import { TokenEstimate } from "./estimate"

const DEFAULT_RATIO = 4

export type TokenAccounting = {
  step: {
    input: number
    output: number
    confirmed: boolean
  }
  request: {
    input: number
    output: number
    totalInput: number
    totalOutput: number
    cost: number
  }
  session: {
    input: number
    output: number
    reasoning: number
    cacheRead: number
    cacheWrite: number
    cost: number
  }
  contextLimit: number
  contextPercent: number | null
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

type Msg = {
  id: string
  role: string
  parentID?: string
  providerID?: string
  modelID?: string
  cost?: number
  tokens?: { input: number; output: number; reasoning: number; cache: { read: number; write: number } }
  time?: { created?: number; completed?: number }
  inputBreakdown?: {
    system: number
    instructions: number
    skills: number
    tools: number
    messages: { userText: number; assistantText: number; reasoning: number; toolInput: number; toolOutput: number; attachments: number; total: number }
    media?: { rawChars: number; textChars: number; tokens: number; count: number; imageTokens: number; pdfTokens: number; otherTokens: number }
  }
  inputChars?: number
  inputTokens?: number
}

type Pt = { id?: string; type: string; [key: string]: any }

export function tokenAccounting(
  messages: ReadonlyArray<Msg>,
  getParts: (id: string) => ReadonlyArray<Pt>,
  contextLimit?: number,
): TokenAccounting {
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

  const session = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }
  const confirmedRequest = { input: 0, output: 0, cost: 0 }
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

      const confirmedOut = p.tokens.output + p.tokens.reasoning
      if (confirmedOut > 0) {
        let stepChars = 0
        const startIdx = parts.slice(0, i).findLastIndex((x) => x.type === "step-start")
        for (let j = (startIdx >= 0 ? startIdx + 1 : 0); j < i; j++) {
          const sp = parts[j]
          if (sp.type === "text" && !sp.ignored) stepChars += sp.text?.length ?? 0
          if (sp.type === "reasoning") stepChars += sp.text?.length ?? 0
          if (sp.type === "tool") {
            stepChars += sp.state?.status === "pending"
              ? sp.state.raw?.length ?? 0
              : JSON.stringify(sp.state?.input ?? {}).length
          }
        }
        if (stepChars > 0) {
          outputCharsTotal += stepChars
          outputTokensTotal += confirmedOut
        }
      }
    }

    if (!msgHasFinish && msg.tokens) {
      session.input += msg.tokens.input
      session.output += msg.tokens.output
      session.reasoning += msg.tokens.reasoning
      session.cacheRead += msg.tokens.cache.read
      session.cacheWrite += msg.tokens.cache.write
      session.cost += msg.cost ?? 0
      if (isRequest) {
        if (msg.id !== latestRequestAssistant?.id) {
          confirmedRequest.input += msg.tokens.input + msg.tokens.cache.read + msg.tokens.cache.write
        }
        confirmedRequest.output += msg.tokens.output + msg.tokens.reasoning
        confirmedRequest.cost += msg.cost ?? 0
      }
    }
  }

  const inputRatio = TokenEstimate.learnInputCharsPerToken({
    messages: messages.map((msg) => ({ role: msg.role, providerID: msg.providerID, modelID: msg.modelID, parts: getParts(msg.id) })),
  })?.charsPerToken ?? DEFAULT_RATIO
  const outputRatio = outputTokensTotal > 0 && outputCharsTotal > 100 ? outputCharsTotal / outputTokensTotal : DEFAULT_RATIO

  const lastParts = latestAssistant ? getParts(latestAssistant.id) : []
  const sfIdx = lastParts.findLastIndex((p) => p.type === "step-finish")
  const stepSF = sfIdx >= 0 ? lastParts[sfIdx] : undefined
  const msgCompleted = !!latestAssistant?.time?.completed

  const stepInputBase = stepSF && msgCompleted
    ? stepSF.tokens.input + stepSF.tokens.cache.read + stepSF.tokens.cache.write
    : stepSF && !msgCompleted
      ? latestAssistant?.tokens
        ? latestAssistant.tokens.input + latestAssistant.tokens.cache.read + latestAssistant.tokens.cache.write
        : stepSF.tokens.input + stepSF.tokens.cache.read + stepSF.tokens.cache.write
      : latestAssistant?.tokens
        ? latestAssistant.tokens.input + latestAssistant.tokens.cache.read + latestAssistant.tokens.cache.write
        : 0
  const stepConfirmed = !!(stepSF && msgCompleted)

  const stepOutput = stepSF && msgCompleted
    ? stepSF.tokens.output + stepSF.tokens.reasoning
    : Math.round(
        lastParts.slice(sfIdx + 1).reduce((sum, p) => {
          if (p.type === "text" && !p.ignored) return sum + (p.text?.length ?? 0)
          if (p.type === "reasoning") return sum + (p.text?.length ?? 0)
          if (p.type === "tool") {
            return sum + (p.state?.status === "pending" ? p.state.raw?.length ?? 0 : JSON.stringify(p.state?.input ?? {}).length)
          }
          return sum
        }, 0) / outputRatio,
      )

  let pendingToolResultChars = 0
  let pendingAttachTokens = 0
  for (let i = sfIdx + 1; i < lastParts.length; i++) {
    const p = lastParts[i]
    if (p.type !== "tool") continue
    if (p.state?.status === "completed") {
      pendingToolResultChars += p.state.output?.length ?? 0
      for (const att of (p.state.attachments ?? []) as Array<{ url: string; mime: string }>) {
        pendingAttachTokens += TokenEstimate.estimateAttachment(att).tokens
      }
    }
    if (p.state?.status === "error") pendingToolResultChars += p.state.error?.length ?? 0
  }
  const pendingToolResultTokens = Math.round(pendingToolResultChars / inputRatio)
  const stepInput = stepInputBase + pendingToolResultTokens + pendingAttachTokens

  const inFlightInput = stepConfirmed
    ? 0
    : stepSF && latestAssistant?.id === latestRequestAssistant?.id
      ? pendingToolResultTokens + pendingAttachTokens
      : stepInput
  const totalInput = confirmedRequest.input + inFlightInput
  const totalOutput = confirmedRequest.output + (stepConfirmed ? 0 : stepOutput)

  let breakdown: TokenAccounting["breakdown"] = null
  const ssIdx = lastParts.findLastIndex((p) => p.type === "step-start" && p.inputBreakdown)
  const stepSS = ssIdx >= 0 ? lastParts[ssIdx] : undefined
  const pendingMsg = latestAssistant?.inputBreakdown && latestAssistant.inputChars ? latestAssistant : undefined
  const breakdownSrc = stepSF?.inputBreakdown ? stepSF : stepSS?.inputBreakdown ? stepSS : pendingMsg

  if (breakdownSrc?.inputBreakdown && breakdownSrc.inputChars) {
    const bd = breakdownSrc.inputBreakdown
    const isConfirmed = "type" in breakdownSrc && breakdownSrc.type === "step-finish" && stepConfirmed
    const allocInput = isConfirmed
      ? stepSF!.tokens.input + stepSF!.tokens.cache.read + stepSF!.tokens.cache.write
      : (breakdownSrc.inputTokens ?? Math.round(breakdownSrc.inputChars / inputRatio))
    const media = bd.media
    const attachmentTokens = media?.tokens
    const textAllocInput = attachmentTokens == null ? allocInput : Math.max(0, allocInput - attachmentTokens)
    const textDenom = media ? Math.max(1, breakdownSrc.inputChars - media.rawChars + media.textChars) : breakdownSrc.inputChars
    const alloc = (chars: number) => textDenom > 0 ? Math.round((chars / textDenom) * textAllocInput) : 0
    const inputAssistantText = alloc(bd.messages.assistantText)
    const inputReasoning = alloc(bd.messages.reasoning)
    const inputToolCalls = alloc(bd.messages.toolInput)
    const outputStartIdx = ssIdx >= 0 ? ssIdx : isConfirmed ? -1 : lastParts.length
    const outputEndIdx = isConfirmed && sfIdx >= 0 ? sfIdx : lastParts.length
    let textC = 0
    let reasonC = 0
    let toolC = 0
    for (let i = outputStartIdx + 1; i < outputEndIdx; i++) {
      const p = lastParts[i]
      if (!p) continue
      if (p.type === "text" && !p.ignored) textC += p.text?.length ?? 0
      if (p.type === "reasoning") reasonC += p.text?.length ?? 0
      if (p.type === "tool") {
        toolC += p.state?.status === "pending" ? p.state.raw?.length ?? 0 : JSON.stringify(p.state?.input ?? {}).length
      }
    }
    const liveReasoning = isConfirmed ? stepSF!.tokens.reasoning : Math.round(reasonC / outputRatio)
    const visibleOutput = isConfirmed ? stepSF!.tokens.output : undefined
    const liveAssistantText = isConfirmed
      ? textC + toolC > 0
        ? Math.round((visibleOutput! * textC) / (textC + toolC))
        : visibleOutput!
      : Math.round(textC / outputRatio)
    const liveToolCalls = isConfirmed ? Math.max(0, visibleOutput! - liveAssistantText) : Math.round(toolC / outputRatio)

    breakdown = {
      system: alloc(bd.system),
      instructions: alloc(bd.instructions),
      skills: alloc(bd.skills),
      tools: alloc(bd.tools),
      userMessages: alloc(bd.messages.userText),
      toolResults: alloc(bd.messages.toolOutput),
      attachments: attachmentTokens ?? alloc(bd.messages.attachments),
      assistantText: inputAssistantText + liveAssistantText,
      reasoning: inputReasoning + liveReasoning,
      toolCalls: inputToolCalls + liveToolCalls,
      pending: pendingToolResultTokens + pendingAttachTokens,
    }
  }

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

export * as TokenAccounting from "./accounting"
