import type { StatsReport, TokenPartSeries, TokenTotals, UsageGroup, UsageSeries } from "./data"
import { formatNumber } from "../../format"
import {
  dailySeries,
  metricFormatter,
  palette,
  renderCallout,
  renderComparisonTable,
  renderHeatmap,
  renderPercentStack,
  renderRoundedLineChart,
  renderTabs,
  renderThreeColumn,
  renderTwoColumn,
  seriesFromUsage,
  seriesColor,
  padEndVisible,
  padStartVisible,
  statsContentWidth,
  terminalText,
  visibleLength,
  wrapAnsiVisible,
  wrapVisible,
  useColor as chartUseColor,
  type ChartColor,
  type SeriesColor,
} from "./charts"

export { formatNumber } from "../../format"

const BOLD = "\x1b[1m"
const TEXT_RESET = "\x1b[22m\x1b[39m"
// 49m 只恢复终端默认背景，不指定具体颜色；stats 的行填充必须避免继承上游残留背景。
const BACKGROUND_RESET = "\x1b[49m"

const theme = {
  // 页面别名只复用 charts 的唯一 ANSI palette，不能重新引入独立 RGB 色盘。
  title: palette.title,
  subtitle: palette.subtitle,
  muted: palette.muted,
  border: palette.grid,
  sep: palette.axis,
  blue: palette.blue,
  cyan: palette.cyan,
  green: palette.green,
  yellow: palette.yellow,
  orange: palette.orange,
  purple: palette.purple,
  pink: palette.pink,
  red: palette.red,
  white: palette.white,
  lavender: palette.purple,
  mauve: palette.pink,
  tealSoft: palette.cyan,
  amberSoft: palette.yellow,
  roseSoft: palette.red,
}

export type ColorMode = "auto" | "always" | "never"
export type StatsRenderOptions = {
  color?: ColorMode
  limit?: number
  metric?: "tokens" | "cost"
  sort?: "cost" | "tokens" | "calls" | "updated"
  by?: BreakdownDimension
  heatmap?: boolean
}

export type BreakdownDimension = "model" | "provider" | "agent" | "source" | "project" | "tool" | "status"

export const useColor = chartUseColor

const color = (text: string, name: keyof typeof theme, enabled: boolean, bold = false) => {
  if (!enabled) return text
  return `${bold ? BOLD : ""}${theme[name]}${text}${TEXT_RESET}`
}

const panel = (lines: string[], enabled: boolean) => {
  // panel 是最终宽度边界：允许增加行数，但禁止截断或插入省略号。
  // 宽度不足属于布局问题，不应通过隐藏数据伪装成成功渲染。
  const width = statsContentWidth()
  const rows = lines.flatMap((line) => wrapAnsiVisible(line, width))
    .map((line) => `  ${padEndVisible(line, width)}  `)
  if (!enabled) return rows.join("\n")
  return rows.map((line) => `${BACKGROUND_RESET}${line}${BACKGROUND_RESET}`).join("\n")
}

const dateRange = (report: StatsReport) => {
  // requestedDays 是用户意图；undefined 必须显示 all-time，而不是猜测首尾日期。
  if (report.requestedDays === 0) return "Today"
  if (report.requestedDays) return `Last ${report.requestedDays} days`
  return "All time"
}

const shortDate = (time: number) => {
  const date = new Date(time)
  return `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`
}

const money = (value: number) => {
  // 紧凑金额格式按量级减少小数，零值使用破折号以降低表格噪声。
  if (!Number.isFinite(value) || value <= 0) return "—"
  if (value >= 100) return `$${value.toFixed(0)}`
  if (value >= 10) return `$${value.toFixed(1)}`
  if (value >= 1) return `$${value.toFixed(2)}`
  return `$${value.toFixed(4)}`
}

const percent = (value: number, total: number) => {
  // 零分母统一为 0%，任何页面都不应泄漏 NaN/Infinity。
  if (!total) return "0.0%"
  return `${((value / total) * 100).toFixed(1)}%`
}

const metricBar = (value: number, max: number, width: number, enabled: boolean, name: keyof typeof theme) => {
  const filled = max <= 0 ? 0 : Math.round((value / max) * width)
  return color("█".repeat(filled), name, enabled) + color("░".repeat(Math.max(0, width - filled)), "border", enabled)
}

const title = (text: string, enabled: boolean) => color(text, "title", enabled, true)
const muted = (text: string, enabled: boolean) => color(text, "muted", enabled)
const sep = (enabled: boolean) => color(" · ", "sep", enabled)
const clipVisible = (text: string, width: number) => {
  if (visibleLength(text) <= width) return text
  return Array.from(text).reduce(
    (acc, char) => visibleLength(acc + char) > width ? acc : acc + char,
    "",
  )
}
const fitPlain = (text: string, width: number) => padEndVisible(clipVisible(text, width), width)
const wrapWhenNeeded = (text: string, width: number) => visibleLength(text) <= width ? [text] : wrapVisible(text, width)
const fullChartWidth = () => Math.max(12, statsContentWidth() - 8)
// plot 预留 Y 轴和一个空格；最小值只保证坐标可读，不强制桌面宽度。
const terminalContentWidth = () => statsContentWidth()
const layoutModeFor = (width: number) => width >= 130 ? "wide" : "medium"
const chartPlotWidth = (availableWidth: number) => Math.max(12, availableWidth - 8)

const dailyTokenPoints = (report: StatsReport) =>
  report.daily.map((item) => ({ day: item.day, label: shortDate(item.day), value: item.tokens.total }))

const dailyCostPoints = (report: StatsReport) =>
  report.daily.map((item) => ({ day: item.day, label: shortDate(item.day), value: item.cost }))

const dailyCacheHitPoints = (report: StatsReport) =>
  report.daily.map((item) => ({ day: item.day, label: shortDate(item.day), value: item.tokens.total > 0 ? (item.tokens.cache.read / item.tokens.total) * 100 : 0 }))

const dailyErrorRatePoints = (report: StatsReport) =>
  report.daily.map((item) => ({ day: item.day, label: shortDate(item.day), value: item.requests > 0 ? ((item.errors + item.aborted) / item.requests) * 100 : 0 }))

const safeDivide = (value: number, divisor: number) => {
  // 所有派生比率共用同一零值保护，避免不同端点出现不一致的异常格式。
  if (!divisor || !Number.isFinite(value) || !Number.isFinite(divisor)) return 0
  return value / divisor
}

const avgDuration = (durationMs: number, requests: number) => {
  const seconds = safeDivide(durationMs, requests) / 1000
  if (seconds >= 60) return `${(seconds / 60).toFixed(1)}m`
  return `${seconds.toFixed(1)}s`
}

const cacheShare = (tokens: TokenTotals) => percent(tokens.cache.read + tokens.cache.write, tokens.total)
const outputTokens = (tokens: TokenTotals) => tokens.output + tokens.reasoning
const inputContextTokens = (group: UsageGroup) =>
  // Context fingerprint 只统计输入构成，不把输出 token 重复计入上下文。
  group.components.system +
  group.components.instructions +
  group.components.skills +
  group.components.toolSchemas +
  group.components.userMessages +
  group.components.assistantText +
  group.components.reasoning +
  group.components.toolCalls +
  group.components.toolResults +
  group.components.attachments

const sparkline = (values: number[], width: number, enabled: boolean, name: keyof typeof theme) => {
  const chars = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"]
  const max = Math.max(0, ...values.filter(Number.isFinite))
  const sampled = Array.from({ length: width }, (_, index) => {
    if (values.length === 0) return 0
    return values[Math.round((index / Math.max(1, width - 1)) * (values.length - 1))] ?? 0
  })
  return sampled.map((value) => color(chars[max <= 0 ? 0 : Math.min(chars.length - 1, Math.floor((value / max) * (chars.length - 1)))], name, enabled)).join("")
}

const breakdownTitle = (by: BreakdownDimension) => {
  // 标题映射是用户可见词汇，wrapper 和 canonical breakdown 必须共享。
  if (by === "model") return "Models"
  if (by === "provider") return "Providers"
  if (by === "agent") return "Agents"
  if (by === "source") return "Sources"
  if (by === "project") return "Projects"
  if (by === "status") return "Request status"
  return "Tools"
}

const breakdownPageTitle = (by: BreakdownDimension) => {
  if (by === "model") return "Model"
  if (by === "provider") return "Provider"
  if (by === "agent") return "Agent"
  if (by === "source") return "Source"
  if (by === "project") return "Project"
  if (by === "status") return "Status"
  return "Tool"
}

const breakdownGroups = (report: StatsReport, by: BreakdownDimension) => {
  // Tool 数据结构不同于 UsageGroup，工具分支在 renderBreakdown 中单独处理。
  if (by === "model") return report.models
  if (by === "provider") return report.providers
  if (by === "agent") return report.agents
  if (by === "source") return report.sources
  if (by === "project") return report.projects
  if (by === "status") return report.statuses
  return []
}

const breakdownSeries = (report: StatsReport, by: BreakdownDimension) => {
  // 聚合表和趋势必须取自同一维度，不能出现排名与折线标签错位。
  if (by === "model") return report.modelSeries
  if (by === "provider") return report.providerSeries
  if (by === "agent") return report.agentSeries
  if (by === "source") return report.sourceSeries
  if (by === "project") return report.projectSeries
  if (by === "status") return report.statusSeries
  return []
}

const statusColor = (status: string): SeriesColor => {
  // Outcome 颜色表达 success/error/warning，而不是该状态恰好排在第几个系列。
  // 未知或运行中状态回退为 info blue，避免误报成功或失败。
  if (status === "completed") return "green"
  if (status === "error") return "red"
  if (status === "aborted") return "yellow"
  return "blue"
}

type AnalyticalRow = {
  label: string
  values: string[]
  color?: SeriesColor
  valueColors?: (SeriesColor | undefined)[]
}

// 指标文本与可选语义色成对返回，保证 marker、颜色和格式化值不会在调用处各算一遍后漂移。
type AnalyticalValue = {
  text: string
  color?: SeriesColor
}

const highOutlier = (value: number, population: number[], format: (input: number) => string): AnalyticalValue => {
  const values = population.filter(Number.isFinite)
  const text = format(value)
  // 少于三个可比较样本或没有方差时，sigma 没有可靠区分力；此时只显示原始精确值。
  if (!Number.isFinite(value) || values.length < 3) return { text }
  // 使用 population 标准差与 Insights 保持口径一致；这里描述当前完整集合，不估计外部样本。
  const average = values.reduce((sum, item) => sum + item, 0) / values.length
  const deviation = Math.sqrt(values.reduce((sum, item) => sum + (item - average) ** 2, 0) / values.length)
  // 只标记高侧异常；低费用、低失败率和低时延不是风险，不能用同一颜色制造反向告警。
  if (deviation === 0 || value <= average) return { text }
  const sigma = (value - average) / deviation
  // 记号是无色模式的等价编码；颜色只加速扫描，不能成为异常结论的唯一载体。
  if (sigma >= 3) return { text: `${text}!`, color: "red" }
  if (sigma >= 2) return { text: `${text}^`, color: "orange" }
  return { text }
}

// 宽屏用可横向比较的表格，窄屏改为完整标签加指标行。这里不截断实体名，
// 因为模型、项目和会话名称本身就是定位异常所需的数据，而不是装饰文本。
const renderAnalyticalTable = (input: {
  title: string
  label: string
  headers: string[]
  rows: AnalyticalRow[]
  // 分类色必须由调用方显式启用，防止日期或普通排行因复用表格而出现无意义彩虹色。
  identityColors?: boolean
  color?: ColorMode
}) => {
  // 宽屏保留列比较，窄屏改为逐实体 key/value；两种布局承载完全相同的数据。
  // 响应式判断只看可见宽度，不依赖 ANSI 字节数。
  const enabled = useColor(input.color)
  const width = statsContentWidth()
  // 表格单元均为数据文本而非受信样式，进入 chart primitive 前统一移除控制字节。
  const rows = input.rows.map((row, index) => ({
    label: terminalText(row.label),
    values: row.values.map(terminalText),
    // 第一列默认沿用趋势图系列色；调用方只需为异常值或短趋势显式指定 valueColors。
    // 只有跨 section 保持同一身份的实体才自动继承系列色；日期等普通排行继续使用默认前景。
    color: row.color ?? (input.identityColors ? seriesColor(index) : undefined),
    valueColors: row.valueColors,
  }))
  const table = renderComparisonTable({
    title: input.title,
    headers: [input.label, ...input.headers],
    rows: rows.map((row) => [row.label, ...row.values]),
    colors: rows.map((row) => [row.color, ...(row.valueColors ?? [])]),
    color: input.color,
  })
  const heading = [...renderSectionDivider(input.title, enabled, width), ""]
  // 只有完整实体名与全部列都能容纳时才使用横表；否则立即改为逐实体布局，不生成二次查找键。
  if (width >= 100 && table.every((line) => visibleLength(line) <= width)) return [...heading, ...table.slice(1)]
  return [
    ...heading,
    ...rows.flatMap((row) => [
      ...wrapVisible(row.label, width).map((line) => color(line, row.color ?? "white", enabled, true)),
      ...wrapAnsiVisible(input.headers.map((header, column) => `${muted(header, enabled)} ${color(row.values[column], row.valueColors?.[column] ?? "white", enabled, row.valueColors?.[column] !== undefined)}`).join(sep(enabled)), Math.max(12, width - 2))
        .map((line) => `  ${line}`),
    ]),
  ]
}

const activeDays = (series: UsageSeries | undefined) =>
  series?.points.filter((point) => point.tokens.total > 0 || point.cost > 0 || point.requests > 0).length ?? 0

const failureRate = (group: UsageGroup) => percent(group.errors + group.aborted, group.requests)

