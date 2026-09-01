import { Config } from "@/config/config"
import { Auth } from "@/auth"
import { Plugin } from "@/plugin"
import { Provider } from "@/provider/provider"
import { buildBaseProviderMap, isOpenaiOauthProvider } from "@/provider/alias"
import { ProviderTransform } from "@/provider/transform"
import { Session } from "@/session/session"
import { MessageV2 } from "@/session/message-v2"
import { SessionRetry } from "@/session/retry"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { ModelID, ProviderID } from "@/provider/schema"
import { toJsonSchema } from "@/util/effect-zod"
import { jsonSchema, streamText, tool, wrapLanguageModel, type ModelMessage } from "ai"
import { Context, Effect, Exit, Layer, Option, Schema, Semaphore } from "effect"
import * as Stream from "effect/Stream"
import { mergeDeep } from "remeda"
import * as Log from "@opencode-ai/core/util/log"
import { PermissionReviewerPrompt } from "./prompt"
import { Assessment, ReviewerRequest } from "./schema"
import { PermissionReviewerTranscript } from "./transcript"
import type { PermissionAuto } from "../auto"

// 与 SessionProcessor.TOOL_ABORTED_ERROR 字面量对齐。
// 故意不 import processor：reviewer 安全边界禁止并入主会话管道，只共享终态文案合同。
const TOOL_ABORTED_ERROR = "Tool execution aborted"
// incomplete 与 aborted 必须区分：Provider replay 不能把协议未完成误判成用户取消。
// 两常量是跨模块合同字符串，改字面量必须同步 processor 与本文件测试期望。
const TOOL_INCOMPLETE_ERROR = "Tool execution did not complete before stream ended"
const log = Log.create({ service: "permission.reviewer" })

export class ReviewerDisabled extends Schema.TaggedErrorClass<ReviewerDisabled>()("PermissionReviewerDisabled", {}) {
  override get message() {
    return "auto reviewer is disabled"
  }
}

export class ReviewerFallbackToUser extends Schema.TaggedErrorClass<ReviewerFallbackToUser>()(
  "PermissionReviewerFallbackToUser",
  { reason: Schema.String },
) {
  override get message() {
    return this.reason
  }
}

export class ReviewerTimedOut extends Schema.TaggedErrorClass<ReviewerTimedOut>()("PermissionReviewerTimedOut", {}) {
  override get message() {
    return "auto reviewer timed out"
  }
}

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

const REVIEWER_MESSAGE_FETCH_LIMIT = 120
// JSON fallback is a runtime compatibility boundary, not a prompt contract: the
// reviewer prompt still asks providers to submit `permission_review_decision`,
// but some tool-capable providers occasionally return the same Assessment as a
// plain JSON final answer. Accept only a complete schema-valid JSON object and
// mark the persisted audit part with this source so later UI/export code can
// distinguish fallback acceptance from an actual function/tool call.
const JSON_FALLBACK_SOURCE = "json_fallback"
// This exact reason is the retry discriminator. Provider errors and policy
// denials must not be retried through this path; only a completed reviewer turn
// that produced neither a decision tool call nor valid JSON fallback is hidden
// and retried with a protocol nudge.
const REVIEWER_DECISION_PROTOCOL_ERROR = "reviewer did not call permission_review_decision"
// Keep this string aligned with MessageV2.Hidden. It names the audit workflow
// that owns these hidden child-session turns and prevents future hidden-message
// consumers from confusing protocol retry cleanup with undo or session repair.
const PROTOCOL_RETRY_HIDDEN_REASON = "permission-reviewer-protocol-retry"
const PROTOCOL_RETRY_USER_ITEM = {
  type: "text" as const,
  // [local-smark] R-REQ-4 avoid-xxx 防御纵深 nudge：重试请求不含失败回合（重建
  // 全新 [system, user] 上下文），旧文案的 "the previous response" 对模型不可见，
  // 且未阻断实测漂移形态（反问、自认无法执行）。新文案自包含、逐项 avoid，
  // 并显式给出裸 JSON 逃生口——生产 DB 证据表明漂移场景下 json_fallback 是
  // 实测可救回路径，此设计取代旧「不宣传 JSON fallback」取舍。
  text: "Protocol retry: your previous reply was rejected because it did not submit the decision. Avoid prose, questions, explanations of inability, and offers to execute the action — none of these produce a decision. Reassess the same evidence and reply with exactly one permission_review_decision call. If you believe tool calls are unavailable, reply with ONLY the JSON object {\"risk_level\",\"user_authorization\",\"outcome\",\"rationale\"} as your entire message.",
}

const mergeOptions = (target: Record<string, any>, source: Record<string, any> | undefined): Record<string, any> =>
  mergeDeep(target, source ?? {}) as Record<string, any>

