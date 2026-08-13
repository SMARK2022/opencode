/**
 * Model-facing V2 exact-edit leaf. Relative paths resolve within the active
 * Location. Absolute paths inside that Location are accepted, while explicit
 * absolute external paths retain mutation capability through a separate
 * external_directory approval before edit approval.
 */
export * as EditTool from "./edit"

import path from "path"
import { ToolFailure } from "@opencode-ai/llm"
import { FileDiff } from "@opencode-ai/schema/file-diff"
import { createTwoFilesPatch, diffLines } from "diff"
import { Effect, Layer, Schema, SchemaGetter } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { FileMutation } from "../file-mutation"
import { FSUtil } from "../fs-util"
import { LocationMutation } from "../location-mutation"
import { Location } from "../location"
import { SessionStore } from "../session/store"
import { PermissionV2 } from "../permission"
import { ToolRegistry } from "./registry"
import { closestMatch } from "./edit-excerpt"
import { EditApply } from "./edit-apply"
import { Tool } from "./tool"
import { Tools } from "./tools"
import { Format } from "../format"
import { convertToLineEnding, detectLineEnding, normalizeLineEndings } from "../util/line-ending"

export const name = "edit"

const EditItem = Schema.Struct({
  oldString: Schema.String.annotate({
    description: "Exact text for one targeted replacement. It must be unique in the original file (unless replaceAll) and must not overlap other edits[].oldString in the same call.",
  }),
  newString: Schema.String.annotate({ description: "Replacement text for this targeted edit." }),
  replaceAll: Schema.Boolean.pipe(Schema.optional).annotate({
    description: "Replace all occurrences of oldString for this edit (default false)",
  }),
})

export const Input = Schema.Struct({
  path: Schema.String.annotate({
    description:
      "File path to edit. Relative paths resolve within the active Location. Absolute paths inside that Location are accepted; external absolute paths require external_directory approval.",
  }),
  edits: Schema.mutable(Schema.Array(EditItem)).annotate({
    description: "One or more targeted replacements. Each edit is matched against the original file, not incrementally. Do not include overlapping or nested edits. If two changes touch the same block or nearby lines, merge them into one edit instead.",
  }),
})

// 折叠只发生在原 codec 中；广告仍用 Input，不增加 registry 执行或通用兼容入口。
const InvocationInput = Schema.Unknown.pipe(
  Schema.decodeTo(Schema.Unknown, {
    decode: SchemaGetter.transform(EditApply.prepareEditArguments),
    encode: SchemaGetter.passthrough(),
  }),
  Schema.decodeTo(Input),
)

export const Output = Schema.Struct({
  files: Schema.Array(FileDiff.Info),
  replacements: Schema.Number,
  syncInput: Schema.optional(Input),
  // 模型回执与结构化结果共用同一跳写事实，不从 formatter 后的 diff 猜测无操作数量。
  warning: Schema.optional(Schema.String),
})
export type Output = typeof Output.Type

const splitBom = (text: string) =>
  text.startsWith("\uFEFF") ? { bom: true, text: text.slice(1) } : { bom: false, text }
const joinBom = (text: string, bom: boolean) => (bom ? `\uFEFF${text}` : text)
const decodeUtf8 = (content: Uint8Array) => {
  const bom = content[0] === 0xef && content[1] === 0xbb && content[2] === 0xbf
  return { bom, content, text: new TextDecoder().decode(bom ? content.slice(3) : content) }
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
    // 通用 owner 默认保留 head+tail，末尾 warning 不需要复制 V1 的 head 截断补偿。
    ...(output.warning ? ["", output.warning] : []),
  ].join("\n")

