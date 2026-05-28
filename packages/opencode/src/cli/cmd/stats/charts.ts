import { formatNumber } from "../../format"
import type { TokenPartSeries, UsageSeries } from "./data"
import type { ColorMode } from "./render"

const BOLD = "\x1b[1m"
const TEXT_RESET = "\x1b[22m\x1b[39m"
// 49m 只恢复终端默认背景，不指定具体颜色；独立 panel 同样需要清掉上游背景状态。
const BACKGROUND_RESET = "\x1b[49m"
const ANSI_RE = /\x1b\[[0-9;]*m/g
const ANSI_PREFIX_RE = /^\x1b\[[0-9;]*m/
const DEFAULT_PANEL_WIDTH = 104
const MIN_PANEL_WIDTH = 58
const PANEL_PADDING = 2

const fg = (r: number, g: number, b: number) => `\x1b[38;2;${r};${g};${b}m`

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

export type ChartStyle = {
  color: ChartColor
  priority: number
  bold?: boolean
}

export type ChartPoint = {
  x: number
  y: number
  label?: string
  value?: number
}

export type ChartSeries = {
  id: string
  label: string
  color: ChartColor
  mark?: string
  points: ChartPoint[]
  total?: number
}

export type ChartLayer = {
  id: string
  label: string
  color: ChartColor
  values: number[]
  total?: number
}

export type HeatPoint = {
  day: number
  label: string
  value: number
}

export type HistogramBucket = {
  label: string
  count: number
  value: number
}

type Cell = {
  char: string
  style?: ChartStyle
  priority: number
}

type Bounds = {
  minX: number
  maxX: number
  minY: number
  maxY: number
}

type RenderContext = {
  color: boolean
  palette: Record<ChartColor, string>
}

const palette: Record<ChartColor, string> = {
  axis: fg(146, 110, 154),
  muted: fg(158, 130, 170),
  title: fg(246, 241, 248),
  subtitle: fg(198, 171, 207),
  blue: fg(78, 198, 224),
  cyan: fg(98, 226, 218),
  green: fg(95, 216, 139),
  yellow: fg(238, 203, 83),
  orange: fg(236, 145, 70),
  purple: fg(196, 123, 232),
  pink: fg(239, 119, 178),
  red: fg(246, 111, 125),
  white: fg(248, 244, 250),
  grid: fg(74, 45, 82),
}

const chartColors: ChartColor[] = ["blue", "green", "yellow", "purple", "pink", "cyan", "orange", "red"]
const chartMarks = ["●", "◆", "■", "▲", "◇", "○", "✕", "+"]

const axisStyle: ChartStyle = { color: "axis", priority: 20 }
const gridStyle: ChartStyle = { color: "grid", priority: 0 }
const labelStyle: ChartStyle = { color: "subtitle", priority: 10 }

const useColor = (mode: ColorMode = "auto") => {
  if (mode === "always") return true
  if (mode === "never") return false
  if (process.env.NO_COLOR) return false
  return Boolean(process.stdout.isTTY)
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
  const code = char.codePointAt(0)
  if (code === undefined) return 0
  if (code === 0 || code < 32 || (code >= 0x7f && code < 0xa0) || isCombining(code)) return 0
  return isWide(code) ? 2 : 1
}

export const visibleLength = (text: string) => Array.from(text.replace(ANSI_RE, "")).reduce((sum, char) => sum + charWidth(char), 0)

export const stripAnsi = (text: string) => text.replace(ANSI_RE, "")

export const padEndVisible = (text: string, width: number) => text + " ".repeat(Math.max(0, width - visibleLength(text)))

export const padStartVisible = (text: string, width: number) =>
  " ".repeat(Math.max(0, width - visibleLength(text))) + text

export const statsPanelWidth = (width?: number) => {
  const columns = Number(process.stdout.columns ?? process.env.COLUMNS)
  const terminalWidth = Number.isFinite(columns) && columns > 0 ? Math.max(20, columns - 2) : DEFAULT_PANEL_WIDTH
  const preferred = width ?? terminalWidth
  return Math.max(Math.min(MIN_PANEL_WIDTH, terminalWidth), Math.min(preferred, terminalWidth))
}

export const statsContentWidth = (width?: number) => Math.max(20, statsPanelWidth(width) - PANEL_PADDING * 2)

export const truncateVisible = (text: string, width: number) => {
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

export const renderContext = (mode: ColorMode = "auto"): RenderContext => ({
  color: useColor(mode),
  palette,
})

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))

const safeMax = (values: number[]) => Math.max(0, ...values.filter(Number.isFinite))

const niceMax = (value: number) => {
  if (!Number.isFinite(value) || value <= 0) return 1
  const exponent = Math.floor(Math.log10(value))
  const base = 10 ** exponent
  const scaled = value / base
  const step = [1, 1.25, 1.5, 2, 2.5, 3, 4, 5, 7.5, 10].find((item) => scaled <= item) ?? 10
  return step * base
}

/** Round a rough step to a human-friendly interval: 1/2/5 × 10^n */
const niceStep = (rough: number): number => {
  if (rough <= 0) return 1
  const exp = Math.floor(Math.log10(rough))
  const f = rough / Math.pow(10, exp)
  if (f < 1.5) return Math.pow(10, exp)
  if (f < 3) return 2 * Math.pow(10, exp)
  if (f < 7) return 5 * Math.pow(10, exp)
  return Math.pow(10, exp + 1)
}

/** Compute nice Y-axis tick values for a given data range */
const niceTicks = (min: number, max: number, targetCount = 5): number[] => {
  if (max <= min) return [min, min + 1]
  const step = niceStep((max - min) / Math.max(1, targetCount - 1))
  const niceMin = Math.floor(min / step) * step
  const niceMaxVal = Math.ceil(max / step) * step
  const ticks: number[] = []
  for (let v = niceMin; v <= niceMaxVal + step / 2; v += step) ticks.push(v)
  return ticks.length >= 2 ? ticks : [min, max]
}

const range = (count: number) => Array.from({ length: Math.max(0, count) }, (_, index) => index)

const evenlySpaced = (count: number, max: number) => {
  if (count <= 1) return [0]
  return range(count).map((index) => Math.round((index / (count - 1)) * max))
}

const dateLabel = (time: number) => {
  const date = new Date(time)
  return `${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`
}

const money = (value: number) => {
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
    this.width = width
    this.height = height
    this.cells = range(height).map(() => range(width).map(() => ({ char: " ", priority: -1 })))
  }

  put(x: number, y: number, char: string, style: ChartStyle = axisStyle, priority = style.priority) {
    if (x < 0 || x >= this.width || y < 0 || y >= this.height) return
    const cell = this.cells[y][x]
    if (priority < cell.priority) return
    cell.char = char
    cell.style = style
    cell.priority = priority
  }

  text(x: number, y: number, text: string, style: ChartStyle = labelStyle) {
    Array.from(text).forEach((char, index) => this.put(x + index, y, char, style))
  }

  horizontal(x1: number, x2: number, y: number, char: string, style: ChartStyle = axisStyle) {
    for (const x of range(Math.abs(x2 - x1) + 1).map((offset) => Math.min(x1, x2) + offset)) {
      this.put(x, y, char, style)
    }
  }

  vertical(x: number, y1: number, y2: number, char: string, style: ChartStyle = axisStyle) {
    for (const y of range(Math.abs(y2 - y1) + 1).map((offset) => Math.min(y1, y2) + offset)) {
      this.put(x, y, char, style)
    }
  }

  box(style: ChartStyle = axisStyle) {
    this.horizontal(1, this.width - 2, 0, "─", style)
    this.horizontal(1, this.width - 2, this.height - 1, "─", style)
    this.vertical(0, 1, this.height - 2, "│", style)
    this.vertical(this.width - 1, 1, this.height - 2, "│", style)
    this.put(0, 0, "╭", style)
    this.put(this.width - 1, 0, "╮", style)
    this.put(0, this.height - 1, "╰", style)
    this.put(this.width - 1, this.height - 1, "╯", style)
  }

  grid(columns: number, rows: number) {
    for (const x of evenlySpaced(columns, this.width - 1)) this.vertical(x, 0, this.height - 1, "┆", gridStyle)
    for (const y of evenlySpaced(rows, this.height - 1)) this.horizontal(0, this.width - 1, y, "┄", gridStyle)
  }

  render(ctx: RenderContext) {
    return this.cells.map((row) => {
      const parts: string[] = []
      let active: ChartStyle | undefined
      for (const cell of row) {
        if (ctx.color && cell.style !== active) {
          active = cell.style
          parts.push(active ? `${active.bold ? BOLD : ""}${ctx.palette[active.color]}` : TEXT_RESET)
        }
        parts.push(cell.char)
      }
      if (ctx.color && active) parts.push(TEXT_RESET)
      return parts.join("")
    })
  }
}

