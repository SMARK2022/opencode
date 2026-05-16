export * as Daemon from "./daemon"

import { resolveNetworkOptionsNoConfig, type NetworkOptions } from "@/cli/network"
import { Filesystem } from "@/util/filesystem"
import { ServerLock } from "@/cli/cmd/tui/server-lock"
import { Flock } from "@opencode-ai/core/util/flock"
import { Global } from "@opencode-ai/core/global"
import { NetworkProxy } from "@opencode-ai/core/network-proxy"
import {
  OPENCODE_PROCESS_ROLE,
  OPENCODE_RUN_ID,
  ensureRunID,
  sanitizedProcessEnv,
} from "@opencode-ai/core/util/opencode-process"
import path from "path"
import { fileURLToPath } from "url"

declare global {
  const OPENCODE_WORKER_PATH: string
}

export const DAEMON_START_TIMEOUT_MS = 60_000
export const SERVER_ELECTION_TIMEOUT_MS = DAEMON_START_TIMEOUT_MS + 15_000
const SERVER_ELECTION_STALE_MS = 5_000
const SERVER_POLL_INTERVAL_MS = 200

type Args = NetworkOptions

// Exposed for tests only.  Keep the daemon spawn path injectable without
// forcing production code through a heavier process abstraction.
let spawnImpl = (cmd: string[], opts: Parameters<typeof Bun.spawn>[1]) => Bun.spawn(cmd, opts)
export const _spawn = (cmd: string[], opts: Parameters<typeof Bun.spawn>[1]) => spawnImpl(cmd, opts)
export function _setSpawn(fn: typeof spawnImpl | undefined) {
  spawnImpl = fn ?? ((cmd, opts) => Bun.spawn(cmd, opts))
}

let reloadTarget: ReturnType<typeof Bun.spawn> | undefined
let reloadForwarderInstalled = false

function forwardReload(proc: ReturnType<typeof Bun.spawn>) {
  if (process.platform === "win32") return
  reloadTarget = proc
  if (reloadForwarderInstalled) return
  reloadForwarderInstalled = true
  process.on("SIGUSR2", () => {
    try {
      reloadTarget?.kill("SIGUSR2")
    } catch {}
  })
}

async function target() {
  if (typeof OPENCODE_WORKER_PATH !== "undefined") return OPENCODE_WORKER_PATH
  const dist = new URL("./cli/cmd/tui/worker.js", import.meta.url)
  if (await Filesystem.exists(fileURLToPath(dist))) return fileURLToPath(dist)
  return fileURLToPath(new URL("./worker.ts", import.meta.url))
}

