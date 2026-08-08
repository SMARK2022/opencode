import type { Argv } from "yargs"
import { spawn } from "child_process"
import { Database } from "@/storage/db"
import { drizzle } from "drizzle-orm/bun-sqlite"
import { Database as BunDatabase } from "bun:sqlite"
import { UI } from "../ui"
import { cmd } from "./cmd"
import { JsonMigration } from "@/storage/json-migration"
import { EOL } from "os"
import { errorMessage } from "../../util/error"
import { ColdStorage } from "@/storage/cold"
import { ServerLock } from "./tui/server-lock"
import path from "path"
import { SessionID } from "@/session/schema"
import { stopDaemon } from "./daemon"
import { createInterface } from "readline"
import { Flock } from "@opencode-ai/core/util/flock"
import { Global } from "@opencode-ai/core/global"

class MaintenanceUnavailableError extends Error {}

// duration parser 只接受带单位的完整字符串，裸数字不能被不同调用层解释成秒或毫秒。
// 结果统一为毫秒后进入 ColdStorage request，resume 则始终复用持久化后的数值。
// 使用显式 switch 保持单位集合可穷尽，避免索引任意字符串绕过类型和范围验证。
function durationMs(value: string) {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d|w)$/.exec(value.trim().toLowerCase())
  if (!match) throw new ColdStorage.ValidationError({ message: `Invalid duration: ${value}` })
  const amount = Number(match[1])
  const factor = (() => {
    switch (match[2]) {
      case "ms":
        return 1
      case "s":
        return 1_000
      case "m":
        return 60_000
      case "h":
        return 3_600_000
      case "d":
        return 86_400_000
      case "w":
        return 604_800_000
      default:
        throw new ColdStorage.ValidationError({ message: `Invalid duration unit: ${match[2]}` })
    }
  })()
  return amount * factor
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

// daemon 判定同时绑定 pid、dbPath 与私有 controlPort，不能把其他 channel 的 daemon 当作当前 DB owner。
// stale pid 只按 lock token 清理；live daemon 缺 controlPort 时拒绝 direct fallback，避免双 writer 竞争。
// 返回 undefined 只代表启动前已确定的 offline 域，后续 control 失败不会重新选择运行域。
async function liveDaemon() {
  const lock = await ServerLock.read()
  if (!lock) return
  if (path.resolve(lock.dbPath) !== path.resolve(Database.getPath())) return
  if (!ServerLock.alive(lock.pid)) {
    await ServerLock.clearIfOwner(lock.token)
    return
  }
  if (!lock.controlPort) throw new MaintenanceUnavailableError("Live daemon does not expose a maintenance control port")
  return lock
}

// 与 TUI reconnect 共用选主锁；从 expected-owner stop 到 offline 序列结束都禁止 replacement daemon 发布。
function daemonElection() {
  return Flock.acquire("opencode.server", { dir: path.join(Global.Path.state, "locks"), timeoutMs: 75_000, staleMs: 5_000 })
}
// transport seam 不接收 offline callback，确保网络或鉴权失败不能被转换成第二条成功路径。
// control request 总是携带当前 lock token；短 timeout 只约束快速 control acknowledgement。
// 完整 status 扫描随数据库增长，显式 false 避免把合法长计算误报为 daemon 不可达。
// 非 2xx 响应保留 daemon 错误语义，调用方不得在失败后改走 offline 并伪造成功。
// 该 helper 只传输 request/result，不包含 operation SQL、eligibility 或 cursor 推进逻辑。
async function daemonRequest(lock: ServerLock.ServerLock, pathname: string, init?: RequestInit, timeoutMs: number | false = 2_000) {
  const response = await fetch(`http://127.0.0.1:${lock.controlPort}${pathname}`, {
    ...init,
    headers: {
      [ServerLock.CONTROL_TOKEN_HEADER]: lock.token,
      ...(init?.headers ?? {}),
    },
    // false 表示调用方已确认本地 daemon 身份，不再用固定 deadline 截断合法长计算。
    signal: timeoutMs === false ? undefined : AbortSignal.timeout(timeoutMs),
  })
  const body: unknown = await response.json().catch(() => ({ error: `daemon returned ${response.status}` }))
  if (!response.ok) {
    const error = isRecord(body) && typeof body.error === "string" ? body.error : `daemon returned ${response.status}`
    throw new MaintenanceUnavailableError(error)
  }
  return body
}

function printMaintenance(value: unknown) {
  // machine serializer 永远一次写完整 value，进度与 prompt 必须在 mode gate 之外停止。
  UI.println(JSON.stringify(value, null, 2))
}
// mode 在任何 prompt/ANSI 前一次决定，避免同一命令中途从 machine 输出切换成人类输出。
function interactive(json: boolean) {
  // 人类输出同时要求可见终端和可读输入；重定向/脚本不得进入 ANSI 或 prompt 分支。
  return !json && Boolean(process.stdin.isTTY && process.stderr.isTTY)
}
// DB 展示统一使用十进制单位，与既有 maintenance JSON 的原始 byte 计数保持可核对关系。
function size(value: number) {
  const units = ["B", "KB", "MB", "GB", "TB"]
  if (value === 0) return "0 B"
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1000)), units.length - 1)
  return `${(value / 1000 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`
}
// freelist 展示门控用页分配作分母；与 cold rawBytes 无关，避免把逻辑压缩率误当成可 VACUUM 份额。
// 1MB 以下 freelist 视为噪声：不自动 vacuum、不挡路问人。
const RECLAIM_NOISE_BYTES = 1_000_000
// status 黄字建议：绝对 8MB 且占比≥1%，或绝对 64MB 快车道。
const RECLAIM_HINT_BYTES = 8_000_000
const RECLAIM_HINT_RATIO = 0.01
// compress 后 Y/n：比 HINT 更严，避免小收益整库 VACUUM。
const RECLAIM_PROMPT_BYTES = 16_000_000
const RECLAIM_PROMPT_RATIO = 0.02
// 大额绝对回收量绕过占比不足（大库 2% 很难达到）仍应提示。
const RECLAIM_LARGE_BYTES = 64_000_000
// online 观察帧时钟约 10fps；rate 只在 durable counter 变化时重算，避免每帧把吞吐刷成 0。
const PROGRESS_FRAME_MS = 100
const MAINTENANCE_START_TIMEOUT_MS = 10_000

