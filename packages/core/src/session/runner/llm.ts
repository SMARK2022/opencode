import {
  LLM,
  LLMClient,
  LLMError,
  LLMEvent,
  Message,
  SystemPart,
  TransportReason,
  isContextOverflowFailure,
  type ProviderErrorEvent,
} from "@opencode-ai/llm"
import { Cause, DateTime, Effect, FiberSet, Layer, Option, Semaphore, Stream } from "effect"
import { and, asc, desc, eq, isNotNull, lte, or } from "drizzle-orm"
import { AgentV2 } from "../../agent"
import { Config } from "../../config"
import { Database } from "../../database/database"
import { EventV2 } from "../../event"
import { Location } from "../../location"
import { ModelV2 } from "../../model"
import { PermissionV2 } from "../../permission"
import { ProviderV2 } from "../../provider"
import { QuestionV2 } from "../../question"
import { SystemContext } from "../../system-context/index"
import { SystemContextRegistry } from "../../system-context/registry"
import { SystemContextBuiltIns } from "../../system-context/builtins"
import { SessionPrompts } from "../../system-context/prompts"
import { SessionReminders } from "../reminders"
import { SkillGuidance } from "../../skill/guidance"
import { ReferenceGuidance } from "../../reference/guidance"
import { ToolRegistry } from "../../tool/registry"
import { ToolOutputStore } from "../../tool-output-store"
import { SessionContextEpoch } from "../context-epoch"
import { SessionCompaction } from "../compaction"
import { SessionEvent } from "../event"
import { SessionHistory } from "../history"
import { SessionInput } from "../input"
import { SessionMessage } from "../message"
import { SessionInputTable } from "../sql"
import { RequestUsageTable } from "../request-usage.sql"
import { SessionV1 } from "../../v1/session"
import { SessionSchema } from "../schema"
import { SessionStore } from "../store"
import { type RunError, Service } from "./index"
import { SessionRunnerModel } from "./model"
import { createLLMEventPublisher } from "./publish-llm-event"
import { toLLMMessages } from "./to-llm-message"
import { MAX_STEPS_PROMPT } from "./max-steps"
import { Snapshot } from "../../snapshot"
import { makeLocationNode } from "../../effect/app-node"
import { llmClient } from "../../effect/app-node-platform"
import { Token } from "../../util/token"
import { FSUtil } from "../../fs-util"
import { Global } from "../../global"

