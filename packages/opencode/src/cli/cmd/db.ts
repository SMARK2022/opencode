import type { Argv } from "yargs"
import { spawn } from "child_process"
import { EOL } from "os"
import { Database } from "@opencode-ai/core/database/database"
import { Effect } from "effect"
import { sql } from "drizzle-orm"
import { effectCmd } from "../effect-cmd"
import path from "path"
// #493：ColdStorage 运行时位于 core——CLI 只渲染 task/report JSON，不复制状态机。
import { ColdStorage } from "@opencode-ai/core/storage/cold-storage"
import { ColdMaintain } from "@opencode-ai/core/storage/cold-maintain"
import { ServerLock } from "../tui/server-lock"
import { SessionID } from "@/session/schema"
// #535：安全停机/选主锁/交互确认与人类渲染进入 db 维护域
import { stopDaemon } from "./daemon"
import { createInterface } from "readline"
import { Flock } from "@opencode-ai/core/util/flock"
import { Global } from "@opencode-ai/core/global"
import { UI } from "../ui"
import { MaintenanceExecutor } from "../maintenance"


class MaintenanceUnavailableError extends Error {}

// duration parser 只接受带单位的完整字符串，裸数字不能被不同调用层解释成秒或毫秒。
// 结果统一为毫秒后进入 ColdStorage request，resume 则始终复用持久化后的数值。
function durationMs(value: string) {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d|w)$/.exec(value.trim().toLowerCase())
  if (!match) throw new ColdStorage.ValidationError({ message: `Invalid duration: ${value}` })
  const amount = Number(match[1])
  // 显式 switch 保持单位集合可穷尽，避免索引任意字符串绕过类型和范围验证。
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
  const lockPath = ServerLock.placement()
  const lock = await ServerLock.read(lockPath)
  if (!lock) return
  // 按宿主路径语义比较同一数据库，Windows大小写差异不能把活跃owner误判为offline。
  if (path.relative(lock.dbPath, Database.path()) !== "") return
  if (!ServerLock.alive(lock.pid)) {
    await ServerLock.clearIfOwner(lock.token, lockPath)
    return
  }
  if (!lock.controlPort) throw new MaintenanceUnavailableError("Live daemon does not expose a maintenance control port")
  return lock
}

// control request 总是携带当前 lock token，并用短 timeout 把本机 daemon 不可达明确反馈给 CLI。
// 非 2xx 响应保留 daemon 错误语义，调用方不得在失败后改走 offline 并伪造成功。
// status 报告显式取消短 deadline；其他 immediate 操作不因此自动获得相同豁免。
async function daemonRequest(lock: ServerLock.ServerLock, pathname: string, init?: RequestInit, timeoutMs: number | false = 2_000) {
  const response = await fetch(`http://127.0.0.1:${lock.controlPort}${pathname}`, {
    ...init,
    headers: {
      [ServerLock.CONTROL_TOKEN_HEADER]: lock.token,
      ...(init?.headers ?? {}),
    },
    signal: timeoutMs === false ? undefined : AbortSignal.timeout(timeoutMs),
  })
  const body: unknown = await response.json().catch(() => ({ error: `daemon returned ${response.status}` }))
  if (!response.ok) {
    // #524：无 deadline 只影响等待上限；错误分类与 offline 回退禁止仍由调用方执行域决定。
    const error = isRecord(body) && typeof body.error === "string" ? body.error : `daemon returned ${response.status}`
    throw new MaintenanceUnavailableError(error)
  }
  return body
}

function printMaintenance(value: unknown) {
  // #535：machine serializer 永远一次写完整 value，进度与 prompt 必须在 mode gate 之外停止。
  // UI.println 写 stderr——stdout 保持单值协议，脚本调用方无需从人类输出里猜 JSON 边界。
  UI.println(JSON.stringify(value, null, 2))
}

// #535：mode 在任何 prompt/ANSI 前一次决定，避免同一命令中途从 machine 输出切换成人类输出。
function interactive(json: boolean) {
  // 人类输出同时要求可见终端和可读输入；重定向/脚本不得进入 ANSI 或 prompt 分支。
  return !json && Boolean(process.stdin.isTTY && process.stderr.isTTY)
}

// #535：DB 展示统一使用十进制单位，与既有 maintenance JSON 的原始 byte 计数保持可核对关系。
function size(value: number) {
  const units = ["B", "KB", "MB", "GB", "TB"]
  if (value === 0) return "0 B"
  // 1000 进制与既有 StatusReport 的 byte 语义一致；1024 进制会让渲染层与 JSON 层出现换算漂移。
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1000)), units.length - 1)
  // B 档不保留小数，避免把 512 B 显示成 512.0 B 的噪声。
  return `${(value / 1000 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`
}

// #549：freelist 展示门控用页分配作分母；与 cold rawBytes 无关，避免把逻辑压缩率误当成可 VACUUM 份额。
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
// #549：online 观察帧时钟约 10fps；rate 只在 durable counter 变化时重算，避免每帧把吞吐刷成 0。
const PROGRESS_FRAME_MS = 100
// 350ms 仅控制视觉追赶速度，与 durable checkpoint 和 100ms 采样时钟无关。
const PROGRESS_SMOOTHING_MS = 350
const MAINTENANCE_START_TIMEOUT_MS = 10_000

