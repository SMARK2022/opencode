import { AttachmentToken } from "@opencode-ai/core/util/attachment-token"
import type { AssistantMessage, Part, SessionRequestUsage } from "@opencode-ai/sdk/v2"
import { estimate } from "@opencode-ai/core/util/token"

export type UsageInfo = {
  input: number
  output: number
  totalInput: number
  totalOutput: number
  context: string | undefined
  cost: string | undefined
}

export function estimateDataUrlInputTokens(url: string, mime: string) {
  // #175：委托 core，禁止 TUI 本地 /750 分叉
  return AttachmentToken.estimateAttachment({ url, mime, type: "file" }).tokens
}

export function sumConfirmed(
  items: AssistantMessage[],
  getParts: (id: string) => ReadonlyArray<Part>,
) {
  return items.reduce(
    (acc, a) => {
      const parts = getParts(a.id)
      const { input, output } = parts.reduce(
        (t, p) => {
          // 只有 API 每轮确认点参与累计，流式部件仍未确认。
          if (p.type !== "step-finish") return t
          return {
            // 缓存读写仍占上下文窗口，必须与普通 input 一起累计。
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

export function computeFinalTokens(
  lastAssistant: AssistantMessage | undefined,
  lastParts: ReadonlyArray<Part>,
  request: SessionRequestUsage,
  outputRatio = 4,
) {
  const lastSFIdx = lastParts.reduce((idx: number, p, i) => (p.type === "step-finish" ? i : idx), -1)
  const streamingOut = !lastAssistant || lastAssistant.time.completed !== undefined
    ? 0
    : lastParts.reduce((sum, p, i) => {
        if (i <= lastSFIdx) return sum
        if (p.type === "text" && !p.ignored) return sum + p.text.length
        if (p.type === "reasoning") return sum + p.text.length
        // pending 工具尚无完整参数，只能读取 raw，解析后的 input 不能替代流式片段。
        if (p.type === "tool" && p.state.status === "pending") return sum + p.state.raw.length
        if (p.type === "tool" && p.state.status !== "pending") return sum + JSON.stringify(p.state.input).length
        return sum
      }, 0)
  // 最后 step-finish 之后的 completed 工具输出将在下一轮 API 调用中计入输入。
  const pendingIn = !lastAssistant || lastAssistant.time.completed !== undefined
    ? 0
    : lastParts.reduce((sum, p, i) => {
        if (i <= lastSFIdx) return sum
        // server 请求体已包含游标之前的工具结果，只为之后的新结果追加下一轮输入估算。
        if (request.estimatedInput !== undefined && p.id <= (lastAssistant.inputEstimate?.afterPartID ?? "")) return sum
        if (p.type === "tool" && p.state.status === "completed") return sum + p.state.output.length
        return sum
      }, 0)

  // 三个消费者只校准未确认尾部；prepared input 与零确认继续沿原投影/游标优先级取值。
  const density = request.inputEstimate?.charsPerToken
  const ratio = density !== undefined && Number.isFinite(density) && density > 0 ? density : 4
  const pendingInputTokens = Math.round(pendingIn / ratio)
  // 输出使用独立历史校准；请求体的 JSON/附件输入密度不能解释新生成的文本与参数。
  const pendingOutputTokens = Math.round(streamingOut / outputRatio)
  // 可见尾部可能先于 Session 快照到达；立即遮掉旧 step，保留请求历史累计。
  const hasInFlightTail = !!lastAssistant && lastAssistant.time.completed === undefined && lastParts.some((_, i) => i > lastSFIdx)
  const lastStepFinish = lastParts[lastSFIdx]
  // 最新助手可以没有 parts，投影仍提供末步基数；可见零确认或完成先到时立即遮掉旧估算。
  const projectedPendingInput = !lastAssistant || (lastAssistant.time.completed === undefined && (lastSFIdx < 0 || hasInFlightTail))
    ? request.pendingInput : undefined
  // 零估算有效；确认 part 或完成先到时立即遮掉旧 Session provisional input。
  const estimatedInput = (!lastAssistant || lastAssistant.time.completed === undefined)
    && lastAssistant?.inputEstimate?.confirmed !== true
    && (lastSFIdx < 0 || (lastAssistant?.inputEstimate?.afterPartID ?? "") >= (lastStepFinish?.id ?? ""))
    ? request.estimatedInput : undefined
  // 首轮只消费服务端实际请求估算，确认值包括零均不受本地 bootstrap 下限约束。
  const pendingStepInput = estimatedInput ?? (hasInFlightTail && lastStepFinish?.type === "step-finish"
    // 下一步继承末步完整上下文，输出、reasoning 和缓存输入均进入历史，不能用全部请求累计替代。
    ? lastStepFinish.tokens.input + lastStepFinish.tokens.cache.read + lastStepFinish.tokens.cache.write
      + lastStepFinish.tokens.output + lastStepFinish.tokens.reasoning
    : projectedPendingInput ?? 0)
  // 确认 step 读取完整 Session 投影，parts 只补未确认尾部；完成态零值同样有权威性。
  const currentInput = (hasInFlightTail || estimatedInput !== undefined ? 0 : request.stepInput) + pendingInputTokens + pendingStepInput
  const currentOutput = (hasInFlightTail || estimatedInput !== undefined ? 0 : request.stepOutput) + pendingOutputTokens
  // durable 累计独立于可见助手与 V1 part 缓存，末步已确认用量只叠加未结算的下一步估算。
  const totalInput = request.input + pendingInputTokens + pendingStepInput
  const totalOutput = request.output + pendingOutputTokens

  // 此函数仅返回显示值，不写 Session.tokens 或费用，不成为持久化账本的第二个 owner。
  return {
    input: currentInput,
    output: currentOutput,
    totalInput,
    totalOutput,
  }
}

export function getContextLimit(
  provider: ReadonlyArray<{ id: string; models: Record<string, { limit: { context: number } }> }>,
  providerID: string | undefined,
  modelID: string | undefined,
  contextLimit?: number,
): number | undefined {
  // 本轮冻结预算包括零均有权威性；仅旧 V1 Catalog ID 沿用原字典查找。
  if (contextLimit !== undefined) return contextLimit
  // 模型缺省时没有可算上限，保留 undefined，不能拿系统开销代替上下文窗口。
  if (!providerID || !modelID) return undefined
  return provider.find((item) => item.id === providerID)?.models[modelID]?.limit.context
}
