import { DateTime, Effect, Schema } from "effect"
import { and, desc, eq, inArray, sql } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import type { ColdStorage } from "@opencode-ai/core/storage/cold-storage"
import type { Sqlite } from "@opencode-ai/core/database/sqlite"
import { EventV2Bridge } from "@/event-v2-bridge"
import {
  MessageTable,
  PartTable,
  SessionTable,
  SessionInputTable,
  SessionMessageTable,
} from "@opencode-ai/core/session/sql"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { RequestUsageTable } from "@opencode-ai/core/session/request-usage.sql"
import { MessageV2 } from "./message-v2"
import { SessionProcessor } from "./processor"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import type { MessageID, SessionID } from "./schema"

// #547：worker 进程级结构化日志——与 worker.ts #235 的 daemon log 同构（目标无 core Log 模块）。
const log = {
  info: (message: string, fields: Record<string, unknown> = {}) => console.log(`[stale-turn] ${message}`, fields),
  error: (message: string, fields: Record<string, unknown> = {}) =>
    console.log(`[stale-turn] [ERROR] ${message}`, fields),
}

// L1 产品范围：最近 16 个活跃 session。
// 不变量 INV-06：启动路径禁止 full part SCAN（1.8GB DB 上约 1–5s）。
export const RECENT_ACTIVE_SESSION_LIMIT = 16
// 孤儿 open-tool SCAN 硬上限。
// 完整 SCAN 在 1.8GB DB 上约 5.3s，必须让位于 worker 5s / CLI stop 10s 的强制层级。
export const ORPHAN_TOOL_SCAN_BUDGET_MS = 2_000
// gracefulShutdown 在 exit-full 后仍需 stop servers + Database.close + clear lock。
// 该余量保证 worker 硬截止不会被 exit-full 吃光，CLI force-kill 不会先于 worker deadline。
export const SAFETY_MARGIN_MS = 500

// #547：scope 词表与 worker 两个调用点一一对应——recent=pre-lock L1，exit-full=退出残余清扫。
export type Scope = { kind: "recent"; limit?: number } | { kind: "exit-full" }

// #547：open 状态集合的精确类型收窄——结构与 processor cleanup 的判定同源。
type OpenToolState = Extract<MessageV2.ToolPart["state"], { status: "pending" | "running" }>
type OpenToolPart = MessageV2.ToolPart & { state: OpenToolState }

// open 仅 pending/running：completed/error 已是终态，重复写入会破坏幂等。
function isOpenToolPart(part: MessageV2.Part): part is OpenToolPart {
  return part.type === "tool" && (part.state.status === "pending" || part.state.status === "running")
}

// 与 SessionPrompt.interruptedToolState 同形。
// 不变量：error 文案与 interrupted metadata 必须匹配 cancel/processor，UI 才渲染「· interrupted」。
function interruptedToolState(state: OpenToolState, now: number) {
  const start = state.status === "running" ? state.time.start : now
  return {
    status: "error",
    input: state.input,
    error: SessionProcessor.TOOL_ABORTED_ERROR,
    metadata: SessionProcessor.interruptedToolMetadata(
      state.status === "running" ? state.metadata : undefined,
      now - start,
    ),
    time: { start, end: now },
  } as Extract<MessageV2.ToolPart["state"], { status: "error" }>
}

// incomplete 检测只读 hot fields（role / time.completed），与 cancelSnapshot 同源，避免为 L1 全量 thaw。
// #547 适配：目标无 MessageV2.Info 导出——以 WithParts["info"]（SessionV1 消息联合）承载。
function hotInfo(row: typeof MessageTable.$inferSelect): MessageV2.WithParts["info"] {
  return {
    ...row.data,
    id: row.id,
    sessionID: row.session_id,
  } as MessageV2.WithParts["info"]
}

// #547 适配：目标 MessageV2.parts 是需 Database.Service 的 cold-aware Effect；
// reconcile 在 Effect Layer 外的启动/退出路径运行，改为 sync drizzle 直查 + decodePartRow
// （与 Session.getPart 同一 row decoder，cold projection 语义不绕过）。
function hotParts(db: ColdStorage.TxOrDb, messageID: MessageID): MessageV2.Part[] {
  return db
    .select()
    .from(PartTable)
    .where(eq(PartTable.message_id, messageID))
    .all()
    .map((row) => MessageV2.decodePartRow(db, row))
}

