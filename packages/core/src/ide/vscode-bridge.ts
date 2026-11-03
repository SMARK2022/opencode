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

// #219：损坏注册文件的清理宽限窗口——大于心跳间隔，保留活桥恢复能力同时清理真正废弃的损坏清单
// Corrupt registry files are removed only after a grace window longer than one
// heartbeat interval: the VS Code writer used to update the final JSON file in
// place, so a reader could observe a transient empty/all-NUL file while VS Code
// was still rewriting it. Keeping the 10s window larger than HEARTBEAT_MS
// preserves live bridge recovery while still cleaning truly abandoned corrupt
// manifests on the next discovery pass.
const CORRUPT_REGISTRY_GRACE_MS = 10_000

// #219：注册清单文件名匹配 UUID 格式——发现只处理 VS Code 扩展创建的 ${randomUUID()}.json
// The VS Code extension creates registry entries as `${randomUUID()}.json`.
// Discovery deliberately ignores every other `*.json` name so a misconfigured
// OPENCODE_IDE_REGISTRY_DIR cannot make this cleanup path own arbitrary JSON
// files such as settings, notes, quoted names, or shell-looking filenames.
const REGISTRY_MANIFEST_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/i
const CORRUPT_REGISTRY_ENTRY = Symbol("corrupt-vscode-bridge-registry-entry")

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
// 能力元数据沿共享客户端保留，不据此重新启用已停用的LSP后端。
export type BridgeRef = Pick<BridgeEntry, "id" | "port" | "token" | "capabilities"> & {
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
      registryDir: string
      expiresAt: number
      bridge: BridgeRef
    }
  | undefined

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
      // #219：仅匹配 UUID 格式的注册清单——防止误删非 VS Code 扩展创建的 JSON 文件
      .filter(isRegistryManifestFile)
      .map(async (file) => {
        // 注册文件完整路径：每个 VS Code 实例一个 JSON 文件
        const filepath = path.join(dir, file)
        // 读取注册条目：解析 JSON 并验证 schema 版本
        const entry = await readEntry(filepath)
        // #219：损坏条目经宽限期后清理——读取失败或 JSON 语法错误返回 CORRUPT_REGISTRY_ENTRY
        if (entry === CORRUPT_REGISTRY_ENTRY) {
          // #219：清理失败不影响发现——坏条目删除是尽力而为，发现须继续返回活桥
          await removeRegistryFile(dir, file, { olderThanMs: CORRUPT_REGISTRY_GRACE_MS, now }).catch(() => undefined)
          return
        }
        // 无效条目跳过：JSON 解析失败或 schema 不匹配时返回 null
        // 无效条目：JSON 解析失败或 schema 版本不匹配时 readEntry 返回 null
        if (!entry) return
        // 先检查进程存活：进程已死则直接移除注册条目，无需进一步检查
        if (pidDead(entry.pid)) {
          // 移除过期注册文件：PID 已死的 VS Code 实例留下的残留文件
          await removeRegistryFile(dir, file)
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
        if (age > staleMs) await removeRegistryFile(dir, file)
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
  // #219：缓存身份包含 registryDir——测试和自定义部署可更改 OPENCODE_IDE_REGISTRY_DIR 而不改变 cwd/filePath
  // Include the resolved registry directory in the cache identity because tests
  // and custom deployments can move OPENCODE_IDE_REGISTRY_DIR without changing
  // cwd/filePath; returning a bridge from the old directory would cross that
  // explicit isolation boundary for up to RESOLVE_CACHE_MS (5 seconds).
  const dir = registryDir()
  if (
    cachedRegistryBridge &&
    cachedRegistryBridge.expiresAt > now &&
    cachedRegistryBridge.cwd === input.cwd &&
    cachedRegistryBridge.filePath === input.filePath &&
    cachedRegistryBridge.registryDir === dir
  ) {
    return cachedRegistryBridge.bridge
  }

  // 桥接发现：扫描注册目录获取所有活跃桥接
  const entries = await discoverBridges(input)
  const candidates = input.filePath ? entries.filter((entry) => bridgeMatchesFilePath(entry, input.filePath!)) : entries
  // 无匹配工作区：有可用桥接但没有匹配请求路径的工作区
  if (entries.length > 0 && candidates.length === 0) {
    throw new Error(
      `No live VS Code bridge workspace matches filePath: ${input.filePath}. Check the exact notebook path from vscode_notebook_summary.`,
    )
  }

  // 评分排序：按工作区路径匹配度和心跳新鲜度排序
  const scored = candidates
    // 评分：健康>心跳新鲜>端口可达，决定 discover 排序
    .map((entry) => ({ entry, score: scoreBridge(entry, input.cwd, input.filePath) }))
    .sort((a, b) => b.score - a.score || b.entry.updatedAt - a.entry.updatedAt)

  // 最佳桥接：评分最高的候选
  const best = scored[0]
  if (!best) {
    throw new Error(
      "No live VS Code bridge found. Open this workspace in VS Code or launch opencode from the VS Code extension.",
    )
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
    // 保留扩展原始能力声明，实际执行入口仍由产品注册表决定。
    capabilities: best.entry.capabilities,
    score: best.score,
    source: "registry",
  } satisfies BridgeRef
  // 更新缓存：设置过期时间为当前时间 + RESOLVE_CACHE_MS
  cachedRegistryBridge = {
    cwd: input.cwd,
    filePath: input.filePath,
    registryDir: dir,
    expiresAt: Date.now() + RESOLVE_CACHE_MS,
    bridge,
  }
  // 返回匹配桥接：工作区路径匹配度最高的桥接
  return bridge
}

// 调用桥接：向 VS Code 扩展发送 HTTP POST 请求，支持超时和中止
// 对指定bridge发鉴权HTTP，跨文件请求不再共用客户端队列。
// CLI 桥接 API：callBridge — 发现/调用 VS Code notebook 能力
export async function callBridge(input: CallInput): Promise<unknown> {
  // 全局请求队列已移除：服务端 withFileLock 已按 filePath 序列化同一文档的请求，
  // 客户端不再需要全局 Promise 队列。之前的全局队列会把一个长时间 run（最长 50 分钟）
  // 阻塞所有后续 summary/source/edit/env 操作，包括不同 notebook 的请求。
  return await callBridgeOnce(input)
}

// 发现、鉴权、期限和错误传播仍由原调用路径承担。
async function callBridgeOnce(input: CallInput): Promise<unknown> {
  input.signal?.throwIfAborted()
  // 创建的目标本来就可不存在；实际冲突保护由SDK的create入口负责。
  if (input.path !== "/notebook/env" || input.body.operation !== "create") {
    await assertExistingLocalFilePath(input.filePath)
  }
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
  // #219：不可读或并发删除的条目视为缺失——单个损坏文件不得阻止发现其他活桥
  // Treat unreadable or concurrently-removed entries as absent: one bad direct
  // child must not block discovery of another live bridge. Only JSON syntax
  // failures return CORRUPT_REGISTRY_ENTRY, because parsed-but-foreign UUID JSON
  // may belong to a misconfigured directory and must be ignored, not deleted.
  const text = await fs.readFile(filepath, "utf8").catch(() => undefined)
  if (text === undefined) return

  const value = parseRegistryJson(text)
  if (value === CORRUPT_REGISTRY_ENTRY) return value

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
      throw new Error(
        `Notebook filePath does not exist exactly: ${filePath}. Reuse the exact path returned by vscode_notebook_summary.`,
      )
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
// #219：注册清单文件名判定——仅 UUID 格式的 .json 文件由 VS Code 扩展拥有
function isRegistryManifestFile(file: string) {
  return REGISTRY_MANIFEST_FILE.test(file)
}

// #219：安全 JSON 解析——语法错误返回 CORRUPT_REGISTRY_ENTRY 而非抛出
function parseRegistryJson(text: string) {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return CORRUPT_REGISTRY_ENTRY
  }
}

// #219：唯一的注册条目清理路径——仅删除直接子文件且名为 UUID 清单，不删目录树或任意 JSON
// This is the only cleanup path for bridge registry entries. Keep all guards
// here so dead processes, stale manifests, and corrupt-manifest recovery share
// the same safety invariant: unlink only a direct child with the exact UUID
// manifest name that the VS Code extension owns, never a directory tree and
// never an arbitrary JSON file selected through glob expansion or shell syntax.
async function removeRegistryFile(dir: string, file: string, options?: { olderThanMs?: number; now?: number }) {
  if (!isRegistryManifestFile(file)) return
  const filepath = path.join(dir, file)
  const stat = await fs.lstat(filepath).catch((error) => {
    if (isMissing(error)) return
    throw error
  })
  // #219：文件已不存在时跳过——可能被其他进程删除
  if (!stat) return
  // #219：不删除目录——UUID 命名的目录不是注册清单
  if (!stat.isFile()) return
  // #219：宽限期内不删——避免清理 VS Code 正在重写的瞬态损坏文件
  if (options?.olderThanMs !== undefined && (options.now ?? Date.now()) - stat.mtimeMs < options.olderThanMs) return
  return fs.unlink(filepath).catch((error) => {
    if (isMissing(error)) return
    throw error
  })
}

export function defaultRegistryDirForTests(home = os.homedir()) {
  return path.join(process.env.XDG_STATE_HOME ?? path.join(home, ".local", "state"), "opencode", "ide")
}
