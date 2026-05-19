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
  renderTwoColumn,
  seriesFromUsage,
  padEndVisible,
  padStartVisible,
  statsContentWidth,
  truncateVisible,
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
  bg: bg(25, 8, 28),
  title: fg(224, 222, 226),
  subtitle: fg(150, 132, 155),
  muted: fg(122, 106, 130),
  border: fg(86, 55, 88),
  sep: fg(96, 80, 98),
  blue: fg(78, 199, 224),
  cyan: fg(76, 215, 220),
  green: fg(82, 205, 126),
  yellow: fg(224, 186, 76),
  orange: fg(232, 145, 76),
  purple: fg(190, 120, 225),
  pink: fg(230, 120, 175),
  red: fg(238, 106, 114),
  white: fg(226, 226, 226),
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

const metricBar = (value: number, max: number, width: number, enabled: boolean, name: keyof typeof theme) => {
  const filled = max <= 0 ? 0 : Math.round((value / max) * width)
  return color("█".repeat(filled), name, enabled) + color("░".repeat(Math.max(0, width - filled)), "border", enabled)
}

const title = (text: string, enabled: boolean) => color(text, "title", enabled, true)
const muted = (text: string, enabled: boolean) => color(text, "muted", enabled)
const sep = (enabled: boolean) => color(" · ", "sep", enabled)
const activityColors = ["blue", "green", "yellow", "purple", "pink"] as const

const fullChartWidth = () => Math.max(38, statsContentWidth() - 8)
const halfChartWidth = () => Math.max(22, Math.floor((statsContentWidth() - 5) / 2) - 8)

const dailyLabels = (daily: DailyUsage[]) => daily.map((item) => item.label)

const dailyTokenPoints = (report: StatsReport) =>
  report.daily.map((item) => ({ day: item.day, label: item.label, value: item.tokens.total }))

const dailyCostPoints = (report: StatsReport) =>
  report.daily.map((item) => ({ day: item.day, label: item.label, value: item.cost }))

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

const dashboardCallout = (report: StatsReport) => {
  const topSession = [...report.sessions].sort((a, b) => b.cost - a.cost || b.tokens.total - a.tokens.total)[0]
  if (report.total.errors + report.total.aborted > 0) {
    return `${formatNumber(report.total.errors + report.total.aborted)} failed or aborted requests in this range; inspect stats insights for wasted-cost signals.`
  }
  if (topSession && topSession.cost > report.total.cost * 0.35) {
    return `${topSession.title || topSession.id} accounts for ${percent(topSession.cost, report.total.cost)} of cost; inspect it with opencode session info -s ${topSession.id}.`
  }
  return `Cache is ${cacheShare(report.total.tokens)} of tokens; use stats timeline for daily changes and stats breakdown for attribution.`
}

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

const sortGroups = (groups: UsageGroup[], sort: StatsRenderOptions["sort"] = "tokens") =>
  [...groups].sort((a, b) => {
    if (sort === "cost") return b.cost - a.cost || b.tokens.total - a.tokens.total
    if (sort === "calls") return b.assistantCalls - a.assistantCalls || b.tokens.total - a.tokens.total
    return b.tokens.total - a.tokens.total || b.cost - a.cost
  })

const topGroups = (groups: UsageGroup[], options: StatsRenderOptions) =>
  sortGroups(groups, options.sort ?? "tokens").slice(0, options.limit ?? 8)

export function renderStatsHeader(report: StatsReport, options: StatsRenderOptions, active: string) {
  return renderRichHeader(report, options, active)
}

