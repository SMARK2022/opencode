import { and, asc, desc, eq, gt, gte, inArray, lte, ne, or, sql } from "drizzle-orm"
import { MessageID } from "@opencode-ai/schema/v1/session"
import { Effect, Schema } from "effect"
import { Database } from "../database/database"
import { ColdStorage } from "../storage/cold-storage"
import { matchColdBytes } from "../storage/cold-store"
import { ColdCodec } from "../storage/cold-codec"
import type { FileEvidence } from "./file-evidence"
import { MessageDecodeError } from "./error"
import { SessionMessage } from "./message"
import { SessionSchema } from "./schema"
import { MessageTable, PartTable, SessionContextEpochTable, SessionMessageTable } from "./sql"
import { encodeProofKey } from "./history-proof"

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
  restore = true,
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
  const visible = rows.filter(row => !hidden(row.data.metadata?.hidden))
  // runner先核对raw前缀，只有变化后缀才恢复冷payload；其他消费者保持原读取路径。
  return restore ? yield* ColdStorage.readSessionMessageRows(db, visible) : visible
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

// 单entry只保存当前Session；寿命由runner scope持有，proof用完整row而非毫秒revision或额外hash。
export const makeCache = () => ({
  boundary: "", proof: [] as string[],
  entries: [] as Array<{ seq: number; message: SessionMessage.Message }>,
})

export const entriesForRunner = Effect.fn("SessionHistory.entriesForRunner")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  baselineSeq: number,
  cache?: ReturnType<typeof makeCache>,
) {
  const compaction = yield* latestCompaction(db, sessionID)
  const rows = yield* messageRows(db, sessionID, compaction, baselineSeq, false)
  const boundary = JSON.stringify([sessionID, baselineSeq, compaction?.seq])
  // 包含data、seq和cold key/ref/stats，原位修改、隐藏和冷热迁移都会在首个分歧处失效。
  // 与V1共用无损表示，完整row的每个字段和顺序仍参加exact proof，不另造版本或缓存。
  const proof = rows.map(row => encodeProofKey(JSON.stringify(row)))
  const mismatch = cache?.boundary === boundary
    ? proof.findIndex((key, index) => key !== cache.proof[index]) : 0
  const matched = cache?.boundary === boundary ? mismatch < 0 ? rows.length : mismatch : 0
  const suffix = yield* ColdStorage.readSessionMessageRows(db, rows.slice(matched), "execution")
  const decoded = yield* Effect.forEach(suffix, (row) =>
    decodeMessageRow(row).pipe(Effect.map((message) => ({ seq: row.seq, message }))),
  )
  const entries = [...(cache?.entries.slice(0, matched) ?? []), ...decoded]
    .filter(entry => !hidden(entry.message.metadata?.hidden))
  if (cache) {
    cache.boundary = boundary
    cache.proof = proof
    cache.entries = entries
  }
  return entries
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
      // 在limit之前排除合法hidden，不能让最近的隐藏行挤掉真正的前一Goal turn。
      sql`not coalesce((json_extract(${SessionMessageTable.data}, '$.metadata.hidden.reason') = 'permission-reviewer-protocol-retry'
        and json_type(${SessionMessageTable.data}, '$.metadata.hidden.time') = 'integer'
        and json_extract(${SessionMessageTable.data}, '$.metadata.hidden.time') >= 0), 0)`,
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

// 进度取当前 eligible turn 的持久投影，不让 compaction 的 provider 窗口裁掉先前工具证据。
export const goalTurnMessages = Effect.fn("SessionHistory.goalTurnMessages")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
) {
  const turn = yield* goalTurn(db, sessionID)
  if (!turn) return []
  const boundary = yield* db.select({ seq: SessionMessageTable.seq }).from(SessionMessageTable)
    .where(and(eq(SessionMessageTable.session_id, sessionID), eq(SessionMessageTable.id, turn.id))).get().pipe(Effect.orDie)
  if (!boundary) return []
  const rows = yield* db.select().from(SessionMessageTable)
    .where(and(eq(SessionMessageTable.session_id, sessionID), eq(SessionMessageTable.type, "assistant"), gt(SessionMessageTable.seq, boundary.seq)))
    .orderBy(asc(SessionMessageTable.seq)).all().pipe(Effect.orDie)
  // 仅恢复已选 turn 的可见助手；压缩窗口或冷骨架不能抹去实际进度。
  const restored = yield* ColdStorage.readSessionMessageRows(db, rows.filter(row => !hidden(row.data.metadata?.hidden)))
  return yield* Effect.forEach(restored, decodeMessageRow)
})

type Position = { id: string; time: number; source: number }
type Hit = Position & { ref: string; sessionID: SessionSchema.ID; role: string; partType: string; snippet: string }
type Scope = "session" | "global"
type ArchiveDB = ColdStorage.TxOrDb
export type ArchiveScan = {
  before?: Position
  hits: Hit[]
  total: number
  scanned: number
  errors: number
  eof: boolean
}

const fold = (text: string) => text.replace(/[A-Z]/g, (letter) => letter.toLowerCase())

function body(value: unknown): string {
  if (typeof value === "string") return value
  if (Array.isArray(value)) return value.map(body).join("\n")
  if (ColdCodec.isRecord(value))
    return Object.keys(value)
      .sort()
      .map((key) => `${key}\n${body(value[key])}`)
      .join("\n")
  return String(value)
}

