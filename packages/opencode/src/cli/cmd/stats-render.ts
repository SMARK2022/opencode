import type { DailyUsage, StatsReport, TokenTotals, UsageGroup } from "./stats-data"
import { Locale } from "@/util/locale"
import { formatNumber } from "../format"
import {
  dailySeries,
  fitVisible,
  layersFromTokenParts,
  metricFormatter,
  renderCallout,
  renderComparisonTable,
  renderCompositionDonut,
  renderGauge,
  renderHeatmap,
  renderHistogram,
  renderHorizon,
  renderMatrix,
  renderMetricRibbon,
  renderPercentStack,
  renderRankBars,
  renderRoundedLineChart,
  renderSlopeChart,
  renderSmallMultiples,
  renderStackedAreaChart,
  renderStreamStackChart,
  renderTabs,
  renderTwoColumn,
  renderWaterfall,
  seriesFromUsage,
  statsContentWidth,
  type ChartColor,
} from "./stats-charts"

export { formatNumber } from "../format"

const RESET = "\x1b[0m"
const BOLD = "\x1b[1m"
const TEXT_RESET = "\x1b[22m\x1b[39m"
const ANSI_RE = /\x1b\[[0-9;]*m/g

const fg = (r: number, g: number, b: number) => `\x1b[38;2;${r};${g};${b}m`
const bg = (r: number, g: number, b: number) => `\x1b[48;2;${r};${g};${b}m`

const theme = {
  bg: bg(25, 8, 28),
  title: fg(224, 222, 226),
  subtitle: fg(150, 132, 155),
  muted: fg(122, 106, 130),
  border: fg(86, 55, 88),
  sep: fg(96, 80, 98),
  blue: fg(78, 199, 224),
  green: fg(82, 205, 126),
  yellow: fg(224, 186, 76),
  purple: fg(190, 120, 225),
  pink: fg(230, 120, 175),
  white: fg(226, 226, 226),
  danger: fg(235, 116, 116),
}

export type ColorMode = "auto" | "always" | "never"
export type StatsRenderOptions = {
  color?: ColorMode
  limit?: number
  metric?: "tokens" | "cost"
  sort?: "cost" | "tokens" | "calls" | "updated"
}

export const useColor = (mode: ColorMode = "auto") => {
  if (mode === "always") return true
  if (mode === "never") return false
  if (process.env.NO_COLOR) return false
  return Boolean(process.stdout.isTTY)
}

const visibleLength = (text: string) => text.replace(ANSI_RE, "").length

const padEndAnsi = (text: string, width: number) => text + " ".repeat(Math.max(0, width - visibleLength(text)))
const padStartAnsi = (text: string, width: number) => " ".repeat(Math.max(0, width - visibleLength(text))) + text

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

const money = (value: number) => {
  if (!Number.isFinite(value)) return "$0.00"
  if (value >= 100) return `$${value.toFixed(0)}`
  if (value >= 10) return `$${value.toFixed(1)}`
  return `$${value.toFixed(4)}`
}

const percent = (value: number, total: number) => {
  if (!total) return "0.0%"
  return `${((value / total) * 100).toFixed(1)}%`
}

const tokenParts = (tokens: TokenTotals) => [
  { label: "In", value: tokens.input, color: "blue" as const },
  { label: "Out", value: tokens.output + tokens.reasoning, color: "green" as const },
  { label: "Cache Read", value: tokens.cache.read, color: "yellow" as const },
  { label: "Cache Write", value: tokens.cache.write, color: "purple" as const },
]

const segmentWidths = (values: number[], width: number) => {
  const total = values.reduce((acc, value) => acc + value, 0)
  if (total <= 0) return values.map(() => 0)
  const raw = values.map((value) => (value / total) * width)
  const sizes = raw.map((value, index) => (values[index] > 0 ? Math.max(1, Math.floor(value)) : 0))
  while (sizes.reduce((acc, value) => acc + value, 0) > width) {
    const index = sizes.reduce((best, value, current) => (value > sizes[best] ? current : best), 0)
    sizes[index]--
  }
  while (sizes.reduce((acc, value) => acc + value, 0) < width) {
    const index = raw.reduce((best, value, current) => (value - sizes[current] > raw[best] - sizes[best] ? current : best), 0)
    sizes[index]++
  }
  return sizes
}

const tokenStack = (tokens: TokenTotals, width: number, enabled: boolean) => {
  const parts = tokenParts(tokens)
  if (parts.every((part) => part.value <= 0)) return " ".repeat(width)
  const sizes = segmentWidths(
    parts.map((part) => part.value),
    width,
  )
  return parts
    .map((part, index) => color("█".repeat(sizes[index]), part.color, enabled))
    .join("")
    .padEnd(width)
}

const metricBar = (value: number, max: number, width: number, enabled: boolean, name: keyof typeof theme) => {
  const filled = max <= 0 ? 0 : Math.round((value / max) * width)
  return color("█".repeat(filled), name, enabled) + color("░".repeat(Math.max(0, width - filled)), "border", enabled)
}

const sparkline = (values: number[], enabled: boolean) => {
  const chars = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"]
  const max = Math.max(0, ...values)
  if (max === 0) return color(chars[0].repeat(values.length), "muted", enabled)
  return values
    .map((value) => color(chars[Math.min(chars.length - 1, Math.floor((value / max) * (chars.length - 1)))], "pink", enabled))
    .join("")
}

const title = (text: string, enabled: boolean) => color(text, "title", enabled, true)
const muted = (text: string, enabled: boolean) => color(text, "muted", enabled)
const sep = (enabled: boolean) => color(" · ", "sep", enabled)

const fullChartWidth = () => Math.max(38, statsContentWidth() - 8)
const halfChartWidth = () => Math.max(22, Math.floor((statsContentWidth() - 5) / 2) - 8)
const compactBarWidth = () => Math.max(10, Math.floor(statsContentWidth() / 5))

const hero = (label: string, value: string, enabled: boolean, accent: keyof typeof theme) =>
  `${color("●", accent, enabled)} ${color(label, "subtitle", enabled)} ${color(value, "white", enabled, true)}`

const legend = (enabled: boolean) =>
  [
    `${color("●", "blue", enabled)} Input`,
    `${color("●", "green", enabled)} Output + Reasoning`,
    `${color("●", "yellow", enabled)} Cache Read`,
    `${color("●", "purple", enabled)} Cache Write`,
  ].join(sep(enabled))

const dailyLabels = (daily: DailyUsage[]) => daily.map((item) => item.label)

const dailyTokenPoints = (report: StatsReport) =>
  report.daily.map((item) => ({ day: item.day, label: item.label, value: item.tokens.total }))

const dailyCostPoints = (report: StatsReport) =>
  report.daily.map((item) => ({ day: item.day, label: item.label, value: item.cost }))

const groupRows = (groups: UsageGroup[], metric: "tokens" | "cost", limit: number) =>
  groups.slice(0, limit).map((group, index) => ({
    label: group.label,
    value: metric === "cost" ? group.cost : group.tokens.total,
    subvalue: `${formatNumber(group.assistantCalls)} calls · ${formatNumber(group.sessions)} sessions`,
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
  const values = providers.map((provider) =>
    models.map((model) => {
      const providerHit = model.providers.find((item) => item.id === provider.id)?.tokens ?? 0
      const modelHit = provider.models.find((item) => item.id === model.id)?.tokens ?? 0
      return Math.min(providerHit, modelHit)
    }),
  )
  return { models, providers, values }
}

const costWaterfallRows = (report: StatsReport) => [
  ...report.providers.slice(0, 6).map((provider, index) => ({
    label: provider.label,
    value: provider.cost,
    color: ["pink", "purple", "blue", "green", "yellow", "orange"][index % 6] as ChartColor,
  })),
  { label: "Unshown", value: report.providers.slice(6).reduce((acc, provider) => acc + provider.cost, 0), color: "muted" as ChartColor },
]

const sessionCostValues = (report: StatsReport) => report.sessions.map((session) => session.cost)

const sessionTokenValues = (report: StatsReport) => report.sessions.map((session) => session.tokens.total)

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
        { label: "Tools", value: formatNumber(report.totalTools), color: "yellow" },
      ],
    }),
    renderTabs({
      color: options.color,
      tabs: ["dashboard", "timeline", "models", "providers", "sessions", "insights"].map((label) => ({
        label,
        active: label === active,
      })),
    }),
    renderTabs({
      color: options.color,
      tabs: ["charts", "heatmap", "costs", "tokens", "forecast"].map((label) => ({
        label,
        active: label === active,
      })),
    }),
  ]
}

