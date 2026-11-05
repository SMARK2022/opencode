import { Effect, Schema } from "effect"
import path from "path"
import { and, asc, desc, eq, inArray, isNull, sql, type SQL } from "drizzle-orm"
// #0500：目标分层——cold owner 在 core；TxOrDb 与 SummaryPayload 由 cold-storage 导出。
import { Database } from "@opencode-ai/core/database/database"
import { ToolDiffs } from "@opencode-ai/core/session/tool-diffs"
import { ColdStorage, type SummaryPayload, type TxOrDb } from "@opencode-ai/core/storage/cold-storage"
import { InstanceState } from "@/effect/instance-state"
import { MessageTable, PartTable, SessionTable } from "@opencode-ai/core/session/sql"
import { MessageID, SessionID } from "./schema"
import { Snapshot } from "@/snapshot"
import type { MessageV2 } from "./message-v2"
import { NotFoundError, Storage } from "@/storage/storage"
import { boundMergedPatch } from "@/tool/file-diff"

const isDiffs = Schema.is(Schema.Array(Snapshot.FileDiff))
type Diffs = Snapshot.FileDiff[]

type ToolDiffPart = {
  hidden?: unknown
  type: "tool"
  state: {
    status: "completed"
    metadata: unknown
  }
}

type ToolDiffMessage = {
  info: { id: MessageID; hidden?: unknown }
  parts: ToolDiffPart[]
}

type MessageCursor = { id: MessageID; time: number }

// #0584：持久 cursor 只存 MessageID；任何非空 cursor 在使用前必须解析回同 Session 的持久 tuple。
// 解析失败即 corruption：不允许借用附近行或忽略边界继续扫描。

function resolveMessageCursor(db: TxOrDb, sessionID: SessionID, id: string): MessageCursor {
  const row = db
    .select({ id: MessageTable.id, time: MessageTable.time_created })
    .from(MessageTable)
    .where(and(eq(MessageTable.session_id, sessionID), eq(MessageTable.id, MessageID.make(id))))
    .get()
  if (!row) throw new ColdStorage.CorruptionError({ message: `Session summary cursor is not resolvable: ${sessionID}` })
  return row
}

// #0584：开区间增量：只取严格晚于 cursor 的行，避免每次 load 重复累计同一 patch。
function afterCursor(cursor: MessageCursor) {
  // tuple 比较与持久排序一致，并让现有复合索引直接定位增量起点。
  return sql`(${MessageTable.time_created}, ${MessageTable.id}) > (${cursor.time}, ${cursor.id})`
}

// #0584：闭区间上界：同毫秒时用 SQLite BINARY 的 ID 序，不能把同时间整段都纳入。
function throughCursor(cursor: MessageCursor) {
  return sql`(${MessageTable.time_created}, ${MessageTable.id}) <= (${cursor.time}, ${cursor.id})`
}

// #0584：空字符串是无 closed Message 的合法 sentinel，恒早于任何具体行；
// 其余比较复用持久 (time, UTF-8 ID) 序，禁止 JS locale 字典序。
function compareMessageCursors(db: TxOrDb, sessionID: SessionID, left: string, right: string) {
  if (left === right) return 0
  if (left === "") return -1
  if (right === "") return 1
  const a = resolveMessageCursor(db, sessionID, left)
  const b = resolveMessageCursor(db, sessionID, right)
  return a.time - b.time || Buffer.compare(Buffer.from(a.id), Buffer.from(b.id))
}

type DiffAccumulator = {
  values: Snapshot.FileDiff[]
  byFile: Map<string, number>
}

function createAccumulator(initial: readonly Snapshot.FileDiff[] = []): DiffAccumulator {
  // clone initial items，归并过程不能原地修改调用方持有的 decoded payload。
  const values = initial.map((item) => ({ ...item }))
  return {
    values,
    byFile: new Map(values.flatMap((item, index) => (item.file ? [[item.file, index] as const] : []))),
  }
}

