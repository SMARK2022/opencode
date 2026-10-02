export * as PermissionV1 from "./permission"

import { Schema } from "effect"
export * from "@opencode-ai/schema/permission-v1"
import { ID } from "@opencode-ai/schema/permission-v1"

export class RejectedError extends Schema.TaggedErrorClass<RejectedError>()("PermissionRejectedError", {}) {
  override get message() {
    // 用户拒绝禁止原样重试或立即重问，但不阻止安全替代与其他已授权工作。
    return "The user rejected permission for this specific tool call. Do not retry the same call or re-ask immediately; switch to a safer alternative or continue other authorized work. If the task is blocked, explain what was rejected and ask the user once."
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
// [local-smark] #627：terminal=true 标记三级分级中的 forbidden 终审拒绝——
// 该类操作（保护根/家/驱动器根递归删除等）即使用户显式授权也不可放行，
// 文案分叉避免 agent 尝试向用户索取授权后重试。
export class AutoDeniedError extends Schema.TaggedErrorClass<AutoDeniedError>()("PermissionAutoDeniedError", {
  reason: Schema.String,
  terminal: Schema.optional(Schema.Boolean),
}) {
  override get message() {
    // [local-smark] 终审文案：明示不存在授权路径（"请用户确认"对 forbidden 是
    // 虚假逃生口，会诱发换形态重试循环）；默认文案保留可授权重试路径
    const tail = this.terminal
      ? " Use a materially safer approach. This operation is terminally forbidden: it cannot be executed even with explicit user authorization."
      // 非终局拒绝给出安全替代、改变事实的取证和继续其他工作，原终局门禁保持不变。
      : " You may: switch to a materially safer approach; gather read-only evidence that changes this assessment and retry; or complete unaffected work without asking for confirmation. If the task stays blocked, report in one short paragraph what was rejected and why, and ask the user for approval once."
    return `Auto permission preflight rejected this tool call: ${this.reason}. Do not retry the same outcome through shell indirection, generated scripts, alternative tools, MCP tools, or other policy workarounds.${tail}`
  }
}

// #199：Error 联合类型纳入 AutoDeniedError，使 caller 通过 Pattern.match 捕获
// #199：确定性拒绝时与 DeniedError 区分——前者不可由用户即时审批撤销。
export type Error = DeniedError | AutoDeniedError | RejectedError | CorrectedError