function freelistMetrics(report: Pick<ColdStorage.StatusReport, "freelistPages" | "pageSize" | "pageCount">) {
  const reusable = report.freelistPages * report.pageSize
  // total 固定为 page allocation；禁止用 rawBytes 当占比分母。
  const total = report.pageCount * report.pageSize
  const ratio = total > 0 ? reusable / total : 0
  return { reusable, total, ratio }
}

function reclaimHint(report: Pick<ColdStorage.StatusReport, "freelistPages" | "pageSize" | "pageCount">) {
  const metrics = freelistMetrics(report)
  // HINT 只服务 status Recommendation，不得单独触发写库。
  return metrics.reusable >= RECLAIM_LARGE_BYTES || (metrics.reusable >= RECLAIM_HINT_BYTES && metrics.ratio >= RECLAIM_HINT_RATIO)
}

function reclaimPrompt(report: Pick<ColdStorage.StatusReport, "freelistPages" | "pageSize" | "pageCount">) {
  const metrics = freelistMetrics(report)
  // PROMPT 才授权交互 reclaim；retainedDaemon 路径另有跳过逻辑。
  return metrics.reusable >= RECLAIM_LARGE_BYTES || (metrics.reusable >= RECLAIM_PROMPT_BYTES && metrics.ratio >= RECLAIM_PROMPT_RATIO)
}

// 固定 label 宽度只影响 scrollback 可读性，不参与字段选择或数值计算。
function renderRow(label: string, value: string | number) {
  UI.println(`  ${UI.Style.TEXT_DIM}${label.padEnd(17)}${UI.Style.TEXT_NORMAL}${value}`)
}
// daemon status 是本机鉴权 envelope；offline status 已是同一 StatusReport，本层只消除包裹差异。
function parseStatus(value: unknown): ColdStorage.StatusReport {
  // daemon 返回带 type/report 的 wire envelope，offline 返回 report；本层只校验 envelope 再保留完整指标。
  const report = isRecord(value) && value.type === "status" ? value.report : value
  if (!isRecord(report)) throw new MaintenanceUnavailableError("Invalid database status report")
  // status renderer 只读同一报告，不重新查询或解冻 payload，hidden/stats 字段因此保持原始统计口径。
  return report as ColdStorage.StatusReport
}
// 聚合 renderer 不读取 payload，因此 status 不会因冷数据统计而触发 hydration。
function renderStatus(report: ColdStorage.StatusReport) {
  // reusable 只来自 freelist pages；它是建议 vacuum 的依据，不代表 cold payload 可再压缩量。
  const reusable = report.freelistPages * report.pageSize
  const saved = Math.max(0, report.rawBytes - report.compressedBytes)
  const ratio = report.rawBytes === 0 ? 0 : (saved / report.rawBytes) * 100
  UI.println(`${UI.Style.TEXT_HIGHLIGHT_BOLD}OpenCode database${UI.Style.TEXT_NORMAL}`)
  renderRow("Path", Database.getPath())
  renderRow("Page allocation", size(report.pageCount * report.pageSize))
  renderRow("Active pages", size(report.activeBytes))
  renderRow("Reusable pages", size(reusable))
  UI.empty()
  UI.println(`${UI.Style.TEXT_HIGHLIGHT_BOLD}Cold storage${UI.Style.TEXT_NORMAL}`)
  renderRow("Eligible now", report.eligibleOwners.toLocaleString())
  renderRow("Cold owners", report.coldOwners.toLocaleString())
  renderRow("Raw", size(report.rawBytes))
  renderRow("Compressed", size(report.compressedBytes))
  renderRow("Saved", `${size(saved)} (${ratio.toFixed(1)}%)`)
  renderRow("Shared", size(report.sharedBytes))
  UI.empty()
  UI.println(`${UI.Style.TEXT_HIGHLIGHT_BOLD}Health${UI.Style.TEXT_NORMAL}`)
  renderRow("Orphans", report.orphans.toLocaleString())
  renderRow("Ref mismatch", report.refCountMismatches.toLocaleString())
  // Recommendation 只在 freelist 达到 HINT 时出现，避免几 KB 噪声打扰。
  if (!reclaimHint(report)) return
  UI.empty()
  UI.println(`${UI.Style.TEXT_WARNING_BOLD}Recommendation${UI.Style.TEXT_NORMAL}`)
  UI.println(`  Run ${UI.Style.TEXT_INFO_BOLD}opencode db vacuum --yes${UI.Style.TEXT_NORMAL} to reclaim approximately ${size(reusable)}.`)
}
// task view 只投影 durable record，repair/delete 语义从 args 而非 operation 名称猜测。
function renderTask(task: ColdStorage.MaintenanceTask) {
  // 颜色和符号只增强状态辨识，文本 status 始终保留，重定向去色后仍不丢语义。
  // 状态颜色只映射 durable terminal，不能把 queued/running 预先显示成成功结果。
  const color =
    task.status === "completed"
      ? UI.Style.TEXT_SUCCESS_BOLD
      : task.status === "failed"
        ? UI.Style.TEXT_DANGER_BOLD
        : task.status === "interrupted"
          ? UI.Style.TEXT_WARNING_BOLD
          : UI.Style.TEXT_HIGHLIGHT_BOLD
  const symbol =
    task.status === "completed"
      ? "✓"
      : task.status === "failed"
        ? "×"
        : task.status === "interrupted"
          ? "!"
          : "●"
  const detail =
    task.args.operation === "verify" && (task.args.repair || task.args.repairToolInput === true)
      ? "verify (repair)"
      : task.args.operation === "cleanup" && task.args.delete
        ? "cleanup (delete)"
        : task.operation

  UI.println(task.status === "interrupted" ? `${color}! Maintenance interrupted${UI.Style.TEXT_NORMAL}` : `${color}${symbol} OpenCode database maintenance task${UI.Style.TEXT_NORMAL}`)
  renderRow("Task", task.taskID)
  renderRow("Operation", detail)
  renderRow("Status", task.status)
  renderRow("Processed", `${task.processed.toLocaleString()} owners`)
  renderRow("Skipped", `${task.skipped.toLocaleString()} owners`)
  if (task.rawBytes > 0 || task.compressedBytes > 0)
    renderRow("Payload", `${size(task.rawBytes)} → ${size(task.compressedBytes)}`)
  renderRow("Updated", relativeTime(task.updatedAt))
  if (task.status === "failed" && task.error)
    UI.println(`  ${UI.Style.TEXT_DANGER}${task.error}${UI.Style.TEXT_NORMAL}`)
  if (task.status !== "interrupted") return
  // interrupted task 的 cursor 只能由既有 resume 接口继续；重新 compress 会被 nonterminal 检查拒绝。
  UI.println(`  Resume with: ${UI.Style.TEXT_INFO_BOLD}opencode db resume ${task.taskID}${UI.Style.TEXT_NORMAL}`)
}
// offline runner 仍由既有 lease/checkpoint owner 执行；回调仅观察提交后的 task 快照。
async function runOffline(prepared: ColdStorage.PreparedMaintenance, onTask?: (task: ColdStorage.MaintenanceTask) => void) {
  if (prepared.type === "immediate") {
    if (prepared.request.operation !== "vacuum") return ColdStorage.maintain(prepared)
    const existing = await ServerLock.findNonterminalMaintenanceTask()
    if (existing) throw new ServerLock.MaintenanceBusyError(`Maintenance task already exists: ${existing.taskID}`)
    // vacuum 没有可恢复 cursor，但仍持有同一 maintenance lease，防止与 daemon/offline task 并行写入。
    // pseudo taskID 只标识 lease owner，不创建会误导 status/resume 的持久 task record。
    const lease = await ServerLock.acquireMaintenanceLease({
      taskID: `vacuum_${crypto.randomUUID()}`,
      dbPath: Database.getPath(),
    })
    try {
      return await ColdStorage.maintain(prepared, { lease, checkpoint: async () => {} })
    } finally {
      await lease.release()
    }
  }
  const existing = await ServerLock.findNonterminalMaintenanceTask()
  // record 与 lease 冲突检查先于新 task 写入，避免 UI 进度为一个永远不能获得 owner 的任务启动。
  if (existing) throw new ServerLock.MaintenanceBusyError(`Maintenance task already exists: ${existing.taskID}`)
  // lease owner 先于 queued record 可见，status 不会把仍在启动的 offline task 误判为 interrupted。
  // queued 仍在第一批 DB transaction 前原子落盘；其后 crash 可由 cursor/owner reconcile 恢复。
  // checkpoint 和数据批次由同一 ColdStorage.maintain owner 推进，offline CLI 不复制状态机。
  const lease = await ServerLock.acquireMaintenanceLease(prepared.task)
  try {
    await ServerLock.writeMaintenanceTask(prepared.task)
    return await ColdStorage.maintain(prepared, {
      task: prepared.task,
      lease,
      checkpoint: async (task) => {
        // UI 只能观察已经原子持久化的 checkpoint；先画进度会让屏幕领先可恢复 cursor。
        await ServerLock.writeMaintenanceTask(task)
        onTask?.(task)
      },
    })
  } finally {
    await lease.release()
  }
}

