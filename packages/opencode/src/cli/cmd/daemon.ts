import { cmd } from "@/cli/cmd/cmd"
import { UI } from "@/cli/ui"
import { errorMessage } from "@opencode-ai/tui/util/error"
import { ServerLock } from "@/cli/tui/server-lock"
import { withNetworkOptions } from "@/cli/network"
import { NetworkProxy } from "@opencode-ai/core/network-proxy"

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
  builder: (yargs) => yargs.command(DaemonStopCommand).demandCommand(),
  async handler() {},
})

const DaemonStopCommand = cmd({
  // 先请求正常关闭；超时后只终止重新确认的同一 owner。
  command: "stop",
  describe: "stop the shared opencode daemon",
  builder: (yargs) => withNetworkOptions(yargs),
  async handler() {
    await stopDaemon()
  },
})

async function stopDaemon() {
  // 与发现共用DB/channel定位；网络参数不另建同库owner，也无需启动runtime读取配置。
  const lockPath = ServerLock.placement()
  // CLI 没有经过发现入口；私有 token 请求仍须绕过父进程继承的代理。
  const noProxy = NetworkProxy.noProxyString(
    [process.env.NO_PROXY, process.env.no_proxy].flatMap((value) => (value ?? "").split(",").map((s) => s.trim()).filter(Boolean)),
  )
  process.env.NO_PROXY = noProxy
  process.env.no_proxy = noProxy
  const lock = await ServerLock.read(lockPath)

  if (!lock) {
    // #259：没有 lock 表示当前 CLI 管辖范围内没有 TUI daemon；保持 0 退出码，便于脚本重复调用
    UI.println("No opencode daemon is running.")
    return
  }

  if (!ServerLock.alive(lock.pid)) {
    // #259：pid 已不存在时只清理同 token lock——这样不会误删刚重启 daemon 写入的新 lock
    await ServerLock.clearIfOwner(lock.token, lockPath)
    UI.println("Removed stale opencode daemon lock.")
    return
  }

  const controlPort = lock.controlPort
  if (!controlPort) {
    // #259：旧 lock 没有私有 control port 时无法证明 pid 与 HTTP daemon 的所有权关系
    // 为了避免退化成误杀风险，这里拒绝 fallback 到 process.kill
    UI.error(`opencode daemon pid=${lock.pid} does not support safe stop; restart the TUI or wait for idle shutdown.`)
    process.exitCode = 1
    return
  }

  const requestError = await requestStop(lock, controlPort)
  if (requestError) {
    UI.error(`Failed to request opencode daemon shutdown pid=${lock.pid}: ${requestError}`)
    process.exitCode = 1
    return
  }

  UI.println(`Stopping opencode daemon pid=${lock.pid}...`)

  if (await waitForStop(lock)) {
    // #259：只在停止成功后清锁，且仍走同 token 校验——进程若已换代则保留新 owner 的锁
    await ServerLock.clearIfOwner(lock.token, lockPath)
    UI.println("Stopped opencode daemon.")
    return
  }

  // placement 与首次请求一致；等待期间换代的 owner 不能被旧 stop 误杀。
  const current = await ServerLock.read(lockPath)
  if (!sameOwner(current, lock)) {
    UI.error(`Refused to force-stop opencode daemon pid=${lock.pid}: daemon owner changed.`)
    process.exitCode = 1
    return
  }
  if (!ServerLock.alive(lock.pid)) {
    await ServerLock.clearIfOwner(lock.token, lockPath)
    UI.println("Stopped opencode daemon.")
    return
  }

  const forceError = await forceStop(lock)
  if (forceError) {
    UI.error(`Failed to force-stop opencode daemon pid=${lock.pid}: ${forceError}`)
    process.exitCode = 1
    return
  }
  await ServerLock.clearIfOwner(lock.token, lockPath)
  UI.println("Force-stopped opencode daemon.")
}

async function requestStop(lock: ServerLock.ServerLock, controlPort: number) {
  try {
    const response = await fetch(`http://127.0.0.1:${controlPort}${ServerLock.CONTROL_SHUTDOWN_PATH}`, {
      method: "POST",
      // #259：control token 复用 lock token——端口证明"本机私有控制面"，token 证明"当前 lock owner"
      headers: { [ServerLock.CONTROL_TOKEN_HEADER]: lock.token },
      // #259：控制面请求自身必须有界——daemon 卡死时 stop 不能跟着无限悬挂
      signal: AbortSignal.timeout(1_000),
    })
    if (response.ok) return
    return `control endpoint returned ${response.status}`
  } catch (error) {
    return errorMessage(error)
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

function sameOwner(current: ServerLock.ServerLock | undefined, expected: ServerLock.ServerLock) {
  // PID、token 和私有端口三者均来自重新读取的 owner，不能凭旧 PID 授权强停。
  return (
    current !== undefined &&
    current.pid === expected.pid &&
    current.token === expected.token &&
    current.controlPort === expected.controlPort
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
