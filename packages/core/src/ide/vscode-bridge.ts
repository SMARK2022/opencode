export * as VscodeBridge from "./vscode-bridge"

import fs from "fs/promises"
import os from "os"
import path from "path"
import { fileURLToPath } from "url"
import { Global } from "../global"

// 健康检查超时 2 秒（500ms→2000ms：兼容高延迟网络）：平衡响应速度和误判风险
// 健康检查超时：过短会在慢机上误杀存活桥接
const DEFAULT_HEALTH_TIMEOUT = 2_000
// 过期 TTL 60 秒（15s→60s：兼容慢心跳环境）：无心跳超过此时间的桥接视为过期
// 注册过期窗口：结合心跳信任避免误删活跃实例
// stale 60s：registry 清理与发现评分共用同一老化阈值
const DEFAULT_STALE_MS = 60_000
// 心跳信任期：10 秒内的桥接跳过健康检查
// 心跳信任窗内跳过 health，降低探活噪声
// 心跳信任窗口 10s：过期条目不得当作在线桥
const DEFAULT_HEARTBEAT_TRUST_MS = 10_000
// 解析缓存 5 秒：避免频繁扫描锁文件目录
const RESOLVE_CACHE_MS = 5_000

// 桥接条目：包含端口、token、工作区路径和心跳时间
export type BridgeEntry = {
  schema: 1
  id: string
  pid: number
  port: number
  token: string
  host?: string
  transport: "http"
  ideName: string
  ideKind: "vscode"
  remoteName?: string | null
  createdAt: number
  updatedAt: number
  workspaceFolders: Array<{
    name: string
    uri: string
    fsPath?: string
  }>
  active?: {
    textEditor?: string
    notebook?: string
  }
  capabilities?: Record<string, boolean>
}

// 桥接引用：精简的桥接信息，用于匹配和调用
export type BridgeRef = Pick<BridgeEntry, "id" | "port" | "token"> & {
  host: string
  score?: number
  source: "env" | "registry"
}

type ResolveInput = {
  cwd: string
  // notebook 工具强制带 filePath，与扩展侧锁键一致
  filePath?: string
  staleMs?: number
  healthTimeoutMs?: number
}

type CallInput = {
  cwd: string
  path: string
  body: Record<string, unknown>
  filePath?: string
  signal?: AbortSignal
  timeoutMs?: number
}

// 桥接缓存：5 秒 TTL，避免频繁扫描注册目录和发起健康检查
let cachedRegistryBridge:
  | {
      cwd: string
      filePath?: string
      expiresAt: number
      bridge: BridgeRef
    }
  | undefined

// 全局请求队列：序列化所有桥接 HTTP 请求，防止并发 notebook 工具调用竞争同一 VS Code 桥接
// 全局串行化 CLI→bridge 调用，避免并发打乱会话状态
let bridgeRequestQueue = Promise.resolve()

// 注册目录：每个 VS Code 实例在此目录下写入一个 JSON 注册文件
export function registryDir() {
// 环境变量优先：允许测试和自定义安装指定注册目录路径
  return process.env.OPENCODE_IDE_REGISTRY_DIR ?? path.join(Global.Path.state, "ide")
}

// 发现桥接：扫描注册目录，返回所有可用桥接（PID 存活 + 健康检查通过）
// 扫描本机 registry 目录，返回仍存活的 bridge 列表
// CLI 桥接 API：discoverBridges — 发现/调用 VS Code notebook 能力
export async function discoverBridges(input: ResolveInput): Promise<BridgeEntry[]> {
// 注册目录路径：OPENCODE_IDE_REGISTRY_DIR 环境变量优先，默认为 state/ide
  const dir = registryDir()
// 当前时间戳：用于判断注册条目是否过期
  const now = Date.now()
// 过期阈值：调用方可自定义，默认 60 秒
  const staleMs = input.staleMs ?? DEFAULT_STALE_MS
// 读取注册目录：目录不存在时返回空数组，不抛出异常
  const files = await fs.readdir(dir).catch((error) => {
  // 目录不存在时返回空数组：首次运行时注册目录可能尚未创建
    if (isMissing(error)) return [] as string[]
  // 其他 fs 错误向上抛出：权限不足等错误需要调用方处理
    throw error
  })

// 活跃桥接列表：只包含 PID 存活且健康检查通过的条目
  const live: BridgeEntry[] = []
// 并行检查所有注册文件：Promise.all 确保所有检查完成后才返回
  await Promise.all(
    files
      // 过滤 JSON 文件：注册目录可能包含非 JSON 临时文件
      .filter((file) => file.endsWith(".json"))
      .map(async (file) => {
        // 注册文件完整路径：每个 VS Code 实例一个 JSON 文件
        const filepath = path.join(dir, file)
        // 读取注册条目：解析 JSON 并验证 schema 版本
        const entry = await readEntry(filepath)
        // 无效条目跳过：JSON 解析失败或 schema 不匹配时返回 null
      // 无效条目：JSON 解析失败或 schema 版本不匹配时 readEntry 返回 null
        if (!entry) return
        // 先检查进程存活：进程已死则直接移除注册条目，无需进一步检查
        if (pidDead(entry.pid)) {
// 移除过期注册文件：PID 已死的 VS Code 实例留下的残留文件
          await removeStale(filepath)
          return
        }
        // 注册条目年龄：用于判断是否在心跳信任窗口内
        const age = now - entry.updatedAt
        // 心跳信任窗口：10 秒内的注册条目视为活跃，跳过健康检查以降低延迟
        if (age <= DEFAULT_HEARTBEAT_TRUST_MS) {
          live.push(entry)
          return
        }
        // 超过信任窗口的条目需要健康检查：通过则保留，不通过且超过 staleMs 才移除
        if (await healthCheck(entry, input.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT)) {
          live.push(entry)
          return
        }
        // 过期清理：仅在健康检查失败且超过 staleMs 时删除注册文件
        if (age > staleMs) await removeStale(filepath)
      }),
  )
// 返回活跃桥接列表：已排除过期、PID 失效和健康检查失败的条目
  return live
}

