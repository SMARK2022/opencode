import { createHash, randomUUID } from "node:crypto"
import {
  constants as zlibConstants,
  zstdCompressSync as nodeZstdCompressSync,
  zstdDecompressSync as nodeZstdDecompressSync,
} from "node:zlib"
import { Schema } from "effect"
import { and, desc, eq, gt, inArray, isNotNull, isNull, or, sql, type SQL } from "drizzle-orm"
import { Database, type TxOrDb } from "./db"
import { ColdStorageTable, MessageTable, PartTable, SessionTable, type PartColdStats } from "@/session/session.sql"
import { MessageID, PartID, SessionID as SessionIDSchema, type SessionID } from "@/session/schema"
import { CompactionBoundary } from "@/session/compaction-boundary"
import { Snapshot } from "@/snapshot"
import type { MessageV2 } from "@/session/message-v2"

// root 7 天 session.time_updated、subagent 24 小时 last message、completed compact head 三者 OR；任一成立即可进冷存储。
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000
// subagent 固定 24h last-message 阈值；CLI olderThanMs 只调 root，不覆盖该常量。
const SUBAGENT_IDLE_MS = 24 * 60 * 60 * 1000
// 1 MiB 是普通 pack 的目标而非硬上限；单个超大 entry 必须独立保留完整信息而不能截断。
const PACK_TARGET_BYTES = 1024 * 1024
export const DEFAULT_BATCH_SIZE = 2000
const MAX_BATCH_SIZE = 5000
const isDiffsSchema = Schema.is(Schema.Array(Snapshot.FileDiff))
const isMessageID = Schema.is(MessageID)

// 本模块是 archive payload、owner pointer、codec、refcount 与可逆恢复的唯一语义 owner。
// 前端只能请求业务 Message/Part；是否持久预热由这里和 MessageV2 hydration seam 决定。
function isDiffs(value: unknown): value is readonly Schema.Schema.Type<typeof Snapshot.FileDiff>[] {
  return isDiffsSchema(value)
}

// 空字符串是无 closed Message 的合法 claimed cursor；其他值必须是仓库 MessageID。
function isSummaryCursor(value: unknown): value is string {
  return value === "" || isMessageID(value)
}

function isSummarySeed(value: unknown): value is { cursor: string; diffs: SummaryDiffs } {
  // hot seed 与压缩 payload 共用同一 cursor/FileDiff 边界，verify 不能只信 Drizzle 静态类型。
  return isRecord(value) && isSummaryCursor(value.cursor) && isDiffs(value.diffs)
}

type Owner = { type: "message"; id: MessageID } | { type: "part"; id: PartID }
// hot owner 以 NULL ref/key 表示，v1 owner 只有 ref，v2 owner 同时持有 ref 与 32-byte key。
type OwnerKind = Owner["type"]
type PackKind = "message-pack" | "part-pack"
// 三种持久状态唯一选择 decoder，读取失败后绝不尝试另一格式制造备用成功路径。
type StorageKind = OwnerKind | PackKind | "session-summary"
type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
// payload hash 覆盖 canonical raw bytes 而非 zstd frame，跨平台压缩差异不会改变内容身份。
type Envelope = { version: 1; owner: OwnerKind; fields: Record<string, Json> }
type PackEntry = { key: Buffer; fields: Record<string, Json> }
type PackEnvelope = { version: 2; owner: OwnerKind; entries: PackEntry[] }
type MessageData<T extends MessageV2.Info = MessageV2.Info> = T extends unknown ? Omit<T, "id" | "sessionID"> : never
type PartData<T extends MessageV2.Part = MessageV2.Part> = T extends unknown
  ? Omit<T, "id" | "sessionID" | "messageID">
  : never

type SummaryDiffs = Schema.Schema.Type<typeof Snapshot.FileDiff>[]
// ref_count 是共享 fork 和去重生命周期的 DB 权威，不能用进程内 cache 数量推测真实 owner。
export type SummaryPayload = {
  seed?: { cursor: string; diffs: SummaryDiffs }
  delta: SummaryDiffs
}

function isSummaryPayload(value: unknown): value is SummaryPayload {
  if (!isRecord(value) || !isDiffs(value.delta)) return false
  if (value.seed === undefined) return true
  return isSummarySeed(value.seed)
}

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

// MaintenanceRequest 是 daemon control 和 offline CLI 唯一共享的行为联合，operation 决定合法参数。
// confirm/repair/delete 使用显式 boolean，避免模糊 flag 在后端被解释为写授权。
export type MaintenanceRequest =
  | { operation: "compress"; sessionID?: SessionID; olderThanMs: number; batchSize: number }
  | { operation: "expand"; sessionID?: SessionID; all: boolean; batchSize: number }
  | { operation: "status" }
  | { operation: "verify"; repair: boolean; repairToolInput?: boolean; batchSize: number }
  | { operation: "cleanup"; delete: boolean; batchSize: number }
  | { operation: "vacuum"; confirm: boolean }

// owner cursor 按 Message 后 Part 推进，payload cursor 按 hash 推进；两者不能在 resume 中互换。
// cursor 只是跳过已提交批次的性能状态，真正幂等事实仍是 owner cold_ref 与 payload refcount。
export type MaintenanceCursor =
  | { owner: "message" | "part" | "session-summary"; lastID: string }
  | { stage: "payload"; lastHash: string }

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
function digest(owner: StorageKind, raw: Uint8Array) {
  // owner prefix 防止相同 JSON 值在 Message/Part 两种恢复语义之间错误共享。
  // NUL 是不可能出现在固定 owner 名中的稳定分隔符，hash 输入因此没有拼接歧义。
  return createHash("sha256")
    .update(owner)
    .update(Buffer.from([0]))
    .update(raw)
    .digest("hex")
}

function packKind(owner: OwnerKind): PackKind {
  return owner === "message" ? "message-pack" : "part-pack"
}

// entry key 只覆盖 owner kind 与冷字段，pack hash 则覆盖整个排序后的 entries；两层地址分别服务去重和批量读取。
// binary key 固定 32 bytes，避免 SQLite text 编码/大小写差异改变同一 entry 的身份。
function entryKey(owner: OwnerKind, fields: Record<string, Json>) {
  // fields 已由 jsonObject 递归验证并排序；这里直接编码，避免每个 owner 再完整遍历一次大 metadata/output。
  const raw = Buffer.from(JSON.stringify(fields))
  return Buffer.from(digest(owner, raw), "hex")
}

// pack 内同 key 只保存一份 fields；多个 owner 仍各自持有 cold_ref/ref_count，展开时按 owner 数递减。
// entries 按 binary key 排序而非插入顺序，跨批次、Windows/Linux 和 fork 都能得到同一 pack hash。
function packEnvelope(owner: OwnerKind, entries: PackEntry[]) {
  const unique = new Map<string, PackEntry>()
  for (const entry of entries) {
    const key = entry.key.toString("hex")
    const previous = unique.get(key)
    if (previous && JSON.stringify(previous.fields) !== JSON.stringify(entry.fields)) {
      throw new CorruptionError({ message: "Pack entry key collides with different fields", hash: key })
    }
    unique.set(key, { key: Buffer.from(entry.key), fields: entry.fields })
  }
  const values = [...unique.values()].sort((a, b) => Buffer.compare(a.key, b.key))
  const value = {
    version: 2 as const,
    owner,
    entries: values.map((entry) => ({ key: entry.key.toString("hex"), fields: entry.fields })),
  }
  const raw = Buffer.from(canonical(value))
  return { value, raw, hash: digest(packKind(owner), raw), entries: values }
}

