export * as PermissionReviewer from "./reviewer"

import path from "path"
import { LLM, LLMClient, LLMEvent, Tool } from "@opencode-ai/llm"
import { Cause, Context, DateTime, Effect, FileSystem, Layer, Option, Schema, Semaphore, Stream } from "effect"
import { and, eq } from "drizzle-orm"
import { Config } from "../config"
import { ConfigAutoReview } from "../config/auto-review"
import { Database } from "../database/database"
import { EventV2 } from "../event"
import { ProviderV2 } from "../provider"
import { SessionEvent } from "../session/event"
import { SessionProjector } from "../session/projector"
import { SessionTable } from "../session/sql"
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
export class Failed extends Schema.TaggedErrorClass<Failed>()("PermissionReviewerRunError", { reason: Schema.String }) {}
export class FallbackToUser extends Schema.TaggedErrorClass<FallbackToUser>()("PermissionReviewerFallbackToUser", { reason: Schema.String }) {}
export class Service extends Context.Service<Service, PermissionAuto.Reviewer>()("@opencode/core/PermissionReviewer") {}

const layer = Layer.effect(Service, Effect.gen(function* () {
  const config = yield* Config.Service
  const sessions = yield* SessionStore.Service
  const models = yield* SessionRunnerModel.Service
  const client = yield* LLMClient.Service
  const fs = yield* FileSystem.FileSystem
  const location = yield* Location.Service
  const db = (yield* Database.Service).db
  const events = yield* EventV2.Service
  const reviewerLocks = new Map<SessionSchema.ID, Semaphore.Semaphore>()
  const review = Effect.fn("PermissionReviewer.review")(function* (input: PermissionAuto.ReviewInput) {
    const entries = yield* config.entries()
    const sessionID = input.sessionID
    const selected = Config.latest(entries, "approvals_reviewer")
    // auto准入已由权限owner决定；执行代理名称只作证据，显式user仍保留人工审批。
    if (!sessionID || selected === "user") return yield* new Disabled()
    // 按字段合并各层配置，较近文档只覆盖它明确提供的策略项。
    const options = entries.flatMap((entry) => entry.type === "document" && entry.info.auto_review ? [entry.info.auto_review] : [])
      .reduce<NonNullable<ConstructorParameters<typeof ConfigAutoReview.Info>[0]>>((value, next) => ({ ...value, ...next }), {})
    const timedOut = new Failed({ reason: "auto reviewer timed out" })
    const run = Effect.gen(function* () {
      const session = yield* sessions.get(SessionSchema.ID.make(sessionID))
      if (!session) return yield* new Failed({ reason: "Review session was not found" })
      const target = options.model ? ModelV2.parse(options.model) : undefined
      // 独立审查复用真实 Catalog/认证解析，不运行 Session 或任何工具。
      // 未显式指定 reviewer 模型时保留父会话选择，避免漂移到其他默认提供者。
      const selected = yield* models.resolve({ ...session, model: target ? { id: target.modelID, providerID: target.providerID } : session.model }).pipe(
        // 仅source规定的失效隐式候选回退一次；显式配置及认证、取消等其它失败继续报错。
        Effect.catchTag("SessionRunnerModel.ModelUnavailableError", (error) => target
          ? Effect.fail(error)
          : models.resolve({ ...session, model: undefined })),
      )
      const history = yield* sessions.context(session.id)
      const policy = options.policy_path ? yield* fs.readFileString(path.resolve(location.directory, options.policy_path)) : ""
      const tenant = [PermissionReviewerPrompt.DEFAULT_TENANT_POLICY, policy, options.policy].filter(Boolean).join("\n\n")
      const request = new PermissionReviewerSchema.ReviewerRequest({
        permission: input.permission, patterns: [...input.patterns], metadata: { ...input.metadata }, precheck: input.precheck,
      })
      const rendered = history.slice(-120).map((message) => {
        const text = render(message)
        const role: PermissionReviewerPrompt.TranscriptEntry["role"] = message.type === "user" ? "user" : message.type === "shell" ? "tool" : "assistant"
        // 真实用户末尾可能包含授权；仅用户条目增大预算并保尾，不扩大工具证据。
        const limit = role === "user" ? 2000 : 1000
        return { role, text: truncate(text, limit, role === "user"), truncated: text.length > limit }
      })
      const visible = rendered.filter((entry) => entry.text.trim())
      const keep = new Set<number>()
      const first = visible.findIndex((entry) => entry.role === "user")
      const last = visible.findLastIndex((entry) => entry.role === "user")
      // 真实用户锚点优先，模型推理或合成上下文不能冒充用户授权。
      if (first >= 0) keep.add(first)
      if (last >= 0) keep.add(last)
      for (let index = visible.length - 1; index >= 0 && keep.size < 40; index--) keep.add(index)
      const retained = visible.filter((_, index) => keep.has(index))
      const items = PermissionReviewerPrompt.buildUserPromptItems({
        entries: retained.map(({ role, text }) => ({ role, text })),
        truncated: history.length > 120 || visible.length > retained.length,
        entryTruncated: retained.some((entry) => entry.truncated),
        emptyEntries: rendered.length > visible.length,
      }, request, input.precheck.reason)
      const system = PermissionReviewerPrompt.buildSystemPrompt(tenant)
      const prompt = items.map((item) => item.text).join("\n\n")
      const model = { id: ModelV2.ID.make(selected.model.id), providerID: ProviderV2.ID.make(selected.model.provider) }
      const reviewerSession = yield* getReviewerSession(session, model)
      yield* updateToolAutoReview(input, { status: "reviewing", sessionID: reviewerSession })
      const protocolError = new Failed({ reason: "reviewer did not call permission_review_decision" })
      const decodeAssessment = Schema.decodeUnknownOption(PermissionReviewerSchema.Assessment)
      const runReviewerAttempt = (attemptPrompt: string, hideProtocolFailure: boolean) => Effect.gen(function* () {
        const reviewerRequestID = SessionMessage.ID.create()
        // 每次尝试保留真实请求；相同reviewID不代替请求/助手的独立身份。
        yield* events.publish(SessionEvent.Synthetic, {
          sessionID: reviewerSession, messageID: reviewerRequestID, timestamp: yield* DateTime.now,
          text: `reviewID=${input.reviewID}\ntool=${JSON.stringify(input.tool ?? null)}\n\nsystem: ${system}\n\nuser: ${attemptPrompt}`,
        }, { metadata: { permissionReviewerRequest: true, reviewID: input.reviewID } })
        // 审查使用自己的确认样本；父对话和并行审查的未结算估计不能参与校准。
        const samples = Token.inputHistory(yield* sessions.context(reviewerSession), selected.model)
        let inputEstimate: SessionMessage.InputEstimate | undefined
        const publisher = createLLMEventPublisher(events, {
          sessionID: reviewerSession, agent: "permission-reviewer", model, inputEstimate: () => inputEstimate,
        }, {
          permissionReviewerRequestID: reviewerRequestID, reviewID: input.reviewID,
        })
        let assessment: typeof PermissionReviewerSchema.Assessment.Type | undefined
        let textOutput = ""
        return yield* client.stream(LLM.request({
          model: selected.model, prompt: attemptPrompt,
          // 逐次移动同一可信原话；证据与协议修复提示始终留在user通道。
          ...(selected.openaiOAuth ? { providerOptions: { openai: { instructions: system } } } : { system }),
          tools: Tool.toDefinitions({ permission_review_decision: Tool.make({
            description: "Submit the structured allow/deny decision for this permission review.",
            parameters: PermissionReviewerSchema.Assessment, success: Schema.Unknown,
          }) }),
        }), (body) => Effect.sync(() => {
          // 同一次compile的最终正文包含真正发出的工具；OAuth策略只归instructions，不重复归system正文。
          inputEstimate = {
            ...Token.estimateRequest(body, samples, selected.openaiOAuth ? [{ kind: "instructions", text: system }] : []),
            contextLimit: selected.model.defaults?.limits?.context ?? selected.model.route.defaults.limits?.context ?? 0,
          }
          // Started读取本尝试的估算；原有Ended仍独立确认真实用量与费用。
        })).pipe(
          Stream.runForEach((event) => Effect.gen(function* () {
            if (event.type === "tool-error") return yield* protocolError
            yield* publisher.publish(event)
            if (event.type === "provider-error") return yield* new Failed({ reason: event.message })
            if (event.type === "text-delta") textOutput += event.text
            if (event.type !== "tool-call" || event.name !== "permission_review_decision") return
            assessment = Option.getOrUndefined(decodeAssessment(event.input))
            if (!assessment) return yield* protocolError
            yield* publisher.publish(LLMEvent.toolResult({
              id: event.id, name: event.name, result: { type: "text", value: JSON.stringify(assessment) },
              output: { structured: { ...assessment, reviewID: input.reviewID, source: "tool_call" }, content: [{ type: "text", text: JSON.stringify(assessment) }] },
            }))
          })),
          Effect.flatMap(() => Effect.gen(function* () {
            if (assessment) return assessment
            // 文本兼容只在原裁决边界提取首个对象，继续经过同一Schema及策略校验。
            const fallback = Option.getOrUndefined(assessmentFromText(textOutput))
            if (!fallback) return yield* protocolError
            const callID = `json_fallback_${input.reviewID}`
            yield* publisher.publish(LLMEvent.toolCall({ id: callID, name: "permission_review_decision", input: fallback }))
            yield* publisher.publish(LLMEvent.toolResult({
              id: callID, name: "permission_review_decision", result: { type: "text", value: JSON.stringify(fallback) },
              output: { structured: { ...fallback, reviewID: input.reviewID, source: "json_fallback" }, content: [{ type: "text", text: JSON.stringify(fallback) }] },
            }))
            return fallback
          })),
          // 每次拥有完整执行期限；仍先完成原onExit收尾，再向外层交付超时供补试。
          Effect.timeoutOrElse({ duration: options.timeout_ms ?? 90_000, orElse: () => Effect.fail(timedOut) }),
          Effect.onExit((exit) => Effect.gen(function* () {
            const finalizer = exit._tag === "Failure"
            yield* publisher.flush(finalizer)
            // 成功裁决或文本回退也可能遗留其它call的输入，attempt退出必须一并闭合。
            if (exit._tag === "Success")
              yield* publisher.failUnsettledTools("Tool execution did not complete before stream ended", false, finalizer)
            if (exit._tag === "Failure") {
              const failure = Cause.squash(exit.cause)
              const reason = failure instanceof Error ? failure.message : "Review cancelled"
              yield* publisher.failUnsettledTools(reason, false, true)
              yield* publisher.failAssistant(reason, Cause.hasInterrupts(exit.cause), true)
            }
            const settlement = publisher.stepSettlement()
            if (exit._tag === "Success" || settlement) {
              const usage = settlement?.tokens ?? { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
              // 每次真实消耗独立结算；隐藏失败轮次不退款，也不算入父请求。
              yield* events.publish(SessionEvent.Step.Ended, {
                sessionID: reviewerSession, timestamp: yield* DateTime.now, assistantMessageID: yield* publisher.startAssistant(finalizer),
                finish: settlement?.finish ?? "tool-calls", cost: SessionRunnerModel.cost(selected.pricing, usage), tokens: usage,
              }, { finalizer })
            }
          })),
          Effect.tapError((error) => {
            if (error !== protocolError || !hideProtocolFailure) return Effect.void
            return Effect.gen(function* () {
              const timestamp = yield* DateTime.now
              const assistantID = publisher.peekAssistantMessageID()
              yield* events.publish(SessionEvent.MessagesHidden, {
                sessionID: reviewerSession, timestamp,
                messageIDs: assistantID ? [reviewerRequestID, assistantID] : [reviewerRequestID],
                hidden: { time: DateTime.toEpochMillis(timestamp), reason: "permission-reviewer-protocol-retry" },
              })
            })
          }),
        )
      })
      // 三次预算只覆盖本请求的超时/协议错误，provider失败和取消不补试。
      const attempt = (index: number, currentPrompt = prompt): Effect.Effect<PermissionReviewerSchema.Assessment, Effect.Error<ReturnType<typeof runReviewerAttempt>>> =>
        runReviewerAttempt(currentPrompt, index === 0).pipe(
          Effect.catchIf((error) => error === protocolError || error === timedOut, (error) => {
            if (index >= 2) return Effect.fail(error)
            // 协议仅追加同一条原话；超时保留当前提示，必须等上次收尾后才重试。
            return attempt(index + 1, error === protocolError ? `${prompt}\n\n${PermissionReviewerPrompt.PROTOCOL_RETRY_TEXT}` : currentPrompt)
          }),
        )
      const result = yield* attempt(0)
      yield* updateToolAutoReview(input, { status: result.outcome === "allow" ? "allowed" : "denied", result })
      return {
        action: result.outcome, reason: result.rationale, reviewID: input.reviewID,
        risk_level: result.risk_level, user_authorization: result.user_authorization,
      } satisfies PermissionAuto.ReviewDecision
    }).pipe(Effect.mapError((error) => error instanceof Failed ? error : new Failed({ reason: error instanceof Error ? error.message : String(error) })))
    // 用户审批回退是显式配置；其他失败由共享 auto 路由拒绝，绝不转换成成功。
    return yield* run.pipe(
      Effect.onExit((exit) => {
        if (exit._tag === "Success") return Effect.void
        const error = Cause.squash(exit.cause)
        // 期限身份来自本次timeout错误对象；取消不靠英文文案猜测，也不变成用户批准。
        return updateToolAutoReview(input, {
          status: Cause.hasInterrupts(exit.cause) ? "aborted" : options.fallback === "user" ? "fallback_user" : error === timedOut ? "timed_out" : "failed",
          error: error instanceof Error ? error.message : "Review cancelled",
        }, true)
      }),
      Effect.catch((error) => Effect.fail(options.fallback === "user" ? new FallbackToUser({ reason: error.reason }) : error)),
    )
  })
  return Service.of({ review })

  function getReviewerSession(parent: SessionSchema.Info, model: ModelV2.Ref) {
    const lock = reviewerLocks.get(parent.id) ?? Semaphore.makeUnsafe(1)
    reviewerLocks.set(parent.id, lock)
    return lock.withPermit(Effect.gen(function* () {
      const existing = yield* db.select({ id: SessionTable.id }).from(SessionTable).where(and(eq(SessionTable.parent_id, parent.id), eq(SessionTable.agent, "permission-reviewer"))).limit(1).get().pipe(Effect.orDie)
      if (existing) return SessionSchema.ID.make(existing.id)
      const row = yield* db.select().from(SessionTable).where(eq(SessionTable.id, parent.id)).get().pipe(Effect.orDie)
      if (!row) return yield* new Failed({ reason: "Review session was not found" })
      const id = SessionSchema.ID.create()
      const now = Date.now()
      // 只复用父会话placement；通过同一Created投影建审查子会话，不继承分享或执行状态。
      yield* events.publish(SessionV1.Event.Created, { sessionID: id, info: SessionV1.SessionInfo.make({
        id, slug: Slug.create(), version: row.version,
        projectID: row.project_id, directory: row.directory, path: row.path ?? undefined, workspaceID: row.workspace_id ?? undefined,
        parentID: parent.id, title: "Auto permission review (@permission-reviewer subagent)", agent: "permission-reviewer",
        model, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: now, updated: now },
      }) }, { location: parent.location })
      return id
    }))
  }

  function updateToolAutoReview(input: PermissionAuto.ReviewInput, patch: Record<string, unknown>, finalizer = false) {
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
      if (patch.status === "aborted" && typeof current === "object" && current !== null && "status" in current && current.status && current.status !== "reviewing") return
      yield* events.publish(SessionEvent.Tool.Progress, {
        sessionID: recorded.sessionID, assistantMessageID: recorded.message.id, callID: binding.callID, timestamp: yield* DateTime.now,
        structured: { ...part.state.structured, autoReview: {
          ...(typeof current === "object" && current !== null && !Array.isArray(current) ? current : {}),
          reviewID: input.reviewID, precheck: input.precheck, ...patch,
        } },
        content: part.state.content,
      }, { finalizer })
    }).pipe(
      // 父工具展示是附属状态，写入失败不得覆盖已获得的裁决；中断继续传播。
      Effect.catch(() => Effect.void),
      Effect.catchDefect(() => Effect.void),
    )
  }
}))

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
  if (message.type === "assistant") return message.content.map((part) => {
    if (part.type === "reasoning") return ""
    if (part.type !== "tool") return truncate(part.text)
    const state = part.state
    const body = state.status === "pending" ? state.input : state.status === "error" ? state.error.message
      : state.content.map((item) => item.type === "text" ? item.text : `[Attached ${item.mime}]`).join("\n")
    return `<tool name="${part.name}" status="${state.status}">\n${truncate(JSON.stringify(state.input))}\n${truncate(body)}\n</tool>`
  }).join("\n")
  if (message.type === "user") return truncate([message.text, ...(message.files ?? []).map((file) => `[Attached ${file.mime}: ${file.name ?? ""}]`)].join("\n"))
  if (message.type === "compaction") return truncate(`${message.summary}\n${message.recent}`)
  if (message.type === "shell") return truncate(`${message.command}\n${message.output}`)
  return `<${message.type} />`
}

// 单段和整条截短都留下显式证据标记，而不是静默丢弃剩余内容。
function truncate(text: string, limit = 4000, preserveTail = false) {
  if (text.length <= limit) return text
  if (preserveTail) {
    // 与V1同样保留头部60%和尾部40%，省略标记仍反映真实缺失量。
    const head = Math.floor(limit * 0.6)
    const tail = limit - head
    return text.slice(0, head) + `\n<truncated chars="${text.length - limit}" />\n` + text.slice(text.length - tail)
  }
  return text.slice(0, limit) + `\n<truncated chars="${text.length - limit}" />`
}

export const node = makeLocationNode({ service: Service, layer,
  deps: [Config.node, SessionStore.node, SessionRunnerModel.node, LayerNodePlatform.llmClient, LayerNodePlatform.filesystem, Location.node, Database.node, EventV2.node, SessionProjector.node],
})