const renderBreakdownTrend = (
  groups: UsageGroup[],
  allSeries: UsageSeries[],
  metric: "tokens" | "cost",
  titleText: string,
  colorMode?: ColorMode,
) => {
  // 最多五条线与 Dashboard 的低重叠原则一致，更多实体留在下方分析表。
  const selected = groups.slice(0, 5)
  // 颜色属于原可见实体位置；某条历史 series 缺失时，后续实体不能被压缩后重新编号。
  const identityColors = new Map(selected.map((group, index) => [group.id, seriesColor(index)]))
  const series = seriesFromUsage(
    selected.flatMap((group) => {
      const item = allSeries.find((candidate) => candidate.id === group.id)
      return item ? [item] : []
    }),
    metric,
    5,
  ).map((item) => {
    const identityColor = identityColors.get(item.id) ?? seriesColor(0)
    return { ...item, label: terminalText(item.label), color: identityColor }
  })
  // 线内不放点和文字；图下直接列完整名称与绝对量级，颜色不成为唯一归因手段。
  const title = titleText === "Sources"
    ? `${metric === "cost" ? "Cost" : "Token"} trend · request sources`
    : `${metric === "cost" ? "Cost" : "Token"} trend · top ${series.length} ${titleText.toLowerCase()}`
  const chart = renderRoundedLineChart({
      title,
      series,
      color: colorMode,
      metric,
      width: fullChartWidth(),
      height: 8,
      points: false,
      legend: false,
    })
  return [
    ...renderSectionDivider(title, useColor(colorMode), statsContentWidth()),
    "",
    ...chart.slice(1),
    ...wrapAnsiVisible(series.map((item) => color(`${item.label} ${metricFormatter(metric)(item.total ?? 0)}`, item.color, useColor(colorMode), true)).join(sep(useColor(colorMode))), statsContentWidth()),
  ]
}

const inputContextRows = (groups: UsageGroup[]) =>
  groups.map((group) => {
    // 每行以自身 context 为分母，才能比较不同规模实体的结构差异。
    const total = inputContextTokens(group)
    return {
      label: group.label,
      values: [
        percent(group.components.system, total),
        percent(group.components.instructions, total),
        percent(group.components.skills, total),
        percent(group.components.toolSchemas, total),
        percent(group.components.userMessages, total),
        percent(group.components.assistantText, total),
        percent(group.components.reasoning, total),
        percent(group.components.toolCalls, total),
        percent(group.components.toolResults, total),
        percent(group.components.attachments, total),
      ],
    }
  })

const mixText = (items: { id: string; value: number }[], limit = 3) => {
  // Mix 最多展开前三项；其余显式归入 other，百分比才能闭合为完整集合而不是静默消失。
  const sorted = [...items].filter((item) => item.value > 0).sort((a, b) => b.value - a.value)
  const total = sorted.reduce((sum, item) => sum + item.value, 0)
  if (total === 0) return "—"
  const other = sorted.slice(limit).reduce((sum, item) => sum + item.value, 0)
  return [...sorted.slice(0, limit), ...(other > 0 ? [{ id: "other", value: other }] : [])]
    .map((item) => `${terminalText(item.id)} ${percent(item.value, total)}`)
    .join(" · ")
}

const tokenMix = (items: { id: string; tokens: number }[]) => mixText(items.map((item) => ({ id: item.id, value: item.tokens })))

const callMix = (calls: StatsReport["toolCalls"], pick: (call: StatsReport["toolCalls"][number]) => string) => {
  // calls 已经过 CLI owner filter；这里仅切换观察维度，不再次改变样本集合。
  const totals = new Map<string, number>()
  calls.forEach((call) => totals.set(pick(call), (totals.get(pick(call)) ?? 0) + call.calls))
  return mixText(Array.from(totals, ([id, value]) => ({ id, value })))
}

const toolCallsFor = (
  report: StatsReport,
  key: "modelID" | "providerID" | "agent" | "projectID" | "source" | "status" | "toolID",
  id: string,
) =>
  // 关联键使用稳定 id 而不是可变 label，Project 同名时也不会把调用混在一起。
  report.toolCalls.filter((call) => call[key] === id)

const renderModelTokenComposition = (groups: UsageGroup[], options: StatsRenderOptions) => {
  const enabled = useColor(options.color)
  const width = statsContentWidth()
  return [
    ...renderSectionDivider("Token composition", enabled, width),
    "",
    ...renderPercentStack({
      width,
      color: options.color,
      rows: groups.map((group, index) => ({
        label: group.label,
        // 模型身份继续沿用主折线色；组成段颜色则固定表达 token 语义，二者不能混用。
        color: seriesColor(index),
        parts: [
          { label: "input", value: group.tokens.input, color: "blue" },
          { label: "output", value: group.tokens.output, color: "green" },
          { label: "reasoning", value: group.tokens.reasoning, color: "purple" },
          { label: "cache read", value: group.tokens.cache.read, color: "yellow" },
          { label: "cache write", value: group.tokens.cache.write, color: "pink" },
        ],
      })),
    }),
  ]
}

const renderDimensionDetails = (
  report: StatsReport,
  groups: UsageGroup[],
  by: Exclude<BreakdownDimension, "tool">,
  options: StatsRenderOptions,
) => {
  if (by === "model") {
    // Model 页先拆开 token 结构，再展示 Provider 路由和实际发起的 ToolPart。
    // 这两节分别回答“上下文为何大”和“模型被怎样路由/使用”，不能合成单一排行。
    return [
      ...renderModelTokenComposition(groups, options),
      "",
      ...renderAnalyticalTable({
        title: "Routing & tools",
        label: "model",
        identityColors: true,
        headers: ["provider mix by tokens", "issued tool calls"],
        rows: groups.map((group) => ({
          label: group.label,
          values: [tokenMix(group.providers), callMix(toolCallsFor(report, "modelID", group.id), (call) => call.toolID)],
        })),
        color: options.color,
      }),
      ...wrapVisible("Tool shares count ToolParts issued by each model; they are not Tool cost or billed tokens.", statsContentWidth()).map((line) => muted(line, useColor(options.color))),
    ]
  }
  if (by === "provider") {
    // Provider 的模型组合解释容量来源，可靠性表则只使用该 Provider 拥有的 request 指标。
    // secondary Assistant 可能有 token/cost 却没有 owned req，这是合法的零值而非数据丢失。
    const series = breakdownSeries(report, "provider")
    // errors/aborted 是独立结果，分别比较才能避免一个字段掩盖另一个字段的尖峰。
    const errorPopulation = report.providers.map((group) => group.errors)
    const abortedPopulation = report.providers.map((group) => group.aborted)
    return [
      ...renderAnalyticalTable({
        title: "Model portfolio by provider",
        label: "provider",
        identityColors: true,
        headers: ["models by tokens"],
        rows: groups.map((group) => ({ label: group.label, values: [tokenMix(group.models)] })),
        color: options.color,
      }),
      "",
      ...renderAnalyticalTable({
        title: "Capacity & reliability",
        label: "provider",
        identityColors: true,
        headers: ["tok/$", "tok/call", "output", "errors", "aborted", "completed", "recent cost/day"],
        rows: groups.map((group, index) => {
          const errors = highOutlier(group.errors, errorPopulation, formatNumber)
          const aborted = highOutlier(group.aborted, abortedPopulation, formatNumber)
          return {
            label: group.label,
            values: [
              group.cost > 0 ? formatNumber(safeDivide(group.tokens.total, group.cost)) : "—",
              formatNumber(safeDivide(group.tokens.total, group.assistantCalls)),
              percent(outputTokens(group.tokens), group.tokens.total),
              errors.text,
              aborted.text,
              formatNumber(Math.max(0, group.requests - group.errors - group.aborted)),
              // Sparkline 是数据字符而非样式；保持无 ANSI，避免表格文本清理再次泄漏 SGR 参数。
              sparkline(series.find((item) => item.id === group.id)?.points.map((point) => point.cost) ?? [], 12, false, "pink"),
            ],
            // 原始 outcome 使用风险色，最后一列短趋势仍使用实体色；两套颜色分别回答异常与归属。
            valueColors: [undefined, undefined, undefined, errors.color, aborted.color, undefined, seriesColor(index)],
          }
        }),
        color: options.color,
      }),
    ]
  }
  if (by === "agent") {
    // Agent 需要完整十类 context 分母；只显示四类会让可见百分比无法解释剩余输入。
    return [
      ...renderAnalyticalTable({
        title: "Input context composition",
        label: "agent",
        identityColors: true,
        headers: ["system", "instruct", "skills", "schemas", "user", "assistant", "reasoning", "tool calls", "tool results", "attach"],
        rows: inputContextRows(groups),
        color: options.color,
      }),
      "",
      ...renderAnalyticalTable({
        title: "Runtime mix",
        label: "agent",
        identityColors: true,
        headers: ["models by tokens", "providers by tokens", "tools by calls"],
        rows: groups.map((group) => ({
          label: group.label,
          values: [
            tokenMix(group.models),
            tokenMix(group.providers),
            callMix(toolCallsFor(report, "agent", group.id), (call) => call.toolID),
          ],
        })),
        color: options.color,
      }),
    ]
  }
  if (by === "source") {
    return [
      ...renderAnalyticalTable({
        title: "Input context composition",
        label: "source",
        identityColors: true,
        headers: ["input components"],
        rows: groups.map((group) => {
          const total = inputContextTokens(group)
          const values = [
            { id: "system", value: group.components.system },
            { id: "instructions", value: group.components.instructions },
            { id: "skills", value: group.components.skills },
            { id: "schemas", value: group.components.toolSchemas },
            { id: "user", value: group.components.userMessages },
            { id: "assistant", value: group.components.assistantText },
            { id: "reasoning", value: group.components.reasoning },
            { id: "tool calls", value: group.components.toolCalls },
            { id: "tool results", value: group.components.toolResults },
            { id: "attach", value: group.components.attachments },
          ]
          // 全零 breakdown 无法证明真实占比，明确标记 unavailable 比十个伪 0% 更安全。
          return { label: group.label, values: [total > 0 ? mixText(values, 5) : "component attribution unavailable for these records"] }
        }),
        color: options.color,
      }),
      "",
      ...renderAnalyticalTable({
        title: "Routing mix",
        label: "source",
        identityColors: true,
        headers: ["models by tokens", "providers by tokens"],
        rows: groups.map((group) => ({
          label: group.label,
          values: [tokenMix(group.models), tokenMix(group.providers)],
        })),
        color: options.color,
      }),
    ]
  }
  if (by === "project") {
    // Project 路径已在 portfolio 中显示一次，后续表只复用 label，避免每节重复长目录。
    // 最大 Session 直接从已过滤 report.sessions 推导，不增加数据库查询或通用 cube。
    const projectLabels = new Map(report.projects.map((project) => [project.id, project.label]))
    return [
      ...renderAnalyticalTable({
        title: "Runtime mix",
        label: "project",
        identityColors: true,
        headers: ["models by tokens", "providers by tokens", "tools by calls"],
        rows: groups.map((group) => ({
          label: group.label,
          values: [tokenMix(group.models), tokenMix(group.providers), callMix(toolCallsFor(report, "projectID", group.id), (call) => call.toolID)],
        })),
        color: options.color,
      }),
      "",
      ...renderAnalyticalTable({
        title: "Largest sessions inside each project",
        label: "project",
        identityColors: true,
        headers: ["session", "tokens", "cost", "requests"],
        rows: groups.map((group) => {
          const session = report.sessions.filter((item) => item.projectID === group.id).sort((a, b) => b.tokens.total - a.tokens.total)[0]
          return {
            label: projectLabels.get(group.id) ?? group.label,
            values: session ? [session.title, formatNumber(session.tokens.total), money(session.cost), formatNumber(session.requests)] : ["—", "—", "—", "—"],
          }
        }),
        color: options.color,
      }),
    ]
  }
  // 一个失败请求会同时归属于 model/provider/source/agent/project；这些行是独立查询，不是互斥分区。
  const totalFailures = report.total.errors + report.total.aborted
  const dimensions = [
    { label: "model", groups: report.models },
    { label: "provider", groups: report.providers },
    { label: "source", groups: report.sources },
    { label: "agent", groups: report.agents },
    { label: "project", groups: report.projects },
  ]
  return [
    ...renderAnalyticalTable({
      title: "Failure leaders within each dimension",
      label: "dimension",
      headers: ["leader", "failed req", "rate in leader", "share of all failures"],
      rows: dimensions.map((dimension) => {
        const leader = [...dimension.groups].sort((a, b) => b.errors + b.aborted - a.errors - a.aborted)[0]
        const failures = (leader?.errors ?? 0) + (leader?.aborted ?? 0)
        return {
          label: dimension.label,
          values: [terminalText(leader?.label ?? "—"), formatNumber(failures), leader ? percent(failures, leader.requests) : "—", percent(failures, totalFailures)],
        }
      }),
      color: options.color,
    }),
    ...wrapVisible("Outcome ratios exclude unattributed usage. Each leader row is an independent query, not a partition.", statsContentWidth()).map((line) => muted(line, useColor(options.color))),
    ...wrapVisible("One failed request contributes to every applicable dimension.", statsContentWidth()).map((line) => muted(line, useColor(options.color))),
    ...wrapVisible(`Errors and aborted requests remain separate outcomes; the combined failure rate is ${percent(totalFailures, report.total.requests)}.`, statsContentWidth()).map((line) => muted(line, useColor(options.color))),
  ]
}

