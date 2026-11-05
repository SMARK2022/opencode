/**
 * accounting.ts — 统一 token 统计入口
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

import { TokenEstimate } from "./estimate"

// UI accounting only uses this when neither daemon estimates nor confirmed
// provider samples exist yet; source upload estimates live in TokenEstimate.
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
    totalInputPure: number
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
  providerID?: string
  modelID?: string
  cost?: number
  tokens?: { input: number; output: number; reasoning: number; cache: { read: number; write: number } }
  time?: { created?: number; completed?: number }
  /** Per-component character counts of the pending request body,
   *  persisted on the assistant message before the provider stream starts.
   *  Carries the daemon's exact request-body breakdown. */
  inputBreakdown?: {
    system: number; instructions: number; skills: number; tools: number
    messages: { userText: number; assistantText: number; reasoning: number; toolInput: number; toolOutput: number; attachments: number; total: number }
    media?: { rawChars: number; textChars: number; tokens: number; count: number; imageTokens: number; pdfTokens: number; otherTokens: number }
  }
  /** Character count of the pending request body before the provider stream starts. */
  inputChars?: number
  /** Estimated input tokens for the pending request (chars-per-token ratio). */
  inputTokens?: number
}

type Pt = { id?: string; type: string; [key: string]: any }

// 单条 Message 的贡献是原计算的可复用边界；正文变化不再使其他 Message 重新测量。
export function measureMessage(message: Msg, parts: ReadonlyArray<Pt>) {
  // 拷贝会参与选择/去重的 metadata，使 Solid 依赖在测量阶段而非每个 footer 建立。
  // reconcile 会保留对象身份，因此 cache/time 的属性变化也必须在这里被观察。
  const info = {
    ...message,
    time: message.time ? { ...message.time } : undefined,
    tokens: message.tokens ? { ...message.tokens, cache: { ...message.tokens.cache } } : undefined,
  }
  const atoms: { tokens: NonNullable<Msg["tokens"]>; cost: number }[] = []
  let calibrationChars = 0
  let calibrationTokens = 0
  if (info.role === "assistant") {
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]
      if (part.type !== "step-finish") continue
      // 保持每个 step 的费用顺序；预先按 Message 汇总浮点 cost 会改变旧结果。
      atoms.push({ tokens: { ...part.tokens, cache: { ...part.tokens.cache } }, cost: part.cost ?? 0 })
      const output = part.tokens.output + part.tokens.reasoning
      if (output <= 0) continue
      const start = parts.slice(0, i).findLastIndex((item) => item.type === "step-start")
      // 每份 provider usage 只校准其最近 step-start 后的输出，不能拿整条 Message 的字符重复配对。
      let chars = 0
      for (let j = start >= 0 ? start + 1 : 0; j < i; j++) {
        const item = parts[j]
        if (item.type === "text" && !item.ignored) chars += item.text?.length ?? 0
        if (item.type === "reasoning") chars += item.text?.length ?? 0
        // pending 的 raw 可能尚不是完整 JSON；计字符时不能提前解析或改用最终 input。
        if (item.type === "tool") chars += item.state?.status === "pending"
          ? item.state.raw?.length ?? 0 : JSON.stringify(item.state?.input ?? {}).length
      }
      if (chars > 0) {
        calibrationChars += chars
        calibrationTokens += output
      }
    }
  }
  const hasFinish = atoms.length > 0
  // 没有 step-finish 的既有 Message.tokens 仍是唯一兼容口径，不去查另一份账本。
  if (info.role === "assistant" && !hasFinish && info.tokens)
    atoms.push({ tokens: info.tokens, cost: info.cost ?? 0 })
  const sfIndex = parts.findLastIndex((part) => part.type === "step-finish")
  // 最近 finish 与最近携带 breakdown 的 start 分别定位，保留旧历史缺少 finish breakdown 的情形。
  const ssIndex = parts.findLastIndex((part) => part.type === "step-start" && part.inputBreakdown)
  const sf = sfIndex >= 0 ? parts[sfIndex] : undefined
  const ss = ssIndex >= 0 ? parts[ssIndex] : undefined
  let outputChars = 0
  let resultChars = 0
  let attachmentTokens = 0
  // finish 后的工具结果属于下次上传；只保留字符/附件数字，不复制输出正文。
  for (let i = sfIndex + 1; i < parts.length; i++) {
    const part = parts[i]
    if (part.type === "text" && !part.ignored) outputChars += part.text?.length ?? 0
    if (part.type === "reasoning") outputChars += part.text?.length ?? 0
    if (part.type !== "tool") continue
    outputChars += part.state?.status === "pending"
      ? part.state.raw?.length ?? 0 : JSON.stringify(part.state?.input ?? {}).length
    if (part.state?.status === "completed") {
      // 工具输出是未来上传的 input，而工具参数属于当前 assistant 的 output，两者不能混算。
      resultChars += part.state.output?.length ?? 0
      for (const attachment of part.state.attachments ?? [])
        // 附件沿用各自 MIME 的估算，再相加；合并字符后统一取整会丢失媒体语义。
        attachmentTokens += TokenEstimate.estimateAttachment(attachment).tokens
    }
    if (part.state?.status === "error") resultChars += part.state.error?.length ?? 0
  }
  const confirmed = !!sf && !!info.time?.completed
  const start = ssIndex >= 0 ? ssIndex : confirmed ? -1 : parts.length
  const end = confirmed && sfIndex >= 0 ? sfIndex : parts.length
  // 确认态在 finish 处封住当前输出，finish 后的工具结果仍单独归入 pending input。
  const live = { text: 0, reasoning: 0, tools: 0 }
  // breakdown 的本 step 输出区间与原实现一致，不能将上传历史再次算作当前输出。
  for (let i = start + 1; i < end; i++) {
    const part = parts[i]
    if (part.type === "text" && !part.ignored) live.text += part.text?.length ?? 0
    if (part.type === "reasoning") live.reasoning += part.text?.length ?? 0
    if (part.type === "tool") live.tools += part.state?.status === "pending"
      ? part.state.raw?.length ?? 0 : JSON.stringify(part.state?.input ?? {}).length
  }
  return {
    info, atoms, hasFinish, calibrationChars, calibrationTokens,
    sf, ss, outputChars, resultChars, attachmentTokens, live,
    // 校准只消费 step 的标量样本；重用原学习器的阈值、媒体修正及模型选择规则。
    samples: parts.filter((part) => part.type === "step-finish").map((part) => ({
      // 不预先把样本合并，原学习器仍需按模型、历史长度和媒体修正筛选样本。
      type: part.type, inputChars: part.inputChars, inputBreakdown: part.inputBreakdown, tokens: part.tokens,
    })),
  }
}

