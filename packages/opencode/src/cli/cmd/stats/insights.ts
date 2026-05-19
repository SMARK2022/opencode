import type { DailyUsage, SessionUsage, StatsReport, UsageGroup } from "./data"
import type { ColorMode, StatsRenderOptions } from "./render"
import { formatNumber } from "../../format"
import {
  metricFormatter,
  renderCallout,
  renderComparisonTable,
  renderHistogram,
  renderRankBars,
  renderRoundedLineChart,
  renderSlopeChart,
  renderTwoColumn,
  dailySeries,
  renderPanel,
  renderContext,
  statsContentWidth,
  paint,
  padEndVisible,
  padStartVisible,
  type ChartColor,
} from "./charts"
import { renderStatsHeader } from "./render"

export type InsightSeverity = "info" | "good" | "warn" | "risk"

export type InsightCard = {
  id: string
  title: string
  body: string
  severity: InsightSeverity
  value?: string
  detail?: string
}

export type ForecastPoint = {
  label: string
  value: number
  lower: number
  upper: number
}

export type ForecastReport = {
  dailyAverage: number
  weeklyRunRate: number
  monthlyRunRate: number
  projectedMonthEnd: number
  confidence: number
  points: ForecastPoint[]
}

type Trend = {
  first: number
  last: number
  delta: number
  ratio: number
  direction: "up" | "down" | "flat"
}

type Efficiency = {
  inputShare: number
  outputShare: number
  cacheShare: number
  cacheReadShare: number
  cacheWriteShare: number
  costPerMillionTokens: number
  tokensPerDollar: number
}

const severityColor: Record<InsightSeverity, ChartColor> = {
  info: "blue",
  good: "green",
  warn: "yellow",
  risk: "red",
}

const halfChartWidth = () => Math.max(22, Math.floor((statsContentWidth() - 5) / 2) - 8)
const compactBarWidth = () => Math.max(8, halfChartWidth() - 42)

const money = (value: number) => {
  if (!Number.isFinite(value)) return "$0.00"
  if (value >= 100) return `$${value.toFixed(0)}`
  if (value >= 10) return `$${value.toFixed(1)}`
  return `$${value.toFixed(4)}`
}

const percent = (value: number, total: number) => {
  if (!total || !Number.isFinite(value)) return "0.0%"
  return `${((value / total) * 100).toFixed(1)}%`
}

const safeDivide = (value: number, divisor: number) => {
  if (!divisor || !Number.isFinite(value) || !Number.isFinite(divisor)) return 0
  return value / divisor
}

const median = (values: number[]) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b)
  if (sorted.length === 0) return 0
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) return sorted[mid]
  return (sorted[mid - 1] + sorted[mid]) / 2
}

const percentile = (values: number[], p: number) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b)
  if (sorted.length === 0) return 0
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))))
  return sorted[index]
}

const sum = (values: number[]) => values.reduce((acc, value) => acc + value, 0)

const average = (values: number[]) => safeDivide(sum(values), values.length)

const stddev = (values: number[]) => {
  if (values.length === 0) return 0
  const avg = average(values)
  return Math.sqrt(average(values.map((value) => (value - avg) ** 2)))
}

const trend = (values: number[]): Trend => {
  const filtered = values.filter(Number.isFinite)
  if (filtered.length === 0) return { first: 0, last: 0, delta: 0, ratio: 0, direction: "flat" }
  const split = Math.max(1, Math.floor(filtered.length / 3))
  const first = average(filtered.slice(0, split))
  const last = average(filtered.slice(-split))
  const delta = last - first
  const ratio = first === 0 ? (last > 0 ? 1 : 0) : delta / first
  return {
    first,
    last,
    delta,
    ratio,
    direction: Math.abs(ratio) < 0.05 ? "flat" : ratio > 0 ? "up" : "down",
  }
}

const topShare = (groups: UsageGroup[], count: number, pick: (group: UsageGroup) => number) => {
  const total = sum(groups.map(pick))
  const top = sum(groups.slice(0, count).map(pick))
  return safeDivide(top, total)
}

const dailyValues = (daily: DailyUsage[], metric: "tokens" | "cost") =>
  daily.map((item) => (metric === "cost" ? item.cost : item.tokens.total))

const dailyPointValues = (daily: DailyUsage[], metric: "tokens" | "cost") =>
  daily.map((item) => ({ day: item.day, label: item.label, value: metric === "cost" ? item.cost : item.tokens.total }))

