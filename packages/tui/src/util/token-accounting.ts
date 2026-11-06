// #175：TUI 固定侧分配 media.tokens，不抢 system/user 文本份额
// step/request/session 共用统计入口，持久投影拥有完整累计，parts 只提供当前尾部。
// 确认分类按 categoryChars / inputChars 分配 provider input，不在 TUI 重建请求体。

import { AttachmentToken } from "@opencode-ai/core/util/attachment-token"
import type { AssistantMessage, Part, Session } from "@opencode-ai/sdk/v2"
import { computeFinalTokens, measureOutput, measureTail, modelParts, type TokenPart } from "./token-estimate"

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
    // 消息底部上传数不含缓存命中的历史输入；输入框附近的窗口用量仍读取包含缓存的 totalInput。
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

type Projection = {
  session: Pick<Session, "tokens" | "cost" | "request"> | undefined
  last: AssistantMessage | Pick<AssistantMessage, "id"> | undefined
  parts: ReadonlyArray<Part>
}

export type RequestTotals = { input: number; inputPure: number; output: number; cost: number }
const emptyRequest = (): RequestTotals => ({ input: 0, inputPure: 0, output: 0, cost: 0 })

const shared = new WeakMap<NonNullable<Projection["session"]>, () => ReturnType<typeof summarizeAccounting>>()

// 旧视图已传入同一个 Session 对象，只绑定原 owner 的数字 accessor，不复制贡献或正文。
export function shareAccounting(session: NonNullable<Projection["session"]>, read: () => ReturnType<typeof summarizeAccounting>) {
  shared.set(session, read)
  // Session 移除或 Sync 销毁就解绑，旧视图不能再次唤起已卸载的 owner。
  return () => shared.delete(session)
}

// ─── 主函数 ──────────────────────────────────────────────────────────────────

// #122：一次遍历汇总 step/request/session，确认优先于估算
export function tokenAccounting(
  messages: ReadonlyArray<Msg>,
  getParts: (id: string) => ReadonlyArray<TokenPart>,
  contextLimit?: number,
  projection?: Projection,
  // #490：显式历史 request 选择器——只改变 request projection 的 parent，不改变 session 全量遍历
  requestUserID?: string,
): TokenAccounting {
  const read = projection?.session && shared.get(projection.session)
  const summary = read?.() ?? summarizeAccounting(messages.map((message) =>
    measureMessage(message, message.role === "assistant" ? getParts(message.id) : [])))
  return projectAccounting(summary, contextLimit, projection, requestUserID)
}