function mergeFileDiff(target: DiffAccumulator, item: Snapshot.FileDiff) {
  if (!item.file) {
    // 无 file 的历史条目无法安全归并，只能按原顺序追加而不猜测路径。
    target.values.push({ ...item })
    return target.values.length - 1
  }
  const index = target.byFile.get(item.file)
  if (index === undefined) {
    // 新文件记录首次 index，后续增量在原位置更新以保持 UI 顺序。
    target.byFile.set(item.file, target.values.length)
    // 首见同样受摄入界约束：单条 legacy 巨型 metadata 不能凭首见绕过（plan §16 切片 4 语义）。
    target.values.push({ ...item, patch: boundMergedPatch(item.patch ?? "", item.additions, item.deletions) })
    return target.values.length - 1
  }
  const current = target.values[index]
  if (!current) throw new Error(`Summary diff merge index disappeared: ${item.file}`)
  // 摄入界：逐轮拼接的 patch 超限时降级为事实标记，计数照常累加（INV-05）。这同时
  // 免疫已入库的 legacy 巨型 tool metadata（事故：216MB user message 行）；后续轮次在
  // 标记上继续拼接并重新检查，持久值上限 = MAX_MERGED_PATCH_CHARS + 单轮标记开销。
  const mergedPatch = boundMergedPatch(
    (current.patch ?? "") + (item.patch ?? ""),
    current.additions + item.additions,
    current.deletions + item.deletions,
  )
  target.values[index] = {
    ...current,
    // patch 字符串直接连接，保留 producer 原始转义和尾部换行；超限才降级。
    patch: mergedPatch,
    // 计数直接相加，与首次全量 collect 保持同一 totals 口径。
    additions: current.additions + item.additions,
    deletions: current.deletions + item.deletions,
    // 单一状态优先级阻止缓存路径产生与无缓存路径不同的状态漂移。
    status: heaviestStatus(current.status, item.status ?? inferStatus(item.additions, item.deletions)),
  }
  return index
}

// SummaryCache 与 SessionSummary 共用这一纯归并规则，避免缓存增量和显式 diff 各自定义文件状态。
// 输入只保留 completed Tool metadata；可见 Text、Tool output 和其他 Part 不会因聚合被复制到缓存。
export function collectToolDiffs(messages: readonly ToolDiffMessage[], worktree: string): Snapshot.FileDiff[] {
  const records = messages.flatMap(message => message.info.hidden ? [] :
    message.parts.flatMap(part => part.hidden ? [] : [part.state.metadata]),
  ).filter((meta): meta is Record<string, unknown> => meta !== null && typeof meta === "object" && !Array.isArray(meta))
  return ToolDiffs.collect(records, worktree)
}

export function toToolDiffMessages(messages: readonly MessageV2.WithParts[]): ToolDiffMessage[] {
  return messages.map((message) => ({
    info: { id: message.info.id, hidden: message.info.hidden },
    parts: message.parts.flatMap((part) => {
      if (part.type !== "tool" || part.state.status !== "completed") return []
      return [
        {
          hidden: part.hidden,
          type: "tool" as const,
          state: { status: "completed" as const, metadata: part.state.metadata },
        },
      ]
    }),
  }))
}

