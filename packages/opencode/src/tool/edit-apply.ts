/**
 * edit 文本替换的唯一语义所有者（单条与多条 edits 共用）。
 *
 * 设计约束：
 * - 主路径只有一条：对 edits[] 在同一 pre-edit 快照上 locate → 唯一性/replaceAll → 重叠检查 → reverse apply。
 * - exact 字面匹配是默认成功域（对齐历史 OpenCode replace）；归一化是不足时的增强，不是第二条并列算法。
 * - 禁止「先应用 edits[0] 再在新内容上匹配 edits[1]」；顺序依赖的条带必须失败。
 * - closest / 相似度仅允许出现在调用方的失败诊断，不得进入本模块成功域。
 */
export type EditReplacement = {
  oldString: string
  newString: string
  replaceAll?: boolean
}

export class EditApplyError extends Error {
  // 失败索引只在 owner 内传递，用于 multi-edit 诊断，不进入 Schema、metadata 或用户可见文案。
  // 继承 Error 的既有 message，使调用方获得身份而不改变原有错误渲染契约。
  constructor(message: string, readonly editIndex: number) {
    super(message)
  }
}

export type ApplyEditsResult = {
  contentNew: string
  usedNormalized: boolean
  /** 历史真值：每条 oldString 为 pre-edit baseLF 上的连续 needle，不是 preserve 整行块。 */
  syncEdits: EditReplacement[]
  /** 只有实际写入条目的 normalized disk slice 与模型 LF oldString 不同时才记录。 */
  normalizedMismatchIndices: number[]
}

type TextReplacement = {
  matchIndex: number
  matchLength: number
  newText: string
  editIndex: number
}

type LineSpan = { start: number; end: number }

// --- 模块内不变量速查（供维护者与审计门禁邻近决策）---
// 1. 所有 edits 的 locate 必须在同一 pre-edit 内容上完成后再 apply。
// 2. elevation 一旦触发，整批 range 坐标只能在 normalize 后的串上解释。
// 3. reverse apply 保证后写的 range 不污染先写 range 的 offset。
// 4. preserve 只改「触碰行块」，未触碰行字节级原样拷贝（含行尾空白）。
// 5. actualOld 是历史 needle，不是 full-file continuous apply 的输入。
// 6. replaceAll 的展开必须与 sole occurrence 计数域一致。
// 7. 空 needle（含归一化后为空）永不进入 indexOf 成功路径。
// 8. closest/相似度禁止出现在本文件成功返回值中。
// 9. 单元素 edits 与多元素 edits 不得分叉到不同匹配算法。
// 10. newString 禁止再走 normalizeForMatch，避免改写用户意图插入文本。
// 11. hybrid 连字符：字面一次、归一化两次 → 无 replaceAll 必歧义失败。
// 12. 重叠 range 在 reverse 前拒绝，避免部分写盘。
// 13. identical（oldString === newString）条目校验后跳写，不推入 allRanges；
//     唯一 no-op 门是批级内容等值（505-511），逐条不再拒绝。
//     其 syncEdits 历史为提交形态（零写入即无命中切片可记），真实条目沿用 actualOld。
// 14. 兼容 replace() 仅允许 length-1 委托，禁止复制粘贴第二实现。


/**
 * 封闭归一化集（与 Pi normalizeForFuzzyMatch 对齐的 OpenCode 命名）：
 * 仅消除模型复制时的常见 Unicode/行尾空白漂移。
 * 明确不在集合内：tab↔空格缩进、转义字面量、任意相似度/Levenshtein。
 * 这些仍必须失败并要求 re-read 精确文本。
 */
export function normalizeForMatch(text: string): string {
  return (
    text
      .normalize("NFKC")
      .split("\n")
      .map((line) => line.trimEnd())
      .join("\n")
      // 智能引号 → ASCII，避免聊天字体替换导致 exact 失败
      .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
      .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
      // 各类 dash/minus → 普通连字符
      .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
      // 特殊空格 → 普通空格（不含普通 ASCII 空格本身的语义合并之外）
      .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ")
  )
}