// 执行域只在命令开始时选择一次：live daemon 只走 control，daemon 缺席才走同一 maintain 的 offline 入口。
// 两个域都先调用 prepareMaintenance，保证默认值、写授权、task 分类和错误类型完全一致。
// human compress 会轮询同一持久 task；其他命令保持原来的单次 JSON 结果，不把 disconnect 解释为 task failure。
function compressionProgress(startedAt: number) {
  let visible = false
  let latest: ColdStorage.MaintenanceTask | undefined
  let rateBytes = 0
  let previous: { at: number; bytes: number } | undefined
  // 观察器只在 human compress 创建；因此这里统一发布一次开始行，避免 online/offline 两条输出路径漂移。
  renderCompressionStart()
  const paint = () => {
    if (!latest) return
    visible = true
    const now = performance.now()
    const elapsed = Math.max(1, now - startedAt)
    // 脉冲按墙钟滑动；轨道固定 20 格，不定百分比。
    const offset = Math.floor(elapsed / PROGRESS_FRAME_MS) % 15
    const pulse = `${"·".repeat(offset)}${"█".repeat(6)}${"·".repeat(14 - offset)}`
    const owners = latest.processed.toLocaleString("en-US").padStart(12)
    const rateText = `${size(rateBytes)}/s`.padStart(12)
    const elapsedText = duration(elapsed).padStart(8)
    // 定宽字段 + EL，防止 rate/耗时变短后留下上一帧残影。
    process.stderr.write(
      `\r  ${UI.Style.TEXT_HIGHLIGHT}[${pulse}]${UI.Style.TEXT_NORMAL}  ${owners} owners  ${rateText}  elapsed ${elapsedText}\x1b[K`,
    )
  }
  // online 硬 ~10fps；offline 仅在事件循环空闲时触发（同步 batch 内无法强刷）。
  // 不 await maintain 内部；定时器仅在 CLI 事件循环可运行时刷新（offline 同步批内会停）。
  const timer = setInterval(paint, PROGRESS_FRAME_MS)
  return {
    update(task: ColdStorage.MaintenanceTask) {
      const now = performance.now()
      // rate 只在 rawBytes 变化的 durable 快照之间计算，避免每帧把吞吐刷成 0。
      if (!previous || task.rawBytes !== previous.bytes) {
        rateBytes = previous
          ? Math.round(Math.max(0, task.rawBytes - previous.bytes) / (Math.max(1, now - previous.at) / 1_000))
          : 0
        previous = { at: now, bytes: task.rawBytes }
      }
      latest = task
      paint()
    },
    finish() {
      clearInterval(timer)
      if (visible) process.stderr.write(EOL)
      visible = false
      latest = undefined
    },
  }
}
// 完成耗时使用人类单位；它与活动行的 elapsed 共享同一单调时钟起点。
function duration(value: number) {
  return value < 60_000 ? `${(value / 1_000).toFixed(1)}s` : `${Math.floor(value / 60_000)}m ${(Math.floor(value / 1_000) % 60).toString().padStart(2, "0")}s`
}
// 相对时间避免在紧凑状态中暴露冗长 ISO 字符串，同时不改变持久 updatedAt。
function relativeTime(timestamp: number) {
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1_000))
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  return minutes < 60 ? `${minutes}m ago` : minutes < 1_440 ? `${Math.floor(minutes / 60)}h ago` : `${Math.floor(minutes / 1_440)}d ago`
}
// completed 汇总严格使用 task counters；packed 不能把 skipped/failed 误算为压缩成功。
function renderCompression(task: ColdStorage.MaintenanceTask, elapsed: number) {
  const packed = Math.max(0, task.processed - task.skipped - task.failed)
  const saved = Math.max(0, task.rawBytes - task.compressedBytes)
  const ratio = task.rawBytes === 0 ? 0 : (saved / task.rawBytes) * 100
  UI.println(`${UI.Style.TEXT_SUCCESS_BOLD}✓ Compression completed${UI.Style.TEXT_NORMAL} in ${duration(elapsed)}`)
  UI.empty()
  renderRow("Processed", `${task.processed.toLocaleString()} owners`)
  renderRow("Compressed", `${packed.toLocaleString()} owners`)
  renderRow("Skipped", `${task.skipped.toLocaleString()} owners`)
  renderRow("Failed", task.failed.toLocaleString())
  renderRow("Payload", `${size(task.rawBytes)} → ${size(task.compressedBytes)}`)
  renderRow("Logical saved", `${size(saved)} (${ratio.toFixed(1)}%)`)
}
// 首次 Y/n 只决定执行域；回答 N 不会被后续 reclaim prompt 重新解释为关闭许可。
async function confirm(question: string) {
  const prompt = createInterface({ input: process.stdin, output: process.stderr })
  const answer = (await new Promise<string>((resolve) => prompt.question(question, resolve))).toLowerCase()
  prompt.close()
  return answer !== "n" && answer !== "no"
}
async function confirmDaemonStop(lock: ServerLock.ServerLock) {
  UI.println(`${UI.Style.TEXT_WARNING_BOLD}! OpenCode daemon is running (pid ${lock.pid}).${UI.Style.TEXT_NORMAL}`)
  UI.println("  Stopping it first is recommended for faster maintenance and reliable reclaim.")
  // readline 的 output 必须与 DB CLI 的 stderr 一致；跨 stdout 重绘会在真实 PTY 中抹掉先写出的 prompt。
  return confirm(`${UI.Style.TEXT_WARNING_BOLD}? Stop daemon and continue? [Y/n] ${UI.Style.TEXT_NORMAL}`)
}
// start view 在首个 durable checkpoint 前可见，但不会伪造尚未提交的 owner 计数。
function renderCompressionStart() {
  UI.println(`${UI.Style.TEXT_HIGHLIGHT_BOLD}OpenCode database maintenance${UI.Style.TEXT_NORMAL}`)
  renderRow("Path", Database.getPath())
  UI.empty()
  UI.println(`${UI.Style.TEXT_HIGHLIGHT}●${UI.Style.TEXT_NORMAL} Compressing cold data`)
}
// online 观察以 reconcile 为进度真源；终态后必须 control settlement，避免 terminal→release 窗口误 busy。
async function waitForDaemonTask(lock: ServerLock.ServerLock, taskID: string, renderProgress = true) {
  const started = performance.now()
  const progress = renderProgress ? compressionProgress(started) : undefined
  try {
    // 非终态禁止依赖 control GET：大库 batch 会堵死 worker HTTP，2s ACK 超时会误杀观察器。
    while (true) {
      // reconcile 含 dead-owner 降级；禁止只读 raw JSON 导致 owner 死后无限脉冲。
      let task = await ServerLock.reconcileMaintenanceTask(taskID)
      if (!task) {
        throw new MaintenanceUnavailableError(`Maintenance task not found: ${taskID}`)
      }
      if (task.status === "queued" || task.status === "running") {
        progress?.update(task)
        await Bun.sleep(PROGRESS_FRAME_MS)
        continue
      }
      // 终态（含 retainedDaemon completed）一律走 control GET timeout false 做 lease handoff。
      const settled = await ensureSettled(lock, taskID)
      progress?.finish()
      if (settled.status === "completed") {
        if (progress) renderCompression(settled, performance.now() - started)
        return { type: "task" as const, task: settled }
      }
      if (settled.status === "interrupted") renderTask(settled)
      throw new MaintenanceUnavailableError(settled.error ?? `Maintenance task ${settled.taskID} is ${settled.status}`)
    }
  } finally {
    progress?.finish()
  }
}

