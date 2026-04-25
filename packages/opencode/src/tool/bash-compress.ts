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
  inlinePatternGroups: number  // 命中的行内模式压缩次数

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
}

// 命令执行完毕后的诊断快照，汇总了各项异常指标
export type DiagnosticSnapshot = {
  totalLines: number           // 输出总行数
  errorLikeLines: number       // 包含错误关键词的行数
  warningLikeLines: number     // 包含警告关键词的行数
  fatalLikeLines: number       // 包含致命错误关键词的行数
  contexts: DiagnosticContext[]// 合并整理后的所有诊断上下文块
}

// 渲染诊断附录信息的选项
export type RenderAppendixOptions = {
  durationMs: number           // 命令执行耗时
  exitCode: number | null      // 命令退出码
  visibleOutput: string        // 当前对模型可见的已压缩、已截断输出
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

// 用于排除 "0 errors", "0 warnings" 这种健康指标行
const ZERO_PROBLEM_RE = /\b0\s+(?:errors?|failures?|warnings?)\b/i
// 匹配 ANSI 控制字符（颜色、清屏等），含有 ANSI 的行在行内压缩时被跳过
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/
const ANSI_GLOBAL_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g

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
function quotePattern(pattern: string, maxChars = 40) {
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
 * 折叠回车符（CR \r）。
 * 进度条通常使用回车（CR）来重绘同一行。
 * 我们通过按行拆分后找 \r，将前面的绘制帧丢弃，只保留最后一帧，并记录折叠了多少次重绘。
 */
function collapseCarriageReturns(text: string, config: CompressionConfig): { text: string; groups: number } {
  // 如果没有回车符直接短路返回
  if (!text.includes("\r")) return { text, groups: 0 }

  const lines = text.split("\n")
  let groups = 0
  let changed = false

  const next = lines.map((line) => {
    if (!line.includes("\r")) return line

    // 以 \r 为分隔符拆分每一帧，忽略空帧
    const frames = line.split("\r").filter((frame) => frame.length > 0)
    // 帧数不够阈值就不折叠
    if (frames.length < config.minCarriageReturnFrames) return line

    const last = frames[frames.length - 1] ?? ""
    // 插入一条说明，告诉 LLM 这里折叠了多少帧
    const replacement = `... [carriage-return progress updates collapsed: ${frames.length - 1} frames]\n${last}`
    
    // 检查这个替换操作是否划算（有些短帧折叠后可能反而体积变大）
    const score = scoreReplacement(line, replacement, config)
    if (!score.profitable) return line

    groups++
    changed = true
    return replacement
  })

  // 如果有改变则拼接回去
  return { text: changed ? next.join("\n") : text, groups }
}

// 在给定的起始索引处寻找最划算的连续重复多行块
function findRepeatedBlockAt(lines: string[], start: number, config: CompressionConfig): BlockCandidate | undefined {
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

    let repeats = 1
    let cursor = start + width

    // 向下探查看这个块重复了多少次
    while (cursor + width <= lines.length && sameBlock(lines, start, cursor, width)) {
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

// 从上到下扫描所有行，应用多行块压缩
function compressRepeatedBlocks(lines: string[], config: CompressionConfig): { lines: string[]; groups: number } {
  const out: string[] = []
  let groups = 0
  let i = 0

  while (i < lines.length) {
    // 尝试在当前 i 位置找到一个可折叠的多行块
    const candidate = findRepeatedBlockAt(lines, i, config)
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
  // 如果行超长，为避免性能问题直接跳过
  if (line.length > config.maxInlineLineLength) return { line, applied: false }
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

// 遍历每一行执行行内压缩
function compressInlinePatterns(lines: string[], config: CompressionConfig): { lines: string[]; groups: number } {
  let groups = 0
  const next = lines.map((line) => {
    const result = compressInlineLine(line, config)
    if (result.applied) groups++
    return result.line
  })

  return { lines: next, groups }
}

// 粗略判断这段文本是否值得送进压缩流程，避免对很小的输出浪费 CPU
export function shouldCompressOutput(text: string) {
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

/**
 * 主入口：压缩传入的可见文本，返回压缩后的文本以及详细的统计信息
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
    inlinePatternGroups: 0,
    applied: false,
  }

  // 禁用或不值得压缩时直接返回
  if (!config.enabled || !shouldCompressOutput(text)) {
    return { text, stats: emptyStats }
  }

  // 第一步：清理和折叠回车符刷新
  const cr = collapseCarriageReturns(text, config)
  let lines = cr.text.split("\n")

  // 第二步：压缩大块多行重复
  const blocks = compressRepeatedBlocks(lines, config)
  lines = blocks.lines

  // 第三步：压缩单行连续重复
  const same = compressSameLines(lines, config)
  lines = same.lines

  // 第四步：压缩行内重复字符
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
    inlinePatternGroups: inline.groups,
    applied:
      compressedBytes < originalBytes &&
      (cr.groups > 0 || blocks.groups > 0 || same.groups > 0 || inline.groups > 0),
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

// 判定是否是类似报错行
function isErrorLike(line: string) {
  // 如果是 "0 errors" 等不视为报错
  if (ZERO_PROBLEM_RE.test(line) && !FATAL_LIKE_RE.test(line)) return false
  return ERROR_LIKE_RE.test(line)
}

// 判定是否是类似警告行
function isWarningLike(line: string) {
  if (ZERO_PROBLEM_RE.test(line) && !FATAL_LIKE_RE.test(line)) return false
  return WARNING_LIKE_RE.test(line)
}

// 判定是否是包含栈追踪、断言失败等强烈致死关键词的行
function isFatalLike(line: string) {
  return FATAL_LIKE_RE.test(line)
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
  private lineNo = 0          // 绝对行号计数器
  private prev: Ring<LineRecord>  // 保存最近遍历过的上文（比如当前行的前 3 行）
  private contexts: Ring<DiagnosticContext> // 保存提取好的独立上下文块
  private active: ActiveContext[] = [] // 当前正在等待“后文”的上下文列表

  private errorCount = 0      // 出现报错关键词的行数
  private warningCount = 0    // 出现警告关键词的行数
  private fatalCount = 0      // 出现致命错误的行数

  private readonly config: CompressionConfig

  constructor(configInput?: Partial<CompressionConfig>) {
    this.config = configOf(configInput)
    // 上文环形队列的长度为配置的半径
    this.prev = new Ring<LineRecord>(this.config.diagnosticContextRadius)
    // 保存最终诊断上下文的环形缓冲，预留足够多的空位便于之后去重合并
    this.contexts = new Ring<DiagnosticContext>(Math.max(this.config.maxDiagnosticContexts * 3, this.config.maxDiagnosticContexts))
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

  // 生成最终快照，返回合并、去重之后的最近 N 个诊断上下文块
  snapshot(): DiagnosticSnapshot {
    return {
      totalLines: this.lineNo,
      errorLikeLines: this.errorCount,
      warningLikeLines: this.warningCount,
      fatalLikeLines: this.fatalCount,
      // 合并可能有重叠行号的上下文，然后取最后的 N 个
      contexts: this.mergeContexts(this.contexts.values()).slice(-this.config.maxDiagnosticContexts),
    }
  }

  // 核心处理单行的逻辑
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

    // 统计各种警示关键词出现的频率
    if (isWarningLike(text)) this.warningCount++

    if (isErrorLike(text)) {
      this.errorCount++
      if (isFatalLike(text)) this.fatalCount++

      // 当前行是一个报错，新建一个等待捕获后文的活跃上下文
      const ctx: ActiveContext = {
        centerLine: record.no,
        // 把环形队列里保留的上文全部带进来，再加上当前这一行
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

    // 把当前行压入“前文环形缓冲区”，为未来的报错作铺垫
    this.prev.push(record)
    this.lineNo++
  }

  // 将收集完上文下文的活跃块封存到结果池中
  private finalizeContext(ctx: ActiveContext) {
    this.contexts.push({
      centerLine: ctx.centerLine,
      lines: ctx.lines,
    })
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

// 检查某个提取出来的错误上下文是否实际上已经存在于给 LLM 可见的输出 (visibleOutput) 当中。
// 为了防止输出本就很短时还在尾部把错误内容重复打两遍，浪费 token 还会干扰模型。
function contextAlreadyVisible(ctx: DiagnosticContext, visibleOutput: string, config: CompressionConfig) {
  const center = ctx.lines.find((line) => line.no === ctx.centerLine)
  if (!center) return false

  const rawCenter = center.text
  const truncatedCenter = truncateOneLine(rawCenter, config.diagnosticLineMaxChars)
  const visibleNorm = normalizeVisibleText(visibleOutput)
  const rawNorm = normalizeVisibleText(rawCenter)
  const truncatedNorm = normalizeVisibleText(truncatedCenter)
  if (!rawNorm && !truncatedNorm) return false

  // 原文匹配优先，归一化匹配兜底，避免 ANSI、空白折叠或诊断行截断造成重复附录。
  return (
    visibleOutput.includes(rawCenter) ||
    visibleOutput.includes(truncatedCenter) ||
    visibleNorm.includes(rawNorm) ||
    visibleNorm.includes(truncatedNorm)
  )
}

// 将错误上下文集合格式化为字符串，方便追加到最后的 Bash 输出中
function renderDiagnosticContexts(contexts: DiagnosticContext[], config: CompressionConfig) {
  const out: string[] = []
  out.push("<bash_high_signal_excerpt>")
  out.push("Recent error-like contexts not fully visible above:")

  for (const ctx of contexts) {
    const first = ctx.lines[0]?.no ?? ctx.centerLine
    const last = ctx.lines[ctx.lines.length - 1]?.no ?? ctx.centerLine
    out.push("")
    out.push(`[L${first}-L${last}]`) // 打印行号区间，比如 [L500-L506]

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
 * 只返回当前可见输出中没有出现的高信号错误上下文。
 */
export function renderDiagnosticAppendix(snapshot: DiagnosticSnapshot, options: RenderAppendixOptions) {
  const config = configOf(options.config)

  // 判断命令执行的时间和退出状态是否值得附带高价值摘录
  const longEnough = options.durationMs >= config.diagnosticMinRuntimeMs
  const abnormalExit = options.exitCode !== 0
  const hasStrongSignal = snapshot.fatalLikeLines > 0 || snapshot.errorLikeLines > 0

  const shouldShowDiagnostics = longEnough && hasStrongSignal && (abnormalExit || snapshot.fatalLikeLines > 0)

  // 过滤掉在可见输出（经历过 tail 截断后的内容）中已有的上下文，避免给模型提供重复冗余的阅读负担
  const hiddenContexts = shouldShowDiagnostics
    ? snapshot.contexts.filter((ctx) => !contextAlreadyVisible(ctx, options.visibleOutput, config)).slice(-config.maxDiagnosticContexts)
    : []

  const parts: string[] = []

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
  }
}
