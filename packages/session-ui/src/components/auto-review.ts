import type { UiI18n } from "@opencode-ai/ui/context/i18n"

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function autoReviewMetadata(value: unknown) {
  if (!record(value) || typeof value.reviewID !== "string") return
  const precheck = record(value.precheck) ? value.precheck : {}
  const result = record(value.result) ? value.result : {}
  // 只投影已有审查信封；展示默认值不产生批准或替代真实工具状态。
  return {
    reviewID: value.reviewID, sessionID: typeof value.sessionID === "string" ? value.sessionID : undefined,
    status: typeof value.status === "string" ? value.status : "reviewing",
    level: typeof precheck.level === "string" ? precheck.level : undefined,
    risk: typeof result.risk_level === "string" ? result.risk_level : undefined, authorization: typeof result.user_authorization === "string" ? result.user_authorization : undefined,
  }
}

export function autoReviewLabel(review: NonNullable<ReturnType<typeof autoReviewMetadata>>, i18n: Pick<UiI18n, "t">) {
  // 源状态文案由i18n整句承载，不能从是否执行成功反推reviewer的裁决。
  const unknown = i18n.t("ui.permission.review.unknown")
  switch (review.status) {
    case "allowed": return i18n.t("ui.permission.review.allowed", { authorization: review.authorization ?? unknown })
    case "denied": return i18n.t("ui.permission.review.denied", { risk: review.risk ?? unknown, authorization: review.authorization ?? unknown })
    case "timed_out": return i18n.t("ui.permission.review.timedOut")
    case "failed": return i18n.t("ui.permission.review.failed")
    case "fallback_user": return i18n.t("ui.permission.review.fallbackUser")
    default: return i18n.t("ui.permission.review.reviewing", { level: review.level ?? i18n.t("ui.permission.review.pending") })
  }
}