// settlement 唯一路径：worker 在 terminal+active 时 await 同一 promise 再回读，等价于 lease 已释放。
async function ensureSettled(lock: ServerLock.ServerLock, taskID: string) {
  try {
    return ColdStorage.parseMaintenanceTask(
      await daemonRequest(
        lock,
        `${ServerLock.CONTROL_MAINTENANCE_STATUS_PATH}?task=${encodeURIComponent(taskID)}`,
        undefined,
        false,
      ),
    )
  } catch (error) {
    // control 不可达时 fail-closed，并带 taskID，避免在 lease 未释放时假装成功。
    const detail = error instanceof Error ? error.message : String(error)
    throw new MaintenanceUnavailableError(
      `Maintenance task ${taskID} reached a durable terminal state but control settlement failed: ${detail}`,
    )
  }
}
// options 只承载展示与已选执行域，不允许 control 失败后重新选择 offline writer。
async function executeMaintenance(
  request: ColdStorage.MaintenanceRequest,
  options: {
    human?: boolean
    output?: boolean
    lock?: ServerLock.ServerLock | null
  } = {},
) {
  const human = options.human === true
  // 传入 null 是显式 offline 选择；undefined 才允许初次探测 daemon，二者不能用 truthy 判断合并。
  let lock = options.lock === undefined ? await liveDaemon() : (options.lock ?? undefined)
  let retainedDaemon = false
  let election: Awaited<ReturnType<typeof daemonElection>> | undefined
  if (!lock && request.operation === "compress" && options.lock === undefined) {
    election = await daemonElection()
    lock = await liveDaemon()
    if (lock) {
      // recheck 发现 replacement daemon 后立即放弃 election，避免把已选择的 control owner 误留成 offline writer 的保护锁。
      await election.release()
      election = undefined
    }
  }
  if (lock && human && request.operation === "compress") {
    const existing = await ServerLock.findNonterminalMaintenanceTask()
    if (existing) throw new ServerLock.MaintenanceBusyError(`Maintenance task already exists: ${existing.taskID}`)
    if (await confirmDaemonStop(lock)) {
      UI.println(`${UI.Style.TEXT_HIGHLIGHT}●${UI.Style.TEXT_NORMAL} Stopping daemon safely...`)
      election = await daemonElection()
      const result = await stopDaemon({ expected: lock, maintenanceIdle: true }).catch(async (error) => {
        await election?.release()
        throw error
      })
      if (result.type !== "stopped" && result.type !== "stale") {
        await election.release()
        throw new MaintenanceUnavailableError(`Daemon pid=${lock.pid} did not stop`)
      }
      UI.println(`${UI.Style.TEXT_SUCCESS_BOLD}✓ Daemon stopped${UI.Style.TEXT_NORMAL}`)
      lock = undefined
    } else {
      retainedDaemon = true
      UI.println(`${UI.Style.TEXT_WARNING_BOLD}! Continuing through the running daemon.${UI.Style.TEXT_NORMAL}`)
      UI.println("  Compression is safe, but may be slower while Sessions are active.")
    }
  }
  if (lock) {
    // 已选 live daemon 后只等待它的 durable task，不重新准备 offline lease 或第二个 writer。
    const body = await daemonRequest(
      lock,
      ServerLock.CONTROL_MAINTENANCE_PATH,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
      },
      // start 只需 ACK；长任务观察改走 reconcile，不能再复用 2s 默认去盯进度。
      MAINTENANCE_START_TIMEOUT_MS,
    )
    if (human && request.operation === "compress") {
      if (!isRecord(body) || typeof body.taskID !== "string")
        throw new MaintenanceUnavailableError("Daemon returned an invalid maintenance task")
      return { result: await waitForDaemonTask(lock, body.taskID), retainedDaemon, election }
    }
    if (options.output !== false) printMaintenance(body)
    return { result: body, retainedDaemon, election }
  }
  const started = performance.now()
  const progress = human && request.operation === "compress" ? compressionProgress(started) : undefined
  const result = await runOffline(ColdStorage.prepareMaintenance(request), progress?.update)
    .catch(async (error) => {
      // offline 失败必须先释放选主锁再传播原错误，否则 reconnect daemon 会被一次失败维护永久挡住。
      await election?.release()
      throw error
    })
    .finally(() => progress?.finish())
  if (human && request.operation === "compress" && result.type === "task") {
    renderCompression(result.task, performance.now() - started)
    return { result, retainedDaemon, election }
  }
  if (options.output !== false) printMaintenance(result.type === "task" ? result.task : result)
  return { result, retainedDaemon, election }
}
// sequence 只接受真实 task envelope，防止异常 daemon 响应被当成 completed 授权。
function taskResult(value: unknown) {
  if (!isRecord(value) || value.type !== "task" || !("task" in value)) {
    throw new MaintenanceUnavailableError("Maintenance did not return a task")
  }
  return ColdStorage.parseMaintenanceTask(value.task)
}
// vacuum 的 page counts 保持原协议；pageSize 由紧邻执行前的 StatusReport 提供。
function vacuumResult(value: unknown) {
  // page counts 是 vacuum 的唯一物理结果来源，缺失或负值不能被 renderer 当作可回收空间。
  if (
    !isRecord(value) ||
    value.type !== "vacuum" ||
    typeof value.pagesBefore !== "number" ||
    typeof value.pagesAfter !== "number" ||
    !Number.isFinite(value.pagesBefore) ||
    !Number.isFinite(value.pagesAfter) ||
    value.pagesBefore < 0 ||
    value.pagesAfter < 0
  )
    throw new MaintenanceUnavailableError("Vacuum returned an invalid result")
  return value as { type: "vacuum"; pagesBefore: number; pagesAfter: number }
}
// standalone 可保留 daemon 域；combined 路径显式传 null，确保停机后只走 offline lease。
async function runVacuum(pageSize: number, human: boolean, lock: ServerLock.ServerLock | null = null) {
  const started = performance.now()
  if (human) UI.println(`${UI.Style.TEXT_HIGHLIGHT}●${UI.Style.TEXT_NORMAL} Reclaiming SQLite pages...`)
  const execution = await executeMaintenance({ operation: "vacuum", confirm: true }, { human: false, output: false, lock })
  const result = vacuumResult(execution.result)
  if (human) {
    // 页面差值描述 SQLite allocation，不宣称等于 main+WAL 的即时文件系统占用。
    const before = result.pagesBefore * pageSize
    const after = result.pagesAfter * pageSize
    UI.println(`${UI.Style.TEXT_SUCCESS_BOLD}✓ Physical reclaim completed${UI.Style.TEXT_NORMAL} in ${duration(performance.now() - started)}`)
    renderRow("Page allocation", `${size(before)} → ${size(after)}`)
    renderRow("Reclaimed pages", size(Math.max(0, before - after)))
  }
  return result
}
// sequence owner 只编排两个现有 operation，任何非 completed compression 都在 vacuum 前失败。
// flags 由同一个 CLI request 传入，避免 machine/human 分支各自解释 --yes 的含义。
async function executeCompression(
  input: { request: Extract<ColdStorage.MaintenanceRequest, { operation: "compress" }> } &
    Record<"human" | "vacuum" | "yes", boolean>,
) {
  if (input.yes && !input.vacuum) {
    throw new ColdStorage.ValidationError({ message: "compress --yes requires --vacuum" })
  }
  if (!input.human && input.vacuum && !input.yes) {
    throw new ColdStorage.ValidationError({ message: "non-interactive compress --vacuum requires --yes" })
  }
  // 三个 machine 授权同时成立时才进入 silent stop；任一缺失都不能隐式取得 reclaim 权限。
  if (!input.human && input.vacuum && input.yes) {
    // machine 组合的 --yes 同时承担 silent stop 与 reclaim 授权，所以 bare --yes 必须在上方拒绝。
    await using election = await daemonElection()
    const lock = await liveDaemon()
    if (lock) {
      const stopped = await stopDaemon({ expected: lock, maintenanceIdle: true })
      if (stopped.type !== "stopped" && stopped.type !== "stale") throw new MaintenanceUnavailableError(`Daemon pid=${lock.pid} did not stop`)
    }
    // 显式 machine 组合只打印一个最终 JSON；两个既有 operation 仍各自拥有数据库语义。
    const compressed = await executeMaintenance(input.request, { output: false, lock: null })
    const task = taskResult(compressed.result)
    const report = ColdStorage.status()
    // 低于噪声地板时不跑 SQL VACUUM，但保持 compress-vacuum 复合 shape（pageCount 自报）。
    // pagesBefore==pagesAfter 表示逻辑跳过而非 vacuum 失败，脚本仍可解析同一 type。
    if (freelistMetrics(report).reusable < RECLAIM_NOISE_BYTES) {
      const pages = report.pageCount
      printMaintenance({
        type: "compress-vacuum",
        compress: task,
        vacuum: { type: "vacuum", pagesBefore: pages, pagesAfter: pages },
      })
      return
    }
    const vacuum = await runVacuum(report.pageSize, false)
    printMaintenance({ type: "compress-vacuum", compress: task, vacuum })
    return
  }
  // 普通 machine 与 interactive 共享一次 domain selection，只有 interactive 分支继续做 reclaim 决策。
  const execution = await executeMaintenance(input.request, { human: input.human })
  try {
    if (!input.human) return
    taskResult(execution.result)
    if (execution.retainedDaemon) {
      // 首次 N 已拒绝 daemon shutdown；本次调用不得再显示 reclaim prompt 或执行 vacuum。
      UI.println(`${UI.Style.TEXT_DIM}○ Physical reclaim skipped while daemon remains running.${UI.Style.TEXT_NORMAL}`)
      UI.println("  Stop the daemon and run: opencode db vacuum --yes")
      return
    }
    const report = ColdStorage.status()
    const { reusable } = freelistMetrics(report)
    // completed task 只证明 logical compression；PROMPT 门槛过滤几 KB～小 freelist 噪声。
    if (!reclaimPrompt(report)) return
    UI.println(`${UI.Style.TEXT_WARNING_BOLD}! Logical compression is complete.${UI.Style.TEXT_NORMAL}`)
    UI.println(`  SQLite still contains ${size(reusable)} of reusable pages.`)
    // reclaim prompt 是独立物理授权，不能继承普通 compression 的默认许可。
    if (!input.yes && !(await confirm(`${UI.Style.TEXT_WARNING_BOLD}? Reclaim ${size(reusable)} of physical database space now? [Y/n] ${UI.Style.TEXT_NORMAL}`))) {
      UI.println(`${UI.Style.TEXT_DIM}  Physical reclaim skipped. Run: opencode db vacuum --yes${UI.Style.TEXT_NORMAL}`)
      return
    }
    await runVacuum(report.pageSize, true)
  } finally {
    await execution.election?.release()
  }
}

