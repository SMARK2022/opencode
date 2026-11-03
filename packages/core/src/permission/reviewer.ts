export * as PermissionReviewer from "./reviewer"

import path from "path"
import { Question } from "@opencode-ai/schema/question"
import { LLM, LLMClient, LLMEvent, Tool, ToolChoice } from "@opencode-ai/llm"
import { Cause, Context, DateTime, Effect, FileSystem, Layer, Option, Schema, Semaphore, Stream } from "effect"
import { and, desc, eq, inArray, lt, sql } from "drizzle-orm"
import { Catalog } from "../catalog"
import { ColdStorage } from "../storage/cold-storage"
import { Config } from "../config"
import { ConfigAutoReview } from "../config/auto-review"
import { Database } from "../database/database"
import { EventV2 } from "../event"
import { ProviderV2 } from "../provider"
import { SessionEvent } from "../session/event"
import { SessionProjector } from "../session/projector"
import { SessionMessageTable, SessionTable } from "../session/sql"
import { createLLMEventPublisher } from "../session/runner/publish-llm-event"
import { Slug } from "../util/slug"
import { Token } from "../util/token"
import { SessionV1 } from "../v1/session"
import { makeLocationNode } from "../effect/app-node"
import { LayerNodePlatform } from "../effect/app-node-platform"
import { Location } from "../location"
import { ModelV2 } from "../model"
import { SessionMessage } from "../session/message"
import { SessionSchema } from "../session/schema"
import { SessionStore } from "../session/store"
import { SessionRunnerModel } from "../session/runner/model"
import { PermissionAuto } from "./auto"
import { PermissionReviewerPrompt } from "./reviewer/prompt"
import { PermissionReviewerSchema } from "./reviewer/schema"

