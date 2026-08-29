import * as path from "path"
// #518：私有 Semaphore 锁移除——edit/write/apply_patch 共享 file-mutation-coordinator
import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { LSP } from "@/lsp/lsp"
import { renderFileDiff } from "./file-diff"
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
// 0576：预算纪律消费 Truncate limits——与 wrapper 通用截断同源，确保末段 warning 不被外层截断丢弃。
import { Truncate } from "./truncate"
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
    // 0576：edit 组装期预算需要 limits；注入一次避免执行期重复解析配置。
    const truncate = yield* Truncate.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      // #557：edit result 已声明 filepath/diff，Revert 不需要扩大到 ambient Patch。
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

          // identical 条目须通过共享引擎定位/唯一性校验后跳写，不能提前否决混合批次。
          // create+空 newString 仍拒绝，不随无操作容忍放宽已有创建边界。
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
          const provenanceRewrites: Array<{
            editIndex: number
            original: { byteLength: number; sha256: string }
          }> = []
          // 该数组只承载本次 Tool 调用的异常覆写事实，不进入参数 Schema，也不改变 edit 成功语义。

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
            // 元数据 diff 走唯一有界 seam（二进制/超限中段改标记表示，ask 预览与最终 metadata 同界）。
            diff = renderFileDiff(filePath, normalizeLineEndings(contentOld), normalizeLineEndings(contentNew)).patch
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
            // create 分支 ending 恒 undefined（existing 覆写在上方被拒），历史只保留 LF 化差异。
            syncInput = {
              filePath,
              // Message history 使用逻辑 LF；物理 CRLF 已由文件 owner 保留，不能泄回模型参数面。
              edits: [
                {
                  oldString: "",
                  newString: finalLF !== wroteLF ? finalLF : normalizeLineEndings(edits[0].newString),
                },
              ],
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
              // ending 只影响 proposal 的物理写回；下面的 editsLF 和 history sync 始终保持逻辑 LF。
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
              // 该转换只服务磁盘写回；diff 与 history 随后再次归一化，避免物理 EOL 重复进入模型视图。
              const desiredBom = source.bom || Bom.split(contentNew).bom
              contentNew = Bom.split(contentNew).text

              // 预计算 diff 供权限预览；有界 seam 保证审批 metadata 不携带无界产物。
              diff = renderFileDiff(filePath, normalizeLineEndings(contentOld), normalizeLineEndings(contentNew)).patch

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
                  if (yield* format.file(filePath)) {
                    const formattedText = yield* Bom.syncFile(afs, filePath, desiredBom)
                    // formatter 的文本变化有效，但 existing edit 的物理行尾仍由 proposal ending 约束。
                    // 恢复和最终读取都留在 commit lock 内，保证 diff、事件与后续 mutation 只见最终文件。
                    const restoredText = convertToLineEnding(normalizeLineEndings(formattedText), ending)
                    if (restoredText !== formattedText) {
                      yield* afs.writeWithDirs(filePath, Bom.join(restoredText, desiredBom))
                    }
                    contentNew = (yield* Bom.readFile(afs, filePath)).text
                  }
                }),
              }).pipe(Effect.orDie)
              // commit 成功后才发布 Edited/Updated，Permission reject 或 version conflict 不产生成功事件。
              yield* events.publish(FileSystem.Event.Edited, { file: filePath })
              yield* events.publish(Watcher.Event.Updated, {
                file: filePath,
                event: "change",
              })
              // 两代共享matcher给出的覆写索引及原LF输入指纹，不能用actual oldString替代提交证据。
              provenanceRewrites.push(...EditApply.provenance(editsLF, applied.normalizedMismatchIndices))

              // #514 INV-16：成功后始终发完整参数面 { filePath, edits }，
              // processor 用其整表替换 state.input，清掉 stream 遗留的顶层 oldString。
              // actualOld 已在 applyEdits.syncEdits 中，history 继续保留模型可回放的 LF logical form。
              syncInput = {
                filePath,
                // normalize 已在 matcher 前完成，因此这里不再把物理 CRLF 写回 Message 参数。
                edits: applied.syncEdits.map((edit) => ({
                  oldString: edit.oldString,
                  newString: edit.newString,
                  ...(edit.replaceAll === true ? { replaceAll: true as const } : {}),
                })),
              }
            }

          // 两分支都已同步 formatter 后的最终内容，回执与 metadata 因此共用同一 diff。
          // 权限请求仍使用各自 ask 前的预计算，不能拿成功后的真值替代审批预览。
          // 元数据 diff 走唯一有界 seam，计数随产物单遍推导（删除原第二遍 diffLines，INV-08 单一权威）。
          const rendered = renderFileDiff(filePath, normalizeLineEndings(contentOld), normalizeLineEndings(contentNew))
          diff = rendered.patch
          const filediff: Snapshot.FileDiff = {
            file: filePath,
            patch: rendered.patch,
            additions: rendered.additions,
            deletions: rendered.deletions,
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
          // [local-smark] 逐条 identical 统计在组装点从 edits 重算（与 applyEdits 收到的
          // LF 归一化判断一致），行尾等值也算 no-op。
          const unchangedEntries = edits.filter(
            (edit) => normalizeLineEndings(edit.oldString) === normalizeLineEndings(edit.newString),
          ).length

          // Changed 使用最终 diff；与 wrapper 同源的限额为 warning 留出位置，避免 head 截断丢尾。
          // 裁剪只陈述省略事实，不指向模型看不到的 metadata 通道。
          const { maxLines: limitLines, maxBytes: limitBytes } = yield* truncate.limits()
          const reserveBytes = 2048
          const reserveLines = 10
          const diffBudgetBytes = Math.max(0, limitBytes - reserveBytes)
          // 预算下限钳 0：limits 配置小于保留额时差分段整体放弃而不是负数比较失效。
          const diffBudgetLines = Math.max(0, limitLines - reserveLines)
          let consumedBytes = Buffer.byteLength(output, "utf-8")
          let consumedLines = output.split("\n").length
          // 差分按行入账而非整体拼接：预算判定必须逐行，中途停止才可能保留 warning 空间。
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

          // 两代复用完整行预算与精确省略数；仅展示预算内摘要，metadata仍保存全部原始取证。
          const warningTail = EditApply.warningTail({ rewrites: provenanceRewrites, unchanged: unchangedEntries, total: edits.length, maxBytes: Math.min(reserveBytes, Math.max(0, limitBytes - consumedBytes)), maxLines: Math.min(reserveLines, Math.max(0, limitLines - consumedLines)), channel: "metadata" })
          const warningBytes = Buffer.byteLength(warningTail, "utf-8")
          const warningLinesCount = warningTail ? warningTail.split("\n").length - 1 : 0

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
          // LSP 段先组装后预算检查：不再直接追加 output，超限时代之以纯事实降级标记。
          let lspSection = ""
          if (block) {
            lspSection = `\n\nNew LSP errors introduced by this edit:\n${block}`
            lspSection += `\n\nNote: If this is part of a multi-step edit, some errors may be expected until all changes are complete.`
          } else {
            // [local-smark] delta 空 ≠ LSP 验证通过：LSP 未运行时
            // baseline 和 current 都为空，delta 必然为空
            const clients = yield* lsp.status()
            if (clients.length === 0) {
              diagnosticSummary = undefined
              lspSection = `\n\nLSP diagnostics unavailable (no language server running). Run bun typecheck to verify type safety.`
            } else {
              // [local-smark] 只输出一行检查结果，不展开既有错误详情，保持反馈高信噪比
              lspSection = `\n\n${LSP.Diagnostic.checkedMessage(delta, "file")}`
            }
          }
          // LSP 段按剩余预算检查（预留 warning 与标记），宁断示标也不消费 warning 预算。
          if (
            Buffer.byteLength(lspSection, "utf-8") <= limitBytes - consumedBytes - warningBytes &&
            lspSection.split("\n").length <= limitLines - consumedLines - warningLinesCount
          ) {
            output += lspSection
            consumedBytes += Buffer.byteLength(lspSection, "utf-8")
            consumedLines += lspSection.split("\n").length - 1
          } else if (block) {
            const omission = `\n\n(Diagnostics omitted: output size limit)`
            if (
              Buffer.byteLength(omission, "utf-8") <= limitBytes - consumedBytes - warningBytes &&
              omission.split("\n").length - 1 <= limitLines - consumedLines - warningLinesCount
            ) {
              output += omission
            }
          }

          // warning 是模型可见的取证摘要；完整 provenance 已在 metadata，尾段只写入预算内的完整行。
          // 即使预算小到无法展示 header，Tool 成功结果也不伪造截断通道；DB metadata 仍是权威记录。
          output += warningTail

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
              // public metadata 在 processor strip 后保留；正常 exact/identical 路径不制造空 provenance。
              ...(provenanceRewrites.length > 0 ? { inputProvenance: { rewrites: provenanceRewrites } } : {}),
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
  // 保留 diff 原始前导空白；公共缩进属于模型需要理解的文件语义，不是可丢弃的装饰。
  return diff
}
