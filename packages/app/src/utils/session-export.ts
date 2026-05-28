import type { Message, Part, Session } from "@opencode-ai/sdk/v2/client"
import type { SessionInfo, SessionMessageInfo } from "@opencode-ai/client/promise"
import type { ServerApi } from "./server"
import type { ServerProtocol } from "./server-protocol"
import { sessionMessageHidden } from "./session-message"

// V1沿用CLI导出结构；Native保留原生字段，避免显示投影丢失压缩正文与工具信息。
export type SessionExportData = {
  info: Session
  messages: {
    info: Message
    parts: Part[]
  }[]
} | {
  info: SessionInfo
  messages: SessionMessageInfo[]
}

export type SessionExportClient = {
  session: {
    get: (input: { sessionID: string }) => Promise<{ data?: Session | null }>
    messages: (input: { sessionID: string }) => Promise<{ data?: { info: Message; parts: Part[] }[] | null }>
  }
}

export async function fetchSessionExport(input: {
  sessionID: string
  client: SessionExportClient
  protocol: Promise<ServerProtocol>
  api: { session: Pick<ServerApi["session"], "get">; message: Pick<ServerApi["message"], "list"> }
}): Promise<SessionExportData> {
  if (await input.protocol !== "v1") {
    const info = await input.api.session.get({ sessionID: input.sessionID })
    let page = await input.api.message.list({ sessionID: input.sessionID, limit: 200, order: "asc" })
    const messages = page.data.filter((message) => !sessionMessageHidden(message))
    // 游标已编码升序；非空末页仍有next，读到空页后才允许下载完整结果。
    while (page.cursor.next) {
      page = await input.api.message.list({ sessionID: input.sessionID, limit: 200, cursor: page.cursor.next })
      // 隐藏的协议修复消息不重新暴露；其他canonical字段按服务端原样保留。
      messages.push(...page.data.filter((message) => !sessionMessageHidden(message)))
    }
    return { info, messages }
  }
  const [sessionRes, messagesRes] = await Promise.all([
    input.client.session.get({ sessionID: input.sessionID }),
    input.client.session.messages({ sessionID: input.sessionID }),
  ])

  if (!sessionRes?.data) {
    throw new Error(`Session not found: ${input.sessionID}`)
  }
  if (!messagesRes?.data) {
    throw new Error(`Failed to load messages for session: ${input.sessionID}`)
  }

  return {
    info: sessionRes.data,
    messages: messagesRes.data,
  }
}

export function sessionExportFilename(session: { id: string; title?: string; slug?: string }) {
  const name = session.title || session.slug || session.id
  const clean = name
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
  return `${clean || session.id}.json`
}

export function downloadSessionExport(filename: string, data: unknown) {
  const json = JSON.stringify(data, null, 2)
  const blob = new Blob([json], { type: "application/json" })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}
