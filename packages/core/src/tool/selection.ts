export * as ToolSelection from "./selection"

import type { PermissionV2 } from "../permission"
import { Wildcard } from "../util/wildcard"

const INTERNAL = new Set(["invalid", "_noop", "StructuredOutput"])

export function isUserConfigurable(id: string) {
  return !INTERNAL.has(id)
}

export function enabled(id: string, rules: PermissionV2.Ruleset = []) {
  // 内部定义供provider修复使用，不参与用户的能力开关。
  if (!isUserConfigurable(id)) return true
  // 这里只按工具原名与全局资源筛选；执行授权继续由leaf的权限分组负责。
  const rule = rules.findLast(rule => Wildcard.match(id, rule.action) && rule.resource === "*")
  return rule?.effect !== "deny"
}
