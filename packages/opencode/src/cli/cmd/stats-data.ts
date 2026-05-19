// #180：SQL 会话预过滤 + 工具事件单遍生成
import { Effect, Schema } from "effect"
import { MessageID } from "@/session/schema"
import { Session } from "@/session/session"
// #174：assistant 表优先费用
// #174：request 表补次数
// #174：request 行只补次数
import { RequestUsageAssistantTable, RequestUsageTable } from "@opencode-ai/core/session/request-usage.sql"
// #174：NotFound 变空数组
// #174：单会话 NotFound 降级为空数组，不中断整批
// #174：单会话缺失降级为空，不中断整批
import { NotFoundError } from "@/storage/storage"
import { Database } from "@opencode-ai/core/database/database"
import { eq, sql } from "drizzle-orm"
// #174：SessionTable 只用于枚举，不在此写用量
import { SessionTable, SessionMessageTable } from "@opencode-ai/core/session/sql"
import { SessionMessage } from "@opencode-ai/core/session/message"
import type { Project } from "@/project/project"
import type { SessionID } from "@/session/schema"

// #174：MICROS 定义存库到显示的换算
// #174：费用以微美元存库，显示只除一次 1e6
const MICROS = 1_000_000
// #174：MS_IN_DAY 与 days 窗口同口径
const MS_IN_DAY = 24 * 60 * 60 * 1000

// #174：TokenTotals 固定五类+total 字段
export type TokenTotals = {
  input: number
  output: number
  reasoning: number
// #174：cache 读写与 output 分列
  cache: { read: number; write: number }
  total: number
}

// #174：UsageTotals 含 tokens/cost/两次计数
export type UsageTotals = {
  tokens: TokenTotals
  // #176：组件 token 归因与请求结局计数同属用量契约
  components: InputComponentTotals
  cost: number
// #174：requests 字段只累加次数，不带费用
  requests: number
// #174：assistantCalls 与 requests 分列，避免混口径
// #174：assistant 行优先 cost/model 防双计
  assistantCalls: number
  // #176：errors/aborted 由 status==error/aborted 累计，durationMs 来自 request 行完成时刻
  errors: number
  aborted: number
  durationMs: number
}

// #174：UsageGroup 含 sessions 与子榜
export type UsageGroup = UsageTotals & {
  id: string
  label: string
  sessions: number
  providers: { id: string; tokens: number }[]
  models: { id: string; tokens: number }[]
}

// #174：DailyUsage 是日聚合点
export type DailyUsage = UsageTotals & {
  day: number
  label: string
}

// #174：UsageSeries 供多图复用
export type UsageSeries = UsageTotals & {
  id: string
  label: string
  points: DailyUsage[]
}

// #174：TokenPartSeries 限定四分列 id
export type TokenPartSeries = {
  id: "input" | "output" | "cacheRead" | "cacheWrite"
  label: string
  points: { day: number; label: string; value: number }[]
  total: number
}

// #174：SessionUsage 含 title/directory
export type SessionUsage = UsageTotals & {
  id: SessionID
  title: string
  projectID: string
  directory: string
  created: number
  updated: number
// #174：messages 按 session 拉取
  messages: number
// #174：工具次数来自 parts
// #174：工具次数来自 message parts
  tools: number
  providers: string[]
  models: string[]
}

// #176：工具维度：次数 + IO 字符 + 归因上下文 token
// #176：ToolUsage 扩展 count/IO/context 三计量
export type ToolUsage = {
  id: string
  count: number
  inputChars: number
  outputChars: number
  contextTokens: number
}

// #174：StatsReport 是渲染只读契约
export type StatsReport = {
// #174：totalSessions 计数
  totalSessions: number
// #174：sessionsWithUsage 排除零用量
  sessionsWithUsage: number
// #174：totalMessages 汇总
  totalMessages: number
// #174：totalTools 汇总
  totalTools: number
  days: number
// #174：requestedDays 回显用户参数
  requestedDays?: number
// #174：dateRange 记录跨度
  dateRange: { earliest: number; latest: number }
  total: UsageTotals
  models: UsageGroup[]
  providers: UsageGroup[]
  daily: DailyUsage[]
// #174：modelSeries 供图
  modelSeries: UsageSeries[]
// #174：providerSeries 供图
  providerSeries: UsageSeries[]
// #174：tokenPartSeries 供堆叠
  tokenPartSeries: TokenPartSeries[]
  sessions: SessionUsage[]
  // #176：工具用量含字符与上下文 token 归因
  toolUsage: ToolUsage[]
  agents: UsageGroup[]
  sources: UsageGroup[]
  statuses: UsageGroup[]
  projects: UsageGroup[]
  agentSeries: UsageSeries[]
  sourceSeries: UsageSeries[]
  statusSeries: UsageSeries[]
  projectSeries: UsageSeries[]
  modelProviderTokens: { providerID: string; modelID: string; tokens: number }[]
// #174：tokensPerSession 均摊
  tokensPerSession: number
// #174：median 抗长尾
// #174：medianTokensPerSession 字段
// #174：会话 tokens 取中位抗长尾
  medianTokensPerSession: number
}

// #174：StatsFilter 描述 days/project
export type StatsFilter = {
  days?: number
// #174：projectFilter 空串绑当前项目
  projectFilter?: string
  currentProject?: Project.Info
  // #176：明细过滤下推到聚合事件/会话
  // #176：session 子串可匹配 id/title/directory
  sessionFilter?: string
  modelFilter?: string
  providerFilter?: string
  sourceFilter?: string
  agentFilter?: string
  statusFilter?: string
  toolFilter?: string
}

type UsageEvent = {
  time: number
  sessionID: SessionID
  providerID: string
  modelID: string
  tokens: TokenTotals
  cost: number
  requests: number
  assistantCalls: number
  // #176：请求维归因字段（来自 request_usage）
  source?: string
  agent?: string
  status?: string
  projectID?: string
  // #176：组件归因与请求结局计量，构造时携带避免事后猜测式 join
  components: InputComponentTotals
  errors: number
  aborted: number
  durationMs: number
}

