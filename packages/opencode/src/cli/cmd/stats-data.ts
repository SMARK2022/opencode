import { Effect, Schema } from "effect"
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
  cost: number
// #174：requests 字段只累加次数，不带费用
  requests: number
// #174：assistantCalls 与 requests 分列，避免混口径
// #174：assistant 行优先 cost/model 防双计
  assistantCalls: number
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
  toolUsage: { id: string; count: number }[]
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
}

type SessionAggregate = {
  session: Session.Info
  messageCount: number
  toolUsage: Record<string, number>
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
  cost: 0,
  requests: 0,
  assistantCalls: 0,
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
  target.cost += event.cost
  target.requests += event.requests
  target.assistantCalls += event.assistantCalls
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
      cost: group.cost,
      requests: group.requests,
      assistantCalls: group.assistantCalls,
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
            providerID: id,
            modelID: id,
            tokens: point.tokens,
            cost: point.cost,
            requests: point.requests,
            assistantCalls: point.assistantCalls,
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
const getAllSessions = Effect.fnUntraced(function* () {
// #174：Effect 取 db 的口径在邻码固定，禁止旁路改写
// #174：经 Service 取 db，失败 orDie
  const { db } = yield* Database.Service
// #174：失败显式 的口径在邻码固定，禁止旁路改写
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

// #174：aggregateSession 捕获 NotFound
// #174：aggregateSession 生成只读 StatsReport 快照
const aggregateSession = Effect.fn("Cli.stats.aggregate.session")(function* (session: Session.Info, cutoff: number) {
  const svc = yield* Session.Service
  const messages = yield* svc
    .messages({ sessionID: session.id })
    .pipe(Effect.catchIf(NotFoundError.isInstance, () => Effect.succeed([])))
  const visibleMessages = messages.filter((message) => includeTime(cutoff, message.info.time.created))
  const { db } = yield* Database.Service
  const requestUsageRows = yield* db.select().from(RequestUsageTable).where(eq(RequestUsageTable.session_id, session.id)).all().pipe(Effect.orDie)
  const assistantUsageRows = yield* db.select().from(RequestUsageAssistantTable).where(eq(RequestUsageAssistantTable.session_id, session.id)).all().pipe(Effect.orDie)
  // 原生消息与 V1 分表投影；同 ID 的迁移副本只计一次，日期仍按消息创建时间。
  const legacyIDs = new Set(messages.map(message => String(message.info.id)))
  const projected = yield* db.select().from(SessionMessageTable).where(eq(SessionMessageTable.session_id, session.id)).all().pipe(Effect.orDie)
  const nativeMessages = projected
    .filter(row => !legacyIDs.has(row.id) && (row.type === "assistant" || row.type === "user") && includeTime(cutoff, row.time_created))
    .map(row => Schema.decodeUnknownSync(SessionMessage.Message)({ ...row.data, id: row.id, type: row.type }))
  const totalEvents: UsageEvent[] = []
  const breakdownEvents: UsageEvent[] = []

  if (requestUsageRows.length > 0) {
// #174：time_created 过滤 usage
    const requestRows = requestUsageRows.filter((row) => includeTime(cutoff, row.time_created))
    const assistantRows = assistantUsageRows.filter((row) => includeTime(cutoff, row.time_created))

    if (assistantRows.length > 0) {
// #174：request_id 用于跳过双计
      const assistantRequests = new Set(assistantRows.map((row) => row.request_id))
      const assistantEvents = assistantRows.map((row) => ({
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
      }))
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
    if (tracked.has(message.info.id) || fallbackRequests.has(message.info.parentID)) continue
    const tokens = normalizeTokens(message.info.tokens ?? emptyTokens())
    const event = {
      time: message.info.time.created,
      sessionID: session.id,
      providerID: message.info.providerID,
      modelID: message.info.modelID,
      tokens,
      cost: message.info.cost ?? 0,
      requests: 0,
      assistantCalls: 1,
    }
    totalEvents.push(event)
    breakdownEvents.push(event)
  }

  const toolUsage: Record<string, number> = {}
  for (const message of visibleMessages) {
    for (const part of message.parts) {
      if (part.type !== "tool" || !part.tool) continue
      toolUsage[part.tool] = (toolUsage[part.tool] ?? 0) + 1
    }
  }

  // Tool 的 Called/Progress/Success 更新同一投影项，不能把状态更新重复算作工具调用。
  for (const message of nativeMessages) {
    if (message.type !== "assistant") continue
    for (const part of message.content) {
      if (part.type !== "tool" || !part.name) continue
      toolUsage[part.name] = (toolUsage[part.name] ?? 0) + 1
    }
  }
  return { session, messageCount: visibleMessages.length + nativeMessages.length, toolUsage, totalEvents, breakdownEvents } satisfies SessionAggregate
})

// #174：aggregateStats 唯一写路径
// #174：唯一写 StatsReport 的路径
// #174：aggregateStats 生成只读 StatsReport 快照
export const aggregateStats = Effect.fn("Cli.stats.aggregate")(function* (input: StatsFilter = {}) {
  const cutoff = cutoffFromDays(input.days)
  const sessions = yield* getAllSessions()
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
  const toolUsage: Record<string, number> = {}
  const sessionsWithUsage: SessionUsage[] = []
  const sessionTokenTotals: number[] = []
  let totalMessages = 0
  let totalTools = 0

  for (const aggregate of aggregates) {
    const sessionUsage: SessionUsage = {
      id: aggregate.session.id,
      title: aggregate.session.title,
      projectID: aggregate.session.projectID,
      directory: aggregate.session.directory,
      created: aggregate.session.time.created,
      updated: aggregate.session.time.updated,
      messages: aggregate.messageCount,
      tools: Object.values(aggregate.toolUsage).reduce((acc, count) => acc + count, 0),
      providers: [],
      models: [],
      ...emptyUsage(),
    }
    const sessionProviders = new Set<string>()
    const sessionModels = new Set<string>()

    totalMessages += aggregate.messageCount
    totalTools += sessionUsage.tools
    for (const [tool, count] of Object.entries(aggregate.toolUsage)) {
      toolUsage[tool] = (toolUsage[tool] ?? 0) + count
    }

    for (const event of aggregate.totalEvents) {
      addUsage(sessionUsage, event)
      addUsage(getDaily(daily, event.time), event)
    }
    // 未筛选日期时沿用持久 Session 全历史累计，部分 request 账本只负责明细与次数。
    if (cutoff === 0) {
      sessionUsage.tokens = normalizeTokens(aggregate.session.tokens ?? emptyTokens())
      sessionUsage.cost = aggregate.session.cost ?? 0
    }
    addUsage(total, sessionUsage)

    for (const event of aggregate.breakdownEvents) {
      addGroup(models, event.modelID, event.modelID, event)
      addGroup(providers, event.providerID, event.providerID, event)
      addUsage(getSeriesDaily(modelSeries, event.modelID, event.time), event)
      addUsage(getSeriesDaily(providerSeries, event.providerID, event.time), event)
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
  const earliest = sortedDaily.at(0)?.day ?? fallbackEarliest
  const latest = sortedDaily.at(-1)?.day ?? fallbackLatest
  const effectiveDays = windowDays(input.days) ?? Math.max(1, Math.ceil((latest - earliest) / MS_IN_DAY) + 1)
  const sortedSessionTotals = sessionTokenTotals.sort((a, b) => a - b)
  const mid = Math.floor(sortedSessionTotals.length / 2)
  const medianTokensPerSession =
    sortedSessionTotals.length === 0
      ? 0
      : sortedSessionTotals.length % 2 === 0
        ? (sortedSessionTotals[mid - 1] + sortedSessionTotals[mid]) / 2
        : sortedSessionTotals[mid]

  return {
    totalSessions: filteredSessions.length,
    sessionsWithUsage: sessionsWithUsage.length,
    totalMessages,
    totalTools,
    days: effectiveDays,
    requestedDays: input.days,
    dateRange: { earliest, latest },
    total,
    models: finalizeGroups(models),
    providers: finalizeGroups(providers),
    daily: sortedDaily,
    modelSeries: finalizeSeries(modelSeries, sortedDaily),
    providerSeries: finalizeSeries(providerSeries, sortedDaily),
    tokenPartSeries: tokenPartSeries(sortedDaily),
    sessions: sessionsWithUsage.sort((a, b) => b.cost - a.cost || b.tokens.total - a.tokens.total),
    toolUsage: Object.entries(toolUsage)
      .map(([id, count]) => ({ id, count }))
      .sort((a, b) => b.count - a.count),
    tokensPerSession: sessionsWithUsage.length > 0 ? total.tokens.total / sessionsWithUsage.length : 0,
    medianTokensPerSession,
  } satisfies StatsReport
})
