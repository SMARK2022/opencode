import { MessageV2 } from "@/session/message-v2"
import type { PermissionReviewerPrompt } from "./prompt"

const ENTRY_LIMIT = 40
const PART_CHAR_LIMIT = 4000

export function fromMessages(messages: readonly MessageV2.WithParts[]): PermissionReviewerPrompt.TranscriptDelta {
  // Only send the recent tail. Auto review answers one current permission
  // question; older context increases prompt-injection surface and token cost
  // without reliably improving authorization evidence.
  const recent = messages.slice(-ENTRY_LIMIT)
  return {
    entries: recent.map((message) => ({
      role: message.info.role,
      text: message.parts.map(renderPart).filter(Boolean).join("\n"),
    })),
    truncated: messages.length > recent.length,
  }
}

function renderPart(part: MessageV2.Part) {
  // Hidden parts stay hidden from the reviewer. Visible non-text parts are
  // rendered as metadata tags so the reviewer sees that context exists without
  // executing tools or expanding large binary/file payloads.
  if (part.hidden) return ""
  if (part.type === "text") return truncate(part.text)
  if (part.type === "reasoning") return `<reasoning>${truncate(part.text)}</reasoning>`
  if (part.type === "tool") return renderTool(part)
  if (part.type === "file") return `<file mime="${part.mime}" filename="${part.filename ?? ""}" />`
  if (part.type === "subtask") return `<subtask agent="${part.agent}" description="${truncate(part.description, 400)}" />`
  if (part.type === "patch") return `<patch files="${part.files.join(",")}" />`
  if (part.type === "agent") return `<agent name="${part.name}" />`
  return `<${part.type} />`
}

function renderTool(part: MessageV2.ToolPart) {
  // Tool state is evidence, not instructions. Include input/output summaries for
  // completed tools and raw pending input for unresolved calls, each bounded by
  // truncate() to avoid unbounded reviewer context.
  if (part.state.status === "pending") return `<tool name="${part.tool}" status="pending">${truncate(part.state.raw)}</tool>`
  if (part.state.status === "running") {
    return `<tool name="${part.tool}" status="running">${truncate(JSON.stringify(part.state.input))}</tool>`
  }
  if (part.state.status === "completed") {
    return `<tool name="${part.tool}" status="completed" title="${part.state.title}">\ninput=${truncate(JSON.stringify(part.state.input))}\noutput=${truncate(part.state.output)}\n</tool>`
  }
  return `<tool name="${part.tool}" status="error">${truncate(part.state.error)}</tool>`
}

function truncate(text: string, limit = PART_CHAR_LIMIT) {
  // The marker records exactly how much was omitted so policy can treat missing
  // evidence conservatively instead of assuming the hidden tail was benign.
  if (text.length <= limit) return text
  return text.slice(0, limit) + `\n<truncated chars="${text.length - limit}" />`
}

export * as PermissionReviewerTranscript from "./transcript"
