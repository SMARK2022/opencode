// the approaches in this edit tool are sourced from
// https://github.com/cline/cline/blob/main/evals/diff-edits/diff-apply/diff-06-23-25.ts
// https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/utils/editCorrector.ts
// https://github.com/cline/cline/blob/main/evals/diff-edits/diff-apply/diff-06-26-25.ts

import * as path from "path"
import { Effect, Schema, Semaphore } from "effect"
import * as Tool from "./tool"
import { LSP } from "@/lsp/lsp"
import { createTwoFilesPatch, diffLines, diffChars } from "diff"
import type { Change } from "diff"
import DESCRIPTION from "./edit.txt"
import { File } from "../file"
import { FileWatcher } from "../file/watcher"
import { Bus } from "../bus"
import { Format } from "../format"
import { InstanceState } from "@/effect/instance-state"
import { Snapshot } from "@/snapshot"
import { assertExternalDirectoryEffect } from "./external-directory"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import * as Bom from "@/util/bom"
import { convertToLineEnding, detectLineEnding, normalizeLineEndings } from "@/util/line-ending"

const locks = new Map<string, Semaphore.Semaphore>()

function lock(filePath: string) {
  const resolvedFilePath = AppFileSystem.resolve(filePath)
  const hit = locks.get(resolvedFilePath)
  if (hit) return hit

  const next = Semaphore.makeUnsafe(1)
  locks.set(resolvedFilePath, next)
  return next
}

export const Parameters = Schema.Struct({
  filePath: Schema.String.annotate({ description: "The absolute path to the file to modify" }),
  oldString: Schema.String.annotate({ description: "The text to replace" }),
  newString: Schema.String.annotate({
    description: "The text to replace it with (must be different from oldString)",
  }),
  replaceAll: Schema.optional(Schema.Boolean).annotate({
    description: "Replace all occurrences of oldString (default false)",
  }),
})

