import path from "path"
import { Effect, Schema } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { PositiveInt } from "@opencode-ai/core/schema"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { assertExternalDirectoryEffect } from "./external-directory"
import DESCRIPTION from "./grep.txt"
import * as Tool from "./tool"

const RESULT_LIMIT = 64
// 默认 10 秒覆盖常规代码库检索；它替代 grep 工具原先的 5000 文件硬拒绝，
// 让“小文件很多但搜索很快”的仓库能完成，同时仍给低命中大扫描一个确定边界。
const DEFAULT_TIMEOUT = 10_000
// 允许用户显式放宽时间预算，但保留 2 分钟上限，避免模型把 grep 当成长时间后台任务。
const MAX_TIMEOUT = 120_000
// include/exclude 都允许单个 glob 或 glob 列表；保持一个小 schema 常量，
// 避免两个参数定义分叉后出现 include 支持数组而 exclude 不支持的回归。
const PatternList = Schema.Union([Schema.String, Schema.Array(Schema.String)])

export const Parameters = Schema.Struct({
  pattern: Schema.String.annotate({ description: "The regex pattern to search for in file contents" }),
  path: Schema.optional(Schema.String).annotate({
    description: "The directory to search in. Defaults to the current working directory.",
  }),
  include: Schema.optional(PatternList).annotate({
    description: 'File pattern(s) to include in the search (e.g. "*.js", ["*.ts", "*.tsx"])',
  }),
  exclude: Schema.optional(PatternList).annotate({
    description: 'File pattern(s) to exclude from the search (e.g. "node_modules/**", ["dist/**", "*.lock"])',
  }),
  timeout: Schema.optional(
    // 机器可读 schema 和描述文字保持同一上限；这样模型/客户端在提交工具调用前
    // 就能看到 120 秒边界，而不是依赖执行阶段再静默截断。
    PositiveInt.check(Schema.isLessThanOrEqualTo(MAX_TIMEOUT)),
  ).annotate({
    description: `Optional timeout in milliseconds. Defaults to ${DEFAULT_TIMEOUT}, maximum ${MAX_TIMEOUT}.`,
  }),
})

function patterns(input?: string | readonly string[]) {
  if (!input) return []
  // 空 glob 没有明确搜索语义，作为 no-op 忽略；真实的 pattern 必填校验仍在执行入口保留。
  return (Array.isArray(input) ? input : [input]).filter((item) => item.length > 0)
}

export const GrepTool = Tool.define(
  "grep",
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const ripgrep = yield* Ripgrep.Service
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
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
              exclude: params.exclude,
              timeout: params.timeout,
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
          const file = info?.type === "Directory" ? undefined : [path.relative(cwd, search)]
          const timeout = params.timeout ?? DEFAULT_TIMEOUT
          const emptyTimedOut = () => ({
            title: params.pattern,
            metadata: { matches: 0, truncated: true, timedOut: true },
            output: [
              `Search timed out after ${timeout} ms before finding matches.`,
              "Results may be incomplete. Use a narrower path/include/exclude pattern or increase timeout.",
            ].join("\n"),
          })

          const result = yield* ripgrep.search({
            cwd,
            pattern: params.pattern,
            include: patterns(params.include),
            exclude: patterns(params.exclude),
            file,
            limit: RESULT_LIMIT,
            // grep 用真实执行时间做保护，不再用候选文件数粗暴拒绝；
            // 小文件多的仓库应允许快速完成，低命中大搜索由 timeout 受控终止。
            maxFiles: false,
            timeout,
            signal: ctx.abort,
          })
          if (result.items.length === 0 && result.timedOut) {
            return emptyTimedOut()
          }
          if (result.items.length === 0) return empty

          const rows = result.items.map((item) => ({
            path: path.resolve(cwd, item.entry.path),
            line: item.line,
            text: item.text,
          }))

          const resultLimitTruncated = result.truncated || rows.length > RESULT_LIMIT
          const truncated = resultLimitTruncated || result.timedOut === true
          const final = resultLimitTruncated ? rows.slice(0, RESULT_LIMIT) : rows
          // 超时语义优先于空结果语义：即使 rg 曾输出匹配但文件随后在 stat
          // 阶段不可用，也不能把未完成搜索降级成确定性的 “No files found”。
          if (final.length === 0 && result.timedOut) return emptyTimedOut()
          if (final.length === 0) return empty

          const output = [
            `Found ${resultLimitTruncated ? `${RESULT_LIMIT}+` : final.length} matches${
              resultLimitTruncated ? ` (showing first ${RESULT_LIMIT})` : ""
            }${result.timedOut ? ` before timing out after ${timeout} ms` : ""}`,
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

          if (resultLimitTruncated) {
            output.push("")
            output.push("(Results truncated. Consider using a more specific path or pattern.)")
          }

          if (result.timedOut) {
            output.push("")
            output.push(
              `(Search timed out after ${timeout} ms; results may be incomplete. Use a narrower path/include/exclude pattern or increase timeout.)`,
            )
          }

          if (result.partial) {
            output.push("")
            output.push("(Some paths were inaccessible and skipped)")
          }

          return {
            title: params.pattern,
            metadata: {
              matches: final.length,
              truncated,
              ...(result.timedOut && { timedOut: true }),
            },
            output: output.join("\n"),
          }
        }).pipe(Effect.orDie),
    }
  }),
)
