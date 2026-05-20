import type { Message, SessionStatus } from "@opencode-ai/sdk/v2"

type SessionViewportMessage = {
  role?: string
  type?: string
  time: {
    created: number
    completed?: number
  }
}

type SessionViewportState = {
  stuckToBottom?: boolean
}

export function hasStreamingAssistant(messages: Message[]) {
  return messages.some((message) => message.role === "assistant" && !message.time.completed)
}

export function shouldCullSessionViewport(
  messages: readonly SessionViewportMessage[],
  state: SessionViewportState = {},
) {
  // Keep the hot sticky-bottom streaming path culled, but let off-screen
  // streaming code blocks continue measuring when the user scrolls into history.
  if (!messages.some(isStreamingViewportAssistant)) return true
  return state.stuckToBottom ?? true
}

function isStreamingViewportAssistant(message: SessionViewportMessage) {
  return (message.role ?? message.type) === "assistant" && !message.time.completed
}

export function pendingAssistantID(messages: Message[], status: SessionStatus | undefined) {
  if (!status || status.type === "idle") return undefined
  return messages.findLast((message) => message.role === "assistant" && !message.time.completed)?.id
}

export function shouldRefreshStaleBusyStatus(messages: Message[], status: SessionStatus | undefined) {
  // A busy status with no open assistant stream usually means the SSE update
  // was missed while SQLite already has the completed message. Force one DB
  // refresh instead of keeping the prompt disabled indefinitely.
  return status?.type === "busy" && !hasStreamingAssistant(messages)
}