function parsePackEnvelope(owner: OwnerKind, raw: Uint8Array, hash: string): PackEnvelope {
  let value: unknown
  try {
    value = JSON.parse(Buffer.from(raw).toString("utf8"))
  } catch (cause) {
    throw new CorruptionError({ message: `Cold pack is not JSON: ${String(cause)}`, hash })
  }
  if (!isRecord(value) || value.version !== 2 || value.owner !== owner || !Array.isArray(value.entries)) {
    throw new CorruptionError({ message: "Cold pack envelope does not match its owner", hash })
  }
  const entries = value.entries.map((item) => {
    if (!isRecord(item) || typeof item.key !== "string" || !/^[0-9a-f]{64}$/.test(item.key) || !isRecord(item.fields)) {
      throw new CorruptionError({ message: "Cold pack entry is invalid", hash })
    }
    const fields = jsonObject(item.fields)
    const key = Buffer.from(item.key, "hex")
    if (!key.equals(entryKey(owner, fields))) {
      throw new CorruptionError({ message: "Cold pack entry key does not match fields", hash })
    }
    return { key, fields }
  })
  for (let index = 1; index < entries.length; index++) {
    const previous = entries[index - 1]
    const current = entries[index]
    if (!previous || !current || Buffer.compare(previous.key, current.key) >= 0) {
      throw new CorruptionError({ message: "Cold pack entries are not uniquely key-sorted", hash })
    }
  }
  const parsed: PackEnvelope = { version: 2, owner, entries }
  const canonicalValue = {
    version: 2 as const,
    owner,
    entries: entries.map((entry) => ({ key: entry.key.toString("hex"), fields: entry.fields })),
  }
  if (!Buffer.from(canonical(canonicalValue)).equals(Buffer.from(raw))) {
    throw new CorruptionError({ message: "Cold pack is not canonical JSON", hash })
  }
  return parsed
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

// Session summary 使用独立 version/owner，防止 aggregate FileDiff 被当成 Message 的 summary.diffs 字段恢复。
// 一个 Session ref 直接选择完整 aggregate，不需要 entry key；仍复用相同 canonical/hash/zstd integrity gate。
function summaryEnvelope(payload: SummaryPayload) {
  if (!isSummaryPayload(payload)) throw new CorruptionError({ message: "Session summary payload fails schema validation" })
  const fields = payload.seed
    ? { seed: { cursor: payload.seed.cursor, diffs: payload.seed.diffs }, delta: payload.delta }
    : { delta: payload.delta }
  const value = { version: 2 as const, owner: "session-summary" as const, fields }
  const raw = Buffer.from(canonical(value))
  return { value, raw, hash: digest("session-summary", raw) }
}

function parseSummaryEnvelope(raw: Uint8Array, hash: string): SummaryPayload {
  let value: unknown
  try {
    value = JSON.parse(Buffer.from(raw).toString("utf8"))
  } catch (cause) {
    throw new CorruptionError({ message: `Session summary payload is not JSON: ${String(cause)}`, hash })
  }
  if (
    !isRecord(value) ||
    value.version !== 2 ||
    value.owner !== "session-summary" ||
    !isRecord(value.fields) ||
    !isSummaryPayload(value.fields)
  ) {
    throw new CorruptionError({ message: "Session summary payload envelope is invalid", hash })
  }
  const fields = value.fields.seed
    ? { seed: { cursor: value.fields.seed.cursor, diffs: value.fields.seed.diffs }, delta: value.fields.delta }
    : { delta: value.fields.delta }
  const parsed = { version: 2 as const, owner: "session-summary" as const, fields }
  if (!Buffer.from(canonical(parsed)).equals(Buffer.from(raw))) {
    throw new CorruptionError({ message: "Session summary payload is not canonical JSON", hash })
  }
  return {
    ...(parsed.fields.seed
      ? { seed: { cursor: parsed.fields.seed.cursor, diffs: Array.from(parsed.fields.seed.diffs) } }
      : {}),
    delta: Array.from(parsed.fields.delta),
  }
}

function extractMessage(data: (typeof MessageTable.$inferSelect)["data"]) {
  // ordinary Text 始终保持 hot 以支持精确搜索；Message 只允许归档 summary.diffs。
  const summary = data.role === "user" ? data.summary : undefined
  if (!summary) return
  if (!isDiffs(summary.diffs)) throw new CorruptionError({ message: "Stored message diffs fail schema validation" })
  if (summary.diffs.length === 0) return
  const projection = structuredClone(data)
  if (projection.role !== "user" || !projection.summary) {
    throw new CorruptionError({ message: "User message summary disappeared during freeze" })
  }
  const projectionSummary = projection.summary
  const fields = jsonObject({ "summary.diffs": summary.diffs })
  projectionSummary.diffs = []
  return { projection, fields }
}

// v2 Message extraction 复用已验证的 projection/字段白名单，但取消 owner-level 4 KiB 门槛。
// entry key 只由 summary.diffs 生成；同一 diff 可在不同 Session 的 pack 中安全复用 entry 身份。
function extractMessageV2(data: (typeof MessageTable.$inferSelect)["data"]) {
  const value = extractMessage(data)
  if (!value) return
  return { projection: value.projection, key: entryKey("message", value.fields), fields: value.fields }
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

function storedRecord(value: unknown, message: string) {
  if (isRecord(value)) return value
  throw new CorruptionError({ message })
}

function storedJson(value: unknown, message: string) {
  if (value === undefined) throw new CorruptionError({ message })
  try {
    return json(value)
  } catch (cause) {
    throw new CorruptionError({ message: `${message}: ${String(cause)}` })
  }
}

const emptyPartComponents = (): Extract<PartColdStats, { type: "step-finish" }>["components"] => ({
  system: 0,
  instructions: 0,
  skills: 0,
  toolSchemas: 0,
  userMessages: 0,
  assistantText: 0,
  reasoning: 0,
  toolCalls: 0,
  toolResults: 0,
  attachments: 0,
})

const finiteStat = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0)

// Step projection 复用 Stats 已发布的字符到 token 分摊公式；只有这个 owner 可以解释持久 inputBreakdown。
// 旧记录可能缺少 messages 子字段，因此缺项按既有统计口径计零，而不是让一次全库统计失败。
// media token 单独归入 attachment，剩余文本 token 才按字符比例分摊，十项之和因而与热路径一致。
function stepComponents(data: Extract<(typeof PartTable.$inferSelect)["data"], { type: "step-finish" }>) {
  const inputChars = finiteStat(data.inputChars)
  if (data.inputBreakdown === undefined || data.inputBreakdown === null || inputChars <= 0) return emptyPartComponents()
  // 早期版本没有在读取 Step 时重跑完整 Schema；非 object 子结构与缺失字段同样按零计入。
  // 这里保持旧 Stats 的可选访问语义，不能因增加存储投影而收紧用户历史数据库的可读域。
  const breakdown = isRecord(data.inputBreakdown) ? data.inputBreakdown : {}
  const messages = isRecord(breakdown.messages) ? breakdown.messages : undefined
  const media = isRecord(breakdown.media) ? breakdown.media : undefined
  const inputTokens = finiteStat(data.tokens.input) + finiteStat(data.tokens.cache.read) + finiteStat(data.tokens.cache.write)
  const attachmentTokens = typeof media?.tokens === "number" && Number.isFinite(media.tokens) ? media.tokens : undefined
  const textTokens = attachmentTokens === undefined ? inputTokens : Math.max(0, inputTokens - attachmentTokens)
  const textChars = media
    ? Math.max(1, inputChars - finiteStat(media.rawChars) + finiteStat(media.textChars))
    : inputChars
  const alloc = (value: unknown) => Math.round((finiteStat(value) / textChars) * textTokens)
  return {
    system: alloc(breakdown.system),
    instructions: alloc(breakdown.instructions),
    skills: alloc(breakdown.skills),
    toolSchemas: alloc(breakdown.tools),
    userMessages: alloc(messages?.userText),
    assistantText: alloc(messages?.assistantText),
    reasoning: alloc(messages?.reasoning),
    toolCalls: alloc(messages?.toolInput),
    toolResults: alloc(messages?.toolOutput),
    attachments: attachmentTokens ?? alloc(messages?.attachments),
  }
}

// projector 是 hot Stats、freeze writer、v1 inspect 与 verify 共用的唯一标量权威。
// 它不读取 DB 或 payload，因此四条路径能复用同一公式而不触发 thaw。
export function projectPartStats(data: (typeof PartTable.$inferSelect)["data"]): PartColdStats | null {
  if (data.type === "tool") {
    // 字符数必须在完整 Tool 字段被抽走前计算，不能从 skeleton 反推原始长度。
    // inputChars 沿用公开 JSON.stringify 口径；字符数不是 UTF-8 bytes 或 provider token。
    const inputChars = data.state.status === "pending"
      ? data.state.raw.length
      : JSON.stringify(storedRecord(data.state.input, "Stored tool input is invalid")).length
    // completed output 包含 attachment URL；error 只计 error，未完成状态不猜测稳定输出。
    const outputChars = data.state.status === "completed"
      ? storedString(data.state.output, "Stored tool output is invalid").length +
        (data.state.attachments ?? []).reduce(
          (sum, item) => sum + storedString(item.url, "Stored tool attachment URL is invalid").length,
          0,
        )
      : data.state.status === "error"
        ? storedString(data.state.error, "Stored tool error is invalid").length
        : 0
    // Tool name/status/time 保持在主表，投影禁止复制这些 hot 字段形成双权威。
    // 固定字段顺序使投影 JSON 和跨平台 state hash 可复现。
    return { version: 1, type: "tool", inputChars, outputChars }
  }
  if (data.type === "step-finish") {
    // Step 在完整 breakdown 清除前固化十项 token，Stats 不必恢复 prompt body。
    return { version: 1, type: "step-finish", components: stepComponents(data) }
  }
  // 非 Stats Part 返回 NULL，cold_stats 不能演变成第二份任意业务 payload。
  // 完整 Tool/Step 数据仍由 pack 承担唯一恢复责任，投影只保存公开统计标量。
  return null
}

function exactKeys(value: Record<string, unknown>, keys: string[]) {
  return Object.keys(value).toSorted(compareCodePoints).join("\0") === keys.toSorted(compareCodePoints).join("\0")
}

function statInteger(value: unknown, message: string, hash?: string) {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value
  throw new CorruptionError({ message, hash })
}

// v2 Stats 在投影损坏后不得解码 pack 兜底，必须独立验证 exact version/type/keys。
// 此 parser 同时服务 Stats 和 verify，维护命令不会采用更宽松的投影规则。
function parsePartStats(value: unknown, hash?: string): PartColdStats {
  // version 是格式演进边界，未知版本不能按相似字段结构猜测解释。
  if (!isRecord(value) || value.version !== 1 || typeof value.type !== "string") {
    throw new CorruptionError({ message: "Part cold Stats projection is invalid", hash })
  }
  // exactKeys 阻止扩展字段把 cold_stats 变成隐藏的第二业务 payload。
  if (value.type === "tool" && exactKeys(value, ["version", "type", "inputChars", "outputChars"])) {
    // 返回重建对象而非类型强转，外部 SQL 注入的额外属性不能越过持久边界。
    // 重建普通对象消除 prototype/属性访问器；safe integer 排除小数、NaN 和无限值。
    return {
      version: 1,
      type: "tool",
      inputChars: statInteger(value.inputChars, "Tool cold Stats inputChars is invalid", hash),
      outputChars: statInteger(value.outputChars, "Tool cold Stats outputChars is invalid", hash),
    }
  }
  if (
    value.type === "step-finish" &&
    exactKeys(value, ["version", "type", "components"]) &&
    isRecord(value.components) &&
    exactKeys(value.components, [
      "system",
      "instructions",
      "skills",
      "toolSchemas",
      "userMessages",
      "assistantText",
      "reasoning",
      "toolCalls",
      "toolResults",
      "attachments",
    ])
  ) {
    // Step 十项由 Math.round 或持久整数产生，小数表示 writer 与公开公式已经漂移。
    return {
      version: 1,
      type: "step-finish",
      components: {
        system: statInteger(value.components.system, "Step cold Stats system is invalid", hash),
        instructions: statInteger(value.components.instructions, "Step cold Stats instructions is invalid", hash),
        skills: statInteger(value.components.skills, "Step cold Stats skills is invalid", hash),
        toolSchemas: statInteger(value.components.toolSchemas, "Step cold Stats toolSchemas is invalid", hash),
        userMessages: statInteger(value.components.userMessages, "Step cold Stats userMessages is invalid", hash),
        assistantText: statInteger(value.components.assistantText, "Step cold Stats assistantText is invalid", hash),
        reasoning: statInteger(value.components.reasoning, "Step cold Stats reasoning is invalid", hash),
        toolCalls: statInteger(value.components.toolCalls, "Step cold Stats toolCalls is invalid", hash),
        toolResults: statInteger(value.components.toolResults, "Step cold Stats toolResults is invalid", hash),
        attachments: statInteger(value.components.attachments, "Step cold Stats attachments is invalid", hash),
      },
    }
  }
  // parser 只检查投影形状；与完整 payload 数值的一致性由显式 verify 集中证明。
  // 错误只附 payload hash 用于定位，不泄露完整 Tool 输入或输出。
  // missing/malformed 都是 corruption，不能 hydrate fallback 后顺带清除 refcount。
  throw new CorruptionError({ message: "Part cold Stats projection does not match a supported shape", hash })
}

function requirePartStats(
  row: Pick<typeof PartTable.$inferSelect, "cold_ref" | "cold_stats">,
  expected: PartColdStats | null,
) {
  if (expected === null) {
    if (row.cold_stats !== null) throw new CorruptionError({ message: "Non-Stats Part has a cold Stats projection", hash: row.cold_ref ?? undefined })
    return null
  }
  if (row.cold_stats === null) throw new CorruptionError({ message: "Stats Part is missing its cold projection", hash: row.cold_ref ?? undefined })
  const stored = parsePartStats(row.cold_stats, row.cold_ref ?? undefined)
  if (canonical(stored) !== canonical(expected)) {
    throw new CorruptionError({ message: "Part cold Stats projection does not match its payload", hash: row.cold_ref ?? undefined })
  }
  return stored
}

// extraction 先检查冷字段，再对真正候选 clone，避免扫描大型 Tool JSON 时无效深拷贝。
// fields 白名单是版本协议，新增路径必须同步 restore、tests 与 full audit。
function extractPart(data: (typeof PartTable.$inferSelect)["data"]) {
  const fields: Record<string, unknown> = {}

  // pending/running Tool 仍会被 processor 更新，只有 completed 状态具有完整稳定输出。
  if (data.type === "tool" && data.state.status === "completed") {
    // storedString/storedJson 在清空前验证源值，坏数据不能被压成看似合法的空 skeleton。
    // input/title/metadata 与 output 外移是主要物理收益，search 已明确不索引这些字段。
    fields["state.input"] = storedJson(data.state.input, "Stored completed tool input is invalid")
    fields["state.output"] = storedString(data.state.output, "Stored tool output is not a string")
    fields["state.title"] = storedString(data.state.title, "Stored completed tool title is not a string")
    fields["state.metadata"] = storedJson(data.state.metadata, "Stored completed tool metadata is invalid")
    if (data.metadata !== undefined) fields.metadata = storedJson(data.metadata, "Stored tool part metadata is invalid")
    // attachment 路径记录原索引，restore 必须回填同一槽位而不能重排数组。
    for (const [index, attachment] of data.state.attachments?.entries() ?? []) {
      const url = storedString(attachment.url, "Stored tool attachment URL is not a string")
      if (!isInlineData(url)) continue
      fields[`state.attachments.${index}.url`] = url
    }
  }
  // error Tool 同样保存 input/error/metadata，异常历史不能退化成不可逆 skeleton。
  if (data.type === "tool" && data.state.status === "error") {
    fields["state.input"] = storedJson(data.state.input, "Stored error tool input is invalid")
    fields["state.error"] = storedString(data.state.error, "Stored error tool error is not a string")
    if (data.state.metadata !== undefined) fields["state.metadata"] = storedJson(data.state.metadata, "Stored error tool metadata is invalid")
    if (data.metadata !== undefined) fields.metadata = storedJson(data.metadata, "Stored tool part metadata is invalid")
  }
  // reasoning 只抽 text；其余结构和可见身份仍留在主表。
  if (data.type === "reasoning") {
    // provider metadata 与 text 一起归档，完整回放不能只恢复正文而遗失伴随信息。
    fields.text = storedString(data.text, "Stored reasoning text is not a string")
    if (data.metadata !== undefined) fields.metadata = storedJson(data.metadata, "Stored reasoning metadata is invalid")
  }
  // 普通路径与 HTTP URL 保持 hot，只有 data URI 的 base64 body 可归档。
  if (data.type === "file") {
    const url = storedString(data.url, "Stored file URL is not a string")
    if (isInlineData(url)) fields.url = url
  }
  // Compaction memento 完成后只供完整历史回放，routine prompt 不读取该字段。
  if (data.type === "compaction" && data.recent_user_messages !== undefined) {
    fields.recent_user_messages = storedJson(data.recent_user_messages, "Stored compaction memento is invalid")
  }
  // Step snapshot/breakdown 是存档字段；tokens/cost/reason 保持 hot 服务 usage 与 Stats。
  if (data.type === "step-start") {
    if (data.snapshot !== undefined) fields.snapshot = storedJson(data.snapshot, "Stored step-start snapshot is invalid")
    if (data.inputChars !== undefined) fields.inputChars = storedJson(data.inputChars, "Stored step-start inputChars is invalid")
    if (data.inputTokens !== undefined) fields.inputTokens = storedJson(data.inputTokens, "Stored step-start inputTokens is invalid")
    if (data.inputBreakdown !== undefined) fields.inputBreakdown = storedJson(data.inputBreakdown, "Stored step-start breakdown is invalid")
  }
  if (data.type === "step-finish") {
    if (data.snapshot !== undefined) fields.snapshot = storedJson(data.snapshot, "Stored step-finish snapshot is invalid")
    if (data.inputChars !== undefined) fields.inputChars = storedJson(data.inputChars, "Stored step-finish inputChars is invalid")
    if (data.inputBreakdown !== undefined) fields.inputBreakdown = storedJson(data.inputBreakdown, "Stored step-finish breakdown is invalid")
  }
  if (Object.keys(fields).length === 0) return
  // hot row 的空字符串/对象仍是合法业务值，只有 cold_ref 才赋予 skeleton 语义。
  // clone 仅在确认有冷字段后发生，避免全表 eligibility 扫描扩大 GC 压力。
  const projection = structuredClone(data)
  if (projection.type === "tool" && projection.state.status === "completed") {
    // projection 只清已被 envelope 接管的路径，其他可见字段继续由主表承担权威。
    projection.state.input = {}
    projection.state.output = ""
    projection.state.title = ""
    projection.state.metadata = {}
    if ("metadata" in fields) projection.metadata = {}
    for (const field of Object.keys(fields)) {
      const match = /^state\.attachments\.(\d+)\.url$/.exec(field)
      if (match) {
        const attachment = projection.state.attachments?.[Number(match[1])]
        if (!attachment) throw new CorruptionError({ message: "Tool attachment disappeared during freeze" })
        attachment.url = ""
      }
    }
  }
  if (projection.type === "tool" && projection.state.status === "error") {
    projection.state.input = {}
    projection.state.error = ""
    if ("state.metadata" in fields) projection.state.metadata = {}
    if ("metadata" in fields) projection.metadata = {}
  }
  if (projection.type === "reasoning") {
    projection.text = ""
    if ("metadata" in fields) projection.metadata = {}
  }
  if (projection.type === "file" && "url" in fields) projection.url = ""
  if (projection.type === "compaction" && "recent_user_messages" in fields) delete projection.recent_user_messages
  if (projection.type === "step-start") {
    delete projection.snapshot
    delete projection.inputChars
    delete projection.inputTokens
    delete projection.inputBreakdown
  }
  if (projection.type === "step-finish") {
    delete projection.snapshot
    delete projection.inputChars
    delete projection.inputBreakdown
  }
  // 多个字段共用一个 envelope，使 owner update、refcount 与恢复保持同一原子边界。
  return { projection, fields: jsonObject(fields) }
}

// v2 Part extraction 先保持 R9 已上线字段白名单，后续 expanded-field slice 会只扩展此处和 restorePart 对称协议。
// 没有获准字段的结构 Part 仍保持 hot，避免把 marker/patch/usage 变成无意义 pack owner。
function extractPartV2(data: (typeof PartTable.$inferSelect)["data"]) {
  const value = extractPart(data)
  if (!value) return
  return { projection: value.projection, key: entryKey("part", value.fields), fields: value.fields }
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
    if (field === "state.input" && restored.type === "tool") {
      restored.state.input = storedRecord(fieldValue, "Tool input is not an object")
      continue
    }
    if (field === "state.output" && restored.type === "tool" && restored.state.status === "completed") {
      if (typeof fieldValue !== "string") throw new CorruptionError({ message: "Tool output is not a string", hash })
      restored.state.output = fieldValue
      continue
    }
    if (field === "state.title" && restored.type === "tool" && restored.state.status === "completed") {
      if (typeof fieldValue !== "string") throw new CorruptionError({ message: "Tool title is not a string", hash })
      restored.state.title = fieldValue
      continue
    }
    if (field === "state.error" && restored.type === "tool" && restored.state.status === "error") {
      if (typeof fieldValue !== "string") throw new CorruptionError({ message: "Tool error is not a string", hash })
      restored.state.error = fieldValue
      continue
    }
    if (field === "state.metadata" && restored.type === "tool" && (restored.state.status === "completed" || restored.state.status === "error")) {
      restored.state.metadata = storedRecord(fieldValue, "Tool metadata is not an object")
      continue
    }
    if (field === "metadata" && (restored.type === "tool" || restored.type === "reasoning")) {
      restored.metadata = storedRecord(fieldValue, "Part metadata is not an object")
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
    if (field === "recent_user_messages" && restored.type === "compaction") {
      if (
        !Array.isArray(fieldValue) ||
        !fieldValue.every(
          (item) =>
            isRecord(item) &&
            typeof item.id === "string" &&
            typeof item.text === "string" &&
            (item.truncated === undefined || typeof item.truncated === "boolean"),
        )
      ) {
        throw new CorruptionError({ message: "Compaction memento is invalid", hash })
      }
      restored.recent_user_messages = fieldValue as typeof restored.recent_user_messages
      continue
    }
    if (field === "snapshot" && (restored.type === "step-start" || restored.type === "step-finish")) {
      if (typeof fieldValue !== "string") throw new CorruptionError({ message: "Step snapshot is not a string", hash })
      restored.snapshot = fieldValue
      continue
    }
    if (
      (field === "inputChars" || field === "inputTokens") &&
      restored.type === "step-start"
    ) {
      if (typeof fieldValue !== "number" || !Number.isSafeInteger(fieldValue) || fieldValue < 0) {
        throw new CorruptionError({ message: "Step input estimate is invalid", hash })
      }
      if (field === "inputChars") restored.inputChars = fieldValue
      else restored.inputTokens = fieldValue
      continue
    }
    if (field === "inputChars" && restored.type === "step-finish") {
      if (typeof fieldValue !== "number" || !Number.isSafeInteger(fieldValue) || fieldValue < 0) {
        throw new CorruptionError({ message: "Step input estimate is invalid", hash })
      }
      restored.inputChars = fieldValue
      continue
    }
    if (
      field === "inputBreakdown" &&
      (restored.type === "step-start" || restored.type === "step-finish")
    ) {
      restored.inputBreakdown = storedRecord(fieldValue, "Step input breakdown is not an object") as typeof restored.inputBreakdown
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

// v2 entry fields 使用与 v1 envelope 相同的字段恢复协议；只替换 envelope version，避免复制另一套字段校验。
function restorePackedMessage(data: (typeof MessageTable.$inferSelect)["data"], fields: Record<string, Json>, hash: string) {
  return restoreMessage(data, { version: 1, owner: "message", fields }, hash)
}

function restorePackedPart(data: (typeof PartTable.$inferSelect)["data"], fields: Record<string, Json>, hash: string) {
  return restorePart(data, { version: 1, owner: "part", fields }, hash)
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
  if (!state.aged && ((markerPart && messageID === state.markerID) || (!markerPart && messageID === state.summaryID))) return false
  if (state.aged) return true
  const ownerTime = state.messageTimes.get(messageID)
  if (ownerTime === undefined || state.boundary === undefined) return false
  // 同时间 ID 必须按 SQLite BINARY 的 UTF-8 bytes 比较，不能把 caller ID 字典序当作 chronology。
  return ownerTime < state.boundary.time ||
    (ownerTime === state.boundary.time && Buffer.compare(Buffer.from(messageID), Buffer.from(state.boundary.id)) < 0)
}

// 空 cursor 是无 closed Message 的 sentinel：任何真实变更都晚于它，无需查行。
// 非空 cursor 解析失败则是持久化损坏，必须响亮失败而不是猜测边界。
function compareStoredMessageCursor(db: TxOrDb, sessionID: SessionID, messageID: MessageID, cursor: string) {
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

function requireReferenceMetadata(db: TxOrDb, hashes: string[], kind: "part-pack" | "session-summary") {
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
  // owner/refcount 交换由调用方的 immediate transaction 包住，崩溃不会留下半写 projection。
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
        sql`not exists (select 1 from ${SessionTable} where ${SessionTable.summary_ref} = ${ColdStorageTable.hash})`,
      ),
    )
    .run()
}

type MessagePackItem = {
  row: typeof MessageTable.$inferSelect
  projection: (typeof MessageTable.$inferSelect)["data"]
  entry: PackEntry
  oldRef: string | null
}

// status eligibility 只需要这些字段；完整 freeze/repack 调用方仍可传入整行。
type MessageValueRow = Pick<
  typeof MessageTable.$inferSelect,
  "id" | "session_id" | "data" | "cold_ref" | "cold_key"
>

// canonical pack 的数组/entry 标点大小可精确增量计算；不能为每个 owner 重编码整个候选 pack，
// 否则大 Session 会退化为 O(n²)。duplicate key 不增加 raw bytes，但 owner 仍留在当前 chunk 贡献 refcount。
function splitPacks<T extends { entry: PackEntry }>(owner: OwnerKind, items: T[]) {
  // 输入先按 owner ID 固定顺序到达，split 只决定 frame 边界，不能重排可观察的 entry identity。
  // 目标大小按 canonical entry bytes 估计，避免先压缩每个候选再反复尝试组合造成 CPU 浪费。
  // chunk 只持有当前 Session 的候选，maintenance 不把整库 raw data 同时留在内存。
  const chunks: T[][] = []
  let current: T[] = []
  let unique = new Map<string, string>()
  // Message 与 Part 使用不同 envelope owner，字段 JSON 相同也不能跨恢复 schema 共享。
  const emptyBytes = packEnvelope(owner, []).raw.byteLength
  let bytes = emptyBytes
  for (const item of items) {
    // canonical bytes 跨平台确定，同一 entry 集合在 Windows/Linux 得到相同边界决策。
    const key = item.entry.key.toString("hex")
    const fields = JSON.stringify(item.entry.fields)
    // 相同 key 的 fields 在 pack 内去重，owner 数量仍由 refcount 精确保留。
    const previous = unique.get(key)
    if (previous !== undefined && previous !== fields) {
      throw new CorruptionError({ message: "Pack entry key collides with different fields", hash: key })
    }
    const entryBytes = Buffer.byteLength(`{"fields":${fields},"key":${JSON.stringify(key)}}`)
    // target 变化虽不改业务值，却会改变 hash/ref 布局，仍需 plan revision 与物理实测。
    const delta = previous === undefined ? entryBytes + (unique.size ? 1 : 0) : 0
    // 首个超大 entry 仍独立成包，完整信息优先于目标大小与平均吞吐。
    if (current.length > 0 && previous === undefined && bytes + delta > PACK_TARGET_BYTES) {
      chunks.push(current)
      current = [item]
      unique = new Map([[key, fields]])
      bytes = emptyBytes + entryBytes
      continue
    }
    current.push(item)
    if (previous === undefined) {
      unique.set(key, fields)
      bytes += delta
    }
  }
  // Session/kind 聚合把逐 owner zstd frame 的固定成本压缩到 pack 数量级。
  if (current.length > 0) chunks.push(current)
  // 此处不写 DB；retain、assignment 与 release 由上层同一 transaction 连续完成。
  return chunks
}

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
  if (row.cold_key) throw new CorruptionError({ message: "Message v2 owner was selected for repack", hash: row.cold_ref ?? undefined })
  const data = row.cold_ref ? restoreMessage(row.data, cachedEnvelope(db, row.cold_ref, "message", cache), row.cold_ref) : row.data
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
function freezeMessagePacked(
  db: TxOrDb,
  row: typeof MessageTable.$inferSelect,
  now: number,
): FreezeResult {
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
      if (!item.cold_ref || !item.cold_key) throw new CorruptionError({ message: "Message v2 owner state is incomplete" })
      const entries = decodePack(db, item.cold_ref, "message")
      const fields = entries.get(item.cold_key.toString("hex"))
      if (!fields) throw new CorruptionError({ message: "Message v2 owner key is missing from pack", hash: item.cold_ref })
      return {
        row: item,
        projection: item.data,
        entry: { key: Buffer.from(item.cold_key), fields },
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
    for (const item of chunk) assignments.set(item.row.id, { hash: packed.hash, key: Buffer.from(item.entry.key) })
  }

  for (const item of items) {
    const assignment = assignments.get(item.row.id)
    if (!assignment) throw new CorruptionError({ message: "Message pack assignment is incomplete", hash: item.oldRef ?? undefined })
    const updated = db
      .update(MessageTable)
      .set({ data: item.projection, cold_ref: assignment.hash, cold_key: assignment.key, time_updated: item.row.time_updated })
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
  const envelopeValue = packEnvelope("message", packed.map((item) => item.entry))
  const payload = db.select({ compressed_bytes: ColdStorageTable.compressed_bytes }).from(ColdStorageTable).where(eq(ColdStorageTable.hash, assigned.hash)).get()
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
  if (row.cold_key) throw new CorruptionError({ message: "Part v2 owner was selected for repack", hash: row.cold_ref ?? undefined })
  if (row.cold_stats !== null) throw new CorruptionError({ message: "Hot or v1 Part has an unexpected cold Stats projection", hash: row.cold_ref ?? undefined })
  const data = row.cold_ref ? restorePart(row.data, cachedEnvelope(db, row.cold_ref, "part", cache), row.cold_ref) : row.data
  const value = extractPartV2(data)
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
    .where(
      and(
        eq(PartTable.session_id, row.session_id),
        isNotNull(PartTable.cold_ref),
        isNotNull(PartTable.cold_key),
      ),
    )
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
        entry: { key: Buffer.from(item.cold_key), fields },
        oldRef: item.cold_ref,
      } satisfies PartPackItem
    })
  const items = [...existing, target].sort((a, b) => a.row.id.localeCompare(b.row.id))
  const chunks = splitPacks("part", items)
  const assignments = new Map<PartID, { hash: string; key: Buffer }>()
  for (const chunk of chunks) {
    const packed = retainPackPayload(db, "part", chunk.map((item) => item.entry), now)
    const added = chunk.filter((item) => item.oldRef !== packed.hash).length
    if (added > 0) retainPackedReference(db, packed.hash, "part", now, added)
    for (const item of chunk) assignments.set(item.row.id, { hash: packed.hash, key: Buffer.from(item.entry.key) })
  }
  for (const item of items) {
    const assignment = assignments.get(item.row.id)
    if (!assignment) throw new CorruptionError({ message: "Part pack assignment is incomplete", hash: item.oldRef ?? undefined })
    const updated = db
      .update(PartTable)
      .set({
        data: item.projection,
        cold_ref: assignment.hash,
        cold_key: assignment.key,
        cold_stats: item.stats,
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
  const payload = db.select({ raw_bytes: ColdStorageTable.raw_bytes, compressed_bytes: ColdStorageTable.compressed_bytes }).from(ColdStorageTable).where(eq(ColdStorageTable.hash, assigned.hash)).get()
  if (!payload) throw new CorruptionError({ message: "Part pack disappeared after assignment", hash: assigned.hash })
  return {
    type: "frozen",
    hash: assigned.hash,
    rawBytes: payload.raw_bytes,
    compressedBytes: payload.compressed_bytes,
  }
}

// packed Message thaw 按 hash 分组，每个 pack 只解压一次；entry key 缺失或真实 ref_count 漂移会阻止整批回填。
// owner row 清除 ref/key 后再统一 decrement，父子 fork 共享 pack 时不会把仍在使用的 payload 提前删除。
function thawPackedMessageRows(db: TxOrDb, rows: Array<typeof MessageTable.$inferSelect & { cold_ref: string; cold_key: Buffer }>, now: number) {
  const hashes = [...new Set(rows.map((row) => row.cold_ref))]
  const payloads = db.select().from(ColdStorageTable).where(inArray(ColdStorageTable.hash, hashes)).all()
  if (payloads.length !== hashes.length) throw new CorruptionError({ message: "Message thaw contains a missing pack" })
  const counts = ownerCounts(db, hashes)
  const entries = new Map<string, Map<string, Record<string, Json>>>()
  for (const payload of payloads) {
    if (payload.kind !== "message-pack" || payload.ref_count !== (counts.get(payload.hash) ?? 0)) {
      throw new CorruptionError({ message: "Message pack metadata is inconsistent", hash: payload.hash })
    }
    entries.set(payload.hash, decodePack(db, payload.hash, "message"))
  }
  const restored = rows.map((row) => {
    const fields = entries.get(row.cold_ref)?.get(row.cold_key.toString("hex"))
    if (!fields) throw new CorruptionError({ message: "Message thaw key is missing from pack", hash: row.cold_ref })
    const data = restorePackedMessage(row.data, fields, row.cold_ref)
    db.update(MessageTable)
      .set({ data, cold_ref: null, cold_key: null, time_updated: row.time_updated })
      .where(and(eq(MessageTable.id, row.id), eq(MessageTable.cold_ref, row.cold_ref)))
      .run()
    return { ...row, data, cold_ref: null, cold_key: null }
  })
  decrementReferences(db, rows.map((row) => row.cold_ref), now)
  return restored
}

// 一个 pack chunk 内的 owner projection 使用单条 SQLite upsert，而不是每行一次 UPDATE。
// maintenance 已持有 immediate transaction；同一批不会被其他 writer 插入竞争，RETURNING 仍验证每个 owner 都被写回。
function assignMessagePack(
  db: TxOrDb,
  items: MessagePackItem[],
  hash: string,
) {
  for (let offset = 0; offset < items.length; offset += DEFAULT_BATCH_SIZE) {
    const values = items.slice(offset, offset + DEFAULT_BATCH_SIZE).map((item) => ({
      id: item.row.id,
      session_id: item.row.session_id,
      time_created: item.row.time_created,
      time_updated: item.row.time_updated,
      data: item.projection,
      cold_ref: hash,
      cold_key: Buffer.from(item.entry.key),
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
    if (updated.length !== values.length) throw new CorruptionError({ message: "Message pack assignment is incomplete", hash })
  }
}

function assignPartPack(
  db: TxOrDb,
  items: PartPackItem[],
  hash: string,
) {
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
      cold_key: Buffer.from(item.entry.key),
      // 非 Tool/Step 的 stats 必须是 NULL，不能沿用上一轮对象中的派生值。
      cold_stats: item.stats,
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
    if (updated.length !== values.length) throw new CorruptionError({ message: "Part pack assignment is incomplete", hash })
  }
}

// Message freeze batch 按 Session 分组构建 v2 pack；v1 owner 先在内存 inspect，再与新 hot owner 一起升级。
// 不再使用 per-owner 4 KiB floor；每个有 approved field 的 eligible owner 都进入 pack，未处理 row 只计 skipped。
// payload、owner projection、ref/key、旧 v1 release 位于同一 immediate transaction，checkpoint 只在提交后推进。
function freezeMessageBatch(
  db: TxOrDb,
  rows: (typeof MessageTable.$inferSelect)[],
  input: {
    now: number
    olderThanMs: number
    eligibilityState(sessionID: SessionID): ReturnType<typeof eligibility>
  },
) {
  const groups = new Map<SessionID, MessagePackItem[]>()
  const legacyCache = new Map<string, Envelope>()
  const prepared = rows.flatMap((row) => {
    const value = messageV2Value(db, row, legacyCache)
    if (!value || !eligible(input.eligibilityState(row.session_id), row.id)) return []
    const group = groups.get(row.session_id)
    if (group) group.push(value)
    else groups.set(row.session_id, [value])
    return [value]
  })
  let rawBytes = 0
  let compressedBytes = 0
  for (const items of groups.values()) {
    for (const chunk of splitPacks("message", items)) {
      const packed = retainPackPayload(db, "message", chunk.map((item) => item.entry), input.now)
      retainPackedReference(db, packed.hash, "message", input.now, chunk.length)
      rawBytes += packed.rawBytes
      compressedBytes += packed.compressedBytes
      assignMessagePack(db, chunk, packed.hash)
      decrementReferences(
        db,
        chunk.flatMap((item) => (item.oldRef && item.oldRef !== packed.hash ? [item.oldRef] : [])),
        input.now,
      )
    }
  }
  return {
    skipped: rows.length - prepared.length,
    rawBytes,
    compressedBytes,
  }
}

// Part freeze batch 与 Message 使用相同 pack 目标；v1 projection 在内存 inspect 后升级，所有 approved fields 取消 4 KiB floor。
// 每个 Session 的 prepared owners 只生成目标范围内的 immutable packs，旧 v1 refs 在 owner 切换后按真实数量递减。
function freezePartBatch(
  db: TxOrDb,
  rows: (typeof PartTable.$inferSelect)[],
  input: {
    now: number
    olderThanMs: number
    eligibilityState(sessionID: SessionID): ReturnType<typeof eligibility>
  },
) {
  // eligibilityState 仅在当前 batch 按 Session 缓存，下一批会重算 updated/boundary。
  // groups 以 Session 为单位，内容 hash 可跨 fork 去重而不混淆 chronology owner。
  const groups = new Map<SessionID, PartPackItem[]>()
  // legacy cache 让同一 v1 payload 在 batch 内只解压一次，多个 fork owner不重复消耗 CPU。
  const legacyCache = new Map<string, Envelope>()
  // hot row 抽取完整值；v1 row 仅内存恢复并从此升级，v2 row不会进入候选 SQL。
  const prepared = rows.flatMap((row) => {
    const value = partV2Value(db, row, legacyCache)
    if (!value || !eligible(input.eligibilityState(row.session_id), row.message_id)) return []
    const group = groups.get(row.session_id)
    if (group) group.push(value)
    else groups.set(row.session_id, [value])
    return [value]
  })
  let rawBytes = 0
  let compressedBytes = 0
  // projector、canonical、zstd 或 SQL 任一步失败都会回滚 batch，cursor 不会提前推进。
  for (const items of groups.values()) {
    for (const chunk of splitPacks("part", items)) {
      // 每个 chunk 先 retain immutable pack，再切 owner，最后递减真实移动的旧 refs。
      const packed = retainPackPayload(db, "part", chunk.map((item) => item.entry), input.now)
      retainPackedReference(db, packed.hash, "part", input.now, chunk.length)
      // counters 只累加 frame 逻辑 bytes，不把共享 owner 数量当作物理文件大小。
      rawBytes += packed.rawBytes
      compressedBytes += packed.compressedBytes
      assignPartPack(db, chunk, packed.hash)
      // 新旧 hash 相同表示内容未变，不能 retain/decrement 后删除仍被复用的 payload。
      decrementReferences(
        db,
        chunk.flatMap((item) => (item.oldRef && item.oldRef !== packed.hash ? [item.oldRef] : [])),
        input.now,
      )
    }
  }
  return {
    // ineligible/no-fields 是正常 skipped，不应被维护任务误报为失败。
    // prepared 差值直接形成 skipped，避免再次遍历大型 candidate batch。
    skipped: rows.length - prepared.length,
    rawBytes,
    compressedBytes,
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
  // 成功 decode 尚未合并 owner；restore 和 owner UPDATE 完成后才能 release 引用。
  return parseEnvelope(owner, raw, hash)
}

// decodePack 是 v2 owner 的唯一 pack integrity gate；解压后同时验证 pack hash、entry key 和 canonical 顺序。
// 调用方只能拿到经验证的 entry map，不能把任意 JSON 当作 projection 成功返回。
function decodePack(db: TxOrDb, hash: string, owner: OwnerKind) {
  const payload = db.select().from(ColdStorageTable).where(eq(ColdStorageTable.hash, hash)).get()
  if (!payload) throw new CorruptionError({ message: "Cold pack reference points to a missing payload", hash })
  if (payload.kind !== packKind(owner) || payload.codec !== "zstd") {
    throw new CorruptionError({ message: "Cold pack kind or codec is invalid", hash })
  }
  if (payload.payload.byteLength !== payload.compressed_bytes) {
    throw new CorruptionError({ message: "Cold pack compressed size does not match", hash })
  }
  const raw = decompress(payload.payload)
  if (raw.byteLength !== payload.raw_bytes || digest(packKind(owner), raw) !== hash) {
    throw new CorruptionError({ message: "Cold pack size or hash does not match", hash })
  }
  const parsed = parsePackEnvelope(owner, raw, hash)
  return new Map(parsed.entries.map((entry) => [entry.key.toString("hex"), entry.fields]))
}

// retainPackPayload 与 v1 retain 对称，但 hash 身份覆盖完整 pack；existing row 必须先用真实 owner ref_count 和 canonical bytes 复验。
// 新 pack 以零引用插入，owner projection 写入后才由 retainPackedReference 增加每个实际 owner。
function retainPackPayload(db: TxOrDb, owner: OwnerKind, entries: PackEntry[], now: number) {
  // digest 取 canonical raw bytes 而非 zstd frame，跨平台压缩差异不改变内容身份。
  const value = packEnvelope(owner, entries)
  const existing = db.select().from(ColdStorageTable).where(eq(ColdStorageTable.hash, value.hash)).get()
  if (existing) {
    if (
      existing.kind !== packKind(owner) ||
      existing.codec !== "zstd" ||
      existing.raw_bytes !== value.raw.byteLength ||
      existing.compressed_bytes !== existing.payload.byteLength ||
      existing.ref_count !== ownerCount(db, value.hash)
    ) {
      throw new CorruptionError({ message: "Existing cold pack metadata is inconsistent", hash: value.hash })
    }
    const restored = decodePack(db, value.hash, owner)
    const restoredValue = packEnvelope(
      owner,
      [...restored].map(([key, fields]) => ({ key: Buffer.from(key, "hex"), fields })),
    )
    if (!restoredValue.raw.equals(value.raw)) {
      throw new CorruptionError({ message: "Cold pack hash collides with different canonical bytes", hash: value.hash })
    }
    return {
      hash: value.hash,
      rawBytes: value.raw.byteLength,
      compressedBytes: existing.compressed_bytes,
    }
  }
  const payload = compress(value.raw)
  // 新 payload 先以零引用落表，只有 owner assignment 路径可增加真实生命周期计数。
  db.insert(ColdStorageTable)
    .values({
      hash: value.hash,
      kind: packKind(owner),
      codec: "zstd",
      payload,
      raw_bytes: value.raw.byteLength,
      compressed_bytes: payload.byteLength,
      ref_count: 0,
      time_created: now,
      time_updated: now,
    })
    .run()
  return { hash: value.hash, rawBytes: value.raw.byteLength, compressedBytes: payload.byteLength }
}

// Pack ref_count 按 owner 增量而不是按 unique key 增量；相同 entry 被两个 Message 使用时仍需两个生命周期引用。
function retainPackedReference(db: TxOrDb, hash: string, owner: OwnerKind, now: number, count = 1) {
  const payload = db.select().from(ColdStorageTable).where(eq(ColdStorageTable.hash, hash)).get()
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
// 该路径只给内部 cache rebuild 使用；业务 Message/Part 读取必须继续走 thaw，不能借此形成第二套缓存。
function decodeSummary(db: TxOrDb, hash: string) {
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
      throw new CorruptionError({ message: "Session summary hash collides with different canonical bytes", hash: value.hash })
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
  const seedRelation = payload.seed ? compareStoredMessageCursor(db, sessionID, messageID, payload.seed.cursor) : undefined
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
    .onConflictDoUpdate({ target: PartTable.id, set: { data: row.data, cold_ref: null, cold_key: null, cold_stats: null } })
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
    db.update(SessionTable)
      .set({ summary_ref: null, summary_cursor: null })
      .where(eq(SessionTable.id, sessionID))
      .run()
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
      cold_key: row.cold_key ? Buffer.from(row.cold_key) : null,
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
    [...sourceMessages, ...sourceParts].flatMap((row) => (row.cold_ref ? [{ hash: row.cold_ref }] : [])),
    Date.now(),
  )
  // projector 仍拥有 Session usage totals；返回 raw Part data 让它复用既有 step-finish 聚合而不再次查询或 thaw。
  return sourceParts.map((row) => row.data)
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
  const value = extractPartV2(source)
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

// Message range thaw 在一个 immediate transaction 中恢复传入范围；未含 cold_ref 时直接零成本返回原 rows。
// 每个 row 在事务内重新读取，避免调用方持有的旧 projection 覆盖刚完成的其他 writer 更新。
// 成功回填后立即 release，后续 page/get 读取主表热 JSON，不再反复解压，这是持久预热语义。
// corruption 会使整个范围 rollback，模型不会收到部分完整、部分占位的混合上下文。
export function thawMessageRows(rows: (typeof MessageTable.$inferSelect)[]) {
  if (!rows.some((row) => row.cold_ref)) {
    if (rows.some((row) => row.cold_key)) throw new CorruptionError({ message: "Message owner has a key without a ref" })
    return rows
  }
  return Database.transaction(
    (db) => {
      const current = rows.map((input) => {
        if (input.cold_key && !input.cold_ref) throw new CorruptionError({ message: "Message owner has a key without a ref" })
        const row = db.select().from(MessageTable).where(eq(MessageTable.id, input.id)).get()
        if (!row) throw new CorruptionError({ message: `Message disappeared during thaw: ${input.id}` })
        return row
      })
      const legacy = current.filter((row): row is typeof row & { cold_ref: string; cold_key: null } => !!row.cold_ref && !row.cold_key)
      const packed = current.filter((row): row is typeof row & { cold_ref: string; cold_key: Buffer } => !!row.cold_ref && !!row.cold_key)
      const restored = new Map<MessageID, typeof current[number]>()
      if (legacy.length > 0) {
        const values = decodedBatch(db, legacy.map((row) => row.cold_ref), "message")
        for (const row of legacy) {
          const data = restoreMessage(row.data, requiredEnvelope(values, row.cold_ref), row.cold_ref)
          db.update(MessageTable)
            .set({ data, cold_ref: null, cold_key: null, time_updated: row.time_updated })
            .where(and(eq(MessageTable.id, row.id), eq(MessageTable.cold_ref, row.cold_ref)))
            .run()
          restored.set(row.id, { ...row, data, cold_ref: null, cold_key: null })
        }
        decrementReferences(db, legacy.map((row) => row.cold_ref), Date.now())
      }
      if (packed.length > 0) {
        for (const row of thawPackedMessageRows(db, packed, Date.now())) restored.set(row.id, row)
      }
      return current.map((row) => restored.get(row.id) ?? row)
    },
    { behavior: "immediate" },
  )
}

// Part range thaw 与 Message 共享持久预热合同，Session.getPart 和 MessageV2.hydrate 都必须经过该 decoder。
// 事务内重读保证 projection 与 cold_ref 来自同一版本；已被其他 reader thaw 的 row 直接采用最新热数据。
// release 在完整 data UPDATE 后执行，确保 fork 共享 payload 只在最后一个 owner 完成恢复时删除。
export function thawPartRows(rows: (typeof PartTable.$inferSelect)[]) {
  // fast path 只接受严格 hot `(NULL,NULL,NULL)`；key-only 或 stats-only 状态不能冒充无需处理。
  if (!rows.some((row) => row.cold_ref)) {
    if (rows.some((row) => row.cold_key)) throw new CorruptionError({ message: "Part owner has a key without a ref" })
    if (rows.some((row) => row.cold_stats !== null)) throw new CorruptionError({ message: "Hot Part has a cold Stats projection" })
    return rows
  }
  return Database.transaction(
    (db) => {
      // 输入可能来自过期查询；事务内按 ID 重读才是选择当前 decoder 的事实。
      const current = rows.map((input) => {
        if (input.cold_key && !input.cold_ref) throw new CorruptionError({ message: "Part owner has a key without a ref" })
        const row = db.select().from(PartTable).where(eq(PartTable.id, input.id)).get()
        if (!row) throw new CorruptionError({ message: `Part disappeared during thaw: ${input.id}` })
        return row
      })
      const legacy = current.filter((row): row is typeof row & { cold_ref: string; cold_key: null } => !!row.cold_ref && !row.cold_key)
      const packed = current.filter((row): row is typeof row & { cold_ref: string; cold_key: Buffer } => !!row.cold_ref && !!row.cold_key)
      // Map 按 ID 汇合恢复值，最终仍依输入顺序返回，hash grouping 不改变 Part chronology。
      const restored = new Map<PartID, typeof current[number]>()
      if (legacy.length > 0) {
        // v1 refs 按 hash 批量 decode，共享 fork owner 不重复解压同一 payload。
        const values = decodedBatch(db, legacy.map((row) => row.cold_ref), "part")
        for (const row of legacy) {
          const data = restorePart(row.data, requiredEnvelope(values, row.cold_ref), row.cold_ref)
          // data 与 NULL ref/key/stats 一次写回并保留 timestamp，持久预热不改变 chronology。
          db.update(PartTable)
            .set({ data, cold_ref: null, cold_key: null, cold_stats: null, time_updated: row.time_updated })
            .where(and(eq(PartTable.id, row.id), eq(PartTable.cold_ref, row.cold_ref)))
            .run()
          restored.set(row.id, { ...row, data, cold_ref: null, cold_key: null, cold_stats: null })
        }
        // legacy owners 全部写热后再递减，共享 payload 不会因首个 fork thaw 被提前删除。
        decrementReferences(db, legacy.map((row) => row.cold_ref), Date.now())
      }
      if (packed.length > 0) {
        const hashes = [...new Set(packed.map((row) => row.cold_ref))]
        const payloads = db.select().from(ColdStorageTable).where(inArray(ColdStorageTable.hash, hashes)).all()
        if (payloads.length !== hashes.length) throw new CorruptionError({ message: "Part thaw contains a missing pack" })
        // v2 先反算真实 owner count，再验证 kind/refcount；损坏时不写回任何 Part。
        const counts = ownerCounts(db, hashes)
        const entries = new Map<string, Map<string, Record<string, Json>>>()
        for (const payload of payloads) {
          if (payload.kind !== "part-pack" || payload.ref_count !== (counts.get(payload.hash) ?? 0)) {
            throw new CorruptionError({ message: "Part pack metadata is inconsistent", hash: payload.hash })
          }
          entries.set(payload.hash, decodePack(db, payload.hash, "part"))
        }
        for (const row of packed) {
          // 每个 owner key 必须存在，不能拿 skeleton 的空字段继续业务读取。
          const fields = entries.get(row.cold_ref)?.get(row.cold_key.toString("hex"))
          if (!fields) throw new CorruptionError({ message: "Part thaw key is missing from pack", hash: row.cold_ref })
          const data = restorePackedPart(row.data, fields, row.cold_ref)
          // Tool/Step 在清除同行投影前重算核对，避免错误 cold_stats 进入公开统计。
          requirePartStats(row, projectPartStats(data))
          db.update(PartTable)
            .set({ data, cold_ref: null, cold_key: null, cold_stats: null, time_updated: row.time_updated })
            .where(and(eq(PartTable.id, row.id), eq(PartTable.cold_ref, row.cold_ref)))
            .run()
          restored.set(row.id, { ...row, data, cold_ref: null, cold_key: null, cold_stats: null })
        }
        // owner 全部写回后才递减，最后一个共享 ref 才能删除 immutable payload。
        decrementReferences(db, packed.map((row) => row.cold_ref), Date.now())
      }
      // 返回值均已是热态业务数据，前端不感知本次是否执行 zstd 与持久写回。
      return current.map((row) => restored.get(row.id) ?? row)
    },
    { behavior: "immediate" },
  )
}

// inspect 只在 SummaryCache rebuild 中恢复内存投影，保留 owner cold_ref 和 payload ref_count 不动。
// 它与 thaw 共用 decode/restore corruption gate，但绝不写 PartTable，避免 derived cache 重建反向破坏归档状态。
export function inspectPartRows(db: TxOrDb, rows: (typeof PartTable.$inferSelect)[]) {
  const legacy = rows.filter((row): row is typeof row & { cold_ref: string; cold_key: null } => !!row.cold_ref && !row.cold_key)
  const packed = rows.filter((row): row is typeof row & { cold_ref: string; cold_key: Buffer } => !!row.cold_ref && !!row.cold_key)
  const legacyValues = decodedBatch(db, legacy.map((row) => row.cold_ref), "part")
  // 非持久 inspect 与 thaw/Stats 共用真实 owner gate，不能仅因 pack bytes 可解码就忽略 refcount drift。
  const packedHashes = [...new Set(packed.map((row) => row.cold_ref))]
  requireReferenceMetadata(db, packedHashes, "part-pack")
  const packs = new Map(
    packedHashes.map((hash) => [hash, decodePack(db, hash, "part")] as const),
  )
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

// Stats inspect 与业务 inspect 的差异是持久格式合同：v2 只能读取 owner 同行投影，绝不打开 pack。
// v1 没有该列，必须按 hash 批量解码并在内存恢复；该 shipped compatibility branch 不写 owner/refcount。
// hot row 现场计算同一 projector，因而 hot/v1/v2 不会维护三套统计公式。
export function inspectPartStats(db: TxOrDb, rows: (typeof PartTable.$inferSelect)[]) {
  // hot row 出现 cold_stats 表示 writer 未清理派生状态，继续统计会形成两个矛盾数据源。
  // 此 seam 只返回标量且不执行 owner mutation，Stats 前后 storage-state hash 必须相同。
  const legacy = rows.filter((row): row is typeof row & { cold_ref: string; cold_key: null } => !!row.cold_ref && !row.cold_key)
  // v1 只能批量 decode 旧 payload，但共用正式 integrity gate，不建立宽松 Stats parser。
  const legacyValues = decodedBatch(db, legacy.map((row) => row.cold_ref), "part")
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
        throw new CorruptionError({ message: "Legacy Part has an unexpected cold Stats projection", hash: row.cold_ref })
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
  return sql`json_extract(${MessageTable.data}, '$.role') = 'user'
    and json_array_length(json_extract(${MessageTable.data}, '$.summary.diffs')) > 0`
}

// Part candidate 只做 discriminator 前置筛选，最终字段白名单/eligibility 在 JS extraction 再验证。
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
    if (row.data.type !== "tool" || (row.data.state.status !== "completed" && row.data.state.status !== "error")) continue
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
    // packed key 固定 32 bytes，并须存在于成功解析的唯一排序 entry 集合。
    if (key.byteLength !== 32 || payload.kind !== packKind(owner)) {
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
        if (owner.stats !== null) throw new CorruptionError({ message: "Non-v2 Part has a cold Stats projection", hash: owner.ref ?? undefined })
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
  // prepare 是 control/CLI 的共同参数门禁，daemon 与 offline 命令不能各自解释默认值。
  // 参数错误在创建 task 或获取 lease 前失败，不能留下不可恢复的 queued 记录。
  validateMaintenanceRequest(request)
  // 只读/立即操作不伪造 durable cursor；实际持久写入才创建可恢复 task。
  const taskBacked =
    request.operation === "compress" ||
    request.operation === "expand" ||
    (request.operation === "verify" && (request.repair || request.repairToolInput === true)) ||
    (request.operation === "cleanup" && request.delete)
  if (!taskBacked) return { type: "immediate", request }

  const now = Date.now()
  // task 固化 dbPath 与规范化 args，resume 不能换数据库、scope 或 batchSize。
  // prepare 不扫描 owner；eligibility 必须在真正的 batch transaction 内重新验证。
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
    // batchSize 同时约束 SQLite variables 与单事务 WAL 体积，超限不能静默 clamp。
    // CASE/inArray 会为每个 owner 生成多个 SQLite 参数；5000 保持低于跨平台变量上限并约束单事务 WAL 体积。
    // 上限属于后端 normalization invariant，CLI flag 和 daemon JSON 不能各自选择不同的危险批量。
    throw new ValidationError({ message: `Maintenance batchSize must be an integer between 1 and ${MAX_BATCH_SIZE}` })
  }
  // NaN age 会使全部 Session 的 eligibility 失真，必须在扫描 owner 前拒绝。
  if (request.operation === "compress" && (!Number.isFinite(request.olderThanMs) || request.olderThanMs < 0)) {
    throw new ValidationError({ message: "compress olderThanMs must be non-negative" })
  }
  // 空 expand scope 不得被后端解释成全库恢复，all 必须来自显式授权。
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
        olderThanMs: input.olderThanMs === undefined ? SEVEN_DAYS_MS : Number(input.olderThanMs),
        batchSize,
      }
    case "expand":
      return { operation: "expand", ...(sessionID ? { sessionID } : {}), all: input.all === true, batchSize }
    case "status":
      return { operation: "status" }
    case "verify":
      return {
        operation: "verify",
        repair: input.repair === true,
        repairToolInput: input.repairToolInput === true,
        batchSize,
      }
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
    if (
      (input.owner !== "message" && input.owner !== "part" && input.owner !== "session-summary") ||
      typeof input.lastID !== "string"
    ) {
      throw new ValidationError({ message: "Maintenance task owner cursor is invalid" })
    }
    if (
      input.lastID &&
      ((input.owner === "message" && !Schema.is(MessageID)(input.lastID)) ||
        (input.owner === "part" && !Schema.is(PartID)(input.lastID)) ||
        (input.owner === "session-summary" && !Schema.is(SessionIDSchema)(input.lastID)))
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
    (args.operation === "verify" && (args.repair || args.repairToolInput === true)) ||
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

function pragmaNumber(name: "page_size" | "page_count" | "freelist_count") {
  const row: unknown = Database.Client().$client.query(`PRAGMA ${name}`).get()
  return isRecord(row) && typeof row[name] === "number" ? row[name] : 0
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

// maintain 是 operation dispatch、batch transaction、cursor advance、abort 与 terminal checkpoint 的唯一 owner。
// 每批先 assert lease，SQLite immediate transaction 提交后才更新 task record；checkpoint 失败可由 owner 状态幂等恢复。
// AbortSignal 只在批次边界观察，不中断正在写 WAL 的事务；下一 checkpoint 明确记录 interrupted 而非 failed。
export async function maintain(
  prepared: PreparedMaintenance,
  runtime: MaintenanceRuntime = { checkpoint: async () => {} },
): Promise<MaintenanceResult> {
  // daemon 与 offline CLI 共用此执行器，channel 差异只存在于外层锁和结果传输。
  if (prepared.type === "immediate") {
    if (prepared.request.operation === "status") return { type: "status", report: status() }
    if (prepared.request.operation === "verify") return { type: "verify", report: verify(prepared.request) }
    if (prepared.request.operation === "cleanup") return { type: "cleanup", report: cleanup(prepared.request) }
    if (prepared.request.operation !== "vacuum") {
      throw new ValidationError({ message: "vacuum requires confirm=true" })
    }
    if (!prepared.request.confirm) throw new ValidationError({ message: "vacuum requires confirm=true" })
    // vacuum 是唯一 immediate write，必须同时持有显式 confirm 与 maintenance lease。
    if (!runtime.lease) throw new ValidationError({ message: "vacuum requires a maintenance lease" })
    runtime.lease.assertOwned()
    const pagesBefore = pageCount()
    // checkpoint 位于同一显式 vacuum operation 内，普通 status/compress 不获得额外阻塞写入。
    Database.Client().$client.run("VACUUM")
    const checkpoint: unknown = Database.Client().$client.query("PRAGMA wal_checkpoint(TRUNCATE)").get()
    // VACUUM 在 WAL 模式可留下接近主库大小的 frame；busy/nonempty 结果不能被报告为物理整理完成。
    // SQLite 在没有 WAL 能力时返回 log=-1/checkpointed=-1，这与零 frame 同样是 terminal success。
    if (
      !isRecord(checkpoint) ||
      typeof checkpoint.busy !== "number" ||
      checkpoint.busy !== 0 ||
      typeof checkpoint.log !== "number" ||
      checkpoint.log > 0
    ) {
      // busy=0 但 log>0 仍表示磁盘上存在未截断 frame，必须让 CLI 以失败结束。
      throw new Error(`WAL checkpoint did not truncate after vacuum: ${JSON.stringify(checkpoint)}`)
    }
    // page report 只有在 WAL 结果验证后返回，调用方不会看到“成功 JSON + 双倍磁盘占用”。
    return { type: "vacuum", pagesBefore, pagesAfter: pageCount() }
  }

  // zstd 与 SQLite 在当前后台进程执行，不创建会弹出窗口的 worker 子进程。
  const preparedTask = taskRequest(prepared, runtime)
  const task = structuredClone(preparedTask.task)
  // durable 参数只取 task row；resume 不能用新命令行改变尚未处理的 scope。
  const request = preparedTask.request
  if (!runtime.lease) throw new ValidationError({ message: "task-backed maintenance requires a lease" })
  runtime.lease.assertOwned()
  const checkpoint = async () => {
    task.updatedAt = Date.now()
    // callback 只在 DB commit 后通知控制层，外部进度不能领先持久 owner 状态。
    await runtime.checkpoint(structuredClone(task))
  }

  task.status = "running"
  // resume 开始后旧 interrupted error 不再描述当前 attempt；新失败会在 catch 中重新持久化真实原因。
  delete task.error
  await checkpoint()

  try {
    if (request.operation === "verify") {
      // repair task 复用同步 verify 的完整 owner/payload/state 快照，禁止维护第二套 payload-only verdict。
      const report = Database.transaction(
        (db) => verifyWith(db, { repair: request.repair, repairToolInput: request.repairToolInput === true }),
        { behavior: "immediate" },
      )
      // repaired mismatch 不算失败；无法修复的 owner/missing/frame 类别才进入 task.failed。
      const failed = report.corruptOwners + report.missingPayloads + report.corruptPayloads
      task.processed = report.checkedOwners + report.checkedPayloads
      task.skipped = Math.max(0, task.processed - report.repaired - failed)
      task.failed = failed
      task.status = "completed"
      await checkpoint()
      return { type: "task", task }
    }

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
          // Message 完成后才转到 Part，固定 owner cursor 顺序避免恢复时跨表遗漏。
          const outcome = Database.transaction(
            (db) => {
              const rows = cold
                ? nextMessageRows(db, request, cursor.lastID, true, request.batchSize)
                : nextMessageRows(db, request, cursor.lastID, false, request.batchSize)
              if (rows.length === 0) return { empty: true as const }
              const now = Date.now()
              const eligibilityState = batchEligibility(db, now, olderThanMs)
              if (cold) thawMessageRows(rows)
              const result = cold
                ? { skipped: 0, rawBytes: 0, compressedBytes: 0 }
                : freezeMessageBatch(db, rows, {
                    now,
                    olderThanMs,
                    eligibilityState,
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
            // 阶段切换也持久 checkpoint，崩溃恢复不会重新解释上一表的结束位置。
            task.cursor = { owner: "part", lastID: "" }
            await checkpoint()
            continue
          }
          task.cursor = outcome.cursor
          task.processed += outcome.processed
          task.skipped += outcome.skipped
          task.rawBytes += outcome.rawBytes
          task.compressedBytes += outcome.compressedBytes
        } else if (cursor.owner === "part") {
          const outcome = Database.transaction(
            (db) => {
              const rows = cold
                ? nextPartRows(db, request, cursor.lastID, true, request.batchSize)
                : nextPartRows(db, request, cursor.lastID, false, request.batchSize)
              if (rows.length === 0) return { empty: true as const }
              const now = Date.now()
              const eligibilityState = batchEligibility(db, now, olderThanMs)
              if (cold) thawPartRows(rows)
              const result = cold
                ? { skipped: 0, rawBytes: 0, compressedBytes: 0 }
                : freezePartBatch(db, rows, {
                    now,
                    olderThanMs,
                    eligibilityState,
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
          if (outcome.empty && cold) {
            // expand 最后清 summary refs，完整降级结束后不残留 maintenance pointers。
            task.cursor = { owner: "session-summary", lastID: "" }
            await checkpoint()
            continue
          }
          if (outcome.empty) done = true
          else {
            task.cursor = outcome.cursor
            task.processed += outcome.processed
            task.skipped += outcome.skipped
            task.rawBytes += outcome.rawBytes
            task.compressedBytes += outcome.compressedBytes
          }
        } else {
          if (!cold) throw new ValidationError({ message: "Compress task cannot enter the summary expand stage" })
          const outcome = Database.transaction(
            (db) => {
              const rows = nextSummaryRows(db, request, cursor.lastID, request.batchSize)
              if (rows.length === 0) return { empty: true as const }
              for (const row of rows) {
                if (!row.ref) continue
                expandSummaryReference(db, row.id, row.ref)
              }
              return {
                empty: false as const,
                cursor: { owner: "session-summary" as const, lastID: rows[rows.length - 1].id },
                processed: rows.length,
              }
            },
            { behavior: "immediate" },
          )
          if (outcome.empty) done = true
          else {
            task.cursor = outcome.cursor
            task.processed += outcome.processed
          }
        }
      } else if (request.operation === "cleanup") {
        // cleanup 只处理真实 orphan；完整 verify/repair 已在上方单一权威快照完成。
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
            let bytes = 0
            for (const row of rows) {
              const owners = ownerCount(db, row.hash)
              if (owners === 0 && request.delete) {
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
    // snapshot 只含进度指标，不把 Tool output、diff 或 compressed payload 带入控制面。
    return { type: "task", task }
  } catch (error) {
    task.status = runtime.signal?.aborted ? "interrupted" : "failed"
    task.error = String(error)
    await checkpoint()
    // terminal failure 记录后继续抛出，worker/CLI 不得接收 completed 外形或备用成功路径。
    throw error
  }
}

// status 汇总 logical raw、unique compressed、共享 bytes 与真实 refcount mismatch，不触发 thaw 或 owner rewrite。
// eligibleOwners 复用 SQL candidate+唯一 eligibility 判定，报告的是当前可冻 owner 而非所有 hot rows。
// 它不获取 maintenance lease；纯 metadata 读取不能阻塞正在进行的后台批次。
export function status(): StatusReport {
  return Database.use((db) => {
    // activeBytes 与 file length 分开，freelist 页面只在显式 VACUUM 后物理消失。
    const pageSize = pragmaNumber("page_size")
    const pages = pragmaNumber("page_count")
    const freelistPages = pragmaNumber("freelist_count")
    // status 只汇总同行 metadata；禁止 materialize 不参与报告的压缩 body。
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
    // 所有共享与 mismatch 指标都由真实 owner 反算，stored counter 不能给自身背书。
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
    // summary payload 单列报告，用户可区分 transcript packs 与 Session aggregate cache。
    const summaryPayloads = payloads.filter((row) => row.kind === "session-summary")
    // logical raw 使用 owner 反算数；当 persisted ref_count 损坏时，status 仍给出真实共享量并单独报告 mismatch。
    // orphan payload 计入物理 compressedBytes，但不参与 referencedRaw/sharedBytes，避免无 owner blob 扭曲去重收益。
    // verify/cleanup 才拥有修复或删除权限，status 的真实计数不能顺带改写 persisted ref_count。
    // v2 pack 的 raw_bytes 是整包 envelope：F0=raw×owners 会把同一 entry 集合重复计 N 次。
    // F4=raw×(owners/keys) 在等分 entry 近似下表示「每个 owner 各持一份字段」的逻辑 raw；pure pack 退化为 unique raw。
    // session-summary 无 cold_key，整 blob 仍按 raw×owners 展开。禁止为算 F4 去 materialize payload body。
    // packKeyStats 与 ownerCounts 分查：前者只补 distinct key，后者继续服务 mismatch/orphan。
    const keyCounts = packKeyStats(
      db,
      payloads.map((row) => row.hash),
    )
    const rawBytes = payloads.reduce((total, row) => {
      const owners = counts.get(row.hash) ?? 0
      // orphan 的 unique raw 只进 referencedRaw/compressed，不进逻辑 Raw 展开。
      if (owners === 0) return total
      if (row.kind === "message-pack" || row.kind === "part-pack") {
        const distinctKeys = keyCounts.get(row.hash) ?? 0
        // keys==0 的 v2 损坏行不回退 F0，避免再次把整包按 owner 连乘放大。
        if (distinctKeys <= 0) return total
        // owners 用全表反算 n；keys 只服务 entry 共享倍率（等分 entry 近似）。
        // 除法保持 number：StatusReport 与 CLI 十进制展示均按浮点字节计数。
        return total + (row.raw_bytes * owners) / distinctKeys
      }
      // session-summary 等整 blob kind：一份 payload 即完整逻辑内容，仍 raw×owners。
      return total + row.raw_bytes * owners
    }, 0)
    // unique compressed 包含 orphan 的真实占用，cleanup 前仍须显示可回收空间。
    const compressedBytes = payloads.reduce((total, row) => total + row.compressed_bytes, 0)
    const referencedRawBytes = payloads.reduce(
      (total, row) => total + ((counts.get(row.hash) ?? 0) > 0 ? row.raw_bytes : 0),
      0,
    )
    const refCountMismatches = payloads.filter((row) => row.ref_count !== (counts.get(row.hash) ?? 0)).length
    // orphan 由真实引用为零判定，错误的 persisted ref_count 不能隐藏 cleanup 候选。
    const orphans = payloads.filter((row) => (counts.get(row.hash) ?? 0) === 0).length
    return {
      pageSize,
      pageCount: pages,
      freelistPages,
      activeBytes: Math.max(0, pages - freelistPages) * pageSize,
      // 物理门槛使用批准的 decimal 1.5 GB，避免与 GiB 换算混淆。
      targetBytes: 1_500_000_000,
      // 候选扫描不调用 freeze；status 使用与默认 compress 相同的 root 7d / subagent 24h 阈值。
      // 频繁 TUI status 因此不会反过来改变 root time_updated 或 last-message 时钟。
      eligibleOwners: eligibleOwnerCount(db, Date.now(), SEVEN_DAYS_MS),
      coldOwners,
      summaryOwners,
      summaryPayloads: summaryPayloads.length,
      summaryRawBytes: summaryPayloads.reduce((total, row) => total + row.raw_bytes, 0),
      summaryCompressedBytes: summaryPayloads.reduce((total, row) => total + row.compressed_bytes, 0),
      payloads: payloads.length,
      rawBytes,
      compressedBytes,
      // sharedBytes 在 F4 下是真 entry 共享溢价（F4−unique），不能被误读为 SQLite 已释放空间。
      sharedBytes: Math.max(0, rawBytes - referencedRawBytes),
      refCountMismatches,
      orphans,
    }
  })
}

export * as ColdStorage from "./cold"