// #547：recent 排序键 time_updated DESC+id tiebreak——与 TUI 列表默认序一致，用户最可能先打开。
function recentSessionIDs(db: ColdStorage.TxOrDb, limit: number): SessionID[] {
  const roots = db
    .select({ id: SessionTable.id })
    .from(SessionTable)
    .orderBy(desc(SessionTable.time_updated), desc(SessionTable.id))
    .limit(limit)
    .all()
    .map((row) => row.id)
  if (roots.length === 0) return []
  // 子 session（subagent）与 cancel 递归范围一致：parent 在 top-N 时一并终端化。
  // 否则 reviewer/task 子会话 crash 残留不会被 L1 覆盖。
  const children = db
    .select({ id: SessionTable.id })
    .from(SessionTable)
    .where(inArray(SessionTable.parent_id, roots))
    .all()
    .map((row) => row.id)
  return Array.from(new Set([...roots, ...children]))
}

// sessionIDs 缺省表示 exit-full 的 D 步：全库 incomplete assistant（json 扫描，实测约 0.4s）。
// 有 sessionIDs 时是 L1 会话范围查询，保持启动预算。
function incompleteAssistants(db: ColdStorage.TxOrDb, sessionIDs?: SessionID[]) {
  const rows =
    sessionIDs === undefined
      ? db
          .select()
          .from(MessageTable)
          .where(
            and(
              sql`json_extract(${MessageTable.data}, '$.role') = 'assistant'`,
              sql`json_extract(${MessageTable.data}, '$.time.completed') is null`,
            ),
          )
          .all()
      : sessionIDs.length === 0
        ? []
        : db
            .select()
            .from(MessageTable)
            .where(
              and(
                inArray(MessageTable.session_id, sessionIDs),
                sql`json_extract(${MessageTable.data}, '$.role') = 'assistant'`,
                sql`json_extract(${MessageTable.data}, '$.time.completed') is null`,
              ),
            )
            .all()
  return rows.flatMap((row) => {
    const info = hotInfo(row)
    if (info.role !== "assistant" || info.time.completed) return []
    return [{ info, parts: hotParts(db, info.id) }]
  })
}

// usage 表不走事件投影；字段对齐 RequestUsage.complete(status=aborted)。
// 只关 request_usage 行即可清 running 聚合；assistant 子表 parity 非本路径硬要求。
// #547：usage 直写不走事件投影——request_usage 表无投影器；字段与 RequestUsage.complete(aborted) 逐一对齐。
function abortUsageRunning(db: ColdStorage.TxOrDb, sessionIDs?: SessionID[]) {
  const now = Date.now()
  const where =
    sessionIDs === undefined
      ? eq(RequestUsageTable.status, "running")
      : sessionIDs.length === 0
        ? sql`0`
        : and(eq(RequestUsageTable.status, "running"), inArray(RequestUsageTable.session_id, sessionIDs))
  db.update(RequestUsageTable)
    .set({
      status: "aborted",
      time_completed: now,
      time_updated: now,
    })
    // 未提升native inbox的running行仍代表待接纳工作，不能按旧V1全表规则终结。
    .where(
      and(
        where,
        sql`not exists (select 1 from session_input i where i.session_id = ${RequestUsageTable.session_id} and i.id = ${RequestUsageTable.request_id})`,
      ),
    )
    .run()
}

// 单条 incomplete assistant 的 durable 终端化入口。
// Part 先于 Message：与 cancel 顺序一致，避免读到 completed message 仍挂 open tool 的中间态。
// #547 适配：目标 SyncEvent 已删除——durable 写入经 EventV2Bridge.publish（projector 订阅落
// SQLite）。与 source 的 publish:false 差异：bridge 在无 InstanceRef 时也会广播 bus；pre-lock
// 阶段无订阅者无害，exit-full 时已连 TUI 会收到无 directory 事件（SSE 端按 directory 过滤）。
// 可见性不靠 bus：pre-lock L1 完成后 ensure 才放行，首份 HTTP snapshot 已是终态（INV-01 不变）。
type RunEvents = <A, E>(effect: Effect.Effect<A, E, EventV2Bridge.Service>) => Effect.Effect<A, E>

