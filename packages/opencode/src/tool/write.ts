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

const MAX_PROJECT_DIAGNOSTICS_FILES = 5

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

          const exists = yield* fs.existsSafe(filepath)
          const source = exists ? yield* Bom.readFile(fs, filepath) : { bom: false, text: "" }
          const next = Bom.split(params.content)
          const desiredBom = source.bom || next.bom
          const contentOld = source.text
          const contentNew = next.text

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

          yield* fs.writeWithDirs(filepath, Bom.join(contentNew, desiredBom))
          // [local-smark] 捕获 format 是否运行，用于后续判断是否需要检测内容变化
          const formatted = yield* format.file(filepath)
          if (formatted) {
            yield* Bom.syncFile(fs, filepath, desiredBom)
          }
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
            const finalSource = yield* Bom.readFile(fs, filepath)
            if (exists) {
              metadataDiff = trimDiff(
                createTwoFilesPatch(
                  filepath,
                  filepath,
                  normalizeLineEndings(contentOld),
                  normalizeLineEndings(finalSource.text),
                ),
              )
            }
            // 仅在格式化确实改变了内容时设置，避免无谓的 input 覆盖
            if (formatted && normalizeLineEndings(finalSource.text) !== normalizeLineEndings(contentNew)) {
              formattedContent = finalSource.text
            }
          }
          yield* bus.publish(File.Event.Edited, { file: filepath })
          yield* bus.publish(FileWatcher.Event.Updated, {
            file: filepath,
            event: exists ? "change" : "add",
          })

          let output = "Wrote file successfully."
          yield* lsp.touchFile(filepath, "document")
          const diagnostics = yield* lsp.diagnostics()
          const normalizedFilepath = AppFileSystem.normalizePath(filepath)
          let projectDiagnosticsCount = 0
          for (const [file, issues] of Object.entries(diagnostics)) {
            const current = file === normalizedFilepath
            if (!current && projectDiagnosticsCount >= MAX_PROJECT_DIAGNOSTICS_FILES) continue
            const block = LSP.Diagnostic.report(current ? filepath : file, issues)
            if (!block) continue
            if (current) {
              output += `\n\nLSP errors detected in this file, please fix:\n${block}`
              continue
            }
            projectDiagnosticsCount++
            output += `\n\nLSP errors detected in other files:\n${block}`
          }
          // [local-smark] diagnostics 为空时不区分"无错误"和"LSP 未运行"，
          // 模型会误认为写入的文件无类型错误。用 status() 检查是否有已连接的
          // LSP client：空列表表示无 server 运行，追加不可用提示。
          if (Object.keys(diagnostics).length === 0) {
            const clients = yield* lsp.status()
            if (clients.length === 0) {
              output += `\n\nLSP diagnostics unavailable (no language server running). Run bun typecheck to verify type safety.`
            }
          }

          return {
            title: path.relative(instance.worktree, filepath),
            metadata: {
              diagnostics,
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
