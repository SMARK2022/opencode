import fs from "fs/promises"
import os from "os"
import path from "path"
import { fileURLToPath } from "url"
import { Global } from "@opencode-ai/core/global"

const DEFAULT_HEALTH_TIMEOUT = 2_000
const DEFAULT_HEARTBEAT_TRUST_MS = 10_000
const DEFAULT_STALE_MS = 60_000
const RESOLVE_CACHE_MS = 5_000

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

export type BridgeRef = Pick<BridgeEntry, "id" | "port" | "token"> & {
  host: string
  score?: number
  source: "env" | "registry"
}

type ResolveInput = {
  cwd: string
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

let cachedRegistryBridge:
  | {
      cwd: string
      filePath?: string
      expiresAt: number
      bridge: BridgeRef
    }
  | undefined

let bridgeRequestQueue = Promise.resolve()

export function registryDir() {
  return process.env.OPENCODE_IDE_REGISTRY_DIR ?? path.join(Global.Path.state, "ide")
}

export async function discoverBridges(input: ResolveInput): Promise<BridgeEntry[]> {
  const dir = registryDir()
  const now = Date.now()
  const staleMs = input.staleMs ?? DEFAULT_STALE_MS
  const files = await fs.readdir(dir).catch((error) => {
    if (isMissing(error)) return [] as string[]
    throw error
  })

  const live: BridgeEntry[] = []
  await Promise.all(
    files
      .filter((file) => file.endsWith(".json"))
      .map(async (file) => {
        const filepath = path.join(dir, file)
        const entry = await readEntry(filepath)
        if (!entry) return
        if (pidDead(entry.pid)) {
          await removeStale(filepath)
          return
        }
        const age = now - entry.updatedAt
        if (age <= DEFAULT_HEARTBEAT_TRUST_MS) {
          live.push(entry)
          return
        }
        if (await healthCheck(entry, input.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT)) {
          live.push(entry)
          return
        }
        if (age > staleMs) await removeStale(filepath)
      }),
  )
  return live
}

export async function resolveBridge(input: ResolveInput): Promise<BridgeRef> {
  const env = envBridge()
  if (env && (await healthCheck(env, input.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT))) return env

  const now = Date.now()
  if (
    cachedRegistryBridge &&
    cachedRegistryBridge.expiresAt > now &&
    cachedRegistryBridge.cwd === input.cwd &&
    cachedRegistryBridge.filePath === input.filePath
  ) {
    return cachedRegistryBridge.bridge
  }

  const entries = await discoverBridges(input)
  const candidates = input.filePath ? entries.filter((entry) => bridgeMatchesFilePath(entry, input.filePath!)) : entries
  if (entries.length > 0 && candidates.length === 0) {
    throw new Error(`No live VS Code bridge workspace matches filePath: ${input.filePath}. Check the exact notebook path from vscode_notebook_summary.`)
  }

  const scored = candidates
    .map((entry) => ({ entry, score: scoreBridge(entry, input.cwd, input.filePath) }))
    .sort((a, b) => b.score - a.score || b.entry.updatedAt - a.entry.updatedAt)

  const best = scored[0]
  if (!best) {
    throw new Error("No live VS Code bridge found. Open this workspace in VS Code or launch opencode from the VS Code extension.")
  }

  const second = scored[1]
  if (second && best.score === second.score && best.entry.updatedAt === second.entry.updatedAt) {
    throw new Error("Multiple matching VS Code bridges found. Specify filePath or focus the desired VS Code workspace.")
  }

  const bridge = {
    id: best.entry.id,
    host: best.entry.host ?? "127.0.0.1",
    port: best.entry.port,
    token: best.entry.token,
    score: best.score,
    source: "registry",
  } satisfies BridgeRef
  cachedRegistryBridge = {
    cwd: input.cwd,
    filePath: input.filePath,
    expiresAt: Date.now() + RESOLVE_CACHE_MS,
    bridge,
  }
  return bridge
}

export async function callBridge(input: CallInput): Promise<unknown> {
  return await enqueueBridgeRequest(() => callBridgeOnce(input))
}

async function callBridgeOnce(input: CallInput): Promise<unknown> {
  await assertExistingLocalFilePath(input.filePath)
  const bridge = await resolveBridge({ cwd: input.cwd, filePath: input.filePath })
  let response: Response
  try {
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
  } catch (error) {
    invalidateCachedBridge(bridge)
    throw error
  }

  const text = await response.text()
  let value: unknown
  try {
    value = text ? JSON.parse(text) : {}
  } catch {
    value = text
  }

  if (!response.ok) {
    const message = errorFromResponse(value) ?? `VS Code bridge request failed with HTTP ${response.status}`
    throw new Error(message)
  }
  const error = errorFromResponse(value)
  if (error) throw new Error(error)
  return value
}

async function enqueueBridgeRequest<T>(operation: () => Promise<T>) {
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

function envBridge(): BridgeRef | undefined {
  const rawPort = process.env.OPENCODE_VSCODE_BRIDGE_PORT
  const token = process.env.OPENCODE_VSCODE_BRIDGE_TOKEN
  if (!rawPort || !token) return
  const port = Number(rawPort)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return
  return {
    id: "env",
    host: process.env.OPENCODE_VSCODE_BRIDGE_HOST ?? "127.0.0.1",
    port,
    token,
    source: "env",
  }
}

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

async function healthCheck(entry: Pick<BridgeEntry, "host" | "port">, timeoutMs: number) {
  const response = await fetchWithTimeout(
    `http://${entry.host ?? "127.0.0.1"}:${entry.port}/health`,
    { method: "GET" },
    timeoutMs,
  ).catch(() => undefined)
  return response?.ok === true
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs = DEFAULT_HEALTH_TIMEOUT,
  signal?: AbortSignal,
) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const abort = () => controller.abort()
  signal?.addEventListener("abort", abort, { once: true })
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener("abort", abort)
  }
}

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

function normalizeInputPath(value?: string) {
  if (!value) return
  let result = value
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

function errorFromResponse(value: unknown) {
  if (!isRecord(value)) return
  if (typeof value.error === "string") return value.error
  if (value.ok === false) return "VS Code bridge returned ok=false"
}

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

function invalidateCachedBridge(bridge: BridgeRef) {
  if (cachedRegistryBridge?.bridge.id === bridge.id) cachedRegistryBridge = undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isMissing(error: unknown) {
  return isRecord(error) && error.code === "ENOENT"
}

function removeStale(filepath: string) {
  return fs.unlink(filepath).catch((error) => {
    if (isMissing(error)) return
    throw error
  })
}

export function defaultRegistryDirForTests(home = os.homedir()) {
  return path.join(process.env.XDG_STATE_HOME ?? path.join(home, ".local", "state"), "opencode", "ide")
}
