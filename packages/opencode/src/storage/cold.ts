import { and, eq, inArray, isNotNull, sql, type SQL } from "drizzle-orm"
import { Database, type TxOrDb } from "./db"
import { ColdStorageTable, MessageTable, PartTable, SessionTable } from "@/session/session.sql"
import { MessageID, PartID, type SessionID } from "@/session/schema"
import {
  DEFAULT_BATCH_SIZE,
  type StorageKind,
  type Json,
  type MessageData,
  type PartData,
  CorruptionError,
  ValidationError,
  projectPartStats,
  parsePartStats,
  restorePart,
} from "./cold-codec"
import {
  compareStoredMessageCursor,
  ownerCounts,
  requireReferenceMetadata,
  incrementReferences,
  decodedBatch,
  requiredEnvelope,
  release,
  decode,
  decodePack,
  decodeSummary,
  releaseSummaryReference,
  inspectPartRows,
} from "./cold-store"

// 历史 Message/Part 发生语义替换时，cursor 以内的 aggregate 不再可信；清 ref 后由下一次 load 从当前 Tool rows 重建。
// 新 owner 位于 cursor 之后不会影响已缓存前缀，因此保持 cache 可增量扩展，避免每个实时 tail 写入都解压 summary。
export function invalidateSessionSummaryBefore(db: TxOrDb, sessionID: SessionID, messageID: MessageID) {
  const session = db
    .select({
      summaryRef: SessionTable.summary_ref,
      summaryCursor: SessionTable.summary_cursor,
      summaryInitialized: SessionTable.summary_initialized,
      summaryInitDirty: SessionTable.summary_init_dirty,
      summarySeed: SessionTable.summary_seed,
    })
    .from(SessionTable)
    .where(eq(SessionTable.id, sessionID))
    .get()
  if (!session) return
  if (!session.summaryInitialized) {
    if (session.summaryRef || session.summarySeed || (session.summaryCursor === null && session.summaryInitDirty)) {
      throw new CorruptionError({ message: `Session summary initialization state is inconsistent: ${sessionID}` })
    }
    if (session.summaryCursor === null) return
    const relation = compareStoredMessageCursor(db, sessionID, messageID, session.summaryCursor)
    if (relation === undefined || relation > 0) return
    const parent = db
      .select({ data: MessageTable.data })
      .from(MessageTable)
      .where(and(eq(MessageTable.id, messageID), eq(MessageTable.session_id, sessionID)))
      .get()
    if (!parent || parent.data.hidden) return
    if (parent.data.role === "assistant" && parent.data.time.completed === undefined) return
    // claim 覆盖范围内的 closed history 已变化；dirty 与 owner replacement 位于同一 projector transaction。
    db.update(SessionTable)
      .set({ summary_init_dirty: true, time_updated: SessionTable.time_updated })
      .where(and(eq(SessionTable.id, sessionID), eq(SessionTable.summary_initialized, false)))
      .run()
    return
  }
  if (session.summaryInitDirty || (session.summaryRef === null) !== (session.summaryCursor === null)) {
    throw new CorruptionError({ message: `Session summary cache state is inconsistent: ${sessionID}` })
  }
  if (!session.summaryRef) {
    if (!session.summarySeed) return
    const relation = compareStoredMessageCursor(db, sessionID, messageID, session.summarySeed.cursor)
    if (relation === undefined || relation > 0) return
    db.update(SessionTable)
      .set({ summary_seed: null, time_updated: SessionTable.time_updated })
      .where(eq(SessionTable.id, sessionID))
      .run()
    return
  }
  // 三条分支全部改为 tuple 判定：dirty-claim、seed 退休与 ref 失效共用同一 chronology 语义，
  // 变更行早于边界才覆盖 cache，之后则保持增量可扩展。
  if (session.summaryCursor === null) return
  const relation = compareStoredMessageCursor(db, sessionID, messageID, session.summaryCursor)
  if (relation === undefined || relation > 0) return
  const payload = decodeSummary(db, session.summaryRef)
  // seed 内部 cursor 与外层 cursor 各自独立解析：保留晚于变更行的 seed，丢弃已被覆盖的 seed。
  const seedRelation = payload.seed
    ? compareStoredMessageCursor(db, sessionID, messageID, payload.seed.cursor)
    : undefined
  const seed = payload.seed && (seedRelation === undefined || seedRelation > 0) ? payload.seed : undefined
  const updated = db
    .update(SessionTable)
    .set({
      summary_ref: null,
      summary_cursor: null,
      summary_seed: seed ? { cursor: seed.cursor, diffs: seed.diffs.map((item) => ({ ...item })) } : null,
      time_updated: SessionTable.time_updated,
    })
    .where(and(eq(SessionTable.id, sessionID), eq(SessionTable.summary_ref, session.summaryRef)))
    .returning({ id: SessionTable.id })
    .get()
  if (!updated) throw new CorruptionError({ message: `Session summary changed during invalidation: ${sessionID}` })
  releaseSummaryReference(db, session.summaryRef)
}

