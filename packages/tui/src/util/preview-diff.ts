export function previewDiff(input: string, maxLines: number) {
  // max(1,...) 防止 0/负预算把整个预览清空
  const limit = Math.max(1, maxLines)
  const src = input.split("\n")
  const out: string[] = []
  const body: string[] = []
  let oldStart = "", newStart = "", suffix = "", left = 0, right = 0, cut = false
  // left/right 是分栏行预算：split 视图两侧独立计数，任一侧触顶即截断
  let expectedOld = 0,
    expectedNew = 0,
    changed = false

  // Flush each preview hunk as a fresh, parser-valid hunk. The preview may drop
  // trailing body lines, so the original @@ counts must be rewritten to the
  // actual old/new line counts that remain visible to DiffRenderable.
  const flush = () => {
    if (!oldStart) return

    // 计数重写是本函数的核心契约：截断后 @@ 头若沿用原值，parsePatch 会按虚高行数越界读行
    const oldVisible = body.filter((line) => line[0] === " " || line[0] === "-").length
    const newVisible = body.filter((line) => line[0] === " " || line[0] === "+").length
    const countMismatch = oldVisible !== expectedOld || newVisible !== expectedNew
    const incomplete = oldVisible < expectedOld || newVisible < expectedNew
    // Match previewText's "N visible rows plus one ellipsis row" contract, but
    // keep the ellipsis as a legal context line so parsePatch accepts it. The
    // incomplete branch covers metadata that was already clipped mid-hunk.
    // 省略号必须是合法 context 行（前缀空格）：带 +/- 前缀会破坏 hunk 行数账目
    if (cut || incomplete) body.push(" …")
    changed ||= cut || countMismatch
    out.push(
      `@@ -${oldStart},${body.filter((line) => line[0] === " " || line[0] === "-").length} +${newStart},${body.filter((line) => line[0] === " " || line[0] === "+").length} @@${suffix}`,
      ...body,
    )
    oldStart = newStart = suffix = ""
    expectedOld = expectedNew = left = right = 0
    body.length = 0
  }

  for (let i = 0; i < src.length; i++) {
    const line = src[i]
    if (cut) continue

    const hunk = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/)
    if (hunk) {
      flush()
      // hunk 头必须精确锚定：宽松匹配会把正文里类 @@ 的行误判为新 hunk 起点
      oldStart = hunk[1]
      expectedOld = Number(hunk[2] ?? 1)
      newStart = hunk[3]
      expectedNew = Number(hunk[4] ?? 1)
      suffix = hunk[5] ?? ""
      continue
    }

    if (!oldStart) {
      // 文件头（Index/---/+++）原样透传，预览保持完整 diff 结构
      out.push(line)
      continue
    }

    if (line[0] === " ") {
      if (left >= limit || right >= limit) {
        cut = true
        continue
      }
      body.push(line)
      left++
      right++
      continue
    }

    if ((line[0] === "-" && !line.startsWith("---")) || (line[0] === "+" && !line.startsWith("+++"))) {
      const del: string[] = []
      const add: string[] = []
      let j = i
      while (src[j] && /^[+-]/.test(src[j]) && !/^(---|\+\+\+)/.test(src[j])) {
        ;(src[j][0] === "-" ? del : add).push(src[j])
        j++
      }
      // 成对增删按对齐截取：单侧截断会让 split 视图左右错位
      const paired = del.length > 0 && add.length > 0
      const take = paired ? Math.min(del.length, add.length, limit - left, limit - right) : 0
      const dl = paired ? take : Math.min(del.length, limit - left)
      const al = paired ? take : Math.min(add.length, limit - right)
      body.push(...del.slice(0, dl), ...add.slice(0, al))
      left += dl
      right += al
      cut ||= dl < del.length || al < add.length
      // 一次性消费整组 +/-，外层循环不再重复处理已入账行
      i = j - 1
    }
  }

  flush()
  // 未截断时返回原串引用，调用方可安全做 identity 比较
  return changed ? out.join("\n") : input
}
