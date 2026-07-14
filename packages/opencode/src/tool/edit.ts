// the approaches in this edit tool are sourced from
// https://github.com/cline/cline/blob/main/evals/diff-edits/diff-apply/diff-06-23-25.ts
// https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/utils/editCorrector.ts
// https://github.com/cline/cline/blob/main/evals/diff-edits/diff-apply/diff-06-26-25.ts

import * as path from "path"
import { Effect, Schema, Semaphore } from "effect"
import * as Tool from "./tool"
import { LSP } from "@/lsp/lsp"
import { createTwoFilesPatch, diffLines } from "diff"
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
import { closestWindow } from "@/patch/match"

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

export function replace(content: string, oldString: string, newString: string, replaceAll = false): string {
  if (oldString === newString) {
    throw new Error("No changes to apply: oldString and newString are identical.")
  }

  const first = content.indexOf(oldString)
  if (first === -1) {
    // closest 只解释失败；即使分数很高也绝不能转成 replacement success。
    const closest = closestWindow(content, oldString)
    throw new Error(
      `Could not find oldString in the file. It must match exactly, including whitespace, indentation, and line endings.` +
        (closest
          ? `\n\nClosest match at line ${closest.line}:\n${closest.excerpt}`
          : "\n\nNo reliable nearby candidate was found. Read the file and retry with exact text."),
    )
  }

  // replaceAll 是调用方对多处 exact literal 的显式授权，必须在 ambiguity 拒绝前处理。
  if (replaceAll) return content.replaceAll(oldString, newString)
  // 从下一字符寻找可识别重叠 occurrence；未显式 replaceAll 时，任何第二处精确匹配都必须拒绝。
  if (content.indexOf(oldString, first + 1) !== -1) {
    throw new Error("Found multiple matches for oldString. Provide more surrounding context to make the match unique.")
  }
  return content.slice(0, first) + newString + content.slice(first + oldString.length)
}
