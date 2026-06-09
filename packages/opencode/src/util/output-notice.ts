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
  // execution notice 是 shell 输出里给模型看的执行状态，不是完整 metadata 回放。
  // timeout/user_abort 继续用 warning；exit 只暴露退出码，避免把命令、环境变量或原始 metadata 放进模型上下文。
  severity: "info" | "warning" | "error"
  reason: "timeout" | "user_abort" | "exit"
  timeout_ms?: number
  exit_code?: number
}

type Notice = Record<string, string | number | undefined>

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
  })
}

export function formatExecutionNotice(input: ExecutionNotice) {
  return formatNotice({ type: "execution", source: "shell", ...input })
}

export function formatCompactionClearedNotice() {
  return formatNotice({ type: "compaction_cleared", source: "tool_output", reason: "old_result_pruned" })
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
