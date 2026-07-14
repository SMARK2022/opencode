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
// [local-smark] LSPClient.Diagnostic 类型用于增量诊断 baseline Map 的类型标注
import type * as LSPClient from "@/lsp/client"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import DESCRIPTION from "./apply_patch.txt"
import { File } from "../file"
import { Format } from "../format"
import * as Bom from "@/util/bom"
import { normalizeLineEndings } from "@/util/line-ending"

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
        // Patch owner 仍持有失败 chunk 身份与 persisted text；Tool 只聚合其错误，不能运行第二套 matcher。
        return yield* Effect.fail(error instanceof Error ? error : new Error(String(error)))
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

      // [local-smark] baseline 在 patch 落盘后、touch 前采集：LSP 此时还不知道新内容。
      const beforeAll = yield* lsp.diagnostics()
      const baselines = new Map<string, LSPClient.Diagnostic[]>()
      for (const change of fileChanges) {
        if (change.type === "delete") continue
        const target = change.movePath ?? change.filePath
        const normalized = AppFileSystem.normalizePath(target)
        baselines.set(normalized, beforeAll[normalized] ?? [])
      }

      // Notify LSP of file changes
      for (const change of fileChanges) {
        if (change.type === "delete") continue
        const target = change.movePath ?? change.filePath
        yield* lsp.touchFile(target, "document")
      }
      const afterAll = yield* lsp.diagnostics()

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

      // [local-smark] 逐文件计算增量诊断，只显示本次 patch 新引入的错误
      let lspFoundNewErrors = false
      let totalNew = 0
      let totalExisting = 0
      const diagMetadata: Record<string, LSPClient.Diagnostic[]> = {}
      for (const change of fileChanges) {
        if (change.type === "delete") continue
        const target = change.movePath ?? change.filePath
        const normalized = AppFileSystem.normalizePath(target)
        const currentIssues = afterAll[normalized] ?? []
        const fileBaseline = baselines.get(normalized) ?? []
        // [local-smark] 新错误数组和摘要：供 metadata 和 TUI 渲染
        const fileNewErrors = LSP.Diagnostic.newErrors(currentIssues, fileBaseline)
        const fileDelta = LSP.Diagnostic.deltaSummary(currentIssues, fileBaseline)
        totalNew += fileDelta.newCount
        totalExisting += fileDelta.existingCount
        diagMetadata[normalized] = fileNewErrors
        const block = LSP.Diagnostic.reportDelta(target, currentIssues, fileBaseline)
        if (!block) continue
        lspFoundNewErrors = true
        const rel = path.relative(instance.worktree, target).replaceAll("\\", "/")
        output += `\n\nNew LSP errors introduced in ${rel}:\n${block}`
      }
      let diagnosticSummary: { newCount: number; existingCount: number } | undefined = {
        newCount: totalNew,
        existingCount: totalExisting,
      }
      if (lspFoundNewErrors) {
        output += `\n\nNote: If this is part of a multi-step edit, some errors may be expected until all changes are complete.`
      } else {
        // [local-smark] delta 空 ≠ LSP 验证通过：LSP 未运行时所有 delta 都为空
        const clients = yield* lsp.status()
        if (clients.length === 0) {
          diagnosticSummary = undefined
          output += `\n\nLSP diagnostics unavailable (no language server running). Run bun typecheck to verify type safety.`
        } else {
          // [local-smark] apply_patch 可能覆盖多文件，clean 文案必须指向 changed files 而非单个 file。
          output += `\n\n${LSP.Diagnostic.checkedMessage({ newCount: totalNew, existingCount: totalExisting }, "changed-files")}`
        }
      }

      return {
        title: output,
        metadata: {
          diff: totalDiff,
          files,
          // [local-smark] metadata.diagnostics 存储新错误数组 + diagnosticSummary 聚合摘要
          diagnostics: diagMetadata,
          // summary 缺失时 TUI 不显示 clean，避免与 unavailable output 冲突。
          ...(diagnosticSummary ? { diagnosticSummary } : {}),
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