// 解析桥接：通过路径匹配选择最佳桥接，优先选择工作区路径最匹配的
// CLI 桥接 API：resolveBridge — 发现/调用 VS Code notebook 能力
// 发现仅走 registry/cache/健康探测：env 捷径已删除
export async function resolveBridge(input: ResolveInput): Promise<BridgeRef> {
  const now = Date.now()
  if (
    cachedRegistryBridge &&
    cachedRegistryBridge.expiresAt > now &&
    cachedRegistryBridge.cwd === input.cwd &&
    cachedRegistryBridge.filePath === input.filePath
  ) {
    return cachedRegistryBridge.bridge
  }

// 桥接发现：扫描注册目录获取所有活跃桥接
  const entries = await discoverBridges(input)
  const candidates = input.filePath ? entries.filter((entry) => bridgeMatchesFilePath(entry, input.filePath!)) : entries
// 无匹配工作区：有可用桥接但没有匹配请求路径的工作区
  if (entries.length > 0 && candidates.length === 0) {
    throw new Error(`No live VS Code bridge workspace matches filePath: ${input.filePath}. Check the exact notebook path from vscode_notebook_summary.`)
  }

// 评分排序：按工作区路径匹配度和心跳新鲜度排序
  const scored = candidates
    // 评分：健康>心跳新鲜>端口可达，决定 discover 排序
    .map((entry) => ({ entry, score: scoreBridge(entry, input.cwd, input.filePath) }))
    .sort((a, b) => b.score - a.score || b.entry.updatedAt - a.entry.updatedAt)

// 最佳桥接：评分最高的候选
  const best = scored[0]
  if (!best) {
    throw new Error("No live VS Code bridge found. Open this workspace in VS Code or launch opencode from the VS Code extension.")
  }

// 次优桥接：用于检测评分并列的冲突
  const second = scored[1]
  if (second && best.score === second.score && best.entry.updatedAt === second.entry.updatedAt) {
    throw new Error("Multiple matching VS Code bridges found. Specify filePath or focus the desired VS Code workspace.")
  }

// 构建桥接引用：包含连接信息和缓存过期时间
  const bridge = {
    id: best.entry.id,
    host: best.entry.host ?? "127.0.0.1",
    port: best.entry.port,
    token: best.entry.token,
    score: best.score,
    source: "registry",
  } satisfies BridgeRef
// 更新缓存：设置过期时间为当前时间 + RESOLVE_CACHE_MS
  cachedRegistryBridge = {
    cwd: input.cwd,
    filePath: input.filePath,
    expiresAt: Date.now() + RESOLVE_CACHE_MS,
    bridge,
  }
// 返回匹配桥接：工作区路径匹配度最高的桥接
  return bridge
}

// 调用桥接：向 VS Code 扩展发送 HTTP POST 请求，支持超时和中止
// 对指定 bridge 发鉴权 HTTP，并走请求队列
// CLI 桥接 API：callBridge — 发现/调用 VS Code notebook 能力
export async function callBridge(input: CallInput): Promise<unknown> {
  // 入队后 FIFO 执行；失败不阻塞后续任务
  // 客户端全局串行：避免并发 callBridge 打穿扩展侧状态
  // 请求队列：每次 callBridge 通过 enqueueBridgeRequest 序列化，确保同一时刻只有一个 HTTP 请求在途
  return await enqueueBridgeRequest(() => callBridgeOnce(input))
}

