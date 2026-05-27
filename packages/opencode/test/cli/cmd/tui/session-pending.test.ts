import { describe, expect, test } from "bun:test"
import type { AssistantMessage, Message, UserMessage } from "@opencode-ai/sdk/v2"
import {
  activeTurnDuration,
  assistantTurnDuration,
  hasStreamingAssistant,
  pendingAssistantID,
  shouldCullSessionViewport,
  shouldRefreshStaleBusyStatus,
} from "../../../../src/cli/cmd/tui/util/session-pending"

const user = (id: string, created: number): UserMessage => ({
  id,
  sessionID: "ses_test",
  role: "user",
  time: { created },
  agent: "build",
  model: { providerID: "provider", modelID: "model" },
})

const assistant = (
  id: string,
  completed?: number,
  parentID = "msg_user",
  finish?: AssistantMessage["finish"],
): AssistantMessage => ({
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
    expect(pendingAssistantID(messages, { type: "busy" })).toBe("open")
    expect(pendingAssistantID(messages, { type: "idle" })).toBeUndefined()
  })

  test("refreshes stale busy state when no assistant is streaming", () => {
    expect(shouldRefreshStaleBusyStatus([assistant("done", 2)], { type: "busy" })).toBe(true)
    expect(shouldRefreshStaleBusyStatus([assistant("open")], { type: "busy" })).toBe(false)
    expect(shouldRefreshStaleBusyStatus([assistant("done", 2)], { type: "idle" })).toBe(false)
  })

  test("keeps session viewport culling enabled while an assistant message streams", () => {
    expect(shouldCullSessionViewport([assistant("open")])).toBe(true)
  })

  test("pauses session viewport culling while streaming away from sticky bottom", () => {
    expect(shouldCullSessionViewport([assistant("open")], { stuckToBottom: false })).toBe(false)
  })

  test("keeps session viewport culling enabled after the assistant message completes", () => {
    expect(shouldCullSessionViewport([assistant("done", 2)])).toBe(true)
  })

  test("derives completed assistant turn duration from the parent user timestamp", () => {
    const reply = assistant("reply", 6_500)

    expect(assistantTurnDuration([user("msg_user", 1_000), reply], reply)).toBe(5_500)
  })

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

  test("derives active turn duration from the latest user before the assistant exists", () => {
    const messages: Message[] = [
      user("first", 1_000),
      assistant("done", 2_000, "first", "stop"),
      user("latest", 5_000),
    ]

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

  test("keeps active duration running through tool-call continuation turns", () => {
    const messages: Message[] = [
      user("msg_user", 1_000),
      assistant("tools", 2_500, "msg_user", "tool-calls"),
    ]

    expect(activeTurnDuration(messages, { type: "busy" }, 6_000)).toBe(5_000)
  })

  test("keeps active duration running while the session is retrying", () => {
    const messages: Message[] = [user("msg_user", 1_000), assistant("open", undefined, "msg_user")]

    expect(activeTurnDuration(messages, { type: "retry", attempt: 2, message: "quota", next: 6_000 }, 4_500)).toBe(
      3_500,
    )
  })

  test("returns no active duration for stale busy status after a terminal assistant finish", () => {
    const messages: Message[] = [
      user("msg_user", 1_000),
      assistant("done", 6_000, "msg_user", "stop"),
    ]

    expect(activeTurnDuration(messages, { type: "busy" }, 8_000)).toBe(0)
  })

  test("returns no active duration while the session is idle", () => {
    const messages: Message[] = [user("msg_user", 1_000), assistant("open", undefined, "msg_user")]

    expect(activeTurnDuration(messages, { type: "idle" }, 8_000)).toBe(0)
  })
})
