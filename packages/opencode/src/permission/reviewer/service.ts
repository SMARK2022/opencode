import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ConfigPermissionV1 } from "@opencode-ai/core/v1/config/permission"
import { Config } from "@/config/config"
import { Provider } from "@/provider/provider"
import { Session } from "@/session/session"
import { MessageV2 } from "@/session/message-v2"
import { Database } from "@opencode-ai/core/database/database"

import { MessageID, PartID, SessionID } from "@/session/schema"
import type { ToolPart, User, Assistant, TextPart } from "@opencode-ai/core/v1/session"
import { generateObject, type ModelMessage } from "ai"
import { Context, Effect, Layer, Schema, Semaphore } from "effect"
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

// #206：拉取比最终 reviewer prompt 更宽的最近窗口——transcript 选择再保留用户锚点并限制条目/字符，避免在权限路径遍历过旧会话
const REVIEWER_MESSAGE_FETCH_LIMIT = 120

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const provider = yield* Provider.Service
    // #206：layer 内捕获 Database 服务——review 经 provideService 消化 page 的 DB 需求且不泄漏类型
    const database = yield* Database.Service
    // #208：Session.Service 已在 patch 206 保留——复用为 session 变量避免 Database.Service 泄漏
    const session = yield* Session.Service
    // #208：每父会话一个 Semaphore——并发工具审查复用同一 reviewer transcript
    const reviewerSessionLocks = new Map<SessionID, Semaphore.Semaphore>()

    const review: Interface["review"] = (input) => Effect.gen(function* () {
      const cfg = yield* config.get()
      const permission = cfg.permission
      // #203：reviewerEnabled 统一判定——显式 user 禁用，显式 auto_review 启用，无配置时原生 Auto 隐式启用
      if (!reviewerEnabled(permission, input.metadata)) return yield* new ReviewerDisabled()
      const autoReview = permission?.auto_review

      const run = Effect.gen(function* () {
        const request = new ReviewerRequest({
          permission: input.permission,
          patterns: [...input.patterns],
          metadata: { ...input.metadata },
          precheck: input.precheck,
        })
        const tenantPolicy = yield* loadTenantPolicy(autoReview)
        // #206：transcript 收集双重有界——先拉 120 条宽窗口再由 transcript 选择保留用户锚点和截短条目
        // #206：page.more 表示获取窗口外还有更早消息（含 hidden 行的原始窗口探测）——hidden 挤占
        // #206：窗口时可见条目可能 ≤ENTRY_LIMIT，必须与 selectEntries 截短合并披露，否则 reviewer
        // #206：会把部分历史当作完整对话评估 user_authorization（修复 page.more 语义丢失）
        const transcript = input.sessionID
          ? yield* MessageV2.page({ sessionID: SessionID.make(input.sessionID), limit: REVIEWER_MESSAGE_FETCH_LIMIT }).pipe(
              // #206：provideService 在调用点消化 Database 需求——review 类型不泄漏 Database.Service
              Effect.provideService(Database.Service, database),
              Effect.map((page) => {
                const transcript = PermissionReviewerTranscript.fromMessages(page.items)
                // #206：窗口溢出与条目截短任一存在都置 truncated——省略标记是 reviewer 的缺失证据
                return { ...transcript, truncated: transcript.truncated || page.more }
              }),
              // #206：失败时返回空 transcript 含 entryTruncated:false——保持 TranscriptDelta 新字段类型完整
              Effect.catch(() => Effect.succeed({ entries: [], truncated: false, entryTruncated: false })),
              )
          : { entries: [], truncated: false, entryTruncated: false }
        const messages = buildMessages({
          system: PermissionReviewerPrompt.buildSystemPrompt(tenantPolicy),
          userItems: PermissionReviewerPrompt.buildUserPromptItems(transcript, request, input.precheck.reason),
        })
        // #198：模型解析——配置了 auto_review.model 时用指定模型，否则用 default + small model 组合
        // #198：优先使用 small model——reviewer 不需高创造力，小模型更快更省成本且足以做安全判定
        const model = autoReview?.model
          ? yield* provider.getModel(
              Provider.parseModel(autoReview.model).providerID,
              Provider.parseModel(autoReview.model).modelID,
            )
          : yield* Effect.gen(function* () {
              const current = yield* provider.defaultModel()
              return (yield* provider.getSmallModel(current.providerID)) ?? (yield* provider.getModel(current.providerID, current.modelID))
            })
        const language = yield* provider.getLanguage(model)
        // #208：获取或创建 reviewer 子会话——复用同一 transcript 追加请求/决策轮次
        const reviewerSession = input.sessionID ? yield* getReviewerSession(SessionID.make(input.sessionID), model) : undefined
        // #208：标记工具状态为 reviewing——UI 展示确定性 precheck 到模型审查的进度
        // #208：markToolReviewing best-effort 标记——过期工具引用不影响有效决策
        yield* markToolReviewing(input)
        // #208：在子会话中记录 reviewer 请求——synthetic 文本不作为用户授权证据
        const reviewerUser = reviewerSession
          ? yield* recordReviewerRequest({
              session: reviewerSession,
              model,
              text: messages.map((message) => `${message.role}: ${message.content}`).join("\n\n"),
            })
          : undefined
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
            duration: `${autoReview?.timeout_ms ?? 90_000} millis`,
            orElse: () => Effect.fail(new ReviewerTimedOut()),
          }),
          // #198：mapError 将非 reviewer 错误包装为 RunError——provider/schema 错误统一为可处理的 fail-closed 信号
          Effect.mapError((error) => (isReviewerError(error) ? error : new ReviewerRunError({ reason: errorMessage(error) }))),
        )

        // #208：在子会话中记录 reviewer 决策——供未来 transcript delta 审计追溯
        if (reviewerSession && reviewerUser) {
          yield* recordReviewerDecision({ session: reviewerSession, model, parentID: reviewerUser.id, assessment })
        }

        return {
          action: assessment.outcome,
          reason: assessment.rationale,
          // #208：reviewID 由 auto.ts mint 后传入——不再在此处随机生成
          reviewID: input.reviewID,
          risk_level: assessment.risk_level,
          user_authorization: assessment.user_authorization,
        } satisfies PermissionAuto.ReviewDecision
      })

      // #198：fallback=user 时，非 Disabled 错误转为 FallbackToUser 回退到用户审批；Disabled 不转换因为它是显式禁用信号
      // #198：Disabled 保持原样——服务禁用是配置决策，不应被 fallback 策略覆盖为其他错误类型
      return yield* run.pipe(
        Effect.catch((error: unknown) =>
          autoReview?.fallback === "user" && !(error instanceof ReviewerDisabled)
            ? Effect.fail(new ReviewerFallbackToUser({ reason: errorMessage(error) }))
            : Effect.fail(error),
        ),
      )
    })

    return Service.of({ review })

    // #208：获取或创建 reviewer 子会话——每父会话一个可复用的 permission-reviewer 子会话
    function getReviewerSession(parentID: SessionID, model: Provider.Model) {
      return reviewerSessionLock(parentID).withPermits(1)(Effect.gen(function* () {
        // #208：优先复用已有 permission-reviewer 子会话——每次审查创建新 transcript 会丢失前序请求/决策上下文
        const existing = (yield* session.children(parentID)).find((item) => item.agent === "permission-reviewer")
        if (existing) return existing
        // #208：单个子会话镜像 Codex guardian trunk——后续审查追加新请求/决策轮次
        return yield* session.create({
          parentID,
          title: "Auto permission review (@permission-reviewer subagent)",
          agent: "permission-reviewer",
          model: { providerID: model.providerID, id: model.id },
        })
      }))
    }

    function reviewerSessionLock(parentID: SessionID) {
      const existing = reviewerSessionLocks.get(parentID)
      if (existing) return existing
      // #208：get-or-create 非原子——每父会话锁保持并发工具审查复用同一 reviewer transcript
      const next = Semaphore.makeUnsafe(1)
      reviewerSessionLocks.set(parentID, next)
      return next
    }

    // #208：记录 reviewer 请求为 synthetic 用户消息——可检查但不作为人类授权证据
    function recordReviewerRequest(input: { session: Session.Info; model: Provider.Model; text: string }) {
      return Effect.gen(function* () {
        const message = yield* session.updateMessage({
          id: MessageID.ascending(),
          role: "user",
          sessionID: input.session.id,
          time: { created: Date.now() },
          agent: "permission-reviewer",
          model: { providerID: input.model.providerID, modelID: input.model.id },
        } satisfies User)
        yield* session.updatePart({
          id: PartID.ascending(),
          sessionID: input.session.id,
          messageID: message.id,
          type: "text",
          // #208：synthetic=true 防止此文本在子会话 transcript 投影时被误认为人类授权
          synthetic: true,
          text: input.text,
        } satisfies TextPart)
        return message
      })
    }

    // #208：记录 reviewer 决策为助手消息+tool part——供未来 transcript delta 审计追溯
    function recordReviewerDecision(input: {
      session: Session.Info
      model: Provider.Model
      parentID: MessageID
      assessment: Schema.Schema.Type<typeof Assessment>
    }) {
      return Effect.gen(function* () {
        const message = yield* session.updateMessage({
          id: MessageID.ascending(),
          parentID: input.parentID,
          role: "assistant",
          mode: "permission-reviewer",
          agent: "permission-reviewer",
          path: { cwd: input.session.directory, root: input.session.directory },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: input.model.id,
          providerID: input.model.providerID,
          sessionID: input.session.id,
          time: { created: Date.now(), completed: Date.now() },
          finish: "tool-calls",
        } satisfies Assistant)
        yield* session.updatePart({
          id: PartID.ascending(),
          sessionID: input.session.id,
          messageID: message.id,
          type: "tool",
          // #208：callID 由 parentID 确定性生成——同一请求的决策轮次可追溯，避免随机 ID 在 transcript 重放时漂移
          callID: `permission-review-${input.parentID}`,
          tool: "permission_review_decision",
          state: {
            status: "completed",
            input: input.assessment,
            output: JSON.stringify(input.assessment),
            title: input.assessment.outcome === "allow" ? "Permission review allowed" : "Permission review denied",
            metadata: input.assessment,
            time: { start: message.time.created, end: message.time.completed ?? Date.now() },
          },
        } satisfies ToolPart)
      })
    }

    // #208：标记工具状态为 reviewing——UI 展示 precheck 到 reviewer 的进度
    function markToolReviewing(input: PermissionAuto.ReviewInput) {
      // #208：无 sessionID 或 tool 绑定时跳过标记——非工具触发的审查无需 UI 进度展示
      const sessionID = input.sessionID
      const tool = input.tool
      if (!sessionID || !tool) return Effect.void
      return Effect.gen(function* () {
        // #208：用 session.messages 替代 MessageV2.get——避免 Database.Service 泄漏到 review 类型
        const messages = yield* session.messages({ sessionID: SessionID.make(sessionID), limit: 50 })
        const message = messages.find((m) => m.info.id === tool.messageID)
        if (!message) return
        const part = message.parts.find(
          (item): item is ToolPart => item.type === "tool" && item.callID === tool.callID,
        )
        if (!part || (part.state.status !== "pending" && part.state.status !== "running")) return
        yield* session.updatePart({
          ...part,
          state: {
            status: "running",
            input: part.state.status === "pending" ? { raw: part.state.raw } : part.state.input,
            title: `Auto review: ${input.precheck.level}`,
            metadata: {
              ...(part.state.status === "running" ? part.state.metadata : {}),
              // #208：metadata 小而稳定——客户端可展示 precheck 交接而不渲染隐藏 reviewer prompt
              autoReview: {
                reviewID: input.reviewID,
                precheck: input.precheck,
              },
            },
            time: { start: part.state.status === "running" ? part.state.time.start : Date.now() },
          },
        } satisfies ToolPart)
      }).pipe(
        // #208：review 展示是 best-effort——过期工具引用不应将有效 reviewer 决策转为 fail-closed deny
        Effect.catch(() => Effect.void),
      )
    }
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