function freelistMetrics(report: Pick<ColdStorage.StatusReport, "freelistPages" | "pageSize" | "pageCount">) {
  const reusable = report.freelistPages * report.pageSize
  // total 固定为 page allocation；禁止用 rawBytes 当占比分母。
  const total = report.pageCount * report.pageSize
  const ratio = total > 0 ? reusable / total : 0
  return { reusable, total, ratio }
}

// #549：HINT 只服务 status Recommendation，不得单独触发写库。
function reclaimHint(report: Pick<ColdStorage.StatusReport, "freelistPages" | "pageSize" | "pageCount">) {
  const metrics = freelistMetrics(report)
  return metrics.reusable >= RECLAIM_LARGE_BYTES || (metrics.reusable >= RECLAIM_HINT_BYTES && metrics.ratio >= RECLAIM_HINT_RATIO)
}

// #549：PROMPT 才授权交互 reclaim；retainedDaemon 路径另有跳过逻辑。
function reclaimPrompt(report: Pick<ColdStorage.StatusReport, "freelistPages" | "pageSize" | "pageCount">) {
  const metrics = freelistMetrics(report)
  return metrics.reusable >= RECLAIM_LARGE_BYTES || (metrics.reusable >= RECLAIM_PROMPT_BYTES && metrics.ratio >= RECLAIM_PROMPT_RATIO)
}

// #535：固定 label 宽度只影响 scrollback 可读性，不参与字段选择或数值计算。
function renderRow(label: string, value: string | number) {
  UI.println(`  ${UI.Style.TEXT_DIM}${label.padEnd(17)}${UI.Style.TEXT_NORMAL}${value}`)
}

// #535：daemon status 是本机鉴权 envelope；offline status 已是同一 StatusReport，本层只消除包裹差异。
function parseStatus(value: unknown): ColdStorage.StatusReport {
  const report = isRecord(value) && value.type === "status" ? value.report : value
  if (!isRecord(report)) throw new MaintenanceUnavailableError("Invalid database status report")
  // 运行时只验证 envelope 形状；字段级校验属于 ColdStorage schema，渲染层不复制第二套契约。
  return report as ColdStorage.StatusReport
}

// #535：聚合 renderer 不读取 payload，因此 status 不会因冷数据统计而触发 hydration。
function renderStatus(report: ColdStorage.StatusReport) {
  // reusable 只来自 freelist pages；它是建议 vacuum 的依据，不代表 cold payload 可再压缩量。
  const reusable = report.freelistPages * report.pageSize
  // saved 是逻辑差值；payload 去重后的实际节省只能由压缩后的 compressedBytes 反映。
  const saved = Math.max(0, report.rawBytes - report.compressedBytes)
  // rawBytes=0 的空库不能除零；ratio 退化为 0 而不是 NaN。
  const ratio = report.rawBytes === 0 ? 0 : (saved / report.rawBytes) * 100
  UI.println(`${UI.Style.TEXT_HIGHLIGHT_BOLD}OpenCode database${UI.Style.TEXT_NORMAL}`)
  renderRow("Path", Database.path())
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
  // #549：Recommendation 只在 freelist 达到 HINT 时出现，避免几 KB 噪声打扰。
  if (!reclaimHint(report)) return
  UI.empty()
  UI.println(`${UI.Style.TEXT_WARNING_BOLD}Recommendation${UI.Style.TEXT_NORMAL}`)
  // 建议文案指向显式 --yes 命令，不暗示本命令可以隐式触发物理回收。
  UI.println(`  Run ${UI.Style.TEXT_INFO_BOLD}opencode db vacuum --yes${UI.Style.TEXT_NORMAL} to reclaim approximately ${size(reusable)}.`)
}

// #535：完成耗时使用人类单位；它与活动行的 elapsed 共享同一单调时钟起点。
function duration(value: number) {
  // 60s 以内保留 0.1s 精度；更长窗口的 0.1s 精度对人类没有观察价值。
  return value < 60_000 ? `${(value / 1_000).toFixed(1)}s` : `${Math.floor(value / 60_000)}m ${(Math.floor(value / 1_000) % 60).toString().padStart(2, "0")}s`
}

// #535：相对时间避免在紧凑状态中暴露冗长 ISO 字符串，同时不改变持久 updatedAt。
function relativeTime(timestamp: number) {
  // 时钟回拨或未来时间戳时铉位到 0，不显示负的 "ago"。
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1_000))
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  return minutes < 60 ? `${minutes}m ago` : minutes < 1_440 ? `${Math.floor(minutes / 60)}h ago` : `${Math.floor(minutes / 1_440)}d ago`
}

