import { and, eq, gt, inArray, isNotNull, isNull, or, sql, type SQL } from "drizzle-orm"
import { Database, type TxOrDb } from "./db"
import { ColdStorageTable, MessageTable, PartTable, SessionTable, type PartColdStats } from "@/session/session.sql"
import { MessageID, PartID, SessionID as SessionIDSchema, type SessionID } from "@/session/schema"
import { CompactionBoundary } from "@/session/compaction-boundary"
import type { StorageKind } from "./cold-codec"
import {
  DEFAULT_BATCH_SIZE,
  isSummaryCursor,
  isSummarySeed,
  type Owner,
  type OwnerKind,
  type PackKind,
  type Json,
  type Envelope,
  type PackEntry,
  type SummaryPayload,
  CorruptionError,
  ValidationError,
  isRecord,
  canonical,
  digest,
  packKind,
  entryKey,
  packEnvelope,
  compress,
  decompress,
  parseEnvelope,
  summaryEnvelope,
  parseSummaryEnvelope,
  extractMessageV2,
  projectPartStats,
  parsePartStats,
  requirePartStats,
  compactPartStats,
  extractPartCore,
  restoreMessage,
  restorePart,
  restorePackedMessage,
  restorePackedPart,
  splitPacks,
  decodePayload,
  type PackWireRow,
  type PackWire,
  type PackScanResult,
  type PackedChunk,
} from "./cold-codec"

// root 7 天 session.time_updated、subagent 24 小时 last message、completed compact head 三者 OR；任一成立即可进冷存储。
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000

// subagent 固定 24h last-message 阈值；CLI olderThanMs 只调 root，不覆盖该常量。
const SUBAGENT_IDLE_MS = 24 * 60 * 60 * 1000

// FreezeResult 把正常“未处理”与异常分开；ineligible/no-fields 不应让整个维护 task failed。
// frozen 返回 raw/compressed bytes 供 checkpoint 统计，但不暴露 payload body 或 storage projection。
export type FreezeResult =
  | { type: "frozen"; hash: string; rawBytes: number; compressedBytes: number }
  | { type: "skipped"; reason: "missing" | "already-cold" | "ineligible" | "no-fields" }

// StatusReport 区分可冻 owner、现有 cold owner、unique payload 和共享逻辑 bytes，避免收益口径混用。
// mismatch/orphan 来自真实 owner 反算，用户可以在执行 repair/cleanup 前看到风险范围。
export type StatusReport = {
  pageSize: number
  pageCount: number
  freelistPages: number
  activeBytes: number
  targetBytes: number
  eligibleOwners: number
  coldOwners: number
  summaryOwners: number
  summaryPayloads: number
  summaryRawBytes: number
  summaryCompressedBytes: number
  payloads: number
  rawBytes: number
  compressedBytes: number
  sharedBytes: number
  refCountMismatches: number
  orphans: number
}

// VerifyReport 同时记录扫描范围与错误类别；missing/corrupt 不能被 refcount repair 伪装成 repaired。
// repaired 只统计真正更新的 ref_count rows，不表示所有 integrity 问题都已解决。
export type VerifyReport = {
  checkedOwners: number
  checkedPayloads: number
  corruptOwners: number
  refCountMismatches: number
  missingPayloads: number
  corruptPayloads: number
  repaired: number
  // toolInputFixed 独立计数 Tool input 形状修复，与 refcount repair 互不混淆。
  toolInputFixed: number
}

// CleanupReport 的 candidate 与 deleted 分开，保证 dry-run 输出不能被误读为已经释放磁盘内容。
// bytes 是 compressed payload logical size；物理 SQLite 文件变化只能由显式 vacuum report 表示。
export type CleanupReport = {
  candidates: number
  candidateBytes: number
  deleted: number
  deletedBytes: number
}

// 存储模块把父关系转为抽取参数，字段白名单与恢复协议统一由codec维护。
function extractPartV2(data: (typeof PartTable.$inferSelect)["data"], sessionID?: SessionID) {
  // parent_id 区分子任务与 fork；标题和 agent 显示名称不承担此分类。
  // child 判定只在主线程查询一次，worker 重打包时以纯参数形式传入，保持 worker 零 DB 访问。
  const child =
    data.type === "text" && sessionID
      ? !!Database.use((db) =>
          db.select({ parent: SessionTable.parent_id }).from(SessionTable).where(eq(SessionTable.id, sessionID)).get(),
        )?.parent
      : undefined
  return extractPartCore(data, child)
}

// eligibility 合并 root/subagent 闲置时钟与最新 completed compaction boundary，三条规则 OR。
// root 用 session.time_updated；subagent（parent_id 非空）用 max(message.time_created)，不用 SessionStatus。
// olderThanMs 只作为 root 闲置阈值由 prepare 后的 request 固定；subagent 24h 常量不可被 CLI 改写。
// boundary 结果可按 session 缓存，但写入改变时间后必须重算，避免冻住新 tail。
function lastMessageCreated(db: TxOrDb, sessionID: SessionID) {
  // 空会话 max 为 null：无法证明 last-message idle，subagent age 分支必须为 false。
  return (
    db
      .select({ value: sql<number | null>`max(${MessageTable.time_created})` })
      .from(MessageTable)
      .where(eq(MessageTable.session_id, sessionID))
      .get()?.value ?? null
  )
}

function completedReviewMessages(db: TxOrDb, sessionID: SessionID) {
  // reviewer 复用 Session，但重试创建新 request；已完成 attempt 可以独立冷冻。
  // 这里仅读取持久事实；业务 reviewer 不获得任何冷冻接口或新状态标记。
  // 同一 Session 中其他 request 仍可运行，资格只约束关联的这一组消息。
  const messages = db
    .select({ id: MessageTable.id, data: MessageTable.data })
    .from(MessageTable)
    .where(eq(MessageTable.session_id, sessionID))
    .all()
  const requests = new Set(
    messages.flatMap((row) => (row.data.role === "user" && row.data.agent === "permission-reviewer" ? [row.id] : [])),
  )
  const open = new Set(
    db
      .select({ id: PartTable.message_id })
      .from(PartTable)
      .where(
        and(
          eq(PartTable.session_id, sessionID),
          sql`json_extract(${PartTable.data}, '$.type') = 'tool'`,
          sql`json_extract(${PartTable.data}, '$.state.status') in ('pending', 'running')`,
        ),
      )
      .all()
      .map((row) => row.id),
  )
  const replies = new Map<string, typeof messages>()
  // 用户请求没有已完成回复时不入选，避免把尚待审计的请求正文提前冻结。
  // 多个回复共享 parent 时统一检查，单个完成回复不能掩盖仍在运行的回复。
  for (const row of messages) {
    if (row.data.role !== "assistant" || !requests.has(row.data.parentID)) continue
    const group = replies.get(row.data.parentID)
    if (group) {
      group.push(row)
      continue
    }
    replies.set(row.data.parentID, [row])
  }
  const result = new Set<string>()
  // 后续协议隐藏走完整对象 replacement，能保留这里移入包的正文。
  // 手动命令的 immediate transaction 将资格检查和引用切换放在同一写边界。
  for (const [request, group] of replies) {
    // completed 时间先于部分异常 Tool 收尾落库，因此同时核实 Tool 已经终态。
    if (
      open.has(MessageID.make(request)) ||
      group.some(
        (row) =>
          row.data.role !== "assistant" ||
          row.data.agent !== "permission-reviewer" ||
          !row.data.time.completed ||
          open.has(row.id),
      )
    )
      continue
    result.add(request)
    for (const row of group) result.add(row.id)
  }
  return result
}

function eligibility(db: TxOrDb, sessionID: SessionID, now: number, rootOlderThanMs = SEVEN_DAYS_MS) {
  const session = db
    .select({ updated: SessionTable.time_updated, parentID: SessionTable.parent_id })
    .from(SessionTable)
    .where(eq(SessionTable.id, sessionID))
    .get()
  if (!session) return
  const boundary = CompactionBoundary.latest(sessionID)
  // marker fallback 仅在 tail 缺失时成立（shipped compatibility）；
  // tail 存在但行已删除时 boundary 不可解析，语义分支必须失效。
  const boundaryID = boundary?.tailStartID ?? boundary?.markerID
  const boundaryRow = boundaryID
    ? db
        .select({ id: MessageTable.id, time: MessageTable.time_created })
        .from(MessageTable)
        .where(and(eq(MessageTable.session_id, sessionID), eq(MessageTable.id, boundaryID)))
        .get()
    : undefined
  // semantic eligibility 需要 owner 与 boundary 的持久时间；维护 cursor 仍只负责物理枚举，不复用这里的顺序。
  const messageTimes = new Map<string, number>(
    db
      .select({ id: MessageTable.id, time: MessageTable.time_created })
      .from(MessageTable)
      .where(eq(MessageTable.session_id, sessionID))
      .all()
      .map((row) => [row.id, row.time] as const),
  )
  // parent_id 是 task/subagent 权威分类；fork 无 parent，走 root 时钟，禁止用标题匹配。
  const aged = session.parentID
    ? (() => {
        const last = lastMessageCreated(db, sessionID)
        return last !== null && last <= now - SUBAGENT_IDLE_MS
      })()
    : session.updated <= now - rootOlderThanMs
  return {
    aged,
    completed: session.parentID ? completedReviewMessages(db, sessionID) : new Set<string>(),
    boundary: boundaryRow ? { id: boundaryRow.id, time: boundaryRow.time } : undefined,
    markerID: boundary?.markerID,
    summaryID: boundary?.summaryID,
    messageTimes,
  }
}

// aged session 的所有 owner 都可检查白名单；recent session 只允许严格早于 completed boundary 的 compacted head。
// 边界与 owner 都按持久 (time_created, BINARY id) tuple 比较：回绕后 raw ID 字典序不再代表时间。
// marker、summary 与 tail 即使通过 age/boundary，仍必须通过 extraction 白名单才能真正冻结。
function eligible(state: ReturnType<typeof eligibility>, messageID: string, markerPart = false) {
  if (!state) return false
  if (state.completed.has(messageID)) return true
  if (!state.aged && ((markerPart && messageID === state.markerID) || (!markerPart && messageID === state.summaryID)))
    return false
  if (state.aged) return true
  const ownerTime = state.messageTimes.get(messageID)
  if (ownerTime === undefined || state.boundary === undefined) return false
  // 同时间 ID 必须按 SQLite BINARY 的 UTF-8 bytes 比较，不能把 caller ID 字典序当作 chronology。
  return (
    ownerTime < state.boundary.time ||
    (ownerTime === state.boundary.time && Buffer.compare(Buffer.from(messageID), Buffer.from(state.boundary.id)) < 0)
  )
}

// 空 cursor 是无 closed Message 的 sentinel：任何真实变更都晚于它，无需查行。
// 非空 cursor 解析失败则是持久化损坏，必须响亮失败而不是猜测边界。
export function compareStoredMessageCursor(db: TxOrDb, sessionID: SessionID, messageID: MessageID, cursor: string) {
  if (cursor === "") return 1
  const message = db
    .select({ time: MessageTable.time_created })
    .from(MessageTable)
    .where(and(eq(MessageTable.id, messageID), eq(MessageTable.session_id, sessionID)))
    .get()
  if (!message) return undefined
  const boundary = db
    .select({ id: MessageTable.id, time: MessageTable.time_created })
    .from(MessageTable)
    .where(and(eq(MessageTable.id, MessageID.make(cursor)), eq(MessageTable.session_id, sessionID)))
    .get()
  if (!boundary) throw new CorruptionError({ message: `Session summary cursor is not resolvable: ${sessionID}` })
  return message.time - boundary.time || Buffer.compare(Buffer.from(messageID), Buffer.from(boundary.id))
}

// 单 hash 反算只服务普通 owner update/delete 的强一致检查；批量维护必须使用 ownerCounts 避免 N+1 SQL。
// Message 与 Part 都可能引用同一表中的不同 kind payload，因此计数始终合并两个 owner 表。
// 外键只证明 hash 存在，不能证明 ref_count 正确；release 前必须用真实 owner 数拒绝静默漂移。
function ownerCount(db: TxOrDb, hash: string) {
  const messages =
    db
      .select({ value: sql<number>`count(*)` })
      .from(MessageTable)
      .where(eq(MessageTable.cold_ref, hash))
      .get()?.value ?? 0
  const parts =
    db
      .select({ value: sql<number>`count(*)` })
      .from(PartTable)
      .where(eq(PartTable.cold_ref, hash))
      .get()?.value ?? 0
  const summaries =
    db
      .select({ value: sql<number>`count(*)` })
      .from(SessionTable)
      .where(eq(SessionTable.summary_ref, hash))
      .get()?.value ?? 0
  return messages + parts + summaries
}

// ownerCounts 以固定分块执行两个 GROUP BY，既遵守 SQLite variable 上限，也把数万 payload 的验证压成少量查询。
// 未出现在结果中的 hash 按零 owner 处理；调用方再结合 payload row 区分 orphan 与 missing payload。
// 计数 map 不读取 payload bytes，status/cleanup 不会因为报告引用关系而触发任何 thaw 或 zstd 解压。
export function ownerCounts(db: TxOrDb, hashes: string[]) {
  const result = new Map<string, number>()
  if (hashes.length === 0) return result
  for (let offset = 0; offset < hashes.length; offset += DEFAULT_BATCH_SIZE) {
    const batch = hashes.slice(offset, offset + DEFAULT_BATCH_SIZE)
    for (const row of db
      .select({ hash: MessageTable.cold_ref, value: sql<number>`count(*)` })
      .from(MessageTable)
      .where(inArray(MessageTable.cold_ref, batch))
      .groupBy(MessageTable.cold_ref)
      .all()) {
      if (row.hash) result.set(row.hash, row.value)
    }
    for (const row of db
      .select({ hash: PartTable.cold_ref, value: sql<number>`count(*)` })
      .from(PartTable)
      .where(inArray(PartTable.cold_ref, batch))
      .groupBy(PartTable.cold_ref)
      .all()) {
      if (row.hash) result.set(row.hash, (result.get(row.hash) ?? 0) + row.value)
    }
    for (const row of db
      .select({ hash: SessionTable.summary_ref, value: sql<number>`count(*)` })
      .from(SessionTable)
      .where(inArray(SessionTable.summary_ref, batch))
      .groupBy(SessionTable.summary_ref)
      .all()) {
      if (row.hash) result.set(row.hash, (result.get(row.hash) ?? 0) + row.value)
    }
  }
  return result
}