// resume 从持久 record 恢复 operation/args/cursor，用户不能借同一 taskID 改写 scope 或 batchSize。
// live daemon 负责 active lifecycle；offline 域则获取同一文件 lease并同步执行到 terminal checkpoint。
// queued/completed/failed/running 都拒绝显式 resume，只有 reconcile 后的 interrupted 是合法来源。
async function executeResume(taskID: string) {
  const lock = await liveDaemon()
  if (lock) {
    printMaintenance(await daemonRequest(lock, ServerLock.CONTROL_MAINTENANCE_RESUME_PATH, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ taskID }) }))
    return
  }
  const task = await ServerLock.reconcileMaintenanceTask(taskID)
  if (!task) throw new ColdStorage.ValidationError({ message: `Maintenance task not found: ${taskID}` })
  if (task.status !== "interrupted")
    throw new ColdStorage.ValidationError({ message: `Maintenance task is ${task.status}` })
  const prepared = ColdStorage.prepareMaintenance(task.args)
  if (prepared.type !== "task") throw new ColdStorage.ValidationError({ message: "Task is not resumable" })
  const lease = await ServerLock.acquireMaintenanceLease(task)
  try {
    const result = await ColdStorage.maintain(prepared, { task, lease, checkpoint: (next) => ServerLock.writeMaintenanceTask(next) })
    printMaintenance(result.type === "task" ? result.task : result)
  } finally {
    await lease.release()
  }
}

