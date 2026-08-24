import { describe, test, expect } from "bun:test"
import { NodeFileSystem } from "@effect/platform-node"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Effect, FileSystem, Layer, PlatformError } from "effect"
import { Truncate } from "@/tool/truncate"
import { Config } from "@/config/config"
import { Identifier } from "../../src/id/id"
import { Process } from "@/util/process"
import path from "path"
import { testEffect } from "../lib/effect"
import { writeFileStringScoped } from "../lib/filesystem"
import { TestConfig } from "../fixture/config"

const FIXTURES_DIR = path.join(import.meta.dir, "fixtures")
const ROOT = path.resolve(import.meta.dir, "..", "..")

const it = testEffect(Layer.mergeAll(Truncate.defaultLayer, NodeFileSystem.layer, AppFileSystem.defaultLayer))

const removedAfterStatFailure: string[] = []
const statFailureFileSystem = FileSystem.makeNoop({
  // 完整 noop service 保留 FileSystem 的 symbol/sink 契约，只覆写本用例可达的三个操作。
  readDirectory: () => Effect.succeed([Identifier.create("tool", "ascending", 0)]),
  stat: () =>
    Effect.fail(PlatformError.systemError({ _tag: "PermissionDenied", module: "FileSystem", method: "stat" })),
  remove: (file) =>
    Effect.sync(() => {
      removedAfterStatFailure.push(file)
    }),
})
const statFailureIt = testEffect(
  Truncate.layer.pipe(
    Layer.provide(
      Layer.mock(AppFileSystem.Service, {
        ...statFailureFileSystem,
        // AppFileSystem 额外的同步 matcher 不是本路径输入，但必须维持 service 的完整结构。
        globMatch: () => false,
      }),
    ),
  ),
)

const configuredLayer = (cfg: Config.Info) =>
  Layer.mergeAll(
    Truncate.defaultLayer,
    NodeFileSystem.layer,
    AppFileSystem.defaultLayer,
    TestConfig.layer({ get: () => Effect.succeed(cfg) }),
  )
const configuredIt = (cfg: Config.Info) => testEffect(configuredLayer(cfg))