// #535：task view 只投影 durable record，repair/delete 语义从 args 而非 operation 名称猜测。
function renderTask(task: ColdMaintain.MaintenanceTask) {
  // 颜色和符号只增强状态辨识，文本 status 始终保留，重定向去色后仍不丢语义。
  const color =
    task.status === "completed"
      ? UI.Style.TEXT_SUCCESS_BOLD
      : task.status === "failed"
        ? UI.Style.TEXT_DANGER_BOLD
        : task.status === "interrupted"
          ? UI.Style.TEXT_WARNING_BOLD
          : UI.Style.TEXT_HIGHLIGHT_BOLD
  const symbol = task.status === "completed" ? "✓" : task.status === "failed" ? "×" : task.status === "interrupted" ? "!" : "●"
  const detail =
    // #568：tool-input 修复也是写事务，task view 必须与 refcount repair 同样显式标记。
    task.args.operation === "verify" && (task.args.repair || task.args.repairToolInput === true)
      ? "verify (repair)"
      : task.args.operation === "cleanup" && task.args.delete
        ? "cleanup (delete)"
        : task.operation
  // interrupted 的标题替换为独立文案，避免把可恢复中断误读成一次完成的任务实例。
  UI.println(task.status === "interrupted" ? `${color}! Maintenance interrupted${UI.Style.TEXT_NORMAL}` : `${color}${symbol} OpenCode database maintenance task${UI.Style.TEXT_NORMAL}`)
  renderRow("Task", task.taskID)
  // detail 必须来自 args 的显式布尔；从 operation 名推断会把 dry-run 伪装成写操作。
  renderRow("Operation", detail)
  renderRow("Status", task.status)
  renderRow("Processed", `${task.processed.toLocaleString()} owners`)
  renderRow("Skipped", `${task.skipped.toLocaleString()} owners`)
  // 空 payload 的 status/verify 任务不打印 Payload 行，避免 0 B → 0 B 的无信息行。
  if (task.rawBytes > 0 || task.compressedBytes > 0)
    renderRow("Payload", `${size(task.rawBytes)} → ${size(task.compressedBytes)}`)
  renderRow("Updated", relativeTime(task.updatedAt))
  if (task.status === "failed" && task.error) UI.println(`  ${UI.Style.TEXT_DANGER}${task.error}${UI.Style.TEXT_NORMAL}`)
  if (task.status !== "interrupted") return
  // interrupted task 的 cursor 只能由既有 resume 接口继续；重新 compress 会被 nonterminal 检查拒绝。
  UI.println(`  Resume with: ${UI.Style.TEXT_INFO_BOLD}opencode db resume ${task.taskID}${UI.Style.TEXT_NORMAL}`)
}

// #535：观察器只在 human compress 创建；因此这里统一发布一次开始行，避免 online/offline 两条输出路径漂移。
function renderCompressionStart() {
  UI.println(`${UI.Style.TEXT_HIGHLIGHT_BOLD}OpenCode database maintenance${UI.Style.TEXT_NORMAL}`)
  renderRow("Path", Database.path())
  UI.empty()
  UI.println(`${UI.Style.TEXT_HIGHLIGHT}●${UI.Style.TEXT_NORMAL} Compressing cold data`)
}

// #549：帧时钟驱动 pulse——online 硬 ~10fps 与 durable counter 解耦；rate 只取变化的 durable 快照。
function compressionProgress(startedAt: number) {
  let visible = false
  let latest: ColdMaintain.MaintenanceTask | undefined
  let rateBytes = 0
  let previous: { at: number; bytes: number } | undefined
  let phase: { stage: string; at: number; done: number } | undefined
  let displayRatio = 0
  let paintedAt = startedAt
  renderCompressionStart()
  const paint = () => {
    if (!latest) return
    visible = true
    const now = performance.now()
    const elapsed = Math.max(1, now - startedAt)
    const owners = latest.processed.toLocaleString("en-US").padStart(12)
    // 原始字节差值表示完整维护路径的吞吐，不是磁盘带宽。
    const rateText = `${size(rateBytes)}/s`.padStart(12)
    const elapsedText = duration(elapsed).padStart(8)
    // 有总量估算时显示真实百分比与 ETA；老旧任务记录没有 progress 字段，回退脉冲动画。
    const progress = latest.progress
    // running 的零总量继续 pulse；completed 即使零候选也必须能由 finish 补齐 100%。
    if (progress && (progress.total > 0 || latest.status === "completed")) {
      const actual = progress.total > 0 ? Math.min(1, progress.done / progress.total) : 0
      // 视觉值最多比 durable 进度前瞻 5 个百分点，非 completed 永远不满 100%。
      const target = latest.status === "completed" ? 1 : Math.min(0.99, actual + 0.05)
      const remaining = target - displayRatio
      // 长同步帧也只推进一个视觉帧步长，避免恢复绘制时按数秒墙钟一次追满。
      const step = 1 - Math.exp(-Math.min(PROGRESS_FRAME_MS, now - paintedAt) / PROGRESS_SMOOTHING_MS)
      displayRatio = remaining < 0.0005 ? target : displayRatio + remaining * step
      paintedAt = now
      const filled = Math.round(displayRatio * 20)
      const bar = `${"█".repeat(filled)}${"·".repeat(20 - filled)}`
      const percent = `${(displayRatio * 100).toFixed(1)}%`.padStart(6)
      // 阶段切换和恢复有不同的计数起点，ETA 只使用本观察阶段实际完成的增量。
      const advanced = phase ? progress.done - phase.done : 0
      // 尚无完成增量时只显示elapsed，避免把第一帧停顿解释成零剩余时间。
      const eta =
        phase && advanced > 0
          ? `  ETA ~${duration(((now - phase.at) * Math.max(0, progress.total - progress.done)) / advanced)}`
          : ""
      const stage = progress.stage === "payload" ? "Compressing payloads" : "Scanning cold data"
      // 定宽字段 + EL，防止 rate/耗时变短后留下上一帧残影。
      process.stderr.write(
        `\r  ${stage} ${UI.Style.TEXT_HIGHLIGHT}[${bar}]${UI.Style.TEXT_NORMAL} ${percent}  ${rateText}  elapsed ${elapsedText}${eta}\x1b[K`,
      )
      return
    }
    // 脉冲按墙钟滑动；轨道固定 20 格，不定百分比。
    const offset = Math.floor(elapsed / PROGRESS_FRAME_MS) % 15
    const pulse = `${"·".repeat(offset)}${"█".repeat(6)}${"·".repeat(14 - offset)}`
    process.stderr.write(
      `\r  ${UI.Style.TEXT_HIGHLIGHT}[${pulse}]${UI.Style.TEXT_NORMAL}  ${owners} owners  ${rateText}  elapsed ${elapsedText}\x1b[K`,
    )
  }
  // 刷新与任务采样解耦；同步SQLite阶段结束后，事件循环继续绘制最新快照。
  const timer = setInterval(paint, PROGRESS_FRAME_MS)
  return {
    update(task: ColdMaintain.MaintenanceTask) {
      const now = performance.now()
      if (task.progress && phase?.stage !== task.progress.stage) {
        phase = { stage: task.progress.stage, at: now, done: task.progress.done }
        // owners 与 packs 分母不同；满量 running 首帧也受非终态上限约束，不能先 100% 再回退。
        const actual = task.progress.total > 0 ? Math.min(1, task.progress.done / task.progress.total) : 0
        displayRatio = Math.min(actual, task.status === "completed" ? 1 : 0.99)
        paintedAt = now
      }
      // rate 只在 rawBytes 变化的 durable 快照之间计算，避免每帧把吞吐刷成 0。
      if (!previous || task.rawBytes !== previous.bytes) {
        rateBytes = previous
          ? Math.round(Math.max(0, task.rawBytes - previous.bytes) / (Math.max(1, now - previous.at) / 1_000))
          : 0
        previous = { at: now, bytes: task.rawBytes }
      }
      latest = task
      // completed 只登记快照并停止定时器，最终 100% 由 finish 独占绘制。
      if (task.status === "completed") {
        clearInterval(timer)
        return
      }
      paint()
    },
    finish() {
      // 只有画过至少一帧才补换行，纯 machine 或空任务路径不污染 stderr。
      clearInterval(timer)
      if (latest?.status === "completed") {
        displayRatio = 1
        paint()
      }
      if (visible) process.stderr.write(EOL)
      visible = false
      // 已排队的paint也会看见空快照，收尾后不再覆盖汇总行。
      latest = undefined
    },
  }
}