// status 的 F4 raw 需要每个 pack 的 distinct cold_key 数；owners/keys 才是 entry 共享倍率。
// 只扫 message/part：session-summary 无 entry key，仍用 ownerCounts 的 raw×owners。
// 返回值只含 keys：owner 数继续由 ownerCounts 反算，避免两套计数口径分叉。
function packKeyStats(db: TxOrDb, hashes: string[]) {
  const result = new Map<string, number>()
  if (hashes.length === 0) return result
  for (let offset = 0; offset < hashes.length; offset += DEFAULT_BATCH_SIZE) {
    const batch = hashes.slice(offset, offset + DEFAULT_BATCH_SIZE)
    for (const row of db
      .select({
        hash: MessageTable.cold_ref,
        keys: sql<number>`count(distinct ${MessageTable.cold_key})`,
      })
      .from(MessageTable)
      .where(inArray(MessageTable.cold_ref, batch))
      .groupBy(MessageTable.cold_ref)
      .all()) {
      if (row.hash) result.set(row.hash, row.keys)
    }
    for (const row of db
      .select({
        hash: PartTable.cold_ref,
        keys: sql<number>`count(distinct ${PartTable.cold_key})`,
      })
      .from(PartTable)
      .where(inArray(PartTable.cold_ref, batch))
      .groupBy(PartTable.cold_ref)
      .all()) {
      // 正常 kind 下同一 hash 只会出现在 message 或 part 一侧；相加仅防御异常双引用。
      if (row.hash) result.set(row.hash, (result.get(row.hash) ?? 0) + row.keys)
    }
  }
  return result
}

export function requireReferenceMetadata(db: TxOrDb, hashes: string[], kind: PackKind | "session-summary") {
  // unique hash 去重只减少 SQL 工作量，不改变每个真实 owner 对 ref_count 的贡献。
  const unique = [...new Set(hashes)]
  if (unique.length === 0) return
  // existence 与 kind 在同一小投影查询中验证，缺失 payload 不能被解释为空统计值。
  const payloads = new Map(
    db
      .select({ hash: ColdStorageTable.hash, kind: ColdStorageTable.kind, refs: ColdStorageTable.ref_count })
      .from(ColdStorageTable)
      .where(inArray(ColdStorageTable.hash, unique))
      .all()
      .map((row) => [row.hash, row] as const),
  )
  // metadata-only consumer 不读取 payload BLOB，但仍须证明计数等于三类真实 owner。
  const counts = ownerCounts(db, unique)
  // 该门禁由 Summary inspect 和 v2 Stats 共用，避免两个只读消费者产生不同 corruption verdict。
  for (const hash of unique) {
    const payload = payloads.get(hash)
    if (!payload || payload.kind !== kind || payload.refs !== (counts.get(hash) ?? 0)) {
      // 验证失败不调用 repair；只有显式 verify --repair 拥有修改 ref_count 的权限。
      throw new CorruptionError({ message: "Cold payload reference metadata is inconsistent", hash })
    }
  }
}

// 引用增加按 hash 聚合，fork 和 maintenance 都不会对共享 payload 执行重复 UPDATE。
// CASE 增量基于事务开始时已验证的 ref_count；owner 批量写入失败时该语句不会单独提交。
// 再按 DEFAULT_BATCH_SIZE 分块，避免大型 fork 的唯一 hash 数超过 SQLite 参数和表达式限制。
export function incrementReferences(db: TxOrDb, values: Array<{ hash: string }>, now: number) {
  const counts = new Map<string, number>()
  for (const value of values) counts.set(value.hash, (counts.get(value.hash) ?? 0) + 1)
  const entries = [...counts]
  if (entries.length === 0) return
  for (let offset = 0; offset < entries.length; offset += DEFAULT_BATCH_SIZE) {
    const batch = entries.slice(offset, offset + DEFAULT_BATCH_SIZE)
    const cases = batch.map(
      ([hash, count]) => sql`when ${ColdStorageTable.hash} = ${hash} then ${ColdStorageTable.ref_count} + ${count}`,
    )
    db.update(ColdStorageTable)
      .set({
        ref_count: sql`case ${sql.join(cases, sql.raw(" "))} else ${ColdStorageTable.ref_count} end`,
        time_updated: now,
      })
      .where(
        inArray(
          ColdStorageTable.hash,
          batch.map(([hash]) => hash),
        ),
      )
      .run()
  }
}

// decodedBatch 在修改任何 owner 前证明 payload 集合完整、kind 一致且 ref_count 等于真实引用。
// 同一 hash 每批只解压一次，但 projection 仍逐 owner 合并，因为其热字段可能不同。
// missing payload 或计数漂移会阻断整批 expand，禁止部分 owner 清 ref 后留下不可恢复的兄弟 owner。
export function decodedBatch(db: TxOrDb, hashes: string[], owner: OwnerKind) {
  const unique = [...new Set(hashes)]
  if (unique.length === 0) return new Map<string, Envelope>()
  const payloads = db.select().from(ColdStorageTable).where(inArray(ColdStorageTable.hash, unique)).all()
  if (payloads.length !== unique.length) {
    throw new CorruptionError({ message: "Cold batch contains a missing payload" })
  }
  const counts = ownerCounts(db, unique)
  const result = new Map<string, Envelope>()
  for (const payload of payloads) {
    if (payload.kind !== owner || payload.ref_count !== (counts.get(payload.hash) ?? 0)) {
      throw new CorruptionError({ message: "Cold batch payload metadata is inconsistent", hash: payload.hash })
    }
    result.set(payload.hash, decode(db, payload.hash, owner))
  }
  return result
}

// decodedBatch 的完整性检查保证每个 requested hash 都有值；该 helper 把保证转成显式分支而非非空断言。
// 若未来 batching 代码破坏 map 完整性，expand 会以 typed corruption 中止而不是向 restore 传 undefined。
export function requiredEnvelope(values: Map<string, Envelope>, hash: string) {
  const value = values.get(hash)
  if (!value) throw new CorruptionError({ message: "Decoded cold batch is missing an envelope", hash })
  return value
}

// 调用者先完成owner切换，再在同一事务内释放本批旧引用。
function decrementReferences(db: TxOrDb, hashes: string[], now: number) {
  // owner/refcount 交换由调用方的 immediate transaction 包住，崩溃不会留下半写 projection。
  const counts = new Map<string, number>()
  // 多个owner可释放同一地址，按次数聚合而不是按唯一hash减一。
  for (const hash of hashes) counts.set(hash, (counts.get(hash) ?? 0) + 1)
  const entries = [...counts]
  if (entries.length === 0) return
  const cases = entries.map(
    ([hash, count]) => sql`when ${ColdStorageTable.hash} = ${hash} then ${ColdStorageTable.ref_count} - ${count}`,
  )
  const affected = entries.map(([hash]) => hash)
  // 已耗尽包无需先 UPDATE 大 BLOB 所在行再 DELETE，直接释放仍保留真实 owner 的安全闸。
  const exhausted = entries.map(([hash, count]) => sql`when ${ColdStorageTable.hash} = ${hash} then ${count}`)
  db.delete(ColdStorageTable)
    .where(
      and(
        inArray(ColdStorageTable.hash, affected),
        eq(ColdStorageTable.ref_count, sql`case ${sql.join(exhausted, sql.raw(" "))} else -1 end`),
        // 包的三个引用入口都清空才可删除，不能只检查本批所属的owner表。
        sql`not exists (select 1 from ${MessageTable} where ${MessageTable.cold_ref} = ${ColdStorageTable.hash})`,
        sql`not exists (select 1 from ${PartTable} where ${PartTable.cold_ref} = ${ColdStorageTable.hash})`,
        sql`not exists (select 1 from ${SessionTable} where ${SessionTable.summary_ref} = ${ColdStorageTable.hash})`,
      ),
    )
    .run()
  // 已删除地址不会命中UPDATE，仍共享的包继续扣除本批移出的引用。
  db.update(ColdStorageTable)
    .set({
      ref_count: sql`case ${sql.join(cases, sql.raw(" "))} else ${ColdStorageTable.ref_count} end`,
      time_updated: now,
    })
    .where(inArray(ColdStorageTable.hash, affected))
    .run()
}

type MessagePackItem = {
  row: typeof MessageTable.$inferSelect
  projection: (typeof MessageTable.$inferSelect)["data"]
  entry: PackEntry
  oldRef: string | null
}

// status eligibility 只需要这些字段；完整 freeze/repack 调用方仍可传入整行。
type MessageValueRow = Pick<typeof MessageTable.$inferSelect, "id" | "session_id" | "data" | "cold_ref" | "cold_key">

function cachedEnvelope(db: TxOrDb, hash: string, owner: OwnerKind, cache?: Map<string, Envelope>) {
  if (!cache) return decode(db, hash, owner)
  const key = `${owner}:${hash}`
  const existing = cache.get(key)
  if (existing) return existing
  const value = decode(db, hash, owner)
  cache.set(key, value)
  return value
}

function messageV2Value<Row extends MessageValueRow>(db: TxOrDb, row: Row, cache?: Map<string, Envelope>) {
  if (row.cold_key)
    throw new CorruptionError({ message: "Message v2 owner was selected for repack", hash: row.cold_ref ?? undefined })
  const data = row.cold_ref
    ? restoreMessage(row.data, cachedEnvelope(db, row.cold_ref, "message", cache), row.cold_ref)
    : row.data
  const value = extractMessageV2(data)
  if (!value) return
  return {
    row,
    projection: value.projection,
    entry: { key: value.key, fields: value.fields },
    oldRef: row.cold_ref,
  }
}

// 单 owner freeze 也通过 Session/kind pack builder，保证 direct freeze 与 batch compress 产生相同 key/ref 语义。
// 已有同 Session v2 owners 会被纳入重打包；新 pack 先取得 refs，owner row 全部切换后再批量递减旧 pack。
function freezeMessagePacked(db: TxOrDb, row: typeof MessageTable.$inferSelect, now: number): FreezeResult {
  const target = messageV2Value(db, row)
  if (!target) return { type: "skipped", reason: "no-fields" }
  const existing = db
    .select()
    .from(MessageTable)
    .where(
      and(
        eq(MessageTable.session_id, row.session_id),
        isNotNull(MessageTable.cold_ref),
        isNotNull(MessageTable.cold_key),
      ),
    )
    .orderBy(MessageTable.id)
    .all()
    .filter((item) => item.id !== row.id)
    .map((item) => {
      if (!item.cold_ref || !item.cold_key)
        throw new CorruptionError({ message: "Message v2 owner state is incomplete" })
      const entries = decodePack(db, item.cold_ref, "message")
      const fields = entries.get(item.cold_key.toString("hex"))
      if (!fields)
        throw new CorruptionError({ message: "Message v2 owner key is missing from pack", hash: item.cold_ref })
      return {
        row: item,
        projection: item.data,
        entry: { key: entryKey("message", fields), fields },
        oldRef: item.cold_ref,
      } satisfies MessagePackItem
    })
  const items = [...existing, target].sort((a, b) => a.row.id.localeCompare(b.row.id))
  const chunks = splitPacks("message", items)
  const assignments = new Map<MessageID, { hash: string; key: Buffer }>()
  for (const chunk of chunks) {
    const packed = retainPackPayload(
      db,
      "message",
      chunk.map((item) => item.entry),
      now,
    )
    const added = chunk.filter((item) => item.oldRef !== packed.hash).length
    if (added > 0) retainPackedReference(db, packed.hash, "message", now, added)
    for (const item of chunk)
      assignments.set(item.row.id, { hash: packed.hash, key: requiredPackKey(packed, item.entry.key) })
  }

  for (const item of items) {
    const assignment = assignments.get(item.row.id)
    if (!assignment)
      throw new CorruptionError({ message: "Message pack assignment is incomplete", hash: item.oldRef ?? undefined })
    const updated = db
      .update(MessageTable)
      .set({
        data: item.projection,
        cold_ref: assignment.hash,
        cold_key: assignment.key,
        time_updated: item.row.time_updated,
      })
      .where(eq(MessageTable.id, item.row.id))
      .returning({ id: MessageTable.id })
      .get()
    if (!updated) throw new CorruptionError({ message: `Message disappeared during pack: ${item.row.id}` })
  }
  const moved = items.flatMap((item) => {
    const assignment = assignments.get(item.row.id)
    return item.oldRef && assignment && item.oldRef !== assignment.hash ? [item.oldRef] : []
  })
  decrementReferences(db, moved, now)
  const assigned = assignments.get(row.id)
  if (!assigned) throw new CorruptionError({ message: `Message pack target missing: ${row.id}` })
  const packed = chunks.find((chunk) => chunk.some((item) => item.row.id === row.id))
  if (!packed) throw new CorruptionError({ message: `Message pack target chunk missing: ${row.id}` })
  const envelopeValue = packEnvelope(
    "message",
    packed.map((item) => item.entry),
  )
  const payload = db
    .select({ compressed_bytes: ColdStorageTable.compressed_bytes })
    .from(ColdStorageTable)
    .where(eq(ColdStorageTable.hash, assigned.hash))
    .get()
  if (!payload) throw new CorruptionError({ message: "Message pack disappeared after assignment", hash: assigned.hash })
  return {
    type: "frozen",
    hash: assigned.hash,
    rawBytes: envelopeValue.raw.byteLength,
    compressedBytes: payload.compressed_bytes,
  }
}

type PartPackItem = {
  row: typeof PartTable.$inferSelect
  projection: (typeof PartTable.$inferSelect)["data"]
  stats: PartColdStats | null
  entry: PackEntry
  oldRef: string | null
}

// cold_stats 保留是为了沿用 v1/hot 损坏门禁，而不是把 Stats 当作第二 eligibility 源。
type PartValueRow = Pick<
  typeof PartTable.$inferSelect,
  "id" | "message_id" | "session_id" | "data" | "cold_ref" | "cold_key" | "cold_stats"
>

function partV2Value<Row extends PartValueRow>(db: TxOrDb, row: Row, cache?: Map<string, Envelope>) {
  if (row.cold_key)
    throw new CorruptionError({ message: "Part v2 owner was selected for repack", hash: row.cold_ref ?? undefined })
  if (row.cold_stats !== null)
    throw new CorruptionError({
      message: "Hot or v1 Part has an unexpected cold Stats projection",
      hash: row.cold_ref ?? undefined,
    })
  const data = row.cold_ref
    ? restorePart(row.data, cachedEnvelope(db, row.cold_ref, "part", cache), row.cold_ref)
    : row.data
  const value = extractPartV2(data, row.session_id)
  if (!value) return
  return {
    row,
    projection: value.projection,
    stats: projectPartStats(data),
    entry: { key: value.key, fields: value.fields },
    oldRef: row.cold_ref,
  }
}

