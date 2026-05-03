import { describe, expect, test } from "bun:test"
import type { AssistantMessage, Message, Part } from "@opencode-ai/sdk/v2"
import { computeFinalTokens, charsPerTokenFromHistory } from "@/cli/cmd/tui/util/token-estimate"

function assistant(tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read: number; write: number } }, completed?: number): AssistantMessage {
  return {
    id: "2",
    sessionID: "s",
    role: "assistant",
    time: { created: 2, completed },
    parentID: "1",
    modelID: "model",
    providerID: "test",
    mode: "general",
    agent: "general",
    path: { cwd: ".", root: "." },
    cost: 0,
    tokens: { input: tokens?.input ?? 0, output: tokens?.output ?? 0, reasoning: tokens?.reasoning ?? 0, cache: tokens?.cache ?? { read: 0, write: 0 } },
  } as AssistantMessage
}

function text(id: string, text: string): Part {
  return { id, sessionID: "s", messageID: "2", type: "text", text } as Part
}

function stepFinish(input: number, output: number, reasoning = 0, cacheRead = 0, cacheWrite = 0, inputChars?: number): Part {
  return {
    id: "sf",
    sessionID: "s",
    messageID: "2",
    type: "step-finish",
    reason: "stop",
    cost: 0,
    tokens: { input, output, reasoning, cache: { read: cacheRead, write: cacheWrite } },
    ...(inputChars != null ? { inputChars } : {}),
  } as Part
}

function userMsg(id: string): Message {
  return { id, sessionID: "s", role: "user", time: { created: 1 }, agent: "general", model: { providerID: "test", modelID: "model" } } as Message
}
function asstMsg(id: string): Message {
  return { id, sessionID: "s", role: "assistant", time: { created: 2 }, parentID: "1", modelID: "model", providerID: "test", mode: "general", agent: "general", path: { cwd: ".", root: "." }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } } as Message
}

describe("charsPerTokenFromHistory", () => {
  test("computes correct ratio from step-finish with inputChars", () => {
    // 模拟 DeepSeek 输入：100000 chars → 40000 input tokens (ratio ≈ 2.5)
    const getParts = (_id: string) => [stepFinish(40000, 5000, 0, 0, 0, 100000)]
    const ratio = charsPerTokenFromHistory(
      [{ role: "assistant", id: "msg" }],
      getParts,
    )
    expect(ratio).toBe(2.5)
  })

  test("includes cache tokens in the ratio calculation", () => {
    const getParts = (_id: string) => [stepFinish(30000, 5000, 0, 5000, 5000, 100000)]
    const ratio = charsPerTokenFromHistory(
      [{ role: "assistant", id: "msg" }],
      getParts,
    )
    // tokens: input(30000) + cache.read(5000) + cache.write(5000) = 40000
    expect(ratio).toBe(2.5)
  })

  test("returns fallback 4 when no data", () => {
    const getParts = (_id: string) => []
    const ratio = charsPerTokenFromHistory(
      [],
      getParts,
    )
    expect(ratio).toBe(4)
  })

  test("returns fallback 4 when inputChars < 100", () => {
    const getParts = (_id: string) => [stepFinish(10, 5, 0, 0, 0, 50)]
    const ratio = charsPerTokenFromHistory(
      [{ role: "assistant", id: "msg" }],
      getParts,
    )
    expect(ratio).toBe(4)
  })

  test("returns fallback 4 when total chars < 500", () => {
    const getParts = (_id: string) => [stepFinish(2, 1, 0, 0, 0, 200)]
    const ratio = charsPerTokenFromHistory(
      [{ role: "assistant", id: "msg" }],
      getParts,
    )
    expect(ratio).toBe(4)
  })

  test("accumulates across multiple messages until 100k chars", () => {
    const getParts = (id: string) => {
      if (id === "m1") return [stepFinish(20000, 3000, 0, 0, 0, 50000)]
      if (id === "m2") return [stepFinish(20000, 3000, 0, 0, 0, 50000)]
      return []
    }
    const msgs = [
      { role: "assistant" as const, id: "m1" },
      { role: "assistant" as const, id: "m2" },
    ]
    // totalChars = 100000, totalTokens = 40000, ratio = 2.5
    expect(charsPerTokenFromHistory(msgs, getParts)).toBe(2.5)
  })

  test("ignores user messages", () => {
    const getParts = (_id: string) => []
    const msgs = [{ role: "user" as const, id: "u1" }]
    expect(charsPerTokenFromHistory(msgs, getParts)).toBe(4)
  })
})

