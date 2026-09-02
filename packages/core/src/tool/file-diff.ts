import { createHash } from "crypto"
import { createTwoFilesPatch, diffLines } from "diff"

// V1三工具与原生V2 Edit/ApplyPatch共用表示owner，避免另一执行路径重新生成全文diff。
// source事故涉及二进制巨型metadata和大中段Myers耗时；三路表示保留变更事实与计数，不改变写盘。

// 前8192个JS字符只检查NUL，不使用不可打印比例启发式；字符窗口不等同Git的字节窗口。
// 二进制计数0/0与Snapshot既有展示一致，完整文件内容仍由工作树与快照持有。
export const BINARY_SCAN_CHARS = 8192

// 计算预算按编辑距离而非跨度；2000兼容原大重写切片，耗尽由jsdiff原生返回undefined。
export const MAX_DIFF_EDIT_LINES = 2000

// 小编辑距离仍可能产生巨行diff，必须独立量最终JS字符长度，不把它说成UTF-8字节界。
export const MAX_DIFF_PATCH_CHARS = 64 * 1024

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

// 裁公共头尾只为标记的显式中段计数，不再参与预算或产物门控。
// 这里的无尾换行/CRLF行口径可能不同于jsdiff，不用于推断精确编辑距离。
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
    // 合法context hunk让现有渲染器直接解析；保留Binary file词形及0/0重扫语义。
    patch: [
      `Index: ${filePath}`,
      "===================================================================",
      `--- ${filePath}`,
      `+++ ${filePath}`,
      "@@ -1,4 +1,4 @@",
      ` Binary file ${filePath} changed: ${oldText.length} -> ${newText.length} chars`,
      ` old sha256: ${sha256(oldText)}`,
      ` new sha256: ${sha256(newText)}`,
      " (binary content not diffed)",
    ].join("\n"),
    additions: 0,
    deletions: 0,
  }
}

function rewriteMarker(filePath: string, oldMid: string[], newMid: string[], oldText: string, newText: string): RenderedFileDiff {
  // 预算耗尽或产物超界只降级展示，显式中段计数及完整内容身份继续保留。
  // 正文使用context前缀和合法range，普通解析器无需特判，重扫0/0不覆盖显式计数。
  return {
    patch: [
      `Index: ${filePath}`,
      "===================================================================",
      `--- ${filePath}  (whole-file rewrite: line diff skipped, exceeds diff budget)`,
      `+++ ${filePath}`,
      "@@ -1,2 +1,2 @@",
      ` old: ${oldMid.length} mid lines, ${oldText.length} file chars, sha256 ${sha256(oldText)}`,
      ` new: ${newMid.length} mid lines, ${newText.length} file chars, sha256 ${sha256(newText)}`,
    ].join("\n"),
    additions: newMid.length,
    deletions: oldMid.length,
  }
}

export function renderFileDiff(filePath: string, oldText: string, newText: string): RenderedFileDiff {
  if (isBinaryText(oldText) || isBinaryText(newText)) return binaryMarker(filePath, oldText, newText)
  // 直接用jsdiff原生预算探测；跨度大但改动小的文本仍走真实行级diff。
  const probe = diffLines(oldText, newText, { maxEditLength: MAX_DIFF_EDIT_LINES })
  // 探测成功才使用原生成器以保留正常格式；编辑距离不能替代独立的产物长度检查。
  const patch = probe === undefined ? undefined : createTwoFilesPatch(filePath, filePath, oldText, newText)
  if (patch === undefined || patch.length > MAX_DIFF_PATCH_CHARS) {
    const { oldMid, newMid } = trimCommonLines(oldText, newText)
    return rewriteMarker(filePath, oldMid, newMid, oldText, newText)
  }
  // 计数从生成产物单遍推导（INV-08 单一权威），调用方不再跑第二遍 diffLines。
  const stats = countPatchStats(patch)
  return { patch, ...stats }
}

// 首个hunk前的---/+++是文件头，进入后同形前缀是内容；SQL注释等不能被误当文件头丢计数。
// 接受legacy裸@@头；合法binary/rewrite正文是context行，0/0重扫不替代显式计数。
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
