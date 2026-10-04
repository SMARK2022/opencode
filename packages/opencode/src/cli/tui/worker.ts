import { Server } from "@/server/server"
import { Flag } from "@opencode-ai/core/flag/flag"
import { NetworkProxy } from "@opencode-ai/core/network-proxy"
import { InstanceRuntime } from "@/project/instance-runtime"
import { upgrade } from "@/cli/upgrade"
import { Config } from "@/config/config"
import { Heap } from "@/cli/heap"
import { AppRuntime } from "@/effect/app-runtime"
import { Effect, Layer, Logger, ManagedRuntime, Scope } from "effect"
import { NodeFileSystem } from "@effect/platform-node"
import { Logging } from "@opencode-ai/core/observability/logging"
import { disposeAllInstancesAndEmitGlobalDisposed } from "@/server/global-lifecycle"
import { Database } from "@opencode-ai/core/database/database"
import { SessionStaleTurn } from "@/session/stale-turn"
import { ServerLock } from "@/cli/tui/server-lock"
// #493：daemon maintenance 全部 SQL 位于 core ColdStorage；worker 只装配生命周期。
import { ColdStorage } from "@opencode-ai/core/storage/cold-storage"
import { ColdMaintain } from "@opencode-ai/core/storage/cold-maintain"
import { EventClients } from "@opencode-ai/server/event-clients"
import { SessionActivity } from "@/session/activity"
import { HttpApiApp } from "@/server/routes/instance/httpapi/server"
import { GlobalBus } from "@/bus/global"
import { DisposedReason, Event } from "@/server/event"
import { win32DetachConsole } from "@opencode-ai/tui/terminal-win32"

Heap.start()

let onUnhandledRejection: (error: unknown) => void = (_error: unknown) => {}

let onUncaughtException: (error: Error) => void = (_error: Error) => {}

process.on("unhandledRejection", onUnhandledRejection)
process.on("uncaughtException", onUncaughtException)

// #493：daemon 内唯一 maintenance 运行态；task promise 只在 terminal/interrupted checkpoint 后释放。
let activeMaintenance:
  | { taskID: string; controller: AbortController; promise: Promise<void> }
  | undefined
let maintenanceRecoveryPromise: Promise<void> | undefined
let maintenanceShutdownRequested = false
// #535：pending 覆盖 accepted request 到 activeMaintenance 发布之间的 await 窗口；active 单独覆盖 runner 生命周期。
let maintenanceTransitionPending = 0

// control 错误映射只决定本机 HTTP status，不改写 task terminal 状态或吞掉 ColdStorage failure。
// busy 与 lease-lost 分开反馈，CLI 可区分"已有任务"与"当前 owner 已失效"的恢复动作。
// 未知异常保持 500，禁止把 corruption/程序缺陷降级为参数错误后继续运行。
function maintenanceError(error: unknown) {
  if (error instanceof ServerLock.MaintenanceBusyError) return { status: 409, message: error.message }
  if (error instanceof ServerLock.MaintenanceLeaseError) return { status: 503, message: error.message }
  if (error instanceof ColdStorage.ValidationError) return { status: 400, message: error.message }
  return { status: 500, message: error instanceof Error ? error.message : String(error) }
}

const isDaemon = process.env.OPENCODE_PROCESS_ROLE === "worker"
// 共享 daemon 是唯一生产入口；线程 RPC 不再持有数据库或转发事件。

