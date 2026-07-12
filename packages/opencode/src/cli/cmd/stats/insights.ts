import type { DailyUsage, StatsReport } from "./data"
import type { ColorMode } from "./render"
import { formatNumber } from "../../format"
import {
  renderComparisonTable,
  renderPanel,
  renderContext,
  statsContentWidth,
  terminalText,
  paint,
  visibleLength,
  wrapVisible,
  type ChartColor,
} from "./charts"
import { renderStatsHeader } from "./render"

export type ForecastPoint = {
  label: string
  value: number
  lower: number
  upper: number
}

export type ForecastReport = {
  // dailyAverage 是活跃日均值，activityRate 是活跃日占比；两者不可混成同一指标。
  dailyAverage: number
  activityRate: number
  weeklyRunRate: number
  // 该字段固定表示 30 个日历日；自然月长度只允许影响 projectedMonthEnd。
  thirtyDayRunRate: number
  projectedMonthEnd: number
  confidence: number
  points: ForecastPoint[]
}

type Trend = {
  first: number
  last: number
  ratio: number
}

type Efficiency = {
  cacheReadShare: number
  costPerMillionTokens: number
  tokensPerDollar: number
}

const money = (value: number) => {
  // 0 可能是免费，也可能是价格缺失；派生分析统一显示不可用而不是伪造 `$0.00` 精度。
  if (!Number.isFinite(value) || value <= 0) return "—"
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

const percentile = (values: number[], p: number) => {
  // 小样本采用最近秩，避免插值制造数据库中不存在的会话费用。
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
  // 比较首尾各三分之一可降低单日尖峰影响，同时保持实现可解释。
  const filtered = values.filter(Number.isFinite)
  if (filtered.length === 0) return { first: 0, last: 0, ratio: 0 }
  const split = Math.max(1, Math.floor(filtered.length / 3))
  const first = average(filtered.slice(0, split))
  const last = average(filtered.slice(-split))
  return { first, last, ratio: first === 0 ? (last > 0 ? 1 : 0) : (last - first) / first }
}

const dailyValues = (daily: DailyUsage[], metric: "tokens" | "cost") =>
  daily.map((item) => (metric === "cost" ? item.cost : item.tokens.total))

const efficiency = (report: StatsReport): Efficiency => {
  // 效率指标统一以 report 总量为分母，不能从格式化后的字符串反推。
  const total = report.total.tokens.total
  return {
    cacheReadShare: safeDivide(report.total.tokens.cache.read, total),
    // 数值层仍返回有限 0，是否“不可用”由 renderer 根据 total cost 明确标注。
    costPerMillionTokens: safeDivide(report.total.cost, total) * 1_000_000,
    tokensPerDollar: safeDivide(total, report.total.cost),
  }
}

export function buildForecast(report: StatsReport): ForecastReport {
  // 预测只使用当前已选窗口，不暗中加载 all-time 数据，保持命令范围可预期。
  const costs = dailyValues(report.daily, "cost")
  const activeCosts = costs.filter((value) => value > 0)
  // 活跃日均值描述单次使用强度，活跃率描述使用频率；月度预测需要两者相乘。
  // 这可避免稀疏用户的一次高费用被外推成每日持续费用。
  const dailyAverage = average(activeCosts)
  const activityRate = safeDivide(activeCosts.length, costs.length)
  const calendarDailyAverage = dailyAverage * activityRate
  const activeSigma = stddev(activeCosts)
  // 将“当天是否活跃”的伯努利波动和活跃日费用波动合并，避免稀疏使用被误报为稳定。
  // 该方差用于置信带，不能只用 activeCosts 的标准差，否则大量零日会被忽略。
  const calendarSigma = Math.sqrt(Math.max(0, activityRate * (activeSigma ** 2 + dailyAverage ** 2) - calendarDailyAverage ** 2))
  const anchor = new Date(report.dateRange.latest || Date.now())
  // 月份边界按本地自然日计算，与 data.ts 的 bucket 口径保持一致。
  const year = anchor.getFullYear()
  const month = anchor.getMonth()
  const dayOfMonth = anchor.getDate()
  const daysInMonth = new Date(year, month + 1, 0).getDate()
  const remainingDays = Math.max(0, daysInMonth - dayOfMonth)
  // 月末投影只能以当前自然月的已发生费用为基线；选择区间可能跨月，不能把
  // 整个 report.total.cost 误当成 month-to-date。均值和波动也统一使用活跃日。
  // 历史窗口的 latest 仍作为锚点，因此查看旧月份不会掺入当前系统日期。
  const monthToDate = sum(report.daily.filter((day) => {
    const date = new Date(day.day)
    return date.getFullYear() === year && date.getMonth() === month && day.day <= report.dateRange.latest
  }).map((day) => day.cost))
  const projectedMonthEnd = monthToDate + calendarDailyAverage * remainingDays
  const confidence = calendarDailyAverage > 0 ? clampConfidence(1 - safeDivide(calendarSigma, calendarDailyAverage * 2)) : 0
  const points = Array.from({ length: remainingDays + 1 }, (_, index) => {
    const value = monthToDate + calendarDailyAverage * index
    return {
      label: index === 0 ? "now" : `+${index}d`,
      value,
      lower: Math.max(0, value - calendarSigma * Math.sqrt(index)),
      upper: value + calendarSigma * Math.sqrt(index),
    }
  })
  return {
    dailyAverage,
    activityRate,
    weeklyRunRate: calendarDailyAverage * 7,
    // 30-day run rate 使用固定窗口；自然月天数只参与独立的 month-end 投影。
    thirtyDayRunRate: calendarDailyAverage * 30,
    projectedMonthEnd,
    confidence,
    points,
  }
}

function clampConfidence(value: number) {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(1, value))
}

