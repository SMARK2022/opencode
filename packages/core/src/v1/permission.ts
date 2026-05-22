export * as PermissionV1 from "./permission"

import { Schema } from "effect"
export * from "@opencode-ai/schema/permission-v1"
import { ID } from "@opencode-ai/schema/permission-v1"

export class RejectedError extends Schema.TaggedErrorClass<RejectedError>()("PermissionRejectedError", {}) {
  override get message() {
    return "The user rejected permission to use this specific tool call."
  }
}

export class CorrectedError extends Schema.TaggedErrorClass<CorrectedError>()("PermissionCorrectedError", {
  feedback: Schema.String,
}) {
  override get message() {
    return `The user rejected permission to use this specific tool call with the following feedback: ${this.feedback}`
  }
}

export class DeniedError extends Schema.TaggedErrorClass<DeniedError>()("PermissionDeniedError", {
  ruleset: Schema.Any,
}) {
  override get message() {
    return `The user has specified a rule which prevents you from using this specific tool call. Here are some of the relevant rules ${JSON.stringify(this.ruleset)}`
  }
}

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("Permission.NotFoundError", {
  requestID: ID,
}) {}

// #199：AutoDeniedError 不提供可绕过的拒绝信息，防止 agent 通过 shell 包装、
// #199：生成脚本、MCP 工具或其他策略旁路重试同一危险操作。
export class AutoDeniedError extends Schema.TaggedErrorClass<AutoDeniedError>()("PermissionAutoDeniedError", {
  reason: Schema.String,
}) {
  override get message() {
    return `Auto permission preflight rejected this tool call: ${this.reason}. Do not retry the same outcome through shell indirection, generated scripts, alternative tools, MCP tools, or other policy workarounds. Use a materially safer approach, or ask the user for explicit confirmation before attempting a risky operation.`
  }
}

// #199：Error 联合类型纳入 AutoDeniedError，使 caller 通过 Pattern.match 捕获
// #199：确定性拒绝时与 DeniedError 区分——前者不可由用户即时审批撤销。
export type Error = DeniedError | AutoDeniedError | RejectedError | CorrectedError
