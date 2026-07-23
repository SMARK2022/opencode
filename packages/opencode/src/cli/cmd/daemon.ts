import { cmd } from "./cmd"
import { UI } from "../ui"
import { errorMessage } from "@/util/error"
import { ServerLock, type ServerLock as ServerLockInfo } from "./tui/server-lock"
import { Daemon } from "./tui/daemon"

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
  builder: (yargs) => yargs.command(DaemonStatusCommand).command(DaemonStartCommand).command(DaemonStopCommand).demandCommand(),
  async handler() {},
})

const DaemonStatusCommand = cmd({
  // status是观察接口，缺少owner时返回running=false且不得进入ensure选主。
  // JSON不包含token/controlPort/dbPath，外部client只获得连接所需最小authority。
  // stdout保持单值协议，日志继续走stderr，避免Node调用方猜测人类输出。
  // responsive=false仍报告同一存活owner，调用方不得据此创建第二个daemon。
  command: "status",
  describe: "report the shared opencode daemon connection",
  builder: (yargs) =>
    yargs.option("json", {
      type: "boolean",
      demandOption: true,
      describe: "write one machine-readable JSON result to stdout",
    }),
  async handler() {
    // stdout是外部client的协议通道；UI logo、日志和人类诊断必须继续留在stderr。
    process.stdout.write(JSON.stringify(await Daemon.connectionInfo()) + "\n")
  },
})

const DaemonStartCommand = cmd({
  // start只把跨进程请求交给现有ensure，CLI自身不解析lock或选择端口。
  // launcher PID来自长期client，保护首个SSE前窗口而不是绑定短命CLI。
  // ensure返回后重新查询同一owner identity，避免输出spawn wrapper或旧lock PID。
  // 参数错误直接失败，不使用默认PID掩盖调用方协议缺陷。
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
    // 正整数门禁属于CLI trust seam；无效PID不能进入worker环境并改变startup idle语义。
    if (!Number.isSafeInteger(args.launcherPid) || args.launcherPid <= 0) throw new Error("launcher-pid must be a positive integer")
    await Daemon.ensure({
      launcherPid: args.launcherPid,
      port: 0,
      hostname: "127.0.0.1",
      mdns: false,
      "mdns-domain": "opencode.local",
      cors: [],
    })
    const info = await Daemon.connectionInfo()
    if (!info.running) throw new Error("opencode daemon owner disappeared after startup")
    // ensure与快照共用OpenCode owner分类，不向调用方泄漏或要求解析ServerLock。
    process.stdout.write(JSON.stringify(info) + "\n")
  },
})

const DaemonStopCommand = cmd({
  // `stop` 先请求 graceful shutdown；超时后只对重新确认的同一 owner force stop。
  command: "stop",
  describe: "stop the shared opencode daemon",
  async handler() {
    try {
      const result = await stopDaemon({ progress: (message) => UI.println(message) })
      if (result.type === "absent") UI.println("No opencode daemon is running.")
      if (result.type === "stale") UI.println("Removed stale opencode daemon lock.")
      if (result.type === "stopped") UI.println(result.forced ? "Force-stopped opencode daemon." : "Stopped opencode daemon.")
    } catch (error) {
      UI.error(errorMessage(error))
      process.exitCode = 1
    }
  },
})

export async function stopDaemon(input: { expected?: ServerLockInfo; maintenanceIdle?: boolean; progress?: (message: string) => void } = {}) {
  // stop 的第一阶段仍然只发送现有 authenticated shutdown 请求。
  // 只有该请求成功且 owner 在窗口内没有退出，才允许进入第二阶段。
  // expected 来自用户看到的 prompt；首次 control request 前就必须校验，不能只保护超时后的 force 阶段。
  const observed = await ServerLock.read()
  if (input.expected && observed && !sameOwner(input.expected, observed)) {
    throw new Error(`Refused to stop opencode daemon pid=${input.expected.pid}: daemon owner changed.`)
  }
  // expected 将用户看到的 PID/token 绑定到首次 shutdown；无新 owner 时旧进程自然退出可视为已停止。
  if (input.expected && !observed) {
    if (!ServerLock.alive(input.expected.pid)) return finishStop(input.expected, false)
    throw new Error(`Refused to stop opencode daemon pid=${input.expected.pid}: daemon lock disappeared.`)
  }
  const lock = input.expected ?? observed

  if (!lock) {
    // 没有 lock 表示当前 CLI 管辖范围内没有 TUI daemon；保持 0 退出码，便于脚本重复调用。
    return { type: "absent" as const }
  }

  if (!ServerLock.alive(lock.pid)) {
    // pid 已不存在时只清理同 token lock；这样不会误删刚重启 daemon 写入的新 lock。
    if (input.expected) return finishStop(lock, false)
    await ServerLock.clearIfOwner(lock.token)
    return { type: "stale" as const }
  }

  const controlPort = lock.controlPort
  if (!controlPort) {
    // 旧 lock 没有私有 control port 时无法证明 pid 与 HTTP daemon 的所有权关系；
    // 为了避免退化成误杀风险，这里拒绝 fallback 到 process.kill。
    throw new Error(`opencode daemon pid=${lock.pid} does not support safe stop; restart the TUI or wait for idle shutdown.`)
  }

  // maintenance-idle 的 409 是业务拒绝，不得降级成普通 shutdown 或 process.kill。
  const requestError = await requestStop(lock, controlPort, input.maintenanceIdle === true)
  if (requestError) {
    throw new Error(`Failed to request opencode daemon shutdown pid=${lock.pid}: ${requestError}`)
  }

  input.progress?.(`Stopping opencode daemon pid=${lock.pid}...`)

  if (await waitForStop(lock)) {
    return finishStop(lock, false)
  }

  const current = await ServerLock.read()
  if (!current || !sameOwner(lock, current)) {
    // lock 改变意味着当前命令的观察结果已经过期，宁可失败也不误杀新 owner。
    throw new Error(`Refused to force-stop opencode daemon pid=${lock.pid}: daemon owner changed.`)
  }
  if (!ServerLock.alive(current.pid)) {
    return finishStop(current, false)
  }

  input.progress?.(`Graceful stop timed out; force-stopping opencode daemon pid=${current.pid}...`)
  const forceError = await forceStop(current)
  if (forceError) {
    throw new Error(`Failed to force-stop opencode daemon pid=${current.pid}: ${forceError}`)
  }
  return finishStop(current, true)
}
// 所有成功 stop 都在这里完成最后一次 owner 校验，调用方拿到 stopped 时才真正获得 offline handoff。
async function finishStop(lock: ServerLockInfo, forced: boolean) {
  // PID 退出到 offline 授权之间再次读取 lock；replacement 出现时 token-safe clear 本身不足以证明数据库无人持有。
  const replacement = await ServerLock.read()
  if (replacement && !sameOwner(lock, replacement)) throw new Error(`Refused offline handoff: daemon owner changed.`)
  await ServerLock.clearIfOwner(lock.token)
  return { type: "stopped" as const, forced }
}

async function requestStop(lock: ServerLockInfo, controlPort: number, maintenanceIdle: boolean) {
  try {
    const url = new URL(`http://127.0.0.1:${controlPort}${ServerLock.CONTROL_SHUTDOWN_PATH}`)
    if (maintenanceIdle) url.searchParams.set("maintenance-idle", "1")
    const response = await fetch(url, {
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
  // dbPath 参与 identity，防止共享 lock 位置异常时把另一数据库的 daemon 当成原 owner。
  return left.pid === right.pid && left.token === right.token && left.controlPort === right.controlPort && left.dbPath === right.dbPath
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
