import z from "zod"
import { Context, Effect, Layer } from "effect"
import { and, desc, eq, lt } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { MessageV2 } from "./message-v2"
import { SessionID, MessageID } from "./schema"
import { RequestUsageAssistantTable, RequestUsageTable } from "./request-usage.sql"

// 中文说明：数据库使用微美元（micros）存储成本，避免浮点累计误差。
const MICROS = 1_000_000

const toMicros = (cost: number) => Math.round(cost * MICROS)
const toCost = (micros: number) => micros / MICROS

export const Source = z
  .enum(["prompt", "command", "shell", "system_compaction", "system_continue", "unknown"])
  .meta({ ref: "RequestUsageSource" })
export type Source = z.infer<typeof Source>

export const Status = z.enum(["running", "completed", "error", "aborted"]).meta({ ref: "RequestUsageStatus" })
export type Status = z.infer<typeof Status>

export const Tokens = z
  .object({
    input: z.number(),
    output: z.number(),
    reasoning: z.number(),
    cache: z.object({
      read: z.number(),
      write: z.number(),
    }),
    total: z.number(),
  })
  .meta({ ref: "RequestUsageTokens" })
export type Tokens = z.infer<typeof Tokens>

export const Request = z
  .object({
    sessionID: z.string(),
    requestID: z.string(),
    rootRequestID: z.string(),
    source: Source,
    status: Status,
    agent: z.string(),
    model: z.object({
      providerID: z.string(),
      modelID: z.string(),
      variant: z.string().optional(),
    }),
    assistantCount: z.number(),
    stepCount: z.number(),
    tokens: Tokens,
    cost: z.number(),
    error: z.string().optional(),
    time: z.object({
      created: z.number(),
      updated: z.number(),
      completed: z.number().optional(),
    }),
  })
  .meta({ ref: "SessionRequestUsage" })
export type Request = z.infer<typeof Request>

export const Assistant = z
  .object({
    sessionID: z.string(),
    requestID: z.string(),
    assistantMessageID: z.string(),
    rootRequestID: z.string(),
    status: Status,
    model: z.object({
      providerID: z.string(),
      modelID: z.string(),
      variant: z.string().optional(),
    }),
    stepCount: z.number(),
    tokens: Tokens,
    cost: z.number(),
    error: z.string().optional(),
    time: z.object({
      created: z.number(),
      updated: z.number(),
      completed: z.number().optional(),
    }),
  })
  .meta({ ref: "SessionRequestUsageAssistant" })
export type Assistant = z.infer<typeof Assistant>

export interface Interface {
  readonly begin: (input: {
    sessionID: SessionID
    requestID: MessageID
    rootRequestID?: MessageID
    source: Source
    agent: string
    providerID: string
    modelID: string
    variant?: string
    timeCreated?: number
  }) => Effect.Effect<void>
  readonly recordAssistant: (input: {
    sessionID: SessionID
    requestID: MessageID
    assistant: MessageV2.Assistant
  }) => Effect.Effect<void>
  readonly complete: (input: {
    sessionID: SessionID
    requestID: MessageID
    status?: Status
    error?: string
    timeCompleted?: number
  }) => Effect.Effect<void>
  readonly get: (input: { sessionID: SessionID; requestID: MessageID }) => Effect.Effect<Request | undefined>
  readonly list: (input: {
    sessionID: SessionID
    limit?: number
    before?: number
    rootRequestID?: MessageID
    source?: Source
  }) => Effect.Effect<Request[]>
  readonly assistants: (input: { sessionID: SessionID; requestID: MessageID }) => Effect.Effect<Assistant[]>
}

const emptyTotals = () => ({
  input: 0,
  output: 0,
  reasoning: 0,
  cache: { read: 0, write: 0 },
  total: 0,
})