// #535：completed 汇总严格使用 task counters；packed 不能把 skipped/failed 误算为压缩成功。
function renderCompression(task: ColdMaintain.MaintenanceTask, elapsed: number) {
  // packed = processed - skipped - failed；skipped 不是压缩成功，不能计入 Compressed 行。
  const packed = Math.max(0, task.processed - task.skipped - task.failed)
  const saved = Math.max(0, task.rawBytes - task.compressedBytes)
  const ratio = task.rawBytes === 0 ? 0 : (saved / task.rawBytes) * 100
  UI.println(`${UI.Style.TEXT_SUCCESS_BOLD}✓ Compression completed${UI.Style.TEXT_NORMAL} in ${duration(elapsed)}`)
  UI.empty()
  // Failed 单独成行：全 skipped 的任务是合法完成，不能把 0 失败隐藏进 Compressed。
  renderRow("Processed", `${task.processed.toLocaleString()} owners`)
  renderRow("Compressed", `${packed.toLocaleString()} owners`)
  renderRow("Skipped", `${task.skipped.toLocaleString()} owners`)
  renderRow("Failed", task.failed.toLocaleString())
  renderRow("Payload", `${size(task.rawBytes)} → ${size(task.compressedBytes)}`)
  renderRow("Logical saved", `${size(saved)} (${ratio.toFixed(1)}%)`)
}

// #535：首次 Y/n 只决定执行域；回答 N 不会被后续 reclaim prompt 重新解释为关闭许可。
async function confirm(question: string) {
  const prompt = createInterface({ input: process.stdin, output: process.stderr })
  const answer = (await new Promise<string>((resolve) => prompt.question(question, resolve))).toLowerCase()
  prompt.close()
  // 空回车与其它非否定输入都是同意；只有显式 n/no 才拒绝，与 CLI 交互惯例一致。
  return answer !== "n" && answer !== "no"
}

async function confirmDaemonStop(lock: ServerLock.ServerLock) {
  UI.println(`${UI.Style.TEXT_WARNING_BOLD}! OpenCode daemon is running (pid ${lock.pid}).${UI.Style.TEXT_NORMAL}`)
  UI.println("  Stopping it first is recommended for faster maintenance and reliable reclaim.")
  // readline 的 output 必须与 DB CLI 的 stderr 一致；跨 stdout 重绘会在真实 PTY 中抹掉先写出的 prompt。
  return confirm(`${UI.Style.TEXT_WARNING_BOLD}? Stop daemon and continue? [Y/n] ${UI.Style.TEXT_NORMAL}`)
}

// #535：与 TUI reconnect 共用选主锁；从 expected-owner stop 到 offline 序列结束都禁止 replacement daemon 发布。
function daemonElection() {
  // 75s 超时覆盖最长 offline 压缩序列的启动等待；5s stale 阈值与 TUI reconnect 的接管判定一致。
  return Flock.acquire(`opencode.server:${ServerLock.placement()}`, { dir: path.join(Global.Path.state, "locks"), timeoutMs: 75_000, staleMs: 5_000 })
}

