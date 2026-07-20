import { NotFoundError } from "@/storage/storage"
import { eq } from "drizzle-orm"
import { and } from "drizzle-orm"
import { sql } from "drizzle-orm"
import type { TxOrDb } from "@/storage/db"
import { SyncEvent } from "@/sync"
import * as Session from "./session"
import { MessageV2 } from "./message-v2"
import { SessionTable, MessageTable, PartTable } from "./session.sql"
import { WorkspaceTable } from "@/control-plane/workspace.sql"
import { ColdStorage } from "@/storage/cold"
import { Log } from "@opencode-ai/core/util/log"
import nextProjectors from "./projectors-next"

const log = Log.create({ service: "session.projector" })

function foreign(err: unknown) {
  if (typeof err !== "object" || err === null) return false
  if ("code" in err && err.code === "SQLITE_CONSTRAINT_FOREIGNKEY") return true
  return "message" in err && typeof err.message === "string" && err.message.includes("FOREIGN KEY constraint failed")
}

export type DeepPartial<T> = T extends object ? { [K in keyof T]?: DeepPartial<T[K]> | null } : T

type Usage = Pick<MessageV2.StepFinishPart, "cost" | "tokens">

function usage(part: MessageV2.Part | (typeof PartTable.$inferSelect)["data"]): Usage | undefined {
  if (part.type !== "step-finish") return undefined
  if (!("cost" in part) || !("tokens" in part)) return undefined
  return { cost: part.cost, tokens: part.tokens }
}

function applyUsage(db: TxOrDb, sessionID: Session.Info["id"], value: Usage, sign = 1) {
  db.update(SessionTable)
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
}

function summaryMessageSource(data: (typeof MessageTable.$inferSelect)["data"]) {
  if (data.hidden) return false
  if (data.role === "user") return true
  return data.time.completed !== undefined
}

function summaryPartSource(data: (typeof PartTable.$inferSelect)["data"] | undefined) {
  if (!data || data.hidden || data.type !== "tool" || data.state.status !== "completed") return undefined
  return data.state.metadata
}

function sameSummaryPart(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right)
}

function grab<T extends object, K1 extends keyof T, X>(
  obj: T,
  field1: K1,
  cb?: (val: NonNullable<T[K1]>) => X,
): X | undefined {
  if (obj == undefined || !(field1 in obj)) return undefined

  const val = obj[field1]
  if (val && typeof val === "object" && cb) {
    return cb(val)
  }
  if (val === undefined) {
    throw new Error(
      "Session update failure: pass `null` to clear a field instead of `undefined`: " + JSON.stringify(obj),
    )
  }
  return val as X | undefined
}

export function toPartialRow(info: DeepPartial<Session.Info>) {
  const obj = {
    id: grab(info, "id"),
    project_id: grab(info, "projectID"),
    workspace_id: grab(info, "workspaceID"),
    parent_id: grab(info, "parentID"),
    slug: grab(info, "slug"),
    directory: grab(info, "directory"),
    path: grab(info, "path"),
    title: grab(info, "title"),
    version: grab(info, "version"),
    share_url: grab(info, "share", (v) => grab(v, "url")),
    summary_additions: grab(info, "summary", (v) => grab(v, "additions")),
    summary_deletions: grab(info, "summary", (v) => grab(v, "deletions")),
    summary_files: grab(info, "summary", (v) => grab(v, "files")),
    summary_diffs: grab(info, "summary", (v) => grab(v, "diffs")),
    cost: grab(info, "cost"),
    tokens_input: grab(info, "tokens", (v) => grab(v, "input")),
    tokens_output: grab(info, "tokens", (v) => grab(v, "output")),
    tokens_reasoning: grab(info, "tokens", (v) => grab(v, "reasoning")),
    tokens_cache_read: grab(info, "tokens", (v) => grab(v, "cache", (cache) => grab(cache, "read"))),
    tokens_cache_write: grab(info, "tokens", (v) => grab(v, "cache", (cache) => grab(cache, "write"))),
    revert: grab(info, "revert"),
    permission: grab(info, "permission"),
    time_created: grab(info, "time", (v) => grab(v, "created")),
    time_updated: grab(info, "time", (v) => grab(v, "updated")),
    time_compacting: grab(info, "time", (v) => grab(v, "compacting")),
    time_archived: grab(info, "time", (v) => grab(v, "archived")),
  }

  return Object.fromEntries(Object.entries(obj).filter(([_, val]) => val !== undefined))
}

