import { cmd } from "./cmd"
import { UI } from "../ui"
import { errorMessage } from "@/util/error"
import { ServerLock, type ServerLock as ServerLockInfo } from "./tui/server-lock"

// graceful 预算保持 10 秒；超时后的 force 只针对重新确认的同一 lock owner。
// 重新读取 lock 是必要的，因为等待期间旧 PID 可能已经退出。
// 如果 lock token、PID 或 controlPort 改变，当前命令不能替新的 owner 做决定。
const STOP_TIMEOUT_MS = 10_000
const FORCE_STOP_TIMEOUT_MS = 1_000
// 100ms 是本命令的本地轮询间隔：足够快地反馈 CLI，同时避免对 lock 文件做忙等读取。
const STOP_POLL_INTERVAL_MS = 100

export const DaemonCommand = cmd({
  // 这里只注册本机 TUI 共享 daemon 的管理入口；不复用 `serve`，避免把 headless server 生命周期混入。
  command: "daemon",
  describe: "manage the shared opencode daemon",
  builder: (yargs) => yargs.command(DaemonStopCommand).demandCommand(),
  async handler() {},
})

const DaemonStopCommand = cmd({
  // `stop` 先请求 graceful shutdown；超时后只对重新确认的同一 owner force stop。
  command: "stop",
  describe: "stop the shared opencode daemon",
  async handler() {
    await stopDaemon()
  },
})

async function stopDaemon() {
  // stop 的第一阶段仍然只发送现有 authenticated shutdown 请求。
  // 只有该请求成功且 owner 在窗口内没有退出，才允许进入第二阶段。
  const lock = await ServerLock.read()

  if (!lock) {
    // 没有 lock 表示当前 CLI 管辖范围内没有 TUI daemon；保持 0 退出码，便于脚本重复调用。
    UI.println("No opencode daemon is running.")
    return
  }

  if (!ServerLock.alive(lock.pid)) {
    // pid 已不存在时只清理同 token lock；这样不会误删刚重启 daemon 写入的新 lock。
    await ServerLock.clearIfOwner(lock.token)
    UI.println("Removed stale opencode daemon lock.")
    return
  }

  const controlPort = lock.controlPort
  if (!controlPort) {
    // 旧 lock 没有私有 control port 时无法证明 pid 与 HTTP daemon 的所有权关系；
    // 为了避免退化成误杀风险，这里拒绝 fallback 到 process.kill。
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
    await ServerLock.clearIfOwner(lock.token)
    UI.println("Stopped opencode daemon.")
    return
  }

  const current = await ServerLock.read()
  if (!current || !sameOwner(lock, current)) {
    // lock 改变意味着当前命令的观察结果已经过期，宁可失败也不误杀新 owner。
    UI.error(`Refused to force-stop opencode daemon pid=${lock.pid}: daemon owner changed.`)
    process.exitCode = 1
    return
  }
  if (!ServerLock.alive(current.pid)) {
    await ServerLock.clearIfOwner(current.token)
    UI.println("Stopped opencode daemon.")
    return
  }

  UI.println(`Graceful stop timed out; force-stopping opencode daemon pid=${current.pid}...`)
  const forceError = await forceStop(current)
  if (forceError) {
    UI.error(`Failed to force-stop opencode daemon pid=${current.pid}: ${forceError}`)
    process.exitCode = 1
    return
  }
  await ServerLock.clearIfOwner(current.token)
  // 只有确认 PID 已经消失后才清理同 token lock，保留其他 owner 的现场。
  UI.println("Force-stopped opencode daemon.")
}

async function requestStop(lock: ServerLockInfo, controlPort: number) {
  try {
    const response = await fetch(`http://127.0.0.1:${controlPort}${ServerLock.CONTROL_SHUTDOWN_PATH}`, {
      method: "POST",
      // control token 复用 lock token：端口证明“本机私有控制面”，token 证明“当前 lock owner”。
      headers: { [ServerLock.CONTROL_TOKEN_HEADER]: lock.token },
      signal: AbortSignal.timeout(1_000),
    })
    if (response.ok) return
    return `control endpoint returned ${response.status}`
  } catch (error) {
    return errorMessage(error)
  }
}

async function waitForStop(lock: ServerLockInfo, timeoutMs = STOP_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    if (!ServerLock.alive(lock.pid)) return true
    await Bun.sleep(STOP_POLL_INTERVAL_MS)
  }

  return false
}

function sameOwner(left: ServerLockInfo, right: ServerLockInfo) {
  return left.pid === right.pid && left.token === right.token && left.controlPort === right.controlPort
}

async function forceStop(lock: ServerLockInfo) {
  // token/PID复核后才允许强制终止，避免旧 stop 命令误杀新 daemon。
  // SIGKILL 只作为 graceful teardown 超时后的最后手段。
  // kill 之后仍然轮询 PID，确认命令没有把“已发送信号”误报成“已停止”。
  try {
    process.kill(lock.pid, "SIGKILL")
  } catch (error) {
    if (!ServerLock.alive(lock.pid)) return
    return errorMessage(error)
  }
  if (await waitForStop(lock, FORCE_STOP_TIMEOUT_MS)) return
  // force 窗口也必须有界，否则 stop 命令会把 worker 的问题再次变成 CLI 挂起。
  return `daemon pid=${lock.pid} is still alive after force stop`
}
