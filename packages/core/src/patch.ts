export * as Patch from "./patch"

import { convertToLineEnding, detectLineEnding, splitLines } from "./util/line-ending"
import {
  closestWindow,
  formatAmbiguityHint,
  lineOffset,
  locateContext,
  locateExact,
  nextLineOffset,
  uniqueExtensionHint,
  type AmbiguityCandidates,
} from "./patch-match"

export type Hunk =
  | { readonly type: "add"; readonly path: string; readonly contents: string }
  | { readonly type: "delete"; readonly path: string }
  | {
      readonly type: "update"
      readonly path: string
      readonly movePath?: string
      readonly chunks: ReadonlyArray<UpdateFileChunk>
    }

export interface UpdateFileChunk {
  readonly oldLines: ReadonlyArray<string>
  readonly newLines: ReadonlyArray<string>
  readonly changeContext?: string
  readonly endOfFile?: boolean
}

export interface FileUpdate {
  readonly content: string
  readonly bom: boolean
}

export function parse(patchText: string): ReadonlyArray<Hunk> {
  const lines = splitLines(stripHeredoc(patchText.trim()))
  const begin = lines.findIndex((line) => line.trim() === "*** Begin Patch")
  const end = lines.findIndex((line) => line.trim() === "*** End Patch")
  if (begin === -1 || end === -1 || begin >= end) throw new Error("Invalid patch format: missing Begin/End markers")

  const hunks: Hunk[] = []
  let index = begin + 1
  while (index < end) {
    const line = lines[index]!
    if (line.startsWith("*** Add File:")) {
      const path = line.slice("*** Add File:".length).trim()
      if (!path) throw new Error("Invalid add file path")
      const parsed = parseAdd(lines, index + 1)
      hunks.push({ type: "add", path, contents: parsed.content })
      index = parsed.next
      continue
    }
    if (line.startsWith("*** Delete File:")) {
      const path = line.slice("*** Delete File:".length).trim()
      if (!path) throw new Error("Invalid delete file path")
      hunks.push({ type: "delete", path })
      index++
      continue
    }
    if (line.startsWith("*** Update File:")) {
      const path = line.slice("*** Update File:".length).trim()
      if (!path) throw new Error("Invalid update file path")
      let next = index + 1
      let movePath: string | undefined
      if (lines[next]?.startsWith("*** Move to:")) {
        movePath = lines[next]!.slice("*** Move to:".length).trim()
        if (!movePath) throw new Error("Invalid move file path")
        next++
      }
      const parsed = parseUpdate(lines, next)
      if (parsed.chunks.length === 0) throw new Error(`Invalid update hunk for ${path}: expected at least one @@ chunk`)
      hunks.push({ type: "update", path, movePath, chunks: parsed.chunks })
      index = parsed.next
      continue
    }
    throw new Error(`Invalid patch line: ${line}`)
  }
  return hunks
}

export function derive(path: string, chunks: ReadonlyArray<UpdateFileChunk>, original: string): FileUpdate {
  const source = splitBom(original)
  // 匹配使用逻辑LF，写回仍保留原CRLF/CR及BOM；字面恢复不引入纯行尾变更。
  const lines = splitLines(source.text)
  const text = lines.join("\n")
  if (lines.at(-1) === "") lines.pop()
  const updated = applyChunks(lines, path, chunks, text)
  const normalized = updated.length === 0 ? "" : `${updated.join("\n")}\n`
  const next = splitBom(convertToLineEnding(normalized, detectLineEnding(source.text)))
  return { content: next.text, bom: source.bom || next.bom }
}

export function joinBom(text: string, bom: boolean) {
  const stripped = splitBom(text).text
  return bom ? `\uFEFF${stripped}` : stripped
}

function parseAdd(lines: ReadonlyArray<string>, start: number) {
  const content: string[] = []
  let index = start
  while (index < lines.length && !lines[index]!.startsWith("***")) {
    if (!lines[index]!.startsWith("+")) throw new Error(`Invalid add file line: ${lines[index]}`)
    content.push(lines[index]!.slice(1))
    index++
  }
  return { content: content.join("\n"), next: index }
}

function parseUpdate(lines: ReadonlyArray<string>, start: number) {
  const chunks: UpdateFileChunk[] = []
  let index = start
  while (index < lines.length && !lines[index]!.startsWith("***")) {
    if (!lines[index]!.startsWith("@@")) {
      throw new Error(`Invalid update file line: ${lines[index]}`)
    }
    const changeContext = lines[index]!.slice(2).trim() || undefined
    const oldLines: string[] = []
    const newLines: string[] = []
    let endOfFile = false
    index++
    while (index < lines.length && !lines[index]!.startsWith("@@")) {
      const line = lines[index]!
      if (line === "*** End of File") {
        endOfFile = true
        index++
        break
      }
      if (line.startsWith("***")) break
      if (line.startsWith(" ")) {
        oldLines.push(line.slice(1))
        newLines.push(line.slice(1))
      } else if (line.startsWith("-")) oldLines.push(line.slice(1))
      else if (line.startsWith("+")) newLines.push(line.slice(1))
      else throw new Error(`Invalid update chunk line: ${line}`)
      index++
    }
    chunks.push({ oldLines, newLines, changeContext, endOfFile: endOfFile || undefined })
  }
  return { chunks, next: index }
}

