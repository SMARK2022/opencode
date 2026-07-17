import { makeGlobalNode } from "../effect/app-node"
import { Database } from "../database/database"
import { Context, Effect, Layer, Schema } from "effect"
import { optional } from "../schema"
import { SessionV1, MessageID } from "../v1/session"
import { and, desc, eq, lt, sql } from "drizzle-orm"
import { RequestUsageTable, RequestUsageAssistantTable } from "./request-usage.sql"
import { MessageTable, PartTable } from "./sql"
import type { SessionSchema } from "./schema"
type SessionID = SessionSchema.ID

// 来源标识实际入口，command/shell 不由 agent 名称推断；unknown 仅承载缺失 begin 的异常记录。
export type Source = "prompt" | "command" | "shell" | "system_compaction" | "system_continue" | "unknown"

// running 包含已接纳但尚未执行的输入；error 与 aborted 分别标识 provider 故障和用户中断。
export type Status = "running" | "completed" | "error" | "aborted"

// 五类用量互不重叠；input 不含缓存，output 不含 reasoning。
// total 保留 provider 总量，缺失时才把五类相加，避免重复计算缓存或推理。
export type Tokens = {
  input: number
  output: number
  reasoning: number
  cache: { read: number; write: number }
  total: number
}

// 请求 ID 是用户输入身份，多个工具续轮共享同一行；不以 drain 当作请求。
// 根请求保留因果链，不能代替当前 requestID 参与主键或汇总过滤。
export type Request = typeof RequestUsageSchema.Type

// 助手 ID 作为快照身份，重试同一结算不增加调用次数。
// 模型明细保留每个助手的 provider/model/variant，不能被请求行最终模型覆盖。
export type Assistant = typeof AssistantUsageSchema.Type

export interface Interface {
  // 复用请求只更新当前执行描述与状态，不能抹掉原创建时间和根身份。
  readonly begin: (input: {
    sessionID: SessionID
    requestID: MessageID
    // 压缩与系统继续保留独立来源，调用链仍通过 rootRequestID 关联。
    rootRequestID?: MessageID
    source: Source
    agent: string
    providerID: string
    modelID: string
    variant?: string
    timeCreated?: number
  }) => Effect.Effect<void>
  // V1/V2 的差异仅在输入适配，明细 upsert 和请求求和共用一个实现。
  readonly recordAssistant: (input: {
    sessionID: SessionID
    requestID: MessageID
    assistant: Pick<SessionV1.Assistant, "id" | "agent" | "providerID" | "modelID" | "variant" | "time" | "error">
    // 原生 V2 每个助手就是一个 provider step；V1 仍从持久化 parts 重建全部 step。
    usage?: { count: number; tokens: Tokens; costMicros: number }
  }) => Effect.Effect<void>
  // shell/noReply 没有 step-finish，也需要显式完成零用量请求。
  readonly complete: (input: {
    sessionID: SessionID
    requestID: MessageID
    status?: Status
    error?: string
    timeCompleted?: number
  }) => Effect.Effect<void>
  // 读取缺失返回 undefined，由 HTTP 边界翻译为 404；SQL 失败仍是缺陷。
  readonly get: (input: { sessionID: SessionID; requestID: MessageID }) => Effect.Effect<Request | undefined>
  // 保留 source 的数字时间游标及根请求过滤，不擅自改成 opaque cursor。
  readonly list: (input: {
    sessionID: SessionID
    limit?: number
    before?: number
    rootRequestID?: MessageID
    source?: Source
  }) => Effect.Effect<Request[]>
  // 请求明细不分页，必须返回所有模型与续轮助手以便核对汇总。
  readonly assistants: (input: { sessionID: SessionID; requestID: MessageID }) => Effect.Effect<Assistant[]>
}