// DB rebuild 先按 MessageID/PartID 固定顺序读取，再只 inspect Tool metadata；它不会 hydrate Session business objects。
// 冷 Part 由 ColdStorage inspect 原地恢复到临时 row，owner ref/key 和 ref_count 保持不变。
function loadToolDiffMessages(db: TxOrDb, sessionID: SessionID, after?: string, through?: string) {
  // SQL 层排除 hidden 且只读 hot discriminator，超大 Tool output 不为可见性判断进入 JS。
  const closed = sql`(json_extract(${MessageTable.data}, '$.role') = 'user' or json_type(${MessageTable.data}, '$.time.completed') is not null)`
  const messageConditions: SQL[] = [
    eq(MessageTable.session_id, sessionID),
    sql`json_type(${MessageTable.data}, '$.hidden') is null`,
    closed,
  ]
  // #0584：cursor 只保存 MessageID，但范围判断必须先恢复同 Session 的 persisted tuple。
  if (after) {
    const condition = afterCursor(resolveMessageCursor(db, sessionID, after))
    if (condition) messageConditions.push(condition)
  }
  // through 是稳定历史闭区间，单轮 summary 不越过调用方目标。
  if (through) {
    const condition = throughCursor(resolveMessageCursor(db, sessionID, through))
    if (condition) messageConditions.push(condition)
  }
  // Message 与 Part 分开查询，只搬运必要 Tool rows 而不构造完整 transcript。
  // #0584：两组查询按 persisted chronology 排序，SQLite 扫描顺序不会改变 aggregate hash。
  const messages = db
    .select({ id: MessageTable.id })
    .from(MessageTable)
    .where(and(...messageConditions))
    .orderBy(asc(MessageTable.time_created), asc(MessageTable.id))
    .all()
  // snapshot cursor 基于全部可见 closed Message，即使没有 Tool diff 也推进已观察位置。
  const snapshotConditions: SQL[] = [
    eq(MessageTable.session_id, sessionID),
    sql`json_type(${MessageTable.data}, '$.hidden') is null`,
    closed,
  ]
  if (through) {
    const condition = throughCursor(resolveMessageCursor(db, sessionID, through))
    if (condition) snapshotConditions.push(condition)
  }
  const snapshotMaxID = db
    .select({ id: MessageTable.id })
    .from(MessageTable)
    .where(and(...snapshotConditions))
    .orderBy(desc(MessageTable.time_created), desc(MessageTable.id))
    .limit(1)
    .get()?.id ?? ""
  // 无增量时连 Part 查询也不发起，避免空刷新仍搬运整个会话的工具正文。
  if (messages.length === 0) return { messages: [], cursor: snapshotMaxID }
  const partConditions: SQL[] = [
    eq(PartTable.session_id, sessionID),
    // 复用同一消息范围且不展开 ID 参数表，首次全量构建也不受 SQLite 变量数量限制。
    inArray(PartTable.message_id, db.select({ id: MessageTable.id }).from(MessageTable).where(and(...messageConditions))),
    sql`json_extract(${PartTable.data}, '$.type') = 'tool'`,
    sql`json_extract(${PartTable.data}, '$.state.status') = 'completed'`,
    sql`json_type(${PartTable.data}, '$.hidden') is null`,
  ]
  // #0584：Part 归属以已选 Message 集合为准：回绕后 message_id 与 cursor 无共同排序，
  // 不能用 id 范围二次过滤。
  const parts = db
    .select({
      id: sql`${PartTable.id}`.mapWith(PartTable.id),
      message_id: sql`${PartTable.message_id}`.mapWith(PartTable.message_id),
      session_id: sql`${PartTable.session_id}`.mapWith(PartTable.session_id),
      time_created: sql`${PartTable.time_created}`.mapWith(PartTable.time_created),
      time_updated: sql`${PartTable.time_updated}`.mapWith(PartTable.time_updated),
      data: sql`${PartTable.data}`.mapWith(PartTable.data),
      cold_ref: sql`${PartTable.cold_ref}`.mapWith(PartTable.cold_ref),
      cold_key: sql`${PartTable.cold_key}`.mapWith(PartTable.cold_key),
      cold_stats: sql`${PartTable.cold_stats}`.mapWith(PartTable.cold_stats),
    })
    // 仅加 IN 仍可能误选 session 索引；按父消息点查，列解码继续复用原 schema。
    .from(sql`${PartTable} indexed by part_message_id_id_idx`)
    .where(and(...partConditions))
    .orderBy(asc(PartTable.message_id), asc(PartTable.id))
    .all()
  // inspect 只在内存恢复 metadata，不持久 thaw compacted head。
  const restored = ColdStorage.inspectPartRows(db, parts)
  // 最小消息形状只服务 collectToolDiffs，禁止借此读取 Text 或 provider context。
  const byMessage = new Map(
    messages.map((row) => [row.id, { info: { id: row.id }, parts: [] as ToolDiffPart[] }]),
  )
  for (const row of restored) {
    if (row.data.type !== "tool" || row.data.state.status !== "completed") continue
    const message = byMessage.get(row.message_id)
    // 缺失父 Message 的 Part 不可猜测归属，Map 同时保护损坏数据库边界。
    if (!message) continue
    message.parts.push({
      hidden: row.data.hidden,
      type: "tool",
      state: { status: "completed", metadata: row.data.state.metadata },
    })
  }
  // 首次 rebuild 与普通增量共用此结果，不维护第二套扫描算法。
  return { messages: [...byMessage.values()], cursor: snapshotMaxID }
}

type PreparedBase = {
  sessionID: SessionID
  targetMessageID?: MessageID
  previousRef: string | null
  previousCursor: string | null
  cursor: string
  snapshotMaxID: string
}

export type PreparedDelta = PreparedBase &
  (
    | { type: "changed"; payload: SummaryPayload; diffs: Diffs }
    | { type: "unchanged"; previousRef: string; previousCursor: string }
    | { type: "materialized"; diffs: Diffs; previousRef: string; previousCursor: string }
  )

type PreparedCacheDelta = Exclude<PreparedDelta, { type: "materialized" }>

// 增量结果以已有 aggregate 为 seed，保持首次出现的文件顺序、patch 拼接顺序和 status 规则。
// 该 merge 不重新扫描旧 Tool rows，避免每次 Session.diff 都把 compacted head 重新 inspect。
function mergeDiffs(previous: Diffs, delta: Diffs) {
  // previous 已通过 hash/codec 校验；clone 防止修改内容寻址 payload 的 decoded 对象。
  const result = createAccumulator(previous)
  // merge 不执行 I/O 或 retain，事务失败前不会创建无法释放的 payload。
  // delta 来自当前 DB snapshot，归一路径确保 Windows 分隔符不会再次分叉文件键。
  for (const item of delta) mergeFileDiff(result, item)
  // 结果是下一 payload 的完整值，commit 无需在 immediate transaction 再读旧 ref。
  return result.values
}

function sameDiff(left: Snapshot.FileDiff | undefined, right: Snapshot.FileDiff | undefined) {
  return (
    left !== undefined &&
    right !== undefined &&
    left.file === right.file &&
    left.patch === right.patch &&
    left.additions === right.additions &&
    left.deletions === right.deletions &&
    left.status === right.status
  )
}

