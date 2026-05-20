import type { DailyUsage, StatsReport, TokenTotals, UsageGroup, UsageSeries } from "./data"
import { formatNumber } from "../../format"
import {
  dailySeries,
  fitVisible,
  layersFromTokenParts,
  metricFormatter,
  renderCallout,
  renderComparisonTable,
  renderHeatmap,
  renderHistogram,
  renderMatrix,
  renderMetricRibbon,
  renderPercentStack,
  renderRankBars,
  renderRoundedLineChart,
  renderStackedAreaChart,
  renderTabs,
  renderThreeColumn,
  renderTwoColumn,
  seriesFromUsage,
  padEndVisible,
  padStartVisible,
  statsContentWidth,
  truncateVisible,
  visibleLength,
  type ChartColor,
  type ChartLayer,
  type ChartSeries,
} from "./charts"

export { formatNumber } from "../../format"

const RESET = "\x1b[0m"
const BOLD = "\x1b[1m"
const TEXT_RESET = "\x1b[22m\x1b[39m"

const fg = (r: number, g: number, b: number) => `\x1b[38;2;${r};${g};${b}m`
const bg = (r: number, g: number, b: number) => `\x1b[48;2;${r};${g};${b}m`

const theme = {
  bg: bg(19, 6, 24),
  title: fg(246, 241, 248),
  subtitle: fg(198, 171, 207),
  muted: fg(158, 130, 170),
  border: fg(116, 70, 124),
  sep: fg(142, 97, 152),
  blue: fg(78, 198, 224),
  cyan: fg(98, 226, 218),
  green: fg(95, 216, 139),
  yellow: fg(238, 203, 83),
  orange: fg(236, 145, 70),
  purple: fg(196, 123, 232),
  pink: fg(239, 119, 178),
  red: fg(246, 111, 125),
  white: fg(248, 244, 250),
  lavender: fg(184, 158, 198),
  mauve: fg(172, 126, 170),
  tealSoft: fg(126, 174, 176),
  amberSoft: fg(190, 162, 104),
  roseSoft: fg(198, 132, 158),
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

export const useColor = (mode: ColorMode = "auto") => {
  if (mode === "always") return true
  if (mode === "never") return false
  if (process.env.NO_COLOR) return false
  return Boolean(process.stdout.isTTY)
}

const color = (text: string, name: keyof typeof theme, enabled: boolean, bold = false) => {
  if (!enabled) return text
  return `${bold ? BOLD : ""}${theme[name]}${text}${TEXT_RESET}`
}

const panel = (lines: string[], enabled: boolean) => {
  const rows = lines.map((line) => `  ${fitVisible(line, statsContentWidth())}  `)
  if (!enabled) return rows.join("\n")
  return rows.map((line) => `${theme.bg}${line}${RESET}`).join("\n")
}

const dateRange = (report: StatsReport) => {
  if (report.requestedDays === 0) return "Today"
  if (report.requestedDays) return `Last ${report.requestedDays} days`
  if (report.daily.length === 0) return "All time"
  return `${new Date(report.dateRange.earliest).toLocaleDateString()} - ${new Date(report.dateRange.latest).toLocaleDateString()}`
}

const shortDate = (time: number) => {
  const date = new Date(time)
  return `${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`
}

const money = (value: number) => {
  if (!Number.isFinite(value) || value <= 0) return "—"
  if (value >= 100) return `$${value.toFixed(0)}`
  if (value >= 10) return `$${value.toFixed(1)}`
  if (value >= 1) return `$${value.toFixed(2)}`
  return `$${value.toFixed(4)}`
}

const percent = (value: number, total: number) => {
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
const activityColors = ["blue", "green", "yellow", "purple", "pink"] as const

const fullChartWidth = () => Math.max(38, statsContentWidth() - 8)
const halfChartWidth = () => Math.max(22, Math.floor((statsContentWidth() - 5) / 2) - 8)
const terminalContentWidth = () => statsContentWidth()
const layoutModeFor = (width: number) => width >= 130 ? "wide" : "medium"
const chartPlotWidth = (availableWidth: number) => Math.max(12, availableWidth - 8)

const dailyLabels = (daily: DailyUsage[]) => daily.map((item) => shortDate(item.day))

const dailyTokenPoints = (report: StatsReport) =>
  report.daily.map((item) => ({ day: item.day, label: shortDate(item.day), value: item.tokens.total }))

const dailyCostPoints = (report: StatsReport) =>
  report.daily.map((item) => ({ day: item.day, label: shortDate(item.day), value: item.cost }))

const dailyCacheHitPoints = (report: StatsReport) =>
  report.daily.map((item) => ({ day: item.day, label: shortDate(item.day), value: item.tokens.total > 0 ? (item.tokens.cache.read / item.tokens.total) * 100 : 0 }))

const dailyErrorRatePoints = (report: StatsReport) =>
  report.daily.map((item) => ({ day: item.day, label: shortDate(item.day), value: item.requests > 0 ? ((item.errors + item.aborted) / item.requests) * 100 : 0 }))

const groupRows = (groups: UsageGroup[], metric: "tokens" | "cost", limit: number) =>
  groups.slice(0, limit).map((group, index) => ({
    label: group.label,
    value: metric === "cost" ? group.cost : group.tokens.total,
    subvalue: `${formatNumber(group.assistantCalls)}c/${formatNumber(group.sessions)}s`,
    color: ["blue", "green", "yellow", "purple", "pink", "cyan", "orange", "red"][index % 8] as ChartColor,
  }))

const tokenPartRows = (report: StatsReport) => [
  {
    label: "All tokens",
    parts: [
      { label: "Input", value: report.total.tokens.input, color: "blue" as ChartColor },
      { label: "Output", value: report.total.tokens.output + report.total.tokens.reasoning, color: "green" as ChartColor },
      { label: "Cache Read", value: report.total.tokens.cache.read, color: "yellow" as ChartColor },
      { label: "Cache Write", value: report.total.tokens.cache.write, color: "purple" as ChartColor },
    ],
  },
]

const modelProviderMatrix = (report: StatsReport) => {
  const models = report.models.slice(0, 8)
  const providers = report.providers.slice(0, 6)
  const joint = new Map(report.modelProviderTokens.map((item) => [`${item.providerID}\0${item.modelID}`, item.tokens]))
  const values = providers.map((provider) =>
    models.map((model) => joint.get(`${provider.id}\0${model.id}`) ?? 0),
  )
  return { models, providers, values }
}

const sessionCostValues = (report: StatsReport) => report.sessions.map((session) => session.cost)

const sessionTokenValues = (report: StatsReport) => report.sessions.map((session) => session.tokens.total)

const safeDivide = (value: number, divisor: number) => {
  if (!divisor || !Number.isFinite(value) || !Number.isFinite(divisor)) return 0
  return value / divisor
}

const avgDuration = (durationMs: number, requests: number) => {
  const seconds = safeDivide(durationMs, requests) / 1000
  if (seconds >= 60) return `${(seconds / 60).toFixed(1)}m`
  return `${seconds.toFixed(1)}s`
}

const cacheShare = (tokens: TokenTotals) => percent(tokens.cache.read + tokens.cache.write, tokens.total)
const cacheTokens = (tokens: TokenTotals) => tokens.cache.read + tokens.cache.write
const outputTokens = (tokens: TokenTotals) => tokens.output + tokens.reasoning
const inputContextTokens = (group: UsageGroup) =>
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

const tokenComponentLineSeries = (report: StatsReport): ChartSeries[] =>
  report.tokenPartSeries
    .filter((part) => part.total > 0)
    .map((part, index) => ({
      id: part.id,
      label: part.label,
      color: ["blue", "green", "yellow", "purple"][index % 4] as ChartColor,
      mark: ["●", "◆", "■", "▲"][index % 4],
      total: part.total,
      points: part.points.map((point) => ({ x: point.day, y: point.value, label: point.label, value: point.value })),
    }))

const sparkline = (values: number[], width: number, enabled: boolean, name: (typeof activityColors)[number]) => {
  const chars = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"]
  const max = Math.max(0, ...values.filter(Number.isFinite))
  const sampled = Array.from({ length: width }, (_, index) => {
    if (values.length === 0) return 0
    return values[Math.round((index / Math.max(1, width - 1)) * (values.length - 1))] ?? 0
  })
  return sampled.map((value) => color(chars[max <= 0 ? 0 : Math.min(chars.length - 1, Math.floor((value / max) * (chars.length - 1)))], name, enabled)).join("")
}

const activityRows = (titleText: string, series: UsageSeries[], metric: "tokens" | "cost", limit: number, enabled: boolean) => {
  const formatter = metricFormatter(metric)
  const rows = series
    .filter((item) => (metric === "cost" ? item.cost : item.tokens.total) > 0)
    .slice(0, limit)
  return [
    title(titleText, enabled),
    ...rows.map((item, index) => {
      const itemColor = activityColors[index % activityColors.length]
      const total = metric === "cost" ? item.cost : item.tokens.total
      const values = item.points.map((point) => metric === "cost" ? point.cost : point.tokens.total)
      return `${fitVisible(color(item.label, "white", enabled, true), 24)} ${sparkline(values, 14, enabled, itemColor)} ${padStartVisible(formatter(total), 9)}`
    }),
  ]
}

const renderUsageGroupDetails = (input: {
  title: string
  groups: UsageGroup[]
  total: UsageGroup | StatsReport["total"]
  metric: "tokens" | "cost"
  limit: number
  enabled: boolean
}) => {
  const maxMetric = Math.max(0, ...input.groups.slice(0, input.limit).map((group) => input.metric === "cost" ? group.cost : group.tokens.total))
  const maxSessions = Math.max(0, ...input.groups.slice(0, input.limit).map((group) => group.sessions))
  const width = statsContentWidth()
  const labelWidth = Math.max(10, Math.min(34, width - 52))
  const barWidth = Math.max(8, Math.min(42, width - 44))
  const marks = ["●", "◆", "■", "▲", "◇", "○", "+", "×"]
  const colors = ["blue", "green", "yellow", "purple", "pink", "cyan", "orange", "red"] as const
  return [
    title(input.title, input.enabled),
    ...input.groups.slice(0, input.limit).flatMap((group, index) => {
      const groupColor = colors[index % colors.length]
      const metricValue = input.metric === "cost" ? group.cost : group.tokens.total
      const shareBase = input.metric === "cost" ? input.total.cost : input.total.tokens.total
      return [
        fitVisible(
          `${padStartVisible(String(index + 1), 2)} ${color(marks[index % marks.length], groupColor, input.enabled)} ${fitVisible(color(group.label, "white", input.enabled, true), labelWidth)} ${padStartVisible(money(group.cost), 9)} ${padStartVisible(`${formatNumber(group.tokens.total)} tok`, 13)} ${padStartVisible(`${formatNumber(group.assistantCalls)} calls`, 11)} ${padStartVisible(percent(metricValue, shareBase), 7)}`,
          width,
        ),
        fitVisible(
          `   ${metricBar(metricValue, maxMetric, barWidth, input.enabled, groupColor)}  In ${formatNumber(group.tokens.input)} / Out ${formatNumber(outputTokens(group.tokens))} / Cache ${formatNumber(cacheTokens(group.tokens))}`,
          width,
        ),
        fitVisible(
          `   ${metricBar(group.sessions, maxSessions, barWidth, input.enabled, "border")}  ${formatNumber(group.sessions)} sessions · req ${formatNumber(group.requests)} · cache ${cacheShare(group.tokens)}`,
          width,
        ),
      ]
    }),
  ]
}

const renderInputComponentTable = (by: BreakdownDimension, groups: UsageGroup[], options: StatsRenderOptions, limit: number) => {
  const rows = groups
    .filter((group) => inputContextTokens(group) > 0)
    .slice(0, limit)
    .map((group) => [
      truncateVisible(group.label, 18),
      formatNumber(inputContextTokens(group)),
      formatNumber(group.components.toolSchemas),
      formatNumber(group.components.userMessages),
      formatNumber(group.components.toolResults),
      formatNumber(group.components.attachments),
    ])
  if (rows.length === 0) return []
  return renderComparisonTable({
    title: `${breakdownTitle(by)} input context components · est tokens`,
    headers: [by, "ctx", "schemas", "user", "tool out", "attach"],
    rows,
    color: options.color,
  })
}

const requestOutcomeLayers = (report: StatsReport): ChartLayer[] => [
  {
    id: "completed",
    label: "Completed",
    color: "green",
    values: report.daily.map((day) => Math.max(0, day.requests - day.errors - day.aborted)),
    total: Math.max(0, report.total.requests - report.total.errors - report.total.aborted),
  },
  {
    id: "errors",
    label: "Errors",
    color: "red",
    values: report.daily.map((day) => day.errors),
    total: report.total.errors,
  },
  {
    id: "aborted",
    label: "Aborted",
    color: "yellow",
    values: report.daily.map((day) => day.aborted),
    total: report.total.aborted,
  },
]

const breakdownTitle = (by: BreakdownDimension) => {
  if (by === "model") return "Models"
  if (by === "provider") return "Providers"
  if (by === "agent") return "Agents"
  if (by === "source") return "Sources"
  if (by === "project") return "Projects"
  if (by === "status") return "Request status"
  return "Tools"
}

const breakdownGroups = (report: StatsReport, by: BreakdownDimension) => {
  if (by === "model") return report.models
  if (by === "provider") return report.providers
  if (by === "agent") return report.agents
  if (by === "source") return report.sources
  if (by === "project") return report.projects
  if (by === "status") return report.statuses
  return []
}

const breakdownSeries = (report: StatsReport, by: BreakdownDimension) => {
  if (by === "model") return report.modelSeries
  if (by === "provider") return report.providerSeries
  if (by === "agent") return report.agentSeries
  if (by === "source") return report.sourceSeries
  if (by === "project") return report.projectSeries
  if (by === "status") return report.statusSeries
  return []
}

const breakdownRows = (groups: UsageGroup[], report: StatsReport, limit: number) =>
  groups.slice(0, limit).map((group) => [
    truncateVisible(group.label, 26),
    money(group.cost),
    formatNumber(group.tokens.total),
    formatNumber(group.requests),
    formatNumber(group.assistantCalls),
    percent(group.cost, report.total.cost),
    money(safeDivide(group.cost, group.requests)),
  ])

const renderRichHeader = (report: StatsReport, options: StatsRenderOptions, active: string) => {
  const enabled = useColor(options.color)
  return [
    title("opencode stats", enabled),
    muted(`${dateRange(report)}${sep(enabled)}${report.days} day window${sep(enabled)}${report.sessionsWithUsage}/${report.totalSessions} sessions with usage`, enabled),
    renderMetricRibbon({
      color: options.color,
      metrics: [
        { label: "Cost", value: money(report.total.cost), color: "pink", detail: `${money(report.total.cost / Math.max(report.days, 1))}/day` },
        { label: "Tokens", value: formatNumber(report.total.tokens.total), color: "blue", detail: `${formatNumber(report.tokensPerSession)} avg/session` },
        { label: "Requests", value: formatNumber(report.total.requests), color: "green" },
        { label: "Cache", value: cacheShare(report.total.tokens), color: "yellow" },
        { label: "Errors", value: formatNumber(report.total.errors + report.total.aborted), color: "red" },
      ],
    }),
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
  if (width >= 100) return renderRichHeader(report, options, "dashboard")
  const enabled = useColor(options.color)
  return [
    title("opencode stats", enabled),
    muted(`${dateRange(report)}${sep(enabled)}${report.days} day window${sep(enabled)}${report.sessionsWithUsage}/${report.totalSessions} sessions`, enabled),
    `${color("●", "pink", enabled)} Cost ${money(report.total.cost)}  ${color("●", "blue", enabled)} Tok ${formatNumber(report.total.tokens.total)}  ${color("●", "green", enabled)} Req ${formatNumber(report.total.requests)}`,
    `${color("●", "yellow", enabled)} Cache ${cacheShare(report.total.tokens)}  ${color("●", "red", enabled)} Err ${formatNumber(report.total.errors + report.total.aborted)}`,
    renderTabs({
      color: options.color,
      tabs: ["dashboard", "timeline", "breakdown", "sessions", "insights"].map((label) => ({ label, active: label === "dashboard" })),
    }),
    "",
  ]
}

const sortGroups = (groups: UsageGroup[], sort: StatsRenderOptions["sort"] = "tokens") =>
  [...groups].sort((a, b) => {
    if (sort === "cost") return b.cost - a.cost || b.tokens.total - a.tokens.total
    if (sort === "calls") return b.assistantCalls - a.assistantCalls || b.tokens.total - a.tokens.total
    return b.tokens.total - a.tokens.total || b.cost - a.cost
  })

const topGroups = (groups: UsageGroup[], options: StatsRenderOptions) =>
  sortGroups(groups, options.sort ?? "tokens").slice(0, options.limit ?? 8)

// Dashboard helpers stay local to this file because they compose existing chart
// primitives rather than adding new public chart types. The public surface stays
// `renderDashboard(report, options)`, which is what the tests exercise.
const renderSectionDivider = (label: string, enabled: boolean, width: number, subtitle?: string) => {
  const maxLabel = Math.min(visibleLength(label), 40)
  const head = `━━━ ${clipVisible(label, maxLabel)} `
  const divider = color(`${head}${"─".repeat(Math.max(3, width - visibleLength(head)))}`, "border", enabled)
  return subtitle ? [divider, muted(`  ${subtitle}`, enabled)] : [divider]
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

const intensityGlyph = (level: { char: string; color: keyof typeof theme }, enabled: boolean, width = 1) =>
  color(level.char === "·" ? level.char : level.char.repeat(width), level.color, enabled)
const plainIntensityGlyph = (level: { char: string }, width = 1) =>
  level.char === "·" ? level.char : level.char.repeat(width)

const hourActivity = (report: StatsReport) =>
  report.sessions.reduce(
    (buckets, session) => {
      buckets[new Date(session.updated).getHours()] += Math.max(1, session.requests)
      return buckets
    },
    Array.from({ length: 24 }, () => 0),
  )

const dayOfWeekTokens = (report: StatsReport) =>
  report.daily.reduce(
    (buckets, day) => {
      buckets[(new Date(day.day).getDay() + 6) % 7] += day.tokens.total
      return buckets
    },
    Array.from({ length: 7 }, () => 0),
  )

const renderHourOfDayStrip = (report: StatsReport, width: number) => {
  const buckets = hourActivity(report)
  const nonZero = buckets.map((value, hour) => ({ value, hour })).filter((item) => item.value > 0)
  const peak = [...nonZero].sort((a, b) => b.value - a.value)[0]
  const quiet = [...nonZero].sort((a, b) => a.value - b.value)[0]
  // 24 chars, one per hour — no compression
  const dataLine = buckets.map((value) => plainIntensityGlyph(requestIntensity(value))).join("")
  const legendLine = "· =0  ░ <50  ▒ <150  ▓ <300  █ ≥300"
  return [
    "Hour-of-day · avg requests per hour",
    "",
    "00  04  08  12  16  20",
    dataLine,
    "",
    peak ? `peak  ${String(peak.hour).padStart(2, "0")}:00 — ${formatNumber(peak.value)} req` : "no hourly activity",
    quiet ? `quiet ${String(quiet.hour).padStart(2, "0")}:00 — ${formatNumber(quiet.value)} req` : "",
    "",
    `legend  ${legendLine}`,
  ]
}

const rangeLabels = (start: number, end: number, step: number) =>
  Array.from({ length: Math.floor((end - start) / step) + 1 }, (_, index) => String(start + index * step).padStart(2, "0"))

const isoWeek = (time: number) => {
  const date = new Date(time)
  const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
  target.setUTCDate(target.getUTCDate() + 3 - ((target.getUTCDay() + 6) % 7))
  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4))
  return 1 + Math.round(((target.getTime() - firstThursday.getTime()) / 86_400_000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7)
}

const renderCalendarActivity = (report: StatsReport, width: number) => {
  const byDay = new Map(report.daily.map((day) => [day.day, day.tokens.total]))
  const first = report.daily[0]?.day ?? Date.now()
  const last = report.daily.at(-1)?.day ?? first
  const start = first - ((new Date(first).getUTCDay() + 6) % 7) * 86_400_000
  const weeks = Math.max(1, Math.ceil((last - start + 86_400_000) / (7 * 86_400_000)))
  // Calendar cells remain adaptive: narrow columns use one glyph, wider columns
  // use two glyphs while keeping weekday headers on the same fixed grid.
  const glyphWidth = width >= 42 ? 2 : 1
  const cellWidth = glyphWidth + 2
  const cell = (tokens: number) => fitPlain(` ${plainIntensityGlyph(tokenIntensity(tokens), glyphWidth)}`, cellWidth)
  const legendLine = `░ <50M   ▒ 50-150M   ▓ 150-250M   █ >250M`
  return [
    "Calendar · cell intensity = daily tokens",
    "",
    `     ${["M", "T", "W", "T", "F", "S", "S"].map((d) => fitPlain(` ${d}`, cellWidth)).join("")}`,
    ...Array.from({ length: weeks }, (_, week) => {
      const weekStart = start + week * 7 * 86_400_000
      const cells = Array.from({ length: 7 }, (_, day) => cell(byDay.get(weekStart + day * 86_400_000) ?? 0)).join("")
      return `${padStartVisible(String(isoWeek(weekStart)), 4)} ${cells}`
    }),
    "",
    legendLine,
  ]
}

// Activity is deliberately three small views of the same window: calendar for
// date-level rhythm, hour strip for intra-day load, and weekday share for bias.
const renderDayOfWeekShare = (report: StatsReport, enabled: boolean, width: number) => {
  const buckets = dayOfWeekTokens(report)
  const total = buckets.reduce((sum, value) => sum + value, 0)
  const max = Math.max(0, ...buckets)
  const barWidth = Math.max(6, width - 14)
  return [
    title("Day-of-week · share of total tokens", enabled),
    ...["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((label, index) => {
      const filled = max <= 0 ? 0 : Math.round((buckets[index] / max) * barWidth)
      return `${label} ${color("▇".repeat(filled), index >= 5 ? "mauve" : "lavender", enabled)}${" ".repeat(Math.max(0, barWidth - filled))} ${padStartVisible(percent(buckets[index], total), 6)}`
    }),
  ]
}

const renderDailyActivitySection = (report: StatsReport, options: StatsRenderOptions, mode: ReturnType<typeof layoutModeFor>, width: number) => {
  const calendarWidth = width < 100 ? width : mode === "wide" ? Math.floor((width - 10) / 3) : Math.floor((width - 4) / 2)
  const sideWidth = mode === "wide" ? Math.max(24, calendarWidth) : Math.max(24, width < 100 ? width : width - 4 - calendarWidth)
  const calendar = renderCalendarActivity(report, calendarWidth)
  const hour = renderHourOfDayStrip(report, sideWidth)
  const dow = renderDayOfWeekShare(report, useColor(options.color), sideWidth)
  if (width < 100) return [...calendar, "", ...hour, "", ...dow]
  if (mode === "wide") return renderThreeColumn(calendar, hour, dow, 5, width)
  return renderTwoColumn(calendar, [...hour, "", ...dow], 4, width, 0.5)
}

// Token components are no longer stacked in the dashboard. Each component uses a
// one-series line chart, so low-share output/cache-write data keeps its shape.
const orderedTokenParts = (report: StatsReport) =>
  (["cacheRead", "input", "cacheWrite", "output"] as const).flatMap((id) => {
    const part = report.tokenPartSeries.find((item) => item.id === id)
    if (!part) return []
    return [{ ...part, label: id === "output" ? "Output" : part.label }]
  })

const renderTokenComponentSmallChart = (part: ReturnType<typeof orderedTokenParts>[number], report: StatsReport, options: StatsRenderOptions, width: number) => {
  const meta = {
    cacheRead: { color: "yellow", mark: "▓" },
    input: { color: "blue", mark: "░" },
    cacheWrite: { color: "purple", mark: "▒" },
    output: { color: "green", mark: "▎" },
  }[part.id] as { color: ChartColor; mark: string }
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
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] ?? 0
}

const renderCostHealthSubchart = (titleText: string, id: string, colorName: ChartColor, points: ReturnType<typeof dailyCostPoints>, width: number, metric: "tokens" | "cost", options: StatsRenderOptions, summary: string, yRange?: { min: number; max: number }) => [
  ...renderRoundedLineChart({ title: titleText, series: [dailySeries(points, colorName, id)], color: options.color, metric, width: chartPlotWidth(width), height: 7, points: false, legend: false, yMin: yRange?.min, yMax: yRange?.max }),
  muted(summary, useColor(options.color)),
]

// Wide terminals get the three health charts side-by-side. Medium terminals put
// Error before Cache, then give Cache the released full-width row for clarity.
const renderCostHealthSection = (report: StatsReport, options: StatsRenderOptions, mode: ReturnType<typeof layoutModeFor>, width: number, halfWidth: number, thirdWidth: number) => {
  const costPeak = [...report.daily].sort((a, b) => b.cost - a.cost)[0]
  const cacheRates = dailyCacheHitPoints(report).map((point) => point.value).filter((value) => value > 0)
  const errorPeak = dailyErrorRatePoints(report).sort((a, b) => b.value - a.value)[0]
  const errorAvg = safeDivide(report.total.errors + report.total.aborted, report.total.requests) * 100
  const pairWidth = width < 100 ? Math.max(38, width - 4) : mode === "wide" ? thirdWidth : halfWidth
  const dailyCost = renderCostHealthSubchart("Daily cost ($/day)", "cost", "pink", dailyCostPoints(report), pairWidth, "cost", options, costPeak ? `peak ${money(costPeak.cost)} on ${shortDate(costPeak.day)} · median ${money(median(report.daily.map((day) => day.cost)))}` : "no cost activity")
  const cacheRange = cacheRates.length ? { min: Math.max(0, Math.floor(Math.min(...cacheRates) / 10) * 10), max: Math.min(100, Math.ceil(Math.max(...cacheRates) / 10) * 10) } : undefined
  const cacheHit = renderCostHealthSubchart("Cache hit rate (%)", "cache", "yellow", dailyCacheHitPoints(report), mode === "wide" ? thirdWidth : Math.max(38, width - 4), "tokens", options, cacheRates.length ? `range ${Math.min(...cacheRates).toFixed(1)}% → ${Math.max(...cacheRates).toFixed(1)}% · ${Math.max(...cacheRates) - Math.min(...cacheRates) < 10 ? "stable" : "variable"}` : "no cache activity", cacheRange)
  const errorRate = renderCostHealthSubchart("Abort & error rate (%)", "errors", "red", dailyErrorRatePoints(report), pairWidth, "tokens", options, errorPeak && errorPeak.value > 0 ? `spike ${errorPeak.value.toFixed(1)}% on ${shortDate(errorPeak.day)} · avg ${errorAvg.toFixed(1)}%` : "no errors recorded")
  if (mode === "wide") return renderThreeColumn(dailyCost, cacheHit, errorRate, 5, width)
  if (width < 100) return [...dailyCost, "", ...errorRate, "", ...cacheHit]
  return [...renderTwoColumn(dailyCost, errorRate, 5, width, 0.5), "", ...cacheHit]
}

const renderTopModelsLollipop = (report: StatsReport, options: StatsRenderOptions, width: number) => {
  const enabled = useColor(options.color)
  const models = topGroups(report.models, { ...options, limit: options.limit ?? 6, sort: "tokens" })
  if (models.length === 0) return [muted("No model data in range", enabled)]
  const max = Math.max(0, ...models.map((model) => model.tokens.total))
  const labelWidth = Math.max(16, Math.min(30, Math.max(...models.map((model) => visibleLength(model.label))) + 1))
  const perCallWidth = 9
  const barWidth = Math.max(12, width - labelWidth - 43 - perCallWidth - 3)
  return [
    muted(`${" ".repeat(labelWidth)} │ tokens${" ".repeat(Math.max(1, barWidth - 6))} │ share  │ cost     │ per-call`, enabled),
    ...models.map((model, index) => {
      const filled = Math.max(1, Math.round(safeDivide(model.tokens.total, max) * Math.max(1, barWidth - 10)))
      const perCall = `${formatNumber(safeDivide(model.tokens.total, model.assistantCalls))}/c`
      return fitPlain(`${padEndVisible(clipVisible(model.label, labelWidth), labelWidth)} │${color("●" + "━".repeat(Math.max(0, filled - 1)), activityColors[index % activityColors.length], enabled)} ${padEndVisible(formatNumber(model.tokens.total), Math.max(1, barWidth - filled))} │ ${padStartVisible(percent(model.tokens.total, report.total.tokens.total), 6)} │ ${padStartVisible(money(model.cost), 8)} │ ${padStartVisible(perCall, perCallWidth)}`, width)
    }),
  ]
}

const renderTopProvidersStack = (report: StatsReport, options: StatsRenderOptions, width: number) => {
  const enabled = useColor(options.color)
  const providers = sortGroups(report.providers, "tokens")
  if (providers.length === 0) return [muted("No provider data in range", enabled)]
  const barWidth = Math.max(20, width - 2)
  const colors = ["yellow", "green", "blue", "purple", "cyan", "pink"] as const
  const chars = ["▓", "█", "░", "▒", "▓", "▒"]
  const top = providers.slice(0, 6)
  const otherTokens = providers.slice(6).reduce((sum, provider) => sum + provider.tokens.total, 0)
  const pieces = [
    ...top.map((provider) => ({ label: provider.label, tokens: provider.tokens.total, cost: provider.cost })),
    ...(otherTokens > 0 ? [{ label: "other", tokens: otherTokens, cost: providers.slice(6).reduce((sum, provider) => sum + provider.cost, 0) }] : []),
  ].map((provider, index) => ({ provider, color: colors[index % colors.length], char: chars[index] ?? "█" }))
  const baseSizes = pieces.map((piece) => Math.max(1, Math.floor(safeDivide(piece.provider.tokens, report.total.tokens.total) * barWidth)))
  const sizes = baseSizes.map((size, index) => index === baseSizes.length - 1 ? Math.max(1, size + barWidth - baseSizes.reduce((sum, item) => sum + item, 0)) : size)
  const bar = pieces.map((piece, index) => color(piece.char.repeat(Math.max(1, sizes[index] ?? 1)), piece.color, enabled)).join("")
  const pctLine = pieces.map((piece, index) => padEndVisible(percent(piece.provider.tokens, report.total.tokens.total), Math.max(visibleLength(percent(piece.provider.tokens, report.total.tokens.total)) + 1, sizes[index] ?? 1))).join("")
  const itemsPerRow = width >= 110 ? 3 : 2
  const legendGap = width >= 110 ? 6 : 4
  const colWidth = Math.min(38, Math.floor((width - legendGap * (itemsPerRow - 1)) / itemsPerRow))
  return [fitPlain(bar, barWidth), muted(fitPlain(pctLine, barWidth), enabled), "", ...pieces.map((piece) => {
    const labelWidth = Math.max(8, colWidth - 20)
    return `${color(piece.char, piece.color, enabled)} ${padEndVisible(color(clipVisible(piece.provider.label, labelWidth), "white", enabled, true), labelWidth)} ${padStartVisible(formatNumber(piece.provider.tokens), 7)} ${padStartVisible(money(piece.provider.cost), 8)}`
  }).reduce<string[]>((rows, item, index) => {
    if (index % itemsPerRow === 0) rows.push("")
    rows[rows.length - 1] += `${index % itemsPerRow === 0 ? "" : " ".repeat(legendGap)}${padEndVisible(item, colWidth)}`
    return rows
  }, [])]
}

const sessionPercentile = (report: StatsReport, q: number) => {
  const sorted = report.sessions.map((session) => session.tokens.total).sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0
}

const renderSessionDistribution = (report: StatsReport, options: StatsRenderOptions, width: number) => {
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
  const enabled = useColor(options.color)
  const sessions = [...report.sessions].sort((a, b) => b.tokens.total - a.tokens.total || b.cost - a.cost).slice(0, options.limit ?? 5)
  const max = Math.max(0, ...sessions.map((session) => session.tokens.total))
  const barWidth = Math.max(18, width - 14)
  return [
    title("Top sessions by tokens", enabled),
    ...sessions.flatMap((session, index) => [
      `#${index + 1} ${padEndVisible(color(clipVisible(session.title || session.id, Math.max(20, width - 28)), "white", enabled, true), Math.max(20, width - 28))} ${padStartVisible(money(session.cost), 8)} ${padStartVisible(formatNumber(session.tokens.total), 8)} tok`,
      `   ${metricBar(session.tokens.total, max, barWidth, enabled, "blue")} ${padStartVisible(percent(session.tokens.total, max), 5)}`,
      `   ${muted(`${session.models.slice(0, 2).join(" · ") || "?"} · ${formatNumber(session.requests)} req · ${avgDuration(session.durationMs, session.requests)} avg`, enabled)}`,
      "",
    ]),
  ]
}

const renderInsightsCallout = (report: StatsReport, options: StatsRenderOptions) => {
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
          errorTotal > 0 ? "  → opencode stats insights --wasted" : "  → keep watching error-rate trend.",
          `▸ Top 2 sessions: ${percent(top2, report.total.tokens.total)} of tokens.`,
          `▸ Cache hit: ${cachePct.toFixed(1)}%; review prompt reuse.`,
        ].join("\n")
      : [
          errorTotal > 0 ? `▸ ${formatNumber(errorTotal)} failed/aborted requests (${errorRate.toFixed(1)}% rate).` : "▸ No failed or aborted requests in this range.",
          errorTotal > 0 ? "  → run  opencode stats insights --wasted   to surface root causes." : "  → keep watching the error-rate chart for regressions.",
          `▸ Top 2 sessions account for ${percent(top2, report.total.tokens.total)} of all tokens; consider splitting long sessions.`,
          `▸ Cache hit rate is ${cachePct.toFixed(1)}%; further gains likely require prompt restructuring.`,
        ].join("\n"),
    color: options.color,
    accent: "purple",
  })
}

