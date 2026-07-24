import { Effect } from "effect"
import { and, desc, eq, inArray, sql } from "drizzle-orm"
import { AppRuntime } from "@/effect/app-runtime"
import { Database } from "@/storage/db"
import { Log } from "@opencode-ai/core/util/log"
import { SyncEvent } from "@/sync"
import { MessageTable, SessionTable } from "./session.sql"
import { RequestUsageTable } from "./request-usage.sql"
import { MessageV2 } from "./message-v2"
import { SessionProcessor } from "./processor"
import type { MessageID, SessionID } from "./schema"

const log = Log.create({ service: "session.stale-turn" })

// L1 产品范围：最近 16 个活跃 session。
// 不变量 INV-06：启动路径禁止 full part SCAN（1.8GB DB 上约 1–5s）。
export const RECENT_ACTIVE_SESSION_LIMIT = 16
// 孤儿 open-tool SCAN 硬上限。
// 完整 SCAN 在 1.8GB DB 上约 5.3s，必须让位于 worker 5s / CLI stop 10s 的强制层级。
export const ORPHAN_TOOL_SCAN_BUDGET_MS = 2_000
// gracefulShutdown 在 exit-full 后仍需 stop servers + Database.close + clear lock。
// 该余量保证 worker 硬截止不会被 exit-full 吃光，CLI force-kill 不会先于 worker deadline。
export const SAFETY_MARGIN_MS = 500

export type Scope = { kind: "recent"; limit?: number } | { kind: "exit-full" }

type OpenToolPart = MessageV2.ToolPart & {
  state: MessageV2.ToolStatePending | MessageV2.ToolStateRunning
}

// open 仅 pending/running：completed/error 已是终态，重复写入会破坏幂等。
function isOpenToolPart(part: MessageV2.Part): part is OpenToolPart {
  return part.type === "tool" && (part.state.status === "pending" || part.state.status === "running")
}

// 与 SessionPrompt.interruptedToolState 同形。
// 不变量：error 文案与 interrupted metadata 必须匹配 cancel/processor，UI 才渲染 “· interrupted”。
function interruptedToolState(
  state: MessageV2.ToolStatePending | MessageV2.ToolStateRunning,
  now: number,
): MessageV2.ToolStateError {
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
  }
}

// incomplete 检测只读 hot fields（role / time.completed），与 cancelSnapshot 同源，避免为 L1 全量 thaw。
function hotInfo(row: typeof MessageTable.$inferSelect): MessageV2.Info {
  return {
    ...row.data,
    id: row.id,
    sessionID: row.session_id,
  } as MessageV2.Info
}

function recentSessionIDs(limit: number): SessionID[] {
  return Database.use((db) => {
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
  })
}

// sessionIDs 缺省表示 exit-full 的 D 步：全库 incomplete assistant（json 扫描，实测约 0.4s）。
// 有 sessionIDs 时是 L1 会话范围查询，保持启动预算。
function incompleteAssistants(sessionIDs?: SessionID[]) {
  return Database.use((db) => {
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
      return [{ info, parts: MessageV2.parts(info.id) }]
    })
  })
}

// usage 表不走 SyncEvent；字段对齐 RequestUsage.complete(status=aborted)。
// 只关 request_usage 行即可清 running 聚合；assistant 子表 parity 非本路径硬要求。
function abortUsageRunning(sessionIDs?: SessionID[]) {
  const now = Date.now()
  Database.use((db) => {
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
      .where(where)
      .run()
  })
}

// 单条 incomplete assistant 的 durable 终端化事务入口。
// Part 先于 Message：与 cancel 顺序一致，避免读到 completed message 仍挂 open tool 的中间态。
async function writeTerminal(input: {
  sessionID: SessionID
  assistant: MessageV2.Assistant
  parts: MessageV2.Part[]
  now: number
}) {
  // publish:false：worker 进程级 owner 切换没有 directory InstanceRef。
  // 不变量 INV-08：禁止 Session.update* 默认 publish（会 yield InstanceState.context）。
  // 可见性不靠 bus：pre-lock L1 完成后 ensure 才放行，首份 HTTP snapshot 已是终态。
  await AppRuntime.runPromise(
    SyncEvent.Service.use((sync) =>
      Effect.gen(function* () {
        for (const part of input.parts.filter(isOpenToolPart)) {
          const next = {
            ...part,
            state: interruptedToolState(part.state, input.now),
          }
          yield* sync.run(
            MessageV2.Event.PartUpdated,
            { sessionID: input.sessionID, part: structuredClone(next), time: input.now },
            { publish: false },
          )
        }
        const assistant = { ...input.assistant }
        assistant.time = { ...assistant.time, completed: input.now }
        // error ??= 保留已有终态错误；仅补 MessageAbortedError 以触发 UI interrupted 标签。
        assistant.error ??= new MessageV2.AbortedError({ message: "Aborted" }).toObject()
        // 空 dangling assistant 与 cancel 一致：隐藏以免 UI 留下无内容终态气泡。
        if (input.parts.length === 0) {
          assistant.hidden = { time: input.now, reason: "repair-empty-dangling-assistant" }
        }
        yield* sync.run(
          MessageV2.Event.Updated,
          { sessionID: input.sessionID, info: assistant },
          { publish: false },
        )
      }),
    ),
  )
}

