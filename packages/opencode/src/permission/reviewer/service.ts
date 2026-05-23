import { Config } from "@/config/config"
import { Provider } from "@/provider/provider"
import { Session } from "@/session/session"
import { MessageV2 } from "@/session/message-v2"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { generateObject, type ModelMessage } from "ai"
import { Context, Effect, Layer, Schema, Semaphore } from "effect"
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

// The reviewer layer is provider-backed but intentionally receives only a bounded
// transcript projection plus the planned action JSON. It never reuses the main
// agent's model messages, tools, or scratchpad as reviewer context.
export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const provider = yield* Provider.Service
    const sessions = yield* Session.Service
    const reviewerSessionLocks = new Map<SessionID, Semaphore.Semaphore>()

    const review: Interface["review"] = (input) => Effect.gen(function* () {
      const cfg = yield* config.get()
      const permission = cfg.permission
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
        // Transcript collection is best-effort and bounded twice: fetch a wider
        // recent window than the final reviewer prompt, then let transcript
        // selection preserve user anchors and cap entries/chars. This avoids
        // walking very old sessions on the permission path while still keeping
        // substantially more authorization context than the final prompt size.
        const transcript = input.sessionID
          ? yield* MessageV2.page({ sessionID: input.sessionID, limit: REVIEWER_MESSAGE_FETCH_LIMIT })
              .pipe(
                Effect.map((page) => {
                  const transcript = PermissionReviewerTranscript.fromMessages(page.items)
                  return { ...transcript, truncated: transcript.truncated || page.more }
                }),
                Effect.catch(() => Effect.succeed({ entries: [], truncated: false, entryTruncated: false })),
              )
          : { entries: [], truncated: false, entryTruncated: false }
        const messages = buildMessages({
          system: PermissionReviewerPrompt.buildSystemPrompt(tenantPolicy),
          userItems: PermissionReviewerPrompt.buildUserPromptItems(transcript, request, input.precheck.reason),
        })
        const model = autoReview?.model
          // User-specified reviewer models use the same provider/model parser as
          // normal agent config so aliases and provider validation stay in one
          // place. A bad model fails closed unless fallback=user is configured.
          ? yield* provider.getModel(
              Provider.parseModel(autoReview.model).providerID,
              Provider.parseModel(autoReview.model).modelID,
            )
          : yield* Effect.gen(function* () {
              const current = yield* provider.defaultModel()
              return (yield* provider.getSmallModel(current.providerID)) ?? (yield* provider.getModel(current.providerID, current.modelID))
            })
        const language = yield* provider.getLanguage(model)
        const reviewerSession = input.sessionID ? yield* getReviewerSession(input.sessionID, model) : undefined
        yield* markToolReviewing(input)
        const reviewerUser = reviewerSession
          ? yield* recordReviewerRequest({
              session: reviewerSession,
              model,
              text: messages.map((message) => `${message.role}: ${message.content}`).join("\n\n"),
            })
          : undefined
        // Use structured generation instead of free-form text parsing. The schema
        // enforces the JSON shape; PermissionAuto still performs semantic checks
        // for contradictory allows after the object is returned.
        const assessment = yield* Effect.promise(() =>
          generateObject({
            model: language,
            messages,
            schema: Object.assign(Schema.toStandardSchemaV1(Assessment), Schema.toStandardJSONSchemaV1(Assessment)),
          }).then((result) => result.object),
        ).pipe(
          Effect.timeoutOrElse({
            // Timeout is a security boundary: if the reviewer cannot complete in
            // time, the tool call must not execute unless explicit user fallback
            // is configured below.
            duration: `${autoReview?.timeout_ms ?? 90_000} millis`,
            orElse: () => Effect.fail(new ReviewerTimedOut()),
          }),
          Effect.mapError((error) => (isReviewerError(error) ? error : new ReviewerRunError({ reason: errorMessage(error) }))),
        )

        if (reviewerSession && reviewerUser) {
          yield* recordReviewerDecision({ session: reviewerSession, model, parentID: reviewerUser.id, assessment })
        }

        return {
          action: assessment.outcome,
          reason: assessment.rationale,
          reviewID: input.reviewID,
          risk_level: assessment.risk_level,
          user_authorization: assessment.user_authorization,
        } satisfies PermissionAuto.ReviewDecision
      })

      return yield* run.pipe(
        Effect.catch((error: unknown) =>
          // `fallback: "user"` is deliberately narrow: disabled reviewer already
          // means normal user routing, while all other failures become an explicit
          // fallback signal for PermissionAuto. Default behavior is fail-closed.
          autoReview?.fallback === "user" && !(error instanceof ReviewerDisabled)
            ? Effect.fail(new ReviewerFallbackToUser({ reason: errorMessage(error) }))
            : Effect.fail(error),
        ),
      )
    })

    return Service.of({ review })

    function getReviewerSession(parentID: SessionID, model: Provider.Model) {
      return reviewerSessionLock(parentID).withPermits(1)(Effect.gen(function* () {
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
      }))
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

    function recordReviewerRequest(input: { session: Session.Info; model: Provider.Model; text: string }) {
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
          // The text is synthetic protocol input: it should be inspectable in the
          // hidden reviewer child session, but must not later count as human
          // authorization evidence if that child transcript is projected again.
          synthetic: true,
          text: input.text,
        } satisfies MessageV2.TextPart)
        return message
      })
    }

    function recordReviewerDecision(input: {
      session: Session.Info
      model: Provider.Model
      parentID: MessageID
      assessment: Schema.Schema.Type<typeof Assessment>
    }) {
      return Effect.gen(function* () {
        const message = yield* sessions.updateMessage({
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
        } satisfies MessageV2.Assistant)
        yield* sessions.updatePart({
          id: PartID.ascending(),
          sessionID: input.session.id,
          messageID: message.id,
          type: "tool",
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
        } satisfies MessageV2.ToolPart)
      })
    }

    function markToolReviewing(input: PermissionAuto.ReviewInput) {
      if (!input.sessionID || !input.tool) return Effect.void
      return Effect.gen(function* () {
        const message = yield* MessageV2.get({ sessionID: input.sessionID!, messageID: input.tool!.messageID })
        const part = message.parts.find(
          (item): item is MessageV2.ToolPart => item.type === "tool" && item.callID === input.tool!.callID,
        )
        if (!part || (part.state.status !== "pending" && part.state.status !== "running")) return
        yield* sessions.updatePart({
          ...part,
          state: {
            status: "running",
            input: part.state.status === "pending" ? { raw: part.state.raw } : part.state.input,
            title: `Auto review: ${input.precheck.level}`,
            metadata: {
              ...(part.state.status === "running" ? part.state.metadata : {}),
              // This metadata is intentionally small and stable: clients can show
              // that deterministic precheck handed the tool to the reviewer
              // without rendering the hidden reviewer prompt or trusting it as a
              // permission result.
              autoReview: {
                reviewID: input.reviewID,
                precheck: input.precheck,
              },
            },
            time: { start: part.state.status === "running" ? part.state.time.start : Date.now() },
          },
        } satisfies MessageV2.ToolPart)
      }).pipe(
        // Review display is best-effort: stale tool references can happen after
        // cancellation, repair, or compaction, but losing that UI update must not
        // convert an otherwise valid reviewer decision into a fail-closed deny.
        Effect.catch(() => Effect.void),
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

function isReviewerError(error: unknown): error is Error {
  // Preserve typed reviewer failures through the generateObject error mapping;
  // everything else is wrapped as ReviewerRunError for one fail-closed path.
  return error instanceof ReviewerTimedOut || error instanceof ReviewerRunError
}

function reviewerEnabled(permission: Config.Info["permission"], metadata: Readonly<Record<string, unknown>>) {
  // 显式配置优先：`user` 保留人工审批，`auto_review` 对所有 auto 规则启用 reviewer。
  // 没有全局配置时，原生 Auto agent 仍应隐式启用 reviewer；否则选择 Auto
  // 只会把 cautious 命令降级成普通 ask，用户点允许后敏感 shell 仍会执行。
  if (permission?.approvals_reviewer === "user") return false
  if (permission?.approvals_reviewer === "auto_review") return true
  return metadata.agent === "Auto"
}

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") return error.message
  return String(error)
}

function loadTenantPolicy(autoReview: { policy?: string; policy_path?: string } | undefined) {
  return Effect.gen(function* () {
    // Inline and file-based tenant policy are appended to the default policy
    // instead of replacing it so local rules can tighten behavior without losing
    // the baseline critical-deny taxonomy.
    const pathPolicy = autoReview?.policy_path
      ? yield* Effect.promise(() => Bun.file(autoReview.policy_path!).text()).pipe(
          Effect.mapError((error) =>
            new ReviewerRunError({ reason: `failed to load auto_review.policy_path: ${String(error)}` }),
          ),
        )
      : ""
    return [PermissionReviewerPrompt.DEFAULT_TENANT_POLICY, pathPolicy, autoReview?.policy]
      .filter((item): item is string => Boolean(item?.trim()))
      .join("\n\n")
  })
}

export const defaultLayer = layer.pipe(
  Layer.provide(Config.defaultLayer),
  Layer.provide(Provider.defaultLayer),
)

// Permission.defaultLayer consumes this bundled reviewer layer before building
// Permission.Service. `Layer.suspend` preserves the historical cycle boundary:
// Session imports Permission types, so Session.defaultLayer must not be
// dereferenced while this module is initializing.
export const defaultLayerWithSession = Layer.suspend(() => defaultLayer.pipe(Layer.provide(Session.defaultLayer)))

export * as PermissionReviewer from "./service"
