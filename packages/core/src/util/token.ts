export * as Token from "./token"

import type { SessionMessage } from "@opencode-ai/schema/session-message"
import { AttachmentToken } from "./attachment-token"

export type SystemSection = { readonly kind: "system" | "instructions" | "skills"; readonly text: string }
type Bucket = Exclude<keyof SessionMessage.InputBreakdown, "messages" | "media"> | Exclude<keyof SessionMessage.InputBreakdown["messages"], "total">
type Node = {
  bucket: Bucket
  section: "body" | "system" | "messages" | "tools" | "options"
  role?: string
  entries: number
  media?: boolean
  literal?: boolean
  mime?: string
}
const CHARS_PER_TOKEN = 4
// 使用最近20个助手确认点描述当前模型，窗口大小同时限定每次估算的学习工作量。
export const INPUT_RATIO_HISTORY_SAMPLES = 20

/** 一次已发送请求的测量值：序列化字符、provider确认输入和载荷分类来自同一个step。 */
export type InputSample = {
  readonly bodyChars: number
  // input已经包含普通输入与cache.read/cache.write，表示该请求完整上下文的使用量。
  readonly input: number
  readonly inputBreakdown?: {
    // reasoning按序列化字符记录加密和可见推理；旧数据可以没有这些分类字段。
    readonly messages?: { readonly reasoning?: number; readonly attachments?: number }
    // media把二进制载荷的原始字符、模型可见占位字符和独立token预算联系起来。
    readonly media?: { readonly rawChars: number; readonly textChars: number; readonly tokens: number }
  }
}

export const estimate = (input: string) => Math.max(0, Math.round(input.length / CHARS_PER_TOKEN))

/** 从native历史提取同API的已确认输入，返回按时间从新到旧排列的可重复消费数组。 */
export function inputHistory(messages: ReadonlyArray<SessionMessage.Message>, model: { provider: string; id: string }) {
  const history: InputSample[] = []
  for (let index = messages.length - 1; index >= 0 && history.length < INPUT_RATIO_HISTORY_SAMPLES; index--) {
    const message = messages[index]
    // provider/model共同标识API编码和模型行为，只有同组确认量能校准当前请求。
    if (message.type !== "assistant" || String(message.model.providerID) !== String(model.provider) || String(message.model.id) !== String(model.id)
      || !message.inputEstimate?.confirmed || !message.tokens) continue
    // confirmed标记把这次bodyChars与本次usage绑定，缓存读写也计入上下文分母。
    const sample = { bodyChars: message.inputEstimate.bodyChars, inputBreakdown: message.inputEstimate.inputBreakdown,
      input: message.tokens.input + message.tokens.cache.read + message.tokens.cache.write }
    if (inputRatioSample(sample)) history.push(sample)
  }
  return history
}

/** 把一个确认点归一为可用于学习的文本字符、非媒体输入和可选reasoning字符。 */
export function inputRatioSample(item: InputSample) {
  // 有限正用量和至少100字符提供稳定的密度观测，过短文本不承担模型校准。
  if (!Number.isFinite(item.input) || !Number.isFinite(item.bodyChars) || item.input <= 0 || item.bodyChars < 100) return undefined
  const media = item.inputBreakdown?.media
  const input = item.input - (media?.tokens ?? 0)
  // 已知媒体预算从文本分母分离，正文只使用模型可见的占位字符。
  // 旧附件缺少media.tokens时无法完成这项分离，因此该点保留在历史中而不参与学习。
  if (input <= 0 || (!media && (item.inputBreakdown?.messages?.attachments ?? 0) > 0)) return undefined
  return { chars: Math.max(0, item.bodyChars - (media?.rawChars ?? 0) + (media?.textChars ?? 0)), input,
    reasoning: item.inputBreakdown?.messages?.reasoning }
}

/**
 * 从确认历史学习text与reasoning的字符/token密度。
 *
 * 完整分类样本求解 I = a*T + b*R，其中T为普通字符、R为推理字符，a/b为每token字符的倒数。
 * 学习结果再用最近确认点的真实输入缩放，使载荷组成变化与provider的绝对使用量同时进入估算。
 */
