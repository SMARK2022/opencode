
import { formatNumber } from "../format"
import type { DailyUsage, StatsReport, UsageGroup, TokenTotals } from "./stats-data"

// #174：ChartColor 在无色模式映射为空前缀
export type ChartColor = "red" | "green" | "blue" | "yellow" | "magenta" | "cyan" | "white" | "gray"
// #174：ChartStyle 默认实线，供折线面积共用
export type ChartStyle = { color?: ChartColor; bold?: boolean }
// #174：ChartPoint 携带类别/时间键与数值供图元消费
export type ChartPoint = { x: string | number; y: number; label?: string }
// #174：ChartSeries 保留 id/label，图例与数据对齐
export type ChartSeries = { id: string; label: string; points: ChartPoint[]; style?: ChartStyle }
// #174：ChartLayer 声明取值函数，堆叠按声明顺序累加
export type ChartLayer = { id: string; label: string; color?: ChartColor; value: (d: DailyUsage) => number }
// #174：HeatPoint 含 day/dow/value，供周×星期密度格
export type HeatPoint = { day: number; dow: number; value: number; label?: string }
// #174：HistogramBucket 保存界与频次，溢出并入末桶
export type HistogramBucket = { lo: number; hi: number; count: number }

// #174：CSI 正则只用于剥色测宽
const CSI = /\x1b\[[0-9;]*m/g
// #174：RESET 与颜色前缀成对
const RESET = "\x1b[0m"
// #174：BOLD 可选强调
const BOLD = "\x1b[1m"
// #174：COLORS 映射终端色。
// R6 系列色使用终端 bright 槽位，正文使用默认前景，保留用户主题的对比度。
const COLORS: Record<string, string> = {
  red: "\x1b[91m", green: "\x1b[92m", blue: "\x1b[94m", yellow: "\x1b[93m",
  magenta: "\x1b[95m", cyan: "\x1b[96m", white: "\x1b[39m", gray: "\x1b[90m",
}
// #174：DENSITY 供热力/矩阵相对强度
// #174：密度字符只编码相对强度
const DENSITY = " ·░▒▓█"

// #174：visibleLength 忽略 CSI 占列
// #174：测宽忽略 CSI 控制序列

// #176：组合音标/ZWJ 等零宽码点不计列宽
const isCombining = (code: number) =>
  (code >= 0x0300 && code <= 0x036f) ||
  (code >= 0x1ab0 && code <= 0x1aff) ||
  (code >= 0x1dc0 && code <= 0x1dff) ||
  (code >= 0x20d0 && code <= 0x20ff) ||
  (code >= 0xfe20 && code <= 0xfe2f) ||
  (code >= 0xfe00 && code <= 0xfe0f) ||
  code === 0x200d

// #176：CJK/全角等宽字符占两列，避免终端裁切错位
const isWide = (code: number) =>
  code >= 0x1100 &&
  (code <= 0x115f ||
    code === 0x2329 ||
    code === 0x232a ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe10 && code <= 0xfe19) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x20000 && code <= 0x2fffd) ||
    (code >= 0x30000 && code <= 0x3fffd))

// #176：单码点显示列宽：宽=2，组合=0，其余=1
const charWidth = (code: number) => {
  if (isCombining(code)) return 0
  if (isWide(code)) return 2
  return 1
}

