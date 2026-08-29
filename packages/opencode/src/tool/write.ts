import { Schema } from "effect"
import * as path from "path"
import { Effect } from "effect"
import * as Tool from "./tool"
import { LSP } from "@/lsp/lsp"
import DESCRIPTION from "./write.txt"
import { Bus } from "../bus"
import { File } from "../file"
import { FileWatcher } from "../file/watcher"
import { Format } from "../format"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { InstanceState } from "@/effect/instance-state"
import { renderFileDiff } from "./file-diff"
import { assertExternalDirectoryEffect } from "./external-directory"
import * as Bom from "@/util/bom"
import { convertToLineEnding, detectLineEnding, normalizeLineEndings } from "@/util/line-ending"
import * as Mutation from "./file-mutation-coordinator"

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
    const fs = yield* AppFileSystem.Service
    const bus = yield* Bus.Service
    const format = yield* Format.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      // write 的单一 filePath 是精确归属，不认领并发 worktree 变化。
      worktree: "declared",
      execute: (params: { content: string; filePath: string }, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const filepath = path.isAbsolute(params.filePath)
            ? params.filePath
            : path.join(instance.directory, params.filePath)
          yield* assertExternalDirectoryEffect(ctx, filepath, {
            // Auto review needs the write payload intent before the later edit
            // permission diff exists; otherwise external_directory is path-only.
            metadata: { action_kind: "tool", tool: "write", operation: "write", content: params.content },
          })

          // write proposal 使用同一次 raw read 捕获 expected state，避免 Permission 后提交旧内容。
          const proposal = yield* Mutation.read(fs, filepath)
          if (proposal.version.state === "other") {
            if (proposal.version.kind === "Directory") throw new Error(`Path is a directory, not a file: ${filepath}`)
            throw new Error(`Path is not a file: ${filepath}`)
          }
          const exists = proposal.version.state === "file"
          const source = Bom.split(Mutation.decode(proposal))
          // exists 只表示 proposal 时的 file state；commit recheck 仍以 tagged version 为准。
          const next = Bom.split(params.content)
          const desiredBom = source.bom || next.bom
          const contentOld = source.text
          const ending = exists ? detectLineEnding(contentOld) : undefined
          // ending 取自 Permission 前同一 proposal，避免审批期间补读把版本事实与属性事实拆开。
          // contentNew 只转换已有文件，防止“继承属性”误变成新文件的隐式默认格式。
          // 模型提交的是逻辑行；已有文件的行尾属于 proposal 磁盘属性，不能被 overwrite 参数偶然翻转。
          // 新文件没有可继承属性，继续逐字采用提交内容，避免 write 对创建行为施加全局 EOL 策略。
          const contentNew = ending ? convertToLineEnding(normalizeLineEndings(next.text), ending) : next.text
          // diff/metadata 仍基于 proposal 文本；formatter 后的最终内容只在 commit 内重新读取。
          // 元数据 diff 走唯一有界 seam：ask 预览与最终 metadata 同界（二进制/超限中段改标记表示）。
          const rendered = renderFileDiff(
            filepath,
            normalizeLineEndings(contentOld),
            normalizeLineEndings(contentNew),
          )
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
          let finalSource = source
          // formatter 仍在同一 commit critical section，避免第二个 mutation 看到半完成内容。
          yield* Mutation.commit({
            fs,
            expected: [proposal],
            execute: Effect.gen(function* () {
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
          let metadataDiff: string | undefined
          // [local-smark] 摄入端（summary-cache diff/filepath 分支）优先读取显式计数，
          // 避免对有界标记重扫描退化为 0/0（plan B-02）；与 edit/apply_patch 的计数口径一致。
          let diffCounts: { additions: number; deletions: number } | undefined
          // [local-smark] 当 auto-format 改变了写入内容时，将格式化后的内容
          // 通过 metadata._formattedContent 传递给 processor。
          // processor 的 completeToolCall 会用它直接覆盖 state.input.content，
          // 使 DB 中持久化的 input 就是磁盘上的实际内容（格式化后），
          // 后续上下文重放时模型看到的内容与磁盘一致。
          // 用 normalizeLineEndings 比较避免 CRLF/LF 差异导致 false positive。
          // 覆写和新文件都检查：新文件也可能被 formatter 改变内容。
          let formattedContent: string | undefined
          if (exists || formatted) {
            // finalSource 在 commit lock 内读取，metadata 不会引用另一个 mutation 的中间内容。
            if (exists) {
              const overwrite = renderFileDiff(
                filepath,
                normalizeLineEndings(contentOld),
                normalizeLineEndings(finalSource.text),
              )
              metadataDiff = overwrite.patch
              diffCounts = { additions: overwrite.additions, deletions: overwrite.deletions }
            } else {
              // 新文件被 formatter 改变内容：diff 基于格式化后的最终落盘内容，
              // 使 computeDiff 的工具流能按工具归因追踪新文件改动
              const created = renderFileDiff(filepath, "", normalizeLineEndings(finalSource.text))
              metadataDiff = created.patch
              diffCounts = { additions: created.additions, deletions: created.deletions }
            }
            // 仅在格式化确实改变了内容时设置，避免无谓的 input 覆盖
            if (formatted && normalizeLineEndings(finalSource.text) !== normalizeLineEndings(contentNew)) {
              formattedContent = finalSource.text
            }
          } else if (!exists) {
            // 新文件且未格式化：用写入前已计算的 diff（空内容 → contentNew），
            // 确保新文件写入也出现在工具流 diff 中，而非仅依赖 git 兜底
            metadataDiff = diff
            diffCounts = { additions: rendered.additions, deletions: rendered.deletions }
          }
          yield* bus.publish(File.Event.Edited, { file: filepath })
          yield* bus.publish(FileWatcher.Event.Updated, {
            file: filepath,
            event: exists ? "change" : "add",
          })

          let output = "Wrote file successfully."
          const normalizedFilepath = AppFileSystem.normalizePath(filepath)
          // [local-smark] baseline 在写入后、touch 前采集：LSP 此时还不知道新内容，诊断反映旧状态。
          const beforeDiagnostics = yield* lsp.diagnostics()
          const beforeIssues = beforeDiagnostics[normalizedFilepath] ?? []
          yield* lsp.touchFile(filepath, "document")
          const afterDiagnostics = yield* lsp.diagnostics()
          const currentIssues = afterDiagnostics[normalizedFilepath] ?? []
          const block = LSP.Diagnostic.reportDelta(filepath, currentIssues, beforeIssues)
          // [local-smark] 计算新错误数组和摘要供 TUI 渲染
          const newErrorsArr = LSP.Diagnostic.newErrors(currentIssues, beforeIssues)
          const delta = LSP.Diagnostic.deltaSummary(currentIssues, beforeIssues)
          let diagnosticSummary: typeof delta | undefined = delta
          if (block) {
            output += `\n\nNew LSP errors introduced by this edit:\n${block}`
            output += `\n\nNote: If this is part of a multi-step edit, some errors may be expected until all changes are complete.`
          } else {
            // [local-smark] delta 空 ≠ LSP 验证通过：LSP 未运行时 baseline 和 current 都为空，
            // delta 必然为空。须用 status() 确认 LSP 确实在运行，否则模型获得虚假"类型安全"信号。
            const clients = yield* lsp.status()
            if (clients.length === 0) {
              diagnosticSummary = undefined
              output += `\n\nLSP diagnostics unavailable (no language server running). Run bun typecheck to verify type safety.`
            } else {
              // [local-smark] LSP 已运行且 delta 为空时给短确认，避免模型误判为 LSP 未工作。
              output += `\n\n${LSP.Diagnostic.checkedMessage(delta, "file")}`
            }
          }

          return {
            title: path.relative(instance.worktree, filepath),
            metadata: {
              // [local-smark] metadata.diagnostics 存储新错误数组（delta），不是全部当前错误。
              // TUI getDiagnostics() 从此字段读取，只显示新引入的错误。
              diagnostics: { [normalizedFilepath]: newErrorsArr },
              // diagnosticSummary 缺失代表 LSP 未可靠完成，TUI 不能显示绿色 clean。
              ...(diagnosticSummary ? { diagnosticSummary } : {}),
              filepath,
              exists,
              ...(metadataDiff !== undefined ? { diff: metadataDiff } : {}),
              ...(diffCounts ? { additions: diffCounts.additions, deletions: diffCounts.deletions } : {}),
              // _formattedContent 由 processor 的 completeToolCall 消费：
              // 覆盖 state.input.content 后从此 metadata 中 strip，不持久化
              ...(formattedContent !== undefined ? { _formattedContent: formattedContent } : {}),
            },
            output,
          }
        }).pipe(Effect.orDie),
    }
  }),
)
