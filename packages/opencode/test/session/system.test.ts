import { describe, expect, test } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { DateTime, Effect, Layer } from "effect"
import type { Agent } from "../../src/agent/agent"
import { NamedError } from "@opencode-ai/core/util/error"
import { Skill } from "../../src/skill"
import { Permission } from "../../src/permission"
import type { Provider } from "../../src/provider/provider"
import { SystemPrompt } from "../../src/session/system"
import { MCP } from "../../src/mcp"
import { Git } from "../../src/git"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { InstanceState } from "../../src/effect/instance-state"
import { testEffect } from "../lib/effect"
import { Database } from "@opencode-ai/core/database/database"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionContextEpoch } from "../../src/session/context-epoch"
import { MessageID, SessionID } from "../../src/session/schema"
import { adjust, setTime } from "effect/testing/TestClock"
import PROMPT_ASTRA from "../../../core/src/system-context/prompt/gpt-astra.txt"
import PROMPT_GPT from "../../../core/src/system-context/prompt/gpt.txt"
import PROMPT_CODEX from "../../../core/src/system-context/prompt/codex.txt"
import PROMPT_BEAST from "../../../core/src/system-context/prompt/beast.txt"
import PROMPT_ANTHROPIC from "../../../core/src/system-context/prompt/anthropic.txt"

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
  LayerNode.compile(LayerNode.group([SystemPrompt.node, Git.node, Database.node]), [
    [RuntimeFlags.node, RuntimeFlags.layer({ disableGit: false })],
    [
      MCP.node,
      Layer.mock(MCP.Service, {
        instructions: () =>
          Effect.succeed([
            {
              name: "guide-server",
              instructions: "Use lookup before mutate.",
              tools: [],
            },
            {
              name: "tool-server",
              instructions: "Prefer search before update.",
              tools: ["tool-server_search", "tool-server_update"],
            },
          ]),
      }),
    ],
    [
      Skill.node,
      Layer.succeed(
        Skill.Service,
        Skill.Service.of({
          get: (name) => Effect.succeed(skills.find((skill) => skill.name === name)),
          require: (name) => {
            const info = skills.find((skill) => skill.name === name)
            if (info) return Effect.succeed(info)
            return Effect.fail(new Skill.NotFoundError({ name, available: skills.map((skill) => skill.name) }))
          },
          all: () => Effect.succeed(skills),
          dirs: () => Effect.succeed([]),
          available: () => Effect.succeed(skills),
        }),
      ),
    ],
  ]),
)

