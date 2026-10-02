import type { WithParts, Part, ToolPart } from "@opencode-ai/core/v1/session"
import type { PermissionReviewerPrompt } from "./prompt"
import type { MessageV2 } from "../../session/message-v2"

// #198：40 条消息上限平衡 token 预算和上下文覆盖——足够展示最近操作历史，不超出模型上下文窗口
const ENTRY_LIMIT = 40
// #198：4000 字符上限防止单条消息过长——tool 输出可能包含大量日志，截断保留前部分
const PART_CHAR_LIMIT = 4000
// #206：单条消息渲染上限 1000 字符——比 PART_CHAR_LIMIT 更小，防止单条消息占满 reviewer 上下文预算
const ENTRY_CHAR_LIMIT = 1000
// 问题措辞限300字符以锚定语义，用户答案在独立快照中不作条内截断。
const QA_QUESTION_LIMIT = 300
// #206：渲染后的条目附带 truncated 标记——selectEntries 和 fromMessages 用它判断 entryTruncated
type RenderedEntry = PermissionReviewerPrompt.TranscriptEntry & { truncated: boolean }

export function fromMessages(messages: readonly WithParts[]): PermissionReviewerPrompt.TranscriptDelta {
  // 授权全文归快照负责，近期窗口统一使用1000字符限额。
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

// 快照保留完整授权锚点，窗口仅按最近40条填充。
function selectEntries(entries: readonly RenderedEntry[]) {
  if (entries.length <= ENTRY_LIMIT) return { items: entries, truncated: false }
  const keep = new Set<number>()
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
  // truncate 用于 part/tool 输出截断，不保留尾部：tool 输出的尾部截断
  // 不是授权证据丢失问题，保持原有行为避免作用域蔓延
  return truncateWithFlag(text, limit).text
}

// #206：截断并返回标记——让 fromMessages 区分整条省略与条目内截短，分别设 truncated 和 entryTruncated
function truncateWithFlag(text: string, limit = PART_CHAR_LIMIT) {
  // 显式披露窗口缺失量，不能把截断尾部当作无害或完整授权。
  if (text.length <= limit) return { text, truncated: false }
  return { text: text.slice(0, limit) + `\n<truncated chars="${text.length - limit}" />`, truncated: true }
}

// 两代共用Core纯数据合同，授权全文和用户答案均独立于滚动窗口。
export type ReviewerSnapshotEntryUser = PermissionReviewerPrompt.ReviewerSnapshotEntryUser
export type ReviewerSnapshotEntryUserDup = PermissionReviewerPrompt.ReviewerSnapshotEntryUserDup
export type ReviewerSnapshotEntryQA = PermissionReviewerPrompt.ReviewerSnapshotEntryQA
export type ReviewerSnapshotEntryDecision = PermissionReviewerPrompt.ReviewerSnapshotEntryDecision
export type ReviewerSnapshotEntry = PermissionReviewerPrompt.ReviewerSnapshotEntry

export type ReviewerSnapshot = PermissionReviewerPrompt.ReviewerSnapshot
export type ReviewerTranscript = PermissionReviewerPrompt.ReviewerTranscript

export function fromEvidence(input: {
  snapshot: MessageV2.ReviewerEvidence
  window: readonly WithParts[]
}): ReviewerTranscript {
  const merged = [
    ...input.snapshot.user.map((row) => ({ time: row.time, entry: { kind: "user", text: row.text } satisfies ReviewerSnapshotEntry })),
    ...input.snapshot.tools.flatMap(qaEntries),
    ...input.snapshot.tools.flatMap(decisionEntries),
  ].sort((left, right) => left.time - right.time)
  // 首个精确文本为全文锚点，重复GOAL块仅输出指向该锚点的标记以稳定缓存前缀。
  const anchorByText = new Map<string, number>()
  const entries: ReviewerSnapshotEntry[] = []
  for (const { entry } of merged) {
    if (entry.kind !== "user") {
      entries.push(entry)
      continue
    }
    const anchor = anchorByText.get(entry.text)
    if (anchor !== undefined) {
      entries.push({ kind: "userDup", ofIndex: anchor, chars: entry.text.length })
      continue
    }
    entries.push(entry)
    // ofIndex 是锚点在最终 entries 中的 1-based 位置，渲染标记据此指向 uK。
    anchorByText.set(entry.text, entries.length)
  }
  return {
    snapshot: {
      entries,
      userOmitted: input.snapshot.userOmitted,
      decisionsOmitted: input.snapshot.decisionsOmitted,
      emptyUserEvidence: input.snapshot.user.length === 0 && input.snapshot.tools.length === 0,
    },
    window: fromMessages(input.window),
  }
}

// 问题仅锚定语义，metadata中的真实用户答案全文保留；坏JSON沿source跳过单行。
function qaEntries(row: MessageV2.ReviewerEvidenceTool): { time: number; entry: ReviewerSnapshotEntry }[] {
  if (row.tool !== "question" || row.stateStatus !== "completed") return []
  try {
    const questions = (JSON.parse(row.input ?? "{}") as { questions?: { question?: unknown }[] }).questions ?? []
    const answers = (JSON.parse(row.answers ?? "[]") as unknown[][]) ?? []
    return questions.flatMap((item, index) => {
      if (typeof item?.question !== "string" || !item.question.trim()) return []
      const answer = (Array.isArray(answers[index]) ? answers[index] : [])
        .filter((option): option is string => typeof option === "string")
        .join(", ")
      if (!answer) return []
      const question = item.question.length > QA_QUESTION_LIMIT ? item.question.slice(0, QA_QUESTION_LIMIT) + "…" : item.question
      return [{ time: row.time, entry: { kind: "qa", question, answer } satisfies ReviewerSnapshotEntry }]
    })
  } catch {
    return []
  }
}

// 用户拒绝签名与 permission/index.ts 的 RejectedError 文案前缀共享：新旧文案
// 在历史 part 上共存（文案迭代不迁移存量数据），稳定前缀是两者的公共部分。
const USER_REJECTED_SIGNATURE = "The user rejected permission"

// 只投影真实reviewer决定或人工应答，普通completed和基础设施失败不构成授权。
function decisionEntries(row: MessageV2.ReviewerEvidenceTool): { time: number; entry: ReviewerSnapshotEntry }[] {
  if (row.tool === "question") return []
  const label = decisionLabel(row)
  return label ? [{ time: row.time, entry: { kind: "decision", label } as ReviewerSnapshotEntry }] : []
}

function decisionLabel(row: MessageV2.ReviewerEvidenceTool) {
  if (row.error?.startsWith(USER_REJECTED_SIGNATURE)) return `[PERMISSION: USER-REJECTED] ${row.tool}`
  if (row.stateStatus === "completed" && row.autoReviewStatus === "fallback_user")
    return `[PERMISSION: USER-ALLOWED-AFTER-ASK] ${row.tool}`
  if (row.autoReviewStatus === "denied")
    return `[AUTO-REVIEW: DENIED] ${row.tool}${row.autoReviewRationale ? ` — ${row.autoReviewRationale}` : ""}`
  if (row.autoReviewStatus === "allowed") return `[AUTO-REVIEW: ALLOWED] ${row.tool}`
  return undefined
}

export * as PermissionReviewerTranscript from "./transcript"
