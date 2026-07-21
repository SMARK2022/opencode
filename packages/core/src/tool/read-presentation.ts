export * as ReadPresentation from "./read-presentation"

import { Schema } from "effect"
import { FSUtil } from "../fs-util"
import { mergeRanges } from "../util/range"
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
  // 历史缺指纹仍可展示正文，但不能证明已见内容属于当前版本。
  fp: Schema.optional(Schema.String),
  start: Schema.Number,
  end: Schema.Number,
  total: Schema.Number,
  totalExact: Schema.Boolean,
  returned: Schema.Number,
  stub: Schema.Boolean,
  stubStatus: Schema.optional(Schema.Literals(["stub_same_range_visible", "stub_covered_range_visible", "stub_high_overlap_visible"])),
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

// 两代的 stub、重叠和未读指引共用此门控；同 size/mtime 的改写不能仅凭弱键命中。
function isSameFileVersion(a: ReadRangeMeta, b: ReadRangeMeta) {
  if (a.modifiedMs === undefined || a.size !== b.size || a.modifiedMs !== b.modifiedMs) return false
  if (typeof a.fp !== "string" || a.fp.length === 0) return false
  if (typeof b.fp !== "string" || b.fp.length === 0) return false
  return a.fp === b.fp
}

export function findReadStub(visibleReads: readonly ReadRangeMeta[], current: ReadRangeMeta, contentLength: number) {
  const sameVersion = visibleReads.filter((item) => item.canonicalPath === current.canonicalPath && !item.stub && isSameFileVersion(item, current))
  const sameRange = sameVersion.find((item) => item.start === current.start && item.end === current.end)
  if (sameRange) return { status: "stub_same_range_visible" as const }
  const covering = sameVersion.find((item) => item.start <= current.start && item.end >= current.end)
  // 覆盖源同时拥有 total 和精确性，子页不能以较弱下界改写导航事实。
  if (covering) return { status: "stub_covered_range_visible" as const, coveredBy: `${covering.start}-${covering.end}`, covering }
  // 只有高重叠分支比较正文字符数；完全相同或被覆盖的读取保持原stub语义。
  if (contentLength < 300) return undefined
  // 只使用同版本最佳单交集；多个重复页不能叠加出虚假的80%覆盖。
  const overlap = findOverlapNote(visibleReads, current)
  if (!overlap) return undefined
  const [start, end] = overlap.split("-").map(Number)
  if ((end - start + 1) / Math.max(1, current.end - current.start + 1) >= 0.8)
    return { status: "stub_high_overlap_visible" as const, coveredBy: overlap }
  return undefined
}

export function findOverlapNote(visibleReads: readonly ReadRangeMeta[], current: ReadRangeMeta) {
  const best = visibleReads
    .filter((item) => item.canonicalPath === current.canonicalPath && !item.stub && isSameFileVersion(item, current))
    .map((item) => ({ start: Math.max(item.start, current.start), end: Math.min(item.end, current.end) }))
    .filter((item) => item.end >= item.start)
    .sort((a, b) => (b.end - b.start) - (a.end - a.start))[0]
  if (!best) return undefined
  const lines = best.end - best.start + 1
  // 源策略要求最佳单个交集同时达到两项门限，重复历史不能叠加成虚假的重叠。
  if (lines < OVERLAP_MIN_LINES || lines / Math.max(1, current.end - current.start + 1) < OVERLAP_MIN_RATIO) return undefined
  return `${best.start}-${best.end}`
}

export function computeUnreadRanges(visibleReads: readonly ReadRangeMeta[], current: ReadRangeMeta) {
  // 联合范围仅计算指引；路径、版本与实际交付正文仍先过滤，不能改变80%触发口径。
  const covered = mergeRanges(visibleReads.filter(read => read.canonicalPath === current.canonicalPath && !read.stub && isSameFileVersion(read, current))
    .map(read => ({ start: read.start, end: read.end })))
  const unread: { start: number; end: number }[] = []
  let pos = current.start
  for (const range of covered) {
    if (range.start > pos) unread.push({ start: pos, end: Math.min(range.start - 1, current.end) })
    pos = Math.max(pos, range.end + 1)
    if (pos > current.end) break
  }
  if (pos <= current.end) unread.push({ start: pos, end: current.end })
  return unread
}

