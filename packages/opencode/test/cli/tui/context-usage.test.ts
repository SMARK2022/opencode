import { describe, expect, test } from "bun:test"
import { createMemo, createRoot } from "solid-js"
import { createStore, produce } from "solid-js/store"
import type { Message, Part, Provider } from "@opencode-ai/sdk/v2"
import { computeContextData, contextGrid, filterCompactedMessages, type ContextCategory } from "@/cli/cmd/tui/util/context-usage"
import { contextUsageDetailLines, contextUsageFooter, contextUsageRefreshKey, contextUsageSnapshot } from "@/cli/cmd/tui/routes/session/context-usage"

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
  test("refresh key follows streaming tool deltas without serializing raw payloads", () => {
    const raw = new String('{"filePath"')
    Object.defineProperty(raw, "toJSON", {
      value() {
        throw new Error("raw payload should not be JSON-serialized while building the refresh key")
      },
    })
    const messages = [user("1"), assistant("2", "1")]
    const common = {
      messages,
      providers: [provider],
      config: {},
      agents: [],
      lastUserModel: undefined,
      vcs: undefined,
      paths: { cwd: process.cwd(), worktree: process.cwd() },
      columns: 100,
    }

    const first = contextUsageRefreshKey({
      ...common,
      getParts: (id) => id === "2" ? [{
        id: "tool",
        sessionID: "s",
        messageID: "2",
        type: "tool",
        tool: "bash",
        callID: "call",
        state: { status: "pending", input: {}, raw: raw as unknown as string },
      } as Part] : [],
    })
    const second = contextUsageRefreshKey({
      ...common,
      getParts: (id) => id === "2" ? [{
        id: "tool",
        sessionID: "s",
        messageID: "2",
        type: "tool",
        tool: "bash",
        callID: "call",
        state: { status: "pending", input: {}, raw: '{"filePath":"src/index.ts"' },
      } as Part] : [],
    })

    expect(first).not.toBe(second)
  })

  test("snapshot tracks streaming tool input deltas", () => {
    createRoot((dispose) => {
      const [store, setStore] = createStore<{ parts: Record<string, Part[]> }>({
        parts: {
          message: [
            {
              id: "tool",
              sessionID: "s",
              messageID: "message",
              type: "tool",
              tool: "bash",
              callID: "call",
              state: { status: "pending", input: {}, raw: "" },
            } as Part,
          ],
        },
      })
      let runs = 0
      const snapshot = createMemo(() => {
        runs++
        return contextUsageSnapshot([...(store.parts.message ?? [])])
      })

      const initial = snapshot()[0]
      if (!initial || initial.type !== "tool" || initial.state.status !== "pending") {
        throw new Error("expected pending tool part")
      }
      expect(initial.state.raw).toBe("")
      setStore(
        "parts",
        "message",
        produce((draft) => {
          const part = draft[0]
          if (part?.type === "tool" && part.state.status === "pending") part.state.raw = '{"filePath"'
        }),
      )
      const updated = snapshot()[0]
      if (!updated || updated.type !== "tool" || updated.state.status !== "pending") {
        throw new Error("expected pending tool part")
      }
      expect(updated.state.raw).toBe('{"filePath"')
      expect(runs).toBe(2)
      dispose()
    })
  })

  test("precise allocation from daemon step-finish inputBreakdown", async () => {
    const messages = [user("1", { bash: true }), assistant("2", "1")]
    const parts: Record<string, Part[]> = {
      "1": [text("1", "abcdefgh")],
      "2": [
        text("2", "abcdefghijkl"),
        {
          id: "sf",
          sessionID: "s",
          messageID: "2",
          type: "step-finish",
          reason: "stop",
          cost: 0,
          tokens: { input: 400, output: 150, reasoning: 50, cache: { read: 0, write: 0 } },
          inputChars: 1000,
          inputBreakdown: {
            system: 300, instructions: 100, skills: 0, tools: 100,
            messages: { userText: 50, assistantText: 80, reasoning: 60, toolInput: 40, toolOutput: 70, attachments: 100, total: 500 },
          },
        } as Part,
      ],
    }

    const data = await computeContextData({
      messages,
      parts,
      providers: [provider],
      config: { compaction: { reserved: 100 } },
      agents: [],
      paths: { cwd: process.cwd(), worktree: process.cwd() },
      columns: 100,
      instructionFiles: [{ path: "/tmp/AGENTS.md", content: "abcdefgh" }],
      toolDefinitions: [{ name: "bash", text: "abcdefghijklmnop" }],
    })

    // confirmedInput = 400 (tokens.input)
    // alloc = round(chars * 400 / 1000)
    // system: round(300 * 0.4) = 120
    // instructions: round(100 * 0.4) = 40
    expect(data.categories.find((item) => item.name === "System prompt")?.tokens).toBe(120)
    expect(data.categories.find((item) => item.name === "Instructions")?.tokens).toBe(40)
    // tools: round(100 * 0.4) = 40
    expect(data.categories.find((item) => item.name === "Tool definitions")?.tokens).toBe(40)
    // input context: assistantText=32, reasoning=24, toolCalls=16
    // live output: text part gets all visible output=150, reasoning=50, no live tool-call output
    expect(data.details.messages.assistantText).toBe(182)
    expect(data.details.messages.reasoning).toBe(74)
    expect(data.details.messages.toolCalls).toBe(16)
    // window still valid
    expect(data.details.window).toMatchObject({ inputLimit: 19_900, usableInput: 19_800, compactionBuffer: 100 })
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
      config: { compaction: { reserved: 20_000 } },
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

  test("main total is latest context window while footer keeps session totals", async () => {
    const messages = [user("1"), assistant("2", "1"), user("3"), assistant("4", "3")]
    const parts: Record<string, Part[]> = {
      "2": [
        {
          id: "sf-old",
          sessionID: "s",
          messageID: "2",
          type: "step-finish",
          reason: "stop",
          cost: 0,
          tokens: { input: 1_000, output: 100, reasoning: 0, cache: { read: 0, write: 0 } },
        } as Part,
      ],
      "4": [
        {
          id: "sf-latest",
          sessionID: "s",
          messageID: "4",
          type: "step-finish",
          reason: "stop",
          cost: 0,
          tokens: { input: 200, output: 20, reasoning: 0, cache: { read: 50, write: 0 } },
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
      toolDefinitions: [],
    })

    expect(data.totalTokens).toBe(270)
    expect(data.details.usage.total).toBe(1_370)
    expect(contextUsageFooter(data, 100)).toContain("Session Totals")
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

  test("uses daemon inputBreakdown when available for accurate per-category estimation", async () => {
    // 模拟 daemon 记录的 step-finish 含 inputBreakdown
    const messages = [user("1"), assistant("2", "1")]
    const parts: Record<string, Part[]> = {
      "1": [text("1", "hello world user question about code")],
      "2": [
        text("2", "here is the answer with some code"),
        {
          id: "sf1",
          sessionID: "s",
          messageID: "2",
          type: "step-finish",
          reason: "stop",
          cost: 0.001,
          tokens: { input: 12000, output: 600, reasoning: 0, cache: { read: 3000, write: 2000 } },
          inputChars: 34000,
          inputBreakdown: {
            system: 8000,
            instructions: 1000,
            skills: 0,
            tools: 5000,
            messages: {
              userText: 8000,
              assistantText: 8000,
              reasoning: 0,
              toolInput: 2000,
              toolOutput: 2000,
              attachments: 0,
              total: 20000,
            },
          },
        } as unknown as Part,
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
      toolDefinitions: [],
    })

    // 用 daemon breakdown + 校准 ratio 估算：ratio = 34000/17000 = 2.0
    // system: 8000/2.0 = 4000
    // instructions: 1000/2.0 = 500
    // tools: 5000/2.0 = 2500
    expect(data.categories.find((c) => c.name === "System prompt")?.tokens).toBe(4000)
    expect(data.categories.find((c) => c.name === "Instructions")?.tokens).toBe(500)
    expect(data.categories.find((c) => c.name === "Tool definitions")?.tokens).toBe(2500)
    expect(data.categories.find((c) => c.name === "Skills")?.tokens).toBe(0)
  })

  test("ratio=2.5 gives consistently higher estimates than ratio=4 for JSON-heavy content", async () => {
    // 用大段 JSON 验证校准差值
    const longText = JSON.stringify(Array.from({ length: 100 }, (_, i) => ({
      role: "user",
      content: `message number ${i} with repeated text to simulate conversation history and tool outputs containing JSON data structures`,
    })))

    const messages = [user("1"), assistant("2", "1")]
    const parts: Record<string, Part[]> = {
      "1": [text("1", longText)],
      "2": [{
        id: "sf1",
        sessionID: "s",
        messageID: "2",
        type: "step-finish",
        reason: "stop",
        cost: 0.01,
        tokens: { input: Math.round(longText.length / 2.5), output: 100, reasoning: 0, cache: { read: 0, write: 0 } },
        inputChars: longText.length,
          inputBreakdown: {
            system: 0,
            instructions: 0,
            skills: 0,
            tools: 0,
            messages: {
              userText: longText.length,
              assistantText: 0,
              reasoning: 0,
              toolInput: 0,
              toolOutput: 0,
              attachments: 0,
              total: longText.length,
            },
          },
      } as unknown as Part],
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
      toolDefinitions: [],
    })

    // 使用校准 ratio=2.5
    const inputTokens = data.categories.find((c) => c.name === "Input Messages")?.tokens ?? 0
    const confirmed = Math.round(longText.length / 2.5)

    // 估算应接近确认值 (误差 < 2%)
    expect(Math.abs(inputTokens - confirmed) / confirmed).toBeLessThan(0.02)
  })

  test("queued trailing user does not blank out context usage or shift the resolved model", async () => {
    // orphan user3 没有 assistant 子节点（模拟 TaskTool 后台注入 noReply prompt 在父会话
    // busy 期间持久化的 user message）。修复前 lastUser=user3(modelB) 导致 /context 面板
    // 的 model 解析漂移到未定义的 modelB（maxTokens=0）；修复后应锁定 user1（活跃
    // assistantA 的 parent），model 解析回到 provider 已定义的 "test/model"。
    const messages = [
      user("1"),
      assistant("2", "1"),
      { ...user("3"), model: { providerID: "test", modelID: "modelB" } },
    ]
    const parts: Record<string, Part[]> = {
      "2": [
        {
          id: "sf1",
          sessionID: "s",
          messageID: "2",
          type: "step-finish",
          reason: "stop",
          cost: 0.001,
          tokens: { input: 12000, output: 600, reasoning: 0, cache: { read: 3000, write: 2000 } },
          inputChars: 34000,
          inputBreakdown: {
            system: 8000,
            instructions: 1000,
            skills: 0,
            tools: 5000,
            messages: {
              userText: 8000,
              assistantText: 8000,
              reasoning: 0,
              toolInput: 2000,
              toolOutput: 2000,
              attachments: 0,
              total: 20000,
            },
          },
        } as unknown as Part,
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
      toolDefinitions: [],
    })

    // model 应解析为 user1 的 "test/model"（provider 有定义），而非 orphan user3 的 "test/modelB"
    expect(data.model).toBe("test/model")
    expect(data.maxTokens).toBe(20_000)
    // totalTokens 取自活跃 assistantA 的 step（17000 input + 600 output），不受 queued user 影响
    expect(data.totalTokens).toBe(17_600)
  })

  // 网格 seat：累积水位线（waterline）——整数刻度被谁的累积区间跨过，格子就归谁。
  // 预期值独立手算 floor(cum*seats/sum)-floor(prev*seats/sum)，不复制实现源码。

  function countByCategory(rows: ReturnType<typeof contextGrid>) {
    const map = new Map<string, number>()
    for (const cell of rows.flat()) {
      map.set(cell.categoryName, (map.get(cell.categoryName) ?? 0) + 1)
    }
    return map
  }

  function cat(name: string, tokens: number, color: ContextCategory["color"] = "primary"): ContextCategory {
    return { name, tokens, color, isDeferred: name === "Free space" || name === "Model reserve" || name === "Autocompact buffer" }
  }

  test("grid seats always fill the fixed total under waterline apportionment", () => {
    // lock-in：用户要求“分配总数必须达到 total”；回归时若丢席会先在这里红。
    const categories = [
      cat("System prompt", 1_000),
      cat("Input Messages", 3_000),
      cat("Free space", 16_000),
    ]
    // contextLimit 仅影响 gridSize；<100k → width 10；rows 10 → total 100
    const rows = contextGrid(categories, 20_000, { columns: 100, rows: 10 })
    expect(rows.flat()).toHaveLength(100)
    const counts = countByCategory(rows)
    expect([...counts.values()].reduce((a, b) => a + b, 0)).toBe(100)
  })

  test("sub-half used fragments still occupy seats when their waterline crosses integers", () => {
    // 红路径：亚半格碎片合起来应占多格——旧独立 round 会全灭，水位跨 1..4 刻度应给出 used=4。
    // 10×800 + free 192000 = 200000；seats=100 → 每 used exact=0.4；合计 used exact=4
    const used = Array.from({ length: 10 }, (_, i) => cat(`U${i}`, 800))
    const categories = [...used, cat("Free space", 192_000)]
    const rows = contextGrid(categories, 50_000, { columns: 100, rows: 10 })
    const counts = countByCategory(rows)
    const usedCells = used.reduce((sum, c) => sum + (counts.get(c.name) ?? 0), 0)
    expect(usedCells).toBe(4)
    expect(counts.get("Free space")).toBe(96)
    expect(rows.flat()).toHaveLength(100)
  })

  test("waterline assigns seats by cumulative stack order, not largest-remainder frac race", () => {
    // 顺序敏感：LRM 会按 frac 抢席给 B，水位线按栈序跨刻度使 B=0——锁死用户要的叠高语义。
    // 手算 waterline seats=100, weights [2300,400,97300] → A=2,B=0,Free=98
    const categories = [cat("A", 2_300), cat("B", 400), cat("Free space", 97_300)]
    const rows = contextGrid(categories, 50_000, { columns: 100, rows: 10 })
    const counts = countByCategory(rows)
    expect(counts.get("A")).toBe(2)
    expect(counts.get("B") ?? 0).toBe(0)
    expect(counts.get("Free space")).toBe(98)
  })

  test("single used block at one third of mass gets exactly one third of seats", () => {
    // 用户症状：100K 占 300K 时应约三分之一图标带，不能明显偏短。
    const categories = [cat("Input Messages", 100_000), cat("Free space", 200_000)]
    const rows = contextGrid(categories, 50_000, { columns: 100, rows: 12 })
    expect(rows.flat()).toHaveLength(120)
    expect(countByCategory(rows).get("Input Messages")).toBe(40)
  })

  test("multi-category used share stays within one seat of exact waterline total", () => {
    // 多类拆分后 used 合计仍须贴近 exact；禁止 Free 吸余数导致 used 系统少席。
    const categories = [
      cat("System prompt", 14_000),
      cat("Instructions", 11_000),
      cat("Skills", 4_000),
      cat("Tool definitions", 17_000),
      cat("Input Messages", 23_000),
      cat("Tool results", 13_000),
      cat("Output Messages", 10_000),
      cat("Tool calls", 8_000),
      cat("Free space", 200_000),
    ]
    const rows = contextGrid(categories, 50_000, { columns: 100, rows: 16 })
    expect(rows.flat()).toHaveLength(160)
    const counts = countByCategory(rows)
    const usedNames = new Set(categories.filter((c) => c.name !== "Free space").map((c) => c.name))
    const usedCells = [...counts.entries()].filter(([n]) => usedNames.has(n)).reduce((s, [, n]) => s + n, 0)
    expect(Math.abs(usedCells - 160 / 3)).toBeLessThanOrEqual(1)
  })

  test("attachments mass is painted so used cells track real step used share", async () => {
    // INV-03：attachments 已计入 used 却无色块时 Free 会吞席；必须出现 Attachments 类别与格子。
    const messages = [user("1"), assistant("2", "1")]
    const parts: Record<string, Part[]> = {
      "1": [text("1", "hello")],
      "2": [
        text("2", "world"),
        {
          id: "sf",
          sessionID: "s",
          messageID: "2",
          type: "step-finish",
          reason: "stop",
          cost: 0,
          tokens: { input: 400, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          inputChars: 1000,
          inputBreakdown: {
            system: 100,
            instructions: 100,
            skills: 0,
            tools: 100,
            messages: {
              userText: 100,
              assistantText: 0,
              reasoning: 0,
              toolInput: 0,
              toolOutput: 100,
              attachments: 500,
              total: 700,
            },
          },
        } as Part,
      ],
    }
    const data = await computeContextData({
      messages,
      parts,
      providers: [provider],
      config: { compaction: { reserved: 0 } },
      agents: [],
      paths: { cwd: process.cwd(), worktree: process.cwd() },
      columns: 100,
      instructionFiles: [],
      skills: [],
      toolDefinitions: [],
    })
    // provider context=20000；attachments 应按比例分到 confirmed input 并进入色块
    expect(data.categories.find((c) => c.name === "Attachments")?.tokens).toBeGreaterThan(0)
    const flat = data.gridRows.flat()
    expect(flat.filter((c) => c.categoryName === "Attachments").length).toBeGreaterThan(0)
  })

  test("autocompact buffer seats remain a contiguous tail after waterline", () => {
    // INV-04：Autocompact 席位来自同一 waterline 结果，仅序列化贴尾，不能再二次 round。
    const categories = [
      cat("Input Messages", 40_000),
      cat("Free space", 40_000),
      cat("Autocompact buffer", 20_000),
    ]
    const rows = contextGrid(categories, 50_000, { columns: 100, rows: 10 })
    const flat = rows.flat()
    expect(flat).toHaveLength(100)
    const tail = flat.slice(-20)
    expect(tail.every((c) => c.categoryName === "Autocompact buffer")).toBe(true)
    expect(flat.filter((c) => c.categoryName === "Autocompact buffer")).toHaveLength(20)
  })
})
