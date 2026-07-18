import path from "path"
import { readFileSync } from "fs"
import { mkdir, readdir, rename, rm } from "fs/promises"
import { randomUUID } from "crypto"
import { Global } from "@opencode-ai/core/global"
import { InstallationChannel } from "@opencode-ai/core/installation/version"
import { getPath as DatabasePath } from "@/storage/db"
import { parseMaintenanceTask, type MaintenanceTask } from "@/storage/cold"

export type ServerLock = {
  pid: number
  port: number
  token: string
  dbPath: string
  channel: string
  startedAt: string
  externalUrl?: string
  controlPort?: number
}

// daemon control 是本机私有通道：端口随机写入 lock，token 复用 lock token。
// 它只服务 CLI/TUI 的 stop/status，不进入公共 HTTP API、OpenAPI 或 SDK。
export const CONTROL_SHUTDOWN_PATH = "/shutdown"
export const CONTROL_STATUS_PATH = "/status"
export const CONTROL_MAINTENANCE_PATH = "/maintenance"
export const CONTROL_MAINTENANCE_STATUS_PATH = "/maintenance/status"
export const CONTROL_MAINTENANCE_RESUME_PATH = "/maintenance/resume"
export const CONTROL_TOKEN_HEADER = "x-opencode-daemon-token"

export class ExistingLiveServerError extends Error {
  constructor(public readonly lock: ServerLock) {
    super(`Existing live opencode daemon is still running: pid=${lock.pid}, port=${lock.port}`)
    this.name = "ExistingLiveServerError"
  }
}

export class MaintenanceBusyError extends Error {
  constructor(message = "Another database maintenance task owns the lock") {
    super(message)
    this.name = "MaintenanceBusyError"
  }
}

export class MaintenanceLeaseError extends Error {
  constructor(message = "Database maintenance lock is no longer owned") {
    super(message)
    this.name = "MaintenanceLeaseError"
  }
}

// 25ms只决定下一次同rename探测的节奏，不参与lease成功判定或测试的elapsed-time断言。
const MAINTENANCE_RENAME_RETRY_MS = 25
// deadline限制真实损坏锁的等待成本；一秒来源于本仓库641-876ms Windows sharing观测区间。
const MAINTENANCE_RENAME_TIMEOUT_MS = 1_000

// Overrideable for tests; undefined means use the default path.
let _lockPath: string | undefined
export function _setLockPath(p: string | undefined) {
  _lockPath = p
}

function getLockPath() {
  return _lockPath ?? process.env.OPENCODE_LOCK_PATH ?? path.join(Global.Path.state, "tui-server.json")
}

// Write the lock file atomically (tmp → rename) and return the new token so
// the caller can later use clearIfOwner() for safe deletion.
//
// Guards against overwriting a lock owned by a different live process.
export async function write(port: number, externalUrl?: string, controlPort?: number): Promise<string> {
  const existing = await read()

  if (existing && existing.pid !== process.pid && alive(existing.pid)) {
    throw new ExistingLiveServerError(existing)
  }

  const token = randomUUID()
  const lock: ServerLock = {
    pid: process.pid,
    port,
    token,
    dbPath: DatabasePath(),
    channel: InstallationChannel,
    startedAt: new Date().toISOString(),
    ...(externalUrl ? { externalUrl } : {}),
    // controlPort 是 daemon stop 的本机私有入口，不进入公共 HTTP/OpenAPI；
    // stop 命令必须同时持有 lock token 才能请求 daemon 自行 graceful shutdown。
    ...(controlPort ? { controlPort } : {}),
  }
  const tmp = getLockPath() + ".tmp"
  await Bun.write(tmp, JSON.stringify(lock, null, 2))
  await rename(tmp, getLockPath())
  return token
}

export async function read(): Promise<ServerLock | undefined> {
  const raw = await Bun.file(getLockPath())
    .text()
    .catch(() => undefined)
  if (!raw) return
  try {
    return JSON.parse(raw) as ServerLock
  } catch {
    return undefined
  }
}

export async function clear() {
  await rm(getLockPath(), { force: true }).catch(() => undefined)
}

// Only remove the lock if its token matches — prevents a slave TUI or a
// restarted server from deleting a lock it no longer owns.
export async function clearIfOwner(token: string) {
  const lock = await read()
  if (lock?.token !== token) return
  await clear()
}

// Works on all platforms:
// - ESRCH  → process does not exist → dead
// - EPERM  → no permission to signal but process exists (Windows) → alive
// - no err → process exists → alive
export function alive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch (e: any) {
    return e?.code !== "ESRCH"
  }
}