const topGroups = (groups: UsageGroup[], options: StatsRenderOptions) => {
  const sort = options.sort ?? "cost"
  const sorted = [...groups].sort((a, b) => {
    if (sort === "tokens") return b.tokens.total - a.tokens.total
    if (sort === "calls") return b.assistantCalls - a.assistantCalls
    return b.cost - a.cost || b.tokens.total - a.tokens.total
  })
  return sorted.slice(0, options.limit ?? 8)
}

const renderGroupRows = (groups: UsageGroup[], report: StatsReport, options: StatsRenderOptions, enabled: boolean) => {
  const rows: string[] = []
  const items = topGroups(groups, options)
  const maxCost = Math.max(0, ...items.map((item) => item.cost))
  const maxTokens = Math.max(0, ...items.map((item) => item.tokens.total))
  items.forEach((item, index) => {
    const share = percent(item.tokens.total, report.total.tokens.total)
    const heading = `${padStartAnsi(String(index + 1), 2)} ${color("●", index % 2 === 0 ? "blue" : "green", enabled)} ${padEndAnsi(color(item.label, "white", enabled, true), 34)} ${padStartAnsi(money(item.cost), 10)} ${padStartAnsi(formatNumber(item.tokens.total), 9)} tok ${padStartAnsi(String(item.assistantCalls), 5)} calls ${padStartAnsi(share, 7)}`
    rows.push(heading)
    rows.push(
      `   ${tokenStack(item.tokens, 42, enabled)}  ${muted(
        `In ${formatNumber(item.tokens.input)} / Out ${formatNumber(item.tokens.output + item.tokens.reasoning)} / Cache ${formatNumber(item.tokens.cache.read + item.tokens.cache.write)}`,
        enabled,
      )}`,
    )
    rows.push(
      `   ${metricBar(options.metric === "tokens" ? item.tokens.total : item.cost, options.metric === "tokens" ? maxTokens : maxCost, 42, enabled, options.metric === "tokens" ? "blue" : "pink")}  ${muted(`${item.sessions} sessions`, enabled)}`,
    )
  })
  if (rows.length === 0) rows.push(muted("No usage data for this range.", enabled))
  return rows
}

