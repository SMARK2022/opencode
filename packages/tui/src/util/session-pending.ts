import type { AssistantMessage, Message, SessionStatus, UserMessage } from "@opencode-ai/sdk/v2"

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

// #243：会话耗时只从 transcript 中已经持久化的消息时间戳推导：user.time.created
// 是 turn 的唯一开始边界，assistant.time.completed 是完成边界。TUI 的刷新
// tick 只能提供运行中的临时 end，不允许再维护独立 start time，否则 Prompt
// remount、SSE 重连或 retry 状态切换都会让左下角耗时和消息 footer 口径分叉。
// completed 已持久化时优先于 now；now 仅充当流式期间的临时终点（调用方传刷新时钟）
export function assistantTurnDuration(messages: Message[], assistant: AssistantMessage, now?: number) {
  const end = assistant.time.completed ?? now
  // 流式中无 completed：调用方必须传 now，否则无法定义终点
  if (end === undefined) return 0

  const user = messages.find((message): message is UserMessage => {
    return message.role === "user" && message.id === assistant.parentID
  })
  if (!user) return 0

  return durationSince(user.time.created, end)
}

export function activeTurnDuration(messages: Message[], status: SessionStatus | undefined, now: number) {
  // idle 即无运行中回合；status 本身可能因重连 stale，assistant 形态才是真边界
  if (!status || status.type === "idle") return 0

  const user = messages.findLast((message): message is UserMessage => message.role === "user")
  if (!user) return 0

  const assistant = messages.findLast((message): message is AssistantMessage => {
    return message.role === "assistant" && message.parentID === user.id
  })
  if (!assistant) return durationSince(user.time.created, now)

  // finish 枚举语义：stop/end_turn 是终态；tool-calls/unknown/undefined 表示回合仍在推进
  // tool-calls / unknown 表示同一个 user turn 还可能继续执行工具或下一步模型调用。
  // 运行中 footer 必须继续按 parent user 计时，不能停在上一条 assistant.completed。
  if (!assistant.time.completed || assistant.finish === "tool-calls" || assistant.finish === "unknown") {
    return durationSince(user.time.created, now)
  }

  // 非 idle status 可能是重连后遗留的 stale busy。已 terminal 的 assistant 不再
  // 显示运行时耗时，避免左下角把上一轮完成耗时误认为当前仍在运行。
  // finish 已存在 = terminal（stop/end_turn）；其余枚举在上一分支已放行
  if (assistant.finish) return 0

  // completed 存在 → now 不参与计算，保证 stale busy 与完成后重放同口径
  return assistantTurnDuration(messages, assistant)
}

// 时钟精度或乱序时间戳可能产生负差，clamp 到 0 避免显示负耗时
function durationSince(start: number, end: number) {
  return Math.max(0, end - start)
}