// #549：online 观察以 reconcile 为进度真源；终态后必须 control settlement，避免 terminal→release 窗口误 busy。
async function waitForDaemonTask(lock: ServerLock.ServerLock, taskID: string, renderProgress = true) {
  const started = performance.now()
  const progress = renderProgress ? compressionProgress(started) : undefined
  try {
    // 非终态禁止依赖 control GET：大库 batch 会堵死 worker HTTP，2s ACK 超时会误杀观察器。
    while (true) {
      // reconcile 含 dead-owner 降级；禁止只读 raw JSON 导致 owner 死后无限脉冲。
      const task = await ServerLock.reconcileMaintenanceTask(taskID)
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
      progress?.update(settled)
      progress?.finish()
      if (settled.status === "completed") {
        if (progress) renderCompression(settled, performance.now() - started)
        return { type: "task" as const, task: settled }
      }
      // interrupted 先渲染可恢复视图再抛错；CLI 退出码非零但用户能看到 resume 命令。
      if (settled.status === "interrupted") renderTask(settled)
      throw new MaintenanceUnavailableError(settled.error ?? `Maintenance task ${settled.taskID} is ${settled.status}`)
    }
  } finally {
    progress?.finish()
  }
}

// #549：settlement 唯一路径——worker 在 terminal+active 时 await 同一 promise 再回读，等价于 lease 已释放。
async function ensureSettled(lock: ServerLock.ServerLock, taskID: string) {
  try {
    return ColdMaintain.parseMaintenanceTask(
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

// #535：sequence 只接受真实 task envelope，防止异常 daemon 响应被当成 completed 授权。
function taskResult(value: unknown) {
  if (!isRecord(value) || value.type !== "task" || !("task" in value)) {
    throw new MaintenanceUnavailableError("Maintenance did not return a task")
  }
  return ColdMaintain.parseMaintenanceTask(value.task)
}

// #535：vacuum 的 page counts 保持原协议；pageSize 由紧邻执行前的 StatusReport 提供。
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

// #535：standalone 可保留 daemon 域；combined 路径显式传 null，确保停机后只走 offline lease。
async function runVacuum(db: Database.Interface, pageSize: number, human: boolean, lock: ServerLock.ServerLock | null = null) {
  const started = performance.now()
  if (human) UI.println(`${UI.Style.TEXT_HIGHLIGHT}●${UI.Style.TEXT_NORMAL} Reclaiming SQLite pages...`)
  // 内层固定 machine：vacuum 结果只由外层渲染一次，避免 JSON 与人类行交错。
  const execution = await executeMaintenance(db, { operation: "vacuum", confirm: true }, { human: false, output: false, lock })
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

const runOffline = MaintenanceExecutor.runOffline

// 执行域只在命令开始时选择一次：live daemon 只走 control，daemon 缺席才走同一 maintain 的 offline 入口。
// 两个域都先调用 prepareMaintenance，保证默认值、写授权、task 分类和错误类型完全一致。
// #524：status 的 deadline 豁免只在 CLI 侧；task 类 control 仍走 2s acknowledgement 合同。
// #535：options 只承载展示与已选执行域，不允许 control 失败后重新选择 offline writer。
async function executeMaintenance(
  db: Database.Interface,
  request: ColdMaintain.MaintenanceRequest,
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
  // 选主锁只保护 offline 压缩：immediate 操作无跨进程序列，不需要阻止 reconnect daemon 发布。
  if (!lock && request.operation === "compress" && options.lock === undefined) {
    election = await daemonElection()
    lock = await liveDaemon()
    if (lock) {
      // recheck 发现 replacement daemon 后立即放弃 election，避免把已选 control owner 误留成 offline writer 的保护锁。
      await election.release()
      election = undefined
    }
  }
  if (lock && human && request.operation === "compress") {
    // 冲突检查先于 prompt：已有 nonterminal task 时不能让用户先看到停机询问再失败。
    const existing = await ServerLock.findNonterminalMaintenanceTask()
    if (existing) throw new ServerLock.MaintenanceBusyError(`Maintenance task already exists: ${existing.taskID}`)
    if (await confirmDaemonStop(lock)) {
      UI.println(`${UI.Style.TEXT_HIGHLIGHT}●${UI.Style.TEXT_NORMAL} Stopping daemon safely...`)
      // 停机前才获取 election；N 分支不需要任何选主锁。
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
      // 域切换：Y 停机成功后本 CLI 成为唯一 writer，后续走 offline lease。
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
      // #549：start 只需 ACK；长任务观察改走 reconcile，不能再复用 2s 默认去盯进度。
      MAINTENANCE_START_TIMEOUT_MS,
    )
    if (human && request.operation === "compress") {
      // 202 body 只承诺受理；taskID 不存在说明协议被破坏，不能猜一个离线执行。
      if (!isRecord(body) || typeof body.taskID !== "string")
        throw new MaintenanceUnavailableError("Daemon returned an invalid maintenance task")
      return { result: await waitForDaemonTask(lock, body.taskID), retainedDaemon, election }
    }
    if (options.output !== false) printMaintenance(body)
    return { result: body, retainedDaemon, election }
  }
  const started = performance.now()
  // 进度条只在 human compress 创建；offline immediate/verify/cleanup 保持单 JSON 输出合同。
  const progress = human && request.operation === "compress" ? compressionProgress(started) : undefined
  const result = await runOffline(db, ColdMaintain.prepareMaintenance(request), progress?.update)
    .catch(async (error) => {
      // offline 失败必须先释放选主锁再传播原错误，否则 reconnect daemon 会被一次失败维护永久挡住。
      await election?.release()
      throw error
    })
    .then((result) => {
      // offline 的最终快照只在 encoder/lease 已收尾后进入 renderer。
      if (result.type === "task") progress?.update(result.task)
      return result
    })
    .finally(() => progress?.finish())
  if (human && request.operation === "compress" && result.type === "task") {
    renderCompression(result.task, performance.now() - started)
    return { result, retainedDaemon, election }
  }
  if (options.output !== false) printMaintenance(result.type === "task" ? result.task : result)
  return { result, retainedDaemon, election }
}

// #535：sequence owner 只编排两个现有 operation，任何非 completed compression 都在 vacuum 前失败。
// flags 由同一个 CLI request 传入，避免 machine/human 分支各自解释 --yes 的含义。
async function executeCompression(
  db: Database.Interface,
  input: { request: Extract<ColdMaintain.MaintenanceRequest, { operation: "compress" }> } &
    Record<"human" | "vacuum" | "yes", boolean>,
) {
  if (input.yes && !input.vacuum) {
    // bare --yes 只在交互域是 reclaim 授权；机器域它是 silent-stop 授权，必须与 --vacuum 绑定。
    throw new ColdStorage.ValidationError({ message: "compress --yes requires --vacuum" })
  }
  if (!input.human && input.vacuum && !input.yes) {
    // 机器域没有 prompt 可拒绝；缺少 --yes 时直接拒绝组合，不允许静默跳过 reclaim。
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
    const compressed = await executeMaintenance(db, input.request, { output: false, lock: null })
    const task = taskResult(compressed.result)
    const report = await Effect.runPromise(Database.withSync(db, ColdMaintain.status))
    // #549：低于噪声地板时不跑 SQL VACUUM，但保持 compress-vacuum 复合 shape（pageCount 自报）。
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
    const vacuum = await runVacuum(db, report.pageSize, false)
    printMaintenance({ type: "compress-vacuum", compress: task, vacuum })
    return
  }
  // 普通 machine 与 interactive 共享一次 domain selection，只有 interactive 分支继续做 reclaim 决策。
  const execution = await executeMaintenance(db, input.request, { human: input.human })
  try {
    // machine 域到此结束：单 JSON 已由 executeMaintenance 打印，election 在 finally 释放。
    if (!input.human) return
    // taskResult 校验 interactive 结果真的是 task envelope，防止 immediate 被当 completed 处理。
    taskResult(execution.result)
    if (execution.retainedDaemon) {
      // 首次 N 已拒绝 daemon shutdown；本次调用不得再显示 reclaim prompt 或执行 vacuum。
      UI.println(`${UI.Style.TEXT_DIM}○ Physical reclaim skipped while daemon remains running.${UI.Style.TEXT_NORMAL}`)
      UI.println("  Stop the daemon and run: opencode db vacuum --yes")
      return
    }
    const report = await Effect.runPromise(Database.withSync(db, ColdMaintain.status))
    const { reusable } = freelistMetrics(report)
    // #549：completed task 只证明 logical compression；PROMPT 门槛过滤几 KB～小 freelist 噪声。
    if (!reclaimPrompt(report)) return
    UI.println(`${UI.Style.TEXT_WARNING_BOLD}! Logical compression is complete.${UI.Style.TEXT_NORMAL}`)
    UI.println(`  SQLite still contains ${size(reusable)} of reusable pages.`)
    // reclaim prompt 是独立物理授权，不能继承普通 compression 的默认许可。
    if (!input.yes && !(await confirm(`${UI.Style.TEXT_WARNING_BOLD}? Reclaim ${size(reusable)} of physical database space now? [Y/n] ${UI.Style.TEXT_NORMAL}`))) {
      UI.println(`${UI.Style.TEXT_DIM}  Physical reclaim skipped. Run: opencode db vacuum --yes${UI.Style.TEXT_NORMAL}`)
      return
    }
    await runVacuum(db, report.pageSize, true)
  } finally {
    await execution.election?.release()
  }
}

// resume 从持久 record 恢复 operation/args/cursor，用户不能借同一 taskID 改写 scope 或 batchSize。
// live daemon 负责 active lifecycle；offline 域则获取同一文件 lease 并同步执行到 terminal checkpoint。
async function executeResume(db: Database.Interface, taskID: string) {
  const lock = await liveDaemon()
  if (lock) {
    printMaintenance(
      await daemonRequest(lock, ServerLock.CONTROL_MAINTENANCE_RESUME_PATH, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ taskID }),
      }),
    )
    return
  }
  const task = await ServerLock.reconcileMaintenanceTask(taskID)
  if (!task) throw new ColdStorage.ValidationError({ message: `Maintenance task not found: ${taskID}` })
  // queued/completed/failed/running 都拒绝显式 resume，只有 reconcile 后的 interrupted 是合法来源。
  if (task.status !== "interrupted") throw new ColdStorage.ValidationError({ message: `Maintenance task is ${task.status}` })
  const prepared = ColdMaintain.prepareMaintenance(task.args)
  if (prepared.type !== "task") throw new ColdStorage.ValidationError({ message: "Task is not resumable" })
  const result = await runOffline(db, prepared, undefined, { task })
  printMaintenance(result.type === "task" ? result.task : result)
}

const maintenanceDB = Effect.fn("Cli.db.maintenanceDB")(function* () {
  // 显式传递所属 Layer；并存的数据库实例不会通过最后一次初始化互相覆盖。
  return yield* Database.Service
})

// compress：completed compact head OR root idle（--older-than，默认 7d，session.time_updated）OR subagent idle（固定 24h last message）。
// --older-than 只调 root 阈值；subagent 24h 由 ColdStorage 常量固定，不在 CLI 复制第二套规则。
// batch 默认值来自本机实测，不在 CLI 复制魔法数字，daemon JSON 缺省也使用同一常量。
const CompressCommand = effectCmd({
  command: "compress",
  describe: "freeze eligible cold fields into the database cold store",
  instance: false,
  builder: (yargs: Argv) =>
    yargs
      .option("session", { type: "string" })
      .option("older-than", { type: "string", default: "7d" })
      .option("recompress", { type: "boolean", default: false, describe: "also recompress existing cold frames" })
      .option("batch-size", { type: "number", default: ColdStorage.DEFAULT_BATCH_SIZE })
      .option("vacuum", { type: "boolean", default: false })
      .option("yes", { type: "boolean", default: false })
      .option("json", { type: "boolean", default: false }),
  handler: Effect.fn("Cli.db.compress")(function* (args) {
    const db = yield* maintenanceDB()
    // #535：handler 只把 yargs 已解析值转成 request + mode/flags；domain 决策全部在 executeCompression。
    yield* Effect.promise(() =>
      executeCompression(db, {
        request: {
          operation: "compress",
          ...(args.session ? { sessionID: SessionID.make(args.session) } : {}),
          olderThanMs: durationMs(args["older-than"]),
          batchSize: args["batch-size"],
          recompress: args.recompress,
        },
        human: interactive(args.json),
        vacuum: args.vacuum,
        yes: args.yes,
      }),
    )
  }),
})

// expand 反向回填完整热 JSON；全库操作必须同时给 --all 和 --yes，session scope 不需要全库确认。
const ExpandCommand = effectCmd({
  command: "expand",
  describe: "thaw cold fields back into the primary tables",
  instance: false,
  builder: (yargs: Argv) =>
    yargs.option("session", { type: "string" }).option("all", { type: "boolean", default: false }).option("yes", { type: "boolean", default: false }).option("batch-size", { type: "number", default: ColdStorage.DEFAULT_BATCH_SIZE }),
  handler: Effect.fn("Cli.db.expand")(function* (args) {
    const db = yield* maintenanceDB()
    yield* Effect.promise(() => {
      if (!args.all && !args.session) throw new ColdStorage.ValidationError({ message: "expand requires --all or --session" })
      if (args.all && !args.yes) throw new ColdStorage.ValidationError({ message: "expand --all requires --yes" })
      return executeMaintenance(db, { operation: "expand", ...(args.session ? { sessionID: SessionID.make(args.session) } : {}), all: args.all, batchSize: args["batch-size"] })
    })
  }),
})

// status 无 task 时返回 DB metrics，带 task 时只查询持久 control record；两种语义不混入 daemon health。
// offline task 查询先 reconcile dead owner，使强制终止后的 running record 可立即显示 interrupted。
const StatusCommand = effectCmd({
  command: "status",
  describe: "show cold-storage metrics or a persisted task",
  instance: false,
  builder: (yargs: Argv) =>
    yargs.option("task", { type: "string" }).option("json", { type: "boolean", default: false }),
  handler: Effect.fn("Cli.db.status")(function* (args: { task?: string; json: boolean }) {
    const db = yield* maintenanceDB()
    yield* Effect.promise(async () => {
      const lock = await liveDaemon()
      if (args.task) {
        if (lock) {
          const result = await daemonRequest(lock, `${ServerLock.CONTROL_MAINTENANCE_STATUS_PATH}?task=${encodeURIComponent(args.task)}`)
          // #535：人类 PTY 渲染 durable task；脚本/重定向始终拿原始 JSON。
          if (interactive(args.json)) renderTask(ColdMaintain.parseMaintenanceTask(result))
          else printMaintenance(result)
          return
        }
        // offline 域的 task 已是持久 record；daemon 离场后同一 taskID 仍可查询。
        const task = await ServerLock.reconcileMaintenanceTask(args.task)
        if (!task) throw new ColdStorage.ValidationError({ message: `Maintenance task not found: ${args.task}` })
        if (interactive(args.json)) renderTask(task)
        else printMaintenance(task)
        return
      }
      if (lock) {
        // #524：status 没有持久 task 结果可轮询，必须在同一 control 请求中等到完整 StatusReport。
        // 只有本报告调用显式传 false；task 状态查询和其他操作仍沿原 acknowledgement 合同。
        const result = await daemonRequest(
          lock,
          ServerLock.CONTROL_MAINTENANCE_PATH,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ operation: "status" }),
          },
          false,
        )
        if (interactive(args.json)) renderStatus(parseStatus(result))
        else printMaintenance(result)
        return
      }
      const report = await Effect.runPromise(Database.withSync(db, ColdMaintain.status))
      if (interactive(args.json)) renderStatus(report)
      else printMaintenance(report)
    })
  }),
})

