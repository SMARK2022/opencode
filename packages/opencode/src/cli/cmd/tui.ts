import { cmd } from "@/cli/cmd/cmd"
import { ServerLock } from "@/cli/tui/server-lock"
import { Flock } from "@opencode-ai/core/util/flock"
import { Global } from "@opencode-ai/core/global"
import path from "path"
import { fileURLToPath } from "url"
import { UI } from "@/cli/ui"
import { errorMessage } from "@opencode-ai/tui/util/error"
import { withNetworkOptions, resolveNetworkOptionsNoConfig, hasArg } from "@/cli/network"
import { Filesystem } from "@/util/filesystem"
import type { UpdateNotice, UpdateSource } from "@opencode-ai/tui"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { writeHeapSnapshot } from "v8"
import { validateSession } from "../tui/validate-session"
import { win32InstallCtrlCGuard } from "@opencode-ai/tui/terminal-win32"

declare global {
  const OPENCODE_WORKER_PATH: string
}

// 唯一生产 spawn seam 同时用于注入测试；测试不能另跑一条模拟发现算法。
export const DaemonProcess = {
  // Bun 支持 windowsHide；直接启动 worker，不经可见 pwsh 窗口或改变用户弹窗工具。
  spawn: (cmd: string[], opts: Parameters<typeof Bun.spawn>[1]) => Bun.spawn(cmd, { ...opts, windowsHide: true }),
}

// Mirrors the V2 CLI updater: the TUI process checks every 10 minutes and installs on this machine,
// but only when the user picks an option in the /update dialog.
function createUpdater(latest: () => Promise<UpdateNotice | undefined>): UpdateSource {
  const listeners = new Set<(notice: UpdateNotice) => void>()
  let current: UpdateNotice | undefined
  const check = () =>
    latest()
      .then((notice) => {
        if (!notice || JSON.stringify(notice) === JSON.stringify(current)) return
        current = notice
        listeners.forEach((notify) => notify(notice))
      })
      .catch(() => {})
  setTimeout(check, 1000).unref?.()
  setInterval(check, 10 * 60 * 1000).unref?.()
  return {
    subscribe: (notify) => {
      if (current) notify(current)
      listeners.add(notify)
      return () => listeners.delete(notify)
    },
    check: async () => {
      const { Installation } = await import("@/installation")
      // A failed check leaves latest unset, which /update reports as "Couldn't check for updates."
      const latest = await Installation.latest(await Installation.method()).catch(() => undefined)
      return { current: InstallationVersion, latest }
    },
    apply: async (target) => {
      const { Installation } = await import("@/installation")
      const method = await Installation.method()
      if (method === "unknown") throw new Error("Installation method not found")
      if (target.type === "major") return Installation.upgradeMajor(method)
      return Installation.upgrade(method, target.version)
    },
  }
}

async function target() {
  if (typeof OPENCODE_WORKER_PATH !== "undefined") return OPENCODE_WORKER_PATH
  const dist = new URL("./cli/tui/worker.js", import.meta.url)
  // 编译入口与源码入口共用 argv，文件 URL 必须在启动边界转换成原生路径。
  if (await Filesystem.exists(fileURLToPath(dist))) return fileURLToPath(dist)
  return fileURLToPath(new URL("../tui/worker.ts", import.meta.url))
}

// 依赖注入只替换外部 I/O，身份判断与失败清理仍执行下面的生产主路径。
export type DiscoverDaemonDeps = {
  read: typeof ServerLock.read
  alive: typeof ServerLock.alive
  ping: typeof ServerLock.ping
  clear: typeof ServerLock.clearIfOwner
  acquire: typeof Flock.acquire
  spawn: typeof DaemonProcess.spawn
  sleep: (ms: number) => Promise<unknown>
  resolveDaemonFile: () => Promise<string>
  identity: typeof ServerLock.identity
  placement: typeof ServerLock.placement
  resolveNetwork: (args: Parameters<typeof resolveNetworkOptionsNoConfig>[0]) => Promise<ReturnType<typeof resolveNetworkOptionsNoConfig>>
  electionTimeoutMs: number
  electionStaleMs: number
  pollMs: number
  waitMs: number
}

