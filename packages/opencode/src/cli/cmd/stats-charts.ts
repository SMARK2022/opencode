import { formatNumber } from "../format"
import type { UsageSeries } from "./stats-data"
import type { ColorMode } from "./stats-render"

const BOLD = "\x1b[1m"
const TEXT_RESET = "\x1b[22m\x1b[39m"
// 49m 只恢复终端默认背景，不指定具体颜色；独立 panel 同样需要清掉上游背景状态。
const BACKGROUND_RESET = "\x1b[49m"
const ANSI_RE = /\x1b\[[0-9;]*m/g
const ANSI_PREFIX_RE = /^\x1b\[[0-9;]*m/
// 持久化文本先按完整 CSI/OSC 序列清理，避免只删 ESC 后把 `[41m`、链接 URL 等参数显示给用户。
// 同时覆盖 7-bit ESC 与 8-bit C1 形式；未终止序列再由控制字节清理兜底，绝不交给终端执行。
const TERMINAL_ESCAPE_RE =
  /(?:(?:\u001b\]|\u009d)[\s\S]*?(?:\u0007|\u001b\\|\u009c|$)|(?:\u001b\[|\u009b)[0-?]*[ -/]*(?:[@-~]|$)|\u001b[@-_])/g
const TERMINAL_CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/g
// 默认宽度只服务非 TTY/测试回退；真实终端宽度始终优先，不能把 104 列当作固定画布。
const DEFAULT_PANEL_WIDTH = 104
// 最小宽度保护坐标和标签算法，最终 panel 仍会按更窄终端逐行换行。
const MIN_PANEL_WIDTH = 58
// 左右各两列留白是 Stats 页面唯一背景边界，不通过背景色制造卡片。
const PANEL_PADDING = 2
// 图元只接收可用宽度，默认尺寸不应散落在各页面；所有取值保持源版几何契约。
const layout = {
  minContentWidth: 20,
  terminalMargin: 2,
  line: {
    width: 64,
    height: 12,
    axisMin: 5,
    gridX: 5,
    gridY: 4,
    ticksMin: 3,
    ticksMax: 6,
    labelsMax: 4,
    labelSpacing: 8,
  },
  heatmap: { width: 52, labelWidth: 4, cellWidth: 2 },
  composition: {
    width: 48,
    minWidth: 24,
    minLabel: 8,
    maxLabel: 24,
    minBar: 12,
    maxBar: 48,
    reserved: 7,
    detailMin: 12,
    detailIndent: 2,
  },
  columns: { gap: 4, maxGap: 8, maxThreeGap: 6, minRatio: 0.1, maxRatio: 0.9, leftFraction: 0.5 },
  callout: { minWidth: 20, minInner: 10, border: 2 },
} as const

export const terminalText = (value: string) =>
  // 控制序列整体移除后再折叠布局字符，标签保留可读正文而不泄漏终端协议参数。
  value.replace(TERMINAL_ESCAPE_RE, " ").replace(TERMINAL_CONTROL_RE, " ").replace(/\s+/g, " ").trim()

export type ChartColor =
  | "axis"
  | "muted"
  | "title"
  | "subtitle"
  | "blue"
  | "cyan"
  | "green"
  | "yellow"
  | "orange"
  | "purple"
  | "pink"
  | "red"
  | "white"
  | "grid"

export type ChartStyle = { color: ChartColor; priority: number; bold?: boolean }
export type ChartPoint = { x: number; y: number; label?: string; value?: number }
export type ChartSeries = {
  id: string
  label: string
  color: ChartColor
  mark?: string
  points: ChartPoint[]
  total?: number
}
export type HeatPoint = { day: number; label: string; value: number }
type Cell = { char: string; style?: ChartStyle; priority: number }
type Bounds = { minX: number; maxX: number; minY: number; maxY: number }
type RenderContext = { color: boolean; palette: Record<ChartColor, string> }

export const palette: Record<ChartColor, string> = {
  // R6 前景色契约：采用终端语义 ANSI 槽位，明暗由终端主题决定。
  // bright magenta/cyan 承载标题与辅助层级，避免历史固定 RGB 在浅色终端失去对比。
  // axis/white 仍使用终端默认前景，确保正文对比度由用户主题负责。
  axis: "\x1b[39m",
  muted: "\x1b[2;39m",
  // title 使用 bright magenta（95m），复用 OpenCode system theme accent 语义。
  title: "\x1b[95m",
  // subtitle 使用 bright cyan（96m），对应 primary/info。
  subtitle: "\x1b[96m",
  // 系列色使用 bright 槽位，避免普通 ANSI 在深色 profile 中过暗。
  blue: "\x1b[94m",
  cyan: "\x1b[96m",
  green: "\x1b[92m",
  yellow: "\x1b[93m",
  // orange 用 normal yellow（33m）作为次级 amber，与 bright warning（93m）区分。
  orange: "\x1b[33m",
  // purple 用 bright magenta（95m）对应 accent/forecast；pink 用 normal magenta（35m）对照。
  purple: "\x1b[95m",
  pink: "\x1b[35m",
  // red 用 bright red（91m）对应 error/danger。
  red: "\x1b[91m",
  white: "\x1b[39m",
  // 网格只提供空间参照，不承载唯一数据，因此可以使用 dim 默认前景。
  grid: "\x1b[2;39m",
}

// 顺序本身是跨页面身份契约；插入新颜色会改变已有实体在 legend、表格和趋势中的对应关系。
const chartColors = [
  "blue",
  "green",
  "yellow",
  "purple",
  "pink",
  "cyan",
  "orange",
  "red",
] as const satisfies readonly ChartColor[]
export type SeriesColor = (typeof chartColors)[number]
// 分类实体在画布、图例和明细表中必须使用同一索引函数，避免各 renderer 复制后发生颜色漂移。
export const seriesColor = (index: number): SeriesColor => chartColors[index % chartColors.length]
// 无色终端依靠 mark 区分系列；彩色终端则优先保持线条干净，不把 mark 画进每个采样点。
const chartMarks = ["●", "◆", "■", "▲", "◇", "○", "✕", "+"]

// 热力图的相对 peak 五档与日历绝对阈值不同；glyph 和语义色必须按同一档索引。
const heatLevels = ["··", "░░", "▒▒", "▓▓", "██"]
const heatColors = ["grid", "muted", "blue", "purple", "pink"] as const satisfies readonly ChartColor[]

// priority 决定同一字符格的覆盖关系：数据线 > 坐标轴 > 网格，交叉处不能由绘制顺序随机决定。
const axisStyle: ChartStyle = { color: "axis", priority: 20 }
const gridStyle: ChartStyle = { color: "grid", priority: 0 }
// 系列基准高于轴，点标识又高于线段；偏移分开命名，避免调整单点时改变整条折线的覆盖关系。
const seriesPriority = { base: 30, line: 1, singlePoint: 3, marker: 5 } as const

export const useColor = (mode: ColorMode = "auto") => {
  // NO_COLOR 的优先级高于 TTY 探测，但显式 always 仍用于快照和颜色回归测试。
  if (mode === "always") return true
  if (mode === "never") return false
  // auto 才服从 NO_COLOR/TTY；显式 always/never 是公开 CLI 契约，不能被环境覆盖。
  if (process.env.NO_COLOR) return false
  return process.stdout.isTTY
}

const isCombining = (code: number) =>
  (code >= 0x0300 && code <= 0x036f) ||
  (code >= 0x1ab0 && code <= 0x1aff) ||
  (code >= 0x1dc0 && code <= 0x1dff) ||
  (code >= 0x20d0 && code <= 0x20ff) ||
  (code >= 0xfe20 && code <= 0xfe2f) ||
  (code >= 0xfe00 && code <= 0xfe0f) ||
  code === 0x200d

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
    (code >= 0x1f300 && code <= 0x1faff))

const charWidth = (char: string) => {
  // 宽度按终端列计算而不是 JS 字符数，CJK 和组合字符才能在同一 panel 对齐。
  const code = char.codePointAt(0)
  if (code === undefined) return 0
  if (code === 0 || code < 32 || (code >= 0x7f && code < 0xa0) || isCombining(code)) return 0
  return isWide(code) ? 2 : 1
}

export const visibleLength = (text: string) =>
  Array.from(text.replace(ANSI_RE, "")).reduce((sum, char) => sum + charWidth(char), 0)
export const stripAnsi = (text: string) => text.replace(ANSI_RE, "")
export const padEndVisible = (text: string, width: number) =>
  text + " ".repeat(Math.max(0, width - visibleLength(text)))
export const padStartVisible = (text: string, width: number) =>
  " ".repeat(Math.max(0, width - visibleLength(text))) + text

// 最终布局的兜底换行必须保留 ANSI 序列和全部可见字符。上层仍应优先按语义
// 组织布局；这里只防止遗漏的超宽行在 panel 边界被省略号静默截断。
export const wrapAnsiVisible = (text: string, width: number) => {
  if (width <= 0) return [""]
  const lines = [""]
  let visible = 0
  let index = 0
  while (index < text.length) {
    const rest = text.slice(index)
    const ansi = rest.match(ANSI_PREFIX_RE)?.[0]
    if (ansi) {
      lines[lines.length - 1] += ansi
      index += ansi.length
      continue
    }
    const code = text.codePointAt(index)
    if (code === undefined) break
    const char = String.fromCodePoint(code)
    if (char === "\n") {
      lines.push("")
      visible = 0
      index += char.length
      continue
    }
    const charColumns = charWidth(char)
    if (visible > 0 && visible + charColumns > width) {
      lines.push("")
      visible = 0
    }
    lines[lines.length - 1] += char
    visible += charColumns
    index += char.length
  }
  return lines
}

export const wrapVisible = (text: string, width: number) => {
  // 语义文本优先按单词换行；超长模型 ID 再按码点硬拆，确保内容完整保留。
  // 返回值至少一行，panel 的高度计算因此不需要额外空数组分支。
  if (width <= 0) return [""]
  const lines: string[] = []
  let line = ""
  const flush = () => {
    if (!line) return
    lines.push(line)
    line = ""
  }
  for (const word of text.trim().split(/\s+/)) {
    const pieces = Array.from(word).reduce(
      (result, char) => {
        const current = result.at(-1) ?? ""
        if (current && visibleLength(current + char) > width) result.push(char)
        else result[result.length - 1] = current + char
        return result
      },
      [""] as string[],
    )
    for (const [index, piece] of pieces.entries()) {
      const candidate = line ? `${line} ${piece}` : piece
      if (visibleLength(candidate) <= width) line = candidate
      else {
        flush()
        line = piece
      }
      if (index < pieces.length - 1) flush()
    }
  }
  flush()
  return lines.length ? lines : [""]
}

export const statsPanelWidth = (width?: number) => {
  // 外层始终预留两列，避免终端最右列触发自动换行；显式 width 也不能越过真实终端。
  // 测试传入的 COLUMNS 和运行时 columns 使用同一上限规则。
  const columns = process.stdout.columns ?? Number(process.env.COLUMNS)
  const terminalWidth =
    Number.isFinite(columns) && columns > 0
      ? Math.max(layout.minContentWidth, columns - layout.terminalMargin)
      : DEFAULT_PANEL_WIDTH
  const preferred = width ?? terminalWidth
  return Math.max(Math.min(MIN_PANEL_WIDTH, terminalWidth), Math.min(preferred, terminalWidth))
}
export const statsContentWidth = (width?: number) =>
  Math.max(layout.minContentWidth, statsPanelWidth(width) - PANEL_PADDING * 2)

export const truncateVisible = (text: string, width: number) => {
  // 该 helper 仍供明确允许摘要的低层 primitive 使用；stats 最终 panel 不再调用它。
  if (visibleLength(text) <= width) return text
  if (width <= 0) return ""
  if (width === 1) return "…"
  const parts: string[] = []
  let visible = 0
  let index = 0
  const target = width - visibleLength("…")
  while (index < text.length && visible < target) {
    const ansi = text.slice(index).match(ANSI_PREFIX_RE)?.[0]
    if (ansi) {
      parts.push(ansi)
      index += ansi.length
      continue
    }
    const char = Array.from(text.slice(index))[0]
    if (!char) break
    const nextWidth = charWidth(char)
    if (visible + nextWidth > target) break
    parts.push(char)
    visible += nextWidth
    index += char.length
  }
  parts.push("…")
  if (text.includes("\x1b[")) parts.push(TEXT_RESET)
  return parts.join("")
}
export const fitVisible = (text: string, width: number) => padEndVisible(truncateVisible(text, width), width)
export const paint = (text: string, color: ChartColor, ctx: RenderContext, bold = false) => {
  if (!ctx.color) return text
  return `${bold ? BOLD : ""}${ctx.palette[color]}${text}${TEXT_RESET}`
}
export const renderContext = (mode: ColorMode = "auto"): RenderContext => ({ color: useColor(mode), palette })

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))
const safeMax = (values: number[]) => Math.max(0, ...values.filter(Number.isFinite))
const niceMax = (value: number) => {
  // 上界向外圆整，峰值才不会被顶边裁掉；这些档位不是对实际采样值的舍入。
  // 零窗口仍给坐标留出有限跨度，空图的可用性判断由公开 renderer 负责。
  if (!Number.isFinite(value) || value <= 0) return 1
  const exponent = Math.floor(Math.log10(value))
  const base = 10 ** exponent
  const scaled = value / base
  const step = [1, 1.25, 1.5, 2, 2.5, 3, 4, 5, 7.5, 10].find((item) => scaled <= item) ?? 10
  return step * base
}
/** 将粗略步长收敛为 1/2/5 × 10^n，坐标轴因此保持便于心算的圆整间隔。 */
const niceStep = (rough: number): number => {
  // 选择数量级内的少数步长，防止金额小数与十亿级 Token 分别产生难读的碎刻度。
  if (rough <= 0) return 1
  const exp = Math.floor(Math.log10(rough))
  const f = rough / Math.pow(10, exp)
  if (f < 1.5) return Math.pow(10, exp)
  if (f < 3) return 2 * Math.pow(10, exp)
  if (f < 7) return 5 * Math.pow(10, exp)
  return Math.pow(10, exp + 1)
}
/** 在完整数据域内生成圆整 Y 轴刻度，不裁掉真实最小值或最大值。 */
const niceTicks = (min: number, max: number, targetCount = 5): number[] => {
  // 刻度首尾向外扩展而非截取数据范围，低值和峰值始终能从同一轴读取。
  if (max <= min) return [min, min + 1]
  const step = niceStep((max - min) / Math.max(1, targetCount - 1))
  const niceMin = Math.floor(min / step) * step
  const niceMaxVal = Math.ceil(max / step) * step
  const ticks: number[] = []
  // 半步余量只消除浮点累加遗漏末刻度的问题，不增加一个新的可观察数据点。
  for (let v = niceMin; v <= niceMaxVal + step / 2; v += step) ticks.push(v)
  return ticks.length >= 2 ? ticks : [min, max]
}
const range = (count: number) => Array.from({ length: Math.max(0, count) }, (_, index) => index)
const evenlySpaced = (count: number, max: number) => {
  // 端点也参与均匀定位；少量标签可以稀疏，但时间区间的起止不能随宽度向内收缩。
  if (count <= 1) return [0]
  return range(count).map((index) => Math.round((index / (count - 1)) * max))
}
const dateLabel = (time: number) => {
  // 固定 MM-DD 是画布坐标契约，本地化长日期只属于正文，不得挤占不同语言终端的列宽。
  const date = new Date(time)
  return `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`
}
const money = (value: number) => {
  // 这是图轴的紧凑单位，不用于账单精确值；页面摘要另外保留小额费用的小数位。
  if (!Number.isFinite(value) || value <= 0) return "$0"
  if (value >= 1000) return `$${(value / 1000).toFixed(1)}K`
  if (value >= 10) return `$${Math.round(value)}`
  if (value >= 1) return `$${value.toFixed(1)}`
  return `$${value.toFixed(2)}`
}

