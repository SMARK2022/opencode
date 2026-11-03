import type { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { ToolSelection } from "@opencode-ai/core/tool/selection"

export const isUserConfigurable = ToolSelection.isUserConfigurable

export function enabled(id: string, ruleset?: PermissionV1.Ruleset) {
  return ToolSelection.enabled(
    id,
    ruleset?.map((rule) => ({ action: rule.permission, resource: rule.pattern, effect: rule.action })),
  )
}

export * as ToolSelection from "./selection"
