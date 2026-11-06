import type { StatsReport, TokenPartSeries, TokenTotals, UsageGroup, UsageSeries } from "./stats-data"
import { formatNumber } from "../format"
import {
  dailySeries,
  metricFormatter,
  palette,
  renderCallout,
  renderComparisonTable,
  renderHeatmap,
  renderPercentStack,
  renderPanel,
  renderRoundedLineChart,
  renderTabs,
  renderThreeColumn,
  renderTwoColumn,
  seriesFromUsage,
  seriesColor,
  padEndVisible,
  padStartVisible,
  statsContentWidth,
  terminalText,
  visibleLength,
  wrapAnsiVisible,
  wrapVisible,
  useColor,
  type ChartColor,
  type SeriesColor,
} from "./stats-charts"

export { formatNumber } from "../format"
export { useColor } from "./stats-charts"

const BOLD = "\x1b[1m"
const TEXT_RESET = "\x1b[22m\x1b[39m"
const theme = {
  // 页面别名只复用 charts 的唯一 ANSI palette，不能重新引入独立 RGB 色盘。
  title: palette.title,
  subtitle: palette.subtitle,
  muted: palette.muted,
  border: palette.grid,
  sep: palette.axis,
  blue: palette.blue,
  cyan: palette.cyan,
  green: palette.green,
  yellow: palette.yellow,
  orange: palette.orange,
  purple: palette.purple,
  pink: palette.pink,
  red: palette.red,
  white: palette.white,
  lavender: palette.purple,
  mauve: palette.pink,
  tealSoft: palette.cyan,
  amberSoft: palette.yellow,
  roseSoft: palette.red,
}

// 这些是源界面的布局取值，集中命名只改变代码组织，不能暗改断点、留白或可见行数。
const layout = {
  // 断点按内容列计算，已扣除终端边距与 panel padding；不能直接与 stdout.columns 比较。
  narrow: 60,
  columns: 100,
  wide: 130,
  gap: 5,
  // 半宽/三分宽的下限保留轴与短日期，不能拿整页的默认宽度强塞给嵌套图。
  minHalf: 30,
  minThird: 28,
  minText: 12,
  paragraphIndent: 2,
  halfFraction: 0.5,
  fields: { percent: 6, cost: 8, tokens: 8 },
  section: { minLabel: 8, reserved: 5, continuationIndent: 4 },
  chart: { axisWidth: 8, height: 8, healthHeight: 7, narrowHeight: 6, heatmapFraction: 0.7 },
  // 默认可见行随版面变化，但显式 limit 和汇总分母不受这些展示限额影响。
  rows: { narrow: 3, default: 5, analytical: 8, drivers: 3, mix: 3 },
  spark: { min: 8, max: 32, driver: 14, componentReserved: 66, driverLabelMax: 28 },
  activity: {
    minSide: 24,
    pairGap: 4,
    doubleCellWidth: 42,
    cellPadding: 2,
    dowMinBar: 6,
    dowReserved: 14,
    weekLabel: 4,
  },
  status: { minBar: 4, maxBar: 48, reserved: 60, label: 12, count: 6 },
  // 排名行需预留份额、金额、per-call 与分隔符，条长只能使用扣除这些字段后的空间。
  modelRank: {
    minLabel: 16,
    maxLabel: 30,
    minBar: 12,
    reserved: 43,
    perCall: 9,
    gap: 3,
    headingTokens: 6,
    barReserved: 10,
  },
  providerRank: {
    minBar: 20,
    inset: 2,
    legendWidth: 110,
    // 图例在此断点增加一列，不能用截短 Provider 名称来维持桌面列数。
    maxColumn: 38,
    minLabel: 8,
    reserved: 20,
    wideGap: 6,
    gap: 4,
    wideItems: 3,
    items: 2,
    tokenWidth: 7,
  },
  health: { narrow: 80, minSpark: 6, maxSpark: 24, reserved: 58, label: 14, value: 10, minChart: 18 },
  session: {
    leaderboardReserved: 40,
    // Leaderboard 条长以全局 Token 份额为量纲，和下方分桶的相对最大桶不同。
    minBar: 8,
    leftFraction: 0.42,
    bandReserved: 20,
    distributionReserved: 26,
    topBarMin: 18,
    topBarReserved: 14,
    titleMin: 20,
    titleReserved: 28,
    indent: 3,
    distributionLabel: 8,
    distributionCount: 4,
    bandCount: 5,
    populationLabel: 7,
    topShare: 5,
  },
} as const

// 高缓存是健康提示，sigma 是高侧风险；两类阈值独立维护，不能因为数值都很高就共用判定。
const healthThresholds = {
  cache: 0.95,
  samples: 3,
  warningSigma: 2,
  dangerSigma: 3,
  cacheStep: 10,
  stableCacheRange: 10,
} as const

// 量纲和状态的颜色都引用唯一 palette；实体系列仍由 seriesColor 保持跨区块身份。
const metricColor = {
  tokens: "blue",
  cost: "pink",
  requests: "green",
  cache: "yellow",
  failures: "red",
  latency: "purple",
} as const satisfies Record<string, ChartColor>

// 强度区间是跨窗口稳定的绝对量，不得随当前最大值重新缩放；图例也沿用这些源区间。
const activityIntensity = {
  // 日 Token 和小时请求数有不同单位，不能把一组阈值拿给两种活动图共用。
  tokens: [50_000_000, 150_000_000, 250_000_000],
  requests: [50, 150, 300],
  levels: [
    { char: "·", color: "muted" },
    { char: "░", color: "blue" },
    { char: "▒", color: "cyan" },
    { char: "▓", color: "purple" },
    { char: "█", color: "white" },
  ],
} as const

// 组件颜色表达固定 Token 语义，跨 Dashboard 和 Timeline 不随当日排名交换。
const tokenPartMeta = {
  // 无色模式仍保留组件纹理；颜色是附加编码，不能成为唯一身份信息。
  cacheRead: { color: "yellow", mark: "▓" },
  input: { color: "blue", mark: "░" },
  cacheWrite: { color: "purple", mark: "▒" },
  output: { color: "green", mark: "▎" },
} satisfies Record<TokenPartSeries["id"], { color: ChartColor; mark: string }>

// Provider 总览的源顺序不同于通用实体系列；只集中定义，不能合并成另一套身份顺序。
const providerColors = ["yellow", "green", "blue", "purple", "cyan", "pink"] as const
const providerMarks = ["▓", "█", "░", "▒", "▓", "▒"]
const sessionBandColors = ["muted", "lavender", "tealSoft", "mauve", "amberSoft"] as const