// 幂等：已 completed 的 assistant / 非 open tool 不会进入 incompleteAssistants 集合。
async function terminalizeIncomplete(sessionIDs?: SessionID[]) {
  const now = Date.now()
  for (const item of incompleteAssistants(sessionIDs)) {
    await writeTerminal({
      sessionID: item.info.sessionID,
      assistant: item.info,
      parts: item.parts,
      now,
    })
  }
  abortUsageRunning(sessionIDs)
}

async function terminalizeOrphanTools(deadlineMs: number) {
  // 孤儿 tool：message 已 completed 但 tool 仍 pending/running。
  // cancelSnapshot 只处理 incomplete assistant，因此 half-write 残留必须在 exit-full C 步清掉。
  // 只改 tool part，不改写已 completed message 的 error（保持历史终态语义）。
  // 关键：SCAN 本身必须服从 deadline——1.8GB DB 上 full open-tool SCAN 约 5.3s，禁止 .all() 后再计时。
  const found: Array<{ id: string; message_id: string }> = []
  const stmt = Database.Client().$client.prepare(`
    SELECT part.id AS id, part.message_id AS message_id
    FROM part
    INNER JOIN message ON message.id = part.message_id
    WHERE json_extract(part.data, '$.type') = 'tool'
      AND json_extract(part.data, '$.state.status') IN ('pending', 'running')
      AND json_extract(message.data, '$.time.completed') IS NOT NULL
  `)
  for (const row of stmt.iterate() as Iterable<{ id: string; message_id: string }>) {
    if (Date.now() >= deadlineMs) {
      log.info("orphan tool scan budget exhausted during scan", { collected: found.length })
      break
    }
    found.push(row)
  }

  const now = Date.now()
  for (const row of found) {
    // 写循环同样检查预算：扫描后仍可能耗尽。
    if (Date.now() >= deadlineMs) {
      log.info("orphan tool write budget exhausted", { remaining: found.length })
      return
    }
    const part = MessageV2.parts(row.message_id as MessageID).find((item) => item.id === row.id)
    if (!part || !isOpenToolPart(part)) continue
    await AppRuntime.runPromise(
      SyncEvent.Service.use((sync) =>
        sync.run(
          MessageV2.Event.PartUpdated,
          {
            sessionID: part.sessionID,
            part: structuredClone({ ...part, state: interruptedToolState(part.state, now) }),
            time: now,
          },
          { publish: false },
        ),
      ),
    )
  }
}

/**
 * owner 切换时的 durable 中断 reconcile。
 * recent：启动 L1，必须在 ServerLock.write 之前调用。
 * exit-full：优雅退出，必须在 dispose 之后、Database.close 之前，并带 residual budgetMs。
 */
export async function reconcile(scope: Scope, opts?: { budgetMs?: number }) {
  if (scope.kind === "recent") {
    // recent 不扫描孤儿 completed-message tools：L1 只修用户最可能打开的 streaming 会话。
    // 孤儿清理由 exit-full C 步或下次 graceful stop 承担（产品 L1 延迟预算约束）。
    const limit = scope.limit ?? RECENT_ACTIVE_SESSION_LIMIT
    const sessionIDs = recentSessionIDs(limit)
    await terminalizeIncomplete(sessionIDs)
    return
  }

  // exit-full：仅在 worker residual budget 内运行。
  // budgetMs<=0 表示 dispose 已吃光 5s 窗口，整段跳过，残留交给下次 pre-lock L1。
  const budgetMs = opts?.budgetMs ?? 0
  if (budgetMs <= 0) {
    log.info("exit-full skipped: no residual budget")
    return
  }
  const deadline = Date.now() + budgetMs
  // D+E 优先：incomplete assistant / open tools / running usage 是用户可见 streaming 的主因。
  await terminalizeIncomplete()
  if (Date.now() >= deadline) {
    log.info("exit-full stopped after D/E: budget exhausted")
    return
  }
  // C 步 best-effort：孤儿 open-tool 再占 min(2000ms, 剩余预算)。
  const orphanBudget = Math.min(ORPHAN_TOOL_SCAN_BUDGET_MS, deadline - Date.now())
  if (orphanBudget <= 0) return
  await terminalizeOrphanTools(Date.now() + orphanBudget)
}

export * as SessionStaleTurn from "./stale-turn"