const efficiency = (report: StatsReport): Efficiency => {
  const total = report.total.tokens.total
  const cache = report.total.tokens.cache.read + report.total.tokens.cache.write
  return {
    inputShare: safeDivide(report.total.tokens.input, total),
    outputShare: safeDivide(report.total.tokens.output + report.total.tokens.reasoning, total),
    cacheShare: safeDivide(cache, total),
    cacheReadShare: safeDivide(report.total.tokens.cache.read, total),
    cacheWriteShare: safeDivide(report.total.tokens.cache.write, total),
    costPerMillionTokens: safeDivide(report.total.cost, total) * 1_000_000,
    tokensPerDollar: safeDivide(total, report.total.cost),
  }
}

const severityForTrend = (item: Trend, metric: "tokens" | "cost"): InsightSeverity => {
  if (item.direction === "flat") return "info"
  if (metric === "cost" && item.ratio > 0.5) return "risk"
  if (item.ratio > 0.25) return "warn"
  if (item.ratio < -0.15) return "good"
  return "info"
}

const trendInsight = (report: StatsReport, metric: "tokens" | "cost"): InsightCard => {
  const item = trend(dailyValues(report.daily, metric))
  const formatter = metricFormatter(metric)
  const label = metric === "cost" ? "cost" : "token usage"
  const direction = item.direction === "up" ? "increased" : item.direction === "down" ? "decreased" : "stayed flat"
  return {
    id: `${metric}-trend`,
    title: `${metric === "cost" ? "Cost" : "Token"} trend`,
    body: `Daily ${label} ${direction} from ${formatter(item.first)} to ${formatter(item.last)} across the visible window.`,
    severity: severityForTrend(item, metric),
    value: `${item.ratio >= 0 ? "+" : ""}${(item.ratio * 100).toFixed(1)}%`,
    detail: `${formatter(item.delta)} delta`,
  }
}

const concentrationInsight = (report: StatsReport, groups: UsageGroup[], kind: "model" | "provider"): InsightCard => {
  const share = topShare(groups, 1, (group) => group.tokens.total)
  const top = groups[0]
  const severity: InsightSeverity = share > 0.75 ? "risk" : share > 0.55 ? "warn" : share < 0.35 ? "good" : "info"
  return {
    id: `${kind}-concentration`,
    title: `${kind === "model" ? "Model" : "Provider"} concentration`,
    body: top
      ? `${top.label} accounts for ${percent(top.tokens.total, report.total.tokens.total)} of tokens in the selected range.`
      : `No ${kind} usage was found in the selected range.`,
    severity,
    value: top ? percent(top.tokens.total, report.total.tokens.total) : "0.0%",
    detail: top?.label,
  }
}

const cacheInsight = (report: StatsReport): InsightCard => {
  const item = efficiency(report)
  const severity: InsightSeverity = item.cacheReadShare > 0.35 ? "good" : item.cacheShare > 0.2 ? "info" : "warn"
  return {
    id: "cache-efficiency",
    title: "Cache efficiency",
    body: `Cache read/write tokens account for ${percent(item.cacheShare, 1)} of total usage; read cache is ${percent(item.cacheReadShare, 1)}.`,
    severity,
    value: percent(item.cacheShare, 1),
    detail: `${formatNumber(report.total.tokens.cache.read)} read / ${formatNumber(report.total.tokens.cache.write)} write`,
  }
}

const costEfficiencyInsight = (report: StatsReport): InsightCard => {
  const item = efficiency(report)
  const severity: InsightSeverity = item.costPerMillionTokens > 50 ? "risk" : item.costPerMillionTokens > 20 ? "warn" : "info"
  return {
    id: "cost-efficiency",
    title: "Cost efficiency",
    body: `The selected range averages ${money(item.costPerMillionTokens)} per 1M total tokens.`,
    severity,
    value: money(item.costPerMillionTokens),
    detail: `${formatNumber(item.tokensPerDollar)} tokens per dollar`,
  }
}

const sessionOutlierInsight = (report: StatsReport): InsightCard => {
  const costs = report.sessions.map((session) => session.cost)
  const p95 = percentile(costs, 95)
  const top = [...report.sessions].sort((a, b) => b.cost - a.cost || b.tokens.total - a.tokens.total)[0]
  const severity: InsightSeverity = top && top.cost > Math.max(1, p95 * 1.5) ? "risk" : top && top.cost > p95 ? "warn" : "info"
  return {
    id: "session-outlier",
    title: "Session outliers",
    body: top
      ? `${top.title || top.id} is the highest-cost session at ${money(top.cost)}; p95 is ${money(p95)}.`
      : "No session-level usage was found.",
    severity,
    value: top ? money(top.cost) : "$0.00",
    detail: top?.id,
  }
}