// 实际执行桥接调用的函数：从 callBridge 提取，由队列调度
async function callBridgeOnce(input: CallInput): Promise<unknown> {
  await assertExistingLocalFilePath(input.filePath)
// 解析桥接：通过工作区和文件路径匹配最佳桥接
  const bridge = await resolveBridge({ cwd: input.cwd, filePath: input.filePath })
// HTTP 响应：fetchWithTimeout 支持 AbortController 中止
  let response: Response
  try {
    // 发送 HTTP POST：携带 Bearer token 认证，防止未授权调用
    response = await fetchWithTimeout(
      `http://${bridge.host}:${bridge.port}${input.path}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${bridge.token}`,
        },
        body: JSON.stringify(input.body),
      },
      input.timeoutMs,
      input.signal,
    )
// 网络错误处理：清除缓存桥接，下次调用将重新发现
  } catch (error) {
// 失效缓存：桥接可能已关闭或不可达，强制下次重新发现
    invalidateCachedBridge(bridge)
    throw error
  }

// 读取响应体：可能为空（204 No Content）
  const text = await response.text()
// 解析响应体：优先 JSON，失败时保留原始文本
  let value: unknown
  try {
    value = text ? JSON.parse(text) : {}
  } catch {
    value = text
  }

// HTTP 错误：非 2xx 状态码视为失败
  if (!response.ok) {
    const message = errorFromResponse(value) ?? `VS Code bridge request failed with HTTP ${response.status}`
    throw new Error(message)
  }
// 业务错误：HTTP 200 但响应体包含 error 字段
  const error = errorFromResponse(value)
  if (error) throw new Error(error)
  return value
}

// 桥接请求队列调度器：前一个请求完成（或失败）后才执行下一个，finally 确保队列不会卡住
async function enqueueBridgeRequest<T>(operation: () => Promise<T>): Promise<T> {
  const previous = bridgeRequestQueue
  let release!: () => void
  bridgeRequestQueue = new Promise<void>((resolve) => {
    release = resolve
  })
  await previous
  try {
    return await operation()
  } finally {
    release()
  }
}

// 摘要提取：从桥接响应中提取 summary 字段
export function summaryOnly(value: unknown) {
  if (value && typeof value === "object" && "summary" in value && typeof value.summary === "string") {
    return value.summary
  }
  return JSON.stringify(value, null, 2)
}

export function scoreBridge(entry: BridgeEntry, cwd: string, filePath?: string) {
  let score = 0
  const target = filePath ? normalizeInputPath(filePath) : undefined
  const current = normalizeInputPath(cwd)
  const workspaces = entry.workspaceFolders.flatMap((folder) => {
    const values = [folder.fsPath, folder.uri].filter((item): item is string => Boolean(item))
    return values.map(normalizeInputPath).filter((item): item is string => Boolean(item))
  })

  if (target && workspaces.some((folder) => containsPath(folder, target))) score += 3000
  if (current && workspaces.some((folder) => containsPath(folder, current))) score += 2000

  const active = [entry.active?.notebook, entry.active?.textEditor].map(normalizeInputPath)
  if (target && active.some((item) => item && samePath(item, target))) score += 1000
  if (entry.active?.notebook && current && workspaces.some((folder) => containsPath(folder, current))) score += 500

  const age = Math.max(0, Date.now() - entry.updatedAt)
  score += Math.max(0, 100 - Math.floor(age / 1000))
  return score
}

// 工作区匹配：检查桥接的工作区路径是否包含请求的文件路径
function bridgeMatchesFilePath(entry: BridgeEntry, filePath: string) {
  const target = normalizeInputPath(filePath)
  if (!target) return false
  const workspaces = entry.workspaceFolders.flatMap((folder) => {
    const values = [folder.fsPath, folder.uri].filter((item): item is string => Boolean(item))
    return values.map(normalizeInputPath).filter((item): item is string => Boolean(item))
  })
  if (workspaces.some((folder) => containsPath(folder, target))) return true
  return [entry.active?.notebook, entry.active?.textEditor]
    .map(normalizeInputPath)
    .some((active) => active !== undefined && samePath(active, target))
}


// 读取注册条目：解析 JSON，验证 schema 版本和必需字段
async function readEntry(filepath: string) {
  const value = JSON.parse(await fs.readFile(filepath, "utf8")) as unknown
  if (!isRecord(value)) return
  if (value.schema !== 1) return
  if (value.transport !== "http" || value.ideKind !== "vscode") return
  if (typeof value.id !== "string") return
  if (typeof value.pid !== "number") return
  if (typeof value.port !== "number") return
  if (typeof value.token !== "string") return
  if (typeof value.updatedAt !== "number") return
  if (!Array.isArray(value.workspaceFolders)) return
  return value as BridgeEntry
}