// compress：completed compact head OR root idle（--older-than，默认 7d，session.time_updated）OR subagent idle（固定 24h last message）。
// --older-than 只调 root 阈值；subagent 24h 由 ColdStorage 常量固定，不在 CLI 复制第二套规则。
// batch 默认值来自本机 2.2 GB 实测，daemon JSON 缺省也使用同一常量。
const CompressCommand = cmd({
  command: "compress",
  describe: "freeze eligible cold fields into the database cold store",
  builder: (yargs: Argv) =>
    yargs
      .option("session", { type: "string" })
      .option("older-than", { type: "string", default: "7d" })
      .option("batch-size", { type: "number", default: ColdStorage.DEFAULT_BATCH_SIZE })
      .option("vacuum", { type: "boolean", default: false })
      .option("yes", { type: "boolean", default: false })
      .option("json", { type: "boolean", default: false }),
  handler: async (args) => {
    // handler 只把 yargs 的已解析值转换为 ColdStorage request，不在边界复制 eligibility 或 cursor 逻辑。
    await executeCompression({
      request: {
        operation: "compress",
        ...(args.session ? { sessionID: SessionID.make(args.session) } : {}),
        olderThanMs: durationMs(args.olderThan),
        batchSize: args.batchSize,
      },
      human: interactive(args.json),
      vacuum: args.vacuum,
      yes: args.yes,
    })
  },
})