export async function ping(port: number, init?: Pick<RequestInit, "headers">) {
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/global/health`, {
      // /global/health 受同一套 server auth 保护；允许调用方传入 header，避免启用
      // OPENCODE_SERVER_PASSWORD 后把健康 daemon 误判成不可响应。
      ...init,
      signal: AbortSignal.timeout(500),
    })
    return resp.ok
  } catch {
    return false
  }
}

function maintenanceRoot(dbPath = DatabasePath()) {
  return `${dbPath}.maintenance`
}

function maintenanceTaskName(taskID: string) {
  // taskID 直接组成 tasks/<id>.json，只允许内部前缀和安全字符，禁止 status 参数穿越 maintenance root。
  // 长度上限同时约束异常文件名和 control query，不影响 UUID 形式的正常 task identity。
  if (taskID.length > 128 || !/^dbm_[A-Za-z0-9_-]+$/.test(taskID)) {
    throw new MaintenanceLeaseError("Maintenance task ID is invalid")
  }
  return taskID
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

// lease owner 同样是跨进程信任边界；缺字段或错误 dbPath 不能通过类型断言获得删除 lock 的权限。
// parser 返回全新白名单对象，assert/release/reconcile 因而共享完全相同的 token 与 pid 解释。
function maintenanceOwner(raw: string) {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new MaintenanceLeaseError("Database maintenance owner record is corrupt")
  }
  if (
    !isRecord(value) ||
    typeof value.pid !== "number" ||
    !Number.isSafeInteger(value.pid) ||
    value.pid <= 0 ||
    typeof value.token !== "string" ||
    value.token.length > 128 ||
    !/^[A-Za-z0-9_-]+$/.test(value.token) ||
    typeof value.taskID !== "string" ||
    value.taskID.length > 128 ||
    !/^(?:dbm|vacuum)_[A-Za-z0-9_-]+$/.test(value.taskID) ||
    typeof value.dbPath !== "string" ||
    typeof value.startedAt !== "number" ||
    !Number.isSafeInteger(value.startedAt) ||
    value.startedAt < 0
  ) {
    throw new MaintenanceLeaseError("Database maintenance owner record is invalid")
  }
  return {
    pid: value.pid,
    token: value.token,
    taskID: value.taskID,
    dbPath: value.dbPath,
    startedAt: value.startedAt,
  }
}

// task 文件名只由内部生成的 taskID 构造，root 与规范化 dbPath 一一对应，避免不同 channel 互相恢复。
// payload 永远不进入该目录；这里保存的只是 cursor、计数和 terminal/error 控制元数据。
function taskPath(taskID: string, dbPath?: string) {
  return path.join(maintenanceRoot(dbPath), "tasks", `${maintenanceTaskName(taskID)}.json`)
}

// tmp+rename 保证 reader 只看到旧完整 record 或新完整 record，永远不读取半写 JSON。
// tmp 带随机后缀，daemon 与 CLI 即使异常并发 checkpoint 也不会覆盖彼此的临时文件。
// Windows reader 可能在 Bun.file().text() 返回后短暂持有旧句柄；仅对 EPERM/EACCES/EBUSY 有限重试。
// 其他错误和重试耗尽仍向上抛出，maintain 会把 checkpoint 失败记录为 task failure 而不是伪造进度。
async function writeAtomic(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${randomUUID()}.tmp`
  await Bun.write(tmp, JSON.stringify(value, null, 2))
  let lastError: unknown
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await rename(tmp, file)
      return
    } catch (error) {
      lastError = error
      const code = isRecord(error) && typeof error.code === "string" ? error.code : undefined
      if (!code || !["EPERM", "EACCES", "EBUSY"].includes(code) || attempt === 4) break
      await Bun.sleep(25)
    }
  }
  await rm(tmp, { force: true }).catch(() => undefined)
  throw lastError
}

export async function writeMaintenanceTask(task: MaintenanceTask) {
  // checkpoint 也经过 runtime parser，内存状态若产生非法 cursor/counter 不会被原子地持久成“可信”record。
  // parser 重建白名单对象后再序列化，调用方附加的非协议字段不会成为跨版本恢复合同。
  // tmp+rename 只保证写入原子性；此处的 shape 校验另行保证原子写下的是可恢复状态。
  const validated = parseMaintenanceTask(task)
  await writeAtomic(taskPath(validated.taskID, validated.dbPath), validated)
}

