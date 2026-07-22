import { diffChars } from "diff"
import { normalizeForMatch } from "../tool/edit-apply"

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" })

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

// old block 的成功域由一个候选清单决定：exact literal 与 PI-normalized whole-line 共同参与唯一性。
// exact 只决定替换精度，不能跳过 normalized-equivalent 第二候选；诊断相似度永远不进入写路径。
// fuzzy 只产生 whole-line 候选，避免规范化后用 substring 吞掉未由 old block 拥有的外围字符。
export function locateExact(
  lines: string[],
  pattern: string[],
  cursorOffset: number,
  eof = false,
  terminated = false,
): ExactResult {
  if (pattern.length === 0) return { type: "not-found" }
  // EOF 只能在唯一候选已成立后表达位置偏好；全局唯一契约下无需另设提前成功分支。
  void eof

  const starts: number[] = []
  let offset = 0
  // 所有 offset 都属于 immutable original；apply 阶段才能按这些坐标反向改副本。
  for (const line of lines) {
    starts.push(offset)
    offset += line.length + 1
  }
  // cursor 落在一行内部时该行已被部分消费，whole-line 分支只能从下一个完整行起点继续。
  const firstEligibleLine = starts.findIndex((offset) => offset >= cursorOffset)
  const startLine = firstEligibleLine === -1 ? lines.length : firstEligibleLine
  const text = lines.join("\n") + (terminated && lines.length > 0 ? "\n" : "")
  const literal = pattern.join("\n")
  const exactLineByOffset = new Map<number, number>()
  // 此 Map 只给 literal occurrence 标注整行身份，不能另添一个重复候选影响唯一性计数。
  for (let index = startLine; index <= lines.length - pattern.length; index++) {
    if (pattern.every((line, patternIndex) => lines[index + patternIndex] === line)) {
      exactLineByOffset.set(starts[index], index)
    }
  }

  const normalizedPattern = pattern.map(normalizeLineForFuzzy)
  const lineCandidates: Array<{ location: ExactLocation; start: number; end: number }> = []
  for (const [start, index] of exactLineByOffset) {
    lineCandidates.push({
      location: { kind: "line", startLine: index, endLine: index + pattern.length },
      start,
      end: index + pattern.length < lines.length ? starts[index + pattern.length] : text.length,
    })
  }

  // exact whole-line 激活优先层；其它 normalized whole-line 仍须进入同层唯一性证明。
  for (let index = startLine; index <= lines.length - pattern.length; index++) {
    if (!normalizedPattern.every((line, patternIndex) => normalizeLineForFuzzy(lines[index + patternIndex]) === line)) {
      continue
    }
    const start = starts[index]
    const end = index + pattern.length < lines.length ? starts[index + pattern.length] : text.length
    if (exactLineByOffset.has(start)) continue
    lineCandidates.push({
      location: { kind: "line", startLine: index, endLine: index + pattern.length },
      start,
      end,
    })
  }

  // proper substring 是 lower tier；只要存在 exact whole-line，就不能反向否决该既有成功域。
  if (exactLineByOffset.size > 0) {
    if (lineCandidates.length > 1) return { type: "ambiguous" }
    return { type: "found", location: lineCandidates[0].location }
  }

  const candidates: Array<{ location: ExactLocation; start: number; end: number }> = []
  if (literal.length > 0) {
    // exact occurrence 从下一字符继续，重叠 occurrence 也必须参与 fallback tier 的全局唯一性。
    for (let start = text.indexOf(literal, cursorOffset); start !== -1; start = text.indexOf(literal, start + 1)) {
      candidates.push({
        location: { kind: "substring", startOffset: start, endOffset: start + literal.length },
        start,
        end: start + literal.length,
      })
    }
  }
  for (const candidate of lineCandidates) {
    // 同一 normalized 行窗内已有 exact occurrence 时保留精确 span，避免吞掉外围空白。
    if (candidates.some((exact) => exact.start >= candidate.start && exact.end <= candidate.end)) continue
    candidates.push(candidate)
  }

  const normalized = normalizedRawView(text)
  const normalizedLiteral = normalizeForMatch(literal)
  let unsafeNormalized = 0
  if (normalized && normalizedLiteral.length > 0) {
    for (
      let start = normalized.text.indexOf(normalizedLiteral);
      start !== -1;
      start = normalized.text.indexOf(normalizedLiteral, start + 1)
    ) {
      const end = start + normalizedLiteral.length
      const rawStart = normalized.starts.get(start)
      const rawEnd = normalized.ends.get(end)
      // NFKC expansion 内部和跨 trim gap 都没有一个由 old block 独占的连续 original span。
      const ownerStart = rawStart ?? normalizedOwnerStart(normalized.owners, start)
      if (ownerStart < cursorOffset) continue
      if (rawStart === undefined || rawEnd === undefined || hasInternalGap(normalized.gaps, start, end)) {
        unsafeNormalized++
        continue
      }
      // whole-line 或 exact occurrence 已代表同一 normalized identity 时，不重复增加候选计数。
      if (candidates.some((candidate) => candidate.start <= rawStart && candidate.end >= rawEnd)) continue
      candidates.push({
        location: { kind: "substring", startOffset: rawStart, endOffset: rawEnd },
        start: rawStart,
        end: rawEnd,
      })
    }
  }

  // unsafe occurrence 不可写，但仍是 normalized 域的第二候选；忽略它会破坏全局唯一性。
  if (candidates.length + unsafeNormalized > 1) return { type: "ambiguous" }
  if (unsafeNormalized > 0) return { type: "not-found" }
  if (candidates.length > 1) return { type: "ambiguous" }
  if (candidates.length === 0) return { type: "not-found" }
  return { type: "found", location: candidates[0].location }
}

