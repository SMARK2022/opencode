// [local-smark] 区间合并工具：将重叠或相邻（start <= last.end + 1）的区间合并为一个。
// 被 compaction.ts renderInspectedFiles 和 task.ts buildParentInspectedFilesSummary 共享。
// 标准 interval-merge 算法：先按 start 排序，再线性扫描合并。
// 不变量：输出区间按 start 升序排列，且任意两个区间不相邻（gap >= 2）。
export function mergeRanges(ranges: Array<{ start: number; end: number }>) {
  const sorted = ranges.toSorted((a, b) => a.start - b.start || a.end - b.end)
  return sorted.reduce<Array<{ start: number; end: number }>>((result, range) => {
    const last = result.at(-1)
    // 不相邻（gap > 1）时新建区间；相邻或重叠时扩展上一个区间的 end
    if (!last || range.start > last.end + 1) return [...result, { ...range }]
    last.end = Math.max(last.end, range.end)
    return result
  }, [])
}
