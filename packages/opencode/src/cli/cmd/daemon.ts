import { cmd } from "@/cli/cmd/cmd"
import { UI } from "@/cli/ui"
import { errorMessage } from "@opencode-ai/tui/util/error"
import { ServerLock } from "@/cli/tui/server-lock"
import { withNetworkOptions } from "@/cli/network"
import { NetworkProxy } from "@opencode-ai/core/network-proxy"
// #532：机器接口复用 discover 的 owner 分类与拉起 seam，不解析 lock/选端口
import { connectionInfo, discoverOrSpawnDaemon } from "./tui"

// #259：stop 只等待 worker 既有 graceful shutdown 完成，不升级为 SIGKILL
// 10 秒足够覆盖实例 dispose、server close 和数据库 close，超时则保留现场让用户人工判断
const STOP_TIMEOUT_MS = 10_000
// #259：100ms 是本命令的本地轮询间隔——足够快地反馈 CLI，同时避免对 lock 文件做忙等读取
const STOP_POLL_INTERVAL_MS = 100
// 强停仅在认证请求成功且同 owner 复核后发生，确认死亡仍有独立短预算。
const FORCE_STOP_TIMEOUT_MS = 1_000

export const DaemonCommand = cmd({
  // #259：这里只注册本机 TUI 共享 daemon 的管理入口；不复用 serve，避免把 headless server 生命周期混入
  command: "daemon",
  describe: "manage the shared opencode daemon",
  builder: (yargs) =>
    yargs.command(DaemonStatusCommand).command(DaemonStartCommand).command(DaemonStopCommand).demandCommand(),
  async handler() {},
})

// #532：status 是观察接口，缺少 owner 时返回 running=false 且不得进入 ensure 选主。
// JSON 不包含 token/controlPort/dbPath，外部 client 只获得连接所需最小 authority。
// stdout 保持单值协议，日志继续走 stderr，避免 Node 调用方猜测人类输出。
// responsive=false 仍报告同一存活 owner，调用方不得据此创建第二个 daemon。
const DaemonStatusCommand = cmd({
  command: "status",
  describe: "report the shared opencode daemon connection",
  builder: (yargs) =>
    yargs.option("json", {
      type: "boolean",
      demandOption: true,
      describe: "write one machine-readable JSON result to stdout",
    }),
  async handler() {
    // stdout 是外部 client 的协议通道；UI logo、日志和人类诊断必须继续留在 stderr
    process.stdout.write(JSON.stringify(await connectionInfo()) + "\n")
  },
})

// #532：start 只把跨进程请求交给现有 discoverOrSpawnDaemon，CLI 自身不解析 lock 或选择端口。
// launcher PID 来自长期 client，保护首个 SSE 前窗口而不是绑定短命 CLI。
// discover 返回后重新查询同一 owner identity，避免输出 spawn wrapper 或旧 lock PID。
const DaemonStartCommand = cmd({
  command: "start",
  describe: "ensure the shared opencode daemon is running",
  builder: (yargs) =>
    yargs
      .option("json", {
        type: "boolean",
        demandOption: true,
        describe: "write one machine-readable JSON result to stdout",
      })
      .option("launcher-pid", {
        type: "number",
        demandOption: true,
        describe: "client process that protects startup until the first global SSE connection",
      }),
  async handler(args) {
    // 正整数门禁属于 CLI trust seam；无效 PID 不能进入 worker 环境并改变 startup idle 语义
    if (!Number.isSafeInteger(args.launcherPid) || args.launcherPid <= 0)
      throw new Error("launcher-pid must be a positive integer")
    await discoverOrSpawnDaemon(
      { port: 0, hostname: "127.0.0.1", mdns: false, "mdns-domain": "opencode.local", cors: [] },
      undefined,
      args.launcherPid,
    )
    const info = await connectionInfo()
    if (!info.running) throw new Error("opencode daemon owner disappeared after startup")
    // discover 与快照共用同一 owner 分类，不向调用方泄漏或要求解析 ServerLock
    process.stdout.write(JSON.stringify(info) + "\n")
  },
})