class ChartCanvas {
  readonly width: number
  readonly height: number
  private readonly cells: Cell[][]
  constructor(width: number, height: number) {
    // 未绘制格的 priority 低于网格；默认空格不能阻止后续原点、网格或数据线落笔。
    this.width = width
    this.height = height
    this.cells = range(height).map(() => range(width).map(() => ({ char: " ", priority: -1 })))
  }
  put(x: number, y: number, char: string, style: ChartStyle = axisStyle, priority = style.priority) {
    // 量化后的边界点可以落在画布边缘之外，裁剪属于此唯一写入口，不由每条线重复处理。
    if (x < 0 || x >= this.width || y < 0 || y >= this.height) return
    const cell = this.cells[y][x]
    // 低优先级后来写入时必须被拒绝，否则网格会擦掉已经成形的数据路径。
    if (priority < cell.priority) return
    // glyph、style、priority 必须一起替换，否则交叉格可能显示旧颜色配新线段。
    cell.char = char
    cell.style = style
    cell.priority = priority
  }
  horizontal(x1: number, x2: number, y: number, char: string, style: ChartStyle = axisStyle) {
    // 含两个端点且与方向无关，避免反向线与正向线在接头少一个字符格。
    for (const x of range(Math.abs(x2 - x1) + 1).map((offset) => Math.min(x1, x2) + offset)) this.put(x, y, char, style)
  }
  vertical(x: number, y1: number, y2: number, char: string, style: ChartStyle = axisStyle) {
    // 垂直方向也使用闭区间；轴与折线共用写入优先级，而非靠绘制顺序决定覆盖。
    for (const y of range(Math.abs(y2 - y1) + 1).map((offset) => Math.min(y1, y2) + offset)) this.put(x, y, char, style)
  }
  grid(columns: number, rows: number) {
    // 网格数量固定表达空间参考，不能把每天一条网格画成与窗口天数成正比的噪声。
    for (const x of evenlySpaced(columns, this.width - 1)) this.vertical(x, 0, this.height - 1, "┆", gridStyle)
    for (const y of evenlySpaced(rows, this.height - 1)) this.horizontal(0, this.width - 1, y, "┄", gridStyle)
  }
  render(ctx: RenderContext) {
    // 可见格先完成合成再发射 ANSI；样式字节永远不参加坐标、优先级或宽度计算。
    return this.cells.map((row) => {
      const parts: string[] = []
      // 每行独立开始样式状态，不能假定调用方总会把上一行和当前行连续打印。
      let active: ChartStyle | undefined
      // 仅在样式发生变化时输出 SGR，减少不可见字节且不改变任何可见列宽。
      for (const cell of row) {
        if (ctx.color && cell.style !== active) {
          active = cell.style
          // 先清除前一 style 的 dim/bold/foreground 状态，避免 grid 的 \x1b[2;39m
          // 泄漏到数据线：foreground 色码（如 34m）不会自动清除 SGR dim（2）。
          // TEXT_RESET（22m+39m）只恢复 intensity/foreground，不触碰 background；
          // background 继续由 panel 的 49m 边界负责。
          parts.push(active ? `${TEXT_RESET}${active.bold ? BOLD : ""}${ctx.palette[active.color]}` : TEXT_RESET)
        }
        parts.push(cell.char)
      }
      // 行尾复位也覆盖最后一个数据格，旁边的列与后续摘要不会继承其粗体或颜色。
      if (ctx.color && active) parts.push(TEXT_RESET)
      return parts.join("")
    })
  }
}

