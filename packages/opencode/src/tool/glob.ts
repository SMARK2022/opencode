import path from "path"
import { Effect, Option, Schema } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Ripgrep } from "../file/ripgrep"
import { assertExternalDirectoryEffect } from "./external-directory"
import DESCRIPTION from "./glob.txt"
import * as Tool from "./tool"
import { Reference } from "@/reference/reference"

export const Parameters = Schema.Struct({
  pattern: Schema.String.annotate({ description: "The glob pattern to match files against" }),
  path: Schema.optional(Schema.String).annotate({
    description: `The directory to search in. If not specified, the current working directory will be used. IMPORTANT: Omit this field to use the default directory. DO NOT enter "undefined" or "null" - simply omit it for the default behavior. Must be a valid directory path if provided.`,
  }),
})

export const GlobTool = Tool.define(
  "glob",
  Effect.gen(function* () {
    const rg = yield* Ripgrep.Service
    const fs = yield* AppFileSystem.Service
    const reference = yield* Reference.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: { pattern: string; path?: string }, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const ins = yield* InstanceState.context
          yield* ctx.ask({
            permission: "glob",
            patterns: [params.pattern],
            always: ["*"],
            metadata: {
              pattern: params.pattern,
              path: params.path,
            },
          })

          let search = params.path ?? ins.directory
          search = path.isAbsolute(search) ? search : path.resolve(ins.directory, search)
          yield* reference.ensure(search)
          const info = yield* fs.stat(search).pipe(Effect.catch(() => Effect.succeed(undefined)))
          if (info?.type === "File") {
            throw new Error(`glob path must be a directory: ${search}`)
          }
          yield* assertExternalDirectoryEffect(ctx, search, {
            bypass: yield* reference.contains(search),
            kind: "directory",
          })

          const limit = 100
          // limit 由 Tool 决定，Ripgrep 多观察一个 sentinel；不能在两层各自再次 take 造成双重截断。
          const result = yield* rg.glob({ cwd: search, glob: [params.pattern], limit, signal: ctx.abort })
          const files = yield* Effect.forEach(result.items, (file) =>
            Effect.gen(function* () {
              const full = path.resolve(search, file)
              const info = yield* fs.stat(full).pipe(Effect.catch(() => Effect.succeed(undefined)))
              // rg 已经确认路径存在；stat 竞态只降低排序优先级，不能删除可用结果。
              const mtime =
                info?.mtime.pipe(
                  Option.map((date) => date.getTime()),
                  Option.getOrElse(() => 0),
                ) ?? 0
              return { path: full, mtime }
            }),
          )

          // total 保持旧的 bounded 口径：101 只证明“至少还有一项”，不是精确全量。
          const totalFiles = files.length + Number(result.truncated)
          files.sort((a, b) => b.mtime - a.mtime)

          const output = []
          if (files.length === 0) {
            // 只有 complete-empty 能沿用历史精确文案，partial-empty 必须限制结论到可访问路径。
            output.push(result.partial ? "No files found in accessible paths." : "No files found")
          }
          if (files.length > 0) {
            output.push(...files.map((file) => file.path))
            if (result.truncated) {
              output.push("")
              // [local-smark] 显示真实总数而非仅 "first 100"，帮助模型判断文件密度
              output.push(
                `(Results are truncated: showing first ${limit} results. ${totalFiles > limit ? `Total: ${totalFiles}+ files.` : ""} Consider using a more specific path or pattern.)`,
              )
            }
          }
          if (result.partial) {
            output.push("")
            // 不回传被拒绝路径，既避免隐私泄漏，也防止权限诊断重新淹没模型上下文。
            output.push(
              "(Search incomplete: some paths were inaccessible and skipped. Narrow the path before relying on absence.)",
            )
          }

          return {
            title: path.relative(ins.worktree, search),
            metadata: {
              count: files.length,
              // [local-smark] total: 截断前的真实文件数
              total: totalFiles,
              truncated: result.truncated,
              // metadata 供持久化、Compaction 和 UI 使用；模型提示仍必须存在于 output 中。
              partial: result.partial,
            },
            output: output.join("\n"),
          }
        }).pipe(Effect.orDie),
    }
  }),
)
