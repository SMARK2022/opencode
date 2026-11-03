import { RGBA, type OptimizedBuffer, type ScrollBoxRenderable, type SliderRenderable } from "@opentui/core"

// #109：thumb 亚像素：每终端行 8 格
const THUMB_PRECISION = 8
// #109：marker 半行精度
const MARKER_PRECISION = 2
// #109：marker 向 track 背景混合
const MARKER_BLEND = 0.22
// #109：半格到满格字符表
const LOWER_BLOCKS = [" ", "▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const

export interface SmoothScrollbarMarker {
  // #109：content 坐标偏移
  offset: number
  // #109：源色，绘制前弱化
  color: RGBA
}

interface SmoothThumbRange {
  start: number
  end: number
  scrollRange: number
  virtualTrackSize: number
}

// #109：renderAfter 唯一入口
export function drawSmoothScrollbar(options: {
  buffer: OptimizedBuffer
  scrollBox: ScrollBoxRenderable
  markers?: readonly SmoothScrollbarMarker[]
}) {
  const slider = options.scrollBox.verticalScrollBar.slider
  if (slider.height <= 0 || slider.width <= 0) return

  // #109：清空原生 track，本函数成为唯一视觉源
  options.buffer.fillRect(slider.screenX, slider.screenY, slider.width, slider.height, slider.backgroundColor)

  const thumb = getSmoothThumbRange(options.scrollBox, slider)
  drawSmoothThumb(options.buffer, slider, thumb)
  drawSmoothMarkers(options.buffer, slider, thumb, options.markers ?? [])
}

// #109：scrollTop 映射虚拟 thumb 区间
function getSmoothThumbRange(scrollBox: ScrollBoxRenderable, slider: SliderRenderable): SmoothThumbRange {
  // #109：视口高度下限 1，避免除零
  const viewportSize = Math.max(1, scrollBox.viewport.height)
  // #109：内容高度不低于视口
  const contentSize = Math.max(viewportSize, scrollBox.scrollHeight)
  // #109：可滚动范围非负
  const scrollRange = Math.max(0, contentSize - viewportSize)
  // #109：虚拟 track = 行数×精度
  const virtualTrackSize = slider.height * THUMB_PRECISION

  // #109：不可滚动时 thumb 铺满
  if (scrollRange <= 0) {
    return { start: 0, end: virtualTrackSize, scrollRange, virtualTrackSize }
  }

  // #109：thumb 至少一行高，保证可见可点
  const thumbSize = Math.max(
    THUMB_PRECISION,
    Math.min(Math.round((viewportSize / contentSize) * virtualTrackSize), virtualTrackSize),
  )
  // #109：thumb 起点随 scrollTop 线性移动
  const thumbStart = Math.round((scrollBox.scrollTop / scrollRange) * (virtualTrackSize - thumbSize))

  return {
    start: Math.max(0, Math.min(thumbStart, virtualTrackSize - thumbSize)),
    end: Math.max(0, Math.min(thumbStart, virtualTrackSize - thumbSize)) + thumbSize,
    scrollRange,
    virtualTrackSize,
  }
}

// #109：按覆盖率绘制 thumb
function drawSmoothThumb(buffer: OptimizedBuffer, slider: SliderRenderable, thumb: SmoothThumbRange) {
  const startRow = Math.floor(thumb.start / THUMB_PRECISION)
  const endRow = Math.ceil(thumb.end / THUMB_PRECISION) - 1

  for (let row = Math.max(0, startRow); row <= Math.min(slider.height - 1, endRow); row++) {
    const cellStart = row * THUMB_PRECISION
    const cellEnd = cellStart + THUMB_PRECISION
    const segmentStart = Math.max(thumb.start, cellStart)
    const segmentEnd = Math.min(thumb.end, cellEnd)
    const coverage = segmentEnd - segmentStart

    if (coverage <= 0) continue

    for (let x = 0; x < slider.width; x++) {
      drawVerticalSegment(
        buffer,
        slider.screenX + x,
        slider.screenY + row,
        segmentStart - cellStart,
        coverage,
        slider.foregroundColor,
        slider.backgroundColor,
      )
    }
  }
}

// #109：绘制 user 消息 marker
function drawSmoothMarkers(
  buffer: OptimizedBuffer,
  slider: SliderRenderable,
  thumb: SmoothThumbRange,
  markers: readonly SmoothScrollbarMarker[],
) {
  if (thumb.scrollRange <= 0) return

  const rows = new Map<number, { color: RGBA; char: string }>()

  for (const marker of markers) {
    // #109：与 thumb 共用 scrollRange 映射
    const tick = Math.max(
      0,
      Math.min(
        slider.height * MARKER_PRECISION - 1,
        Math.round(
          (Math.min(marker.offset, thumb.scrollRange) / thumb.scrollRange) * (slider.height * MARKER_PRECISION - 1),
        ),
      ),
    )
    const row = Math.floor(tick / MARKER_PRECISION)

    // #109：thumb 覆盖行不画 marker
    if (rowIntersectsThumb(row, thumb)) continue
    if (rows.has(row)) continue

    const color = mutedMarkerColor(marker.color, slider.backgroundColor)
    rows.set(row, { color, char: tick % MARKER_PRECISION === 0 ? "▀" : "▄" })
  }

  for (const [row, marker] of rows) {
    buffer.setCellWithAlphaBlending(
      slider.screenX + slider.width - 1,
      slider.screenY + row,
      marker.char,
      marker.color,
      slider.backgroundColor,
    )
  }
}

// #109：marker 色向背景弱化
function mutedMarkerColor(color: RGBA, background: RGBA) {
  const [r, g, b] = color.toInts()
  const [bgR, bgG, bgB] = background.toInts()

  // Pre-blend into the track background instead of relying on RGBA alpha.
  // Some block glyph paths still look saturated after alpha blending because
  // the bright agent color remains the glyph foreground. A muted opaque color
  // gives predictable contrast across terminals and OpenTUI backends.
  return RGBA.fromInts(
    mixChannel(bgR, r, MARKER_BLEND),
    mixChannel(bgG, g, MARKER_BLEND),
    mixChannel(bgB, b, MARKER_BLEND),
  )
}

// #109：通道线性插值
function mixChannel(from: number, to: number, amount: number) {
  return Math.round(from + (to - from) * amount)
}

// #109：单 cell 上下半格
function drawVerticalSegment(
  buffer: OptimizedBuffer,
  x: number,
  y: number,
  start: number,
  coverage: number,
  fg: RGBA,
  bg: RGBA,
) {
  if (coverage >= THUMB_PRECISION) {
    buffer.setCellWithAlphaBlending(x, y, "█", fg, bg)
    return
  }

  if (start === 0) {
    // #109：贴顶：上半格语义（bg/fg 互换）
    buffer.setCellWithAlphaBlending(x, y, LOWER_BLOCKS[THUMB_PRECISION - coverage], bg, fg)
    return
  }

  if (start + coverage === THUMB_PRECISION) {
    // #109：贴底：下半格字符
    buffer.setCellWithAlphaBlending(x, y, LOWER_BLOCKS[coverage], fg, bg)
    return
  }

  // #109：落在 cell 中部时锚定最近边缘
  const anchoredCoverage = Math.max(1, Math.min(THUMB_PRECISION - 1, coverage))
  if (start < THUMB_PRECISION / 2) {
    buffer.setCellWithAlphaBlending(x, y, LOWER_BLOCKS[THUMB_PRECISION - anchoredCoverage], bg, fg)
    return
  }
  buffer.setCellWithAlphaBlending(x, y, LOWER_BLOCKS[anchoredCoverage], fg, bg)
}

// #109：marker 行是否与 thumb 重叠
function rowIntersectsThumb(row: number, thumb: SmoothThumbRange) {
  const rowStart = row * THUMB_PRECISION
  const rowEnd = rowStart + THUMB_PRECISION
  return rowStart < thumb.end && rowEnd > thumb.start
}
