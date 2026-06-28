import fs from "fs/promises"
import path from "path"
import { describe, expect } from "bun:test"
import { Deferred, Effect, Exit, Fiber, Layer, Schema } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FileMutation } from "@opencode-ai/core/file-mutation"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Location } from "@opencode-ai/core/location"
import { LocationMutation } from "@opencode-ai/core/location-mutation"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { PermissionPrecheck } from "@opencode-ai/core/permission/precheck"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { ApplyPatchTool } from "@opencode-ai/core/tool/apply-patch"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { toolIdentity, executeTool, settleTool, toolDefinitions } from "./lib/tool"

const sessionID = SessionV2.ID.make("ses_apply_patch_tool_test")
const assertions: PermissionV2.AssertInput[] = []
let denyAction: string | undefined
let failRemoveTarget: string | undefined
let readsBeforeEditApproval = 0
let editApproved = false
let blockRemoveTarget: string | undefined
let removeStarted: Deferred.Deferred<void> | undefined
let releaseRemove: Deferred.Deferred<void> | undefined
let afterEditApproval = (): Effect.Effect<void> => Effect.void

const permission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    assert: (input) =>
      Effect.sync(() => {
        assertions.push(input)
        if (input.action === "edit") editApproved = true
      }).pipe(
        Effect.andThen(input.action === "edit" ? Effect.suspend(afterEditApproval) : Effect.void),
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
  denyAction = undefined
  failRemoveTarget = undefined
  readsBeforeEditApproval = 0
  editApproved = false
  blockRemoveTarget = undefined
  removeStarted = undefined
  releaseRemove = undefined
  afterEditApproval = () => Effect.void
}

const filesystem = Layer.effect(
  FSUtil.Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    return FSUtil.Service.of({
      ...fs,
      readFile: (target) =>
        Effect.sync(() => {
          if (!editApproved) readsBeforeEditApproval++
        }).pipe(Effect.andThen(fs.readFile(target))),
      remove: (target, options) => {
        if (failRemoveTarget && path.basename(target) === failRemoveTarget) return Effect.die("forced remove failure")
        if (blockRemoveTarget && path.basename(target) === blockRemoveTarget && removeStarted && releaseRemove)
          return Deferred.succeed(removeStarted, undefined).pipe(
            Effect.andThen(Deferred.await(releaseRemove)),
            Effect.andThen(fs.remove(target, options)),
          )
        return fs.remove(target, options)
      },
    })
  }),
).pipe(Layer.provide(LayerNode.compile(FSUtil.node)))

const withTool = <A, E, R>(directory: string, body: (registry: ToolRegistry.Interface) => Effect.Effect<A, E, R>) => {
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
          ApplyPatchTool.node,
        ]),
        [
          [FSUtil.node, filesystem],
          [Location.node, activeLocation],
          [PermissionV2.node, permission],
          [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
        ],
      ),
    ),
  )
}

const call = (patchText: string, id = "call-apply-patch") => ({
  sessionID,
  ...toolIdentity,
  call: { type: "tool-call" as const, id, name: "apply_patch", input: { patchText } },
})

const exists = (target: string) =>
  Effect.promise(() =>
    fs.stat(target).then(
      () => true,
      () => false,
    ),
  )
const it = testEffect(Layer.empty)

