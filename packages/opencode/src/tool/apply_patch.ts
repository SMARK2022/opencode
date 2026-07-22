import * as path from "path"
import { Cause, Effect, Exit, Schema } from "effect"
import type { InstanceContext } from "../project/instance-context"
import * as Tool from "./tool"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Watcher } from "@opencode-ai/core/filesystem/watcher"
import { InstanceState } from "@/effect/instance-state"
import { Patch } from "../patch"
import { createTwoFilesPatch, diffLines } from "diff"
import { assertExternalDirectoryEffect } from "./external-directory"
import { trimDiff } from "./edit"
import { LSP } from "@/lsp/lsp"
// [local-smark] LSPClient.Diagnostic 类型用于增量诊断 baseline Map 的类型标注
import { LSPClient } from "@/lsp/client"
import { FSUtil } from "@opencode-ai/core/fs-util"
import DESCRIPTION from "./apply_patch.txt"
import { FileSystem } from "@opencode-ai/core/filesystem"
import { Format } from "../format"
import * as Bom from "@/util/bom"
import { normalizeLineEndings } from "@/util/line-ending"
// #518：apply_patch 加入共享 file-mutation coordinator（多文件一次性 commit + 提交前全量 recheck）
import * as Mutation from "./file-mutation-coordinator"
// #131：diff 展示归一行尾，隐藏纯换行变更

// [local-smark] #518：hunk 按 canonicalPath 分组，一组 = 一个 FileChange/proposal。
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

// #518：canonicalPath 是 coordinator 的锁键；filePath 保留 patchText 原始解析结果用于错误与 diff 展示。
// 两者分离后 symlink alias 不会生成第二个锁，展示路径也不被 realpath 改写。

// #533：group 代表一个 canonical source proposal；update entries 会合并 chunks，且只派生一个最终 FileChange。
// add/delete 不合并，避免把同 source 的冲突操作猜成新语义。

