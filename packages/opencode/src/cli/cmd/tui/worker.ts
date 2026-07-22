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
import { GlobalBus } from "@/bus/global"
import { DisposedReason, Event as ServerEvent } from "@/server/event"
import { win32DetachConsole } from "./win32"
import { ColdStorage } from "@/storage/cold"

ensureProcessMetadata("worker")
NetworkProxy.installGlobalFetch()

const log = Log.create({ service: "daemon" })

// printLogs 判定须与 daemon.ts launcher 端的 printLogs（argv 决定 stdio + env 透传）
// 保持语义一致：launcher 只看 argv 设置 stdio（daemon.ts:187），同时把
// OPENCODE_PRINT_LOGS="1" 透传到 worker env（daemon.ts:191），worker 端再看
// argv||env（此处）。注意：若仅经 env 注入 OPENCODE_PRINT_LOGS=1 而不带 --print-logs
// argv，launcher 的 stdio 仍为 ignore——此时 worker 不调 FreeConsole（保留 console）
// 但日志无法输出到 stderr，是 pre-existing 死区，非本次引入。
const printLogs = process.argv.includes("--print-logs") || process.env.OPENCODE_PRINT_LOGS === "1"

await Log.init({
  print: printLogs,
  dev: Installation.isLocal(),
  level: (() => {
    if (Installation.isLocal()) return "DEBUG"
    return "INFO"
  })(),
})

// Windows: 让 daemon worker 脱离共享 console，使 Ctrl+C 的 CTRL_C_EVENT 不再
// 送达 worker（等价 Unix detached 进程组）。必须在 HTTP server 启动前、日志
// 系统初始化后调用：默认模式日志写文件不受影响。--print-logs 调试模式保留
// console 以便 stderr 日志输出，该模式下 daemon 不保证 Ctrl+C 免疫（有意降级）。
if (!printLogs) win32DetachConsole()

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
// worker 自己的 5 秒上限短于 CLI 的 10 秒 stop 等待，确保 CLI force 路径不会遮蔽 worker deadline 回归。
// 这两个窗口分别保护 worker 生命周期和用户 stop 命令，不能合并成一个隐式超时。
// worker 先结束 cleanup，只有 disposer 卡住时才进入 deadline 分支。
const SHUTDOWN_TIMEOUT_MS = 5_000
let shutdownDeadlineTimer: ReturnType<typeof setTimeout> | undefined
let lockToken = ""
let controlServer: ReturnType<typeof Bun.serve> | undefined
let activeMaintenance:
  | { taskID: string; controller: AbortController; promise: Promise<void> }
  | undefined
let maintenanceRecoveryPromise: Promise<void> | undefined
let maintenanceShutdownRequested = false

// control 错误映射只决定本机 HTTP status，不改写 task terminal 状态或吞掉 ColdStorage failure。
// busy 与 lease-lost 分开反馈，CLI 可区分“已有任务”与“当前 owner 已失效”的恢复动作。
// 未知异常保持 500，禁止把 corruption/程序缺陷降级为参数错误后继续运行。
function maintenanceError(error: unknown) {
  if (error instanceof ServerLock.MaintenanceBusyError) return { status: 409, message: error.message }
  if (error instanceof ServerLock.MaintenanceLeaseError) return { status: 503, message: error.message }
  if (error instanceof ColdStorage.ValidationError) return { status: 400, message: error.message }
  return { status: 500, message: error instanceof Error ? error.message : String(error) }
}