const renderDimensionAnalysis = (
  report: StatsReport,
  groups: UsageGroup[],
  by: Exclude<BreakdownDimension, "tool">,
  metric: "tokens" | "cost",
  options: StatsRenderOptions,
) => {
  const series = breakdownSeries(report, by)
  // 同一分组的表格变化率必须按 id 找回对应 series，不能依赖数组偶然同序。
  const findSeries = (group: UsageGroup) => series.find((item) => item.id === group.id)
  if (by === "model") {
    // Model 重点回答份额、费用效率、输出/缓存结构和会话覆盖。
    return [
      ...renderAnalyticalTable({
        title: "Model portfolio",
        label: "model",
        identityColors: true,
        headers: ["tokens", "share", "cost", "owned req", "calls", "tok/call", "sessions", "owner fail", "owner avg"],
        rows: groups.map((group) => ({
          label: group.label,
          values: [
            formatNumber(group.tokens.total),
            percent(group.tokens.total, report.total.tokens.total),
            money(group.cost),
            formatNumber(group.requests),
            formatNumber(group.assistantCalls),
            formatNumber(safeDivide(group.tokens.total, group.assistantCalls)),
            String(group.sessions),
            failureRate(group),
            avgDuration(group.durationMs, group.requests),
          ],
        })),
        color: options.color,
      }),
      ...wrapVisible("owned req / owner fail / owner avg follow RequestUsage owner; tokens, cost and calls follow Assistant usage.", statsContentWidth()).map((line) => muted(line, useColor(options.color))),
    ]
  }
  if (by === "provider") {
    // Provider 以经济性和失败率为主，默认主指标由上层设为 cost。
    // 异常基线使用完整过滤后 population，不能因 --limit 只显示前几行而改变告警等级。
    // 零费用在现有 schema 中可能表示未知而非免费，因此不能作为 $/call=0 拉低均值。
    const costPerCall = report.providers.flatMap((group) => group.cost > 0 && group.assistantCalls > 0 ? [group.cost / group.assistantCalls] : [])
    // 没有 owning request 的 secondary usage 不具备失败率和平均时延分母，应从基线排除。
    const ownerFailure = report.providers.flatMap((group) => group.requests > 0 ? [(group.errors + group.aborted) / group.requests] : [])
    const ownerAverage = report.providers.flatMap((group) => group.requests > 0 ? [group.durationMs / group.requests] : [])
    return [
      ...renderAnalyticalTable({
        title: "Provider economics",
        label: "provider",
        identityColors: true,
        headers: ["tokens", "share", "cost", "cost share", "owned req", "calls", "$/call", "cache", "owner fail", "owner avg"],
        rows: groups.map((group) => {
          // unavailable 费用保持破折号，不能先除成零再获得一个虚假的“低风险”值。
          const perCall = group.cost > 0 && group.assistantCalls > 0
            ? highOutlier(group.cost / group.assistantCalls, costPerCall, money)
            : { text: "—" }
          const failure = group.requests > 0
            ? highOutlier((group.errors + group.aborted) / group.requests, ownerFailure, (value) => percent(value, 1))
            : { text: failureRate(group) }
          const average = group.requests > 0
            ? highOutlier(group.durationMs / group.requests, ownerAverage, (value) => avgDuration(value, 1))
            : { text: avgDuration(group.durationMs, group.requests) }
          // Cache 颜色和显示文本共用完整 token 分母，避免 read-only 与 read+write 两套阈值并存。
          const cache = safeDivide(group.tokens.cache.read + group.tokens.cache.write, group.tokens.total)
          return {
            label: group.label,
            values: [
              formatNumber(group.tokens.total),
              percent(group.tokens.total, report.total.tokens.total),
              money(group.cost),
              group.cost > 0 ? percent(group.cost, report.total.cost) : "—",
              formatNumber(group.requests),
              formatNumber(group.assistantCalls),
              perCall.text,
              cacheShare(group.tokens),
              failure.text,
              average.text,
            ],
            // 95% cache 是正向提示；费用、失败率和时延才使用高侧风险色，不能按“数值大”统一染红。
            valueColors: [undefined, undefined, undefined, undefined, undefined, undefined, perCall.color, cache >= 0.95 ? "green" : undefined, failure.color, average.color],
          }
        }),
        color: options.color,
      }),
      ...wrapVisible("Request-owner metrics can be zero for a provider that only appears on secondary Assistant calls.", statsContentWidth()).map((line) => muted(line, useColor(options.color))),
      ...wrapVisible("Risk marks compare the full provider population: ! >=3σ, ^ >=2σ. Cache >=95% is highlighted as healthy.", statsContentWidth()).map((line) => muted(line, useColor(options.color))),
    ]
  }
  if (by === "agent") {
    // Agent 关注工作负载密度和调用效率，不复用模型页的费用排名壳。
    return renderAnalyticalTable({
      title: "Agent workload",
      label: "agent",
      identityColors: true,
      headers: ["tokens", "sessions", "cost", "owned req", "calls", "calls/req", "tok/session", "cache", "owner fail", "owner avg"],
      rows: groups.map((group) => ({
        label: group.label,
        values: [
          formatNumber(group.tokens.total),
          String(group.sessions),
          money(group.cost),
          formatNumber(group.requests),
          formatNumber(group.assistantCalls),
          safeDivide(group.assistantCalls, group.requests).toFixed(1),
          formatNumber(safeDivide(group.tokens.total, group.sessions)),
          cacheShare(group.tokens),
          failureRate(group),
          avgDuration(group.durationMs, group.requests),
        ],
      })),
      color: options.color,
    })
  }
  if (by === "source") {
    // Source 用请求与上下文结构解释流量来源，避免只展示绝对 token。
    return [
      ...renderAnalyticalTable({
        title: "Source workload",
        label: "source",
        identityColors: true,
        headers: ["owned req", "calls", "tokens", "tok/req*", "cost", "cost/req*", "sessions", "cache", "output", "fail*", "avg*"],
        rows: groups.map((group) => ({
          label: group.label,
          values: [
            formatNumber(group.requests),
            formatNumber(group.assistantCalls),
            formatNumber(group.tokens.total),
            group.requests > 0 ? formatNumber(safeDivide(group.tokens.total, group.requests)) : "—",
            money(group.cost),
            group.requests > 0 ? money(safeDivide(group.cost, group.requests)) : "—",
            String(group.sessions),
            cacheShare(group.tokens),
            percent(outputTokens(group.tokens), group.tokens.total),
            group.requests > 0 ? failureRate(group) : "—",
            group.requests > 0 ? avgDuration(group.durationMs, group.requests) : "—",
          ],
        })),
        color: options.color,
      }),
      ...wrapVisible("* request-owner denominator and health; legacy Assistant usage has no owned request.", statsContentWidth()).map((line) => muted(line, useColor(options.color))),
    ]
  }
  if (by === "project") {
    const enabled = useColor(options.color)
    const projects = new Map(report.projects.map((project) => [project.id, project]))
    // Project identity 需要名称与完整路径共同消歧；卡片换行比宽表截断更适合带空格的真实 worktree。
    return [
      ...renderSectionDivider("Project portfolio", enabled, statsContentWidth()),
      "",
      ...groups.flatMap((group, index) => [
        // 自定义 Project 卡片没有通用 table 第一列，因此在这里显式延续趋势中的项目身份色。
        color(terminalText(group.label), seriesColor(index), enabled, true),
        ...wrapVisible(`  ${terminalText(projects.get(group.id)?.path || "Path unavailable")}`, statsContentWidth()).map((line) => muted(line, enabled)),
        ...wrapVisible(
          `  ${formatNumber(group.tokens.total)} tok ${percent(group.tokens.total, report.total.tokens.total)} · ${money(group.cost)} · ${formatNumber(group.sessions)} sessions · ${formatNumber(group.requests)} req · ${formatNumber(group.assistantCalls)} calls · ${activeDays(findSeries(group))} active days · cache ${cacheShare(group.tokens)} · fail ${failureRate(group)}`,
          statsContentWidth(),
        ),
      ]),
    ]
  }
  // Status 是结果分布，核心是每请求成本、调用密度和请求占比，而非 token 排名。
  return renderAnalyticalTable({
    title: "Status efficiency",
    label: "status",
    headers: ["req share", "tokens/req", "cost/req", "calls/req", "cache", "output", "sessions"],
    rows: groups.filter((group) => group.id !== "unattributed").map((group) => ({
      label: group.label,
      // Outcome 是语义状态而非任意分类，颜色必须与趋势和分布中的 success/error/warning 保持一致。
      color: statusColor(group.id),
      values: [
        percent(group.requests, report.total.requests),
        group.requests > 0 ? formatNumber(safeDivide(group.tokens.total, group.requests)) : "—",
        group.requests > 0 ? money(safeDivide(group.cost, group.requests)) : "—",
        group.requests > 0 ? safeDivide(group.assistantCalls, group.requests).toFixed(1) : "—",
        cacheShare(group.tokens),
        percent(outputTokens(group.tokens), group.tokens.total),
        String(group.sessions),
      ],
    })),
    color: options.color,
  })
}

const renderOutcomeDistribution = (report: StatsReport, groups: UsageGroup[], options: StatsRenderOptions) => {
  // unattributed 只有 Assistant usage、没有 owning request，必须单列且不能进入 outcome 比率分母。
  const enabled = useColor(options.color)
  const width = statsContentWidth()
  const barWidth = Math.max(4, Math.min(48, width - 60))
  const outcomes = groups.filter((group) => group.id !== "unattributed")
  const unattributed = groups.find((group) => group.id === "unattributed")
  const total = outcomes.reduce((sum, group) => sum + group.requests, 0)
  return [
    ...renderSectionDivider("Outcome distribution", enabled, width),
    "",
    ...outcomes.map((group) => {
      const filled = total <= 0 ? 0 : Math.round((group.requests / total) * barWidth)
      return `${padEndVisible(terminalText(group.label), 12)} ${color("█".repeat(filled), statusColor(group.id), enabled)}${color("░".repeat(barWidth - filled), "border", enabled)} ${padStartVisible(formatNumber(group.requests), 6)} ${padStartVisible(percent(group.requests, total), 6)} ${formatNumber(group.tokens.total)} tokens · ${money(group.cost)} · ${group.requests > 0 ? avgDuration(group.durationMs, group.requests) : "—"} avg`
    }),
    ...(unattributed
      ? ["", ...wrapVisible(`Unattributed usage · ${formatNumber(unattributed.tokens.total)} tokens · ${money(unattributed.cost)} · ${formatNumber(unattributed.assistantCalls)} calls · no owning request outcome`, width).map((line) => muted(line, enabled))]
      : []),
  ]
}

const renderStatusTrend = (report: StatsReport, groups: UsageGroup[], options: StatsRenderOptions) => {
  const enabled = useColor(options.color)
  const outcomes = groups.filter((group) => group.id !== "unattributed")
  const dailyRequests = new Map(report.daily.map((day) => [day.day, day.requests]))
  const series = outcomes.flatMap((group) => {
    const source = report.statusSeries.find((item) => item.id === group.id)
    if (!source) return []
    return [{
      id: group.id,
      label: terminalText(group.label),
      color: statusColor(group.id),
      points: source.points.map((point) => ({ x: point.day, y: safeDivide(point.requests, dailyRequests.get(point.day) ?? 0) * 100 })),
    }]
  })
  const chart = renderRoundedLineChart({
    title: "Request outcome trend",
    series,
    color: options.color,
    formatter: (value) => `${value.toFixed(0)}%`,
    yMin: 0,
    yMax: 100,
    width: fullChartWidth(),
    height: 8,
    points: false,
  })
  return [...renderSectionDivider("Request outcome trend", enabled, statsContentWidth()), "", ...chart.slice(1)]
}

const renderStatusBreakdown = (report: StatsReport, options: StatsRenderOptions) => {
  const enabled = useColor(options.color)
  const order = ["completed", "error", "aborted", "running"]
  const groups = [...report.statuses].sort((a, b) => {
    const left = order.indexOf(a.id)
    const right = order.indexOf(b.id)
    return (left < 0 ? order.length : left) - (right < 0 ? order.length : right)
  })
  const count = (id: string) => groups.find((group) => group.id === id)?.requests ?? 0
  const total = groups.filter((group) => group.id !== "unattributed").reduce((sum, group) => sum + group.requests, 0)
  return panel([
    ...renderRichHeader(report, options, "breakdown", "Breakdown / Status"),
    ...wrapVisible(`Request outcomes · ${formatNumber(total)} total · ${formatNumber(count("completed"))} completed · ${formatNumber(count("error"))} error · ${formatNumber(count("aborted"))} aborted · ${formatNumber(count("running"))} running`, statsContentWidth()).map((line) => muted(line, enabled)),
    "",
    ...renderStatusTrend(report, groups, options),
    "",
    ...renderOutcomeDistribution(report, groups, options),
    "",
    ...renderDimensionAnalysis(report, groups, "status", "tokens", options),
    "",
    ...renderDimensionDetails(report, groups, "status", options),
  ], enabled)
}

const renderCompactHeader = (report: StatsReport, options: StatsRenderOptions, active: string, detail?: string) => {
  // 小于 100 列时拆分指标和范围，优先保留数值而不是完整 tabs 装饰。
  const enabled = useColor(options.color)
  const width = statsContentWidth()
  const metrics = width < 60
    ? [
        `${color(`Cost ${money(report.total.cost)}`, "pink", enabled)}  ${color(`Tok ${formatNumber(report.total.tokens.total)}`, "blue", enabled)}`,
        `${color(`Req ${formatNumber(report.total.requests)}`, "green", enabled)}  ${color(`Cache ${cacheShare(report.total.tokens)}`, "yellow", enabled)}  ${color(`Fail ${formatNumber(report.total.errors + report.total.aborted)}`, "red", enabled)}`,
      ]
    : [
        `${color(`Cost ${money(report.total.cost)}`, "pink", enabled)}  ${color(`Tokens ${formatNumber(report.total.tokens.total)}`, "blue", enabled)}  ${color(`Requests ${formatNumber(report.total.requests)}`, "green", enabled)}`,
        `${color(`Cache ${cacheShare(report.total.tokens)}`, "yellow", enabled)}  ${color(`Fail ${formatNumber(report.total.errors + report.total.aborted)}`, "red", enabled)}`,
      ]
  return [
    title(detail ? `opencode stats · ${detail}` : "opencode stats", enabled),
    ...wrapVisible(detail ? `${dateRange(report)} · ${report.sessionsWithUsage}/${report.totalSessions} sessions with usage` : `${dateRange(report)} · ${report.days} day window · ${report.sessionsWithUsage}/${report.totalSessions} sessions with usage`, width).map((line) => muted(line, enabled)),
    ...metrics,
    // 极窄终端只显示当前页面，避免五个 tab 把标题挤成省略号。
    width < 60
      ? muted(`View: ${active}`, enabled)
      : renderTabs({
          color: options.color,
          tabs: ["dashboard", "timeline", "breakdown", "sessions", "insights"].map((label) => ({ label, active: label === active })),
        }),
    "",
  ]
}

