import type { AssistantMessage } from "@opencode-ai/sdk/v2"
import { estimate as estimateTokens } from "@/util/token"

const DEFAULT_CHARS_PER_TOKEN = 4

export type UsageInfo = {
  input: number
  output: number
  totalInput: number
  totalOutput: number
  context: string | undefined
  cost: string | undefined
}

export function estimateDataUrlInputTokens(url: string, mime: string) {
  if (!url.startsWith("data:")) return 0
  const comma = url.indexOf(",")
  if (comma < 0) return 0
  const payloadLength = url.length - comma - 1
  if (payloadLength <= 0) return 0
  if (mime.startsWith("image/")) return Math.max(1, Math.min(1600, Math.round(payloadLength / 750)))
  if (mime === "application/pdf") return Math.max(1, Math.round(payloadLength / 1100))
  return Math.max(1, estimateTokens(url.slice(comma + 1)))
}

/**
 * 从 session 历史 step-finish 的 inputChars/inputTokens 计算输入侧 chars-per-token 比值。
 * 输入含大量 JSON/schema/code，密度与自然语言输出（~4 chars/token）差异很大，
 * 因此必须从输入侧数据校准。若无历史数据则回退到默认值 4。
 */
export function charsPerTokenFromHistory(
  allMessages: ReadonlyArray<{ role: string; id: string }>,
  getParts: (id: string) => ReadonlyArray<{ type: string; [key: string]: any }>,
): number {
  let totalChars = 0
  let totalTokens = 0
  for (let i = allMessages.length - 1; i >= 0 && totalChars < 100_000; i--) {
    const msg = allMessages[i]
    if (msg.role !== "assistant") continue
    for (const p of getParts(msg.id)) {
      if (p.type !== "step-finish") continue
      const chars = p.inputChars as number | undefined
      if (!chars || chars < 100) continue
      const tokens = (p.tokens?.input ?? 0) + (p.tokens?.cache?.read ?? 0) + (p.tokens?.cache?.write ?? 0)
      if (tokens <= 0) continue
      const bd = p.inputBreakdown as { messages?: { attachments?: number } } | undefined
      totalChars += Math.max(0, chars - (bd?.messages?.attachments ?? 0))
      totalTokens += tokens
    }
  }
  if (totalTokens > 0 && totalChars > 500) return totalChars / totalTokens
  return DEFAULT_CHARS_PER_TOKEN
}

/** 累加所有已完成 request 的 step-finish 确认 token（不含当前 step 的流式追加） */
export function sumConfirmed(
  items: AssistantMessage[],
  getParts: (id: string) => ReadonlyArray<{ type: string; [key: string]: any }>,
) {
  return items.reduce(
    (acc, a) => {
      const parts = getParts(a.id)
      const { input, output } = parts.reduce(
        (t, p) => {
          if (p.type !== "step-finish") return t
          return {
            input: t.input + p.tokens.input + p.tokens.cache.read + p.tokens.cache.write,
            output: t.output + p.tokens.output + p.tokens.reasoning,
          }
        },
        { input: 0, output: 0 },
      )
      return { input: acc.input + input, output: acc.output + output }
    },
    { input: 0, output: 0 },
  )
}

/**
 * 合并 step-finish 真实值、流式追加估算，以及 assistant message 上的服务端请求体估算。
 * finish-step 到达前，prompt.ts 会先把真实请求体估算写入 lastAssistant.tokens.input。
 * @param ratio - 从 charsPerTokenFromHistory 计算得到的输入侧 chars/token 比值
 */
export function computeFinalTokens(
  lastAssistant: AssistantMessage,
  lastParts: ReadonlyArray<{ type: string; [key: string]: any }>,
  requestConfirmed: { input: number; output: number },
  ratio?: number,
) {
  const cpt = ratio ?? DEFAULT_CHARS_PER_TOKEN
  const lastSFIdx = lastParts.reduce((idx: number, p, i) => (p.type === "step-finish" ? i : idx), -1)
  const streamingOut = lastAssistant.time.completed
    ? 0
    : lastParts.reduce((sum, p, i) => {
        if (i <= lastSFIdx) return sum
        if (p.type === "text" && !p.ignored) return sum + (p.text?.length ?? 0)
        if (p.type === "reasoning") return sum + (p.text?.length ?? 0)
        if (p.type === "tool" && p.state?.status === "pending") return sum + (p.state.raw?.length ?? 0)
        if (p.type === "tool" && p.state?.status !== "pending") return sum + JSON.stringify(p.state.input ?? {}).length
        return sum
      }, 0)
  const pendingIn = lastAssistant.time.completed
    ? 0
    : lastParts.reduce((sum, p, i) => {
        if (i <= lastSFIdx) return sum
        if (p.type === "tool" && p.state?.status === "completed") return sum + (p.state.output?.length ?? 0)
        return sum
      }, 0)

  const pendingInputTokens = Math.round(pendingIn / cpt)
  const pendingOutputTokens = Math.round(streamingOut / cpt)
  const hasInFlightTail = !lastAssistant.time.completed && lastParts.some((_, i) => i > lastSFIdx)
  const lastStepFinish =
    lastSFIdx >= 0 && lastParts[lastSFIdx]?.type === "step-finish" ? lastParts[lastSFIdx] : undefined
  const currentStepInputConfirmed =
    !hasInFlightTail && lastStepFinish
      ? lastStepFinish.tokens.input + lastStepFinish.tokens.cache.read + lastStepFinish.tokens.cache.write
      : 0
  const currentStepOutputConfirmed =
    !hasInFlightTail && lastStepFinish
      ? lastStepFinish.tokens.output + lastStepFinish.tokens.reasoning
      : 0

  const assistantInputEstimate =
    lastSFIdx < 0 ? lastAssistant.tokens.input + lastAssistant.tokens.cache.read + lastAssistant.tokens.cache.write : 0
  const currentStepInput = currentStepInputConfirmed || assistantInputEstimate
  const previousInput = currentStepInputConfirmed ? requestConfirmed.input - currentStepInputConfirmed : requestConfirmed.input
  const previousOutput = currentStepOutputConfirmed ? requestConfirmed.output - currentStepOutputConfirmed : requestConfirmed.output
  const currentInput = currentStepInput + pendingInputTokens
  const currentOutput = currentStepOutputConfirmed + pendingOutputTokens

  const totalInput = previousInput + currentStepInput + pendingInputTokens
  const totalOutput = previousOutput + currentOutput

  return {
    input: currentInput,
    output: currentOutput,
    totalInput,
    totalOutput,
  }
}

export function getContextLimit(
  provider: ReadonlyArray<{ id: string; models: Record<string, { limit: { context: number; input?: number; output: number } }> }>,
  providerID: string | undefined,
  modelID: string | undefined,
): number | undefined {
  if (!providerID || !modelID) return undefined
  return provider.find((item) => item.id === providerID)?.models[modelID]?.limit.context
}
