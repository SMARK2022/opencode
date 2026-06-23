// 两代共享模型可见的notice和省略标记；统计、转义及属性顺序只维护一处。
type OutputAmount = {
  lines?: number
  bytes?: number
}

type OutputTruncatedNotice = {
  source: "tool" | "shell"
  total: OutputAmount
  shown: OutputAmount & { direction: "head" | "tail" | "head+tail" }
  path: string
}

type ExecutionNotice = {
  // #289：execution notice 是 shell 输出里给模型看的执行状态，不是完整 metadata 回放。
  // timeout/user_abort 继续用 warning；exit 只暴露退出码，避免把命令、环境变量或原始 metadata 放进模型上下文。
  severity: "info" | "warning" | "error"
  reason: "timeout" | "user_abort" | "exit"
  timeout_ms?: number
  // #289：exit_code 在 reason 为 exit 时必填，携带原始进程退出码供审计
  exit_code?: number
}

type Notice = Record<string, string | number | undefined>

// 这是模型可见的恢复原话：先grep保存文件，再read offset/limit读取局部，避免无必要整读。
// 单个attribute复用既有notice转义和展示，不改变shell/tool截断正文的前后位置。
const OUTPUT_TRUNCATED_GUIDANCE =
  "Before making decisions that depend on omitted output, use grep on path first, then read relevant ranges with read offset/limit. Avoid reading the full file unless necessary."

export function outputStats(text: string): Required<OutputAmount> {
  return {
    // #282：工具输出经常以最终换行结束；按人类查看保存文件时的行数统计，
    // 避免 notice 把末尾换行误报成额外空行。
    lines: text.length === 0 ? 0 : text.replace(/\r?\n$/, "").split(/\r?\n/).length,
    bytes: Buffer.byteLength(text, "utf-8"),
  }
}

// #282：这些 notice 是模型可见的 harness 边界提示，不是遥测。上下文里只放
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

// #282：timeout_ms 直接内联，模型无需再查 metadata 即可判断是否值得重试
export function formatExecutionNotice(input: ExecutionNotice) {
  return formatNotice({ type: "execution", source: "shell", ...input })
}

// 退出状态与隐藏诊断互相独立，非零退出始终交付，取消仍不冒充进程退出。
export function formatExitNotice(code: number | null, emptyOutput: boolean) {
  if (code === null || (!emptyOutput && code === 0)) return
  return formatExecutionNotice({ severity: code === 0 ? "info" : "error", reason: "exit", exit_code: code })
}


// #282：compaction 已在持久层清理旧输出；给模型一个稳定的占位语义而不是空串
export function formatCompactionClearedNotice() {
  return formatNotice({ type: "compaction_cleared", source: "tool_output", reason: "old_result_pruned" })
}

// 只截模型交付文本；旧单边零上限禁用截断，显式双向预算保留source的零端退化语义。
export function truncateForCompaction(text: string, maxChars?: number, tailChars?: number) {
  if (tailChars === undefined) {
    if (!maxChars || text.length <= maxChars) return text
    return `${text.slice(0, maxChars)}\n[... compaction truncated ${text.length - maxChars} chars]`
  }
  if (maxChars === undefined || text.length <= maxChars + tailChars) return text
  const omitted = text.length - maxChars - tailChars
  // 不截短重叠的首尾；单端预算避免多余空行，训练过的省略标记原话保持不变。
  if (tailChars === 0) return `${text.slice(0, maxChars)}\n[... compaction truncated ${omitted} chars]`
  if (maxChars === 0) return `[... compaction truncated ${omitted} chars ...]\n${text.slice(-tailChars)}`
  return `${text.slice(0, maxChars)}\n[... compaction truncated ${omitted} chars ...]\n${text.slice(-tailChars)}`
}

function formatNotice(input: Notice) {
  // #282：空值属性直接省略，保持单行、稳定属性顺序（对象字面量序）
  return `<opencode_notice ${Object.entries(input)
    .flatMap(([key, value]) => (value === undefined || value === "" ? [] : [`${key}="${escapeAttribute(String(value))}"`]))
    .join(" ")} />`
}

function formatOutputAmount(input: OutputAmount) {
  // #282：L/B 分段展示；任一缺失即跳过该段，不输出 0 占位
  return [input.lines === undefined ? "" : `${input.lines}L`, input.bytes === undefined ? "" : formatBytes(input.bytes)]
    .filter(Boolean)
    .join("/")
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${formatUnit(bytes / 1024)}KB`
  return `${formatUnit(bytes / 1024 / 1024)}MB`
}

// #282：≥10 取整、<10 保留一位小数；整数值不拖尾 .0，保证断言稳定
function formatUnit(value: number) {
  if (value >= 10) return Math.round(value).toString()
  const rounded = Math.round(value * 10) / 10
  return Number.isInteger(rounded) ? rounded.toString() : rounded.toFixed(1)
}

// #282：属性值转义防破坏标签结构；输出可能包含用户控制的文件路径
function escapeAttribute(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;")
}