// HTTP 与 SQL 共用闭合枚举类型，拒绝任意伪造来源或另一套状态词汇。
export const SourceSchema = Schema.Literals(["prompt", "command", "shell", "system_compaction", "system_continue", "unknown"])
export const StatusSchema = Schema.Literals(["running", "completed", "error", "aborted"])
// model/time 必须嵌套，rootRequestID 必须存在，已发布接口不能被扁平化。
// source 的 error 是可选字符串；编码时省略 undefined，不能把无错误响应变成 error:null。
export const RequestUsageSchema = Schema.Struct({
  sessionID: Schema.String, requestID: MessageID, rootRequestID: MessageID,
  source: SourceSchema, status: StatusSchema, agent: Schema.String,
  // SQL NULL 映射成显式 undefined；模型可选键需编码时省略，不能扩大 wire 为 nullable。
  model: Schema.Struct({ providerID: Schema.String, modelID: Schema.String, variant: optional(Schema.String) }),
  tokens: Schema.Struct({ input: Schema.Number, output: Schema.Number, reasoning: Schema.Number, cache: Schema.Struct({ read: Schema.Number, write: Schema.Number }), total: Schema.Number }),
  // Schema 编码保持 source wire 形状，snake_case 和微美元只留在数据库边界。
  cost: Schema.Number, time: Schema.Struct({ created: Schema.Number, updated: Schema.Number, completed: optional(Schema.Number) }),
  // assistantCount 与 stepCount 独立：V1 单助手可能包含多个 step。
  assistantCount: Schema.Number, stepCount: Schema.Number, error: optional(Schema.String),
})
// wire 身份保留 assistantMessageID，不把已有客户端字段改名成 assistantID。
export const AssistantUsageSchema = Schema.Struct({
  sessionID: Schema.String, requestID: MessageID, assistantMessageID: MessageID, rootRequestID: MessageID,
  model: Schema.Struct({ providerID: Schema.String, modelID: Schema.String, variant: optional(Schema.String) }),
  status: StatusSchema, stepCount: Schema.Number, error: optional(Schema.String),
  tokens: Schema.Struct({ input: Schema.Number, output: Schema.Number, reasoning: Schema.Number, cache: Schema.Struct({ read: Schema.Number, write: Schema.Number }), total: Schema.Number }),
  // 未完成助手省略时间键；helper 仅过滤 undefined，合法 completed=0 继续原值输出。
  cost: Schema.Number, time: Schema.Struct({ created: Schema.Number, updated: Schema.Number, completed: optional(Schema.Number) }),
})

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionRequestUsage") {}

// 公开 cost 是美元，整数微美元仅在读出时换算一次，HTTP handler 不重复换算。
const toCost = (micros: number) => micros / 1_000_000
// 每个 provider step 单独舍入为整数微美元，随后跨助手只做整数求和。
const toMicros = (cost: number) => Math.round(cost * 1_000_000)

// 每次归约使用新缓存对象，不能让一个请求的累计污染另一个请求。
const emptyTotals = (): Tokens => ({
  input: 0,
  output: 0,
  reasoning: 0,
  cache: { read: 0, write: 0 },
  total: 0,
})

// 已有账本只映射存储字段；旧历史只读归约，不补写账本或改变请求状态。
function stepUsage(parts: ReadonlyArray<Schema.Schema.Type<typeof SessionV1.Part>>, fallback?: SessionV1.Assistant) {
  const steps = parts.filter(part => part.type === "step-finish")
  // 没有finish的已完成旧消息仍保留原tokens/cost；不能覆盖真实多step确认值。
  if (steps.length === 0 && fallback?.time.completed !== undefined) {
    const tokens = fallback.tokens
    return { count: 1, costMicros: toMicros(fallback.cost), tokens: { ...tokens, total: tokens.total ?? (tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write) } }
  }
  return steps.reduce((acc, part) => ({
    count: acc.count + 1,
    tokens: {
      input: acc.tokens.input + part.tokens.input,
      output: acc.tokens.output + part.tokens.output,
      reasoning: acc.tokens.reasoning + part.tokens.reasoning,
      cache: { read: acc.tokens.cache.read + part.tokens.cache.read, write: acc.tokens.cache.write + part.tokens.cache.write },
      total: acc.tokens.total + (part.tokens.total ?? (part.tokens.input + part.tokens.output + part.tokens.reasoning + part.tokens.cache.read + part.tokens.cache.write)),
    },
    // 每个step分别舍入为微美元，不能按当前模型重新定价历史费用。
    costMicros: acc.costMicros + toMicros(part.cost ?? 0),
  }), { count: 0, tokens: emptyTotals(), costMicros: 0 })
}

