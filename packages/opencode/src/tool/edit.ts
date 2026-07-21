import * as path from "path"
// #518：私有 Semaphore 锁移除——edit/write/apply_patch 共享 file-mutation-coordinator
import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { LSP } from "@/lsp/lsp"
import { createTwoFilesPatch, diffLines } from "diff"
import DESCRIPTION from "./edit.txt"
import { FileSystem } from "@opencode-ai/core/filesystem"
import { Watcher } from "@opencode-ai/core/filesystem/watcher"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Format } from "../format"
import { InstanceState } from "@/effect/instance-state"
import { Snapshot } from "@/snapshot"
import { assertExternalDirectoryEffect } from "./external-directory"
import { FSUtil } from "@opencode-ai/core/fs-util"
import * as Bom from "@/util/bom"
import { convertToLineEnding, detectLineEnding, normalizeLineEndings } from "@/util/line-ending"
import { closestMatch } from "@opencode-ai/core/tool/edit-excerpt"
import { EditApply } from "@opencode-ai/core/tool/edit-apply"
// #518：共享 mutation coordinator（proposal 版本耦合 + Permission 后持锁 + 提交前 recheck）
import * as Mutation from "./file-mutation-coordinator"
// #131：行尾逻辑收敛到 util/line-ending（含 CR-only）

