/**
 * 用于优化大模型上下文的 Bash 输出压缩器（增强版）。
 *
 * 设计思路:
 *   1. Secret Redaction - 脱敏敏感信息（API key、JWT、密码等）
 *   2. 虚拟终端渲染 - 处理 ANSI 控制序列和回车进度条
 *   3. 模板化近重复压缩 - 压缩时间戳/UUID/哈希不同但模式相同的行
 *   4. 多行块重复压缩 - 压缩循环打印的多行日志块
 *   5. 单行重复压缩 - 压缩连续相同的行
 *   6. 高熵长行压缩 - 压缩 base64/JWT/minified JSON 等高熵内容
 *   7. 行内模式压缩 - 压缩进度条、长列表等行内重复
 *   8. 命令适配器 - 针对 npm/pytest/docker/tsc 等工具的特定优化
 *   9. 双队列诊断收集 - 保留 first/fatal/recent 错误上下文
 *
 * 安全性:
 *   - 每次替换必须证明它节省了足够的字节，避免为了压缩而压缩，导致信息丢失却没省下空间。
 *   - 替换是贪婪执行的，从上到下。
 *   - 跨行压缩在行内压缩之前运行，保证大块的重复优先被处理。
 *   - BashTool 的截断文件路径应当仍然保留完整的原始输出，以便用户或模型后续可以查看完整日志。
 */

// ==================== 命令适配器接口 ====================

/**
 * 命令适配器接口
 * 用于针对特定工具（npm、pytest、docker 等）进行输出优化
 */
export interface CommandAdapter {
  // 检测命令是否匹配此适配器
  detect(command: string): boolean
  
  // 后处理压缩后的输出（可选）
  postCompress?(output: string, config: CompressionConfig): string
}

/**
 * 命令适配器上下文
 */
export type CommandAdapterContext = {
  command: string
  exitCode: number | null
  durationMs: number
}

