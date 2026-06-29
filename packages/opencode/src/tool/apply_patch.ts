import * as path from "path"
import { Cause, Effect, Exit, Schema } from "effect"
import type { InstanceContext } from "../project/instance-context"
import * as Tool from "./tool"
import { Bus } from "../bus"
import { FileWatcher } from "../file/watcher"
import { InstanceState } from "@/effect/instance-state"
import { Patch } from "../patch"
import { createTwoFilesPatch, diffLines } from "diff"
import { assertExternalDirectoryEffect } from "./external-directory"
import { trimDiff } from "./edit"
import { LSP } from "@/lsp/lsp"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import DESCRIPTION from "./apply_patch.txt"
import { File } from "../file"
import { Format } from "../format"
import * as Bom from "@/util/bom"
import { normalizeLineEndings } from "@/util/line-ending"

// [local-smark] 从 patch hunk chunks 中提取期望的旧行文本，
// 在 oldContent 中找到最近似的位置并返回上下文摘录。
// 仅在 patch context 匹配失败时调用，帮助模型看到 actual content 而无需 re-read。
// 限制摘录 5 行避免 error 消息过长。
function extractActualExcerpt(oldContent: string, chunks: unknown): string | undefined {
  // chunks 是 UpdateFileChunk[]，每个 chunk 有 old_lines: string[]
  // 从第一个 chunk 的 old_lines 中提取搜索目标
  let searchLine: string | undefined
  if (Array.isArray(chunks)) {
    for (const chunk of chunks) {
      if (typeof chunk === "object" && chunk !== null) {
        const c = chunk as Record<string, unknown>
        const oldLines = c.old_lines
        if (Array.isArray(oldLines)) {
          for (const l of oldLines) {
            if (typeof l === "string" && l.trim().length >= 3) {
              searchLine = l.trim()
              break
            }
          }
        }
      }
      if (searchLine) break
    }
  }
  if (!searchLine) return undefined
  // 在 oldContent 中找到与 searchLine 字符重叠最高的行
  const lines = oldContent.split("\n")
  let bestIdx = -1
  let bestScore = 0
  for (let i = 0; i < lines.length; i++) {
    const candidate = lines[i]!.trim()
    if (candidate.length === 0) continue
    const setA = new Set(searchLine.toLowerCase())
    let common = 0
    for (const ch of candidate.toLowerCase()) {
      if (setA.has(ch)) common++
    }
    const score = common / Math.max(1, Math.min(searchLine.length, candidate.length))
    if (score > bestScore) {
      bestScore = score
      bestIdx = i
    }
  }
  if (bestIdx < 0 || bestScore < 0.3) return undefined
  const start = Math.max(0, bestIdx - 1)
  const end = Math.min(lines.length, bestIdx + 4)
  return lines.slice(start, end).join("\n").slice(0, 500)
}

// [local-smark] 处理单个 hunk 的独立函数，支持 per-file atomicity。
// 调用方用 Effect.exit 捕获成功/失败，失败时收集错误继续处理其他 hunk。
// 逻辑与重构前的 switch/case 完全一致，仅提取为函数边界。
type FileChange = {
  filePath: string
  oldContent: string
  newContent: string
  type: "add" | "update" | "delete" | "move"
  movePath?: string
  diff: string
  additions: number
  deletions: number
  bom: boolean
}

