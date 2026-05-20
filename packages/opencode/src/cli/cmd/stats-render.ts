
import { renderCompositionDonut, renderPercentStack, renderStreamStackChart, renderWaterfall, renderHistogram } from "./stats-charts"
import type { StatsReport } from "./stats-data"
import { emptyComponents } from "./stats-data"
// #174：render 再导出 formatNumber 方便调用
import { formatNumber } from "../format"
import {
  dailyCostPoints,
  dailySeries,
  dailyTokenPoints,
  fitVisible,
  layersFromTokenParts,
  modelProviderMatrix,
  paint,
  renderCallout,
  renderEmptyState,
  renderHeatmap,
  renderMatrix,
  renderRankBars,
  renderRoundedLineChart,
  renderStackedAreaChart,
  statsContentWidth,
  sparkline,
  visibleLength,
  truncateVisible,
} from "./stats-charts"

// #174：ColorMode 仅 auto/always/never
export type ColorMode = "auto" | "always" | "never"
// #174：StatsRenderOptions 收 color/limit/metric/sort
export type BreakdownDimension = "model" | "provider" | "agent" | "source" | "project" | "tool" | "status"

// #176：渲染选项含 by/heatmap
export type StatsRenderOptions = {
  color?: ColorMode
  limit?: number
  metric?: "tokens" | "cost"
  sort?: "cost" | "tokens" | "calls" | "updated"
  by?: BreakdownDimension
  heatmap?: boolean
}

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
    // 默认 token 与显式 cost/calls 共用选择器，所有榜单和台账在限行前取得同一排序。
    if (options.sort === "cost") return b.cost - a.cost || b.tokens.total - a.tokens.total
    if (options.sort === "calls") return b.assistantCalls - a.assistantCalls || b.tokens.total - a.tokens.total
    return b.tokens.total - a.tokens.total || b.cost - a.cost
  }), options.limit)

// 分组台账补足排名图省略的计量，模型、供应商和扩展维度复用同一口径。
const renderGroupDetails = (groups: StatsReport["models"], options: StatsRenderOptions) =>
  topGroups(groups, options).flatMap((group) => [
    `${group.label || group.id} cost=${formatNumber(group.cost)} tokens=${formatNumber(group.tokens.total)} calls=${group.assistantCalls} requests=${group.requests} sessions=${group.sessions} $/call=${formatNumber(group.assistantCalls ? group.cost / group.assistantCalls : 0)}`,
    `  input=${formatNumber(group.tokens.input)} output=${formatNumber(group.tokens.output + group.tokens.reasoning)} cacheRead=${formatNumber(group.tokens.cache.read)} cacheWrite=${formatNumber(group.tokens.cache.write)}`,
  ])

// #174：dashboard 固定模型榜后日线
// #174：dashboard 固定先模型榜后日线

// #176：按维度输出归因表/条形图
export const renderBreakdown = (report: StatsReport, options: StatsRenderOptions = {}) => {
  // #176：默认按 model 归因
  const by = options.by ?? "model"
  const metric = options.metric ?? "tokens"
  const groups =
    by === "provider"
      ? report.providers
      : by === "agent"
        ? report.agents ?? []
        : by === "source"
          ? report.sources ?? []
          : by === "project"
            ? report.projects ?? []
            : by === "status"
              ? report.statuses ?? []
              : by === "tool"
                ? (report.toolUsage ?? []).map((tool) => ({
                    id: tool.id,
                    label: tool.id,
                    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 }, total: tool.contextTokens },
                    cost: 0,
                    requests: tool.count,
                    assistantCalls: 0,
                    // #176：合成行补齐用量契约字段，与 UsageGroup 联合类型对齐
                    components: emptyComponents(),
                    errors: 0,
                    aborted: 0,
                    durationMs: 0,
                    sessions: 0,
                    providers: [],
                    models: [],
                  }))
                : report.models

  const rows = (by === "tool" ? limitRows(groups, options.limit) : topGroups(groups, options)).map((group) => {
    const value = metric === "cost" ? group.cost : group.tokens.total
    return { label: group.label || group.id, value }
  })
  const lines = [
    `Breakdown by ${by} (${metric})`,
    ...renderRankBars({ title: `${by} ranking`, rows }),
  ]
    // #176：tool 维附加 context/count/IO 明细
  if (by === "tool") {
    // #177：tool breakdown 主路径展示 context 时间序列
    if ((report.toolSeries?.length ?? 0) > 0) {
      lines.push("")
      lines.push(
        ...renderRoundedLineChart({
          // #177：固定标题供测试与 UI 契约锁定
          title: "Tool context tokens over time",
          series: (report.toolSeries ?? []).slice(0, options.limit ?? 5).map((s) => ({
            id: s.id,
            label: s.label || s.id,
            points: s.points.map((p) => ({ x: p.label, y: p.tokens.total })),
          })),
        }),
      )
    }
    lines.push("")
    lines.push("Tool context tokens / counts")
    for (const tool of limitRows(report.toolUsage ?? [], options.limit)) {
      lines.push(
        `  ${tool.id.padEnd(24)} ctx=${tool.contextTokens} count=${tool.count} in=${tool.inputChars} out=${tool.outputChars}`,
      )
    }
  }
  if (by !== "tool") {
    // 数据层的各维度序列与输入组件必须有实际输出入口，不能只保留在报告对象中。
    const series = { model: report.modelSeries, provider: report.providerSeries, agent: report.agentSeries, source: report.sourceSeries, project: report.projectSeries, status: report.statusSeries }[by]
    lines.push("", ...renderUsageSeries(series, options, `${by} usage over time`))
    lines.push(...renderGroupDetails(groups, options))
    if (by === "source") {
      lines.push("Input components by source")
      for (const group of topGroups(groups, options)) {
        lines.push(`  ${group.label || group.id} ${Object.entries(group.components).map(([key, value]) => `${key}=${formatNumber(value)}`).join(" ")}`)
      }
    }
  }
    // #181：只返回本表行，由 dashboard 负责段间距
  return lines.join("\n")
}