function splitLinesWithEndings(content: string): string[] {
  return content.match(/[^\n]*\n|[^\n]+/g) ?? []
}

function getLineSpans(content: string): LineSpan[] {
  let offset = 0
  return splitLinesWithEndings(content).map((line) => {
    const span = { start: offset, end: offset + line.length }
    offset = span.end
    return span
  })
}

function getReplacementLineRange(lines: LineSpan[], replacement: TextReplacement) {
  // 将字符区间扩展到完整逻辑行，供 preserve 按行拷贝/重写
  const replacementStart = replacement.matchIndex
  const replacementEnd = replacement.matchIndex + replacement.matchLength

  let startLine = -1
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (replacementStart >= line.start && replacementStart < line.end) {
      startLine = i
      break
    }
  }
  if (startLine === -1) throw new Error("Replacement range is outside the base content.")

  let endLine = startLine
  while (endLine < lines.length && lines[endLine].end < replacementEnd) {
    endLine++
  }
  if (endLine >= lines.length) throw new Error("Replacement range is outside the base content.")

  return { startLine, endLine: endLine + 1 }
}

function applyReplacements(content: string, replacements: TextReplacement[], offset = 0): string {
  // 从高 offset 到低 offset 写回，保证同一快照上的多 range 互不干扰
  let result = content
  for (let i = replacements.length - 1; i >= 0; i--) {
    const replacement = replacements[i]
    const matchIndex = replacement.matchIndex - offset
    result =
      result.substring(0, matchIndex) + replacement.newText + result.substring(matchIndex + replacement.matchLength)
  }
  return result
}

// 归一化空间上的替换按触碰行回写原文，未触碰行保留原始字节（含行尾空白）。
export function applyReplacementsPreservingUnchangedLines(
  originalContent: string,
  baseContent: string,
  replacements: TextReplacement[],
): string {
  const originalLines = splitLinesWithEndings(originalContent)
  const baseLines = getLineSpans(baseContent)
  if (originalLines.length !== baseLines.length) {
    throw new Error("Cannot preserve unchanged lines because the base content has a different line count.")
  }

  const groups: Array<{ startLine: number; endLine: number; replacements: TextReplacement[] }> = []
  const sorted = [...replacements].sort((a, b) => a.matchIndex - b.matchIndex)
  for (const replacement of sorted) {
    const range = getReplacementLineRange(baseLines, replacement)
    const current = groups[groups.length - 1]
    if (current && range.startLine < current.endLine) {
      current.endLine = Math.max(current.endLine, range.endLine)
      current.replacements.push(replacement)
      continue
    }
    groups.push({ ...range, replacements: [replacement] })
  }

  let originalLineIndex = 0
  let result = ""
  for (const group of groups) {
    result += originalLines.slice(originalLineIndex, group.startLine).join("")
    const groupStartOffset = baseLines[group.startLine].start
    const groupEndOffset = baseLines[group.endLine - 1].end
    result += applyReplacements(baseContent.slice(groupStartOffset, groupEndOffset), group.replacements, groupStartOffset)
    originalLineIndex = group.endLine
  }
  result += originalLines.slice(originalLineIndex).join("")
  return result
}

// progressive locate：先字面 exact，失败才进封闭 normalize；不使用打分/closest 成功。
export function findMatch(content: string, oldString: string) {
  const exactIndex = content.indexOf(oldString)
  if (exactIndex !== -1) {
    return {
      found: true as const,
      index: exactIndex,
      matchLength: oldString.length,
      usedNormalized: false,
    }
  }

  const fuzzyContent = normalizeForMatch(content)
  const fuzzyOld = normalizeForMatch(oldString)
  // 空 needle 的 indexOf 恒为 0，必须在成功域外拒绝
  if (fuzzyOld.length === 0) {
    return { found: false as const, index: -1, matchLength: 0, usedNormalized: false }
  }
  const fuzzyIndex = fuzzyContent.indexOf(fuzzyOld)
  if (fuzzyIndex === -1) {
    return { found: false as const, index: -1, matchLength: 0, usedNormalized: false }
  }
  // 返回的 index/length 在归一化空间；调用方 elevation 后整批统一坐标系
  return {
    found: true as const,
    index: fuzzyIndex,
    matchLength: fuzzyOld.length,
    usedNormalized: true,
  }
}

