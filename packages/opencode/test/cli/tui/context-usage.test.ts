import { describe, expect, test } from "bun:test"
import type { Message, Part, Provider } from "@opencode-ai/sdk/v2"
import { computeContextData, filterCompactedMessages } from "@/cli/cmd/tui/util/context-usage"
import { contextUsageDetailLines, contextUsageFooter } from "@/cli/cmd/tui/routes/session/context-usage"

const provider: Provider = {
  id: "test",
  name: "Test",
  source: "custom",
  env: [],
  options: {},
  models: {
    model: {
      id: "model",
      providerID: "test",
      api: { id: "model", url: "https://example.com/model", npm: "@ai-sdk/openai" },
      name: "Model",
      family: "test",
      capabilities: {
        temperature: true,
        reasoning: true,
        attachment: false,
        toolcall: true,
        input: { text: true, audio: false, image: false, video: false, pdf: false },
        output: { text: true, audio: false, image: false, video: false, pdf: false },
        interleaved: false,
      },
      release_date: "",
      cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
      limit: { context: 20_000, input: 19_900, output: 100 },
      status: "active",
      options: {},
      headers: {},
    },
  },
}

function user(id: string, tools?: Record<string, boolean>): Message {
  return {
    id,
    sessionID: "s",
    role: "user",
    time: { created: Number(id) },
    agent: "general",
    model: { providerID: "test", modelID: "model" },
    tools,
  } as Message
}

function assistant(id: string, parentID: string, summary = false): Message {
  return {
    id,
    sessionID: "s",
    role: "assistant",
    time: { created: Number(id), completed: Number(id) },
    parentID,
    modelID: "model",
    providerID: "test",
    mode: "general",
    agent: "general",
    path: { cwd: ".", root: "." },
    summary,
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    finish: "stop",
  } as Message
}

function text(messageID: string, value: string): Part {
  return {
    id: `${messageID}-text`,
    sessionID: "s",
    messageID,
    type: "text",
    text: value,
  } as Part
}

