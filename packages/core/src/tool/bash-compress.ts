/**
 * 用于优化大模型上下文的 Bash 输出压缩器。
 *
 * 设计思路:
 *   1. 折叠回车（Carriage-Return, \r）产生的进度条帧，避免类似 npm install 时的全屏刷新。
 *   2. 压缩重复的多行块，比如无限循环打印相同的几行日志。
 *   3. 压缩连续的相同行，比如连续打印 100 行 "ping timeout"。
 *   4. 压缩单行内明显的重复模式，比如某些进度条中的 "...." 或者 "######"。
 *   5. 单独收集高信号的诊断信息，例如带有 error, exception 的上下文，确保最后的 tail() 回退不会意外截断提取到的错误。
 *
 * 安全性:
 *   - 每次替换必须证明它节省了足够的字节，避免为了压缩而压缩，导致信息丢失却没省下空间。
 *   - 替换是贪婪执行的，从上到下。
 *   - 跨行压缩在行内压缩之前运行，保证大块的重复优先被处理。
 *   - BashTool 的截断文件路径应当仍然保留完整的原始输出，以便用户或模型后续可以查看完整日志。
 */

// 配置只影响模型呈现，不能改变进程执行、授权或原始日志的写盘内容。
export type CompressionConfig = {
  // 单次 false 必须绕过所有折叠策略；诊断采样仍独立运行以观察窗口外错误。
  enabled: boolean

  /**
   * 一次替换操作所需的最小绝对节省字节数。
   * 如果替换后省下的空间不到这个值，则放弃替换。
   */
  minSavedBytes: number

  /**
   * 一次替换所需的最小节省比例。
   * 0.5 表示替换必须节省原始字节的至少 50%。
   */
  minSavingRatio: number

  /**
   * 多行重复块设置。
   * maxBlockLines: 寻找重复块时的最大块行数（太大会导致性能下降）
   * minBlockRepeats: 最小的重复次数（例如一个块至少要重复2次才考虑压缩）
   */
  maxBlockLines: number
  minBlockRepeats: number

  /**
   * 相同行设置。
   * minSameLineRepeats: 单行重复的最少次数，达到这个次数才会合并。
   */
  minSameLineRepeats: number

  /**
   * 行内重复模式设置。
   * maxInlinePatternLength: 寻找行内重复模式的最大字符串长度。
   * minInlineRepeatCount: 行内模式最少重复次数。
   * minInlineRunBytes: 触发单行内压缩的整行最小字节数（短行不值得行内压缩）。
   * maxInlineLineLength: 允许进行行内压缩的最大单行长度，防止超长行正则卡死（ReDoS）。
   */
  maxInlinePatternLength: number
  minInlineRepeatCount: number
  minInlineRunBytes: number
  maxInlineLineLength: number

  /**
   * 回车（\r）进度条设置。
   * minCarriageReturnFrames: 在同一行中出现的最少 \r 刷新帧数，达到此值才折叠。
   */
  minCarriageReturnFrames: number

  // 熵与空白阈值共同排除普通长句，长度门槛限制短行误判。
  minHighEntropyLineLength: number
  minEntropy: number
  maxWhitespaceRatio: number
  minTemplateRepeats: number
  // off 保留精确文本；aggressive 的路径和数字归一化必须显式启用。
  templateNormalizationLevel: string
  // 适配器只改呈现，不改变 command 的执行或授权资源。
  enableCommandAdapters: boolean

  /**
   * 诊断信息提取设置。
   * diagnosticMinRuntimeMs: 命令执行时间超过此时长才提取诊断（太短的命令报错通常很直接，不需要专门提取）。
   * diagnosticContextRadius: 错误行前后保留的上下文行数（半径）。
   * maxDiagnosticContexts: 最终展示的最大诊断上下文数量。
   * diagnosticLineMaxChars: 诊断信息单行最大保留字符数，超长则截断。
   */
  diagnosticMinRuntimeMs: number
  diagnosticContextRadius: number
  maxDiagnosticContexts: number
  diagnosticLineMaxChars: number
}

// 统计针对进入压缩器的有界可见窗口；不能把它冒充整个磁盘日志的收益。
export type CompressionStats = {
  originalBytes: number        // 压缩前原始总字节数
  compressedBytes: number      // 压缩后总字节数
  savedBytes: number           // 节省的总字节数
  savingRatio: number          // 节省的总体比例

  carriageReturnGroups: number // 命中的回车折叠次数
  repeatedBlockGroups: number  // 命中的多行块重复压缩次数
  repeatedLineGroups: number   // 命中的单行重复压缩次数
  inlinePatternGroups: number  // 命中的行内模式压缩次数
  templateGroups: number
  highEntropyLines: number
  // 脱敏不是收益命中，零压缩时也需要独立报告与原文恢复。
  secretsRedacted: number

  applied: boolean             // 是否真正应用了任何压缩（即节省了空间）
}

// 文本与统计同一次计算返回，避免调用者重复压缩导致比例和实际输出不一致。
export type CompressResult = {
  text: string                 // 压缩后的文本
  stats: CompressionStats      // 压缩统计
}

// 候选收益包含替换标签，扫描阶段与最终应用阶段必须使用相同计量单位。
type Score = {
  originalBytes: number        // 替换前字节数
  replacementBytes: number     // 替换后字节数
  savedBytes: number           // 节省字节数
  savingRatio: number          // 节省比例
  profitable: boolean          // 是否满足 minSavedBytes 和 minSavingRatio 的“划算”阈值
}

// 消耗行数指向原始数组，替换标签的行数不能用于推进扫描游标。
type BlockCandidate = {
  width: number                // 这个块包含多少行
  repeats: number              // 连续重复了多少次
  replacementLines: string[]   // 用于替换的文本行（通常是原始块 + 提示信息）
  consumedLines: number        // 这次替换共消耗/涵盖了原始文本的多少行
  score: Score                 // 评估得分
}

// CR 重绘也形成诊断帧；这里的编号是采集帧序号，不冒充原文件的 LF 行号。
type LineRecord = {
  no: number                   // 行号（从1开始）
  text: string                 // 行内容
}

// 中心帧身份用于可见性去重，重叠上下文合并后仍需保留最近错误的中心。
export type DiagnosticContext = {
  centerLine: number           // 触发这个上下文的中心错误行号
  lines: LineRecord[]          // 包含上下文的所有行
  // 优先级在错误准入时确定，收尾时不能依赖已增长的总计数。
  priority: "first" | "fatal" | "recent"
  // 合并邻域不能丢掉准入中心，也不能从已脱敏文本重新猜测错误身份。
  centerLines: number[]
}

// 命令执行完毕后的诊断快照，汇总了各项异常指标
export type DiagnosticSnapshot = {
  totalLines: number           // 输出总行数
  errorLikeLines: number       // 包含错误关键词的行数
  warningLikeLines: number     // 包含警告关键词的行数
  fatalLikeLines: number       // 包含致命错误关键词的行数
  contexts: DiagnosticContext[]// 合并整理后的所有诊断上下文块
  // 首批不被滚动队列驱逐；致命与近期各自保留有限容量。
  firstErrorContexts: DiagnosticContext[]
  fatalContexts: DiagnosticContext[]
  recentErrorContexts: DiagnosticContext[]
  // 采样损失与输出截断分别报告；遗漏段仍可从调用方保留的原始文件恢复。
  discardedChars: number
  truncatedFrames: number
}

// 可见性判断必须读取最终窗口，不能用截断前文本认定错误已经交给模型。
export type RenderAppendixOptions = {
  durationMs: number           // 命令执行耗时
  exitCode: number | null      // 命令退出码
  visibleOutput: string        // 当前对模型可见的已压缩、已截断输出
  config?: Partial<CompressionConfig> // 允许传入部分配置覆盖默认
}