export const visibleLength = (text: string) => {
  // #176：先剥 CSI 再按显示列宽累加，而非 UTF-16 length
  const plain = text.replace(CSI, "")
  let width = 0
  for (const ch of plain) {
    width += charWidth(ch.codePointAt(0) ?? 0)
  }
  return width
}
// #174：stripAnsi 专供测宽
export const stripAnsi = (text: string) => text.replace(CSI, "")
// #174：padEnd 按可见列补空
export const padEndVisible = (text: string, width: number) => {
  const v = visibleLength(text)
  return v >= width ? text : text + " ".repeat(width - v)
}
// #174：padStart 按可见列补空
export const padStartVisible = (text: string, width: number) => {
  const v = visibleLength(text)
  return v >= width ? text : " ".repeat(width - v) + text
}
// #174：面板宽夹在下限与 stdout.columns 之间
export const statsPanelWidth = () => Math.max(40, Math.min(120, (process.stdout.columns || 80) - 4))
// #174：内容宽先扣边距再交给图元
export const statsContentWidth = () => Math.max(36, statsPanelWidth() - 4)
// #174：truncate 按可见宽截断并加省略
// #174：按可见宽截断并加省略号
export const truncateVisible = (text: string, width: number) => {
  // #176：按显示列宽截断，预留 1 列给省略号
  const plain = stripAnsi(text)
  if (visibleLength(plain) <= width) return text
  const budget = Math.max(0, width - 1)
  let out = ""
  let used = 0
  for (const ch of plain) {
    const w = charWidth(ch.codePointAt(0) ?? 0)
    if (used + w > budget) break
    out += ch
    used += w
  }
  return out + "…"
}
// #174：fitVisible 先截断再垫到目标可见宽
export const fitVisible = (text: string, width: number) => padEndVisible(truncateVisible(text, width), width)
// #174：paint 在 never/非 TTY 去颜色码
// #174：非 TTY 或 never 时去 ANSI
export const paint = (text: string, color?: ChartColor, ctx?: unknown, bold?: boolean) => {
  // 输出端消费同一模式裁决；省略context的片段也遵守NO_COLOR，always仍可显式开启。
  const mode = (ctx as { color?: string } | undefined)?.color ?? renderContext().color
  if (mode === "never") return stripAnsi(text)
  if (mode !== "always" && !process.stdout.isTTY) return stripAnsi(text)
  const pref = (bold ? BOLD : "") + (color ? COLORS[color] || "" : "")
  // foreground不会自行清除dim/bold；片段起点先复位强度，防止继承上一个样式。
  return pref ? "\x1b[22m\x1b[39m" + pref + text + RESET : text
}

// #181：序列 sparkline，窄宽时由调用方关闭
// #181：宽表趋势列用的迷你柱序
export const sparkline = (values: number[], width: number) => {
  if (width <= 0 || values.length === 0) return ""
  // #181：8 阶块字符，低值也不留白
  const glyphs = "▁▂▃▄▅▆▇█"
  const safe = values.map((v) => (Number.isFinite(v) ? v : 0))
  // #181：全 0 序列仍可出平底 sparkline
  const max = Math.max(1, ...safe)
  const buckets: number[] = []
  if (safe.length <= width) {
    // #181：点数不足时逐点绘制，右侧重复末值稳定列宽
    buckets.push(...safe)
    while (buckets.length < width) buckets.push(safe.at(-1) ?? 0)
  } else {
    // #181：超采样按桶取峰值聚合，禁止步进丢点导致尖峰消失
    for (let i = 0; i < width; i++) {
      const lo = Math.floor((i * safe.length) / width)
      const hi = Math.max(lo + 1, Math.floor(((i + 1) * safe.length) / width))
      buckets.push(Math.max(...safe.slice(lo, hi)))
    }
  }
  // #181：输出纯字符，不含 ANSI
  return buckets
    .slice(0, width)
    .map((v) => glyphs[Math.min(glyphs.length - 1, Math.max(0, Math.round((v / max) * (glyphs.length - 1))))])
    .join("")
}

// #174：renderContext 一次缓存宽度与颜色模式
export const renderContext = (color?: string) => ({
  // R6 truthy NO_COLOR 契约：always 恒开；never 恒关；auto 在非 TTY 或非空
  // NO_COLOR 下禁用（空字符串按 truthiness 等同未设置，与源 0174 语义一致）。
  color: color === "never" || (color !== "always" && (!process.stdout.isTTY || !!process.env.NO_COLOR)) ? "never" : color || "auto",
  width: statsContentWidth(),
})
// #174：指标展示统一 formatNumber
export const metricFormatter = (v: number) => formatNumber(v)
// #174：UsageGroup 转 series 保留 id/label
export const seriesFromUsage = (groups: UsageGroup[], metric: "tokens" | "cost" = "cost"): ChartSeries[] =>
  groups.map((g) => ({
    id: g.id,
    label: g.label || g.id,
    points: [{ x: g.label || g.id, y: metric === "cost" ? g.cost : g.tokens.total }],
  }))