function renderContentLines(raw: readonly string[], offset: number) {
  return raw
    .map((line, i) => {
      // #145：内容行保留原文，仅结构包装字段 escape；与 edit/write 操作对象一致
      if (line.length <= MAX_LINE_LENGTH) return `${i + offset}: ${line}`
      return `${i + offset}: ${line.slice(0, MAX_LINE_LENGTH)} (line truncated to ${MAX_LINE_LENGTH} chars)`
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
    // #145：outline 条目不转义，保留源码记号
    output.push(input.outline.items.join("\n"))
    output.push("</outline>")
  }
  // 短正文仍原样交付，仅附既有范围与避免重复读取的原话。
  if (input.overlap) output.push(`<note type="overlap" ranges="${escapeXmlAttr(input.overlap)}">Lines ${input.overlap} already in context (latest version, file unchanged); avoid re-reading this range unnecessarily.</note>`)
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
  status: "stub_same_range_visible" | "stub_covered_range_visible" | "stub_high_overlap_visible"
  coveredBy?: string
  unread?: readonly { start: number; end: number }[]
}) {
  // 两代共用可见覆盖末行，续读从已交付区间之后开始，不重复灌入正文。
  const visibleEnd = input.coveredBy ? Number(input.coveredBy.split("-")[1]) : input.end
  const nextOffset = visibleEnd + 1
  // 有界扫描的 total 可能只是下界，只有确切末尾才能关闭 offset 出口。
  const reachedEof = input.totalExact && visibleEnd >= input.total
  const offsetExit = reachedEof
    ? "No unread lines remain (end of file reached); use grep to locate symbols."
    : `Use offset=${nextOffset} for unread lines, or grep to locate symbols.`
  const coverage = input.coveredBy ?? `${input.start}-${input.end}`
  // 版本与覆盖证明已由 findReadStub 核验，保留原话以消除模型的重读动机。
  const unread = input.unread ?? []
  const message =
    input.status === "stub_same_range_visible"
      ? `Lines ${input.start}-${input.end} are the latest version and already in context; do NOT re-read.\n${offsetExit}`
      : input.status === "stub_high_overlap_visible"
        ? unread.length === 0
          ? `Lines ${input.start}-${input.end} fully covered by visible reads (same version, file unchanged); no new content to read. ` +
            `Lines ${coverage} are already in context and current — avoid re-reading this range unnecessarily. ` +
            `Use the content from your previous read.`
          : `Lines ${coverage} already in context (latest version, file unchanged). ` +
            `Avoid re-reading this range unnecessarily — use the content from your previous read. ` +
            `New unread lines: ${unread.map(range => `${range.start}-${range.end}`).join(", ")}. ` +
            `Read offset=${unread[0]!.start} limit=${unread[0]!.end - unread[0]!.start + 1} for just the new content.`
        : `Lines ${input.start}-${input.end} covered by visible read ${coverage} (latest version, file unchanged); do NOT re-read.\n${offsetExit}`
  return [
    `<path>${escapeXmlText(input.path)}</path>`,
    `<type>file</type>`,
    `<file size="${input.size}" modified="${escapeXmlAttr(input.modified)}" />`,
    `<range start="${input.start}" end="${input.end}" total="${input.total}"${input.totalExact ? "" : ' total_exact="false"'} returned="0" />`,
    `<stub status="${input.status}"${input.coveredBy ? ` covered_by="${escapeXmlAttr(input.coveredBy)}"` : ""}>`,
    message,
    "</stub>",
  ].join("\n")
}
