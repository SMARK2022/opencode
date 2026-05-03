export * as Token from "./token"

import type { SessionMessage } from "@opencode-ai/schema/session-message"

export type SystemSection = { readonly kind: "instructions" | "skills"; readonly text: string }
type Bucket = Exclude<keyof SessionMessage.InputBreakdown, "messages"> | Exclude<keyof SessionMessage.InputBreakdown["messages"], "total">
type Node = {
  bucket: Bucket
  section: "body" | "system" | "messages" | "tools" | "options"
  role?: string
  entries: number
}
const CHARS_PER_TOKEN = 4

export const estimate = (input: string) => Math.max(0, Math.round(input.length / CHARS_PER_TOKEN))

export function charsPerTokenFromHistory(history: ReadonlyArray<{ bodyChars: number; input: number }>) {
  const sample = history.reduce((sum, item) => {
    // 调用方筛选同 API 的确认样本；分子分母同时截止，零确认和不足100字符的样本不校准。
    if (sum.bodyChars >= 100_000 || !Number.isFinite(item.input) || !Number.isFinite(item.bodyChars) || item.input <= 0 || item.bodyChars < 100) return sum
    return { bodyChars: sum.bodyChars + item.bodyChars, input: sum.input + item.input }
  }, { bodyChars: 0, input: 0 })
  // 不足 500 字符或零确认不构成比率样本，首轮继续使用通用 /4。
  return sample.bodyChars > 500 && sample.input > 0 ? sample.bodyChars / sample.input : CHARS_PER_TOKEN
}

export function estimateRequest(body: unknown, history: ReadonlyArray<{ bodyChars: number; input: number }>, sections?: ReadonlyArray<SystemSection>) {
  const ratio = charsPerTokenFromHistory(history)
  const counts = {
    system: 0, instructions: 0, skills: 0, tools: 0,
    messages: { userText: 0, assistantText: 0, reasoning: 0, toolInput: 0, toolOutput: 0, attachments: 0, total: 0 },
  } satisfies SessionMessage.InputBreakdown
  const nodes = new WeakMap<object, Node>()
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
    if (section === "messages") {
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
        if (key === "functionCall") bucket = "toolInput"
        if (key === "functionResponse") bucket = "toolOutput"
      }
    }
    // 属性名、冒号和逗号归同一载荷；遗漏这些结构会让 JSON-heavy 输入的分类总和偏小。
    const prefix = parent ? (parent.entries++ > 0 ? 1 : 0) + (Array.isArray(this) ? 0 : stringChars(key) + 1) : 0
    // JSON 原生会拆箱 Number/String/Boolean，不能把它们误计成空对象的两个字符。
    const scalar = value instanceof String || value instanceof Number || value instanceof Boolean ? value.valueOf() : value
    const chars = absent || scalar === null ? 4 : typeof scalar === "string" ? stringChars(scalar)
      : typeof scalar === "number" ? Number.isFinite(scalar) ? String(scalar).length : 4
      : typeof scalar === "boolean" ? scalar ? 4 : 5 : 2
    if (section === "system" && typeof scalar === "string" && sections) {
      // 仅匹配服务端 source 真正渲染的片段；插件删除或改写的文本不会凭本地文件重新补回。
      const spans = sections.flatMap((item) => {
        const found: Array<{ start: number; end: number; kind: SystemSection["kind"]; text: string }> = []
        if (!item.text) return found
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
      counts.system += prefix + chars - attributed
    } else if (bucket === "system" || bucket === "instructions" || bucket === "skills" || bucket === "tools") {
      counts[bucket] += prefix + chars
    } else {
      counts.messages[bucket] += prefix + chars
    }
    // 同一对象在请求内重复引用时每次重新开始计数，WeakMap 不能成为省略第二次载荷的缓存。
    if (value !== null && typeof value === "object") nodes.set(value, { bucket, section, role, entries: 0 })
    return value
  }).length
  // total 只求和六个消息桶，不能用 bodyChars 补残差来掩盖 system 或转义计数的遗漏。
  counts.messages.total = counts.messages.userText + counts.messages.assistantText + counts.messages.reasoning + counts.messages.toolInput + counts.messages.toolOutput + counts.messages.attachments
  // 不请求细分的既有纯估算调用保留返回契约；两个运行时 owner 均显式请求该元数据。
  return { input: Math.max(0, Math.round(bodyChars / ratio)), bodyChars, confirmed: false,
    ...(sections === undefined ? {} : { charsPerToken: ratio, inputBreakdown: counts }) }
}

function stringChars(value: string) {
  // JSON 的控制字符与孤立 surrogate 会转义；有效 Unicode pair 仍按原有 UTF-16 字符口径计数。
  return value.length + 2 + Array.from(value.matchAll(/["\\\u0000-\u001f]|[\ud800-\udfff]/gu)).reduce((sum, match) =>
    sum + (/["\\\b\f\n\r\t]/u.test(match[0]) ? 1 : 5), 0)
}
