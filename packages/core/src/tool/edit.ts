/**
 * Model-facing V2 exact-edit leaf. Relative paths resolve within the active
 * Location. Absolute paths inside that Location are accepted, while explicit
 * absolute external paths retain mutation capability through a separate
 * external_directory approval before edit approval.
 */
export * as EditTool from "./edit"

import { ToolFailure } from "@opencode-ai/llm"
import { FileDiff } from "@opencode-ai/schema/file-diff"
import { createTwoFilesPatch, diffLines } from "diff"
import { Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { FileMutation } from "../file-mutation"
import { FSUtil } from "../fs-util"
import { LocationMutation } from "../location-mutation"
import { PermissionV2 } from "../permission"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"
import { Format } from "../format"
import { convertToLineEnding, detectLineEnding, normalizeLineEndings } from "../util/line-ending"

export const name = "edit"

export const Input = Schema.Struct({
  path: Schema.String.annotate({
    description:
      "File path to edit. Relative paths resolve within the active Location. Absolute paths inside that Location are accepted; external absolute paths require external_directory approval.",
  }),
  oldString: Schema.String.annotate({ description: "Exact text to replace" }),
  newString: Schema.String.annotate({ description: "Replacement text, which must differ from oldString" }),
  replaceAll: Schema.Boolean.pipe(Schema.optional).annotate({
    description: "Replace all exact occurrences of oldString (default false)",
  }),
})

export const Output = Schema.Struct({
  files: Schema.Array(FileDiff.Info),
  replacements: Schema.Number,
})
export type Output = typeof Output.Type

const splitBom = (text: string) =>
  text.startsWith("\uFEFF") ? { bom: true, text: text.slice(1) } : { bom: false, text }
const joinBom = (text: string, bom: boolean) => (bom ? `\uFEFF${text}` : text)
const decodeUtf8 = (content: Uint8Array) => {
  const bom = content[0] === 0xef && content[1] === 0xbb && content[2] === 0xbf
  return { bom, content, text: new TextDecoder().decode(bom ? content.slice(3) : content) }
}

const countOccurrences = (content: string, search: string) => {
  if (search === "") return content.length + 1
  let count = 0
  let offset = 0
  while ((offset = content.indexOf(search, offset)) !== -1) {
    count++
    offset += search.length
  }
  return count
}

export const toModelOutput = (output: Output) =>
  [
    `Edited file successfully: ${output.files[0]?.file}`,
    `Replacements: ${output.replacements}`,
    "Changed:",
    "```diff",
    // 展示真实文件 diff，第七行以后的修改和 formatter 变化同样可见。
    ...output.files.map((file) => file.patch),
    "```",
    // 最终文件 diff 保持完整；LSP 固定停用，不能把成功当作诊断通过。
    "\nLSP diagnostics unavailable (no language server running). Run bun typecheck to verify type safety.",
  ].join("\n")

/** Deferred V2 edit behavior and UX integrations remain visible at the model-facing seam. */
// TODO: Port V1 fuzzy correction strategies only after exact-edit behavior is established: line-trimmed matching, block-anchor fallback, indentation correction, and similarity-threshold review.
// TODO: Publish watcher/file-edit events after V2 watcher integration exists.
// TODO: Add snapshots / undo after design exists.
// TODO: Add LSP notification and diagnostics after V2 LSP runtime exists.

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const mutation = yield* LocationMutation.Service
    const files = yield* FileMutation.Service
    const fs = yield* FSUtil.Service
    const permission = yield* PermissionV2.Service
    const format = yield* Format.Service

    yield* tools
      .register({
        [name]: Tool.withPermission(
          Tool.make({
            description:
              "Replace exact text in one file. Relative paths resolve within the active Location. Absolute paths inside the Location are accepted. Explicit external absolute paths require external_directory approval before edit approval.",
            input: Input,
            output: Output,
            toModelOutput: ({ output }) => [
              { type: "text", text: toModelOutput(output) },
            ],
            execute: (input, context) => {
              const unableToEdit = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
                effect.pipe(
                  Effect.mapError((error) =>
                    error instanceof FileMutation.StaleContentError
                      ? new ToolFailure({
                          message: "File changed after permission approval. Read it again before editing.",
                        })
                      : new ToolFailure({ message: PermissionV2.autoDeniedMessage(error) ?? `Unable to edit ${input.path}` }),
                  ),
                )

              return Effect.gen(function* () {
                const permissionSource = {
                  type: "tool" as const,
                  messageID: context.assistantMessageID,
                  callID: context.toolCallID,
                }
                if (input.oldString === input.newString) {
                  return yield* new ToolFailure({
                    message: "No changes to apply: oldString and newString are identical.",
                  })
                }
                if (input.oldString === "") {
                  return yield* new ToolFailure({
                    message: "oldString must not be empty. Use write to create or overwrite a file.",
                  })
                }

                const target = yield* unableToEdit(mutation.resolve({ path: input.path, kind: "file" }))
                const external = target.externalDirectory
                if (external) {
                  yield* unableToEdit(
                    permission.assert({
                      ...LocationMutation.externalDirectoryPermission(external),
                      sessionID: context.sessionID,
                      agent: context.agent,
                      metadata: {
                        // 保留原生diff证据，补齐共享reviewer需要的操作与原始替换负载。
                        filepath: target.canonical, diff: JSON.stringify({ oldString: input.oldString, newString: input.newString, replaceAll: input.replaceAll }),
                        action_kind: "tool", tool: "edit", operation: "edit",
                        oldString: input.oldString, newString: input.newString, replaceAll: input.replaceAll === true,
                      },
                      source: permissionSource,
                    }),
                  )
                }

                yield* unableToEdit(
                  permission.assert({
                    action: "edit",
                    resources: [target.resource],
                    save: ["*"],
                    sessionID: context.sessionID,
                    agent: context.agent,
                      metadata: { filepath: target.canonical, diff: JSON.stringify({ oldString: input.oldString, newString: input.newString, replaceAll: input.replaceAll }) },
                    source: permissionSource,
                  }),
                )
                const source = decodeUtf8(yield* unableToEdit(fs.readFile(target.canonical)))
                const ending = detectLineEnding(source.text)
                // LF 目标也先归一请求，保留原有 CRLF 请求编辑 LF 文件的匹配能力。
                const oldString = convertToLineEnding(normalizeLineEndings(input.oldString), ending)
                const newString = convertToLineEnding(normalizeLineEndings(input.newString), ending)
                const replacements = countOccurrences(source.text, oldString)
                if (replacements === 0) {
                  return yield* new ToolFailure({
                    message:
                      "Could not find oldString in the file. It must match exactly, including whitespace and indentation.",
                  })
                }
                if (replacements > 1 && input.replaceAll !== true) {
                  return yield* new ToolFailure({
                    message:
                      "Found multiple exact matches for oldString. Provide more surrounding context or set replaceAll to true.",
                  })
                }

                const replaced =
                  input.replaceAll === true
                    // newString 是字面文本，不能把 $&、$1 等误执行为替换表达式。
                    ? source.text.replaceAll(oldString, () => newString)
                    : source.text.replace(oldString, () => newString)
                const diffOld = normalizeLineEndings(source.text)
                const diffNew = normalizeLineEndings(replaced)
                // 统计和展示共用逻辑文本，CR-only 不得被误计成整行替换。
                const counts = diffLines(diffOld, diffNew).reduce(
                  (result, item) => ({
                    additions: result.additions + (item.added ? (item.count ?? 0) : 0),
                    deletions: result.deletions + (item.removed ? (item.count ?? 0) : 0),
                  }),
                  { additions: 0, deletions: 0 },
                )
                const next = splitBom(replaced)
                const result = yield* unableToEdit(
                  files.writeIfUnchanged({
                    target,
                    expected: source.content,
                    content: joinBom(next.text, source.bom || next.bom),
                    format: format.file,
                  }),
                )
                return {
                  files: [
                    {
                      file: result.resource,
                      patch: result.diff ?? createTwoFilesPatch(result.resource, result.resource, diffOld, diffNew),
                      status: "modified" as const,
                      ...(result.text === undefined ? counts : diffLines(diffOld, normalizeLineEndings(result.text)).reduce(
                        (total, change) => ({
                          additions: total.additions + (change.added ? change.count ?? 0 : 0),
                          deletions: total.deletions + (change.removed ? change.count ?? 0 : 0),
                        }),
                        { additions: 0, deletions: 0 },
                      )),
                    },
                  ],
                  replacements,
                } satisfies Output
              })
            },
          }),
          "edit",
        ),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/edit",
  layer,
  deps: [ToolRegistry.node, LocationMutation.node, FileMutation.node, FSUtil.node, PermissionV2.node, Format.node],
})
