import { randomUUID } from "node:crypto"
import { Schema } from "effect"
import { Database } from "./db"
import { MessageID, PartID, SessionID as SessionIDSchema, type SessionID } from "@/session/schema"
import {
  PACK_TARGET_BYTES,
  DEFAULT_BATCH_SIZE,
  type OwnerKind,
  CorruptionError,
  ValidationError,
  isRecord,
  packEnvelope,
  type PackedChunk,
  createPackEncoder,
  transferCopy,
} from "./cold-codec"
import {
  type StatusReport,
  type VerifyReport,
  type CleanupReport,
  verify,
  cleanup,
  status,
  type EntryLocation,
  type PreparedRepack,
} from "./cold-store"
import { maintenance as store } from "./cold-store"

// 重写批次以解压工作量限流，单个超大 entry 仍沿用完整保存合同。
const REPACK_BATCH_BYTES = 8 * PACK_TARGET_BYTES

// 沿用控制面与CLI共享的owner批量上限，和payload原始字节预算分别限流。
const MAX_BATCH_SIZE = 5000

// MaintenanceRequest 是 daemon control 和 offline CLI 唯一共享的行为联合，operation 决定合法参数。
// confirm/repair/delete 使用显式 boolean，避免模糊 flag 在后端被解释为写授权。
export type MaintenanceRequest =
  | { operation: "compress"; sessionID?: SessionID; olderThanMs: number; batchSize: number; recompress?: boolean }
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

