import { Schema } from "effect"
import * as path from "path"
import { Effect } from "effect"
import * as Tool from "./tool"
import { LSP } from "@/lsp/lsp"
import DESCRIPTION from "./write.txt"
import { EventV2Bridge } from "@/event-v2-bridge"
import { FileSystem } from "@opencode-ai/core/filesystem"
import { Watcher } from "@opencode-ai/core/filesystem/watcher"
import { Format } from "../format"
import { boundDiff } from "./file-diff"
import { Truncate } from "./truncate"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { InstanceState } from "@/effect/instance-state"
import { renderFileDiff } from "./file-diff"
import { assertExternalDirectoryEffect } from "./external-directory"
import * as Bom from "@/util/bom"
import { normalizeLineEndings } from "@/util/line-ending"
import { convertToLineEnding, detectLineEnding } from "@/util/line-ending"
// #518：write 参与共享 file-mutation coordinator——proposal 版本耦合 + Permission 后持锁 + 提交前 recheck
import * as Mutation from "./file-mutation-coordinator"
// #131：write 元数据 diff 归一行尾

export const Parameters = Schema.Struct({
  content: Schema.String.annotate({ description: "The content to write to the file" }),
  filePath: Schema.String.annotate({
    description: "The absolute path to the file to write (must be absolute, not relative)",
  }),
})

