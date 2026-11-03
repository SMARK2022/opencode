export function previewDiff(input: string, maxLines: number) {
  // max(1,...) 防止 0/负预算把整个预览清空
  const limit = Math.max(1, maxLines)
  const src = input.split("\n")
  const out: string[] = []
  const body: string[] = []
  let oldStart = "",
    newStart = "",
    suffix = "",
    left = 0,
    right = 0,
    cut = false
  // left/right 是分栏行预算：split 视图两侧独立计数，任一侧触顶即截断
  let expectedOld = 0,
    expectedNew = 0,
    changed = false

  // Flush each preview hunk as a fresh, parser-valid hunk. The preview may drop
  // trailing body lines, so the original @@ counts must be rewritten to the
  // actual old/new line counts that remain visible to DiffRenderable.
  // #233：计数改为惰性函数——省略号 context 行 push 后行数变化，重复计数必须实时反映
  const oldVisible = () => body.filter((line) => line[0] === " " || line[0] === "-").length
  const newVisible = () => body.filter((line) => line[0] === " " || line[0] === "+").length
  const flush = () => {
    if (!oldStart) return

    // 计数重写是本函数的核心契约：截断后 @@ 头若沿用原值，parsePatch 会按虚高行数越界读行
    // #233：计数改为惰性函数——行数变化时重复计数必须实时反映
    const countMismatch = oldVisible() !== expectedOld || newVisible() !== expectedNew
    // #564：截断预览不注入 ` …` sentinel 行：hunk header 已按 oldVisible()/newVisible()
    // 重算为实际保留行数，parsePatch 依此即可解析；“还有更多”由 BlockTool footer 承载。
    changed ||= cut || countMismatch
    out.push(`@@ -${oldStart},${oldVisible()} +${newStart},${newVisible()} @@${suffix}`, ...body)
    oldStart = newStart = suffix = ""
    expectedOld = expectedNew = left = right = 0
    body.length = 0
  }

  for (let i = 0; i < src.length; i++) {
    const line = src[i]
    if (cut) continue

    const hunk = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/)
    if (hunk) {
      // #233：进入新 hunk 先 flush 前一 hunk——输出保持解析器可接受的独立 hunk 形态
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

    // #233：完整 hunk 后可出现新的文件头或 patch 元数据——先 flush 再处理，
    // #233：使类头源行只在预期 hunk 体消费期间才合法。
    // #233：此处基于可见行数判断完整性——被预算截断的 hunk 不满足计数，继续消费。
    if (oldVisible() >= expectedOld && newVisible() >= expectedNew) {
      flush()
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

    // #233：hunk 内 +/- 消费——`+++`/`---` 此时可能是合法源码行，仅按预期
    // #233：行数耗尽停止；已满足侧的行触发 flush 而非死循环。
    if (line[0] === "-" || line[0] === "+") {
      const del: string[] = []
      const add: string[] = []
      let j = i
      // #233：seen 计数从当前 body 起算——已消费行不重复计入本 hunk 的预期配额
      let seenOld = oldVisible()
      let seenNew = newVisible()
      while (src[j] && /^[+-]/.test(src[j])) {
        if (seenOld >= expectedOld && seenNew >= expectedNew) break
        if (src[j][0] === "-") {
          if (seenOld >= expectedOld) break
          del.push(src[j])
          seenOld++
          j++
          continue
        }
        if (seenNew >= expectedNew) break
        add.push(src[j])
        seenNew++
        j++
      }
      if (j === i) {
        // #233：畸形或已裁剪 hunk 对已满足侧再抛一行——防止外层循环对同一行无限重处理。
        // #564：flush 只把当前 body 写入 out（不再补省略号行），随后该行按原文透传。
        flush()
        out.push(line)
        continue
      }
      // #233：左右预算独立截取——del/add 各自不超过 split 视图的可见额度
      const dl = Math.min(del.length, limit - left)
      const al = Math.min(add.length, limit - right)
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