export function renderDashboard(report: StatsReport, options: StatsRenderOptions = {}) {
  const enabled = useColor(options.color)
  const lines = [
    ...renderRichHeader(report, options, "dashboard"),
    "",
    ...renderRoundedLineChart({
      title: "Tokens per day",
      series: [dailySeries(dailyTokenPoints(report), "blue", "tokens")],
      color: options.color,
      metric: "tokens",
      width: fullChartWidth(),
      height: 12,
    }),
    "",
    ...renderTwoColumn(
      renderComparisonTable({
        title: "Top models",
        headers: ["model", "tokens", "share"],
        rows: topGroups(report.models, { ...options, limit: options.limit ?? 5, sort: "tokens" }).map((model) => [
          Locale.truncate(model.label, 22),
          formatNumber(model.tokens.total),
          percent(model.tokens.total, report.total.tokens.total),
        ]),
        color: options.color,
      }),
      renderComparisonTable({
        title: "Top providers",
        headers: ["provider", "cost", "share"],
        rows: topGroups(report.providers, { ...options, limit: options.limit ?? 5, sort: "cost" }).map((provider) => [
          Locale.truncate(provider.label, 22),
          money(provider.cost),
          percent(provider.cost, report.total.cost),
        ]),
        color: options.color,
      }),
      5,
    ),
    "",
    ...renderTwoColumn(
      renderPercentStack({ title: "Token composition", rows: tokenPartRows(report), color: options.color, width: halfChartWidth() }),
      renderComparisonTable({
        title: "Snapshot",
        headers: ["metric", "value"],
        rows: [
          ["cost / day", money(report.total.cost / Math.max(report.days, 1))],
          ["tokens / session", formatNumber(report.tokensPerSession)],
          ["median session", formatNumber(report.medianTokensPerSession)],
          ["requests", formatNumber(report.total.requests)],
          ["assistant calls", formatNumber(report.total.assistantCalls)],
        ],
        color: options.color,
      }),
      5,
    ),
    "",
    ...renderCallout({
      title: "Focused views",
      body: "Use stats timeline, models, providers, sessions, costs, tokens, insights, or forecast for deeper drilldowns.",
      color: options.color,
      accent: "purple",
    }),
  ]
  return panel(lines, enabled)
}

