import { Effect } from "effect"
import { Session } from "@/session/session"
import { RequestUsageAssistantTable, RequestUsageTable } from "@/session/request-usage.sql"
import { Database, and, gte, inArray, sql } from "@/storage/db"
import { MessageTable, PartTable, SessionTable, type PartColdStats } from "@/session/session.sql"
import { ColdStorage } from "@/storage/cold"
import type { Project } from "@/project/project"
import { ProjectTable } from "@/project/project.sql"
import type { MessageID, SessionID } from "@/session/schema"

const MICROS = 1_000_000
const displayText = (value: string) => value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").trim()

const projectIdentity = (
  id: string,
  row: { name: string | null; worktree: string } | undefined,
  directory: string | undefined,
) => {
  // 名称与路径来自用户数据，只替换会控制终端布局的字符；shell 元字符从不进入执行路径，应原样显示。
  const projectPath = displayText(row?.worktree ?? directory ?? "")
  // 数据库可跨操作系统复制；同时识别两种分隔符，避免在 macOS 上把 Windows worktree 整段当作名称。
  const label = displayText(row?.name ?? "") || displayText(projectPath.split(/[\\/]/).filter(Boolean).at(-1) ?? "") || id
  return { label, path: projectPath }
}

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

export type ProjectUsage = UsageGroup & {
  // path 只用于可识别展示；project id 继续承担过滤和 series 关联，不能互换。
  path: string
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

export type ToolCallAttribution = {
  // toolID 是真实 ToolPart 名称；其余维度描述拥有该 ToolPart 的 Assistant 运行时。
  toolID: string
  modelID: string
  providerID: string
  agent: string
  projectID: string
  // source/status 来自关联请求；无法关联的历史记录必须显式标为 unattributed/unknown。
  source: string
  status: string
  // calls 与字符数是 ToolPart footprint，不能解释为计费 token 或费用。
  calls: number
  inputChars: number
  outputChars: number
  // errors/duration 描述工具执行本身，与 owning request 的健康指标相互独立。
  errors: number
  durationMs: number
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
  projects: ProjectUsage[]
  daily: DailyUsage[]
  // 24 槽使用 RequestUsage.time_created 的本地小时；只计 request shell，不重复计算 Assistant rows。
  requestsByHour: number[]
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
  toolCalls: ToolCallAttribution[]
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
  // Request outcome 与 Assistant 自身状态可能不同；健康筛选和 Status 页面必须以前者为准。
  outcome?: string
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
  toolCalls: ToolCallAttribution[]
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
  message: StatsMessage | undefined
  components: InputComponentTotals
  event: Omit<UsageEvent, "tokens" | "components" | "cost" | "requests" | "assistantCalls" | "errors" | "aborted" | "durationMs">
}

type StatsToolPart = Extract<PartColdStats, { type: "tool" }> & {
  tool: string
  status: "pending" | "running" | "completed" | "error"
  start?: number
  end?: number
}

type StatsStepPart = Extract<PartColdStats, { type: "step-finish" }>
type StatsPart = StatsToolPart | StatsStepPart

type StatsMessage =
  | { id: MessageID; time: number; role: "user"; parts: StatsPart[] }
  | {
      id: MessageID
      time: number
      role: "assistant"
      providerID: string
      modelID: string
      agent: string
      cost: number
      tokens: TokenTotals
      parts: StatsPart[]
    }

// 内部 scalar snapshot 不导出，公开 StatsReport schema 不因存储优化改变。
type StatsRows = {
  // messages 只包含统计需要的 role/time/model/token 与 Tool/Step 标量，不是可回放 transcript。
  // 空 Session 显式表现为空数组，aggregate 不需要通过 NotFound fallback 合成成功。
  messages: Map<SessionID, StatsMessage[]>
  // Part 标量已由 ColdStorage 验证，聚合层不再理解 pack/ref/key 或 codec。
  // requests 保留既有 attribution rows，cold projection 不成为新的 usage 权威。
  requests: Map<SessionID, (typeof RequestUsageTable.$inferSelect)[]>
  // loader 一次建立三类 rows，所有透视表基于同一批 DB 事实计算。
  // 三个 Map 都以已过滤 SessionID 为 key，跨项目数据不能在聚合阶段误关联。
  assistants: Map<SessionID, (typeof RequestUsageAssistantTable.$inferSelect)[]>
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

// 汇总只依赖数值字段，不要求伪造 session/provider 等身份；这也避免非法品牌值进入运行时。
const addUsage = (target: UsageTotals, event: UsageTotals) => {
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
  // 有 owning request 时按最终结果过滤，避免 error request 中已完成的 Assistant usage 被提前丢弃。
  textMatches(event.outcome ?? event.status, input.statusFilter)

const toolEventMatches = (event: ToolUsageEvent, input: StatsFilter) =>
  textMatches(event.toolID, input.toolFilter) &&
  textMatches(event.modelID, input.modelFilter) &&
  textMatches(event.providerID, input.providerFilter) &&
  textMatches(event.source, input.sourceFilter) &&
  textMatches(event.agent, input.agentFilter) &&
  textMatches(event.status, input.statusFilter)

const toolCallMatches = (call: ToolCallAttribution, input: StatsFilter) =>
  // Tool 页面必须让所有 owner filter 作用于同一 tuple，不能只过滤 context estimate。
  textMatches(call.toolID, input.toolFilter) &&
  textMatches(call.modelID, input.modelFilter) &&
  textMatches(call.providerID, input.providerFilter) &&
  textMatches(call.source, input.sourceFilter) &&
  textMatches(call.agent, input.agentFilter) &&
  textMatches(call.status, input.statusFilter)

const sessionMatches = (session: Session.Info, input: StatsFilter) =>
  textMatches(session.id, input.sessionFilter) ||
  textMatches(session.title, input.sessionFilter) ||
  textMatches(session.directory, input.sessionFilter)

const getToolUsage = (map: Record<string, ToolUsage>, id: string) => {
  // ToolUsage 是按名称汇总的最终显示投影，owner 细节仍保留在 toolCalls 中。
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
  // estimated context 只累加到独立字段，不能改变真实 calls/chars 计数。
  getToolUsage(map, toolID).contextTokens += contextTokens
}

const addToolCall = (map: Map<string, ToolCallAttribution>, call: ToolCallAttribution) => {
  // 复合 owner 键保留发起方，不能先按 toolID 合并后再反推模型、Agent 或 Project 占比。
  const key = [call.projectID, call.agent, call.providerID, call.modelID, call.source, call.status, call.toolID].join("\0")
  const item = map.get(key) ?? { ...call, calls: 0, inputChars: 0, outputChars: 0, errors: 0, durationMs: 0 }
  item.calls += call.calls
  item.inputChars += call.inputChars
  item.outputChars += call.outputChars
  item.errors += call.errors
  item.durationMs += call.durationMs
  map.set(key, item)
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

const shiftDay = (time: number, amount: number) => {
  // 使用本地日历加减而非固定毫秒，跨 DST 时仍保持在目标自然日零点。
  // amount 可以为负数，正反方向必须遵守同一日历语义。
  const date = new Date(time)
  date.setDate(date.getDate() + amount)
  return dayStart(date.getTime())
}

const buildDayBuckets = (start: number, end: number) => {
  const startDay = dayStart(start)
  const endDay = dayStart(Math.max(startDay, end))
  const days: DailyUsage[] = []
  // 自然日不能用固定 24 小时递增；跨 DST 时，一天可能是 23 或 25 小时。
  for (const date = new Date(startDay); date.getTime() <= endDay; date.setDate(date.getDate() + 1)) {
    const day = dayStart(date.getTime())
    days.push({ day, label: dateLabel(day), ...emptyUsage() })
  }
  return days
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
          addUsage(series, point)
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

const getProjects = () =>
  Effect.sync(() =>
    // 一次批量读取即可覆盖所有聚合行，避免在 project group 循环中形成 N+1 查询。
    Database.use((db) => db.select({ id: ProjectTable.id, name: ProjectTable.name, worktree: ProjectTable.worktree }).from(ProjectTable).all()),
  )

const cutoffFromDays = (days?: number) => {
  // 正数 N 包含今天在内的 N 个完整自然日；0 单独表示今天，undefined 表示全历史。
  // cutoff 是闭区间起点，因此 N 天窗口需要从今天回退 N-1 天。
  if (days === undefined) return 0
  if (days === 0) return dayStart(Date.now())
  return shiftDay(Date.now(), -(days - 1))
}

const windowDays = (days?: number): number | undefined => {
  // bucket 数与 cutoff 共享同一语义，防止总计覆盖范围大于图表日期范围。
  if (days === undefined) return undefined
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

const finiteStat = (value: number | undefined) => typeof value === "number" && Number.isFinite(value) ? value : 0

const componentsFromAssistant = (message: StatsMessage | undefined) => {
  const components = emptyComponents()
  for (const part of message?.parts ?? []) {
    if (part.type !== "step-finish") continue
    addComponents(components, part.components)
  }
  return components
}

const toolDuration = (part: StatsToolPart) => {
  // pending/running 没有完整结束时间；调用仍计数，但不能用当前时间伪造耗时。
  if ((part.status !== "completed" && part.status !== "error") || part.start === undefined || part.end === undefined) return 0
  return Math.max(0, part.end - part.start)
}

// 保留既有上下文归因公式，但每个 Session 只扫描一次，避免按 Assistant turn 重复遍历。
const toolEventsFromAssistants = (visibleMessages: StatsMessage[], seeds: ToolEventSeed[]) => {
  const tasks = seeds
    .filter((seed): seed is ToolEventSeed & { message: StatsMessage } => seed.message !== undefined)
    .sort((a, b) => a.message.time - b.message.time)
  if (tasks.length === 0) return []

  const deltas = visibleMessages
    .flatMap((message) =>
      message.parts
        .filter((part): part is StatsToolPart => part.type === "tool")
        .map((part) => ({
          time: message.time,
          toolID: part.tool,
          inputChars: part.inputChars,
          outputChars: part.outputChars,
        })),
    )
    .sort((a, b) => a.time - b.time)

  const result: ToolUsageEvent[] = []
  const chars = new Map<string, { inputChars: number; outputChars: number }>()
  let inputTotal = 0
  let outputTotal = 0
  let deltaIndex = 0

  for (const task of tasks) {
    // 既有归因口径包含该 Assistant turn 之前及同一时刻产生的全部工具消息。
    while (deltaIndex < deltas.length && deltas[deltaIndex].time <= task.message.time) {
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
        status: task.event.outcome ?? task.event.status,
        toolID,
        contextTokens,
      })
    }
  }

  return result
}

function append<K, V>(map: Map<K, V[]>, key: K, value: V) {
  const values = map.get(key)
  if (values) values.push(value)
  else map.set(key, [value])
}

// Stats 读取 selected Session 的 scalar projection，而不是调用 transcript hydration。
// Message SELECT 明确排除 user summary.diffs；Part 只读取 Tool/StepFinish，避免把无关 archive 搬入 JS。
const loadStatsRows = (sessionIDs: SessionID[]) =>
  Effect.sync(() =>
    Database.use((db): StatsRows => {
      // 2000-ID chunk 与 maintenance 上限一致，并绕开 SQLite variable 数量限制。
      const batches = sessionIDs.flatMap((_, index) =>
        index % ColdStorage.DEFAULT_BATCH_SIZE === 0
          ? [sessionIDs.slice(index, index + ColdStorage.DEFAULT_BATCH_SIZE)]
          : [],
      )
      // SQLite 只提取 Message 标量，大型 summary.diffs 不进入 JavaScript heap。
      const messageRows = batches.flatMap((batch) =>
        db
          .select({
            id: MessageTable.id,
            sessionID: MessageTable.session_id,
            time: MessageTable.time_created,
            role: sql<string>`json_extract(${MessageTable.data}, '$.role')`,
            providerID: sql<string | null>`json_extract(${MessageTable.data}, '$.providerID')`,
            modelID: sql<string | null>`json_extract(${MessageTable.data}, '$.modelID')`,
            agent: sql<string | null>`json_extract(${MessageTable.data}, '$.agent')`,
            cost: sql<number | null>`json_extract(${MessageTable.data}, '$.cost')`,
            tokensInput: sql<number | null>`json_extract(${MessageTable.data}, '$.tokens.input')`,
            tokensOutput: sql<number | null>`json_extract(${MessageTable.data}, '$.tokens.output')`,
            tokensReasoning: sql<number | null>`json_extract(${MessageTable.data}, '$.tokens.reasoning')`,
            tokensCacheRead: sql<number | null>`json_extract(${MessageTable.data}, '$.tokens.cache.read')`,
            tokensCacheWrite: sql<number | null>`json_extract(${MessageTable.data}, '$.tokens.cache.write')`,
            tokensTotal: sql<number | null>`json_extract(${MessageTable.data}, '$.tokens.total')`,
          })
          .from(MessageTable)
          .where(inArray(MessageTable.session_id, batch))
          .all(),
      )
      // Part query 保留 Tool name/status/time 与 Step tokens 这些既有 hot 统计输入。
      const partRows = batches.flatMap((batch) =>
        db
          .select()
          .from(PartTable)
          .where(
            and(
              inArray(PartTable.session_id, batch),
              sql`json_extract(${PartTable.data}, '$.type') in ('tool', 'step-finish')`,
            ),
          )
          .orderBy(PartTable.message_id, PartTable.id)
          .all(),
      )
      // v2 读同行投影，v1 grouped decode，hot 现场计算；三者复用 ColdStorage 公式。
      const projections = ColdStorage.inspectPartStats(db, partRows)
      const parts = new Map<MessageID, StatsPart[]>()
      partRows.forEach((row, index) => {
        // discriminator 不匹配立即失败，不能丢弃异常 Part 后返回不完整报告。
        const projection = projections[index]
        if (row.data.type === "step-finish") {
          if (projection?.type !== "step-finish") throw new Error(`Stats Step projection is unavailable: ${row.id}`)
          append(parts, row.message_id, projection)
          return
        }
        if (row.data.type !== "tool") throw new Error(`Stats query returned an unsupported Part: ${row.id}`)
        if (projection?.type !== "tool") throw new Error(`Stats Tool projection is unavailable: ${row.id}`)
        const state = row.data.state
        append(parts, row.message_id, {
          ...projection,
          tool: row.data.tool,
          status: state.status,
          ...(state.status === "pending" ? {} : { start: state.time.start }),
          ...(state.status === "completed" || state.status === "error" ? { end: state.time.end } : {}),
        })
      })

      // Parts 只按 message_id 关联，孤立行不会被猜测归属另一个 Assistant。
      const messages = new Map<SessionID, StatsMessage[]>()
      for (const row of messageRows) {
        const messageParts = parts.get(row.id) ?? []
        if (row.role === "user") {
          append(messages, row.sessionID, { id: row.id, time: row.time, role: "user", parts: messageParts })
          continue
        }
        if (row.role !== "assistant" || row.providerID === null || row.modelID === null || row.agent === null) {
          throw new Error(`Stats Message projection is invalid: ${row.id}`)
        }
        append(messages, row.sessionID, {
          id: row.id,
          time: row.time,
          role: "assistant",
          providerID: row.providerID,
          modelID: row.modelID,
          agent: row.agent,
          cost: finiteStat(row.cost ?? undefined),
          tokens: normalizeTokens({
            input: finiteStat(row.tokensInput ?? undefined),
            output: finiteStat(row.tokensOutput ?? undefined),
            reasoning: finiteStat(row.tokensReasoning ?? undefined),
            cache: {
              read: finiteStat(row.tokensCacheRead ?? undefined),
              write: finiteStat(row.tokensCacheWrite ?? undefined),
            },
            ...(row.tokensTotal === null ? {} : { total: row.tokensTotal }),
          }),
          parts: messageParts,
        })
      }
      // persisted time 后用 ID 打破同毫秒平局，保持旧 Session.messages chronology。
      for (const rows of messages.values()) rows.sort((a, b) => a.time - b.time || a.id.localeCompare(b.id))

      const requests = new Map<SessionID, (typeof RequestUsageTable.$inferSelect)[]>()
      const assistants = new Map<SessionID, (typeof RequestUsageAssistantTable.$inferSelect)[]>()
      // attribution 两表同样分块读取，替代原先每 Session 两次 SQL 的 N+1 往返。
      for (const batch of batches) {
        for (const row of db.select().from(RequestUsageTable).where(inArray(RequestUsageTable.session_id, batch)).all()) {
          append(requests, row.session_id, row)
        }
        for (const row of db.select().from(RequestUsageAssistantTable).where(inArray(RequestUsageAssistantTable.session_id, batch)).all()) {
          append(assistants, row.session_id, row)
        }
      }
      // 快照只活一次命令且没有 owner mutation，不能升级为需失效维护的全局 cache。
      return { messages, requests, assistants }
    }),
  )

const aggregateSession = (session: Session.Info, cutoff: number, rows: StatsRows) => {
  // cutoff 继续作用于 Message/RequestUsage 的持久时间，raw loader 不能以 Session updated 替代事件窗口。
  // toolCalls 归属 Assistant runtime；request shell 存在时不能把 legacy message 猜成精确 request。
  const messages = rows.messages.get(session.id) ?? []
  const visibleMessages = messages.filter((message) => includeTime(cutoff, message.time))
  const messagesByID = new Map(visibleMessages.map((message) => [message.id, message]))
  const requestUsageRows = rows.requests.get(session.id) ?? []
  const assistantUsageRows = rows.assistants.get(session.id) ?? []
  const storedRequestsByID = new Map(requestUsageRows.map((row) => [row.request_id, row]))
  const assistantUsageByMessageID = new Map(assistantUsageRows.map((row) => [row.assistant_message_id, row]))
  // ToolPart ownership 与 context consumption 在同一次 Message 扫描中建立，避免第二次读取 Session。
  // Tool chars 来自同行投影，status/error/duration 来自同一 hot Part tuple。
  const toolCalls = visibleMessages.flatMap((message): ToolCallAttribution[] => {
    if (message.role !== "assistant") return []
    const assistant = assistantUsageByMessageID.get(message.id)
    const request = assistant ? storedRequestsByID.get(assistant.request_id) : undefined
    // 有 request 数据却找不到 Assistant row 通常是 fork/cutoff 历史，不能猜测它原属哪个请求。
    // 有 AssistantUsage 时优先采用 request source/final status；只有 row 时回退 Assistant 状态。
    const source = assistant ? request?.source ?? "assistant" : requestUsageRows.length > 0 ? "unattributed" : "legacy-message"
    // 整个 Session 都没有 RequestUsage 才能使用 legacy completed，不能把 fork 历史伪装成精确归因。
    const status = assistant ? request?.status ?? assistant.status : requestUsageRows.length > 0 ? "unknown" : "completed"
    return message.parts
      .filter((part): part is StatsToolPart => part.type === "tool")
      .map((part) => ({
        toolID: part.tool,
        modelID: assistant?.model_id ?? message.modelID,
        providerID: assistant?.provider_id ?? message.providerID,
        agent: request?.agent ?? message.agent ?? session.agent ?? "unknown",
        projectID: session.projectID,
        source,
        status,
        calls: 1,
        inputChars: part.inputChars,
        outputChars: part.outputChars,
        errors: part.status === "error" ? 1 : 0,
        durationMs: toolDuration(part),
      }))
  })
  const totalEvents: UsageEvent[] = []
  const breakdownEvents: UsageEvent[] = []
  const toolEvents: ToolUsageEvent[] = []

  if (requestUsageRows.length > 0) {
    // Step components 按 Assistant message ID 关联，不能跨 Assistant 平均再回填模型维度。
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
          // 窗口外 request 无法提供最终结果，此时保留 undefined 并由筛选回退 Assistant status。
          outcome: request?.status,
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
          outcome: row.status,
          tokens: rowTokens(row),
          components: emptyComponents(),
          cost: row.cost_micros / MICROS,
          requests: 1,
          assistantCalls: row.assistant_count || 1,
          ...statusCounts(row.status, 1),
          durationMs: rowDuration(row),
        }))
      const requestEvents = requestRows.filter((row) => assistantRequests.has(row.request_id)).map((row) => ({
          time: row.time_created,
          sessionID: session.id,
          projectID: session.projectID,
          providerID: row.provider_id,
          modelID: row.model_id,
          source: row.source,
          agent: row.agent || session.agent || "unknown",
          status: row.status,
          outcome: row.status,
          tokens: emptyTokens(),
          components: emptyComponents(),
          cost: 0,
          requests: 1,
          assistantCalls: 0,
          ...statusCounts(row.status, 1),
          durationMs: rowDuration(row),
        }))
      totalEvents.push(...assistantEvents, ...fallbackRequestEvents, ...requestEvents)
      breakdownEvents.push(...assistantEvents)
      breakdownEvents.push(...fallbackRequestEvents)
      // Shell 只携带一次 request 健康指标；加入 Breakdown 后不能复制给每个 Assistant owner。
      breakdownEvents.push(...requestEvents)
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
        outcome: row.status,
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
    // 缺 Assistant 明细时保留既有 fallbackRequestEvent 域，不扫描 transcript 猜替代 owner。
  } else {
    // 仅无 RequestUsage 的 legacy Session 才采用 Assistant Message totals。
    const legacyToolEvents: ToolEventSeed[] = []
    for (const message of visibleMessages) {
      if (message.role !== "assistant") continue
      const components = componentsFromAssistant(message)
      const event = {
        time: message.time,
        sessionID: session.id,
        projectID: session.projectID,
        providerID: message.providerID,
        modelID: message.modelID,
        source: "legacy-message",
        agent: session.agent ?? "unknown",
        status: "completed",
        tokens: message.tokens,
        components,
        cost: message.cost,
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
    // toolEvents 沿用时间前缀累计字符，存储路径变化不改变 context attribution。
    toolEvents.push(...toolEventsFromAssistants(visibleMessages, legacyToolEvents))
  }

  const toolUsage: Record<string, ToolUsage> = {}
  for (const message of visibleMessages) {
    for (const part of message.parts) {
      if (part.type !== "tool" || !part.tool) continue
      const item = getToolUsage(toolUsage, part.tool)
      item.count++
      item.inputChars += part.inputChars
      item.outputChars += part.outputChars
    }
  }

  // 公共 filters 在 aggregate 后统一执行，loader 不提前按 model/tool/status 改变分母。
  return { session, messageCount: visibleMessages.length, toolUsage, toolEvents, toolCalls, totalEvents, breakdownEvents } satisfies SessionAggregate
}

export const aggregateStats = Effect.fn("Cli.stats.aggregate")(function* (input: StatsFilter = {}) {
  // 先筛 Session 再读取 rows 是空间修复的关键，未命中 project/session filter 的 archive 不进入内存。
  // all-time 仍覆盖全部 selected sessions，只改变数据取得方式，不通过缩短窗口伪造性能收益。
  const cutoff = cutoffFromDays(input.days)
  const sessions = yield* getSessions(cutoff)
  const filteredSessions = sessions
    // Session updated 先缩小读取集合，精确事件 cutoff 仍在各 Session aggregate 内执行。
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

  // raw snapshot 一次读取，移除旧 concurrency:20 的 per-session hydration/N+1。
  const rows = yield* loadStatsRows(filteredSessions.map((session) => session.id))
  // loader/inspect 均无写入，v1 decode 也不会清 owner/ref 或补写 cold_stats。
  const aggregates = filteredSessions.map((session) => aggregateSession(session, cutoff, rows))
  // 任一 projection corruption 作为 Effect failure 返回，不用零值或部分 report 掩盖。
  // toolFilter 保持原公开过滤顺序，在完整 Session toolUsage 形成后才筛选。
  const filteredAggregates = input.toolFilter === undefined
    ? aggregates
    : aggregates.filter((aggregate) => Object.values(aggregate.toolUsage).some((tool) => textMatches(tool.id, input.toolFilter)))
  // Project identity 单独批量读取；path 只用于显示，ID 仍是 series 关联键。
  const projectRows = new Map<string, { name: string | null; worktree: string }>(
    // 查询结果只作为显示索引；显式 string 键避免 branded ProjectID 泄漏到通用统计类型。
    (yield* getProjects()).map((row) => [row.id, row] as const),
  )
  const projectDirectories = new Map<string, string>(
    // 代表性 Session directory 仅在 Project row 缺失时回退，不参与 project filter。
    filteredAggregates.map((aggregate) => [aggregate.session.projectID, aggregate.session.directory] as const),
  )
  const projectIdentities = new Map<string, { label: string; path: string }>(
    // 每个 project 只解析一次安全 display identity，group 与 series 因而共享同一 label。
    Array.from(new Set(filteredAggregates.map((aggregate) => aggregate.session.projectID))).map((id) => [
      id,
      projectIdentity(id, projectRows.get(id), projectDirectories.get(id)),
    ]),
  )

  // total、breakdown 与各 series 共用同一 SessionAggregate，不再各自触发 transcript 读取。
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
  const toolUsage: Record<string, ToolUsage> = {}
  const toolCalls = new Map<string, ToolCallAttribution>()
  const requestsByHour = Array.from({ length: 24 }, () => 0)
  const sessionsWithUsage: SessionUsage[] = []
  const sessionTokenTotals: number[] = []
  let totalMessages = 0
  let totalTools = 0

  for (const aggregate of filteredAggregates) {
    // 先过滤 owner tuple，再同时生成 Session、总调用量和 ToolUsage，三者分母必须一致。
    const matchingToolCalls = aggregate.toolCalls.filter((call) => toolCallMatches(call, input))
    const sessionUsage: SessionUsage = {
      id: aggregate.session.id,
      title: aggregate.session.title,
      projectID: aggregate.session.projectID,
      directory: aggregate.session.directory,
      created: aggregate.session.time.created,
      updated: aggregate.session.time.updated,
      messages: aggregate.messageCount,
      tools: matchingToolCalls.reduce((acc, call) => acc + call.calls, 0),
      providers: [],
      models: [],
      ...emptyUsage(),
    }
    const sessionProviders = new Set<string>()
    const sessionModels = new Set<string>()

    totalMessages += aggregate.messageCount
    totalTools += sessionUsage.tools
    matchingToolCalls.forEach((call) => {
      addToolCall(toolCalls, call)
      // ToolUsage 是页面总表投影；calls/chars 必须来自同一批已过滤 owner tuple。
      addToolUsage(toolUsage, {
        id: call.toolID,
        count: call.calls,
        inputChars: call.inputChars,
        outputChars: call.outputChars,
        contextTokens: 0,
      })
    })
    aggregate.toolEvents
      .filter((event) => toolEventMatches(event, input))
      .forEach((event) => {
        // context event 使用相同 owner filter，但只贡献估算 token 和逐日趋势。
        addToolContextTokens(toolUsage, event.toolID, event.contextTokens)
        addUsage(getSeriesDaily(toolSeries, event.toolID, event.time), toolEventUsage(event))
      })

    for (const event of aggregate.totalEvents.filter((event) => eventMatches(event, input))) {
      // Request shell 的 requests 为 1、Assistant usage 为 0；由同一事件同时维护总量和小时投影才能闭合。
      if (event.requests > 0) requestsByHour[new Date(event.time).getHours()] += event.requests
      addUsage(total, event)
      addUsage(sessionUsage, event)
      addUsage(getDaily(daily, event.time), event)
    }

    for (const event of aggregate.breakdownEvents.filter((event) => eventMatches(event, input))) {
      addGroup(models, event.modelID, event.modelID, event)
      addGroup(providers, event.providerID, event.providerID, event)
      addGroup(agents, event.agent, event.agent, event)
      addGroup(sources, event.source, event.source, event)
      // 无 request provenance 的 legacy/cutoff usage 单列，不能与真实 outcome 共用请求分母。
      const outcome = event.outcome ?? "unattributed"
      addGroup(statuses, outcome, outcome, event)
      addGroup(projects, event.projectID, projectIdentities.get(event.projectID)?.label ?? event.projectID, event)
      addUsage(getSeriesDaily(modelSeries, event.modelID, event.time), event)
      addUsage(getSeriesDaily(providerSeries, event.providerID, event.time), event)
      addUsage(getSeriesDaily(agentSeries, event.agent, event.time), event)
      addUsage(getSeriesDaily(sourceSeries, event.source, event.time), event)
      addUsage(getSeriesDaily(statusSeries, outcome, event.time), event)
      addUsage(getSeriesDaily(projectSeries, event.projectID, event.time), event)
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
  // 有显式窗口时以今天为末日；all-time 才以真实数据首尾确定范围。
  // 空数据库使用 fallback 日期，确保仍能返回结构完整的报告。
  const latest = requestedWindow ? dayStart(Date.now()) : dayStart((sortedDaily.at(-1)?.day ?? fallbackLatest) || fallbackEarliest)
  const earliest = requestedWindow
    ? shiftDay(latest, -(requestedWindow - 1))
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
    projects: finalizeGroups(projects).map((group) => ({
      ...group,
      // 聚合 identity 与 group 使用同一 id；缺失元数据时 path 为空而 label 仍保留 id。
      path: projectIdentities.get(group.id)?.path ?? "",
    })),
    daily: completeDaily,
    requestsByHour,
    modelSeries: finalizeSeries(modelSeries, completeDaily),
    providerSeries: finalizeSeries(providerSeries, completeDaily),
    agentSeries: finalizeSeries(agentSeries, completeDaily),
    sourceSeries: finalizeSeries(sourceSeries, completeDaily),
    statusSeries: finalizeSeries(statusSeries, completeDaily),
    projectSeries: finalizeSeries(projectSeries, completeDaily).map((series) => ({
      ...series,
      // series id 保持 project ID，只替换读者可见名称，筛选与趋势关联不会失配。
      label: projectIdentities.get(series.id)?.label ?? series.label,
    })),
    toolSeries: finalizeSeries(toolSeries, completeDaily),
    tokenPartSeries: tokenPartSeries(completeDaily),
    sessions: sessionsWithUsage.sort((a, b) => b.tokens.total - a.tokens.total || b.cost - a.cost),
    toolUsage: Object.values(toolUsage)
      .sort((a, b) => b.contextTokens - a.contextTokens || b.count - a.count),
    // 复合 tuple 按调用量稳定排序，renderer 可直接构建 issuing runtime mix 而无需重新扫 Message。
    toolCalls: Array.from(toolCalls.values()).sort((a, b) => b.calls - a.calls || b.durationMs - a.durationMs),
    tokensPerSession: sessionsWithUsage.length > 0 ? total.tokens.total / sessionsWithUsage.length : 0,
    medianTokensPerSession,
  } satisfies StatsReport
})