const DaemonStopCommand = cmd({
  // 先请求正常关闭；超时后只终止重新确认的同一 owner。
  command: "stop",
  describe: "stop the shared opencode daemon",
  builder: (yargs) => withNetworkOptions(yargs),
  async handler() {
    // #535：typed result 由命令层统一渲染；错误以 throw 传播由 catch 统一转 stderr+exitCode
    try {
      const result = await stopDaemon({ progress: (message) => UI.println(message) })
      if (result.type === "absent") UI.println("No opencode daemon is running.")
      if (result.type === "stale") UI.println("Removed stale opencode daemon lock.")
      if (result.type === "stopped")
        UI.println(result.forced ? "Force-stopped opencode daemon." : "Stopped opencode daemon.")
    } catch (error) {
      UI.error(errorMessage(error))
      process.exitCode = 1
    }
  },
})

// #535：stopDaemon 导出为 db 维护域的唯一安全停机 owner：expected 绑定 prompt 时用户看到的 PID/token，
// maintenanceIdle 请求 conditional shutdown，progress 承接人类进度；typed result 让调用方获得 offline 授权。
export async function stopDaemon(
  input: { expected?: ServerLock.ServerLock; maintenanceIdle?: boolean; progress?: (message: string) => void } = {},
) {
  // 与发现共用DB/channel定位；网络参数不另建同库owner，也无需启动runtime读取配置。
  const lockPath = ServerLock.placement()
  // CLI 没有经过发现入口；私有 token 请求仍须绕过父进程继承的代理。
  const noProxy = NetworkProxy.noProxyString(
    [process.env.NO_PROXY, process.env.no_proxy].flatMap((value) =>
      (value ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  )
  process.env.NO_PROXY = noProxy
  process.env.no_proxy = noProxy
  // #535：expected 来自用户看到的 prompt；首次 control request 前就必须校验，不能只保护超时后的 force 阶段。
  const observed = await ServerLock.read(lockPath)
  if (input.expected && observed && !sameOwner(observed, input.expected)) {
    throw new Error(`Refused to stop opencode daemon pid=${input.expected.pid}: daemon owner changed.`)
  }
  // #535：expected 将用户看到的 PID/token 绑定到首次 shutdown；无新 owner 时旧进程自然退出可视为已停止。
  if (input.expected && !observed) {
    if (!ServerLock.alive(input.expected.pid)) return finishStop(input.expected, false, lockPath)
    throw new Error(`Refused to stop opencode daemon pid=${input.expected.pid}: daemon lock disappeared.`)
  }
  const lock = input.expected ?? observed

  if (!lock) {
    // #259：没有 lock 表示当前 CLI 管辖范围内没有 TUI daemon；保持 0 退出码，便于脚本重复调用。
    return { type: "absent" as const }
  }

  if (!ServerLock.alive(lock.pid)) {
    // #259：pid 已不存在时只清理同 token lock；这样不会误删刚重启 daemon 写入的新 lock。
    if (input.expected) return finishStop(lock, false, lockPath)
    await ServerLock.clearIfOwner(lock.token, lockPath)
    return { type: "stale" as const }
  }

  const controlPort = lock.controlPort
  if (!controlPort) {
    // #259：旧 lock 没有私有 control port 时无法证明 pid 与 HTTP daemon 的所有权关系；
    // 为了避免退化成误杀风险，这里拒绝 fallback 到 process.kill。
    throw new Error(
      `opencode daemon pid=${lock.pid} does not support safe stop; restart the TUI or wait for idle shutdown.`,
    )
  }

  // 已接受的graceful超时或显式stop未获应答，均须先复核同一owner才可进入原force分支。
  // #535：maintenance-idle 的 409 是业务拒绝，不得降级成普通 shutdown 或 process.kill。
  const requestError = await requestStop(lock, controlPort, input.maintenanceIdle === true)
  // 应答拒绝不授权强停，无应答仅给显式stop开放既有恢复路径。
  if (requestError?.type === "rejected") {
    throw new Error(`Failed to request opencode daemon shutdown pid=${lock.pid}: ${requestError.message}`)
  }
  // maintenanceIdle须获worker明确接受，无应答不等于空闲，不得中断可能在跑的维护。
  if (requestError?.type === "unreachable" && input.maintenanceIdle === true) {
    throw new Error(`Failed to request opencode daemon shutdown pid=${lock.pid}: ${requestError.message}`)
  }

  if (!requestError) {
    input.progress?.(`Stopping opencode daemon pid=${lock.pid}...`)
    if (await waitForStop(lock)) {
      return finishStop(lock, false, lockPath)
    }
  }

  // #523：graceful 超时后必须重读 lock 再确认 owner；期间换代的新 daemon 不能被旧 stop 误杀。
  const current = await ServerLock.read(lockPath)
  if (!sameOwner(current, lock)) {
    throw new Error(`Refused to force-stop opencode daemon pid=${lock.pid}: daemon owner changed.`)
  }
  if (!ServerLock.alive(lock.pid)) {
    // #523：等待窗口内 owner 自然退出——仍走同 token 清锁，避免误删换代后的新锁。
    return finishStop(lock, false, lockPath)
  }

  input.progress?.(`Graceful stop timed out; force-stopping opencode daemon pid=${current.pid}...`)
  const forceError = await forceStop(lock)
  if (forceError) {
    // #523：SIGKILL 后仍存活属异常态；锁保留给下次 stop 或 stale 清理，不在此处盲删。
    throw new Error(`Failed to force-stop opencode daemon pid=${lock.pid}: ${forceError}`)
  }
  return finishStop(lock, true, lockPath)
}

// #535：所有成功 stop 都在这里完成最后一次 owner 校验，调用方拿到 stopped 时才真正获得 offline handoff。
async function finishStop(lock: ServerLock.ServerLock, forced: boolean, lockPath: string) {
  // PID 退出到 offline 授权之间再次读取 lock；replacement 出现时 token-safe clear 不足以证明数据库无人持有。
  const replacement = await ServerLock.read(lockPath)
  if (replacement && !sameOwner(replacement, lock)) throw new Error(`Refused offline handoff: daemon owner changed.`)
  await ServerLock.clearIfOwner(lock.token, lockPath)
  return { type: "stopped" as const, forced }
}

async function requestStop(
  lock: ServerLock.ServerLock,
  controlPort: number,
  maintenanceIdle: boolean,
): Promise<undefined | { type: "rejected" | "unreachable"; message: string }> {
  try {
    // #535：maintenance-idle query 请求 conditional shutdown——active/pending 维护时 daemon 返回 409。
    const url = new URL(`http://127.0.0.1:${controlPort}${ServerLock.CONTROL_SHUTDOWN_PATH}`)
    if (maintenanceIdle) url.searchParams.set("maintenance-idle", "1")
    const response = await fetch(url, {
      method: "POST",
      // #259：control token 复用 lock token——端口证明"本机私有控制面"，token 证明"当前 lock owner"
      headers: { [ServerLock.CONTROL_TOKEN_HEADER]: lock.token },
      // #259：控制面请求自身必须有界——daemon 卡死时 stop 不能跟着无限悬挂
      signal: AbortSignal.timeout(1_000),
    })
    if (response.ok) return
    return { type: "rejected", message: `control endpoint returned ${response.status}` }
  } catch (error) {
    return { type: "unreachable", message: errorMessage(error) }
  }
}

async function waitForStop(lock: ServerLock.ServerLock, timeoutMs = STOP_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs
  // 清锁或控制端口断开不代表进程已退出，成功条件仍是实际 PID 消失。

  while (Date.now() < deadline) {
    if (!ServerLock.alive(lock.pid)) return true
    await Bun.sleep(Math.min(STOP_POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())))
  }

  return false
}

function sameOwner(
  current: ServerLock.ServerLock | undefined,
  expected: ServerLock.ServerLock,
): current is ServerLock.ServerLock {
  // PID、token 和私有端口三者均来自重新读取的 owner，不能凭旧 PID 授权强停。
  // #535：dbPath 参与 identity，防止共享 lock 位置异常时把另一数据库的 daemon 当成原 owner。
  return (
    current !== undefined &&
    current.pid === expected.pid &&
    current.token === expected.token &&
    current.controlPort === expected.controlPort &&
    current.dbPath === expected.dbPath
  )
}

async function forceStop(lock: ServerLock.ServerLock) {
  // 发信号不等于确认死亡；kill 抛错后也须复核退出竞态，存活则保留原错误。
  try {
    process.kill(lock.pid, "SIGKILL")
  } catch (error) {
    if (!ServerLock.alive(lock.pid)) return
    return errorMessage(error)
  }
  if (await waitForStop(lock, FORCE_STOP_TIMEOUT_MS)) return
  return `daemon pid=${lock.pid} is still alive after force stop`
}