function collectWithPrefixProof(messages: ToolDiffMessage[], legacy: Diffs, base: string) {
  // equality 只在发生变化的 file index 上更新；每个 Message 边界判断为 O(1)，不会反复扫描完整 legacy。
  // values 长度与 equalCount 同时相等才是完整有序前缀，部分文件重合或不同顺序都不能获得 lineage。
  // 无 Tool 的 closed Message 仍形成合法边界，因此每轮 merge 后都检查一次，而不是只在 delta 非空时检查。
  const expected = normalizeDiffPaths(legacy)
  const result = createAccumulator()
  const equalAt: boolean[] = []
  let equalCount = 0
  let prefixCursor: MessageID | undefined
  for (const message of messages) {
    for (const item of collectToolDiffs([message], base)) {
      const previous = result.byFile.get(item.file ?? "")
      const index = mergeFileDiff(result, item)
      if (previous !== undefined && equalAt[index]) equalCount--
      const equal = sameDiff(result.values[index], expected[index])
      equalAt[index] = equal
      if (equal) equalCount++
    }
    if (result.values.length === expected.length && equalCount === expected.length) prefixCursor = message.info.id
  }
  return { diffs: result.values, prefixCursor }
}

function publicDiffs(payload: SummaryPayload) {
  return payload.seed ? mergeDiffs(payload.seed.diffs, payload.delta) : payload.delta.map((item) => ({ ...item }))
}

function stateCondition(sessionID: SessionID, summaryRef: string | null, summaryCursor: string | null) {
  return and(
    eq(SessionTable.id, sessionID),
    summaryRef === null ? isNull(SessionTable.summary_ref) : eq(SessionTable.summary_ref, summaryRef),
    summaryCursor === null ? isNull(SessionTable.summary_cursor) : eq(SessionTable.summary_cursor, summaryCursor),
  )
}

type SummaryState = {
  summaryRef: string | null
  summaryCursor: string | null
  summaryInitialized: boolean
  summaryInitDirty: boolean
  summarySeed: { cursor: string; diffs: Snapshot.FileDiff[] } | null
}

function requireSummaryState(sessionID: SessionID, state: SummaryState) {
  // 四种持久状态必须由 initialized 明确区分；不能用 NULL ref 猜测是首次导入还是历史失效。
  // claimed 状态允许 cursor 先于 ref 落盘，dirty 只在该窗口内有意义并可跨进程恢复。
  if (!state.summaryInitialized) {
    if (state.summaryRef || state.summarySeed || (state.summaryCursor === null && state.summaryInitDirty)) {
      throw new Error(`Session summary initialization state is inconsistent: ${sessionID}`)
    }
    return
  }
  // initialized cache 要求 ref/cursor 成对；无 cache 时 cursor 也必须清空。
  if (state.summaryInitDirty || (state.summaryRef === null) !== (state.summaryCursor === null)) {
    throw new Error(`Session summary cache state is inconsistent: ${sessionID}`)
  }
  // seed 与 live ref 同时存在会制造两个 aggregate 前缀，读取前必须报告损坏。
  if (state.summaryRef && state.summarySeed) {
    throw new Error(`Session summary has two authorities: ${sessionID}`)
  }
}

function selectSummaryState(db: TxOrDb, sessionID: SessionID) {
  const row = db
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
  if (!row) throw new Error(`Session not found: ${sessionID}`)
  requireSummaryState(sessionID, row)
  return row
}

function greatestClosedMessageID(db: TxOrDb, sessionID: SessionID) {
  // User Message 已完整持久化即可成为无 Tool 的边界；Assistant 只有 completed 后才可冻结其 Tool metadata。
  // hidden 行不参与当前可见历史，claim 不得让后续 undo cleanup 误以为它仍受旧 mirror 覆盖。
  // 倒序扫描只搬运 Message hot projection，不 hydrate Parts，也不会触发 cold owner 解冻。
  const rows = db
    .select({ id: MessageTable.id, data: MessageTable.data })
    .from(MessageTable)
    .where(eq(MessageTable.session_id, sessionID))
    .orderBy(desc(MessageTable.time_created), desc(MessageTable.id))
    .all()
  return rows.find((row) => !row.data.hidden && (row.data.role === "user" || row.data.time.completed !== undefined))?.id ?? ""
}