const requestDensityInsight = (report: StatsReport): InsightCard => {
  const requestsPerSession = safeDivide(report.total.requests, report.sessionsWithUsage)
  const callsPerRequest = safeDivide(report.total.assistantCalls, report.total.requests)
  const severity: InsightSeverity = callsPerRequest > 4 ? "warn" : requestsPerSession > 20 ? "info" : "good"
  return {
    id: "request-density",
    title: "Request density",
    body: `Average ${requestsPerSession.toFixed(1)} requests per usage session and ${callsPerRequest.toFixed(1)} assistant calls per request.`,
    severity,
    value: `${requestsPerSession.toFixed(1)} req/session`,
    detail: `${callsPerRequest.toFixed(1)} calls/request`,
  }
}

const toolDensityInsight = (report: StatsReport): InsightCard => {
  const toolsPerMessage = safeDivide(report.totalTools, report.totalMessages)
  const top = report.toolUsage[0]
  const severity: InsightSeverity = toolsPerMessage > 1.5 ? "warn" : toolsPerMessage > 0.5 ? "info" : "good"
  return {
    id: "tool-density",
    title: "Tool density",
    body: top
      ? `${top.id} is the most used tool; overall density is ${toolsPerMessage.toFixed(2)} tool calls per message.`
      : `Tool density is ${toolsPerMessage.toFixed(2)} tool calls per message.`,
    severity,
    value: toolsPerMessage.toFixed(2),
    detail: top ? `${top.id} ${formatNumber(top.count)}` : undefined,
  }
}

const volatilityInsight = (report: StatsReport): InsightCard => {
  const costs = dailyValues(report.daily, "cost")
  const avg = average(costs)
  const volatility = safeDivide(stddev(costs), avg)
  const severity: InsightSeverity = volatility > 1.2 ? "risk" : volatility > 0.7 ? "warn" : volatility < 0.25 ? "good" : "info"
  return {
    id: "cost-volatility",
    title: "Cost volatility",
    body: `Daily cost coefficient of variation is ${(volatility * 100).toFixed(1)}%.`,
    severity,
    value: `${(volatility * 100).toFixed(1)}%`,
    detail: `${money(avg)} daily avg`,
  }
}

export const buildInsights = (report: StatsReport): InsightCard[] => [
  trendInsight(report, "cost"),
  trendInsight(report, "tokens"),
  concentrationInsight(report, report.models, "model"),
  concentrationInsight(report, report.providers, "provider"),
  cacheInsight(report),
  costEfficiencyInsight(report),
  sessionOutlierInsight(report),
  requestDensityInsight(report),
  toolDensityInsight(report),
  volatilityInsight(report),
]

const renderInsightCards = (cards: InsightCard[], color?: ColorMode) => {
  const ctx = renderContext(color)
  return cards.flatMap((card) => {
    const accent = severityColor[card.severity]
    const value = card.value ? paint(card.value, accent, ctx, true) : ""
    const detail = card.detail ? paint(card.detail, "muted", ctx) : ""
    return [
      `${paint("●", accent, ctx)} ${padEndVisible(paint(card.title, "white", ctx, true), 28)} ${padStartVisible(value, 12)} ${detail}`,
      `  ${paint(card.body, "subtitle", ctx)}`,
    ]
  })
}

const recommendationRows = (cards: InsightCard[]) =>
  cards
    .filter((card) => card.severity === "risk" || card.severity === "warn")
    .map((card) => {
      if (card.id === "model-concentration") return [card.title, "Try splitting heavy workflows across models or agents."]
      if (card.id === "provider-concentration") return [card.title, "Keep a fallback provider configured for availability and cost control."]
      if (card.id === "cache-efficiency") return [card.title, "Review prompt reuse and cache-friendly system prompt boundaries."]
      if (card.id === "cost-efficiency") return [card.title, "Inspect expensive models and route routine tasks to lower-cost models."]
      if (card.id === "session-outlier") return [card.title, "Open the top session and inspect long loops or repeated tool retries."]
      if (card.id === "cost-volatility") return [card.title, "Use stats timeline --metric cost to find burst days before they become habits."]
      return [card.title, "Investigate this signal with the detailed stats subcommands."]
    })

