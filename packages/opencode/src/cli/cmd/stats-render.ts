
import { renderCompositionDonut, renderPercentStack, renderStreamStackChart, renderWaterfall, renderHistogram } from "./stats-charts"
import type { StatsReport } from "./stats-data"
// #174：render 再导出 formatNumber 方便调用
import { formatNumber } from "../format"
import {
// #174：heatmap 页 cost 密度
  dailyCostPoints,
// #174：timeline 用 dailySeries 生成折线
  dailySeries,
// #174：heatmap 页 token 密度
  dailyTokenPoints,
// #174：fitVisible 保证列对齐
  fitVisible,
// #174：timeline 附加 token 分层堆叠
  layersFromTokenParts,
// #174：矩阵只读报告交叉强度，不发起 select
  modelProviderMatrix,
// #174：paint 按 TTY 着色
  paint,
// #174：callout 分隔页面区块
  renderCallout,
  renderEmptyState,
// #174：密度：只读报告生成终端行，不写库
  renderHeatmap,
  renderMatrix,
// #174：条长相对本页最大值缩放，最大为 0 时不除零
  renderRankBars,
// #174：折线：只读报告生成终端行，不写库
  renderRoundedLineChart,
// #174：堆叠：只读报告生成终端行，不写库
  renderStackedAreaChart,
// #174：宽度取终端列夹逼值，避免负宽或过宽
  statsContentWidth,
} from "./stats-charts"

// #174：ColorMode 仅 auto/always/never
export type ColorMode = "auto" | "always" | "never"
// #174：StatsRenderOptions 收 color/limit/metric/sort
export type StatsRenderOptions = { color?: ColorMode; limit?: number; metric?: "tokens" | "cost"; sort?: "cost" | "tokens" | "calls" | "updated" }

// #174：auto 非 TTY=never
// #174：color=auto 在非 TTY 视为 never，避免管道脏码
// #174：auto 在非 TTY 降为 never 防管道脏码
export const useColor = (mode?: ColorMode) => {
  if (mode === "always") return true
  if (mode === "never") return false
  return Boolean(process.stdout.isTTY)
}

// #174：limit 只 slice
// #174：limit 只 slice 展示行，不改 totals
// #174：limit 只切片列表，totals 不动
export const limitRows = <T,>(rows: T[], limit?: number) => {
  if (limit === undefined || !Number.isFinite(limit)) return rows
  return rows.slice(0, Math.max(0, limit))
}

// #174：header 固定展示关键汇总
const header = (report: StatsReport, title: string) => [
  paint(title, "cyan", undefined, true),
  `sessions=${report.totalSessions} cost=${formatNumber(report.total.cost)} tokens=${formatNumber(report.total.tokens.total)} days=${report.days}`,
  "-".repeat(Math.min(60, statsContentWidth())),
]

// 分组时间序列共用同一图元，保留各模型/供应商身份与完整趋势数据。
const renderUsageSeries = (series: StatsReport["modelSeries"], options: StatsRenderOptions, title: string) =>
  renderRoundedLineChart({
    title,
    series: limitRows(series, options.limit).map((item) => ({
      id: item.id, label: item.label || item.id,
      points: item.points.map((point) => ({ x: point.label, y: options.metric === "cost" ? point.cost : point.tokens.total })),
    })),
  })

// 排名和明细先按同一指标排序再限行，不能从默认费用榜截出 token/calls 的 Top N。
const topGroups = (groups: StatsReport["models"], options: StatsRenderOptions) =>
  limitRows(groups.toSorted((a, b) => {
    if (options.sort === "tokens") return b.tokens.total - a.tokens.total
    if (options.sort === "calls") return b.assistantCalls - a.assistantCalls
    return b.cost - a.cost || b.tokens.total - a.tokens.total
  }), options.limit)