// Part direct freeze 与 Message 对称；现有同 Session v2 parts 会在需要时重打包，保证 key/ref 生命周期独立。
function freezePartPacked(db: TxOrDb, row: typeof PartTable.$inferSelect, now: number): FreezeResult {
  const target = partV2Value(db, row)
  if (!target) return { type: "skipped", reason: "no-fields" }
  const existing = db
    .select()
    .from(PartTable)
    .where(and(eq(PartTable.session_id, row.session_id), isNotNull(PartTable.cold_ref), isNotNull(PartTable.cold_key)))
    .orderBy(PartTable.id)
    .all()
    .filter((item) => item.id !== row.id)
    .map((item) => {
      if (!item.cold_ref || !item.cold_key) throw new CorruptionError({ message: "Part v2 owner state is incomplete" })
      const entries = decodePack(db, item.cold_ref, "part")
      const fields = entries.get(item.cold_key.toString("hex"))
      if (!fields) throw new CorruptionError({ message: "Part v2 owner key is missing from pack", hash: item.cold_ref })
      const data = restorePackedPart(item.data, fields, item.cold_ref)
      return {
        row: item,
        projection: item.data,
        stats: requirePartStats(item, projectPartStats(data)),
        entry: { key: entryKey("part", fields), fields },
        oldRef: item.cold_ref,
      } satisfies PartPackItem
    })
  const items = [...existing, target].sort((a, b) => a.row.id.localeCompare(b.row.id))
  const chunks = splitPacks("part", items)
  const assignments = new Map<PartID, { hash: string; key: Buffer }>()
  for (const chunk of chunks) {
    const packed = retainPackPayload(
      db,
      "part",
      chunk.map((item) => item.entry),
      now,
    )
    const added = chunk.filter((item) => item.oldRef !== packed.hash).length
    if (added > 0) retainPackedReference(db, packed.hash, "part", now, added)
    for (const item of chunk)
      assignments.set(item.row.id, { hash: packed.hash, key: requiredPackKey(packed, item.entry.key) })
  }
  for (const item of items) {
    const assignment = assignments.get(item.row.id)
    if (!assignment)
      throw new CorruptionError({ message: "Part pack assignment is incomplete", hash: item.oldRef ?? undefined })
    const updated = db
      .update(PartTable)
      .set({
        data: item.projection,
        cold_ref: assignment.hash,
        cold_key: assignment.key,
        cold_stats: compactPartStats(item.stats),
        time_updated: item.row.time_updated,
      })
      .where(eq(PartTable.id, item.row.id))
      .returning({ id: PartTable.id })
      .get()
    if (!updated) throw new CorruptionError({ message: `Part disappeared during pack: ${item.row.id}` })
  }
  decrementReferences(
    db,
    items.flatMap((item) => {
      const assignment = assignments.get(item.row.id)
      return item.oldRef && assignment && item.oldRef !== assignment.hash ? [item.oldRef] : []
    }),
    now,
  )
  const assigned = assignments.get(row.id)
  if (!assigned) throw new CorruptionError({ message: `Part pack target missing: ${row.id}` })
  const packed = chunks.find((chunk) => chunk.some((item) => item.row.id === row.id))
  if (!packed) throw new CorruptionError({ message: `Part pack target chunk missing: ${row.id}` })
  const payload = db
    .select({ raw_bytes: ColdStorageTable.raw_bytes, compressed_bytes: ColdStorageTable.compressed_bytes })
    .from(ColdStorageTable)
    .where(eq(ColdStorageTable.hash, assigned.hash))
    .get()
  if (!payload) throw new CorruptionError({ message: "Part pack disappeared after assignment", hash: assigned.hash })
  return {
    type: "frozen",
    hash: assigned.hash,
    rawBytes: payload.raw_bytes,
    compressedBytes: payload.compressed_bytes,
  }
}

// 一个 pack chunk 内的 owner projection 使用单条 SQLite upsert，而不是每行一次 UPDATE。
// maintenance 已持有 immediate transaction；同一批不会被其他 writer 插入竞争，RETURNING 仍验证每个 owner 都被写回。
function assignMessagePack(db: TxOrDb, items: MessagePackItem[], packed: ReturnType<typeof retainPackPayload>) {
  const hash = packed.hash
  for (let offset = 0; offset < items.length; offset += DEFAULT_BATCH_SIZE) {
    const values = items.slice(offset, offset + DEFAULT_BATCH_SIZE).map((item) => ({
      id: item.row.id,
      session_id: item.row.session_id,
      time_created: item.row.time_created,
      time_updated: item.row.time_updated,
      data: item.projection,
      cold_ref: hash,
      cold_key: requiredPackKey(packed, item.entry.key),
    }))
    const updated = db
      .insert(MessageTable)
      .values(values)
      .onConflictDoUpdate({
        target: MessageTable.id,
        set: {
          data: sql`excluded.data`,
          cold_ref: sql`excluded.cold_ref`,
          cold_key: sql`excluded.cold_key`,
          time_updated: sql`excluded.time_updated`,
        },
      })
      .returning({ id: MessageTable.id })
      .all()
    if (updated.length !== values.length)
      throw new CorruptionError({ message: "Message pack assignment is incomplete", hash })
  }
}

function assignPartPack(db: TxOrDb, items: PartPackItem[], packed: ReturnType<typeof retainPackPayload>) {
  const hash = packed.hash
  // 一个 chunk 使用批量 upsert，避免每个 Part 各执行 UPDATE 导致 SQLite writer 往返成为瓶颈。
  // 2000 行与公共 batch 上限一致，既降低 statement 次数也不超过当前 SQLite variable 限制。
  for (let offset = 0; offset < items.length; offset += DEFAULT_BATCH_SIZE) {
    // 原始 timestamps 随 values 回写，maintenance 不能改变 Session 活跃度或 Part chronology。
    const values = items.slice(offset, offset + DEFAULT_BATCH_SIZE).map((item) => ({
      id: item.row.id,
      message_id: item.row.message_id,
      session_id: item.row.session_id,
      time_created: item.row.time_created,
      time_updated: item.row.time_updated,
      data: item.projection,
      cold_ref: hash,
      // 每个 owner 保留自己的 key；entry 去重不能丢失一对一恢复定位。
      cold_key: requiredPackKey(packed, item.entry.key),
      // 非 Tool/Step 的 stats 必须是 NULL，不能沿用上一轮对象中的派生值。
      cold_stats: compactPartStats(item.stats),
    }))
    // data、ref、key、stats 在同一 statement 切换，任何半状态都属于 corruption。
    // excluded 值只来自已经验证的 extraction projection，不接受任意 storage skeleton。
    const updated = db
      .insert(PartTable)
      .values(values)
      .onConflictDoUpdate({
        target: PartTable.id,
        set: {
          data: sql`excluded.data`,
          cold_ref: sql`excluded.cold_ref`,
          cold_key: sql`excluded.cold_key`,
          cold_stats: sql`excluded.cold_stats`,
          time_updated: sql`excluded.time_updated`,
        },
      })
      .returning({ id: PartTable.id })
      .all()
    // payload ref 已由 caller 预先 retain，只有完整 assignment 后才能递减旧引用。
    // returning 缺一行会回滚 immediate transaction，不能留下已 retain 却未归属的 payload。
    if (updated.length !== values.length)
      throw new CorruptionError({ message: "Part pack assignment is incomplete", hash })
  }
}

function prepareFreezeBatch(
  request: { sessionID?: SessionID; batchSize: number; olderThanMs: number },
  cursor: { owner: "message" | "part" | "session-summary"; lastID: string },
) {
  if (cursor.owner === "session-summary") throw new ValidationError({ message: "Invalid freeze cursor" })
  // 只读事务固定 owner 与资格快照；编码交给线程后释放 SQLite 读锁。
  return Database.transaction(
    (db) => {
      const admission = batchEligibility(db, Date.now(), request.olderThanMs)
      // v1 包可被同批多个 owner 引用，读取快照内复用其已验证的 envelope。
      const cache = new Map<string, Envelope>()
      if (cursor.owner === "message") {
        const rows = nextMessageRows(db, request, cursor.lastID, false, request.batchSize)
        // 按 Session 组织首次包，继续沿用显式冻结的分组边界。
        const groups = new Map<SessionID, MessagePackItem[]>()
        for (const row of rows) {
          const value = messageV2Value(db, row, cache)
          if (!value || !eligible(admission(row.session_id), row.id)) continue
          const group = groups.get(row.session_id)
          if (group) group.push(value)
          else groups.set(row.session_id, [value])
        }
        return {
          cursor: { owner: "message" as const, lastID: rows.at(-1)?.id ?? cursor.lastID },
          // 计数包含已检查但没有可抽取字段的行，游标仍需跨过它们。
          processed: rows.length,
          olderThanMs: request.olderThanMs,
          chunks: [...groups.values()].flatMap((items) =>
            splitPacks("message", items).map((items) => ({ owner: "message" as const, items })),
          ),
        }
      }
      const rows = nextPartRows(db, request, cursor.lastID, false, request.batchSize)
      const groups = new Map<SessionID, PartPackItem[]>()
      for (const row of rows) {
        const value = partV2Value(db, row, cache)
        if (!value || !eligible(admission(row.session_id), row.message_id)) continue
        const group = groups.get(row.session_id)
        if (group) group.push(value)
        else groups.set(row.session_id, [value])
      }
      return {
        cursor: { owner: "part" as const, lastID: rows.at(-1)?.id ?? cursor.lastID },
        // 空 chunks 仍可能检查过候选，扫描量与真正冻结数量分开报告。
        processed: rows.length,
        olderThanMs: request.olderThanMs,
        chunks: [...groups.values()].flatMap((items) =>
          splitPacks("part", items).map((items) => ({ owner: "part" as const, items })),
        ),
      }
    },
    { behavior: "deferred" },
  )
}

function commitFreezeBatch(prepared: ReturnType<typeof prepareFreezeBatch>, packs: PackedChunk[]) {
  // 空扫描才结束当前 owner 阶段，全部候选暂时不合格时仍需推进游标。
  if (!prepared.processed) return { empty: true as const }
  return Database.transaction(
    (db) => {
      const now = Date.now()
      const admission = batchEligibility(db, now, prepared.olderThanMs)
      // 编码时释放了读锁，下面用新事务逐块重验资格与行快照。
      let frozen = 0
      let rawBytes = 0
      let compressedBytes = 0
      for (const [index, chunk] of prepared.chunks.entries()) {
        // 批量重读能发现删除；数量不一致会使整块失效，而不是重建已删除 owner。
        const current =
          chunk.owner === "message"
            ? db
                .select()
                .from(MessageTable)
                .where(
                  inArray(
                    MessageTable.id,
                    chunk.items.map((item) => item.row.id),
                  ),
                )
                .all()
            : db
                .select()
                .from(PartTable)
                .where(
                  inArray(
                    PartTable.id,
                    chunk.items.map((item) => item.row.id),
                  ),
                )
                .all()
        // 完整行快照覆盖同毫秒更新；资格在写事务中重算，以当前 Session 活跃度为准。
        const snapshots = new Map(chunk.items.map((item) => [String(item.row.id), JSON.stringify(item.row)]))
        // 按 ID 比较完整行，SQL 返回顺序与读取阶段无须相同。
        const live =
          current.length === chunk.items.length &&
          current.every(
            (row) =>
              snapshots.get(row.id) === JSON.stringify(row) &&
              eligible(admission(row.session_id), "message_id" in row ? row.message_id : row.id),
          )
        if (!live) continue
        // 先确认整个 chunk，再落包和引用；被更新或删除的 owner 留待下一次显式维护。
        const encoded = packs[index]
        // Promise.all 保持输入次序，编码完成先后不会错配 chunk 与 slot。
        const packed = insertPackedBytes(
          db,
          chunk.owner,
          {
            ...encoded,
            keys: new Map(encoded.slots.map(([key, slot]) => [key, Buffer.from(slot, "hex")])),
          },
          now,
        )
        // 引用按 owner 计数，块内相同字段去重后依然可以有多个引用者。
        retainPackedReference(db, packed.hash, chunk.owner, now, chunk.items.length)
        if (chunk.owner === "message") assignMessagePack(db, chunk.items, packed)
        else assignPartPack(db, chunk.items, packed)
        // v1 升级仍有旧引用；所有新位置落盘后才释放这些引用。
        decrementReferences(
          db,
          chunk.items.flatMap((item) => (item.oldRef ? [item.oldRef] : [])),
          now,
        )
        frozen += chunk.items.length
        // 包字节只累计一次，不能随共享 owner 数重复累计。
        rawBytes += packed.rawBytes
        compressedBytes += packed.compressedBytes
      }
      return {
        empty: false as const,
        cursor: prepared.cursor,
        processed: prepared.processed,
        // 并发变化导致的保留行计入 skipped，当前任务继续从已检查范围之后推进。
        skipped: prepared.processed - frozen,
        rawBytes,
        compressedBytes,
      }
    },
    { behavior: "immediate" },
  )
}

// release 的调用前提是当前 owner 已在同一事务清除 cold_ref，所以 remaining 是“其他 owner”的真实数量。
// ref_count 必须恰好等于 remaining+1；偏大或偏小都代表外部破坏，不能在正常删除中自动修正。
// 最后一个 owner 删除 payload，否则只把计数设置为反算值；该语义保护 fork 父子独立 thaw/delete。
export function release(db: TxOrDb, hash: string) {
  const payload = db.select().from(ColdStorageTable).where(eq(ColdStorageTable.hash, hash)).get()
  if (!payload) throw new CorruptionError({ message: "Cold reference points to a missing payload", hash })
  const remaining = ownerCount(db, hash)
  // caller 必须先清除当前 owner 引用；因此旧 ref_count 应精确等于 remaining + 1。
  // 不匹配时 rollback 比“修正后继续”更安全，verify 才是外部不一致的唯一修复 owner。
  if (payload.ref_count !== remaining + 1) {
    throw new CorruptionError({ message: "Cold payload reference count is inconsistent", hash })
  }
  if (remaining === 0) {
    db.delete(ColdStorageTable).where(eq(ColdStorageTable.hash, hash)).run()
    return
  }
  db.update(ColdStorageTable)
    .set({ ref_count: remaining, time_updated: Date.now() })
    .where(eq(ColdStorageTable.hash, hash))
    .run()
}

// decode 是所有恢复路径的唯一 codec/integrity gate，调用方不能直接读取 payload 并自行 JSON.parse。
// compressed size、zstd frame、raw size、SHA-256、canonical envelope 会依次验证，任一失败都不返回 projection。
// owner kind 参与 digest 和 envelope，双重阻止 Message payload 被误用于 Part 或反向恢复。
export function decode(db: TxOrDb, hash: string, owner: OwnerKind) {
  const payload = db.select().from(ColdStorageTable).where(eq(ColdStorageTable.hash, hash)).get()
  if (!payload) throw new CorruptionError({ message: "Cold reference points to a missing payload", hash })
  if (payload.kind !== owner || payload.codec !== "zstd") {
    throw new CorruptionError({ message: "Cold payload kind or codec is invalid", hash })
  }
  if (payload.payload.byteLength !== payload.compressed_bytes) {
    throw new CorruptionError({ message: "Cold payload compressed size does not match", hash })
  }
  const raw = decompress(payload.payload)
  if (raw.byteLength !== payload.raw_bytes || digest(owner, raw) !== hash) {
    throw new CorruptionError({ message: "Cold payload size or hash does not match", hash })
  }
  // 成功 decode 尚未合并 owner；restore 和 owner UPDATE 完成后才能 release 引用。
  return parseEnvelope(owner, raw, hash)
}