// Dashboard 与 Sessions 使用同一组固定档位，不能各自根据样本极值重分桶。
const sessionBands = {
  tokens: [
    // 区间左闭右开，50M 本身落在末桶；文案沿用固定源而不是动态根据最大值生成。
    { label: "<100K", min: 0, max: 100_000 },
    { label: "100K-1M", min: 100_000, max: 1_000_000 },
    { label: "1M-5M", min: 1_000_000, max: 5_000_000 },
    { label: "5M-50M", min: 5_000_000, max: 50_000_000 },
    { label: ">50M", min: 50_000_000, max: Number.POSITIVE_INFINITY },
  ],
  cost: [
    // 费用档位仅用于正费用样本，未知/未记录的零值不应被归入最便宜的一档。
    { label: "<$0.10", min: 0, max: 0.1 },
    { label: "$0.10-$1", min: 0.1, max: 1 },
    { label: "$1-$5", min: 1, max: 5 },
    { label: "$5-$10", min: 5, max: 10 },
    { label: ">$10", min: 10, max: Number.POSITIVE_INFINITY },
  ],
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
const color = (text: string, name: keyof typeof theme, enabled: boolean, bold = false) => {
  // disabled 必须返回原文本而非带 reset 的文本，否则 never 仍会向管道发射不可见控制字节。
  if (!enabled) return text
  return `${bold ? BOLD : ""}${theme[name]}${text}${TEXT_RESET}`
}
const panel = (lines: string[], enabled: boolean) => {
  // 最终换行、padding 和默认背景复位只有 Charts 一处实现；不让各页面复制后产生间距分叉。
  return renderPanel({ lines, color: enabled ? "always" : "never" })
}
const dateRange = (report: StatsReport) => {
  // requestedDays 是用户意图；undefined 必须显示 all-time，而不是猜测首尾日期。
  if (report.requestedDays === 0) return "Today"
  if (report.requestedDays) return `Last ${report.requestedDays} days`
  return "All time"
}
const shortDate = (time: number) => {
  const date = new Date(time)
  return `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`
}
const money = (value: number) => {
  // 页面金额与坐标轴的紧凑 formatter 不同；小额费用需四位小数，不能用整数 Token 格式器。
  // 紧凑金额格式按量级减少小数，零值使用破折号以降低表格噪声。
  if (!Number.isFinite(value) || value <= 0) return "—"
  if (value >= 100) return `$${value.toFixed(0)}`
  if (value >= 10) return `$${value.toFixed(1)}`
  if (value >= 1) return `$${value.toFixed(2)}`
  return `$${value.toFixed(4)}`
}
const percent = (value: number, total: number) => {
  // 零分母统一为 0%，任何页面都不应泄漏 NaN/Infinity。
  if (!total) return "0.0%"
  return `${((value / total) * 100).toFixed(1)}%`
}
const metricBar = (value: number, max: number, width: number, enabled: boolean, name: keyof typeof theme) => {
  // max 由所属视图决定，可以是全局 Token 或最大桶；此 primitive 不擅自重算统计分母。
  const filled = max <= 0 ? 0 : Math.round((value / max) * width)
  return color("█".repeat(filled), name, enabled) + color("░".repeat(Math.max(0, width - filled)), "border", enabled)
}
const title = (text: string, enabled: boolean) => color(text, "title", enabled, true)
const muted = (text: string, enabled: boolean) => color(text, "muted", enabled)
const sep = (enabled: boolean) => color(" · ", "sep", enabled)
const clipVisible = (text: string, width: number) => {
  // 只用于有独立完整名称 key 的紧凑图元，最终 panel 走 wrap，不把此行为扩散到整页。
  if (visibleLength(text) <= width) return text
  return Array.from(text).reduce((acc, char) => (visibleLength(acc + char) > width ? acc : acc + char), "")
}
const fitPlain = (text: string, width: number) => padEndVisible(clipVisible(text, width), width)
const wrapWhenNeeded = (text: string, width: number) =>
  visibleLength(text) <= width ? [text] : wrapVisible(text, width)
const fullChartWidth = () => Math.max(layout.minText, statsContentWidth() - layout.chart.axisWidth)
// 图元接收的是 plot 宽度而非整行宽度，Y 标签必须在上层分配的物理行内留出位置。
// plot 预留 Y 轴和一个空格；最小值只保证坐标可读，不强制桌面宽度。
const terminalContentWidth = () => statsContentWidth()
const layoutModeFor = (width: number) => (width >= layout.wide ? "wide" : "medium")
const chartPlotWidth = (availableWidth: number) => Math.max(layout.minText, availableWidth - layout.chart.axisWidth)
const dailyTokenPoints = (report: StatsReport) =>
  report.daily.map((item) => ({ day: item.day, label: shortDate(item.day), value: item.tokens.total }))
const dailyCostPoints = (report: StatsReport) =>
  report.daily.map((item) => ({ day: item.day, label: shortDate(item.day), value: item.cost }))
const dailyCacheHitPoints = (report: StatsReport) =>
  // hit rate 只观察 read；Header 的 cache 总份额还包含 write，两者不能因名字相近被合并。
  report.daily.map((item) => ({
    day: item.day,
    label: shortDate(item.day),
    value: item.tokens.total > 0 ? (item.tokens.cache.read / item.tokens.total) * 100 : 0,
  }))
const dailyErrorRatePoints = (report: StatsReport) =>
  // 当天结果数与当天请求数配对，不能把请求高低波动误画成错误率波动。
  report.daily.map((item) => ({
    day: item.day,
    label: shortDate(item.day),
    value: item.requests > 0 ? ((item.errors + item.aborted) / item.requests) * 100 : 0,
  }))
const safeDivide = (value: number, divisor: number) => {
  // 所有派生比率共用同一零值保护，避免不同端点出现不一致的异常格式。
  if (!divisor || !Number.isFinite(value) || !Number.isFinite(divisor)) return 0
  return value / divisor
}
const avgDuration = (durationMs: number, requests: number) => {
  // 时长是 request-owner 累计，除数不能换成 Assistant calls，否则多轮请求会显得异常更快。
  const seconds = safeDivide(durationMs, requests) / 1000
  if (seconds >= 60) return `${(seconds / 60).toFixed(1)}m`
  return `${seconds.toFixed(1)}s`
}
const cacheShare = (tokens: TokenTotals) => percent(tokens.cache.read + tokens.cache.write, tokens.total)
// Output 的摘要按源契约包括 reasoning；Model composition 的独立 reasoning 段仍保留。
const outputTokens = (tokens: TokenTotals) => tokens.output + tokens.reasoning
const inputContextTokens = (group: UsageGroup) =>
  // Context fingerprint 只统计输入构成，不把输出 token 重复计入上下文。
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
const sparkline = (values: number[], width: number, enabled: boolean, name: keyof typeof theme) => {
  // 每条短趋势以自身峰值归一化，用于看形状而非跨指标比较绝对高度。
  const chars = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"]
  const max = Math.max(0, ...values.filter(Number.isFinite))
  const sampled = Array.from({ length: width }, (_, index) => {
    // 压缩仅用于摘要 glyph；原日序列仍交给主图和表格，不能反过来拿这里的采样算总量。
    if (values.length === 0) return 0
    return values[Math.round((index / Math.max(1, width - 1)) * (values.length - 1))] ?? 0
  })
  return sampled
    .map((value) =>
      color(
        chars[max <= 0 ? 0 : Math.min(chars.length - 1, Math.floor((value / max) * (chars.length - 1)))],
        name,
        enabled,
      ),
    )
    .join("")
}
const breakdownTitle = (by: BreakdownDimension) => {
  // 标题映射是用户可见词汇，wrapper 和 canonical breakdown 必须共享。
  if (by === "model") return "Models"
  if (by === "provider") return "Providers"
  if (by === "agent") return "Agents"
  if (by === "source") return "Sources"
  if (by === "project") return "Projects"
  if (by === "status") return "Request status"
  return "Tools"
}
const breakdownPageTitle = (by: BreakdownDimension) => {
  if (by === "model") return "Model"
  if (by === "provider") return "Provider"
  if (by === "agent") return "Agent"
  if (by === "source") return "Source"
  if (by === "project") return "Project"
  if (by === "status") return "Status"
  return "Tool"
}
const breakdownGroups = (report: StatsReport, by: BreakdownDimension) => {
  // Tool 数据结构不同于 UsageGroup，工具分支在 renderBreakdown 中单独处理。
  if (by === "model") return report.models
  if (by === "provider") return report.providers
  if (by === "agent") return report.agents
  if (by === "source") return report.sources
  if (by === "project") return report.projects
  if (by === "status") return report.statuses
  return []
}
const breakdownSeries = (report: StatsReport, by: BreakdownDimension) => {
  // 聚合表和趋势必须取自同一维度，不能出现排名与折线标签错位。
  if (by === "model") return report.modelSeries
  if (by === "provider") return report.providerSeries
  if (by === "agent") return report.agentSeries
  if (by === "source") return report.sourceSeries
  if (by === "project") return report.projectSeries
  if (by === "status") return report.statusSeries
  return []
}
const statusColor = (status: string): SeriesColor => {
  // Outcome 颜色表达 success/error/warning，而不是该状态恰好排在第几个系列。
  // 未知或运行中状态回退为 info blue，避免误报成功或失败。
  if (status === "completed") return "green"
  if (status === "error") return "red"
  if (status === "aborted") return "yellow"
  return "blue"
}
type AnalyticalRow = { label: string; values: string[]; color?: SeriesColor; valueColors?: (SeriesColor | undefined)[] }
// 指标文本与可选语义色成对返回，保证 marker、颜色和格式化值不会在调用处各算一遍后漂移。
type AnalyticalValue = { text: string; color?: SeriesColor }
const highOutlier = (value: number, population: number[], format: (input: number) => string): AnalyticalValue => {
  // 调用方按指标提供可比较总体；这里不按当前页面的 Top N 再筛一次样本。
  // 格式化值保留原量纲，sigma 只决定标记，不能把表格中的费用替换为标准分数。
  const values = population.filter(Number.isFinite)
  const text = format(value)
  // 少于三个可比较样本或没有方差时，sigma 没有可靠区分力；此时只显示原始精确值。
  if (!Number.isFinite(value) || values.length < healthThresholds.samples) return { text }
  // 使用 population 标准差与 Insights 保持口径一致；这里描述当前完整集合，不估计外部样本。
  const average = values.reduce((sum, item) => sum + item, 0) / values.length
  const deviation = Math.sqrt(values.reduce((sum, item) => sum + (item - average) ** 2, 0) / values.length)
  // 只标记高侧异常；低费用、低失败率和低时延不是风险，不能用同一颜色制造反向告警。
  if (deviation === 0 || value <= average) return { text }
  const sigma = (value - average) / deviation
  // population 方差分母是 n，改成样本 n-1 会改变固定源的 2σ/3σ 边界与风险颜色。
  // 记号是无色模式的等价编码；颜色只加速扫描，不能成为异常结论的唯一载体。
  if (sigma >= healthThresholds.dangerSigma) return { text: `${text}!`, color: "red" }
  if (sigma >= healthThresholds.warningSigma) return { text: `${text}^`, color: "orange" }
  return { text }
}
// 宽屏用可横向比较的表格，窄屏改为完整标签加指标行。这里不截断实体名，
// 因为模型、项目和会话名称本身就是定位异常所需的数据，而不是装饰文本。
const renderAnalyticalTable = (input: {
  title: string
  label: string
  headers: string[]
  rows: AnalyticalRow[]
  identityColors?: boolean
  color?: ColorMode
}) => {
  // 宽屏保留列比较，窄屏改为逐实体 key/value；两种布局承载完全相同的数据。
  // 响应式判断只看可见宽度，不依赖 ANSI 字节数。
  const enabled = useColor(input.color)
  const width = statsContentWidth()
  // 表格单元均为数据文本而非受信样式，进入 chart primitive 前统一移除控制字节。
  const rows = input.rows.map((row, index) => ({
    label: terminalText(row.label),
    values: row.values.map(terminalText),
    // 第一列默认沿用趋势图系列色；调用方只需为异常值或短趋势显式指定 valueColors。
    // 只有跨 section 保持同一身份的实体才自动继承系列色；日期等普通排行继续使用默认前景。
    color: row.color ?? (input.identityColors ? seriesColor(index) : undefined),
    valueColors: row.valueColors,
  }))
  const table = renderComparisonTable({
    // 列定义和行值一次交给共享 primitive，宽窄分支随后复用同一批已清理数据。
    title: input.title,
    headers: [input.label, ...input.headers],
    rows: rows.map((row) => [row.label, ...row.values]),
    colors: rows.map((row) => [row.color, ...(row.valueColors ?? [])]),
    color: input.color,
  })
  const heading = [...renderSectionDivider(input.title, enabled, width), ""]
  // 只有完整实体名与全部列都能容纳时才使用横表；否则立即改为逐实体布局，不生成二次查找键。
  if (width >= layout.columns && table.every((line) => visibleLength(line) <= width))
    return [...heading, ...table.slice(1)]
  return [
    ...heading,
    ...rows.flatMap((row) => [
      // 名称独立成行才能保留长身份；编号缩写会迫使用户回表查找，不能替代完整 key。
      ...wrapVisible(row.label, width).map((line) => color(line, row.color ?? "white", enabled, true)),
      ...wrapAnsiVisible(
        input.headers
          .map(
            (header, column) =>
              `${muted(header, enabled)} ${color(row.values[column], row.valueColors?.[column] ?? "white", enabled, row.valueColors?.[column] !== undefined)}`,
          )
          .join(sep(enabled)),
        Math.max(layout.minText, width - layout.paragraphIndent),
      ).map((line) => `  ${line}`),
    ]),
  ]
}
// 活跃日由任一已记录用量决定，零费用的免费/缺价格记录仍可通过 Token 或 request 计入。
const activeDays = (series: UsageSeries | undefined) =>
  series?.points.filter((point) => point.tokens.total > 0 || point.cost > 0 || point.requests > 0).length ?? 0
// 失败率是 owning request 的结果比率，不能拿 Assistant 调用数当作更大的分母稀释失败。
const failureRate = (group: UsageGroup) => percent(group.errors + group.aborted, group.requests)
const renderBreakdownTrend = (
  groups: UsageGroup[],
  allSeries: UsageSeries[],
  metric: "tokens" | "cost",
  titleText: string,
  colorMode?: ColorMode,
) => {
  // 最多五条线与 Dashboard 的低重叠原则一致，更多实体留在下方分析表。
  const selected = groups.slice(0, layout.rows.default)
  // 五条趋势线与明细限额分别负责图形密度和行数；不能为更多行自动塞入更多重叠曲线。
  // selected 继承主排名的次序；趋势不是按各自峰值再次排名的第二套实体集合。
  // 颜色属于原可见实体位置；某条历史 series 缺失时，后续实体不能被压缩后重新编号。
  const identityColors = new Map(selected.map((group, index) => [group.id, seriesColor(index)]))
  const series = seriesFromUsage(
    selected.flatMap((group) => {
      // 某实体缺历史序列时只省略其线条，主体分析行与该实体原分配的颜色不受影响。
      const item = allSeries.find((candidate) => candidate.id === group.id)
      return item ? [item] : []
    }),
    metric,
    layout.rows.default,
  ).map((item) => ({ ...item, label: terminalText(item.label), color: identityColors.get(item.id) ?? seriesColor(0) }))
  // 线内不放点和文字；图下直接列完整名称与绝对量级，颜色不成为唯一归因手段。
  const title =
    // Source 的趋势代表请求来源，保留专属措辞，不能让默认分类标题误导为工具来源。
    titleText === "Sources"
      ? `${metric === "cost" ? "Cost" : "Token"} trend · request sources`
      : `${metric === "cost" ? "Cost" : "Token"} trend · top ${series.length} ${titleText.toLowerCase()}`
  const chart = renderRoundedLineChart({
    title,
    series,
    color: colorMode,
    metric,
    width: fullChartWidth(),
    height: layout.chart.height,
    points: false,
    legend: false,
  })
  return [
    ...renderSectionDivider(title, useColor(colorMode), statsContentWidth()),
    "",
    ...chart.slice(1),
    ...wrapAnsiVisible(
      // 画布标题已转为 section divider；完整名称和量级仍在下方保留，不使用编号图例。
      series
        .map((item) =>
          color(`${item.label} ${metricFormatter(metric)(item.total ?? 0)}`, item.color, useColor(colorMode), true),
        )
        .join(sep(useColor(colorMode))),
      statsContentWidth(),
    ),
  ]
}
const inputContextRows = (groups: UsageGroup[]) =>
  groups.map((group) => {
    // 十类输入属于同一分母；输出 Token 不属于输入上下文，reasoning 也须按此字段归属区分。
    // 每行以自身 context 为分母，才能比较不同规模实体的结构差异。
    const total = inputContextTokens(group)
    return {
      label: group.label,
      values: [
        // 列的顺序与 Agent 表头一一对应，不能为展示“更重要”的类别而单独重排百分比。
        percent(group.components.system, total),
        percent(group.components.instructions, total),
        percent(group.components.skills, total),
        percent(group.components.toolSchemas, total),
        percent(group.components.userMessages, total),
        percent(group.components.assistantText, total),
        percent(group.components.reasoning, total),
        percent(group.components.toolCalls, total),
        percent(group.components.toolResults, total),
        percent(group.components.attachments, total),
      ],
    }
  })
const mixText = (items: { id: string; value: number }[], limit: number = layout.rows.mix) => {
  // 零权重不参与归因排名；真实数据总和在 limit 前确定，other 的份额才不会被放大。
  // Mix 最多展开前三项；其余显式归入 other，百分比才能闭合为完整集合而不是静默消失。
  const sorted = [...items].filter((item) => item.value > 0).sort((a, b) => b.value - a.value)
  const total = sorted.reduce((sum, item) => sum + item.value, 0)
  if (total === 0) return "—"
  const other = sorted.slice(limit).reduce((sum, item) => sum + item.value, 0)
  // 列出 other 而不丢弃它，既控制长尾长度，也能解释前三项之外的剩余份额。
  return [...sorted.slice(0, limit), ...(other > 0 ? [{ id: "other", value: other }] : [])]
    .map((item) => `${terminalText(item.id)} ${percent(item.value, total)}`)
    .join(" · ")
}
const tokenMix = (items: { id: string; tokens: number }[]) =>
  mixText(items.map((item) => ({ id: item.id, value: item.tokens })))
const callMix = (calls: StatsReport["toolCalls"], pick: (call: StatsReport["toolCalls"][number]) => string) => {
  // 同一工具可有多个 issuing runtime tuple，必须先按所观察的身份汇总，再截取 Top N。
  // calls 已经过 CLI owner filter；这里仅切换观察维度，不再次改变样本集合。
  const totals = new Map<string, number>()
  calls.forEach((call) => totals.set(pick(call), (totals.get(pick(call)) ?? 0) + call.calls))
  return mixText(Array.from(totals, ([id, value]) => ({ id, value })))
}
const toolCallsFor = (
  report: StatsReport,
  key: "modelID" | "providerID" | "agent" | "projectID" | "source" | "status" | "toolID",
  id: string,
) =>
  // 关联键使用稳定 id 而不是可变 label，Project 同名时也不会把调用混在一起。
  report.toolCalls.filter((call) => call[key] === id)
const renderModelTokenComposition = (groups: UsageGroup[], options: StatsRenderOptions) => {
  // 五种计费 Token 与十类输入来源是不同分解；不能拿 context components 代替此组成条。
  // output 与 reasoning 在本节分开，Timeline 的 Output+Reasoning 则按它自身的已发布契约合并。
  const enabled = useColor(options.color)
  const width = statsContentWidth()
  return [
    ...renderSectionDivider("Token composition", enabled, width),
    "",
    ...renderPercentStack({
      width,
      color: options.color,
      rows: groups.map((group, index) => ({
        label: group.label,
        // 模型身份继续沿用主折线色；组成段颜色则固定表达 token 语义，二者不能混用。
        color: seriesColor(index),
        parts: [
          // cache write 在此使用独立 pink 段，不能与趋势小图的 purple 标记擅自统一。
          { label: "input", value: group.tokens.input, color: "blue" },
          { label: "output", value: group.tokens.output, color: "green" },
          { label: "reasoning", value: group.tokens.reasoning, color: "purple" },
          { label: "cache read", value: group.tokens.cache.read, color: "yellow" },
          { label: "cache write", value: group.tokens.cache.write, color: "pink" },
        ],
      })),
    }),
  ]
}

const renderDimensionDetails = (
  report: StatsReport,
  groups: UsageGroup[],
  by: Exclude<BreakdownDimension, "tool">,
  options: StatsRenderOptions,
) => {
  if (by === "model") {
    // Model 页先拆开 token 结构，再展示 Provider 路由和实际发起的 ToolPart。
    // 这两节分别回答“上下文为何大”和“模型被怎样路由/使用”，不能合成单一排行。
    return [
      ...renderModelTokenComposition(groups, options),
      "",
      ...renderAnalyticalTable({
        title: "Routing & tools",
        label: "model",
        identityColors: true,
        headers: ["provider mix by tokens", "issued tool calls"],
        // 两个 mix 分别按 Token 和真实 ToolPart 加权；不能复用一个百分比分母。
        rows: groups.map((group) => ({
          label: group.label,
          values: [
            tokenMix(group.providers),
            // 模型账本与工具只通过 modelID 关联，不从 Provider 路由份额估算工具量。
            callMix(toolCallsFor(report, "modelID", group.id), (call) => call.toolID),
          ],
        })),
        color: options.color,
      }),
      ...wrapVisible(
        "Tool shares count ToolParts issued by each model; they are not Tool cost or billed tokens.",
        statsContentWidth(),
      ).map((line) => muted(line, useColor(options.color))),
    ]
  }
  if (by === "provider") {
    // Provider 的模型组合解释容量来源，可靠性表则只使用该 Provider 拥有的 request 指标。
    // secondary Assistant 可能有 token/cost 却没有 owned req，这是合法的零值而非数据丢失。
    const series = breakdownSeries(report, "provider")
    // short trend 只观察本 Provider 的日费用，不复用整个报告的总费用曲线。
    // errors/aborted 是独立结果，分别比较才能避免一个字段掩盖另一个字段的尖峰。
    const errorPopulation = report.providers.map((group) => group.errors)
    const abortedPopulation = report.providers.map((group) => group.aborted)
    return [
      ...renderAnalyticalTable({
        title: "Model portfolio by provider",
        // 组合分母属于每个 Provider，自身内部构成不能被全局模型份额覆盖。
        label: "provider",
        identityColors: true,
        headers: ["models by tokens"],
        rows: groups.map((group) => ({ label: group.label, values: [tokenMix(group.models)] })),
        color: options.color,
      }),
      "",
      ...renderAnalyticalTable({
        title: "Capacity & reliability",
        // 原始结果数、费用效率与输出占比回答不同问题，不折算成一个不透明评分。
        label: "provider",
        identityColors: true,
        headers: ["tok/$", "tok/call", "output", "errors", "aborted", "completed", "recent cost/day"],
        rows: groups.map((group, index) => {
          const errors = highOutlier(group.errors, errorPopulation, formatNumber)
          const aborted = highOutlier(group.aborted, abortedPopulation, formatNumber)
          return {
            label: group.label,
            values: [
              group.cost > 0 ? formatNumber(safeDivide(group.tokens.total, group.cost)) : "—",
              // 每调用 Token 包含 secondary Assistant，即使本 Provider 没有 owning request。
              formatNumber(safeDivide(group.tokens.total, group.assistantCalls)),
              percent(outputTokens(group.tokens), group.tokens.total),
              errors.text,
              aborted.text,
              // completed 沿用源端剩余请求定义；不在页面另行回扫历史制造第二本 outcome 账。
              formatNumber(Math.max(0, group.requests - group.errors - group.aborted)),
              // Sparkline 是数据字符而非样式；保持无 ANSI，避免表格文本清理再次泄漏 SGR 参数。
              sparkline(
                series.find((item) => item.id === group.id)?.points.map((point) => point.cost) ?? [],
                12,
                false,
                "pink",
              ),
            ],
            // 原始 outcome 使用风险色，最后一列短趋势仍使用实体色；两套颜色分别回答异常与归属。
            valueColors: [undefined, undefined, undefined, errors.color, aborted.color, undefined, seriesColor(index)],
          }
        }),
        color: options.color,
      }),
    ]
  }
  if (by === "agent") {
    // Agent 需要完整十类 context 分母；只显示四类会让可见百分比无法解释剩余输入。
    return [
      ...renderAnalyticalTable({
        title: "Input context composition",
        label: "agent",
        identityColors: true,
        headers: [
          "system",
          "instruct",
          "skills",
          "schemas",
          "user",
          "assistant",
          "reasoning",
          "tool calls",
          "tool results",
          "attach",
        ],
        rows: inputContextRows(groups),
        color: options.color,
      }),
      "",
      ...renderAnalyticalTable({
        title: "Runtime mix",
        label: "agent",
        // 观察实际运行时路由，不能把 Agent 名机械映射为某个固定模型或 Provider。
        identityColors: true,
        headers: ["models by tokens", "providers by tokens", "tools by calls"],
        rows: groups.map((group) => ({
          label: group.label,
          values: [
            tokenMix(group.models),
            tokenMix(group.providers),
            callMix(toolCallsFor(report, "agent", group.id), (call) => call.toolID),
          ],
        })),
        color: options.color,
      }),
    ]
  }
  if (by === "source")
    return [
      ...renderAnalyticalTable({
        title: "Input context composition",
        label: "source",
        identityColors: true,
        headers: ["input components"],
        rows: groups.map((group) => {
          const total = inputContextTokens(group)
          // Source 的紧凑 mix 仍以十类输入为分母，展示五项不等于只统计五类。
          const values = [
            { id: "system", value: group.components.system },
            { id: "instructions", value: group.components.instructions },
            { id: "skills", value: group.components.skills },
            { id: "schemas", value: group.components.toolSchemas },
            { id: "user", value: group.components.userMessages },
            { id: "assistant", value: group.components.assistantText },
            { id: "reasoning", value: group.components.reasoning },
            { id: "tool calls", value: group.components.toolCalls },
            { id: "tool results", value: group.components.toolResults },
            { id: "attach", value: group.components.attachments },
          ]
          // 全零 breakdown 无法证明真实占比，明确标记 unavailable 比十个伪 0% 更安全。
          return {
            label: group.label,
            values: [total > 0 ? mixText(values, 5) : "component attribution unavailable for these records"],
          }
        }),
        color: options.color,
      }),
      "",
      ...renderAnalyticalTable({
        title: "Routing mix",
        label: "source",
        // 请求来源不限定 Assistant 实际经过的模型，两套身份都须保留。
        identityColors: true,
        headers: ["models by tokens", "providers by tokens"],
        rows: groups.map((group) => ({
          label: group.label,
          values: [tokenMix(group.models), tokenMix(group.providers)],
        })),
        color: options.color,
      }),
    ]
  if (by === "project") {
    // Project 路径已在 portfolio 中显示一次，后续表只复用 label，避免每节重复长目录。
    // 最大 Session 直接从已过滤 report.sessions 推导，不增加数据库查询或通用 cube。
    const projectLabels = new Map(report.projects.map((project) => [project.id, project.label]))
    // label 可改名或重复；连接 Session 始终使用 projectID，显示映射不能变成关联键。
    return [
      ...renderAnalyticalTable({
        title: "Runtime mix",
        label: "project",
        identityColors: true,
        headers: ["models by tokens", "providers by tokens", "tools by calls"],
        rows: groups.map((group) => ({
          label: group.label,
          values: [
            tokenMix(group.models),
            tokenMix(group.providers),
            callMix(toolCallsFor(report, "projectID", group.id), (call) => call.toolID),
          ],
        })),
        color: options.color,
      }),
      "",
      ...renderAnalyticalTable({
        title: "Largest sessions inside each project",
        // 从各项目完整会话集合选最大项，而非先截取全局排行榜再做项目筛选。
        label: "project",
        identityColors: true,
        headers: ["session", "tokens", "cost", "requests"],
        rows: groups.map((group) => {
          const session = report.sessions
            .filter((item) => item.projectID === group.id)
            .sort((a, b) => b.tokens.total - a.tokens.total)[0]
          // 无匹配会话时保留 unavailable，不能拿项目累计伪造一条最大会话。
          return {
            label: projectLabels.get(group.id) ?? group.label,
            values: session
              ? [session.title, formatNumber(session.tokens.total), money(session.cost), formatNumber(session.requests)]
              : ["—", "—", "—", "—"],
          }
        }),
        color: options.color,
      }),
    ]
  }
  // 一个失败请求会同时归属于 model/provider/source/agent/project；这些行是独立查询，不是互斥分区。
  const totalFailures = report.total.errors + report.total.aborted
  // 分母来自整个窗口的失败总量；五个视角不能因为展示五行就被当成互斥分区。
  const dimensions = [
    { label: "model", groups: report.models },
    { label: "provider", groups: report.providers },
    { label: "source", groups: report.sources },
    { label: "agent", groups: report.agents },
    { label: "project", groups: report.projects },
  ]
  return [
    ...renderAnalyticalTable({
      title: "Failure leaders within each dimension",
      label: "dimension",
      headers: ["leader", "failed req", "rate in leader", "share of all failures"],
      rows: dimensions.map((dimension) => {
        const leader = [...dimension.groups].sort((a, b) => b.errors + b.aborted - a.errors - a.aborted)[0]
        const failures = (leader?.errors ?? 0) + (leader?.aborted ?? 0)
        // leader 内失败率和全局失败份额并列，避免小样本 100% 被误读为主要来源。
        return {
          label: dimension.label,
          values: [
            terminalText(leader?.label ?? "—"),
            formatNumber(failures),
            leader ? percent(failures, leader.requests) : "—",
            percent(failures, totalFailures),
          ],
        }
      }),
      color: options.color,
    }),
    ...wrapVisible(
      "Outcome ratios exclude unattributed usage. Each leader row is an independent query, not a partition.",
      statsContentWidth(),
    ).map((line) => muted(line, useColor(options.color))),
    ...wrapVisible("One failed request contributes to every applicable dimension.", statsContentWidth()).map((line) =>
      muted(line, useColor(options.color)),
    ),
    ...wrapVisible(
      `Errors and aborted requests remain separate outcomes; the combined failure rate is ${percent(totalFailures, report.total.requests)}.`,
      statsContentWidth(),
    ).map((line) => muted(line, useColor(options.color))),
  ]
}

const renderDimensionAnalysis = (
  report: StatsReport,
  groups: UsageGroup[],
  by: Exclude<BreakdownDimension, "tool">,
  metric: "tokens" | "cost",
  options: StatsRenderOptions,
) => {
  const series = breakdownSeries(report, by)
  // groups 已排序并限行，但各列份额仍取完整 report，不改为可见行的局部分母。
  // 同一分组的表格变化率必须按 id 找回对应 series，不能依赖数组偶然同序。
  const findSeries = (group: UsageGroup) => series.find((item) => item.id === group.id)
  if (by === "model") {
    // Model 重点回答份额、费用效率、输出/缓存结构和会话覆盖。
    return [
      ...renderAnalyticalTable({
        title: "Model portfolio",
        // request 和 Assistant 指标刻意并列；两者不相等可以是正常的 secondary usage。
        label: "model",
        identityColors: true,
        headers: ["tokens", "share", "cost", "owned req", "calls", "tok/call", "sessions", "owner fail", "owner avg"],
        rows: groups.map((group) => ({
          label: group.label,
          values: [
            formatNumber(group.tokens.total),
            percent(group.tokens.total, report.total.tokens.total),
            money(group.cost),
            formatNumber(group.requests),
            formatNumber(group.assistantCalls),
            // 此密度属于 Assistant 调用，不因旁边有 owned req 就换成每请求 Token。
            formatNumber(safeDivide(group.tokens.total, group.assistantCalls)),
            String(group.sessions),
            failureRate(group),
            avgDuration(group.durationMs, group.requests),
          ],
        })),
        color: options.color,
      }),
      ...wrapVisible(
        "owned req / owner fail / owner avg follow RequestUsage owner; tokens, cost and calls follow Assistant usage.",
        statsContentWidth(),
      ).map((line) => muted(line, useColor(options.color))),
    ]
  }
  if (by === "provider") {
    // Provider 以经济性和失败率为主，默认主指标由上层设为 cost。
    // 异常基线使用完整过滤后 population，不能因 --limit 只显示前几行而改变告警等级。
    // 零费用在现有 schema 中可能表示未知而非免费，因此不能作为 $/call=0 拉低均值。
    const costPerCall = report.providers.flatMap((group) =>
      group.cost > 0 && group.assistantCalls > 0 ? [group.cost / group.assistantCalls] : [],
    )
    // 没有 owning request 的 secondary usage 不具备失败率和平均时延分母，应从基线排除。
    const ownerFailure = report.providers.flatMap((group) =>
      group.requests > 0 ? [(group.errors + group.aborted) / group.requests] : [],
    )
    const ownerAverage = report.providers.flatMap((group) =>
      group.requests > 0 ? [group.durationMs / group.requests] : [],
    )
    return [
      ...renderAnalyticalTable({
        title: "Provider economics",
        // 可见行只影响展示，异常总体始终是上方完整的过滤后 Provider 集合。
        label: "provider",
        identityColors: true,
        headers: [
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
        rows: groups.map((group) => {
          // unavailable 费用保持破折号，不能先除成零再获得一个虚假的“低风险”值。
          const perCall =
            group.cost > 0 && group.assistantCalls > 0
              ? highOutlier(group.cost / group.assistantCalls, costPerCall, money)
              : { text: "—" }
          const failure =
            // 没有 owner 的 Provider 不进入失败总体，页面仍保留公开的零分母约定。
            group.requests > 0
              ? highOutlier((group.errors + group.aborted) / group.requests, ownerFailure, (value) => percent(value, 1))
              : { text: failureRate(group) }
          const average =
            // sigma 用毫秒统一计算，转换秒/分钟只属于显示，不改变风险边界。
            group.requests > 0
              ? highOutlier(group.durationMs / group.requests, ownerAverage, (value) => avgDuration(value, 1))
              : { text: avgDuration(group.durationMs, group.requests) }
          // Cache 颜色和显示文本共用完整 token 分母，避免 read-only 与 read+write 两套阈值并存。
          const cache = safeDivide(group.tokens.cache.read + group.tokens.cache.write, group.tokens.total)
          return {
            label: group.label,
            values: [
              formatNumber(group.tokens.total),
              percent(group.tokens.total, report.total.tokens.total),
              money(group.cost),
              // 缓存或价格可让费用份额与 Token 份额相反，不能合并成同一列。
              group.cost > 0 ? percent(group.cost, report.total.cost) : "—",
              formatNumber(group.requests),
              formatNumber(group.assistantCalls),
              perCall.text,
              cacheShare(group.tokens),
              failure.text,
              average.text,
            ],
            // 95% cache 是正向提示；费用、失败率和时延才使用高侧风险色，不能按“数值大”统一染红。
            valueColors: [
              // 普通数量不因“大”而警告，只有风险或健康语义的列覆盖实体色。
              undefined,
              undefined,
              undefined,
              undefined,
              undefined,
              undefined,
              perCall.color,
              cache >= healthThresholds.cache ? "green" : undefined,
              failure.color,
              average.color,
            ],
          }
        }),
        color: options.color,
      }),
      ...wrapVisible(
        "Request-owner metrics can be zero for a provider that only appears on secondary Assistant calls.",
        statsContentWidth(),
      ).map((line) => muted(line, useColor(options.color))),
      ...wrapVisible(
        `Risk marks compare the full provider population: ! >=${healthThresholds.dangerSigma}σ, ^ >=${healthThresholds.warningSigma}σ. Cache >=${healthThresholds.cache * 100}% is highlighted as healthy.`,
        statsContentWidth(),
      ).map((line) => muted(line, useColor(options.color))),
    ]
  }
  if (by === "agent") {
    // Agent 关注工作负载密度和调用效率，不复用模型页的费用排名壳。
    return renderAnalyticalTable({
      title: "Agent workload",
      // 每会话与每请求的工作密度互补，不能以列宽不足为由删掉其中一种。
      label: "agent",
      identityColors: true,
      headers: [
        "tokens",
        "sessions",
        "cost",
        "owned req",
        "calls",
        "calls/req",
        "tok/session",
        "cache",
        "owner fail",
        "owner avg",
      ],
      rows: groups.map((group) => ({
        label: group.label,
        values: [
          formatNumber(group.tokens.total),
          String(group.sessions),
          money(group.cost),
          formatNumber(group.requests),
          formatNumber(group.assistantCalls),
          safeDivide(group.assistantCalls, group.requests).toFixed(1),
          // 会话覆盖在聚合层去重，不能拿调用次数替代会话数来缩小平均值。
          formatNumber(safeDivide(group.tokens.total, group.sessions)),
          cacheShare(group.tokens),
          failureRate(group),
          avgDuration(group.durationMs, group.requests),
        ],
      })),
      color: options.color,
    })
  }
  if (by === "source") {
    // Source 用请求与上下文结构解释流量来源，避免只展示绝对 token。
    return [
      ...renderAnalyticalTable({
        title: "Source workload",
        // 星号明确 request-owner 分母：旧来源有费用并不代表拥有 request。
        label: "source",
        identityColors: true,
        headers: [
          "owned req",
          "calls",
          "tokens",
          "tok/req*",
          "cost",
          "cost/req*",
          "sessions",
          "cache",
          "output",
          "fail*",
          "avg*",
        ],
        rows: groups.map((group) => ({
          label: group.label,
          values: [
            formatNumber(group.requests),
            formatNumber(group.assistantCalls),
            formatNumber(group.tokens.total),
            group.requests > 0 ? formatNumber(safeDivide(group.tokens.total, group.requests)) : "—",
            money(group.cost),
            // 无 request 的每请求费用必须不可用，显示零会把历史记录误判为免费流量。
            group.requests > 0 ? money(safeDivide(group.cost, group.requests)) : "—",
            String(group.sessions),
            cacheShare(group.tokens),
            percent(outputTokens(group.tokens), group.tokens.total),
            group.requests > 0 ? failureRate(group) : "—",
            group.requests > 0 ? avgDuration(group.durationMs, group.requests) : "—",
          ],
        })),
        color: options.color,
      }),
      ...wrapVisible(
        "* request-owner denominator and health; legacy Assistant usage has no owned request.",
        statsContentWidth(),
      ).map((line) => muted(line, useColor(options.color))),
    ]
  }
  if (by === "project") {
    const enabled = useColor(options.color)
    const projects = new Map(report.projects.map((project) => [project.id, project]))
    // 完整路径负责同名项目消歧，不参与 ID 连接，也不能按终端宽度改写身份。
    // Project identity 需要名称与完整路径共同消歧；卡片换行比宽表截断更适合带空格的真实 worktree。
    return [
      ...renderSectionDivider("Project portfolio", enabled, statsContentWidth()),
      "",
      ...groups.flatMap((group, index) => [
        // 自定义 Project 卡片没有通用 table 第一列，因此在这里显式延续趋势中的项目身份色。
        color(terminalText(group.label), seriesColor(index), enabled, true),
        ...wrapVisible(
          `  ${terminalText(projects.get(group.id)?.path || "Path unavailable")}`,
          statsContentWidth(),
        ).map((line) => muted(line, enabled)),
        ...wrapVisible(
          `  ${formatNumber(group.tokens.total)} tok ${percent(group.tokens.total, report.total.tokens.total)} · ${money(group.cost)} · ${formatNumber(group.sessions)} sessions · ${formatNumber(group.requests)} req · ${formatNumber(group.assistantCalls)} calls · ${activeDays(findSeries(group))} active days · cache ${cacheShare(group.tokens)} · fail ${failureRate(group)}`,
          statsContentWidth(),
        ),
      ]),
    ]
  }
  // Status 是结果分布，核心是每请求成本、调用密度和请求占比，而非 token 排名。
  // tool 已在上层独立处理；此处闭合到 status，不为未知维度新增默认成功页面。
  return renderAnalyticalTable({
    title: "Status efficiency",
    label: "status",
    headers: ["req share", "tokens/req", "cost/req", "calls/req", "cache", "output", "sessions"],
    // 没有 owning request 的 Assistant 只在独立说明中显示，不进入 outcome 每请求指标。
    rows: groups
      .filter((group) => group.id !== "unattributed")
      .map((group) => ({
        label: group.label,
        // Outcome 是语义状态而非任意分类，颜色必须与趋势和分布中的 success/error/warning 保持一致。
        color: statusColor(group.id),
        values: [
          percent(group.requests, report.total.requests),
          group.requests > 0 ? formatNumber(safeDivide(group.tokens.total, group.requests)) : "—",
          group.requests > 0 ? money(safeDivide(group.cost, group.requests)) : "—",
          group.requests > 0 ? safeDivide(group.assistantCalls, group.requests).toFixed(1) : "—",
          cacheShare(group.tokens),
          percent(outputTokens(group.tokens), group.tokens.total),
          String(group.sessions),
        ],
      })),
    color: options.color,
  })
}

const renderOutcomeDistribution = (report: StatsReport, groups: UsageGroup[], options: StatsRenderOptions) => {
  // unattributed 只有 Assistant usage、没有 owning request，必须单列且不能进入 outcome 比率分母。
  const enabled = useColor(options.color)
  const width = statsContentWidth()
  const barWidth = Math.max(layout.status.minBar, Math.min(layout.status.maxBar, width - layout.status.reserved))
  const outcomes = groups.filter((group) => group.id !== "unattributed")
  const unattributed = groups.find((group) => group.id === "unattributed")
  const total = outcomes.reduce((sum, group) => sum + group.requests, 0)
  // 条长只编码请求占比；旁边的 Token/费用是补充量纲，不能反过来控制状态条长度。
  return [
    ...renderSectionDivider("Outcome distribution", enabled, width),
    "",
    ...outcomes.map((group) => {
      const filled = total <= 0 ? 0 : Math.round((group.requests / total) * barWidth)
      return `${padEndVisible(terminalText(group.label), layout.status.label)} ${color("█".repeat(filled), statusColor(group.id), enabled)}${color("░".repeat(barWidth - filled), "border", enabled)} ${padStartVisible(formatNumber(group.requests), layout.status.count)} ${padStartVisible(percent(group.requests, total), layout.fields.percent)} ${formatNumber(group.tokens.total)} tokens · ${money(group.cost)} · ${group.requests > 0 ? avgDuration(group.durationMs, group.requests) : "—"} avg`
    }),
    ...(unattributed
      ? [
          "",
          ...wrapVisible(
            `Unattributed usage · ${formatNumber(unattributed.tokens.total)} tokens · ${money(unattributed.cost)} · ${formatNumber(unattributed.assistantCalls)} calls · no owning request outcome`,
            // unattributed 是真实用量而非另一种 failed/running 状态，不能合并进请求结果条。
            width,
          ).map((line) => muted(line, enabled)),
        ]
      : []),
  ]
}
const renderStatusTrend = (report: StatsReport, groups: UsageGroup[], options: StatsRenderOptions) => {
  const enabled = useColor(options.color)
  const outcomes = groups.filter((group) => group.id !== "unattributed")
  const dailyRequests = new Map(report.daily.map((day) => [day.day, day.requests]))
  // 每天独立取 request 分母，不能用全窗口总量摊薄某一天的失败峰值。
  const series = outcomes.flatMap((group) => {
    const source = report.statusSeries.find((item) => item.id === group.id)
    if (!source) return []
    return [
      {
        id: group.id,
        label: terminalText(group.label),
        color: statusColor(group.id),
        points: source.points.map((point) => ({
          x: point.day,
          y: safeDivide(point.requests, dailyRequests.get(point.day) ?? 0) * 100,
        })),
      },
    ]
  })
  const chart = renderRoundedLineChart({
    title: "Request outcome trend",
    series,
    color: options.color,
    formatter: (value) => `${value.toFixed(0)}%`,
    yMin: 0,
    yMax: 100,
    width: fullChartWidth(),
    height: layout.chart.height,
    points: false,
  })
  return [...renderSectionDivider("Request outcome trend", enabled, statsContentWidth()), "", ...chart.slice(1)]
}
const renderStatusBreakdown = (report: StatsReport, options: StatsRenderOptions) => {
  // 状态顺序表达生命周期而非大小，completed/error/aborted/running 不能按 Token 重新排名。
  const enabled = useColor(options.color)
  const order = ["completed", "error", "aborted", "running"]
  const groups = [...report.statuses].sort((a, b) => {
    const left = order.indexOf(a.id)
    const right = order.indexOf(b.id)
    return (left < 0 ? order.length : left) - (right < 0 ? order.length : right)
  })
  const count = (id: string) => groups.find((group) => group.id === id)?.requests ?? 0
  // 页头结果数直接来自各状态 owning request，不能拿 Assistant call 数补齐未知结果。
  const total = groups.filter((group) => group.id !== "unattributed").reduce((sum, group) => sum + group.requests, 0)
  return panel(
    [
      ...renderRichHeader(report, options, "breakdown", "Breakdown / Status"),
      ...wrapVisible(
        `Request outcomes · ${formatNumber(total)} total · ${formatNumber(count("completed"))} completed · ${formatNumber(count("error"))} error · ${formatNumber(count("aborted"))} aborted · ${formatNumber(count("running"))} running`,
        statsContentWidth(),
      ).map((line) => muted(line, enabled)),
      "",
      ...renderStatusTrend(report, groups, options),
      "",
      ...renderOutcomeDistribution(report, groups, options),
      "",
      ...renderDimensionAnalysis(report, groups, "status", "tokens", options),
      "",
      ...renderDimensionDetails(report, groups, "status", options),
    ],
    enabled,
  )
}

const renderCompactHeader = (report: StatsReport, options: StatsRenderOptions, active: string, detail?: string) => {
  // 只缩短 Tok/Req 的标签，数值、范围和使用会话数不能在紧凑版被省掉。
  // 小于 100 列时拆分指标和范围，优先保留数值而不是完整 tabs 装饰。
  const enabled = useColor(options.color)
  const width = statsContentWidth()
  const metrics =
    width < layout.narrow
      ? [
          `${color(`Cost ${money(report.total.cost)}`, "pink", enabled)}  ${color(`Tok ${formatNumber(report.total.tokens.total)}`, "blue", enabled)}`,
          `${color(`Req ${formatNumber(report.total.requests)}`, "green", enabled)}  ${color(`Cache ${cacheShare(report.total.tokens)}`, "yellow", enabled)}  ${color(`Fail ${formatNumber(report.total.errors + report.total.aborted)}`, "red", enabled)}`,
        ]
      : [
          `${color(`Cost ${money(report.total.cost)}`, "pink", enabled)}  ${color(`Tokens ${formatNumber(report.total.tokens.total)}`, "blue", enabled)}  ${color(`Requests ${formatNumber(report.total.requests)}`, "green", enabled)}`,
          `${color(`Cache ${cacheShare(report.total.tokens)}`, "yellow", enabled)}  ${color(`Fail ${formatNumber(report.total.errors + report.total.aborted)}`, "red", enabled)}`,
        ]
  return [
    title(detail ? `opencode stats · ${detail}` : "opencode stats", enabled),
    ...wrapVisible(
      detail
        ? `${dateRange(report)} · ${report.sessionsWithUsage}/${report.totalSessions} sessions with usage`
        : `${dateRange(report)} · ${report.days} day window · ${report.sessionsWithUsage}/${report.totalSessions} sessions with usage`,
      width,
    ).map((line) => muted(line, enabled)),
    ...metrics,
    // 极窄终端只显示当前页面，避免五个 tab 把标题挤成省略号。
    width < layout.narrow
      ? muted(`View: ${active}`, enabled)
      : renderTabs({
          color: options.color,
          tabs: ["dashboard", "timeline", "breakdown", "sessions", "insights"].map((label) => ({
            label,
            active: label === active,
          })),
        }),
    "",
  ]
}

const renderRichHeader = (report: StatsReport, options: StatsRenderOptions, active: string, detail?: string) => {
  // detail 页不重复 Dashboard 的 avg/session 摘要，但 Cost/Token/Requests 等事实保持同一报告。
  // 所有详细页面复用 Dashboard header，颜色、范围和指标顺序因此保持一致。
  if (statsContentWidth() < layout.columns) return renderCompactHeader(report, options, active, detail)
  const enabled = useColor(options.color)
  return [
    title(detail ? `opencode stats · ${detail}` : "opencode stats", enabled),
    muted(
      detail
        ? `${dateRange(report)}${sep(enabled)}${report.sessionsWithUsage}/${report.totalSessions} sessions with usage`
        : `${dateRange(report)}${sep(enabled)}${report.days} day window${sep(enabled)}${report.sessionsWithUsage}/${report.totalSessions} sessions with usage`,
      enabled,
    ),
    detail
      ? `${color(`Cost ${money(report.total.cost)}`, "pink", enabled)}${sep(enabled)}${color(`Tokens ${formatNumber(report.total.tokens.total)}`, "blue", enabled)}${sep(enabled)}${color(`Requests ${formatNumber(report.total.requests)}`, "green", enabled)}${sep(enabled)}${color(`Cache ${cacheShare(report.total.tokens)}`, "yellow", enabled)}${sep(enabled)}${color(`Fail ${formatNumber(report.total.errors + report.total.aborted)}`, "red", enabled)}`
      : `${color(`Cost ${money(report.total.cost)} ${money(report.total.cost / Math.max(report.days, 1))}/day`, "pink", enabled)}${sep(enabled)}${color(`Tokens ${formatNumber(report.total.tokens.total)} ${formatNumber(report.tokensPerSession)} avg/session`, "blue", enabled)}${sep(enabled)}${color(`Requests ${formatNumber(report.total.requests)}`, "green", enabled)}${sep(enabled)}${color(`Cache ${cacheShare(report.total.tokens)}`, "yellow", enabled)}${sep(enabled)}${color(`Fail ${formatNumber(report.total.errors + report.total.aborted)}`, "red", enabled)}`,
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

const renderDashboardHeader = (report: StatsReport, options: StatsRenderOptions, width: number) =>
  width < layout.columns
    ? renderCompactHeader(report, options, "dashboard")
    : renderRichHeader(report, options, "dashboard")

const hasUsage = (report: StatsReport) =>
  // 只有 Session 外壳或日期坐标不构成观测；反过来零计费的工具记录仍是有效数据。
  // Session 数本身不代表存在 usage；严格筛选后只有 ToolPart 的报告也必须视为非空。
  report.total.tokens.total > 0 ||
  report.total.cost > 0 ||
  report.total.requests > 0 ||
  report.total.assistantCalls > 0 ||
  report.toolUsage.some((tool) => tool.count > 0 || tool.contextTokens > 0)

const renderEmptyStatsPage = (report: StatsReport, options: StatsRenderOptions, active: string) =>
  // 所有公开页面共用 header 后短路，避免不同端点各自绘制一套零值图和 NaN 风险。
  panel(
    [
      ...renderRichHeader(report, options, active),
      muted("No usage data for the selected range.", useColor(options.color)),
    ],
    useColor(options.color),
  )

const sortGroups = (groups: UsageGroup[], sort: StatsRenderOptions["sort"] = "tokens") =>
  // 拷贝后排序，让随后渲染的其他视图继续拿到原报告，而不是上一页改过次序的缓存。
  // 排序始终带稳定次级指标，数值相同的实体不会在多次渲染间随机跳动。
  [...groups].sort((a, b) => {
    if (sort === "cost") return b.cost - a.cost || b.tokens.total - a.tokens.total
    if (sort === "calls") return b.assistantCalls - a.assistantCalls || b.tokens.total - a.tokens.total
    return b.tokens.total - a.tokens.total || b.cost - a.cost
  })

const topGroups = (groups: UsageGroup[], options: StatsRenderOptions) =>
  sortGroups(groups, options.sort ?? "tokens").slice(0, options.limit ?? layout.rows.analytical)

// 章节分隔由所有 canonical 页面共享，留在页面组合层而不扩张公共图元的统计业务职责。
const renderSectionDivider = (label: string, enabled: boolean, width: number, subtitle?: string) => {
  // Section 标题携带排序、分母等行为语义，不能用固定 40 列上限静默裁掉后半段。
  // 极窄终端改为完整换行；只有单行标题才在右侧补分隔线，避免产生超宽行。
  const labels = wrapVisible(label, Math.max(layout.section.minLabel, width - layout.section.reserved))
  const head = `━━━ ${labels[0] ?? ""} `
  const divider = color(`${head}${"─".repeat(Math.max(0, width - visibleLength(head)))}`, "border", enabled)
  const continuation = labels
    .slice(1)
    .map((line) => color(`${" ".repeat(layout.section.continuationIndent)}${line}`, "border", enabled))
  return [
    divider,
    ...continuation,
    ...(subtitle
      ? wrapVisible(subtitle, Math.max(layout.minText, width - layout.paragraphIndent)).map((line) =>
          muted(`${" ".repeat(layout.paragraphIndent)}${line}`, enabled),
        )
      : []),
  ]
}

const tokenIntensity = (value: number): { char: string; color: keyof typeof theme } => {
  if (value <= 0) return activityIntensity.levels[0]
  if (value < activityIntensity.tokens[0]) return activityIntensity.levels[1]
  if (value < activityIntensity.tokens[1]) return activityIntensity.levels[2]
  if (value < activityIntensity.tokens[2]) return activityIntensity.levels[3]
  return activityIntensity.levels[4]
}

const requestIntensity = (value: number): { char: string; color: keyof typeof theme } => {
  // 与日 Token 的 glyph 外观相同但量纲不同，阈值始终使用真实小时请求量。
  if (value <= 0) return activityIntensity.levels[0]
  if (value < activityIntensity.requests[0]) return activityIntensity.levels[1]
  if (value < activityIntensity.requests[1]) return activityIntensity.levels[2]
  if (value < activityIntensity.requests[2]) return activityIntensity.levels[3]
  return activityIntensity.levels[4]
}

const plainIntensityGlyph = (level: { char: string }, width = 1) =>
  // 零值仍保留一个中点，不能把它复制成密度块后误认为两个活动单位。
  level.char === "·" ? level.char : level.char.repeat(width)

const dayOfWeekTokens = (report: StatsReport) =>
  // Monday-first 索引与日历列一致，不能直接使用 JavaScript Sunday-first 的 getDay 下标。
  report.daily.reduce(
    (buckets, day) => {
      buckets[(new Date(day.day).getDay() + 6) % 7] += day.tokens.total
      return buckets
    },
    Array.from({ length: 7 }, () => 0),
  )

const renderHourOfDayStrip = (report: StatsReport, width: number) => {
  // 聚合层已按真实 RequestUsage 开始时间闭合；renderer 不再从 Session 更新时间猜测请求发生时段。
  const buckets = report.requestsByHour
  const nonZero = buckets.map((value, hour) => ({ value, hour })).filter((item) => item.value > 0)
  // quiet 指发生过活动的最安静小时，未活动时段不应永远抢占这个观察值。
  const peak = [...nonZero].sort((a, b) => b.value - a.value)[0]
  const quiet = [...nonZero].sort((a, b) => a.value - b.value)[0]
  // 24 个字符逐小时对应，不压缩采样，峰值位置才能与上方刻度稳定对齐。
  const dataLine = buckets.map((value) => plainIntensityGlyph(requestIntensity(value))).join("")
  const legendLine = "· =0  ░ <50  ▒ <150  ▓ <300  █ ≥300"
  return [
    ...wrapWhenNeeded("Request starts by hour", width),
    "",
    "00  04  08  12  16  20",
    dataLine,
    "",
    peak ? `peak  ${String(peak.hour).padStart(2, "0")}:00 — ${formatNumber(peak.value)} req` : "no hourly activity",
    quiet ? `quiet ${String(quiet.hour).padStart(2, "0")}:00 — ${formatNumber(quiet.value)} req` : "",
    "",
    ...wrapWhenNeeded(`legend  ${legendLine}`, width),
  ]
}

const isoWeek = (time: number) => {
  // 周编号先锚定本地日期再用 UTC 计算 ISO 周，避免 DST 的小时差影响整周除法。
  const date = new Date(time)
  const target = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()))
  target.setUTCDate(target.getUTCDate() + 3 - ((target.getUTCDay() + 6) % 7))
  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4))
  return (
    1 +
    Math.round(
      ((target.getTime() - firstThursday.getTime()) / 86_400_000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7,
    )
  )
}

const renderCalendarActivity = (report: StatsReport, width: number) => {
  // Calendar 直接按完整 daily 索引放置数据，不使用固定 24 小时 timestamp 步长。
  const first = report.daily[0]?.day ?? Date.now()
  const offset = (new Date(first).getDay() + 6) % 7
  // 第一行前置空格属于未落入窗口的日期，不应把窗口首日左移到星期一。
  const startDate = new Date(first)
  startDate.setDate(startDate.getDate() - offset)
  const start = startDate.getTime()
  const weeks = Math.max(1, Math.ceil((offset + report.daily.length) / 7))
  // 日历单元保持自适应：窄列使用一个字符，宽列使用两个字符；
  // 星期标题始终落在同一固定网格，不能随色块宽度漂移。
  // 42 列以上使用双字符色块，窄屏退化为单字符但仍保留每个自然日。
  const glyphWidth = width >= layout.activity.doubleCellWidth ? 2 : 1
  const cellWidth = glyphWidth + layout.activity.cellPadding
  const cell = (tokens: number) => fitPlain(` ${plainIntensityGlyph(tokenIntensity(tokens), glyphWidth)}`, cellWidth)
  const legendLine = "░ <50M   ▒ 50-150M   ▓ 150-250M   █ >250M"
  return [
    ...wrapWhenNeeded("Calendar · cell intensity = daily tokens", width),
    "",
    `     ${["M", "T", "W", "T", "F", "S", "S"].map((d) => fitPlain(` ${d}`, cellWidth)).join("")}`,
    ...Array.from({ length: weeks }, (_, week) => {
      const weekStart = new Date(start)
      weekStart.setDate(weekStart.getDate() + week * 7)
      // daily 已是完整连续自然日序列；按索引定位可避开 DST 导致的 23/25 小时间隔。
      const cells = Array.from({ length: 7 }, (_, day) => {
        const index = week * 7 + day - offset
        return cell(index >= 0 && index < report.daily.length ? report.daily[index].tokens.total : 0)
      }).join("")
      return `${padStartVisible(String(isoWeek(weekStart.getTime())), layout.activity.weekLabel)} ${cells}`
    }),
    "",
    ...wrapWhenNeeded(legendLine, width),
  ]
}

// Activity 对同一窗口使用三个小视图：日历观察日期节奏，小时条观察日内负载，
// 星期份额观察周期偏置；三者互补而不重复展示同一量纲。
const renderDayOfWeekShare = (report: StatsReport, enabled: boolean, width: number) => {
  // 条长相对最忙星期归一化，旁边百分比仍相对全周 Token；两者不能互相替代。
  const buckets = dayOfWeekTokens(report)
  const total = buckets.reduce((sum, value) => sum + value, 0)
  const max = Math.max(0, ...buckets)
  const barWidth = Math.max(layout.activity.dowMinBar, width - layout.activity.dowReserved)
  return [
    ...wrapVisible("Day-of-week · share of total tokens", width).map((line) => title(line, enabled)),
    ...["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((label, index) => {
      const filled = max <= 0 ? 0 : Math.round((buckets[index] / max) * barWidth)
      return `${label} ${color("▇".repeat(filled), index >= 5 ? "mauve" : "lavender", enabled)}${" ".repeat(Math.max(0, barWidth - filled))} ${padStartVisible(percent(buckets[index], total), layout.fields.percent)}`
    }),
  ]
}