describe("ApplyPatchTool", () => {
  it.live("preserves logical lines, BOM and precise diffs for each file ending", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.gen(function* () {
        for (const [index, ending] of ["\n", "\r\n", "\r"].entries()) {
          reset()
          const update = path.join(tmp.path, "update.txt")
          const remove = path.join(tmp.path, "remove.txt")
          yield* Effect.promise(() => fs.writeFile(update, `\uFEFFone${ending}two${ending}three${ending}`))
          yield* Effect.promise(() => fs.writeFile(remove, `first${ending}last${ending}`))
          const patch = ["*** Begin Patch", "*** Update File: update.txt", "@@", " one", "-two", "+changed", " three", "*** Delete File: remove.txt", "*** End Patch"].join(ending)
          // 通过正式工具解析、准备、条件写入及结算，确认原始字节和展示各守其责。
          const settled = yield* withTool(tmp.path, (registry) => settleTool(registry, call(patch, `call-ending-${index}`)))
          const output = Schema.decodeUnknownSync(ApplyPatchTool.Output)(settled.output?.structured)
          expect(output.files).toHaveLength(2)
          expect(output.files[0]).toMatchObject({ additions: 1, deletions: 1, status: "modified" })
          expect(output.files[0]?.patch).toContain("-two\n+changed\n")
          expect(output.files[0]?.patch).not.toContain("-one")
          expect(output.files[0]?.patch).not.toContain("+one")
          expect(output.files[0]?.patch).not.toContain("\r")
          expect(output.files[0]?.patch).not.toContain("\uFEFF")
          expect(output.files[1]).toMatchObject({ additions: 0, deletions: 2, status: "deleted" })
          expect(yield* Effect.promise(() => fs.readFile(update, "utf8"))).toBe(`\uFEFFone${ending}changed${ending}three${ending}`)
          expect(yield* exists(remove)).toBe(false)
          expect(readsBeforeEditApproval).toBe(0)
          expect(assertions).toMatchObject([{ action: "edit", resources: ["update.txt", "remove.txt"] }])
          // 分类器必须消费真实工具请求，不能只用手造metadata证明删除已送审。
          const request = assertions[0]
          if (!request?.metadata) return yield* Effect.die("Missing edit precheck metadata")
          expect(request.metadata.files).toEqual([{ type: "update", relativePath: "update.txt" }, { type: "delete", relativePath: "remove.txt" }])
          expect(PermissionPrecheck.evaluate({ permission: request.action, patterns: request.resources, metadata: request.metadata })).toMatchObject({ level: "cautious", reason: "file deletion requires explicit approval" })
        }
      }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("registers and sequentially applies add, update, and delete hunks", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        const update = path.join(tmp.path, "update.txt")
        const remove = path.join(tmp.path, "remove.txt")
        return Effect.promise(() =>
          Promise.all([fs.writeFile(update, "before\n"), fs.writeFile(remove, "remove\n")]),
        ).pipe(
          Effect.andThen(
            withTool(tmp.path, (registry) =>
              Effect.gen(function* () {
                expect((yield* toolDefinitions(registry)).map((tool) => tool.name)).toEqual(["apply_patch"])
                const settled = yield* settleTool(
                  registry,
                  call(
                    "*** Begin Patch\n*** Add File: nested/new.txt\n+created\n*** Update File: update.txt\n@@\n-before\n+after\n*** Delete File: remove.txt\n*** End Patch",
                  ),
                )
                const shown = settled.result.type === "text" ? settled.result.value : ""
                expect(settled.result).toEqual({
                  type: "text",
                  value: expect.stringContaining("Applied patch sequentially:\nA nested/new.txt\nM update.txt\nD remove.txt\n\nChanged:\n```diff"),
                })
                expect(shown).toEndWith("\n\nLSP diagnostics unavailable (no language server running). Run bun typecheck to verify type safety.")
                expect(settled.output?.structured).toMatchObject({
                  applied: [
                    { type: "add", resource: "nested/new.txt" },
                    { type: "update", resource: "update.txt" },
                    { type: "delete", resource: "remove.txt" },
                  ],
                  files: [
                    {
                      file: "nested/new.txt",
                      status: "added",
                      additions: 1,
                      deletions: 0,
                      patch: expect.stringContaining("+created"),
                    },
                    {
                      file: "update.txt",
                      status: "modified",
                      additions: 1,
                      deletions: 1,
                      patch: expect.stringContaining("-before\n+after"),
                    },
                    {
                      file: "remove.txt",
                      status: "deleted",
                      additions: 0,
                      deletions: 1,
                      patch: expect.stringContaining("-remove"),
                    },
                  ],
                })
                expect(assertions).toMatchObject([
                  { sessionID, action: "edit", resources: ["nested/new.txt", "update.txt", "remove.txt"], save: ["*"] },
                ])
                // 真实leaf交付每个操作类型，不能把混合patch中的删除当作general更新。
                expect(assertions[0]?.metadata?.files).toEqual([
                  { type: "add", relativePath: "nested/new.txt" },
                  { type: "update", relativePath: "update.txt" },
                  { type: "delete", relativePath: "remove.txt" },
                ])
                expect(readsBeforeEditApproval).toBe(0)
                expect(yield* Effect.promise(() => fs.readFile(path.join(tmp.path, "nested/new.txt"), "utf8"))).toBe(
                  "created\n",
                )
                expect(yield* Effect.promise(() => fs.readFile(update, "utf8"))).toBe("after\n")
                expect(shown).toContain("+created")
                expect(shown).toContain("-before\n+after")
                expect(shown).toContain("-remove")
                expect(yield* exists(remove)).toBe(false)
              }),
            ),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("rejects moves before applying any hunk", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        const source = path.join(tmp.path, "old.txt")
        return Effect.promise(() => fs.writeFile(source, "before\n")).pipe(
          Effect.andThen(
            withTool(tmp.path, (registry) =>
              Effect.gen(function* () {
                expect(
                  yield* executeTool(
                    registry,
                    call(
                      "*** Begin Patch\n*** Add File: created.txt\n+created\n*** Update File: old.txt\n*** Move to: moved.txt\n@@\n-before\n+after\n*** End Patch",
                    ),
                  ),
                ).toEqual({ type: "error", value: "apply_patch moves are not supported yet" })
                expect(yield* exists(path.join(tmp.path, "created.txt"))).toBe(false)
                expect(assertions).toEqual([])
              }),
            ),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("approves an external directory and the batch before reading external update content", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => Promise.all([tmpdir(), tmpdir()])),
      ([active, outside]) => {
        reset()
        const target = path.join(outside.path, "external.txt")
        return Effect.promise(() => fs.writeFile(target, "before\n")).pipe(
          Effect.andThen(
            withTool(active.path, (registry) =>
              Effect.gen(function* () {
                expect(
                  yield* executeTool(
                    registry,
                    call(`*** Begin Patch\n*** Update File: ${target}\n@@\n-before\n+after\n*** End Patch`),
                  ),
                ).toMatchObject({ type: "text" })
                expect(assertions.map((input) => input.action)).toEqual(["external_directory", "edit"])
                expect(readsBeforeEditApproval).toBe(0)
                expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe("after\n")
              }),
            ),
          ),
        )
      },
      ([active, outside]) =>
        Effect.promise(() =>
          Promise.all([active[Symbol.asyncDispose](), outside[Symbol.asyncDispose]()]).then(() => undefined),
        ),
    ),
  )

  it.live("approves one external directory scope for multiple files under the same parent", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => Promise.all([tmpdir(), tmpdir()])),
      ([active, outside]) => {
        reset()
        const first = path.join(outside.path, "first.txt")
        const second = path.join(outside.path, "second.txt")
        return Effect.promise(() =>
          Promise.all([fs.writeFile(first, "before\n"), fs.writeFile(second, "before\n")]),
        ).pipe(
          Effect.andThen(
            withTool(active.path, (registry) =>
              Effect.gen(function* () {
                expect(
                  yield* executeTool(
                    registry,
                    call(
                      `*** Begin Patch\n*** Update File: ${first}\n@@\n-before\n+after\n*** Update File: ${second}\n@@\n-before\n+after\n*** End Patch`,
                    ),
                  ),
                ).toMatchObject({ type: "text" })
                // 同目录同操作仍只批准一次，同时reviewer得到完整批次而非只有路径。
                expect(assertions[0]?.metadata).toMatchObject({ action_kind: "tool", tool: "apply_patch", operation: "update", patchText: expect.stringContaining(`*** Update File: ${second}`) })
                expect(assertions.map((input) => input.action)).toEqual(["external_directory", "edit"])
                expect(assertions[0]?.resources).toEqual([
                  path.join(yield* Effect.promise(() => fs.realpath(outside.path)), "*").replaceAll("\\", "/"),
                ])
              }),
            ),
          ),
        )
      },
      ([active, outside]) =>
        Effect.promise(() =>
          Promise.all([active[Symbol.asyncDispose](), outside[Symbol.asyncDispose]()]).then(() => undefined),
        ),
    ),
  )

  it.live("rejects invalid later update before applying an earlier add", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        return withTool(tmp.path, (registry) =>
          Effect.gen(function* () {
            expect(
              yield* executeTool(
                registry,
                call(
                  "*** Begin Patch\n*** Add File: created.txt\n+created\n*** Update File: missing.txt\n@@\n-before\n+after\n*** End Patch",
                ),
              ),
            ).toEqual({ type: "error", value: "Unable to apply patch at missing.txt" })
            expect(yield* exists(path.join(tmp.path, "created.txt"))).toBe(false)
          }),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("rejects add hunks targeting an existing file without replacing it", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        const target = path.join(tmp.path, "existing.txt")
        return Effect.promise(() => fs.writeFile(target, "sentinel\n")).pipe(
          Effect.andThen(
            withTool(tmp.path, (registry) =>
              Effect.gen(function* () {
                expect(
                  yield* executeTool(
                    registry,
                    call("*** Begin Patch\n*** Add File: existing.txt\n+replacement\n*** End Patch"),
                  ),
                ).toEqual({ type: "error", value: "Unable to apply patch at existing.txt" })
                expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe("sentinel\n")
              }),
            ),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("rejects an add target that appears during permission approval", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        const target = path.join(tmp.path, "appeared.txt")
        afterEditApproval = () => Effect.promise(() => fs.writeFile(target, "winner\n")).pipe(Effect.orDie)
        return withTool(tmp.path, (registry) =>
          Effect.gen(function* () {
            expect(
              yield* executeTool(
                registry,
                call("*** Begin Patch\n*** Add File: appeared.txt\n+replacement\n*** End Patch"),
              ),
            ).toEqual({ type: "error", value: "Unable to apply patch at appeared.txt" })
            expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe("winner\n")
          }),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("preserves a later commit defect after earlier sequential applications", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        const first = path.join(tmp.path, "first.txt")
        const second = path.join(tmp.path, "second.txt")
        failRemoveTarget = path.basename(second)
        return Effect.promise(() => Promise.all([fs.writeFile(first, "first"), fs.writeFile(second, "second")])).pipe(
          Effect.andThen(
            withTool(tmp.path, (registry) =>
              Effect.gen(function* () {
                expect(
                  Exit.isFailure(
                    yield* executeTool(
                      registry,
                      call("*** Begin Patch\n*** Delete File: first.txt\n*** Delete File: second.txt\n*** End Patch"),
                    ).pipe(Effect.exit),
                  ),
                ).toBe(true)
                expect(yield* exists(first)).toBe(false)
                expect(yield* exists(second)).toBe(true)
              }),
            ),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("finishes the sequential commit phase when interrupted after the first mutation", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        const first = path.join(tmp.path, "first.txt")
        const second = path.join(tmp.path, "second.txt")
        blockRemoveTarget = path.basename(second)
        return Effect.gen(function* () {
          removeStarted = yield* Deferred.make<void>()
          releaseRemove = yield* Deferred.make<void>()
          yield* Effect.promise(() => Promise.all([fs.writeFile(first, "first"), fs.writeFile(second, "second")]))
          yield* withTool(tmp.path, (registry) =>
            Effect.gen(function* () {
              const run = yield* executeTool(
                registry,
                call("*** Begin Patch\n*** Delete File: first.txt\n*** Delete File: second.txt\n*** End Patch"),
              ).pipe(Effect.forkChild)
              yield* Deferred.await(removeStarted!)
              const interrupt = yield* Fiber.interrupt(run).pipe(Effect.forkChild)
              yield* Deferred.succeed(releaseRemove!, undefined)
              yield* Fiber.join(interrupt)
              expect(yield* exists(first)).toBe(false)
              expect(yield* exists(second)).toBe(false)
            }),
          )
        })
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )
})