// The reviewer layer is provider-backed but intentionally receives only a bounded
// transcript projection plus the planned action JSON. It never reuses the main
// agent's model messages, tools, or scratchpad as reviewer context.
export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const auth = yield* Auth.Service
    const plugin = yield* Plugin.Service
    const provider = yield* Provider.Service
    const sessions = yield* Session.Service
    const reviewerSessionLocks = new Map<SessionID, Semaphore.Semaphore>()
    // [local-smark] 已知拒绝 tool_choice 的 provider 集合（进程内记忆）：首次到达
    // 400 参数拒绝后记录，后续评审直接去参发送，避免每次评审都重复支付一次
    // 400 轮往返；不持久化——能力探测的授权粒度是「重发一次」，非跨进程契约。
    const toolChoiceRejectedProviders = new Set<ProviderID>()

    const review: Interface["review"] = (input) =>
      Effect.gen(function* () {
        const cfg = yield* config.get()
        const permission = cfg.permission
        if (!reviewerEnabled(permission, input.metadata)) return yield* new ReviewerDisabled()
        const autoReview = permission?.auto_review
        const fallbackToUser = autoReview?.fallback !== "deny"

        const run = Effect.gen(function* () {
          const request = new ReviewerRequest({
            permission: input.permission,
            patterns: [...input.patterns],
            metadata: { ...input.metadata },
            precheck: input.precheck,
          })
          const model = autoReview?.model
            ? // User-specified reviewer models use the same provider/model parser as
              // normal agent config so aliases and provider validation stay in one
              // place. A bad model follows the same reviewer-failure fallback as
              // provider/runtime errors instead of inventing a separate config path.
              yield* provider.getModel(
                Provider.parseModel(autoReview.model).providerID,
                Provider.parseModel(autoReview.model).modelID,
              )
            : yield* resolveImplicitReviewerModel(input.sessionID)
          const reviewerSession = input.sessionID ? yield* getReviewerSession(input.sessionID, model) : undefined
          yield* markToolReviewing(input, reviewerSession?.id)
          const tenantPolicy = yield* loadTenantPolicy(autoReview)
          // Transcript collection is best-effort and bounded twice: fetch a wider
          // recent window than the final reviewer prompt, then let transcript
          // selection preserve user anchors and cap entries/chars. This avoids
          // walking very old sessions on the permission path while still keeping
          // substantially more authorization context than the final prompt size.
          const transcript = input.sessionID
            ? yield* MessageV2.page({ sessionID: input.sessionID, limit: REVIEWER_MESSAGE_FETCH_LIMIT }).pipe(
                Effect.map((page) => {
                  const transcript = PermissionReviewerTranscript.fromMessages(page.items)
                  return { ...transcript, truncated: transcript.truncated || page.more }
                }),
                Effect.catch(() => Effect.succeed({ entries: [], truncated: false, entryTruncated: false })),
              )
            : { entries: [], truncated: false, entryTruncated: false }
          const system = PermissionReviewerPrompt.buildSystemPrompt(tenantPolicy)
          const userItems = PermissionReviewerPrompt.buildUserPromptItems(transcript, request, input.precheck.reason)
          const messages = buildMessages({ system, userItems })
          function runReviewerAttempt(messages: readonly ModelMessage[], hideProtocolFailure: boolean) {
            return Effect.gen(function* () {
              const reviewerUser = reviewerSession
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
                reviewID: input.reviewID,
                parentID: reviewerUser?.id,
                messages,
              }).pipe(
                Effect.tapError((error) => {
                  if (!hideProtocolFailure || !reviewerSession || !reviewerUser || !isReviewerDecisionProtocolError(error)) {
                    return Effect.void
                  }
                  return hideReviewerProtocolAttempt(sessions, reviewerSession.id, reviewerUser.id)
                }),
              )
            })
          }
          // [local-smark] reviewer 重试架构：per-attempt 超时 + 最多 3 次尝试
          // timeout_ms 是每次尝试的超时（非总超时），总最差时间为 timeout_ms * MAX_REVIEWER_ATTEMPTS。
          // 旧代码的 pipe 顺序是 catchIf → timeoutOrElse（超时在外层），导致超时产生的
          // ReviewerTimedOut 在 catchIf 之外，无法被捕获重试。修复后 timeoutOrElse 在
          // catchIf 内层，超时可被 catchIf 捕获并触发重试。
          const MAX_REVIEWER_ATTEMPTS = 3
          const perAttemptTimeout = autoReview?.timeout_ms ?? 90_000

          function reviewerRetry(
            attemptNum: number,
            currentMessages: readonly ModelMessage[],
            hideOnProtocolError: boolean,
          ): Effect.Effect<Schema.Schema.Type<typeof Assessment>, unknown> {
            return runReviewerAttempt(currentMessages, hideOnProtocolError).pipe(
              // per-attempt 超时：每次尝试独立计时。超时产生 ReviewerTimedOut，
              // 被下方 catchIf 捕获后触发重试，而非直接失败。
              Effect.timeoutOrElse({
                duration: `${perAttemptTimeout} millis`,
                orElse: () => Effect.fail(new ReviewerTimedOut()),
              }),
              // catchIf 在 timeoutOrElse 外层：能捕获 ReviewerTimedOut 进行重试。
              // 旧代码顺序相反，超时绕过了重试。
              Effect.catchIf(isReviewerRetryable, (error) => {
                if (attemptNum >= MAX_REVIEWER_ATTEMPTS - 1) return Effect.fail(error)
                // 协议错误：附加 protocol nudge 修复提交格式；超时：保持原 prompt
                const nextMessages = isReviewerDecisionProtocolError(error)
                  ? buildMessages({ system, userItems: [...userItems, PROTOCOL_RETRY_USER_ITEM] })
                  : currentMessages
                return reviewerRetry(attemptNum + 1, nextMessages, false)
              }),
            )
          }

          const assessment = yield* reviewerRetry(0, messages, true).pipe(
            Effect.mapError((error) =>
              isReviewerError(error) ? error : new ReviewerRunError({ reason: errorMessage(error) }),
            ),
          )
          yield* markToolReviewed(input, assessment)

          return {
            action: assessment.outcome,
            reason: assessment.rationale,
            reviewID: input.reviewID,
            risk_level: assessment.risk_level,
            user_authorization: assessment.user_authorization,
          } satisfies PermissionAuto.ReviewDecision
        })

        const handleReviewerFailure = (error: unknown) =>
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
              // Parent tool metadata is audit/UI state only. If that write fails
              // while handling an already-failed reviewer, it must not create a
              // second failure mode that bypasses ask/fallback=deny resolution.
              Effect.catch(() => Effect.void),
              Effect.catchDefect(() => Effect.void),
            )
            // Reviewer failures reach this point only after the stream-level retry
            // policy has completed. Converting the default case to the explicit
            // fallback signal lets PermissionAuto reuse the ordinary ask path
            // without treating infrastructure errors as reviewer policy denials.
            if (fallbackToUser && !(error instanceof ReviewerDisabled)) {
              return yield* new ReviewerFallbackToUser({ reason: errorMessage(error) })
            }
            return yield* Effect.fail(isReviewerError(error) ? error : new ReviewerRunError({ reason: errorMessage(error) }))
          })

        return yield* run.pipe(
          // Defects from provider SDKs or persistence callbacks should not bypass
          // the permission boundary. Convert them to the same post-retry failure
          // channel so fallback=user can ask and fallback=deny can fail closed.
          Effect.catchDefect((defect) => Effect.fail(defect)),
          Effect.catch(handleReviewerFailure),
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
        // sessions.get 和 findMessage 是 best-effort：如果 session 不存在或
        // message store 不可用，不能让 reviewer 直接不可用，应回退到 defaultModel。
        const exit = yield* Effect.exit(sessions.get(sessionID))
        if (Exit.isSuccess(exit)) {
          const session = exit.value
          if (session.model) {
            return {
              providerID: session.model.providerID,
              modelID: session.model.id,
            }
          }
        }
        // 旧 session 或 projector 未写入 model 时，用最近 user message 的 model
        // role/model 都属于 HotInfo；reviewer fallback 扫描不能因为一条权限请求展开整段历史工具输出。
        // 仅最终匹配 Message 被 hydrate，现有 best-effort error fallback 仍只处理真实读取失败。
        const match = yield* sessions
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
    function resolveModelWithFallback(candidate: { providerID: ProviderID; modelID: ModelID }) {
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

    function getReviewerSession(parentID: SessionID, model: Provider.Model) {
      return reviewerSessionLock(parentID).withPermits(1)(
        Effect.gen(function* () {
          const existing = (yield* sessions.children(parentID)).find((item) => item.agent === "permission-reviewer")
          if (existing) return existing
          // A single child session per parent mirrors Codex's reusable guardian
          // trunk: later reviews append new request/decision turns instead of
          // creating detached one-off records, enabling future transcript deltas by
          // child session id without changing the permission API again.
          return yield* sessions.create({
            parentID,
            title: "Auto permission review (@permission-reviewer subagent)",
            agent: "permission-reviewer",
            model: { providerID: model.providerID, id: model.id },
          })
        }),
      )
    }

    function reviewerSessionLock(parentID: SessionID) {
      const existing = reviewerSessionLocks.get(parentID)
      if (existing) return existing
      // Child-session creation is read-then-create because Session.Service does
      // not expose an atomic get-or-create child primitive. A per-parent lock
      // keeps concurrent tool reviews in one reusable reviewer transcript.
      const next = Semaphore.makeUnsafe(1)
      reviewerSessionLocks.set(parentID, next)
      return next
    }

    function recordReviewerRequest(input: { session: Session.Info; model: Provider.Model; reviewID: string; text: string }) {
      return Effect.gen(function* () {
        const message = yield* sessions.updateMessage({
          id: MessageID.ascending(),
          role: "user",
          sessionID: input.session.id,
          time: { created: Date.now() },
          agent: "permission-reviewer",
          model: { providerID: input.model.providerID, modelID: input.model.id },
        } satisfies MessageV2.User)
        yield* sessions.updatePart({
          id: PartID.ascending(),
          sessionID: input.session.id,
          messageID: message.id,
          type: "text",
          // This visible child-session message is the audit-friendly reviewer
          // request cell. It mirrors the exact bounded system/user prompt sent to
          // the reviewer model so the hidden child agent feels like a normal
          // subagent run instead of an opaque audit summary. The metadata marker
          // keeps this generated protocol cell out of future authorization
          // evidence if reviewer child transcripts are ever projected again.
          // `reviewID` is the stable join key from the parent tool's autoReview
          // metadata to this visible protocol prompt. Keep it in metadata rather
          // than prompt text so audit/export code can navigate without parsing a
          // security-sensitive synthetic prompt body.
          metadata: { permissionReviewerRequest: true, reviewID: input.reviewID },
          text: input.text,
        } satisfies MessageV2.TextPart)
        return message
      })
    }

    function runReviewerAgent(input: {
      session: Session.Info | undefined
      model: Provider.Model
      reviewID: string
      parentID: MessageID | undefined
      messages: readonly ModelMessage[]
    }) {
      const session = input.session
      const parentID = input.parentID
      if (!session || !parentID) return runReviewerStreamWithToolChoice(input.messages, input.model)
      return Effect.gen(function* () {
        const message: MessageV2.Assistant = {
          id: MessageID.ascending(),
          parentID,
          role: "assistant",
          mode: "permission-reviewer",
          agent: "permission-reviewer",
          path: { cwd: session.directory, root: session.directory },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: input.model.id,
          providerID: input.model.providerID,
          sessionID: session.id,
          time: { created: Date.now() },
        }
        yield* sessions.updateMessage(message)
        // INV-02：message 标 completed 前必须先收同 message 下 open tool，避免 Aborted+pending 半写。
        // 外层 handler 无 toolParts map：依赖 closeOpenReviewerTools 的 durable 补扫 + stream ensuring 已跑路径。
        // 首次 finalize 写失败时，此处第二次 close 是共终态的关键重试点（与生产半写同形）。
        const closeMessageTools = (error: string, interrupted: boolean) =>
          closeOpenReviewerTools(sessions, {
            sessionID: session.id,
            messageID: message.id,
            error,
            interrupted,
          }).pipe(
            Effect.catch((cause) =>
              Effect.sync(() =>
                log.warn("reviewer tool finalize failed", {
                  sessionID: session.id,
                  messageID: message.id,
                  error: String(cause),
                }),
              ),
            ),
            Effect.catchDefect((cause) =>
              Effect.sync(() =>
                log.warn("reviewer tool finalize defect", {
                  sessionID: session.id,
                  messageID: message.id,
                  error: String(cause),
                }),
              ),
            ),
          )
        const assessment = yield* runReviewerStreamWithToolChoice(input.messages, input.model, {
          sessionID: session.id,
          messageID: message.id,
          reviewID: input.reviewID,
          // 传入可变 message 引用，使 finish-step handler 能就地更新 tokens/cost
          message,
        }).pipe(
          Effect.tapError((error) =>
            Effect.gen(function* () {
              yield* closeMessageTools(TOOL_INCOMPLETE_ERROR, false)
              message.error = MessageV2.fromError(error, { providerID: input.model.providerID })
              message.time.completed = Date.now()
              yield* sessions.updateMessage(message)
            }),
          ),
          // 超时中断不会触发 tapError（中断不是 failure）；先闭 tool 再写 message 终态。
          // 顺序固定：tool → message；颠倒会重现库内 Aborted message + pending tool。
          Effect.onInterrupt(() =>
            Effect.gen(function* () {
              yield* closeMessageTools(TOOL_ABORTED_ERROR, true)
              if (message.time.completed) return
              message.error ??= MessageV2.fromError(
                new DOMException("Aborted", "AbortError"),
                { providerID: input.model.providerID, aborted: true },
              )
              message.time.completed = Date.now()
              yield* sessions.updateMessage(message)
            }).pipe(Effect.catch(() => Effect.void), Effect.catchDefect(() => Effect.void)),
          ),
        )
        message.finish = "tool-calls"
        message.time.completed = Date.now()
        yield* sessions.updateMessage(message)
        return assessment
      })
    }

    function runReviewerStream(
      messages: readonly ModelMessage[],
      model: Provider.Model,
      persist?: { sessionID: SessionID; messageID: MessageID; reviewID: string; message: MessageV2.Assistant },
      forcedToolChoice?: boolean,
    ) {
      return Effect.acquireUseRelease(
        Effect.sync(() => new AbortController()),
        (abort) =>
          Effect.gen(function* () {
            const [language, providerInfo, cfg, authInfo] = yield* Effect.all(
              [
                provider.getLanguage(model),
                provider.getProvider(model.providerID),
                config.get(),
                auth.get(model.providerID),
              ],
              { concurrency: "unbounded" },
            )
            const sessionID = persist?.sessionID ?? "permission-reviewer"
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
            // 提取 tool 定义常量，使 tool() 和 toolsText 共用同一 schema 序列化，
            // 避免 toJsonSchema(Assessment) 被调用两次产生不一致的序列化结果
            const assessmentSchema = toJsonSchema(Assessment)
            const toolDescription = "Submit the structured allow/deny decision for this permission review."
            // 计算 /context 面板所需的 per-component 字符 breakdown。reviewer 不走
            // session.prompt 的 pre-stream estimate 路径，所以在此直接按字符占比
            // 计算并附到 step-finish part，使 tokenAccounting 的 breakdown 非 null。
            // 公式与 prompt.ts:2283 一致：inputChars = [system, rawMessages, tools].join("\n").length
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
            // Reviewer requests intentionally stay outside the main SessionProcessor
            // pipeline, but provider compatibility still lives in the existing chat
            // hooks: Codex clears unsupported output caps there, GitHub Copilot
            // disables incompatible tool streaming there, and provider plugins may
            // add transport headers there. The synthetic message below satisfies the
            // hook shape without exposing reviewer prompt text, transcript evidence,
            // or planned tool arguments as plugin input; those remain inside the
            // bounded reviewer prompt because they are part of the permission
            // boundary, not general chat-extension data. The message id is also
            // deliberately fresh instead of a persisted child-session message id:
            // provider hooks may use the normal chat contract shape, but they must
            // not be handed a stable pointer that lets a general chat plugin fetch
            // or reinterpret the hidden reviewer prompt as user-authored context.
            const hookSessionID = persist?.sessionID ?? SessionID.descending()
            const hookMessage = {
              id: MessageID.ascending(),
              sessionID: hookSessionID,
              role: "user",
              time: { created: Date.now() },
              agent: "permission-reviewer",
              model: { providerID: model.providerID, modelID: model.id },
            } satisfies MessageV2.User
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
            const result = streamText({
              model: wrapLanguageModel({
                model: language,
                middleware: [
                  {
                    specificationVersion: "v3" as const,
                    async transformParams(args) {
                      if (args.type === "stream") {
                        // Match normal SessionPrompt requests: provider adapters
                        // expect opencode's message normalization before seeing
                        // reasoning/tool-call payloads.
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
                  inputSchema: jsonSchema(assessmentSchema as Parameters<typeof jsonSchema>[0]),
                  execute: async (assessment) => ({
                    title: assessment.outcome === "allow" ? "Permission review allowed" : "Permission review denied",
                    metadata: assessment,
                    output: JSON.stringify(assessment),
                  }),
                }),
              },
              // [local-smark] INV-02：仿照 session/prompt.ts:3194 的 structured-output
              // 先例，评审请求在 API 层强制决策工具提交，排除 prompt-only 强制在
              // 长 transcript 下观测到的 prose 漂移失败尾部；已知拒绝该参数的
              // provider 由 runReviewerStreamWithToolChoice 的兼容重发降级。
              toolChoice: forcedToolChoice ? ("required" as const) : undefined,
              maxRetries: 0,
              providerOptions: ProviderTransform.providerOptions(model, params.options),
              maxOutputTokens: params.maxOutputTokens,
              headers: headers.headers,
              abortSignal: abort.signal,
            })
            let assessment: Schema.Schema.Type<typeof Assessment> | undefined
            let textPart: MessageV2.TextPart | undefined
            let textOutput = ""
            let reasoningPart: MessageV2.ReasoningPart | undefined
            // Map 只表达 attempt 对 Part identity 的 ownership，不缓存可变 state；
            // durable state 的单一真相留在 Session.Service，避免发布窗口产生双重 winner。
            const toolParts = new Map<string, PartID>()
            const toolInput = new Map<string, string>()
            // 中断路径优先 aborted 文案；ensuring 复用该标志避免二次闭合写成 incomplete。
            // 标志必须在 onInterrupt 内同步置位：ensuring 与 onInterrupt 的相对顺序不能假定。
            let streamInterrupted = false

            const finalizeOpenToolParts = Effect.fnUntraced(function* (error: string, interrupted: boolean) {
              if (!persist) return
              // map ∪ durable：内存 ownership 加速；SQLite/message 真相兜底漏登记 part。
              // 幂等：已 error/completed 的 part 在 getPart 后跳过，双跑 ensuring/onInterrupt 安全。
              yield* closeOpenReviewerTools(sessions, {
                sessionID: persist.sessionID,
                messageID: persist.messageID,
                knownPartIDs: toolParts.values(),
                error,
                interrupted,
              })
            })

            // safeFinalize：cleanup 失败可观测，但不升级为第二个业务错误、不伪造决策成功。
            // catch + catchDefect 都要盖：写失败可能是 typed error，测试夹具也用 throw defect 模拟。
            const safeFinalize = (error: string, interrupted: boolean) =>
              finalizeOpenToolParts(error, interrupted).pipe(
                Effect.catch((cause) =>
                  Effect.sync(() =>
                    log.warn("reviewer stream tool finalize failed", {
                      sessionID: persist?.sessionID,
                      messageID: persist?.messageID,
                      error: String(cause),
                    }),
                  ),
                ),
                Effect.catchDefect((cause) =>
                  Effect.sync(() =>
                    log.warn("reviewer stream tool finalize defect", {
                      sessionID: persist?.sessionID,
                      messageID: persist?.messageID,
                      error: String(cause),
                    }),
                  ),
                ),
              )

            yield* Stream.runForEach(
              Stream.fromAsyncIterable(result.fullStream, (error) => error),
              Effect.fnUntraced(function* (event) {
                if (!persist) {
                  if (event.type === "text-delta") {
                    textOutput += event.text
                  }
                  if (event.type === "tool-call" && event.toolName === "permission_review_decision") {
                    assessment = assessmentFromUnknown(event.input)
                  }
                  // [local-smark] NF-1：非 persist 分支同样必须以原始 shape 传播
                  // provider error 事件，否则 400 等错误被吞成「drain 无 assessment」
                  // 协议错误盲重试 3 次，且 tool_choice 兼容重发在该 seam 结构
                  // 不可达——与 persist 分支下方的同款处理语义对齐。
                  if (event.type === "error") return yield* Effect.fail(event.error)
                  return
                }
                if (event.type === "reasoning-start") {
                  reasoningPart = yield* sessions.updatePart({
                    id: PartID.ascending(),
                    sessionID: persist.sessionID,
                    messageID: persist.messageID,
                    type: "reasoning",
                    text: "",
                    time: { start: Date.now() },
                    metadata: event.providerMetadata,
                  } satisfies MessageV2.ReasoningPart)
                  return
                }
                if (event.type === "reasoning-delta" && reasoningPart) {
                  reasoningPart.text += event.text
                  if (event.providerMetadata) reasoningPart.metadata = event.providerMetadata
                  yield* sessions.updatePart(reasoningPart)
                  return
                }
                if (event.type === "reasoning-end" && reasoningPart) {
                  reasoningPart.time = { ...reasoningPart.time, end: Date.now() }
                  if (event.providerMetadata) reasoningPart.metadata = event.providerMetadata
                  yield* sessions.updatePart(reasoningPart)
                  reasoningPart = undefined
                  return
                }
                if (event.type === "text-start") {
                  textPart = yield* sessions.updatePart({
                    id: PartID.ascending(),
                    sessionID: persist.sessionID,
                    messageID: persist.messageID,
                    type: "text",
                    text: "",
                    time: { start: Date.now() },
                    metadata: event.providerMetadata,
                  } satisfies MessageV2.TextPart)
                  return
                }
                if (event.type === "text-delta" && textPart) {
                  textPart.text += event.text
                  textOutput += event.text
                  if (event.providerMetadata) textPart.metadata = event.providerMetadata
                  yield* sessions.updatePart(textPart)
                  return
                }
                if (event.type === "text-end" && textPart) {
                  textPart.time = { start: textPart.time?.start ?? Date.now(), end: Date.now() }
                  if (event.providerMetadata) textPart.metadata = event.providerMetadata
                  yield* sessions.updatePart(textPart)
                  textPart = undefined
                  return
                }
                if (event.type === "tool-input-start") {
                  const part = {
                    id: PartID.ascending(),
                    sessionID: persist.sessionID,
                    messageID: persist.messageID,
                    type: "tool",
                    callID: event.id,
                    tool: event.toolName,
                    state: { status: "pending", input: {}, raw: "" },
                  } satisfies MessageV2.ToolPart
                  // identity 必须先于 updatePart 注册：SQLite commit 早于事件发布和返回，
                  // 中断若落在其间，attempt cleanup 仍能通过 PartID 找到 durable pending。
                  toolParts.set(event.id, part.id)
                  yield* sessions.updatePart(part)
                  return
                }
                if (event.type === "tool-input-delta") {
                  toolInput.set(event.id, (toolInput.get(event.id) ?? "") + event.delta)
                  return
                }
                if (event.type === "tool-input-end") {
                  const partID = toolParts.get(event.id)
                  if (!partID) return
                  // raw 参数更新也必须从 durable Part 起步；创建写入可能已经 commit，
                  // 但调用返回与内存 snapshot 更新并不构成持久化顺序保证。
                  const part = yield* sessions.getPart({
                    sessionID: persist.sessionID,
                    messageID: persist.messageID,
                    partID,
                  })
                  if (!part || part.type !== "tool" || part.state.status !== "pending") return
                  yield* sessions.updatePart({
                    ...part,
                    state: { ...part.state, raw: toolInput.get(event.id) ?? "" },
                  } satisfies MessageV2.ToolPart)
                  return
                }
                if (event.type === "tool-call" && event.toolName === "permission_review_decision") {
                  assessment = assessmentFromUnknown(event.input)
                  if (!assessment) return
                  const registered = toolParts.get(event.toolCallId)
                  const partID = registered ?? PartID.ascending()
                  // 部分 Provider 直接发 tool-call；该路径同样在首次 durable write 前登记，
                  // 保持所有 attempt-owned Tool Part 只有一个 closure 所有者。
                  if (!registered) toolParts.set(event.toolCallId, partID)
                  // completed 转换基于存储中的最新 ID/raw/metadata，避免先前 pending 写入
                  // 已提交但尚未返回时，旧对象重新成为后续 terminal write 的来源。
                  const current = registered
                    ? yield* sessions.getPart({
                        sessionID: persist.sessionID,
                        messageID: persist.messageID,
                        partID,
                      })
                    : undefined
                  yield* sessions.updatePart({
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
                      // Mirror reviewID onto the final decision part so the child
                      // transcript can be searched or exported by logical review,
                      // even though one hidden reviewer session accumulates many
                      // request/decision turns over the parent session lifetime.
                      metadata: { ...assessment, reviewID: persist.reviewID, source: "tool_call" },
                      output: JSON.stringify(assessment),
                      time: { start: Date.now(), end: Date.now() },
                    },
                  } satisfies MessageV2.ToolPart)
                  return
                }
                if (event.type === "tool-error") {
                  // The reviewer has exactly one no-side-effect protocol tool.
                  // A tool-error here means the provider/model attempted a tool
                  // submission that did not become a valid Assessment, so route it
                  // through the same hidden retry as missing or malformed input
                  // instead of treating it as an unrelated provider failure.
                  return yield* new ReviewerRunError({ reason: REVIEWER_DECISION_PROTOCOL_ERROR })
                }
                // 镜像 processor.ts finish-step：持久化 provider 真实 usage 和 input breakdown。
                // reviewer 不走 SessionProcessor 管道（安全边界：不暴露 prompt 给 chat plugin），
                // 所以必须在此手动处理 finish-step 事件，否则 message.tokens 恒为初始 0 且
                // 无 step-finish part → tokenAccounting 对 reviewer session 算出 input=0、breakdown=null。
                if (event.type === "finish-step") {
                  // persist 在此已被 !persist 早退分支（service.ts 上方）收窄为非 undefined，
                  // 与其他 persist 路径 handler 一致，无需重复 guard
                  const usage = Session.getUsage({ model, usage: event.usage, metadata: event.providerMetadata })
                  // 就地更新可变 message 引用，使 runReviewerAgent 的最终 updateMessage 持久化真实 tokens/cost
                  persist.message.tokens = usage.tokens
                  persist.message.cost += usage.cost
                  yield* sessions.updatePart({
                    id: PartID.ascending(),
                    sessionID: persist.sessionID,
                    messageID: persist.messageID,
                    type: "step-finish",
                    reason: event.finishReason,
                    tokens: usage.tokens,
                    cost: usage.cost,
                    inputChars,
                    inputBreakdown,
                  } satisfies MessageV2.StepFinishPart)
                  // 立即落库 message 行：finish-step 是流终止事件，但 runReviewerAgent 的
                  // 最终 updateMessage 在 stream drain 之后才执行。若不在此立即写入，
                  // DB 的 message.tokens 仍为 0，tokenAccounting 的 stepSF && !msgCompleted
                  // 分支会取到 stale 0 而非 stepSF.tokens.input。
                  yield* sessions.updateMessage(persist.message)
                  return
                }
                if (event.type === "error") {
                  // Provider stream errors must keep their original shape until
                  // SessionRetry classifies them. Wrapping here would erase
                  // APICallError/status/header details and turn transient socket
                  // failures into immediate reviewer fallback/user prompts.
                  return yield* Effect.fail(event.error)
                }
              }),
            ).pipe(
              Effect.onInterrupt(() =>
                Effect.gen(function* () {
                  streamInterrupted = true
                  yield* safeFinalize(TOOL_ABORTED_ERROR, true)
                }),
              ),
              // Provider failure 的原始 shape 仍交给 SessionRetry；cleanup 失败不能把
              // status/header 等诊断替换成第二个错误，也不能伪造 reviewer 成功结果。
              Effect.tapError(() => safeFinalize(TOOL_INCOMPLETE_ERROR, false)),
              // 对齐 SessionProcessor.ensuring(cleanup)：interrupt/error/success 退出都再扫一次。
              // 这是相对「仅 onInterrupt」的根修：timeout 与旁路失败时仍保证至少再尝试一次闭合。
              Effect.ensuring(
                Effect.suspend(() =>
                  safeFinalize(
                    streamInterrupted ? TOOL_ABORTED_ERROR : TOOL_INCOMPLETE_ERROR,
                    streamInterrupted,
                  ),
                ),
              ),
            )

            // 正常 drain 仍可能只有 tool-input-start 而没有合法 tool-call；在协议
            // retry/fallback 接管前先闭合本 attempt，防止每次重试累积 pending Part。
            // ensuring 已跑过后此处幂等；保留显式调用使「drain 成功但无 assessment」路径语义自解释。
            yield* safeFinalize(TOOL_INCOMPLETE_ERROR, false)

            if (textPart)
              yield* sessions.updatePart({
                ...textPart,
                time: { start: textPart.time?.start ?? Date.now(), end: Date.now() },
              })
            if (reasoningPart)
              yield* sessions.updatePart({
                ...reasoningPart,
                time: { start: reasoningPart.time.start, end: Date.now() },
              })
            if (!assessment) {
              const fallback = assessmentFromJsonText(textOutput)
              if (fallback) {
                // The text part remains as provider output, while this synthetic
                // no-side-effect tool part preserves the same audit shape as the
                // function-call path. Consumers should read `source` before
                // treating the part as a provider-emitted tool call.
                if (persist) yield* recordJsonFallbackDecision(sessions, persist, fallback)
                return fallback
              }
              return yield* new ReviewerRunError({ reason: REVIEWER_DECISION_PROTOCOL_ERROR })
            }
            return assessment
          }),
        (abort) => Effect.sync(() => abort.abort()),
      ).pipe(
        SessionRetry.retry({
          provider: model.providerID,
          parse: (error) => MessageV2.fromError(error, { providerID: model.providerID }),
          // The hidden reviewer child session is an audit transcript, not an
          // active SessionProcessor run with a visible status line. Reuse the
          // shared retry policy for provider safety while leaving parent tool
          // autoReview metadata in its existing `reviewing` state until a final
          // allow/deny/fallback result is known.
          set: () => Effect.void,
        }),
      )
    }

    // [local-smark] tool_choice 兼容协商入口（INV-03，用户原话授权：「如果拒绝
    // 该参数，则兼容性地重发一次」）：默认强制 required；provider 以 400 且报文
    // 指向 tool_choice 拒绝时，同次评审去参重发恰一次并记忆该 provider。该
    // catchIf 位于 runReviewerAgent 的 tapError/onInterrupt 管道之内，首次 400
    // 不会写入 message error 终态；重发复用同一 child message 行（首次 400 在任何
    // stream 事件前发生，无 parts 落库，safeFinalize 为 no-op）。
    function runReviewerStreamWithToolChoice(
      messages: readonly ModelMessage[],
      model: Provider.Model,
      persist?: Parameters<typeof runReviewerStream>[2],
    ) {
      const forced = !toolChoiceRejectedProviders.has(model.providerID)
      return runReviewerStream(messages, model, persist, forced).pipe(
        Effect.catchIf(isToolChoiceRejection, () => {
          toolChoiceRejectedProviders.add(model.providerID)
          return runReviewerStream(messages, model, persist, false)
        }),
      )
    }

    function markToolReviewing(input: PermissionAuto.ReviewInput, reviewerSessionID: SessionID | undefined) {
      return updateToolAutoReview(input, {
        status: "reviewing",
        ...(reviewerSessionID ? { sessionID: reviewerSessionID } : {}),
      })
    }

    function markToolReviewed(input: PermissionAuto.ReviewInput, assessment: Schema.Schema.Type<typeof Assessment>) {
      return updateToolAutoReview(input, {
        status: assessment.outcome === "allow" ? "allowed" : "denied",
        result: {
          risk_level: assessment.risk_level,
          user_authorization: assessment.user_authorization,
          rationale: assessment.rationale,
        },
      })
    }

    function markToolReviewFailed(
      input: PermissionAuto.ReviewInput,
      status: "timed_out" | "failed" | "fallback_user" | "aborted",
      reason: string,
    ) {
      return updateToolAutoReview(input, { status, error: reason })
    }

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
      if (!input.sessionID || !input.tool) return Effect.void
      return Effect.gen(function* () {
        const message = yield* MessageV2.get({ sessionID: input.sessionID!, messageID: input.tool!.messageID })
        const part = message.parts.find(
          (item): item is MessageV2.ToolPart => item.type === "tool" && item.callID === input.tool!.callID,
        )
        if (!part || (part.state.status !== "pending" && part.state.status !== "running")) return
        const metadata = part.state.status === "running" ? (part.state.metadata ?? {}) : {}
        const current =
          metadata?.autoReview && typeof metadata.autoReview === "object" && !Array.isArray(metadata.autoReview)
            ? metadata.autoReview
            : {}
        // onInterrupt 可能在 handleReviewerFailure 写入终态后延迟触发；
        // "aborted" 不应覆盖更具体的终态（timed_out/failed/fallback_user/allowed/denied）。
        if (patch.status === "aborted" && current.status && current.status !== "reviewing") return
        // 审核展示写只做一次：优先保留已结构化 input，其次用 ask metadata 中已固定的
        // command（Shell 在 Permission.ask 时已写入），避免 pending 仍写成 { raw }
        // 导致 TUI 整段 reviewing 窗显示 Writing command...。
        const toolInput = reviewDisplayToolInput(part, input.metadata)
        yield* sessions.updatePart({
          ...part,
          state: {
            status: "running",
            input: toolInput,
            title:
              patch.status === "reviewing" ? `Auto review: ${input.precheck.level}` : `Auto review: ${patch.status}`,
            metadata: {
              ...metadata,
              // This metadata is intentionally small and stable: clients can show
              // that deterministic precheck handed the tool to the reviewer
              // without rendering the hidden reviewer prompt or trusting it as a
              // permission result.
              autoReview: {
                ...current,
                reviewID: input.reviewID,
                precheck: input.precheck,
                ...patch,
              },
            },
            time: { start: part.state.status === "running" ? part.state.time.start : Date.now() },
          },
        } satisfies MessageV2.ToolPart)
      }).pipe(
        // Review display is best-effort: stale tool references can happen after
        // cancellation, repair, or compaction, but losing that UI update must not
        // convert an otherwise valid reviewer decision into deny or ask. Defects
        // are caught too because this path updates display metadata, not policy.
        Effect.catch(() => Effect.void),
        Effect.catchDefect(() => Effect.void),
      )
    }
  }),
)

