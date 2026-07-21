import type { Part } from "@opencode-ai/sdk/v2"

const GOAL_CONTINUATION_LABEL = {
  continue: "CONTINUE",
  replan: "REPLAN",
  "block-check": "BLOCK CHECK",
} as const

// exact 根标签只服务已经落库的 pre-marker 记录，正文片段和普通用户 XML 不属于 Goal 卡片。
const GOAL_CONTINUATION_ENVELOPE = /^<session-goal-continuation>\n[\s\S]*\n<\/session-goal-continuation>$/

function goalObjective(text: string) {
  const match = text.match(/<objective>([\s\S]*?)<\/objective>/)
  if (!match) return
  // producer 只转义这三种实体；amp 最后还原，避免用户原文 &lt; 被二次解码。
  return match[1].trim().replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&amp;/g, "&")
}

export function goalContinuation(parts: Part[]) {
  const part = parts.find(
    item => item.type === "text" && item.synthetic &&
      (item.metadata?.goal_continuation === true || GOAL_CONTINUATION_ENVELOPE.test(item.text)),
  )
  if (!part || part.type !== "text") return
  const objective = goalObjective(part.text)
  const storedMode = part.metadata?.goal_continuation_mode
  // 只为 shipped 历史推断缺失 mode；未知的已存值不能退回 CONTINUE 隐藏契约漂移。
  const mode =
    storedMode === "continue" || storedMode === "replan" || storedMode === "block-check"
      ? storedMode
      : storedMode === undefined
        ? part.text.includes('<strategy-switch mode="breadth-first-replan">')
          ? "replan"
          : "continue"
        : undefined
  if (!objective || !mode) return
  const turn = part.metadata?.goal_continuation_turn
  const maxTurns = part.metadata?.goal_continuation_max_turns
  // turn/max 必须是同一条消息的成对正整数，不读取当前 Goal 或按历史索引制造计数。
  const count =
    typeof turn === "number" &&
    Number.isSafeInteger(turn) &&
    turn > 0 &&
    typeof maxTurns === "number" &&
    Number.isSafeInteger(maxTurns) &&
    maxTurns > 0
      ? `${turn} / ${maxTurns}`
      : undefined
  return { objective, label: GOAL_CONTINUATION_LABEL[mode], count }
}
