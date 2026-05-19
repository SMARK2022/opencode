import { Token } from "./token"

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

function emptyEstimate(): AttachmentTokenEstimate {
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
  if (!payload?.payload) return emptyEstimate()

  const mime = input.mime ?? input.mediaType ?? payload.mime ?? "application/octet-stream"
  const text = placeholder({ mime, filename: input.filename })
  const tokens = mime.startsWith("image/")
    ? Math.max(1, Math.min(1600, Math.round(payload.payload.length / 750)))
    : mime === "application/pdf"
      ? Math.max(1, Math.round(payload.payload.length / 1100))
      : Math.max(1, Token.estimate(payload.payload))

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
      { value: [] as unknown[], attachments: emptyEstimate() },
    )
  }

  if (!isRecord(value)) return { value, attachments: emptyEstimate() }

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
    { value: {} as Record<string, unknown>, attachments: emptyEstimate() },
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

export function sanitizeModelMessagesForTokenEstimate(messages: unknown): SanitizedTextEstimate {
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

export * as AttachmentToken from "./attachment-token"