function normalizeLineForFuzzy(line: string) {
  // Patch 与 Edit 共用一个 PI normalization contract，避免标点、空格或 NFKC 集合静默分叉。
  return normalizeForMatch(line)
}

function normalizedRawView(text: string) {
  const starts = new Map<number, number>([[0, 0]])
  const ends = new Map<number, number>([[0, 0]])
  const gaps: number[] = []
  const owners: Array<{ start: number; end: number; rawStart: number }> = []
  const parts: string[] = []
  let normalizedOffset = 0
  let lineStart = 0

  while (lineStart <= text.length) {
    const newline = text.indexOf("\n", lineStart)
    const lineEnd = newline === -1 ? text.length : newline
    const line = text.slice(lineStart, lineEnd)
    const retained = line.trimEnd()

    for (const segment of graphemes.segment(retained)) {
      const rawStart = lineStart + segment.index
      const rawEnd = rawStart + segment.segment.length
      // NUL 阻止单个 interior whitespace grapheme 被 normalizeForMatch 的 trimEnd 删除。
      const value = normalizeForMatch(`${segment.segment}\0`).slice(0, -1)
      starts.set(normalizedOffset, rawStart)
      ends.set(normalizedOffset, rawStart)
      parts.push(value)
      if (value.length > 0) owners.push({ start: normalizedOffset, end: normalizedOffset + value.length, rawStart })
      normalizedOffset += value.length
      starts.set(normalizedOffset, rawEnd)
      ends.set(normalizedOffset, rawEnd)
    }

    const retainedEnd = lineStart + retained.length
    ends.set(normalizedOffset, retainedEnd)
    if (newline === -1) break
    starts.set(normalizedOffset, lineEnd)
    if (retainedEnd < lineEnd) gaps.push(normalizedOffset)
    parts.push("\n")
    owners.push({ start: normalizedOffset, end: normalizedOffset + 1, rawStart: newline })
    normalizedOffset++
    starts.set(normalizedOffset, newline + 1)
    ends.set(normalizedOffset, newline + 1)
    lineStart = newline + 1
  }

  const normalized = parts.join("")
  // 不一致表示该输入不能建立可信 raw ownership；只禁用 normalized candidate，绝不改走第二 matcher。
  if (normalized !== normalizeForMatch(text)) return undefined
  return { text: normalized, starts, ends, gaps, owners }
}