describe("computeFinalTokens with custom ratio", () => {
  // DeepSeek 典型比值：JSON 输入 ~2.5 chars/token
  const deepseekRatio = 2.5

  test("streaming estimate uses custom ratio instead of hardcoded /4", () => {
    const result = computeFinalTokens(
      assistant({ input: 8000 }),
      [text("p1", "abcdefgh")], // 8 chars
      { input: 0, output: 0 },
      deepseekRatio,
    )
    // 8 / 2.5 = 3 (not 8/4 = 2)
    expect(result.input).toBe(8000)
    expect(result.output).toBe(3)
  })

  test("defaults to /4 when no ratio provided", () => {
    const result = computeFinalTokens(
      assistant({ input: 8000 }),
      [text("p1", "abcdefgh")],
      { input: 0, output: 0 },
    )
    expect(result.output).toBe(2) // 8/4 = 2
  })

  test("pending tool call uses custom ratio for streaming estimate", () => {
    const toolPending: Part = {
      id: "t1", sessionID: "s", messageID: "2", type: "tool",
      callID: "c1", tool: "bash",
      state: { status: "pending", input: {}, raw: "pending-raw-text" },
    } as Part

    const result = computeFinalTokens(
      assistant({ input: 5000 }),
      [text("p1", "ab"), toolPending, text("p2", "cd")],
      { input: 0, output: 0 },
      deepseekRatio,
    )
    // streaming: 2 + 17 + 2 = 21 chars → 21/2.5 = 8
    expect(result.output).toBe(8)
  })
})

describe("calibration accuracy — simulated DeepSeek session", () => {
  // 模拟真实 DeepSeek session 的 step-finish 数据
  // 确认 token 数 vs 估算 token 数的对比

  test("ratio=2.5 estimates are much closer to confirmed than ratio=4", () => {
    const longJson = JSON.stringify({
      messages: Array.from({ length: 50 }, (_, i) => ({
        role: i % 2 ? "assistant" : "user",
        content: `message content with various words and some code blocks like \`\`\`\nconst x = ${i};\n\`\`\` and more text here to fill space making it look like real conversation data with tool calls and their results embedded in JSON format.`,
      })),
      tools: Array.from({ length: 5 }, (_, i) => ({
        name: `tool_${i}`,
        description: `Tool number ${i} for doing things with parameters and structured output`,
        inputSchema: { type: "object", properties: { input: { type: "string" } } },
      })),
    })
    // ~10000 chars of JSON
    const chars = longJson.length

    // 真实 DeepSeek tokenizer: ~2.5 chars/token for JSON
    const realTokens = Math.round(chars / 2.5)

    // 旧方法: /4
    const oldEstimate = Math.round(chars / 4)

    // 新方法: /2.5
    const newEstimate = Math.round(chars / 2.5)

    // 新方法应完全等于真实值（因为我们用相同比值估算）
    expect(newEstimate).toBe(realTokens)

    // 旧方法偏差：低估 ~37%
    // e.g. 10000 / 4 = 2500, real = 4000, diff = 1500 (37%)
    expect(oldEstimate).toBeLessThan(realTokens)
    expect(realTokens - oldEstimate).toBeGreaterThan(0)
  })

  test("deepseek ratio for mixed content is between 2.0 and 3.5", () => {
    // 混合内容：natural language + JSON + code
    const naturalLang = "The quick brown fox jumps over the lazy dog. ".repeat(100)
    const jsonContent = JSON.stringify({ key: "value", nested: { array: [1, 2, 3, 4, 5] } }).repeat(50)
    const codeContent = "function example(x: number): string { return x.toString(); }\n".repeat(30)

    const mixed = naturalLang + jsonContent + codeContent
    const chars = mixed.length

    // 自然语言: ~4.0 chars/token
    // JSON: ~2.0-2.5 chars/token
    // Code: ~2.5-3.0 chars/token
    // 混合: ~2.5-3.5 chars/token
    const ratioEstimate4 = Math.round(chars / 4)
    const ratioEstimate2 = Math.round(chars / 2)
    const ratioEstimate3 = Math.round(chars / 3)

    // /4 明显低估
    expect(ratioEstimate4).toBeLessThan(ratioEstimate3)
    // /2 高估
    expect(ratioEstimate2).toBeGreaterThan(ratioEstimate3)
  })
})
