import { describe, expect } from "bun:test"
import { ConfigProvider, Effect, Layer, Schema } from "effect"
import { AppProcess } from "@opencode-ai/core/process"
import * as TestClock from "effect/testing/TestClock"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Location } from "@opencode-ai/core/location"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SystemContext } from "@opencode-ai/core/system-context"
import { SystemContextBuiltIns } from "@opencode-ai/core/system-context/builtins"
import { SystemContextRegistry } from "@opencode-ai/core/system-context/registry"
import { location } from "../fixture/location"
import { testEffect } from "../lib/effect"

const directory = AbsolutePath.make(FSUtil.resolve("/repo/packages/core"))
const projectDirectory = AbsolutePath.make(FSUtil.resolve("/repo"))
const instructionFile = FSUtil.resolve("/repo/AGENTS.md")
const timestamp = Date.parse("2026-06-03T12:00:00.000Z")
const localDate = (time: number) => new Date(time).toDateString()
const locationLayer = Layer.succeed(
  Location.Service,
  Location.Service.of(
    location(
      { directory },
      { projectDirectory, vcs: { type: "git", store: AbsolutePath.make(FSUtil.resolve("/repo/.git")) } },
    ),
  ),
)
const builtInsNode = LayerNode.group([SystemContextBuiltIns.node, SystemContextRegistry.node])
// 原有环境/日期断言使用禁用选项，禁止测试机的真实 Git 配置影响精确文本。
const disabled = ConfigProvider.layer(ConfigProvider.fromUnknown({ OPENCODE_DISABLE_GIT: true }))
// 禁用与非仓库短路必须根本不启动 Git，而不是启动后丢弃结果。
const noGit = Layer.mock(AppProcess.Service, { run: () => Effect.die("Git must not run") })
const it = testEffect(
  AppNodeBuilder.build(builtInsNode, [
    [Location.node, locationLayer],
    [Global.node, Global.layerWith({ config: "/global" })],
    [AppProcess.node, noGit],
  ]).pipe(Layer.provide(disabled)),
)
const instructionFS = Layer.effect(
  FSUtil.Service,
  FSUtil.Service.pipe(
    Effect.map((fs) =>
      FSUtil.Service.of({
        ...fs,
        up: () => Effect.succeed([instructionFile]),
        readFileStringSafe: (path) => Effect.succeed(path === instructionFile ? "Be precise." : undefined),
      }),
    ),
  ),
).pipe(Layer.provide(LayerNode.compile(FSUtil.node)))
const itWithInstructions = testEffect(
  AppNodeBuilder.build(builtInsNode, [
    [Location.node, locationLayer],
    [FSUtil.node, instructionFS],
    [Global.node, Global.layerWith({ config: "/global" })],
    [AppProcess.node, noGit],
  ]).pipe(Layer.provide(disabled)),
)

// 仅替换进程边界；文本、Source codec 和 registry 均执行真实实现。
const gitProcess = Layer.unwrap(Effect.sync(() => {
  let observations = 0
  return Layer.mock(AppProcess.Service, { run: (command) => Effect.sync(() => {
    // 复合 shell 命令会掩盖 Location 绑定，测试只接受显式 Git argv。
    if (command._tag !== "StandardCommand") throw new Error("Expected Git argv")
    expect(command.command).toBe("git")
    expect(command.options.cwd).toBe(directory)
    const text = command.args.includes("status") ? ` M file with spaces-${++observations}\0${"?? long-file\0".repeat(200)}`
      : command.args.includes("log") ? "abc123 root commit\n"
      : command.args.includes("user.name") ? "Test User\n"
      : command.args.includes("remote") ? "origin\n"
      : command.args.includes("refs/remotes/origin/HEAD") ? "refs/remotes/origin/dev\n"
      : "topic\n"
    return { command: "git", exitCode: 0, stdout: Buffer.from(text), stderr: Buffer.alloc(0), stdoutTruncated: false, stderrTruncated: false }
  }) })
}))
const gitIt = testEffect(AppNodeBuilder.build(builtInsNode, [
  [Location.node, locationLayer], [AppProcess.node, gitProcess],
  [Global.node, Global.layerWith({ config: "/global" })],
]).pipe(Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ OPENCODE_DISABLE_GIT: false })))))
const plainIt = testEffect(AppNodeBuilder.build(builtInsNode, [
  // 非仓库由 Location 决定，不能通过探测测试机父目录偷偷变成 Git 仓库。
  [Location.node, Layer.succeed(Location.Service, location({ directory }))],
  [AppProcess.node, noGit], [Global.node, Global.layerWith({ config: "/global" })],
]).pipe(Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ OPENCODE_DISABLE_GIT: false })))))

