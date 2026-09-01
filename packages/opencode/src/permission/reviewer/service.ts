import { Usage } from "@opencode-ai/llm"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ConfigPermissionV1 } from "@opencode-ai/core/v1/config/permission"
import { Config } from "@/config/config"
import { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import { Session } from "@/session/session"
import { MessageV2 } from "@/session/message-v2"
import { Auth } from "@/auth"
import { Plugin } from "@/plugin"
import { buildBaseProviderMap, isOpenaiOauthProvider } from "@/provider/alias"
import { SessionRetry } from "@/session/retry"
import { Database } from "@opencode-ai/core/database/database"

import { MessageID, PartID, SessionID } from "@/session/schema"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ToolJsonSchema } from "@/tool/json-schema"
import type { ToolPart, User, Assistant, TextPart, ReasoningPart } from "@opencode-ai/core/v1/session"
import { jsonSchema, streamText, tool, wrapLanguageModel, type ModelMessage } from "ai"
import { Context, Effect, Exit, Layer, Option, Schema, Semaphore } from "effect"
import * as Stream from "effect/Stream"
import { mergeDeep } from "remeda"
import { PermissionReviewerPrompt } from "./prompt"
import { Assessment, ReviewerRequest } from "./schema"
import { PermissionReviewerTranscript } from "./transcript"
import type { PermissionAuto } from "../auto"

// #546：错误文案与 SessionProcessor.TOOL_ABORTED_ERROR 字面量对齐（跨模块合同：aborted 与
// incomplete 必须区分，防 Provider replay 把协议失败误判成用户取消）；故意不 import
// processor——reviewer 失败路径不得把 session 模块拉进加载图。
const TOOL_ABORTED_ERROR = "Tool execution aborted"
const TOOL_INCOMPLETE_ERROR = "Tool execution did not complete before stream ended"

// #198：reviewer 不可用——服务已禁用，回退到用户审批
// #280：Disabled 仅表示显式 approvals_reviewer=user，auto.ts 将其转为 ask
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

// #209：合并 provider options 与 model.options——reviewer stream 需与正常 SessionPrompt 一致的 provider 适配
// JSON fallback is a runtime compatibility boundary, not a prompt contract: the
// reviewer prompt still asks providers to submit `permission_review_decision`,
// but some tool-capable providers occasionally return the same Assessment as a
// plain JSON final answer. Accept only a complete schema-valid JSON object and
// mark the persisted audit part with this source so later UI/export code can
// distinguish fallback acceptance from an actual function/tool call.
const JSON_FALLBACK_SOURCE = "json_fallback"
// #227：JSON 回退来源标记——模型以纯文本回复决策而非调用工具时，合成 part 用此标记区分审计来源
// This exact reason is the retry discriminator. Provider errors and policy
// denials must not be retried through this path; only a completed reviewer turn
// that produced neither a decision tool call nor valid JSON fallback is hidden
// and retried with a protocol nudge.
const REVIEWER_DECISION_PROTOCOL_ERROR = "reviewer did not call permission_review_decision"
  // #227：协议错误哨兵——JSON 回退失败与工具缺失共用同一错误码触发重试
