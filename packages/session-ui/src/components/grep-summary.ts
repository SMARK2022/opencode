import type { UiI18n } from "@opencode-ai/ui/context/i18n"

export function grepSummary(
  input: Record<string, unknown>,
  metadata: Record<string, unknown>,
  i18n: Pick<UiI18n, "t" | "plural">,
) {
  // 普通卡片与分组摘要共用同一投影，Native和历史V1结果都不能漏掉不完整状态。
  const filters = ([false, true] as const).flatMap((exclude) => {
    const value = exclude ? input.exclude : input.include
    const items = (
      typeof value === "string"
        ? [value]
        : Array.isArray(value)
          ? value.filter((item): item is string => typeof item === "string")
          : []
    )
      .filter(Boolean)
      .map((item) => (exclude && !item.startsWith("!") ? `!${item}` : item))
    // include最多两项、exclude一项；其余数量保留，不把整列参数铺满时间线。
    const shown = items.slice(0, exclude ? 1 : 2)
    return shown.length
      ? [`${shown.join(",")}${items.length > shown.length ? ` +${items.length - shown.length}` : ""}`]
      : []
  })
  const count =
    typeof metadata.matches === "number"
      ? metadata.matches
      : Array.isArray(metadata.items)
        ? metadata.items.length
        : undefined
  const result =
    count === undefined || (count === 0 && metadata.timedOut === true)
      ? ""
      : metadata.truncated === true
        ? i18n.t("ui.tool.grep.truncated", { count })
        : i18n.plural("ui.tool.grep.matches", count)
  const status =
    metadata.timedOut !== true
      ? result
      : result
        ? i18n.t("ui.tool.grep.incomplete", { result })
        : i18n.t("ui.tool.grep.timedOut")
  return [typeof input.pattern === "string" ? input.pattern : "", ...filters, status].filter(Boolean)
}
