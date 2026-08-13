import * as path from "path"
import { Effect, Schema } from "effect"
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
import { applyEdits, EditApplyError, replace as applyExactReplace, type EditReplacement } from "./edit-apply"
import * as Mutation from "./file-mutation-coordinator"
import * as Truncate from "./truncate"

/**
 * 兼容导出：单点替换 = applyEdits 单元素，保证测试与外部调用仍见 replace API。
 * 禁止在此重实现第二套匹配算法。
 */
export function replace(content: string, oldString: string, newString: string, replaceAll = false): string {
  return applyExactReplace(content, oldString, newString, replaceAll)
}

const EditItem = Schema.Struct({
  oldString: Schema.String.annotate({
    description:
      "Exact text for one targeted replacement. It must be unique in the original file (unless replaceAll) and must not overlap other edits[].oldString in the same call.",
  }),
  newString: Schema.String.annotate({ description: "Replacement text for this targeted edit." }),
  replaceAll: Schema.optional(Schema.Boolean).annotate({
    description: "Replace all occurrences of oldString for this edit (default false)",
  }),
})

export const Parameters = Schema.Struct({
  filePath: Schema.String.annotate({ description: "The absolute path to the file to modify" }),
  edits: Schema.mutable(Schema.Array(EditItem)).annotate({
    description:
      "One or more targeted replacements. Each edit is matched against the original file, not incrementally. Do not include overlapping or nested edits. If two changes touch the same block or nearby lines, merge them into one edit instead.",
  }),
})

export type Parameters = Schema.Schema.Type<typeof Parameters>

/**
 * decode 前折叠 legacy 入参（Pi #2639 教训）：
 * - wire JSON Schema 只广告 filePath + edits[]，避免模型混用双形态
 * - 若 edits 缺失且存在顶层 oldString/newString，折成单元素 edits
 * - 若 edits 已非空，丢弃顶层字段（edits 权威，不 append）
 * - edits 有时被序列化为 JSON 字符串，尽量 parse 成数组
 */
export function prepareEditArguments(input: unknown): unknown {
  if (!input || typeof input !== "object") return input
  const args = { ...(input as Record<string, unknown>) }

  if (typeof args.edits === "string") {
    try {
      const parsed = JSON.parse(args.edits)
      if (Array.isArray(parsed)) args.edits = parsed
    } catch {
      // 非法 JSON 留给 Schema 拒绝，不在此处吞掉错误
    }
  }

  const hasEdits = Array.isArray(args.edits) && args.edits.length > 0
  if (!hasEdits && typeof args.oldString === "string" && typeof args.newString === "string") {
    args.edits = [
      {
        oldString: args.oldString,
        newString: args.newString,
        ...(args.replaceAll === true ? { replaceAll: true } : {}),
      },
    ]
  }

  // edits 权威：丢弃顶层替换字段，避免双形态污染 decode 与历史回放
  delete args.oldString
  delete args.newString
  delete args.replaceAll
  return args
}

function isCreate(edits: EditReplacement[]) {
  return edits.length === 1 && edits[0].oldString === ""
}