// 出现次数始终走归一化投影，与 Pi countOccurrences 一致，避免 hybrid dash 误唯一。
export function countOccurrences(content: string, oldString: string): number {
  const fuzzyContent = normalizeForMatch(content)
  const fuzzyOld = normalizeForMatch(oldString)
  if (fuzzyOld.length === 0) return 0
  return fuzzyContent.split(fuzzyOld).length - 1
}

// 字面出现次数：与历史 replace 的 indexOf 第二处探测一致（步长为 needle 长度，非重叠）。
function exactLiteralCount(content: string, oldString: string): number {
  if (oldString.length === 0) return 0
  let count = 0
  let from = 0
  while (true) {
    const index = content.indexOf(oldString, from)
    if (index === -1) break
    count++
    from = index + oldString.length
  }
  return count
}

// exact 域枚举 range；replaceAll 时展开全部非重叠字面命中（旧 content.replaceAll 的区间形态）。
function enumerateExactRanges(content: string, oldString: string, replaceAll: boolean): Array<{ matchIndex: number; matchLength: number }> {
  const first = content.indexOf(oldString)
  if (first === -1) return []
  if (!replaceAll) return [{ matchIndex: first, matchLength: oldString.length }]
  const ranges: Array<{ matchIndex: number; matchLength: number }> = []
  let from = 0
  while (true) {
    const index = content.indexOf(oldString, from)
    if (index === -1) break
    ranges.push({ matchIndex: index, matchLength: oldString.length })
    from = index + oldString.length
  }
  return ranges
}

// 归一化域枚举：content 必须已是 replacementBase（可能已 normalize）；offset 不得跨串回写。
function enumerateNormalizedRanges(
  content: string,
  oldString: string,
  replaceAll: boolean,
): Array<{ matchIndex: number; matchLength: number }> {
  const needle = normalizeForMatch(oldString)
  if (needle.length === 0) return []
  const first = content.indexOf(needle)
  if (first === -1) return []
  if (!replaceAll) return [{ matchIndex: first, matchLength: needle.length }]
  const ranges: Array<{ matchIndex: number; matchLength: number }> = []
  let from = 0
  while (true) {
    const index = content.indexOf(needle, from)
    if (index === -1) break
    ranges.push({ matchIndex: index, matchLength: needle.length })
    from = index + needle.length
  }
  return ranges
}

/**
 * 建立归一化串到原文的偏移映射（INV-16 actualOld）。
 * 双路径组合：先走「行 trim + 字符折叠」线性 map（快、边界清晰），
 * 若结果与 normalizeForMatch 不一致则回退前缀扫描 map（慢、与归一化定义严格一致）。
 * 两套互补，避免只保留一种时在 NFKC 扩缩/跨行边界上丢精度。
 */
export function normalizeWithMap(text: string): { normalized: string; map: number[] } {
  const folded = normalizeWithMapFold(text)
  const reference = normalizeForMatch(text)
  if (folded.normalized === reference) return folded
  return buildMapByScan(text, reference)
}