const renderRichHeader = (report: StatsReport, options: StatsRenderOptions, active: string, detail?: string) => {
  // 所有详细页面复用 Dashboard header，颜色、范围和指标顺序因此保持一致。
  if (statsContentWidth() < 100) return renderCompactHeader(report, options, active, detail)
  const enabled = useColor(options.color)
  return [
    title(detail ? `opencode stats · ${detail}` : "opencode stats", enabled),
    muted(detail ? `${dateRange(report)}${sep(enabled)}${report.sessionsWithUsage}/${report.totalSessions} sessions with usage` : `${dateRange(report)}${sep(enabled)}${report.days} day window${sep(enabled)}${report.sessionsWithUsage}/${report.totalSessions} sessions with usage`, enabled),
    detail
      ? `${color(`Cost ${money(report.total.cost)}`, "pink", enabled)}${sep(enabled)}${color(`Tokens ${formatNumber(report.total.tokens.total)}`, "blue", enabled)}${sep(enabled)}${color(`Requests ${formatNumber(report.total.requests)}`, "green", enabled)}${sep(enabled)}${color(`Cache ${cacheShare(report.total.tokens)}`, "yellow", enabled)}${sep(enabled)}${color(`Fail ${formatNumber(report.total.errors + report.total.aborted)}`, "red", enabled)}`
      : `${color(`Cost ${money(report.total.cost)} ${money(report.total.cost / Math.max(report.days, 1))}/day`, "pink", enabled)}${sep(enabled)}${color(`Tokens ${formatNumber(report.total.tokens.total)} ${formatNumber(report.tokensPerSession)} avg/session`, "blue", enabled)}${sep(enabled)}${color(`Requests ${formatNumber(report.total.requests)}`, "green", enabled)}${sep(enabled)}${color(`Cache ${cacheShare(report.total.tokens)}`, "yellow", enabled)}${sep(enabled)}${color(`Fail ${formatNumber(report.total.errors + report.total.aborted)}`, "red", enabled)}`,
    renderTabs({
      color: options.color,
      tabs: ["dashboard", "timeline", "breakdown", "sessions", "insights"].map((label) => ({
        label,
        active: label === active,
      })),
    }),
    "",
  ]
}

const renderDashboardHeader = (report: StatsReport, options: StatsRenderOptions, width: number) => {
  return width < 100 ? renderCompactHeader(report, options, "dashboard") : renderRichHeader(report, options, "dashboard")
}

const hasUsage = (report: StatsReport) =>
  // Session 数本身不代表存在 usage；严格筛选后只有 ToolPart 的报告也必须视为非空。
  report.total.tokens.total > 0 ||
  report.total.cost > 0 ||
  report.total.requests > 0 ||
  report.total.assistantCalls > 0 ||
  report.toolUsage.some((tool) => tool.count > 0 || tool.contextTokens > 0)

const renderEmptyStatsPage = (report: StatsReport, options: StatsRenderOptions, active: string) =>
  // 所有公开页面共用 header 后短路，避免不同端点各自绘制一套零值图和 NaN 风险。
  panel([
    ...renderRichHeader(report, options, active),
    muted("No usage data for the selected range.", useColor(options.color)),
  ], useColor(options.color))

const sortGroups = (groups: UsageGroup[], sort: StatsRenderOptions["sort"] = "tokens") =>
  // 排序始终带稳定次级指标，数值相同的实体不会在多次渲染间随机跳动。
  [...groups].sort((a, b) => {
    if (sort === "cost") return b.cost - a.cost || b.tokens.total - a.tokens.total
    if (sort === "calls") return b.assistantCalls - a.assistantCalls || b.tokens.total - a.tokens.total
    return b.tokens.total - a.tokens.total || b.cost - a.cost
  })

const topGroups = (groups: UsageGroup[], options: StatsRenderOptions) =>
  sortGroups(groups, options.sort ?? "tokens").slice(0, options.limit ?? 8)

// Dashboard helper 只组合既有图表 primitive，因此留在本文件而不扩张公开图表类型。
// 对外仍只有 `renderDashboard(report, options)`，行为测试也只经过这条公开边界。
const renderSectionDivider = (label: string, enabled: boolean, width: number, subtitle?: string) => {
  // Section 标题携带排序、分母等行为语义，不能用固定 40 列上限静默裁掉后半段。
  // 极窄终端改为完整换行；只有单行标题才在右侧补分隔线，避免产生超宽行。
  const labels = wrapVisible(label, Math.max(8, width - 5))
  const head = `━━━ ${labels[0] ?? ""} `
  const divider = color(`${head}${"─".repeat(Math.max(0, width - visibleLength(head)))}`, "border", enabled)
  const continuation = labels.slice(1).map((line) => color(`    ${line}`, "border", enabled))
  return [
    divider,
    ...continuation,
    ...(subtitle ? wrapVisible(subtitle, Math.max(12, width - 2)).map((line) => muted(`  ${line}`, enabled)) : []),
  ]
}

const tokenIntensity = (value: number): { char: string; color: keyof typeof theme } => {
  if (value <= 0) return { char: "·", color: "muted" }
  if (value < 50_000_000) return { char: "░", color: "blue" }
  if (value < 150_000_000) return { char: "▒", color: "cyan" }
  if (value < 250_000_000) return { char: "▓", color: "purple" }
  return { char: "█", color: "white" }
}

const requestIntensity = (value: number): { char: string; color: keyof typeof theme } => {
  if (value <= 0) return { char: "·", color: "muted" }
  if (value < 50) return { char: "░", color: "blue" }
  if (value < 150) return { char: "▒", color: "cyan" }
  if (value < 300) return { char: "▓", color: "purple" }
  return { char: "█", color: "white" }
}

const plainIntensityGlyph = (level: { char: string }, width = 1) =>
  level.char === "·" ? level.char : level.char.repeat(width)

const dayOfWeekTokens = (report: StatsReport) =>
  report.daily.reduce(
    (buckets, day) => {
      buckets[(new Date(day.day).getDay() + 6) % 7] += day.tokens.total
      return buckets
    },
    Array.from({ length: 7 }, () => 0),
  )

const renderHourOfDayStrip = (report: StatsReport, width: number) => {
  // 聚合层已按真实 RequestUsage 开始时间闭合；renderer 不再从 Session 更新时间猜测请求发生时段。
  const buckets = report.requestsByHour
  const nonZero = buckets.map((value, hour) => ({ value, hour })).filter((item) => item.value > 0)
  const peak = [...nonZero].sort((a, b) => b.value - a.value)[0]
  const quiet = [...nonZero].sort((a, b) => a.value - b.value)[0]
  // 24 个字符逐小时对应，不压缩采样，峰值位置才能与上方刻度稳定对齐。
  const dataLine = buckets.map((value) => plainIntensityGlyph(requestIntensity(value))).join("")
  const legendLine = "· =0  ░ <50  ▒ <150  ▓ <300  █ ≥300"
  return [
    ...wrapWhenNeeded("Request starts by hour", width),
    "",
    "00  04  08  12  16  20",
    dataLine,
    "",
    peak ? `peak  ${String(peak.hour).padStart(2, "0")}:00 — ${formatNumber(peak.value)} req` : "no hourly activity",
    quiet ? `quiet ${String(quiet.hour).padStart(2, "0")}:00 — ${formatNumber(quiet.value)} req` : "",
    "",
    ...wrapWhenNeeded(`legend  ${legendLine}`, width),
  ]
}

const isoWeek = (time: number) => {
  const date = new Date(time)
  const target = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()))
  target.setUTCDate(target.getUTCDate() + 3 - ((target.getUTCDay() + 6) % 7))
  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4))
  return 1 + Math.round(((target.getTime() - firstThursday.getTime()) / 86_400_000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7)
}

const renderCalendarActivity = (report: StatsReport, width: number) => {
  // Calendar 直接按完整 daily 索引放置数据，不使用固定 24 小时 timestamp 步长。
  const first = report.daily[0]?.day ?? Date.now()
  const offset = (new Date(first).getDay() + 6) % 7
  const startDate = new Date(first)
  startDate.setDate(startDate.getDate() - offset)
  const start = startDate.getTime()
  const weeks = Math.max(1, Math.ceil((offset + report.daily.length) / 7))
  // 日历单元保持自适应：窄列使用一个字符，宽列使用两个字符；
  // 星期标题始终落在同一固定网格，不能随色块宽度漂移。
  // 42 列以上使用双字符色块，窄屏退化为单字符但仍保留每个自然日。
  const glyphWidth = width >= 42 ? 2 : 1
  const cellWidth = glyphWidth + 2
  const cell = (tokens: number) => fitPlain(` ${plainIntensityGlyph(tokenIntensity(tokens), glyphWidth)}`, cellWidth)
  const legendLine = `░ <50M   ▒ 50-150M   ▓ 150-250M   █ >250M`
  return [
    ...wrapWhenNeeded("Calendar · cell intensity = daily tokens", width),
    "",
    `     ${["M", "T", "W", "T", "F", "S", "S"].map((d) => fitPlain(` ${d}`, cellWidth)).join("")}`,
    ...Array.from({ length: weeks }, (_, week) => {
      const weekStart = new Date(start)
      weekStart.setDate(weekStart.getDate() + week * 7)
      // `daily` 已是完整连续自然日序列；按索引定位可避开 DST 导致的 23/25 小时间隔。
      const cells = Array.from({ length: 7 }, (_, day) => {
        const index = week * 7 + day - offset
        return cell(index >= 0 && index < report.daily.length ? report.daily[index].tokens.total : 0)
      }).join("")
      return `${padStartVisible(String(isoWeek(weekStart.getTime())), 4)} ${cells}`
    }),
    "",
    ...wrapWhenNeeded(legendLine, width),
  ]
}

// Activity 对同一窗口使用三个小视图：日历观察日期节奏，小时条观察日内负载，
// 星期份额观察周期偏置；三者互补而不重复展示同一量纲。
const renderDayOfWeekShare = (report: StatsReport, enabled: boolean, width: number) => {
  const buckets = dayOfWeekTokens(report)
  const total = buckets.reduce((sum, value) => sum + value, 0)
  const max = Math.max(0, ...buckets)
  const barWidth = Math.max(6, width - 14)
  return [
    ...wrapVisible("Day-of-week · share of total tokens", width).map((line) => title(line, enabled)),
    ...["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((label, index) => {
      const filled = max <= 0 ? 0 : Math.round((buckets[index] / max) * barWidth)
      return `${label} ${color("▇".repeat(filled), index >= 5 ? "mauve" : "lavender", enabled)}${" ".repeat(Math.max(0, barWidth - filled))} ${padStartVisible(percent(buckets[index], total), 6)}`
    }),
  ]
}

const renderDailyActivitySection = (report: StatsReport, options: StatsRenderOptions, mode: ReturnType<typeof layoutModeFor>, width: number) => {
  // Calendar、小时和星期是三个不同时间尺度，宽屏并列、窄屏顺序堆叠。
  // 布局变化不重复聚合，每个视图都读取同一份 report。
  const calendarWidth = width < 100 ? width : mode === "wide" ? Math.floor((width - 10) / 3) : Math.floor((width - 4) / 2)
  const sideWidth = mode === "wide" ? Math.max(24, calendarWidth) : Math.max(24, width < 100 ? width : width - 4 - calendarWidth)
  const calendar = renderCalendarActivity(report, calendarWidth)
  const hour = renderHourOfDayStrip(report, sideWidth)
  const dow = renderDayOfWeekShare(report, useColor(options.color), sideWidth)
  if (width < 100) return [...calendar, "", ...hour, "", ...dow]
  if (mode === "wide") return renderThreeColumn(calendar, hour, dow, 5, width)
  return renderTwoColumn(calendar, [...hour, "", ...dow], 4, width, 0.5)
}

// Dashboard 不再堆叠 Token 组成；每个组件使用单系列折线，
// 因而低占比 output/cache-write 仍能保留自身趋势形状。
const orderedTokenParts = (report: StatsReport) =>
  // 固定顺序与全局颜色语义一致，低占比 Output 不会因数据排序改变位置。
  (["cacheRead", "input", "cacheWrite", "output"] as const).flatMap((id) => {
    const part = report.tokenPartSeries.find((item) => item.id === id)
    if (!part) return []
    return [part]
  })

// 组件颜色表达固定 token 语义而非当日排名，跨 Dashboard 与 Timeline 不得随数值交换。
const tokenPartMeta = {
  cacheRead: { color: "yellow", mark: "▓" },
  input: { color: "blue", mark: "░" },
  cacheWrite: { color: "purple", mark: "▒" },
  output: { color: "green", mark: "▎" },
} satisfies Record<TokenPartSeries["id"], { color: ChartColor; mark: string }>

