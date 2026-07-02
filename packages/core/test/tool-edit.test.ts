import fs from "fs/promises"
import path from "path"
import { fileURLToPath } from "url"
import { describe, expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FileMutation } from "@opencode-ai/core/file-mutation"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Location } from "@opencode-ai/core/location"
import { LocationMutation } from "@opencode-ai/core/location-mutation"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionStore } from "@opencode-ai/core/session/store"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { EditTool } from "@opencode-ai/core/tool/edit"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { toolIdentity, executeTool, settleTool, toolDefinitions, toolHistory } from "./lib/tool"

const sessionID = SessionV2.ID.make("ses_edit_tool_test")
const assertions: PermissionV2.AssertInput[] = []
const writes: string[] = []
let reads = 0
let denyAction: string | undefined
let denyReason: string | undefined
let afterRead = (_target: string, _content: Uint8Array): Effect.Effect<void> => Effect.void

const permission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    assert: (input) =>
      Effect.sync(() => assertions.push(input)).pipe(
        Effect.andThen(
          input.action === denyAction ? Effect.fail(new PermissionV2.BlockedError({ rules: [], reason: denyReason })) : Effect.void,
        ),
      ),
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)

const reset = () => {
  assertions.length = 0
  writes.length = 0
  reads = 0
  denyAction = undefined
  denyReason = undefined
  afterRead = () => Effect.void
}

const filesystem = Layer.effect(
  FSUtil.Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    return FSUtil.Service.of({
      ...fs,
      readFile: (target) =>
        fs
          .readFile(target)
          .pipe(
            Effect.tap((content) =>
              Effect.sync(() => reads++).pipe(Effect.andThen(Effect.suspend(() => afterRead(target, content)))),
            ),
          ),
      writeWithDirs: (target, content, mode) =>
        Effect.sync(() => writes.push(target)).pipe(Effect.andThen(fs.writeWithDirs(target, content, mode))),
      writeFile: (target, content, options) =>
        Effect.sync(() => writes.push(target)).pipe(Effect.andThen(fs.writeFile(target, content, options))),
      writeFileString: (target, content, options) =>
        Effect.sync(() => writes.push(target)).pipe(Effect.andThen(fs.writeFileString(target, content, options))),
    })
  }),
).pipe(Layer.provide(LayerNode.compile(FSUtil.node)))