export function renderDashboard(report: StatsReport, options: StatsRenderOptions = {}) {
  const enabled = useColor(options.color)
  const dashboardSessions = [...report.sessions]
    .sort((a, b) => b.tokens.total - a.tokens.total || b.cost - a.cost)
    .slice(0, 5)
  const maxSessionTokens = Math.max(0, ...dashboardSessions.map((session) => session.tokens.total))
  const cacheReadPct = percent(report.total.tokens.cache.read, report.total.tokens.total)
  const inputPct = percent(report.total.tokens.input, report.total.tokens.total)
  const outputPct = percent(report.total.tokens.output + report.total.tokens.reasoning, report.total.tokens.total)
  const lines = [
    ...renderRichHeader(report, options, "dashboard"),
    ...renderTwoColumn(
      renderRoundedLineChart({
        title: "Token components",
        series: tokenComponentLineSeries(report),
        color: options.color,
        metric: "tokens",
        width: halfChartWidth(),
        height: 12,
      }),
      renderRoundedLineChart({
        title: "Model mix over time",
        series: seriesFromUsage(report.modelSeries, "tokens", 5),
        color: options.color,
        metric: "tokens",
        width: halfChartWidth(),
        height: 12,
      }),
      5,
    ),
    "",
    // Two-column: top models + top providers with richer data
    ...renderTwoColumn(
      renderComparisonTable({
        title: "Top models",
        headers: ["model", "cost", "tokens", "calls", "share"],
        rows: topGroups(report.models, { ...options, limit: options.limit ?? 6, sort: "tokens" }).map((model) => [
          truncateVisible(model.label, 20),
          money(model.cost),
          formatNumber(model.tokens.total),
          formatNumber(model.assistantCalls),
          percent(model.tokens.total, report.total.tokens.total),
        ]),
        color: options.color,
      }),
      renderComparisonTable({
        title: "Top providers",
        headers: ["provider", "cost", "tokens", "calls", "share"],
        rows: topGroups(report.providers, { ...options, limit: options.limit ?? 6, sort: "tokens" }).map((provider) => [
          truncateVisible(provider.label, 18),
          money(provider.cost),
          formatNumber(provider.tokens.total),
          formatNumber(provider.assistantCalls),
          percent(provider.tokens.total, report.total.tokens.total),
        ]),
        color: options.color,
      }),
      5,
    ),
    "",
    ...renderTwoColumn(
      activityRows("Model activity rows", report.modelSeries, "tokens", 6, enabled),
      activityRows("Provider trend rows", report.providerSeries, "tokens", 6, enabled),
      5,
    ),
    "",
    // Three-column: token composition + snapshot + top session
    ...renderTwoColumn(
      [
        ...renderPercentStack({ title: "Token composition", rows: tokenPartRows(report), color: options.color, width: halfChartWidth() }),
        "",
        ...renderComparisonTable({
          title: "Token ledger",
          headers: ["kind", "tokens", "share"],
          rows: [
            ["input", formatNumber(report.total.tokens.input), inputPct],
            ["output", formatNumber(report.total.tokens.output + report.total.tokens.reasoning), outputPct],
            ["cache read", formatNumber(report.total.tokens.cache.read), cacheReadPct],
            ["cache write", formatNumber(report.total.tokens.cache.write), percent(report.total.tokens.cache.write, report.total.tokens.total)],
          ],
          color: options.color,
        }),
      ],
      renderComparisonTable({
        title: "Usage snapshot",
        headers: ["metric", "value"],
        rows: [
          ["cost total", money(report.total.cost)],
          ["cost / day", money(safeDivide(report.total.cost, report.days))],
          ["cost / request", money(safeDivide(report.total.cost, report.total.requests))],
          ["tokens total", formatNumber(report.total.tokens.total)],
          ["tokens / session", formatNumber(report.tokensPerSession)],
          ["median session", formatNumber(report.medianTokensPerSession)],
          ["cache share", cacheShare(report.total.tokens)],
          ["cache read", cacheReadPct],
          ["requests", formatNumber(report.total.requests)],
          ["assistant calls", formatNumber(report.total.assistantCalls)],
          ["sessions w/ usage", `${report.sessionsWithUsage} / ${report.totalSessions}`],
          ["avg duration", avgDuration(report.total.durationMs, report.total.requests)],
          ["failed / aborted", formatNumber(report.total.errors + report.total.aborted)],
          ["tools used", formatNumber(report.totalTools)],
          ["top tool", report.toolUsage[0] ? `${report.toolUsage[0].id} (${formatNumber(report.toolUsage[0].count)})` : "—"],
        ],
        color: options.color,
      }),
      5,
    ),
    "",
    // Top sessions inline
    title("Top sessions by tokens", enabled),
    ...dashboardSessions.flatMap((session, index) => {
      const bar = metricBar(session.tokens.total, maxSessionTokens, 36, enabled, "blue")
      return [
        `${padStartVisible(String(index + 1), 2)} ${fitVisible(color(session.title || session.id, "white", enabled, true), 42)} ${padStartVisible(money(session.cost), 9)} ${padStartVisible(formatNumber(session.tokens.total), 8)} tok`,
        `   ${bar} ${muted(`${session.models.slice(0, 2).join(", ")} · ${formatNumber(session.requests)} req · ${avgDuration(session.durationMs, session.requests)} avg`, enabled)}`,
      ]
    }),
    "",
    ...renderCallout({
      title: "Next question",
      body: dashboardCallout(report),
      color: options.color,
      accent: "purple",
    }),
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
