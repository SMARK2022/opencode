import { describe, expect, test } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SystemContextBuiltIns } from "@opencode-ai/core/system-context/builtins"
import { DateTime, Effect, Layer } from "effect"
import type { Agent } from "../../src/agent/agent"
import { NamedError } from "@opencode-ai/core/util/error"
import { Skill } from "../../src/skill"
import { Permission } from "../../src/permission"
import type { Provider } from "../../src/provider/provider"
import { SystemPrompt } from "../../src/session/system"
import { MCP } from "../../src/mcp"
import { Config } from "../../src/config/config"
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
  // 同一服务连续渲染，防止把配置值冻结在 layer 构造或首次调用时；Git 用固定快照隔离宿主状态。
  const shellCfg: { shell: string | undefined } = { shell: process.platform === "win32" ? "cmd" : "sh" }
  const configShellIt = testEffect(
    LayerNode.compile(LayerNode.group([SystemPrompt.node, Git.node, Database.node]), [
      [RuntimeFlags.node, RuntimeFlags.layer({ disableGit: false })],
      [
        Config.node,
        // 私有fixture只改变shell配置，保留同一Session的Git与日期快照。
        Layer.mock(Config.Service, { get: () => Effect.sync(() => ({ shell: shellCfg.shell })) }),
      ],
      [
        Git.node,
        Layer.mock(Git.Service, {
          branch: () => Effect.succeed("feature"),
          defaultBranch: () => Effect.succeed({ name: "dev", ref: "refs/heads/dev" }),
          status: () => Effect.succeed([{ file: "before.ts", code: "M", status: "modified" as const }]),
          run: () => Effect.succeed({ exitCode: 0, text: () => "SMARK", stdout: Buffer.from(""), stderr: Buffer.from(""), truncated: false }),
        }),
      ],
      [MCP.node, Layer.mock(MCP.Service, { instructions: () => Effect.succeed([]) })],
      [
        Skill.node,
        Layer.mock(Skill.Service, { available: () => Effect.succeed([]) }),
      ],
    ]),
  )
  configShellIt.instance("environment follows configured shell changes", () =>
    Effect.gen(function* () {
      const prompt = yield* SystemPrompt.Service
      const instance = yield* InstanceState.context
      const sessionID = SessionID.make("ses_configured_shell")
      yield* seedContextSession(sessionID, instance.directory)
      const input = { sessionID, model: { api: { id: "test" } } as Provider.Model, history: contextHistory }
      const first = yield* prompt.environment(input)
      // 独立名称来自显式配置；Windows解析出的.EXE大小写不改变shell身份。
      expect(first.system.join("\n")).toMatch(process.platform === "win32" ? /Shell: (?:.*[\\/])?cmd\.exe/i : /Shell: (?:.*[\\/])?sh\n/)
      shellCfg.shell = "bash"
      const second = yield* prompt.environment(input)
      expect(second.system.join("\n")).toMatch(/Shell: (?:.*[\\/])?bash(?:\.exe)?\n/i)
      // Shell是每轮能力，不改写已持久化的Git/日期；只剔除该动态段再比较全文。
      const stripShell = (lines: string[]) => {
        const all = lines.join("\n").split("\n")
        const start = all.findIndex((line) => line.startsWith("  Shell"))
        const end = all.findIndex((line) => line.startsWith("  OS Version:"))
        return [...all.slice(0, start === -1 ? all.length : start), ...all.slice(end === -1 ? all.length : end)]
      }
      expect(stripShell(second.system)).toEqual(stripShell(first.system))
      expect(second.updates).toEqual(first.updates)
      // git 的会话快照仍由原缓存合同保护。
      expect(second.system.join("\n")).toContain("before.ts")
    }), { git: true })

  test("Astra autonomy infers intent before choosing work", () => {
    // 原文合同适用于调研和代码任务；只断言模型收到的文本，不声称证明模型完成率。
    expect(PROMPT_ASTRA).toContain("Infer the user's intent and your task scope from their instructions and the prior conversation context.")
    expect(PROMPT_ASTRA).toContain("You should bias towards action and carry out the user's intended task until it is completed.")
  })

  test("Astra autonomy completes bounded research while clarifying", () => {
    // 保留上游原句的独立工作边界，澄清不能被解释成扩大授权。
    expect(PROMPT_ASTRA.includes("If the intent is unclear, progress towards the goal using the available information and ask for clarification while continuing independent work when possible.")).toBe(true)
    expect(PROMPT_ASTRA.includes("Continue until the user's intended goal is fulfilled, even when it requires sustained work.")).toBe(true)
    // 持续执行与范围内允许未知结论必须成对，避免把研究完成误写成必须证实某命题。
    expect(PROMPT_ASTRA.includes("A pending, running, inconclusive, or unchanged result is not by itself completion.")).toBe(true)
    expect(PROMPT_ASTRA.includes("For research tasks, describe the scope searched and the limits of the evidence. When the requested investigation is complete, report unresolved questions and uncertainty explicitly.")).toBe(true)
  })

  test("Astra clarification uses the shared autonomy contract", () => {
    // 局部兼容性建议统一交给上游澄清合同，避免同一提示词出现两个等待口径。
    expect(PROMPT_ASTRA.includes("ask one short question instead of guessing")).toBe(false)
  })

  test("Astra retains GPT tools without elevating reminder tags", () => {
    // GPT 的编辑工具由 registry 筛选；精简文字不能让模型丢失唯一编辑入口。
    expect(PROMPT_ASTRA).toContain("Always use apply_patch for manual code edits. Do not use cat or any other commands when creating or editing files. Formatting commands or bulk edits don't need to be done with apply_patch.")
    expect(PROMPT_ASTRA).toContain("use multi_tool_use.parallel to parallelize tool calls and only this")
    expect(PROMPT_ASTRA).toContain("read, grep, glob, git status, git diff, git show, ls, nl, and wc")
    // 用户和文件正文也能包含标签，不能通过字面标签推导内容的指令权限。
    expect(PROMPT_ASTRA.includes("blocks are harness instructions, not user-authored content")).toBe(false)
  })

  test("Astra retains formatting and unfinished-work guidance", () => {
    // 断言稳定语义片段，允许合段；不把删空行误当作格式规则仍然完整的证据。
    for (const rule of [
      "Your responses are rendered as GitHub-flavored Markdown.",
      "Never use nested bullets. Keep lists flat (single level).",
      "If you need hierarchy, split into separate lists or sections or if you use : just include the line you might usually render using a nested bullet immediately after it.",
      "For numbered lists, only use the `1. 2. 3.` style markers (with a period), never `1)`.",
      "Headers are optional, only use them when you think they are necessary. If you do use them, use short Title Case (1-3 words) wrapped in **…**. Don't add a blank line.",
      "commands, paths, environment variables, function names, inline examples, keywords.",
      "Code samples or multi-line snippets should be wrapped in fenced code blocks",
      "language tag when possible.",
      "use emojis or em dashes unless explicitly instructed.",
    ]) expect(PROMPT_ASTRA).toContain(rule)
    // 最终交付边界独立于排版约束，合并段落时必须保留该句本身。
    expect(PROMPT_ASTRA).toContain("If the requested work is not finished, keep it in commentary and continue with tools.")
  })

  test("Astra stays within the restrained edit size and deduplicates openers", () => {
    // 空行属于物理行，末尾换行只作终止符；避免 Windows 换行影响用户约定的体量。
    const lines = PROMPT_ASTRA.replaceAll("\r\n", "\n").replace(/\n$/, "").split("\n")
    expect(lines.length).toBeGreaterThanOrEqual(80)
    expect(lines.length).toBeLessThan(107)
    // 尺寸护栏不证明语义完整，重复措辞与保留规则分别由独立断言保护。
    expect(PROMPT_ASTRA.match(/conversational interjections/g)?.length).toBe(1)
  })

  test("verification contract preserves failures and reports missing prerequisites promptly", () => {
    // 失败断言是已观察证据；验证原句也应保留，不能用别处绿灯替代必要检查。
    expect(SystemContextBuiltIns.ACTION_GUIDANCE).toContain("Before reporting a coding task complete, verify the change when feasible.")
    expect(SystemContextBuiltIns.ACTION_GUIDANCE).toContain("Start with the narrowest relevant check for the code you changed, then broaden to related tests, typecheck, lint, or build as confidence grows.")
    expect(SystemContextBuiltIns.ACTION_GUIDANCE.includes("If a check fails, investigate the failure and fix issues within the requested scope.")).toBe(true)
    expect(SystemContextBuiltIns.ACTION_GUIDANCE.includes("treat it as an untested hypothesis")).toBe(false)
    // 缺前提需要用户参与时可立即告知，独立工作仍继续，不把汇报等同结束。
    expect(SystemContextBuiltIns.ACTION_GUIDANCE.includes("If a required check cannot run, identify the missing prerequisite, report it promptly when user input is needed, and continue independent work within the authorized scope.")).toBe(true)
    // 阻塞交付保留未完成状态，防止最终回答把局部验证包装成完整通过。
    expect(SystemContextBuiltIns.ACTION_GUIDANCE.includes("Before ending the turn because of a blocker, state what remains incomplete, what you tried, and what input or external change is needed.")).toBe(true)
    expect(SystemContextBuiltIns.ACTION_GUIDANCE.includes("Keep unresolved verification explicit in the final response.")).toBe(true)
  })

  test("output contract allows interim blockers requiring user input", () => {
    // 缺输入的分支可先汇报，让其他分支继续推进；不能等所有恢复途径耗尽才开口。
    expect(SystemContextBuiltIns.OUTPUT_GUIDANCE.includes("- Errors or blockers that change the plan or require user input")).toBe(true)
    expect(SystemContextBuiltIns.OUTPUT_GUIDANCE.includes("recovery attempts are exhausted")).toBe(false)
  })

  test("ASTRA template carries permission semantics woven into existing sections", () => {
    // 权限语义仅织入ASTRA既有Autonomy段，避免污染其他模型；收尾是残余报告而非停摆请示门禁。
    expect(PROMPT_ASTRA).toContain("User authorization persists across turns")
    expect(PROMPT_ASTRA).toContain("do not stop the turn just because one action was rejected")
    expect(PROMPT_ASTRA).toContain("at the end of your response")
    expect(PROMPT_ASTRA).not.toContain("then ask once")
    expect([SystemContextBuiltIns.ACTION_GUIDANCE, SystemContextBuiltIns.OUTPUT_GUIDANCE].some((section) => section.includes("auto-review"))).toBe(false)
  })

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
