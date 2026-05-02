import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import type { Agent } from "./agent"

/**
 * Build the `permission` ruleset for a subagent's session when it's spawned
 * via the task tool. Combines:
 *
 * 1. The parent session's deny rules and external_directory rules.
 *    Ordered parent-agent non-allow restrictions also bound delegation;
 *    matching parent asks and denies take precedence over session grants.
 * 2. Default `todowrite` and `task` denies if the subagent's own ruleset
 *    doesn't already permit them.
 */
export function deriveSubagentSessionPermission(
  input: {
    parentSessionPermission: PermissionV1.Ruleset
    subagent: Agent.Info
  },
  // 父 allow 不扩张子能力；空默认只供没有父代理限制的独立 helper 调用。
  parentAgentPermission: PermissionV1.Ruleset = [],
): PermissionV1.Ruleset {
  const canTask = input.subagent.permission.some((rule) => rule.permission === "task")
  const canTodo = input.subagent.permission.some((rule) => rule.permission === "todowrite")
  return [
    ...input.parentSessionPermission.filter(
      (rule) => rule.permission === "external_directory" || rule.action === "deny",
    ),
    // source 后写父 non-allow：ask/deny 均覆盖会话 grant，原序保留最后匹配语义。
    ...parentAgentPermission.filter((rule) => rule.action !== "allow"),
    ...(canTodo ? [] : [{ permission: "todowrite" as const, pattern: "*" as const, action: "deny" as const }]),
    ...(canTask ? [] : [{ permission: "task" as const, pattern: "*" as const, action: "deny" as const }]),
  ]
}