const sparkline = (values: number[], width: number, color: ChartColor, colorMode?: ColorMode) => {
  // sparkline 只表达相对形状，精确总量必须由同一行的数值字段补充。
  const ctx = renderContext(colorMode)
  const chars = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"]
  const max = Math.max(0, ...values.filter(Number.isFinite))
  return Array.from({ length: width }, (_, index) => {
    const value = values.length === 0 ? 0 : values[Math.round((index / Math.max(1, width - 1)) * (values.length - 1))] ?? 0
    return paint(chars[max <= 0 ? 0 : Math.min(chars.length - 1, Math.floor((value / max) * (chars.length - 1)))], color, ctx)
  }).join("")
}

const renderResponsiveTable = (input: { title: string; headers: string[]; rows: string[][]; color?: ColorMode }) => {
  // 120 列优先表格比较；窄屏退化为完整 key/value 行，绝不截断实体名。
  // 两条路径共享 rows 输入，响应式变化不会改变统计结论。
  const ctx = renderContext(input.color)
  const width = statsContentWidth()
  // Insights 表格同样会展示持久化实体名，必须在加入受信 ANSI 样式前清除控制字节。
  const rows = input.rows.map((row) => row.map(terminalText))
  const table = renderComparisonTable({ ...input, rows })
  // 只有全宽 section divider 需要留白，Forecast drivers 等局部表题仍应紧邻表头。
  const sectionGap = input.title.startsWith("━━━") ? [""] : []
  if (width >= 100 && table.every((line) => visibleLength(line) <= width)) return [table[0], ...sectionGap, ...table.slice(1)]
  return [
    ...wrapVisible(input.title, width).map((line) => paint(line, "title", ctx, true)),
    ...sectionGap,
    ...rows.flatMap((row) => wrapVisible(input.headers.map((header, index) => `${header} ${row[index] ?? "—"}`).join(" · "), width)
      .map((line) => paint(line, "white", ctx))),
  ]
}

const sectionTitle = (label: string) => {
  // Insights 与其他详细页共享全宽章节节奏；标题本身仍是纯文本，主题只负责前景语义色。
  const prefix = `━━━ ${label} `
  return `${prefix}${"─".repeat(Math.max(0, statsContentWidth() - visibleLength(prefix)))}`
}

