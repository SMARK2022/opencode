import { createHash } from "crypto"
import { createTwoFilesPatch } from "diff"

// V1三工具与原生V2 Edit/ApplyPatch共用表示owner，避免另一执行路径重新生成全文diff。
// source事故涉及二进制巨型metadata和大中段Myers耗时；三路表示保留变更事实与计数，不改变写盘。

// 前8192个JS字符只检查NUL，不使用不可打印比例启发式；字符窗口不等同Git的字节窗口。
// 二进制计数0/0与Snapshot既有展示一致，完整文件内容仍由工作树与快照持有。
export const BINARY_SCAN_CHARS = 8192

// 超限差异中段跳过Myers；公共上下文仍可能很长，不承诺固定运行时间或总字节界。
export const MAX_DIFF_MIDDLE_CHARS = 64 * 1024

// 单文件摘要归并超过1Mi字符时只换patch表示，显式计数继续累加，不是整个会话总量界。
export const MAX_MERGED_PATCH_CHARS = 1024 * 1024

export type RenderedFileDiff = { patch: string; additions: number; deletions: number }

// 首见与重复归并使用同一表示界，保留显式计数而不从省略标记倒推行数。
export function boundMergedPatch(patch: string, additions: number, deletions: number) {
  return patch.length > MAX_MERGED_PATCH_CHARS
    ? `[aggregated patch elided: ${patch.length} chars, +${additions}/-${deletions}]`
    : patch
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex")

function isBinaryText(text: string) {
  const window = text.length > BINARY_SCAN_CHARS ? text.slice(0, BINARY_SCAN_CHARS) : text
  return window.includes("\u0000")
}

// 按行裁剪公共前/后缀，返回中段行数组。与 jsdiff 内部的前置剪枝同语义，只用于预算
// 判定；行语义（无尾换行/CRLF）不完全一致时估计偏保守——只会更早触发重写标记，不会放行超限。
function trimCommonLines(oldText: string, newText: string) {
  const oldLines = oldText.split("\n")
  const newLines = newText.split("\n")
  let start = 0
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) start++
  let endOld = oldLines.length
  let endNew = newLines.length
  while (endOld > start && endNew > start && oldLines[endOld - 1] === newLines[endNew - 1]) {
    endOld--
    endNew--
  }
  return { oldMid: oldLines.slice(start, endOld), newMid: newLines.slice(start, endNew) }
}

function binaryMarker(filePath: string, oldText: string, newText: string): RenderedFileDiff {
  // 二进制用变更事实、字符度量和生产内容身份代替乱码行diff，完整内容仍在工作树/快照中。
  // 计数0/0沿用Snapshot二进制语义，不影响实际文件变更或恢复。
  return {
    patch: [
      `Index: ${filePath}`,
      "===================================================================",
      `Binary file ${filePath} changed: ${oldText.length} -> ${newText.length} chars`,
      `old sha256: ${sha256(oldText)}`,
      `new sha256: ${sha256(newText)}`,
      "(binary content not diffed)",
    ].join("\n"),
    additions: 0,
    deletions: 0,
  }
}

function rewriteMarker(filePath: string, oldMid: string[], newMid: string[], oldText: string, newText: string): RenderedFileDiff {
  // 超限中段：跳过 Myers 与行级产物。行数取中段口径（与正常路径"变更行"计数语义
  // 连续）；chars 与 sha256 是全文件身份，保证内容可追溯（用户否决"截断丢内容"）。
  return {
    patch: [
      `Index: ${filePath}`,
      "===================================================================",
      `--- ${filePath}  (whole-file rewrite: line diff skipped, delta > ${MAX_DIFF_MIDDLE_CHARS} chars)`,
      `+++ ${filePath}`,
      "@@ rewrite @@",
      `old: ${oldMid.length} mid lines, ${oldText.length} file chars, sha256 ${sha256(oldText)}`,
      `new: ${newMid.length} mid lines, ${newText.length} file chars, sha256 ${sha256(newText)}`,
    ].join("\n"),
    additions: newMid.length,
    deletions: oldMid.length,
  }
}

export function renderFileDiff(filePath: string, oldText: string, newText: string): RenderedFileDiff {
  if (isBinaryText(oldText) || isBinaryText(newText)) return binaryMarker(filePath, oldText, newText)
  const { oldMid, newMid } = trimCommonLines(oldText, newText)
  if (oldMid.join("\n").length + newMid.join("\n").length > MAX_DIFF_MIDDLE_CHARS) {
    return rewriteMarker(filePath, oldMid, newMid, oldText, newText)
  }
  const patch = createTwoFilesPatch(filePath, filePath, oldText, newText)
  // 计数从生成产物单遍推导（INV-08 单一权威），调用方不再跑第二遍 diffLines。
  const stats = countPatchStats(patch)
  return { patch, ...stats }
}

// 首个hunk前的---/+++是文件头，进入后同形前缀是内容；SQL注释等不能被误当文件头丢计数。
// 接受legacy裸@@头；rewrite标记的计数由显式字段携带，其正文不含增删前缀。
export function countPatchStats(patch: string) {
  let additions = 0
  let deletions = 0
  let inHunk = false
  for (const line of patch.split("\n")) {
    if (!inHunk) {
      if (line.startsWith("@@")) inHunk = true
      continue
    }
    if (line.startsWith("+")) additions++
    else if (line.startsWith("-")) deletions++
  }
  return { additions, deletions }
}

export * as FileDiff from "./file-diff"
