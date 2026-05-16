import type { Message, SessionStatus } from "@opencode-ai/sdk/v2"

export function hasStreamingAssistant(messages: Message[]) {
  return messages.some((message) => message.role === "assistant" && !message.time.completed)
}

export function pendingAssistantIndex(messages: Message[], status: SessionStatus | undefined) {
  // 会话空闲时不查找待处理消息，避免不必要的重渲染
  if (!status || status.type === "idle") return undefined
  // 以最后一条已完成 assistant 为游标，只认其后的未完成 assistant，
  // 防止重放历史时误把旧消息标记为待处理
  const completed = messages.findLastIndex((message) => message.role === "assistant" && message.time.completed)
  const pending = messages.findLastIndex(
    (message, index) => index > completed && message.role === "assistant" && !message.time.completed,
  )
  return pending === -1 ? undefined : pending
}

export function shouldRefreshStaleBusyStatus(messages: Message[], status: SessionStatus | undefined) {
  // busy 但没有打开的 assistant 流，通常意味着 SSE 更新丢失而 DB 已有完成消息；
  // 强制一次全量刷新，而不是让 prompt 因状态陈旧被无限禁用
  return status?.type === "busy" && !hasStreamingAssistant(messages)
}