// runMaintenance 在返回 202 前登记 activeMaintenance，使 startup/idle timer 从第一刻就看到活跃任务。
// task-backed operation 必须先获得跨进程 lease；新 task 可注入已获取 lease，resume/recovery 在此获取。
// task promise 只在 terminal/interrupted checkpoint 后释放 lease 和 active 标记，daemon 不会提前退出。
// shutdown race 通过 maintenanceShutdownRequested 立即 abort 刚创建的 controller，避免恢复窗口漏掉停止信号。
async function runMaintenance(
  prepared: ColdStorage.PreparedMaintenance,
  existing?: ColdStorage.MaintenanceTask,
  acquired?: ServerLock.MaintenanceLease,
) {
  if (prepared.type !== "task") throw new ColdStorage.ValidationError({ message: "Expected task-backed maintenance" })
  const task = existing ?? prepared.task
  const lease = acquired ?? (await ServerLock.acquireMaintenanceLease(task))
  const controller = new AbortController()
  const promise = (async () => {
    try {
      await ColdStorage.maintain(prepared, {
        task,
        lease,
        signal: controller.signal,
        checkpoint: (next) => ServerLock.writeMaintenanceTask(next),
      })
    } catch (error) {
      log.error("database maintenance failed", { taskID: task.taskID, error: String(error) })
    } finally {
      await lease.release()
      if (activeMaintenance?.taskID === task.taskID) activeMaintenance = undefined
      maybeScheduleIdleShutdown()
    }
  })()
  activeMaintenance = { taskID: task.taskID, controller, promise }
  if (maintenanceShutdownRequested) controller.abort()
  cancelIdleTimer("maintenance-started")
  cancelStartupIdleTimer("maintenance-started")
  void promise
  return task
}

// startMaintenance 只做 request decode、prepare、task conflict 和 runtime 装配，operation SQL 全部留在 ColdStorage。
// immediate read-only request 不创建 task；vacuum 虽 immediate write，仍使用同一 maintenance lease。
// 新 task 在 lease owner 可见后写 queued record，消除 status 把启动中任务误判 interrupted 的窗口。
// queued 仍早于任何 DB batch；写 record 或 runner 装配失败会释放 lease且不留下假 running 状态。
async function startMaintenance(input: unknown) {
  const request = ColdStorage.parseMaintenanceRequest(input)
  const prepared = ColdStorage.prepareMaintenance(request)
  if (prepared.type === "immediate") {
    if (request.operation === "vacuum") {
      // interrupted task 虽不持有 live lease，仍是待恢复的 nonterminal 工作；vacuum 不得绕过它重排数据库页面。
      // daemon 与 offline CLI 都先做同一冲突检查，再用 pseudo taskID 获取 lease，保持运行域行为一致。
      const existing = await ServerLock.findNonterminalMaintenanceTask()
      if (existing) throw new ServerLock.MaintenanceBusyError(`Maintenance task already exists: ${existing.taskID}`)
      const pseudo = { taskID: `vacuum_${crypto.randomUUID()}`, dbPath: Database.getPath() }
      const lease = await ServerLock.acquireMaintenanceLease(pseudo)
      try {
        return await ColdStorage.maintain(prepared, { lease, checkpoint: async () => {} })
      } finally {
        await lease.release()
      }
    }
    return await ColdStorage.maintain(prepared)
  }
  const existing = await ServerLock.findNonterminalMaintenanceTask()
  if (existing) throw new ServerLock.MaintenanceBusyError(`Maintenance task already exists: ${existing.taskID}`)
  const lease = await ServerLock.acquireMaintenanceLease(prepared.task)
  try {
    await ServerLock.writeMaintenanceTask(prepared.task)
    const task = await runMaintenance(prepared, undefined, lease)
    return { type: "task" as const, task }
  } catch (error) {
    await lease.release()
    throw error
  }
}

// resume 先 reconcile dead owner，只接受 interrupted；running/completed/failed/queued 都返回明确 conflict。
// prepared 的随机新 task 仅验证 schema，实际 maintain 注入原 task，因此 cursor/计数/taskID 保持连续。
// 返回 running 只表示 daemon 已登记 active；最终结果由持久 task record 查询，不阻塞 control request。
async function resumeMaintenance(taskID: string) {
  const task = await ServerLock.reconcileMaintenanceTask(taskID)
  if (!task) return { status: 404 as const, body: { error: `Maintenance task not found: ${taskID}` } }
  if (task.status !== "interrupted") {
    return { status: 409 as const, body: { error: `Maintenance task is ${task.status}` } }
  }
  if (activeMaintenance) throw new ServerLock.MaintenanceBusyError()
  const prepared = ColdStorage.prepareMaintenance(task.args)
  if (prepared.type !== "task") throw new ColdStorage.ValidationError({ message: "Interrupted task is not resumable" })
  await runMaintenance(prepared, task)
  return { status: 202 as const, body: { taskID: task.taskID, operation: task.operation, status: "running" } }
}