function normalizedOwnerStart(owners: Array<{ start: number; end: number; rawStart: number }>, offset: number) {
  let low = 0
  let high = owners.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (owners[middle].end <= offset) low = middle + 1
    else high = middle
  }
  return owners[low]?.rawStart ?? Number.POSITIVE_INFINITY
}

function hasInternalGap(gaps: number[], start: number, end: number) {
  let low = 0
  let high = gaps.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (gaps[middle] <= start) low = middle + 1
    else high = middle
  }
  return low < gaps.length && gaps[low] < end
}

// context 是导航下界，不是 old block 候选：保留 first eligible whole-line，后备唯一 literal substring。
// context 不做 PI normalize，否则仅用于导航的宽松文本会意外改变 old block 的匹配域。
export function locateContext(lines: string[], pattern: string[], cursorOffset: number, terminated = false): ExactResult {
  if (pattern.length === 0) return { type: "not-found" }
  const starts: number[] = []
  let offset = 0
  for (const line of lines) {
    starts.push(offset)
    offset += line.length + 1
  }
  const firstEligibleLine = starts.findIndex((start) => start >= cursorOffset)
  const startLine = firstEligibleLine === -1 ? lines.length : firstEligibleLine
  // 重复整行 context 有意选择 first eligible；真正的唯一性仍由随后 old block 证明。
  for (let index = startLine; index <= lines.length - pattern.length; index++) {
    if (pattern.every((line, patternIndex) => lines[index + patternIndex] === line)) {
      return { type: "found", location: { kind: "line", startLine: index, endLine: index + pattern.length } }
    }
  }

  const literal = pattern.join("\n")
  if (literal.length === 0) return { type: "not-found" }
  const text = lines.join("\n") + (terminated && lines.length > 0 ? "\n" : "")
  const first = text.indexOf(literal, cursorOffset)
  if (first === -1) return { type: "not-found" }
  if (text.indexOf(literal, first + 1) !== -1) return { type: "ambiguous" }
  return { type: "found", location: { kind: "substring", startOffset: first, endOffset: first + literal.length } }
}

export type ClosestWindow = {
  line: number
  excerpt: string
  score: number
}

type NormalizedText = {
  points: Uint32Array
  rawBoundaries: Float64Array
  lineStarts: Float64Array
  lineContentEnds: Float64Array
}

type CandidateSpan = { start: number; end: number }

type DistanceResult = {
  distance: number
  end: number
  endCount: number
}

// 诊断预算从 closestWindow 入口开始，超限只能返回 undefined，不能提交部分 actual 或改走另一 matcher。
// performance.now 使用单调时钟，系统时间跳变不会让四秒上限倒退或提前失效。
// 同步 matcher 无法由外部 Promise 抢占，因此每个可能无界的阶段都必须协作检查这一 deadline。
const MATCH_DIAGNOSTIC_BUDGET_MS = 4000
// 64MiB 覆盖 matcher 新增工作集；原始 content/expected 已由 caller 持有，不计入这份增量预算。
// 该上限约束诊断的额外内存，不改变 Edit/Patch 已经读取文件所需的 owner 内存。
const MATCH_WORKING_SET_BYTES = 64 * 1024 * 1024
// 外部 diffChars 不可中断，因此在调用前用固定输入上限把最坏工作量封闭起来。
// source 与 diff 分开限制：变长候选只需 excerpt，等行数候选才会进入字符差异算法。
const MATCH_RENDER_DIFF_POINTS = 4096
const MATCH_RENDER_SOURCE_UTF16 = 1024 * 1024

function expired(deadline: number) {
  return performance.now() >= deadline
}