const renderTokenComponentSmallChart = (part: ReturnType<typeof orderedTokenParts>[number], report: StatsReport, options: StatsRenderOptions, width: number) => {
  // 每个 token 组成独立归一化，避免缓存大值把 Output 曲线压在同一条线上。
  const meta = tokenPartMeta[part.id]
  const peak = Math.max(0, ...part.points.map((point) => point.value))
  const avg = safeDivide(part.total, Math.max(1, part.points.length))
  const fullTitle = `${meta.mark} ${part.label} ${formatNumber(part.total)} ${percent(part.total, report.total.tokens.total)} · peak ${formatNumber(peak)}/d · avg ${formatNumber(avg)}/d`
  const compactTitle = `${meta.mark} ${part.label} ${formatNumber(part.total)} ${percent(part.total, report.total.tokens.total)}`
  return renderRoundedLineChart({
    title: visibleLength(fullTitle) <= width ? fullTitle : compactTitle,
    series: [{ id: part.id, label: part.label, color: meta.color, mark: meta.mark, total: part.total, points: part.points.map((point) => ({ x: point.day, y: point.value, label: point.label, value: point.value })) }],
    color: options.color,
    metric: "tokens",
    width: chartPlotWidth(width),
    height: 8,
    points: false,
    legend: false,
  })
}

const renderTokenComponentsSmallMultiples = (report: StatsReport, options: StatsRenderOptions, halfWidth: number, width: number) => {
  const charts = orderedTokenParts(report).map((part) => renderTokenComponentSmallChart(part, report, options, width < 100 ? width : halfWidth))
  if (charts.length === 0) return [muted("No token component data", useColor(options.color))]
  if (width < 100) return charts.flatMap((chart) => [...chart, ""]).slice(0, -1)
  return [
    ...(charts.length >= 2 ? renderTwoColumn(charts[0], charts[1], 5, width, 0.5) : charts[0]),
    ...(charts.length >= 4 ? ["", ...renderTwoColumn(charts[2], charts[3], 5, width, 0.5)] : charts[2] ? ["", ...charts[2]] : []),
  ]
}

const median = (values: number[]) => {
  // 日费用中位数保留零日，描述完整日历窗口，而不是只描述活跃日的消费强度。
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] ?? 0
}

const renderCostHealthSubchart = (titleText: string, id: string, colorName: ChartColor, points: ReturnType<typeof dailyCostPoints>, width: number, metric: "tokens" | "cost", options: StatsRenderOptions, summary: string, yRange?: { min: number; max: number }) => [
  ...renderRoundedLineChart({ title: titleText, series: [dailySeries(points, colorName, id)], color: options.color, metric, width: chartPlotWidth(width), height: 7, points: false, legend: false, yMin: yRange?.min, yMax: yRange?.max }),
  ...wrapVisible(summary, width).map((line) => muted(line, useColor(options.color))),
]

// 宽终端并排展示三张健康图；中等终端先显示 Error，
// 再让 Cache 独占释放出的整行宽度，避免三图同时被压扁。
const renderCostHealthSection = (report: StatsReport, options: StatsRenderOptions, mode: ReturnType<typeof layoutModeFor>, width: number, halfWidth: number, thirdWidth: number) => {
  // Cost、Cache、Failure 使用各自量纲，分成 small multiples 而不是共享 Y 轴。
  const costPeak = [...report.daily].sort((a, b) => b.cost - a.cost)[0]
  const cacheRates = dailyCacheHitPoints(report).map((point) => point.value).filter((value) => value > 0)
  const errorPeak = dailyErrorRatePoints(report).sort((a, b) => b.value - a.value)[0]
  const errorAvg = safeDivide(report.total.errors + report.total.aborted, report.total.requests) * 100
  const pairWidth = width < 100 ? Math.max(18, width - 4) : mode === "wide" ? thirdWidth : halfWidth
  const dailyCost = renderCostHealthSubchart("Daily cost ($/day)", "cost", "pink", dailyCostPoints(report), pairWidth, "cost", options, costPeak ? `peak ${money(costPeak.cost)} on ${shortDate(costPeak.day)} · median ${money(median(report.daily.map((day) => day.cost)))}` : "no cost activity")
  const cacheRange = cacheRates.length ? { min: Math.max(0, Math.floor(Math.min(...cacheRates) / 10) * 10), max: Math.min(100, Math.ceil(Math.max(...cacheRates) / 10) * 10) } : undefined
  const cacheHit = renderCostHealthSubchart("Cache hit rate (%)", "cache", "yellow", dailyCacheHitPoints(report), mode === "wide" ? thirdWidth : Math.max(18, width - 4), "tokens", options, cacheRates.length ? `range ${Math.min(...cacheRates).toFixed(1)}% → ${Math.max(...cacheRates).toFixed(1)}% · ${Math.max(...cacheRates) - Math.min(...cacheRates) < 10 ? "stable" : "variable"}` : "no cache activity", cacheRange)
  const errorRate = renderCostHealthSubchart("Abort & error rate (%)", "errors", "red", dailyErrorRatePoints(report), pairWidth, "tokens", options, errorPeak && errorPeak.value > 0 ? `spike ${errorPeak.value.toFixed(1)}% on ${shortDate(errorPeak.day)} · avg ${errorAvg.toFixed(1)}%` : "no errors recorded")
  // 中等宽度优先并列 Cost/Failure，再给 Cache 一整行，保持异常指标的可比性。
  if (mode === "wide") return renderThreeColumn(dailyCost, cacheHit, errorRate, 5, width)
  if (width < 100) return [...dailyCost, "", ...errorRate, "", ...cacheHit]
  return [...renderTwoColumn(dailyCost, errorRate, 5, width, 0.5), "", ...cacheHit]
}

const renderTopModelsLollipop = (report: StatsReport, options: StatsRenderOptions, width: number) => {
  // Lollipop 只承担模型规模比较；精确份额、费用和每调用量仍以数字列给出。
  const enabled = useColor(options.color)
  const models = topGroups(report.models, { ...options, limit: options.limit ?? 5, sort: "tokens" })
  if (models.length === 0) return [muted("No model data in range", enabled)]
  const max = Math.max(0, ...models.map((model) => model.tokens.total))
  const modelLabels = models.map((model) => terminalText(model.label))
  const labelWidth = Math.max(16, Math.min(30, Math.max(...modelLabels.map(visibleLength)) + 1))
  // 只有超出可用列时才启用编号键；完整名称随后回显，编号不能替代实体身份。
  const labels = modelLabels.map((label, index) => visibleLength(label) <= labelWidth ? label : `[${index + 1}]`)
  // 超长模型名通过编号键完整回显，不能用无省略号的静默 clip 代替。
  const perCallWidth = 9
  const barWidth = Math.max(12, width - labelWidth - 43 - perCallWidth - 3)
  return [
    muted(`${" ".repeat(labelWidth)} │ tokens${" ".repeat(Math.max(1, barWidth - 6))} │ share  │ cost     │ per-call`, enabled),
    ...models.map((model, index) => {
      const filled = Math.max(1, Math.round(safeDivide(model.tokens.total, max) * Math.max(1, barWidth - 10)))
      const perCall = `${formatNumber(safeDivide(model.tokens.total, model.assistantCalls))}/c`
      return fitPlain(`${padEndVisible(labels[index], labelWidth)} │${color("●" + "━".repeat(Math.max(0, filled - 1)), seriesColor(index), enabled)} ${padEndVisible(formatNumber(model.tokens.total), Math.max(1, barWidth - filled))} │ ${padStartVisible(percent(model.tokens.total, report.total.tokens.total), 6)} │ ${padStartVisible(money(model.cost), 8)} │ ${padStartVisible(perCall, perCallWidth)}`, width)
    }),
    ...models.flatMap((_, index) => labels[index].startsWith("[") ? wrapVisible(`[${index + 1}] ${modelLabels[index]}`, width).map((line) => muted(line, enabled)) : []),
  ]
}

const renderTopProvidersStack = (report: StatsReport, options: StatsRenderOptions, width: number) => {
  // Provider 使用 100% 组成条表达份额，和模型的绝对量 lollipop 分工不同。
  const enabled = useColor(options.color)
  const providers = sortGroups(report.providers, "tokens")
  if (providers.length === 0) return [muted("No provider data in range", enabled)]
  const barWidth = Math.max(20, width - 2)
  const colors = ["yellow", "green", "blue", "purple", "cyan", "pink"] as const
  const chars = ["▓", "█", "░", "▒", "▓", "▒"]
  const top = providers.slice(0, 6)
  const otherTokens = providers.slice(6).reduce((sum, provider) => sum + provider.tokens.total, 0)
  // 超过六个的长尾合并为 other，控制视觉密度但仍计入总占比和费用。
  const pieces = [
    ...top.map((provider) => ({ label: terminalText(provider.label), tokens: provider.tokens.total, cost: provider.cost })),
    ...(otherTokens > 0 ? [{ label: "other", tokens: otherTokens, cost: providers.slice(6).reduce((sum, provider) => sum + provider.cost, 0) }] : []),
  ].map((provider, index) => ({ provider, color: colors[index % colors.length], char: chars[index] ?? "█" }))
  // Dashboard Provider 条是“出现过的实体”总览，允许每个可见实体至少一格；这不用于精确 Model composition。
  const baseSizes = pieces.map((piece) => Math.max(1, Math.floor(safeDivide(piece.provider.tokens, report.total.tokens.total) * barWidth)))
  const sizes = baseSizes.map((size, index) => index === baseSizes.length - 1 ? Math.max(1, size + barWidth - baseSizes.reduce((sum, item) => sum + item, 0)) : size)
  const bar = pieces.map((piece, index) => color(piece.char.repeat(Math.max(1, sizes[index] ?? 1)), piece.color, enabled)).join("")
  // 字符格经过最小宽度量化，下一行仍输出精确百分比，不能把格数误当成账单分母。
  const pctLine = pieces.map((piece, index) => padEndVisible(percent(piece.provider.tokens, report.total.tokens.total), Math.max(visibleLength(percent(piece.provider.tokens, report.total.tokens.total)) + 1, sizes[index] ?? 1))).join("")
  const itemsPerRow = width >= 110 ? 3 : 2
  const legendGap = width >= 110 ? 6 : 4
  const colWidth = Math.min(38, Math.floor((width - legendGap * (itemsPerRow - 1)) / itemsPerRow))
  const legend = pieces.map((piece, index) => {
    // 图例列只放短标签，完整长名称在下方 key 中保留。
    const labelWidth = Math.max(8, colWidth - 20)
    const label = visibleLength(piece.provider.label) <= labelWidth ? piece.provider.label : `[${index + 1}]`
    return {
      line: `${color(piece.char, piece.color, enabled)} ${padEndVisible(color(label, "white", enabled, true), labelWidth)} ${padStartVisible(formatNumber(piece.provider.tokens), 7)} ${padStartVisible(money(piece.provider.cost), 8)}`,
      note: label.startsWith("[") ? `[${index + 1}] ${piece.provider.label}` : undefined,
    }
  })
  const legendRows = legend.map((item) => item.line).reduce<string[]>((rows, item, index) => {
    if (index % itemsPerRow === 0) rows.push("")
    rows[rows.length - 1] += `${index % itemsPerRow === 0 ? "" : " ".repeat(legendGap)}${padEndVisible(item, colWidth)}`
    return rows
  }, [])
  return [fitPlain(bar, barWidth), muted(fitPlain(pctLine, barWidth), enabled), "", ...legendRows, ...legend.flatMap((item) => item.note ? wrapVisible(item.note, width).map((line) => muted(line, enabled)) : [])]
}

const sessionPercentile = (report: StatsReport, q: number) => {
  const sorted = report.sessions.map((session) => session.tokens.total).sort((a, b) => a - b)
  // 最近秩只返回真实 Session 值，不通过插值制造数据库中不存在的 token 规模。
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0
}

const renderSessionDistribution = (report: StatsReport, options: StatsRenderOptions, width: number) => {
  // 固定业务区间比随样本最大值变化的直方图更适合跨时间比较。
  // 空区间仍保留位置，用户能识别分布中真正缺失的范围。
  const enabled = useColor(options.color)
  const buckets = [
    { label: "<100K", min: 0, max: 100_000 },
    { label: "100K-1M", min: 100_000, max: 1_000_000 },
    { label: "1M-5M", min: 1_000_000, max: 5_000_000 },
    { label: "5M-50M", min: 5_000_000, max: 50_000_000 },
    { label: ">50M", min: 50_000_000, max: Number.POSITIVE_INFINITY },
  ]
  const counts = buckets.map((bucket) => report.sessions.filter((session) => session.tokens.total >= bucket.min && session.tokens.total < bucket.max).length)
  const max = Math.max(1, ...counts)
  const total = Math.max(1, counts.reduce((sum, count) => sum + count, 0))
  const barWidth = Math.max(12, width - 26)
  const topTokens = [...report.sessions].sort((a, b) => b.tokens.total - a.tokens.total)
  const top2 = topTokens.slice(0, 2).reduce((sum, session) => sum + session.tokens.total, 0)
  const top10 = topTokens.slice(0, 10).reduce((sum, session) => sum + session.tokens.total, 0)
  return [
    title(`Session size distribution (${report.sessions.length} sessions)`, enabled),
    ...buckets.map((bucket, index) => `${padStartVisible(bucket.label, 8)} ${metricBar(counts[index], max, barWidth, enabled, (["muted", "lavender", "tealSoft", "mauve", "amberSoft"] as const)[index] ?? "lavender")} ${padStartVisible(String(counts[index]), 4)} ${padStartVisible(percent(counts[index], total), 6)}`),
    "",
    muted(`Percentiles   p50 ${formatNumber(sessionPercentile(report, 0.5))} · p90 ${formatNumber(sessionPercentile(report, 0.9))} · p99 ${formatNumber(sessionPercentile(report, 0.99))}`, enabled),
    muted(`Heavy-tail   top 2 ⇒ ${percent(top2, report.total.tokens.total)} of tokens · top 10 ⇒ ${percent(top10, report.total.tokens.total)}`, enabled),
  ]
}

