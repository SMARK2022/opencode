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
          yield* assertExternalDirectoryEffect(ctx, filepath)

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
          if (yield* format.file(filepath)) {
            yield* Bom.syncFile(fs, filepath, desiredBom)
          }
          // 覆写已有文件时，基于格式化后的最终落盘内容生成 diff，供 TUI 以 git diff 形式展示
          // 格式化后的最终内容：格式化可能改变文件内容，因此基于最终落盘内容生成 diff
          let metadataDiff: string | undefined
          if (exists) {
            // 最终内容读取：格式化后重新读取文件，确保 diff 反映实际落盘内容
            const finalSource = yield* Bom.readFile(fs, filepath)
            // diff 生成：使用 createTwoFilesPatch 生成 git diff 格式，trimDiff 清理头部
            metadataDiff = trimDiff(
              createTwoFilesPatch(
                filepath,
                filepath,
                // #131：格式化后最终 diff 也归一行尾
                normalizeLineEndings(contentOld),
                normalizeLineEndings(finalSource.text),
              ),
            )
          }
          yield* events.publish(FileSystem.Event.Edited, { file: filepath })
          yield* events.publish(Watcher.Event.Updated, {
            file: filepath,
            event: exists ? "change" : "add",
          })

          let output = "Wrote file successfully."
          yield* lsp.touchFile(filepath, "document")
          const diagnostics = yield* lsp.diagnostics()
          const normalizedFilepath = FSUtil.normalizePath(filepath)
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

          return {
            title: path.relative(instance.worktree, filepath),
            metadata: {
              diagnostics,
              filepath,
              exists,
              // 条件展开：仅在 metadataDiff 存在时展开 diff 字段，避免 undefined 污染 metadata
              ...(metadataDiff !== undefined ? { diff: metadataDiff } : {}),
            },
            output,
          }
        }).pipe(Effect.orDie),
    }
  }),
)
