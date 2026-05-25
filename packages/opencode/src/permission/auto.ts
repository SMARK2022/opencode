import { Effect } from "effect"
import { PermissionPrecheck } from "./precheck"
import type { MessageID, SessionID } from "@/session/schema"

export type Decision =
  | { action: "allow"; reason: string; source: "precheck" | "reviewer"; reviewID?: string }
  | { action: "ask"; reason: string; source: "precheck" | "reviewer_unavailable" }
  | { action: "deny"; reason: string; source: "precheck" | "reviewer"; reviewID?: string }

// Reviewer output is intentionally narrower than Permission.ask: once precheck
// reaches the review boundary, the model must decide allow/deny. A user prompt
// fallback is represented by reviewer errors, not by a third reviewer outcome,
// so policy failures and unavailable reviewers remain distinguishable.
export type ReviewDecision =
  | {
      action: "allow"
      reason: string
      reviewID: string
      risk_level: "low" | "medium" | "high" | "critical"
      user_authorization: "unknown" | "low" | "medium" | "high"
    }
  | {
      action: "deny"
      reason: string
      reviewID: string
      risk_level: "low" | "medium" | "high" | "critical"
      user_authorization: "unknown" | "low" | "medium" | "high"
    }

export interface ReviewInput {
  readonly reviewID: string
  readonly sessionID?: SessionID
  readonly permission: string
  readonly patterns: readonly string[]
  readonly metadata: Readonly<Record<string, unknown>>
  readonly tool?: { readonly messageID: MessageID; readonly callID: string }
  readonly precheck: { readonly level: PermissionPrecheck.Level; readonly reason: string }
}

// The reviewer is injected rather than constructed here so the deterministic
// router can be tested without provider/session layers and can fail closed when
// the optional service is absent in smaller runtimes.
export interface Reviewer {
  readonly review: (input: ReviewInput) => Effect.Effect<ReviewDecision, unknown>
}