// 分组台账补足排名图省略的计量，模型、供应商和扩展维度复用同一口径。
const renderGroupDetails = (groups: StatsReport["models"], options: StatsRenderOptions) =>
  topGroups(groups, options).flatMap((group) => [
    `${group.label || group.id} cost=${formatNumber(group.cost)} tokens=${formatNumber(group.tokens.total)} calls=${group.assistantCalls} requests=${group.requests} sessions=${group.sessions} $/call=${formatNumber(group.assistantCalls ? group.cost / group.assistantCalls : 0)}`,
    `  input=${formatNumber(group.tokens.input)} output=${formatNumber(group.tokens.output + group.tokens.reasoning)} cacheRead=${formatNumber(group.tokens.cache.read)} cacheWrite=${formatNumber(group.tokens.cache.write)}`,
  ])

// #174：dashboard 固定模型榜后日线
// #174：dashboard 固定先模型榜后日线
export const renderDashboard = (report: StatsReport, options: StatsRenderOptions = {}) =>
  [
    ...header(report, "stats dashboard"),
    ...renderCallout("models", `top ${Math.min(5, report.models.length)}`),
    ...renderRankBars({
      rows: limitRows(report.models, options.limit ?? 5).map((m) => ({ label: m.label || m.id, value: (options.metric ?? "cost") === "cost" ? m.cost : m.tokens.total })),
    }),
    ...renderCallout("daily", "recent"),
    ...renderRoundedLineChart({ series: [dailySeries(report.daily, (d) => ((options.metric ?? "tokens") === "cost" ? d.cost : d.tokens.total))] }),
  ].join("\n")

// #174：overview 含消息/工具与工具榜
export const renderOverview = (report: StatsReport, options: StatsRenderOptions = {}) =>
  [
    ...header(report, "stats overview"),
    `messages=${report.totalMessages} tools=${report.totalTools} medianTokens/session=${formatNumber(report.medianTokensPerSession)}`,
    "tools:",
    ...limitRows(report.toolUsage, options.limit).map((t) => `  ${fitVisible(t.id, 24)} ${t.count}`),
  ].join("\n")

// #174：models 页按 metric 选 cost 或 tokens
export const renderModels = (report: StatsReport, options: StatsRenderOptions = {}) =>
  [
    ...header(report, "stats models"),
    ...renderRankBars({
      rows: topGroups(report.models, options).map((m) => ({ label: m.label || m.id, value: (options.metric ?? "cost") === "cost" ? m.cost : m.tokens.total })),
    }),
    ...renderUsageSeries(report.modelSeries, options, "Model usage over time"),
    ...renderGroupDetails(report.models, options),
  ].join("\n")

// #174：providers 页数据源独立
export const renderProviders = (report: StatsReport, options: StatsRenderOptions = {}) =>
  [
    ...header(report, "stats providers"),
    ...renderRankBars({
      rows: topGroups(report.providers, options).map((p) => ({ label: p.label || p.id, value: (options.metric ?? "cost") === "cost" ? p.cost : p.tokens.total })),
    }),
    ...renderUsageSeries(report.providerSeries, options, "Provider usage over time"),
    ...renderGroupDetails(report.providers, options),
  ].join("\n")

// #174：折线加堆叠非热力命令：只读报告生成终端行，不写库
// #174：timeline 只用折线与堆叠，不承担 heatmap 命令
// #174：时间线只拼折线与堆叠
// #174：renderTimeline 服务时间线折线，不承担 heatmap 命令
export const renderTimeline = (report: StatsReport, options: StatsRenderOptions = {}) =>
  [
    ...header(report, "stats timeline"),
    ...renderRoundedLineChart({ series: [dailySeries(report.daily, (d) => ((options.metric ?? "tokens") === "cost" ? d.cost : d.tokens.total))] }),
    ...renderStackedAreaChart({ daily: report.daily, layers: layersFromTokenParts() }),
  ].join("\n")

// #174：sessions 按 sort 键排序再切片
export const renderSessions = (report: StatsReport, options: StatsRenderOptions = {}) => {
  const sort = options.sort ?? "cost"
  const rows = [...report.sessions].sort((a, b) => {
    if (sort === "tokens") return b.tokens.total - a.tokens.total
    if (sort === "calls") return b.assistantCalls - a.assistantCalls
    if (sort === "updated") return b.updated - a.updated
    return b.cost - a.cost
  })
  return [
    ...header(report, "stats sessions"),
    ...limitRows(rows, options.limit).map((s) => `${fitVisible(s.title || s.id, 28)} cost=${formatNumber(s.cost)} tokens=${formatNumber(s.tokens.total)}`),
  ].join("\n")
}