function buildMessages(input: { system: string; userItems: readonly PermissionReviewerPrompt.UserPromptItem[] }) {
  // Keep reviewer prompting to one system message plus one synthetic user message
  // so provider behavior is deterministic and isolated from the main session's
  // original role ordering.
  return [
    { role: "system", content: input.system },
    { role: "user", content: input.userItems.map((item) => item.text).join("\n\n") },
  ] satisfies ModelMessage[]
}

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

function isReviewerError(error: unknown): error is Error {
  // Preserve typed reviewer failures through provider stream error mapping;
  // everything else is wrapped as ReviewerRunError for one fail-closed path.
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

// [local-smark] 仅当 provider 以 400 且报文明确指向 tool_choice 时才归类为
// 参数拒绝：其它 400（如 Codex 的 instructions/max_output_tokens 拒绝）必须
// 原样失败（INV-06），不得被去参重发掩盖。窄匹配的残余场景（报文不含该词）
// 走既有 3-attempt/fail-closed，不加宽匹配。statusCode/responseBody 来自
// AI SDK APICallError 的原始 shape（与 errorMessage 提取的 responseBody 同源）。
function isToolChoiceRejection(error: unknown): boolean {
  if (!error || typeof error !== "object") return false
  const withStatus = error as { statusCode?: unknown; responseBody?: unknown }
  return withStatus.statusCode === 400 && /tool[_ ]?choice/i.test(String(withStatus.responseBody ?? ""))
}

function reviewerEnabled(permission: Config.Info["permission"], _metadata: Readonly<Record<string, unknown>>) {
  // reviewer 只会在 Permission.ask 已经命中 auto action 后被调用；是否进入
  // auto review 由权限计算决定，而不是由 agent 名称或工具 metadata 决定。
  if (permission?.approvals_reviewer === "user") return false
  return true
}

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

function loadTenantPolicy(autoReview: { policy?: string; policy_path?: string } | undefined) {
  return Effect.gen(function* () {
    // Inline and file-based tenant policy are appended to the default policy
    // instead of replacing it so local rules can tighten behavior without losing
    // the baseline critical-deny taxonomy.
    const pathPolicy = autoReview?.policy_path
      ? yield* Effect.promise(() => Bun.file(autoReview.policy_path!).text()).pipe(
          Effect.mapError(
            (error) => new ReviewerRunError({ reason: `failed to load auto_review.policy_path: ${String(error)}` }),
          ),
        )
      : ""
    return [PermissionReviewerPrompt.DEFAULT_TENANT_POLICY, pathPolicy, autoReview?.policy]
      .filter((item): item is string => Boolean(item?.trim()))
      .join("\n\n")
  })
}

export const defaultLayer = Layer.suspend(() =>
  layer.pipe(
    // reviewer 请求落点现在需要读取 auth，才能只在 OpenAI OAuth/Codex 路径把同一份
    // 可信策略放进 Responses `instructions`；默认层必须随现有 config/provider 一起
    // 提供 Auth。Reviewer 还要读取 Plugin，以便复用主聊天路径已有的 provider
    // 兼容 hook；这保持 Codex/GitHub/Cloudflare 等请求形状修正在一个既有入口，
    // 避免隐藏 reviewer 流另起一套 provider 特例。
    Layer.provide(Auth.defaultLayer),
    Layer.provide(Config.defaultLayer),
    Layer.provide(Plugin.defaultLayer),
    Layer.provide(Provider.defaultLayer),
  ),
)

// Permission.defaultLayer consumes this bundled reviewer layer before building
// Permission.Service. `Layer.suspend` preserves the historical cycle boundary:
// Session imports Permission types, so Session.defaultLayer must not be
// dereferenced while this module is initializing.
export const defaultLayerWithSession = Layer.suspend(() => defaultLayer.pipe(Layer.provide(Session.defaultLayer)))

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
  try {
    // Treat malformed tool/function arguments the same as missing protocol
    // output: they are not a valid permission decision, but they also should not
    // bypass the one retry that repairs reviewer submission format.
    return Schema.decodeUnknownSync(Assessment)(input)
  } catch {
    return
  }
}

