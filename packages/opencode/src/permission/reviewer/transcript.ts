import type { WithParts, Part, ToolPart } from "@opencode-ai/core/v1/session"
import type { PermissionReviewerPrompt } from "./prompt"

// #198：40 条消息上限平衡 token 预算和上下文覆盖——足够展示最近操作历史，不超出模型上下文窗口
const ENTRY_LIMIT = 40
// #198：4000 字符上限防止单条消息过长——tool 输出可能包含大量日志，截断保留前部分
const PART_CHAR_LIMIT = 4000
// #206：单条消息渲染上限 1000 字符——比 PART_CHAR_LIMIT 更小，防止单条消息占满 reviewer 上下文预算
const ENTRY_CHAR_LIMIT = 1000
// #206：渲染后的条目附带 truncated 标记——selectEntries 和 fromMessages 用它判断 entryTruncated
type RenderedEntry = PermissionReviewerPrompt.TranscriptEntry & { truncated: boolean }

export function fromMessages(messages: readonly WithParts[]): PermissionReviewerPrompt.TranscriptDelta {
  // #206：保留首条用户轮次和最近尾部——首条用户轮次通常包含原始授权，最近轮次解释重试和当前范围
  // #206：过滤 hidden 消息——page 默认 includeHidden=false 已过滤，此处显式过滤保持 fromMessages 独立可用
  const visibleMessages = messages.filter((message) => !message.info.hidden)
  const rendered = visibleMessages.map((message) => {
      const text = message.parts.map(renderPart).filter((part): part is string => Boolean(part?.trim())).join("\n")
      const entry = truncateWithFlag(text, ENTRY_CHAR_LIMIT)
      return {
        role: message.info.role,
        text: entry.text,
        truncated: entry.truncated,
      }
    })
  // #206：过滤渲染后无可见文本的条目——reasoning/synthetic 被排除后可能整条消息为空，需单独标记 emptyEntries
  const visibleRendered = rendered.filter((entry) => entry.text.trim())
  const entries = selectEntries(visibleRendered)
  return {
    entries: entries.items.map((entry) => ({ role: entry.role, text: entry.text })),
    truncated: entries.truncated,
    entryTruncated: entries.items.some((entry) => entry.truncated),
    emptyEntries: visibleMessages.length > visibleRendered.length,
  }
}

// #206：选择策略——不超过 ENTRY_LIMIT 时全保留；超出时保留首条用户、最新用户和最近尾部
function selectEntries(entries: readonly RenderedEntry[]) {
  if (entries.length <= ENTRY_LIMIT) return { items: entries, truncated: false }
  const keep = new Set<number>()
  const userIndexes = entries.flatMap((entry, index) => (entry.role === "user" ? [index] : []))
  // #206：首条用户轮次包含原始授权——即使截短也需保留作为授权锚点
  if (userIndexes[0] !== undefined) keep.add(userIndexes[0])
  const latestUserIndex = userIndexes.at(-1)
  // #206：最新用户轮次解释当前范围和重试——与首条锚点配合覆盖授权意图的演变
  if (latestUserIndex !== undefined) keep.add(latestUserIndex)
  // #206：从尾部向前填充至 ENTRY_LIMIT——优先保留最新上下文，首条和最新用户已由锚点保留
  for (let index = entries.length - 1; index >= 0 && keep.size < ENTRY_LIMIT; index--) {
    keep.add(index)
  }
  return {
    items: Array.from(keep)
      .sort((left, right) => left - right)
      .map((index) => entries[index]),
    truncated: true,
  }
}

// #206：hidden/synthetic/reasoning 不是用户授权证据——仿 Codex guardian，reviewer 看可见对话和工具证据，不看内部思考
function renderPart(part: Part) {
  if (part.hidden) return ""
  // #206：synthetic 文本不是用户输入——协议生成的上下文不应被误认为用户授权
  if (part.type === "text" && part.synthetic) return ""
  // #209：reviewer 子会话请求 cell 是协议记录而非人类授权——排除以免被误认为授权证据
  // #209：用 metadata 而非 synthetic 标记——请求 cell 需在子会话中可见可审计，仅在 transcript 投影给 reviewer 时排除
  // #209：此排除防止增量审查把上一轮 reviewer 自身请求当作新的用户授权——否则 reviewer 会自我批准
  if (part.type === "text" && part.metadata?.permissionReviewerRequest === true) return ""
  // #206：reasoning 是模型内部思考——不应作为授权证据，否则 reviewer 可能过度信任 agent 自身理由
  if (part.type === "reasoning") return ""
  if (part.type === "text") return truncate(part.text)
  if (part.type === "tool") return renderTool(part)
  if (part.type === "file") return `<file mime="${part.mime}" filename="${part.filename ?? ""}" />`
  if (part.type === "subtask") return `<subtask agent="${part.agent}" description="${truncate(part.description, 400)}" />`
  if (part.type === "patch") return `<patch files="${part.files.join(",")}" />`
  if (part.type === "agent") return `<agent name="${part.name}" />`
  return `<${part.type} />`
}

// #198：渲染 tool part——按状态 pending/running/completed/error 分别展示输入输出，超长截断
function renderTool(part: ToolPart) {
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
  return truncateWithFlag(text, limit).text
}

// #206：截断并返回标记——让 fromMessages 区分整条省略与条目内截短，分别设 truncated 和 entryTruncated
function truncateWithFlag(text: string, limit = PART_CHAR_LIMIT) {
  if (text.length <= limit) return { text, truncated: false }
  return { text: text.slice(0, limit) + `\n<truncated chars="${text.length - limit}" />`, truncated: true }
}

export * as PermissionReviewerTranscript from "./transcript"