// 复用真实Core连接布置私有持久行，不启动应用或复刻Session业务实现。
const seedContextSession = Effect.fn("test.seedContextSession")(function* (sessionID: SessionID, directory: string) {
  const database = yield* Database.Service
  yield* Database.withSync(database, db => {
    db.insert(ProjectTable).values({ id: Project.ID.global, worktree: AbsolutePath.make(directory), sandboxes: [] }).onConflictDoNothing().run()
    db.insert(SessionTable).values({ id: sessionID, project_id: Project.ID.global, slug: sessionID,
      directory, title: "context", version: "test", time_updated: 1234 }).run()
  })
})
const contextHistory = { boundary: "null", messageIDs: [MessageID.make("msg_context_seed")] }
const contextIt = testEffect(LayerNode.compile(Database.node))
const prepareContext = (sessionID: SessionID, git: string, history = contextHistory) => Effect.gen(function* () {
  return yield* SessionContextEpoch.prepare({ sessionID, history, now: yield* DateTime.nowAsDate,
    captureGit: Effect.succeed(git) })
})

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
    // 展示别名与API id分开，模板不能误按展示名选择；fixture沿用现有Muse测试形式。
    expect(SystemPrompt.provider({ id: "display-alias", api: { id } } as Provider.Model)).toEqual([expected])
  })

  it.instance("retains the Session Git snapshot after the worktree changes", () => Effect.gen(function* () {
    const prompt = yield* SystemPrompt.Service
    const git = yield* Git.Service
    const ctx = yield* InstanceState.context
    const model = { providerID: "test", api: { id: "test" } } as Provider.Model
    const sessionID = SessionID.make("ses_system_git")
    yield* seedContextSession(sessionID, ctx.directory)
    const input = { sessionID, model, history: contextHistory }
    const initial = yield* prompt.environment(input)
    const changed = yield* git.run(["checkout", "-b", "snapshot-next"], { cwd: ctx.directory })
    expect(changed.exitCode).toBe(0)
    // 真实工作树变化不改写Session已保存的快照，不能依赖目录级内存缓存。
    expect((yield* git.branch(ctx.directory))).toBe("snapshot-next")
    expect(yield* prompt.environment(input)).toEqual(initial)
  }), { git: true })
  it.instance("does not inject private Git fields into non-repository environments", () => Effect.gen(function* () {
    const prompt = yield* SystemPrompt.Service
    const ctx = yield* InstanceState.context
    const sessionID = SessionID.make("ses_system_plain")
    yield* seedContextSession(sessionID, ctx.directory)
    const text = (yield* prompt.environment({ sessionID, history: contextHistory,
      model: { providerID: "test", api: { id: "test" } } as Provider.Model })).system.join("\n")
    // 检查真实 environment producer，稳定指引先于包含模型身份的环境尾块。
    expect(text.indexOf("# Doing tasks")).toBeGreaterThanOrEqual(0)
    expect(text.indexOf("You are powered by")).toBeGreaterThan(text.indexOf("# Doing tasks"))
    expect(text).toContain("Is directory a git repo: no")
    expect(text).not.toContain("Git user:")
    expect(text).not.toContain("Recent commits:")
  }))
  test("selects the Meta prompt for Muse Spark model IDs", () => {
    for (const id of ["meta/muse-spark-preview", "muse-spark-1.1", "muse-spark-1.2"]) {
      const prompt = SystemPrompt.provider({ api: { id } } as Provider.Model)[0]
      expect(prompt).toContain("powered by Muse Spark,")
      expect(prompt).toContain("using Meta Muse Spark.")
      expect(prompt).not.toContain("{{MODEL_NAME}}")
    }
  })

  test("selects the Meta prompt for Muse Glimmer model IDs", () => {
    for (const id of ["meta/muse-glimmer", "meta/muse-glimmer-30b", "muse-glimmer-30b"]) {
      const prompt = SystemPrompt.provider({ api: { id } } as Provider.Model)[0]
      expect(prompt).toContain("powered by Muse Glimmer,")
      expect(prompt).toContain("using Meta Muse Glimmer.")
      expect(prompt).not.toContain("{{MODEL_NAME}}")
    }
  })

  test("selects the Kimi prompt for official provider model IDs", () => {
    for (const providerID of ["kimi-for-coding", "moonshotai", "moonshotai-cn"]) {
      const prompt = SystemPrompt.provider({ providerID, api: { id: "k3" } } as Provider.Model)[0]
      expect(prompt).toContain("# Prompt and Tool Use")
    }
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

  it.effect("MCP output includes connected server instructions", () =>
    Effect.gen(function* () {
      const prompt = yield* SystemPrompt.Service
      const output = yield* prompt.mcp(build)

      expect(output).toBe(
        [
          "<mcp_instructions>",
          '  <server name="guide-server">',
          "    Use lookup before mutate.",
          "  </server>",
          '  <server name="tool-server">',
          "    Prefer search before update.",
          "  </server>",
          "</mcp_instructions>",
        ].join("\n"),
      )
    }),
  )

  it.effect("MCP output omits servers when all advertised tools are denied", () =>
    Effect.gen(function* () {
      const prompt = yield* SystemPrompt.Service
      const output = yield* prompt.mcp(build, Permission.fromConfig({ "tool-server_*": "deny" }))

      expect(output).toBe(
        [
          "<mcp_instructions>",
          '  <server name="guide-server">',
          "    Use lookup before mutate.",
          "  </server>",
          "</mcp_instructions>",
        ].join("\n"),
      )
    }),
  )
  contextIt.effect("session context: persists Git across fresh preparations and isolates Sessions", () => Effect.gen(function* () {
    const directory = "/context"
    const firstID = SessionID.make("ses_context_a")
    const secondID = SessionID.make("ses_context_b")
    yield* seedContextSession(firstID, directory)
    yield* seedContextSession(secondID, directory)
    const first = yield* prepareContext(firstID, "before.ts")
    expect((yield* prepareContext(firstID, "after.ts")).baseline).toBe(first.baseline)
    expect((yield* prepareContext(secondID, "after.ts")).baseline).toContain("after.ts")
    expect((yield* prepareContext(firstID, "later.ts")).baseline).toBe(first.baseline)
  }))
  contextIt.effect("session context: appends one durable date update without rewriting baseline", () => Effect.gen(function* () {
    yield* setTime(Date.parse("2026-09-11T12:00:00Z"))
    const id = SessionID.make("ses_context_date")
    yield* seedContextSession(id, "/context")
    const first = yield* prepareContext(id, "before.ts")
    expect(first.updates).toEqual([])
    yield* adjust(25 * 60 * 60 * 1000)
    const next = yield* prepareContext(id, "after.ts")
    expect(next.baseline).toBe(first.baseline)
    expect(next.updates).toHaveLength(1)
    expect(next.updates[0]?.message.text).toContain("Today's date is now:")
    expect((yield* prepareContext(id, "later.ts")).updates).toEqual(next.updates)
    // epoch写入不得改变Session排序时间，亦不能泄漏到公开metadata。
    const database = yield* Database.Service
    expect(yield* Database.withSync(database, db => db.select({ updated: SessionTable.time_updated,
      metadata: SessionTable.metadata }).from(SessionTable).get())).toEqual({ updated: 1234, metadata: null })
  }))
  contextIt.effect("session context: hidden update anchor retires dates while preserving Git", () => Effect.gen(function* () {
    const id = SessionID.make("ses_context_undo")
    yield* seedContextSession(id, "/context")
    const first = yield* prepareContext(id, "before.ts")
    yield* adjust(25 * 60 * 60 * 1000)
    expect((yield* prepareContext(id, "after.ts")).updates).toHaveLength(1)
    const rebuilt = yield* prepareContext(id, "later.ts", { boundary: "null", messageIDs: [MessageID.make("msg_other")] })
    expect(rebuilt.updates).toEqual([])
    expect(rebuilt.baseline).not.toBe(first.baseline)
    expect(rebuilt.snapshot["smark/git"].value).toBe("before.ts")
  }))
  contextIt.effect("session context: compaction replaces date generation but keeps Session Git", () => Effect.gen(function* () {
    const id = SessionID.make("ses_context_compact")
    yield* seedContextSession(id, "/context")
    const first = yield* prepareContext(id, "before.ts")
    yield* adjust(25 * 60 * 60 * 1000)
    expect((yield* prepareContext(id, "after.ts")).updates).toHaveLength(1)
    const compacted = yield* prepareContext(id, "later.ts", { boundary: "completed-compaction", messageIDs: [MessageID.make("msg_tail")] })
    expect(compacted.updates).toEqual([])
    expect(compacted.baseline).not.toBe(first.baseline)
    expect(compacted.snapshot["smark/git"].value).toBe("before.ts")
  }))
  test("session context: update placement preserves after, before-successor and end slots", () => {
    const a = MessageID.make("msg_a")
    const b = MessageID.make("msg_b")
    const update: SessionContextEpoch.Update = { after_message_id: a,
      message: { id: MessageID.make("msg_update"), type: "system", time: { created: 1 }, text: "date" } }
    expect(SessionContextEpoch.projectUpdates({ updates: [update], canonicalIDs: [a, b], retainedIDs: new Set([a]) }))
      .toEqual([{ placement: { type: "after", id: a }, text: "date" }])
    expect(SessionContextEpoch.projectUpdates({ updates: [update], canonicalIDs: [a, b], retainedIDs: new Set([b]) }))
      .toEqual([{ placement: { type: "before", id: b }, text: "date" }])
    expect(SessionContextEpoch.projectUpdates({ updates: [update], canonicalIDs: [a], retainedIDs: new Set() }))
      .toEqual([{ placement: { type: "end" }, text: "date" }])
  })
})
