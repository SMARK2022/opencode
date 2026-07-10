import { describe, expect } from "bun:test"
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Sink } from "effect"
import * as Stream from "effect/Stream"
import { FetchHttpClient } from "effect/unstable/http"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Ripgrep } from "../../src/file/ripgrep"
import { awaitWithTimeout, testEffect } from "../lib/effect"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"

const it = testEffect(Ripgrep.defaultLayer)

const tmpdir = (init?: (dir: string) => Effect.Effect<void>) =>
  Effect.acquireRelease(
    Effect.promise(async () => fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "opencode-test-")))),
    (dir) =>
      Effect.promise(() =>
        fs.rm(dir, {
          recursive: true,
          force: true,
          maxRetries: 5,
          retryDelay: 100,
        }),
      ).pipe(Effect.ignore),
  ).pipe(Effect.tap((dir) => init?.(dir) ?? Effect.void))

const write = (file: string, data: string) => Effect.promise(() => Bun.write(file, data))
const mkdir = (dir: string) => Effect.promise(() => fs.mkdir(dir, { recursive: true }))
const encoder = new TextEncoder()

function scriptedRipgrep(input: {
  stdout?: string
  stderr?: string
  code: number
  pending?: boolean
  released?: Deferred.Deferred<void>
  spawned?: Deferred.Deferred<void>
  calls?: string[][]
}) {
  // 进程边界必须可控，权限位和管理员身份会让 chmod 类测试在不同 CI 上产生相反结果。
  // fixture 只模拟 ChildProcess 的公开流和终态，不替换 Ripgrep 的参数、解析或 scope 逻辑。
  // pending/spawned/released 三个信号专门区分“调用已返回”和“资源已经释放”，避免假绿。
  const spawner = Layer.effect(
    ChildProcessSpawner.ChildProcessSpawner,
    Effect.gen(function* () {
      const real = yield* ChildProcessSpawner.ChildProcessSpawner
      return ChildProcessSpawner.make((command) => {
        const standard = ChildProcess.isStandardCommand(command) ? command : undefined
        // binary 下载/解压仍走真实进程；只截获目标 rg，避免 fixture 污染安装链。
        if (path.basename(standard?.command ?? "").toLowerCase() !== (process.platform === "win32" ? "rg.exe" : "rg")) {
          return real.spawn(command)
        }
        input.calls?.push([...(standard?.args ?? [])])
        const handle = ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(0),
          exitCode: input.pending ? Effect.never : Effect.succeed(ChildProcessSpawner.ExitCode(input.code)),
          isRunning: Effect.succeed(input.pending === true),
          kill: () => Effect.void,
          stdin: Sink.drain,
          stdout: input.stdout ? Stream.make(encoder.encode(input.stdout)) : Stream.empty,
          stderr: input.stderr ? Stream.make(encoder.encode(input.stderr)) : Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
          unref: Effect.succeed(Effect.void),
        })
        const acquire = input.spawned
          ? Deferred.succeed(input.spawned, undefined).pipe(Effect.as(handle))
          : Effect.succeed(handle)
        if (!input.released) return acquire
        // release 信号来自 spawner 的资源边界，能证明是 scope 清理而非测试主动完成进程。
        return Effect.acquireRelease(acquire, () => Deferred.succeed(input.released!, undefined).pipe(Effect.asVoid))
      })
    }),
  ).pipe(Layer.provide(CrossSpawnSpawner.defaultLayer))
  return Ripgrep.layer.pipe(
    Layer.provide(spawner),
    Layer.provide(AppFileSystem.defaultLayer),
    Layer.provide(FetchHttpClient.layer),
  )
}