const compositionLines = (input: {
  label: string
  parts: { label: string; value: number; color: ChartColor }[]
  total: number
  color?: ColorMode
}) => {
  // 组成条按累计占比分配字符；全零总量必须保持空条，不能虚构第一段颜色。
  const ctx = renderContext(input.color)
  const width = statsContentWidth()
  const barWidth = Math.max(8, Math.min(32, width - 24))
  const cumulative = input.parts.reduce<number[]>((values, part) => [...values, (values.at(-1) ?? 0) + part.value], [])
  const bar = Array.from({ length: barWidth }, (_, index) => {
    const value = ((index + 0.5) / barWidth) * input.total
    const part = input.total > 0 ? input.parts[cumulative.findIndex((end) => value <= end)] ?? input.parts.at(-1) : undefined
    return part ? paint("█", part.color, ctx) : " "
  }).join("")
  const legend = input.parts.map((part) => `${part.label} ${percent(part.value, input.total)}`).join(" · ")
  return [
    `${paint(input.label, "subtitle", ctx, true)}  ${bar}  ${paint(formatNumber(input.total), "white", ctx, true)}`,
    ...wrapVisible(legend, width).map((line) => paint(line, "muted", ctx)),
  ]
}

const renderUsageShape = (report: StatsReport, color?: ColorMode) => {
  // Usage shape 回答“token 花在哪里”，不重复 Dashboard 已展示的总费用和请求数。
  const ctx = renderContext(color)
  const inputParts = [
    { label: "system", value: report.total.components.system, color: "purple" as const },
    { label: "instructions", value: report.total.components.instructions, color: "pink" as const },
    { label: "skills", value: report.total.components.skills, color: "green" as const },
    { label: "schemas", value: report.total.components.toolSchemas, color: "yellow" as const },
    { label: "user", value: report.total.components.userMessages, color: "blue" as const },
    { label: "assistant", value: report.total.components.assistantText, color: "green" as const },
    { label: "reasoning", value: report.total.components.reasoning, color: "purple" as const },
    { label: "tool calls", value: report.total.components.toolCalls, color: "yellow" as const },
    { label: "tool results", value: report.total.components.toolResults, color: "cyan" as const },
    { label: "attach", value: report.total.components.attachments, color: "muted" as const },
  ]
  // 十类由同一个 input denominator 直接闭合，不能预先合并后再用 other 隐藏归因信息。
  const inputTotal = sum(inputParts.map((part) => part.value))
  const item = efficiency(report)
  return [
    paint(sectionTitle("Usage shape"), "title", ctx, true),
    "",
    ...compositionLines({
      label: "tokens",
      parts: [
        { label: "input", value: report.total.tokens.input, color: "blue" },
        { label: "output", value: report.total.tokens.output + report.total.tokens.reasoning, color: "green" },
        { label: "cache read", value: report.total.tokens.cache.read, color: "yellow" },
        { label: "cache write", value: report.total.tokens.cache.write, color: "purple" },
      ],
      total: report.total.tokens.total,
      color,
    }),
    ...(inputTotal > 0 ? compositionLines({ label: "input", parts: inputParts, total: inputTotal, color }) : []),
    // cost/M 与 tok/$ 必须成对可用；单位靠近数值，避免把美元/Token 的方向读反。
    ...wrapVisible(`efficiency ${report.total.cost > 0 ? `${money(item.costPerMillionTokens)}/M tok · ${formatNumber(item.tokensPerDollar)} tok/$` : "cost/M — · tok/$ —"} · ${percent(item.cacheReadShare, 1)} cache read · ${safeDivide(report.total.assistantCalls, report.total.requests).toFixed(1)} calls/request`, statsContentWidth())
      .map((line) => paint(line, "subtitle", ctx)),
  ]
}