function* writeTerminal(input: {
  sessionID: SessionID
  assistant: MessageV2.Assistant
  parts: MessageV2.Part[]
  now: number
  run: RunEvents
}) {
  yield* input.run(
    EventV2Bridge.Service.use((events) =>
      Effect.gen(function* () {
        for (const part of input.parts.filter(isOpenToolPart)) {
          const next = {
            ...part,
            state: interruptedToolState(part.state, input.now),
          }
          yield* events.publish(
            MessageV2.Event.PartUpdated,
            {
              sessionID: input.sessionID,
              part: structuredClone(next),
              time: input.now,
            },
            { finalizer: true },
          )
        }
        // 浅拷贝后写终态——不改动 incompleteAssistants 读到的快照引用。
        const assistant = { ...input.assistant }
        assistant.time = { ...assistant.time, completed: input.now }
        // error ??= 保留已有终态错误；仅补 MessageAbortedError 以触发 UI interrupted 标签。
        assistant.error ??= new SessionV1.AbortedError({ message: "Aborted" }).toObject()
        // 空 dangling assistant 与 cancel 一致：隐藏以免 UI 留下无内容终态气泡。
        if (input.parts.length === 0) {
          assistant.hidden = { time: input.now, reason: "repair-empty-dangling-assistant" }
        }
        // 复用已确认的原子助手账本提交，状态收尾不能让消费明细与消息分裂。
        yield* SessionProcessor.publishAssistant(assistant, events, true)
      }),
    ),
  )
}

// 幂等：已 completed 的 assistant / 非 open tool 不会进入 incompleteAssistants 集合。
function* terminalizeIncomplete(database: Database.Interface, run: RunEvents, sessionIDs?: SessionID[]) {
  const now = Date.now()
  const items = yield* Database.withSync(database, (db) => incompleteAssistants(db, sessionIDs))
  for (const item of items) {
    yield* writeTerminal({
      sessionID: item.info.sessionID,
      assistant: item.info as MessageV2.Assistant,
      parts: item.parts,
      now,
      run,
    })
  }
  yield* Database.withSync(database, (db) => abortUsageRunning(db, sessionIDs))
}

