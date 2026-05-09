import { describe, expect, test } from "bun:test"
import { tokenAccounting } from "@/cli/cmd/tui/util/token-accounting"

/** 精简的 part 工厂函数，减少测试噪音 */
function assistantMsg(id: string, parentID: string, tokens?: { input: number; output: number; reasoning: number; cache: { read: number; write: number } }, completed?: number) {
  return {
    id, role: "assistant", parentID,
    cost: 0,
    tokens: tokens ?? { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, completed },
  }
}

function userMsg(id: string) {
  return { id, role: "user" }
}

function stepFinish(input: number, output: number, reasoning = 0, cacheRead = 0, cacheWrite = 0, inputChars?: number) {
  return {
    id: "sf", sessionID: "s", messageID: "m2", type: "step-finish",
    reason: "stop", cost: 0,
    tokens: { input, output, reasoning, cache: { read: cacheRead, write: cacheWrite } },
    ...(inputChars != null ? { inputChars } : {}),
  }
}

function textPart(id: string, text: string) {
  return { id, sessionID: "s", messageID: "m2", type: "text", text }
}

describe("tokenAccounting", () => {
  test("step.input = confirmed tokens when last step-finish exists and message completed", () => {
    const msgs = [userMsg("1"), assistantMsg("2", "1", { input: 100, output: 200, reasoning: 0, cache: { read: 5, write: 10 } }, 10)]
    const getParts = (_id: string) => [stepFinish(100, 200, 0, 5, 10, 2000)]
    const acc = tokenAccounting(msgs, getParts)
    expect(acc.step.input).toBe(115)
    expect(acc.step.output).toBe(200)
    expect(acc.step.confirmed).toBe(true)
  })

  test("step.input = daemon estimate when no step-finish yet", () => {
    const msgs = [userMsg("1"), assistantMsg("2", "1", { input: 8000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } })]
    const getParts = (_id: string) => [textPart("p1", "hello world")]
    const acc = tokenAccounting(msgs, getParts)
    expect(acc.step.input).toBe(8000)
    expect(acc.step.confirmed).toBe(false)
  })

  test("session accumulates step-finish data across messages", () => {
    const msgs = [
      userMsg("1"),
      assistantMsg("2", "1", undefined, 10),
      assistantMsg("3", "1", undefined, 20),
    ]
    const getParts = (id: string) => {
      if (id === "2") return [stepFinish(100, 200, 0, 0, 0)]
      if (id === "3") return [stepFinish(300, 400, 50, 10, 5)]
      return []
    }
    const acc = tokenAccounting(msgs, getParts)
    expect(acc.session.input).toBe(400)
    expect(acc.session.output).toBe(600)
    expect(acc.session.reasoning).toBe(50)
    expect(acc.session.cacheRead).toBe(10)
    expect(acc.session.cacheWrite).toBe(5)
    expect(acc.session.cost).toBe(0)
  })

  test("request.input/output only include requestAssistants", () => {
    const msgs = [
      userMsg("u1"),
      assistantMsg("a1", "u1", undefined, 10),
      userMsg("u2"),
      assistantMsg("a2", "u2", undefined, 20),
    ]
    const getParts = (id: string) => {
      if (id === "a1") return [stepFinish(100, 200, 0, 5, 0)]
      if (id === "a2") return [stepFinish(300, 400, 0, 10, 5)]
      return []
    }
    const acc = tokenAccounting(msgs, getParts)
    expect(acc.request.input).toBe(315)
    expect(acc.request.output).toBe(400)
    expect(acc.session.input).toBe(400)
    expect(acc.session.output).toBe(600)
  })

  test("ratio calibration from history", () => {
    const msgs = [
      userMsg("1"),
      assistantMsg("2", "1", undefined, 10),
    ]
    // inputChars=1000, inputTokens=100+5+5=110 → ratio ≈ 1000/110 ≈ 9.09
    const getParts = (_id: string) => [stepFinish(100, 200, 0, 5, 5, 1000)]
    const acc = tokenAccounting(msgs, getParts)
    expect(acc.ratio.input).toBeCloseTo(9.09, 1)
    // output: text part chars / output tokens (200)
    // If there are text parts between step-start and step-finish
  })

  test("breakdown = precise allocation from confirmed inputBreakdown", () => {
    const msgs = [userMsg("1"), assistantMsg("2", "1", undefined, 10)]
    const getParts = (_id: string) => [{
      ...stepFinish(500, 200, 0, 0, 0, 10000),
      inputBreakdown: {
        system: 5000, instructions: 2000, skills: 0, tools: 1000,
        messages: { userText: 500, assistantText: 300, reasoning: 0, toolInput: 200, toolOutput: 300, attachments: 700, total: 2000 },
      },
    }]
    const acc = tokenAccounting(msgs, getParts)
    expect(acc.breakdown).not.toBeNull()
    const bd = acc.breakdown!
    // system = round(500 * 5000/10000) = 250
    expect(bd.system).toBe(250)
    // instructions = round(500 * 2000/10000) = 100
    expect(bd.instructions).toBe(100)
    // tools = round(500 * 1000/10000) = 50
    expect(bd.tools).toBe(50)
    // Alloc output: reasoning=0, visible=200
    // text chars=300, tool call chars=200, total=500
    // assistantText = round(200 * 300/500) = 120
    // toolCalls = 200 - 120 = 80
    expect(bd.assistantText).toBe(120)
    expect(bd.toolCalls).toBe(80)
  })
})
