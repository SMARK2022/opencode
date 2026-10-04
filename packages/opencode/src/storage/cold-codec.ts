import { createHash } from "node:crypto"
import os from "node:os"
import { Worker, parentPort, workerData } from "node:worker_threads"
import {
  constants as zlibConstants,
  zstdCompressSync as nodeZstdCompressSync,
  zstdDecompressSync as nodeZstdDecompressSync,
} from "node:zlib"
import { Schema } from "effect"
import type { MessageTable, PartTable, PartColdStats } from "@/session/session.sql"
import { MessageID, PartID } from "@/session/schema"
import { Snapshot } from "@/snapshot"
import type { MessageV2 } from "@/session/message-v2"

// 1 MiB 是普通 pack 的目标而非硬上限；单个超大 entry 必须独立保留完整信息而不能截断。
export const PACK_TARGET_BYTES = 1024 * 1024

// 两个运行时共享编码策略，解码协议不依赖这个压缩级别。
const COMPRESSION_LEVEL = 17

export const DEFAULT_BATCH_SIZE = 2000

const isDiffsSchema = Schema.is(Schema.Array(Snapshot.FileDiff))

const isMessageID = Schema.is(MessageID)

// 本模块是 archive payload、owner pointer、codec、refcount 与可逆恢复的唯一语义 owner。
// 前端只能请求业务 Message/Part；是否持久预热由这里和 MessageV2 hydration seam 决定。
function isDiffs(value: unknown): value is readonly Schema.Schema.Type<typeof Snapshot.FileDiff>[] {
  return isDiffsSchema(value)
}

// 空字符串是无 closed Message 的合法 claimed cursor；其他值必须是仓库 MessageID。
export function isSummaryCursor(value: unknown): value is string {
  return value === "" || isMessageID(value)
}

export function isSummarySeed(value: unknown): value is { cursor: string; diffs: SummaryDiffs } {
  // hot seed 与压缩 payload 共用同一 cursor/FileDiff 边界，verify 不能只信 Drizzle 静态类型。
  return isRecord(value) && isSummaryCursor(value.cursor) && isDiffs(value.diffs)
}

export type Owner = { type: "message"; id: MessageID } | { type: "part"; id: PartID }

// hot owner 没有引用；v1 只有 ref，v2 使用完整 key，v3 使用包内 slot。
// 存量版本由持久 envelope 决定，不能因一次解码失败而改猜另一种版本。
export type OwnerKind = Owner["type"]

export type PackKind = "message-pack" | "part-pack"

// 三种持久状态唯一选择 decoder，读取失败后绝不尝试另一格式制造备用成功路径。
export type StorageKind = OwnerKind | PackKind | "session-summary"

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

// payload hash 覆盖 canonical raw bytes 而非 zstd frame，跨平台压缩差异不会改变内容身份。
export type Envelope = { version: 1; owner: OwnerKind; fields: Record<string, Json> }

export type PackEntry = { key: Buffer; fields: Record<string, Json> }

type PackEnvelope = { version: 2 | 3; owner: OwnerKind; entries: PackEntry[] }

export type MessageData<T extends MessageV2.Info = MessageV2.Info> = T extends unknown
  ? Omit<T, "id" | "sessionID">
  : never

export type PartData<T extends MessageV2.Part = MessageV2.Part> = T extends unknown
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

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

