import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Config } from "@/config/config"
import { Provider } from "@/provider/provider"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { generateObject, type ModelMessage } from "ai"
import { Context, Effect, Layer, Schema } from "effect"
import { PermissionReviewerPrompt } from "./prompt"
import { Assessment, ReviewerRequest } from "./schema"
import { PermissionReviewerTranscript } from "./transcript"
import type { PermissionAuto } from "../auto"

// #198：reviewer 不可用——服务已禁用，回退到用户审批
// #198：Disabled 是配置信号——approvals_reviewer 非 auto_review 时抛出，auto.ts 将其转为 ask
export class ReviewerDisabled extends Schema.TaggedErrorClass<ReviewerDisabled>()("PermissionReviewerDisabled", {}) {
  override get message() {
    return "auto reviewer is disabled"
  }
}

// #198：reviewer 回退到用户——fallback=user 时非 Disabled 错误转为此类型，由 auto.ts 回退到用户审批
// #198：FallbackToUser 保留原始错误原因——审计日志可追溯回退原因（超时、provider 错误等）
export class ReviewerFallbackToUser extends Schema.TaggedErrorClass<ReviewerFallbackToUser>()(
  "PermissionReviewerFallbackToUser",
  { reason: Schema.String },
) {
  override get message() {
    return this.reason
  }
}

// #198：reviewer 超时——超过配置的 timeout_ms 后中断，fail closed
// #198：超时是可预期故障——provider 响应慢不应导致无限等待，超时后 deny 保持 fail-closed
export class ReviewerTimedOut extends Schema.TaggedErrorClass<ReviewerTimedOut>()("PermissionReviewerTimedOut", {}) {
  override get message() {
    return "auto reviewer timed out"
  }
}

// #198：reviewer 运行错误——provider 错误、schema 错误等非超时非禁用错误，fail closed
// #198：RunError 包装不可预期错误——provider API 故障、schema 验证失败等，统一为 fail-closed 信号
export class ReviewerRunError extends Schema.TaggedErrorClass<ReviewerRunError>()("PermissionReviewerRunError", {
  reason: Schema.String,
}) {
  override get message() {
    return this.reason
  }
}

export type Error = ReviewerDisabled | ReviewerFallbackToUser | ReviewerTimedOut | ReviewerRunError

export interface Interface extends PermissionAuto.Reviewer {}

export class Service extends Context.Service<Service, Interface>()("@opencode/PermissionReviewer") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const provider = yield* Provider.Service
    const session = yield* Session.Service

    const review: Interface["review"] = (input) => Effect.gen(function* () {
      const cfg = yield* config.get()
      const permission = cfg.permission
      // #198：approvals_reviewer 非 auto_review 时 reviewer 已禁用——回退到用户审批
      // #198：禁用检查在构建请求前——避免不必要地加载策略和 transcript
      if (permission?.approvals_reviewer !== "auto_review") return yield* new ReviewerDisabled()

      const run = Effect.gen(function* () {
        const request = new ReviewerRequest({
          permission: input.permission,
          patterns: [...input.patterns],
          metadata: { ...input.metadata },
          precheck: input.precheck,
        })
        const tenantPolicy = yield* loadTenantPolicy(permission.auto_review)
        // #198：transcript 从 session 消息提取——有 sessionID 时取最近 40 条，失败时返回空 transcript 而非中断
        // #198：transcript 失败不阻断审查——空 transcript 仍允许 reviewer 基于 planned action 和策略做决策
        const transcript = input.sessionID
          ? yield* session
              .messages({ sessionID: SessionID.make(input.sessionID), limit: 40 })
              .pipe(
                Effect.map(PermissionReviewerTranscript.fromMessages),
                Effect.catch(() => Effect.succeed({ entries: [], truncated: false })),
              )
          : { entries: [], truncated: false }
        const messages = buildMessages({
          system: PermissionReviewerPrompt.buildSystemPrompt(tenantPolicy),
          userItems: PermissionReviewerPrompt.buildUserPromptItems(transcript, request, input.precheck.reason),
        })
        // #198：模型解析——配置了 auto_review.model 时用指定模型，否则用 default + small model 组合
        // #198：优先使用 small model——reviewer 不需高创造力，小模型更快更省成本且足以做安全判定
        const model = permission.auto_review?.model
          ? yield* provider.getModel(
              Provider.parseModel(permission.auto_review.model).providerID,
              Provider.parseModel(permission.auto_review.model).modelID,
            )
          : yield* Effect.gen(function* () {
              const current = yield* provider.defaultModel()
              return (yield* provider.getSmallModel(current.providerID)) ?? (yield* provider.getModel(current.providerID, current.modelID))
            })
        const language = yield* provider.getLanguage(model)
        // #198：generateObject 结构化输出——schema 同时提供 StandardSchemaV1 和 StandardJSONSchemaV1 确保 provider 兼容
        // #198：双重 schema 提供者——StandardSchemaV1 用于运行时验证，StandardJSONSchemaV1 用于 provider API 请求格式
        const assessment = yield* Effect.promise(() =>
          generateObject({
            model: language,
            messages,
            schema: Object.assign(Schema.toStandardSchemaV1(Assessment), Schema.toStandardJSONSchemaV1(Assessment)),
          }).then((result) => result.object),
        ).pipe(
          // #198：超时控制——默认 90 秒，超时后返回 ReviewerTimedOut 而非等待不确定的 provider 响应
          // #198：90 秒上限覆盖大多数 provider 响应——超过此时间通常表示 provider 故障而非正常审查
          Effect.timeoutOrElse({
            duration: `${permission.auto_review?.timeout_ms ?? 90_000} millis`,
            orElse: () => Effect.fail(new ReviewerTimedOut()),
          }),
          // #198：mapError 将非 reviewer 错误包装为 RunError——provider/schema 错误统一为可处理的 fail-closed 信号
          Effect.mapError((error) => (isReviewerError(error) ? error : new ReviewerRunError({ reason: errorMessage(error) }))),
        )

        return {
          action: assessment.outcome,
          reason: assessment.rationale,
          reviewID: crypto.randomUUID(),
          risk_level: assessment.risk_level,
          user_authorization: assessment.user_authorization,
        } satisfies PermissionAuto.ReviewDecision
      })

      // #198：fallback=user 时，非 Disabled 错误转为 FallbackToUser 回退到用户审批；Disabled 不转换因为它是显式禁用信号
      // #198：Disabled 保持原样——服务禁用是配置决策，不应被 fallback 策略覆盖为其他错误类型
      return yield* run.pipe(
        Effect.catch((error: unknown) =>
          permission.auto_review?.fallback === "user" && !(error instanceof ReviewerDisabled)
            ? Effect.fail(new ReviewerFallbackToUser({ reason: errorMessage(error) }))
            : Effect.fail(error),
        ),
      )
    })

    return Service.of({ review })
  }),
)

