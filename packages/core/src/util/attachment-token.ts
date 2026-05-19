// #175：媒体 token 与文本密度隔离；daemon 与 TUI 必须共用
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

// #175：累加单位元，全字段为 0
function emptyEstimate(): AttachmentTokenEstimate {
  // #175：empty 返回全 0，作为 reduce 单位元
  return { tokens: 0, rawChars: 0, textChars: 0, count: 0, imageTokens: 0, pdfTokens: 0, otherTokens: 0 }
}

// #175：分项相加，保留 image/pdf/other
function addEstimate(left: AttachmentTokenEstimate, right: AttachmentTokenEstimate): AttachmentTokenEstimate {
  return {
    // #175：tokens 与分项同步累加，禁止只加 tokens
    tokens: left.tokens + right.tokens,
    rawChars: left.rawChars + right.rawChars,
    textChars: left.textChars + right.textChars,
    count: left.count + right.count,
    imageTokens: left.imageTokens + right.imageTokens,
    pdfTokens: left.pdfTokens + right.pdfTokens,
    otherTokens: left.otherTokens + right.otherTokens,
  }
}

// #175：排除数组，只从普通对象抽附件
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

// #175：仅解析 data: URL；缺逗号则无效
export function parseDataUrl(url: string): ParsedPayload | undefined {
  // #175：非 data: 直接拒绝，交给 isRemoteReference 路径
  if (!url.startsWith("data:")) return undefined
  const comma = url.indexOf(",")
  if (comma < 0) return undefined
  const semicolon = url.indexOf(";")
  return {
    mime: url.slice("data:".length, semicolon >= 0 && semicolon < comma ? semicolon : comma),
    payload: url.slice(comma + 1),
  }
}

// #175：优先 url 字段，其次 data
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

// #175：// 或 scheme: 视为远程，不计 token
function isRemoteReference(value: string) {
  return value.startsWith("//") || /^[a-z][a-z0-9+.-]*:/i.test(value)
}

// #175：占位计入 textChars，替代 raw base64
function placeholder(input: { mime: string; filename?: string }) {
  return `[Attached ${input.mime}: ${input.filename ?? "file"}]`
}

// #175：单附件入口，按 mime 选密度
export function estimateAttachment(input: AttachmentInput): AttachmentTokenEstimate {
  const payload = payloadInfo(input)
  if (!payload?.payload) return emptyEstimate()

  // #175：mime 优先显式字段，其次 payload 解析
  const mime = input.mime ?? input.mediaType ?? payload.mime ?? "application/octet-stream"
  const text = placeholder({ mime, filename: input.filename })
// #175：image 除数 750，结果夹紧到 1..1600
  const tokens = mime.startsWith("image/")
    ? Math.max(1, Math.min(1600, Math.round(payload.payload.length / 750)))
// #175：pdf 除数 1100
    : mime === "application/pdf"
      ? Math.max(1, Math.round(payload.payload.length / 1100))
// #175：其它 MIME 回退 Token.estimate
      : Math.max(1, Token.estimate(payload.payload))

  return {
    tokens,
    rawChars: payload.rawChars,
    textChars: text.length,
    count: 1,
// #175：image 除数 750，结果夹紧到 1..1600
    imageTokens: mime.startsWith("image/") ? tokens : 0,
// #175：pdf 除数 1100
    pdfTokens: mime === "application/pdf" ? tokens : 0,
    otherTokens: !mime.startsWith("image/") && mime !== "application/pdf" ? tokens : 0,
  }
}

// #175：递归消毒并累计 media
function sanitize(value: unknown): { value: unknown; attachments: AttachmentTokenEstimate } {
  // #175：数组元素各自 sanitize 再合并 attachments
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

// #175：识别 file/media/image 三种形态
function attachmentFromRecord(value: Record<string, unknown>): AttachmentInput | undefined {
  // #175：file 形态读 url/mime/filename
  if (value.type === "file") {
    return {
      type: "file",
      mime: typeof value.mime === "string" ? value.mime : undefined,
      mediaType: typeof value.mediaType === "string" ? value.mediaType : undefined,
      url: typeof value.url === "string" ? value.url : undefined,
      data: typeof value.data === "string" ? value.data : value.data instanceof Uint8Array ? Buffer.from(value.data).toString("base64") : undefined,
      filename: typeof value.filename === "string" ? value.filename : undefined,
    }
  }
  // #175：media 形态可能把数据放在 data
  if (value.type === "media") {
    return {
      type: "media",
      mediaType: typeof value.mediaType === "string" ? value.mediaType : undefined,
      data: typeof value.data === "string" ? value.data : undefined,
      filename: typeof value.filename === "string" ? value.filename : undefined,
    }
  }
  // SDK 图片可为二进制；转换只供估算，不改实际 provider 请求。
  if (value.type === "image" && value.image instanceof Uint8Array) {
    return { type: "media", data: Buffer.from(value.image).toString("base64"), mediaType: typeof value.mediaType === "string" ? value.mediaType : "image/png" }
  }
  if (value.type === "image" && typeof value.image === "string") return { type: "image", url: value.image, mime: parseDataUrl(value.image)?.mime }
  // native Responses 的字段不同，仍消费同一 prepared 载荷。
  if (value.type === "input_image" && typeof value.image_url === "string")
    return { type: "image", url: value.image_url, mime: parseDataUrl(value.image_url)?.mime }
  if (value.type === "input_file" && typeof value.file_data === "string")
    return { type: "file", data: value.file_data, mime: "application/pdf" }
  return undefined
}

// #175：只替换 data 载荷为占位字符串
function sanitizeAttachmentRecord(value: Record<string, unknown>, input: AttachmentInput) {
  const mime = input.mime ?? input.mediaType ?? parseDataUrl(input.url ?? input.data ?? "")?.mime ?? "attachment"
  const text = placeholder({ mime, filename: input.filename })
  if (value.image instanceof Uint8Array) return { ...value, image: text }
  if (value.data instanceof Uint8Array) return { ...value, data: text }
  if (typeof value.image_url === "string" && value.image_url.startsWith("data:")) return { ...value, image_url: text }
  if (typeof value.file_data === "string" && value.file_data.startsWith("data:")) return { ...value, file_data: text }
  if (typeof value.url === "string" && value.url.startsWith("data:")) return { ...value, url: text }
  if (typeof value.data === "string") return { ...value, data: text }
  if (typeof value.image === "string" && value.image.startsWith("data:")) return { ...value, image: text }
  return value
}

// #175：返回消毒 text、raw 线长与 media 累计
export function sanitizeModelMessagesForTokenEstimate(messages: unknown): SanitizedTextEstimate {
  const result = sanitize(messages)
  const text = JSON.stringify(result.value)
  const rawChars = JSON.stringify(messages).length
  return {
    value: result.value,
    text,
    textChars: text.length,
// #175：rawChars 用未消毒 JSON 对齐 wire
    rawChars,
    // 二进制与 data URL 的 JSON 长度不同，raw→text 的差额必须对齐真实准备体。
    attachments: { ...result.attachments,
      rawChars: rawChars - text.length + result.attachments.textChars },
  }
}

export * as AttachmentToken from "./attachment-token"