// 默认依赖不缓存发现结果；新的启动方必须重新核对磁盘 owner 与认证配置。
// 只缩短 contender 等待和探测频率，完整启动 deadline 仍由独立 waitMs 约束。
const defaultDiscoverDeps = (): DiscoverDaemonDeps => ({
  read: ServerLock.read,
  alive: ServerLock.alive,
  ping: ServerLock.ping,
  clear: ServerLock.clearIfOwner,
  acquire: Flock.acquire,
  spawn: DaemonProcess.spawn,
  sleep: (ms) => Bun.sleep(ms),
  resolveDaemonFile: target,
  identity: ServerLock.identity,
  placement: ServerLock.placement,
  // 全局 server 配置与 CLI 显式值按现有 network owner 合并，复用前即解析。
  resolveNetwork: async (args) => {
    const { AppRuntime } = await import("@/effect/app-runtime")
    const { resolveNetworkOptions } = await import("@/cli/network")
    return AppRuntime.runPromise(resolveNetworkOptions(args))
  },
  // 选举等待只限制 contender，不缩短成功持锁者启动健康服务的完整预算。
  // acquire 超时必须显式失败，不能在未获得租约时私自拉起另一个同身份服务。

  electionTimeoutMs: 10_000,
  // staleMs 交给已有 Flock heartbeat 维护，不能凭 HTTP 超时自行打破活租约。
  // Flock 持有期间仍按 staleMs 更新 heartbeat，长启动不等于 lease 已失效。

  electionStaleMs: 5_000,
  // 启动轮询等待 owner 写锁，不能把尚未发布端口的进程当作可复用服务。
  // 增大间隔减少未发布 owner 的无效读取；就绪验证仍检查同一子 PID 和受保护 health。

  pollMs: 200,
  waitMs: 30_000,
})

export async function discoverOrSpawnDaemon(
  networkArgs: Parameters<typeof resolveNetworkOptionsNoConfig>[0],
  deps: DiscoverDaemonDeps = defaultDiscoverDeps(),
): Promise<{ url: string; fwdPid?: number }> {
  // 身份与网络请求先于快速路径解析，禁止复用另一数据库或忽略显式外部端口。
  const identity = deps.identity()
  const network = await deps.resolveNetwork(networkArgs)
  const external = ["--port", "--hostname", "--mdns", "--mdns-domain", "--cors"].some(hasArg) ||
    network.mdns || network.port !== 0 || network.hostname !== "127.0.0.1" || network.cors.length > 0
  // 同一 DB/channel 共用发现路径；显式网络请求只在复用检查中判断兼容性。
  const lockPath = deps.placement()
  async function reuse(lock: ServerLock.ServerLock | undefined) {
    if (!lock || !deps.alive(lock.pid)) return null
    // 活进程身份不符或认证失败均保留原锁，不另建备用 daemon，也不杀其他进程。
    const dbPath = path.normalize(lock.dbPath)
    const expectedPath = path.normalize(identity.dbPath)
    if ((process.platform === "win32" ? dbPath.toLowerCase() !== expectedPath.toLowerCase() : dbPath !== expectedPath) || lock.channel !== identity.channel)
      throw new Error("Existing opencode daemon has a different database or channel; stop it explicitly before switching")
    if (external && (!lock.externalUrl || JSON.stringify(lock.network) !== JSON.stringify(network)))
      throw new Error("Existing opencode daemon has incompatible network options; stop it explicitly before changing listeners")
    if (!(await deps.ping(lock.port))) throw new Error("Existing opencode daemon health or authentication check failed")
    // 探测期间锁可能换主；复读 token 后才允许把地址交给 TUI。
    const current = await deps.read(lockPath)
    if (current?.token !== lock.token || current.pid !== lock.pid) throw new Error("Opencode daemon ownership changed during discovery")
    return external && lock.externalUrl ? lock.externalUrl : `http://127.0.0.1:${lock.port}`
  }
  // 快速检查与持锁复查都调用 reuse，身份、认证与 token 校验不分叉。
  let existingUrl = await reuse(await deps.read(lockPath))
  let fwdPid: number | undefined

  // URL 为空只能进入选举或失败出口，不能返回一个猜测的旧端口作为成功。
      
  if (!existingUrl) {
    // Flock key 与发现路径绑定，四个并发 TUI 对同一身份只能产生一个 winner。
    // 租约由此作用域获取并 finally 释放，调用方不能传入已持有的 lease。
    const electionLease = await deps.acquire(`opencode.server:${lockPath ?? "default"}`, {
      dir: path.join(Global.Path.state, "locks"),
      timeoutMs: deps.electionTimeoutMs,
      staleMs: deps.electionStaleMs,
    })
    try {
      // acquire 等待期间其他 contender 可能已完成启动，持锁后重新读取 owner。
      const lock = await deps.read(lockPath)
      existingUrl = await reuse(lock)
      // 仅清除已确认死亡的 owner；短暂不可达的存活服务不能被替换。
      if (!existingUrl && lock) await deps.clear(lock.token, lockPath)

      if (existingUrl) {
        return { url: existingUrl }
      } else {
        const daemonFile = await deps.resolveDaemonFile()
        const printLogs = process.argv.includes("--print-logs")
        const env = Object.fromEntries(
          Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
        )
        // 编译二进制必须凭 worker 环境角色旁路 yargs，不能把模块路径当成用户 project。
        const proc = deps.spawn([process.execPath, daemonFile], {
          env: {
            ...env,
            OPENCODE_PROCESS_ROLE: "worker",
            ...(lockPath ? { OPENCODE_LOCK_PATH: lockPath } : {}),
            // 覆盖继承的外部监听变量，避免内部请求误启动旧的外部端口。
            OPENCODE_EXTERNAL_NETWORK: external ? JSON.stringify(network) : "",
            ...(printLogs ? { OPENCODE_PRINT_LOGS: "1" } : {}),
          },
          stdin: "ignore",
          stdout: printLogs ? "inherit" : "ignore",
          stderr: printLogs ? "inherit" : "ignore",
        })
        try {
          // exited 的拒绝先安装 observer；read/unref 的同步异常仍由两层 finally 清理。
          void proc.exited.catch(() => undefined)
          proc.unref()
          fwdPid = proc.pid

          // 等待放在 proc 与 lease 的 finally 内，sleep 拒绝也不能泄漏选举所有权。
          // 完整启动预算从 sleep 后开始，不能用避让早期探测的延迟吃掉健康等待时间。
          await deps.sleep(1000)
          const deadline = Date.now() + deps.waitMs
          // 端口即使被其他健康服务占用，也不能替代本次子进程 PID 的发现锁。
          while (Date.now() < deadline) {
            const daemonLock = await deps.read(lockPath)
            if (daemonLock && daemonLock.pid === proc.pid && deps.alive(daemonLock.pid) && await deps.ping(daemonLock.port)) {
              // 只交付本次子进程已发布且通过认证的锁，未知 owner 不进入本次清理范围。
              existingUrl = await reuse(daemonLock)
              if (existingUrl) break
            }
            await deps.sleep(deps.pollMs)
          }

          if (!existingUrl) {
            // deadline 只结束此次交付尝试，清理随后只作用于尚未交付的 proc handle。
            UI.error("opencode daemon failed to start within 30 seconds")
            throw new Error("opencode daemon failed to start within 30 seconds")
          }
        } finally {
          // 只终止本次启动且尚未交付的子进程；read/sleep/ping 异常也会进入此处。
          if (!existingUrl) proc.kill()
        }
      }
    } finally {
      // acquire 的同一作用域释放租约，spawn 同步抛错也不依赖返回值交接。
      await electionLease.release()
    }
  }

  if (!existingUrl) throw new Error("Opencode daemon discovery produced no ready listener")
  return { url: existingUrl, fwdPid }
}