const boundsForSeries = (series: ChartSeries[]): Bounds => {
  // 轴范围取所有系列而非第一条；较小系列不能因为排序靠后而被排除在坐标域之外。
  const points = series.flatMap((item) => item.points)
  const xs = points.map((point) => point.x)
  const ys = points.map((point) => point.y)
  const minX = xs.length === 0 ? 0 : Math.min(...xs)
  const maxX = xs.length === 0 ? 1 : Math.max(...xs)
  // 非负 Stats 指标固定包含零基线；单值序列扩成最小范围，避免退化除零。
  return { minX, maxX: maxX === minX ? minX + 1 : maxX, minY: Math.min(...ys, 0), maxY: niceMax(Math.max(...ys, 1)) }
}
const xMap = (value: number, bounds: Bounds, width: number) => {
  // 使用时间戳距离而非数组下标，稀疏日期与连续日期才能位于同一真实时间轴。
  if (bounds.maxX === bounds.minX) return 0
  return Math.round(((value - bounds.minX) / (bounds.maxX - bounds.minX)) * (width - 1))
}
const yMap = (value: number, bounds: Bounds, height: number) => {
  // 终端 y 向下增长，数值 y 向上增长；翻转只发生一次，不能在页面再反转数据序列。
  if (bounds.maxY === bounds.minY) return height - 1
  return Math.round((1 - (value - bounds.minY) / (bounds.maxY - bounds.minY)) * (height - 1))
}
const UP = 1
const RIGHT = 2
const DOWN = 4
const LEFT = 8
// 四方向 bit mask 让相邻正交线段在交点合成为一个 box-drawing 字符，而不是互相覆盖。
const MASK_TO_CHAR: Record<number, string> = {
  [UP]: "│",
  [RIGHT]: "─",
  [DOWN]: "│",
  [LEFT]: "─",
  [UP | DOWN]: "│",
  [LEFT | RIGHT]: "─",
  [RIGHT | DOWN]: "╭",
  [LEFT | DOWN]: "╮",
  [UP | RIGHT]: "╰",
  [UP | LEFT]: "╯",
  [UP | RIGHT | DOWN]: "├",
  [UP | DOWN | LEFT]: "┤",
  [RIGHT | DOWN | LEFT]: "┬",
  [UP | RIGHT | LEFT]: "┴",
  [UP | RIGHT | DOWN | LEFT]: "┼",
}
const pointKey = (point: { x: number; y: number }) => `${point.x},${point.y}`
// 这里比较的是量化后的字符格；原始时间/数值仍保留在 series，不能用于此处的拓扑去重。
const samePoint = (a: { x: number; y: number }, b: { x: number; y: number }) => a.x === b.x && a.y === b.y
const addMask = (
  masks: Map<string, { x: number; y: number; mask: number }>,
  point: { x: number; y: number },
  mask: number,
) => {
  const key = pointKey(point)
  const existing = masks.get(key)
  // OR 合并保留一个格子的全部来向/去向，折线交叉和拐角因此不会丢边。
  masks.set(key, { x: point.x, y: point.y, mask: (existing?.mask ?? 0) | mask })
}
const drawOrthogonalSegment = (
  masks: Map<string, { x: number; y: number; mask: number }>,
  from: { x: number; y: number },
  to: { x: number; y: number },
) => {
  if (samePoint(from, to)) return
  if (from.y === to.y) {
    // 相邻两格各记录朝向对方的边，交点才能在最终合成时保留两个端点的连接关系。
    const step = from.x < to.x ? 1 : -1
    for (const x of range(Math.abs(to.x - from.x)).map((offset) => from.x + offset * step)) {
      addMask(masks, { x, y: from.y }, step > 0 ? RIGHT : LEFT)
      addMask(masks, { x: x + step, y: from.y }, step > 0 ? LEFT : RIGHT)
    }
    return
  }
  if (from.x === to.x) {
    // 上行和下行必须交换来向/去向；只给起点记边会让回折曲线出现断口。
    const step = from.y < to.y ? 1 : -1
    for (const y of range(Math.abs(to.y - from.y)).map((offset) => from.y + offset * step)) {
      addMask(masks, { x: from.x, y }, step > 0 ? DOWN : UP)
      addMask(masks, { x: from.x, y: y + step }, step > 0 ? UP : DOWN)
    }
    return
  }
  // 斜向采样统一先横后纵，保证同一输入在不同终端宽度下仍有确定的阶梯路径。
  drawOrthogonalSegment(masks, from, { x: to.x, y: from.y })
  drawOrthogonalSegment(masks, { x: to.x, y: from.y }, to)
}
const stepPath = (points: { x: number; y: number }[]) => {
  // 保留日序中的每次转折，不能先按终端列抽样再丢掉同一列内的高低变化。
  if (points.length <= 1) return points
  // 每两个采样点插入水平中点，连续日趋势使用细正交线而不是粗散点或伪平滑曲线。
  return points.slice(1).reduce(
    (path, point) => {
      const previous = path[path.length - 1]
      const mid = { x: point.x, y: previous.y }
      // 中点与前后点可能重合；去掉零长度边不会改变真实折线的转向或端点。
      if (!samePoint(previous, mid)) path.push(mid)
      if (!samePoint(path[path.length - 1], point)) path.push(point)
      return path
    },
    [points[0]],
  )
}
// 多个日期量化到同一字符格时只去除相邻重复点，不丢弃其前后的真实转折。
const compactPoints = (points: { x: number; y: number }[]) =>
  points.filter((point, index) => index === 0 || !samePoint(point, points[index - 1]))