// 路径 A：按行 trimEnd 记原点，再对保留字符做与 normalizeForMatch 相同的折叠。
function normalizeWithMapFold(text: string): { normalized: string; map: number[] } {
  let trimmed = ""
  const trimMap: number[] = []
  let i = 0
  while (i < text.length) {
    const lineStart = i
    let lineEnd = text.indexOf("\n", i)
    if (lineEnd === -1) lineEnd = text.length
    const line = text.slice(lineStart, lineEnd)
    let end = line.length
    while (end > 0 && (line[end - 1] === " " || line[end - 1] === "\t" || line[end - 1] === "\r")) {
      end--
    }
    for (let j = 0; j < end; j++) {
      trimMap.push(lineStart + j)
      trimmed += line[j]
    }
    if (lineEnd < text.length) {
      trimMap.push(lineEnd)
      trimmed += "\n"
      i = lineEnd + 1
    } else {
      i = lineEnd
    }
  }

  let out = ""
  const outMap: number[] = []
  for (let k = 0; k < trimmed.length; k++) {
    const ch = trimmed[k]
    const origin = trimMap[k]
    const folded = ch
      .normalize("NFKC")
      .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
      .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
      .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
      .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ")
    for (const part of folded) {
      outMap.push(origin)
      out += part
    }
  }
  if (out.length > 0) {
    outMap[out.length] = Math.min(text.length, outMap[out.length - 1] + 1)
  } else {
    outMap[0] = 0
  }
  return { normalized: out, map: outMap }
}

// 路径 B：对 reference 每个字符在原文中找使 normalize 前缀对齐的最小推进（严格一致）。
function buildMapByScan(text: string, reference: string): { normalized: string; map: number[] } {
  const map: number[] = []
  let origin = 0
  for (let n = 0; n < reference.length; n++) {
    let found = -1
    for (let end = origin + 1; end <= text.length; end++) {
      const prefix = normalizeForMatch(text.slice(0, end))
      if (prefix.length >= n + 1 && prefix.slice(0, n + 1) === reference.slice(0, n + 1)) {
        found = Math.max(origin, end - 1)
        while (origin < end && normalizeForMatch(text.slice(0, origin + 1)).length <= n) {
          origin++
        }
        origin = Math.max(origin, found + 1)
        break
      }
    }
    if (found === -1) found = Math.min(origin, Math.max(0, text.length - 1))
    map.push(Math.max(0, found))
  }
  map.push(text.length)
  return { normalized: reference, map }
}

/**
 * INV-16：从 pre-edit 原文提取连续 needle，写入历史 oldString。
 * - exact：直接 slice 原文
 * - normalized：用 normalizeWithMap 把归一化坐标映回原文连续子串（mid-line，非整行 block）
 * - 历史 needle 与落盘 preserve 分离：不得用 actualOld 充当 full-file apply oracle
 */
function actualOldFromRanges(
  baseLF: string,
  _replacementBase: string,
  usedNormalized: boolean,
  ranges: Array<{ matchIndex: number; matchLength: number }>,
  modelOld: string,
): { oldString: string; mismatch: boolean } {
  if (ranges.length === 0) return { oldString: modelOld, mismatch: false }
  const slices = ranges.map((range) => {
    if (!usedNormalized) {
      return baseLF.slice(range.matchIndex, range.matchIndex + range.matchLength)
    }
    const { map } = normalizeWithMap(baseLF)
    const start = map[range.matchIndex] ?? 0
    const end = map[range.matchIndex + range.matchLength] ?? baseLF.length
    return baseLF.slice(start, end)
  })
  // 同构 slices 可以回填一个 actual oldString；异构 slices 只能保留模型形态，但两者都要保留 mismatch。
  const mismatch = slices.some((slice) => slice !== modelOld)
  if (slices.every((slice) => slice === slices[0])) return { oldString: slices[0], mismatch }
  // replaceAll 下 en-dash/ASCII 等异构实际切片无法塞进单个 oldString 字段
  // mismatch 必须在 representational fallback 前保留，否则历史字段回退会抹掉真实 normalized rewrite。
  return { oldString: modelOld, mismatch }
}