// decodePack 是 v2 owner 的唯一 pack integrity gate；解压后同时验证 pack hash、entry key 和 canonical 顺序。
// 调用方只能拿到经验证的 entry map，不能把任意 JSON 当作 projection 成功返回。
export function decodePack(db: TxOrDb, hash: string, owner: OwnerKind) {
  const payload = db.select().from(ColdStorageTable).where(eq(ColdStorageTable.hash, hash)).get()
  if (!payload) throw new CorruptionError({ message: "Cold pack reference points to a missing payload", hash })
  return decodePayload(owner, payload)
}

function requiredPackKey(packed: { hash: string; keys: Map<string, Buffer> }, key: Buffer) {
  // assignment 查的是完整内容身份，返回的短 slot 只负责定位。
  // 缺失映射应回滚本批，不能写入一个指向其他 entry 的默认序号。
  const value = packed.keys.get(key.toString("hex"))
  if (!value) throw new CorruptionError({ message: "Pack assignment entry is missing", hash: packed.hash })
  return value
}

// 单项冻结先形成内容地址，与 worker 产物共用存储核验和引用合同。
function retainPackPayload(db: TxOrDb, owner: OwnerKind, entries: PackEntry[], now: number) {
  return insertPackedBytes(db, owner, packEnvelope(owner, entries), now)
}

// 内容地址冲突必须验证 canonical 字节而不是信任 digest 相等；两条写入路径（在线 retain / 并行 repack 提交）共用同一复核。
function verifyExistingPackBytes(db: TxOrDb, owner: OwnerKind, hash: string, raw: Uint8Array) {
  const restored = decodePack(db, hash, owner)
  const restoredValue = packEnvelope(
    owner,
    [...restored.values()].map((fields) => ({ key: entryKey(owner, fields), fields })),
  )
  if (!restoredValue.raw.equals(raw)) {
    throw new CorruptionError({ message: "Cold pack hash collides with different canonical bytes", hash })
  }
}

// Pack ref_count 按 owner 增量而不是按 unique key 增量；相同 entry 被两个 Message 使用时仍需两个生命周期引用。
function retainPackedReference(db: TxOrDb, hash: string, owner: OwnerKind, now: number, count = 1) {
  // 引用门禁只需 kind/count；大 payload 留给唯一 decoder 校验，避免主线程重复搬运 BLOB。
  const payload = db
    .select({ kind: ColdStorageTable.kind, ref_count: ColdStorageTable.ref_count })
    .from(ColdStorageTable)
    .where(eq(ColdStorageTable.hash, hash))
    .get()
  if (!payload || payload.kind !== packKind(owner)) {
    throw new CorruptionError({ message: "Cold pack reference points to an invalid payload", hash })
  }
  if (payload.ref_count !== ownerCount(db, hash)) {
    throw new CorruptionError({ message: "Cold pack reference count is inconsistent", hash })
  }
  // DB 中三类 owner 是 refcount 权威，进程 cache 或 unique entry 数量都不能替代它。
  db.update(ColdStorageTable)
    .set({ ref_count: sql`${ColdStorageTable.ref_count} + ${count}`, time_updated: now })
    .where(eq(ColdStorageTable.hash, hash))
    .run()
}

// SummaryCache 的 inspect 只解码 aggregate，不修改 Session ref/cursor 或任何 payload ref_count。
// 该路径只恢复 Session aggregate；Message/Part 仍由对应 owner decoder 恢复。
export function decodeSummary(db: TxOrDb, hash: string) {
  const payload = db.select().from(ColdStorageTable).where(eq(ColdStorageTable.hash, hash)).get()
  if (!payload) throw new CorruptionError({ message: "Session summary reference points to a missing payload", hash })
  if (payload.kind !== "session-summary" || payload.codec !== "zstd") {
    throw new CorruptionError({ message: "Session summary payload kind or codec is invalid", hash })
  }
  if (payload.payload.byteLength !== payload.compressed_bytes) {
    throw new CorruptionError({ message: "Session summary compressed size does not match", hash })
  }
  const raw = decompress(payload.payload)
  if (raw.byteLength !== payload.raw_bytes || digest("session-summary", raw) !== hash) {
    throw new CorruptionError({ message: "Session summary size or hash does not match", hash })
  }
  return parseSummaryEnvelope(raw, hash)
}

// Summary payload 与 Message/Part 共用 same-table 内容地址和 zstd frame，但 ref owner 是 Session。
// 新 payload 先以零引用插入；SummaryCache 完成 Session CAS 后才调用 retainSummaryReference 增加真实 owner。
export function retainSummaryPayload(db: TxOrDb, diffs: SummaryPayload, now: number) {
  const value = summaryEnvelope(diffs)
  const existing = db.select().from(ColdStorageTable).where(eq(ColdStorageTable.hash, value.hash)).get()
  if (existing) {
    if (
      existing.kind !== "session-summary" ||
      existing.codec !== "zstd" ||
      existing.raw_bytes !== value.raw.byteLength ||
      existing.compressed_bytes !== existing.payload.byteLength ||
      existing.ref_count !== ownerCount(db, value.hash)
    ) {
      throw new CorruptionError({ message: "Existing session summary metadata is inconsistent", hash: value.hash })
    }
    const restored = decodeSummary(db, value.hash)
    if (!Buffer.from(canonical(summaryEnvelope(restored).value)).equals(value.raw)) {
      throw new CorruptionError({
        message: "Session summary hash collides with different canonical bytes",
        hash: value.hash,
      })
    }
    return { hash: value.hash, compressedBytes: existing.compressed_bytes }
  }

  const payload = compress(value.raw)
  db.insert(ColdStorageTable)
    .values({
      hash: value.hash,
      kind: "session-summary",
      codec: "zstd",
      payload,
      raw_bytes: value.raw.byteLength,
      compressed_bytes: payload.byteLength,
      ref_count: 0,
      time_created: now,
      time_updated: now,
    })
    .run()
  return { hash: value.hash, compressedBytes: payload.byteLength }
}

// SummaryCache 在 CAS 写入 Session 前调用 retain；ref_count 旧值必须等于真实 owner 数，禁止修正后继续。
export function retainSummaryReference(db: TxOrDb, hash: string, now: number) {
  const payload = db.select().from(ColdStorageTable).where(eq(ColdStorageTable.hash, hash)).get()
  if (!payload || payload.kind !== "session-summary") {
    throw new CorruptionError({ message: "Session summary reference points to an invalid payload", hash })
  }
  if (payload.ref_count !== ownerCount(db, hash)) {
    throw new CorruptionError({ message: "Session summary reference count is inconsistent", hash })
  }
  db.update(ColdStorageTable)
    .set({ ref_count: sql`${ColdStorageTable.ref_count} + 1`, time_updated: now })
    .where(eq(ColdStorageTable.hash, hash))
    .run()
}

// 调用方必须先在同一事务清除 Session.summary_ref；release 会用其余真实 Session/Message/Part owner 反算计数。
export function releaseSummaryReference(db: TxOrDb, hash: string) {
  release(db, hash)
}

// rebuild 需要读取完整 aggregate 但不能持久 thaw；该公开 seam 只返回经 integrity gate 验证的 FileDiff。
export function inspectSummary(db: TxOrDb, hash: string) {
  requireReferenceMetadata(db, [hash], "session-summary")
  return decodeSummary(db, hash)
}

function expandSummaryReference(db: TxOrDb, sessionID: SessionID, hash: string) {
  // expand 只热存不可从 Tool rows 重建的 opaque seed；delta 在下一次读取时按当前可见历史重新生成。
  // payload 必须在清 ref 前完成 codec/hash/schema 校验，损坏时原 owner 保持不变并让整个事务失败。
  // initialized 保持 true，明确禁止展开后重新读取可能已被用户清理或替换的 legacy mirror。
  const payload = decodeSummary(db, hash)
  // ref/cursor/seed 更新与最后 owner release 位于同一事务，崩溃不能留下已释放 payload 的热指针。
  const updated = db
    .update(SessionTable)
    .set({
      summary_ref: null,
      summary_cursor: null,
      summary_initialized: true,
      summary_init_dirty: false,
      summary_seed: payload.seed
        ? { cursor: payload.seed.cursor, diffs: payload.seed.diffs.map((item) => ({ ...item })) }
        : null,
      time_updated: SessionTable.time_updated,
    })
    .where(and(eq(SessionTable.id, sessionID), eq(SessionTable.summary_ref, hash)))
    .returning({ id: SessionTable.id })
    .get()
  if (!updated) throw new CorruptionError({ message: `Session summary changed during expand: ${sessionID}`, hash })
  releaseSummaryReference(db, hash)
}

// freeze 是单 owner 事务内核，供公开 freezeOwner 使用；批量 maintenance 复用相同 extraction/eligibility 规则。
// extraction 白名单先执行，只有真正候选才查询 session age/compaction boundary。
// owner update 以 cold_ref IS NULL 保护状态，若同事务外的预期被破坏则 hard-fail 而不是覆盖。
// payload 初始零引用，owner projection 写入后原子加一；任何异常都由 immediate transaction 回滚。
function freeze(
  db: TxOrDb,
  input: Owner & {
    now: number
    olderThanMs: number
    eligibilityState?: ReturnType<typeof eligibility> | (() => ReturnType<typeof eligibility>)
  },
): FreezeResult {
  if (input.type === "message") {
    const row = db.select().from(MessageTable).where(eq(MessageTable.id, input.id)).get()
    if (!row) return { type: "skipped", reason: "missing" }
    if (row.cold_key) return { type: "skipped", reason: "already-cold" }
    const source = row.cold_ref ? restoreMessage(row.data, decode(db, row.cold_ref, "message"), row.cold_ref) : row.data
    const value = extractMessageV2(source)
    if (!value) return { type: "skipped", reason: "no-fields" }
    const state =
      typeof input.eligibilityState === "function"
        ? input.eligibilityState()
        : (input.eligibilityState ?? eligibility(db, row.session_id, input.now, input.olderThanMs))
    if (!eligible(state, row.id)) return { type: "skipped", reason: "ineligible" }
    return freezeMessagePacked(db, row, input.now)
  }

  const row = db.select().from(PartTable).where(eq(PartTable.id, input.id)).get()
  if (!row) return { type: "skipped", reason: "missing" }
  if (row.cold_key) return { type: "skipped", reason: "already-cold" }
  const source = row.cold_ref ? restorePart(row.data, decode(db, row.cold_ref, "part"), row.cold_ref) : row.data
  const value = extractPartV2(source, row.session_id)
  if (!value) return { type: "skipped", reason: "no-fields" }
  const state =
    typeof input.eligibilityState === "function"
      ? input.eligibilityState()
      : (input.eligibilityState ?? eligibility(db, row.session_id, input.now, input.olderThanMs))
  if (!eligible(state, row.message_id)) return { type: "skipped", reason: "ineligible" }
  return freezePartPacked(db, row, input.now)
}

// 公开 freezeOwner 是测试、精确 session 操作和未来内部调用的最小 seam，不暴露 codec 或 projection 细节。
// olderThanMs 可由已规范化 maintenance request 传入，缺省 root 7 天；subagent 仍用固定 24h last-message。
// 返回 skipped reason 便于 task 计数，但不会把 ineligible/no-fields 当作错误或改写 owner。
export function freezeOwner(input: Owner & { now?: number; olderThanMs?: number }): FreezeResult {
  const now = input.now ?? Date.now()
  return Database.transaction((db) => freeze(db, { ...input, now, olderThanMs: input.olderThanMs ?? SEVEN_DAYS_MS }), {
    behavior: "immediate",
  })
}

// 显式解冻在同一事务内恢复、回填并释放引用，返回值沿用输入顺序。
export function thawMessageRows(rows: (typeof MessageTable.$inferSelect)[]) {
  if (!rows.some((row) => row.cold_ref)) {
    if (rows.some((row) => row.cold_key))
      throw new CorruptionError({ message: "Message owner has a key without a ref" })
    return rows
  }
  return Database.transaction(
    (db) => {
      const current = rows.map((input) => {
        if (input.cold_key && !input.cold_ref)
          throw new CorruptionError({ message: "Message owner has a key without a ref" })
        // 调用者可能持有旧投影，当前事务中的完整行决定实际恢复内容。
        const row = db.select().from(MessageTable).where(eq(MessageTable.id, input.id)).get()
        if (!row) throw new CorruptionError({ message: `Message disappeared during thaw: ${input.id}` })
        return row
      })
      // inspect 已统一版本、定位键和引用校验；解冻只增加持久回填步骤。
      const restored = inspectMessageRows(db, current).map((row) => {
        if (!row.cold_ref) return row
        db.update(MessageTable)
          .set({ data: row.data, cold_ref: null, cold_key: null, time_updated: row.time_updated })
          .where(and(eq(MessageTable.id, row.id), eq(MessageTable.cold_ref, row.cold_ref)))
          .run()
        return { ...row, cold_ref: null, cold_key: null }
      })
      // 所有 owner 完成回填后统一释放，fork 的兄弟引用继续保留。
      decrementReferences(
        db,
        current.flatMap((row) => (row.cold_ref ? [row.cold_ref] : [])),
        Date.now(),
      )
      return restored
    },
    { behavior: "immediate" },
  )
}

// Part 解冻在清除统计投影前，以恢复后的完整值验证统计一致性。
export function thawPartRows(rows: (typeof PartTable.$inferSelect)[]) {
  // fast path 只接受严格 hot `(NULL,NULL,NULL)`；key-only 或 stats-only 状态不能冒充无需处理。
  if (!rows.some((row) => row.cold_ref)) {
    if (rows.some((row) => row.cold_key)) throw new CorruptionError({ message: "Part owner has a key without a ref" })
    if (rows.some((row) => row.cold_stats !== null))
      throw new CorruptionError({ message: "Hot Part has a cold Stats projection" })
    return rows
  }
  return Database.transaction(
    (db) => {
      // 输入可能来自过期查询；事务内按 ID 重读才是选择当前 decoder 的事实。
      const current = rows.map((input) => {
        if (input.cold_key && !input.cold_ref)
          throw new CorruptionError({ message: "Part owner has a key without a ref" })
        const row = db.select().from(PartTable).where(eq(PartTable.id, input.id)).get()
        if (!row) throw new CorruptionError({ message: `Part disappeared during thaw: ${input.id}` })
        return row
      })
      const restored = inspectPartRows(db, current).map((row) => {
        if (!row.cold_ref) return row
        // packed owner 具有同行统计；v1 的兼容恢复继续使用原有字段合同。
        if (row.cold_key) requirePartStats(row, projectPartStats(row.data))
        db.update(PartTable)
          .set({ data: row.data, cold_ref: null, cold_key: null, cold_stats: null, time_updated: row.time_updated })
          .where(and(eq(PartTable.id, row.id), eq(PartTable.cold_ref, row.cold_ref)))
          .run()
        return { ...row, cold_ref: null, cold_key: null, cold_stats: null }
      })
      // 引用释放与完整 data 回填共用事务，任何统计错误都会回滚整个范围。
      decrementReferences(
        db,
        current.flatMap((row) => (row.cold_ref ? [row.cold_ref] : [])),
        Date.now(),
      )
      return restored
    },
    { behavior: "immediate" },
  )
}