// expand 反向回填完整热 JSON；全库操作必须同时给 --all 和 --yes，session scope 不需要全库确认。
// --all 与 --session 可以并存，但 session 仍限定范围，实际 normalization 由 ColdStorage owner 完成。
const ExpandCommand = cmd({
  command: "expand",
  describe: "thaw cold fields back into the primary tables",
  builder: (yargs: Argv) => yargs.option("session", { type: "string" }).option("all", { type: "boolean", default: false }).option("yes", { type: "boolean", default: false }).option("batch-size", { type: "number", default: ColdStorage.DEFAULT_BATCH_SIZE }),
  handler: async (args: { session?: string; all: boolean; yes: boolean; batchSize: number }) => {
    if (!args.all && !args.session)
      throw new ColdStorage.ValidationError({ message: "expand requires --all or --session" })
    if (args.all && !args.yes) throw new ColdStorage.ValidationError({ message: "expand --all requires --yes" })
    await executeMaintenance({ operation: "expand", ...(args.session ? { sessionID: SessionID.make(args.session) } : {}), all: args.all, batchSize: args.batchSize })
  },
})

// status 无 task 时返回 DB metrics，带 task 时只查询持久 control record；两种语义不混入 daemon health。
// offline task 查询先 reconcile dead owner，使强制终止后的 running record 可立即显示 interrupted。
const StatusCommand = cmd({
  command: "status",
  describe: "show cold-storage metrics or a persisted task",
  builder: (yargs: Argv) =>
    yargs.option("task", { type: "string" }).option("json", { type: "boolean", default: false }),
  handler: async (args: { task?: string; json: boolean }) => {
    const lock = await liveDaemon()
    if (args.task) {
      if (lock) {
        const result = await daemonRequest(lock, `${ServerLock.CONTROL_MAINTENANCE_STATUS_PATH}?task=${encodeURIComponent(args.task)}`)
        if (interactive(args.json)) renderTask(ColdStorage.parseMaintenanceTask(result))
        else printMaintenance(result)
        return
      }
      const task = await ServerLock.reconcileMaintenanceTask(args.task)
      if (!task) throw new ColdStorage.ValidationError({ message: `Maintenance task not found: ${args.task}` })
      if (interactive(args.json)) renderTask(task)
      else printMaintenance(task)
      return
    }
    if (lock) {
      // status 没有持久 task 结果可轮询，必须在同一 control 请求中等到完整 StatusReport。
      const result = await daemonRequest(lock, ServerLock.CONTROL_MAINTENANCE_PATH, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ operation: "status" }) }, false)
      if (interactive(args.json)) renderStatus(parseStatus(result))
      else printMaintenance(result)
      return
    }
    const report = ColdStorage.status()
    if (interactive(args.json)) renderStatus(report)
    else printMaintenance(report)
  },
})

// resume 是独立命令而非 compress/expand flag，避免新参数覆盖持久 task 的原始请求。
const ResumeCommand = cmd({
  command: "resume <taskID>",
  describe: "resume an interrupted cold-storage task",
  builder: (yargs: Argv) => yargs.positional("taskID", { type: "string", demandOption: true }),
  handler: async (args: { taskID: string }) => {
    await executeResume(args.taskID)
  },
})

// verify 默认只读完整性报告；--repair 才生成可恢复 task，并且只修正可证明的 ref_count。
// --repair-tool-input 独立授权热 Tool 行的 input 形状修复，同样进入 task-backed 写事务。
const VerifyCommand = cmd({
  command: "verify",
  describe: "verify cold payload hashes and reference counts",
  builder: (yargs: Argv) =>
    yargs
      .option("repair", { type: "boolean", default: false })
      .option("repair-tool-input", { type: "boolean", default: false })
      .option("batch-size", { type: "number", default: ColdStorage.DEFAULT_BATCH_SIZE }),
  handler: async (args: { repair: boolean; repairToolInput: boolean; batchSize: number }) => {
    await executeMaintenance({
      operation: "verify",
      repair: args.repair,
      repairToolInput: args.repairToolInput,
      batchSize: args.batchSize,
    })
  },
})