const boundsForSeries = (series: ChartSeries[]): Bounds => {
  const points = series.flatMap((item) => item.points)
  const xs = points.map((point) => point.x)
  const ys = points.map((point) => point.y)
  const minX = xs.length === 0 ? 0 : Math.min(...xs)
  const maxX = xs.length === 0 ? 1 : Math.max(...xs)
  return {
    minX,
    maxX: maxX === minX ? minX + 1 : maxX,
    minY: Math.min(...ys, 0),
    maxY: niceMax(Math.max(...ys, 1)),
  }
}

const xMap = (value: number, bounds: Bounds, width: number) => {
  if (bounds.maxX === bounds.minX) return 0
  return Math.round(((value - bounds.minX) / (bounds.maxX - bounds.minX)) * (width - 1))
}

const yMap = (value: number, bounds: Bounds, height: number) => {
  if (bounds.maxY === bounds.minY) return height - 1
  return Math.round((1 - (value - bounds.minY) / (bounds.maxY - bounds.minY)) * (height - 1))
}

const UP = 1
const RIGHT = 2
const DOWN = 4
const LEFT = 8

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

const samePoint = (a: { x: number; y: number }, b: { x: number; y: number }) => a.x === b.x && a.y === b.y

const addMask = (masks: Map<string, { x: number; y: number; mask: number }>, point: { x: number; y: number }, mask: number) => {
  const key = pointKey(point)
  const existing = masks.get(key)
  masks.set(key, { x: point.x, y: point.y, mask: (existing?.mask ?? 0) | mask })
}

