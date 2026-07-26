import { Schema } from "effect"
import * as path from "path"
import { Effect } from "effect"
import * as Tool from "./tool"
import { LSP } from "@/lsp/lsp"
import { createTwoFilesPatch } from "diff"
import DESCRIPTION from "./write.txt"
import { Bus } from "../bus"
import { File } from "../file"
import { FileWatcher } from "../file/watcher"
import { Format } from "../format"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { InstanceState } from "@/effect/instance-state"
import { trimDiff } from "./edit"
import { assertExternalDirectoryEffect } from "./external-directory"
import * as Bom from "@/util/bom"
import { normalizeLineEndings } from "@/util/line-ending"
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
          const contentNew = next.text
          // diff/metadata 仍基于 proposal 文本；formatter 后的最终内容只在 commit 内重新读取。

          const diff = trimDiff(
            createTwoFilesPatch(filepath, filepath, normalizeLineEndings(contentOld), normalizeLineEndings(contentNew)),
          )
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
              if (formatted) yield* Bom.syncFile(fs, filepath, desiredBom)
              if (exists || formatted) finalSource = yield* Bom.readFile(fs, filepath)
            }),
          }).pipe(Effect.orDie)
          // 覆写已有文件时，基于格式化后的最终落盘内容生成 diff，供 TUI 以 git diff 形式展示
          let metadataDiff: string | undefined
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
              metadataDiff = trimDiff(
                createTwoFilesPatch(
                  filepath,
                  filepath,
                  normalizeLineEndings(contentOld),
                  normalizeLineEndings(finalSource.text),
                ),
              )
            } else {
              // 新文件被 formatter 改变内容：diff 基于格式化后的最终落盘内容，
              // 使 computeDiff 的工具流能按工具归因追踪新文件改动
              metadataDiff = trimDiff(
                createTwoFilesPatch(
                  filepath,
                  filepath,
                  "",
                  normalizeLineEndings(finalSource.text),
                ),
              )
            }
            // 仅在格式化确实改变了内容时设置，避免无谓的 input 覆盖
            if (formatted && normalizeLineEndings(finalSource.text) !== normalizeLineEndings(contentNew)) {
              formattedContent = finalSource.text
            }
          } else if (!exists) {
            // 新文件且未格式化：用写入前已计算的 diff（空内容 → contentNew），
            // 确保新文件写入也出现在工具流 diff 中，而非仅依赖 git 兜底
            metadataDiff = diff
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