export async function readMaintenanceTask(taskID: string, dbPath?: string) {
  const expectedPath = path.resolve(dbPath ?? DatabasePath())
  // task 文件先按当前 DB root 定位，再核对 record 内 dbPath；不能反过来信任文件内容选择要锁的数据库。
  // 规范化 path 消除 Windows 斜杠/相对路径差异，同时保留不同真实 DB 之间的硬隔离。
  const raw = await Bun.file(taskPath(taskID, expectedPath))
    .text()
    .catch(() => undefined)
  if (!raw) return undefined
  try {
    const task = parseMaintenanceTask(JSON.parse(raw))
    // record 所在 root 与内部 dbPath 必须一致，否则 resume 可能锁住一个 DB 却修改当前进程的另一个 DB。
    if (path.resolve(task.dbPath) !== expectedPath)
      throw new MaintenanceLeaseError("Maintenance task database path mismatch")
    return task
  } catch {
    throw new MaintenanceLeaseError(`Maintenance task record is corrupt: ${taskID}`)
  }
}

// list 只枚举 tasks/*.json，lock owner、tmp 文件和未来其他 maintenance metadata 不会被误当成 task。
// 任一损坏 task hard-fail，不能在多个 nonterminal 中悄悄跳过坏记录后选择另一个恢复。
export async function listMaintenanceTasks(dbPath = DatabasePath()) {
  const dir = path.join(maintenanceRoot(dbPath), "tasks")
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  const tasks = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => readMaintenanceTask(entry.name.slice(0, -5), dbPath)),
  )
  return tasks.filter((task): task is MaintenanceTask => task !== undefined)
}

// queued/running 都必须有当前 live lease owner；进程在 writeTask/acquire 或 batch/checkpoint 间退出时统一降为 interrupted。
// completed/failed 是 terminal 事实，不因 lock 文件遗留或 pid 复用重新打开。
// dbPath、taskID 与 pid 三者同时匹配才承认 live owner，避免其他数据库进程让 stale task 永久卡住。
export async function reconcileMaintenanceTask(taskID: string, dbPath = DatabasePath()) {
  const task = await readMaintenanceTask(taskID, dbPath)
  if (!task || (task.status !== "queued" && task.status !== "running")) return task
  const ownerRaw = await Bun.file(path.join(maintenanceRoot(dbPath), "lock", "owner.json"))
    .text()
    .catch(() => undefined)
  const owner = ownerRaw ? maintenanceOwner(ownerRaw) : undefined
  if (
    owner?.taskID === task.taskID &&
    owner.dbPath === path.resolve(dbPath) &&
    typeof owner.pid === "number" &&
    alive(owner.pid)
  ) {
    return task
  }

  // queued/running 只在持有 maintenance lease 时成立；owner 消失或 pid 已死亡时，
  // 已提交批次由 cursor 保留，状态降为 interrupted 后才能安全 resume。
  task.status = "interrupted"
  task.updatedAt = Date.now()
  await writeMaintenanceTask(task)
  return task
}

// 同一 DB 只允许一个 nonterminal task；多个 record 代表外部复制/损坏，必须由用户先检查而非任意挑选。
// 每次查找先 reconcile，startup、status、resume 和新 task 冲突判断共享同一 stale-state 规则。
export async function findNonterminalMaintenanceTask(dbPath = DatabasePath()) {
  const reconciled = await Promise.all(
    (await listMaintenanceTasks(dbPath)).map((task) => reconcileMaintenanceTask(task.taskID, dbPath)),
  )
  const tasks = reconciled
    .filter((task): task is MaintenanceTask => task !== undefined)
    .filter((task) => task.status === "queued" || task.status === "running" || task.status === "interrupted")
  if (tasks.length > 1) throw new MaintenanceBusyError("Multiple nonterminal maintenance tasks require manual repair")
  return tasks[0]
}

export type MaintenanceLease = {
  token: string
  assertOwned: () => void
  release: () => Promise<void>
}