// #203：reviewer 启用判定——显式配置优先：user 保留人工审批，auto_review 对所有 auto 规则启用。
// #203：无全局配置时原生 Auto agent 隐式启用 reviewer；否则选 Auto 只会把 cautious 降级成普通 ask
function reviewerEnabled(permission: ConfigPermissionV1.Info | undefined, metadata: Readonly<Record<string, unknown>>) {
  if (permission?.approvals_reviewer === "user") return false
  if (permission?.approvals_reviewer === "auto_review") return true
  return metadata.agent === "Auto"
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

// #203：Permission.defaultLayer 消费此 bundled reviewer 层来构建 Permission.Service。
// #203：Layer.suspend 保留历史循环边界：Session 导入 Permission 类型，故 Session.defaultLayer
// #203：不能在本模块初始化期间被解引用
export const defaultLayerWithSession = Layer.suspend(() => defaultLayer.pipe(Layer.provide(LayerNode.compile(Session.node))))

// #198：node deps 包含 Config/Provider/Session——reviewer layer yield 三个 service，Session 不导入 Permission 故无循环依赖
// #206：deps 补 Database.node——layer 捕获 db 供 page 溢出探测，仍不泄漏进 review 类型
export const node = LayerNode.make({ service: Service, layer: layer, deps: [Config.node, Provider.node, Session.node, Database.node] })

export * as PermissionReviewer from "./service"