const renderDailyActivitySection = (
  report: StatsReport,
  options: StatsRenderOptions,
  mode: ReturnType<typeof layoutModeFor>,
  width: number,
) => {
  // Calendar、小时和星期是三个不同时间尺度，宽屏并列、窄屏顺序堆叠。
  // 布局变化不重复聚合，每个视图都读取同一份 report。
  const calendarWidth =
    // 中屏左日历右辅助、宽屏三列，预留 gap 后再分配宽度，不能对整终端直接三等分。
    width < layout.columns
      ? width
      : mode === "wide"
        ? Math.floor((width - layout.gap * 2) / 3)
        : Math.floor((width - layout.activity.pairGap) / 2)
  const sideWidth =
    // 辅助视图至少容纳小时刻度，不能因日历变宽就把小时序列裁为少于 24 槽。
    mode === "wide"
      ? Math.max(layout.activity.minSide, calendarWidth)
      : Math.max(
          layout.activity.minSide,
          width < layout.columns ? width : width - layout.activity.pairGap - calendarWidth,
        )
  const calendar = renderCalendarActivity(report, calendarWidth)
  const hour = renderHourOfDayStrip(report, sideWidth)
  const dow = renderDayOfWeekShare(report, useColor(options.color), sideWidth)
  // 所有分支保留同样三个观察问题，只改变并排或堆叠，不靠删视图来满足窄屏。
  if (width < layout.columns) return [...calendar, "", ...hour, "", ...dow]
  if (mode === "wide") return renderThreeColumn(calendar, hour, dow, layout.gap, width)
  return renderTwoColumn(calendar, [...hour, "", ...dow], layout.activity.pairGap, width, layout.halfFraction)
}

