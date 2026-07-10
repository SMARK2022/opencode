import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Cause, Effect, Exit, Layer } from "effect"
import { GlobTool } from "../../src/tool/glob"
import { SessionID, MessageID } from "../../src/session/schema"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Ripgrep } from "../../src/file/ripgrep"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Truncate } from "@/tool/truncate"
import { Agent } from "../../src/agent/agent"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { Reference } from "@/reference/reference"

const it = testEffect(
  Layer.mergeAll(
    CrossSpawnSpawner.defaultLayer,
    AppFileSystem.defaultLayer,
    Ripgrep.defaultLayer,
    Truncate.defaultLayer,
    Agent.defaultLayer,
    Reference.defaultLayer,
  ),
)

const ctx = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

describe("tool.glob", () => {
  it.instance("reports an incomplete empty result without claiming the search was exhaustive", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      // 这里 mock 的是外部扫描结果 seam；路径解析、Permission、Tool 文案和 metadata 仍执行真实实现。
      const info = yield* GlobTool.pipe(
        Effect.provide(
          Layer.mock(Ripgrep.Service)({
            glob: () => Effect.succeed({ items: [], partial: true, truncated: false }),
          }),
        ),
      )
      const glob = yield* info.init()
      const result = yield* glob.execute({ pattern: "*.ts", path: test.directory }, ctx)

      // 同时断言计数和 warning，避免未来只修模型文案却再次丢失可审计 metadata。
      // partial-empty 只能证明可访问范围内没有结果，不能复用完整搜索的确定性文案。
      expect(result.output).not.toBe("No files found")
      expect(result.output).toContain("Search incomplete")
      expect(result.metadata).toMatchObject({ count: 0, total: 0, truncated: false, partial: true })
    }),
  )

  it.instance("keeps accessible files in an incomplete result", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      // accessible.ts 不必预先存在：现有 stat 竞态约定会以 mtime 0 保留 rg 已确认的路径。
      const info = yield* GlobTool.pipe(
        Effect.provide(
          Layer.mock(Ripgrep.Service)({
            glob: () => Effect.succeed({ items: ["accessible.ts"], partial: true, truncated: false }),
          }),
        ),
      )
      const glob = yield* info.init()
      const result = yield* glob.execute({ pattern: "*.ts", path: test.directory }, ctx)

      // 部分失败不能回滚已经枚举出的路径，warning 应作为补充而不是替代结果。
      expect(result.output).toContain(path.join(test.directory, "accessible.ts"))
      expect(result.output).toContain("Search incomplete")
      expect(result.metadata).toMatchObject({ count: 1, total: 1, truncated: false, partial: true })
    }),
  )

  it.instance("preserves the exact empty result for a complete search", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      // 完整空结果是兼容基线，防止修复 partial 时把所有零结果都改成不确定文案。
      const info = yield* GlobTool.pipe(
        Effect.provide(
          Layer.mock(Ripgrep.Service)({
            glob: () => Effect.succeed({ items: [], partial: false, truncated: false }),
          }),
        ),
      )
      const glob = yield* info.init()
      const result = yield* glob.execute({ pattern: "*.ts", path: test.directory }, ctx)

      // 只有完整搜索可以继续提供确定性的兼容文案，避免把所有空结果都降级成警告。
      expect(result.output).toBe("No files found")
      expect(result.metadata.partial).toBe(false)
    }),
  )

  it.instance("preserves the bounded total when results are truncated", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      // fixture 已经模拟 Ripgrep 丢弃第 101 条后的公开结果，Tool 只验证原 bounded total 口径。
      const info = yield* GlobTool.pipe(
        Effect.provide(
          Layer.mock(Ripgrep.Service)({
            glob: () =>
              Effect.succeed({
                items: Array.from({ length: 100 }, (_, index) => `file-${index}.ts`),
                partial: false,
                truncated: true,
              }),
          }),
        ),
      )
      const glob = yield* info.init()
      const result = yield* glob.execute({ pattern: "*.ts", path: test.directory }, ctx)

      // 第 101 条是“至少还有结果”的 sentinel，total 不能被误写成精确全量。
      expect(result.metadata).toMatchObject({ count: 100, total: 101, truncated: true, partial: false })
      expect(result.output).toContain("Total: 101+ files")
    }),
  )

  it.instance("matches files under a path containing spaces", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const search = path.join(test.directory, "space dir")
      yield* Effect.promise(() => fs.mkdir(search, { recursive: true }))
      // 文件名保持简单，单独隔离 cwd 空格这个变量，失败时能直接定位参数数组边界。
      yield* Effect.promise(() => Bun.write(path.join(search, "match.ts"), "export const value = 1\n"))
      const info = yield* GlobTool
      const glob = yield* info.init()
      const result = yield* glob.execute({ pattern: "*.ts", path: search }, ctx)

      // cwd 通过 ChildProcess 参数传递而非 shell 拼接，空格不能改变搜索根或 pattern。
      expect(result.output).toContain(path.join(search, "match.ts"))
    }),
  )

  it.instance("matches files from a directory path", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => Bun.write(path.join(test.directory, "a.ts"), "export const a = 1\n"))
      yield* Effect.promise(() => Bun.write(path.join(test.directory, "b.txt"), "hello\n"))
      const info = yield* GlobTool
      const glob = yield* info.init()
      const result = yield* glob.execute(
        {
          pattern: "*.ts",
          path: test.directory,
        },
        ctx,
      )
      expect(result.metadata.count).toBe(1)
      expect(result.output).toContain(path.join(test.directory, "a.ts"))
      expect(result.output).not.toContain(path.join(test.directory, "b.txt"))
    }),
  )

  it.instance("rejects exact file paths", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const file = path.join(test.directory, "a.ts")
      yield* Effect.promise(() => Bun.write(file, "export const a = 1\n"))
      const info = yield* GlobTool
      const glob = yield* info.init()
      const exit = yield* glob
        .execute(
          {
            pattern: "*.ts",
            path: file,
          },
          ctx,
        )
        .pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const err = Cause.squash(exit.cause)
        expect(err instanceof Error ? err.message : String(err)).toContain("glob path must be a directory")
      }
    }),
  )
})
