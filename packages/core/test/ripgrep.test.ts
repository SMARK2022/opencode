import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Schema, Sink, Stream } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process"
import { RipgrepBinary } from "@opencode-ai/core/ripgrep/binary"
import { GlobTool } from "@opencode-ai/core/tool/glob"
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
        const searches: Ripgrep.GrepInput[] = []
        let forced: Ripgrep.SearchResult | undefined
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
            // 交互工具必须显式关闭候选预算；内部调用仍以小门限验证原拒绝语义。
            search: (input) => Effect.sync(() => { limits.push(input.limit); searches.push(input) }).pipe(
              Effect.andThen(Effect.suspend(() => forced ? Effect.succeed(forced) : native.search({ ...input, maxFiles: input.maxFiles === false ? false : input.file ? input.maxFiles : 1 }))),
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
          // 真实过滤与Native显式limit共同生效，交互搜索不再按文件数拒绝。
          const broad = yield* settleTool(registry, { sessionID, ...toolIdentity, call: { type: "tool-call", id: "grep-broad", name: "grep", input: { pattern: "needle", path: ".", include: ["*.txt"], exclude: ["exact.txt"], limit: 3 } } })
          const filtered = Schema.decodeUnknownSync(GrepTool.Output)(broad.output?.structured)
          expect(filtered.items).toHaveLength(3)
          expect(filtered.items.every((match) => match.entry.path === "matches.txt")).toBe(true)
          expect(searches.at(-1)).toMatchObject({ include: ["*.txt"], exclude: ["exact.txt"], timeout: 10_000, maxFiles: false })
          const internal = yield* Ripgrep.Service.use((rg) => rg.grep({ cwd: tmp.path, pattern: "needle", limit: 3, maxFiles: 1 })).pipe(Effect.provide(LayerNode.compile(Ripgrep.node)), Effect.flip)
          expect(internal).toBeInstanceOf(Ripgrep.SearchTooBroadError)
          // 只替换搜索结果来验证真实leaf投影；空和部分超时均不能伪装为无匹配。
          for (const items of [[], filtered.items.slice(0, 1)]) {
            forced = { items, partial: false, truncated: false, timedOut: true }
            const timed = yield* settleTool(registry, { sessionID, ...toolIdentity, call: { type: "tool-call", id: `grep-timeout-${items.length}`, name: "grep", input: { pattern: "needle", path: ".", timeout: 1 } } })
            const output = Schema.decodeUnknownSync(GrepTool.Output)(timed.output?.structured)
            expect(output.timedOut).toBe(true)
            expect(output.timeout).toBe(1)
            const text = timed.result.type === "text" ? timed.result.value : ""
            expect(text).toContain("timed out after 1 ms")
            expect(text).not.toContain("No files found")
            if (items.length) expect(text).toContain("Line 1: needle")
            expect(searches.at(-1)).toMatchObject({ timeout: 1, maxFiles: false })
          }
          expect(assertions).toHaveLength(7)
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

  // #244：真实 rg 进程需要足够大的输入才能稳定越过 1ms 预算；该测试验证公开
  // Ripgrep.search 行为，不断言内部 kill 调用形状，避免和进程实现耦合
  it.live("search timeout returns a bounded partial result instead of failing", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => Bun.write(path.join(tmp.path, "large.txt"), "x".repeat(4 * 1024 * 1024)))

          const result = yield* (yield* Ripgrep.Service).search({
            cwd: tmp.path,
            pattern: "needle",
            limit: 10,
            timeout: 1,
          })

          // #244：truncated=false 锁定「时间截断≠条数截断」，避免误报上限提示
          // #244：timedOut 必须置位且 truncated 不置位——两者语义独立：
          // 时间预算耗尽 ≠ 结果条数达到上限，调用方依赖这个区别生成提示
          expect(result.items).toEqual([])
          expect(result.timedOut).toBe(true)
          expect(result.truncated).toBe(false)
          // #244：partial 恒为 false 的契约——受控截断不等于路径不可访问，
          // 两者语义正交，调用方需分别提示
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  // [local-smark] 源 0413 契约「glob keeps invalid patterns fatal」等价：
  // glob 语法错误（error parsing glob，exit 2 且 stderr 有诊断）必须保持
  // Tool error，不得被归因为权限 partial——否则输入错误被隐藏成假阴性
  it.live("glob keeps invalid glob patterns fatal", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => Bun.write(path.join(tmp.path, "match.ts"), "needle\n"))

          const exit = yield* (yield* Ripgrep.Service)
            .glob({ cwd: tmp.path, pattern: "[", limit: 10 })
            .pipe(Effect.exit)

          // 无效 glob 是输入错误：失败而非「权限拒绝的部分结果」
          expect(exit._tag).toBe("Failure")
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  // [local-smark] search 的 include/exclude 走 --glob 参数：语法错误同样是
  // 输入错误，主 pattern 合法不能豁免 include 侧的错误分类
  it.live("search keeps invalid include globs fatal", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => Bun.write(path.join(tmp.path, "match.txt"), "needle\n"))

          const exit = yield* (yield* Ripgrep.Service)
            .search({ cwd: tmp.path, pattern: "needle", include: "[", limit: 10 })
            .pipe(Effect.exit)

          expect(exit._tag).toBe("Failure")
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  // [local-smark] 完整空结果是兼容基线：partial 只属于真实的 exit 2 空诊断
  // 场景，正常无匹配必须保持确定性阴性（源 complete-empty 契约等价）
  it.live("glob returns a deterministic empty result for a complete search", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => Bun.write(path.join(tmp.path, "match.ts"), "needle\n"))

          const result = yield* (yield* Ripgrep.Service).glob({ cwd: tmp.path, pattern: "*.nonexistent", limit: 10 })

          expect(result.files).toEqual([])
          expect(result.partial).toBe(false)
          expect(result.timedOut).toBeUndefined()
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  // [local-smark] 正常 glob 的 partial 契约：有匹配且无错误时 partial 必须为
  // false，调用方依赖该缺省区分「全量结果」与「部分路径不可访问」
  it.live("glob reports partial false for a healthy search", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => Bun.write(path.join(tmp.path, "match.ts"), "needle\n"))

          const result = yield* (yield* Ripgrep.Service).glob({ cwd: tmp.path, pattern: "*.ts", limit: 10 })

          expect(result.files.map((item) => item.path)).toContain(RelativePath.make("match.ts"))
          expect(result.partial).toBe(false)
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  // #244：timeout 存在时，正则语法错误仍是 rg 的真实失败，
  // 不能被降级成「超时后的空部分结果」
  it.live("search timeout does not hide invalid regex errors", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => Bun.write(path.join(tmp.path, "match.txt"), "needle\n"))

          const exit = yield* (yield* Ripgrep.Service)
            .search({ cwd: tmp.path, pattern: "(", limit: 10, timeout: 1000 })
            .pipe(Effect.exit)

          // #244：1000ms 预算远长于正则错误浮出时间——确保失败来自真实正则错误
          // 而非超时路径，锁定错误语义优先级：真实失败 > 受控截断
          expect(exit._tag).toBe("Failure")
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

})