// cleanup 默认等价 dry-run，只有 --yes 且未显式 --dry-run 才授予 payload 删除权限。
// cleanup 不调用 VACUUM，用户可先核对 logical bytes，再单独决定物理页面回收。
const CleanupCommand = cmd({
  command: "cleanup",
  describe: "report or remove unreferenced cold payloads",
  builder: (yargs: Argv) => yargs.option("dry-run", { type: "boolean", default: false }).option("yes", { type: "boolean", default: false }).option("batch-size", { type: "number", default: ColdStorage.DEFAULT_BATCH_SIZE }),
  handler: async (args: { dryRun: boolean; yes: boolean; batchSize: number }) => {
    await executeMaintenance({ operation: "cleanup", delete: args.yes && !args.dryRun, batchSize: args.batchSize })
  },
})

// vacuum 是不可 resume 的 SQLite 原子操作，必须显式 --yes 并持有 maintenance lease。
// pages before/after 是唯一物理文件收益口径，不与 cold payload compressedBytes 混用。
const VacuumCommand = cmd({
  command: "vacuum",
  describe: "reclaim unused SQLite pages",
  builder: (yargs: Argv) =>
    yargs.option("yes", { type: "boolean", default: false }).option("json", { type: "boolean", default: false }),
  handler: async (args: { yes: boolean; json: boolean }) => {
    if (!args.yes) throw new ColdStorage.ValidationError({ message: "vacuum requires --yes" })
    if (!interactive(args.json)) {
      await executeMaintenance({ operation: "vacuum", confirm: true })
      return
    }
    const lock = await liveDaemon()
    const report = lock
      ? parseStatus(await daemonRequest(lock, ServerLock.CONTROL_MAINTENANCE_PATH, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ operation: "status" }) }, false))
      : ColdStorage.status()
    // human freelist=0 不跑 VACUUM；machine 路径仍走上方 executeMaintenance。
    if (freelistMetrics(report).reusable === 0) {
      UI.println(`${UI.Style.TEXT_DIM}○ No reusable pages to reclaim.${UI.Style.TEXT_NORMAL}`)
      return
    }
    // standalone vacuum 复用当前所选执行域；仅 human renderer 改变，daemon/storage ownership 不迁移。
    await runVacuum(report.pageSize, true, lock ?? null)
  },
})

const QueryCommand = cmd({
  command: "$0 [query]",
  describe: "open an interactive sqlite3 shell or run a query",
  builder: (yargs: Argv) => {
    return yargs
      .positional("query", {
        type: "string",
        describe: "SQL query to execute",
      })
      .option("format", {
        type: "string",
        choices: ["json", "tsv"],
        default: "tsv",
        describe: "Output format",
      })
  },
  handler: async (args: { query?: string; format: string }) => {
    const query = args.query as string | undefined
    if (query) {
      const db = new BunDatabase(Database.getPath(), { readonly: true })
      try {
        const result = db.query(query).all() as Record<string, unknown>[]
        if (args.format === "json") {
          console.log(JSON.stringify(result, null, 2))
        } else if (result.length > 0) {
          const keys = Object.keys(result[0])
          console.log(keys.join("\t"))
          for (const row of result) {
            console.log(keys.map((k) => row[k]).join("\t"))
          }
        }
      } catch (err) {
        UI.error(errorMessage(err))
        process.exit(1)
      }
      db.close()
      return
    }
    const child = spawn("sqlite3", [Database.getPath()], {
      stdio: "inherit",
    })
    await new Promise((resolve) => child.on("close", resolve))
  },
})

const PathCommand = cmd({
  command: "path",
  describe: "print the database path",
  handler: () => {
    console.log(Database.getPath())
  },
})

const MigrateCommand = cmd({
  command: "migrate",
  describe: "migrate JSON data to SQLite (merges with existing data)",
  handler: async () => {
    const sqlite = new BunDatabase(Database.getPath())
    const tty = process.stderr.isTTY
    const width = 36
    const orange = "\x1b[38;5;214m"
    const muted = "\x1b[0;2m"
    const reset = "\x1b[0m"
    let last = -1
    if (tty) process.stderr.write("\x1b[?25l")
    try {
      const stats = await JsonMigration.run(drizzle({ client: sqlite }), {
        progress: (event) => {
          const percent = Math.floor((event.current / event.total) * 100)
          if (percent === last) return
          last = percent
          if (tty) {
            const fill = Math.round((percent / 100) * width)
            const bar = `${"■".repeat(fill)}${"･".repeat(width - fill)}`
            process.stderr.write(
              `\r${orange}${bar} ${percent.toString().padStart(3)}%${reset} ${muted}${event.current}/${event.total}${reset} `,
            )
          } else {
            process.stderr.write(`sqlite-migration:${percent}${EOL}`)
          }
        },
      })
      if (tty) process.stderr.write("\n")
      if (tty) process.stderr.write("\x1b[?25h")
      else process.stderr.write(`sqlite-migration:done${EOL}`)
      UI.println(
        `Migration complete: ${stats.projects} projects, ${stats.sessions} sessions, ${stats.messages} messages`,
      )
      if (stats.errors.length > 0) {
        UI.println(`${stats.errors.length} errors occurred during migration`)
      }
    } catch (err) {
      if (tty) process.stderr.write("\x1b[?25h")
      UI.error(`Migration failed: ${errorMessage(err)}`)
      process.exit(1)
    } finally {
      sqlite.close()
    }
  },
})

export const DbCommand = cmd({
  command: "db",
  describe: "database tools",
  builder: (yargs: Argv) => {
    return yargs
      .command(CompressCommand)
      .command(ExpandCommand)
      .command(StatusCommand)
      .command(ResumeCommand)
      .command(VerifyCommand)
      .command(CleanupCommand)
      .command(VacuumCommand)
      .command(QueryCommand)
      .command(PathCommand)
      .command(MigrateCommand)
      .demandCommand()
  },
  handler: () => {},
})
