import { createHash, randomUUID } from "node:crypto"
import {
  constants as zlibConstants,
  zstdCompressSync as nodeZstdCompressSync,
  zstdDecompressSync as nodeZstdDecompressSync,
} from "node:zlib"
import { Schema } from "effect"
import { and, desc, eq, gt, inArray, isNotNull, isNull, sql, type SQL } from "drizzle-orm"
import { Database, type TxOrDb } from "./db"
import { ColdStorageTable, MessageTable, PartTable, SessionTable } from "@/session/session.sql"
import { MessageID, PartID, SessionID as SessionIDSchema, type SessionID } from "@/session/schema"
import { Snapshot } from "@/snapshot"
import type { MessageV2 } from "@/session/message-v2"

const MIN_ENVELOPE_BYTES = 4096
const SQL_CANDIDATE_MIN_BYTES = MIN_ENVELOPE_BYTES - 64
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000
export const DEFAULT_BATCH_SIZE = 2000
const MAX_BATCH_SIZE = 5000
const isDiffsSchema = Schema.is(Schema.Array(Snapshot.FileDiff))

function isDiffs(value: unknown): value is readonly Schema.Schema.Type<typeof Snapshot.FileDiff>[] {
  return isDiffsSchema(value)
}

type Owner = { type: "message"; id: MessageID } | { type: "part"; id: PartID }
type OwnerKind = Owner["type"]
type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
type Envelope = { version: 1; owner: OwnerKind; fields: Record<string, Json> }
type MessageData<T extends MessageV2.Info = MessageV2.Info> = T extends unknown ? Omit<T, "id" | "sessionID"> : never
type PartData<T extends MessageV2.Part = MessageV2.Part> = T extends unknown
  ? Omit<T, "id" | "sessionID" | "messageID">
  : never

// CorruptionError 表示持久数据已违反可逆性 invariant，调用方必须终止读取或维护任务。
// hash 可选是因为 missing batch/canonical parse 等错误可能在定位具体 payload 前发生。
export class CorruptionError extends Schema.TaggedErrorClass<CorruptionError>()("ColdStorageCorruptionError", {
  message: Schema.String,
  hash: Schema.optional(Schema.String),
}) {}

// CodecUnavailableError 只描述当前运行时无法执行 zstd，不与 payload 已损坏的 CorruptionError 混淆。
// typed error 允许 CLI/daemon 给出环境诊断，同时禁止隐式改用另一个持久格式。
export class CodecUnavailableError extends Schema.TaggedErrorClass<CodecUnavailableError>()(
  "ColdStorageCodecUnavailableError",
  { message: Schema.String },
) {}

// ValidationError 覆盖用户 request、scope、cursor 与 fork map 的可证明非法输入，不代表数据库损坏。
// control/CLI 层只序列化该错误，规范化和默认值的 owner 仍保持在 ColdStorage。
export class ValidationError extends Schema.TaggedErrorClass<ValidationError>()("ColdStorageValidationError", {
  message: Schema.String,
}) {}

// FreezeResult 把正常“未处理”与异常分开；ineligible/below-threshold 不应让整个维护 task failed。
// frozen 返回 raw/compressed bytes 供 checkpoint 统计，但不暴露 payload body 或 storage projection。
export type FreezeResult =
  | { type: "frozen"; hash: string; rawBytes: number; compressedBytes: number }
  | { type: "skipped"; reason: "missing" | "already-cold" | "ineligible" | "no-fields" | "below-threshold" }

// StatusReport 区分可冻 owner、现有 cold owner、unique payload 和共享逻辑 bytes，避免收益口径混用。
// mismatch/orphan 来自真实 owner 反算，用户可以在执行 repair/cleanup 前看到风险范围。
export type StatusReport = {
  eligibleOwners: number
  coldOwners: number
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
  refCountMismatches: number
  missingPayloads: number
  corruptPayloads: number
  repaired: number
}

// CleanupReport 的 candidate 与 deleted 分开，保证 dry-run 输出不能被误读为已经释放磁盘内容。
// bytes 是 compressed payload logical size；物理 SQLite 文件变化只能由显式 vacuum report 表示。
export type CleanupReport = {
  candidates: number
  candidateBytes: number
  deleted: number
  deletedBytes: number
}

// MaintenanceRequest 是 daemon control 和 offline CLI 唯一共享的行为联合，operation 决定合法参数。
// confirm/repair/delete 使用显式 boolean，避免模糊 flag 在后端被解释为写授权。
export type MaintenanceRequest =
  | { operation: "compress"; sessionID?: SessionID; olderThanMs: number; batchSize: number }
  | { operation: "expand"; sessionID?: SessionID; all: boolean; batchSize: number }
  | { operation: "status" }
  | { operation: "verify"; repair: boolean; batchSize: number }
  | { operation: "cleanup"; delete: boolean; batchSize: number }
  | { operation: "vacuum"; confirm: boolean }

// owner cursor 按 Message 后 Part 推进，payload cursor 按 hash 推进；两者不能在 resume 中互换。
// cursor 只是跳过已提交批次的性能状态，真正幂等事实仍是 owner cold_ref 与 payload refcount。
export type MaintenanceCursor = { owner: "message" | "part"; lastID: string } | { stage: "payload"; lastHash: string }

// MaintenanceTask 是可断线查询的控制元数据，不保存任何 Message/Part 内容或冷 payload 副本。
// processed/skipped/failed 与 byte counters 只在批次提交后 checkpoint，不能领先数据库事实。
// dbPath 固定 task 所属数据库，防止相同 taskID 被另一 channel/测试数据库错误恢复。
export type MaintenanceTask = {
  version: 1
  taskID: string
  dbPath: string
  operation: "compress" | "expand" | "verify" | "cleanup"
  args: MaintenanceRequest
  status: "queued" | "running" | "interrupted" | "completed" | "failed"
  cursor?: MaintenanceCursor
  processed: number
  skipped: number
  failed: number
  rawBytes: number
  compressedBytes: number
  createdAt: number
  updatedAt: number
  error?: string
}

// PreparedMaintenance 固化 immediate/task-backed 决策，worker 与 CLI 不再各自复制 operation switch。
// task variant 在数据写入前携带 queued record，提供 crash window 的恢复锚点。
export type PreparedMaintenance =
  | { type: "immediate"; request: MaintenanceRequest }
  | { type: "task"; request: MaintenanceRequest; task: MaintenanceTask }

// runtime 把文件 lease/checkpoint/abort 作为注入边界，ColdStorage 不直接拥有 daemon 文件生命周期。
// lease assert 是每批写入前的硬门禁，signal 只在 transaction 之间生效。
export type MaintenanceRuntime = {
  task?: MaintenanceTask
  lease?: { assertOwned(): void }
  signal?: AbortSignal
  checkpoint(task: MaintenanceTask): Promise<void>
}

// MaintenanceResult 明确区分 task 状态与同步报告，CLI 不能把 failed task 包装成 status 成功。
// vacuum 只返回 page 数，不创建伪 cursor；其他写操作都返回持久 task record。
export type MaintenanceResult =
  | { type: "task"; task: MaintenanceTask }
  | { type: "status"; report: StatusReport }
  | { type: "verify"; report: VerifyReport }
  | { type: "cleanup"; report: CleanupReport }
  | { type: "vacuum"; pagesBefore: number; pagesAfter: number }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

// 默认 string sort 比较 UTF-16 code unit，astral key 与 BMP key 的顺序可能不等于持久协议要求的 code point 顺序。
// 显式 comparator 不依赖系统 locale，Windows/Linux/macOS 对同一 Unicode object 必须产生相同 hash。
function compareCodePoints(left: string, right: string) {
  const a = Array.from(left, (value) => value.codePointAt(0) ?? 0)
  const b = Array.from(right, (value) => value.codePointAt(0) ?? 0)
  const different = a.findIndex((value, index) => value !== b[index])
  if (different === -1) return a.length - b.length
  const other = b[different]
  return other === undefined ? 1 : a[different] - other
}

// canonicalizer 接受 unknown 是因为 provider metadata 和 diff 来自持久化边界，不能先信任静态类型。
// undefined 只允许作为对象中的“未提供字段”被省略，array 内 undefined 会被拒绝而不是悄悄变 null。
// 非有限 number 在 JSON 中没有可逆表示；freeze 必须失败，不能生成无法逐字恢复的 payload。
// 返回自有 Json 递归类型，使后续 hash 输入不再携带任意 prototype 或运行时对象语义。
function json(value: unknown): Json {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new ValidationError({ message: "Cold payload contains a non-finite number" })
    return value
  }
  if (Array.isArray(value)) return value.map(json)
  if (!isRecord(value)) throw new ValidationError({ message: "Cold payload contains a non-JSON value" })

  // object key 的排序是 payload 身份的一部分；所有 writer 必须经过这里，不能依赖调用方插入顺序。
  // array 顺序保持不变，因为 diff、attachment 与 tool 输出中的列表顺序具有业务语义。
  return Object.fromEntries(
    Object.keys(value)
      .toSorted(compareCodePoints)
      .flatMap((key) => (value[key] === undefined ? [] : [[key, json(value[key])]])),
  )
}

// envelope.fields 必须是 JSON object；该显式 narrowing 取代把 canonicalizer 结果强转为 Record 的类型逃逸。
// 调用方虽传入 object，仍由同一 runtime 校验拒绝 nested 非 JSON 值，返回类型因此可被持久格式信任。
function jsonObject(value: Record<string, unknown>) {
  const result = json(value)
  if (result === null || Array.isArray(result) || typeof result !== "object") {
    throw new ValidationError({ message: "Cold payload fields must be a JSON object" })
  }
  return result
}

// canonical 只负责确定未压缩身份，不参与 codec 选择；未来升级压缩器不会改变同一 payload 的 hash。
// JSON.stringify 在 key 已排序后提供稳定 string escaping，避免不同平台自行拼接字符串产生差异。
// 这里不做 pretty-print，空白若进入 hash 会放大 payload 且让同一语义形成多个内容地址。
function canonical(value: unknown) {
  return JSON.stringify(json(value))
}