function maintenanceTaskID(input: unknown) {
  // resume control 只接受 taskID 字符串；operation/args/cursor 必须从已验证的持久 record 获取。
  // 返回 undefined 让同一 ValidationError 路径处理 malformed JSON，不使用 unchecked body cast。
  if (
    typeof input !== "object" ||
    input === null ||
    !("taskID" in input) ||
    typeof input.taskID !== "string" ||
    input.taskID.length > 128 ||
    !/^dbm_[A-Za-z0-9_-]+$/.test(input.taskID)
  )
    return
  return input.taskID
}

// daemon startup 只恢复唯一 interrupted task；多个 nonterminal 或损坏 record 由 task store hard-fail。
// caller 在启动 timer/watcher 前 await 本函数；返回时要么 activeMaintenance 已登记，要么已证明无需恢复。
// 因而 isActive 不需要第四种临时状态，所有 shutdown 判定保持批准的单一 predicate。
async function recoverInterruptedMaintenance() {
  const task = await ServerLock.findNonterminalMaintenanceTask()
  if (!task || task.status !== "interrupted") return
  const prepared = ColdStorage.prepareMaintenance(task.args)
  if (prepared.type !== "task") throw new ColdStorage.ValidationError({ message: "Interrupted task is not resumable" })
  await runMaintenance(prepared, task)
}

