import type { Permission } from "@/permission"
import { Wildcard } from "@/util/wildcard"

const INTERNAL = new Set(["invalid", "_noop", "StructuredOutput"])

export function isUserConfigurable(id: string) {
  return !INTERNAL.has(id)
}

export function enabled(id: string, ruleset?: Permission.Ruleset) {
  // Internal support tools are not exposed to the model's active tool list, but
  // some provider repair paths still need their definitions to stay registered.
  if (!isUserConfigurable(id)) return true
  // This is intentionally exact-tool matching, separate from permission's
  // edit/write/apply_patch grouping, because this controls model exposure only.
  const rule = ruleset?.findLast((rule) => Wildcard.match(id, rule.permission) && rule.pattern === "*")
  return rule?.action !== "deny"
}

export * as ToolSelection from "./selection"