// owner kind 进入 digest 可隔离 Message 与 Part 的恢复 schema，即使 fields JSON 恰好完全相同也不共享。
// hash 只覆盖 canonical raw bytes；compressed frame 的实现差异不能改变内容地址和 fork 引用身份。
// SHA-256 collision 被后续 raw size、kind、codec 和解压后 digest 复验共同视为 corruption，而非去重命中。
function digest(owner: OwnerKind, raw: Uint8Array) {
  // owner prefix 防止相同 JSON 值在 Message/Part 两种恢复语义之间错误共享。
  // NUL 是不可能出现在固定 owner 名中的稳定分隔符，hash 输入因此没有拼接歧义。
  return createHash("sha256")
    .update(owner)
    .update(Buffer.from([0]))
    .update(raw)
    .digest("hex")
}

// 压缩适配器固定产生标准 zstd frame，数据库不保存 Bun/Node 平台标记，保证跨平台可展开。
// level 3 是实测甜点：740 MB canonical payload 单进程约 16.7 秒，继续提高级别会让 CPU 反客为主。
// codec 不可用是环境错误，不能回退为 gzip；静默混用格式会让 codec 列失去完整性约束。
// 同步 API 只在维护批次或单 owner freeze 内调用，前端请求不会在每次上下文构建时重新压缩。
function compress(raw: Uint8Array) {
  try {
    // Bun 与 Node 使用同一 zstd frame 格式；codec 字段描述格式，而不是运行时实现。
    // 固定 level 3 保证相同 canonical bytes 的性能策略一致，hash 本身仍只依赖未压缩内容。
    if (typeof Bun !== "undefined") return Buffer.from(Bun.zstdCompressSync(raw, { level: 3 }))
    return nodeZstdCompressSync(raw, {
      params: { [zlibConstants.ZSTD_c_compressionLevel]: 3 },
    })
  } catch (cause) {
    throw new CodecUnavailableError({ message: `zstd compression unavailable: ${String(cause)}` })
  }
}

// 解压异常统一转成 corruption，业务读取必须 hard-fail，不能把热 projection 的空字符串发给模型。
// Bun 与 Node 都读取同一 frame；该 seam 是跨平台差异的唯一 owner，调用方不判断当前运行时。
// raw size 与 digest 在 decode 中另行核验，因此成功返回 bytes 不代表 payload 已经可信。
function decompress(payload: Uint8Array) {
  try {
    if (typeof Bun !== "undefined") return Buffer.from(Bun.zstdDecompressSync(payload))
    return nodeZstdDecompressSync(payload)
  } catch (cause) {
    throw new CorruptionError({ message: `zstd payload cannot be decompressed: ${String(cause)}` })
  }
}

// envelope 聚合同一 owner 的全部冷字段，保证一次 thaw 可以原子恢复完整业务对象。
// fields 路径属于持久格式；新增路径必须同步扩展 extraction、restore、schema version 和 corruption 测试。
// 先 canonicalize 再编码 UTF-8，门槛和 hash 都基于真正落库的 raw bytes，而不是 JS 字符数。
function envelope(owner: OwnerKind, fields: Record<string, unknown>) {
  const value: Envelope = { version: 1, owner, fields: jsonObject(fields) }
  const raw = Buffer.from(canonical(value))
  return { value, raw, hash: digest(owner, raw) }
}

// parseEnvelope 不接受“语义等价但非 canonical”的 JSON，避免手工写入绕过唯一内容身份。
// version、owner 和 fields 三个结构字段缺一不可；未知版本必须由迁移处理，不能由当前 reader 猜测。
// 解析后的 fields 再走 Json 校验，阻止 prototype、非有限数值或非 JSON 值进入恢复路径。
// canonical byte equality 是 digest 之外的格式约束，可定位 hash 正确但 writer 不符合协议的外部破坏。
function parseEnvelope(owner: OwnerKind, raw: Uint8Array, hash: string): Envelope {
  let value: unknown
  try {
    value = JSON.parse(Buffer.from(raw).toString("utf8"))
  } catch (cause) {
    throw new CorruptionError({ message: `Cold payload is not JSON: ${String(cause)}`, hash })
  }
  if (!isRecord(value) || value.version !== 1 || value.owner !== owner || !isRecord(value.fields)) {
    throw new CorruptionError({ message: "Cold payload envelope does not match its owner", hash })
  }
  const parsed = { version: 1 as const, owner, fields: jsonObject(value.fields) }
  if (!Buffer.from(canonical(parsed)).equals(Buffer.from(raw))) {
    throw new CorruptionError({ message: "Cold payload is not canonical JSON", hash })
  }
  return parsed
}

function extractMessage(data: (typeof MessageTable.$inferSelect)["data"]) {
  const summary = data.role === "user" ? data.summary : undefined
  if (!summary) return
  if (!isDiffs(summary.diffs)) throw new CorruptionError({ message: "Stored message diffs fail schema validation" })
  if (summary.diffs.length === 0) return
  const projection = structuredClone(data)
  if (projection.role !== "user" || !projection.summary) {
    throw new CorruptionError({ message: "User message summary disappeared during freeze" })
  }
  const projectionSummary = projection.summary
  const result = envelope("message", { "summary.diffs": summary.diffs })
  projectionSummary.diffs = []
  return { projection, ...result }
}

// data URI 是唯一允许外移的 URL；普通 file path、HTTP URL 和 source 定位字段必须持续可搜索。
// 只检查稳定前缀而不解析 media 内容，避免 maintenance 因超大 base64 再做一次无意义解码。
// 空 projection URL 只能由 cold_ref 证明，业务 decoder 在 cold_ref 丢失时必须把它视为损坏数据。
function isInlineData(value: string) {
  return value.startsWith("data:")
}

function storedString(value: unknown, message: string) {
  // StoredPartData 故意把可冷字符串标成 unknown；所有 extraction 分支必须在读取 length/prefix 前经过此门禁。
  // 返回 typed string 而非强转，使外部 SQL 破坏在 freeze 阶段就成为 corruption，不生成不可恢复 payload。
  if (typeof value === "string") return value
  throw new CorruptionError({ message })
}

// extraction 先只读检查冷字段，再对真正候选 structuredClone，避免扫描 1.1 GB tool JSON 时无效深拷贝。
// completed tool 才有稳定 output；pending/running state 仍可能被 processor 更新，禁止在维护中冻结。
// attachment 保留数组位置和可见 metadata，只抽取 data URI，确保 TUI 结构与 search identity 不变。
// reasoning 只抽取 text，file 只抽取 data URI url；step/patch/compaction 等结构 part 永远不进入白名单。
// 多个冷字段进入同一 envelope，owner update、refcount 和恢复因此共享一个原子事务边界。
function extractPart(data: (typeof PartTable.$inferSelect)["data"]) {
  const fields: Record<string, unknown> = {}

  if (data.type === "tool" && data.state.status === "completed") {
    const output = storedString(data.state.output, "Stored tool output is not a string")
    if (output.length > 0) {
      fields["state.output"] = output
    }
    for (const [index, attachment] of data.state.attachments?.entries() ?? []) {
      const url = storedString(attachment.url, "Stored tool attachment URL is not a string")
      if (!isInlineData(url)) continue
      // attachment 的 mime/filename/source 常驻主表；只把体积大的 inline URL 抽到 envelope。
      // index 写入字段路径，恢复时可以精确回填而不改变 attachment 顺序或对象身份。
      fields[`state.attachments.${index}.url`] = url
    }
  }
  if (data.type === "reasoning") {
    const text = storedString(data.text, "Stored reasoning text is not a string")
    if (text.length > 0) fields.text = text
  }
  if (data.type === "file") {
    const url = storedString(data.url, "Stored file URL is not a string")
    if (isInlineData(url)) fields.url = url
  }
  if (Object.keys(fields).length === 0) return
  const projection = structuredClone(data)
  if (projection.type === "tool" && projection.state.status === "completed") {
    if ("state.output" in fields) projection.state.output = ""
    for (const field of Object.keys(fields)) {
      const match = /^state\.attachments\.(\d+)\.url$/.exec(field)
      if (match) {
        const attachment = projection.state.attachments?.[Number(match[1])]
        if (!attachment) throw new CorruptionError({ message: "Tool attachment disappeared during freeze" })
        attachment.url = ""
      }
    }
  }
  if (projection.type === "reasoning" && "text" in fields) projection.text = ""
  if (projection.type === "file" && "url" in fields) projection.url = ""
  return { projection, ...envelope("part", fields) }
}

// Message restore 只接受唯一 summary.diffs 路径，防止 part 字段或未来未知字段被错误合并进 user info。
// projection 必须仍是 user 且保留 summary；否则 cold_ref 与 owner skeleton 已失配，应中止整个读取事务。
// FileDiff 通过 Effect Schema 重新验证，外部 SQL 写入的任意 JSON 不能借 thaw 冒充完整业务类型。
// 返回对象是完整替换输入；后续修改非冷字段时 diffs 会自然随对象保留，不需要 touched-field 猜测。
function restoreMessage(data: (typeof MessageTable.$inferSelect)["data"], value: Envelope, hash: string) {
  const summary = data.role === "user" ? data.summary : undefined
  if (!summary) {
    throw new CorruptionError({ message: "Message projection cannot accept summary.diffs", hash })
  }
  const keys = Object.keys(value.fields)
  if (keys.length !== 1 || keys[0] !== "summary.diffs" || !Array.isArray(value.fields["summary.diffs"])) {
    throw new CorruptionError({ message: "Message cold fields are invalid", hash })
  }
  const restored = structuredClone(data)
  if (restored.role !== "user" || !restored.summary) {
    throw new CorruptionError({ message: "User message summary disappeared during thaw", hash })
  }
  const restoredSummary = restored.summary
  const diffs = value.fields["summary.diffs"]
  if (!isDiffs(diffs)) throw new CorruptionError({ message: "Message diffs fail schema validation", hash })
  // Schema.is 只验证而不执行 decode transform；新建数组但保留已解析对象，避免恢复时规范化丢字段。
  restoredSummary.diffs = Array.from(diffs)
  return restored
}

