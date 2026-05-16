import { describe, expect, test } from "bun:test"
import type { AssistantMessage, Message } from "@opencode-ai/sdk/v2"
import { hasStreamingAssistant, pendingAssistantIndex, shouldRefreshStaleBusyStatus } from "../../src/util/session-pending"

const assistant = (id: string, completed?: number): AssistantMessage => ({
  id,
  sessionID: "ses_test",
  role: "assistant",
  time: { created: 1, completed },
  parentID: "msg_user",
  modelID: "model",
  providerID: "provider",
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
})
