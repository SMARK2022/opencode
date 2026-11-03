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
  terminalText,
  wrapAnsiVisible,
  wrapVisible,
  renderPercentStack,
  type ChartColor,
  type ChartSeries,
} from "./stats-charts"

// 严重度→色彩映射：info 蓝 / good 绿 / warn 黄 / risk 红，与终端 256 色板对齐
// #483：severity 字段保留为元数据（历史 call ID/归档兼容），但不再驱动色彩或建议路由——
// 主观好坏分级从页面呈现中完全退出
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

// 预测报告口径：dailyAverage 是活跃日均值，activityRate 是活跃日占比；两者不可混成同一指标，
// 月度预测需要两者相乘（calendarDailyAverage）；30-day run rate 用固定窗口而非自然月天数
export type ForecastReport = {
  dailyAverage: number
  weeklyRunRate: number
  activityRate: number
  thirtyDayRunRate: number
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

// #483：severityColor 已随 severity 色标一并退役——定量证据不做好坏红绿暗示

// 布局常量：半宽图与紧凑条共用宽度下限，避免窄终端下双栏内容重叠截断
const halfChartWidth = () => Math.max(22, Math.floor((statsContentWidth() - 5) / 2) - 8)
const compactBarWidth = () => Math.max(8, halfChartWidth() - 42)

// #483：金额展示与不可用标注共用入口——调用方不再各自判断零/缺失语义
// 金额精度分层：≥100 取整、≥10 一位小数、其余四位——大数降噪、小数保留量级
const money = (value: number) => {
  // #483：价格缺失或零展示为不可用标注，不伪造 $0.00——零费用与无计费数据是两件事
  if (!Number.isFinite(value) || value <= 0) return "—"
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
// #483：趋势方向仍是定量派生（first/last 差值），direction 只描述变化不评判好坏
const severityForTrend = (item: Trend, metric: "tokens" | "cost"): InsightSeverity => {
  if (item.direction === "flat") return "info"
  if (metric === "cost" && item.ratio > 0.5) return "risk"
  if (item.ratio > 0.25) return "warn"
  if (item.ratio < -0.15) return "good"
  return "info"
}

// #483：卡片工厂保留 severity 赋值仅为元数据完整性，页面不消费
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
  const severity: InsightSeverity =
    item.costPerMillionTokens > 50 ? "risk" : item.costPerMillionTokens > 20 ? "warn" : "info"
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
  // #177：sessions 已翻转为 tokens-first，异常语义按成本口径防御性重排
  const top = [...report.sessions].sort((a, b) => b.cost - a.cost || b.tokens.total - a.tokens.total)[0]
  const severity: InsightSeverity =
    top && top.cost > Math.max(1, p95 * 1.5) ? "risk" : top && top.cost > p95 ? "warn" : "info"
  return {
    id: "session-outlier",
    title: "Session outliers",
    body: top
      ? `${top.title || top.id} is the highest-cost session at ${money(top.cost)}; p95 is ${money(p95)}.`
      : "No session-level usage was found.",
    severity,
    // #483：无带费用 session 时无数值可示——显示不可用标注而非伪造 $0.00
    value: top ? money(top.cost) : "—",
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
  const severity: InsightSeverity =
    volatility > 1.2 ? "risk" : volatility > 0.7 ? "warn" : volatility < 0.25 ? "good" : "info"
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

// #483：insight 卡片渲染契约：标题/数值/明细三段均为定量事实，
// 色彩只承担扫描锚点不做健康评判
// 渲染上下文统一解析 color 模式（auto/always/never），与全站统计输出一致
const renderInsightCards = (cards: InsightCard[], color?: ColorMode) => {
  const ctx = renderContext(color)
  // #483：severity 色标退役——good/warn/risk 是主观建议信号；
  // insights 页只呈现定量证据，数值保留强调色但不作健康暗示
  const accent: ChartColor = "cyan"
  const value = (card: InsightCard) => (card.value ? paint(card.value, accent, ctx, true) : "")
  const detail = (card: InsightCard) => (card.detail ? paint(terminalText(card.detail), "gray", ctx) : "")
  // #483：title/body 内插持久化实体标签（session title/model/provider），
  // 卡片出口与同页 observation 表共享同一 terminalText 清洗契约
  const title = (card: InsightCard) => padEndVisible(paint(terminalText(card.title), "white", ctx, true), 28)
  const body = (card: InsightCard) => paint(terminalText(card.body), "white", ctx)
  return cards.flatMap((card) => [
    `${paint("●", accent, ctx, true)} ${title(card)} ${padStartVisible(value(card), 12)} ${detail(card)}`,
    `  ${body(card)}`,
  ])
}

// #483：建议路由整表退役——severity 驱动的可执行建议是主观判断；
// insight 表改为定量观察（signal → 卡片自带 body），空范围只陈述事实
const observationRows = (cards: InsightCard[]) =>
  // hasUsage 守卫后恒为非空卡片流；空态已由守卫提前返回，无需防御分支
  cards.map((card) => [card.title, card.body])

// 预测用活跃日均值（0 值日剔除）而非自然日均，避免间歇使用拉低 run-rate
export function buildForecast(report: StatsReport): ForecastReport {
  // #483：预测只使用当前已选窗口，不暗中加载 all-time 数据，保持命令范围可预期
  const costs = dailyValues(report.daily, "cost")
  const activeCosts = costs.filter((value) => value > 0)
  // #483：活跃日均值描述单次使用强度，活跃率描述使用频率；月度预测需要两者相乘，
  // 避免稀疏用户的一次高费用被外推成每日持续费用
  const dailyAverage = safeDivide(sum(activeCosts), Math.max(1, activeCosts.length))
  const activityRate = safeDivide(activeCosts.length, costs.length)
  const calendarDailyAverage = dailyAverage * activityRate
  const activeSigma = stddev(activeCosts)
  // #483：将“当天是否活跃”的伯努利波动与活跃日费用波动合并为日历口径 σ，
  // 只用 activeCosts 的标准差会忽略大量零日，误报稳定
  const calendarSigma = Math.sqrt(
    Math.max(0, activityRate * (activeSigma ** 2 + dailyAverage ** 2) - calendarDailyAverage ** 2),
  )
  // 方差恒等式 Var(X) = E[p·σ² + (p·μ)²] - (p·μ)²；负值只能来自浮点误差，clamp 到 0
  // #483：月份边界按本地自然日计算；锚点用窗口 latest，查看旧月份不会掺入当前系统日期
  const anchor = new Date(report.dateRange.latest || Date.now())
  const year = anchor.getFullYear()
  const month = anchor.getMonth()
  const dayOfMonth = anchor.getDate()
  const daysInMonth = new Date(year, month + 1, 0).getDate()
  const remainingDays = Math.max(0, daysInMonth - dayOfMonth)
  // #483：月末投影只能以当前自然月的已发生费用为基线；选择区间可能跨月，
  // 不能把整个 report.total.cost 误当成 month-to-date
  const monthToDate = sum(
    report.daily
      .filter((day) => {
        const date = new Date(day.day)
        return date.getFullYear() === year && date.getMonth() === month && day.day <= report.dateRange.latest
      })
      .map((day) => day.cost),
  )
  const projectedMonthEnd = monthToDate + calendarDailyAverage * remainingDays
  // 置信度 = 1 - σ/(2×日均)：波动越大置信越低，clamp 到 [0,1] 防越界
  const confidence =
    calendarDailyAverage > 0 ? clampConfidence(1 - safeDivide(calendarSigma, calendarDailyAverage * 2)) : 0
  // 投影覆盖到月末：基线是 month-to-date，点列从 now 起按日历日均推算
  const points = Array.from({ length: remainingDays + 1 }, (_, index) => {
    const value = monthToDate + calendarDailyAverage * index
    return {
      label: index === 0 ? "now" : `+${index}d`,
      value,
      // 置信带按 √index 放大 σ：随机游走假设下不确定性随天数开方增长
      lower: Math.max(0, value - calendarSigma * Math.sqrt(index)),
      upper: value + calendarSigma * Math.sqrt(index),
    }
  })
  return {
    dailyAverage,
    weeklyRunRate: calendarDailyAverage * 7,
    activityRate,
    // #483：30-day run rate 使用固定窗口；自然月天数只参与独立的 month-end 投影，
    // 两者口径不同，禁止混在同一字段里导出
    thirtyDayRunRate: calendarDailyAverage * 30,
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
  // #177：雷达行同样恢复 cost-first 口径，top8 按成本选取
  const ranked = [...sessions].sort((a, b) => b.cost - a.cost || b.tokens.total - a.tokens.total)
  return ranked.slice(0, 8).map((session) => ({
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
export function renderInsights(
  report: StatsReport,
  options: { color?: ColorMode; limit?: number; forecast?: boolean } = {},
) {
  // 工具独立存在也是用量；仅有Session数量则不能产生使用结论。
  const hasUsage =
    report.total.tokens.total > 0 ||
    report.total.cost > 0 ||
    report.total.requests > 0 ||
    report.total.assistantCalls > 0 ||
    report.toolUsage.some((tool) => tool.count > 0 || tool.contextTokens > 0)
  if (!hasUsage) return renderPanel("opencode stats insights", ["No usage data for the selected range."]).join("\n")
  const section = (title: string) => ["", paint(`━━━ ${title}`, "magenta", renderContext(options.color), true), ""]
  const components = Object.entries({
    system: report.total.components.system,
    instructions: report.total.components.instructions,
    skills: report.total.components.skills,
    schemas: report.total.components.toolSchemas,
    user: report.total.components.userMessages,
    assistant: report.total.components.assistantText,
    reasoning: report.total.components.reasoning,
    "tool calls": report.total.components.toolCalls,
    "tool results": report.total.components.toolResults,
    attach: report.total.components.attachments,
  })
  // 十类输入共享完整分母，不能把未展示的部分删除后重新归一化。
  const inputTotal = sum(components.map(([, value]) => value))
  const attribution = [
    { dimension: "model", groups: report.models, series: report.modelSeries },
    { dimension: "provider", groups: report.providers, series: report.providerSeries },
    { dimension: "agent", groups: report.agents, series: report.agentSeries },
    { dimension: "source", groups: report.sources, series: report.sourceSeries },
    { dimension: "project", groups: report.projects, series: report.projectSeries },
    {
      dimension: "status",
      groups: report.statuses.filter((group) => group.id !== "unattributed"),
      series: report.statusSeries,
    },
  ].map((entry) => {
    const leader = entry.groups.toSorted((a, b) => b.tokens.total - a.tokens.total)[0]
    const item = trend(entry.series.find((series) => series.id === leader?.id)?.points.map((point) => point.cost) ?? [])
    return [
      entry.dimension,
      leader?.label ?? "—",
      percent(leader?.tokens.total ?? 0, report.total.tokens.total),
      money(leader?.cost ?? 0),
      `${item.ratio >= 0 ? "+" : ""}${(item.ratio * 100).toFixed(1)}%`,
      percent((leader?.errors ?? 0) + (leader?.aborted ?? 0), leader?.requests ?? 0),
    ]
  })
  const costs = dailyValues(report.daily, "cost")
  // 零费用可能表示未定价，不参与正费用会话分位数。
  const sessionCosts = report.sessions.map((session) => session.cost).filter((value) => value > 0)
  const p95 = percentile(sessionCosts, 95)
  const top = report.sessions.toSorted((a, b) => b.cost - a.cost)[0]
  const model = report.models[0]
  const provider = report.providers[0]
  const actions = [
    ...(model && safeDivide(model.tokens.total, report.total.tokens.total) > 0.55
      ? [
          `Model ${terminalText(model.label)} share ${percent(model.tokens.total, report.total.tokens.total)} > 55% · inspect breakdown model`,
        ]
      : []),
    ...(provider && safeDivide(provider.tokens.total, report.total.tokens.total) > 0.55
      ? [
          `Provider ${terminalText(provider.label)} share ${percent(provider.tokens.total, report.total.tokens.total)} > 55% · inspect breakdown provider`,
        ]
      : []),
    ...(top && top.cost > p95 * 1.5
      ? [
          `Session ${terminalText(top.title || top.id)} costs ${money(top.cost)} vs p95 ${money(p95)} · inspect sessions --sort cost`,
        ]
      : []),
    ...(safeDivide(report.total.errors + report.total.aborted, report.total.requests) > 0.02
      ? [
          `Failure rate ${percent(report.total.errors + report.total.aborted, report.total.requests)} > 2% · inspect breakdown status`,
        ]
      : []),
    // ToolPart不是Assistant token分母，tool-only不能生成低缓存行动项。
    ...(report.total.tokens.total > 0 && safeDivide(report.total.tokens.cache.read, report.total.tokens.total) < 0.2
      ? [
          `Cache read ${percent(report.total.tokens.cache.read, report.total.tokens.total)} < 20% · compare reusable prompt prefixes`,
        ]
      : []),
  ].slice(0, 3)
  const unattributed = report.statuses.find((group) => group.id === "unattributed")
  const lines = [
    ...section("Usage shape"),
    ...renderPercentStack({
      columns: [
        {
          label: "tokens",
          parts: [
            { label: "input", value: report.total.tokens.input },
            { label: "output", value: report.total.tokens.output + report.total.tokens.reasoning },
            { label: "cache read", value: report.total.tokens.cache.read },
            { label: "cache write", value: report.total.tokens.cache.write },
          ],
        },
      ],
    }),
    ...(inputTotal > 0
      ? wrapVisible(components.map(([label, value]) => `${label} ${percent(value, inputTotal)}`).join(" · "))
      : []),
    `efficiency ${report.total.cost > 0 ? `${money(efficiency(report).costPerMillionTokens)}/M tok · ${formatNumber(efficiency(report).tokensPerDollar)} tok/$` : "cost/M — · tok/$ —"} · ${percent(report.total.tokens.cache.read, report.total.tokens.total)} cache read · ${safeDivide(report.total.assistantCalls, report.total.requests).toFixed(1)} calls/request`,
    ...section("Attribution"),
    ...renderComparisonTable([
      ["dimension", "leader", "token share", "cost", "recent cost change", "owner fail"],
      ...attribution,
    ]),
    `Status leader excludes unattributed usage; ${formatNumber(unattributed?.tokens.total ?? 0)} tokens without request outcome are reported separately.`,
    ...section("Variability & outliers"),
    ...(report.total.cost > 0
      ? [
          `Daily cost avg ${money(average(costs))} · p95 ${money(percentile(costs, 95))} · peak ${money(Math.max(0, ...costs))} · coefficient of variation ${(safeDivide(stddev(costs), average(costs)) * 100).toFixed(0)}% · active ${costs.filter((value) => value > 0).length}/${costs.length} days`,
          sessionCosts.length > 0
            ? `Session cost p50 ${money(percentile(sessionCosts, 50))} · p95 ${money(p95)} · max ${money(top?.cost ?? 0)} · max/p95 ${safeDivide(top?.cost ?? 0, p95).toFixed(1)}x`
            : "Session cost unavailable · no positive Session cost recorded in this range.",
        ]
      : [
          "Daily cost unavailable · no positive cost recorded in this range.",
          `Session token distribution · p50 ${formatNumber(
            percentile(
              report.sessions.map((session) => session.tokens.total),
              50,
            ),
          )} · p95 ${formatNumber(
            percentile(
              report.sessions.map((session) => session.tokens.total),
              95,
            ),
          )}`,
        ]),
    `Session tokens mean ${formatNumber(report.tokensPerSession)} · median ${formatNumber(report.medianTokensPerSession)} · mean/median ${safeDivide(report.tokensPerSession, report.medianTokensPerSession).toFixed(1)}x · top 2 share ${percent(
      sum(
        report.sessions
          .toSorted((a, b) => b.tokens.total - a.tokens.total)
          .slice(0, 2)
          .map((session) => session.tokens.total),
      ),
      report.total.tokens.total,
    )}`,
    ...(top ? [`Top session: ${terminalText(top.title || top.id)}`] : []),
    ...section("Actions"),
    ...(actions.length ? actions.map((action) => `! ${action}`) : ["No material threshold crossings in this range."]),
  ]
  // 仅显式请求预测时调用同一个Forecast入口，不在默认路径生成隐藏预测。
  return [
    ...renderPanel(
      "opencode stats insights",
      lines.flatMap((line) => (line.includes("\x1b[") ? wrapAnsiVisible(line) : wrapVisible(line))),
    ),
    ...(options.forecast ? [renderForecast(report, options)] : []),
  ].join("\n")
}

// forecast 面板：观测线+投影带双图对照，附 run-rate 台账与斜率表
export function renderForecast(report: StatsReport, options: { color?: ColorMode } = {}) {
  // 没有正费用观测就不生成预测线或伪造稳定置信度。
  if (report.total.cost <= 0)
    return renderPanel("Forecast", ["Forecast unavailable: no positive cost recorded in the selected range."]).join(
      "\n",
    )
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
      ["daily average (active days)", money(forecast.dailyAverage)],
      ["weekly run-rate", money(forecast.weeklyRunRate)],
      // #483：30-day 固定窗口口径取代自然月天数——跨月比较采样点数量一致
      ["30-day run-rate", money(forecast.thirtyDayRunRate)],
      ["projected month-end", money(forecast.projectedMonthEnd)],
      ["confidence", `${(forecast.confidence * 100).toFixed(0)}%`],
    ]),
    "",
    // 目标 slope API 接受单序列：改用对照表承载首末三段趋势，能力等价
    ...renderComparisonTable([
      ["provider", "first third", "last third"],
      ...report.providerSeries
        .toSorted((a, b) => b.cost - a.cost)
        .slice(0, 4)
        .map((series) => {
          const item = trend(series.points.map((point) => point.cost))
          return [series.label, money(item.first), money(item.last)]
        }),
    ]),
  ]
  // driver按费用排序，置信带与方法保留在同一个公开预测页面。
  const endpoint = forecast.points.at(-1)
  lines.splice(
    lines.findIndex((line) => line.includes("provider")),
    0,
    "Forecast drivers",
  )
  lines.push(
    `endpoint confidence band ${endpoint ? `${money(endpoint.lower)}-${money(endpoint.upper)}` : "—"}`,
    "Projection uses only the selected window and observed active-day frequency; month-end uses the latest date's local month.",
  )
  return renderPanel(
    "opencode stats forecast",
    lines.flatMap((line) => (line.includes("\x1b[") ? wrapAnsiVisible(line) : wrapVisible(line))),
  ).join("\n")
}
