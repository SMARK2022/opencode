/**
 * V1的确认样本适配器。
 * 消息字段在此转换为Core输入，附件预算与tail/prune的固定密度估算继续复用原有实现。
 */
export {
  estimateAttachment,
  parseDataUrl,
  type AttachmentInput,
  type AttachmentTokenEstimate,
  type SanitizedTextEstimate,
} from "@opencode-ai/core/util/attachment-token"
// #194：别名
export { sanitizeModelMessagesForTokenEstimate as sanitizeModelMessages } from "@opencode-ai/core/util/attachment-token"
import type { AttachmentTokenEstimate } from "@opencode-ai/core/util/attachment-token"
import { Token } from "@opencode-ai/core/util/token"
export function emptyAttachmentEstimate(): AttachmentTokenEstimate {
  return { tokens: 0, rawChars: 0, textChars: 0, count: 0, imageTokens: 0, pdfTokens: 0, otherTokens: 0 }
}

const DEFAULT_CHARS_PER_TOKEN = 4

type HistoryMessage = {
  info: {
    role: string
    providerID?: string
    modelID?: string
    hidden?: unknown
    tokens?: HistoryPart["tokens"]
    // assistant上的inputEstimate与tokens是最近一次provider确认形成的热快照。
    inputEstimate?: { confirmed?: boolean; bodyChars: number; inputBreakdown?: Token.InputSample["inputBreakdown"] }
  }
  parts: ReadonlyArray<HistoryPart>
}

type HistoryPart = {
  type: string
  inputChars?: number
  inputBreakdown?: Token.InputSample["inputBreakdown"]
  tokens?: { input: number; cache: { read: number; write: number } }
}

/** 为tail/prune等保留预算提供固定密度的文本估算，默认沿用4字符/token。 */
export function estimateText(input: string, charsPerToken = DEFAULT_CHARS_PER_TOKEN) { return Math.max(0, Math.round((input || "").length / charsPerToken)) }

/** 将V1历史转换为同provider/model、按时间从新到旧排列的Core确认样本。 */
export function inputHistory(messages: ReadonlyArray<HistoryMessage>, model: { providerID: string; id: string }) {
  const history: Token.InputSample[] = []
  // 每个助手优先读取热快照，缺少有效热快照时从最近finish恢复同一请求的测量值。
  for (let index = messages.length - 1; index >= 0 && history.length < Token.INPUT_RATIO_HISTORY_SAMPLES; index--) {
    const message = messages[index]
    const info = message.info
    // 当前会话、可见性和API身份共同决定样本能否校准这次请求。
    if (info.role !== "assistant" || info.hidden || info.providerID !== model.providerID || info.modelID !== model.id) continue
    if (info.inputEstimate?.confirmed && info.tokens) {
      const sample = { bodyChars: info.inputEstimate.bodyChars, inputBreakdown: info.inputEstimate.inputBreakdown,
        input: info.tokens.input + info.tokens.cache.read + info.tokens.cache.write }
      if (Token.inputRatioSample(sample)) {
        history.push(sample)
        continue
      }
    }
    // 新prepared会更新carrier；finish仍保存旧请求自己的字符和usage，读取时保持这份配对。
    for (let part = message.parts.length - 1; part >= 0; part--) {
      const sample = inputSample(message.parts[part])
      if (!sample || !Token.inputRatioSample(sample)) continue
      history.push(sample)
      break
    }
  }
  return history
}

/** 从step-finish提取完整原始测量值，媒体字符与输入的分离在Core统一完成。 */
export function inputSample(part: HistoryPart): Token.InputSample | undefined {
  if (part.type !== "step-finish" || part.inputChars === undefined || !part.tokens) return undefined
  return { bodyChars: part.inputChars, inputBreakdown: part.inputBreakdown,
    input: part.tokens.input + part.tokens.cache.read + part.tokens.cache.write }
}

// 保持现有TokenEstimate命名空间入口，调用方共享上面的适配逻辑。
export * as TokenEstimate from "./estimate"