export function renderStatsHeader(report: StatsReport, options: StatsRenderOptions, active: string) {
  return renderRichHeader(report, options, active)
}

export function renderDashboard(report: StatsReport, options: StatsRenderOptions = {}) {
  const enabled = useColor(options.color)
  const totalWidth = terminalContentWidth()
  const mode = layoutModeFor(totalWidth)
  const gap = 5
  const halfWidth = Math.max(30, Math.floor((totalWidth - gap) / 2))
  const thirdWidth = Math.max(28, Math.floor((totalWidth - gap * 2) / 3))
  const sessionLeftWidth = Math.max(30, Math.floor((totalWidth - gap) * 0.42))
  const sessionRightWidth = Math.max(30, totalWidth - gap - sessionLeftWidth)

  // The dashboard is intentionally section-first. Each block owns one question,
  // while timeline/breakdown/sessions keep their existing detailed renderers.
  const lines = [
    ...renderDashboardHeader(report, options, totalWidth),
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
  const enabled = useColor(options.color)
  const by = options.by ?? "model"
  const metric = options.metric ?? "tokens"
  const sort = options.sort ?? "tokens"
  const groups = sortGroups(breakdownGroups(report, by), sort)
  const limit = options.limit ?? 12

  if (by === "tool") {
    const hasContextTokens = report.toolUsage.some((tool) => tool.contextTokens > 0)
    const gap = 5
    const contentWidth = statsContentWidth()
    const ledgerWidth = Math.min(76, Math.max(42, Math.floor(contentWidth * 0.55)))
    const rankWidth = Math.max(24, contentWidth - gap - ledgerWidth)
    const rows = report.toolUsage.slice(0, limit).map((tool, index) => ({
      label: tool.id,
      value: hasContextTokens && metric === "tokens" ? tool.contextTokens : tool.count,
      subvalue: hasContextTokens ? `${formatNumber(tool.count)} calls` : percent(tool.count, report.totalTools),
      color: ["yellow", "blue", "green", "purple", "pink", "cyan"][index % 6] as ChartColor,
    }))
    const tokenTotal = report.toolUsage.reduce((sum, tool) => sum + tool.contextTokens, 0)
    return panel(
      [
        ...renderRichHeader(report, options, "breakdown"),
        title(`Tool breakdown · ${report.totalTools} total calls · ${formatNumber(tokenTotal)} est context tokens`, enabled),
        muted("Estimated ctx tokens from step inputBreakdown.", enabled),
        muted("Allocation uses tool-call/result chars × confirmed input/cache tokens.", enabled),
        "",
        ...renderRoundedLineChart({
          title: "Tool context tokens over time",
          series: seriesFromUsage(report.toolSeries, "tokens", Math.min(limit, 8)),
          color: options.color,
          metric: "tokens",
          width: fullChartWidth(),
          height: 12,
        }),
        "",
        ...renderTwoColumn(
          renderRankBars({
            title: hasContextTokens && metric === "tokens" ? "Tool context tokens" : "Tool calls",
            rows,
            color: options.color,
            totalWidth: rankWidth,
            labelWidth: 18,
            subvalueWidth: 10,
            formatter: formatNumber,
          }),
          renderComparisonTable({
            title: "Tool ledger",
            headers: ["tool", "calls", "ctx tok", "in chars", "out chars", "share"],
            rows: report.toolUsage.slice(0, limit).map((tool) => [
              truncateVisible(tool.id, 22),
              formatNumber(tool.count),
              formatNumber(tool.contextTokens),
              formatNumber(tool.inputChars),
              formatNumber(tool.outputChars),
              hasContextTokens ? percent(tool.contextTokens, tokenTotal) : percent(tool.count, report.totalTools),
            ]),
            color: options.color,
          }),
          gap,
          contentWidth,
          rankWidth / Math.max(1, contentWidth - gap),
        ),
      ],
      enabled,
    )
  }

  const topGroup = groups[0]
  const topShare = topGroup ? percent(metric === "cost" ? topGroup.cost : topGroup.tokens.total, metric === "cost" ? report.total.cost : report.total.tokens.total) : "—"
  const summaryLine = topGroup
    ? `${breakdownTitle(by)} · top: ${topGroup.label} (${topShare}) · ${groups.length} total · sorted by ${sort === "cost" ? "cost" : sort === "calls" ? "calls" : "tokens"}`
    : `${breakdownTitle(by)} · no data in this range`
  const ledgerGap = 4
  const contentWidth = statsContentWidth()
  const ledgerWidth = Math.min(82, Math.max(42, Math.floor(contentWidth * 0.58)))
  const rankWidth = Math.max(24, contentWidth - ledgerGap - ledgerWidth)

  const lines = [
    ...renderRichHeader(report, options, "breakdown"),
    muted(summaryLine, enabled),
    "",
    ...renderRoundedLineChart({
      title: `${breakdownTitle(by)} over time`,
      series: seriesFromUsage(breakdownSeries(report, by), metric, Math.min(limit, 8)),
      color: options.color,
      metric,
      width: fullChartWidth(),
      height: 12,
    }),
    "",
    ...renderUsageGroupDetails({
      title: `${breakdownTitle(by)} token detail`,
      groups: topGroups(groups, { ...options, limit, sort }),
      total: report.total,
      metric,
      limit,
      enabled,
    }),
    "",
    ...renderTwoColumn(
      renderRankBars({
        title: metric === "cost" ? `Cost by ${by}` : `Tokens by ${by}`,
        rows: groupRows(groups, metric, limit),
        color: options.color,
        totalWidth: rankWidth,
        labelWidth: 18,
        subvalueWidth: 9,
        formatter: metricFormatter(metric),
      }),
      renderComparisonTable({
        title: `${breakdownTitle(by)} ledger`,
        headers: [by, "cost", "tokens", "calls", "sessions", "share", "$/call"],
        rows: topGroups(groups, { ...options, limit, sort }).map((group) => [
          truncateVisible(group.label, 22),
          money(group.cost),
          formatNumber(group.tokens.total),
          formatNumber(group.assistantCalls),
          String(group.sessions),
          percent(metric === "cost" ? group.cost : group.tokens.total, metric === "cost" ? report.total.cost : report.total.tokens.total),
          money(safeDivide(group.cost, group.assistantCalls)),
        ]),
        color: options.color,
      }),
      ledgerGap,
      contentWidth,
      rankWidth / Math.max(1, contentWidth - ledgerGap),
    ),
    "",
    // Token composition for this dimension
    ...renderPercentStack({
      title: `Token composition across all ${by}s`,
      rows: tokenPartRows(report),
      color: options.color,
      width: Math.min(fullChartWidth(), statsContentWidth() - 4),
    }),
  ]

  if (by === "source") {
    lines.push("", ...renderInputComponentTable(by, groups, options, limit))
  }

  if (by === "provider") {
    const matrix = modelProviderMatrix(report)
    lines.push(
      "",
      ...renderMatrix({
        title: "Provider × model token matrix",
        xLabels: matrix.models.map((model) => model.label),
        yLabels: matrix.providers.map((provider) => provider.label),
        values: matrix.values,
        color: options.color,
      }),
    )
  }

  return panel(lines, enabled)
}

export function renderModels(report: StatsReport, options: StatsRenderOptions = {}) {
  return renderBreakdown(report, { ...options, by: "model" })
}

export function renderProviders(report: StatsReport, options: StatsRenderOptions = {}) {
  return renderBreakdown(report, { ...options, by: "provider", metric: options.metric ?? "cost" })
}


export function renderTimeline(report: StatsReport, options: StatsRenderOptions = {}) {
  const enabled = useColor(options.color)
  const metric = options.metric ?? "tokens"
  const mainSeries = metric === "cost"
    ? [dailySeries(dailyCostPoints(report), "pink", "cost")]
    : tokenComponentLineSeries(report)

  // Top 5 active days by the chosen metric
  const sortedDays = [...report.daily]
    .filter((d) => (metric === "cost" ? d.cost : d.tokens.total) > 0)
    .sort((a, b) => (metric === "cost" ? b.cost - a.cost : b.tokens.total - a.tokens.total))
    .slice(0, 5)

  return panel(
    [
      ...renderRichHeader(report, options, "timeline"),
      ...renderRoundedLineChart({
        title: metric === "cost" ? "Cost per day" : "Token components per day",
        series: mainSeries,
        color: options.color,
        metric,
        width: fullChartWidth(),
        height: 12,
      }),
      "",
      ...renderTwoColumn(
        activityRows("Model activity rows", report.modelSeries, metric, 6, enabled),
        activityRows("Provider trend rows", report.providerSeries, metric, 6, enabled),
        5,
      ),
      "",
      ...renderStackedAreaChart({
        title: "Token component stack by day",
        layers: layersFromTokenParts(report.tokenPartSeries),
        labels: dailyLabels(report.daily),
        color: options.color,
        width: fullChartWidth(),
        height: 10,
      }),
      "",
      ...renderStackedAreaChart({
        title: "Request outcomes by day",
        layers: requestOutcomeLayers(report),
        labels: dailyLabels(report.daily),
        color: options.color,
        width: fullChartWidth(),
        height: 7,
        formatter: formatNumber,
      }),
      ...(options.heatmap === false
        ? []
        : [
          "",
          ...renderHeatmap({
            title: metric === "cost" ? "Cost heatmap · calendar view" : "Token heatmap · calendar view",
            points: metric === "cost" ? dailyCostPoints(report) : dailyTokenPoints(report),
            color: options.color,
            width: Math.min(Math.floor(statsContentWidth() * 0.7), statsContentWidth()),
            formatter: metricFormatter(metric),
          }),
        ]),
      "",
      ...renderTwoColumn(
        renderComparisonTable({
          title: "Timeline ledger",
          headers: ["metric", "value"],
          rows: [
            ["period", `${report.days} days`],
            ["daily avg cost", money(safeDivide(report.total.cost, report.days))],
            ["daily avg tokens", formatNumber(safeDivide(report.total.tokens.total, report.days))],
            ["peak day cost", money(Math.max(0, ...report.daily.map((d) => d.cost)))],
            ["peak day tokens", formatNumber(Math.max(0, ...report.daily.map((d) => d.tokens.total)))],
            ["requests", formatNumber(report.total.requests)],
            ["errors", formatNumber(report.total.errors)],
            ["aborted", formatNumber(report.total.aborted)],
            ["error rate", percent(report.total.errors + report.total.aborted, report.total.requests)],
            ["avg duration", avgDuration(report.total.durationMs, report.total.requests)],
            ["cache read share", percent(report.total.tokens.cache.read, report.total.tokens.total)],
          ],
          color: options.color,
        }),
        renderComparisonTable({
          title: `Top ${sortedDays.length} active days`,
          headers: ["date", metric === "cost" ? "cost" : "tokens", "req", "cache%"],
          rows: sortedDays.map((d) => [
            d.label,
            metric === "cost" ? money(d.cost) : formatNumber(d.tokens.total),
            formatNumber(d.requests),
            percent(d.tokens.cache.read, d.tokens.total),
          ]),
          color: options.color,
        }),
        5,
      ),
      "",
      muted(`Use --metric cost to switch to cost trend. Active days: ${report.daily.filter((d) => d.tokens.total > 0).length} of ${report.days}.`, enabled),
    ],
    enabled,
  )
}

export function renderSessions(report: StatsReport, options: StatsRenderOptions = {}) {
  const enabled = useColor(options.color)
  const sort = options.sort ?? "tokens"
  const sessions = [...report.sessions]
    .sort((a, b) => {
      if (sort === "tokens") return b.tokens.total - a.tokens.total
      if (sort === "updated") return b.updated - a.updated
      if (sort === "calls") return b.assistantCalls - a.assistantCalls
      return b.cost - a.cost || b.tokens.total - a.tokens.total
    })
    .slice(0, options.limit ?? 20)
  const maxCost = Math.max(0, ...sessions.map((session) => session.cost))
  const maxTokens = Math.max(0, ...sessions.map((session) => session.tokens.total))
  const maxCalls = Math.max(0, ...sessions.map((session) => session.assistantCalls))

  // Per-session stats
  const sessionCosts = report.sessions.map((s) => s.cost)
  const sessionTokens = report.sessions.map((s) => s.tokens.total)
  const p50Cost = sessionCosts.slice().sort((a, b) => a - b)[Math.floor(sessionCosts.length / 2)] ?? 0
  const p95Cost = sessionCosts.slice().sort((a, b) => a - b)[Math.floor(sessionCosts.length * 0.95)] ?? 0
  const p50Tokens = sessionTokens.slice().sort((a, b) => a - b)[Math.floor(sessionTokens.length / 2)] ?? 0

  const lines = [
    ...renderRichHeader(report, options, "sessions"),
    ...renderTwoColumn(
      renderHistogram({
        title: "Session cost distribution",
        values: sessionCostValues(report),
        color: options.color,
        width: Math.max(12, halfChartWidth() - 18),
        formatter: metricFormatter("cost"),
      }),
      renderHistogram({
        title: "Session token distribution",
        values: sessionTokenValues(report),
        color: options.color,
        width: Math.max(12, halfChartWidth() - 18),
        formatter: formatNumber,
      }),
      5,
    ),
    "",
    ...renderTwoColumn(
      renderComparisonTable({
        title: "Session statistics",
        headers: ["metric", "value"],
        rows: [
          ["sessions with usage", String(report.sessionsWithUsage)],
          ["total sessions", String(report.totalSessions)],
          ["p50 cost", money(p50Cost)],
          ["p95 cost", money(p95Cost)],
          ["max cost", money(maxCost)],
          ["p50 tokens", formatNumber(p50Tokens)],
          ["max tokens", formatNumber(maxTokens)],
          ["avg req / session", (safeDivide(report.total.requests, report.sessionsWithUsage)).toFixed(1)],
          ["avg calls / session", (safeDivide(report.total.assistantCalls, report.sessionsWithUsage)).toFixed(1)],
          ["avg duration", avgDuration(report.total.durationMs, report.total.requests)],
        ],
        color: options.color,
      }),
      renderComparisonTable({
        title: "Top tools",
        headers: ["tool", "calls", "share"],
        rows: report.toolUsage.slice(0, 8).map((tool) => [
          truncateVisible(tool.id, 20),
          formatNumber(tool.count),
          percent(tool.count, report.totalTools),
        ]),
        color: options.color,
      }),
      5,
    ),
    "",
    title(`Session leaderboard · sorted by ${sort}`, enabled),
    ...sessions.flatMap((session, index) => {
      const cacheRatio = percent(session.tokens.cache.read, session.tokens.total)
      const bar = metricBar(
        sort === "cost" ? session.cost : sort === "calls" ? session.assistantCalls : session.tokens.total,
        sort === "cost" ? maxCost : sort === "calls" ? maxCalls : maxTokens,
        36,
        enabled,
        sort === "cost" ? "pink" : sort === "calls" ? "green" : "blue",
      )
      return [
        `${padStartVisible(String(index + 1), 2)} ${fitVisible(color(session.title || session.id, "white", enabled, true), 46)} ${padStartVisible(money(session.cost), 9)} ${padStartVisible(formatNumber(session.tokens.total), 8)} tok`,
        `   ${bar} ${muted(`${session.models.slice(0, 2).join(", ") || "?"} · ${formatNumber(session.requests)} req · ${formatNumber(session.assistantCalls)} calls · ${avgDuration(session.durationMs, session.requests)} avg · cache ${cacheRatio}`, enabled)}`,
      ]
    }),
    "",
    muted("Run opencode session info -s <ID> for per-session model/provider token breakdown.", enabled),
  ]
  if (sessions.length === 0) lines.push(muted("No session usage data for this range.", enabled))
  return panel(lines, enabled)
}