const processSingleHunk = Effect.fn("ApplyPatchTool.processSingleHunk")(function* (
  hunk: Patch.Hunk,
  filePath: string,
  instance: InstanceContext,
  afs: AppFileSystem.Interface,
  ctx: Tool.Context,
  patchText: string,
) {
  switch (hunk.type) {
    case "add": {
      const oldContent = ""
      const newContent = hunk.contents.length === 0 || hunk.contents.endsWith("\n") ? hunk.contents : `${hunk.contents}\n`
      const next = Bom.split(newContent)
      const diffOld = normalizeLineEndings(oldContent)
      const diffNew = normalizeLineEndings(next.text)
      const diff = trimDiff(createTwoFilesPatch(filePath, filePath, diffOld, diffNew))
      let additions = 0
      let deletions = 0
      for (const change of diffLines(diffOld, diffNew)) {
        if (change.added) additions += change.count || 0
        if (change.removed) deletions += change.count || 0
      }
      return { filePath, oldContent, newContent: next.text, type: "add" as const, diff, additions, deletions, bom: next.bom }
    }
    case "update": {
      const stats = yield* afs.stat(filePath).pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (!stats || stats.type === "Directory") {
        return yield* Effect.fail(new Error(`Failed to read file to update: ${filePath}`))
      }
      const source = yield* Bom.readFile(afs, filePath)
      const oldContent = source.text
      let newContent = oldContent
      let bom = source.bom
      try {
        const fileUpdate = Patch.deriveNewContentsFromChunks(filePath, hunk.chunks, Bom.join(source.text, source.bom))
        newContent = fileUpdate.content
        bom = fileUpdate.bom
      } catch (error) {
        const actualExcerpt = extractActualExcerpt(oldContent, hunk.chunks)
        return yield* Effect.fail(new Error(`${error}` + (actualExcerpt ? `\n\nActual content near expected location:\n${actualExcerpt}` : "")))
      }
      const diffOld = normalizeLineEndings(oldContent)
      const diffNew = normalizeLineEndings(newContent)
      const diff = trimDiff(createTwoFilesPatch(filePath, filePath, diffOld, diffNew))
      let additions = 0
      let deletions = 0
      for (const change of diffLines(diffOld, diffNew)) {
        if (change.added) additions += change.count || 0
        if (change.removed) deletions += change.count || 0
      }
      const movePath = hunk.move_path ? path.resolve(instance.directory, hunk.move_path) : undefined
      if (movePath) {
        yield* assertExternalDirectoryEffect(ctx, movePath, {
          metadata: { action_kind: "tool", tool: "apply_patch", operation: "move", patchText },
        })
      }
      return { filePath, oldContent, newContent, type: hunk.move_path ? "move" as const : "update" as const, movePath, diff, additions, deletions, bom }
    }
    case "delete": {
      const source = yield* Bom.readFile(afs, filePath)
      const contentToDelete = source.text
      const diffOld = normalizeLineEndings(contentToDelete)
      const deleteDiff = trimDiff(createTwoFilesPatch(filePath, filePath, diffOld, ""))
      let deletions = 0
      for (const change of diffLines(diffOld, "")) {
        if (change.removed) deletions += change.count || 0
      }
      return { filePath, oldContent: contentToDelete, newContent: "", type: "delete" as const, diff: deleteDiff, additions: 0, deletions, bom: source.bom }
    }
    default:
      return yield* Effect.fail(new Error(`Unknown hunk type: ${(hunk as { type: string }).type}`))
  }
})

export const Parameters = Schema.Struct({
  patchText: Schema.String.annotate({ description: "The full patch text that describes all changes to be made" }),
})