const renderTopSessionsList = (report: StatsReport, options: StatsRenderOptions, width: number) => {
  // Dashboard 只给 top 会话摘要；完整多维比较由 Sessions 页面承担。
  const enabled = useColor(options.color)
  const sessions = [...report.sessions].sort((a, b) => b.tokens.total - a.tokens.total || b.cost - a.cost).slice(0, options.limit ?? 5)
  // 同量 token 用费用稳定破平；max 只负责相对条长，精确 token 始终在标题行展示。
  const max = Math.max(0, ...sessions.map((session) => session.tokens.total))
  const barWidth = Math.max(18, width - 14)
  return [
    title("Top sessions by tokens", enabled),
    ...sessions.flatMap((session, index) => {
      const titleWidth = Math.max(20, width - 28)
      const sessionTitle = terminalText(session.title || session.id)
      const label = visibleLength(sessionTitle) <= titleWidth ? sessionTitle : `[${index + 1}]`
      // 模型和供应商列表全部换行展示，不再 slice 后静默丢掉第三个实体。
      return [
        `#${index + 1} ${padEndVisible(color(label, "white", enabled, true), titleWidth)} ${padStartVisible(money(session.cost), 8)} ${padStartVisible(formatNumber(session.tokens.total), 8)} tok`,
        ...(label.startsWith("[") ? wrapVisible(`[${index + 1}] ${sessionTitle}`, width).map((line) => `   ${muted(line, enabled)}`) : []),
        `   ${metricBar(session.tokens.total, max, barWidth, enabled, "blue")} ${padStartVisible(percent(session.tokens.total, max), 5)}`,
        ...wrapVisible(`${session.models.map(terminalText).join(" · ") || "?"} · ${session.providers.map(terminalText).join(" · ") || "?"} · ${formatNumber(session.requests)} req · ${avgDuration(session.durationMs, session.requests)} avg`, Math.max(12, width - 3)).map((line) => `   ${muted(line, enabled)}`),
        "",
      ]
    }),
  ]
}

const renderInsightsCallout = (report: StatsReport, options: StatsRenderOptions) => {
  // Dashboard callout 仅给可验证入口，不复制 Insights 的整套定量分析。
  const errorTotal = report.total.errors + report.total.aborted
  const errorRate = safeDivide(errorTotal, report.total.requests) * 100
  const top2 = [...report.sessions].sort((a, b) => b.tokens.total - a.tokens.total).slice(0, 2).reduce((sum, session) => sum + session.tokens.total, 0)
  const cachePct = safeDivide(report.total.tokens.cache.read, report.total.tokens.total) * 100
  const compact = statsContentWidth() < 100
  return renderCallout({
    title: "💡  Suggested next steps",
    body: compact
      ? [
          errorTotal > 0 ? `▸ ${formatNumber(errorTotal)} failed/aborted req (${errorRate.toFixed(1)}%).` : "▸ No failed or aborted requests.",
          errorTotal > 0 ? "  → opencode stats breakdown status" : "  → keep watching error-rate trend.",
          `▸ Top 2 sessions: ${percent(top2, report.total.tokens.total)} of tokens.`,
          `▸ Cache hit: ${cachePct.toFixed(1)}%; review prompt reuse.`,
        ].join("\n")
      : [
          errorTotal > 0 ? `▸ ${formatNumber(errorTotal)} failed/aborted requests (${errorRate.toFixed(1)}% rate).` : "▸ No failed or aborted requests in this range.",
          errorTotal > 0 ? "  → run  opencode stats breakdown status   to inspect failed usage." : "  → keep watching the error-rate chart for regressions.",
          `▸ Top 2 sessions account for ${percent(top2, report.total.tokens.total)} of all tokens; consider splitting long sessions.`,
          `▸ Cache hit rate is ${cachePct.toFixed(1)}%; further gains likely require prompt restructuring.`,
        ].join("\n"),
    color: options.color,
    accent: "purple",
  })
}

export function renderStatsHeader(report: StatsReport, options: StatsRenderOptions, active: string) {
  return renderRichHeader(report, options, active, active === "insights" ? "Insights" : undefined)
}

const renderNarrowDashboard = (report: StatsReport, options: StatsRenderOptions, width: number) => {
  const enabled = useColor(options.color)
  const models = topGroups(report.models, { ...options, limit: 3, sort: "tokens" })
  const sessions = [...report.sessions].sort((a, b) => b.tokens.total - a.tokens.total).slice(0, 3)
  // 40 列附近无法保持桌面版多栏图的比较关系。紧凑模式保留同一组分析问题，
  // 但将低优先级装饰图降为完整数值行，避免外层 panel 用省略号静默丢失数据。
  // 该分支不改变 60 列以上 Dashboard，主端点既有视觉基线因此保持稳定。
  return panel([
    ...renderCompactHeader(report, options, "dashboard"),
    ...(report.total.cost <= 0 ? [...wrapVisible("No positive cost recorded in this range; token, cache, and failure trends remain visible.", width).map((line) => muted(line, enabled)), ""] : []),
    ...renderSectionDivider("Daily activity", enabled, width),
    "",
    ...renderCalendarActivity(report, width),
    "",
    ...renderRoundedLineChart({
      title: "Daily tokens",
      series: [dailySeries(dailyTokenPoints(report), "blue", "tokens")],
      color: options.color,
      metric: "tokens",
      width: fullChartWidth(),
      height: 6,
      points: false,
      legend: false,
    }),
    "",
    ...renderSectionDivider("Usage shape", enabled, width),
    ...wrapVisible(`Input ${percent(report.total.tokens.input, report.total.tokens.total)} · Output ${percent(outputTokens(report.total.tokens), report.total.tokens.total)} · Cache ${cacheShare(report.total.tokens)}`, width).map((line) => muted(line, enabled)),
    ...wrapVisible(`Cost ${money(report.total.cost)} · Requests ${formatNumber(report.total.requests)} · Failures ${formatNumber(report.total.errors + report.total.aborted)}`, width).map((line) => muted(line, enabled)),
    "",
    ...renderSectionDivider("Top models", enabled, width),
    ...models.flatMap((model, index) => wrapVisible(`${index + 1} ${terminalText(model.label)} · ${formatNumber(model.tokens.total)} · ${percent(model.tokens.total, report.total.tokens.total)} · ${money(model.cost)}`, width).map((line) => color(line, "white", enabled))),
    "",
    ...renderSectionDivider("Top sessions", enabled, width),
    ...sessions.flatMap((session, index) => wrapVisible(`${index + 1} ${terminalText(session.title || session.id)} · ${formatNumber(session.tokens.total)} · ${money(session.cost)}`, width).map((line) => color(line, "white", enabled))),
  ], enabled)
}

export function renderDashboard(report: StatsReport, options: StatsRenderOptions = {}) {
  // Dashboard 是视觉基准；只有极窄终端进入紧凑分支，其余布局沿用 section-first 结构。
  const enabled = useColor(options.color)
  const totalWidth = terminalContentWidth()
  // 空态判定先于窄屏分支，所有宽度必须看到同一事实而不是不同的零值布局。
  if (!hasUsage(report)) return renderEmptyStatsPage(report, options, "dashboard")
  if (totalWidth < 60) return renderNarrowDashboard(report, options, totalWidth)
  // 布局阈值只改变并排/堆叠方式，所有 section 和统计口径在两种模式中保持一致。
  const mode = layoutModeFor(totalWidth)
  const gap = 5
  const halfWidth = Math.max(30, Math.floor((totalWidth - gap) / 2))
  const thirdWidth = Math.max(28, Math.floor((totalWidth - gap * 2) / 3))
  const sessionLeftWidth = Math.max(30, Math.floor((totalWidth - gap) * 0.42))
  const sessionRightWidth = Math.max(30, totalWidth - gap - sessionLeftWidth)

  // Dashboard 刻意采用 section-first：每个区块只回答一个问题，
  // Timeline、Breakdown、Sessions 继续保留各自的详细 renderer。
  const lines = [
    ...renderDashboardHeader(report, options, totalWidth),
    // 无正费用只禁用费用推断，Token/Cache/Failure 仍有独立观测价值。
    ...(report.total.cost <= 0 ? [muted("No positive cost recorded in this range; token, cache, and failure trends remain visible.", enabled), ""] : []),
    // 长时间轴是 Dashboard 的主图，始终使用整行；下面的小视图只补充周期和组成透视。
    ...renderRoundedLineChart({
      title: "Daily token volume",
      series: [dailySeries(dailyTokenPoints(report), "blue", "tokens")],
      color: options.color,
      metric: "tokens",
      width: fullChartWidth(),
      height: 8,
      points: false,
      legend: false,
    }),
    "",
    ...renderSectionDivider("Daily activity", enabled, totalWidth),
    "",
    ...renderDailyActivitySection(report, options, mode, totalWidth),
    "",
    ...renderSectionDivider("Token components", enabled, totalWidth, "Each panel auto-normalizes to its own peak."),
    "",
    ...renderTokenComponentsSmallMultiples(report, options, halfWidth, totalWidth),
    "",
    ...renderSectionDivider("Cost & health trends", enabled, totalWidth),
    "",
    ...renderCostHealthSection(report, options, mode, totalWidth, halfWidth, thirdWidth),
    "",
    ...renderSectionDivider("Top models · by token volume", enabled, totalWidth),
    "",
    ...renderTopModelsLollipop(report, options, totalWidth),
    "",
    ...renderSectionDivider("Top providers · share of total tokens", enabled, totalWidth),
    "",
    ...renderTopProvidersStack(report, options, totalWidth),
    "",
    ...renderSectionDivider("Sessions", enabled, totalWidth),
    "",
    ...(mode === "wide"
      ? renderTwoColumn(renderSessionDistribution(report, options, sessionLeftWidth), renderTopSessionsList(report, options, sessionRightWidth), gap, totalWidth, sessionLeftWidth / Math.max(1, totalWidth - gap))
      : [...renderSessionDistribution(report, options, totalWidth - 4), "", ...renderTopSessionsList(report, options, totalWidth - 4)]),
    "",
    ...renderSectionDivider("Insights", enabled, totalWidth),
    "",
    ...renderInsightsCallout(report, options),
  ]
  return panel(lines, enabled)
}