// 沿旧性能提交的 Message 边界测量。只返回数字与步骤元数据，不把正文留在共享 owner。
export function measureMessage(message: Msg, allParts: ReadonlyArray<TokenPart>) {
  const parts = modelParts(allParts)
  // 在测量时读取响应式字段，后续汇总不再订阅原消息或因视图数量重复访问正文。
  const info = {
    id: message.id,
    role: message.role,
    parentID: message.parentID,
    cost: message.cost,
    tokens: message.tokens ? { ...message.tokens, cache: { ...message.tokens.cache } } : undefined,
    time: message.time ? { ...message.time } : undefined,
    inputEstimate: message.inputEstimate ? { ...message.inputEstimate } : undefined,
  }
  // 校准、尾部和分类复用同次字符测量，尤其避免重复序列化工具参数。
  const chars = parts.map(measureOutput)
  const tail = measureTail(info.role === "assistant" ? info : undefined, parts, chars)
  const atoms: { tokens: NonNullable<Msg["tokens"]>; cost: number }[] = []
  let inputChars = 0
  let inputTokens = 0
  let outputChars = 0
  let outputTokens = 0
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]
    if (part.type !== "step-finish") continue
    // 每个 finish 的顺序保留，不能先改变浮点费用的累加顺序。
    atoms.push({ tokens: { ...part.tokens, cache: { ...part.tokens.cache } }, cost: part.cost ?? 0 })
    const start = parts.slice(0, i).findLastIndex((item) => item.type === "step-start")
    const stepChars = chars.slice(start + 1, i).reduce((sum, value) => sum + value, 0)
    const input = part.tokens.input + part.tokens.cache.read + part.tokens.cache.write
    const output = part.tokens.output + part.tokens.reasoning
    const bd = part.inputBreakdown
    // 媒体固定 token 不进入文本密度，沿用原有样本门槛和 2..8 钳位。
    if (part.inputChars !== undefined && part.inputChars >= 100 && input > 0 && (!bd?.messages.attachments || bd.media)) {
      inputChars += bd?.media ? Math.max(0, part.inputChars - bd.media.rawChars + bd.media.textChars) : part.inputChars
      inputTokens += Math.max(0, input - (bd?.media?.tokens ?? 0))
    }
    if (output > 0 && stepChars > 0) {
      // 只有生成侧的已报告输出能训练输出密度，输入校准不能混进该样本。
      outputChars += stepChars
      outputTokens += output
    }
  }
  const hasFinish = atoms.length > 0
  if (info.role === "assistant" && !hasFinish && info.tokens) {
    // 已发布的无 finish 消息仍保留原 tokens/cost 合同，不把估算伪装成费用。
    atoms.push({ tokens: info.tokens, cost: info.cost ?? 0 })
    const output = info.tokens.output + info.tokens.reasoning
    if (info.time?.completed !== undefined && output > 0) {
      outputChars += chars.reduce((sum, value) => sum + value, 0)
      outputTokens += output
    }
  }
  const sf = tail.lastStepFinish?.type === "step-finish" ? tail.lastStepFinish : undefined
  const ssIdx = parts.findLastIndex((part) => part.type === "step-start" && !!part.inputBreakdown)
  const ss = parts[ssIdx]
  const estimate = info.inputEstimate
  const pending = estimate?.inputBreakdown
    ? { type: "pending" as const, inputChars: estimate.bodyChars, inputTokens: estimate.input, inputBreakdown: estimate.inputBreakdown }
    : undefined
  // 本次输入还未确认时，用准备这次请求时保存的分类，避免显示前一次调用的输入分类。
  const source = pending && estimate?.confirmed === false
    ? pending
    : sf?.inputBreakdown && tail.lastSFIdx > ssIdx ? sf
    : ss?.type === "step-start" && ss.inputBreakdown ? ss : pending
  const cursor = estimate?.afterPartID
  // 已确认分类只取其步骤内的生成片段；下一轮准备后只看游标以后的新内容。
  const begin = source?.type === "step-finish"
    ? parts.slice(0, tail.lastSFIdx).findLastIndex((part) => part.type === "step-start")
    : Math.max(ssIdx, estimate?.confirmed === false ? -1 : tail.lastSFIdx, cursor ? parts.findLastIndex((part) => (part.id ?? "") <= cursor) : -1)
  const end = source?.type === "step-finish" ? tail.lastSFIdx : parts.length
  const live = { text: 0, reasoning: 0, tools: 0 }
  let attachmentTokens = 0
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]
    if (i > begin && i < end) {
      if (part.type === "text") live.text += chars[i]
      if (part.type === "reasoning") live.reasoning += chars[i]
      if (part.type === "tool") live.tools += chars[i]
    }
    if (i <= tail.lastSFIdx || part.type !== "tool" || part.state.status !== "completed") continue
    if (estimate && (part.id ?? "") <= (estimate.afterPartID ?? "")) continue
    // 工具回执中的媒体按既有固定 token 规则计入输入，不用正文密度解释二进制载荷。
    for (const attachment of part.state.attachments ?? []) attachmentTokens += AttachmentToken.estimateAttachment(attachment).tokens
  }
  return { info, atoms, hasFinish, tail, inputChars, inputTokens, outputChars, outputTokens, source, live, attachmentTokens }
}

const emptyMessage = measureMessage({ id: "", role: "none" }, [])

