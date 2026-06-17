/**
 * TokenEstimate is the single upload-estimation boundary. Callers hand it the
 * exact text that will be sent to the provider after media sanitization plus the
 * historical session messages that contain provider-confirmed step-finish usage.
 */
const DEFAULT_CHARS_PER_TOKEN = 4
const MIN_CHARS_PER_TOKEN = 2
const MAX_CHARS_PER_TOKEN = 8
const INPUT_CHARS_HISTORY_LIMIT = 100_000

type HistoryModel = { providerID?: string; id?: string; modelID?: string }

type HistoryMessage = {
  info?: { role: string; providerID?: string; modelID?: string }
  role?: string
  providerID?: string
  modelID?: string
  parts: ReadonlyArray<HistoryPart>
}

type HistoryPart = {
  type: string
  inputChars?: number
  inputBreakdown?: {
    messages?: { attachments?: number }
    media?: AttachmentTokenEstimate
  }
  tokens?: { input: number; cache: { read: number; write: number } }
}

type LearnedInputRatio = {
  charsPerToken: number
  source: "model-history" | "session-history"
}

export type UploadInputEstimate = {
  inputTokens: number
  textTokens: number
  attachmentTokens: number
  charsPerToken: number
  source: "model-history" | "session-history" | "default"
}

export type AttachmentInput = {
  type?: "file" | "media" | "image"
  mime?: string
  mediaType?: string
  url?: string
  data?: string
  filename?: string
}

export type AttachmentTokenEstimate = {
  tokens: number
  rawChars: number
  textChars: number
  count: number
  imageTokens: number
  pdfTokens: number
  otherTokens: number
}

export type SanitizedTextEstimate = {
  value: unknown
  text: string
  textChars: number
  rawChars: number
  attachments: AttachmentTokenEstimate
}

type ParsedPayload = {
  mime: string
  payload: string
}

type PayloadInfo = {
  payload: string
  rawChars: number
  mime?: string
}

export function estimateText(input: string, charsPerToken = DEFAULT_CHARS_PER_TOKEN) {
  return Math.max(0, Math.round((input || "").length / charsPerToken))
}

export function emptyAttachmentEstimate(): AttachmentTokenEstimate {
  return { tokens: 0, rawChars: 0, textChars: 0, count: 0, imageTokens: 0, pdfTokens: 0, otherTokens: 0 }
}

