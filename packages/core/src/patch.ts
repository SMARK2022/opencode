export * as Patch from "./patch"

import { convertToLineEnding, detectLineEnding, splitLines } from "./util/line-ending"
import { closestWindow, lineOffset, locateExact, nextLineOffset } from "./patch-match"

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

function applyChunks(originalLines: string[], path: string, chunks: ReadonlyArray<UpdateFileChunk>, persistedText: string) {
  // 后续chunk失败只丢弃局部working copy，不能提交该文件已完成的半次修改。
  let lines = [...originalLines]
  let terminated = persistedText.endsWith("\n")
  let cursorOffset = 0
  const insertions: Array<ReadonlyArray<string>> = []
  for (const chunk of chunks) {
    if (chunk.changeContext) {
      const context = locateExact(lines, [chunk.changeContext], cursorOffset, false, terminated)
      if (context.type !== "found") throw new Error(withCandidate(`Failed to find context '${chunk.changeContext}' in ${path}`, persistedText, chunk.changeContext))
      const text = workingText(lines, terminated)
      const offset = context.location.kind === "line" ? lineOffset(lines, context.location.startLine) : context.location.startOffset
      cursorOffset = nextLineOffset(text, offset)
    }
    if (chunk.oldLines.length === 0) {
      // 延迟插入不能变成后续chunk的匹配输入，但仍先验证其公开context。
      insertions.push(chunk.newLines)
      continue
    }
    const result = locateExact(lines, chunk.oldLines, cursorOffset, chunk.endOfFile, terminated)
    if (result.type === "ambiguous")
      throw new Error(`Found multiple matches for expected lines in ${path}:\n${chunk.oldLines.join("\n")}\nProvide more context to make the match unique.`)
    if (result.type === "not-found")
      throw new Error(withCandidate(`Failed to find expected lines in ${path}:\n${chunk.oldLines.join("\n")}`, persistedText, chunk.oldLines.join("\n")))
    if (result.location.kind === "line") {
      const startLine = result.location.startLine
      lines.splice(startLine, result.location.endLine - startLine, ...chunk.newLines)
      if (lines.length === 0) terminated = false
      // replacement生成的末行也已消费，不能让后续chunk回头重匹配空逻辑行。
      const nextLine = startLine + chunk.newLines.length
      cursorOffset = chunk.newLines.length === 0 ? lineOffset(lines, startLine) : nextLine < lines.length ? lineOffset(lines, nextLine) : workingText(lines, terminated).length + 1
      continue
    }
    const text = workingText(lines, terminated)
    const replacement = chunk.newLines.join("\n")
    // 只拥有完整字面命中范围，其外的首行前缀与末行后缀原样保留。
    const next = text.slice(0, result.location.startOffset) + replacement + text.slice(result.location.endOffset)
    terminated = next.endsWith("\n")
    lines = next === "" ? [] : next.split("\n")
    if (terminated) lines.pop()
    cursorOffset = result.location.startOffset + replacement.length
  }
  for (const insertion of insertions) lines.push(...insertion)
  return lines
}

function workingText(lines: string[], terminated: boolean) {
  return lines.join("\n") + (terminated && lines.length > 0 ? "\n" : "")
}

function withCandidate(message: string, content: string, expected: string) {
  // 用失败chunk和未提交的磁盘原文诊断，不混入其他chunk或working copy。
  const closest = closestWindow(content, expected)
  return closest ? `${message}\n\nClosest match at line ${closest.line}:\n${closest.excerpt}` : `${message}\n\nNo reliable nearby candidate was found. Read the file and retry with exact text.`
}
const splitBom = (text: string) =>
  text.startsWith("\uFEFF") ? { bom: true, text: text.slice(1) } : { bom: false, text }
const stripHeredoc = (input: string) =>
  input.match(/^(?:cat\s+)?<<['"]?(\w+)['"]?\s*\n([\s\S]*?)\n\1\s*$/)?.[2] ?? input