function releaseReference(db: TxOrDb, table: typeof MessageTable, id: MessageID, hash: string | null): void

function releaseReference(db: TxOrDb, table: typeof PartTable, id: PartID, hash: string | null): void

function releaseReference(
  db: TxOrDb,
  table: typeof MessageTable | typeof PartTable,
  id: MessageID | PartID,
  hash: string | null,
) {
  if (!hash) return
  if (table === MessageTable) {
    db.update(MessageTable)
      .set({ cold_ref: null, cold_key: null })
      .where(eq(MessageTable.id, MessageID.make(id)))
      .run()
  } else {
    db.update(PartTable)
      .set({ cold_ref: null, cold_key: null, cold_stats: null })
      .where(eq(PartTable.id, PartID.make(id)))
      .run()
  }
  release(db, hash)
}

// durable Message update 的合同是完整对象替换，不根据空 diffs 猜测调用方是否“未触及”冷字段。
// 新热对象先写入并清 ref，随后 release 旧 payload；外键或 SQL 失败会让 projector transaction 整体回滚。
// 因而只修改标题会保留已 thaw 的 diffs，而明确清空 diffs 会准确释放旧 blob。
export function replaceMessage(
  db: TxOrDb,
  row: {
    id: MessageID
    session_id: SessionID
    time_created: number
    // replacement 只接受完整业务 Message；storage projection 的 unknown diffs 在类型层不能进入该 API。
    data: MessageData
  },
) {
  const previous = db
    .select({ cold_ref: MessageTable.cold_ref })
    .from(MessageTable)
    .where(eq(MessageTable.id, row.id))
    .get()
  // 先完成新的完整热写入，再 release 旧 blob；外键失败时不会留下已释放但未写入的 owner。
  db.insert(MessageTable)
    .values({ ...row, cold_ref: null, cold_key: null })
    .onConflictDoUpdate({ target: MessageTable.id, set: { data: row.data, cold_ref: null, cold_key: null } })
    .run()
  if (previous?.cold_ref) releaseReference(db, MessageTable, row.id, previous.cold_ref)
}

// Part update 与 Message 使用相同完整替换语义，tool output 的空字符串既可能是合法更新也可能是 projection。
// 只有 cold-aware reader 能把 projection 交回业务层；projector 永远接收完整 Part 后再调用此 seam。
// 先写热 row 再释放旧 ref，避免 late update 或 FK 失败把唯一 payload 提前删除。
export function replacePart(
  db: TxOrDb,
  row: {
    id: PartID
    message_id: MessageID
    session_id: SessionID
    time_created: number
    // replacement 只接受完整业务 Part；raw tool/reasoning/file placeholder 必须先经过 decoder。
    data: PartData
  },
) {
  const previous = db.select({ cold_ref: PartTable.cold_ref }).from(PartTable).where(eq(PartTable.id, row.id)).get()
  db.insert(PartTable)
    .values({ ...row, cold_ref: null, cold_key: null, cold_stats: null })
    .onConflictDoUpdate({
      target: PartTable.id,
      set: { data: row.data, cold_ref: null, cold_key: null, cold_stats: null },
    })
    .run()
  if (previous?.cold_ref) releaseReference(db, PartTable, row.id, previous.cold_ref)
}

// 单 Part 删除先按 session/id 双重限定 owner，防止跨 session 的错误事件递减其他会话引用。
// owner 不存在或本来为热态时保持幂等；有 ref 时清除和 release 必须位于 projector transaction。
export function releasePart(db: TxOrDb, partID: PartID, sessionID: SessionID) {
  const row = db
    .select({ cold_ref: PartTable.cold_ref })
    .from(PartTable)
    .where(and(eq(PartTable.id, partID), eq(PartTable.session_id, sessionID)))
    .get()
  if (row?.cold_ref) releaseReference(db, PartTable, partID, row.cold_ref)
}

