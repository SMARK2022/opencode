import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Context, Deferred, Effect, Exit, Fiber, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { AbsolutePath, RelativePath } from "@opencode-ai/core/schema"
import { tmpdir } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"
import { FileSystemSearch } from "@opencode-ai/core/filesystem/search"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Location } from "@opencode-ai/core/location"
import { location } from "../fixture/location"

const it = testEffect(LayerNode.compile(Ripgrep.node))

const withTmp = <A, E, R>(f: (directory: AbsolutePath) => Effect.Effect<A, E, R>) =>
  Effect.acquireRelease(
    Effect.promise(() => tmpdir()),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  ).pipe(Effect.flatMap((tmp) => f(AbsolutePath.make(tmp.path))))

describe("Ripgrep", () => {
  it.live("globs files as an array", () =>
    withTmp((cwd) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => fs.mkdir(path.join(cwd, "src")))
        yield* Effect.promise(() => fs.writeFile(path.join(cwd, "src", "match.ts"), "needle\n"))
        const result = yield* (yield* Ripgrep.Service).glob({ cwd, pattern: "**/*.ts", limit: 10 })
        // [local-smark] glob 返回值改为 { files, partial, timedOut } 包装
        expect(result.files.map((item) => item.path)).toEqual([RelativePath.make("src/match.ts")])
      }),
    ),
  )

  it.live("greps files with include filtering", () =>
    withTmp((cwd) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => fs.mkdir(path.join(cwd, "src")))
        yield* Effect.promise(() => fs.writeFile(path.join(cwd, "src", "match.ts"), "needle\n"))
        yield* Effect.promise(() => fs.writeFile(path.join(cwd, "src", "skip.txt"), "needle\n"))
        const result = yield* (yield* Ripgrep.Service).grep({ cwd, pattern: "needle", include: "*.ts", limit: 10 })
        expect(result).toHaveLength(1)
        expect(result[0]?.entry.path).toBe(RelativePath.make("src/match.ts"))
        expect(result[0]?.submatches[0]?.text).toBe("needle")
      }),
    ),
  )
})

const scans = testEffect(Layer.empty)
scans.live("building does not scan; searches share only an in-flight index", () => Effect.gen(function* () {
  let count = 0
  let gate = Deferred.makeUnsafe<void>()
  const started = Deferred.makeUnsafe<void>()
  const built = yield* Layer.build(Layer.fresh(FileSystemSearch.ripgrepLayer).pipe(Layer.provide([
    LayerNode.compile(FSUtil.node),
    Layer.succeed(Location.Service, location({ directory: AbsolutePath.make("/test") })),
    Layer.mock(Ripgrep.Service, { find: (input) => Effect.gen(function* () {
      count++
      if (count === 2) yield* Deferred.succeed(started, undefined)
      yield* Deferred.await(gate)
      const entries = [{ path: RelativePath.make("src/a.ts"), type: "file" as const }]
      if (input.onEntry) for (const entry of entries) yield* input.onEntry(entry)
      return entries
    }) }),
  ])))
  const search = Context.get(built, FileSystemSearch.Service)
  const find = () => search.find({ query: "", type: "file" }).pipe(Effect.map((entries) => entries.map((entry) => String(entry.path))))
  // 构建即原init边界，不得因测试mock尚未完成而把预扫误判为零。
  expect(count).toBe(0)
  yield* Deferred.succeed(gate, undefined)
  expect(yield* find()).toEqual(["src/a.ts"])
  expect(count).toBe(1)
  gate = Deferred.makeUnsafe<void>()
  const first = yield* find().pipe(Effect.exit, Effect.forkChild)
  yield* Deferred.await(started).pipe(Effect.timeout("5 seconds"))
  const second = yield* find().pipe(Effect.exit, Effect.forkChild)
  // 等待者先进入已有租约，再打开扫描gate；不使用任意墙钟sleep判断并发。
  yield* Effect.yieldNow
  expect(count).toBe(2)
  yield* Deferred.succeed(gate, undefined)
  expect(yield* Fiber.join(first)).toEqual(Exit.succeed(["src/a.ts"]))
  expect(yield* Fiber.join(second)).toEqual(Exit.succeed(["src/a.ts"]))
  yield* find()
  expect(count).toBe(3)
}))

scans.live("probe: mocked ripgrep drives both blank-query results", () => Effect.gen(function* () {
  const built = yield* Layer.build(Layer.fresh(FileSystemSearch.ripgrepLayer).pipe(Layer.provide([
    LayerNode.compile(FSUtil.node),
    Layer.succeed(Location.Service, location({ directory: AbsolutePath.make("/test") })),
    Layer.mock(Ripgrep.Service, { find: (input) => Effect.gen(function* () {
      const entries = ["src/a.ts", "src/b.ts"].map((value) => ({ path: RelativePath.make(value), type: "file" as const }))
      if (input.onEntry) for (const entry of entries) yield* input.onEntry(entry)
      return entries
    }) }),
  ])))
  const search = Context.get(built, FileSystemSearch.Service)
  expect((yield* search.find({ query: "", type: "file" })).map((entry) => String(entry.path))).toEqual(["src/a.ts", "src/b.ts"])
}))
