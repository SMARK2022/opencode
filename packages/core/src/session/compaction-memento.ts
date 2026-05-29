import { Token } from "../util/token"

type Entry = { readonly id: string; readonly text: string; readonly truncated?: boolean }

export function format(messages: readonly Entry[]) {
  if (messages.length === 0) return ""
  return [
    "<recent-user-messages>",
    "Recent user instructions preserved verbatim for continuity. They may overlap with the retained transcript tail.",
    ...messages.flatMap((message, index) => [
      `<message index="${index + 1}" id="${message.id}"${message.truncated ? ' truncated="true"' : ""}>`,
      message.text,
      "</message>",
    ]),
    "</recent-user-messages>",
  ].join("\n")
}

export function collect<Id extends string>(messages: readonly { readonly id: Id; readonly text: string }[], maxTokens: number) {
  const result: { id: Id; text: string; truncated?: boolean }[] = []
  // 独立增量通道允许归零，不能为信封最小长度反过来扩张预算。
  if (maxTokens <= 0) return result
  for (const message of messages.toReversed()) {
    const text = message.text.trim()
    if (!text) continue
    // 先保最新原话，最终恢复原序；计费包含intro、消息ID和所有标签。
    if (Token.estimate(format([{ id: message.id, text }, ...result])) <= maxTokens) {
      result.unshift({ id: message.id, text })
      continue
    }
    let low = 0
    let high = text.length
    let best = ""
    // 对实际重放的完整信封二分，截断标记本身也占用预算。
    while (low <= high) {
      const mid = Math.floor((low + high) / 2)
      const fragment = [text.slice(0, mid).trimEnd(), "...[truncated for compaction memento]"].filter(Boolean).join("\n")
      const candidate = [{ id: message.id, text: fragment, truncated: true }, ...result]
      if (Token.estimate(format(candidate)) <= maxTokens) {
        best = fragment
        low = mid + 1
        continue
      }
      high = mid - 1
    }
    if (best) result.unshift({ id: message.id, text: best, truncated: true })
    break
  }
  return result
}

export * as SessionMemento from "./compaction-memento"
