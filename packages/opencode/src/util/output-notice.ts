type OutputAmount = {
  lines?: number
  bytes?: number
}

type OutputTruncatedNotice = {
  source: "tool" | "shell"
  total: OutputAmount
  shown: OutputAmount & { direction: "head" | "tail" }
  path: string
}

type ExecutionNotice = {
  // execution notice 是 shell/tool 输出里给模型看的执行状态，不是完整 metadata 回放。
  // timeout/user_abort 继续用 warning；exit 只暴露退出码，避免把命令、环境变量或原始 metadata 放进模型上下文。
  // source 缺省为 shell，generic tool 传 "tool" 以区分来源
  source?: "shell" | "tool"
  severity: "info" | "warning" | "error"
  // completed 用于长成功工具的中性耗时提示，不含退出码
  reason: "timeout" | "user_abort" | "exit" | "completed"
  timeout_ms?: number
  exit_code?: number
  // 实际墙钟耗时（毫秒），由 server 在终态时写入；不从旧 state.time 追溯
  elapsed_ms?: number
}

// 长成功 Notice 阈值：超过此值的成功执行追加中性 completed Notice。
// 120 秒是当前产品决定，不新增配置项；异常（abort/timeout/exit）不受此阈值限制
export const LONG_EXECUTION_NOTICE_MS = 120 * 1000

type Notice = Record<string, string | number | undefined>

// 这段文本是模型可见的截断恢复策略，而不是 UI 文案：它必须足够短，
// 同时明确先用保存文件做 grep 定位，再用 read offset/limit 读取局部上下文。
// 保持为单个 attribute 可以复用现有 XML-like notice 解析和展示路径，
// 避免为了增强提示性而改变 shell/tool 截断输出的前后位置不变量。
const OUTPUT_TRUNCATED_GUIDANCE =
  "Before making decisions that depend on omitted output, use grep on path first, then read relevant ranges with read offset/limit. Avoid reading the full file unless necessary."

export function outputStats(text: string): Required<OutputAmount> {
  return {
    // 工具输出经常以最终换行结束；这里按人类查看保存文件时的行数统计，
    // 避免 notice 把末尾换行误报成额外空行。
    lines: text.length === 0 ? 0 : text.replace(/\r?\n$/, "").split(/\r?\n/).length,
    bytes: Buffer.byteLength(text, "utf-8"),
  }
}

// 这些 notice 是模型可见的 harness 边界提示，不是遥测。上下文里只放
// 可继续工作的关键字段，详细计数继续留在 metadata/log，避免截断说明本身耗费过多 token。
export function formatOutputTruncatedNotice(input: OutputTruncatedNotice) {
  return formatNotice({
    type: "output_truncated",
    source: input.source,
    total: formatOutputAmount(input.total),
    shown: [input.shown.direction, formatOutputAmount(input.shown)].filter(Boolean).join(" "),
    path: input.path,
    guidance: OUTPUT_TRUNCATED_GUIDANCE,
  })
}

export function formatExecutionNotice(input: ExecutionNotice) {
  // source 缺省为 shell，保持所有旧调用点行为不变
  const { source = "shell", ...rest } = input
  return formatNotice({ type: "execution", source, ...rest })
}

// 将 elapsed 规范化为非负有限整数；NaN/Infinity/负值返回 0，不输出畸形属性
function normalizeElapsed(ms: number): number {
  return Number.isFinite(ms) && ms > 0 ? Math.floor(ms) : 0
}

// 通用长成功 Notice：仅当 elapsed 达到阈值时返回 Notice，否则 undefined。
// 用于 local/MCP/Task/direct shell 的成功路径；Bash 由 formatShellExecutionNotice 统一处理
export function formatLongExecutionNotice(source: "shell" | "tool", elapsedMs: number): string | undefined {
  const ms = normalizeElapsed(elapsedMs)
  // 未达阈值不追加，保持短成功 output 完全不变
  if (ms < LONG_EXECUTION_NOTICE_MS) return undefined
  return formatExecutionNotice({ source, severity: "info", reason: "completed", elapsed_ms: ms })
}

// Bash 终态 outcome policy：按固定优先级返回唯一 execution Notice。
// timeout > user_abort > exit(non-zero/empty) > long completed > none
// 保证一个 Bash 结果不会同时出现两种系统 outcome（如 abort + completed）
export function formatShellExecutionNotice(input: {
  aborted: boolean
  expired: boolean
  exitCode: number | null
  emptyOutput: boolean
  timeoutMs: number
  elapsedMs: number
}): string | undefined {
  const elapsed = normalizeElapsed(input.elapsedMs)
  // timeout 优先：即使后续 exitCode 有值，也是 kill 后的残留，不是真实退出
  if (input.expired) {
    return formatExecutionNotice({ severity: "warning", reason: "timeout", timeout_ms: input.timeoutMs, elapsed_ms: elapsed })
  }
  if (input.aborted) {
    return formatExecutionNotice({ severity: "warning", reason: "user_abort", elapsed_ms: elapsed })
  }
  if (input.exitCode !== null) {
    // non-zero exit 始终显示 error exit Notice + elapsed
    if (input.exitCode !== 0) {
      return formatExecutionNotice({ severity: "error", reason: "exit", exit_code: input.exitCode, elapsed_ms: elapsed })
    }
    // exit 0 + 空输出：保留既有 info exit Notice，不改成 completed
    if (input.emptyOutput) {
      return formatExecutionNotice({ severity: "info", reason: "exit", exit_code: 0, elapsed_ms: elapsed })
    }
    // exit 0 + 有输出：仅超过阈值时追加 completed Notice
    return formatLongExecutionNotice("shell", elapsed)
  }
  // exitCode === null 且无 abort/timeout：不生成 Notice
  return undefined
}

export function formatCompactionClearedNotice() {
  return formatNotice({ type: "compaction_cleared", source: "tool_output", reason: "old_result_pruned" })
}

// task 工具：模型传了无法解析为已有 Session 的 task_id 时，仍新建任务但用 notice 标明独立上下文。
// provided 走 attribute escape，避免引号/尖括号破坏 <opencode_notice> 骨架。
export function formatTaskIdNotice(input: { provided: string }) {
  // severity=warning：任务已成功创建，但模型应改用返回的合法 task_id 继续
  return formatNotice({
    type: "task_id",
    source: "task",
    severity: "warning",
    reason: "invalid_provided",
    provided: input.provided,
    // action 固定 created_new，避免与 resume 语义混淆
    action: "created_new",
  })
}

function formatNotice(input: Notice) {
  return `<opencode_notice ${Object.entries(input)
    .flatMap(([key, value]) => (value === undefined || value === "" ? [] : [`${key}="${escapeAttribute(String(value))}"`]))
    .join(" ")} />`
}

function formatOutputAmount(input: OutputAmount) {
  return [input.lines === undefined ? "" : `${input.lines}L`, input.bytes === undefined ? "" : formatBytes(input.bytes)]
    .filter(Boolean)
    .join("/")
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${formatUnit(bytes / 1024)}KB`
  return `${formatUnit(bytes / 1024 / 1024)}MB`
}

function formatUnit(value: number) {
  if (value >= 10) return Math.round(value).toString()
  const rounded = Math.round(value * 10) / 10
  return Number.isInteger(rounded) ? rounded.toString() : rounded.toFixed(1)
}

function escapeAttribute(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;")
}