const drawOrthogonalPolyline = (
  canvas: ChartCanvas,
  points: { x: number; y: number }[],
  style: ChartStyle,
  singlePointChar = "●",
) => {
  const path = stepPath(compactPoints(points))
  // 单点同样是观测而非空数据，必须占据一个可见格，不能要求两天数据才显示趋势。
  if (path.length === 0) return
  if (path.length === 1) {
    canvas.put(path[0].x, path[0].y, singlePointChar, style, style.priority + seriesPriority.singlePoint)
    return
  }
  // 每条 series 独立合成拓扑，交叉时再由 canvas priority 决定可见身份，不拼混两条线。
  const masks = new Map<string, { x: number; y: number; mask: number }>()
  path.slice(1).forEach((point, index) => drawOrthogonalSegment(masks, path[index], point))
  for (const item of masks.values())
    canvas.put(item.x, item.y, MASK_TO_CHAR[item.mask] ?? "┼", style, style.priority + seriesPriority.line)
}
const labelTicks = (labels: string[], width: number) => {
  // 标签稀疏策略仅影响日期文字，不影响曲线的样本和范围，不能借窄屏裁掉早期峰值。
  if (labels.length === 0) return ""
  const line = Array.from({ length: width }, () => " ")
  // 日期标签至少预留两个空格，窄图自动减少刻度，避免末端日期互相覆盖成无效字符串。
  // 只减少标签数量，不减少数据采样点，因此趋势形状不会随终端宽度改变。
  const count = Math.max(
    1,
    Math.min(layout.line.labelsMax, Math.floor(width / layout.line.labelSpacing), labels.length),
  )
  const indexes = labels.length <= count ? range(labels.length) : evenlySpaced(count, labels.length - 1)
  for (const index of indexes) {
    const label = labels[index]
    const labelWidth = visibleLength(label)
    const x = clamp(
      // 首尾标签贴住可用范围，中间标签居中；不能将最后一个日期打印到右边界以外。
      Math.round((index / Math.max(1, labels.length - 1)) * (width - 1)) - Math.floor(labelWidth / 2),
      0,
      Math.max(0, width - labelWidth),
    )
    let pos = x
    for (const char of Array.from(label)) {
      const width = charWidth(char)
      if (pos >= 0 && pos < line.length) line[pos] = char
      // 宽字符占据两列但只输出一次，后一个占位格必须清空，避免 CJK 标签重复占位。
      if (width === 2 && pos + 1 < line.length) line[pos + 1] = ""
      pos += width
    }
  }
  return line.join("")
}
const legend = (series: { label: string; color: ChartColor; mark?: string }[], ctx: RenderContext) =>
  // 图例直接消费 series 的身份色/mark，不能按最终筛选后的图例行再次分配颜色。
  series
    .map((item) => `${paint(item.mark ?? "●", item.color, ctx)} ${paint(item.label, item.color, ctx)}`)
    .join(paint(" · ", "muted", ctx))