// Keep this string aligned with MessageV2.Hidden. It names the audit workflow
// that owns these hidden child-session turns and prevents future hidden-message
// consumers from confusing protocol retry cleanup with undo or session repair.
const PROTOCOL_RETRY_HIDDEN_REASON = "permission-reviewer-protocol-retry"
// #227：协议失败重试的隐藏原因——首次尝试的畸形输出在重试前隐藏，避免用户把 JSON/散文答案误读为已批准
// 两条reviewer路径共用预算措辞；仅超时后的新请求追加，不污染首次证据。
const TIME_BUDGET_RETRY_USER_ITEM = PermissionReviewerPrompt.TIME_BUDGET_RETRY_USER_ITEM
// reviewer 总尝试次数：1 初始 + 2 重试。协议错误与超时共用该预算。
const MAX_REVIEWER_ATTEMPTS = 3
const PROTOCOL_RETRY_USER_ITEM = {
// #227：协议 nudge 仅追加到 user items——重试时保持证据与请求上下文不变，只修复提交格式
  type: "text" as const,
  // 重试仍重建同一证据，nudge明确排除反问/执行承诺，保留source允许的严格JSON兼容入口。
  text: PermissionReviewerPrompt.PROTOCOL_RETRY_TEXT,
}
const mergeOptions = (target: Record<string, any>, source: Record<string, any> | undefined): Record<string, any> =>
  mergeDeep(target, source ?? {}) as Record<string, any>

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    // #250：auth.get(providerID) 判定凭据类型——只有 openai+oauth 才走 instructions 提升
    const auth = yield* Auth.Service
    const plugin = yield* Plugin.Service
    const provider = yield* Provider.Service
    // #206：layer 内捕获 Database 服务——review 经 provideService 消化 page 的 DB 需求且不泄漏类型
    const database = yield* Database.Service
    // #208：Session.Service 已在 patch 206 保留——复用为 session 变量避免 Database.Service 泄漏
    const session = yield* Session.Service
    // #208：每父会话一个 Semaphore——并发工具审查复用同一 reviewer transcript
    const reviewerSessionLocks = new Map<SessionID, Semaphore.Semaphore>()
    // 层内记忆明确拒绝tool_choice的provider，避免重复往返；不持久化或扩大到任意参数错误。
    const toolChoiceRejectedProviders = new Set<ProviderV2.ID>()

    const review: Interface["review"] = (input) =>
      // #209：streaming refactor——generateObject 替换为 streamText + permission_review_decision tool，让 reviewer 子会话留下可审计的推理与文本轨迹
      Effect.gen(function* () {
        const cfg = yield* config.get()
        const permission = cfg.permission
        // #280：auto action 已决定送审；仅显式 user 禁用 reviewer，metadata.agent 只作审计证据
        if (!reviewerEnabled(permission, input.metadata)) return yield* new ReviewerDisabled()
        const autoReview = permission?.auto_review
        // #264：默认 fallback=user，fallback=deny 保留 fail-closed
        const fallbackToUser = autoReview?.fallback !== "deny"

        const run = Effect.gen(function* () {
          const request = new ReviewerRequest({
            permission: input.permission,
            patterns: [...input.patterns],
            metadata: { ...input.metadata },
            precheck: input.precheck,
          })
          // #209：模型解析提前到 transcript 之前——streamText 需要具体 model 对象而非仅在 generateObject 调用点解析
          const model = autoReview?.model
            ? yield* provider.getModel(
                Provider.parseModel(autoReview.model).providerID,
                Provider.parseModel(autoReview.model).modelID,
                )
            : yield* resolveImplicitReviewerModel(input.sessionID ? SessionID.make(input.sessionID) : undefined)
          // #208：获取或创建 reviewer 子会话——复用同一 transcript 追加请求/决策轮次
          const reviewerSession = input.sessionID ? yield* getReviewerSession(SessionID.make(input.sessionID), model) : undefined
          // #209：标记工具状态为 reviewing 并附带 reviewer 子会话 ID——UI 可导航到 reviewer 子会话查看完整推理
          yield* markToolReviewing(input, reviewerSession?.id)
          const tenantPolicy = yield* loadTenantPolicy(autoReview)
          // #206：transcript 收集双重有界——先拉 120 条宽窗口再由 transcript 选择保留用户锚点和截短条目
          // #206：page.more 表示获取窗口外还有更早消息（含 hidden 行的原始窗口探测）——hidden 挤占
          // #206：窗口时可见条目可能 ≤ENTRY_LIMIT，必须与 selectEntries 截短合并披露，否则 reviewer
          // #206：会把部分历史当作完整对话评估 user_authorization（page.more 语义合并）
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
          // #209：在子会话中记录 reviewer 请求——metadata 标记防止被误认为人类授权，但保留可检查性
          const system = PermissionReviewerPrompt.buildSystemPrompt(tenantPolicy, "tool")
          const userItems = PermissionReviewerPrompt.buildUserPromptItems(transcript, request, input.precheck.reason)
    // #227：buildMessages 统一拼装 system+userItems——重试时仅追加协议 nudge 其余不变
          const messages = buildMessages({ system, userItems })
          function runReviewerAttempt(messages: readonly ModelMessage[], hideProtocolFailure: boolean) {
// #227：hideProtocolFailure=true 时协议错误触发隐藏+重试；第二次尝试传 false 不再隐藏
            return Effect.gen(function* () {
              const reviewerUser = reviewerSession
// #227：先落盘 synthetic reviewer 请求，重试时才能按 requestID 隐藏首次失败尝试
                ? yield* recordReviewerRequest({
                    session: reviewerSession,
                    model,
                    reviewID: input.reviewID,
                    text: renderReviewerPrompt(messages),
                  })
                : undefined
              return yield* runReviewerAgent({
                session: reviewerSession,
                model,
                // #214：reviewID 从父工具 autoReview metadata 传入——稳定 join key
                reviewID: input.reviewID,
          // #209：streamText + permission_review_decision tool——流式持久化 reasoning/text/tool part，替代一次性 generateObject 黑盒
// #227：reviewer 用流式事件持久化 part——推理/文本/工具分片随 stream 实时落盘，替代一次性拼接
            // #214：reviewID 透传到 reviewer agent——最终决策 part 需 mirror 此 ID
                parentID: reviewerUser?.id,
                messages,
              }).pipe(
                Effect.tapError((error) => {
// #227：协议失败才隐藏——provider/schema 等其他错误保持可见，避免掩盖真实失败
    // #227：隐藏前置条件齐全才隐藏——缺 reviewer 会话或非协议错误时静默跳过
                  if (!hideProtocolFailure || !reviewerSession || !reviewerUser || !isReviewerDecisionProtocolError(error)) {
                    return Effect.void
                  }
                  return hideReviewerProtocolAttempt(session, reviewerSession.id, reviewerUser.id)
// #227：隐藏失败尝试后重试；隐藏本身失败不阻断流程（Effect.ignore）
                }),
              )
            }) as Effect.Effect<Schema.Schema.Type<typeof Assessment>, Error, never>
          }
          // timeout_ms是每次执行预算，共三次尝试；清理开销不构成严格的总墙钟上限。
          // 默认120秒覆盖source观测长尾；显式配置与三次尝试总数不变。
          const perAttemptTimeout = autoReview?.timeout_ms ?? 120_000
          // 显式返回注解：递归函数的返回类型无法推断（TS7023/7024）
          const reviewerRetry = (attemptNum: number, currentMessages: readonly ModelMessage[], hideProtocolFailure: boolean): Effect.Effect<Schema.Schema.Type<typeof Assessment>, Error> =>
            runReviewerAttempt(currentMessages, hideProtocolFailure).pipe(
              Effect.timeoutOrElse({
                duration: `${perAttemptTimeout} millis`,
                orElse: () => Effect.fail(new ReviewerTimedOut()),
              }),
              // catchIf 在 timeoutOrElse 外层：能捕获 ReviewerTimedOut 进行重试。
              // 旧代码顺序相反，超时绕过了重试。
              Effect.catchIf(isReviewerRetryable, (error) => {
                if (attemptNum >= MAX_REVIEWER_ATTEMPTS - 1) return Effect.fail(error)
                // 按最近失败重建单份后缀；协议→超时只留时间预算，不累积旧格式提示。
                const nextMessages = isReviewerDecisionProtocolError(error)
                  ? buildMessages({ system, userItems: [...userItems, PROTOCOL_RETRY_USER_ITEM] })
                  : error instanceof ReviewerTimedOut
                    ? buildMessages({ system, userItems: [...userItems, TIME_BUDGET_RETRY_USER_ITEM] })
                    : currentMessages
                return reviewerRetry(attemptNum + 1, nextMessages, false)
              }),
            )
          const assessment = yield* reviewerRetry(0, messages, true).pipe(
            // #198：mapError 将非 reviewer 错误包装为 RunError——provider/schema 错误统一为可处理的 fail-closed 信号
            Effect.mapError((error) =>
// #227：非 reviewer 错误统一包装为 RunError——fail-closed 信号可被上层捕获
    // #227：isReviewerError 保持原始错误类型——只有未知错误才包装为 RunError
              isReviewerError(error) ? error : new ReviewerRunError({ reason: errorMessage(error) }),
            ),
          )
          // #209：标记工具审查结果——allowed/denied 状态和 reviewer 评估详情写入工具 metadata 供 UI 渲染
// #227：markToolReviewed 把 outcome 写回工具 metadata——UI 无需重查 reviewer 子会话
          yield* markToolReviewed(input, assessment)

          return {
            action: assessment.outcome,
            reason: assessment.rationale,
            // #208：reviewID 由 auto.ts mint 后传入——不再在此处随机生成
            reviewID: input.reviewID,
            risk_level: assessment.risk_level,
            user_authorization: assessment.user_authorization,
          } satisfies PermissionAuto.ReviewDecision
        })

        // #209：错误时标记工具审查失败——fallback=user 标记 fallback_user，超时标记 timed_out，其他标记 failed，使 UI 能展示失败原因
        return yield* run.pipe(
          // #264：defect 不应绕过权限边界，转为同一 post-retry 失败通道
          Effect.catchDefect((defect) => Effect.fail(defect)),
          Effect.catch((error: unknown) =>
            Effect.gen(function* () {
              yield* markToolReviewFailed(
                input,
                fallbackToUser && !(error instanceof ReviewerDisabled)
                  ? "fallback_user"
                  : error instanceof ReviewerTimedOut
                    ? "timed_out"
                    : "failed",
                errorMessage(error),
              ).pipe(
                // #264：父 tool metadata 是审计/UI 状态，写入失败不应创建第二个失败模式
                Effect.catch(() => Effect.void),
                Effect.catchDefect(() => Effect.void),
              )
              // #264：reviewer 失败默认转为显式 fallback 信号，让 PermissionAuto 复用普通 ask 路径
              if (fallbackToUser && !(error instanceof ReviewerDisabled)) {
                return yield* new ReviewerFallbackToUser({ reason: errorMessage(error) })
              }
              // #264：非 ReviewerError 的未知错误包成 ReviewerRunError——类型化错误契约不因 fallback 改造而破裂
              return yield* Effect.fail(isReviewerError(error) ? error : new ReviewerRunError({ reason: errorMessage(error) }))
            }),
          ),
          // 外部取消（session cancel/compaction）不触发 handleReviewerFailure（中断
          // 不是 failure）；onInterrupt 作为 processor.interruptedToolMetadata 的补充，
          // 覆盖 processor 清理未触达的边界（stuck reviewing 案例）。
          Effect.onInterrupt(() =>
            markToolReviewFailed(input, "aborted", "reviewer interrupted").pipe(
              Effect.catch(() => Effect.void),
              Effect.catchDefect(() => Effect.void),
            ),
          ),
        )
      })

    return Service.of({ review })

    // [local-smark] 隐式 reviewer 模型解析开始
    // 未配置 permission.auto_review.model 时，reviewer 不应直接使用全局
    // Provider.defaultModel()，因为后者会读 state/model.json recent，可能漂移到
    // 一个认证失效的 provider（如 zhipuai/glm-5.2 → 401 → “身份验证失败。”）。
    // 这里复用 SessionPrompt.currentModel 的语义：先读父会话 SessionTable.model，
    // 再找最近一条带 model 的 user message，最后才回退到 defaultModel。选定候选
    // provider 后仍沿用 getSmallModel 优先策略以保持成本/性能行为不变。
    function resolveImplicitReviewerModel(sessionID: SessionID | undefined) {
      return Effect.gen(function* () {
        const candidate = yield* parentSessionModel(sessionID)
        // 候选 provider 选定后，优先用同 provider 的 small model；若不存在则用 exact model。
        // 保留既有 small_model 语义：全局 small_model 仍可能跨 provider 覆盖，这是兼容行为。
        return yield* resolveModelWithFallback(candidate)
      })
    }

    // 读取父会话当前模型，语义对齐 SessionPrompt.currentModel：
    // SessionTable.model → 最近 user message model → provider.defaultModel()
    function parentSessionModel(sessionID: SessionID | undefined) {
      return Effect.gen(function* () {
        if (!sessionID) return yield* provider.defaultModel()
        // session.get 和 findMessage 是 best-effort：如果 session 不存在或
        // message store 不可用，不能让 reviewer 直接不可用，应回退到 defaultModel。
        const exit = yield* Effect.exit(session.get(sessionID))
        if (Exit.isSuccess(exit)) {
          const s = exit.value
          if (s.model) {
            return {
              providerID: s.model.providerID,
              modelID: s.model.id,
            }
          }
        }
        // 旧 session 或 projector 未写入 model 时，用最近 user message 的 model
        const match = yield* session
          // #493：role/model 均为 Info 热字段——reviewer fallback 扫描不得因一次权限请求展开整段历史工具输出。
          .findMessage(sessionID, (info) => info.role === "user" && !!info.model)
          .pipe(Effect.catch(() => Effect.succeed(Option.none())))
        if (Option.isSome(match) && match.value.info.role === "user" && match.value.info.model) {
          return {
            providerID: match.value.info.model.providerID,
            modelID: match.value.info.model.modelID,
          }
        }
        return yield* provider.defaultModel()
      })
    }

    // 选定候选 provider/model 后，沿用 getSmallModel → getModel 的既有解析顺序。
    // 如果隐式候选的 exact model 已从 provider 配置移除（ModelNotFoundError），
    // 只在此处回退一次到 defaultModel，避免 stale session model 让 reviewer 永久不可用。
    function resolveModelWithFallback(candidate: { providerID: ProviderV2.ID; modelID: ModelV2.ID }) {
      return Effect.gen(function* () {
        const small = yield* provider.getSmallModel(candidate.providerID).pipe(
          Effect.catch(() => Effect.succeed(undefined)),
        )
        if (small) return small
        return yield* provider.getModel(candidate.providerID, candidate.modelID).pipe(
          // 仅隐式候选的 exact model 缺失才回退；显式 auto_review.model 不经过此路径
          Effect.catchTag("ProviderModelNotFoundError", () =>
            Effect.gen(function* () {
              const fallback = yield* provider.defaultModel()
              return yield* provider.getModel(fallback.providerID, fallback.modelID)
            }),
          ),
        )
      })
    }
    // [local-smark] 隐式 reviewer 模型解析结束


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

    // #209：记录 reviewer 请求为可见用户消息——metadata 标记防止被误认为人类授权
    // #214：reviewID 写入 metadata——审计/导出代码可按逻辑审查导航，无需解析安全敏感的合成 prompt
    function recordReviewerRequest(input: { session: Session.Info; model: Provider.Model; reviewID: string; text: string }) {
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
          // #209：metadata 标记替代 synthetic——reviewer 子会话请求 cell 可见但不可作为授权证据，transcript 投影据此排除
          // #214：reviewID 是从父工具 autoReview metadata 到此可见协议 prompt 的稳定 join key
          metadata: { permissionReviewerRequest: true, reviewID: input.reviewID },
          text: input.text,
        } satisfies TextPart)
        return message
      })
    }

    // #209：runReviewerAgent——有子会话时持久化流式 part，无子会话时仅提取 assessment
    // #214：reviewID 透传到 runReviewerStream——最终决策 part metadata 需 mirror 此 ID
    function runReviewerAgent(input: {
      session: Session.Info | undefined
      model: Provider.Model
      reviewID: string
      parentID: MessageID | undefined
      messages: readonly ModelMessage[]
    }) {
      const sessionInfo = input.session
      const parentID = input.parentID
      // #209：无子会话或无 parentID 时走纯流式提取——不持久化中间 part，仅从 tool-call 事件取出 assessment
      if (!sessionInfo || !parentID) return runReviewerStreamWithToolChoice(input.messages, input.model)
      return Effect.gen(function* () {
        // #209：先创建 assistant 消息壳——流式 part 挂载到该消息，错误时也能回填 error 字段
        const message: Assistant = {
          id: MessageID.ascending(),
          parentID,
          role: "assistant",
          mode: "permission-reviewer",
          agent: "permission-reviewer",
          path: { cwd: sessionInfo.directory, root: sessionInfo.directory },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: input.model.id,
          providerID: input.model.providerID,
          sessionID: sessionInfo.id,
          time: { created: Date.now() },
        }
        yield* session.updateMessage(message)
        // #546：message 终态写入前先闭协议 tool（tool→message 顺序，INV-02）——Aborted
        // message + pending tool 的僵尸形态会逃过 abortPendingToolParts（其只扫未 completed 的 assistant）。
        // finalize 失败只可观测，不产生第二个业务错误（INV-04）。
        const closeMessageTools = (error: string, interrupted: boolean) =>
          closeOpenReviewerTools(session, {
            sessionID: sessionInfo!.id,
            messageID: message.id,
            error,
            interrupted,
          }).pipe(
            Effect.provideService(Database.Service, database),
            Effect.catch((cause) => Effect.logWarning("reviewer closeMessageTools failed", { cause, sessionID: sessionInfo.id, messageID: message.id })),
            Effect.catchDefect((cause) => Effect.logWarning("reviewer closeMessageTools defect", { cause, sessionID: sessionInfo.id, messageID: message.id })),
          )
        const assessment = yield* runReviewerStreamWithToolChoice(input.messages, input.model, {
          sessionID: sessionInfo.id,
          messageID: message.id,
          // #214：reviewID 透传到 stream——决策 part metadata 需 mirror 此 ID
          reviewID: input.reviewID,
          // [local-smark] 传入可变 message 引用，使 finish-step handler 能就地更新 tokens/cost
          message,
        }).pipe(
          // #209：流式错误时仍持久化 assistant 消息的 error 字段——审计可见失败原因，而非丢失在内存中
          // #546：先闭 tool 再写 message——顺序颠倒会重现「error message + pending tool」僵尸（INV-02）。
          Effect.tapError((error) =>
            Effect.gen(function* () {
              yield* closeMessageTools(TOOL_INCOMPLETE_ERROR, false)
              message.error = MessageV2.fromError(error, { providerID: input.model.providerID })
              message.time.completed = Date.now()
              yield* session.updateMessage(message)
            }),
          ),
          // #546：超时中断不会触发 tapError（中断不是 failure）；onInterrupt 先闭 tool 再确保子会话
          // assistant 消息写入终态，避免 repair-empty-dangling-assistant 延迟修复（对齐 prompt.ts 模式）。
          Effect.onInterrupt(() =>
            Effect.gen(function* () {
              yield* closeMessageTools(TOOL_ABORTED_ERROR, true)
              if (message.time.completed) return
              message.error ??= MessageV2.fromError(
                new DOMException("Aborted", "AbortError"),
                { providerID: input.model.providerID, aborted: true },
              )
              message.time.completed = Date.now()
              yield* session.updateMessage(message)
            }).pipe(Effect.catch(() => Effect.void), Effect.catchDefect(() => Effect.void)),
          ),
        )
        // #209：流结束后补全 finish 与 completed——tool-calls 标记决策工具已被调用
        message.finish = "tool-calls"
        message.time.completed = Date.now()
        yield* session.updateMessage(message)
        return assessment
      })
    }

    // #209：runReviewerStream——streamText + permission_review_decision tool，流式消费 fullStream 事件并逐 part 持久化
    // #214：persist 新增 reviewID——最终决策 part metadata mirror 此 ID，供审计/导出按逻辑审查导航
    // #214：persist 为 undefined 时（无子会话）不 mirror reviewID——纯流式提取不持久化决策 part
    function runReviewerStream(
      messages: readonly ModelMessage[],
      model: Provider.Model,
      persist?: { sessionID: SessionID; messageID: MessageID; reviewID: string; message: Assistant },
      forcedToolChoice?: boolean,
    ) {
      return Effect.acquireUseRelease(
        // #209：AbortController 在 release 时中止 streamText——Effect 取消/超时能立即停止 provider 流
        Effect.sync(() => new AbortController()),
        (abort) =>
          Effect.gen(function* () {
            // #250：四项依赖互不依赖，Effect.all unbounded 合并发射减少 reviewer 延迟；
            // config 与 auth 是 OAuth 判定的新增输入
            const [language, providerInfo, cfg, authInfo] = yield* Effect.all(
              [
                provider.getLanguage(model),
                provider.getProvider(model.providerID),
                config.get(),
                auth.get(model.providerID),
              ],
              { concurrency: "unbounded" },
            )
            // #209：无 persist 时用固定标识——ProviderTransform.options 需要一个 sessionID 做 provider 适配键，无子会话时用常量避免空值
            const sessionID = persist?.sessionID ?? "permission-reviewer"
            // #209：合并 provider options 与 model.options——与 SessionPrompt 保持一致的 provider 适配，避免 reviewer 流缺少必要选项
            const baseOptions = mergeOptions(
              ProviderTransform.options({ model, sessionID, providerOptions: providerInfo.options }),
              model.options,
            )
            const isOpenaiOauth =
              isOpenaiOauthProvider(providerInfo.id, buildBaseProviderMap(cfg.provider ?? {})) && authInfo?.type === "oauth"
            // OpenAI OAuth/Codex 后端要求顶层 instructions；普通 Responses 会把
            // system message 降成 input item，但 Codex 路径会因此 400。这里只移动
            // 可信 reviewer 指令，transcript、precheck reason 和 planned action 仍留在
            // user message，避免把不可信证据提升成高优先级指令。
            const reviewerInstructions = isOpenaiOauth
              ? messages.flatMap((message) => (message.role === "system" ? [message.content] : [])).join("\n")
              : undefined
            const reviewerMessages = isOpenaiOauth ? messages.filter((message) => message.role !== "system") : messages
            // [local-smark] 提取 tool 定义常量，使 tool() 和 toolsText 共用同一 schema 序列化，
            // 避免重复调用产生不一致的序列化结果
            const assessmentSchema = ToolJsonSchema.fromSchema(Assessment)
            const toolDescription = "Submit the structured allow/deny decision for this permission review."
            // [local-smark] 计算 /context 面板所需的 per-component 字符 breakdown。reviewer 不走
            // session.prompt 的 pre-stream estimate 路径，所以在此直接按字符占比
            // 计算并附到 step-finish part，使 tokenAccounting 的 breakdown 非 null。
            // 公式与 prompt.ts 一致：inputChars = [system, rawMessages, tools].join("\n").length
            const toolsText = `Tool: permission_review_decision\n${toolDescription}\n${JSON.stringify(assessmentSchema)}`
            // conversationMessages 排除 system message：非 OAuth 时 system 在 messages 中，
            // OAuth 时 reviewerMessages 已过滤。system 单独计入 system/instructions 分区，
            // 避免 messages.total 与 system 重复累加。
            const conversationMessages = reviewerMessages.filter((m) => m.role !== "system")
            const rawMessagesText = JSON.stringify(conversationMessages)
            let userTextChars = 0
            for (const m of conversationMessages) {
              if (m.role !== "user") continue
              userTextChars += typeof m.content === "string" ? m.content.length : JSON.stringify(m.content).length
            }
            const systemMessage = messages.find((m) => m.role === "system")
            const systemText = typeof systemMessage?.content === "string" ? systemMessage.content : ""
            const inputChars = [systemText, rawMessagesText, toolsText].join("\n").length
            // OAuth 路径下 system 被提取为顶层 instructions：system 分区=0，instructions=systemText。
            // 非 OAuth 路径下 system 保留为 system message：system=systemText，instructions=0。
            const inputBreakdown = {
              system: isOpenaiOauth ? 0 : systemText.length,
              instructions: isOpenaiOauth ? systemText.length : 0,
              skills: 0,
              tools: toolsText.length,
              messages: {
                userText: userTextChars,
                assistantText: 0,
                reasoning: 0,
                toolInput: 0,
                toolOutput: 0,
                attachments: 0,
                total: rawMessagesText.length,
              },
            }
            const options = reviewerInstructions ? { ...baseOptions, instructions: reviewerInstructions } : baseOptions
            // #261：Reviewer 复用主聊天 provider hook——Codex 清理不支持的 output caps、Copilot 禁用不兼容的 tool streaming
            // 合成消息不暴露 reviewer prompt 文本或证据——这些仍在有界 reviewer prompt 内
            const hookSessionID = persist?.sessionID ?? SessionID.descending()
            const hookMessage = {
              id: MessageID.ascending(),
              sessionID: hookSessionID,
              role: "user",
              time: { created: Date.now() },
              agent: "permission-reviewer",
              model: { providerID: model.providerID, modelID: model.id },
            } satisfies User
            const hookInput = {
              sessionID: hookSessionID,
              agent: "permission-reviewer",
              model,
              provider: providerInfo,
              message: hookMessage,
            }
            const params = yield* plugin.trigger("chat.params", hookInput, {
              temperature: undefined,
              topP: undefined,
              topK: undefined,
              maxOutputTokens: ProviderTransform.maxOutputTokens(model),
              options,
            })
            const headers = yield* plugin.trigger("chat.headers", hookInput, { headers: {} })
            // #209：wrapLanguageModel 注入 message 归一化中间件——reviewer 流与 SessionPrompt 共享同一 provider 适配层
            const result = streamText({
              model: wrapLanguageModel({
                model: language,
                middleware: [
                  {
                    specificationVersion: "v3" as const,
                    async transformParams(args) {
                      if (args.type === "stream") {
                        // 与普通请求共用消息归一化，避免审查流跳过provider适配。
                        // @ts-expect-error AI SDK's internal prompt type is narrower than ModelMessage here.
                        args.params.prompt = ProviderTransform.message(args.params.prompt, model, options)
                      }
                      return args.params
                    },
                  },
                ],
              }),
              messages: [...reviewerMessages],
              tools: {
                permission_review_decision: tool({
                  description: toolDescription,
                  // #209：ToolJsonSchema.fromSchema 将 Effect Assessment schema 转为 AI SDK jsonSchema——替代原 generateObject 的双重 schema
                  inputSchema: jsonSchema(assessmentSchema as Parameters<typeof jsonSchema>[0]),
                  // #209：execute 返回 title/metadata/output——SDK 调用此函数但真正持久化在 tool-call 事件处理器中完成
                  execute: async (assessment) => ({
                    title: assessment.outcome === "allow" ? "Permission review allowed" : "Permission review denied",
                    metadata: assessment,
                    output: JSON.stringify(assessment),
                  }),
                }),
              },
              // 默认强制决策工具；明确400参数拒绝才由同一次评审协商去参。
              toolChoice: forcedToolChoice ? ("required" as const) : undefined,
              maxRetries: 0,
              // #261：providerOptions 和 maxOutputTokens 现由 plugin hook 修改后的 params 提供
              providerOptions: ProviderTransform.providerOptions(model, params.options),
              maxOutputTokens: params.maxOutputTokens,
              headers: headers.headers,
              abortSignal: abort.signal,
            })
            // #209：assessment 可变——由 tool-call 事件设置，流结束时检查是否为空决定 fail-closed
            let assessment: Schema.Schema.Type<typeof Assessment> | undefined
// #227：assessment 由 tool-call 事件或文本回退填充——流结束时为空即 fail-closed
            // #209：textPart/reasoningPart 可变——跨 start/delta/end 事件保持引用以增量更新同一 part
            let textPart: TextPart | undefined
            let textOutput = ""
// #227：textOutput 累积所有 text-delta——JSON 回退解析需要完整文本而非首个分片
            let reasoningPart: ReasoningPart | undefined
            // #209：toolParts/toolInput 按 callID 索引——一个 tool-call 的 input-start/delta/end/call 共享同一 callID
            // #497：Map 只表达 attempt 对 Part identity 的 ownership，不缓存可变 state；
            // durable state 的单一真相留在 Session.Service，避免发布窗口产生双重 winner。
            const toolParts = new Map<string, PartID>()
            const toolInput = new Map<string, string>()
            // #546：stream 退出方式标志——onInterrupt 置位，ensuring 兜底据此选择终态文案。
            let streamInterrupted = false
            // #546：safeFinalize——cleanup 失败降级为可观测日志，绝不让 finalize 错误覆盖
            // provider 原始错误或伪装 reviewer 成功（INV-04）。
            const safeFinalize = (error: string, interrupted: boolean) =>
              finalizeOpenToolParts(error, interrupted).pipe(
                Effect.catch((cause) => Effect.logWarning("reviewer finalizeOpenToolParts failed", { cause, sessionID: persist?.sessionID, messageID: persist?.messageID })),
                Effect.catchDefect((cause) => Effect.logWarning("reviewer finalizeOpenToolParts defect", { cause, sessionID: persist?.sessionID, messageID: persist?.messageID })),
              )
            const finalizeOpenToolParts = Effect.fnUntraced(function* (error: string, interrupted: boolean) {
              if (!persist) return
              // #546：委托 map∪durable 双扫描（closeOpenReviewerTools）——只扫内存 Map 会漏
              // commit 后 return 前中断的 part；#497 的 getPart 重读语义在委托内完整保留。
              yield* closeOpenReviewerTools(session, {
                sessionID: persist.sessionID,
                messageID: persist.messageID,
                knownPartIDs: toolParts.values(),
                error,
                interrupted,
              }).pipe(Effect.provideService(Database.Service, database))
            })

            const iterator = result.fullStream[Symbol.asyncIterator]()
            const close = iterator.return
            if (close) iterator.return = (value) => {
              // SDK的tee分支关闭要等待底层流结束，必须先中止请求再等待迭代器释放。
              abort.abort()
              return close.call(iterator, value)
            }

            yield* Stream.runForEach(
              // #209：fullStream 聚合 reasoning/text/tool 全部事件——逐事件持久化使子会话 transcript 实时可审计
              Stream.fromAsyncIterable({ [Symbol.asyncIterator]: () => iterator }, (error) => error),
              // #209：fnUntraced 避免每个 stream 事件创建 span——fullStream 事件高频，tracing 噪声远大于诊断价值
              Effect.fnUntraced(function* (event) {
                // #209：无 persist 时仅提取 assessment——不持久化中间 part，用于无子会话的纯判定路径
                if (!persist) {
                  if (event.type === "text-delta") {
                    textOutput += event.text
// #227：text-delta 增量累积，textPart 同时持久化——两者各自独立完成
                  }
                  if (event.type === "tool-call" && event.toolName === "permission_review_decision") {
// #227：tool-call 事件携带最终 input——此处提取 assessment 为唯一权威来源
                    assessment = assessmentFromUnknown(event.input)
                  }
                  // 纯流式分支也传播原始provider错误，不能吞成协议失败使窄400协商失去依据。
                  if (event.type === "error") return yield* Effect.fail(event.error)
                  return
                }
                if (event.type === "reasoning-start") {
// #227：reasoning 空壳先建后增量更新——UI 能实时显示推理进度
                  // #209：reasoning part 先建空壳——delta 事件增量更新 text，end 事件收尾时间
                  reasoningPart = yield* session.updatePart({
                    id: PartID.ascending(),
                    sessionID: persist.sessionID,
                    messageID: persist.messageID,
                    type: "reasoning",
                    text: "",
                    time: { start: Date.now() },
                    metadata: event.providerMetadata,
                  } satisfies ReasoningPart)
                  return
                }
                if (event.type === "reasoning-delta" && reasoningPart) {
                  // #209：增量追加 reasoning 文本——每次 delta 都 updatePart 使 UI 实时显示推理进度
                  reasoningPart.text += event.text
                  if (event.providerMetadata) reasoningPart.metadata = event.providerMetadata
                  yield* session.updatePart(reasoningPart)
                  return
                }
                if (event.type === "reasoning-end" && reasoningPart) {
                  reasoningPart.time = { ...reasoningPart.time, end: Date.now() }
                  if (event.providerMetadata) reasoningPart.metadata = event.providerMetadata
                  yield* session.updatePart(reasoningPart)
                  reasoningPart = undefined
                  return
                }
                if (event.type === "text-start") {
                  textPart = yield* session.updatePart({
                    id: PartID.ascending(),
                    sessionID: persist.sessionID,
                    messageID: persist.messageID,
                    type: "text",
                    text: "",
                    time: { start: Date.now() },
                    metadata: event.providerMetadata,
                  } satisfies TextPart)
                  return
                }
                if (event.type === "text-delta" && textPart) {
                  textOutput += event.text
                  textPart.text += event.text
                  if (event.providerMetadata) textPart.metadata = event.providerMetadata
                  yield* session.updatePart(textPart)
                  return
                }
                if (event.type === "text-end" && textPart) {
                  textPart.time = { start: textPart.time?.start ?? Date.now(), end: Date.now() }
                  if (event.providerMetadata) textPart.metadata = event.providerMetadata
                  yield* session.updatePart(textPart)
                  textPart = undefined
                  return
                }
                if (event.type === "tool-input-start") {
                  // #209：工具输入先建 pending 壳——delta 缓冲到 toolInput Map，end 时回填 raw
                  const part = {
                    id: PartID.ascending(),
                    sessionID: persist.sessionID,
                    messageID: persist.messageID,
                    type: "tool",
                    callID: event.id,
                    tool: event.toolName,
                    state: { status: "pending", input: {}, raw: "" },
                  } satisfies ToolPart
                  // #497：identity 必须先于 updatePart 注册：SQLite commit 早于事件发布和返回，
                  // 中断若落在其间，attempt cleanup 仍能通过 PartID 找到 durable pending。
                  toolParts.set(event.id, part.id)
                  yield* session.updatePart(part)
                  return
                }
                if (event.type === "tool-input-delta") {
                  // #209：缓冲工具输入 delta——不在每个 delta 持久化，避免高频写入，end 时一次性回填 raw
                  toolInput.set(event.id, (toolInput.get(event.id) ?? "") + event.delta)
                  return
                }
                if (event.type === "tool-input-end") {
// #227：input 聚合完成时回填 state.input——running 状态先持久化保证 UI 及时
                  const partID = toolParts.get(event.id)
                  if (!partID) return
                  // #497：raw 参数更新也必须从 durable Part 起步；创建写入可能已经 commit，
                  // 但调用返回与内存 snapshot 更新并不构成持久化顺序保证。
                  const part = yield* session.getPart({
                    sessionID: persist.sessionID,
                    messageID: persist.messageID,
                    partID,
                  })
                  if (!part || part.type !== "tool" || part.state.status !== "pending") return
                  yield* session.updatePart({
                    ...part,
                    state: { ...part.state, raw: toolInput.get(event.id) ?? "" },
                  } satisfies ToolPart)
                  return
                }
                if (event.type === "tool-call" && event.toolName === "permission_review_decision") {
                  // #209：tool-call 携带最终 input——Schema.decode 验证并提取 assessment，同时把 tool part 标记 completed
                  assessment = assessmentFromUnknown(event.input)
                  if (!assessment) return
                  // #209：toolCallId 可能与 tool-input-start 的 event.id 不同——无 existing 时新建 part 壳
                  const registered = toolParts.get(event.toolCallId)
                  const partID = registered ?? PartID.ascending()
                  // #497：部分 Provider 直接发 tool-call；该路径同样在首次 durable write 前登记，
                  // 保持所有 attempt-owned Tool Part 只有一个 closure 所有者。
                  if (!registered) toolParts.set(event.toolCallId, partID)
                  // #497：completed 转换基于存储中的最新 ID/raw/metadata，避免先前 pending 写入
                  // 已提交但尚未返回时，旧对象重新成为后续 terminal write 的来源。
                  const current = registered
                    ? yield* session.getPart({
                        sessionID: persist.sessionID,
                        messageID: persist.messageID,
                        partID,
                      })
                    : undefined
                  yield* session.updatePart({
                    ...(current?.type === "tool"
                      ? current
                      : {
                          id: partID,
                          sessionID: persist.sessionID,
                          messageID: persist.messageID,
                          type: "tool" as const,
                          callID: event.toolCallId,
                          tool: event.toolName,
                        }),
                    state: {
                      status: "completed",
                      input: assessment,
                      title: assessment.outcome === "allow" ? "Permission review allowed" : "Permission review denied",
                      // #214：reviewID mirror 到最终决策 part——子会话可按逻辑审查搜索/导出
                      // #214：一个隐藏 reviewer 子会话可累积多次审查轮次，每次需带父 autoReview.reviewID
                      metadata: { ...assessment, reviewID: persist.reviewID, source: "tool_call" },
                      output: JSON.stringify(assessment),
                      time: { start: Date.now(), end: Date.now() },
                    },
                  })
                  return
                }
                if (event.type === "tool-error") {
                  // The reviewer has exactly one no-side-effect protocol tool.
                  // A tool-error here means the provider/model attempted a tool
                  // submission that did not become a valid Assessment, so route it
                  // through the same hidden retry as missing or malformed input
                  // instead of treating it as an unrelated provider failure.
                  return yield* new ReviewerRunError({ reason: REVIEWER_DECISION_PROTOCOL_ERROR })
// #227：文本回退也失败时抛协议错误——触发外层 catchIf 的第二次尝试
                }
                // [local-smark] 镜像 processor.ts finish-step：持久化 provider 真实 usage 和 input breakdown。
                // reviewer 不走 SessionProcessor 管道（安全边界：不暴露 prompt 给 chat plugin），
                // 所以必须在此手动处理 finish-step 事件，否则 message.tokens 恒为初始 0 且
                // 无 step-finish part → tokenAccounting 对 reviewer session 算出 input=0、breakdown=null。
                if (event.type === "finish-step") {
                  // persist 在此已被无子会话早退分支收窄为非 undefined，无需重复 guard
                  const usage = Session.getUsage({
                    model,
                    // reviewer 直接消费 AI SDK，需在边界转换缓存和推理明细，不能把它们算作普通输入输出。
                    usage: Usage.from({
                      inputTokens: event.usage.inputTokens,
                      outputTokens: event.usage.outputTokens,
                      totalTokens: event.usage.totalTokens,
                      reasoningTokens: event.usage.outputTokenDetails.reasoningTokens,
                      cacheReadInputTokens: event.usage.inputTokenDetails.cacheReadTokens,
                      cacheWriteInputTokens: event.usage.inputTokenDetails.cacheWriteTokens,
                    }),
                    metadata: event.providerMetadata,
                  })
                  // 就地更新可变 message 引用，使 runReviewerAgent 的最终 updateMessage 持久化真实 tokens/cost
                  persist.message.tokens = usage.tokens
                  persist.message.cost += usage.cost
                  yield* session.updatePart({
                    id: PartID.ascending(),
                    sessionID: persist.sessionID,
                    messageID: persist.messageID,
                    type: "step-finish",
                    reason: event.finishReason,
                    tokens: usage.tokens,
                    cost: usage.cost,
                    inputChars,
                    inputBreakdown,
                  })
                  // [local-smark] 立即落库 message 行：finish-step 是流终止事件，但 runReviewerAgent 的
                  // 最终 updateMessage 在 stream drain 之后才执行。若不在此立即写入，
                  // DB 的 message.tokens 仍为 0，tokenAccounting 的 stepSF && !msgCompleted
                  // 分支会取到 stale 0 而非 stepSF.tokens.input。
                  yield* session.updateMessage(persist.message)
                  return
                }
                if (event.type === "error") {
                  // #214：provider stream 错误必须保留原始形状直到 SessionRetry 分类
                  // #214：此处包装会丢失 APICallError/status/header 细节，将瞬时 socket 故障转为即时 fallback
                  return yield* Effect.fail(event.error)
                }
              }),
            ).pipe(
              Effect.onInterrupt(() =>
                Effect.suspend(() => {
                  // #546：同步标志在 onInterrupt 第一时间置位——ensuring 兜底据此区分 aborted/incomplete。
                  streamInterrupted = true
                  // #497：真实 abort 的 open tool part 闭合为 error+interrupted marker。
                  return safeFinalize(TOOL_ABORTED_ERROR, true)
                }),
              ),
              // #497：Provider failure 的原始 shape 仍交给 SessionRetry；cleanup 失败不能把
              // status/header 等诊断替换成第二个错误，也不能伪造 reviewer 成功结果。
              Effect.tapError(() => safeFinalize(TOOL_INCOMPLETE_ERROR, false)),
              // #546：ensuring 兜底——interrupt/error/success 全部退出路径至少再扫一次
              // （对齐 SessionProcessor 的 Effect.ensuring(cleanup())；幂等由非 open 跳过保证）。
              Effect.ensuring(
                Effect.suspend(() =>
                  safeFinalize(streamInterrupted ? TOOL_ABORTED_ERROR : TOOL_INCOMPLETE_ERROR, streamInterrupted),
                ),
              ),
            )
            // #497：正常 drain 仍可能只有 tool-input-start 而没有合法 tool-call；在协议
            // retry/fallback 接管前先闭合本 attempt，防止每次重试累积 pending Part。
            yield* safeFinalize(TOOL_INCOMPLETE_ERROR, false)

            // #209：流结束后收尾未关闭的 text/reasoning part——provider 可能不发 *-end 事件，避免 part 残留无结束时间
            if (textPart)
              yield* session.updatePart({
                ...textPart,
                time: { start: textPart.time?.start ?? Date.now(), end: Date.now() },
              })
            if (reasoningPart)
              yield* session.updatePart({
                ...reasoningPart,
                time: { start: reasoningPart.time.start, end: Date.now() },
              })
            // #209：模型未调用 permission_review_decision——fail closed，未给出明确 allow 即拒绝
            if (!assessment) {
              const fallback = assessmentFromJsonText(textOutput)
// #227：纯文本回退只在无工具调用时启用——解析失败仍 fail-closed 而非静默放行
              if (fallback) {
                // The text part remains as provider output, while this synthetic
                // no-side-effect tool part preserves the same audit shape as the
                // function-call path. Consumers should read `source` before
                // treating the part as a provider-emitted tool call.
                if (persist) yield* recordJsonFallbackDecision(session, persist, fallback)
                return fallback
              }
              return yield* new ReviewerRunError({ reason: REVIEWER_DECISION_PROTOCOL_ERROR })
            }
            return assessment
          }),
        (abort) => Effect.sync(() => abort.abort()),
// #227：release 中止 AbortController——Effect 取消/超时立即停止 streamText 不再消耗配额
        // #209：release 时中止 AbortController——确保 Effect 取消时 streamText 立即停止，不再消耗 provider 配额
      ).pipe(
        // #214：SessionRetry.retry 封装——hidden reviewer 子代理流复用同一 provider 安全重试策略
        // #214：reviewer 子代理流是审计 transcript，非活跃 SessionProcessor run——重试时不更新父工具 autoReview 状态
        // #214：父工具 autoReview 保持在 reviewing 状态直到最终 allow/deny/fallback 结果确定
        // #214：set 为 Effect.void——reviewer 无独立 UI 状态合约，重试仅影响 provider 调用
        // #214：parse 使用 MessageV2.fromError 保留 APICallError/status/header 细节供分类
        SessionRetry.retry({
          provider: model.providerID,
          parse: (error) => MessageV2.fromError(error, { providerID: model.providerID }),
          set: () => Effect.void,
        }),
      )
    }

    // 用户授权窄400拒绝时同次去参重发一次，不递归；共享已有child message而不写伪失败终态。
    // 协商位于外层tapError/onInterrupt内侧，输出关闭和最终错误仍由原owner处理。
    function runReviewerStreamWithToolChoice(
      messages: readonly ModelMessage[],
      model: Provider.Model,
      persist?: Parameters<typeof runReviewerStream>[2],
    ) {
      const forced = !toolChoiceRejectedProviders.has(model.providerID)
      return runReviewerStream(messages, model, persist, forced).pipe(
        Effect.catchIf((error) => forced && isToolChoiceRejection(error), () => {
          toolChoiceRejectedProviders.add(model.providerID)
          return runReviewerStream(messages, model, persist, false)
        }),
      )
    }

    // #209：标记工具状态为 reviewing——附带 reviewer 子会话 ID 供 UI 导航
    function markToolReviewing(input: PermissionAuto.ReviewInput, reviewerSessionID: SessionID | undefined) {
// #227：reviewing 状态附带 reviewer 子会话 ID——UI 可跳转查看审查过程
      return updateToolAutoReview(input, {
        status: "reviewing",
        ...(reviewerSessionID ? { sessionID: reviewerSessionID } : {}),
      })
    }

    // #209：标记工具审查完成——allowed/denied 状态和 reviewer 评估详情
    function markToolReviewed(input: PermissionAuto.ReviewInput, assessment: Schema.Schema.Type<typeof Assessment>) {
// #227：allowed/denied 终结状态——result 附带完整评估供审计与 UI 展示
      return updateToolAutoReview(input, {
        status: assessment.outcome === "allow" ? "allowed" : "denied",
        result: {
          risk_level: assessment.risk_level,
          user_authorization: assessment.user_authorization,
          rationale: assessment.rationale,
        },
      })
    }
    // #209：标记工具审查失败——timed_out/failed/fallback_user 状态和错误原因
    function markToolReviewFailed(
      input: PermissionAuto.ReviewInput,
      status: "timed_out" | "failed" | "fallback_user" | "aborted",
      reason: string,
    ) {
      return updateToolAutoReview(input, { status, error: reason })
    }

    // #209：统一更新工具 autoReview metadata——合并现有 metadata 与新 patch，保留 reviewID/precheck 等渐进字段
    function updateToolAutoReview(
      input: PermissionAuto.ReviewInput,
      patch: {
        status: "reviewing" | "allowed" | "denied" | "timed_out" | "failed" | "fallback_user" | "aborted"
        sessionID?: SessionID
        error?: string
        result?: {
          risk_level: Schema.Schema.Type<typeof Assessment>["risk_level"]
          user_authorization: Schema.Schema.Type<typeof Assessment>["user_authorization"]
          rationale: string
        }
      },
    ) {
      // 无工具绑定时不写UI标记；捕获绑定以保持异步闭包内的类型收窄。
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
        // #209：保留现有 autoReview metadata——reviewing → allowed/denied 渐进更新不覆盖已写入的 reviewID/precheck
        const metadata = part.state.status === "running" ? (part.state.metadata ?? {}) : {}
        const current =
          metadata?.autoReview && typeof metadata.autoReview === "object" && !Array.isArray(metadata.autoReview)
            ? metadata.autoReview
            : {}
        // onInterrupt 可能在 handleReviewerFailure 写入终态后延迟触发；
        // "aborted" 不应覆盖更具体的终态（timed_out/failed/fallback_user/allowed/denied）。
        if (patch.status === "aborted" && current.status && current.status !== "reviewing") return
        // #531 审核展示写只做一次：优先保留已结构化 input，其次用 ask metadata 中已固定的
        // command（Shell 在 Permission.ask 时已写入），避免 pending 仍写成 { raw }
        // 导致 TUI 整段 reviewing 窗显示 Writing command...。
        const toolInput = reviewDisplayToolInput(part, input.metadata)
        yield* session.updatePart({
          ...part,
          state: {
            status: "running",
            input: toolInput,
            // #209：title 随状态变化——reviewing 显示 precheck level，其余显示具体状态供 UI 区分
            title:
              patch.status === "reviewing" ? `Auto review: ${input.precheck.level}` : `Auto review: ${patch.status}`,
            metadata: {
              ...metadata,
              // #208：metadata 小而稳定——客户端可展示 precheck 交接而不渲染隐藏 reviewer prompt
              autoReview: {
                ...current,
                reviewID: input.reviewID,
                precheck: input.precheck,
                ...patch,
              },
            },
            time: { start: part.state.status === "running" ? part.state.time.start : Date.now() },
          },
        } satisfies ToolPart)
      }).pipe(
        // #208：review 展示是 best-effort——过期工具引用不应将有效 reviewer 决策转为 fail-closed deny
        Effect.catch(() => Effect.void),
        // #264：显示路径 defect 也应被捕获——避免 UI 更新失败降级有效 reviewer 决策
        Effect.catchDefect(() => Effect.void),
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

// #209：渲染 reviewer prompt 为可检查文本——子会话用户消息可见但不可作为授权证据
function renderReviewerPrompt(messages: readonly ModelMessage[]) {
  return messages
    .map((message) =>
      [
        `${message.role}:`,
        typeof message.content === "string" ? message.content : JSON.stringify(message.content, null, 2),
      ].join("\n"),
    )
    .join("\n\n")
}

// #198：判断是否为 reviewer 自身错误——TimedOut 和 RunError 是可预期的运行时错误，其他错误向上传播
// #209：streaming refactor 后错误来源变为 streamText 的 fullStream 事件，但 RunError 仍是唯一可预期包装
function isReviewerError(error: unknown): error is Error {
  return error instanceof ReviewerTimedOut || error instanceof ReviewerRunError
}

function isReviewerDecisionProtocolError(error: unknown) {
  // Only this protocol miss gets one hidden retry. Other ReviewerRunError values
  // include provider tool errors, schema failures, and policy-path loading errors;
  // retrying those would blur operational failures with model formatting repair.
  return error instanceof ReviewerRunError && error.reason === REVIEWER_DECISION_PROTOCOL_ERROR
}
// 协议错误（reviewer 完成但未调用决策工具）和超时都触发重试。
// provider 级 429/503 由 SessionRetry.retry 在每次尝试内处理，不经过此层。
function isReviewerRetryable(error: unknown): boolean {
  return isReviewerDecisionProtocolError(error) || error instanceof ReviewerTimedOut
}

// 仅识别AI SDK原始400与tool_choice报文，其他参数错误不得被重发掩盖。
function isToolChoiceRejection(error: unknown): boolean {
  if (!error || typeof error !== "object") return false
  const withStatus = error as { statusCode?: unknown; responseBody?: unknown }
  return withStatus.statusCode === 400 && /tool[_ ]?choice/i.test(String(withStatus.responseBody ?? ""))
}

// #203：reviewer 启用判定——显式 user 配置优先保留人工审批
// #280：reviewer 只会在 Permission.ask 已经命中 auto action 后被调用；是否进入
// auto review 由权限计算决定，而不是由 agent 名称或工具 metadata 决定。
function reviewerEnabled(permission: ConfigPermissionV1.Info | undefined, _metadata: Readonly<Record<string, unknown>>) {
  if (permission?.approvals_reviewer === "user") return false
  return true
}

// #198：提取错误消息——provider/model 错误在 reason 中暴露用于诊断，但 AutoDeniedError 仍阻止鼓励绕过策略的重试建议
function errorMessage(error: unknown) {
  if (error instanceof Error) {
    // AI SDK APICallError 携带 responseBody/statusCode，但 message 不包含它们。
    // 提取这些字段使 reviewer 失败可诊断。responseBody 是 provider 的错误响应
    //（非请求体），截断 300 字符，不含用户凭据。
    const withResponse = error as Error & { responseBody?: string; statusCode?: number }
    if (withResponse.responseBody) {
      return `${error.message}${withResponse.statusCode ? ` (${withResponse.statusCode})` : ""}: ${withResponse.responseBody.slice(0, 300)}`
    }
    return error.message
  }
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string")
    return error.message
  // 非 Error 对象（如 provider 结构化错误）可能无 message 字符串；
  // JSON.stringify 比 String(error)（"[object Object]"）提供更多诊断信息。
  // ?? 兜底 JSON.stringify(undefined) 返回 undefined 的情况；try-catch 防循环引用。
  if (error && typeof error === "object") {
    try {
      return JSON.stringify(error) ?? String(error)
    } catch {
      return String(error)
    }
  }
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

// #235：suspend 延迟 Config/Provider 层实例化——保留 Session↔Permission 类型导入循环边界
export const defaultLayer = Layer.suspend(() =>
  layer.pipe(
    // #261：Reviewer 复用主聊天路径的 provider 兼容 hook——Plugin 必须随 config/provider 进默认 wiring，
    // 否则隐藏 reviewer 流在默认层下缺 Plugin.Service 依赖
    Layer.provide(LayerNode.compile(Plugin.node)),
    Layer.provide(LayerNode.compile(Config.node)),
    Layer.provide(LayerNode.compile(Provider.node)),
  ),
)

// #203：Permission.defaultLayer 消费此 bundled reviewer 层来构建 Permission.Service。
// #203：Layer.suspend 保留历史循环边界：Session 导入 Permission 类型，故 Session.defaultLayer
// #203：不能在本模块初始化期间被解引用
export const defaultLayerWithSession = Layer.suspend(() => defaultLayer.pipe(Layer.provide(LayerNode.compile(Session.node))))

function assessmentFromJsonText(text: string) {
  const trimmed = text.trim()
  if (!trimmed) return
  // 先尝试整体解析（覆盖模型直接输出纯 JSON 的正常路径）
  const direct = parseAssessmentJson(trimmed)
  if (direct) return direct
  // 模型可能在 JSON 前后附加 prose 或 markdown fence。reviewer 模型是可信系统组件
  //（非用户输入），Schema 校验和 invalidReviewContract 仍保证结构与语义安全。
  // 提取仅扩大解析范围，不削弱 schema 或策略守卫。
  const extracted = extractFirstJsonObject(trimmed)
  if (extracted) return parseAssessmentJson(extracted)
}

function parseAssessmentJson(text: string) {
  try {
    return Schema.decodeUnknownSync(Assessment)(JSON.parse(text))
  } catch {
    return
  }
}

// 用括号深度扫描提取第一个完整 JSON 对象，避免正则对嵌套结构的误匹配。
// 处理字符串内的花括号和转义引号，防止误截断。
function extractFirstJsonObject(text: string): string | undefined {
  const start = text.indexOf("{")
  if (start < 0) return
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === "\\") escaped = true
      else if (ch === '"') inString = false
    } else if (ch === '"') inString = true
    else if (ch === "{") depth++
    else if (ch === "}") {
      depth--
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return
}

function assessmentFromUnknown(input: unknown) {
// #227：畸形工具参数与缺失协议输出同等待遇——不绕过修复格式的第二次尝试
  try {
    // Treat malformed tool/function arguments the same as missing protocol
    // output: they are not a valid permission decision, but they also should not
    // bypass the one retry that repairs reviewer submission format.
    return Schema.decodeUnknownSync(Assessment)(input)
  } catch {
    return
  }
}

// map∪durable闭合同一message的协议tool；按message精确读取，避免历史窗口截断漏掉未登记Part。
// getPart逐个重读并跳过终态，尊重completed winner；cleanup失败只记录，不产生授权结果。
function closeOpenReviewerTools(
  session: Session.Interface,
  input: {
    sessionID: SessionID
    messageID: MessageID
    knownPartIDs?: Iterable<PartID>
    error: string
    interrupted: boolean
  },
) {
  return Effect.gen(function* () {
    const end = Date.now()
    const known = new Set(input.knownPartIDs ?? [])
    const durable = yield* MessageV2.parts(input.messageID).pipe(
      Effect.catchDefect((cause) => Effect.logWarning("reviewer durable tool scan failed", { cause, sessionID: input.sessionID, messageID: input.messageID }).pipe(Effect.as([]))),
    )
    // durable 只补 tool 类型——text/reasoning 的收尾走既有 drain 路径，不在闭合范围
    for (const part of durable) {
      if (part.type === "tool") known.add(part.id)
    }
    for (const partID of known) {
      // #497：重读而非读缓存——退出时刻的 durable state 才是唯一真相
      const part = yield* session.getPart({
        sessionID: input.sessionID,
        messageID: input.messageID,
        partID,
      })
      if (!part || part.type !== "tool") continue
      if (part.state.status !== "pending" && part.state.status !== "running") continue
      const start = part.state.status === "running" ? part.state.time.start : end
      const metadata = part.state.status === "running" ? part.state.metadata : undefined
      yield* session.updatePart({
        ...part,
        state: {
          status: "error",
          input: part.state.input,
          error: input.error,
          // #497：interrupted marker 属于真实 user/timeout abort；普通 incomplete stream
          // 保持原错误语义，不能让 Provider replay 把协议失败误判成用户取消。
          metadata: input.interrupted
            ? { ...metadata, interrupted: true, executionElapsedMs: Math.floor(end - start) }
            : metadata,
          time: { start, end },
        },
      } satisfies ToolPart)
    }
  })
}

function hideReviewerProtocolAttempt(sessions: Session.Interface, sessionID: SessionID, requestID: MessageID): Effect.Effect<void, ReviewerRunError, never> {
// #227：隐藏请求与畸形 assistant 回复——重试后只保留最终可见尝试
  return Effect.gen(function* () {
    const hidden = { time: Date.now(), reason: PROTOCOL_RETRY_HIDDEN_REASON as typeof PROTOCOL_RETRY_HIDDEN_REASON }
// #227：hidden 元数据独立于消息内容——重试后消息仍可作结构压缩锚点
    // #208: use sessions.messages instead of MessageV2.get to avoid Database.Service leak
    const messages = yield* sessions.messages({ sessionID, limit: 100 })
    const request = messages.find((m) => m.info.id === requestID)
// #227：按 requestID 定位 synthetic 请求——消息缓存行可能因分页错位
    // Hide the synthetic reviewer request together with its malformed assistant
    // reply. The prompt is regenerated for the retry, and keeping only the final
    // visible attempt prevents users from reading a malformed JSON/prose answer
    // as an approved decision before the protocol repair completes.
    if (request) {
      yield* sessions.updateMessage({ ...request.info, hidden })
    }
    const assistant = messages.find((m) => m.info.role === "assistant" && m.info.parentID === requestID)
    if (assistant?.info.role === "assistant") {
      yield* sessions.updateMessage({ ...assistant.info, hidden })
    }
  }).pipe(Effect.ignore)
}

function recordJsonFallbackDecision(
// #227：合成 tool part 模拟函数调用路径的审计形状——source 字段标识回退来源
  sessions: Session.Interface,
  persist: { sessionID: SessionID; messageID: MessageID; reviewID: string },
  assessment: Schema.Schema.Type<typeof Assessment>,
) {
  return Effect.gen(function* () {
    yield* sessions.updatePart({
      id: PartID.ascending(),
      sessionID: persist.sessionID,
      messageID: persist.messageID,
      type: "tool",
      // This synthetic call id cannot collide with provider tool-call ids because
      // it is namespaced by the stable review id and is only created after the
      // stream ended without any `permission_review_decision` function call.
      callID: `json_fallback_${persist.reviewID}`,
// #227：callID 用 reviewID 命名空间——不可能与 provider 真实 tool-call id 冲突
      tool: "permission_review_decision",
      state: {
        status: "completed",
        input: assessment,
        title: assessment.outcome === "allow" ? "Permission review allowed" : "Permission review denied",
        metadata: { ...assessment, reviewID: persist.reviewID, source: JSON_FALLBACK_SOURCE },
        output: JSON.stringify(assessment),
        time: { start: Date.now(), end: Date.now() },
      },
    } satisfies ToolPart)
  })
}

// #531：仅 { raw } 是历史 pending 提升形状；任意其它自有键表示已有结构化工具参数。
// 不得把空 {} 当成 structured，否则会挡住 metadata.command 回填。
// 判定只看自有键形状，不解析 raw JSON，避免第二套参数源。
// 与 TUI equal-v0 enrich 共用同一 raw-only 语义，防止 durable/live 对“有无 command”判断分叉。
function isRawOnlyToolInput(input: Record<string, unknown>) {
  const keys = Object.keys(input)
  return keys.length === 1 && keys[0] === "raw" && typeof input.raw === "string"
}

// #531：structured = 非空且非 raw-only；tool-call 写入的 command/filePath 等均属此类。
// 空对象不算 structured：pending 初值 {} 必须继续落到 metadata.command 分支。
function isStructuredToolInput(input: Record<string, unknown>) {
  return Object.keys(input).length > 0 && !isRawOnlyToolInput(input)
}

// #531：审核展示用 input 的唯一决策函数：一次选择、一次写入。
// 优先级：已有 structured → ask metadata.command → pending.raw → 原值。
// 该顺序保证“参数已固定仍 Writing command...”在 pending-at-review 路径上可被单一 owner 修复。
function reviewDisplayToolInput(part: ToolPart, askMetadata: Readonly<Record<string, unknown>>) {
  const current = part.state.input as Record<string, unknown>
  // tool-call 已写入的 structured input 优先，禁止用 { raw } 覆盖（INV-02）。
  if (isStructuredToolInput(current)) return current
  // Shell ask 在 Permission.ask 时已把固定 command 写入 metadata；pending 提升不得
  // 只写 { raw }，否则 TUI 在 reviewing 窗缺少 input.command 会显示 Writing command...
  // 单次 write 即完成：metadata.command 在 selection 时已可用，不做第二成功写。
  // description 不在 Shell ask metadata 合同内，不在此伪造。
  const command = askMetadata.command
  if (typeof command === "string" && command.length > 0) return { command }
  // 无 command 证据时的窄 residual：仅 pending 才允许 raw 形状展示。
  if (part.state.status === "pending") return { raw: part.state.raw }
  return current
}

// #198：node deps 包含 Config/Provider/Session——reviewer layer yield 三个 service，Session 不导入 Permission 故无循环依赖
// #206：deps 补 Database.node——layer 捕获 db 供 page 溢出探测，仍不泄漏进 review 类型
// #250：reviewer layer 现在 yield Auth.Service 判定 OpenAI OAuth/Codex instructions 路径——
// node deps 显式加入 Auth.node，LayerNode 依赖图在编译期保持完整
// #261：Plugin.Service 加入 layer 依赖——node deps 同步加 Plugin.node，保持 LayerNode 编译期依赖图完整
export const node = LayerNode.make({ service: Service, layer: layer, deps: [Config.node, Auth.node, Provider.node, Session.node, Database.node, Plugin.node] })

export * as PermissionReviewer from "./service"
