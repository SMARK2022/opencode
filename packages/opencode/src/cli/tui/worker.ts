import { Server } from "@/server/server"
import { NetworkProxy } from "@opencode-ai/core/network-proxy"
import { InstanceRuntime } from "@/project/instance-runtime"
import { upgrade } from "@/cli/upgrade"
import { Config } from "@/config/config"
import { Heap } from "@/cli/heap"
import { AppRuntime } from "@/effect/app-runtime"
import { Effect } from "effect"
import { disposeAllInstancesAndEmitGlobalDisposed } from "@/server/global-lifecycle"
import { Database } from "@opencode-ai/core/database/database"
import { ServerLock } from "@/cli/tui/server-lock"
import { EventClients } from "@opencode-ai/server/event-clients"
import { SessionActivity } from "@/session/activity"
import { HttpApiApp } from "@/server/routes/instance/httpapi/server"

Heap.start()

let onUnhandledRejection: (error: unknown) => void = (_error: unknown) => {}

let onUncaughtException: (error: Error) => void = (_error: Error) => {}

process.on("unhandledRejection", onUnhandledRejection)
process.on("uncaughtException", onUncaughtException)

const isDaemon = process.env.OPENCODE_PROCESS_ROLE === "worker"
// 共享 daemon 是唯一生产入口；线程 RPC 不再持有数据库或转发事件。

if (isDaemon) {
  // daemon 插件可能直接调用 fetch，入口安装一次使其共享实时代理策略。
  NetworkProxy.installGlobalFetch()
  // 非print-logs启动时stdout由launcher丢弃；生命周期消息仍携带结构化原因。
  const log = {
    info: (message: string, fields: Record<string, unknown> = {}) => console.log(`[daemon] ${message}`, fields),
  }
  // 资源先声明再启动，外部端口绑定或写锁失败也能清理已开的内部监听。
  let internalServer: Awaited<ReturnType<typeof Server.listen>> | undefined

  // 外部 listener 与内部 listener 使用同一服务树，不能另建应用 runtime 或另一份计数。
  let externalServer: Awaited<ReturnType<typeof Server.listen>> | undefined
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
  
  async function gracefulShutdown(exitCode = 0, reason = "unknown") {
    if (shutdownInProgress) return
    shutdownInProgress = true
    cancelIdleTimer("shutdown")
    cancelStartupIdleTimer("shutdown")
    cancelLauncherWatcher("shutdown")
    log.info("daemon shutting down", { reason, hadClient, sseClients, sessionActivity: SessionActivity.count() })
    // 致命关闭也有上限；只退出当前 daemon，不向其他 owner 发终止信号。
    const shutdownTimer = setTimeout(() => process.exit(1), 5_000)
    shutdownTimer.unref?.()
    if (upgradeTimer) clearTimeout(upgradeTimer)
    // 每个资源独立清理；dispose 失败不能跳过停监听或关闭 runtime 的数据库 scope。
    const disposed = await Promise.allSettled([InstanceRuntime.disposeAllInstances()])
    // 监听资源归 daemon 所有，共享它的 TUI 退出只释放自己的连接。
    const stopped = await Promise.allSettled([externalServer?.stop(true), internalServer?.stop(true)])
    // 停止监听后才释放发现锁，避免另一个启动方在旧端口尚被占用时替换 owner。
    const cleared = await Promise.allSettled([lockToken ? ServerLock.clearIfOwner(lockToken) : Promise.resolve()])
    const runtime = await Promise.allSettled([AppRuntime.dispose()])
    // Database Layer 的 finalizer 在 native close 前 checkpoint，监听 scope 与 runtime 均照常释放。
    clearTimeout(shutdownTimer)
    process.exit(exitCode || ([...disposed, ...stopped, ...cleared, ...runtime].some((item) => item.status === "rejected") ? 1 : 0))
  }

  // SIGTERM 也必须经过 token/scope 清理；正常信号退出码与 fatal 的非零退出码分开。
  process.on("SIGTERM", () => void gracefulShutdown(0, "signal:SIGTERM"))

  // daemon 致命路径替换线程空监听，启动与空闲阶段共享同一资源清理闭包。
  process.off("unhandledRejection", onUnhandledRejection)
  process.off("uncaughtException", onUncaughtException)
  onUnhandledRejection = (_error: unknown) => {
    void gracefulShutdown(1, "unhandledRejection")
  }
  onUncaughtException = (_error: Error) => {
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
    // 缩短默认空闲窗口：最后一个 TUI 断开后守护进程只作短暂收尾，防孤儿 daemon 长驻拖机
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
    const network = process.env.OPENCODE_EXTERNAL_NETWORK
      ? JSON.parse(process.env.OPENCODE_EXTERNAL_NETWORK) as NonNullable<ServerLock.ServerLock["network"]>
      : undefined
    if (network) {
      // 外部网络选项完整运输，cors/mdnsDomain 与共享客户端计数不因内部预热而丢失。
      externalServer = await Server.listen({ ...network, eventClients, sharedServices })
      externalUrl = externalServer.url.toString()
    }
    // 内部认证监听就绪后才发布发现锁，外部 URL 不代替内部健康通道。
    lockToken = await ServerLock.write(internalServer.port, externalUrl, network)
    log.info("daemon lock written", { pid: process.pid, port: internalServer.port, externalUrl, launcherPID: LAUNCHER_PID })
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
    // shutdown 已开始时 callback 不再加载新实例。
    if (shutdownInProgress) return
    // 仅升级任务为 advisory；实例加载失败同样观测，不能变成致命拒绝。
    void InstanceRuntime.load({ directory: process.cwd() }).then(() => upgrade()).catch(() => {})
  }, 1_000)
  // unref 避免 upgrade timer 独自续命。
  upgradeTimer.unref?.()
}