export function learnInputRatios(history: Iterable<InputSample>) {
  const all = { count: 0, chars: 0 }
  // fit累加二元正规方程所需的平方项和交叉项，避免逐请求重复处理正文。
  const fit = { chars: 0, input: 0, tt: 0, rr: 0, tr: 0, ti: 0, ri: 0 }
  let latest: ReturnType<typeof inputRatioSample>
  for (const item of history) {
    const sample = inputRatioSample(item)
    if (!sample) continue
    latest ??= sample
    all.chars += sample.chars
    if (sample.reasoning !== undefined) {
      const text = sample.chars - sample.reasoning
      fit.chars += sample.chars
      fit.input += sample.input
      fit.tt += text * text
      fit.rr += sample.reasoning * sample.reasoning
      fit.tr += text * sample.reasoning
      fit.ti += text * sample.input
      fit.ri += sample.reasoning * sample.input
    }
    // 缺reasoning字段的旧点仍参与总样本门槛和最近点选择，二元拟合只读取有分类的点。
    if (++all.count >= INPUT_RATIO_HISTORY_SAMPLES) break
  }
  if (!latest || all.chars <= 500) return undefined
  // 单点、单桶或共线样本能确定混合密度；两个区间分别约束正文和推理的极端值。
  const pooled = Math.max(2, latest.chars / latest.input)
  const mixed = { text: Math.min(8, pooled), reasoning: Math.min(32, pooled) }
  const det = fit.tt * fit.rr - fit.tr * fit.tr
  // 行列式相对规模衡量两个组成轴是否可区分，过小则采用上面的混合密度。
  if (latest.reasoning === undefined || fit.chars <= 500 || fit.input <= 0 || det <= 0 || det < 0.01 * fit.tt * fit.rr) return mixed
  const text = (fit.ti * fit.rr - fit.ri * fit.tr) / det
  const reasoning = (fit.ri * fit.tt - fit.ti * fit.tr) / det
  if (text <= 0 || reasoning <= 0) return mixed
  const ratio = { text: Math.min(8, Math.max(2, 1 / text)), reasoning: Math.min(32, Math.max(2, 1 / reasoning)) }
  // scale让拟合公式在最近bodyChars上重算的输入与该点provider usage相等。
  // 两个密度同乘scale后保留正文与推理的相对组成，同时跟随最近的绝对使用量。
  const scale = ((latest.chars - latest.reasoning) / ratio.text + latest.reasoning / ratio.reasoning) / latest.input
  return { text: Math.min(8, Math.max(2, ratio.text * scale)), reasoning: Math.min(32, Math.max(2, ratio.reasoning * scale)) }
}

export function charsPerTokenFromHistory(history: Iterable<InputSample>) {
  // scalar 合同用于文本尾部增量，与请求估算共用学习结果。
  return learnInputRatios(history)?.text ?? CHARS_PER_TOKEN
}

