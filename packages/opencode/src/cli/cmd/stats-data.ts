import { Effect } from "effect"
import { Session } from "@/session/session"
import { RequestUsageAssistantTable, RequestUsageTable } from "@/session/request-usage.sql"
import { NotFoundError } from "@/storage/storage"
import { Database, eq } from "@/storage/db"
import { SessionTable } from "@/session/session.sql"
import type { Project } from "@/project/project"
import type { SessionID } from "@/session/schema"

const MICROS = 1_000_000
const MS_IN_DAY = 24 * 60 * 60 * 1000

export type TokenTotals = {
  input: number
  output: number
  reasoning: number
  cache: { read: number; write: number }
  total: number
}

export type UsageTotals = {
  tokens: TokenTotals
  cost: number
  requests: number
  assistantCalls: number
}

export type UsageGroup = UsageTotals & {
  id: string
  label: string
  sessions: number
  providers: { id: string; tokens: number }[]
  models: { id: string; tokens: number }[]
}

export type DailyUsage = UsageTotals & {
  day: number
  label: string
}

export type UsageSeries = UsageTotals & {
  id: string
  label: string
  points: DailyUsage[]
}

export type TokenPartSeries = {
  id: "input" | "output" | "cacheRead" | "cacheWrite"
  label: string
  points: { day: number; label: string; value: number }[]
  total: number
}

export type SessionUsage = UsageTotals & {
  id: SessionID
  title: string
  projectID: string
  directory: string
  created: number
  updated: number
  messages: number
  tools: number
  providers: string[]
  models: string[]
}

export type StatsReport = {
  totalSessions: number
  sessionsWithUsage: number
  totalMessages: number
  totalTools: number
  days: number
  requestedDays?: number
  dateRange: { earliest: number; latest: number }
  total: UsageTotals
  models: UsageGroup[]
  providers: UsageGroup[]
  daily: DailyUsage[]
  modelSeries: UsageSeries[]
  providerSeries: UsageSeries[]
  tokenPartSeries: TokenPartSeries[]
  sessions: SessionUsage[]
  toolUsage: { id: string; count: number }[]
  tokensPerSession: number
  medianTokensPerSession: number
}

