import { describe, expect, test } from "bun:test"
import { tokenAccounting } from "@/token/accounting"

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

function stepStart(inputTokens: number, inputChars?: number) {
  return {
    id: "ss", sessionID: "s", messageID: "m2", type: "step-start",
    inputTokens,
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

  test("request total counts the in-flight upload estimate once across the normal lifecycle", () => {
    // 正常发送路径会先把 daemon 的 upload estimate 写到 assistant message，
    // 然后依次出现 step-start、step-finish，最后 message.completed 落库。
    // request.totalInput 必须表示“已确认步骤 + 当前 in-flight step”，同一轮上传
    // 在完成前不能同时作为历史累计和当前步骤各算一次。
    const tokens = { input: 100_000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
    const cases = [
      {
        name: "pending assistant message",
        msg: assistantMsg("2", "1", tokens),
        parts: [],
        confirmed: false,
      },
      {
        name: "streaming after step-start",
        msg: assistantMsg("2", "1", tokens),
        parts: [stepStart(100_000, 400_000)],
        confirmed: false,
      },
      {
        name: "provider usage received before message completion",
        msg: assistantMsg("2", "1", tokens),
        parts: [stepStart(100_000, 400_000), stepFinish(100_000, 0, 0, 0, 0, 400_000)],
        confirmed: false,
      },
      {
        name: "completed assistant message",
        msg: assistantMsg("2", "1", tokens, 10),
        parts: [stepStart(100_000, 400_000), stepFinish(100_000, 0, 0, 0, 0, 400_000)],
        confirmed: true,
      },
    ]

    for (const item of cases) {
      const acc = tokenAccounting([userMsg("1"), item.msg], () => item.parts)
      expect(acc.step.input, item.name).toBe(100_000)
      expect(acc.step.confirmed, item.name).toBe(item.confirmed)
      expect(acc.request.totalInput, item.name).toBe(100_000)
    }

    // 多个 assistant 可以归属于同一个 user request；修复 in-flight 双算时，
    // 仍需保留已确认历史步骤，否则括号累计值会从“双算”退化为“漏算”。
    const acc = tokenAccounting(
      [
        userMsg("1"),
        assistantMsg("2", "1", { input: 50_000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, 5),
        assistantMsg("3", "1", tokens),
      ],
      (id) => (id === "2" ? [stepFinish(50_000, 0, 0, 0, 0, 200_000)] : []),
    )
    expect(acc.step.input, "confirmed history plus in-flight assistant").toBe(100_000)
    expect(acc.request.totalInput, "confirmed history plus in-flight assistant").toBe(150_000)
  })

  test("latest message-token fallback keeps output and cost while input is counted once", () => {
    // Some completed or legacy assistant messages can have message.tokens without
    // step-finish parts.  The input fallback must still avoid the active-step
    // double count, but output and cost have no equivalent step-finish duplicate
    // in this shape and must remain visible to request totals.
    const msg = {
      ...assistantMsg("2", "1", { input: 10, output: 20, reasoning: 5, cache: { read: 2, write: 3 } }, 10),
      cost: 0.5,
    }
    const acc = tokenAccounting([userMsg("1"), msg], () => [])

    expect(acc.step.input).toBe(15)
    expect(acc.request.totalInput).toBe(15)
    expect(acc.request.totalOutput).toBe(25)
    expect(acc.request.cost).toBe(0.5)
  })

  test("request total uses provider input when step-finish arrives before message token update", () => {
    // updatePart(step-finish) and updateMessage(tokens) are separate sync events;
    // the UI can briefly see confirmed provider usage while the assistant message
    // still carries the earlier upload estimate.  In that window, the confirmed
    // step-finish value is authoritative and the estimate/actual delta is not
    // pending context.
    const msg = assistantMsg("2", "1", { input: 120, output: 0, reasoning: 0, cache: { read: 0, write: 0 } })
    const acc = tokenAccounting([userMsg("1"), msg], () => [
      stepStart(120, 480),
      stepFinish(100, 0, 0, 0, 0, 400),
    ])

    expect(acc.step.input).toBe(120)
    expect(acc.request.totalInput).toBe(100)
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
    // Shared input learning clamps unusually high densities so one old sample
    // cannot make TUI pending estimates diverge from daemon upload estimates.
    const getParts = (_id: string) => [stepFinish(100, 200, 0, 5, 5, 1000)]
    const acc = tokenAccounting(msgs, getParts)
    expect(acc.ratio.input).toBe(8)
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
    // input context assistantText=round(500*300/10000)=15, no output parts → live visible=200
    // input context toolInput=round(500*200/10000)=10, no live tool output
    expect(bd.assistantText).toBe(215)
    expect(bd.toolCalls).toBe(10)
  })

  test("breakdown allocates media tokens outside text character ratio", () => {
    const msgs = [userMsg("1"), assistantMsg("2", "1", undefined, 10)]
    const getParts = (_id: string) => [{
      ...stepFinish(500, 200, 0, 0, 0, 9_500),
      inputBreakdown: {
        system: 1_000, instructions: 0, skills: 0, tools: 0,
        messages: { userText: 1_000, assistantText: 0, reasoning: 0, toolInput: 0, toolOutput: 0, attachments: 7_500, total: 8_500 },
        media: { rawChars: 7_500, textChars: 25, tokens: 10, count: 1, imageTokens: 10, pdfTokens: 0, otherTokens: 0 },
      },
    }]
    const acc = tokenAccounting(msgs, getParts)

    expect(acc.breakdown?.attachments).toBe(10)
    expect(acc.breakdown?.system).toBe(242)
    expect(acc.breakdown?.userMessages).toBe(242)
  })

  test("breakdown available from step-start during streaming (before step-finish)", () => {
    // 模拟 daemon 写入的 step-start input snapshot；assistant 正在 streaming 中
    const msgs = [userMsg("1"), assistantMsg("2", "1", { input: 400, output: 0, reasoning: 0, cache: { read: 0, write: 0 } })]
    const getParts = (_id: string) => [
      {
        id: "ss", type: "step-start",
        inputChars: 1000,
        inputTokens: 400,
        inputBreakdown: {
          system: 300, instructions: 200, skills: 0, tools: 100,
          messages: { userText: 100, assistantText: 80, reasoning: 0, toolInput: 40, toolOutput: 80, attachments: 100, total: 400 },
        },
      },
      textPart("p1", "hello world"),
    ]
    const acc = tokenAccounting(msgs, getParts)
    expect(acc.breakdown).not.toBeNull()
    expect(acc.step.confirmed).toBe(false)
    // daemon inputTokens=400, inputChars=1000 → alloc = round(chars * 400/1000)
    expect(acc.breakdown!.system).toBe(120)
    expect(acc.breakdown!.instructions).toBe(80)
    expect(acc.breakdown!.tools).toBe(40)
    // input context assistantText=32, live text "hello world" 11 chars / outputRatio=4 → 3
    expect(acc.breakdown!.assistantText).toBe(35)
    // input context toolInput=16; no live tool-call output yet
    expect(acc.breakdown!.toolCalls).toBe(16)
  })
})