const rowToRequest = (row: typeof RequestUsageTable.$inferSelect): Request => ({
  sessionID: row.session_id,
  requestID: row.request_id,
  rootRequestID: row.root_request_id,
  source: row.source,
  status: row.status,
  agent: row.agent,
  // 可选字段的 NULL 统一映射为 undefined，公开 JSON 不暴露数据库的 NULL 表示。
  model: { providerID: row.provider_id, modelID: row.model_id, variant: row.variant ?? undefined },
  assistantCount: row.assistant_count,
  stepCount: row.step_count,
  tokens: { input: row.tokens_input, output: row.tokens_output, reasoning: row.tokens_reasoning,
    cache: { read: row.tokens_cache_read, write: row.tokens_cache_write }, total: row.tokens_total },
  cost: toCost(row.cost_micros), error: row.error_message ?? undefined,
  time: { created: row.time_created, updated: row.time_updated, completed: row.time_completed ?? undefined },
})

// 助手用量来自独立明细，不从请求汇总反推各模型的费用。
const rowToAssistant = (row: typeof RequestUsageAssistantTable.$inferSelect): Assistant => ({
  sessionID: row.session_id,
  requestID: row.request_id,
  assistantMessageID: row.assistant_message_id,
  rootRequestID: row.root_request_id,
  status: row.status,
  model: { providerID: row.provider_id, modelID: row.model_id, variant: row.variant ?? undefined },
  stepCount: row.step_count,
  tokens: { input: row.tokens_input, output: row.tokens_output, reasoning: row.tokens_reasoning,
    cache: { read: row.tokens_cache_read, write: row.tokens_cache_write }, total: row.tokens_total },
  cost: toCost(row.cost_micros), error: row.error_message ?? undefined,
  time: { created: row.time_created, updated: row.time_updated, completed: row.time_completed ?? undefined },
})