// Part restore 按显式路径和 discriminator 双重匹配，合法字符串也不能跨 reasoning/file/tool 语义回填。
// attachment index 必须仍指向 projection 中的同一位置；数组结构漂移代表 owner 被外部修改，必须失败。
// 所有字段恢复到 clone，原始 row 对象不被原地污染，事务失败时调用方不会观察半恢复状态。
// 未识别路径 hard-fail 是版本边界；在 reader 中忽略它会让 expand 宣称成功却永久遗失未知字段。
// restore 不自行删除 blob，只有 owner 回填成功后 release/decrement 才能改变引用生命周期。
function restorePart(data: (typeof PartTable.$inferSelect)["data"], value: Envelope, hash: string) {
  const restored = structuredClone(data)
  for (const [field, fieldValue] of Object.entries(value.fields)) {
    if (field === "state.output" && restored.type === "tool" && restored.state.status === "completed") {
      if (typeof fieldValue !== "string") throw new CorruptionError({ message: "Tool output is not a string", hash })
      restored.state.output = fieldValue
      continue
    }
    if (field === "text" && restored.type === "reasoning") {
      if (typeof fieldValue !== "string") throw new CorruptionError({ message: "Reasoning text is not a string", hash })
      restored.text = fieldValue
      continue
    }
    if (field === "url" && restored.type === "file") {
      if (typeof fieldValue !== "string") throw new CorruptionError({ message: "File URL is not a string", hash })
      restored.url = fieldValue
      continue
    }
    const match = /^state\.attachments\.(\d+)\.url$/.exec(field)
    if (match && restored.type === "tool" && restored.state.status === "completed") {
      const attachment = restored.state.attachments?.[Number(match[1])]
      if (!attachment || typeof fieldValue !== "string") {
        throw new CorruptionError({ message: "Tool attachment URL does not match its projection", hash })
      }
      attachment.url = fieldValue
      continue
    }
    throw new CorruptionError({ message: `Cold field cannot be restored: ${field}`, hash })
  }
  return restored
}

function latestBoundary(db: TxOrDb, sessionID: SessionID) {
  // completed summary 的 parent user 才能形成边界；未完成 marker 不能让历史提前进入冷存储。
  // SQL join 只选择最新有效 marker，避免为每个 owner 把整个 session 的 JSON 拉进 JS。
  return db
    .select({ boundary: sql<MessageID>`json_extract(${PartTable.data}, '$.tail_start_id')` })
    .from(PartTable)
    .innerJoin(
      MessageTable,
      and(
        eq(MessageTable.session_id, PartTable.session_id),
        sql`json_extract(${MessageTable.data}, '$.parentID') = ${PartTable.message_id}`,
      ),
    )
    .where(
      and(
        eq(PartTable.session_id, sessionID),
        sql`json_extract(${PartTable.data}, '$.type') = 'compaction'`,
        sql`json_extract(${PartTable.data}, '$.tail_start_id') is not null`,
        sql`json_extract(${MessageTable.data}, '$.role') = 'assistant'`,
        sql`json_extract(${MessageTable.data}, '$.summary') = 1`,
        sql`json_extract(${MessageTable.data}, '$.finish') is not null`,
        sql`json_type(${MessageTable.data}, '$.error') is null`,
      ),
    )
    .orderBy(desc(PartTable.message_id))
    .limit(1)
    .get()?.boundary
}

// eligibility 同时读取 session age 与最新 completed compaction boundary，两条规则在一个 owner 判断中合并。
// session.time_updated 是 age 的唯一时钟；Message/Part 自身时间不能代表会话是否仍在活跃使用。
// olderThanMs 由准备后的 request 固定，resume 不允许用新 CLI 参数改变同一 task 的判定集合。
// boundary 查询结果可按 session.updated 缓存，但业务写入改变 session 时间后必须重新计算以避免冻住新 tail。
function eligibility(db: TxOrDb, sessionID: SessionID, now: number, olderThanMs = THIRTY_DAYS_MS) {
  const session = db
    .select({ updated: SessionTable.time_updated })
    .from(SessionTable)
    .where(eq(SessionTable.id, sessionID))
    .get()
  if (!session) return
  return { aged: session.updated <= now - olderThanMs, boundary: latestBoundary(db, sessionID) }
}

// aged session 的所有 owner 都可检查白名单；recent session 只允许严格早于 tail_start_id 的 compacted head。
// 使用 MessageID 的持久字典序，因为 ID ascending 是仓库既有时间排序 invariant，不能改用 wall-clock 猜顺序。
// marker、summary 与 tail 即使通过 age/boundary，仍必须通过 extraction 白名单和 4 KiB 门槛才能真正冻结。
function eligible(state: ReturnType<typeof eligibility>, messageID: string) {
  if (!state) return false
  return state.aged || (state.boundary !== undefined && messageID < state.boundary)
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
  return messages + parts
}

// 单 owner retain 保留严格复验，供实时 update/freeze 使用；维护批次走 retainBatch 共享查询和 codec 工作。
// 已有 payload 复用前比较 kind、codec、raw/compressed size 和真实计数，不能把损坏 row 当作去重收益。
// 新 payload 初始 ref_count 为零，只有 owner projection 成功写回后才递增，事务 rollback 会同时撤销两步。
// 每次复用都比较当前 canonical bytes；hash 相同不自动证明 requested value 与既有 payload 相同。
function retain(db: TxOrDb, value: ReturnType<typeof envelope>, now: number) {
  const existing = db.select().from(ColdStorageTable).where(eq(ColdStorageTable.hash, value.hash)).get()
  if (existing) {
    // hash collision 或损坏 row 不能被“去重成功”掩盖；复用前先证明格式和计数仍一致。
    // 该校验也阻止不同 owner kind 因错误 hash 输入而共享同一恢复语义。
    if (
      existing.kind !== value.value.owner ||
      existing.codec !== "zstd" ||
      existing.raw_bytes !== value.raw.byteLength ||
      existing.compressed_bytes !== existing.payload.byteLength ||
      existing.ref_count !== ownerCount(db, value.hash)
    ) {
      throw new CorruptionError({ message: "Existing cold payload metadata is inconsistent", hash: value.hash })
    }
    const restored = decode(db, value.hash, value.value.owner)
    if (!Buffer.from(canonical(restored)).equals(value.raw)) {
      throw new CorruptionError({
        message: "Cold payload hash collides with different canonical bytes",
        hash: value.hash,
      })
    }
    return { compressedBytes: existing.compressed_bytes }
  } else {
    const compressed = compress(value.raw)
    db.insert(ColdStorageTable)
      .values({
        hash: value.hash,
        kind: value.value.owner,
        codec: "zstd",
        payload: compressed,
        raw_bytes: value.raw.byteLength,
        compressed_bytes: compressed.byteLength,
        ref_count: 0,
        time_created: now,
        time_updated: now,
      })
      .run()
    return { compressedBytes: compressed.byteLength }
  }
}

// ownerCounts 以固定分块执行两个 GROUP BY，既遵守 SQLite variable 上限，也把数万 payload 的验证压成少量查询。
// 未出现在结果中的 hash 按零 owner 处理；调用方再结合 payload row 区分 orphan 与 missing payload。
// 计数 map 不读取 payload bytes，status/cleanup 不会因为报告引用关系而触发任何 thaw 或 zstd 解压。
function ownerCounts(db: TxOrDb, hashes: string[]) {
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
  }
  return result
}

// retainBatch 先按 canonical hash 去重，一个批次中相同 payload 只压缩、插入和校验一次。
// existing 的 ref_count 在 owner upsert 前核验；随后 incrementReferences 只增加本批真实写入的 owner 数。
// compressedBytes map 同时覆盖新旧 payload，使 task metrics 保持按 owner 统计而 status 仍按 unique blob 统计。
// 所有 payload insert 与 owner insert 位于同一个 immediate transaction，任一 codec/SQL 错误都会整体 rollback。
// 批量路径不降低 corruption 标准，只消除逐 owner select/insert/update 导致的十万级 SQLite 往返。
// 建立 unique map 前先比较同 hash 的 raw bytes，禁止 Map 最后写入者掩盖批内 collision。
// 复用数据库 payload 时再次比较 requested canonical bytes，跨批共享也不能仅信任 digest 与长度。
function retainBatch(db: TxOrDb, values: ReturnType<typeof envelope>[], now: number) {
  const unique = new Map<string, ReturnType<typeof envelope>>()
  for (const value of values) {
    const previous = unique.get(value.hash)
    if (previous && !Buffer.from(previous.raw).equals(value.raw)) {
      throw new CorruptionError({ message: "Cold batch contains a content hash collision", hash: value.hash })
    }
    unique.set(value.hash, value)
  }
  const hashes = [...unique.keys()]
  if (hashes.length === 0) return new Map<string, number>()
  const existing = db.select().from(ColdStorageTable).where(inArray(ColdStorageTable.hash, hashes)).all()
  const existingByHash = new Map(existing.map((row) => [row.hash, row]))
  const counts = ownerCounts(
    db,
    existing.map((row) => row.hash),
  )
  const compressedBytes = new Map<string, number>()

  for (const row of existing) {
    const value = unique.get(row.hash)
    if (
      !value ||
      row.kind !== value.value.owner ||
      row.codec !== "zstd" ||
      row.raw_bytes !== value.raw.byteLength ||
      row.compressed_bytes !== row.payload.byteLength ||
      row.ref_count !== (counts.get(row.hash) ?? 0)
    ) {
      throw new CorruptionError({ message: "Existing cold payload metadata is inconsistent", hash: row.hash })
    }
    const restored = decode(db, row.hash, value.value.owner)
    if (!Buffer.from(canonical(restored)).equals(value.raw)) {
      throw new CorruptionError({
        message: "Cold payload hash collides with different canonical bytes",
        hash: row.hash,
      })
    }
    compressedBytes.set(row.hash, row.compressed_bytes)
  }

  const created = [...unique.values()].flatMap((value) => {
    if (existingByHash.has(value.hash)) return []
    const payload = compress(value.raw)
    compressedBytes.set(value.hash, payload.byteLength)
    return [
      {
        hash: value.hash,
        kind: value.value.owner,
        codec: "zstd" as const,
        payload,
        raw_bytes: value.raw.byteLength,
        compressed_bytes: payload.byteLength,
        ref_count: 0,
        time_created: now,
        time_updated: now,
      },
    ]
  })
  if (created.length > 0) db.insert(ColdStorageTable).values(created).run()
  return compressedBytes
}

