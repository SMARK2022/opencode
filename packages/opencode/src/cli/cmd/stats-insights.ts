import type { DailyUsage, SessionUsage, StatsReport, UsageGroup } from "./stats-data"
import type { ColorMode } from "./stats-render"
import { formatNumber } from "../format"
import {
  metricFormatter,
  renderCallout,
  renderComparisonTable,
  renderGauge,
  renderHistogram,
  renderRankBars,
  renderRoundedLineChart,
  renderTwoColumn,
  dailySeries,
  renderPanel,
  renderContext,
  statsContentWidth,
  paint,
  padEndVisible,
  padStartVisible,
  type ChartColor,
  type ChartSeries,
} from "./stats-charts"

// 严重度→色彩映射：info 蓝 / good 绿 / warn 黄 / risk 红，与终端 256 色板对齐
export type InsightSeverity = "info" | "good" | "warn" | "risk"

// 洞察卡片三要素：标题/正文/严重度 + 可选数值与明细，渲染层按存在性降级
export type InsightCard = {
  id: string
  title: string
  body: string
  severity: InsightSeverity
  value?: string
  detail?: string
}

// 投影点带上下界：lower/upper 由 σ√index 导出，渲染成置信带
export type ForecastPoint = {
  label: string
  value: number
  lower: number
  upper: number
}

// 预测报告聚合五个口径：日均/周率/月率/月末投影/置信度
export type ForecastReport = {
  dailyAverage: number
  weeklyRunRate: number
  monthlyRunRate: number
  projectedMonthEnd: number
  confidence: number
  points: ForecastPoint[]
}

// Trend 记录首尾均值、绝对差与相对比率，direction 为派生结论
type Trend = {
  first: number
  last: number
  delta: number
  ratio: number
  direction: "up" | "down" | "flat"
}

// Efficiency 拆分五类 token 份额，供缓存/成本两张卡片复用
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

// 布局常量：半宽图与紧凑条共用宽度下限，避免窄终端下双栏内容重叠截断
const halfChartWidth = () => Math.max(22, Math.floor((statsContentWidth() - 5) / 2) - 8)
const compactBarWidth = () => Math.max(8, halfChartWidth() - 42)

// 金额精度分层：≥100 取整、≥10 一位小数、其余四位——大数降噪、小数保留量级
const money = (value: number) => {
  if (!Number.isFinite(value)) return "$0.00"
  if (value >= 100) return `$${value.toFixed(0)}`
  if (value >= 10) return `$${value.toFixed(1)}`
  return `$${value.toFixed(4)}`
}

// 分母为 0 或非有限值时按 0.0% 处理，保证空数据区间的渲染稳定
const percent = (value: number, total: number) => {
  if (!total || !Number.isFinite(value)) return "0.0%"
  return `${((value / total) * 100).toFixed(1)}%`
}

// 除法统一入口：非有限值与零除一并归 0，防止 NaN 沿调用链扩散到渲染层
const safeDivide = (value: number, divisor: number) => {
  if (!divisor || !Number.isFinite(value) || !Number.isFinite(divisor)) return 0
  return value / divisor
}

// median/percentile 先滤非有限值再排序，异常采样点不参与分位计算
const median = (values: number[]) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b)
  if (sorted.length === 0) return 0
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) return sorted[mid]
  return (sorted[mid - 1] + sorted[mid]) / 2
}

// 分位索引按 round((p/100)×(n-1)) 取最近序位，p=0/100 精确落在首尾
const percentile = (values: number[], p: number) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b)
  if (sorted.length === 0) return 0
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))))
  return sorted[index]
}

// 标准差用总体口径（除以 n）：与变异系数分母同量纲，短序列不做样本校正
const stddev = (values: number[]) => {
  if (values.length === 0) return 0
  const avg = average(values)
  return Math.sqrt(average(values.map((value) => (value - avg) ** 2)))
}

const sum = (values: number[]) => values.reduce((acc, value) => acc + value, 0)

const average = (values: number[]) => safeDivide(sum(values), values.length)