/** 在一次JSON遍历中测量实际请求，再按学习到的两类密度折算输入token。 */
export function estimateRequest(body: unknown, history: Iterable<InputSample>, sections?: ReadonlyArray<SystemSection>) {
  const ratio = learnInputRatios(history) ?? { text: CHARS_PER_TOKEN, reasoning: CHARS_PER_TOKEN }
  const counts = {
    system: 0, instructions: 0, skills: 0, tools: 0,
    messages: { userText: 0, assistantText: 0, reasoning: 0, toolInput: 0, toolOutput: 0, attachments: 0, total: 0 },
  } satisfies SessionMessage.InputBreakdown
  const nodes = new WeakMap<object, Node>()
  // 媒体沿同一个 JSON visitor 统计；getter、toJSON 与原 provider body 仍只观察一次。
  const media = AttachmentToken.estimateAttachment({})
  // 唯一 stringify 的 visitor 同时计数，既不重跑 Schema parser，也不按子树再次序列化。
  const bodyChars = JSON.stringify(body, function(this: object, key: string, value: unknown) {
    const parent = nodes.get(this)
    // 对象的 undefined/function/symbol 不上 wire；数组同值是 null，必须沿 JSON 的两种规则计数。
    const absent = value === undefined || typeof value === "function" || typeof value === "symbol"
    if (absent && !Array.isArray(this)) return value
    let bucket = parent?.bucket ?? "system"
    let section = parent?.section ?? "body"
    // 子片段继承父载荷，工具结果里的附件还能细分，不能把包装字段重归用户正文。
    let role = parent?.role
    // 工具参数和JSON结果保留正文语义，其中的MIME、data或文件路径不能变成媒体预算。
    const literal = parent?.literal || key === "providerOptions" || (parent?.bucket === "toolInput" && ["input", "args", "arguments"].includes(key))
      || (parent?.bucket === "toolOutput" && ["json", "response"].includes(key))
      || (key === "value" && "type" in this && (this.type === "json" || this.type === "error-json"))
    if (parent?.section === "body") {
      // 只在请求根识别广告与历史，工具参数里同名 messages/tools 字段不能跨桶。
      if (key === "tools") { section = "tools"; bucket = "tools" }
      if (key === "messages" || key === "input" || key === "contents") { section = "messages"; bucket = "userText" }
      if (key === "system" || key === "instructions" || key === "systemInstruction") section = "system"
      if (key === "providerOptions") section = "options"
      if (section === "body") section = "options"
    }
    // SDK 的 OAuth instructions 与 native 的 system 都来自已经准备完成的正文。
    if (section === "options" && (key === "instructions" || key === "system")) section = "system"
    if (section === "messages" && !literal) {
      // Anthropic 的工具结果包在 user 消息中，角色只决定默认桶，片段身份随后覆盖它。
      if (value !== null && typeof value === "object" && "role" in value && typeof value.role === "string") {
        role = value.role
        bucket = role === "assistant" || role === "model" ? "assistantText" : role === "tool" ? "toolOutput" : "userText"
      }
      // Chat 的 system/developer 消息不再重复进入 messages.total。
      if (role === "system" || role === "developer") { section = "system"; bucket = "system" }
      if (section === "messages") {
        const type = value !== null && typeof value === "object" && "type" in value ? value.type : undefined
        // Responses 的独立 function_call 与 Chat.tool_calls 都是历史调用，不属于工具定义广告。
        if (["tool-call", "tool_use", "function_call"].includes(typeof type === "string" ? type : "") || key === "tool_calls" || key === "function_call") bucket = "toolInput"
        // 返回片段按自己的身份归下一轮输入，即使外层协议角色不是 tool。
        if (["tool-result", "tool_result", "function_call_output"].includes(typeof type === "string" ? type : "")) bucket = "toolOutput"
        // 签名或加密的 reasoning 结构也属于实际载荷，不能只计可见思考正文。
        if (["reasoning", "thinking", "redacted_thinking", "reasoning_text"].includes(typeof type === "string" ? type : "") || key === "reasoning_content") bucket = "reasoning"
        // 附件只记录实际 JSON 字符，不再次解码 base64 或套用客户端视觉 token 启发式。
        if (["image", "image_url", "input_image", "input_file", "file", "document", "media", "audio", "input_audio", "video"].includes(typeof type === "string" ? type : "") || key === "inlineData" || key === "fileData") bucket = "attachments"
        // Gemini 的调用/结果使用不同字段判别，不能因缺少共享 type 就退回正文桶。
        if (key === "functionCall" || key === "toolUse") bucket = "toolInput"
        if (key === "functionResponse" || key === "toolResult") bucket = "toolOutput"
      }
    }
    // 属性名、冒号和逗号归同一载荷；遗漏这些结构会让 JSON-heavy 输入的分类总和偏小。
    const prefix = parent ? (parent.entries++ > 0 ? 1 : 0) + (Array.isArray(this) ? 0 : stringChars(key) + 1) : 0
    // JSON 原生会拆箱 Number/String/Boolean，不能把它们误计成空对象的两个字符。
    const scalar = value instanceof String || value instanceof Number || value instanceof Boolean ? value.valueOf() : value
    const chars = absent || scalar === null ? 4 : typeof scalar === "string" ? stringChars(scalar)
      : typeof scalar === "number" ? Number.isFinite(scalar) ? String(scalar).length : 4
      : typeof scalar === "boolean" ? scalar ? 4 : 5 : 2
    // Buffer 在 JSON visitor 前已执行 toJSON，必须识别其原生字节形态而非再序列化。
    const bytes = value instanceof Uint8Array ? value
      : value !== null && typeof value === "object" && "type" in value && value.type === "Buffer" && "data" in value && Array.isArray(value.data)
        ? Buffer.from(value.data) : undefined
    const source = this as Record<string, unknown>
    const mime = [source.mediaType, source.mimeType, source.media_type, source.mime, parent?.mime].find((value): value is string => typeof value === "string")
    // MIME和载荷确定媒体身份；内联base64直接计量，data URL与远程引用沿用原解析。
    if (section === "messages" && !literal && mime && ["data", "image", "url", "image_url", "file_data", "bytes"].includes(key)) bucket = "attachments"
    const binary = bucket === "attachments" && bytes !== undefined && ["data", "image", "bytes"].includes(key)
    const attachment = binary
      ? AttachmentToken.estimateAttachment({ type: "media", data: Buffer.from(bytes).toString("base64"),
          mediaType: mime ?? "image/png" })
      : bucket === "attachments" && typeof scalar === "string" && ["data", "image", "url", "image_url", "file_data", "bytes"].includes(key)
        ? AttachmentToken.estimateAttachment({ type: scalar.includes(":") || scalar.startsWith("//") ? "file" : "media", url: scalar, data: scalar,
            // Anthropic 的已校验 source 使用 media_type，不能把图片预算退成 base64 文本预算。
            mediaType: mime }) : undefined
    if (attachment?.count) {
      for (const field of ["tokens", "textChars", "count", "imageTokens", "pdfTokens", "otherTokens"] as const)
        media[field] += attachment[field]
      // 字符串外引号保留；二进制对象的实际 JSON 长度由后续子节点计入，不另做 stringify。
      if (!binary) media.rawChars += chars - 2
    }
    if (parent?.media) media.rawChars += prefix + chars
    if ((section === "system" || section === "messages" && bucket === "userText") && typeof scalar === "string" && sections) {
      // 仅匹配服务端 source 真正渲染的片段；插件删除或改写的文本不会凭本地文件重新补回。
      const spans = sections.flatMap((item) => {
        const found: Array<{ start: number; end: number; kind: SystemSection["kind"]; text: string }> = []
        // user历史仅接受明确的系统reminder归属，不能把普通用户文字认作指令或skill。
        if (!item.text || section !== "system" && item.kind !== "system") return found
        for (let start = scalar.indexOf(item.text); start >= 0; start = scalar.indexOf(item.text, start + item.text.length))
          found.push({ start, end: start + item.text.length, kind: item.kind, text: item.text })
        return found
      }).toSorted((a, b) => a.start - b.start || b.end - a.end)
      let end = 0
      let attributed = 0
      for (const span of spans) {
        // 同一 source 的重叠/重复来源只能消费一遍，system 保留分隔符与未归属默认正文。
        if (span.start < end) continue
        const size = stringChars(span.text) - 2
        counts[span.kind] += size
        attributed += size
        end = span.end
      }
      // 只转移匹配的转义后正文；原消息结构和未匹配字符仍留user桶，实际body总长不变。
      if (section === "system") counts.system += prefix + chars - attributed
      else counts.messages.userText += prefix + chars - attributed
    } else if (bucket === "system" || bucket === "instructions" || bucket === "skills" || bucket === "tools") {
      counts[bucket] += prefix + chars
    } else {
      counts.messages[bucket] += prefix + chars
    }
    // 同一对象在请求内重复引用时每次重新开始计数，WeakMap 不能成为省略第二次载荷的缓存。
    if (value !== null && typeof value === "object") nodes.set(value, { bucket, section, role, entries: 0, media: binary || parent?.media, literal,
      mime: key === "image" && "format" in value ? `image/${value.format}` : key === "document" && "format" in value ? value.format === "pdf" ? "application/pdf" : "application/octet-stream" : mime,
    })
    return value
  }).length
  // total 只求和六个消息桶，不能用 bodyChars 补残差来掩盖 system 或转义计数的遗漏。
  counts.messages.total = counts.messages.userText + counts.messages.assistantText + counts.messages.reasoning + counts.messages.toolInput + counts.messages.toolOutput + counts.messages.attachments
  // 正文包含系统、普通消息、工具定义/结果和选项；reasoning从其中分出并使用自己的密度。
  // 媒体使用AttachmentToken的独立预算，包装与占位字符仍留在正文折算中。
  const input = Math.max(0, Math.round((bodyChars - media.rawChars + media.textChars - counts.messages.reasoning) / ratio.text
    + counts.messages.reasoning / ratio.reasoning)) + media.tokens
  // 不请求细分时保留原有返回形状；显式传入sections时一并交付文本密度和分类测量。
  return { input, bodyChars, confirmed: false,
    ...(sections === undefined ? {} : { charsPerToken: ratio.text, inputBreakdown: {
      ...counts, ...(media.count > 0 ? { media } : {}),
    } }) }
}

function stringChars(value: string) {
  // JSON 的控制字符与孤立 surrogate 会转义；有效 Unicode pair 仍按原有 UTF-16 字符口径计数。
  return value.length + 2 + Array.from(value.matchAll(/["\\\u0000-\u001f]|[\ud800-\udfff]/gu)).reduce((sum, match) =>
    sum + (/["\\\b\f\n\r\t]/u.test(match[0]) ? 1 : 5), 0)
}