// #181：金额短格式
// #181：仪表盘顶表金额短显示
const money = (value: number) => {
  if (!Number.isFinite(value) || value <= 0) return "$0"
  if (value >= 10) return `$${value.toFixed(0)}`
  if (value >= 1) return `$${value.toFixed(2)}`
  return `$${value.toFixed(4)}`
}

// #181：把 UsageGroup 列表收成 top-N 行
// #181：limit 后的分组投影，供顶表复用
const dashboardTopRows = (groups: StatsReport["models"], limit: number) =>
  topGroups(groups, { limit, sort: "tokens" }).map((g) => ({
    id: g.id,
    label: g.label || g.id,
    tokens: g.tokens.total,
    cost: g.cost,
    calls: g.assistantCalls,
  }))

// #181：响应式顶表：指标固定，趋势列随终端宽度伸缩/折叠
// #181：单列顶表：指标+可选 trend，替代双栏+activity
const dashboardTopTable = (
  title: string,
  groups: StatsReport["models"],
  series: StatsReport["modelSeries"],
  options: StatsRenderOptions,
  kind: "model" | "provider",
  // #181：share 分母用全局 total.tokens.total，禁止 top-N 重归一化
  globalTokenTotal: number,
) => {
    // #181：内容宽取自 tip charts 统一口径
  const content = statsContentWidth()
    // #181：空表仍保留标题，避免布局塌陷误判
  const rows = dashboardTopRows(groups, options.limit ?? 5)
  if (rows.length === 0) return [`▸ ${title}`, "  (empty)"]
    // #181：share 分母至少为 1，避免 NaN%
  const totalTokens = Math.max(1, globalTokenTotal)
    // #181：model 标签地板更宽，provider 稍窄
  const labelFloor = kind === "model" ? 18 : 16
    // #181：标签上限防止挤掉指标列
  const labelCap = kind === "model" ? 28 : 26
  // metrics 形如 " $12  1.2M  3  40% " 约 28 列预算
  // #181：右侧指标列预算，剩余给 label/trend
  const metricsBudget = 28
    // #181：先扣指标与 gutter 再谈 trend
  const trendRoom = content - metricsBudget - 15 - labelFloor
  // #181：小于 6 列不画 trend，避免碎裂
    // #181：trend 要么够 6 列要么为 0
  const trendWidth = trendRoom < 6 ? 0 : Math.min(24, trendRoom)
  // #181：label 在 floor/cap 间吃掉剩余宽度
  const labelWidth = Math.max(labelFloor, Math.min(labelCap, content - metricsBudget - 15 - trendWidth))
  const lines = [`▸ ${title}`]
    // #181：宽屏表头带 share│trend，窄屏去掉 trend
  const head =
    trendWidth > 0
      ? `  ${fitVisible("name", labelWidth)} ${fitVisible("cost", 8)} ${fitVisible("tokens", 8)} ${fitVisible("calls", 5)} share │ trend`
      : `  ${fitVisible("name", labelWidth)} ${fitVisible("cost", 8)} ${fitVisible("tokens", 8)} ${fitVisible("calls", 5)} share`
  lines.push(head)
  for (const row of rows) {
    // #181：share 相对本表 tokens 合计
    const share = `${Math.round((row.tokens / totalTokens) * 100)}%`
    // #181：按 id 对齐 series 点列
    const seriesPoints = series.find((s) => s.id === row.id)?.points ?? []
    const values = seriesPoints.map((p) => p.tokens.total)
        // #181：无点列时 sparkline 返回空串
    const trend = trendWidth > 0 ? sparkline(values, trendWidth) : ""
        // #181：标签按显示列截断，保留 CJK 语义
    const label = truncateVisible(row.label, labelWidth)
        // #181：行体固定指标槽位，便于扫读对齐
    const base = `  ${fitVisible(label, labelWidth)} ${fitVisible(money(row.cost), 8)} ${fitVisible(formatNumber(row.tokens), 8)} ${fitVisible(formatNumber(row.calls), 5)} ${fitVisible(share, 5)}`
        // #181：trend 用 │ 与 share 分隔
    lines.push(trendWidth > 0 ? `${base} │ ${trend}` : base)
  }
  // #181：禁止再单独挂 Model/Provider activity rows
  return lines
}

