export function previewDiff(input: string, maxLines: number) {
  const limit = Math.max(1, maxLines)
  const src = input.split("\n")
  const out: string[] = []
  const body: string[] = []
  let oldStart = "", newStart = "", suffix = "", left = 0, right = 0, cut = false
  let expectedOld = 0,
    expectedNew = 0,
    changed = false

  // Flush each preview hunk as a fresh, parser-valid hunk. The preview may drop
  // trailing body lines, so the original @@ counts must be rewritten to the
  // actual old/new line counts that remain visible to DiffRenderable.
  const flush = () => {
    if (!oldStart) return

    const oldVisible = body.filter((line) => line[0] === " " || line[0] === "-").length
    const newVisible = body.filter((line) => line[0] === " " || line[0] === "+").length
    const countMismatch = oldVisible !== expectedOld || newVisible !== expectedNew
    const incomplete = oldVisible < expectedOld || newVisible < expectedNew
    // Match previewText's "N visible rows plus one ellipsis row" contract, but
    // keep the ellipsis as a legal context line so parsePatch accepts it. The
    // incomplete branch covers metadata that was already clipped mid-hunk.
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
      const paired = del.length > 0 && add.length > 0
      const take = paired ? Math.min(del.length, add.length, limit - left, limit - right) : 0
      const dl = paired ? take : Math.min(del.length, limit - left)
      const al = paired ? take : Math.min(add.length, limit - right)
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