// 默认 string sort 比较 UTF-16 code unit，astral key 与 BMP key 的顺序可能不等于持久协议要求的 code point 顺序。
// 显式 comparator 不依赖系统 locale，Windows/Linux/macOS 对同一 Unicode object 必须产生相同 hash。
function compareCodePoints(left: string, right: string) {
  // 相等码点前缀的 UTF-16 宽度也相等；直接迭代，无需每次比较分配两组字符数组。
  for (let index = 0; index < Math.min(left.length, right.length); ) {
    const a = left.codePointAt(index) ?? 0
    const b = right.codePointAt(index) ?? 0
    if (a !== b) return a - b
    index += a > 0xffff ? 2 : 1
  }
  return left.length - right.length
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
export function canonical(value: unknown) {
  return JSON.stringify(json(value))
}

// owner kind 进入 digest 可隔离 Message 与 Part 的恢复 schema，即使 fields JSON 恰好完全相同也不共享。
// hash 只覆盖 canonical raw bytes；compressed frame 的实现差异不能改变内容地址和 fork 引用身份。
// SHA-256 collision 被后续 raw size、kind、codec 和解压后 digest 复验共同视为 corruption，而非去重命中。
export function digest(owner: StorageKind, raw: Uint8Array) {
  // owner prefix 防止相同 JSON 值在 Message/Part 两种恢复语义之间错误共享。
  // NUL 是不可能出现在固定 owner 名中的稳定分隔符，hash 输入因此没有拼接歧义。
  return createHash("sha256")
    .update(owner)
    .update(Buffer.from([0]))
    .update(raw)
    .digest("hex")
}

export function packKind(owner: OwnerKind): PackKind {
  return owner === "message" ? "message-pack" : "part-pack"
}

function slotKey(index: number): Buffer {
  // 四字节是包内序号，完整内容身份仍由包和 entry 的 SHA-256 校验。
  // 固定小端编码避免宿主机器字节序进入持久协议。
  // slot 只在所属不可变包内有意义，重打包后必须重新分配。
  const key = Buffer.alloc(4)
  key.writeUInt32LE(index)
  return key
}

// entry key 只覆盖 owner kind 与冷字段，pack hash 则覆盖整个排序后的 entries；两层地址分别服务去重和批量读取。
// binary key 固定 32 bytes，避免 SQLite text 编码/大小写差异改变同一 entry 的身份。
export function entryKey(owner: OwnerKind, fields: Record<string, Json>) {
  // fields 已由 jsonObject 递归验证并排序；这里直接编码，避免每个 owner 再完整遍历一次大 metadata/output。
  const raw = Buffer.from(JSON.stringify(fields))
  return Buffer.from(digest(owner, raw), "hex")
}

// pack 内同 key 只保存一份 fields；多个 owner 仍各自持有 cold_ref/ref_count，展开时按 owner 数递减。
// entries 按 binary key 排序而非插入顺序，跨批次、Windows/Linux 和 fork 都能得到同一 pack hash。
export function packEnvelope(owner: OwnerKind, entries: PackEntry[]) {
  // 去重对象是完整字段集合，工具的内部 schema 和字段关系保持原样。
  // 不把相同字段拆成跨包引用树，避免读取一个 owner 时递归追踪多个包。
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
  // 排序按完整内容摘要固定，调用方传入顺序不会改变 slot 的含义。
  // 行 ID 和时间不参与正文身份，因此 fork 可以继续共享不可变内容。
  const value = {
    version: 3 as const,
    owner,
    entries: values.map((entry) => entry.fields),
  }
  const raw = Buffer.from(canonical(value))
  // base64url 保留全部 256 bit，缩短每个 owner 的引用而不截断摘要。
  return {
    value,
    raw,
    hash: Buffer.from(digest(packKind(owner), raw), "hex").toString("base64url"),
    entries: values,
    keys: new Map(values.map((entry, index) => [entry.key.toString("hex"), slotKey(index)])),
  }
}

function parsePackEnvelope(owner: OwnerKind, raw: Uint8Array, hash: string): PackEnvelope {
  // 新格式省去可重算的 entry 摘要，包级完整摘要仍覆盖全部原始字节。
  // 保留 canonical 校验，禁止只改 JSON 排版就绕过唯一内容身份。
  let value: unknown
  try {
    value = JSON.parse(Buffer.from(raw).toString("utf8"))
  } catch (cause) {
    throw new CorruptionError({ message: `Cold pack is not JSON: ${String(cause)}`, hash })
  }
  if (
    !isRecord(value) ||
    (value.version !== 2 && value.version !== 3) ||
    value.owner !== owner ||
    !Array.isArray(value.entries)
  ) {
    throw new CorruptionError({ message: "Cold pack envelope does not match its owner", hash })
  }
  const entries = value.entries.map((item) => {
    // v3 的字段本身就是 entry 身份来源；旧包的显式 key 继续逐项验证。
    if (value.version === 3) {
      const fields = jsonObject(item)
      return { key: entryKey(owner, fields), fields }
    }
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
  const parsed: PackEnvelope = { version: value.version, owner, entries }
  const canonicalValue = {
    version: value.version,
    owner,
    entries:
      value.version === 3
        ? entries.map((entry) => entry.fields)
        : entries.map((entry) => ({ key: entry.key.toString("hex"), fields: entry.fields })),
  }
  if (!Buffer.from(canonical(canonicalValue)).equals(Buffer.from(raw))) {
    throw new CorruptionError({ message: "Cold pack is not canonical JSON", hash })
  }
  return parsed
}

// 压缩适配器固定产生标准 zstd frame，数据库不保存 Bun/Node 平台标记，保证跨平台可展开。
// 17级在当前包规模下兼顾耗时与密度，编码工作由显式维护承担。
// codec 不可用是环境错误，不能回退为 gzip；静默混用格式会让 codec 列失去完整性约束。
// 同步 API 只在维护批次或单 owner freeze 内调用，前端请求不会在每次上下文构建时重新压缩。
export function compress(raw: Uint8Array, threads = 0) {
  try {
    // 统一适配器让 Bun 和 Node 都能表达原生线程预算，帧仍由标准 zstd 解码器读取。
    return nodeZstdCompressSync(raw, {
      params: {
        [zlibConstants.ZSTD_c_compressionLevel]: COMPRESSION_LEVEL,
        // 普通包由 JS 池分摊；独占作业才借用池预算，避免两层并行相乘。
        [zlibConstants.ZSTD_c_nbWorkers]: threads,
        // 按源大小分配作业，避免原生默认大块只供给少数线程；0沿用普通包的库默认值。
        [zlibConstants.ZSTD_c_jobSize]: threads ? Math.ceil(raw.byteLength / threads) : 0,
      },
    })
  } catch (cause) {
    throw new CodecUnavailableError({ message: `zstd compression unavailable: ${String(cause)}` })
  }
}

// 解压异常统一转成 corruption，业务读取必须 hard-fail，不能把热 projection 的空字符串发给模型。
// Bun 与 Node 都读取同一 frame；该 seam 是跨平台差异的唯一 owner，调用方不判断当前运行时。
// raw size 与 digest 在 decode 中另行核验，因此成功返回 bytes 不代表 payload 已经可信。
export function decompress(payload: Uint8Array) {
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
export function parseEnvelope(owner: OwnerKind, raw: Uint8Array, hash: string): Envelope {
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
export function summaryEnvelope(payload: SummaryPayload) {
  if (!isSummaryPayload(payload))
    throw new CorruptionError({ message: "Session summary payload fails schema validation" })
  const fields = payload.seed
    ? { seed: { cursor: payload.seed.cursor, diffs: payload.seed.diffs }, delta: payload.delta }
    : { delta: payload.delta }
  const value = { version: 2 as const, owner: "session-summary" as const, fields }
  const raw = Buffer.from(canonical(value))
  return { value, raw, hash: digest("session-summary", raw) }
}

export function parseSummaryEnvelope(raw: Uint8Array, hash: string): SummaryPayload {
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
  // 抽取只作用于经过资格判定的维护写入；流式生产者继续写完整业务对象。
  // 原始 token/cost 数字留在同行，统计读取无需恢复诊断明细。
  if (data.role === "assistant") {
    // 生命周期和 provider token 保热；完整读取统一恢复历史诊断字段。
    const projection = structuredClone(data)
    const fields: Record<string, unknown> = {}
    for (const key of ["path", "inputChars", "inputTokens", "inputBreakdown"] as const) {
      const value = data[key]
      if (value !== undefined) fields[key] = value
    }
    delete projection.path
    delete projection.inputChars
    delete projection.inputTokens
    delete projection.inputBreakdown
    return Object.keys(fields).length ? { projection, fields: jsonObject(fields) } : undefined
  }
  // user summary 的 title/body 继续支撑列表定位，只把大 diff 内容外移。
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

// Message extraction 复用统一字段白名单，不以单 owner 大小排除批量压缩收益。
// entry 身份只取抽取字段，热的生命周期变更不会改变共享正文。
export function extractMessageV2(data: (typeof MessageTable.$inferSelect)["data"]) {
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

// tuple 是已发布的持久编码：版本号、判别标签和字段位置发布后都不可变更。
// 写入与解析共用同一份组件键序，任何一侧单独漂移都会被对侧按损坏数据拒绝。
const STATS_TUPLE_VERSION = 2

const STATS_TAG_TOOL = 0

const STATS_TAG_STEP_FINISH = 1

const TOOL_STATS_TUPLE_LENGTH = 4

const STEP_COMPONENT_KEYS = Object.keys(emptyPartComponents()) as (keyof ReturnType<typeof emptyPartComponents>)[]

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
  const inputTokens =
    finiteStat(data.tokens.input) + finiteStat(data.tokens.cache.read) + finiteStat(data.tokens.cache.write)
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
    const inputChars =
      data.state.status === "pending"
        ? data.state.raw.length
        : JSON.stringify(storedRecord(data.state.input, "Stored tool input is invalid")).length
    // completed output 包含 attachment URL；error 只计 error，未完成状态不猜测稳定输出。
    const outputChars =
      data.state.status === "completed"
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
  // 这里只校验键集合，排序属于持久 canonical 协议；统计形状检查无需反复排序字符串。
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
}

function statInteger(value: unknown, message: string, hash?: string) {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value
  throw new CorruptionError({ message, hash })
}

// v2 Stats 在投影损坏后不得解码 pack 兜底，必须独立验证 exact version/type/keys。
// 此 parser 同时服务 Stats 和 verify，维护命令不会采用更宽松的投影规则。
export function parsePartStats(value: unknown, hash?: string): PartColdStats {
  // 固定长度同时拒绝缺项和多余项，不能把版本标签当作业务计数。
  // 兼容旧对象是为了读取已发布数据；新 tuple 出错仍按损坏上报。
  // tuple 只压缩字段名；还原后继续通过原有整数和 exact-shape 校验。
  if (Array.isArray(value) && value[0] === STATS_TUPLE_VERSION) {
    if (value[1] === STATS_TAG_TOOL && value.length === TOOL_STATS_TUPLE_LENGTH)
      return parsePartStats({ version: 1, type: "tool", inputChars: value[2], outputChars: value[3] }, hash)
    // step 长度由键序派生而非硬编码，组件增减时两侧同步失效而不是静默错位。
    if (value[1] === STATS_TAG_STEP_FINISH && value.length === STEP_COMPONENT_KEYS.length + 2)
      return parsePartStats(
        {
          version: 1,
          type: "step-finish",
          components: Object.fromEntries(STEP_COMPONENT_KEYS.map((key, index) => [key, value[index + 2]])),
        },
        hash,
      )
    throw new CorruptionError({ message: "Cold Stats tuple has an invalid shape", hash })
  }
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

export function requirePartStats(
  row: Pick<typeof PartTable.$inferSelect, "cold_ref" | "cold_stats">,
  expected: PartColdStats | null,
) {
  if (expected === null) {
    if (row.cold_stats !== null)
      throw new CorruptionError({
        message: "Non-Stats Part has a cold Stats projection",
        hash: row.cold_ref ?? undefined,
      })
    return null
  }
  if (row.cold_stats === null)
    throw new CorruptionError({ message: "Stats Part is missing its cold projection", hash: row.cold_ref ?? undefined })
  const stored = parsePartStats(row.cold_stats, row.cold_ref ?? undefined)
  // 两侧均已是固定形状的标量统计，直接逐值核对，保留精度而省去两次 canonical/JSON 分配。
  const matches =
    stored.type === "tool" && expected.type === "tool"
      ? stored.inputChars === expected.inputChars && stored.outputChars === expected.outputChars
      : stored.type === "step-finish" &&
        expected.type === "step-finish" &&
        STEP_COMPONENT_KEYS.every((key) => stored.components[key] === expected.components[key])
  if (!matches) {
    throw new CorruptionError({
      message: "Part cold Stats projection does not match its payload",
      hash: row.cold_ref ?? undefined,
    })
  }
  return stored
}

export function compactPartStats(value: PartColdStats | null) {
  // 输入来自同一统计 projector 或已重建的 parser 对象，字段顺序具有单一来源。
  // 精确数值直接搬运，不通过压缩后的空字符串重新估算字符或 token。
  if (!value) return null
  // 两种投影使用独立标签；写入同样按 STEP_COMPONENT_KEYS 取值，与解析共用唯一键序来源。
  return value.type === "tool"
    ? [STATS_TUPLE_VERSION, STATS_TAG_TOOL, value.inputChars, value.outputChars]
    : [STATS_TUPLE_VERSION, STATS_TAG_STEP_FINISH, ...STEP_COMPONENT_KEYS.map((key) => value.components[key])]
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
    if (data.state.metadata !== undefined)
      fields["state.metadata"] = storedJson(data.state.metadata, "Stored error tool metadata is invalid")
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
    if (data.snapshot !== undefined)
      fields.snapshot = storedJson(data.snapshot, "Stored step-start snapshot is invalid")
    if (data.inputChars !== undefined)
      fields.inputChars = storedJson(data.inputChars, "Stored step-start inputChars is invalid")
    if (data.inputTokens !== undefined)
      fields.inputTokens = storedJson(data.inputTokens, "Stored step-start inputTokens is invalid")
    if (data.inputBreakdown !== undefined)
      fields.inputBreakdown = storedJson(data.inputBreakdown, "Stored step-start breakdown is invalid")
  }
  if (data.type === "step-finish") {
    if (data.snapshot !== undefined)
      fields.snapshot = storedJson(data.snapshot, "Stored step-finish snapshot is invalid")
    if (data.inputChars !== undefined)
      fields.inputChars = storedJson(data.inputChars, "Stored step-finish inputChars is invalid")
    if (data.inputBreakdown !== undefined)
      fields.inputBreakdown = storedJson(data.inputBreakdown, "Stored step-finish breakdown is invalid")
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

// Text metadata 保热，reviewID 和可见性查询无需打开正文包。
// 根正文继续服务直接 SQL 搜索；只有子 Session 的完整正文进入冷包。
export function extractPartCore(data: (typeof PartTable.$inferSelect)["data"], child: boolean | undefined) {
  if (data.type === "text" && child !== undefined) {
    if (!child) return
    const fields = jsonObject({ text: data.text })
    return { projection: { ...data, text: "" }, key: entryKey("part", fields), fields }
  }
  const value = extractPart(data)
  if (!value) return
  return { projection: value.projection, key: entryKey("part", value.fields), fields: value.fields }
}

// Message restore 按角色接受明确白名单，不能把 Part 字段或未知路径合入业务对象。
// user 的 summary 容器和 assistant 的生命周期继续由热行承担权威。
// FileDiff 通过 Effect Schema 重新验证，外部 SQL 写入的任意 JSON 不能借 thaw 冒充完整业务类型。
// 返回对象是完整替换输入；后续修改非冷字段时 diffs 会自然随对象保留，不需要 touched-field 猜测。
export function restoreMessage(data: (typeof MessageTable.$inferSelect)["data"], value: Envelope, hash: string) {
  // 回填完整字段而非摘要，provider 重放与 TUI 明细获得同一份原始值。
  // 恢复只修改 clone；事务回滚时不会向其他消费者暴露半恢复对象。
  if (data.role === "assistant") {
    const restored = structuredClone(data)
    for (const [field, item] of Object.entries(value.fields)) {
      if (field === "path" && isRecord(item) && typeof item.cwd === "string" && typeof item.root === "string") {
        restored.path = { ...item, cwd: item.cwd, root: item.root }
        continue
      }
      if (
        (field === "inputChars" || field === "inputTokens") &&
        typeof item === "number" &&
        Number.isSafeInteger(item) &&
        item >= 0
      ) {
        restored[field] = item
        continue
      }
      if (field === "inputBreakdown" && isRecord(item)) {
        // 与 Step 的历史读取合同一致，保留已存 breakdown 的全部键和值。
        Object.assign(restored, { inputBreakdown: item })
        continue
      }
      throw new CorruptionError({ message: `Assistant cold field is invalid: ${field}`, hash })
    }
    return restored
  }
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
export function restorePart(data: (typeof PartTable.$inferSelect)["data"], value: Envelope, hash: string) {
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
    if (
      field === "state.metadata" &&
      restored.type === "tool" &&
      (restored.state.status === "completed" || restored.state.status === "error")
    ) {
      restored.state.metadata = storedRecord(fieldValue, "Tool metadata is not an object")
      continue
    }
    if (field === "metadata" && (restored.type === "tool" || restored.type === "reasoning")) {
      restored.metadata = storedRecord(fieldValue, "Part metadata is not an object")
      continue
    }
    if (field === "text" && (restored.type === "reasoning" || restored.type === "text")) {
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
    if ((field === "inputChars" || field === "inputTokens") && restored.type === "step-start") {
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
    if (field === "inputBreakdown" && (restored.type === "step-start" || restored.type === "step-finish")) {
      restored.inputBreakdown = storedRecord(
        fieldValue,
        "Step input breakdown is not an object",
      ) as typeof restored.inputBreakdown
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
export function restorePackedMessage(
  data: (typeof MessageTable.$inferSelect)["data"],
  fields: Record<string, Json>,
  hash: string,
) {
  return restoreMessage(data, { version: 1, owner: "message", fields }, hash)
}

export function restorePackedPart(
  data: (typeof PartTable.$inferSelect)["data"],
  fields: Record<string, Json>,
  hash: string,
) {
  return restorePart(data, { version: 1, owner: "part", fields }, hash)
}

// canonical pack 的数组/entry 标点大小可精确增量计算；不能为每个 owner 重编码整个候选 pack，
// 否则大 Session 会退化为 O(n²)。duplicate key 不增加 raw bytes，但 owner 仍留在当前 chunk 贡献 refcount。
export function splitPacks<T extends { entry: PackEntry }>(owner: OwnerKind, items: T[]) {
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
    const entryBytes = Buffer.byteLength(fields)
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

// decodePayload 是 decodePack 的纯字节核心：不触碰 SQLite，worker 与主线程共享同一校验路径。
// 地址编码与包版本分别校验：改写版本会重建包地址，包内条目的内容身份仍可用于共享。
export function decodePayload(
  owner: OwnerKind,
  payload: {
    hash: string
    kind: string
    codec: string
    payload: Uint8Array
    raw_bytes: number
    compressed_bytes: number
  },
) {
  if (payload.kind !== packKind(owner) || payload.codec !== "zstd") {
    throw new CorruptionError({ message: "Cold pack kind or codec is invalid", hash: payload.hash })
  }
  const raw = checkedRaw(packKind(owner), payload)
  // 地址正确仍不足以接受任意 JSON；包内排序决定了持久 slot 的含义。
  const parsed = parsePackEnvelope(owner, raw, payload.hash)
  return Object.assign(
    new Map(
      parsed.entries.map((entry, index) => [
        (parsed.version === 3 ? slotKey(index) : entry.key).toString("hex"),
        entry.fields,
      ]),
    ),
    // 保留已验证的摘要，重打包可复用它而无需再遍历每个字段计算身份。
    { content: parsed.entries },
  )
}

// worker 接收存储端已判定的抽取资格，协议只携带恢复和统计核实所需的数据。
export type PackWireRow = {
  id: string
  // 保留缺失定位的事实，由统一解码门禁报告损坏owner。
  coldKey: string | null
  // 这是存储快照上的抽取决定，worker执行字段变换，提交端仍复核owner。
  merge: boolean
  // 仅Text抽取需要父关系，其他类型不携带Session实体。
  child?: boolean
  // data只用于新增抽取和Tool/StepFinish统计核实，其余正文由冷包恢复。
  data?: (typeof MessageTable.$inferSelect)["data"] | (typeof PartTable.$inferSelect)["data"] | undefined
  // part 行的持久统计投影（小字段），worker 就地与推导值比对；漂移即整批失败，不占主线程。
  coldStats?: (typeof PartTable.$inferSelect)["cold_stats"] | null
}

export type PackWire = { payload: Uint8Array; raw_bytes: number; compressed_bytes: number }

// worker 端按源包驻留的 entry 缓存：scan 写入，encode 按键取用，字段正文不离开 worker。
export type PackEntryCache = Map<string, Record<string, Json>>

export type PackScanResult = {
  // 一个条目可被多个 owner 共用，因此逐行回传目的身份，不能按条目数代替引用数。
  rows: Array<{ id: string; key: string }>
  // merge 行的缩减投影随结果回传（量小）；新字段正文留在缓存等 encode。
  merges: Array<{ id: string; key: string; projection: unknown }>
  // 该源的完整输出 entry 集合（键 + canonical 字节估计），供主线程去重与分块。
  entries: Array<{ key: string; bytes: number }>
}

// 与串行时代同一语义：entry 缺失/统计漂移即整批失败，worker 只是把同一份校验放到别的线程执行。
function scanPack(
  input: { hash: string; owner: OwnerKind; pack: PackWire; rows: PackWireRow[] },
  cachePut: (entries: PackEntryCache) => void,
): PackScanResult {
  const decoded = decodePayload(input.owner, {
    hash: input.hash,
    kind: packKind(input.owner),
    codec: "zstd",
    payload: input.pack.payload,
    raw_bytes: input.pack.raw_bytes,
    compressed_bytes: input.pack.compressed_bytes,
  })
  const lookupToKey = new Map<string, string>()
  // 定位键随包版本而变，后续去重统一使用字段摘要，避免把 slot 当成跨包身份。
  const carried: PackEntryCache = new Map()
  let index = 0
  for (const [lookup, fields] of decoded) {
    // decoder 已校验并算出完整内容摘要，scan 复用它，避免重复序列化与 SHA-256。
    const key = decoded.content[index++].key.toString("hex")
    lookupToKey.set(lookup, key)
    carried.set(key, fields)
  }
  const result: PackScanResult = { rows: [], merges: [], entries: [] }
  const removed = new Set<string>()
  // 同一旧条目可以同时有 merge 与 carry owner；后者仍需引用原字段。
  const kept = new Set<string>()
  for (const row of input.rows) {
    const fields = row.coldKey ? decoded.get(row.coldKey) : undefined
    // 每个传入 owner 都必须能定位原条目，遗漏不能被当成可忽略的空内容。
    if (!fields) throw new CorruptionError({ message: "Repack owner entry is missing", hash: input.hash })
    const key = lookupToKey.get(row.coldKey ?? "") ?? ""
    if (row.merge && row.data !== undefined) {
      const value =
        input.owner === "message"
          ? extractMessageV2(
              restorePackedMessage(row.data as (typeof MessageTable.$inferSelect)["data"], fields, input.hash),
            )
          : extractPartCore(
              restorePackedPart(row.data as (typeof PartTable.$inferSelect)["data"], fields, input.hash),
              row.child,
            )
      if (value) {
        const mergedKey = value.key.toString("hex")
        // 新旧字段在该源的临时映射内并存，等全部 owner 处理后再决定旧键是否仍被需要。
        removed.add(key)
        carried.set(mergedKey, value.fields)
        // merge 行必须没有统计投影（merge 会清空 stats），与串行时代 requirePartStats(null) 同一语义。
        if (input.owner === "part") requirePartStats({ cold_ref: input.hash, cold_stats: row.coldStats ?? null }, null)
        result.rows.push({ id: row.id, key: mergedKey })
        // 只有新增抽取会改变热投影；普通搬运保持原有 data 和统计列。
        result.merges.push({ id: row.id, key: mergedKey, projection: value.projection })
        continue
      }
      // 保热字段可能通过年龄判定，抽取为空时仍保留原条目与热投影。
    }
    kept.add(key)
    result.rows.push({ id: row.id, key })
    if (input.owner === "part") {
      // 统计核实需要完整对象；只有 tool/step-finish 行携带了 data。worker 就地与持久投影比对，漂移即批次失败。
      const expected = row.data
        ? projectPartStats(restorePackedPart(row.data as (typeof PartTable.$inferSelect)["data"], fields, input.hash))
        : null
      requirePartStats({ cold_ref: input.hash, cold_stats: row.coldStats ?? null }, expected)
    }
  }
  const output: PackEntryCache = new Map()
  for (const [key, fields] of carried) {
    // 只有已被新字段取代且无人继续使用的旧键才退出本源输出。
    if (removed.has(key) && !kept.has(key)) continue
    output.set(key, fields)
  }
  // 内容地址用于校验，缓存句柄由调用方的请求生命周期决定。
  cachePut(output)
  // 分块预算使用 UTF-8 字节；字符串字符数会低估中文及其他多字节正文。
  result.entries = [...output].map(([key, fields]) => ({ key, bytes: Buffer.byteLength(JSON.stringify(fields)) }))
  return result
}

export type PackedChunk = {
  hash: string
  // 主线程以 raw 核对同地址已有内容；不同线程参数生成的压缩帧可以不同。
  raw: Uint8Array
  payload: Uint8Array
  // slot 绑定规范排序后的条目次序，完成先后顺序不能改变 owner 的定位。
  slots: Array<readonly [string, string]>
}

function encodePackChunks(
  input: { hash: string; handle: number; owner: OwnerKind; chunks: string[][] },
  cache: ReadonlyMap<number, PackEntryCache>,
  threads = 0,
) {
  const entries = cache.get(input.handle)
  // 句柄释放后内容已失去本次调用的所有权，继续编码必须失败。
  if (!entries) throw new CorruptionError({ message: "Pack worker cache miss for encode", hash: input.hash })
  const packs = input.chunks.map((keys) =>
    encodePack(
      input.owner,
      keys.map((key) => {
        const fields = entries.get(key)
        if (!fields) throw new CorruptionError({ message: "Pack chunk references a missing entry", hash: input.hash })
        return { key: Buffer.from(key, "hex"), fields }
      }),
      // 同源 chunks 顺序编码，原生预算在各包之间复用。
      threads,
    ),
  )
  return { packs }
}

function encodePack(owner: OwnerKind, entries: PackEntry[], threads = 0): PackedChunk {
  // 首次冷冻与重打包共享内容身份和 slot 分配，线程只改变执行位置。
  const value = packEnvelope(owner, entries)
  return {
    // 内容地址在压缩之前生成，压缩级别和线程数不进入身份计算。
    hash: value.hash,
    raw: value.raw,
    payload: compress(value.raw, threads),
    slots: [...value.keys].map(([key, slot]) => [key, slot.toString("hex")] as const),
  }
}

function checkedRaw(
  kind: StorageKind,
  input: { hash: string; payload: Uint8Array; raw_bytes: number; compressed_bytes: number },
) {
  if (input.payload.byteLength !== input.compressed_bytes)
    throw new CorruptionError({ message: "Cold compressed size does not match", hash: input.hash })
  const raw = decompress(input.payload)
  // hash 的 owner 前缀阻止不同业务种类误用相同字节。
  const identity = digest(kind, raw)
  // pack 的两种已发布地址分别为 hex 和 base64url，单 owner 与摘要继续使用 hex。
  const matches =
    identity === input.hash ||
    ((kind === "message-pack" || kind === "part-pack") &&
      Buffer.from(identity, "hex").toString("base64url") === input.hash)
  // 解压成功并不代表帧与数据库记录对应，长度和内容摘要仍须同时成立。
  if (raw.byteLength !== input.raw_bytes || !matches)
    throw new CorruptionError({ message: "Cold size or hash does not match", hash: input.hash })
  return raw
}

function recodeFrame(
  input: {
    kind: StorageKind
    hash: string
    payload: Uint8Array
    raw_bytes: number
    compressed_bytes: number
  },
  threads = 0,
) {
  const raw = checkedRaw(input.kind, input)
  // 重压缩保持原始 canonical 字节，各种已发布 envelope 使用各自的校验器。
  if (input.kind === "session-summary") parseSummaryEnvelope(raw, input.hash)
  else if (input.kind === "message-pack" || input.kind === "part-pack")
    parsePackEnvelope(input.kind === "message-pack" ? "message" : "part", raw, input.hash)
  // 旧单owner格式使用原解析器，帧重编码不会顺带升级其包结构。
  else parseEnvelope(input.kind, raw, input.hash)
  // 重新编码原始字节，保留历史 envelope 版本和其中所有字段。
  return compress(raw, threads)
}

declare const OPENCODE_COMPILED: boolean | undefined

declare const OPENCODE_PACK_WORKER_PATH: string | undefined

function packWorkerUrl() {
  if (typeof OPENCODE_COMPILED !== "undefined" && OPENCODE_COMPILED) {
    // compiled 运行时只走 bunfs entrypoint，不回退 checkout 源码；缺失即安装损坏。
    if (typeof OPENCODE_PACK_WORKER_PATH === "undefined")
      throw new Error("Cold pack worker is missing from this installation")
    return OPENCODE_PACK_WORKER_PATH
  }
  return new URL("./cold-codec.ts", import.meta.url)
}

// 池规模取 75% 核数：主线程仍需核跑 SQLite 读写与组装；上限 12 避免大核数机器的调度与内存放大。
const PACK_POOL_SIZE = Math.min(12, Math.max(2, Math.ceil(os.cpus().length * 0.75)))
const PACK_WORKER_ID = "opencode-cold-codec"

type PackCallMap = {
  // 首次冻结还没有旧包，直接发送已抽取的字段并接收完整待提交包。
  pack: [{ owner: OwnerKind; entries: Array<{ key: Uint8Array; fields: Record<string, Json> }> }, PackedChunk]
  // 解码后的正文驻留所属线程，只把规划需要的身份与大小送回主线程。
  scan: [Parameters<typeof scanPack>[0], PackScanResult & { handle: number }]
  // chunks 引用 scan 的缓存，句柄使编码始终回到拥有正文的线程。
  encode: [Parameters<typeof encodePackChunks>[0], { packs: PackedChunk[] }]
  // 原位重编码沿用原内容地址，调用方负责比较收益并提交帧。
  recode: [Parameters<typeof recodeFrame>[0], Uint8Array]
  // 显式释放的是本次扫描句柄，同内容的另一份在飞扫描保持独立。
  drop: [{ handle: number }, void]
}

// 执行器只属于一次维护，句柄因此隔离数据库与资格快照；同 hash 的两次 scan 不共享可变缓存。
export function createPackEncoder() {
  const workers: Worker[] = []
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>()
  let sequence = 0
  let nextWorker = 0
  // 首个关闭原因同时决定在飞请求与后续调用的失败结果。
  let closed: Error | undefined
  // prepare 的失败收尾与 maintain 的 finally 共享实际退出的等待对象。
  let closing: Promise<number[]> | undefined
  const close = (error = new Error("Cold pack encoder closed")) => {
    if (closed) return closing
    // 先封闭入口再终止线程，退出事件重入close时会复用同一次收尾。
    closed = error
    for (const job of pending.values()) job.reject(error)
    pending.clear()
    // task 的 finally 等待线程实际退出，后续维护复用进程时前一批已完成资源收尾。
    closing = Promise.all(workers.map((worker) => worker.terminate()))
    return closing
  }
  const call = <K extends keyof PackCallMap>(
    op: K,
    input: PackCallMap[K][0],
    transfer: ArrayBuffer[] = [],
    exclusive = false,
  ) => {
    // 独占由维护队列保证，编码器只分配预算，不维护另一套任务调度状态。
    if (closed) return Promise.reject<PackCallMap[K][1]>(closed)
    // 空任务和只读报告只创建轻量执行器，不支付线程启动成本。
    if (!workers.length) {
      for (let index = 0; index < PACK_POOL_SIZE; index++) {
        const worker = new Worker(packWorkerUrl(), { workerData: PACK_WORKER_ID })
        worker.on("message", (message: { id: number; result: unknown; error?: string }) => {
          const job = pending.get(message.id)
          // 关闭会先结算并清空请求；随后到达的回复已没有接收者。
          if (!job) return
          pending.delete(message.id)
          // 空错误消息仍是错误，不能用字符串 truthiness 判断成功。
          if (message.error !== undefined) job.reject(new Error(message.error))
          else job.resolve(message.result)
        })
        // 一个线程故障即终止本次执行器，绝不自动补员重试或丢下无法结算的 RPC。
        worker.on("error", () => close(new Error("Cold pack worker crashed")))
        worker.on("exit", () => close(new Error("Cold pack worker exited")))
        workers.push(worker)
      }
    }
    // 仅新源推进轮转；encode/drop 不消耗槽位，否则三步调用会永久跳过部分线程。
    const slot = "handle" in input ? input.handle % workers.length : nextWorker++ % workers.length
    // 唯一请求号编码所属槽位，保留 scan 句柄的固定路由而无需额外生命周期映射表。
    const id = ++sequence * workers.length + slot
    const worker = workers[slot]
    return new Promise<PackCallMap[K][1]>((resolve, reject) => {
      // 请求号绑定发起时的操作型；专属 dispatcher 按同一协议返回结果。
      pending.set(id, { resolve: (value) => resolve(value as PackCallMap[K][1]), reject })
      try {
        // 调度方声明队列独占；线程数量仍由执行器的统一池预算决定。
        worker.postMessage({ id, op, input, threads: exclusive ? PACK_POOL_SIZE : 0 }, transfer)
      } catch (error) {
        // 序列化或发送失败也走统一收尾，已登记的 promise 不会遗留在 pending 中。
        close(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }
  return { call, close }
}

// bun:sqlite 返回的 Buffer 视图底层 buffer 可能大于视图；传输前按视图精确拷贝，避免泄露无关内存块。
export function transferCopy(view: Uint8Array) {
  const copy = new Uint8Array(view)
  return { copy, buffer: copy.buffer }
}

type PackRequest = {
  [K in keyof PackCallMap]: { id: number; op: K; input: PackCallMap[K][0]; threads?: number }
}[keyof PackCallMap]

function replyBytes(view: Uint8Array): Uint8Array<ArrayBuffer> {
  // 回复移交独占 buffer；slab 视图先取有效区间，避免把相邻数据一起转移。
  if (view.buffer instanceof ArrayBuffer && view.byteOffset === 0 && view.byteLength === view.buffer.byteLength)
    return new Uint8Array(view.buffer)
  return new Uint8Array(view)
}

function replyPack(pack: PackedChunk) {
  return { ...pack, raw: replyBytes(pack.raw), payload: replyBytes(pack.payload) }
}

// 只有执行器创建的专属线程注册 dispatcher；主线程及其他 worker 保留各自的消息协议。
if (workerData === PACK_WORKER_ID && parentPort) {
  const port = parentPort
  const cache = new Map<number, PackEntryCache>()
  port.on("message", (message: PackRequest) => {
    const { id, op, input } = message
    try {
      if (op === "pack") {
        // structured clone 的 key 为 Uint8Array；在字节核心前恢复 Buffer 的 hex 接口。
        const result = replyPack(
          encodePack(
            input.owner,
            input.entries.map((entry) => ({
              key: Buffer.from(entry.key),
              fields: entry.fields,
            })),
          ),
        )
        port.postMessage({ id, result }, [result.raw.buffer, result.payload.buffer])
        return
      }
      if (op === "scan") {
        // 使用请求号作缓存键，同一个 hash 被再次扫描也不会覆盖前一次字段。
        const result = scanPack(input, (entries) => cache.set(id, entries))
        port.postMessage({ id, result: { ...result, handle: id } })
        return
      }
      if (op === "encode") {
        const result = {
          packs: encodePackChunks(input, cache, message.threads).packs.map(replyPack),
        }
        // 消息引用与 transfer 使用同一 buffer，实际移交 raw 和压缩帧的所有权。
        port.postMessage(
          { id, result },
          result.packs.flatMap((pack) => [pack.raw.buffer, pack.payload.buffer]),
        )
        return
      }
      if (op === "drop") {
        // 回复表明该句柄的字段已经释放，批次可据此结束资源生命周期。
        cache.delete(input.handle)
        port.postMessage({ id, result: undefined })
        return
      }
      // 同步编码完成后才回传，线程预算保持在该 RPC 的生命周期内。
      const result = replyBytes(recodeFrame(input, message.threads))
      port.postMessage({ id, result }, [result.buffer])
    } catch (error) {
      // 存储提交依赖成功回复；编码错误通过同一个请求号交回维护流程。
      port.postMessage({ id, error: error instanceof Error ? error.message : String(error) })
    }
  })
}

export * as ColdCodec from "./cold-codec"