gitIt.effect("retains the Location Git snapshot through refresh and replacement", () => Effect.gen(function* () {
  yield* TestClock.setTime(timestamp)
  const registry = yield* SystemContextRegistry.Service
  const first = yield* SystemContext.initialize(yield* registry.load())
  // 完整字段必须到达 registry 的 baseline，不能只测试孤立的 formatter。
  expect(first.baseline).toContain("Current branch: topic")
  expect(first.baseline).toContain("Main branch (you will usually use this for PRs): dev")
  expect(first.baseline).toContain("Git user: Test User")
  // 工作树列前导空格和含空格文件名必须同时保留。
  expect(first.baseline).toContain(" M file with spaces-1")
  expect(first.baseline).toContain("Recent commits:\n  abc123 root commit")
  // 超限状态必须有显式提示，不能静默伪装成完整状态。
  expect(first.baseline).toContain("truncated because it exceeds 2k characters")
  const second = yield* SystemContext.initialize(yield* registry.load())
  // 同目录重复初始化沿用源补丁的缓存，不增加跨会话身份管理。
  expect(second.baseline).toBe(first.baseline)
  // JSON 往返模拟 epoch 的持久化，避免测试依赖某个内存对象引用。
  const persisted = Schema.decodeUnknownSync(SystemContext.Snapshot)(JSON.parse(JSON.stringify(first.snapshot)))
  expect(yield* SystemContext.reconcile(yield* registry.load(), persisted)).toEqual({ _tag: "Unchanged" })
  // Context replacement 复用同一采样，不改变其余 Source 的上游重载规则。
  expect(yield* SystemContext.replace(yield* registry.load(), persisted)).toMatchObject({
    _tag: "ReplacementReady", generation: { baseline: first.baseline },
  })
  const third = yield* SystemContext.initialize(yield* registry.load())
  // 重复观察不启动新的 Git 采样，其他动态上下文仍由各自 Source 管理。
  expect(third.baseline).toBe(first.baseline)
}))
plainIt.effect("keeps non-repository context without invoking Git", () => Effect.gen(function* () {
  const registry = yield* SystemContextRegistry.Service
  const first = yield* SystemContext.initialize(yield* registry.load())
  expect(first.baseline).toContain("Is directory a git repo: no")
  expect(first.snapshot["core/git"]).toBeUndefined()
}))
it.effect("disabled Git retains repository identity without private fields", () => Effect.gen(function* () {
  const registry = yield* SystemContextRegistry.Service
  const first = yield* SystemContext.initialize(yield* registry.load())
  expect(first.baseline).toContain("Is directory a git repo: yes")
  // 关闭开关不能仅隐去状态，却继续暴露用户名、分支或提交。
  expect(first.baseline).not.toContain("Current branch:")
  expect(first.baseline).not.toContain("Git user:")
  expect(first.baseline).not.toContain("Recent commits:")
}))
// 非零退出与启动失败属于不同进程边界，都必须保留源补丁的非阻断退化。
for (const failure of [
  { name: "nonzero exit", result: Effect.succeed({ command: "git", exitCode: 1, stdout: Buffer.from("invalid stdout"), stderr: Buffer.from("fatal"), stdoutTruncated: false, stderrTruncated: false }) },
  { name: "spawn failure", result: Effect.fail(new AppProcess.AppProcessError({ command: "git", stderr: "missing executable" })) },
]) {
  testEffect(AppNodeBuilder.build(builtInsNode, [
    [Location.node, locationLayer], [AppProcess.node, Layer.mock(AppProcess.Service, { run: () => failure.result })],
    [Global.node, Global.layerWith({ config: "/global" })],
  ]).pipe(Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ OPENCODE_DISABLE_GIT: false }))))).effect(`keeps Git context on ${failure.name}`, () => Effect.gen(function* () {
    const registry = yield* SystemContextRegistry.Service
    const baseline = (yield* SystemContext.initialize(yield* registry.load())).baseline
    // 命令失败不改变 Location 的仓库归属，错误输出也不能被当成有效字段。
    expect(baseline).toContain("Is directory a git repo: yes")
    expect(baseline).not.toContain("invalid stdout")
    expect(baseline).not.toContain("Git user:")
    // detached、未知默认分支和无提交分别保留各自标记，不能合成一个含糊的错误段。
    expect(baseline).toContain("Current branch: (detached)")
    expect(baseline).toContain("Main branch (you will usually use this for PRs): unknown")
    expect(baseline).toContain("Status:\n  (clean)")
    expect(baseline).toContain("Recent commits:\n  (no commits)")
  }))
}

