export * as PermissionReviewer from "./reviewer"

import path from "path"
import { LLM, LLMClient } from "@opencode-ai/llm"
import { Context, Effect, FileSystem, Layer, Schema } from "effect"
import { Config } from "../config"
import { ConfigAutoReview } from "../config/auto-review"
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
  const review = Effect.fn("PermissionReviewer.review")(function* (input: PermissionAuto.ReviewInput) {
    const entries = yield* config.entries()
    const sessionID = input.sessionID
    const selected = Config.latest(entries, "approvals_reviewer")
    // 显式user优先；未配置全局reviewer时，Auto仍使用相同的隔离审查路径。
    if (!sessionID || selected === "user" || (selected !== "auto_review" && input.metadata.agent !== "Auto")) return yield* new Disabled()
    // 按字段合并各层配置，较近文档只覆盖它明确提供的策略项。
    const options = entries.flatMap((entry) => entry.type === "document" && entry.info.auto_review ? [entry.info.auto_review] : [])
      .reduce<NonNullable<ConstructorParameters<typeof ConfigAutoReview.Info>[0]>>((value, next) => ({ ...value, ...next }), {})
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
      // generateObject 只生成一次结构化裁决；合成输出工具不具备业务执行权限。
      const result = yield* LLM.generateObject({
        model: selected.model, schema: PermissionReviewerSchema.Assessment,
        system: PermissionReviewerPrompt.buildSystemPrompt(tenant), prompt: items.map((item) => item.text).join("\n\n"),
      }).pipe(
        Effect.provideService(LLMClient.Service, client),
        Effect.timeoutOrElse({ duration: options.timeout_ms ?? 90_000, orElse: () => Effect.fail(new Failed({ reason: "auto reviewer timed out" })) }),
      )
      return {
        action: result.object.outcome, reason: result.object.rationale, reviewID: crypto.randomUUID(),
        risk_level: result.object.risk_level, user_authorization: result.object.user_authorization,
      } satisfies PermissionAuto.ReviewDecision
    }).pipe(Effect.mapError((error) => new Failed({ reason: error instanceof Error ? error.message : String(error) })))
    // 用户审批回退是显式配置；其他失败由共享 auto 路由拒绝，绝不转换成成功。
    return yield* run.pipe(Effect.catch((error) => Effect.fail(options.fallback === "user"
      ? new FallbackToUser({ reason: error.reason }) : error)))
  })
  return Service.of({ review })
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
  deps: [Config.node, SessionStore.node, SessionRunnerModel.node, LayerNodePlatform.llmClient, LayerNodePlatform.filesystem, Location.node],
})