function rawBudgetAllows(contentLength: number, expectedLength: number, deadline: number) {
  // 此预检只能读取 O(1) 的 raw length；任何 replaceAll/split/typed-array 分配都必须位于它之后。
  // raw UTF-16 length 是 normalized point 数的保守上界，因此可能早拒绝，但绝不会低估工作集。
  // profile 按每个 pattern point 预留一行是故意的最坏估算，避免高基数字符集绕过内存门禁。
  // reverse row 与 Myers scratch 同时计入，因为恢复阶段开始前 forward 数组仍然处于作用域内。
  if (expired(deadline)) return false
  const blocks = Math.ceil(expectedLength / 32)
  const bytes =
    contentLength * 4 +
    (contentLength + 1) * 8 +
    2 * (contentLength + 1) * 8 +
    expectedLength * 4 +
    expectedLength * (blocks * 4 + 256) +
    (blocks * 7 + expectedLength + 1) * 4
  // 非 safe integer 说明估算本身已越过 JS 可精确表达的分配域，必须在构造任何中间数组前拒绝。
  return Number.isSafeInteger(bytes) && bytes <= MATCH_WORKING_SET_BYTES && !expired(deadline)
}

function measureNormalized(text: string, deadline: number) {
  // 先计数再精确分配 typed arrays，避免可增长 JS 数组在长文件上制造未计入预算的临时副本。
  // 计数遍与填充遍共享 CRLF/code-point 规则，否则预分配长度与后续 raw boundary 会发生偏移。
  // 每 4096 个 raw UTF-16 单元检查一次时间，在线性预扫描中同时限制最坏响应延迟。
  let pointCount = 0
  let lineCount = 1
  let nextCheck = 0
  for (let offset = 0; offset < text.length;) {
    if (offset >= nextCheck) {
      if (expired(deadline)) return undefined
      nextCheck = offset + 4096
    }
    const codePoint = text.codePointAt(offset) ?? text.charCodeAt(offset)
    offset += codePoint > 0xffff ? 2 : 1
    // CRLF 在比较空间是一个 LF point，但 raw offset 必须一次跨过两个 UTF-16 单元。
    if (codePoint === 13 && text.charCodeAt(offset) === 10) offset++
    if (codePoint === 10 || codePoint === 13) lineCount++
    pointCount++
  }
  if (expired(deadline)) return undefined
  return { pointCount, lineCount }
}

function normalizePattern(text: string, deadline: number) {
  const measured = measureNormalized(text, deadline)
  if (!measured) return undefined
  const points = new Uint32Array(measured.pointCount)
  if (expired(deadline)) return undefined

  // matcher 的距离单位是 Unicode code point；CRLF/CR 只在该比较空间折叠为一个 LF point。
  // Uint32 保存完整 astral scalar，避免同一个 emoji 被两个 surrogate 当成两次编辑。
  // pattern 不需要 raw boundary；只保留距离计算所需的数据，减小每次失败诊断的固定工作集。
  let pointIndex = 0
  let nextCheck = 0
  for (let offset = 0; offset < text.length;) {
    if (offset >= nextCheck) {
      if (expired(deadline)) return undefined
      nextCheck = offset + 4096
    }
    const codePoint = text.codePointAt(offset) ?? text.charCodeAt(offset)
    offset += codePoint > 0xffff ? 2 : 1
    if (codePoint === 13 && text.charCodeAt(offset) === 10) offset++
    points[pointIndex++] = codePoint === 10 || codePoint === 13 ? 10 : codePoint
  }
  if (expired(deadline)) return undefined
  return points
}

