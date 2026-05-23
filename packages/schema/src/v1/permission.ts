export * as PermissionV1 from "./permission"

import { Schema } from "effect"
import { define, inventory } from "../event"
import { ascending } from "../identifier"
import { Project } from "../project"
import { statics } from "../schema"
import { SessionID } from "../session-id"

export const ID = Schema.String.check(Schema.isStartsWith("per")).pipe(
  Schema.brand("PermissionID"),
  statics((schema) => ({ ascending: (id?: string) => schema.make(id ?? "per_" + ascending()) })),
)
export type ID = typeof ID.Type

// #196：`auto` 参与 allow/ask/deny 的 last-match-wins 评估器；Permission service
// #196：之后决定由 precheck、reviewer 还是用户审批处理匹配的请求。
export const Action = Schema.Literals(["allow", "deny", "ask", "auto"]).annotate({ identifier: "PermissionAction" })
export type Action = typeof Action.Type

export const Rule = Schema.Struct({ permission: Schema.String, pattern: Schema.String, action: Action }).annotate({
  identifier: "PermissionRule",
})
export type Rule = typeof Rule.Type

export const Ruleset = Schema.Array(Rule).annotate({ identifier: "PermissionRuleset" })
export type Ruleset = typeof Ruleset.Type

export const Request = Schema.Struct({
  id: ID,
  sessionID: SessionID,
  permission: Schema.String,
  patterns: Schema.Array(Schema.String),
  metadata: Schema.Record(Schema.String, Schema.Unknown),
  always: Schema.Array(Schema.String),
  tool: Schema.optional(Schema.Struct({ messageID: Schema.String, callID: Schema.String })),
}).annotate({ identifier: "PermissionRequest" })
export type Request = typeof Request.Type

export const Reply = Schema.Literals(["once", "always", "reject"])
export type Reply = typeof Reply.Type

export const ReplyBody = Schema.Struct({ reply: Reply, message: Schema.optional(Schema.String) }).annotate({
  identifier: "PermissionReplyBody",
})
export type ReplyBody = typeof ReplyBody.Type

export const Approval = Schema.Struct({ projectID: Project.ID, patterns: Schema.Array(Schema.String) }).annotate({
  identifier: "PermissionApproval",
})
export type Approval = typeof Approval.Type

export const AskInput = Schema.Struct({ ...Request.fields, id: Schema.optional(ID), ruleset: Ruleset }).annotate({
  identifier: "PermissionAskInput",
})
export type AskInput = typeof AskInput.Type

export const ReplyInput = Schema.Struct({ requestID: ID, ...ReplyBody.fields }).annotate({
  identifier: "PermissionReplyInput",
})
export type ReplyInput = typeof ReplyInput.Type

const Asked = define({ type: "permission.asked", schema: Request.fields })
const Replied = define({
  type: "permission.replied",
  schema: { sessionID: SessionID, requestID: ID, reply: Reply },
})
// #199：以下三个事件仅用于观察/审计，不影响 permission 决议本身。ask 与 error
// #199：仍通过原有 Asked/Replied 路径返回，订阅者无需监听这些新事件即可保持行为不变。
// #199：ReviewCompleted 在 reviewer 给出 allow/deny 时发布，绑定 reviewID 供审计
// #199：追溯；outcome 与 reviewer 决议一致，但 permission 层仍独立执行 cache/circuit。
// #208：ReviewStarted 在 reviewer 调用前发布——UI 可展示确定性 precheck 到模型审查的边界，不泄露隐藏 prompt
const ReviewStarted = define({
  type: "permission.review.started",
  // #208：内联 Schema.Literals 而非引用 PermissionPrecheck.LEVELS——schema 包不依赖 opencode 包
  schema: {
    sessionID: SessionID,
    reviewID: Schema.String,
    permission: Schema.String,
    patterns: Schema.Array(Schema.String),
    precheck: Schema.Struct({
      level: Schema.Literals(["safe", "general", "cautious", "dangerous"]),
      reason: Schema.String,
    }),
  },
})
const ReviewCompleted = define({
  type: "permission.review.completed",
  schema: { sessionID: SessionID, reviewID: Schema.String, outcome: Schema.Literals(["allow", "deny"]), rationale: Schema.String },
})
// #199：ReviewFailed 在 reviewer 异常退出（超时/provider 错误）时发布，reviewID 缺失
// #199：时记为 unknown；permission 层据此 fail-closed 而非静默放行。
const ReviewFailed = define({
  type: "permission.review.failed",
  schema: { sessionID: SessionID, reviewID: Schema.String, reason: Schema.String },
})
// #199：CircuitBroken 在连续拒绝触发阈值时发布，是咨询性信号——UI 可据此提示
// #199：用户，但 permission 层的 deny 结果不依赖此事件。
const CircuitBroken = define({
  type: "permission.review.circuit_broken",
  schema: { sessionID: SessionID, consecutive: Schema.Number, recent: Schema.Number },
})
export const Event = {
  Asked,
  Replied,
  ReviewStarted,
  ReviewCompleted,
  ReviewFailed,
  CircuitBroken,
  Definitions: inventory(Asked, Replied, ReviewStarted, ReviewCompleted, ReviewFailed, CircuitBroken),
}
