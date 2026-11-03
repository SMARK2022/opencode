export * as SessionProjector from "./projector"

import { and, desc, eq, gt, inArray, isNotNull, lte, ne, or, sql } from "drizzle-orm"
import { DateTime, Effect, Layer, Schema } from "effect"
import { Database } from "../database/database"
import { EventV2 } from "../event"
import { SessionRequestUsage } from "./request-usage"
import { RequestUsageTable, RequestUsageAssistantTable } from "./request-usage.sql"
import { ProviderV2 } from "../provider"
import { ModelV2 } from "../model"
import { makeGlobalNode } from "../effect/app-node"
import { SessionEvent } from "./event"
import { SessionV1 } from "../v1/session"
import { WorkspaceTable } from "../control-plane/workspace.sql"
import { SessionMessage } from "./message"
import { SessionMessageUpdater } from "./message-updater"
import { SessionInput } from "./input"
import { WorkspaceV2 } from "../workspace"
import { MessageTable, PartTable, SessionInputTable, SessionMessageTable, SessionTable } from "./sql"
import { ColdStorage } from "../storage/cold-storage"
import type { DeepMutable } from "../schema"
import { PromptCacheSlots } from "./prompt-cache-slots"

type DatabaseService = Database.Interface["db"]

const decodeMessage = Schema.decodeUnknownSync(SessionMessage.Message)
const encodeMessage = Schema.encodeSync(SessionMessage.Message)

export class SessionAlreadyProjected extends Error {}

type Usage = {
  cost: number
  tokens: {
    input: number
    output: number
    reasoning: number
    cache: { read: number; write: number }
  }
}

function usage(part: (typeof SessionV1.Event.PartUpdated.Type)["data"]["part"] | unknown): Usage | undefined {
  if (typeof part !== "object" || part === null) return undefined
  const value = part as Record<string, unknown>
  if (value.type !== "step-finish") return undefined
  if (!("cost" in value) || !("tokens" in value)) return undefined
  return { cost: value.cost as Usage["cost"], tokens: value.tokens as Usage["tokens"] }
}

function sessionRow(info: SessionV1.SessionInfo): typeof SessionTable.$inferInsert {
  return {
    id: info.id,
    project_id: info.projectID,
    workspace_id: info.workspaceID ?? null,
    parent_id: info.parentID,
    slug: info.slug,
    directory: info.directory,
    path: info.path,
    title: info.title,
    agent: info.agent,
    model: info.model,
    version: info.version,
    share_url: info.share?.url,
    summary_additions: info.summary?.additions,
    summary_deletions: info.summary?.deletions,
    summary_files: info.summary?.files,
    summary_diffs: info.summary?.diffs ? [...info.summary.diffs] : undefined,
    metadata: info.metadata,
    cost: info.cost ?? 0,
    tokens_input: (info.tokens ?? { input: 0 }).input,
    tokens_output: (info.tokens ?? { output: 0 }).output,
    tokens_reasoning: (info.tokens ?? { reasoning: 0 }).reasoning,
    tokens_cache_read: (info.tokens ?? { cache: { read: 0 } }).cache.read,
    tokens_cache_write: (info.tokens ?? { cache: { write: 0 } }).cache.write,
    revert: info.revert ? { ...info.revert, messageID: SessionMessage.ID.make(info.revert.messageID) } : null,
    permission: info.permission ? [...info.permission] : undefined,
    time_created: info.time.created,
    time_updated: info.time.updated,
    time_compacting: info.time.compacting,
    time_archived: info.time.archived,
  }
}

function messageData(info: (typeof SessionV1.Event.MessageUpdated.Type)["data"]["info"]) {
  const { id: _, sessionID: __, ...rest } = info
  return rest as DeepMutable<typeof rest>
}

function partData(part: (typeof SessionV1.Event.PartUpdated.Type)["data"]["part"]) {
  const { id: _, messageID: __, sessionID: ___, ...rest } = part
  return rest as DeepMutable<typeof rest>
}

function applyUsage(
  db: DatabaseService,
  sessionID: (typeof SessionV1.Event.MessageUpdated.Type)["data"]["sessionID"],
  value: Usage,
  sign = 1,
) {
  return db
    .update(SessionTable)
    .set({
      cost: sql`${SessionTable.cost} + ${value.cost * sign}`,
      tokens_input: sql`${SessionTable.tokens_input} + ${value.tokens.input * sign}`,
      tokens_output: sql`${SessionTable.tokens_output} + ${value.tokens.output * sign}`,
      tokens_reasoning: sql`${SessionTable.tokens_reasoning} + ${value.tokens.reasoning * sign}`,
      tokens_cache_read: sql`${SessionTable.tokens_cache_read} + ${value.tokens.cache.read * sign}`,
      tokens_cache_write: sql`${SessionTable.tokens_cache_write} + ${value.tokens.cache.write * sign}`,
      time_updated: sql`${SessionTable.time_updated}`,
    })
    .where(eq(SessionTable.id, sessionID))
    .run()
    .pipe(Effect.orDie)
}