function applyProxyEnv(env: Record<string, string>) {
  // Merge loopback addresses into NO_PROXY so the daemon never proxies its own
  // server.  This must run for every respawn because reconnect can create a new
  // worker long after the original launcher setup finished.
  const parts = (env.NO_PROXY ?? env.no_proxy ?? "").split(",").map((s) => s.trim()).filter(Boolean)
  const no = NetworkProxy.noProxyString(parts)
  env.NO_PROXY = no
  env.no_proxy = no

  if (process.platform === "win32" || process.platform === "darwin") {
    // The daemon installs a global fetch wrapper that resolves system proxy
    // dynamically per request. Strip inherited shell proxy env so Bun doesn't
    // freeze routing to stale variables captured before the proxy app started.
    for (const key of ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"])
      delete env[key]
    return
  }

  // Linux: normalize proxy env — ensure both casings, HTTPS falls back to HTTP.
  const http = env.HTTP_PROXY ?? env.http_proxy
  const https = env.HTTPS_PROXY ?? env.https_proxy ?? http
  const all = env.ALL_PROXY ?? env.all_proxy
  if (http) {
    env.HTTP_PROXY = http
    env.http_proxy = http
  }
  if (https) {
    env.HTTPS_PROXY = https
    env.https_proxy = https
  }
  if (all) {
    env.ALL_PROXY = all
    env.all_proxy = all
  }
}

function internalUrl(port: number) {
  return `http://127.0.0.1:${port}`
}

function lockUrl(lock: ServerLock, external: boolean) {
  if (external && lock.externalUrl) return lock.externalUrl
  return internalUrl(lock.port)
}

// Determine the URL of an existing daemon owner.
// Returns:
//   - { type: "missing" }        → no lock file exists
//   - { type: "dead", lock }     → pid is dead, lock is stale
//   - { type: "responsive" | "unresponsive", url, lock }
//                                → pid is alive; responsive=HTTP ping OK
//
// CRITICAL: "unresponsive" means the owner process is alive but its control
// plane is temporarily blocked (e.g. during a long model call).  We must NOT
// spawn a second daemon in this state — the single-owner invariant would break.
//
// NOTE: Calls ServerLock.read/alive/ping through the namespace so test spies
// on those exports can intercept the calls.
async function existingOwnerUrl(external: boolean) {
  const lock = await ServerLock.read()

  if (!lock)
    return { type: "missing" as const }

  if (!ServerLock.alive(lock.pid))
    return { type: "dead" as const, lock }

  // pid alive — whether or not HTTP ping succeeded, the owner still exists.
  const responsive = await ServerLock.ping(lock.port)
  return {
    type: responsive ? "responsive" as const : "unresponsive" as const,
    url: lockUrl(lock, external),
    lock,
  }
}

function wantsExternal(args: Args) {
  const network = resolveNetworkOptionsNoConfig(args)
  return {
    network,
    external:
      process.argv.includes("--port") ||
      process.argv.includes("--hostname") ||
      process.argv.includes("--mdns") ||
      network.mdns ||
      network.port !== 0 ||
      network.hostname !== "127.0.0.1",
  }
}

export async function ensure(args: Args) {
  const { network, external } = wantsExternal(args)
  const env = sanitizedProcessEnv({
    [OPENCODE_PROCESS_ROLE]: "worker",
    [OPENCODE_RUN_ID]: ensureRunID(),
  })
  applyProxyEnv(env)
  // Preserve the original TUI launcher behavior: the UI process itself must
  // also bypass proxies for loopback SDK calls, even when an existing daemon is
  // reused and no child process is spawned.
  process.env.NO_PROXY = env.NO_PROXY
  process.env.no_proxy = env.no_proxy

  // Fast path: if an owner is alive (responsive OR unresponsive), reuse it.
  const quick = await existingOwnerUrl(external)
  if (quick.type === "responsive" || quick.type === "unresponsive") return quick.url

  let electionLease: Awaited<ReturnType<typeof Flock.acquire>> | undefined
  try {
    // A shared election lock is required both on initial TUI startup and during
    // later reconnect recovery; otherwise two surviving TUIs can race and spawn
    // duplicate daemon workers after the original process dies.
    electionLease = await Flock.acquire("opencode.server", {
      dir: path.join(Global.Path.state, "locks"),
      timeoutMs: SERVER_ELECTION_TIMEOUT_MS,
      staleMs: SERVER_ELECTION_STALE_MS,
    })

    // Re-check under lock: another TUI may have started a daemon while we waited.
    const existing = await existingOwnerUrl(external)
    if (existing.type === "responsive" || existing.type === "unresponsive") return existing.url

    // Only clear the lock if the owner is truly dead.
    if (existing.type === "dead") await ServerLock.clear()

    const printLogs = process.argv.includes("--print-logs")
    const proc = spawnImpl([process.execPath, await target()], {
      env: {
        ...env,
        ...(printLogs ? { OPENCODE_PRINT_LOGS: "1" } : {}),
        ...(external
          ? {
              OPENCODE_EXTERNAL_PORT: String(network.port),
              OPENCODE_EXTERNAL_HOSTNAME: network.hostname,
              OPENCODE_EXTERNAL_MDNS: network.mdns ? "1" : "",
            }
          : {}),
      },
      stdin: "ignore",
      stdout: printLogs ? "inherit" : "ignore",
      stderr: printLogs ? "inherit" : "ignore",
      // Unix Ctrl+C is delivered to the foreground process group.  Detaching the
      // worker gives it its own group so TUI exits do not accidentally take down
      // the shared daemon.  Windows keeps the existing console-mode guard path.
      detached: process.platform !== "win32",
    })
    proc.unref()
    forwardReload(proc)

    // The daemon cannot be ready immediately: worker startup has to load the
    // server, bind a port, and write the lock atomically before health can pass.
    await Bun.sleep(1000)

    const deadline = Date.now() + DAEMON_START_TIMEOUT_MS
    while (Date.now() < deadline) {
      const lock = await ServerLock.read()
      if (lock && ServerLock.alive(lock.pid)) {
        if (external) {
          if (lock.externalUrl) return lock.externalUrl
        } else if (await ServerLock.ping(lock.port)) {
          return internalUrl(lock.port)
        }
      }
      await Bun.sleep(SERVER_POLL_INTERVAL_MS)
    }

    proc.kill()
    throw new Error(`opencode daemon failed to start within ${DAEMON_START_TIMEOUT_MS / 1000} seconds`)
  } finally {
    await electionLease?.release().catch(() => undefined)
  }
}