// 健康检查：GET /health 验证桥接服务器是否存活
// GET /health：确认 HTTP 端口仍响应
async function healthCheck(entry: Pick<BridgeEntry, "host" | "port">, timeoutMs: number) {
  const response = await fetchWithTimeout(
    `http://${entry.host ?? "127.0.0.1"}:${entry.port}/health`,
    { method: "GET" },
    timeoutMs,
  ).catch(() => undefined)
  return response?.ok === true
}

// 带超时的 fetch：使用 AbortController 在指定时间后中止请求
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs = DEFAULT_HEALTH_TIMEOUT,
  signal?: AbortSignal,
) {
  // 请求可能在排队时已取消，先检查再安装监听，避免迟到发送执行或编辑请求。
  signal?.throwIfAborted()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const abort = () => controller.abort()
  signal?.addEventListener("abort", abort, { once: true })
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
  // 清理定时器：请求完成后立即清除，防止内存泄漏
// 清理定时器：请求完成后立即清除，防止内存泄漏和空回调
    clearTimeout(timer)
    signal?.removeEventListener("abort", abort)
  }
}

// PID 存活检查：通过 process.kill(pid, 0) 测试进程是否存在，不发送信号
function pidDead(pid: number) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    const code = isRecord(error) && typeof error.code === "string" ? error.code : undefined
    return code === "ESRCH"
  }
}

// 路径规范化：将用户输入路径转换为绝对路径，处理 file:// URI 和相对路径
function normalizeInputPath(value?: string) {
  if (!value) return
  let result = value
// file:// URI 转换：VS Code 使用 file:// URI，桥接需要文件系统路径
  if (result.startsWith("file://")) {
    try {
      result = fileURLToPath(result)
    } catch {
      result = decodeURIComponent(new URL(result).pathname)
    }
  }
  result = result.replace(/\\/g, "/").replace(/\/+$/g, "")
  if (/^[a-z]:/i.test(result)) result = result.toLowerCase()
  return result
}

function samePath(left: string, right: string) {
  return normalizeInputPath(left) === normalizeInputPath(right)
}

function containsPath(parent: string, child: string) {
  const folder = normalizeInputPath(parent)
  const target = normalizeInputPath(child)
  if (!folder || !target) return false
  return target === folder || target.startsWith(folder + "/")
}

// 错误提取：从桥接响应中提取错误消息
function errorFromResponse(value: unknown) {
  if (!isRecord(value)) return
  if (typeof value.error === "string") return value.error
  if (value.ok === false) return "VS Code bridge returned ok=false"
}

// 文件存在性检查：确保请求的文件路径在本地存在，防止桥接访问不存在的文件
async function assertExistingLocalFilePath(filePath?: string) {
  const localPath = localPathFromInput(filePath)
  if (!localPath) return
  const stat = await fs.stat(localPath).catch((error) => {
    if (isMissing(error)) {
      throw new Error(`Notebook filePath does not exist exactly: ${filePath}. Reuse the exact path returned by vscode_notebook_summary.`)
    }
    throw error
  })
  if (!stat.isFile()) {
    throw new Error(`Notebook filePath is not a file: ${filePath}`)
  }
}

// 本地路径提取：从 file:// URI 中提取文件系统路径
function localPathFromInput(value?: string) {
  if (!value) return
  if (value.startsWith("file://")) {
    try {
      return fileURLToPath(value)
    } catch {
      return
    }
  }
  if (/^[a-zA-Z]:[\\/]/.test(value)) return value
  if (path.isAbsolute(value)) return value
  return
}

// 失效缓存：当桥接调用失败时清除缓存的桥接引用，强制下次重新发现
function invalidateCachedBridge(bridge: BridgeRef) {
  if (cachedRegistryBridge?.bridge.id === bridge.id) cachedRegistryBridge = undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

// 错误判断：Node.js fs errno ENOENT 表示文件或目录不存在
function isMissing(error: unknown) {
  return isRecord(error) && error.code === "ENOENT"
}

// 移除过期注册文件：catch 忽略文件不存在错误（可能被其他进程删除）
function removeStale(filepath: string) {
  return fs.unlink(filepath).catch((error) => {
    if (isMissing(error)) return
    throw error
  })
}

export function defaultRegistryDirForTests(home = os.homedir()) {
  return path.join(process.env.XDG_STATE_HOME ?? path.join(home, ".local", "state"), "opencode", "ide")
}