const processHunkGroup = Effect.fn("ApplyPatchTool.processHunkGroup")(function* (
  group: HunkGroup,
  instance: InstanceContext,
  afs: FSUtil.Interface,
) {
  const rewrite = group.hunks.length === 2 && group.hunks[0].type === "delete" && group.hunks[1].type === "add"
  const first = rewrite ? group.hunks[1] : group.hunks[0]
  switch (first.type) {
    case "add": {
      // Delete 后 Add 保留原地重写；重复 Add 仍拒绝，不能静默取最后一项。
      if (group.hunks.length !== 1 && !rewrite) throw new Error(`Conflicting operations for ${group.filePath}`)
      const snapshot = yield* Mutation.read(afs, group.filePath)
      // #518：add 的旧 diff 语义继续从空文本计算，但 expected 保留真实 existing/missing state。
      if (snapshot.version.state === "other") throw new Error(`Path is not a file: ${group.filePath}`)
      const oldContent = ""
      // 尾部换行补齐沿用既有 Add File 语义；proposal 不修正用户文本，只保证落盘可 diff。
      const newContent = first.contents.length === 0 || first.contents.endsWith("\n") ? first.contents : `${first.contents}\n`
      const next = Bom.split(newContent)
      const diffOld = normalizeLineEndings(oldContent)
      const diffNew = normalizeLineEndings(next.text)
      const diff = trimDiff(createTwoFilesPatch(group.filePath, group.filePath, diffOld, diffNew))
      const { additions, deletions } = countDiff(diffOld, diffNew)
      // #518：add 保留既有空文本 diff 展示，同时用真实 snapshot 防止 missing/empty 混淆。
      return { filePath: group.filePath, oldContent, newContent: next.text, type: "add" as const, diff, additions, deletions, bom: next.bom, expected: [snapshot] }
    }
    case "update": {
      // #533：canonical source 只读取一个 snapshot，定位与最终 Mutation expected 因而观察同一版本。
      const snapshot = yield* Mutation.read(afs, group.filePath)
      // #518：proposal 阶段就拒绝 missing/目录；不能等 commit recheck 才报错，否则错误会混入 Permission 后失败路径。
      if (snapshot.version.state !== "file") return yield* Effect.fail(new Error(`Failed to read file to update: ${group.filePath}`))
      // #518：update 只接受 proposal read 观察到的 file state，目录和 missing 不进入 matcher 成功域。
      const source = Bom.split(Mutation.decode(snapshot))
      const oldContent = source.text
      let movePath: string | undefined
      let moveCanonicalPath: string | undefined
      let fileUpdate: ReturnType<typeof Patch.deriveNewContentsFromChunks>
      try {
        // #533：canonical group 内全部 chunks 一次交给 Patch owner，entry2 不得读取 entry1 在本次 proposal 生成的文本。
        const chunks = group.hunks.flatMap((hunk) => {
          if (hunk.type !== "update") throw new Error(`Conflicting operations for ${group.filePath}`)
          if (hunk.move_path) {
            const nextMovePath = path.resolve(instance.directory, hunk.move_path)
            const nextMoveCanonicalPath = FSUtil.resolve(nextMovePath)
            // #518：相同 destination 允许重复声明（canonical 等价即可）；不同 destination 无法用单次 move 表达。
            if (moveCanonicalPath && moveCanonicalPath !== nextMoveCanonicalPath) {
              throw new Error(`Conflicting move destinations for ${group.filePath}`)
            }
            movePath = nextMovePath
            moveCanonicalPath = nextMoveCanonicalPath
          }
          return hunk.chunks
        })
        fileUpdate = Patch.deriveNewContentsFromChunks(group.filePath, chunks, Bom.join(source.text, source.bom))
      } catch (error) {
        // #518：每个 parsed entry 保留 Patch owner 的定位边界；Tool 只丢弃 proposal，不运行第二套 matcher。
        return yield* Effect.fail(error instanceof Error ? error : new Error(String(error)))
      }
      const diffOld = normalizeLineEndings(oldContent)
      // #533：diff 与计数都来自单次派生的最终 content，与 commit 写盘观察同一份文本。
      const diffNew = normalizeLineEndings(fileUpdate.content)
      const diff = trimDiff(createTwoFilesPatch(group.filePath, group.filePath, diffOld, diffNew))
      const { additions, deletions } = countDiff(diffOld, diffNew)
      // #518：expected 只包含 source；update 未声明 move 时不锁任何 destination 路径。
      const expected = [snapshot]
      if (movePath) {
        // #518：move destination 也是 proposal 的 expected state，不能只锁 source。
        // destination 既要参与 version recheck，也要参与 canonical key 排序。
        const destination = yield* Mutation.read(afs, movePath)
        if (destination.version.state === "other") throw new Error(`Path is not a file: ${movePath}`)
        expected.push(destination)
      }
      return { filePath: group.filePath, oldContent, newContent: fileUpdate.content, type: movePath ? "move" as const : "update" as const, movePath, diff, additions, deletions, bom: fileUpdate.bom, expected }
    }
    case "delete": {
      // #518：delete 与 add 同理不聚合；重复 Delete entry 无法像 update 那样链式消费。
      if (group.hunks.length !== 1) throw new Error(`Conflicting operations for ${group.filePath}`)
      const snapshot = yield* Mutation.read(afs, group.filePath)
      if (snapshot.version.state !== "file") return yield* Effect.fail(new Error(`Failed to read file to delete: ${group.filePath}`))
      const source = Bom.split(Mutation.decode(snapshot))
      const diffOld = normalizeLineEndings(source.text)
      const deleteDiff = trimDiff(createTwoFilesPatch(group.filePath, group.filePath, diffOld, ""))
      const { deletions } = countDiff(diffOld, "")
      // #518：delete 的 proposal 只记录 source state；commit 仍在所有 patch target 校验后才执行。
      return { filePath: group.filePath, oldContent: source.text, newContent: "", type: "delete" as const, diff: deleteDiff, additions: 0, deletions, bom: source.bom, expected: [snapshot] }
    }
    default:
      // 未知 hunk 类型来自 parser 版本差异；拒绝而不是跳过，避免静默丢 hunk。
      return yield* Effect.fail(new Error(`Unknown hunk type: ${(first as { type: string }).type}`))
  }
})

function countDiff(oldContent: string, newContent: string) {
  // #518：计数与展示用同一对归一后文本（#131），保证 additions/deletions 与用户看到的 diff 一致。
  let additions = 0
  let deletions = 0
  for (const change of diffLines(oldContent, newContent)) {
    if (change.added) additions += change.count || 0
    if (change.removed) deletions += change.count || 0
  }
  return { additions, deletions }
}

