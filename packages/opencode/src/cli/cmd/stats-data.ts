// #180：SQL 会话预过滤 + 工具事件单遍生成
import { DateTime, Effect, Schema } from "effect"
import { MessageID } from "@/session/schema"
import { Session } from "@/session/session"
// #174：assistant 表优先费用
// #174：request 表补次数
// #174：request 行只补次数
import { RequestUsageAssistantTable, RequestUsageTable } from "@opencode-ai/core/session/request-usage.sql"
// #174：NotFound 变空数组
// #174：单会话 NotFound 降级为空数组，不中断整批
// #174：单会话缺失降级为空，不中断整批
import { Database } from "@opencode-ai/core/database/database"
import { and, gte, inArray, sql } from "drizzle-orm"
// #174：SessionTable 只用于枚举，不在此写用量
import { MessageTable, PartTable, SessionTable, SessionMessageTable, type PartColdStats } from "@opencode-ai/core/session/sql"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { ColdStorage } from "@opencode-ai/core/storage/cold-storage"
import type { Project } from "@/project/project"
// #483：Project 身份读取——project group 的 label/path 来自存储行，不再用裸 ID 展示
import { ProjectTable } from "@opencode-ai/core/project/sql"
import type { SessionID } from "@/session/schema"

// #174：MICROS 定义存库到显示的换算
// #174：费用以微美元存库，显示只除一次 1e6
const MICROS = 1_000_000
// #483：自然日运算改用 shiftDay 日历语义，固定 24h 常数已无消费方

// #483：用户数据只替换会控制终端布局的控制字符；shell 元字符不进执行路径，应原样显示
const displayText = (value: string) => value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").trim()

// #483：project 身份解析——名称与路径都来自用户数据，控制字符已清洗；
// id 是唯一关联键：同名项目不会被合并，缺失元数据时 label 回退路径末段再到裸 id
const projectIdentity = (
  id: string,
  row: { name: string | null; worktree: string } | undefined,
  directory: string | undefined,
) => {
  const projectPath = displayText(row?.worktree ?? directory ?? "")
  // 数据库可跨操作系统复制；同时识别两种分隔符，避免把 Windows 路径整段当作名称
  const label = displayText(row?.name ?? "") || displayText(projectPath.split(/[\\/]/).filter(Boolean).at(-1) ?? "") || id
  return { label, path: projectPath }
}

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