const attributionRows = (report: StatsReport) => [
  // 每个归因维度只保留 leader 一行，便于横向比较集中度，而不是复制六张排名表。
  { dimension: "model", groups: report.models, series: report.modelSeries },
  { dimension: "provider", groups: report.providers, series: report.providerSeries },
  { dimension: "agent", groups: report.agents, series: report.agentSeries },
  { dimension: "source", groups: report.sources, series: report.sourceSeries },
  { dimension: "project", groups: report.projects, series: report.projectSeries },
  // unattributed 没有 owning request outcome，不能与 completed/error 等状态竞争 leader。
  { dimension: "status", groups: report.statuses.filter((group) => group.id !== "unattributed"), series: report.statusSeries },
].map((entry) => {
  // leader 以 token 量定义，费用变化和失败率作为独立透视列，避免单指标结论。
  const leader = [...entry.groups].sort((a, b) => b.tokens.total - a.tokens.total)[0]
  const series = entry.series.find((item) => item.id === leader?.id)
  const item = trend(series?.points.map((point) => point.cost) ?? [])
  return [
    entry.dimension,
    terminalText(leader?.label ?? "—"),
    leader ? percent(leader.tokens.total, report.total.tokens.total) : "0.0%",
    leader ? money(leader.cost) : "—",
    `${item.ratio >= 0 ? "+" : ""}${(item.ratio * 100).toFixed(1)}%`,
    leader ? percent(leader.errors + leader.aborted, leader.requests) : "0.0%",
  ]
})

const renderDailyAndSessions = (report: StatsReport, color?: ColorMode) => {
  // 时间波动与会话离群各占一条摘要，不使用大段判断性 prose。
  const ctx = renderContext(color)
  const width = statsContentWidth()
  const dailyCosts = dailyValues(report.daily, "cost")
  const avg = average(dailyCosts)
  const p95 = percentile(dailyCosts, 95)
  const peak = Math.max(0, ...dailyCosts)
  const volatility = safeDivide(stddev(dailyCosts), avg)
  // 零费用既可能免费也可能缺价格，只允许正费用样本进入费用分位数。
  const costs = report.sessions.map((session) => session.cost).filter((value) => value > 0)
  const sessionP50 = percentile(costs, 50)
  const sessionP95 = percentile(costs, 95)
  const top = [...report.sessions].filter((session) => session.cost > 0).sort((a, b) => b.cost - a.cost || b.tokens.total - a.tokens.total)[0]
  const topTokenShare = safeDivide(sum([...report.sessions].sort((a, b) => b.tokens.total - a.tokens.total).slice(0, 2).map((session) => session.tokens.total)), report.total.tokens.total)
  const tokenSummary = `Session tokens mean ${formatNumber(report.tokensPerSession)} · median ${formatNumber(report.medianTokensPerSession)} · mean/median ${safeDivide(report.tokensPerSession, report.medianTokensPerSession).toFixed(1)}x · top 2 share ${percent(topTokenShare, 1)}`
  if (report.total.cost <= 0) {
    // 无正费用时仍保留 token 长尾事实，但不能把零值计算成费用分位数或离群程度。
    const tokens = report.sessions.map((session) => session.tokens.total)
    return [
      // 明确保留 Token 分布，避免用户把“无费用记录”误解为“无使用记录”。
      paint("Daily cost unavailable · no positive cost recorded in this range.", "muted", ctx),
      ...wrapVisible(`Session token distribution · p50 ${formatNumber(percentile(tokens, 50))} · p95 ${formatNumber(percentile(tokens, 95))} · max ${formatNumber(Math.max(0, ...tokens))}`, width).map((line) => paint(line, "subtitle", ctx, true)),
      ...wrapVisible(tokenSummary, width).map((line) => paint(line, "subtitle", ctx, true)),
    ]
  }
  // CV、p95 和 skew 都保留原始数值，用户可以自行判断而非接受机械结论。
  const daily = `Daily cost ${sparkline(dailyCosts, Math.max(8, Math.min(32, width - 68)), "pink", color)}`
  const dailySummary = `avg ${money(avg)} · p95 ${money(p95)} · peak ${money(peak)} · coefficient of variation ${(volatility * 100).toFixed(0)}% · active ${dailyCosts.filter((value) => value > 0).length}/${dailyCosts.length} days`
  const sessions = costs.length > 0
    ? `Session cost p50 ${money(sessionP50)} · p95 ${money(sessionP95)} · max ${money(top?.cost ?? 0)} · max/p95 ${safeDivide(top?.cost ?? 0, sessionP95).toFixed(1)}x`
    : "Session cost unavailable · no positive Session cost recorded in this range."
  return [
    ...wrapVisible(daily, width).map((line) => paint(line, "subtitle", ctx, true)),
    ...wrapVisible(dailySummary, width).map((line) => paint(line, "subtitle", ctx, true)),
    ...wrapVisible(sessions, width).map((line) => paint(line, "subtitle", ctx, true)),
    ...wrapVisible(tokenSummary, width).map((line) => paint(line, "subtitle", ctx, true)),
    ...(top ? wrapVisible(`Top session: ${terminalText(top.title || top.id)}`, width).map((line) => paint(line, "muted", ctx)) : []),
  ]
}