function normalizeContent(text: string, deadline: number): NormalizedText | undefined {
  const measured = measureNormalized(text, deadline)
  if (!measured) return undefined
  const points = new Uint32Array(measured.pointCount)
  const rawBoundaries = new Float64Array(measured.pointCount + 1)
  const lineStarts = new Float64Array(measured.lineCount)
  const lineContentEnds = new Float64Array(measured.lineCount)
  if (expired(deadline)) return undefined

  // rawBoundary[k] 表示前 k 个 normalized points 消耗到的 UTF-16 offset，避免 surrogate/CRLF 坐标漂移。
  // 行起止在同一遍扫描中记录，renderer 后续只二分这些边界，不再复制并 split 整个文件前缀。
  // Float64 可精确表达 JS 可索引范围内的 raw offset，不把文件大小暗中收窄到 Uint32。
  // lineCount 包含终止换行后的逻辑空行，使 rawEnd 位于 EOF 时仍有稳定的 upper-bound 坐标。
  // lineStarts[0] 先写入零；即使文件没有换行，renderer 也能安全地二分到唯一逻辑行。
  let pointIndex = 0
  let lineIndex = 0
  let nextCheck = 0
  lineStarts[0] = 0
  for (let offset = 0; offset < text.length;) {
    if (offset >= nextCheck) {
      if (expired(deadline)) return undefined
      nextCheck = offset + 4096
    }
    const rawStart = offset
    const codePoint = text.codePointAt(offset) ?? text.charCodeAt(offset)
    offset += codePoint > 0xffff ? 2 : 1
    if (codePoint === 13 && text.charCodeAt(offset) === 10) offset++
    const newline = codePoint === 10 || codePoint === 13
    points[pointIndex] = newline ? 10 : codePoint
    rawBoundaries[++pointIndex] = offset
    if (!newline) continue
    // lineContentEnds 排除 CR/LF；lineStarts 则越过整个 CRLF，使 exact raw slice 仍保留原换行字节。
    lineContentEnds[lineIndex++] = rawStart
    lineStarts[lineIndex] = offset
  }
  lineContentEnds[lineIndex] = text.length
  if (expired(deadline)) return undefined
  return { points, rawBoundaries, lineStarts, lineContentEnds }
}

function findLine(lineStarts: Float64Array, rawOffset: number) {
  // upper-bound 让恰好落在下一行起点的 rawEnd 归入下一行，保持旧 renderer 对终止换行的扩展语义。
  let low = 0
  let high = lineStarts.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (lineStarts[middle] <= rawOffset) low = middle + 1
    else high = middle
  }
  return Math.max(0, low - 1)
}