const rowToRequest = (row: typeof RequestUsageTable.$inferSelect): Request => ({
  sessionID: row.session_id,
  requestID: row.request_id,
  rootRequestID: row.root_request_id,
  source: row.source as Source,
  status: row.status as Status,
  agent: row.agent,
  model: {
    providerID: row.provider_id,
    modelID: row.model_id,
    variant: row.variant ?? undefined,
  },
  assistantCount: row.assistant_count,
  stepCount: row.step_count,
  tokens: {
    input: row.tokens_input,
    output: row.tokens_output,
    reasoning: row.tokens_reasoning,
    cache: {
      read: row.tokens_cache_read,
      write: row.tokens_cache_write,
    },
    total: row.tokens_total,
  },
  cost: toCost(row.cost_micros),
  error: row.error_message ?? undefined,
  time: {
    created: row.time_created,
    updated: row.time_updated,
    completed: row.time_completed ?? undefined,
  },
})

const rowToAssistant = (row: typeof RequestUsageAssistantTable.$inferSelect): Assistant => ({
  sessionID: row.session_id,
  requestID: row.request_id,
  assistantMessageID: row.assistant_message_id,
  rootRequestID: row.root_request_id,
  status: row.status as Status,
  model: {
    providerID: row.provider_id,
    modelID: row.model_id,
    variant: row.variant ?? undefined,
  },
  stepCount: row.step_count,
  tokens: {
    input: row.tokens_input,
    output: row.tokens_output,
    reasoning: row.tokens_reasoning,
    cache: {
      read: row.tokens_cache_read,
      write: row.tokens_cache_write,
    },
    total: row.tokens_total,
  },
  cost: toCost(row.cost_micros),
  error: row.error_message ?? undefined,
  time: {
    created: row.time_created,
    updated: row.time_updated,
    completed: row.time_completed ?? undefined,
  },
})

const errorMessage = (error: MessageV2.Assistant["error"]) => {
  if (!error) return undefined
  if ("message" in error.data && typeof error.data.message === "string") return error.data.message
  return error.name
}

