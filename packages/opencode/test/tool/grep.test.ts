import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { describe, expect } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Layer } from "effect"
import { GrepTool } from "../../src/tool/grep"
import { provideInstance, testInstanceStoreLayer, TestInstance } from "../fixture/fixture"
import { SessionID, MessageID } from "../../src/session/schema"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Global } from "@opencode-ai/core/global"
import { Truncate } from "@/tool/truncate"
import { Agent } from "../../src/agent/agent"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { Entry, Match } from "@opencode-ai/schema/filesystem"
import { RelativePath } from "@opencode-ai/core/schema"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { testEffect } from "../lib/effect"
import { Permission } from "../../src/permission"
import type * as Tool from "../../src/tool/tool"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Git } from "@/git"
import { Filesystem } from "@/util/filesystem"

const toolLayer = (flags: Partial<RuntimeFlags.Info> = {}) =>
  LayerNode.compile(
    LayerNode.group([CrossSpawnSpawner.node, FSUtil.node, Ripgrep.node, Truncate.node, Agent.node, Git.node]),
  )

const it = testEffect(toolLayer())
const rooted = testEffect(Layer.mergeAll(toolLayer(), testInstanceStoreLayer))

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

const root = path.join(__dirname, "../..")
const full = (p: string) => (process.platform === "win32" ? Filesystem.normalizePath(p) : p)

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