export const EditTool = Tool.define(
  "edit",
  Effect.gen(function* () {
    const lsp = yield* LSP.Service
    const afs = yield* AppFileSystem.Service
    const format = yield* Format.Service
    const bus = yield* Bus.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          if (!params.filePath) {
            throw new Error("filePath is required")
          }

          if (params.oldString === params.newString) {
            throw new Error("No changes to apply: oldString and newString are identical.")
          }

          const instance = yield* InstanceState.context
          const filePath = path.isAbsolute(params.filePath)
            ? params.filePath
            : path.join(instance.directory, params.filePath)

          // [local-smark] blind edit 检查：当 oldString 非空（非创建文件模式）时，
          // 检查文件是否在当前 session 的消息历史中被 read/write/edit 接触过。
          // 未接触过的文件可能有过期内容（auto-format、外部修改），
          // oldString 基于假设会导致匹配失败。
          // 用 path.resolve 规范化路径比较，避免正斜杠/反斜杠差异导致误拦截。
          // Windows 下 NTFS 大小写不敏感，需 toLowerCase；Linux/macOS 大小写敏感，不应 lower。
          // 遵循 read.ts canonicalReadPath 的同一平台分支范式。
          // apply_patch 的 input 是 patchText 而非 filePath，无法简单匹配，不纳入检查。
          if (params.oldString !== "") {
            const resolveForCompare = (p: string) => {
              const r = path.resolve(p)
              return process.platform === "win32" ? r.toLowerCase() : r
            }
            const resolvedFilePath = resolveForCompare(filePath)
            const hasTouched = ctx.messages.some((msg) =>
              msg.info.role === "assistant" &&
              msg.parts.some((part) => {
                if (part.type !== "tool" || part.state.status !== "completed") return false
                if (part.tool !== "read" && part.tool !== "write" && part.tool !== "edit") return false
                const input = part.state.input as Record<string, unknown> | undefined
                if (!input || typeof input.filePath !== "string") return false
                return resolveForCompare(input.filePath) === resolvedFilePath
              }),
            )
            if (!hasTouched) {
              throw new Error(
                `File has not been read in this session: ${filePath}. Read it first to verify current content, then retry the edit.`,
              )
            }
          }

          yield* assertExternalDirectoryEffect(ctx, filePath, {
            // Include the intended edit operation so Auto reviewer decisions are
            // based on tool evidence, not just the external path glob.
            metadata: {
              action_kind: "tool",
              tool: "edit",
              operation: params.oldString === "" ? "create" : "edit",
              oldString: params.oldString,
              newString: params.newString,
              replaceAll: params.replaceAll === true,
            },
          })

          let diff = ""
          let contentOld = ""
          let contentNew = ""
          yield* lock(filePath).withPermits(1)(
            Effect.gen(function* () {
              if (params.oldString === "") {
                const existed = yield* afs.existsSafe(filePath)
                const source = existed ? yield* Bom.readFile(afs, filePath) : { bom: false, text: "" }
                const next = Bom.split(params.newString)
                const desiredBom = source.bom || next.bom
                contentOld = source.text
                contentNew = next.text
                diff = trimDiff(
                  createTwoFilesPatch(filePath, filePath, normalizeLineEndings(contentOld), normalizeLineEndings(contentNew)),
                )
                yield* ctx.ask({
                  permission: "edit",
                  patterns: [path.relative(instance.worktree, filePath)],
                  always: ["*"],
                  metadata: {
                    filepath: filePath,
                    diff,
                  },
                })
                yield* afs.writeWithDirs(filePath, Bom.join(contentNew, desiredBom))
                if (yield* format.file(filePath)) {
                  contentNew = yield* Bom.syncFile(afs, filePath, desiredBom)
                }
                yield* bus.publish(File.Event.Edited, { file: filePath })
                yield* bus.publish(FileWatcher.Event.Updated, {
                  file: filePath,
                  event: existed ? "change" : "add",
                })
                return
              }

              const info = yield* afs.stat(filePath).pipe(Effect.catch(() => Effect.succeed(undefined)))
              if (!info) throw new Error(`File ${filePath} not found`)
              if (info.type === "Directory") throw new Error(`Path is a directory, not a file: ${filePath}`)
              const source = yield* Bom.readFile(afs, filePath)
              contentOld = source.text

              const ending = detectLineEnding(contentOld)
              const old = convertToLineEnding(normalizeLineEndings(params.oldString), ending)
              const replacement = convertToLineEnding(normalizeLineEndings(params.newString), ending)

              const next = Bom.split(replace(contentOld, old, replacement, params.replaceAll))
              const desiredBom = source.bom || next.bom
              contentNew = next.text

              diff = trimDiff(
                createTwoFilesPatch(
                  filePath,
                  filePath,
                  normalizeLineEndings(contentOld),
                  normalizeLineEndings(contentNew),
                ),
              )
              yield* ctx.ask({
                permission: "edit",
                patterns: [path.relative(instance.worktree, filePath)],
                always: ["*"],
                metadata: {
                  filepath: filePath,
                  diff,
                },
              })

              yield* afs.writeWithDirs(filePath, Bom.join(contentNew, desiredBom))
              if (yield* format.file(filePath)) {
                contentNew = yield* Bom.syncFile(afs, filePath, desiredBom)
              }
              yield* bus.publish(File.Event.Edited, { file: filePath })
              yield* bus.publish(FileWatcher.Event.Updated, {
                file: filePath,
                event: "change",
              })
              diff = trimDiff(
                createTwoFilesPatch(
                  filePath,
                  filePath,
                  normalizeLineEndings(contentOld),
                  normalizeLineEndings(contentNew),
                ),
              )
            }).pipe(Effect.orDie),
          )

          const diffOld = normalizeLineEndings(contentOld)
          const diffNew = normalizeLineEndings(contentNew)
          let additions = 0
          let deletions = 0
          for (const change of diffLines(diffOld, diffNew)) {
            if (change.added) additions += change.count || 0
            if (change.removed) deletions += change.count || 0
          }
          const filediff: Snapshot.FileDiff = {
            file: filePath,
            patch: diff,
            additions,
            deletions,
          }

          yield* ctx.metadata({
            metadata: {
              diff,
              filediff,
              diagnostics: {},
            },
          })

          let output = "Edit applied successfully."
          const normalizedFilePath = AppFileSystem.normalizePath(filePath)
          // [local-smark] baseline 在写入后、touch 前采集：LSP 此时还不知道新内容，诊断反映旧状态。
          const beforeIssues = (yield* lsp.diagnostics())[normalizedFilePath] ?? []
          yield* lsp.touchFile(filePath, "document")
          const afterDiagnostics = yield* lsp.diagnostics()
          const currentIssues = afterDiagnostics[normalizedFilePath] ?? []
          const block = LSP.Diagnostic.reportDelta(filePath, currentIssues, beforeIssues)
          // [local-smark] 计算新错误数组和摘要供 TUI 渲染
          const newErrorsArr = LSP.Diagnostic.newErrors(currentIssues, beforeIssues)
          const delta = LSP.Diagnostic.deltaSummary(currentIssues, beforeIssues)
          let diagnosticSummary: typeof delta | undefined = delta
          if (block) {
            output += `\n\nNew LSP errors introduced by this edit:\n${block}`
            output += `\n\nNote: If this is part of a multi-step edit, some errors may be expected until all changes are complete.`
          } else {
            // [local-smark] delta 空 ≠ LSP 验证通过：LSP 未运行时 baseline 和 current 都为空
            const clients = yield* lsp.status()
            if (clients.length === 0) {
              diagnosticSummary = undefined
              output += `\n\nLSP diagnostics unavailable (no language server running). Run bun typecheck to verify type safety.`
            } else {
              // [local-smark] 只输出一行检查结果，不展开既有错误详情，保持 edit 反馈高信噪比。
              output += `\n\n${LSP.Diagnostic.checkedMessage(delta, "file")}`
            }
          }

          return {
            metadata: {
              // [local-smark] metadata.diagnostics 存储新错误数组（delta）+ diagnosticSummary 供 TUI
              diagnostics: { [normalizedFilePath]: newErrorsArr },
              // summary 只有在 LSP 可靠可用时才传给 TUI，避免 unavailable 时出现绿色 clean。
              ...(diagnosticSummary ? { diagnosticSummary } : {}),
              diff,
              filediff,
            },
            title: `${path.relative(instance.worktree, filePath)}`,
            output,
          }
        }),
    }
  }),
)

