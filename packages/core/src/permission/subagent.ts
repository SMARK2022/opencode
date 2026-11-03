export * as SubagentPermissions from "./subagent"

import { Wildcard } from "@opencode-ai/schema/wildcard"
import type { PermissionV2 } from "../permission"
import type { PermissionV1 } from "../v1/permission"

export function derive(input: {
  parentAgentPermission: PermissionV2.Ruleset
  parentSessionPermission: PermissionV2.Ruleset
  subagentPermission: PermissionV2.Ruleset
}): PermissionV2.Ruleset {
  // 仅转换协议字段；两代使用同一有序推导，不能另造更弱的Native近似算法。
  return deriveSubagentSessionPermission(
    {
      parentSessionPermission: legacy(input.parentSessionPermission),
      subagent: { permission: legacy(input.subagentPermission) },
    },
    legacy(input.parentAgentPermission),
  ).map((rule) => ({ action: rule.permission, resource: rule.pattern, effect: rule.action }))
}

function legacy(rules: PermissionV2.Ruleset): PermissionV1.Ruleset {
  return rules.map((rule) => ({ permission: rule.action, pattern: rule.resource, action: rule.effect }))
}

// 子代理自身能力仍是基底；这里只派生父代理准入上限和父会话运行时上限。
export function deriveSubagentSessionPermission(
  input: { parentSessionPermission: PermissionV1.Ruleset; subagent: { permission: PermissionV1.Ruleset } },
  parentAgentPermission: PermissionV1.Ruleset = [],
): PermissionV1.Ruleset {
  const canTask = input.subagent.permission.some((rule) => rule.permission === "task")
  const canTodo = input.subagent.permission.some((rule) => rule.permission === "todowrite")
  const parentHasCatchAllDeny = parentAgentPermission.some((rule) => rule.permission === "*" && rule.action === "deny")
  const ceilings = [
    ...parentAgentPermission.flatMap((rule) =>
      parentAgentCeiling(rule, input.subagent.permission, parentHasCatchAllDeny),
    ),
    ...input.parentSessionPermission.flatMap((rule) => forwardParentSessionRule(rule, input.subagent.permission)),
  ]
  return [
    ...ceilings,
    ...subagentDenyOverrides(input.subagent.permission, ceilings),
    ...(canTodo ? [] : [{ permission: "todowrite" as const, pattern: "*", action: "deny" as const }]),
    ...(canTask ? [] : [{ permission: "task" as const, pattern: "*", action: "deny" as const }]),
  ]
}

function parentAgentCeiling(rule: PermissionV1.Rule, subagent: PermissionV1.Ruleset, parentHasCatchAllDeny: boolean) {
  // 父catch-all约束自执行，不能抹掉controller委派给executor的能力。
  if (rule.permission === "*") return []
  // catch-all deny下只继承edit禁令，保留原计划模式和委派语义。
  if (rule.action === "deny" && parentHasCatchAllDeny && rule.permission !== "edit") return []
  const childAction = evaluateSubagentRule(subagent, rule.permission, rule.pattern)?.action ?? "ask"
  if (rule.action === "allow") {
    // 只保留父子共同允许的例外，不能放宽子代理ask、auto或deny。
    return childAction === "allow" ? [rule] : []
  }
  if (childAction === "deny") return childSpecificCeilings(rule, subagent)
  const action = rule.action
  if (action === childAction) return []
  return [{ ...rule, action }]
}

function forwardParentSessionRule(rule: PermissionV1.Rule, subagent: PermissionV1.Ruleset) {
  // 会话allow同样仅共享例外；其他上限按原顺序传给下一跳。
  if (rule.action === "allow")
    return evaluateSubagentRule(subagent, rule.permission, rule.pattern)?.action === "allow" ? [rule] : []
  const childAction = evaluateSubagentRule(subagent, rule.permission, rule.pattern)?.action ?? "ask"
  if (childAction === "deny") return childSpecificCeilings(rule, subagent)
  const action = rule.action
  if (action === childAction) return []
  return [{ ...rule, action }]
}

function childSpecificCeilings(parent: PermissionV1.Rule, subagent: PermissionV1.Ruleset) {
  // 通配deny兜底后的窄能力必须承接父上限，其他关闭边界保持不变。
  return subagent.flatMap((rule) => {
    if (rule.action === "deny" || rule.permission === "*") return []
    if (!Wildcard.match(rule.permission, parent.permission, process.platform === "win32")) return []
    if (!Wildcard.match(rule.pattern, parent.pattern, process.platform === "win32")) return []
    const action = parent.action
    if (action === rule.action) return []
    return [{ permission: rule.permission, pattern: rule.pattern, action }]
  })
}

function subagentDenyOverrides(subagent: PermissionV1.Ruleset, ceilings: PermissionV1.Ruleset) {
  if (ceilings.length === 0) return []
  // 具体deny置于父宽上限之后；不重放会抹掉窄能力的通配兜底。
  return subagent.filter(
    (rule) =>
      rule.action === "deny" &&
      rule.permission !== "*" &&
      rule.pattern !== "*" &&
      ceilings.some((ceiling) => Wildcard.match(rule.permission, ceiling.permission, process.platform === "win32")),
  )
}

function evaluateSubagentRule(ruleset: PermissionV1.Ruleset, permission: string, pattern: string) {
  return ruleset.findLast(
    (rule) =>
      Wildcard.match(permission, rule.permission, process.platform === "win32") &&
      Wildcard.match(pattern, rule.pattern, process.platform === "win32"),
  )
}
