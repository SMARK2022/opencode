import { createHash } from "crypto"
import { createTwoFilesPatch } from "diff"

// [local-smark] 工具元数据 diff 的唯一生成 seam（apply_patch/edit/write 三工具共用）。
// 背景事故（2026-08-27）：apply_patch 删除 ~200MB ELF 二进制时，全文行 diff 产生了
// 407MB 的单 part 行；jsdiff 对"无公共前后缀的大中段"是二次方 Myers（实测中段
// 8000 行约 30s、640KB 文本重写 >139s）。本 seam 用三分表示同时界住入库体积与计算成本。

// 与 git buffer_is_binary 的 8000 字节窗口同值：只判 U+0000、不用不可打印比例启发式。
// snapshot/index.ts 的 git diffFull 路径（binary -> 计数 0/0）与本规则语义对齐。
export const BINARY_SCAN_CHARS = 8192

// 中段界同时是计算界与产物界：行级 diff 产物体积 ≈ 差异中段体积，64KiB 中段保证
// Myers 亚秒级且单文件 patch ≤ ~256KB 量级（中段 + hunk 上下文开销）。
export const MAX_DIFF_MIDDLE_CHARS = 64 * 1024

// SummaryCache 聚合把逐轮 patch 永久拼接（事故：216MB user message 行）。摄入界只
// 降级 patch 文本、计数照常累加，以此免疫已入库的 legacy 巨型 tool metadata。
export const MAX_MERGED_PATCH_CHARS = 1024 * 1024

export type RenderedFileDiff = { patch: string; additions: number; deletions: number }

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
  // 二进制行级 diff 不可读、无人工审计价值（正是 407MB 事故的构成物）；审计记录 =
  // 变更事实 + 度量 + sha256 身份对，完整内容由工作树与 git snapshot 持有。
  // 计数 0/0 与 snapshot git 路径的 binary 语义对齐。
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

// hunk 门控计数：unified 格式的文件头（Index/===/---/+++）只出现在首个 hunk 标记之前，
// 进入 hunk 后 "+"/"-" 前缀行即内容行——因此 hunk 内以 "--"/"++" 开头的内容行（SQL/Lua
// 注释、YAML 分隔符）被正确计入；仓库先例 plugin/vscode-bridge.ts 的 diffStats 同构。
// hunk 标记按 "@@" 前缀识别而非要求 range 后缀：既有写入方除 unified "@@ -a +b @@" 外，
// legacy 摘要 fixture 还使用裸 "@@" 头（summary-tool-diff 契约）；正文行在 unified 中
// 总以 +/-/空格开头，不会以 "@@" 误触。
// rewrite 标记的 "@@ rewrite @@" 之后的正文行不以 "+"/"-" 开头，天然不计数（计数由显式字段携带）。
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