export type Replacer = (content: string, find: string) => Generator<string, void, unknown>

// Similarity thresholds for block anchor fallback matching
const SINGLE_CANDIDATE_SIMILARITY_THRESHOLD = 0.0
const MULTIPLE_CANDIDATES_SIMILARITY_THRESHOLD = 0.3

/**
 * Levenshtein distance algorithm implementation
 */
function levenshtein(a: string, b: string): number {
  // Handle empty strings
  if (a === "" || b === "") {
    return Math.max(a.length, b.length)
  }
  const matrix = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  )

  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      matrix[i][j] = Math.min(matrix[i - 1][j] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j - 1] + cost)
    }
  }
  return matrix[a.length][b.length]
}

export const SimpleReplacer: Replacer = function* (_content, find) {
  yield find
}

export const LineTrimmedReplacer: Replacer = function* (content, find) {
  const originalLines = content.split("\n")
  const searchLines = find.split("\n")

  if (searchLines[searchLines.length - 1] === "") {
    searchLines.pop()
  }

  for (let i = 0; i <= originalLines.length - searchLines.length; i++) {
    let matches = true

    for (let j = 0; j < searchLines.length; j++) {
      const originalTrimmed = originalLines[i + j].trim()
      const searchTrimmed = searchLines[j].trim()

      if (originalTrimmed !== searchTrimmed) {
        matches = false
        break
      }
    }

    if (matches) {
      let matchStartIndex = 0
      for (let k = 0; k < i; k++) {
        matchStartIndex += originalLines[k].length + 1
      }

      let matchEndIndex = matchStartIndex
      for (let k = 0; k < searchLines.length; k++) {
        matchEndIndex += originalLines[i + k].length
        if (k < searchLines.length - 1) {
          matchEndIndex += 1 // Add newline character except for the last line
        }
      }

      yield content.substring(matchStartIndex, matchEndIndex)
    }
  }
}

