import * as Tool from "./tool"
import { Effect, Schema } from "effect"

const id = "permission_review_decision"

// This tool is a no-side-effect protocol primitive for the hidden reviewer
// agent. The registry gates it to the reserved reviewer object, not just the
// agent name, so config-spoofed agents cannot fabricate approval metadata.
const Parameters = Schema.Struct({
  outcome: Schema.Literals(["allow", "deny"]).annotate({ description: "Final review outcome" }),
  risk_level: Schema.Literals(["low", "medium", "high", "critical"]).annotate({
    description: "Risk level for the proposed action",
  }),
  user_authorization: Schema.Literals(["unknown", "low", "medium", "high"]).annotate({
    description: "How clearly the user authorized the exact action and side effects",
  }),
  rationale: Schema.String.annotate({ description: "Concise reason for the decision" }),
})
type Parameters = Schema.Schema.Type<typeof Parameters>
type Metadata = Parameters

export const PermissionReviewDecisionTool = Tool.define<typeof Parameters, Metadata, never>(
  id,
  Effect.succeed({
    description:
      "Submit a structured allow/deny decision for an auto permission review. This tool has no side effects and should only be used by the permission-reviewer agent.",
    parameters: Parameters,
    execute: (params: Parameters) =>
      // Echo the exact decision into metadata/output for auditability. Do not
      // perform permission changes here; PermissionAuto remains the only router
      // that can interpret reviewer decisions.
      Effect.succeed({
        title: params.outcome === "allow" ? "Permission review allowed" : "Permission review denied",
        metadata: params,
        output: JSON.stringify(params),
      }),
  }),
)
