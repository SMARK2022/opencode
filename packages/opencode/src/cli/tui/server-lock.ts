import path from "path"
import { rename, rm } from "fs/promises"
import { createHash, randomUUID } from "crypto"
import { Global } from "@opencode-ai/core/global"
import { InstallationChannel } from "@opencode-ai/core/installation/version"
import { Database } from "@opencode-ai/core/database/database"
import { ServerAuth } from "@/server/auth"
import { InstallationVersion } from "@opencode-ai/core/installation/version"

export type ServerLock = {
  pid: number
  port: number
  token: string
  dbPath: string
  channel: string
  startedAt: string
  externalUrl?: string
  network?: ReturnType<typeof resolveNetworkOptionsNoConfig>
  // #259：daemon control 私有端口——随机分配写入 lock，stop/status 通过 token 鉴权
  controlPort?: number
}
import type { resolveNetworkOptionsNoConfig } from "@/cli/network"

// 数据库路径不打开连接；路径统一后再比较身份。
export function identity() {
  const dbPath = path.normalize(Database.path())
  return { dbPath: process.platform === "win32" ? dbPath.toLowerCase() : dbPath, channel: InstallationChannel }
}

// HTTP listener 读取当前 env；显式传入相同值，避免 Flag 缓存与实际认证配置分叉。
export function headers(credentials: ServerAuth.Credentials = {
  password: process.env.OPENCODE_SERVER_PASSWORD ?? "",
  username: process.env.OPENCODE_SERVER_USERNAME ?? "opencode",
}) {
  return ServerAuth.headers(credentials)
}

// #259：daemon control 是本机私有通道——端口随机写入 lock，token 复用 lock token
// 只服务 CLI/TUI 的 stop/status，不进入公共 HTTP API、OpenAPI 或 SDK
export const CONTROL_SHUTDOWN_PATH = "/shutdown"
export const CONTROL_STATUS_PATH = "/status"
export const CONTROL_TOKEN_HEADER = "x-opencode-daemon-token"

// #152：写锁前若已有存活 pid，拒绝覆盖
export class ExistingLiveServerError extends Error {
  constructor(public readonly lock: ServerLock) {
    super(`Existing live opencode daemon is still running: pid=${lock.pid}, port=${lock.port}`)
    this.name = "ExistingLiveServerError"
  }
}

// 测试覆盖只影响发现文件；不改写 Global 路径或打开临时数据库连接。
let _lockPath: string | undefined
export function _setLockPath(p: string | undefined) {
  _lockPath = p
}

// 显式锁路径是部署隔离边界，不能在失败时擅自改用另一个 XDG 文件继续启动。
function getLockPath() {
  return _lockPath ?? process.env.OPENCODE_LOCK_PATH ?? path.join(Global.Path.state, "tui-server.json")
}

// DB/channel 决定主发现身份；网络参数不分裂同库 owner，显式锁路径仍优先。
export function placement() {
  if (_lockPath || process.env.OPENCODE_LOCK_PATH) return getLockPath()
  const key = createHash("sha256").update(JSON.stringify(identity())).digest("hex").slice(0, 24)
  return path.join(Global.Path.state, `tui-server-${key}.json`)
}

export async function write(
  port: number,
  externalUrl?: string,
  network?: ServerLock["network"],
  controlPort?: number,
): Promise<string> {
  // network 保持第三参数和既有身份语义，私有 controlPort 只追加为第四参数。
  // #152：已有存活 owner 时拒绝写锁，防止双 daemon
  const existing = await read()
  if (existing && alive(existing.pid) && existing.pid !== process.pid) {
    throw new ExistingLiveServerError(existing)
  }
  // token 区分同 PID 的历次启动，旧退出清理不能删除新启动发布的 owner。
  const token = randomUUID()
  const lock: ServerLock = {
    pid: process.pid,
    port,
    token,
    ...identity(),
    startedAt: new Date().toISOString(),
    ...(externalUrl ? { externalUrl } : {}),
    ...(network ? { network } : {}),
    // #259：controlPort 是 daemon stop 的本机私有入口，不进入公共 HTTP/OpenAPI
    ...(controlPort ? { controlPort } : {}),
  }
  const tmp = getLockPath() + ".tmp"
  await Bun.write(tmp, JSON.stringify(lock, null, 2))
  // 完整记录用 rename 一次发布，contender 不会读到只有 PID 的半份锁。
  await rename(tmp, getLockPath())
  return token
}

// 缺失或损坏记录不能提供可信 PID；权限错误另行抛出，不能伪装成不存在。
export async function read(lockPath = getLockPath()): Promise<ServerLock | undefined> {
  // 只有不存在才视为无 owner；权限或 I/O 故障必须向上失败，不能启动备用 daemon。
  const raw = await Bun.file(lockPath).text().catch((error: unknown) => {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return undefined
    throw error
  })
  if (!raw) return
  try {
    const lock: unknown = JSON.parse(raw)
    // 锁是外部输入，字段错误不能成为 process.kill(0) 或任意端口探测的依据。
    if (!lock || typeof lock !== "object" || !("pid" in lock) || !("port" in lock) ||
      typeof lock.pid !== "number" || !Number.isSafeInteger(lock.pid) || lock.pid <= 0 ||
      typeof lock.port !== "number" || !Number.isInteger(lock.port) || lock.port < 1 || lock.port > 65535 ||
      !("token" in lock) || typeof lock.token !== "string" || !lock.token ||
      !("dbPath" in lock) || typeof lock.dbPath !== "string" || !lock.dbPath ||
      !("channel" in lock) || typeof lock.channel !== "string" || !lock.channel ||
      !("startedAt" in lock) || typeof lock.startedAt !== "string") return
    return lock as ServerLock
  } catch {
    return undefined
  }
}

// force 只容忍已不存在；权限/I/O 错误必须让选举失败，不能吞掉后继续覆盖 owner。
export async function clear(lockPath = getLockPath()) {
  await rm(lockPath, { force: true })
}

export async function clearIfOwner(token: string, lockPath = getLockPath()) {
  const lock = await read(lockPath)
  // 只删除调用方所见 token 的 owner；复读发现换主便放弃，旧进程存活也不授权清理新锁。
  if (lock?.token !== token) return
  await clear(lockPath)
}

export function alive(pid: number) {
  // PID 0/负数具有进程组语义，在 OS 调用前拒绝无效 PID。
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    // signal 0 只检查进程存在性，健康与身份仍由发现链独立验证。
    process.kill(pid, 0)
    return true
  } catch (e) {
    // 仅 EPERM 表示进程存在；其他异常返回不存活，存在性本身不授权删锁或终止进程。
    return typeof e === "object" && e !== null && "code" in e && e.code === "EPERM"
  }
}

export async function ping(port: number, credentials?: ServerAuth.Credentials) {
  try {
    // 固定 loopback 地址，发现文件只提供端口，不提供任意主机访问授权。
    const resp = await fetch(`http://127.0.0.1:${port}/global/health`, {
      // 保留受保护的健康路由，401 不能被当作陈旧 owner 并覆盖锁。
      headers: headers(credentials),
      // 500ms deadline 覆盖响应与 body；超时或 401 均不授权清理存活 owner。
      signal: AbortSignal.timeout(500),
    })
    // 健康 JSON 与当前版本均匹配才可复用，不能接受任意监听者的 200。
    if (!resp.ok) return false
    const body = await resp.json()
    return body?.healthy === true && body.version === InstallationVersion
  } catch {
    return false
  }
}

export * as ServerLock from "./server-lock"
