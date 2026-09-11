import { describe, expect, test } from "bun:test"
import { Duration, Effect, Layer } from "effect"
import * as TestClock from "effect/testing/TestClock"
import type { Agent } from "../../src/agent/agent"
import type { Provider } from "../../src/provider/provider"
import { NamedError } from "@opencode-ai/core/util/error"
import { Skill } from "../../src/skill"
import { Permission } from "../../src/permission"
import { SystemPrompt } from "../../src/session/system"
import { Git } from "../../src/git"
import { ToolRegistry } from "../../src/tool/registry"
import { it as baseIt, testEffect } from "../lib/effect"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Database } from "../../src/storage/db"
import { ProjectTable } from "../../src/project/project.sql"
import { SessionTable } from "../../src/session/session.sql"
import { ProjectID } from "../../src/project/schema"
import { MessageID, SessionID } from "../../src/session/schema"
import { InstanceRef } from "../../src/effect/instance-ref"
import { SessionContextEpoch } from "../../src/session/context-epoch"
import type { InstanceContext } from "../../src/project/instance-context"
import PROMPT_ASTRA from "../../src/session/prompt/gpt-astra.txt"
import PROMPT_GPT from "../../src/session/prompt/gpt.txt"
import PROMPT_CODEX from "../../src/session/prompt/codex.txt"
import PROMPT_BEAST from "../../src/session/prompt/beast.txt"
import PROMPT_ANTHROPIC from "../../src/session/prompt/anthropic.txt"

const skills: Skill.Info[] = [
  {
    name: "zeta-skill",
    description: "Zeta skill.",
    location: "/tmp/zeta-skill/SKILL.md",
    content: "# zeta-skill",
  },
  {
    name: "alpha-skill",
    description: "Alpha skill.",
    location: "/tmp/alpha-skill/SKILL.md",
    content: "# alpha-skill",
  },
  {
    name: "middle-skill",
    description: "Middle skill.",
    location: "/tmp/middle-skill/SKILL.md",
    content: "# middle-skill",
  },
  {
    name: "manual-skill",
    location: "/tmp/manual-skill/SKILL.md",
    content: "# manual-skill",
  },
]

const build: Agent.Info = {
  name: "build",
  mode: "primary",
  permission: Permission.fromConfig({ "*": "allow" }),
  options: {},
}

const it = testEffect(
  SystemPrompt.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(
          Skill.Service,
          Skill.Service.of({
            get: (name) => Effect.succeed(skills.find((skill) => skill.name === name)),
            all: () => Effect.succeed(skills),
            dirs: () => Effect.succeed([]),
            available: () => Effect.succeed(skills),
          }),
        ),
        Layer.succeed(
          Git.Service,
          Git.Service.of({
            run: () => Effect.die("unused"),
            branch: () => Effect.die("unused"),
            prefix: () => Effect.die("unused"),
            defaultBranch: () => Effect.die("unused"),
            hasHead: () => Effect.die("unused"),
            mergeBase: () => Effect.die("unused"),
            show: () => Effect.die("unused"),
            status: () => Effect.die("unused"),
            diff: () => Effect.die("unused"),
            stats: () => Effect.die("unused"),
            patch: () => Effect.die("unused"),
            patchAll: () => Effect.die("unused"),
            patchUntracked: () => Effect.die("unused"),
            statUntracked: () => Effect.die("unused"),
            applyPatch: () => Effect.die("unused"),
          }),
        ),
        Layer.succeed(
          ToolRegistry.Service,
          ToolRegistry.Service.of({
            ids: () => Effect.succeed([]),
            all: () => Effect.succeed([]),
            named: () => Effect.die("unused"),
            tools: () => Effect.succeed([]),
          }),
        ),
      ),
    ),
  ),
)

// ===== session context epoch 行为测试 =====
// Git/日期快照归属 Session 并持久化到数据库；重建服务层（等价于进程重启丢内存）后必须逐字复用。

// model fixture 的 api.id 会被渲染进前缀首行；固定它才能让跨调用断言聚焦在 Git/日期维度。
const contextModel: Provider.Model = {
  id: ModelID.make("display-alias"),
  providerID: ProviderID.make("test"),
  api: { id: "gpt-6-astra", url: "https://example.com", npm: "@ai-sdk/openai" },
  name: "Display alias",
  capabilities: {
    temperature: true,
    reasoning: false,
    attachment: false,
    toolcall: true,
    input: { text: true, audio: false, image: false, video: false, pdf: false },
    output: { text: true, audio: false, image: false, video: false, pdf: false },
    interleaved: false,
  },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  limit: { context: 0, input: 0, output: 0 },
  status: "active",
  options: {},
  headers: {},
  release_date: "2026-09-11",
}