const withTool = <A, E, R>(directory: string, body: (registry: ToolRegistry.Interface) => Effect.Effect<A, E, R>, history: ReturnType<typeof toolHistory> = []) => {
  const activeLocation = Layer.succeed(
    Location.Service,
    Location.Service.of(location({ directory: AbsolutePath.make(directory) })),
  )
  return Effect.gen(function* () {
    return yield* body(yield* ToolRegistry.Service)
  }).pipe(
    Effect.provide(
      AppNodeBuilder.build(
        LayerNode.group([
          ToolRegistry.node,
          ToolRegistry.toolsNode,
          LocationMutation.node,
          FileMutation.node,
          EditTool.node,
        ]),
        [
          [FSUtil.node, filesystem],
          [Location.node, activeLocation],
          [PermissionV2.node, permission],
          [SessionStore.node, Layer.mock(SessionStore.Service, { context: id => Effect.succeed(id === sessionID ? history : []) })],
          [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
        ],
      ),
    ),
  )
}

const call = (input: typeof EditTool.Input.Type, id = "call-edit") => ({
  sessionID,
  ...toolIdentity,
  call: { type: "tool-call" as const, id, name: "edit", input },
})

const it = testEffect(Layer.empty)

describe("EditTool", () => {
  it.live("registers and replaces relative exact text through FileMutation once", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        const target = path.join(tmp.path, "hello.txt")
        const history: ReturnType<typeof toolHistory> = []
        return Effect.promise(() => fs.writeFile(target, "before\nrest\n")).pipe(
          Effect.andThen(
            withTool(tmp.path, (registry) =>
              Effect.gen(function* () {
                expect((yield* toolDefinitions(registry)).map((tool) => tool.name)).toEqual(["edit"])
                // 相同真实leaf先验证缺失/跨Session历史均拒绝，再显式提供当前文件的已读证据。
                const blind = call({ path: "hello.txt", oldString: "before", newString: "after" })
                expect(yield* executeTool(registry, blind)).toEqual({ type: "error", value: `File has not been read in this session: ${target}. Read it first to verify current content, then retry the edit.` })
                history.push(...toolHistory("hello.txt"))
                expect(yield* executeTool(registry, { ...blind, sessionID: SessionV2.ID.make("ses_other") })).toEqual({ type: "error", value: `File has not been read in this session: ${target}. Read it first to verify current content, then retry the edit.` })
                expect(assertions).toEqual([])
                expect(reads).toBe(0)
                expect(writes).toEqual([])

                expect(yield* toolDefinitions(registry, [{ action: "edit", resource: "*", effect: "deny" }])).toEqual(
                  [],
                )
                const settled = yield* settleTool(
                  registry,
                  call({ path: "hello.txt", oldString: "before", newString: "after" }),
                )
                const shown = settled.result.type === "text" ? settled.result.value : ""
                expect(settled.result).toEqual({
                  type: "text",
                  value: expect.stringContaining("Edited file successfully: hello.txt\nReplacements: 1\nChanged:\n```diff\n"),
                })
                expect(settled.output?.structured).toEqual({
                  replacements: 1,
                  files: [
                    {
                      file: "hello.txt",
                      status: "modified",
                      additions: 1,
                      deletions: 1,
                      patch: expect.stringContaining("-before\n+after"),
                    },
                  ],
                })
                expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe("after\nrest\n")
                expect(shown).toContain("-before\n+after\n rest")
                expect(shown).toEndWith("\n\nLSP diagnostics unavailable (no language server running). Run bun typecheck to verify type safety.")
                expect(assertions).toMatchObject([{ sessionID, action: "edit", resources: ["hello.txt"], save: ["*"] }])
                expect(writes).toEqual([yield* Effect.promise(() => fs.realpath(target))])
              }),
              history,
            ),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("accepts an absolute file path inside the active Location", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        const target = path.join(tmp.path, "absolute.txt")
        return Effect.promise(() => fs.writeFile(target, "before")).pipe(
          Effect.andThen(
            withTool(tmp.path, (registry) =>
              executeTool(registry, call({ path: target, oldString: "before", newString: "after" })),
              toolHistory("absolute.txt", "write"),
            ),
          ),
          Effect.andThen((result) =>
            Effect.gen(function* () {
              expect(result.type).toBe("text")
              expect(assertions.map((input) => input.action)).toEqual(["edit"])
              expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe("after")
            }),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("approves an explicit external absolute path before edit", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => Promise.all([tmpdir(), tmpdir()])),
      ([active, outside]) => {
        reset()
        const target = path.join(outside.path, "external.txt")
        return Effect.promise(() => fs.writeFile(target, "before")).pipe(
          Effect.andThen(
            withTool(active.path, (registry) =>
              executeTool(registry, call({ path: target, oldString: "before", newString: "after" })),
              toolHistory(target, "edit"),
            ),
          ),
          Effect.andThen((result) =>
            Effect.gen(function* () {
              expect(result.type).toBe("text")
              expect(assertions.map((input) => input.action)).toEqual(["external_directory", "edit"])
              // 授权证据保留原始替换串，不通过提前读取外部文件生成第二份内容。
              expect(assertions[0]?.metadata).toMatchObject({ action_kind: "tool", tool: "edit", operation: "edit", oldString: "before", newString: "after" })
              expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe("after")
              expect(writes).toHaveLength(1)
            }),
          ),
        )
      },
      ([active, outside]) =>
        Effect.promise(() =>
          Promise.all([active[Symbol.asyncDispose](), outside[Symbol.asyncDispose]()]).then(() => undefined),
        ),
    ),
  )

  it.live("does not write when external_directory or edit approval is denied", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => Promise.all([tmpdir(), tmpdir()])),
      ([active, outside]) =>
        Effect.gen(function* () {
          const external = path.join(outside.path, "denied.txt")
          yield* Effect.promise(() => fs.writeFile(external, "before"))
          reset()
          denyAction = "external_directory"
          expect(
            yield* withTool(active.path, (registry) =>
              executeTool(registry, call({ path: external, oldString: "before", newString: "after" })),
              toolHistory(external),
            ),
          ).toEqual({
            type: "error",
            value: `Unable to edit ${external}`,
          })
          expect(assertions.map((input) => input.action)).toEqual(["external_directory"])
          expect(reads).toBe(0)
          expect(writes).toEqual([])

          reset()
          denyAction = "edit"
          expect(
            yield* withTool(active.path, (registry) =>
              executeTool(registry, call({ path: external, oldString: "before", newString: "after" })),
              toolHistory(external),
            ),
          ).toEqual({
            type: "error",
            value: `Unable to edit ${external}`,
          })
          expect(assertions.map((input) => input.action)).toEqual(["external_directory", "edit"])
          expect(reads).toBe(0)
          expect(writes).toEqual([])
          expect(yield* Effect.promise(() => fs.readFile(external, "utf8"))).toBe("before")
        }),
      ([active, outside]) =>
        Effect.promise(() =>
          Promise.all([active[Symbol.asyncDispose](), outside[Symbol.asyncDispose]()]).then(() => undefined),
        ),
    ),
  )

  it.live("denied edit reads no target content and does not disclose whether oldString matches", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        denyAction = "edit"
        const target = path.join(tmp.path, "secret.txt")
        return Effect.promise(() => fs.writeFile(target, "secret content")).pipe(
          Effect.andThen(
            withTool(tmp.path, (registry) =>
              Effect.gen(function* () {
                const matching = yield* executeTool(
                  registry,
                  call({ path: "secret.txt", oldString: "secret content", newString: "replacement" }),
                )
                const missing = yield* executeTool(
                  registry,
                  call({ path: "secret.txt", oldString: "not present", newString: "replacement" }),
                )

                expect(matching).toEqual({ type: "error", value: "Unable to edit secret.txt" })
                expect(missing).toEqual(matching)
                expect(assertions.map((input) => input.action)).toEqual(["edit", "edit"])
                expect(reads).toBe(0)
                expect(writes).toEqual([])

                // 自动拒绝保留审查反馈，但同样不能先探测文件内容。
                denyReason = "Automatic review rejected this edit. Ask the user before attempting it again."
                expect(yield* executeTool(registry, call({ path: "secret.txt", oldString: "secret content", newString: "replacement" }))).toEqual({ type: "error", value: denyReason })
                expect(reads).toBe(0)
                expect(writes).toEqual([])
              }),
              toolHistory("secret.txt"),
            ),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("rejects no-op, empty, missing, and ambiguous exact replacements", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        const target = path.join(tmp.path, "matches.txt")
        return Effect.promise(() => fs.writeFile(target, "same same")).pipe(
          Effect.andThen(
            withTool(tmp.path, (registry) =>
              Effect.gen(function* () {
                expect(
                  yield* executeTool(registry, call({ path: "matches.txt", oldString: "same", newString: "same" })),
                ).toEqual({
                  type: "error",
                  value: "No changes to apply: oldString and newString are identical.",
                })
                expect(
                  yield* executeTool(registry, call({ path: "matches.txt", oldString: "", newString: "after" })),
                ).toEqual({
                  type: "error",
                  value: "oldString must not be empty. Use write to create or overwrite a file.",
                })
                expect(
                  yield* executeTool(registry, call({ path: "matches.txt", oldString: "missing", newString: "after" })),
                ).toEqual({
                  type: "error",
                  value:
                    "Could not find oldString in the file. It must match exactly, including whitespace and indentation.\n\nClosest match at line 1:\nsame same",
                })
                expect(
                  yield* executeTool(registry, call({ path: "matches.txt", oldString: "same", newString: "after" })),
                ).toEqual({
                  type: "error",
                  value:
                    "Found multiple exact matches for oldString. Provide more surrounding context or set replaceAll to true.",
                })
                // 真实Native Edit失败必须显示900字符行末差异，不只证明孤立formatter可用。
                const prefix = "p".repeat(900)
                yield* Effect.promise(() => fs.writeFile(target, `return value;\n${prefix} private int x = 0;`))
                const mismatch = yield* executeTool(registry, call({ path: "matches.txt", oldString: `return value;\n${prefix} private int x = 1;`, newString: "replacement" }))
                expect(mismatch).toEqual({ type: "error", value: expect.stringContaining("x = 0") })
                expect(mismatch).toEqual({ type: "error", value: expect.stringContaining("x = 1") })
                expect(JSON.stringify(mismatch)).not.toContain("p".repeat(500))
                expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe(`return value;\n${prefix} private int x = 0;`)
                expect(writes).toEqual([])
              }),
              toolHistory("matches.txt"),
            ),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("replaces every exact occurrence when replaceAll is true", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        const target = path.join(tmp.path, "all.txt")
        return Effect.promise(() => fs.writeFile(target, "same same same")).pipe(
          Effect.andThen(
            withTool(tmp.path, (registry) =>
              settleTool(registry, call({ path: "all.txt", oldString: "same", newString: "after", replaceAll: true })),
              toolHistory("all.txt"),
            ),
          ),
          Effect.andThen((settled) =>
            Effect.gen(function* () {
              expect(settled.output?.structured).toMatchObject({ replacements: 3 })
              expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe("after after after")
              expect(writes).toHaveLength(1)
              const literal = "$&! $1 $` $' $$"
              const replaced = yield* withTool(tmp.path, (registry) => settleTool(registry, call({ path: "all.txt", oldString: "after", newString: literal, replaceAll: true })), toolHistory("all.txt", "edit"))
              expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe([literal, literal, literal].join(" "))
              expect(replaced.result).toMatchObject({ type: "text", value: expect.stringContaining(literal) })
              // 唯一变化在第七行，模型必须看到真实 diff，而非前六行输入片段。
              const original = "a\nb\nc\nd\ne\nf\ng\n"
              const final = "a\nb\nc\nd\ne\nf\nG\n"
              yield* Effect.promise(() => fs.writeFile(target, original))
              const lastLine = yield* withTool(tmp.path, (registry) => settleTool(registry, call({ path: "all.txt", oldString: original, newString: final })), toolHistory("all.txt", "edit"))
              expect(lastLine.result).toMatchObject({ value: expect.stringContaining("-g\n+G") })
              expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe(final)
            }),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("preserves BOM and file line endings in edits and diffs", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.gen(function* () {
        const target = path.join(tmp.path, "windows.txt")
        for (const ending of ["\n", "\r\n", "\r"]) {
          reset()
          yield* Effect.promise(() => fs.writeFile(target, `\uFEFFbefore${ending}rest${ending}`))
          // 真实 registry 结算还要校验逻辑 diff，不能只看到写盘正文正确。
          const settled = yield* withTool(tmp.path, (registry) =>
            settleTool(registry, call({ path: "windows.txt", oldString: "before\r\nrest", newString: "after\nrest" })),
            toolHistory("windows.txt"),
          )
          const output = Schema.decodeUnknownSync(EditTool.Output)(settled.output?.structured)
          expect(output.replacements).toBe(1)
          expect(output.files[0]).toMatchObject({ additions: 1, deletions: 1 })
          expect(output.files[0]?.patch).toContain("-before\n+after\n")
          expect(output.files[0]?.patch).not.toContain("\r")
          expect(output.files[0]?.patch).not.toContain("\uFEFF")
          expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe(`\uFEFFafter${ending}rest${ending}`)
          expect(writes).toHaveLength(1)
        }
      }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("rejects an in-place content change after matching but before conditional commit", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        const target = path.join(tmp.path, "concurrent.txt")
        afterRead = () => (reads === 1 ? Effect.promise(() => fs.writeFile(target, "newer\n")) : Effect.void)
        return Effect.promise(() => fs.writeFile(target, "before\n")).pipe(
          Effect.andThen(
            withTool(tmp.path, (registry) =>
              executeTool(registry, call({ path: "concurrent.txt", oldString: "before", newString: "after" })),
              toolHistory("concurrent.txt"),
            ),
          ),
          Effect.andThen((result) =>
            Effect.gen(function* () {
              expect(result).toEqual({
                type: "error",
                value: "File changed after permission approval. Read it again before editing.",
              })
              expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe("newer\n")
              expect(writes).toEqual([])
            }),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )
})

test("keeps the locked edit schema, semantics docstring, and deferred TODOs visible", async () => {
  const source = (await fs.readFile(new URL("../src/tool/edit.ts", import.meta.url), "utf8")).replaceAll("\r\n", "\n")
  const definition = await Effect.runPromise(
    withTool(path.dirname(fileURLToPath(import.meta.url)), (registry) => toolDefinitions(registry)),
  )
  const schema = definition[0]?.inputSchema as { readonly properties?: Record<string, unknown> }

  expect(Object.keys(schema.properties ?? {}).sort()).toEqual(["newString", "oldString", "path", "replaceAll"])
  expect(source).toContain(
    "absolute external paths retain mutation capability through a separate\n * external_directory approval before edit approval.",
  )
  for (const todo of [
    "Port V1 fuzzy correction strategies only after exact-edit behavior is established: line-trimmed matching, block-anchor fallback, indentation correction, and similarity-threshold review.",
    "Publish watcher/file-edit events after V2 watcher integration exists.",
    "Add snapshots / undo after design exists.",
    "Add LSP notification and diagnostics after V2 LSP runtime exists.",
  ]) {
    expect(source).toContain(`TODO: ${todo}`)
  }
})
