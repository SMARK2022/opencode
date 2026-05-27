import { describe, expect, test } from "bun:test"
import type { AssistantMessage, Message, UserMessage } from "@opencode-ai/sdk/v2"
import {
  activeTurnDuration,
  assistantTurnDuration,
  hasStreamingAssistant,
  pendingAssistantIndex,
  shouldRefreshStaleBusyStatus,
} from "../../src/util/session-pending"

const user = (id: string, created: number): UserMessage => ({
  id,
  sessionID: "ses_test",
  role: "user",
  time: { created },
  agent: "build",
  model: { providerID: "provider", modelID: "model" },
})

const assistant = (id: string, completed?: number, parentID = "msg_user", finish?: AssistantMessage["finish"]): AssistantMessage => ({
  id,
  sessionID: "ses_test",
  role: "assistant",
  time: { created: 1, completed },
  parentID,
  modelID: "model",
  providerID: "provider",
  finish,
  mode: "build",
  agent: "build",
  path: { cwd: "/tmp", root: "/tmp" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
})

describe("session pending helpers", () => {
  test("finds the active assistant only while the session is non-idle", () => {
    const messages: Message[] = [assistant("done", 2), assistant("open")]

    expect(hasStreamingAssistant(messages)).toBe(true)
    // pending 契约为 messages 数组索引（UserMessage 侧按 index 比较），而非消息 id
    expect(pendingAssistantIndex(messages, { type: "busy" })).toBe(1)
    expect(pendingAssistantIndex(messages, { type: "idle" })).toBeUndefined()
  })

  test("refreshes stale busy state when no assistant is streaming", () => {
    // busy 无流式是 SSE 丢失的唯一信号；idle 恒不触发强刷
    expect(shouldRefreshStaleBusyStatus([assistant("done", 2)], { type: "busy" })).toBe(true)
    expect(shouldRefreshStaleBusyStatus([assistant("open")], { type: "busy" })).toBe(false)
    expect(shouldRefreshStaleBusyStatus([assistant("done", 2)], { type: "idle" })).toBe(false)
  })

  // #243：耗时口径只从 transcript 时间戳推导，start 边界不依赖本地计时器
  test("derives completed assistant turn duration from the parent user timestamp", () => {
    const reply = assistant("reply", 6_500)

    expect(assistantTurnDuration([user("msg_user", 1_000), reply], reply)).toBe(5_500)
  })

  // now 参数模拟刷新时钟注入——流式 assistant 无 completed 时以 now 为临时终点
  test("derives streaming assistant turn duration from the parent user timestamp and current time", () => {
    const reply = assistant("reply")

    expect(assistantTurnDuration([user("msg_user", 1_000), reply], reply, 6_200)).toBe(5_200)
  })

  test("returns no assistant turn duration when the parent user is unavailable", () => {
    const reply = assistant("reply", 6_500, "missing_user")

    expect(assistantTurnDuration([user("msg_user", 1_000), reply], reply)).toBe(0)
  })

  test("clamps assistant turn duration when persisted timestamps arrive out of order", () => {
    const reply = assistant("reply", 500)

    expect(assistantTurnDuration([user("msg_user", 1_000), reply], reply)).toBe(0)
  })

  // 最新 user 之前已有 terminal assistant：active 起点切换到最新 user，上一轮不累计
  test("derives active turn duration from the latest user before the assistant exists", () => {
    const messages: Message[] = [user("first", 1_000), assistant("done", 2_000, "first", "stop"), user("latest", 5_000)]

    expect(activeTurnDuration(messages, { type: "busy" }, 7_000)).toBe(2_000)
  })

  test("derives active turn duration from the latest user's streaming assistant", () => {
    const messages: Message[] = [
      user("first", 1_000),
      assistant("done", 2_000, "first", "stop"),
      user("latest", 3_000),
      assistant("open", undefined, "latest"),
    ]

    expect(activeTurnDuration(messages, { type: "busy" }, 8_000)).toBe(5_000)
  })

  // tool-calls finish 表示回合未终态：计时必须穿过工具阶段继续
  test("keeps active duration running through tool-call continuation turns", () => {
    const messages: Message[] = [user("msg_user", 1_000), assistant("tools", 2_500, "msg_user", "tool-calls")]

    expect(activeTurnDuration(messages, { type: "busy" }, 6_000)).toBe(5_000)
  })

  test("keeps active duration running while the session is retrying", () => {
    const messages: Message[] = [user("msg_user", 1_000), assistant("open", undefined, "msg_user")]

    expect(activeTurnDuration(messages, { type: "retry", attempt: 2, message: "quota", next: 6_000 }, 4_500)).toBe(3_500)
  })

  // stale busy：status 未回落但 assistant 已 terminal——不应显示运行耗时
  test("returns no active duration for stale busy status after a terminal assistant finish", () => {
    const messages: Message[] = [user("msg_user", 1_000), assistant("done", 6_000, "msg_user", "stop")]

    expect(activeTurnDuration(messages, { type: "busy" }, 8_000)).toBe(0)
  })

  test("returns no active duration while the session is idle", () => {
    const messages: Message[] = [user("msg_user", 1_000), assistant("open", undefined, "msg_user")]

    expect(activeTurnDuration(messages, { type: "idle" }, 8_000)).toBe(0)
  })
})
