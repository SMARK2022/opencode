import { and, asc, desc, eq, gt, gte, lte, ne, or } from "drizzle-orm"
import { Effect, Schema } from "effect"
import { Database } from "../database/database"
import { MessageDecodeError } from "./error"
import { SessionMessage } from "./message"
import { SessionSchema } from "./schema"
import { SessionContextEpochTable, SessionMessageTable } from "./sql"

type DatabaseService = Database.Interface["db"]

const decode = Schema.decodeUnknownEffect(SessionMessage.Message)
const hidden = Schema.is(SessionMessage.Hidden)

export const latestCompaction = Effect.fnUntraced(function* (db: DatabaseService, sessionID: SessionSchema.ID) {
  return yield* db
    .select({ seq: SessionMessageTable.seq })
    .from(SessionMessageTable)
    .where(and(eq(SessionMessageTable.session_id, sessionID), eq(SessionMessageTable.type, "compaction")))
    .orderBy(desc(SessionMessageTable.seq))
    .limit(1)
    .get()
    .pipe(Effect.orDie)
})

const messageRows = Effect.fnUntraced(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  compaction: { readonly seq: number } | undefined,
  baselineSeq?: number,
) {
  const rows = yield* db
    .select()
    .from(SessionMessageTable)
    .where(
      and(
        eq(SessionMessageTable.session_id, sessionID),
        compaction
          ? or(
              gte(SessionMessageTable.seq, compaction.seq),
              baselineSeq === undefined
                ? undefined
                : and(eq(SessionMessageTable.type, "system"), gt(SessionMessageTable.seq, baselineSeq)),
            )
          : undefined,
        baselineSeq === undefined
          ? undefined
          : or(ne(SessionMessageTable.type, "system"), gt(SessionMessageTable.seq, baselineSeq)),
      ),
    )
    .orderBy(asc(SessionMessageTable.seq))
    .all()
    .pipe(Effect.orDie)
  return rows
})

const decodeMessageRow = (row: typeof SessionMessageTable.$inferSelect) =>
  decode({ ...row.data, id: row.id, type: row.type }).pipe(
    Effect.mapError(
      () =>
        new MessageDecodeError({
          sessionID: SessionSchema.ID.make(row.session_id),
          messageID: SessionMessage.ID.make(row.id),
        }),
    ),
  )

export const load = Effect.fn("SessionHistory.load")(function* (db: DatabaseService, sessionID: SessionSchema.ID) {
  const [epoch, compaction] = yield* Effect.all(
    [
      db
        .select({ baselineSeq: SessionContextEpochTable.baseline_seq })
        .from(SessionContextEpochTable)
        .where(eq(SessionContextEpochTable.session_id, sessionID))
        .get()
        .pipe(Effect.orDie),
      latestCompaction(db, sessionID),
    ],
    { concurrency: "unbounded" },
  )
  // 普通模型历史排除失败协议轮次；原始message/messages读取仍可检查它们。
  return (yield* Effect.forEach(yield* messageRows(db, sessionID, compaction, epoch?.baselineSeq), decodeMessageRow)).filter((message) => !hidden(message.metadata?.hidden))
})

export const loadForRunner = Effect.fn("SessionHistory.loadForRunner")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  baselineSeq: number,
) {
  return (yield* entriesForRunner(db, sessionID, baselineSeq)).map((entry) => entry.message)
})

export const entriesForRunner = Effect.fn("SessionHistory.entriesForRunner")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  baselineSeq: number,
) {
  const rows = yield* messageRows(db, sessionID, yield* latestCompaction(db, sessionID), baselineSeq)
  return (yield* Effect.forEach(rows, (row) =>
    decodeMessageRow(row).pipe(Effect.map((message) => ({ seq: row.seq, message }))),
  )).filter((entry) => !hidden(entry.message.metadata?.hidden))
})

// memento只读本次边界内的原始user行，不经过latestCompaction，也不从旧摘要反推原话。
export const rawUserMessages = Effect.fn("SessionHistory.rawUserMessages")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  throughSeq: number,
) {
  const rows = yield* db.select().from(SessionMessageTable).where(and(
    eq(SessionMessageTable.session_id, sessionID), eq(SessionMessageTable.type, "user"), lte(SessionMessageTable.seq, throughSeq),
  )).orderBy(asc(SessionMessageTable.seq)).all().pipe(Effect.orDie)
  const messages = yield* Effect.forEach(rows, decodeMessageRow)
  // 使用同一合法hidden合同；synthetic、助手和未promote的inbox本来就不属于user行。
  return messages.flatMap(message => message.type === "user" && !hidden(message.metadata?.hidden) ? [message] : [])
})

// 连续压缩仍从真实助手行读取凭证，旧表格不参与，边界之后的消息不纳入本次交接。
export const readReceipts = Effect.fn("SessionHistory.readReceipts")(function* (
  db: DatabaseService, sessionID: SessionSchema.ID, throughSeq: number,
) {
  const rows = yield* db.select().from(SessionMessageTable).where(and(
    eq(SessionMessageTable.session_id, sessionID), eq(SessionMessageTable.type, "assistant"), lte(SessionMessageTable.seq, throughSeq),
  )).orderBy(asc(SessionMessageTable.seq)).all().pipe(Effect.orDie)
  const messages = yield* Effect.forEach(rows, decodeMessageRow)
  return messages.flatMap((message) => message.type === "assistant" && !hidden(message.metadata?.hidden)
    ? message.content.flatMap((part) =>
        part.type === "tool" && part.name === "read" && part.provider?.executed !== true && part.state.status === "completed"
          ? [part.state.structured.read] : [],
      )
    : [],
  )
})

export * as SessionHistory from "./history"
