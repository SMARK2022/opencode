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
import { RelativePath } from "../schema"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "grep"

const RESULT_LIMIT = 64

export const Input = Schema.Struct({
  pattern: FileSystem.GrepInput.fields.pattern.annotate({
    description: "Regex pattern to search for in file contents",
  }),
  path: RelativePath.pipe(Schema.optional).annotate({
    description: "Relative directory to search. Defaults to the active Location.",
  }),
  include: FileSystem.GrepInput.fields.include.annotate({
    description: 'File glob to include in the search (for example, "*.js" or "*.{ts,tsx}")',
  }),
  limit: FileSystem.GrepInput.fields.limit.annotate({
    description: `Maximum matches to return (default ${RESULT_LIMIT})`,
  }),
})

export const Output = Schema.Struct({
  items: Schema.Array(FileSystem.Match),
  partial: Schema.Boolean,
  truncated: Schema.Boolean,
})
type ModelOutput = typeof Output.Encoded

/** Format raw search matches into the familiar concise model output. */
export const toModelOutput = (output: ModelOutput) => {
  // 截断来自真实 producer 状态，不能仅因条数恰好等于预算就猜测有更多结果。
  const lines = output.items.length === 0 ? ["No files found"] : [`Found ${output.items.length}${output.truncated ? "+" : ""} matches${output.truncated ? ` (showing first ${output.items.length})` : ""}`]
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
            "Search file contents by regular expression within the active Location or an absolute managed tool-output file. Use a path to narrow the search, include to filter files by glob, and limit to bound the match count. Returns concise file resources, line numbers, and bounded line previews.",
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
                  // 默认预算进入流式收集之前；显式正数 limit 不被默认值夹紧。
                  limit: input.limit ?? RESULT_LIMIT,
                })
                .pipe(
                  Effect.map((result) => ({
                    ...result,
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