// trend 用三等分首尾均值而非首尾单点，抑制单日毛刺对方向判断的误导
const trend = (values: number[]): Trend => {
  const filtered = values.filter(Number.isFinite)
  if (filtered.length === 0) return { first: 0, last: 0, delta: 0, ratio: 0, direction: "flat" }
  // 三等分切片下限 1：短序列也保证首尾窗口非空
  const split = Math.max(1, Math.floor(filtered.length / 3))
  const first = average(filtered.slice(0, split))
  const last = average(filtered.slice(-split))
  const delta = last - first
  // 基数为 0 时按"从无到有"视为满幅上涨，避免除零失真
  const ratio = first === 0 ? (last > 0 ? 1 : 0) : delta / first
  return {
    first,
    last,
    delta,
    ratio,
    // ±5% 以内视为持平：低于该阈值的波动无业务含义
    direction: Math.abs(ratio) < 0.05 ? "flat" : ratio > 0 ? "up" : "down",
  }
}

// 集中度只算前 count 组占总量份额，groups 已按调用方排好序
const topShare = (groups: UsageGroup[], count: number, pick: (group: UsageGroup) => number) => {
  const total = sum(groups.map(pick))
  const top = sum(groups.slice(0, count).map(pick))
  return safeDivide(top, total)
}

// 指标切换统一入口：cost 用日成本、tokens 用日总量，后续图表共用
const dailyValues = (daily: DailyUsage[], metric: "tokens" | "cost") =>
  daily.map((item) => (metric === "cost" ? item.cost : item.tokens.total))

const dailyPointValues = (daily: DailyUsage[], metric: "tokens" | "cost") =>
  daily.map((item) => ({ day: item.day, label: item.label, value: metric === "cost" ? item.cost : item.tokens.total }))

// 效率分母为全部 token（input+output+reasoning+cache），output 份额含 reasoning 部分
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

// 阈值分级：成本上涨比 token 更严格（50%/25% vs 25%），回落 15% 即为改善
const severityForTrend = (item: Trend, metric: "tokens" | "cost"): InsightSeverity => {
  if (item.direction === "flat") return "info"
  if (metric === "cost" && item.ratio > 0.5) return "risk"
  if (item.ratio > 0.25) return "warn"
  if (item.ratio < -0.15) return "good"
  return "info"
}