// #174：input/output/cache 层与分列绑定
export const layersFromTokenParts = (): ChartLayer[] => [
  { id: "input", label: "Input", color: "cyan", value: (d) => d.tokens.input },
  { id: "output", label: "Output", color: "green", value: (d) => d.tokens.output + d.tokens.reasoning },
  { id: "cacheRead", label: "Cache Read", color: "blue", value: (d) => d.tokens.cache.read },
  { id: "cacheWrite", label: "Cache Write", color: "magenta", value: (d) => d.tokens.cache.write },
]
// #174：dailySeries 排序后再绘，拒绝乱序
export const dailySeries = (daily: DailyUsage[], pick: (d: DailyUsage) => number, id = "daily"): ChartSeries => ({
  id,
  label: id,
  points: [...daily].sort((a, b) => a.day - b.day).map((d) => ({ x: d.label, y: pick(d) })),
})

// #174：bar 生成重复块字符
const bar = (n: number, width: number, ch = "█") => ch.repeat(Math.max(0, Math.min(width, Math.round(n))))
// #174：maxY 至少为 1 避免除零
const maxY = (pts: ChartPoint[]) => Math.max(1, ...pts.map((p) => p.y))

// #174：line 按点列输出，非热力格
// #174：折线用点列输出，与热力格不同
// #174：renderRoundedLineChart 服务时间线折线，不承担 heatmap 命令
export const renderRoundedLineChart = (input: { title?: string; series: ChartSeries[]; width?: number; height?: number }) => {
  const w = input.width ?? Math.min(60, statsContentWidth())
  const series = input.series.filter((item) => item.points.length > 0)
  if (series.length === 0) return [input.title || "line", "(empty)"].filter(Boolean) as string[]
  const m = Math.max(...series.map((item) => maxY(item.points)))
  const lines = input.title ? [input.title] : []
  // 多序列共用刻度并保留身份，预测上下界和各工具趋势不能静默退成第一条。
  for (const item of series) {
    if (series.length > 1) lines.push(fitVisible(item.label || item.id, w))
    for (const p of item.points) {
      const n = Math.round((p.y / m) * 20)
      lines.push(`${fitVisible(String(p.x), 8)} ${bar(n, 20, "•")}${n ? "" : "·"} ${formatNumber(p.y)}`)
    }
  }
  return lines
}

// #174：stacked 按层输出分量文本
// #174：堆叠按层输出分量，缺层不插值
export const renderStackedAreaChart = (input: { title?: string; daily: DailyUsage[]; layers: ChartLayer[]; width?: number }) => {
  const lines = input.title ? [input.title] : []
  const width = Math.max(1, input.width ?? Math.min(40, statsContentWidth() - 12))
  const max = Math.max(1, ...input.daily.map((day) => input.layers.reduce((sum, layer) => sum + layer.value(day), 0)))
  // 同一时间轴和总量刻度呈现组成，图例保留每个分量的名字。
  lines.push(input.layers.map((layer, index) => `${"█▓▒░"[index % 4]} ${layer.label}`).join("  "))
  for (const d of input.daily) {
    const stack = input.layers.map((layer, index) => bar(layer.value(d) / max * width, width, "█▓▒░"[index % 4])).join("")
    const parts = input.layers.map((layer) => `${layer.label}:${formatNumber(layer.value(d))}`)
    lines.push(`${fitVisible(d.label, 8)} ${stack} ${parts.join(" ")}`)
  }
  return lines.length ? lines : ["(empty stack)"]
}