export class Disabled extends Schema.TaggedErrorClass<Disabled>()("PermissionReviewerDisabled", {}) {}
export class Failed extends Schema.TaggedErrorClass<Failed>()("PermissionReviewerRunError", {
  reason: Schema.String,
}) {}
export class FallbackToUser extends Schema.TaggedErrorClass<FallbackToUser>()("PermissionReviewerFallbackToUser", {
  reason: Schema.String,
}) {}
export class Service extends Context.Service<Service, PermissionAuto.Reviewer>()("@opencode/core/PermissionReviewer") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const catalog = yield* Catalog.Service
    const sessions = yield* SessionStore.Service
    const models = yield* SessionRunnerModel.Service
    const client = yield* LLMClient.Service
    const fs = yield* FileSystem.FileSystem
    const location = yield* Location.Service
    const database = yield* Database.Service
    const db = database.db
    const events = yield* EventV2.Service
    const reviewerLocks = new Map<SessionSchema.ID, Semaphore.Semaphore>()
    // 与V1相同的provider层内记忆；协商不另建请求身份或持久化能力探测结果。
    const toolChoiceRejectedProviders = new Set<string>()
    const review = Effect.fn("PermissionReviewer.review")(function* (input: PermissionAuto.ReviewInput) {
      const entries = yield* config.entries()
      const sessionID = input.sessionID
      const selected = Config.latest(entries, "approvals_reviewer")
      // auto准入已由权限owner决定；执行代理名称只作证据，显式user仍保留人工审批。
      if (!sessionID || selected === "user") return yield* new Disabled()
      // 按字段合并各层配置，较近文档只覆盖它明确提供的策略项。
      const options = entries
        .flatMap((entry) => (entry.type === "document" && entry.info.auto_review ? [entry.info.auto_review] : []))
        .reduce<
          NonNullable<ConstructorParameters<typeof ConfigAutoReview.Info>[0]>
        >((value, next) => ({ ...value, ...next }), {})
      const timedOut = new Failed({ reason: "auto reviewer timed out" })
      const run = Effect.gen(function* () {
        const session = yield* sessions.get(SessionSchema.ID.make(sessionID))
        if (!session) return yield* new Failed({ reason: "Review session was not found" })
        const target = options.model ? ModelV2.parse(options.model) : undefined
        // 两条既有解析分支共用选档；只把实际广告的档名交给原lowering，不改模型或认证owner。
        const resolve = (ref: SessionSchema.Info["model"]) =>
          Effect.gen(function* () {
            const configured = ref ? yield* catalog.model.get(ref.providerID, ref.id) : yield* catalog.model.default()
            const model =
              ref || (configured && SessionRunnerModel.supported(configured))
                ? configured
                : (yield* catalog.model.available()).find(SessionRunnerModel.supported)
            const variant = [options.effort, "low", "minimal", "none"]
              .map((name) => model?.variants.find((variant) => variant.id === name))
              .find((variant) => variant !== undefined)
            const result = yield* models.resolve({
              ...session,
              model: model && variant ? { id: model.id, providerID: model.providerID, variant: variant.id } : ref,
            })
            return { ...result, effortVariant: variant?.id }
          })
        const ref = target ? { id: target.modelID, providerID: target.providerID } : session.model
        const selected = yield* resolve(ref).pipe(
          // 仅source规定的失效隐式候选回退一次；显式配置及认证、取消等其它失败继续报错。
          Effect.catchTag("SessionRunnerModel.ModelUnavailableError", (error) =>
            target ? Effect.fail(error) : resolve(undefined),
          ),
        )
        const history = yield* sessions.context(session.id)
        const snapshot = yield* reviewerSnapshot(database, session.id)
        const policy = options.policy_path
          ? yield* fs.readFileString(path.resolve(location.directory, options.policy_path))
          : ""
        const tenant = [PermissionReviewerPrompt.DEFAULT_TENANT_POLICY, policy, options.policy]
          .filter(Boolean)
          .join("\n\n")
        const request = new PermissionReviewerSchema.ReviewerRequest({
          permission: input.permission,
          patterns: [...input.patterns],
          metadata: { ...input.metadata },
          precheck: input.precheck,
        })
        const rendered = history.slice(-120).map((message) => {
          const text = render(message)
          const role: PermissionReviewerPrompt.TranscriptEntry["role"] =
            message.type === "user" ? "user" : message.type === "shell" ? "tool" : "assistant"
          // 全文授权已在独立快照，滚动窗口各角色统一1000字符头截断。
          return { role, text: truncate(text, 1000), truncated: text.length > 1000 }
        })
        const visible = rendered.filter((entry) => entry.text.trim())
        const retained = visible.slice(-40)
        const items = PermissionReviewerPrompt.buildUserPromptItems(
          {
            snapshot,
            window: {
              entries: retained.map(({ role, text }) => ({ role, text })),
              truncated: history.length > 120 || visible.length > retained.length,
              entryTruncated: retained.some((entry) => entry.truncated),
              emptyEntries: rendered.length > visible.length,
            },
          },
          request,
          input.precheck.reason,
        )
        const system = PermissionReviewerPrompt.buildSystemPrompt(tenant)
        const prompt = items.map((item) => item.text).join("\n\n")
        const model = {
          id: ModelV2.ID.make(selected.model.id),
          providerID: ProviderV2.ID.make(selected.model.provider),
        }
        const reviewerSession = yield* getReviewerSession(session, model)
        yield* updateToolAutoReview(input, { status: "reviewing", sessionID: reviewerSession })
        const protocolError = new Failed({ reason: "reviewer did not call permission_review_decision" })
        const decodeAssessment = Schema.decodeUnknownOption(PermissionReviewerSchema.Assessment)
        const runReviewerAttempt = (attemptPrompt: string, hideProtocolFailure: boolean) =>
          Effect.gen(function* () {
            const reviewerRequestID = SessionMessage.ID.create()
            // 每次尝试保留真实请求；相同reviewID不代替请求/助手的独立身份。
            yield* events.publish(
              SessionEvent.Synthetic,
              {
                sessionID: reviewerSession,
                messageID: reviewerRequestID,
                timestamp: yield* DateTime.now,
                text: `reviewID=${input.reviewID}\ntool=${JSON.stringify(input.tool ?? null)}\n\nsystem: ${system}\n\nuser: ${attemptPrompt}`,
                // 审计名称与实际选档共用一次结果，保持原reviewID/请求身份及事件清理合同。
              },
              {
                metadata: {
                  permissionReviewerRequest: true,
                  reviewID: input.reviewID,
                  ...(selected.effortVariant ? { effortVariant: selected.effortVariant } : {}),
                },
              },
            )
            // 审查使用自己的确认样本；父对话和并行审查的未结算估计不能参与校准。
            const samples = Token.inputHistory(yield* sessions.context(reviewerSession), selected.model)
            let inputEstimate: SessionMessage.InputEstimate | undefined
            const publisher = createLLMEventPublisher(
              events,
              {
                sessionID: reviewerSession,
                agent: "permission-reviewer",
                model,
                inputEstimate: () => inputEstimate,
              },
              {
                permissionReviewerRequestID: reviewerRequestID,
                reviewID: input.reviewID,
              },
            )
            let assessment: typeof PermissionReviewerSchema.Assessment.Type | undefined
            let textOutput = ""
            const forced = !toolChoiceRejectedProviders.has(selected.model.provider)
            const request = LLM.request({
              toolChoice: forced ? ToolChoice.make("required") : undefined,
              model: selected.model,
              prompt: attemptPrompt,
              // reviewer直接调用LLM而不经过V1插件，同一OpenAI会话仍需使用相同代理亲和身份。
              ...(selected.model.provider === "openai" ? { http: { headers: { "session-id": session.id } } } : {}),
              // 逐次移动同一可信原话；证据与协议修复提示始终留在user通道。
              ...(selected.openaiOAuth ? { providerOptions: { openai: { instructions: system } } } : { system }),
              tools: Tool.toDefinitions({
                permission_review_decision: Tool.make({
                  description: "Submit the structured allow/deny decision for this permission review.",
                  parameters: PermissionReviewerSchema.Assessment,
                  success: Schema.Unknown,
                }),
              }),
            })
            const onPrepared = (body: unknown) =>
              Effect.sync(() => {
                // 同一次compile的最终正文包含真正发出的工具；OAuth策略只归instructions，不重复归system正文。
                inputEstimate = {
                  ...Token.estimateRequest(
                    body,
                    samples,
                    selected.openaiOAuth ? [{ kind: "instructions", text: system }] : [],
                  ),
                  contextLimit:
                    selected.model.defaults?.limits?.context ?? selected.model.route.defaults.limits?.context ?? 0,
                }
                // Started读取本尝试的估算；原有Ended仍独立确认真实用量与费用。
              })
            return yield* client.stream(request, onPrepared).pipe(
              // typed400发生于事件交付之前；只在同次timeout和publisher内去参重发一次。
              Stream.catch((error) => {
                if (
                  !forced ||
                  !("http" in error.reason) ||
                  error.reason.http?.response?.status !== 400 ||
                  !/tool[_ ]?choice/i.test(error.reason.http.body ?? "")
                )
                  return Stream.fail(error)
                toolChoiceRejectedProviders.add(selected.model.provider)
                return client.stream(LLM.updateRequest(request, { toolChoice: undefined }), onPrepared)
              }),
              Stream.runForEach((event) =>
                Effect.gen(function* () {
                  if (event.type === "tool-error") return yield* protocolError
                  yield* publisher.publish(event)
                  if (event.type === "provider-error") return yield* new Failed({ reason: event.message })
                  if (event.type === "text-delta") textOutput += event.text
                  if (event.type !== "tool-call" || event.name !== "permission_review_decision") return
                  assessment = Option.getOrUndefined(decodeAssessment(event.input))
                  if (!assessment) return yield* protocolError
                  yield* publisher.publish(
                    LLMEvent.toolResult({
                      id: event.id,
                      name: event.name,
                      result: { type: "text", value: JSON.stringify(assessment) },
                      output: {
                        structured: { ...assessment, reviewID: input.reviewID, source: "tool_call" },
                        content: [{ type: "text", text: JSON.stringify(assessment) }],
                      },
                    }),
                  )
                }),
              ),
              Effect.flatMap(() =>
                Effect.gen(function* () {
                  if (assessment) return assessment
                  // 文本兼容只在原裁决边界提取首个对象，继续经过同一Schema及策略校验。
                  const fallback = Option.getOrUndefined(assessmentFromText(textOutput))
                  if (!fallback) return yield* protocolError
                  const callID = `json_fallback_${input.reviewID}`
                  yield* publisher.publish(
                    LLMEvent.toolCall({ id: callID, name: "permission_review_decision", input: fallback }),
                  )
                  yield* publisher.publish(
                    LLMEvent.toolResult({
                      id: callID,
                      name: "permission_review_decision",
                      result: { type: "text", value: JSON.stringify(fallback) },
                      output: {
                        structured: { ...fallback, reviewID: input.reviewID, source: "json_fallback" },
                        content: [{ type: "text", text: JSON.stringify(fallback) }],
                      },
                    }),
                  )
                  return fallback
                }),
              ),
              // 每次拥有完整执行期限；仍先完成原onExit收尾，再向外层交付超时供补试。
              Effect.timeoutOrElse({ duration: options.timeout_ms ?? 120_000, orElse: () => Effect.fail(timedOut) }),
              Effect.onExit((exit) =>
                Effect.gen(function* () {
                  const finalizer = exit._tag === "Failure"
                  const failure = exit._tag === "Failure" ? Cause.squash(exit.cause) : undefined
                  const reason =
                    exit._tag === "Success"
                      ? "Tool execution did not complete before stream ended"
                      : failure instanceof Error
                        ? failure.message
                        : "Review cancelled"
                  const closeTools = publisher.failUnsettledTools(reason, false, finalizer)
                  // 首次工具提交失败仍在助手完成前复扫同一身份；flush或再次清理失败仅记录，保留原退出原因。
                  yield* publisher.flush(finalizer).pipe(
                    Effect.ensuring(
                      closeTools.pipe(
                        Effect.catchCause((cause) =>
                          Effect.logWarning("reviewer tool finalization failed", { cause }).pipe(
                            Effect.andThen(closeTools),
                          ),
                        ),
                      ),
                    ),
                    Effect.catchCause((cause) => Effect.logWarning("reviewer attempt finalization failed", { cause })),
                  )
                  if (exit._tag === "Failure") {
                    yield* publisher.failAssistant(reason, Cause.hasInterrupts(exit.cause), true)
                  }
                  const settlement = publisher.stepSettlement()
                  if (exit._tag === "Success" || settlement) {
                    const usage = settlement?.tokens ?? {
                      input: 0,
                      output: 0,
                      reasoning: 0,
                      cache: { read: 0, write: 0 },
                    }
                    // 每次真实消耗独立结算；隐藏失败轮次不退款，也不算入父请求。
                    yield* events.publish(
                      SessionEvent.Step.Ended,
                      {
                        sessionID: reviewerSession,
                        timestamp: yield* DateTime.now,
                        assistantMessageID: yield* publisher.startAssistant(finalizer),
                        finish: settlement?.finish ?? "tool-calls",
                        cost: SessionRunnerModel.cost(selected.pricing, usage),
                        tokens: usage,
                      },
                      { finalizer },
                    )
                  }
                }),
              ),
              Effect.tapError((error) => {
                if (error !== protocolError || !hideProtocolFailure) return Effect.void
                return Effect.gen(function* () {
                  const timestamp = yield* DateTime.now
                  const assistantID = publisher.peekAssistantMessageID()
                  yield* events.publish(SessionEvent.MessagesHidden, {
                    sessionID: reviewerSession,
                    timestamp,
                    messageIDs: assistantID ? [reviewerRequestID, assistantID] : [reviewerRequestID],
                    hidden: { time: DateTime.toEpochMillis(timestamp), reason: "permission-reviewer-protocol-retry" },
                  })
                })
              }),
            )
          })
        // 三次预算只覆盖本请求的超时/协议错误，provider失败和取消不补试。
        const attempt = (
          index: number,
          currentPrompt = prompt,
        ): Effect.Effect<PermissionReviewerSchema.Assessment, Effect.Error<ReturnType<typeof runReviewerAttempt>>> =>
          runReviewerAttempt(currentPrompt, index === 0).pipe(
            Effect.catchIf(
              (error) => error === protocolError || error === timedOut,
              (error) => {
                if (index >= 2) return Effect.fail(error)
                // 以最近失败重建单份后缀；先完成原收尾，不累积旧提示或扩大授权证据。
                return attempt(
                  index + 1,
                  `${prompt}\n\n${error === protocolError ? PermissionReviewerPrompt.PROTOCOL_RETRY_TEXT : PermissionReviewerPrompt.TIME_BUDGET_RETRY_USER_ITEM.text}`,
                )
              },
            ),
          )
        const result = yield* attempt(0)
        yield* updateToolAutoReview(input, { status: result.outcome === "allow" ? "allowed" : "denied", result })
        return {
          action: result.outcome,
          reason: result.rationale,
          reviewID: input.reviewID,
          risk_level: result.risk_level,
          user_authorization: result.user_authorization,
        } satisfies PermissionAuto.ReviewDecision
      }).pipe(
        Effect.mapError((error) =>
          error instanceof Failed
            ? error
            : new Failed({ reason: error instanceof Error ? error.message : String(error) }),
        ),
      )
      // 用户审批回退是显式配置；其他失败由共享 auto 路由拒绝，绝不转换成成功。
      return yield* run.pipe(
        Effect.onExit((exit) => {
          if (exit._tag === "Success") return Effect.void
          const error = Cause.squash(exit.cause)
          // 期限身份来自本次timeout错误对象；取消不靠英文文案猜测，也不变成用户批准。
          return updateToolAutoReview(
            input,
            {
              status: Cause.hasInterrupts(exit.cause)
                ? "aborted"
                : options.fallback === "user"
                  ? "fallback_user"
                  : error === timedOut
                    ? "timed_out"
                    : "failed",
              error: error instanceof Error ? error.message : "Review cancelled",
            },
            true,
          )
        }),
        Effect.catch((error) =>
          Effect.fail(options.fallback === "user" ? new FallbackToUser({ reason: error.reason }) : error),
        ),
      )
    })
    return Service.of({ review })

    function getReviewerSession(parent: SessionSchema.Info, model: ModelV2.Ref) {
      const lock = reviewerLocks.get(parent.id) ?? Semaphore.makeUnsafe(1)
      reviewerLocks.set(parent.id, lock)
      return lock.withPermit(
        Effect.gen(function* () {
          const existing = yield* db
            .select({ id: SessionTable.id })
            .from(SessionTable)
            .where(and(eq(SessionTable.parent_id, parent.id), eq(SessionTable.agent, "permission-reviewer")))
            .limit(1)
            .get()
            .pipe(Effect.orDie)
          if (existing) return SessionSchema.ID.make(existing.id)
          const row = yield* db
            .select()
            .from(SessionTable)
            .where(eq(SessionTable.id, parent.id))
            .get()
            .pipe(Effect.orDie)
          if (!row) return yield* new Failed({ reason: "Review session was not found" })
          const id = SessionSchema.ID.create()
          const now = Date.now()
          // 只复用父会话placement；通过同一Created投影建审查子会话，不继承分享或执行状态。
          yield* events.publish(
            SessionV1.Event.Created,
            {
              sessionID: id,
              info: SessionV1.SessionInfo.make({
                id,
                slug: Slug.create(),
                version: row.version,
                projectID: row.project_id,
                directory: row.directory,
                path: row.path ?? undefined,
                workspaceID: row.workspace_id ?? undefined,
                parentID: parent.id,
                title: "Auto permission review (@permission-reviewer subagent)",
                agent: "permission-reviewer",
                model,
                cost: 0,
                tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                time: { created: now, updated: now },
              }),
            },
            { location: parent.location },
          )
          return id
        }),
      )
    }

    function updateToolAutoReview(
      input: PermissionAuto.ReviewInput,
      patch: Record<string, unknown>,
      finalizer = false,
    ) {
      const binding = input.tool
      if (!input.sessionID || !binding) return Effect.void
      return Effect.gen(function* () {
        const recorded = yield* sessions.message(SessionMessage.ID.make(binding.messageID))
        if (!recorded || recorded.sessionID !== input.sessionID || recorded.message.type !== "assistant") return
        const part = recorded.message.content.find((part) => part.type === "tool" && part.id === binding.callID)
        if (!part || part.type !== "tool" || part.state.status !== "running") return
        // 已结算或过期引用不重启工具；仅在现有running投影记录关联，不泄漏审查正文。
        const current = part.state.structured.autoReview
        // 迟到取消只补reviewing，不能把已有裁决或失败终态覆写为aborted。
        if (
          patch.status === "aborted" &&
          typeof current === "object" &&
          current !== null &&
          "status" in current &&
          current.status &&
          current.status !== "reviewing"
        )
          return
        yield* events.publish(
          SessionEvent.Tool.Progress,
          {
            sessionID: recorded.sessionID,
            assistantMessageID: recorded.message.id,
            callID: binding.callID,
            timestamp: yield* DateTime.now,
            structured: {
              ...part.state.structured,
              autoReview: {
                ...(typeof current === "object" && current !== null && !Array.isArray(current) ? current : {}),
                reviewID: input.reviewID,
                precheck: input.precheck,
                ...patch,
              },
            },
            content: part.state.content,
          },
          { finalizer },
        )
      }).pipe(
        // 父工具展示是附属状态，写入失败不得覆盖已获得的裁决；中断继续传播。
        Effect.catch(() => Effect.void),
        Effect.catchDefect(() => Effect.void),
      )
    }
  }),
)

