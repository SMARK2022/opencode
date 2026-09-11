export * as SessionContextEpoch from "./context-epoch"

import { eq } from "drizzle-orm"
import { DateTime, Effect, Option, Schema } from "effect"
import type { Database } from "../database/database"
import { EventV2 } from "../event"
import { SystemContext } from "../system-context/index"
import { ContextSnapshotDecodeError } from "./error"
import { SessionEvent } from "./event"
import { SessionHistory } from "./history"
import { SessionInput } from "./input"
import { SessionMessage } from "./message"
import { SessionSchema } from "./schema"
import { SessionContextEpochTable, SessionMessageTable } from "./sql"

type DatabaseService = Database.Interface["db"]

// 同一 JSON 列保存 baseline/历史渲染归属，source comparison 快照与模型正文仍由原 owner 管理。
const State = Schema.Struct({
  sources: SystemContext.Snapshot,
  sections: Schema.Array(Schema.Struct({ kind: Schema.Literals(["instructions", "skills"]), text: Schema.String })),
  // rewind严格删除后缀；最后一次更新仍在即可证明此前更新没有被删。
  anchor: Schema.optional(SessionMessage.ID),
})
export type State = typeof State.Type

interface Prepared {
  readonly baseline: string
  readonly baselineSeq: number
  readonly sections: State["sections"]
}

function capture(sections: Array<State["sections"][number]>) {
  return (key: SystemContext.Key, text: string) => {
    // 只认实际领域 producer 的 key；文件正文里的同名标题不创造新的分类来源。
    if (key === "core/instructions") sections.push({ kind: "instructions", text })
    if (key === "core/skill-guidance") sections.push({ kind: "skills", text })
  }
}

export function initialize(
  db: DatabaseService,
  context: Effect.Effect<SystemContext.SystemContext>,
  sessionID: SessionSchema.ID,
): Effect.Effect<Prepared | undefined, SystemContext.InitializationBlocked> {
  return initializeOnce(db, context, sessionID).pipe(Effect.withSpan("SessionContextEpoch.initialize"))
}

export function prepare(
  db: DatabaseService,
  events: EventV2.Interface,
  context: Effect.Effect<SystemContext.SystemContext>,
  sessionID: SessionSchema.ID,
): Effect.Effect<Prepared, SystemContext.InitializationBlocked | ContextSnapshotDecodeError> {
  return prepareOnce(db, events, context, sessionID).pipe(Effect.withSpan("SessionContextEpoch.prepare"))
}

const prepareOnce = Effect.fnUntraced(function* (
  db: DatabaseService,
  events: EventV2.Interface,
  context: Effect.Effect<SystemContext.SystemContext>,
  sessionID: SessionSchema.ID,
) {
  const [value, stored, compaction] = yield* Effect.all(
    [context, find(db, sessionID), SessionHistory.latestCompaction(db, sessionID)],
    { concurrency: "unbounded" },
  )
  const sections: Array<State["sections"][number]> = []
  if (!stored) {
    const generation = yield* SystemContext.initialize(value, capture(sections))
    const baselineSeq = yield* insert(db, sessionID, generation, sections)
    return { baseline: generation.baseline, baselineSeq, sections }
  }

  // 已持久化的旧裸 Snapshot 没有片段归属，仍解码原契约；缺少证明的文本保守留在 system。
  // 私有 wrapper 不改变 baseline_seq 或 source 的等价比较，现有 ContextEpoch admission 仍是唯一 owner。
  const decoded = Schema.decodeUnknownOption(State)(stored.snapshot)
  const snapshot = Option.isSome(decoded) ? decoded.value : {
    sources: yield* Schema.decodeUnknownEffect(SystemContext.Snapshot)(stored.snapshot).pipe(
      Effect.mapError((error) => new ContextSnapshotDecodeError({ sessionID, details: String(error) })),
    ), sections: [], anchor: undefined,
  }
  const replacementSeq = compaction !== undefined && compaction.seq > stored.baseline_seq ? compaction.seq : undefined
  // 查原始投影而非已裁剪的模型历史；正常compaction过滤不等于用户删除更新。
  const missingAnchor = snapshot.anchor && !(yield* db.select({ id: SessionMessageTable.id })
    .from(SessionMessageTable).where(eq(SessionMessageTable.id, snapshot.anchor)).get().pipe(Effect.orDie))
  const result = replacementSeq !== undefined || missingAnchor
    ? yield* SystemContext.replace(value, snapshot.sources, capture(sections))
    : yield* SystemContext.reconcile(value, snapshot.sources, capture(sections))
  // 不可用来源继续保守复用原 baseline/证明，估算不能偷读当前文件生成替代正文。
  if (result._tag === "Unchanged" || result._tag === "ReplacementBlocked") {
    return { baseline: stored.baseline, baselineSeq: stored.baseline_seq, sections: snapshot.sections }
  }
  // 压缩或不兼容 replacement 重新冻结本代片段，旧 epoch 历史不进入新一代分类。
  if (result._tag === "ReplacementReady") {
    const baselineSeq = replacementSeq ?? (yield* EventV2.latestSequence(db, sessionID))
    yield* replace(db, sessionID, baselineSeq, result.generation, sections)
    return { baseline: result.generation.baseline, baselineSeq, sections }
  }

  // 旧 baseline 与此前更新仍会发送；source 变更/删除不抹掉它们已经渲染的字符归属。
  const messageID = SessionMessage.ID.create()
  const state = { sources: result.snapshot, sections: [...snapshot.sections, ...sections], anchor: messageID }
  yield* events.publish(
    SessionEvent.ContextUpdated,
    { sessionID, messageID, timestamp: yield* DateTime.now, text: result.text },
    { commit: () => advance(db, sessionID, state).pipe(Effect.orDie) },
  )
  return { baseline: stored.baseline, baselineSeq: stored.baseline_seq, sections: state.sections }
})