export const metricFormatter = (metric: "tokens" | "cost") => (metric === "cost" ? money : formatNumber)
export const seriesFromUsage = (series: UsageSeries[], metric: "tokens" | "cost", limit: number): ChartSeries[] =>
  // Breakdown 只把已排序的前 N 个系列交给画布，避免颜色重复和折线过度重叠。
  series.slice(0, limit).map((item, index) => ({
    id: item.id,
    label: item.label,
    color: seriesColor(index),
    mark: chartMarks[index % chartMarks.length],
    total: metric === "cost" ? item.cost : item.tokens.total,
    // 费用与 Token 使用相同时间戳；切换量纲不得重排或重新生成日期窗口。
    points: item.points.map((point) => ({
      x: point.day,
      y: metric === "cost" ? point.cost : point.tokens.total,
      label: point.label,
      value: metric === "cost" ? point.cost : point.tokens.total,
    })),
  }))
export const dailySeries = (
  points: { day: number; label: string; value: number }[],
  color: ChartColor,
  label: string,
): ChartSeries => ({
  // 日总量与分类 series 共用画布协议，页面无需为主趋势再维护一种采样格式。
  id: label,
  label,
  color,
  mark: chartMarks[0],
  total: points.reduce((acc, point) => acc + point.value, 0),
  points: points.map((point) => ({ x: point.day, y: point.value, label: point.label, value: point.value })),
})