// #174：stream 紧凑实现复用堆叠文本路径
export const renderStreamStackChart = (input: { title?: string; daily: DailyUsage[]; layers: ChartLayer[] }) =>
  renderStackedAreaChart(input)

// #174：周×星期密度非折线：只读报告生成终端行，不写库
// #174：renderHeatmap 输出密度格/矩阵语义，供 heatmap 命令使用
export const renderHeatmap = (input: {
  title?: string
  points: HeatPoint[]
  color?: string
  width?: number
  formatter?: (n: number) => string
}) => {
  const lines = input.title ? [paint(input.title, "cyan", renderContext(input.color), true)] : []
  const points = input.points.toSorted((a, b) => a.day - b.day)
  const hi = Math.max(1, ...points.map((point) => point.value))
  const weeks = new Map<number, { label: string; values: Map<number, number> }>()
  // 本地周一作为行键，保留完整请求区间；毫秒尾数不能作为可读日期。
  for (const point of points) {
    const monday = new Date(point.day)
    monday.setDate(monday.getDate() - point.dow)
    monday.setHours(0, 0, 0, 0)
    const week = weeks.get(monday.getTime()) ?? { label: `${String(monday.getMonth() + 1).padStart(2, "0")}-${String(monday.getDate()).padStart(2, "0")}`, values: new Map<number, number>() }
    week.values.set(point.dow, point.value)
    weeks.set(monday.getTime(), week)
  }
  if (points.length) lines.push(`${points[0].label ?? ""} .. ${points.at(-1)?.label ?? ""}`)
  lines.push("       Mo Tu We Th Fr Sa Su")
  for (const week of weeks.values()) {
    let row = week.label
    for (let dow = 0; dow < 7; dow++) {
      const v = week.values.get(dow) ?? 0
      const idx = Math.min(DENSITY.length - 1, Math.round((v / hi) * (DENSITY.length - 1)))
      row += `  ${DENSITY[idx]}`
    }
    lines.push(row)
  }
  if (points.length === 0) lines.push("(empty heatmap)")
  return lines
}

// #174：histogram 在 min-max 间均分桶
// #174：直方图在 min-max 间均分桶宽
export const renderHistogram = (input: { title?: string; values: number[]; bins?: number }) => {
  const bins = input.bins ?? 8
  const vs = input.values.filter((v) => Number.isFinite(v))
  const lines = input.title ? [input.title] : []
  if (!vs.length) return [...lines, "(empty hist)"]
  const lo = Math.min(...vs)
  const hi = Math.max(...vs)
  const width = hi === lo ? 1 : (hi - lo) / bins
  const counts = Array.from({ length: bins }, () => 0)
  for (const v of vs) {
    const i = Math.min(bins - 1, Math.floor((v - lo) / width))
    counts[i]++
  }
  const m = Math.max(1, ...counts)
  counts.forEach((c, i) => {
    lines.push(`${fitVisible(formatNumber(lo + i * width), 8)} ${bar(c / m * 20, 20)} ${c}`)
  })
  return lines
}

// #174：rank 条相对当前页最大值
// #174：条长相对当前页最大值缩放
export const renderRankBars = (input: { title?: string; series?: ChartSeries[]; rows?: { label: string; value: number }[]; width?: number } | { label: string; value: number }[]) => {
  // support both call shapes used by render pages
  const rows = Array.isArray(input)
    ? input
    : input.rows || (input.series ? input.series.flatMap((s) => s.points.map((p) => ({ label: String(p.label ?? p.x), value: p.y }))) : [])
  const title = Array.isArray(input) ? undefined : input.title
  const lines = title ? [title] : []
  const m = Math.max(1, ...rows.map((r) => r.value), 0)
  for (const r of rows.slice(0, 20)) {
    lines.push(`${fitVisible(r.label, 14)} ${bar(r.value / m * 16, 16)} ${formatNumber(r.value)}`)
  }
  return lines.length ? lines : ["(empty ranks)"]
}