const renderActions = (report: StatsReport, color?: ColorMode) => {
  // Actions 只在可量化阈值越界时出现，并把观测值与阈值同时展示。
  // 没有触发项时显示明确空态，而不是生成泛化建议填充页面。
  const ctx = renderContext(color)
  const model = report.models[0]
  const provider = report.providers[0]
  const sessionCosts = report.sessions.map((session) => session.cost).filter((value) => value > 0)
  const p95 = percentile(sessionCosts, 95)
  const topSession = [...report.sessions].sort((a, b) => b.cost - a.cost)[0]
  const failure = safeDivide(report.total.errors + report.total.aborted, report.total.requests)
  const actions = [
    // 集中度阈值用于提示进一步检查，不把“集中”直接描述为错误或安全风险。
    ...(model && safeDivide(model.tokens.total, report.total.tokens.total) > 0.55
      ? [`Model ${terminalText(model.label)} share ${percent(model.tokens.total, report.total.tokens.total)} > 55% · inspect breakdown model`]
      : []),
    ...(provider && safeDivide(provider.tokens.total, report.total.tokens.total) > 0.55
      ? [`Provider ${terminalText(provider.label)} share ${percent(provider.tokens.total, report.total.tokens.total)} > 55% · inspect breakdown provider`]
      : []),
    // cost 为 0 时条件自然不触发，不能生成基于缺失价格的费用离群行动项。
    ...(topSession && topSession.cost > p95 * 1.5
      // 会话离群必须同时超过 p95 的 1.5 倍，避免小样本中最高值必然触发。
      ? [`Session ${terminalText(topSession.title || topSession.id)} costs ${money(topSession.cost)} vs p95 ${money(p95)} · inspect sessions --sort cost`]
      : []),
    ...(failure > 0.02
      ? [`Failure rate ${percent(report.total.errors + report.total.aborted, report.total.requests)} > 2% · inspect breakdown status`]
      : []),
    // cache 阈值只有在 Assistant Token 分母存在时才有意义；Tool-only 数据不代表 0% cache。
    ...(report.total.tokens.total > 0 && safeDivide(report.total.tokens.cache.read, report.total.tokens.total) < 0.2
      ? [`Cache read ${percent(report.total.tokens.cache.read, report.total.tokens.total)} < 20% · compare reusable prompt prefixes`]
      : []),
  ].slice(0, 3)
  // 最多三项可操作信号，防止 Insights 退化成长篇建议清单。
  return [
    paint(sectionTitle("Actions"), "title", ctx, true),
    "",
    ...(actions.length
      ? actions.flatMap((action) => wrapVisible(`! ${action}`, statsContentWidth()).map((line) => paint(line, "yellow", ctx)))
      : [paint("No material threshold crossings in this range.", "muted", ctx)]),
  ]
}