function claimInitialization(db: TxOrDb, sessionID: SessionID) {
  const state = selectSummaryState(db, sessionID)
  if (state.summaryInitialized) return { type: "initialized" as const }
  if (state.summaryCursor !== null) {
    return { type: "claimed" as const, cursor: state.summaryCursor, dirty: state.summaryInitDirty }
  }
  const cursor = greatestClosedMessageID(db, sessionID)
  const updated = db
    .update(SessionTable)
    .set({ summary_cursor: cursor, summary_init_dirty: false, time_updated: SessionTable.time_updated })
    .where(and(eq(SessionTable.id, sessionID), isNull(SessionTable.summary_cursor), eq(SessionTable.summary_initialized, false)))
    .returning({ id: SessionTable.id })
    .get()
  if (!updated) throw new Error(`Session summary initialization claim changed: ${sessionID}`)
  return { type: "claimed" as const, cursor, dirty: false }
}

// ref/cursor swap、CAS 和旧 payload release 共享一个 immediate transaction，避免并发 summary 把 ref_count 加倍。
// 相同 hash 只推进 cursor，不重复 retain/release；不同 hash 先取得新 owner，再清旧 owner，失败则整体回滚。
// 这是 summary owner 生命周期唯一写 seam，其他 producer 只能调用对应 invalidation/release。
function commitSummary(
  db: TxOrDb,
  input: {
    sessionID: SessionID
    previousRef: string | null
    previousCursor: string | null
    payload: SummaryPayload
    cursor: string
  },
) {
  // caller 的 immediate transaction 将状态读取和交换串联，deferred writer 不具备同样排他性。
  const now = Date.now()
  // retain payload 先验证 schema/canonical/hash，Session 不会指向未验证 bytes。
  const retained = ColdStorage.retainSummaryPayload(db, input.payload, now)
  // 内容 hash 不变时不增减引用，cursor-only 提交不能逐次抬高 refcount。
  // 新 ref 在 CAS 前取得 owner count，RESTRICT 防止中途形成悬空引用。
  if (retained.hash !== input.previousRef) ColdStorage.retainSummaryReference(db, retained.hash, now)
  // CAS 同时比较旧 ref/cursor，并发提交会明确失败而不是覆盖新 authority。
  const updated = db
    .update(SessionTable)
    .set({
      summary_ref: retained.hash,
      summary_cursor: input.cursor,
      summary_initialized: true,
      summary_init_dirty: false,
      summary_seed: null,
      // 派生 cache 刷新保持 activity 时间，不能把旧 Session 伪装为刚编辑。
      time_updated: SessionTable.time_updated,
    })
    .where(stateCondition(input.sessionID, input.previousRef, input.previousCursor))
    .returning({ id: SessionTable.id })
    .get()
  // 零行不是幂等成功，它证明 owner 消失或 CAS 已被并发改写。
  if (!updated) throw new Error(`Session summary cache changed during commit: ${input.sessionID}`)
  if (input.previousRef && input.previousRef !== retained.hash) {
    // 旧 ref 只在新 owner 落盘后释放，transaction rollback 会同步恢复两侧。
    ColdStorage.releaseSummaryReference(db, input.previousRef)
  }
  // hash 仅供内部证据使用，不是可以绕过 load 暴露的 archive 地址。
  return retained.hash
}

// 没有新 diff-producing Tool 时 aggregate bytes 与 owner identity 都未变化；这里只推进已观测的快照 cursor。
// CAS 仍同时校验旧 ref/cursor，确保并发历史失效或另一轮提交不能被一次无内容增量覆盖。
function advanceSummaryCursor(db: TxOrDb, input: PreparedDelta & { type: "unchanged" }) {
  const updated = db
    .update(SessionTable)
    .set({ summary_cursor: input.cursor, time_updated: SessionTable.time_updated })
    .where(stateCondition(input.sessionID, input.previousRef, input.previousCursor))
    .returning({ id: SessionTable.id })
    .get()
  if (!updated) throw new Error(`Session summary cache changed during cursor advance: ${input.sessionID}`)
}

function confirmMaterialized(db: TxOrDb, input: PreparedDelta & { type: "materialized" }) {
  // materialization 已在首次兼容事务提交；automatic summarize 这里只确认期间没有失效或 owner swap。
  // summary-only per-user metadata 更新不触及 Tool history，因此合法情况下 ref/cursor 必须保持原值。
  // 零行代表并发历史变化，必须失败让下一轮重算，不能重复发布已经陈旧的 counters/Bus event。
  const state = selectSummaryState(db, input.sessionID)
  if (!state.summaryInitialized || state.summaryRef !== input.previousRef || state.summaryCursor !== input.previousCursor) {
    throw new Error(`Session summary cache changed after materialization: ${input.sessionID}`)
  }
}

