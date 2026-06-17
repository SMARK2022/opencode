import { RGBA, type OptimizedBuffer, type ScrollBoxRenderable, type SliderRenderable } from "@opentui/core"

const THUMB_PRECISION = 8
const MARKER_PRECISION = 2
const MARKER_BLEND = 0.22
const LOWER_BLOCKS = [" ", "▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const

export interface SmoothScrollbarMarker {
  // Content-relative vertical offset for the place this marker represents.
  offset: number
  // Marker source color. The helper mutes it against the track background.
  color: RGBA
}

interface SmoothThumbRange {
  start: number
  end: number
  scrollRange: number
  virtualTrackSize: number
}

export function drawSmoothScrollbar(options: {
  buffer: OptimizedBuffer
  scrollBox: ScrollBoxRenderable
  markers?: readonly SmoothScrollbarMarker[]
}) {
  const slider = options.scrollBox.verticalScrollBar.slider
  if (slider.height <= 0 || slider.width <= 0) return

  // OpenTUI already rendered its coarse half-cell thumb before renderAfter runs.
  // Reset the track so this helper is the single source of scrollbar visuals.
  options.buffer.fillRect(slider.screenX, slider.screenY, slider.width, slider.height, slider.backgroundColor)

  const thumb = getSmoothThumbRange(options.scrollBox, slider)
  drawSmoothThumb(options.buffer, slider, thumb)
  drawSmoothMarkers(options.buffer, slider, thumb, options.markers ?? [])
}

function getSmoothThumbRange(scrollBox: ScrollBoxRenderable, slider: SliderRenderable): SmoothThumbRange {
  const viewportSize = Math.max(1, scrollBox.viewport.height)
  const contentSize = Math.max(viewportSize, scrollBox.scrollHeight)
  const scrollRange = Math.max(0, contentSize - viewportSize)
  const virtualTrackSize = slider.height * THUMB_PRECISION

  if (scrollRange <= 0) {
    return { start: 0, end: virtualTrackSize, scrollRange, virtualTrackSize }
  }

  // Keep the thumb at least one terminal row high; sub-row thumbs are too easy
  // to lose visually and make mouse hit-testing feel worse than the core thumb.
  const thumbSize = Math.max(
    THUMB_PRECISION,
    Math.min(Math.round((viewportSize / contentSize) * virtualTrackSize), virtualTrackSize),
  )
  const thumbStart = Math.round((scrollBox.scrollTop / scrollRange) * (virtualTrackSize - thumbSize))

  return {
    start: Math.max(0, Math.min(thumbStart, virtualTrackSize - thumbSize)),
    end: Math.max(0, Math.min(thumbStart, virtualTrackSize - thumbSize)) + thumbSize,
    scrollRange,
    virtualTrackSize,
  }
}

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

function drawSmoothMarkers(
  buffer: OptimizedBuffer,
  slider: SliderRenderable,
  thumb: SmoothThumbRange,
  markers: readonly SmoothScrollbarMarker[],
) {
  if (thumb.scrollRange <= 0) return

  const rows = new Map<number, { color: RGBA; char: string }>()

  for (const marker of markers) {
    // Markers represent where the user would scroll to see a message, so map
    // content offset to the same scroll range that drives the thumb.
    const tick = Math.max(0, Math.min(
      slider.height * MARKER_PRECISION - 1,
      Math.round((Math.min(marker.offset, thumb.scrollRange) / thumb.scrollRange) * (slider.height * MARKER_PRECISION - 1)),
    ))
    const row = Math.floor(tick / MARKER_PRECISION)

    // Avoid drawing markers on any row touched by the smoother thumb, including
    // its sub-cell top/bottom edges.
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

function mixChannel(from: number, to: number, amount: number) {
  return Math.round(from + (to - from) * amount)
}

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
    // The segment touches the top of this cell. Render an upper block by using
    // thumb color as the cell background and painting the lower remainder as track.
    buffer.setCellWithAlphaBlending(x, y, LOWER_BLOCKS[THUMB_PRECISION - coverage], bg, fg)
    return
  }

  if (start + coverage === THUMB_PRECISION) {
    // The segment touches the bottom of this cell, which maps directly to the
    // lower block family.
    buffer.setCellWithAlphaBlending(x, y, LOWER_BLOCKS[coverage], fg, bg)
    return
  }

  // A very small thumb can land fully inside one cell. Block glyphs cannot draw
  // an arbitrary middle slice, so choose the nearest anchored edge instead.
  const anchoredCoverage = Math.max(1, Math.min(THUMB_PRECISION - 1, coverage))
  if (start < THUMB_PRECISION / 2) {
    buffer.setCellWithAlphaBlending(x, y, LOWER_BLOCKS[THUMB_PRECISION - anchoredCoverage], bg, fg)
    return
  }
  buffer.setCellWithAlphaBlending(x, y, LOWER_BLOCKS[anchoredCoverage], fg, bg)
}

function rowIntersectsThumb(row: number, thumb: SmoothThumbRange) {
  const rowStart = row * THUMB_PRECISION
  const rowEnd = rowStart + THUMB_PRECISION
  return rowStart < thumb.end && rowEnd > thumb.start
}