// inspect 为普通读取恢复内存对象，保留 owner cold_ref 和 payload ref_count 不动。
// 它与 thaw 共用完整性门禁，只有持久预热才写回 owner 并释放引用。
export function inspectMessageRows(db: TxOrDb, rows: (typeof MessageTable.$inferSelect)[]) {
  // 一次读取按包分组，完整 Message 返回值不改变持久引用或时间戳。
  // 普通查看不调用 release，多个 fork 的共享生命周期保持独立。
  // v1 的单 owner envelope 与 packed owner 各走明确版本路径。
  const hashes = [...new Set(rows.flatMap((row) => (row.cold_ref && row.cold_key ? [row.cold_ref] : [])))]
  requireReferenceMetadata(db, hashes, "message-pack")
  const packs = new Map(hashes.map((hash) => [hash, decodePack(db, hash, "message")]))
  const legacy = decodedBatch(
    db,
    rows.flatMap((row) => (row.cold_ref && !row.cold_key ? [row.cold_ref] : [])),
    "message",
  )
  return rows.map((row) => {
    if (!row.cold_ref) {
      if (row.cold_key) throw new CorruptionError({ message: "Message key has no pack" })
      return row
    }
    if (!row.cold_key)
      return { ...row, data: restoreMessage(row.data, requiredEnvelope(legacy, row.cold_ref), row.cold_ref) }
    const fields = packs.get(row.cold_ref)?.get(row.cold_key.toString("hex"))
    if (!fields) throw new CorruptionError({ message: "Message inspect entry is missing", hash: row.cold_ref })
    return { ...row, data: restorePackedMessage(row.data, fields, row.cold_ref) }
  })
}

export function inspectPartRows(db: TxOrDb, rows: (typeof PartTable.$inferSelect)[]) {
  const legacy = rows.filter(
    (row): row is typeof row & { cold_ref: string; cold_key: null } => !!row.cold_ref && !row.cold_key,
  )
  const packed = rows.filter(
    (row): row is typeof row & { cold_ref: string; cold_key: Buffer } => !!row.cold_ref && !!row.cold_key,
  )
  const legacyValues = decodedBatch(
    db,
    legacy.map((row) => row.cold_ref),
    "part",
  )
  // 非持久 inspect 与 thaw/Stats 共用真实 owner gate，不能仅因 pack bytes 可解码就忽略 refcount drift。
  const packedHashes = [...new Set(packed.map((row) => row.cold_ref))]
  requireReferenceMetadata(db, packedHashes, "part-pack")
  const packs = new Map(packedHashes.map((hash) => [hash, decodePack(db, hash, "part")] as const))
  return rows.map((row) => {
    if (!row.cold_ref) {
      if (row.cold_key) throw new CorruptionError({ message: "Part owner has a key without a ref" })
      return row
    }
    if (row.cold_key) {
      const fields = packs.get(row.cold_ref)?.get(row.cold_key.toString("hex"))
      if (!fields) throw new CorruptionError({ message: "Part inspect key is missing from pack", hash: row.cold_ref })
      return { ...row, data: restorePackedPart(row.data, fields, row.cold_ref) }
    }
    return {
      ...row,
      data: restorePart(row.data, requiredEnvelope(legacyValues, row.cold_ref), row.cold_ref),
    }
  })
}

// thawOwner 提供显式单 owner 展开，并用返回 boolean 区分 missing/hot 与实际发生的持久 thaw。
// 它仍委托批量 row seam，不复制 decode、restore 或 refcount 规则。
// 该 API 不接受“只返回解压值但不回填”的模式，避免形成与持久预热并行的第二套缓存语义。
export function thawOwner(input: Owner) {
  if (input.type === "message") {
    const row = Database.use((db) => db.select().from(MessageTable).where(eq(MessageTable.id, input.id)).get())
    if (!row) return false
    thawMessageRows([row])
    return row.cold_ref !== null
  }
  const row = Database.use((db) => db.select().from(PartTable).where(eq(PartTable.id, input.id)).get())
  if (!row) return false
  thawPartRows([row])
  return row.cold_ref !== null
}

function eligibleOwnerCount(db: TxOrDb, now: number, olderThanMs: number) {
  const states = new Map<SessionID, ReturnType<typeof eligibility>>()
  const legacyCache = new Map<string, Envelope>()
  const state = (sessionID: SessionID) => {
    if (!states.has(sessionID)) states.set(sessionID, eligibility(db, sessionID, now, olderThanMs))
    return states.get(sessionID)
  }
  const messageCondition = or(messageCandidate(), isNotNull(MessageTable.cold_ref))
  const partCondition = or(partCandidate(), isNotNull(PartTable.cold_ref))
  if (!messageCondition || !partCondition) return 0
  // 候选投影收窄到 extraction/eligibility 消费列；谓词与边界规则保持不变。
  const messages = db
    .select({
      id: MessageTable.id,
      session_id: MessageTable.session_id,
      data: MessageTable.data,
      cold_ref: MessageTable.cold_ref,
      cold_key: MessageTable.cold_key,
    })
    .from(MessageTable)
    .where(and(isNull(MessageTable.cold_key), messageCondition))
    .all()
  const parts = db
    .select({
      id: PartTable.id,
      message_id: PartTable.message_id,
      session_id: PartTable.session_id,
      data: PartTable.data,
      cold_ref: PartTable.cold_ref,
      cold_key: PartTable.cold_key,
      cold_stats: PartTable.cold_stats,
    })
    .from(PartTable)
    .where(and(isNull(PartTable.cold_key), partCondition))
    .all()
  return (
    messages.filter((row) => {
      const value = messageV2Value(db, row, legacyCache)
      if (!value) return false
      return eligible(state(row.session_id), row.id)
    }).length +
    parts.filter((row) => {
      const value = partV2Value(db, row, legacyCache)
      if (!value) return false
      return eligible(state(row.session_id), row.message_id, row.data.type === "compaction")
    }).length
  )
}

// Message SQL candidate 只做必要条件预筛，最终字段白名单与 eligibility 仍由 extraction 路径决定。
function messageCandidate() {
  // v2 不再按 owner 大小筛选；SQL 只识别有 summary.diffs 的 hot user，v1 projection 由 cold_ref 分支纳入。
  return sql`(json_extract(${MessageTable.data}, '$.role') = 'assistant' or
    (json_extract(${MessageTable.data}, '$.role') = 'user'
    and json_array_length(json_extract(${MessageTable.data}, '$.summary.diffs')) > 0))`
}

// 候选 SQL 复用字段类别和 root/child 边界，具体字段与年龄仍由 extraction/eligibility 确认。
// 不按 row bytes 预筛，确保 v2 小于 4 KiB 的 reasoning/file/tool owner 也能进入 pack；v1 projection 由 cold_ref 分支补入。
// pending/running Tool、结构 marker 和无 data URI 的 File 仍由 extraction 返回 no-fields，保持 hot。
function partCandidate() {
  return sql`(
      (
        json_extract(${PartTable.data}, '$.type') = 'tool'
        and json_extract(${PartTable.data}, '$.state.status') in ('completed', 'error')
      )
      or (
        json_extract(${PartTable.data}, '$.type') = 'reasoning'
      )
      or (
        json_extract(${PartTable.data}, '$.type') = 'text'
        and exists (select 1 from ${SessionTable}
          where ${SessionTable.id} = ${PartTable.session_id} and ${SessionTable.parent_id} is not null)
      )
      or (
        json_extract(${PartTable.data}, '$.type') = 'file'
      )
      or (
        json_extract(${PartTable.data}, '$.type') = 'compaction'
        and json_type(${PartTable.data}, '$.recent_user_messages') is not null
      )
      or (
        json_extract(${PartTable.data}, '$.type') = 'step-start'
        and (
          json_type(${PartTable.data}, '$.snapshot') is not null
          or json_type(${PartTable.data}, '$.inputChars') is not null
          or json_type(${PartTable.data}, '$.inputTokens') is not null
          or json_type(${PartTable.data}, '$.inputBreakdown') is not null
        )
      )
      or (
        json_extract(${PartTable.data}, '$.type') = 'step-finish'
        and (
          json_type(${PartTable.data}, '$.snapshot') is not null
          or json_type(${PartTable.data}, '$.inputChars') is not null
          or json_type(${PartTable.data}, '$.inputBreakdown') is not null
        )
      )
    )`
}

// isEligibleOwner 供 status/test 复用唯一 eligibility owner，避免 CLI 或测试复制 age/compact 四象限。
// 它先做 extraction 和 exact 门槛，再查询 session boundary，保持大多数非候选 row 的低成本。
// 该函数只读且不压缩；true 仅表示此刻可冻，真正 freeze 会在 immediate transaction 内再次确认。
export function isEligibleOwner(input: Owner & { now?: number; olderThanMs?: number }) {
  return Database.use((db) => {
    const now = input.now ?? Date.now()
    const olderThanMs = input.olderThanMs ?? SEVEN_DAYS_MS
    if (input.type === "message") {
      const row = db.select().from(MessageTable).where(eq(MessageTable.id, input.id)).get()
      if (!row || row.cold_key) return false
      const value = messageV2Value(db, row)
      if (!value) return false
      return eligible(eligibility(db, row.session_id, now, olderThanMs), row.id)
    }
    const row = db.select().from(PartTable).where(eq(PartTable.id, input.id)).get()
    if (!row || row.cold_key) return false
    const value = partV2Value(db, row)
    if (!value) return false
    return eligible(eligibility(db, row.session_id, now, olderThanMs), row.message_id, row.data.type === "compaction")
  })
}

// 工具 input 形状修复只针对热 Tool owner：v1/v2 冻结路径在写入前已验证 input，坏行只可能来自 hot row。
// 谓词与 partCandidate 保持同源，避免维护命令与候选扫描对“坏 input”给出不同判定。
// 状态谓词限定 completed/error：这是 partCandidate 中唯一可冻结的 tool 状态，
// 修复范围严格覆盖 corruption 检测实际能看到的历史行。
// 可解析的 JSON 字符串恢复为 object，其余非 object 值统一置空——原始值本身违反 ToolState
// 契约，无法重建为合法 Tool input，且对应调用从未成功执行。
function repairToolInputShape(db: TxOrDb) {
  const rows = db
    .select({ id: PartTable.id, data: PartTable.data, time_updated: PartTable.time_updated })
    .from(PartTable)
    .where(
      and(
        sql`json_extract(${PartTable.data}, '$.type') = 'tool'`,
        sql`json_extract(${PartTable.data}, '$.state.status') in ('completed', 'error')`,
        sql`json_type(${PartTable.data}, '$.state.input') <> 'object'`,
      ),
    )
    .all()
  let fixed = 0
  for (const row of rows) {
    // SQL 谓词已保证 tool + completed/error；此分支只收窄 union 类型，不复制第二套判定。
    if (row.data.type !== "tool" || (row.data.state.status !== "completed" && row.data.state.status !== "error"))
      continue
    const normalized = typeof row.data.state.input === "string" ? parseToolInputObject(row.data.state.input) : {}
    db.update(PartTable)
      .set({ data: { ...row.data, state: { ...row.data.state, input: normalized } }, time_updated: row.time_updated })
      .where(eq(PartTable.id, row.id))
      .run()
    fixed++
  }
  return fixed
}

// 修复函数专用的容错解析：解析失败或结果不是 object 都回退空对象，绝不把非对象值写回。
function parseToolInputObject(input: string): Record<string, unknown> {
  try {
    const value = JSON.parse(input)
    return isRecord(value) ? value : {}
  } catch {
    return {}
  }
}

