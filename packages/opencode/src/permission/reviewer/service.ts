import { Config } from "@/config/config"
import { Provider } from "@/provider/provider"
import { Session } from "@/session/session"
import { generateObject, type ModelMessage } from "ai"
import { Context, Effect, Layer, Schema } from "effect"
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

// The reviewer layer is provider-backed but intentionally receives only a bounded
// transcript projection plus the planned action JSON. It never reuses the main
// agent's model messages, tools, or scratchpad as reviewer context.
export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const provider = yield* Provider.Service
    const session = yield* Session.Service

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
        // Transcript collection is best-effort and bounded. Missing sessions or
        // storage issues should not block the permission path; the reviewer can
        // still decide from the planned action and policy, or deny via policy.
        const transcript = input.sessionID
          ? yield* session
              .messages({ sessionID: input.sessionID, limit: 40 })
              .pipe(
                Effect.map(PermissionReviewerTranscript.fromMessages),
                Effect.catch(() => Effect.succeed({ entries: [], truncated: false })),
              )
          : { entries: [], truncated: false }
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

        return {
          action: assessment.outcome,
          reason: assessment.rationale,
          reviewID: crypto.randomUUID(),
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