export type StatsFilter = {
  days?: number
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

const emptyTokens = (): TokenTotals => ({
  input: 0,
  output: 0,
  reasoning: 0,
  cache: { read: 0, write: 0 },
  total: 0,
})

const emptyUsage = (): UsageTotals => ({
  tokens: emptyTokens(),
  cost: 0,
  requests: 0,
  assistantCalls: 0,
})

const tokenTotal = (tokens: Omit<TokenTotals, "total">) =>
  tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write

const normalizeTokens = (tokens: Omit<TokenTotals, "total"> & { total?: number }): TokenTotals => ({
  input: tokens.input,
  output: tokens.output,
  reasoning: tokens.reasoning,
  cache: { read: tokens.cache.read, write: tokens.cache.write },
  total: tokens.total ?? tokenTotal(tokens),
})

const rowTokens = (row: {
  tokens_input: number
  tokens_output: number
  tokens_reasoning: number
  tokens_cache_read: number
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

const addTokens = (target: TokenTotals, value: TokenTotals) => {
  target.input += value.input
  target.output += value.output
  target.reasoning += value.reasoning
  target.cache.read += value.cache.read
  target.cache.write += value.cache.write
  target.total += value.total
}

const addUsage = (target: UsageTotals, event: UsageEvent) => {
  addTokens(target.tokens, event.tokens)
  target.cost += event.cost
  target.requests += event.requests
  target.assistantCalls += event.assistantCalls
}

const increment = (map: Map<string, number>, key: string, value: number) => map.set(key, (map.get(key) ?? 0) + value)

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

const addGroup = (map: Map<string, UsageGroupAccumulator>, id: string, label: string, event: UsageEvent) => {
  const group = getGroup(map, id, label)
  addUsage(group, event)
  group.sessionIDs.add(event.sessionID)
  increment(group.providerTotals, event.providerID, event.tokens.total)
  increment(group.modelTotals, event.modelID, event.tokens.total)
}

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

const dayStart = (time: number) => {
  const date = new Date(time)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

const dateLabel = (time: number) =>
  new Date(time).toLocaleDateString(undefined, { month: "short", day: "numeric" })

const getDaily = (map: Map<number, DailyUsage>, time: number) => {
  const day = dayStart(time)
  const existing = map.get(day)
  if (existing) return existing
  const usage: DailyUsage = { day, label: dateLabel(day), ...emptyUsage() }
  map.set(day, usage)
  return usage
}

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

const getAllSessions = Effect.sync(() =>
  Database.use((db) => db.select().from(SessionTable).all()).map((row) => Session.fromRow(row)),
)

const cutoffFromDays = (days?: number) => {
  if (days === undefined) return 0
  if (days === 0) {
    const now = new Date()
    now.setHours(0, 0, 0, 0)
    return now.getTime()
  }
  return Date.now() - days * MS_IN_DAY
}

const windowDays = (days?: number) => {
  if (days === undefined) return
  if (days === 0) return 1
  return days
}

const includeTime = (cutoff: number, time: number) => cutoff === 0 || time >= cutoff

const aggregateSession = Effect.fn("Cli.stats.aggregate.session")(function* (session: Session.Info, cutoff: number) {
  const svc = yield* Session.Service
  const messages = yield* svc
    .messages({ sessionID: session.id })
    .pipe(Effect.catchIf(NotFoundError.isInstance, () => Effect.succeed([])))
  const visibleMessages = messages.filter((message) => includeTime(cutoff, message.info.time.created))
  const requestUsageRows = Database.use((db) =>
    db.select().from(RequestUsageTable).where(eq(RequestUsageTable.session_id, session.id)).all(),
  )
  const assistantUsageRows = Database.use((db) =>
    db.select().from(RequestUsageAssistantTable).where(eq(RequestUsageAssistantTable.session_id, session.id)).all(),
  )
  const totalEvents: UsageEvent[] = []
  const breakdownEvents: UsageEvent[] = []

  if (requestUsageRows.length > 0) {
    const requestRows = requestUsageRows.filter((row) => includeTime(cutoff, row.time_created))
    const assistantRows = assistantUsageRows.filter((row) => includeTime(cutoff, row.time_created))

    if (assistantRows.length > 0) {
      const assistantRequests = new Set(assistantRows.map((row) => row.request_id))
      const assistantEvents = assistantRows.map((row) => ({
        time: row.time_created,
        sessionID: session.id,
        providerID: row.provider_id,
        modelID: row.model_id,
        tokens: rowTokens(row),
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
  } else {
    for (const message of visibleMessages) {
      if (message.info.role !== "assistant") continue
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
  }

  const toolUsage: Record<string, number> = {}
  for (const message of visibleMessages) {
    for (const part of message.parts) {
      if (part.type !== "tool" || !part.tool) continue
      toolUsage[part.tool] = (toolUsage[part.tool] ?? 0) + 1
    }
  }

  return { session, messageCount: visibleMessages.length, toolUsage, totalEvents, breakdownEvents } satisfies SessionAggregate
})

export const aggregateStats = Effect.fn("Cli.stats.aggregate")(function* (input: StatsFilter = {}) {
  const cutoff = cutoffFromDays(input.days)
  const sessions = yield* getAllSessions
  const filteredSessions = sessions
    .filter((session) => includeTime(cutoff, session.time.updated))
    .filter((session) => {
      if (input.projectFilter === undefined) return true
      if (input.projectFilter === "") return session.projectID === input.currentProject?.id
      return session.projectID === input.projectFilter
    })

  if (filteredSessions.length > 1000) {
    process.stderr.write(`Large dataset detected (${filteredSessions.length} sessions). This may take a while...\n`)
  }

  const aggregates = yield* Effect.forEach(filteredSessions, (session) => aggregateSession(session, cutoff), {
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
      addUsage(total, event)
      addUsage(sessionUsage, event)
      addUsage(getDaily(daily, event.time), event)
    }

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
