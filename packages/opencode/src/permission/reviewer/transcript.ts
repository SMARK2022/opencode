import type { WithParts, Part, ToolPart } from "@opencode-ai/core/v1/session"
import type { PermissionReviewerPrompt } from "./prompt"

// #198：transcript 边界——最近 40 条消息、每 part 4000 字符上限，超出则标记 truncated 供模型识别缺失证据
// #198：40 条消息上限平衡 token 预算和上下文覆盖——足够展示最近操作历史，不超出模型上下文窗口
const ENTRY_LIMIT = 40
// #198：4000 字符上限防止单条消息过长——tool 输出可能包含大量日志，截断保留前部分
const PART_CHAR_LIMIT = 4000

export function fromMessages(messages: readonly WithParts[]): PermissionReviewerPrompt.TranscriptDelta {
  // #198：取最近 N 条——旧消息可能包含过时上下文，最近消息更能反映当前意图
  const recent = messages.slice(-ENTRY_LIMIT)
  return {
    entries: recent.map((message) => ({
      role: message.info.role,
      text: message.parts.map(renderPart).filter(Boolean).join("\n"),
    })),
    // #198：truncated 标记——messages 超过 ENTRY_LIMIT 时告知模型有缺失证据
    truncated: messages.length > recent.length,
  }
}

// #198：渲染消息 part——hidden 直接跳过，text/reasoning/tool/file/subtask/patch/agent 各有格式，其余用 <type/> 占位
function renderPart(part: Part) {
  // #198：hidden part 跳过——内部消息不纳入 reviewer 证据，防止泄露不应可见的信息
  if (part.hidden) return ""
  // #198：text part 直接截断——普通文本是最常见的 part 类型
  if (part.type === "text") return truncate(part.text)
  // #198：reasoning part 用标签包裹——区分模型的思考过程与用户可见文本
  if (part.type === "reasoning") return `<reasoning>${truncate(part.text)}</reasoning>`
  // #198：tool part 需按状态分别渲染——pending/running/completed/error 各有不同信息
  if (part.type === "tool") return renderTool(part)
  // #198：file part 用自闭合标签——mime 和 filename 供模型判断文件类型
  if (part.type === "file") return `<file mime="${part.mime}" filename="${part.filename ?? ""}" />`
  // #198：subtask part 截断 description——子任务描述可能过长，400 字符足够
  if (part.type === "subtask") return `<subtask agent="${part.agent}" description="${truncate(part.description, 400)}" />`
  // #198：patch part 仅列文件名——patch 内容可能极大，文件名足够让模型判断变更范围
  if (part.type === "patch") return `<patch files="${part.files.join(",")}" />`
  // #198：agent part 用标签——标记 agent 调用但不包含输入输出
  if (part.type === "agent") return `<agent name="${part.name}" />`
  // #198：未知 part 类型用占位标签——保留类型信息供模型识别
  return `<${part.type} />`
}

// #198：渲染 tool part——按状态 pending/running/completed/error 分别展示输入输出，超长截断
function renderTool(part: ToolPart) {
  // #198：pending 状态仅展示原始请求——尚未执行，无输入输出
  if (part.state.status === "pending") return `<tool name="${part.tool}" status="pending">${truncate(part.state.raw)}</tool>`
  // #198：running 状态展示已解析输入——执行中，无输出
  if (part.state.status === "running") {
    return `<tool name="${part.tool}" status="running">${truncate(JSON.stringify(part.state.input))}</tool>`
  }
  // #198：completed 状态展示输入和输出——title 提供人类可读摘要
  if (part.state.status === "completed") {
    return `<tool name="${part.tool}" status="completed" title="${part.state.title}">\ninput=${truncate(JSON.stringify(part.state.input))}\noutput=${truncate(part.state.output)}\n</tool>`
  }
  // #198：error 状态展示错误信息——让模型了解前次工具失败原因
  return `<tool name="${part.tool}" status="error">${truncate(part.state.error)}</tool>`
}

// #198：截断——超限部分用 <truncated chars="N" /> 标记，让模型知道有省略内容而非假设省略是无害的
function truncate(text: string, limit = PART_CHAR_LIMIT) {
  // #198：未超限直接返回——多数文本不会触发截断
  if (text.length <= limit) return text
  // #198：截断并标记省略字符数——chars 属性告知模型省略了多少内容，避免假设截断部分无关键信息
  return text.slice(0, limit) + `\n<truncated chars="${text.length - limit}" />`
}

export * as PermissionReviewerTranscript from "./transcript"
