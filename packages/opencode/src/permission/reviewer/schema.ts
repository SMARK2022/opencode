import { Schema } from "effect"

export const RiskLevel = Schema.Literals(["low", "medium", "high", "critical"])
export type RiskLevel = Schema.Schema.Type<typeof RiskLevel>

export const UserAuthorization = Schema.Literals(["unknown", "low", "medium", "high"])
export type UserAuthorization = Schema.Schema.Type<typeof UserAuthorization>

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
    action: Schema.Literal("prompt"),
    reason: Schema.String,
  }),
}) {}

export * as PermissionReviewerSchema from "./schema"