export const BlockAnchorReplacer: Replacer = function* (content, find) {
  const originalLines = content.split("\n")
  const searchLines = find.split("\n")

  if (searchLines.length < 3) {
    return
  }

  if (searchLines[searchLines.length - 1] === "") {
    searchLines.pop()
  }

  const firstLineSearch = searchLines[0].trim()
  const lastLineSearch = searchLines[searchLines.length - 1].trim()
  const searchBlockSize = searchLines.length

  // Collect all candidate positions where both anchors match
  const candidates: Array<{ startLine: number; endLine: number }> = []
  for (let i = 0; i < originalLines.length; i++) {
    if (originalLines[i].trim() !== firstLineSearch) {
      continue
    }

    // Look for the matching last line after this first line
    for (let j = i + 2; j < originalLines.length; j++) {
      if (originalLines[j].trim() === lastLineSearch) {
        candidates.push({ startLine: i, endLine: j })
        break // Only match the first occurrence of the last line
      }
    }
  }

  // Return immediately if no candidates
  if (candidates.length === 0) {
    return
  }

  // Handle single candidate scenario (using relaxed threshold)
  if (candidates.length === 1) {
    const { startLine, endLine } = candidates[0]
    const actualBlockSize = endLine - startLine + 1

    let similarity = 0
    let linesToCheck = Math.min(searchBlockSize - 2, actualBlockSize - 2) // Middle lines only

    if (linesToCheck > 0) {
      for (let j = 1; j < searchBlockSize - 1 && j < actualBlockSize - 1; j++) {
        const originalLine = originalLines[startLine + j].trim()
        const searchLine = searchLines[j].trim()
        const maxLen = Math.max(originalLine.length, searchLine.length)
        if (maxLen === 0) {
          continue
        }
        const distance = levenshtein(originalLine, searchLine)
        similarity += (1 - distance / maxLen) / linesToCheck

        // Exit early when threshold is reached
        if (similarity >= SINGLE_CANDIDATE_SIMILARITY_THRESHOLD) {
          break
        }
      }
    } else {
      // No middle lines to compare, just accept based on anchors
      similarity = 1.0
    }

    if (similarity >= SINGLE_CANDIDATE_SIMILARITY_THRESHOLD) {
      let matchStartIndex = 0
      for (let k = 0; k < startLine; k++) {
        matchStartIndex += originalLines[k].length + 1
      }
      let matchEndIndex = matchStartIndex
      for (let k = startLine; k <= endLine; k++) {
        matchEndIndex += originalLines[k].length
        if (k < endLine) {
          matchEndIndex += 1 // Add newline character except for the last line
        }
      }
      yield content.substring(matchStartIndex, matchEndIndex)
    }
    return
  }

  // Calculate similarity for multiple candidates
  let bestMatch: { startLine: number; endLine: number } | null = null
  let maxSimilarity = -1

  for (const candidate of candidates) {
    const { startLine, endLine } = candidate
    const actualBlockSize = endLine - startLine + 1

    let similarity = 0
    let linesToCheck = Math.min(searchBlockSize - 2, actualBlockSize - 2) // Middle lines only

    if (linesToCheck > 0) {
      for (let j = 1; j < searchBlockSize - 1 && j < actualBlockSize - 1; j++) {
        const originalLine = originalLines[startLine + j].trim()
        const searchLine = searchLines[j].trim()
        const maxLen = Math.max(originalLine.length, searchLine.length)
        if (maxLen === 0) {
          continue
        }
        const distance = levenshtein(originalLine, searchLine)
        similarity += 1 - distance / maxLen
      }
      similarity /= linesToCheck // Average similarity
    } else {
      // No middle lines to compare, just accept based on anchors
      similarity = 1.0
    }

    if (similarity > maxSimilarity) {
      maxSimilarity = similarity
      bestMatch = candidate
    }
  }

  // Threshold judgment
  if (maxSimilarity >= MULTIPLE_CANDIDATES_SIMILARITY_THRESHOLD && bestMatch) {
    const { startLine, endLine } = bestMatch
    let matchStartIndex = 0
    for (let k = 0; k < startLine; k++) {
      matchStartIndex += originalLines[k].length + 1
    }
    let matchEndIndex = matchStartIndex
    for (let k = startLine; k <= endLine; k++) {
      matchEndIndex += originalLines[k].length
      if (k < endLine) {
        matchEndIndex += 1
      }
    }
    yield content.substring(matchStartIndex, matchEndIndex)
  }
}