// attempt 退出时的 tool 终态收口主路径（INV-01/02）。
// knownPartIDs = 本 attempt 内存 ownership；durable = SQLite/message 真相补扫。
// 并集后仍 getPart 重读：覆盖 commit 后 return 前中断窗口，并跳过 completed winner（INV-03）。
// 写失败向上抛出：caller 只 log，绝不把 cleanup 失败变成 allow/deny 成功（INV-04）。
function closeOpenReviewerTools(
  sessions: Session.Interface,
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
    const partIDs = new Set<PartID>(input.knownPartIDs ?? [])
    // durable 失败（无 DB / mock）降级为仅 map，避免拖垮整个 finalize。
    // MessageV2.parts 走 SQLite；单元 mock 无库时 catch 后 partIDs 仅含 knownPartIDs。
    const durable = yield* Effect.try({
      try: () => MessageV2.parts(input.messageID),
      catch: (cause) => cause,
    }).pipe(Effect.catch(() => Effect.succeed([] as MessageV2.Part[])))
    for (const part of durable) {
      // 只收 open tool；text/reasoning/step-finish 不参与 tool 终态合同。
      if (part.type !== "tool") continue
      if (part.state.status !== "pending" && part.state.status !== "running") continue
      partIDs.add(part.id)
    }
    yield* Effect.forEach(
      partIDs,
      Effect.fnUntraced(function* (partID) {
        // registry/map 只持有 identity；终态前必须重读，尊重已 completed 的 decision winner。
        const part = yield* sessions.getPart({
          sessionID: input.sessionID,
          messageID: input.messageID,
          partID,
        })
        if (!part || part.type !== "tool") return
        if (part.state.status !== "pending" && part.state.status !== "running") return
        const start = part.state.status === "running" ? part.state.time.start : end
        const metadata = part.state.status === "running" ? part.state.metadata : undefined
        yield* sessions.updatePart({
          ...part,
          state: {
            status: "error",
            input: part.state.input,
            error: input.error,
            // interrupted 仅用于真实 abort/timeout；incomplete stream 保持原错误语义。
            metadata: input.interrupted
              ? { ...metadata, interrupted: true, executionElapsedMs: Math.floor(end - start) }
              : metadata,
            time: { start, end },
          },
        } satisfies MessageV2.ToolPart)
      }),
      { discard: true },
    )
  })
}

