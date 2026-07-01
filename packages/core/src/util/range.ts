// 排序后合并重叠或相邻区间，压缩交接与两代父上下文共用同一规则。
export function mergeRanges(ranges: readonly { start: number; end: number }[]) {
  const sorted = ranges.toSorted((a, b) => a.start - b.start || a.end - b.end)
  return sorted.reduce<Array<{ start: number; end: number }>>((result, range) => {
    const last = result.at(-1)
    // 复制新区间，避免合并修改调用者保存的历史凭证。
    if (!last || range.start > last.end + 1) return [...result, { ...range }]
    last.end = Math.max(last.end, range.end)
    return result
  }, [])
}