// resume 是独立命令而非 compress/expand flag，避免新参数覆盖持久 task 的原始请求。
const ResumeCommand = effectCmd({
  command: "resume <taskID>",
  describe: "resume an interrupted cold-storage task",
  instance: false,
  builder: (yargs: Argv) => yargs.positional("taskID", { type: "string", demandOption: true }),
  handler: Effect.fn("Cli.db.resume")(function* (args: { taskID: string }) {
    const db = yield* maintenanceDB()
    yield* Effect.promise(() => executeResume(db, args.taskID))
  }),
})

// verify 默认只读完整性报告；--repair 才生成可恢复 task，并且只修正可证明的 ref_count。
// #568：--repair-tool-input 独立授权热 Tool 行的 input 形状修复，同样进入 task-backed 写事务。
const VerifyCommand = effectCmd({
  command: "verify",
  describe: "verify cold payload hashes and reference counts",
  instance: false,
  builder: (yargs: Argv) =>
    yargs
      .option("repair", { type: "boolean", default: false })
      .option("repair-tool-input", { type: "boolean", default: false })
      .option("batch-size", { type: "number", default: ColdStorage.DEFAULT_BATCH_SIZE }),
  handler: Effect.fn("Cli.db.verify")(function* (args) {
    const db = yield* maintenanceDB()
    yield* Effect.promise(() =>
      executeMaintenance(db, {
        operation: "verify",
        repair: args.repair,
        repairToolInput: args["repair-tool-input"],
        batchSize: args["batch-size"],
      }),
    )
  }),
})