/** Deferred V2 edit behavior and UX integrations remain visible at the model-facing seam. */
// 字面匹配现为两代共同合同，不再等待移植已明确弃用的fuzzy成功路径。
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
    const location = yield* Location.Service
    const sessions = yield* SessionStore.Service

    yield* tools
      .register({
        [name]: Tool.withPermission(
          Tool.make({
            // 恢复只认本助手实际成功声明的文件，不接纳整个快照窗口。
            worktree: "declared",
            description: [
              "Performs string replacements in files. Supports one or more disjoint edits in a single call. Relative paths resolve within the active Location; external absolute paths require external_directory approval before edit approval.",
              "",
              "Usage:",
              "- You must use your Read tool at least once in the conversation before editing. This tool will error if you attempt an edit without reading the file.",
              "- When editing text from Read tool output, ensure you preserve the exact indentation (tabs/spaces) as it appears AFTER the line number prefix. The line number prefix format is: line number + colon + space (e.g., `1: `). Everything after that space is the actual file content to match. Never include any part of the line number prefix in the oldString or newString.",
              "- ALWAYS prefer editing existing files in the codebase. NEVER write new files unless explicitly required.",
              "- Prefer one call with multiple entries in edits[] for disjoint regions in the same file instead of multiple edit calls.",
              "- Each edits[].oldString is matched against the original file snapshot, not after earlier edits in the same call. Do not emit overlapping or nested edits; merge nearby changes into one edit.",
              "- Keep each oldString as small as possible while still unique. Do not pad with large unchanged regions.",
              "- Matching tries exact unique literal first, then a conservative normalized form (trailing line whitespace and common unicode quote/dash/space variants). Uniqueness and replaceAll both count under that same normalized-aware domain (e.g. ASCII hyphen and en-dash siblings count as multiples).",
              "- Indent/tab differences and escape artifacts still fail; re-read and copy exact text.",
              "- The edit will FAIL if oldString is found multiple times without replaceAll. Provide more surrounding context to make it unique or set replaceAll on that edit item.",
              "- Use replaceAll on an edit item to rename a string across the file.",
              "- Use Write to create or overwrite files; edits[].oldString must not be empty.",
              "- If both edits and legacy top-level oldString/newString are sent, edits wins when non-empty.",
              "- Successful normalized matches may rewrite the recorded oldString in tool history to the actual file text that was replaced.",
            ].join("\n"),
            input: InvocationInput,
            inputSchema: Schema.toJsonSchemaDocument(Input).schema,
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
                if (input.edits.length === 0) {
                  return yield* new ToolFailure({
                    message: "edits must contain at least one replacement.",
                  })
                }
                // 与 V1 一样先定位/校验，混批中的 identical 条目由共享引擎跳写。
                if (input.edits.some(edit => edit.oldString === "")) {
                  return yield* new ToolFailure({
                    message: "oldString must not be empty. Use write to create or overwrite a file.",
                  })
                }

                const target = yield* unableToEdit(mutation.resolve({ path: input.path, kind: "file" }))
                // 只使用本Session实际可见的完成态工具历史；条件写入新鲜度不能替代此前检查。
                const resolveForCompare = (value: string) => {
                  const resolved = path.resolve(location.directory, value)
                  return process.platform === "win32" ? resolved.toLowerCase() : resolved
                }
                const filePath = path.resolve(location.directory, input.path)
                const hasTouched = (yield* unableToEdit(sessions.context(context.sessionID))).some(message =>
                  message.type === "assistant" && message.content.some(part => {
                    if (part.type !== "tool" || part.state.status !== "completed") return false
                    if (part.name !== "read" && part.name !== "write" && part.name !== "edit") return false
                    return typeof part.state.input.path === "string" && resolveForCompare(part.state.input.path) === resolveForCompare(filePath)
                  }))
                if (!hasTouched) return yield* new ToolFailure({
                  message: `File has not been read in this session: ${filePath}. Read it first to verify current content, then retry the edit.`,
                })
                // 目标正文仍须等两项权限通过才读取，源工具名与错误原话均不扩展。
                const external = target.externalDirectory
                if (external) {
                  yield* unableToEdit(
                    permission.assert({
                      ...LocationMutation.externalDirectoryPermission(external),
                      sessionID: context.sessionID,
                      agent: context.agent,
                      metadata: {
                        // 保留原生diff证据，补齐共享reviewer需要的操作与原始替换负载。
                        filepath: target.canonical, diff: JSON.stringify({ edits: input.edits }),
                        action_kind: "tool", tool: "edit", operation: "edit",
                        edits: input.edits,
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
                      metadata: { filepath: target.canonical, diff: JSON.stringify({ edits: input.edits }) },
                    source: permissionSource,
                  }),
                )
                const source = decodeUtf8(yield* unableToEdit(fs.readFile(target.canonical)))
                const ending = detectLineEnding(source.text)
                const baseLF = normalizeLineEndings(source.text)
                const editsLF = input.edits.map(edit => ({
                  oldString: normalizeLineEndings(edit.oldString),
                  newString: normalizeLineEndings(edit.newString),
                  replaceAll: edit.replaceAll,
                }))
                // 整批先在同一快照匹配；失败候选只解释，绝不参与成功替换。
                const applied = yield* Effect.try({
                  try: () => EditApply.applyEdits(baseLF, editsLF, input.path),
                  catch: (error) => {
                    const message = error instanceof Error ? error.message : String(error)
                    if (!(error instanceof EditApply.EditApplyError) || !message.includes("Could not find")) return new ToolFailure({ message })
                    // Native与V1消费同一失败索引，不能把前项归一化成功误判为本次失败。
                    const probe = editsLF[error.editIndex]
                    if (!probe) return new ToolFailure({ message })
                    const closest = closestMatch(source.text, convertToLineEnding(probe.oldString, ending))
                    return new ToolFailure({
                      message: message + (closest ? `\n\nClosest match at line ${closest.line}:\n${closest.excerpt}` : "\n\nNo reliable nearby candidate was found. Read the file and retry with exact text."),
                    })
                  },
                })
                // 替换次数只统计真正写入项；跳写计数按 LF 提交形态，与引擎和历史一致。
                const unchangedEntries = editsLF.filter(edit => edit.oldString === edit.newString).length
                const replacements = editsLF.reduce((count, edit) => edit.oldString === edit.newString ? count : count + (edit.replaceAll ? EditApply.countOccurrences(baseLF, edit.oldString) : 1), 0)
                const replaced = convertToLineEnding(applied.contentNew, ending)
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
                  // 此处只能由整批有真实变化的成功路径抵达，warning 不会把全 no-op 伪装成成功。
                  ...(unchangedEntries > 0 ? {
                    warning: `Warning: ${unchangedEntries} of ${input.edits.length} edit(s) were no-ops (oldString equals newString) and did not change the file.`,
                  } : {}),
                  // 仅保存实际旧 needle；非创建编辑不猜测 formatter 后的局部新 needle。
                  syncInput: { path: input.path, edits: applied.syncEdits.map(edit => ({
                    oldString: convertToLineEnding(edit.oldString, ending),
                    newString: convertToLineEnding(edit.newString, ending),
                    ...(edit.replaceAll === true ? { replaceAll: true } : {}),
                  })) },
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
  deps: [ToolRegistry.node, LocationMutation.node, FileMutation.node, FSUtil.node, PermissionV2.node, Format.node, Location.node, SessionStore.node],
})