const git = Effect.fn("GrepToolTest.git")(function* (cwd: string, args: string[]) {
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

describe("tool.grep", () => {
  rooted.live("basic search", () =>
    Effect.gen(function* () {
      const info = yield* GrepTool
      const grep = yield* info.init()
      const result = yield* provideInstance(root)(
        grep.execute(
          {
            pattern: "export",
            path: path.join(root, "src/tool"),
            include: "*.ts",
          },
          ctx,
        ),
      )
      expect(result.metadata.matches).toBeGreaterThan(0)
      expect(result.output).toContain("Found")
    }),
  )

  it.instance("no matches returns correct output", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => Bun.write(path.join(test.directory, "test.txt"), "hello world"))
      const info = yield* GrepTool
      const grep = yield* info.init()
      const result = yield* grep.execute(
        {
          pattern: "xyznonexistentpatternxyz123",
          path: test.directory,
        },
        ctx,
      )
      expect(result.metadata.matches).toBe(0)
      expect(result.output).toBe("No files found")
    }),
  )

  // #244：搜索路径包含空格，覆盖参数数组传递到 rg 时不能依赖 shell 引号的边界；
  // include/exclude 同时存在时，exclude 必须继续收窄 include 已选中的候选文件
  it.instance("supports include and exclude filters together", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const search = path.join(test.directory, "space dir")
      yield* Effect.promise(() => fs.mkdir(search, { recursive: true }))
      yield* Effect.promise(() => Bun.write(path.join(search, "keep.ts"), "const value = 'needle'\n"))
      yield* Effect.promise(() => Bun.write(path.join(search, "keep.tsx"), "const value = 'needle'\n"))
      yield* Effect.promise(() => Bun.write(path.join(search, "skip.test.ts"), "const value = 'needle'\n"))
      yield* Effect.promise(() => fs.mkdir(path.join(search, "dist"), { recursive: true }))
      yield* Effect.promise(() => Bun.write(path.join(search, "dist", "skip.ts"), "const value = 'needle'\n"))

      const info = yield* GrepTool
      const grep = yield* info.init()
      const result = yield* grep.execute(
        {
          pattern: "needle",
          path: search,
          // #244：include/exclude 同传是本测试的核心场景，
          // 数组形态直接覆盖 legacy 单字符串入参的升级路径
          include: ["*.ts", "*.tsx"],
          exclude: ["*.test.ts", "dist/**"],
        },
        ctx,
      )

      // #244：四个候选文件各覆盖一条过滤分支；
      // #244：两个断言组分别验证 include 并集与 exclude 收窄——
      // skip.test.ts 命中 include 但被 exclude 剔除，dist 目录同理；
      // 路径参数含空格，验证参数数组传递不依赖 shell 引号
      expect(result.metadata.matches).toBe(2)
      expect(result.output).toContain(path.join(search, "keep.ts"))
      expect(result.output).toContain(path.join(search, "keep.tsx"))
      expect(result.output).not.toContain("skip.test.ts")
      expect(result.output).not.toContain("dist")
    }),
  )

  // #244：大量空文件会触发旧的候选文件硬上限；现在 grep 依赖时间预算，
  // 因此「小文件很多但搜索很快」的场景应返回真实匹配而不是 scope-too-broad
  it.instance(
    "searches more than the legacy candidate file limit when work is fast",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const search = path.join(test.directory, "many-small-files")
        yield* Effect.promise(() => fs.mkdir(search, { recursive: true }))
        yield* Effect.forEach(
          Array.from({ length: 5_001 }, (_, index) => path.join(search, `empty-${index}.txt`)),
          (file) => Effect.promise(() => Bun.write(file, "")),
          // #244：并发 64 模拟真实仓库的文件创建节奏，避免串行写入放大慢盘抖动
          { concurrency: 64, discard: true },
        )
        yield* Effect.promise(() => Bun.write(path.join(search, "match.txt"), "needle\n"))

        const info = yield* GrepTool
        const grep = yield* info.init()
        const result = yield* grep.execute(
          {
            pattern: "needle",
            path: search,
            include: "*.txt",
          },
          ctx,
        )

        // #244：单值 include 走 string 兼容分支，与数组共用同一展开逻辑；
        // #244：核心断言是「真匹配被返回」而非仅「不再报错」——
        // 防止未来把 maxFiles 预扫加回导致静默恢复硬拒绝；
        // include 单值形态同步验证 string 兼容分支；
        // 5001 个空文件全部命中 include glob，预扫若存在必然拒绝
        expect(result.metadata.matches).toBe(1)
        expect(result.output).toContain("match.txt")
        expect(result.output).not.toContain("Search scope is too broad")
      }),
    undefined,
    // #244：Windows 慢盘写入 5001 个空文件远超 bun 默认 5 秒预算，放宽墙钟上限
    60_000,
  )

  it.instance("reports timeout without claiming no files were found", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => Bun.write(path.join(test.directory, "match.txt"), "needle\n"))

      const info = yield* GrepTool.pipe(
        Effect.provide(
          // #244：Layer.mock 覆盖 toolLayer 里的真实 Ripgrep.node——内层 provide 优先，
          // 未触达的方法用 die 占位：测试若意外调用会立即暴露
          Layer.mock(Ripgrep.Service)({
            find: () => Effect.die("unused in timeout test"),
            glob: () => Effect.die("unused in timeout test"),
            grep: () => Effect.die("unused in timeout test"),
            // #244：mock 直接返回 timedOut——搜索层与工具层的超时语义在此解耦验证；
            // #244：timedOut-only 形态：items 为空时工具必须返回超时提示而非空结果
            search: () =>
              Effect.succeed({
                items: [],
                partial: false,
                truncated: false,
                timedOut: true,
              }),
          }),
        ),
      )
      const grep = yield* info.init()
      const result = yield* grep.execute(
        {
          pattern: "needle",
          path: test.directory,
          // #244：timeout:1 仅用于触发参数透传路径，实际结果由 mock 决定
          timeout: 1,
        },
        ctx,
      )

      // #244：空结果 + timedOut 必须走 emptyTimedOut 而不是 empty——
      // metadata.truncated 与输出文案是调用方区分两种空结果的唯一信号；
      // mock 注入免受真实磁盘速度影响，专注验证输出分支
      expect(result.metadata.matches).toBe(0)
      expect(result.metadata.truncated).toBe(true)
      expect(result.output).toContain("timed out")
      expect(result.output).not.toBe("No files found")
    }),
  )

  it.instance("keeps partial matches when search times out", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => Bun.write(path.join(test.directory, "match.txt"), "needle\n"))

      const info = yield* GrepTool.pipe(
        Effect.provide(
          Layer.mock(Ripgrep.Service)({
            find: () => Effect.die("unused in timeout test"),
            glob: () => Effect.die("unused in timeout test"),
            grep: () => Effect.die("unused in timeout test"),
            search: () =>
              Effect.succeed({
                items: [
                  // #244：真实 Match 实例（schema 构造）保证工具端 rows 映射与
                  // 真实执行路径同构，mock 只替换进程层不替换数据形状
                  Match.make({
                    entry: Entry.make({ path: RelativePath.make("match.txt"), type: "file" }),
                    line: 1,
                    offset: 0,
                    text: "needle",
                    submatches: [],
                  }),
                ],
                partial: false,
                truncated: false,
                timedOut: true,
              }),
          }),
        ),
      )
      const grep = yield* info.init()
      const result = yield* grep.execute(
        {
          pattern: "needle",
          path: test.directory,
          // #244：timeout:1 仅用于触发参数透传路径，实际结果由 mock 决定
          timeout: 1,
        },
        ctx,
      )

      // #244：部分匹配场景验证「受控截断不丢弃已解析结果」——
      // matches 计数与行内容都保留，仅追加截断与超时提示
      expect(result.metadata.matches).toBe(1)
      expect(result.metadata.truncated).toBe(true)
      expect(result.output).toContain("Line 1: needle")
      expect(result.output).toContain("timed out")
    }),
  )

  it.instance("finds matches in tmp instance", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() => Bun.write(path.join(test.directory, "test.txt"), "line1\nline2\nline3"))
      const info = yield* GrepTool
      const grep = yield* info.init()
      const result = yield* grep.execute(
        {
          pattern: "line",
          path: test.directory,
        },
        ctx,
      )
      expect(result.metadata.matches).toBeGreaterThan(0)
    }),
  )

  it.instance("does not report an unknown total when results are truncated", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* Effect.promise(() =>
        Promise.all(
          Array.from({ length: 101 }, (_, index) =>
            Bun.write(path.join(test.directory, `match-${index}.txt`), "needle"),
          ),
        ),
      )
      const info = yield* GrepTool
      const grep = yield* info.init()
      const result = yield* grep.execute({ pattern: "needle", path: test.directory, include: "*.txt" }, ctx)

      expect(result.output).toContain(
        "(Results truncated: showing first 64 matches. Consider using a more specific path or pattern.)",
      )
      expect(result.output).not.toMatch(/showing \d+ of \d+ matches/)
    }),
  )

  it.instance("supports exact file paths", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const file = path.join(test.directory, "test.txt")
      yield* Effect.promise(() => Bun.write(file, "line1\nline2\nline3"))
      yield* Effect.promise(() => Bun.write(path.join(test.directory, "other.txt"), "line2 sibling"))
      const ripgrep = yield* Ripgrep.Service
      // 内部grep仍保留候选上限；交互工具改用时间预算，单文件目标继续保持精确。
      const tooBroad = yield* ripgrep
        .grep({
          cwd: test.directory,
          pattern: "line2",
          include: "*.txt",
          limit: 65,
          maxFiles: 1,
        })
        .pipe(Effect.flip)
      expect(tooBroad).toMatchObject({ maxFiles: 1 })
      const info = yield* GrepTool
      const grep = yield* info.init()
      const broad = yield* grep.execute({ pattern: "line2", path: test.directory, include: "*.txt" }, ctx)
      expect(broad.metadata.matches).toBe(2)
      expect(broad.output).not.toContain("Search scope is too broad")
      const result = yield* grep.execute(
        {
          pattern: "line2",
          path: file,
        },
        ctx,
      )
      expect(result.metadata.matches).toBe(1)
      expect(result.metadata.truncated).toBe(false)
      expect(result.output).toContain(file)
      expect(result.output).toContain("Line 2: line2")
      expect(result.output).not.toContain("other.txt")
      expect(result.output).not.toContain("sibling")
    }),
  )

  it.instance("does not ask for external_directory when alias path is allowed", () =>
    Effect.gen(function* () {
      if (process.platform === "win32") return

      yield* TestInstance
      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "opencode-grep-alias-"))),
        (dir) => Effect.promise(() => fs.rm(dir, { recursive: true, force: true })),
      )
      const real = path.join(tmp, "real")
      const alias = path.join(tmp, "alias")
      yield* Effect.promise(() => fs.mkdir(real))
      yield* Effect.promise(() => fs.symlink(real, alias, "dir"))
      yield* Effect.promise(() => Bun.write(path.join(real, "test.txt"), "needle"))

      const ruleset = Permission.fromConfig({
        grep: "allow",
        external_directory: {
          [path.join(alias, "*")]: "allow",
        },
      })
      const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
      const next: Tool.Context = {
        ...ctx,
        ask: (req) =>
          Effect.sync(() => {
            const needsAsk = req.patterns.some(
              (pattern) => Permission.evaluate(req.permission, pattern, ruleset).action !== "allow",
            )
            if (needsAsk) requests.push(req)
          }),
      }

      const info = yield* GrepTool
      const grep = yield* info.init()
      const result = yield* grep.execute(
        {
          pattern: "needle",
          path: alias,
          include: "*.txt",
        },
        next,
      )

      expect(result.metadata.matches).toBe(1)
      expect(result.output).toContain(path.join(alias, "test.txt"))
      expect(result.output).not.toContain(path.join(real, "test.txt"))
      expect(requests.find((req) => req.permission === "external_directory")).toBeUndefined()
    }),
  )
  // #138：有界输出截断
  // #138：工具层 64 条上限
  it.instance("caps broad match output", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const content = Array.from({ length: 130 }, (_, index) => `needle ${index}`).join("\n")
      yield* Effect.promise(() => Bun.write(path.join(test.directory, "test.txt"), content))
      const info = yield* GrepTool
      const grep = yield* info.init()
      const result = yield* grep.execute(
        {
          pattern: "needle",
          path: test.directory,
        },
        ctx,
      )
      expect(result.metadata.matches).toBe(64)
      expect(result.metadata.truncated).toBe(true)
      // [local-smark] 截断文案改为显示截断前真实数量（rows.length=65）+ "+" 后缀
      expect(result.output).toContain("Found 65+")
      expect(result.output).toContain("Results truncated")
    }),
  )
})

