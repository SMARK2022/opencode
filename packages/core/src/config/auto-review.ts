export * as ConfigAutoReview from "./auto-review"

import { Schema } from "effect"

export const ApprovalsReviewer = Schema.Literals(["user", "auto_review"])

// 控制项独立于权限规则，保留源配置语义而不伪装成工具名。
export class Info extends Schema.Class<Info>("Config.AutoReview")({
  model: Schema.String.pipe(Schema.optional),
  timeout_ms: Schema.Number.pipe(Schema.optional),
  policy_path: Schema.String.pipe(Schema.optional),
  policy: Schema.String.pipe(Schema.optional),
  fallback: Schema.Literals(["deny", "user"]).pipe(Schema.optional),
  strict: Schema.Boolean.pipe(Schema.optional),
  max_consecutive_denials: Schema.Number.pipe(Schema.optional),
  max_recent_denials: Schema.Number.pipe(Schema.optional),
  recent_denial_window: Schema.Number.pipe(Schema.optional),
}) {}