function groupHunks(hunks: Patch.Hunk[], instance: InstanceContext) {
  // #533：Tool 只拥有 filesystem identity 与 mutation boundary；old block 语义继续下沉给 Patch owner。
  // #518：分组先于 Permission 与 proposal；Map 保持首次出现顺序，fileChanges 顺序与 patchText 一致。
  const groups = new Map<string, HunkGroup>()
  for (const hunk of hunks) {
    // hunk path 是 instance.directory 相对路径；解析后才能做 canonical 比较。
    const filePath = path.resolve(instance.directory, hunk.path)
    const canonicalPath = FSUtil.resolve(filePath)
    const group = groups.get(canonicalPath)
    // #518：realpath alias 归并到同一 source proposal，避免同一文件生成两个完整-file writes。
    // missing leaf 继续使用 resolved fallback，保持 FSUtil.resolve 的既有边界。
    if (group) group.hunks.push(hunk)
    else groups.set(canonicalPath, { filePath, canonicalPath, hunks: [hunk] })
  }
  return [...groups.values()]
}

function validateOwnership(groups: HunkGroup[], instance: InstanceContext) {
  const sources = new Set(groups.map((group) => group.canonicalPath))
  // #518：destinations 跨 group 全局去重；两个不同 source 指向同一 destination 时没有无损顺序。
  const destinations = new Set<string>()
  // #518：source/destination ownership 在 Permission 前解析；锁排序不能替代语义冲突判断。
  for (const group of groups) {
    const first = group.hunks[0]
    const rewrite = group.hunks.length === 2 && first.type === "delete" && group.hunks[1].type === "add"
    const compatible = rewrite || group.hunks.every((hunk) => hunk.type === first.type) && (first.type === "update" || group.hunks.length === 1)
    // #518：ownership conflict 在 Permission 前拒绝；锁排序只能避免死锁，不能选择语义。
    // 同 source 的 update entry 是唯一允许聚合的组合；add/delete 不凭猜测重建新语义。
    if (!compatible) throw new Error(`Conflicting operations for ${group.filePath}`)
    // add/delete 没有 cursor 链可依赖，聚合只会引入实现猜测；只有 update 进入 destination 检查。
    if (first.type !== "update") continue
    const groupDestinations = new Set<string>()
    for (const hunk of group.hunks) {
      if (hunk.type !== "update") continue
      if (!hunk.move_path) continue
      // #518：move 同时消费 source 并产生 destination，任何交叉 ownership 都会改变另一个操作的结果。
      const destination = FSUtil.resolve(path.resolve(instance.directory, hunk.move_path))
      if (
        destination === group.canonicalPath ||
        sources.has(destination) ||
        destinations.has(destination) ||
        // #518：同 group 内允许重复声明同一 destination（含 canonical 等价 alias），但不得切换目标。
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
    const afs = yield* FSUtil.Service
    const format = yield* Format.Service
    const events = yield* EventV2Bridge.Service

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

      // #518：先按 canonicalPath 分组并在 Permission 前拒绝 ownership 冲突。
      // 冲突 patch 不得进入 ask；被批准后再失败会浪费一次审批并污染 always 授权记录。
      const groups = groupHunks(hunks, instance)
      validateOwnership(groups, instance)
      for (const group of groups) {
        for (const hunk of group.hunks) {
          const filePath = path.resolve(instance.directory, hunk.path)
          // #210：external_directory 门禁先于最终 edit 权限，携带 patch 意图让 Auto reviewer 判断的不仅是路径
          yield* assertExternalDirectoryEffect(ctx, filePath, {
            metadata: { action_kind: "tool", tool: "apply_patch", operation: hunk.type, patchText: params.patchText },
          })
          // #518：move 断言从 processSingleHunk 内移到调用方循环，proposal 阶段不再持 ctx。
          if (hunk.type === "update" && hunk.move_path) {
            const movePath = path.resolve(instance.directory, hunk.move_path)
            yield* assertExternalDirectoryEffect(ctx, movePath, {
              metadata: { action_kind: "tool", tool: "apply_patch", operation: "move", patchText: params.patchText },
            })
          }
        }

        // #518：同一 source 的所有 entry 共享一次 proposal；失败时只丢弃 working copy。
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
      // #518：move 的展示路径指向 destination；UI 与 permission 看到的是最终落盘位置。
      const files = fileChanges.map((change) => ({
        filePath: change.filePath,
        relativePath: path.relative(instance.worktree, change.movePath ?? change.filePath).replaceAll("\\", "/"),
        type: change.type,
        patch: change.diff,
        additions: change.additions,
        deletions: change.deletions,
        ...(change.movePath ? { movePath: change.movePath } : {}),
      }))

      // Check permissions if needed
      // #518：patterns 仍按 source 相对路径授权；move 的 destination 已通过 external gate 单独校验。
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
      // #518：updates/editedFiles 在 execute 内填充、commit 成功后才发布；冲突路径不会留下半套事件。
      const updates: Array<{ file: string; event: "add" | "change" | "unlink" }> = []
      const editedFiles: string[] = []
      const expected = fileChanges.flatMap((change) => change.expected)
      // #518：所有 source/destination 在这里一次性交给 coordinator，避免逐 change recheck 产生 partial commit。
      // expected 保持 proposal 顺序；coordinator 内部按 canonical 字典序加锁，顺序不影响正确性。

      // #518：commit 失败只能是 MutationConflict（orDie 转为 defect）；错误工具语义仍由 run 外层统一呈现。
      yield* Mutation.commit({
        fs: afs,
        expected,
        execute: Effect.gen(function* () {
          for (const change of fileChanges) {
            const edited = change.type === "delete" ? undefined : (change.movePath ?? change.filePath)
            switch (change.type) {
              case "add":
                // Create parent directories (recursive: true is safe on existing/root dirs)

                // #518：写盘在全部 target recheck 之后才发生；任一 target 冲突时这里一步都不会执行。
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

                  // #518：move 的 source/destination 都在 expected 内；两键全部 recheck 通过后才先写后删。
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
              // #518：formatter 与 BOM 回写留在 commit critical section 内，避免另一 mutation 在格式化中途读盘。
              if (yield* format.file(edited)) {
                yield* Bom.syncFile(afs, edited, change.bom)
              }
              editedFiles.push(edited)
            }
          }
        }),
      }).pipe(Effect.orDie)

      // Publish file change events
      // #518：事件在 commit 成功后发布，version conflict 不产生成功事件。
      for (const file of editedFiles) {
        yield* events.publish(FileSystem.Event.Edited, { file })
      }
      for (const update of updates) {
        yield* events.publish(Watcher.Event.Updated, update)
      }

      // [local-smark] baseline 在 patch 落盘后、touch 前采集：LSP 此时还不知道新内容。
      const beforeAll = yield* lsp.diagnostics()
      const baselines = new Map<string, LSPClient.Diagnostic[]>()
      for (const change of fileChanges) {
        if (change.type === "delete") continue
        const target = change.movePath ?? change.filePath
        const normalized = FSUtil.normalizePath(target)
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
      // summary 标记与 git status 一致：A/D/M；move 显示 destination，删除不显示 target。
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

      let lspFoundNewErrors = false
      let totalNew = 0
      let totalExisting = 0
      const diagMetadata: Record<string, LSPClient.Diagnostic[]> = {}

      // [local-smark] 逐文件计算增量诊断，只显示本次 patch 新引入的错误
      for (const change of fileChanges) {
        if (change.type === "delete") continue
        const target = change.movePath ?? change.filePath
        const normalized = FSUtil.normalizePath(target)
        const currentIssues = afterAll[normalized] ?? []
        const fileBaseline = baselines.get(normalized) ?? []
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
      // [local-smark] summary 只在 LSP 可靠可用时传给 TUI；unavailable 时缺失字段
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
          // [local-smark] apply_patch 可能覆盖多文件，clean 文案必须指向 changed files
          output += `\n\n${LSP.Diagnostic.checkedMessage({ newCount: totalNew, existingCount: totalExisting }, "changed-files")}`
        }
      }

      return {
        title: output,
        metadata: {
          diff: totalDiff,
          files,
          // 未连接不能报告clean；保留差分数据供历史显示，不将空结果当验证成功。
          diagnostics: diagMetadata,
          // summary 缺失时 TUI 不显示 clean，避免与 unavailable output 冲突
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