function* terminalizeOrphanTools(database: Database.Interface, run: RunEvents, deadlineMs: number) {
  // 孤儿 tool：message 已 completed 但 tool 仍 pending/running。
  // cancelSnapshot 只处理 incomplete assistant，因此 half-write 残留必须在 exit-full C 步清掉。
  // 只改 tool part，不改写已 completed message 的 error（保持历史终态语义）。
  // 关键：SCAN 本身必须服从 deadline——1.8GB DB 上 full open-tool SCAN 约 5.3s，禁止 .all() 后再计时。
  // found 只携带定位字段——扫描阶段不解码 part JSON，预算花在行进上。
  const execution = yield* SessionExecution.Service
  const active = yield* execution.active
  const found = yield* Database.withSync(database, (db) => {
    const result: Array<{ id: string; message_id: string; native: number }> = []
    // $client 仅存在于基础 Db（cold-storage 同款 cast）；事务句柄不参与孤儿扫描路径。
    // 两代孤儿共用这一条有界扫描；Native只定位热工具状态，不扫描或恢复冷正文。
    const stmt = (db as Sqlite.DrizzleClient).$client.prepare(`
    SELECT part.id AS id, part.message_id AS message_id, 0 AS native
    FROM part
    INNER JOIN message ON message.id = part.message_id
    WHERE json_extract(part.data, '$.type') = 'tool'
      AND json_extract(part.data, '$.state.status') IN ('pending', 'running')
      AND json_extract(message.data, '$.time.completed') IS NOT NULL
    UNION ALL
    SELECT json_extract(content.value, '$.id') AS id, session_message.id AS message_id, 1 AS native
    FROM session_message, json_each(session_message.data, '$.content') AS content
    WHERE session_message.type = 'assistant'
      AND json_extract(session_message.data, '$.time.completed') IS NOT NULL
      AND json_extract(content.value, '$.type') = 'tool'
      AND json_extract(content.value, '$.state.status') IN ('pending', 'running')
  `)
    for (const row of stmt.iterate() as Iterable<{ id: string; message_id: string; native: number }>) {
      if (Date.now() >= deadlineMs) {
        log.info("orphan tool scan budget exhausted during scan", { collected: result.length })
        break
      }
      result.push(row)
    }
    return result
  })

  // 写阶段时钟单独取样：scan 与 write 之间的耗时不计入 tool 的 executionElapsedMs。
  const now = Date.now()
  for (const row of found) {
    // 写循环同样检查预算：扫描后仍可能耗尽。
    if (Date.now() >= deadlineMs) {
      log.info("orphan tool write budget exhausted", { remaining: found.length })
      return
    }
    if (row.native) {
      const stored = yield* database.db
        .select()
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.id, SessionMessage.ID.make(row.message_id)))
        .get()
        .pipe(Effect.orDie)
      if (!stored || active.has(stored.session_id)) continue
      const message = yield* Schema.decodeUnknownEffect(SessionMessage.Message)({
        ...stored.data,
        id: stored.id,
        type: stored.type,
      }).pipe(Effect.orDie)
      if (message.type !== "assistant" || message.time.completed === undefined) continue
      const part = message.content.find((part) => part.type === "tool" && part.id === row.id)
      if (!part || part.type !== "tool" || (part.state.status !== "pending" && part.state.status !== "running"))
        continue
      // completed助手只收工具终态，不发Step/Prompt失败，不改已确认消费或completed winner。
      yield* run(
        EventV2Bridge.Service.use((events) =>
          events.publish(
            SessionEvent.Tool.Failed,
            {
              sessionID: stored.session_id,
              assistantMessageID: message.id,
              callID: part.id,
              timestamp: DateTime.makeUnsafe(now),
              error: { type: "unknown", message: SessionProcessor.TOOL_ABORTED_ERROR },
              provider: part.provider ?? { executed: false },
            },
            { finalizer: true },
          ),
        ),
      )
      continue
    }
    const part = yield* Database.withSync(database, (db) =>
      hotParts(db, row.message_id as MessageID).find((item) => item.id === row.id),
    )
    if (!part || !isOpenToolPart(part)) continue
    yield* run(
      EventV2Bridge.Service.use((events) =>
        events.publish(
          MessageV2.Event.PartUpdated,
          {
            sessionID: part.sessionID,
            part: structuredClone({ ...part, state: interruptedToolState(part.state, now) }),
            time: now,
          },
          { finalizer: true },
        ),
      ),
    )
  }
}

// native由持久化Step/Prompt归属收尾，不能把尚未提升的inbox或正在运行的coordinator当成崩溃残留。
function* terminalizeNative(database: Database.Interface, run: RunEvents, sessionIDs?: SessionID[]) {
  const execution = yield* SessionExecution.Service
  const active = yield* execution.active
  const timestamp = yield* DateTime.now
  const error = { type: "unknown" as const, message: SessionProcessor.TOOL_ABORTED_ERROR }
  // 先冻结已提升的running请求；Step.Failed可能先将根账本终结，但Prompt终态仍需闭合同批估算。
  const requests = yield* database.db
    .select({
      sessionID: RequestUsageTable.session_id,
      id: SessionInputTable.id,
      root: RequestUsageTable.root_request_id,
    })
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
        eq(RequestUsageTable.status, "running"),
        sql`${SessionInputTable.promoted_seq} is not null`,
        sessionIDs ? inArray(RequestUsageTable.session_id, sessionIDs) : undefined,
      ),
    )
    .all()
    .pipe(Effect.orDie)
  const rows = yield* database.db
    .select()
    .from(SessionMessageTable)
    .where(
      and(
        eq(SessionMessageTable.type, "assistant"),
        sql`json_extract(${SessionMessageTable.data}, '$.time.completed') is null`,
        sessionIDs ? inArray(SessionMessageTable.session_id, sessionIDs) : undefined,
      ),
    )
    .all()
    .pipe(Effect.orDie)
  for (const row of rows) {
    if (active.has(row.session_id)) continue
    const message = yield* Schema.decodeUnknownEffect(SessionMessage.Message)({
      ...row.data,
      id: row.id,
      type: row.type,
    }).pipe(Effect.orDie)
    if (message.type !== "assistant" || message.time.completed !== undefined) continue
    yield* run(
      EventV2Bridge.Service.use((events) =>
        Effect.gen(function* () {
          for (const part of message.content) {
            if (part.type !== "tool" || (part.state.status !== "pending" && part.state.status !== "running")) continue
            yield* events.publish(
              SessionEvent.Tool.Failed,
              {
                sessionID: row.session_id,
                assistantMessageID: message.id,
                callID: part.id,
                timestamp,
                error,
                provider: part.provider ?? { executed: false },
              },
              { finalizer: true },
            )
          }
          // 原生projector保留已确认成本并更新助手明细，不伪造V1消息或直接覆写累计。
          yield* events.publish(
            SessionEvent.Step.Failed,
            {
              sessionID: row.session_id,
              assistantMessageID: message.id,
              timestamp,
              error: message.error ?? error,
              aborted: true,
            },
            { finalizer: true },
          )
        }),
      ),
    )
  }
  const batches = new Map<string, { sessionID: SessionID; root: string; ids: SessionMessage.ID[] }>()
  for (const request of requests) {
    if (active.has(request.sessionID)) continue
    const key = `${request.sessionID}\0${request.root}`
    const batch = batches.get(key)
    if (batch) batch.ids.push(request.id)
    else batches.set(key, { sessionID: request.sessionID, root: request.root, ids: [request.id] })
  }
  for (const batch of batches.values())
    yield* run(
      EventV2Bridge.Service.use((events) =>
        events.publish(
          SessionEvent.PromptFailed,
          {
            sessionID: batch.sessionID,
            messageID: SessionMessage.ID.make(batch.root),
            requestIDs: batch.ids,
            timestamp,
            error,
            aborted: true,
          },
          { finalizer: true },
        ),
      ),
    )
}

