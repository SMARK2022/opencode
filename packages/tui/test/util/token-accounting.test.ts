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
    const msgs = [
      userMsg("u1"),
      assistantMsg("a1", "u1", { input: 10, output: 20, reasoning: 0, cache: { read: 0, write: 0 } }, 100),
    ]
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
    expect(acc.ratio.input).toBe(8)
  })

  // #124：streaming 期间 step-start breakdown 可用
  test("breakdown available from step-start during streaming (before step-finish)", () => {
    const msgs = [
      { id: "u1", role: "user", time: { created: 0 } },
      {
        id: "a1",
        role: "assistant",
        parentID: "u1",
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: 1 },
      },
    ]
    const parts: Record<string, any[]> = {
      a1: [
        {
          id: "ss",
          type: "step-start",
          inputChars: 1000,
          inputTokens: 400,
          inputBreakdown: {
            system: 200,
            instructions: 100,
            skills: 50,
            tools: 50,
            messages: {
              userText: 100,
              assistantText: 80,
              reasoning: 0,
              toolInput: 40,
              toolOutput: 80,
              attachments: 100,
              total: 400,
            },
          },
        },
      ],
    }
    const acc = tokenAccounting(msgs as any, (id) => parts[id] ?? [])
    expect(acc.breakdown).not.toBeNull()
    // #124：200/1000 * 400 = 80
    expect(acc.breakdown!.system).toBe(80)
  })

  // #127：assistant 消息级 pending 快照在 step-start 前即可分配 breakdown
  test("breakdown available from assistant message pending snapshot before step-start", () => {
    const msgs = [
      { id: "u1", role: "user", time: { created: 0 } },
      {
        id: "a1",
        role: "assistant",
        parentID: "u1",
        cost: 0,
        tokens: { input: 400, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: 1 },
        inputEstimate: {
          bodyChars: 1000,
          input: 400,
          confirmed: false,
          inputBreakdown: {
            system: 200,
            instructions: 100,
            skills: 50,
            tools: 50,
            messages: {
              userText: 100,
              assistantText: 80,
              reasoning: 0,
              toolInput: 40,
              toolOutput: 80,
              attachments: 100,
              total: 400,
            },
          },
        },
      },
    ]
    const acc = tokenAccounting(msgs as any, () => [])
    expect(acc.breakdown).not.toBeNull()
    // #127：200/1000 * 400 = 80
    expect(acc.breakdown!.system).toBe(80)
    const zero = { ...msgs[1], inputEstimate: { ...msgs[1].inputEstimate!, input: 0, bodyChars: 0 } }
    const cleared = tokenAccounting([msgs[0], zero], () => [])
    expect(cleared.breakdown!.system).toBe(0)
  })

  // #127：confirmed 时 assistantText = input 份额 + live visible
  test("confirmed breakdown adds input context assistantText to live visible output", () => {
    const msgs = [
      { id: "u1", role: "user", time: { created: 0 } },
      {
        id: "a1",
        role: "assistant",
        parentID: "u1",
        cost: 0,
        tokens: { input: 500, output: 200, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: 1, completed: 2 },
      },
    ]
    const parts: Record<string, any[]> = {
      a1: [
        {
          id: "ss",
          type: "step-start",
          inputChars: 10000,
          inputTokens: 500,
          inputBreakdown: {
            system: 1000,
            instructions: 1000,
            skills: 500,
            tools: 500,
            messages: {
              userText: 5000,
              assistantText: 300,
              reasoning: 0,
              toolInput: 200,
              toolOutput: 500,
              attachments: 0,
              total: 6000,
            },
          },
        },
        { id: "t1", type: "text", text: "x".repeat(300) },
        {
          id: "sf",
          type: "step-finish",
          tokens: { input: 500, output: 200, reasoning: 0, cache: { read: 0, write: 0 } },
          inputChars: 10000,
          inputTokens: 500,
          inputBreakdown: {
            system: 1000,
            instructions: 1000,
            skills: 500,
            tools: 500,
            messages: {
              userText: 5000,
              assistantText: 300,
              reasoning: 0,
              toolInput: 200,
              toolOutput: 500,
              attachments: 0,
              total: 6000,
            },
          },
        },
      ],
    }
    const acc = tokenAccounting(msgs as any, (id) => parts[id] ?? [])
    expect(acc.breakdown).not.toBeNull()
    // #127：15 + 200 = 215；toolCalls 仅 input 份额 10
    expect(acc.breakdown!.assistantText).toBe(215)
    expect(acc.breakdown!.toolCalls).toBe(10)
    const unfinished = tokenAccounting(
      msgs.map((msg) => (msg.role === "assistant" ? { ...msg, time: { created: 1 } } : msg)),
      (id) => parts[id] ?? [],
    )
    expect(unfinished.breakdown!.assistantText).toBe(215)
  })

  // #127：streaming 时 live text 估算叠加 input assistant 份额
  test("streaming breakdown adds input context to live text estimate", () => {
    const msgs = [
      { id: "u1", role: "user", time: { created: 0 } },
      {
        id: "a1",
        role: "assistant",
        parentID: "u1",
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: 1 },
      },
    ]
    const parts: Record<string, any[]> = {
      a1: [
        {
          id: "ss",
          type: "step-start",
          inputChars: 1000,
          inputTokens: 400,
          inputBreakdown: {
            system: 200,
            instructions: 100,
            skills: 50,
            tools: 50,
            messages: {
              userText: 100,
              assistantText: 80,
              reasoning: 0,
              toolInput: 40,
              toolOutput: 80,
              attachments: 100,
              total: 400,
            },
          },
        },
        { id: "tx", type: "text", text: "hello world" },
      ],
    }
    const acc = tokenAccounting(msgs as any, (id) => parts[id] ?? [])
    // #127：input 32 + live 3 = 35；toolCalls input 16
    expect(acc.breakdown!.assistantText).toBe(35)
    expect(acc.breakdown!.toolCalls).toBe(16)
    const next = tokenAccounting(msgs, (id) =>
      id === "a1"
        ? [
            {
              ...parts.a1[0],
              id: "00-finish",
              type: "step-finish",
              tokens: { input: 500, output: 200, reasoning: 0, cache: { read: 0, write: 0 } },
            },
            ...parts.a1,
          ]
        : [],
    )
    expect(next.breakdown!.system).toBe(80)
    expect(next.breakdown!.assistantText).toBe(35)
  })
  // #175：media.tokens=10 固定；system/user 经 textDenom 为 242
  test("breakdown allocates media tokens outside text character ratio", () => {
    const msgs = [userMsg("1"), assistantMsg("2", "1", undefined, 10)]
    const getParts = (_id: string) => [
      {
        ...stepFinish("sf", { input: 500, output: 200, reasoning: 0, cache: { read: 0, write: 0 } }, 9_500),
        inputBreakdown: {
          system: 1_000,
          instructions: 0,
          skills: 0,
          tools: 0,
          messages: {
            userText: 1_000,
            assistantText: 0,
            reasoning: 0,
            toolInput: 0,
            toolOutput: 0,
            attachments: 7_500,
            total: 8_500,
          },
          media: {
            rawChars: 7_500,
            textChars: 25,
            tokens: 10,
            count: 1,
            imageTokens: 10,
            pdfTokens: 0,
            otherTokens: 0,
          },
        },
      },
    ]
    const acc = tokenAccounting(msgs as any, getParts)
    // #175：固定侧 10，不按 7500 字符分配
    expect(acc.breakdown?.attachments).toBe(10)
    // #175：textDenom 算法回归锁：system 份额 242
    expect(acc.breakdown?.system).toBe(242)
    expect(acc.breakdown?.userMessages).toBe(242)
  })

  test("durable projection survives an empty visible history and preserves prepared input", () => {
    const tokens = { input: 9000, output: 700, reasoning: 30, cache: { read: 100, write: 20 } }
    const snapshot = (request: SessionRequestUsage) =>
      tokenAccounting([], () => [], undefined, {
        session: { tokens, request },
        last: undefined,
        parts: [],
      })
    const request = { messageID: "u", input: 4000, output: 30, stepInput: 1000, stepOutput: 10, cost: 2 }
    // 窗口没有旧消息也不能截断持久累计，未记录会话费用时沿用零值。
    const confirmed = snapshot(request)
    expect(confirmed.request).toEqual({
      input: 1000,
      output: 10,
      totalInput: 4000,
      totalInputPure: 0,
      totalOutput: 30,
      cost: 2,
    })
    expect(confirmed.session).toEqual({
      input: 9000,
      output: 700,
      reasoning: 30,
      cacheRead: 100,
      cacheWrite: 20,
      cost: 0,
    })
    // 首包前由服务端发布估算；零估算同样权威，不能借上一个请求的窗口补值。
    const prepared = {
      ...request,
      stepInput: 0,
      stepOutput: 0,
      estimatedInput: 777,
      model: { providerID: "p", modelID: "m", contextLimit: 2000 },
    }
    expect(snapshot(prepared).request).toEqual({
      input: 777,
      output: 0,
      totalInput: 4777,
      totalInputPure: 0,
      totalOutput: 30,
      cost: 2,
    })
    expect(snapshot(prepared).contextPercent).toBe(39)
    expect(snapshot({ ...prepared, estimatedInput: 0 }).request.totalInput).toBe(4000)
    expect(snapshot(prepared).breakdown).toBeNull()
  })

  test("projection calibrates live output independently and preserves durable totals", () => {
    const history = assistantMsg("old", "u", undefined, 1)
    const last: AssistantMessage = {
      ...assistantMsg("a", "u"),
      sessionID: "s",
      agent: "build",
      mode: "build",
      providerID: "p",
      modelID: "m",
      path: { cwd: "/", root: "/" },
      inputEstimate: { input: 777, bodyChars: 1554, confirmed: false, charsPerToken: 2, afterPartID: "02-tool" },
    }
    const parts: Record<string, Part[]> = {
      old: [
        { id: "01-text", sessionID: "s", messageID: "old", type: "text", text: "x".repeat(800) },
        {
          ...stepFinish("01-finish", { input: 400, output: 80, reasoning: 20, cache: { read: 0, write: 0 } }, 800),
          sessionID: "s",
          messageID: "old",
          reason: "stop",
          cost: 0,
        },
      ],
      a: [
        {
          id: "02-tool",
          sessionID: "s",
          messageID: "a",
          type: "tool",
          callID: "covered",
          tool: "read",
          state: {
            status: "completed",
            input: {},
            output: "x".repeat(80),
            title: "read",
            metadata: {},
            time: { start: 1, end: 2 },
          },
        },
        { id: "03-text", sessionID: "s", messageID: "a", type: "text", text: "x".repeat(80) },
        {
          id: "04-reason",
          sessionID: "s",
          messageID: "a",
          type: "reasoning",
          text: "x".repeat(40),
          time: { start: 0, end: 1 },
        },
        {
          id: "05-tool",
          sessionID: "s",
          messageID: "a",
          type: "tool",
          callID: "live",
          tool: "read",
          state: { status: "pending", input: {}, raw: "x".repeat(40) },
        },
      ],
    }
    const request: SessionRequestUsage = {
      messageID: "u",
      assistantID: "a",
      input: 4000,
      output: 300,
      cost: 2,
      stepInput: 0,
      stepOutput: 0,
      estimatedInput: 777,
      inputEstimate: last.inputEstimate,
      model: { providerID: "p", modelID: "m", contextLimit: 2000 },
    }
    const tokens = { input: 9000, output: 700, reasoning: 30, cache: { read: 100, write: 20 } }
    const acc = tokenAccounting([history, last], (id) => parts[id] ?? [], undefined, {
      session: { tokens, cost: 3, request },
      last,
      parts: parts.a,
    })
    // 密度仍分别为 8/2，游标覆盖结果不重复计入；窗口缺少 parent user 时，不从含 cache 的投影反推 pure input。
    expect(acc.ratio.output).toBe(8)
    expect(acc.step).toMatchObject({ input: 777, output: 20 })
    expect(acc.request).toEqual({
      input: 777,
      output: 20,
      totalInput: 4777,
      totalInputPure: 0,
      totalOutput: 320,
      cost: 2,
    })
    expect(acc.session).toEqual({ input: 9000, output: 700, reasoning: 30, cacheRead: 100, cacheWrite: 20, cost: 3 })
    const native = { ...history, tokens: { input: 400, output: 80, reasoning: 20, cache: { read: 0, write: 0 } } }
    const calibrated = tokenAccounting(
      [native, last],
      (id) => (id === "old" ? parts.old.slice(0, 1) : parts.a),
      undefined,
      { session: { tokens, request }, last, parts: parts.a },
    )
    expect(calibrated.ratio.output).toBe(8)
    expect(calibrated.request.totalOutput).toBe(320)
  })

  // #238：in-flight 上传估算在整个正常生命周期内只计一次
  test("request total counts the in-flight upload estimate once across the normal lifecycle", () => {
    // 正常发送路径会先把 daemon 的 upload estimate 写到 assistant message，
    // 然后依次出现 step-start、step-finish，最后 message.completed 落库。
    // request.totalInput 必须表示“已确认步骤 + 当前 in-flight step”，同一轮上传
    // 在完成前不能同时作为历史累计和当前步骤各算一次。
    const sf = (input: number, output = 0, reasoning = 0, cacheRead = 0, cacheWrite = 0, inputChars?: number) =>
      // 包装目标版 stepFinish(id, tokens, inputChars) 签名，保持用例的位置参数形态与 source 一致
      stepFinish("sf", { input, output, reasoning, cache: { read: cacheRead, write: cacheWrite } }, inputChars)
    const tokens = { input: 100_000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
    const cases = [
      {
        // 场景一：估算已写但任何 parts 都未到达——此时 totalInput 只来自估算本身
        name: "pending assistant message",
        msg: assistantMsg("2", "1", tokens),
        parts: [] as any[],
        confirmed: false,
      },
      {
        // 场景二：step-start 到达——估算转为 step 上下文，仍不得重复进入 request 总计
        name: "streaming after step-start",
        msg: assistantMsg("2", "1", tokens),
        parts: [{ id: "ss", type: "step-start", inputTokens: 100_000, inputChars: 400_000 }] as any[],
        confirmed: false,
      },
      {
        // 场景三：provider 确认值已到但 message 未 completed——确认值替换估算成为 step.input
        name: "provider usage received before message completion",
        msg: assistantMsg("2", "1", tokens),
        parts: [
          { id: "ss", type: "step-start", inputTokens: 100_000, inputChars: 400_000 },
          sf(100_000, 0, 0, 0, 0, 400_000),
        ] as any[],
        confirmed: false,
      },
      {
        // 场景四：completed 落库——步骤转入 confirmed 历史，不改变 request 总计
        name: "completed assistant message",
        msg: assistantMsg("2", "1", tokens, 10),
        parts: [
          { id: "ss", type: "step-start", inputTokens: 100_000, inputChars: 400_000 },
          sf(100_000, 0, 0, 0, 0, 400_000),
        ] as any[],
        confirmed: true,
      },
    ]

    for (const item of cases) {
      const acc = tokenAccounting([userMsg("1"), item.msg] as any, () => item.parts)
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
      ] as any,
      (id) => (id === "2" ? [sf(50_000, 0, 0, 0, 0, 200_000)] : []),
    )
    expect(acc.step.input, "confirmed history plus in-flight assistant").toBe(100_000)
    expect(acc.request.totalInput, "confirmed history plus in-flight assistant").toBe(150_000)
  })

  // #238：无 step-finish 的旧消息保留 output/cost 可见性，input 只计一次
  // 目标版 helper 无 cost 字段，用展开覆盖模拟带 cost 的历史消息
  test("latest message-token fallback keeps output and cost while input is counted once", () => {
    // 部分 completed 或历史 assistant 消息可能只有 message.tokens 而没有
    // step-finish parts。input fallback 仍须避免活跃步骤双算；output 与 cost
    // 在该形态下没有等价的 step-finish 重复来源，必须继续进入 request 总计。
    const msg = {
      ...assistantMsg("2", "1", { input: 10, output: 20, reasoning: 5, cache: { read: 2, write: 3 } }, 10),
      cost: 0.5,
    }
    const acc = tokenAccounting([userMsg("1"), msg] as any, () => [])

    expect(acc.step.input).toBe(15)
    expect(acc.request.totalInput).toBe(15)
    expect(acc.request.totalOutput).toBe(25)
    expect(acc.request.cost).toBe(0.5)
  })

  // #238：step-finish 先于 message tokens 更新时，request 总计以 provider 值为准
  test("request total uses provider input when step-finish arrives before message token update", () => {
    // updatePart(step-finish) 与 updateMessage(tokens) 是两个独立同步事件；
    // UI 可能短暂看到「已确认 provider usage + assistant 仍带旧上传估算」。
    // 该窗口内已确认 step-finish 值是权威值，估算与实际值的差不是 pending context。
    const msg = assistantMsg("2", "1", { input: 120, output: 0, reasoning: 0, cache: { read: 0, write: 0 } })
    const acc = tokenAccounting([userMsg("1"), msg] as any, () => [
      { id: "ss", type: "step-start", inputTokens: 120, inputChars: 480 },
      sf2(100, 0, 0, 0, 0, 400),
    ])

    expect(acc.step.input).toBe(120)
    expect(acc.request.totalInput).toBe(100)
  })

  function sf2(input: number, output = 0, reasoning = 0, cacheRead = 0, cacheWrite = 0, inputChars?: number) {
    return stepFinish("sf", { input, output, reasoning, cache: { read: cacheRead, write: cacheWrite } }, inputChars)
  }
})