const trendInsight = (report: StatsReport, metric: "tokens" | "cost"): InsightCard => {
  const item = trend(dailyValues(report.daily, metric))
  const formatter = metricFormatter
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

// 集中度分级：单点占比 >75% 风险、>55% 警告、<35% 健康——避免单一供应商依赖
const concentrationInsight = (report: StatsReport, groups: UsageGroup[], kind: "model" | "provider"): InsightCard => {
  const share = topShare(groups, 1, (group) => group.tokens.total)
  // groups 已按 tokens 降序排列，[0] 即最大消费方
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

// 缓存健康：读缓存 >35% 视为良好命中，总缓存 <20% 视为提示词结构欠佳
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

// 成本效率：每百万 token 成本 >$50 风险、>$20 警告——按主流模型价位带设定
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

// 会话异常：top 会话超过 p95×1.5 判风险、超过 p95 判警告，隔离单会话失控
const sessionOutlierInsight = (report: StatsReport): InsightCard => {
  const costs = report.sessions.map((session) => session.cost)
  // p95 作为异常基准线：覆盖 95% 常规会话的成本上包络
  const p95 = percentile(costs, 95)
  const top = report.sessions[0]
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

// 请求密度：单请求 >4 次 assistant 调用提示重试/循环，>20 请求/会话属重度使用
const requestDensityInsight = (report: StatsReport): InsightCard => {
  const requestsPerSession = safeDivide(report.total.requests, report.sessionsWithUsage)
  // 每请求 assistant 调用数反映重试与多轮工具循环的频率
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

// 工具密度：>1.5 次/消息 提示工作流工具化过度，仅信息级
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

// 波动率 = 日成本标准差/均值（变异系数），>1.2 失控、<0.25 稳定
const volatilityInsight = (report: StatsReport): InsightCard => {
  const costs = dailyValues(report.daily, "cost")
  const avg = average(costs)
  // 变异系数剥离量纲：成本绝对值不同的账户可直接比较波动
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

// 卡片顺序：成本趋势→token 趋势→集中度→效率→异常→密度→波动，风险信号靠前
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

// 渲染上下文统一解析 color 模式（auto/always/never），与全站统计输出一致
const renderInsightCards = (cards: InsightCard[], color?: ColorMode) => {
  const ctx = renderContext(color)
  return cards.flatMap((card) => {
    // 强调色只用于数值与圆点，正文保持中性色以免整版花哨
    const accent = severityColor[card.severity]
    const value = card.value ? paint(card.value, accent, ctx, true) : ""
    // 目标色板无 muted/subtitle 语义色：明细用 gray、正文用 white
    const detail = card.detail ? paint(card.detail, "gray", ctx) : ""
    return [
      `${paint("●", accent, ctx, true)} ${padEndVisible(paint(card.title, "white", ctx, true), 28)} ${padStartVisible(value, 12)} ${detail}`,
      `  ${paint(card.body, "white", ctx)}`,
    ]
  })
}

// 建议按卡片 id 精确路由到可执行动作，未知 id 落到通用调查建议而非空白
const recommendationRows = (cards: InsightCard[]) =>
  cards
    .filter((card) => card.severity === "risk" || card.severity === "warn")
    .map((card) => {
      if (card.id === "model-concentration") return [card.title, "Try splitting heavy workflows across models or agents."]
      if (card.id === "provider-concentration") return [card.title, "Keep a fallback provider configured for availability and cost control."]
      if (card.id === "cache-efficiency") return [card.title, "Review prompt reuse and cache-friendly system prompt boundaries."]
      if (card.id === "cost-efficiency") return [card.title, "Inspect expensive models and route routine tasks to lower-cost models."]
      if (card.id === "session-outlier") return [card.title, "Open the top session and inspect long loops or repeated tool retries."]
      if (card.id === "cost-volatility") return [card.title, "Use stats timeline/costs to find burst days before they become habits."]
      return [card.title, "Investigate this signal with the detailed stats subcommands."]
    })

// 无风险/警告卡片时给出平衡结论，避免空面板让用户误以为数据缺失
const noRecommendationRows = (cards: InsightCard[]) =>
  recommendationRows(cards).length > 0 ? recommendationRows(cards) : [["No urgent recommendations", "Current usage shape looks balanced for this range."]]

// 预测用活跃日均值（0 值日剔除）而非自然日均，避免间歇使用拉低 run-rate
export function buildForecast(report: StatsReport): ForecastReport {
  const costs = dailyValues(report.daily, "cost")
  // 活跃日下限 1：全零区间也能给出可用 run-rate 而非 NaN
  const activeDays = Math.max(1, costs.filter((value) => value > 0).length)
  const dailyAverage = safeDivide(sum(costs), activeDays)
  const sigma = stddev(costs)
  // 月末锚点用本地时区实算，跨月边界由 getDate 归零自然处理
  const dayOfMonth = new Date().getDate()
  const daysInMonth = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getDate()
  const remainingDays = Math.max(0, daysInMonth - dayOfMonth)
  const projectedMonthEnd = report.total.cost + dailyAverage * remainingDays
  // 置信度 = 1 - σ/(2×日均)：波动越大置信越低，clamp 到 [0,1] 防越界
  const confidence = clampConfidence(1 - safeDivide(sigma, dailyAverage * 2))
  // 投影窗口取 min(14, remaining+1)：远期预测只保留两周，超出部分噪声主导
  const points = Array.from({ length: Math.min(14, remainingDays + 1) }, (_, index) => {
    const value = report.total.cost + dailyAverage * index
    return {
      label: index === 0 ? "now" : `+${index}d`,
      value,
      // 置信带按 √index 放大 σ：随机游走假设下不确定性随天数开方增长
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

// 非有限值一律归 0：σ 为 0 时置信度满格，成本序列不足时置信为 0
function clampConfidence(value: number) {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(1, value))
}

// 三序列着色语义：品红=投影线、黄=上界、绿=下界，与 forecast 面板图例一致
function forecastSeries(forecast: ForecastReport): ChartSeries[] {
  const now = Date.now()
  const day = 24 * 60 * 60 * 1000
  return [
    {
      id: "forecast",
      label: "projected spend",
      points: forecast.points.map((point, index) => ({ x: index, y: point.value, label: point.label })),
      style: { color: "magenta" },
    },
    {
      id: "upper",
      label: "upper band",
      points: forecast.points.map((point, index) => ({ x: index, y: point.upper, label: point.label })),
      style: { color: "yellow" },
    },
    {
      id: "lower",
      label: "lower band",
      points: forecast.points.map((point, index) => ({ x: index, y: point.lower, label: point.label })),
      style: { color: "green" },
    },
  ]
}

// 异常雷达行按 p75/p95 分档着色，仅取 top8 避免长尾会话刷屏；目标条形 API 不带分级字段，档位编码进标签
function sessionOutlierRows(sessions: SessionUsage[]) {
  const costs = sessions.map((session) => session.cost)
  const p75 = percentile(costs, 75)
  const p95 = percentile(costs, 95)
  return sessions.slice(0, 8).map((session) => ({
    label: `${session.title || session.id}${session.cost >= p95 ? " [p95+]" : session.cost >= p75 ? " [p75+]" : ""}`,
    value: session.cost,
  }))
}

// 模型动量用三段趋势比率，方向列与洞察卡 severityForTrend 阈值同口径
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

// 供应商动量按成本口径计算，与 token 口径的模型动量互补
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

// insights 面板分三段双栏：卡片+雷达/建议、双动量表、置信仪表+方差直方
export function renderInsights(report: StatsReport, options: { color?: ColorMode; limit?: number } = {}) {
  const cards = buildInsights(report)
  const forecast = buildForecast(report)
  const lines = [
    // 面板头 callout 说明数据口径（所选时间范围），避免跨范围误读
    ...renderCallout("opencode stats insights", "Signals, recommendations, and outlier analysis derived from the selected stats range."),
    "",
    ...renderInsightCards(cards, options.color),
    "",
    // 双栏布局：短侧留白优于溢出换行
    ...renderTwoColumn(
      // 目标条形 API 不接受 formatter：数值预格式化为金额字符串
      renderRankBars({
        title: "Session outlier radar",
        rows: sessionOutlierRows(report.sessions).map((row) => ({ label: row.label, value: row.value })),
        width: compactBarWidth(),
      }),
      renderComparisonTable([
        ["signal", "action"],
        ...noRecommendationRows(cards),
      ]),
    ),
    "",
    ...renderTwoColumn(
      renderComparisonTable([
        ["model", "tokens", "trend", "dir"],
        ...modelMomentumRows(report),
      ]),
      renderComparisonTable([
        ["provider", "cost", "trend", "dir"],
        ...providerMomentumRows(report),
      ]),
    ),
    "",
    ...renderTwoColumn(
      // 置信仪表以百分比展示，宽度与右栏直方图对齐
      renderGauge({ title: "Forecast confidence", value: forecast.confidence }),
      renderHistogram({ title: "Daily cost variance", values: dailyValues(report.daily, "cost") }),
    ),
  ]
  // 统一经 renderPanel 包装：边框/内边距/主题由 charts 层单点控制；join 与其他视图的 string 返回合同一致
  return renderPanel("opencode stats insights", lines).join("\n")
}

// forecast 面板：观测线+投影带双图对照，附 run-rate 台账与斜率表
export function renderForecast(report: StatsReport, options: { color?: ColorMode } = {}) {
  const forecast = buildForecast(report)
  const costs = dailyPointValues(report.daily, "cost")
  const lines = [
    ...renderCallout(
      "opencode stats forecast",
      "Run-rate projection using active-day averages and observed daily volatility.",
    ),
    "",
    ...renderTwoColumn(
      renderRoundedLineChart({
        title: "Observed daily cost",
        // 目标 dailySeries 以 pick 函数取值，序列色经 style 承载
        series: [{ ...dailySeries(report.daily, (d) => d.cost, "observed-cost"), style: { color: "magenta" } }],
        width: halfChartWidth(),
        height: 10,
      }),
      renderRoundedLineChart({
        title: "Projected month-end spend",
        series: forecastSeries(forecast),
        width: halfChartWidth(),
        height: 10,
      }),
    ),
    "",
    ...renderComparisonTable([
      ["metric", "value"],
      ["daily average", money(forecast.dailyAverage)],
      ["weekly run-rate", money(forecast.weeklyRunRate)],
      ["monthly run-rate", money(forecast.monthlyRunRate)],
      ["projected month-end", money(forecast.projectedMonthEnd)],
      ["confidence", `${(forecast.confidence * 100).toFixed(0)}%`],
    ]),
    "",
    // 目标 slope API 接受单序列：改用对照表承载首末三段趋势，能力等价
    ...renderComparisonTable([
      ["provider", "first third", "last third"],
      ...report.providers.slice(0, 8).map((provider) => {
        const series = report.providerSeries.find((item) => item.id === provider.id)
        const item = trend(series?.points.map((point) => point.cost) ?? [])
        return [provider.label, money(item.first), money(item.last)]
      }),
    ]),
  ]
  return renderPanel("opencode stats forecast", lines).join("\n")
}