// #174：matrix 单元格用密度字符编码强度
// #174：矩阵横纵为 provider/model 交叉
export const renderMatrix = (input: { title?: string; rows: string[]; cols: string[]; values: number[][]; width?: number }) => {
  const lines = input.title ? [input.title] : []
  const hi = Math.max(1, ...input.values.flat(), 0)
  lines.push("     " + input.cols.map((c) => fitVisible(c, 4)).join(" "))
  input.rows.forEach((r, i) => {
    const cells = (input.values[i] || []).map((v) => {
      const idx = Math.min(DENSITY.length - 1, Math.round((v / hi) * (DENSITY.length - 1)))
      return `  ${DENSITY[idx]}`
    })
    lines.push(`${fitVisible(r, 5)}${cells.join("")}`)
  })
  return lines
}

// #174：waterfall 步进表示增量而非绝对值
export const renderWaterfall = (input: { title?: string; steps: { label: string; delta: number }[] }) => {
  const lines = input.title ? [input.title] : []
  let acc = 0
  for (const s of input.steps) {
    acc += s.delta
    lines.push(`${fitVisible(s.label, 12)} ${s.delta >= 0 ? "+" : ""}${formatNumber(s.delta)} → ${formatNumber(acc)}`)
  }
  return lines
}

// #174：horizon 用短字符带压缩长序列
export const renderHorizon = (input: { title?: string; series: ChartSeries }) => {
  const lines = input.title ? [input.title] : []
  const pts = input.series.points
  const m = maxY(pts)
  lines.push(pts.map((p) => DENSITY[Math.min(5, Math.round((p.y / m) * 5))]).join(""))
  return lines
}

// #174：共享尺度子图：只读报告生成终端行，不写库
export const renderSmallMultiples = (input: { title?: string; series: ChartSeries[] }) => {
  const lines = input.title ? [input.title] : []
  for (const s of input.series.slice(0, 6)) {
    lines.push(s.label)
    lines.push(...renderRoundedLineChart({ series: [s], width: 40 }))
  }
  return lines
}

// #174：donut 用条长近似占比，过小合并 other 语义由调用方处理
export const renderCompositionDonut = (input: { title?: string; parts: { label: string; value: number }[] }) => {
  const lines = input.title ? [input.title] : []
  const sum = Math.max(1, input.parts.reduce((a, p) => a + p.value, 0))
  for (const p of input.parts) {
    const pct = (p.value / sum) * 100
    lines.push(`${fitVisible(p.label, 12)} ${bar(pct / 5, 20)} ${pct.toFixed(1)}%`)
  }
  return lines
}

