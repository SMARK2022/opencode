import fs from "fs/promises"
import path from "path"
import { fileURLToPath } from "url"
import { describe, expect, test } from "bun:test"
import { Cause, Effect, Exit, Fiber, Layer, Schema } from "effect"
import { Config } from "@opencode-ai/core/config"
import { EditTool } from "@opencode-ai/core/tool/edit"
import { ApplyPatchTool } from "@opencode-ai/core/tool/apply-patch"
import { FileMutation } from "@opencode-ai/core/file-mutation"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Location } from "@opencode-ai/core/location"
import { LocationMutation } from "@opencode-ai/core/location-mutation"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { WriteTool } from "@opencode-ai/core/tool/write"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { toolIdentity, executeTool, settleTool, toolDefinitions } from "./lib/tool"

const sessionID = SessionV2.ID.make("ses_write_tool_test")
const assertions: PermissionV2.AssertInput[] = []
const writes: string[] = []
let denyAction: string | undefined

const permission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    assert: (input) =>
      Effect.sync(() => assertions.push(input)).pipe(
        Effect.andThen(
          input.action === denyAction ? Effect.fail(new PermissionV2.BlockedError({ rules: [] })) : Effect.void,
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
  denyAction = undefined
}

const filesystem = Layer.effect(
  FSUtil.Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    return FSUtil.Service.of({
      ...fs,
      writeWithDirs: (target, content, mode) =>
        Effect.sync(() => writes.push(target)).pipe(Effect.andThen(fs.writeWithDirs(target, content, mode))),
    })
  }),
).pipe(Layer.provide(LayerNode.compile(FSUtil.node)))

const withTool = <A, E, R>(directory: string, body: (registry: ToolRegistry.Interface) => Effect.Effect<A, E, R>, formatting?: { formatter: Config.Info["formatter"]; tool?: "edit" | "apply_patch" }) => {
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
          formatting?.tool === "edit" ? EditTool.node : formatting?.tool === "apply_patch" ? ApplyPatchTool.node : WriteTool.node,
        ]),
        [
          [FSUtil.node, filesystem],
          [Location.node, activeLocation],
          [PermissionV2.node, permission],
          [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
          ...(formatting ? [
            [Config.node, Layer.succeed(Config.Service, Config.Service.of({ entries: () => Effect.succeed([new Config.Document({ type: "document", info: Schema.decodeUnknownSync(Config.Info)({ formatter: formatting.formatter }) })]) }))] as const,
          ] : []),
        ],
      ),
    ),
  )
}

const call = (input: typeof WriteTool.Input.Type, id = "call-write") => ({
  sessionID,
  ...toolIdentity,
  call: { type: "tool-call" as const, id, name: "write", input },
})

const it = testEffect(Layer.empty)