function buildMessages(input: { system: string; userItems: readonly PermissionReviewerPrompt.UserPromptItem[] }) {
  // #198：system 消息包含策略模板和输出合约——user 消息包含 transcript 和 approval request
  return [
    { role: "system", content: input.system },
    // #198：user 消息拼接所有 userItems——用双换行分隔 transcript、retry reason、planned action
    { role: "user", content: input.userItems.map((item) => item.text).join("\n\n") },
  ] satisfies ModelMessage[]
}

// #198：判断是否为 reviewer 自身错误——TimedOut 和 RunError 是可预期的运行时错误，其他错误向上传播
// #198：区分错误类型——reviewer 自身错误已有 _tag 标识，provider 错误需包装为 RunError
function isReviewerError(error: unknown): error is Error {
  return error instanceof ReviewerTimedOut || error instanceof ReviewerRunError
}

// #198：提取错误消息——provider/model 错误在 reason 中暴露用于诊断，但 AutoDeniedError 仍阻止鼓励绕过策略的重试建议
function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") return error.message
  return String(error)
}

// #198：加载租户策略——默认策略 + policy_path 文件 + policy 内联文本，三者拼接，空值过滤
// #198：策略来源优先级——DEFAULT_TENANT_POLICY 是基线，policy_path 和 policy 是追加覆盖
function loadTenantPolicy(autoReview: { policy?: string; policy_path?: string } | undefined) {
  return Effect.gen(function* () {
    // #198：policy_path 文件读取失败转为 RunError——策略加载失败不应静默回退到默认策略
    const pathPolicy = autoReview?.policy_path
      ? yield* Effect.promise(() => Bun.file(autoReview.policy_path!).text()).pipe(
          Effect.mapError((error) =>
            new ReviewerRunError({ reason: `failed to load auto_review.policy_path: ${String(error)}` }),
          ),
        )
      : ""
    // #198：三者拼接——默认策略 + 文件策略 + 内联策略，空值过滤后用双换行分隔
    return [PermissionReviewerPrompt.DEFAULT_TENANT_POLICY, pathPolicy, autoReview?.policy]
      .filter((item): item is string => Boolean(item?.trim()))
      .join("\n\n")
  })
}

export const defaultLayer = layer.pipe(
  Layer.provide(LayerNode.compile(Config.node)),
  Layer.provide(LayerNode.compile(Provider.node)),
)

// #198：node deps 包含 Config/Provider/Session——reviewer layer yield 三个 service，Session 不导入 Permission 故无循环依赖
export const node = LayerNode.make({ service: Service, layer: layer, deps: [Config.node, Provider.node, Session.node] })

export * as PermissionReviewer from "./service"