// #483：ProjectUsage 携带可识别展示路径；project id 继续承担过滤和 series 关联，不能互换
export type ProjectUsage = UsageGroup & {
  path: string
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

// #483：工具调用归因——toolID 是真实 ToolPart 名称；其余维度描述拥有该 ToolPart 的 Assistant 运行时
export type ToolCallAttribution = {
  toolID: string
  modelID: string
  providerID: string
  agent: string
  projectID: string
  // source/status 来自关联请求；无法关联的历史记录必须显式标为 unattributed/unknown
  source: string
  status: string
  // calls 与字符数是 ToolPart footprint，不能解释为计费 token 或费用
  calls: number
  inputChars: number
  outputChars: number
  // errors/duration 描述工具执行本身，与 owning request 的健康指标相互独立
  errors: number
  durationMs: number
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
  projects: ProjectUsage[]
  agentSeries: UsageSeries[]
  sourceSeries: UsageSeries[]
  statusSeries: UsageSeries[]
  projectSeries: UsageSeries[]
  // 工具发起方按调用计量；模型和供应商的token组合仍由UsageGroup明细提供。
  toolCalls: ToolCallAttribution[]
  // #177：工具上下文 token 时间序列
  toolSeries: UsageSeries[]
  // #483：24 槽使用 RequestUsage.time_created 的本地小时；只计 request shell，不重复计算 Assistant rows
  requestsByHour: number[]
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
  // #483：Request outcome 与 Assistant 自身状态可能不同；健康筛选和 Status 页面必须以前者为准
  outcome?: string
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
  // #483：逐调用归因 tuple，聚合层按 owner 过滤后再投影 ToolUsage
  toolCalls: ToolCallAttribution[]
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
// #483：汇总只依赖数值字段，不要求伪造 session/provider 等身份；这也避免非法品牌值进入运行时
const addUsage = (target: UsageTotals, event: UsageTotals) => {
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
// #177：分组默认按 tokens 排序，cost 作次键
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
    .sort((a, b) => b.tokens.total - a.tokens.total || b.cost - a.cost)

// #174：dayStart 对齐本地日界
const dayStart = (time: number) => {
  const date = new Date(time)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

// #174：dateLabel 供轴标签
// #183：与 dayStart 同用本地日界，MM-DD 避免 locale 月名撑列
export const dateLabel = (time: number) => {
  // #183：本地月日两位零填充（禁止 getUTC*，否则非 UTC 时区日前移）
  const d = new Date(time)
  const mm = String(d.getMonth() + 1).padStart(2, "0")
  const dd = String(d.getDate()).padStart(2, "0")
  return `${mm}-${dd}`
}

// #483：本地日历加减而非固定毫秒，跨 DST 时仍保持在目标自然日零点；正反方向遵守同一日历语义
const shiftDay = (time: number, amount: number) => {
  const date = new Date(time)
  date.setDate(date.getDate() + amount)
  return dayStart(date.getTime())
}

// #176：稠密日轴：窗口内逐日生成零基桶，保证空闲日连续
const buildDayBuckets = (start: number, end: number) => {
  const startDay = dayStart(start)
  const endDay = dayStart(Math.max(startDay, end))
  // #483：自然日不能用固定 24 小时递增；跨 DST 时一天可能是 23 或 25 小时
  const days: DailyUsage[] = []
  for (const date = new Date(startDay); date.getTime() <= endDay; date.setDate(date.getDate() + 1)) {
    const day = dayStart(date.getTime())
    days.push({ day, label: dateLabel(day), ...emptyUsage() })
  }
  return days
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
          // #483：addUsage 只读数值字段，直接传日点即可，无需合成伪身份事件
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

// #174：getAllSessions 必须调用
// #174：必须调用 getAllSessions，经 Database.Service 读表
// #174：必须调用 Effect.fn 枚举会话
// #174：getAllSessions 通过 Database.Service 拉取会话列表
// #180：按 cutoff 下推 SQL，减少全表 session 扫描
const getSessions = Effect.fnUntraced(function* (cutoff: number) {
  const { db } = yield* Database.Service
  // #180：cutoff=0 表示全历史，仍走全表扫描
  const rows =
    cutoff > 0
      ? yield* db
          .select()
          .from(SessionTable)
          // #180：time_updated 与 days 窗口同口径
          .where(gte(SessionTable.time_updated, cutoff))
          .all()
          .pipe(Effect.orDie)
      : yield* db.select().from(SessionTable).all().pipe(Effect.orDie)
  return rows.map((row) => Session.fromRow(row))
})

// #483：一次批量读取即可覆盖所有聚合行，避免在 project group 循环中形成 N+1 查询
const getProjects = Effect.fnUntraced(function* () {
  const { db } = yield* Database.Service
  // 统计只展示历史原文；跨系统路径不经过本机AbsolutePath解码，不改变写入或文件访问校验。
  return yield* db
    .select({ id: ProjectTable.id, name: ProjectTable.name, worktree: sql<string>`${ProjectTable.worktree}` })
    .from(ProjectTable)
    .all()
    .pipe(Effect.orDie)
})

// #174：cutoffFromDays 解释 0/缺省/正数
const cutoffFromDays = (days?: number) => {
  if (days === undefined) return 0
// #174：显式 0 天取今日本地零点，不是空窗口
  if (days === 0) return dayStart(Date.now())
  // #483：正数 N 包含今天在内的 N 个完整自然日；cutoff 是闭区间起点，需要回退 N-1 天
  return shiftDay(Date.now(), -(days - 1))
}

// #174：windowDays 避免除零
// #483：bucket 数与 cutoff 共享同一语义，防止总计覆盖范围大于图表日期范围
const windowDays = (days?: number): number | undefined => {
  if (days === undefined) return undefined
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
      parentID?: MessageID
      agent?: string
      cost: number
      tokens: TokenTotals
      parts: StatsPart[]
    }

// #0500：内部 scalar snapshot 不导出，公开 StatsReport schema 不因存储优化改变。
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

function append<K, V>(map: Map<K, V[]>, key: K, value: V) {
  const values = map.get(key)
  if (values) values.push(value)
  else map.set(key, [value])
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
  // #483：有 owning request 时按最终结果过滤，避免 error request 中已完成的 Assistant usage 被提前丢弃
  textMatches(event.outcome ?? event.status, input.statusFilter)

// #483：owner tuple 过滤与 toolUsage 投影使用同一谓词，
// 避免页面总数与会话计数因两套匹配规则而分母漂移
const toolCallMatches = (call: ToolCallAttribution, input: StatsFilter) =>
  textMatches(call.toolID, input.toolFilter) &&
  textMatches(call.modelID, input.modelFilter) &&
  textMatches(call.providerID, input.providerFilter) &&
  textMatches(call.source, input.sourceFilter) &&
  textMatches(call.agent, input.agentFilter) &&
  textMatches(call.status, input.statusFilter)

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

// #483：复合 owner 键保留发起方，不能先按 toolID 合并后再反推模型、Agent 或 Project 占比
const addToolCall = (map: Map<string, ToolCallAttribution>, call: ToolCallAttribution) => {
  const key = [call.projectID, call.agent, call.providerID, call.modelID, call.source, call.status, call.toolID].join("\0")
  const item = map.get(key) ?? { ...call, calls: 0, inputChars: 0, outputChars: 0, errors: 0, durationMs: 0 }
  item.calls += call.calls
  item.inputChars += call.inputChars
  item.outputChars += call.outputChars
  item.errors += call.errors
  item.durationMs += call.durationMs
  map.set(key, item)
}

// #0500：pending/running 没有完整结束时间；调用仍计数，但不能用当前时间伪造耗时。
// start/end 来自 cold 投影与 hot state.time 的同值拷贝。
const toolDuration = (part: StatsToolPart) => {
  if (part.status !== "completed" && part.status !== "error") return 0
  if (part.start === undefined || part.end === undefined) return 0
  return Math.max(0, part.end - part.start)
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
const componentsFromAssistant = (message: StatsMessage | undefined) => {
  const components = emptyComponents()
  for (const part of message?.parts ?? []) {
    if (part.type !== "step-finish") continue
    // #0500：Step components 直接取 cold_stats 同行投影——聚合层不再重算字符分摊。
    addComponents(components, part.components)
  }
  return components
}

const toolEventsFromAssistant = (input: {
  // #176：兼容 Session.WithParts，不绑死 tokens 形状
  message: StatsMessage | undefined
  chars: Map<string, { inputChars: number; outputChars: number }>
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
  const chars = input.chars
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
  assistants: Array<{ message: StatsMessage | undefined; event: { time: number; sessionID: SessionID; projectID: string; providerID: string; modelID: string; source: string; agent: string; status: string } }>,
  visibleMessages: StatsMessage[],
) => {
  const ordered = assistants.filter((item): item is typeof item & { message: StatsMessage } => !!item.message).toSorted((a, b) => a.message.time - b.message.time)
  const messages = visibleMessages.toSorted((a, b) => a.time - b.time)
  const chars = new Map<string, { inputChars: number; outputChars: number }>()
  const events: ToolUsageEvent[] = []
  let index = 0
  // 时间游标只消费每条历史工具一次，保留“创建时间不晚于助手”的原归因边界。
  for (const item of ordered) {
    while (index < messages.length && messages[index].time <= item.message.time) {
      for (const part of messages[index].parts) {
        if (part.type !== "tool" || !part.tool) continue
        const weight = chars.get(part.tool) ?? { inputChars: 0, outputChars: 0 }
        weight.inputChars += part.inputChars
        weight.outputChars += part.outputChars
        chars.set(part.tool, weight)
      }
      index++
    }
    events.push(...toolEventsFromAssistant({ message: item.message, chars, event: item.event }))
  }
  return events
}

// #0500：json_extract 的 NULL/类型漂移统一收敛为有限数值，防止 NaN 坐标进入图表。
const finiteStat = (value: number | undefined) => (typeof value === "number" && Number.isFinite(value) ? value : 0)

// #0500：Stats 读取 selected Session 的 scalar projection，而不是调用 transcript hydration。
// Message SELECT 明确排除 user summary.diffs；Part 只读取 Tool/StepFinish，避免把无关 archive 搬入 JS。
const loadStatsRows = (sessionIDs: SessionID[], cutoff: number) =>
  Effect.gen(function* () {
    const database = yield* Database.Service
    return yield* Database.withSync(database, (sync): StatsRows => {
      // 2000-ID chunk 与 maintenance 上限一致，并绕开 SQLite variable 数量限制。
      const batches = sessionIDs.flatMap((_, index) =>
        index % ColdStorage.DEFAULT_BATCH_SIZE === 0
          ? [sessionIDs.slice(index, index + ColdStorage.DEFAULT_BATCH_SIZE)]
          : [],
      )
      // SQLite 只提取 Message 标量，大型 summary.diffs 不进入 JavaScript heap。
      const messageRows = batches.flatMap((batch) =>
        sync
          .select({
            id: MessageTable.id,
            sessionID: MessageTable.session_id,
            time: MessageTable.time_created,
            role: sql<string>`json_extract(${MessageTable.data}, '$.role')`,
            parentID: sql<string | null>`json_extract(${MessageTable.data}, '$.parentID')`,
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
        sync
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
      const projections = ColdStorage.inspectPartStats(sync, partRows)
      const parts = new Map<MessageID, StatsPart[]>()
      partRows.forEach((row, index) => {
        // discriminator 不匹配立即失败，不能丢弃异常 Part 后返回不完整报告。
        const projection = projections[index]
        if (row.data.type === "step-finish") {
          if (projection?.type !== "step-finish") throw new Error("Stats Step projection is unavailable: " + row.id)
          append(parts, row.message_id, projection)
          return
        }
        if (row.data.type !== "tool") throw new Error("Stats query returned an unsupported Part: " + row.id)
        if (projection?.type !== "tool") throw new Error("Stats Tool projection is unavailable: " + row.id)
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
          throw new Error("Stats Message projection is invalid: " + row.id)
        }
        append(messages, row.sessionID, {
          id: row.id,
          time: row.time,
          role: "assistant",
          providerID: row.providerID,
          modelID: row.modelID,
          agent: row.agent,
          ...(row.parentID ? { parentID: MessageID.make(row.parentID) } : {}),
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

      // attribution 两表同样分块读取，替代原先每 Session 两次 SQL 的 N+1 往返。
      const requests = new Map<SessionID, (typeof RequestUsageTable.$inferSelect)[]>()
      const assistants = new Map<SessionID, (typeof RequestUsageAssistantTable.$inferSelect)[]>()
      for (const batch of batches) {
        for (const row of sync.select().from(RequestUsageTable).where(inArray(RequestUsageTable.session_id, batch)).all()) {
          append(requests, row.session_id, row)
        }
        for (const row of sync
          .select()
          .from(RequestUsageAssistantTable)
          .where(inArray(RequestUsageAssistantTable.session_id, batch))
          .all()) {
          append(assistants, row.session_id, row)
        }
      }
      // Native沿同一只读冷统计入口取字符投影，身份、模型和精确账本关联仍由原消息承担。
      const legacyIDs = new Set(messageRows.map((row) => String(row.id)))
      for (const batch of batches) {
        const projected = sync.select().from(SessionMessageTable).where(inArray(SessionMessageTable.session_id, batch)).all()
          .filter(row => !legacyIDs.has(row.id) && (row.type === "assistant" || row.type === "user") && includeTime(cutoff, row.time_created))
        const nativeStats = ColdStorage.inspectSessionMessageStats(sync, projected)
        for (const [rowIndex, row] of projected.entries()) {
          const message = Schema.decodeUnknownSync(SessionMessage.Message)({ ...row.data, id: row.id, type: row.type })
          const id = MessageID.make(row.id)
          if (message.type !== "assistant") {
            append(messages, row.session_id, { id, time: row.time_created, role: "user", parts: [] })
            continue
          }
          const parts: StatsPart[] = message.content.flatMap((part, contentIndex): StatsToolPart[] => {
            if (part.type !== "tool") return []
            const state = part.state
            const projection = nativeStats[rowIndex]?.tools[String(contentIndex)]
            if (!projection) throw new Error("Native Stats Tool projection is unavailable: " + row.id)
            return [{ version: 1, type: "tool", tool: part.name, status: state.status, ...projection,
              start: DateTime.toEpochMillis(part.time.ran ?? part.time.created),
              end: DateTime.toEpochMillis(part.time.completed ?? part.time.ran ?? part.time.created),
            }]
          })
          const estimate = message.inputEstimate
          const step = estimate?.confirmed ? ColdStorage.projectPartStats({ type: "step-finish", reason: "stop",
            tokens: normalizeTokens(message.tokens ?? emptyTokens()), cost: message.cost ?? 0, inputChars: estimate.bodyChars, inputBreakdown: estimate.inputBreakdown }) : undefined
          if (step?.type === "step-finish") parts.push(step)
          // 同 ID 投影只保留一份；parent 仍从精确账本取得，混合历史不会按相邻时间猜测归属。
          append(messages, row.session_id, { id, time: row.time_created, role: "assistant", parts,
            providerID: message.model.providerID, modelID: message.model.id, tokens: normalizeTokens(message.tokens ?? emptyTokens()), cost: message.cost ?? 0,
            parentID: assistants.get(row.session_id)?.find((usage) => usage.assistant_message_id === id)?.request_id,
          })
        }
      }
      for (const rows of messages.values()) rows.sort((a, b) => a.time - b.time || a.id.localeCompare(b.id))
      return { messages, requests, assistants } satisfies StatsRows
    })
  })

// #180：SQL 会话预过滤 + 工具事件单遍生成
const aggregateSession = (session: Session.Info, cutoff: number, rows: StatsRows) => {
  // #0500：visibleMessages 来自 loader 的 scalar snapshot——loader 不提前按 model/tool/status 改变分母。
  const visibleMessages = (rows.messages.get(session.id) ?? []).filter((message) => includeTime(cutoff, message.time))
  const requestUsageRows = rows.requests.get(session.id) ?? []
  const assistantUsageRows = rows.assistants.get(session.id) ?? []
  // #483：ToolPart ownership 与 context consumption 在同一次 Message 扫描中建立，避免第二次读取 Session；
  // 两个索引都以原始行为准，cutoff 只影响事件投影不影响 ownership 关联
  const storedRequestsByID = new Map(requestUsageRows.map((row) => [row.request_id, row]))
  const assistantUsageByMessageID = new Map(assistantUsageRows.map((row) => [row.assistant_message_id, row]))
  const toolCalls: ToolCallAttribution[] = []
  for (const message of visibleMessages) {
    if (message.role !== "assistant") continue
    const assistant = assistantUsageByMessageID.get(message.id)
    const request = assistant ? storedRequestsByID.get(assistant.request_id) : undefined
    // #483：有 request 数据却找不到 Assistant row 通常是 fork/cutoff 历史，不能猜测它原属哪个请求；
    // source 三态：assistant-row 归因 > unattributed（有 request 体系但断链）> legacy-message（无 request 体系）
    const source = assistant ? request?.source ?? "assistant" : requestUsageRows.length > 0 ? "unattributed" : "legacy-message"
    // #483：status 同样三态——request 终局优先于 assistant 自身状态，
    // legacy completed 仅在无 request 体系时可用，防伪造归因
    const status = assistant ? request?.status ?? assistant.status : requestUsageRows.length > 0 ? "unknown" : "completed"
    for (const part of message.parts) {
      if (part.type !== "tool" || !part.tool) continue
      // #0500：字符/耗时标量来自 cold 投影；errors 按 status 判定，不再序列化 input/output。
      toolCalls.push({
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
      })
    }
  }
  const totalEvents: UsageEvent[] = []
  const breakdownEvents: UsageEvent[] = []

  if (requestUsageRows.length > 0) {
    // #0500：Step components 按 Assistant message ID 关联，不能跨 Assistant 平均再回填模型维度。
// #174：time_created 过滤 usage
    const requestRows = requestUsageRows.filter((row) => includeTime(cutoff, row.time_created))
    const assistantRows = assistantUsageRows.filter((row) => includeTime(cutoff, row.time_created))

    if (assistantRows.length > 0) {
// #174：request_id 用于跳过双计
      const assistantRequests = new Set(assistantRows.map((row) => row.request_id))
      // #176：构造时精确 join：request_id 直接取 request 维，不做时间/模型猜测
      const requestsByID = new Map(requestRows.map((row) => [row.request_id, row]))
      const messagesByID = new Map(visibleMessages.map((message) => [message.id, message]))
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
        // #483：窗口外 request 无法提供最终结果，此时保留 undefined 并由筛选回退 Assistant status
        outcome: request?.status,
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
          outcome: row.status,
          components: emptyComponents(),
          ...statusCounts(row.status, 1),
          durationMs: rowDuration(row),
        }))
      const requestEvents = requestRows.filter((row) => assistantRequests.has(row.request_id)).map((row) => ({
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
          outcome: row.status,
          components: emptyComponents(),
          ...statusCounts(row.status, 1),
          durationMs: rowDuration(row),
        }))
      totalEvents.push(...assistantEvents, ...fallbackRequestEvents, ...requestEvents)
      breakdownEvents.push(...assistantEvents)
      breakdownEvents.push(...fallbackRequestEvents)
      // #483：Shell 只携带一次 request 健康指标；加入 Breakdown 后不能复制给每个 Assistant owner。
      // assistantEvents 的 tokens/cost 已由 assistant 行承担，request shell 只补 requests/errors/duration
      breakdownEvents.push(...requestEvents)
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
        outcome: row.status,
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
    if (message.role !== "assistant") continue
    if (tracked.has(message.id) || (message.parentID && fallbackRequests.has(message.parentID))) continue
    const tokens = message.tokens
    const event = {
      time: message.time,
      sessionID: session.id,
      providerID: message.providerID,
      modelID: message.modelID,
      tokens,
      cost: message.cost,
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
      // #0500：冷投影标量——hot/v1/v2 共用 ColdStorage 公式（INV-20/26）。
      item.inputChars += part.inputChars
      item.outputChars += part.outputChars
    }
  }

  // #180：批量收集 assistant 种子后单遍生成工具上下文事件
  if (requestUsageRows.length > 0) {
    const requestRows = requestUsageRows.filter((row) => includeTime(cutoff, row.time_created))
    const assistantRows = assistantUsageRows.filter((row) => includeTime(cutoff, row.time_created))
    const requestsByID = new Map(requestRows.map((row) => [row.request_id, row]))
    // #180：assistant_message_id → 消息映射，种子在此复用避免二次扫描
    const messagesByID = new Map(visibleMessages.map((message) => [message.id, message]))
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
          // #483：context 归因事件同样采用 request 最终结局，与 owner tuple 口径一致
          status: request?.status ?? row.status,
        },
      }
    })
        // #180：单点推入，避免循环内重复展开逻辑
    toolEvents.push(...toolEventsFromAssistants(seeds, visibleMessages))
  }
  // #176：工具上下文沿用同一助手覆盖集合，混合历史只补未入账消息。
  const seeds = visibleMessages
    .filter((message): message is Extract<StatsMessage, { role: "assistant" }> => message.role === "assistant" && !tracked.has(message.id) && !(message.parentID && fallbackRequests.has(message.parentID)))
    .map((message) => ({
      message,
      event: {
        time: message.time,
        sessionID: session.id,
        projectID: session.projectID,
        providerID: message.providerID,
        modelID: message.modelID,
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

  // #0500：公共 filters 在 aggregate 后统一执行，loader 不提前按 model/tool/status 改变分母。
  return { session, messageCount: visibleMessages.length, toolUsage, toolEvents, toolCalls, totalEvents, breakdownEvents } satisfies SessionAggregate
}

// #174：aggregateStats 唯一写路径
// #174：唯一写 StatsReport 的路径
// #174：aggregateStats 生成只读 StatsReport 快照
export const aggregateStats = Effect.fn("Cli.stats.aggregate")(function* (input: StatsFilter = {}) {
  const cutoff = cutoffFromDays(input.days)
  // #180：聚合入口改用 SQL 预过滤会话，降低全表扫描
  const sessions = yield* getSessions(cutoff)
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
  // #0500：raw snapshot 一次读取，移除旧 concurrency:20 的 per-session hydration/N+1。
  const rows = yield* loadStatsRows(filteredSessions.map((session) => session.id), cutoff)
  // loader/inspect 均无写入，v1 decode 也不会清 owner/ref 或补写 cold_stats。
  const aggregates = filteredSessions.map((session) => aggregateSession(session, cutoff, rows))
  // #0500：toolFilter 保持原公开过滤顺序，在完整 Session toolUsage 形成后才筛选。

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
  // #483：工具调用归因按复合 owner tuple 聚合；小时投影只计 request shell
  const toolCalls = new Map<string, ToolCallAttribution>()
  const requestsByHour = Array.from({ length: 24 }, () => 0)
  const agentSeries = new Map<string, Map<number, DailyUsage>>()
  const sourceSeries = new Map<string, Map<number, DailyUsage>>()
  const statusSeries = new Map<string, Map<number, DailyUsage>>()
  const projectSeries = new Map<string, Map<number, DailyUsage>>()
  // 编号矩阵退役；token portfolio继续使用各UsageGroup的models/providers明细。
  // #177：按日累加工具 contextTokens
  const toolSeries = new Map<string, Map<number, DailyUsage>>()
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

  // #483：查询结果只作显示索引；显式 string 键避免 branded ProjectID 泄漏到通用统计类型
  const projectRows = new Map<string, { name: string | null; worktree: string }>(
    (yield* getProjects()).map((row) => [row.id, row] as const),
  )
  // #483：代表性 Session directory 仅在 Project row 缺失时回退，不参与 project filter；
  // 同一 project 多 Session 时取任一目录即可，display 身份不要求目录唯一
  const projectDirectories = new Map<string, string>(
    filteredAggregates.map((aggregate) => [aggregate.session.projectID, aggregate.session.directory] as const),
  )
  // #483：每个 project 只解析一次安全 display identity；
  // group 与 series 共享同一解析结果，两处名称永远不会互不相配
  const projectIdentities = new Map<string, { label: string; path: string }>(
    Array.from(new Set(filteredAggregates.map((aggregate) => aggregate.session.projectID))).map((id) => [
      id,
      projectIdentity(id, projectRows.get(id), projectDirectories.get(id)),
    ]),
  )

  for (const aggregate of filteredAggregates) {
    // #483：先过滤 owner tuple，再同时生成 Session、总调用量和 ToolUsage，三者分母必须一致；
    // toolFilter 命中判定从“工具名子串”升级为全 tuple 匹配，未命中 owner 的工具不再进榜
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
    // #483：ToolUsage 是页面总表投影；calls/chars 必须来自同一批已过滤 owner tuple
    matchingToolCalls.forEach((call) => {
      addToolCall(toolCalls, call)
      addToolUsage(toolUsage, {
        id: call.toolID,
        count: call.calls,
        inputChars: call.inputChars,
        outputChars: call.outputChars,
        contextTokens: 0,
      })
    })
    // #176：上下文 token 由 toolEvents 叠加，避免与 count 双计字符
    aggregate.toolEvents
      .filter((event) => toolEventMatches(event, input))
      // #177：工具事件同时更新用量与序列
      .forEach((event) => {
        addToolContextTokens(toolUsage, event.toolID, event.contextTokens)
        // #177：工具事件写入日序列（tokens.total 承载 contextTokens）
        const point = getSeriesDaily(toolSeries, event.toolID, event.time)
        // #177：日点 tokens.total 承载 context
        point.tokens.total += event.contextTokens
        point.tokens.input += event.contextTokens
        // 工具上下文不是新的提供者请求，保持 source 的零请求/零费用口径。
      })

    for (const event of aggregate.totalEvents.filter((event) => eventMatches(event, input))) {
      // #483：Request shell 的 requests 为 1、Assistant usage 为 0；由同一事件同时维护总量和小时投影才能闭合；
      // 时间取 RequestUsage.time_created 的本地小时，与行内健康指标同一时间戳
      if (event.requests > 0) requestsByHour[new Date(event.time).getHours()] += event.requests
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
      // #483：无 request provenance 的 legacy/cutoff usage 单列为 unattributed；
      // 与真实 outcome 共用分母会让 Status 页的完成率凭空变好
      const outcome = event.outcome ?? "unattributed"
      addGroup(statuses, outcome, outcome, event)
      // #483：project 分组 label 使用解析后的 display identity
      addGroup(projects, event.projectID ?? aggregate.session.projectID, projectIdentities.get(event.projectID ?? aggregate.session.projectID)?.label ?? event.projectID ?? aggregate.session.projectID, event)
      addUsage(getSeriesDaily(modelSeries, event.modelID, event.time), event)
      addUsage(getSeriesDaily(providerSeries, event.providerID, event.time), event)
      addUsage(getSeriesDaily(agentSeries, event.agent ?? "unknown", event.time), event)
      addUsage(getSeriesDaily(sourceSeries, event.source ?? "unknown", event.time), event)
      addUsage(getSeriesDaily(statusSeries, event.outcome ?? "unattributed", event.time), event)
      addUsage(getSeriesDaily(projectSeries, event.projectID ?? aggregate.session.projectID, event.time), event)
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
  // #483：显式窗口以今天为末日；all-time 才用真实数据首尾确定范围；
  // 空数据库使用 fallback 日期，保证报告结构完整而不是抛错
  const requestedWindow = windowDays(input.days)
  const latest = requestedWindow ? dayStart(Date.now()) : dayStart((sortedDaily.at(-1)?.day ?? fallbackLatest) || fallbackEarliest)
  const earliest = requestedWindow
    ? shiftDay(latest, -(requestedWindow - 1))
    : dayStart(sortedDaily.at(0)?.day ?? fallbackEarliest)
  const completeDaily = buildDayBuckets(earliest, latest).map((day) => daily.get(day.day) ?? day)
  const effectiveDays = completeDaily.length
  const sortedSessionTotals = sessionTokenTotals.sort((a, b) => a - b)
  // #483：中位数抗长尾——大会话不能拉高典型会话的基准；偶数样本取中间两数均值
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
    // #483：聚合 identity 与 group 使用同一 id；缺失元数据时 path 为空而 label 仍保留 id，
    // renderer 依据空 path 省略路径后缀而不是输出空分隔符
    projects: finalizeGroups(projects).map((group) => ({ ...group, path: projectIdentities.get(group.id)?.path ?? "" })),
    daily: completeDaily,
    // #483：小时投影随报告输出，供 Dashboard 时段分布直接消费
    requestsByHour,
    modelSeries: finalizeSeries(modelSeries, completeDaily),
    providerSeries: finalizeSeries(providerSeries, completeDaily),
    agentSeries: finalizeSeries(agentSeries, completeDaily),
    sourceSeries: finalizeSeries(sourceSeries, completeDaily),
    statusSeries: finalizeSeries(statusSeries, completeDaily),
    // #483：series id 保持 project ID，只替换读者可见名称；
    // 若同步改 id，历史图表与 --project 筛选都会失配
    projectSeries: finalizeSeries(projectSeries, completeDaily).map((series) => ({
      ...series,
      label: projectIdentities.get(series.id)?.label ?? series.label,
    })),
    tokenPartSeries: tokenPartSeries(completeDaily),
    sessions: sessionsWithUsage.sort((a, b) => b.tokens.total - a.tokens.total || b.cost - a.cost),
    // #176：默认按 contextTokens 再按 count
    // #176：工具榜优先 contextTokens 体现归因
    toolUsage: Object.values(toolUsage).sort((a, b) => b.contextTokens - a.contextTokens || b.count - a.count),
    // #176：模型×供应矩阵供热图/对比
    // #177：输出 toolSeries 供渲染
    toolSeries: finalizeSeries(toolSeries, completeDaily),
    // #483：复合 tuple 按调用量稳定排序，renderer 可直接构建 issuing runtime mix 而无需重新扫 Message
    toolCalls: Array.from(toolCalls.values()).sort((a, b) => b.calls - a.calls || b.durationMs - a.durationMs),
    tokensPerSession: sessionsWithUsage.length > 0 ? total.tokens.total / sessionsWithUsage.length : 0,
    medianTokensPerSession,
  } satisfies StatsReport
})
