export function previewDiff(input: string, maxLines: number) {
  const limit = Math.max(1, maxLines)
  const src = input.split("\n")
  const out: string[] = []
  const body: string[] = []
  let oldStart = "", newStart = "", suffix = "", left = 0, right = 0, cut = false
  let expectedOld = 0,
    expectedNew = 0,
    changed = false
  const oldVisible = () => body.filter((line) => line[0] === " " || line[0] === "-").length
  const newVisible = () => body.filter((line) => line[0] === " " || line[0] === "+").length

  // Flush each preview hunk as a fresh, parser-valid hunk. The preview may drop
  // trailing body lines, so the original @@ counts must be rewritten to the
  // actual old/new line counts that remain visible to DiffRenderable.
  const flush = () => {
    if (!oldStart) return

    const countMismatch = oldVisible() !== expectedOld || newVisible() !== expectedNew
    const incomplete = oldVisible() < expectedOld || newVisible() < expectedNew
    // Match previewText's "N visible rows plus one ellipsis row" contract, but
    // keep the ellipsis as a legal context line so parsePatch accepts it. The
    // incomplete branch covers metadata that was already clipped mid-hunk.
    if (cut || incomplete) body.push(" …")
    changed ||= cut || countMismatch
    out.push(
      `@@ -${oldStart},${oldVisible()} +${newStart},${newVisible()} @@${suffix}`,
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
      oldStart = hunk[1]
      expectedOld = Number(hunk[2] ?? 1)
      newStart = hunk[3]
      expectedNew = Number(hunk[4] ?? 1)
      suffix = hunk[5] ?? ""
      continue
    }

    if (!oldStart) {
      out.push(line)
      continue
    }

    if (oldVisible() >= expectedOld && newVisible() >= expectedNew) {
      // A new file header or other patch metadata can follow a completed hunk.
      // Flush before handling it so header-like source rows remain valid only
      // while the expected hunk body is still being consumed.
      flush()
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

    if (line[0] === "-" || line[0] === "+") {
      const del: string[] = []
      const add: string[] = []
      let j = i
      // We are already inside a hunk; `+++`/`---` here can be legitimate source
      // rows, so stop only when this hunk's expected old/new rows are consumed.
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
        // Malformed or already-clipped hunks can present a row for the side whose
        // expected count is already satisfied. Flush with an ellipsis instead of
        // reprocessing the same row forever in the outer loop.
        flush()
        out.push(line)
        continue
      }
      const dl = Math.min(del.length, limit - left)
      const al = Math.min(add.length, limit - right)
      body.push(...del.slice(0, dl), ...add.slice(0, al))
      left += dl
      right += al
      cut ||= dl < del.length || al < add.length
      i = j - 1
    }
  }

  flush()
  return changed ? out.join("\n") : input
}