export function renderOverview(report: StatsReport, options: StatsRenderOptions = {}) {
  const enabled = useColor(options.color)
  const lines = [
    title("opencode stats overview", enabled),
    muted(dateRange(report), enabled),
    "",
    hero("Sessions", `${formatNumber(report.sessionsWithUsage)} with usage / ${formatNumber(report.totalSessions)} total`, enabled, "blue"),
    hero("Messages", formatNumber(report.totalMessages), enabled, "green"),
    hero("Assistant calls", formatNumber(report.total.assistantCalls), enabled, "yellow"),
    hero("Total cost", money(report.total.cost), enabled, "pink"),
    hero("Avg tokens/session", formatNumber(report.tokensPerSession), enabled, "purple"),
    hero("Median tokens/session", formatNumber(report.medianTokensPerSession), enabled, "white"),
    "",
    `${color("Token stack", "subtitle", enabled, true)} ${tokenStack(report.total.tokens, 62, enabled)}`,
    `            ${legend(enabled)}`,
    "",
    title("Tool usage", enabled),
    ...(report.toolUsage.slice(0, options.limit ?? 10).map((tool, index) =>
      `${padStartAnsi(String(index + 1), 2)} ${padEndAnsi(color(tool.id, "white", enabled, true), 28)} ${metricBar(tool.count, report.toolUsage[0]?.count ?? 0, 30, enabled, "yellow")} ${formatNumber(tool.count)}`,
    )),
  ]
  if (report.toolUsage.length === 0) lines.push(muted("No tool usage data for this range.", enabled))
  return panel(lines, enabled)
}

export function renderModels(report: StatsReport, options: StatsRenderOptions = {}) {
  const enabled = useColor(options.color)
  const lines = [
    ...renderRichHeader(report, options, "models"),
    "",
    ...renderRoundedLineChart({
      title: "Model usage over time",
      series: seriesFromUsage(report.modelSeries, options.metric ?? "tokens", options.limit ?? 8),
      color: options.color,
      metric: options.metric ?? "tokens",
      width: fullChartWidth(),
      height: 12,
    }),
    "",
    muted(" # model                                cost      tokens calls   share", enabled),
    ...renderGroupRows(report.models, report, { limit: options.limit ?? 12, metric: options.metric ?? "tokens", sort: options.sort }, enabled),
  ]
  return panel(
    lines,
    enabled,
  )
}

export function renderProviders(report: StatsReport, options: StatsRenderOptions = {}) {
  const enabled = useColor(options.color)
  const matrix = modelProviderMatrix(report)
  return panel(
    [
      ...renderRichHeader(report, options, "providers"),
      "",
      ...renderRoundedLineChart({
        title: "Provider spend over time",
        series: seriesFromUsage(report.providerSeries, options.metric ?? "cost", options.limit ?? 8),
        color: options.color,
        metric: options.metric ?? "cost",
        width: fullChartWidth(),
        height: 12,
      }),
      "",
      ...renderMatrix({
        title: "Provider × model token matrix",
        xLabels: matrix.models.map((model) => model.label),
        yLabels: matrix.providers.map((provider) => provider.label),
        values: matrix.values,
        color: options.color,
      }),
      "",
      muted(" # provider                             cost      tokens calls   share", enabled),
      ...renderGroupRows(report.providers, report, { limit: options.limit ?? 12, metric: options.metric ?? "cost", sort: options.sort }, enabled),
    ],
    enabled,
  )
}

export function renderTimeline(report: StatsReport, options: StatsRenderOptions = {}) {
  const enabled = useColor(options.color)
  const metric = options.metric ?? "tokens"
  const mainSeries = dailySeries(metric === "cost" ? dailyCostPoints(report) : dailyTokenPoints(report), metric === "cost" ? "pink" : "blue", metric)
  return panel(
    [
      ...renderRichHeader(report, options, "timeline"),
      "",
      ...renderRoundedLineChart({
        title: `${metric === "cost" ? "Cost" : "Tokens"} per day`,
        series: [mainSeries],
        color: options.color,
        metric,
        width: fullChartWidth(),
        height: 12,
      }),
      "",
      ...renderStackedAreaChart({
        title: "Token component stack by day",
        layers: layersFromTokenParts(report.tokenPartSeries),
        labels: dailyLabels(report.daily),
        color: options.color,
        width: fullChartWidth(),
        height: 12,
      }),
      "",
      ...renderHeatmap({
        title: metric === "cost" ? "Cost heatmap" : "Token heatmap",
        points: metric === "cost" ? dailyCostPoints(report) : dailyTokenPoints(report),
        color: options.color,
        width: Math.min(54, statsContentWidth()),
        formatter: metricFormatter(metric),
      }),
      "",
      legend(enabled),
    ],
    enabled,
  )
}