export function renderRoundedLineChart(input: {
  title: string
  series: ChartSeries[]
  width?: number
  height?: number
  color?: ColorMode
  metric?: "tokens" | "cost"
  formatter?: (value: number) => string
  yMin?: number
  yMax?: number
  points?: boolean
  legend?: boolean
}) {
  const ctx = renderContext(input.color)
  // 彩色输出用颜色区分系列，默认去掉粗点；无色输出保留形状作为可访问性回退。
  // 调用方显式 points 时仍拥有最高优先级，避免改变单点诊断图的既有行为。
  // 因此主题修复不会牺牲无色终端中区分重叠系列的能力。
  const points = input.points ?? !ctx.color
  const width = input.width ?? layout.line.width
  const height = input.height ?? layout.line.height
  const formatter = input.formatter ?? metricFormatter(input.metric ?? "tokens")
  const nonEmpty = input.series.filter((item) => item.points.some((point) => point.y > 0))
  // 空序列返回稳定文本而不是构造退化坐标轴，供空数据页面统一展示。
  if (nonEmpty.length === 0)
    return [paint(input.title, "title", ctx, true), paint("No line data for this range.", "muted", ctx)]
  // bounds 只读取实际可见系列；空系列不能抬高 Y 轴或改变其他线条的比较尺度。
  const rawBounds = boundsForSeries(nonEmpty)
  const bounds = {
    ...rawBounds,
    minY: input.yMin ?? rawBounds.minY,
    maxY: Math.max(input.yMax ?? rawBounds.maxY, (input.yMin ?? rawBounds.minY) + 1),
  }
  // 首列留给 Y 轴，数据映射从 plotLeft 开始，避免零点覆盖坐标轴字符。
  const plotLeft = width > 1 ? 1 : 0
  const plotWidth = Math.max(1, width - plotLeft)
  const plotHeight = Math.max(1, height - 1)
  const canvas = new ChartCanvas(width, height)
  // 网格保持最低绘制优先级，坐标轴和数据路径交叉时应完整覆盖它。
  canvas.grid(layout.line.gridX, layout.line.gridY)
  canvas.vertical(0, 0, height - 1, "│", axisStyle)
  canvas.horizontal(0, width - 1, height - 1, "─", axisStyle)
  canvas.put(0, height - 1, "└", axisStyle)
  nonEmpty.forEach((item, index) => {
    // 后出现的系列具有更高优先级，交叉点不会把后续路径擦除。
    const style: ChartStyle = { color: item.color, priority: seriesPriority.base + index }
    const mapped = item.points.map((point) => ({
      x: plotLeft + xMap(point.x, bounds, plotWidth),
      y: yMap(point.y, bounds, plotHeight),
    }))
    drawOrthogonalPolyline(canvas, mapped, style, points ? "●" : "─")
    if (points)
      mapped.forEach((point) =>
        canvas.put(
          point.x,
          point.y,
          item.mark ?? chartMarks[index % chartMarks.length],
          style,
          style.priority + seriesPriority.marker,
        ),
      )
  })
  // X 轴从 timestamp 生成固定日期，不复用本地化用户标签；
  // 因此中英文终端中的 Dashboard 坐标宽度保持一致。
  const labels = nonEmpty[0]?.points.map((point) => dateLabel(point.x)) ?? []
  // Y 轴使用圆整刻度，标签便于比较且不会暴露浮点噪声。
  const ticks = niceTicks(
    bounds.minY,
    bounds.maxY,
    Math.max(layout.line.ticksMin, Math.min(layout.line.ticksMax, plotHeight)),
  )
  const tickNiceMax = ticks[ticks.length - 1] ?? bounds.maxY
  const tickNiceMin = ticks[0] ?? bounds.minY
  const yAxisLines = canvas.render(ctx).map((line, rowIndex) => {
    // 先把画布行映射回数据值，再选择最近刻度，避免标签与网格错行。
    const rowValue = tickNiceMax - (tickNiceMax - tickNiceMin) * (rowIndex / Math.max(1, plotHeight - 1))
    const nearestTick = ticks.reduce(
      (best, t) => (Math.abs(t - rowValue) < Math.abs(best - rowValue) ? t : best),
      ticks[0] ?? 0,
    )
    const rowFrac = (tickNiceMax - rowValue) / Math.max(1, tickNiceMax - tickNiceMin)
    const tickFrac = (tickNiceMax - nearestTick) / Math.max(1, tickNiceMax - tickNiceMin)
    return Math.abs(rowFrac - tickFrac) < 0.5 / plotHeight ? formatter(nearestTick) : ""
  })
  const yAxisWidth = Math.max(layout.line.axisMin, ...yAxisLines.map(visibleLength))
  // Y 标签宽度取所有 tick 的最大可见宽度，ANSI 字节不参与几何计算。
  const renderedLines = canvas
    .render(ctx)
    .map((line, index) => `${paint(padStartVisible(yAxisLines[index] ?? "", yAxisWidth), "muted", ctx)} ${line}`)
  return [
    paint(input.title, "title", ctx, true),
    ...renderedLines,
    `${" ".repeat(yAxisWidth + 1)}${paint(labelTicks(labels, width), "muted", ctx)}`,
    ...(input.legend === false ? [] : [legend(nonEmpty, ctx)]),
  ]
}

