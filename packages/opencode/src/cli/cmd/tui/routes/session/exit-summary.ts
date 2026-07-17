import { UI } from "@/cli/ui"
import { Locale } from "@/util/locale"

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
})
// 退出文本沿用 sidebar 的 USD 两位小数格式，避免永久记录和实时面板出现不同 cost 文案。
// formatter 不负责计算 cost，只接受 accounting 已经归属到 Session 的数值。

export type UsageStats = {
  input: number
  output: number
  cost: number
}

export function formatUsageStats(usage: UsageStats) {
  const flow = [
    usage.input > 0 ? `↑${Locale.number(usage.input)}` : "",
    usage.output > 0 ? `↓${Locale.number(usage.output)}` : "",
  ].filter(Boolean)
  const cost = usage.cost > 0 ? money.format(usage.cost) : ""

  // 每个字段单独门控，避免 input-only 的永久记录出现误导性的零 output/cost。
  // input 和 output 属于同一 flow 组，保持既有 footer 的空格分隔；cost 继续用中点隔开。
  // 这种拼接顺序让 output-only、cost-only 也能保持合法文本，而不补造零字段。
  // 没有 flow 时直接显示 cost，避免产生孤立的分隔符或空 Stats 内容。
  return cost ? (flow.length ? `${flow.join(" ")} · ${cost}` : cost) : flow.join(" ")
}

export function formatSessionExitMessage(input: { title: string; sessionID?: string; usage: UsageStats }) {
  const title = Locale.truncate(input.title, 50)
  const pad = (text: string) => text.padEnd(10, " ")
  const weak = (text: string) => UI.Style.TEXT_DIM + pad(text) + UI.Style.TEXT_NORMAL
  const logo = UI.logo("  ").split(/\r?\n/)
  const stats = formatUsageStats(input.usage)

  // Session/Continue 是原有退出记录；Stats 只作为有实际 usage 时的一行补充。
  // 退出发生在 renderer 销毁之后，所以这里必须生成完整文本，不能依赖 TUI 节点继续存在。
  // title 只在 formatter 边界截断，避免 route 与 stdout 使用不同的长度规则。
  // sessionID 缺失时保留既有命令形状，不把退出路径改成异常或空输出。
  return [
    `${logo[0] ?? ""}`,
    `${logo[1] ?? ""}`,
    `${logo[2] ?? ""}`,
    `${logo[3] ?? ""}`,
    ``,
    `  ${weak("Session")}${UI.Style.TEXT_NORMAL_BOLD}${title}${UI.Style.TEXT_NORMAL}`,
    ...(stats ? [`  ${weak("Stats")}${UI.Style.TEXT_NORMAL_BOLD}${stats}${UI.Style.TEXT_NORMAL}`] : []),
    `  ${weak("Continue")}${UI.Style.TEXT_NORMAL_BOLD}opencode -s ${input.sessionID ?? "undefined"}${UI.Style.TEXT_NORMAL}`,
    ``,
  ].join("\n")
}
