import { Effect, Schema } from "effect"
import * as path from "path"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import * as Log from "@opencode-ai/core/util/log"
import * as Bom from "../util/bom"
import { convertToLineEnding, detectLineEnding, splitLines } from "@/util/line-ending"
import { closestWindow, lineOffset, locateContext, locateExact, nextLineOffset } from "./match"

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
  // 集合式编辑：全部对 immutable original 定位，成功后再按位置 reverse apply。
  // 禁止 inter-chunk forward cursor 成功门闸，否则模型乱序唯一 chunk 会被误杀。
  const terminated = persistedText.endsWith("\n") || persistedText.endsWith("\r")
  const originalText = workingText(originalLines, terminated)
  // originalText 是本 proposal 唯一坐标系；任何中间 replacement 都不会重新进入 locator。
  const insertions: string[][] = []
  const replacements: Array<{ start: number; end: number; text: string }> = []

  for (const chunk of chunks) {
    // context 只约束本 chunk 的下界，不推进全局共享 cursor。
    let searchFrom = 0
    if (chunk.change_context) {
      // searchFrom 是 chunk-local 值，后方 chunk 的 context 不会消费前方 chunk 的搜索范围。
      const context = locateContext(originalLines, [chunk.change_context], 0, terminated)
      if (context.type !== "found") {
        throw new Error(withCandidate(`Failed to find context in ${filePath}.`, persistedText, chunk.change_context))
      }
      const contextOffset =
        context.location.kind === "line"
          ? lineOffset(originalLines, context.location.startLine)
          : context.location.startOffset
      searchFrom = nextLineOffset(originalText, contextOffset)
    }

    // pure insertion 延后到所有 replacement 成功之后，避免成为后续 old 候选。
    if (chunk.old_lines.length === 0) {
      // insertion 不占 original span，因此不能参与 overlap，也不能为后续 old block 制造候选。
      insertions.push(chunk.new_lines)
      continue
    }

    const result = locateExact(originalLines, chunk.old_lines, searchFrom, chunk.is_end_of_file, terminated)
    if (result.type === "ambiguous") {
      throw new Error(
        `Found multiple matches for expected lines in ${filePath}. Provide more context to make the match unique.`,
      )
    }
    if (result.type === "not-found") {
      const expected = chunk.old_lines.join("\n")
      throw new Error(withCandidate(`Failed to find expected lines in ${filePath}.`, persistedText, expected))
    }

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

    // whole-line 与 substring 都收成 original 上的 [start,end) 字符窗，便于重叠检测与 reverse apply。
    // replacement 文本在定位期一并确定换行 ownership，apply 时不再重新解释 line kind。
    const text =
      result.location.kind === "line"
        ? formatLineReplacement(chunk.new_lines, span, originalText, terminated)
        : chunk.new_lines.join("\n")

    replacements.push({ start: span.start, end: span.end, text })
  }

  replacements.sort((left, right) => left.start - right.start)
  // 只有所有定位都成功后才排序；任何 miss 都会在产生 working copy 之前终止整个文件 proposal。
  for (let index = 1; index < replacements.length; index++) {
    const previous = replacements[index - 1]
    const current = replacements[index]
    // 同 span 或嵌套必须拒绝：两个 chunk 不能争用同一段 original。
    // 相邻半开区间不重叠，允许连续两行或同行相邻 substring 各自拥有自己的字符窗。
    if (previous.start < current.end && current.start < previous.end) {
      throw new Error(
        `Overlapping expected lines in ${filePath}. Merge the edits or target disjoint regions.`,
      )
    }
  }

  let next = originalText
  // 从后向前应用可保持所有较小 original offset 有效，不需要位置增量修正或第二套 cursor。
  for (const replacement of [...replacements].reverse()) {
    next = next.slice(0, replacement.start) + replacement.text + next.slice(replacement.end)
  }

  const nextTerminated = next.endsWith("\n")
  let lines = next === "" ? [] : next.split("\n")
  if (nextTerminated) lines.pop()

  // 按 patch 顺序追加 pure insertion，与 delete-all + insert 组合共享 EOF 语义。
  for (const insertion of insertions) lines.push(...insertion)
  return lines
}

function formatLineReplacement(
  newLines: string[],
  span: { start: number; end: number },
  originalText: string,
  terminated: boolean,
) {
  // whole-line range 的 end 通常落在下一行起点（含旧行尾 LF）；空替换删除整行窗口。
  if (newLines.length === 0) return ""
  const body = newLines.join("\n")
  if (span.end < originalText.length) return `${body}\n`
  if (terminated && span.end === originalText.length && originalText.endsWith("\n")) return `${body}\n`
  return body
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

function groupUpdateHunks(hunks: Hunk[], resolvePath: (path: string) => string): Hunk[] {
  // 只聚合同 source 全为 update 的 proposal；mixed add/delete 维持既有操作顺序，不扩张本任务语义。
  // 第一遍先盘点 operation type，防止第二遍提前合并 update 后跨过中间 add/delete。
  const types = new Map<string, Set<Hunk["type"]>>()
  for (const hunk of hunks) {
    const key = resolvePath(hunk.path)
    const value = types.get(key) ?? new Set<Hunk["type"]>()
    value.add(hunk.type)
    types.set(key, value)
  }

  const updates = new Map<string, Extract<Hunk, { type: "update" }>>()
  return hunks.flatMap((hunk): Hunk[] => {
    if (hunk.type !== "update") return [hunk]
    const key = resolvePath(hunk.path)
    if (types.get(key)?.size !== 1) return [hunk]
    const existing = updates.get(key)
    if (!existing) {
      // clone chunks 避免 proposal grouping 改写 parser 产物，其他 consumer 仍可安全读取原 hunks。
      const grouped = { ...hunk, chunks: [...hunk.chunks] }
      updates.set(key, grouped)
      return [grouped]
    }

    if (hunk.move_path) {
      // move destination 也按 consumer 提供的 canonical resolver 比较，alias 不应制造虚假冲突。
      if (existing.move_path && resolvePath(existing.move_path) !== resolvePath(hunk.move_path)) {
        throw new Error(`Conflicting move destinations for ${hunk.path}`)
      }
      existing.move_path ??= hunk.move_path
    }
    // 只合并 parser 已确认的 chunks；定位、唯一与重叠仍由唯一 Patch owner 负责。
    existing.chunks.push(...hunk.chunks)
    return []
  })
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

  // direct apply 与 verified preview 共用此 grouping 契约，避免相同 patch 在 consumer 间分叉。
  for (const hunk of groupUpdateHunks(hunks, AppFileSystem.resolve)) {
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
      const groupedHunks = groupUpdateHunks(
        args.hunks,
        (filePath) => AppFileSystem.resolve(path.resolve(effectiveCwd, filePath)),
      )

      for (const hunk of groupedHunks) {
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
