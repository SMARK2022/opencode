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
import { PermissionReviewerPrompt } from "./prompt"
import { Assessment, ReviewerRequest } from "./schema"
import { PermissionReviewerTranscript } from "./transcript"
import type { PermissionAuto } from "../auto"

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
  // The retry prompt deliberately asks only for the tool/function-call protocol.
  // JSON text fallback is a runtime compatibility layer, not behavior we should
  // advertise to the model after it already missed the preferred contract.
  text: "Protocol retry: the previous response did not submit the required permission_review_decision tool/function call. Reassess the same evidence and call permission_review_decision exactly once. Do not answer in prose or markdown.",
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
          const assessment = yield* runReviewerAttempt(messages, true).pipe(
            Effect.catchIf(isReviewerDecisionProtocolError, () =>
              // Keep the evidence and requested action unchanged; only append a
              // protocol nudge so the second attempt repairs submission format
              // instead of broadening the authorization or policy context.
              runReviewerAttempt(buildMessages({ system, userItems: [...userItems, PROTOCOL_RETRY_USER_ITEM] }), false),
            ),
            Effect.timeoutOrElse({
              // Timeout covers reviewer execution including its existing provider
              // retry loop. The tool still never executes from a timeout alone:
              // default fallback returns to user ask, while fallback=deny preserves
              // a terminal fail-closed result for stricter deployments.
              duration: `${autoReview?.timeout_ms ?? 90_000} millis`,
              orElse: () => Effect.fail(new ReviewerTimedOut()),
            }),
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
        const match = yield* sessions
          .findMessage(sessionID, (m) => m.info.role === "user" && !!m.info.model)
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
      if (!session || !parentID) return runReviewerStream(input.messages, input.model)
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
        const assessment = yield* runReviewerStream(input.messages, input.model, {
          sessionID: session.id,
          messageID: message.id,
          reviewID: input.reviewID,
        }).pipe(
          Effect.tapError((error) =>
            Effect.gen(function* () {
              message.error = MessageV2.fromError(error, { providerID: input.model.providerID })
              message.time.completed = Date.now()
              yield* sessions.updateMessage(message)
            }),
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
      persist?: { sessionID: SessionID; messageID: MessageID; reviewID: string },
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
                  description: "Submit the structured allow/deny decision for this permission review.",
                  inputSchema: jsonSchema(toJsonSchema(Assessment) as Parameters<typeof jsonSchema>[0]),
                  execute: async (assessment) => ({
                    title: assessment.outcome === "allow" ? "Permission review allowed" : "Permission review denied",
                    metadata: assessment,
                    output: JSON.stringify(assessment),
                  }),
                }),
              },
              // Some OpenAI-compatible providers reject forced tool_choice even
              // though they can emit tool calls. The reviewer prompt requires this
              // tool, and absence of the call still fails closed below.
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
            const toolParts = new Map<string, MessageV2.ToolPart>()
            const toolInput = new Map<string, string>()

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
                  const part = yield* sessions.updatePart({
                    id: PartID.ascending(),
                    sessionID: persist.sessionID,
                    messageID: persist.messageID,
                    type: "tool",
                    callID: event.id,
                    tool: event.toolName,
                    state: { status: "pending", input: {}, raw: "" },
                  } satisfies MessageV2.ToolPart)
                  toolParts.set(event.id, part)
                  return
                }
                if (event.type === "tool-input-delta") {
                  toolInput.set(event.id, (toolInput.get(event.id) ?? "") + event.delta)
                  return
                }
                if (event.type === "tool-input-end") {
                  const part = toolParts.get(event.id)
                  if (!part || part.state.status !== "pending") return
                  const next = {
                    ...part,
                    state: { ...part.state, raw: toolInput.get(event.id) ?? "" },
                  } satisfies MessageV2.ToolPart
                  toolParts.set(event.id, yield* sessions.updatePart(next))
                  return
                }
                if (event.type === "tool-call" && event.toolName === "permission_review_decision") {
                  assessment = assessmentFromUnknown(event.input)
                  if (!assessment) return
                  const existing = toolParts.get(event.toolCallId)
                  const part = yield* sessions.updatePart({
                    ...(existing ?? {
                      id: PartID.ascending(),
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
                  toolParts.set(event.toolCallId, part)
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
                if (event.type === "error") {
                  // Provider stream errors must keep their original shape until
                  // SessionRetry classifies them. Wrapping here would erase
                  // APICallError/status/header details and turn transient socket
                  // failures into immediate reviewer fallback/user prompts.
                  return yield* Effect.fail(event.error)
                }
              }),
            )

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
      status: "timed_out" | "failed" | "fallback_user",
      reason: string,
    ) {
      return updateToolAutoReview(input, { status, error: reason })
    }

    function updateToolAutoReview(
      input: PermissionAuto.ReviewInput,
      patch: {
        status: "reviewing" | "allowed" | "denied" | "timed_out" | "failed" | "fallback_user"
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
        const metadata = part.state.status === "running" ? part.state.metadata : {}
        const current =
          metadata?.autoReview && typeof metadata.autoReview === "object" && !Array.isArray(metadata.autoReview)
            ? metadata.autoReview
            : {}
        yield* sessions.updatePart({
          ...part,
          state: {
            status: "running",
            input: part.state.status === "pending" ? { raw: part.state.raw } : part.state.input,
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

function reviewerEnabled(permission: Config.Info["permission"], _metadata: Readonly<Record<string, unknown>>) {
  // reviewer 只会在 Permission.ask 已经命中 auto action 后被调用；是否进入
  // auto review 由权限计算决定，而不是由 agent 名称或工具 metadata 决定。
  if (permission?.approvals_reviewer === "user") return false
  return true
}

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string")
    return error.message
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
  try {
    // Deliberately parse only the whole final text. Extracting JSON from prose,
    // markdown fences, or mixed reasoning would let untrusted explanation text
    // influence the permission boundary and belongs in the protocol retry path.
    return Schema.decodeUnknownSync(Assessment)(JSON.parse(trimmed))
  } catch {
    return
  }
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

export * as PermissionReviewer from "./service"