if (isDaemon) {
  // daemon 插件可能直接调用 fetch，入口安装一次使其共享实时代理策略。
  NetworkProxy.installGlobalFetch()
  // 日志资源仅依赖FS，错误处理不能为写日志提前初始化AppRuntime或数据库。
  const daemonLogging = ManagedRuntime.make(Logger.layer([Logging.fileLogger()]).pipe(Layer.provide(NodeFileSystem.layer)))
  const log = {
    info: (message: string, fields: Record<string, unknown> = {}) => {
      console.log(`[daemon] ${message}`, fields)
      return daemonLogging.runPromiseExit(Effect.logInfo(message, { service: "daemon", ...fields })).then(() => undefined)
    },
    error: (message: string, fields: Record<string, unknown> = {}) => {
      console.log(`[daemon] [ERROR] ${message}`, fields)
      // Exit吸收诊断I/O失败，不能让rejection记录再次制造孤儿Promise。
      return daemonLogging.runPromiseExit(Effect.logError(message, { service: "daemon", ...fields })).then(() => undefined)
    },
  }
  // Windows relay 在 Bun 启动前为两种模式都建立非 console pipe，默认双流连续排到 Null。
  // print-logs 经双通道转发到 wrapper；argv||env 只决定日志可见性及是否保留 console 关联。
  // 修复必须由创建 owner 完成，不能靠应用 logger 覆盖依赖直接写 console.error 的路径。
  const printLogs = process.argv.includes("--print-logs") || process.env.OPENCODE_PRINT_LOGS === "1"
  // Windows: 让 daemon worker 脱离共享 console，使 Ctrl+C 的 CTRL_C_EVENT 不再
  // 送达 worker（等价 Unix detached 进程组）。必须在 HTTP server 启动前调用；
  // relay 提供的双流 pipe 在 detach 后仍有效，不会暴露可被 SQLite 复用的失效句柄。
  // print-logs 保留 console 及既有 Ctrl+C 传播，输出分别进入同一组 pipe 的转发通道。
  if (!printLogs) win32DetachConsole()
  // 资源先声明再启动，外部端口绑定或写锁失败也能清理已开的内部监听。
  let internalServer: Awaited<ReturnType<typeof Server.listen>> | undefined

  // 外部 listener 与内部 listener 使用同一服务树，不能另建应用 runtime 或另一份计数。
  let externalServer: Awaited<ReturnType<typeof Server.listen>> | undefined
  // 私有控制监听归同一 owner，绑定或写锁失败也进入统一清理。
  let controlServer: ReturnType<typeof Bun.serve> | undefined
  let externalUrl: string | undefined

  // 只有启动成功写锁后才拥有 token；绑定失败的清理不能删除磁盘上的其他 owner。
  
  let lockToken: string | undefined
  // idle/upgrade timer 先于首次 await 声明，启动期间致命退出也可安全取消它们。
  let idleTimer: ReturnType<typeof setTimeout> | undefined
  let upgradeTimer: ReturnType<typeof setTimeout> | undefined
  let startupIdleTimer: ReturnType<typeof setTimeout> | undefined
  let launcherTimer: ReturnType<typeof setInterval> | undefined

  // shutdown guard 覆盖 SIGTERM、idle 与 fatal 的并发触发，不能重复 dispose 同一 listener。
  let shutdownInProgress = false

  // 所有退出入口收敛到这个闭包，不能从事件 callback 单独调用 Database.close。
  
  async function maintain(prepared: ColdMaintain.PreparedMaintenance, runtime: ColdMaintain.MaintenanceRuntime = { checkpoint: async () => {} }) {
    const database = await AppRuntime.runPromise(Database.Service)
    // 每批只预约本 runtime 的同一连接；文件 checkpoint 期间释放预约，普通会话仍可继续。
    return ColdMaintain.maintain(database.sync, prepared, {
      ...runtime,
      run: (body) => Effect.runPromise(Database.withSync(database, body)),
    })
  }

  // runMaintenance 在返回 202 前登记 activeMaintenance，使 startup/idle timer 从第一刻就看到活跃任务。
  // task-backed operation 必须先获得跨进程 lease；新 task 可注入已获取 lease，resume/recovery 在此获取。
  // task promise 只在 terminal/interrupted checkpoint 后释放 lease 和 active 标记，daemon 不会提前退出。
  // shutdown race 通过 maintenanceShutdownRequested 立即 abort 刚创建的 controller，避免恢复窗口漏掉停止信号。
  async function runMaintenance(
    prepared: ColdMaintain.PreparedMaintenance,
    existing?: ColdMaintain.MaintenanceTask,
    acquired?: ServerLock.MaintenanceLease,
  ) {
    if (prepared.type !== "task") throw new ColdStorage.ValidationError({ message: "Expected task-backed maintenance" })
    const task = existing ?? prepared.task
    const lease = acquired ?? (await ServerLock.acquireMaintenanceLease(task))
    const controller = new AbortController()
    const promise = (async () => {
      try {
        await maintain(prepared, {
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
        armIdleTimer()
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
  async function startMaintenance(input: unknown) {
    // #535：shutdown 后拒绝新维护——pending 在首个 await 前发布，与 conditional shutdown 形成互斥顺序。
    if (shutdownInProgress) throw new ServerLock.MaintenanceBusyError("Daemon shutdown is in progress")
    maintenanceTransitionPending++
    // finally 绑定完整准备 promise，解析、冲突检查或 lease 失败都不能泄漏 pending 计数。
    return startMaintenanceBody(input).finally(() => maintenanceTransitionPending--)
  }

  // body 只在 pending 已发布后运行，因此其首个 await 不会向 conditional shutdown 暴露假 idle 窗口。
  async function startMaintenanceBody(input: unknown) {
    const request = ColdMaintain.parseMaintenanceRequest(input)
    const prepared = ColdMaintain.prepareMaintenance(request)
    if (prepared.type === "immediate") {
      if (request.operation === "vacuum") {
        // interrupted task 虽不持有 live lease，仍是待恢复的 nonterminal 工作；vacuum 不得绕过它重排数据库页面。
        // daemon 与 offline CLI 都先做同一冲突检查，再用 pseudo taskID 获取 lease，保持运行域行为一致。
        const existing = await ServerLock.findNonterminalMaintenanceTask()
        if (existing) throw new ServerLock.MaintenanceBusyError(`Maintenance task already exists: ${existing.taskID}`)
        const pseudo = { taskID: `vacuum_${crypto.randomUUID()}`, dbPath: Database.path() }
        const lease = await ServerLock.acquireMaintenanceLease(pseudo)
        try {
          return await maintain(prepared, { lease, checkpoint: async () => {} })
        } finally {
          await lease.release()
        }
      }
      return await maintain(prepared)
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
    // #535：resume 有独立 reconcile/lease await，同样必须在整个过渡期阻止 maintenance-idle shutdown。
    if (shutdownInProgress) throw new ServerLock.MaintenanceBusyError("Daemon shutdown is in progress")
    maintenanceTransitionPending++
    return resumeMaintenanceBody(taskID).finally(() => maintenanceTransitionPending--)
  }

  // resume body 与 start 分开恢复原 task identity，但二者共享同一个过渡期计数所有者。
  async function resumeMaintenanceBody(taskID: string) {
    // reconcile 结果先决定恢复资格，再创建 lease；未知 task 不能通过 resume 进入维护状态。
    const task = await ServerLock.reconcileMaintenanceTask(taskID)
    if (!task) return { status: 404 as const, body: { error: `Maintenance task not found: ${taskID}` } }
    if (task.status !== "interrupted") {
      return { status: 409 as const, body: { error: `Maintenance task is ${task.status}` } }
    }
    if (activeMaintenance) throw new ServerLock.MaintenanceBusyError()
    const prepared = ColdMaintain.prepareMaintenance(task.args)
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
    const prepared = ColdMaintain.prepareMaintenance(task.args)
    if (prepared.type !== "task") throw new ColdStorage.ValidationError({ message: "Interrupted task is not resumable" })
    await runMaintenance(prepared, task)
  }

  let reconcileStale: ((scope: SessionStaleTurn.Scope, options?: { budgetMs?: number }) => Promise<void>) | undefined

  async function gracefulShutdown(exitCode = 0, reason = "unknown", defer = false) {
    if (shutdownInProgress) return
    shutdownInProgress = true
    // #547：residual 与 process.exit 硬截止必须同一 t0——maintenance abort 也吃墙钟，不能只从 dispose 起算。
    const shutdownStartedAt = Date.now()
    // 五秒总预算从入口开始，maintenance 等待也受保护；超时不提前清锁。
    const shutdownTimer = setTimeout(() => {
      log.error("daemon shutdown deadline exceeded", { reason, pid: process.pid })
      process.exit(1)
    }, 5_000)
    shutdownTimer.unref?.()
    // 停机资格和总截止已同步发布；先让控制响应刷出，再执行同一拆解闭包。
    if (defer) await new Promise<void>((resolve) => setTimeout(resolve, 0))
    // #493：graceful shutdown 先阻止新 maintenance，再 abort 当前 task，并等待其批次结束和 interrupted checkpoint。
    // recovery promise 可能在第一次 active 检查后才登记任务，所以等待后必须再次检查并 abort 该 race。
    // maintenance 先停，随后既有 runtime finalizer checkpoint/close，最后才释放 daemon lock。
    maintenanceShutdownRequested = true
    if (activeMaintenance) {
      activeMaintenance.controller.abort()
      await activeMaintenance.promise.catch(() => undefined)
    }
    if (maintenanceRecoveryPromise) await maintenanceRecoveryPromise.catch(() => undefined)
    if (activeMaintenance) {
      activeMaintenance.controller.abort()
      await activeMaintenance.promise.catch(() => undefined)
    }
    cancelIdleTimer("shutdown")
    cancelStartupIdleTimer("shutdown")
    cancelLauncherWatcher("shutdown")
    await log.info("daemon shutting down", { reason, hadClient, sseClients, sessionActivity: SessionActivity.count() })
    if (upgradeTimer) clearTimeout(upgradeTimer)
    // 主动停机先通知全局订阅；广播失败也计入退出码，不跳过后续清理。
    const notified = await Promise.allSettled([Promise.resolve().then(() => {
      if (reason !== DisposedReason.DaemonStop) return
      GlobalBus.emit("event", {
        directory: "global",
        payload: {
          type: Event.Disposed.type,
          properties: { reason: DisposedReason.DaemonStop },
        },
      })
    })])
    // 每个资源独立清理；dispose 失败不能跳过停监听或关闭 runtime 的数据库 scope。
    const disposed = await Promise.allSettled([InstanceRuntime.disposeAllInstances()])
    // 清理失败仍保留原退出码，但不能把仍可能运行的实例当成stale；五秒总截止保持原样。
    const remaining = 5_000 - (Date.now() - shutdownStartedAt) - SessionStaleTurn.SAFETY_MARGIN_MS
    if (disposed.every((item) => item.status === "fulfilled") && remaining > 0 && reconcileStale) {
      await reconcileStale({ kind: "exit-full" }, { budgetMs: remaining }).catch((error) => log.error("stale-turn exit-full failed", { error: String(error) }))
    } else log.info("stale-turn exit-full skipped: services unavailable or no cleanup budget")

    // 监听资源归 daemon 所有，共享它的 TUI 退出只释放自己的连接。
    const stopped = await Promise.allSettled([
      Promise.resolve().then(() => controlServer?.stop(true)),
      Promise.resolve().then(() => externalServer?.stop(true)),
      Promise.resolve().then(() => internalServer?.stop(true)),
    ])
    // scoped文件logger关闭即排空缓冲；等待仍受原五秒硬截止保护。
    const runtime = await Promise.allSettled([AppRuntime.dispose(), daemonLogging.dispose()])
    // Database Layer 的 finalizer 在 native close 前 checkpoint，监听 scope 与 runtime 均照常释放。
    // 数据库 scope 关闭后才释放锁，避免替换 owner 过早打开仍被旧进程持有的 SQLite。
    const cleared = await Promise.allSettled([lockToken ? ServerLock.clearIfOwner(lockToken) : Promise.resolve()])
    clearTimeout(shutdownTimer)
    process.exit(exitCode || ([...notified, ...disposed, ...stopped, ...cleared, ...runtime].some((item) => item.status === "rejected") ? 1 : 0))
  }

  // SIGTERM 也必须经过 token/scope 清理；正常信号退出码与 fatal 的非零退出码分开。
  process.on("SIGTERM", () => void gracefulShutdown(0, "signal:SIGTERM"))

  // daemon 致命路径替换线程空监听，启动与空闲阶段共享同一资源清理闭包。
  process.off("unhandledRejection", onUnhandledRejection)
  process.off("uncaughtException", onUncaughtException)
  // rejection按非致命策略记录，不声称所有异步错误均安全；同步逃逸仍沿原非零拆解。
  onUnhandledRejection = (error: unknown) => {
    void log.error("rejection", { e: error instanceof Error ? error.message : error })
  }
  onUncaughtException = (error: Error) => {
    void log.error("exception", { e: error.message })
    void gracefulShutdown(1, "uncaughtException")
  }
  process.prependListener("unhandledRejection", onUnhandledRejection)
  process.prependListener("uncaughtException", onUncaughtException)

  // reload 失效配置和实例而不是停止共享 HTTP listener，其他窗口的订阅必须保持。
  if (process.platform !== "win32") {
    process.on("SIGUSR2", () => {
      AppRuntime.runPromise(
        Effect.gen(function* () {
          const cfg = yield* Config.Service
          yield* cfg.invalidate()
          yield* disposeAllInstancesAndEmitGlobalDisposed({ swallowErrors: true })
        }),
      ).catch(() => {})
    })
  }

  // #173：OPENCODE_DAEMON_IDLE_TIMEOUT_MS可配置；非法值回退4秒，零值仍合法。
  const IDLE_TIMEOUT_MS = (() => {
    // 最后一个TUI断开且无会话工作时默认4秒后退出，短暂收尾避免资源长驻。
    const value = Number(process.env.OPENCODE_DAEMON_IDLE_TIMEOUT_MS ?? 4_000)
    // #173：NaN/负数回退默认；0 合法（尽快 idle 退出，便于测试）
    return Number.isFinite(value) && value >= 0 ? value : 4_000
  })()
  const STARTUP_IDLE_TIMEOUT_MS = (() => {
    const value = Number(process.env.OPENCODE_DAEMON_STARTUP_IDLE_TIMEOUT_MS ?? IDLE_TIMEOUT_MS)
    // #235：非法值回退常规 idle 超时——启动期保护不弱于运行期
    return Number.isFinite(value) && value >= 0 ? value : IDLE_TIMEOUT_MS
  })()
  const LAUNCHER_PID = (() => {
    const value = Number(process.env.OPENCODE_DAEMON_LAUNCHER_PID)
    // #235：非正整数视为未提供——launcher watcher 不启用
    return Number.isInteger(value) && value > 0 ? value : undefined
  })()
  // #235：1s 轮询是延迟与开销的折中——launcher 死亡最迟 1s 被发现
  const LAUNCHER_POLL_MS = 1_000

  let hadClient = false
  let sseClients = 0

  // #235：活跃判定统一收敛——SSE client 或 session runner 任一活跃即阻止退出
  // #493：maintenance 与 SSE/session runner 同属 daemon liveness；任一存在都禁止 startup/regular idle shutdown。
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

  // 全部连接断开后仍须等待实际工作结束，不能因 TUI 断线关闭正在生成的会话。
  const armIdleTimer = () => {
    if (idleTimer) {
      clearTimeout(idleTimer)
      idleTimer = undefined
    }
    if (shutdownInProgress) return
    if (!hadClient) {
      // #235：启动期未接 client 时改走 startup idle——常规 timer 只服务运行期
      maybeScheduleStartupIdleShutdown()
      return
    }
    if (isActive()) {
      cancelIdleTimer("active")
      return
    }
    idleTimer = setTimeout(() => {
      // #235：fire 时先置空句柄——重排逻辑不依赖旧句柄引用
      idleTimer = undefined
      if (shutdownInProgress || isActive()) {
        log.info("daemon idle shutdown skipped", {
          reason: "active-at-fire",
          sseClients,
          sessionActivity: SessionActivity.count(),
        })
        return
      }
      void gracefulShutdown(0, "idle-timeout")
    }, IDLE_TIMEOUT_MS)
    idleTimer.unref?.()
    log.info("daemon idle shutdown scheduled", { timeoutMs: IDLE_TIMEOUT_MS })
  }

  function maybeScheduleStartupIdleShutdown() {
    // #235：已接 client 或已有 timer——不重复排程
    if (shutdownInProgress || hadClient || startupIdleTimer) return
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
      // #235：launcher 仍存活说明 TUI 可能还在启动——重排而非退出
      if (LAUNCHER_PID && ServerLock.alive(LAUNCHER_PID)) {
        log.info("daemon startup idle shutdown skipped", {
          reason: "launcher-alive",
          launcherPID: LAUNCHER_PID,
        })
        maybeScheduleStartupIdleShutdown()
        return
      }
      void gracefulShutdown(0, "startup-idle-timeout")
    }, STARTUP_IDLE_TIMEOUT_MS)
    // #235：startup timer 同样 unref——不阻止进程在正常路径退出
    startupIdleTimer.unref?.()
    log.info("daemon startup idle shutdown scheduled", {
      timeoutMs: STARTUP_IDLE_TIMEOUT_MS,
      launcherPID: LAUNCHER_PID,
    })
  }

  function startLauncherWatcher() {
    // #235：无 launcher 语义（直连模式）或已启动则跳过
    if (shutdownInProgress || hadClient || !LAUNCHER_PID || launcherTimer) return
    launcherTimer = setInterval(() => {
      if (hadClient) {
        cancelLauncherWatcher("first-client")
        return
      }
      if (ServerLock.alive(LAUNCHER_PID)) return
      // #235：先停 watcher 再判活跃——避免退出期间重复触发
      cancelLauncherWatcher("launcher-exited")
      // #235：launcher 已死但有活跃工作——不清场，等 idle 路径接管
      if (isActive()) {
        log.info("daemon launcher exited before first client but work is active", {
          launcherPID: LAUNCHER_PID,
          sseClients,
          sessionActivity: SessionActivity.count(),
        })
        return
      }
      void gracefulShutdown(0, "launcher-exited-before-first-client")
    }, LAUNCHER_POLL_MS)
    launcherTimer.unref?.()
    log.info("daemon launcher watcher started", { launcherPID: LAUNCHER_PID, intervalMs: LAUNCHER_POLL_MS })
  }


  // 内外 listener 继续共用一个计数源，活动变更只重算退出时机。
  const eventClients = EventClients.make((count) => {
    log.info(count > sseClients ? "global event connected" : "global event disconnected", { sseClientCount: count })
    sseClients = count
    if (count > 0) {
      hadClient = true
      // #235：首个 client 到达——启动期保护不再需要
      cancelStartupIdleTimer("first-client")
      cancelLauncherWatcher("first-client")
    }
    log.info("daemon sse client count changed", { count, hadClient })
    armIdleTimer()
  })

  SessionActivity.onChange(() => {
    log.info("daemon session activity changed", { count: SessionActivity.count() })
    armIdleTimer()
  })

  try {
    const sharedServices = HttpApiApp.createSharedServices()
    // 监听与健康路由保留 ServerAuth，客户端计数由两个 listener 共用。
    // 内部监听必须真正绑定 0，不能消费公开零端口偏好的 4096。
    internalServer = await Server.listen({ port: 0, hostname: "127.0.0.1", ephemeral: true, eventClients, sharedServices })
    // 借用listener已构建的同一服务图；临时scope只持有引用，不新建数据库或native coordinator。
    reconcileStale = (scope, options) => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const owner = yield* Scope.Scope
      const services = yield* Layer.buildWithMemoMap(sharedServices.layer, sharedServices.memoMap, owner)
      yield* SessionStaleTurn.reconcile(scope, options).pipe(Effect.provide(services))
    })))

    const network = process.env.OPENCODE_EXTERNAL_NETWORK
      ? JSON.parse(process.env.OPENCODE_EXTERNAL_NETWORK) as NonNullable<ServerLock.ServerLock["network"]>
      : undefined
    if (network) {
      // 外部网络选项完整运输，cors/mdnsDomain 与共享客户端计数不因内部预热而丢失。
      externalServer = await Server.listen({ ...network, eventClients, sharedServices })
      externalUrl = externalServer.url.toString()
    }
    // 控制面仅绑定本机随机端口，以当前 lock token 保护 stop/status。
    controlServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        if (!lockToken || request.headers.get(ServerLock.CONTROL_TOKEN_HEADER) !== lockToken)
          return new Response("unauthorized", { status: 401 })
        const url = new URL(request.url)
      // #493：maintenance start 是 daemon 私有控制面，不进入 public HTTP/OpenAPI/SDK。
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
          .then(async (task) => {
            if (!task) return Response.json({ error: "task not found" }, { status: 404 })
            const terminal = task.status === "completed" || task.status === "failed" || task.status === "interrupted"
            // capture exact promise 后再 await，后续 activeMaintenance 清空不会让本请求错等另一个任务。
            const active = activeMaintenance?.taskID === taskID ? activeMaintenance.promise : undefined
            // #535：terminal checkpoint 早于 lease release；只有等待同一 promise 后返回，CLI 才能安全衔接 vacuum。
            if (terminal && active) {
              await active
              const settled = await ServerLock.reconcileMaintenanceTask(taskID)
              if (!settled) return Response.json({ error: "task not found" }, { status: 404 })
              return Response.json(settled)
            }
            return Response.json(task)
          })
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
        if (request.method === "GET" && url.pathname === ServerLock.CONTROL_STATUS_PATH)
          // 私有状态在入口置位，控制面保留到 disposer 完成后，供发现方等待真实退出。
          return Response.json({ tuiClients: sseClients, sessionActivity: SessionActivity.count(), stopping: shutdownInProgress })
        if (request.method !== "POST" || url.pathname !== ServerLock.CONTROL_SHUTDOWN_PATH)
          return new Response("not found", { status: 404 })
        // DB preflight没有中断其他维护的授权；普通stop保留既有abort与退出责任。
        if (
          url.searchParams.get("maintenance-idle") === "1" &&
          (maintenanceTransitionPending > 0 || activeMaintenance !== undefined)
        ) {
          return Response.json({ error: "database maintenance is active" }, { status: 409 })
        }
        // conditional通过后立即进入同一闭包置位shutdownInProgress，不能暴露接收新维护的窗口。
        // 拆解让出macrotask避免stop(true)抢先关闭本次{ok:true}响应，拒绝新维护的时机不变。
        if (url.searchParams.get("maintenance-idle") === "1") void gracefulShutdown(0, DisposedReason.DaemonStop, true)
        else setTimeout(() => void gracefulShutdown(0, DisposedReason.DaemonStop), 0).unref?.()
        return Response.json({ ok: true })
      },
    })
    // 内部认证监听就绪后才发布发现锁，外部 URL 不代替内部健康通道。
    // recovery先于owner发布；失败交给既有启动清理，不把未知恢复状态当成idle。
    await AppRuntime.runPromise(Database.Service)
    maintenanceRecoveryPromise = recoverInterruptedMaintenance()
    await maintenanceRecoveryPromise
    // L1先写入中断终态再发布发现锁，失败仍沿source约定记录并允许启动。
    await reconcileStale({ kind: "recent", limit: SessionStaleTurn.RECENT_ACTIVE_SESSION_LIMIT }).catch((error) => log.error("stale-turn recent L1 failed", { error: String(error) }))
    lockToken = await ServerLock.write(internalServer.port, externalUrl, network, controlServer.port)
    log.info("daemon lock written", { pid: process.pid, port: internalServer.port, controlPort: controlServer.port, externalUrl, launcherPID: LAUNCHER_PID })
    // 锁发布后才启用启动期保护，首个订阅到达后转由运行期空闲路径负责。
    maybeScheduleStartupIdleShutdown()
    startLauncherWatcher()
    // #71：锁可见后再做 best-effort 外部插件预热，避免 npm/代理阻塞 TUI 健康等待。
    setTimeout(() => void AppRuntime.runPromise(Effect.gen(function* () {
      const { RuntimeFlags } = yield* Effect.promise(() => import("@/effect/runtime-flags"))
      const flags = yield* RuntimeFlags.Service
      // pure 不建立预热项目上下文，避免为本应跳过的用户插件读取配置或准备依赖。
      if (flags.pure) return
      const { Project } = yield* Effect.promise(() => import("@/project/project"))
      const { InstanceRef } = yield* Effect.promise(() => import("@/effect/instance-ref"))
      const { FSUtil } = yield* Effect.promise(() => import("@opencode-ai/core/fs-util"))
      const { Plugin } = yield* Effect.promise(() => import("@/plugin"))
      const project = yield* Project.Service
      const directory = FSUtil.resolve(process.cwd())
      const resolved = yield* project.fromDirectory(directory)
      // 仅绑定真实目录/工作树供 Config 合并；不调用 InstanceStore.load 的 bootstrap 提前执行 hook。
      yield* Plugin.warmupExternalPlugins().pipe(Effect.provideService(InstanceRef, {
        directory,
        worktree: resolved.sandbox,
        project: resolved.project,
      }))
    }).pipe(
      // 上下文解析自身失败也只取消预热，监听启动失败仍走外层非零退出清理。
      Effect.catchCause((cause) => Effect.logWarning("daemon plugin warmup skipped", { cause: String(cause) })),
    )), 0).unref?.()
  } catch {
    // 启动失败走相同资源清理，明确非零退出，不伪造成功锁。
    await gracefulShutdown(1, "startup-failed")
  }

  // 升级只是 advisory，不能阻塞健康锁发布或作为发现成功的另一个条件。
  upgradeTimer = setTimeout(() => {
    // 禁用升级时也不启动Project实例；不能先加载完整上下文再在upgrade内部拒绝检查。
    if (shutdownInProgress || Flag.OPENCODE_DISABLE_AUTOUPDATE) return
    // 仅升级任务为 advisory；实例加载失败同样观测，不能变成致命拒绝。
    void InstanceRuntime.load({ directory: process.cwd() }).then(() => upgrade()).catch(() => {})
  }, 1_000)
  // unref 避免 upgrade timer 独自续命。
  upgradeTimer.unref?.()
}