// Dashboard 不再堆叠 Token 组成；每个组件使用单系列折线，
// 因而低占比 output/cache-write 仍能保留自身趋势形状。
const orderedTokenParts = (report: StatsReport) =>
  // 固定顺序与全局颜色语义一致，低占比 Output 不会因数据排序改变位置。
  (["cacheRead", "input", "cacheWrite", "output"] as const).flatMap((id) => {
    const part = report.tokenPartSeries.find((item) => item.id === id)
    // 缺少定义与真实零值不同：不合成一个零组件，也不改变其余组件的固定语义顺序。
    if (!part) return []
    return [part]
  })

const renderTokenComponentSmallChart = (
  part: ReturnType<typeof orderedTokenParts>[number],
  report: StatsReport,
  options: StatsRenderOptions,
  width: number,
) => {
  // 每个 token 组成独立归一化，避免缓存大值把 Output 曲线压在同一条线上。
  const meta = tokenPartMeta[part.id]
  const peak = Math.max(0, ...part.points.map((point) => point.value))
  // 平均按完整组件时间轴计算，不能仅除以正值日而把稀疏输出显示为持续高负载。
  const avg = safeDivide(part.total, Math.max(1, part.points.length))
  const fullTitle = `${meta.mark} ${part.label} ${formatNumber(part.total)} ${percent(part.total, report.total.tokens.total)} · peak ${formatNumber(peak)}/d · avg ${formatNumber(avg)}/d`
  const compactTitle = `${meta.mark} ${part.label} ${formatNumber(part.total)} ${percent(part.total, report.total.tokens.total)}`
  // 小图标题可采用源紧凑摘要，但量级与份额不可丢；曲线仍消费同一完整点集。
  return renderRoundedLineChart({
    title: visibleLength(fullTitle) <= width ? fullTitle : compactTitle,
    series: [
      {
        id: part.id,
        label: part.label,
        color: meta.color,
        mark: meta.mark,
        total: part.total,
        points: part.points.map((point) => ({ x: point.day, y: point.value, label: point.label, value: point.value })),
      },
    ],
    color: options.color,
    metric: "tokens",
    width: chartPlotWidth(width),
    height: layout.chart.height,
    points: false,
    legend: false,
  })
}

