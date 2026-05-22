// #193：token 域估算入口；#194 将填充完整实现
// #193：从 core 包 re-export，保持现有消费端不中断
// #194：re-export 旧 API
export {
  estimateAttachment,
  parseDataUrl,
  type AttachmentInput,
  type AttachmentTokenEstimate,
  type SanitizedTextEstimate,
} from "@opencode-ai/core/util/attachment-token"
// #194：别名
export { sanitizeModelMessagesForTokenEstimate as sanitizeModelMessages } from "@opencode-ai/core/util/attachment-token"
// #194：本地类型
import type { AttachmentTokenEstimate } from "@opencode-ai/core/util/attachment-token"
// #194：源模块未导出，本地定义
export function emptyAttachmentEstimate(): AttachmentTokenEstimate {
  return { tokens: 0, rawChars: 0, textChars: 0, count: 0, imageTokens: 0, pdfTokens: 0, otherTokens: 0 }
}

// #194：默认 4 chars/token 兼容历史 Token.estimate 口径，无学习样本时回退到该值
const DEFAULT_CHARS_PER_TOKEN = 4
// #194：密度下限 2 防极端小样本把 token 数估爆；上限 8 防高密度样本低估上下文占用
const MIN_CHARS_PER_TOKEN = 2
// #194：clamp 上下界与 TUI accounting 同口径，保证 daemon 与展示端估算一致
const MAX_CHARS_PER_TOKEN = 8
// #194：学习窗口限 100k 字符，避免超长历史拖慢估算且让最近密度主导
const INPUT_CHARS_HISTORY_LIMIT = 100_000

type HistoryModel = { providerID?: string; id?: string; modelID?: string }
type HistoryMessage = { info?: { role: string; providerID?: string; modelID?: string }; role?: string; providerID?: string; modelID?: string; parts: ReadonlyArray<HistoryPart> }
type HistoryPart = { type: string; inputChars?: number; inputBreakdown?: { messages?: { attachments?: number }; media?: AttachmentTokenEstimate }; tokens?: { input: number; cache: { read: number; write: number } } }
type LearnedInputRatio = { charsPerToken: number; source: "model-history" | "session-history" }
export type UploadInputEstimate = { inputTokens: number; textTokens: number; attachmentTokens: number; charsPerToken: number; source: "model-history" | "session-history" | "default" }

// #194：estimateText 仅按字符数/密度换算，用于 tail/prune 等不依赖学习样本的场景
export function estimateText(input: string, charsPerToken = DEFAULT_CHARS_PER_TOKEN) { return Math.max(0, Math.round((input || "").length / charsPerToken)) }

// #194：learnInputCharsPerToken 用历史 step-finish 样本反推实际密度，避免固定 /4 失真
export function learnInputCharsPerToken(input: { messages: ReadonlyArray<HistoryMessage>; model?: HistoryModel }): LearnedInputRatio | undefined {
  const modelRatio = collectInputRatio(input.messages, input.model, true)
  // #194：model-history 精确匹配当前模型时优先，session-history 是泛化回退
  if (modelRatio) return { charsPerToken: modelRatio, source: "model-history" }
  // #194：session-history 接受任意模型样本，作为无同模型样本时的近似回退
  const sessionRatio = collectInputRatio(input.messages, input.model, false)
  if (sessionRatio) return { charsPerToken: sessionRatio, source: "session-history" }
  return undefined
}

// #194：estimateUploadInput 汇总文本与附件 token，是 prompt/compaction 共用的唯一上传口径
export function estimateUploadInput(input: { text: string; attachments: AttachmentTokenEstimate; history: ReadonlyArray<HistoryMessage>; model?: HistoryModel }): UploadInputEstimate {
  // #194：先尝试同 model 历史密度，无样本时回退到 4，保证估算始终有界
  const learned = learnInputCharsPerToken({ messages: input.history, model: input.model })
  const charsPerToken = learned?.charsPerToken ?? DEFAULT_CHARS_PER_TOKEN
  // #194：文本部分按学习密度换算，附件部分独立累加，两者互不稀释
  const textTokens = estimateText(input.text, charsPerToken)
  return { inputTokens: textTokens + input.attachments.tokens, textTokens, attachmentTokens: input.attachments.tokens, charsPerToken, source: learned?.source ?? "default" }
}

// #194：clampCharsPerToken 把学习结果限制在 2..8，防止单一样本把密度推到失真区间
function clampCharsPerToken(value: number) { return Math.min(MAX_CHARS_PER_TOKEN, Math.max(MIN_CHARS_PER_TOKEN, value)) }

function collectInputRatio(messages: ReadonlyArray<HistoryMessage>, model: HistoryModel | undefined, modelOnly: boolean) {
  let historyInputTokens = 0
  let historyInputChars = 0
  for (let i = messages.length - 1; i >= 0 && historyInputChars < INPUT_CHARS_HISTORY_LIMIT; i--) {
    const message = messages[i]
    if ((message.info?.role ?? message.role) !== "assistant") continue
    if (modelOnly && !sameModel(message, model)) continue
    for (let j = message.parts.length - 1; j >= 0; j--) {
      const sample = inputRatioSample(message.parts[j])
      if (!sample) continue
      historyInputChars += sample.chars
      historyInputTokens += sample.tokens
    }
  }
  if (historyInputTokens <= 0 || historyInputChars <= 500) return undefined
  return clampCharsPerToken(historyInputChars / historyInputTokens)
}

// #194：sameModel 只在 providerID 匹配时才算同模型样本，避免跨模型密度污染
function sameModel(message: HistoryMessage, model: HistoryModel | undefined) {
  // #194：无 provider 不算
  if (!model?.providerID) return false
  const modelID = model.id ?? model.modelID
  if (!modelID) return false
  return (message.info?.providerID ?? message.providerID) === model.providerID && (message.info?.modelID ?? message.modelID) === modelID
}

// #194：inputRatioSample 只取 step-finish 消息的输入样本，其他消息类型不参与密度学习
function inputRatioSample(part: HistoryPart): { chars: number; tokens: number } | undefined {
  // #194：仅 step-finish 消息携带确认过的 input 字符/token，是密度学习的可信来源
  if (part.type !== "step-finish") return undefined
  const chars = part.inputChars
  if (!chars || chars < 100) return undefined
  const confirmedTokens = (part.tokens?.input ?? 0) + (part.tokens?.cache.read ?? 0) + (part.tokens?.cache.write ?? 0)
  if (confirmedTokens <= 0) return undefined
  const media = part.inputBreakdown?.media
  if (media) {
    // #194：media 附件按独立 token 计，不参与文本密度计算，避免图片压低估文本
    const textChars = Math.max(0, chars - media.rawChars + media.textChars)
    const textTokens = Math.max(0, confirmedTokens - media.tokens)
    return textChars > 0 && textTokens > 0 ? { chars: textChars, tokens: textTokens } : undefined
  }
  // #194：旧附件样本缺乏媒体 token 元数据，整体排除防密度失真
  if ((part.inputBreakdown?.messages?.attachments ?? 0) > 0) return undefined
  return { chars, tokens: confirmedTokens }
}

// #194：统一导出
export * as TokenEstimate from "./estimate"