/**
 * owner 切换时的 durable 中断 reconcile。
 * recent：启动 L1，必须在 ServerLock.write 之前调用。
 * exit-full：优雅退出，必须在 dispose 之后、Database.close 之前，并带 residual budgetMs。
 */
export const reconcile = Effect.fn("SessionStaleTurn.reconcile")(function* (
  scope: Scope,
  opts?: { budgetMs?: number },
) {
  const database = yield* Database.Service
  const events = yield* EventV2Bridge.Service
  const run: RunEvents = (effect) => effect.pipe(Effect.provideService(EventV2Bridge.Service, events))
  if (scope.kind === "recent") {
    // recent 不扫描孤儿 completed-message tools：L1 只修用户最可能打开的 streaming 会话。
    // 孤儿清理由 exit-full C 步或下次 graceful stop 承担（产品 L1 延迟预算约束）。
    const limit = scope.limit ?? RECENT_ACTIVE_SESSION_LIMIT
    const sessionIDs = yield* Database.withSync(database, (db) => recentSessionIDs(db, limit))
    yield* terminalizeIncomplete(database, run, sessionIDs)
    yield* terminalizeNative(database, run, sessionIDs)
    return
  }

  // exit-full：仅在 worker residual budget 内运行。
  // budgetMs<=0 表示 dispose 已吃光 5s 窗口，整段跳过，残留交给下次 pre-lock L1。
  // budgetMs 缺省按 0：非 worker 调用方（测试直调）必须显式传预算才执行 exit-full。
  const budgetMs = opts?.budgetMs ?? 0
  if (budgetMs <= 0) {
    log.info("exit-full skipped: no residual budget")
    return
  }
  // deadline 是软预算：D/E 完成后剩余才给 C，越界立即返回而非补偿重试。
  const deadline = Date.now() + budgetMs
  // D+E 优先：incomplete assistant / open tools / running usage 是用户可见 streaming 的主因。
  const execution = yield* SessionExecution.Service
  // 先等待真实native所有权链退出，再读持久残留；不使用resume/wake制造模型工作。
  const active = yield* execution.active
  yield* Effect.forEach(active, (id) => execution.interrupt(id), { concurrency: "unbounded", discard: true })
  yield* terminalizeIncomplete(database, run)
  yield* terminalizeNative(database, run)
  if (Date.now() >= deadline) {
    log.info("exit-full stopped after D/E: budget exhausted")
    return
  }
  // C 步 best-effort：孤儿 open-tool 再占 min(2000ms, 剩余预算)。
  const orphanBudget = Math.min(ORPHAN_TOOL_SCAN_BUDGET_MS, deadline - Date.now())
  if (orphanBudget <= 0) return
  yield* terminalizeOrphanTools(database, run, Date.now() + orphanBudget)
})

export * as SessionStaleTurn from "./stale-turn"