// #174：charts 拼条形与日线
export const renderCharts = (report: StatsReport, options: StatsRenderOptions = {}) =>
  [
    ...header(report, "stats charts"),
    ...renderRankBars({ rows: limitRows(report.models, options.limit ?? 8).map((m) => ({ label: m.label || m.id, value: m.tokens.total })) }),
    ...renderRoundedLineChart({ series: [dailySeries(report.daily, (d) => d.cost)] }),
    ...renderUsageSeries(report.modelSeries, options, "Model usage over time"),
    ...renderUsageSeries(report.providerSeries, options, "Provider usage over time"),
    ...renderStackedAreaChart({ title: "Token components", daily: report.daily, layers: layersFromTokenParts() }),
    ...renderStreamStackChart({ title: "Model mix over time", daily: report.daily, layers: limitRows(report.modelSeries, options.limit).map((series) => ({ id: series.id, label: series.label || series.id, color: "cyan", value: (day) => { const point = series.points.find((point) => point.day === day.day); return options.metric === "cost" ? point?.cost ?? 0 : point?.tokens.total ?? 0 } })) }),
  ].join("\n")

// #174：双热力加矩阵禁止 timeline 别名
// #174：heatmap 页组合双热力与矩阵，禁止转调 timeline
// #174：页面组合双热力与矩阵，禁止转调 timeline
// #174：renderHeatmapPage 输出密度格/矩阵语义，供 heatmap 命令使用
export const renderHeatmapPage = (report: StatsReport, options: StatsRenderOptions = {}) => {
// #174：matrix 构造 provider×model 交叉表
  const matrix = modelProviderMatrix(report)
  return [
    ...header(report, "stats heatmap"),
    ...renderHeatmap({ title: "Daily tokens", points: dailyTokenPoints(report), color: options.color }),
    ...renderHeatmap({ title: "Daily cost", points: dailyCostPoints(report), color: options.color }),
    ...renderMatrix({ title: "provider x model", ...matrix }),
  ].join("\n")
}

// #174：costs 强制 cost
export const renderCosts = (report: StatsReport, options: StatsRenderOptions = {}) =>
  [
    ...header(report, "stats costs"),
    ...renderRankBars({ rows: limitRows(report.models, options.limit).map((m) => ({ label: m.label || m.id, value: m.cost })) }),
    ...renderRoundedLineChart({ series: [dailySeries(report.daily, (d) => d.cost)] }),
    ...renderWaterfall({ title: "Provider cost waterfall", steps: report.providers.map((provider) => ({ label: provider.label || provider.id, delta: provider.cost })) }),
    ...renderHistogram({ title: "Session cost distribution", values: report.sessions.map((session) => session.cost) }),
  ].join("\n")

// #174：tokens 页先打印 cache 分列
// #174：tokens 页先打印 cache 读写分列
export const renderTokens = (report: StatsReport, options: StatsRenderOptions = {}) =>
  [
    ...header(report, "stats tokens"),
    `input=${formatNumber(report.total.tokens.input)} output=${formatNumber(report.total.tokens.output + report.total.tokens.reasoning)} cacheRead=${formatNumber(report.total.tokens.cache.read)} cacheWrite=${formatNumber(report.total.tokens.cache.write)}`,
    ...renderRankBars({ rows: limitRows(report.models, options.limit).map((m) => ({ label: m.label || m.id, value: m.tokens.total })) }),
    ...renderStackedAreaChart({ title: "Input / output / cache over time", daily: report.daily, layers: layersFromTokenParts() }),
    ...renderPercentStack({ title: "Token share", columns: report.daily.map((day) => ({ label: day.label, parts: layersFromTokenParts().map((layer) => ({ label: layer.label, value: layer.value(day) })) })) }),
    ...renderCompositionDonut({ title: "Top model token share", parts: limitRows(report.models, options.limit).map((model) => ({ label: model.label || model.id, value: model.tokens.total })) }),
  ].join("\n")

export { formatNumber }