const assistantStatus = (assistant: MessageV2.Assistant): Status => {
  if (!assistant.time.completed) return "running"
  if (assistant.error?.name === "MessageAbortedError") return "aborted"
  if (assistant.error) return "error"
  return "completed"
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionRequestUsage") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const database = yield* Database.Service
    const { db } = database

    const begin: Interface["begin"] = Effect.fn("RequestUsage.begin")(function* (input) {
      const now = Date.now()
      const created = input.timeCreated ?? now
      const root = input.rootRequestID ?? input.requestID
      yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
          const where = and(
            eq(RequestUsageTable.session_id, input.sessionID),
            eq(RequestUsageTable.request_id, input.requestID),
          )
          const row = yield* tx.select().from(RequestUsageTable).where(where).get()
          if (!row) {
            yield* tx
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
              .run()
            return
          }
          yield* tx
            .update(RequestUsageTable)
            .set({
              root_request_id: row.root_request_id || root,
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
            .where(where)
            .run()
          }),
        )
        .pipe(Effect.orDie)
    })

    const complete: Interface["complete"] = Effect.fn("RequestUsage.complete")(function* (input) {
      const now = Date.now()
      yield* db
        .update(RequestUsageTable)
        .set({
          status: input.status ?? "completed",
          error_message: input.error ?? null,
          time_updated: now,
          time_completed: input.timeCompleted ?? now,
        })
        .where(and(eq(RequestUsageTable.session_id, input.sessionID), eq(RequestUsageTable.request_id, input.requestID)))
        .run()
        .pipe(Effect.orDie)
    })

    const recordAssistant: Interface["recordAssistant"] = Effect.fn("RequestUsage.recordAssistant")(function* (input) {
      // 中文说明：assistant 粒度单独落表，便于同一 request 下多模型/多回合统计。
      const stepTotals = (yield* MessageV2.parts(input.assistant.id).pipe(Effect.provideService(Database.Service, database))).reduce(
        (acc, part) => {
          if (part.type !== "step-finish") return acc
          return {
            count: acc.count + 1,
            tokens: {
              input: acc.tokens.input + part.tokens.input,
              output: acc.tokens.output + part.tokens.output,
              reasoning: acc.tokens.reasoning + part.tokens.reasoning,
              cache: {
                read: acc.tokens.cache.read + part.tokens.cache.read,
                write: acc.tokens.cache.write + part.tokens.cache.write,
              },
              total:
                acc.tokens.total +
                (part.tokens.total ??
                  part.tokens.input +
                    part.tokens.output +
                    part.tokens.reasoning +
                    part.tokens.cache.read +
                    part.tokens.cache.write),
            },
            costMicros: acc.costMicros + toMicros(part.cost),
          }
        },
        { count: 0, tokens: emptyTotals(), costMicros: 0 },
      )

      const status = assistantStatus(input.assistant)
      const now = Date.now()

      yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
          const requestWhere = and(
            eq(RequestUsageTable.session_id, input.sessionID),
            eq(RequestUsageTable.request_id, input.requestID),
          )
          const request = yield* tx.select().from(RequestUsageTable).where(requestWhere).get()

          // 中文说明：优先使用 begin 已创建的请求；若异常缺失，则兜底创建 unknown 请求，保证计费数据不丢。
          if (!request) {
            yield* tx
              .insert(RequestUsageTable)
              .values({
                session_id: input.sessionID,
                request_id: input.requestID,
                root_request_id: input.requestID,
                source: "unknown",
                status: "running",
                agent: input.assistant.agent,
                provider_id: input.assistant.providerID,
                model_id: input.assistant.modelID,
                variant: input.assistant.variant,
                time_created: input.assistant.time.created,
                time_updated: now,
              })
              .run()
          }

          const requestRow = yield* tx.select().from(RequestUsageTable).where(requestWhere).get()
          if (!requestRow) return yield* Effect.die("request usage row missing after insert")
          const assistantWhere = and(
            eq(RequestUsageAssistantTable.session_id, input.sessionID),
            eq(RequestUsageAssistantTable.assistant_message_id, input.assistant.id),
          )
          const assistantRow = yield* tx.select().from(RequestUsageAssistantTable).where(assistantWhere).get()
          if (!assistantRow) {
            yield* tx
              .insert(RequestUsageAssistantTable)
              .values({
                session_id: input.sessionID,
                request_id: input.requestID,
                assistant_message_id: input.assistant.id,
                root_request_id: requestRow.root_request_id,
                status,
                provider_id: input.assistant.providerID,
                model_id: input.assistant.modelID,
                variant: input.assistant.variant,
                step_count: stepTotals.count,
                tokens_input: stepTotals.tokens.input,
                tokens_output: stepTotals.tokens.output,
                tokens_reasoning: stepTotals.tokens.reasoning,
                tokens_cache_read: stepTotals.tokens.cache.read,
                tokens_cache_write: stepTotals.tokens.cache.write,
                tokens_total: stepTotals.tokens.total,
                cost_micros: stepTotals.costMicros,
                time_created: input.assistant.time.created,
                time_updated: now,
                time_completed: input.assistant.time.completed ?? null,
                error_message: errorMessage(input.assistant.error) ?? null,
              })
              .run()
          }
          if (assistantRow) {
            yield* tx
              .update(RequestUsageAssistantTable)
              .set({
                request_id: input.requestID,
                root_request_id: requestRow.root_request_id,
                status,
                provider_id: input.assistant.providerID,
                model_id: input.assistant.modelID,
                variant: input.assistant.variant,
                step_count: stepTotals.count,
                tokens_input: stepTotals.tokens.input,
                tokens_output: stepTotals.tokens.output,
                tokens_reasoning: stepTotals.tokens.reasoning,
                tokens_cache_read: stepTotals.tokens.cache.read,
                tokens_cache_write: stepTotals.tokens.cache.write,
                tokens_total: stepTotals.tokens.total,
                cost_micros: stepTotals.costMicros,
                time_updated: now,
                time_completed: input.assistant.time.completed ?? null,
                error_message: errorMessage(input.assistant.error) ?? null,
              })
              .where(assistantWhere)
              .run()
          }

          const assistantRows = yield* tx
            .select()
            .from(RequestUsageAssistantTable)
            .where(
              and(
                eq(RequestUsageAssistantTable.session_id, input.sessionID),
                eq(RequestUsageAssistantTable.request_id, input.requestID),
              ),
            )
            .all()

          const aggregate = assistantRows.reduce(
            (acc, row) => ({
              assistantCount: acc.assistantCount + 1,
              stepCount: acc.stepCount + row.step_count,
              tokens: {
                input: acc.tokens.input + row.tokens_input,
                output: acc.tokens.output + row.tokens_output,
                reasoning: acc.tokens.reasoning + row.tokens_reasoning,
                cache: {
                  read: acc.tokens.cache.read + row.tokens_cache_read,
                  write: acc.tokens.cache.write + row.tokens_cache_write,
                },
                total: acc.tokens.total + row.tokens_total,
              },
              costMicros: acc.costMicros + row.cost_micros,
              hasRunning: acc.hasRunning || row.status === "running",
              hasError: acc.hasError || row.status === "error",
              hasAborted: acc.hasAborted || row.status === "aborted",
              completed: Math.max(acc.completed, row.time_completed ?? 0),
              errorMessage: acc.errorMessage || row.error_message,
            }),
            {
              assistantCount: 0,
              stepCount: 0,
              tokens: emptyTotals(),
              costMicros: 0,
              hasRunning: false,
              hasError: false,
              hasAborted: false,
              completed: 0,
              errorMessage: null as string | null,
            },
          )

          const requestStatus: Status = aggregate.hasRunning
            ? "running"
            : aggregate.hasError
              ? "error"
              : aggregate.hasAborted
                ? "aborted"
                : "completed"

          yield* tx
            .update(RequestUsageTable)
            .set({
              assistant_count: aggregate.assistantCount,
              step_count: aggregate.stepCount,
              tokens_input: aggregate.tokens.input,
              tokens_output: aggregate.tokens.output,
              tokens_reasoning: aggregate.tokens.reasoning,
              tokens_cache_read: aggregate.tokens.cache.read,
              tokens_cache_write: aggregate.tokens.cache.write,
              tokens_total: aggregate.tokens.total,
              cost_micros: aggregate.costMicros,
              status: requestStatus,
              time_updated: now,
              time_completed: requestStatus === "running" ? null : aggregate.completed || now,
              error_message: requestStatus === "error" || requestStatus === "aborted" ? aggregate.errorMessage : null,
            })
            .where(requestWhere)
            .run()
          }),
        )
        .pipe(Effect.orDie)
    })

    const get: Interface["get"] = Effect.fn("RequestUsage.get")(function* (input) {
      const row = yield* db
        .select()
        .from(RequestUsageTable)
        .where(and(eq(RequestUsageTable.session_id, input.sessionID), eq(RequestUsageTable.request_id, input.requestID)))
        .get()
        .pipe(Effect.orDie)
      if (!row) return
      return rowToRequest(row)
    })

    const list: Interface["list"] = Effect.fn("RequestUsage.list")(function* (input) {
      const conditions = [eq(RequestUsageTable.session_id, input.sessionID)]
      if (input.before) conditions.push(lt(RequestUsageTable.time_created, input.before))
      if (input.rootRequestID) conditions.push(eq(RequestUsageTable.root_request_id, input.rootRequestID))
      if (input.source) conditions.push(eq(RequestUsageTable.source, input.source))
      const rows = yield* db
        .select()
        .from(RequestUsageTable)
        .where(and(...conditions))
        .orderBy(desc(RequestUsageTable.time_created), desc(RequestUsageTable.request_id))
        .limit(input.limit ?? 100)
        .all()
        .pipe(Effect.orDie)
      return rows.map(rowToRequest)
    })

    const assistants: Interface["assistants"] = Effect.fn("RequestUsage.assistants")(function* (input) {
      const rows = yield* db
        .select()
        .from(RequestUsageAssistantTable)
        .where(
          and(eq(RequestUsageAssistantTable.session_id, input.sessionID), eq(RequestUsageAssistantTable.request_id, input.requestID)),
        )
        .orderBy(desc(RequestUsageAssistantTable.time_created), desc(RequestUsageAssistantTable.assistant_message_id))
        .all()
        .pipe(Effect.orDie)
      return rows.map(rowToAssistant)
    })

    return Service.of({
      begin,
      recordAssistant,
      complete,
      get,
      list,
      assistants,
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Database.defaultLayer))

export * as SessionRequestUsage from "./request-usage"