// 定义压缩配置的接口，用于控制各个压缩策略的阈值
export type CompressionConfig = {
  // 是否启用压缩功能
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

  /**
   * 高熵/长行压缩设置。
   * minHighEntropyLineLength: 触发高熵检测的最小行长度。
   * minEntropy: 最小熵值阈值（信息熵）。
   * maxWhitespaceRatio: 最大空白字符比例。
   */
  minHighEntropyLineLength: number
  minEntropy: number
  maxWhitespaceRatio: number
  
  /**
   * 模板化近重复压缩设置。
   * minTemplateRepeats: 模板重复的最少次数。
   * templateNormalizationLevel: 归一化级别 ('safe' | 'aggressive' | 'off')
   */
  minTemplateRepeats: number
  templateNormalizationLevel: string
  
  /**
   * 命令适配器设置。
   * enableCommandAdapters: 是否启用命令适配器。
   */
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

// 记录各种压缩策略命中的次数以及总的压缩效果
export type CompressionStats = {
  originalBytes: number        // 压缩前原始总字节数
  compressedBytes: number      // 压缩后总字节数
  savedBytes: number           // 节省的总字节数
  savingRatio: number          // 节省的总体比例

  carriageReturnGroups: number // 命中的回车折叠次数
  repeatedBlockGroups: number  // 命中的多行块重复压缩次数
  repeatedLineGroups: number   // 命中的单行重复压缩次数
  templateGroups: number       // 命中的模板化近重复压缩次数
  inlinePatternGroups: number  // 命中的行内模式压缩次数
  highEntropyLines: number     // 命中的高熵长行压缩次数
  secretsRedacted: number      // 被脱敏的敏感信息数量

  applied: boolean             // 是否真正应用了任何压缩（即节省了空间）
}

// 压缩后的结果和对应的统计信息
export type CompressResult = {
  text: string                 // 压缩后的文本
  stats: CompressionStats      // 压缩统计
}

// 用于评估某次字符串替换操作是否“划算”的内部结构
type Score = {
  originalBytes: number        // 替换前字节数
  replacementBytes: number     // 替换后字节数
  savedBytes: number           // 节省字节数
  savingRatio: number          // 节省比例
  profitable: boolean          // 是否满足 minSavedBytes 和 minSavingRatio 的“划算”阈值
}

// 多行重复块的候选对象
type BlockCandidate = {
  width: number                // 这个块包含多少行
  repeats: number              // 连续重复了多少次
  replacementLines: string[]   // 用于替换的文本行（通常是原始块 + 提示信息）
  consumedLines: number        // 这次替换共消耗/涵盖了原始文本的多少行
  score: Score                 // 评估得分
}

// 单行的记录，用于流式诊断时记录行号和行内容
type LineRecord = {
  no: number                   // 行号（从1开始）
  text: string                 // 行内容
}

// 一个完整的诊断上下文，包含中心错误行及前后的上下文行
export type DiagnosticContext = {
  centerLine: number           // 触发这个上下文的中心错误行号
  lines: LineRecord[]          // 包含上下文的所有行
  priority: 'first' | 'fatal' | 'recent'  // 上下文优先级
}

// 命令执行完毕后的诊断快照，汇总了各项异常指标
export type DiagnosticSnapshot = {
  totalLines: number           // 输出总行数
  errorLikeLines: number       // 包含错误关键词的行数
  warningLikeLines: number     // 包含警告关键词的行数
  fatalLikeLines: number       // 包含致命错误关键词的行数
  contexts: DiagnosticContext[]// 合并整理后的所有诊断上下文块
  firstErrorContexts: DiagnosticContext[]  // 最早的错误上下文
  fatalContexts: DiagnosticContext[]       // 致命错误上下文
  recentErrorContexts: DiagnosticContext[] // 最近的错误上下文
}

// 渲染诊断附录信息的选项
export type RenderAppendixOptions = {
  durationMs: number           // 命令执行耗时
  exitCode: number | null      // 命令退出码
  config?: Partial<CompressionConfig> // 允许传入部分配置覆盖默认
}

// 默认配置，支持从环境变量读取进行动态调整
export const DEFAULT_COMPRESSION_CONFIG: CompressionConfig = {
  // 总开关，可通过 OPENCODE_EXPERIMENTAL_BASH_OUTPUT_COMPRESSION 关闭
  enabled: process.env.OPENCODE_EXPERIMENTAL_BASH_OUTPUT_COMPRESSION !== "0",

  // 默认最小节省 80 字节
  minSavedBytes: Number(process.env.OPENCODE_BASH_COMPRESSION_MIN_SAVED_BYTES ?? 80),
  // 默认至少压缩 50% 空间
  minSavingRatio: Number(process.env.OPENCODE_BASH_COMPRESSION_MIN_SAVING_RATIO ?? 0.5),

  // 最大扫描的块行数为 12 行
  maxBlockLines: Number(process.env.OPENCODE_BASH_COMPRESSION_MAX_BLOCK_LINES ?? 12),
  // 块必须至少重复 2 次
  minBlockRepeats: Number(process.env.OPENCODE_BASH_COMPRESSION_MIN_BLOCK_REPEATS ?? 2),

  // 单行必须连续出现至少 3 次
  minSameLineRepeats: Number(process.env.OPENCODE_BASH_COMPRESSION_MIN_SAME_LINE_REPEATS ?? 3),

  // 行内模式最大长度 64 字符
  maxInlinePatternLength: Number(process.env.OPENCODE_BASH_COMPRESSION_MAX_INLINE_PATTERN_LENGTH ?? 64),
  // 行内模式最少重复 4 次
  minInlineRepeatCount: Number(process.env.OPENCODE_BASH_COMPRESSION_MIN_INLINE_REPEAT_COUNT ?? 4),
  // 行长超过 80 字节才触发
  minInlineRunBytes: Number(process.env.OPENCODE_BASH_COMPRESSION_MIN_INLINE_RUN_BYTES ?? 80),
  // 最大支持 4096 字符的行内压缩，防止正则引擎卡死
  maxInlineLineLength: Number(process.env.OPENCODE_BASH_COMPRESSION_MAX_INLINE_LINE_LENGTH ?? 4096),

  // 至少 4 次回车更新才折叠
  minCarriageReturnFrames: Number(process.env.OPENCODE_BASH_COMPRESSION_MIN_CR_FRAMES ?? 4),

  // 高熵长行压缩配置
  minHighEntropyLineLength: Number(process.env.OPENCODE_BASH_MIN_HIGH_ENTROPY_LINE_LENGTH ?? 512),
  minEntropy: Number(process.env.OPENCODE_BASH_MIN_ENTROPY ?? 4.5),
  maxWhitespaceRatio: Number(process.env.OPENCODE_BASH_MAX_WHITESPACE_RATIO ?? 0.1),
  
  // 模板化近重复压缩配置
  minTemplateRepeats: Number(process.env.OPENCODE_BASH_COMPRESSION_MIN_TEMPLATE_REPEATS ?? 3),
  templateNormalizationLevel: process.env.OPENCODE_BASH_TEMPLATE_NORMALIZATION ?? 'safe',
  
  // 命令适配器配置
  enableCommandAdapters: process.env.OPENCODE_BASH_ENABLE_COMMAND_ADAPTERS !== '0',

  // 命令运行超 2000ms 才提取错误上下文
  diagnosticMinRuntimeMs: Number(process.env.OPENCODE_BASH_DIAGNOSTIC_MIN_RUNTIME_MS ?? 2000),
  // 上下文半径为 3 行 (上3下3)
  diagnosticContextRadius: Number(process.env.OPENCODE_BASH_DIAGNOSTIC_CONTEXT_RADIUS ?? 3),
  // 最多展示 5 个独立的错误上下文
  maxDiagnosticContexts: Number(process.env.OPENCODE_BASH_DIAGNOSTIC_MAX_CONTEXTS ?? 5),
  // 每行最多保留 100 字符
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

// 匹配编译/类型错误
const COMPILE_ERROR_RE = /\b(?:TS\d+|error\[E\d+\]|SyntaxError|TypeError|ModuleNotFoundError|cannot find module)\b/i

// 匹配基础设施错误
const INFRA_ERROR_RE = /\b(?:ENOENT|EACCES|ECONNREFUSED|EADDRINUSE|timeout|permission denied|connection refused)\b/i

// 用于排除 "0 errors", "0 warnings" 这种健康指标行
const ZERO_PROBLEM_RE = /\b0\s+(?:errors?|failures?|warnings?)\b/i

// 扩展的健康指标正则（False Positive 过滤）
const HEALTHY_INDICATOR_RE = /\b(?:no\s+errors?|without\s+errors?|0\s+failed|failed\s*=\s*0|errors?\s*:\s*0|warnings?\s*:\s*0|no\s+vulnerabilities\s+found|found\s+0\s+vulnerabilities|all\s+tests?\s+passed?|\d+\s+passed?,\s+0\s+failed|build\s+successful|compilation\s+successful|no\s+issues?\s+found)\b/i
// 匹配 ANSI 控制字符（颜色、清屏等），含有 ANSI 的行在行内压缩时被跳过
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/
const ANSI_GLOBAL_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g

// Secret 检测模式
const SECRET_PATTERNS = [
  // API Keys (sk-xxx 格式，常见于 OpenAI、Anthropic 等)
  { regex: /\bsk-[A-Za-z0-9_-]{20,}\b/g, name: 'api-key', confidence: 1.0 },
  { regex: /\bsk-[A-Za-z0-9_-]+-[A-Za-z0-9_-]{20,}\b/g, name: 'api-key', confidence: 1.0 },
  
  // JWT
  { regex: /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, name: 'jwt', confidence: 0.9 },
  
  // AWS Keys
  { regex: /\bAKIA[0-9A-Z]{16}\b/g, name: 'aws-access-key', confidence: 1.0 },
  
  // GitHub Token
  { regex: /\bgh[ps]_[A-Za-z0-9]{36,}\b/g, name: 'github-token', confidence: 1.0 },
  
  // Generic secrets (password=xxx, token=xxx)
  { regex: /(?:password|passwd|pwd|secret|token|key|api[_-]?key)\s*[:=]\s*['"]?([^'"\s]{8,})['"]?/gi, name: 'credential', confidence: 0.7 },
  
  // Private keys
  { regex: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g, name: 'private-key', confidence: 1.0 },
]

// Secret Redaction（敏感信息脱敏）
function redactSecrets(text: string): { text: string; redacted: number } {
  let redacted = 0
  let result = text
  
  for (const { regex, name, confidence } of SECRET_PATTERNS) {
    // 只 redact 高置信度的匹配
    if (confidence >= 0.7) {
      const matches = result.match(regex)
      if (matches) {
        for (const match of matches) {
          const replacement = `<REDACTED_${name.toUpperCase()}>`
          result = result.replace(match, replacement)
          redacted++
        }
      }
    }
  }
  
  return { text: result, redacted }
}

/**
 * 虚拟终端渲染器 - 处理 ANSI 控制序列
 * 支持光标移动、清屏、清行等操作，将终端重绘输出转换为稳定的文本
 */
type VirtualTerminalOptions = {
  maxLines?: number
  maxChars?: number
  bufferPartialControl?: boolean
}

class VirtualTerminal {
  private lines: string[] = []
  private cursorRow = 0
  private cursorCol = 0
  private frameCount = 0
  private pendingControl = ''

  constructor(private readonly options: VirtualTerminalOptions = {}) {}
  
  // ANSI CSI 序列解析正则
  private readonly CSI_REGEX = /\x1b\[([0-9;?]*)([A-Za-z])/g
  
  processChunk(input: string): void {
    const chunk = this.pendingControl + input
    this.pendingControl = ''
    let pos = 0
    
    while (pos < chunk.length) {
      // 查找下一个 ANSI 控制序列
      this.CSI_REGEX.lastIndex = pos
      const match = this.CSI_REGEX.exec(chunk)
      
      if (!match) {
        // 没有更多控制序列，处理剩余文本
        const rest = chunk.slice(pos)
        const partial = this.options.bufferPartialControl ? this.partialControl(rest) : ''
        if (partial) {
          // Live shell chunks may split ESC or ESC[2K across arbitrary byte
          // boundaries. Buffer only a suffix that can still become one of the CSI
          // controls this renderer understands; complete or unknown sequences keep
          // following the existing parse path instead of hiding visible text.
          this.writeText(rest.slice(0, rest.length - partial.length))
          this.pendingControl = partial
        } else {
          this.writeText(rest)
        }
        break
      }
      
      // 写入控制序列前的文本
      if (match.index > pos) {
        this.writeText(chunk.slice(pos, match.index))
      }
      
      // 处理控制序列
      const params = match[1]
      const command = match[2]
      this.handleCSI(params, command)
      
      pos = this.CSI_REGEX.lastIndex
    }

    this.trimDisplay()
  }

  private partialControl(text: string) {
    const esc = text.lastIndexOf('\x1b')
    if (esc < 0) return ''
    const suffix = text.slice(esc)
    if (suffix === '\x1b') return suffix
    if (/^\x1b\[[0-9;?]*$/.test(suffix)) return suffix
    return ''
  }

  private trimDisplay(): void {
    // Live metadata used to be bounded by `preview(last + chunk)`. Keep that
    // invariant for the terminal-display path too; otherwise long-running tools
    // would trade clean CR rendering for unbounded screen storage and repeated
    // whole-buffer joins. Compression uses an unbounded VirtualTerminal by not
    // passing these display-only limits.
    if (this.options.maxLines !== undefined && this.lines.length > this.options.maxLines) {
      const drop = this.lines.length - this.options.maxLines
      this.lines = this.lines.slice(drop)
      this.cursorRow = Math.max(0, this.cursorRow - drop)
    }

    if (this.options.maxChars === undefined || this.lines.length === 0) return

    let total = 0
    let start = this.lines.length
    for (let i = this.lines.length - 1; i >= 0; i--) {
      const line = this.lines[i]
      const size = line.length + (start === this.lines.length ? 0 : 1)
      if (total + size > this.options.maxChars) {
        if (start === this.lines.length) {
          const drop = Math.max(0, line.length - this.options.maxChars)
          this.lines[i] = line.slice(drop)
          if (this.cursorRow === i) this.cursorCol = Math.max(0, this.cursorCol - drop)
          start = i
        }
        break
      }
      total += size
      start = i
    }

    if (start > 0 && start < this.lines.length) {
      this.lines = this.lines.slice(start)
      this.cursorRow = Math.max(0, this.cursorRow - start)
    }
  }
  
  private handleCSI(params: string, command: string): void {
    const nums = params.split(';').map(n => parseInt(n) || 0)
    
    switch (command) {
      case 'A': // Cursor Up
        this.cursorRow = Math.max(0, this.cursorRow - (nums[0] || 1))
        this.frameCount++
        break
      case 'B': // Cursor Down
        this.cursorRow += nums[0] || 1
        this.frameCount++
        break
      case 'C': // Cursor Forward
        this.cursorCol += nums[0] || 1
        break
      case 'D': // Cursor Back
        this.cursorCol = Math.max(0, this.cursorCol - (nums[0] || 1))
        break
      case 'G': // Cursor Horizontal Absolute
        this.cursorCol = (nums[0] || 1) - 1
        this.frameCount++
        break
      case 'H': // Cursor Position
      case 'f': // Horizontal Vertical Position
        this.cursorRow = Math.max(0, (nums[0] || 1) - 1)
        this.cursorCol = Math.max(0, (nums[1] || 1) - 1)
        this.frameCount++
        break
      case 'K': // Erase in Line
        this.ensureLine(this.cursorRow)
        if (nums[0] === 0 || !nums[0]) {
          // 清除从光标到行尾
          this.lines[this.cursorRow] = this.lines[this.cursorRow].slice(0, this.cursorCol)
        } else if (nums[0] === 1) {
          // 清除从行首到光标
          this.lines[this.cursorRow] = ' '.repeat(this.cursorCol) + this.lines[this.cursorRow].slice(this.cursorCol)
        } else if (nums[0] === 2) {
          // 清除整行
          this.lines[this.cursorRow] = ''
        }
        this.frameCount++
        break
      case 'J': // Erase in Display
        if (nums[0] === 2 || nums[0] === 3) {
          // 清屏
          this.lines = []
          this.cursorRow = 0
          this.cursorCol = 0
          this.frameCount++
        }
        break
    }
  }
  
  private writeText(text: string): void {
    for (let pos = 0; pos < text.length;) {
      const char = text[pos]
      if (char === '\r') {
        this.cursorCol = 0
        this.frameCount++
        pos++
        continue
      }

      if (char === '\n') {
        this.cursorRow++
        this.cursorCol = 0
        this.trimDisplay()
        pos++
        continue
      }

      if (char === '\b') {
        this.cursorCol = Math.max(0, this.cursorCol - 1)
        pos++
        continue
      }

      let end = pos + 1
      while (end < text.length && text[end] !== '\r' && text[end] !== '\n' && text[end] !== '\b') {
        end++
      }
      this.writeRun(text.slice(pos, end))
      pos = end
    }
  }

  private writeRun(input: string): void {
    // Plain output can arrive as very large chunks. Batch normal text and, in
    // live-display mode, keep only the suffix that metadata can ever show so the
    // terminal renderer stays bounded before the final preview() call.
    const text = this.options.maxChars === undefined ? input : input.slice(-this.options.maxChars)
    this.ensureLine(this.cursorRow)

    if (this.options.maxChars !== undefined && this.cursorCol > this.options.maxChars) {
      this.lines[this.cursorRow] = ''
      this.cursorCol = this.options.maxChars
    }
    while (this.lines[this.cursorRow].length < this.cursorCol) {
      this.lines[this.cursorRow] += ' '
    }

    const line = this.lines[this.cursorRow]
    this.lines[this.cursorRow] = line.slice(0, this.cursorCol) + text + line.slice(this.cursorCol + text.length)
    this.cursorCol += text.length
    this.trimDisplay()
  }
  
  private ensureLine(row: number): void {
    while (this.lines.length <= row) {
      this.lines.push('')
    }
  }
  
  getStableOutput(): string {
    return this.lines.filter(line => line.trim().length > 0).join('\n')
  }

  getDisplayOutput(): string {
    // Display snapshots model what the user sees in a terminal, not what the
    // model receives. Preserve intentional blank rows inside the visible screen,
    // but trim the implicit empty rows created only by a trailing newline or clear.
    const last = this.lines.findLastIndex(line => line.trim().length > 0)
    if (last < 0) return ''
    return this.lines.slice(0, last + 1).join('\n')
  }
  
  getFrameCount(): number {
    return this.frameCount
  }
}

export function createTerminalDisplay(options?: Pick<VirtualTerminalOptions, 'maxLines' | 'maxChars'>) {
  const terminal = new VirtualTerminal({ ...options, bufferPartialControl: true })

  return {
    push(chunk: string) {
      // Reuse the same terminal renderer as compression so live metadata and
      // final compression cannot diverge on CR redraws, clear-line sequences, or
      // cursor movement. This helper intentionally returns only the display view;
      // callers that need faithful model output must keep their own raw stream.
      terminal.processChunk(chunk)
      return terminal.getDisplayOutput()
    },
    value() {
      return terminal.getDisplayOutput()
    },
  }
}

// 使用虚拟终端渲染器替代简单的回车折叠
function normalizeTerminalOutput(text: string, config: CompressionConfig): { text: string; frames: number } {
  // 如果没有 ANSI 控制字符和回车，直接返回
  if (!text.includes('\r') && !text.includes('\x1b[')) {
    return { text, frames: 0 }
  }
  
  const vt = new VirtualTerminal()
  vt.processChunk(text)
  
  const stable = vt.getStableOutput()
  const frames = vt.getFrameCount()
  
  if (frames >= config.minCarriageReturnFrames && terminalRenderCollapsedText(text, stable)) {
    return {
      text: `... [terminal progress collapsed: ${frames} frames]\n${stable}`,
      frames
    }
  }
  
  return { text: stable, frames }
}

function terminalRenderCollapsedText(text: string, stable: string) {
  // 有些 shell 会在普通输出行前写入光标定位或样式 CSI。它们会增加 frame
  // 计数，但并没有覆盖进度帧；只有渲染后的稳定画面少于原始可见文本时才提示 progress collapse。
  return stripAnsi(text).replace(/\r/g, "\n").split("\n").filter((line) => line.trim().length > 0).join("\n") !== stable
}

// 去掉 ANSI 控制字符，供压缩和诊断渲染使用；诊断候选只来自隐藏输出，
// 不再和可见窗口做重复性判断。
function stripAnsi(text: string) {
  return text.replace(ANSI_GLOBAL_RE, "")
}

// 合并传入配置与默认配置
function configOf(config?: Partial<CompressionConfig>): CompressionConfig {
  return { ...DEFAULT_COMPRESSION_CONFIG, ...config }
}

// 计算文本真实字节大小
function byteLen(text: string) {
  // 纯 ASCII 直接返回长度以提升性能
  if (/^[\x00-\x7f]*$/.test(text)) return text.length
  // 包含 Unicode 时计算 utf-8 字节数
  return Buffer.byteLength(text, "utf-8")
}

// 评估一次替换带来的空间节省情况
function scoreReplacement(original: string, replacement: string, config: CompressionConfig): Score {
  const originalBytes = byteLen(original)
  const replacementBytes = byteLen(replacement)
  const savedBytes = originalBytes - replacementBytes
  const savingRatio = originalBytes > 0 ? savedBytes / originalBytes : 0

  return {
    originalBytes,
    replacementBytes,
    savedBytes,
    savingRatio,
    // 只有当节省量和比例都满足条件时才认为划算
    profitable: savedBytes >= config.minSavedBytes && savingRatio >= config.minSavingRatio,
  }
}

// 拼接字符串数组
function serializeLines(lines: string[]) {
  return lines.join("\n")
}

// 将长单行截断至指定字符数，并在末尾加上省略号
function truncateOneLine(text: string, maxChars: number) {
  const normalized = text.replace(/\s+/g, " ").trimEnd()
  if (normalized.length <= maxChars) return normalized
  return normalized.slice(0, Math.max(0, maxChars - 1)) + "…"
}

// 引号包裹被压缩的模式字符串，并对其进行转义处理（主要为了呈现给 LLM 看时更清晰）
// [local-smark] 导出 quotePattern 用于直接测试其边界行为；
// 增加 undefined guard：压缩管线中 PowerShell 输出格式化的边界情况
// 可能传入 undefined pattern，直接 .replaceAll 会 crash（历史 9 次 JS 错误）。
// 返回空字符串而非 throw，保证压缩管线不会因单个 pattern 为空而中断整个输出处理。
export function quotePattern(pattern: string, maxChars = 40) {
  // 防御 undefined / 非 string 输入：TypeScript 类型标注不在运行时强制，
  // 压缩管线的调用方在 PowerShell CLIXML 解析等边界路径可能产生 undefined
  if (typeof pattern !== "string") return ""
  let text = pattern
    .replaceAll("\\", "\\\\")
    .replaceAll("\t", "\\t")
    .replaceAll("\r", "\\r")
    .replaceAll('"', '\\"')

  if (text.length > maxChars) text = text.slice(0, maxChars - 1) + "…"
  return `"${text}"`
}

// 判断行是否为空或仅含空白符
function isBlankLine(line: string) {
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
  for (let width = 1; width <= Math.floor(block.length / 2); width++) {
    // 只能整除的情况才可能是完整的周期
    if (block.length % width !== 0) continue

    let ok = true
    for (let i = width; i < block.length; i++) {
      if (block[i] !== block[i % width]) {
        ok = false
        break
      }
    }
    if (ok) return true
  }
  return false
}

// 检查原数组中偏移为 a 和 b、宽度为 width 的两块内容是否完全相等
function sameBlock(lines: string[], a: number, b: number, width: number) {
  for (let i = 0; i < width; i++) {
    if (lines[a + i] !== lines[b + i]) return false
  }
  return true
}

/**
 * 折叠终端重绘输出（增强版：支持 ANSI 控制序列）
 * 优先使用虚拟终端渲染器，如果没有 ANSI 控制序列则回退到简单的回车折叠
 */
function collapseCarriageReturns(text: string, config: CompressionConfig): { text: string; groups: number } {
  // 如果包含 ANSI 控制序列或回车，使用虚拟终端渲染器
  if (text.includes('\x1b[') || text.includes('\r')) {
    const result = normalizeTerminalOutput(text, config)
    return { text: result.text, groups: result.frames > 0 ? 1 : 0 }
  }

  return { text, groups: 0 }
}

// ==================== Phase 3: 命令适配器实现 ====================

/**
 * npm/pnpm 适配器
 * 优化 npm install、pnpm install 等包管理器输出
 */
class NpmPnpmAdapter implements CommandAdapter {
  detect(command: string): boolean {
    return /^(npm|pnpm|yarn)\s+(i|install|ci|add)\b/.test(command)
  }
  
  postCompress(output: string, config: CompressionConfig): string {
    const lines = output.split('\n')
    
    // 1. 折叠 audit banner
    const auditStart = lines.findIndex(l => /found \d+ vulnerabilities/.test(l))
    if (auditStart >= 0) {
      const auditEnd = lines.findIndex((l, i) => i > auditStart && l.trim() === '')
      if (auditEnd > auditStart) {
        const auditSummary = lines[auditStart]
        lines.splice(auditStart, auditEnd - auditStart, 
          `... [npm audit summary collapsed]`,
          auditSummary
        )
      }
    }
    
    // 2. 聚合 peer dependency warnings
    const peerWarnings = lines.filter(l => /WARN.*peer dep/i.test(l))
    if (peerWarnings.length >= 3) {
      const grouped = new Map<string, number>()
      for (const warn of peerWarnings) {
        const match = /peer dep.*?(\S+)/.exec(warn)
        if (match) {
          grouped.set(match[1], (grouped.get(match[1]) || 0) + 1)
        }
      }
      
      const summary = Array.from(grouped.entries())
        .map(([pkg, count]) => `  - ${pkg} (${count}×)`)
        .join('\n')
      
      // 移除原始 warnings，插入摘要
      const filtered = lines.filter(l => !/WARN.*peer dep/i.test(l))
      filtered.push(`\n... [peer dependency warnings grouped]:\n${summary}`)
      
      return filtered.join('\n')
    }
    
    return lines.join('\n')
  }
}

/**
 * pytest 适配器
 * 优化 pytest 测试输出
 */
class PytestAdapter implements CommandAdapter {
  detect(command: string): boolean {
    return /^pytest\b/.test(command)
  }
  
  postCompress(output: string, config: CompressionConfig): string {
    const lines = output.split('\n')
    
    // 1. 提取 short test summary
    const summaryStart = lines.findIndex(l => /^=+ short test summary/i.test(l))
    if (summaryStart >= 0) {
      const summaryEnd = lines.findIndex((l, i) => i > summaryStart && /^=+/.test(l))
      if (summaryEnd > summaryStart) {
        const summary = lines.slice(summaryStart, summaryEnd)
        
        // 提取失败测试列表
        const failedTests = summary
          .filter(l => /^FAILED/i.test(l))
          .map(l => l.replace(/^FAILED\s+/i, ''))
        
        if (failedTests.length > 0) {
          const summaryText = `<pytest_summary>
failed=${failedTests.length}
${failedTests.map(t => `- ${t}`).join('\n')}
</pytest_summary>`
          
          // 在输出开头插入摘要
          lines.unshift(summaryText, '')
        }
      }
    }
    
    // 2. 折叠过长的 captured output
    let i = 0
    while (i < lines.length) {
      if (/^-+ Captured (stdout|stderr) call -+$/i.test(lines[i])) {
        const start = i
        i++
        while (i < lines.length && !/^=+/.test(lines[i]) && !/^-+ Captured/i.test(lines[i])) {
          i++
        }
        const capturedLines = i - start - 1
        if (capturedLines > 50) {
          // 保留前 10 行和后 10 行
          const kept = 10
          lines.splice(
            start + kept + 1,
            capturedLines - kept * 2,
            `... [${capturedLines - kept * 2} lines of captured output omitted]`
          )
          i = start + kept * 2 + 2
        }
      }
      i++
    }
    
    return lines.join('\n')
  }
}

/**
 * Docker 适配器
 * 优化 docker build 输出
 */
class DockerAdapter implements CommandAdapter {
  detect(command: string): boolean {
    return /^docker\s+(build|buildx)/.test(command)
  }
  
  postCompress(output: string, config: CompressionConfig): string {
    const lines = output.split('\n')
    const steps: Array<{ num: number; name: string; status: string; lines: string[] }> = []
    
    let currentStep: typeof steps[0] | null = null
    
    for (const line of lines) {
      const stepMatch = /^#(\d+) \[(.+?)\]/.exec(line)
      if (stepMatch) {
        if (currentStep) steps.push(currentStep)
        currentStep = {
          num: parseInt(stepMatch[1]),
          name: stepMatch[2],
          status: 'running',
          lines: [line]
        }
        continue
      }
      
      if (currentStep) {
        currentStep.lines.push(line)
        if (/DONE|CACHED|ERROR/i.test(line)) {
          currentStep.status = /ERROR/i.test(line) ? 'failed' : 
                               /CACHED/i.test(line) ? 'cached' : 'done'
        }
      }
    }
    
    if (currentStep) steps.push(currentStep)
    
    // 生成摘要
    const summary = steps.map(s => 
      `#${s.num} ${s.name}: ${s.status.toUpperCase()}`
    ).join('\n')
    
    // 只保留失败步骤的详细输出
    const failedStep = steps.find(s => s.status === 'failed')
    if (failedStep) {
      return `<docker_build_summary>
${summary}
</docker_build_summary>

<docker_failed_step step="#${failedStep.num}">
${failedStep.lines.join('\n')}
</docker_failed_step>`
    }
    
    return `<docker_build_summary>
${summary}
</docker_build_summary>`
  }
}

/**
 * TypeScript 适配器
 * 优化 tsc 编译输出
 */
class TypeScriptAdapter implements CommandAdapter {
  detect(command: string): boolean {
    return /^(tsc|npx tsc|bun tsc)\b/.test(command)
  }
  
  postCompress(output: string, config: CompressionConfig): string {
    const lines = output.split('\n')
    
    // 按错误码分组
    const errorGroups = new Map<string, Array<{ file: string; line: string }>>()
    
    for (const line of lines) {
      const match = /^(.+?)\((\d+),(\d+)\): error (TS\d+):/.exec(line)
      if (match) {
        const [, file, row, col, code] = match
        if (!errorGroups.has(code)) {
          errorGroups.set(code, [])
        }
        errorGroups.get(code)!.push({ file, line })
      }
    }
    
    if (errorGroups.size === 0) return output
    
    // 生成摘要
    const summary = Array.from(errorGroups.entries())
      .map(([code, errors]) => `${code} × ${errors.length}`)
      .join(', ')
    
    // 保留每个错误码的前 3 个实例
    const kept = new Set<string>()
    for (const [code, errors] of errorGroups) {
      errors.slice(0, 3).forEach(e => kept.add(e.line))
    }
    
    const filtered = lines.filter(line => {
      if (!/error TS\d+:/i.test(line)) return true
      return kept.has(line)
    })
    
    return `<tsc_diagnostics_summary>
${summary}
first errors shown below (${kept.size} of ${lines.length} total)
</tsc_diagnostics_summary>
${filtered.join('\n')}`
  }
}

// 适配器注册表
const COMMAND_ADAPTERS: CommandAdapter[] = [
  new NpmPnpmAdapter(),
  new PytestAdapter(),
  new DockerAdapter(),
  new TypeScriptAdapter(),
]

/**
 * 检测并返回匹配的命令适配器
 */
export function detectCommandAdapter(command: string): CommandAdapter | undefined {
  return COMMAND_ADAPTERS.find(adapter => adapter.detect(command))
}

/**
 * 应用命令适配器的后处理
 */
export function applyCommandAdapter(
  command: string,
  output: string,
  config: CompressionConfig
): string {
  if (!config.enableCommandAdapters) return output
  
  const adapter = detectCommandAdapter(command)
  if (!adapter || !adapter.postCompress) return output
  
  return adapter.postCompress(output, config)
}

// 计算行哈希（用于加速块比较）
function computeLineHashes(lines: string[]): number[] {
  return lines.map(line => {
    let hash = 0
    for (let i = 0; i < line.length; i++) {
      hash = ((hash << 5) - hash) + line.charCodeAt(i)
      hash = hash & hash  // Convert to 32bit integer
    }
    return hash
  })
}

// 计算块哈希（rolling hash）
function computeBlockHash(lineHashes: number[], start: number, width: number): number {
  let hash = 0
  for (let i = 0; i < width; i++) {
    hash = ((hash << 5) - hash) + lineHashes[start + i]
    hash = hash & hash
  }
  return hash
}

// 在给定的起始索引处寻找最划算的连续重复多行块（优化版：使用 rolling hash）
function findRepeatedBlockAt(
  lines: string[], 
  lineHashes: number[], 
  start: number, 
  config: CompressionConfig
): BlockCandidate | undefined {
  const remaining = lines.length - start
  let best: BlockCandidate | undefined

  // 最大尝试的块宽度为配置的上限，或剩余行能容纳最小重复次数的最大宽度
  const maxWidth = Math.min(config.maxBlockLines, Math.floor(remaining / config.minBlockRepeats))
  
  // 逐一尝试不同的块宽度
  for (let width = 2; width <= maxWidth; width++) {
    const block = lines.slice(start, start + width)
    // 忽略全空行的块
    if (block.every(isBlankLine)) continue
    // 忽略全是同一行内容的块（这应该交给相同单行压缩来做，而不是块压缩）
    if (new Set(block).size <= 1) continue
    // 忽略本身具有更小重复周期的块
    if (hasSmallerLinePeriod(block)) continue

    // 计算当前块的哈希
    const blockHash = computeBlockHash(lineHashes, start, width)
    
    let repeats = 1
    let cursor = start + width

    // 向下探查看这个块重复了多少次（优化：先比较哈希，再比较字符串）
    while (cursor + width <= lines.length) {
      const nextHash = computeBlockHash(lineHashes, cursor, width)
      if (nextHash !== blockHash) break
      
      // Hash 相同，再做精确比较
      if (!sameBlock(lines, start, cursor, width)) break
      
      repeats++
      cursor += width
    }

    // 重复次数不达标
    if (repeats < config.minBlockRepeats) continue

    const originalLines = lines.slice(start, start + width * repeats)
    // 替换内容：只留第一遍块，然后加上总结语
    const replacementLines = [
      ...block,
      `... [previous ${width} lines repeated ${repeats - 1} more times]`,
    ]

    // 评估是否划算
    const score = scoreReplacement(serializeLines(originalLines), serializeLines(replacementLines), config)
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
      best = candidate
    }
  }

  return best
}

// 从上到下扫描所有行，应用多行块压缩（优化版：预计算行哈希）
function compressRepeatedBlocks(lines: string[], config: CompressionConfig): { lines: string[]; groups: number } {
  const out: string[] = []
  let groups = 0
  let i = 0
  
  // 预计算所有行的哈希值，加速后续比较
  const lineHashes = computeLineHashes(lines)

  while (i < lines.length) {
    // 尝试在当前 i 位置找到一个可折叠的多行块
    const candidate = findRepeatedBlockAt(lines, lineHashes, i, config)
    if (!candidate) {
      out.push(lines[i])
      i++
      continue
    }

    // 找到了，塞入替换行并跳过已经消耗的行数
    out.push(...candidate.replacementLines)
    groups++
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

    // 一直向后寻找完全一样的行
    while (j < lines.length && lines[j] === line) j++

    const count = j - i
    // 如果达到了阈值且不是纯空白行
    if (count >= config.minSameLineRepeats && !isBlankLine(line)) {
      const originalLines = lines.slice(i, j)
      const replacementLines = [line, `... [same line repeated ${count - 1} more times]`]
      const score = scoreReplacement(serializeLines(originalLines), serializeLines(replacementLines), config)

      // 只有省下了足够字节才应用
      if (score.profitable) {
        out.push(...replacementLines)
        groups++
        i = j
        continue
      }
    }

    out.push(line)
    i++
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
  // 超长单行只允许检查“整行短周期重复”这种线性安全形态；避免恢复
  // 旧的全位置扫描导致 ReDoS/CPU 尖峰，同时保留 abcabcabc 这类高收益压缩。
  if (line.length > config.maxInlineLineLength) return compressWholeLineRepeat(line, config)
  // 不处理带有 ANSI 转义序列的行（通常含有颜色代码，强行切割会破坏终端样式）
  if (ANSI_RE.test(line)) return { line, applied: false }

  let best: InlineCandidate | undefined
  // 最大模式长度不能超过配置值，也不能超过整行被重复要求的最低倍数能分的份数
  const maxPattern = Math.min(config.maxInlinePatternLength, Math.floor(line.length / config.minInlineRepeatCount))

  for (let start = 0; start < line.length; start++) {
    for (let width = 1; width <= maxPattern; width++) {
      // 提早退出：如果剩下的长度都不足以放下最小重复次数
      if (start + width * config.minInlineRepeatCount > line.length) break

      const pattern = line.slice(start, start + width)
      // 不压缩只包含空格的模式
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

  if (!best) return { line, applied: false }

  // 拼接：替换前半段 + 替换标签 + 替换后半段
  return {
    line: line.slice(0, best.start) + best.replacement + line.slice(best.end),
    applied: true,
  }
}

function compressWholeLineRepeat(line: string, config: CompressionConfig): { line: string; applied: boolean } {
  const maxPattern = Math.min(config.maxInlinePatternLength, Math.floor(line.length / config.minInlineRepeatCount))
  for (let width = 1; width <= maxPattern; width++) {
    if (line.length % width !== 0) continue
    const pattern = line.slice(0, width)
    if (!pattern.trim()) continue
    const repeats = line.length / width
    if (repeats < config.minInlineRepeatCount) continue
    let ok = true
    for (let cursor = width; cursor < line.length; cursor += width) {
      if (line.slice(cursor, cursor + width) === pattern) continue
      ok = false
      break
    }
    if (!ok) continue
    const replacement = `[repeated ${quotePattern(pattern)} ×${repeats}]`
    const score = scoreReplacement(line, replacement, config)
    if (score.profitable) return { line: replacement, applied: true }
  }
  return { line, applied: false }
}

// 计算文本熵值
function calculateEntropy(text: string): number {
  const freq = new Map<string, number>()
  for (const char of text) {
    freq.set(char, (freq.get(char) || 0) + 1)
  }
  
  let entropy = 0
  const len = text.length
  for (const count of freq.values()) {
    const p = count / len
    entropy -= p * Math.log2(p)
  }
  
  return entropy
}

// 高熵行检测
function isHighEntropyLine(line: string, config: CompressionConfig): boolean {
  if (line.length < config.minHighEntropyLineLength) return false
  
  const entropy = calculateEntropy(line)
  const whitespaceCount = (line.match(/\s/g) || []).length
  const noWhitespaceRatio = 1 - (whitespaceCount / line.length)
  
  return entropy > config.minEntropy && noWhitespaceRatio > (1 - config.maxWhitespaceRatio)
}

// 内容类型检测
function detectHighEntropyType(line: string): string {
  if (/^[A-Za-z0-9+/]+=*$/.test(line.trim())) return 'base64'
  if (/^eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(line.trim())) return 'jwt'
  if (/^data:image\/[^;]+;base64,/.test(line)) return 'data-uri'
  if (/^[{[].*[}\]]$/.test(line.trim()) && line.length > 1000) return 'minified-json'
  if (/^[0-9a-f]{64,}$/i.test(line.trim())) return 'hex-dump'
  if (/^<Objs\b/.test(line.trim())) return 'powershell-clixml'
  return 'unknown'
}

// 计算简单哈希（用于摘要）
function simpleHash(text: string): string {
  let hash = 0
  for (let i = 0; i < text.length; i++) {
    const char = text.charCodeAt(i)
    hash = ((hash << 5) - hash) + char
    hash = hash & hash // Convert to 32bit integer
  }
  return Math.abs(hash).toString(16).padStart(8, '0')
}

// 归一化函数（用于模板化压缩）
function normalizeLineForGrouping(line: string, level: string): string {
  if (level === 'off') return line
  
  let normalized = line
  
  // Safe 级别：只替换时间/UUID/哈希
  // ISO 时间戳
  normalized = normalized.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z?/g, '<ISO_TIME>')
  // 时间格式 HH:MM:SS
  normalized = normalized.replace(/\b\d{2}:\d{2}:\d{2}(\.\d{3})?\b/g, '<TIME>')
  // UUID
  normalized = normalized.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<UUID>')
  // 长哈希（8位以上）
  normalized = normalized.replace(/\b[0-9a-f]{8,}\b/gi, '<HEX>')
  
  if (level === 'aggressive') {
    // Aggressive 级别：还替换数字/路径/端口/大小
    // 端口号
    normalized = normalized.replace(/:\d{2,5}\b/g, ':<PORT>')
    // 文件大小
    normalized = normalized.replace(/\b\d+(\.\d+)?\s*(B|KB|MB|GB|TB|bytes?)\b/gi, '<SIZE>')
    // 持续时间
    normalized = normalized.replace(/\b\d+(\.\d+)?\s*(ms|s|sec|min|h|hours?|minutes?|seconds?)\b/gi, '<DURATION>')
    // 数字（只替换 4 位以上，保留错误码）
    normalized = normalized.replace(/\b\d{4,}\b/g, '<NUM>')
    // 临时路径
    normalized = normalized.replace(/\/tmp\/[^\s]+/g, '<TMPPATH>')
    normalized = normalized.replace(/C:\\Users\\[^\\]+\\AppData\\Local\\Temp\\[^\s]+/gi, '<TMPPATH>')
  }
  
  return normalized
}

// 模板化近重复压缩
function compressTemplateRuns(lines: string[], config: CompressionConfig): { lines: string[]; groups: number } {
  if (config.templateNormalizationLevel === 'off') {
    return { lines, groups: 0 }
  }
  
  const out: string[] = []
  let groups = 0
  let i = 0
  
  while (i < lines.length) {
    const line = lines[i]
    const template = normalizeLineForGrouping(line, config.templateNormalizationLevel)
    
    // 向后扫描相同模板
    let j = i + 1
    while (j < lines.length && normalizeLineForGrouping(lines[j], config.templateNormalizationLevel) === template) {
      j++
    }
    
    const count = j - i
    
    // 达到阈值且模板化后确实有变化（不是完全相同）
    // 同时不压缩包含错误关键词的行
    const hasErrorKeywords = /error|failed|assert|exception/i.test(line)
    if (count >= config.minTemplateRepeats && template !== line && !hasErrorKeywords) {
      const originalLines = lines.slice(i, j)
      const replacementLines = [
        `... [template repeated ${count} times: ${quotePattern(template, 60)}]`,
        `    first: ${lines[i]}`,
        `    last:  ${lines[j - 1]}`
      ]
      
      const score = scoreReplacement(
        serializeLines(originalLines),
        serializeLines(replacementLines),
        config
      )
      
      if (score.profitable) {
        out.push(...replacementLines)
        groups++
        i = j
        continue
      }
    }
    
    out.push(line)
    i++
  }
  
  return { lines: out, groups }
}

// 高熵长行压缩
function compressHighEntropyLines(lines: string[], config: CompressionConfig): { lines: string[]; groups: number } {
  let groups = 0
  
  const next = lines.map(line => {
    if (!isHighEntropyLine(line, config)) return line
    
    const type = detectHighEntropyType(line)
    const hash = simpleHash(line)
    const prefix = line.slice(0, 20)
    const suffix = line.slice(-20)
    const bytes = byteLen(line)
    
    const replacement = `<high-entropy ${type} omitted: ${bytes} bytes, hash=${hash}, prefix="${prefix}...", suffix="...${suffix}">`
    
    const score = scoreReplacement(line, replacement, config)
    if (score.profitable) {
      groups++
      return replacement
    }
    
    return line
  })
  
  return { lines: next, groups }
}

// ==================== Phase 4: 行内压缩增强 ====================

// 压缩进度条
function compressProgressBars(line: string, config: CompressionConfig): { line: string; applied: boolean } {
  // 检测常见进度条模式
  const patterns = [
    { regex: /([=\-#█▓▒░])\1{20,}/, name: 'bar' },
    { regex: /(\.)\1{20,}/, name: 'dots' },
    { regex: /([▁▂▃▄▅▆▇█])\1{10,}/, name: 'blocks' },
  ]
  
  for (const { regex, name } of patterns) {
    const match = regex.exec(line)
    if (match) {
      const char = match[1]
      const count = match[0].length
      const replacement = `[${name} ${count}×"${char}"]`
      
      const score = scoreReplacement(match[0], replacement, config)
      if (score.profitable) {
        return {
          line: line.replace(match[0], replacement),
          applied: true
        }
      }
    }
  }
  
  return { line, applied: false }
}

// 压缩长分隔列表
function compressLongLists(line: string, config: CompressionConfig): { line: string; applied: boolean } {
  // 检测逗号分隔的长列表
  const items = line.split(/,\s*/)
  if (items.length < 10) return { line, applied: false }
  
  const totalBytes = byteLen(line)
  if (totalBytes < 200) return { line, applied: false }
  
  // 保留前 3 个和后 3 个
  const kept = [...items.slice(0, 3), `... (${items.length - 6} more)`, ...items.slice(-3)]
  const replacement = kept.join(', ')
  
  const score = scoreReplacement(line, replacement, config)
  if (score.profitable) {
    return { line: replacement, applied: true }
  }
  
  return { line, applied: false }
}

// 遍历每一行执行行内压缩（增强版：进度条 + 长列表 + 通用模式）
function compressInlinePatterns(lines: string[], config: CompressionConfig): { lines: string[]; groups: number } {
  let groups = 0
  
  const next = lines.map(line => {
    // 1. 先尝试进度条压缩
    let result = compressProgressBars(line, config)
    if (result.applied) {
      groups++
      return result.line
    }
    
    // 2. 再尝试长列表压缩
    result = compressLongLists(line, config)
    if (result.applied) {
      groups++
      return result.line
    }
    
    // 3. 最后尝试通用行内模式压缩
    result = compressInlineLine(line, config)
    if (result.applied) groups++
    return result.line
  })

  return { lines: next, groups }
}

// 粗略判断这段文本是否值得送进压缩流程，避免对很小的输出浪费 CPU
export function shouldCompressOutput(text: string) {
  if (!text) return false
  if (byteLen(text) < 200) return false

  if (text.includes("\r")) return true

  let newlines = 0
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) newlines++
    if (newlines >= 5) return true
  }

  return text.length >= DEFAULT_COMPRESSION_CONFIG.minInlineRunBytes
}

const POWER_SHELL_CLIXML_HEADER_RE = /^\s*#<\s*CLIXML(?:\r?\n|$)/i
const POWER_SHELL_CLIXML_BLOCK_RE = /(?:#<\s*CLIXML(?:\r?\n)?)?<Objs\b[\s\S]*?<\/Objs>/gi
const POWER_SHELL_CLIXML_TEXT_NODE_RE = /<(S|ToString)\b([^>]*)>([\s\S]*?)<\/\1>/gi
const POWER_SHELL_CLIXML_MEANINGFUL_NAMES = new Set([
  "message",
  "tostring",
  "exception",
  "errordetails",
  "positionmessage",
  "fullyqualifiederrorid",
  "scriptstacktrace",
  "stacktrace",
  "line",
  "statement",
  "command",
  "value",
  "path",
  "targetobject",
  "categoryinfo",
])

/**
 * Detects and decodes PowerShell CLIXML output back to plain text.
 * CLIXML is PowerShell's XML-based error/info serialization format that usually
 * starts with `#< CLIXML` and wraps visible text inside `<Objs>...<S ...>...`.
 *
 * Returns decoded multi-line text wrapped in `<high-entropy powershell-clixml>`
 * if the input is recognized CLIXML, or null otherwise.
 */
function transformPowerShellClixml(text: string): string | null {
  let changed = false
  const next = text.replace(POWER_SHELL_CLIXML_BLOCK_RE, (block) => {
    const decoded = decodePowerShellClixmlBlock(block)
    if (!decoded) return block
    changed = true
    return decoded
  })

  return changed ? next : null
}

function decodePowerShellClixmlBlock(block: string): string | null {
  const plain = decodePowerShellClixmlPlain(block)
  if (!plain) return null

  return `<high-entropy powershell-clixml>${plain}</high-entropy>`
}

function decodePowerShellClixmlPlain(block: string): string | null {
  if (!isPurePowerShellClixmlBlock(block)) return null

  const body = block.replace(POWER_SHELL_CLIXML_HEADER_RE, "")

  const parts = extractPowerShellClixmlText(body)
  if (parts.length === 0) return null

  let plain = parts.join("\n")
  plain = plain.replace(ANSI_GLOBAL_RE, "")
  // Collapse any \r\n → \n left over from the decode
  plain = plain.replace(/\r\n?/g, "\n")
  plain = plain.trimEnd()

  if (!plain) return null

  return plain
}

// Only decode CLIXML blocks that are structurally pure XML-ish payloads.
// Mixed blocks with plain stdout inside them are left untouched so we never swallow real command output.
function isPurePowerShellClixmlBlock(block: string) {
  const body = block.replace(POWER_SHELL_CLIXML_HEADER_RE, "")
  const lines = body.split(/\r?\n/)
  let sawXml = false

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    if (trimmed.startsWith("<Objs") || trimmed.startsWith("</Objs>")) {
      sawXml = true
      continue
    }
    if (trimmed.startsWith("<")) {
      sawXml = true
      continue
    }
    return false
  }

  return sawXml
}

function extractPowerShellClixmlText(text: string) {
  const collect = (fallback: boolean) => {
    POWER_SHELL_CLIXML_TEXT_NODE_RE.lastIndex = 0
    const parts: string[] = []
    let match: RegExpExecArray | null

    while ((match = POWER_SHELL_CLIXML_TEXT_NODE_RE.exec(text)) !== null) {
      const nodeType = match[1]
      const attrs = match[2]
      const raw = match[3]
      const name = /(?:^|\s)(?:N|S)="([^"]+)"/i.exec(attrs)?.[1]?.toLowerCase()
      if (nodeType === "S" && !fallback && (!name || !POWER_SHELL_CLIXML_MEANINGFUL_NAMES.has(name))) continue

      const decoded = clixmlDecodeHexEscapes(decodeXmlEntities(raw)).trimEnd()
      if (decoded.trim().length === 0 || parts.at(-1) === decoded) continue
      parts.push(decoded)
    }

    return parts
  }

  const parts = collect(false)
  if (parts.length > 0) return parts
  return collect(true)
}

function decodeXmlEntities(value: string) {
  return value.replace(/&(lt|gt|amp|quot|apos);/g, (_, entity) => {
    if (entity === "lt") return "<"
    if (entity === "gt") return ">"
    if (entity === "amp") return "&"
    if (entity === "quot") return '"'
    return "'"
  })
}

/** Decodes PowerShell _xHHHH_ hex escape sequences in CLIXML text nodes. */
function clixmlDecodeHexEscapes(value: string): string {
  return value.replace(/_x([0-9A-Fa-f]{4,})_/g, (_, hex) => {
    const num = parseInt(hex, 16)
    // preserve printable ASCII range; pass non-printable control chars as-is (ANSI strip runs after)
    return String.fromCharCode(num)
  })
}

/**
 * 主入口：压缩传入的可见文本，返回压缩后的文本以及详细的统计信息
 * 优化后的流水线顺序：Secret redaction → 虚拟终端渲染 → 模板化压缩 → 多行块 → 单行重复 → 高熵长行 → 行内模式
 */
export function compressVisibleOutput(text: string, configInput?: Partial<CompressionConfig>): CompressResult {
  const config = configOf(configInput)
  const originalBytes = byteLen(text)

  const emptyStats: CompressionStats = {
    originalBytes,
    compressedBytes: originalBytes,
    savedBytes: 0,
    savingRatio: 0,
    carriageReturnGroups: 0,
    repeatedBlockGroups: 0,
    repeatedLineGroups: 0,
    templateGroups: 0,
    inlinePatternGroups: 0,
    highEntropyLines: 0,
    secretsRedacted: 0,
    applied: false,
  }

  // 0a: PowerShell CLIXML — decode back to plain text before the main pipeline.
  const clixml = transformPowerShellClixml(text)
  if (clixml) {
    const compressedBytes = byteLen(clixml)
    return {
      text: clixml,
      stats: {
        ...emptyStats,
        compressedBytes,
        savedBytes: originalBytes - compressedBytes,
        savingRatio: originalBytes > 0 ? (originalBytes - compressedBytes) / originalBytes : 0,
        highEntropyLines: 1,
        applied: true,
      },
    }
  }

  // 禁用或不值得压缩时直接返回
  if (!config.enabled || !shouldCompressOutput(text)) {
    return { text, stats: emptyStats }
  }

  // 第零步：Secret redaction（最早执行，避免敏感信息进入后续流程）
  const { text: redactedText, redacted: secretsRedacted } = redactSecrets(text)

  // 第一步：虚拟终端渲染（处理 ANSI 控制序列和回车）
  const cr = collapseCarriageReturns(redactedText, config)
  let lines = cr.text.split("\n")

  // 第二步：模板化近重复压缩（在精确重复之前，避免模板被误判为不重复）
  const template = compressTemplateRuns(lines, config)
  lines = template.lines

  // 第三步：压缩大块多行重复
  const blocks = compressRepeatedBlocks(lines, config)
  lines = blocks.lines

  // 第四步：压缩单行连续重复
  const same = compressSameLines(lines, config)
  lines = same.lines

  // 第五步：压缩高熵长行（在行内模式之前，避免对 base64 做无效扫描）
  const highEntropy = compressHighEntropyLines(lines, config)
  lines = highEntropy.lines

  // 第六步：压缩行内重复字符
  const inline = compressInlinePatterns(lines, config)
  lines = inline.lines

  const compressed = lines.join("\n")
  const compressedBytes = byteLen(compressed)
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
    templateGroups: template.groups,
    inlinePatternGroups: inline.groups,
    highEntropyLines: highEntropy.groups,
    secretsRedacted,
    applied:
      compressedBytes < originalBytes &&
      (cr.groups > 0 || blocks.groups > 0 || same.groups > 0 || template.groups > 0 || inline.groups > 0 || highEntropy.groups > 0),
  }

  return {
    text: stats.applied ? compressed : text,
    stats: stats.applied ? stats : emptyStats,
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
}

// 判定是否是类似报错行（增强版，带上下文感知）
function isErrorLike(line: string, prevLine?: string, nextLine?: string) {
  // 先检查是否是健康指标
  if (HEALTHY_INDICATOR_RE.test(line)) return false
  
  // 如果是 "0 errors" 等不视为报错
  if (ZERO_PROBLEM_RE.test(line) && !FATAL_LIKE_RE.test(line)) return false
  
  // 检查是否是注释中的 "error"
  if (/^\s*(#|\/\/|\/\*|\*).*error/i.test(line)) return false
  
  // 检查是否是文档/示例中的 "error"
  if (/example|sample|demo|test.*should.*error/i.test(line)) return false
  
  // 检查是否是日志级别配置
  if (/log.*level.*error|error.*level/i.test(line)) return false
  
  // 检查前后文是否表明这是预期行为
  if (prevLine && /expect|should|test/i.test(prevLine)) return false
  
  return ERROR_LIKE_RE.test(line)
}

// 判定是否是类似警告行
function isWarningLike(line: string) {
  if (HEALTHY_INDICATOR_RE.test(line)) return false
  if (ZERO_PROBLEM_RE.test(line) && !FATAL_LIKE_RE.test(line)) return false
  return WARNING_LIKE_RE.test(line)
}

// 判定是否是包含栈追踪、断言失败等强烈致死关键词的行
function isFatalLike(line: string) {
  return FATAL_LIKE_RE.test(line)
}

// 错误分级评分系统
function scoreErrorLine(text: string): number {
  if (FATAL_LIKE_RE.test(text)) return 100
  if (COMPILE_ERROR_RE.test(text)) return 80
  if (INFRA_ERROR_RE.test(text)) return 70
  if (ERROR_LIKE_RE.test(text)) return 60
  if (WARNING_LIKE_RE.test(text)) return 30
  return 0
}

/**
 * 流式诊断信息收集器（增强版：三队列机制）。
 *
 * 它以极小的内存占用模式工作：
 *   - 前几行信息的一个小型环形缓冲区 (prev)
 *   - 少数处于活跃状态、正在等待后续错误上下文的块 (active)
 *   - 三个独立队列：first（最早错误）、fatal（致命错误）、recent（最近错误）
 *
 * 它不需要把整个几十兆的文件都放到内存，而是顺着 chunk 分片一边看一边丢掉正常日志。
 */
export class BashDiagnosticCollector {
  private pending = ""        // 分片读取拼接用的残余文本缓冲
  private lineNo = 0          // 绝对行号计数器
  private prev: Ring<LineRecord>  // 保存最近遍历过的上文（比如当前行的前 3 行）
  
  // 三个独立队列
  private contextsFirst: Ring<DiagnosticContext>   // 最早的 3 个错误
  private contextsFatal: Ring<DiagnosticContext>   // 所有 fatal/panic
  private contextsRecent: Ring<DiagnosticContext>  // 最近的 5 个错误
  
  private active: ActiveContext[] = [] // 当前正在等待"后文"的上下文列表

  private errorCount = 0      // 出现报错关键词的行数
  private warningCount = 0    // 出现警告关键词的行数
  private fatalCount = 0      // 出现致命错误的行数

  private readonly config: CompressionConfig

  constructor(configInput?: Partial<CompressionConfig>) {
    this.config = configOf(configInput)
    // 上文环形队列的长度为配置的半径
    this.prev = new Ring<LineRecord>(this.config.diagnosticContextRadius)
    
    // 初始化三个独立队列
    this.contextsFirst = new Ring<DiagnosticContext>(3)
    this.contextsFatal = new Ring<DiagnosticContext>(5)  // Fatal 错误最多保留 5 个
    this.contextsRecent = new Ring<DiagnosticContext>(Math.max(this.config.maxDiagnosticContexts, 5))
  }

  // 接收从控制台流中涌来的 chunk 字符串
  push(chunk: string) {
    if (!chunk) return

    this.pending += chunk

    while (true) {
      const idx = this.pending.indexOf("\n")
      if (idx < 0) break // 没遇到换行则等下一次 chunk 再拼

      // 提取完整的一行并削去 \r
      const line = this.pending.slice(0, idx).replace(/\r$/, "")
      this.pending = this.pending.slice(idx + 1)
      this.observeLine(line)
    }
  }

  // 命令结束时收尾，把残余缓冲里的最后半行消化掉
  end() {
    if (this.pending.length > 0) {
      this.observeLine(this.pending.replace(/\r$/, ""))
      this.pending = ""
    }

    // 强行关闭所有还处于 active 等待后文状态的上下文
    for (const ctx of this.active) this.finalizeContext(ctx)
    this.active = []
  }

  // 生成最终快照，返回合并、去重之后的诊断上下文
  snapshot(): DiagnosticSnapshot {
    const firstContexts = this.mergeContexts(this.contextsFirst.values())
    const fatalContexts = this.mergeContexts(this.contextsFatal.values())
    const recentContexts = this.mergeContexts(this.contextsRecent.values())
    
    // 合并所有上下文并去重
    const allContexts = [...firstContexts, ...fatalContexts, ...recentContexts]
    const merged = this.mergeContexts(allContexts).slice(-this.config.maxDiagnosticContexts)
    
    return {
      totalLines: this.lineNo,
      errorLikeLines: this.errorCount,
      warningLikeLines: this.warningCount,
      fatalLikeLines: this.fatalCount,
      contexts: merged,
      firstErrorContexts: firstContexts,
      fatalContexts: fatalContexts,
      recentErrorContexts: recentContexts,
    }
  }

  // 核心处理单行的逻辑（增强版：三队列 + 错误评分）
  private observeLine(text: string) {
    const record: LineRecord = { no: this.lineNo + 1, text }

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
    this.active = stillActive

    // 获取前一行用于上下文感知
    const prevLine = this.prev.values()[this.prev.values().length - 1]?.text

    // 统计各种警示关键词出现的频率
    if (isWarningLike(text)) this.warningCount++

    const score = scoreErrorLine(text)
    
    if (score >= 60 || isErrorLike(text, prevLine)) {
      this.errorCount++
      if (score >= 100 || isFatalLike(text)) this.fatalCount++

      // 当前行是一个报错，新建一个等待捕获后文的活跃上下文
      const ctx: ActiveContext = {
        centerLine: record.no,
        // 把环形队列里保留的上文全部带进来，再加上当前这一行
        lines: [...this.prev.values(), record],
        // 设置还需要收集多少个后文行
        remainingAfter: this.config.diagnosticContextRadius,
      }

      // 特殊情况：半径配了 0，直接结束收集
      if (ctx.remainingAfter <= 0) {
        this.finalizeContextWithPriority(ctx, score)
      } else {
        this.active.push(ctx)
      }
    } else if (isFatalLike(text)) {
      // 即使没明确报 Error 关键词，如果有致命错误也进行统计
      this.fatalCount++
    }

    // 把当前行压入"前文环形缓冲区"，为未来的报错作铺垫
    this.prev.push(record)
    this.lineNo++
  }

  // 将收集完上文下文的活跃块封存到结果池中（增强版：根据优先级分配队列）
  private finalizeContext(ctx: ActiveContext) {
    const centerText = ctx.lines.find(l => l.no === ctx.centerLine)?.text || ''
    const score = scoreErrorLine(centerText)
    this.finalizeContextWithPriority(ctx, score)
  }
  
  private finalizeContextWithPriority(ctx: ActiveContext, score: number) {
    const diagnosticCtx: DiagnosticContext = {
      centerLine: ctx.centerLine,
      lines: ctx.lines,
      priority: score >= 100 ? 'fatal' : this.errorCount <= 3 ? 'first' : 'recent',
    }
    
    // 根据优先级分配到不同队列
    if (score >= 100) {
      // Fatal 错误单独保存
      this.contextsFatal.push(diagnosticCtx)
    }
    
    if (this.errorCount <= 3) {
      // 前 3 个错误保存到 first 队列
      this.contextsFirst.push(diagnosticCtx)
    }
    
    // 所有错误都进 recent 队列
    this.contextsRecent.push(diagnosticCtx)
  }

  // 合并重叠上下文：比如行号 10 报错，保留了 7~13；紧接着 12 又报错，保留了 9~15，
  // 它们就会交织在一起。这个方法把它们无缝拼成一个 7~15 的大块。
  private mergeContexts(contexts: DiagnosticContext[]) {
    if (contexts.length <= 1) return contexts

    // 按照行号升序排列
    const sorted = [...contexts].sort((a, b) => {
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
        const byNo = new Map<number, LineRecord>()
        for (const line of last.lines) byNo.set(line.no, line)
        for (const line of ctx.lines) byNo.set(line.no, line)

        // 生成合并去重后的新行集合
        last.lines = [...byNo.values()].sort((a, b) => a.no - b.no)
        // 保留更靠后的中心点
        last.centerLine = ctx.centerLine
      } else {
        // 如果断开了，作为新的独立块压入
        out.push(ctx)
      }
    }

    return out
  }
}

// 将错误上下文集合格式化为字符串，方便追加到最后的 Bash 输出中（增强版：带优先级标签）
function renderDiagnosticContexts(contexts: DiagnosticContext[], config: CompressionConfig) {
  const out: string[] = []
  out.push("<bash_high_signal_excerpt>")
  out.push("Error contexts not fully visible above:")

  for (const ctx of contexts) {
    const first = ctx.lines[0]?.no ?? ctx.centerLine
    const last = ctx.lines[ctx.lines.length - 1]?.no ?? ctx.centerLine
    const priorityLabel = ctx.priority === 'first' ? ' (root cause)' : 
                         ctx.priority === 'fatal' ? ' (fatal)' : ''
    out.push("")
    out.push(`[L${first}-L${last}]${priorityLabel}`)

    for (const line of ctx.lines) {
      // 对于命中的那一核心行，使用 > 进行强调
      const marker = line.no === ctx.centerLine ? ">" : " "
      out.push(`${marker} ${line.no} | ${truncateOneLine(line.text, config.diagnosticLineMaxChars)}`)
    }
  }

  out.push("</bash_high_signal_excerpt>")
  return out.join("\n")
}

/**
 * 组装并渲染完整的诊断附录（Appendix），作为 Bash 输出结尾的后缀。
 * 调用方只传入最终输出隐藏掉的文本生成的 snapshot；因此这里不和
 * visible output 做二次比对，避免诊断摘录与 exit notice 互相推断。
 * 优化：只在命令失败或有致命错误时才输出诊断信息，避免成功时的 token 浪费。
 */
export function renderDiagnosticAppendix(snapshot: DiagnosticSnapshot, options: RenderAppendixOptions) {
  const config = configOf(options.config)

  // 判断命令执行的时间和退出状态是否值得附带高价值摘录
  const longEnough = options.durationMs >= config.diagnosticMinRuntimeMs
  const abnormalExit = options.exitCode !== 0
  const hasStrongSignal = snapshot.fatalLikeLines > 0 || snapshot.errorLikeLines > 0

  // 关键优化：只在命令失败或有致命错误时才输出诊断
  const shouldShowDiagnostics = longEnough && hasStrongSignal && (abnormalExit || snapshot.fatalLikeLines > 0)

  if (!shouldShowDiagnostics) {
    return '' // 成功时不输出诊断附录，节省 token
  }

  // 优先级排序：first > fatal > recent
  const priorityContexts = [
    ...snapshot.firstErrorContexts,
    ...snapshot.fatalContexts,
    ...snapshot.recentErrorContexts,
  ]

  // 去重并限制数量
  const uniqueContexts = Array.from(
    new Map(priorityContexts.map(ctx => [ctx.centerLine, ctx])).values()
  ).slice(0, config.maxDiagnosticContexts)

  if (uniqueContexts.length === 0) {
    return ''
  }

  const parts: string[] = []
  parts.push(renderDiagnosticContexts(uniqueContexts, config))

  return parts.join("\n\n")
}

/**
 * Normalize PowerShell CLIXML back to plain text while preserving surrounding stdout.
 * Pure CLIXML blocks are decoded; mixed blocks are left untouched to avoid losing real output.
 */
export function normalizePowerShellOutput(text: string) {
  let changed = false
  const next = text.replace(POWER_SHELL_CLIXML_BLOCK_RE, (block) => {
    const decoded = decodePowerShellClixmlPlain(block)
    if (!decoded) return block
    changed = true
    return decoded
  })

  return changed ? next : text
}

/**
 * 组装压缩相关的数据统计用于返回在最终命令的工具元数据内
 */
export function bashCompressionMetadata(stats: CompressionStats) {
  return {
    compressed: stats.applied,
    compressionOriginalBytes: stats.originalBytes,
    compressionCompressedBytes: stats.compressedBytes,
    compressionSavedBytes: stats.savedBytes,
    compressionSavingRatio: stats.savingRatio,
    compressionCarriageReturnGroups: stats.carriageReturnGroups,
    compressionRepeatedBlockGroups: stats.repeatedBlockGroups,
    compressionRepeatedLineGroups: stats.repeatedLineGroups,
    compressionTemplateGroups: stats.templateGroups,
    compressionInlinePatternGroups: stats.inlinePatternGroups,
    compressionHighEntropyLines: stats.highEntropyLines,
    compressionSecretsRedacted: stats.secretsRedacted,
  }
}