// 默认配置，支持从环境变量读取进行动态调整
export const DEFAULT_COMPRESSION_CONFIG: CompressionConfig = {
  // 环境开关是默认值；调用方显式 enabled 可以覆盖它，保持源配置优先级。
  enabled: process.env.OPENCODE_EXPERIMENTAL_BASH_OUTPUT_COMPRESSION !== "0",

  // 80 字节覆盖说明标签成本，避免几条短日志被更长的说明替换。
  minSavedBytes: Number(process.env.OPENCODE_BASH_COMPRESSION_MIN_SAVED_BYTES ?? 80),
  // 默认至少减半才牺牲精确排版，微小收益不足以支持有损呈现。
  minSavingRatio: Number(process.env.OPENCODE_BASH_COMPRESSION_MIN_SAVING_RATIO ?? 0.5),

  // 12 行限制每个起点的候选数量，防止多行扫描扩展到整个捕获窗口。
  maxBlockLines: Number(process.env.OPENCODE_BASH_COMPRESSION_MAX_BLOCK_LINES ?? 12),
  // 两次是块重复的最小证据，实际替换仍受字节收益门槛约束。
  minBlockRepeats: Number(process.env.OPENCODE_BASH_COMPRESSION_MIN_BLOCK_REPEATS ?? 2),

  // 三次降低偶发相同行的折叠概率；两条相同诊断仍保持原始上下文。
  minSameLineRepeats: Number(process.env.OPENCODE_BASH_COMPRESSION_MIN_SAME_LINE_REPEATS ?? 3),

  // 模式宽度上限与行长上限共同约束嵌套扫描，不能只限制替换结果长度。
  maxInlinePatternLength: Number(process.env.OPENCODE_BASH_COMPRESSION_MAX_INLINE_PATTERN_LENGTH ?? 64),
  // 四次重复减少普通源码短片段误判，收益检查再排除短标签净增长。
  minInlineRepeatCount: Number(process.env.OPENCODE_BASH_COMPRESSION_MIN_INLINE_REPEAT_COUNT ?? 4),
  // 行内候选另按 UTF-8 字节检查，字符预筛不会把中文字符数当作最终收益。
  minInlineRunBytes: Number(process.env.OPENCODE_BASH_COMPRESSION_MIN_INLINE_RUN_BYTES ?? 80),
  // 最大支持 4096 字符的行内压缩，防止正则引擎卡死
  maxInlineLineLength: Number(process.env.OPENCODE_BASH_COMPRESSION_MAX_INLINE_LINE_LENGTH ?? 4096),

  // 少量 CR 可能是精确格式内容，默认四帧才视作可折叠进度刷新。
  minCarriageReturnFrames: Number(process.env.OPENCODE_BASH_COMPRESSION_MIN_CR_FRAMES ?? 4),

  // 保留源环境默认值，局部 config 覆盖仍由同一个 configOf 合并。
  minHighEntropyLineLength: Number(process.env.OPENCODE_BASH_MIN_HIGH_ENTROPY_LINE_LENGTH ?? 512),
  minEntropy: Number(process.env.OPENCODE_BASH_MIN_ENTROPY ?? 4.5),
  maxWhitespaceRatio: Number(process.env.OPENCODE_BASH_MAX_WHITESPACE_RATIO ?? 0.1),
  minTemplateRepeats: Number(process.env.OPENCODE_BASH_COMPRESSION_MIN_TEMPLATE_REPEATS ?? 3),
  templateNormalizationLevel: process.env.OPENCODE_BASH_TEMPLATE_NORMALIZATION ?? "safe",
  enableCommandAdapters: process.env.OPENCODE_BASH_ENABLE_COMMAND_ADAPTERS !== "0",

  // 两秒门槛避免短命令把同一错误再附录一次，采样损失提示不受此门槛隐藏。
  diagnosticMinRuntimeMs: Number(process.env.OPENCODE_BASH_DIAGNOSTIC_MIN_RUNTIME_MS ?? 2000),
  // 前后三帧提供定位线索，采集器只持有这些邻域而不是整个历史。
  diagnosticContextRadius: Number(process.env.OPENCODE_BASH_DIAGNOSTIC_CONTEXT_RADIUS ?? 3),
  // 最近五个上下文优先，防止早期噪声占满结束时的诊断预算。
  maxDiagnosticContexts: Number(process.env.OPENCODE_BASH_DIAGNOSTIC_MAX_CONTEXTS ?? 5),
  // 附录每帧最多百字符，详细内容由原始文件承担，避免附录重新膨胀输出。
  diagnosticLineMaxChars: Number(process.env.OPENCODE_BASH_DIAGNOSTIC_LINE_MAX_CHARS ?? 100),
}

// 匹配类错误的高信噪比关键词正则（大小写不敏感）
const ERROR_LIKE_RE =
  /\b(?:error|errors|exception|traceback|failed|failure|fatal|panic|segmentation fault|assertion|assertionerror|typeerror|valueerror|referenceerror|syntaxerror|module not found|cannot find module)\b/i

// 匹配类警告的关键词正则
const WARNING_LIKE_RE = /\b(?:warn|warning|warnings|deprecated|deprecation)\b/i

// 匹配极高信号的致命错误关键词（用于决定是否强制输出上下文）
const FATAL_LIKE_RE =
  /\b(?:exception|traceback|fatal|panic|segmentation fault|assertionerror|typeerror|valueerror|referenceerror|syntaxerror|module not found|cannot find module)\b/i

// 用于排除 "0 errors", "0 warnings" 这种健康指标行
const ZERO_PROBLEM_RE = /\b0\s+(?:errors?|failures?|warnings?)\b/i
// 匹配 ANSI 控制字符（颜色、清屏等），含有 ANSI 的行在行内压缩时被跳过
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/
const ANSI_GLOBAL_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g
// 诊断分帧容量不依赖命令是否换行，也不依赖可能被环境配置放大的呈现阈值。
const MAX_DIAGNOSTIC_FRAME_CHARS = 4096

const COMPILE_ERROR_RE = /\b(?:TS\d+|error\[E\d+\]|SyntaxError|TypeError|ModuleNotFoundError|cannot find module)\b/i
const INFRA_ERROR_RE = /\b(?:ENOENT|EACCES|ECONNREFUSED|EADDRINUSE|timeout|permission denied|connection refused)\b/i
// 健康词只能过滤弱信号，分级判断仍优先检查真实编译与基础设施错误。
const HEALTHY_INDICATOR_RE = /\b(?:no\s+errors?|without\s+errors?|0\s+failed|failed\s*=\s*0|errors?\s*:\s*0|warnings?\s*:\s*0|no\s+vulnerabilities\s+found|found\s+0\s+vulnerabilities|all\s+tests?\s+passed?|\d+\s+passed?,\s+0\s+failed|build\s+successful|compilation\s+successful|no\s+issues?\s+found)\b/i
// 完整值与跨帧续接共用源字段定义，不增加其它秘密类别或另一套识别语法。
const CREDENTIAL_FIELD = String.raw`\b(?:password|passwd|pwd|secret|token|key|api[_-]?key)`
const CREDENTIAL_LABEL = `${CREDENTIAL_FIELD}\\s*[:=]`

// 正文、附录与可见性比较共用同一掩码，不能通过第二呈现出口泄密。
function redactSecrets(text: string) {
  let redacted = 0
  const positions: number[] = []
  let visible = ""
  // ANSI透明匹配只定位秘密；未匹配的原格式与未知CSI不能被全局清洗。
  for (let i = 0; i < text.length;) {
    const ansi = text[i] === "\x1b" ? /^\x1b\[[0-9;?]*[ -/]*[@-~]/.exec(text.slice(i)) : null
    if (ansi) { i += ansi[0].length; continue }
    positions.push(i)
    visible += text[i++]
  }
  const patterns = [
    // 私钥整段遮盖；缺少结束标记时遮到窗口末尾，不能只替换标题。
    [/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|$)/g, "private-key"],
    [/\bsk-[A-Za-z0-9_-]{20,}\b/g, "api-key"],
    [/\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "jwt"],
    [/\bAKIA[0-9A-Z]{16}\b/g, "aws-access-key"],
    [/\bgh[ps]_[A-Za-z0-9]{36,}\b/g, "github-token"],
    // 单词边界避免 monkey 等普通字段误匹配；保留源八字符凭据门槛。
    [new RegExp(`${CREDENTIAL_LABEL}\\s*['"]?([^'"\\s]{8,})['"]?`, "gi"), "credential"],
  ] as const
  const matches = patterns.flatMap(([regex, name]) => [...visible.matchAll(regex)].map((match) => ({
    start: positions[match.index], end: positions[match.index + match[0].length - 1] + 1, name,
  }))).sort((a, b) => a.start - b.start || b.end - a.end)
  const parts: string[] = []
  let cursor = 0
  // 重叠模式只提交一次掩码，计数对应真实替换，不重复计算同一凭据。
  for (const match of matches) {
    if (match.start < cursor) continue
    // 保留被掩码范围的分帧边界，标签跨LF时掩码落在值帧，正文与诊断可见性一致。
    const breaks = text.slice(match.start, match.end).match(/\r\n|\r|\n/g)?.join("") ?? ""
    parts.push(text.slice(cursor, match.start), breaks + `<REDACTED_${match.name.toUpperCase()}>`)
    cursor = match.end
    redacted++
  }
  parts.push(text.slice(cursor))
  // 仅携带无值字段及可选分隔符，源允许字段与冒号间跨空白帧，状态不累积空白或值。
  const continuation = new RegExp(`${CREDENTIAL_FIELD}(?:\\s*[:=])?\\s*$`, "i").exec(visible)?.[0].replace(/\s/g, "") ?? ""
  return { text: parts.join(""), redacted, continuation }
}

export interface CommandAdapter {
  detect(command: string): boolean
  postCompress?(output: string, config: CompressionConfig): string
}
// 只描述呈现上下文，不引入进程句柄、原文路径或 Store 依赖。
export type CommandAdapterContext = { command: string; exitCode: number | null; durationMs: number }

class NpmPnpmAdapter implements CommandAdapter {
  detect(command: string): boolean {
    return /^(npm|pnpm|yarn)\s+(i|install|ci|add)\b/.test(command)
  }

  postCompress(output: string, config: CompressionConfig): string {
    const lines = output.split("\n")
    const start = lines.findIndex((line) => /found \d+ vulnerabilities/.test(line))
    const end = lines.findIndex((line, i) => i > start && line.trim() === "")
    // 只折叠已闭合 banner，窗口末尾缺边界时保留详细建议。
    if (start >= 0 && end > start && !lines.slice(start + 1, end).some(isErrorLike))
      lines.splice(start, end - start, "... [npm audit summary collapsed]", lines[start])
    const grouped = new Map<string, number>()
    for (const line of lines) {
      const match = /WARN.*peer dep.*?(\S+)/i.exec(line)
      if (match) grouped.set(match[1], (grouped.get(match[1]) ?? 0) + 1)
    }
    // 没有可解析包名的 warning 不能被过滤成空摘要。
    if ([...grouped.values()].reduce((sum, count) => sum + count, 0) < 3) return lines.join("\n")
    return [...lines.filter((line) => !/WARN.*peer dep.*?(\S+)/i.test(line)),
      "... [peer dependency warnings grouped]:",
      ...[...grouped].map(([pkg, count]) => `  - ${pkg} (${count}x)`)].join("\n")
  }
}