function hideReviewerProtocolAttempt(sessions: Session.Interface, sessionID: SessionID, requestID: MessageID) {
  return Effect.gen(function* () {
    const hidden = { time: Date.now(), reason: PROTOCOL_RETRY_HIDDEN_REASON as typeof PROTOCOL_RETRY_HIDDEN_REASON }
    const request = yield* MessageV2.get({ sessionID, messageID: requestID })
    // Hide the synthetic reviewer request together with its malformed assistant
    // reply. The prompt is regenerated for the retry, and keeping only the final
    // visible attempt prevents users from reading a malformed JSON/prose answer
    // as an approved decision before the protocol repair completes.
    yield* sessions.updateMessage({ ...request.info, hidden })
    const assistant = Array.from(MessageV2.stream(sessionID, { includeHidden: true })).find(
      (msg) => msg.info.role === "assistant" && msg.info.parentID === requestID,
    )
    if (assistant?.info.role === "assistant") {
      yield* sessions.updateMessage({ ...assistant.info, hidden })
    }
  })
}

function recordJsonFallbackDecision(
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
      tool: "permission_review_decision",
      state: {
        status: "completed",
        input: assessment,
        title: assessment.outcome === "allow" ? "Permission review allowed" : "Permission review denied",
        metadata: { ...assessment, reviewID: persist.reviewID, source: JSON_FALLBACK_SOURCE },
        output: JSON.stringify(assessment),
        time: { start: Date.now(), end: Date.now() },
      },
    } satisfies MessageV2.ToolPart)
  })
}

