import { describe, expect, test } from "bun:test"
import type { AssistantMessage, Part } from "@opencode-ai/sdk/v2"
import { computeFinalTokens } from "@/cli/cmd/tui/util/token-estimate"

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

function stepFinish(input: number, output: number, reasoning = 0, cacheRead = 0, cacheWrite = 0): Part {
  return {
    id: "sf",
    sessionID: "s",
    messageID: "2",
    type: "step-finish",
    reason: "stop",
    cost: 0,
    tokens: { input, output, reasoning, cache: { read: cacheRead, write: cacheWrite } },
  } as Part
}

describe("token estimate — computeFinalTokens", () => {
  test("uses assistant message tokens.input before the first step-finish (daemon estimate)", () => {
    const result = computeFinalTokens(
      assistant({ input: 5200 }),
      [text("p1", "Hello")], // streaming text
      { input: 0, output: 0 },
    )

    expect(result.input).toBe(5200) // estimate from message.tokens.input
    expect(result.output).toBe(1)   // "Hello".length / 4 ≈ 1
    expect(result.totalInput).toBe(5200)
    expect(result.totalOutput).toBe(1)
  })

  test("uses step-finish tokens and ignores assistant estimate once confirmed", () => {
    const result = computeFinalTokens(
      assistant({ input: 9999 }, 3),
      [stepFinish(5100, 200, 10, 20, 30)],
      { input: 5370, output: 350 },
    )

    expect(result.input).toBe(5150)
    expect(result.output).toBe(210)
    expect(result.totalInput).toBe(5370)
    expect(result.totalOutput).toBe(350)
  })

  test("streaming text + assistant estimate: shows estimate for input, text for output", () => {
    const result = computeFinalTokens(
      assistant({ input: 8000 }), // in-flight, not completed
      [text("p1", "abcdefgh")],     // 8 chars streaming
      { input: 0, output: 0 },
    )

    expect(result.input).toBe(8000)
    expect(result.output).toBe(2) // 8/4 = 2
  })

  test("streaming text without assistant estimate or step-finish returns 0 input", () => {
    const result = computeFinalTokens(
      assistant({ input: 0 }),
      [text("p1", "abcdefgh")],
      { input: 0, output: 0 },
    )

    expect(result.input).toBe(0)
    expect(result.output).toBe(2)
  })

  test("pending tool call adds to streaming output estimate", () => {
    const toolPending: Part = {
      id: "t1",
      sessionID: "s",
      messageID: "2",
      type: "tool",
      callID: "c1",
      tool: "bash",
      state: { status: "pending", input: {}, raw: "pending-raw-text" },
    } as Part

    const result = computeFinalTokens(
      assistant({ input: 5000 }),
      [text("p1", "ab"), toolPending, text("p2", "cd")],
      { input: 0, output: 0 },
    )

    // streamingOut: "ab" (2) + "pending-raw-text" (17) + "cd" (2) = 21 chars → 5 tokens
    // pendingInput: 0 (no completed tool)
    expect(result.input).toBe(5000)
    expect(result.output).toBe(5)
  })

  test("multiple requests: respects previous confirmed tokens", () => {
    // request 1 assistant: step-finish with real tokens
    const requestConfirmed = { input: 5000, output: 200 }

    // request 2 assistant: streaming with estimate
    const result = computeFinalTokens(
      assistant({ input: 7000 }),
      [text("p1", "abcdefgh")],
      requestConfirmed,
    )

    // currentInput = 7000 (estimate), currentOutput = 2 (streaming)
    // totalInput = 5000 + 7000 + 0 = 12000
    // totalOutput = 200 + 2 = 202
    expect(result.input).toBe(7000)
    expect(result.output).toBe(2)
    expect(result.totalInput).toBe(12000)
    expect(result.totalOutput).toBe(202)
  })
})
