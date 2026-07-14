import { Effect, Schema } from "effect"
import * as path from "path"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import * as Log from "@opencode-ai/core/util/log"
import * as Bom from "../util/bom"
import { convertToLineEnding, detectLineEnding, splitLines } from "@/util/line-ending"
import { closestWindow, lineOffset, locateExact, nextLineOffset } from "./match"

const log = Log.create({ service: "patch" })

export const PatchSchema = Schema.Struct({
  patchText: Schema.String.annotate({ description: "The full patch text that describes all changes to be made" }),
})

export type PatchParams = Schema.Schema.Type<typeof PatchSchema>

// Core types matching the Rust implementation
export interface ApplyPatchArgs {
  patch: string
  hunks: Hunk[]
  workdir?: string
}

export type Hunk =
  | { type: "add"; path: string; contents: string }
  | { type: "delete"; path: string }
  | { type: "update"; path: string; move_path?: string; chunks: UpdateFileChunk[] }

export interface UpdateFileChunk {
  old_lines: string[]
  new_lines: string[]
  change_context?: string
  is_end_of_file?: boolean
}

export interface ApplyPatchAction {
  changes: Map<string, ApplyPatchFileChange>
  patch: string
  cwd: string
}

export type ApplyPatchFileChange =
  | { type: "add"; content: string }
  | { type: "delete"; content: string }
  | { type: "update"; unified_diff: string; move_path?: string; new_content: string }

export interface AffectedPaths {
  added: string[]
  modified: string[]
  deleted: string[]
}

export enum ApplyPatchError {
  ParseError = "ParseError",
  IoError = "IoError",
  ComputeReplacements = "ComputeReplacements",
  ImplicitInvocation = "ImplicitInvocation",
}

export enum MaybeApplyPatch {
  Body = "Body",
  ShellParseError = "ShellParseError",
  PatchParseError = "PatchParseError",
  NotApplyPatch = "NotApplyPatch",
}

export enum MaybeApplyPatchVerified {
  Body = "Body",
  ShellParseError = "ShellParseError",
  CorrectnessError = "CorrectnessError",
  NotApplyPatch = "NotApplyPatch",
}

// Parser implementation
function parsePatchHeader(
  lines: string[],
  startIdx: number,
): { filePath: string; movePath?: string; nextIdx: number } | null {
  const line = lines[startIdx]

  if (line.startsWith("*** Add File:")) {
    const filePath = line.slice("*** Add File:".length).trim()
    return filePath ? { filePath, nextIdx: startIdx + 1 } : null
  }

  if (line.startsWith("*** Delete File:")) {
    const filePath = line.slice("*** Delete File:".length).trim()
    return filePath ? { filePath, nextIdx: startIdx + 1 } : null
  }

  if (line.startsWith("*** Update File:")) {
    const filePath = line.slice("*** Update File:".length).trim()
    let movePath: string | undefined
    let nextIdx = startIdx + 1

    // Check for move directive
    if (nextIdx < lines.length && lines[nextIdx].startsWith("*** Move to:")) {
      movePath = lines[nextIdx].slice("*** Move to:".length).trim()
      nextIdx++
    }

    return filePath ? { filePath, movePath, nextIdx } : null
  }

  return null
}

function parseUpdateFileChunks(lines: string[], startIdx: number): { chunks: UpdateFileChunk[]; nextIdx: number } {
  const chunks: UpdateFileChunk[] = []
  let i = startIdx

  while (i < lines.length && !lines[i].startsWith("***")) {
    if (lines[i].startsWith("@@")) {
      // Parse context line
      const contextLine = lines[i].substring(2).trim()
      i++

      const oldLines: string[] = []
      const newLines: string[] = []
      let isEndOfFile = false

      // Parse change lines
      while (i < lines.length && !lines[i].startsWith("@@") && !lines[i].startsWith("***")) {
        const changeLine = lines[i]

        if (changeLine === "*** End of File") {
          isEndOfFile = true
          i++
          break
        }

        if (changeLine.startsWith(" ")) {
          // Keep line - appears in both old and new
          const content = changeLine.substring(1)
          oldLines.push(content)
          newLines.push(content)
        } else if (changeLine.startsWith("-")) {
          // Remove line - only in old
          oldLines.push(changeLine.substring(1))
        } else if (changeLine.startsWith("+")) {
          // Add line - only in new
          newLines.push(changeLine.substring(1))
        }

        i++
      }

      chunks.push({
        old_lines: oldLines,
        new_lines: newLines,
        change_context: contextLine || undefined,
        is_end_of_file: isEndOfFile || undefined,
      })
    } else {
      i++
    }
  }

  return { chunks, nextIdx: i }
}