// Message 删除必须先释放其全部 Part，再释放 Message 自身，否则 cascade 会抹掉反算 refcount 所需证据。
// usage totals 的扣减由 projector 在同一事务负责；ColdStorage 只拥有 payload 引用生命周期。
// 共享 fork payload 仍有其他 owner 时 release 只递减，不会让父子任一方丢失可恢复内容。
export function releaseMessage(db: TxOrDb, messageID: MessageID, sessionID: SessionID) {
  const parts = db
    .select({ id: PartTable.id, cold_ref: PartTable.cold_ref })
    .from(PartTable)
    .where(and(eq(PartTable.message_id, messageID), eq(PartTable.session_id, sessionID)))
    .all()
  for (const row of parts) {
    if (row.cold_ref) releaseReference(db, PartTable, row.id, row.cold_ref)
  }
  const message = db
    .select({ cold_ref: MessageTable.cold_ref })
    .from(MessageTable)
    .where(and(eq(MessageTable.id, messageID), eq(MessageTable.session_id, sessionID)))
    .get()
  if (message?.cold_ref) releaseReference(db, MessageTable, messageID, message.cold_ref)
}

// Session cascade 前显式遍历所有 owner ref，避免 SQLite onDelete 隐式删除行却绕过应用级 ref_count。
// Part 先于 Message 释放与 Message 删除路径一致，transaction 失败时 session 和 payload 都保持原状。
// 该 primary path 保证 verify --repair 是外部破坏修复工具，而不是正常删除后的最终一致性补丁。
export function releaseSession(db: TxOrDb, sessionID: SessionID) {
  const parts = db
    .select({ id: PartTable.id, cold_ref: PartTable.cold_ref })
    .from(PartTable)
    .where(eq(PartTable.session_id, sessionID))
    .all()
  for (const row of parts) {
    if (row.cold_ref) releaseReference(db, PartTable, row.id, row.cold_ref)
  }
  const messages = db
    .select({ id: MessageTable.id, cold_ref: MessageTable.cold_ref })
    .from(MessageTable)
    .where(eq(MessageTable.session_id, sessionID))
    .all()
  for (const row of messages) {
    if (row.cold_ref) releaseReference(db, MessageTable, row.id, row.cold_ref)
  }
  const summary = db
    .select({ summary_ref: SessionTable.summary_ref })
    .from(SessionTable)
    .where(eq(SessionTable.id, sessionID))
    .get()
  if (summary?.summary_ref) {
    // Session FK 是 RESTRICT；summary owner 必须先清除并 release，才能删除 Session 行而不绕过计数。
    db.update(SessionTable).set({ summary_ref: null, summary_cursor: null }).where(eq(SessionTable.id, sessionID)).run()
    releaseSummaryReference(db, summary.summary_ref)
  }
}

