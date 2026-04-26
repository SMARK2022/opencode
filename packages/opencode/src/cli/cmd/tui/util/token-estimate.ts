import type { AssistantMessage, UserMessage } from "@opencode-ai/sdk/v2"
import { estimate as estimateTokens } from "@/util/token"

export type UsageInfo = {
  input: number
  output: number
  totalInput: number
  totalOutput: number
  context: string | undefined
  cost: string | undefined
}

// Rough overhead for system prompt content (instructions, environment info, prompt templates)
// The exact system prompt is assembled server-side and includes model identity, working dir,
// git context, platform info, skills, user instructions, etc. — typically 1500-4000 chars.
export const SYSTEM_PROMPT_OVERHEAD = 800

// Rough overhead for tool definitions (descriptions, parameter schemas, output schemas)
// Each tool adds name + description + JSON schema. With ~15-25 active tools, this
// can easily be 3000-8000+ chars.
export const TOOL_DEFINITION_OVERHEAD = 2000

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

export function estimateUserInputTokens(parts: ReadonlyArray<{ type: string; [key: string]: any }>) {
  return parts.reduce((sum, part) => {
    if (part.type === "text" && !part.synthetic && !part.ignored) {
      return sum + estimateTokens(part.text ?? "")
    }
    if (part.type === "file") {
      return sum + estimateDataUrlInputTokens(part.url ?? "", part.mime ?? "")
    }
    if (part.type === "agent") {
      return sum + estimateTokens(part.name ?? "")
    }
    if (part.type === "subtask") {
      return sum + estimateTokens(`${part.description ?? ""}\n${part.prompt ?? ""}`)
    }
    return sum
  }, 0)
}

/** Rough estimate of system prompt + tool definition overhead (chars). */
export function estimateRequestOverhead(): number {
  return SYSTEM_PROMPT_OVERHEAD + TOOL_DEFINITION_OVERHEAD
}

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

export function getContextSize(
  item: AssistantMessage,
  getParts: (id: string) => ReadonlyArray<{ type: string; [key: string]: any }>,
): number {
  const parts = getParts(item.id)
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i]
    if (p.type === "step-finish") {
      return (
        p.tokens.input +
        p.tokens.cache.read +
        p.tokens.cache.write +
        p.tokens.output +
        p.tokens.reasoning
      )
    }
  }
  return 0
}

export function getBootstrapInputTokens(
  users: UserMessage[],
  assistants: AssistantMessage[],
  getParts: (id: string) => ReadonlyArray<{ type: string; [key: string]: any }>,
): number {
  const lastUser = users.at(-1)
  const lastUserParts = lastUser ? getParts(lastUser.id) : []
  const estimatedPromptInputTokens = estimateUserInputTokens(lastUserParts)
  const previousAssistant = lastUser ? assistants.findLast((item) => item.parentID !== lastUser.id) : assistants.at(-1)
  
  const requestOverhead = estimateRequestOverhead()
  const previousContextSize = previousAssistant ? getContextSize(previousAssistant, getParts) : 0
  
  return previousContextSize > 0
    ? previousContextSize + estimatedPromptInputTokens
    : estimatedPromptInputTokens + requestOverhead
}

export function computeFinalTokens(
  lastAssistant: AssistantMessage,
  lastParts: ReadonlyArray<{ type: string; [key: string]: any }>,
  requestConfirmed: { input: number; output: number },
  bootstrapInputTokens: number,
) {
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

  const pendingInputTokens = Math.round(pendingIn / 4)
  const pendingOutputTokens = Math.round(streamingOut / 4)
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
  
  // 修复：currentInput 应该反映当前步骤的真实输入（包括 bootstrap 或确认值）
  const currentInput = Math.max(currentStepInputConfirmed, bootstrapInputTokens) + pendingInputTokens
  const currentOutput = currentStepOutputConfirmed + pendingOutputTokens
  
  // 修复：totalInput 应该始终包含当前步骤的完整上下文
  // 如果当前步骤已确认（有 step-finish），使用确认值；否则使用 bootstrap 估算
  const currentStepTotalInput = currentStepInputConfirmed > 0 ? currentStepInputConfirmed : bootstrapInputTokens
  const totalInput = requestConfirmed.input + currentStepTotalInput + pendingInputTokens
  const totalOutput = requestConfirmed.output + pendingOutputTokens

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