function applyChunks(
  originalLines: string[],
  path: string,
  chunks: ReadonlyArray<UpdateFileChunk>,
  persistedText: string,
) {
  // 两代调用方共用immutable original；定位结束前不产生可被后续chunk消费的文本。
  const terminated = persistedText.endsWith("\n")
  const originalText = workingText(originalLines, terminated)
  const insertions: Array<ReadonlyArray<string>> = []
  const replacements: Array<{ start: number; end: number; text: string }> = []
  for (const chunk of chunks) {
    let searchFrom = 0
    if (chunk.changeContext) {
      const context = locateContext(originalLines, [chunk.changeContext], 0, terminated)
      if (context.type !== "found")
        throw new Error(withCandidate(`Failed to find context in ${path}.`, persistedText, chunk.changeContext))
      const offset =
        context.location.kind === "line"
          ? lineOffset(originalLines, context.location.startLine)
          : context.location.startOffset
      searchFrom = nextLineOffset(originalText, offset)
    }
    if (chunk.oldLines.length === 0) {
      insertions.push(chunk.newLines)
      continue
    }
    const result = locateExact(originalLines, chunk.oldLines, searchFrom, chunk.endOfFile, terminated)
    if (result.type === "ambiguous")
      throw new Error(
        withAmbiguityAdvice(
          `Found multiple matches for expected lines in ${path}. Provide more context to make the match unique.`,
          originalLines,
          chunk.oldLines,
          result.candidates,
          searchFrom,
          terminated,
        ),
      )
    if (result.type === "not-found")
      throw new Error(
        withCandidate(`Failed to find expected lines in ${path}.`, persistedText, chunk.oldLines.join("\n")),
      )
    const span =
      result.location.kind === "line"
        ? {
            start: lineOffset(originalLines, result.location.startLine),
            end:
              result.location.endLine < originalLines.length
                ? lineOffset(originalLines, result.location.endLine)
                : originalText.length,
          }
        : { start: result.location.startOffset, end: result.location.endOffset }
    // 整行span包含其行尾；substring仅拥有匹配字符，不能吞掉原始前后缀。
    const text =
      result.location.kind === "line"
        ? formatLineReplacement(chunk.newLines, span, originalText, terminated)
        : chunk.newLines.join("\n")
    replacements.push({ ...span, text })
  }
  // 先排序再比较相邻半开区间；重复、嵌套和交叉均在任何应用前拒绝。
  replacements.sort((left, right) => left.start - right.start)
  for (let index = 1; index < replacements.length; index++) {
    const previous = replacements[index - 1]
    const current = replacements[index]
    if (previous.start < current.end && current.start < previous.end)
      throw new Error(`Overlapping expected lines in ${path}. Merge the edits or target disjoint regions.`)
  }
  let next = originalText
  // 倒序应用保持原坐标有效，失败诊断仍只读取persistedText。
  for (const replacement of [...replacements].reverse())
    next = next.slice(0, replacement.start) + replacement.text + next.slice(replacement.end)
  const nextTerminated = next.endsWith("\n")
  const lines = next === "" ? [] : next.split("\n")
  if (nextTerminated) lines.pop()
  // 纯插入最后按patch顺序追加，不参与定位或重叠窗口。
  for (const insertion of insertions) lines.push(...insertion)
  return lines
}
// 失败诊断只消费唯一性owner携带的候选，并用相同cursor/行尾语义核验扩展，不能另建成功matcher。
function withAmbiguityAdvice(
  message: string,
  originalLines: string[],
  oldLines: ReadonlyArray<string>,
  candidates: AmbiguityCandidates | undefined,
  cursorOffset: number,
  terminated: boolean,
) {
  if (!candidates || candidates.lines.length === 0) return message
  // old block本身是整行域输入；展示数量仍用完整枚举总数，不把封顶列表冒充全部候选。
  const hint = uniqueExtensionHint(
    originalLines,
    candidates.lines,
    oldLines.length,
    (extended) => locateExact(originalLines, extended, cursorOffset, false, terminated).type === "found",
    true,
  )
  return message + formatAmbiguityHint(hint && { ...hint, total: candidates.total })
}

function formatLineReplacement(
  newLines: ReadonlyArray<string>,
  span: { start: number; end: number },
  originalText: string,
  terminated: boolean,
) {
  if (newLines.length === 0) return ""
  const body = newLines.join("\n")
  if (span.end < originalText.length) return `${body}\n`
  if (terminated && span.end === originalText.length && originalText.endsWith("\n")) return `${body}\n`
  return body
}

function workingText(lines: string[], terminated: boolean) {
  return lines.join("\n") + (terminated && lines.length > 0 ? "\n" : "")
}

function withCandidate(message: string, content: string, expected: string) {
  // 用失败chunk和未提交的磁盘原文诊断，不混入其他chunk或working copy。
  const closest = closestWindow(content, expected)
  return closest
    ? `${message}\n\nClosest match at line ${closest.line}:\n${closest.excerpt}`
    : `${message}\n\nNo reliable nearby candidate was found. Read the file and retry with exact text.`
}
const splitBom = (text: string) =>
  text.startsWith("\uFEFF") ? { bom: true, text: text.slice(1) } : { bom: false, text }
const stripHeredoc = (input: string) =>
  input.match(/^(?:cat\s+)?<<['"]?(\w+)['"]?\s*\n([\s\S]*?)\n\1\s*$/)?.[2] ?? input