/**
 * Runs one durable coding-agent Session until it settles.
 *
 * Keep this as orchestration over smaller collaborators rather than rebuilding the legacy
 * `SessionPrompt` monolith. Implement the unchecked items in small reviewed slices:
 *
 * - Session ownership and controls
 *   - [x] Coordinate one local active drain per Session; explicit resumes join and prompt wakeups coalesce.
 *   - [ ] Replace local ownership with durable multi-node ownership when clustered.
 *   - [ ] Mark busy, retrying, idle, interrupted, or terminal-failure status durably.
 *   - [ ] Honor interruption and reject stale work after runtime attachment replacement.
 *   - [x] Honor optional agent step limits.
 *   - [ ] Bound provider retries and repeated identical tool calls.
 *
 * - Runtime context assembly
 *   - Track V1 runtime-context parity canonically in `specs/v2/session.md`.
 *
 * - One provider turn
 *   - [x] Translate every projected V2 Session message variant into canonical
 *     `@opencode-ai/llm` messages.
 *   - [ ] Resolve policy-filtered built-in, MCP, plugin, and structured-output tool definitions.
 *   - [x] Stream exactly one `llm.stream(request)` provider turn.
 *   - [x] Persist assistant text and usage events incrementally as they arrive.
 *   - [ ] Persist snapshots, patches, and retry notices incrementally as they arrive.
 *   - [x] Persist reasoning, provider errors, and tool-call events incrementally as they arrive.
 *
 * - Tool settlement and continuation
 *   - [x] Durably record each tool call before side effects begin.
 *   - [x] Authorize and execute recorded local calls through a core-owned registry hook.
 *   - [x] Persist typed success, failure, and provider-executed tool outcomes.
 *   - [x] Start each recorded local call eagerly and await all settlements before continuation.
 *   - [ ] Add scoped runtime context, progress updates, attachment normalization,
 *     plugins, and cancellation settlement.
 *   - [x] Reload projected history and start the next explicit provider turn after local tool results.
 *   - [x] Continue for durable user steering accepted during an active provider turn.
 *   - [ ] Continue for compaction or another continuation condition when required.
 *
 * - Post-run maintenance
 *   - [ ] Settle final status and expose durable output events to replayable consumers.
 *   - [ ] Coalesce streamed deltas and add covering projected-history indexes.
 *   - [ ] Update title, summaries, compaction state, and cleanup in bounded background work.
 *
 * Use `llm.stream(request)` for each provider turn. Keep tool execution and continuation here.
 * Durable continuation recovery remains a separate future slice with an explicit retry policy.
 *
 * The current slice loads V2 history, translates it, resolves a model through a core service, and persists one
 * provider turn. Registry definitions are advertised, local tool calls are settled durably, and an
 * explicit loop starts the next provider turn after local settlement. Configured agent step limits bound the loop.
 */

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const llm = yield* LLMClient.Service
    const agents = yield* AgentV2.Service
    const tools = yield* ToolRegistry.Service
    const models = yield* SessionRunnerModel.Service
    const store = yield* SessionStore.Service
    const location = yield* Location.Service
    const systemContext = yield* SystemContextRegistry.Service
    const skillGuidance = yield* SkillGuidance.Service
    const referenceGuidance = yield* ReferenceGuidance.Service
    const config = yield* Config.Service
    const snapshots = yield* Snapshot.Service
    const db = (yield* Database.Service).db
    const buildReminders = yield* SessionReminders.make
    const compaction = SessionCompaction.make({ events, llm, db, config: yield* config.entries() })
    const getSession = Effect.fn("SessionRunner.getSession")(function* (sessionID: SessionSchema.ID) {
      const session = yield* store.get(sessionID)
      if (!session) return yield* Effect.die(`Session not found: ${sessionID}`)
      return session
    })

    const getContext = Effect.fn("SessionRunner.getContext")(function* (sessionID: SessionSchema.ID) {
      return yield* store.context(sessionID)
    })
    const failInterruptedTools = Effect.fn("SessionRunner.failInterruptedTools")(function* (
      sessionID: SessionSchema.ID,
    ) {
      for (const message of yield* getContext(sessionID)) {
        if (message.type !== "assistant") continue
        for (const tool of message.content) {
          if (tool.type !== "tool" || (tool.state.status !== "pending" && tool.state.status !== "running")) continue
          yield* events.publish(SessionEvent.Tool.Failed, {
            sessionID,
            timestamp: yield* DateTime.now,
            assistantMessageID: message.id,
            callID: tool.id,
            error: { type: "unknown", message: "Tool execution interrupted" },
            provider: {
              executed: tool.provider?.executed === true,
              ...(tool.provider?.metadata === undefined ? {} : { metadata: tool.provider.metadata }),
            },
          })
        }
      }
    })

    const awaitToolFibers = (fibers: FiberSet.FiberSet<void, ToolOutputStore.Error>) =>
      Effect.raceFirst(FiberSet.join(fibers), FiberSet.awaitEmpty(fibers))

    // Match V1: declining a user prompt halts the loop instead of becoming model-facing tool output.
    const isUserDeclined = (cause: Cause.Cause<unknown>) =>
      cause.reasons.some(
        (reason) =>
          Cause.isDieReason(reason) &&
          (reason.defect instanceof PermissionV2.DeclinedError || reason.defect instanceof QuestionV2.RejectedError),
      )

    type TurnTransition =
      // Automatic compaction completed; rebuild the request from compacted history.
      | { readonly _tag: "ContinueAfterCompaction"; readonly step: number }
      // Overflow compaction completed; rebuild once through the path without overflow recovery.
      | { readonly _tag: "ContinueAfterOverflowCompaction"; readonly step: number }

    class TurnTransitionError extends Error {
      constructor(readonly transition: TurnTransition) {
        super()
      }
    }

    const continueAfterCompaction = (step: number) => new TurnTransitionError({ _tag: "ContinueAfterCompaction", step })
    const continueAfterOverflowCompaction = (step: number) =>
      new TurnTransitionError({ _tag: "ContinueAfterOverflowCompaction", step })

    const loadSystemContext = (agent: AgentV2.Selection) =>
      Effect.all([systemContext.load(), skillGuidance.load(agent), referenceGuidance.load()], {
        concurrency: "unbounded",
      }).pipe(Effect.map(SystemContext.combine))

    const runTurnAttempt = Effect.fn("SessionRunner.runTurn")(function* (
      sessionID: SessionSchema.ID,
      promotion: SessionInput.Delivery | undefined,
      step: number,
      recoverOverflow?: typeof compaction.compactAfterOverflow,
    ) {
      const session = yield* getSession(sessionID)
      if (session.location.directory !== location.directory || session.location.workspaceID !== location.workspaceID)
        return yield* Effect.interrupt
      const agent = yield* agents.select(session.agent)
      const initialized = yield* SessionContextEpoch.initialize(db, loadSystemContext(agent), session.id)
      const toolFibers = yield* FiberSet.make<void, ToolOutputStore.Error>()
      let needsContinuation = false
      let currentStep = step
      let hasAssistantStarted = () => false
      // restore 保留提升后的 listener 可中断性，只有归属快照/注册使用退出保护。
      yield* Effect.uninterruptibleMask((restore) => Effect.gen(function* () {
        const cutoff = yield* EventV2.latestSequence(db, session.id)
        yield* restore(Effect.gen(function* () {
          if (promotion) {
            let promoted = 0
            if (promotion === "steer") promoted = yield* SessionInput.promoteSteers(db, events, session.id, cutoff)
            if (promotion === "queue") {
              promoted += Number(yield* SessionInput.promoteNextQueued(db, events, session.id))
              promoted += yield* SessionInput.promoteSteers(db, events, session.id, cutoff)
            }
            if (promoted > 0) currentStep = 1
          }
        })).pipe(Effect.onExit((promotionExit) => Effect.gen(function* () {
          const promoted = yield* db.select({ id: SessionInputTable.id, seq: SessionInputTable.promoted_seq }).from(SessionInputTable)
            .where(and(eq(SessionInputTable.session_id, session.id), isNotNull(SessionInputTable.promoted_seq)))
            .orderBy(desc(SessionInputTable.promoted_seq)).limit(1).get().pipe(Effect.orDie)
          if (!promoted || promoted.seq === null || (promotionExit._tag === "Failure" && promotion !== undefined && promoted.seq <= cutoff)) return
          const requestID = SessionV1.MessageID.make(promoted.id)
          // 已拥有助手的续轮沿用根；未拥有助手的已提升批次按 Started 的规则关联。
          const requests = yield* db.select({ id: RequestUsageTable.request_id, status: RequestUsageTable.status }).from(RequestUsageTable)
            .innerJoin(SessionInputTable, and(eq(SessionInputTable.session_id, RequestUsageTable.session_id), eq(SessionInputTable.id, RequestUsageTable.request_id)))
            .where(and(eq(RequestUsageTable.session_id, session.id), eq(RequestUsageTable.source, "prompt"),
              isNotNull(SessionInputTable.promoted_seq), lte(SessionInputTable.promoted_seq, promoted.seq),
              or(eq(RequestUsageTable.root_request_id, requestID), and(eq(RequestUsageTable.status, "running"),
                eq(RequestUsageTable.assistant_count, 0), eq(RequestUsageTable.root_request_id, RequestUsageTable.request_id)))))
            .orderBy(asc(SessionInputTable.admitted_seq)).all().pipe(Effect.orDie)
          // 使用现有 turn scope 的真实 exit；已开始助手仍由 publisher/Step owner 结算。
          yield* Effect.addFinalizer((exit) => {
            if (requests.length === 0 || hasAssistantStarted()) return Effect.void
            if (exit._tag === "Success") return Effect.gen(function* () {
              // raw 空成功只完成冻结的 running 成员；显式空续轮不能覆盖先前失败或确认消费。
              if (!requests.some(row => row.status === "running")) return
              yield* events.publish(SessionEvent.PromptCompleted, {
                sessionID: session.id, messageID: SessionMessage.ID.make(requestID), timestamp: yield* DateTime.now,
                requestIDs: requests.filter(row => row.status === "running").map(row => SessionMessage.ID.make(row.id)),
              }, { finalizer: true })
            })
            const failure = Cause.squash(exit.cause)
            if (failure instanceof TurnTransitionError && !Cause.hasInterrupts(exit.cause)) return Effect.void
            return Effect.gen(function* () {
              yield* events.publish(SessionEvent.PromptFailed, {
                sessionID: session.id, messageID: SessionMessage.ID.make(requestID), timestamp: yield* DateTime.now,
                // 此后新增 admission 不属于本次失败；cause 仅转换事件诊断，原 typed exit 不变。
                requestIDs: requests.map(row => SessionMessage.ID.make(row.id)),
                error: { type: "unknown", message: failure instanceof Error ? failure.message : String(failure) },
                aborted: Cause.hasInterrupts(exit.cause),
              }, { finalizer: true })
            })
          })
        })))
      }))
      const system =
        initialized ?? (yield* SessionContextEpoch.prepare(db, events, loadSystemContext(agent), session.id))
      const selection = yield* models.resolve(session)
      const model = selection.model
      const entries = yield* SessionHistory.entriesForRunner(db, session.id, system.baselineSeq)
      const context = entries.map((entry) => entry.message)
      const isLastStep = agent.info?.steps !== undefined && currentStep >= agent.info.steps
      // 委派Session的持久范围也决定本轮广告，防止正文可见工具与实际权限分裂。
      const sessionPermissions = yield* store.permissions(session.id)
      const toolMaterialization = isLastStep ? undefined : yield* tools.materialize([...(agent.info?.permissions ?? []), ...sessionPermissions])
      // 实际 tool materialization 已应用当前 agent 权限；最后一步无工具时不产生替代指引。
      const toolGuidance = SystemContextBuiltIns.toolUsage(toolMaterialization?.definitions.map((tool) => tool.name) ?? [])
      // 模型身份随当前选择变化，不能固定进 default-agent baseline 或首次 Environment 快照。
      const cutoff = SystemContextBuiltIns.knowledgeCutoff(String(model.id))
      // 普通提醒逐轮生成，实验计划沿既有synthetic持久化；两者都不新增用户admission或放宽权限。
      const reminders = yield* buildReminders(agent.id, session.id, context)
      const promptCacheKey = /^ses_[0-9a-f]{64}$/.test(session.id) ? session.id.slice(4) : session.id
      const request = LLM.request({
        model,
        http: {
          headers: {
            "x-opencode-session-id": session.id,
            ...(session.parentID ? { "x-opencode-parent-session-id": session.parentID } : {}),
            "x-session-affinity": session.id,
            "X-Session-Id": session.id,
            ...(session.parentID ? { "x-parent-session-id": session.parentID } : {}),
          },
        },
        // Agent 的显式开关覆盖 model/variant 默认值，false 不能被真值判断吞掉。
        providerOptions: { openai: { promptCacheKey,
          ...(agent.info?.request.body.parallelToolCalls !== undefined || agent.info?.request.body.parallel_tool_calls !== undefined
            ? { parallelToolCalls: agent.info.request.body.parallelToolCalls ?? agent.info.request.body.parallel_tool_calls } : {}),
        } },
        // 模型族正文与V1共用；显式agent system仍替代默认正文，而非重复注入两份身份。
        system: [toolGuidance, agent.info?.system ?? SessionPrompts.provider(String(model.id), String(model.provider)), system.baseline,
          `You are powered by the model named ${model.id}. The exact model ID is ${model.provider}/${model.id}${cutoff ? `\nKnowledge cutoff: ${cutoff}` : ""}`]
          .filter((part): part is string => part !== undefined && part.length > 0)
          .map(SystemPart.make),
        messages: [...toLLMMessages(context, model), ...reminders.map(text => Message.user(text)), ...(isLastStep ? [Message.assistant(MAX_STEPS_PROMPT)] : [])],
        tools: toolMaterialization?.definitions ?? [],
        toolChoice: isLastStep ? "none" : undefined,
      })
      // 压缩复用本 turn 已采样的模型选择；不从稍后可能切换的 Session 重读 variant。
      if (yield* compaction.compactIfNeeded({ sessionID: session.id, entries, model, pricing: selection.pricing, variant: session.model?.variant, request }))
        return yield* Effect.die(continueAfterCompaction(currentStep))
      const startSnapshot = yield* snapshots.capture()
      // ContextEpoch 仍决定 baseline 和历史选择，估算不另建历史或改变请求。
      const samples = context.toReversed().flatMap((message) => {
        // publisher 保存实际 provider/API model ID；边界只去除品牌，不换成 Session 的 catalog 别名。
        if (message.type !== "assistant" || String(message.model.providerID) !== String(model.provider) || String(message.model.id) !== String(model.id)
          || !message.inputEstimate?.confirmed || !message.tokens) return []
        return [{ bodyChars: message.inputEstimate.bodyChars,
          input: message.tokens.input + message.tokens.cache.read + message.tokens.cache.write }]
      })
      let inputEstimate: SessionMessage.InputEstimate | undefined
      // 只使用现有 provider step；不启动第二次 stream 或 advisory wake。
      const publisher = createLLMEventPublisher(events, {
        sessionID: session.id,
        agent: agent.id,
        model: {
          id: ModelV2.ID.make(model.id),
          providerID: ProviderV2.ID.make(model.provider),
          ...(session.model?.variant === undefined ? {} : { variant: session.model.variant }),
        },
        snapshot: startSnapshot,
        // compile 回调晚于 publisher 创建，真实 Started 时才读取该轮估算。
        inputEstimate: () => inputEstimate,
      })
      hasAssistantStarted = publisher.hasAssistantStarted
      const withPublication = Semaphore.makeUnsafe(1).withPermit
      const publish = (event: LLMEvent, outputPaths: ReadonlyArray<string> = []) =>
        withPublication(publisher.publish(event, outputPaths))
      let overflowFailure: ProviderErrorEvent | undefined
      const providerStream = llm.stream(request, (body) => Effect.gen(function* () {
        // 同一次 compile 已合并模型/路由默认值并完成协议 lowering，估算只读取该有效正文。
        inputEstimate = {
          ...Token.estimateRequest(body, samples, system.sections),
          contextLimit: model.defaults?.limits?.context ?? model.route.defaults.limits?.context ?? 0,
        }
        // 使用实际已提升输入身份；较新的未提升 queue 不能接管这个请求。
        const promoted = yield* db.select({ id: SessionInputTable.id }).from(SessionInputTable)
          .where(and(eq(SessionInputTable.session_id, session.id), isNotNull(SessionInputTable.promoted_seq)))
          .orderBy(desc(SessionInputTable.promoted_seq)).limit(1).get().pipe(Effect.orDie)
        // Durable event 保存唯一 provisional 快照，沿现有请求身份投影，不新增请求表或第二次 stream。
        if (promoted) yield* events.publish(SessionEvent.RequestEstimated, {
          sessionID: session.id, messageID: SessionMessage.ID.make(promoted.id), timestamp: yield* DateTime.now,
          model: { id: ModelV2.ID.make(model.id), providerID: ProviderV2.ID.make(model.provider),
            ...(session.model?.variant === undefined ? {} : { variant: session.model.variant }) },
          inputEstimate,
        })
        // 不提前创建助手，空 EOF、失败、overflow 与中断继续使用原来的 owner。
      })).pipe(
        Stream.runForEach((event) =>
          Effect.gen(function* () {
            if (overflowFailure || publisher.hasProviderError()) return
            if (LLMEvent.is.providerError(event)) {
              if (isContextOverflowFailure(event) && !publisher.hasAssistantStarted()) {
                overflowFailure = event
                return
              }
            }
            yield* publish(event)
            if (event.type !== "tool-call" || event.providerExecuted) return
            if (!toolMaterialization) {
              yield* withPublication(publisher.failUnsettledTools("Tools are disabled after the maximum agent steps"))
              return
            }
            needsContinuation = true
            const assistantMessageID = yield* publisher.assistantMessageID(event.id)
            yield* Effect.uninterruptibleMask((restore) =>
              restore(
                toolMaterialization.settle({
                  sessionID: session.id,
                  agent: agent.id,
                  assistantMessageID,
                  call: event,
                }),
              ).pipe(
                Effect.flatMap((settlement) =>
                  publish(
                    LLMEvent.toolResult({
                      id: event.id,
                      name: event.name,
                      result: settlement.result,
                      output: settlement.output,
                    }),
                    settlement.outputPaths ?? [],
                  ),
                ),
              ),
            ).pipe(FiberSet.run(toolFibers))
          }),
        ),
        // 对整个消费 Effect 计一次总期限，不能用会被 chunks 重置的 Stream.timeout。
        (effect) => model.timeout === false ? effect : Effect.timeoutOrElse(effect, {
          duration: model.timeout ?? 300_000,
          // 只创建本次到期的运输错误；原 provider cause 与既有 flush/助手/用量结算保持。
          orElse: () => Effect.fail(new LLMError({
            module: "SessionRunner",
            method: "stream",
            reason: new TransportReason({ message: "Provider request timed out", kind: "timeout" }),
          })),
        }),
        // 成功 EOF 保留默认残片通知；只有失败/中断 cleanup 使用退出安全模式。
        Effect.onExit(exit => withPublication(publisher.flush(exit._tag === "Failure"))),
      )

      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const stream = yield* restore(providerStream).pipe(Effect.exit)
          const failure =
            stream._tag === "Failure" ? Option.getOrUndefined(Cause.findErrorOption(stream.cause)) : undefined
          if (
            recoverOverflow &&
            !publisher.hasAssistantStarted() &&
            isContextOverflowFailure(overflowFailure ?? failure) &&
            // 恢复摘要也属于这次失败 turn 的采样，不能再次 resolve 或采用新选择。
            (yield* restore(recoverOverflow({ sessionID: session.id, entries, model, pricing: selection.pricing, variant: session.model?.variant, request })))
          )
            return yield* Effect.die(continueAfterOverflowCompaction(currentStep))
          if (overflowFailure) yield* publish(overflowFailure)
          const llmFailure = failure instanceof LLMError ? failure : undefined
          if (llmFailure && !publisher.hasProviderError()) {
            yield* withPublication(publisher.failUnsettledTools("Provider did not return a tool result", true, true))
            yield* withPublication(publisher.failAssistant(llmFailure.reason.message, false, true))
          }
          if (stream._tag === "Failure" && Cause.hasInterrupts(stream.cause)) yield* FiberSet.clear(toolFibers)
          const settled = yield* restore(awaitToolFibers(toolFibers)).pipe(Effect.exit)
          // 仅真正失败/中断退出隔离通知；普通工具错误仍沿用原 model-facing 路径。
          const finalizer = stream._tag === "Failure" ||
            (settled._tag === "Failure" && (Cause.hasInterrupts(settled.cause) || isUserDeclined(settled.cause)))
          if (settled._tag === "Failure" && isUserDeclined(settled.cause)) {
            yield* FiberSet.clear(toolFibers)
            yield* withPublication(publisher.failUnsettledTools("Tool execution interrupted", false, true))
            // 用户拒绝也终结当前助手；退出延后到已收到的 provider 用量完成持久化。
            if (publisher.hasAssistantStarted())
              yield* withPublication(publisher.failAssistant("Provider turn interrupted", true, true))
          }
          if (
            (stream._tag === "Failure" && Cause.hasInterrupts(stream.cause)) ||
            (settled._tag === "Failure" && Cause.hasInterrupts(settled.cause))
          ) {
            yield* FiberSet.clear(toolFibers)
            yield* withPublication(publisher.failUnsettledTools("Tool execution interrupted", false, true))
            if (publisher.hasAssistantStarted())
              // 中断是独立结算状态，保持真实事件标志而非依赖英文错误字符串。
              yield* withPublication(publisher.failAssistant("Provider turn interrupted", true, true))
          }
          if (settled._tag === "Failure" && !Cause.hasInterrupts(settled.cause) && !isUserDeclined(settled.cause)) {
            const failure = Cause.squash(settled.cause)
            const message = failure instanceof Error ? failure.message : String(failure)
            yield* withPublication(publisher.failUnsettledTools(`Tool execution failed: ${message}`, false, finalizer))
          }
          const stepSettlement = publisher.stepSettlement()
          // step-finish 已确认的消耗不因随后失败退款；消息和账本保留此前失败身份。
          if (stepSettlement) {
            const endSnapshot = yield* snapshots.capture()
            const files =
              startSnapshot && endSnapshot
                ? yield* snapshots
                    .files({ from: startSnapshot, to: endSnapshot })
                    .pipe(Effect.catch(() => Effect.succeed(undefined)))
                : undefined
            yield* withPublication(
              events.publish(SessionEvent.Step.Ended, {
                sessionID: session.id,
                timestamp: yield* DateTime.now,
                assistantMessageID: yield* publisher.startAssistant(finalizer),
                finish: stepSettlement.finish,
                cost: SessionRunnerModel.cost(selection.pricing, stepSettlement.tokens),
                tokens: stepSettlement.tokens,
                snapshot: endSnapshot,
                files,
              // 失败退出仍结算同一确认 step，模式只影响通知，不改变 cost/tokens。
              }, { finalizer }),
            )
          }
          if (publisher.hasProviderError())
            yield* withPublication(publisher.failUnsettledTools("Tool execution interrupted", false, finalizer))
          if (stream._tag === "Success" && !publisher.hasProviderError())
            yield* withPublication(publisher.failUnsettledTools("Provider did not return a tool result", true, finalizer))
          if (settled._tag === "Failure" && isUserDeclined(settled.cause)) return yield* Effect.interrupt
          if (stream._tag === "Failure") {
            // LLMError 已按上游 hosted-only 清理；其他 cause 才补清理，保留本地 raw partial。
            if (!llmFailure) yield* withPublication(publisher.failUnsettledTools("Provider did not return a tool result", false, true))
            if (publisher.hasAssistantStarted() && !Cause.hasInterrupts(stream.cause))
              yield* withPublication(publisher.failAssistant(String(Cause.squash(stream.cause)), false, true))
            return yield* Effect.failCause(stream.cause)
          }
          if (settled._tag === "Failure" && Cause.hasInterrupts(settled.cause))
            return yield* Effect.failCause(settled.cause)
          if (publisher.hasActiveAssistant() && !stepSettlement) {
            // 无内容 turn 的 Started 可迟于 step-finish；结算快照存在时不能按 active 误报 EOF。
            yield* withPublication(publisher.failAssistant("Provider stream ended before assistant step finish"))
            // 只补消息和账本终态；raw EOF 的成功返回及原 continuation 契约保持。
          }
          return { needsContinuation: !publisher.hasProviderError() && needsContinuation, step: currentStep }
        }),
      )
    }, Effect.scoped)
    type RunTurn = (
      sessionID: SessionSchema.ID,
      promotion: SessionInput.Delivery | undefined,
      step: number,
    ) => Effect.Effect<{ readonly needsContinuation: boolean; readonly step: number }, RunError>

    const runAfterOverflowCompaction: RunTurn = Effect.fnUntraced(function* (sessionID, promotion, step) {
      return yield* runTurnAttempt(sessionID, promotion, step).pipe(
        Effect.catchDefect(
          Effect.fnUntraced(function* (defect) {
            if (!(defect instanceof TurnTransitionError)) return yield* Effect.die(defect)
            if (defect.transition._tag === "ContinueAfterOverflowCompaction")
              return yield* Effect.die("Post-compaction provider attempt cannot recover another overflow")
            yield* Effect.yieldNow
            return yield* runAfterOverflowCompaction(sessionID, undefined, defect.transition.step)
          }),
        ),
      )
    })

    const runTurn: RunTurn = Effect.fnUntraced(function* (sessionID, promotion, step) {
      return yield* runTurnAttempt(sessionID, promotion, step, compaction.compactAfterOverflow).pipe(
        Effect.catchDefect(
          Effect.fnUntraced(function* (defect) {
            if (!(defect instanceof TurnTransitionError)) return yield* Effect.die(defect)
            yield* Effect.yieldNow
            if (defect.transition._tag === "ContinueAfterOverflowCompaction")
              return yield* runAfterOverflowCompaction(sessionID, undefined, defect.transition.step)
            return yield* runTurn(sessionID, undefined, defect.transition.step)
          }),
        ),
      )
    })

    const run = Effect.fn("SessionRunner.run")(function* (input: {
      readonly sessionID: SessionSchema.ID
      readonly force: boolean
    }) {
      const hasSteer = yield* SessionInput.hasPending(db, input.sessionID, "steer")
      const hasQueue = hasSteer ? false : yield* SessionInput.hasPending(db, input.sessionID, "queue")
      if (!input.force && !hasSteer && !hasQueue) return
      yield* failInterruptedTools(input.sessionID)
      let promotion: SessionInput.Delivery | undefined = hasSteer ? "steer" : hasQueue ? "queue" : undefined
      let shouldRun = input.force || hasSteer || hasQueue
      while (shouldRun) {
        let needsContinuation = true
        let step = 1
        while (needsContinuation) {
          const result = yield* runTurn(input.sessionID, promotion, step)
          needsContinuation = result.needsContinuation
          step = result.step + 1
          promotion = "steer"
          if (!needsContinuation) needsContinuation = yield* SessionInput.hasPending(db, input.sessionID, "steer")
        }
        shouldRun = yield* SessionInput.hasPending(db, input.sessionID, "queue")
        promotion = shouldRun ? "queue" : undefined
      }
    })

    return Service.of({
      run,
    })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [
    EventV2.node,
    llmClient,
    AgentV2.node,
    ToolRegistry.node,
    SessionRunnerModel.node,
    SessionStore.node,
    Location.node,
    SystemContextRegistry.node,
    SkillGuidance.node,
    ReferenceGuidance.node,
    Config.node,
    Snapshot.node,
    Database.node,
    FSUtil.node,
    Global.node,
  ],
})
