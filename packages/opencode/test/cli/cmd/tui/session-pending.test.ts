import { describe, expect, test } from "bun:test"
import type { AssistantMessage, Message } from "@opencode-ai/sdk/v2"
import {
  hasStreamingAssistant,
  pendingAssistantID,
  shouldCullSessionViewport,
  shouldRefreshStaleBusyStatus,
} from "../../../../src/cli/cmd/tui/util/session-pending"

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
})