// fork 复制 raw row 而非业务对象：cold source 保留 projection+cold_ref，hot source 保留完整 JSON。
// source/target ID map 由 Session owner 生成；此处只重写 assistant parentID 和 compaction tail_start_id。
// payload 在复制前按 unique hash 完整校验，clone 失败时 owner inserts 与引用增量由 SyncEvent transaction 回滚。
// Message/Part 查询和 insert 都按 2000 分块，防止超长会话超过 SQLite variable 数量限制。
// 父子 row 使用独立 ID，共享 hash；任一方 thaw/delete 只改变自身 owner 和对应引用计数。
export function clonePrefix(
  db: TxOrDb,
  input: {
    sourceSessionID: SessionID
    sessionID: SessionID
    messageMap: ReadonlyArray<{ sourceID: MessageID; targetID: MessageID }>
    partMap: ReadonlyArray<{ sourceID: PartID; targetID: PartID }>
  },
) {
  const messageIDs = input.messageMap.map((item) => item.sourceID)
  const partIDs = input.partMap.map((item) => item.sourceID)
  const sourceMessages = messageIDs.flatMap((_, index) => {
    if (index % DEFAULT_BATCH_SIZE !== 0) return []
    return db
      .select()
      .from(MessageTable)
      .where(
        and(
          eq(MessageTable.session_id, input.sourceSessionID),
          inArray(MessageTable.id, messageIDs.slice(index, index + DEFAULT_BATCH_SIZE)),
        ),
      )
      .all()
  })
  const sourceParts = partIDs.flatMap((_, index) => {
    if (index % DEFAULT_BATCH_SIZE !== 0) return []
    return db
      .select()
      .from(PartTable)
      .where(
        and(
          eq(PartTable.session_id, input.sourceSessionID),
          inArray(PartTable.id, partIDs.slice(index, index + DEFAULT_BATCH_SIZE)),
        ),
      )
      .all()
  })
  if (sourceMessages.length !== messageIDs.length || sourceParts.length !== partIDs.length) {
    throw new ValidationError({ message: "Fork source rows do not match the supplied ID maps" })
  }

  const messageMap = new Map(input.messageMap.map((item) => [item.sourceID, item.targetID]))
  const partMap = new Map(input.partMap.map((item) => [item.sourceID, item.targetID]))
  // owner prefix 理论上隔离 hash kind；这里仍验证真实引用，防止外部 SQL 破坏后 Map 覆盖先前 kind。
  // 同一 hash 跨 kind 是 corruption，不能任意选择最后遍历的 kind 再把 fork 伪装成成功。
  const hashes = new Map<string, StorageKind>()
  for (const row of sourceMessages) {
    if (!row.cold_ref) continue
    const expected = row.cold_key ? "message-pack" : "message"
    const kind = hashes.get(row.cold_ref)
    if (kind && kind !== expected) {
      throw new CorruptionError({
        message: "Fork source hash is referenced by different owner kinds",
        hash: row.cold_ref,
      })
    }
    hashes.set(row.cold_ref, expected)
  }
  for (const row of sourceParts) {
    if (!row.cold_ref) continue
    const expected = row.cold_key ? "part-pack" : "part"
    const kind = hashes.get(row.cold_ref)
    if (kind && kind !== expected) {
      throw new CorruptionError({
        message: "Fork source hash is referenced by different owner kinds",
        hash: row.cold_ref,
      })
    }
    hashes.set(row.cold_ref, expected)
  }
  const payloads = [...hashes.keys()].flatMap((_, index, all) => {
    if (index % DEFAULT_BATCH_SIZE !== 0) return []
    return db
      .select()
      .from(ColdStorageTable)
      .where(inArray(ColdStorageTable.hash, all.slice(index, index + DEFAULT_BATCH_SIZE)))
      .all()
  })
  if (payloads.length !== hashes.size) {
    throw new CorruptionError({ message: "Fork source points to a missing cold payload" })
  }
  const counts = ownerCounts(db, [...hashes.keys()])
  for (const payload of payloads) {
    const expected = hashes.get(payload.hash)
    if (!expected || payload.kind !== expected || payload.ref_count !== (counts.get(payload.hash) ?? 0)) {
      throw new CorruptionError({ message: "Fork source cold payload metadata is inconsistent", hash: payload.hash })
    }
    if (expected === "message" || expected === "part") decode(db, payload.hash, expected)
    else {
      const owner = expected === "message-pack" ? "message" : "part"
      const entries = decodePack(db, payload.hash, owner)
      const owners = owner === "message" ? sourceMessages : sourceParts
      for (const row of owners) {
        if (row.cold_ref !== payload.hash || !row.cold_key) continue
        if (!entries.has(row.cold_key.toString("hex"))) {
          throw new CorruptionError({ message: "Fork source cold key is missing from pack", hash: payload.hash })
        }
      }
    }
  }

  const messages = sourceMessages.map((row) => {
    const targetID = messageMap.get(row.id)
    if (!targetID) throw new ValidationError({ message: `Fork message map misses ${row.id}` })
    const data = structuredClone(row.data)
    if (data.role === "assistant" && data.parentID) {
      const parentID = messageMap.get(data.parentID)
      if (!parentID) throw new ValidationError({ message: `Fork parent map misses ${data.parentID}` })
      data.parentID = parentID
    }
    return {
      id: targetID,
      session_id: input.sessionID,
      time_created: row.time_created,
      time_updated: row.time_updated,
      data,
      cold_ref: row.cold_ref,
      cold_key: row.cold_key ? Buffer.from(row.cold_key) : null,
    }
  })
  for (let offset = 0; offset < messages.length; offset += DEFAULT_BATCH_SIZE) {
    db.insert(MessageTable)
      .values(messages.slice(offset, offset + DEFAULT_BATCH_SIZE))
      .run()
  }

  const targetRoot = !db
    .select({ parent: SessionTable.parent_id })
    .from(SessionTable)
    .where(eq(SessionTable.id, input.sessionID))
    .get()?.parent
  // 冷子正文复制到根 Session 时仅恢复目标行，源引用保持不变。
  const copiedText = new Map(
    inspectPartRows(
      db,
      sourceParts.filter((row) => targetRoot && row.data.type === "text" && row.cold_ref),
    ).map((row) => [row.id, row.data]),
  )
  const parts = sourceParts.map((row) => {
    const targetID = partMap.get(row.id)
    const targetMessageID = messageMap.get(row.message_id)
    if (!targetID || !targetMessageID) throw new ValidationError({ message: `Fork part map misses ${row.id}` })
    const data = structuredClone(copiedText.get(row.id) ?? row.data)
    if (data.type === "compaction" && data.tail_start_id) {
      const tailStartID = messageMap.get(data.tail_start_id)
      if (tailStartID) data.tail_start_id = tailStartID
      else delete data.tail_start_id
    }
    return {
      id: targetID,
      message_id: targetMessageID,
      session_id: input.sessionID,
      time_created: row.time_created,
      time_updated: row.time_updated,
      data,
      cold_ref: copiedText.has(row.id) ? null : row.cold_ref,
      cold_key: copiedText.has(row.id) ? null : row.cold_key ? Buffer.from(row.cold_key) : null,
      // fork 复制同一 immutable payload 的 owner 投影；重新计算会要求无意义地解码整个共享 pack。
      cold_stats: row.cold_stats,
    }
  })
  for (let offset = 0; offset < parts.length; offset += DEFAULT_BATCH_SIZE) {
    db.insert(PartTable)
      .values(parts.slice(offset, offset + DEFAULT_BATCH_SIZE))
      .run()
  }

  incrementReferences(
    db,
    [...messages, ...parts].flatMap((row) => (row.cold_ref ? [{ hash: row.cold_ref }] : [])),
    Date.now(),
  )
  // projector 仍拥有 Session usage totals；返回 raw Part data 让它复用既有 step-finish 聚合而不再次查询或 thaw。
  return sourceParts.map((row) => row.data)
}

