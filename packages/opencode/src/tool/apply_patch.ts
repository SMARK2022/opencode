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
import * as Mutation from "./file-mutation-coordinator"

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
  expected: Mutation.MutationRead[]
}

type HunkGroup = { filePath: string; canonicalPath: string; hunks: Patch.Hunk[] }

// group 代表一个最终 FileChange；它不是把多个 parser entry 当成一个 chunks 数组。
// 这样既能一次 commit，也能保留每个 entry 的 Patch owner 语义。

const processHunkGroup = Effect.fn("ApplyPatchTool.processHunkGroup")(function* (
  group: HunkGroup,
  instance: InstanceContext,
  afs: AppFileSystem.Interface,
) {
  const first = group.hunks[0]
  switch (first.type) {
    case "add": {
      if (group.hunks.length !== 1) throw new Error(`Conflicting operations for ${group.filePath}`)
      const snapshot = yield* Mutation.read(afs, group.filePath)
      // add 的旧 diff 语义继续从空文本计算，但 expected 保留真实 existing/missing state。
      if (snapshot.version.state === "other") throw new Error(`Path is not a file: ${group.filePath}`)
      const oldContent = ""
      const newContent = first.contents.length === 0 || first.contents.endsWith("\n") ? first.contents : `${first.contents}\n`
      const next = Bom.split(newContent)
      const diffOld = normalizeLineEndings(oldContent)
      const diffNew = normalizeLineEndings(next.text)
      const diff = trimDiff(createTwoFilesPatch(group.filePath, group.filePath, diffOld, diffNew))
      const { additions, deletions } = countDiff(diffOld, diffNew)
      // add 保留既有空文本 diff 展示，同时用真实 snapshot 防止 missing/empty 混淆。
      return { filePath: group.filePath, oldContent, newContent: next.text, type: "add" as const, diff, additions, deletions, bom: next.bom, expected: [snapshot] }
    }
    case "update": {
      const snapshot = yield* Mutation.read(afs, group.filePath)
      if (snapshot.version.state !== "file") return yield* Effect.fail(new Error(`Failed to read file to update: ${group.filePath}`))
      // update 只接受 proposal read 观察到的 file state，目录和 missing 不进入 matcher 成功域。
      const source = Bom.split(Mutation.decode(snapshot))
      // source BOM 随 working copy 传给 Patch owner，最终 BOM 仍由既有 Bom contract 决定。
      const oldContent = source.text
      let working = Bom.join(source.text, source.bom)
      let movePath: string | undefined
      let moveCanonicalPath: string | undefined
      try {
        // 每个 parsed Update File entry 独立调用 Patch owner；entry 之间才共享 working copy。
        // 下一 entry 只接收上一 entry 的最终 content，entry 内部生成文本仍由 Patch owner 隔离。
        for (const hunk of group.hunks) {
          if (hunk.type !== "update") throw new Error(`Conflicting operations for ${group.filePath}`)
          const fileUpdate = Patch.deriveNewContentsFromChunks(group.filePath, hunk.chunks, working)
          working = Bom.join(fileUpdate.content, fileUpdate.bom)
          if (hunk.move_path) {
            const nextMovePath = path.resolve(instance.directory, hunk.move_path)
            const nextMoveCanonicalPath = AppFileSystem.resolve(nextMovePath)
            if (moveCanonicalPath && moveCanonicalPath !== nextMoveCanonicalPath) {
              throw new Error(`Conflicting move destinations for ${group.filePath}`)
            }
            movePath = nextMovePath
            moveCanonicalPath = nextMoveCanonicalPath
          }
        }
      } catch (error) {
        // 每个 parsed entry 保留 Patch owner 的 cursor 边界；Tool 只丢弃 working copy，不运行第二套 matcher。
        return yield* Effect.fail(error instanceof Error ? error : new Error(String(error)))
      }
      const next = Bom.split(working)
      const diffOld = normalizeLineEndings(oldContent)
      const diffNew = normalizeLineEndings(next.text)
      const diff = trimDiff(createTwoFilesPatch(group.filePath, group.filePath, diffOld, diffNew))
      const { additions, deletions } = countDiff(diffOld, diffNew)
      const expected = [snapshot]
      if (movePath) {
        // move destination 也是 proposal 的 expected state，不能只锁 source。
        // destination 既要参与 version recheck，也要参与 canonical key 排序。
        const destination = yield* Mutation.read(afs, movePath)
        if (destination.version.state === "other") throw new Error(`Path is not a file: ${movePath}`)
        expected.push(destination)
      }
      return { filePath: group.filePath, oldContent, newContent: next.text, type: movePath ? "move" as const : "update" as const, movePath, diff, additions, deletions, bom: next.bom, expected }
    }
    case "delete": {
      if (group.hunks.length !== 1) throw new Error(`Conflicting operations for ${group.filePath}`)
      const snapshot = yield* Mutation.read(afs, group.filePath)
      if (snapshot.version.state !== "file") return yield* Effect.fail(new Error(`Failed to read file to delete: ${group.filePath}`))
      const source = Bom.split(Mutation.decode(snapshot))
      const diffOld = normalizeLineEndings(source.text)
      const deleteDiff = trimDiff(createTwoFilesPatch(group.filePath, group.filePath, diffOld, ""))
      const { deletions } = countDiff(diffOld, "")
      // delete 的 proposal 只记录 source state；commit 仍在所有 patch target 校验后才执行。
      return { filePath: group.filePath, oldContent: source.text, newContent: "", type: "delete" as const, diff: deleteDiff, additions: 0, deletions, bom: source.bom, expected: [snapshot] }
    }
    default:
      return yield* Effect.fail(new Error(`Unknown hunk type: ${(first as { type: string }).type}`))
  }
})