export function renderHeatmap(input: {
  title: string
  points: HeatPoint[]
  color?: ColorMode
  width?: number
  emptyLabel?: string
  formatter?: (value: number) => string
}) {
  const ctx = renderContext(input.color)
  const width = input.width ?? layout.heatmap.width
  // 每个日期单元默认占两列，使周历保持自然间距；窄屏由调用方降低单元宽度。
  const maxWeeks = Math.max(1, Math.floor((width - layout.heatmap.labelWidth) / layout.heatmap.cellWidth))
  const points = input.points.slice(-maxWeeks * 7)
  if (points.length === 0)
    return [paint(input.title, "title", ctx, true), paint(input.emptyLabel ?? "No heatmap data.", "muted", ctx)]
  const max = safeMax(points.map((point) => point.value))
  // 零值使用可见中点而不是空格，用户才能区分“真实为零”和“日期未落入所选窗口”。
  const rows = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((label) => `${paint(label, "muted", ctx)} `)
  const start = new Date(points[0].day)
  const offset = (start.getDay() + 6) % 7
  points.forEach((point, index) => {
    const slot = index + offset
    const row = slot % 7
    const level =
      max <= 0 ? 0 : Math.min(heatLevels.length - 1, Math.ceil((point.value / max) * (heatLevels.length - 1)))
    rows[row] += paint(heatLevels[level], heatColors[level], ctx)
  })
  const peak = input.formatter?.(max) ?? formatNumber(max)
  // Legend 公开相对 peak 的四个闭合区间，未来调整 glyph 时也不能暗改强度分母。
  const legend = `· 0   ░ <=25% peak   ▒ <=50% peak   ▓ <=75% peak   █ >75% peak   peak ${peak}`
  return [
    paint(input.title, "title", ctx, true),
    ...rows.map((row) => fitVisible(row, width)),
    paint(legend, "muted", ctx),
  ]
}