export function renderBreakdown(report: StatsReport, options: StatsRenderOptions = {}) {
  // Breakdown 共用 header 和 top-5 趋势，但分析表必须按维度回答不同问题。
  // 此处是七个分组 wrapper 的唯一渲染入口，不能复制成专属页面。
  const enabled = useColor(options.color)
  const by = options.by ?? "model"
  if (!hasUsage(report)) return renderEmptyStatsPage(report, options, "breakdown")
  if (by === "status") return renderStatusBreakdown(report, options)
  // Provider 默认关注费用，其他维度默认关注 token；显式 metric 始终覆盖默认值。
  // 全范围无正费用时按 cost 排序没有区分度，Provider 稳定回退到 token 规模。
  const metric = options.metric ?? (by === "provider" && report.total.cost > 0 ? "cost" : "tokens")
  const sort = options.sort ?? (by === "provider" && report.total.cost > 0 ? "cost" : "tokens")
  const limit = options.limit ?? (statsContentWidth() < 60 ? 3 : 5)

  if (by === "tool") {
    // Tool 没有可靠费用归因，使用调用量与估算上下文 token 的专属数据结构。
    // 显式 calls 排序必须覆盖默认 context token 顺序，不能接受参数后静默忽略。
    // 两种排序都保留另一指标作为次级键，数值并列时输出仍然稳定。
    // 估算上下文可能因 legacy breakdown 缺失而全零，此时保留 calls 并明确显示不可用。
    const hasContextTokens = report.toolUsage.some((tool) => tool.contextTokens > 0)
    const toolSort = hasContextTokens ? sort : "calls"
    const tools = [...report.toolUsage]
      .sort((a, b) => toolSort === "calls" ? b.count - a.count || b.contextTokens - a.contextTokens : b.contextTokens - a.contextTokens || b.count - a.count)
      .slice(0, limit)
    // footprint 与 issuing runtime 均从过滤后的 toolCalls 构建，不能混入 Session 级未过滤 count。
    const callStats = new Map<string, { errors: number; durationMs: number }>()
    const projectLabels = new Map(report.projects.map((project) => [project.id, project.label]))
    report.toolCalls.forEach((call) => {
      const item = callStats.get(call.toolID) ?? { errors: 0, durationMs: 0 }
      item.errors += call.errors
      item.durationMs += call.durationMs
      callStats.set(call.toolID, item)
    })
    const tokenTotal = report.toolUsage.reduce((sum, tool) => sum + tool.contextTokens, 0)
    const selectedTools = tools.slice(0, 5)
    // Tool 趋势和两张明细表都按 tools 排序；缺失日序列只能隐藏折线，不能改变剩余工具颜色。
    const toolColors = new Map(selectedTools.map((tool, index) => [tool.id, seriesColor(index)]))
    const toolSeries = seriesFromUsage(
      // 趋势同样限制五条线，但保留完整工具名；颜色不承担唯一的系列映射。
      selectedTools.flatMap((tool) => {
        const series = report.toolSeries.find((item) => item.id === tool.id)
        return series ? [series] : []
      }),
      "tokens",
      5,
    ).map((series) => {
      const identityColor = toolColors.get(series.id) ?? seriesColor(0)
      return { ...series, label: terminalText(series.label), color: identityColor }
    })
    return panel(
      [
        ...renderRichHeader(report, options, "breakdown", `Breakdown / ${breakdownPageTitle(by)}`),
        ...wrapVisible(`Tools · ${formatNumber(report.totalTools)} calls · ${hasContextTokens ? `${formatNumber(tokenTotal)} estimated context tokens · sorted by ${toolSort === "calls" ? "calls" : "estimated context tokens"}` : "context estimate unavailable · sorted by calls"}`, statsContentWidth()).map((line) => muted(line, enabled)),
        ...(hasContextTokens
          ? [
              "",
              ...renderSectionDivider(`Estimated context trend · top ${toolSeries.length} tools`, enabled, statsContentWidth()),
              "",
              ...renderRoundedLineChart({
                title: `Estimated context trend · top ${toolSeries.length} tools`,
                series: toolSeries,
                color: options.color,
                metric: "tokens",
                width: fullChartWidth(),
                height: 8,
                points: false,
                legend: false,
              }).slice(1),
              ...wrapAnsiVisible(`${toolSeries.map((series) => color(`${series.label} ${formatNumber(series.total ?? 0)}`, series.color, enabled, true)).join(sep(enabled))}${muted(" est ctx tok", enabled)}`, statsContentWidth()),
            ]
          : [muted("Context estimate unavailable for these records; call share remains separate.", enabled)]),
        "",
        ...renderAnalyticalTable({
          title: "Tool footprint",
          label: "tool",
          identityColors: true,
          headers: ["calls", "call share", "est ctx tok", "ctx share", "ctx/call", "in chars/c", "out chars/c", "errors", "avg/call"],
          rows: tools.map((tool) => {
            // error 和 duration 来自 ToolPart 状态，分母始终是同一行的真实调用数。
            const calls = callStats.get(tool.id) ?? { errors: 0, durationMs: 0 }
            return {
              label: tool.id,
              values: [
                formatNumber(tool.count),
                percent(tool.count, report.totalTools),
                hasContextTokens ? formatNumber(tool.contextTokens) : "—",
                hasContextTokens ? percent(tool.contextTokens, tokenTotal) : "—",
                hasContextTokens ? formatNumber(safeDivide(tool.contextTokens, tool.count)) : "—",
                formatNumber(safeDivide(tool.inputChars, tool.count)),
                formatNumber(safeDivide(tool.outputChars, tool.count)),
                formatNumber(calls.errors),
                avgDuration(calls.durationMs, tool.count),
              ],
            }
          }),
          color: options.color,
        }),
        ...wrapVisible("est ctx tok approximates how much prior Tool input/output appears in later Assistant input.", statsContentWidth()).map((line) => muted(line, enabled)),
        ...wrapVisible("Calls, chars, errors and duration come from ToolPart; no row represents Tool cost or billed tokens.", statsContentWidth()).map((line) => muted(line, enabled)),
        ...wrapVisible("Tool errors are ToolPart execution errors; --status filters associated request/Assistant status, not ToolState.", statsContentWidth()).map((line) => muted(line, enabled)),
        "",
        ...renderAnalyticalTable({
          title: "Issuing runtime",
          label: "tool",
          identityColors: true,
          headers: ["top models by calls", "top agents by calls", "projects by calls"],
          rows: tools.map((tool) => {
            // runtime mix 只改变分组键，不把 estimated context 当成调用权重。
            const calls = toolCallsFor(report, "toolID", tool.id)
            return {
              label: tool.id,
              values: [
                callMix(calls, (call) => call.modelID),
                callMix(calls, (call) => call.agent),
                callMix(calls, (call) => projectLabels.get(call.projectID) ?? call.projectID),
              ],
            }
          }),
          color: options.color,
        }),
      ],
      enabled,
    )
  }

  // limit 只裁剪可见实体；summary 中的 total 必须继续反映完整分组集合。
  const allGroups = sortGroups(breakdownGroups(report, by), sort)
  // summary 使用完整分组数，limit 只限制可见明细，不能把“显示 8 行”说成“共 8 组”。
  const groups = allGroups.slice(0, limit)
  const topGroup = groups[0]
  const topShare = topGroup ? percent(metric === "cost" ? topGroup.cost : topGroup.tokens.total, metric === "cost" ? report.total.cost : report.total.tokens.total) : "—"
  const topValue = topGroup ? metricFormatter(metric)(metric === "cost" ? topGroup.cost : topGroup.tokens.total) : "—"
  const summaryLine = topGroup
    ? `${breakdownTitle(by)} · top ${terminalText(topGroup.label)} ${topValue} (${topShare}) · ${allGroups.length} total · sorted by ${sort === "cost" ? "cost" : sort === "calls" ? "calls" : "tokens"}`
    : `${breakdownTitle(by)} · no data in this range`

  const lines = [
    ...renderRichHeader(report, options, "breakdown", `Breakdown / ${breakdownPageTitle(by)}`),
    ...wrapVisible(summaryLine, statsContentWidth()).map((line) => muted(line, enabled)),
    "",
    ...renderBreakdownTrend(groups, breakdownSeries(report, by), metric, breakdownTitle(by), options.color),
    "",
    ...renderDimensionAnalysis(report, groups, by, metric, options),
  ]

  // 每个维度的第二、第三透视都从现有 report 投影，避免再套用无语义的编号矩阵。
  lines.push("", ...renderDimensionDetails(report, groups, by, options))

  return panel(lines, enabled)
}

export function renderModels(report: StatsReport, options: StatsRenderOptions = {}) {
  return renderBreakdown(report, { ...options, by: "model" })
}

export function renderProviders(report: StatsReport, options: StatsRenderOptions = {}) {
  // Provider 默认 metric 由 canonical Breakdown 根据正费用可用性决定，wrapper 只固定维度。
  return renderBreakdown(report, { ...options, by: "provider" })
}

const renderTimelineHealth = (report: StatsReport, options: StatsRenderOptions, metric: "tokens" | "cost") => {
  // Health rows 将不同量纲压缩为并列 sparkline，避免重复五张完整坐标图。
  const enabled = useColor(options.color)
  const width = statsContentWidth()
  const rows = [
    metric === "cost"
      ? {
          // Cost 已由主图承担，secondary health 改看 Token，避免同页重复同一条费用序列。
          label: "Tokens",
          values: report.daily.map((day) => day.tokens.total),
          value: formatNumber(report.total.tokens.total),
          detail: "total",
          color: "blue" as const,
        }
      : {
          label: "Daily cost",
          values: report.daily.map((day) => day.cost),
          value: money(report.total.cost),
          detail: `avg ${money(safeDivide(report.total.cost, report.days))}/day`,
          color: "pink" as const,
        },
    {
      label: "Requests",
      values: report.daily.map((day) => day.requests),
      value: formatNumber(report.total.requests),
      detail: `${safeDivide(report.total.requests, report.days).toFixed(1)}/day`,
      color: "green" as const,
    },
    {
      label: "Cache read",
      values: report.daily.map((day) => safeDivide(day.tokens.cache.read, day.tokens.total) * 100),
      value: percent(report.total.tokens.cache.read, report.total.tokens.total),
      detail: "of tokens",
      color: "yellow" as const,
    },
    {
      label: "Failures",
      values: report.daily.map((day) => safeDivide(day.errors + day.aborted, day.requests) * 100),
      value: percent(report.total.errors + report.total.aborted, report.total.requests),
      detail: `${formatNumber(report.total.errors + report.total.aborted)} requests`,
      color: "red" as const,
    },
    {
      label: "Latency",
      values: report.daily.map((day) => safeDivide(day.durationMs, day.requests) / 1000),
      value: avgDuration(report.total.durationMs, report.total.requests),
      detail: "avg/request",
      color: "purple" as const,
    },
  ]
  // 窄屏每个指标拆成标题和 sparkline 两行，保证数值与趋势都完整。
  if (width < 80) {
    return [
      ...renderSectionDivider("Health and efficiency", enabled, width),
      "",
      ...rows.flatMap((row) => [
        ...wrapVisible(`${row.label} ${row.value} · ${row.detail}`, width).map((line) => color(line, "white", enabled, true)),
        `  ${sparkline(row.values, Math.max(6, Math.min(24, width - 2)), enabled, row.color)}`,
      ]),
    ]
  }
  const sparkWidth = Math.max(12, Math.min(32, width - 58))
  return [
    ...renderSectionDivider("Health and efficiency", enabled, width),
    "",
    ...rows.map((row) => `${padEndVisible(row.label, 14)} ${sparkline(row.values, sparkWidth, enabled, row.color)} ${padStartVisible(row.value, 10)}  ${muted(row.detail, enabled)}`),
  ]
}

const renderTimelineActivity = (titleText: string, series: UsageSeries[], metric: "tokens" | "cost", options: StatsRenderOptions) => {
  // Model/Provider 各保留前三条趋势，既提供归因又不与 Breakdown 重复整页排名。
  const enabled = useColor(options.color)
  const width = statsContentWidth()
  const total = series.reduce((sum, entry) => sum + (metric === "cost" ? entry.cost : entry.tokens.total), 0)
  const rows = series
    .filter((item) => (metric === "cost" ? item.cost : item.tokens.total) > 0)
    .slice(0, 3)
    .map((item, index) => ({
      label: terminalText(item.label),
      trend: sparkline(item.points.map((point) => metric === "cost" ? point.cost : point.tokens.total), 14, enabled, seriesColor(index)),
      value: metricFormatter(metric)(metric === "cost" ? item.cost : item.tokens.total),
      share: percent(metric === "cost" ? item.cost : item.tokens.total, total),
      // Timeline 的名称和 sparkline 共用索引色，用户无需跨行猜测短趋势属于哪个实体。
      color: seriesColor(index),
    }))
  const labelWidth = Math.min(28, Math.max(12, ...rows.map((row) => visibleLength(row.label))))
  return [
    title(titleText, enabled),
    ...rows.flatMap((row) => {
      // label 是不可信持久化文本，trend 则是本 renderer 生成的可信 ANSI；两者不能经过同一清理路径。
      const detail = `${row.trend}  ${metric} ${row.value} · share ${row.share}`
      if (visibleLength(row.label) <= labelWidth && visibleLength(`${row.label} ${detail}`) <= width) {
        return [`${padEndVisible(color(row.label, row.color, enabled, true), labelWidth)} ${detail}`]
      }
      return [color(row.label, row.color, enabled, true), ...wrapAnsiVisible(`  ${detail}`, width)]
    }),
  ]
}

const renderTimelineTokenComponents = (report: StatsReport, options: StatsRenderOptions) => {
  const enabled = useColor(options.color)
  const width = statsContentWidth()
  const sparkWidth = Math.max(8, Math.min(32, width - 66))
  return [
    title("Token components · each trend independently normalized", enabled),
    // 独立尺度只比较趋势形状；跨组件量级必须读取同一行的 total/share/peak。
    ...orderedTokenParts(report).flatMap((part) => {
      const meta = tokenPartMeta[part.id]
      const summary = `${meta.mark} ${part.label} ${formatNumber(part.total)} ${percent(part.total, report.total.tokens.total)} · peak ${formatNumber(Math.max(0, ...part.points.map((point) => point.value)))}/day`
      const trend = sparkline(part.points.map((point) => point.value), sparkWidth, enabled, meta.color)
      if (visibleLength(`${summary}  ${trend}`) <= width) return [`${summary}  ${trend}`]
      // 窄屏把趋势移到下一行，不截断组件名称或精确量级。
      return [...wrapVisible(summary, width), `  ${trend}`]
    }),
  ]
}


