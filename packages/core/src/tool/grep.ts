export * as GrepTool from "./grep"

import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Layer, Schema } from "effect"
import path from "path"
import { makeLocationNode } from "../effect/app-node"
import { FileSystem } from "../filesystem"
import { FSUtil } from "../fs-util"
import { Location } from "../location"
import { PermissionV2 } from "../permission"
import { Ripgrep } from "../ripgrep"
import { PositiveInt, RelativePath } from "../schema"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "grep"

const RESULT_LIMIT = 64
// 与V1使用同一默认预算和上限，Native显式limit仍保留原有结果条数语义。
const DEFAULT_TIMEOUT = 10_000
const MAX_TIMEOUT = 120_000
const PatternList = Schema.Union([Schema.String, Schema.Array(Schema.String)])

export const Input = Schema.Struct({
  pattern: FileSystem.GrepInput.fields.pattern.annotate({
    description: "The regex pattern to search for in file contents",
  }),
  path: RelativePath.pipe(Schema.optional).annotate({
    description: "Relative directory to search. Defaults to the active Location.",
  }),
  include: Schema.optional(PatternList).annotate({
    description: 'File pattern(s) to include in the search (e.g. "*.js", ["*.ts", "*.tsx"])',
  }),
  exclude: Schema.optional(PatternList).annotate({
    description: 'File pattern(s) to exclude from the search (e.g. "node_modules/**", ["dist/**", "*.lock"])',
  }),
  timeout: Schema.optional(PositiveInt.check(Schema.isLessThanOrEqualTo(MAX_TIMEOUT))).annotate({
    description: `Optional timeout in milliseconds. Defaults to ${DEFAULT_TIMEOUT}, maximum ${MAX_TIMEOUT}.`,
  }),
  limit: FileSystem.GrepInput.fields.limit.annotate({
    description: `Maximum matches to return (default ${RESULT_LIMIT})`,
  }),
})

export const Output = Schema.Struct({
  items: Schema.Array(FileSystem.Match),
  partial: Schema.Boolean,
  truncated: Schema.Boolean,
  timedOut: Schema.optional(Schema.Boolean),
  timeout: Schema.optional(PositiveInt),
})
type ModelOutput = typeof Output.Encoded

// 保留真实数量截断，预算耗尽单独提示，不能把少量部分结果谎报成64+。
export const toModelOutput = (output: ModelOutput) => {
  // 截断来自真实 producer 状态，不能仅因条数恰好等于预算就猜测有更多结果。
  const timeout = output.timeout ?? DEFAULT_TIMEOUT
  const lines = output.items.length === 0
    ? output.timedOut ? [`Search timed out after ${timeout} ms before finding matches.`, "Results may be incomplete. Use a narrower path/include/exclude pattern or increase timeout."] : ["No files found"]
    : [`Found ${output.items.length}${output.truncated ? "+" : ""} matches${output.truncated ? ` (showing first ${output.items.length})` : ""}${output.timedOut ? ` before timing out after ${timeout} ms` : ""}`]
  let current = ""
  for (const match of output.items) {
    if (current !== match.entry.path) {
      if (current) lines.push("")
      current = match.entry.path
      lines.push(`${match.entry.path}:`)
    }
    lines.push(`  Line ${match.line}: ${match.text}`)
  }
  if (output.truncated) lines.push("", `(Results truncated: showing first ${output.items.length} matches. Consider using a more specific path or pattern.)`)
  if (output.timedOut) lines.push("",
    `(Search timed out after ${timeout} ms; results may be incomplete. Use a narrower path/include/exclude pattern or increase timeout.)`,
  )
  if (output.partial) lines.push("Some paths could not be accessed; results may be incomplete.")
  return lines.join("\n")
}

/** Grep leaf that defaults its filesystem root to the active Location. */
const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const fs = yield* FSUtil.Service
    const ripgrep = yield* Ripgrep.Service
    const location = yield* Location.Service
    const permission = yield* PermissionV2.Service

    yield* tools
      .register({
        [name]: Tool.make({
          description:
            "Search file contents by regular expression within the active Location or an absolute managed tool-output file. Use limit to bound the match count. Returns concise file resources, line numbers, and bounded line previews.\n- Filter files by pattern with the include and exclude parameters (eg. include \"*.js\", exclude \"dist/**\")\n- For large workspaces, pass path, include, and exclude to narrow the candidate files before searching contents\n- Searches are time-bounded; if the timeout is reached, partial results may be returned instead of claiming there are no matches",
          input: Input,
          output: Output,
          toModelOutput: ({ output }) => [
            {
              type: "text",
              text: toModelOutput(
                { ...output, items: output.items.map((match) => ({
                  ...match,
                  entry: { ...match.entry, path: path.resolve(location.directory, match.entry.path) },
                })) },
              ),
            },
          ],
          execute: (input, context) =>
            Effect.gen(function* () {
              yield* permission.assert({
                action: name,
                resources: [input.pattern],
                save: ["*"],
                metadata: {
                  root: ".",
                  path: input.path,
                  include: input.include,
                  exclude: input.exclude,
                  timeout: input.timeout,
                  limit: input.limit,
                },
                sessionID: context.sessionID,
                agent: context.agent,
                source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
              })
              const target = path.resolve(location.directory, input.path ?? ".")
              const info = yield* fs.stat(target).pipe(Effect.catch(() => Effect.succeed(undefined)))
              return yield* ripgrep
                .search({
                  cwd: info?.type === "Directory" ? target : path.dirname(target),
                  pattern: input.pattern,
                  file: info?.type === "File" ? path.basename(target) : undefined,
                  include: input.include,
                  exclude: input.exclude,
                  // 交互工具用时间而非候选数拒绝，内部搜索的maxFiles策略保持。
                  timeout: input.timeout ?? DEFAULT_TIMEOUT,
                  maxFiles: false,
                  // 默认预算进入流式收集之前；显式正数 limit 不被默认值夹紧。
                  limit: input.limit ?? RESULT_LIMIT,
                })
                .pipe(
                  Effect.map((result) => ({
                    ...result,
                    // 仅超时时携带真实预算，不改变普通结果的既有形状。
                    ...(result.timedOut ? { timeout: input.timeout ?? DEFAULT_TIMEOUT } : {}),
                    items: result.items.map((match) =>
                      FileSystem.Match.make({
                        ...match,
                        entry: FileSystem.Entry.make({
                          ...match.entry,
                          path: RelativePath.make(
                            path.relative(
                              location.directory,
                              path.resolve(
                                info?.type === "Directory" ? target : path.dirname(target),
                                match.entry.path,
                              ),
                            ),
                          ),
                        }),
                      }),
                    ),
                  })),
                )
            }).pipe(Effect.mapError((cause) => new ToolFailure({
              message: cause instanceof Ripgrep.SearchTooBroadError
                ? `${cause.message}\nUse a narrower path or include pattern before searching file contents.`
                : cause instanceof Ripgrep.InvalidPatternError || cause instanceof Ripgrep.Error
                  ? cause.message
                  : PermissionV2.autoDeniedMessage(cause) ?? `Unable to grep for ${input.pattern}`,
            }))),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/grep",
  layer,
  deps: [ToolRegistry.node, FSUtil.node, Ripgrep.node, Location.node, PermissionV2.node],
})
