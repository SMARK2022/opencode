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

// 测量只要求统计相关载荷，不要求 transport 的品牌 ID、时间或费用字段。
export type TokenPart = {
  [Kind in Part["type"]]: Omit<Extract<Part, { type: Kind }>, "id" | "sessionID" | "messageID" | "reason" | "cost" | "time"> & Partial<Extract<Part, { type: Kind }>>
}[Part["type"]]

export function modelParts(parts: ReadonlyArray<TokenPart>) {
  // 模型只生成了外层工具调用；再统计本地展开出的内部调用，会重复增加参数的输出估算。
  return parts.filter((part) => part.type !== "tool" || typeof part.metadata?.executeParent !== "string")
}

export function measureOutput(part: TokenPart) {
  if (part.type === "text") return part.ignored ? 0 : part.text.length
  if (part.type === "reasoning") return part.text.length
  if (part.type !== "tool") return 0
  if (part.state.status === "pending") return part.state.raw.length
  // 参数没接收完就中断时，input 可能是空对象；应从 metadata.raw 读取已经收到的参数字符。
  if (part.state.status === "error" && typeof part.state.metadata?.raw === "string") return part.state.metadata.raw.length
  return JSON.stringify(part.state.input).length
}

export function measureTail(lastAssistant: (Pick<AssistantMessage, "inputEstimate"> & { tokens?: AssistantMessage["tokens"]; time?: { completed?: number } }) | undefined, lastParts: ReadonlyArray<TokenPart>, chars = lastParts.map(measureOutput)) {
  const lastSFIdx = lastParts.reduce((idx: number, p, i) => (p.type === "step-finish" ? i : idx), -1)
  const lastStepFinish = lastParts[lastSFIdx]
  // afterPartID 记录本次输入已包含到哪条内容；它越过前次完成记录时，应显示新输入的估算。
  // 没有新准备资料时，再检查前次完成后是否出现新正文或工具调用，避免继续显示前次用量。
  const hasInFlightTail = !!lastAssistant && (
    (lastStepFinish && lastAssistant.inputEstimate?.confirmed === false &&
      (lastAssistant.inputEstimate.afterPartID ?? "") >= (lastStepFinish.id ?? "")) ||
    (lastAssistant.time?.completed === undefined && lastParts.some((part, i) => i > lastSFIdx &&
      (part.type === "text" || part.type === "reasoning" || part.type === "tool" || part.type === "step-start"))))
  // 全零报告不能抹掉已保存估算；正数报告仍按原确认记录处理。
  const finish = !hasInFlightTail && lastStepFinish?.type === "step-finish" &&
    (lastStepFinish.tokens.input + lastStepFinish.tokens.cache.read + lastStepFinish.tokens.cache.write +
      lastStepFinish.tokens.output + lastStepFinish.tokens.reasoning > 0)
    ? lastStepFinish : undefined
  const start = lastParts.findLast((part, i) => part.type === "step-start" && (!hasInFlightTail || i > lastSFIdx))
  // 旧中断消息的 tokens 可能全零；没有确认标记时，不能用这组默认零覆盖已保存正文的估算。
  const stored = lastSFIdx < 0 && (lastAssistant?.inputEstimate?.confirmed === true ||
    (!lastAssistant?.inputEstimate && lastAssistant?.time?.completed !== undefined &&
      (lastAssistant?.tokens?.output ?? 0) + (lastAssistant?.tokens?.reasoning ?? 0) > 0))
    ? lastAssistant?.tokens : undefined
  const tokens = finish?.tokens ?? stored
  // 结束通知没有报告用量时，仍从这次调用开始的位置计算正文，不能用默认零替换估算。
  const outputStart = lastSFIdx >= 0 && !hasInFlightTail && !finish
    ? lastParts.slice(0, lastSFIdx).findLastIndex((part) => part.type === "step-start") : lastSFIdx
  // 中断后已经收到的正文仍需估算；只计算最后一次确认以后保存的文字和参数。
  const streamingOut = !lastAssistant
    ? 0
    : lastParts.reduce((sum, p, i) => {
        if (i <= outputStart) return sum
        return sum + chars[i]
      }, 0)
  // 工具成功结果和报错文字都会回传给模型，需计入后续输入；尚未返回结果的工具此处不计。
  const pendingIn = !lastAssistant
    ? 0
    : lastParts.reduce((sum, p, i) => {
        if (i <= lastSFIdx || p.type !== "tool") return sum
        // 输入估算已包含 afterPartID 之前的结果，再加一次会重复计算。
        if (lastAssistant.inputEstimate && (p.id ?? "") <= (lastAssistant.inputEstimate.afterPartID ?? "")) return sum
        switch (p.state.status) {
          case "completed": return sum + p.state.output.length
          case "error": return sum + p.state.error.length
          default: return sum
        }
      }, 0)

  // 只交接数字和步骤元数据；共享缓存不保留正文、raw 或工具结果。
  return { assistant: !!lastAssistant, inputEstimate: lastAssistant?.inputEstimate, lastSFIdx, lastStepFinish, hasInFlightTail, finish, start, tokens, streamingOut, pendingIn }
}