const drawOrthogonalSegment = (masks: Map<string, { x: number; y: number; mask: number }>, from: { x: number; y: number }, to: { x: number; y: number }) => {
  if (samePoint(from, to)) return
  if (from.y === to.y) {
    const step = from.x < to.x ? 1 : -1
    for (const x of range(Math.abs(to.x - from.x)).map((offset) => from.x + offset * step)) {
      addMask(masks, { x, y: from.y }, step > 0 ? RIGHT : LEFT)
      addMask(masks, { x: x + step, y: from.y }, step > 0 ? LEFT : RIGHT)
    }
    return
  }
  if (from.x === to.x) {
    const step = from.y < to.y ? 1 : -1
    for (const y of range(Math.abs(to.y - from.y)).map((offset) => from.y + offset * step)) {
      addMask(masks, { x: from.x, y }, step > 0 ? DOWN : UP)
      addMask(masks, { x: from.x, y: y + step }, step > 0 ? UP : DOWN)
    }
    return
  }
  drawOrthogonalSegment(masks, from, { x: to.x, y: from.y })
  drawOrthogonalSegment(masks, { x: to.x, y: from.y }, to)
}

const stepPath = (points: { x: number; y: number }[]) => {
  if (points.length <= 1) return points
  return points.slice(1).reduce(
    (path, point) => {
      const previous = path[path.length - 1]
      const mid = { x: point.x, y: previous.y }
      if (!samePoint(previous, mid)) path.push(mid)
      if (!samePoint(path[path.length - 1], point)) path.push(point)
      return path
    },
    [points[0]],
  )
}

const compactPoints = (points: { x: number; y: number }[]) =>
  points.filter((point, index) => index === 0 || !samePoint(point, points[index - 1]))

const drawOrthogonalPolyline = (canvas: ChartCanvas, points: { x: number; y: number }[], style: ChartStyle, singlePointChar = "●") => {
  const path = stepPath(compactPoints(points))
  if (path.length === 0) return
  if (path.length === 1) {
    canvas.put(path[0].x, path[0].y, singlePointChar, style, style.priority + 3)
    return
  }
  const masks = new Map<string, { x: number; y: number; mask: number }>()
  path.slice(1).forEach((point, index) => drawOrthogonalSegment(masks, path[index], point))
  for (const item of masks.values()) canvas.put(item.x, item.y, MASK_TO_CHAR[item.mask] ?? "┼", style, style.priority + 1)
}

const labelTicks = (labels: string[], width: number) => {
  if (labels.length === 0) return ""
  const line = Array.from({ length: width }, () => " ")
  const indexes = labels.length <= 4 ? range(labels.length) : [0, Math.floor(labels.length / 3), Math.floor((labels.length * 2) / 3), labels.length - 1]
  for (const index of indexes) {
    const label = labels[index]
    const labelWidth = visibleLength(label)
    const x = clamp(
      Math.round((index / Math.max(1, labels.length - 1)) * (width - 1)) - Math.floor(labelWidth / 2),
      0,
      Math.max(0, width - labelWidth),
    )
    let pos = x
    for (const char of Array.from(label)) {
      const width = charWidth(char)
      if (pos >= 0 && pos < line.length) line[pos] = char
      if (width === 2 && pos + 1 < line.length) line[pos + 1] = ""
      pos += width
    }
  }
  return line.join("")
}

const axisLabels = (min: number, max: number, height: number, formatter: (value: number) => string) =>
  range(height).map((index) => formatter(max - (max - min) * (index / Math.max(1, height - 1))))

const withYAxis = (plotLines: string[], max: number, formatter: (value: number) => string, ctx: RenderContext) => {
  const labels = axisLabels(0, max, plotLines.length, formatter)
  const width = Math.max(5, ...labels.map(visibleLength))
  return plotLines.map((line, index) => `${paint(padStartVisible(labels[index], width), "muted", ctx)} ${line}`)
}

const withYAxisRange = (plotLines: string[], bounds: Bounds, formatter: (value: number) => string, ctx: RenderContext) => {
  const labels = axisLabels(bounds.minY, bounds.maxY, plotLines.length, formatter)
  const width = Math.max(5, ...labels.map(visibleLength))
  return plotLines.map((line, index) => `${paint(padStartVisible(labels[index], width), "muted", ctx)} ${line}`)
}