// git run 同时承担 user.name 与 log 两个采集点；按参数区分返回值，避免断言被串扰。
// status 的 code 字段使用 git porcelain 短格式（" M" 前缀），与生产采集的真实输出同构。
const contextGit = (file: () => string): Git.Interface =>
  Git.Service.of({
    run: (args) =>
      Effect.succeed({
        exitCode: 0,
        text: () => (args[0] === "config" ? "Test User" : "abc1234 root commit"),
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
        truncated: false,
      }),
    branch: () => Effect.succeed("dev"),
    prefix: () => Effect.die("unused"),
    defaultBranch: () => Effect.succeed({ name: "dev", ref: "refs/heads/dev" }),
    hasHead: () => Effect.die("unused"),
    mergeBase: () => Effect.die("unused"),
    show: () => Effect.die("unused"),
    status: () => Effect.succeed([{ code: " M", file: file(), status: "modified" as const }]),
    diff: () => Effect.die("unused"),
    stats: () => Effect.die("unused"),
    patch: () => Effect.die("unused"),
    patchAll: () => Effect.die("unused"),
    patchUntracked: () => Effect.die("unused"),
    statUntracked: () => Effect.die("unused"),
    applyPatch: () => Effect.die("unused"),
  })

const contextLayer = (git: Git.Interface) =>
  SystemPrompt.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(
          Skill.Service,
          Skill.Service.of({
            get: () => Effect.succeed(undefined),
            all: () => Effect.succeed([]),
            dirs: () => Effect.succeed([]),
            available: () => Effect.succeed([]),
          }),
        ),
        Layer.succeed(Git.Service, git),
        Layer.succeed(
          ToolRegistry.Service,
          ToolRegistry.Service.of({
            ids: () => Effect.succeed([]),
            all: () => Effect.succeed([]),
            named: () => Effect.die("unused"),
            tools: () => Effect.succeed([]),
          }),
        ),
      ),
    ),
  )

const contextInstance = (directory: string): InstanceContext => ({
  directory,
  worktree: directory,
  project: {
    id: ProjectID.make("project-context-epoch"),
    worktree: directory,
    vcs: "git",
    time: { created: 0, updated: 0 },
    sandboxes: [],
  },
})

// 测试只读数据库已有行；Session/Project 行通过持久层公开表结构布置，不触碰私有实现。
// Project 行可幂等复用；Session 行按用例唯一 ID 插入，互不干扰。
const seedContextSession = (sessionID: SessionID, directory: string) =>
  Database.use((db) => {
    db.insert(ProjectTable)
      .values({ id: ProjectID.make("project-context-epoch"), worktree: directory, vcs: "git", sandboxes: [] })
      .onConflictDoNothing()
      .run()
    db.insert(SessionTable)
      .values({
        id: sessionID,
        project_id: ProjectID.make("project-context-epoch"),
        slug: `context-epoch-${sessionID}`,
        directory,
        title: "context epoch",
        version: "test",
      })
      .run()
  })

// boundary "null" 逐字对应 promptWindowProof 在无 compaction 时的输出；msg_seed 充当首轮锚点。
const contextHistory = { boundary: "null", messageIDs: [MessageID.make("msg_seed")] }

const renderEnvironment = (
  git: Git.Interface,
  sessionID: SessionID,
  directory: string,
  history: { boundary: string; messageIDs: MessageID[] } = contextHistory,
) =>
  Effect.gen(function* () {
    const prompt = yield* SystemPrompt.Service
    return yield* prompt.environment({ sessionID, model: contextModel, registeredTools: [], history })
  }).pipe(Effect.provide(contextLayer(git)), Effect.provideService(InstanceRef, contextInstance(directory)))

