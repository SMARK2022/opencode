export * as GlobTool from "./glob"

import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Layer, Schema } from "effect"
import path from "path"
import { makeLocationNode } from "../effect/app-node"
import { FileSystem } from "../filesystem"
import { Location } from "../location"
import { Ripgrep } from "../ripgrep"
import { RelativePath } from "../schema"
import { PermissionV2 } from "../permission"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "glob"

export const Input = Schema.Struct({
  pattern: FileSystem.GlobInput.fields.pattern.annotate({ description: "Glob pattern to match files against" }),
  path: RelativePath.pipe(Schema.optional).annotate({
    description: "Relative directory to search. Defaults to the active Location.",
  }),
  limit: FileSystem.GlobInput.fields.limit.annotate({
    description: "Maximum results to return",
  }),
})

export const Output = Schema.Struct({
  files: Schema.Array(FileSystem.Entry),
  partial: Schema.Boolean,
  truncated: Schema.Boolean,
  timedOut: Schema.optional(Schema.Boolean),
})
type ModelOutput = typeof Output.Encoded

// 正常结果仍用原路径列表，完整性标记同时进入结构化结果和模型文本。
export const toModelOutput = (output: ModelOutput) => {
  const lines = output.files.length === 0 ? ["No files found"] : output.files.map((item) => item.path)
  if (output.truncated) lines.push("Results truncated; narrow the search path or pattern.")
  if (output.timedOut) lines.push("Search timed out; results may be incomplete.")
  if (output.partial) lines.push("Some paths could not be accessed; results may be incomplete.")
  return lines.join("\n")
}

/** Glob leaf that defaults its filesystem root to the active Location. */
const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const ripgrep = yield* Ripgrep.Service
    const location = yield* Location.Service
    const permission = yield* PermissionV2.Service

    yield* tools
      .register({
        [name]: Tool.make({
          description:
            "Find files by glob pattern within the active Location. Returns concise relative file resources. Use a relative path to narrow the search and limit to bound the result count.",
          input: Input,
          output: Output,
          toModelOutput: ({ output }) => [
            {
              type: "text",
              text: toModelOutput(
                { ...output, files: output.files.map((entry) => ({ ...entry, path: path.resolve(location.directory, entry.path) })) },
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
                  root: input.path ?? ".",
                  path: input.path,
                  limit: input.limit,
                },
                sessionID: context.sessionID,
                agent: context.agent,
                source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
              })
              const cwd = path.resolve(location.directory, input.path ?? ".")
              return yield* ripgrep
                .glob({
                  cwd,
                  pattern: input.pattern,
                  // 默认同V1有界，Native显式limit仍保留其参数能力。
                  limit: input.limit ?? 100,
                })
                .pipe(
                  // 仅重映射路径，不让数组投影吞掉partial/timeout/limit状态。
                  Effect.map((result) => ({
                    ...result,
                    files: result.files.map((entry) =>
                      FileSystem.Entry.make({
                        ...entry,
                        path: RelativePath.make(path.relative(location.directory, path.resolve(cwd, entry.path))),
                      }),
                    ),
                  })),
                )
            }).pipe(
              Effect.mapError((error) => new ToolFailure({ message: PermissionV2.autoDeniedMessage(error) ?? `Unable to find files matching ${input.pattern}` })),
            ),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/glob",
  layer,
  deps: [ToolRegistry.node, Ripgrep.node, Location.node, PermissionV2.node],
})