class PytestAdapter implements CommandAdapter {
  detect(command: string): boolean {
    return /^pytest\b/.test(command)
  }

  postCompress(output: string, config: CompressionConfig): string {
    const lines = output.split("\n")
    const start = lines.findIndex((line) => /^=+ short test summary/i.test(line))
    // 截断窗口没有完整结尾时不假造失败列表，原 summary 仍原样保留。
    const end = lines.findIndex((line, i) => i > start && /^=+/.test(line))
    const failed = start >= 0 && end > start ? lines.slice(start, end).filter((line) => /^FAILED/i.test(line)) : []
    // 摘要用于定位失败测试，只有另有折叠净收益时才由调用方提交。
    if (failed.length) lines.unshift(`<pytest_summary>\nfailed=${failed.length}\n${failed.map((line) => `- ${line.replace(/^FAILED\s+/i, "")}`).join("\n")}\n</pytest_summary>`, "")
    for (let i = 0; i < lines.length; i++) {
      if (!/^-+ Captured (stdout|stderr) call -+$/i.test(lines[i])) continue
      let end = i + 1
      while (end < lines.length && !/^=+/.test(lines[end]) && !/^-+ Captured/i.test(lines[end])) end++
      const count = end - i - 1
      // 首尾各十行保留来源；隐藏中段错误由流式诊断附录恢复。
      if (count > 50) {
        lines.splice(i + 11, count - 20, `... [${count - 20} lines of captured output omitted]`)
        i += 21
      }
    }
    return lines.join("\n")
  }
}

class DockerAdapter implements CommandAdapter {
  detect(command: string): boolean {
    return /^docker\s+(build|buildx)\b/.test(command)
  }

  postCompress(output: string, config: CompressionConfig): string {
    const steps = new Map<string, { num: string; name: string; status: string; lines: string[] }>()
    const prefix: string[] = []
    for (const line of output.split("\n")) {
      const match = /^#(\d+)(?:\s|$)/.exec(line)
      // 无编号输出没有可证明的步骤归属，保留原文而非挂到最后的header。
      if (!match) { prefix.push(line); continue }
      const header = /^#\d+ \[(.+?)\]/.exec(line)
      // BuildKit并发日志按实际编号索引，header与状态交错不会改变归属。
      const step = steps.get(match[1]) ?? { num: match[1], name: header?.[1] ?? `step #${match[1]}`, status: "RUNNING", lines: new Array<string>() }
      if (header) step.name = header[1]
      steps.set(match[1], step)
      step.lines.push(line)
      // ERROR 终态不能被后续 DONE 覆盖；失败步骤全部保留而非只留第一个。
      if (/ERROR/i.test(line)) step.status = "FAILED"
      if (step.status !== "FAILED" && /DONE|CACHED/i.test(line)) step.status = /CACHED/i.test(line) ? "CACHED" : "DONE"
    }
    if (!steps.size) return output
    const ordered = [...steps.values()]
    return [...prefix, "<docker_build_summary>", ...ordered.map((step) => `#${step.num} ${step.name}: ${step.status}`),
      "</docker_build_summary>", ...ordered.filter((step) => step.status === "FAILED" || step.status === "RUNNING").flatMap((step) =>
        [`<docker_failed_step step="#${step.num}">`, ...step.lines, "</docker_failed_step>"])].join("\n")
  }
}

class TypeScriptAdapter implements CommandAdapter {
  detect(command: string): boolean {
    return /^(tsc|npx tsc|bun tsc)\b/.test(command)
  }

  postCompress(output: string, config: CompressionConfig): string {
    const groups = new Map<string, string[]>()
    for (const line of output.split("\n")) {
      const match = /^(.+?)\((\d+),(\d+)\): error (TS\d+):/.exec(line)
      if (!match) continue
      const group = groups.get(match[4]) ?? []
      group.push(line)
      groups.set(match[4], group)
    }
    if (!groups.size) return output
    // 不同错误码各自保留三例，不能让一个高频错误挤掉其它类型。
    const kept = new Set([...groups.values()].flatMap((lines) => lines.slice(0, 3)))
    // 只省去成功解析的后续实例，未知格式的诊断不能被错误码过滤吞掉。
    const filtered = output.split("\n").filter((line) => !/^(.+?)\((\d+),(\d+)\): error (TS\d+):/.test(line) || kept.has(line))
    return `<tsc_diagnostics_summary>\n${[...groups].map(([code, lines]) => `${code} x ${lines.length}`).join(", ")}\nfirst errors shown below (${kept.size} instances)\n</tsc_diagnostics_summary>\n${filtered.join("\n")}`
  }
}

// 沿用源适配器类与注册顺序，实际 command 和收益门槛仍由调用处控制。
const COMMAND_ADAPTERS: CommandAdapter[] = [
  new NpmPnpmAdapter(),
  new PytestAdapter(),
  new DockerAdapter(),
  new TypeScriptAdapter(),
]

export function detectCommandAdapter(command: string) {
  // 只识别源支持的命令头，不猜测复杂 shell 字符串内的子命令。
  return COMMAND_ADAPTERS.find((adapter) => adapter.detect(command.trim()))
}
export function applyCommandAdapter(command: string, output: string, config: CompressionConfig) {
  if (!config.enabled || !config.enableCommandAdapters) return output
  const candidate = detectCommandAdapter(command)?.postCompress?.(output, config) ?? output
  // 摘要也必须满足相同绝对与比例收益，不能靠适配器绕开 no-apply。
  return scoreReplacement(output, candidate, config).profitable ? candidate : output
}

function simpleHash(text: string) {
  let hash = 0
  for (let i = 0; i < text.length; i++) hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0
  return Math.abs(hash).toString(16).padStart(8, "0")
}

function normalizeLineForGrouping(line: string, level: string) {
  if (level === "off") return line
  let normalized = line
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z?/g, "<ISO_TIME>")
    .replace(/\b\d{2}:\d{2}:\d{2}(\.\d{3})?\b/g, "<TIME>")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<UUID>")
    .replace(/\b[0-9a-f]{8,}\b/gi, "<HEX>")
  // safe 保留路径、端口、错误码等定位信息，源 aggressive 只在显式选择时扩展。
  if (level === "aggressive") normalized = normalized
    .replace(/:\d{2,5}\b/g, ":<PORT>")
    .replace(/\b\d+(\.\d+)?\s*(B|KB|MB|GB|TB|bytes?)\b/gi, "<SIZE>")
    .replace(/\b\d+(\.\d+)?\s*(ms|s|sec|min|h|hours?|minutes?|seconds?)\b/gi, "<DURATION>")
    .replace(/\b\d{4,}\b/g, "<NUM>")
    .replace(/\/tmp\/[^\s]+/g, "<TMPPATH>")
    .replace(/C:\\Users\\[^\\]+\\AppData\\Local\\Temp\\[^\s]+/gi, "<TMPPATH>")
  return normalized
}

function compressTemplateRuns(lines: string[], config: CompressionConfig) {
  if (config.templateNormalizationLevel === "off") return { lines, groups: 0 }
  // 归一化一次缓存，拒绝收益的长运行不会反复执行整组正则。
  const templates = lines.map((line) => normalizeLineForGrouping(line, config.templateNormalizationLevel))
  const out: string[] = []
  let groups = 0
  for (let i = 0; i < lines.length;) {
    let j = i + 1
    while (j < lines.length && templates[j] === templates[i]) j++
    const run = lines.slice(i, j)
    const replacement = [`... [template repeated ${j - i} times: ${quotePattern(templates[i], 60)}]`, `    first: ${lines[i]}`, `    last:  ${lines[j - 1]}`]
    // 检查整段而非首行；中间的诊断不能因模板相似被删去。
    if (j - i >= config.minTemplateRepeats && templates[i] !== lines[i] && !run.some((line) => /error|failed|assert|exception/i.test(line) || isErrorLike(line)) && scoreReplacement(run.join("\n"), replacement.join("\n"), config).profitable) {
      out.push(...replacement)
      groups++
      i = j
      continue
    }
    // 已扫描运行一次消费，收益拒绝时也避免逐后缀重复扫描。
    while (i < j) out.push(lines[i++])
  }
  return { lines: out, groups }
}

