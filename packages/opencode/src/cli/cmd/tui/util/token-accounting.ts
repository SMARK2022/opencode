/**
 * token-accounting.ts — 统一 token 统计入口
 *
 * 设计原则：
 * - 一个函数 `tokenAccounting()`，一个类型 `TokenAccounting`
 * - 一次遍历完成所有统计
 * - 有确定（step-finish confirmed）用确定，没有用 estimate（chars / ratio）
 * - 所有消费端读同一份结果
 * - 不做 TUI 端 prompt 重建；token 数字始终来自 daemon 的 inputBreakdown → 精确分配
 *
 * 核心公式（step-finish 后）：
 *   category_tokens = round((category_chars / inputChars_total) × confirmedInputTokens)
 * 这不是"估计"，是按字符占比精确分配已确认 token 总量。
 */

import { estimateDataUrlInputTokens } from "./token-estimate"

const DEFAULT_RATIO = 4

// ─── 类型 ────────────────────────────────────────────────────────────────────

export type TokenAccounting = {
  /** 当前（最后一个）step 的 token 统计 */
  step: {
    input: number
    output: number
    confirmed: boolean
  }
  /** 当前 user request（agent loop）累计。
   *  外层 input/output = 当前 step；括号里的 totalInput/totalOutput = 全 request 累计 */
  request: {
    input: number
    output: number
    totalInput: number
    totalOutput: number
    cost: number
  }
  /** 整个 session 累计 */
  session: {
    input: number
    output: number
    reasoning: number
    cacheRead: number
    cacheWrite: number
    cost: number
  }
  /** model context limit */
  contextLimit: number
  /** (step.input + step.output) / contextLimit；无 limit 为 null */
  contextPercent: number | null
  /**
   * 上下文窗口各组件精确分配。
   * 有 latest assistant 的 step-finish + inputBreakdown 时可用；否则 null。
   */
  breakdown: {
    system: number
    instructions: number
    skills: number
    tools: number
    userMessages: number
    toolResults: number
    attachments: number
    assistantText: number
    reasoning: number
    toolCalls: number
    pending: number
  } | null
  ratio: { input: number; output: number }
}

// ─── 内部类型 ─────────────────────────────────────────────────────────────────

type Msg = {
  id: string
  role: string
  parentID?: string
  cost?: number
  tokens?: { input: number; output: number; reasoning: number; cache: { read: number; write: number } }
  time?: { created?: number; completed?: number }
}

type Pt = { id?: string; type: string; [key: string]: any }

// ─── 主函数 ──────────────────────────────────────────────────────────────────