const ensureInitialized = Effect.fn("SummaryCache.ensureInitialized")(function* (input: {
  sessionID: SessionID
  storage: Storage.Interface
}) {
  // 初始化 claim 与后续提交分别预约同一连接，镜像读取不持有 SQL 预约。
  const database = yield* Database.Service
  const claim = yield* Database.withSync(database, (sync) =>
    sync.transaction((db) => claimInitialization(db, input.sessionID), { behavior: "immediate" }),
  )
  if (claim.type === "initialized") return undefined

  // dirty claim 已证明 mirror 早于覆盖历史，继续读取只会扩大竞态窗口且最终结果必须丢弃。
  const mirror = claim.dirty
    ? undefined
    : yield* input.storage
        .read<unknown>(["session_diff", input.sessionID])
        .pipe(Effect.catchIf(NotFoundError.isInstance, () => Effect.succeed(undefined)), Effect.orDie)
  const legacy = yield* Effect.sync(() => {
    if (mirror === undefined) return undefined
    if (!isDiffs(mirror)) throw new Error(`Session diff mirror is invalid: ${input.sessionID}`)
    return mirror.map((item) => ({ ...item }))
  })
  const ctx = yield* InstanceState.context
  const base = ctx.worktree && ctx.worktree !== "/" ? ctx.worktree : ctx.directory

  return yield* Database.withSync(database, (sync) =>
    sync.transaction(
      (db) => {
        // 外部 I/O 后必须在同一 immediate transaction 重读 claim；并发 initializer 已提交时直接采用 DB authority。
        // claimed cursor 是 mirror 的最大可信边界，真正提交的 cursor 仍取当前 closed history，不能提交已删除 ID。
        const state = selectSummaryState(db, input.sessionID)
        if (state.summaryInitialized) return undefined
        if (state.summaryCursor !== claim.cursor) {
          throw new Error(`Session summary initialization claim changed: ${input.sessionID}`)
        }
        const row = db
          .select({ diffs: SessionTable.summary_diffs })
          .from(SessionTable)
          .where(eq(SessionTable.id, input.sessionID))
          .get()
        if (!row) throw new Error(`Session not found: ${input.sessionID}`)
        // dirty 证明 legacy/row mirror 陈旧，本轮只能从当前可见 Tool rows 构建。
        // 文件 missing 才回退迁移 row；空数组是有效历史，不能与 missing 混淆。
        const imported = state.summaryInitDirty ? undefined : legacy ?? row.diffs ?? undefined
        if (imported !== undefined && !isDiffs(imported)) {
          throw new Error(`Session diff compatibility value is invalid: ${input.sessionID}`)
        }
        const cursor = greatestClosedMessageID(db, input.sessionID)
        const collected = loadToolDiffMessages(db, input.sessionID, undefined, cursor || undefined)
        const rebuilt = imported ? collectWithPrefixProof(collected.messages, imported, base) : undefined
        // 可证明 cumulative prefix 时使用完整 Tool aggregate，保留 mirror 之后的 tail 且不重复旧 patch。
        // 无法证明时旧值仍是覆盖 claim 边界的 opaque authority；现有 Tool evidence 不参与猜测性合并。
        const payload: SummaryPayload = imported
          ? rebuilt?.prefixCursor
            ? { delta: rebuilt.diffs }
            : { seed: { cursor, diffs: imported.map((item) => ({ ...item })) }, delta: [] }
          : { delta: collectToolDiffs(collected.messages, base) }
        const diffs = publicDiffs(payload)
        const ref = commitSummary(db, {
          sessionID: input.sessionID,
          previousRef: null,
          previousCursor: state.summaryCursor,
          payload,
          cursor,
        })
        return { ref, cursor, diffs }
      },
      { behavior: "immediate" },
    ),
  )
})