export function renderTimeline(report: StatsReport, options: StatsRenderOptions = {}) {
  // Timeline 只回答“何时变化以及组成如何”，不再重复三份相同日序列。
  // 跨实体的详细份额比较由 Breakdown 承担，避免端点职责重叠。
  const enabled = useColor(options.color)
  const metric = options.metric ?? "tokens"
  // 全空报告先短路；只有 Tool 数据的部分报告仍允许进入 Timeline 的稳定零趋势布局。
  if (!hasUsage(report)) return renderEmptyStatsPage(report, options, "timeline")
  if (metric === "cost" && report.total.cost <= 0) {
    // 零费用无法形成有意义的 cost 趋势，但请求、缓存和失败仍是有效观测，不应整页隐藏。
    return panel([
      ...renderRichHeader(report, options, "timeline", "Timeline / Cost"),
      muted("No positive cost recorded in this range.", enabled),
      "",
      ...renderTimelineHealth(report, options, metric),
    ], enabled)
  }
  // Top active days 只按当前 metric 排序，不能因另一量纲较大而改变日期排名。
  const sortedDays = [...report.daily]
    .filter((d) => (metric === "cost" ? d.cost : d.tokens.total) > 0)
    .sort((a, b) => (metric === "cost" ? b.cost - a.cost : b.tokens.total - a.tokens.total))
    .slice(0, 5)
  // Token 总量使用绝对 Y 轴，组件使用独立尺度；缓存主导时不能让小组件在堆积图中消失。
  // 主图始终占满可用宽度；组件/健康 small multiples 放在其后，不与长时间轴争宽度。
  const mainChart = metric === "cost"
    ? renderRoundedLineChart({
        // Section divider 已承担标题；图表 primitive 的首行在组合时移除，避免重复标题。
        title: "",
        series: [dailySeries(dailyCostPoints(report), "pink", "cost")],
        color: options.color,
        metric: "cost",
        width: fullChartWidth(),
        height: 8,
        points: false,
        legend: false,
      })
    : renderRoundedLineChart({
        title: "",
        series: [dailySeries(dailyTokenPoints(report), "blue", "tokens")],
        color: options.color,
        metric: "tokens",
        width: fullChartWidth(),
        height: 8,
        points: false,
        legend: false,
      })
  // 主图摘要复用折线的同一日序列；avg 按完整选择窗口计算，不能只除以活跃日而改变时间口径。
  const mainValues = report.daily.map((day) => metric === "cost" ? day.cost : day.tokens.total)
  // total 使用 report 汇总而不是再次累加采样点，保持筛选后的 header、图表和摘要同一口径。
  const mainTotal = metric === "cost" ? report.total.cost : report.total.tokens.total
  const mainPeak = Math.max(0, ...mainValues)
  const mainPeakDay = report.daily[mainValues.indexOf(mainPeak)]
  // Cost 额外公开活跃日数量；Token 只比较绝对量，避免把无请求日期解释为健康信号。
  const mainSummary = metric === "cost"
    ? `total ${money(mainTotal)} · avg ${money(safeDivide(mainTotal, report.days))}/day · peak ${money(mainPeak)}${mainPeakDay ? ` on ${shortDate(mainPeakDay.day)}` : ""} · ${mainValues.filter((value) => value > 0).length}/${report.days} active days`
    : `total ${formatNumber(mainTotal)} · peak ${formatNumber(mainPeak)}/day · avg ${formatNumber(safeDivide(mainTotal, report.days))}/day`

  // Model 与 Provider 共同回答“哪些实体驱动变化”，保留一个父级标题可避免被误读成两张重复主图。
  return panel(
    [
      ...renderRichHeader(report, options, "timeline", `Timeline / ${metric === "cost" ? "Cost" : "Tokens"}`),
      // Section 是页面导航锚点，chart.slice(1) 只移除 primitive 的空标题，不删除任何坐标或数据行。
      ...renderSectionDivider(metric === "cost" ? "Daily cost" : "Daily token volume", enabled, statsContentWidth()),
      "",
      ...mainChart.slice(1),
      muted(mainSummary, enabled),
      ...(metric === "tokens" ? ["", ...renderTimelineTokenComponents(report, options)] : []),
      "",
      ...renderTimelineHealth(report, options, metric),
      "",
      ...renderAnalyticalTable({
        title: metric === "cost" ? "Top cost days" : "Top active days",
        label: "date",
        headers: [metric, metric === "cost" ? "tokens" : "cost", "req", "fail", "cache", "output", "avg/req"],
        rows: sortedDays.map((day) => ({
          label: shortDate(day.day),
          values: [
            metric === "cost" ? money(day.cost) : formatNumber(day.tokens.total),
            metric === "cost" ? formatNumber(day.tokens.total) : money(day.cost),
            formatNumber(day.requests),
            percent(day.errors + day.aborted, day.requests),
            percent(day.tokens.cache.read, day.tokens.total),
            percent(outputTokens(day.tokens), day.tokens.total),
            avgDuration(day.durationMs, day.requests),
          ],
        })),
        color: options.color,
      }),
      "",
      ...renderSectionDivider(metric === "cost" ? "Cost drivers" : "Entity trends", enabled, statsContentWidth()),
      "",
      ...renderTimelineActivity("Models", report.modelSeries, metric, options),
      "",
      ...renderTimelineActivity("Providers", report.providerSeries, metric, options),
      // Heatmap 信息密度较低，仅在显式请求时追加，默认页保持一到两屏。
      ...(options.heatmap === true
        ? [
            "",
            // Heatmap 是显式附录，仍使用完整 section 层级而不是退化成主图后的无名字符块。
            ...renderSectionDivider(metric === "cost" ? "Cost heatmap · calendar view" : "Token heatmap · calendar view", enabled, statsContentWidth()),
            "",
            ...renderHeatmap({
              // 与主折线相同，section divider 是唯一标题，避免同一语义显示两次。
              title: "",
              points: metric === "cost" ? dailyCostPoints(report) : dailyTokenPoints(report),
              color: options.color,
              width: Math.min(Math.floor(statsContentWidth() * 0.7), statsContentWidth()),
              formatter: metricFormatter(metric),
            }).slice(1),
          ]
        : []),
    ],
    enabled,
  )
}

const percentileValue = (values: number[], quantile: number) => {
  // 会话分位数使用观测值，不做插值，表格中的值可对应到真实会话。
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b)
  if (sorted.length === 0) return 0
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * quantile))]
}

const renderSessionPopulation = (report: StatsReport, options: StatsRenderOptions) => {
  // Population 用标量建立总体与长尾基线，图形留给下方分布和单 Session 集中度。
  const enabled = useColor(options.color)
  const width = statsContentWidth()
  const tokenValues = report.sessions.map((session) => session.tokens.total)
  // 0 无法区分免费与缺失价格，只以正费用记录计算费用分位数。
  // Token 分位数仍使用全部 usage session，因此零费用不会隐藏真实长尾。
  const costValues = report.sessions.map((session) => session.cost).filter((cost) => cost > 0)
  const max = [...report.sessions].sort((a, b) => b.tokens.total - a.tokens.total)[0]
  const rows = [
    ["usage", `${formatNumber(report.total.tokens.total)} tokens · ${money(report.total.cost)} · ${report.sessionsWithUsage}/${report.totalSessions} sessions with usage · ${formatNumber(report.total.requests)} requests`],
    ["p50", `${formatNumber(percentileValue(tokenValues, 0.5))} tokens · ${money(percentileValue(costValues, 0.5))} · ${safeDivide(report.total.assistantCalls, report.sessionsWithUsage).toFixed(1)} calls/session`],
    ["p90", `${formatNumber(percentileValue(tokenValues, 0.9))} tokens · ${money(percentileValue(costValues, 0.9))}`],
    ["p95", `${formatNumber(percentileValue(tokenValues, 0.95))} tokens · ${money(percentileValue(costValues, 0.95))}`],
    ["p99", `${formatNumber(percentileValue(tokenValues, 0.99))} tokens · ${money(percentileValue(costValues, 0.99))}`],
    ["max", max ? `${formatNumber(max.tokens.total)} tokens · ${money(max.cost)} · ${formatNumber(max.requests)} requests · ${avgDuration(max.durationMs, max.requests)} avg/request` : "—"],
  ]
  return [
    // Population 是独立分析层级，不应与下方明细的普通实体标题混在同一视觉层。
    ...renderSectionDivider("Session population", enabled, width),
    "",
    ...rows.flatMap(([label, value]) => wrapVisible(`${padEndVisible(label, 7)} ${value}`, width)),
  ]
}

const renderSessionBands = (report: StatsReport, options: StatsRenderOptions) => {
  // Token 与 cost 都使用固定档位，但费用只统计正记录，0 不能被描述为已测得的低费用。
  const tokenBands = [
    { label: "<100K", min: 0, max: 100_000 },
    { label: "100K-1M", min: 100_000, max: 1_000_000 },
    { label: "1M-5M", min: 1_000_000, max: 5_000_000 },
    { label: "5M-50M", min: 5_000_000, max: 50_000_000 },
    { label: ">50M", min: 50_000_000, max: Number.POSITIVE_INFINITY },
  ]
  const costBands = [
    { label: "<$0.10", min: 0, max: 0.1 },
    { label: "$0.10-$1", min: 0.1, max: 1 },
    { label: "$1-$5", min: 1, max: 5 },
    { label: "$5-$10", min: 5, max: 10 },
    { label: ">$10", min: 10, max: Number.POSITIVE_INFINITY },
  ]
  const enabled = useColor(options.color)
  const width = statsContentWidth()
  const total = report.sessions.length
  const positiveCosts = report.sessions.filter((session) => session.cost > 0)
  const tokenCounts = tokenBands.map((band) => report.sessions.filter((session) => session.tokens.total >= band.min && session.tokens.total < band.max).length)
  const renderBands = (heading: string, bands: typeof tokenBands, counts: number[], sampleSize: number, colorName: keyof typeof theme) => {
    const max = Math.max(1, ...counts)
    const labelWidth = Math.max(...bands.map((band) => visibleLength(band.label)))
    const barWidth = Math.max(8, width - labelWidth - 20)
    return [
      // 两种分布共享相同 section primitive，避免普通标题让大量横条缺少页面锚点。
      ...renderSectionDivider(heading, enabled, width),
      "",
      ...bands.map((band, index) => `${padEndVisible(band.label, labelWidth)} ${metricBar(counts[index], max, barWidth, enabled, colorName)} ${padStartVisible(formatNumber(counts[index]), 5)} ${padStartVisible(percent(counts[index], sampleSize), 6)}`),
    ]
  }
  const sortedTokens = [...report.sessions].sort((a, b) => b.tokens.total - a.tokens.total)
  const top2 = sortedTokens.slice(0, 2).reduce((sum, session) => sum + session.tokens.total, 0)
  const top10 = sortedTokens.slice(0, 10).reduce((sum, session) => sum + session.tokens.total, 0)
  const tokenDistribution = [
    ...renderBands("Session size distribution · tokens", tokenBands, tokenCounts, total, "blue"),
    muted(`top 2 ${percent(top2, report.total.tokens.total)} · top 10 ${percent(top10, report.total.tokens.total)} · mean/median ${safeDivide(report.tokensPerSession, report.medianTokensPerSession).toFixed(1)}x`, enabled),
  ]
  if (positiveCosts.length === 0) {
    // 全零费用时彻底移除 cost bands，不能把所有 Session 塞入 `<$0.10` 档。
    return [
      ...tokenDistribution,
      "",
      ...renderSectionDivider("Session cost distribution", enabled, width),
      "",
      muted("Cost distribution unavailable: no positive cost recorded in this range.", useColor(options.color)),
    ]
  }
  return [
    ...tokenDistribution,
    "",
    // 标题公开正费用样本数，使费用分布的分母可以被用户直接审计。
    ...renderBands(
      `Session cost distribution · positive recorded cost (${positiveCosts.length} sessions)`,
      costBands,
      costBands.map((band) => positiveCosts.filter((session) => session.cost >= band.min && session.cost < band.max).length),
      positiveCosts.length,
      "pink",
    ),
    ...(report.sessions.length === positiveCosts.length ? [] : [muted(`No positive recorded cost · ${report.sessions.length - positiveCosts.length} sessions`, enabled)]),
  ]
}

const renderSessionLeaderboard = (report: StatsReport, sessions: StatsReport["sessions"], sort: NonNullable<StatsRenderOptions["sort"]>, options: StatsRenderOptions) => {
  // 每个会话同时展示 token、费用、请求/调用、消息/工具、失败、缓存和耗时。
  const enabled = useColor(options.color)
  const width = statsContentWidth()
  const projectLabels = new Map(report.projects.map((project) => [project.id, terminalText(project.label)]))
  const barWidth = Math.max(8, width - 40)
  return [
    // 排序和 bar 分母属于 section 语义，必须在 divider 上持续可见。
    ...renderSectionDivider(`Session leaderboard · sorted by ${sort} · bar = token share`, enabled, width),
    "",
    ...sessions.flatMap((session, index) => {
      const models = session.models.map(terminalText).join(", ") || "unknown"
      const providers = session.providers.map(terminalText).join(", ") || "unknown"
      const identity = `${index + 1} ${terminalText(session.title || session.id)}`
      const project = projectLabels.get(session.projectID) ?? terminalText(session.projectID)
      return [
        ...wrapVisible(identity, width).map((line) => color(line, "white", enabled, true)),
        `  token share ${metricBar(session.tokens.total, report.total.tokens.total, barWidth, enabled, seriesColor(index))} ${padStartVisible(percent(session.tokens.total, report.total.tokens.total), 6)} ${padStartVisible(formatNumber(session.tokens.total), 8)}`,
        ...wrapVisible(`project ${project} · ${money(session.cost)} · ${formatNumber(session.requests)} req / ${formatNumber(session.assistantCalls)} calls · ${formatNumber(session.messages)} msg / ${formatNumber(session.tools)} tools`, Math.max(12, width - 2)).map((line) => `  ${muted(line, enabled)}`),
        ...wrapVisible(`cache ${percent(session.tokens.cache.read, session.tokens.total)} · fail ${formatNumber(session.errors + session.aborted)} · ${avgDuration(session.durationMs, session.requests)} avg/request · updated ${shortDate(session.updated)}`, Math.max(12, width - 2)).map((line) => `  ${muted(line, enabled)}`),
        ...wrapVisible(`models ${models} · providers ${providers}`, Math.max(12, width - 2)).map((line) => `  ${muted(line, enabled)}`),
        "",
      ]
    }),
  ]
}

export function renderSessions(report: StatsReport, options: StatsRenderOptions = {}) {
  // limit 只影响榜单，Population 和 Distribution 始终基于完整会话集合。
  const enabled = useColor(options.color)
  if (!hasUsage(report)) return renderEmptyStatsPage(report, options, "sessions")
  // 默认 limit 随宽度降低；显式 -n 不经过响应式覆盖，脚本输出因此保持可预测。
  const sort = options.sort ?? "tokens"
  const sessions = [...report.sessions]
    .sort((a, b) => {
      if (sort === "tokens") return b.tokens.total - a.tokens.total
      if (sort === "updated") return b.updated - a.updated
      if (sort === "calls") return b.assistantCalls - a.assistantCalls
      return b.cost - a.cost || b.tokens.total - a.tokens.total
    })
    .slice(0, options.limit ?? (statsContentWidth() < 60 ? 3 : 5))

  // 页面按总体、分布、明细排序，先建立基线再定位具体离群会话。
  const lines = [
    ...renderRichHeader(report, options, "sessions", "Sessions"),
    ...renderSessionPopulation(report, options),
    "",
    ...renderSessionBands(report, options),
    "",
    ...renderSessionLeaderboard(report, sessions, sort, options),
    "",
    ...wrapVisible(`Visible ${sessions.length} of ${report.sessions.length} usage sessions · ${percent(sessions.reduce((sum, session) => sum + session.tokens.total, 0), report.total.tokens.total)} of tokens · ${percent(sessions.reduce((sum, session) => sum + session.cost, 0), report.total.cost)} of cost · use -n to change rows`, statsContentWidth()).map((line) => muted(line, enabled)),
  ]
  if (sessions.length === 0) lines.push(muted("No session usage data for this range.", enabled))
  return panel(lines, enabled)
}
