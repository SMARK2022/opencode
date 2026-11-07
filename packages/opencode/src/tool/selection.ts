import type { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { ToolSelection } from "@opencode-ai/core/tool/selection"
import { Permission } from "@/permission"

export const isUserConfigurable = ToolSelection.isUserConfigurable

export function enabled(id: string, ruleset?: PermissionV1.Ruleset) {
  return ToolSelection.enabled(id, ruleset?.map(rule => ({ action: rule.permission, resource: rule.pattern, effect: rule.action })))
}

// provider 目录与脚本目录使用同一筛选，关闭工具后两种入口保持一致。
export function filter<T>(tools: Record<string, T>, agent: PermissionV1.Ruleset, permission?: PermissionV1.Ruleset, user?: Record<string, boolean>) {
  // user.tools 是本轮输入选择，Session permission 是实时开关，两者不能互相覆盖。
  const disabled = Permission.disabled(Object.keys(tools), Permission.merge(agent, permission ?? []))
  return Object.fromEntries(Object.entries(tools).filter(([id]) =>
    !isUserConfigurable(id) || (user?.[id] !== false && !disabled.has(id) && enabled(id, permission)),
  ))
}

export * as ToolSelection from "./selection"
