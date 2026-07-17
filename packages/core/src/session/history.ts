import { and, asc, desc, eq, gt, gte, lte, ne, or, sql } from "drizzle-orm"
import { Effect, Schema } from "effect"
import { Database } from "../database/database"
import { ColdStorage } from "../storage/cold-storage"
import type { FileEvidence } from "./file-evidence"
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
  // 已选定compaction/epoch范围；合法隐藏行不为普通模型上下文预热。
  return yield* ColdStorage.readSessionMessageRows(db, rows.filter(row => !hidden(row.data.metadata?.hidden)))
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
  const restored = yield* ColdStorage.readSessionMessageRows(db, rows.filter(row => !hidden(row.data.metadata?.hidden)))
  const messages = yield* Effect.forEach(restored, decodeMessageRow)
  // 使用同一合法hidden合同；synthetic、助手和未promote的inbox本来就不属于user行。
  return messages.flatMap(message => message.type === "user" && !hidden(message.metadata?.hidden) ? [message] : [])
})

// 连续压缩仍从真实助手行读取凭证，旧表格不参与，边界之后的消息不纳入本次交接。
export const evidence = Effect.fn("SessionHistory.evidence")(function* (
  db: DatabaseService, sessionID: SessionSchema.ID, throughSeq: number,
) {
  const rows = yield* db.select().from(SessionMessageTable).where(and(
    eq(SessionMessageTable.session_id, sessionID), or(eq(SessionMessageTable.type, "assistant"), eq(SessionMessageTable.type, "compaction")), lte(SessionMessageTable.seq, throughSeq),
  )).orderBy(asc(SessionMessageTable.seq)).all().pipe(Effect.orDie)
  const restored = yield* ColdStorage.readSessionMessageRows(db, rows.filter(row => !hidden(row.data.metadata?.hidden)))
  const messages = (yield* Effect.forEach(restored, decodeMessageRow)).filter(message => !hidden(message.metadata?.hidden))
  const receipts = messages.flatMap((message) => message.type === "assistant"
    ? message.content.flatMap((part) =>
        part.type === "tool" && part.name === "read" && part.provider?.executed !== true && part.state.status === "completed"
          ? [part.state.structured.read] : [],
      )
    : [],
  )
  const searches: FileEvidence.SearchReceipt[] = []
  const commands: FileEvidence.CommandReceipt[] = []
  for (const message of messages) {
    if (message.type !== "assistant") continue
    for (const part of message.content) {
      if (part.type !== "tool" || part.provider?.executed === true || part.state.status !== "completed") continue
      // 只采本边界内真正settle的本地Bash，展示命令文本不再次执行。
      if (part.name === "bash" && typeof part.state.input.command === "string") {
        commands.push({ command: part.state.input.command,
          ...(typeof part.state.input.workdir === "string" ? { workdir: part.state.input.workdir } : {}),
          ...(typeof part.state.structured.exit === "number" ? { exit: part.state.structured.exit } : {}),
        })
      }
      if (part.name !== "grep" && part.name !== "glob") continue
      const pattern = part.state.input.pattern
      if (typeof pattern !== "string" || !pattern) continue
      const output = part.state.structured
      // 新Glob保留files及完整性；旧持久数组仍读value，不从正文猜测条数。
      const items = part.name === "grep" ? output.items : output.files ?? output.value
      if (!Array.isArray(items)) continue
      searches.push({ tool: part.name, pattern, path: typeof part.state.input.path === "string" ? part.state.input.path : ".", matches: items.length,
        partial: output.partial === true || output.truncated === true || output.timedOut === true ||
          part.name === "glob" && !Array.isArray(output.files) && typeof part.state.input.limit === "number" && items.length >= part.state.input.limit,
      })
    }
  }
  return { receipts, searches, commands, compactionCount: messages.filter(message => message.type === "compaction").length + 1 }
})

export const readReceipts = (db: DatabaseService, sessionID: SessionSchema.ID, throughSeq: number) =>
  evidence(db, sessionID, throughSeq).pipe(Effect.map(result => result.receipts))
// eligible lineage读取未被compaction裁掉的原生投影；admission尚未提升时不会出现在这里。
export const goalTurn = Effect.fn("SessionHistory.goalTurn")(function* (db: DatabaseService, sessionID: SessionSchema.ID) {
  const rows = yield* db.select({ id: SessionMessageTable.id, type: SessionMessageTable.type })
    .from(SessionMessageTable)
    .where(and(eq(SessionMessageTable.session_id, sessionID),
      or(eq(SessionMessageTable.type, "user"), and(
        eq(SessionMessageTable.type, "synthetic"),
        sql`json_extract(${SessionMessageTable.data}, '$.text') LIKE ${"<session-goal-continuation>%"}`,
      ))))
    .orderBy(desc(SessionMessageTable.seq)).limit(2).all().pipe(Effect.orDie)
  if (!rows[0]) return
  // 只接受既有Goal continuation producer的标记；计划提醒等技术Synthetic不创建或重排turn。
  return {
    id: rows[0].id,
    previousID: rows[1]?.id,
    userInitiated: rows[0].type === "user",
  }
})

export * as SessionHistory from "./history"