describe("Truncate", () => {
  describe("output", () => {
    it.live("truncates large json file by bytes", () =>
      Effect.gen(function* () {
        const svc = yield* Truncate.Service
        const fsys = yield* AppFileSystem.Service
        const content = yield* fsys.readFileString(path.join(FIXTURES_DIR, "models-api.json"))
        const result = yield* svc.output(content)

        expect(result.truncated).toBe(true)
        expect(result.content).toContain('<opencode_notice type="output_truncated" source="tool"')
        if (result.truncated) expect(result.outputPath).toBeDefined()
      }),
    )

    it.live("returns content unchanged when under limits", () =>
      Effect.gen(function* () {
        const svc = yield* Truncate.Service
        const content = "line1\nline2\nline3"
        const result = yield* svc.output(content)

        expect(result.truncated).toBe(false)
        expect(result.content).toBe(content)
      }),
    )

    it.live("truncates by line count", () =>
      Effect.gen(function* () {
        const svc = yield* Truncate.Service
        const lines = Array.from({ length: 100 }, (_, i) => `line${i}`).join("\n")
        const result = yield* svc.output(lines, { maxLines: 10 })

        expect(result.truncated).toBe(true)
        expect(result.content).toContain('<opencode_notice type="output_truncated" source="tool"')
        expect(result.content).toContain('total="100L/')
        expect(result.content).toContain('shown="head 10L/')
        if (!result.truncated) throw new Error("expected truncated")
        expect(result.content).toContain(`path="${result.outputPath}`)
      }),
    )

    it.live("guides targeted recovery from saved output when truncated", () =>
      Effect.gen(function* () {
        const svc = yield* Truncate.Service
        const lines = Array.from({ length: 100 }, (_, i) => `line${i}`).join("\n")
        const result = yield* svc.output(lines, { maxLines: 10 })

        expect(result.truncated).toBe(true)
        if (!result.truncated) throw new Error("expected truncated")
        // Notice 是模型可见的恢复入口；这里验证它给出先 grep 定位、再 read
        // 局部读取的低成本路径，避免调用方为了找隐藏日志而直接读取完整文件。
        expect(result.content).toContain(`path="${result.outputPath}`)
        expect(result.content).toContain("grep")
        expect(result.content).toContain("read offset/limit")
        expect(result.content).toContain("Avoid reading the full file")
      }),
    )

    it.live("does not count final newline as an extra notice line", () =>
      Effect.gen(function* () {
        const svc = yield* Truncate.Service
        const lines = Array.from({ length: 12 }, (_, i) => `line${i}`).join("\n") + "\n"
        const result = yield* svc.output(lines, { maxLines: 10 })

        expect(result.truncated).toBe(true)
        expect(result.content).toContain('total="12L/')
        expect(result.content).toContain('shown="head 10L/')
      }),
    )

    it.live("truncates by byte count", () =>
      Effect.gen(function* () {
        const svc = yield* Truncate.Service
        const content = "a".repeat(1000)
        const result = yield* svc.output(content, { maxBytes: 100 })

        expect(result.truncated).toBe(true)
        expect(result.content).toContain('<opencode_notice type="output_truncated" source="tool"')
        expect(result.content).toContain('shown="head')
      }),
    )

    it.live("truncates from head by default", () =>
      Effect.gen(function* () {
        const svc = yield* Truncate.Service
        const lines = Array.from({ length: 10 }, (_, i) => `line${i}`).join("\n")
        const result = yield* svc.output(lines, { maxLines: 3 })

        expect(result.truncated).toBe(true)
        expect(result.content).toContain("line0")
        expect(result.content).toContain("line1")
        expect(result.content).toContain("line2")
        expect(result.content).not.toContain("line9")
      }),
    )

    it.live("truncates from tail when direction is tail", () =>
      Effect.gen(function* () {
        const svc = yield* Truncate.Service
        const lines = Array.from({ length: 10 }, (_, i) => `line${i}`).join("\n")
        const result = yield* svc.output(lines, { maxLines: 3, direction: "tail" })

        expect(result.truncated).toBe(true)
        expect(result.content).toContain("line7")
        expect(result.content).toContain("line8")
        expect(result.content).toContain("line9")
        expect(result.content).not.toContain("line0")
      }),
    )

    test("uses default MAX_LINES and MAX_BYTES", () => {
      expect(Truncate.MAX_LINES).toBe(1000)
      expect(Truncate.MAX_BYTES).toBe(16 * 1024)
    })

    it.live("limits() falls back to MAX_LINES/MAX_BYTES when Config is not provided", () =>
      Effect.gen(function* () {
        const svc = yield* Truncate.Service
        const resolved = yield* svc.limits()
        expect(resolved.maxLines).toBe(Truncate.MAX_LINES)
        expect(resolved.maxBytes).toBe(Truncate.MAX_BYTES)
      }),
    )

    describe("with tool_output config", () => {
      const limitsIt = configuredIt({ tool_output: { max_lines: 123, max_bytes: 456 } })
      limitsIt.live("limits() reflects config overrides", () =>
        Effect.gen(function* () {
          const resolved = yield* (yield* Truncate.Service).limits()
          expect(resolved.maxLines).toBe(123)
          expect(resolved.maxBytes).toBe(456)
        }),
      )

      // Huge byte budget isolates line truncation. 100 lines against max_lines: 10
      // proves the configured line limit is what `output()` enforces.
      const lineIt = configuredIt({ tool_output: { max_lines: 10, max_bytes: 1024 * 1024 } })
      lineIt.live("output() truncates to configured max_lines", () =>
        Effect.gen(function* () {
          const content = Array.from({ length: 100 }, (_, i) => `line${i}`).join("\n")
          const result = yield* (yield* Truncate.Service).output(content)
          expect(result.truncated).toBe(true)
          expect(result.content).toContain('<opencode_notice type="output_truncated" source="tool"')
          expect(result.content).toContain('total="100L/')
          expect(result.content).toContain('shown="head 10L/')
        }),
      )

      // Huge line budget isolates byte truncation.
      const byteIt = configuredIt({ tool_output: { max_lines: 1_000_000, max_bytes: 100 } })
      byteIt.live("output() truncates to configured max_bytes", () =>
        Effect.gen(function* () {
          const content = "a".repeat(1000)
          const result = yield* (yield* Truncate.Service).output(content)
          expect(result.truncated).toBe(true)
          expect(result.content).toContain('<opencode_notice type="output_truncated" source="tool"')
          expect(result.content).toContain('shown="head')
        }),
      )

      const overrideIt = configuredIt({ tool_output: { max_lines: 10, max_bytes: 100 } })
      overrideIt.live("per-call options still override config", () =>
        Effect.gen(function* () {
          const content = Array.from({ length: 50 }, (_, i) => `line${i}`).join("\n")
          const result = yield* (yield* Truncate.Service).output(content, {
            maxLines: 1000,
            maxBytes: 1024 * 1024,
          })
          expect(result.truncated).toBe(false)
        }),
      )
    })

    it.live("large single-line file truncates with byte message", () =>
      Effect.gen(function* () {
        const svc = yield* Truncate.Service
        const fsys = yield* AppFileSystem.Service
        const content = yield* fsys.readFileString(path.join(FIXTURES_DIR, "models-api.json"))
        const result = yield* svc.output(content)

        expect(result.truncated).toBe(true)
        expect(result.content).toContain('<opencode_notice type="output_truncated" source="tool"')
        expect(result.content).toContain('shown="head')
        expect(Buffer.byteLength(content, "utf-8")).toBeGreaterThan(Truncate.MAX_BYTES)
      }),
    )

    it.live("writes full output to file when truncated", () =>
      Effect.gen(function* () {
        const svc = yield* Truncate.Service
        const lines = Array.from({ length: 100 }, (_, i) => `line${i}`).join("\n")
        const result = yield* svc.output(lines, { maxLines: 10 })

        expect(result.truncated).toBe(true)
        expect(result.content).toContain('<opencode_notice type="output_truncated" source="tool"')
        if (!result.truncated) throw new Error("expected truncated")
        expect(result.outputPath).toBeDefined()
        expect(result.outputPath).toContain("tool_")

        const fsys = yield* AppFileSystem.Service
        const written = yield* fsys.readFileString(result.outputPath!)
        expect(written).toBe(lines)
      }),
    )

    it.live("keeps truncation notice compact when agent has task permission", () =>
      Effect.gen(function* () {
        const svc = yield* Truncate.Service
        const lines = Array.from({ length: 100 }, (_, i) => `line${i}`).join("\n")
        const agent = { permission: [{ permission: "task", pattern: "*", action: "allow" as const }] }
        const result = yield* svc.output(lines, { maxLines: 10 }, agent as any)

        expect(result.truncated).toBe(true)
        expect(result.content).toContain('<opencode_notice type="output_truncated" source="tool"')
        expect(result.content).not.toContain("Task tool")
        expect(result.content).not.toContain("Use Grep")
      }),
    )

    it.live("keeps truncation notice compact when agent lacks task permission", () =>
      Effect.gen(function* () {
        const svc = yield* Truncate.Service
        const lines = Array.from({ length: 100 }, (_, i) => `line${i}`).join("\n")
        const agent = { permission: [{ permission: "task", pattern: "*", action: "deny" as const }] }
        const result = yield* svc.output(lines, { maxLines: 10 }, agent as any)

        expect(result.truncated).toBe(true)
        expect(result.content).toContain('<opencode_notice type="output_truncated" source="tool"')
        expect(result.content).not.toContain("Use Grep")
        expect(result.content).not.toContain("Task tool")
      }),
    )

    it.live("does not write file when not truncated", () =>
      Effect.gen(function* () {
        const svc = yield* Truncate.Service
        const content = "short content"
        const result = yield* svc.output(content)

        expect(result.truncated).toBe(false)
        if (result.truncated) throw new Error("expected not truncated")
        expect("outputPath" in result).toBe(false)
      }),
    )

    test("loads truncate effect in a fresh process", async () => {
      const out = await Process.run([process.execPath, "run", path.join(ROOT, "src", "tool", "truncate.ts")], {
        cwd: ROOT,
      })

      expect(out.code).toBe(0)
    }, 20000)
  })

  describe("cleanup", () => {
    const DAY_MS = 24 * 60 * 60 * 1000

    statFailureIt.live("preserves entries when stat metadata is unavailable", () =>
      Effect.gen(function* () {
        removedAfterStatFailure.length = 0
        const svc = yield* Truncate.Service
        yield* svc.cleanup()

        // 未知 metadata 不能被解释为过期；通过 remove 的外部可观察结果锁定保留语义。
        expect(removedAfterStatFailure).toEqual([])
      }),
    )

    it.live("uses file mtime when IDs wrap", () =>
      Effect.gen(function* () {
        const svc = yield* Truncate.Service
        const fs = yield* FileSystem.FileSystem

        yield* fs.makeDirectory(Truncate.DIR, { recursive: true })

        // 两个文件名固定跨越 2^36 ms 回绕边界，避免测试结果依赖执行当天处于哪个 ID 纪元。
        const old = path.join(Truncate.DIR, Identifier.create("tool", "ascending", 2 ** 36 - 1))
        const recent = path.join(Truncate.DIR, Identifier.create("tool", "ascending", 2 ** 36 + 1))

        yield* writeFileStringScoped(old, "old content")
        yield* writeFileStringScoped(recent, "recent content")
        // retention 的独立真值来自文件元数据：旧文件超过七天，新文件只有三天。
        yield* fs.utimes(old, new Date(), new Date(Date.now() - 10 * DAY_MS))
        yield* fs.utimes(recent, new Date(), new Date(Date.now() - 3 * DAY_MS))
        yield* svc.cleanup()

        // lexical-low 的回绕后 ID 仍必须按 recent mtime 保留，不能被当成远古时间。
        expect(yield* fs.exists(old)).toBe(false)
        expect(yield* fs.exists(recent)).toBe(true)
      }),
    )
  })
})
