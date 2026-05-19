import { formatNumber } from "../format"
import type { TokenPartSeries, UsageSeries } from "./stats-data"
import type { ColorMode } from "./stats-render"

const RESET = "\x1b[0m"
const BOLD = "\x1b[1m"
const TEXT_RESET = "\x1b[22m\x1b[39m"
const ANSI_RE = /\x1b\[[0-9;]*m/g
const ANSI_PREFIX_RE = /^\x1b\[[0-9;]*m/
const DEFAULT_PANEL_WIDTH = 104
const MAX_PANEL_WIDTH = 118
const MIN_PANEL_WIDTH = 58
const PANEL_PADDING = 2

const fg = (r: number, g: number, b: number) => `\x1b[38;2;${r};${g};${b}m`
const bg = (r: number, g: number, b: number) => `\x1b[48;2;${r};${g};${b}m`

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
  | "panel"
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
  axis: fg(132, 105, 137),
  muted: fg(123, 105, 130),
  title: fg(232, 230, 234),
  subtitle: fg(170, 145, 176),
  blue: fg(74, 185, 235),
  cyan: fg(76, 215, 220),
  green: fg(82, 208, 132),
  yellow: fg(232, 196, 82),
  orange: fg(232, 145, 76),
  purple: fg(184, 116, 230),
  pink: fg(235, 118, 178),
  red: fg(238, 106, 114),
  white: fg(230, 230, 230),
  panel: bg(24, 8, 28),
  grid: fg(72, 46, 76),
}

const chartColors: ChartColor[] = ["blue", "green", "yellow", "purple", "pink", "cyan", "orange", "red"]

const axisStyle: ChartStyle = { color: "axis", priority: 20 }
const gridStyle: ChartStyle = { color: "grid", priority: 0 }
const labelStyle: ChartStyle = { color: "subtitle", priority: 10 }

const useColor = (mode: ColorMode = "auto") => {
  if (mode === "always") return true
  if (mode === "never") return false
  if (process.env.NO_COLOR) return false
  return Boolean(process.stdout.isTTY)
}

export const visibleLength = (text: string) => text.replace(ANSI_RE, "").length

export const stripAnsi = (text: string) => text.replace(ANSI_RE, "")

export const padEndVisible = (text: string, width: number) => text + " ".repeat(Math.max(0, width - visibleLength(text)))

export const padStartVisible = (text: string, width: number) =>
  " ".repeat(Math.max(0, width - visibleLength(text))) + text

export const statsPanelWidth = (width?: number) => {
  const columns = Number(process.stdout.columns)
  const terminalWidth = Number.isFinite(columns) && columns > 0 ? Math.max(20, columns - 2) : DEFAULT_PANEL_WIDTH
  const preferred = width ?? DEFAULT_PANEL_WIDTH
  return Math.max(Math.min(MIN_PANEL_WIDTH, terminalWidth), Math.min(preferred, terminalWidth, MAX_PANEL_WIDTH))
}

export const statsContentWidth = (width?: number) => Math.max(20, statsPanelWidth(width) - PANEL_PADDING * 2)

export const truncateVisible = (text: string, width: number) => {
  if (visibleLength(text) <= width) return text
  if (width <= 0) return ""
  if (width === 1) return "…"

  const parts: string[] = []
  let visible = 0
  let index = 0
  while (index < text.length && visible < width - 1) {
    const ansi = text.slice(index).match(ANSI_PREFIX_RE)?.[0]
    if (ansi) {
      parts.push(ansi)
      index += ansi.length
      continue
    }
    const char = Array.from(text.slice(index))[0]
    if (!char) break
    parts.push(char)
    visible++
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
  if (scaled <= 1) return base
  if (scaled <= 2) return 2 * base
  if (scaled <= 5) return 5 * base
  return 10 * base
}

const range = (count: number) => Array.from({ length: Math.max(0, count) }, (_, index) => index)

const evenlySpaced = (count: number, max: number) => {
  if (count <= 1) return [0]
  return range(count).map((index) => Math.round((index / (count - 1)) * max))
}

const dateLabel = (time: number) => new Date(time).toLocaleDateString(undefined, { month: "short", day: "numeric" })

const money = (value: number) => {
  if (!Number.isFinite(value)) return "$0"
  if (value >= 100) return `$${value.toFixed(0)}`
  if (value >= 10) return `$${value.toFixed(1)}`
  return `$${value.toFixed(3)}`
}

const braille = (value: number, max: number) => {
  const chars = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"]
  if (max <= 0) return chars[0]
  return chars[Math.min(chars.length - 1, Math.floor((value / max) * (chars.length - 1)))]
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

const drawOrthogonalPolyline = (canvas: ChartCanvas, points: { x: number; y: number }[], style: ChartStyle) => {
  const path = stepPath(compactPoints(points))
  if (path.length === 0) return
  if (path.length === 1) {
    canvas.put(path[0].x, path[0].y, "●", style, style.priority + 3)
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
    const x = clamp(
      Math.round((index / Math.max(1, labels.length - 1)) * (width - 1)) - Math.floor(label.length / 2),
      0,
      Math.max(0, width - label.length),
    )
    Array.from(label).forEach((char, offset) => {
      const pos = x + offset
      if (pos >= 0 && pos < line.length) line[pos] = char
    })
  }
  return line.join("")
}

const axisLabels = (max: number, height: number, formatter: (value: number) => string) =>
  range(height).map((index) => formatter(max * (1 - index / Math.max(1, height - 1))))

const withYAxis = (plotLines: string[], max: number, formatter: (value: number) => string, ctx: RenderContext) => {
  const labels = axisLabels(max, plotLines.length, formatter)
  const width = Math.max(5, ...labels.map(visibleLength))
  return plotLines.map((line, index) => `${paint(padStartVisible(labels[index], width), "muted", ctx)} ${line}`)
}

const legend = (series: { label: string; color: ChartColor }[], ctx: RenderContext) =>
  series.map((item) => `${paint("●", item.color, ctx)} ${paint(item.label, item.color, ctx)}`).join(paint(" · ", "muted", ctx))

export const metricFormatter = (metric: "tokens" | "cost") => (metric === "cost" ? money : formatNumber)

export const seriesFromUsage = (series: UsageSeries[], metric: "tokens" | "cost", limit: number): ChartSeries[] =>
  series.slice(0, limit).map((item, index) => ({
    id: item.id,
    label: item.label,
    color: chartColors[index % chartColors.length],
    total: metric === "cost" ? item.cost : item.tokens.total,
    points: item.points.map((point) => ({
      x: point.day,
      y: metric === "cost" ? point.cost : point.tokens.total,
      label: point.label,
      value: metric === "cost" ? point.cost : point.tokens.total,
    })),
  }))

export const layersFromTokenParts = (parts: TokenPartSeries[]): ChartLayer[] =>
  parts.map((part, index) => ({
    id: part.id,
    label: part.label,
    color: chartColors[index % chartColors.length],
    values: part.points.map((point) => point.value),
    total: part.total,
  }))

export const dailySeries = (points: { day: number; label: string; value: number }[], color: ChartColor, label: string): ChartSeries => ({
  id: label,
  label,
  color,
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
}) {
  const ctx = renderContext(input.color)
  const width = input.width ?? 64
  const height = input.height ?? 12
  const formatter = metricFormatter(input.metric ?? "tokens")
  const nonEmpty = input.series.filter((item) => item.points.length > 0)
  if (nonEmpty.length === 0) return [paint(input.title, "title", ctx, true), paint("No line data for this range.", "muted", ctx)]
  const bounds = boundsForSeries(nonEmpty)
  const plotLeft = width > 1 ? 1 : 0
  const plotWidth = Math.max(1, width - plotLeft)
  const plotHeight = Math.max(1, height - 1)
  const canvas = new ChartCanvas(width, height)
  canvas.grid(5, 4)
  canvas.vertical(0, 0, height - 1, "│", axisStyle)
  canvas.horizontal(0, width - 1, height - 1, "─", axisStyle)
  canvas.put(0, height - 1, "╰", axisStyle)
  nonEmpty.forEach((item, index) => {
    const style: ChartStyle = { color: item.color, priority: 30 + index }
    const mapped = item.points.map((point) => ({ x: plotLeft + xMap(point.x, bounds, plotWidth), y: yMap(point.y, bounds, plotHeight) }))
    drawOrthogonalPolyline(canvas, mapped, style)
  })
  const labels = nonEmpty[0]?.points.map((point) => point.label ?? dateLabel(point.x)) ?? []
  return [
    paint(input.title, "title", ctx, true),
    ...withYAxis(canvas.render(ctx), bounds.maxY, formatter, ctx),
    `${" ".repeat(7)}${paint(labelTicks(labels, width), "muted", ctx)}`,
    legend(nonEmpty, ctx),
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
}) {
  const ctx = renderContext(input.color)
  const width = input.width ?? 64
  const height = input.height ?? 12
  const layers = input.layers.filter((layer) => layer.values.some((value) => value > 0))
  if (layers.length === 0) return [paint(input.title, "title", ctx, true), paint("No stacked data for this range.", "muted", ctx)]
  const maxLength = Math.max(...layers.map((layer) => layer.values.length), 0)
  const columns = range(width).map((index) => {
    const sourceIndex = maxLength <= 1 ? 0 : Math.round((index / Math.max(1, width - 1)) * (maxLength - 1))
    return layers.map((layer) => layer.values[sourceIndex] ?? 0)
  })
  const maxTotal = niceMax(Math.max(...columns.map((column) => column.reduce((acc, value) => acc + value, 0)), 1))
  const canvas = new ChartCanvas(width, height)
  columns.forEach((column, x) => {
    let base = 0
    column.forEach((value, layerIndex) => {
      const top = base + value
      const y1 = yMap(base, { minX: 0, maxX: width - 1, minY: 0, maxY: maxTotal }, height)
      const y2 = yMap(top, { minX: 0, maxX: width - 1, minY: 0, maxY: maxTotal }, height)
      for (const y of range(Math.abs(y1 - y2) + 1).map((offset) => Math.min(y1, y2) + offset)) {
        canvas.put(x, y, "█", { color: layers[layerIndex].color, priority: 10 + layerIndex })
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
    legend(layers, ctx),
  ]
}

export function renderStreamStackChart(input: {
  title: string
  layers: ChartLayer[]
  labels?: string[]
  width?: number
  height?: number
  color?: ColorMode
}) {
  const ctx = renderContext(input.color)
  const width = input.width ?? 64
  const height = input.height ?? 13
  const layers = input.layers.filter((layer) => layer.values.some((value) => value > 0))
  if (layers.length === 0) return [paint(input.title, "title", ctx, true), paint("No stream data for this range.", "muted", ctx)]
  const maxLength = Math.max(...layers.map((layer) => layer.values.length), 0)
  const columns = range(width).map((index) => {
    const sourceIndex = maxLength <= 1 ? 0 : Math.round((index / Math.max(1, width - 1)) * (maxLength - 1))
    return layers.map((layer) => layer.values[sourceIndex] ?? 0)
  })
  const maxTotal = niceMax(Math.max(...columns.map((column) => column.reduce((acc, value) => acc + value, 0)), 1))
  const center = Math.floor(height / 2)
  const canvas = new ChartCanvas(width, height)
  columns.forEach((column, x) => {
    const total = column.reduce((acc, value) => acc + value, 0)
    let cursor = center - Math.round((total / maxTotal) * center)
    column.forEach((value, layerIndex) => {
      const size = value <= 0 ? 0 : Math.max(1, Math.round((value / maxTotal) * (height - 1)))
      for (const y of range(size).map((offset) => clamp(cursor + offset, 0, height - 1))) {
        canvas.put(x, y, "█", { color: layers[layerIndex].color, priority: 10 + layerIndex })
      }
      cursor += size
    })
  })
  canvas.horizontal(0, width - 1, center, "─", gridStyle)
  const labels = input.labels ?? range(maxLength).map(String)
  return [
    paint(input.title, "title", ctx, true),
    ...canvas.render(ctx),
    paint(labelTicks(labels, width), "muted", ctx),
    legend(layers, ctx),
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
  const maxWeeks = Math.max(1, width - 4)
  const points = input.points.slice(-maxWeeks * 7)
  if (points.length === 0) return [paint(input.title, "title", ctx, true), paint(input.emptyLabel ?? "No heatmap data.", "muted", ctx)]
  const max = safeMax(points.map((point) => point.value))
  const levels = [" ", "░", "▒", "▓", "█"]
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
  formatter?: (value: number) => string
}) {
  const ctx = renderContext(input.color)
  const width = input.width ?? 46
  const rows = input.rows.filter((row) => row.value > 0)
  if (rows.length === 0) return [paint(input.title, "title", ctx, true), paint("No ranked data.", "muted", ctx)]
  const max = Math.max(...rows.map((row) => row.value), 1)
  const formatter = input.formatter ?? formatNumber
  return [
    paint(input.title, "title", ctx, true),
    ...rows.map((row, index) => {
      const color = row.color ?? chartColors[index % chartColors.length]
      const size = Math.max(1, Math.round((row.value / max) * width))
      return `${paint(String(index + 1).padStart(2), "muted", ctx)} ${padEndVisible(paint(row.label.slice(0, 28), "white", ctx, true), 30)} ${paint("█".repeat(size), color, ctx)}${paint("░".repeat(width - size), "grid", ctx)} ${paint(formatter(row.value).padStart(8), "subtitle", ctx)} ${paint(row.subvalue ?? "", "muted", ctx)}`
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
  const header = `${" ".repeat(16)}${input.xLabels.map((label) => paint(label.slice(0, 3).padStart(4), "muted", ctx)).join("")}`
  const rows = input.yLabels.map((label, y) => {
    const cells = input.xLabels.map((_, x) => {
      const value = input.values[y]?.[x] ?? 0
      const level = max <= 0 ? 0 : Math.min(shades.length - 1, Math.ceil((value / max) * (shades.length - 1)))
      return paint(shades[level].repeat(4), chartColors[level % chartColors.length], ctx)
    })
    return `${paint(label.slice(0, 14).padEnd(14), "white", ctx, true)}  ${cells.join("")}`
  })
  return [paint(input.title, "title", ctx, true), header, ...rows]
}

export function renderWaterfall(input: {
  title: string
  rows: { label: string; value: number; color?: ChartColor }[]
  color?: ColorMode
  width?: number
  formatter?: (value: number) => string
}) {
  const ctx = renderContext(input.color)
  const width = input.width ?? 56
  const formatter = input.formatter ?? formatNumber
  const max = safeMax(input.rows.map((row) => Math.abs(row.value)))
  const center = Math.floor(width / 2)
  const lines = input.rows.map((row, index) => {
    const size = max <= 0 ? 0 : Math.max(1, Math.round((Math.abs(row.value) / max) * center))
    const color = row.color ?? (row.value >= 0 ? chartColors[index % chartColors.length] : "red")
    const left = row.value < 0 ? `${" ".repeat(center - size)}${paint("█".repeat(size), color, ctx)}` : " ".repeat(center)
    const right = row.value >= 0 ? paint("█".repeat(size), color, ctx) : ""
    return `${paint(row.label.slice(0, 18).padEnd(18), "white", ctx, true)} ${left}${paint("│", "axis", ctx)}${right.padEnd(center)} ${paint(formatter(row.value), "subtitle", ctx)}`
  })
  return [paint(input.title, "title", ctx, true), ...lines]
}

export function renderHorizon(input: {
  title: string
  series: ChartSeries[]
  color?: ColorMode
  width?: number
  formatter?: (value: number) => string
}) {
  const ctx = renderContext(input.color)
  const width = input.width ?? 64
  const rows = input.series.map((series, index) => {
    const max = safeMax(series.points.map((point) => point.y))
    const values = range(width).map((slot) => {
      const source = series.points.length <= 1 ? 0 : Math.round((slot / Math.max(1, width - 1)) * (series.points.length - 1))
      return series.points[source]?.y ?? 0
    })
    const line = values.map((value) => paint(braille(value, max), series.color, ctx)).join("")
    return `${padEndVisible(paint(series.label.slice(0, 20), "white", ctx, true), 22)} ${line} ${paint(input.formatter?.(max) ?? formatNumber(max), "muted", ctx)}`
  })
  if (rows.length === 0) rows.push(paint("No horizon data.", "muted", ctx))
  return [paint(input.title, "title", ctx, true), ...rows]
}

export function renderSmallMultiples(input: {
  title: string
  series: ChartSeries[]
  color?: ColorMode
  width?: number
  formatter?: (value: number) => string
}) {
  const ctx = renderContext(input.color)
  const width = input.width ?? 24
  const rows = input.series.map((series) => {
    const max = safeMax(series.points.map((point) => point.y))
    const sampled = range(width).map((slot) => {
      const source = series.points.length <= 1 ? 0 : Math.round((slot / Math.max(1, width - 1)) * (series.points.length - 1))
      return series.points[source]?.y ?? 0
    })
    return `${padEndVisible(paint(series.label.slice(0, 22), "white", ctx, true), 24)} ${sampled.map((value) => paint(braille(value, max), series.color, ctx)).join("")} ${paint(input.formatter?.(max) ?? formatNumber(max), "muted", ctx)}`
  })
  if (rows.length === 0) rows.push(paint("No small multiple data.", "muted", ctx))
  return [paint(input.title, "title", ctx, true), ...rows]
}

export function renderCompositionDonut(input: {
  title: string
  rows: { label: string; value: number; color?: ChartColor }[]
  color?: ColorMode
  formatter?: (value: number) => string
}) {
  const ctx = renderContext(input.color)
  const rows = input.rows.filter((row) => row.value > 0)
  const total = rows.reduce((acc, row) => acc + row.value, 0)
  if (total <= 0) return [paint(input.title, "title", ctx, true), paint("No composition data.", "muted", ctx)]
  const ring = "◜████◝\n██  ██\n██  ██\n◟████◞".split("\n").map((line, index) => paint(line, chartColors[index % chartColors.length], ctx))
  const legendRows = rows.slice(0, 6).map((row, index) => {
    const color = row.color ?? chartColors[index % chartColors.length]
    const share = ((row.value / total) * 100).toFixed(1)
    return `${paint("●", color, ctx)} ${padEndVisible(paint(row.label.slice(0, 24), "white", ctx, true), 26)} ${paint(`${share}%`.padStart(7), "subtitle", ctx)} ${paint(input.formatter?.(row.value) ?? formatNumber(row.value), "muted", ctx)}`
  })
  const height = Math.max(ring.length, legendRows.length)
  return [
    paint(input.title, "title", ctx, true),
    ...range(height).map((index) => `${padEndVisible(ring[index] ?? "", 10)} ${legendRows[index] ?? ""}`),
  ]
}

export function renderPanel(input: { title?: string; lines: string[]; color?: ColorMode; width?: number }) {
  const ctx = renderContext(input.color)
  const content = input.title ? [paint(input.title, "title", ctx, true), ...input.lines] : input.lines
  const width = statsPanelWidth(input.width)
  const innerWidth = statsContentWidth(width)
  const lines = content.map((line) => `${" ".repeat(PANEL_PADDING)}${fitVisible(line, innerWidth)}${" ".repeat(PANEL_PADDING)}`)
  if (!ctx.color) return lines.join("\n")
  return lines.map((line) => `${palette.panel}${line}${RESET}`).join("\n")
}

export function renderTwoColumn(left: string[], right: string[], gap = 4, width = statsContentWidth()) {
  const safeGap = Math.max(1, Math.min(gap, 8))
  const leftWidth = Math.max(1, Math.floor((width - safeGap) / 2))
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

export function renderGauge(input: {
  label: string
  value: number
  max: number
  color?: ColorMode
  width?: number
  formatter?: (value: number) => string
}) {
  const ctx = renderContext(input.color)
  const width = input.width ?? 32
  const ratio = input.max <= 0 ? 0 : clamp(input.value / input.max, 0, 1)
  const filled = Math.round(ratio * width)
  const bar = `${paint("█".repeat(filled), "green", ctx)}${paint("░".repeat(width - filled), "grid", ctx)}`
  return `${paint(input.label, "white", ctx, true)} ${bar} ${paint(input.formatter?.(input.value) ?? formatNumber(input.value), "subtitle", ctx)}`
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
    return `${padEndVisible(paint(row.label.slice(0, 22), "white", ctx, true), 24)} ${paint(line, color, ctx)} ${paint(`${input.formatter?.(row.start) ?? formatNumber(row.start)} → ${input.formatter?.(row.end) ?? formatNumber(row.end)}`, "muted", ctx)}`
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
  const rows = input.rows.map((row) => {
    const total = row.parts.reduce((acc, part) => acc + part.value, 0)
    const pieces = row.parts.map((part) => {
      const size = total <= 0 ? 0 : Math.round((part.value / total) * width)
      return paint("█".repeat(size), part.color, ctx)
    })
    return `${padEndVisible(paint(row.label.slice(0, 18), "white", ctx, true), 20)} ${pieces.join("").padEnd(width)} ${paint(formatNumber(total), "muted", ctx)}`
  })
  return [paint(input.title, "title", ctx, true), ...rows]
}

export function renderDayLabels(points: { label: string }[], width: number, color?: ColorMode) {
  const ctx = renderContext(color)
  return paint(labelTicks(points.map((point) => point.label), width), "muted", ctx)
}

export function renderCallout(input: { title: string; body: string; color?: ColorMode; accent?: ChartColor }) {
  const ctx = renderContext(input.color)
  const accent = input.accent ?? "yellow"
  const width = Math.min(72, statsContentWidth() - 2)
  const innerWidth = Math.max(10, width - 2)
  return [
    `${paint("╭", accent, ctx)}${paint("─".repeat(width), "grid", ctx)}${paint("╮", accent, ctx)}`,
    `${paint("│", accent, ctx)} ${fitVisible(paint(input.title, "title", ctx, true), innerWidth)} ${paint("│", accent, ctx)}`,
    `${paint("│", accent, ctx)} ${fitVisible(paint(input.body, "subtitle", ctx), innerWidth)} ${paint("│", accent, ctx)}`,
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
