import type { AssistantMessage, Message, SessionStatus, UserMessage } from "@opencode-ai/sdk/v2"

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

// 会话耗时只从 transcript 中已经持久化的消息时间戳推导：user.time.created
// 是 turn 的唯一开始边界，assistant.time.completed 是完成边界。TUI 的刷新
// tick 只能提供运行中的临时 end，不允许再维护独立 start time，否则 Prompt
// remount、SSE 重连或 retry 状态切换都会让左下角耗时和消息 footer 口径分叉。
export function assistantTurnDuration(messages: Message[], assistant: AssistantMessage, now?: number) {
  const end = assistant.time.completed ?? now
  if (end === undefined) return 0

  const user = messages.find((message): message is UserMessage => {
    return message.role === "user" && message.id === assistant.parentID
  })
  if (!user) return 0

  return durationSince(user.time.created, end)
}

// 当前活跃轮次的 (user, assistant) 对。是 footer usage、sidebar context 与左下角计时器
// 共用的解析口径，必须跳过尚未派生 assistant 的 queued orphan user——否则这些 widget
// 会在 orphan 窗口期（例如 TaskTool 后台注入 noReply prompt 在父会话 busy 期间持久化的
// user message）归零或漂移到错误的 user 时间戳。tokenAccounting 与 computeContextData
// 也通过同一口径锁定活跃 user，避免 request 累计和 model 解析落到 orphan 上。
export type ActiveTurnPair = { user: UserMessage; assistant: AssistantMessage | undefined }

export function activeTurnPair(messages: readonly Message[]): ActiveTurnPair | undefined {
  const latestAssistant = messages.findLast((message): message is AssistantMessage => message.role === "assistant")
  const user = latestAssistant
    ? // 有 assistant：以最新 assistant 的 parentID 锁定活跃 user，跳过其后未派生 assistant
      // 的 orphan user。不变量：成对场景下 latestAssistant.parentID === latestUser.id，
      // 因此与旧 findLast(role==="user") 完全等价，不改变任何既有行为。
      messages.findLast((message): message is UserMessage => message.role === "user" && message.id === latestAssistant.parentID)
    : // 无 assistant（首次 prompt 落库但 assistant 尚未创建的空窗期）：fallback 到最新 user，
      // 返回 assistant: undefined 让调用点维持既有的 fail-closed 显示语义。
      messages.findLast((message): message is UserMessage => message.role === "user")

  if (!user) return undefined
  return { user, assistant: latestAssistant }
}

export function activeTurnDuration(messages: Message[], status: SessionStatus | undefined, now: number) {
  if (!status || status.type === "idle") return 0

  // 复用 activeTurnPair 锁定活跃 (user, assistant)，确保计时器与 token widget 口径一致，
  // 不会在 orphan user 窗口期切到错误的 user 时间戳。
  const pair = activeTurnPair(messages)
  if (!pair) return 0
  const { user, assistant } = pair

  // tool-calls / unknown 表示同一个 user turn 还可能继续执行工具或下一步模型调用。
  // 运行中 footer 必须继续按 parent user 计时，不能停在上一条 assistant.completed。
  // assistant 为 undefined（首次 prompt 空窗）时也走此分支，按 user.created 起算。
  if (!assistant || !assistant.time.completed || assistant.finish === "tool-calls" || assistant.finish === "unknown") {
    return durationSince(user.time.created, now)
  }

  // 非 idle status 可能是重连后遗留的 stale busy。已 terminal 的 assistant 不再
  // 显示运行时耗时，避免左下角把上一轮完成耗时误认为当前仍在运行。
  if (assistant.finish) return 0

  return assistantTurnDuration(messages, assistant)
}

function durationSince(start: number, end: number) {
  return Math.max(0, end - start)
}