const renderTokenComponentsSmallMultiples = (
  report: StatsReport,
  options: StatsRenderOptions,
  halfWidth: number,
  width: number,
) => {
  const charts = orderedTokenParts(report).map((part) =>
    renderTokenComponentSmallChart(part, report, options, width < layout.columns ? width : halfWidth),
  )
  if (charts.length === 0) return [muted("No token component data", useColor(options.color))]
  // 最后一张图后不额外塞空行，章节间距由调用方负责，不能在每层重复叠加。
  if (width < layout.columns) return charts.flatMap((chart) => [...chart, ""]).slice(0, -1)
  return [
    ...(charts.length >= 2 ? renderTwoColumn(charts[0], charts[1], layout.gap, width, layout.halfFraction) : charts[0]),
    ...(charts.length >= 4
      ? ["", ...renderTwoColumn(charts[2], charts[3], layout.gap, width, layout.halfFraction)]
      : charts[2]
        ? ["", ...charts[2]]
        : []),
  ]
}

const median = (values: number[]) => {
  // 保留源日费用选择秩；不要与 Session 页的分位 helper 合并后悄悄改变偶数样本取值。
  // 日费用中位数保留零日，描述完整日历窗口，而不是只描述活跃日的消费强度。
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] ?? 0
}

const renderCostHealthSubchart = (
  titleText: string,
  id: string,
  colorName: ChartColor,
  points: ReturnType<typeof dailyCostPoints>,
  width: number,
  metric: "tokens" | "cost",
  options: StatsRenderOptions,
  summary: string,
  yRange?: { min: number; max: number },
) => [
  ...renderRoundedLineChart({
    title: titleText,
    // 三种健康量纲共用同一画布协议，颜色、轴和摘要来自调用方而非专属绘制函数。
    series: [dailySeries(points, colorName, id)],
    color: options.color,
    metric,
    width: chartPlotWidth(width),
    height: layout.chart.healthHeight,
    points: false,
    legend: false,
    yMin: yRange?.min,
    yMax: yRange?.max,
  }),
  ...wrapVisible(summary, width).map((line) => muted(line, useColor(options.color))),
]

// 宽终端并排展示三张健康图；中等终端先显示 Error，
// 再让 Cache 独占释放出的整行宽度，避免三图同时被压扁。
const renderCostHealthSection = (
  report: StatsReport,
  options: StatsRenderOptions,
  mode: ReturnType<typeof layoutModeFor>,
  width: number,
  halfWidth: number,
  thirdWidth: number,
) => {
  // Cost、Cache、Failure 使用各自量纲，分成 small multiples 而不是共享 Y 轴。
  const costPeak = [...report.daily].sort((a, b) => b.cost - a.cost)[0]
  // 只对副本排序，原 daily 的自然日顺序仍供主图、星期和后续页复用。
  const cacheRates = dailyCacheHitPoints(report)
    .map((point) => point.value)
    .filter((value) => value > 0)
  const errorPeak = dailyErrorRatePoints(report).sort((a, b) => b.value - a.value)[0]
  const errorAvg = safeDivide(report.total.errors + report.total.aborted, report.total.requests) * 100
  // 总体失败率按请求加权，不是把每日百分比做平均，以免安静日与高流量日权重相同。
  const pairWidth =
    width < layout.columns
      ? Math.max(layout.health.minChart, width - layout.activity.pairGap)
      : mode === "wide"
        ? thirdWidth
        : halfWidth
  const dailyCost = renderCostHealthSubchart(
    "Daily cost ($/day)",
    "cost",
    metricColor.cost,
    dailyCostPoints(report),
    pairWidth,
    "cost",
    options,
    costPeak
      ? `peak ${money(costPeak.cost)} on ${shortDate(costPeak.day)} · median ${money(median(report.daily.map((day) => day.cost)))}`
      : "no cost activity",
  )
  const cacheRange = cacheRates.length
    ? // Cache 小图保留源的十百分点圆整域，不能把很窄变化夸成完整 0-100% 的跳变。
      {
        min: Math.max(0, Math.floor(Math.min(...cacheRates) / healthThresholds.cacheStep) * healthThresholds.cacheStep),
        max: Math.min(
          100,
          Math.ceil(Math.max(...cacheRates) / healthThresholds.cacheStep) * healthThresholds.cacheStep,
        ),
      }
    : undefined
  const cacheHit = renderCostHealthSubchart(
    "Cache hit rate (%)",
    "cache",
    metricColor.cache,
    dailyCacheHitPoints(report),
    mode === "wide" ? thirdWidth : Math.max(layout.health.minChart, width - layout.activity.pairGap),
    "tokens",
    options,
    cacheRates.length
      ? `range ${Math.min(...cacheRates).toFixed(1)}% → ${Math.max(...cacheRates).toFixed(1)}% · ${Math.max(...cacheRates) - Math.min(...cacheRates) < healthThresholds.stableCacheRange ? "stable" : "variable"}`
      : "no cache activity",
    cacheRange,
  )
  const errorRate = renderCostHealthSubchart(
    // 中止也属于失败观测，不能在重放时只保留 error 而悄悄降低图中的失败率。
    "Abort & error rate (%)",
    "errors",
    metricColor.failures,
    dailyErrorRatePoints(report),
    pairWidth,
    "tokens",
    options,
    errorPeak && errorPeak.value > 0
      ? `spike ${errorPeak.value.toFixed(1)}% on ${shortDate(errorPeak.day)} · avg ${errorAvg.toFixed(1)}%`
      : "no errors recorded",
  )
  // 中等宽度优先并列 Cost/Failure，再给 Cache 一整行，保持异常指标的可比性。
  if (mode === "wide") return renderThreeColumn(dailyCost, cacheHit, errorRate, layout.gap, width)
  if (width < layout.columns) return [...dailyCost, "", ...errorRate, "", ...cacheHit]
  return [...renderTwoColumn(dailyCost, errorRate, layout.gap, width, layout.halfFraction), "", ...cacheHit]
}

const renderTopModelsLollipop = (report: StatsReport, options: StatsRenderOptions, width: number) => {
  // Lollipop 只承担模型规模比较；精确份额、费用和每调用量仍以数字列给出。
  const enabled = useColor(options.color)
  const models = topGroups(report.models, { ...options, limit: options.limit ?? layout.rows.default, sort: "tokens" })
  if (models.length === 0) return [muted("No model data in range", enabled)]
  const max = Math.max(0, ...models.map((model) => model.tokens.total))
  const modelLabels = models.map((model) => terminalText(model.label))
  // 名称测量发生在终端控制序列清理之后，不把不可见字节算进条形可用宽度。
  const labelWidth = Math.max(
    layout.modelRank.minLabel,
    Math.min(layout.modelRank.maxLabel, Math.max(...modelLabels.map(visibleLength)) + 1),
  )
  // 只有超出可用列时才启用编号键；完整名称随后回显，编号不能替代实体身份。
  const labels = modelLabels.map((label, index) => (visibleLength(label) <= labelWidth ? label : `[${index + 1}]`))
  // 超长模型名通过编号键完整回显，不能用无省略号的静默 clip 代替。
  const perCallWidth = layout.modelRank.perCall
  // per-call 数字保留独立固定列，不能把它挤入条形后导致不同长度的指标起点漂移。
  const barWidth = Math.max(
    layout.modelRank.minBar,
    width - labelWidth - layout.modelRank.reserved - perCallWidth - layout.modelRank.gap,
  )
  return [
    muted(
      `${" ".repeat(labelWidth)} │ tokens${" ".repeat(Math.max(1, barWidth - layout.modelRank.headingTokens))} │ share  │ cost     │ per-call`,
      enabled,
    ),
    ...models.map((model, index) => {
      // 点标识实体存在，线长再表达相对规模；精确份额始终由右侧数字说明。
      const filled = Math.max(
        1,
        Math.round(safeDivide(model.tokens.total, max) * Math.max(1, barWidth - layout.modelRank.barReserved)),
      )
      const perCall = `${formatNumber(safeDivide(model.tokens.total, model.assistantCalls))}/c`
      return fitPlain(
        `${padEndVisible(labels[index], labelWidth)} │${color("●" + "━".repeat(Math.max(0, filled - 1)), seriesColor(index), enabled)} ${padEndVisible(formatNumber(model.tokens.total), Math.max(1, barWidth - filled))} │ ${padStartVisible(percent(model.tokens.total, report.total.tokens.total), layout.fields.percent)} │ ${padStartVisible(money(model.cost), layout.fields.cost)} │ ${padStartVisible(perCall, perCallWidth)}`,
        width,
      )
    }),
    ...models.flatMap((_, index) =>
      labels[index].startsWith("[")
        ? wrapVisible(`[${index + 1}] ${modelLabels[index]}`, width).map((line) => muted(line, enabled))
        : [],
    ),
  ]
}

const renderTopProvidersStack = (report: StatsReport, options: StatsRenderOptions, width: number) => {
  // Provider 使用 100% 组成条表达份额，和模型的绝对量 lollipop 分工不同。
  const enabled = useColor(options.color)
  const providers = sortGroups(report.providers, "tokens")
  if (providers.length === 0) return [muted("No provider data in range", enabled)]
  const barWidth = Math.max(layout.providerRank.minBar, width - layout.providerRank.inset)
  const top = providers.slice(0, providerColors.length)
  const otherTokens = providers.slice(providerColors.length).reduce((sum, provider) => sum + provider.tokens.total, 0)
  // 聚合前先保留长尾 Token 与费用，other 不能只在图例写一个没有数值的名字。
  // 超过六个的长尾合并为 other，控制视觉密度但仍计入总占比和费用。
  const pieces = [
    ...top.map((provider) => ({
      label: terminalText(provider.label),
      tokens: provider.tokens.total,
      cost: provider.cost,
    })),
    ...(otherTokens > 0
      ? [
          {
            label: "other",
            tokens: otherTokens,
            cost: providers.slice(providerColors.length).reduce((sum, provider) => sum + provider.cost, 0),
          },
        ]
      : []),
  ].map((provider, index) => ({
    provider,
    color: providerColors[index % providerColors.length],
    char: providerMarks[index] ?? "█",
  }))
  // Dashboard Provider 条是“出现过的实体”总览，允许每个可见实体至少一格；这不用于精确 Model composition。
  const baseSizes = pieces.map((piece) =>
    Math.max(1, Math.floor(safeDivide(piece.provider.tokens, report.total.tokens.total) * barWidth)),
  )
  const sizes = baseSizes.map((size, index) =>
    // 最后一段承接像素量化余差，整条保持源固定宽度；数字百分比不从像素反算。
    index === baseSizes.length - 1
      ? Math.max(1, size + barWidth - baseSizes.reduce((sum, item) => sum + item, 0))
      : size,
  )
  const bar = pieces
    // 每段只使用既定身份色，不设置背景；用户主题始终决定字符块实际对比度。
    .map((piece, index) => color(piece.char.repeat(Math.max(1, sizes[index] ?? 1)), piece.color, enabled))
    .join("")
  // 字符格经过最小宽度量化，下一行仍输出精确百分比，不能把格数误当成账单分母。
  const pctLine = pieces
    .map((piece, index) =>
      padEndVisible(
        percent(piece.provider.tokens, report.total.tokens.total),
        Math.max(visibleLength(percent(piece.provider.tokens, report.total.tokens.total)) + 1, sizes[index] ?? 1),
      ),
    )
    .join("")
  const itemsPerRow =
    width >= layout.providerRank.legendWidth ? layout.providerRank.wideItems : layout.providerRank.items
  const legendGap = width >= layout.providerRank.legendWidth ? layout.providerRank.wideGap : layout.providerRank.gap
  const colWidth = Math.min(
    layout.providerRank.maxColumn,
    Math.floor((width - legendGap * (itemsPerRow - 1)) / itemsPerRow),
  )
  const legend = pieces.map((piece, index) => {
    // 图例列只放短标签，完整长名称在下方 key 中保留。
    const labelWidth = Math.max(layout.providerRank.minLabel, colWidth - layout.providerRank.reserved)
    const label = visibleLength(piece.provider.label) <= labelWidth ? piece.provider.label : `[${index + 1}]`
    return {
      line: `${color(piece.char, piece.color, enabled)} ${padEndVisible(color(label, "white", enabled, true), labelWidth)} ${padStartVisible(formatNumber(piece.provider.tokens), layout.providerRank.tokenWidth)} ${padStartVisible(money(piece.provider.cost), layout.fields.cost)}`,
      note: label.startsWith("[") ? `[${index + 1}] ${piece.provider.label}` : undefined,
    }
  })
  const legendRows = legend
    .map((item) => item.line)
    .reduce<string[]>((rows, item, index) => {
      if (index % itemsPerRow === 0) rows.push("")
      rows[rows.length - 1] +=
        `${index % itemsPerRow === 0 ? "" : " ".repeat(legendGap)}${padEndVisible(item, colWidth)}`
      return rows
    }, [])
  return [
    fitPlain(bar, barWidth),
    muted(fitPlain(pctLine, barWidth), enabled),
    "",
    ...legendRows,
    ...legend.flatMap((item) => (item.note ? wrapVisible(item.note, width).map((line) => muted(line, enabled)) : [])),
  ]
}

