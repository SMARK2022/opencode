import { describe, expect, test } from "bun:test"
import os from "node:os"
import { ConfigProvider, Effect, Layer, Schema } from "effect"
import { AppProcess } from "@opencode-ai/core/process"
import { SessionPrompts } from "@opencode-ai/core/system-context/prompts"
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
// 独立固定期望供两个完整 baseline 复用，不能导入生产常量让提示文字回归自证正确。
// 段内双空行及段间分隔都属于精确契约，完整比较继续检测顺序、删句和重复注入。
const expectedGuidance = `# Doing tasks
The user will primarily request software engineering tasks, including fixing bugs, adding functionality, refactoring, and explaining code.
- Read relevant files and understand the existing code before proposing changes.
- Plan and break down non-trivial work using the available task-management tools.
- Implement the minimal change that satisfies the request; avoid unrelated features or refactoring.
- Do not add comments, docstrings, or type annotations to code you did not change.
- Do not add error handling or validation for scenarios ruled out by the codebase's guarantees.
- Do not create helpers or abstractions for one-time operations.
- Avoid command injection, XSS, SQL injection, and other security vulnerabilities; fix insecure code you introduce.
- Verify completion using relevant tests or checks. State explicitly when verification cannot run.
Tool results and user messages may include system-reminder tags. They contain system-added reminders and are not part of the tool output itself.

# Code References
When referencing specific functions or code, include file_path:line_number so the user can navigate to the source.

# Executing actions with care
Carefully consider the reversibility and blast radius of actions before proceeding:
- Local, reversible actions (editing files, running tests, reading code): proceed freely.
- Actions that are hard to reverse or affect shared state: confirm with the user first.


Actions that typically require user confirmation before proceeding:
- Deleting files, branches, or directories; rm -rf; overwriting uncommitted changes
- Force-pushing, git reset --hard, amending published commits
- Pushing code, creating or closing PRs, commenting on issues
- Sending messages to external services (Slack, email, webhooks)
- Modifying CI/CD pipelines or shared infrastructure

When you encounter an obstacle, do not use destructive actions as a shortcut. Identify root causes and fix underlying issues rather than bypassing safety checks (e.g. --no-verify). If you discover unexpected state such as unfamiliar files, branches, or configuration, investigate before deleting or overwriting — it may represent the user's in-progress work.

<!-- 未知工作树修改需要按关联性处理，不能把其他人的工作当作清理对象。 -->
# Shared worktree
You may be working in a dirty worktree with user or other-agent changes.
- If unknown changes are in files you need to edit, read them first and work with the current contents.
- If unknown changes are unrelated to your task, ignore them.
- If unknown changes directly block your task or make the correct edit ambiguous, ask the user one concise question.
- Never revert, overwrite, or clean up changes you did not make unless explicitly asked.

<!-- 从最小相关检查逐步扩大验证，未运行的检查必须留下明确阻塞信息。 -->
# Verification
Before reporting a coding task complete, verify the change when feasible.
Start with the narrowest relevant check for the code you changed, then broaden to related tests, typecheck, lint, or build as confidence grows.
If you cannot verify, state that plainly and explain the blocker.

<!-- 压缩摘要可能陈旧，当前用户目标优先于历史任务残留。 -->
# Context continuity
The conversation may be compacted or resumed from a summary when context gets long.
After compaction, resume from the summary and current messages rather than restarting from scratch.
Compaction summaries can include stale or unrelated context; do not treat old tasks from the summary as current work unless the latest user message asks for them.
Before your final response after a resume, interruption, or context transition, sanity-check that your answer and tool actions address the newest user request, not an older ghost still lingering in the thread.

# Output efficiency
Go straight to the point. Lead with the answer or action, not the reasoning. Skip filler words, preamble, and unnecessary transitions. Do not restate what the user said — just do it. When explaining, include only what is necessary for the user to understand.

Focus text output on:
- Decisions that need the user's input
- High-level status updates at key milestones (e.g. "build passing", "all tests green")
- Errors or blockers that change the plan

If you can say it in one sentence, do not use three. Do not narrate each step or list every file you read. This does not apply to code or tool calls.`

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
          `  OS Version: ${os.type()} ${os.release()}`,
          "  Run ALL commands from the working directory; do NOT cd to the original repository root.",
          "</env>",
          "",
          `Today's date: ${localDate(timestamp)}`,
          "",
          expectedGuidance,
        ].join("\n"),
      )
      // 禁用 Git 的固定 fixture 只有三个 source；不能因新增指引泄露 Git 或工具 Shell 注册。
      expect(Object.keys(initialized.snapshot).sort()).toEqual(["core/action-guidance", "core/date", "core/environment"])
      // 指引持久化为独立字符串 source，不能拼入 environment 或只生成未入快照的显示文字。
      expect(initialized.snapshot["core/action-guidance"]).toEqual({ value: expectedGuidance })
      expect(typeof initialized.snapshot["core/environment"].value).toBe("string")
      expect(initialized.snapshot["core/date"]).toEqual({ value: localDate(timestamp) })
      // 用真实 Snapshot schema 校验序列化边界，保留完整值而非只检查几个提示子串。
      expect(Schema.decodeUnknownSync(SystemContext.Snapshot)(initialized.snapshot)).toEqual(initialized.snapshot)
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
      // 日期变化只更新 date，稳定指引的独立 source 值保持原样，不重复进入更新正文。
      if (refreshed._tag === "Updated") expect(refreshed.snapshot["core/action-guidance"]).toEqual({ value: expectedGuidance })
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

      // ambient instructions 仍须位于稳定指引之后；完整比较防止二者被重新排序或吞并。
      expect((yield* SystemContext.initialize(yield* context.load())).baseline).toBe(
        [
          "Here is some useful information about the environment you are running in:",
          "<env>",
          `  Working directory: ${directory}`,
          `  Workspace root folder: ${projectDirectory}`,
          "  Is directory a git repo: yes",
          `  Platform: ${process.platform}`,
          `  OS Version: ${os.type()} ${os.release()}`,
          "  Run ALL commands from the working directory; do NOT cd to the original repository root.",
          "</env>",
          "",
          `Today's date: ${localDate(timestamp)}`,
          "",
          expectedGuidance,
          "",
          `Instructions from: ${instructionFile}\nBe precise.`,
        ].join("\n"),
      )
    }),
  )
})