export const renderDashboard = (report: StatsReport, options: StatsRenderOptions = {}) => {
  // #181：顶表吸收 activity/trend，不再并排 Top models|providers + 独立 activity 区
    // #181：models 与 providers 纵向堆叠，不再 two-column
  const body = [
    ...header(report, "stats dashboard"),
        // #181：models 表绑定 modelSeries 趋势
    // #176：失败/中止请求存在时置顶提示（#176 契约在 #181 顶表重写后保留）
    ...(report.total.errors + report.total.aborted > 0 ? [`requests failed=${report.total.errors} aborted=${report.total.aborted}`] : []),
    ...dashboardTopTable("Top models", report.models, report.modelSeries, options, "model", report.total.tokens.total),
    "",
        // #181：providers 表绑定 providerSeries 趋势
    ...dashboardTopTable("Top providers", report.providers, report.providerSeries, options, "provider", report.total.tokens.total),
    ...renderCallout("daily", "recent"),
    ...renderRoundedLineChart({ series: [dailySeries(report.daily, (d) => ((options.metric ?? "tokens") === "cost" ? d.cost : d.tokens.total))] }),
  ]
    // #181：整页一次 join，保持段间空行
  return body.join("\n")
}


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
    // 每日结局与时长来自同一报告，保留错误/中止集中日期的诊断能力。
    ...report.daily.map((day) => `${day.label} completed=${Math.max(0, day.requests - day.errors - day.aborted)} error=${day.errors} aborted=${day.aborted} avg=${Math.round(day.durationMs / Math.max(1, day.requests))}ms`),
  ].join("\n")

// #174：sessions 按 sort 键排序再切片
// #177：sessions 默认 tokens 排序
export const renderSessions = (report: StatsReport, options: StatsRenderOptions = {}) => {
  const sort = options.sort ?? "tokens"
  const rows = [...report.sessions].sort((a, b) => {
    if (sort === "tokens") return b.tokens.total - a.tokens.total
    if (sort === "calls") return b.assistantCalls - a.assistantCalls
    if (sort === "updated") return b.updated - a.updated
    return b.cost - a.cost
  })
  return [
    ...header(report, "stats sessions"),
    ...limitRows(rows, options.limit).map((s) => `${fitVisible(s.title || s.id, 28)} cost=${formatNumber(s.cost)} tokens=${formatNumber(s.tokens.total)} avg=${Math.round(s.durationMs / Math.max(1, s.requests))}ms`),
  ].join("\n")
}

// #174：charts 拼条形与日线
// #177：charts 页附加 tool context 时间序列
export const renderCharts = (report: StatsReport, options: StatsRenderOptions = {}) =>
  [
    ...header(report, "stats charts"),
    // #177：charts 主路径组合 tool context 时间序列
    ...((report.toolSeries?.length ?? 0) > 0
      ? renderRoundedLineChart({
          // #177：固定标题供测试与 UI 契约锁定
          title: "Tool context tokens over time",
          series: (report.toolSeries ?? []).slice(0, options.limit ?? 5).map((s) => ({
            id: s.id,
            label: s.label || s.id,
            points: s.points.map((p) => ({ x: p.label, y: p.tokens.total })),
          })),
        })
      : []),
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
    ...renderRankBars({
      // #177：显式 cost 先排序再限行，默认沿用 tokens 榜
      rows: limitRows(
        options.sort === "cost" ? [...report.models].sort((a, b) => b.cost - a.cost || b.tokens.total - a.tokens.total) : options.sort === "calls" ? [...report.models].sort((a, b) => b.assistantCalls - a.assistantCalls) : report.models,
        options.limit,
      ).map((m) => ({ label: m.label || m.id, value: m.cost })),
    }),
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


// #177：独立导出工具上下文时间序列块，供 charts/dashboard 组合
export const renderToolSeries = (report: StatsReport, options: StatsRenderOptions = {}) => {
  if (!report.toolSeries?.length) return ""
  return renderRoundedLineChart({
    title: "Tool context tokens over time",
    series: report.toolSeries.slice(0, options.limit ?? 5).map((s) => ({
      id: s.id,
      label: s.label || s.id,
      points: s.points.map((p) => ({ x: p.label, y: p.tokens.total })),
    })),
  }).join("\n")
}
