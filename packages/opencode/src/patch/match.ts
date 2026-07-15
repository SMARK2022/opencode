import { diffChars } from "diff"

export type ExactLocation =
  | { kind: "line"; startLine: number; endLine: number }
  | { kind: "substring"; startOffset: number; endOffset: number }

export type ExactResult =
  | { type: "found"; location: ExactLocation }
  | { type: "not-found" }
  | { type: "ambiguous" }

// 行起点统一从当前 working lines 推导，避免前一次替换后继续使用失效的原始坐标。
// index 等于行数时表示逻辑文本末尾，供删除和 replacement 后的 cursor 使用。
export function lineOffset(lines: string[], index: number) {
  // 此 helper 只处理单个 replacement cursor；批量行起点必须走 locateExact 的线性累计路径。
  if (index <= 0) return 0
  if (index >= lines.length) return lines.join("\n").length
  return lines.slice(0, index).reduce((offset, line) => offset + line.length + 1, 0)
}

export function nextLineOffset(text: string, offset: number) {
  // substring context 即使只命中行内后缀也消费整个包含行，避免 old block 回头重匹配 context。
  const newline = text.indexOf("\n", offset)
  return newline === -1 ? text.length : newline + 1
}

// 成功域只有两层：完整整行窗口优先，其后才搜索完整旧块的唯一字面 occurrence。
// 诊断相似度绝不能进入这里，否则会把提示算法重新变成隐式 replacement fallback。
export function locateExact(
  lines: string[],
  pattern: string[],
  cursorOffset: number,
  eof = false,
  terminated = false,
): ExactResult {
  if (pattern.length === 0) return { type: "not-found" }

  // 单次累计全部行起点，避免大文件诊断前的 exact scan 因重复 slice/reduce 退化为二次复杂度。
  const starts: number[] = []
  let offset = 0
  for (const line of lines) {
    starts.push(offset)
    offset += line.length + 1
  }
  // cursor 落在一行内部时该行已被部分消费，whole-line 分支只能从下一个完整行起点继续。
  const firstEligibleLine = starts.findIndex((offset) => offset >= cursorOffset)
  const startLine = firstEligibleLine === -1 ? lines.length : firstEligibleLine
  const matchesAt = (index: number) =>
    index >= startLine &&
    index + pattern.length <= lines.length &&
    pattern.every((line, patternIndex) => lines[index + patternIndex] === line)

  // EOF 只改变精确整行分支的优先位置，不能放宽后续 substring 的唯一性。
  const fromEnd = lines.length - pattern.length
  if (eof && matchesAt(fromEnd)) {
    return { type: "found", location: { kind: "line", startLine: fromEnd, endLine: lines.length } }
  }
  for (let index = startLine; index <= fromEnd; index++) {
    if (matchesAt(index)) {
      return { type: "found", location: { kind: "line", startLine: index, endLine: index + pattern.length } }
    }
  }

  const literal = pattern.join("\n")
  // 单个空逻辑行只能由 exact-line 分支定位；空字符串有无限位置，不能进入唯一 substring 判断。
  if (literal.length === 0) return { type: "not-found" }
  // 行数组不保存文件终止符；substring 搜索必须把当前 terminal LF 恢复成真实字面文本。
  // 该 LF 只参与完整 literal，不会被 exact-line 分支误认为额外空白逻辑行。
  const text = lines.join("\n") + (terminated && lines.length > 0 ? "\n" : "")
  const first = text.indexOf(literal, cursorOffset)
  if (first === -1) return { type: "not-found" }

  // 从下一字符继续才能识别重叠 occurrence；任何第二个候选都必须拒绝而非猜第一个。
  if (text.indexOf(literal, first + 1) !== -1) return { type: "ambiguous" }
  return {
    type: "found",
    location: { kind: "substring", startOffset: first, endOffset: first + literal.length },
  }
}

export type ClosestWindow = {
  line: number
  excerpt: string
  score: number
}

function bigrams(text: string) {
  // Array.from 按 Unicode code point 切分，避免代理对被拆开后制造不存在的相似度。
  const points = Array.from(text)
  const result = new Map<string, number>()
  for (let index = 0; index < points.length - 1; index++) {
    const pair = points[index] + points[index + 1]
    result.set(pair, (result.get(pair) ?? 0) + 1)
  }
  return result
}

function similarity(expected: string, candidate: string) {
  const expectedPairs = bigrams(expected)
  const candidatePairs = bigrams(candidate)
  const expectedCount = [...expectedPairs.values()].reduce((sum, count) => sum + count, 0)
  const candidateCount = [...candidatePairs.values()].reduce((sum, count) => sum + count, 0)
  if (expectedCount === 0 || candidateCount === 0) return 0

  // multiset 取最小频次保留重复字符权重，不能退化回“出现过即可”的字符集合。
  const common = [...expectedPairs].reduce(
    (sum, [pair, count]) => sum + Math.min(count, candidatePairs.get(pair) ?? 0),
    0,
  )
  return (2 * common) / (expectedCount + candidateCount)
}