// mkdir(lock) 是 Windows/Linux/macOS 共用的唯一获取条件，不依赖平台 advisory lock。
// dead lock rename 到按旧 token 命名的 tombstone；并发 reclaimer 使用同一目标，只有一个能移动旧 owner。
// winner 仍须重新 mkdir(lock) 才获得新 lease，tombstone 只阻止延迟 reclaimer 搬走刚发布的新 lock。
// owner.json 绑定 pid/token/taskID/dbPath；每批 assertOwned 同步重读，替换后的旧进程不能继续写数据库。
// live owner 一律 busy；release 也只在 token 相同后删除 lock，不能清理重启后另一个 owner 的 lease。
export async function acquireMaintenanceLease(
  task: Pick<MaintenanceTask, "taskID" | "dbPath">,
  dbPath = task.dbPath,
): Promise<MaintenanceLease> {
  const root = maintenanceRoot(dbPath)
  const lockDir = path.join(root, "lock")
  await mkdir(root, { recursive: true })
  const token = randomUUID()
  const owner = {
    pid: process.pid,
    token,
    taskID: task.taskID,
    dbPath: path.resolve(dbPath),
    startedAt: Date.now(),
  }
  try {
    await mkdir(lockDir)
  } catch {
    const ownerRaw = await Bun.file(path.join(lockDir, "owner.json"))
      .text()
      .catch(() => undefined)
    if (!ownerRaw) throw new MaintenanceBusyError("Database maintenance lock has no readable owner")
    const staleOwner = maintenanceOwner(ownerRaw)
    if (staleOwner.dbPath !== path.resolve(dbPath)) {
      throw new MaintenanceLeaseError("Database maintenance owner belongs to a different database")
    }
    if (alive(staleOwner.pid)) throw new MaintenanceBusyError()
    const staleTask = staleOwner.taskID.startsWith("dbm_")
      ? await readMaintenanceTask(staleOwner.taskID, dbPath)
      : undefined
    if (staleTask && (staleTask.status === "queued" || staleTask.status === "running")) {
      staleTask.status = "interrupted"
      staleTask.updatedAt = Date.now()
      await writeMaintenanceTask(staleTask)
    }
    const latestRaw = await Bun.file(path.join(lockDir, "owner.json"))
      .text()
      .catch(() => undefined)
    if (!latestRaw) throw new MaintenanceBusyError("Database maintenance owner changed during stale reclaim")
    const latest = maintenanceOwner(latestRaw)
    if (latest.token !== staleOwner.token || alive(latest.pid)) throw new MaintenanceBusyError()
    // 所有contender都rename到旧token命名的同一tombstone；winner占住目标后，延迟重试不会搬走新lock。
    // 一秒边界覆盖CI已观察到的641-876ms sharing生命周期，同时避免永久等待损坏或长期占用的lock。
    // retry期间不再读取owner；旧目录一旦被winner搬走，其他contender只能失败，不能把新owner误判成旧owner。
    const renameDeadline = Date.now() + MAINTENANCE_RENAME_TIMEOUT_MS
    while (true) {
      try {
        await rename(lockDir, path.join(root, `stale-${staleOwner.token}`))
        break
      } catch (error) {
        const code = isRecord(error) && typeof error.code === "string" ? error.code : undefined
        // 仅NT sharing对应的三类瞬时错误可等待；目标已存在、路径损坏等结果仍立即保持busy语义。
        if (!code || !["EPERM", "EACCES", "EBUSY"].includes(code) || Date.now() >= renameDeadline) {
          throw new MaintenanceBusyError()
        }
        await Bun.sleep(MAINTENANCE_RENAME_RETRY_MS)
      }
    }
    try {
      await mkdir(lockDir)
    } catch {
      throw new MaintenanceBusyError()
    }
  }

  try {
    await writeAtomic(path.join(lockDir, "owner.json"), owner)
  } catch (error) {
    // owner 发布失败时本调用仍是刚 mkdir 的唯一 owner；立即撤销空 lock，避免永久阻塞后续人工恢复。
    await rm(lockDir, { recursive: true, force: true })
    throw error
  }

  const ownerPath = path.join(lockDir, "owner.json")
  const assertOwned = () => {
    try {
      const current = maintenanceOwner(readFileSync(ownerPath, "utf8"))
      if (current.token !== token || current.taskID !== task.taskID || current.dbPath !== path.resolve(dbPath)) {
        throw new MaintenanceLeaseError()
      }
    } catch (error) {
      if (error instanceof MaintenanceLeaseError) throw error
      throw new MaintenanceLeaseError()
    }
  }
  const lease: MaintenanceLease = {
    token,
    assertOwned,
    release: async () => {
      const ownerRaw = await Bun.file(path.join(lockDir, "owner.json"))
        .text()
        .catch(() => undefined)
      if (!ownerRaw) return
      if (maintenanceOwner(ownerRaw).token !== token) return
      await rm(lockDir, { recursive: true, force: true })
    },
  }
  return lease
}

export * as ServerLock from "./server-lock"