// cleanup 默认等价 dry-run，只有 --yes 且未显式 --dry-run 才授予 payload 删除权限。
// cleanup 不调用 VACUUM，用户可先核对 logical bytes，再单独决定物理页面回收。
const CleanupCommand = effectCmd({
  command: "cleanup",
  describe: "report or remove unreferenced cold payloads",
  instance: false,
  builder: (yargs: Argv) => yargs.option("dry-run", { type: "boolean", default: false }).option("yes", { type: "boolean", default: false }).option("batch-size", { type: "number", default: ColdStorage.DEFAULT_BATCH_SIZE }),
  handler: Effect.fn("Cli.db.cleanup")(function* (args) {
    const db = yield* maintenanceDB()
    yield* Effect.promise(() => executeMaintenance(db, { operation: "cleanup", delete: args.yes && !args["dry-run"], batchSize: args["batch-size"] }))
  }),
})

// vacuum 是不可 resume 的 SQLite 原子操作，必须显式 --yes 并持有 maintenance lease。
// pages before/after 是唯一物理文件收益口径，不与 cold payload compressedBytes 混用。
const VacuumCommand = effectCmd({
  command: "vacuum",
  describe: "reclaim unused SQLite pages",
  instance: false,
  builder: (yargs: Argv) =>
    yargs.option("yes", { type: "boolean", default: false }).option("json", { type: "boolean", default: false }),
  handler: Effect.fn("Cli.db.vacuum")(function* (args: { yes: boolean; json: boolean }) {
    const db = yield* maintenanceDB()
    yield* Effect.promise(async () => {
      if (!args.yes) throw new ColdStorage.ValidationError({ message: "vacuum requires --yes" })
      // #535：machine 域保持原单 JSON；human 域先取 StatusReport 供 pageSize，再渲染页面前后。
      if (!interactive(args.json)) {
        await executeMaintenance(db, { operation: "vacuum", confirm: true })
        return
      }
      const lock = await liveDaemon()
      // pageSize 必须来自执行前的同一数据库；执行后再读会把 vacuum 后的 page_count 当基准。
      const report = lock
        ? parseStatus(await daemonRequest(lock, ServerLock.CONTROL_MAINTENANCE_PATH, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ operation: "status" }) }, false))
        : await Effect.runPromise(Database.withSync(db, ColdMaintain.status))
      // #549：human freelist=0 不跑 VACUUM；machine 路径仍走上方 executeMaintenance。
      if (freelistMetrics(report).reusable === 0) {
        UI.println(`${UI.Style.TEXT_DIM}○ No reusable pages to reclaim.${UI.Style.TEXT_NORMAL}`)
        return
      }
      // standalone vacuum 复用当前所选执行域；仅 human renderer 改变，daemon/storage ownership 不迁移。
      await runVacuum(db, report.pageSize, true, lock ?? null)
    })
  }),
})