function countDiff(oldContent: string, newContent: string) {
  let additions = 0
  let deletions = 0
  for (const change of diffLines(oldContent, newContent)) {
    if (change.added) additions += change.count || 0
    if (change.removed) deletions += change.count || 0
  }
  return { additions, deletions }
}

function groupHunks(hunks: Patch.Hunk[], instance: InstanceContext) {
  const groups = new Map<string, HunkGroup>()
  for (const hunk of hunks) {
    const filePath = path.resolve(instance.directory, hunk.path)
    const canonicalPath = AppFileSystem.resolve(filePath)
    const group = groups.get(canonicalPath)
    // realpath alias 归并到同一 source proposal，避免同一文件生成两个完整-file writes。
    // missing leaf 继续使用 resolved fallback，保持 AppFileSystem.resolve 的既有边界。
    if (group) group.hunks.push(hunk)
    else groups.set(canonicalPath, { filePath, canonicalPath, hunks: [hunk] })
  }
  return [...groups.values()]
}

function validateOwnership(groups: HunkGroup[], instance: InstanceContext) {
  const sources = new Set(groups.map((group) => group.canonicalPath))
  const destinations = new Set<string>()
  // source/destination ownership 在 Permission 前解析；锁排序不能替代语义冲突判断。
  for (const group of groups) {
    const first = group.hunks[0]
    const compatible = group.hunks.every((hunk) => hunk.type === first.type) && (first.type === "update" || group.hunks.length === 1)
    // ownership conflict 在 Permission 前拒绝；锁排序只能避免死锁，不能选择语义。
    // 同 source 的 update entry 是唯一允许聚合的组合；add/delete 不凭猜测重建新语义。
    if (!compatible) throw new Error(`Conflicting operations for ${group.filePath}`)
    if (first.type !== "update") continue
    const groupDestinations = new Set<string>()
    for (const hunk of group.hunks) {
      if (hunk.type !== "update") continue
      if (!hunk.move_path) continue
      // move 同时消费 source 并产生 destination，任何交叉 ownership 都会改变另一个操作的结果。
      const destination = AppFileSystem.resolve(path.resolve(instance.directory, hunk.move_path))
      if (
        destination === group.canonicalPath ||
        sources.has(destination) ||
        destinations.has(destination) ||
        (groupDestinations.size > 0 && !groupDestinations.has(destination))
      ) {
        throw new Error(`Conflicting mutation ownership for ${group.filePath}`)
      }
      groupDestinations.add(destination)
    }
    for (const destination of groupDestinations) destinations.add(destination)
  }
}

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
      const fileChanges: FileChange[] = []

      let totalDiff = ""

      // [local-smark] per-file atomicity：收集每个 hunk 的错误而非在第一个失败时立即返回。
      // 成功的 hunk 进入 fileChanges 正常 apply；失败的 hunk 记录 error 在 output 中报告。
      // 仅当全部 hunk 都失败时才返回 Effect.fail（不让空 patch 静默成功）。
      // 用 Effect.exit 捕获每个 hunk 的成功/失败，不中断循环。
      const hunkErrors: string[] = []

      const groups = groupHunks(hunks, instance)
      validateOwnership(groups, instance)
      for (const group of groups) {
        for (const hunk of group.hunks) {
          const filePath = path.resolve(instance.directory, hunk.path)
          yield* assertExternalDirectoryEffect(ctx, filePath, {
            metadata: { action_kind: "tool", tool: "apply_patch", operation: hunk.type, patchText: params.patchText },
          })
          if (hunk.type === "update" && hunk.move_path) {
            const movePath = path.resolve(instance.directory, hunk.move_path)
            yield* assertExternalDirectoryEffect(ctx, movePath, {
              metadata: { action_kind: "tool", tool: "apply_patch", operation: "move", patchText: params.patchText },
            })
          }
        }

        // 同一 source 的所有 entry 共享一次 proposal；失败时只丢弃 working copy。
        const exit = yield* Effect.exit(processHunkGroup(group, instance, afs))
        if (Exit.isFailure(exit)) {
          const err = Cause.squash(exit.cause)
          hunkErrors.push(`${group.filePath}: ${err instanceof Error ? err.message : String(err)}`)
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
      const editedFiles: string[] = []
      const expected = fileChanges.flatMap((change) => change.expected)
      // 所有 source/destination 在这里一次性交给 coordinator，避免逐 change recheck 产生 partial commit。

      yield* Mutation.commit({
        fs: afs,
        expected,
        execute: Effect.gen(function* () {
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

                  yield* afs.writeWithDirs(change.movePath, Bom.join(change.newContent, change.bom))
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
              editedFiles.push(edited)
            }
          }
        }),
      }).pipe(Effect.orDie)

      // Publish file change events
      for (const file of editedFiles) {
        yield* bus.publish(File.Event.Edited, { file })
      }
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