const partialGlob = testEffect(scriptedRipgrep({ stdout: "accessible.ts\n", code: 2 }))
// fatal fixture 与 partial fixture 共享 code 2，唯一差异是 rg 是否仍提供输入诊断。
const invalidGlob = testEffect(
  scriptedRipgrep({ stderr: "rg: error parsing glob '[': unclosed character class\n", code: 2 }),
)
const boundedReleased = Deferred.makeUnsafe<void>()
// exit 永久 pending 强制实现依赖 scope finalizer，而不是测试进程恰好自然结束。
const boundedGlob = testEffect(
  scriptedRipgrep({
    stdout: Array.from({ length: 101 }, (_, index) => `file-${index}.ts`).join("\n") + "\n",
    code: 0,
    pending: true,
    released: boundedReleased,
  }),
)
const emptyGlob = testEffect(scriptedRipgrep({ code: 1 }))
// 未知 code 单独保留，防止未来把所有非零退出都宽泛地归入 partial。
const unknownGlob = testEffect(scriptedRipgrep({ code: 3 }))
const argumentCalls: string[][] = []
// 参数捕获发生在外部进程 seam，验证的是 rg 的实际匹配/诊断契约而非私有 helper 名称。
const argumentGlob = testEffect(scriptedRipgrep({ code: 1, calls: argumentCalls }))
const filesCalls: string[][] = []
const scriptedFiles = testEffect(scriptedRipgrep({ code: 1, calls: filesCalls }))
const abortSpawned = Deferred.makeUnsafe<void>()
const abortReleased = Deferred.makeUnsafe<void>()
// abort fixture 在 stdout EOF 后卡住 exit，确保中断发生在真实等待阶段而非启动前短路。
const abortGlob = testEffect(
  scriptedRipgrep({ code: 0, pending: true, spawned: abortSpawned, released: abortReleased }),
)

const collectFiles = (input: Ripgrep.FilesInput) =>
  Ripgrep.Service.use((rg) =>
    rg.files(input).pipe(
      Stream.runCollect,
      Effect.map((c) => [...c]),
    ),
  )

const withRipgrepConfig = <A, E, R>(value: string, effect: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const prev = process.env["RIPGREP_CONFIG_PATH"]
      process.env["RIPGREP_CONFIG_PATH"] = value
      return prev
    }),
    () => effect,
    (prev) =>
      Effect.sync(() => {
        if (prev === undefined) delete process.env["RIPGREP_CONFIG_PATH"]
        else process.env["RIPGREP_CONFIG_PATH"] = prev
      }),
  )

