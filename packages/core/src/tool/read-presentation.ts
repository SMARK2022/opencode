export * as ReadPresentation from "./read-presentation"

import { Schema } from "effect"
import { FSUtil } from "../fs-util"
export const OutlineOutput = Schema.Struct({ items: Schema.Array(Schema.String), truncated: Schema.Boolean })

const MAX_LINE_LENGTH = 2000
const OVERLAP_MIN_LINES = 20
const OVERLAP_MIN_RATIO = 0.3

// 两代读取共用版本与实际返回区间；没有稳定 mtime 的结果仍展示，但不能授权 stub。
export const ReadRangeMeta = Schema.Struct({
  path: Schema.String,
  canonicalPath: Schema.String,
  type: Schema.Literal("file"),
  size: Schema.Number,
  modified: Schema.String,
  modifiedMs: Schema.optional(Schema.Number),
  start: Schema.Number,
  end: Schema.Number,
  total: Schema.Number,
  totalExact: Schema.Boolean,
  returned: Schema.Number,
  stub: Schema.Boolean,
  stubStatus: Schema.optional(Schema.Literals(["stub_same_range_visible", "stub_covered_range_visible"])),
  coveredBy: Schema.optional(Schema.String),
  cut: Schema.optional(Schema.Boolean),
})
export type ReadRangeMeta = { -readonly [K in keyof typeof ReadRangeMeta.Type]: (typeof ReadRangeMeta.Type)[K] }
export const isReadRangeMeta: (input: unknown) => input is ReadRangeMeta = Schema.is(ReadRangeMeta)

export function canonicalReadPath(filepath: string) {
  return process.platform === "win32" ? FSUtil.normalizePath(filepath).toLowerCase() : filepath
}

export function escapeXmlText(input: string) {
  return input.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
}

export function escapeXmlAttr(input: string) {
  return escapeXmlText(input).replaceAll('"', "&quot;").replaceAll("'", "&apos;")
}

export function formatModified(ms: number) {
  const date = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

export function findReadStub(visibleReads: readonly ReadRangeMeta[], current: ReadRangeMeta) {
  if (current.modifiedMs === undefined) return undefined
  const sameVersion = visibleReads.filter((item) => item.canonicalPath === current.canonicalPath && !item.stub && item.modifiedMs === current.modifiedMs && item.size === current.size)
  const sameRange = sameVersion.find((item) => item.start === current.start && item.end === current.end)
  if (sameRange) return { status: "stub_same_range_visible" as const }
  const covering = sameVersion.find((item) => item.start <= current.start && item.end >= current.end)
  if (covering) return { status: "stub_covered_range_visible" as const, coveredBy: `${covering.start}-${covering.end}` }
  return undefined
}

export function findOverlapNote(visibleReads: readonly ReadRangeMeta[], current: ReadRangeMeta) {
  if (current.modifiedMs === undefined) return undefined
  const best = visibleReads
    .filter((item) => item.canonicalPath === current.canonicalPath && !item.stub && item.modifiedMs === current.modifiedMs && item.size === current.size)
    .map((item) => ({ start: Math.max(item.start, current.start), end: Math.min(item.end, current.end) }))
    .filter((item) => item.end >= item.start)
    .sort((a, b) => (b.end - b.start) - (a.end - a.start))[0]
  if (!best) return undefined
  const lines = best.end - best.start + 1
  // 源策略要求最佳单个交集同时达到两项门限，重复历史不能叠加成虚假的重叠。
  if (lines < OVERLAP_MIN_LINES || lines / Math.max(1, current.end - current.start + 1) < OVERLAP_MIN_RATIO) return undefined
  return `${best.start}-${best.end}`
}

function renderContentLines(raw: readonly string[], offset: number) {
  return raw
    .map((line, i) => {
      // #142：结构化包装字段转义；内容行 escape 防破坏 XML 结构（#145 改为原文）
      if (line.length <= MAX_LINE_LENGTH) return `${i + offset}: ${escapeXmlText(line)}`
      return `${i + offset}: ${escapeXmlText(line.slice(0, MAX_LINE_LENGTH))} (line truncated to ${MAX_LINE_LENGTH} chars)`
    })
    .join("\n")
}

export function renderReadOutput(input: {
  path: string
  size: number
  modified: string
  start: number
  end: number
  total: number
  totalExact: boolean
  returned: number
  raw: readonly string[]
  cut: boolean
  more: boolean
  outline?: typeof OutlineOutput.Type
  overlap?: string
}) {
  const output = [
    `<path>${escapeXmlText(input.path)}</path>`,
    `<type>file</type>`,
    `<file size="${input.size}" modified="${escapeXmlAttr(input.modified)}" />`,
    `<range start="${input.start}" end="${input.end}" total="${input.total}"${input.totalExact ? "" : ' total_exact="false"'} returned="${input.returned}" />`,
  ]
  // #142：outline 仅插入结构提示区
  if (input.outline?.items.length) {
    output.push(`<outline truncated="${input.outline.truncated ? "true" : "false"}">`)
    output.push(input.outline.items.map(escapeXmlText).join("\n"))
    output.push("</outline>")
  }
  if (input.overlap) output.push(`<note type="overlap" ranges="${escapeXmlAttr(input.overlap)}" />`)
  output.push("<content>", renderContentLines(input.raw, input.start), "</content>")
  if (input.cut) output.push(`<more offset="${input.end + 1}" reason="byte_limit" />`)
  else if (input.more) output.push(`<more offset="${input.end + 1}" reason="line_limit" />`)
  return output.join("\n")
}

export function renderNativeRead(output: { content: string; read: ReadRangeMeta; truncated?: unknown; outline?: unknown }, overlap?: string) {
  return renderReadOutput({
    ...output.read,
    raw: output.read.returned === 0 ? [] : output.content.split("\n"),
    cut: output.read.cut === true,
    more: output.truncated === true,
    outline: Schema.is(OutlineOutput)(output.outline) ? output.outline : undefined,
    overlap,
  })
}

export function renderReadStub(input: {
  path: string
  size: number
  modified: string
  start: number
  end: number
  total: number
  totalExact: boolean
  status: "stub_same_range_visible" | "stub_covered_range_visible"
  coveredBy?: string
}) {
  return [
    `<path>${escapeXmlText(input.path)}</path>`,
    `<type>file</type>`,
    `<file size="${input.size}" modified="${escapeXmlAttr(input.modified)}" />`,
    `<range start="${input.start}" end="${input.end}" total="${input.total}"${input.totalExact ? "" : ' total_exact="false"'} returned="0" />`,
    `<stub status="${input.status}"${input.coveredBy ? ` covered_by="${escapeXmlAttr(input.coveredBy)}"` : ""}>`,
    input.status === "stub_same_range_visible" ? "Requested range is already visible in the current context." : "Requested range is already covered by a visible read result.",
    "</stub>",
  ].join("\n")
}