// [local-smark] 源 0413 核心缺陷场景：rg exit 2（TCC/ACL/EACCES）→
// search 零匹配 + partial——工具必须显式携带 partial 标记，与确定性
// empty / emptyTimedOut 三态可区分，不能把部分路径不可访问当作全量阴性
it.instance("flags zero matches as partial when search reports inaccessible paths", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance

    const info = yield* GrepTool.pipe(
      Effect.provide(
        Layer.mock(Ripgrep.Service)({
          find: () => Effect.die("unused in partial test"),
          glob: () => Effect.die("unused in partial test"),
          grep: () => Effect.die("unused in partial test"),
          search: () =>
            Effect.succeed({
              items: [],
              partial: true,
              truncated: false,
              timedOut: false,
            }),
        }),
      ),
    )
    const grep = yield* info.init()
    const result = yield* grep.execute(
      {
        pattern: "needle",
        path: test.directory,
        timeout: 1,
      },
      ctx,
    )

    // partial 空结果的三态可区分：metadata.partial 是模型判断
    // 「结果可能不完整」的唯一信号；输出不得是确定性 "No files found"
    expect(result.metadata.matches).toBe(0)
    expect(result.metadata.truncated).toBe(false)
    expect((result.metadata as Record<string, unknown>).partial).toBe(true)
    expect(result.output).toContain("could not access some paths")
    expect(result.output).not.toBe("No files found")
  }),
)

