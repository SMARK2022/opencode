export * as PermissionReviewer from "./reviewer"

import path from "path"
import { LLM, LLMClient, LLMEvent, Tool } from "@opencode-ai/llm"
import { Cause, Context, DateTime, Effect, FileSystem, Layer, Schema, Semaphore, Stream } from "effect"
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
    // 显式user优先；未配置全局reviewer时，Auto仍使用相同的隔离审查路径。
    if (!sessionID || selected === "user" || (selected !== "auto_review" && input.metadata.agent !== "Auto")) return yield* new Disabled()
    // 按字段合并各层配置，较近文档只覆盖它明确提供的策略项。
    const options = entries.flatMap((entry) => entry.type === "document" && entry.info.auto_review ? [entry.info.auto_review] : [])
      .reduce<NonNullable<ConstructorParameters<typeof ConfigAutoReview.Info>[0]>>((value, next) => ({ ...value, ...next }), {})
    const timedOut = new Failed({ reason: "auto reviewer timed out" })
    const run = Effect.gen(function* () {
      const session = yield* sessions.get(SessionSchema.ID.make(sessionID))
      if (!session) return yield* new Failed({ reason: "Review session was not found" })
      const target = options.model ? ModelV2.parse(options.model) : undefined
      // 独立审查复用真实 Catalog/认证解析，不运行 Session 或任何工具。
      const selected = yield* models.resolve({ ...session, model: target ? { id: target.modelID, providerID: target.providerID } : undefined })
      const history = yield* sessions.context(session.id)
      const policy = options.policy_path ? yield* fs.readFileString(path.resolve(location.directory, options.policy_path)) : ""
      const tenant = [PermissionReviewerPrompt.DEFAULT_TENANT_POLICY, policy, options.policy].filter(Boolean).join("\n\n")
      const request = new PermissionReviewerSchema.ReviewerRequest({
        permission: input.permission, patterns: [...input.patterns], metadata: { ...input.metadata }, precheck: input.precheck,
      })
      const rendered = history.slice(-120).map((message) => {
        const text = render(message)
        const role: PermissionReviewerPrompt.TranscriptEntry["role"] = message.type === "user" ? "user" : message.type === "shell" ? "tool" : "assistant"
        return { role, text: truncate(text, 1000), truncated: text.length > 1000 }
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
      const reviewerRequestID = SessionMessage.ID.create()
      // 协议文本可持久检查，但使用synthetic事件，不能在后续审查中充当人类授权。
      yield* events.publish(SessionEvent.Synthetic, {
        sessionID: reviewerSession, messageID: reviewerRequestID, timestamp: yield* DateTime.now,
        text: `reviewID=${input.reviewID}\ntool=${JSON.stringify(input.tool ?? null)}\n\nsystem: ${system}\n\nuser: ${prompt}`,
      }, { metadata: { permissionReviewerRequest: true, reviewID: input.reviewID } })
      yield* updateToolAutoReview(input, { status: "reviewing", sessionID: reviewerSession })
      const publisher = createLLMEventPublisher(events, { sessionID: reviewerSession, agent: "permission-reviewer", model }, {
        permissionReviewerRequestID: reviewerRequestID, reviewID: input.reviewID,
      })
      let assessment: typeof PermissionReviewerSchema.Assessment.Type | undefined
      // 只声明裁决协议：一次真实provider流，不接业务工具registry或会话执行循环。
      const result = yield* client.stream(LLM.request({
        model: selected.model, system, prompt,
        tools: Tool.toDefinitions({ permission_review_decision: Tool.make({
          description: "Submit the structured allow/deny decision for this permission review.",
          parameters: PermissionReviewerSchema.Assessment, success: Schema.Unknown,
        }) }),
      })).pipe(
        Stream.runForEach((event) => Effect.gen(function* () {
          yield* publisher.publish(event)
          if (event.type === "provider-error" || event.type === "tool-error") return yield* new Failed({ reason: event.message })
          if (event.type !== "tool-call" || event.name !== "permission_review_decision") return
          // 真实reasoning/text在裁决前已经落盘；同一Schema验证最终输入，绝不执行该工具。
          assessment = yield* Schema.decodeUnknownEffect(PermissionReviewerSchema.Assessment)(event.input).pipe(Effect.mapError((error) => new Failed({ reason: error.message })))
          yield* publisher.publish(LLMEvent.toolResult({
            id: event.id, name: event.name, result: { type: "text", value: JSON.stringify(assessment) },
            output: { structured: { ...assessment, reviewID: input.reviewID }, content: [{ type: "text", text: JSON.stringify(assessment) }] },
          }))
        })),
        Effect.flatMap(() => assessment ? Effect.succeed(assessment) : Effect.fail(new Failed({ reason: "reviewer did not call permission_review_decision" }))),
        Effect.timeoutOrElse({ duration: options.timeout_ms ?? 90_000, orElse: () => Effect.fail(timedOut) }),
        Effect.onExit((exit) => Effect.gen(function* () {
          const finalizer = exit._tag === "Failure"
          yield* publisher.flush(finalizer)
          if (exit._tag === "Failure") {
            const failure = Cause.squash(exit.cause)
            const reason = failure instanceof Error ? failure.message : "Review cancelled"
            // 失败/取消闭合真实残片和工具，沿退出安全通知模式，不伪造成功助手。
            yield* publisher.failUnsettledTools(reason, false, true)
            yield* publisher.failAssistant(reason, Cause.hasInterrupts(exit.cause), true)
          }
          const settlement = publisher.stepSettlement()
          if (exit._tag === "Success" || settlement) {
            const usage = settlement?.tokens ?? { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
            // 已确认消耗留在审查子会话；失败不能退款，也不能算进父请求的账本。
            yield* events.publish(SessionEvent.Step.Ended, {
              sessionID: reviewerSession, timestamp: yield* DateTime.now, assistantMessageID: yield* publisher.startAssistant(finalizer),
              finish: settlement?.finish ?? "tool-calls", cost: SessionRunnerModel.cost(selected.pricing, usage), tokens: usage,
            }, { finalizer })
          }
        })),
      )
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
          status: options.fallback === "user" && !Cause.hasInterrupts(exit.cause) ? "fallback_user" : error === timedOut ? "timed_out" : "failed",
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
      yield* events.publish(SessionEvent.Tool.Progress, {
        sessionID: recorded.sessionID, assistantMessageID: recorded.message.id, callID: binding.callID, timestamp: yield* DateTime.now,
        structured: { ...part.state.structured, autoReview: {
          ...(typeof current === "object" && current !== null && !Array.isArray(current) ? current : {}),
          reviewID: input.reviewID, precheck: input.precheck, ...patch,
        } },
        content: part.state.content,
      }, { finalizer })
    })
  }
}))

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
function truncate(text: string, limit = 4000) {
  return text.length <= limit ? text : text.slice(0, limit) + `\n<truncated chars="${text.length - limit}" />`
}

export const node = makeLocationNode({ service: Service, layer,
  deps: [Config.node, SessionStore.node, SessionRunnerModel.node, LayerNodePlatform.llmClient, LayerNodePlatform.filesystem, Location.node, Database.node, EventV2.node, SessionProjector.node],
})