export const EditTool = Tool.define(
  "edit",
  Effect.gen(function* () {
    const lsp = yield* LSP.Service
    const afs = yield* AppFileSystem.Service
    const format = yield* Format.Service
    const bus = yield* Bus.Service
    const truncate = yield* Truncate.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      // edit result 已声明 filepath/diff，Revert 不需要扩大到 ambient Patch。
      worktree: "declared",
      prepareArguments: prepareEditArguments,
      execute: (params: Parameters, ctx: Tool.Context) =>
        Effect.gen(function* () {
          if (!params.filePath) {
            throw new Error("filePath is required")
          }
          if (!Array.isArray(params.edits) || params.edits.length === 0) {
            throw new Error("edits must contain at least one replacement.")
          }

          const edits = params.edits as EditReplacement[]
          const instance = yield* InstanceState.context
          const filePath = path.isAbsolute(params.filePath)
            ? params.filePath
            : path.join(instance.directory, params.filePath)

          // INV-06：multi-edit 中禁止空 oldString；仅 length-1 空串表示 create/overwrite。
          // 空白-only 的 oldString 不是 create，会在 applyEdits 的归一化空 needle 检查处失败。
          if (edits.some((e, i) => e.oldString === "" && !(edits.length === 1 && i === 0))) {
            throw new Error("edits[].oldString must not be empty except for a single create/overwrite edit.")
          }

          // [local-smark] 逐条 oldString===newString 不再整批拒绝：identical 条目交由
          // applyEdits 的 locate/唯一性校验与跳写处理，混入真实变化的 batch 按无操作容忍。
          // create+空 newString 语义保持既有拒绝契约（edit.test.ts 锁定），不随逐条容忍放宽。
          if (isCreate(edits) && edits[0].oldString === edits[0].newString) {
            throw new Error("No changes to apply: oldString and newString are identical.")
          }

          // blind edit 门闩：非 create 时要求 session 内已 read/write/edit 过该路径，
          // 防止模型基于过期假设构造 oldString 导致误匹配或静默失败。
          if (!isCreate(edits)) {
            const resolveForCompare = (p: string) => {
              const r = path.resolve(p)
              return process.platform === "win32" ? r.toLowerCase() : r
            }
            const resolvedFilePath = resolveForCompare(filePath)
            const hasTouched = ctx.messages.some(
              (msg) =>
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
            metadata: {
              action_kind: "tool",
              tool: "edit",
              operation: isCreate(edits) ? "create" : "edit",
              edits,
            },
          })

          let diff = ""
          let contentOld = ""
          let contentNew = ""
          let syncInput: { filePath: string; edits: EditReplacement[] } | undefined

          // 先取得与 edits[] proposal 同源的 raw bytes/version；Permission 期间不持有 mutation lock。
          const proposal = yield* Mutation.read(afs, filePath)
          const source = Bom.split(Mutation.decode(proposal))
          // source.text 只供当前 edit-apply owner 使用；coordinator 不知道 edits[] 的匹配规则。
          if (proposal.version.state === "other") {
            if (proposal.version.kind === "Directory") throw new Error(`Path is a directory, not a file: ${filePath}`)
            throw new Error(`Path is not a file: ${filePath}`)
          }

          if (isCreate(edits)) {
            const next = Bom.split(edits[0].newString)
            const desiredBom = source.bom || next.bom
            const existed = proposal.version.state === "file"
            // create/overwrite 继续允许覆盖 unchanged existing file；只有 Permission 后的变化产生 conflict。
            contentOld = source.text
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
            // 旧 edit 的 create/overwrite 语义保留，只有 commit 阶段新增 state recheck。
            yield* Mutation.commit({
              fs: afs,
              expected: [proposal],
              execute: Effect.gen(function* () {
                yield* afs.writeWithDirs(filePath, Bom.join(contentNew, desiredBom))
                if (yield* format.file(filePath)) contentNew = yield* Bom.syncFile(afs, filePath, desiredBom)
                // create+format：若落盘与写入不同，历史 newString 改为最终磁盘内容。
                const finalLF = normalizeLineEndings(contentNew)
                const wroteLF = normalizeLineEndings(next.text)
                syncInput = {
                  filePath,
                  edits: [{ oldString: "", newString: finalLF !== wroteLF ? contentNew : edits[0].newString }],
                }
              }),
            }).pipe(Effect.orDie)
            // commit 成功后才发布 Edited/Updated，Permission reject 或 version conflict 不产生成功事件。
            yield* bus.publish(File.Event.Edited, { file: filePath })
            yield* bus.publish(FileWatcher.Event.Updated, {
              file: filePath,
              event: existed ? "change" : "add",
            })
          } else {
            if (proposal.version.state === "absent") throw new Error(`File ${filePath} not found`)
            contentOld = source.text

            // 匹配在 LF 工作区进行，写回时恢复文件级 CRLF/CR；避免把换行差异当成全文 diff。
            const ending = detectLineEnding(contentOld)
            const baseLF = normalizeLineEndings(contentOld)
            // normalize 只属于 edit-apply owner 的 proposal 阶段，commit 不会重新解释模型输入。
            const editsLF = edits.map((edit) => ({
              oldString: normalizeLineEndings(edit.oldString),
              newString: normalizeLineEndings(edit.newString),
              replaceAll: edit.replaceAll,
            }))

            let applied
            try {
              // 单/多 edit 同一 applyEdits；失败诊断的 closest 只解释，不参与成功替换。
              applied = applyEdits(baseLF, editsLF, filePath)
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error)
              if (message.includes("Could not find") || message.includes("Could not find oldString")) {
                if (!(error instanceof EditApplyError)) throw error
                const probe = editsLF[error.editIndex]
                // owner 已确定失败 edit；缺失内部索引时必须原样失败，不能用首条 edit 猜测。
                if (!probe) throw error
                // closest 只解释这条失败 oldString，不参与 replacement success，也不启动第二 matcher。
                // normalized batch 中前一条 edit 可能已经成功定位，但它不是本次失败的诊断证据。
                // 保持既有 message 前缀不变，新增信息只来自同一主路径返回的 actual candidate。
                const closest = closestWindow(contentOld, convertToLineEnding(probe.oldString, ending))
                throw new Error(
                  message +
                    (closest
                      ? `\n\nClosest match at line ${closest.line}:\n${closest.excerpt}`
                      : "\n\nNo reliable nearby candidate was found. Read the file and retry with exact text."),
                )
              }
              throw error
            }

            contentNew = convertToLineEnding(applied.contentNew, ending)
            const desiredBom = source.bom || Bom.split(contentNew).bom
            contentNew = Bom.split(contentNew).text

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

            // applyEdits 已完成全部匹配与 overlap 校验，coordinator 只负责 stale proposal 防护。
            yield* Mutation.commit({
              fs: afs,
              expected: [proposal],
              execute: Effect.gen(function* () {
                yield* afs.writeWithDirs(filePath, Bom.join(contentNew, desiredBom))
                if (yield* format.file(filePath)) contentNew = yield* Bom.syncFile(afs, filePath, desiredBom)
              }),
            }).pipe(Effect.orDie)
            // diagnostics 在 commit 后执行，LSP 观察到的是已经完成 formatter 的磁盘内容。
            yield* bus.publish(File.Event.Edited, { file: filePath })
            yield* bus.publish(FileWatcher.Event.Updated, {
              file: filePath,
              event: "change",
            })

            // INV-16：成功后始终发完整参数面 { filePath, edits }，
            // processor 用其整表替换 state.input，清掉 stream 遗留的顶层 oldString。
            // actualOld 已在 applyEdits.syncEdits 中；此处只做行尾风格还原便于回放。
            syncInput = {
              filePath,
              edits: applied.syncEdits.map((edit) => ({
                oldString: convertToLineEnding(edit.oldString, ending),
                newString: convertToLineEnding(edit.newString, ending),
                ...(edit.replaceAll === true ? { replaceAll: true as const } : {}),
              })),
            }
          }

          // 共享出口统一重算 diff：此刻两分支的 contentNew 均已同步 commit/formatter 后的
          // 最终磁盘内容，output 的 Changed 段与 metadata.diff 因此共用 post-formatter 真值；
          // 权限请求的预计算 diff 保留在各自 ask 之前，审批预览不受影响（R5）。
          diff = trimDiff(
            createTwoFilesPatch(
              filePath,
              filePath,
              normalizeLineEndings(contentOld),
              normalizeLineEndings(contentNew),
            ),
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

          let output = `Edit applied successfully${edits.length > 1 ? ` (${edits.length} blocks)` : ""}.`
          // [local-smark] 逐条 identical 统计在组装点从 edits 重算（与 applyEdits 收到的
          // LF 归一化判断一致），行尾等值也算 no-op。
          const unchangedEntries = edits.filter(
            (edit) => normalizeLineEndings(edit.oldString) === normalizeLineEndings(edit.newString),
          ).length

          // [local-smark] R-01 变化说明 = 出口 post-formatter diff（-/+ 行即逐条变化），
          // 与 metadata.diff 同串单一真值。output 有物理上限：按与 wrapper 截断同源的
          // limits 做预算纪律——diff/LSP 段可裁剪，末尾 warning 段不可裁剪（B-02b 教训：
          // 通用 head 截断丢尾部 warning），裁剪标记用纯事实句不指向模型不可见通道。
          const { maxLines: limitLines, maxBytes: limitBytes } = yield* truncate.limits()
          const reserveBytes = 2048
          const reserveLines = 10
          const diffBudgetBytes = Math.max(0, limitBytes - reserveBytes)
          const diffBudgetLines = Math.max(0, limitLines - reserveLines)
          let consumedBytes = Buffer.byteLength(output, "utf-8")
          let consumedLines = output.split("\n").length
          if (diff) {
            output += `\n\nChanged:`
            consumedBytes += Buffer.byteLength("\n\nChanged:", "utf-8")
            consumedLines += 3
            const diffLinesArr = diff.split("\n")
            let omitted = 0
            for (const line of diffLinesArr) {
              const size = Buffer.byteLength(line, "utf-8") + 1
              if (consumedLines >= diffBudgetLines || consumedBytes + size > diffBudgetBytes) {
                omitted++
                continue
              }
              output += `\n${line}`
              consumedBytes += size
              consumedLines++
            }
            if (omitted > 0) {
              const marker = `\n… (${omitted} more lines omitted)`
              output += marker
              consumedBytes += Buffer.byteLength(marker, "utf-8")
              consumedLines++
            }
          }

          const normalizedFilePath = AppFileSystem.normalizePath(filePath)
          const beforeIssues = (yield* lsp.diagnostics())[normalizedFilePath] ?? []
          yield* lsp.touchFile(filePath, "document")
          const afterDiagnostics = yield* lsp.diagnostics()
          const currentIssues = afterDiagnostics[normalizedFilePath] ?? []
          const block = LSP.Diagnostic.reportDelta(filePath, currentIssues, beforeIssues)
          const newErrorsArr = LSP.Diagnostic.newErrors(currentIssues, beforeIssues)
          const delta = LSP.Diagnostic.deltaSummary(currentIssues, beforeIssues)
          let diagnosticSummary: typeof delta | undefined = delta
          let lspSection = ""
          if (block) {
            lspSection = `\n\nNew LSP errors introduced by this edit:\n${block}`
            lspSection += `\n\nNote: If this is part of a multi-step edit, some errors may be expected until all changes are complete.`
          } else {
            const clients = yield* lsp.status()
            if (clients.length === 0) {
              diagnosticSummary = undefined
              lspSection = `\n\nLSP diagnostics unavailable (no language server running). Run bun typecheck to verify type safety.`
            } else {
              lspSection = `\n\n${LSP.Diagnostic.checkedMessage(delta, "file")}`
            }
          }
          // LSP 段按剩余预算检查（预留 warning 与标记），宁断示标也不消费 warning 预算。
          if (
            Buffer.byteLength(lspSection, "utf-8") <= limitBytes - consumedBytes - 256 &&
            lspSection.split("\n").length <= limitLines - consumedLines - 2
          ) {
            output += lspSection
          } else if (block) {
            output += `\n\n(Diagnostics omitted: output size limit)`
          }

          // [local-smark] 成功且存在 identical 条目时在最后追加 warning（恒保留，不参与裁剪）：
          // 跳写保证该陈述构造性为真（全 no-op 批次已在批级门失败，到不了这里）。
          if (unchangedEntries > 0) {
            output += `\n\nWarning: ${unchangedEntries} of ${edits.length} edit(s) were no-ops (oldString equals newString) and did not change the file.`
          }

          return {
            metadata: {
              diagnostics: { [normalizedFilePath]: newErrorsArr },
              ...(diagnosticSummary ? { diagnosticSummary } : {}),
              diff,
              filediff,
              // processor 消费后 strip；覆盖 state.input 为 ground-truth edits
              ...(syncInput ? { _syncInput: syncInput } : {}),
            },
            title: `${path.relative(instance.worktree, filePath)}`,
            output,
          }
        }).pipe(Effect.orDie),
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
