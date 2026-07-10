import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Cause, Effect, Exit, Layer } from "effect"
import { GlobTool } from "../../src/tool/glob"
import { SessionID, MessageID } from "../../src/session/schema"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { Entry } from "@opencode-ai/schema/filesystem"
import { RelativePath } from "@opencode-ai/core/schema"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { Truncate } from "@/tool/truncate"
import { Agent } from "../../src/agent/agent"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Git } from "@/git"
import { Filesystem } from "@/util/filesystem"
import { Permission } from "../../src/permission"
import type * as Tool from "../../src/tool/tool"

const toolLayer = (flags: Partial<RuntimeFlags.Info> = {}) =>
  LayerNode.compile(
    LayerNode.group([CrossSpawnSpawner.node, FSUtil.node, Ripgrep.node, Truncate.node, Agent.node, Git.node]),
  )

const it = testEffect(toolLayer())
const full = (p: string) => (process.platform === "win32" ? Filesystem.normalizePath(p) : p)

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

const asks = () => {
  const items: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
  return {
    items,
    next: {
      ...ctx,
      ask: (req: Omit<PermissionV1.Request, "id" | "sessionID" | "tool">) =>
        Effect.sync(() => {
          items.push(req)
        }),
    } satisfies Tool.Context,
  }
}

const githubBase = <A, E, R>(url: string, self: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = process.env.OPENCODE_REPO_CLONE_GITHUB_BASE_URL
      process.env.OPENCODE_REPO_CLONE_GITHUB_BASE_URL = url
      return previous
    }),
    () => self,
    (previous) =>
      Effect.sync(() => {
        if (previous) process.env.OPENCODE_REPO_CLONE_GITHUB_BASE_URL = previous
        else delete process.env.OPENCODE_REPO_CLONE_GITHUB_BASE_URL
      }),
  )

const git = Effect.fn("GlobToolTest.git")(function* (cwd: string, args: string[]) {
  return yield* Effect.promise(async () => {
    const proc = Bun.spawn(["git", ...args], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    if (code !== 0) throw new Error(stderr.trim() || stdout.trim() || `git ${args.join(" ")} failed`)
    return stdout.trim()
  })
})

describe("tool.glob", () => {
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

  // [local-smark] 源 0413 核心缺陷场景：rg exit 2（TCC/ACL/EACCES）时 glob 通道
  // 透出 partial——零匹配不得伪装成全量确定性阴性，模型可据此收窄路径
  it.instance("flags zero matches as partial when glob reports inaccessible paths", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => Bun.write(path.join(test.directory, "keep.txt"), "x\n"))

      // mock 的是外部扫描 seam；路径解析、Permission、文案和 metadata 仍执行真实实现
      const info = yield* GlobTool.pipe(
        Effect.provide(
          Layer.mock(Ripgrep.Service)({
            find: () => Effect.die("unused in partial test"),
            glob: () => Effect.succeed({ files: [], partial: true, truncated: false, timedOut: false }),
            grep: () => Effect.die("unused in partial test"),
            search: () => Effect.die("unused in partial test"),
          }),
        ),
      )
      const glob = yield* info.init()
      const result = yield* glob.execute({ pattern: "*.txt", path: test.directory }, ctx)

      // 同时断言 metadata 与文案，防止未来只修文案却再次丢失可审计标记
      expect(result.metadata.count).toBe(0)
      expect(result.metadata.partial).toBe(true)
      expect(result.output).toContain("could not be accessed")
      expect(result.output).not.toBe("No files found")
    }),
  )

  // [local-smark] 有匹配 + partial：可达文件照常列出（部分失败不能回滚已枚举路径），
  // 不可访问警告作为补充而不是替代结果
  it.instance("keeps accessible files and marks inaccessibility on partial glob", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => Bun.write(path.join(test.directory, "keep.ts"), "export const a = 1\n"))

      const info = yield* GlobTool.pipe(
        Effect.provide(
          Layer.mock(Ripgrep.Service)({
            find: () => Effect.die("unused in partial test"),
            glob: () =>
              Effect.succeed({
                files: [Entry.make({ path: RelativePath.make("keep.ts"), type: "file" })],
                partial: true,
                truncated: false,
                timedOut: false,
              }),
            grep: () => Effect.die("unused in partial test"),
            search: () => Effect.die("unused in partial test"),
          }),
        ),
      )
      const glob = yield* info.init()
      const result = yield* glob.execute({ pattern: "*.ts", path: test.directory }, ctx)

      expect(result.metadata.count).toBe(1)
      expect(result.metadata.partial).toBe(true)
      expect(result.output).toContain(path.join(test.directory, "keep.ts"))
      expect(result.output).toContain("could not be accessed")
    }),
  )

  // [local-smark] 完整空结果是兼容基线：修复 partial 时不得把所有零结果
  // 都降级成不确定文案——只有真实 partial 才携带警告
  it.instance("preserves the exact empty result for a complete search", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance

      const info = yield* GlobTool.pipe(
        Effect.provide(
          Layer.mock(Ripgrep.Service)({
            find: () => Effect.die("unused in partial test"),
            glob: () => Effect.succeed({ files: [], partial: false, truncated: false, timedOut: false }),
            grep: () => Effect.die("unused in partial test"),
            search: () => Effect.die("unused in partial test"),
          }),
        ),
      )
      const glob = yield* info.init()
      const result = yield* glob.execute({ pattern: "*.ts", path: test.directory }, ctx)

      expect(result.output).toBe("No files found")
      expect(result.metadata.partial).toBeUndefined()
    }),
  )

  // sentinel证明第101条存在，total下界与真实截断状态必须一同保留。
  // 恰好100条的完整结果不适用此case，不能仅从返回长度推断。
  it.instance("preserves the bounded total when results are truncated", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance

      const info = yield* GlobTool.pipe(
        Effect.provide(
          Layer.mock(Ripgrep.Service)({
            find: () => Effect.die("unused in partial test"),
            glob: () =>
              Effect.succeed({
                files: Array.from({ length: 100 }, (_, index) =>
                  Entry.make({ path: RelativePath.make(`file-${index}.ts`), type: "file" }),
                ),
                partial: false,
                truncated: true,
                timedOut: false,
              }),
            grep: () => Effect.die("unused in partial test"),
            search: () => Effect.die("unused in partial test"),
          }),
        ),
      )
      const glob = yield* info.init()
      const result = yield* glob.execute({ pattern: "*.ts", path: test.directory }, ctx)

      expect(result.metadata.count).toBe(100)
      expect(result.metadata.total).toBe(101)
      expect(result.metadata.truncated).toBe(true)
      expect(result.output).toContain("Total: 101+ files")
    }),
  )

  // [local-smark] 含空格路径的真实集成：cwd 经参数数组传递而非 shell 拼接，
  // 空格不能改变搜索根或 pattern
  it.instance("matches files under a path containing spaces", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const search = path.join(test.directory, "space dir")
      yield* Effect.promise(() => fs.mkdir(search, { recursive: true }))
      yield* Effect.promise(() => Bun.write(path.join(search, "match.ts"), "export const value = 1\n"))
      const info = yield* GlobTool
      const glob = yield* info.init()
      const result = yield* glob.execute({ pattern: "*.ts", path: search }, ctx)

      expect(result.output).toContain(path.join(search, "match.ts"))
    }),
  )
})
