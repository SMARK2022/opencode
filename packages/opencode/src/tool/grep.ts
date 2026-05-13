import path from "path"
import { Effect, Schema } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
// #138：grep 结果上限与过宽候选处理
import { assertExternalDirectoryEffect } from "./external-directory"
import DESCRIPTION from "./grep.txt"
import * as Tool from "./tool"

// #138：工具输出匹配上限（有界搜索）
// #138：工具默认 64 条匹配上限（与 source 一致）
const RESULT_LIMIT = 64

export const Parameters = Schema.Struct({
  pattern: Schema.String.annotate({ description: "The regex pattern to search for in file contents" }),
  path: Schema.optional(Schema.String).annotate({
    description: "The directory to search in. Defaults to the current working directory.",
  }),
  include: Schema.optional(Schema.String).annotate({
    description: 'File pattern to include in the search (e.g. "*.js", "*.{ts,tsx}")',
  }),
})

export const GrepTool = Tool.define(
  "grep",
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const ripgrep = yield* Ripgrep.Service
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: { pattern: string; path?: string; include?: string }, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const empty = {
            title: params.pattern,
            metadata: { matches: 0, truncated: false },
            output: "No files found",
          }
          if (!params.pattern) {
            throw new Error("pattern is required")
          }

          yield* ctx.ask({
            permission: "grep",
            patterns: [params.pattern],
            always: ["*"],
            metadata: {
              pattern: params.pattern,
              path: params.path,
              include: params.include,
            },
          })

          const ins = yield* InstanceState.context
          const requested = path.isAbsolute(params.path ?? ins.directory)
            ? (params.path ?? ins.directory)
            : path.join(ins.directory, params.path ?? ".")
          const requestedInfo = yield* fs.stat(requested).pipe(Effect.catch(() => Effect.succeed(undefined)))
          yield* assertExternalDirectoryEffect(ctx, requested, {
            bypass: false,
            kind: requestedInfo?.type === "Directory" ? "directory" : "file",
          })

          const search = FSUtil.resolve(requested)
          const info = yield* fs.stat(search).pipe(Effect.catch(() => Effect.succeed(undefined)))
          const cwd = info?.type === "Directory" ? search : path.dirname(search)
          const result = yield* ripgrep
            .grep({
              cwd,
              // #138：现存单文件传入精确目标，避免按父目录计数与搜索。
              file: info?.type === "File" ? path.basename(search) : undefined,
              pattern: params.pattern,
              include: params.include,
              // #138：多取 1 条以检测截断
              limit: RESULT_LIMIT + 1,
            })
            .pipe(
              Effect.catchTag("Ripgrep.SearchTooBroadError", (err) =>
                Effect.succeed({ tooBroad: err.maxFiles as number }),
              ),
            )
          // #138：过宽候选转用户可读输出，不抛到工具崩溃
          if ("tooBroad" in result) {
            return {
              title: params.pattern,
              metadata: { matches: 0, truncated: false },
              output: [
                `Search scope is too broad: more than ${result.tooBroad} candidate files.`,
                "Use a narrower path or include pattern before searching file contents.",
              ].join("\n"),
            }
          }
          if (result.length === 0) return empty

          const rows = result.map((item) => ({
            path: path.resolve(
              requestedInfo?.type === "Directory" ? requested : path.dirname(requested),
              item.entry.path,
            ),
            line: item.line,
            text: item.text,
          }))

          // #138：超出 RESULT_LIMIT 截断展示
          const truncated = rows.length > RESULT_LIMIT
          // #138：只返回前 RESULT_LIMIT 条匹配
          const final = truncated ? rows.slice(0, RESULT_LIMIT) : rows
          if (final.length === 0) return empty

          const output = [
            `Found ${truncated ? `${RESULT_LIMIT}+` : final.length} matches${truncated ? ` (showing first ${RESULT_LIMIT})` : ""}`,
          ]

          let current = ""
          for (const match of final) {
            if (current !== match.path) {
              if (current !== "") output.push("")
              current = match.path
              output.push(`${match.path}:`)
            }
            output.push(`  Line ${match.line}: ${match.text}`)
          }

          if (truncated) {
            output.push("")
            output.push(`(Results truncated: showing first ${RESULT_LIMIT} matches. Consider using a more specific path or pattern.)`)
          }

          return {
            title: params.pattern,
            // #138：metadata.matches 为展示条数
            metadata: {
              matches: final.length,
              truncated,
            },
            output: output.join("\n"),
          }
        }).pipe(Effect.orDie),
    }
  }),
)