const sessionPercentile = (report: StatsReport, q: number) => {
  const sorted = report.sessions.map((session) => session.tokens.total).sort((a, b) => a - b)
  // 最近秩只返回真实 Session 值，不通过插值制造数据库中不存在的 token 规模。
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0
}

const renderSessionDistribution = (report: StatsReport, options: StatsRenderOptions, width: number) => {
  // 固定业务区间比随样本最大值变化的直方图更适合跨时间比较。
  // 空区间仍保留位置，用户能识别分布中真正缺失的范围。
  const enabled = useColor(options.color)
  const buckets = sessionBands.tokens
  const counts = buckets.map(
    (bucket) =>
      report.sessions.filter((session) => session.tokens.total >= bucket.min && session.tokens.total < bucket.max)
        .length,
  )
  const max = Math.max(1, ...counts)
  const total = Math.max(
    1,
    counts.reduce((sum, count) => sum + count, 0),
  )
  const barWidth = Math.max(layout.minText, width - layout.session.distributionReserved)
  const topTokens = [...report.sessions].sort((a, b) => b.tokens.total - a.tokens.total)
  const top2 = topTokens.slice(0, 2).reduce((sum, session) => sum + session.tokens.total, 0)
  const top10 = topTokens.slice(0, 10).reduce((sum, session) => sum + session.tokens.total, 0)
  return [
    title(`Session size distribution (${report.sessions.length} sessions)`, enabled),
    ...buckets.map(
      (bucket, index) =>
        `${padStartVisible(bucket.label, layout.session.distributionLabel)} ${metricBar(counts[index], max, barWidth, enabled, sessionBandColors[index] ?? sessionBandColors[1])} ${padStartVisible(String(counts[index]), layout.session.distributionCount)} ${padStartVisible(percent(counts[index], total), layout.fields.percent)}`,
    ),
    "",
    muted(
      `Percentiles   p50 ${formatNumber(sessionPercentile(report, 0.5))} · p90 ${formatNumber(sessionPercentile(report, 0.9))} · p99 ${formatNumber(sessionPercentile(report, 0.99))}`,
      enabled,
    ),
    muted(
      `Heavy-tail   top 2 ⇒ ${percent(top2, report.total.tokens.total)} of tokens · top 10 ⇒ ${percent(top10, report.total.tokens.total)}`,
      enabled,
    ),
  ]
}

const renderTopSessionsList = (report: StatsReport, options: StatsRenderOptions, width: number) => {
  // Dashboard 只给 top 会话摘要；完整多维比较由 Sessions 页面承担。
  const enabled = useColor(options.color)
  const sessions = [...report.sessions]
    .sort((a, b) => b.tokens.total - a.tokens.total || b.cost - a.cost)
    .slice(0, options.limit ?? layout.rows.default)
  // 同量 token 用费用稳定破平；max 只负责相对条长，精确 token 始终在标题行展示。
  const max = Math.max(0, ...sessions.map((session) => session.tokens.total))
  const barWidth = Math.max(layout.session.topBarMin, width - layout.session.topBarReserved)
  return [
    title("Top sessions by tokens", enabled),
    ...sessions.flatMap((session, index) => {
      const titleWidth = Math.max(layout.session.titleMin, width - layout.session.titleReserved)
      const sessionTitle = terminalText(session.title || session.id)
      const label = visibleLength(sessionTitle) <= titleWidth ? sessionTitle : `[${index + 1}]`
      // 模型和供应商列表全部换行展示，不再 slice 后静默丢掉第三个实体。
      return [
        `#${index + 1} ${padEndVisible(color(label, "white", enabled, true), titleWidth)} ${padStartVisible(money(session.cost), layout.fields.cost)} ${padStartVisible(formatNumber(session.tokens.total), layout.fields.tokens)} tok`,
        ...(label.startsWith("[")
          ? wrapVisible(`[${index + 1}] ${sessionTitle}`, width).map(
              (line) => `${" ".repeat(layout.session.indent)}${muted(line, enabled)}`,
            )
          : []),
        `${" ".repeat(layout.session.indent)}${metricBar(session.tokens.total, max, barWidth, enabled, "blue")} ${padStartVisible(percent(session.tokens.total, max), layout.session.topShare)}`,
        ...wrapVisible(
          `${session.models.map(terminalText).join(" · ") || "?"} · ${session.providers.map(terminalText).join(" · ") || "?"} · ${formatNumber(session.requests)} req · ${avgDuration(session.durationMs, session.requests)} avg`,
          Math.max(layout.minText, width - layout.session.indent),
        ).map((line) => `${" ".repeat(layout.session.indent)}${muted(line, enabled)}`),
        "",
      ]
    }),
  ]
}

const renderInsightsCallout = (report: StatsReport, options: StatsRenderOptions) => {
  // Dashboard callout 仅给可验证入口，不复制 Insights 的整套定量分析。
  const errorTotal = report.total.errors + report.total.aborted
  const errorRate = safeDivide(errorTotal, report.total.requests) * 100
  const top2 = [...report.sessions]
    .sort((a, b) => b.tokens.total - a.tokens.total)
    .slice(0, 2)
    .reduce((sum, session) => sum + session.tokens.total, 0)
  const cachePct = safeDivide(report.total.tokens.cache.read, report.total.tokens.total) * 100
  const compact = statsContentWidth() < layout.columns
  // callout 只提示下一步命令，完整定量分析在 Insights 页；紧凑文案不改变主报告事实。
  return renderCallout({
    title: "💡  Suggested next steps",
    body: compact
      ? [
          errorTotal > 0
            ? `▸ ${formatNumber(errorTotal)} failed/aborted req (${errorRate.toFixed(1)}%).`
            : "▸ No failed or aborted requests.",
          errorTotal > 0 ? "  → opencode stats breakdown status" : "  → keep watching error-rate trend.",
          `▸ Top 2 sessions: ${percent(top2, report.total.tokens.total)} of tokens.`,
          `▸ Cache hit: ${cachePct.toFixed(1)}%; review prompt reuse.`,
        ].join("\n")
      : [
          errorTotal > 0
            ? `▸ ${formatNumber(errorTotal)} failed/aborted requests (${errorRate.toFixed(1)}% rate).`
            : "▸ No failed or aborted requests in this range.",
          errorTotal > 0
            ? "  → run  opencode stats breakdown status   to inspect failed usage."
            : "  → keep watching the error-rate chart for regressions.",
          `▸ Top 2 sessions account for ${percent(top2, report.total.tokens.total)} of all tokens; consider splitting long sessions.`,
          `▸ Cache hit rate is ${cachePct.toFixed(1)}%; further gains likely require prompt restructuring.`,
        ].join("\n"),
    color: options.color,
    accent: "purple",
  })
}

export function renderStatsHeader(report: StatsReport, options: StatsRenderOptions, active: string) {
  return renderRichHeader(report, options, active, active === "insights" ? "Insights" : undefined)
}

const renderNarrowDashboard = (report: StatsReport, options: StatsRenderOptions, width: number) => {
  const enabled = useColor(options.color)
  const models = topGroups(report.models, { ...options, limit: layout.rows.narrow, sort: "tokens" })
  const sessions = [...report.sessions].sort((a, b) => b.tokens.total - a.tokens.total).slice(0, layout.rows.narrow)
  // 40 列附近无法保持桌面版多栏图的比较关系。紧凑模式保留同一组分析问题，
  // 但将低优先级装饰图降为完整数值行，避免外层 panel 用省略号静默丢失数据。
  // 该分支不改变 60 列以上 Dashboard，主端点既有视觉基线因此保持稳定。
  return panel(
    [
      ...renderCompactHeader(report, options, "dashboard"),
      ...(report.total.cost <= 0
        ? [
            ...wrapVisible(
              "No positive cost recorded in this range; token, cache, and failure trends remain visible.",
              width,
            ).map((line) => muted(line, enabled)),
            "",
          ]
        : []),
      ...renderSectionDivider("Daily activity", enabled, width),
      "",
      ...renderCalendarActivity(report, width),
      "",
      ...renderRoundedLineChart({
        title: "Daily tokens",
        series: [dailySeries(dailyTokenPoints(report), "blue", "tokens")],
        color: options.color,
        metric: "tokens",
        width: fullChartWidth(),
        height: layout.chart.narrowHeight,
        points: false,
        legend: false,
      }),
      "",
      ...renderSectionDivider("Usage shape", enabled, width),
      ...wrapVisible(
        `Input ${percent(report.total.tokens.input, report.total.tokens.total)} · Output ${percent(outputTokens(report.total.tokens), report.total.tokens.total)} · Cache ${cacheShare(report.total.tokens)}`,
        width,
      ).map((line) => muted(line, enabled)),
      ...wrapVisible(
        `Cost ${money(report.total.cost)} · Requests ${formatNumber(report.total.requests)} · Failures ${formatNumber(report.total.errors + report.total.aborted)}`,
        width,
      ).map((line) => muted(line, enabled)),
      "",
      ...renderSectionDivider("Top models", enabled, width),
      ...models.flatMap((model, index) =>
        wrapVisible(
          `${index + 1} ${terminalText(model.label)} · ${formatNumber(model.tokens.total)} · ${percent(model.tokens.total, report.total.tokens.total)} · ${money(model.cost)}`,
          width,
        ).map((line) => color(line, "white", enabled)),
      ),
      "",
      ...renderSectionDivider("Top sessions", enabled, width),
      ...sessions.flatMap((session, index) =>
        wrapVisible(
          `${index + 1} ${terminalText(session.title || session.id)} · ${formatNumber(session.tokens.total)} · ${money(session.cost)}`,
          width,
        ).map((line) => color(line, "white", enabled)),
      ),
    ],
    enabled,
  )
}

export function renderDashboard(report: StatsReport, options: StatsRenderOptions = {}) {
  // Dashboard 是视觉基准；只有极窄终端进入紧凑分支，其余布局沿用 section-first 结构。
  const enabled = useColor(options.color)
  const totalWidth = terminalContentWidth()
  // 空态判定先于窄屏分支，所有宽度必须看到同一事实而不是不同的零值布局。
  if (!hasUsage(report)) return renderEmptyStatsPage(report, options, "dashboard")
  if (totalWidth < layout.narrow) return renderNarrowDashboard(report, options, totalWidth)
  // 布局阈值只改变并排/堆叠方式，所有 section 和统计口径在两种模式中保持一致。
  const mode = layoutModeFor(totalWidth)
  const gap = layout.gap
  const halfWidth = Math.max(layout.minHalf, Math.floor((totalWidth - gap) / 2))
  const thirdWidth = Math.max(layout.minThird, Math.floor((totalWidth - gap * 2) / 3))
  const sessionLeftWidth = Math.max(layout.minHalf, Math.floor((totalWidth - gap) * layout.session.leftFraction))
  const sessionRightWidth = Math.max(layout.minHalf, totalWidth - gap - sessionLeftWidth)
  // Dashboard 刻意采用 section-first：每个区块只回答一个问题，
  // Timeline、Breakdown、Sessions 继续保留各自的详细 renderer。
  const lines = [
    ...renderDashboardHeader(report, options, totalWidth),
    // 无正费用只禁用费用推断，Token/Cache/Failure 仍有独立观测价值。
    ...(report.total.cost <= 0
      ? [
          muted("No positive cost recorded in this range; token, cache, and failure trends remain visible.", enabled),
          "",
        ]
      : []),
    // 长时间轴是 Dashboard 的主图，始终使用整行；下面的小视图只补充周期和组成透视。
    ...renderRoundedLineChart({
      title: "Daily token volume",
      series: [dailySeries(dailyTokenPoints(report), "blue", "tokens")],
      color: options.color,
      metric: "tokens",
      width: fullChartWidth(),
      height: layout.chart.height,
      points: false,
      legend: false,
    }),
    "",
    ...renderSectionDivider("Daily activity", enabled, totalWidth),
    "",
    ...renderDailyActivitySection(report, options, mode, totalWidth),
    "",
    ...renderSectionDivider("Token components", enabled, totalWidth, "Each panel auto-normalizes to its own peak."),
    "",
    ...renderTokenComponentsSmallMultiples(report, options, halfWidth, totalWidth),
    "",
    ...renderSectionDivider("Cost & health trends", enabled, totalWidth),
    "",
    ...renderCostHealthSection(report, options, mode, totalWidth, halfWidth, thirdWidth),
    "",
    ...renderSectionDivider("Top models · by token volume", enabled, totalWidth),
    "",
    ...renderTopModelsLollipop(report, options, totalWidth),
    "",
    ...renderSectionDivider("Top providers · share of total tokens", enabled, totalWidth),
    "",
    ...renderTopProvidersStack(report, options, totalWidth),
    "",
    ...renderSectionDivider("Sessions", enabled, totalWidth),
    "",
    ...(mode === "wide"
      ? renderTwoColumn(
          renderSessionDistribution(report, options, sessionLeftWidth),
          renderTopSessionsList(report, options, sessionRightWidth),
          gap,
          totalWidth,
          sessionLeftWidth / Math.max(1, totalWidth - gap),
        )
      : [
          ...renderSessionDistribution(report, options, totalWidth - 4),
          "",
          ...renderTopSessionsList(report, options, totalWidth - 4),
        ]),
    "",
    ...renderSectionDivider("Insights", enabled, totalWidth),
    "",
    ...renderInsightsCallout(report, options),
  ]
  return panel(lines, enabled)
}