// 既有单条导出仍委托共享引擎，不保留第二套匹配实现。
export function replace(content: string, oldString: string, newString: string, replaceAll = false): string {
  return EditApply.replace(content, oldString, newString, replaceAll)
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

// 只在原 decode 入口折叠旧形态，Native codec 复用同一个函数。
export function prepareEditArguments(input: unknown): unknown {
  return EditApply.prepareEditArguments(input)
}

function isCreate(edits: EditApply.EditReplacement[]) {
  return edits.length === 1 && edits[0].oldString === ""
}

export const EditTool = Tool.define(
  "edit",
  Effect.gen(function* () {
    const lsp = yield* LSP.Service
    const afs = yield* FSUtil.Service
    const format = yield* Format.Service
    const events = yield* EventV2Bridge.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      prepareArguments: prepareEditArguments,
      execute: (params: Parameters, ctx: Tool.Context) =>
        Effect.gen(function* () {
          if (!params.filePath) {
            throw new Error("filePath is required")
          }

          if (!Array.isArray(params.edits) || params.edits.length === 0) {
            throw new Error("edits must contain at least one replacement.")
          }

          const edits = params.edits
          const instance = yield* InstanceState.context
          const filePath = path.isAbsolute(params.filePath)
            ? params.filePath
            : path.join(instance.directory, params.filePath)

          // #514 INV-06：multi-edit 中禁止空 oldString；仅 length-1 空串表示 create。
          // 空白-only 的 oldString 不是 create，会在 applyEdits 的归一化空 needle 检查处失败。
          if (edits.some((e, i) => e.oldString === "" && !(edits.length === 1 && i === 0))) {
            throw new Error("edits[].oldString must not be empty except for a single create/overwrite edit.")
          }

          for (const edit of edits) {
            if (edit.oldString === edit.newString && edit.oldString !== "") {
              throw new Error("No changes to apply: oldString and newString are identical.")
            }
          }
          if (isCreate(edits) && edits[0].oldString === edits[0].newString) {
            throw new Error("No changes to apply: oldString and newString are identical.")
          }

          // [local-smark] blind edit 门闩：非 create 时要求 session 内已 read/write/edit 过该路径，
          // 防止模型基于过期假设构造 oldString 导致误匹配或静默失败。
          // Windows 下 NTFS 大小写不敏感需 toLowerCase；Linux/macOS 保持大小写敏感。
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

          // #210：携带 edit 操作意图让 Auto reviewer 基于工具证据而非仅外部路径 glob 判断
          yield* assertExternalDirectoryEffect(ctx, filePath, {
            metadata: {
              action_kind: "tool",
              tool: "edit",
              // #514：operation 由 edits 形态推导；完整 edits 数组随证据传递
              operation: isCreate(edits) ? "create" : "edit",
              edits,
            },
          })

          let diff = ""
          let contentOld = ""
          let contentNew = ""
          // #514 INV-16：成功后的历史真值（整参数面 { filePath, edits }），由 processor 整表替换 state.input
          let syncInput: { filePath: string; edits: EditApply.EditReplacement[] } | undefined

          // #518：先取得与 edits[] proposal 同源的 raw bytes/version；Permission 期间不持有 mutation lock。
          // #518：锁不覆盖 ask：同文件第二个 proposal 仍可完成审批，冲突在 commit recheck 显式化。
          const proposal = yield* Mutation.read(afs, filePath)
          // source.text 只供当前 edit-apply owner 使用；coordinator 不知道 edits[] 的匹配规则。
          const source = Bom.split(Mutation.decode(proposal))
          if (proposal.version.state === "other") {
            if (proposal.version.kind === "Directory") throw new Error(`Path is a directory, not a file: ${filePath}`)
            throw new Error(`Path is not a file: ${filePath}`)
          }

          if (isCreate(edits)) {
            // 目标基线语义保留：已存在文件禁止空 oldString 覆盖（上游比源 overwrite 更强的防盲写边界，
            // 0514 record 已裁定；#518 只在 create 分支叠加 coordinator recheck，不放宽该边界）。
            if (proposal.version.state === "file") {
              throw new Error(
                "oldString cannot be empty when editing an existing file. Provide the exact text to replace, or use write for an intentional full-file replacement.",
              )
            }
            const next = Bom.split(edits[0].newString)
            const desiredBom = next.bom
            contentOld = ""
            contentNew = next.text
            diff = trimDiff(
              // #131：ask 元数据 diff 忽略纯行尾差异
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
            // #518：Permission 后才进入 commit；absent→已存在等中途变化由 recheck 拒绝。
            // #518：create 的 expected 是 absent 标签；外部在 ask 窗口内创建空文件也会触发 version 冲突。
            yield* Mutation.commit({
              fs: afs,
              expected: [proposal],
              execute: Effect.gen(function* () {
                // #518：写盘与 formatter 回写都在锁内；中途失败由 ensuring 释放锁而不是留下半写状态。
                yield* afs.writeWithDirs(filePath, Bom.join(contentNew, desiredBom))
                if (yield* format.file(filePath)) contentNew = yield* Bom.syncFile(afs, filePath, desiredBom)
              }),
            }).pipe(Effect.orDie)
            // #514 create+format：若落盘与写入不同，历史 newString 改为最终磁盘内容。
            const finalLF = normalizeLineEndings(contentNew)
            const wroteLF = normalizeLineEndings(next.text)
            syncInput = {
              filePath,
              edits: [{ oldString: "", newString: finalLF !== wroteLF ? contentNew : edits[0].newString }],
            }
            // commit 成功后才发布 Edited/Updated；Permission reject 或 version conflict 不产生成功事件。
            yield* events.publish(FileSystem.Event.Edited, { file: filePath })
            yield* events.publish(Watcher.Event.Updated, {
              file: filePath,
              event: "add",
            })
          } else {
            // #518：absent 只允许 create 分支；edit 分支要求 proposal 时已是文件。
            if (proposal.version.state === "absent") throw new Error(`File ${filePath} not found`)
            contentOld = source.text

              // #514：匹配在 LF 工作区进行，写回时恢复文件级 CRLF/CR；避免把换行差异当成全文 diff。
              const ending = detectLineEnding(contentOld)
              const baseLF = normalizeLineEndings(contentOld)
              const editsLF = edits.map((edit) => ({
                oldString: normalizeLineEndings(edit.oldString),
                newString: normalizeLineEndings(edit.newString),
                replaceAll: edit.replaceAll,
              }))

              let applied
              try {
                // #514：单/多 edit 同一 applyEdits；失败诊断的 closest 只解释，不参与成功替换。
                applied = EditApply.applyEdits(baseLF, editsLF, filePath)
              } catch (error) {
                const message = error instanceof Error ? error.message : String(error)
                if (message.includes("Could not find") || message.includes("Could not find oldString")) {
                  // 失败索引来自共享替换owner，不能重新扫描成功条目猜测失败归属。
                  if (!(error instanceof EditApply.EditApplyError)) throw error
                  const probe = editsLF[error.editIndex]
                  // 缺失内部索引时必须原样失败，不能用首条 edit 猜测。
                  if (!probe) throw error
                  // 只展示同一DP返回的actual，归一化成功的前项不应出现在本次诊断。
                  const closest = closestMatch(contentOld, convertToLineEnding(probe.oldString, ending))
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

              // #518：applyEdits 已完成全部匹配与 overlap 校验，coordinator 只负责 stale proposal 防护。
              // #518：匹配基于 proposal bytes；另一 mutation 先提交时这里整体失败，绝不重新匹配新内容。
              yield* Mutation.commit({
                fs: afs,
                expected: [proposal],
                execute: Effect.gen(function* () {
                  // #518：写盘沿用既有顺序（内容→format→BOM 回写）；锁内完成才发布 change 事件。
                  yield* afs.writeWithDirs(filePath, Bom.join(contentNew, desiredBom))
                  if (yield* format.file(filePath)) contentNew = yield* Bom.syncFile(afs, filePath, desiredBom)
                }),
              }).pipe(Effect.orDie)
              // commit 成功后才发布 Edited/Updated，Permission reject 或 version conflict 不产生成功事件。
              yield* events.publish(FileSystem.Event.Edited, { file: filePath })
              yield* events.publish(Watcher.Event.Updated, {
                file: filePath,
                event: "change",
              })
              // #518：成功后 diff 用锁内最终内容生成；与 write 一致，不展示 proposal 时的中间估计。
              diff = trimDiff(
                createTwoFilesPatch(
                  filePath,
                  filePath,
                  normalizeLineEndings(contentOld),
                  normalizeLineEndings(contentNew),
                ),
              )

              // #514 INV-16：成功后始终发完整参数面 { filePath, edits }，
              // processor 用其整表替换 state.input，清掉 stream 遗留的顶层 oldString。
              // actualOld 已在 applyEdits.syncEdits 中（历史 needle，非 preserve 整行块）；
              // 此处只做行尾风格还原便于回放。
              syncInput = {
                filePath,
                edits: applied.syncEdits.map((edit) => ({
                  oldString: convertToLineEnding(edit.oldString, ending),
                  newString: convertToLineEnding(edit.newString, ending),
                  ...(edit.replaceAll === true ? { replaceAll: true as const } : {}),
                })),
              }
            }

          const diffOld = normalizeLineEndings(contentOld)
          const diffNew = normalizeLineEndings(contentNew)
          // #131：统计增删行时忽略行尾风格
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

          // #514：多块编辑成功回执标注块数，与单块形态区分
          let output = `Edit applied successfully${edits.length > 1 ? ` (${edits.length} blocks)` : ""}.`
          const normalizedFilePath = FSUtil.normalizePath(filePath)
          // [local-smark] baseline 在写入后、touch 前采集：LSP 此时还不知道新内容
          const beforeIssues = (yield* lsp.diagnostics())[normalizedFilePath] ?? []
          yield* lsp.touchFile(filePath, "document")
          const afterDiagnostics = yield* lsp.diagnostics()
          const currentIssues = afterDiagnostics[normalizedFilePath] ?? []
          const block = LSP.Diagnostic.reportDelta(filePath, currentIssues, beforeIssues)
          // [local-smark] 新错误数组和摘要供 TUI 渲染
          const newErrorsArr = LSP.Diagnostic.newErrors(currentIssues, beforeIssues)
          const delta = LSP.Diagnostic.deltaSummary(currentIssues, beforeIssues)
          // summary 只有在 LSP 可靠可用时才传给 TUI，避免 unavailable 时出现绿色 clean
          let diagnosticSummary: typeof delta | undefined = delta
          if (block) {
            output += `\n\nNew LSP errors introduced by this edit:\n${block}`
            output += `\n\nNote: If this is part of a multi-step edit, some errors may be expected until all changes are complete.`
          } else {
            // [local-smark] delta 空 ≠ LSP 验证通过：LSP 未运行时
            // baseline 和 current 都为空，delta 必然为空
            const clients = yield* lsp.status()
            if (clients.length === 0) {
              diagnosticSummary = undefined
              output += `\n\nLSP diagnostics unavailable (no language server running). Run bun typecheck to verify type safety.`
            } else {
              // [local-smark] 只输出一行检查结果，不展开既有错误详情，保持反馈高信噪比
              output += `\n\n${LSP.Diagnostic.checkedMessage(delta, "file")}`
            }
          }

          return {
            metadata: {
              // 未连接时不提供clean摘要；差分数据与formatter后的真实diff各自保留。
              diagnostics: { [normalizedFilePath]: newErrorsArr },
              // diagnosticSummary 缺失代表 LSP 未可靠完成，TUI 不能显示绿色 clean
              ...(diagnosticSummary ? { diagnosticSummary } : {}),
              diff,
              filediff,
              // #514：processor 消费后 strip；覆盖 state.input 为 ground-truth edits
              ...(syncInput ? { _syncInput: syncInput } : {}),
            },
            title: `${path.relative(instance.worktree, filePath)}`,
            output,
          }
          // #518：MutationConflict 等错误通道统一 orDie——coordinator 冲突是诊断性 fail，
          // 与既有 IO 错误同一处理面，不扩大 Tool.define 的 error 泛型。
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