// 仅 { raw } 是历史 pending 提升形状；任意其它自有键表示已有结构化工具参数。
// 不得把空 {} 当成 structured，否则会挡住 metadata.command 回填。
// 判定只看自有键形状，不解析 raw JSON，避免第二套参数源。
// 与 TUI equal-v0 enrich 共用同一 raw-only 语义，防止 durable/live 对“有无 command”判断分叉。
function isRawOnlyToolInput(input: Record<string, unknown>) {
  const keys = Object.keys(input)
  return keys.length === 1 && keys[0] === "raw" && typeof input.raw === "string"
}

// structured = 非空且非 raw-only；tool-call 写入的 command/filePath 等均属此类。
// 空对象不算 structured：pending 初值 {} 必须继续落到 metadata.command 分支。
function isStructuredToolInput(input: Record<string, unknown>) {
  return Object.keys(input).length > 0 && !isRawOnlyToolInput(input)
}

// 审核展示用 input 的唯一决策函数：一次选择、一次写入。
// 优先级：已有 structured → ask metadata.command → pending.raw → 原值。
// 该顺序保证“参数已固定仍 Writing command...”在 pending-at-review 路径上可被单一 owner 修复。
function reviewDisplayToolInput(part: MessageV2.ToolPart, askMetadata: Readonly<Record<string, unknown>>) {
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

export * as PermissionReviewer from "./service"