export default [
  SyncEvent.project(Session.Event.Created, (db, data) => {
    db.insert(SessionTable)
      .values(Session.toRow(data.info as Session.Info))
      .run()

    if (data.info.workspaceID) {
      db.update(WorkspaceTable).set({ time_used: Date.now() }).where(eq(WorkspaceTable.id, data.info.workspaceID)).run()
    }
  }),

  SyncEvent.project(Session.Event.Updated, (db, data) => {
    const info = data.info
    const row = db
      .update(SessionTable)
      .set({ time_updated: sql`${SessionTable.time_updated}`, ...toPartialRow(info as Session.Patch) })
      .where(eq(SessionTable.id, data.sessionID))
      .returning()
      .get()
    if (!row) throw new NotFoundError({ message: `Session not found: ${data.sessionID}` })
  }),

  SyncEvent.project(Session.Event.Deleted, (db, data) => {
    ColdStorage.releaseSession(db, data.sessionID)
    db.delete(SessionTable).where(eq(SessionTable.id, data.sessionID)).run()
  }),

  SyncEvent.project(Session.Event.Forked, (db, data) => {
    // fork 只复制 raw rows；cold owner 共享同一 hash，避免业务 hydrate 把父前缀先 thaw 成热副本。
    // clonePrefix 与 EventSequence 投影共享 immediate transaction，owner/ref 任一步失败都会整体回滚。
    // projector 不发布逐 Message/Part update event，避免 fork 前缀产生大量中间可观察状态。
    const parts = ColdStorage.clonePrefix(db, data)
    // 旧 fork 逐 PartUpdated 时会累加 step-finish usage；raw clone 必须在同一 projector transaction 保留该行为。
    // storage 只返回已复制的 raw data，usage owner 仍在 projector，不能把 Session totals 计算下沉到 cold module。
    for (const part of parts) {
      const value = usage(part)
      if (value) applyUsage(db, data.sessionID, value)
    }
  }),

  SyncEvent.project(MessageV2.Event.Updated, (db, data) => {
    const time_created = data.info.time.created
    const { id, sessionID, ...rest } = data.info
    const previous = db.select().from(MessageTable).where(eq(MessageTable.id, id)).get()
    const moved = previous && previous.session_id !== sessionID
    const changed =
      !data.summaryOnly &&
      (previous ? moved || summaryMessageSource(previous.data) !== summaryMessageSource(rest) : summaryMessageSource(rest))

    try {
      // durable event 携带完整业务 Info；replaceMessage 统一清旧 ref，projector 不猜测冷字段 touched mask。
      // 可见/closed 边界必须用 replacement 前的 owner 判断；隐藏旧行后再检查会漏掉 covered-history dirty witness。
      if (changed && previous && summaryMessageSource(previous.data)) {
        ColdStorage.invalidateSessionSummaryBefore(db, previous.session_id, id)
      }
      ColdStorage.replaceMessage(db, {
        id,
        session_id: sessionID,
        time_created,
        data: rest,
      })
      // per-user summary.diffs 只改变派生 metadata；它不能让相同 Tool history 的 aggregate 失效。
      if (changed && summaryMessageSource(rest)) ColdStorage.invalidateSessionSummaryBefore(db, sessionID, id)
    } catch (err) {
      if (!foreign(err)) throw err
      log.warn("ignored late message update", { messageID: id, sessionID })
    }
  }),

  SyncEvent.project(MessageV2.Event.Removed, (db, data) => {
    const message = db
      .select({ data: MessageTable.data })
      .from(MessageTable)
      .where(and(eq(MessageTable.id, data.messageID), eq(MessageTable.session_id, data.sessionID)))
      .get()
    for (const row of db
      .select()
      .from(PartTable)
      .where(and(eq(PartTable.message_id, data.messageID), eq(PartTable.session_id, data.sessionID)))
      .all()) {
      const previous = usage(row.data)
      if (previous) applyUsage(db, data.sessionID, previous, -1)
    }
    if (message && summaryMessageSource(message.data)) {
      ColdStorage.invalidateSessionSummaryBefore(db, data.sessionID, data.messageID)
    }
    ColdStorage.releaseMessage(db, data.messageID, data.sessionID)
    db.delete(MessageTable)
      .where(and(eq(MessageTable.id, data.messageID), eq(MessageTable.session_id, data.sessionID)))
      .run()
  }),

  SyncEvent.project(MessageV2.Event.PartRemoved, (db, data) => {
    const row = db
      .select()
      .from(PartTable)
      .where(and(eq(PartTable.id, data.partID), eq(PartTable.session_id, data.sessionID)))
      .get()
    const previous = row && usage(row.data)
    if (previous) applyUsage(db, data.sessionID, previous, -1)

    const restored = row ? ColdStorage.inspectPartRows(db, [row])[0]?.data : undefined
    if (summaryPartSource(restored) !== undefined) {
      ColdStorage.invalidateSessionSummaryBefore(db, data.sessionID, data.messageID)
    }
    ColdStorage.releasePart(db, data.partID, data.sessionID)
    db.delete(PartTable)
      .where(and(eq(PartTable.id, data.partID), eq(PartTable.session_id, data.sessionID)))
      .run()
  }),

  SyncEvent.project(MessageV2.Event.PartUpdated, (db, data) => {
    const { id, messageID, sessionID, ...rest } = data.part
    const row = db.select().from(PartTable).where(eq(PartTable.id, id)).get()
    const previous = row ? ColdStorage.inspectPartRows(db, [row])[0]?.data : undefined
    const before = summaryPartSource(previous)
    const after = summaryPartSource(rest)
    const moved = row && (row.session_id !== sessionID || row.message_id !== messageID)
    const changed = moved || !sameSummaryPart(before, after)

    try {
      // usage 差量与完整 Part replacement 位于同一 transaction，cold update 失败不能只提交统计变化。
      // 旧父级在 replace 前失效；跨 Session/Message move 还必须在 replace 后失效新父级，不能只修一侧 aggregate。
      if (changed && row && before !== undefined) {
        ColdStorage.invalidateSessionSummaryBefore(db, row.session_id, row.message_id)
      }
      ColdStorage.replacePart(db, {
        id,
        message_id: messageID,
        session_id: sessionID,
        time_created: data.time,
        data: rest,
      })
      if (changed && after !== undefined) ColdStorage.invalidateSessionSummaryBefore(db, sessionID, messageID)
      const previous = row && usage(row.data)
      const next = usage(data.part)
      if (previous) applyUsage(db, row.session_id, previous, -1)
      if (next) applyUsage(db, sessionID, next)
    } catch (err) {
      if (!foreign(err)) throw err
      log.warn("ignored late part update", { partID: id, messageID, sessionID })
    }
  }),

  ...nextProjectors,
]
