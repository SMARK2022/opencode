// #175：TUI 固定侧分配 media.tokens，不抢 system/user 文本份额
// step/request/session 共用统计入口，持久投影拥有完整累计，parts 只提供当前尾部。
// 确认分类按 categoryChars / inputChars 分配 provider input，不在 TUI 重建请求体。

import { AttachmentToken } from "@opencode-ai/core/util/attachment-token"
import type { AssistantMessage, Part, Session } from "@opencode-ai/sdk/v2"
import { computeFinalTokens, estimateDataUrlInputTokens } from "./token-estimate"

// #122：缺校准样本时默认 4 字符约 1 token
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
  // 分类来自当前请求的字符快照；缺少快照时不构造另一份请求体。
  // 确认后分配 provider input，准备阶段保留服务端估算。
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
  // 请求发出前的快照由既有准备链发布，类型与实际消息保持一致。
  inputEstimate?: AssistantMessage["inputEstimate"]
}

type Pt = { id?: string; type: string; [key: string]: any }

// ─── 主函数 ──────────────────────────────────────────────────────────────────

// #122：一次遍历汇总 step/request/session，确认优先于估算
export function tokenAccounting(
  messages: ReadonlyArray<Msg>,
  getParts: (id: string) => ReadonlyArray<Pt>,
  contextLimit?: number,
  projection?: { session: Pick<Session, "tokens" | "cost" | "request"> | undefined; last: AssistantMessage | undefined; parts: ReadonlyArray<Part> },
): TokenAccounting {
  // #122：会话累计与当前 request 边界（按 user 消息切分）
// ── 1. lastUser / requestAssistantIDs ──
  const lastUser = messages.findLast((m) => m.role === "user")
  const latestRequestAssistant = lastUser
    ? messages.findLast((m) => m.role === "assistant" && m.parentID === lastUser.id)
    : undefined
  const requestAssistantIDs = new Set<string>()
  if (lastUser) {
    for (const m of messages) {
      if (m.role === "assistant" && m.parentID === lastUser.id) requestAssistantIDs.add(m.id)
    }
  }

  // ── 2. 一次遍历 ──
  const session = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }
  const confirmedRequest = { input: 0, output: 0, cost: 0 }
  // #122：用于校准 input 字符/token 比的累计样本
  let ratioChars = 0
  let ratioTokens = 0
  let outputCharsTotal = 0
  // #122：输出侧确认 token 样本
  let outputTokensTotal = 0
  // #122：跟踪最近 assistant 以定位当前 step 的 parts
  let latestAssistant: Msg | undefined

  // #122：按消息遍历，user 边界切 request，assistant 累加 session/request
  for (const msg of messages) {
    if (msg.role !== "assistant") continue
    latestAssistant = msg
    const parts = getParts(msg.id)
    const isRequest = requestAssistantIDs.has(msg.id)
    // #122：本 assistant 是否已出现 step-finish
  let msgHasFinish = false

    for (let i = 0; i < parts.length; i++) {
      const p = parts[i]
      // #122：step-finish 是 provider 确认边界
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
          const bd = p.inputBreakdown as { messages?: { attachments?: number }; media?: { rawChars: number; textChars: number; tokens: number } } | undefined
          // #175：校准剔除 media.raw，加回 text 占位
          // #194：旧附件样本排除，已知媒体量从确认分母扣除，不能稀释文本密度。
          if (bd?.media || !bd?.messages?.attachments) {
            ratioChars += bd?.media ? Math.max(0, chars - bd.media.rawChars + bd.media.textChars) : chars
            ratioTokens += Math.max(0, tok - (bd?.media?.tokens ?? 0))
          }
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
        // 当前 user 请求的最新 assistant 消息在 message.tokens 上携带预流式
        // 上传估算，让 prompt/侧栏在回车后立即显示 input。该值属于当前步骤
        // 而非已完成历史步骤，因此 request 总计不得在此处计入后又作为
        // stepInput 重复统计。output 与 cost 保持在 fallback 路径：上传估算
        // 回归只影响 input，且无 step-finish parts 的历史消息仍需保留总计。
        if (msg.id !== latestRequestAssistant?.id)
          confirmedRequest.input += msg.tokens.input + msg.tokens.cache.read + msg.tokens.cache.write
        confirmedRequest.output += msg.tokens.output + msg.tokens.reasoning
        confirmedRequest.cost += msg.cost ?? 0
      }
      // native 消息没有 V1 finish part 时，已完成消息的真实输出仍可校准输出密度。
      const confirmedOut = msg.tokens.output + msg.tokens.reasoning
      if (msg.time?.completed !== undefined && confirmedOut > 0) {
        const stepChars = parts.reduce((sum, p) => {
          if ((p.type === "text" && !p.ignored) || p.type === "reasoning") return sum + (p.text?.length ?? 0)
          if (p.type === "tool") return sum + (p.state?.status === "pending"
            ? (p.state.raw?.length ?? 0)
            : JSON.stringify(p.state?.input ?? {}).length)
          return sum
        }, 0)
        if (stepChars > 0) { outputCharsTotal += stepChars; outputTokensTotal += confirmedOut }
      }
    }
  }

  // ── 3. ratio ──
  // #194：clamp 2..8——与 TokenEstimate.learnInputCharsPerToken 同口径，防极端样本失真
  // #194：TUI 不能直接 import TokenEstimate（包边界），但 ratio 逻辑与 daemon 对齐
  const density = projection?.session?.request?.inputEstimate?.charsPerToken
  const inputRatio = density !== undefined && Number.isFinite(density) && density > 0 ? density : ratioTokens > 0 && ratioChars > 500 ? Math.min(8, Math.max(2, ratioChars / ratioTokens)) : DEFAULT_RATIO
  // #122：输出字符/token 比；样本不足回落 DEFAULT_RATIO
  const outputRatio = outputTokensTotal > 0 && outputCharsTotal > 100 ? outputCharsTotal / outputTokensTotal : DEFAULT_RATIO
  // 持久投影拥有完整请求确认值；输入密度与输出校准分别进入既有尾部 helper。
  const projected = projection?.session?.request
    ? computeFinalTokens(projection.last, projection.parts, projection.session.request, outputRatio)
    : undefined

  // ── 4. step（基于 latest assistant）───────────────────────────────
  // 请求投影明确选择当前助手，分页中的旧助手不能接管当前分类。
  latestAssistant = projection ? projection.last : latestAssistant
  const lastParts: ReadonlyArray<Pt> = projection ? projection.parts : latestAssistant ? getParts(latestAssistant.id) : []
  // #122：最后一个 step-finish 划分已确认区与流式追加区
  const sfIdx = lastParts.findLastIndex((p) => p.type === "step-finish")
  const stepSF = sfIdx >= 0 ? lastParts[sfIdx] : undefined
  // #122：消息 completed 才把 step-finish 当最终确认
  const msgCompleted = latestAssistant?.time?.completed !== undefined

  let stepInput: number
  let stepConfirmed: boolean
  // #122：完成消息用 step-finish 全量 tokens 作为 step input
  if (stepSF && msgCompleted) {
    stepInput = stepSF.tokens.input + stepSF.tokens.cache.read + stepSF.tokens.cache.write
    stepConfirmed = true
  // #122：流式中 step-finish 可能存在但仍需叠加未确认输出
  } else if (stepSF && !msgCompleted) {
    // #122：流式进行中：step-finish 存在但消息未 completed
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
  // #122：流式中 completed 工具输出将进入下一轮 input
  let pendingToolResultChars = 0
  // #122：流式未完成时附件 data URL 估算计入下一步 input
  let pendingAttachTokens = 0
  for (let i = sfIdx + 1; i < lastParts.length; i++) {
    const p = lastParts[i]
    if (p.type !== "tool") continue
    // prepared 游标已覆盖的结果和附件属于输入快照，不能再追加为 pending。
    if (projection?.session?.request?.estimatedInput !== undefined && (p.id ?? "") <= (projection.last?.inputEstimate?.afterPartID ?? "")) continue
    if (p.state?.status === "completed") {
      pendingToolResultChars += (p.state.output?.length ?? 0)
      for (const att of (p.state.attachments ?? []) as Array<{ url: string; mime: string }>) {
        // #122：附件 data URL 估算并入待计入 input
        // #175：pending 附件与 daemon 同口径
        pendingAttachTokens += AttachmentToken.estimateAttachment({ url: att.url, mime: att.mime, type: "file" }).tokens
      }
    }
    if (p.state?.status === "error") {
      pendingToolResultChars += (p.state.error?.length ?? 0)
    }
  }
  const pendingToolResultTokens = Math.round(pendingToolResultChars / inputRatio)
  stepInput += pendingToolResultTokens + pendingAttachTokens

  // ── 6. request totals（confirmed + in-flight）─────────
  // #124：input 与 output 必须分开，stepOutput 不能混进 totalInput
  // 当 provider usage 已到达但 message.completed 尚未落库时，confirmedRequest
  // 已包含最新 step-finish input。assistant 消息可能仍携带较早的预流式估算，
  // 因此不能用「估算 − 实际用量」推导 pending input。此时只有 finish 之后
  // 写入的工具结果才是已知的未来 input。
  const inFlightInput = stepConfirmed
    ? 0
    : stepSF && latestAssistant?.id === latestRequestAssistant?.id
      ? pendingToolResultTokens + pendingAttachTokens
      : stepInput
  const totalInput = confirmedRequest.input + inFlightInput
  const totalOutput = confirmedRequest.output + (stepConfirmed ? 0 : stepOutput)

  // ── 7. breakdown 优先级（#127）──────────────────────────────
  // #127：inputBreakdown=上传上下文；当前 step 输出单独叠加（input + live）
  let breakdown: TokenAccounting["breakdown"] = null
  // #124：定位最近的 step-start 字符快照
  const ssIdx = lastParts.findLastIndex((p) => p.type === "step-start" && p.inputBreakdown)
  // #124：无 step-start 时 breakdown 仅能等 step-finish 或 pending
  const stepSS = ssIdx >= 0 ? lastParts[ssIdx] : undefined
  // 当前请求没有快照时不能借旧助手；显式零字符、零估算也是有效快照。
  const estimate = projection?.session?.request ? projection.session.request.inputEstimate : latestAssistant?.inputEstimate
  const pendingMsg =
    estimate?.inputBreakdown
      ? {
          type: "pending" as const,
          inputBreakdown: estimate.inputBreakdown,
          inputChars: estimate.bodyChars,
          inputTokens: estimate.input,
        }
      : undefined
  // 下一轮 prepared 游标越过旧 finish/start 时，旧确认不能接管新请求体。
  const breakdownSrc = pendingMsg && estimate?.confirmed === false &&
    (estimate.afterPartID ?? "") >= (stepSF?.id ?? "") && (estimate.afterPartID ?? "") >= (stepSS?.id ?? "")
    ? pendingMsg
    : stepSF?.inputBreakdown && sfIdx > ssIdx
    ? stepSF
    : stepSS?.inputBreakdown
      ? stepSS
      : pendingMsg
  if (breakdownSrc?.inputBreakdown && breakdownSrc.inputChars !== undefined) {
    const bd = breakdownSrc.inputBreakdown as {
      system: number; instructions: number; skills: number; tools: number
      messages: { userText: number; assistantText: number; reasoning: number; toolInput: number; toolOutput: number; attachments: number; total: number }
      media?: { rawChars: number; textChars: number; tokens: number; count: number; imageTokens: number; pdfTokens: number; otherTokens: number }
    }
    // provider 确认优先于旧 prepared 密度，不必等整条消息 completed。
    const isConfirmed = breakdownSrc.type === "step-finish" || (breakdownSrc === pendingMsg && estimate?.confirmed === true)
    const confirmedInput = breakdownSrc.type === "step-finish" && stepSF?.tokens
      ? stepSF.tokens.input + stepSF.tokens.cache.read + stepSF.tokens.cache.write
      : isConfirmed ? projection?.session?.request?.stepInput ?? (latestAssistant?.tokens
        ? latestAssistant.tokens.input + latestAssistant.tokens.cache.read + latestAssistant.tokens.cache.write : 0)
      : breakdownSrc.inputTokens ?? Math.round(breakdownSrc.inputChars / inputRatio)
    const denom = breakdownSrc.inputChars
    // #175：先固定切走 media.tokens
    const media = (bd as any).media as { rawChars: number; textChars: number; tokens: number } | undefined
    const attachmentTokens = media?.tokens
    // #175：无 media 时保持旧全量分配
    // #175：textAllocInput 在无 media 时等于 confirmedInput
    const textAllocInput = attachmentTokens == null ? confirmedInput : Math.max(0, confirmedInput - attachmentTokens)
    // #175：textDenom = denom - raw + text，至少为 1
    // #175：全媒体请求 textDenom 保底 1
    const textDenom = media ? Math.max(1, denom - media.rawChars + media.textChars) : denom
    const alloc = (chars: number) => textDenom > 0 ? Math.round((chars / textDenom) * textAllocInput) : 0
    const system = alloc(bd.system)
    const instructions = alloc(bd.instructions)
    const skills = alloc(bd.skills)
    const tools = alloc(bd.tools)
    const userMessages = alloc(bd.messages.userText)
    const toolResults = alloc(bd.messages.toolOutput)
    // #175：有 media.tokens 则 attachments 用固定值
    // #175：attachments UI 槽位优先固定 media.tokens
    const attachments = attachmentTokens ?? alloc(bd.messages.attachments)
    // #127：历史 assistant/reasoning/tool-call 属于 input context，不是当前 step 新输出
    const inputAssistantText = alloc(bd.messages.assistantText)
    const inputReasoning = alloc(bd.messages.reasoning)
    const inputToolCalls = alloc(bd.messages.toolInput)

    // #127：当前 step live output：只统计本 step 新生成的 text/reasoning/tool
    let liveAssistantText = 0, liveReasoning = 0, liveToolCalls = 0
    // finish 只扫描它之前的本 step；prepared 游标隔开已上传历史与新输出。
    const outputStartIdx = breakdownSrc.type === "step-finish"
      ? lastParts.slice(0, sfIdx).findLastIndex((p) => p.type === "step-start")
      : Math.max(ssIdx, sfIdx, estimate?.afterPartID ? lastParts.findLastIndex((p) => (p.id ?? "") <= estimate.afterPartID!) : -1)
    const outputEndIdx = breakdownSrc.type === "step-finish" ? sfIdx : lastParts.length
    let textC = 0, reasonC = 0, toolC = 0
    // #127：扫描当前 step 的 live text/reasoning/tool 字符
    for (let i = outputStartIdx + 1; i < outputEndIdx; i++) {
      const p = lastParts[i]
      if (p.type === "text" && !p.ignored) textC += (p.text?.length ?? 0)
      if (p.type === "reasoning") reasonC += (p.text?.length ?? 0)
      if (p.type === "tool") {
        toolC += p.state?.status === "pending"
          ? (p.state.raw?.length ?? 0)
          : JSON.stringify(p.state?.input ?? {}).length
      }
    }
    const outputTokens = breakdownSrc.type === "step-finish" ? stepSF?.tokens : latestAssistant?.tokens
    if (isConfirmed && outputTokens) {
      // reasoning 保留 provider 真值，visible output 仅按本 step 的 text/tool 字符分配。
      liveReasoning = outputTokens.reasoning
      const visibleOutput = outputTokens.output
      // #127：visible output 在 live text/tool 字符间分配
      const totalVisibleChars = textC + toolC
      liveAssistantText = totalVisibleChars > 0 ? Math.round((visibleOutput * textC) / totalVisibleChars) : visibleOutput
      // #127：toolCalls 吃掉 visible 余量，避免双重计数
      liveToolCalls = Math.max(0, visibleOutput - liveAssistantText)
    } else {
      // #127：未确认时 live 用历史 output 字符比估算
      liveAssistantText = Math.round(textC / outputRatio)
      liveReasoning = Math.round(reasonC / outputRatio)
      liveToolCalls = Math.round(toolC / outputRatio)
    }

    breakdown = {
      system, instructions, skills, tools, userMessages, toolResults, attachments,
      // #127：UI 展示 = 上传上下文份额 + 本 step 新输出
      assistantText: inputAssistantText + liveAssistantText,
      reasoning: inputReasoning + liveReasoning,
      toolCalls: inputToolCalls + liveToolCalls,
      pending: pendingToolResultTokens + pendingAttachTokens,
    }
  }

  // ── 8. contextPercent ──
  const limit = projection?.session?.request?.model?.contextLimit ?? contextLimit ?? 0
  // #122：context 占用按 step input+output 相对 limit
  const stepTotal = (projected?.input ?? stepInput) + (projected?.output ?? stepOutput)
  // #122：context 百分比相对 model limit
  const contextPercent = limit > 0 ? Math.round((stepTotal / limit) * 100) : null

  // #122：返回结构供 prompt/sidebar/footer 只读；勿在 UI 再拆第二套算法
  return {
    step: { input: projected?.input ?? stepInput, output: projected?.output ?? stepOutput, confirmed: stepConfirmed },
    request: {
      input: projected?.input ?? stepInput,
      output: projected?.output ?? stepOutput,
      totalInput: projected?.totalInput ?? totalInput,
      totalOutput: projected?.totalOutput ?? totalOutput,
      // #122：cost 仅累计已确认 request 费用
      cost: projection?.session?.request?.cost ?? confirmedRequest.cost,
    },
    // 会话账本独立于前端分页，旧 transcript-only 调用仍保留原始统计语义。
    session: projection?.session?.tokens
      ? { input: projection.session.tokens.input, output: projection.session.tokens.output, reasoning: projection.session.tokens.reasoning,
          cacheRead: projection.session.tokens.cache.read, cacheWrite: projection.session.tokens.cache.write, cost: projection.session.cost ?? 0 }
      : session,
    contextLimit: limit,
    contextPercent,
    breakdown,
    ratio: { input: inputRatio, output: outputRatio },
  }
}