// Stats inspect 与业务 inspect 的差异是持久格式合同：v2 只能读取 owner 同行投影，绝不打开 pack。
// v1 没有该列，必须按 hash 批量解码并在内存恢复；该 shipped compatibility branch 不写 owner/refcount。
// hot row 现场计算同一 projector，因而 hot/v1/v2 不会维护三套统计公式。
export function matchColdText(tokens: string[], scope?: SQL) {
  // 只返回命中身份，把最终排序、分页和 title/hot 条件仍交给现有 SQL。
  // 每个 token 独立记录命中，允许关键词分别出现在标题、热正文和冷正文中。
  return Database.use((db) => {
    // 范围和可见性先在 SQL 缩小；一次只解码一个包，结果仅保留 Session ID。
    const rows = db
      .select({ session: PartTable.session_id, ref: PartTable.cold_ref, key: PartTable.cold_key })
      .from(PartTable)
      .innerJoin(
        MessageTable,
        and(eq(MessageTable.id, PartTable.message_id), eq(MessageTable.session_id, PartTable.session_id)),
      )
      .innerJoin(SessionTable, eq(SessionTable.id, PartTable.session_id))
      .where(
        and(
          scope,
          isNotNull(PartTable.cold_ref),
          sql`json_extract(${PartTable.data}, '$.type') = 'text'`,
          sql`json_type(${PartTable.data}, '$.hidden') is null`,
          sql`json_type(${MessageTable.data}, '$.hidden') is null`,
          sql`coalesce(json_extract(${PartTable.data}, '$.synthetic'), 0) = 0`,
          sql`coalesce(json_extract(${PartTable.data}, '$.ignored'), 0) = 0`,
        ),
      )
      .orderBy(PartTable.cold_ref)
      .all()
    const result = tokens.map(() => new Set<SessionID>())
    // locator 已按 hash 排序，单包缓存即可避免同包 owner 重复解压。
    // 查询结束即释放正文，没有跨请求缓存生命周期或额外持久索引。
    let hash: string | undefined
    let entries = new Map<string, Record<string, Json>>()
    for (const row of rows) {
      if (!row.ref || !row.key) throw new CorruptionError({ message: "Cold Text locator is incomplete" })
      if (hash !== row.ref) {
        entries = decodePack(db, row.ref, "part")
        hash = row.ref
      }
      const text = entries.get(row.key.toString("hex"))?.text
      if (typeof text !== "string") throw new CorruptionError({ message: "Cold Text body is missing", hash })
      // SQLite lower 只折叠 ASCII；Unicode 大小写不能改用 JS 全量折叠。
      const folded = text.replace(/[A-Z]/g, (letter) => letter.toLowerCase())
      tokens.forEach((token, index) => {
        if (folded.includes(token)) result[index].add(row.session)
      })
    }
    return result.map((ids) => [...ids])
  })
}