// 引用增加按 hash 聚合，fork 和 maintenance 都不会对共享 payload 执行重复 UPDATE。
// CASE 增量基于事务开始时已验证的 ref_count；owner 批量写入失败时该语句不会单独提交。
// 再按 DEFAULT_BATCH_SIZE 分块，避免大型 fork 的唯一 hash 数超过 SQLite 参数和表达式限制。
function incrementReferences(db: TxOrDb, values: Array<{ hash: string }>, now: number) {
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
function decodedBatch(db: TxOrDb, hashes: string[], owner: OwnerKind) {
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
function requiredEnvelope(values: Map<string, Envelope>, hash: string) {
  const value = values.get(hash)
  if (!value) throw new CorruptionError({ message: "Decoded cold batch is missing an envelope", hash })
  return value
}

// 批量递减先更新计数，再只删除 ref_count=0 且两个 owner 表都不存在引用的 payload。
// NOT EXISTS 是最后一道安全闸，防止外部并发写入或计数错误把仍被 fork 共享的 blob 删除。
// 删除和 owner 清 ref 在同一事务；中断只发生在批次边界，不会产生已展开 row 指向已删 payload 的半状态。
function decrementReferences(db: TxOrDb, hashes: string[], now: number) {
  const counts = new Map<string, number>()
  for (const hash of hashes) counts.set(hash, (counts.get(hash) ?? 0) + 1)
  const entries = [...counts]
  if (entries.length === 0) return
  const cases = entries.map(
    ([hash, count]) => sql`when ${ColdStorageTable.hash} = ${hash} then ${ColdStorageTable.ref_count} - ${count}`,
  )
  const affected = entries.map(([hash]) => hash)
  db.update(ColdStorageTable)
    .set({
      ref_count: sql`case ${sql.join(cases, sql.raw(" "))} else ${ColdStorageTable.ref_count} end`,
      time_updated: now,
    })
    .where(inArray(ColdStorageTable.hash, affected))
    .run()
  db.delete(ColdStorageTable)
    .where(
      and(
        inArray(ColdStorageTable.hash, affected),
        eq(ColdStorageTable.ref_count, 0),
        sql`not exists (select 1 from ${MessageTable} where ${MessageTable.cold_ref} = ${ColdStorageTable.hash})`,
        sql`not exists (select 1 from ${PartTable} where ${PartTable.cold_ref} = ${ColdStorageTable.hash})`,
      ),
    )
    .run()
}

// Message batch thaw 先按 unique hash 校验并解压，再为每个 hot projection 恢复独立完整对象。
// 批量 upsert 清 ref 后才聚合递减 payload，任何 restore 失败都会阻止该批所有 owner 改变。
// time_created 保持原值，time_updated 只记录 storage row 维护，不触碰 Session.time_updated 的活跃度依据。
function thawMessageBatch(db: TxOrDb, rows: (typeof MessageTable.$inferSelect)[], now: number) {
  const cold = rows.filter((row): row is typeof row & { cold_ref: string } => row.cold_ref !== null)
  const values = decodedBatch(
    db,
    cold.map((row) => row.cold_ref),
    "message",
  )
  if (cold.length > 0) {
    db.insert(MessageTable)
      .values(
        cold.map((row) => ({
          ...row,
          data: restoreMessage(row.data, requiredEnvelope(values, row.cold_ref), row.cold_ref),
          cold_ref: null,
          time_updated: now,
        })),
      )
      .onConflictDoUpdate({
        target: MessageTable.id,
        set: { data: sql`excluded.data`, cold_ref: null, time_updated: now },
      })
      .run()
    decrementReferences(
      db,
      cold.map((row) => row.cold_ref),
      now,
    )
  }
}

// Part batch thaw 与 Message 对称，但按每个 projection 的 discriminator 执行 restorePart 字段协议检查。
// bulk upsert 只更新 data/cold_ref/time_updated，不改变 message/session 归属和原始 time_created。
// 一批共享 hash 只解压一次并按实际 owner 数递减，避免全量 expand 再退化为逐行引用查询。
// 该 helper 仅用于 maintenance；普通 MessageV2.parts/get 仍按请求范围持久预热，前端无需传 read intent。
function thawPartBatch(db: TxOrDb, rows: (typeof PartTable.$inferSelect)[], now: number) {
  const cold = rows.filter((row): row is typeof row & { cold_ref: string } => row.cold_ref !== null)
  const values = decodedBatch(
    db,
    cold.map((row) => row.cold_ref),
    "part",
  )
  if (cold.length > 0) {
    db.insert(PartTable)
      .values(
        cold.map((row) => ({
          ...row,
          data: restorePart(row.data, requiredEnvelope(values, row.cold_ref), row.cold_ref),
          cold_ref: null,
          time_updated: now,
        })),
      )
      .onConflictDoUpdate({
        target: PartTable.id,
        set: { data: sql`excluded.data`, cold_ref: null, time_updated: now },
      })
      .run()
    decrementReferences(
      db,
      cold.map((row) => row.cold_ref),
      now,
    )
  }
}

// Message freeze batch 先做 exact envelope 门槛和 eligibility 复验，SQL candidate 过滤仅是性能前置条件。
// eligibilityState 由 task 按 session.updated 缓存；每个真正候选才触发 boundary 查询，非冷字段 row 不付成本。
// payload、owner projection、refcount 三类写入共享事务，checkpoint 只在提交后记录 cursor 和 byte counters。
// upsert 使用原 row 的 session/time 字段，避免批量化把 storage maintenance 误表现成新的对话活动。
function freezeMessageBatch(
  db: TxOrDb,
  rows: (typeof MessageTable.$inferSelect)[],
  input: {
    now: number
    olderThanMs: number
    eligibilityState(sessionID: SessionID): ReturnType<typeof eligibility>
  },
) {
  const prepared = rows.flatMap((row) => {
    const value = extractMessage(row.data)
    if (!value || value.raw.byteLength < MIN_ENVELOPE_BYTES) return []
    if (!eligible(input.eligibilityState(row.session_id), row.id)) return []
    return [{ row, value }]
  })
  const bytes = retainBatch(
    db,
    prepared.map((item) => item.value),
    input.now,
  )
  if (prepared.length > 0) {
    db.insert(MessageTable)
      .values(
        prepared.map((item) => ({
          ...item.row,
          data: item.value.projection,
          cold_ref: item.value.hash,
          time_updated: input.now,
        })),
      )
      .onConflictDoUpdate({
        target: MessageTable.id,
        set: { data: sql`excluded.data`, cold_ref: sql`excluded.cold_ref`, time_updated: input.now },
      })
      .run()
    incrementReferences(
      db,
      prepared.map((item) => item.value),
      input.now,
    )
  }
  return {
    skipped: rows.length - prepared.length,
    rawBytes: prepared.reduce((total, item) => total + item.value.raw.byteLength, 0),
    compressedBytes: prepared.reduce((total, item) => total + (bytes.get(item.value.hash) ?? 0), 0),
  }
}

// Part freeze batch 聚合 tool output/attachment、reasoning text 和 file data URI，不接受白名单外类型。
// retainBatch 对同批 hash 去重，随后 owner upsert 与引用增量按 prepared owner 数一一对应。
// skipped 只统计 SQL 候选中最终不足门槛或不符合 age/compact 的 row，不把全表非候选计入 task 噪声。
// batchSize=2000 已在 2.2 GB 数据上验证，兼顾 SQLite 参数上限、WAL 写入和 checkpoint 恢复粒度。
function freezePartBatch(
  db: TxOrDb,
  rows: (typeof PartTable.$inferSelect)[],
  input: {
    now: number
    olderThanMs: number
    eligibilityState(sessionID: SessionID): ReturnType<typeof eligibility>
  },
) {
  const prepared = rows.flatMap((row) => {
    const value = extractPart(row.data)
    if (!value || value.raw.byteLength < MIN_ENVELOPE_BYTES) return []
    if (!eligible(input.eligibilityState(row.session_id), row.message_id)) return []
    return [{ row, value }]
  })
  const bytes = retainBatch(
    db,
    prepared.map((item) => item.value),
    input.now,
  )
  if (prepared.length > 0) {
    db.insert(PartTable)
      .values(
        prepared.map((item) => ({
          ...item.row,
          data: item.value.projection,
          cold_ref: item.value.hash,
          time_updated: input.now,
        })),
      )
      .onConflictDoUpdate({
        target: PartTable.id,
        set: { data: sql`excluded.data`, cold_ref: sql`excluded.cold_ref`, time_updated: input.now },
      })
      .run()
    incrementReferences(
      db,
      prepared.map((item) => item.value),
      input.now,
    )
  }
  return {
    skipped: rows.length - prepared.length,
    rawBytes: prepared.reduce((total, item) => total + item.value.raw.byteLength, 0),
    compressedBytes: prepared.reduce((total, item) => total + (bytes.get(item.value.hash) ?? 0), 0),
  }
}

// release 的调用前提是当前 owner 已在同一事务清除 cold_ref，所以 remaining 是“其他 owner”的真实数量。
// ref_count 必须恰好等于 remaining+1；偏大或偏小都代表外部破坏，不能在正常删除中自动修正。
// 最后一个 owner 删除 payload，否则只把计数设置为反算值；该语义保护 fork 父子独立 thaw/delete。
function release(db: TxOrDb, hash: string) {
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
// 成功结果仍未合并到 owner；restore 和 owner update 完成后才能 release 引用。
function decode(db: TxOrDb, hash: string, owner: OwnerKind) {
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
  return parseEnvelope(owner, raw, hash)
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
      .set({ cold_ref: null })
      .where(eq(MessageTable.id, MessageID.make(id)))
      .run()
  } else {
    db.update(PartTable)
      .set({ cold_ref: null })
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
    .values({ ...row, cold_ref: null })
    .onConflictDoUpdate({ target: MessageTable.id, set: { data: row.data, cold_ref: null } })
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
    .values({ ...row, cold_ref: null })
    .onConflictDoUpdate({ target: PartTable.id, set: { data: row.data, cold_ref: null } })
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
  const hashes = new Map<string, OwnerKind>()
  for (const row of sourceMessages) {
    if (!row.cold_ref) continue
    const kind = hashes.get(row.cold_ref)
    if (kind && kind !== "message") {
      throw new CorruptionError({
        message: "Fork source hash is referenced by different owner kinds",
        hash: row.cold_ref,
      })
    }
    hashes.set(row.cold_ref, "message")
  }
  for (const row of sourceParts) {
    if (!row.cold_ref) continue
    const kind = hashes.get(row.cold_ref)
    if (kind && kind !== "part") {
      throw new CorruptionError({
        message: "Fork source hash is referenced by different owner kinds",
        hash: row.cold_ref,
      })
    }
    hashes.set(row.cold_ref, "part")
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
    decode(db, payload.hash, expected)
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
    }
  })
  for (let offset = 0; offset < messages.length; offset += DEFAULT_BATCH_SIZE) {
    db.insert(MessageTable)
      .values(messages.slice(offset, offset + DEFAULT_BATCH_SIZE))
      .run()
  }

  const parts = sourceParts.map((row) => {
    const targetID = partMap.get(row.id)
    const targetMessageID = messageMap.get(row.message_id)
    if (!targetID || !targetMessageID) throw new ValidationError({ message: `Fork part map misses ${row.id}` })
    const data = structuredClone(row.data)
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
      cold_ref: row.cold_ref,
    }
  })
  for (let offset = 0; offset < parts.length; offset += DEFAULT_BATCH_SIZE) {
    db.insert(PartTable)
      .values(parts.slice(offset, offset + DEFAULT_BATCH_SIZE))
      .run()
  }

  incrementReferences(
    db,
    [...sourceMessages, ...sourceParts].flatMap((row) => (row.cold_ref ? [{ hash: row.cold_ref }] : [])),
    Date.now(),
  )
  // projector 仍拥有 Session usage totals；返回 raw Part data 让它复用既有 step-finish 聚合而不再次查询或 thaw。
  return sourceParts.map((row) => row.data)
}

