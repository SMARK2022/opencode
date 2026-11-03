import { Effect, Schema } from "effect"
import * as path from "path"
import { FSUtil } from "@opencode-ai/core/fs-util"
import * as Bom from "../util/bom"
import { splitLines } from "../util/line-ending"
// #131：patch 逻辑行匹配，写回保留原行尾
// #533：只保留legacy字段和diff适配，两代成功派生共用Core owner。
import { derive } from "@opencode-ai/core/patch"

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
  // 只翻译parser字段；原文定位、唯一性、坐标及行尾均由同一个Core引擎承担。
  const result = derive(
    filePath,
    chunks.map((chunk) => ({
      oldLines: chunk.old_lines,
      newLines: chunk.new_lines,
      changeContext: chunk.change_context,
      endOfFile: chunk.is_end_of_file,
    })),
    originalText,
  )
  // legacy仍返回独立BOM标志及既有diff格式，不把迁移变成输出协议变化。
  return {
    unified_diff: generateUnifiedDiff(Bom.split(originalText).text, result.content),
    ...result,
  }
}

function generateUnifiedDiff(oldContent: string, newContent: string): string {
  // #131：diff 行数组用逻辑行，避免 CRLF 噪声
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

// #533：只聚合同 source 全为 update 的 proposal；mixed add/delete 维持既有操作顺序，不扩张本任务语义。
// 第一遍先盘点 operation type，防止第二遍提前合并 update 后跨过中间 add/delete。
function groupUpdateHunks(hunks: Hunk[], resolvePath: (path: string) => string): Hunk[] {
  const types = new Map<string, Set<Hunk["type"]>>()
  for (const hunk of hunks) {
    const key = resolvePath(hunk.path)
    const value = types.get(key) ?? new Set<Hunk["type"]>()
    value.add(hunk.type)
    types.set(key, value)
  }

  const updates = new Map<string, Extract<Hunk, { type: "update" }>>()
  // #533：flatMap 保序返回——非 update 或 mixed-source hunk 原位通过，聚合只发生在纯 update 序列。
  return hunks.flatMap((hunk): Hunk[] => {
    if (hunk.type !== "update") return [hunk]
    const key = resolvePath(hunk.path)
    if (types.get(key)?.size !== 1) return [hunk]
    const existing = updates.get(key)
    if (!existing) {
      // #533：clone chunks 避免 proposal grouping 改写 parser 产物，其他 consumer 仍可安全读取原 hunks。
      const grouped = { ...hunk, chunks: [...hunk.chunks] }
      updates.set(key, grouped)
      return [grouped]
    }

    if (hunk.move_path) {
      // #533：move destination 也按 consumer 提供的 canonical resolver 比较，alias 不应制造虚假冲突。
      if (existing.move_path && resolvePath(existing.move_path) !== resolvePath(hunk.move_path)) {
        throw new Error(`Conflicting move destinations for ${hunk.path}`)
      }
      existing.move_path ??= hunk.move_path
    }
    // #533：只合并 parser 已确认的 chunks；定位、唯一与重叠仍由唯一 Patch owner 负责。
    existing.chunks.push(...hunk.chunks)
    return []
  })
}

// Apply hunks to filesystem
export const applyHunksToFiles = Effect.fn("Patch.applyHunksToFiles")(function* (hunks: Hunk[]) {
  if (hunks.length === 0) {
    return yield* Effect.fail(new Error("No files were modified."))
  }

  const fs = yield* FSUtil.Service

  const added: string[] = []
  const modified: string[] = []
  const deleted: string[] = []

  for (const hunk of groupUpdateHunks(hunks, FSUtil.resolve)) {
    switch (hunk.type) {
      case "add": {
        yield* fs.writeWithDirs(hunk.path, hunk.contents)
        added.push(hunk.path)
        yield* Effect.logInfo(`Added file: ${hunk.path}`)
        break
      }

      case "delete": {
        yield* fs.remove(hunk.path)
        deleted.push(hunk.path)
        yield* Effect.logInfo(`Deleted file: ${hunk.path}`)
        break
      }

      case "update": {
        const originalText = yield* fs.readFileString(hunk.path)
        const fileUpdate = deriveNewContentsFromChunks(hunk.path, hunk.chunks, originalText)

        if (hunk.move_path) {
          yield* fs.writeWithDirs(hunk.move_path, Bom.join(fileUpdate.content, fileUpdate.bom))
          yield* fs.remove(hunk.path)
          modified.push(hunk.move_path)
          yield* Effect.logInfo(`Moved file: ${hunk.path} -> ${hunk.move_path}`)
        } else {
          yield* fs.writeWithDirs(hunk.path, Bom.join(fileUpdate.content, fileUpdate.bom))
          modified.push(hunk.path)
          yield* Effect.logInfo(`Updated file: ${hunk.path}`)
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

// Effectful verified-parse: needs FSUtil.Service to read existing files
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
      const fs = yield* FSUtil.Service
      const args = result.args
      const effectiveCwd = args.workdir ? path.resolve(cwd, args.workdir) : cwd
      const changes = new Map<string, ApplyPatchFileChange>()
      // #533：direct apply 与 verified preview 共用此 grouping 契约，避免相同 patch 在 consumer 间分叉。
      const groupedHunks = groupUpdateHunks(args.hunks, (filePath) =>
        FSUtil.resolve(path.resolve(effectiveCwd, filePath)),
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