export function summarizeAccounting(items: ReadonlyArray<ReturnType<typeof measureMessage>>) {
  const latest = items.findLast((item) => item.info.role === "assistant")
  const byID = new Map(items.map((item) => [item.info.id, item]))
  const latestByRequest = new Map<string, typeof emptyMessage>()
  // 按真实 parent 归属保留末助手，排队但尚无回复的 user 不接管当前请求。
  for (const item of items) if (item.info.role === "assistant" && item.info.parentID) latestByRequest.set(item.info.parentID, item)
  const requests = new Map<string, RequestTotals>()
  const session = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }
  let inputChars = 0
  let inputTokens = 0
  let outputChars = 0
  let outputTokens = 0
  // 汇总只访问贡献数字。每个请求和每个视图共用这次校准，不重读历史 Part。
  for (const item of items) {
    if (item.info.role !== "assistant") continue
    inputChars += item.inputChars
    inputTokens += item.inputTokens
    outputChars += item.outputChars
    outputTokens += item.outputTokens
    const request = item.info.parentID ? requests.get(item.info.parentID) ?? emptyRequest() : undefined
    if (request && item.info.parentID) requests.set(item.info.parentID, request)
    for (const atom of item.atoms) {
      session.input += atom.tokens.input
      session.output += atom.tokens.output
      session.reasoning += atom.tokens.reasoning
      session.cacheRead += atom.tokens.cache.read
      session.cacheWrite += atom.tokens.cache.write
      session.cost += atom.cost
      if (!request) continue
      // 当前无 finish 的输入可能仍是旧式准备值，留给尾部选择，避免累计同一估算两次。
      if (item.hasFinish || item.tail.tokens || latestByRequest.get(item.info.parentID ?? "") !== item)
        request.input += atom.tokens.input + atom.tokens.cache.read + atom.tokens.cache.write
      request.inputPure += atom.tokens.input
      request.output += atom.tokens.output + atom.tokens.reasoning
      request.cost += atom.cost
    }
  }
  // 保留旧样本门槛；少量短输出不重新校准整个会话的显示，输入仍按原范围钳位。
  const inputRatio = inputTokens > 0 && inputChars > 500 ? Math.min(8, Math.max(2, inputChars / inputTokens)) : DEFAULT_RATIO
  const outputRatio = outputTokens > 0 && outputChars > 100 ? outputChars / outputTokens : DEFAULT_RATIO
  // 按真实 parent 汇集各助手的未结算差额，切换助手不等于结算上一助手。
  const pending = new Map<string, { input: number; output: number }>()
  const tails = new Map<string, { input: number; output: number }>()
  for (const item of items) {
    if (item.info.role !== "assistant" || !item.info.parentID) continue
    const value = pending.get(item.info.parentID) ?? { input: 0, output: 0 }
    pending.set(item.info.parentID, value)
    // 本地基数与已计入的步骤用同一份数字，不能伪造零累计再扣掉真实确认数。
    const stepInput = item.tail.tokens ? item.tail.tokens.input + item.tail.tokens.cache.read + item.tail.tokens.cache.write : 0
    const stepOutput = item.tail.tokens ? item.tail.tokens.output + item.tail.tokens.reasoning : 0
    const projected = computeFinalTokens(undefined, [], {
      messageID: item.info.parentID, input: stepInput, output: stepOutput, cost: 0,
      stepInput, stepOutput,
      inputEstimate: item.tail.inputEstimate,
    }, outputRatio, item.tail, inputRatio)
    const extra = { input: projected.totalInput - stepInput, output: projected.totalOutput - stepOutput }
    value.input += extra.input
    value.output += extra.output
    tails.set(item.info.id, extra)
  }
  const unsettled = [...pending.values()].reduce((sum, value) => ({ input: sum.input + value.input, output: sum.output + value.output }), { input: 0, output: 0 })
  return { items, byID, latest, latestByRequest, requests, session, inputRatio, outputRatio, pending, tails, unsettled }
}