export const WhitespaceNormalizedReplacer: Replacer = function* (content, find) {
  const normalizeWhitespace = (text: string) => text.replace(/\s+/g, " ").trim()
  const normalizedFind = normalizeWhitespace(find)

  // Handle single line matches
  const lines = content.split("\n")
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (normalizeWhitespace(line) === normalizedFind) {
      yield line
    } else {
      // Only check for substring matches if the full line doesn't match
      const normalizedLine = normalizeWhitespace(line)
      if (normalizedLine.includes(normalizedFind)) {
        // Find the actual substring in the original line that matches
        const words = find.trim().split(/\s+/)
        if (words.length > 0) {
          const pattern = words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+")
          try {
            const regex = new RegExp(pattern)
            const match = line.match(regex)
            if (match) {
              yield match[0]
            }
          } catch {
            // Invalid regex pattern, skip
          }
        }
      }
    }
  }

  // Handle multi-line matches
  const findLines = find.split("\n")
  if (findLines.length > 1) {
    for (let i = 0; i <= lines.length - findLines.length; i++) {
      const block = lines.slice(i, i + findLines.length)
      if (normalizeWhitespace(block.join("\n")) === normalizedFind) {
        yield block.join("\n")
      }
    }
  }
}

export const IndentationFlexibleReplacer: Replacer = function* (content, find) {
  const removeIndentation = (text: string) => {
    const lines = text.split("\n")
    const nonEmptyLines = lines.filter((line) => line.trim().length > 0)
    if (nonEmptyLines.length === 0) return text

    const minIndent = Math.min(
      ...nonEmptyLines.map((line) => {
        const match = line.match(/^(\s*)/)
        return match ? match[1].length : 0
      }),
    )

    return lines.map((line) => (line.trim().length === 0 ? line : line.slice(minIndent))).join("\n")
  }

  const normalizedFind = removeIndentation(find)
  const contentLines = content.split("\n")
  const findLines = find.split("\n")

  for (let i = 0; i <= contentLines.length - findLines.length; i++) {
    const block = contentLines.slice(i, i + findLines.length).join("\n")
    if (removeIndentation(block) === normalizedFind) {
      yield block
    }
  }
}

export const EscapeNormalizedReplacer: Replacer = function* (content, find) {
  const unescapeString = (str: string): string => {
    return str.replace(/\\(n|t|r|'|"|`|\\|\n|\$)/g, (match, capturedChar) => {
      switch (capturedChar) {
        case "n":
          return "\n"
        case "t":
          return "\t"
        case "r":
          return "\r"
        case "'":
          return "'"
        case '"':
          return '"'
        case "`":
          return "`"
        case "\\":
          return "\\"
        case "\n":
          return "\n"
        case "$":
          return "$"
        default:
          return match
      }
    })
  }

  const unescapedFind = unescapeString(find)

  // Try direct match with unescaped find string
  if (content.includes(unescapedFind)) {
    yield unescapedFind
  }

  // Also try finding escaped versions in content that match unescaped find
  const lines = content.split("\n")
  const findLines = unescapedFind.split("\n")

  for (let i = 0; i <= lines.length - findLines.length; i++) {
    const block = lines.slice(i, i + findLines.length).join("\n")
    const unescapedBlock = unescapeString(block)

    if (unescapedBlock === unescapedFind) {
      yield block
    }
  }
}

export const MultiOccurrenceReplacer: Replacer = function* (content, find) {
  // This replacer yields all exact matches, allowing the replace function
  // to handle multiple occurrences based on replaceAll parameter
  let startIndex = 0

  while (true) {
    const index = content.indexOf(find, startIndex)
    if (index === -1) break

    yield find
    startIndex = index + find.length
  }
}