function assessmentFromText(text: string) {
  const json = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)
  const decode = Schema.decodeUnknownOption(PermissionReviewerSchema.Assessment)
  const direct = Option.flatMap(json(text.trim()), decode)
  if (Option.isSome(direct)) return direct
  const start = text.indexOf("{")
  if (start < 0) return Option.none()
  // 仅提取第一个完整对象；字符串内括号和转义不参与深度，禁止搜索后续候选。
  let depth = 0
  let quoted = false
  let escaped = false
  for (let index = start; index < text.length; index++) {
    const character = text[index]
    if (quoted) {
      if (escaped) escaped = false
      else if (character === "\\") escaped = true
      else if (character === '"') quoted = false
      continue
    }
    if (character === '"') quoted = true
    else if (character === "{") depth++
    else if (character === "}" && --depth === 0) return Option.flatMap(json(text.slice(start, index + 1)), decode)
  }
  return Option.none()
}

function render(message: SessionMessage.Message) {
  if (message.type === "synthetic" || message.type === "system") return ""
  if (message.type === "assistant")
    return message.content
      .map((part) => {
        if (part.type === "reasoning") return ""
        if (part.type !== "tool") return truncate(part.text)
        const state = part.state
        const body =
          state.status === "pending"
            ? state.input
            : state.status === "error"
              ? state.error.message
              : state.content.map((item) => (item.type === "text" ? item.text : `[Attached ${item.mime}]`)).join("\n")
        return `<tool name="${part.name}" status="${state.status}">\n${truncate(JSON.stringify(state.input))}\n${truncate(body)}\n</tool>`
      })
      .join("\n")
  if (message.type === "user")
    return truncate(
      [message.text, ...(message.files ?? []).map((file) => `[Attached ${file.mime}: ${file.name ?? ""}]`)].join("\n"),
    )
  if (message.type === "compaction") return truncate(`${message.summary}\n${message.recent}`)
  if (message.type === "shell") return truncate(`${message.command}\n${message.output}`)
  return `<${message.type} />`
}

