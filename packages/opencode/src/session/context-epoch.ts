import { eq, sql } from "drizzle-orm"
import { Effect, Schema } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { NotFoundError } from "@/storage/storage"
import { MessageID, SessionID } from "./schema"

// 持久形状沿用来源命名空间与baseline；日期更新保存完整System编码，wire适配仍归prompt。
const SourceSnapshot = Schema.Struct({ value: Schema.String })
const SystemMessage = Schema.Struct({
  id: MessageID,
  type: Schema.Literal("system"),
  time: Schema.Struct({ created: Schema.Number }),
  text: Schema.String,
})
export const Update = Schema.Struct({ after_message_id: MessageID, message: SystemMessage })
export type Update = typeof Update.Type
export const Stored = Schema.Struct({
  baseline: Schema.String,
  snapshot: Schema.Struct({ "smark/git": SourceSnapshot, "core/date": SourceSnapshot }),
  boundary: Schema.String,
  updates: Schema.Array(Update),
})
export type Stored = typeof Stored.Type
export interface History {
  readonly boundary: string
  readonly messageIDs: readonly MessageID[]
}

// 新代只重建日期，Git沿用已保存值；不从工作区写文件，也不维护进程级Session缓存。
const generation = (git: string, today: string, boundary: string): Stored => ({
  baseline: `${git}\nToday's date: ${today}`,
  snapshot: { "smark/git": { value: git }, "core/date": { value: today } },
  boundary,
  updates: [],
})

const reconcile = (
  stored: Stored,
  now: Date,
  history: History,
): { readonly _tag: "unchanged" | "changed"; readonly value: Stored } => {
  const today = now.toDateString()
  // compaction换代或undo隐藏锚点都会退休旧日期更新；两者都不能重新采集Git。
  const anchorsVisible = stored.updates.every((update) => history.messageIDs.includes(update.after_message_id))
  if (stored.boundary !== history.boundary || !anchorsVisible) {
    return { _tag: "changed", value: generation(stored.snapshot["smark/git"].value, today, history.boundary) }
  }
  if (stored.snapshot["core/date"].value === today) return { _tag: "unchanged", value: stored }
  const anchor = history.messageIDs.at(-1)
  // 空窗口没有可锚定消息；只重建当前日期baseline，不制造悬空更新。
  if (!anchor)
    return { _tag: "changed", value: generation(stored.snapshot["smark/git"].value, today, history.boundary) }
  const update: Update = {
    after_message_id: anchor,
    message: {
      id: MessageID.ascending(),
      type: "system",
      time: { created: now.getTime() },
      text: `Today's date is now: ${today}`,
    },
  }
  return {
    _tag: "changed",
    value: {
      ...stored,
      snapshot: { ...stored.snapshot, "core/date": { value: today } },
      updates: [...stored.updates, update],
    },
  }
}

export const prepare = Effect.fn("SessionContextEpoch.prepare")(function* (input: {
  sessionID: SessionID
  history: History
  now: Date
  captureGit: Effect.Effect<string>
}) {
  const database = yield* Database.Service
  // withSync预约当前Effect层的同一原生连接，不另开DB或跨await持有事务。
  const row = yield* Database.withSync(database, (db) =>
    db
      .select({ epoch: SessionTable.context_epoch })
      .from(SessionTable)
      .where(eq(SessionTable.id, input.sessionID))
      .get(),
  )
  if (!row) return yield* new NotFoundError({ message: `Session not found: ${input.sessionID}` })
  if (row.epoch !== null) {
    const stored = Schema.decodeUnknownSync(Stored)(row.epoch)
    const result = reconcile(stored, input.now, input.history)
    // 同日同窗口只读，不拿写锁、不更新Session排序时间。
    if (result._tag === "unchanged") return stored
    return yield* Database.withSync(database, (db) =>
      db.transaction(
        (tx) => {
          const fresh = tx
            .select({ epoch: SessionTable.context_epoch })
            .from(SessionTable)
            .where(eq(SessionTable.id, input.sessionID))
            .get()
          if (!fresh) throw new Error(`Session deleted during context epoch update: ${input.sessionID}`)
          // immediate内重读胜者；并发请求不能各自产生同一日期更新。
          const winner = reconcile(Schema.decodeUnknownSync(Stored)(fresh.epoch), input.now, input.history)
          if (winner._tag !== "unchanged") write(tx, input.sessionID, winner.value)
          return winner.value
        },
        { behavior: "immediate" },
      ),
    )
  }
  // Git在事务外采集；最终采用事务内已提交的胜者，不覆盖另一个初始化者的快照。
  const git = yield* input.captureGit
  return yield* Database.withSync(database, (db) =>
    db.transaction(
      (tx) => {
        const fresh = tx
          .select({ epoch: SessionTable.context_epoch })
          .from(SessionTable)
          .where(eq(SessionTable.id, input.sessionID))
          .get()
        if (!fresh) throw new Error(`Session deleted during context epoch initialization: ${input.sessionID}`)
        if (fresh.epoch !== null) return Schema.decodeUnknownSync(Stored)(fresh.epoch)
        const created = generation(git, input.now.toDateString(), input.history.boundary)
        write(tx, input.sessionID, created)
        return created
      },
      { behavior: "immediate" },
    ),
  )
})

// 只更新私有列，显式保留time_updated，避免环境准备改变Session排序。
const write = (tx: Pick<Database.Interface["sync"], "update">, sessionID: SessionID, value: Stored) =>
  tx
    .update(SessionTable)
    .set({ context_epoch: value, time_updated: sql`${SessionTable.time_updated}` })
    .where(eq(SessionTable.id, sessionID))
    .run()

export interface UpdatePlacement {
  readonly placement:
    | { readonly type: "after"; readonly id: MessageID }
    | { readonly type: "before"; readonly id: MessageID }
    | { readonly type: "end" }
  readonly text: string
}

export function projectUpdates(input: {
  updates: readonly Update[]
  canonicalIDs: readonly MessageID[]
  retainedIDs: ReadonlySet<MessageID>
}): UpdatePlacement[] {
  // 每条更新仅放一次；裁剪不改canonical顺序，tool-call/result完整块不会被插开。
  return input.updates.map((update) => {
    const anchor = update.after_message_id
    if (input.retainedIDs.has(anchor)) return { placement: { type: "after", id: anchor }, text: update.message.text }
    const order = input.canonicalIDs.indexOf(anchor)
    const successor =
      order < 0 ? undefined : input.canonicalIDs.slice(order + 1).find((id) => input.retainedIDs.has(id))
    return successor
      ? { placement: { type: "before", id: successor }, text: update.message.text }
      : { placement: { type: "end" }, text: update.message.text }
  })
}

export * as SessionContextEpoch from "./context-epoch"
