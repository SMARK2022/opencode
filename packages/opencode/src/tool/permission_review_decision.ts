import * as Tool from "./tool"
import { Effect, Schema } from "effect"

const id = "permission_review_decision"

// #200：无副作用协议原语，registry 按对象引用门控而非仅按名，
// #200：配置伪造的代理无法冒名获取审批元数据工具
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
// #200：Metadata 与 Parameters 同型，审计链路保留完整决策快照
// #200：outcome/risk_level/user_authorization 三维度结构化决策，供 PermissionAuto 解释
type Metadata = Parameters

export const PermissionReviewDecisionTool = Tool.define<typeof Parameters, Metadata, never>(
  id,
  Effect.succeed({
    description:
      "Submit a structured allow/deny decision for an auto permission review. This tool has no side effects and should only be used by the permission-reviewer agent.",
    parameters: Parameters,
    execute: (params: Parameters) =>
      // #200：仅回显决策到 metadata/output 供审计；权限变更仍由 PermissionAuto 路由，
      // #200：reviewer 不是唯一可解释决策的路由器
      Effect.succeed({
        title: params.outcome === "allow" ? "Permission review allowed" : "Permission review denied",
        metadata: params,
        output: JSON.stringify(params),
      }),
  }),
)