const noRecommendationRows = (cards: InsightCard[]) =>
  recommendationRows(cards).length > 0 ? recommendationRows(cards) : [["No urgent recommendations", "Current usage shape looks balanced for this range."]]

export function buildForecast(report: StatsReport): ForecastReport {
  const costs = dailyValues(report.daily, "cost")
  const activeDays = Math.max(1, costs.filter((value) => value > 0).length)
  const dailyAverage = safeDivide(sum(costs), activeDays)
  const sigma = stddev(costs)
  const dayOfMonth = new Date().getDate()
  const daysInMonth = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getDate()
  const remainingDays = Math.max(0, daysInMonth - dayOfMonth)
  const projectedMonthEnd = report.total.cost + dailyAverage * remainingDays
  const confidence = clampConfidence(1 - safeDivide(sigma, dailyAverage * 2))
  const points = Array.from({ length: Math.min(14, remainingDays + 1) }, (_, index) => {
    const value = report.total.cost + dailyAverage * index
    return {
      label: index === 0 ? "now" : `+${index}d`,
      value,
      lower: Math.max(0, value - sigma * Math.sqrt(index)),
      upper: value + sigma * Math.sqrt(index),
    }
  })
  return {
    dailyAverage,
    weeklyRunRate: dailyAverage * 7,
    monthlyRunRate: dailyAverage * daysInMonth,
    projectedMonthEnd,
    confidence,
    points,
  }
}

function clampConfidence(value: number) {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(1, value))
}

function forecastSeries(forecast: ForecastReport) {
  const now = Date.now()
  const day = 24 * 60 * 60 * 1000
  return [
    {
      id: "forecast",
      label: "projected spend",
      color: "pink" as ChartColor,
      points: forecast.points.map((point, index) => ({ x: now + index * day, y: point.value, label: point.label, value: point.value })),
      total: forecast.projectedMonthEnd,
    },
    {
      id: "upper",
      label: "upper band",
      color: "yellow" as ChartColor,
      points: forecast.points.map((point, index) => ({ x: now + index * day, y: point.upper, label: point.label, value: point.upper })),
      total: forecast.points.at(-1)?.upper ?? 0,
    },
    {
      id: "lower",
      label: "lower band",
      color: "green" as ChartColor,
      points: forecast.points.map((point, index) => ({ x: now + index * day, y: point.lower, label: point.label, value: point.lower })),
      total: forecast.points.at(-1)?.lower ?? 0,
    },
  ]
}

function sessionOutlierRows(sessions: SessionUsage[]) {
  const costs = sessions.map((session) => session.cost)
  const p75 = percentile(costs, 75)
  const p95 = percentile(costs, 95)
  return [...sessions].sort((a, b) => b.cost - a.cost || b.tokens.total - a.tokens.total).slice(0, 8).map((session) => ({
    label: session.title || session.id,
    value: session.cost,
    subvalue: session.cost >= p95 ? "p95+" : session.cost >= p75 ? "p75+" : "normal",
    color: session.cost >= p95 ? "red" as ChartColor : session.cost >= p75 ? "yellow" as ChartColor : "blue" as ChartColor,
  }))
}

function modelMomentumRows(report: StatsReport) {
  return report.modelSeries.slice(0, 8).map((series) => {
    const item = trend(series.points.map((point) => point.tokens.total))
    return [
      series.label,
      formatNumber(series.tokens.total),
      `${item.ratio >= 0 ? "+" : ""}${(item.ratio * 100).toFixed(1)}%`,
      item.direction,
    ]
  })
}

function providerMomentumRows(report: StatsReport) {
  return report.providerSeries.slice(0, 8).map((series) => {
    const item = trend(series.points.map((point) => point.cost))
    return [
      series.label,
      money(series.cost),
      `${item.ratio >= 0 ? "+" : ""}${(item.ratio * 100).toFixed(1)}%`,
      item.direction,
    ]
  })
}

const forecastLedgerRows = (forecast: ForecastReport) => [
  ["daily average", money(forecast.dailyAverage)],
  ["weekly run-rate", money(forecast.weeklyRunRate)],
  ["monthly run-rate", money(forecast.monthlyRunRate)],
  ["projected month-end", money(forecast.projectedMonthEnd)],
  ["confidence", `${(forecast.confidence * 100).toFixed(0)}%`],
]