describe("SystemContextBuiltIns", () => {
  it.effect("loads location-scoped environment and host-local date context", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(timestamp)
      const context = yield* SystemContextRegistry.Service
      const initialized = yield* SystemContext.initialize(yield* context.load())

      expect(initialized.baseline).toBe(
        [
          "Here is some useful information about the environment you are running in:",
          "<env>",
          `  Working directory: ${directory}`,
          `  Workspace root folder: ${projectDirectory}`,
          "  Is directory a git repo: yes",
          `  Platform: ${process.platform}`,
          "</env>",
          "",
          `Today's date: ${localDate(timestamp)}`,
        ].join("\n"),
      )
    }),
  )

  it.effect("reconciles the date without repeating unchanged environment context", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(timestamp)
      const context = yield* SystemContextRegistry.Service
      const initialized = yield* SystemContext.initialize(yield* context.load())

      yield* TestClock.setTime(timestamp + 24 * 60 * 60 * 1000)
      const refreshed = yield* SystemContext.reconcile(yield* context.load(), initialized.snapshot)

      expect(refreshed).toMatchObject({
        _tag: "Updated",
        text: `Today's date is now: ${localDate(timestamp + 24 * 60 * 60 * 1000)}`,
      })
    }),
  )

  it.effect("does not update again within the same local calendar day", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(timestamp)
      const context = yield* SystemContextRegistry.Service
      const initialized = yield* SystemContext.initialize(yield* context.load())

      yield* TestClock.setTime(timestamp + 60 * 60 * 1000)
      expect(yield* SystemContext.reconcile(yield* context.load(), initialized.snapshot)).toEqual({ _tag: "Unchanged" })
    }),
  )

  itWithInstructions.effect("composes ambient instructions after built-in context", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(timestamp)
      const context = yield* SystemContextRegistry.Service

      expect((yield* SystemContext.initialize(yield* context.load())).baseline).toBe(
        [
          "Here is some useful information about the environment you are running in:",
          "<env>",
          `  Working directory: ${directory}`,
          `  Workspace root folder: ${projectDirectory}`,
          "  Is directory a git repo: yes",
          `  Platform: ${process.platform}`,
          "</env>",
          "",
          `Today's date: ${localDate(timestamp)}`,
          "",
          `Instructions from: ${instructionFile}\nBe precise.`,
        ].join("\n"),
      )
    }),
  )
})