function parseAddFileContent(lines: string[], startIdx: number): { content: string; nextIdx: number } {
  let content = ""
  let i = startIdx

  while (i < lines.length && !lines[i].startsWith("***")) {
    if (lines[i].startsWith("+")) {
      content += lines[i].substring(1) + "\n"
    }
    i++
  }

  // Remove trailing newline
  if (content.endsWith("\n")) {
    content = content.slice(0, -1)
  }

  return { content, nextIdx: i }
}

function stripHeredoc(input: string): string {
  // Match heredoc patterns like: cat <<'EOF'\n...\nEOF or <<EOF\n...\nEOF
  const heredocMatch = input.match(/^(?:cat\s+)?<<['"]?(\w+)['"]?\s*\n([\s\S]*?)\n\1\s*$/)
  if (heredocMatch) {
    return heredocMatch[2]
  }
  return input
}

export function parsePatch(patchText: string): { hunks: Hunk[] } {
  const cleaned = stripHeredoc(patchText.trim())
  const lines = splitLines(cleaned)
  const hunks: Hunk[] = []
  let i = 0

  // Look for Begin/End patch markers
  const beginMarker = "*** Begin Patch"
  const endMarker = "*** End Patch"

  const beginIdx = lines.findIndex((line) => line.trim() === beginMarker)
  const endIdx = lines.findIndex((line) => line.trim() === endMarker)

  if (beginIdx === -1 || endIdx === -1 || beginIdx >= endIdx) {
    throw new Error("Invalid patch format: missing Begin/End markers")
  }

  // Parse content between markers
  i = beginIdx + 1

  while (i < endIdx) {
    const header = parsePatchHeader(lines, i)
    if (!header) {
      i++
      continue
    }

    if (lines[i].startsWith("*** Add File:")) {
      const { content, nextIdx } = parseAddFileContent(lines, header.nextIdx)
      hunks.push({
        type: "add",
        path: header.filePath,
        contents: content,
      })
      i = nextIdx
    } else if (lines[i].startsWith("*** Delete File:")) {
      hunks.push({
        type: "delete",
        path: header.filePath,
      })
      i = header.nextIdx
    } else if (lines[i].startsWith("*** Update File:")) {
      const { chunks, nextIdx } = parseUpdateFileChunks(lines, header.nextIdx)
      hunks.push({
        type: "update",
        path: header.filePath,
        move_path: header.movePath,
        chunks,
      })
      i = nextIdx
    } else {
      i++
    }
  }

  return { hunks }
}

// Apply patch functionality
export function maybeParseApplyPatch(
  argv: string[],
):
  | { type: MaybeApplyPatch.Body; args: ApplyPatchArgs }
  | { type: MaybeApplyPatch.PatchParseError; error: Error }
  | { type: MaybeApplyPatch.NotApplyPatch } {
  const APPLY_PATCH_COMMANDS = ["apply_patch", "applypatch"]

  // Direct invocation: apply_patch <patch>
  if (argv.length === 2 && APPLY_PATCH_COMMANDS.includes(argv[0])) {
    try {
      const { hunks } = parsePatch(argv[1])
      return {
        type: MaybeApplyPatch.Body,
        args: {
          patch: argv[1],
          hunks,
        },
      }
    } catch (error) {
      return {
        type: MaybeApplyPatch.PatchParseError,
        error: error as Error,
      }
    }
  }

  // Bash heredoc form: bash -lc 'apply_patch <<"EOF" ...'
  if (argv.length === 3 && argv[0] === "bash" && argv[1] === "-lc") {
    // Simple extraction - in real implementation would need proper bash parsing
    const script = argv[2]
    const heredocMatch = script.match(/apply_patch\s*<<['"](\w+)['"]\s*\n([\s\S]*?)\n\1/)

    if (heredocMatch) {
      const patchContent = heredocMatch[2]
      try {
        const { hunks } = parsePatch(patchContent)
        return {
          type: MaybeApplyPatch.Body,
          args: {
            patch: patchContent,
            hunks,
          },
        }
      } catch (error) {
        return {
          type: MaybeApplyPatch.PatchParseError,
          error: error as Error,
        }
      }
    }
  }

  return { type: MaybeApplyPatch.NotApplyPatch }
}

// File content manipulation
interface ApplyPatchFileUpdate {
  unified_diff: string
  content: string
  bom: boolean
}

export function deriveNewContentsFromChunks(
  filePath: string,
  chunks: UpdateFileChunk[],
  originalText: string,
): ApplyPatchFileUpdate {
  const originalContent = Bom.split(originalText)

  let originalLines = splitLines(originalContent.text)

  // 这里只移除真实文件终止符；chunk 中显式的 trailing empty old line 仍属于完整字面模式。
  if (originalLines.length > 0 && originalLines[originalLines.length - 1] === "") {
    originalLines.pop()
  }

  const newLines = applyChunks(originalLines, filePath, chunks, originalContent.text)

  // Patch matching works on logical lines; preserve the file's original line ending when writing back.
  // 既有 update contract 始终补一个终止换行；substring recovery 不能改变这个写回约定。
  const normalized = newLines.length === 0 ? "" : newLines.join("\n") + "\n"
  const next = Bom.split(convertToLineEnding(normalized, detectLineEnding(originalContent.text)))
  const newContent = next.text

  // Generate unified diff
  const unifiedDiff = generateUnifiedDiff(originalContent.text, newContent)

  return {
    unified_diff: unifiedDiff,
    content: newContent,
    bom: originalContent.bom || next.bom,
  }
}

function applyChunks(originalLines: string[], filePath: string, chunks: UpdateFileChunk[], persistedText: string) {
  // 所有变换只发生在局部 working copy；任一后续失败都会丢弃它，保持单文件原子性。
  let lines = [...originalLines]
  // terminal flag 只记录真实文件终止符，不能与最后一个空逻辑行合并成同一数组元素。
  let terminated = persistedText.endsWith("\n") || persistedText.endsWith("\r")
  let cursorOffset = 0
  const insertions: string[][] = []

  for (const chunk of chunks) {
    // 每个 chunk 都先验证 context；pure insertion 只跳过 old block，不能跳过公开的 @@ 约束。
    if (chunk.change_context) {
      const context = locateExact(lines, [chunk.change_context], cursorOffset, false, terminated)
      if (context.type !== "found") {
        // context 的零匹配与多匹配都不能继续，否则同一公开 @@ 字段会出现两套成功语义。
        throw new Error(withCandidate(`Failed to find context '${chunk.change_context}' in ${filePath}`, persistedText, chunk.change_context))
      }
      const text = workingText(lines, terminated)
      // 两种 location 都转换为包含行起点，再统一消费整行，避免 substring context 只前进到命中末尾。
      const contextOffset = context.location.kind === "line"
        ? lineOffset(lines, context.location.startLine)
        : context.location.startOffset
      cursorOffset = nextLineOffset(text, contextOffset)
    }

    // 插入文本延后到所有匹配成功后统一追加，既不暴露给后续搜索，也能与删除全部原文自然组合。
    if (chunk.old_lines.length === 0) {
      insertions.push(chunk.new_lines)
      continue
    }

    const result = locateExact(lines, chunk.old_lines, cursorOffset, chunk.is_end_of_file, terminated)
    if (result.type === "ambiguous") {
      throw new Error(
        `Found multiple matches for expected lines in ${filePath}:\n${chunk.old_lines.join("\n")}\nProvide more context to make the match unique.`,
      )
    }
    if (result.type === "not-found") {
      const expected = chunk.old_lines.join("\n")
      throw new Error(withCandidate(`Failed to find expected lines in ${filePath}:\n${expected}`, persistedText, expected))
    }

    if (result.location.kind === "line") {
      // exact-line 保留 line splice，避免 generic content span 把整行删除退化为空行。
      const startLine = result.location.startLine
      lines.splice(startLine, result.location.endLine - startLine, ...chunk.new_lines)
      if (lines.length === 0) terminated = false
      // 纯删除停在存活边界；有 replacement 时越过全部新逻辑行，连零长度行也不能被后续重匹配。
      const nextLine = startLine + chunk.new_lines.length
      // EOF replacement 没有后继行起点，使用 text.length + 1 明确表示所有生成行均已消费。
      cursorOffset = chunk.new_lines.length === 0
        ? lineOffset(lines, startLine)
        : nextLine < lines.length
          ? lineOffset(lines, nextLine)
          : workingText(lines, terminated).length + 1
      continue
    }

    const text = workingText(lines, terminated)
    const replacement = chunk.new_lines.join("\n")
    // slice 只替换 exact literal range，首行前缀和末行后缀始终由原 working text 提供。
    const next = text.slice(0, result.location.startOffset) + replacement + text.slice(result.location.endOffset)
    // 字符替换只拥有命中的字面范围；重新分行时保留内部及边界空行，不把它们当作文件终止符丢弃。
    terminated = next.endsWith("\n")
    // substring splice 后重新分离 terminal 状态，后续完整 literal 才能继续区分 `foo` 与 `foo\n`。
    lines = next === "" ? [] : next.split("\n")
    if (terminated) lines.pop()
    cursorOffset = result.location.startOffset + replacement.length
  }

  // 按 patch 顺序追加数组，让空文件、delete-all 和多 insertion 共用同一分隔符语义。
  // 最终文件尾换行仍由 deriveNewContentsFromChunks 的既有逻辑统一补齐，避免双重 owner。
  for (const insertion of insertions) lines.push(...insertion)
  return lines
}

function workingText(lines: string[], terminated: boolean) {
  // canonical lines 与 terminal 状态分离，既能区分 `foo`/`foo\n`，也不会把终止符误当空逻辑行。
  return lines.join("\n") + (terminated && lines.length > 0 ? "\n" : "")
}

function withCandidate(message: string, content: string, expected: string) {
  // 候选必须来自失败后仍在磁盘上的 immutable 输入，不能展示已丢弃 working copy 中的生成文本。
  const closest = closestWindow(content, expected)
  if (!closest) return `${message}\n\nNo reliable nearby candidate was found. Read the file and retry with exact text.`
  return `${message}\n\nClosest match at line ${closest.line}:\n${closest.excerpt}`
}

function generateUnifiedDiff(oldContent: string, newContent: string): string {
  const oldLines = splitLines(oldContent)
  const newLines = splitLines(newContent)

  // Simple diff generation - in a real implementation you'd use a proper diff algorithm
  let diff = "@@ -1 +1 @@\n"

  // Find changes (simplified approach)
  const maxLen = Math.max(oldLines.length, newLines.length)
  let hasChanges = false

  for (let i = 0; i < maxLen; i++) {
    const oldLine = oldLines[i] || ""
    const newLine = newLines[i] || ""

    if (oldLine !== newLine) {
      if (oldLine) diff += `-${oldLine}\n`
      if (newLine) diff += `+${newLine}\n`
      hasChanges = true
    } else if (oldLine) {
      diff += ` ${oldLine}\n`
    }
  }

  return hasChanges ? diff : ""
}

// Apply hunks to filesystem
export const applyHunksToFiles = Effect.fn("Patch.applyHunksToFiles")(function* (hunks: Hunk[]) {
  if (hunks.length === 0) {
    return yield* Effect.fail(new Error("No files were modified."))
  }

  const fs = yield* AppFileSystem.Service

  const added: string[] = []
  const modified: string[] = []
  const deleted: string[] = []

  for (const hunk of hunks) {
    switch (hunk.type) {
      case "add": {
        yield* fs.writeWithDirs(hunk.path, hunk.contents)
        added.push(hunk.path)
        log.info(`Added file: ${hunk.path}`)
        break
      }

      case "delete": {
        yield* fs.remove(hunk.path)
        deleted.push(hunk.path)
        log.info(`Deleted file: ${hunk.path}`)
        break
      }

      case "update": {
        const originalText = yield* fs.readFileString(hunk.path)
        const fileUpdate = deriveNewContentsFromChunks(hunk.path, hunk.chunks, originalText)

        if (hunk.move_path) {
          yield* fs.writeWithDirs(hunk.move_path, Bom.join(fileUpdate.content, fileUpdate.bom))
          yield* fs.remove(hunk.path)
          modified.push(hunk.move_path)
          log.info(`Moved file: ${hunk.path} -> ${hunk.move_path}`)
        } else {
          yield* fs.writeWithDirs(hunk.path, Bom.join(fileUpdate.content, fileUpdate.bom))
          modified.push(hunk.path)
          log.info(`Updated file: ${hunk.path}`)
        }
        break
      }
    }
  }

  return { added, modified, deleted } satisfies AffectedPaths
})

// Main patch application function
export const applyPatch = Effect.fn("Patch.applyPatch")(function* (patchText: string) {
  const { hunks } = parsePatch(patchText)
  return yield* applyHunksToFiles(hunks)
})

type MaybeApplyPatchVerifiedResult =
  | { type: MaybeApplyPatchVerified.Body; action: ApplyPatchAction }
  | { type: MaybeApplyPatchVerified.CorrectnessError; error: Error }
  | { type: MaybeApplyPatchVerified.NotApplyPatch }

// Effectful verified-parse: needs AppFileSystem.Service to read existing files
export const maybeParseApplyPatchVerified = Effect.fn("Patch.maybeParseApplyPatchVerified")(function* (
  argv: string[],
  cwd: string,
) {
  // Detect implicit patch invocation (raw patch without apply_patch command)
  if (argv.length === 1) {
    try {
      parsePatch(argv[0])
      return {
        type: MaybeApplyPatchVerified.CorrectnessError,
        error: new Error(ApplyPatchError.ImplicitInvocation),
      } satisfies MaybeApplyPatchVerifiedResult
    } catch {
      // Not a patch, continue
    }
  }

  const result = maybeParseApplyPatch(argv)

  switch (result.type) {
    case MaybeApplyPatch.Body: {
      const fs = yield* AppFileSystem.Service
      const args = result.args
      const effectiveCwd = args.workdir ? path.resolve(cwd, args.workdir) : cwd
      const changes = new Map<string, ApplyPatchFileChange>()

      for (const hunk of args.hunks) {
        const resolvedPath = path.resolve(
          effectiveCwd,
          hunk.type === "update" && hunk.move_path ? hunk.move_path : hunk.path,
        )

        switch (hunk.type) {
          case "add":
            changes.set(resolvedPath, {
              type: "add",
              content: hunk.contents,
            })
            break

          case "delete": {
            const deletePath = path.resolve(effectiveCwd, hunk.path)
            const content = yield* fs.readFileString(deletePath).pipe(Effect.catch(() => Effect.succeed(undefined)))
            if (content === undefined) {
              return {
                type: MaybeApplyPatchVerified.CorrectnessError,
                error: new Error(`Failed to read file for deletion: ${deletePath}`),
              } satisfies MaybeApplyPatchVerifiedResult
            }
            changes.set(resolvedPath, {
              type: "delete",
              content,
            })
            break
          }

          case "update": {
            const updatePath = path.resolve(effectiveCwd, hunk.path)
            const originalText = yield* fs
              .readFileString(updatePath)
              .pipe(
                Effect.catch((cause) =>
                  Effect.succeed(new Error(`Failed to read file ${updatePath}: ${cause}`, { cause })),
                ),
              )
            if (originalText instanceof Error) {
              return {
                type: MaybeApplyPatchVerified.CorrectnessError,
                error: originalText,
              } satisfies MaybeApplyPatchVerifiedResult
            }
            try {
              const fileUpdate = deriveNewContentsFromChunks(updatePath, hunk.chunks, originalText)
              changes.set(resolvedPath, {
                type: "update",
                unified_diff: fileUpdate.unified_diff,
                move_path: hunk.move_path ? path.resolve(effectiveCwd, hunk.move_path) : undefined,
                new_content: fileUpdate.content,
              })
            } catch (error) {
              return {
                type: MaybeApplyPatchVerified.CorrectnessError,
                error: error as Error,
              } satisfies MaybeApplyPatchVerifiedResult
            }
            break
          }
        }
      }

      return {
        type: MaybeApplyPatchVerified.Body,
        action: {
          changes,
          patch: args.patch,
          cwd: effectiveCwd,
        },
      } satisfies MaybeApplyPatchVerifiedResult
    }

    case MaybeApplyPatch.PatchParseError:
      return {
        type: MaybeApplyPatchVerified.CorrectnessError,
        error: result.error,
      } satisfies MaybeApplyPatchVerifiedResult

    case MaybeApplyPatch.NotApplyPatch:
      return { type: MaybeApplyPatchVerified.NotApplyPatch } satisfies MaybeApplyPatchVerifiedResult
  }
})

export * as Patch from "."