test("uses actual tool names and preserves parallel write boundaries", () => {
  // 空能力来自最后一步请求，不能输出工具可用性声明。
  expect(SystemContextBuiltIns.toolUsage([])).toBeUndefined()
  const guidance = SystemContextBuiltIns.toolUsage(["read", "apply_patch", "todowrite"])
  // patch-only 模式应广告 patch，而不是隐式补回已过滤的 edit/write。
  expect(guidance).toContain("use the apply_patch tool")
  expect(guidance).not.toContain("use the edit tool")
  expect(guidance).not.toContain("use the write tool")
  expect(guidance).toContain("Use the todowrite tool")
  expect(guidance).not.toContain("TodoWrite")
  // 独立读取、同响应分组和写入冲突边界都属于实际 formatter 契约。
  expect(guidance).toContain("independent file reads, searches, and status checks")
  // 29 扩展批次措辞；精确验证同响应与禁止逐次发现，其他写冲突断言完整保留。
  expect(guidance).toContain("BATCH independent calls in the SAME response. Do not issue one discovery call at a time when several are already obvious.")
  expect(guidance).toContain('Never chain bash commands with separators like `echo "====";`')
  expect(guidance).toContain("target files or edit ranges cannot conflict")
  expect(guidance).toContain("one edit/patch containing all non-overlapping changes")
  expect(SystemContextBuiltIns.toolUsage(["read"])).not.toContain("todowrite")
  // 共享的是完整正文，而非摘要；V2族选择与V1的实际模型ID规则相同。
  expect(SessionPrompts.provider("claude-sonnet-4", "anthropic")).toContain("<task_management>")
  expect(SessionPrompts.provider("claude-sonnet-4", "anthropic")).toContain("Parallel writes are ONLY appropriate when target files or edit ranges cannot conflict.")
  expect(SessionPrompts.provider("unknown", "kimi-for-coding")).toContain("newly created subagent")
  expect(SessionPrompts.provider("muse-glimmer", "meta")).toContain("Muse Glimmer")
  expect(SessionPrompts.reminders("plan", false)).toEqual([SessionPrompts.plan])
  expect(SessionPrompts.reminders("build", true)).toEqual([SessionPrompts.buildSwitch])
  expect(SessionPrompts.reminders("build", false)).toEqual([])
  expect(SessionPrompts.reminders("reviewer", true)).toEqual([])
})