const renderForecast = (report: StatsReport, color?: ColorMode) => {
  // Forecast 是显式扩展区，默认 Insights 不应混入预测性内容。
  const ctx = renderContext(color)
  const width = statsContentWidth()
  if (report.total.cost <= 0) {
    // Forecast 依赖正费用观测，不能把全零序列外推成“稳定的 $0 预测”。
    return [
      paint("Forecast", "title", ctx, true),
      paint("Forecast unavailable: no positive cost recorded in the selected range.", "muted", ctx),
    ]
  }
  const forecast = buildForecast(report)
  const endpoint = forecast.points.at(-1)
  // 30-day 与 month-end 并列展示但不可互换：前者便于跨月份比较，后者回答当前月落点。
  const summary = `active-day avg ${money(forecast.dailyAverage)} · active ${percent(forecast.activityRate, 1)} · weekly ${money(forecast.weeklyRunRate)} · 30-day ${money(forecast.thirtyDayRunRate)} · projected month-end ${money(forecast.projectedMonthEnd)} · stability ${(forecast.confidence * 100).toFixed(0)}%`
  const band = endpoint ? `endpoint confidence band ${money(endpoint.lower)}-${money(endpoint.upper)}` : "endpoint confidence band —"
  // Forecast driver 按费用而非上游 Token 排名，避免高 Token 免费路由挤掉真实费用变化来源。
  const drivers = [...report.providerSeries].sort((a, b) => b.cost - a.cost).slice(0, 4).map((series) => {
    // driver 使用首尾窗口日均对比，和 Attribution 的趋势定义保持一致。
    const item = trend(series.points.map((point) => point.cost))
    return [terminalText(series.label), money(item.first), money(item.last), `${item.ratio >= 0 ? "+" : ""}${(item.ratio * 100).toFixed(1)}%`]
  })
  return [
    paint(sectionTitle("Forecast · observed activity run rate"), "title", ctx, true),
    "",
    ...wrapVisible(summary, width).map((line) => paint(line, "subtitle", ctx)),
    `${paint("observed", "muted", ctx)} ${sparkline(dailyValues(report.daily, "cost"), Math.max(8, Math.min(28, width - 12)), "pink", color)}`,
    `${paint("projected", "muted", ctx)} ${sparkline(forecast.points.map((point) => point.value), Math.max(8, Math.min(28, width - 13)), "purple", color)}`,
    ...wrapVisible(band, width).map((line) => paint(line, "muted", ctx)),
    ...renderResponsiveTable({ title: "Forecast drivers", headers: ["provider", "early/day", "recent/day", "Δ"], rows: drivers, color }),
    ...wrapVisible("Projection uses only the selected window and observed active-day frequency; month-end uses the latest date's local month.", width).map((line) => paint(line, "muted", ctx)),
  ]
}

export function renderInsights(report: StatsReport, options: { color?: ColorMode; forecast?: boolean } = {}) {
  // 页面顺序从组成、归因到波动和动作，保持“事实先于建议”的阅读路径。
  // 该顺序还让 Forecast 作为可选附录出现，不干扰默认分析主线。
  // 与其他页面相同，Tool-only 部分数据不属于全空报告；Session 数本身也不构成 usage。
  const hasUsage = report.total.tokens.total > 0 || report.total.cost > 0 || report.total.requests > 0 || report.total.assistantCalls > 0 || report.toolUsage.some((tool) => tool.count > 0 || tool.contextTokens > 0)
  if (!hasUsage) {
    // 统一在共享 header 后结束，Insights 不应对零值生成趋势、阈值或 Forecast。
    return renderPanel({
      lines: [...renderStatsHeader(report, options, "insights"), "No usage data for the selected range."],
      color: options.color,
    })
  }
  const lines = [
    ...renderStatsHeader(report, options, "insights"),
    ...renderUsageShape(report, options.color),
    "",
    ...renderResponsiveTable({
      title: sectionTitle("Attribution"),
      headers: ["dimension", "leader", "token share", "cost", "recent cost change", "owner fail"],
      rows: attributionRows(report),
      color: options.color,
    }),
    ...(report.statuses.find((group) => group.id === "unattributed" && group.tokens.total > 0)
      ? wrapVisible(`Status leader excludes unattributed usage; ${formatNumber(report.statuses.find((group) => group.id === "unattributed")?.tokens.total ?? 0)} tokens without request outcome are reported separately.`, statsContentWidth()).map((line) => paint(line, "muted", renderContext(options.color)))
      : []),
    "",
    paint(sectionTitle("Variability & outliers"), "title", renderContext(options.color), true),
    "",
    ...renderDailyAndSessions(report, options.color),
    "",
    ...renderActions(report, options.color),
    // 未显式请求 forecast 时不计算或渲染预测，避免默认页面增加噪声。
    // 显式 forecast 仍经过正费用保护；默认路径完全不计算预测。
    ...(options.forecast ? ["", ...renderForecast(report, options.color)] : []),
  ]
  return renderPanel({ lines, color: options.color })
}