// freeze 是单 owner 事务内核，供公开 freezeOwner 使用；批量 maintenance 复用相同 extraction/eligibility 规则。
// extraction 与 exact 4 KiB 门槛先执行，只有真正候选才查询 session age/compaction boundary。
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
    if (row.cold_ref) return { type: "skipped", reason: "already-cold" }
    const value = extractMessage(row.data)
    if (!value) return { type: "skipped", reason: "no-fields" }
    if (value.raw.byteLength < MIN_ENVELOPE_BYTES) return { type: "skipped", reason: "below-threshold" }
    const state =
      typeof input.eligibilityState === "function"
        ? input.eligibilityState()
        : (input.eligibilityState ?? eligibility(db, row.session_id, input.now, input.olderThanMs))
    if (!eligible(state, row.id)) return { type: "skipped", reason: "ineligible" }
    const retained = retain(db, value, input.now)
    const updated = db
      .update(MessageTable)
      .set({ data: value.projection, cold_ref: value.hash })
      .where(and(eq(MessageTable.id, row.id), isNull(MessageTable.cold_ref)))
      .returning({ id: MessageTable.id })
      .get()
    if (!updated) throw new CorruptionError({ message: "Message owner changed during freeze", hash: value.hash })
    db.update(ColdStorageTable)
      .set({ ref_count: sql`${ColdStorageTable.ref_count} + 1`, time_updated: input.now })
      .where(eq(ColdStorageTable.hash, value.hash))
      .run()
    return {
      type: "frozen",
      hash: value.hash,
      rawBytes: value.raw.byteLength,
      compressedBytes: retained.compressedBytes,
    }
  }

  const row = db.select().from(PartTable).where(eq(PartTable.id, input.id)).get()
  if (!row) return { type: "skipped", reason: "missing" }
  if (row.cold_ref) return { type: "skipped", reason: "already-cold" }
  const value = extractPart(row.data)
  if (!value) return { type: "skipped", reason: "no-fields" }
  if (value.raw.byteLength < MIN_ENVELOPE_BYTES) return { type: "skipped", reason: "below-threshold" }
  const state =
    typeof input.eligibilityState === "function"
      ? input.eligibilityState()
      : (input.eligibilityState ?? eligibility(db, row.session_id, input.now, input.olderThanMs))
  if (!eligible(state, row.message_id)) return { type: "skipped", reason: "ineligible" }
  const retained = retain(db, value, input.now)
  const updated = db
    .update(PartTable)
    .set({ data: value.projection, cold_ref: value.hash })
    .where(and(eq(PartTable.id, row.id), isNull(PartTable.cold_ref)))
    .returning({ id: PartTable.id })
    .get()
  if (!updated) throw new CorruptionError({ message: "Part owner changed during freeze", hash: value.hash })
  db.update(ColdStorageTable)
    .set({ ref_count: sql`${ColdStorageTable.ref_count} + 1`, time_updated: input.now })
    .where(eq(ColdStorageTable.hash, value.hash))
    .run()
  return {
    type: "frozen",
    hash: value.hash,
    rawBytes: value.raw.byteLength,
    compressedBytes: retained.compressedBytes,
  }
}

// 公开 freezeOwner 是测试、精确 session 操作和未来内部调用的最小 seam，不暴露 codec 或 projection 细节。
// olderThanMs 可由已规范化 maintenance request 传入，缺省保持产品合同的 30 天。
// 返回 skipped reason 便于 task 计数，但不会把 ineligible/below-threshold 当作错误或改写 owner。
export function freezeOwner(input: Owner & { now?: number; olderThanMs?: number }): FreezeResult {
  const now = input.now ?? Date.now()
  return Database.transaction((db) => freeze(db, { ...input, now, olderThanMs: input.olderThanMs ?? THIRTY_DAYS_MS }), {
    behavior: "immediate",
  })
}

// Message range thaw 在一个 immediate transaction 中恢复传入范围；未含 cold_ref 时直接零成本返回原 rows。
// 每个 row 在事务内重新读取，避免调用方持有的旧 projection 覆盖刚完成的其他 writer 更新。
// 成功回填后立即 release，后续 page/get 读取主表热 JSON，不再反复解压，这是持久预热语义。
// corruption 会使整个范围 rollback，模型不会收到部分完整、部分占位的混合上下文。
export function thawMessageRows(rows: (typeof MessageTable.$inferSelect)[]) {
  if (!rows.some((row) => row.cold_ref)) return rows
  return Database.transaction(
    (db) =>
      rows.map((input) => {
        if (!input.cold_ref) return input
        const row = db.select().from(MessageTable).where(eq(MessageTable.id, input.id)).get()
        if (!row) throw new CorruptionError({ message: `Message disappeared during thaw: ${input.id}` })
        if (!row.cold_ref) return row
        const data = restoreMessage(row.data, decode(db, row.cold_ref, "message"), row.cold_ref)
        db.update(MessageTable)
          .set({ data, cold_ref: null })
          .where(and(eq(MessageTable.id, row.id), eq(MessageTable.cold_ref, row.cold_ref)))
          .run()
        release(db, row.cold_ref)
        return { ...row, data, cold_ref: null }
      }),
    { behavior: "immediate" },
  )
}

// Part range thaw 与 Message 共享持久预热合同，Session.getPart 和 MessageV2.hydrate 都必须经过该 decoder。
// 事务内重读保证 projection 与 cold_ref 来自同一版本；已被其他 reader thaw 的 row 直接采用最新热数据。
// release 在完整 data UPDATE 后执行，确保 fork 共享 payload 只在最后一个 owner 完成恢复时删除。
export function thawPartRows(rows: (typeof PartTable.$inferSelect)[]) {
  if (!rows.some((row) => row.cold_ref)) return rows
  return Database.transaction(
    (db) =>
      rows.map((input) => {
        if (!input.cold_ref) return input
        const row = db.select().from(PartTable).where(eq(PartTable.id, input.id)).get()
        if (!row) throw new CorruptionError({ message: `Part disappeared during thaw: ${input.id}` })
        if (!row.cold_ref) return row
        const data = restorePart(row.data, decode(db, row.cold_ref, "part"), row.cold_ref)
        db.update(PartTable)
          .set({ data, cold_ref: null })
          .where(and(eq(PartTable.id, row.id), eq(PartTable.cold_ref, row.cold_ref)))
          .run()
        release(db, row.cold_ref)
        return { ...row, data, cold_ref: null }
      }),
    { behavior: "immediate" },
  )
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
  const state = (sessionID: SessionID) => {
    if (!states.has(sessionID)) states.set(sessionID, eligibility(db, sessionID, now, olderThanMs))
    return states.get(sessionID)
  }
  const messages = db
    .select()
    .from(MessageTable)
    .where(and(isNull(MessageTable.cold_ref), messageCandidate()))
    .all()
  const parts = db
    .select()
    .from(PartTable)
    .where(and(isNull(PartTable.cold_ref), partCandidate()))
    .all()
  return (
    messages.filter((row) => {
      const value = extractMessage(row.data)
      if (!value || value.raw.byteLength < MIN_ENVELOPE_BYTES) return false
      return eligible(state(row.session_id), row.id)
    }).length +
    parts.filter((row) => {
      const value = extractPart(row.data)
      if (!value || value.raw.byteLength < MIN_ENVELOPE_BYTES) return false
      return eligible(state(row.session_id), row.message_id)
    }).length
  )
}

