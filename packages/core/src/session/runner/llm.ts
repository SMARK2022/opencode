import {
  LLM,
  LLMClient,
  LLMError,
  InvalidProviderOutputReason,
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
import { ToolSelection } from "../../tool/selection"
import { McpTools } from "../../mcp/tools"
import { ToolOutputStore } from "../../tool-output-store"
import { SessionContextEpoch } from "../context-epoch"
import { SessionCompaction } from "../compaction"
import { SessionTodo } from "../todo"
import { SessionEvent } from "../event"
import { SessionHistory } from "../history"
import { PromptCacheSlots } from "../prompt-cache-slots"
import { SessionGoal } from "../goal"
import { SessionRetry } from "../retry"
import { SessionGoalProgress } from "../goal-progress"
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
import { DECIDE_PROMPT, makeMessageCache, toDecideMessages, toLLMMessages } from "./to-llm-message"
import { MAX_STEPS_PROMPT } from "./max-steps"
import { Snapshot } from "../../snapshot"
import { makeLocationNode } from "../../effect/app-node"
import { llmClient } from "../../effect/app-node-platform"
import { Token } from "../../util/token"
import { FSUtil } from "../../fs-util"
import { ToolDiffs } from "../tool-diffs"
import { Global } from "../../global"
import { Image } from "../../image"
import { normalizeImages } from "./images"

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
    const mcpTools = yield* McpTools.Service
    const store = yield* SessionStore.Service
    const goals = yield* SessionGoal.Service
    const location = yield* Location.Service
    const systemContext = yield* SystemContextRegistry.Service
    const skillGuidance = yield* SkillGuidance.Service
    const referenceGuidance = yield* ReferenceGuidance.Service
    const config = yield* Config.Service
    const image = yield* Image.Service
    const permission = yield* PermissionV2.Service
    const nearOverflowNotified = new Set<SessionSchema.ID>()
    const snapshots = yield* Snapshot.Service
    const db = (yield* Database.Service).db
    const buildReminders = yield* SessionReminders.make
    const configuration = yield* config.entries()
    const fileSystem = yield* FSUtil.Service
    const todos = yield* SessionTodo.Service
    const compaction = SessionCompaction.make({ events, llm, db, todos: todos.get, config: configuration, fs: fileSystem, worktree: location.project.directory, directory: location.directory })
    // Location内只保留可替换entry，跨独立请求复用；执行与Goal状态不进入缓存。
    const promptCache = PromptCacheSlots.acquire<{
      sessionID: SessionSchema.ID
      instance: typeof location
      history: ReturnType<typeof SessionHistory.makeCache>
      messages: ReturnType<typeof makeMessageCache>
    }>()
    // 注销只属于Location Service退出；普通resume/idle继续保留同一个warm单槽。
    yield* Effect.addFinalizer(() => Effect.sync(() => PromptCacheSlots.release(promptCache)))
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

    const prepareTurn = Effect.fn("SessionRunner.prepareTurn")(function* (sessionID: SessionSchema.ID, agent: AgentV2.Selection) {
      const decide = agent.id === "decide"
      // 无工具模式在准备入口跳过连接和技能；不能只清广告，也不能注销其他会话共享的工具。
      const mcpContextFor = decide ? undefined : yield* mcpTools.prepare()
      // 工具与说明使用同一轮权限/选择快照，不能共享另一Session的可见工具列表。
      const sessionPermissions = yield* store.permissions(sessionID)
      const materialization = decide ? undefined : yield* tools.materialize([...(agent.info?.permissions ?? []), ...sessionPermissions], sessionPermissions)
      return {
        materialization,
        context: Effect.all([
          systemContext.load(), decide ? Effect.succeed(SystemContext.empty) : skillGuidance.load(agent), referenceGuidance.load(),
          Effect.succeed(mcpContextFor && materialization ? mcpContextFor(materialization.definitions.map(tool => tool.name)) : SystemContext.empty),
        ], { concurrency: "unbounded" }).pipe(Effect.map(SystemContext.combine)),
      }
    })

    // 仅当前 drain 持有待注入目标；不新增调度器或崩溃后自动恢复。
    type GoalContinuation = {
      goal?: SessionGoal.Goal & { viewMode: "continue" | "replan" | "block-check"; maxTurns: number }; turns: number
      mode?: SessionGoal.ContinuationMode
      progressLedger: SessionGoalProgress.GoalProgressLedger
      progressGate: { noProgressTurns: number; replanRequired: boolean }
      // 同eligible turn跨provider steps与compaction重入共享读取快照。
      goalTurn?: SessionGoal.GoalTurnContext
    }

    const runTurnAttempt = Effect.fn("SessionRunner.runTurn")(function* (
      sessionID: SessionSchema.ID,
      promotion: SessionInput.Delivery | undefined,
      step: number,
      continuation: GoalContinuation,
      recoverOverflow?: typeof compaction.compactAfterOverflow,
    ) {
      // 首个Session读取前取得租约，删除/dispose期间的迟发结果不能重新成为长期owner。
      const cacheLease = PromptCacheSlots.lease(promptCache)
      const session = yield* getSession(sessionID)
      if (session.location.directory !== location.directory || session.location.workspaceID !== location.workspaceID)
        return yield* Effect.interrupt
      const agent = yield* agents.select(session.agent)
      const prepared = yield* prepareTurn(session.id, agent)
      // initialize仍在durable promotion之前，既有epoch基线与用户admission边界不移动。
      const initialized = yield* SessionContextEpoch.initialize(db, prepared.context, session.id)
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
            if (promoted > 0) {
              currentStep = 1
              continuation.goal = undefined
            }
          }
          // 新用户输入优先；合成续跑保留当前步数额度，并由原历史投影持久化。
          if (continuation.goal) {
            const pending = continuation.goal
            const goal = yield* goals.get(session.id)
            continuation.goal = undefined
            if (Option.isSome(goal) && goal.value.status === "active") {
              yield* events.publish(SessionEvent.Synthetic, {
                sessionID: session.id, messageID: SessionMessage.ID.create(), timestamp: yield* DateTime.now,
                text: SessionGoal.continuationPrompt(goal.value, continuation.mode),
                // 候选模式和额度在 admission 时采样，发布成功后才递增本 drain 的计数。
                metadata: {
                  goal_continuation: true,
                  goal_continuation_mode: pending.viewMode,
                  goal_continuation_turn: continuation.turns + 1,
                  goal_continuation_max_turns: pending.maxTurns,
                },
              })
              continuation.turns++
            }
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
        initialized ?? (yield* SessionContextEpoch.prepare(db, events, prepared.context, session.id))
      const selection = yield* models.resolve(session)
      const model = selection.model
      const retained = PromptCacheSlots.read(promptCache, session.id) ?? {
        sessionID: session.id, instance: location, history: SessionHistory.makeCache(), messages: makeMessageCache(),
      }
      // await前捕获entry，另一Session替换唯一指针不能混入本次在途历史或转换。
      PromptCacheSlots.publish(promptCache, cacheLease, retained)
      const entries = yield* SessionHistory.entriesForRunner(db, session.id, system.baselineSeq, retained.history)
      const context = entries.map((entry) => entry.message)
      // 普通Provider turn不查Goal lineage；同一步并发调用共享查询，同eligible turn保留read身份。
      const loadGoalTurn = yield* Effect.cached(Effect.gen(function* () {
        const lineage = yield* SessionHistory.goalTurn(db, session.id)
        if (lineage?.id !== continuation.goalTurn?.id) continuation.goalTurn = lineage
        return continuation.goalTurn
      }))
      const isLastStep = agent.info?.steps !== undefined && currentStep >= agent.info.steps
      const decide = agent.id === "decide"
      // 与最大步数共用原禁用路径，不构建第二套执行器或只依赖权限过滤。
      const toolMaterialization = isLastStep || decide ? undefined : prepared.materialization
      // 指引只引用本轮真实可见工具；内部修复定义不算用户能力，空列表明确提示无工具。
      const toolGuidance = SystemContextBuiltIns.toolUsage(toolMaterialization?.definitions.map((tool) => tool.name).filter(ToolSelection.isUserConfigurable) ?? [])
      // 根据本轮实际工具表提示历史调用的可用性，不另建权限判断或持久化提醒。
      const available = new Set(toolMaterialization?.definitions.map((tool) => tool.name) ?? [])
      const disabled = toolMaterialization ? [...new Set(context.flatMap(message => message.type === "assistant" ? message.content.flatMap(part => part.type === "tool" && part.provider?.executed !== true ? [part.name] : []) : []))].filter(name => !available.has(name)) : []
      const notice = disabled.map(name => {
        const substitutes = name === "apply_patch" ? ["edit", "write"].filter(tool => available.has(tool)) : []
        return `${name} is not available in this session. Use ${substitutes.length ? substitutes.join(" or ") : "an available tool"} instead.`
      }).join("\n")
      // 模型身份随当前选择变化，不能固定进 default-agent baseline 或首次 Environment 快照。
      const cutoff = SystemContextBuiltIns.knowledgeCutoff(String(model.id))
      // 普通提醒逐轮生成，实验计划沿既有synthetic持久化；两者都不新增用户admission或放宽权限。
      const reminders = decide ? [] : yield* buildReminders(agent.id, session.id, context)
      const promptCacheKey = /^ses_[0-9a-f]{64}$/.test(session.id) ? session.id.slice(4) : session.id
      const systemParts = [toolGuidance, agent.info?.system ?? SessionPrompts.provider(String(model.id), String(model.provider)), system.baseline,
        ...(notice ? [`<system-reminder>${notice}</system-reminder>`] : []),
        ...(decide ? [DECIDE_PROMPT] : []),
        `You are powered by the model named ${model.id}. The exact model ID is ${model.provider}/${model.id}${cutoff ? `\nKnowledge cutoff: ${cutoff}` : ""}`]
        .filter((part): part is string => part !== undefined && part.length > 0)
        .map(SystemPart.make)
      const prior = context.findLast(message => message.type === "assistant" && message.inputEstimate)
      const estimatedInput = prior?.type === "assistant" ? prior.inputEstimate?.input ?? 0 : 0
      const usableTokens = compaction.inputBudget({ model })
      // 仅用前轮真实prepared快照作轻量提醒，本轮硬溢出仍走原压缩入口。
      const threshold = usableTokens > 0 ? Math.floor(usableTokens * 0.85) : 0
      // 同一drain切大窗口或无上限后复位；仍处高位的模型切换不能重复灌入提醒。
      if (!decide && !isLastStep && (usableTokens <= 0 || estimatedInput < threshold)) nearOverflowNotified.delete(session.id)
      const nearOverflow = !decide && !isLastStep && !nearOverflowNotified.has(session.id) && usableTokens > 0 && estimatedInput >= threshold
      if (nearOverflow) nearOverflowNotified.add(session.id)
      const overflowReminder = nearOverflow ? [Message.user("Context is approaching the model's limit. To avoid context compaction degrading task quality, prefer targeted reads (small offset/limit) over full-file reads, and narrow grep patterns over broad searches. Do not reduce response quality. If work is still in progress, ignore this and continue per user instructions.")] : []
      // 正常请求和压缩共用准备后的消息；不把坏图交给provider，也不改写持久历史。
      const messages = yield* normalizeImages([...(decide ? toDecideMessages(context, model, systemParts.map((part) => part.text).join("\n"), Config.latest(configuration, "compaction")?.buffer) : toLLMMessages(context, model, retained.messages)), ...reminders.map(text => Message.user(text)), ...overflowReminder, ...(isLastStep && !decide ? [Message.assistant(MAX_STEPS_PROMPT)] : [])], image)
      const request = LLM.request({
        model,
        http: {
          headers: {
            "x-opencode-session-id": session.id,
            ...(session.parentID ? { "x-opencode-parent-session-id": session.parentID } : {}),
            "x-session-affinity": session.id,
            // 代理按连字符头识别OpenAI会话；header保留完整身份，不复用缩短的正文缓存键。
            ...(model.provider === "openai" ? { "session-id": session.id } : {}),
            "X-Session-Id": session.id,
            ...(session.parentID ? { "x-parent-session-id": session.parentID } : {}),
          },
        },
        // Agent 的显式开关覆盖 model/variant 默认值，false 不能被真值判断吞掉。
        providerOptions: { openai: { promptCacheKey,
          // 普通turn与审查器共用真实OAuth资格，完整可信system原话只提升一次。
          ...(selection.openaiOAuth ? { instructions: systemParts.map(part => part.text).join("\n") } : {}),
          ...(agent.info?.request.body.parallelToolCalls !== undefined || agent.info?.request.body.parallel_tool_calls !== undefined
            ? { parallelToolCalls: agent.info.request.body.parallelToolCalls ?? agent.info.request.body.parallel_tool_calls } : {}),
        } },
        // 模型族正文与V1共用；显式agent system仍替代默认正文，而非重复注入两份身份。
        system: selection.openaiOAuth ? undefined : systemParts,
        messages,
        tools: toolMaterialization?.definitions ?? [],
        toolChoice: isLastStep || decide ? "none" : undefined,
      })
      // 压缩复用本 turn 已采样的模型选择；不从稍后可能切换的 Session 重读 variant。
      if (yield* compaction.compactIfNeeded({ sessionID: session.id, entries, model, pricing: selection.pricing, variant: session.model?.variant, request })) {
        nearOverflowNotified.delete(session.id)
        return yield* Effect.die(continueAfterCompaction(currentStep))
      }
      // 基线只在校验后的non-none本地调用启动；同助手共享一次in-flight捕获及失败。
      let startSnapshot: Snapshot.ID | undefined
      let snapshotAuthority: "declared" | "ambient" | undefined
      const startedAt = Date.now()
      let firstStreamEvent = true
      // 只记录本轮身份和里程碑，不把实际请求、工具参数或提供者元数据带进日志。
      yield* Effect.logInfo("stream timing", {
        phase: "processor.start", sessionID: session.id, providerID: model.provider, modelID: model.id, agent: agent.id,
      })
      // turn scope 在流、工具和用量结算后关闭，失败与中断也记录结束且保持原Cause。
      yield* Effect.addFinalizer((exit) => Effect.logInfo("stream timing", {
        phase: "processor.end", sessionID: session.id, result: exit._tag,
        durationMs: Date.now() - startedAt,
      }))
      // ContextEpoch 仍决定 baseline 和历史选择，估算不另建历史或改变请求。
      const samples = Token.inputHistory(context, model)
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
        // compile 回调晚于 publisher 创建，真实 Started 时才读取该轮估算。
        inputEstimate: () => inputEstimate,
      })
      hasAssistantStarted = publisher.hasAssistantStarted
      const withPublication = Semaphore.makeUnsafe(1).withPermit
      const captureSnapshot = yield* Effect.cached(snapshots.capture())
      const captureWorktree = (authority: "declared" | "ambient") => withPublication(Effect.gen(function* () {
        const baseline = yield* captureSnapshot
        if (!baseline || snapshotAuthority === "ambient" || snapshotAuthority === authority) return
        const next = authority === "ambient" ? "ambient" : snapshotAuthority ?? "declared"
        // Started早于工具校验，晚到的baseline必须走durable更新，而非只保存在局部getter。
        yield* events.publish(SessionEvent.Step.SnapshotUpdated, {
          sessionID: session.id,
          assistantMessageID: yield* publisher.startAssistant(),
          timestamp: yield* DateTime.now,
          snapshot: { start: baseline, worktree: next },
        })
        startSnapshot = baseline
        snapshotAuthority = next
      }))
      const publish = (event: LLMEvent, outputPaths: ReadonlyArray<string> = []) =>
        withPublication(Effect.gen(function* () {
          // publisher只为已接受的终态返回凭证，重复/忽略事件不能虚增错误。
          const settled = yield* publisher.publish(event, outputPaths)
          if (!settled?.failed) return
          // 沿已提交凭证定点重读当前助手，先前历史复用本turn的compaction/epoch可见快照。
          const current = yield* store.message(settled.assistantMessageID, session.id)
          if (!current || current.message.type !== "assistant")
            return yield* Effect.die("Accepted tool failure is missing its projected assistant")
          // 不另扫或thaw历史；当前pending不占窗口，成功及不同输入都会自然打断连续失败。
          const recent = [...context.filter(message => message.id !== settled.assistantMessageID), current.message]
            .flatMap(message => message.type === "assistant"
              ? message.content.filter((part): part is SessionMessage.AssistantTool => part.type === "tool" && part.state.status !== "pending")
              : []).slice(-3)
          // JSON.stringify比较沿原合同，不规范化键序，也不把同工具的所有错误累加成第二数据源。
          if (recent.length !== 3 || !recent.every(part => part.name === settled.name && part.state.status === "error" && JSON.stringify(part.state.input) === JSON.stringify(settled.input))) return
          yield* permission.assert({ action: "doom_loop", resources: [settled.name], save: [settled.name], sessionID: session.id, agent: agent.id,
            metadata: { tool: settled.name, input: settled.input, consecutiveErrors: 3 },
            source: { type: "tool", messageID: settled.assistantMessageID, callID: settled.callID },
          }).pipe(Effect.orDie)
        }))
      let overflowFailure: ProviderErrorEvent | undefined
      // 只有本轮显式provider错误携带续跑资格，不能从投影中的unknown推断中断或EOF。
      let terminalError = false
      let hasToolCall = false
      const incomplete = new LLMError({ module: "SessionRunner", method: "stream", reason: new InvalidProviderOutputReason({
        message: "Provider returned incomplete completion (finish_reason: unknown)",
      }) })
      const retryError = new SessionV1.APIError({ message: incomplete.reason.message, isRetryable: true, metadata: { finishReason: "unknown" } })
      // 与V1共用65,536个UTF-16字符语义；只给无真实Tool的超限一次重试，不进入Goal错误续跑。
      const outputLength = new LLMError({ module: "SessionRunner", method: "stream", reason: new InvalidProviderOutputReason({
        message: "Provider output exceeded the 64 KiB text limit",
      }) })
      let outputLimitRetried = false
      // policy的set不携带cause，在私有parse闭包交接准确错误，不修改公共重试接口。
      let retryErrorForAttempt = retryError
      // 请求归属与工具读取门寿命不同：dispatch固定代际，终态后的同代最终消耗仍结算。
      const dispatchedGoal = yield* goals.get(session.id)
      const expectedUsage = Option.isSome(dispatchedGoal) && dispatchedGoal.value.status === "active" ? { goalID: dispatchedGoal.value.id, generation: dispatchedGoal.value.generation } : undefined
      // 每个获准 retry 才重新调用唯一 stream；不能反复消费同一个已构造响应。
      const providerStream = Effect.suspend(() => {
        // 每次订阅重置累计值，不能在text-start重置而放过多个独立正文块。
        let attemptTextChars = 0
        return llm.stream(request, (body) => Effect.gen(function* () {
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
            // 首事件只取类型，保留唯一stream与既有顺序消费，不逐token写诊断。
            if (firstStreamEvent) {
              firstStreamEvent = false
              yield* Effect.logInfo("stream timing", {
                phase: "ai.first_event", sessionID: session.id, event: event.type, elapsedMs: Date.now() - startedAt,
              })
            }
            if (overflowFailure || publisher.hasProviderError()) return
            if (LLMEvent.is.providerError(event)) {
              if (isContextOverflowFailure(event) && !publisher.hasAssistantStarted()) {
                overflowFailure = event
                return
              }
              terminalError = !isContextOverflowFailure(event)
            }
            if (event.type === "tool-call") hasToolCall = true
            if (event.type === "text-delta") {
              // 拒绝越界delta后撤回已接受前缀，flush和durable/live清理仍走同一发布owner。
              if (attemptTextChars + event.text.length > 64 * 1024) {
                yield* withPublication(publisher.failAssistant(outputLength.reason.message, false, false, true))
                return yield* outputLength
              }
              attemptTextChars += event.text.length
            }
            if (event.type === "step-finish" && event.reason === "unknown" && !hasToolCall && !publisher.stepSettlement()) {
              // 成功事件和用量确认前清理；tool-bearing attempt 从不重放。
              yield* withPublication(publisher.failAssistant(incomplete.reason.message, false, false, true))
              return yield* incomplete
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
                Effect.gen(function* () {
                  return yield* toolMaterialization.settle({
                  sessionID: session.id,
                  agent: agent.id,
                  assistantMessageID,
                  call: event,
                   loadGoalTurn: () => loadGoalTurn,
                   captureWorktree,
                // 与普通工具结果共用 publication 串行器；回调只交接已限幅的取消证据。
                }, (bounded) => withPublication(publisher.interruptedOutput(event.id, bounded.output)))
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
          // 原生provider turn与AISDK使用相同的十分钟缺省总期限。
          duration: model.timeout ?? 600_000,
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
      }).pipe(Effect.retry({
        schedule: SessionRetry.policy({
          provider: String(model.provider), parse: error => {
            // 必须在set发布Retried之前拒绝终态；Effect v4的while会先执行内层schedule副作用。
            if (error !== incomplete && error !== outputLength) return { name: "UnknownError", data: {} }
            if (error === outputLength && (hasToolCall || outputLimitRetried)) return { name: "MessageOutputLengthError", data: {} }
            if (error === outputLength) outputLimitRetried = true
            retryErrorForAttempt = error === outputLength
              ? new SessionV1.APIError({ message: outputLength.reason.message, isRetryable: true, metadata: { reason: "output-length" } })
              : retryError
            return retryErrorForAttempt.toObject()
          },
          set: ({ attempt }) => Effect.gen(function* () {
            hasToolCall = false
            yield* withPublication(publisher.retry(attempt, retryErrorForAttempt.data))
          }),
        }),
      }))

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
          {
            nearOverflowNotified.delete(session.id)
            return yield* Effect.die(continueAfterOverflowCompaction(currentStep))
          }
          if (overflowFailure) yield* publish(overflowFailure)
          const llmFailure = failure instanceof LLMError ? failure : undefined
          if (llmFailure && !publisher.hasProviderError()) {
            yield* withPublication(publisher.failUnsettledTools("Provider did not return a tool result", true, true))
            yield* withPublication(publisher.failAssistant(llmFailure.reason.message, false, true))
          }
          if (stream._tag === "Failure" && Cause.hasInterrupts(stream.cause)) yield* FiberSet.clear(toolFibers)
          const settled = yield* restore(awaitToolFibers(toolFibers)).pipe(Effect.exit)
          // 熔断不能重放或提前结算本地副作用；原fiber完成后才收尾剩余输入/托管工具。
          if (failure === outputLength)
            yield* withPublication(publisher.failUnsettledTools(outputLength.reason.message, false, true))
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
          // 文件收尾不依赖确认用量；失败仍可保留已完成副作用，中断按source跳过慢Git扫描。
          const aborted = stream._tag === "Failure" && Cause.hasInterrupts(stream.cause) || settled._tag === "Failure" && Cause.hasInterrupts(settled.cause)
          if (startSnapshot && !aborted) {
            const end = yield* snapshots.capture()
            const files = end ? yield* snapshots.files({ from: startSnapshot, to: end })
              .pipe(Effect.catch(() => Effect.succeed(undefined))) : undefined
            yield* withPublication(events.publish(SessionEvent.Step.SnapshotUpdated, {
              sessionID: session.id, timestamp: yield* DateTime.now,
              assistantMessageID: yield* publisher.startAssistant(finalizer),
              snapshot: { start: startSnapshot, ...(end ? { end } : {}), ...(files ? { files } : {}), ...(snapshotAuthority ? { worktree: snapshotAuthority } : {}) },
            }, { finalizer }))
          }
          // step-finish 已确认的消耗不因随后失败退款；消息和账本保留此前失败身份。
          if (stepSettlement) {
            // 工具fibers已结算并持久化；按Started冻结的请求读取，不受新steer或压缩窗口影响。
            const summary = yield* ToolDiffs.summarize(db, {
              sessionID: session.id, assistantMessageID: yield* publisher.startAssistant(finalizer),
              directory: location.directory, worktree: location.project.directory,
            })
            yield* withPublication(
              events.publish(SessionEvent.Step.Ended, {
                sessionID: session.id,
                timestamp: yield* DateTime.now,
                assistantMessageID: yield* publisher.startAssistant(finalizer),
                finish: stepSettlement.finish,
                cost: SessionRunnerModel.cost(selection.pricing, stepSettlement.tokens),
                tokens: stepSettlement.tokens,
                ...(summary ? { summary } : {}),
              // 失败退出仍结算同一确认 step，模式只影响通知，不改变 cost/tokens。
              }, { finalizer }),
            )
            // 沿确认Step结算一次，先于错误/中断传播；不能因当前Goal已终态而退款。
            if (expectedUsage) {
              const tokens = stepSettlement.tokens
              const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000))
              yield* goals.accountUsage(session.id, tokens.input + tokens.output + tokens.reasoning, seconds, expectedUsage).pipe(
                Effect.catchDefect((defect) => Effect.logError("goal accountUsage defect", { defect: String(defect) })),
              )
            }
          }
          if (publisher.hasProviderError())
            yield* withPublication(publisher.failUnsettledTools("Tool execution interrupted", false, finalizer))
          if (stream._tag === "Success" && !publisher.hasProviderError())
            yield* withPublication(publisher.failUnsettledTools("Provider did not return a tool result", true, finalizer))
          if (settled._tag === "Failure" && isUserDeclined(settled.cause)) return yield* Effect.interrupt
          // typed鉴权/路由/格式/策略错误不等同于source的API/Unknown错误。
          // 只在本轮结算后读取显式策略，原始中断和未授权错误继续传播同一cause。
          const eligibleFailure = stream._tag === "Failure" && !Cause.hasInterrupts(stream.cause) && llmFailure && !isContextOverflowFailure(llmFailure) && !["Authentication", "NoRoute", "InvalidProviderOutput", "ContentPolicy"].includes(llmFailure.reason._tag)
          const goal = (stream._tag === "Success" && terminalError) || eligibleFailure ? yield* goals.get(session.id) : Option.none()
          const continueAfterError = Option.isSome(goal) && goal.value.status === "active" && goal.value.continueOnError
          if (stream._tag === "Failure") {
            // LLMError 已按上游 hosted-only 清理；其他 cause 才补清理，保留本地 raw partial。
            if (!llmFailure) yield* withPublication(publisher.failUnsettledTools("Provider did not return a tool result", false, true))
            if (publisher.hasAssistantStarted() && !Cause.hasInterrupts(stream.cause))
              yield* withPublication(publisher.failAssistant(String(Cause.squash(stream.cause)), false, true))
            if (!continueAfterError) return yield* Effect.failCause(stream.cause)
          }
          if (settled._tag === "Failure" && Cause.hasInterrupts(settled.cause))
            return yield* Effect.failCause(settled.cause)
          if (!continueAfterError && publisher.hasActiveAssistant() && !stepSettlement) {
            // 无内容 turn 的 Started 可迟于 step-finish；结算快照存在时不能按 active 误报 EOF。
            yield* withPublication(publisher.failAssistant("Provider stream ended before assistant step finish"))
            // 只补消息和账本终态；raw EOF 的成功返回及原 continuation 契约保持。
          }
          return {
            needsContinuation: !continueAfterError && !publisher.hasProviderError() && needsContinuation,
            canContinueGoal: continueAfterError || (!!stepSettlement && !publisher.hasProviderError() && !["tool-calls", "unknown", "error"].includes(stepSettlement.finish ?? "unknown")),
            step: currentStep,
          }
        }),
      )
    }, Effect.scoped)
    type RunTurn = (
      sessionID: SessionSchema.ID,
      promotion: SessionInput.Delivery | undefined,
      step: number,
      continuation: GoalContinuation,
    ) => Effect.Effect<{ readonly needsContinuation: boolean; readonly canContinueGoal: boolean; readonly step: number }, RunError>

    const runAfterOverflowCompaction: RunTurn = Effect.fnUntraced(function* (sessionID, promotion, step, continuation) {
      return yield* runTurnAttempt(sessionID, promotion, step, continuation).pipe(
        Effect.catchDefect(
          Effect.fnUntraced(function* (defect) {
            if (!(defect instanceof TurnTransitionError)) return yield* Effect.die(defect)
            if (defect.transition._tag === "ContinueAfterOverflowCompaction")
              return yield* Effect.die("Post-compaction provider attempt cannot recover another overflow")
            yield* Effect.yieldNow
            return yield* runAfterOverflowCompaction(sessionID, undefined, defect.transition.step, continuation)
          }),
        ),
      )
    })

    const runTurn: RunTurn = Effect.fnUntraced(function* (sessionID, promotion, step, continuation) {
      return yield* runTurnAttempt(sessionID, promotion, step, continuation, compaction.compactAfterOverflow).pipe(
        Effect.catchDefect(
          Effect.fnUntraced(function* (defect) {
            if (!(defect instanceof TurnTransitionError)) return yield* Effect.die(defect)
            yield* Effect.yieldNow
            if (defect.transition._tag === "ContinueAfterOverflowCompaction")
              return yield* runAfterOverflowCompaction(sessionID, undefined, defect.transition.step, continuation)
            return yield* runTurn(sessionID, undefined, defect.transition.step, continuation)
          }),
        ),
      )
    })

    const run = Effect.fn("SessionRunner.run")(function* (input: {
      readonly sessionID: SessionSchema.ID
      readonly force: boolean
      readonly maintenance?: "compact"
    }) {
      nearOverflowNotified.delete(input.sessionID)
      if (input.maintenance === "compact") {
        const session = yield* getSession(input.sessionID)
        if (session.location.directory !== location.directory || session.location.workspaceID !== location.workspaceID)
          return yield* Effect.interrupt
        const agent = yield* agents.select(session.agent)
        const prepared = yield* prepareTurn(session.id, agent)
        const initialized = yield* SessionContextEpoch.initialize(db, prepared.context, session.id)
        const system = initialized ?? (yield* SessionContextEpoch.prepare(db, events, prepared.context, session.id))
        const entries = yield* SessionHistory.entriesForRunner(db, session.id, system.baselineSeq)
        if (entries.length === 0) return
        const selection = yield* models.resolve(session)
        const request = LLM.request({
          model: selection.model,
          messages: [],
          // 手动摘要没有普通turn request，仍从现有可信agent与epoch构造指令。
          ...(selection.openaiOAuth ? { providerOptions: { openai: { instructions: [
            agent.info?.system ?? SessionPrompts.provider(String(selection.model.id), String(selection.model.provider)), system.baseline,
          ].filter(Boolean).join("\n") } } } : {}),
          http: { headers: {
            "x-session-affinity": session.id,
            // 手动摘要独立构造请求，也沿用所选OpenAI模型的完整会话亲和身份。
            ...(selection.model.provider === "openai" ? { "session-id": session.id } : {}),
            "X-Session-Id": session.id,
            ...(session.parentID ? { "x-parent-session-id": session.parentID } : {}),
          } },
        })
        // 只执行一次共享摘要；不提升 inbox，也不进入普通工具/续跑循环。
        if (yield* compaction.compact({ sessionID: session.id, entries, model: selection.model, pricing: selection.pricing, variant: session.model?.variant, request })) return
        return yield* new LLMError({
          module: "SessionCompaction",
          method: "compact",
          reason: new InvalidProviderOutputReason({ message: "Compaction did not produce a usable summary" }),
        })
      }
      const hasSteer = yield* SessionInput.hasPending(db, input.sessionID, "steer")
      const hasQueue = hasSteer ? false : yield* SessionInput.hasPending(db, input.sessionID, "queue")
      if (!input.force && !hasSteer && !hasQueue) return
      yield* failInterruptedTools(input.sessionID)
      let promotion: SessionInput.Delivery | undefined = hasSteer ? "steer" : hasQueue ? "queue" : undefined
      // frontier 仅属于本次 drain；新唤醒不继承旧运行的停滞或验证基线。
      const continuation: GoalContinuation = { turns: 0, progressLedger: SessionGoalProgress.createGoalProgressLedger(), progressGate: { noProgressTurns: 0, replanRequired: false } }
      let shouldRun = input.force || hasSteer || hasQueue
      while (shouldRun) {
        let needsContinuation = true
        let step = 1
        while (needsContinuation) {
          const result = yield* runTurn(input.sessionID, promotion, step, continuation)
          needsContinuation = result.needsContinuation
          step = result.step + 1
          promotion = "steer"
          if (!needsContinuation) needsContinuation = yield* SessionInput.hasPending(db, input.sessionID, "steer")
          if (!needsContinuation && result.canContinueGoal && !(yield* SessionInput.hasPending(db, input.sessionID, "queue"))) {
            const maxGoalTurns = Config.latest(configuration, "goal_max_turns") ?? 32
            const session = yield* getSession(input.sessionID)
            const agent = yield* agents.select(session.agent)
            if (continuation.turns < maxGoalTurns &&
              !session.parentID && agent.id !== "decide" && result.step < (agent.info?.steps ?? Infinity)) {
              const goal = yield* goals.get(input.sessionID)
              if (Option.isSome(goal) && goal.value.status === "active") {
                // 只在既有 eligible completion 边界计一次，provider step 或 compaction 不另计轮。
                const messages = yield* SessionHistory.goalTurnMessages(db, input.sessionID)
                const signal = SessionGoalProgress.absorbGoalTurnEvidence(
                  SessionGoalProgress.nativeEvidence(messages), location.directory, continuation.progressLedger,
                )
                SessionGoalProgress.updateGoalProgressGate(continuation.progressGate, signal)
                continuation.mode = continuation.progressGate.replanRequired ? "replan" : "ordinary"
                continuation.goal = {
                  ...goal.value, maxTurns: maxGoalTurns,
                  // blockedAttempt 已由真实 GoalTool 校验并保存，不从 prose 或可变状态反推。
                  viewMode: messages.some(message => message.type === "assistant" && message.content.some(part => part.type === "tool" && part.name === "goal" && part.state.status === "completed" && part.state.structured.blockedAttempt !== undefined))
                    ? "block-check" : continuation.mode === "replan" ? "replan" : "continue",
                }
                needsContinuation = true
                // 下个安全边界也检查 queue，避免候选 Goal 抢占刚到达的用户输入。
                promotion = "queue"
              }
            }
            // 只在正常Goal边界耗尽正额度时暂停，0与异常退出不触发状态迁移。
            if (maxGoalTurns > 0 && !session.parentID && continuation.turns >= maxGoalTurns) {
              const goal = yield* goals.get(input.sessionID)
              if (Option.isSome(goal) && goal.value.status === "active") yield* goals.set(input.sessionID, { status: "paused" }).pipe(Effect.orDie)
            }
          }
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
    McpTools.node,
    SessionStore.node,
    SessionGoal.node,
    SessionTodo.node,
    Location.node,
    SystemContextRegistry.node,
    SkillGuidance.node,
    ReferenceGuidance.node,
    Config.node,
    Image.node,
    Snapshot.node,
    Database.node,
    FSUtil.node,
    PermissionV2.node,
    Global.node,
  ],
})
