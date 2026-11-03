import { renderTwoColumn, renderThreeColumn } from "./stats-charts"
import {
  renderCompositionDonut,
  renderPercentStack,
  renderStreamStackChart,
  renderWaterfall,
  renderHistogram,
} from "./stats-charts"
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
  paint,
  renderCallout,
  renderContext,
  renderEmptyState,
  renderHeatmap,
  renderRankBars,
  renderRoundedLineChart,
  renderStackedAreaChart,
  statsContentWidth,
  sparkline,
  terminalText,
  visibleLength,
  truncateVisible,
  renderComparisonTable,
  wrapAnsiVisible,
  wrapVisible,
} from "./stats-charts"
// #483：renderMatrix 编号矩阵退役——身份与数值需来回对照，改真实实体名视图

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
// 公开查询与实际发射点使用同一NO_COLOR裁决，避免字段正确但输出漏色。
export const useColor = (mode?: ColorMode) => renderContext(mode).color !== "never"

// #174：limit 只 slice
// #174：limit 只 slice 展示行，不改 totals
// #174：limit 只切片列表，totals 不动
export const limitRows = <T>(rows: T[], limit?: number) => {
  if (limit === undefined || !Number.isFinite(limit)) return rows
  return rows.slice(0, Math.max(0, limit))
}

// #174：header 固定展示关键汇总
const header = (report: StatsReport, title: string, color?: ColorMode) => [
  // R6标题采用magenta，辅助标题保留cyan；同一模式决定每个页面的ANSI输出。
  paint(title, "magenta", renderContext(color), true),
  `sessions=${report.totalSessions} cost=${formatNumber(report.total.cost)} tokens=${formatNumber(report.total.tokens.total)} days=${report.days}`,
  report.requestedDays === undefined
    ? "All time"
    : report.requestedDays === 0
      ? "Today"
      : `Last ${report.requestedDays} days`,
  "-".repeat(Math.min(60, statsContentWidth())),
]

// 分组时间序列共用同一图元，保留各模型/供应商身份与完整趋势数据。
const renderUsageSeries = (series: StatsReport["modelSeries"], options: StatsRenderOptions, title: string) =>
  renderRoundedLineChart({
    title,
    series: limitRows(series, options.limit).map((item) => ({
      id: item.id,
      label: item.label || item.id,
      points: item.points.map((point) => ({
        x: point.label,
        y: options.metric === "cost" ? point.cost : point.tokens.total,
      })),
    })),
  })

// 排名和明细先按同一指标排序再限行，不能从默认费用榜截出 token/calls 的 Top N。
const topGroups = (groups: StatsReport["models"], options: StatsRenderOptions) =>
  limitRows(
    groups.toSorted((a, b) => {
      // 默认 token 与显式 cost/calls 共用选择器，所有榜单和台账在限行前取得同一排序。
      if (options.sort === "cost") return b.cost - a.cost || b.tokens.total - a.tokens.total
      if (options.sort === "calls") return b.assistantCalls - a.assistantCalls || b.tokens.total - a.tokens.total
      return b.tokens.total - a.tokens.total || b.cost - a.cost
    }),
    options.limit,
  )

// 分组台账补足排名图省略的计量，模型、供应商和扩展维度复用同一口径。
const renderGroupDetails = (groups: StatsReport["models"], options: StatsRenderOptions) =>
  topGroups(groups, options).flatMap((group) => [
    `${terminalText(group.label || group.id)} cost=${formatNumber(group.cost)} tokens=${formatNumber(group.tokens.total)} calls=${group.assistantCalls} requests=${group.requests} sessions=${group.sessions} $/call=${formatNumber(group.assistantCalls ? group.cost / group.assistantCalls : 0)}`,
    `  input=${formatNumber(group.tokens.input)} output=${formatNumber(group.tokens.output + group.tokens.reasoning)} cacheRead=${formatNumber(group.tokens.cache.read)} cacheWrite=${formatNumber(group.tokens.cache.write)}`,
  ])

// #174：dashboard 固定模型榜后日线
// #174：dashboard 固定先模型榜后日线