const legend = (series: { label: string; color: ChartColor; mark?: string }[], ctx: RenderContext) =>
  series.map((item) => `${paint(item.mark ?? "●", item.color, ctx)} ${paint(item.label, item.color, ctx)}`).join(paint(" · ", "muted", ctx))

const layerLegend = (layers: { label: string; color: ChartColor }[], ctx: RenderContext) =>
  layers.map((item) => `${paint("■", item.color, ctx)} ${paint(item.label, item.color, ctx)}`).join(paint(" · ", "muted", ctx))

export const metricFormatter = (metric: "tokens" | "cost") => (metric === "cost" ? money : formatNumber)

export const seriesFromUsage = (series: UsageSeries[], metric: "tokens" | "cost", limit: number): ChartSeries[] =>
  series.slice(0, limit).map((item, index) => ({
    id: item.id,
    label: item.label,
    color: chartColors[index % chartColors.length],
    mark: chartMarks[index % chartMarks.length],
    total: metric === "cost" ? item.cost : item.tokens.total,
    points: item.points.map((point) => ({
      x: point.day,
      y: metric === "cost" ? point.cost : point.tokens.total,
      label: point.label,
      value: metric === "cost" ? point.cost : point.tokens.total,
    })),
  }))

export const layersFromTokenParts = (parts: TokenPartSeries[]): ChartLayer[] =>
  // Token stacks read bottom-to-top in this order. Output is last so even a
  // tiny response-token slice can survive overlap as the visible top band.
  ([
    { id: "cacheRead", label: "Cache Read", color: "yellow" },
    { id: "input", label: "Input", color: "blue" },
    { id: "cacheWrite", label: "Cache Write", color: "purple" },
    { id: "output", label: "Output", color: "green" },
  ] as const).flatMap((layer) => {
    const part = parts.find((item) => item.id === layer.id)
    if (!part) return []
    return [{ ...layer, values: part.points.map((point) => point.value), total: part.total }]
  })

