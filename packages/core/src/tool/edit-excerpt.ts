export function closestMatch(content: string, expected: string) {
  const first = expected.split("\n").find(line => line.trim().length >= 3)?.trim().toLowerCase()
  if (!first) return undefined
  const letters = new Set(first)
  const lines = content.split("\n")
  // 摘录只辅助重试，不能把相似位置当作授权后的真实匹配。
  const best = lines.map((line, index) => {
    const candidate = line.trim().toLowerCase()
    const common = [...candidate].filter(letter => letters.has(letter)).length
    return { index, score: common / Math.max(1, Math.min(first.length, candidate.length)) }
  }).sort((a, b) => b.score - a.score)[0]
  if (!best || best.score < 0.3) return undefined
  const start = Math.max(0, best.index - 1)
  return {
    line: start + 1,
    excerpt: lines.slice(start, best.index + 4).join("\n").slice(0, 500),
  }
}