function truncateExcerpt(text: string, limit: number) {
  if (text.length <= limit) return text
  // 为 omission marker 预留固定上限，其余预算平分首尾，最终提示不会再次无标记截断。
  const visible = Math.max(0, limit - 48)
  const head = Math.ceil(visible / 2)
  const tail = Math.floor(visible / 2)
  const marker = `\n...[${text.length - head - tail} chars omitted]...\n`
  // 同时保留候选首尾，避免长行真正差异位于尾部时再次被静默截掉。
  return text.slice(0, head) + marker + text.slice(text.length - tail)
}

// Edit 与 Patch 共用此 renderer，避免同一 candidate 在两个 Tool result 中重新形成相互漂移的 expected 副本。
function formatClosestDifference(expected: string[], candidate: string[], startLine: number) {
  const output: string[] = []
  for (const [index, actual] of candidate.entries()) {
    const requested = expected[index]
    if (requested === actual) continue

    const changes = diffChars(requested, actual)
    let requestedColumn = 1
    let actualColumn = 1
    let requestedStart: number | undefined
    let requestedEnd: number | undefined
    let actualStart: number | undefined
    let actualEnd: number | undefined

    for (const change of changes) {
      const length = Array.from(change.value).length
      if (!change.added && !change.removed) {
        requestedColumn += length
        actualColumn += length
        continue
      }

      // 差异区间只输出列号；完整 requested 已由 Tool input 携带，不能借 diff 再复制到错误正文。
      requestedStart ??= requestedColumn
      actualStart ??= actualColumn
      if (change.removed) {
        requestedEnd = requestedColumn + length - 1
        requestedColumn += length
        continue
      }
      actualEnd = actualColumn + length - 1
      actualColumn += length
    }

    if (requestedStart === undefined || actualStart === undefined) continue
    const requestedLast = requestedEnd ?? requestedStart - 1
    const actualLast = actualEnd ?? actualStart - 1
    // actual excerpt 围绕首尾变化点截取，长公共前缀不会挤掉真正差异；JSON 字符串同时显式保留空白。
    const actualPoints = Array.from(actual)
    const visibleStart = Math.max(0, actualStart - 1 - 30)
    const visibleEnd = Math.min(actualPoints.length, Math.max(actualStart - 1, actualLast) + 20)
    // 两端省略数量必须显式可见，避免模型把紧凑窗口误认为完整 actual 行。
    const prefix = visibleStart > 0 ? `...[${visibleStart} chars omitted]...` : ""
    const suffix = visibleEnd < actualPoints.length ? `...[${actualPoints.length - visibleEnd} chars omitted]...` : ""
    const visible = `${prefix}${actualPoints.slice(visibleStart, visibleEnd).join("")}${suffix}`
    output.push(
      `line ${startLine + index} actual: ${JSON.stringify(visible)}`,
      `difference: requested columns ${requestedStart}-${requestedLast} differ from actual columns ${actualStart}-${actualLast}`,
    )
  }
  return output.join("\n")
}

// 诊断按完整 expected block 的行数比较窗口；有序 bigram multiset 同时惩罚无关长行和字符重排。
// 分数低于 0.5 或最佳分并列时不声称存在 closest，宁可要求重新 read 也不提供错误位置。
export function closestWindow(content: string, expected: string): ClosestWindow | undefined {
  // trim 仅用于诊断评分；返回 excerpt 始终取 raw file text，不能伪装成规范化后的文件内容。
  const lines = content.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n")
  const expectedLines = expected.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n")
  if (expectedLines.length === 0 || expectedLines.every((line) => line.trim() === "")) return undefined

  const normalizedExpected = expectedLines.map((line) => line.trim()).join("\n")
  let bestIndex = -1
  let bestScore = 0
  let tied = false
  for (let index = 0; index <= lines.length - expectedLines.length; index++) {
    const score = similarity(
      normalizedExpected,
      lines.slice(index, index + expectedLines.length).map((line) => line.trim()).join("\n"),
    )
    if (score > bestScore) {
      // 严格更高分会开启新的唯一候选；旧候选之间的 tie 不应污染新的最大值。
      bestIndex = index
      bestScore = score
      tied = false
      continue
    }
    if (score === bestScore && score > 0) tied = true
  }

  if (bestIndex === -1 || bestScore < 0.5 || tied) return undefined
  const candidate = lines.slice(bestIndex, bestIndex + expectedLines.length)
  const candidateText = candidate.join("\n")
  // working copy 可能已消费或越过原文；persisted candidate 若含完整 expected，只能报告位置而不能回显第二份文本。
  const excerpt = candidateText.includes(expected)
    ? "Exact requested text exists at this location in the original file but is unavailable to the current patch step."
    : formatClosestDifference(expectedLines, candidate, bestIndex + 1) || truncateExcerpt(candidateText, 500)
  // 行号绑定候选窗口起点而非 surrounding context 起点，修复旧 Edit 提示的 off-by-one。
  return {
    line: bestIndex + 1,
    excerpt: truncateExcerpt(excerpt, 500),
    score: bestScore,
  }
}