export const dailySeries = (points: { day: number; label: string; value: number }[], color: ChartColor, label: string): ChartSeries => ({
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
  const width = input.width ?? 64
  const height = input.height ?? 12
  const formatter = input.formatter ?? metricFormatter(input.metric ?? "tokens")
  const nonEmpty = input.series.filter((item) => item.points.some((point) => point.y > 0))
  if (nonEmpty.length === 0) return [paint(input.title, "title", ctx, true), paint("No line data for this range.", "muted", ctx)]
  const rawBounds = boundsForSeries(nonEmpty)
  const bounds = {
    ...rawBounds,
    minY: input.yMin ?? rawBounds.minY,
    maxY: Math.max(input.yMax ?? rawBounds.maxY, (input.yMin ?? rawBounds.minY) + 1),
  }
  const plotLeft = width > 1 ? 1 : 0
  const plotWidth = Math.max(1, width - plotLeft)
  const plotHeight = Math.max(1, height - 1)
  const canvas = new ChartCanvas(width, height)
  // The grid stays low-priority so axes and data paths overwrite it cleanly.
  canvas.grid(5, 4)
  canvas.vertical(0, 0, height - 1, "│", axisStyle)
  canvas.horizontal(0, width - 1, height - 1, "─", axisStyle)
  canvas.put(0, height - 1, "└", axisStyle)
  nonEmpty.forEach((item, index) => {
    const style: ChartStyle = { color: item.color, priority: 30 + index }
    const mapped = item.points.map((point) => ({ x: plotLeft + xMap(point.x, bounds, plotWidth), y: yMap(point.y, bounds, plotHeight) }))
    drawOrthogonalPolyline(canvas, mapped, style, input.points === false ? "─" : "●")
    if (input.points !== false) mapped.forEach((point) => canvas.put(point.x, point.y, item.mark ?? chartMarks[index % chartMarks.length], style, style.priority + 5))
  })
  // X-axis labels come from timestamps, not locale/user labels, so dashboard
  // charts stay stable across CJK and English terminals.
  const labels = nonEmpty[0]?.points.map((point) => dateLabel(point.x)) ?? []
  // Build Y-axis using nice ticks so labels are human-friendly round numbers
  const ticks = niceTicks(bounds.minY, bounds.maxY, Math.max(3, Math.min(6, plotHeight)))
  const tickNiceMax = ticks[ticks.length - 1] ?? bounds.maxY
  const tickNiceMin = ticks[0] ?? bounds.minY
  const yAxisLines = canvas.render(ctx).map((line, rowIndex) => {
    // Map row index back to a data value, then find the nearest tick
    const rowValue = tickNiceMax - (tickNiceMax - tickNiceMin) * (rowIndex / Math.max(1, plotHeight - 1))
    const nearestTick = ticks.reduce((best, t) => Math.abs(t - rowValue) < Math.abs(best - rowValue) ? t : best, ticks[0] ?? 0)
    const rowFrac = (tickNiceMax - rowValue) / Math.max(1, tickNiceMax - tickNiceMin)
    const tickFrac = (tickNiceMax - nearestTick) / Math.max(1, tickNiceMax - tickNiceMin)
    const label = Math.abs(rowFrac - tickFrac) < 0.5 / plotHeight ? formatter(nearestTick) : ""
    return label
  })
  const yAxisWidth = Math.max(5, ...yAxisLines.map(visibleLength))
  const renderedLines = canvas.render(ctx).map((line, index) => `${paint(padStartVisible(yAxisLines[index] ?? "", yAxisWidth), "muted", ctx)} ${line}`)
  return [
    paint(input.title, "title", ctx, true),
    ...renderedLines,
    `${" ".repeat(yAxisWidth + 1)}${paint(labelTicks(labels, width), "muted", ctx)}`,
    ...(input.legend === false ? [] : [legend(nonEmpty, ctx)]),
  ]
}

export function renderStackedAreaChart(input: {
  title: string
  layers: ChartLayer[]
  labels?: string[]
  width?: number
  height?: number
  color?: ColorMode
  formatter?: (value: number) => string
  bars?: boolean
}) {
  const ctx = renderContext(input.color)
  const width = input.width ?? 64
  const height = input.height ?? 12
  const layers = input.layers.filter((layer) => layer.values.some((value) => value > 0))
  if (layers.length === 0) return [paint(input.title, "title", ctx, true), paint("No stacked data for this range.", "muted", ctx)]
  const maxLength = Math.max(...layers.map((layer) => layer.values.length), 0)
  // `bars` keeps one sampled day per drawn column. The default area mode still
  // interpolates across every x-cell for timeline charts that want continuous bands.
  const sourceIndexes = input.bars
    ? evenlySpaced(Math.min(maxLength, Math.max(1, Math.floor((width + 1) / 2))), maxLength - 1)
    : range(width).map((index) => maxLength <= 1 ? 0 : Math.round((index / Math.max(1, width - 1)) * (maxLength - 1)))
  const columns = sourceIndexes.map((sourceIndex, index) => ({
    x: input.bars && sourceIndexes.length > 1 ? Math.round((index / (sourceIndexes.length - 1)) * (width - 1)) : index,
    values: layers.map((layer) => layer.values[sourceIndex] ?? 0),
  }))
  const maxTotal = niceMax(Math.max(...columns.map((column) => column.values.reduce((acc, value) => acc + value, 0)), 1))
  const canvas = new ChartCanvas(width, height)
  columns.forEach((column) => {
    let base = 0
    column.values.forEach((value, layerIndex) => {
      const top = base + value
      const y1 = yMap(base, { minX: 0, maxX: width - 1, minY: 0, maxY: maxTotal }, height)
      const y2 = yMap(top, { minX: 0, maxX: width - 1, minY: 0, maxY: maxTotal }, height)
      // Inclusive fill gives every non-zero slice at least one cell; later
      // layers intentionally win overlaps so tiny Output remains visible on top.
      for (const y of range(Math.abs(y1 - y2) + 1).map((offset) => Math.min(y1, y2) + offset)) {
        canvas.put(column.x, y, "█", { color: layers[layerIndex].color, priority: 10 + layerIndex })
      }
      base = top
    })
  })
  canvas.vertical(0, 0, height - 1, "│", axisStyle)
  canvas.horizontal(0, width - 1, height - 1, "─", axisStyle)
  const labels = input.labels ?? range(maxLength).map(String)
  return [
    paint(input.title, "title", ctx, true),
    ...withYAxis(canvas.render(ctx), maxTotal, input.formatter ?? formatNumber, ctx),
    `${" ".repeat(7)}${paint(labelTicks(labels, width), "muted", ctx)}`,
    layerLegend(layers, ctx),
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
  const width = input.width ?? 52
  // Each day cell is 2 columns wide so the calendar reads naturally.
  const maxWeeks = Math.max(1, Math.floor((width - 4) / 2))
  const points = input.points.slice(-maxWeeks * 7)
  if (points.length === 0) return [paint(input.title, "title", ctx, true), paint(input.emptyLabel ?? "No heatmap data.", "muted", ctx)]
  const max = safeMax(points.map((point) => point.value))
  const levels = ["  ", "░░", "▒▒", "▓▓", "██"]
  const rows = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((label) => `${paint(label, "muted", ctx)} `)
  const start = new Date(points[0].day)
  const offset = (start.getDay() + 6) % 7
  points.forEach((point, index) => {
    const slot = index + offset
    const row = slot % 7
    const level = max <= 0 ? 0 : Math.min(levels.length - 1, Math.ceil((point.value / max) * (levels.length - 1)))
    const color = level >= 4 ? "pink" : level === 3 ? "purple" : level === 2 ? "blue" : level === 1 ? "muted" : "grid"
    rows[row] += paint(levels[level], color, ctx)
  })
  const caption = points.length
    ? `${points[0].label} → ${points.at(-1)?.label ?? points[0].label}  max ${input.formatter?.(max) ?? formatNumber(max)}`
    : ""
  return [paint(input.title, "title", ctx, true), ...rows.map((row) => fitVisible(row, width)), paint(caption, "muted", ctx)]
}

export function renderHistogram(input: {
  title: string
  values: number[]
  color?: ColorMode
  width?: number
  buckets?: number
  formatter?: (value: number) => string
}) {
  const ctx = renderContext(input.color)
  const width = input.width ?? 56
  const buckets = input.buckets ?? 12
  const values = input.values.filter((value) => Number.isFinite(value) && value >= 0)
  if (values.length === 0) return [paint(input.title, "title", ctx, true), paint("No distribution data.", "muted", ctx)]
  const max = Math.max(...values)
  const min = Math.min(...values)
  const span = Math.max(1, max - min)
  const counts = range(buckets).map(() => 0)
  values.forEach((value) => {
    const index = Math.min(buckets - 1, Math.floor(((value - min) / span) * buckets))
    counts[index]++
  })
  const maxCount = Math.max(...counts, 1)
  const formatter = input.formatter ?? formatNumber
  const rows = counts.map((count, index) => {
    const start = min + (span / buckets) * index
    const end = min + (span / buckets) * (index + 1)
    const bar = paint("█".repeat(Math.round((count / maxCount) * width)), chartColors[index % chartColors.length], ctx)
    return `${paint(`${formatter(start)}-${formatter(end)}`.padStart(15), "muted", ctx)} │ ${padEndVisible(bar, width)} ${count}`
  })
  return [paint(input.title, "title", ctx, true), ...rows]
}

export function renderRankBars(input: {
  title: string
  rows: { label: string; value: number; subvalue?: string; color?: ChartColor }[]
  color?: ColorMode
  width?: number
  totalWidth?: number
  labelWidth?: number
  subvalueWidth?: number
  formatter?: (value: number) => string
}) {
  const ctx = renderContext(input.color)
  const width = input.width ?? 46
  const rows = input.rows.filter((row) => row.value > 0)
  if (rows.length === 0) return [paint(input.title, "title", ctx, true), paint("No ranked data.", "muted", ctx)]
  const max = Math.max(...rows.map((row) => row.value), 1)
  const formatter = input.formatter ?? formatNumber
  const valWidth = Math.max(...rows.map((row) => visibleLength(formatter(row.value))), 6)
  if (input.totalWidth) {
    const totalWidth = Math.max(20, input.totalWidth)
    const hasSubvalue = rows.some((row) => row.subvalue)
    const subvalueWidth = hasSubvalue && totalWidth >= 52 ? Math.min(input.subvalueWidth ?? 12, Math.max(0, totalWidth - 42)) : 0
    const labelWidth = Math.max(
      6,
      Math.min(input.labelWidth ?? 18, Math.max(6, totalWidth - valWidth - (subvalueWidth ? subvalueWidth + 1 : 0) - 10)),
    )
    const barWidth = Math.max(1, totalWidth - 2 - 1 - labelWidth - 1 - 1 - valWidth - (subvalueWidth ? subvalueWidth + 1 : 0))
    return [
      fitVisible(paint(input.title, "title", ctx, true), totalWidth),
      ...rows.map((row, index) => {
        const color = row.color ?? chartColors[index % chartColors.length]
        const size = Math.max(1, Math.round((row.value / max) * barWidth))
        const subvalue = subvalueWidth ? ` ${fitVisible(paint(row.subvalue ?? "", "muted", ctx), subvalueWidth)}` : ""
        return fitVisible(
          `${paint(String(index + 1).padStart(2), "muted", ctx)} ${padEndVisible(paint(truncateVisible(row.label, labelWidth), "white", ctx, true), labelWidth)} ${paint("█".repeat(size), color, ctx)}${paint("░".repeat(barWidth - size), "grid", ctx)} ${paint(padStartVisible(formatter(row.value), valWidth), "subtitle", ctx)}${subvalue}`,
          totalWidth,
        )
      }),
    ]
  }
  // label(24) + space(1) + bar(width) + space(1) + val(valWidth) + space(1) + subvalue
  const labelWidth = 24
  return [
    paint(input.title, "title", ctx, true),
    ...rows.map((row, index) => {
      const color = row.color ?? chartColors[index % chartColors.length]
      const size = Math.max(1, Math.round((row.value / max) * width))
      return `${paint(String(index + 1).padStart(2), "muted", ctx)} ${padEndVisible(paint(truncateVisible(row.label, labelWidth), "white", ctx, true), labelWidth)} ${paint("█".repeat(size), color, ctx)}${paint("░".repeat(width - size), "grid", ctx)} ${paint(padStartVisible(formatter(row.value), valWidth), "subtitle", ctx)} ${paint(row.subvalue ?? "", "muted", ctx)}`
    }),
  ]
}

export function renderMatrix(input: {
  title: string
  xLabels: string[]
  yLabels: string[]
  values: number[][]
  color?: ColorMode
  formatter?: (value: number) => string
}) {
  const ctx = renderContext(input.color)
  if (input.xLabels.length === 0 || input.yLabels.length === 0) {
    return [paint(input.title, "title", ctx, true), paint("No matrix data.", "muted", ctx)]
  }
  const max = safeMax(input.values.flat())
  const shades = [" ", "░", "▒", "▓", "█"]
  const header = `${" ".repeat(16)}${input.xLabels.map((label) => paint(padStartVisible(truncateVisible(label, 3), 4), "muted", ctx)).join("")}`
  const rows = input.yLabels.map((label, y) => {
    const cells = input.xLabels.map((_, x) => {
      const value = input.values[y]?.[x] ?? 0
      const level = max <= 0 ? 0 : Math.min(shades.length - 1, Math.ceil((value / max) * (shades.length - 1)))
      return paint(shades[level].repeat(4), chartColors[level % chartColors.length], ctx)
    })
    return `${padEndVisible(paint(truncateVisible(label, 14), "white", ctx, true), 14)}  ${cells.join("")}`
  })
  return [paint(input.title, "title", ctx, true), header, ...rows]
}

export function renderPanel(input: { title?: string; lines: string[]; color?: ColorMode; width?: number }) {
  const ctx = renderContext(input.color)
  const content = input.title ? [paint(input.title, "title", ctx, true), ...input.lines] : input.lines
  const width = statsPanelWidth(input.width)
  const innerWidth = statsContentWidth(width)
  const lines = content.map((line) => `${" ".repeat(PANEL_PADDING)}${fitVisible(line, innerWidth)}${" ".repeat(PANEL_PADDING)}`)
  if (!ctx.color) return lines.join("\n")
  return lines.map((line) => `${BACKGROUND_RESET}${line}${BACKGROUND_RESET}`).join("\n")
}

export function renderTwoColumn(left: string[], right: string[], gap = 4, width = statsContentWidth(), leftFraction = 0.5) {
  const safeGap = Math.max(1, Math.min(gap, 8))
  const leftWidth = Math.max(1, Math.floor((width - safeGap) * Math.min(0.9, Math.max(0.1, leftFraction))))
  const rightWidth = Math.max(1, width - safeGap - leftWidth)
  const height = Math.max(left.length, right.length)
  return range(height).map((index) => `${fitVisible(left[index] ?? "", leftWidth)}${" ".repeat(safeGap)}${fitVisible(right[index] ?? "", rightWidth)}`)
}

export function renderThreeColumn(first: string[], second: string[], third: string[], gap = 4, width = statsContentWidth()) {
  const safeGap = Math.max(1, Math.min(gap, 6))
  const baseWidth = Math.max(1, Math.floor((width - safeGap * 2) / 3))
  const firstWidth = baseWidth
  const secondWidth = baseWidth
  const thirdWidth = Math.max(1, width - safeGap * 2 - firstWidth - secondWidth)
  const height = Math.max(first.length, second.length, third.length)
  return range(height).map(
    (index) =>
      `${fitVisible(first[index] ?? "", firstWidth)}${" ".repeat(safeGap)}${fitVisible(second[index] ?? "", secondWidth)}${" ".repeat(safeGap)}${fitVisible(third[index] ?? "", thirdWidth)}`,
  )
}

export function renderMetricRibbon(input: {
  metrics: { label: string; value: string; color: ChartColor; detail?: string }[]
  color?: ColorMode
  width?: number
}) {
  const ctx = renderContext(input.color)
  return fitVisible(input.metrics.map((metric) => {
    const dot = paint("●", metric.color, ctx)
    const label = paint(metric.label, "subtitle", ctx)
    const value = paint(metric.value, "white", ctx, true)
    const detail = metric.detail ? paint(` ${metric.detail}`, "muted", ctx) : ""
    return `${dot} ${label} ${value}${detail}`
  }).join("  "), input.width ?? statsContentWidth())
}

export function renderTabs(input: { tabs: { label: string; active?: boolean }[]; color?: ColorMode; width?: number }) {
  const ctx = renderContext(input.color)
  return fitVisible(input.tabs
    .map((tab) => paint(tab.active ? ` ${tab.label} ` : ` ${tab.label} `, tab.active ? "yellow" : "muted", ctx, Boolean(tab.active)))
    .join(paint(" · ", "grid", ctx)), input.width ?? statsContentWidth())
}

export function renderNarrative(input: { title: string; lines: string[]; color?: ColorMode }) {
  const ctx = renderContext(input.color)
  return [paint(input.title, "title", ctx, true), ...input.lines.map((line) => `${paint("│", "grid", ctx)} ${paint(line, "subtitle", ctx)}`)]
}

export function renderSlopeChart(input: {
  title: string
  rows: { label: string; start: number; end: number; color?: ChartColor }[]
  color?: ColorMode
  width?: number
  formatter?: (value: number) => string
}) {
  const ctx = renderContext(input.color)
  const width = input.width ?? 42
  const values = input.rows.flatMap((row) => [row.start, row.end])
  const max = niceMax(Math.max(...values, 1))
  const rows = input.rows.map((row, index) => {
    const start = Math.round((row.start / max) * (width - 1))
    const end = Math.round((row.end / max) * (width - 1))
    const line = range(width).map((x) => {
      if (x === start && x === end) return "●"
      if (x === start) return "●"
      if (x === end) return "●"
      if (x > Math.min(start, end) && x < Math.max(start, end)) return start < end ? "╱" : "╲"
      return " "
    }).join("")
    const color = row.color ?? chartColors[index % chartColors.length]
    return `${padEndVisible(paint(truncateVisible(row.label, 22), "white", ctx, true), 24)} ${paint(line, color, ctx)} ${paint(`${input.formatter?.(row.start) ?? formatNumber(row.start)} → ${input.formatter?.(row.end) ?? formatNumber(row.end)}`, "muted", ctx)}`
  })
  return [paint(input.title, "title", ctx, true), ...rows]
}

export function renderPercentStack(input: {
  title: string
  rows: { label: string; parts: { label: string; value: number; color: ChartColor }[] }[]
  color?: ColorMode
  width?: number
}) {
  const ctx = renderContext(input.color)
  const width = input.width ?? 48
  // Reserve space for label(20) + space(1) + total(~8) + space(1) = 30; bar gets the rest
  const barWidth = Math.max(4, width - 30)
  const rows = input.rows.map((row) => {
    const total = row.parts.reduce((acc, part) => acc + part.value, 0)
    const pieces = row.parts.map((part) => {
      const size = total <= 0 ? 0 : Math.max(0, Math.round((part.value / total) * barWidth))
      return paint("█".repeat(size), part.color, ctx)
    })
    return `${padEndVisible(paint(truncateVisible(row.label, 18), "white", ctx, true), 20)} ${padEndVisible(pieces.join(""), barWidth)} ${paint(formatNumber(total), "muted", ctx)}`
  })
  // Legend showing each part
  const allParts = input.rows[0]?.parts ?? []
  const legendLine = allParts.map((part) => `${paint("■", part.color, ctx)} ${paint(part.label, "muted", ctx)}`).join(paint("  ", "muted", ctx))
  return [paint(input.title, "title", ctx, true), ...rows, legendLine]
}

export function renderDayLabels(points: { label: string }[], width: number, color?: ColorMode) {
  const ctx = renderContext(color)
  return paint(labelTicks(points.map((point) => point.label), width), "muted", ctx)
}

export function renderCallout(input: { title: string; body: string; color?: ColorMode; accent?: ChartColor }) {
  const ctx = renderContext(input.color)
  const accent = input.accent ?? "yellow"
  const width = Math.max(20, statsContentWidth() - 2)
  const innerWidth = Math.max(10, width - 2)
  return [
    `${paint("╭", accent, ctx)}${paint("─".repeat(width), "grid", ctx)}${paint("╮", accent, ctx)}`,
    `${paint("│", accent, ctx)} ${fitVisible(paint(input.title, "title", ctx, true), innerWidth)} ${paint("│", accent, ctx)}`,
    // Body can be a multi-line recommendation list. Split here so callers do
    // not leak raw newlines into panel rows and break fixed-width rendering.
    ...input.body.split("\n").map((line) => `${paint("│", accent, ctx)} ${fitVisible(paint(line, "subtitle", ctx), innerWidth)} ${paint("│", accent, ctx)}`),
    `${paint("╰", accent, ctx)}${paint("─".repeat(width), "grid", ctx)}${paint("╯", accent, ctx)}`,
  ]
}

export function renderComparisonTable(input: {
  title: string
  headers: string[]
  rows: string[][]
  color?: ColorMode
}) {
  const ctx = renderContext(input.color)
  const widths = input.headers.map((header, index) => Math.max(visibleLength(header), ...input.rows.map((row) => visibleLength(row[index] ?? ""))))
  const rowLine = (row: string[], color: ChartColor, bold = false) =>
    row.map((cell, index) => padEndVisible(paint(cell, color, ctx, bold), widths[index])).join(paint(" │ ", "grid", ctx))
  return [
    paint(input.title, "title", ctx, true),
    rowLine(input.headers, "subtitle", true),
    paint(widths.map((width) => "─".repeat(width)).join("─┼─"), "grid", ctx),
    ...input.rows.map((row) => rowLine(row, "white")),
  ]
}

export function renderEmptyState(title: string, body: string, color?: ColorMode) {
  const ctx = renderContext(color)
  return [paint(title, "title", ctx, true), paint(body, "muted", ctx)]
}
