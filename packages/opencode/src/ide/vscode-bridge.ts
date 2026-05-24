import fs from "fs/promises"
import os from "os"
import path from "path"
import { fileURLToPath } from "url"
import { Global } from "@opencode-ai/core/global"

const DEFAULT_HEALTH_TIMEOUT = 2_000
const DEFAULT_HEARTBEAT_TRUST_MS = 10_000
const DEFAULT_STALE_MS = 60_000
const RESOLVE_CACHE_MS = 5_000

// Corrupt registry files are removed only after a grace window longer than one
// heartbeat interval: the VS Code writer used to update the final JSON file in
// place, so a reader could observe a transient empty/all-NUL file while VS Code
// was still rewriting it. Keeping the 10s window larger than HEARTBEAT_MS
// preserves live bridge recovery while still cleaning truly abandoned corrupt
// manifests on the next discovery pass.
const CORRUPT_REGISTRY_GRACE_MS = 10_000

// The VS Code extension creates registry entries as `${randomUUID()}.json`.
// Discovery deliberately ignores every other `*.json` name so a misconfigured
// OPENCODE_IDE_REGISTRY_DIR cannot make this cleanup path own arbitrary JSON
// files such as settings, notes, quoted names, or shell-looking filenames.
const REGISTRY_MANIFEST_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/i
const CORRUPT_REGISTRY_ENTRY = Symbol("corrupt-vscode-bridge-registry-entry")

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
      registryDir: string
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
      .filter(isRegistryManifestFile)
      .map(async (file) => {
        const filepath = path.join(dir, file)
        const entry = await readEntry(filepath)
        if (entry === CORRUPT_REGISTRY_ENTRY) {
          await removeRegistryFile(dir, file, { olderThanMs: CORRUPT_REGISTRY_GRACE_MS, now }).catch(() => undefined)
          return
        }
        if (!entry) return
        if (pidDead(entry.pid)) {
          await removeRegistryFile(dir, file)
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
        if (age > staleMs) await removeRegistryFile(dir, file)
      }),
  )
  return live
}

export async function resolveBridge(input: ResolveInput): Promise<BridgeRef> {
  const now = Date.now()
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
    registryDir: dir,
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

async function readEntry(filepath: string) {
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

function isRegistryManifestFile(file: string) {
  return REGISTRY_MANIFEST_FILE.test(file)
}

function parseRegistryJson(text: string) {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return CORRUPT_REGISTRY_ENTRY
  }
}

async function removeRegistryFile(dir: string, file: string, options?: { olderThanMs?: number; now?: number }) {
  // This is the only cleanup path for bridge registry entries. Keep all guards
  // here so dead processes, stale manifests, and corrupt-manifest recovery share
  // the same safety invariant: unlink only a direct child with the exact UUID
  // manifest name that the VS Code extension owns, never a directory tree and
  // never an arbitrary JSON file selected through glob expansion or shell syntax.
  if (!isRegistryManifestFile(file)) return
  const filepath = path.join(dir, file)
  const stat = await fs.lstat(filepath).catch((error) => {
    if (isMissing(error)) return
    throw error
  })
  if (!stat) return
  if (!stat.isFile()) return
  if (options?.olderThanMs !== undefined && (options.now ?? Date.now()) - stat.mtimeMs < options.olderThanMs) return
  return fs.unlink(filepath).catch((error) => {
    if (isMissing(error)) return
    throw error
  })
}

export function defaultRegistryDirForTests(home = os.homedir()) {
  return path.join(process.env.XDG_STATE_HOME ?? path.join(home, ".local", "state"), "opencode", "ide")
}
