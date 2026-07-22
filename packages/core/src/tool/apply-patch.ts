export * as ApplyPatchTool from "./apply-patch"

import { ToolFailure } from "@opencode-ai/llm"
import { FileDiff } from "@opencode-ai/schema/file-diff"
import { createTwoFilesPatch, diffLines } from "diff"
import { Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { FileMutation } from "../file-mutation"
import { FSUtil } from "../fs-util"
import { LocationMutation } from "../location-mutation"
import { Patch } from "../patch"
import { PermissionV2 } from "../permission"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"
import { Format } from "../format"
import { normalizeLineEndings } from "../util/line-ending"

export const name = "apply_patch"

export const Input = Schema.Struct({
  patchText: Schema.String.annotate({
    description: "The full patch text describing add, update, and delete operations",
  }),
})

export const Applied = Schema.Struct({
  type: Schema.Literals(["add", "update", "delete"]),
  resource: Schema.String,
  target: Schema.String,
})

export const Output = Schema.Struct({
  applied: Schema.Array(Applied),
  files: Schema.Array(FileDiff.Info),
  errors: Schema.optional(Schema.Array(Schema.String)),
})
export type Output = typeof Output.Type

export const toModelOutput = (output: Output) =>
  [
    "Applied patch sequentially:",
    ...output.applied.map(
      (item) => `${item.type === "add" ? "A" : item.type === "delete" ? "D" : "M"} ${item.resource}`,
    ),
    "",
    "Changed:",
    "```diff",
    ...output.files.map((file) => file.patch),
    "```",
    // 批次最终 diff 与诊断状态独立，不用不可用提示替代真实改动。
    "\nLSP diagnostics unavailable (no language server running). Run bun typecheck to verify type safety.",
    ...(output.errors?.length ? [`\nFailed to update ${output.errors.length} file(s):`, ...output.errors] : []),
  ].join("\n")

type Prepared =
  | (Extract<Patch.Hunk, { readonly type: "add" | "delete" }> & {
      readonly target: LocationMutation.Target
      readonly before: string
      readonly after: string
    })
  | (Extract<Patch.Hunk, { readonly type: "update" }> & {
      readonly target: LocationMutation.Target
      readonly source: Uint8Array
      readonly destination?: LocationMutation.Target
      readonly content: string
      readonly before: string
      readonly after: string
    })

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
              "Apply one patch containing add, update, delete, and move file operations. Add File replaces an existing file; Delete File followed by Add File at the same path rewrites it. Use *** Move to: after Update File to rename while applying changes. Update chunks for one canonical file locate against one original snapshot: complete exact lines share uniqueness checks with PI-normalized lines, then unique literal or reversible PI-normalized substrings preserve surrounding text. Ambiguous or overlapping edits fail; nearby candidates are diagnostic only. All source and destination targets are resolved and approved before contents are read. Distinct file operations apply sequentially; earlier operations remain applied if a later commit fails. Atomic rollback is not supported.",
            input: Input,
            output: Output,
            toModelOutput: ({ output }) => [{ type: "text", text: toModelOutput(output) }],
            execute: (input, context) => {
              const applied: Array<typeof Applied.Type> = []
              const fail = (path: string, error?: unknown) => {
                const prefix =
                  applied.length === 0
                    ? `Unable to apply patch at ${path}`
                    : `Patch partially applied before failing at ${path}. Applied: ${applied.map((item) => item.resource).join(", ")}`
                return new ToolFailure({ message: PermissionV2.autoDeniedMessage(error) ?? prefix })
              }
              return Effect.gen(function* () {
                const source = {
                  type: "tool" as const,
                  messageID: context.assistantMessageID,
                  callID: context.toolCallID,
                }
                if (!input.patchText.trim()) return yield* new ToolFailure({ message: "patchText is required" })
                const hunks = yield* Effect.try({
                  try: () => Patch.parse(input.patchText),
                  catch: (cause) => new ToolFailure({ message: `apply_patch verification failed: ${String(cause)}` }),
                })
                if (hunks.length === 0) return yield* new ToolFailure({ message: "patch rejected: empty patch" })

                const targets: Array<{ readonly hunk: Patch.Hunk; readonly target: LocationMutation.Target; readonly destination?: LocationMutation.Target }> = []
                for (const hunk of hunks) {
                  const target = yield* mutation.resolve({ path: hunk.path, kind: "file" })
                  const destination = hunk.type === "update" && hunk.movePath
                    ? yield* mutation.resolve({ path: hunk.movePath, kind: "file" }) : undefined
                  targets.push({ hunk, target, destination })
                }
                // 重复 update 可组合，Delete/Add 可重写；跨源 Move 争用不能靠提交顺序猜测。
                const groups = new Map<string, typeof targets>()
                const destinations = new Map<string, string>()
                for (const item of targets) {
                  const group = groups.get(item.target.canonical) ?? []
                  group.push(item)
                  groups.set(item.target.canonical, group)
                  const destination = item.destination
                  if (!destination || destination.canonical === item.target.canonical) continue
                  const owner = destinations.get(destination.canonical)
                  if (owner && owner !== item.target.canonical || targets.some(other => other.target.canonical === destination.canonical)) return yield* fail(item.hunk.path)
                  if (group.some(other => other.destination && other.destination.canonical !== destination.canonical)) return yield* fail(item.hunk.path)
                  destinations.set(destination.canonical, item.target.canonical)
                }
                for (const group of groups.values()) {
                  const rewrite = group.length === 2 && group[0].hunk.type === "delete" && group[1].hunk.type === "add"
                  if (group.length > 1 && !rewrite && group.some(item => item.hunk.type !== "update")) return yield* fail(group[0].hunk.path)
                }

                // 相同目录和操作仍合并授权；不同操作保留各自语义并携带完整patch。
                const externalDirectories = new Map<string, LocationMutation.ExternalDirectoryAuthorization & { operation: Patch.Hunk["type"] | "move" }>()
                for (const { hunk, target, destination } of targets) {
                  // Move目的地有独立授权边界，不能用源路径审批代替。
                  for (const entry of [{ target, operation: hunk.type }, ...(destination ? [{ target: destination, operation: "move" as const }] : [])]) {
                    const external = entry.target.externalDirectory
                    if (external) externalDirectories.set(`${external.resource}:${entry.operation}`, { ...external, operation: entry.operation })
                  }
                }
                for (const external of externalDirectories.values()) {
                  yield* permission.assert({
                    ...LocationMutation.externalDirectoryPermission(external),
                    metadata: { action_kind: "tool", tool: "apply_patch", operation: external.operation, patchText: input.patchText },
                    sessionID: context.sessionID,
                    agent: context.agent,
                    source,
                  })
                }
                yield* permission.assert({
                  action: "edit",
                  // 审批前仅传解析计划；不读取目标来填充diff或伪造删除行数。
                  metadata: { files: targets.flatMap(item => [{ type: item.destination ? "move" : item.hunk.type, relativePath: item.target.resource }, ...(item.destination ? [{ type: "add", relativePath: item.destination.resource }] : [])]), patchText: input.patchText },
                  resources: [...new Set(targets.flatMap(({ target, destination }) => [target.resource, ...(destination ? [destination.resource] : [])]))],
                  save: ["*"],
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source,
                })

                // 既有groups已拒绝冲突操作；仅合并update，保留mixed Delete/Add及跨文件顺序。
                const updates = new Map<string, Patch.UpdateFileChunk[]>()
                const grouped = targets.flatMap((entry): typeof targets => {
                  if (entry.hunk.type !== "update") return [entry]
                  const chunks = updates.get(entry.target.canonical)
                  if (chunks) { chunks.push(...entry.hunk.chunks); return [] }
                  const combined = [...entry.hunk.chunks]
                  updates.set(entry.target.canonical, combined)
                  return [{ ...entry, hunk: { ...entry.hunk, chunks: combined } }]
                })
                // 授权仍先于读盘；预备失败只排除对应文件，不丢弃其他已验证操作。
                const errors: string[] = []
                const prepared: Prepared[] = []
                const expected = new Map<string, { target: LocationMutation.Target; content: Uint8Array | undefined }>()
                const failed = new Set<string>()
                for (const { hunk, target } of grouped) {
                  if (failed.has(target.canonical)) continue
                  yield* Effect.gen(function* () {
                    // Move可在后entry才声明，两端仍沿原始完整targets授权并从既有group取最终目的地。
                    const destination = groups.get(target.canonical)?.findLast(item => item.destination)?.destination
                    const snapshot = expected.get(target.canonical) ?? { target, content: yield* fs.readFile(target.canonical).pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(undefined))) }
                    expected.set(target.canonical, snapshot)
                    if (hunk.type === "add") {
                      prepared.push({
                        ...hunk,
                        target,
                        before: "",
                        after:
                          hunk.contents.endsWith("\n") || hunk.contents === "" ? hunk.contents : `${hunk.contents}\n`,
                      })
                      return
                    }
                    if ((yield* fs.stat(target.canonical)).type !== "File") yield* fail(hunk.path)
                    const source = snapshot.content
                    if (source === undefined) return yield* fail(hunk.path)
                    const original = new TextDecoder("utf-8", { ignoreBOM: true }).decode(source)
                    const before = original.replace(/^\uFEFF/, "")
                    if (hunk.type === "delete") {
                      prepared.push({ ...hunk, target, before, after: "" })
                      return
                    }
                    const update = yield* Effect.try({
                      try: () => Patch.derive(hunk.path, hunk.chunks, original),
                      // owning Patch保留失败chunk身份；此处不再运行第二套猜测位置的matcher。
                      catch: (error) => new ToolFailure({ message: String(error) }),
                    })
                    if (destination && !expected.has(destination.canonical)) {
                      expected.set(destination.canonical, { target: destination, content: yield* fs.readFile(destination.canonical).pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(undefined))) })
                    }
                    // 同源全部chunks已对同一原文派生，最后只提交一次并保留真实Move目标。
                    const change = {
                      ...hunk,
                      target,
                      source,
                      destination,
                      content: Patch.joinBom(update.content, update.bom),
                      before,
                      after: update.content,
                    }
                    prepared.push(change)
                  }).pipe(Effect.catch(error => {
                    failed.add(target.canonical)
                    const index = prepared.findIndex(change => change.target.canonical === target.canonical)
                    if (index !== -1) prepared.splice(index, 1)
                    errors.push(error instanceof ToolFailure ? error.message : fail(hunk.path).message)
                    return Effect.void
                  }))
                }

                if (prepared.length === 0) return yield* new ToolFailure({ message: errors.join("\n") })
                const patchFiles: Array<typeof FileDiff.Info.Type> = []
                yield* files.commit({
                  expected: [...expected.values()].filter(item => prepared.some(change => change.target.canonical === item.target.canonical || change.type === "update" && change.destination?.canonical === item.target.canonical)),
                  execute: files => Effect.forEach(
                  prepared,
                  (change) =>
                    Effect.gen(function* () {
                      if (change.type === "add") {
                        const result = yield* files.writeTextPreservingBom({
                          target: change.target,
                          content:
                            change.contents.endsWith("\n") || change.contents === ""
                              ? change.contents
                              : `${change.contents}\n`,
                          format: format.file,
                        })
                        applied.push({ type: change.type, resource: result.resource, target: result.target })
                        // Add覆盖也报告持锁前像，而不是将已有正文伪装成空文件。
                        patchFiles.push({ ...patchFile({ ...change, before: result.previous ?? "", after: result.text ?? change.after.replace(/^\uFEFF+/, "") }), status: result.existed ? "modified" : "added" })
                        return
                      }
                      if (change.type === "delete") {
                        const result = yield* files.remove({ target: change.target })
                        applied.push({ type: change.type, resource: result.resource, target: result.target })
                        patchFiles.push(patchFile(change))
                        return
                      }
                      const moving = change.destination && change.destination.canonical !== change.target.canonical ? change.destination : undefined
                      const write = {
                        target: change.target,
                        expected: change.source,
                        content: change.content,
                        format: format.file,
                      }
                      const result = yield* (moving ? files.moveIfUnchanged({ ...write, destination: moving }) : files.writeIfUnchanged(write))
                      if (moving) {
                        // 用既有删除/创建合同呈现真实两端变化，不新增无人消费的move状态。
                        applied.push({ type: "delete", resource: change.target.resource, target: change.target.canonical })
                        applied.push({ type: result.existed ? "update" : "add", resource: result.resource, target: result.target })
                        patchFiles.push(patchFile({ ...change, type: "delete", after: "" }))
                        patchFiles.push({ ...patchFile({ ...change, target: moving, before: result.previous ?? "", after: result.text ?? change.after }), status: result.existed ? "modified" : "added" })
                        return
                      }
                      applied.push({ type: change.type, resource: result.resource, target: result.target })
                      patchFiles.push(patchFile({ ...change, after: result.text ?? change.after }))
                    }).pipe(Effect.mapError(error => error instanceof FileMutation.MoveIncompleteError
                      ? new ToolFailure({ message: `${fail(change.path).message}. Destination ${error.destination} was written, but source ${error.path} could not be removed: ${error.reason}` })
                      : fail(change.path))),
                  { discard: true },
                ) })
                return { applied, files: patchFiles, ...(errors.length ? { errors } : {}) }
              }).pipe(Effect.mapError(error => error instanceof FileMutation.StaleContentError
                ? new ToolFailure({ message: `File changed before commit: ${error.path}. Read the file again and retry.` })
                : error instanceof ToolFailure ? error : fail("patch", error)))
            },
          }),
          "edit",
        ),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/apply-patch",
  layer,
  deps: [ToolRegistry.node, LocationMutation.node, FileMutation.node, FSUtil.node, PermissionV2.node, Format.node],
})

function patchFile(change: Prepared): typeof FileDiff.Info.Type {
  const before = normalizeLineEndings(change.before)
  const after = normalizeLineEndings(change.after)
  // 增删统计与展示共用同一逻辑行视图，写入仍使用 prepared 原始内容。
  const counts = diffLines(before, after).reduce(
    (result, item) => ({
      additions: result.additions + (item.added ? (item.count ?? 0) : 0),
      deletions: result.deletions + (item.removed ? (item.count ?? 0) : 0),
    }),
    { additions: 0, deletions: 0 },
  )
  return {
    file: change.target.resource,
    patch: createTwoFilesPatch(change.target.resource, change.target.resource, before, after),
    status: change.type === "add" ? "added" : change.type === "delete" ? "deleted" : "modified",
    ...counts,
  }
}