export function projectAccounting(
  summary: ReturnType<typeof summarizeAccounting>,
  contextLimit?: number,
  projection?: Projection,
  requestUserID?: string,
  confirmed?: RequestTotals,
): TokenAccounting {
  // 显式历史请求不借当前 Session.request，避免把别轮实时估算带进永久记录。
  const active = requestUserID ? undefined : projection?.session?.request
  const selected = requestUserID ?? active?.messageID ?? summary.latest?.info.parentID
  // 服务端指定助手但正文尚未加载时保持该边界，不能借另一个旧助手的报告填空。
  const item = (active ? active.assistantID ? summary.byID.get(active.assistantID) : undefined
    : requestUserID ? summary.latestByRequest.get(requestUserID)
    : projection ? projection.last ? summary.byID.get(projection.last.id) : undefined : summary.latest) ?? emptyMessage
  // footer 的资源覆盖完整确认前缀，优先于只包含当前可见页的本地确认贡献。
  const values = confirmed ?? (selected ? summary.requests.get(selected) : undefined) ?? emptyRequest()
  const tokens = item.tail.tokens ?? item.info.tokens
  const legacy = !item.hasFinish && !item.info.inputEstimate && !item.tail.tokens
  const request = {
    ...(active ?? {
      messageID: selected ?? "",
      // 旧账本已含这条消息保存的输入估算，先移出同一份值，再由统一估算入口计入一次。
      input: values.input - (confirmed && legacy && tokens ? tokens.input + tokens.cache.read + tokens.cache.write : 0),
      output: values.output, cost: values.cost,
      stepInput: tokens ? tokens.input + tokens.cache.read + tokens.cache.write : 0,
      stepOutput: tokens ? tokens.output + tokens.reasoning : 0,
      inputEstimate: item.info.inputEstimate,
    }),
    // 旧消息保存的输入估算也用于 Session 入口，不能因传入投影就丢掉 step-start 或 tokens 的已有值。
    estimatedInput: active?.estimatedInput ?? (legacy && tokens ? item.tail.start?.type === "step-start" && item.tail.start.inputTokens !== undefined
      ? item.tail.start.inputTokens : tokens.input + tokens.cache.read + tokens.cache.write : undefined
    ),
  }
  const density = active?.inputEstimate?.charsPerToken
  const inputRatio = density !== undefined && Number.isFinite(density) && density > 0 ? density : summary.inputRatio
  const current = computeFinalTokens(undefined, [], request, summary.outputRatio, item.tail, inputRatio)
  const pending = selected ? summary.pending.get(selected) : undefined
  const own = summary.tails.get(item.info.id)
  // 当前步骤已由 current 计入；请求补其他助手和较早未确认轴时必须扣掉 own。
  const totalInput = current.totalInput + (pending?.input ?? 0) - (own?.input ?? 0)
  const totalOutput = current.totalOutput + (pending?.output ?? 0) - (own?.output ?? 0)
  // 分类与主数值共用消息准备快照，避免 Session 投影先到时出现不同确认状态。
  const estimate = item.info.inputEstimate ?? active?.inputEstimate
  const pendingMsg =
    estimate?.inputBreakdown
      ? {
          type: "pending" as const,
          inputBreakdown: estimate.inputBreakdown,
          inputChars: estimate.bodyChars,
          inputTokens: estimate.input,
        }
      : undefined
  // 准备快照与 finish 的分类按同一游标换代，不能把旧输入类别套到新请求。
  const breakdownSrc = pendingMsg && estimate?.confirmed === false
    ? pendingMsg : item.source ?? pendingMsg
  let breakdown: TokenAccounting["breakdown"] = null
  if (breakdownSrc?.inputBreakdown && breakdownSrc.inputChars !== undefined) {
    const bd = breakdownSrc.inputBreakdown
    // provider 确认优先于旧 prepared 密度，不必等整条消息 completed。
    const confirmedInput = breakdownSrc.type === "step-finish"
      ? breakdownSrc.tokens.input + breakdownSrc.tokens.cache.read + breakdownSrc.tokens.cache.write
      : breakdownSrc.type === "pending" && estimate?.confirmed === true
        ? active?.stepInput ?? current.input
        : item.tail.tokens ? current.input : breakdownSrc.inputTokens ?? Math.round(breakdownSrc.inputChars / inputRatio)
    const denom = breakdownSrc.inputChars
    // #175：先固定切走 media.tokens
    const media = bd.media
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
    // 字符已在变化消息的测量阶段取得；沿用原分配公式，不为每个视图重读 Part。
    const textC = item.live.text, reasonC = item.live.reasoning, toolC = item.live.tools
    const outputRatio = summary.outputRatio
    const outputTokens = item.tail.tokens
    if (outputTokens) {
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
    const pendingToolResultTokens = Math.round(item.tail.pendingIn / inputRatio)
    const pendingAttachTokens = item.attachmentTokens
    breakdown = {
      system, instructions, skills, tools, userMessages, toolResults, attachments,
      // #127：UI 展示 = 上传上下文份额 + 本 step 新输出
      assistantText: inputAssistantText + liveAssistantText,
      reasoning: inputReasoning + liveReasoning,
      toolCalls: inputToolCalls + liveToolCalls,
      pending: pendingToolResultTokens + pendingAttachTokens,
    }
  }
  const limit = active?.model?.contextLimit ?? contextLimit ?? 0
  // 首包前可以只有服务端 prepared 投影，替换对应本地尾部而非再加一次。
  const sessionInput = summary.unsettled.input + (active ? current.totalInput - active.input - (own?.input ?? 0) : 0)
  const sessionOutput = summary.unsettled.output + (active ? current.totalOutput - active.output - (own?.output ?? 0) : 0)
  // 已确认消费与实时有效值来自同一前缀；Context 的费用区不能把估算标成确认用量。
  const confirmedSession = projection?.session?.tokens
    ? { input: projection.session.tokens.input, output: projection.session.tokens.output, reasoning: projection.session.tokens.reasoning,
        cacheRead: projection.session.tokens.cache.read, cacheWrite: projection.session.tokens.cache.write, cost: projection.session.cost ?? 0 }
    : summary.session
  return {
    step: { input: current.input, output: current.output, confirmed: !!item.tail.tokens },
    request: {
      input: current.input, output: current.output, totalInput, totalOutput,
      // footer 继续展示纯 input，prompt 的窗口用量则包含 cache；两种范围共享同一贡献。
      totalInputPure: confirmed ? confirmed.inputPure + (pending?.input ?? 0)
        : summary.items.some((entry) => entry.info.role === "user" && entry.info.id === selected)
          ? values.inputPure - (!requestUserID && legacy ? tokens?.input ?? 0 : 0) : 0,
      cost: active?.cost ?? values.cost,
    },
    // 确认账本仍拥有完整前缀；只有尚未结算的贡献加入显示，不写回费用或 tokens。
    session: { ...confirmedSession, input: confirmedSession.input + sessionInput, output: confirmedSession.output + sessionOutput },
    contextLimit: limit,
    // 窗口比例属于当前步骤，不使用多轮请求累计或整个会话消费量作分子。
    contextPercent: limit > 0 ? Math.round((current.input + current.output) / limit * 100) : null,
    breakdown,
    ratio: { input: inputRatio, output: summary.outputRatio },
  }
}
