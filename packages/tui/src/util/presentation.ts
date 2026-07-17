import { Locale } from "./locale"
const logo = {
  left: ["                   ", "█▀▀█ █▀▀█ █▀▀█ █▀▀▄", "█__█ █__█ █^^^ █__█", "▀▀▀▀ █▀▀▀ ▀▀▀▀ ▀~~▀"],
  right: ["             ▄     ", "█▀▀▀ █▀▀█ █▀▀█ █▀▀█", "█___ █__█ █__█ █^^^", "▀▀▀▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀"],
}

const reset = "\x1b[0m"
const bold = "\x1b[1m"
const dim = "\x1b[90m"

function wordmark(pad = "") {
  const draw = (line: string, fg: string, shadow: string, bg: string) =>
    [...line]
      .map((char) => {
        if (char === "_") return `${bg} ${reset}`
        if (char === "^") return `${fg}${bg}▀${reset}`
        if (char === "~") return `${shadow}▀${reset}`
        if (char === " ") return " "
        return `${fg}${char}${reset}`
      })
      .join("")

  return logo.left.map((line, index) => {
    const left = draw(line, dim, "\x1b[38;5;235m", "\x1b[48;5;235m")
    const right = draw(logo.right[index] ?? "", reset, "\x1b[38;5;238m", "\x1b[48;5;238m")
    return `${pad}${left} ${right}`
  })
}


// #490：退出文本沿用 sidebar 的 USD 两位小数格式，避免永久记录和实时面板出现不同 cost 文案。
// formatter 不负责计算 cost，只接受 accounting 已经归属到 Session 的数值。
const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" })

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

  // #490：每个字段单独门控，避免 input-only 的永久记录出现误导性的零 output/cost。
  // input/output 属于同一 flow 组保持空格分隔；cost 用中点隔开；无 flow 时直接显示 cost。
  return cost ? (flow.length ? `${flow.join(" ")} · ${cost}` : cost) : flow.join(" ")
}

export function sessionEpilogue(input: { title: string; sessionID?: string; usage?: UsageStats }) {
  const weak = (text: string) => `${dim}${text.padEnd(10, " ")}${reset}`
  const stats = input.usage ? formatUsageStats(input.usage) : ""
  return [
    ...wordmark("  "),
    "",
    `  ${weak("Session")}${bold}${input.title}${reset}`,
    // #490：Stats 只作为有实际 usage 时的一行补充；零字段不人为补造。
    ...(stats ? [`  ${weak("Stats")}${bold}${stats}${reset}`] : []),
    `  ${weak("Continue")}${bold}opencode -s ${input.sessionID}${reset}`,
    "",
  ].join("\n")
}
