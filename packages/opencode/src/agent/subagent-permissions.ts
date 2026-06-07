import type { Permission } from "../permission"
import type { Agent } from "./agent"
import { Wildcard } from "@/util/wildcard"

/**
 * Build the `permission` ruleset for a subagent's session when it's spawned
 * via the task tool. Combines:
 *
 * 1. The parent **agent's** edit-class deny rules — Plan Mode's file-edit
 *    restriction lives on the agent ruleset, not on the session, so a
 *    subagent that only inherited the parent SESSION's permission would
 *    silently bypass it. (#26514)
 * 2. The parent **agent's** explicit admission ceilings — `ask` and `auto`
 *    make subagent execution no less strict than the delegating agent without
 *    coupling the behavior to a specific agent name.
 * 3. The parent **session's** runtime ceilings — nested subagents inherit
 *    already-derived `ask`/`auto`/`deny` overlays, while `allow` exceptions are
 *    preserved only when the child agent already allows the same boundary.
 * 4. Default `todowrite` and `task` denies if the subagent's own ruleset
 *    doesn't already permit them.
 */
export function deriveSubagentSessionPermission(input: {
  parentSessionPermission: Permission.Ruleset
  parentAgent: Agent.Info | undefined
  subagent: Agent.Info
}): Permission.Ruleset {
  const canTask = input.subagent.permission.some((rule) => rule.permission === "task")
  const canTodo = input.subagent.permission.some((rule) => rule.permission === "todowrite")
  const parentHasCatchAllDeny = input.parentAgent?.permission.some(
    (rule) => rule.permission === "*" && rule.action === "deny",
  )
  const ceilings = [
    ...(input.parentAgent?.permission.flatMap((rule) => parentAgentCeiling(rule, input.subagent.permission, parentHasCatchAllDeny)) ?? []),
    ...input.parentSessionPermission.flatMap((rule) => forwardParentSessionRule(rule, input.subagent.permission)),
  ]

  return [
    ...ceilings,
    ...subagentDenyOverrides(input.subagent.permission, ceilings),
    ...(canTodo ? [] : [{ permission: "todowrite" as const, pattern: "*" as const, action: "deny" as const }]),
    ...(canTask ? [] : [{ permission: "task" as const, pattern: "*" as const, action: "deny" as const }]),
  ]
}

function parentAgentCeiling(rule: Permission.Rule, subagent: Permission.Ruleset, parentHasCatchAllDeny: boolean | undefined) {
  // Catch-all parent rules are self-execution defaults. Forwarding `*: deny`
  // would erase controller/executor style agents that intentionally delegate
  // work to a narrower subagent despite being personally tool-restricted.
  if (rule.permission === "*") return []
  // When a parent is primarily self-restricted by `*: deny`, its extra explicit
  // denies are usually UI/tool-selection detail. Preserve the existing Plan Mode
  // edit ceiling, but do not turn controller bash/read self-denies into executor
  // denials. Parents without a catch-all still pass explicit denies as ceilings.
  if (rule.action === "deny" && parentHasCatchAllDeny && rule.permission !== "edit") return []

  const childAction = evaluateSubagentRule(subagent, rule.permission, rule.pattern)?.action ?? "ask"
  if (rule.action === "allow") {
    // Parent allow may preserve a shared internal exception, but it must never
    // broaden a child ask/auto/deny into allow.
    return childAction === "allow" ? [rule] : []
  }
  if (childAction === "deny") return childSpecificCeilings(rule, subagent)

  const action = rule.action
  if (action === childAction) return []
  return [{ ...rule, action }]
}

function forwardParentSessionRule(rule: Permission.Rule, subagent: Permission.Ruleset) {
  // Session allow rules are forwarded only as shared exceptions. They cannot
  // relax a child agent that would otherwise ask, auto-review, or deny.
  if (rule.action === "allow")
    return evaluateSubagentRule(subagent, rule.permission, rule.pattern)?.action === "allow" ? [rule] : []

  const childAction = evaluateSubagentRule(subagent, rule.permission, rule.pattern)?.action ?? "ask"
  if (childAction === "deny") return childSpecificCeilings(rule, subagent)
  const action = rule.action
  if (action === childAction) return []
  return [{ ...rule, action }]
}

function childSpecificCeilings(parent: Permission.Rule, subagent: Permission.Ruleset) {
  // A child may expose narrow capabilities behind a `*: deny` fallback. When a
  // broad parent ceiling meets that fallback, derive ceilings for the narrow
  // child patterns instead of widening everything or dropping the parent ceiling.
  return subagent.flatMap((rule) => {
    if (rule.action === "deny") return []
    if (rule.permission === "*") return []
    if (!Wildcard.match(rule.permission, parent.permission)) return []
    if (!Wildcard.match(rule.pattern, parent.pattern)) return []
    const action = parent.action
    if (action === rule.action) return []
    return [{ permission: rule.permission, pattern: rule.pattern, action }]
  })
}

function subagentDenyOverrides(subagent: Permission.Ruleset, ceilings: Permission.Ruleset) {
  if (ceilings.length === 0) return []
  // A child-specific deny must stay terminal when a broader parent auto/ask
  // ceiling was appended after the child agent rules. Do not repeat wildcard
  // fallback denies; read-only subagents use those fallbacks together with
  // explicit allow rules, and replaying the fallback here would erase the narrow
  // ceilings derived from their own allows.
  return subagent.filter(
    (rule) =>
      rule.action === "deny" &&
      rule.permission !== "*" &&
      rule.pattern !== "*" &&
      ceilings.some((ceiling) => Wildcard.match(rule.permission, ceiling.permission)),
  )
}

function evaluateSubagentRule(ruleset: Permission.Ruleset, permission: string, pattern: string) {
  return ruleset.findLast((rule) => Wildcard.match(permission, rule.permission) && Wildcard.match(pattern, rule.pattern))
}