function prepareDeltaState(
  db: TxOrDb,
  input: { sessionID: SessionID; targetMessageID?: MessageID },
  base: string,
): PreparedCacheDelta {
  // ref/cursor 必须成对出现；半状态没有可证明的恢复方向，不能回退到外部 session_diff 镜像。
  // prepared value 保存 previous state，异步计算完成后 commit 才能检测期间发生的并发写入。
  // base 来自 InstanceState 的 worktree/directory，DB 层不猜当前进程 cwd。
  const session = selectSummaryState(db, input.sessionID)
  // 初始化不完整是状态错误；此处不重新读取可清理 mirror 作为备用成功路径。
  if (!session.summaryInitialized) throw new Error(`Session summary was not initialized: ${input.sessionID}`)

  if (session.summaryRef) {
    // 已缓存路径先扫描 cursor 后的 Tool，无变化时不解压旧 aggregate。
    const collected = loadToolDiffMessages(db, input.sessionID, session.summaryCursor ?? undefined)
    // cursor 落后是正常增量，超前则证明历史被外部改写，必须 hard-fail。
    // #0584：超前判定同样按持久 (time, BINARY id) tuple，raw 字典序在回绕后会误报。
    if (session.summaryCursor !== null && compareMessageCursors(db, input.sessionID, collected.cursor, session.summaryCursor) < 0) {
      throw new Error(`Session summary cursor is ahead of message history: ${input.sessionID}`)
    }
    const delta = collectToolDiffs(collected.messages, base)
    // delta 查询必须先于旧 payload decode；无内容增量直接返回 cursor-only 计划，避免自动 summary 反复解压同一 archive。
    if (collected.cursor === session.summaryCursor || delta.length === 0) {
      // 新的非 Tool Message 仍需推进 snapshot cursor，即使没有文件 delta。
      return {
        type: "unchanged",
        sessionID: input.sessionID,
        targetMessageID: input.targetMessageID,
        previousRef: session.summaryRef,
        previousCursor: session.summaryCursor!,
        cursor: collected.cursor,
        snapshotMaxID: collected.cursor,
      }
    }
    // 只有真实文件增量才 inspect previous summary，保持 routine Session.diff 的低解压成本。
    const previous = ColdStorage.inspectSummary(db, session.summaryRef)
    const payload = { ...previous, delta: mergeDiffs(previous.delta, delta) }
    return {
      type: "changed",
      sessionID: input.sessionID,
      // target 只限制调用方可见上界，不改变全局 cache owner 的 CAS 身份。
      targetMessageID: input.targetMessageID,
      previousRef: session.summaryRef,
      previousCursor: session.summaryCursor,
      payload,
      diffs: publicDiffs(payload),
      cursor: collected.cursor,
      snapshotMaxID: collected.cursor,
    }
  }

  // 无 live ref 时从 seed cursor 后扫描，inspect 不会持久 thaw compacted head。
  const collected = loadToolDiffMessages(db, input.sessionID, session.summarySeed?.cursor)
  const payload: SummaryPayload = {
    ...(session.summarySeed
      ? { seed: { cursor: session.summarySeed.cursor, diffs: session.summarySeed.diffs.map((item) => ({ ...item })) } }
      : {}),
    delta: collectToolDiffs(collected.messages, base),
  }
  // 封闭 changed/unchanged 联合禁止用可选字段拼出缺少 diffs 的伪提交。
  return {
    type: "changed",
    sessionID: input.sessionID,
    targetMessageID: input.targetMessageID,
    previousRef: null,
    previousCursor: null,
    payload,
    diffs: publicDiffs(payload),
    cursor: collected.cursor,
    // snapshotMaxID 让 commit 后的调用方证明 cache 覆盖到哪个稳定位置。
    snapshotMaxID: collected.cursor,
  }
}

export const prepareDelta = Effect.fn("SummaryCache.prepareDelta")(function* (input: {
  sessionID: SessionID
  targetMessageID?: MessageID
  storage: Storage.Interface
}) {
  const materialized = yield* ensureInitialized(input)
  if (materialized) {
    return {
      type: "materialized" as const,
      sessionID: input.sessionID,
      targetMessageID: input.targetMessageID,
      previousRef: materialized.ref,
      previousCursor: materialized.cursor,
      cursor: materialized.cursor,
      snapshotMaxID: materialized.cursor,
      diffs: materialized.diffs,
    }
  }
  const ctx = yield* InstanceState.context
  const base = ctx.worktree && ctx.worktree !== "/" ? ctx.worktree : ctx.directory
  const database = yield* Database.Service
  return yield* Database.withSync(database, (sync) =>
    sync.transaction((db) => prepareDeltaState(db, input, base), { behavior: "immediate" }),
  )
})

export const commit = Effect.fn("SummaryCache.commit")(function* (input: PreparedDelta) {
  const database = yield* Database.Service
  return yield* Database.withSync(database, (sync) =>
    sync.transaction(
      (db) =>
        input.type === "unchanged"
          ? advanceSummaryCursor(db, input)
          : input.type === "materialized"
            ? confirmMaterialized(db, input)
            : commitSummary(db, input),
      { behavior: "immediate" },
    ),
  )
})