type SessionAggregate = {
  session: Session.Info
  messageCount: number
  toolUsage: Record<string, ToolUsage>
  // #176：工具上下文事件供跨会话归因
  toolEvents: ToolUsageEvent[]
  totalEvents: UsageEvent[]
  breakdownEvents: UsageEvent[]
}

type UsageGroupAccumulator = UsageGroup & {
  sessionIDs: Set<SessionID>
  providerTotals: Map<string, number>
  modelTotals: Map<string, number>
}

// #174：emptyTokens 为 reduce 起点
const emptyTokens = (): TokenTotals => ({
  input: 0,
  output: 0,
  reasoning: 0,
  cache: { read: 0, write: 0 },
  total: 0,
})

// #174：emptyUsage 为费用次数起点
const emptyUsage = (): UsageTotals => ({
  tokens: emptyTokens(),
  // #176：新增四计量零基与既有字段同源，避免遗漏分计
  components: emptyComponents(),
  cost: 0,
  requests: 0,
  assistantCalls: 0,
  errors: 0,
  aborted: 0,
  durationMs: 0,
})

// #174：tokenTotal 写回 total
const tokenTotal = (tokens: Omit<TokenTotals, "total">) =>
// #174：cache.read 不进 output
// #174：cache.write 不进 output
  tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write

// #174：normalizeTokens 补 total
const normalizeTokens = (tokens: Omit<TokenTotals, "total"> & { total?: number }): TokenTotals => ({
  input: tokens.input,
  output: tokens.output,
  reasoning: tokens.reasoning,
  cache: { read: tokens.cache.read, write: tokens.cache.write },
  total: tokens.total ?? tokenTotal(tokens),
})

// #174：rowTokens 从 SQL 行映射
const rowTokens = (row: {
// #174：tokens_input 单独累计
  tokens_input: number
// #174：tokens_output 单独累计
  tokens_output: number
// #174：tokens_reasoning 单独累计
  tokens_reasoning: number
// #174：tokens_cache_read 分列
  tokens_cache_read: number
// #174：tokens_cache_write 分列
  tokens_cache_write: number
  tokens_total: number
}) =>
  normalizeTokens({
    input: row.tokens_input,
    output: row.tokens_output,
    reasoning: row.tokens_reasoning,
    cache: { read: row.tokens_cache_read, write: row.tokens_cache_write },
    total: row.tokens_total,
  })

// #174：addTokens 就地累加
const addTokens = (target: TokenTotals, value: TokenTotals) => {
  target.input += value.input
  target.output += value.output
  target.reasoning += value.reasoning
  target.cache.read += value.cache.read
  target.cache.write += value.cache.write
  target.total += value.total
}

// #174：addUsage 同步 cost 与次数
const addUsage = (target: UsageTotals, event: UsageTotals | UsageEvent) => {
  addTokens(target.tokens, event.tokens)
  // #176：组件与结局计量随事件同步累加，不事后补算
  addComponents(target.components, event.components)
  target.cost += event.cost
  target.requests += event.requests
  target.assistantCalls += event.assistantCalls
  target.errors += event.errors
  target.aborted += event.aborted
  target.durationMs += event.durationMs
}

// #174：increment 更新 Map 计数
const increment = (map: Map<string, number>, key: string, value: number) => map.set(key, (map.get(key) ?? 0) + value)

// #174：getGroup 懒创建累加器
const getGroup = (map: Map<string, UsageGroupAccumulator>, id: string, label: string) => {
  const existing = map.get(id)
  if (existing) return existing
  const group: UsageGroupAccumulator = {
    id,
    label,
    ...emptyUsage(),
    sessions: 0,
    providers: [],
    models: [],
    sessionIDs: new Set(),
    providerTotals: new Map(),
    modelTotals: new Map(),
  }
  map.set(id, group)
  return group
}

// #174：addGroup 并入事件并更新子合计
const addGroup = (map: Map<string, UsageGroupAccumulator>, id: string, label: string, event: UsageEvent) => {
  const group = getGroup(map, id, label)
  addUsage(group, event)
  group.sessionIDs.add(event.sessionID)
  increment(group.providerTotals, event.providerID, event.tokens.total)
  increment(group.modelTotals, event.modelID, event.tokens.total)
}

// #174：finalizeGroups 定稿分组
const finalizeGroups = (map: Map<string, UsageGroupAccumulator>) =>
  Array.from(map.values())
    .map((group): UsageGroup => ({
      id: group.id,
      label: group.label,
      tokens: group.tokens,
      // #176：分组定稿携带组件归因与请求结局计量
      components: group.components,
      cost: group.cost,
      requests: group.requests,
      assistantCalls: group.assistantCalls,
      errors: group.errors,
      aborted: group.aborted,
      durationMs: group.durationMs,
      sessions: group.sessionIDs.size,
      providers: Array.from(group.providerTotals, ([id, tokens]) => ({ id, tokens })).sort((a, b) => b.tokens - a.tokens),
      models: Array.from(group.modelTotals, ([id, tokens]) => ({ id, tokens })).sort((a, b) => b.tokens - a.tokens),
    }))
    .sort((a, b) => b.cost - a.cost || b.tokens.total - a.tokens.total)