// Message SQL candidate 只做必要条件预筛，最终 envelope bytes 与 eligibility 仍由 extraction 路径决定。
// row data 包含冷字段外的 role/time/model 热结构，因此 row 小于 4 KiB 时冷 envelope 不可能达到门槛。
// 本机 96,557 Message 全量验证该条件零漏选；保留 exact JS 检查防止未来 schema 变化改变比例。
function messageCandidate() {
  // cold envelope 只保留原 row 的大型字段，而 row 还包含 role/time/model 等热结构；
  // 因此 row UTF-8 小于门槛时 envelope 必然也不足门槛，可在 JSON 解析前安全排除。
  return sql`length(cast(${MessageTable.data} as blob)) >= ${SQL_CANDIDATE_MIN_BYTES}
    and json_extract(${MessageTable.data}, '$.role') = 'user'
    and json_array_length(json_extract(${MessageTable.data}, '$.summary.diffs')) > 0`
}

// Part candidate 在 SQL 中限定白名单 discriminator 和 data URI，避免 43 万 row 全部进入 JS/structuredClone。
// row byte 门槛预留 64-byte envelope 固定包装差；它只扩大候选，不会绕过最终 exact 4096-byte 判定。
// file part 是原 row 热骨架最小的白名单类型，余量覆盖 fields/owner/version 相对 type/mime/url 的差值。
// tool 的多个 attachment 仍由 envelope 聚合后精确计量，未来字段变化也不会因等值预筛漏掉近门槛 owner。
// search 可见的 tool/input/filename 字段不参与该条件，筛选本身不会读取或改写业务热投影。
// 本机 snapshot 逐 row 重建 envelope 证明小于门槛的 Part 零漏选，最大未选 envelope 为 4062 bytes。
function partCandidate() {
  return sql`length(cast(${PartTable.data} as blob)) >= ${SQL_CANDIDATE_MIN_BYTES}
    and (
      (
        json_extract(${PartTable.data}, '$.type') = 'tool'
        and json_extract(${PartTable.data}, '$.state.status') = 'completed'
        and (
          length(json_extract(${PartTable.data}, '$.state.output')) > 0
          or exists (
            select 1 from json_each(${PartTable.data}, '$.state.attachments') as attachment
            where substr(json_extract(attachment.value, '$.url'), 1, 5) = 'data:'
          )
        )
      )
      or (
        json_extract(${PartTable.data}, '$.type') = 'reasoning'
        and length(json_extract(${PartTable.data}, '$.text')) > 0
      )
      or (
        json_extract(${PartTable.data}, '$.type') = 'file'
        and substr(json_extract(${PartTable.data}, '$.url'), 1, 5) = 'data:'
      )
    )`
}

// isEligibleOwner 供 status/test 复用唯一 eligibility owner，避免 CLI 或测试复制 age/compact 四象限。
// 它先做 extraction 和 exact 门槛，再查询 session boundary，保持大多数非候选 row 的低成本。
// 该函数只读且不压缩；true 仅表示此刻可冻，真正 freeze 会在 immediate transaction 内再次确认。
export function isEligibleOwner(input: Owner & { now?: number; olderThanMs?: number }) {
  return Database.use((db) => {
    const now = input.now ?? Date.now()
    const olderThanMs = input.olderThanMs ?? THIRTY_DAYS_MS
    if (input.type === "message") {
      const row = db.select().from(MessageTable).where(eq(MessageTable.id, input.id)).get()
      if (!row || row.cold_ref) return false
      const value = extractMessage(row.data)
      if (!value || value.raw.byteLength < MIN_ENVELOPE_BYTES) return false
      return eligible(eligibility(db, row.session_id, now, olderThanMs), row.id)
    }
    const row = db.select().from(PartTable).where(eq(PartTable.id, input.id)).get()
    if (!row || row.cold_ref) return false
    const value = extractPart(row.data)
    if (!value || value.raw.byteLength < MIN_ENVELOPE_BYTES) return false
    return eligible(eligibility(db, row.session_id, now, olderThanMs), row.message_id)
  })
}

// verifyWith 把 owner 引用一次性 GROUP BY 反算，并逐 payload 校验 codec、size、hash 与 canonical envelope。
// repair 只修正可证明的 ref_count，不伪造 missing/corrupt payload，也不清除任何 owner cold_ref。
// report 同时记录 checked owner/payload，使空库成功与未执行扫描在用户输出中可区分。
// 所有 repair 写入位于 immediate transaction；只读 verify 不获取 maintenance lease 或改变数据库。
function verifyWith(db: TxOrDb, repair: boolean): VerifyReport {
  const payloads = db.select().from(ColdStorageTable).all()
  const counts = ownerCounts(
    db,
    payloads.map((row) => row.hash),
  )
  const refs = [
    ...db.select({ hash: MessageTable.cold_ref }).from(MessageTable).where(isNotNull(MessageTable.cold_ref)).all(),
    ...db.select({ hash: PartTable.cold_ref }).from(PartTable).where(isNotNull(PartTable.cold_ref)).all(),
  ]
  const hashes = new Set(payloads.map((row) => row.hash))
  const missingPayloads = refs.filter((row) => row.hash !== null && !hashes.has(row.hash)).length
  let refCountMismatches = 0
  let corruptPayloads = 0
  let repaired = 0
  for (const payload of payloads) {
    const actual = counts.get(payload.hash) ?? 0
    if (payload.ref_count !== actual) {
      refCountMismatches++
      if (repair) {
        db.update(ColdStorageTable)
          .set({ ref_count: actual, time_updated: Date.now() })
          .where(eq(ColdStorageTable.hash, payload.hash))
          .run()
        repaired++
      }
    }
    try {
      decode(db, payload.hash, payload.kind)
    } catch {
      corruptPayloads++
    }
  }
  return {
    checkedOwners: refs.length,
    checkedPayloads: payloads.length,
    refCountMismatches,
    missingPayloads,
    corruptPayloads,
    repaired,
  }
}

// verify 的 repair flag 决定事务写权限，调用层不能用“verify 后另行 update”复制修复 SQL。
// corruption 计入 report 而非在首个坏 blob 终止，便于用户一次看到完整损坏范围。
// normal delete/fork/thaw 仍 hard-fail；宽容扫描只属于显式维护诊断命令。
export function verify(input: { repair: boolean }) {
  if (!input.repair) return Database.use((db) => verifyWith(db, false))
  return Database.transaction((db) => verifyWith(db, true), { behavior: "immediate" })
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
      return { expanded: messages.length + parts.length }
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

function initialCursor(request: MaintenanceRequest): MaintenanceCursor | undefined {
  if (request.operation === "compress" || request.operation === "expand") return { owner: "message", lastID: "" }
  if (request.operation === "verify" || request.operation === "cleanup") return { stage: "payload", lastHash: "" }
}

// prepareMaintenance 是 daemon 与 offline CLI 的共同 normalization/dispatch owner，调用层只能传 request。
// compress/expand/repair/delete 产生持久 task；status/只读 verify/preview/vacuum 保持 immediate 合同。
// task 保存完整规范化 args，resume 必须原样使用，禁止同一 taskID 在恢复时改 scope 或 batchSize。
// queued record 在任何数据库写入前生成，使 CLI 断线和 daemon crash 都有可查询的控制面事实。
// batchSize、age 和 expand scope 在这里拒绝非法值，maintenance loop 不再处理模糊 argv/default。
export function prepareMaintenance(request: MaintenanceRequest): PreparedMaintenance {
  validateMaintenanceRequest(request)
  const taskBacked =
    request.operation === "compress" ||
    request.operation === "expand" ||
    (request.operation === "verify" && request.repair) ||
    (request.operation === "cleanup" && request.delete)
  if (!taskBacked) return { type: "immediate", request }

  const now = Date.now()
  return {
    type: "task",
    request,
    task: {
      version: 1,
      taskID: `dbm_${randomUUID()}`,
      dbPath: Database.getPath(),
      operation: request.operation,
      args: request,
      status: "queued",
      cursor: initialCursor(request),
      processed: 0,
      skipped: 0,
      failed: 0,
      rawBytes: 0,
      compressedBytes: 0,
      createdAt: now,
      updatedAt: now,
    },
  }
}

function validateMaintenanceRequest(request: MaintenanceRequest) {
  // 该校验同时服务新 task 与持久 task 恢复；resume 不能因重新解析默认值而接受当初不合法的参数。
  // 它只验证跨 operation 共用的数值/scope invariant，task-backed 分类仍由 prepareMaintenance 唯一拥有。
  if (
    "batchSize" in request &&
    (!Number.isSafeInteger(request.batchSize) || request.batchSize <= 0 || request.batchSize > MAX_BATCH_SIZE)
  ) {
    // CASE/inArray 会为每个 owner 生成多个 SQLite 参数；5000 保持低于跨平台变量上限并约束单事务 WAL 体积。
    // 上限属于后端 normalization invariant，CLI flag 和 daemon JSON 不能各自选择不同的危险批量。
    throw new ValidationError({ message: `Maintenance batchSize must be an integer between 1 and ${MAX_BATCH_SIZE}` })
  }
  if (request.operation === "compress" && (!Number.isFinite(request.olderThanMs) || request.olderThanMs < 0)) {
    throw new ValidationError({ message: "compress olderThanMs must be non-negative" })
  }
  if (request.operation === "expand" && !request.all && !request.sessionID) {
    throw new ValidationError({ message: "Expand requires an explicit session or all=true" })
  }
}

// parseMaintenanceRequest 只接受私有 control JSON 的白名单字段，不把任意对象直接持久化为 task args。
// 缺省 batchSize 使用实测 2000；CLI 与 daemon 共享该值，避免两种运行域产生不同性能语义。
// session ID 通过品牌 schema 构造，格式错误在进入 SQL 前成为 typed validation failure。
// 布尔确认必须严格等于 true，字符串 "true" 不能绕过 expand/cleanup/vacuum 的显式用户意图。
export function parseMaintenanceRequest(input: unknown): MaintenanceRequest {
  if (!isRecord(input) || typeof input.operation !== "string") {
    throw new ValidationError({ message: "Maintenance request must contain an operation" })
  }
  const sessionID = maintenanceSessionID(input.sessionID)
  // 2.2 GB 本机快照上 2000-owner 批次全量完成约 4.3 分钟；更小默认值会让
  // SQLite transaction/checkpoint 固定成本重新主导，而该规模仍低于变量上限。
  const batchSize = input.batchSize === undefined ? DEFAULT_BATCH_SIZE : Number(input.batchSize)
  switch (input.operation) {
    case "compress":
      return {
        operation: "compress",
        ...(sessionID ? { sessionID } : {}),
        olderThanMs: input.olderThanMs === undefined ? THIRTY_DAYS_MS : Number(input.olderThanMs),
        batchSize,
      }
    case "expand":
      return { operation: "expand", ...(sessionID ? { sessionID } : {}), all: input.all === true, batchSize }
    case "status":
      return { operation: "status" }
    case "verify":
      return { operation: "verify", repair: input.repair === true, batchSize }
    case "cleanup":
      return { operation: "cleanup", delete: input.delete === true, batchSize }
    case "vacuum":
      return { operation: "vacuum", confirm: input.confirm === true }
    default:
      throw new ValidationError({ message: `Unknown maintenance operation: ${input.operation}` })
  }
}

function maintenanceSessionID(value: unknown) {
  // session scope 进入 SQL 前必须通过品牌 Schema；任意字符串品牌化会让损坏 task 改写扫描范围。
  // undefined 保留全库 operation 语义，空串或错误前缀不能被解释成“未指定”。
  if (value === undefined) return
  if (!Schema.is(SessionIDSchema)(value)) throw new ValidationError({ message: "Maintenance sessionID is invalid" })
  return value
}

function taskCounter(input: Record<string, unknown>, field: string) {
  // counter 会在 resume 后继续累加，必须是安全非负整数；Number coercion 会让损坏字符串悄悄改变进度。
  // bytes/timestamp 与 processed 共用该边界，持久 record 不允许 NaN、Infinity 或超安全整数。
  const value = input[field]
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new ValidationError({ message: `Maintenance task ${field} must be a non-negative safe integer` })
  }
  return value
}