export function renderBreakdown(report: StatsReport, options: StatsRenderOptions = {}) {
  // 过滤和报表生成已经在 Data 完成，本入口只投影视图，不再次读库或猜补缺失归属。
  // Breakdown 共用 header 和 top-5 趋势，但分析表必须按维度回答不同问题。
  // 此处是七个分组 wrapper 的唯一渲染入口，不能复制成专属页面。
  const enabled = useColor(options.color)
  const by = options.by ?? "model"
  if (!hasUsage(report)) return renderEmptyStatsPage(report, options, "breakdown")
  if (by === "status") return renderStatusBreakdown(report, options)
  // Provider 默认关注费用，其他维度默认关注 token；显式 metric 始终覆盖默认值。
  // 全范围无正费用时按 cost 排序没有区分度，Provider 稳定回退到 token 规模。
  const metric = options.metric ?? (by === "provider" && report.total.cost > 0 ? "cost" : "tokens")
  const sort = options.sort ?? (by === "provider" && report.total.cost > 0 ? "cost" : "tokens")
  const limit = options.limit ?? (statsContentWidth() < layout.narrow ? layout.rows.narrow : layout.rows.default)
  // undefined 才启用响应式默认值；显式 0 表示不显示明细，不能用 truthy 判断改回默认行数。

  if (by === "tool") {
    // Tool 没有可靠费用归因，使用调用量与估算上下文 token 的专属数据结构。
    // 显式 calls 排序必须覆盖默认 context token 顺序，不能接受参数后静默忽略。
    // 两种排序都保留另一指标作为次级键，数值并列时输出仍然稳定。
    // 估算上下文可能因 legacy breakdown 缺失而全零，此时保留 calls 并明确显示不可用。
    const hasContextTokens = report.toolUsage.some((tool) => tool.contextTokens > 0)
    const toolSort = hasContextTokens ? sort : "calls"
    // 无估算值时 calls 仍然可观测；这是支持域的可用性选择，不是绘图失败后的备用成功路径。
    const tools = [...report.toolUsage]
      .sort((a, b) =>
        toolSort === "calls"
          ? b.count - a.count || b.contextTokens - a.contextTokens
          : b.contextTokens - a.contextTokens || b.count - a.count,
      )
      .slice(0, limit)
    // footprint 与 issuing runtime 均从过滤后的 toolCalls 构建，不能混入 Session 级未过滤 count。
    const callStats = new Map<string, { errors: number; durationMs: number }>()
    const projectLabels = new Map(report.projects.map((project) => [project.id, project.label]))
    report.toolCalls.forEach((call) => {
      // 一个工具可有多个 runtime tuple，错误与耗时必须跨 tuple 累加，不能只取第一条。
      const item = callStats.get(call.toolID) ?? { errors: 0, durationMs: 0 }
      item.errors += call.errors
      item.durationMs += call.durationMs
      callStats.set(call.toolID, item)
    })
    const tokenTotal = report.toolUsage.reduce((sum, tool) => sum + tool.contextTokens, 0)
    // Tool context 份额使用全部工具的估算总量，limit 不应把选中几行的份额膨胀到 100%。
    const selectedTools = tools.slice(0, layout.rows.default)
    // Tool 趋势和两张明细表都按 tools 排序；缺失日序列只能隐藏折线，不能改变剩余工具颜色。
    const toolColors = new Map(selectedTools.map((tool, index) => [tool.id, seriesColor(index)]))
    const toolSeries = seriesFromUsage(
      // 趋势同样限制五条线，但保留完整工具名；颜色不承担唯一的系列映射。
      selectedTools.flatMap((tool) => {
        const series = report.toolSeries.find((item) => item.id === tool.id)
        return series ? [series] : []
      }),
      "tokens",
      layout.rows.default,
    ).map((series) => ({
      ...series,
      label: terminalText(series.label),
      color: toolColors.get(series.id) ?? seriesColor(0),
    }))
    return panel(
      [
        ...renderRichHeader(report, options, "breakdown", `Breakdown / ${breakdownPageTitle(by)}`),
        ...wrapVisible(
          `Tools · ${formatNumber(report.totalTools)} calls · ${hasContextTokens ? `${formatNumber(tokenTotal)} estimated context tokens · sorted by ${toolSort === "calls" ? "calls" : "estimated context tokens"}` : "context estimate unavailable · sorted by calls"}`,
          statsContentWidth(),
        ).map((line) => muted(line, enabled)),
        ...(hasContextTokens
          ? [
              "",
              ...renderSectionDivider(
                `Estimated context trend · top ${toolSeries.length} tools`,
                enabled,
                statsContentWidth(),
              ),
              "",
              ...renderRoundedLineChart({
                title: `Estimated context trend · top ${toolSeries.length} tools`,
                series: toolSeries,
                color: options.color,
                metric: "tokens",
                width: fullChartWidth(),
                height: layout.chart.height,
                points: false,
                legend: false,
              }).slice(1),
              ...wrapAnsiVisible(
                `${toolSeries.map((series) => color(`${series.label} ${formatNumber(series.total ?? 0)}`, series.color, enabled, true)).join(sep(enabled))}${muted(" est ctx tok", enabled)}`,
                statsContentWidth(),
              ),
            ]
          : [muted("Context estimate unavailable for these records; call share remains separate.", enabled)]),
        "",
        ...renderAnalyticalTable({
          title: "Tool footprint",
          label: "tool",
          identityColors: true,
          headers: [
            "calls",
            "call share",
            "est ctx tok",
            "ctx share",
            "ctx/call",
            "in chars/c",
            "out chars/c",
            "errors",
            "avg/call",
          ],
          rows: tools.map((tool) => {
            // 同行分别展示实际调用和估算消费；没有估算时只禁用该组列，不删实际 chars/errors。
            // error 和 duration 来自 ToolPart 状态，分母始终是同一行的真实调用数。
            const calls = callStats.get(tool.id) ?? { errors: 0, durationMs: 0 }
            return {
              label: tool.id,
              values: [
                formatNumber(tool.count),
                percent(tool.count, report.totalTools),
                // calls share 与 context share 的两个分母独立，不能共享一个更方便的百分比。
                hasContextTokens ? formatNumber(tool.contextTokens) : "—",
                hasContextTokens ? percent(tool.contextTokens, tokenTotal) : "—",
                hasContextTokens ? formatNumber(safeDivide(tool.contextTokens, tool.count)) : "—",
                formatNumber(safeDivide(tool.inputChars, tool.count)),
                formatNumber(safeDivide(tool.outputChars, tool.count)),
                formatNumber(calls.errors),
                avgDuration(calls.durationMs, tool.count),
              ],
            }
          }),
          color: options.color,
        }),
        ...wrapVisible(
          "est ctx tok approximates how much prior Tool input/output appears in later Assistant input.",
          statsContentWidth(),
        ).map((line) => muted(line, enabled)),
        ...wrapVisible(
          "Calls, chars, errors and duration come from ToolPart; no row represents Tool cost or billed tokens.",
          statsContentWidth(),
        ).map((line) => muted(line, enabled)),
        ...wrapVisible(
          "Tool errors are ToolPart execution errors; --status filters associated request/Assistant status, not ToolState.",
          statsContentWidth(),
        ).map((line) => muted(line, enabled)),
        "",
        ...renderAnalyticalTable({
          title: "Issuing runtime",
          // runtime 表逐工具展开，避免把全局模型分布复制到所有工具行。
          label: "tool",
          identityColors: true,
          headers: ["top models by calls", "top agents by calls", "projects by calls"],
          rows: tools.map((tool) => {
            // runtime mix 只改变分组键，不把 estimated context 当成调用权重。
            const calls = toolCallsFor(report, "toolID", tool.id)
            return {
              label: tool.id,
              values: [
                callMix(calls, (call) => call.modelID),
                callMix(calls, (call) => call.agent),
                // 项目以 ID 连接后显示名称，用户改名不会让工具归因被断开。
                callMix(calls, (call) => projectLabels.get(call.projectID) ?? call.projectID),
              ],
            }
          }),
          color: options.color,
        }),
      ],
      enabled,
    )
  }

  // limit 只裁剪可见实体；summary 中的 total 必须继续反映完整分组集合。
  const allGroups = sortGroups(breakdownGroups(report, by), sort)
  // summary 使用完整分组数，limit 只限制可见明细，不能把“显示 8 行”说成“共 8 组”。
  const groups = allGroups.slice(0, limit)
  const topGroup = groups[0]
  const topShare = topGroup
    ? percent(
        metric === "cost" ? topGroup.cost : topGroup.tokens.total,
        metric === "cost" ? report.total.cost : report.total.tokens.total,
      )
    : "—"
  const topValue = topGroup ? metricFormatter(metric)(metric === "cost" ? topGroup.cost : topGroup.tokens.total) : "—"
  // 摘要数值与当前主量纲一致；排序键可独立指定，不能因为按 calls 排序就把费用显示成调用数。
  const summaryLine = topGroup
    ? `${breakdownTitle(by)} · top ${terminalText(topGroup.label)} ${topValue} (${topShare}) · ${allGroups.length} total · sorted by ${sort === "cost" ? "cost" : sort === "calls" ? "calls" : "tokens"}`
    : `${breakdownTitle(by)} · no data in this range`
  const lines = [
    ...renderRichHeader(report, options, "breakdown", `Breakdown / ${breakdownPageTitle(by)}`),
    ...wrapVisible(summaryLine, statsContentWidth()).map((line) => muted(line, enabled)),
    "",
    ...renderBreakdownTrend(groups, breakdownSeries(report, by), metric, breakdownTitle(by), options.color),
    "",
    ...renderDimensionAnalysis(report, groups, by, metric, options),
  ]
  // 每个维度的第二、第三透视都从现有 report 投影，避免再套用无语义的编号矩阵。
  lines.push("", ...renderDimensionDetails(report, groups, by, options))
  return panel(lines, enabled)
}

export function renderModels(report: StatsReport, options: StatsRenderOptions = {}) {
  // 只固定公开别名的维度，显式颜色、limit 和 sort 仍交给同一个 canonical renderer。
  return renderBreakdown(report, { ...options, by: "model" })
}

export function renderProviders(report: StatsReport, options: StatsRenderOptions = {}) {
  // Provider 默认 metric 由 canonical Breakdown 根据正费用可用性决定，wrapper 只固定维度。
  return renderBreakdown(report, { ...options, by: "provider" })
}

const renderTimelineHealth = (report: StatsReport, options: StatsRenderOptions, metric: "tokens" | "cost") => {
  // 短趋势用于并列扫视，数值摘要保留实际单位，不能跨行比较 glyph 高度来推导绝对大小。
  // Health rows 将不同量纲压缩为并列 sparkline，避免重复五张完整坐标图。
  const enabled = useColor(options.color)
  const width = statsContentWidth()
  const rows = [
    metric === "cost"
      ? {
          // Cost 已由主图承担，secondary health 改看 Token，避免同页重复同一条费用序列。
          label: "Tokens",
          values: report.daily.map((day) => day.tokens.total),
          value: formatNumber(report.total.tokens.total),
          detail: "total",
          color: metricColor.tokens,
        }
      : {
          label: "Daily cost",
          values: report.daily.map((day) => day.cost),
          value: money(report.total.cost),
          detail: `avg ${money(safeDivide(report.total.cost, report.days))}/day`,
          color: metricColor.cost,
        },
    {
      label: "Requests",
      // 请求量描述 shell，而不是 Assistant 次数，多轮模型调用不能增加这里的请求数。
      values: report.daily.map((day) => day.requests),
      value: formatNumber(report.total.requests),
      detail: `${safeDivide(report.total.requests, report.days).toFixed(1)}/day`,
      color: metricColor.requests,
    },
    {
      label: "Cache read",
      // 此处明确 read 命中份额，不同于 Header 中含 write 的 cache 总份额。
      values: report.daily.map((day) => safeDivide(day.tokens.cache.read, day.tokens.total) * 100),
      value: percent(report.total.tokens.cache.read, report.total.tokens.total),
      detail: "of tokens",
      color: metricColor.cache,
    },
    {
      label: "Failures",
      // 使用 request-owner 分母；工具自身错误不能混入模型请求失败率。
      values: report.daily.map((day) => safeDivide(day.errors + day.aborted, day.requests) * 100),
      value: percent(report.total.errors + report.total.aborted, report.total.requests),
      detail: `${formatNumber(report.total.errors + report.total.aborted)} requests`,
      color: metricColor.failures,
    },
    {
      label: "Latency",
      // 时延总和只在最终按请求数求均值，不先平均每日均值再平均一次。
      values: report.daily.map((day) => safeDivide(day.durationMs, day.requests) / 1000),
      value: avgDuration(report.total.durationMs, report.total.requests),
      detail: "avg/request",
      color: metricColor.latency,
    },
  ]
  // 窄屏每个指标拆成标题和 sparkline 两行，保证数值与趋势都完整。
  if (width < layout.health.narrow) {
    return [
      ...renderSectionDivider("Health and efficiency", enabled, width),
      "",
      ...rows.flatMap((row) => [
        ...wrapVisible(`${row.label} ${row.value} · ${row.detail}`, width).map((line) =>
          color(line, "white", enabled, true),
        ),
        `  ${sparkline(row.values, Math.max(layout.health.minSpark, Math.min(layout.health.maxSpark, width - layout.paragraphIndent)), enabled, row.color)}`,
      ]),
    ]
  }
  const sparkWidth = Math.max(layout.minText, Math.min(layout.spark.max, width - layout.health.reserved))
  return [
    ...renderSectionDivider("Health and efficiency", enabled, width),
    "",
    ...rows.map(
      (row) =>
        `${padEndVisible(row.label, layout.health.label)} ${sparkline(row.values, sparkWidth, enabled, row.color)} ${padStartVisible(row.value, layout.health.value)}  ${muted(row.detail, enabled)}`,
    ),
  ]
}

const renderTimelineActivity = (
  titleText: string,
  series: UsageSeries[],
  metric: "tokens" | "cost",
  options: StatsRenderOptions,
) => {
  // Model/Provider 各保留前三条趋势，既提供归因又不与 Breakdown 重复整页排名。
  const enabled = useColor(options.color)
  const width = statsContentWidth()
  const total = series.reduce((sum, entry) => sum + (metric === "cost" ? entry.cost : entry.tokens.total), 0)
  // driver 只显示前三项，share 仍取所有该维度 series，不能因摘要限行改变归因份额。
  const rows = series
    .filter((item) => (metric === "cost" ? item.cost : item.tokens.total) > 0)
    .slice(0, layout.rows.drivers)
    .map((item, index) => ({
      label: terminalText(item.label),
      trend: sparkline(
        item.points.map((point) => (metric === "cost" ? point.cost : point.tokens.total)),
        layout.spark.driver,
        enabled,
        seriesColor(index),
      ),
      value: metricFormatter(metric)(metric === "cost" ? item.cost : item.tokens.total),
      share: percent(metric === "cost" ? item.cost : item.tokens.total, total),
      // Timeline 的名称和 sparkline 共用索引色，用户无需跨行猜测短趋势属于哪个实体。
      color: seriesColor(index),
    }))
  const labelWidth = Math.min(
    layout.spark.driverLabelMax,
    Math.max(layout.minText, ...rows.map((row) => visibleLength(row.label))),
  )
  return [
    title(titleText, enabled),
    ...rows.flatMap((row) => {
      // label 是不可信持久化文本，trend 则是本 renderer 生成的可信 ANSI；两者不能经过同一清理路径。
      const detail = `${row.trend}  ${metric} ${row.value} · share ${row.share}`
      if (visibleLength(row.label) <= labelWidth && visibleLength(`${row.label} ${detail}`) <= width) {
        return [`${padEndVisible(color(row.label, row.color, enabled, true), labelWidth)} ${detail}`]
      }
      return [color(row.label, row.color, enabled, true), ...wrapAnsiVisible(`  ${detail}`, width)]
    }),
  ]
}

const renderTimelineTokenComponents = (report: StatsReport, options: StatsRenderOptions) => {
  const enabled = useColor(options.color)
  const width = statsContentWidth()
  const sparkWidth = Math.max(layout.spark.min, Math.min(layout.spark.max, width - layout.spark.componentReserved))
  // 给完整组件摘要预留空间，spark 长度可以缩短，但总量/份额/峰值不能被 clip。
  return [
    title("Token components · each trend independently normalized", enabled),
    // 独立尺度只比较趋势形状；跨组件量级必须读取同一行的 total/share/peak。
    ...orderedTokenParts(report).flatMap((part) => {
      const meta = tokenPartMeta[part.id]
      const summary = `${meta.mark} ${part.label} ${formatNumber(part.total)} ${percent(part.total, report.total.tokens.total)} · peak ${formatNumber(Math.max(0, ...part.points.map((point) => point.value)))}/day`
      const trend = sparkline(
        part.points.map((point) => point.value),
        sparkWidth,
        enabled,
        meta.color,
      )
      if (visibleLength(`${summary}  ${trend}`) <= width) return [`${summary}  ${trend}`]
      // 窄屏把趋势移到下一行，不截断组件名称或精确量级。
      return [...wrapVisible(summary, width), `  ${trend}`]
    }),
  ]
}