// #174：面板先扣边框再绘制正文
export const renderPanel = (title: string, body: string[]) => [`┌─ ${title}`, ...body.map((l) => `│ ${l}`), "└─"]
// #174：半宽拆栏，中缝固定，不错行
export const renderTwoColumn = (left: string[], right: string[]) => {
  const n = Math.max(left.length, right.length)
  const w = Math.floor((statsContentWidth() - 3) / 2)
  const lines: string[] = []
  for (let i = 0; i < n; i++) {
    lines.push(`${fitVisible(left[i] || "", w)} │ ${fitVisible(right[i] || "", w)}`)
  }
  return lines
}
// #174：够宽三栏，过窄改单栏堆叠
export const renderThreeColumn = (a: string[], b: string[], c: string[]) => {
  if (statsContentWidth() < 90) return [...a, ...b, ...c]
  const w = Math.floor((statsContentWidth() - 6) / 3)
  const n = Math.max(a.length, b.length, c.length)
  const lines: string[] = []
  for (let i = 0; i < n; i++) {
    lines.push(`${fitVisible(a[i] || "", w)} │ ${fitVisible(b[i] || "", w)} │ ${fitVisible(c[i] || "", w)}`)
  }
  return lines
}
// #174：丝带标量来自 totals，不重新聚合
export const renderMetricRibbon = (metrics: { label: string; value: string }[]) => [
  metrics.map((m) => `${m.label}:${m.value}`).join("  "),
]
// #174：页签只改标题高亮，不触发 loadReport
export const renderTabs = (tabs: { id: string; label: string; active?: boolean }[]) => [
  tabs.map((t) => (t.active ? `[${t.label}]` : t.label)).join("  "),
]
// #174：叙事只输出给定文案行，不算新指标
export const renderNarrative = (lines: string[]) => lines.map((l) => `  ${l}`)
// #174：gauge 将 0..1 映射到条长并钳制
export const renderGauge = (input: { title?: string; value: number }) => {
  const v = Number.isFinite(input.value) ? Math.min(1, Math.max(0, input.value)) : 0
  const n = Math.round(v * 20)
  return [input.title || "gauge", `[${bar(n, 20)}${" ".repeat(20 - n)}] ${(v * 100).toFixed(0)}%`]
}
// #174：slope 只连首末点强调方向
export const renderSlopeChart = (input: { title?: string; series: ChartSeries }) => {
  const pts = input.series.points
  if (pts.length < 2) return [input.title || "slope", "(need 2 points)"]
  const a = pts[0]
  const b = pts[pts.length - 1]
  return [input.title || "slope", `${a.x}:${formatNumber(a.y)} → ${b.x}:${formatNumber(b.y)}`]
}
// #174：每列除以列和使总和 100%
export const renderPercentStack = (input: { title?: string; columns: { label: string; parts: { label: string; value: number }[] }[] }) => {
  const lines = input.title ? [input.title] : []
  for (const col of input.columns) {
    const sum = Math.max(1, col.parts.reduce((a, p) => a + p.value, 0))
    lines.push(col.label + " " + col.parts.map((p) => `${p.label}:${((p.value / sum) * 100).toFixed(0)}%`).join(" "))
  }
  return lines
}
// #174：日标签抽样显示，窄屏避免重叠
export const renderDayLabels = (daily: DailyUsage[], step = 1) => daily.filter((_, i) => i % step === 0).map((d) => d.label)
// #174：callout 标题与正文靠样式分层而非第二数据源
export const renderCallout = (title: string, body: string) => [`▸ ${title}`, `  ${body}`]
// #174：列宽按可见字符最大值决定
export const renderComparisonTable = (rows: string[][]) => rows.map((r) => r.map((c) => fitVisible(c, 12)).join("  "))
// #174：无数据输出 empty，保持管道可解析成功路径
export const renderEmptyState = (msg = "no data") => [`(empty) ${msg}`]

// helpers used by render pages
// #174：dailyTokenPoints 映射 day/dow/value
// #174：把 daily tokens 映射为 day/dow 热力点
// #174：dailyTokenPoints 把 daily 转为热力点 day/dow/value
export const dailyTokenPoints = (report: StatsReport): HeatPoint[] =>
  report.daily.flatMap((d) => {
    const dt = new Date(d.day)
    return [{ day: d.day, dow: (dt.getDay() + 6) % 7, value: d.tokens.total, label: d.label }]
  })
// #174：dailyCostPoints 映射费用密度
// #174：把 daily cost 映射为热力点
// #174：dailyCostPoints 把 daily 转为热力点 day/dow/value
export const dailyCostPoints = (report: StatsReport): HeatPoint[] =>
  report.daily.flatMap((d) => {
    const dt = new Date(d.day)
    return [{ day: d.day, dow: (dt.getDay() + 6) % 7, value: d.cost, label: d.label }]
  })
// #174：modelProviderMatrix 只读报告字段
// #174：交叉矩阵只读报告字段不查库
// #174：modelProviderMatrix 构造 provider×model 交叉表
export const modelProviderMatrix = (report: StatsReport) => {
  const providers = [...new Set(report.providers.map((p) => p.id))].slice(0, 8)
  const models = [...new Set(report.models.map((m) => m.id))].slice(0, 8)
  const values = models.map((m) => {
    const mg = report.models.find((x) => x.id === m)
    return providers.map((p) => mg?.providers.find((x) => x.id === p)?.tokens || 0)
  })
  return { rows: models, cols: providers, values }
}