// MaintenanceTask 是可断线查询的控制元数据，与业务内容分离。
export type MaintenanceTask = {
  // 控制面记录独立于冷包格式版本，只用于跨进程查询和恢复。
  version: 1
  taskID: string
  // 记录绑定存储目标，控制层据此识别跨库恢复。
  dbPath: string
  operation: "compress" | "expand" | "verify" | "cleanup"
  // 恢复沿用当初的范围和参数，新命令的默认值不会覆盖它们。
  args: MaintenanceRequest
  status: "queued" | "running" | "interrupted" | "completed" | "failed"
  cursor?: MaintenanceCursor
  // owner阶段统计扫描行，payload阶段统计所检查源包的引用者。
  processed: number
  skipped: number
  failed: number
  // 这些是处理过的包字节，区别于SQLite页面分配和物理回收量。
  rawBytes: number
  compressedBytes: number
  createdAt: number
  updatedAt: number
  error?: string
  // 进度是面向人类的估算快照，不参与恢复语义；缺失时 CLI 回退到脉冲动画。
  // payload阶段以源包数作分母，和processed的owner计数各有用途。
  progress?: { stage: string; done: number; total: number }
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
    // 写入前统一拒绝超限批量，CLI与控制面据同一批量边界建立任务。
    throw new ValidationError({ message: `Maintenance batchSize must be an integer between 1 and ${MAX_BATCH_SIZE}` })
  }
  // NaN age 会使全部 Session 的 eligibility 失真，必须在扫描 owner 前拒绝。
  if (request.operation === "compress" && (!Number.isFinite(request.olderThanMs) || request.olderThanMs < 0)) {
    throw new ValidationError({ message: "compress olderThanMs must be non-negative" })
  }
  // 范围选择按原生布尔值保存，字符串不能意外扩大到全部现有帧。
  if (request.operation === "compress" && request.recompress !== undefined && typeof request.recompress !== "boolean")
    throw new ValidationError({ message: "compress recompress must be boolean" })
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
  // 新请求在这里确定默认批量，恢复任务则另外核验其已经持久化的数值。
  const batchSize = input.batchSize === undefined ? DEFAULT_BATCH_SIZE : Number(input.batchSize)
  switch (input.operation) {
    case "compress":
      if (input.recompress !== undefined && typeof input.recompress !== "boolean")
        throw new ValidationError({ message: "compress recompress must be boolean" })
      return {
        operation: "compress",
        ...(sessionID ? { sessionID } : {}),
        olderThanMs: input.olderThanMs === undefined ? store.SEVEN_DAYS_MS : Number(input.olderThanMs),
        batchSize,
        ...(input.recompress === undefined ? {} : { recompress: input.recompress }),
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
  // compress 在 owner 扫描后进入既有包阶段；expand 仍只接受 owner cursor。
  // 同一个持久任务保留明确阶段，恢复时不能把包 hash 当作 Message ID。
  // cursor 是已提交批次的恢复锚点，缺失时不能默认从头运行并重复 refcount 写入。
  // operation 决定唯一 cursor family，验证后 maintain 无需再解释任意 JSON shape。
  if (!isRecord(input)) throw new ValidationError({ message: "Maintenance task cursor is missing" })
  if ((operation === "compress" && input.stage !== "payload") || operation === "expand") {
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
  if (input.lastHash && !/^(?:[0-9a-f]{64}|[A-Za-z0-9_-]{43})$/.test(input.lastHash)) {
    throw new ValidationError({ message: "Maintenance task payload cursor hash is invalid" })
  }
  return { stage: "payload", lastHash: input.lastHash }
}

// 持久任务是跨进程输入，恢复前核对身份、参数、状态及游标之间的合同。
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
  // 立即返回的只读操作没有恢复阶段，持久记录只能描述有任务生命周期的操作。
  const taskBacked =
    args.operation === "compress" ||
    args.operation === "expand" ||
    (args.operation === "verify" && (args.repair || args.repairToolInput === true)) ||
    (args.operation === "cleanup" && args.delete)
  if (!taskBacked) throw new ValidationError({ message: "Maintenance task contains an immediate operation" })
  // 恢复要求原值已经规范化，不能再用字符串转换或缺省值改变历史范围。
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
  // 老记录可以没有展示快照，已有快照仍需满足计数类型才能安全绘制百分比。
  if (
    input.progress !== undefined &&
    (!isRecord(input.progress) ||
      typeof input.progress.stage !== "string" ||
      typeof input.progress.done !== "number" ||
      !Number.isSafeInteger(input.progress.done) ||
      input.progress.done < 0 ||
      typeof input.progress.total !== "number" ||
      !Number.isSafeInteger(input.progress.total) ||
      input.progress.total < 0)
  ) {
    throw new ValidationError({ message: "Maintenance task progress is invalid" })
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
    // 游标族由操作决定，防止把包地址解释成owner ID或从错误阶段恢复。
    cursor: taskCursor(input.cursor, args.operation),
    processed: taskCounter(input, "processed"),
    skipped: taskCounter(input, "skipped"),
    failed: taskCounter(input, "failed"),
    rawBytes: taskCounter(input, "rawBytes"),
    compressedBytes: taskCounter(input, "compressedBytes"),
    createdAt,
    updatedAt,
    ...(input.error === undefined ? {} : { error: input.error }),
    ...(input.progress === undefined
      ? {}
      : { progress: input.progress as { stage: string; done: number; total: number } }),
  }
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

async function prepareRepackBatch(
  candidates: ReturnType<typeof store.repackCandidates>,
  request: { sessionID?: SessionID; olderThanMs: number; recompress?: boolean },
  known: Map<string, EntryLocation>,
  encoder: ReturnType<typeof createPackEncoder>,
): Promise<PreparedRepack> {
  const { sources, now } = store.readRepackSources(candidates, request)
  // 队列已排空前序批次并隔离超大单源，此时编码器可把池预算用于该源内部。
  const exclusive = candidates.length === 1 && candidates[0].bytes > REPACK_BATCH_BYTES
  // worker 阶段全部并行；任何 corruption/崩溃都直接让批次失败，不写任何行。
  // 字段正文驻留worker缓存，只有键、大小与merge投影回传；统计在worker内核实。
  const scanCalls = sources.map((source) => {
    const payload = transferCopy(source.pack.payload)
    if (source.kind === "recode")
      return encoder.call(
        "recode",
        { kind: source.storageKind, hash: source.hash, ...source.pack, payload: payload.copy },
        [payload.buffer],
        exclusive,
      )
    return encoder.call(
      "scan",
      { hash: source.hash, owner: source.owner, pack: { ...source.pack, payload: payload.copy }, rows: source.wire },
      [payload.buffer],
    )
  })
  // 主线程规划：known 命中与批内首源重复 → 复用既有位置；其余按 canonical 字节估计做 1MB 分块。
  const location = new Map<string, EntryLocation>()
  // 编码结果先留在内存，源快照复核通过后才交给存储模块落盘。
  const freshPacks: Array<{ owner: OwnerKind; pack: PackedChunk }> = []
  try {
    // 立即观察全部 scan 的拒绝；下方仍 await 原 promise，观察者不把失败变成成功。
    const scans = Promise.all(scanCalls)
    void scans.catch(() => {})
    const pendingFresh = new Set<string>()
    const encodeCalls: Promise<void>[] = []
    // 按源顺序领取 scan 保持去重归属；前面的 encode 与后面的 scan 重叠，无全批扫描屏障。
    for (let sourceIndex = 0; sourceIndex < sources.length; sourceIndex++) {
      const source = sources[sourceIndex]
      if (!source) continue
      if (source.kind !== "pack") continue
      const scan = await scanCalls[sourceIndex]
      // 队列同时容纳recode字节与scan规划结果，此处必须得到后者。
      if (scan instanceof Uint8Array)
        throw new CorruptionError({ message: "Unexpected summary result", hash: source.hash })
      const chunks: string[][] = []
      let chunk: string[] = []
      // 与存储端 splitPacks 共用包壳尺寸，字段以 UTF-8 字节计，逗号只在非首项增加。
      const emptyBytes = packEnvelope(source.owner, []).raw.byteLength
      let bytes = emptyBytes
      for (const entry of scan.entries) {
        const identity = `${source.owner}:${entry.key}`
        const hit = known.get(identity)
        if (hit) {
          // known只包含已提交位置，目标在异步窗口内的存活性仍由提交事务确认。
          location.set(identity, hit)
          continue
        }
        // 批内跨源重复由首个源拥有；后续源的同一 entry 在编码解析后指向同一位置。
        if (pendingFresh.has(identity)) continue
        pendingFresh.add(identity)
        // 1MB 是目标而非硬上限；单个超大 entry 必须独立保留完整信息而不能截断。
        if (chunk.length && bytes + entry.bytes + 1 > PACK_TARGET_BYTES) {
          chunks.push(chunk)
          chunk = []
          bytes = emptyBytes
        }
        bytes += entry.bytes + (chunk.length ? 1 : 0)
        chunk.push(entry.key)
      }
      if (chunk.length) chunks.push(chunk)
      // 条目已全部命中去重索引时，只切换引用，无需再次编码。
      if (!chunks.length) continue
      const encoded = encoder
        .call("encode", { hash: source.hash, handle: scan.handle, owner: source.owner, chunks }, [], exclusive)
        .then((result) => {
          for (const pack of result.packs) {
            freshPacks.push({ owner: source.owner, pack })
            // slot来自最终规范排序，不能用输入chunks中的位置代替。
            for (const [key, slot] of pack.slots) {
              location.set(`${source.owner}:${key}`, { hash: pack.hash, key: Buffer.from(slot, "hex") })
            }
          }
        })
      // 后续 scan 可能较慢，先登记 encode 拒绝；整批 await 仍负责传播原始错误。
      void encoded.catch(() => {})
      encodeCalls.push(encoded)
    }
    const completedScans = await scans
    await Promise.all(encodeCalls)
    // 最后一次encode结束后释放句柄，整批返回时已完成缓存收尾。
    await Promise.all(
      // recode未创建字段缓存，只有scan结果拥有待释放句柄。
      completedScans.flatMap((scan) =>
        scan instanceof Uint8Array ? [] : [encoder.call("drop", { handle: scan.handle })],
      ),
    )
    return {
      sources,
      scans: completedScans,
      location,
      freshPacks,
      // 即使源在读取时已被删除，也要跨过本批枚举范围，防止重复扫描。
      lastHash: candidates[candidates.length - 1].hash,
      now,
    }
  } catch (error) {
    // 失败无需逐个驱逐缓存：停止本次维护的线程，同时拒绝所有在飞请求。
    await encoder.close(error instanceof Error ? error : new Error(String(error)))
    throw error
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
    return { type: "vacuum", ...store.vacuum() }
  }

  // 编码在线程中完成，SQLite事务和控制面通知留在任务线程。
  const preparedTask = taskRequest(prepared, runtime)
  // 保持调用方持有的queued/resume记录稳定，运行中状态使用独立对象。
  const task = structuredClone(preparedTask.task)
  // durable 参数只取 task row；resume 不能用新命令行改变尚未处理的 scope。
  const request = preparedTask.request
  if (!runtime.lease) throw new ValidationError({ message: "task-backed maintenance requires a lease" })
  runtime.lease.assertOwned()
  const checkpoint = async () => {
    task.updatedAt = Date.now()
    // callback 只在 DB commit 后通知控制层，外部进度不能领先持久 owner 状态。
    // 回调可保留自己的快照，后续游标推进不会改动它已接收的数据。
    await runtime.checkpoint(structuredClone(task))
  }

  task.status = "running"
  // resume 开始后旧 interrupted error 不再描述当前 attempt；新失败会在 catch 中重新持久化真实原因。
  delete task.error
  await checkpoint()

  const encoder = createPackEncoder()
  try {
    if (request.operation === "verify") {
      // repair task 复用同步 verify 的完整 owner/payload/state 快照，禁止维护第二套 payload-only verdict。
      const report = verify(request)
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
    let packs: ReturnType<typeof store.repackCandidates> | undefined
    const known = new Map<string, EntryLocation>()
    // 进度只服务人类可读的百分比/ETA；总量是 SQL 候选计数估算，崩溃恢复后按剩余量重算。
    // owner 阶段的 processed 本来就按扫描行数累计，因此候选计数与进度口径天然对齐。
    let ownerTotal = 0
    // 恢复后的展示从剩余范围起算，历史累计量继续保留在task.processed中。
    const ownerStart = task.processed
    if ((request.operation === "compress" || request.operation === "expand") && task.cursor && "owner" in task.cursor) {
      ownerTotal = store.countOwnerCandidates(request, task.cursor)
      task.progress = { stage: "owner", done: 0, total: ownerTotal }
    }
    let payloadTotal = 0
    let payloadDone = 0
    // 四批有限供给重叠计算与提交；源 raw 总量限于 32MiB，超大单源独占队列。
    // 该预算只计源字节，owner快照和JSON对象另占内存，最终验收同时记录RSS。
    const queue: Array<{ count: number; bytes: number; prepared: Promise<PreparedRepack> }> = []
    while (!done) {
      runtime.lease.assertOwned()
      if (runtime.signal?.aborted) {
        // finally 关闭执行器并结算预取 RPC，恢复仍从最后一个已提交 cursor 开始。
        task.status = "interrupted"
        await checkpoint()
        return { type: "task", task }
      }

      if (request.operation === "compress" && task.cursor && "stage" in task.cursor) {
        const cursor = task.cursor
        if (!packs) {
          packs = store.repackCandidates(request, cursor.lastHash)
          // 恢复重打包需要内容去重索引；原位帧重压缩沿用现有身份与引用。
          if (cursor.lastHash && packs.some((pack) => pack.repack)) store.restoreRepackIndex(known)
        }
        if (payloadTotal === 0) payloadTotal = packs.length
        while (packs.length && queue.length < 4) {
          // 队列容量按源raw字节计算，压缩率高的包也占用其真实解压预算。
          const buffered = queue.reduce((sum, item) => sum + item.bytes, 0)
          if (queue.length && (packs[0].bytes > REPACK_BATCH_BYTES || buffered >= 4 * REPACK_BATCH_BYTES)) break
          // 一个超大 entry 是不可拆业务对象；它前后的批次不能同时占用队列。
          if (queue.some((item) => item.bytes > REPACK_BATCH_BYTES)) break
          const batch: ReturnType<typeof store.repackCandidates> = []
          let bytes = 0
          // 空批次允许接纳一个超大源，确保完整业务对象仍能前进。
          while (packs.length && (batch.length === 0 || bytes + packs[0].bytes <= REPACK_BATCH_BYTES)) {
            const row = packs.shift()
            if (!row) break
            batch.push(row)
            bytes += row.bytes
          }
          const prepared = prepareRepackBatch(batch, request, known, encoder)
          // 保留原 promise 的拒绝供 FIFO 消费；此观察者仅防止取消后的未处理 rejection。
          void prepared.catch(() => {})
          queue.push({ count: batch.length, bytes, prepared })
        }
        const pending = queue.shift()
        if (!pending) {
          // 候选与在飞队列都耗尽后，才允许写入最终完成状态。
          done = true
        } else {
          const preparedBatch = await pending.prepared
          // 计算期间可能取消或失去lease，写事务前重新确认写入权限。
          runtime.lease.assertOwned()
          if (runtime.signal?.aborted) {
            task.status = "interrupted"
            await checkpoint()
            return { type: "task", task }
          }
          const outcome = store.commitPreparedRepackBatch(preparedBatch, known)
          // FIFO提交后才推进恢复锚点，已算完但未提交的后续批次不计完成。
          task.cursor = { stage: "payload", lastHash: preparedBatch.lastHash }
          task.processed += outcome.processed
          task.skipped += outcome.skipped
          task.rawBytes += outcome.rawBytes
          task.compressedBytes += outcome.compressedBytes
          // 源在读取窗口消失也已被检查过，完成量跟随原候选批次推进。
          payloadDone += pending.count
        }
        task.progress = { stage: "payload", done: payloadDone, total: payloadTotal }
      } else if (request.operation === "compress" || request.operation === "expand") {
        const cold = request.operation === "expand"
        const cursor = task.cursor
        if (!cursor || !("owner" in cursor)) throw new ValidationError({ message: "Invalid owner maintenance cursor" })
        const batch = request.operation === "compress" ? store.prepareFreezeBatch(request, cursor) : undefined
        // 存储快照与编码之间释放写锁；Promise.all 接管各 chunk 的失败，整批成功才进入提交。
        const packs = batch
          ? await Promise.all(
              batch.chunks.map((chunk) =>
                // 首次冻结没有旧冷包，发送已抽取字段并保持chunks的对应顺序。
                encoder.call("pack", {
                  owner: chunk.owner,
                  entries: chunk.items.map((item) => item.entry),
                }),
              ),
            )
          : []
        runtime.lease.assertOwned()
        if (runtime.signal?.aborted) {
          task.status = "interrupted"
          await checkpoint()
          return { type: "task", task }
        }
        const outcome = batch ? store.commitFreezeBatch(batch, packs) : store.expandOwnerBatch(request, cursor)
        if (outcome.empty) {
          // 只管理阶段推进；同一事务内的资格、恢复和引用修改由存储模块完成。
          if (cursor.owner === "message") task.cursor = { owner: "part", lastID: "" }
          else if (cursor.owner === "part")
            task.cursor = cold ? { owner: "session-summary", lastID: "" } : { stage: "payload", lastHash: "" }
          else done = true
        } else {
          task.cursor = outcome.cursor
          task.processed += outcome.processed
          task.skipped += outcome.skipped
          task.rawBytes += outcome.rawBytes
          task.compressedBytes += outcome.compressedBytes
          if (ownerTotal && cursor.owner !== "session-summary")
            task.progress = {
              stage: "owner",
              done: Math.min(task.processed - ownerStart, ownerTotal),
              total: ownerTotal,
            }
        }
      } else if (request.operation === "cleanup") {
        // cleanup 只处理真实 orphan；完整 verify/repair 已在上方单一权威快照完成。
        const cursor = task.cursor
        if (!cursor || !("stage" in cursor)) {
          throw new ValidationError({ message: "Invalid payload maintenance cursor" })
        }
        const outcome = store.cleanupBatch(request, cursor.lastHash)
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

      // 持久快照与通知都发生在提交之后，进度不会领先可恢复的数据状态。
      await checkpoint()
    }
    task.status = "completed"
    // 最终checkpoint也是任务完成的一部分，调用者等它成功后才收到完成结果。
    await checkpoint()
    // snapshot 只含进度指标，不把 Tool output、diff 或 compressed payload 带入控制面。
    return { type: "task", task }
  } catch (error) {
    task.status = runtime.signal?.aborted ? "interrupted" : "failed"
    task.error = String(error)
    await checkpoint()
    // terminal failure 记录后继续抛出，worker/CLI 不得接收 completed 外形或备用成功路径。
    throw error
  } finally {
    // 维护返回后控制层才释放lease，真实线程退出包含在这段生命周期内。
    await encoder.close()
  }
}

export { status } from "./cold-store"
export * as ColdMaintain from "./cold-maintain"
