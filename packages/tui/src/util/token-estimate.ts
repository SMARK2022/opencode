import type { AssistantMessage, Message, Part, Provider, SessionRequestUsage } from "@opencode-ai/sdk/v2"
import { estimate } from "@opencode-ai/core/util/token"

export type UsageInfo = {
  input: number
  output: number
  totalInput: number
  totalOutput: number
  context: string | undefined
  cost: string | undefined
}

// 服务端系统提示包含模型身份、目录、git、平台、技能和用户指令；800 仅粗估未知开销，provider 确认后不作为真实输入下限。
export const SYSTEM_PROMPT_OVERHEAD = 800

// 工具名称、描述和 JSON Schema 在 15-25 个活跃工具下可达 3000-8000+ 字符；2000 沿用源典型开销，不是精确上界。
export const TOOL_DEFINITION_OVERHEAD = 2000

export function estimateDataUrlInputTokens(url: string, mime: string) {
  if (!url.startsWith("data:")) return 0
  const comma = url.indexOf(",")
  if (comma < 0) return 0
  const payloadLength = url.length - comma - 1
  if (payloadLength <= 0) return 0
  // 图片沿用每 750 字符约 1 token、1600 封顶的视觉启发式，不把 base64 当等长文本；实际用量以 provider 确认为准。
  if (mime.startsWith("image/")) return Math.max(1, Math.min(1600, Math.round(payloadLength / 750)))
  // PDF 沿用每 1100 字符约 1 token 且不套图片封顶，多页文档负载增长仍参与估算。
  if (mime === "application/pdf") return Math.max(1, Math.round(payloadLength / 1100))
  // 其他 MIME 没有视觉估算规则，负载回到通用文本估算。
  return Math.max(1, estimate(url.slice(comma + 1)))
}

export function estimateUserInputTokens(parts: ReadonlyArray<Part>) {
  return parts.reduce((sum, part) => {
    // synthetic 文件、编辑器和 MCP 正文也发送给模型，只有 ignored 文本不计入。
    if (part.type === "text" && !part.ignored) {
      return sum + estimate(part.text ?? "")
    }
    if (part.type === "file") {
      // text/plain 和目录已展开成 synthetic 正文，模型投影跳过原附件，不能重复计数。
      if (part.mime === "text/plain" || part.mime === "application/x-directory") return sum
      return sum + estimateDataUrlInputTokens(part.url ?? "", part.mime ?? "")
    }
    if (part.type === "agent") {
      return sum + estimate(part.name ?? "")
    }
    if (part.type === "subtask") {
      return sum + estimate(`${part.description ?? ""}\n${part.prompt ?? ""}`)
    }
    return sum
  }, 0)
}

export function estimateRequestOverhead(): number {
  // 首轮无助手确认时用系统提示和工具定义粗估引导上下文。
  return SYSTEM_PROMPT_OVERHEAD + TOOL_DEFINITION_OVERHEAD
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

export function getContextSize(
  item: AssistantMessage,
  getParts: (id: string) => ReadonlyArray<Part>,
): number {
  const parts = getParts(item.id)
  // 上下文以最新一轮确认为准，倒序只取最后 step-finish，早期确认不再代表当前大小。
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
  messages: ReadonlyArray<Message>,
  request: SessionRequestUsage | undefined,
  getParts: (id: string) => ReadonlyArray<Part>,
): number {
  // 请求身份来自持久化投影，显示窗口最后一个用户可能属于其他请求。
  const user = messages.find((item) => item.id === request?.messageID && item.role === "user")
  // 用户被窗口淘汰时零表示缺少可估正文，不能借用旧用户内容。
  if (!user) return 0
  const estimatedPromptInputTokens = estimateUserInputTokens(getParts(user.id))
  // 只借用用户之前的助手上下文，防止排队或混合入口中的较新回复混入本次估算。
  const previousAssistant = messages.findLast(
    (item): item is AssistantMessage => item.role === "assistant" && item.parentID !== user.id && item.time.created < user.time.created,
  )
  const previousContextSize = previousAssistant ? getContextSize(previousAssistant, getParts) : 0
  // 历史上下文取最后一步，不取全部请求累计；固定开销只用于没有可见历史确认的引导。
  return previousContextSize > 0
    ? previousContextSize + estimatedPromptInputTokens
    : estimatedPromptInputTokens + estimateRequestOverhead()
}

export function computeFinalTokens(
  lastAssistant: AssistantMessage | undefined,
  lastParts: ReadonlyArray<Part>,
  request: SessionRequestUsage,
  bootstrapInputTokens: number,
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
        if (p.type === "tool" && p.state.status === "completed") return sum + p.state.output.length
        return sum
      }, 0)

  // 字符数 / 4 是通用 token 估算比率，适用于英文为主的代码和文本
  const pendingInputTokens = Math.round(pendingIn / 4)
  const pendingOutputTokens = Math.round(streamingOut / 4)
  // 可见尾部可能先于 Session 快照到达；立即遮掉旧 step，保留请求历史累计。
  const hasInFlightTail = !!lastAssistant && lastAssistant.time.completed === undefined && lastParts.some((_, i) => i > lastSFIdx)
  // input 为零不足以判定未确认，还须检查 output、step-finish 与完成时间；assistantID 存在而缓存缺失时相信投影。
  const unconfirmed = request.input === 0 && request.output === 0 && request.stepInput === 0 && request.stepOutput === 0
    && lastSFIdx < 0 && (!request.assistantID || (!!lastAssistant && lastAssistant.time.completed === undefined))
  // bootstrap 只属于首轮尚未确认的请求，确认零也必须退出引导估算。
  const promptInputEstimate = unconfirmed ? bootstrapInputTokens : 0
  const lastStepFinish = lastParts[lastSFIdx]
  // 未确认续轮保留源 bootstrap；完成态和明确零确认继续服从真实投影。
  const currentPromptInputEstimate = !!lastAssistant && lastAssistant.time.completed === undefined
    && ((lastSFIdx < 0 && request.stepInput === 0 && request.stepOutput === 0)
      || (hasInFlightTail && lastStepFinish?.type === "step-finish"
        && lastStepFinish.tokens.input + lastStepFinish.tokens.cache.read + lastStepFinish.tokens.cache.write
          + lastStepFinish.tokens.output + lastStepFinish.tokens.reasoning > 0))
    ? bootstrapInputTokens : promptInputEstimate
  // step 确认来自完整投影，native 无 V1 parts 或助手被淘汰仍保留真实值，不以粗略系统开销抬高它。
  const currentInput = (hasInFlightTail ? 0 : request.stepInput) + pendingInputTokens + currentPromptInputEstimate
  const currentOutput = (hasInFlightTail ? 0 : request.stepOutput) + pendingOutputTokens
  // step 与 request 两种范围各加一次尾部；请求累计永远不由有限 transcript 求和。
  const totalInput = request.input + pendingInputTokens + promptInputEstimate
  const totalOutput = request.output + pendingOutputTokens

  return {
    input: currentInput,
    output: currentOutput,
    totalInput,
    totalOutput,
  }
}

export function getContextLimit(
  provider: ReadonlyArray<Provider>,
  providerID: string | undefined,
  modelID: string | undefined,
): number | undefined {
  // 模型缺省时没有可算上限，保留 undefined，不能拿系统开销代替上下文窗口。
  if (!providerID || !modelID) return undefined
  return provider.find((item) => item.id === providerID)?.models[modelID]?.limit.context
}