export function tokenAccounting(
  messages: ReadonlyArray<Msg>,
  getParts: (id: string) => ReadonlyArray<Pt>,
  contextLimit?: number,
): TokenAccounting {
  // ── 1. lastUser / requestAssistantIDs ──
  const lastUser = messages.findLast((m) => m.role === "user")
  const requestAssistantIDs = new Set<string>()
  if (lastUser) {
    for (const m of messages) {
      if (m.role === "assistant" && m.parentID === lastUser.id) requestAssistantIDs.add(m.id)
    }
  }

  // ── 2. 一次遍历 ──
  const session = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }
  const confirmedRequest = { input: 0, output: 0, cost: 0 }
  let ratioChars = 0
  let ratioTokens = 0
  let outputCharsTotal = 0
  let outputTokensTotal = 0
  let latestAssistant: Msg | undefined

  for (const msg of messages) {
    if (msg.role !== "assistant") continue
    latestAssistant = msg
    const parts = getParts(msg.id)
    const isRequest = requestAssistantIDs.has(msg.id)
    let msgHasFinish = false

    for (let i = 0; i < parts.length; i++) {
      const p = parts[i]
      if (p.type !== "step-finish") continue
      msgHasFinish = true

      session.input += p.tokens.input
      session.output += p.tokens.output
      session.reasoning += p.tokens.reasoning
      session.cacheRead += p.tokens.cache.read
      session.cacheWrite += p.tokens.cache.write
      session.cost += p.cost ?? 0

      if (isRequest) {
        confirmedRequest.input += p.tokens.input + p.tokens.cache.read + p.tokens.cache.write
        confirmedRequest.output += p.tokens.output + p.tokens.reasoning
        confirmedRequest.cost += p.cost ?? 0
      }

      // input ratio 校准
      const chars = p.inputChars as number | undefined
      if (chars && chars >= 100) {
        const tok = p.tokens.input + p.tokens.cache.read + p.tokens.cache.write
        if (tok > 0) {
          const bd = p.inputBreakdown as { messages?: { attachments?: number } } | undefined
          ratioChars += Math.max(0, chars - (bd?.messages?.attachments ?? 0))
          ratioTokens += tok
        }
      }

      // output ratio 校准
      const confirmedOut = p.tokens.output + p.tokens.reasoning
      if (confirmedOut > 0) {
        let stepChars = 0
        const startIdx = parts.slice(0, i).findLastIndex((x) => x.type === "step-start")
        for (let j = (startIdx >= 0 ? startIdx + 1 : 0); j < i; j++) {
          const sp = parts[j]
          if (sp.type === "text" && !sp.ignored) stepChars += (sp.text?.length ?? 0)
          if (sp.type === "reasoning") stepChars += (sp.text?.length ?? 0)
          if (sp.type === "tool") {
            stepChars += sp.state?.status === "pending"
              ? (sp.state.raw?.length ?? 0)
              : JSON.stringify(sp.state?.input ?? {}).length
          }
        }
        if (stepChars > 0) { outputCharsTotal += stepChars; outputTokensTotal += confirmedOut }
      }
    }

    // 无 step-finish → message.tokens fallback
    if (!msgHasFinish && msg.tokens) {
      session.input += msg.tokens.input
      session.output += msg.tokens.output
      session.reasoning += msg.tokens.reasoning
      session.cacheRead += msg.tokens.cache.read
      session.cacheWrite += msg.tokens.cache.write
      session.cost += msg.cost ?? 0
      if (isRequest) {
        confirmedRequest.input += msg.tokens.input + msg.tokens.cache.read + msg.tokens.cache.write
        confirmedRequest.output += msg.tokens.output + msg.tokens.reasoning
        confirmedRequest.cost += msg.cost ?? 0
      }
    }
  }

  // ── 3. ratio ──
  const inputRatio = ratioTokens > 0 && ratioChars > 500 ? ratioChars / ratioTokens : DEFAULT_RATIO
  const outputRatio = outputTokensTotal > 0 && outputCharsTotal > 100 ? outputCharsTotal / outputTokensTotal : DEFAULT_RATIO

  // ── 4. step（基于 latest assistant）───────────────────────────────
  const lastParts = latestAssistant ? getParts(latestAssistant.id) : []
  const sfIdx = lastParts.findLastIndex((p) => p.type === "step-finish")
  const stepSF = sfIdx >= 0 ? lastParts[sfIdx] : undefined
  const msgCompleted = !!latestAssistant?.time?.completed

  let stepInput: number
  let stepConfirmed: boolean
  if (stepSF && msgCompleted) {
    stepInput = stepSF.tokens.input + stepSF.tokens.cache.read + stepSF.tokens.cache.write
    stepConfirmed = true
  } else if (stepSF && !msgCompleted) {
    stepInput = latestAssistant?.tokens
      ? latestAssistant.tokens.input + latestAssistant.tokens.cache.read + latestAssistant.tokens.cache.write
      : stepSF.tokens.input + stepSF.tokens.cache.read + stepSF.tokens.cache.write
    stepConfirmed = false
  } else {
    stepInput = latestAssistant?.tokens
      ? latestAssistant.tokens.input + latestAssistant.tokens.cache.read + latestAssistant.tokens.cache.write
      : 0
    stepConfirmed = false
  }

  let stepOutput: number
  if (stepSF && msgCompleted) {
    stepOutput = stepSF.tokens.output + stepSF.tokens.reasoning
  } else {
    let outChars = 0
    for (let i = sfIdx + 1; i < lastParts.length; i++) {
      const p = lastParts[i]
      if (p.type === "text" && !p.ignored) outChars += (p.text?.length ?? 0)
      if (p.type === "reasoning") outChars += (p.text?.length ?? 0)
      if (p.type === "tool") {
        outChars += p.state?.status === "pending"
          ? (p.state.raw?.length ?? 0)
          : JSON.stringify(p.state?.input ?? {}).length
      }
    }
    stepOutput = Math.round(outChars / outputRatio)
  }

  // ── 5. pending input（step-finish 之后的 tool result）───────────
  let pendingToolResultChars = 0
  let pendingAttachTokens = 0
  for (let i = sfIdx + 1; i < lastParts.length; i++) {
    const p = lastParts[i]
    if (p.type !== "tool") continue
    if (p.state?.status === "completed") {
      pendingToolResultChars += (p.state.output?.length ?? 0)
      for (const att of (p.state.attachments ?? []) as Array<{ url: string; mime: string }>) {
        pendingAttachTokens += estimateDataUrlInputTokens(att.url, att.mime)
      }
    }
    if (p.state?.status === "error") {
      pendingToolResultChars += (p.state.error?.length ?? 0)
    }
  }
  const pendingToolResultTokens = Math.round(pendingToolResultChars / inputRatio)
  stepInput += pendingToolResultTokens + pendingAttachTokens

  // ── 6. request totals（confirmed + in-flight）─────────
  const stepDelta = stepConfirmed ? 0 : stepInput + stepOutput
  const totalInput = confirmedRequest.input + stepDelta
  const totalOutput = confirmedRequest.output + (stepConfirmed ? 0 : stepOutput)

  // ── 7. breakdown（来自 latest assistant 的 step-finish）───────
  let breakdown: TokenAccounting["breakdown"] = null
  if (stepSF && stepSF.inputBreakdown && stepSF.inputChars) {
    const bd = stepSF.inputBreakdown as {
      system: number; instructions: number; skills: number; tools: number
      messages: { userText: number; assistantText: number; reasoning: number; toolInput: number; toolOutput: number; attachments: number; total: number }
    }
    const confirmedInput = stepSF.tokens.input + stepSF.tokens.cache.read + stepSF.tokens.cache.write
    const denom = stepSF.inputChars as number

    const alloc = (chars: number) => denom > 0 ? Math.round((chars / denom) * confirmedInput) : 0
    const system = alloc(bd.system)
    const instructions = alloc(bd.instructions)
    const skills = alloc(bd.skills)
    const tools = alloc(bd.tools)
    const userMessages = alloc(bd.messages.userText)
    const toolResults = alloc(bd.messages.toolOutput)
    const attachments = alloc(bd.messages.attachments)

    let assistantText: number; let reasoning: number; let toolCalls: number
    if (stepConfirmed) {
      reasoning = stepSF.tokens.reasoning
      const visibleOutput = stepSF.tokens.output
      const textChars = bd.messages.assistantText
      const toolCallChars = bd.messages.toolInput
      const totalOutChars = textChars + toolCallChars
      assistantText = totalOutChars > 0 ? Math.round((visibleOutput * textChars) / totalOutChars) : visibleOutput
      toolCalls = Math.max(0, visibleOutput - assistantText)
    } else {
      let textC = 0, reasonC = 0, toolC = 0
      for (let i = sfIdx + 1; i < lastParts.length; i++) {
        const p = lastParts[i]
        if (p.type === "text" && !p.ignored) textC += (p.text?.length ?? 0)
        if (p.type === "reasoning") reasonC += (p.text?.length ?? 0)
        if (p.type === "tool") {
          toolC += p.state?.status === "pending"
            ? (p.state.raw?.length ?? 0)
            : JSON.stringify(p.state?.input ?? {}).length
        }
      }
      assistantText = Math.round(textC / outputRatio)
      reasoning = Math.round(reasonC / outputRatio)
      toolCalls = Math.round(toolC / outputRatio)
    }

    breakdown = { system, instructions, skills, tools, userMessages, toolResults, attachments, assistantText, reasoning, toolCalls, pending: pendingToolResultTokens + pendingAttachTokens }
  }

  // ── 8. contextPercent ──
  const limit = contextLimit ?? 0
  const stepTotal = stepInput + stepOutput
  const contextPercent = limit > 0 ? Math.round((stepTotal / limit) * 100) : null

  return {
    step: { input: stepInput, output: stepOutput, confirmed: stepConfirmed },
    request: {
      input: stepInput,
      output: stepOutput,
      totalInput,
      totalOutput,
      cost: confirmedRequest.cost,
    },
    session,
    contextLimit: limit,
    contextPercent,
    breakdown,
    ratio: { input: inputRatio, output: outputRatio },
  }
}