async function input(value?: string) {
  const piped = process.stdin.isTTY ? undefined : await Bun.stdin.text()
  if (!value) return piped
  if (!piped) return value
  return piped + "\n" + value
}

export function resolveThreadDirectory(project?: string, envPWD = process.env.PWD, cwd = process.cwd()) {
  const root = Filesystem.resolve(envPWD ?? cwd)
  if (project) return Filesystem.resolve(path.isAbsolute(project) ? project : path.join(root, project))
  return Filesystem.resolve(cwd)
}

export const TuiThreadCommand = cmd({
  command: "$0 [project]",
  describe: "start opencode tui",
  builder: (yargs) =>
    withNetworkOptions(yargs)
      .positional("project", {
        type: "string",
        describe: "path to start opencode in",
      })
      .option("model", {
        type: "string",
        alias: ["m"],
        describe: "model to use in the format of provider/model",
      })
      .option("continue", {
        alias: ["c"],
        describe: "continue the last session",
        type: "boolean",
      })
      .option("session", {
        alias: ["s"],
        type: "string",
        describe: "session id to continue",
      })
      .option("fork", {
        type: "boolean",
        describe: "fork the session when continuing (use with --continue or --session)",
      })
      .option("prompt", {
        type: "string",
        describe: "prompt to use",
      })
      .option("agent", {
        type: "string",
        describe: "agent to use",
      })
      .option("auto", {
        type: "boolean",
        describe: "auto-approve permissions that are not explicitly denied (dangerous!)",
        default: false,
      })
      .option("yolo", {
        type: "boolean",
        hidden: true,
        default: false,
      })
      .option("dangerously-skip-permissions", {
        type: "boolean",
        hidden: true,
        default: false,
      })
      .option("mini", {
        type: "boolean",
        describe: "start the minimal interactive interface",
        default: false,
      })
      .option("replay", {
        type: "boolean",
        hidden: true,
      })
      .option("no-replay", {
        type: "boolean",
        describe: "disable mini session history replay on resume and after resize",
      })
      .option("replay-limit", {
        type: "number",
        describe: "cap visible mini replay to the newest N messages",
      })
      .option("demo", {
        type: "boolean",
        hidden: true,
      }),
  handler: async (args) => {
    if (args.replay === true) {
      UI.error("--replay is not supported; replay is enabled by default")
      process.exitCode = 1
      return
    }
    const noReplay = args.replay === false || args.noReplay === true

    if (args.mini) {
      const network = ["--port", "--hostname", "--mdns", "--no-mdns", "--mdns-domain", "--cors"].find((option) =>
        process.argv.some((arg) => arg === option || arg.startsWith(option + "=")),
      )
      if (network) {
        UI.error(`${network} cannot be used with --mini`)
        process.exitCode = 1
        return
      }

      const { runMini } = await import("./run")
      await runMini({
        directory: resolveThreadDirectory(args.project),
        continue: args.continue,
        session: args.session,
        fork: args.fork,
        model: args.model,
        agent: args.agent,
        prompt: args.prompt,
        replay: noReplay ? false : undefined,
        replayLimit: args.replayLimit,
        demo: args.demo,
      })
      return
    }

    const unsupported = [
      ["--no-replay", noReplay],
      ["--replay-limit", args.replayLimit !== undefined],
      ["--demo", args.demo !== undefined],
    ].find((entry) => entry[1])?.[0]
    if (unsupported) {
      UI.error(`${unsupported} requires --mini`)
      process.exitCode = 1
      return
    }

    const unguard = win32InstallCtrlCGuard()
    // 转发句柄属于 TUI，选举租约在 discoverOrSpawnDaemon 内部闭合。
    let fwdReload: (() => void) | undefined
    try {
      const { TuiConfig } = await import("@/config/tui")
      if (args.fork && !args.continue && !args.session) {
        UI.error("--fork requires --continue or --session")
        process.exitCode = 1
        return
      }

      // Resolve relative --project paths from PWD, then use the real cwd after
      // chdir so the thread and worker share the same directory key.
      const next = resolveThreadDirectory(args.project)
      try {
        process.chdir(next)
      } catch {
        UI.error("Failed to change directory to " + next)
        return
      }
      const cwd = Filesystem.resolve(process.cwd())

      const prompt = await input(args.prompt)
      const config = await TuiConfig.get()

      // chdir 后再发现服务，保证会话 directory 与配置解析使用同一个实际 cwd。
      let existingUrl: string
      try {
        const discovered = await discoverOrSpawnDaemon(args)
        existingUrl = discovered.url
        // Windows 不注册不支持的 SIGUSR2；TUI 也不能因重载信号走共享服务的退出路径。
        if (discovered.fwdPid !== undefined && process.platform !== "win32") {
          const pid = discovered.fwdPid
          fwdReload = () => {
            try {
              process.kill(pid, "SIGUSR2")
            } catch {}
          }
          process.on("SIGUSR2", fwdReload)
        }
      } catch (error) {
        UI.error(errorMessage(error))
        process.exitCode = 1
        return
      }

      // validateSession 和 TUI 必须使用同一发现 URL，避免校验一个库却连接另一个服务。
      // HTTP transport 不能沿用旧内部 RPC 的免认证假设，校验与事件流必须带同一 auth header。
      const headers = ServerLock.headers()
      try {
        await validateSession({
          url: existingUrl,
          sessionID: args.session,
          directory: cwd,
          headers,
        })
      } catch (error) {
        UI.error(errorMessage(error))
        process.exitCode = 1
        return
      }

      // 更新检查沿用原 upgrade owner，只将已移除的 RPC 调用改为同进程调用。
      const updater = createUpdater(async () => {
        const { upgrade } = await import("@/cli/upgrade")
        return upgrade()
      })

      try {
        const { Effect } = await import("effect")
        const { run } = await import("../tui/layer")
        const { createLegacyTuiPluginHost } = await import("@/plugin/tui/runtime")
        await Effect.runPromise(
          run({
            url: existingUrl,
            async onSnapshot() {
              // 不伪造已移除的 RPC snapshot 响应；本回调只返回实际生成的本进程快照。
              return [writeHeapSnapshot("tui.heapsnapshot")]
            },
            config,
            pluginHost: createLegacyTuiPluginHost(),
            directory: cwd,
            headers,
            updater,
            args: {
              continue: args.continue,
              sessionID: args.session,
              agent: args.agent,
              model: args.model,
              prompt,
              fork: args.fork,
              auto: args.auto || args.yolo || args["dangerously-skip-permissions"],
            },
          }),
        )
      } finally {
        // 共享 daemon 可能仍服务其他窗口，TUI finally 只卸载自己的信号监听。
        if (fwdReload) {
          process.off("SIGUSR2", fwdReload)
          fwdReload = undefined
        }
      }
    } finally {
      // 校验会话提前返回时仍卸载转发，避免 TUI 留下 daemon 信号监听。
      if (fwdReload) process.off("SIGUSR2", fwdReload)
      try {
        unguard?.()
      } catch {}
    }
    process.exit()
  },
})
// scratch