function taskCursor(input: unknown, operation: MaintenanceTask["operation"]): MaintenanceCursor {
  // cursor 是已提交批次的恢复锚点，缺失时不能默认从头运行并重复 refcount 写入。
  // operation 决定唯一 cursor family，验证后 maintain 无需再解释任意 JSON shape。
  if (!isRecord(input)) throw new ValidationError({ message: "Maintenance task cursor is missing" })
  if (operation === "compress" || operation === "expand") {
    if ((input.owner !== "message" && input.owner !== "part") || typeof input.lastID !== "string") {
      throw new ValidationError({ message: "Maintenance task owner cursor is invalid" })
    }
    if (
      input.lastID &&
      ((input.owner === "message" && !Schema.is(MessageID)(input.lastID)) ||
        (input.owner === "part" && !Schema.is(PartID)(input.lastID)))
    ) {
      throw new ValidationError({ message: "Maintenance task owner cursor ID is invalid" })
    }
    return { owner: input.owner, lastID: input.lastID }
  }
  if (input.stage !== "payload" || typeof input.lastHash !== "string") {
    throw new ValidationError({ message: "Maintenance task payload cursor is invalid" })
  }
  if (input.lastHash && !/^[0-9a-f]{64}$/.test(input.lastHash)) {
    throw new ValidationError({ message: "Maintenance task payload cursor hash is invalid" })
  }
  return { stage: "payload", lastHash: input.lastHash }
}

// task record 是跨进程信任边界：JSON 可解析不代表 cursor、counter、operation 与 args 彼此一致。
// parser 重建白名单对象并拒绝 immediate request，损坏文件不能通过类型强转进入 resume SQL。
// args 仍复用 control request parser，但持久批次/年龄字段额外要求原生 number，避免字符串默认值改变历史任务。
// cursor 形状由 operation 决定；owner 与 payload 两种 cursor 不能在恢复时互换或被默认为起点。
export function parseMaintenanceTask(input: unknown): MaintenanceTask {
  if (!isRecord(input) || input.version !== 1) {
    throw new ValidationError({ message: "Maintenance task record must use version 1" })
  }
  if (
    typeof input.taskID !== "string" ||
    input.taskID.length > 128 ||
    !/^dbm_[A-Za-z0-9_-]+$/.test(input.taskID) ||
    typeof input.dbPath !== "string" ||
    input.dbPath.length === 0
  ) {
    throw new ValidationError({ message: "Maintenance task identity is invalid" })
  }
  if (!isRecord(input.args) || input.args.operation !== input.operation) {
    throw new ValidationError({ message: "Maintenance task operation does not match args" })
  }
  const args = parseMaintenanceRequest(input.args)
  validateMaintenanceRequest(args)
  const taskBacked =
    args.operation === "compress" ||
    args.operation === "expand" ||
    (args.operation === "verify" && args.repair) ||
    (args.operation === "cleanup" && args.delete)
  if (!taskBacked) throw new ValidationError({ message: "Maintenance task contains an immediate operation" })
  if (
    ((args.operation === "compress" ||
      args.operation === "expand" ||
      args.operation === "verify" ||
      args.operation === "cleanup") &&
      typeof input.args.batchSize !== "number") ||
    (args.operation === "compress" && typeof input.args.olderThanMs !== "number")
  ) {
    throw new ValidationError({ message: "Maintenance task args are not normalized" })
  }
  if (
    input.status !== "queued" &&
    input.status !== "running" &&
    input.status !== "interrupted" &&
    input.status !== "completed" &&
    input.status !== "failed"
  ) {
    throw new ValidationError({ message: "Maintenance task status is invalid" })
  }
  if (input.error !== undefined && typeof input.error !== "string") {
    throw new ValidationError({ message: "Maintenance task error must be a string" })
  }
  const createdAt = taskCounter(input, "createdAt")
  const updatedAt = taskCounter(input, "updatedAt")
  return {
    version: 1,
    taskID: input.taskID,
    dbPath: input.dbPath,
    operation: args.operation,
    args,
    status: input.status,
    cursor: taskCursor(input.cursor, args.operation),
    processed: taskCounter(input, "processed"),
    skipped: taskCounter(input, "skipped"),
    failed: taskCounter(input, "failed"),
    rawBytes: taskCounter(input, "rawBytes"),
    compressedBytes: taskCounter(input, "compressedBytes"),
    createdAt,
    updatedAt,
    ...(input.error === undefined ? {} : { error: input.error }),
  }
}

// pageCount 只读取 SQLite pragma 并验证返回形状，vacuum report 不依赖 driver 的 unchecked row cast。
// 该指标表示物理 page 数，不冒充 payload logical bytes；两种收益在 CLI 输出中保持独立。
function pageCount() {
  const row: unknown = Database.Client().$client.query("PRAGMA page_count").get()
  return isRecord(row) && typeof row.page_count === "number" ? row.page_count : 0
}

// taskRequest 允许 resume 注入持久 task，但 operation 必须与本次 prepared request 一致。
// cursor、计数和原始 args 以持久 task 为准，新的随机 prepared task 只提供当前 schema/operation 验证。
function taskRequest(prepared: PreparedMaintenance, runtime: MaintenanceRuntime) {
  if (prepared.type !== "task") throw new ValidationError({ message: "Immediate maintenance cannot enter task runner" })
  const task = runtime.task ?? prepared.task
  if (task.operation !== prepared.task.operation) {
    throw new ValidationError({ message: "Maintenance task operation does not match prepared request" })
  }
  return { task, request: task.args }
}