export const load = Effect.fn("SummaryCache.load")(function* (input: {
  sessionID: SessionID
  storage: Storage.Interface
}) {
  // load 是读取 aggregate 的唯一公开入口，但读取可能需要原子推进 cursor 或建立首次 cache。
  // 同一 immediate transaction 内 prepare 与 commit，防止二者之间插入新的 Tool rows 造成漏计。
  // TUI、HTTP 与 CLI 共用累计语义，前端不会触发额外预热策略。
  yield* ensureInitialized(input)
  // InstanceState 提供稳定 project base，多目录 daemon 不会混用另一项目路径。
  const ctx = yield* InstanceState.context
  const base = ctx.worktree && ctx.worktree !== "/" ? ctx.worktree : ctx.directory
  // corruption 沿 Effect defect 失败，不能以空数组覆盖仍可修复的 owner。
  // ref、codec 和 cursor 均封装在后端，调用方无需判断 aggregate 的冷热状态。
  const database = yield* Database.Service
  return yield* Database.withSync(database, (sync) =>
    // 同步 transaction 不跨网络/文件 I/O，持锁只覆盖 SQLite 与 summary zstd decode。
    sync.transaction(
      (db) => {
        const prepared = prepareDeltaState(db, input, base)
        if (prepared.type === "unchanged") {
          // unchanged 只推进 cursor 并 inspect 已验证 payload，不重写相同 compressed bytes。
          advanceSummaryCursor(db, prepared)
          return publicDiffs(ColdStorage.inspectSummary(db, prepared.previousRef))
        }
        // changed 先交换 DB authority，再把完整累计 diffs 返回而不暴露 delta。
        commitSummary(db, prepared)
        // 外部 mirror 只能在此 transaction 提交后由上层写出，不能先于 DB authority。
        return prepared.diffs
      },
      { behavior: "immediate" },
    ),
  )
})

function unquoteGitPath(input: string) {
  // Git core.quotePath 可能用双引号和八进制字节表示非 ASCII 文件名，DB 必须保存真实 UTF-8 路径。
  // 只有首尾引号同时存在才进入解码；普通 Windows 反斜杠路径不能被误当成 Git escape。
  if (!input.startsWith('"') || !input.endsWith('"')) return input
  // 只改变 file display/key，不触碰 patch、计数或其他 payload 业务值。
  const body = input.slice(1, -1)
  // byte accumulator 允许多段八进制最终作为一个 UTF-8 序列解码。
  const bytes: number[] = []
  for (let i = 0; i < body.length; i++) {
    const char = body[i]!
    if (char !== "\\") {
      bytes.push(char.charCodeAt(0))
      continue
    }
    const next = body[i + 1]
    if (!next) {
      // 不完整反斜杠按字面保留，使损坏展示可见而不是静默删字符。
      bytes.push("\\".charCodeAt(0))
      continue
    }
    if (next >= "0" && next <= "7") {
      // Git C-style 八进制最多三位，不能吞掉后续普通数字。
      const match = body.slice(i + 1, i + 4).match(/^[0-7]{1,3}/)
      if (!match) {
        bytes.push(next.charCodeAt(0))
        i++
        continue
      }
      bytes.push(parseInt(match[0], 8))
      i += match[0].length
      continue
    }
    // 只处理 Git 标准转义；未知转义保留字符而不猜测额外兼容分支。
    const escaped =
      next === "n"
        ? "\n"
        : next === "r"
          ? "\r"
          : next === "t"
            ? "\t"
            : next === "b"
              ? "\b"
              : next === "f"
                ? "\f"
                : next === "v"
                  ? "\v"
                  : next === "\\" || next === '"'
                    ? next
                    : undefined
    bytes.push((escaped ?? next).charCodeAt(0))
    i++
  }
  // 统一按 UTF-8 解码多字节路径，不能逐 JavaScript code unit 拼接中文名。
  // 不探测 filesystem；数据库可能来自另一平台且对应文件早已不存在。
  // 纯函数结果让首次 collect 与 legacy mirror normalize 得到相同稳定键。
  return Buffer.from(bytes).toString()
}

export function normalizeDiffPaths(diffs: Diffs) {
  const next = diffs.map((item) => {
    if (item.file === undefined) return item
    const file = unquoteGitPath(item.file)
    if (file === item.file) return item
    return { ...item, file }
  })
  return next.some((item, i) => item.file !== diffs[i]?.file) ? next : diffs
}

function toWorktreeRel(base: string, target: string, fromBase: string = base) {
  const abs = path.isAbsolute(target) ? target : path.resolve(fromBase, target)
  return path.relative(base, abs).replaceAll("\\", "/")
}

function countPatchStats(patch: string) {
  let additions = 0
  let deletions = 0
  for (const line of patch.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue
    if (line.startsWith("+")) additions++
    else if (line.startsWith("-")) deletions++
  }
  return { additions, deletions }
}

function inferStatus(additions: number, deletions: number): "added" | "deleted" | "modified" {
  if (deletions === 0 && additions > 0) return "added"
  if (additions === 0 && deletions > 0) return "deleted"
  return "modified"
}

function heaviestStatus(a: Snapshot.FileDiff["status"], b: NonNullable<Snapshot.FileDiff["status"]>) {
  if (!a) return b
  if (a === "added" || a === "deleted") return a
  return b
}

function mapStatus(type: string | undefined): NonNullable<Snapshot.FileDiff["status"]> | undefined {
  if (!type) return undefined
  if (type === "add") return "added"
  if (type === "delete") return "deleted"
  return "modified"
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

export * as SummaryCache from "./summary-cache"
