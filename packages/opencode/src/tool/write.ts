import { Schema } from "effect"
import * as path from "path"
import { Effect } from "effect"
import * as Tool from "./tool"
import { LSP } from "@/lsp/lsp"
import { createTwoFilesPatch } from "diff"
import DESCRIPTION from "./write.txt"
import { EventV2Bridge } from "@/event-v2-bridge"
import { FileSystem } from "@opencode-ai/core/filesystem"
import { Watcher } from "@opencode-ai/core/filesystem/watcher"
import { Format } from "../format"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { InstanceState } from "@/effect/instance-state"
import { trimDiff } from "./edit"
import { assertExternalDirectoryEffect } from "./external-directory"
import * as Bom from "@/util/bom"
import { normalizeLineEndings } from "@/util/line-ending"
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

    return {
      description: DESCRIPTION,
      parameters: Parameters,
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

          const exists = yield* fs.existsSafe(filepath)
          const source = exists ? yield* Bom.readFile(fs, filepath) : { bom: false, text: "" }
          const next = Bom.split(params.content)
          const desiredBom = source.bom || next.bom
          const contentOld = source.text
          const contentNew = next.text

          const diff = trimDiff(
            // #131：permission 元数据忽略纯行尾 diff
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
          if (exists || formatted) {
            // 最终内容读取：格式化后重新读取文件，确保 diff 反映实际落盘内容
            const finalSource = yield* Bom.readFile(fs, filepath)
            // diff 生成：使用 createTwoFilesPatch 生成 git diff 格式，trimDiff 清理头部
            if (exists) {
            metadataDiff = trimDiff(
              createTwoFilesPatch(
                filepath,
                filepath,
                // #131：格式化后最终 diff 也归一行尾
                normalizeLineEndings(contentOld),
                normalizeLineEndings(finalSource.text),
              ),
            )
            } else {
              // 格式化新文件的diff必须取最终落盘文本，不能漏记或回用格式化前内容。
              metadataDiff = trimDiff(
                createTwoFilesPatch(filepath, filepath, "", normalizeLineEndings(finalSource.text)),
              )
            }
            // 仅在格式化确实改变了内容时设置，避免无谓的 input 覆盖
            if (formatted && normalizeLineEndings(finalSource.text) !== normalizeLineEndings(contentNew)) {
              formattedContent = finalSource.text
            }
          } else if (!exists) {
            // 未格式化的新文件复用写前diff；该分支属于外层最终内容判断。
            metadataDiff = diff
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
