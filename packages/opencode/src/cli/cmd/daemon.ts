import { cmd } from "./cmd"
import { UI } from "../ui"
import { errorMessage } from "@/util/error"
import { ServerLock, type ServerLock as ServerLockInfo } from "@opencode-ai/tui/server-lock"

// stop 只等待 worker 既有 graceful shutdown 完成，不升级为 SIGKILL；
// 10 秒足够覆盖实例 dispose、server close 和数据库 close，超时则保留现场让用户人工判断。
const STOP_TIMEOUT_MS = 10_000
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
  // `stop` 明确表示 graceful stop：请求 daemon 自己关闭，不提供 force kill 语义。
  command: "stop",
  describe: "gracefully stop the shared opencode daemon",
  async handler() {
    await stopDaemon()
  },
})

async function stopDaemon() {
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

  UI.error(`Timed out waiting for opencode daemon pid=${lock.pid} to stop.`)
  process.exitCode = 1
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

async function waitForStop(lock: ServerLockInfo) {
  const deadline = Date.now() + STOP_TIMEOUT_MS

  while (Date.now() < deadline) {
    if (!ServerLock.alive(lock.pid)) return true
    await Bun.sleep(STOP_POLL_INTERVAL_MS)
  }

  return false
}
