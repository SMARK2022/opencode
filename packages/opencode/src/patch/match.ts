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

type NormalizedText = {
  points: string[]
  rawStarts: number[]
  rawEnds: number[]
}

type CandidateSpan = { start: number; end: number }

type MatchState = {
  distance: number
  span: CandidateSpan
  hasDistinctEqualSpan: boolean
}

function normalizeText(text: string): NormalizedText {
  // DP 只在 code-point 空间计算距离；raw 边界单独保留，避免 astral 字符和 CRLF 被误当成 UTF-16 单元。
  // 每个 normalized point 都对应一个连续原文区间，renderer 只能使用这张映射，不能重新搜索候选。
  const points: string[] = []
  const rawStarts: number[] = []
  const rawEnds: number[] = []

  for (let offset = 0; offset < text.length;) {
    const start = offset
    const codePoint = text.codePointAt(offset)!
    const value = String.fromCodePoint(codePoint)
    offset += value.length
    if (codePoint === 13 && text[offset] === "\n") offset++
    points.push(codePoint === 10 || codePoint === 13 ? "\n" : value)
    rawStarts.push(start)
    rawEnds.push(offset)
  }

  return { points, rawStarts, rawEnds }
}

function sameSpan(left: CandidateSpan | undefined, right: CandidateSpan | undefined) {
  return left?.start === right?.start && left?.end === right?.end
}

