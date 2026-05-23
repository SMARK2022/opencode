import type { OpenCodeEvent, SessionMessageInfo, SessionPendingMessage } from "@opencode-ai/client/promise"
import type { SessionEvent } from "@opencode-ai/schema/session-event"
import { Schema } from "effect"
import { toolMetadata } from "../utils/session-message"

export type NativeSessionEvent = typeof SessionEvent.All.Encoded
type DisplayEvent<E = OpenCodeEvent> = E extends OpenCodeEvent ? Omit<E, "durable" | "location"> : never
type Missing = { sessionID: string; messages: SessionMessageInfo[]; touched: string[]; missing: string }
const metadata = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.MutableJson))

export function nativeSessionEvent(source: readonly SessionMessageInfo[], event: OpenCodeEvent | NativeSessionEvent, pending: Map<string, SessionPendingMessage>): DisplayEvent | Missing | undefined {
  if (!native(event)) return event
  const base = { id: event.id, created: event.data.timestamp, metadata: event.metadata }
  const sessionID = event.data.sessionID
  const missing = (id: string): Missing => ({ sessionID, messages: [...source], touched: [], missing: id })
  // 事件身份不变；只下沉到在用vendor展示DTO，不伪造durable版本或重新执行模型。
  const assistantID = "assistantMessageID" in event.data ? event.data.assistantMessageID : undefined
  if (assistantID && event.type !== "session.next.step.started" && !source.some((item) => item.id === assistantID && item.type === "assistant")) return missing(assistantID)
  switch (event.type) {
    case "session.next.prompted":
      // canonical promotion自带完整prompt，不能再依赖先收到旧版admission缓存。
      pending.set(`${sessionID}:${event.data.messageID}`, { type: "user", delivery: event.data.delivery, data: {
        text: event.data.prompt.text, metadata: event.metadata ? metadata(event.metadata) : undefined,
        files: event.data.prompt.files?.map((file) => ({ mime: file.mime, name: file.name, data: "", source: { type: "uri" as const, uri: file.uri }, mention: file.source })),
        agents: event.data.prompt.agents?.map((agent) => ({ name: agent.name, mention: agent.source })),
      } })
      return { ...base, type: "session.input.promoted", data: { sessionID, inputID: event.data.messageID } }
    case "session.next.synthetic": return { ...base, type: "session.synthetic", data: { ...event.data, metadata: event.metadata } }
    case "session.next.agent.switched": return { ...base, type: "session.agent.selected", data: event.data }
    case "session.next.model.switched": return { ...base, type: "session.model.selected", data: event.data }
    case "session.next.step.started": return { ...base, type: "session.step.started", data: event.data }
    case "session.next.step.ended": {
      const finish = event.data.finish
      const failed = source.some((item) => item.id === event.data.assistantMessageID && item.type === "assistant" && item.error)
      return { ...base, type: "session.step.ended", data: { ...event.data, finish: failed ? "error" : finish === "stop" || finish === "length" || finish === "tool-calls" || finish === "content-filter" || finish === "error" ? finish : "unknown", files: event.data.files ? [...event.data.files] : undefined } }
    }
    case "session.next.step.failed": return { ...base, type: "session.step.failed", data: { ...event.data, error: { ...event.data.error, type: event.data.aborted ? "MessageAbortedError" : event.data.error.type } } }
    case "session.next.text.started":
    case "session.next.text.delta":
    case "session.next.text.ended":
    case "session.next.reasoning.started":
    case "session.next.reasoning.delta":
    case "session.next.reasoning.ended": {
      const kind = "textID" in event.data ? "text" : "reasoning"
      const id = "textID" in event.data ? event.data.textID : event.data.reasoningID
      const assistant = source.find((item) => item.id === event.data.assistantMessageID)
      const parts = assistant?.type === "assistant" ? assistant.content.filter((part) => part.type === kind) : []
      const existing = parts.findIndex((part) => "id" in part && part.id === id)
      const ordinal = existing >= 0 ? existing : event.type.endsWith(".started") ? parts.length : -1
      // 接续流缺少起始片段时交回既有hydration，不把delta猜写到另一段reasoning/text。
      if (ordinal < 0) return missing(event.data.assistantMessageID)
      switch (event.type) {
        case "session.next.text.started": return { ...base, type: "session.text.started", data: { ...event.data, ordinal } }
        case "session.next.text.delta": return { ...base, type: "session.text.delta", data: { ...event.data, ordinal } }
        case "session.next.text.ended": return { ...base, type: "session.text.ended", data: { ...event.data, ordinal } }
        case "session.next.reasoning.started": return { ...base, type: "session.reasoning.started", data: { ...event.data, ordinal, state: event.data.providerMetadata ? metadata(event.data.providerMetadata) : undefined } }
        case "session.next.reasoning.delta": return { ...base, type: "session.reasoning.delta", data: { ...event.data, ordinal } }
        case "session.next.reasoning.ended": return { ...base, type: "session.reasoning.ended", data: { ...event.data, ordinal, state: event.data.providerMetadata ? metadata(event.data.providerMetadata) : undefined } }
      }
    }
    case "session.next.tool.input.started": return { ...base, type: "session.tool.input.started", data: event.data }
    case "session.next.tool.input.delta": return { ...base, type: "session.tool.input.delta", data: event.data }
    case "session.next.tool.input.ended": return { ...base, type: "session.tool.input.ended", data: event.data }
    case "session.next.tool.called": return { ...base, type: "session.tool.called", data: { ...event.data, input: metadata(event.data.input), executed: event.data.provider.executed, state: event.data.provider.metadata ? metadata(event.data.provider.metadata) : undefined } }
    case "session.next.tool.progress":
    case "session.next.tool.success": {
      const assistant = source.find((item) => item.id === event.data.assistantMessageID)
      const tool = assistant?.type === "assistant" ? assistant.content.find((part) => part.type === "tool" && part.id === event.data.callID) : undefined
      const owned = tool?.type === "tool" ? toolMetadata(tool).autoReview : undefined
      // 与持久投影相同：普通进度不能抹掉review，成功结果不能改写已有批准事实。
      const value = metadata({ ...event.data.structured, ...(owned !== undefined && (event.type === "session.next.tool.success" || event.data.structured.autoReview === undefined) ? { autoReview: owned } : {}) })
      const data = { ...event.data, structured: value, metadata: value }
      if (event.type === "session.next.tool.progress") return { ...base, type: "session.tool.progress", data }
      // vendor成功DTO要求非空content；仅展示侧将零正文等价表示为空文本，不改变实际工具结果。
      return { ...base, type: "session.tool.success", data: { ...event.data, metadata: value, content: [event.data.content[0] ?? { type: "text", text: "" }, ...event.data.content.slice(1)], executed: event.data.provider.executed, resultState: event.data.provider.metadata ? metadata(event.data.provider.metadata) : undefined } }
    }
    case "session.next.tool.failed": {
      const assistant = source.find((item) => item.id === event.data.assistantMessageID)
      const tool = assistant?.type === "assistant" ? assistant.content.find((part) => part.type === "tool" && part.id === event.data.callID) : undefined
      const value = tool?.type === "tool" ? toolMetadata(tool) : {}
      const content = tool?.type === "tool" && "content" in tool.state && Array.isArray(tool.state.content) ? tool.state.content : []
      return { ...base, type: "session.tool.failed", data: { ...event.data, metadata: metadata(value), content: content.length ? [content[0], ...content.slice(1)] : undefined, executed: event.data.provider.executed, resultState: event.data.provider.metadata ? metadata(event.data.provider.metadata) : undefined } }
    }
    default: return
  }
}

function native(event: OpenCodeEvent | NativeSessionEvent): event is NativeSessionEvent {
  return event.type.startsWith("session.next.")
}