export function renderSessions(report: StatsReport, options: StatsRenderOptions = {}) {
  const enabled = useColor(options.color)
  const sort = options.sort ?? "cost"
  const sessions = [...report.sessions]
    .sort((a, b) => {
      if (sort === "tokens") return b.tokens.total - a.tokens.total
      if (sort === "updated") return b.updated - a.updated
      if (sort === "calls") return b.assistantCalls - a.assistantCalls
      return b.cost - a.cost || b.tokens.total - a.tokens.total
    })
    .slice(0, options.limit ?? 20)
  const maxCost = Math.max(0, ...sessions.map((session) => session.cost))
  const lines = [
    ...renderRichHeader(report, options, "sessions"),
    "",
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
    title(`Session leaderboard · sorted by ${sort}`, enabled),
    ...sessions.flatMap((session, index) => [
      `${padStartAnsi(String(index + 1), 2)} ${padEndAnsi(color(session.id, "blue", enabled, true), 24)} ${padEndAnsi(Locale.truncate(session.title, 34), 36)} ${padStartAnsi(money(session.cost), 10)} ${padStartAnsi(formatNumber(session.tokens.total), 9)} tok`,
      `   ${metricBar(session.cost, maxCost, 42, enabled, "pink")} ${muted(`${session.models.slice(0, 3).join(", ") || "unknown model"}`, enabled)}`,
    ]),
  ]
  if (sessions.length === 0) lines.push(muted("No session usage data for this range.", enabled))
  return panel(lines, enabled)
}

export function renderCharts(report: StatsReport, options: StatsRenderOptions = {}) {
  const enabled = useColor(options.color)
  const metric = options.metric ?? "tokens"
  const modelLines = seriesFromUsage(report.modelSeries, metric, options.limit ?? 6)
  const providerLines = seriesFromUsage(report.providerSeries, metric, options.limit ?? 6)
  const lines = [
    ...renderRichHeader(report, options, "charts"),
    "",
    ...renderTwoColumn(
      renderRoundedLineChart({
        title: "Model usage",
        series: modelLines,
        color: options.color,
        metric,
        width: halfChartWidth(),
        height: 10,
      }),
      renderRoundedLineChart({
        title: "Provider usage",
        series: providerLines,
        color: options.color,
        metric,
        width: halfChartWidth(),
        height: 10,
      }),
      5,
    ),
    "",
    ...renderTwoColumn(
      renderStackedAreaChart({
        title: "Token components",
        layers: layersFromTokenParts(report.tokenPartSeries),
        labels: dailyLabels(report.daily),
        color: options.color,
        width: halfChartWidth(),
        height: 10,
      }),
      renderStreamStackChart({
        title: "Model mix over time",
        layers: report.modelSeries.slice(0, options.limit ?? 6).map((series, index) => ({
          id: series.id,
          label: series.label,
          color: ["blue", "green", "yellow", "purple", "pink", "cyan"][index % 6] as ChartColor,
          values: series.points.map((point) => (metric === "cost" ? point.cost : point.tokens.total)),
          total: metric === "cost" ? series.cost : series.tokens.total,
        })),
        labels: dailyLabels(report.daily),
        color: options.color,
        width: halfChartWidth(),
        height: 10,
      }),
      5,
    ),
    "",
    ...renderTwoColumn(
      renderHorizon({ title: "Model activity rows", series: modelLines, color: options.color, width: Math.max(10, halfChartWidth() - 26), formatter: metricFormatter(metric) }),
      renderSmallMultiples({ title: "Provider trend rows", series: providerLines, color: options.color, width: Math.max(10, halfChartWidth() - 26), formatter: metricFormatter(metric) }),
      5,
    ),
  ]
  return panel(lines, enabled)
}