describe("session.system", () => {
  // 使用实际 API id 验证分流；展示别名不能决定模板，GPT-6 的优先级高于 Codex。
  test.each([
    ["gpt-6-astra", PROMPT_ASTRA],
    ["gpt-6", PROMPT_ASTRA],
    ["gpt-6-codex", PROMPT_ASTRA],
    ["gpt-5.6-luna", PROMPT_GPT],
    ["gpt-5.4-codex", PROMPT_CODEX],
    ["gpt-4.1", PROMPT_BEAST],
    ["claude-sonnet-4", PROMPT_ANTHROPIC],
  ])("selects the provider prompt for %s", (id, expected) => {
    expect(SystemPrompt.provider({
      id: ModelID.make("display-alias"),
      providerID: ProviderID.make("test"),
      api: { id, url: "https://example.com", npm: "@ai-sdk/openai" },
      name: "Display alias",
      capabilities: {
        temperature: true,
        reasoning: false,
        attachment: false,
        toolcall: true,
        input: { text: true, audio: false, image: false, video: false, pdf: false },
        output: { text: true, audio: false, image: false, video: false, pdf: false },
        interleaved: false,
      },
      cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
      limit: { context: 0, input: 0, output: 0 },
      status: "active",
      options: {},
      headers: {},
      release_date: "2026-09-11",
    })).toEqual([expected])
  })

  it.effect("skills output is sorted by name and stable across calls", () =>
    Effect.gen(function* () {
      const prompt = yield* SystemPrompt.Service
      const first = yield* prompt.skills(build)
      const second = yield* prompt.skills(build)
      const output = first ?? (yield* Effect.fail(new NamedError.Unknown({ message: "missing skills output" })))

      expect(first).toBe(second)

      const alpha = output.indexOf("<name>alpha-skill</name>")
      const middle = output.indexOf("<name>middle-skill</name>")
      const zeta = output.indexOf("<name>zeta-skill</name>")

      expect(alpha).toBeGreaterThan(-1)
      expect(middle).toBeGreaterThan(alpha)
      expect(zeta).toBeGreaterThan(middle)
      expect(output).not.toContain("manual-skill")
    }),
  )

  // 这些用例自行提供 SystemPrompt 层；外层共享 it 的同名服务会覆盖内层，必须改用无外层层的 baseIt。
  baseIt.effect("session context: git snapshot persists per session across service reloads", () =>
    Effect.gen(function* () {
      // directory 是虚构绝对路径：InstanceContext 只被渲染进提示词文本，任何代码都不触碰磁盘。
      const directory = "F:/tmp/opencode-context-epoch-t1"
      const sessionID = SessionID.make("session-context-epoch-t1")
      seedContextSession(sessionID, directory)
      let file = "before.ts"
      const first = yield* renderEnvironment(contextGit(() => file), sessionID, directory)
      file = "after.ts"
      // 重建整层模拟进程重启后内存全部丢失；结果必须仍逐字来自数据库快照。
      const second = yield* renderEnvironment(contextGit(() => file), sessionID, directory)
      // 逐字相等锁定前缀稳定性：任何重新采集都会在 status 文件名单上露出差异。
      expect(second.system).toEqual(first.system)
      expect(second.system.join("\n")).toContain("before.ts")
      expect(second.system.join("\n")).not.toContain("after.ts")
    }),
  )

  baseIt.effect("session context: a new session in the same directory collects its own git snapshot", () =>
    Effect.gen(function* () {
      const directory = "F:/tmp/opencode-context-epoch-t2"
      // 两个 Session 共用同一目录是原 bug 的触发形态（缓存曾按 cwd 共享）。
      const firstID = SessionID.make("session-context-epoch-t2a")
      const secondID = SessionID.make("session-context-epoch-t2b")
      seedContextSession(firstID, directory)
      seedContextSession(secondID, directory)
      const first = yield* renderEnvironment(contextGit(() => "before.ts"), firstID, directory)
      const second = yield* renderEnvironment(contextGit(() => "after.ts"), secondID, directory)
      // 同目录两个 Session 的快照互不继承；旧 Session 后续读取也不被新 Session 污染。
      expect(first.system.join("\n")).toContain("before.ts")
      expect(second.system.join("\n")).toContain("after.ts")
      // 反向再读旧 Session：锁定 cwd 共享缓存被彻底移除后的双向隔离。
      const again = yield* renderEnvironment(contextGit(() => "later.ts"), firstID, directory)
      expect(again.system).toEqual(first.system)
    }),
  )

  baseIt.effect("session context: a date change appends one persisted update without rewriting the baseline", () =>
    Effect.gen(function* () {
      const directory = "F:/tmp/opencode-context-epoch-t3"
      const sessionID = SessionID.make("session-context-epoch-t3")
      seedContextSession(sessionID, directory)
      const git = contextGit(() => "before.ts")
      const first = yield* renderEnvironment(git, sessionID, directory)
      expect(first.updates).toEqual([])
      // 25 小时保证任何本地时区都跨过一个午夜，避免测试依赖运行机器的日期。
      // 用 TestClock 而不是替换全局 Date：共享进程内改全局构造函数会污染并行用例。
      yield* TestClock.adjust(Duration.hours(25))
      const second = yield* renderEnvironment(git, sessionID, directory)
      // 初始日期文本留在 baseline 前缀；新日期只通过追加更新进入历史。
      expect(second.system).toEqual(first.system)
      expect(second.updates.length).toBe(1)
      // 更新措辞逐字沿用上游 core/date 的 "is now" 文本，迁移到 v2 schema 时不需要改写历史。
      expect(second.updates[0]?.message.text).toContain("Today's date is now:")
      // 同日重复 prepare 是纯读路径：更新记录逐字相等，不产生第二条记录。
      const third = yield* renderEnvironment(git, sessionID, directory)
      expect(third.updates).toEqual(second.updates)
      // 重建服务层后更新记录仍从数据库回放，且不重复追加。
      const reloaded = yield* renderEnvironment(git, sessionID, directory)
      expect(reloaded.updates).toEqual(second.updates)
      expect(reloaded.system).toEqual(first.system)
    }),
  )

  baseIt.effect("session context: a hidden update anchor rebuilds the date generation and keeps the git snapshot", () =>
    Effect.gen(function* () {
      const directory = "F:/tmp/opencode-context-epoch-t4a"
      const sessionID = SessionID.make("session-context-epoch-t4a")
      seedContextSession(sessionID, directory)
      const git = contextGit(() => "before.ts")
      const day1 = yield* renderEnvironment(git, sessionID, directory)
      yield* TestClock.adjust(Duration.hours(25))
      const day2 = yield* renderEnvironment(git, sessionID, directory)
      expect(day2.updates.length).toBe(1)
      // 锚点 msg_seed 被 undo cleanup 隐藏后退出可见窗口：日期代际重建为当前日期，旧更新退休。
      // undo 不改变 boundary（没有发生 compaction），只让锚点退出可见集合，两条失效路径由此区分开。
      const rebuilt = yield* renderEnvironment(git, sessionID, directory, {
        boundary: "null",
        messageIDs: [MessageID.make("msg_other")],
      })
      expect(rebuilt.updates).toEqual([])
      // 新代 baseline 的日期是今天，与 day1 前缀不同；Git 文本则逐字保留。
      expect(rebuilt.system).not.toEqual(day1.system)
      expect(rebuilt.system.join("\n")).toContain("before.ts")
    }),
  )

  baseIt.effect("session context: a compaction boundary change rebuilds the date generation and keeps the git snapshot", () =>
    Effect.gen(function* () {
      const directory = "F:/tmp/opencode-context-epoch-t4b"
      const sessionID = SessionID.make("session-context-epoch-t4b")
      seedContextSession(sessionID, directory)
      const git = contextGit(() => "before.ts")
      const day1 = yield* renderEnvironment(git, sessionID, directory)
      yield* TestClock.adjust(Duration.hours(25))
      const day2 = yield* renderEnvironment(git, sessionID, directory)
      expect(day2.updates.length).toBe(1)
      // 完成的 compaction 改变窗口 boundary：日期代际随之重建，Git 快照跨代保留。
      // boundary 的具体 JSON 内容对代际判定是透明的；任何变化都触发重建，不需模拟真实 marker。
      const compacted = yield* renderEnvironment(git, sessionID, directory, {
        boundary: JSON.stringify({ markerID: "msg_marker", summaryID: "msg_summary" }),
        messageIDs: [MessageID.make("msg_tail")],
      })
      // 压缩前的日期更新属于旧窗口，重建后不再回放，避免把已压缩历史的日期注回新窗口。
      expect(compacted.updates).toEqual([])
      expect(compacted.system).not.toEqual(day1.system)
      expect(compacted.system.join("\n")).toContain("before.ts")
    }),
  )

  // 投影是纯函数：decide 裁掉锚点消息时，更新移到第一个仍保留的后继之前；后继不存在则位于末尾。
  test("session context: update projection moves a trimmed anchor before the first retained successor", () => {
    const update: SessionContextEpoch.Update = {
      after_message_id: MessageID.make("msg_a"),
      message: { id: MessageID.make("msg_update"), type: "system", time: { created: 1 }, text: "Today's date is now: X" },
    }
    const successor = SessionContextEpoch.projectUpdates({
      updates: [update],
      canonicalIDs: [MessageID.make("msg_a"), MessageID.make("msg_b"), MessageID.make("msg_c")],
      retainedIDs: new Set([MessageID.make("msg_c")]),
    })
    // 锚点被裁掉时锁定 before-后继语义：更新在 msg_c 之前，仍保持时间顺序早于当前 turn。
    expect(successor).toEqual([{ placement: { type: "before", id: MessageID.make("msg_c") }, text: "Today's date is now: X" }])
    const retained = SessionContextEpoch.projectUpdates({
      updates: [update],
      canonicalIDs: [MessageID.make("msg_a"), MessageID.make("msg_b")],
      retainedIDs: new Set([MessageID.make("msg_a")]),
    })
    // 锚点保留时锁定 after 语义：更新紧跟锚点消息的完整转换块。
    expect(retained).toEqual([{ placement: { type: "after", id: MessageID.make("msg_a") }, text: "Today's date is now: X" }])
    const tail = SessionContextEpoch.projectUpdates({
      updates: [update],
      canonicalIDs: [MessageID.make("msg_a")],
      retainedIDs: new Set<MessageID>(),
    })
    // 整个窗口都被裁掉时仍要出现一次：end 槽位兜底可见性，不丢日期信息。
    expect(tail).toEqual([{ placement: { type: "end" }, text: "Today's date is now: X" }])
  })
})