export const TrimmedBoundaryReplacer: Replacer = function* (content, find) {
  const trimmedFind = find.trim()

  if (trimmedFind === find) {
    // Already trimmed, no point in trying
    return
  }

  // Try to find the trimmed version
  if (content.includes(trimmedFind)) {
    yield trimmedFind
  }

  // Also try finding blocks where trimmed content matches
  const lines = content.split("\n")
  const findLines = find.split("\n")

  for (let i = 0; i <= lines.length - findLines.length; i++) {
    const block = lines.slice(i, i + findLines.length).join("\n")

    if (block.trim() === trimmedFind) {
      yield block
    }
  }
}

export const ContextAwareReplacer: Replacer = function* (content, find) {
  const findLines = find.split("\n")
  if (findLines.length < 3) {
    // Need at least 3 lines to have meaningful context
    return
  }

  // Remove trailing empty line if present
  if (findLines[findLines.length - 1] === "") {
    findLines.pop()
  }

  const contentLines = content.split("\n")

  // Extract first and last lines as context anchors
  const firstLine = findLines[0].trim()
  const lastLine = findLines[findLines.length - 1].trim()

  // Find blocks that start and end with the context anchors
  for (let i = 0; i < contentLines.length; i++) {
    if (contentLines[i].trim() !== firstLine) continue

    // Look for the matching last line
    for (let j = i + 2; j < contentLines.length; j++) {
      if (contentLines[j].trim() === lastLine) {
        // Found a potential context block
        const blockLines = contentLines.slice(i, j + 1)
        const block = blockLines.join("\n")

        // Check if the middle content has reasonable similarity
        // (simple heuristic: at least 50% of non-empty lines should match when trimmed)
        if (blockLines.length === findLines.length) {
          let matchingLines = 0
          let totalNonEmptyLines = 0

          for (let k = 1; k < blockLines.length - 1; k++) {
            const blockLine = blockLines[k].trim()
            const findLine = findLines[k].trim()

            if (blockLine.length > 0 || findLine.length > 0) {
              totalNonEmptyLines++
              if (blockLine === findLine) {
                matchingLines++
              }
            }
          }

          if (totalNonEmptyLines === 0 || matchingLines / totalNonEmptyLines >= 0.5) {
            yield block
            break // Only match the first occurrence
          }
        }
        break
      }
    }
  }
}

export function trimDiff(diff: string): string {
  const lines = diff.split("\n")
  const contentLines = lines.filter(
    (line) =>
      (line.startsWith("+") || line.startsWith("-") || line.startsWith(" ")) &&
      !line.startsWith("---") &&
      !line.startsWith("+++"),
  )

  if (contentLines.length === 0) return diff

  let min = Infinity
  for (const line of contentLines) {
    const content = line.slice(1)
    if (content.trim().length > 0) {
      const match = content.match(/^(\s*)/)
      if (match) min = Math.min(min, match[1].length)
    }
  }
  if (min === Infinity || min === 0) return diff
  const trimmedLines = lines.map((line) => {
    if (
      (line.startsWith("+") || line.startsWith("-") || line.startsWith(" ")) &&
      !line.startsWith("---") &&
      !line.startsWith("+++")
    ) {
      const prefix = line[0]
      const content = line.slice(1)
      return prefix + content.slice(min)
    }
    return line
  })

  return trimmedLines.join("\n")
}