const forecastDetailLines = (report: StatsReport, forecast: ForecastReport, color?: ColorMode) => [
  "",
  ...renderTwoColumn(
    renderRoundedLineChart({
      title: "Observed daily cost",
      series: [dailySeries(dailyPointValues(report.daily, "cost"), "pink", "observed cost")],
      color,
      metric: "cost",
      width: halfChartWidth(),
      height: 10,
    }),
    renderRoundedLineChart({
      title: "Projected month-end spend",
      series: forecastSeries(forecast),
      color,
      metric: "cost",
      width: halfChartWidth(),
      height: 10,
    }),
    5,
  ),
  "",
  ...renderSlopeChart({
    title: "Cost slope · first third vs last third",
    rows: report.providers.slice(0, 8).map((provider) => {
      const series = report.providerSeries.find((item) => item.id === provider.id)
      const item = trend(series?.points.map((point) => point.cost) ?? [])
      return { label: provider.label, start: item.first, end: item.last }
    }),
    color,
    formatter: metricFormatter("cost"),
  }),
]

export function renderInsights(report: StatsReport, options: { color?: ColorMode; limit?: number; forecast?: boolean } & StatsRenderOptions = {}) {
  const cards = buildInsights(report)
  const forecast = buildForecast(report)
  const ctx = renderContext(options.color)

  // Sparkline of daily costs
  const dailyCosts = dailyValues(report.daily, "cost")
  const maxCost = Math.max(...dailyCosts, 1)
  const sparkChars = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"]
  const sparkline = dailyCosts.map((v) => paint(sparkChars[Math.min(sparkChars.length - 1, Math.floor((v / maxCost) * (sparkChars.length - 1)))], v > maxCost * 0.7 ? "red" : v > maxCost * 0.4 ? "yellow" : "green", ctx)).join("")

  const lines = [
    ...renderStatsHeader(report, options, "insights"),
    // Insight cards — wider value column
    ...cards.flatMap((card) => {
      const accent = severityColor[card.severity]
      const value = card.value ? paint(card.value, accent, ctx, true) : ""
      const detail = card.detail ? paint(` · ${card.detail}`, "muted", ctx) : ""
      return [
        `${paint("●", accent, ctx)} ${padEndVisible(paint(card.title, "white", ctx, true), 30)} ${padStartVisible(value, 14)}${detail}`,
        `  ${paint(card.body, "subtitle", ctx)}`,
      ]
    }),
    "",
    // Daily cost sparkline
    `${paint("Daily cost", "subtitle", ctx, true)}  ${sparkline}  ${paint(`peak ${money(maxCost)}`, "muted", ctx)}`,
    "",
    ...renderTwoColumn(
      renderRankBars({
        title: "Session outlier radar",
        rows: sessionOutlierRows(report.sessions),
        color: options.color,
        width: compactBarWidth(),
        formatter: metricFormatter("cost"),
      }),
      renderComparisonTable({
        title: "Recommendations",
        headers: ["signal", "action"],
        rows: noRecommendationRows(cards),
        color: options.color,
      }),
      5,
    ),
    "",
    ...renderTwoColumn(
      renderComparisonTable({
        title: "Model momentum",
        headers: ["model", "tokens", "trend", "dir"],
        rows: modelMomentumRows(report),
        color: options.color,
      }),
      renderComparisonTable({
        title: "Provider momentum",
        headers: ["provider", "cost", "trend", "dir"],
        rows: providerMomentumRows(report),
        color: options.color,
      }),
      5,
    ),
    "",
    ...renderTwoColumn(
      renderComparisonTable({
        title: "Run-rate forecast",
        headers: ["metric", "value"],
        rows: [
          ...forecastLedgerRows(forecast),
          ["active days", String(dailyCosts.filter((v) => v > 0).length)],
          ["zero days", String(dailyCosts.filter((v) => v === 0).length)],
        ],
        color: options.color,
      }),
      renderHistogram({
        title: "Daily cost distribution",
        values: dailyValues(report.daily, "cost"),
        color: options.color,
        width: Math.max(12, halfChartWidth() - 18),
        formatter: metricFormatter("cost"),
      }),
      5,
    ),
    ...(options.forecast ? forecastDetailLines(report, forecast, options.color) : []),
  ]
  return renderPanel({ lines, color: options.color })
}