// 单段和整条截短都留下显式证据标记，而不是静默丢弃剩余内容。
function truncate(text: string, limit = 4000) {
  if (text.length <= limit) return text
  return text.slice(0, limit) + `\n<truncated chars="${text.length - limit}" />`
}

// 原生授权取自未被compaction裁剪的投影表；不读取待提升inbox或已撤回的事件尾部。
function reviewerSnapshot(database: Database.Interface, sessionID: SessionSchema.ID) {
  return Database.withSync(database, (db) => {
    const visible = sql`not coalesce((json_extract(${SessionMessageTable.data}, '$.metadata.hidden.reason') = 'permission-reviewer-protocol-retry'
      and json_type(${SessionMessageTable.data}, '$.metadata.hidden.time') = 'integer'
      and json_extract(${SessionMessageTable.data}, '$.metadata.hidden.time') >= 0), 0)`
    const decode = Schema.decodeUnknownSync(SessionMessage.Message)
    // 用户、QA和决定共用原只读恢复边界；定位后的cold正文不写热行或消费引用。
    const read = (rows: (typeof SessionMessageTable.$inferSelect)[]) =>
      ColdStorage.inspectSessionMessageRows(db, rows).map((row) => ({
        id: row.id,
        seq: row.seq,
        message: decode({ ...row.data, id: row.id, type: row.type }),
      }))
    const locations = db.all<{ id: SessionMessage.ID; seq: number; position: number }>(sql`
      select ${SessionMessageTable.id} as id, ${SessionMessageTable.seq} as seq, cast(p.key as integer) as position
      from ${SessionMessageTable}, json_each(${SessionMessageTable.data}, '$.content') p
      where ${SessionMessageTable.session_id} = ${sessionID} and ${SessionMessageTable.type} = 'assistant' and ${visible}
        and json_extract(p.value, '$.type') = 'tool' and json_extract(p.value, '$.name') = 'question'
        and json_extract(p.value, '$.state.status') = 'completed'
      order by ${SessionMessageTable.seq}, cast(p.key as integer) limit 101
    `)
    const qaMessages = new Map(
      read(
        db
          .select()
          .from(SessionMessageTable)
          .where(
            inArray(
              SessionMessageTable.id,
              locations.map((row) => row.id),
            ),
          )
          .all(),
      ).map((row) => [row.id, row.message]),
    )
    const qa = locations.map((row) => {
      const message = qaMessages.get(row.id)
      const part = message?.type === "assistant" ? message.content[row.position] : undefined
      return {
        seq: row.seq,
        questions: part?.type === "tool" && part.state.status === "completed" ? part.state.input.questions : undefined,
        answers: part?.type === "tool" && part.state.status === "completed" ? part.state.structured.answers : undefined,
      }
    })
    const pairs = qa.slice(0, 100).flatMap((row) => {
      const questions = Schema.decodeUnknownOption(Schema.Array(Question.Prompt))(row.questions)
      const answers = Schema.decodeUnknownOption(Schema.Array(Schema.Array(Schema.String)))(row.answers)
      if (Option.isNone(questions) || Option.isNone(answers)) return []
      // 问题只作300字符锚点，用户的每个答案全文保留。
      return questions.value.flatMap((question, index) => {
        const answer = answers.value[index]?.join(", ")
        return answer
          ? [
              {
                seq: row.seq,
                entry: {
                  kind: "qa",
                  question: question.question.length > 300 ? question.question.slice(0, 300) + "…" : question.question,
                  answer,
                } satisfies PermissionReviewerPrompt.ReviewerSnapshotEntry,
              },
            ]
          : []
      })
    })
    // 完成的审查决定可能先于工具完成落盘；不能把running裁决或冷structured当成不存在。
    const decisions: { seq: number; entry: PermissionReviewerPrompt.ReviewerSnapshotEntryDecision }[] = []
    let decisionBefore: number | undefined
    while (decisions.length <= 60) {
      const rows = db
        .select()
        .from(SessionMessageTable)
        .where(
          and(
            eq(SessionMessageTable.session_id, sessionID),
            eq(SessionMessageTable.type, "assistant"),
            visible,
            decisionBefore === undefined ? undefined : lt(SessionMessageTable.seq, decisionBefore),
            sql`exists (select 1 from json_each(${SessionMessageTable.data}, '$.content') p where json_extract(p.value, '$.type') = 'tool'
          and json_extract(p.value, '$.name') <> 'question' and (${SessionMessageTable.cold_ref} is not null
            or json_extract(p.value, '$.state.structured.autoReview.status') in ('allowed', 'denied', 'fallback_user')
            or json_extract(p.value, '$.state.error.message') like 'The user rejected permission%'))`,
          ),
        )
        .orderBy(desc(SessionMessageTable.seq))
        .limit(64)
        .all()
      if (!rows.length) break
      for (const row of read(rows)) {
        if (row.message.type !== "assistant") continue
        for (const part of row.message.content.toReversed()) {
          if (part.type !== "tool" || part.name === "question" || part.state.status === "pending") continue
          const review: unknown = part.state.structured.autoReview
          const status = review && typeof review === "object" && "status" in review ? review.status : undefined
          const result = review && typeof review === "object" && "result" in review ? review.result : undefined
          const reason =
            result && typeof result === "object" && "rationale" in result && typeof result.rationale === "string"
              ? result.rationale
              : undefined
          const label =
            part.state.status === "error" && part.state.error.message.startsWith("The user rejected permission")
              ? `[PERMISSION: USER-REJECTED] ${part.name}`
              : part.state.status === "completed" && status === "fallback_user"
                ? `[PERMISSION: USER-ALLOWED-AFTER-ASK] ${part.name}`
                : status === "denied"
                  ? `[AUTO-REVIEW: DENIED] ${part.name}${reason ? ` — ${reason}` : ""}`
                  : status === "allowed"
                    ? `[AUTO-REVIEW: ALLOWED] ${part.name}`
                    : undefined
          if (label) decisions.push({ seq: row.seq, entry: { kind: "decision", label } })
          if (decisions.length > 60) break
        }
        if (decisions.length > 60) break
      }
      decisionBefore = rows.at(-1)?.seq
      if (rows.length < 64) break
    }
    let budget = Math.max(
      0,
      24000 -
        qa
          .slice(0, 100)
          .reduce(
            (sum, row) =>
              sum + (JSON.stringify(row.questions)?.length ?? 0) + (JSON.stringify(row.answers)?.length ?? 0),
            0,
          ),
    )
    const users: { seq: number; text: string }[] = []
    const seen = new Set<string>()
    let before: number | undefined
    let userOmitted = qa.length > 100
    walk: while (users.length < 400) {
      const rows = db
        .select()
        .from(SessionMessageTable)
        .where(
          and(
            eq(SessionMessageTable.session_id, sessionID),
            eq(SessionMessageTable.type, "user"),
            visible,
            before === undefined ? undefined : lt(SessionMessageTable.seq, before),
          ),
        )
        .orderBy(desc(SessionMessageTable.seq))
        .limit(32)
        .all()
      if (!rows.length) break
      for (const row of read(rows).flatMap((row) =>
        row.message.type === "user" ? [{ seq: row.seq, text: row.message.text }] : [],
      )) {
        if (!row.text?.trim()) continue
        const cost = seen.has(row.text) ? 50 : row.text.length
        seen.add(row.text)
        if (cost > budget || users.length >= 400) {
          userOmitted = true
          break walk
        }
        budget -= cost
        users.push(row)
      }
      if (users.length >= 400) {
        userOmitted = true
        break
      }
      before = rows.at(-1)?.seq
      if (rows.length < 32) break
    }
    // 原始首条授权与source一致豁免逐出，不能被大量后续消息替代。
    if (userOmitted) {
      const row = db
        .select()
        .from(SessionMessageTable)
        .where(and(eq(SessionMessageTable.session_id, sessionID), eq(SessionMessageTable.type, "user"), visible))
        .orderBy(SessionMessageTable.seq)
        .limit(1)
        .get()
      const restored = row ? read([row])[0] : undefined
      const first = restored?.message.type === "user" ? { seq: restored.seq, text: restored.message.text } : undefined
      if (first?.text?.trim() && !users.some((row) => row.seq === first.seq)) users.push(first)
    }
    const merged = [
      ...users.map((row) => ({
        seq: row.seq,
        entry: { kind: "user", text: row.text } satisfies PermissionReviewerPrompt.ReviewerSnapshotEntry,
      })),
      ...pairs,
      ...decisions.slice(0, 60).reverse(),
    ].sort((left, right) => left.seq - right.seq)
    const entries: PermissionReviewerPrompt.ReviewerSnapshotEntry[] = []
    const anchors = new Map<string, number>()
    for (const { entry } of merged) {
      if (entry.kind !== "user") {
        entries.push(entry)
        continue
      }
      const anchor = anchors.get(entry.text)
      if (anchor !== undefined) {
        entries.push({ kind: "userDup", ofIndex: anchor, chars: entry.text.length })
        continue
      }
      entries.push(entry)
      anchors.set(entry.text, entries.length)
    }
    // 仅真实裁决进入快照，基础设施失败和普通工具完成都不是用户批准。
    return { entries, userOmitted, decisionsOmitted: decisions.length > 60, emptyUserEvidence: entries.length === 0 }
  })
}

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [
    Config.node,
    Catalog.node,
    SessionStore.node,
    SessionRunnerModel.node,
    LayerNodePlatform.llmClient,
    LayerNodePlatform.filesystem,
    Location.node,
    Database.node,
    EventV2.node,
    SessionProjector.node,
  ],
})
