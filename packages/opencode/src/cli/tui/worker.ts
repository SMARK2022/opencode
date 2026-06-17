import { Server } from "@/server/server"
import { InstanceRuntime } from "@/project/instance-runtime"
import { Config } from "@/config/config"
import { Flag } from "@opencode-ai/core/flag/flag"
import { AppRuntime } from "@/effect/app-runtime"
import { ensureProcessMetadata } from "@opencode-ai/core/util/opencode-process"
import { ServerLock } from "@opencode-ai/tui/server-lock"
import { Heap } from "@/cli/heap"
import { onSseClientCountChange } from "@/server/routes/instance/httpapi/handlers/global"
import path from "path"
import { Global } from "@opencode-ai/core/global"
import { resolvePluginTarget, createPluginEntry } from "@/plugin/shared"
import { NetworkProxy } from "@opencode-ai/core/network-proxy"
import { SessionActivity } from "@/session/activity"
import { GlobalBus } from "@/bus/global"
import { DisposedReason, Event as ServerEvent } from "@/server/event"
import { Installation } from "@/installation"
import * as Log from "@opencode-ai/core/util/log"

ensureProcessMetadata("worker")
NetworkProxy.installGlobalFetch()

const log = Log.create({ service: "daemon" })

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

// ── Graceful shutdown ──────────────────────────────────────────────────────
let shutdownInProgress = false
let lockToken = ""
let controlServer: ReturnType<typeof Bun.serve> | undefined

async function gracefulShutdown(reason = "unknown") {
  if (shutdownInProgress) return
  shutdownInProgress = true
  cancelIdleTimer("shutdown")
  cancelStartupIdleTimer("shutdown")
  cancelLauncherWatcher("shutdown")
  log.info("daemon shutting down", {
    reason,
    hadClient,
    sseClients,
    sessionActivity: SessionActivity.count(),
  })
  if (reason === DisposedReason.DaemonStop) notifyDaemonStop()
  await InstanceRuntime.disposeAllInstances()
  controlServer?.stop(true)
  if (externalServer) await externalServer.stop(true)
  await internalServer.stop(true)
  // Keep the lock until after disposers and servers stop. Otherwise a
  // reconnecting TUI can spawn a replacement daemon while this process still owns SQLite.
  await ServerLock.clearIfOwner(lockToken)
  process.exit(0)
}

function notifyDaemonStop() {
  GlobalBus.emit("event", {
    directory: "global",
    payload: {
      type: ServerEvent.Disposed.type,
      properties: { reason: DisposedReason.DaemonStop },
    },
  })
}

process.on("SIGTERM", () => void gracefulShutdown("signal:SIGTERM"))

// Config reload on SIGUSR2 (Unix only — Windows does not support this signal).
if (process.platform !== "win32") {
  process.on("SIGUSR2", () => {
    AppRuntime.runPromise(Config.Service.use((cfg) => cfg.invalidate())).catch(() => {})
  })
}

// Ensure lock is cleaned up even when the daemon crashes or receives a fatal
// signal.  Placed after gracefulShutdown is defined so the closure is valid.
process.prependListener("unhandledRejection", () => void gracefulShutdown("unhandledRejection"))
process.prependListener("uncaughtException", () => void gracefulShutdown("uncaughtException"))

// ── Idle timeout ───────────────────────────────────────────────────────────
// daemon 有两段空闲退出保护：
//
// 1. 启动期：lock 写出后、首个 SSE client 连接前，启动 startup idle timer。
//    这段覆盖「daemon 已启动但 TUI 在连上 /global/event 前崩溃或退出」的场景，
//    避免 hadClient 永远为 false 导致 daemon 长时间遗留。
//
// 2. 运行期：一旦至少有一个 SSE client 连接过，之后在最后一个 SSE client
//    断开且没有活跃 session runner 时，按常规 idle timer 延迟退出。
//
// 活跃 SSE client 或 SessionActivity 都会阻止退出；launcher watcher 只在首个
// SSE client 到来前生效，用来更快清理已经失去启动 TUI 接管的孤儿 daemon。
const IDLE_TIMEOUT_MS = (() => {
  // [local-smark] After the last TUI disconnects, keep the daemon around for at most 4s by default.
  const value = Number(process.env.OPENCODE_DAEMON_IDLE_TIMEOUT_MS ?? 4_000)
  return Number.isFinite(value) && value >= 0 ? value : 4_000
})()
const STARTUP_IDLE_TIMEOUT_MS = (() => {
  const value = Number(process.env.OPENCODE_DAEMON_STARTUP_IDLE_TIMEOUT_MS ?? IDLE_TIMEOUT_MS)
  return Number.isFinite(value) && value >= 0 ? value : IDLE_TIMEOUT_MS
})()
const LAUNCHER_PID = (() => {
  const value = Number(process.env.OPENCODE_DAEMON_LAUNCHER_PID)
  return Number.isInteger(value) && value > 0 ? value : undefined
})()
const LAUNCHER_POLL_MS = 1_000

let hadClient = false
let sseClients = 0
let idleTimer: ReturnType<typeof setTimeout> | undefined
let startupIdleTimer: ReturnType<typeof setTimeout> | undefined
let launcherTimer: ReturnType<typeof setInterval> | undefined