function compressHighEntropyLines(lines: string[], config: CompressionConfig) {
  let groups = 0
  const next = lines.map((line) => {
    if (line.length < config.minHighEntropyLineLength) return line
    const frequency = new Map<string, number>()
    // 用 UTF-16 单元统一频率与分母；原字节大小仍由 byteLen 精确计算。
    for (let i = 0; i < line.length; i++) frequency.set(line[i], (frequency.get(line[i]) ?? 0) + 1)
    const entropy = [...frequency.values()].reduce((sum, count) => sum - count / line.length * Math.log2(count / line.length), 0)
    // 熵和空白必须同时满足源严格不等式，普通长诊断不能只凭长度被省略。
    if (entropy <= config.minEntropy || (line.match(/\s/g)?.length ?? 0) / line.length >= config.maxWhitespaceRatio) return line
    // 类型按具体到一般排序，hex 不会被通用 base64 判定抢走。
    const type = /^eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(line.trim()) ? "jwt"
      : /^data:image\/[^;]+;base64,/.test(line) ? "data-uri"
      : /^[0-9a-f]{64,}$/i.test(line.trim()) ? "hex-dump"
      : /^[A-Za-z0-9+/]+=*$/.test(line.trim()) ? "base64"
      : /^<Objs\b/.test(line.trim()) ? "powershell-clixml"
      : /^[{\[].*[}\]]$/.test(line.trim()) && line.length > 1000 ? "minified-json" : "unknown"
    // 首尾及哈希只读取已脱敏正文，不从 raw 重新截取样例。
    const replacement = `<high-entropy ${type} omitted: ${byteLen(line)} bytes, hash=${simpleHash(line)}, prefix=${JSON.stringify(line.slice(0, 20) + "...")}, suffix=${JSON.stringify("..." + line.slice(-20))}>`
    // 首尾样例与标签本身也计费，净增长摘要继续原样通过。
    if (!scoreReplacement(line, replacement, config).profitable) return line
    groups++
    return replacement
  })
  return { lines: next, groups }
}