// [local-smark] 滑动窗口查找 content 中与 oldString 最相似的区域。
// 用 oldString 首行与 content 各行做简单字符重叠比较，返回最佳匹配位置和摘录。
// 仅在 replace() 抛出 notFound 错误时调用，不影响正常路径性能。
// 限制摘录 5 行 / 500 字符，避免 error 消息过长导致上下文膨胀。
function findClosestMatch(content: string, oldString: string): { line: number; excerpt: string } | undefined {
  const contentLines = content.split("\n")
  const oldLines = oldString.split("\n").filter((l) => l.trim().length > 0)
  if (oldLines.length === 0) return undefined
  const firstOld = oldLines[0]!.trim()
  if (firstOld.length < 3) return undefined
  let bestLine = -1
  let bestScore = 0
  for (let i = 0; i < contentLines.length; i++) {
    const candidate = contentLines[i]!.trim()
    if (candidate.length === 0) continue
    // 简单字符重叠率：共同字符数 / 较短串长度
    const score = charOverlap(firstOld, candidate)
    if (score > bestScore) {
      bestScore = score
      bestLine = i
    }
  }
  if (bestLine < 0 || bestScore < 0.3) return undefined
  // [local-smark] 窗口按 oldString 行数缩放：确保 fileExcerpt 覆盖 oldString 对应区域
  const oldLineCount = oldLines.length
  const fileStart = Math.max(0, bestLine - 1)
  const fileEnd = Math.min(contentLines.length, bestLine + oldLineCount + 2)
  const fileExcerpt = contentLines.slice(fileStart, fileEnd).join("\n")
  // [local-smark] 优先用字符级 diff（信息密度高，只显示差异部分）；
  // 回退时用 head+tail excerpt（前 200 + 后 200 字符），确保末尾内容可见
  const diffExcerpt = formatClosestMatchDiff(oldString, fileExcerpt, fileStart + 1, 500)
  const excerpt = diffExcerpt || (() => {
    const full = fileExcerpt
    return full.length <= 500 ? full : full.slice(0, 200) + `\n...[${full.length - 400} chars omitted]...\n` + full.slice(-200)
  })()
  return { line: fileStart + 1, excerpt }
}

// [local-smark] 字符级 diff：diffLines 定位差异行，diffChars 显示字符级差异。
// 解决长行场景下 .slice(0,500) 截断导致 ]; vs }; 不可见的问题。
// diffLines 的 change.value 可含多行，用 oneChangePerToken 确保每个 change 一行。
function formatClosestMatchDiff(
  oldString: string,
  fileExcerpt: string,
  fileStartLine: number,
  maxChars: number,
): string {
  // pendingRemoved 必须在函数内声明——跨调用持久化会导致配对错误
  const pendingRemoved: string[] = []
  const changes = diffLines(oldString, fileExcerpt, { oneChangePerToken: true })
  // 先统计差异行比例，决定是否回退
  let removedLines = 0
  let addedLines = 0
  let unchangedLines = 0
  for (const c of changes) {
    const lineCount = c.value.split("\n").filter((l) => l.length > 0).length
    if (c.removed) removedLines += lineCount
    else if (c.added) addedLines += lineCount
    else unchangedLines += lineCount
  }
  // [local-smark] 差异行比例：用 max(removed, added) 代表不匹配的行位置数，
  // 而非 removed+added（一个不匹配产生 1 removed + 1 added = 2，会膨胀比例）。
  // 总行数用 max(old, file) 行数，避免短 oldString 对长 fileExcerpt 时比例失真。
  const diffLineCount = Math.max(removedLines, addedLines)
  const totalLineCount = Math.max(removedLines, addedLines) + unchangedLines
  // 差异行 > 60% → 结构严重错位，回退 head+tail excerpt
  if (totalLineCount > 0 && diffLineCount / totalLineCount > 0.6) return ""

  const parts: string[] = []
  let newIdx = 0
  let totalChars = 0
  let omitted = 0
  for (const change of changes) {
    const lines = change.value.split("\n").filter((l) => l.length > 0)
    if (change.added) {
      // 文件中的行——与上一个 removed 行做 diffChars
      for (const line of lines) {
        const oldLine = pendingRemoved.shift()
        if (oldLine !== undefined) {
          const formatted = formatCharDiffLine(fileStartLine + newIdx, oldLine, line)
          if (formatted && totalChars + formatted.length < maxChars) {
            parts.push(formatted)
            totalChars += formatted.length + 1
          } else if (formatted) {
            omitted++
          }
        }
        newIdx++
      }
    } else if (change.removed) {
      // oldString 中的行——暂存，等待下一个 added 配对
      for (const line of lines) pendingRemoved.push(line)
    } else {
      // 未变化行——跳过（不占用预算），只推进行号
      newIdx += lines.length
    }
  }
  if (parts.length === 0) return ""
  // [local-smark] 截断标记：预算耗尽时告知模型还有更多差异
  if (omitted > 0) parts.push(`...(+${omitted} more diff lines)`)
  return parts.join("\n")
}

