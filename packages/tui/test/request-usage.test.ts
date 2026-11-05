import { expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { createStore } from "solid-js/store"
import type { AssistantMessage, SessionRequestUsageGetResponse } from "@opencode-ai/sdk/v2"
import { createRequestUsage } from "../src/routes/session/request-usage"
import { formatUsageStats } from "../src/util/presentation"

test("shares mounted request totals and refreshes only the changed request", async () => {
  const calls: string[] = []
  const assistant = (id: string, parentID: string): AssistantMessage => ({
    id,
    parentID,
    sessionID: "session",
    role: "assistant",
    agent: "plan",
    mode: "plan",
    modelID: "model",
    providerID: "provider",
    path: { cwd: ".", root: "." },
    time: { created: 1, completed: 2 },
    finish: "stop",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  })
  const total: SessionRequestUsageGetResponse = {
    sessionID: "session",
    requestID: "one",
    rootRequestID: "one",
    source: "prompt",
    status: "completed",
    agent: "plan",
    model: { providerID: "provider", modelID: "model" },
    // 账本含分页外的助手；不能被窗口内消息的零统计覆盖。
    assistantCount: 20,
    stepCount: 20,
    cost: 0.25,
    tokens: { input: 12300, output: 970, reasoning: 30, cache: { read: 100, write: 50 }, total: 13450 },
    time: { created: 1, updated: 2, completed: 2 },
  }
  const state = createRoot((dispose) => {
    const [messages, setMessages] = createStore([assistant("a", "one"), assistant("b", "one"), assistant("c", "two")])
    const [mounted, setMounted] = createSignal(new Set(["a", "b"]))
    const usage = createRequestUsage({
      messages: () => messages,
      mounted: (id) => mounted().has(id),
      get: async (sessionID, requestID) => {
        calls.push(`${sessionID}:${requestID}`)
        return { ...total, sessionID, requestID }
      },
    })
    return { dispose, messages, setMessages, setMounted, usage }
  })
  try {
    await Bun.sleep(0)
    expect(calls).toEqual(["session:one"])
    const first = state.usage().get("one")!
    const usage = first()!
    expect(
      formatUsageStats({
        input: Number(usage.tokens.input),
        output: Number(usage.tokens.output) + Number(usage.tokens.reasoning),
        cost: Number(usage.cost),
      }),
    ).toBe("↑ 12.3K ↓ 1.0K · $0.25")
    // 完成态 footer 的资源不依赖流式正文或未挂载请求的消息更新。
    state.setMessages(2, "time", "completed", 3)
    state.setMessages(0, "tokens", "output", 10)
    await Bun.sleep(0)
    expect(calls).toEqual(["session:one"])
    state.setMounted(new Set(["a", "b", "c"]))
    await Bun.sleep(0)
    expect(calls).toEqual(["session:one", "session:two"])
    expect(state.usage().get("one")).toBe(first)
    state.setMessages(1, "time", "completed", 4)
    await Bun.sleep(0)
    expect(calls).toEqual(["session:one", "session:two", "session:one"])
    state.setMounted(new Set(["c"]))
    expect([...state.usage().keys()]).toEqual(["two"])
    state.setMessages(1, "time", "completed", 5)
    await Bun.sleep(0)
    expect(calls).toHaveLength(3)
    // 路由切换时旧资源应离开 owner，不能把上个 Session 的统计留给新页面。
    state.setMessages([{ ...assistant("d", "three"), sessionID: "next" }])
    state.setMounted(new Set(["d"]))
    await Bun.sleep(0)
    expect([...state.usage().keys()]).toEqual(["three"])
    expect(calls.at(-1)).toBe("next:three")
  } finally {
    state.dispose()
  }
})