export function computeFinalTokens(
  lastAssistant: AssistantMessage | undefined,
  lastParts: ReadonlyArray<TokenPart>,
  request: SessionRequestUsage,
  outputRatio = 4,
  tail = measureTail(lastAssistant, modelParts(lastParts)),
  inputRatio = 4,
) {
  // 同一 tail 可由每消息 owner 预先测量，三个消费者不再重新读取或序列化 Part。
  const finish = tail.finish
  const estimate = tail.inputEstimate ?? request.inputEstimate
  const density = request.inputEstimate?.charsPerToken
  const ratio = density !== undefined && Number.isFinite(density) && density > 0 ? density : inputRatio
  const pendingInputTokens = Math.round(tail.pendingIn / ratio)
  // 输出使用独立历史校准；请求体的 JSON/附件输入密度不能解释新生成的文本与参数。
  const pendingOutputTokens = Math.round(tail.streamingOut / outputRatio)
  // patch/snapshot 是收尾记录，不代表新请求；真正的确认点才遮掉旧估算。
  const projectedPendingInput = !tail.assistant || tail.lastSFIdx < 0 || tail.hasInFlightTail
    ? request.pendingInput : undefined
  // 当前调用已有确认记录就用确认数；没有确认时才保留输入估算，包括合法的零估算。
  const estimatedInput = !finish && (tail.lastStepFinish?.type === "step-finish" || estimate?.confirmed !== true)
    ? request.estimatedInput ?? estimate?.input : undefined
  // 基数沿原 request 投影；可见 finish 先到时立即替换，不用旧消息覆盖较新的投影。
  const confirmedInput = finish ? finish.tokens.input + finish.tokens.cache.read + finish.tokens.cache.write
    : tail.tokens && estimatedInput === undefined ? request.stepInput : undefined
  const confirmedOutput = finish ? finish.tokens.output + finish.tokens.reasoning
    : tail.tokens && estimatedInput === undefined ? request.stepOutput : undefined
  // 首轮只消费服务端实际请求估算，确认值包括零均不受本地 bootstrap 下限约束。
  const pendingStepInput = estimatedInput ?? (tail.start?.type === "step-start" && !finish ? tail.start.inputTokens : undefined) ?? (tail.hasInFlightTail && tail.lastStepFinish?.type === "step-finish"
    // 下一步继承末步完整上下文，输出、reasoning 和缓存输入均进入历史，不能用全部请求累计替代。
    ? tail.lastStepFinish.tokens.input + tail.lastStepFinish.tokens.cache.read + tail.lastStepFinish.tokens.cache.write
      + tail.lastStepFinish.tokens.output + tail.lastStepFinish.tokens.reasoning
    : projectedPendingInput ?? 0)
  const provisional = tail.hasInFlightTail || estimatedInput !== undefined || projectedPendingInput !== undefined
  const currentInput = Math.max(estimatedInput ?? 0, confirmedInput ?? (provisional ? pendingStepInput : request.stepInput)) + pendingInputTokens
  const currentOutput = Math.max(confirmedOutput ?? 0, provisional ? pendingOutputTokens : request.stepOutput)
  // 累计与已计入的当前步骤必须取自同一个 request；新到的确认数只替换它，不扣另一路记录。
  const totalInput = request.input + (confirmedInput !== undefined
    ? currentInput - request.stepInput
    : provisional ? currentInput : 0)
  const totalOutput = request.output + (confirmedOutput !== undefined
    ? currentOutput - request.stepOutput
    : provisional ? currentOutput : 0)

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