type Contribution = ReturnType<typeof measureMessage>
const emptyRequest = () => ({ input: 0, inputPure: 0, output: 0, cost: 0 })
export type AccountingPrefix = Record<string, ReturnType<typeof emptyRequest>>
const emptyMessage = measureMessage({ id: "", role: "none" }, [])

export function summarizeAccounting(items: readonly Contribution[], prefix: AccountingPrefix = {}) {
  const latest = items.findLast((item) => item.info.role === "assistant")
  const latestByRequest = new Map<string, Contribution>()
  for (const item of items)
    if (item.info.role === "assistant" && item.info.parentID) latestByRequest.set(item.info.parentID, item)
  // 页外是当前窗口之前的同源数字：先从该基线开始，再逐 step 加入可见贡献，保持费用顺序。
  const requests = new Map(Object.entries(prefix).map(([id, value]) => [id, { ...value }]))
  // 克隆基线而非原地累加，后续 footer 投影或下一次重算不能把同一个页外快照重复计入。
  const session = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }
  let outputChars = 0
  let outputTokens = 0
  // 汇总只遍历缓存数字，所有 request 共用一次校准，不再为每个 footer 重读正文。
  for (const item of items) {
    if (item.info.role !== "assistant") continue
    outputChars += item.calibrationChars
    outputTokens += item.calibrationTokens
    const parent = item.info.parentID
    const request = parent ? requests.get(parent) ?? emptyRequest() : undefined
    if (parent && request) requests.set(parent, request)
    for (const atom of item.atoms) {
      session.input += atom.tokens.input
      session.output += atom.tokens.output
      session.reasoning += atom.tokens.reasoning
      session.cacheRead += atom.tokens.cache.read
      session.cacheWrite += atom.tokens.cache.write
      session.cost += atom.cost
      // Session projection 仍描述原可见输入；页外投影只修复 request 累计，不扩大校准窗口。
      if (!request) continue
      // 最新 Message 的上传估算稍后作为当前 step 加入，不能在历史累计里再加一次。
      if (item.hasFinish || (parent && latestByRequest.get(parent)?.info.id !== item.info.id))
        request.input += atom.tokens.input + atom.tokens.cache.read + atom.tokens.cache.write
      request.inputPure += atom.tokens.input
      // 永久 pure input 不含 cache；cache-inclusive input 只用于原实时上下文口径。
      request.output += atom.tokens.output + atom.tokens.reasoning
      request.cost += atom.cost
    }
  }
  const inputRatio = TokenEstimate.learnInputCharsPerToken({
    messages: items.map((item) => ({
      role: item.info.role, providerID: item.info.providerID, modelID: item.info.modelID, parts: item.samples,
    })),
  })?.charsPerToken ?? DEFAULT_RATIO
  return {
    latest, latestByRequest, requests, session, inputRatio,
    // parentID 已由 prompt 生产者确定；分页和数字缓存不能再次决定 request 是否存在。
    activeRequest: latest ? latest.info.parentID : items.findLast((item) => item.info.role === "user")?.info.id,
    // 保留原先 >100 字符的 output 校准门槛，不能因分解而改变短文本估算。
    outputRatio: outputTokens > 0 && outputChars > 100 ? outputChars / outputTokens : DEFAULT_RATIO,
  }
}