export const ApplyPatchTool = Tool.define(
  "apply_patch",
  Effect.gen(function* () {
    const lsp = yield* LSP.Service
    const afs = yield* AppFileSystem.Service
    const format = yield* Format.Service
    const bus = yield* Bus.Service

    const run = Effect.fn("ApplyPatchTool.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context,
    ) {
      if (!params.patchText) {
        return yield* Effect.fail(new Error("patchText is required"))
      }

      // Parse the patch to get hunks
      let hunks: Patch.Hunk[]
      try {
        const parseResult = Patch.parsePatch(params.patchText)
        hunks = parseResult.hunks
      } catch (error) {
        return yield* Effect.fail(new Error(`apply_patch verification failed: ${error}`))
      }

      if (hunks.length === 0) {
        const normalized = params.patchText.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim()
        if (normalized === "*** Begin Patch\n*** End Patch") {
          return yield* Effect.fail(new Error("patch rejected: empty patch"))
        }
        return yield* Effect.fail(new Error("apply_patch verification failed: no hunks found"))
      }

      const instance = yield* InstanceState.context

      // Validate file paths and check permissions
      const fileChanges: Array<{
        filePath: string
        oldContent: string
        newContent: string
        type: "add" | "update" | "delete" | "move"
        movePath?: string
        diff: string
        additions: number
        deletions: number
        bom: boolean
      }> = []

      let totalDiff = ""

      // [local-smark] per-file atomicity：收集每个 hunk 的错误而非在第一个失败时立即返回。
      // 成功的 hunk 进入 fileChanges 正常 apply；失败的 hunk 记录 error 在 output 中报告。
      // 仅当全部 hunk 都失败时才返回 Effect.fail（不让空 patch 静默成功）。
      // 用 Effect.exit 捕获每个 hunk 的成功/失败，不中断循环。
      const hunkErrors: string[] = []

      for (const hunk of hunks) {
        const filePath = path.resolve(instance.directory, hunk.path)
        yield* assertExternalDirectoryEffect(ctx, filePath, {
          metadata: { action_kind: "tool", tool: "apply_patch", operation: hunk.type, patchText: params.patchText },
        })

        // 用 Effect.exit 捕获 hunk 处理的成功/失败
        const exit = yield* Effect.exit(processSingleHunk(hunk, filePath, instance, afs, ctx, params.patchText))
        if (Exit.isFailure(exit)) {
          const err = Cause.squash(exit.cause)
          hunkErrors.push(`${hunk.path}: ${err instanceof Error ? err.message : String(err)}`)
          continue
        }
        const change = exit.value
        fileChanges.push(change)
        totalDiff += change.diff + "\n"
      }

      // 全部 hunk 都失败时返回 error
      if (fileChanges.length === 0) {
        return yield* Effect.fail(new Error(
          `apply_patch verification failed: all hunks failed.\n${hunkErrors.join("\n")}`,
        ))
      }

      // Build per-file metadata for UI rendering (used for both permission and result)
      const files = fileChanges.map((change) => ({
        filePath: change.filePath,
        relativePath: path.relative(instance.worktree, change.movePath ?? change.filePath).replaceAll("\\", "/"),
        type: change.type,
        patch: change.diff,
        additions: change.additions,
        deletions: change.deletions,
        movePath: change.movePath,
      }))

      // Check permissions if needed
      const relativePaths = fileChanges.map((c) => path.relative(instance.worktree, c.filePath).replaceAll("\\", "/"))
      yield* ctx.ask({
        permission: "edit",
        patterns: relativePaths,
        always: ["*"],
        metadata: {
          filepath: relativePaths.join(", "),
          diff: totalDiff,
          files,
        },
      })

      // Apply the changes
      const updates: Array<{ file: string; event: "add" | "change" | "unlink" }> = []

      for (const change of fileChanges) {
        const edited = change.type === "delete" ? undefined : (change.movePath ?? change.filePath)
        switch (change.type) {
          case "add":
            // Create parent directories (recursive: true is safe on existing/root dirs)

            yield* afs.writeWithDirs(change.filePath, Bom.join(change.newContent, change.bom))
            updates.push({ file: change.filePath, event: "add" })
            break

          case "update":
            yield* afs.writeWithDirs(change.filePath, Bom.join(change.newContent, change.bom))
            updates.push({ file: change.filePath, event: "change" })
            break

          case "move":
            if (change.movePath) {
              // Create parent directories (recursive: true is safe on existing/root dirs)

              yield* afs.writeWithDirs(change.movePath!, Bom.join(change.newContent, change.bom))
              yield* afs.remove(change.filePath)
              updates.push({ file: change.filePath, event: "unlink" })
              updates.push({ file: change.movePath, event: "add" })
            }
            break

          case "delete":
            yield* afs.remove(change.filePath)
            updates.push({ file: change.filePath, event: "unlink" })
            break
        }

        if (edited) {
          if (yield* format.file(edited)) {
            yield* Bom.syncFile(afs, edited, change.bom)
          }
          yield* bus.publish(File.Event.Edited, { file: edited })
        }
      }

      // Publish file change events
      for (const update of updates) {
        yield* bus.publish(FileWatcher.Event.Updated, update)
      }

      // Notify LSP of file changes and collect diagnostics
      for (const change of fileChanges) {
        if (change.type === "delete") continue
        const target = change.movePath ?? change.filePath
        yield* lsp.touchFile(target, "document")
      }
      const diagnostics = yield* lsp.diagnostics()

      // Generate output summary
      const summaryLines = fileChanges.map((change) => {
        if (change.type === "add") {
          return `A ${path.relative(instance.worktree, change.filePath).replaceAll("\\", "/")}`
        }
        if (change.type === "delete") {
          return `D ${path.relative(instance.worktree, change.filePath).replaceAll("\\", "/")}`
        }
        const target = change.movePath ?? change.filePath
        return `M ${path.relative(instance.worktree, target).replaceAll("\\", "/")}`
      })
      let output = `Success. Updated the following files:\n${summaryLines.join("\n")}`

      // [local-smark] per-file atomicity：部分 hunk 失败时在 output 中报告失败文件
      if (hunkErrors.length > 0) {
        output += `\n\nFailed to update ${hunkErrors.length} file(s):\n${hunkErrors.join("\n")}`
      }

      let lspFoundErrors = false
      for (const change of fileChanges) {
        if (change.type === "delete") continue
        const target = change.movePath ?? change.filePath
        const block = LSP.Diagnostic.report(target, diagnostics[AppFileSystem.normalizePath(target)] ?? [])
        if (!block) continue
        lspFoundErrors = true
        const rel = path.relative(instance.worktree, target).replaceAll("\\", "/")
        output += `\n\nLSP errors detected in ${rel}, please fix:\n${block}`
      }
      // [local-smark] 当 LSP diagnostics 无结果且无已连接 client 时，
      // 追加不可用提示，避免模型误认为修改的文件无类型错误。
      // 用 status() 而非 hasClients()：后者检查 server 配置存在性，
      // 不代表 client 已完成 fire-and-forget 启动。
      if (!lspFoundErrors) {
        const clients = yield* lsp.status()
        if (clients.length === 0) {
          output += `\n\nLSP diagnostics unavailable (no language server running). Run bun typecheck to verify type safety.`
        }
      }

      return {
        title: output,
        metadata: {
          diff: totalDiff,
          files,
          diagnostics,
        },
        output,
      }
    })

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        run(params, ctx).pipe(Effect.orDie),
    }
  }),
)