describe("file.ripgrep", () => {
  partialGlob.live("glob keeps accessible files when traversal is incomplete", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdir()
      const result = yield* Ripgrep.Service.use((rg) => rg.glob({ cwd: dir, glob: ["*.ts"], limit: 100 }))

      // exit 2 在 --no-messages 且无诊断时代表部分遍历，不能丢掉已经得到的文件。
      expect(result).toEqual({ items: ["accessible.ts"], partial: true, truncated: false })
    }),
  )

  invalidGlob.live("glob keeps invalid patterns fatal", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdir()
      const exit = yield* Ripgrep.Service.use((rg) => rg.glob({ cwd: dir, glob: ["["], limit: 100 })).pipe(Effect.exit)

      // --no-messages 不能吞输入诊断，否则无效 pattern 会被误报成可恢复的文件权限问题。
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(String(Cause.squash(exit.cause))).toContain("error parsing glob")
      }
    }),
  )

  boundedGlob.live("glob returns bounded results before a pending process exits", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdir()
      const result = yield* Ripgrep.Service.use((rg) => rg.glob({ cwd: dir, glob: ["*.ts"], limit: 100 }))

      expect(result.items).toHaveLength(100)
      expect(result.truncated).toBe(true)
      // 不断言 kill 调用次数，允许未来替换 finalizer 实现，只约束公开返回和资源生命周期。
      // 若实现等待 exitCode，这个 release 永远不会发生，测试会以明确超时报错而不是挂死。
      yield* awaitWithTimeout(Deferred.await(boundedReleased), "bounded glob did not release its child scope")
    }),
  )

  emptyGlob.live("glob distinguishes a complete empty search", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdir()
      const result = yield* Ripgrep.Service.use((rg) => rg.glob({ cwd: dir, glob: ["*.ts"], limit: 100 }))

      expect(result).toEqual({ items: [], partial: false, truncated: false })
    }),
  )

  unknownGlob.live("glob fails closed for an unknown ripgrep exit code", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdir()
      const exit = yield* Ripgrep.Service.use((rg) => rg.glob({ cwd: dir, glob: ["*.ts"], limit: 100 })).pipe(
        Effect.exit,
      )

      // 只有已验证的 code 2 空诊断可降级；未知进程状态不能伪装成 partial success。
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(String(Cause.squash(exit.cause))).toContain("code 3")
    }),
  )

  argumentGlob.live("glob preserves search scope and explicit git patterns", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdir()
      yield* Ripgrep.Service.use((rg) => rg.glob({ cwd: dir, glob: [".git/config"], limit: 100 }))
      const args = argumentCalls.at(-1) ?? []

      // 参数顺序是外部 rg 的行为契约：后置用户 glob 才能覆盖默认 .git 排除。
      expect(args).toContain("--no-messages")
      expect(args).not.toContain("--follow")
      expect(args.indexOf("--glob=!.git/*")).toBeLessThan(args.indexOf("--glob=.git/config"))
    }),
  )

  scriptedFiles.live("files keeps its existing diagnostic behavior", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdir()
      yield* Ripgrep.Service.use((rg) => rg.files({ cwd: dir }).pipe(Stream.runCollect))

      // streaming files 的调用方没有 partial 终态，不能静默加入 --no-messages 后吞掉失败原因。
      expect(filesCalls.at(-1) ?? []).not.toContain("--no-messages")
    }),
  )

  abortGlob.live("glob aborts a running process and releases its scope", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdir()
      const controller = new AbortController()
      const fiber = yield* Effect.forkScoped(
        Ripgrep.Service.use((rg) => rg.glob({ cwd: dir, glob: ["*.ts"], limit: 100, signal: controller.signal })),
      )
      yield* awaitWithTimeout(Deferred.await(abortSpawned), "glob process did not start")
      controller.abort()
      const exit = yield* Fiber.await(fiber)

      expect(Exit.isFailure(exit)).toBe(true)
      // abort 不能只让调用方返回；child 的 scoped resource 也必须完成 release。
      yield* awaitWithTimeout(Deferred.await(abortReleased), "aborted glob did not release its child scope")
    }),
  )

  it.live("defaults to include hidden", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdir((dir) =>
        Effect.gen(function* () {
          yield* write(path.join(dir, "visible.txt"), "hello")
          yield* mkdir(path.join(dir, ".opencode"))
          yield* write(path.join(dir, ".opencode", "thing.json"), "{}")
        }),
      )

      const files = yield* collectFiles({ cwd: dir })
      expect(files.includes("visible.txt")).toBe(true)
      expect(files.includes(path.join(".opencode", "thing.json"))).toBe(true)
    }),
  )

  it.live("hidden false excludes hidden", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdir((dir) =>
        Effect.gen(function* () {
          yield* write(path.join(dir, "visible.txt"), "hello")
          yield* mkdir(path.join(dir, ".opencode"))
          yield* write(path.join(dir, ".opencode", "thing.json"), "{}")
        }),
      )

      const files = yield* collectFiles({ cwd: dir, hidden: false })
      expect(files.includes("visible.txt")).toBe(true)
      expect(files.includes(path.join(".opencode", "thing.json"))).toBe(false)
    }),
  )

  it.live("search returns empty when nothing matches", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdir((dir) => write(path.join(dir, "match.ts"), "const value = 'other'\n"))

      const result = yield* Ripgrep.Service.use((rg) => rg.search({ cwd: dir, pattern: "needle" }))
      expect(result.partial).toBe(false)
      expect(result.items).toEqual([])
    }),
  )

  it.live("search returns match metadata with normalized path", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdir((dir) =>
        Effect.gen(function* () {
          yield* mkdir(path.join(dir, "src"))
          yield* write(path.join(dir, "src", "match.ts"), "const needle = 1\n")
        }),
      )

      const result = yield* Ripgrep.Service.use((rg) => rg.search({ cwd: dir, pattern: "needle" }))
      expect(result.partial).toBe(false)
      expect(result.items).toHaveLength(1)
      expect(result.items[0]?.path.text).toBe(path.join("src", "match.ts"))
      expect(result.items[0]?.line_number).toBe(1)
      expect(result.items[0]?.lines.text).toContain("needle")
    }),
  )

  it.live("search returns matched rows with glob filter", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdir((dir) =>
        Effect.gen(function* () {
          yield* write(path.join(dir, "match.ts"), "const value = 'needle'\n")
          yield* write(path.join(dir, "skip.txt"), "const value = 'other'\n")
        }),
      )

      const result = yield* Ripgrep.Service.use((rg) => rg.search({ cwd: dir, pattern: "needle", glob: ["*.ts"] }))
      expect(result.partial).toBe(false)
      expect(result.items).toHaveLength(1)
      expect(result.items[0]?.path.text).toContain("match.ts")
      expect(result.items[0]?.lines.text).toContain("needle")
    }),
  )

  it.live("search supports explicit file targets", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdir((dir) =>
        Effect.gen(function* () {
          yield* write(path.join(dir, "match.ts"), "const value = 'needle'\n")
          yield* write(path.join(dir, "skip.ts"), "const value = 'needle'\n")
        }),
      )

      const file = path.join(dir, "match.ts")
      const result = yield* Ripgrep.Service.use((rg) => rg.search({ cwd: dir, pattern: "needle", file: [file] }))
      expect(result.partial).toBe(false)
      expect(result.items).toHaveLength(1)
      expect(result.items[0]?.path.text).toBe(file)
    }),
  )

  it.live("search timeout returns a bounded partial result instead of failing", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdir((dir) =>
        Effect.gen(function* () {
          // 真实 rg 进程需要足够大的输入才能稳定越过 1ms 预算；该测试验证公开
          // Ripgrep.search 行为，不断言内部 kill 调用形状，避免和进程实现耦合。
          yield* write(path.join(dir, "large.txt"), "x".repeat(32 * 1024 * 1024))
        }),
      )

      const result = yield* Ripgrep.Service.use((rg) => rg.search({ cwd: dir, pattern: "needle", timeout: 1 }))

      expect(result.items).toEqual([])
      expect(result.timedOut).toBe(true)
      expect(result.truncated).toBe(false)
    }),
  )

  it.live("search timeout does not hide invalid regex errors", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdir((dir) => write(path.join(dir, "match.txt"), "needle\n"))

      // timeout 存在时，正则语法错误仍是 rg 的真实失败，
      // 不能被降级成“超时后的空部分结果”。
      const exit = yield* Ripgrep.Service.use((rg) => rg.search({ cwd: dir, pattern: "(", timeout: 1000 })).pipe(
        Effect.exit,
      )

      expect(exit._tag).toBe("Failure")
    }),
  )

  it.live("files returns empty when glob matches no files", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdir((dir) =>
        Effect.gen(function* () {
          yield* mkdir(path.join(dir, "packages", "console"))
          yield* write(path.join(dir, "packages", "console", "package.json"), "{}")
        }),
      )

      const files = yield* collectFiles({ cwd: dir, glob: ["packages/*"] })
      expect(files).toEqual([])
    }),
  )

  it.live("files returns stream of filenames", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdir((dir) =>
        Effect.gen(function* () {
          yield* write(path.join(dir, "a.txt"), "hello")
          yield* write(path.join(dir, "b.txt"), "world")
        }),
      )

      const files = yield* collectFiles({ cwd: dir }).pipe(Effect.map((files) => files.sort()))
      expect(files).toEqual(["a.txt", "b.txt"])
    }),
  )

  it.live("files respects glob filter", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdir((dir) =>
        Effect.gen(function* () {
          yield* write(path.join(dir, "keep.ts"), "yes")
          yield* write(path.join(dir, "skip.txt"), "no")
        }),
      )

      const files = yield* collectFiles({ cwd: dir, glob: ["*.ts"] })
      expect(files).toEqual(["keep.ts"])
    }),
  )

  it.live("files dies on nonexistent directory", () =>
    Effect.gen(function* () {
      const exit = yield* Ripgrep.Service.use((rg) =>
        rg.files({ cwd: "/tmp/nonexistent-dir-12345" }).pipe(Stream.runCollect),
      ).pipe(Effect.exit)
      expect(exit._tag).toBe("Failure")
    }),
  )

  it.live("ignores RIPGREP_CONFIG_PATH in direct mode", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdir((dir) => write(path.join(dir, "match.ts"), "const needle = 1\n"))

      const result = yield* withRipgrepConfig(
        path.join(dir, "missing-ripgreprc"),
        Ripgrep.Service.use((rg) => rg.search({ cwd: dir, pattern: "needle" })),
      )
      expect(result.items).toHaveLength(1)
    }),
  )

  it.live("ignores RIPGREP_CONFIG_PATH in worker mode", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdir((dir) => write(path.join(dir, "match.ts"), "const needle = 1\n"))

      const result = yield* withRipgrepConfig(
        path.join(dir, "missing-ripgreprc"),
        Ripgrep.Service.use((rg) => rg.search({ cwd: dir, pattern: "needle" })),
      )
      expect(result.items).toHaveLength(1)
    }),
  )
})
