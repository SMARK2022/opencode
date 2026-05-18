import { Installation } from "@/installation"
import { Server } from "@/server/server"
import * as Log from "@opencode-ai/core/util/log"
import { InstanceRuntime } from "@/project/instance-runtime"
import { Config } from "@/config/config"
import { Flag } from "@opencode-ai/core/flag/flag"
import { AppRuntime } from "@/effect/app-runtime"
import { ensureProcessMetadata } from "@opencode-ai/core/util/opencode-process"
import * as Database from "@/storage/db"
import { ServerLock } from "@/cli/cmd/tui/server-lock"
import { Heap } from "@/cli/heap"
import { onSseClientCountChange } from "@/server/routes/instance/httpapi/handlers/global"
import path from "path"
import { Global } from "@opencode-ai/core/global"
import { resolvePluginTarget, createPluginEntry } from "@/plugin/shared"
import { NetworkProxy } from "@opencode-ai/core/network-proxy"
import { SessionActivity } from "@/session/activity"

ensureProcessMetadata("worker")
NetworkProxy.installGlobalFetch()

await Log.init({
  print: process.argv.includes("--print-logs") || process.env.OPENCODE_PRINT_LOGS === "1",
  dev: Installation.isLocal(),
  level: (() => {
    if (Installation.isLocal()) return "DEBUG"
    return "INFO"
  })(),
})

Heap.start()

process.on("unhandledRejection", (e) => {
  Log.Default.error("rejection", {
    e: e instanceof Error ? e.message : e,
  })
})

process.on("uncaughtException", (e) => {
  Log.Default.error("exception", {
    e: e instanceof Error ? e.message : e,
  })
})

// Pre-warm external plugin imports without making daemon health depend on
// package installation or network access.  This is purely a latency
// optimization: the real plugin loader still owns correctness and errors.
async function warmupExternalPlugins() {
  if (Flag.OPENCODE_PURE) return
  try {
    const configFile = path.join(Global.Path.config, "opencode.json")
    const raw: unknown = await Bun.file(configFile).json().catch(() => ({}))
    if (!raw || typeof raw !== "object") return
    const pluginField = (raw as Record<string, unknown>).plugin
    if (!Array.isArray(pluginField)) return
    const specs: string[] = pluginField.flatMap((p: unknown) =>
      Array.isArray(p) ? (typeof p[0] === "string" ? [p[0] as string] : []) : typeof p === "string" ? [p] : [],
    )
    await Promise.all(
      specs.map(async (spec) => {
        try {
          const target = await resolvePluginTarget(spec)
          if (!target) return
          const entry = await createPluginEntry(spec, target, "server")
          if (entry.entry) await import(entry.entry)
        } catch {}
      }),
    )
  } catch {}
}

// Always start the internal loopback HTTP server first.
const internalServer = await Server.listen({ port: 0, hostname: "127.0.0.1" })

// Start an external HTTP server when the launching TUI requests it.
let externalServer: Awaited<ReturnType<typeof Server.listen>> | undefined
let externalUrl: string | undefined

const externalPort = process.env.OPENCODE_EXTERNAL_PORT
if (externalPort !== undefined) {
  externalServer = await Server.listen({
    port: Number(externalPort),
    hostname: process.env.OPENCODE_EXTERNAL_HOSTNAME ?? "0.0.0.0",
    mdns: process.env.OPENCODE_EXTERNAL_MDNS === "1",
  })
  externalUrl = externalServer.url.toString()
}

// Write the lock file atomically (internal port + optional external URL).
const lockToken = await ServerLock.write(internalServer.port, externalUrl)

// Start the best-effort warm-up only after the lock is visible so a slow npm
// registry or proxy cannot keep the launcher stuck waiting for daemon health.
setTimeout(() => void warmupExternalPlugins(), 0).unref?.()

// ── Graceful shutdown ──────────────────────────────────────────────────────
let shutdownInProgress = false

async function gracefulShutdown() {
  if (shutdownInProgress) return
  shutdownInProgress = true
  Log.Default.info("daemon shutting down")
  await ServerLock.clearIfOwner(lockToken)
  await InstanceRuntime.disposeAllInstances()
  if (externalServer) await externalServer.stop(true)
  await internalServer.stop(true)
  Database.close()
  process.exit(0)
}

process.on("SIGTERM", () => void gracefulShutdown())

// Config reload on SIGUSR2 (Unix only — Windows does not support this signal).
if (process.platform !== "win32") {
  process.on("SIGUSR2", () => {
    AppRuntime.runPromise(Config.Service.use((cfg) => cfg.invalidate())).catch(() => {})
  })
}

// Ensure lock is cleaned up even when the daemon crashes or receives a fatal
// signal.  Placed after gracefulShutdown is defined so the closure is valid.
process.prependListener("unhandledRejection", () => void gracefulShutdown())
process.prependListener("uncaughtException", () => void gracefulShutdown())

// ── Idle timeout ───────────────────────────────────────────────────────────
// Exit 30 s after the last SSE client disconnects AND no session runners are
// active.  The timer only starts after the first connection, so a slow-starting
// TUI does not race the daemon.
const IDLE_TIMEOUT_MS = (() => {
  const value = Number(process.env.OPENCODE_DAEMON_IDLE_TIMEOUT_MS ?? 30_000)
  return Number.isFinite(value) && value >= 0 ? value : 30_000
})()

let hadClient = false
let sseClients = 0
let idleTimer: ReturnType<typeof setTimeout> | undefined

function cancelIdleTimer() {
  if (!idleTimer) return
  clearTimeout(idleTimer)
  idleTimer = undefined
}

function maybeScheduleIdleShutdown() {
  if (!hadClient) return

  // Active work prevents idle shutdown.
  if (sseClients > 0 || SessionActivity.count() > 0) {
    cancelIdleTimer()
    return
  }

  // Already scheduled — let it fire.
  if (idleTimer) return

  idleTimer = setTimeout(() => {
    // Re-check at fire time: a client or runner may have appeared.
    if (sseClients > 0 || SessionActivity.count() > 0) {
      cancelIdleTimer()
      return
    }
    void gracefulShutdown()
  }, IDLE_TIMEOUT_MS)
  idleTimer.unref?.()
}

onSseClientCountChange((count) => {
  sseClients = count
  if (count > 0) hadClient = true
  maybeScheduleIdleShutdown()
})

SessionActivity.onChange(() => {
  maybeScheduleIdleShutdown()
})

// [local-devsmark][deprecated-rpc-thread] Upstream's per-TUI RPC surface was
// intentionally disabled. This worker is the shared daemon process and exposes
// HTTP/SSE via ServerLock instead, so one daemon owns SQLite writes across TUI
// instances. Do not add Rpc.listen/Rpc.emit/Rpc.client paths here unless the
// daemon database ownership model is replaced.
