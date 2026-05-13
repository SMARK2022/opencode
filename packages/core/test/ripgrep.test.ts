import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect, Layer, Schema } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { AbsolutePath, RelativePath } from "@opencode-ai/core/schema"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { AppProcess } from "@opencode-ai/core/process"
import { Location } from "@opencode-ai/core/location"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { GrepTool } from "@opencode-ai/core/tool/grep"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { location } from "./fixture/location"
import { settleTool, toolIdentity } from "./lib/tool"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const it = testEffect(LayerNode.compile(Ripgrep.node))

describe("Ripgrep", () => {
  testEffect(Layer.empty).live("bounds native grep at its producer and preserves exact truncation evidence", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.gen(function* () {
        yield* Effect.promise(() => Bun.write(path.join(tmp.path, "matches.txt"), Array.from({ length: 130 }, (_, index) => `needle ${index}`).join("\n")))
        yield* Effect.promise(() => Bun.write(path.join(tmp.path, "exact.txt"), "needle\n".repeat(64)))
        const limits: number[] = []
        const sizes: number[] = []
        const assertions: PermissionV2.AssertInput[] = []
        let kills = 0
        // 只观察实际 handle.kill 的执行，stdout、退出码和作用域清理仍由真实进程提供。
        const processLayer = Layer.effect(AppProcess.Service, Effect.gen(function* () {
          const native = yield* AppProcess.Service
          return AppProcess.Service.of({
            ...native,
            spawn: (command) => native.spawn(command).pipe(
              Effect.map((handle) => new Proxy(handle, {
                get(target, key) {
                  if (key === "kill") return (...args: Parameters<typeof target.kill>) =>
                    Effect.sync(() => { kills++ }).pipe(Effect.andThen(target.kill(...args)))
                  return Reflect.get(target, key, target)
                },
              })),
            ),
          })
        })).pipe(Layer.provide(LayerNode.compile(AppProcess.node)))
        const observed = Layer.effect(Ripgrep.Service, Effect.gen(function* () {
          const native = yield* Ripgrep.Service
          return Ripgrep.Service.of({
            ...native,
            // 单文件保留正式默认预算；目录用小候选门限验证真实拒绝和模型纠正提示。
            search: (input) => Effect.sync(() => limits.push(input.limit)).pipe(
              Effect.andThen(native.search({ ...input, maxFiles: input.file ? input.maxFiles : 1 })),
              Effect.tap((result) => Effect.sync(() => sizes.push(result.items.length))),
            ),
          })
        })).pipe(Layer.provide(AppNodeBuilder.build(Ripgrep.node, [[AppProcess.node, processLayer]])))
        const graph = AppNodeBuilder.build(
          LayerNode.group([ToolRegistry.node, ToolRegistry.toolsNode, GrepTool.node]),
          [
            [Ripgrep.node, observed],
            [Location.node, Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(tmp.path) })))],
            [PermissionV2.node, Layer.mock(PermissionV2.Service, { assert: (input) => Effect.sync(() => { assertions.push(input) }) })],
            [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
          ],
        )
        yield* Effect.gen(function* () {
          const registry = yield* ToolRegistry.Service
          const sessionID = SessionSchema.ID.make("ses_native_grep_budget")
          for (const [index, limit] of [undefined, 3, 80].entries()) {
            const budget = limit ?? 64
            const settled = yield* settleTool(registry, { sessionID, ...toolIdentity, call: { type: "tool-call", id: `grep-${index}`, name: "grep", input: { pattern: "needle", path: "matches.txt", ...(limit === undefined ? {} : { limit }) } } })
            const output = Schema.decodeUnknownSync(GrepTool.Output)(settled.output?.structured)
            expect(output.items).toHaveLength(budget)
            expect(output.truncated).toBe(true)
            expect(output.partial).toBe(false)
            expect(output.items[0]?.text).toContain("needle 0")
            expect(settled.result.type === "text" ? settled.result.value : "").toContain(`Found ${budget}+ matches`)
            expect(limits.at(-1)).toBe(budget)
            expect(sizes.at(-1)).toBe(budget)
            expect(kills).toBe(index + 1)
          }
          const whole = yield* settleTool(registry, { sessionID, ...toolIdentity, call: { type: "tool-call", id: "grep-exact", name: "grep", input: { pattern: "needle", path: "exact.txt" } } })
          const exact = Schema.decodeUnknownSync(GrepTool.Output)(whole.output?.structured)
          expect(exact.items).toHaveLength(64)
          expect(exact.truncated).toBe(false)
          expect(whole.result.type === "text" ? whole.result.value : "").not.toContain("truncated")
          expect(kills).toBe(3)
          expect(limits).toEqual([64, 3, 80, 64])
          expect(sizes).toEqual([64, 3, 80, 64])
          const broad = yield* settleTool(registry, { sessionID, ...toolIdentity, call: { type: "tool-call", id: "grep-broad", name: "grep", input: { pattern: "needle", path: "." } } })
          const failure = broad.result.type === "error" ? String(broad.result.value) : ""
          expect(failure).toContain("more than 1 candidate files")
          expect(failure).toContain("Use a narrower path or include pattern before searching file contents.")
          expect(assertions).toHaveLength(5)
          expect(assertions.every((input) => input.action === "grep" && input.source?.type === "tool")).toBe(true)
        }).pipe(Effect.provide(graph))
      }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("keeps ignored files out of catch-all find results", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => fs.mkdir(path.join(tmp.path, "node_modules", "pkg"), { recursive: true }))
          yield* Effect.promise(() => fs.mkdir(path.join(tmp.path, "src")))
          yield* Effect.promise(() => Bun.$`git init -q ${tmp.path}`)
          yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, ".gitignore"), "node_modules/\n"))
          yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, "node_modules", "pkg", "index.js"), "ignored\n"))
          yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, "src", "index.js"), "included\n"))

          const files = yield* (yield* Ripgrep.Service).find({ cwd: tmp.path, pattern: "*", limit: 10 })
          expect(files.map((item) => item.path)).toContain(RelativePath.make("src/index.js"))
          expect(files.map((item) => item.path)).not.toContain(RelativePath.make("node_modules/pkg/index.js"))
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("never includes git metadata", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => fs.mkdir(path.join(tmp.path, ".opencode")))
          yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, ".opencode", "config"), "needle\n"))
          yield* Effect.promise(() => fs.mkdir(path.join(tmp.path, ".git")))
          yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, ".git", "config"), "needle\n"))
          const ripgrep = yield* Ripgrep.Service

          const files = yield* ripgrep.find({ cwd: tmp.path, pattern: "**/*", limit: 10 })
          expect(files.map((item) => item.path)).toContain(RelativePath.make(".opencode/config"))
          expect(files.map((item) => item.path)).not.toContain(RelativePath.make(".git/config"))

          const observed: string[] = []
          const limited = yield* ripgrep.find({
            cwd: tmp.path,
            pattern: "**/*",
            limit: 1,
            onEntry: (entry) => Effect.sync(() => observed.push(entry.path)),
          })
          expect(observed).toEqual(limited.map((item) => item.path))

          const matches = yield* ripgrep.grep({ cwd: tmp.path, pattern: "needle", include: "config", limit: 10 })
          expect(matches.map((item) => item.entry.path)).toContain(RelativePath.make(".opencode/config"))
          expect(matches.map((item) => item.entry.path)).not.toContain(RelativePath.make(".git/config"))
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )
  it.live("does not split surrogate pairs in oversized line previews", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            fs.writeFile(path.join(tmp.path, "unicode.txt"), `needle${"x".repeat(1_993)}😀\n`),
          )

          const matches = yield* (yield* Ripgrep.Service).grep({
            cwd: tmp.path,
            pattern: "needle",
            limit: 10,
          })

          expect(matches[0]?.text).toBe(`needle${"x".repeat(1_993)}...`)
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )
  // #138：limit 截断匹配数
  // #138：验证 limit 截断
  it.live("grep limit caps total matches", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => Bun.write(path.join(tmp.path, "one.txt"), "needle\nneedle\nneedle\n"))
          yield* Effect.promise(() => Bun.write(path.join(tmp.path, "two.txt"), "needle\nneedle\nneedle\n"))
          const ripgrep = yield* Ripgrep.Service
          const result = yield* ripgrep.search({ cwd: tmp.path, pattern: "needle", limit: 3 })
          expect(result.items).toHaveLength(3)
          expect(result.truncated).toBe(true)
          const full = yield* ripgrep.search({ cwd: tmp.path, pattern: "needle", limit: 10, maxFiles: false })
          expect(full.items).toHaveLength(6)
          expect(full.truncated).toBe(false)
          expect(full.partial).toBe(false)
          const invalid = yield* ripgrep.search({ cwd: tmp.path, file: "one.txt", pattern: "needle", include: "[", limit: 3 }).pipe(Effect.flip)
          expect(invalid.message).toContain("error parsing glob")
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  // #138：maxFiles 过小拒绝目录搜索
  // #138：验证 maxFiles 拒绝过宽搜索
  it.live("grep refuses overly broad candidate sets", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => Bun.write(path.join(tmp.path, "one.txt"), "needle\n"))
          yield* Effect.promise(() => Bun.write(path.join(tmp.path, "two.txt"), "needle\n"))
          const ripgrep = yield* Ripgrep.Service
          const exit = yield* ripgrep
            .grep({ cwd: tmp.path, pattern: "needle", limit: 10, maxFiles: 1 })
            .pipe(Effect.exit)
          expect(exit._tag).toBe("Failure")
          const directory = yield* ripgrep.search({ cwd: tmp.path, file: ".", pattern: "needle", limit: 10, maxFiles: 1 }).pipe(Effect.flip)
          expect(directory).toBeInstanceOf(Ripgrep.SearchTooBroadError)
          const single = yield* ripgrep.search({ cwd: tmp.path, file: "one.txt", pattern: "needle", limit: 10, maxFiles: 1 })
          expect(single.items).toHaveLength(1)
          expect(single.truncated).toBe(false)
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

})