function closestDistance(text: Uint32Array, pattern: Uint32Array, deadline: number): DistanceResult | undefined {
  // 每 32 个 pattern points 构成一个 word；该表示直接覆盖 31/32/33 等边界而无需 BigInt 分支。
  // valid 只描述最后一个有效 word 的高位，topMask 取它的末位而不是固定取 bit 31。
  const blocks = Math.ceil(pattern.length / 32)
  const valid = pattern.length - 32 * (blocks - 1)
  const lastMask = valid === 32 ? 0xffffffff : (2 ** valid - 1) >>> 0
  const topMask = 1 << (valid - 1)
  const profile = new Map<number, Uint32Array>()

  // 稀疏 profile 只为 pattern 实际出现的 code point 建 bit row；文件字符不扩大常驻表。
  // 所有移位结果显式转为 unsigned，避免 JS 有符号位运算把最高 bit 扩展到算术比较。
  // 同一 code point 的多个 pattern 位置合并进一个 row，保持每个 text point 只做一次 profile lookup。
  for (let index = 0; index < pattern.length; index++) {
    if ((index & 255) === 0 && expired(deadline)) return undefined
    const point = pattern[index]
    const row = profile.get(point) ?? new Uint32Array(blocks)
    row[index >>> 5] = (row[index >>> 5] | (1 << (index & 31))) >>> 0
    if (!profile.has(point)) profile.set(point, row)
  }

  const vp = new Uint32Array(blocks)
  const vn = new Uint32Array(blocks)
  const d0 = new Uint32Array(blocks)
  const hn = new Uint32Array(blocks)
  const hp = new Uint32Array(blocks)
  const shiftedHP = new Uint32Array(blocks)
  const shiftedHN = new Uint32Array(blocks)
  if (expired(deadline)) return undefined
  // VP 初态编码 scalar 第一列 D[i,0]=i；partial block 之外的 1 必须在第一次更新前清掉。
  vp.fill(0xffffffff)
  vp[blocks - 1] &= lastMask

  let score = pattern.length
  let bestDistance = pattern.length
  let bestEnd = -1
  let bestEndCount = 0
  let blocksUntilCheck = 64

  // score 是每一列最底部 D[m,j]；semiglobal 只免除文件前缀，不免除 pattern 的缺失字符。
  // bestEndCount 饱和在二：调用方只关心唯一或不唯一，不应为重复文本积累无界计数。
  for (let textIndex = 0; textIndex < text.length; textIndex++) {
    const row = profile.get(text[textIndex])
    let carry = 0
    // 跨 word 加法必须从低块向高块传 carry；各块独立相加会在 32/33 边界静默改写距离。
    // carry 来自无符号 33 位和而不是符号溢出，才能与标量加法的进位完全一致。
    for (let block = 0; block < blocks; block++) {
      const equal = row?.[block] ?? 0
      const x = (equal | vn[block]) >>> 0
      const sum = ((x & vp[block]) >>> 0) + vp[block] + carry
      carry = sum >= 0x100000000 ? 1 : 0
      d0[block] = (((sum >>> 0) ^ vp[block]) | x) >>> 0
      if (--blocksUntilCheck !== 0) continue
      if (expired(deadline)) return undefined
      blocksUntilCheck = 64
    }
    for (let block = 0; block < blocks; block++) {
      hn[block] = (vp[block] & d0[block]) >>> 0
      hp[block] = (vn[block] | ~(vp[block] | d0[block])) >>> 0
      if (--blocksUntilCheck !== 0) continue
      if (expired(deadline)) return undefined
      blocksUntilCheck = 64
    }
    if ((hp[blocks - 1] & topMask) !== 0) score++
    else if ((hn[blocks - 1] & topMask) !== 0) score--

    if (score < bestDistance) {
      bestDistance = score
      bestEnd = textIndex + 1
      bestEndCount = 1
    } else if (score === bestDistance) {
      // 初始距离 m 也可能是全局最优；首次 equality 必须保存真实非空 endpoint，不能留下 -1。
      // 第二个等距 endpoint 已足以否定可靠性，继续扫描只用于发现更小的全局距离。
      if (bestEndCount === 0) bestEnd = textIndex + 1
      bestEndCount = Math.min(2, bestEndCount + 1)
    }

    let hpCarry = 0
    let hnCarry = 0
    // semiglobal 顶边 D[0,j]=0，所以最低 bit 固定注入 0；global Myers 常见的 |1 在这里会收费跳过的文件前缀。
    // HP/HN 的最高 bit 分别传给下一 word 的最低 bit，保证逻辑左移跨块连续而非各块截断。
    for (let block = 0; block < blocks; block++) {
      shiftedHP[block] = (((hp[block] << 1) >>> 0) | hpCarry) >>> 0
      shiftedHN[block] = (((hn[block] << 1) >>> 0) | hnCarry) >>> 0
      hpCarry = hp[block] >>> 31
      hnCarry = hn[block] >>> 31
      if (--blocksUntilCheck !== 0) continue
      if (expired(deadline)) return undefined
      blocksUntilCheck = 64
    }
    for (let block = 0; block < blocks; block++) {
      vn[block] = (shiftedHP[block] & d0[block]) >>> 0
      vp[block] = (shiftedHN[block] | ~(shiftedHP[block] | d0[block])) >>> 0
      if (--blocksUntilCheck !== 0) continue
      if (expired(deadline)) return undefined
      blocksUntilCheck = 64
    }
    // 最后一块的 padding bits 不属于 pattern；每列都清除，避免它们通过 carry 污染 topMask 判定。
    vp[blocks - 1] &= lastMask
    vn[blocks - 1] &= lastMask
  }

  if (expired(deadline) || bestEnd < 0) return undefined
  return { distance: bestDistance, end: bestEnd, endCount: bestEndCount }
}