// 方法捕获已有 db；projector 复用事件事务，V1 使用全局 db，无额外运行时服务或 Location 需求。
export function make(db: Database.Interface["db"]): Interface {

    const begin: Interface["begin"] = Effect.fn("RequestUsage.begin")(function* (input) {
      // 查询与复用请求也属于原子操作，失败不能留下只有半次 begin 的记录。
      yield* db.transaction(() => Effect.gen(function* () {
      const now = Date.now()
      // 用户消息创建时间决定列表游标，不用调用 begin 的时间替代它。
      const created = input.timeCreated ?? now
      const root = input.rootRequestID ?? input.requestID
      // sessionID 与 requestID 联合隔离，不能只用 messageID 查另一个会话的数据。
      const existing = yield* db
        .select()
        .from(RequestUsageTable)
        .where(and(eq(RequestUsageTable.session_id, input.sessionID), eq(RequestUsageTable.request_id, input.requestID)))
        .get()
        .pipe(Effect.orDie)
      if (!existing) {
        // 零值由表默认值建立，首次接纳无需等到 provider 开始才可被查询。
        yield* db
          .insert(RequestUsageTable)
          .values({
            session_id: input.sessionID,
            request_id: input.requestID,
            root_request_id: root,
            source: input.source,
            status: "running",
            agent: input.agent,
            provider_id: input.providerID,
            model_id: input.modelID,
            variant: input.variant,
            time_created: created,
            time_updated: now,
          })
          .pipe(Effect.orDie)
      } else {
        // 已存在请求允许继续执行，清除终态但保留历史计费快照。
        // 首次根身份不可被重试覆盖，variant 缺失也沿用 source 的字段更新规则。
        yield* db
          .update(RequestUsageTable)
          .set({
            root_request_id: existing.root_request_id || root,
            source: input.source,
            agent: input.agent,
            provider_id: input.providerID,
            model_id: input.modelID,
            variant: input.variant,
            status: "running",
            time_updated: now,
            time_completed: null,
            error_message: null,
          })
          .where(and(eq(RequestUsageTable.session_id, input.sessionID), eq(RequestUsageTable.request_id, input.requestID)))
          .pipe(Effect.orDie)
      }
      // 数据库异常沿用 core 的 orDie 契约，事务失败整体退出。
      })).pipe(Effect.orDie)
    })

    const complete: Interface["complete"] = Effect.fn("RequestUsage.complete")(function* (input) {
      const now = Date.now()
      yield* db
        .update(RequestUsageTable)
        // 显式完成只更新请求状态，不清空已有助手计费或再次增加 stepCount。
        .set({
          status: input.status ?? "completed",
          error_message: input.error ?? null,
          time_updated: now,
          time_completed: input.timeCompleted ?? now,
        })
        // 没有对应请求时 update 是无操作，读取 API 不因此制造新账本行。
        .where(and(eq(RequestUsageTable.session_id, input.sessionID), eq(RequestUsageTable.request_id, input.requestID)))
        .pipe(Effect.orDie)
    })

    function assistantStatus(assistant: Parameters<Interface["recordAssistant"]>[0]["assistant"]): Status {
      // 完成时间零也是合法毫秒值；只有 undefined 表示仍运行，不能用真值判断结算。
      if (assistant.time.completed === undefined) return "running"
      // source 的中断以 MessageAbortedError 标识，原生 V2 在适配边界明确映射。
      if (assistant.error?.name === "MessageAbortedError") return "aborted"
      if (assistant.error) return "error"
      return "completed"
    }

    function errorMessage(error: SessionV1.Assistant["error"]): string | undefined {
      if (!error) return undefined
      // 检查联合类型的 message 字段，缺失时用错误名称诊断，不通过 JSON 字符串猜状态。
      if ("message" in error.data && typeof error.data.message === "string") return error.data.message
      return error.name
    }

    const recordAssistant: Interface["recordAssistant"] = Effect.fn("RequestUsage.recordAssistant")(function* (input) {
      // 助手快照、读求和与请求回写共享事务；中断或 SQL 缺陷都会整体回滚。
      yield* db.transaction(() => Effect.gen(function* () {
      const assistant = input.assistant
      const now = Date.now()
      // V1 parts 只在此持久化适配边界解码；不把数据库 JSON 断言成新执行模型。
      // 原生 V2 已传入单步快照，不读取 V1 parts，也不桥接旧 runner。
      const parts = input.usage ? [] : (yield* db.select().from(PartTable)
        .where(and(eq(PartTable.message_id, assistant.id), eq(PartTable.session_id, input.sessionID)))
        .all().pipe(Effect.orDie)).map(row => Schema.decodeUnknownSync(SessionV1.Part)({
          ...row.data, id: row.id, sessionID: row.session_id, messageID: row.message_id,
        }))
      // V1 多个 step-finish 属于同一助手，不能只取末尾一条结算。
      // 不读取 text/reasoning 字符估算，账本只接受 provider 已确认用量。
      const stepTotals = input.usage ?? stepUsage(parts)
      // 请求归属由调用者持久化身份给定，不能在此猜测最新用户消息。
      // 根身份必须先读请求行，压缩与普通请求即使共用模型也不能混合汇总。
      const requestRow = yield* db.select().from(RequestUsageTable)
        .where(and(eq(RequestUsageTable.session_id, input.sessionID), eq(RequestUsageTable.request_id, input.requestID)))
        .get().pipe(Effect.orDie)
      // 异常缺失 begin 时保持 source 的 self-root unknown 行，不丢已发生的计费。
      const rootRequestID = requestRow?.root_request_id ?? input.requestID
      // 根请求链可被过滤查询，因此快照写入必须使用它而非助手 parentID 的猜测。
      const values = {
        // 状态和错误在同一快照中保存，避免终态费用与另一次重试的错误拼接。
        request_id: input.requestID, root_request_id: rootRequestID, status: assistantStatus(assistant),
        // 模型修订和用量修订必须一起提交，避免模型明细错位。
        provider_id: assistant.providerID, model_id: assistant.modelID, variant: assistant.variant ?? null,
        step_count: stepTotals.count, tokens_input: stepTotals.tokens.input, tokens_output: stepTotals.tokens.output,
        tokens_reasoning: stepTotals.tokens.reasoning, tokens_cache_read: stepTotals.tokens.cache.read,
        tokens_cache_write: stepTotals.tokens.cache.write, tokens_total: stepTotals.tokens.total,
        cost_micros: stepTotals.costMicros, time_completed: assistant.time.completed ?? null,
        error_message: errorMessage(assistant.error) ?? null, time_updated: now,
      }
      yield* db.insert(RequestUsageAssistantTable).values({
        ...values, session_id: input.sessionID, assistant_message_id: assistant.id, time_created: assistant.time.created,
        // 同一助手 upsert 覆盖完整快照，重复结算不递增请求费用，多助手才在请求层相加。
      }).onConflictDoUpdate({
        // 创建时间不在 set 中；重试不能改变游标位置或把旧助手变成新调用。
        target: [RequestUsageAssistantTable.session_id, RequestUsageAssistantTable.assistant_message_id], set: values,
      }).run().pipe(Effect.orDie)
      // 求和必须读取本事务刚写入的助手快照，不能复用写入前缓存。
      // 过滤同时包含会话与请求，子会话或同根压缩费用不能串到当前请求。
      const allAssistants = yield* db
        .select()
        .from(RequestUsageAssistantTable)
        .where(and(eq(RequestUsageAssistantTable.session_id, input.sessionID), eq(RequestUsageAssistantTable.request_id, input.requestID)))
        .all()
        .pipe(Effect.orDie)
      // 重建总量而非追加 delta，重复回调与同一助手修订都保持幂等。
      // 费用只对整数微美元求和，不将多助手浮点美元先相加再舍入。
      const aggregated = allAssistants.reduce(
        (acc, row) => ({
          assistantCount: acc.assistantCount + 1,
          stepCount: acc.stepCount + row.step_count,
          tokens: {
            input: acc.tokens.input + row.tokens_input,
            output: acc.tokens.output + row.tokens_output,
            reasoning: acc.tokens.reasoning + row.tokens_reasoning,
            cache: { read: acc.tokens.cache.read + row.tokens_cache_read, write: acc.tokens.cache.write + row.tokens_cache_write },
            total: acc.tokens.total + row.tokens_total,
          },
          cost: acc.cost + row.cost_micros,
        }),
        { assistantCount: 0, stepCount: 0, tokens: emptyTotals(), cost: 0 },
      )
      // 缺失 begin 的 source 兼容仅补该 request，不扫描或推测其他用户消息来归属费用。
      if (!requestRow) {
        yield* db.insert(RequestUsageTable).values({
          session_id: input.sessionID, request_id: input.requestID, root_request_id: rootRequestID,
          // 兜底请求使用 unknown 来源：区分异常缺失和正常请求，保证计费链路完整
          source: "unknown", status: "running", agent: assistant.agent,
          provider_id: assistant.providerID, model_id: assistant.modelID, variant: assistant.variant,
          assistant_count: 0, step_count: 0,
          tokens_input: 0, tokens_output: 0, tokens_reasoning: 0, tokens_cache_read: 0, tokens_cache_write: 0, tokens_total: 0,
          cost_micros: 0, time_created: assistant.time.created, time_updated: now, time_completed: null, error_message: null,
        }).pipe(Effect.orDie)
      }
      // 聚合全部助手状态，仍有执行的 running 优先于旧助手失败，不能只取本次回调。
      const requestStatus: Status = allAssistants.some(a => a.status === "running") ? "running" : allAssistants.some(a => a.status === "error") ? "error" : allAssistants.some(a => a.status === "aborted") ? "aborted" : "completed"
      yield* db
        .update(RequestUsageTable)
        .set({
          assistant_count: aggregated.assistantCount,
          step_count: aggregated.stepCount,
          tokens_input: aggregated.tokens.input,
          tokens_output: aggregated.tokens.output,
          tokens_reasoning: aggregated.tokens.reasoning,
          tokens_cache_read: aggregated.tokens.cache.read,
          tokens_cache_write: aggregated.tokens.cache.write,
          tokens_total: aggregated.tokens.total,
          cost_micros: aggregated.cost,
          status: requestStatus,
          // 聚合取最晚完成时间；合法的 epoch 0 不能被真值默认替换成当前时间。
          time_completed: requestStatus === "running" ? null : allAssistants.reduce((max, a) => Math.max(max, a.time_completed ?? 0), 0),
          // 正常重试恢复 running/completed 后必须清除旧错误，避免把新费用与旧故障拼接。
          error_message: (requestStatus === "error" || requestStatus === "aborted") ? (allAssistants.find(a => a.error_message !== null)?.error_message ?? null) : null,
          time_updated: now,
        })
        .where(and(eq(RequestUsageTable.session_id, input.sessionID), eq(RequestUsageTable.request_id, input.requestID)))
        .pipe(Effect.orDie)
      })).pipe(Effect.orDie)
    })

    // source允许无账本旧历史；只在该具体存量边界读取完整parent桶，不写新请求行。
    const historical = Effect.fn("RequestUsage.historical")(function* (input: { sessionID: SessionID; requestID: MessageID }) {
      const rows = yield* db.select().from(MessageTable).where(and(eq(MessageTable.session_id, input.sessionID),
        sql`json_extract(${MessageTable.data}, '$.role') = 'assistant'`,
        sql`json_extract(${MessageTable.data}, '$.parentID') = ${input.requestID}`,
      )).orderBy(desc(MessageTable.time_created), desc(MessageTable.id)).all().pipe(Effect.orDie)
      const assistants: Assistant[] = []
      for (const row of rows) {
        const info = Schema.decodeUnknownSync(SessionV1.Info)({ ...row.data, id: row.id, sessionID: row.session_id })
        if (info.role !== "assistant") continue
        const parts = (yield* db.select().from(PartTable).where(and(eq(PartTable.session_id, input.sessionID), eq(PartTable.message_id, info.id), sql`json_extract(${PartTable.data}, '$.type') = 'step-finish'`))
          .all().pipe(Effect.orDie)).map(part => Schema.decodeUnknownSync(SessionV1.Part)({ ...part.data, id: part.id, messageID: part.message_id, sessionID: part.session_id }))
        const totals = stepUsage(parts, info)
        assistants.push({ sessionID: input.sessionID, requestID: input.requestID, rootRequestID: input.requestID,
          assistantMessageID: info.id, model: { providerID: info.providerID, modelID: info.modelID, variant: info.variant },
          status: assistantStatus(info), stepCount: totals.count, tokens: totals.tokens, cost: toCost(totals.costMicros),
          time: { created: info.time.created, updated: row.time_updated, completed: info.time.completed }, error: errorMessage(info.error) })
      }
      const latest = rows[0]
      if (!latest) return { request: undefined, assistants }
      const info = Schema.decodeUnknownSync(SessionV1.Info)({ ...latest.data, id: latest.id, sessionID: latest.session_id })
      if (info.role !== "assistant") return { request: undefined, assistants }
      const parent = yield* db.select().from(MessageTable).where(and(eq(MessageTable.session_id, input.sessionID), eq(MessageTable.id, input.requestID))).get().pipe(Effect.orDie)
      // 聚合各助手完整确认值，费用仍以整数微美元相加；不从窗口或当前price推导。
      const totals = assistants.reduce((acc, value) => ({ count: acc.count + value.stepCount,
        tokens: { input: acc.tokens.input + value.tokens.input, output: acc.tokens.output + value.tokens.output,
          reasoning: acc.tokens.reasoning + value.tokens.reasoning,
          cache: { read: acc.tokens.cache.read + value.tokens.cache.read, write: acc.tokens.cache.write + value.tokens.cache.write },
          total: acc.tokens.total + value.tokens.total }, costMicros: acc.costMicros + toMicros(value.cost),
      }), { count: 0, tokens: emptyTotals(), costMicros: 0 })
      const status: Status = assistants.some(value => value.status === "running") ? "running"
        : assistants.some(value => value.status === "error") ? "error" : assistants.some(value => value.status === "aborted") ? "aborted" : "completed"
      const request: Request = { sessionID: input.sessionID, requestID: input.requestID, rootRequestID: input.requestID,
        source: "unknown", status, agent: info.agent, model: { providerID: info.providerID, modelID: info.modelID, variant: info.variant },
        assistantCount: assistants.length, stepCount: totals.count, tokens: totals.tokens, cost: toCost(totals.costMicros),
        time: { created: parent?.time_created ?? Math.min(...rows.map(row => row.time_created)),
          updated: Math.max(...rows.map(row => row.time_updated)),
          completed: status === "running" ? undefined : Math.max(...assistants.map(value => value.time.completed ?? 0)) },
        error: assistants.find(value => value.error !== undefined)?.error }
      return { request, assistants }
    })

    const get: Interface["get"] = Effect.fn("RequestUsage.get")(function* (input) {
      const row = yield* db
        .select()
        .from(RequestUsageTable)
        .where(and(eq(RequestUsageTable.session_id, input.sessionID), eq(RequestUsageTable.request_id, input.requestID)))
        .get()
        .pipe(Effect.orDie)
      if (row) return rowToRequest(row)
      return (yield* historical(input)).request
    })

    const list: Interface["list"] = Effect.fn("RequestUsage.list")(function* (input) {
      const conditions = [eq(RequestUsageTable.session_id, input.sessionID)]
      // 时间游标严格小于 before；零也是已提供的边界，不能按未提供处理而返回所有请求。
      if (input.before !== undefined) conditions.push(lt(RequestUsageTable.time_created, input.before))
      if (input.rootRequestID) conditions.push(eq(RequestUsageTable.root_request_id, input.rootRequestID))
      if (input.source) conditions.push(eq(RequestUsageTable.source, input.source))
      const rows = yield* db
        .select()
        .from(RequestUsageTable)
        .where(and(...conditions))
        // 同时间使用 requestID 稳定排序。
        .orderBy(desc(RequestUsageTable.time_created), desc(RequestUsageTable.request_id))
        // limit 的显式零值不能被默认值替换。
        .limit(input.limit ?? 100)
        .all()
        .pipe(Effect.orDie)
      return rows.map(rowToRequest)
    })

    // 明细保留助手创建顺序和身份打破平局，不能按模型聚合后丢掉助手 ID。
    const assistants: Interface["assistants"] = Effect.fn("RequestUsage.assistants")(function* (input) {
      const rows = yield* db
        .select()
        .from(RequestUsageAssistantTable)
        .where(and(eq(RequestUsageAssistantTable.session_id, input.sessionID), eq(RequestUsageAssistantTable.request_id, input.requestID)))
        .orderBy(desc(RequestUsageAssistantTable.time_created), desc(RequestUsageAssistantTable.assistant_message_id))
        .all()
        .pipe(Effect.orDie)
      // 已存在的零账本仍是权威，不能用旧消息把它反填成另一组用量。
      const stored = rows.length > 0 ? undefined : yield* db.select().from(RequestUsageTable).where(and(
        eq(RequestUsageTable.session_id, input.sessionID), eq(RequestUsageTable.request_id, input.requestID))).get().pipe(Effect.orDie)
      if (rows.length === 0 && !stored) return (yield* historical(input)).assistants
      return rows.map(rowToAssistant)
    })

    return { begin, recordAssistant, complete, get, list, assistants }
}
const layer = Layer.effect(Service, Effect.map(Database.Service, database => make(database.db)))

// 请求账本是全局数据库能力；Session 放置与 Location 不参与 service identity。
// 显式依赖 Database.node，V1 app 和 HTTP layer 共用同一服务而非临时数据库层。
export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node] })

export * as SessionRequestUsage from "./request-usage"


