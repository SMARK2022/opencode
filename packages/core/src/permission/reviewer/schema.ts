import { Schema } from "effect"
import { PermissionPrecheck } from "../precheck"

// #198：风险等级——low/medium/high/critical，critical 在 invalidReviewContract 中强制 deny
// #198：critical 表示不可逆损害——删除根文件系统、凭证外泄等，reviewer 不得放行
// #198：high 表示严重但可恢复——force push、recursive delete 非保护目录，需高授权
// #198：medium 表示有限影响——写入操作、配置变更，需明确授权
// #198：low 表示只读或无副作用——安全命令，可自动放行
export const RiskLevel = Schema.Literals(["low", "medium", "high", "critical"])
export type RiskLevel = Schema.Schema.Type<typeof RiskLevel>

// #198：用户授权等级——high 为显式请求该精确操作，unknown 为 transcript 中无可靠授权
// #198：high 表示用户明确请求该精确操作——reviewer 可据此放行高风险命令
// #198：unknown 表示 transcript 中无可靠授权证据——非低风险命令 deny
export const UserAuthorization = Schema.Literals(["unknown", "low", "medium", "high"])
export type UserAuthorization = Schema.Schema.Type<typeof UserAuthorization>

// #202：precheck 层级 schema——safe/general/cautious/dangerous，复用 precheck 模块的 LEVELS 常量保证一致
export const PrecheckLevel = Schema.Literals(PermissionPrecheck.LEVELS)
export type PrecheckLevel = Schema.Schema.Type<typeof PrecheckLevel>

// #198：评估结果 schema——outcome/risk_level/user_authorization/rationale 四字段，用于 generateObject 结构化输出
// #198：outcome 为 allow/deny——reviewer 必须二选一，无 ask 选项，用户回退由错误类型表示
// #198：rationale 为必填字符串——决策必须有可审计的理由，空 rationale 被 invalidReviewContract 拒绝
export const Assessment = Schema.Struct({
  outcome: Schema.Literals(["allow", "deny"]),
  risk_level: RiskLevel,
  user_authorization: UserAuthorization,
  rationale: Schema.String,
}).annotate({ identifier: "PermissionReviewerAssessment" })
export type Assessment = Schema.Schema.Type<typeof Assessment>

// #202：reviewer 请求——permission/patterns/metadata/precheck，precheck.level 传递实际风险层级而非固定 prompt
// #202：默认仅 cautious 进入 reviewer，strict 配置才可能把 safe/general 送入此 schema
export class ReviewerRequest extends Schema.Class<ReviewerRequest>("PermissionReviewerRequest")({
  permission: Schema.String,
  patterns: Schema.Array(Schema.String),
  metadata: Schema.Record(Schema.String, Schema.Unknown),
  precheck: Schema.Struct({
    // #202：level 而非 action——reviewer 看到的是确定性风险分层，不是最终执行决策，防止模型误解
    level: PrecheckLevel,
    reason: Schema.String,
  }),
}) {}

export * as PermissionReviewerSchema from "./schema"