// Write the lock file atomically (internal port + optional external URL).
controlServer = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    const url = new URL(request.url)
    if (!lockToken || request.headers.get(ServerLock.CONTROL_TOKEN_HEADER) !== lockToken)
      return new Response("unauthorized", { status: 401 })
    if (request.method === "GET" && url.pathname === ServerLock.CONTROL_STATUS_PATH) {
      return Response.json({ tuiClients: sseClients, sessionActivity: SessionActivity.count() })
    }
    if (request.method !== "POST" || url.pathname !== ServerLock.CONTROL_SHUTDOWN_PATH)
      return new Response("not found", { status: 404 })
    // 这是 daemon stop 的本机私有控制面：只有持有当前 lock token 的调用方
    // 才能让 daemon 自己执行 gracefulShutdown，避免 CLI 直接杀 pid。
    setTimeout(() => void gracefulShutdown(DisposedReason.DaemonStop), 0).unref?.()
    return Response.json({ ok: true })
  },
})
lockToken = await ServerLock.write(internalServer.port, externalUrl, controlServer.port)
log.info("daemon lock written", {
  pid: process.pid,
  port: internalServer.port,
  controlPort: controlServer.port,
  externalUrl,
  launcherPID: process.env.OPENCODE_DAEMON_LAUNCHER_PID,
})

// Start the best-effort warm-up only after the lock is visible so a slow npm
// registry or proxy cannot keep the launcher stuck waiting for daemon health.
setTimeout(() => void warmupExternalPlugins(), 0).unref?.()

function isActive() {
  return sseClients > 0 || SessionActivity.count() > 0
}

function cancelIdleTimer(reason: string) {
  if (!idleTimer) return
  clearTimeout(idleTimer)
  idleTimer = undefined
  log.info("daemon idle shutdown cancelled", { reason })
}

function cancelStartupIdleTimer(reason: string) {
  if (!startupIdleTimer) return
  clearTimeout(startupIdleTimer)
  startupIdleTimer = undefined
  log.info("daemon startup idle shutdown cancelled", { reason })
}

function cancelLauncherWatcher(reason: string) {
  if (!launcherTimer) return
  clearInterval(launcherTimer)
  launcherTimer = undefined
  log.info("daemon launcher watcher cancelled", { reason, launcherPID: LAUNCHER_PID })
}

function maybeScheduleIdleShutdown() {
  if (!hadClient) {
    maybeScheduleStartupIdleShutdown()
    return
  }

  // Active work prevents idle shutdown.
  if (isActive()) {
    cancelIdleTimer("active")
    return
  }

  // Already scheduled — let it fire.
  if (idleTimer) return

  idleTimer = setTimeout(() => {
    idleTimer = undefined
    // Re-check at fire time: a client or runner may have appeared.
    if (isActive()) {
      log.info("daemon idle shutdown skipped", {
        reason: "active-at-fire",
        sseClients,
        sessionActivity: SessionActivity.count(),
      })
      return
    }
    void gracefulShutdown("idle-timeout")
  }, IDLE_TIMEOUT_MS)
  idleTimer.unref?.()
  log.info("daemon idle shutdown scheduled", { timeoutMs: IDLE_TIMEOUT_MS })
}

function maybeScheduleStartupIdleShutdown() {
  if (hadClient || startupIdleTimer) return
  startupIdleTimer = setTimeout(() => {
    startupIdleTimer = undefined
    if (hadClient || isActive()) {
      log.info("daemon startup idle shutdown skipped", {
        reason: "active-at-fire",
        hadClient,
        sseClients,
        sessionActivity: SessionActivity.count(),
      })
      return
    }
    if (LAUNCHER_PID && ServerLock.alive(LAUNCHER_PID)) {
      log.info("daemon startup idle shutdown skipped", {
        reason: "launcher-alive",
        launcherPID: LAUNCHER_PID,
      })
      maybeScheduleStartupIdleShutdown()
      return
    }
    void gracefulShutdown("startup-idle-timeout")
  }, STARTUP_IDLE_TIMEOUT_MS)
  startupIdleTimer.unref?.()
  log.info("daemon startup idle shutdown scheduled", {
    timeoutMs: STARTUP_IDLE_TIMEOUT_MS,
    launcherPID: LAUNCHER_PID,
  })
}

function startLauncherWatcher() {
  if (!LAUNCHER_PID || launcherTimer) return
  launcherTimer = setInterval(() => {
    if (hadClient) {
      cancelLauncherWatcher("first-client")
      return
    }
    if (ServerLock.alive(LAUNCHER_PID)) return
    cancelLauncherWatcher("launcher-exited")
    if (isActive()) {
      log.info("daemon launcher exited before first client but work is active", {
        launcherPID: LAUNCHER_PID,
        sseClients,
        sessionActivity: SessionActivity.count(),
      })
      return
    }
    void gracefulShutdown("launcher-exited-before-first-client")
  }, LAUNCHER_POLL_MS)
  launcherTimer.unref?.()
  log.info("daemon launcher watcher started", { launcherPID: LAUNCHER_PID, intervalMs: LAUNCHER_POLL_MS })
}

onSseClientCountChange((count) => {
  sseClients = count
  if (count > 0) {
    hadClient = true
    cancelStartupIdleTimer("first-client")
    cancelLauncherWatcher("first-client")
  }
  log.info("daemon sse client count changed", { count, hadClient })
  maybeScheduleIdleShutdown()
})

SessionActivity.onChange(() => {
  log.info("daemon session activity changed", { count: SessionActivity.count() })
  maybeScheduleIdleShutdown()
})

maybeScheduleStartupIdleShutdown()
startLauncherWatcher()

// [local-devsmark][deprecated-rpc-thread] Upstream's per-TUI RPC surface was
// intentionally disabled. This worker is the shared daemon process and exposes
// HTTP/SSE via ServerLock instead, so one daemon owns SQLite writes across TUI
// instances. Do not add Rpc.listen/Rpc.emit/Rpc.client paths here unless the
// daemon database ownership model is replaced.