// verifyWith 把 owner 引用一次性 GROUP BY 反算，并逐 payload 校验 codec、size、hash 与 canonical envelope。
// repair 只修正可证明的 ref_count，不伪造 missing/corrupt payload，也不清除任何 owner cold_ref。
// repairToolInput 独立修复热 Tool 行的 input 形状，二者在同一事务内执行。
// report 同时记录 checked owner/payload，使空库成功与未执行扫描在用户输出中可区分。
// 所有 repair 写入位于 immediate transaction；只读 verify 不获取 maintenance lease 或改变数据库。
function verifyWith(db: TxOrDb, input: { repair: boolean; repairToolInput: boolean }): VerifyReport {
  // toolInputFixed 先于 payload 校验统计，修复后的行不会影响后续 integrity 判定。
  const toolInputFixed = input.repairToolInput ? repairToolInputShape(db) : 0
  // verify 同时扫描 ref/key/stats，key-only、stats-only 与半 summary cache 都计入 corruptOwners。
  // repair 仅纠正可证明的 ref_count；坏 key/frame/stats 和 orphan 仍由各自显式操作处理。
  const payloads = db.select().from(ColdStorageTable).all()
  // hot `(NULL,NULL)` owner 不参与 integrity 关系；SQL 只带回有任一 maintenance pointer 的 row，仍覆盖 key-only/cursor-only 损坏态。
  const messages = db
    .select({ ref: MessageTable.cold_ref, key: MessageTable.cold_key })
    .from(MessageTable)
    .where(or(isNotNull(MessageTable.cold_ref), isNotNull(MessageTable.cold_key)))
    .all()
  const parts = db
    .select({ ref: PartTable.cold_ref, key: PartTable.cold_key, stats: PartTable.cold_stats, data: PartTable.data })
    .from(PartTable)
    .where(or(isNotNull(PartTable.cold_ref), isNotNull(PartTable.cold_key), isNotNull(PartTable.cold_stats)))
    .all()
  const summaries = db
    .select({
      ref: SessionTable.summary_ref,
      cursor: SessionTable.summary_cursor,
      initialized: SessionTable.summary_initialized,
      dirty: SessionTable.summary_init_dirty,
      seed: SessionTable.summary_seed,
    })
    .from(SessionTable)
    .all()
  const counts = ownerCounts(
    db,
    payloads.map((row) => row.hash),
  )
  // ownerCounts 来自三类真实引用，stored ref_count 只用于比较而不能给自身背书。
  // 同一 owner projection 同时服务缺失 payload、checkedOwners 与 key 验证，避免第二次全索引扫描和十万级对象分配。
  const refs = [
    ...messages.flatMap((row) => (row.ref ? [{ hash: row.ref }] : [])),
    ...parts.flatMap((row) => (row.ref ? [{ hash: row.ref }] : [])),
    ...summaries.flatMap((row) => (row.ref ? [{ hash: row.ref }] : [])),
  ]
  const hashes = new Set(payloads.map((row) => row.hash))
  const byHash = new Map(payloads.map((row) => [row.hash, row]))
  // missing 与 corrupt 分开计数，用户才能判断 refcount repair 是否具有充分证据。
  const missingPayloads = refs.filter((row) => row.hash !== null && !hashes.has(row.hash)).length
  let refCountMismatches = 0
  let corruptPayloads = 0
  let corruptOwners = 0
  let repaired = 0
  // 共享 pack 的 owners 复用单次 decode 结果，避免 verify 退化为 O(refs*zstd)。
  const packEntries = new Map<string, Map<string, Record<string, Json>>>()

  // payload integrity 每个 hash 只验证一次；owner 校验随后复用 entry-key 集合，不能为共享 pack 的每个引用重复解压。
  // 损坏 frame 只计一个 corruptPayload，引用它的 owner 不再重复分类，保持 report 与旧语义一致。
  for (const payload of payloads) {
    const actual = counts.get(payload.hash) ?? 0
    if (payload.ref_count !== actual) {
      refCountMismatches++
      if (input.repair) {
        db.update(ColdStorageTable)
          .set({ ref_count: actual, time_updated: Date.now() })
          .where(eq(ColdStorageTable.hash, payload.hash))
          .run()
        repaired++
      }
    }
    try {
      // canonical、hash、size、codec 和 kind 共同构成 payload integrity，任一不符都算损坏。
      if (payload.kind === "session-summary") decodeSummary(db, payload.hash)
      else if (payload.kind === "message" || payload.kind === "part") decode(db, payload.hash, payload.kind)
      else if (payload.kind === "message-pack") {
        packEntries.set(payload.hash, decodePack(db, payload.hash, "message"))
      } else if (payload.kind === "part-pack") {
        packEntries.set(payload.hash, decodePack(db, payload.hash, "part"))
      } else throw new CorruptionError({ message: "Unsupported cold payload kind", hash: payload.hash })
    } catch {
      corruptPayloads++
    }
  }

  const validateOwner = (owner: OwnerKind, ref: string | null, key: Buffer | null) => {
    if (!ref) {
      if (key) corruptOwners++
      return
    }
    const payload = byHash.get(ref)
    if (!payload) return
    if (!key) {
      if (payload.kind !== owner) corruptOwners++
      return
    }
    // 已发布 hex 包使用完整 key，新 base64url 包使用 slot；长度与包格式共同约束 owner。
    if (key.byteLength !== (ref.length === 43 ? 4 : 32) || payload.kind !== packKind(owner)) {
      corruptOwners++
      return
    }
    const entries = packEntries.get(ref)
    // payload corruption is reported separately；只有成功验证的 frame 才继续判断 owner entry 是否缺失。
    if (entries && !entries.has(key.toString("hex"))) corruptOwners++
  }
  for (const owner of messages) validateOwner("message", owner.ref, owner.key)
  for (const owner of parts) {
    validateOwner("part", owner.ref, owner.key)
    try {
      if (!owner.ref || !owner.key) {
        // hot 与 v1 rows 从未由 v2 writer 生成同行投影；非空值只能来自不完整迁移或外部破坏。
        if (owner.stats !== null)
          throw new CorruptionError({
            message: "Non-v2 Part has a cold Stats projection",
            hash: owner.ref ?? undefined,
          })
        continue
      }
      const entries = packEntries.get(owner.ref)
      const fields = entries?.get(owner.key.toString("hex"))
      if (fields) {
        // v2 Part 从已解码字段恢复，再经唯一 projector 比较 cold_stats。
        const expected = projectPartStats(restorePackedPart(owner.data, fields, owner.ref))
        requirePartStats({ cold_ref: owner.ref, cold_stats: owner.stats }, expected)
        continue
      }
      // frame 已单独标为损坏时仍校验 projection 自身；不为验证统计投影启动另一条 payload decoder。
      if (owner.data.type === "tool" || owner.data.type === "step-finish") {
        if (owner.stats === null || parsePartStats(owner.stats, owner.ref).type !== owner.data.type) {
          throw new CorruptionError({ message: "Part cold Stats projection does not match its owner", hash: owner.ref })
        }
      } else if (owner.stats !== null) {
        throw new CorruptionError({ message: "Non-Stats Part has a cold Stats projection", hash: owner.ref })
      }
    } catch {
      corruptOwners++
    }
  }
  // summary 的 ref/cursor 必须成对且指向 summary kind，repair 不猜测缺失的一半。
  for (const owner of summaries) {
    const seed = owner.seed === null || isSummarySeed(owner.seed)
    const pending =
      !owner.initialized && owner.ref === null && owner.seed === null && (owner.cursor !== null || !owner.dirty)
    const initialized =
      owner.initialized &&
      !owner.dirty &&
      (owner.ref === null) === (owner.cursor === null) &&
      (!owner.ref || owner.seed === null) &&
      seed
    const cursor = owner.cursor === null || isSummaryCursor(owner.cursor)
    const kind = !owner.ref || byHash.get(owner.ref)?.kind === "session-summary"
    // 一个 Session 最多计一次 owner corruption，避免 ref/state 同坏时夸大诊断数量。
    if ((!pending && !initialized) || !cursor || !kind) corruptOwners++
  }
  // 无引用 payload 不在 verify 中删除；cleanup 才拥有独立的显式删除授权。
  return {
    checkedOwners: refs.length,
    checkedPayloads: payloads.length,
    corruptOwners,
    refCountMismatches,
    missingPayloads,
    corruptPayloads,
    repaired,
    toolInputFixed,
  }
}

// verify 的 repair/repairToolInput flag 决定事务写权限，调用层不能用“verify 后另行 update”复制修复 SQL。
// 两类修复共享同一 immediate 事务边界：避免崩溃点在半修复状态留下不一致组合。
// corruption 计入 report 而非在首个坏 blob 终止，便于用户一次看到完整损坏范围。
// normal delete/fork/thaw 仍 hard-fail；宽容扫描只属于显式维护诊断命令。
export function verify(input: { repair: boolean; repairToolInput?: boolean }) {
  if (!input.repair && !input.repairToolInput) {
    return Database.use((db) => verifyWith(db, { repair: false, repairToolInput: false }))
  }
  return Database.transaction(
    (db) => verifyWith(db, { repair: input.repair, repairToolInput: input.repairToolInput === true }),
    { behavior: "immediate" },
  )
}

// expand 必须有明确 session scope 或 all=true，防止缺省命令意外把整个历史数据库全量回热。
// 同步 helper 服务内部精确操作；可恢复 CLI/daemon 大任务通过 maintain 的批次 cursor 路径。
// Message 与 Part 都在同一事务范围恢复，任一 payload corruption 会阻止本次同步 expand 部分成功。
export function expand(input: { sessionID?: SessionID; all: boolean }) {
  if (!input.all && !input.sessionID) {
    throw new ValidationError({ message: "Expand requires an explicit session or all=true" })
  }
  return Database.transaction(
    (db) => {
      const messages = db
        .select()
        .from(MessageTable)
        .where(
          input.sessionID
            ? and(eq(MessageTable.session_id, input.sessionID), isNotNull(MessageTable.cold_ref))
            : isNotNull(MessageTable.cold_ref),
        )
        .all()
      const parts = db
        .select()
        .from(PartTable)
        .where(
          input.sessionID
            ? and(eq(PartTable.session_id, input.sessionID), isNotNull(PartTable.cold_ref))
            : isNotNull(PartTable.cold_ref),
        )
        .all()
      thawMessageRows(messages)
      thawPartRows(parts)
      const summaries = db
        .select({ id: SessionTable.id, ref: SessionTable.summary_ref })
        .from(SessionTable)
        .where(
          input.sessionID
            ? and(eq(SessionTable.id, input.sessionID), isNotNull(SessionTable.summary_ref))
            : isNotNull(SessionTable.summary_ref),
        )
        .all()
      // Session aggregate 是可重建 derived owner；业务 Message/Part 全部热化后再清 ref，
      // downgrade 路径最终可证明零 cold owner，后续 diff read 会从 primary Tool rows 重建。
      for (const summary of summaries) {
        if (!summary.ref) continue
        expandSummaryReference(db, summary.id, summary.ref)
      }
      return { expanded: messages.length + parts.length + summaries.length }
    },
    { behavior: "immediate" },
  )
}

// cleanup 候选来自真实 owner 反算为零，而不是信任可能损坏的 ref_count=0 索引值。
// delete 前逐候选再次 ownerCount，覆盖 preview 与写事务之间潜在的新引用，避免误删刚被 fork 采用的 blob。
// cleanup 不调用 verify repair 或 VACUUM；三种维护操作的责任和用户确认边界保持独立。
function cleanupWith(db: TxOrDb, remove: boolean): CleanupReport {
  const payloads = db.select().from(ColdStorageTable).all()
  const counts = ownerCounts(
    db,
    payloads.map((row) => row.hash),
  )
  const candidates = payloads.filter((row) => (counts.get(row.hash) ?? 0) === 0)
  if (remove) {
    for (const row of candidates) {
      // 删除前再次反算 owner；维护预览和真正删除之间的新引用不能被误删。
      if (ownerCount(db, row.hash) !== 0) continue
      db.delete(ColdStorageTable).where(eq(ColdStorageTable.hash, row.hash)).run()
    }
  }
  return {
    candidates: candidates.length,
    candidateBytes: candidates.reduce((total, row) => total + row.compressed_bytes, 0),
    deleted: remove ? candidates.length : 0,
    deletedBytes: remove ? candidates.reduce((total, row) => total + row.compressed_bytes, 0) : 0,
  }
}

// cleanup(false) 是纯报告；cleanup(true) 才获取 immediate write transaction 并返回实际删除 bytes。
// 删除 payload 不隐式回收 SQLite 文件页面，用户必须显式执行带确认的 vacuum。
export function cleanup(input: { delete: boolean }) {
  if (!input.delete) return Database.use((db) => cleanupWith(db, false))
  return Database.transaction((db) => cleanupWith(db, true), { behavior: "immediate" })
}

// pageCount 只读取 SQLite pragma 并验证返回形状，vacuum report 不依赖 driver 的 unchecked row cast。
// 该指标表示物理 page 数，不冒充 payload logical bytes；两种收益在 CLI 输出中保持独立。
function pageCount() {
  const row: unknown = Database.Client().$client.query("PRAGMA page_count").get()
  return isRecord(row) && typeof row.page_count === "number" ? row.page_count : 0
}

// 去重索引只保存位置，提交阶段仍检查目标包的真实生命周期。
export type EntryLocation = { hash: string; key: Buffer }

// 提交复核锚点：pack/行集合在读时快照，并发写窗口内被改动即整源跳过。
type RepackSource =
  // 不搬 owner 的帧只需保存来源及引用数量，用于提交校验和任务计数。
  | { kind: "recode"; hash: string; storageKind: StorageKind; references: number; pack: PackWire }
  | {
      kind: "pack"
      hash: string
      owner: OwnerKind
      scope?: SessionID
      pack: PackWire
      // 热行留在主线程，提交时核对读取窗口内是否发生了替换或删除。
      messages: (typeof MessageTable.$inferSelect)[]
      parts: (typeof PartTable.$inferSelect)[]
      wire: PackWireRow[]
    }

function repackCandidates(request: { sessionID?: SessionID; recompress?: boolean }, lastHash: string) {
  // 字段谓词同时决定枚举与后续操作：干净帧重压缩只需包字节和引用元数据。
  const pending = sql`(
    exists (select 1 from ${MessageTable} where ${MessageTable.cold_ref} = ${ColdStorageTable.hash}
      and (json_extract(${MessageTable.data}, '$.path') is not null
        or json_extract(${MessageTable.data}, '$.inputChars') is not null
        or json_extract(${MessageTable.data}, '$.inputTokens') is not null
        or json_extract(${MessageTable.data}, '$.inputBreakdown') is not null))
    or exists (select 1 from ${PartTable} where ${PartTable.cold_ref} = ${ColdStorageTable.hash}
      and json_extract(${PartTable.data}, '$.text') != ''))`
  const repack = and(
    inArray(ColdStorageTable.kind, ["message-pack", "part-pack"]),
    or(sql`length(${ColdStorageTable.hash}) = 64`, pending),
  )
  return Database.use((db) =>
    db
      .select({
        hash: ColdStorageTable.hash,
        bytes: ColdStorageTable.raw_bytes,
        // 与 WHERE 共用字段谓词，选出源以后无需再次猜测本轮操作模式。
        repack: sql<boolean>`${repack}`.mapWith(Boolean),
      })
      .from(ColdStorageTable)
      .where(
        and(
          gt(ColdStorageTable.hash, lastHash),
          request.recompress ? undefined : or(sql`length(${ColdStorageTable.hash}) = 64`, repack),
          // scope 约束真实引用者，包的创建者不能代替共享 owner 的所属 Session。
          request.sessionID
            ? sql`(
      exists (select 1 from ${MessageTable} where ${MessageTable.cold_ref} = ${ColdStorageTable.hash} and ${MessageTable.session_id} = ${request.sessionID}) or
      exists (select 1 from ${PartTable} where ${PartTable.cold_ref} = ${ColdStorageTable.hash} and ${PartTable.session_id} = ${request.sessionID}) or
      exists (select 1 from ${SessionTable} where ${SessionTable.summary_ref} = ${ColdStorageTable.hash} and ${SessionTable.id} = ${request.sessionID}))`
            : undefined,
        ),
      )
      .orderBy(ColdStorageTable.hash)
      .all(),
  )
}