export function inspectPartStats(db: TxOrDb, rows: (typeof PartTable.$inferSelect)[]) {
  // hot row 出现 cold_stats 表示 writer 未清理派生状态，继续统计会形成两个矛盾数据源。
  // 此 seam 只返回标量且不执行 owner mutation，Stats 前后 storage-state hash 必须相同。
  const legacy = rows.filter(
    (row): row is typeof row & { cold_ref: string; cold_key: null } => !!row.cold_ref && !row.cold_key,
  )
  // v1 只能批量 decode 旧 payload，但共用正式 integrity gate，不建立宽松 Stats parser。
  const legacyValues = decodedBatch(
    db,
    legacy.map((row) => row.cold_ref),
    "part",
  )
  // v2 只验证 metadata/refcount，不读取 pack body；完整 archive 扫描属于显式 verify。
  requireReferenceMetadata(
    db,
    rows.flatMap((row) => (row.cold_ref && row.cold_key ? [row.cold_ref] : [])),
    "part-pack",
  )
  // map 保持输入 index，loader 不必再按 PartID 建立可能丢项的临时 join。
  return rows.map((row) => {
    if (!row.cold_ref) {
      if (row.cold_key) throw new CorruptionError({ message: "Part Stats owner has a key without a ref" })
      if (row.cold_stats !== null) throw new CorruptionError({ message: "Hot Part has a cold Stats projection" })
      return projectPartStats(row.data)
    }
    if (!row.cold_key) {
      // v1 row 只允许 NULL stats；当前 writer 在下次压缩时将其升级为 v2。
      if (row.cold_stats !== null) {
        throw new CorruptionError({
          message: "Legacy Part has an unexpected cold Stats projection",
          hash: row.cold_ref,
        })
      }
      return projectPartStats(restorePart(row.data, requiredEnvelope(legacyValues, row.cold_ref), row.cold_ref))
    }
    // cold_key 明确选择 v2 同行投影主路径，malformed stats 不能触发 decodePack fallback。
    if (row.data.type !== "tool" && row.data.type !== "step-finish") {
      // 非 Tool/Step 必须保持 NULL，防止无关 archive 借此列进入全量统计内存。
      if (row.cold_stats !== null) {
        throw new CorruptionError({ message: "Non-Stats v2 Part has a cold Stats projection", hash: row.cold_ref })
      }
      return null
    }
    if (row.cold_stats === null) {
      throw new CorruptionError({ message: "Stats v2 Part is missing its cold projection", hash: row.cold_ref })
    }
    const stats = parsePartStats(row.cold_stats, row.cold_ref)
    // projection type 必须匹配 hot discriminator，Tool 数值不能被 Step owner 误用。
    if (stats.type !== row.data.type) {
      throw new CorruptionError({ message: "Part cold Stats type does not match its owner", hash: row.cold_ref })
    }
    // 返回值不包含 fields 或完整 Part，调用方不能把 Stats seam 当作业务读取捷径。
    return stats
  })
}

export {
  DEFAULT_BATCH_SIZE,
  type SummaryPayload,
  CorruptionError,
  CodecUnavailableError,
  ValidationError,
  projectPartStats,
} from "./cold-codec"
export {
  type FreezeResult,
  type StatusReport,
  type VerifyReport,
  type CleanupReport,
  retainSummaryPayload,
  retainSummaryReference,
  releaseSummaryReference,
  inspectSummary,
  freezeOwner,
  thawMessageRows,
  thawPartRows,
  inspectMessageRows,
  inspectPartRows,
  thawOwner,
  isEligibleOwner,
  verify,
  expand,
  cleanup,
  type EntryLocation,
  type PreparedRepack,
  maintenance,
} from "./cold-store"

export * as ColdStorage from "./cold"