// [local-smark] 有匹配 + partial：已解析结果保留的同时追加不可访问提示，
// 与源提交「部分路径不可访问不改变已解析结果可信度」的语义一致
it.instance("keeps matches and marks inaccessibility on non-empty partial results", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance

    const info = yield* GrepTool.pipe(
      Effect.provide(
        Layer.mock(Ripgrep.Service)({
          find: () => Effect.die("unused in partial test"),
          glob: () => Effect.die("unused in partial test"),
          grep: () => Effect.die("unused in partial test"),
          search: () =>
            Effect.succeed({
              items: [
                Match.make({
                  entry: Entry.make({ path: RelativePath.make("match.txt"), type: "file" }),
                  line: 1,
                  offset: 0,
                  text: "needle",
                  submatches: [],
                }),
              ],
              partial: true,
              truncated: false,
              timedOut: false,
            }),
        }),
      ),
    )
    const grep = yield* info.init()
    const result = yield* grep.execute(
      {
        pattern: "needle",
        path: test.directory,
        timeout: 1,
      },
      ctx,
    )

    expect(result.metadata.matches).toBe(1)
    expect(result.output).toContain("Line 1: needle")
    expect(result.output).toContain("inaccessible")
  }),
)

// [local-smark] 源 :3152-3168 契约：exit 2 竞态下 timedOut 与 partial 可并存——
// 四态 metadata（matches/truncated/timedOut/partial）都必须持久化，文案归因
// timeout 但 partial 独立记录路径跳过，模型据此同时获知预算与权限两种归因
it.instance("preserves partial metadata when an empty search also times out", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance

    const info = yield* GrepTool.pipe(
      Effect.provide(
        Layer.mock(Ripgrep.Service)({
          find: () => Effect.die("unused in partial test"),
          glob: () => Effect.die("unused in partial test"),
          grep: () => Effect.die("unused in partial test"),
          search: () =>
            Effect.succeed({
              items: [],
              partial: true,
              truncated: false,
              timedOut: true,
            }),
        }),
      ),
    )
    const grep = yield* info.init()
    const result = yield* grep.execute(
      {
        pattern: "needle",
        path: test.directory,
        timeout: 1,
      },
      ctx,
    )

    expect(result.metadata.matches).toBe(0)
    expect(result.metadata.truncated).toBe(true)
    expect((result.metadata as Record<string, unknown>).timedOut).toBe(true)
    expect((result.metadata as Record<string, unknown>).partial).toBe(true)
    expect(result.output).toContain("timed out")
  }),
)