export function renderHeatmapPage(report: StatsReport, options: StatsRenderOptions = {}) {
  const enabled = useColor(options.color)
  const matrix = modelProviderMatrix(report)
  const lines = [
    ...renderRichHeader(report, options, "heatmap"),
    "",
    ...renderTwoColumn(
      renderHeatmap({ title: "Daily tokens", points: dailyTokenPoints(report), color: options.color, width: Math.max(22, Math.floor((statsContentWidth() - 8) / 2)), formatter: formatNumber }),
      renderHeatmap({ title: "Daily cost", points: dailyCostPoints(report), color: options.color, width: Math.max(22, Math.floor((statsContentWidth() - 8) / 2)), formatter: metricFormatter("cost") }),
      8,
    ),
    "",
    ...renderMatrix({
      title: "Provider × model token density",
      xLabels: matrix.models.map((model) => model.label),
      yLabels: matrix.providers.map((provider) => provider.label),
      values: matrix.values,
      color: options.color,
    }),
  ]
  return panel(lines, enabled)
}

export function renderCosts(report: StatsReport, options: StatsRenderOptions = {}) {
  const enabled = useColor(options.color)
  const lines = [
    ...renderRichHeader(report, options, "costs"),
    "",
    ...renderTwoColumn(
      renderRoundedLineChart({
        title: "Daily cost",
        series: [dailySeries(dailyCostPoints(report), "pink", "daily cost")],
        color: options.color,
        metric: "cost",
        width: halfChartWidth(),
        height: 10,
      }),
      renderWaterfall({
        title: "Provider cost waterfall",
        rows: costWaterfallRows(report),
        color: options.color,
        width: Math.max(12, halfChartWidth() - 24),
        formatter: metricFormatter("cost"),
      }),
      5,
    ),
    "",
    ...renderTwoColumn(
      renderHistogram({ title: "Session cost distribution", values: sessionCostValues(report), color: options.color, width: Math.max(12, halfChartWidth() - 18), formatter: metricFormatter("cost") }),
      renderRankBars({ title: "Cost by model", rows: groupRows(report.models, "cost", options.limit ?? 10), color: options.color, width: Math.max(8, halfChartWidth() - 42), formatter: metricFormatter("cost") }),
      5,
    ),
  ]
  return panel(lines, enabled)
}

export function renderTokens(report: StatsReport, options: StatsRenderOptions = {}) {
  const enabled = useColor(options.color)
  const lines = [
    ...renderRichHeader(report, options, "tokens"),
    "",
    ...renderStackedAreaChart({
      title: "Input / output / cache over time",
      layers: layersFromTokenParts(report.tokenPartSeries),
      labels: dailyLabels(report.daily),
      color: options.color,
      width: fullChartWidth(),
      height: 12,
    }),
    "",
    ...renderTwoColumn(
      renderPercentStack({ title: "Token share", rows: tokenPartRows(report), color: options.color, width: Math.max(16, halfChartWidth() - 12) }),
      renderCompositionDonut({
        title: "Top model token share",
        rows: report.models.slice(0, options.limit ?? 8).map((model, index) => ({
          label: model.label,
          value: model.tokens.total,
          color: ["blue", "green", "yellow", "purple", "pink", "cyan", "orange", "red"][index % 8] as ChartColor,
        })),
        color: options.color,
        formatter: formatNumber,
      }),
      5,
    ),
    "",
    ...renderComparisonTable({
      title: "Token ledger",
      headers: ["kind", "tokens", "share"],
      rows: [
        ["input", formatNumber(report.total.tokens.input), percent(report.total.tokens.input, report.total.tokens.total)],
        ["output", formatNumber(report.total.tokens.output + report.total.tokens.reasoning), percent(report.total.tokens.output + report.total.tokens.reasoning, report.total.tokens.total)],
        ["cache read", formatNumber(report.total.tokens.cache.read), percent(report.total.tokens.cache.read, report.total.tokens.total)],
        ["cache write", formatNumber(report.total.tokens.cache.write), percent(report.total.tokens.cache.write, report.total.tokens.total)],
      ],
      color: options.color,
    }),
    "",
    renderGauge({ label: "Cache share", value: report.total.tokens.cache.read + report.total.tokens.cache.write, max: report.total.tokens.total, color: options.color, width: Math.max(18, statsContentWidth() - 28) }),
  ]
  return panel(lines, enabled)
}