// #0500：summary 聚合的可见性来源判定——隐藏行、未闭合 assistant 与非 user 行不构成 diff 源。
function summaryMessageSource(data: (typeof MessageTable.$inferSelect)["data"]) {
  if (data.hidden) return false
  if (data.role === "user") return true
  return data.time.completed !== undefined
}

// #0500：只有已完成的 Tool metadata 参与 summary aggregate；其它 part 形态一律不是失效证据。
function summaryPartSource(data: (typeof PartTable.$inferSelect)["data"] | undefined) {
  if (!data || data.hidden || data.type !== "tool" || data.state.status !== "completed") return undefined
  return data.state.metadata
}

function sameSummaryPart(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right)
}

function run(db: DatabaseService, event: SessionEvent.Event) {
  return Effect.gen(function* () {
    const ledger = SessionRequestUsage.make(db)
    if (event.type === "session.next.prompt.failed" || event.type === "session.next.prompt.completed") {
      const failed = event.type === "session.next.prompt.failed" ? event.data : undefined
      // 请求终态已经冻结真实提升批次；空成功和失败都不能在重放时认领后来输入。
      const requestID = SessionV1.MessageID.make(event.data.messageID)
      yield* db
        .update(RequestUsageTable)
        .set({ root_request_id: requestID })
        .where(
          and(
            eq(RequestUsageTable.session_id, event.data.sessionID),
            eq(RequestUsageTable.assistant_count, 0),
            inArray(
              RequestUsageTable.request_id,
              event.data.requestIDs.map((id) => SessionV1.MessageID.make(id)),
            ),
          ),
        )
        .run()
        .pipe(Effect.orDie)
      // complete 只改终态，零助手不伪造用量，已有确认消费也不被清空。
      for (const id of event.data.requestIDs)
        yield* ledger.complete({
          sessionID: event.data.sessionID,
          requestID: SessionV1.MessageID.make(id),
          status: failed ? (failed.aborted ? "aborted" : "error") : "completed",
          error: failed?.error.message,
          timeCompleted: DateTime.toEpochMillis(event.data.timestamp),
        })
      return
    }
    if (event.type === "session.next.prompt.admitted" || event.type === "session.next.prompted") {
      // 接纳先落账本，promote 只复用此行；exact retry 不重置已经结算的用量。
      const session = yield* db
        .select()
        .from(SessionTable)
        .where(eq(SessionTable.id, event.data.sessionID))
        .get()
        .pipe(Effect.orDie)
      if (session)
        yield* db
          .insert(RequestUsageTable)
          .values({
            session_id: event.data.sessionID,
            request_id: SessionV1.MessageID.make(event.data.messageID),
            root_request_id: SessionV1.MessageID.make(event.data.messageID),
            source: "prompt",
            status: "running",
            // 接纳时模型可以尚未解析；空字符串表示未选定，Step.Started 写入实际执行模型。
            agent: session.agent ?? "",
            provider_id: session.model?.providerID ?? "",
            model_id: session.model?.id ?? "",
            variant: session.model?.variant,
            time_created: DateTime.toEpochMillis(event.data.timestamp),
            time_updated: DateTime.toEpochMillis(event.data.timestamp),
          })
          .onConflictDoNothing()
          .run()
          .pipe(Effect.orDie)
    }
    if (event.type === "session.next.compaction.started" && event.data.model) {
      const promoted = yield* db
        .select()
        .from(SessionInputTable)
        .where(and(eq(SessionInputTable.session_id, event.data.sessionID), isNotNull(SessionInputTable.promoted_seq)))
        .orderBy(desc(SessionInputTable.promoted_seq))
        .limit(1)
        .get()
        .pipe(Effect.orDie)
      // 压缩拥有独立请求行；根请求关联在开始时冻结，不在摘要结束时重选。
      yield* ledger.begin({
        sessionID: event.data.sessionID,
        requestID: SessionV1.MessageID.make(event.data.messageID),
        rootRequestID: SessionV1.MessageID.make(promoted?.id ?? event.data.messageID),
        source: "system_compaction",
        agent: "compaction",
        providerID: event.data.model.providerID,
        modelID: event.data.model.id,
        variant: event.data.model.variant,
        timeCreated: DateTime.toEpochMillis(event.data.timestamp),
      })
    }
    const decodeRow = (row: typeof SessionMessageTable.$inferSelect) => {
      const restored = ColdStorage.thawSessionMessageRowsInTransaction(db.sync, [row])[0]
      if (!restored) throw new ColdStorage.CorruptionError({ message: `Native message disappeared: ${row.id}` })
      return decodeMessage({ ...restored.data, id: restored.id, type: restored.type })
    }
    const updateMessage = (message: SessionMessage.Message) => {
      if (event.durable === undefined) return Effect.die("Durable Session event is missing aggregate sequence")
      const encoded = encodeMessage(message)
      const { id, type, ...data } = encoded
      // 与事件及账本共用已持有的事务；完整替换后再释放旧payload。
      return Effect.sync(() =>
        ColdStorage.replaceSessionMessage(db.sync, {
          id: SessionMessage.ID.make(id),
          session_id: event.data.sessionID,
          type,
          time_created: DateTime.toEpochMillis(message.time.created),
          data,
        }),
      )
    }
    const appendMessage = (message: SessionMessage.Message) => insertMessage(db, event, message)
    const adapter: SessionMessageUpdater.Adapter = {
      getMessage(messageID) {
        return db
          .select()
          .from(SessionMessageTable)
          .where(and(eq(SessionMessageTable.id, messageID), eq(SessionMessageTable.session_id, event.data.sessionID)))
          .get()
          .pipe(
            Effect.orDie,
            Effect.map((row) => (row ? decodeRow(row) : undefined)),
          )
      },
      updateMessage,
      getCurrentAssistant() {
        return Effect.gen(function* () {
          // A newer turn supersedes stale incomplete rows; never resume an older assistant projection.
          const row = yield* db
            .select()
            .from(SessionMessageTable)
            .where(
              and(eq(SessionMessageTable.session_id, event.data.sessionID), eq(SessionMessageTable.type, "assistant")),
            )
            .orderBy(desc(SessionMessageTable.seq))
            .limit(1)
            .get()
            .pipe(Effect.orDie)
          if (!row) return
          const message = decodeRow(row)
          return message.type === "assistant" && !message.time.completed ? message : undefined
        })
      },
      getAssistant(messageID) {
        return Effect.gen(function* () {
          const row = yield* db
            .select()
            .from(SessionMessageTable)
            .where(
              and(
                eq(SessionMessageTable.id, messageID),
                eq(SessionMessageTable.session_id, event.data.sessionID),
                eq(SessionMessageTable.type, "assistant"),
              ),
            )
            .get()
            .pipe(Effect.orDie)
          if (!row) return
          const message = decodeRow(row)
          return message.type === "assistant" ? message : undefined
        })
      },
      getCurrentShell(callID) {
        return Effect.gen(function* () {
          const rows = yield* db
            .select()
            .from(SessionMessageTable)
            .where(and(eq(SessionMessageTable.session_id, event.data.sessionID), eq(SessionMessageTable.type, "shell")))
            .orderBy(desc(SessionMessageTable.seq))
            .all()
            .pipe(Effect.orDie)
          return rows
            .map(decodeRow)
            .find((message): message is SessionMessage.Shell => message.type === "shell" && message.callID === callID)
        })
      },
      updateAssistant: updateMessage,
      updateShell: updateMessage,
      appendMessage,
    }
    const recordAssistant = (
      assistant: SessionMessage.Assistant,
      requestID: SessionV1.MessageID,
      aborted: boolean | undefined,
    ) =>
      Effect.gen(function* () {
        const tokens = assistant.tokens ?? { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
        // 与 #9 的 Session 累计并行投影但不二次计费；同一助手修订覆盖快照后重新求和。
        yield* ledger.recordAssistant({
          sessionID: event.data.sessionID,
          requestID,
          assistant: {
            id: SessionV1.MessageID.make(assistant.id),
            agent: assistant.agent,
            providerID: assistant.model.providerID,
            modelID: assistant.model.id,
            variant: assistant.model.variant,
            time: {
              created: DateTime.toEpochMillis(assistant.time.created),
              completed: assistant.time.completed ? DateTime.toEpochMillis(assistant.time.completed) : undefined,
            },
            // 补结算旧助手沿用持久化失败身份，不把工具错误升级为助手错误。
            // 新 Failed 使用自身 aborted 标志，旧消息错误也不通过文案猜测。
            error: assistant.error
              ? { name: aborted ? "MessageAbortedError" : "UnknownError", data: { message: assistant.error.message } }
              : undefined,
          },
          usage: {
            count: assistant.tokens ? 1 : 0,
            costMicros: Math.round((assistant.cost ?? 0) * 1_000_000),
            tokens: {
              ...tokens,
              total: tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write,
            },
          },
        })
        const request = yield* ledger.get({ sessionID: event.data.sessionID, requestID })
        // 批次成员同步状态而不复制 tokens/cost，既消除永久 running，也不让同一消费重复计费。
        if (request)
          yield* db
            .update(RequestUsageTable)
            .set({
              status: request.status,
              time_completed: request.time.completed ?? null,
              error_message: request.error ?? null,
              time_updated: request.time.updated,
            })
            .where(
              and(
                eq(RequestUsageTable.session_id, event.data.sessionID),
                eq(RequestUsageTable.source, "prompt"),
                eq(RequestUsageTable.root_request_id, requestID),
                ne(RequestUsageTable.request_id, requestID),
                eq(RequestUsageTable.assistant_count, 0),
              ),
            )
            .run()
            .pipe(Effect.orDie)
      })
    // updater 会关闭旧助手后追加新助手；必须先冻结它选中的旧身份，再读取闭合快照。
    const previous = event.type === "session.next.step.started" ? yield* adapter.getCurrentAssistant() : undefined
    yield* SessionMessageUpdater.update(adapter, event)
    if (previous) {
      const closed = yield* adapter.getAssistant(previous.id)
      const owned = yield* db
        .select()
        .from(RequestUsageAssistantTable)
        .where(
          and(
            eq(RequestUsageAssistantTable.session_id, event.data.sessionID),
            eq(RequestUsageAssistantTable.assistant_message_id, SessionV1.MessageID.make(previous.id)),
          ),
        )
        .get()
        .pipe(Effect.orDie)
      // 旧请求归属只取现有助手行；新输入的 promotion 不能重绑旧助手或其批次成员。
      if (closed && owned) yield* recordAssistant(closed, owned.request_id, owned.status === "aborted")
    }
    if (event.type === "session.next.compaction.ended" || event.type === "session.next.compaction.failed") {
      const requestID = SessionV1.MessageID.make(event.data.messageID)
      const usage = event.data.usage
      const request = yield* db
        .select()
        .from(RequestUsageTable)
        .where(and(eq(RequestUsageTable.session_id, event.data.sessionID), eq(RequestUsageTable.request_id, requestID)))
        .get()
        .pipe(Effect.orDie)
      // 历史压缩事件没有模型/usage，不虚构 provider 数据或历史成本。
      if (!request || !usage) return
      const previous = yield* db
        .select()
        .from(RequestUsageAssistantTable)
        .where(
          and(
            eq(RequestUsageAssistantTable.session_id, event.data.sessionID),
            eq(RequestUsageAssistantTable.assistant_message_id, requestID),
          ),
        )
        .get()
        .pipe(Effect.orDie)
      const failed = event.type === "session.next.compaction.failed" ? event.data : undefined
      yield* ledger.recordAssistant({
        sessionID: event.data.sessionID,
        requestID,
        // 存储列是字符串；在结算适配边界用同一 ID 工厂恢复品牌，不改存储或 wire 单位。
        assistant: {
          id: requestID,
          agent: "compaction",
          providerID: ProviderV2.ID.make(request.provider_id),
          modelID: ModelV2.ID.make(request.model_id),
          variant: request.variant ?? undefined,
          time: { created: request.time_created, completed: DateTime.toEpochMillis(event.data.timestamp) },
          error: failed
            ? { name: failed.aborted ? "MessageAbortedError" : "UnknownError", data: { message: failed.error.message } }
            : undefined,
        },
        usage: {
          count: usage.stepCount,
          tokens: {
            ...usage.tokens,
            total:
              usage.tokens.input +
              usage.tokens.output +
              usage.tokens.reasoning +
              usage.tokens.cache.read +
              usage.tokens.cache.write,
          },
          costMicros: Math.round(usage.cost * 1_000_000),
        },
      })
      // Session 是唯一会话总额；压缩也在同一事件事务减旧加新，不从部分账本替换历史总额。
      if (previous)
        yield* applyUsage(
          db,
          event.data.sessionID,
          {
            cost: previous.cost_micros / 1_000_000,
            tokens: {
              input: previous.tokens_input,
              output: previous.tokens_output,
              reasoning: previous.tokens_reasoning,
              cache: { read: previous.tokens_cache_read, write: previous.tokens_cache_write },
            },
          },
          -1,
        )
      yield* applyUsage(db, event.data.sessionID, usage)
      return
    }
    const messageID =
      event.type === "session.next.step.started" ||
      event.type === "session.next.step.ended" ||
      event.type === "session.next.step.failed" ||
      event.type === "session.next.retried"
        ? event.data.assistantMessageID
        : undefined
    if (messageID === undefined) return
    // 重试覆写同一助手快照，不能让已恢复请求继续聚合上一 attempt 的错误。
    const assistant = yield* adapter.getAssistant(messageID)
    if (!assistant) return
    const assistantID = SessionV1.MessageID.make(assistant.id)
    const owned = yield* db
      .select()
      .from(RequestUsageAssistantTable)
      .where(
        and(
          eq(RequestUsageAssistantTable.session_id, event.data.sessionID),
          eq(RequestUsageAssistantTable.assistant_message_id, assistantID),
        ),
      )
      .get()
      .pipe(Effect.orDie)
    // 只在开始边界选择已提升输入，之后所有结算使用持久化助手归属，不受新 steer/queue 干扰。
    const promoted =
      event.type === "session.next.step.started"
        ? yield* db
            .select()
            .from(SessionInputTable)
            .where(
              and(eq(SessionInputTable.session_id, event.data.sessionID), isNotNull(SessionInputTable.promoted_seq)),
            )
            .orderBy(desc(SessionInputTable.promoted_seq))
            .limit(1)
            .get()
            .pipe(Effect.orDie)
        : undefined
    // Started 选定的请求经下方明细写入冻结，后续结算优先沿用 owned.request_id。
    const requestID = owned?.request_id ?? (promoted ? SessionV1.MessageID.make(promoted.id) : undefined)
    if (!requestID) return
    // SQL 的 IS NOT NULL 过滤不收窄返回行类型；比较边界必须先证明是数值，零序列仍有效。
    if (event.type === "session.next.step.started" && promoted && promoted.promoted_seq !== null) {
      // 同批已提升但未拥有助手的输入共享一次响应；未提升 queue 不进入此关联。
      const pending = db
        .select({ id: RequestUsageTable.request_id })
        .from(RequestUsageTable)
        .innerJoin(
          SessionInputTable,
          and(
            eq(SessionInputTable.session_id, RequestUsageTable.session_id),
            eq(SessionInputTable.id, RequestUsageTable.request_id),
          ),
        )
        .where(
          and(
            eq(RequestUsageTable.session_id, event.data.sessionID),
            eq(RequestUsageTable.source, "prompt"),
            eq(RequestUsageTable.status, "running"),
            eq(RequestUsageTable.assistant_count, 0),
            eq(RequestUsageTable.root_request_id, RequestUsageTable.request_id),
            isNotNull(SessionInputTable.promoted_seq),
            lte(SessionInputTable.promoted_seq, promoted.promoted_seq),
          ),
        )
      // 根关联仅在第一次 Step.Started 冻结；旧批次零用量成员不能被后续 steer 重新绑定。
      yield* db
        .update(RequestUsageTable)
        .set({
          root_request_id: requestID,
          agent: assistant.agent,
          provider_id: assistant.model.providerID,
          model_id: assistant.model.id,
          variant: assistant.model.variant,
          time_updated: DateTime.toEpochMillis(event.data.timestamp),
        })
        .where(
          and(eq(RequestUsageTable.session_id, event.data.sessionID), inArray(RequestUsageTable.request_id, pending)),
        )
        .run()
        .pipe(Effect.orDie)
    }
    if (event.type === "session.next.step.started")
      yield* db
        .update(RequestUsageTable)
        .set({
          // provider 选择属于 runner；账本记录实际模型，而不是接纳时未解析的会话默认值。
          agent: assistant.agent,
          provider_id: assistant.model.providerID,
          model_id: assistant.model.id,
          variant: assistant.model.variant,
          status: "running",
          time_completed: null,
          error_message: null,
          time_updated: DateTime.toEpochMillis(event.data.timestamp),
        })
        .where(and(eq(RequestUsageTable.session_id, event.data.sessionID), eq(RequestUsageTable.request_id, requestID)))
        .run()
        .pipe(Effect.orDie)
    yield* recordAssistant(
      assistant,
      requestID,
      event.type === "session.next.step.failed" ? event.data.aborted : owned?.status === "aborted",
    )
  })
}

function insertMessage(db: DatabaseService, event: SessionEvent.Event, message: SessionMessage.Message) {
  if (event.durable === undefined) return Effect.die("Durable Session event is missing aggregate sequence")
  const encoded = encodeMessage(message)
  const { id, type, ...data } = encoded
  return db
    .insert(SessionMessageTable)
    .values({
      id: SessionMessage.ID.make(id),
      session_id: event.data.sessionID,
      type,
      seq: event.durable.seq,
      time_created: DateTime.toEpochMillis(message.time.created),
      data,
    })
    .run()
    .pipe(Effect.orDie)
}

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    // #493：sync 与 db 是同一原生连接的两个 facade；投影回调内直接闭包引用，不重复解析服务。
    const { db, sync } = yield* Database.Service
    yield* events.project(SessionV1.Event.Created, (event) =>
      Effect.gen(function* () {
        const stored = yield* db
          .insert(SessionTable)
          .values(sessionRow(event.data.info))
          .onConflictDoNothing()
          .returning({ sessionID: SessionTable.id })
          .get()
          .pipe(Effect.orDie)
        if (!stored) return yield* Effect.die(new SessionAlreadyProjected())
        if (event.data.info.workspaceID) {
          yield* db
            .update(WorkspaceTable)
            .set({ time_used: Date.now() })
            .where(eq(WorkspaceTable.id, event.data.info.workspaceID))
            .run()
            .pipe(Effect.orDie)
        }
      }),
    )
    yield* events.project(SessionV1.Event.Updated, (event) =>
      db
        .update(SessionTable)
        .set(sessionRow(event.data.info))
        .where(eq(SessionTable.id, event.data.sessionID))
        .run()
        .pipe(Effect.orDie),
    )
    yield* events.project(SessionEvent.Moved, (event) =>
      Effect.gen(function* () {
        yield* db
          .update(SessionTable)
          .set({
            directory: event.data.location.directory,
            path: event.data.subdirectory,
            workspace_id: event.data.location.workspaceID ? WorkspaceV2.ID.make(event.data.location.workspaceID) : null,
            time_updated: DateTime.toEpochMillis(event.data.timestamp),
          })
          .where(eq(SessionTable.id, event.data.sessionID))
          .run()
          .pipe(Effect.orDie)
      }),
    )
    yield* events.project(
      SessionV1.Event.Deleted,
      (event) =>
        Effect.gen(function* () {
          // #493：删除 session 前释放其全部 cold owner 引用；release 失败阻止删除（引用计数 invariant）。
          ColdStorage.releaseSession(sync, event.data.sessionID)
          yield* db.delete(SessionTable).where(eq(SessionTable.id, event.data.sessionID)).run().pipe(Effect.orDie)
        }),
      // 同一提交成功后清全部Service图单槽，不依赖公开listener或当前Instance存在。
      (event) => Effect.sync(() => PromptCacheSlots.invalidateSession(event.data.sessionID)),
    )
    yield* events.project(SessionV1.Event.Forked, (event) =>
      Effect.gen(function* () {
        // #493：fork 只复制 raw rows；cold owner 共享同一 hash，父前缀不会先 thaw 成热副本。
        // 旧 fork 逐 PartUpdated 累加 step-finish usage；raw clone 必须在同一投影保留该行为。
        const cloned = ColdStorage.clonePrefix(sync, {
          sourceSessionID: event.data.sourceSessionID,
          sessionID: event.data.targetSessionID,
          messageMap: event.data.messageMap,
          partMap: event.data.partMap,
        })
        for (const part of cloned) {
          const value = usage(part)
          if (value) yield* applyUsage(db, event.data.targetSessionID, value)
        }
      }),
    )
    yield* events.project(SessionV1.Event.MessageUpdated, (event) =>
      Effect.gen(function* () {
        const time_created = event.data.info.time.created
        const id = event.data.info.id
        const sessionID = event.data.info.sessionID
        const data = messageData(event.data.info)
        // #0500：可见/closed 边界变化才失效 aggregate；per-user summary.diffs 只改派生 metadata。
        // 判定必须用 replacement 前的 owner——隐藏旧行后再检查会漏掉 covered-history dirty witness。
        const previous = sync.select().from(MessageTable).where(eq(MessageTable.id, id)).get()
        const moved = previous && previous.session_id !== sessionID
        const changed =
          !event.data.summaryOnly &&
          (previous
            ? moved || summaryMessageSource(previous.data) !== summaryMessageSource(data)
            : summaryMessageSource(data))
        // #493：durable event 携带完整业务 Info；replaceMessage 统一清旧 ref 并落库。
        if (changed && previous && summaryMessageSource(previous.data)) {
          ColdStorage.invalidateSessionSummaryBefore(sync, previous.session_id, id)
        }
        ColdStorage.replaceMessage(sync, {
          id,
          session_id: sessionID,
          time_created,
          data,
        })
        // #0500：per-user summary.diffs 不能让相同 Tool history 的 aggregate 失效（summaryOnly 之外才失效）。
        if (changed && summaryMessageSource(data)) ColdStorage.invalidateSessionSummaryBefore(sync, sessionID, id)
      }),
    )
    yield* events.project(SessionV1.Event.MessageRemoved, (event) =>
      Effect.gen(function* () {
        // #0500：删除前先取 owner 行——可见/closed 的被删 Message 是 summary 失效证据。
        const message = sync
          .select({ data: MessageTable.data })
          .from(MessageTable)
          .where(and(eq(MessageTable.id, event.data.messageID), eq(MessageTable.session_id, event.data.sessionID)))
          .get()
        const rows = yield* db
          .select()
          .from(PartTable)
          .where(and(eq(PartTable.message_id, event.data.messageID), eq(PartTable.session_id, event.data.sessionID)))
          .all()
          .pipe(Effect.orDie)
        for (const row of rows) {
          const previous = usage(row.data)
          if (previous) yield* applyUsage(db, event.data.sessionID, previous, -1)
        }
        // #0500：可见/closed 被删 Message 使其之前窗口的 aggregate 失效。
        if (message && summaryMessageSource(message.data)) {
          ColdStorage.invalidateSessionSummaryBefore(sync, event.data.sessionID, event.data.messageID)
        }
        // #493：删除 Message 前释放其自身与级联 Parts 的 cold 引用（RESTRICT FK 要求先清 ref）。
        ColdStorage.releaseMessage(sync, event.data.messageID, event.data.sessionID)
        yield* db
          .delete(MessageTable)
          .where(and(eq(MessageTable.id, event.data.messageID), eq(MessageTable.session_id, event.data.sessionID)))
          .run()
          .pipe(Effect.orDie)
      }),
    )
    yield* events.project(SessionV1.Event.PartRemoved, (event) =>
      Effect.gen(function* () {
        const row = yield* db
          .select()
          .from(PartTable)
          .where(and(eq(PartTable.id, event.data.partID), eq(PartTable.session_id, event.data.sessionID)))
          .get()
          .pipe(Effect.orDie)
        const previous = row && usage(row.data)
        if (previous) yield* applyUsage(db, event.data.sessionID, previous, -1)
        // #0500：删除前经 inspect 恢复完整 Tool metadata——已完成 Tool 是 summary 失效证据。
        const restored = row ? ColdStorage.inspectPartRows(sync, [row])[0]?.data : undefined
        if (summaryPartSource(restored) !== undefined) {
          ColdStorage.invalidateSessionSummaryBefore(sync, event.data.sessionID, event.data.messageID)
        }
        // #493：删除 Part 前释放其 cold 引用。
        ColdStorage.releasePart(sync, event.data.partID, event.data.sessionID)
        yield* db
          .delete(PartTable)
          .where(and(eq(PartTable.id, event.data.partID), eq(PartTable.session_id, event.data.sessionID)))
          .run()
          .pipe(Effect.orDie)
      }),
    )
    yield* events.project(SessionV1.Event.PartUpdated, (event) =>
      Effect.gen(function* () {
        const id = event.data.part.id
        const messageID = event.data.part.messageID
        const sessionID = event.data.part.sessionID
        const data = partData(event.data.part)
        const row = yield* db.select().from(PartTable).where(eq(PartTable.id, id)).get().pipe(Effect.orDie)
        // #0500：completed Tool metadata 变化或跨父级 move 都使两侧 aggregate 失效。
        const previousPart = row ? ColdStorage.inspectPartRows(sync, [row])[0]?.data : undefined
        const before = summaryPartSource(previousPart)
        const after = summaryPartSource(data)
        const moved = row && (row.session_id !== sessionID || row.message_id !== messageID)
        const changed = moved || !sameSummaryPart(before, after)
        // #493：usage 差量与完整 Part replacement 位于同一投影；cold update 失败不能只提交统计变化。
        // #0500：旧父级在 replace 前失效；跨 Session/Message move 还必须在 replace 后失效新父级。
        if (changed && row && before !== undefined) {
          ColdStorage.invalidateSessionSummaryBefore(sync, row.session_id, row.message_id)
        }
        ColdStorage.replacePart(sync, {
          id,
          message_id: messageID,
          session_id: sessionID,
          time_created: event.data.time,
          data,
        })
        if (changed && after !== undefined) ColdStorage.invalidateSessionSummaryBefore(sync, sessionID, messageID)
        const previous = row && usage(row.data)
        const next = usage(event.data.part)
        if (previous) yield* applyUsage(db, row.session_id, previous, -1)
        if (next) yield* applyUsage(db, sessionID, next)
      }),
    )
    yield* events.project(SessionEvent.AgentSwitched, (event) =>
      db
        .update(SessionTable)
        .set({ agent: event.data.agent, time_updated: DateTime.toEpochMillis(event.data.timestamp) })
        .where(eq(SessionTable.id, event.data.sessionID))
        .run()
        .pipe(Effect.orDie, Effect.andThen(run(db, event))),
    )
    yield* events.project(SessionEvent.ModelSwitched, (event) =>
      Effect.gen(function* () {
        yield* db
          .update(SessionTable)
          .set({ model: event.data.model, time_updated: DateTime.toEpochMillis(event.data.timestamp) })
          .where(eq(SessionTable.id, event.data.sessionID))
          .run()
          .pipe(Effect.orDie)
        yield* run(db, event)
      }),
    )
    yield* events.project(SessionEvent.Prompted, (event) =>
      Effect.gen(function* () {
        if (event.durable === undefined) return yield* Effect.die("Durable Session event is missing aggregate sequence")
        yield* SessionInput.projectPrompted(db, {
          id: event.data.messageID,
          sessionID: event.data.sessionID,
          prompt: event.data.prompt,
          delivery: event.data.delivery,
          timeCreated: event.data.timestamp,
          promotedSeq: event.durable.seq,
        })
        yield* run(db, event)
      }),
    )
    yield* events.project(SessionEvent.PromptAdmitted, (event) =>
      Effect.gen(function* () {
        if (event.durable === undefined) return yield* Effect.die("Durable Session event is missing aggregate sequence")
        yield* SessionInput.projectAdmitted(db, {
          admittedSeq: event.durable.seq,
          id: event.data.messageID,
          sessionID: event.data.sessionID,
          prompt: event.data.prompt,
          delivery: event.data.delivery,
          timeCreated: event.data.timestamp,
        })
        yield* run(db, event)
      }),
    )
    yield* events.project(SessionEvent.PromptFailed, (event) => run(db, event))
    yield* events.project(SessionEvent.PromptCompleted, (event) => run(db, event))
    yield* events.project(SessionEvent.ContextUpdated, (event) => run(db, event))
    yield* events.project(SessionEvent.Synthetic, (event) => run(db, event))
    yield* events.project(SessionEvent.MessagesHidden, (event) => run(db, event))
    yield* events.project(SessionEvent.Shell.Started, (event) => run(db, event))
    yield* events.project(SessionEvent.Shell.Ended, (event) => run(db, event))
    yield* events.project(SessionEvent.Step.Started, (event) => run(db, event))
    yield* events.project(SessionEvent.Step.SnapshotUpdated, (event) => run(db, event))
    yield* events.project(SessionEvent.Step.Ended, (event) =>
      Effect.gen(function* () {
        // 只读取此结算拥有的助手；缺失消息仍沿用 updater 的无操作语义，不制造孤立用量。
        const row = yield* db
          .select()
          .from(SessionMessageTable)
          .where(
            and(
              eq(SessionMessageTable.id, event.data.assistantMessageID),
              eq(SessionMessageTable.session_id, event.data.sessionID),
              eq(SessionMessageTable.type, "assistant"),
            ),
          )
          .get()
          .pipe(Effect.orDie)
        yield* run(db, event)
        if (!row) return
        const previous = decodeMessage({ ...row.data, id: row.id, type: row.type })
        // updater 覆盖同一助手的结算，和 V1 part 修订一样减旧加新，不能把修订再算一轮。
        if (previous.type === "assistant" && previous.cost !== undefined && previous.tokens)
          yield* applyUsage(db, event.data.sessionID, { cost: previous.cost, tokens: previous.tokens }, -1)
        // 复用五项累计与费用写入；与消息同属现有事件事务，重复 replay 在 sequencer 前置去重。
        yield* applyUsage(db, event.data.sessionID, event.data)
      }),
    )
    yield* events.project(SessionEvent.Step.Failed, (event) => run(db, event))
    yield* events.project(SessionEvent.Text.Started, (event) => run(db, event))
    yield* events.project(SessionEvent.Text.Ended, (event) => run(db, event))
    yield* events.project(SessionEvent.Tool.Input.Started, (event) => run(db, event))
    yield* events.project(SessionEvent.Tool.Input.Ended, (event) => run(db, event))
    yield* events.project(SessionEvent.Tool.Called, (event) => run(db, event))
    yield* events.project(SessionEvent.Tool.Progress, (event) => run(db, event))
    yield* events.project(SessionEvent.Tool.Success, (event) => run(db, event))
    yield* events.project(SessionEvent.Tool.Failed, (event) => run(db, event))
    yield* events.project(SessionEvent.Reasoning.Started, (event) => run(db, event))
    yield* events.project(SessionEvent.Reasoning.Ended, (event) => run(db, event))
    yield* events.project(SessionEvent.Retried, (event) => run(db, event))
    yield* events.project(SessionEvent.Compaction.Started, (event) => run(db, event))
    yield* events.project(SessionEvent.Compaction.Ended, (event) => run(db, event))
    yield* events.project(SessionEvent.Compaction.Failed, (event) => run(db, event))
    yield* events.project(SessionEvent.RevertEvent.Staged, (event) =>
      db
        .update(SessionTable)
        .set({
          revert: { ...event.data.revert, files: event.data.revert.files ? [...event.data.revert.files] : undefined },
          time_updated: DateTime.toEpochMillis(event.data.timestamp),
        })
        .where(eq(SessionTable.id, event.data.sessionID))
        .run()
        .pipe(Effect.orDie, Effect.asVoid),
    )
    yield* events.project(SessionEvent.RevertEvent.Cleared, (event) =>
      db
        .update(SessionTable)
        .set({ revert: null, time_updated: DateTime.toEpochMillis(event.data.timestamp) })
        .where(eq(SessionTable.id, event.data.sessionID))
        .run()
        .pipe(Effect.orDie, Effect.asVoid),
    )
    yield* events.project(SessionEvent.RevertEvent.Committed, (event) =>
      Effect.gen(function* () {
        const boundary = yield* db
          .select()
          .from(SessionMessageTable)
          .where(
            and(
              eq(SessionMessageTable.session_id, event.data.sessionID),
              eq(SessionMessageTable.id, event.data.messageID),
            ),
          )
          .get()
          .pipe(Effect.orDie)
        if (!boundary) return yield* Effect.die(`Revert boundary message not found: ${event.data.messageID}`)
        // 只释放即将删除的seq后缀；保留边界用户的附件后再清理其失效摘要。
        ColdStorage.releaseSessionMessageRows(
          sync,
          sync
            .select()
            .from(SessionMessageTable)
            .where(
              and(eq(SessionMessageTable.session_id, event.data.sessionID), gt(SessionMessageTable.seq, boundary.seq)),
            )
            .all(),
        )
        if (boundary.type === "user") ColdStorage.thawSessionMessageRowsInTransaction(sync, [boundary])

        const removed = yield* db
          .delete(SessionMessageTable)
          .where(
            and(eq(SessionMessageTable.session_id, event.data.sessionID), gt(SessionMessageTable.seq, boundary.seq)),
          )
          .returning()
          .all()
          .pipe(Effect.orDie)
        // DELETE 返回实际移除的行，扣数与删消息同事务，不另扫历史或猜测边界用量。
        // 用户边界保留但其助手已被撤销；同事务移除该轮摘要，避免重开后再展示已撤销diff。
        yield* db
          .update(SessionMessageTable)
          .set({
            data: sql`json_remove(${SessionMessageTable.data}, '$.summary')`,
          })
          .where(
            and(
              eq(SessionMessageTable.session_id, event.data.sessionID),
              eq(SessionMessageTable.id, event.data.messageID),
              eq(SessionMessageTable.type, "user"),
            ),
          )
          .run()
          .pipe(Effect.orDie)
        for (const row of removed) {
          if (row.type !== "assistant") continue
          const message = decodeMessage({ ...row.data, id: row.id, type: row.type })
          // token 表示当前保留消息的用量；已经花掉的费用不因 revert 退款。
          if (message.type === "assistant" && message.tokens)
            yield* applyUsage(db, event.data.sessionID, { cost: 0, tokens: message.tokens }, -1)
        }
        yield* db
          .delete(SessionInputTable)
          .where(
            and(
              eq(SessionInputTable.session_id, event.data.sessionID),
              or(gt(SessionInputTable.admitted_seq, boundary.seq), gt(SessionInputTable.promoted_seq, boundary.seq)),
            ),
          )
          .run()
          .pipe(Effect.orDie)
        yield* db
          .update(SessionTable)
          .set({ revert: null, time_updated: DateTime.toEpochMillis(event.data.timestamp) })
          .where(eq(SessionTable.id, event.data.sessionID))
          .run()
          .pipe(Effect.orDie)
      }),
    )
  }),
)

export const node = makeGlobalNode({ name: "session-projector", layer, deps: [EventV2.node, Database.node] })