describe("WriteTool", () => {
  it.live("registers and creates a relative file through FileMutation once", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        return withTool(tmp.path, (registry) =>
          Effect.gen(function* () {
            expect((yield* toolDefinitions(registry)).map((tool) => tool.name)).toEqual(["write"])
            const settled = yield* settleTool(registry, call({ path: "src/new.txt", content: "created" }))
            expect(settled).toEqual({
              result: { type: "text", value: "Created file successfully: src/new.txt" },
              output: {
                structured: {
                  operation: "write",
                  target: path.join(yield* Effect.promise(() => fs.realpath(tmp.path)), "src", "new.txt"),
                  resource: "src/new.txt",
                  existed: false,
                  diff: expect.stringContaining("+created"),
                },
                content: [{ type: "text", text: "Created file successfully: src/new.txt" }],
              },
            })
            expect(yield* Effect.promise(() => fs.readFile(path.join(tmp.path, "src", "new.txt"), "utf8"))).toBe(
              "created",
            )
            expect(assertions).toMatchObject([{ sessionID, action: "edit", resources: ["src/new.txt"], save: ["*"] }])
            expect(writes).toEqual([path.join(yield* Effect.promise(() => fs.realpath(tmp.path)), "src", "new.txt")])
          }),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("overwrites a relative existing file and reports that it wrote the file", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        return Effect.promise(() => fs.writeFile(path.join(tmp.path, "existing.txt"), "before")).pipe(
          Effect.andThen(
            withTool(tmp.path, (registry) => settleTool(registry, call({ path: "existing.txt", content: "after" }))),
          ),
          Effect.andThen((settled) =>
            Effect.gen(function* () {
              expect(settled.result).toEqual({ type: "text", value: "Wrote file successfully: existing.txt" })
              expect(settled.output?.structured).toMatchObject({ resource: "existing.txt", existed: true })
              // 先按真实输出Schema读取，避免Bun的连续非对称匹配改写实际对象字段。
              const output = Schema.decodeUnknownSync(WriteTool.Output)(settled.output?.structured)
              expect(output.diff).toContain("-before\n")
              expect(output.diff).toContain("+after\n")
              expect(yield* Effect.promise(() => fs.readFile(path.join(tmp.path, "existing.txt"), "utf8"))).toBe(
                "after",
              )
              expect(writes).toHaveLength(1)
            }),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("formats created and overwritten files using the configured native formatter", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.gen(function* () {
        for (const mode of ["off", "disabled", "enabled"] as const) {
          reset()
          const resource = `${mode}.fmt`
          const target = path.join(tmp.path, resource)
          const counter = path.join(tmp.path, `${mode}-runs.txt`)
          // 实际执行独立临时文件上的 formatter，不 mock 进程、文件服务、结算或回读。
          const program = String.raw`const file = process.argv.at(-2); const counter = process.argv.at(-1); const text = await Bun.file(file).text(); await Bun.write(file, text.replace(/const n=(\d+);?/g, "const n = $1;").replace(/\n*$/, "\n")); await Bun.write(counter, (await Bun.file(counter).exists() ? await Bun.file(counter).text() : "") + "1\n")`
          const formatter: Config.Info["formatter"] = mode === "off" ? false : { fixture: { command: [process.execPath, "-e", program, "$FILE", counter], extensions: [".fmt"], disabled: mode === "disabled" } }
          yield* withTool(tmp.path, (registry) => Effect.gen(function* () {
            for (const index of [0, 1]) {
              const settled = yield* settleTool(registry, call({ path: resource, content: "\uFEFFconst n=2" }, `call-format-${mode}-${index}`))
              const output = Schema.decodeUnknownSync(WriteTool.Output)(settled.output?.structured)
              const shown = settled.result.type === "text" ? settled.result.value : ""
              expect(output.existed).toBe(index === 1)
              expect(output.diff).not.toContain("\uFEFF")
              expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe(mode === "enabled" ? "\uFEFFconst n = 2;\n" : "\uFEFFconst n=2")
              if (mode === "enabled") {
                expect(output.formattedContent).toBe("const n = 2;\n")
                expect(output.formattedDiff).toContain("+const n = 2;")
                expect(shown).toContain("Formatted changes (auto-format adjusted the file):")
                expect(shown).toContain("+const n = 2;")
              } else {
                expect(output.formattedContent).toBeUndefined()
                expect(output.formattedDiff).toBeUndefined()
              }
            }
          }), { formatter })
          if (mode === "enabled") {
            const identity = { sessionID, ...toolIdentity }
            const edit = yield* withTool(tmp.path, (registry) => settleTool(registry, { ...identity, call: { type: "tool-call", id: "format-edit", name: "edit", input: { path: resource, oldString: "const n = 2;", newString: "const n=3" } } }), { formatter, tool: "edit" })
            expect(edit.result.type === "text" ? edit.result.value : "").toContain("-const n = 2;\n+const n = 3;")
            expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe("\uFEFFconst n = 3;\n")
            const patch = yield* withTool(tmp.path, (registry) => settleTool(registry, { ...identity, call: { type: "tool-call", id: "format-patch", name: "apply_patch", input: { patchText: `*** Begin Patch\n*** Update File: ${resource}\n@@\n-const n = 3;\n+const n=4\n*** End Patch` } } }), { formatter, tool: "apply_patch" })
            expect(patch.result.type === "text" ? patch.result.value : "").toContain("-const n = 3;\n+const n = 4;")
            expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe("\uFEFFconst n = 4;\n")
          }
          const ran = yield* Effect.promise(() => Bun.file(counter).exists())
          expect(ran ? (yield* Effect.promise(() => Bun.file(counter).text())).trim().split("\n").length : 0).toBe(mode === "enabled" ? 4 : 0)
        }
      }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("cancels a running formatter, restores BOM and releases the same target lock", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.gen(function* () {
        reset()
        const resource = "cancel.fmt"
        const target = path.join(tmp.path, resource)
        const ready = path.join(tmp.path, "formatter-ready")
        // 子进程只操作本用例文件；自然退出标记令旧的不可取消实现稳定失败并自行收尾。
        const program = String.raw`const file = process.argv.at(-2); const ready = process.argv.at(-1); await Bun.write(file, "formatted before cancel\n"); setTimeout(async () => { await Bun.write(ready + ".natural", "done"); process.exit(0) }, 10000); await Bun.write(ready, "ready")`
        const formatter: Config.Info["formatter"] = { fixture: { command: [process.execPath, "-e", program, "$FILE", ready], extensions: [".fmt"] } }
        yield* withTool(tmp.path, (registry) => Effect.gen(function* () {
          const files = yield* FileMutation.Service
          const running = yield* settleTool(registry, call({ path: resource, content: "\uFEFFbefore" }, "call-cancel-format")).pipe(Effect.forkChild)
          yield* Effect.promise(async () => {
            const deadline = Date.now() + 5000
            while (!(await Bun.file(ready).exists())) {
              if (Date.now() > deadline) throw new Error("Formatter did not publish readiness")
              await Bun.sleep(10)
            }
          })
          yield* Fiber.interrupt(running)
          const exit = yield* Fiber.await(running)
          expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
          expect(yield* Effect.promise(() => Bun.file(`${ready}.natural`).exists())).toBe(false)
          expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe("\uFEFFformatted before cancel\n")
          // 同一个 FileMutation 实例再次写入，证明不是换一个 mutex 绕过泄漏的锁。
          yield* files.writeTextPreservingBom({ target: { canonical: yield* Effect.promise(() => fs.realpath(target)), resource }, content: "after cancellation" })
          expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe("\uFEFFafter cancellation")
        }), { formatter })
      }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("preserves exactly one BOM when overwriting existing files", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        const preserved = path.join(tmp.path, "preserved.txt")
        const deduplicated = path.join(tmp.path, "deduplicated.txt")
        return Effect.promise(() =>
          Promise.all([fs.writeFile(preserved, "\uFEFFbefore"), fs.writeFile(deduplicated, "\uFEFFbefore")]),
        ).pipe(
          Effect.andThen(
            withTool(tmp.path, (registry) =>
              Effect.gen(function* () {
                yield* settleTool(registry, call({ path: "preserved.txt", content: "after" }, "call-preserved"))
                yield* settleTool(
                  registry,
                  call({ path: "deduplicated.txt", content: "\uFEFFafter" }, "call-deduplicated"),
                )

                expect(yield* Effect.promise(() => fs.readFile(preserved, "utf8"))).toBe("\uFEFFafter")
                expect(yield* Effect.promise(() => fs.readFile(deduplicated, "utf8"))).toBe("\uFEFFafter")
                // 本补丁只归一 Write 展示；实际请求仍可把 CRLF/CR 覆写为 LF。
                for (const ending of ["\n", "\r\n", "\r"]) {
                  yield* Effect.promise(() => fs.writeFile(preserved, `\uFEFFone${ending}two${ending}`))
                  const settled = yield* settleTool(registry, call({ path: "preserved.txt", content: "one\ntwo\n" }, `call-eol-${ending.charCodeAt(0)}-${ending.length}`))
                  const output = Schema.decodeUnknownSync(WriteTool.Output)(settled.output?.structured)
                  expect(output.diff).toContain("Index:")
                  expect(output.diff).not.toContain("-one")
                  expect(output.diff).not.toContain("+one")
                  expect(output.diff).not.toContain("-two")
                  expect(output.diff).not.toContain("+two")
                  expect(output.diff).not.toContain("\uFEFF")
                  expect(yield* Effect.promise(() => fs.readFile(preserved, "utf8"))).toBe("\uFEFFone\ntwo\n")
                }
              }),
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
        return withTool(tmp.path, (registry) => executeTool(registry, call({ path: target, content: "inside" }))).pipe(
          Effect.andThen((result) =>
            Effect.gen(function* () {
              expect(result).toEqual({ type: "text", value: "Created file successfully: absolute.txt" })
              expect(assertions.map((input) => input.action)).toEqual(["edit"])
              expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe("inside")
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
        return withTool(active.path, (registry) =>
          settleTool(registry, call({ path: target, content: "external" })),
        ).pipe(
          Effect.andThen((settled) =>
            Effect.gen(function* () {
              const canonicalTarget = path.join(yield* Effect.promise(() => fs.realpath(outside.path)), "external.txt")
              expect(assertions.map((input) => input.action)).toEqual(["external_directory", "edit"])
              expect(assertions[0]).toMatchObject({
                resources: [
                  path.join(yield* Effect.promise(() => fs.realpath(outside.path)), "*").replaceAll("\\", "/"),
                ],
              })
              expect(assertions[1]).toMatchObject({ resources: [canonicalTarget.replaceAll("\\", "/")], save: ["*"] })
              expect(settled.output?.structured).toMatchObject({
                target: canonicalTarget,
                resource: canonicalTarget.replaceAll("\\", "/"),
                existed: false,
              })
              expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe("external")
              expect(writes).toEqual([canonicalTarget])
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
          reset()
          denyAction = "external_directory"
          expect(
            yield* withTool(active.path, (registry) =>
              executeTool(registry, call({ path: external, content: "blocked" })),
            ),
          ).toEqual({
            type: "error",
            value: `Unable to write ${external}`,
          })
          expect(assertions.map((input) => input.action)).toEqual(["external_directory"])
          expect(writes).toEqual([])

          reset()
          denyAction = "edit"
          expect(
            yield* withTool(active.path, (registry) =>
              executeTool(registry, call({ path: "denied.txt", content: "blocked" })),
            ),
          ).toEqual({
            type: "error",
            value: "Unable to write denied.txt",
          })
          expect(assertions.map((input) => input.action)).toEqual(["edit"])
          expect(writes).toEqual([])
        }),
      ([active, outside]) =>
        Effect.promise(() =>
          Promise.all([active[Symbol.asyncDispose](), outside[Symbol.asyncDispose]()]).then(() => undefined),
        ),
    ),
  )
})

test("keeps the locked write schema, semantics docstring, and deferred UX TODOs visible", async () => {
  const source = (await fs.readFile(new URL("../src/tool/write.ts", import.meta.url), "utf8")).replaceAll("\r\n", "\n")
  const definition = await Effect.runPromise(
    withTool(path.dirname(fileURLToPath(import.meta.url)), (registry) => toolDefinitions(registry)),
  )
  const schema = definition[0]?.inputSchema as { readonly properties?: Record<string, unknown> }

  expect(Object.keys(schema.properties ?? {}).sort()).toEqual(["content", "path"])
  expect(source).toContain(
    "absolute external paths retain mutation capability through a separate\n * external_directory approval before edit approval.",
  )
  for (const todo of [
    "Revisit whether model-facing mutation schemas should prefer absolute `filePath` naming for trained-in compatibility after evaluating model behavior.",
    "Publish watcher/file-edit events after V2 watcher integration exists.",
    "Add snapshots / undo after design exists.",
    "Add LSP notification and diagnostics after V2 LSP runtime exists.",
  ]) {
    expect(source).toContain(`TODO: ${todo}`)
  }
})
