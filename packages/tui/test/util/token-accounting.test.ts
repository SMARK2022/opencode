import { describe, expect, test } from "bun:test"
import type { AssistantMessage, Part, SessionRequestUsage } from "@opencode-ai/sdk/v2"
import { tokenAccounting } from "../../src/util/token-accounting"

// #122：助手消息工厂
function assistantMsg(
  id: string,
  parentID: string,
  tokens?: { input: number; output: number; reasoning: number; cache: { read: number; write: number } },
  completed?: number,
) {
  return {
    id,
    role: "assistant" as const,
    parentID,
    cost: 0,
    tokens: tokens ?? { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, completed },
  }
}

function userMsg(id: string) {
  return { id, role: "user" as const, time: { created: 0 } }
}

function stepFinish(
  id: string,
  tokens: { input: number; output: number; reasoning: number; cache: { read: number; write: number } },
  inputChars?: number,
) {
  return {
    id,
    type: "step-finish" as const,
    tokens,
    ...(inputChars !== undefined ? { inputChars } : {}),
  }
}

describe("tokenAccounting", () => {
  // #122：完成消息 + step-finish → step.input 用确认值（含 cache）
  test("step.input uses confirmed tokens when last step-finish exists and message completed", () => {
    const msgs = [userMsg("u1"), assistantMsg("a1", "u1", { input: 10, output: 20, reasoning: 0, cache: { read: 0, write: 0 } }, 100)]
    const parts: Record<string, any[]> = {
      a1: [stepFinish("sf1", { input: 100, output: 50, reasoning: 0, cache: { read: 5, write: 5 } }, 1000)],
    }
    const acc = tokenAccounting(msgs as any, (id) => parts[id] ?? [])
    expect(acc.step.confirmed).toBe(true)
    expect(acc.step.input).toBe(110)
    expect(acc.step.output).toBe(50)
  })

  // #122：inputChars 足够大时校准 ratio
  test("ratio.input uses step-finish inputChars when sample is large", () => {
    const msgs = [userMsg("u1"), assistantMsg("a1", "u1", undefined, 100)]
    const parts: Record<string, any[]> = {
      a1: [stepFinish("sf1", { input: 100, output: 200, reasoning: 0, cache: { read: 5, write: 5 } }, 1000)],
    }
    const acc = tokenAccounting(msgs as any, (id) => parts[id] ?? [])
    expect(acc.ratio.input).toBeGreaterThan(1)
  })

  test("durable projection survives an empty visible history and preserves prepared input", () => {
    const tokens = { input: 9000, output: 700, reasoning: 30, cache: { read: 100, write: 20 } }
    const snapshot = (request: SessionRequestUsage) => tokenAccounting([], () => [], undefined, {
      session: { tokens, request }, last: undefined, parts: [],
    })
    const request = { messageID: "u", input: 4000, output: 30, stepInput: 1000, stepOutput: 10, cost: 2 }
    // 窗口没有旧消息也不能截断持久累计，未记录会话费用时沿用零值。
    const confirmed = snapshot(request)
    expect(confirmed.request).toEqual({ input: 1000, output: 10, totalInput: 4000, totalOutput: 30, cost: 2 })
    expect(confirmed.session).toEqual({ input: 9000, output: 700, reasoning: 30, cacheRead: 100, cacheWrite: 20, cost: 0 })
    // 首包前由服务端发布估算；零估算同样权威，不能借上一个请求的窗口补值。
    const prepared = { ...request, stepInput: 0, stepOutput: 0, estimatedInput: 777,
      model: { providerID: "p", modelID: "m", contextLimit: 2000 } }
    expect(snapshot(prepared).request).toEqual({ input: 777, output: 0, totalInput: 4777, totalOutput: 30, cost: 2 })
    expect(snapshot(prepared).contextPercent).toBe(39)
    expect(snapshot({ ...prepared, estimatedInput: 0 }).request.totalInput).toBe(4000)
    expect(snapshot(prepared).breakdown).toBeNull()
  })

  test("projection calibrates live output independently and preserves durable totals", () => {
    const history = assistantMsg("old", "u", undefined, 1)
    const last: AssistantMessage = {
      ...assistantMsg("a", "u"), sessionID: "s", agent: "build", mode: "build",
      providerID: "p", modelID: "m", path: { cwd: "/", root: "/" },
      inputEstimate: { input: 777, bodyChars: 1554, confirmed: false, charsPerToken: 2, afterPartID: "02-tool" },
    }
    const parts: Record<string, Part[]> = {
      old: [
        { id: "01-text", sessionID: "s", messageID: "old", type: "text", text: "x".repeat(800) },
        { ...stepFinish("01-finish", { input: 400, output: 80, reasoning: 20, cache: { read: 0, write: 0 } }, 800),
          sessionID: "s", messageID: "old", reason: "stop", cost: 0 },
      ],
      a: [
        { id: "02-tool", sessionID: "s", messageID: "a", type: "tool", callID: "covered", tool: "read",
          state: { status: "completed", input: {}, output: "x".repeat(80), title: "read", metadata: {}, time: { start: 1, end: 2 } } },
        { id: "03-text", sessionID: "s", messageID: "a", type: "text", text: "x".repeat(80) },
        { id: "04-reason", sessionID: "s", messageID: "a", type: "reasoning", text: "x".repeat(40), time: { start: 0, end: 1 } },
        { id: "05-tool", sessionID: "s", messageID: "a", type: "tool", callID: "live", tool: "read",
          state: { status: "pending", input: {}, raw: "x".repeat(40) } },
      ],
    }
    const request: SessionRequestUsage = {
      messageID: "u", assistantID: "a", input: 4000, output: 300, cost: 2, stepInput: 0, stepOutput: 0,
      estimatedInput: 777, inputEstimate: last.inputEstimate,
      model: { providerID: "p", modelID: "m", contextLimit: 2000 },
    }
    const tokens = { input: 9000, output: 700, reasoning: 30, cache: { read: 100, write: 20 } }
    const acc = tokenAccounting([history, last], (id) => parts[id] ?? [], undefined, {
      session: { tokens, cost: 3, request }, last, parts: parts.a,
    })
    // 历史输出密度为 8，输入密度为 2；游标覆盖的工具结果不能再加入 prepared input。
    expect(acc.ratio.output).toBe(8)
    expect(acc.step).toMatchObject({ input: 777, output: 20 })
    expect(acc.request).toEqual({ input: 777, output: 20, totalInput: 4777, totalOutput: 320, cost: 2 })
    expect(acc.session).toEqual({ input: 9000, output: 700, reasoning: 30, cacheRead: 100, cacheWrite: 20, cost: 3 })
    const native = { ...history, tokens: { input: 400, output: 80, reasoning: 20, cache: { read: 0, write: 0 } } }
    const calibrated = tokenAccounting([native, last], (id) => id === "old" ? parts.old.slice(0, 1) : parts.a,
      undefined, { session: { tokens, request }, last, parts: parts.a })
    expect(calibrated.ratio.output).toBe(8)
    expect(calibrated.request.totalOutput).toBe(320)
  })
})