/**
 * 单一主路径：对 edits[]（长度 1 即旧「单点 edit」）在同一快照上定位并 reverse apply。
 *
 * 匹配语义在旧 exact 上扩展，不是单点/多点两套实现：
 * 1. 优先字面 exact（旧 OpenCode replace 的 indexOf / 唯一性 / replaceAll）
 * 2. exact 不足时 elevation 到 normalize 空间（Pi 式保守增强）
 * 3. 多条 edits 只是同一算法处理多个 range，禁止顺序应用
 *
 * elevation 判定：
 * - 任一条 findMatch 需要 usedNormalized，或
 * - 归一化出现次数 ≠ 字面出现次数（hybrid 连字符等）
 * 一旦 elevation，整批 range 都在 normalize(base) 上解析，避免混用两套坐标。
 *
 * apply 阶段：
 * - !usedNormalized：在原文 reverse 切串，未触碰字节绝对不变
 * - usedNormalized：preserve 触碰行；未触碰行保留原文行尾空白与特殊 Unicode
 *
 * syncEdits 仅服务会话历史真值（INV-16），不反向定义磁盘 apply。
 */
export function applyEdits(content: string, edits: EditReplacement[], path = "file"): ApplyEditsResult {
  if (edits.length === 0) {
    throw new Error("edits must contain at least one replacement.")
  }

  for (let i = 0; i < edits.length; i++) {
    if (edits[i].oldString.length === 0) {
      throw new Error(
        edits.length === 1
          ? `oldString must not be empty in ${path}.`
          : `edits[${i}].oldString must not be empty in ${path}.`,
      )
    }
    // 归一化后空 needle 会让 indexOf("") 挂住；create 由 execute 在进 apply 前分流。
    if (normalizeForMatch(edits[i].oldString).length === 0) {
      throw new Error(
        edits.length === 1
          ? `oldString is empty after normalization in ${path}.`
          : `edits[${i}].oldString is empty after normalization in ${path}.`,
      )
    }
  }

  // 是否需要整批 elevation：任一条 exact 找不到、或归一化出现次数与字面次数分歧（hybrid dash 等）
  const usedNormalized =
    edits.some((e) => findMatch(content, e.oldString).usedNormalized) ||
    edits.some((e) => countOccurrences(content, e.oldString) !== exactLiteralCount(content, e.oldString))

  const replacementBase = usedNormalized ? normalizeForMatch(content) : content
  const allRanges: TextReplacement[] = []
  const syncEdits: EditReplacement[] = []
  const normalizedMismatchIndices: number[] = []
  // mismatch 索引与 syncEdits 同源生成，调用方无需重新执行 normalize matcher 或猜测 actual slice。

  // 整批共用一个 pre-edit replacementBase，保证失败 index 对应模型提交的原始顺序，而不是增量结果。
  // 诊断因此可以精确绑定单条 edit，同时维持原有 reverse apply 和原子失败边界。
  for (let i = 0; i < edits.length; i++) {
    const edit = edits[i]
    // 统一 locate：在 replacementBase 上 exact-first（base 已是原文或已归一化）
    const match = findMatch(replacementBase, edit.oldString)
    if (!match.found) {
      // 记录 locate 的真实索引；closest 调用方必须使用它，不能回退到 edits[0] 猜测。
      throw new EditApplyError(
        edits.length === 1
          ? `Could not find oldString in the file. It must match exactly, including whitespace, indentation, and line endings.`
          : `Could not find edits[${i}].oldString in ${path}. The oldString must match exactly including all whitespace and newlines.`,
        i,
      )
    }

    // 唯一性：与旧 replace 相同 — 无 replaceAll 时任何第二处都拒绝；计数用 sole domain（归一化感知）
    const occurrences = usedNormalized
      ? countOccurrences(replacementBase, edit.oldString)
      : exactLiteralCount(replacementBase, edit.oldString)
    if (occurrences > 1 && edit.replaceAll !== true) {
      throw new EditApplyError(
        edits.length === 1
          ? `Found multiple matches for oldString. Provide more surrounding context to make the match unique.`
          : `Found ${occurrences} occurrences of edits[${i}] in ${path}. Each oldString must be unique. Provide more context to make it unique.`,
        i,
      )
    }

    const ranges = usedNormalized
      ? enumerateNormalizedRanges(replacementBase, edit.oldString, edit.replaceAll === true)
      : enumerateExactRanges(replacementBase, edit.oldString, edit.replaceAll === true)

    if (ranges.length === 0) {
      // 该失败属于当前 edit 的成功域检查，只有当前 oldString 可以成为诊断 probe。
      throw new EditApplyError(
        edits.length === 1
          ? `Could not find oldString in the file. It must match exactly, including whitespace, indentation, and line endings.`
          : `Could not find edits[${i}].oldString in ${path}.`,
        i,
      )
    }

    // identical 条目已过 locate/唯一性校验，但跳写：归一化漂移下 preserve 重写会
    // 擦洗触碰行字节，违背"逐条无操作"语义与 warning 真实性，故不推入 allRanges。
    if (edit.oldString !== edit.newString) {
      for (const range of ranges) {
        allRanges.push({
          matchIndex: range.matchIndex,
          matchLength: range.matchLength,
          newText: edit.newString,
          editIndex: i,
        })
      }
    }

    const actualOld =
      edit.oldString === edit.newString
        ? { oldString: edit.oldString, mismatch: false }
        : actualOldFromRanges(content, replacementBase, usedNormalized, ranges, edit.oldString)
    // identical 条目已被跳写，不能仅因 located slice 漂移就伪装成 history truth rewrite。
    // 该判断放在 locate/唯一性之后，既保留输入校验，又只记录真正进入 replacement 的条目。
    if (actualOld.mismatch) normalizedMismatchIndices.push(i)

    syncEdits.push({
      // identical 条目零写入、无命中切片可回填历史：oldString 保持提交形态，
      // 使 _syncInput/warning/模型输入三者一致；真实条目沿用 actualOld 真值。
      oldString: actualOld.oldString,
      newString: edit.newString,
      ...(edit.replaceAll === true ? { replaceAll: true } : {}),
    })
  }

  // 重叠拒绝：所有 range（含 replaceAll 展开）在 reverse apply 前检查
  const sorted = [...allRanges].sort((a, b) => a.matchIndex - b.matchIndex)
  for (let i = 1; i < sorted.length; i++) {
    const previous = sorted[i - 1]
    const current = sorted[i]
    if (previous.matchIndex + previous.matchLength > current.matchIndex) {
      throw new Error(
        `edits[${previous.editIndex}] and edits[${current.editIndex}] overlap in ${path}. Merge them into one edit or target disjoint regions.`,
      )
    }
  }

  // exact：原文 reverse 切串（旧 replace 的推广）；normalized：preserve 触碰行
  // closest 从未参与这里的 range 生成，任何相似文本都不能越过 exact/closed-normalization 成功域。
  const contentNew = usedNormalized
    ? applyReplacementsPreservingUnchangedLines(content, replacementBase, allRanges)
    : applyReplacements(replacementBase, allRanges)

  if (content === contentNew) {
    throw new Error(
      edits.length === 1
        ? `No changes to apply: oldString and newString are identical.`
        : `No changes made to ${path}. The replacements produced identical content.`,
    )
  }

  return { contentNew, usedNormalized, syncEdits, normalizedMismatchIndices }
}

/**
 * 兼容导出：单点 edit = applyEdits 长度 1。
 * 与历史 OpenCode `replace` 对外签名一致，内部禁止第二套匹配实现。
 * 失败错误文案与单元素 edits 路径相同，便于现有测试与调用方。
 */
export function replace(content: string, oldString: string, newString: string, replaceAll = false): string {
  return applyEdits(content, [{ oldString, newString, replaceAll }]).contentNew
}
