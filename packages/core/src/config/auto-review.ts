export * as ConfigAutoReview from "./auto-review"

import { Schema } from "effect"

export const ApprovalsReviewer = Schema.Literals(["user", "auto_review"])

// 控制项独立于权限规则，保留源配置语义而不伪装成工具名。
export class Info extends Schema.Class<Info>("Config.AutoReview")({
  model: Schema.String.pipe(Schema.optional),
  // 与V1相同，单次执行期限不包含后续补试及清理的全部墙钟时间。
  timeout_ms: Schema.Number.pipe(Schema.optional).annotate({
    description:
      "Reviewer execution timeout per attempt in milliseconds. At most three attempts. Timeout retries append a time-budget advisory to the prompt. Defaults to 120000.",
  }),
  policy_path: Schema.String.pipe(Schema.optional),
  policy: Schema.String.pipe(Schema.optional),
  fallback: Schema.Literals(["deny", "user"]).pipe(Schema.optional),
  // 只选择模型广告的档位，不把评审预算变成权限或provider参数的新权威。
  effort: Schema.String.pipe(Schema.optional),
  strict: Schema.Boolean.pipe(Schema.optional),
  max_consecutive_denials: Schema.Number.pipe(Schema.optional),
  max_recent_denials: Schema.Number.pipe(Schema.optional),
  recent_denial_window: Schema.Number.pipe(Schema.optional),
}) {}