// nextMessageRows 使用稳定 ID cursor 和 cold_ref 状态实现幂等恢复；已提交 owner 不会在 resume 中重复处理。
// compress 追加 SQL candidate 必要条件，expand 则只扫描 cold_ref 非空的真实 owner。
// session scope 进入同一 SQL，不能先全库读取后在 JS 过滤导致无意义数据搬运。
function nextMessageRows(
  db: TxOrDb,
  request: { sessionID?: SessionID },
  lastID: string,
  cold: boolean,
  batchSize: number,
) {
  const conditions: SQL[] = [cold ? isNotNull(MessageTable.cold_ref) : isNull(MessageTable.cold_ref)]
  if (!cold) conditions.push(messageCandidate())
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
  const conditions: SQL[] = [cold ? isNotNull(PartTable.cold_ref) : isNull(PartTable.cold_ref)]
  if (!cold) conditions.push(partCandidate())
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

// maintain 是 operation dispatch、batch transaction、cursor advance、abort 与 terminal checkpoint 的唯一 owner。
// 每批先 assert lease，SQLite immediate transaction 提交后才更新 task record；checkpoint 失败可由 owner 状态幂等恢复。
// AbortSignal 只在批次边界观察，不中断正在写 WAL 的事务；下一 checkpoint 明确记录 interrupted 而非 failed。
// eligibility cache 以 Session.time_updated 失效，避免跨批复用已过期 boundary，同时消除大型 session 的重复 SQL。
// validated hash 只在当前 task 内缓存 immutable payload integrity，外部重启会重新验证，不信任内存跨进程状态。
// vacuum 是唯一 immediate write，必须同时有 confirm 与 lease；它不创建伪可恢复 cursor。
// task error 在 terminal checkpoint 后继续抛出，worker/CLI 只能序列化失败，禁止 catch-and-success fallback。
export async function maintain(
  prepared: PreparedMaintenance,
  runtime: MaintenanceRuntime = { checkpoint: async () => {} },
): Promise<MaintenanceResult> {
  if (prepared.type === "immediate") {
    if (prepared.request.operation === "status") return { type: "status", report: status() }
    if (prepared.request.operation === "verify") return { type: "verify", report: verify(prepared.request) }
    if (prepared.request.operation === "cleanup") return { type: "cleanup", report: cleanup(prepared.request) }
    if (prepared.request.operation !== "vacuum") {
      throw new ValidationError({ message: "vacuum requires confirm=true" })
    }
    if (!prepared.request.confirm) throw new ValidationError({ message: "vacuum requires confirm=true" })
    if (!runtime.lease) throw new ValidationError({ message: "vacuum requires a maintenance lease" })
    runtime.lease.assertOwned()
    const pagesBefore = pageCount()
    Database.Client().$client.run("VACUUM")
    return { type: "vacuum", pagesBefore, pagesAfter: pageCount() }
  }

  const preparedTask = taskRequest(prepared, runtime)
  const task = structuredClone(preparedTask.task)
  const request = preparedTask.request
  const eligibilityCache = new Map<SessionID, { updated: number; state: ReturnType<typeof eligibility> }>()
  const cachedEligibility = (db: TxOrDb, sessionID: SessionID, now: number, olderThanMs: number) => {
    const current = db
      .select({ updated: SessionTable.time_updated })
      .from(SessionTable)
      .where(eq(SessionTable.id, sessionID))
      .get()
    if (!current) return undefined
    const cached = eligibilityCache.get(sessionID)
    if (cached?.updated === current.updated) return cached.state
    const state = eligibility(db, sessionID, now, olderThanMs)
    eligibilityCache.set(sessionID, { updated: current.updated, state })
    return state
  }
  if (!runtime.lease) throw new ValidationError({ message: "task-backed maintenance requires a lease" })
  runtime.lease.assertOwned()
  const checkpoint = async () => {
    task.updatedAt = Date.now()
    await runtime.checkpoint(structuredClone(task))
  }

  task.status = "running"
  // resume 开始后旧 interrupted error 不再描述当前 attempt；新失败会在 catch 中重新持久化真实原因。
  delete task.error
  await checkpoint()

  try {
    let done = false
    while (!done) {
      runtime.lease.assertOwned()
      if (runtime.signal?.aborted) {
        task.status = "interrupted"
        await checkpoint()
        return { type: "task", task }
      }

      if (request.operation === "compress" || request.operation === "expand") {
        const cold = request.operation === "expand"
        const olderThanMs = request.operation === "compress" ? request.olderThanMs : 0
        const cursor = task.cursor
        if (!cursor || !("owner" in cursor)) throw new ValidationError({ message: "Invalid owner maintenance cursor" })
        if (cursor.owner === "message") {
          const outcome = Database.transaction(
            (db) => {
              const rows = cold
                ? nextMessageRows(db, request, cursor.lastID, true, request.batchSize)
                : nextMessageRows(db, request, cursor.lastID, false, request.batchSize)
              if (rows.length === 0) return { empty: true as const }
              const now = Date.now()
              if (cold) thawMessageBatch(db, rows, now)
              const result = cold
                ? { skipped: 0, rawBytes: 0, compressedBytes: 0 }
                : freezeMessageBatch(db, rows, {
                    now,
                    olderThanMs,
                    eligibilityState: (sessionID) => cachedEligibility(db, sessionID, now, olderThanMs),
                  })
              return {
                empty: false as const,
                cursor: { owner: "message" as const, lastID: rows[rows.length - 1].id },
                processed: rows.length,
                skipped: result.skipped,
                rawBytes: result.rawBytes,
                compressedBytes: result.compressedBytes,
              }
            },
            { behavior: "immediate" },
          )
          if (outcome.empty) {
            task.cursor = { owner: "part", lastID: "" }
            await checkpoint()
            continue
          }
          task.cursor = outcome.cursor
          task.processed += outcome.processed
          task.skipped += outcome.skipped
          task.rawBytes += outcome.rawBytes
          task.compressedBytes += outcome.compressedBytes
        } else {
          const outcome = Database.transaction(
            (db) => {
              const rows = cold
                ? nextPartRows(db, request, cursor.lastID, true, request.batchSize)
                : nextPartRows(db, request, cursor.lastID, false, request.batchSize)
              if (rows.length === 0) return { empty: true as const }
              const now = Date.now()
              if (cold) thawPartBatch(db, rows, now)
              const result = cold
                ? { skipped: 0, rawBytes: 0, compressedBytes: 0 }
                : freezePartBatch(db, rows, {
                    now,
                    olderThanMs,
                    eligibilityState: (sessionID) => cachedEligibility(db, sessionID, now, olderThanMs),
                  })
              return {
                empty: false as const,
                cursor: { owner: "part" as const, lastID: rows[rows.length - 1].id },
                processed: rows.length,
                skipped: result.skipped,
                rawBytes: result.rawBytes,
                compressedBytes: result.compressedBytes,
              }
            },
            { behavior: "immediate" },
          )
          if (outcome.empty) done = true
          else {
            task.cursor = outcome.cursor
            task.processed += outcome.processed
            task.skipped += outcome.skipped
            task.rawBytes += outcome.rawBytes
            task.compressedBytes += outcome.compressedBytes
          }
        }
      } else if (request.operation === "verify" || request.operation === "cleanup") {
        const cursor = task.cursor
        if (!cursor || !("stage" in cursor)) {
          throw new ValidationError({ message: "Invalid payload maintenance cursor" })
        }
        const outcome = Database.transaction(
          (db) => {
            const rows = db
              .select()
              .from(ColdStorageTable)
              .where(gt(ColdStorageTable.hash, cursor.lastHash))
              .orderBy(ColdStorageTable.hash)
              .limit(request.batchSize)
              .all()
            if (rows.length === 0) return { empty: true as const }
            let skipped = 0
            let failed = 0
            let bytes = 0
            for (const row of rows) {
              const owners = ownerCount(db, row.hash)
              if (request.operation === "verify") {
                if (owners !== row.ref_count && request.repair) {
                  db.update(ColdStorageTable)
                    .set({ ref_count: owners, time_updated: Date.now() })
                    .where(eq(ColdStorageTable.hash, row.hash))
                    .run()
                } else if (owners === row.ref_count) skipped++
                try {
                  decode(db, row.hash, row.kind)
                } catch {
                  failed++
                }
              } else if (owners === 0 && request.delete) {
                db.delete(ColdStorageTable).where(eq(ColdStorageTable.hash, row.hash)).run()
                bytes += row.compressed_bytes
              } else skipped++
            }
            return {
              empty: false as const,
              cursor: { stage: "payload" as const, lastHash: rows[rows.length - 1].hash },
              processed: rows.length,
              skipped,
              failed,
              bytes,
            }
          },
          { behavior: "immediate" },
        )
        if (outcome.empty) done = true
        else {
          task.cursor = outcome.cursor
          task.processed += outcome.processed
          task.skipped += outcome.skipped
          task.failed += outcome.failed
          task.compressedBytes += outcome.bytes
        }
      } else {
        throw new ValidationError({ message: `Unsupported task operation: ${request.operation}` })
      }

      await checkpoint()
    }
    task.status = "completed"
    await checkpoint()
    return { type: "task", task }
  } catch (error) {
    task.status = runtime.signal?.aborted ? "interrupted" : "failed"
    task.error = String(error)
    await checkpoint()
    throw error
  }
}

// status 汇总 logical raw、unique compressed、共享 bytes 与真实 refcount mismatch，不触发 thaw 或 owner rewrite。
// eligibleOwners 复用 SQL candidate+唯一 eligibility 判定，报告的是当前可冻 owner 而非所有 hot rows。
// rawBytes 按 ref_count 展开，compressedBytes 按 unique payload 统计，两者差额不能直接当物理文件收益。
// orphans 由两个 owner 表反算为零，ref_count 列即使错误也不会掩盖 cleanup 候选。
export function status(): StatusReport {
  return Database.use((db) => {
    const payloads = db.select().from(ColdStorageTable).all()
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
    // logical raw 使用 owner 反算数；当 persisted ref_count 损坏时，status 仍给出真实共享量并单独报告 mismatch。
    // orphan payload 计入物理 compressedBytes，但不参与 referencedRaw/sharedBytes，避免无 owner blob 扭曲去重收益。
    // verify/cleanup 才拥有修复或删除权限，status 的真实计数不能顺带改写 persisted ref_count。
    const rawBytes = payloads.reduce((total, row) => total + row.raw_bytes * (counts.get(row.hash) ?? 0), 0)
    const compressedBytes = payloads.reduce((total, row) => total + row.compressed_bytes, 0)
    const referencedRawBytes = payloads.reduce(
      (total, row) => total + ((counts.get(row.hash) ?? 0) > 0 ? row.raw_bytes : 0),
      0,
    )
    const refCountMismatches = payloads.filter((row) => row.ref_count !== (counts.get(row.hash) ?? 0)).length
    const orphans = payloads.filter((row) => (counts.get(row.hash) ?? 0) === 0).length
    return {
      eligibleOwners: eligibleOwnerCount(db, Date.now(), THIRTY_DAYS_MS),
      coldOwners,
      payloads: payloads.length,
      rawBytes,
      compressedBytes,
      sharedBytes: Math.max(0, rawBytes - referencedRawBytes),
      refCountMismatches,
      orphans,
    }
  })
}

export * as ColdStorage from "./cold"