function recoverUniqueSpan(
  text: Uint32Array,
  pattern: Uint32Array,
  match: DistanceResult,
  deadline: number,
): CandidateSpan | undefined {
  const minimumLength = Math.max(1, pattern.length - match.distance)
  const maximumLength = Math.min(match.end, pattern.length + match.distance)
  // 编辑距离下界 |m-L|<=d 证明范围外不可能达到 best distance，因此裁剪不会漏掉同 end 的 tie。
  // minimumLength 至少为一，明确排除空 span；诊断必须指向文件中的实际文本证据。
  const row = new Int32Array(pattern.length + 1)
  let cellsUntilCheck = 256
  for (let index = 0; index <= pattern.length; index++) {
    row[index] = index
    if (--cellsUntilCheck !== 0) continue
    if (expired(deadline)) return undefined
    cellsUntilCheck = 256
  }

  let matchCount = 0
  let start = -1
  // 反向 row 只恢复已证明 bestEnd 的 start；|m-L|<=d 把范围限制在最多 2m，不会启动第二次全局搜索。
  // pattern 与文件后缀同时反向后距离不变，所以一个 row 就能依次验证所有允许的 start。
  // 这里不重新比较其他 endpoint；forward 已完成全局证明，reverse 只补回 bit-vector 未携带的 span 身份。
  // row[pattern.length] 只在完整反向候选结束时读取，避免中途 prefix 距离被误当作 span 距离。
  for (let length = 1; length <= maximumLength; length++) {
    const point = text[match.end - length]
    let diagonal = row[0]
    row[0] = length
    for (let patternIndex = 1; patternIndex <= pattern.length; patternIndex++) {
      const above = row[patternIndex]
      const deletion = above + 1
      const insertion = row[patternIndex - 1] + 1
      const substitution = diagonal + (pattern[pattern.length - patternIndex] === point ? 0 : 1)
      row[patternIndex] =
        deletion < insertion
          ? deletion < substitution
            ? deletion
            : substitution
          : insertion < substitution
            ? insertion
            : substitution
      diagonal = above
      if (--cellsUntilCheck !== 0) continue
      if (expired(deadline)) return undefined
      cellsUntilCheck = 256
    }
    if (length < minimumLength || row[pattern.length] !== match.distance) continue
    start = match.end - length
    // 同一 end 的不同 length 就是不同 start/span；第二个证据必须抑制，而不是按长度或位置择优。
    // 立即返回 undefined 保持 tie-first 语义，也避免在已不可靠时继续为 renderer 收集候选。
    if (++matchCount > 1) return undefined
  }

  if (expired(deadline) || matchCount !== 1) return undefined
  return { start, end: match.end }
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
function formatClosestDifference(expected: string[], candidate: string[], startLine: number, deadline: number) {
  if (expected.length !== candidate.length) return ""
  if (expired(deadline)) return undefined

  const output: string[] = []
  for (const [index, actual] of candidate.entries()) {
    const requested = expected[index]
    if (requested === actual) continue

    // diffChars 本身不可抢占；调用方已限制总输入，本层仍在每次调用前后检查同一 deadline。
    if (expired(deadline)) return undefined
    const changes = diffChars(requested, actual)
    if (expired(deadline)) return undefined
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
    if (expired(deadline)) return undefined
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
  if (expired(deadline)) return undefined
  return output.join("\n")
}

// forward Myers 的 free-prefix 边界与旧 DP 第一行一致；reverse row 只恢复同一全局最优 endpoint 的 span。
// tie 必须在 score 之前完成，任何 deadline/工作集/renderer 超限都只返回 undefined，不产生退化 actual。
export function closestWindow(content: string, expected: string): ClosestWindow | undefined {
  const deadline = performance.now() + MATCH_DIAGNOSTIC_BUDGET_MS
  if (!rawBudgetAllows(content.length, expected.length, deadline)) return undefined

  // raw 预算先于这些线性中间结构；无上限 oldString 不能在门禁前触发 replaceAll/split 分配。
  const expectedLines = expected.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n")
  if (expired(deadline)) return undefined
  if (expectedLines.length === 0 || expectedLines.every((line) => line.trim() === "")) return undefined
  if (expired(deadline)) return undefined

  const pattern = normalizePattern(expected, deadline)
  if (!pattern) return undefined
  const text = normalizeContent(content, deadline)
  if (!text || pattern.length === 0 || text.points.length === 0) return undefined

  const match = closestDistance(text.points, pattern, deadline)
  // endpoint tie 在 score 前拒绝；高相似度不能把两个同样可信的位置伪装成唯一定位。
  if (!match || match.endCount !== 1) return undefined
  const span = recoverUniqueSpan(text.points, pattern, match, deadline)
  // span tie 同样先于 score；长度偏好或文件顺序都不属于可靠性证据。
  if (!span) return undefined
  const candidatePointLength = span.end - span.start
  // 分母同时包含 expected 与候选长度，插入/删除的可靠性不会因候选变长而超过 1。
  // 只应用一次既有阈值；低分结果不能通过缩短 excerpt、重排候选或再次搜索获得展示资格。
  const score = 1 - match.distance / Math.max(pattern.length, candidatePointLength)
  if (score < 0.5) return undefined

  const rawStart = text.rawBoundaries[span.start]
  const rawEnd = text.rawBoundaries[span.end]
  // renderer 上限在任何候选 slice 前检查，超限路径不会暂时构造随后被丢弃的大 actual。
  if (rawEnd - rawStart > MATCH_RENDER_SOURCE_UTF16 || expired(deadline)) return undefined
  const startLine = findLine(text.lineStarts, rawStart)
  const endLine = findLine(text.lineStarts, rawEnd)
  const renderStart = text.lineStarts[startLine]
  const renderEnd = text.lineContentEnds[endLine]
  // 行号与展示范围只使用 normalization 已记录的 raw 边界；禁止重新扫描或复制候选前的完整文件。
  if (renderEnd - renderStart > MATCH_RENDER_SOURCE_UTF16 || expired(deadline)) return undefined
  const candidateText = content.slice(rawStart, rawEnd)
  // candidateText 的 slice 只发生在 renderer 已通过 raw span 上限之后，避免预算检查成为事后补救。

  // 零距离等价必须比较同一 normalized points；raw includes 会把 CRLF 与 LF 误判为不同文本。
  // Patch expected 来自 LF 行数组，CRLF raw span 仍可被证明是同一块原始文本，不能因此回显 expected。
  // raw candidate 只用于展示证据，等价判断不依赖第二次搜索或另一套归一化规则。
  let isEquivalentCandidate = candidatePointLength === pattern.length
  for (let index = 0; isEquivalentCandidate && index < pattern.length; index++) {
    if ((index & 255) === 0 && expired(deadline)) return undefined
    if (pattern[index] !== text.points[span.start + index]) isEquivalentCandidate = false
  }
  if (expired(deadline)) return undefined

  const renderedText = content.slice(renderStart, renderEnd).replaceAll("\r\n", "\n").replaceAll("\r", "\n")
  if (expired(deadline)) return undefined
  const candidate = renderedText.split("\n")
  if (expired(deadline)) return undefined
  const line = startLine + 1
  // 展示扩展只改变上下文范围，不改变 score、line 起点或 raw 边界，因此提示与选择始终来自同一候选。
  // 变长分支直接截取 DP raw span，完整行只服务等行数列差异，避免长前后缀遮蔽已证明的 actual。
  // raw span 可能只是行内片段；展示时扩展到包含行，但 candidateText 仍来自 DP span，候选身份不会漂移。
  // 只有行数相同才计算列差异；变长窗口直接展示同一 raw span，renderer 不得自行选择另一段文本。
  let excerpt: string
  if (isEquivalentCandidate) {
    // normalized 零距离只提示当前位置存在原文，不回显 requested；后者已经完整存在于 Tool input。
    excerpt = "Exact requested text exists at this location in the original file but is unavailable to the current patch step."
  } else if (candidate.length === expectedLines.length) {
    // raw UTF-16 length 是 code-point 数的保守上界；超限必须抑制 actual，而不是改用另一种 renderer。
    if (expected.length + renderedText.length > MATCH_RENDER_DIFF_POINTS) return undefined
    const difference = formatClosestDifference(expectedLines, candidate, line, deadline)
    if (difference === undefined) return undefined
    excerpt = difference || truncateExcerpt(renderedText, 500)
  } else {
    excerpt = truncateExcerpt(candidateText, 500)
  }

  if (expired(deadline)) return undefined
  return { line, excerpt: truncateExcerpt(excerpt, 500), score }
}