function readRepackSources(
  candidates: ReturnType<typeof repackCandidates>,
  request: { sessionID?: SessionID; olderThanMs: number; recompress?: boolean },
) {
  return Database.transaction(
    (db) => {
      const now = Date.now()
      const admission = batchEligibility(db, now, request.olderThanMs)
      // 反算与读源共用快照，批量查询避免每个包重复访问三张owner表。
      const counts = ownerCounts(
        db,
        candidates.filter((candidate) => candidate.repack).map((candidate) => candidate.hash),
      )
      const childCache = new Map<string, boolean>()
      const childOf = (sessionID: SessionID) => {
        const cached = childCache.get(sessionID)
        // false是已知的root分类，也必须命中缓存。
        if (cached !== undefined) return cached
        const child = !!db
          .select({ parent: SessionTable.parent_id })
          .from(SessionTable)
          .where(eq(SessionTable.id, sessionID))
          .get()?.parent
        childCache.set(sessionID, child)
        return child
      }
      const sources: RepackSource[] = []
      for (const candidate of candidates) {
        const hash = candidate.hash
        const payload = db.select().from(ColdStorageTable).where(eq(ColdStorageTable.hash, hash)).get()
        // 批次之间允许用户删除最后一个 owner；已释放的输入包不再需要搬运。
        if (!payload) continue
        if (payload.codec !== "zstd") throw new CorruptionError({ message: "Invalid cold codec", hash })
        const pack: PackWire = {
          payload: payload.payload,
          raw_bytes: payload.raw_bytes,
          compressed_bytes: payload.compressed_bytes,
        }
        if (!candidate.repack) {
          // 帧已包含全部待编码字节，无需搬运 Message/Part 的热投影。
          sources.push({ kind: "recode", hash, storageKind: payload.kind, references: payload.ref_count, pack })
          continue
        }
        if (payload.kind !== "message-pack" && payload.kind !== "part-pack") continue
        const owner: OwnerKind = payload.kind === "message-pack" ? "message" : "part"
        // 读取期不一致按 corruption 抛错；并发窗口造成的不一致由提交复核按跳过处理。
        if (payload.ref_count !== (counts.get(hash) ?? 0))
          throw new CorruptionError({ message: "Repack reference count mismatch", hash })
        const messages =
          owner === "message"
            ? db
                .select()
                .from(MessageTable)
                .where(
                  and(
                    eq(MessageTable.cold_ref, hash),
                    request.sessionID ? eq(MessageTable.session_id, request.sessionID) : undefined,
                  ),
                )
                .all()
            : []
        const parts =
          owner === "part"
            ? db
                .select()
                .from(PartTable)
                .where(
                  and(
                    eq(PartTable.cold_ref, hash),
                    request.sessionID ? eq(PartTable.session_id, request.sessionID) : undefined,
                  ),
                )
                .all()
            : []
        const wire: PackWireRow[] = [
          ...messages.map((row): PackWireRow => {
            // 热行仍携带深层字段 ⟺ 包内 entry 未 merge（merge 时热行被替换为缩减投影）。
            const merge =
              row.data.role === "assistant" &&
              (row.data.path !== undefined ||
                row.data.inputChars !== undefined ||
                row.data.inputTokens !== undefined ||
                row.data.inputBreakdown !== undefined) &&
              eligible(admission(row.session_id), row.id)
            // 只有 merge 行需要业务正文；进位行的投影原样保留在主线程，不占线传输。
            return {
              id: row.id,
              // locator 是包内位置，跨包去重身份由 worker 解码后计算。
              coldKey: row.cold_key?.toString("hex") ?? null,
              merge,
              ...(merge ? { data: row.data } : {}),
            }
          }),
          ...parts.map((row): PackWireRow => {
            const data = row.data
            const merge =
              data.type === "text" && data.text !== "" && eligible(admission(row.session_id), row.message_id)
            // tool/step-finish 的统计核实需要完整对象；其他类型与进位行不传 data。
            const needsStats = data.type === "tool" || data.type === "step-finish"
            return {
              id: row.id,
              coldKey: row.cold_key?.toString("hex") ?? null,
              merge,
              coldStats: row.cold_stats,
              ...(merge ? { child: childOf(row.session_id) } : {}),
              ...(merge || needsStats ? { data } : {}),
            }
          }),
        ]
        // v3 包本轮无可 merge 行时不搬动：枚举谓词只保证存在候选行，资格口径在这里精确化。
        // legacy（64 hex）包无条件处理，level 升级路径不因资格跳过。
        if (hash.length !== 64 && !wire.some((row) => row.merge)) {
          if (request.recompress)
            sources.push({ kind: "recode", hash, storageKind: payload.kind, references: payload.ref_count, pack })
          continue
        }
        sources.push({
          kind: "pack",
          hash,
          owner,
          pack,
          messages,
          parts,
          wire,
          // 读与提交保持同一范围，范围外共享者不会被误判为新增 owner。
          ...(request.sessionID ? { scope: request.sessionID } : {}),
        })
      }
      return { sources, now }
    },
    { behavior: "deferred" },
  )
}

// 并发窗口内同一内容地址可能已被另一 writer 插入；存在时复用并复核 canonical 字节（与 retainPackPayload 同一碰撞语义）。
// 新 payload 先以零引用落表，只有 owner assignment 路径可增加真实生命周期计数。
function insertPackedBytes(
  db: TxOrDb,
  owner: OwnerKind,
  pack: { hash: string; raw: Uint8Array; keys: Map<string, Buffer>; payload?: Uint8Array },
  now: number,
) {
  const existing = db.select().from(ColdStorageTable).where(eq(ColdStorageTable.hash, pack.hash)).get()
  if (existing) {
    // 同地址复用仍核实元数据及字节，保持与同步冻结相同的冲突合同。
    if (
      existing.kind !== packKind(owner) ||
      existing.codec !== "zstd" ||
      existing.raw_bytes !== pack.raw.byteLength ||
      existing.compressed_bytes !== existing.payload.byteLength ||
      existing.ref_count !== ownerCount(db, pack.hash)
    ) {
      throw new CorruptionError({ message: "Existing cold pack metadata is inconsistent", hash: pack.hash })
    }
    verifyExistingPackBytes(db, owner, pack.hash, pack.raw)
    // 报告实际保留的帧大小，而不是本次未采用的编码结果大小。
    return {
      hash: pack.hash,
      keys: pack.keys,
      rawBytes: pack.raw.byteLength,
      compressedBytes: existing.compressed_bytes,
    }
  }
  // 单项调用在确认新内容后编码；并行任务提供已计算的帧，二者共享同一写入路径。
  const payload = pack.payload ?? compress(pack.raw)
  db.insert(ColdStorageTable)
    .values({
      hash: pack.hash,
      kind: packKind(owner),
      codec: "zstd",
      // blob 列按 Buffer 写入，与 retainPackPayload 的在线路径保持同一存储形态。
      payload: Buffer.from(payload),
      raw_bytes: pack.raw.byteLength,
      compressed_bytes: payload.byteLength,
      ref_count: 0,
      time_created: now,
      time_updated: now,
    })
    .run()
  return { hash: pack.hash, keys: pack.keys, rawBytes: pack.raw.byteLength, compressedBytes: payload.byteLength }
}

// 缺少 projection 表示仅切换存储位置，不能把它写成 data=NULL。
type RepointRow = { id: string; key: Uint8Array; projection?: unknown }

// 两种语句在当前事务内复用，避免巨大 CASE 对每行重复匹配全部 owner ID。
// carry 不写 data，merge 才替换投影；混合批次不会给未命中的正文赋 NULL。
function repointPack(owner: OwnerKind, rows: RepointRow[], hash: string) {
  // Database.transaction 的 Drizzle 事务与 $client 共用连接，复用原生语句省去逐行参数映射。
  // 表名来自封闭 OwnerKind，值仍全参数化；省略 time_updated 保持业务 chronology。
  const client = Database.Client().$client
  const carry = client.query(`UPDATE ${owner} SET cold_ref=?, cold_key=? WHERE id=? RETURNING id`)
  const merge = client.query(`UPDATE ${owner} SET cold_ref=?, cold_key=?, data=? WHERE id=? RETURNING id`)
  for (const row of rows) {
    const updated =
      row.projection === undefined
        ? carry.get(hash, row.key, row.id)
        : merge.get(hash, row.key, JSON.stringify(row.projection), row.id)
    // 同一事务中的缺行是完整性错误，整批回滚而不是报告部分成功。
    if (!updated) throw new CorruptionError({ message: "Cold pack repoint is incomplete", hash })
  }
}

// 正常replacement会清除冷引用，因此这里比较同一冷态的owner集合及定位。
function sameRowStamp(
  current: Array<{ id: string; cold_key: Uint8Array | null; time_updated: number }>,
  rows: ReadonlyArray<{ id: string; cold_key: Uint8Array | null; time_updated: number }>,
) {
  if (current.length !== rows.length) return false
  // 引用索引的返回次序可能变化，集合比较使用稳定的 owner ID。
  const before = new Map(
    rows.map(
      (row) =>
        [
          row.id as string,
          `${row.time_updated}:${row.cold_key ? Buffer.from(row.cold_key).toString("hex") : ""}`,
        ] as const,
    ),
  )
  return current.every(
    (row) =>
      before.get(row.id) === `${row.time_updated}:${row.cold_key ? Buffer.from(row.cold_key).toString("hex") : ""}`,
  )
}

export type PreparedRepack = {
  sources: RepackSource[]
  // 与 sources 按位置对应，Promise.all 的结果顺序独立于线程完成顺序。
  scans: unknown[]
  // 位置包含旧目标和本批新目标，真正写入时还要核对它们是否存活。
  location: Map<string, EntryLocation>
  freshPacks: Array<{ owner: OwnerKind; pack: PackedChunk }>
  // cursor 语义所需的批次末 hash：提交顺序必须与 packs 顺序一致。
  lastHash: string
  // 包元数据在批内使用同一时间，业务owner的时间由引用切换操作另行保留。
  now: number
}

// 提交单独成函数：流水线中上一个批次的提交与下一个批次的 worker 阶段重叠。
function commitPreparedRepackBatch(prepared: PreparedRepack, known: Map<string, EntryLocation>) {
  return Database.transaction(
    (db) =>
      commitRepackBatch(
        db,
        prepared.sources,
        prepared.scans,
        prepared.location,
        prepared.freshPacks,
        known,
        prepared.now,
      ),
    { behavior: "immediate" },
  )
}

function commitRepackBatch(
  db: TxOrDb,
  sources: RepackSource[],
  scans: unknown[],
  location: Map<string, EntryLocation>,
  freshPacks: Array<{ owner: OwnerKind; pack: PackedChunk }>,
  known: Map<string, EntryLocation>,
  now: number,
) {
  // 复核与读取使用同一 session scope；共享包的范围外 owner 不属于并发漂移。
  // 实际变动的源保留旧引用，本轮计为 skipped；复核自身也有查询成本。
  const live = new Map<string, { references: number; bytes: number }>()
  // 在任何owner赋值之前反算整批引用，所有源使用相同的事务起点。
  const counts = ownerCounts(
    db,
    sources.map((source) => source.hash),
  )
  let rawBytes = 0
  for (const source of sources) {
    const payload = db
      .select({ ref_count: ColdStorageTable.ref_count, compressed_bytes: ColdStorageTable.compressed_bytes })
      .from(ColdStorageTable)
      .where(eq(ColdStorageTable.hash, source.hash))
      .get()
    if (!payload || payload.ref_count !== (counts.get(source.hash) ?? 0)) continue
    if (source.kind === "pack") {
      const current =
        source.owner === "message"
          ? db
              .select({ id: MessageTable.id, cold_key: MessageTable.cold_key, time_updated: MessageTable.time_updated })
              .from(MessageTable)
              .where(
                and(
                  eq(MessageTable.cold_ref, source.hash),
                  source.scope ? eq(MessageTable.session_id, source.scope) : undefined,
                ),
              )
              .all()
          : db
              .select({ id: PartTable.id, cold_key: PartTable.cold_key, time_updated: PartTable.time_updated })
              .from(PartTable)
              .where(
                and(
                  eq(PartTable.cold_ref, source.hash),
                  source.scope ? eq(PartTable.session_id, source.scope) : undefined,
                ),
              )
              .all()
      const rows: ReadonlyArray<{ id: string; cold_key: Uint8Array | null; time_updated: number }> =
        source.owner === "message" ? source.messages : source.parts
      if (!sameRowStamp(current, rows)) continue
    }
    // 原位重编码按当前引用数计量，读取窗口内新建的 fork 仍共享同一帧。
    live.set(source.hash, { references: payload.ref_count, bytes: payload.compressed_bytes })
    rawBytes += source.pack.raw_bytes
  }
  let compressedBytes = 0
  let processedCount = 0
  // 帧重压缩保留 raw、地址、引用和时间，只提交更小的标准 zstd 帧。
  sources.forEach((source, index) => {
    if (source.kind !== "recode") return
    const current = live.get(source.hash)
    if (!current) return
    const payload = scans[index] as Uint8Array
    // 收益比较与更新共用写事务的现存帧大小，而非读取阶段的旧估计。
    if (payload.byteLength >= current.bytes) {
      // 已有帧更紧凑时保留它，检查完成仍计入工作量。
      compressedBytes += current.bytes
      return
    }
    db.update(ColdStorageTable)
      // 显式保留时间字段，避免 Drizzle 的 onUpdate 将纯编码变化标成内容更新。
      .set({
        payload: Buffer.from(payload),
        compressed_bytes: payload.byteLength,
        time_updated: ColdStorageTable.time_updated,
      })
      .where(eq(ColdStorageTable.hash, source.hash))
      .run()
    compressedBytes += payload.byteLength
    processedCount += current.references
  })
  // 先规划真实存活的引用，再插入目标包；失效源不得留下零引用的新压缩副本。
  const inserted = new Map<string, { owner: OwnerKind; keys: Map<string, Buffer> }>()
  const fresh = new Set(freshPacks.map(({ pack }) => pack.hash))
  // 按解析后的目标位置分组；retain→assign→release 顺序与串行时代一致，引用环按计数结算。
  type RepointGroup = { owner: OwnerKind; moved: number; messages: RepointRow[]; parts: RepointRow[] }
  const groups = new Map<string, RepointGroup>()
  const released: string[] = []
  const verifiedTargets = new Set<string>()
  sources.forEach((source, index) => {
    if (source.kind !== "pack" || !live.has(source.hash)) return
    const scan = scans[index] as PackScanResult
    // worker 回传逐行身份与 merge 投影，原热行来自已复核的读取快照。
    const keyById = new Map(scan.rows.map((row) => [row.id, row.key]))
    const mergeById = new Map(scan.merges.map((item) => [item.id, item.projection]))
    const rows = source.owner === "message" ? source.messages : source.parts
    for (const row of rows) {
      const key = keyById.get(row.id)
      if (!key) throw new CorruptionError({ message: "Pack worker result is missing an owner row", hash: source.hash })
      const target = location.get(`${source.owner}:${key}`)
      if (!target) throw new CorruptionError({ message: "Repack entry has no destination", hash: source.hash })
      // 已知目标可能在并发窗口内被释放；fresh 目标由本批插入必然存在。目标消失的行保持旧引用，下轮再搬。
      if (!fresh.has(target.hash) && !verifiedTargets.has(target.hash)) {
        if (
          !db
            .select({ hash: ColdStorageTable.hash })
            .from(ColdStorageTable)
            .where(eq(ColdStorageTable.hash, target.hash))
            .get()
        )
          continue
        // immediate 事务内目标存活性稳定，同一目标只需核实一次。
        verifiedTargets.add(target.hash)
      }
      const group = groups.get(target.hash) ?? { owner: source.owner, moved: 0, messages: [], parts: [] }
      const projection = mergeById.get(row.id)
      // 即使目的地址相同，merge仍可能需要缩减热投影；引用增减另行计算。
      if (source.owner === "message") {
        group.messages.push({ id: row.id, key: target.key, ...(projection === undefined ? {} : { projection }) })
      } else {
        group.parts.push({ id: row.id, key: target.key, ...(projection === undefined ? {} : { projection }) })
      }
      // source==target 时保持计数，防止幂等维护把仍在使用的包删除。
      if (source.hash !== target.hash) {
        group.moved++
        // 重复 hash 代表不同 owner，释放时保留其真实引用次数。
        released.push(source.hash)
      }
      groups.set(target.hash, group)
      processedCount++
    }
  })
  for (const { owner, pack } of freshPacks) {
    // 失效源不会留下无引用的新包，同内容的并行编码结果只落一份。
    if (!groups.has(pack.hash) || inserted.has(pack.hash)) continue
    const packed = insertPackedBytes(
      db,
      owner,
      {
        ...pack,
        keys: new Map(pack.slots.map(([key, slot]) => [key, Buffer.from(slot, "hex")])),
      },
      now,
    )
    inserted.set(pack.hash, { owner, keys: packed.keys })
    compressedBytes += packed.compressedBytes
  }
  for (const [hash, group] of groups) {
    if (group.moved) retainPackedReference(db, hash, group.owner, now, group.moved)
  }
  for (const [hash, group] of groups) {
    if (group.messages.length) repointPack("message", group.messages, hash)
    if (group.parts.length) repointPack("part", group.parts, hash)
  }
  // 此时所有入站引用都已落到 owner 表，旧包即使同时是目的包也会保留正确余量。
  decrementReferences(db, released, now)
  // 只有真实写入的 entry 才登记 dedup 索引；插入成功的包即使源被跳过，其内容地址依然有效。
  for (const [hash, pack] of inserted) {
    for (const [key, slot] of pack.keys) known.set(`${pack.owner}:${key}`, { hash, key: slot })
  }
  const selected = sources.reduce(
    (count, source) =>
      count +
      (source.kind === "pack"
        ? source.messages.length + source.parts.length
        : // 已删除源也算检查过，读取时数量用于报告跳过的 owner。
          (live.get(source.hash)?.references ?? source.references)),
    0,
  )
  // CLI 的 Compressed=Processed-Skipped，枚举数须包含被跳过的 owner。
  return { processed: selected, skipped: selected - processedCount, rawBytes, compressedBytes }
}