export function renderTimeline(report: StatsReport, options: StatsRenderOptions = {}) {
  // canonical tokens/cost/heatmap 别名都汇入这里，不能为不同命令再维护一份同名日序列。
  // Timeline 只回答“何时变化以及组成如何”，不再重复三份相同日序列。
  // 跨实体的详细份额比较由 Breakdown 承担，避免端点职责重叠。
  const enabled = useColor(options.color)
  const metric = options.metric ?? "tokens"
  // 全空报告先短路；只有 Tool 数据的部分报告仍允许进入 Timeline 的稳定零趋势布局。
  if (!hasUsage(report)) return renderEmptyStatsPage(report, options, "timeline")
  if (metric === "cost" && report.total.cost <= 0) {
    // 零费用无法形成有意义的 cost 趋势，但请求、缓存和失败仍是有效观测，不应整页隐藏。
    return panel(
      [
        ...renderRichHeader(report, options, "timeline", "Timeline / Cost"),
        muted("No positive cost recorded in this range.", enabled),
        "",
        ...renderTimelineHealth(report, options, metric),
      ],
      enabled,
    )
  }
  // Top active days 只按当前 metric 排序，不能因另一量纲较大而改变日期排名。
  const sortedDays = [...report.daily]
    // 排名只移除当前主指标的零日，主图和平均值仍使用原完整自然日窗口。
    .filter((d) => (metric === "cost" ? d.cost : d.tokens.total) > 0)
    .sort((a, b) => (metric === "cost" ? b.cost - a.cost : b.tokens.total - a.tokens.total))
    .slice(0, layout.rows.default)
  // Token 总量使用绝对 Y 轴，组件使用独立尺度；缓存主导时不能让小组件在堆积图中消失。
  // 主图始终占满可用宽度；组件/健康 small multiples 放在其后，不与长时间轴争宽度。
  const mainChart =
    metric === "cost"
      ? renderRoundedLineChart({
          title: "",
          series: [dailySeries(dailyCostPoints(report), metricColor.cost, "cost")],
          color: options.color,
          metric: "cost",
          width: fullChartWidth(),
          height: layout.chart.height,
          points: false,
          legend: false,
        })
      : renderRoundedLineChart({
          title: "",
          series: [dailySeries(dailyTokenPoints(report), metricColor.tokens, "tokens")],
          color: options.color,
          metric: "tokens",
          width: fullChartWidth(),
          height: layout.chart.height,
          points: false,
          legend: false,
        })
  // 主图摘要复用折线的同一日序列；avg 按完整选择窗口计算，不能只除以活跃日而改变时间口径。
  const mainValues = report.daily.map((day) => (metric === "cost" ? day.cost : day.tokens.total))
  // total 使用 report 汇总而不是再次累加采样点，保持筛选后的 header、图表和摘要同一口径。
  const mainTotal = metric === "cost" ? report.total.cost : report.total.tokens.total
  const mainPeak = Math.max(0, ...mainValues)
  const mainPeakDay = report.daily[mainValues.indexOf(mainPeak)]
  // 并列峰值沿用原日序的第一个日期，不能因先排序或按成本次级排序而改成另一日。
  // Cost 额外公开活跃日数量；Token 只比较绝对量，避免把无请求日期解释为健康信号。
  const mainSummary =
    metric === "cost"
      ? `total ${money(mainTotal)} · avg ${money(safeDivide(mainTotal, report.days))}/day · peak ${money(mainPeak)}${mainPeakDay ? ` on ${shortDate(mainPeakDay.day)}` : ""} · ${mainValues.filter((value) => value > 0).length}/${report.days} active days`
      : `total ${formatNumber(mainTotal)} · peak ${formatNumber(mainPeak)}/day · avg ${formatNumber(safeDivide(mainTotal, report.days))}/day`
  return panel(
    [
      ...renderRichHeader(report, options, "timeline", `Timeline / ${metric === "cost" ? "Cost" : "Tokens"}`),
      // Section 是页面导航锚点，slice(1) 只移除 primitive 的空标题，不删除任何坐标或数据行。
      ...renderSectionDivider(metric === "cost" ? "Daily cost" : "Daily token volume", enabled, statsContentWidth()),
      "",
      ...mainChart.slice(1),
      muted(mainSummary, enabled),
      ...(metric === "tokens" ? ["", ...renderTimelineTokenComponents(report, options)] : []),
      "",
      ...renderTimelineHealth(report, options, metric),
      "",
      ...renderAnalyticalTable({
        title: metric === "cost" ? "Top cost days" : "Top active days",
        // 第二主指标、cache/output 和平均时延不能随量纲切换被删掉；只交换前两列。
        label: "date",
        headers: [metric, metric === "cost" ? "tokens" : "cost", "req", "fail", "cache", "output", "avg/req"],
        rows: sortedDays.map((day) => ({
          label: shortDate(day.day),
          values: [
            metric === "cost" ? money(day.cost) : formatNumber(day.tokens.total),
            metric === "cost" ? formatNumber(day.tokens.total) : money(day.cost),
            formatNumber(day.requests),
            percent(day.errors + day.aborted, day.requests),
            percent(day.tokens.cache.read, day.tokens.total),
            percent(outputTokens(day.tokens), day.tokens.total),
            avgDuration(day.durationMs, day.requests),
          ],
        })),
        color: options.color,
      }),
      "",
      ...renderSectionDivider(metric === "cost" ? "Cost drivers" : "Entity trends", enabled, statsContentWidth()),
      "",
      ...renderTimelineActivity("Models", report.modelSeries, metric, options),
      "",
      ...renderTimelineActivity("Providers", report.providerSeries, metric, options),
      // Heatmap 是显式附录，仍使用完整 section 层级而不是退化成主图后的无名字符块。
      ...(options.heatmap === true
        ? // 热图强度相对当前 peak，和 Dashboard 的绝对活动阈值是不同契约。
          [
            "",
            ...renderSectionDivider(
              metric === "cost" ? "Cost heatmap · calendar view" : "Token heatmap · calendar view",
              enabled,
              statsContentWidth(),
            ),
            "",
            ...renderHeatmap({
              title: "",
              points: metric === "cost" ? dailyCostPoints(report) : dailyTokenPoints(report),
              color: options.color,
              width: Math.min(Math.floor(statsContentWidth() * layout.chart.heatmapFraction), statsContentWidth()),
              formatter: metricFormatter(metric),
            }).slice(1),
          ]
        : []),
    ],
    enabled,
  )
}

const percentileValue = (values: number[], quantile: number) => {
  // 保留源的离散秩选择；插值会制造任何会话都没有的 Token 数，破坏可追溯性。
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b)
  if (sorted.length === 0) return 0
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * quantile))]
}

const renderSessionPopulation = (report: StatsReport, options: StatsRenderOptions) => {
  // 人口统计在榜单限行之前生成，-n 只影响定位对象，不能改变 p90/p99 所代表的完整集合。
  // Population 用标量建立总体与长尾基线，图形留给下方分布和单 Session 集中度。
  const enabled = useColor(options.color)
  const width = statsContentWidth()
  const tokenValues = report.sessions.map((session) => session.tokens.total)
  // Token 与费用分别排序选秩，不能以最贵会话的 Token 作为 Token 分位数。
  // 0 无法区分免费与缺失价格，只以正费用记录计算费用分位数。
  // Token 分位数仍使用全部 usage session，因此零费用不会隐藏真实长尾。
  const costValues = report.sessions.map((session) => session.cost).filter((cost) => cost > 0)
  const max = [...report.sessions].sort((a, b) => b.tokens.total - a.tokens.total)[0]
  // max 行追踪 Token 最大的实际 Session，不能把不同会话的最大费用/请求拼成一条虚构记录。
  const rows = [
    [
      "usage",
      `${formatNumber(report.total.tokens.total)} tokens · ${money(report.total.cost)} · ${report.sessionsWithUsage}/${report.totalSessions} sessions with usage · ${formatNumber(report.total.requests)} requests`,
    ],
    [
      "p50",
      // 这一行并列的 calls/session 是总体密度，不是对每 Session 调用数再取一次中位数。
      `${formatNumber(percentileValue(tokenValues, 0.5))} tokens · ${money(percentileValue(costValues, 0.5))} · ${safeDivide(report.total.assistantCalls, report.sessionsWithUsage).toFixed(1)} calls/session`,
    ],
    ["p90", `${formatNumber(percentileValue(tokenValues, 0.9))} tokens · ${money(percentileValue(costValues, 0.9))}`],
    ["p95", `${formatNumber(percentileValue(tokenValues, 0.95))} tokens · ${money(percentileValue(costValues, 0.95))}`],
    ["p99", `${formatNumber(percentileValue(tokenValues, 0.99))} tokens · ${money(percentileValue(costValues, 0.99))}`],
    [
      "max",
      max
        ? `${formatNumber(max.tokens.total)} tokens · ${money(max.cost)} · ${formatNumber(max.requests)} requests · ${avgDuration(max.durationMs, max.requests)} avg/request`
        : "—",
    ],
  ]
  return [
    ...renderSectionDivider("Session population", enabled, width),
    "",
    ...rows.flatMap(([label, value]) =>
      wrapVisible(`${padEndVisible(label, layout.session.populationLabel)} ${value}`, width),
    ),
  ]
}

const renderSessionBands = (report: StatsReport, options: StatsRenderOptions) => {
  // Token 与 cost 都使用固定档位，但费用只统计正记录，0 不能被描述为已测得的低费用。
  const tokenBands = sessionBands.tokens
  const costBands = sessionBands.cost
  const enabled = useColor(options.color)
  const width = statsContentWidth()
  const total = report.sessions.length
  const positiveCosts = report.sessions.filter((session) => session.cost > 0)
  // 费用分布和 Token 分布的样本量可以不同，标题与百分比分母必须分别携带这项事实。
  const tokenCounts = tokenBands.map(
    // 每个 Session 只能落在一个左闭右开区间，边界值不能在两个相邻 bucket 被重复计数。
    (band) =>
      report.sessions.filter((session) => session.tokens.total >= band.min && session.tokens.total < band.max).length,
  )
  const renderBands = (
    heading: string,
    bands: typeof tokenBands,
    counts: number[],
    sampleSize: number,
    colorName: keyof typeof theme,
  ) => {
    const max = Math.max(1, ...counts)
    // 固定档位保留空桶，读者可以看到真正缺失的会话规模，而不是只看非零档的重排列表。
    const labelWidth = Math.max(...bands.map((band) => visibleLength(band.label)))
    const barWidth = Math.max(layout.session.minBar, width - labelWidth - layout.session.bandReserved)
    // 条长相对最大桶，右侧百分比相对样本数；两种编码不应因同列数字看似相似而合并。
    return [
      // 两种分布共享相同 section primitive，避免普通标题让大量横条缺少页面锚点。
      ...renderSectionDivider(heading, enabled, width),
      "",
      ...bands.map(
        (band, index) =>
          `${padEndVisible(band.label, labelWidth)} ${metricBar(counts[index], max, barWidth, enabled, colorName)} ${padStartVisible(formatNumber(counts[index]), layout.session.bandCount)} ${padStartVisible(percent(counts[index], sampleSize), layout.fields.percent)}`,
      ),
    ]
  }
  const sortedTokens = [...report.sessions].sort((a, b) => b.tokens.total - a.tokens.total)
  // top-2/top-10 从全量会话推导，不能先截榜单再报告全局长尾集中度。
  const top2 = sortedTokens.slice(0, 2).reduce((sum, session) => sum + session.tokens.total, 0)
  const top10 = sortedTokens.slice(0, 10).reduce((sum, session) => sum + session.tokens.total, 0)
  const tokenDistribution = [
    ...renderBands("Session size distribution · tokens", tokenBands, tokenCounts, total, metricColor.tokens),
    muted(
      `top 2 ${percent(top2, report.total.tokens.total)} · top 10 ${percent(top10, report.total.tokens.total)} · mean/median ${safeDivide(report.tokensPerSession, report.medianTokensPerSession).toFixed(1)}x`,
      enabled,
    ),
  ]
  if (positiveCosts.length === 0) {
    // 全零费用时彻底移除 cost bands，不能把所有 Session 塞入 `<$0.10` 档。
    return [
      ...tokenDistribution,
      "",
      ...renderSectionDivider("Session cost distribution", enabled, width),
      "",
      muted("Cost distribution unavailable: no positive cost recorded in this range.", useColor(options.color)),
    ]
  }
  return [
    ...tokenDistribution,
    "",
    // 标题公开正费用样本数，使费用分布的分母可以被用户直接审计。
    ...renderBands(
      `Session cost distribution · positive recorded cost (${positiveCosts.length} sessions)`,
      costBands,
      costBands.map(
        (band) => positiveCosts.filter((session) => session.cost >= band.min && session.cost < band.max).length,
      ),
      positiveCosts.length,
      metricColor.cost,
    ),
    ...(report.sessions.length === positiveCosts.length
      ? // 未记录正费用的会话单独交代数量，不混入 <$0.10 并伪造低费用样本。
        []
      : [muted(`No positive recorded cost · ${report.sessions.length - positiveCosts.length} sessions`, enabled)]),
  ]
}

const renderSessionLeaderboard = (
  report: StatsReport,
  sessions: StatsReport["sessions"],
  sort: NonNullable<StatsRenderOptions["sort"]>,
  options: StatsRenderOptions,
) => {
  // Session 标题与 Project/Model/Provider 都来自持久数据，完整名称和控制字节清洗同样重要。
  const enabled = useColor(options.color)
  const width = statsContentWidth()
  const projectLabels = new Map(report.projects.map((project) => [project.id, terminalText(project.label)]))
  const barWidth = Math.max(layout.session.minBar, width - layout.session.leaderboardReserved)
  return [
    // 排序和 bar 分母属于 section 语义，必须在 divider 上持续可见。
    ...renderSectionDivider(`Session leaderboard · sorted by ${sort} · bar = token share`, enabled, width),
    "",
    ...sessions.flatMap((session, index) => {
      const models = session.models.map(terminalText).join(", ") || "unknown"
      // 全部参与过的身份都要保留；不能只显示前两个模型，再用没有省略号掩盖信息丢失。
      const providers = session.providers.map(terminalText).join(", ") || "unknown"
      // unknown 只说明历史缺少身份，不能借配置中的默认 Provider 补成一条未发生的路由。
      const identity = `${index + 1} ${terminalText(session.title || session.id)}`
      // 空标题使用稳定 Session ID 仍可定位，不能用随机排名编号作为唯一身份。
      const project = projectLabels.get(session.projectID) ?? terminalText(session.projectID)
      // 路由明细单独换行，条形宽度不会受模型名或项目名长度影响。
      return [
        ...wrapVisible(identity, width).map((line) => color(line, "white", enabled, true)),
        `${" ".repeat(layout.paragraphIndent)}token share ${metricBar(session.tokens.total, report.total.tokens.total, barWidth, enabled, seriesColor(index))} ${padStartVisible(percent(session.tokens.total, report.total.tokens.total), layout.fields.percent)} ${padStartVisible(formatNumber(session.tokens.total), layout.fields.tokens)}`,
        // 条始终表示全报告 Token 份额，即使榜单当前按费用、调用或更新时间排序。
        ...wrapVisible(
          `project ${project} · ${money(session.cost)} · ${formatNumber(session.requests)} req / ${formatNumber(session.assistantCalls)} calls · ${formatNumber(session.messages)} msg / ${formatNumber(session.tools)} tools`,
          Math.max(layout.minText, width - layout.paragraphIndent),
        ).map((line) => `${" ".repeat(layout.paragraphIndent)}${muted(line, enabled)}`),
        ...wrapVisible(
          `cache ${percent(session.tokens.cache.read, session.tokens.total)} · fail ${formatNumber(session.errors + session.aborted)} · ${avgDuration(session.durationMs, session.requests)} avg/request · updated ${shortDate(session.updated)}`,
          // 更新时间是独立明细，不能省略后让用户只能凭创建时间猜测 recency 排名。
          Math.max(layout.minText, width - layout.paragraphIndent),
        ).map((line) => `${" ".repeat(layout.paragraphIndent)}${muted(line, enabled)}`),
        ...wrapVisible(
          `models ${models} · providers ${providers}`,
          Math.max(layout.minText, width - layout.paragraphIndent),
        ).map((line) => `${" ".repeat(layout.paragraphIndent)}${muted(line, enabled)}`),
        "",
      ]
    }),
  ]
}

export function renderSessions(report: StatsReport, options: StatsRenderOptions = {}) {
  // 报告可被交互缓存反复使用；拷贝排序，不把本页的 recency 顺序写回其他页面的输入。
  // limit 只影响榜单，Population 和 Distribution 始终基于完整会话集合。
  const enabled = useColor(options.color)
  if (!hasUsage(report)) return renderEmptyStatsPage(report, options, "sessions")
  // 默认 limit 随宽度降低；显式 -n 不经过响应式覆盖，脚本输出因此保持可预测。
  const sort = options.sort ?? "tokens"
  // 展示短日期不参与排序，排序继续使用原始时间戳，避免同月不同年份或同日时刻混乱。
  const sessions = [...report.sessions]
    .sort((a, b) => {
      if (sort === "tokens") return b.tokens.total - a.tokens.total
      if (sort === "updated") return b.updated - a.updated
      // calls 指 Assistant 调用而非 ToolPart 次数，同页的工具计数只是另一独立明细。
      if (sort === "calls") return b.assistantCalls - a.assistantCalls
      return b.cost - a.cost || b.tokens.total - a.tokens.total
    })
    .slice(0, options.limit ?? (statsContentWidth() < layout.narrow ? layout.rows.narrow : layout.rows.default))
  // 页面按总体、分布、明细排序，先建立基线再定位具体离群会话。
  const lines = [
    ...renderRichHeader(report, options, "sessions", "Sessions"),
    // 总体基线先于分布和榜单，让读者先知道样本规模，再解释单个离群会话。
    ...renderSessionPopulation(report, options),
    "",
    ...renderSessionBands(report, options),
    "",
    ...renderSessionLeaderboard(report, sessions, sort, options),
    "",
    ...wrapVisible(
      `Visible ${sessions.length} of ${report.sessions.length} usage sessions · ${percent(
        // 可见行的占比使用整个报告总量，不能因 -n=1 就把头部 Session 标成 100%。
        sessions.reduce((sum, session) => sum + session.tokens.total, 0),
        report.total.tokens.total,
      )} of tokens · ${percent(
        sessions.reduce((sum, session) => sum + session.cost, 0),
        report.total.cost,
      )} of cost · use -n to change rows`,
      statsContentWidth(),
    ).map((line) => muted(line, enabled)),
  ]
  if (sessions.length === 0) lines.push(muted("No session usage data for this range.", enabled))
  // 明细为空也保留上方总体信息；不在榜单层把已经有工具等用量的报告重新判成全空。
  return panel(lines, enabled)
}
