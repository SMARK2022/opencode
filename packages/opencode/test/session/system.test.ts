import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import type { Agent } from "../../src/agent/agent"
import { NamedError } from "@opencode-ai/core/util/error"
import { Skill } from "../../src/skill"
import { Permission } from "../../src/permission"
import { SystemPrompt } from "../../src/session/system"
import { Git } from "../../src/git"
import { ToolRegistry } from "../../src/tool/registry"
import { testEffect } from "../lib/effect"
import { ModelID, ProviderID } from "../../src/provider/schema"
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
})