export const WriteTool = Tool.define(
  "write",
  Effect.gen(function* () {
    const lsp = yield* LSP.Service
    const fs = yield* FSUtil.Service
    const events = yield* EventV2Bridge.Service
    const format = yield* Format.Service
    const truncate = yield* Truncate.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      // #557：write 的单一 filePath 是精确归属，不认领并发 worktree 变化。
      worktree: "declared",
      execute: (params: { content: string; filePath: string }, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const filepath = path.isAbsolute(params.filePath)
            ? params.filePath
            : path.join(instance.directory, params.filePath)
          // #210：write 负载意图先于后续 edit 权限 diff 存在，否则 external_directory 仅凭路径无法授权
          yield* assertExternalDirectoryEffect(ctx, filepath, {
            metadata: { action_kind: "tool", tool: "write", operation: "write", content: params.content },
          })

          // #518：write proposal 使用同一次 raw read 捕获 expected state，避免 Permission 后提交旧内容。
          const proposal = yield* Mutation.read(fs, filepath)
          // #518：目录等 other 状态在 Permission 前拒绝；让 ask 展示这类错误只会制造必然失败的审批。
          if (proposal.version.state === "other") {
            if (proposal.version.kind === "Directory") throw new Error(`Path is a directory, not a file: ${filepath}`)
            throw new Error(`Path is not a file: ${filepath}`)
          }
          const exists = proposal.version.state === "file"
          const source = Bom.split(Mutation.decode(proposal))
          // #518：exists 只表示 proposal 时的 file state；commit recheck 仍以 tagged version 为准。
          const next = Bom.split(params.content)
          const desiredBom = source.bom || next.bom
          const contentOld = source.text
          const ending = exists ? detectLineEnding(contentOld) : undefined
          // ending 取自 Permission 前同一 proposal，避免审批期间补读把版本事实与属性事实拆开。
          // contentNew 只转换已有文件，防止“继承属性”误变成新文件的隐式默认格式。
          // 模型提交的是逻辑行；已有文件的行尾属于 proposal 磁盘属性，不能被 overwrite 参数偶然翻转。
          // 新文件没有可继承属性，继续逐字采用提交内容，避免 write 对创建行为施加全局 EOL 策略。
          const contentNew = ending ? convertToLineEnding(normalizeLineEndings(next.text), ending) : next.text

          // 元数据 diff 走唯一有界 seam：ask 预览与最终 metadata 同界（二进制/超限中段改标记表示）。
          // #518：diff 基于 proposal 时的旧内容；ask 展示的是本次写入的意图而非磁盘实时状态。
          const rendered = renderFileDiff(filepath, normalizeLineEndings(contentOld), normalizeLineEndings(contentNew))
          const diff = rendered.patch
          yield* ctx.ask({
            permission: "edit",
            patterns: [path.relative(instance.worktree, filepath)],
            always: ["*"],
            metadata: {
              filepath,
              diff,
            },
          })

          let formatted = false
          let finalSource: { bom: boolean; text: string } | undefined
          // #518：formatter 仍在同一 commit critical section，避免第二个 mutation 看到半完成内容。
          // #518：expected 只带一个 proposal；write 的 expected state 就是目标路径本身的 tagged version。
          yield* Mutation.commit({
            fs,
            expected: [proposal],
            execute: Effect.gen(function* () {
              // #518：recheck 通过后写盘；外部 writer 在 ask 窗口内创建/修改文件会在这里被拒绝。
              yield* fs.writeWithDirs(filepath, Bom.join(contentNew, desiredBom))
              // [local-smark] 捕获 format 是否运行，用于后续判断是否需要检测内容变化
              formatted = yield* format.file(filepath)
              if (formatted) {
                const formattedText = yield* Bom.syncFile(fs, filepath, desiredBom)
                // formatter 拥有文本格式化结果，但已有文件的行尾仍由 proposal 决定；两者在此合成唯一磁盘真值。
                // 还原留在 commit lock 内，避免事件、diff 或另一个 mutation 观察到 formatter 的临时 LF 文件。
                const restoredText = ending
                  ? convertToLineEnding(normalizeLineEndings(formattedText), ending)
                  : formattedText
                // new file 没有 ending 时 formatter 输出直接成为最终文本，不引入仓库级默认策略。
                if (restoredText !== formattedText) {
                  yield* fs.writeWithDirs(filepath, Bom.join(restoredText, desiredBom))
                }
                // metadata 必须来自还原后的实际文件，不能沿用 formatter 读取或内存推导的中间视图。
                finalSource = yield* Bom.readFile(fs, filepath)
                return
              }
              if (exists) finalSource = yield* Bom.readFile(fs, filepath)
            }),
          }).pipe(Effect.orDie)
          // 覆写已有文件时，基于格式化后的最终落盘内容生成 diff，供 TUI 以 git diff 形式展示
          // 格式化后的最终内容：格式化可能改变文件内容，因此基于最终落盘内容生成 diff
          // [local-smark] 当 auto-format 改变了写入内容时，将格式化后的内容
          // 通过 metadata._formattedContent 传递给 processor。
          // processor 的 completeToolCall 会用它直接覆盖 state.input.content，
          // 使 DB 中持久化的 input 就是磁盘上的实际内容（格式化后），
          // 后续上下文重放时模型看到的内容与磁盘一致。
          // 用 normalizeLineEndings 比较避免 CRLF/LF 差异导致 false positive。
          // 覆写和新文件都检查：新文件也可能被 formatter 改变内容。
          let metadataDiff: string | undefined
          let formattedContent: string | undefined
          // 显式计数与最终patch同源，摄入端不能从不含增删正文的标记重新推导为0/0。
          let diffCounts: { additions: number; deletions: number } | undefined
          // #518：finalSource 只在锁内赋值；冲突失败时保持 undefined，不生成误导性 metadata。
          if (finalSource) {
            if (exists) {
              // 覆写仍取锁内最终文本，不能复用格式化前审批结果。
              const overwrite = renderFileDiff(
                filepath,
                normalizeLineEndings(contentOld),
                normalizeLineEndings(finalSource.text),
              )
              metadataDiff = overwrite.patch
              diffCounts = { additions: overwrite.additions, deletions: overwrite.deletions }
            } else {
              // 格式化新文件的diff必须取最终落盘文本，不能漏记或回用格式化前内容。
              const created = renderFileDiff(filepath, "", normalizeLineEndings(finalSource.text))
              metadataDiff = created.patch
              diffCounts = { additions: created.additions, deletions: created.deletions }
            }
            // 仅在格式化确实改变了内容时设置，避免无谓的 input 覆盖
            if (formatted && normalizeLineEndings(finalSource.text) !== normalizeLineEndings(contentNew)) {
              formattedContent = finalSource.text
            }
          } else {
            // 未格式化的新文件复用写前diff；该分支属于外层最终内容判断。
            metadataDiff = diff
            diffCounts = { additions: rendered.additions, deletions: rendered.deletions }
          }
          yield* events.publish(FileSystem.Event.Edited, { file: filepath })
          yield* events.publish(Watcher.Event.Updated, {
            file: filepath,
            event: exists ? "change" : "add",
          })

          let output = "Wrote file successfully."
          const normalizedFilepath = FSUtil.normalizePath(filepath)
          // [local-smark] baseline 在写入后、touch 前采集：LSP 此时还不知道新内容
          const beforeIssues = (yield* lsp.diagnostics())[normalizedFilepath] ?? []
          yield* lsp.touchFile(filepath, "document")
          const afterDiagnostics = yield* lsp.diagnostics()
          const currentIssues = afterDiagnostics[normalizedFilepath] ?? []
          const block = LSP.Diagnostic.reportDelta(filepath, currentIssues, beforeIssues)
          // [local-smark] 新错误数组和摘要供 TUI 渲染
          const newErrorsArr = LSP.Diagnostic.newErrors(currentIssues, beforeIssues)
          const delta = LSP.Diagnostic.deltaSummary(currentIssues, beforeIssues)
          // summary 只有在 LSP 可靠可用时才传给 TUI
          // INV-06/G04：formatter 实际改变内容时，回显「提交内容→最终落盘」的差异段，
          // 否则模型记忆中的写入与磁盘真值分叉（后续 edit 凭意图文本构造 oldString 必败）。
          // 未改变时本段整体缺席（常态零成本：新建文件的 full diff 与提交内容重复，不回显）。
          if (formattedContent !== undefined) {
            const delta = renderFileDiff(
              filepath,
              normalizeLineEndings(contentNew),
              normalizeLineEndings(formattedContent),
            ).patch
            const limits = yield* truncate.limits()
            const bounded = boundDiff(delta, {
              maxLines: Math.max(0, limits.maxLines - 10),
              maxBytes: Math.max(0, limits.maxBytes - 2048),
            })
            output += `\n\nFormatted changes (auto-format adjusted the file):\n${bounded.text}`
            if (bounded.omitted > 0) {
              const artifact = yield* truncate.write(delta)
              output += `\n… (${bounded.omitted} more lines omitted; full diff written to ${artifact})`
            }
          }
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
              // [local-smark] LSP 已运行且 delta 为空时给短确认，避免模型误判 LSP 未工作
              output += `\n\n${LSP.Diagnostic.checkedMessage(delta, "file")}`
            }
          }

          return {
            title: path.relative(instance.worktree, filepath),
            metadata: {
              // [local-smark] diagnostics 存新错误数组（delta）+ diagnosticSummary
              // 无活动client的空差分不证明检查成功，不能发出clean摘要。
              diagnostics: { [normalizedFilepath]: newErrorsArr },
              // diagnosticSummary 缺失代表 LSP 未可靠完成，TUI 不能显示绿色 clean
              ...(diagnosticSummary ? { diagnosticSummary } : {}),
              filepath,
              exists,
              // 条件展开：仅在 metadataDiff 存在时展开 diff 字段，避免 undefined 污染 metadata
              ...(metadataDiff !== undefined ? { diff: metadataDiff } : {}),
              // 摄入端优先消费显式计数（plan B-02）；有界标记不再被重扫描成 0/0。
              ...(diffCounts ? { additions: diffCounts.additions, deletions: diffCounts.deletions } : {}),
              // _formattedContent 由 processor 的 completeToolCall 消费：
              // 覆盖 state.input.content 后从此 metadata 中 strip，不持久化
              ...(formattedContent !== undefined ? { _formattedContent: formattedContent } : {}),
              // formattedChanged 持久化（_formattedContent 会被 strip，历史上无法观测
              // formatter 命中率）；只作事实标记，不参与后续判定。
              ...(formattedContent !== undefined ? { formattedChanged: true } : {}),
            },
            output,
          }
        }).pipe(Effect.orDie),
    }
  }),
)
