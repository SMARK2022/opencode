import { Effect } from "effect"
import { Session } from "@/session/session"
import type { MessageV2 } from "@/session/message-v2"
import { RequestUsageAssistantTable, RequestUsageTable } from "@/session/request-usage.sql"
import { NotFoundError } from "@/storage/storage"
import { Database, eq, gte } from "@/storage/db"
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

export type InputComponentTotals = {
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

export type UsageTotals = {
  tokens: TokenTotals
  components: InputComponentTotals
  cost: number
  requests: number
  assistantCalls: number
  errors: number
  aborted: number
  durationMs: number
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

export type ToolUsage = {
  id: string
  count: number
  inputChars: number
  outputChars: number
  contextTokens: number
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
  agents: UsageGroup[]
  sources: UsageGroup[]
  statuses: UsageGroup[]
  projects: UsageGroup[]
  daily: DailyUsage[]
  modelSeries: UsageSeries[]
  providerSeries: UsageSeries[]
  agentSeries: UsageSeries[]
  sourceSeries: UsageSeries[]
  statusSeries: UsageSeries[]
  projectSeries: UsageSeries[]
  toolSeries: UsageSeries[]
  tokenPartSeries: TokenPartSeries[]
  sessions: SessionUsage[]
  toolUsage: ToolUsage[]
  modelProviderTokens: { providerID: string; modelID: string; tokens: number }[]
  tokensPerSession: number
  medianTokensPerSession: number
}

export type StatsFilter = {
  days?: number
  projectFilter?: string
  currentProject?: Project.Info
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
  projectID: string
  providerID: string
  modelID: string
  source: string
  agent: string
  status: string
  tokens: TokenTotals
  components: InputComponentTotals
  cost: number
  requests: number
  assistantCalls: number
  errors: number
  aborted: number
  durationMs: number
}

type SessionAggregate = {
  session: Session.Info
  messageCount: number
  toolUsage: Record<string, ToolUsage>
  toolEvents: ToolUsageEvent[]
  totalEvents: UsageEvent[]
  breakdownEvents: UsageEvent[]
}

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

type ToolEventSeed = {
  message: MessageV2.WithParts | undefined
  components: InputComponentTotals
  event: Omit<UsageEvent, "tokens" | "components" | "cost" | "requests" | "assistantCalls" | "errors" | "aborted" | "durationMs">
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

const emptyComponents = (): InputComponentTotals => ({
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

const emptyUsage = (): UsageTotals => ({
  tokens: emptyTokens(),
  components: emptyComponents(),
  cost: 0,
  requests: 0,
  assistantCalls: 0,
  errors: 0,
  aborted: 0,
  durationMs: 0,
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

const addUsage = (target: UsageTotals, event: UsageEvent) => {
  addTokens(target.tokens, event.tokens)
  addComponents(target.components, event.components)
  target.cost += event.cost
  target.requests += event.requests
  target.assistantCalls += event.assistantCalls
  target.errors += event.errors
  target.aborted += event.aborted
  target.durationMs += event.durationMs
}

const increment = (map: Map<string, number>, key: string, value: number) => map.set(key, (map.get(key) ?? 0) + value)

const textMatches = (value: string | undefined, filter: string | undefined) => {
  if (filter === undefined) return true
  return (value ?? "").toLowerCase().includes(filter.toLowerCase())
}

const eventMatches = (event: UsageEvent, input: StatsFilter) =>
  textMatches(event.modelID, input.modelFilter) &&
  textMatches(event.providerID, input.providerFilter) &&
  textMatches(event.source, input.sourceFilter) &&
  textMatches(event.agent, input.agentFilter) &&
  textMatches(event.status, input.statusFilter)

const toolEventMatches = (event: ToolUsageEvent, input: StatsFilter) =>
  textMatches(event.toolID, input.toolFilter) &&
  textMatches(event.modelID, input.modelFilter) &&
  textMatches(event.providerID, input.providerFilter) &&
  textMatches(event.source, input.sourceFilter) &&
  textMatches(event.agent, input.agentFilter) &&
  textMatches(event.status, input.statusFilter)

const sessionMatches = (session: Session.Info, input: StatsFilter) =>
  textMatches(session.id, input.sessionFilter) ||
  textMatches(session.title, input.sessionFilter) ||
  textMatches(session.directory, input.sessionFilter)

const getToolUsage = (map: Record<string, ToolUsage>, id: string) => {
  const existing = map[id]
  if (existing) return existing
  const item = { id, count: 0, inputChars: 0, outputChars: 0, contextTokens: 0 }
  map[id] = item
  return item
}

const addToolUsage = (map: Record<string, ToolUsage>, usage: ToolUsage) => {
  const item = getToolUsage(map, usage.id)
  item.count += usage.count
  item.inputChars += usage.inputChars
  item.outputChars += usage.outputChars
  item.contextTokens += usage.contextTokens
}

const addToolContextTokens = (map: Record<string, ToolUsage>, toolID: string, contextTokens: number) => {
  getToolUsage(map, toolID).contextTokens += contextTokens
}

const toolEventUsage = (event: ToolUsageEvent): UsageEvent => ({
  time: event.time,
  sessionID: event.sessionID,
  projectID: event.projectID,
  providerID: event.providerID,
  modelID: event.modelID,
  source: event.source,
  agent: event.agent,
  status: event.status,
  tokens: {
    input: event.contextTokens,
    output: 0,
    reasoning: 0,
    cache: { read: 0, write: 0 },
    total: event.contextTokens,
  },
  components: emptyComponents(),
  cost: 0,
  requests: 0,
  assistantCalls: 0,
  errors: 0,
  aborted: 0,
  durationMs: 0,
})

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
    .sort((a, b) => b.tokens.total - a.tokens.total || b.cost - a.cost)

const dayStart = (time: number) => {
  const date = new Date(time)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

const dateLabel = (time: number) =>
  new Date(time).toLocaleDateString(undefined, { month: "short", day: "numeric" })

const buildDayBuckets = (start: number, end: number) => {
  const startDay = dayStart(start)
  const endDay = dayStart(Math.max(startDay, end))
  return Array.from({ length: Math.floor((endDay - startDay) / MS_IN_DAY) + 1 }, (_, index) => {
    const day = startDay + index * MS_IN_DAY
    return { day, label: dateLabel(day), ...emptyUsage() } satisfies DailyUsage
  })
}

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
            projectID: id,
            providerID: id,
            modelID: id,
            source: id,
            agent: id,
            status: id,
            tokens: point.tokens,
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
    .sort((a, b) => b.tokens.total - a.tokens.total || b.cost - a.cost)

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

const getSessions = (cutoff: number) =>
  Effect.sync(() =>
    Database.use((db) => {
      const rows = cutoff > 0
        ? db.select().from(SessionTable).where(gte(SessionTable.time_updated, cutoff)).all()
        : db.select().from(SessionTable).all()
      return rows.map((row) => Session.fromRow(row))
    }),
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

const rowDuration = (row: { time_created: number; time_completed: number | null }) =>
  row.time_completed ? Math.max(0, row.time_completed - row.time_created) : 0

const statusCounts = (status: string, requests: number) => ({
  errors: status === "error" ? requests : 0,
  aborted: status === "aborted" ? requests : 0,
})

const stepInputTokens = (part: MessageV2.StepFinishPart) => part.tokens.input + part.tokens.cache.read + part.tokens.cache.write

const componentsFromStep = (part: MessageV2.StepFinishPart) => {
  if (!part.inputBreakdown || !part.inputChars) return emptyComponents()
  const inputTokens = stepInputTokens(part)
  const media = part.inputBreakdown.media
  const attachmentTokens = media?.tokens
  const textTokens = attachmentTokens === undefined ? inputTokens : Math.max(0, inputTokens - attachmentTokens)
  const textChars = media ? Math.max(1, part.inputChars - media.rawChars + media.textChars) : part.inputChars
  const alloc = (chars: number) => Math.round((chars / textChars) * textTokens)
  return {
    system: alloc(part.inputBreakdown.system),
    instructions: alloc(part.inputBreakdown.instructions),
    skills: alloc(part.inputBreakdown.skills),
    toolSchemas: alloc(part.inputBreakdown.tools),
    userMessages: alloc(part.inputBreakdown.messages.userText),
    assistantText: alloc(part.inputBreakdown.messages.assistantText),
    reasoning: alloc(part.inputBreakdown.messages.reasoning),
    toolCalls: alloc(part.inputBreakdown.messages.toolInput),
    toolResults: alloc(part.inputBreakdown.messages.toolOutput),
    attachments: attachmentTokens ?? alloc(part.inputBreakdown.messages.attachments),
  } satisfies InputComponentTotals
}

const componentsFromAssistant = (message: MessageV2.WithParts | undefined) => {
  const components = emptyComponents()
  for (const part of message?.parts ?? []) {
    if (part.type !== "step-finish") continue
    addComponents(components, componentsFromStep(part))
  }
  return components
}

const toolInputChars = (part: MessageV2.ToolPart) => {
  if (part.state.status === "pending") return part.state.raw.length
  return JSON.stringify(part.state.input).length
}

const toolOutputChars = (part: MessageV2.ToolPart) => {
  if (part.state.status === "completed") return part.state.output.length + (part.state.attachments ?? []).reduce((sum, item) => sum + item.url.length, 0)
  if (part.state.status === "error") return part.state.error.length
  return 0
}

// Preserve the old attribution formula, but scan each session once instead of once per assistant turn.
const toolEventsFromAssistants = (visibleMessages: MessageV2.WithParts[], seeds: ToolEventSeed[]) => {
  const tasks = seeds
    .filter((seed): seed is ToolEventSeed & { message: MessageV2.WithParts } => seed.message !== undefined)
    .sort((a, b) => a.message.info.time.created - b.message.info.time.created)
  if (tasks.length === 0) return []

  const deltas = visibleMessages
    .flatMap((message) =>
      message.parts
        .filter((part): part is MessageV2.ToolPart => part.type === "tool")
        .map((part) => ({
          time: message.info.time.created,
          toolID: part.tool,
          inputChars: toolInputChars(part),
          outputChars: toolOutputChars(part),
        })),
    )
    .sort((a, b) => a.time - b.time)

  const result: ToolUsageEvent[] = []
  const chars = new Map<string, { inputChars: number; outputChars: number }>()
  let inputTotal = 0
  let outputTotal = 0
  let deltaIndex = 0

  for (const task of tasks) {
    // Current attribution includes every tool message created at or before the assistant turn.
    while (deltaIndex < deltas.length && deltas[deltaIndex].time <= task.message.info.time.created) {
      const delta = deltas[deltaIndex]
      const item = chars.get(delta.toolID) ?? { inputChars: 0, outputChars: 0 }
      item.inputChars += delta.inputChars
      item.outputChars += delta.outputChars
      inputTotal += delta.inputChars
      outputTotal += delta.outputChars
      chars.set(delta.toolID, item)
      deltaIndex++
    }

    for (const [toolID, item] of chars) {
      const contextTokens =
        (inputTotal > 0 ? Math.round((task.components.toolCalls * item.inputChars) / inputTotal) : 0) +
        (outputTotal > 0 ? Math.round((task.components.toolResults * item.outputChars) / outputTotal) : 0)
      if (contextTokens === 0) continue
      result.push({
        time: task.event.time,
        sessionID: task.event.sessionID,
        projectID: task.event.projectID,
        providerID: task.event.providerID,
        modelID: task.event.modelID,
        source: task.event.source,
        agent: task.event.agent,
        status: task.event.status,
        toolID,
        contextTokens,
      })
    }
  }

  return result
}

const aggregateSession = Effect.fn("Cli.stats.aggregate.session")(function* (session: Session.Info, cutoff: number) {
  const svc = yield* Session.Service
  const messages = yield* svc
    .messages({ sessionID: session.id })
    .pipe(Effect.catchIf(NotFoundError.isInstance, () => Effect.succeed([])))
  const visibleMessages = messages.filter((message) => includeTime(cutoff, message.info.time.created))
  const messagesByID = new Map(visibleMessages.map((message) => [message.info.id, message]))
  const requestUsageRows = Database.use((db) =>
    db.select().from(RequestUsageTable).where(eq(RequestUsageTable.session_id, session.id)).all(),
  )
  const assistantUsageRows = Database.use((db) =>
    db.select().from(RequestUsageAssistantTable).where(eq(RequestUsageAssistantTable.session_id, session.id)).all(),
  )
  const totalEvents: UsageEvent[] = []
  const breakdownEvents: UsageEvent[] = []
  const toolEvents: ToolUsageEvent[] = []

  if (requestUsageRows.length > 0) {
    const requestRows = requestUsageRows.filter((row) => includeTime(cutoff, row.time_created))
    const assistantRows = assistantUsageRows.filter((row) => includeTime(cutoff, row.time_created))
    const requestsByID = new Map(requestRows.map((row) => [row.request_id, row]))

    if (assistantRows.length > 0) {
      const assistantRequests = new Set(assistantRows.map((row) => row.request_id))
      const assistantToolEvents: ToolEventSeed[] = []
      const assistantEvents = assistantRows.map((row) => {
        const request = requestsByID.get(row.request_id)
        const message = messagesByID.get(row.assistant_message_id)
        const components = componentsFromAssistant(message)
        const event = {
          time: row.time_created,
          sessionID: session.id,
          projectID: session.projectID,
          providerID: row.provider_id,
          modelID: row.model_id,
          source: request?.source ?? "assistant",
          agent: request?.agent ?? session.agent ?? "unknown",
          status: row.status,
          tokens: rowTokens(row),
          components,
          cost: row.cost_micros / MICROS,
          requests: 0,
          assistantCalls: 1,
          errors: 0,
          aborted: 0,
          durationMs: 0,
        }
        assistantToolEvents.push({ message, components, event })
        return event
      })
      toolEvents.push(...toolEventsFromAssistants(visibleMessages, assistantToolEvents))
      const fallbackRequestEvents = requestRows
        .filter((row) => !assistantRequests.has(row.request_id))
        .map((row) => ({
          time: row.time_created,
          sessionID: session.id,
          projectID: session.projectID,
          providerID: row.provider_id,
          modelID: row.model_id,
          source: row.source,
          agent: row.agent || session.agent || "unknown",
          status: row.status,
          tokens: rowTokens(row),
          components: emptyComponents(),
          cost: row.cost_micros / MICROS,
          requests: 1,
          assistantCalls: row.assistant_count || 1,
          ...statusCounts(row.status, 1),
          durationMs: rowDuration(row),
        }))
      totalEvents.push(...assistantEvents)
      totalEvents.push(...fallbackRequestEvents)
      totalEvents.push(
        ...requestRows.filter((row) => assistantRequests.has(row.request_id)).map((row) => ({
          time: row.time_created,
          sessionID: session.id,
          projectID: session.projectID,
          providerID: row.provider_id,
          modelID: row.model_id,
          source: row.source,
          agent: row.agent || session.agent || "unknown",
          status: row.status,
          tokens: emptyTokens(),
          components: emptyComponents(),
          cost: 0,
          requests: 1,
          assistantCalls: 0,
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
        projectID: session.projectID,
        providerID: row.provider_id,
        modelID: row.model_id,
        source: row.source,
        agent: row.agent || session.agent || "unknown",
        status: row.status,
        tokens: rowTokens(row),
        components: emptyComponents(),
        cost: row.cost_micros / MICROS,
        requests: 1,
        assistantCalls: row.assistant_count || 1,
        ...statusCounts(row.status, 1),
        durationMs: rowDuration(row),
      }))
      totalEvents.push(...requestEvents)
      breakdownEvents.push(...requestEvents)
    }
  } else {
    const legacyToolEvents: ToolEventSeed[] = []
    for (const message of visibleMessages) {
      if (message.info.role !== "assistant") continue
      const tokens = normalizeTokens(message.info.tokens ?? emptyTokens())
      const components = componentsFromAssistant(message)
      const event = {
        time: message.info.time.created,
        sessionID: session.id,
        projectID: session.projectID,
        providerID: message.info.providerID,
        modelID: message.info.modelID,
        source: "legacy-message",
        agent: session.agent ?? "unknown",
        status: "completed",
        tokens,
        components,
        cost: message.info.cost ?? 0,
        requests: 0,
        assistantCalls: 1,
        errors: 0,
        aborted: 0,
        durationMs: 0,
      }
      legacyToolEvents.push({ message, components, event })
      totalEvents.push(event)
      breakdownEvents.push(event)
    }
    toolEvents.push(...toolEventsFromAssistants(visibleMessages, legacyToolEvents))
  }

  const toolUsage: Record<string, ToolUsage> = {}
  for (const message of visibleMessages) {
    for (const part of message.parts) {
      if (part.type !== "tool" || !part.tool) continue
      const item = getToolUsage(toolUsage, part.tool)
      item.count++
      item.inputChars += toolInputChars(part)
      item.outputChars += toolOutputChars(part)
    }
  }

  return { session, messageCount: visibleMessages.length, toolUsage, toolEvents, totalEvents, breakdownEvents } satisfies SessionAggregate
})

export const aggregateStats = Effect.fn("Cli.stats.aggregate")(function* (input: StatsFilter = {}) {
  const cutoff = cutoffFromDays(input.days)
  const sessions = yield* getSessions(cutoff)
  const filteredSessions = sessions
    .filter((session) => includeTime(cutoff, session.time.updated))
    .filter((session) => sessionMatches(session, input))
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
  const filteredAggregates = input.toolFilter === undefined
    ? aggregates
    : aggregates.filter((aggregate) => Object.values(aggregate.toolUsage).some((tool) => textMatches(tool.id, input.toolFilter)))

  const total = emptyUsage()
  const daily = new Map<number, DailyUsage>()
  const modelSeries = new Map<string, Map<number, DailyUsage>>()
  const providerSeries = new Map<string, Map<number, DailyUsage>>()
  const agentSeries = new Map<string, Map<number, DailyUsage>>()
  const sourceSeries = new Map<string, Map<number, DailyUsage>>()
  const statusSeries = new Map<string, Map<number, DailyUsage>>()
  const projectSeries = new Map<string, Map<number, DailyUsage>>()
  const toolSeries = new Map<string, Map<number, DailyUsage>>()
  const models = new Map<string, UsageGroupAccumulator>()
  const providers = new Map<string, UsageGroupAccumulator>()
  const agents = new Map<string, UsageGroupAccumulator>()
  const sources = new Map<string, UsageGroupAccumulator>()
  const statuses = new Map<string, UsageGroupAccumulator>()
  const projects = new Map<string, UsageGroupAccumulator>()
  const modelProviderTokens = new Map<string, number>()
  const toolUsage: Record<string, ToolUsage> = {}
  const sessionsWithUsage: SessionUsage[] = []
  const sessionTokenTotals: number[] = []
  let totalMessages = 0
  let totalTools = 0

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
    matchingTools.forEach((tool) => addToolUsage(toolUsage, { ...tool, contextTokens: 0 }))
    aggregate.toolEvents
      .filter((event) => toolEventMatches(event, input))
      .forEach((event) => {
        addToolContextTokens(toolUsage, event.toolID, event.contextTokens)
        addUsage(getSeriesDaily(toolSeries, event.toolID, event.time), toolEventUsage(event))
      })

    for (const event of aggregate.totalEvents.filter((event) => eventMatches(event, input))) {
      addUsage(total, event)
      addUsage(sessionUsage, event)
      addUsage(getDaily(daily, event.time), event)
    }

    for (const event of aggregate.breakdownEvents.filter((event) => eventMatches(event, input))) {
      addGroup(models, event.modelID, event.modelID, event)
      addGroup(providers, event.providerID, event.providerID, event)
      addGroup(agents, event.agent, event.agent, event)
      addGroup(sources, event.source, event.source, event)
      addGroup(statuses, event.status, event.status, event)
      addGroup(projects, event.projectID, event.projectID, event)
      addUsage(getSeriesDaily(modelSeries, event.modelID, event.time), event)
      addUsage(getSeriesDaily(providerSeries, event.providerID, event.time), event)
      addUsage(getSeriesDaily(agentSeries, event.agent, event.time), event)
      addUsage(getSeriesDaily(sourceSeries, event.source, event.time), event)
      addUsage(getSeriesDaily(statusSeries, event.status, event.time), event)
      addUsage(getSeriesDaily(projectSeries, event.projectID, event.time), event)
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
    toolSeries: finalizeSeries(toolSeries, completeDaily),
    tokenPartSeries: tokenPartSeries(completeDaily),
    sessions: sessionsWithUsage.sort((a, b) => b.tokens.total - a.tokens.total || b.cost - a.cost),
    toolUsage: Object.values(toolUsage)
      .sort((a, b) => b.contextTokens - a.contextTokens || b.count - a.count),
    modelProviderTokens: Array.from(modelProviderTokens, ([key, tokens]) => {
      const [providerID, modelID] = key.split("\0")
      return { providerID, modelID, tokens }
    }),
    tokensPerSession: sessionsWithUsage.length > 0 ? total.tokens.total / sessionsWithUsage.length : 0,
    medianTokensPerSession,
  } satisfies StatsReport
})