// #174：dayStart 对齐本地日界
const dayStart = (time: number) => {
  const date = new Date(time)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

// #174：dateLabel 供轴标签
const dateLabel = (time: number) =>
  new Date(time).toLocaleDateString(undefined, { month: "short", day: "numeric" })

// #176：稠密日轴：窗口内逐日生成零基桶，保证空闲日连续
const buildDayBuckets = (start: number, end: number) => {
  const startDay = dayStart(start)
  const endDay = dayStart(Math.max(startDay, end))
  return Array.from({ length: Math.floor((endDay - startDay) / MS_IN_DAY) + 1 }, (_, index) => {
    const day = startDay + index * MS_IN_DAY
    return { day, label: dateLabel(day), ...emptyUsage() } satisfies DailyUsage
  })
}

// #174：getDaily 按日懒建
const getDaily = (map: Map<number, DailyUsage>, time: number) => {
  const day = dayStart(time)
  const existing = map.get(day)
  if (existing) return existing
  const usage: DailyUsage = { day, label: dateLabel(day), ...emptyUsage() }
  map.set(day, usage)
  return usage
}

// #174：getSeriesDaily 先 series 再日
const getSeriesDaily = (map: Map<string, Map<number, DailyUsage>>, id: string, time: number) => {
  const byDay = map.get(id) ?? new Map<number, DailyUsage>()
  map.set(id, byDay)
  return getDaily(byDay, time)
}

const emptySeriesTotals = (id: string): UsageSeries => ({
  id,
  label: id,
  points: [],
  ...emptyUsage(),
})

const zeroDaily = (day: DailyUsage): DailyUsage => ({ day: day.day, label: day.label, ...emptyUsage() })

const finalizeSeries = (map: Map<string, Map<number, DailyUsage>>, days: DailyUsage[]) =>
  Array.from(map.entries())
    .map(([id, byDay]) =>
      days
        .map((day) => byDay.get(day.day) ?? zeroDaily(day))
        .reduce((series, point) => {
          addUsage(series, {
            time: point.day,
            sessionID: "" as SessionID,
            projectID: id,
            providerID: id,
            modelID: id,
            source: id,
            agent: id,
            status: id,
            tokens: point.tokens,
            // #176：合成事件携带全部新计量，保持 UsageEvent 契约完整
            components: point.components,
            cost: point.cost,
            requests: point.requests,
            assistantCalls: point.assistantCalls,
            errors: point.errors,
            aborted: point.aborted,
            durationMs: point.durationMs,
          })
          series.points.push(point)
          return series
        }, emptySeriesTotals(id)),
    )
    .sort((a, b) => b.cost - a.cost || b.tokens.total - a.tokens.total)

const tokenPartSeries = (daily: DailyUsage[]): TokenPartSeries[] =>
  [
    {
      id: "input" as const,
      label: "Input",
      pick: (tokens: TokenTotals) => tokens.input,
    },
    {
      id: "output" as const,
      label: "Output + Reasoning",
      pick: (tokens: TokenTotals) => tokens.output + tokens.reasoning,
    },
    {
      id: "cacheRead" as const,
      label: "Cache Read",
      pick: (tokens: TokenTotals) => tokens.cache.read,
    },
    {
      id: "cacheWrite" as const,
      label: "Cache Write",
      pick: (tokens: TokenTotals) => tokens.cache.write,
    },
  ].map((part) => ({
    id: part.id,
    label: part.label,
    points: daily.map((day) => ({ day: day.day, label: day.label, value: part.pick(day.tokens) })),
    total: daily.reduce((acc, day) => acc + part.pick(day.tokens), 0),
  }))

// #174：getAllSessions 必须调用
// #174：必须调用 getAllSessions，经 Database.Service 读表
// #174：必须调用 Effect.fn 枚举会话
// #174：getAllSessions 通过 Database.Service 拉取会话列表
// #180：按 cutoff 下推 SQL，减少全表 session 扫描
const getAllSessions = Effect.fnUntraced(function* () {
  const { db } = yield* Database.Service
  return (yield* db.select().from(SessionTable).all().pipe(Effect.orDie)).map((row) => Session.fromRow(row))
})

// #174：cutoffFromDays 解释 0/缺省/正数
const cutoffFromDays = (days?: number) => {
  if (days === undefined) return 0
// #174：显式 0 天取今日本地零点，不是空窗口
  if (days === 0) {
    const now = new Date()
    now.setHours(0, 0, 0, 0)
    return now.getTime()
  }
  return Date.now() - days * MS_IN_DAY
}

// #174：windowDays 避免除零
const windowDays = (days?: number) => {
  if (days === undefined) return
  if (days === 0) return 1
  return days
}

// #174：includeTime 统一 cutoff
const includeTime = (cutoff: number, time: number) => cutoff === 0 || time >= cutoff

// #176：request 行时长：完成时刻缺失时计 0，不虚构时长
const rowDuration = (row: { time_created: number; time_completed: number | null }) =>
  row.time_completed ? Math.max(0, row.time_completed - row.time_created) : 0

// #176：按请求结局映射 errors/aborted 计数，其他状态不计数
const statusCounts = (status: string, requests: number) => ({
  errors: status === "error" ? requests : 0,
  aborted: status === "aborted" ? requests : 0,
})

// #174：aggregateSession 捕获 NotFound
// #174：aggregateSession 生成只读 StatsReport 快照

// #176：工具上下文事件（按 assistant 时刻归因）
type ToolUsageEvent = {
  time: number
  sessionID: SessionID
  projectID: string
  providerID: string
  modelID: string
  source: string
  agent: string
  status: string
  toolID: string
  contextTokens: number
}

// #176：子串过滤：未设 filter 则全通
// #176：大小写不敏感子串匹配
const textMatches = (value: string | undefined, filter: string | undefined) => {
  if (filter === undefined) return true
  return (value ?? "").toLowerCase().includes(filter.toLowerCase())
}

// #176：会话 id/title/directory 任一命中即可
// #176：session 过滤三字段 OR
const sessionMatches = (session: Session.Info, input: StatsFilter) =>
  input.sessionFilter === undefined ||
  textMatches(session.id, input.sessionFilter) ||
  textMatches(session.title, input.sessionFilter) ||
  textMatches(session.directory, input.sessionFilter)

// #176：用量事件维过滤
// #176：事件维 AND 过滤
const eventMatches = (event: UsageEvent & { source?: string; agent?: string; status?: string }, input: StatsFilter) =>
  textMatches(event.modelID, input.modelFilter) &&
  textMatches(event.providerID, input.providerFilter) &&
  textMatches(event.source, input.sourceFilter) &&
  textMatches(event.agent, input.agentFilter) &&
  textMatches(event.status, input.statusFilter)

// #176：工具事件维过滤
// #176：工具事件维 AND 过滤
const toolEventMatches = (event: ToolUsageEvent, input: StatsFilter) =>
  textMatches(event.toolID, input.toolFilter) &&
  textMatches(event.modelID, input.modelFilter) &&
  textMatches(event.providerID, input.providerFilter) &&
  textMatches(event.source, input.sourceFilter) &&
  textMatches(event.agent, input.agentFilter) &&
  textMatches(event.status, input.statusFilter)

// #176：按 id 取或建工具桶
const getToolUsage = (map: Record<string, ToolUsage>, id: string) => {
  const existing = map[id]
  if (existing) return existing
  // #176：惰性建工具桶，避免预枚举工具名
  const item = { id, count: 0, inputChars: 0, outputChars: 0, contextTokens: 0 }
  map[id] = item
  return item
}

// #176：合并工具计量
const addToolUsage = (map: Record<string, ToolUsage>, usage: ToolUsage) => {
  const item = getToolUsage(map, usage.id)
  item.count += usage.count
  item.inputChars += usage.inputChars
  item.outputChars += usage.outputChars
  item.contextTokens += usage.contextTokens
}

// #176：仅叠加 contextTokens
const addToolContextTokens = (map: Record<string, ToolUsage>, toolID: string, contextTokens: number) => {
  getToolUsage(map, toolID).contextTokens += contextTokens
}

// #176：tip ToolPart 状态机上的输入字符
// #176：pending 用 raw，其余序列化 input
const toolInputChars = (part: { state: { status: string; raw?: string; input?: unknown } }) => {
  if (part.state.status === "pending") return (part.state.raw ?? "").length
  try {
    return JSON.stringify(part.state.input ?? {}).length
  } catch {
    return 0
  }
}

// #176：完成/错误态输出字符（含附件 URL 长度）
// #176：completed 含附件 URL 长度
const toolOutputChars = (part: {
  state: { status: string; output?: string; error?: string; attachments?: { url: string }[] }
}) => {
  if (part.state.status === "completed") {
    return (part.state.output ?? "").length + (part.state.attachments ?? []).reduce((sum, item) => sum + item.url.length, 0)
  }
  if (part.state.status === "error") return (part.state.error ?? "").length
  return 0
}

// #176：截至 time 的各工具 IO 字符（用于上下文归因权重）
// #176：时间截点前工具 IO 权重
const toolCharsByName = (messages: any[], time: number) => {
  const result = new Map<string, { inputChars: number; outputChars: number }>()
  for (const message of messages) {
    if (message.info.time.created > time) continue
    for (const part of message.parts) {
      if (part.type !== "tool" || !part.tool) continue
      const item = result.get(part.tool) ?? { inputChars: 0, outputChars: 0 }
      item.inputChars += toolInputChars(part)
      item.outputChars += toolOutputChars(part)
      result.set(part.tool, item)
    }
  }
  return result
}

// #176：无 inputBreakdown 时，用 assistant tokens 按工具 IO 字符占比归因 contextTokens
// #176：按 IO 占比分摊 assistant tokens

// #176：请求体组件 token 归因桶（与 step-finish.inputBreakdown 对齐）
// #176：与 step-finish.inputBreakdown 字段同构的 token 桶
type InputComponentTotals = {
  system: number
  instructions: number
  skills: number
  toolSchemas: number
  userMessages: number
  assistantText: number
  reasoning: number
  toolCalls: number
  toolResults: number
  attachments: number
}

// #176：零组件桶；导出供渲染层合成事件复用，避免字面量漂移
export const emptyComponents = (): InputComponentTotals => ({
  system: 0,
  instructions: 0,
  skills: 0,
  toolSchemas: 0,
  userMessages: 0,
  assistantText: 0,
  reasoning: 0,
  toolCalls: 0,
  toolResults: 0,
  attachments: 0,
})

// #176：累加组件 token
const addComponents = (target: InputComponentTotals, value: InputComponentTotals) => {
  target.system += value.system
  target.instructions += value.instructions
  target.skills += value.skills
  target.toolSchemas += value.toolSchemas
  target.userMessages += value.userMessages
  target.assistantText += value.assistantText
  target.reasoning += value.reasoning
  target.toolCalls += value.toolCalls
  target.toolResults += value.toolResults
  target.attachments += value.attachments
}

// #176：step-finish 上的 input 侧 token（含 cache）
// #176：step input 含 cache 读写
const stepInputTokens = (part: any) => {
  const tokens = part.tokens ?? emptyTokens()
  return (tokens.input ?? 0) + (tokens.cache?.read ?? 0) + (tokens.cache?.write ?? 0)
}

// #176：从 step-finish.inputBreakdown 按字符占比分摊到组件 token
// #176：按字符占比把 input tokens 分到组件
const componentsFromStep = (part: any): InputComponentTotals => {
  // #176：无 breakdown 时该 step 贡献 0 组件
  if (!part?.inputBreakdown || !part?.inputChars) return emptyComponents()
  const inputTokens = stepInputTokens(part)
  // #176：media tokens 从文本池剥离
  const media = part.inputBreakdown.media
  const attachmentTokens = media?.tokens
  const textTokens = attachmentTokens === undefined ? inputTokens : Math.max(0, inputTokens - attachmentTokens)
  const textChars = media
    ? Math.max(1, part.inputChars - (media.rawChars ?? 0) + (media.textChars ?? 0))
    : part.inputChars
  // #176：字符→token 四舍五入分摊
  const alloc = (chars: number) => Math.round((chars / textChars) * textTokens)
  const bd = part.inputBreakdown
  const messages = bd.messages ?? {}
  return {
    system: alloc(bd.system ?? 0),
    instructions: alloc(bd.instructions ?? 0),
    skills: alloc(bd.skills ?? 0),
    toolSchemas: alloc(bd.tools ?? 0),
    userMessages: alloc(messages.userText ?? 0),
    assistantText: alloc(messages.assistantText ?? 0),
    reasoning: alloc(messages.reasoning ?? 0),
    toolCalls: alloc(messages.toolInput ?? 0),
    toolResults: alloc(messages.toolOutput ?? 0),
    attachments: attachmentTokens ?? alloc(messages.attachments ?? 0),
  }
}

// #176：汇总 assistant 消息内全部 step-finish 组件
// #176：汇总消息内全部 step-finish
const componentsFromAssistant = (message: any | undefined) => {
  const components = emptyComponents()
  for (const part of message?.parts ?? []) {
    if (part.type !== "step-finish") continue
    addComponents(components, componentsFromStep(part))
  }
  return components
}

const toolEventsFromAssistant = (input: {
  // #176：兼容 Session.WithParts，不绑死 tokens 形状
  message: any
  visibleMessages: any[]
  event: {
    time: number
    sessionID: SessionID
    projectID: string
    providerID: string
    modelID: string
    source: string
    agent: string
    status: string
  }
}) => {
    if (!input.message) return [] as ToolUsageEvent[]
  // #176：组件 token 来自 step-finish.inputBreakdown，而非整包 assistant tokens
  // #176：优先 breakdown 组件而非整包 tokens
  const components = componentsFromAssistant(input.message)
  const chars = toolCharsByName(input.visibleMessages, input.message.info.time.created)
  const inputTotal = Array.from(chars.values()).reduce((sum, item) => sum + item.inputChars, 0)
  const outputTotal = Array.from(chars.values()).reduce((sum, item) => sum + item.outputChars, 0)
  return Array.from(chars.entries())
    .map(([toolID, item]) => ({
      time: input.event.time,
      sessionID: input.event.sessionID,
      projectID: input.event.projectID,
      providerID: input.event.providerID,
      modelID: input.event.modelID,
      source: input.event.source,
      agent: input.event.agent,
      status: input.event.status,
      toolID,
      // #176：toolCalls/toolResults 按 IO 字符占比分摊
      contextTokens:
        (inputTotal > 0 ? Math.round(// #176：toolCalls 对应工具输入字符权重
        (components.toolCalls * item.inputChars) / inputTotal) : 0) +
        (outputTotal > 0 ? Math.round(// #176：toolResults 对应工具输出字符权重
        (components.toolResults * item.outputChars) / outputTotal) : 0),
    }))
    .filter((event) => event.contextTokens > 0)
}


// #180：单遍扫描 assistants，避免每条消息重复 toolCharsByName
// #180：批量种子入口，语义同逐条但可扩展单遍优化
const toolEventsFromAssistants = (
  assistants: Array<{ message: any; event: any }>,
  visibleMessages: any[],
) => {
  // #176：批量入口复用归因公式
  const events: ToolUsageEvent[] = []
  for (const item of assistants) {
    events.push(...toolEventsFromAssistant({ message: item.message, visibleMessages, event: item.event }))
  }
  return events
}

const aggregateSession = Effect.fn("Cli.stats.aggregate.session")(function* (session: Session.Info, cutoff: number) {
  const svc = yield* Session.Service
  const legacyMessages = yield* svc
    .messages({ sessionID: session.id })
    .pipe(Effect.catchIf(NotFoundError.isInstance, () => Effect.succeed([])))
  const { db } = yield* Database.Service
  const requestUsageRows = yield* db.select().from(RequestUsageTable).where(eq(RequestUsageTable.session_id, session.id)).all().pipe(Effect.orDie)
  const assistantUsageRows = yield* db.select().from(RequestUsageAssistantTable).where(eq(RequestUsageAssistantTable.session_id, session.id)).all().pipe(Effect.orDie)
  const legacyIDs = new Set(legacyMessages.map((message) => String(message.info.id)))
  const projected = yield* db.select().from(SessionMessageTable).where(eq(SessionMessageTable.session_id, session.id)).all().pipe(Effect.orDie)
  // 两种历史共享账本，但原生工具只在 session_message；同 ID 的迁移投影不能重复计数。
  const nativeMessages = projected.filter((row) => !legacyIDs.has(row.id) && (row.type === "assistant" || row.type === "user") && includeTime(cutoff, row.time_created)).map((row) => {
    const message = Schema.decodeUnknownSync(SessionMessage.Message)({ ...row.data, id: row.id, type: row.type })
    const assistant = message.type === "assistant" ? message : undefined
    const estimate = assistant?.inputEstimate
    return {
      info: {
        id: MessageID.make(row.id), role: assistant ? "assistant" as const : "user" as const,
        time: { created: row.time_created }, tokens: assistant?.tokens ?? emptyTokens(), cost: assistant?.cost ?? 0,
        // 精确账本关联用于既有去重；无记录时不猜测相邻请求或模型。
        parentID: assistantUsageRows.find((usage) => usage.assistant_message_id === MessageID.make(row.id))?.request_id,
        modelID: assistant?.model.id, providerID: assistant?.model.providerID,
      },
      parts: [
        ...(assistant?.content ?? []).flatMap((part) => part.type !== "tool" ? [] : [{
          type: "tool" as const, tool: part.name, state: {
            status: part.state.status, input: part.state.input,
            raw: typeof part.state.input === "string" ? part.state.input : undefined,
            output: part.state.status === "completed" ? part.state.content.filter((item) => item.type === "text").map((item) => item.text).join("\n") : undefined,
            error: part.state.status === "error" ? part.state.error.message : undefined,
            attachments: part.state.status === "completed" ? part.state.content.flatMap((item) => item.type === "file" ? [{ url: item.uri }] : []) : [],
          },
        }]),
        ...(estimate?.confirmed ? [{ type: "step-finish" as const, tokens: assistant?.tokens, inputChars: estimate.bodyChars, inputBreakdown: estimate.inputBreakdown }] : []),
      ],
    }
  })
  const visibleMessages = [...legacyMessages, ...nativeMessages].filter((message) => includeTime(cutoff, message.info.time.created))
  const totalEvents: UsageEvent[] = []
  const breakdownEvents: UsageEvent[] = []

  if (requestUsageRows.length > 0) {
// #174：time_created 过滤 usage
    const requestRows = requestUsageRows.filter((row) => includeTime(cutoff, row.time_created))
    const assistantRows = assistantUsageRows.filter((row) => includeTime(cutoff, row.time_created))

    if (assistantRows.length > 0) {
// #174：request_id 用于跳过双计
      const assistantRequests = new Set(assistantRows.map((row) => row.request_id))
      // #176：构造时精确 join：request_id 直接取 request 维，不做时间/模型猜测
      const requestsByID = new Map(requestRows.map((row) => [row.request_id, row]))
      const messagesByID = new Map(visibleMessages.map((message) => [message.info.id, message]))
      const assistantEvents = assistantRows.map((row) => {
        const request = requestsByID.get(row.request_id)
        return {
        time: row.time_created,
        sessionID: session.id,
// #174：provider_id 标识供应
        providerID: row.provider_id,
// #174：model_id 标识模型
        modelID: row.model_id,
        tokens: rowTokens(row),
// #174：cost_micros 显示前换算
        cost: row.cost_micros / MICROS,
        requests: 0,
        assistantCalls: 1,
        // #176：assistant 事件结局取自身 status，source/agent 取精确 join 的 request
        source: request?.source ?? "assistant",
        agent: request?.agent ?? session.agent ?? "unknown",
        status: row.status,
        components: componentsFromAssistant(messagesByID.get(row.assistant_message_id)),
        errors: 0,
        aborted: 0,
        durationMs: 0,
        }
      })
      const fallbackRequestEvents = requestRows
        .filter((row) => !assistantRequests.has(row.request_id))
        .map((row) => ({
          time: row.time_created,
          sessionID: session.id,
          providerID: row.provider_id,
          modelID: row.model_id,
          tokens: rowTokens(row),
          cost: row.cost_micros / MICROS,
          requests: 1,
          assistantCalls: row.assistant_count || 1,
          // #176：request 派生事件直接携带行内归因与结局计量
          source: row.source,
          agent: row.agent || session.agent || "unknown",
          status: row.status,
          components: emptyComponents(),
          ...statusCounts(row.status, 1),
          durationMs: rowDuration(row),
        }))
      totalEvents.push(...assistantEvents)
      totalEvents.push(...fallbackRequestEvents)
      totalEvents.push(
        ...requestRows.filter((row) => assistantRequests.has(row.request_id)).map((row) => ({
          time: row.time_created,
          sessionID: session.id,
          providerID: row.provider_id,
          modelID: row.model_id,
          tokens: emptyTokens(),
          cost: 0,
          requests: 1,
          assistantCalls: 0,
          // #176：双计抑制行只计请求侧计量，token/cost 已由 assistant 行承担
          source: row.source,
          agent: row.agent || session.agent || "unknown",
          status: row.status,
          components: emptyComponents(),
          ...statusCounts(row.status, 1),
          durationMs: rowDuration(row),
        })),
      )
      breakdownEvents.push(...assistantEvents)
      breakdownEvents.push(...fallbackRequestEvents)
    } else {
      const requestEvents = requestRows.map((row) => ({
        time: row.time_created,
        sessionID: session.id,
        providerID: row.provider_id,
        modelID: row.model_id,
        tokens: rowTokens(row),
        cost: row.cost_micros / MICROS,
        requests: 1,
        assistantCalls: row.assistant_count || 1,
        // #176：无 assistant 行时全部计量来自 request 行本身
        source: row.source,
        agent: row.agent || session.agent || "unknown",
        status: row.status,
        components: emptyComponents(),
        ...statusCounts(row.status, 1),
        durationMs: rowDuration(row),
      }))
      totalEvents.push(...requestEvents)
      breakdownEvents.push(...requestEvents)
    }
  }
  // #174：助手 ID 去重后补历史消息，新请求账本不能遮蔽旧模型。
  const tracked = new Set(assistantUsageRows.map((row) => row.assistant_message_id))
  // #174：缺明细的已确认请求由汇总行计量；零用量 noReply 不覆盖历史消息。
  const fallbackRequests = new Set(
    requestUsageRows
      .filter((row) => row.assistant_count > 0 || row.tokens_total > 0 || row.cost_micros > 0)
      .map((row) => row.request_id),
  )
  assistantUsageRows.forEach((row) => fallbackRequests.delete(row.request_id))
  for (const message of visibleMessages) {
    if (message.info.role !== "assistant") continue
    if (tracked.has(message.info.id) || (message.info.parentID && fallbackRequests.has(message.info.parentID))) continue
    const tokens = normalizeTokens(message.info.tokens ?? emptyTokens())
    const event = {
      time: message.info.time.created,
      sessionID: session.id,
      providerID: (message.info as { providerID?: string }).providerID ?? "unknown",
      modelID: (message.info as { modelID?: string }).modelID ?? "unknown",
      tokens,
      cost: message.info.cost ?? 0,
      requests: 0,
      assistantCalls: 1,
      // #176：补入的历史助手没有账本明细，组件取消息实况、请求结局计量保持零基。
      components: componentsFromAssistant(message),
      errors: 0,
      aborted: 0,
      durationMs: 0,
    }
    totalEvents.push(event)
    breakdownEvents.push(event)
  }

  // #176：富工具桶 + 上下文事件
  const toolUsage: Record<string, ToolUsage> = {}
  const toolEvents: ToolUsageEvent[] = []

  for (const message of visibleMessages) {
    for (const part of message.parts) {
      if (part.type !== "tool" || !part.tool) continue
      const item = getToolUsage(toolUsage, part.tool)
      // Called/Progress/Success 覆盖同一 parts 项，统一扫描只计一次调用。
      item.count++
      item.inputChars += toolInputChars(part)
      item.outputChars += toolOutputChars(part)
    }
  }

  // #180：批量收集 assistant 种子后单遍生成工具上下文事件
  if (requestUsageRows.length > 0) {
    const requestRows = requestUsageRows.filter((row) => includeTime(cutoff, row.time_created))
    const assistantRows = assistantUsageRows.filter((row) => includeTime(cutoff, row.time_created))
    const requestsByID = new Map(requestRows.map((row) => [row.request_id, row]))
    // #180：assistant_message_id → 消息映射，种子在此复用避免二次扫描
    const messagesByID = new Map(visibleMessages.map((message) => [message.info.id, message]))
        // #180：先收集 assistant 种子再统一生成事件
    const seeds = assistantRows.map((row) => {
      const request = requestsByID.get(row.request_id)
      return {
        message: messagesByID.get(row.assistant_message_id),
        event: {
          time: row.time_created,
          sessionID: session.id,
          projectID: session.projectID,
          providerID: row.provider_id,
          modelID: row.model_id,
          source: request?.source ?? "assistant",
          agent: request?.agent ?? session.agent ?? "unknown",
          status: row.status,
        },
      }
    })
        // #180：单点推入，避免循环内重复展开逻辑
    toolEvents.push(...toolEventsFromAssistants(seeds, visibleMessages))
  }
  // #176：工具上下文沿用同一助手覆盖集合，混合历史只补未入账消息。
  const seeds = visibleMessages
    .filter((message) => message.info.role === "assistant" && !tracked.has(message.info.id) && !(message.info.parentID && fallbackRequests.has(message.info.parentID)))
    .map((message) => ({
      message,
      event: {
        time: message.info.time.created,
        sessionID: session.id,
        projectID: session.projectID,
        providerID: (message.info as { providerID?: string }).providerID ?? "unknown",
        modelID: (message.info as { modelID?: string }).modelID ?? "unknown",
        source: "legacy-message",
        agent: session.agent ?? "unknown",
        status: "completed",
      },
    }))
  toolEvents.push(...toolEventsFromAssistants(seeds, visibleMessages))

  // #176：request 维已在构造时精确 join，此处只补 project 维与缺失默认值
  for (const event of [...totalEvents, ...breakdownEvents]) {
    event.projectID = session.projectID
    event.source = event.source ?? "legacy-message"
    event.agent = event.agent ?? session.agent ?? "unknown"
    event.status = event.status ?? "completed"
  }

  return { session, messageCount: visibleMessages.length, toolUsage, toolEvents, totalEvents, breakdownEvents } satisfies SessionAggregate
})

// #174：aggregateStats 唯一写路径
// #174：唯一写 StatsReport 的路径
// #174：aggregateStats 生成只读 StatsReport 快照
export const aggregateStats = Effect.fn("Cli.stats.aggregate")(function* (input: StatsFilter = {}) {
  const cutoff = cutoffFromDays(input.days)
  const sessions =   // #180：聚合入口改用 SQL 预过滤会话
  yield* getAllSessions()
  const filteredSessions = sessions
// #174：time.updated 过滤会话
    .filter((session) => includeTime(cutoff, session.time.updated))
    .filter((session) => {
      if (input.projectFilter === undefined) return true
// #174：空串 projectFilter 绑定当前 project.id
// #174：空串过滤绑定当前 project.id
      if (input.projectFilter === "") return session.projectID === input.currentProject?.id
      return session.projectID === input.projectFilter
    })
    // #176：会话子串过滤
    // #176：在项目过滤之后应用 session 子串
    .filter((session) => sessionMatches(session, input))

  if (filteredSessions.length > 1000) {
    process.stderr.write(`Large dataset detected (${filteredSessions.length} sessions). This may take a while...\n`)
  }

// #174：aggregates 写聚合快照，页面不得再 select
// #174：aggregates 生成只读 StatsReport 快照
  const aggregates = yield* Effect.forEach(filteredSessions, (session) => aggregateSession(session, cutoff), {
// #174：concurrency 保护 SQLite
// #174：并发明细设上限，降低 SQLite 争用
// #174：并发明细设上限保护 SQLite
    concurrency: 20,
  })

  const total = emptyUsage()
  const daily = new Map<number, DailyUsage>()
  const modelSeries = new Map<string, Map<number, DailyUsage>>()
  const providerSeries = new Map<string, Map<number, DailyUsage>>()
  const models = new Map<string, UsageGroupAccumulator>()
  const providers = new Map<string, UsageGroupAccumulator>()
  const toolUsage: Record<string, ToolUsage> = {}
  const agents = new Map<string, UsageGroupAccumulator>()
  const sources = new Map<string, UsageGroupAccumulator>()
  const statuses = new Map<string, UsageGroupAccumulator>()
  const projects = new Map<string, UsageGroupAccumulator>()
  const agentSeries = new Map<string, Map<number, DailyUsage>>()
  const sourceSeries = new Map<string, Map<number, DailyUsage>>()
  const statusSeries = new Map<string, Map<number, DailyUsage>>()
  const projectSeries = new Map<string, Map<number, DailyUsage>>()
  const modelProviderTokens = new Map<string, number>()
  const sessionsWithUsage: SessionUsage[] = []
  const sessionTokenTotals: number[] = []
  let totalMessages = 0
  let totalTools = 0

  // #176：toolFilter 时仅保留含匹配工具的会话聚合
  // #176：tool 过滤在会话级裁剪，避免空工具会话进榜
const filteredAggregates =
    input.toolFilter === undefined
      ? aggregates
      : aggregates.filter((aggregate) =>
          // #176：会话含匹配工具才保留
          Object.values(aggregate.toolUsage).some((tool) => textMatches(tool.id, input.toolFilter)),
        )

  for (const aggregate of filteredAggregates) {
    const matchingTools = Object.values(aggregate.toolUsage).filter((tool) => textMatches(tool.id, input.toolFilter))
    const sessionUsage: SessionUsage = {
      id: aggregate.session.id,
      title: aggregate.session.title,
      projectID: aggregate.session.projectID,
      directory: aggregate.session.directory,
      created: aggregate.session.time.created,
      updated: aggregate.session.time.updated,
      messages: aggregate.messageCount,
      tools: matchingTools.reduce((acc, tool) => acc + tool.count, 0),
      providers: [],
      models: [],
      ...emptyUsage(),
    }
    const sessionProviders = new Set<string>()
    const sessionModels = new Set<string>()

    totalMessages += aggregate.messageCount
    totalTools += sessionUsage.tools
    // #176：先累加 IO/count，context 由事件叠加
    matchingTools.forEach((tool) => addToolUsage(toolUsage, { ...tool, contextTokens: 0 }))
    // #176：上下文 token 由 toolEvents 叠加，避免与 count 双计字符
    aggregate.toolEvents
      .filter((event) => toolEventMatches(event, input))
      .forEach((event) => addToolContextTokens(toolUsage, event.toolID, event.contextTokens))

    for (const event of aggregate.totalEvents.filter((event) => eventMatches(event, input))) {
      addUsage(sessionUsage, event)
      addUsage(getDaily(daily, event.time), event)
    }
    // 未筛选日期时沿用持久 Session 全历史累计，部分 request 账本只负责明细与次数。
    if (cutoff === 0 && ![input.modelFilter, input.providerFilter, input.sourceFilter, input.agentFilter, input.statusFilter, input.toolFilter].some(value => value !== undefined)) {
      sessionUsage.tokens = normalizeTokens(aggregate.session.tokens ?? emptyTokens())
      sessionUsage.cost = aggregate.session.cost ?? 0
    }
    addUsage(total, sessionUsage)

    for (const event of aggregate.breakdownEvents.filter((event) => eventMatches(event, input))) {
      addGroup(models, event.modelID, event.modelID, event)
      addGroup(providers, event.providerID, event.providerID, event)
      // #176：agent 维分组
      addGroup(agents, event.agent ?? "unknown", event.agent ?? "unknown", event)
      // #176：source 维分组
      addGroup(sources, event.source ?? "unknown", event.source ?? "unknown", event)
      // #176：status 维分组
      addGroup(statuses, event.status ?? "unknown", event.status ?? "unknown", event)
      // #176：project 维分组
      addGroup(projects, event.projectID ?? aggregate.session.projectID, event.projectID ?? aggregate.session.projectID, event)
      addUsage(getSeriesDaily(modelSeries, event.modelID, event.time), event)
      addUsage(getSeriesDaily(providerSeries, event.providerID, event.time), event)
      addUsage(getSeriesDaily(agentSeries, event.agent ?? "unknown", event.time), event)
      addUsage(getSeriesDaily(sourceSeries, event.source ?? "unknown", event.time), event)
      addUsage(getSeriesDaily(statusSeries, event.status ?? "unknown", event.time), event)
      addUsage(getSeriesDaily(projectSeries, event.projectID ?? aggregate.session.projectID, event.time), event)
      // #176：provider\0model 复合键累加 tokens
      increment(modelProviderTokens, `${event.providerID}\0${event.modelID}`, event.tokens.total)
      sessionProviders.add(event.providerID)
      sessionModels.add(event.modelID)
    }

    if (sessionUsage.tokens.total > 0 || sessionUsage.cost > 0) {
      sessionUsage.providers = Array.from(sessionProviders).sort()
      sessionUsage.models = Array.from(sessionModels).sort()
      sessionsWithUsage.push(sessionUsage)
      sessionTokenTotals.push(sessionUsage.tokens.total)
    }
  }

  const sortedDaily = Array.from(daily.values()).sort((a, b) => a.day - b.day)
  const fallbackEarliest = filteredSessions.reduce(
    (earliest, session) => Math.min(earliest, cutoff > 0 ? session.time.updated : session.time.created),
    Date.now(),
  )
  const fallbackLatest = filteredSessions.reduce((latest, session) => Math.max(latest, session.time.updated), 0)
  // #176：稠密日轴锚定今天；无显式窗口时以数据首末日为界
  const requestedWindow = windowDays(input.days)
  const latest = requestedWindow ? dayStart(Date.now()) : dayStart((sortedDaily.at(-1)?.day ?? fallbackLatest) || fallbackEarliest)
  const earliest = requestedWindow
    ? latest - (requestedWindow - 1) * MS_IN_DAY
    : dayStart(sortedDaily.at(0)?.day ?? fallbackEarliest)
  const completeDaily = buildDayBuckets(earliest, latest).map((day) => daily.get(day.day) ?? day)
  const effectiveDays = completeDaily.length
  const sortedSessionTotals = sessionTokenTotals.sort((a, b) => a - b)
  const mid = Math.floor(sortedSessionTotals.length / 2)
  const medianTokensPerSession =
    sortedSessionTotals.length === 0
      ? 0
      : sortedSessionTotals.length % 2 === 0
        ? (sortedSessionTotals[mid - 1] + sortedSessionTotals[mid]) / 2
        : sortedSessionTotals[mid]

  return {
    // #176：会话计数以过滤后聚合为准
    // #176：totalSessions 与过滤后集合一致
    totalSessions: filteredAggregates.length,
    sessionsWithUsage: sessionsWithUsage.length,
    totalMessages,
    totalTools,
    days: effectiveDays,
    requestedDays: input.days,
    dateRange: { earliest, latest },
    total,
    models: finalizeGroups(models),
    providers: finalizeGroups(providers),
    // #176：agent/source/status/project 维与 model 同构
    agents: finalizeGroups(agents),
    sources: finalizeGroups(sources),
    statuses: finalizeGroups(statuses),
    projects: finalizeGroups(projects),
    daily: completeDaily,
    modelSeries: finalizeSeries(modelSeries, completeDaily),
    providerSeries: finalizeSeries(providerSeries, completeDaily),
    agentSeries: finalizeSeries(agentSeries, completeDaily),
    sourceSeries: finalizeSeries(sourceSeries, completeDaily),
    statusSeries: finalizeSeries(statusSeries, completeDaily),
    projectSeries: finalizeSeries(projectSeries, completeDaily),
    tokenPartSeries: tokenPartSeries(completeDaily),
    sessions: sessionsWithUsage.sort((a, b) => b.cost - a.cost || b.tokens.total - a.tokens.total),
    // #176：默认按 contextTokens 再按 count
    // #176：工具榜优先 contextTokens 体现归因
    toolUsage: Object.values(toolUsage).sort((a, b) => b.contextTokens - a.contextTokens || b.count - a.count),
    // #176：模型×供应矩阵供热图/对比
    modelProviderTokens: Array.from(modelProviderTokens, ([key, tokens]) => {
      const [providerID, modelID] = key.split("\0")
      return { providerID, modelID, tokens }
    }),
    tokensPerSession: sessionsWithUsage.length > 0 ? total.tokens.total / sessionsWithUsage.length : 0,
    medianTokensPerSession,
  } satisfies StatsReport
})