function chooseState(left: MatchState, right: MatchState): MatchState {
  if (left.distance < right.distance) return left
  if (right.distance < left.distance) return right
  // 同一 span 的多条最短路径是等价证据；不同 span 必须保留 tie 状态，不能由转移顺序代表文件位置。
  // 该合并只发生在同一个 DP 单元，不会把距离更差的候选带入最终结果。
  if (sameSpan(left.span, right.span)) {
    return { ...left, hasDistinctEqualSpan: left.hasDistinctEqualSpan || right.hasDistinctEqualSpan }
  }
  return { ...left, hasDistinctEqualSpan: true }
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
  if (expected.length !== candidate.length) return ""

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

// DP 的第一行允许跳过全文前缀；最终距离因此代表 expected 到任意连续子串的最小编辑距离。
// span 的等距分支只记录“存在其他位置”，不会用转移顺序猜测唯一候选。
// 末尾扫描必须先聚合全局最小距离，再统一应用 tie 和 reliability，不能提前返回第一个最优终点。
export function closestWindow(content: string, expected: string): ClosestWindow | undefined {
  const expectedLines = expected.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n")
  if (expectedLines.length === 0 || expectedLines.every((line) => line.trim() === "")) return undefined

  const text = normalizeText(content)
  const pattern = normalizeText(expected).points
  if (pattern.length === 0 || text.points.length === 0) return undefined

  let previous: Array<MatchState | undefined> = Array.from({ length: text.points.length + 1 }, () => undefined)

  for (let patternIndex = 1; patternIndex <= pattern.length; patternIndex++) {
    const current: Array<MatchState | undefined> = [undefined]

    for (let textIndex = 1; textIndex <= text.points.length; textIndex++) {
      // 删除前置 expected 字符后从当前 text 字符启动候选，保留“尚未消费 text 前缀”的路径。
      // 该 empty predecessor 是内部子串能够成为等距候选的必要状态，不能被上一格 active span 覆盖。
      let state: MatchState = {
        distance: patternIndex - 1 + (pattern[patternIndex - 1] === text.points[textIndex - 1] ? 0 : 1),
        span: { start: textIndex - 1, end: textIndex },
        hasDistinctEqualSpan: false,
      }

      const deletionSource = previous[textIndex]
      if (deletionSource) {
        // deletion 延续同一连续候选，只增加 expected 消耗；它不能缩短 span 或回到已消费的 text。
        state = chooseState(state, {
          distance: deletionSource.distance + 1,
          span: deletionSource.span,
          hasDistinctEqualSpan: deletionSource.hasDistinctEqualSpan,
        })
      }

      const insertionSource = current[textIndex - 1]
      if (insertionSource) {
        // insertion 只延长当前候选尾部；候选起点只能由 pair 或 empty transition 决定。
        state = chooseState(state, {
          distance: insertionSource.distance + 1,
          span: { start: insertionSource.span.start, end: textIndex },
          hasDistinctEqualSpan: insertionSource.hasDistinctEqualSpan,
        })
      }

      const pairSource = previous[textIndex - 1]
      if (pairSource) {
        // pair 是唯一同时消费新 expected/text point 的对角转移，比较单位保持为 code point。
        state = chooseState(state, {
          distance: pairSource.distance + (pattern[patternIndex - 1] === text.points[textIndex - 1] ? 0 : 1),
          span: { start: pairSource.span.start, end: textIndex },
          hasDistinctEqualSpan: pairSource.hasDistinctEqualSpan,
        })
      }
      current.push(state)
    }

    previous = current
  }

  let bestDistance = Number.POSITIVE_INFINITY
  const spans = new Map<string, CandidateSpan>()
  let tied = false
  for (const state of previous) {
    if (!state?.span) continue
    if (state.distance < bestDistance) {
      bestDistance = state.distance
      spans.clear()
      spans.set(`${state.span.start}:${state.span.end}`, state.span)
      tied = state.hasDistinctEqualSpan
      continue
    }
    if (state.distance !== bestDistance) continue
    if (state.hasDistinctEqualSpan) tied = true
    spans.set(`${state.span.start}:${state.span.end}`, state.span)
  }

  if (!Number.isFinite(bestDistance) || tied || spans.size !== 1) return undefined
  const span = spans.values().next().value as CandidateSpan
  const candidatePointLength = span.end - span.start
  // 分母同时包含 expected 与候选长度，插入/删除的可靠性不会因候选变长而超过 1。
  // 只应用一次既有阈值；低分结果不能通过缩短 excerpt、重排候选或再次搜索获得展示资格。
  const score = 1 - bestDistance / Math.max(pattern.length, candidatePointLength)
  if (score < 0.5) return undefined

  const rawStart = text.rawStarts[span.start]
  const rawEnd = text.rawEnds[span.end - 1]
  const candidateText = content.slice(rawStart, rawEnd)
  // 零距离等价必须比较同一 normalized points；raw includes 会把 CRLF 与 LF 误判为不同文本。
  // Patch expected 来自 LF 行数组，CRLF raw span 仍可被证明是同一块原始文本，不能因此回显 expected。
  // raw candidate 只用于展示证据，等价判断不依赖第二次搜索或另一套归一化规则。
  const isEquivalentCandidate =
    candidatePointLength === pattern.length && pattern.every((point, index) => text.points[span.start + index] === point)
  const renderStart = Math.max(content.lastIndexOf("\n", rawStart - 1), content.lastIndexOf("\r", rawStart - 1)) + 1
  const nextLF = content.indexOf("\n", rawEnd)
  const nextCR = content.indexOf("\r", rawEnd)
  const lineEnd = [nextLF, nextCR].filter((index) => index !== -1).reduce((min, index) => Math.min(min, index), content.length)
  const renderedText = content.slice(renderStart, lineEnd).replaceAll("\r\n", "\n").replaceAll("\r", "\n")
  const candidate = renderedText.split("\n")
  const line = content.slice(0, renderStart).split(/\r\n|\r|\n/).length
  // 展示扩展只改变上下文范围，不改变 score、line 起点或 raw 边界，因此提示与选择始终来自同一候选。
  // 变长分支直接截取 DP raw span，完整行只服务等行数列差异，避免长前后缀遮蔽已证明的 actual。
  // raw span 可能只是行内片段；展示时扩展到包含行，但 candidateText 仍来自 DP span，候选身份不会漂移。
  // 只有行数相同才计算列差异；变长窗口直接展示同一 raw span，renderer 不得自行选择另一段文本。
  const excerpt = isEquivalentCandidate
    ? "Exact requested text exists at this location in the original file but is unavailable to the current patch step."
    : candidate.length === expectedLines.length
      ? formatClosestDifference(expectedLines, candidate, line) || truncateExcerpt(renderedText, 500)
      : truncateExcerpt(candidateText, 500)

  return { line, excerpt: truncateExcerpt(excerpt, 500), score }
}