function compressProgressBars(line: string, config: CompressionConfig) {
  // 线性专用模式先于通用嵌套扫描，单行仍只提交一次替换。
  for (const regex of [/([=\-#█▓▒░])\1{20,}/, /(\.)\1{20,}/, /([▁▂▃▄▅▆▇█])\1{10,}/]) {
    const match = regex.exec(line)
    if (!match) continue
    const replacement = `[bar ${match[0].length}x${quotePattern(match[1])}]`
    if (scoreReplacement(match[0], replacement, config).profitable) return { line: line.replace(match[0], replacement), applied: true }
  }
  return { line, applied: false }
}
function compressLongLists(line: string, config: CompressionConfig) {
  const items = line.split(/,\s*/)
  if (items.length < 10 || byteLen(line) < 200) return { line, applied: false }
  // 保留首尾各三项和省略数量，完整中段仍可从同一 raw archive 恢复。
  const replacement = [...items.slice(0, 3), `... (${items.length - 6} more)`, ...items.slice(-3)].join(", ")
  return scoreReplacement(line, replacement, config).profitable ? { line: replacement, applied: true } : { line, applied: false }
}

function normalizeTerminalOutput(text: string, config: CompressionConfig) {
  const lines = [""]
  let row = 0
  let col = 0
  let frames = 0
  let cells = 0
  // 光标参数受输入窗口长度约束，不能让短 CSI 分配巨大空行或空格。
  const position = (value: number) => Math.min(text.length, Math.max(0, value))
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (char === "\x1b") {
      const match = /^\x1b\[([0-9;?]*)([A-Za-z])/.exec(text.slice(i))
      // 未支持或不完整控制序列保留原文，不能无证据吞掉后面的日志。
      if (!match) return { text, groups: 0 }
      const nums = match[1].split(";").map((value) => Number.parseInt(value) || 0)
      const command = match[2]
      if (command === "A") row = position(row - (nums[0] || 1))
      else if (command === "B") row = position(row + (nums[0] || 1))
      else if (command === "C") col = position(col + (nums[0] || 1))
      else if (command === "D") col = position(col - (nums[0] || 1))
      else if (command === "G") col = position((nums[0] || 1) - 1)
      else if (command === "H" || command === "f") { row = position((nums[0] || 1) - 1); col = position((nums[1] || 1) - 1) }
      else if (command === "K") {
        const line = lines[row] ?? ""
        // 清行不移动光标，后续字符仍写在终端指定列。
        const replacement = nums[0] === 2 ? "" : nums[0] === 1 ? " ".repeat(col + 1) + line.slice(col + 1) : line.slice(0, col)
        cells += replacement.length - line.length
        if (cells > text.length * 2) return { text, groups: 0 }
        lines[row] = replacement
      } else if (command === "J" && (nums[0] === 2 || nums[0] === 3)) { lines.length = 0; cells = 0; row = 0; col = 0 }
      else if (command !== "m") return { text, groups: 0 }
      if (command !== "m") frames++
      i += match[0].length - 1
      continue
    }
    if (char === "\r") { col = 0; frames++; continue }
    if (char === "\n") { row = position(row + 1); col = 0; lines[row] ??= ""; continue }
    if (char === "\b") { col = position(col - 1); frames++; continue }
    const line = lines[row] ?? ""
    cells += Math.max(0, col + 1 - line.length)
    // 总单元限制覆盖多行远列写入，逐轴上限本身不能防止二维放大。
    if (cells > text.length * 2) return { text, groups: 0 }
    lines[row] = line.padEnd(col, " ").slice(0, col) + char + line.slice(col + 1)
    col = position(col + 1)
  }
  // 保留空行位置，不把普通日志的排版当作进度噪声丢掉。
  const stable = Array.from({ length: lines.length }, (_, i) => lines[i] ?? "").join("\n")
  const replacement = `... [terminal progress collapsed: ${frames} frames]\n${stable}`
  return frames >= config.minCarriageReturnFrames && scoreReplacement(text, replacement, config).profitable
    ? { text: replacement, groups: 1 } : { text, groups: 0 }
}

// 去掉 ANSI 控制字符。用于判断诊断行是否已出现在可见窗口中，避免颜色码导致重复附录。
function stripAnsi(text: string) {
  return text.replace(ANSI_GLOBAL_RE, "")
}

// 将空白差异归一化，降低 tail 截断、终端颜色、格式化空白导致的可见性误判。
function normalizeVisibleText(text: string) {
  return stripAnsi(text).replace(/\s+/g, " ").trim()
}

// 合并传入配置与默认配置
function configOf(config?: Partial<CompressionConfig>): CompressionConfig {
  // 部分覆盖保留其它策略的默认值，禁用不是另一套压缩实现。
  return { ...DEFAULT_COMPRESSION_CONFIG, ...config }
}

// 计算文本真实字节大小
function byteLen(text: string) {
  // ASCII 的字符数等于 UTF-8 字节数，可避免对大量普通日志重复编码。
  if (/^[\x00-\x7f]*$/.test(text)) return text.length
  // 非 ASCII 必须按实际编码计量，否则中文日志会虚报节省比例。
  return Buffer.byteLength(text, "utf-8")
}

// 评估一次替换带来的空间节省情况
function scoreReplacement(original: string | number, replacement: string, config: CompressionConfig): Score {
  const originalBytes = typeof original === "number" ? original : byteLen(original)
  // 替换标签也占字节，收益必须扣除它，短重复段不能只凭次数被替换。
  const replacementBytes = byteLen(replacement)
  const savedBytes = originalBytes - replacementBytes
  // 空输入的收益定义为零，不能产生 NaN 后污染 transcript 统计。
  const savingRatio = originalBytes > 0 ? savedBytes / originalBytes : 0

  return {
    originalBytes,
    replacementBytes,
    savedBytes,
    savingRatio,
    // 绝对收益与比例必须同时合格，大日志只省少量字节也不足以支持有损呈现。
    profitable: savedBytes >= config.minSavedBytes && savingRatio >= config.minSavingRatio,
  }
}

// 拼接字符串数组
function serializeLines(lines: string[]) {
  // 换行也是原始字节的一部分，块收益不能只累加各行正文长度。
  return lines.join("\n")
}

// 将长单行截断至指定字符数，并在末尾加上省略号
function truncateOneLine(text: string, maxChars: number) {
  // 仅附录做空白归一化；压缩主输出和磁盘原文不能经过这个格式化函数。
  const normalized = text.replace(/\s+/g, " ").trimEnd()
  if (normalized.length <= maxChars) return normalized
  return normalized.slice(0, Math.max(0, maxChars - 1)) + "…"
}

// 引号包裹被压缩的模式字符串，并对其进行转义处理（主要为了呈现给 LLM 看时更清晰）
function quotePattern(pattern: string, maxChars = 40) {
  // 标签中的引号和控制字符必须转义，避免被误读为日志的真实边界。
  let text = pattern
    .replaceAll("\\", "\\\\")
    .replaceAll("\t", "\\t")
    .replaceAll("\r", "\\r")
    .replaceAll('"', '\\"')

  if (text.length > maxChars) text = text.slice(0, maxChars - 1) + "…"
  // 只缩短标签中的模式示例，重复次数仍描述完整被替换区间。
  return `"${text}"`
}

// 判断行是否为空或仅含空白符
function isBlankLine(line: string) {
  // 空白通常携带排版结构，不能为了省 token 把整段空白当作重复日志折叠。
  return line.trim().length === 0
}

/**
 * 检查当前块是否存在更小的重复周期。
 * 避免选择只是较小周期的倍数的块宽度。
 * 示例:
 *   x
 *   y
 *   x
 *   y
 * 上面四行的基础周期是 2(x,y)，因此其 block 宽度应判定为 2，而不是直接当成一个宽度为 4 的无规律块。
 */
function hasSmallerLinePeriod(block: string[]) {
  // 最小周期让块摘要稳定，避免同一循环被报告为不同宽度的重复块。
  for (let width = 1; width <= Math.floor(block.length / 2); width++) {
    // 只能整除的情况才可能是完整的周期
    if (block.length % width !== 0) continue

    let ok = true
    for (let i = width; i < block.length; i++) {
      if (block[i] !== block[i % width]) {
        ok = false
        // 任一偏移不同就否定这个周期，不能用前缀相似替代精确相等。
        break
      }
    }
    if (ok) return true
  }
  return false
}

/**
 * 折叠回车符（CR \r）。
 * 进度条通常使用回车（CR）来重绘同一行。
 * 我们通过按行拆分后找 \r，将前面的绘制帧丢弃，只保留最后一帧，并记录折叠了多少次重绘。
 */
function collapseCarriageReturns(text: string, config: CompressionConfig): { text: string; groups: number } {
  // 只有编辑控制才进入虚拟终端；单纯颜色码仍遵守原有 ANSI guard。
  if (/\x1b\[[0-9;?]*[ABCDGHfKJ]|\x08/.test(text)) return normalizeTerminalOutput(text, config)
  // 普通 CR 路径保留既有逐行收益检查和最后帧语义。
  // 如果没有回车符直接短路返回
  if (!text.includes("\r")) return { text, groups: 0 }

  const lines = text.split("\n")
  let groups = 0
  let changed = false

  // LF 分隔不同逻辑行，CR 只在各行内部折叠，不能越过错误输出边界。
  const next = lines.map((line) => {
    if (!line.includes("\r")) return line

    // 以 \r 为分隔符拆分每一帧，忽略空帧
    const frames = line.split("\r").filter((frame) => frame.length > 0)
    // CRLF 尾部的空帧不代表一次有内容的更新，不能抬高折叠次数。
    // 帧数不够阈值就不折叠
    if (frames.length < config.minCarriageReturnFrames) return line

    // 最后一帧是终态，折叠时保留它而非最早的进度百分比。
    const last = frames[frames.length - 1] ?? ""
    // 原始输出另行保留，模型在需要中间帧时必须能读取完整日志。
    // 插入一条说明，告诉 LLM 这里折叠了多少帧
    const replacement = `... [carriage-return progress updates collapsed: ${frames.length - 1} frames]\n${last}`
    
    // 检查这个替换操作是否划算（有些短帧折叠后可能反而体积变大）
    const score = scoreReplacement(line, replacement, config)
    if (!score.profitable) return line

    groups++
    changed = true
    // 只有真正采用收益合格的替换才统计命中，扫描到 CR 不等于压缩成功。
    return replacement
  })

  // 如果有改变则拼接回去
  return { text: changed ? next.join("\n") : text, groups }
}

// 在给定的起始索引处寻找最划算的连续重复多行块
function findRepeatedBlockAt(lines: string[], start: number, config: CompressionConfig, bytes: number[], matches: Map<number, Uint32Array>, hashes: string[]): BlockCandidate | undefined {
  const remaining = lines.length - start
  let best: BlockCandidate | undefined

  // 块宽受扫描成本和剩余行能容纳的最小重复次数约束，避免越界；它不限制原始日志保留长度。
  const maxWidth = Math.min(config.maxBlockLines, Math.floor(remaining / config.minBlockRepeats))
  
  // 逐一尝试不同的块宽度
  for (let width = 2; width <= maxWidth; width++) {
    const block = lines.slice(start, start + width)
    // 忽略全空行的块
    if (block.every(isBlankLine)) continue
    // 同一行组成的块交给单行策略，其次数与标签语义不同，块策略不能先抢走输入。
    if (new Set(block).size <= 1) continue
    // 忽略本身具有更小重复周期的块
    if (hasSmallerLinePeriod(block)) continue

    // 同宽逐行相等的后缀长度只计算一次，收益被拒绝也不重扫整段日志。
    const equal = matches.get(width) ?? new Uint32Array(lines.length + 1)
    if (!matches.has(width)) {
      for (let i = lines.length - width - 1; i >= 0; i--)
        // 摘要哈希只作快速否定，碰撞时仍须完整字符串相等才计重复，保留线性后缀缓存。
        equal[i] = hashes[i] === hashes[i + width] && lines[i] === lines[i + width] ? equal[i + 1] + 1 : 0
      matches.set(width, equal)
    }
    // 每满 width 个相等位置才是一整块；余下半块不能算作重复。
    const repeats = 1 + Math.floor(equal[start] / width)

    // 未达到重复证据要求时保持原样，不拼接残缺的块说明。
    if (repeats < config.minBlockRepeats) continue

    // 最后一次重复也计入原始范围，否则收益会漏算被删除的字节。
    const originalBytes = bytes[start + width * repeats] - bytes[start] - 1
    // 替换内容：只留第一遍块，然后加上总结语
    const replacementLines = [
      ...block,
      `... [previous ${width} lines repeated ${repeats - 1} more times]`,
    ]

    // 评估是否划算
    const score = scoreReplacement(originalBytes, serializeLines(replacementLines), config)
    if (!score.profitable) continue

    const candidate: BlockCandidate = {
      width,
      repeats,
      replacementLines,
      consumedLines: width * repeats,
      score,
    }

    // 贪婪选择：找出能节省最多绝对字节数的方案
    if (!best || candidate.score.savedBytes > best.score.savedBytes) {
      // 平收益保留先找到的窄块，使输出稳定并减少标签解释成本。
      best = candidate
    }
  }

  return best
}

// 从上到下扫描所有行，应用多行块压缩
function compressRepeatedBlocks(lines: string[], config: CompressionConfig): { lines: string[]; groups: number } {
  const out: string[] = []
  // 前缀计入每行 UTF-8 字节和 LF，候选区间减去末尾一个 LF 与 join 完全一致。
  const bytes = [0]
  for (const line of lines) bytes.push(bytes[bytes.length - 1] + byteLen(line) + 1)
  // 缓存仅属于本次输入和实际检查的块宽，不跨命令持有日志或改变候选顺序。
  const matches = new Map<number, Uint32Array>()
  // 每行哈希只算一次，不恢复源逐起点反复扫描整个重复后缀的退化。
  const hashes = lines.map(simpleHash)
  let groups = 0
  let i = 0

  while (i < lines.length) {
    // 尝试在当前 i 位置找到一个可折叠的多行块
    const candidate = findRepeatedBlockAt(lines, i, config, bytes, matches, hashes)
    if (!candidate) {
      // 没有合格候选只消费一行，后面的起点仍有机会发现真正重复。
      out.push(lines[i])
      i++
      continue
    }

    // 找到了，塞入替换行并跳过已经消耗的行数
    out.push(...candidate.replacementLines)
    groups++
    // 已替换区间不会二次扫描，避免摘要标签成为后续块匹配的输入。
    i += candidate.consumedLines
  }

  return { lines: out, groups }
}

// 压缩连续相同的单行
function compressSameLines(lines: string[], config: CompressionConfig): { lines: string[]; groups: number } {
  const out: string[] = []
  let groups = 0
  let i = 0

  while (i < lines.length) {
    const line = lines[i]
    let j = i + 1

    // 只扫描相邻且完全相等的运行，分散重复不能跨过中间状态变化。
    while (j < lines.length && lines[j] === line) j++

    const count = j - i
    // 如果达到了阈值且不是纯空白行
    if (count >= config.minSameLineRepeats && !isBlankLine(line)) {
      const originalLines = lines.slice(i, j)
      const replacementLines = [line, `... [same line repeated ${count - 1} more times]`]
      const score = scoreReplacement(serializeLines(originalLines), serializeLines(replacementLines), config)

      // 只有省下了足够字节才应用
      if (score.profitable) {
        // 记录次数前先验证标签净收益，重复很多短行也可能不值得压缩。
        out.push(...replacementLines)
        groups++
        i = j
        continue
      }
    }

    // 已扫描运行逐行消费一次，拒绝收益也不重扫后缀；保留原序和副本数并避免大运行 spread 超过参数上限。
    while (i < j) out.push(lines[i++])
  }

  return { lines: out, groups }
}

// 表示一次行内压缩的候选匹配
type InlineCandidate = {
  start: number           // 在原始字符串中的起点
  end: number             // 在原始字符串中的终点
  replacement: string     // 用于替换的短语
  savedBytes: number      // 节省了多少字节
}

/**
 * 保守的行内模式压缩。
 * 在此版本中，有意跳过包含 ANSI 控制字符的行和过长的行。
 * 主要解决诸如打印大量 "#" 或是 ".........." 的问题。
 */
function compressInlineLine(line: string, config: CompressionConfig): { line: string; applied: boolean } {
  // 如果行本身太短，没必要跑正则扫描
  if (line.length < config.minInlineRunBytes) return { line, applied: false }
  // 超长行原样通过以约束嵌套扫描 CPU 成本，不能切段压缩绕过单行上限。
  if (line.length > config.maxInlineLineLength) return { line, applied: false }
  // 不处理带有 ANSI 转义序列的行（通常含有颜色代码，强行切割会破坏终端样式）
  if (ANSI_RE.test(line)) return { line, applied: false }

  let best: InlineCandidate | undefined
  // 最大模式长度不能超过配置值，也不能超过整行被重复要求的最低倍数能分的份数
  const maxPattern = Math.min(config.maxInlinePatternLength, Math.floor(line.length / config.minInlineRepeatCount))

  for (let start = 0; start < line.length; start++) {
    // 候选只匹配同一行的相邻模式，不能跨换行改变命令输出结构。
    for (let width = 1; width <= maxPattern; width++) {
      // 提早退出：如果剩下的长度都不足以放下最小重复次数
      if (start + width * config.minInlineRepeatCount > line.length) break

      const pattern = line.slice(start, start + width)
      // 空白模式可能携带对齐结构，没有足够正文重复证据时不做有损摘要。
      if (!pattern.trim()) continue

      let repeats = 1
      let cursor = start + width
      // 一直往后匹配相同的模式
      while (cursor + width <= line.length && line.startsWith(pattern, cursor)) {
        repeats++
        cursor += width
      }

      // 未达到最低重复次数要求
      if (repeats < config.minInlineRepeatCount) continue

      const original = line.slice(start, start + width * repeats)
      // 收益只评估被替换区间，前后未修改的内容不会虚增压缩比例。
      // 如果总被替换的这段字符长度本身就不够阈值，跳过
      if (byteLen(original) < config.minInlineRunBytes) continue

      // 替换文案，明确指出是什么模式重复了多少次
      const replacement = `[repeated ${quotePattern(pattern)} ×${repeats}]`
      const score = scoreReplacement(original, replacement, config)
      if (!score.profitable) continue

      // 选择能够节省最多字节的那个区间
      if (!best || score.savedBytes > best.savedBytes) {
        best = {
          start,
          end: start + width * repeats,
          replacement,
          savedBytes: score.savedBytes,
        }
      }
    }
  }

  // 每行最多应用一个最划算区间，避免新标签被当作真实日志再次压缩。
  if (!best) return { line, applied: false }

  // 拼接：替换前半段 + 替换标签 + 替换后半段
  return {
    line: line.slice(0, best.start) + best.replacement + line.slice(best.end),
    applied: true,
  }
}

// 遍历每一行执行行内压缩
function compressInlinePatterns(lines: string[], config: CompressionConfig): { lines: string[]; groups: number } {
  let groups = 0
  const next = lines.map((line) => {
    // 专用行内策略也遵守源 ANSI 与长度保护，不以新策略绕过 CPU 上限。
    if (ANSI_RE.test(line) || line.length > config.maxInlineLineLength) return line
    const bar = compressProgressBars(line, config)
    const list = bar.applied ? bar : compressLongLists(line, config)
    const result = list.applied ? list : compressInlineLine(line, config)
    if (result.applied) groups++
    // 未命中的行保留原位置，行内策略不会重新排序块压缩后的日志。
    return result.line
  })

  return { lines: next, groups }
}

// 粗略判断这段文本是否值得送进压缩流程，避免对很小的输出浪费 CPU
export function shouldCompressOutput(text: string) {
  // 预筛只省扫描成本，真正收益仍由每个策略按替换标签逐次验证。
  if (!text) return false
  if (byteLen(text) < 200) return false

  // 带回车的进度刷新输出高度可压缩，优先进入压缩流程。
  if (text.includes("\r")) return true

  // 多行日志值得扫描重复行和重复块。
  let newlines = 0
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) newlines++ // 10 是 \n
    if (newlines >= 5) return true
  }

  // 长单行输出可能包含明显的行内重复模式，例如 abcabcabc...。
  return text.length >= DEFAULT_COMPRESSION_CONFIG.minInlineRunBytes
}

// 保留源 CLIXML 节点提取与转义规则，ANSI 清洗复用现有实现。
function transformPowerShellClixml(text: string) {
  const trimmed = text.trimStart()
  if (!trimmed.startsWith("<Objs") && !/^[\s\S]*<Objs\b/.test(trimmed)) return null
  const decoded = /<S\s+S="[^"]*">([^<]*)<\/S>/gi
  const parts: string[] = []
  let match: RegExpExecArray | null
  while ((match = decoded.exec(text)) !== null) {
    parts.push(match[1].replace(/_x([0-9A-Fa-f]{4,})_/g, (_, hex) => String.fromCharCode(parseInt(hex, 16))))
  }
  if (parts.length === 0) return null
  const plain = stripAnsi(parts.join("")).replace(/\r\n/g, "\n").trimEnd()
  if (!plain) return null
  return `<high-entropy powershell-clixml>${plain}</high-entropy>`
}

/**
 * 主入口：压缩传入的可见文本，返回压缩后的文本以及详细的统计信息
 */
export function compressVisibleOutput(text: string, configInput?: Partial<CompressionConfig>, command = ""): CompressResult {
  const config = configOf(configInput)
  const originalBytes = byteLen(text)

  const emptyStats: CompressionStats = {
    // 绕过时仍报告窗口原始大小，调用者无需为禁用路径另建统计算法。
    originalBytes,
    compressedBytes: originalBytes,
    savedBytes: 0,
    savingRatio: 0,
    carriageReturnGroups: 0,
    repeatedBlockGroups: 0,
    repeatedLineGroups: 0,
    inlinePatternGroups: 0,
    templateGroups: 0,
    highEntropyLines: 0,
    secretsRedacted: 0,
    applied: false,
  }

  // 源 opt-out 保持逐字原样；启用后脱敏不受长度预筛或压缩收益支配。
  if (!config.enabled) return { text, stats: emptyStats }
  // VT可能把ANSI分隔的片段重组成密钥；规范化完成后只执行一次canonical脱敏。
  // CLIXML 解码属于呈现规范化，收益门槛只约束后续可选压缩。
  const clixml = transformPowerShellClixml(text)
  const cr = collapseCarriageReturns(clixml ?? text, config)
  const redaction = redactSecrets(cr.text)
  const redactedBytes = byteLen(redaction.text)
  // 短终态仍报告已提交的VT收益，独立脱敏不会被后续noapply回退撤销。
  const redactedStats = { ...emptyStats, carriageReturnGroups: cr.groups, highEntropyLines: clixml ? 1 : 0,
    applied: (clixml !== null || cr.groups > 0) && redactedBytes < originalBytes,
    compressedBytes: redactedBytes, savedBytes: originalBytes - redactedBytes,
    savingRatio: originalBytes ? (originalBytes - redactedBytes) / originalBytes : 0, secretsRedacted: redaction.redacted }
  if (!shouldCompressOutput(redaction.text)) return { text: redaction.text, stats: redactedStats }

  let lines = redaction.text.split("\n")
  // 模板在精确重复之前识别，但首尾实际样例仍保持脱敏后的文本。
  const template = compressTemplateRuns(lines, config)
  lines = template.lines

  // 多行块先于单行摘要，保留完整循环样例以表达事件顺序。
  const blocks = compressRepeatedBlocks(lines, config)
  lines = blocks.lines

  // 第三步：压缩单行连续重复
  const same = compressSameLines(lines, config)
  lines = same.lines

  // 高熵先行，避免对 base64 长行做无效的通用模式扫描。
  const highEntropy = compressHighEntropyLines(lines, config)
  lines = highEntropy.lines
  // 行内摘要最后运行，避免先改正文导致原本完全相同的块不再匹配。
  const inline = compressInlinePatterns(lines, config)
  lines = inline.lines

  // 四个适配器由真实调用 command 选择，纯转换不创建任何执行或存储 owner。
  const compressed = applyCommandAdapter(command, lines.join("\n"), config)
  const compressedBytes = byteLen(compressed)
  // 最终重新按编码字节计量，不能把多个局部收益简单相加作为总比例。
  const savedBytes = originalBytes - compressedBytes
  const savingRatio = originalBytes > 0 ? savedBytes / originalBytes : 0

  // 生成统计报告
  const stats: CompressionStats = {
    originalBytes,
    compressedBytes,
    savedBytes,
    savingRatio,
    carriageReturnGroups: cr.groups,
    repeatedBlockGroups: blocks.groups,
    repeatedLineGroups: same.groups,
    inlinePatternGroups: inline.groups,
    templateGroups: template.groups,
    highEntropyLines: highEntropy.groups + (clixml ? 1 : 0),
    secretsRedacted: redaction.redacted,
    applied:
      compressedBytes < originalBytes &&
      (clixml !== null || cr.groups > 0 || blocks.groups > 0 || same.groups > 0 || template.groups > 0 || highEntropy.groups > 0 || inline.groups > 0 || compressed !== lines.join("\n")),
  }

  return {
    // 压缩未提交只退回脱敏正文；即使掩码变长也不能恢复秘密。
    text: stats.applied ? compressed : redaction.text,
    stats: stats.applied ? stats : redactedStats,
  }
}

/**
 * 用于保存历史行记录的一个简单环形队列（固定最大长度）
 */
class Ring<T> {
  private items: T[] = []

  constructor(private readonly max: number) {}

  push(item: T) {
    if (this.max <= 0) return
    this.items.push(item)
    // 超过容量时从头部移出
    while (this.items.length > this.max) this.items.shift()
  }

  values() {
    // 返回副本防止上下文合并排序修改采集器的历史顺序。
    return [...this.items]
  }

  clear() {
    this.items = []
  }
}

// 在提取诊断上下文时的“活跃上下文”结构
type ActiveContext = {
  centerLine: number          // 命中的关键错误行行号
  lines: LineRecord[]         // 包含前面的行和后文收集的行
  remainingAfter: number      // 还需要收集多少后文行才算完成
  // 序号记录准入顺序，与后文半径、chunk 分片、end 封存时机无关。
  ordinal: number
  priority: DiagnosticContext["priority"]
}

// 判定是否是类似报错行
function isErrorLike(line: string) {
  // 强错误优先于健康计数，不能把同帧 panic 或真实类型错误视为成功。
  if (FATAL_LIKE_RE.test(line) || COMPILE_ERROR_RE.test(line) || INFRA_ERROR_RE.test(line)) return true
  if (HEALTHY_INDICATOR_RE.test(line)) return false
  // 零错误计数只抑制普通错误词，同帧 traceback、panic 等强信号仍须保留。
  if (ZERO_PROBLEM_RE.test(line) && !FATAL_LIKE_RE.test(line)) return false
  // 注释、示例与日志等级说明只排除弱 error 字样，不抑制真实强信号。
  if (/^\s*(#|\/\/|\/\*|\*).*error/i.test(line) || /^(?:example|sample|demo)\b|test.*should.*error|log.*level.*error|error.*level/i.test(line)) return false
  return ERROR_LIKE_RE.test(line)
}

// 判定是否是类似警告行
function isWarningLike(line: string) {
  // 健康摘要不制造警告频率，致命关键词仍保留原有例外。
  if (HEALTHY_INDICATOR_RE.test(line) && !FATAL_LIKE_RE.test(line)) return false
  // 健康计数行可以带 warning 字样，不能因此制造虚假诊断频率。
  if (ZERO_PROBLEM_RE.test(line) && !FATAL_LIKE_RE.test(line)) return false
  return WARNING_LIKE_RE.test(line)
}

// 判定是否是包含栈追踪、断言失败等强烈致死关键词的行
function isFatalLike(line: string) {
  return FATAL_LIKE_RE.test(line)
}

function scoreErrorLine(text: string) {
  // 保留源分级，但 admission 已先经过健康/说明过滤，不再用评分绕过过滤。
  if (FATAL_LIKE_RE.test(text)) return 100
  if (COMPILE_ERROR_RE.test(text)) return 80
  if (INFRA_ERROR_RE.test(text)) return 70
  if (ERROR_LIKE_RE.test(text)) return 60
  if (WARNING_LIKE_RE.test(text)) return 30
  return 0
}

/**
 * 流式诊断信息收集器。
 *
 * 它以极小的内存占用模式工作：
 *   - 前几行信息的一个小型环形缓冲区 (prev)
 *   - 少数处于活跃状态、正在等待后续错误上下文的块 (active)
 *   - 最终提取完的 N 个报错上下文 (contexts)
 *
 * 它不需要把整个几十兆的文件都放到内存，而是顺着 chunk 分片一边看一边丢掉正常日志。
 */
export class BashDiagnosticCollector {
  private pending = ""        // 分片读取拼接用的残余文本缓冲
  private discardedChars = 0
  private truncatedFrames = 0
  private frameDiscarded = 0
  private afterCR = false
  private lineNo = 0          // 绝对行号计数器
  private prev: Ring<LineRecord>  // 保存最近遍历过的上文（比如当前行的前 3 行）
  // 固定首批不可滚动；其余两队列继续使用既有有界 Ring。
  private contextsFirst: DiagnosticContext[] = []
  private contextsFatal = new Ring<DiagnosticContext>(5)
  private contextsRecent: Ring<DiagnosticContext>
  private redactingPrivateKey = false
  private pendingCredential = ""
  private active: ActiveContext[] = [] // 当前正在等待“后文”的上下文列表

  private errorCount = 0      // 出现报错关键词的行数
  private warningCount = 0    // 出现警告关键词的行数
  private fatalCount = 0      // 出现致命错误的行数

  private readonly config: CompressionConfig

  constructor(configInput?: Partial<CompressionConfig>) {
    this.config = configOf(configInput)
    // 上文环形队列的长度为配置的半径
    this.prev = new Ring<LineRecord>(this.config.diagnosticContextRadius)
    // recent 至少五个，首批与 fatal 容量不随日志总量增长。
    this.contextsRecent = new Ring<DiagnosticContext>(Math.max(this.config.maxDiagnosticContexts, 5))
  }

  // 接收从控制台流中涌来的 chunk 字符串
  push(chunk: string) {
    if (!chunk) return

    // 逐字符扫描真实 chunk，不把整块追加到 pending 后才尝试截断。
    for (let i = 0; i < chunk.length; i++) {
      const char = chunk[i]
      // 跨 chunk 的 CRLF 仍是一个分隔符；单独 CR 则结束一次进度重绘帧。
      if (char === "\n" && this.afterCR) {
        this.afterCR = false
        continue
      }
      this.afterCR = char === "\r"
      if (char === "\r" || char === "\n") {
        this.flushFrame()
        continue
      }
      // 超长帧只采样前缀，后续字节由原始日志保留；遗漏必须显式报告。
      if (this.pending.length < MAX_DIAGNOSTIC_FRAME_CHARS) this.pending += char
      else this.frameDiscarded++
    }
  }

  // 命令结束时收尾，把残余缓冲里的最后半行消化掉
  end() {
    if (this.pending.length > 0 || this.frameDiscarded > 0) this.flushFrame()

    // 强行关闭所有还处于 active 等待后文状态的上下文
    for (const ctx of this.active) this.finalizeContext(ctx)
    this.active = []
  }

  // 生成最终快照，返回合并、去重之后的最近 N 个诊断上下文块
  snapshot(): DiagnosticSnapshot {
    // 合并使用副本，重复 snapshot 不得修改首批中心或跨队列共享对象。
    const firstErrorContexts = this.mergeContexts(this.contextsFirst)
    const fatalContexts = this.mergeContexts(this.contextsFatal.values())
    const recentErrorContexts = this.mergeContexts(this.contextsRecent.values())
    return {
      totalLines: this.lineNo,
      errorLikeLines: this.errorCount,
      warningLikeLines: this.warningCount,
      fatalLikeLines: this.fatalCount,
      discardedChars: this.discardedChars,
      truncatedFrames: this.truncatedFrames,
      // 通用 contexts 保留合并视图；附录从三队列按优先级选择而非最后 N 个。
      contexts: this.mergeContexts([...firstErrorContexts, ...fatalContexts, ...recentErrorContexts]).slice(-this.config.maxDiagnosticContexts),
      firstErrorContexts,
      fatalContexts,
      recentErrorContexts,
    }
  }

  // 核心处理单行的逻辑
  private flushFrame() {
    if (this.frameDiscarded > 0) {
      this.discardedChars += this.frameDiscarded
      this.truncatedFrames++
    }
    // 截断标记属于诊断样例，不写回原文，也不把遗漏段伪装成完整诊断。
    // 采样标记属于呈现，不能在canonical续接中被当成真实凭据值而清掉标签。
    this.observeLine(this.pending)
    this.pending = ""
    this.frameDiscarded = 0
  }

  private observeLine(text: string) {
    // 私钥跨帧携带状态，错误邻域即使不含 BEGIN 标题也不能展示其正文。
    const normalized = this.config.enabled ? collapseCarriageReturns(text, this.config).text : text
    const privateKey = this.config.enabled && (this.redactingPrivateKey || /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(stripAnsi(normalized)))
    this.redactingPrivateKey = privateKey && !/-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(stripAnsi(normalized))
    // 诊断与正文遵守同一规范化后脱敏契约，分类与raw字节仍读取原始帧。
    const prefix = this.pendingCredential
    const redaction = this.config.enabled ? redactSecrets(prefix + normalized) : { text: normalized, continuation: "" }
    // 一个短前缀覆盖标签落在prev邻域外的值帧，不积累空白或另建上下文队列。
    this.pendingCredential = redaction.continuation ? redaction.continuation + "\n" : ""
    const record: LineRecord = { no: this.lineNo + 1, text: (privateKey ? "<REDACTED_PRIVATE-KEY>"
      : prefix ? redaction.text.slice(redaction.text.indexOf("\n") + 1) : redaction.text) + (this.frameDiscarded > 0 ? " [diagnostic frame sampled]" : "") }

    const stillActive: ActiveContext[] = []
    // 遍历所有正处在活跃收集状态的上下文
    for (const ctx of this.active) {
      // 若当前行确实位于其目标中心行之后且还需要收集
      if (record.no > ctx.centerLine && ctx.remainingAfter > 0) {
        ctx.lines.push(record)
        ctx.remainingAfter--
      }

      // 如果这个上下文后文也收集满了，则转为最终态
      if (ctx.remainingAfter <= 0) this.finalizeContext(ctx)
      // 否则继续放入 active 中等下一行
      else stillActive.push(ctx)
    }
    // 每帧推进所有邻域，连续错误的活跃数量受半径约束，不随日志总量增长。
    this.active = stillActive

    // 统计各种警示关键词出现的频率
    if (isWarningLike(text)) this.warningCount++

    if (isErrorLike(text)) {
      this.errorCount++
      if (isFatalLike(text)) this.fatalCount++

      // 当前行是一个报错，新建一个等待捕获后文的活跃上下文
      const ctx: ActiveContext = {
        centerLine: record.no,
        // 前三次准入在此冻结，后续 burst 不能在 seal 时将它们降为 recent。
        ordinal: this.errorCount,
        priority: scoreErrorLine(text) >= 100 ? "fatal" : this.errorCount <= 3 ? "first" : "recent",
        // 上文和当前帧均已在分帧阶段有界，邻域副本不能藏入未截断长行。
        lines: [...this.prev.values(), record],
        // 设置还需要收集多少个后文行
        remainingAfter: this.config.diagnosticContextRadius,
      }

      // 特殊情况：半径配了 0，直接结束收集
      if (ctx.remainingAfter <= 0) this.finalizeContext(ctx)
      else this.active.push(ctx)
    } else if (isFatalLike(text)) {
      // 即使没明确报 Error 关键词，如果有致命错误也进行统计
      this.fatalCount++
    }

    // 普通帧只留在前文环中供后续错误定位，完整恢复由调用方原始日志存储承担。
    this.prev.push(record)
    this.lineNo++
  }

  // 将收集完上文下文的活跃块封存到结果池中
  private finalizeContext(ctx: ActiveContext) {
    const diagnostic: DiagnosticContext = {
      centerLine: ctx.centerLine,
      lines: ctx.lines,
      priority: ctx.priority,
      centerLines: [ctx.centerLine],
    }
    // fatal 可以同时属于 first；队列归属读取准入序号，不读取当前 errorCount。
    if (ctx.ordinal <= 3) this.contextsFirst.push(diagnostic)
    if (ctx.priority === "fatal") this.contextsFatal.push(diagnostic)
    this.contextsRecent.push(diagnostic)
  }

  // 合并重叠上下文：比如行号 10 报错，保留了 7~13；紧接着 12 又报错，保留了 9~15，
  // 它们就会交织在一起。这个方法把它们无缝拼成一个 7~15 的大块。
  private mergeContexts(contexts: DiagnosticContext[]) {
    const copies = contexts.map((ctx) => ({ ...ctx, lines: [...ctx.lines], centerLines: [...ctx.centerLines] }))
    if (copies.length <= 1) return copies
    // 合并仅处理有限结果环的副本，不能把所有历史错误累积到结束时再去重。

    // 按照行号升序排列
    const sorted = copies.sort((a, b) => {
      const aStart = a.lines[0]?.no ?? a.centerLine
      const bStart = b.lines[0]?.no ?? b.centerLine
      return aStart - bStart
    })

    const out: DiagnosticContext[] = []
    for (const ctx of sorted) {
      const last = out[out.length - 1]
      // 第一个元素直接放入
      if (!last) {
        out.push(ctx)
        continue
      }

      // 获取上一块最末尾行的行号和当前块开头的行号
      const lastEnd = last.lines[last.lines.length - 1]?.no ?? last.centerLine
      const thisStart = ctx.lines[0]?.no ?? ctx.centerLine

      // 如果它们存在交集或是正好紧挨着，进行合并
      if (thisStart <= lastEnd + 1) {
        // 以帧号去重而非正文去重，相同错误在不同时间出现仍是不同事件。
        const byNo = new Map<number, LineRecord>()
        for (const line of last.lines) byNo.set(line.no, line)
        for (const line of ctx.lines) byNo.set(line.no, line)

        // 生成合并去重后的新行集合
        last.lines = [...byNo.values()].sort((a, b) => a.no - b.no)
        // 保留更靠后的中心点
        // 重叠时保持较强优先级，不能让后来的普通错误覆盖根因标签。
        last.priority = last.priority === "first" || ctx.priority === "first" ? "first" : last.priority === "fatal" || ctx.priority === "fatal" ? "fatal" : "recent"
        last.centerLines = [...new Set([...last.centerLines, ...ctx.centerLines])]
        last.centerLine = ctx.centerLine
      } else {
        // 如果断开了，作为新的独立块压入
        out.push(ctx)
      }
    }

    return out
  }
}

// 检查某个提取出来的错误上下文是否实际上已经存在于给 LLM 可见的输出 (visibleOutput) 当中。
// 为了防止输出本就很短时还在尾部把错误内容重复打两遍，浪费 token 还会干扰模型。
function contextAlreadyVisible(ctx: DiagnosticContext, visibleOutput: string, config: CompressionConfig) {
  // 所有准入中心都可见才省略合并块，最新错误不能遮住同块较早的根因。
  return ctx.centerLines.every((centerLine) => {
    const center = ctx.lines.find((line) => line.no === centerLine)
    if (!center) return false

    // 与正文相同的 enabled 与掩码，比较之前脱敏，截短之前也脱敏。
    const rawCenter = config.enabled ? redactSecrets(center.text).text : center.text
    const truncatedCenter = truncateOneLine(rawCenter, config.diagnosticLineMaxChars)
    const visibleNorm = normalizeVisibleText(visibleOutput)
    const rawNorm = normalizeVisibleText(rawCenter)
    const truncatedNorm = normalizeVisibleText(truncatedCenter)
    // 只看中心帧能避免整块空白或公共前文造成错误已可见的误判。
    if (!rawNorm && !truncatedNorm) return false

    // 原文匹配优先，归一化匹配兜底，避免 ANSI、空白折叠或诊断行截断造成重复附录。
    return (
      visibleOutput.includes(rawCenter) ||
      visibleOutput.includes(truncatedCenter) ||
      visibleNorm.includes(rawNorm) ||
      visibleNorm.includes(truncatedNorm)
    )
  })
}

// 将错误上下文集合格式化为字符串，方便追加到最后的 Bash 输出中
function renderDiagnosticContexts(contexts: DiagnosticContext[], config: CompressionConfig) {
  const out: string[] = []
  out.push("<bash_high_signal_excerpt>")
  out.push("Error contexts not fully visible above:")

  for (const ctx of contexts) {
    const first = ctx.lines[0]?.no ?? ctx.centerLine
    const last = ctx.lines[ctx.lines.length - 1]?.no ?? ctx.centerLine
    out.push("")
    // 根因与 fatal 标签说明保留理由，不把诊断帧号冒充磁盘 LF 行号。
    out.push(`[L${first}-L${last}]${ctx.priority === "first" ? " (root cause)" : ctx.priority === "fatal" ? " (fatal)" : ""}`)
    // L 表示诊断帧序号；含 CR 的原始文件不能据此当作 LF 行范围直接定位。

    for (const line of ctx.lines) {
      // 对于命中的那一核心行，使用 > 进行强调
      const marker = ctx.centerLines.includes(line.no) ? ">" : " "
      // 诊断是 raw 的另一出口；必须先掩码后截短，避免留下部分凭据。
      const masked = config.enabled ? redactSecrets(line.text).text : line.text
      out.push(`${marker} ${line.no} | ${truncateOneLine(masked, config.diagnosticLineMaxChars)}`)
    }
  }

  out.push("</bash_high_signal_excerpt>")
  return out.join("\n")
}

/**
 * 组装并渲染完整的诊断附录（Appendix），作为 Bash 输出结尾的后缀。
 * 只返回当前可见输出中没有出现的高信号错误上下文。
 */
export function renderDiagnosticAppendix(snapshot: DiagnosticSnapshot, options: RenderAppendixOptions) {
  const config = configOf(options.config)

  // 判断命令执行的时间和退出状态是否值得附带高价值摘录
  const longEnough = options.durationMs >= config.diagnosticMinRuntimeMs
  // null 表示未正常结束，长命令被中断时仍可呈现已采到的错误线索。
  const abnormalExit = options.exitCode !== 0
  const hasStrongSignal = snapshot.fatalLikeLines > 0 || snapshot.errorLikeLines > 0

  const shouldShowDiagnostics = longEnough && hasStrongSignal && (abnormalExit || snapshot.fatalLikeLines > 0)

  // first > fatal > recent；只对隐藏中心去重，最近队列不能覆盖首批标签。
  const candidates = [...snapshot.firstErrorContexts, ...snapshot.fatalContexts, ...snapshot.recentErrorContexts]
  const seen = new Set<number>()
  const hiddenContexts = shouldShowDiagnostics
    ? candidates.filter((ctx) => {
        if (seen.has(ctx.centerLine) || contextAlreadyVisible(ctx, options.visibleOutput, config)) return false
        seen.add(ctx.centerLine)
        return true
      }).slice(0, Math.max(0, config.maxDiagnosticContexts))
    : []

  const parts: string[] = []
  // 采样遗漏不受运行时长或退出码隐藏，否则成功的长行会被误报为完整观察。
  if (snapshot.discardedChars > 0)
    parts.push(`[diagnostic sampling omitted ${snapshot.discardedChars} characters across ${snapshot.truncatedFrames} frames; inspect the retained raw output for complete diagnostics; L labels are frame ordinals]`)

  // 拼接筛选后有效的报错上下文
  if (hiddenContexts.length > 0) {
    parts.push(renderDiagnosticContexts(hiddenContexts, config))
  }

  return parts.join("\n\n")
}

/**
 * 组装压缩相关的数据统计用于返回在最终命令的工具元数据内
 */
export function bashCompressionMetadata(stats: CompressionStats) {
  // 只输出可序列化标量，V1 metadata 与 Core structured transcript 共用同一含义。
  return {
    compressed: stats.applied,
    compressionOriginalBytes: stats.originalBytes,
    compressionCompressedBytes: stats.compressedBytes,
    compressionSavedBytes: stats.savedBytes,
    compressionSavingRatio: stats.savingRatio,
    compressionCarriageReturnGroups: stats.carriageReturnGroups,
    compressionRepeatedBlockGroups: stats.repeatedBlockGroups,
    compressionRepeatedLineGroups: stats.repeatedLineGroups,
    compressionInlinePatternGroups: stats.inlinePatternGroups,
    compressionTemplateGroups: stats.templateGroups,
    compressionHighEntropyLines: stats.highEntropyLines,
    // compressed 仍只表示净压缩，独立计数驱动脱敏后的 raw 保留。
    compressionSecretsRedacted: stats.secretsRedacted,
  }
}
