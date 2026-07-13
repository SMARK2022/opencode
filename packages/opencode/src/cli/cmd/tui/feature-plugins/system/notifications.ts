import type { Event } from "@opencode-ai/sdk/v2"
import type { TuiAttentionSoundName, TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { InternalTuiPlugin } from "../../plugin/internal"

const id = "internal:notifications"

type SessionError = Extract<Event, { type: "session.error" }>["properties"]["error"]

// sound 参数支持 false：question/permission 只保留视觉通知不播放音效
function notify(api: TuiPluginApi, sessionID: string | undefined, message: string, sound: TuiAttentionSoundName | false) {
  const session = sessionID ? api.state.session.get(sessionID) : undefined
  const isSubagent = session?.parentID !== undefined
  void api.attention.notify({
    title: session?.title,
    message,
    notification: isSubagent ? false : { when: "blurred" },
    // false 表示静音；attention.ts 的 soundVolume 在 input.sound === false 时返回 undefined
    sound: sound === false ? false : { name: sound, when: "always" },
  })
}

function sessionErrorMessage(error: SessionError) {
  if (error?.name === "MessageAbortedError") return "Session aborted"
  const data = error?.data
  if (data && typeof data === "object" && "message" in data && data.message === "SSE read timed out") {
    return "Model stopped responding"
  }
  return "Session error"
}

// 检查 latest assistant 是否已终态化（completed 且无 error）。
// abort 时 Runner.cancel 先发 idle，此时 assistant 尚未被 halt 终态化，
// 因此 completedTurn 返回 false，idle handler 不消费 active，等待后续 session.error。
function completedTurn(api: TuiPluginApi, sessionID: string): boolean {
  const messages = api.state.session.messages(sessionID)
  const user = messages.findLast((m) => m.role === "user")
  if (!user) return false
  // 类型收窄：只有 assistant message 才有 time.completed 和 error
  const assistant = messages.findLast(
    (m): m is Extract<typeof m, { role: "assistant" }> => m.role === "assistant" && m.parentID === user.id,
  )
  return assistant?.time.completed !== undefined && assistant.error === undefined
}

const tui: TuiPlugin = async (api) => {
  const active = new Set<string>()
  const questions = new Set<string>()
  const permissions = new Set<string>()

  // question/permission 静音：只保留视觉通知，避免频繁触发时太吵
  api.event.on("question.asked", (event) => {
    if (questions.has(event.properties.id)) return
    questions.add(event.properties.id)
    notify(api, event.properties.sessionID, "Question needs input", false)
  })

  api.event.on("question.replied", (event) => {
    questions.delete(event.properties.requestID)
  })

  api.event.on("question.rejected", (event) => {
    questions.delete(event.properties.requestID)
  })

  api.event.on("permission.asked", (event) => {
    if (permissions.has(event.properties.id)) return
    permissions.add(event.properties.id)
    notify(api, event.properties.sessionID, "Permission needs input", false)
  })

  api.event.on("permission.replied", (event) => {
    permissions.delete(event.properties.requestID)
  })

  api.event.on("session.status", (event) => {
    const sessionID = event.properties.sessionID
    if (event.properties.status.type === "busy" || event.properties.status.type === "retry") {
      active.add(sessionID)
      return
    }

    if (event.properties.status.type !== "idle") return
    if (!active.has(sessionID)) return

    // abort 的第一个 idle 到达时 assistant 尚未终态化。
    // 保留 active，等待紧随其后的 session.error 消费它。
    if (!completedTurn(api, sessionID)) return

    active.delete(sessionID)

    const session = api.state.session.get(sessionID)
    // subagent 完成不触发通知和音效，保持安静
    if (session?.parentID) return

    notify(api, sessionID, "Session done", "done")
  })

  // error 直接消费 active，不再依赖单独的 errored Set：
  // 重复 error 时 active.delete 返回 false，自然忽略
  api.event.on("session.error", (event) => {
    const sessionID = event.properties.sessionID
    if (!sessionID) return
    if (!active.delete(sessionID)) return
    const isAbort = event.properties.error?.name === "MessageAbortedError"
    // abort 完全静音：用户主动取消，不需要声音提示
    notify(api, sessionID, sessionErrorMessage(event.properties.error), isAbort ? false : "error")
  })
}

const plugin: InternalTuiPlugin = {
  id,
  tui,
}

export default plugin