// graceful shutdown 先阻止新 maintenance，再 abort 当前 task，并等待其批次结束和 interrupted checkpoint。
// recovery promise 可能在第一次 active 检查后才登记任务，所以等待后必须再次检查并 abort 该 race。
// Database.close 与 daemon lock 清理发生在 maintenance/instance/server 全部停止后，避免替代进程过早接管 SQLite。
async function gracefulShutdown(reason = "unknown") {
  if (shutdownInProgress) return
  shutdownInProgress = true
  shutdownDeadlineTimer = setTimeout(() => {
    // deadline 到达时不能继续等待 disposer；进程退出后由下一次 owner 选举清理 stale lock。
    // 不在这里清理 lock，避免另一个进程误以为 SQLite 已经释放。
    // 进程退出后既有 stale-owner reconciliation 负责恢复现场。
    // 该分支故意不等待任何异步清理，避免 deadline 自身再次被阻塞。
    log.error("daemon shutdown deadline exceeded", { timeoutMs: SHUTDOWN_TIMEOUT_MS, reason })
    process.exit(1)
  }, SHUTDOWN_TIMEOUT_MS)
  shutdownDeadlineTimer.unref?.()
  maintenanceShutdownRequested = true
  cancelIdleTimer("shutdown")
  cancelStartupIdleTimer("shutdown")
  cancelLauncherWatcher("shutdown")
  if (activeMaintenance) {
    activeMaintenance.controller.abort()
    await activeMaintenance.promise.catch(() => undefined)
  }
  if (maintenanceRecoveryPromise) await maintenanceRecoveryPromise.catch(() => undefined)
  if (activeMaintenance) {
    activeMaintenance.controller.abort()
    await activeMaintenance.promise.catch(() => undefined)
  }
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
  Database.close()
  // Keep the lock until after disposers and Database.close() finish. Otherwise a
  // reconnecting TUI can spawn a replacement daemon while this process still owns SQLite.
  await ServerLock.clearIfOwner(lockToken)
  if (shutdownDeadlineTimer) clearTimeout(shutdownDeadlineTimer)
  shutdownDeadlineTimer = undefined
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
    // maintenance start 是 daemon 私有控制面，不进入 public HTTP/OpenAPI/SDK；前端业务 API 无需 cold read intent。
    // handler 只解析 JSON、调用共同 dispatcher 并返回 task/report，不能复制 eligibility 或 SQL。
    // task-backed response 只暴露 identity/status/createdAt，不把 payload、cursor 内部对象或 lock token 回传。
    if (request.method === "POST" && url.pathname === ServerLock.CONTROL_MAINTENANCE_PATH) {
      return request
        .json()
        .then((body: unknown) => startMaintenance(body))
        .then((body) =>
          body.type === "task"
            ? Response.json(
                {
                  taskID: body.task.taskID,
                  operation: body.task.operation,
                  status: body.task.status,
                  createdAt: body.task.createdAt,
                },
                { status: 202 },
              )
            : Response.json(body, { status: 200 }),
        )
        .catch((error) => {
          const mapped = maintenanceError(error)
          return Response.json({ error: mapped.message }, { status: mapped.status })
        })
    }
    // task status 与 daemon health 分离；不存在返回 404，损坏 record 返回错误而不是伪造空任务。
    // reconcile 让强制终止进程留下的 running/queued 状态在查询时变为可恢复 interrupted。
    if (request.method === "GET" && url.pathname === ServerLock.CONTROL_MAINTENANCE_STATUS_PATH) {
      const taskID = url.searchParams.get("task")
      if (!taskID) return Response.json({ error: "task query is required" }, { status: 400 })
      return ServerLock.reconcileMaintenanceTask(taskID)
        .then((task) => (task ? Response.json(task) : Response.json({ error: "task not found" }, { status: 404 })))
        .catch((error) => {
          const mapped = maintenanceError(error)
          return Response.json({ error: mapped.message }, { status: mapped.status })
        })
    }
    // resume 参数只含 taskID，operation/args 必须来自持久 record，防止控制调用改变原任务语义。
    // conflict 状态保留 409，调用方不能把重复 resume 当成幂等 completed 成功。
    if (request.method === "POST" && url.pathname === ServerLock.CONTROL_MAINTENANCE_RESUME_PATH) {
      return request
        .json()
        .then((body: unknown) => {
          const taskID = maintenanceTaskID(body)
          if (!taskID) throw new ColdStorage.ValidationError({ message: "taskID is required" })
          return resumeMaintenance(taskID)
        })
        .then((result) => {
          if ("body" in result) return Response.json(result.body, { status: result.status })
          return Response.json(result)
        })
        .catch((error) => {
          const mapped = maintenanceError(error)
          return Response.json({ error: mapped.message }, { status: mapped.status })
        })
    }
    if (request.method === "GET" && url.pathname === ServerLock.CONTROL_STATUS_PATH) {
      // stopping 是 owner 生命周期信号，不改变 status 命令原有的 client/activity 数据。
      // 只有持有 control token 的本地调用者能观察到这个辅助状态。
      // 旧客户端忽略新增字段即可继续解析原有响应。
      // stopping 在 shutdown 入口立即可见，覆盖 disposer 开始后的整个等待窗口。
      return Response.json({
        tuiClients: sseClients,
        sessionActivity: SessionActivity.count(),
        stopping: shutdownInProgress,
      })
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

// maintenance 与 SSE/session runner 同属 daemon liveness；任一存在都禁止 startup/regular idle shutdown。
// startup 在启动 timer 前已 await recovery 注册 activeMaintenance，因此这里不需要临时恢复标志。
// 所有 launcher/startup/idle timer 复用该 predicate，避免各自遗漏新的后台工作类型。
function isActive() {
  return sseClients > 0 || SessionActivity.count() > 0 || activeMaintenance !== undefined
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

maintenanceRecoveryPromise = recoverInterruptedMaintenance().catch((error) => {
  log.error("maintenance recovery failed", { error: String(error) })
})
await maintenanceRecoveryPromise
startLauncherWatcher()
maybeScheduleStartupIdleShutdown()

// [local-devsmark][deprecated-rpc-thread] Upstream's per-TUI RPC surface was
// intentionally disabled. This worker is the shared daemon process and exposes
// HTTP/SSE via ServerLock instead, so one daemon owns SQLite writes across TUI
// instances. Do not add Rpc.listen/Rpc.emit/Rpc.client paths here unless the
// daemon database ownership model is replaced.
