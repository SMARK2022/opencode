import path from "path"
import { Effect, Schema } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { FileSystem } from "@opencode-ai/schema/filesystem"
import { assertExternalDirectoryEffect } from "./external-directory"
import DESCRIPTION from "./glob.txt"
import * as Tool from "./tool"

export const Parameters = Schema.Struct({
  pattern: Schema.String.annotate({ description: "The glob pattern to match files against" }),
  path: Schema.optional(Schema.String).annotate({
    description: `The directory to search in. If not specified, the current working directory will be used. IMPORTANT: Omit this field to use the default directory. DO NOT enter "undefined" or "null" - simply omit it for the default behavior. Must be a valid directory path if provided.`,
  }),
})

export const GlobTool = Tool.define(
  "glob",
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const ripgrep = yield* Ripgrep.Service
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      output: Schema.Struct({ files: Schema.Array(FileSystem.Entry), truncated: Schema.Boolean, partial: Schema.Boolean }),
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
          const info = yield* fs.stat(search).pipe(Effect.catch(() => Effect.succeed(undefined)))
          if (info?.type === "File") {
            throw new Error(`glob path must be a directory: ${search}`)
          }
          yield* assertExternalDirectoryEffect(ctx, search, {
            bypass: false,
            kind: "directory",
          })

          const limit = 100
          // [local-smark] glob 通道透出 partial：零匹配不再等同于确定性无匹配
          const globResult = yield* ripgrep.glob({ cwd: search, pattern: params.pattern, limit, signal: ctx.abort })
          const globPartial = globResult.partial
          const files = globResult.files
          const truncated = globResult.truncated
          // Core观察到limit+1才截断；恰好100条不能被误报为100+。
          const originalCount = files.length + Number(truncated)
          // [local-smark] total: 截断前的真实文件数（rg 按 limit 截停时为下界）
          const totalFiles = originalCount

          // 文本与程序共用绝对路径事实，脚本无需解析带截断提示的展示文本。
          // 锚点是实际search目录，后续工具可直接复用文件身份而无需重解本次path参数。
          const paths = files.map((file) => path.resolve(search, file.path))
          const output = []
          // [local-smark] partial 假阴性防护：部分路径不可访问时显式提示，
        // 模型可据此收窄路径或调整 pattern，而不是误信全量无匹配
        if (files.length === 0 && globPartial)
          output.push("No files found, but some paths could not be accessed (permission denied); results may be incomplete.")
        else if (files.length === 0) output.push("No files found")
          if (files.length > 0) {
            output.push(...paths)
            if (truncated) {
              output.push("")
              output.push(
                // [local-smark] 显示真实总数下界而非仅 "first 100"，帮助模型判断文件密度
                `(Results are truncated: showing first ${limit} results. ${truncated ? `Total: ${totalFiles}+ files.` : ""} Consider using a more specific path or pattern.)`,
              )
            }
          }

          // [local-smark] partial 与源/grep 约定一致：无论是否有匹配都提示——
          // 有匹配但部分路径不可访问时模型仍需知道结果可能不完整
          if (globPartial) output.push("(Some paths could not be accessed; results may be incomplete.)")

          return {
            title: path.relative(ins.worktree, search),
            metadata: {
              count: files.length,
              // [local-smark] total: 截断前的真实文件数
              total: totalFiles,
              truncated,
              // [local-smark] partial: rg exit 2 部分路径不可访问时标记；
              // 零匹配不再被误读为全量无匹配（wire 缺省无此键 = false，向后兼容）
              ...(globPartial ? { partial: true } : {}),
            },
            output: output.join("\n"),
            // R15保留完整性标志；绝对路径沿原V1执行器，便于后续工具直接复用。
            program: { value: { files: files.map((file) => ({ ...file, path: path.resolve(search, file.path) })), truncated, partial: globPartial } },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