const scriptedCases: Array<{ name: string; code: number; stdout?: string; stderr?: string; pending?: boolean }> = [
  { name: "partial", code: 2, stdout: "accessible.ts\n" },
  { name: "partial-empty", code: 2 },
  { name: "search-partial", code: 2, stdout: JSON.stringify({ type: "match", data: { path: { text: "accessible.ts" }, lines: { text: "needle\n" }, line_number: 1, absolute_offset: 0, submatches: [{ match: { text: "needle" }, start: 0, end: 6 }] } }) + "\n" },
  { name: "invalid", code: 2, stderr: "error parsing glob '[': unclosed character class" },
  { name: "unknown-diagnostic", code: 2, stderr: "unknown decoder error" },
  { name: "unknown-code", code: 3 },
  { name: "empty", code: 1 },
  { name: "arguments", code: 1 },
  { name: "find-diagnostics", code: 2, stdout: "accessible.ts\n", stderr: "blocked/: Permission denied (os error 13)" },
  { name: "bounded", code: 0, pending: true, stdout: Array.from({ length: 11 }, (_, index) => `file-${index}.ts`).join("\n") + "\n" },
  { name: "abort", code: 0, pending: true },
]
for (const scenario of scriptedCases) {
  const spawned = Deferred.makeUnsafe<void>()
  const released = Deferred.makeUnsafe<void>()
  const calls: string[][] = []
  // 同时替换进程和binary发现，不下载、不委托真实spawn；参数、parser及scope仍用生产实现。
  const scripted = testEffect(LayerNode.compile(Ripgrep.node, [
    [AppProcess.node, Layer.mock(AppProcess.Service)({
      spawn: (command) => Effect.acquireRelease(
        Effect.sync(() => {
          if (command._tag !== "StandardCommand") throw new Error("expected standard command")
          calls.push([...command.args])
          const prescan = scenario.name === "search-partial" && command.args.includes("--files")
          const stdout = prescan ? "accessible.ts\n" : scenario.stdout
          const stderr = prescan && !command.args.includes("--no-messages") ? "blocked/: Permission denied (os error 13)" : scenario.stderr
          return ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(0),
            exitCode: scenario.pending ? Effect.never : Effect.succeed(ChildProcessSpawner.ExitCode(scenario.code)),
            isRunning: Effect.succeed(scenario.pending === true), kill: () => Effect.void, stdin: Sink.drain,
            stdout: stdout ? Stream.make(new TextEncoder().encode(stdout)) : Stream.empty,
            stderr: stderr ? Stream.make(new TextEncoder().encode(stderr)) : Stream.empty,
            all: Stream.empty, getInputFd: () => Sink.drain, getOutputFd: () => Stream.empty, unref: Effect.succeed(Effect.void),
          })
        }).pipe(Effect.tap(() => Deferred.succeed(spawned, undefined))),
        () => Deferred.succeed(released, undefined),
      ),
    })],
    [RipgrepBinary.node, Layer.succeed(RipgrepBinary.Service, RipgrepBinary.Service.of({ filepath: Effect.succeed("rg-fixture") }))],
  ]))
  scripted.live(`scripted ripgrep replay: ${scenario.name}`, () => Effect.gen(function* () {
    const rg = yield* Ripgrep.Service
    if (scenario.name === "search-partial") {
      // 保留生产默认预扫；缺少抑制参数时替身真实返回权限诊断，不能绕过首个失败点。
      const result = yield* rg.search({ cwd: process.cwd(), pattern: "needle", limit: 10 })
      expect(calls).toHaveLength(2)
      expect(calls[0]).toContain("--files")
      expect(calls[0]).toContain("--no-messages")
      expect(calls[1]).toContain("--json")
      expect(result).toMatchObject({ partial: true, truncated: false })
      expect(result.items.map((item) => item.entry.path)).toEqual([RelativePath.make("accessible.ts")])
      expect(GrepTool.toModelOutput(result)).toContain("could not be accessed")
      expect(GrepTool.toModelOutput(result)).toContain("needle")
      return
    }
    if (scenario.name === "find-diagnostics") {
      expect((yield* rg.find({ cwd: process.cwd(), pattern: "*", limit: 10 })).map(item => item.path)).toEqual([RelativePath.make("accessible.ts")])
      expect(calls[0]).not.toContain("--no-messages")
      return
    }
    const controller = new AbortController()
    const input = { cwd: process.cwd(), pattern: scenario.name === "arguments" ? ".git/config" : "*.ts", limit: 10, signal: controller.signal }
    if (scenario.name === "abort") {
      const fiber = yield* rg.glob(input).pipe(Effect.forkScoped)
      yield* Deferred.await(spawned).pipe(Effect.timeout("1 second"))
      controller.abort()
      expect(Exit.isFailure(yield* Fiber.await(fiber))).toBe(true)
      yield* Deferred.await(released).pipe(Effect.timeout("1 second"))
      return
    }
    const exit = yield* rg.glob(input).pipe(Effect.exit)
    if (scenario.name === "invalid" || scenario.name === "unknown-diagnostic" || scenario.name === "unknown-code") {
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(String(Cause.squash(exit.cause))).toContain(scenario.stderr ?? "code 3")
      return
    }
    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isFailure(exit)) return yield* exit
    const result = exit.value
    expect(result.partial).toBe(scenario.name.startsWith("partial"))
    expect(result.truncated).toBe(scenario.name === "bounded")
    if (scenario.name === "partial" || scenario.name === "partial-empty") {
      expect(result.files.map((item) => item.path)).toEqual(scenario.name === "partial" ? [RelativePath.make("accessible.ts")] : [])
      expect(GlobTool.toModelOutput(result)).toContain("could not be accessed")
      // 真实Native注册/settle消费相同结果；只替换进程、搜索和授权，不启动产品运行时。
      const limits: number[] = []
      const graph = AppNodeBuilder.build(
        LayerNode.group([ToolRegistry.node, ToolRegistry.toolsNode, GlobTool.node, GrepTool.node]),
        [
          [Ripgrep.node, Layer.succeed(Ripgrep.Service, Ripgrep.Service.of({ ...rg, glob: input => Effect.sync(() => limits.push(input.limit)).pipe(Effect.andThen(rg.glob(input))), search: () => Effect.succeed({ items: [], partial: true, truncated: false }) }))],
          [Location.node, Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(process.cwd()) })))],
          [PermissionV2.node, Layer.mock(PermissionV2.Service, { assert: () => Effect.void })],
          [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
        ],
      )
      yield* Effect.gen(function* () {
        const registry = yield* ToolRegistry.Service
        for (const name of ["glob", "grep"]) {
          const settled = yield* settleTool(registry, {
            sessionID: SessionSchema.ID.make("ses_native_partial"), ...toolIdentity,
            call: { type: "tool-call", id: `partial-${name}`, name, input: { pattern: name === "grep" ? "needle" : "*.ts" } },
          })
          expect(settled.output?.structured).toMatchObject({ partial: true, truncated: false })
          expect(settled.result.type === "text" ? settled.result.value : "").toContain("could not be accessed")
        }
      }).pipe(Effect.provide(graph))
      expect(limits).toEqual([100])
    }
    if (scenario.name === "empty") {
      expect(result.files).toEqual([])
      expect(GlobTool.toModelOutput(result)).toBe("No files found")
      expect(GrepTool.toModelOutput({ items: [], partial: false, truncated: false })).toBe("No files found")
    }
    if (scenario.name === "bounded") {
      expect(result.files).toHaveLength(10)
      // exit永久pending，只有正确的bounded返回及scope释放才能到达这里。
      yield* Deferred.await(released).pipe(Effect.timeout("1 second"))
    }
    if (scenario.name === "arguments") {
      expect(calls[0]).toContain("--no-messages")
      expect(calls[0]).not.toContain("--follow")
      // 保留上游统一排除git metadata的更强规则，不恢复旧source的覆盖例外。
      expect(calls[0].indexOf("--glob=.git/config")).toBeLessThan(calls[0].indexOf("--glob=!**/.git/**"))
    }
  }))
}