export function renderPanel(input: { title?: string; lines: string[]; color?: ColorMode; width?: number }) {
  const ctx = renderContext(input.color)
  const content = input.title ? [paint(input.title, "title", ctx, true), ...input.lines] : input.lines
  const width = statsPanelWidth(input.width)
  const innerWidth = statsContentWidth(width)
  // 最终边界只换行和补空格，绝不能插入省略号或丢弃用户标签。
  // 具体背景色也禁止在这里填充，空格应继承终端自身主题。
  const lines = content
    .flatMap((line) => wrapAnsiVisible(line, innerWidth))
    .map((line) => `${" ".repeat(PANEL_PADDING)}${padEndVisible(line, innerWidth)}${" ".repeat(PANEL_PADDING)}`)
  if (!ctx.color) return lines.join("\n")
  return lines.map((line) => `${BACKGROUND_RESET}${line}${BACKGROUND_RESET}`).join("\n")
}
export function renderTwoColumn(
  left: string[],
  right: string[],
  gap: number = layout.columns.gap,
  width = statsContentWidth(),
  leftFraction: number = layout.columns.leftFraction,
) {
  const safeGap = Math.max(1, Math.min(gap, layout.columns.maxGap))
  const leftWidth = Math.max(
    1,
    Math.floor((width - safeGap) * Math.min(layout.columns.maxRatio, Math.max(layout.columns.minRatio, leftFraction))),
  )
  const rightWidth = Math.max(1, width - safeGap - leftWidth)
  const height = Math.max(left.length, right.length)
  // 每个逻辑行独立换行后再对齐，左列过长不会挤占右列或触发二次截断。
  return range(height).flatMap((index) => {
    const leftLines = wrapAnsiVisible(left[index] ?? "", leftWidth)
    const rightLines = wrapAnsiVisible(right[index] ?? "", rightWidth)
    return range(Math.max(leftLines.length, rightLines.length)).map(
      (line) =>
        `${padEndVisible(leftLines[line] ?? "", leftWidth)}${" ".repeat(safeGap)}${padEndVisible(rightLines[line] ?? "", rightWidth)}`,
    )
  })
}
export function renderThreeColumn(
  first: string[],
  second: string[],
  third: string[],
  gap: number = layout.columns.gap,
  width = statsContentWidth(),
) {
  const safeGap = Math.max(1, Math.min(gap, layout.columns.maxThreeGap))
  const baseWidth = Math.max(1, Math.floor((width - safeGap * 2) / 3))
  const firstWidth = baseWidth
  const secondWidth = baseWidth
  const thirdWidth = Math.max(1, width - safeGap * 2 - firstWidth - secondWidth)
  const height = Math.max(first.length, second.length, third.length)
  // 三栏保持固定列宽；内容增长只增加行数，不改变相邻图表的横向比例。
  return range(height).flatMap((index) => {
    const firstLines = wrapAnsiVisible(first[index] ?? "", firstWidth)
    const secondLines = wrapAnsiVisible(second[index] ?? "", secondWidth)
    const thirdLines = wrapAnsiVisible(third[index] ?? "", thirdWidth)
    return range(Math.max(firstLines.length, secondLines.length, thirdLines.length)).map(
      (line) =>
        `${padEndVisible(firstLines[line] ?? "", firstWidth)}${" ".repeat(safeGap)}${padEndVisible(secondLines[line] ?? "", secondWidth)}${" ".repeat(safeGap)}${padEndVisible(thirdLines[line] ?? "", thirdWidth)}`,
    )
  })
}
export function renderTabs(input: { tabs: { label: string; active?: boolean }[]; color?: ColorMode; width?: number }) {
  const ctx = renderContext(input.color)
  const line = input.tabs
    .map((tab) => paint(` ${tab.label} `, tab.active ? "yellow" : "muted", ctx, Boolean(tab.active)))
    .join(paint(" · ", "grid", ctx))
  const width = input.width ?? statsContentWidth()
  return visibleLength(line) <= width ? padEndVisible(line, width) : line
}
export function renderPercentStack(input: {
  title?: string
  rows: { label: string; color?: ChartColor; parts: { label: string; value: number; color: ChartColor }[] }[]
  color?: ColorMode
  width?: number
}) {
  const ctx = renderContext(input.color)
  const width = Math.max(layout.composition.minWidth, input.width ?? layout.composition.width)
  const labels = input.rows.map((row) => terminalText(row.label))
  // 以最长可见名称确定统一起点；24 列以上改为换行，不能截掉模型身份来换取对齐。
  const labelWidth = Math.max(
    layout.composition.minLabel,
    Math.min(layout.composition.maxLabel, Math.max(0, ...labels.map(visibleLength))),
  )
  const barWidth = Math.max(
    layout.composition.minBar,
    Math.min(layout.composition.maxBar, width - labelWidth - layout.composition.reserved),
  )
  const rows = input.rows.flatMap((row, rowIndex) => {
    // 持久化异常值只在图形边界收敛为零，避免 NaN、负数或 Infinity 破坏 repeat 和宽度闭合。
    const values = row.parts.map((part) => (Number.isFinite(part.value) ? Math.max(0, part.value) : 0))
    // 组成总和是该行 100% 的唯一分母；图形不借用跨模型 total，避免不同模型互相改变段宽。
    const total = values.reduce((sum, value) => sum + value, 0)
    const scaled = values.map((value) => (total > 0 ? (value / total) * barWidth : 0))
    const sizes = scaled.map(Math.floor)
    // largest-remainder 只分配真实舍入余数；小于一个像素的组成不会被强制补成虚假可见段。
    const order = scaled
      .map((value, index) => ({ index, remainder: value - sizes[index] }))
      .sort((a, b) => b.remainder - a.remainder || a.index - b.index)
    // 全零组成使用空条，不把“没有 token”错误舍入成任一组件占满 100%。
    const remaining = total > 0 ? barWidth - sizes.reduce((sum, size) => sum + size, 0) : 0
    order.slice(0, remaining).forEach((item) => sizes[item.index]++)
    const bar =
      total > 0
        ? row.parts.map((part, index) => paint("█".repeat(sizes[index]), part.color, ctx)).join("")
        : paint("░".repeat(barWidth), "grid", ctx)
    const wrappedLabel = wrapVisible(labels[rowIndex], labelWidth)
    const labelColor = row.color ?? "white"
    const details = row.parts
      .map((part, index) => {
        const share = total > 0 ? `${((values[index] / total) * 100).toFixed(1)}%` : "0.0%"
        return `${paint(part.label, part.color, ctx, true)} ${paint(formatNumber(values[index]), "white", ctx)} ${paint(share, "muted", ctx)}`
      })
      .join(paint(" · ", "grid", ctx))
    return [
      ...wrappedLabel.slice(0, -1).map((line) => paint(line, labelColor, ctx, true)),
      `${padEndVisible(paint(wrappedLabel.at(-1) ?? "", labelColor, ctx, true), labelWidth)} ${bar} ${paint(total > 0 ? "100%" : "0%", "muted", ctx)}`,
      // 精确值独占下一行，组成条可以保持固定起点和固定总宽度，不受标签或数值长度影响。
      // 这行也是无色模式的完整替代编码：即使各段纹理相同，用户仍能读取每个组成的量和占比。
      ...wrapAnsiVisible(details, Math.max(layout.composition.detailMin, width - layout.composition.detailIndent)).map(
        (line) => `${" ".repeat(layout.composition.detailIndent)}${line}`,
      ),
    ]
  })
  // 图例必须列出每个组成，颜色不能成为读取占比的唯一线索。
  const allParts = input.rows[0]?.parts ?? []
  const legendLine = allParts
    .map((part) => `${paint("■", part.color, ctx)} ${paint(part.label, "muted", ctx)}`)
    .join(paint("  ", "muted", ctx))
  return [
    ...(input.title ? [paint(input.title, "title", ctx, true)] : []),
    ...rows,
    ...wrapAnsiVisible(legendLine, width),
  ]
}
export function renderCallout(input: { title: string; body: string; color?: ColorMode; accent?: ChartColor }) {
  const ctx = renderContext(input.color)
  const accent = input.accent ?? "yellow"
  const width = Math.max(layout.callout.minWidth, statsContentWidth() - layout.callout.border)
  const innerWidth = Math.max(layout.callout.minInner, width - layout.callout.border)
  return [
    `${paint("╭", accent, ctx)}${paint("─".repeat(width), "grid", ctx)}${paint("╮", accent, ctx)}`,
    ...wrapVisible(input.title, innerWidth).map(
      (line) =>
        `${paint("│", accent, ctx)} ${padEndVisible(paint(line, "title", ctx, true), innerWidth)} ${paint("│", accent, ctx)}`,
    ),
    // 正文可能是多行建议列表；在 primitive 内拆行，调用方无需复制布局逻辑，
    // 也不会让原始换行泄漏到 panel 行并破坏固定宽度。
    ...input.body
      .split("\n")
      .flatMap((line) =>
        wrapVisible(line, innerWidth).map(
          (wrapped) =>
            `${paint("│", accent, ctx)} ${padEndVisible(paint(wrapped, "subtitle", ctx), innerWidth)} ${paint("│", accent, ctx)}`,
        ),
      ),
    `${paint("╰", accent, ctx)}${paint("─".repeat(width), "grid", ctx)}${paint("╯", accent, ctx)}`,
  ]
}
export function renderComparisonTable(input: {
  title: string
  headers: string[]
  rows: string[][]
  colors?: (ChartColor | undefined)[][]
  color?: ColorMode
}) {
  const ctx = renderContext(input.color)
  const widths = input.headers.map((header, index) =>
    Math.max(visibleLength(header), ...input.rows.map((row) => visibleLength(row[index] ?? ""))),
  )
  // 单元格颜色只覆盖实体身份或异常语义；没有显式颜色的数值继续使用终端默认前景。
  const rowLine = (row: string[], color: ChartColor, bold = false, colors?: (ChartColor | undefined)[]) =>
    row
      .map((cell, index) =>
        padEndVisible(paint(cell, colors?.[index] ?? color, ctx, bold || colors?.[index] !== undefined), widths[index]),
      )
      .join(paint(" │ ", "grid", ctx))
  return [
    paint(input.title, "title", ctx, true),
    rowLine(input.headers, "subtitle", true),
    paint(widths.map((width) => "─".repeat(width)).join("─┼─"), "grid", ctx),
    ...input.rows.map((row, index) => rowLine(row, "white", false, input.colors?.[index])),
  ]
}