const initializeOnce = Effect.fnUntraced(function* (
  db: DatabaseService,
  context: Effect.Effect<SystemContext.SystemContext>,
  sessionID: SessionSchema.ID,
) {
  if (yield* exists(db, sessionID)) return
  const sections: Array<State["sections"][number]> = []
  const generation = yield* context.pipe(Effect.flatMap(value => SystemContext.initialize(value, capture(sections))))
  const baselineSeq = yield* insert(db, sessionID, generation, sections)
  return { baseline: generation.baseline, baselineSeq, sections }
})

const exists = Effect.fn("SessionContextEpoch.exists")(function* (db: DatabaseService, sessionID: SessionSchema.ID) {
  return (
    (yield* db
      .select({ sessionID: SessionContextEpochTable.session_id })
      .from(SessionContextEpochTable)
      .where(eq(SessionContextEpochTable.session_id, sessionID))
      .get()
      .pipe(Effect.orDie)) !== undefined
  )
})

const find = Effect.fn("SessionContextEpoch.find")(function* (db: DatabaseService, sessionID: SessionSchema.ID) {
  return yield* db
    .select()
    .from(SessionContextEpochTable)
    .where(eq(SessionContextEpochTable.session_id, sessionID))
    .get()
    .pipe(Effect.orDie)
})

export const reset = Effect.fn("SessionContextEpoch.reset")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
) {
  yield* db
    .delete(SessionContextEpochTable)
    .where(eq(SessionContextEpochTable.session_id, sessionID))
    .run()
    .pipe(Effect.orDie)
})

const insert = Effect.fnUntraced(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  generation: SystemContext.Generation,
  sections: State["sections"],
) {
  const baselineSeq = yield* EventV2.latestSequence(db, sessionID)
  yield* db
    .insert(SessionContextEpochTable)
    .values({
      session_id: sessionID,
      baseline: generation.baseline,
      // 片段与 baseline/source 快照同一次写入保存，后续 turn 不依赖尚未提交的内存来源。
      snapshot: { sources: generation.snapshot, sections },
      baseline_seq: baselineSeq,
    })
    .run()
    .pipe(Effect.orDie)
  return baselineSeq
})

const replace = Effect.fnUntraced(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  baselineSeq: number,
  generation: SystemContext.Generation,
  sections: State["sections"],
) {
  const updated = yield* db
    .update(SessionContextEpochTable)
    .set({
      baseline: generation.baseline,
      snapshot: { sources: generation.snapshot, sections },
      baseline_seq: baselineSeq,
    })
    .where(eq(SessionContextEpochTable.session_id, sessionID))
    .returning({ sessionID: SessionContextEpochTable.session_id })
    .get()
    .pipe(Effect.orDie)
  if (!updated) return yield* Effect.die("Context Epoch not found")
})

const advance = Effect.fnUntraced(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  snapshot: State,
) {
  const updated = yield* db
    .update(SessionContextEpochTable)
    .set({ snapshot })
    .where(eq(SessionContextEpochTable.session_id, sessionID))
    .returning({ sessionID: SessionContextEpochTable.session_id })
    .get()
    .pipe(Effect.orDie)
  if (!updated) return yield* Effect.die("Context Epoch not found")
})