const QueryCommand = effectCmd({
  command: "$0 [query]",
  describe: "open an interactive sqlite3 shell or run a query",
  instance: false,
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
  handler: Effect.fn("Cli.db.query")(function* (args: { query?: string; format: string }) {
    const query = args.query as string | undefined
    if (query) {
      const { db } = yield* Database.Service
      const result = yield* db.all<Record<string, unknown>>(sql.raw(query)).pipe(Effect.orDie)
      if (args.format === "json") console.log(JSON.stringify(result, null, 2))
      else if (result.length > 0) {
        const keys = Object.keys(result[0])
        console.log(keys.join("\t"))
        for (const row of result) console.log(keys.map((key) => row[key]).join("\t"))
      }
      return
    }
    const child = spawn("sqlite3", [Database.path()], {
      stdio: "inherit",
    })
    yield* Effect.promise(() => new Promise((resolve) => child.on("close", resolve)))
  }),
})

const PathCommand = effectCmd({
  command: "path",
  describe: "print the database path",
  instance: false,
  handler: Effect.fn("Cli.db.path")(function* () {
    console.log(Database.path())
  }),
})

export const DbCommand = effectCmd({
  command: "db",
  describe: "database tools",
  instance: false,
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
      .demandCommand()
  },
  handler: Effect.fn("Cli.db")(function* () {}),
})