describe("context usage", () => {
  test("counts message, instruction, skill, tool, buffer, and free categories", async () => {
    const messages = [user("1", { bash: true }), assistant("2", "1")]
    const parts: Record<string, Part[]> = {
      "1": [text("1", "abcdefgh")],
      "2": [
        text("2", "abcdefghijkl"),
        {
          id: "2-tool",
          sessionID: "s",
          messageID: "2",
          type: "tool",
          callID: "call",
          tool: "bash",
          state: {
            status: "completed",
            input: { command: "pwd" },
            output: "abcdefghijklmnop",
            title: "pwd",
            metadata: {},
            time: { start: 1, end: 2 },
          },
        } as Part,
      ],
    }

    const data = await computeContextData({
      messages,
      parts,
      providers: [provider],
      config: {},
      agents: [],
      paths: { cwd: process.cwd(), worktree: process.cwd() },
      columns: 100,
      instructionFiles: [{ path: "/tmp/AGENTS.md", content: "abcdefgh" }],
      skills: [{ name: "demo", description: "abcdefgh", path: "/tmp/SKILL.md" }],
      toolDefinitions: [{ name: "bash", text: "abcdefghijklmnop" }],
    })

    expect(data.details.messages.userText).toBe(2)
    expect(data.details.messages.assistantText).toBe(3)
    expect(data.details.messages.toolResults).toBe(4)
    expect(data.details.instructions[0]?.tokens).toBe(2)
    expect(data.details.toolDefs.find((item) => item.name === "bash")?.tokens).toBe(4)
    expect(data.categories.find((item) => item.name === "System prompt")?.tokens).toBeGreaterThan(100)
    expect(data.categories.find((item) => item.name === "Input Messages")?.tokens).toBe(6)
    expect(data.categories.find((item) => item.name === "Output Messages")?.tokens).toBe(7)
    expect(data.categories.find((item) => item.name === "Autocompact buffer")?.tokens).toBe(100)
    expect(data.categories.find((item) => item.name === "Model reserve")?.tokens).toBe(100)
    expect(data.details.window).toMatchObject({ inputLimit: 19_900, usableInput: 19_800, compactionBuffer: 100 })
    expect(data.categories.find((item) => item.name === "Free space")?.tokens).toBeGreaterThan(0)
    expect(data.gridRows.flat()).toHaveLength(100)
    expect(data.gridRows.flat().at(-1)?.categoryName).toBe("Autocompact buffer")
  })

  test("splits provider input reserve from the real autocompact buffer", async () => {
    const constrained: Provider = {
      ...provider,
      models: {
        model: {
          ...provider.models.model,
          limit: { context: 204_800, input: 73_700, output: 32_000 },
        },
      },
    }

    const data = await computeContextData({
      messages: [user("1"), assistant("2", "1")],
      parts: {
        "1": [text("1", "hello")],
        "2": [text("2", "world")],
      },
      providers: [constrained],
      config: {},
      agents: [],
      paths: { cwd: process.cwd(), worktree: process.cwd() },
      columns: 180,
      instructionFiles: [],
      skills: [],
      toolDefinitions: [],
    })

    expect(data.details.window).toMatchObject({
      contextLimit: 204_800,
      inputLimit: 73_700,
      usableInput: 53_700,
      providerReserve: 131_100,
      compactionBuffer: 20_000,
    })
    expect(data.categories.find((item) => item.name === "Model reserve")?.tokens).toBe(131_100)
    expect(data.categories.find((item) => item.name === "Autocompact buffer")?.tokens).toBe(20_000)
    expect(data.categories.findIndex((item) => item.name === "Free space")).toBeLessThan(
      data.categories.findIndex((item) => item.name === "Autocompact buffer"),
    )
    expect(data.gridRows.flat().at(-1)?.categoryName).toBe("Autocompact buffer")
  })

  test("estimates all built-in tool definitions when the request did not explicitly disable tools", async () => {
    const data = await computeContextData({
      messages: [user("1"), assistant("2", "1")],
      parts: {
        "1": [text("1", "hello")],
        "2": [text("2", "world")],
      },
      providers: [provider],
      config: {},
      agents: [],
      paths: { cwd: process.cwd(), worktree: process.cwd() },
      columns: 100,
      instructionFiles: [],
      skills: [],
      toolDefinitions: [
        { name: "bash", text: "bash description" },
        { name: "read", text: "read description" },
      ],
    })

    expect(data.details.toolDefs.map((item) => item.name)).toEqual(["bash", "read"])
    expect(data.categories.find((item) => item.name === "Tool definitions")?.tokens).toBeGreaterThan(0)
  })

  test("does not collapse tool definitions to historical tool calls", async () => {
    const messages = [user("1"), assistant("2", "1")]
    const parts: Record<string, Part[]> = {
      "1": [text("1", "hello")],
      "2": [
        {
          id: "2-tool",
          sessionID: "s",
          messageID: "2",
          type: "tool",
          callID: "call",
          tool: "task",
          state: {
            status: "completed",
            input: { description: "inspect", prompt: "inspect", subagent_type: "general" },
            output: "done",
            title: "inspect",
            metadata: {},
            time: { start: 1, end: 2 },
          },
        } as Part,
      ],
    }

    const data = await computeContextData({
      messages,
      parts,
      providers: [provider],
      config: {},
      agents: [],
      paths: { cwd: process.cwd(), worktree: process.cwd() },
      columns: 100,
      instructionFiles: [],
      skills: [],
    })

    expect(data.details.toolDefs.length).toBeGreaterThan(10)
    expect(data.details.toolDefs.find((item) => item.name === "task")?.tokens).toBeGreaterThan(20)
    expect(data.categories.find((item) => item.name === "Tool definitions")?.tokens).toBeGreaterThan(1000)
  })

  test("explicit false tools disable definitions without turning true tools into a subset", async () => {
    const data = await computeContextData({
      messages: [user("1", { read: true, bash: false }), assistant("2", "1")],
      parts: {
        "1": [text("1", "hello")],
        "2": [text("2", "world")],
      },
      providers: [provider],
      config: {},
      agents: [],
      paths: { cwd: process.cwd(), worktree: process.cwd() },
      columns: 100,
      instructionFiles: [],
      skills: [],
      toolDefinitions: [
        { name: "bash", text: "bash description" },
        { name: "grep", text: "grep description" },
        { name: "read", text: "read description" },
      ],
    })

    expect(data.details.toolDefs.map((item) => item.name)).toEqual(["grep", "read"])
  })

  test("context usage detail lines are bounded so they do not push into the grid", async () => {
    const data = await computeContextData({
      messages: [user("1", { bash: true }), assistant("2", "1")],
      parts: {
        "1": [text("1", "hello")],
        "2": [text("2", "world")],
      },
      providers: [provider],
      config: {},
      agents: [],
      paths: { cwd: process.cwd(), worktree: process.cwd() },
      columns: 100,
      instructionFiles: [{ path: "F:\\very\\long\\nested\\workspace\\path\\that\\should\\not\\overflow\\AGENTS.md", content: "body" }],
      skills: [],
      toolDefinitions: [{ name: "bash", text: "bash description" }],
    })

    const lines = contextUsageDetailLines(data, 80)
    expect(lines.length).toBeLessThanOrEqual(3)
    expect(lines.every((line) => line.length <= 72)).toBe(true)
    expect(lines.every((line) => line.length === 72)).toBe(true)
    expect(lines.join("\n")).toContain("AGENTS.md")
    expect(lines.join("\n")).toContain("Input")
    expect(lines.join("\n")).toContain("Output")
    expect(lines.join("\n")).toContain("Prompt")
    expect(lines.join("\n")).not.toContain("Skills 0")
  })

  test("footer reports confirmed session input, output, reasoning, and cache totals", async () => {
    const data = await computeContextData({
      messages: [user("1"), assistant("2", "1")],
      parts: {
        "1": [text("1", "hello")],
        "2": [
          {
            id: "sf",
            sessionID: "s",
            messageID: "2",
            type: "step-finish",
            reason: "stop",
            cost: 0.01,
            tokens: {
              input: 100,
              output: 40,
              reasoning: 10,
              cache: { read: 20, write: 5 },
            },
          } as Part,
        ],
      },
      providers: [provider],
      config: {},
      agents: [],
      paths: { cwd: process.cwd(), worktree: process.cwd() },
      columns: 100,
      instructionFiles: [],
      skills: [],
      toolDefinitions: [],
    })

    expect(data.details.usage).toMatchObject({ input: 100, output: 40, reasoning: 10, cacheRead: 20, cacheWrite: 5 })
    expect(contextUsageFooter(data, 100)).toContain("Session Totals")
    expect(contextUsageFooter(data, 100)).toContain("Output 40")
    expect(contextUsageFooter(data, 100)).toContain("Cache W/R 5/20")
    expect(contextUsageFooter(data, 100).length).toBe(82)
  })

  test("filters compacted history and keeps summary plus retained tail", () => {
    const messages = [
      { info: user("1"), parts: [text("1", "old")] },
      { info: assistant("2", "1"), parts: [text("2", "old answer")] },
      { info: user("3"), parts: [text("3", "tail")] },
      { info: assistant("4", "3"), parts: [text("4", "tail answer")] },
      {
        info: user("5"),
        parts: [{ id: "c", sessionID: "s", messageID: "5", type: "compaction", auto: true, tail_start_id: "3" } as Part],
      },
      { info: assistant("6", "5", true), parts: [text("6", "summary")] },
    ]

    const result = filterCompactedMessages(messages.toReversed()).map((item) => item.info.id)
    expect(result).toEqual(["3", "4", "5", "6"])
  })
})