function archivePage(db: ArchiveDB, positions: Position[], query: string) {
  const matches = new Map<string, boolean>()
  const legacy = positions.filter((p) => p.source === 1).map((p) => MessageID.make(p.id))
  const native = positions.filter((p) => p.source === 2).map((p) => SessionMessage.ID.make(p.id))
  const byID = <T extends { id: string }>(rows: T[]) => new Map(rows.map((row) => [row.id, row]))
  const v1 = byID(db.select().from(MessageTable).where(inArray(MessageTable.id, legacy)).all())
  const v2 = byID(db.select().from(SessionMessageTable).where(inArray(SessionMessageTable.id, native)).all())
  const parts = Map.groupBy(
    db.select().from(PartTable).where(inArray(PartTable.message_id, legacy)).orderBy(PartTable.id).all(),
    (r) => r.message_id,
  )
  const needle = /^[\p{L}\p{N}_.:/-]+$/u.test(query) ? Buffer.from(query) : undefined
  function project<Row extends { data: unknown; cold_ref: string | null; cold_key: Buffer | null }>(
    rows: Row[],
    owner: "part" | "session_message",
    inspect: (db: ArchiveDB, rows: Row[]) => Row[],
  ) {
    const text = body(rows.map((row) => row.data))
    if (!rows.some((row) => row.cold_ref)) return rows
    if (needle && !fold(text).includes(query)) {
      const possible = rows.some(({ cold_ref, cold_key }) => {
        if (!cold_ref) return false
        const match =
          matches.get(cold_ref) ?? matchColdBytes(db, cold_ref, cold_key ? ColdCodec.packKind(owner) : owner, needle)
        matches.set(cold_ref, match)
        return match
      })
      if (!possible) return []
    }
    return inspect(db, rows)
  }
  function legacyDocument(id: string) {
    const row = v1.get(id)
    if (!row) return
    return {
      sessionID: row.session_id,
      role: row.data.role,
      segments: [
        { type: row.data.role, text: body(row.data) },
        ...project(parts.get(row.id) ?? [], "part", ColdStorage.inspectPartRows).map(({ data }) => ({
          type: data.type,
          text: body(data),
        })),
      ],
    }
  }
  function nativeDocument(id: string) {
    const row = v2.get(id)
    if (!row) return
    return {
      sessionID: row.session_id,
      role: row.type,
      segments: project([row], "session_message", ColdStorage.inspectSessionMessageRows).map((r) => ({
        type: r.type,
        text: body(r.data),
      })),
    }
  }
  return (p: Position) => (p.source === 1 ? legacyDocument(p.id) : nativeDocument(p.id))
}

const locator = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Tuple([Schema.String, Schema.Number, Schema.Number])),
)

export function readArchive(db: ArchiveDB, ref: string) {
  const [id, source, anchorOffset] = locator(Buffer.from(ref, "base64url").toString())
  const position = { id, source, time: 0 }
  const doc = archivePage(db, [position], "")(position)
  if (!doc) throw new Error("Archived message not found")
  return { text: doc.segments.map((part) => part.text).join("\n"), anchorOffset }
}
export function searchArchive(
  db: ArchiveDB,
  input: {
    sessionID: SessionSchema.ID
    scope?: Scope
    query: string
    maxResults?: number
    deadline?: number
    state?: ArchiveScan
  },
) {
  const { sessionID, scope = "session", maxResults = 10, deadline = Date.now() + 4000 } = input
  const query = fold(input.query.trim())
  const local = scope === "session" ? sql`where session_id = ${sessionID}` : sql``
  const history = sql`(select id, time_created as time, 1 as source from ${MessageTable} ${local}
      union all select id, time_created as time, 2 as source from ${SessionMessageTable} ${local})`
  const state: ArchiveScan = input.state ?? {
    hits: [],
    total: db.all<{ n: number }>(sql`select count(*) as n from ${history}`)[0].n,
    scanned: 0,
    errors: 0,
    eof: false,
  }
  const before = state.before
  const cursor = before ? sql`where (time, id, source) < (${before.time}, ${before.id}, ${before.source})` : sql``
  const batch = db.all<Position>(sql`select * from ${history} ${cursor}
      order by time desc, id desc, source desc limit 500`)
  const load = archivePage(db, batch, query)
  function hit(pos: Position): Hit[] {
    try {
      const doc = load(pos)
      if (!doc) return []
      const text = doc.segments.map((part) => part.text).join("\n")
      const offset = fold(text).indexOf(query)
      if (offset < 0) return []
      const ref = Buffer.from(JSON.stringify([pos.id, pos.source, offset])).toString("base64url")
      let end = -1
      const part = doc.segments.find((part) => (end += part.text.length + 1) > offset)
      return [
        {
          ...pos,
          ref,
          sessionID: doc.sessionID,
          role: doc.role,
          partType: part?.type ?? doc.role,
          snippet: text.slice(Math.max(0, offset - 80), offset + 280),
        },
      ]
    } catch {
      state.errors++
      return []
    }
  }
  const expired = () => state.hits.length < maxResults && Date.now() >= deadline
  const stopped = batch.some((pos, index) => {
    if (state.hits.length >= maxResults || (index > 0 && expired())) return true
    state.hits.push(...hit(pos))
    state.before = pos
    state.scanned++
    return false
  })
  state.eof = !stopped && batch.length < 500
  return {
    state,
    hits: state.hits.slice(0, maxResults),
    timedOut: !state.eof && expired(),
  }
}
export * as SessionHistory from "./history"