export function projectAccounting(
  summary: ReturnType<typeof summarizeAccounting>,
  contextLimit?: number,
  requestUserID?: string,
): TokenAccounting {
  const selected = requestUserID ?? summary.activeRequest
  const latestRequest = selected ? summary.latestByRequest.get(selected) : undefined
  // 历史 footer 的 step、pending 与 totals 必须来自同一 parent，不能借全局 latest。
  const item = (requestUserID ? latestRequest : summary.latest) ?? emptyMessage
  const values = selected ? summary.requests.get(selected) ?? emptyRequest() : emptyRequest()
  const confirmedRequest = { ...values }
  // 显式历史 request 保留 legacy input；默认活跃 request 才扣掉已作为当前 step 使用的预估。
  if (!requestUserID && latestRequest && !latestRequest.hasFinish)
    confirmedRequest.inputPure -= latestRequest.info.tokens?.input ?? 0
  const sf = item.sf
  const completed = !!item.info.time?.completed
  const confirmed = !!sf && completed
  const infoTokens = item.info.tokens
  const baseInput = sf && completed
    ? sf.tokens.input + sf.tokens.cache.read + sf.tokens.cache.write
    : sf && !completed
      ? infoTokens
        ? infoTokens.input + infoTokens.cache.read + infoTokens.cache.write
        : sf.tokens.input + sf.tokens.cache.read + sf.tokens.cache.write
      : infoTokens ? infoTokens.input + infoTokens.cache.read + infoTokens.cache.write : 0
  const stepOutput = sf && completed
    ? sf.tokens.output + sf.tokens.reasoning : Math.round(item.outputChars / summary.outputRatio)
  const pending = Math.round(item.resultChars / summary.inputRatio)
  const stepInput = baseInput + pending + item.attachmentTokens
  // usage 已到、Message.completed 尚未到时，只叠加 finish 之后确定的新输入。
  const inFlightInput = confirmed ? 0 : sf && item.info.id === summary.latest?.info.id
    ? pending + item.attachmentTokens : stepInput
  let breakdown: TokenAccounting["breakdown"] = null
  const pendingMessage = item.info.inputBreakdown && item.info.inputChars
    ? { type: "message", inputBreakdown: item.info.inputBreakdown, inputChars: item.info.inputChars, inputTokens: item.info.inputTokens }
    : undefined
  // pending、step-start、step-finish 的权威递进保持在一个 owner，不让消费者猜来源。
  const source = sf?.inputBreakdown ? sf : item.ss?.inputBreakdown ? item.ss : pendingMessage
  if (source?.inputBreakdown && source.inputChars) {
    const bd = source.inputBreakdown
    const isConfirmed = source.type === "step-finish" && confirmed && sf
    const allocInput = isConfirmed
      ? sf.tokens.input + sf.tokens.cache.read + sf.tokens.cache.write
      : source.inputTokens ?? Math.round(source.inputChars / summary.inputRatio)
    const media = bd.media
    const attachmentTokens = media?.tokens
    const textInput = attachmentTokens == null ? allocInput : Math.max(0, allocInput - attachmentTokens)
    const denominator = media ? Math.max(1, source.inputChars - media.rawChars + media.textChars) : source.inputChars
    // 媒体 token 已独立计量；文本分摊不能再把 base64 原始长度当作普通正文占比。
    const allocate = (chars: number) => denominator > 0 ? Math.round(chars / denominator * textInput) : 0
    let liveText = 0
    let liveReasoning = 0
    let liveTools = 0
    if (isConfirmed) {
      // 确认态 reasoning 来自 provider；visible output 再按 text/tool 字符比例分摊。
      liveReasoning = sf.tokens.reasoning
      const visible = sf.tokens.output
      const chars = item.live.text + item.live.tools
      liveText = chars > 0 ? Math.round(visible * item.live.text / chars) : visible
      liveTools = Math.max(0, visible - liveText)
    } else {
      liveText = Math.round(item.live.text / summary.outputRatio)
      liveReasoning = Math.round(item.live.reasoning / summary.outputRatio)
      liveTools = Math.round(item.live.tools / summary.outputRatio)
    }
    breakdown = {
      system: allocate(bd.system), instructions: allocate(bd.instructions), skills: allocate(bd.skills), tools: allocate(bd.tools),
      userMessages: allocate(bd.messages.userText), toolResults: allocate(bd.messages.toolOutput),
      attachments: attachmentTokens ?? allocate(bd.messages.attachments),
      assistantText: allocate(bd.messages.assistantText) + liveText,
      reasoning: allocate(bd.messages.reasoning) + liveReasoning,
      toolCalls: allocate(bd.messages.toolInput) + liveTools,
      pending: pending + item.attachmentTokens,
    }
  }
  const limit = contextLimit ?? 0
  // 没有模型 limit 时继续返回 null 百分比，不能把未知上限伪装成已确认的 0%。
  return {
    step: { input: stepInput, output: stepOutput, confirmed },
    request: {
      input: stepInput, output: stepOutput,
      totalInput: confirmedRequest.input + inFlightInput,
      totalInputPure: confirmedRequest.inputPure,
      totalOutput: confirmedRequest.output + (confirmed ? 0 : stepOutput), cost: confirmedRequest.cost,
    },
    session: summary.session, contextLimit: limit,
    contextPercent: limit > 0 ? Math.round((stepInput + stepOutput) / limit * 100) : null,
    breakdown, ratio: { input: summary.inputRatio, output: summary.outputRatio },
  }
}

// 一次性消费者和共享 owner 组合相同阶段，只有复用粒度不同，没有第二套统计公式。
export function tokenAccounting(
  messages: ReadonlyArray<Msg>,
  getParts: (id: string) => ReadonlyArray<Pt>,
  contextLimit?: number,
  requestUserID?: string,
): TokenAccounting {
  return projectAccounting(
    summarizeAccounting(messages.map((message) => measureMessage(message, getParts(message.id)))),
    contextLimit,
    requestUserID,
  )
}

export * as TokenAccounting from "./accounting"