// [local-smark] 格式化单行字符级 diff：只输出变化点前后 30 字符的 context。
// 例：行末 }; vs ]; → line 41: "    };" → "    ];"
// 对 900 字符长行：只显示末尾 30 字符 + 差异，不显示公共前缀。
function formatCharDiffLine(lineNum: number, oldLine: string, newLine: string): string | undefined {
  const charDiff: Change[] = diffChars(oldLine, newLine)
  // 找到第一个变化位置
  let prefixLen = 0
  for (const c of charDiff) {
    if (c.added || c.removed) break
    prefixLen += c.value.length
  }
  // 无差异
  if (prefixLen >= oldLine.length && prefixLen >= newLine.length) return undefined
  // 提取变化部分
  let oldPart = ""
  let newPart = ""
  let suffix = ""
  let inChange = false
  for (const c of charDiff) {
    if (c.removed) { oldPart += c.value; inChange = true }
    else if (c.added) { newPart += c.value; inChange = true }
    else if (inChange) { suffix = c.value.slice(0, 20); break }
  }
  if (!oldPart && !newPart) return undefined
  // context：变化点前 30 字符 + 变化 + 变化后 20 字符
  const contextChars = 30
  const ctxStart = Math.max(0, prefixLen - contextChars)
  const ctx = oldLine.slice(ctxStart, prefixLen)
  // 截断过长的 context 和 suffix，控制总输出长度
  const truncate = (s: string, max: number) => s.length <= max ? s : s.slice(0, max) + "..."
  return `line ${lineNum}: "${truncate(ctx + oldPart + suffix, 80)}" → "${truncate(ctx + newPart + suffix, 80)}"`
}

// 计算两个字符串的字符重叠率（0~1），用于 closest match 相似度评估
function charOverlap(a: string, b: string): number {
  const setA = new Set(a.toLowerCase())
  let common = 0
  for (const ch of b.toLowerCase()) {
    if (setA.has(ch)) common++
  }
  return common / Math.max(1, Math.min(a.length, b.length))
}

export function replace(content: string, oldString: string, newString: string, replaceAll = false): string {
  if (oldString === newString) {
    throw new Error("No changes to apply: oldString and newString are identical.")
  }

  let notFound = true

  for (const replacer of [
    SimpleReplacer,
    LineTrimmedReplacer,
    BlockAnchorReplacer,
    WhitespaceNormalizedReplacer,
    IndentationFlexibleReplacer,
    EscapeNormalizedReplacer,
    TrimmedBoundaryReplacer,
    ContextAwareReplacer,
    MultiOccurrenceReplacer,
  ]) {
    for (const search of replacer(content, oldString)) {
      const index = content.indexOf(search)
      if (index === -1) continue
      notFound = false
      if (replaceAll) {
        return content.replaceAll(search, newString)
      }
      const lastIndex = content.lastIndexOf(search)
      if (index !== lastIndex) continue
      return content.substring(0, index) + newString + content.substring(index + search.length)
    }
  }

  if (notFound) {
    // [local-smark] 在 oldString 未匹配时，提供 actual content 的最近似区域，
    // 帮助模型自纠正而无需单独 re-read 文件。
    // 用滑动窗口逐行比较 oldString 首行与 content 各行的相似度，
    // 返回相似度最高的区域摘要（限制 5 行避免上下文膨胀）。
    const closest = findClosestMatch(content, oldString)
    throw new Error(
      `Could not find oldString in the file. It must match exactly, including whitespace, indentation, and line endings.` +
        (closest ? `\n\nClosest match at line ${closest.line}:\n${closest.excerpt}` : ""),
    )
  }
  throw new Error("Found multiple matches for oldString. Provide more surrounding context to make the match unique.")
}