function nextMessageRows(
  db: TxOrDb,
  request: { sessionID?: SessionID },
  lastID: string,
  cold: boolean,
  batchSize: number,
) {
  const conditions: SQL[] = [cold ? isNotNull(MessageTable.cold_ref) : isNull(MessageTable.cold_key)]
  if (!cold) {
    const candidate = or(messageCandidate(), isNotNull(MessageTable.cold_ref))
    if (candidate) conditions.push(candidate)
  }
  if (lastID) conditions.push(gt(MessageTable.id, MessageID.make(lastID)))
  if (request.sessionID) conditions.push(eq(MessageTable.session_id, request.sessionID))
  return db
    .select()
    .from(MessageTable)
    .where(and(...conditions))
    .orderBy(MessageTable.id)
    .limit(batchSize)
    .all()
}

// Part cursor 与 Message 分阶段推进，task checkpoint 可以精确表示已完成 Message、正在处理 Part 的位置。
// ORDER BY primary ID 保证跨进程 resume 稳定；batch 之间新增更大 ID 会在后续范围自然被看到。
// cold/hot predicate 让 compress 与 expand 使用同一状态机而不共享错误的 row 投影语义。
function nextPartRows(
  db: TxOrDb,
  request: { sessionID?: SessionID },
  lastID: string,
  cold: boolean,
  batchSize: number,
) {
  const conditions: SQL[] = [cold ? isNotNull(PartTable.cold_ref) : isNull(PartTable.cold_key)]
  if (!cold) {
    const candidate = or(partCandidate(), isNotNull(PartTable.cold_ref))
    if (candidate) conditions.push(candidate)
  }
  if (lastID) conditions.push(gt(PartTable.id, PartID.make(lastID)))
  if (request.sessionID) conditions.push(eq(PartTable.session_id, request.sessionID))
  return db
    .select()
    .from(PartTable)
    .where(and(...conditions))
    .orderBy(PartTable.id)
    .limit(batchSize)
    .all()
}

function nextSummaryRows(db: TxOrDb, request: { sessionID?: SessionID }, lastID: string, batchSize: number) {
  const conditions: SQL[] = [isNotNull(SessionTable.summary_ref)]
  if (lastID) conditions.push(gt(SessionTable.id, SessionIDSchema.make(lastID)))
  if (request.sessionID) conditions.push(eq(SessionTable.id, request.sessionID))
  return db
    .select({ id: SessionTable.id, ref: SessionTable.summary_ref })
    .from(SessionTable)
    .where(and(...conditions))
    .orderBy(SessionTable.id)
    .limit(batchSize)
    .all()
}

// immediate maintenance transaction 内 Session.time_updated 不会被其他 writer 改变；每批只查询每个 Session 一次。
// 跨批重新建立 map，仍保留 session 活跃度和 compaction boundary 在 checkpoint 之间失效的语义。
function batchEligibility(db: TxOrDb, now: number, olderThanMs: number) {
  const states = new Map<SessionID, ReturnType<typeof eligibility>>()
  return (sessionID: SessionID) => {
    if (states.has(sessionID)) return states.get(sessionID)
    const state = eligibility(db, sessionID, now, olderThanMs)
    states.set(sessionID, state)
    return state
  }
}

// 展开枚举与回填共用写事务，流程只接收已提交的游标与计数。
function expandOwnerBatch(
  request: { sessionID?: SessionID; batchSize: number },
  cursor: { owner: "message" | "part" | "session-summary"; lastID: string },
) {
  return Database.transaction(
    (db) => {
      if (cursor.owner === "message") {
        const rows = nextMessageRows(db, request, cursor.lastID, true, request.batchSize)
        if (!rows.length) return { empty: true as const }
        thawMessageRows(rows)
        return {
          empty: false as const,
          cursor: { owner: "message" as const, lastID: rows[rows.length - 1].id },
          processed: rows.length,
          skipped: 0,
          rawBytes: 0,
          compressedBytes: 0,
        }
      }
      if (cursor.owner === "part") {
        const rows = nextPartRows(db, request, cursor.lastID, true, request.batchSize)
        if (!rows.length) return { empty: true as const }
        thawPartRows(rows)
        return {
          empty: false as const,
          cursor: { owner: "part" as const, lastID: rows[rows.length - 1].id },
          processed: rows.length,
          skipped: 0,
          rawBytes: 0,
          compressedBytes: 0,
        }
      }
      const rows = nextSummaryRows(db, request, cursor.lastID, request.batchSize)
      if (!rows.length) return { empty: true as const }
      for (const row of rows) if (row.ref) expandSummaryReference(db, row.id, row.ref)
      return {
        empty: false as const,
        cursor: { owner: "session-summary" as const, lastID: rows[rows.length - 1].id },
        processed: rows.length,
        skipped: 0,
        rawBytes: 0,
        compressedBytes: 0,
      }
    },
    { behavior: "immediate" },
  )
}

function countOwnerCandidates(
  request: { operation: "compress" | "expand"; sessionID?: SessionID },
  cursor: { owner: "message" | "part" | "session-summary"; lastID: string },
) {
  return Database.use((db) => {
    const count = (table: typeof MessageTable | typeof PartTable) => {
      // 恢复到Part或摘要阶段时，已完成的Message范围不再进入分母。
      if (cursor.owner === "session-summary" || (table === MessageTable && cursor.owner !== "message")) return 0
      // 展开覆盖全部冷引用，沿用冻结白名单会漏掉已存在的历史表示。
      const conditions =
        request.operation === "expand"
          ? [isNotNull(table.cold_ref)]
          : [
              isNull(table.cold_key),
              or(table === MessageTable ? messageCandidate() : partCandidate(), isNotNull(table.cold_ref)),
            ]
      if (request.sessionID) conditions.push(eq(table.session_id, request.sessionID))
      // 总量与剩余游标对齐，恢复任务沿用已提交边界。
      if (cursor.lastID && cursor.owner === (table === MessageTable ? "message" : "part"))
        conditions.push(sql`${table.id} > ${cursor.lastID}`)
      return (
        db
          .select({ count: sql<number>`count(*)` })
          .from(table)
          .where(and(...conditions))
          .get()?.count ?? 0
      )
    }
    return count(MessageTable) + count(PartTable)
  })
}

function restoreRepackIndex(known: Map<string, EntryLocation>) {
  Database.use((db) => {
    // 目的包的hash排序与源游标无关，恢复时需扫描全部现有v3目标。
    const rows = db
      .select({ hash: ColdStorageTable.hash, kind: ColdStorageTable.kind })
      .from(ColdStorageTable)
      .where(
        and(sql`length(${ColdStorageTable.hash}) = 43`, inArray(ColdStorageTable.kind, ["message-pack", "part-pack"])),
      )
      .all()
    for (const row of rows) {
      const owner = row.kind === "message-pack" ? "message" : "part"
      const entries = decodePack(db, row.hash, owner)
      let index = 0
      // decoder 已核验 entry 摘要，恢复派生索引时复用其身份计算。
      for (const slot of entries.keys())
        known.set(`${owner}:${entries.content[index++].key.toString("hex")}`, {
          hash: row.hash,
          key: Buffer.from(slot, "hex"),
        })
    }
  })
}

function cleanupBatch(request: { delete: boolean; batchSize: number }, lastHash: string) {
  return Database.transaction(
    (db) => {
      const rows = db
        .select()
        .from(ColdStorageTable)
        .where(gt(ColdStorageTable.hash, lastHash))
        .orderBy(ColdStorageTable.hash)
        .limit(request.batchSize)
        .all()
      if (!rows.length) return { empty: true as const }
      let skipped = 0
      let bytes = 0
      for (const row of rows) {
        // 真实引用与删除共用事务，fork 增加的引用在这里参与判定。
        if (ownerCount(db, row.hash) === 0 && request.delete) {
          db.delete(ColdStorageTable).where(eq(ColdStorageTable.hash, row.hash)).run()
          bytes += row.compressed_bytes
        } else skipped++
      }
      return {
        empty: false as const,
        cursor: { stage: "payload" as const, lastHash: rows[rows.length - 1].hash },
        processed: rows.length,
        skipped,
        failed: 0,
        bytes,
      }
    },
    { behavior: "immediate" },
  )
}

function vacuum() {
  const pagesBefore = pageCount()
  Database.Client().$client.run("VACUUM")
  const checkpoint: unknown = Database.Client().$client.query("PRAGMA wal_checkpoint(TRUNCATE)").get()
  // VACUUM 的 WAL 帧完成截断后，页数才对应实际回收结果。
  if (
    !isRecord(checkpoint) ||
    typeof checkpoint.busy !== "number" ||
    checkpoint.busy !== 0 ||
    typeof checkpoint.log !== "number" ||
    checkpoint.log > 0
  )
    throw new Error(`WAL checkpoint did not truncate after vacuum: ${JSON.stringify(checkpoint)}`)
  return { pagesBefore, pagesAfter: pageCount() }
}

// 维护接口以完整存储操作为单位，流程模块只负责执行顺序和任务生命周期。
export const maintenance = {
  SEVEN_DAYS_MS,
  countOwnerCandidates,
  restoreRepackIndex,
  cleanupBatch,
  vacuum,
  prepareFreezeBatch,
  commitFreezeBatch,
  expandOwnerBatch,
  readRepackSources,
  repackCandidates,
  commitPreparedRepackBatch,
}

function pragmaNumber(name: "page_size" | "page_count" | "freelist_count") {
  const row: unknown = Database.Client().$client.query(`PRAGMA ${name}`).get()
  return isRecord(row) && typeof row[name] === "number" ? row[name] : 0
}

// 容量与共享量按元数据汇总，冻结资格复用存储规则。
export function status(): StatusReport {
  return Database.use((db) => {
    // activeBytes 与 file length 分开，freelist 页面只在显式 VACUUM 后物理消失。
    const pageSize = pragmaNumber("page_size")
    const pages = pragmaNumber("page_count")
    const freelistPages = pragmaNumber("freelist_count")
    // 容量投影只持有每包的固定大小元数据，内存随包数增长。
    const payloads = db
      .select({
        hash: ColdStorageTable.hash,
        kind: ColdStorageTable.kind,
        raw_bytes: ColdStorageTable.raw_bytes,
        compressed_bytes: ColdStorageTable.compressed_bytes,
        ref_count: ColdStorageTable.ref_count,
      })
      .from(ColdStorageTable)
      .all()
    // 真实 owner 索引提供共享量，也作为持久 ref_count 的独立核对来源。
    const counts = ownerCounts(
      db,
      payloads.map((row) => row.hash),
    )
    const coldOwners =
      (db
        .select({ value: sql<number>`count(*)` })
        .from(MessageTable)
        .where(isNotNull(MessageTable.cold_ref))
        .get()?.value ?? 0) +
      (db
        .select({ value: sql<number>`count(*)` })
        .from(PartTable)
        .where(isNotNull(PartTable.cold_ref))
        .get()?.value ?? 0)
    const summaryOwners =
      db
        .select({ value: sql<number>`count(*)` })
        .from(SessionTable)
        .where(isNotNull(SessionTable.summary_ref))
        .get()?.value ?? 0
    const summaryPayloads = payloads.filter((row) => row.kind === "session-summary")
    // distinct 定位键给出包内被引用的条目数，用于估算条目级共享倍率。
    const keyCounts = packKeyStats(
      db,
      payloads.map((row) => row.hash),
    )
    const rawBytes = payloads.reduce((total, row) => {
      const owners = counts.get(row.hash) ?? 0
      // 逻辑展开量针对有 owner 的内容；孤立帧的在库占用另计。
      if (owners === 0) return total
      if (row.kind === "message-pack" || row.kind === "part-pack") {
        const distinctKeys = keyCounts.get(row.hash) ?? 0
        // 有效定位键集合为空时，该包的引用完整性由 verify 诊断。
        if (distinctKeys <= 0) return total
        // raw_bytes 是整包大小；按 owners/keys 等分估算，各条目的实际长度可不同。
        // 保留浮点字节估计，展示层负责单位换算与舍入。
        return total + (row.raw_bytes * owners) / distinctKeys
      }
      // 摘要与 v1 envelope 的每个引用都对应整份内容。
      return total + row.raw_bytes * owners
    }, 0)
    // 帧字节总量包含待清理的孤立帧，SQLite 页开销通过 activeBytes 单列。
    const compressedBytes = payloads.reduce((total, row) => total + row.compressed_bytes, 0)
    const referencedRawBytes = payloads.reduce(
      (total, row) => total + ((counts.get(row.hash) ?? 0) > 0 ? row.raw_bytes : 0),
      0,
    )
    const refCountMismatches = payloads.filter((row) => row.ref_count !== (counts.get(row.hash) ?? 0)).length
    // 孤立帧依据真实引用判定，保留持久计数漂移时的可回收空间信息。
    const orphans = payloads.filter((row) => (counts.get(row.hash) ?? 0) === 0).length
    return {
      pageSize,
      pageCount: pages,
      freelistPages,
      activeBytes: Math.max(0, pages - freelistPages) * pageSize,
      // 报表容量参考值以十进制字节表示。
      targetBytes: 1_500_000_000,
      // 资格计数与默认维护共用 root 7d / subagent 24h 的时钟定义。
      eligibleOwners: eligibleOwnerCount(db, Date.now(), SEVEN_DAYS_MS),
      coldOwners,
      summaryOwners,
      summaryPayloads: summaryPayloads.length,
      summaryRawBytes: summaryPayloads.reduce((total, row) => total + row.raw_bytes, 0),
      summaryCompressedBytes: summaryPayloads.reduce((total, row) => total + row.compressed_bytes, 0),
      payloads: payloads.length,
      rawBytes,
      compressedBytes,
      // 共享收益是逻辑展开与唯一内容之差，物理回收另由 SQLite 页数报告。
      sharedBytes: Math.max(0, rawBytes - referencedRawBytes),
      refCountMismatches,
      orphans,
    }
  })
}

export * as ColdStore from "./cold-store"
