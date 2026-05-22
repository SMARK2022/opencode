import { Schema } from "effect"
import { LEVELS as PRECHECK_LEVELS } from "../precheck"

export const RiskLevel = Schema.Literals(["low", "medium", "high", "critical"])
export type RiskLevel = Schema.Schema.Type<typeof RiskLevel>

export const UserAuthorization = Schema.Literals(["unknown", "low", "medium", "high"])
export type UserAuthorization = Schema.Schema.Type<typeof UserAuthorization>

export const PrecheckLevel = Schema.Literals(PRECHECK_LEVELS)
export type PrecheckLevel = Schema.Schema.Type<typeof PrecheckLevel>

// The reviewer must return the full assessment, even for allow. Optional fields
// made it too easy for a malformed allow to skip policy-grade risk evidence; the
// router still fails closed on semantic contradictions after schema validation.
export const Assessment = Schema.Struct({
  outcome: Schema.Literals(["allow", "deny"]),
  risk_level: RiskLevel,
  user_authorization: UserAuthorization,
  rationale: Schema.String,
}).annotate({ identifier: "PermissionReviewerAssessment" })
export type Assessment = Schema.Schema.Type<typeof Assessment>

export class ReviewerRequest extends Schema.Class<ReviewerRequest>("PermissionReviewerRequest")({
  // This is the only action evidence the reviewer receives besides the bounded
  // transcript. Keep it plain JSON so provider prompts, logs, and tests all see
  // the same permission/pattern/metadata/precheck shape.
  permission: Schema.String,
  patterns: Schema.Array(Schema.String),
  metadata: Schema.Record(Schema.String, Schema.Unknown),
  precheck: Schema.Struct({
    // [local-smark] reviewer 预审层级字段开始
    // reviewer 只应看到已经跨过 auto 边界的请求。字段名使用 level 而不是
    // action，避免把确定性风险分层误解成最终执行决策；默认情况下只有 cautious
    // 会进入 reviewer，strict 配置才可能把 safe/general 也送入此 schema。
    level: PrecheckLevel,
    // [local-smark] reviewer 预审层级字段结束
    reason: Schema.String,
  }),
}) {}

export * as PermissionReviewerSchema from "./schema"