// #176：按维度输出归因表/条形图
export const renderBreakdown = (report: StatsReport, options: StatsRenderOptions = {}) => {
  // #176：默认按 model 归因
  const by = options.by ?? "model"
  const metric = options.metric ?? (by === "provider" ? "cost" : "tokens")
  const groups =
    by === "provider"
      ? report.providers
      : by === "agent"
        ? (report.agents ?? [])
        : by === "source"
          ? (report.sources ?? [])
          : by === "project"
            ? (report.projects ?? [])
            : by === "status"
              ? (report.statuses ?? [])
              : by === "tool"
                ? (report.toolUsage ?? []).map((tool) => ({
                    id: tool.id,
                    label: tool.id,
                    tokens: {
                      input: 0,
                      output: 0,
                      reasoning: 0,
                      cache: { read: 0, write: 0 },
                      total: tool.contextTokens,
                    },
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

  // #483：ranking 行同时携带绝对值与全局占比，读者不再需要心算 share
  // #483：占比分母用完整分组集合而非可见行——limit 只裁剪展示，不改变份额语义
  const grandTotal = groups.reduce((sum, g) => sum + (metric === "cost" ? g.cost : g.tokens.total), 0)
  // 保留目标统一排序器；provider仅在未指定指标/排序时用费用，tool调用数不冒充assistant次数。
  const rows = (
    by === "tool"
      ? limitRows(options.sort === "calls" ? groups.toSorted((a, b) => b.requests - a.requests) : groups, options.limit)
      : topGroups(groups, {
          ...options,
          sort: options.sort ?? (by === "provider" && options.metric === undefined ? "cost" : undefined),
        })
  ).map((group) => {
    const value = metric === "cost" ? group.cost : group.tokens.total
    // share 紧跟绝对值：空数据集合不输出 0%，避免与真实零用量混淆
    const share = grandTotal > 0 ? ` ${Math.round((value / grandTotal) * 100)}%` : ""
    // #483：project 行同时展示名称与 worktree 路径——两者都是用户可识别身份；缺失元数据时 path 为空；
    // replace 只清理空 path 时残留的分隔符，不触碰用户数据中的任何字符
    const path =
      by === "project" && "path" in group ? ` · ${(group as { path?: string }).path || ""}`.replace(/ ·$/, "") : ""
    return { label: `${group.label || group.id}${path}${share}`, value }
  })
  const lines = [
    `Breakdown by ${by} (${metric})`,
    // #483：真实实体名是显示契约——label 预算由最长内容驱动（上限 120 列），
    // 长项目名/worktree 路径在宽终端完整可见，只有物理列数不足时才收敛
    ...renderRankBars({
      title: `${by} ranking`,
      rows,
      labelWidth: Math.max(24, ...rows.map((row) => visibleLength(row.label))),
    }),
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
    // #483：估算上下文可能因 legacy breakdown 缺失而全零；此时保留 calls 并明确显示不可用，不把缺失伪装成精确零
    const hasContextTokens = (report.toolUsage ?? []).some((tool) => tool.contextTokens > 0)
    if (!hasContextTokens) {
      lines.push("Context estimate unavailable for these records; call share remains separate.")
    }
    lines.push("Tool footprint")
    lines.push(
      "Calls, IO characters, errors and duration come from ToolPart; estimated context is not tool cost or billed tokens.",
    )
    // #483：errors/duration 来自过滤后的 toolCalls，分母始终是同一行的真实调用数
    const callStats = new Map<string, { errors: number; durationMs: number }>()
    let totalCalls = 0
    for (const call of report.toolCalls ?? []) {
      const item = callStats.get(call.toolID) ?? { errors: 0, durationMs: 0 }
      item.errors += call.errors
      item.durationMs += call.durationMs
      callStats.set(call.toolID, item)
      totalCalls += call.calls
    }
    for (const tool of limitRows(
      options.sort === "calls" ? report.toolUsage.toSorted((a, b) => b.count - a.count) : report.toolUsage,
      options.limit,
    )) {
      const calls = callStats.get(tool.id) ?? { errors: 0, durationMs: 0 }
      // 分母始终是同一行的真实调用数：per-call 列回答“单次调用多大/多慢”，
      // 总量列回答“累计多少”；call share 分母同样来自过滤后 tuple 总和
      const share = totalCalls > 0 ? ` call share=${percentage(tool.count, totalCalls)}` : ""
      const avgMs = tool.count > 0 ? Math.round(calls.durationMs / tool.count) : 0
      const inPerCall = Math.round(tool.inputChars / Math.max(1, tool.count))
      const outPerCall = Math.round(tool.outputChars / Math.max(1, tool.count))
      const ctx = hasContextTokens
        ? ` ctx=${tool.contextTokens} context share=${percentage(
            tool.contextTokens,
            report.toolUsage.reduce((sum, item) => sum + item.contextTokens, 0),
          )}`
        : ""
      // #483：tool 名同样经终端协议清洗——内部受限词表不是省略清洗的理由
      lines.push(
        `  ${terminalText(tool.id).padEnd(24)} calls=${tool.count}${share} in=${tool.inputChars}chars out=${tool.outputChars}chars in/c=${inPerCall} out/c=${outPerCall} errors=${calls.errors} avg/call=${avgMs}ms${ctx}`,
      )
    }
    // #483：footprint 与 runtime mix 都从过滤后 toolCalls 构建，不能混入 Session 级未过滤 count；
    // 排序按调用量稳定，数值并列时输出不变
    const mix = new Map<string, number>()
    for (const call of report.toolCalls ?? []) {
      const key = `${call.toolID} ← ${terminalText(`${call.providerID}/${call.modelID} · ${call.agent} · ${call.projectID}`)}`
      mix.set(key, (mix.get(key) ?? 0) + call.calls)
    }
    if (mix.size > 0) {
      lines.push("")
      lines.push("Issuing runtime mix (calls by owning assistant)")
      for (const [key, calls] of Array.from(mix.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, options.limit ?? 8)) {
        // #483：mix 行是 provider/model/agent/project 拼接的持久化实体标签，输出前清洗
        lines.push(`  ${terminalText(key)} calls=${calls}`)
      }
    }
  }
  if (by !== "tool") {
    // 数据层的各维度序列与输入组件必须有实际输出入口，不能只保留在报告对象中。
    const series = {
      model: report.modelSeries,
      provider: report.providerSeries,
      agent: report.agentSeries,
      source: report.sourceSeries,
      project: report.projectSeries,
      status: report.statusSeries,
    }[by]
    // Outcome趋势按每日请求分母计算，未归因Assistant token不进入结果比率。
    lines.push(
      "",
      ...(by === "status"
        ? renderRoundedLineChart({
            title: "Request outcome trend",
            series: report.statusSeries
              .filter((group) => group.id !== "unattributed")
              .map((group) => ({
                id: group.id,
                label: terminalText(group.label),
                style: {
                  color:
                    group.id === "completed"
                      ? ("green" as const)
                      : group.id === "error"
                        ? ("red" as const)
                        : group.id === "aborted"
                          ? ("yellow" as const)
                          : ("cyan" as const),
                },
                points: group.points.map((point) => ({
                  x: point.label,
                  y: ratio(point.requests, report.daily.find((day) => day.day === point.day)?.requests ?? 0) * 100,
                })),
              })),
          })
        : renderUsageSeries(series, options, `${by} usage over time`)),
    )
    lines.push(...renderGroupDetails(groups, options))
    if (by === "source") {
      lines.push("Input components by source")
      for (const group of topGroups(groups, options)) {
        lines.push(
          `  ${group.label || group.id} ${Object.entries(group.components)
            .map(([key, value]) => `${key}=${formatNumber(value)}`)
            .join(" ")}`,
        )
      }
    }
  }
  if (by !== "tool") lines.push(...renderDimensionAnalysis(report, groups, by, options))
  // #181：只返回本表行，由 dashboard 负责段间距
  return lines.join("\n")
}

// #181：金额短格式
// #181：仪表盘顶表金额短显示
const money = (value: number) => {
  // #183：紧凑金额，拒绝噪声小数
  if (!Number.isFinite(value) || value <= 0) return "$0"
  if (value >= 1000) return `$${(value / 1000).toFixed(1)}K`
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
  // #183：含 per-call 时指标槽更宽
  const metricsBudget = kind === "model" ? 36 : 28
  // #181：先扣指标与 gutter 再谈 trend
  const trendRoom = content - metricsBudget - 15 - labelFloor
  // #181：小于 6 列不画 trend，避免碎裂
  // #181：trend 要么够 6 列要么为 0
  const trendWidth = trendRoom < 6 ? 0 : Math.min(24, trendRoom)
  // #181：label 在 floor/cap 间吃掉剩余宽度
  // 指标槽宽含空格与缩进；窄屏优先缩标签，保留 per-call 和数量级。
  const labelWidth = Math.max(
    1,
    Math.min(labelCap, content - (kind === "model" ? 41 : 32) - (trendWidth > 0 ? trendWidth + 3 : 0)),
  )
  const lines = [`▸ ${title}`]
  // #181：宽屏表头带 share│trend，窄屏去掉 trend
  // #183：model 顶表增加 per-call 列（tokens/calls）
  const headCols = [
    fitVisible("name", labelWidth),
    fitVisible("cost", 8),
    fitVisible("tokens", 8),
    fitVisible("calls", 5),
  ]
  if (kind === "model") headCols.push(fitVisible("per-call", 8))
  headCols.push("share")
  const head = `  ${headCols.join(" ")}${trendWidth > 0 ? " │ trend" : ""}`
  lines.push(head)
  for (const row of rows) {
    // #181：share 用全局 total.tokens.total
    const share = `${Math.round((row.tokens / totalTokens) * 100)}%`
    // #181：按 id 对齐 series 点列
    const seriesPoints = series.find((s) => s.id === row.id)?.points ?? []
    const values = seriesPoints.map((p) => p.tokens.total)
    // #181：无点列时 sparkline 返回空串
    const trend = trendWidth > 0 ? sparkline(values, trendWidth) : ""
    // #181：标签按显示列截断，保留 CJK 语义；#483：截断前先清洗终端协议序列
    const label = truncateVisible(terminalText(row.label), labelWidth)
    // #183：per-call = tokens/assistantCalls，便于单次调用效率扫读
    const perCall = row.calls > 0 ? Math.round(row.tokens / row.calls) : 0
    const cols = [
      fitVisible(label, labelWidth),
      fitVisible(money(row.cost), 8),
      fitVisible(formatNumber(row.tokens), 8),
      fitVisible(formatNumber(row.calls), 5),
    ]
    if (kind === "model") cols.push(fitVisible(formatNumber(perCall), 8))
    cols.push(fitVisible(share, 5))
    const base = `  ${cols.join(" ")}`
    // #181：trend 用 │ 与 share 分隔
    lines.push(trendWidth > 0 ? `${base} │ ${trend}` : base)
  }
  // #181：禁止再单独挂 Model/Provider activity rows
  return lines
}

// #182：节标题分隔，便于扫读
const renderSectionDivider = (title: string, subtitle?: string) => {
  const line = `── ${title} ${"─".repeat(Math.max(2, 24 - title.length))}`
  return subtitle ? [line, `   ${subtitle}`] : [line]
}

// #182：简易 DOW 份额条（Mon-Sun）
const renderDayOfWeekShare = (report: StatsReport) => {
  // #182：按用量发生的本地星期归属，续聊不能搬移此前 token
  const dow = Array.from({ length: 7 }, () => 0)
  for (const day of report.daily) {
    const d = new Date(day.day).getDay()
    const idx = d === 0 ? 6 : d - 1
    dow[idx] += day.tokens.total
  }
  const max = Math.max(1, ...dow)
  const names = ["M", "T", "W", "T", "F", "S", "S"]
  return [
    "Day of week share",
    ...names.map((n, i) => `  ${n} ${"█".repeat(Math.max(1, Math.round((dow[i] / max) * 10)))} ${dow[i]}`),
  ]
}

// #182：小时活跃粗条
const renderHourOfDayStrip = (report: StatsReport) => {
  // #483：优先 request shell 的本地小时投影——它与请求健康指标同一事件源，不会把 assistant 行重复计数；
  // 全零时回退会话活跃，保持旧数据源仍有可见分布
  const fromReport = report.requestsByHour
  if (fromReport && fromReport.length === 24 && fromReport.some((h) => h > 0)) {
    const max = Math.max(1, ...fromReport)
    const glyphs = fromReport.map((h) => "·░▒▓█"[Math.min(4, Math.round((h / max) * 4))]).join("")
    const active = fromReport
      .map((value, hour) => ({ value, hour }))
      .filter((item) => item.value > 0)
      .toSorted((a, b) => a.value - b.value)
    return [
      "Hour of day (requests)",
      `  ${glyphs}`,
      "  00  04  08  12  16  20",
      `peak ${String(active.at(-1)!.hour).padStart(2, "0")}:00 / ${active.at(-1)!.value} req`,
      `low ${String(active[0].hour).padStart(2, "0")}:00 / ${active[0].value} req`,
    ]
  }
  // #182：24 小时活跃（无 request 数据时的 legacy 回退，仍基于会话活跃）
  const hours = Array.from({ length: 24 }, () => 0)
  for (const s of report.sessions) {
    hours[new Date(s.updated).getHours()] += Math.max(1, s.requests)
  }
  const max = Math.max(1, ...hours)
  const glyphs = hours.map((h) => "·░▒▓█"[Math.min(4, Math.round((h / max) * 4))]).join("")
  return ["Hour of day", `  ${glyphs}`, "  00  04  08  12  16  20"]
}

// #182：日历强度
const renderCalendarActivity = (report: StatsReport) => {
  // 按本地星期分周显示，长历史不扩成一条无日期的超宽字符带。
  const max = Math.max(1, ...report.daily.map((day) => day.tokens.total))
  const rows = ["Calendar activity", "          M T W T F S S"]
  let week: string[] = []
  let label = ""
  for (const day of report.daily) {
    const weekday = (new Date(day.day).getDay() + 6) % 7
    if (weekday === 0 && week.length) {
      rows.push(`  ${label} ${week.join(" ")}`)
      week = []
    }
    if (!week.length) {
      label = day.label
      week = Array(weekday).fill(" ")
    }
    week.push("·░▒▓█"[Math.min(4, Math.round((day.tokens.total / max) * 4))])
  }
  if (week.length) rows.push(`  ${label} ${week.join(" ")}`)
  return [...rows, "  · low  █ high"]
}

// #182：token 组件小多图
const renderTokenComponentsSmallMultiples = (report: StatsReport, options: StatsRenderOptions) => {
  // #182：tokenPartSeries 主路径画 tip sparkline 小多图；仅全空时回退 totals 条
  const parts = report.tokenPartSeries ?? []
  const lines = ["Token components", "  each series auto-normalized to its own peak"]
  if (parts.length === 0) {
    const t = report.total.tokens
    const rows = [
      { label: "Input", value: t.input },
      { label: "Output", value: t.output },
      { label: "Cache Read", value: t.cache.read },
      { label: "Cache Write", value: t.cache.write },
    ]
    return [...lines, ...renderRankBars({ rows })]
  }
  const contentWidth = statsContentWidth()
  for (const part of parts) {
    // #182：点列为空时用 total 单点序列
    const values = part.points.map((p) => p.value)
    const peak = Math.max(0, ...(values.length ? values : [part.total]))
    // 为真实标签和紧凑数值留出空间；窄屏分两行，避免截断组件名或数量级。
    const label = `  ${part.label.padEnd(12)}`
    const summary = `total=${formatNumber(part.total)} peak=${formatNumber(peak)}`
    const available = contentWidth - visibleLength(label) - visibleLength(summary) - 3
    const width = Math.min(40, Math.max(1, available >= 8 ? available : contentWidth - visibleLength(label) - 1))
    const bar = sparkline(values.length ? values : [part.total], width)
    lines.push(...(available >= 8 ? [`${label} ${bar}  ${summary}`] : [`${label} ${bar}`, `    ${summary}`]))
  }
  return lines
}

// #182：成本与健康（含日趋势 sparkline）
// #182：单一指标口径：失败率与 cache hit 都从 report.total 派生
const failureRate = (report: StatsReport) => {
  const failed = report.total.errors + report.total.aborted
  const reqs = report.total.requests
  // #182：无请求时不编造比率
  return { failed, rate: reqs > 0 ? Math.round((failed / reqs) * 1000) / 10 : 0, hasRequests: reqs > 0 }
}

// #182：cache hit 源公式 cache.read / tokens.total * 100
const cacheHitRate = (report: StatsReport) => {
  const total = report.total.tokens.total
  return total > 0 ? Math.round((report.total.tokens.cache.read / total) * 1000) / 10 : 0
}

const renderCostHealthSection = (report: StatsReport) => {
  const lines = ["Cost & health"]
  const costs = report.daily.map((d) => d.cost)
  lines.push(`  daily cost peak: ${money(Math.max(0, ...costs, 0))}`)
  lines.push(`  total cost: ${money(report.total.cost)}`)
  // #182：日成本趋势 sparkline（tip 文本）
  const w = Math.max(12, Math.min(40, statsContentWidth() - 20))
  lines.push(`  cost trend ${sparkline(costs.length ? costs : [0], w)}`)
  // #182：日 cache-hit 序列用源公式 read/total
  const hitSeries = report.daily.map((d) => (d.tokens.total > 0 ? (d.tokens.cache.read / d.tokens.total) * 100 : 0))
  lines.push(`  cache-hit trend ${sparkline(hitSeries.length ? hitSeries : [0], w)}`)
  // #182：日失败率序列，回答“何时出错”
  const errSeries = report.daily.map((d) => (d.requests > 0 ? ((d.errors + d.aborted) / d.requests) * 100 : 0))
  lines.push(`  error-rate trend ${sparkline(errSeries.length ? errSeries : [0], w)}`)
  const failure = failureRate(report)
  // #182：无请求时才 n/a，禁止有数据时写死 n/a
  lines.push(failure.hasRequests ? `  Abort & error rate (%): ${failure.rate}` : "  Abort & error rate (%): n/a")
  lines.push(`  Cache hit (%): ${cacheHitRate(report)}`)
  return lines
}

// #182：用 statuses/sessions/cache 生成可行动建议
const renderInsightsCallout = (report: StatsReport) => {
  // #182：insights 复用 failureRate/cacheHitRate，避免同指标多处派生
  const top = report.models[0]
  const failure = failureRate(report)
  const sorted = [...report.sessions].sort((x, y) => y.tokens.total - x.tokens.total)
  const top2 = sorted.slice(0, 2).reduce((acc, s) => acc + s.tokens.total, 0)
  const share = report.total.tokens.total > 0 ? Math.round((top2 / report.total.tokens.total) * 100) : 0
  const body = [
    top ? `Top model ${terminalText(top.label || top.id)} leads tokens.` : "No model usage yet.",
    failure.failed > 0
      ? `Failed/aborted requests: ${failure.failed} (${failure.rate}%). Inspect stats timeline for bursts.`
      : "No failed/aborted requests in window.",
    share > 0
      ? `Top-2 sessions hold ~${share}% of tokens; use stats sessions for outliers.`
      : "Session concentration unavailable.",
    `Cache hit ~${cacheHitRate(report)}%. Review provider mix if cost spikes.`,
  ]
  return ["Insights", ...body.map((l) => `  ${l}`)]
}

export const renderDashboard = (report: StatsReport, options: StatsRenderOptions = {}) => {
  // #182：分区仪表盘：activity / tokens / cost / tops / sessions / insights
  const lines: string[] = [...header(report, "stats dashboard", options.color)]
  lines.push(...renderSectionDivider("Daily activity"))
  // 宽屏复用现有多列布局；窄屏保留完整内容，避免固定分栏裁掉日期。
  const activity = [renderCalendarActivity(report), renderHourOfDayStrip(report), renderDayOfWeekShare(report)]
  lines.push(
    ...(statsContentWidth() >= 90
      ? renderThreeColumn(activity[0], activity[1], activity[2])
      : statsContentWidth() >= 64
        ? renderTwoColumn(activity[0], [...activity[1], ...activity[2]])
        : activity.flat()),
  )
  lines.push("")
  lines.push(...renderSectionDivider("Token components", "auto-normalized small multiples"))
  // #182：组件小多图区
  lines.push(...renderTokenComponentsSmallMultiples(report, options))
  lines.push("")
  lines.push(...renderSectionDivider("Cost & health"))
  // #182：成本健康区（含日趋势 + statuses 失败率）
  lines.push(...renderCostHealthSection(report))
  lines.push("")
  lines.push(...renderSectionDivider("Top models"))
  lines.push(
    ...dashboardTopTable("Top models", report.models, report.modelSeries, options, "model", report.total.tokens.total),
  )
  lines.push("")
  lines.push(...renderSectionDivider("Top providers"))
  lines.push(
    ...dashboardTopTable(
      "Top providers",
      report.providers,
      report.providerSeries,
      options,
      "provider",
      report.total.tokens.total,
    ),
  )
  lines.push("")
  lines.push(...renderSectionDivider("Sessions"))
  lines.push(`  sessions with usage: ${report.sessionsWithUsage}`)
  lines.push(`  median tokens/session: ${report.medianTokensPerSession}`)
  // #182：会话体量分桶 + top list（tip 文本条）
  {
    // #182：分桶边界服务重尾会话扫读
    const buckets = [
      { label: "<100K", lo: 0, hi: 100_000 },
      { label: "100K-1M", lo: 100_000, hi: 1_000_000 },
      { label: "1M-10M", lo: 1_000_000, hi: 10_000_000 },
      { label: ">10M", lo: 10_000_000, hi: Number.POSITIVE_INFINITY },
    ]
    const counts = buckets.map(
      (b) => report.sessions.filter((s) => s.tokens.total >= b.lo && s.tokens.total < b.hi).length,
    )
    lines.push("  Session size distribution")
    for (let i = 0; i < buckets.length; i++) {
      const bar = "█".repeat(Math.min(20, counts[i]))
      lines.push(`  ${buckets[i].label.padEnd(8)} ${bar} ${counts[i]}`)
    }
    const sorted = [...report.sessions].sort((a, b) => b.tokens.total - a.tokens.total).slice(0, options.limit ?? 5)
    // 分位数使用完整会话样本，榜单 limit 不能改变长尾统计。
    const volumes = report.sessions.map((session) => session.tokens.total).sort((a, b) => a - b)
    const quantile = (q: number) =>
      formatNumber(volumes[Math.min(volumes.length - 1, Math.floor(volumes.length * q))] ?? 0)
    const share = (count: number) =>
      (
        (100 * volumes.slice(-count).reduce((sum, value) => sum + value, 0)) /
        Math.max(1, report.total.tokens.total)
      ).toFixed(1)
    lines.push(`  p50=${formatNumber(report.medianTokensPerSession)} p90=${quantile(0.9)} p99=${quantile(0.99)}`)
    lines.push(`  Heavy-tail top-2=${share(2)}% top-10=${share(10)}%`)
    lines.push("  Top sessions by tokens")
    for (const s of sorted) {
      lines.push(...wrapAnsiVisible(`  ${terminalText(s.title || s.id)} ${s.tokens.total}`))
      lines.push(
        ...wrapAnsiVisible(
          `  models ${s.models.map(terminalText).join(", ")} · providers ${s.providers.map(terminalText).join(", ")}`,
        ),
      )
    }
  }
  lines.push("")
  lines.push(...renderSectionDivider("Insights"))
  // #182：多行 insights，避免单行挤爆
  lines.push(...renderInsightsCallout(report))
  // #182：分区完成后一次性输出
  return lines.join("\n")
}

export const renderOverview = (report: StatsReport, options: StatsRenderOptions = {}) =>
  [
    ...header(report, "stats overview", options.color),
    `messages=${report.totalMessages} tools=${report.totalTools} medianTokens/session=${formatNumber(report.medianTokensPerSession)}`,
    "tools:",
    ...limitRows(report.toolUsage, options.limit).map((t) => `  ${fitVisible(terminalText(t.id), 24)} ${t.count}`),
  ].join("\n")

// #174：models 页按 metric 选 cost 或 tokens
export const renderModels = (report: StatsReport, options: StatsRenderOptions = {}) =>
  [...header(report, "stats models", options.color), renderBreakdown(report, { ...options, by: "model" })].join("\n")

// #174：providers 页数据源独立
export const renderProviders = (report: StatsReport, options: StatsRenderOptions = {}) =>
  [...header(report, "stats providers", options.color), renderBreakdown(report, { ...options, by: "provider" })].join(
    "\n",
  )

// #174：折线加堆叠非热力命令：只读报告生成终端行，不写库
// #174：timeline 只用折线与堆叠，不承担 heatmap 命令
// #174：时间线只拼折线与堆叠
// #174：renderTimeline 服务时间线折线，不承担 heatmap 命令
export const renderTimeline = (report: StatsReport, options: StatsRenderOptions = {}) => {
  const metric = options.metric ?? "tokens"
  const values = report.daily.map((day) => (metric === "cost" ? day.cost : day.tokens.total))
  const peak = Math.max(0, ...values)
  const peakDay = report.daily[values.indexOf(peak)]
  const total = metric === "cost" ? report.total.cost : report.total.tokens.total
  const format = metric === "cost" ? priced : formatNumber
  const lines = [...header(report, "stats timeline", options.color)]
  if (metric === "cost" && report.total.cost <= 0) lines.push("No positive cost recorded in this range.")
  else {
    lines.push(
      `━━━ ${metric === "cost" ? "Daily cost" : "Daily token volume"}`,
      "",
      ...renderRoundedLineChart({
        series: [dailySeries(report.daily, (day) => (metric === "cost" ? day.cost : day.tokens.total))],
        width: Math.max(12, statsContentWidth() - 8),
        height: 8,
      }),
    )
    lines.push(
      metric === "cost"
        ? `total ${format(total)} · avg ${format(ratio(total, report.days))}/day · peak ${format(peak)}${peakDay ? ` on ${new Date(peakDay.day).toLocaleDateString()}` : ""} · ${values.filter((value) => value > 0).length}/${report.days} active days`
        : `total ${format(total)} · peak ${format(peak)}/day · avg ${format(ratio(total, report.days))}/day`,
    )
  }
  if (metric === "tokens") {
    // 各组件独立归一化只表示形状，旁边的绝对量、占比和峰值承担量级比较。
    lines.push("Token components · each trend independently normalized")
    for (const layer of layersFromTokenParts()) {
      const points = report.daily.map(layer.value)
      const amount = layer.value({ ...report.total, day: report.dateRange.latest, label: "total" })
      lines.push(
        `${layer.label === "Output" ? "Output + Reasoning" : layer.label} ${formatNumber(amount)} ${percentage(amount, report.total.tokens.total)} · peak ${formatNumber(Math.max(0, ...points))}/day`,
        sparkline(points, Math.max(8, Math.min(32, statsContentWidth() - 2))),
      )
    }
  }
  lines.push(
    "━━━ Health and efficiency",
    ...renderCostHealthSection(report),
    ...report.daily.map(
      (day) =>
        `${day.label} completed=${Math.max(0, day.requests - day.errors - day.aborted)} error=${day.errors} aborted=${day.aborted} avg=${Math.round(ratio(day.durationMs, day.requests))}ms`,
    ),
  )
  lines.push(
    metric === "cost" ? "Top cost days" : "Top active days",
    ...renderComparisonTable([
      ["date", metric, "requests", "failed"],
      ...report.daily
        .filter((day) => (metric === "cost" ? day.cost : day.tokens.total) > 0)
        .toSorted((a, b) => (metric === "cost" ? b.cost - a.cost : b.tokens.total - a.tokens.total))
        .slice(0, 5)
        .map((day) => [
          day.label,
          format(metric === "cost" ? day.cost : day.tokens.total),
          String(day.requests),
          percentage(day.errors + day.aborted, day.requests),
        ]),
    ]),
  )
  lines.push(metric === "cost" ? "Cost drivers" : "Entity trends")
  for (const [title, series] of [
    ["Models", report.modelSeries],
    ["Providers", report.providerSeries],
  ] as const) {
    lines.push(
      title,
      ...series
        .toSorted((a, b) => (metric === "cost" ? b.cost - a.cost : b.tokens.total - a.tokens.total))
        .slice(0, 3)
        .map(
          (item) =>
            `${terminalText(item.label)} ${sparkline(
              item.points.map((point) => (metric === "cost" ? point.cost : point.tokens.total)),
              14,
            )} ${format(metric === "cost" ? item.cost : item.tokens.total)}`,
        ),
    )
  }
  if (options.heatmap)
    lines.push(
      ...renderHeatmap({
        title: metric === "cost" ? "Cost heatmap · calendar view" : "Token heatmap · calendar view",
        points: metric === "cost" ? dailyCostPoints(report) : dailyTokenPoints(report),
        color: options.color,
      }),
    )
  return lines.flatMap((line) => (line.includes("\x1b[") ? wrapAnsiVisible(line) : wrapVisible(line))).join("\n")
}

// #174：sessions 按 sort 键排序再切片
// #177：sessions 默认 tokens 排序
export const renderSessions = (report: StatsReport, options: StatsRenderOptions = {}) => {
  const sort = options.sort ?? "tokens"
  const rows = report.sessions.toSorted((a, b) =>
    sort === "tokens"
      ? b.tokens.total - a.tokens.total
      : sort === "calls"
        ? b.assistantCalls - a.assistantCalls
        : sort === "updated"
          ? b.updated - a.updated
          : b.cost - a.cost,
  )
  const percentile = (values: number[], q: number) =>
    values.toSorted((a, b) => a - b)[Math.floor(Math.max(0, values.length - 1) * q)] ?? 0
  const positive = report.sessions.filter((session) => session.cost > 0)
  const lines = [...header(report, "stats sessions", options.color), "━━━ Session population", ""]
  // 总体分位数和分布使用全部样本，limit仅约束下面的明细。
  for (const q of [0.5, 0.9, 0.95, 0.99])
    lines.push(
      `p${Math.round(q * 100)} ${formatNumber(
        percentile(
          report.sessions.map((session) => session.tokens.total),
          q,
        ),
      )} tokens · ${priced(
        percentile(
          positive.map((session) => session.cost),
          q,
        ),
      )}`,
    )
  const bands = (title: string, values: number[], limits: number[], labels: string[]) => {
    const counts = labels.map(
      (_, index) => values.filter((value) => value >= limits[index] && value < (limits[index + 1] ?? Infinity)).length,
    )
    const max = Math.max(1, ...counts)
    const width = Math.max(8, statsContentWidth() - 24)
    return [
      title,
      ...counts.map(
        (count, index) =>
          `${labels[index]} ${"█".repeat(Math.round((count / max) * width))}${"░".repeat(width - Math.round((count / max) * width))} ${count} ${percentage(count, values.length)}`,
      ),
    ]
  }
  lines.push(
    ...bands(
      "Session size distribution · tokens",
      report.sessions.map((session) => session.tokens.total),
      [0, 100_000, 1_000_000, 5_000_000, 50_000_000],
      ["<100K", "100K-1M", "1M-5M", "5M-50M", ">50M"],
    ),
  )
  // 零费用既可能是免费也可能是未定价，不能冒充正费用分布的低值样本。
  lines.push(
    ...(positive.length
      ? bands(
          `Session cost distribution · positive recorded cost (${positive.length} sessions)`,
          positive.map((session) => session.cost),
          [0, 0.1, 1, 5, 10],
          ["<$0.10", "$0.10-$1", "$1-$5", "$5-$10", ">$10"],
        )
      : ["Cost distribution unavailable: no positive cost recorded in this range."]),
  )
  if (positive.length < report.sessions.length)
    lines.push(`No positive recorded cost · ${report.sessions.length - positive.length} sessions`)
  lines.push(`Session leaderboard · sorted by ${sort} · bar = token share`)
  const selected = limitRows(rows, options.limit ?? (statsContentWidth() < 60 ? 3 : 5))
  for (const session of selected) {
    const share = ratio(session.tokens.total, report.total.tokens.total)
    const width = Math.max(8, statsContentWidth() - 40)
    lines.push(
      terminalText(session.title || session.id),
      `token share ${"█".repeat(Math.round(share * width))}${"░".repeat(Math.max(0, width - Math.round(share * width)))} ${percentage(session.tokens.total, report.total.tokens.total)} ${formatNumber(session.tokens.total)}`,
    )
    lines.push(
      `project ${terminalText(report.projects.find((project) => project.id === session.projectID)?.label ?? session.projectID)} · ${priced(session.cost)} · ${session.requests} req / ${session.assistantCalls} calls · ${session.messages} msg / ${session.tools} tools`,
    )
    lines.push(
      `cache ${percentage(session.tokens.cache.read, session.tokens.total)} · fail ${session.errors + session.aborted} · ${Math.round(ratio(session.durationMs, session.requests))}ms avg/request`,
    )
    lines.push(
      `models ${session.models.map(terminalText).join(", ") || "unknown"} · providers ${session.providers.map(terminalText).join(", ") || "unknown"}`,
      "",
    )
  }
  lines.push(`Visible ${selected.length} of ${rows.length} usage sessions · use -n to change rows`)
  return lines.flatMap((line) => wrapVisible(line)).join("\n")
}

// #174：charts 拼条形与日线
// #177：charts 页附加 tool context 时间序列
export const renderCharts = (report: StatsReport, options: StatsRenderOptions = {}) =>
  [
    ...header(report, "stats charts", options.color),
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
    ...renderRankBars({
      rows: limitRows(report.models, options.limit ?? 8).map((m) => ({
        label: m.label || m.id,
        value: m.tokens.total,
      })),
    }),
    ...renderRoundedLineChart({ series: [dailySeries(report.daily, (d) => d.cost)] }),
    ...renderUsageSeries(report.modelSeries, options, "Model usage over time"),
    ...renderUsageSeries(report.providerSeries, options, "Provider usage over time"),
    ...renderStackedAreaChart({ title: "Token components", daily: report.daily, layers: layersFromTokenParts() }),
    ...renderStreamStackChart({
      title: "Model mix over time",
      daily: report.daily,
      layers: limitRows(report.modelSeries, options.limit).map((series) => ({
        id: series.id,
        label: series.label || series.id,
        color: "cyan",
        value: (day) => {
          const point = series.points.find((point) => point.day === day.day)
          return options.metric === "cost" ? (point?.cost ?? 0) : (point?.tokens.total ?? 0)
        },
      })),
    }),
  ].join("\n")

// #174：双热力加矩阵禁止 timeline 别名
// #174：heatmap 页组合双热力与矩阵，禁止转调 timeline
// #174：页面组合双热力与矩阵，禁止转调 timeline
// #174：renderHeatmapPage 输出密度格/矩阵语义，供 heatmap 命令使用
export const renderHeatmapPage = (report: StatsReport, options: StatsRenderOptions = {}) => {
  // token portfolio与工具发起方独立计量，不可用工具次数取代没有工具的token用量。
  const portfolio = report.providers.flatMap((provider) =>
    provider.models.map((model) => [`${provider.label || provider.id}/${model.id}`, formatNumber(model.tokens)]),
  )
  const mix = new Map<string, number>()
  for (const call of report.toolCalls ?? []) {
    const key = `${call.providerID}/${call.modelID}`
    mix.set(key, (mix.get(key) ?? 0) + call.calls)
  }
  const topMix = Array.from(mix.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, options.limit ?? 8)
  return [
    ...header(report, "stats heatmap", options.color),
    ...renderHeatmap({ title: "Daily tokens", points: dailyTokenPoints(report), color: options.color }),
    ...renderHeatmap({ title: "Daily cost", points: dailyCostPoints(report), color: options.color }),
    ...(topMix.length > 0
      ? renderRankBars({
          title: "provider/model by tool calls",
          rows: topMix.map(([label, calls]) => ({ label, value: calls })),
        })
      : []),
    ...(portfolio.length
      ? ["Model portfolio by provider (tokens)", ...renderComparisonTable([["provider/model", "tokens"], ...portfolio])]
      : []),
  ].join("\n")
}

// #174：costs 强制 cost
export const renderCosts = (report: StatsReport, options: StatsRenderOptions = {}) =>
  [
    ...header(report, "stats costs", options.color),
    ...renderRankBars({
      // #177：显式 cost 先排序再限行，默认沿用 tokens 榜
      rows: limitRows(
        options.sort === "cost"
          ? [...report.models].sort((a, b) => b.cost - a.cost || b.tokens.total - a.tokens.total)
          : options.sort === "calls"
            ? [...report.models].sort((a, b) => b.assistantCalls - a.assistantCalls)
            : report.models,
        options.limit,
      ).map((m) => ({ label: m.label || m.id, value: m.cost })),
    }),
    ...renderRoundedLineChart({ series: [dailySeries(report.daily, (d) => d.cost)] }),
    ...renderWaterfall({
      title: "Provider cost waterfall",
      steps: report.providers.map((provider) => ({ label: provider.label || provider.id, delta: provider.cost })),
    }),
    ...renderHistogram({ title: "Session cost distribution", values: report.sessions.map((session) => session.cost) }),
  ].join("\n")

// #174：tokens 页先打印 cache 分列
// #174：tokens 页先打印 cache 读写分列
export const renderTokens = (report: StatsReport, options: StatsRenderOptions = {}) =>
  [
    ...header(report, "stats tokens", options.color),
    `input=${formatNumber(report.total.tokens.input)} output=${formatNumber(report.total.tokens.output + report.total.tokens.reasoning)} cacheRead=${formatNumber(report.total.tokens.cache.read)} cacheWrite=${formatNumber(report.total.tokens.cache.write)}`,
    ...renderRankBars({
      rows: limitRows(report.models, options.limit).map((m) => ({ label: m.label || m.id, value: m.tokens.total })),
    }),
    ...renderStackedAreaChart({
      title: "Input / output / cache over time",
      daily: report.daily,
      layers: layersFromTokenParts(),
    }),
    ...renderPercentStack({
      title: "Token share",
      columns: report.daily.map((day) => ({
        label: day.label,
        parts: layersFromTokenParts().map((layer) => ({ label: layer.label, value: layer.value(day) })),
      })),
    }),
    ...renderCompositionDonut({
      title: "Top model token share",
      parts: limitRows(report.models, options.limit).map((model) => ({
        label: model.label || model.id,
        value: model.tokens.total,
      })),
    }),
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

const ratio = (value: number, total: number) => (total > 0 ? value / total : 0)
const percentage = (value: number, total: number) => `${(ratio(value, total) * 100).toFixed(1)}%`
const priced = (value: number) => (value > 0 ? money(value) : "—")
const mixText = (items: { id: string; value: number }[], limit = 3) => {
  // 长尾明确归入other；分母先取完整集合，不随可见项数变化。
  const sorted = items.filter((item) => item.value > 0).toSorted((a, b) => b.value - a.value)
  const total = sorted.reduce((sum, item) => sum + item.value, 0)
  const other = sorted.slice(limit).reduce((sum, item) => sum + item.value, 0)
  return total > 0
    ? [...sorted.slice(0, limit), ...(other > 0 ? [{ id: "other", value: other }] : [])]
        .map((item) => `${terminalText(item.id)} ${percentage(item.value, total)}`)
        .join(" · ")
    : "—"
}
const highOutlier = (value: number, population: number[], format: (value: number) => string) => {
  // 异常基线取完整过滤后总体，不能因limit缩小而改变同一个Provider的标记。
  const mean = population.reduce((sum, item) => sum + item, 0) / Math.max(1, population.length)
  const sigma = Math.sqrt(
    population.reduce((sum, item) => sum + (item - mean) ** 2, 0) / Math.max(1, population.length),
  )
  const z = sigma > 0 && population.length >= 3 ? (value - mean) / sigma : 0
  return `${format(value)}${z >= 3 ? "!" : z >= 2 ? "^" : ""}`
}

const renderDimensionAnalysis = (
  report: StatsReport,
  all: StatsReport["models"],
  by: Exclude<BreakdownDimension, "tool">,
  options: StatsRenderOptions,
) => {
  const groups = limitRows(
    all.toSorted((a, b) =>
      (options.sort ?? (by === "provider" && options.metric === undefined ? "cost" : "tokens")) === "cost"
        ? b.cost - a.cost
        : options.sort === "calls"
          ? b.assistantCalls - a.assistantCalls
          : b.tokens.total - a.tokens.total,
    ),
    options.limit ?? (statsContentWidth() < 100 ? 3 : 5),
  )
  const table = (title: string, columns: string[], rows: string[][]) => [
    "",
    `━━━ ${title}`,
    "",
    ...renderComparisonTable([columns, ...rows]),
  ]
  const tokenMix = (items: { id: string; tokens: number }[]) =>
    mixText(items.map((item) => ({ id: item.id, value: item.tokens })))
  const series = {
    model: report.modelSeries,
    provider: report.providerSeries,
    agent: report.agentSeries,
    source: report.sourceSeries,
    project: report.projectSeries,
    status: report.statusSeries,
  }[by]
  const key = {
    model: "modelID",
    provider: "providerID",
    agent: "agent",
    source: "source",
    project: "projectID",
    status: "status",
  }[by] as "modelID" | "providerID" | "agent" | "source" | "projectID" | "status"
  const callMix = (id: string) => {
    const totals = new Map<string, number>()
    for (const call of report.toolCalls.filter((call) => call[key] === id))
      totals.set(call.toolID, (totals.get(call.toolID) ?? 0) + call.calls)
    return mixText(Array.from(totals, ([id, value]) => ({ id, value })))
  }
  // RequestUsage只拥有请求健康，Assistant行拥有token/cost；secondary usage的零请求不是缺失数据。
  const health = (group: StatsReport["models"][number]) => [
    group.requests > 0 ? percentage(group.errors + group.aborted, group.requests) : "—",
    group.requests > 0 ? `${Math.round(group.durationMs / group.requests)}ms` : "—",
  ]
  const components = (group: StatsReport["models"][number]) =>
    Object.entries({
      system: group.components.system,
      instructions: group.components.instructions,
      skills: group.components.skills,
      schemas: group.components.toolSchemas,
      user: group.components.userMessages,
      assistant: group.components.assistantText,
      reasoning: group.components.reasoning,
      "tool calls": group.components.toolCalls,
      "tool results": group.components.toolResults,
      attach: group.components.attachments,
    })
  const lines: string[] = []
  if (by === "model") {
    lines.push(
      ...table(
        "Model portfolio",
        ["model", "tokens", "share", "cost", "owned req", "calls", "tok/call", "sessions", "owner fail", "owner avg"],
        groups.map((group) => [
          group.label,
          formatNumber(group.tokens.total),
          percentage(group.tokens.total, report.total.tokens.total),
          priced(group.cost),
          String(group.requests),
          String(group.assistantCalls),
          formatNumber(ratio(group.tokens.total, group.assistantCalls)),
          String(group.sessions),
          ...health(group),
        ]),
      ),
    )
    lines.push(
      "owned req / owner fail / owner avg follow RequestUsage owner; tokens, cost and calls follow Assistant usage.",
    )
    lines.push(
      "━━━ Token composition",
      ...renderPercentStack({
        columns: groups.map((group) => ({
          label: terminalText(group.label),
          parts: [
            { label: "input", value: group.tokens.input },
            { label: "output", value: group.tokens.output },
            { label: "reasoning", value: group.tokens.reasoning },
            { label: "cache read", value: group.tokens.cache.read },
            { label: "cache write", value: group.tokens.cache.write },
          ],
        })),
      }),
    )
    lines.push(
      ...table(
        "Routing & tools",
        ["model", "provider mix by tokens", "issued tool calls"],
        groups.map((group) => [group.label, tokenMix(group.providers), callMix(group.id)]),
      ),
    )
  }
  if (by === "provider") {
    const perCall = report.providers
      .filter((group) => group.cost > 0 && group.assistantCalls > 0)
      .map((group) => group.cost / group.assistantCalls)
    const failures = report.providers
      .filter((group) => group.requests > 0)
      .map((group) => (group.errors + group.aborted) / group.requests)
    const durations = report.providers
      .filter((group) => group.requests > 0)
      .map((group) => group.durationMs / group.requests)
    lines.push(
      ...table(
        "Provider economics",
        [
          "provider",
          "tokens",
          "share",
          "cost",
          "cost share",
          "owned req",
          "calls",
          "$/call",
          "cache",
          "owner fail",
          "owner avg",
        ],
        groups.map((group) => [
          group.label,
          formatNumber(group.tokens.total),
          percentage(group.tokens.total, report.total.tokens.total),
          priced(group.cost),
          group.cost > 0 ? percentage(group.cost, report.total.cost) : "—",
          String(group.requests),
          String(group.assistantCalls),
          group.cost > 0 && group.assistantCalls > 0
            ? highOutlier(group.cost / group.assistantCalls, perCall, money)
            : "—",
          percentage(group.tokens.cache.read + group.tokens.cache.write, group.tokens.total),
          group.requests > 0
            ? highOutlier((group.errors + group.aborted) / group.requests, failures, (value) => percentage(value, 1))
            : "—",
          group.requests > 0
            ? highOutlier(group.durationMs / group.requests, durations, (value) => `${Math.round(value)}ms`)
            : "—",
        ]),
      ),
    )
    lines.push(
      "Risk marks compare the full provider population: ! >=3σ, ^ >=2σ. Cache >=95% is highlighted as healthy.",
    )
    lines.push(
      ...table(
        "Model portfolio by provider",
        ["provider", "models by tokens"],
        groups.map((group) => [group.label, tokenMix(group.models)]),
      ),
    )
    lines.push(
      ...table(
        "Capacity & reliability",
        ["provider", "tok/$", "tok/call", "output", "errors", "aborted", "completed", "recent cost/day"],
        groups.map((group) => [
          group.label,
          group.cost > 0 ? formatNumber(group.tokens.total / group.cost) : "—",
          formatNumber(ratio(group.tokens.total, group.assistantCalls)),
          percentage(group.tokens.output + group.tokens.reasoning, group.tokens.total),
          highOutlier(
            group.errors,
            report.providers.map((item) => item.errors),
            formatNumber,
          ),
          highOutlier(
            group.aborted,
            report.providers.map((item) => item.aborted),
            formatNumber,
          ),
          String(Math.max(0, group.requests - group.errors - group.aborted)),
          sparkline(series.find((item) => item.id === group.id)?.points.map((point) => point.cost) ?? [], 12),
        ]),
      ),
    )
  }
  if (by === "agent" || by === "source") {
    lines.push(
      ...table(
        by === "agent" ? "Agent workload" : "Source workload",
        [
          by,
          "tokens",
          "sessions",
          "cost",
          "owned req",
          "calls",
          "calls/req",
          "tok/session",
          "tok/req*",
          "cost/req*",
          "cache",
          "owner fail",
          "owner avg",
        ],
        groups.map((group) => [
          group.label,
          formatNumber(group.tokens.total),
          String(group.sessions),
          priced(group.cost),
          String(group.requests),
          String(group.assistantCalls),
          group.requests > 0 ? ratio(group.assistantCalls, group.requests).toFixed(1) : "—",
          formatNumber(ratio(group.tokens.total, group.sessions)),
          group.requests > 0 ? formatNumber(group.tokens.total / group.requests) : "—",
          group.requests > 0 ? priced(group.cost / group.requests) : "—",
          percentage(group.tokens.cache.read + group.tokens.cache.write, group.tokens.total),
          ...health(group),
        ]),
      ),
    )
    // Source缺旧组件归因时明确不可用；Agent仍逐一展示十类，共用行内完整分母。
    lines.push(
      ...table(
        "Input context composition",
        [by, "input components"],
        groups.map((group) => {
          const parts = components(group)
          const total = parts.reduce((sum, [, value]) => sum + value, 0)
          return [
            group.label,
            total > 0
              ? by === "source"
                ? mixText(
                    parts.map(([id, value]) => ({ id, value })),
                    5,
                  )
                : parts.map(([label, value]) => `${label} ${percentage(value, total)}`).join(" · ")
              : "component attribution unavailable for these records",
          ]
        }),
      ),
    )
    lines.push("* request-owner denominator and health; legacy Assistant usage has no owned request.")
  }
  if (by === "project") {
    lines.push(
      ...table(
        "Project portfolio",
        [
          "project",
          "path",
          "tokens",
          "share",
          "cost",
          "sessions",
          "requests",
          "calls",
          "active days",
          "owner fail",
          "owner avg",
        ],
        groups.map((group) => [
          group.label,
          report.projects.find((item) => item.id === group.id)?.path || "Path unavailable",
          formatNumber(group.tokens.total),
          percentage(group.tokens.total, report.total.tokens.total),
          priced(group.cost),
          String(group.sessions),
          String(group.requests),
          String(group.assistantCalls),
          String(
            series
              .find((item) => item.id === group.id)
              ?.points.filter((point) => point.tokens.total > 0 || point.cost > 0 || point.requests > 0).length ?? 0,
          ),
          ...health(group),
        ]),
      ),
    )
    // 使用稳定project ID找会话，同名目录或Project标签不能混合归属。
    lines.push(
      ...table(
        "Largest sessions inside each project",
        ["project", "session", "tokens", "cost", "requests"],
        groups.map((group) => {
          const session = report.sessions
            .filter((item) => item.projectID === group.id)
            .toSorted((a, b) => b.tokens.total - a.tokens.total)[0]
          return [
            group.label,
            session?.title ?? "—",
            formatNumber(session?.tokens.total ?? 0),
            priced(session?.cost ?? 0),
            String(session?.requests ?? 0),
          ]
        }),
      ),
    )
  }
  if (by !== "status")
    lines.push(
      ...table(
        by === "model" ? "Runtime mix" : "Routing mix",
        [by, "models by tokens", "providers by tokens", "tools by calls"],
        groups.map((group) => [group.label, tokenMix(group.models), tokenMix(group.providers), callMix(group.id)]),
      ),
    )
  if (by === "status") {
    const outcomes = all.filter((group) => group.id !== "unattributed")
    const total = outcomes.reduce((sum, group) => sum + group.requests, 0)
    const count = (id: string) => outcomes.find((group) => group.id === id)?.requests ?? 0
    lines.push(
      `Request outcomes · ${total} total · ${count("completed")} completed · ${count("error")} error · ${count("aborted")} aborted · ${count("running")} running`,
    )
    lines.push(
      ...table(
        "Outcome distribution",
        ["status", "requests", "req share", "tokens", "cost"],
        outcomes.map((group) => [
          group.label,
          String(group.requests),
          percentage(group.requests, total),
          formatNumber(group.tokens.total),
          priced(group.cost),
        ]),
      ),
    )
    lines.push(
      ...table(
        "Status efficiency",
        ["status", "tokens/req", "cost/req", "calls/req", "cache", "output", "sessions"],
        outcomes.map((group) => [
          group.label,
          group.requests > 0 ? formatNumber(group.tokens.total / group.requests) : "—",
          group.requests > 0 ? priced(group.cost / group.requests) : "—",
          group.requests > 0 ? (group.assistantCalls / group.requests).toFixed(1) : "—",
          percentage(group.tokens.cache.read + group.tokens.cache.write, group.tokens.total),
          percentage(group.tokens.output + group.tokens.reasoning, group.tokens.total),
          String(group.sessions),
        ]),
      ),
    )
    const unattributed = all.find((group) => group.id === "unattributed")
    if (unattributed)
      lines.push(
        `Unattributed usage · ${formatNumber(unattributed.tokens.total)} tokens · ${priced(unattributed.cost)} · no owning request outcome`,
      )
    const failures = report.total.errors + report.total.aborted
    lines.push(
      ...table(
        "Failure leaders within each dimension",
        ["dimension", "leader", "failed req", "rate in leader", "share of all failures"],
        [
          { label: "model", groups: report.models },
          { label: "provider", groups: report.providers },
          { label: "source", groups: report.sources },
          { label: "agent", groups: report.agents },
          { label: "project", groups: report.projects },
        ].map((dimension) => {
          const leader = dimension.groups.toSorted((a, b) => b.errors + b.aborted - a.errors - a.aborted)[0]
          const failed = (leader?.errors ?? 0) + (leader?.aborted ?? 0)
          return [
            dimension.label,
            leader?.label ?? "—",
            String(failed),
            percentage(failed, leader?.requests ?? 0),
            percentage(failed, failures),
          ]
        }),
      ),
    )
    lines.push("Outcome ratios exclude unattributed usage. Each leader row is an independent query, not a partition.")
  }
  return lines.flatMap((line) => wrapVisible(line))
}
