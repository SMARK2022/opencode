import { Server } from "@/server/server"
import { NetworkProxy } from "@opencode-ai/core/network-proxy"
import { InstanceRuntime } from "@/project/instance-runtime"
import { Rpc } from "@/util/rpc"
import { upgrade } from "@/cli/upgrade"
import { Config } from "@/config/config"
import { GlobalBus } from "@/bus/global"
import { ServerAuth } from "@/server/auth"
import { writeHeapSnapshot } from "node:v8"
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

// 相同模块保留线程 RPC 与进程 daemon 两种入口，只按明确 worker 角色选择生命周期。
// 主进程不能同时安装线程转发，否则 GlobalBus 会向没有 parentPort 的 transport 发事件。
const isDaemon = process.env.OPENCODE_PROCESS_ROLE === "worker"

// 旧线程仍使用 RPC fanout，daemon 的 HTTP 客户端不能改变该兼容入口的事件来源。
if (!isDaemon) {
  GlobalBus.on("event", (event) => {
    Rpc.emit("global.event", event)
  })
}


let server: Awaited<ReturnType<typeof Server.listen>> | undefined

export const rpc = {
  async fetch(input: { url: string; method: string; headers: Record<string, string>; body?: string }) {
    const headers = { ...input.headers }
    const auth = ServerAuth.header()
    if (auth && !headers["authorization"] && !headers["Authorization"]) {
      headers["Authorization"] = auth
    }
    const request = new Request(input.url, {
      method: input.method,
      headers,
      body: input.body,
    })
    const response = await Server.Default().app.fetch(request)
    const body = await response.text()
    return {
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      body,
    }
  },
  snapshot() {
    const result = writeHeapSnapshot("server.heapsnapshot")
    return result
  },
  async server(input: { port: number; hostname: string; mdns?: boolean; cors?: string[] }) {
    if (server) await server.stop(true)
    server = await Server.listen(input)
    return { url: server.url.toString() }
  },
  async checkUpgrade(input: { directory: string }) {
    await InstanceRuntime.load({ directory: input.directory })
    return upgrade().catch(() => undefined)
  },
  async reload() {
    await AppRuntime.runPromise(
      Effect.gen(function* () {
        const cfg = yield* Config.Service
        yield* cfg.invalidate()
        yield* disposeAllInstancesAndEmitGlobalDisposed({ swallowErrors: true })
      }),
    )
  },
  async shutdown() {
    await InstanceRuntime.disposeAllInstances()
    if (server) await server.stop(true)
    // 先停止生产者再 checkpoint；server() 的监听重启不能释放进程级数据库。
    try {
      await AppRuntime.runPromise(Effect.gen(function* () {
        const database = yield* Database.Service
        yield* Database.checkpoint(database.db)
      }))
    } finally {
      // checkpoint 剩余失败仍向 RPC 传播；释放不能被拒绝跳过，native close 仍由既有 Layer 负责。
      await AppRuntime.dispose()
    }
    process.off("unhandledRejection", onUnhandledRejection)
    process.off("uncaughtException", onUncaughtException)
  },
}

// RPC 属于线程模式；主进程 daemon 不安装线程的 message handler。
if (!isDaemon) Rpc.listen(rpc)

// 线程入口不创建第二个 HTTP listener，也不安装 daemon 的 idle 退出回调。
if (isDaemon) {
  // daemon 插件可能直接调用 fetch，入口安装一次使其共享实时代理策略。
  NetworkProxy.installGlobalFetch()
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

  // shutdown guard 覆盖 SIGTERM、idle 与 fatal 的并发触发，不能重复 dispose 同一 listener。
  let shutdownInProgress = false

  // 所有退出入口收敛到这个闭包，不能从事件 callback 单独调用 Database.close。
  
  async function gracefulShutdown(exitCode = 0) {
    if (shutdownInProgress) return
    shutdownInProgress = true
    // 致命关闭也有上限；只退出当前 daemon，不向其他 owner 发终止信号。
    const shutdownTimer = setTimeout(() => process.exit(1), 5_000)
    shutdownTimer.unref?.()
    if (idleTimer) clearTimeout(idleTimer)
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
  process.on("SIGTERM", () => void gracefulShutdown())

  // daemon 致命路径替换线程空监听，启动与空闲阶段共享同一资源清理闭包。
  process.off("unhandledRejection", onUnhandledRejection)
  process.off("uncaughtException", onUncaughtException)
  onUnhandledRejection = (_error: unknown) => {
    void gracefulShutdown(1)
  }
  onUncaughtException = (_error: Error) => {
    void gracefulShutdown(1)
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

  const IDLE_TIMEOUT_MS = 30_000

  let hadClient = false
  let sseClients = 0

  // 全部连接断开后仍须等待实际工作结束，不能因 TUI 断线关闭正在生成的会话。
  const armIdleTimer = () => {
    if (idleTimer) {
      clearTimeout(idleTimer)
      idleTimer = undefined
    }
    if (shutdownInProgress || !hadClient || sseClients > 0 || SessionActivity.count() > 0) return
    idleTimer = setTimeout(() => {
      if (shutdownInProgress || sseClients > 0 || SessionActivity.count() > 0) return
      void gracefulShutdown()
    }, IDLE_TIMEOUT_MS)
    idleTimer.unref?.()
  }


  // 内外 listener 继续共用一个计数源，活动变更只重算退出时机。
  const eventClients = EventClients.make((count) => {
    sseClients = count
    if (count > 0) hadClient = true
    armIdleTimer()
  })

  SessionActivity.onChange(armIdleTimer)

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
    await gracefulShutdown(1)
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