function addEstimate(left: AttachmentTokenEstimate, right: AttachmentTokenEstimate): AttachmentTokenEstimate {
  return {
    tokens: left.tokens + right.tokens,
    rawChars: left.rawChars + right.rawChars,
    textChars: left.textChars + right.textChars,
    count: left.count + right.count,
    imageTokens: left.imageTokens + right.imageTokens,
    pdfTokens: left.pdfTokens + right.pdfTokens,
    otherTokens: left.otherTokens + right.otherTokens,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function parseDataUrl(url: string): ParsedPayload | undefined {
  if (!url.startsWith("data:")) return undefined
  const comma = url.indexOf(",")
  if (comma < 0) return undefined
  const semicolon = url.indexOf(";")
  return {
    mime: url.slice("data:".length, semicolon >= 0 && semicolon < comma ? semicolon : comma),
    payload: url.slice(comma + 1),
  }
}

function payloadInfo(input: AttachmentInput): PayloadInfo | undefined {
  if (input.url) {
    const parsed = parseDataUrl(input.url)
    if (parsed) return { payload: parsed.payload, rawChars: input.url.length, mime: parsed.mime }
  }
  if (!input.data) return undefined
  const parsed = parseDataUrl(input.data)
  if (parsed) return { payload: parsed.payload, rawChars: input.data.length, mime: parsed.mime }
  if (input.type === "media" || (input.type === "file" && !isRemoteReference(input.data))) {
    return { payload: input.data, rawChars: input.data.length }
  }
  return undefined
}

function isRemoteReference(value: string) {
  return value.startsWith("//") || /^[a-z][a-z0-9+.-]*:/i.test(value)
}

function placeholder(input: { mime: string; filename?: string }) {
  return `[Attached ${input.mime}: ${input.filename ?? "file"}]`
}

export function estimateAttachment(input: AttachmentInput): AttachmentTokenEstimate {
  const payload = payloadInfo(input)
  if (!payload?.payload) return emptyAttachmentEstimate()

  const mime = input.mime ?? input.mediaType ?? payload.mime ?? "application/octet-stream"
  const text = placeholder({ mime, filename: input.filename })
  const tokens = mime.startsWith("image/")
    ? Math.max(1, Math.min(1600, Math.round(payload.payload.length / 750)))
    : mime === "application/pdf"
      ? Math.max(1, Math.round(payload.payload.length / 1100))
      : Math.max(1, estimateText(payload.payload))

  return {
    tokens,
    rawChars: payload.rawChars,
    textChars: text.length,
    count: 1,
    imageTokens: mime.startsWith("image/") ? tokens : 0,
    pdfTokens: mime === "application/pdf" ? tokens : 0,
    otherTokens: !mime.startsWith("image/") && mime !== "application/pdf" ? tokens : 0,
  }
}

function sanitize(value: unknown): { value: unknown; attachments: AttachmentTokenEstimate } {
  if (Array.isArray(value)) {
    return value.reduce(
      (acc, item) => {
        const next = sanitize(item)
        return { value: [...acc.value, next.value], attachments: addEstimate(acc.attachments, next.attachments) }
      },
      { value: [] as unknown[], attachments: emptyAttachmentEstimate() },
    )
  }

  if (!isRecord(value)) return { value, attachments: emptyAttachmentEstimate() }

  const attachment = attachmentFromRecord(value)
  if (attachment) {
    const estimate = estimateAttachment(attachment)
    if (estimate.count > 0) return { value: sanitizeAttachmentRecord(value, attachment), attachments: estimate }
  }

  return Object.entries(value).reduce(
    (acc, [key, item]) => {
      const next = sanitize(item)
      return {
        value: { ...acc.value, [key]: next.value },
        attachments: addEstimate(acc.attachments, next.attachments),
      }
    },
    { value: {} as Record<string, unknown>, attachments: emptyAttachmentEstimate() },
  )
}

function attachmentFromRecord(value: Record<string, unknown>): AttachmentInput | undefined {
  if (value.type === "file") {
    return {
      type: "file",
      mime: typeof value.mime === "string" ? value.mime : undefined,
      mediaType: typeof value.mediaType === "string" ? value.mediaType : undefined,
      url: typeof value.url === "string" ? value.url : undefined,
      data: typeof value.data === "string" ? value.data : undefined,
      filename: typeof value.filename === "string" ? value.filename : undefined,
    }
  }
  if (value.type === "media") {
    return {
      type: "media",
      mediaType: typeof value.mediaType === "string" ? value.mediaType : undefined,
      data: typeof value.data === "string" ? value.data : undefined,
      filename: typeof value.filename === "string" ? value.filename : undefined,
    }
  }
  if (value.type === "image" && typeof value.image === "string") return { type: "image", url: value.image, mime: parseDataUrl(value.image)?.mime }
  return undefined
}

function sanitizeAttachmentRecord(value: Record<string, unknown>, input: AttachmentInput) {
  const mime = input.mime ?? input.mediaType ?? parseDataUrl(input.url ?? input.data ?? "")?.mime ?? "attachment"
  const text = placeholder({ mime, filename: input.filename })
  if (typeof value.url === "string" && value.url.startsWith("data:")) return { ...value, url: text }
  if (typeof value.data === "string") return { ...value, data: text }
  if (typeof value.image === "string" && value.image.startsWith("data:")) return { ...value, image: text }
  return value
}

export function sanitizeModelMessages(messages: unknown): SanitizedTextEstimate {
  const result = sanitize(messages)
  const text = JSON.stringify(result.value)
  return {
    value: result.value,
    text,
    textChars: text.length,
    rawChars: JSON.stringify(messages).length,
    attachments: result.attachments,
  }
}

export function learnInputCharsPerToken(input: {
  messages: ReadonlyArray<HistoryMessage>
  model?: HistoryModel
}): LearnedInputRatio | undefined {
  const modelRatio = collectInputRatio(input.messages, input.model, true)
  if (modelRatio) return { charsPerToken: modelRatio, source: "model-history" }
  const sessionRatio = collectInputRatio(input.messages, input.model, false)
  if (sessionRatio) return { charsPerToken: sessionRatio, source: "session-history" }
  return undefined
}

export function estimateUploadInput(input: {
  text: string
  attachments: AttachmentTokenEstimate
  history: ReadonlyArray<HistoryMessage>
  model?: HistoryModel
}): UploadInputEstimate {
  const learned = learnInputCharsPerToken({ messages: input.history, model: input.model })
  const charsPerToken = learned?.charsPerToken ?? DEFAULT_CHARS_PER_TOKEN
  const textTokens = estimateText(input.text, charsPerToken)
  return {
    inputTokens: textTokens + input.attachments.tokens,
    textTokens,
    attachmentTokens: input.attachments.tokens,
    charsPerToken,
    source: learned?.source ?? "default",
  }
}

function clampCharsPerToken(value: number) {
  return Math.min(MAX_CHARS_PER_TOKEN, Math.max(MIN_CHARS_PER_TOKEN, value))
}

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

function sameModel(message: HistoryMessage, model: HistoryModel | undefined) {
  if (!model?.providerID) return false
  const modelID = model.id ?? model.modelID
  if (!modelID) return false
  return (message.info?.providerID ?? message.providerID) === model.providerID && (message.info?.modelID ?? message.modelID) === modelID
}

function inputRatioSample(part: HistoryPart): { chars: number; tokens: number } | undefined {
  if (part.type !== "step-finish") return undefined
  const chars = part.inputChars
  if (!chars || chars < 100) return undefined
  const confirmedTokens = (part.tokens?.input ?? 0) + (part.tokens?.cache.read ?? 0) + (part.tokens?.cache.write ?? 0)
  if (confirmedTokens <= 0) return undefined
  const media = part.inputBreakdown?.media
  if (media) {
    const textChars = Math.max(0, chars - media.rawChars + media.textChars)
    const textTokens = Math.max(0, confirmedTokens - media.tokens)
    return textChars > 0 && textTokens > 0 ? { chars: textChars, tokens: textTokens } : undefined
  }
  if ((part.inputBreakdown?.messages?.attachments ?? 0) > 0) return undefined
  return { chars, tokens: confirmedTokens }
}

export * as TokenEstimate from "./estimate"