export function evaluate(
  input: {
    permission: string
    patterns: readonly string[]
    metadata: Readonly<Record<string, unknown>>
    tool?: { readonly messageID: MessageID; readonly callID: string }
    strict?: boolean
    reviewerDisabled?: boolean
  },
  reviewer?: Reviewer,
  onReviewStart?: (input: {
    readonly reviewID: string
    readonly precheck: { readonly level: PermissionPrecheck.Level; readonly reason: string }
  }) => Effect.Effect<void>,
) {
  return Effect.gen(function* () {
    const precheck = PermissionPrecheck.evaluate(input)
    const isShell = input.permission === "bash"
    // [local-smark] auto 四级预审路由开始
    // safe/general/cautious/dangerous 是 LLM 负载边界：safe 和 general 默认
    // 直接允许；只有 cautious 进入 reviewer/user fallback；dangerous 直接拒绝。
    // strict 是用户显式配置的例外，用来保留原本“低风险也审”的能力。
    if (precheck.level === "dangerous") return { action: "deny", reason: precheck.reason, source: "precheck" } satisfies Decision
    if (precheck.level === "safe" && !input.strict) {
      return { action: "allow", reason: precheck.reason, source: "precheck" } satisfies Decision
    }
    if (precheck.level === "general" && !input.strict) {
      // general 是“未知但未命中 cautious/dangerous”的确定性 allow 边界；reviewer
      // 只承接 cautious。这样普通 edit/add/update 和未知 shell 不会消耗 LLM 或
      // 回到可点击 ask，真正敏感的 delete/external-directory 会先被 precheck 提升。
      return { action: "allow", reason: precheck.reason, source: "precheck" } satisfies Decision
    }
    // [local-smark] auto 四级预审路由结束

    // Cautious is the default auto review boundary: deterministic precheck found
    // a visible risk that is neither harmless nor immediately forbidden, so a
    // reviewer must explicitly return allow/deny. Native auto must not degrade
    // back to a clickable user ask if reviewer wiring is missing; fail closed so
    // sensitive shell output cannot be exposed by pressing Allow.
    if (!reviewer) {
      // Explicit user-review configuration is stronger than the native auto
      // fail-closed default. This preserves small/custom runtimes that construct
      // Permission.layer without a reviewer service but intentionally keep user
      // approval as the review boundary.
      if (input.reviewerDisabled) return { action: "ask", reason: precheck.reason, source: "reviewer_unavailable" } satisfies Decision
      if (input.metadata.agent === "auto") {
        return { action: "deny", reason: `auto reviewer unavailable: ${precheck.reason}`, source: "reviewer" } satisfies Decision
      }
      return { action: "ask", reason: precheck.reason, source: "reviewer_unavailable" } satisfies Decision
    }

    const reviewID = crypto.randomUUID()
    if (onReviewStart) {
      // The review id is minted before the model call so progress UIs and final
      // audit events can refer to the same logical review even if the model
      // times out or fails before returning an assessment.
      yield* onReviewStart({ reviewID, precheck })
    }

    return yield* reviewer.review({
      ...input,
      reviewID,
      precheck: {
        level: precheck.level,
        // Strict mode preserves why the request crossed the reviewer boundary, so
        // policy and audit logs can distinguish normal cautious review from
        // explicit strict review of an otherwise safe/general command.
        reason: input.strict && precheck.level !== "cautious" ? `strict auto review required: ${precheck.reason}` : precheck.reason,
      },
    }).pipe(
      Effect.match({
        onFailure: (error) => {
          const tag = errorTag(error)
          // Disabled/fallback are explicit service signals that return to the
          // existing user approval path. All other failures, including provider
          // errors, schema errors, and timeouts, fail closed below.
          if (tag === "PermissionReviewerDisabled" || tag === "PermissionReviewerFallbackToUser") {
            return { action: "ask", reason: errorMessage(error), source: "reviewer_unavailable" } satisfies Decision
          }
          return { action: "deny", reason: reviewerFailureMessage(error), source: "reviewer", reviewID } satisfies Decision
        },
        onSuccess: (reviewed) => {
          // The prompt is policy, but this is the hard guardrail. Contradictory
          // model output is converted to deny so a malformed allow cannot weaken
          // the deterministic precheck or tenant policy.
          const invalid = invalidReviewContract(reviewed)
          if (invalid) return { action: "deny", reason: invalid, source: "reviewer", reviewID: reviewed.reviewID } satisfies Decision
          return {
            action: reviewed.action,
            reason: reviewed.reason,
            source: "reviewer",
            reviewID: reviewed.reviewID,
          } satisfies Decision
        },
      }),
    )
  })
}

function errorTag(error: unknown) {
  // TaggedErrorClass instances expose `_tag`, but tests may use plain objects to
  // assert router behavior without depending on reviewer service construction.
  return error && typeof error === "object" && "_tag" in error && typeof error._tag === "string" ? error._tag : undefined
}

function errorMessage(error: unknown) {
  // Provider/model errors are intentionally surfaced in the deny reason for
  // diagnostics; the safe user-facing AutoDeniedError still prevents retry
  // advice that would encourage policy bypasses.
  if (error instanceof Error) return error.message
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") return error.message
  return String(error)
}

function reviewerFailureMessage(error: unknown) {
  const tag = errorTag(error)
  // Timeouts get a stable reason because they are common operational failures
  // and should be clearly distinguishable from reviewer policy denials.
  if (tag === "PermissionReviewerTimedOut") return "auto reviewer timed out; failing closed without executing the tool call"
  return `auto reviewer failed closed: ${errorMessage(error)}`
}

function invalidReviewContract(reviewed: ReviewDecision) {
  // These checks intentionally duplicate the prompt's outcome policy in code.
  // They do not try to grade every answer; they catch contradictions that would
  // turn the reviewer into a security downgrade if accepted as-is.
  if (!reviewed.reason.trim()) return "auto reviewer returned an empty rationale; failing closed"
  if (reviewed.action === "allow" && reviewed.risk_level === "critical") {
    return "auto reviewer returned allow for critical risk; failing closed"
  }
  if (reviewed.action === "allow" && reviewed.risk_level !== "low" && reviewed.user_authorization === "unknown") {
    return "auto reviewer allowed a non-low-risk request without user authorization evidence; failing closed"
  }
}

export * as PermissionAuto from "./auto"
