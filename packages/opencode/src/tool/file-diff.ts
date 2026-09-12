import { createHash } from "crypto"
import { createTwoFilesPatch, diffLines } from "diff"

// [local-smark] 工具元数据 diff 的唯一生成 seam（apply_patch/edit/write 三工具共用）。
// 背景事故（2026-08-27）：apply_patch 删除 ~200MB ELF 二进制时，全文行 diff 产生了
// 407MB 的单 part 行；jsdiff 对"无公共前后缀的大中段"是二次方 Myers（实测中段
// 8000 行约 30s、640KB 文本重写 >139s）。本 seam 用三分表示同时界住入库体积与计算成本。

// 与 git buffer_is_binary 的 8000 字节窗口同值：只判 U+0000、不用不可打印比例启发式。
// snapshot/index.ts 的 git diffFull 路径（binary -> 计数 0/0）与本规则语义对齐。
export const BINARY_SCAN_CHARS = 8192

// 计算预算（R2 门B 判据之一）：jsdiff 行级 Myers 的成本由编辑距离 D 驱动（对角剪枝下
// 约 O((N+M)+D²)），中段体积只是无关代理变量——2026-09-02 precheck.ts 事故里 D=36 的
// 小改因中段 >64KiB 被误判超限。maxEditLength 探测在 D≤K 内必然完成、超出则同步返回
// undefined 立即放弃，界住算力而不猜测。K=2000：兼容既有 fixture（D=4000/16000 仍走
// 标记），abort 工作量按 K² 增长，事故输入实测亚秒级（apply_patch.test 切片 5）。
export const MAX_DIFF_EDIT_LINES = 2000

// 产物界（R2 门B 判据之二）：对最终 patch 直接度量，取代旧的“输入中段”承诺。编辑距离
// 界不住单行长度（minified 文件 D=2 但单行 >64KiB），只有对产物本身量体积才是精确界。
export const MAX_DIFF_PATCH_CHARS = 64 * 1024

// SummaryCache 聚合把逐轮 patch 永久拼接（事故：216MB user message 行）。摄入界只
// 降级 patch 文本、计数照常累加，以此免疫已入库的 legacy 巨型 tool metadata。
export const MAX_MERGED_PATCH_CHARS = 1024 * 1024

export type RenderedFileDiff = { patch: string; additions: number; deletions: number }

// 连续前缀裁剪（INV-08；C01 教训）：text 永远是 patch 的逐字节前缀，omitted 等于真实
// 剩余行数。旧 edit.ts 内联循环用 continue 跳过超放行、后续短行仍进入，展示中间出洞
// 却把「只裁尾部」的印象留给模型——这里只许切一刀，长行处即整体截止。
export function boundDiff(patch: string, budget: { maxLines: number; maxBytes: number }) {
  const lines = patch.split("\n")
  let bytes = 0
  let kept = 0
  while (kept < lines.length && kept < budget.maxLines) {
    const size = Buffer.byteLength(lines[kept], "utf-8") + (kept > 0 ? 1 : 0)
    if (bytes + size > budget.maxBytes) break
    bytes += size
    kept++
  }
  return { text: lines.slice(0, kept).join("\n"), omitted: lines.length - kept }
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex")

function isBinaryText(text: string) {
  const window = text.length > BINARY_SCAN_CHARS ? text.slice(0, BINARY_SCAN_CHARS) : text
  return window.includes("\u0000")
}

// 按行裁剪公共前/后缀，返回中段行数组。R2 起职责收缩为“标记计数口径”——不再参与
// 门控判定（判据移交编辑距离预算与产物直测）；行语义（无尾换行/CRLF）不完全一致时
// 估计偏保守，只会让标记更早出现，不会放行超限产物。
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
  // R2 合法化：正文行加空格前缀成为 context 行 + 合法 hunk range，任意 unified
  // 消费者（TUI Diff renderable/权限预览）零特判解析；保留大写 "Binary file" 措辞
  // 是 apply_patch.test.ts 钉死断言的兼容承诺。
  return {
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
  // 超限中段：跳过行级产物。行数取中段口径（此时中段≈真实变更行，计数语义连续，
  // INV-08）；chars 与 sha256 是全文件身份，保证内容可追溯（用户否决“截断丢内容”）。
  // R2 合法化：与 binary 标记同构——context 行前缀 + 合法 range，parsePatch 可解析
  // （旧版裸 `old:` 行是 TUI “Error parsing diff” 红字的直接根因）；正文行不以
  // +/- 开头，计数重扫天然 0/0（真实计数由显式字段携带）。
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

// 行多重集对称差 |old\\new| + |new\\old| 是行级编辑距离 D 的下界：只在单侧出现的每个
// 行实例都必须被删除/插入，任何编辑脚本都受其约束。行尾差异（CRLF/尾换行空 token）
// 会让下界偏松（strip 后一致性更粗、所需编辑更少），永不偏紧——因此对称差严格大于
// MAX_DIFF_EDIT_LINES 时，jsdiff 探测（diff.js 同步循环按 editLength 递增穷举到 K+1）
// 必然中止，直接走 rewriteMarker 与探测中止的决策逐字节一致。
// 动机实测：jsdiff 中止路径自身是 O(K²) 且每步分配路径对象（事故 fixture 纯探测
// ~1280ms），慢机器上会越过性能回归测试的 1000ms 预算；本过滤是 O(N) 哈希计数。
function exceedsEditBudgetByLineMultiset(oldText: string, newText: string) {
  // 分词对齐 jsdiff 行分词的 strip 形态：split("\n") 后去尾部空 token（尾换行产生），
  // 行尾 \r 归入行内容（strip 只让一致性更粗，保持下界方向安全）。
  const counts = new Map<string, number>()
  let excess = 0
  const consume = (text: string, sign: 1 | -1) => {
    const lines = text.split("\n")
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop()
    for (const line of lines) {
      const next = (counts.get(line) ?? 0) + sign
      counts.set(line, next)
      // excess 只跟踪 |count| 的增量变化，避免最后再一次全表求和。
      excess += Math.abs(next) - Math.abs(next - sign)
    }
  }
  consume(oldText, 1)
  consume(newText, -1)
  return excess > MAX_DIFF_EDIT_LINES
}

export function renderFileDiff(filePath: string, oldText: string, newText: string): RenderedFileDiff {
  if (isBinaryText(oldText) || isBinaryText(newText)) return binaryMarker(filePath, oldText, newText)
  // INV-11：下界严格大于预算时探测必然中止，跳过的不是「可能成功」的路径。
  if (exceedsEditBudgetByLineMultiset(oldText, newText)) {
    const { oldMid, newMid } = trimCommonLines(oldText, newText)
    return rewriteMarker(filePath, oldMid, newMid, oldText, newText)
  }
  // 门B（R2）：带预算的真实计算取代中段体积猜测。探测即主路径计算本身（jsdiff 原生
  // maxEditLength，预算耗尽同步返回 undefined），不是失败后备路径。
  const probe = diffLines(oldText, newText, { maxEditLength: MAX_DIFF_EDIT_LINES })
  // 探测成功 ⇒ 这一次 createTwoFilesPatch 在相同输入上必然同样在预算内完成（确定性
  // 同算法双跑，成本只差常数因子），且输出与既有正常路径逐字节一致（零格式漂移）。
  const patch = probe === undefined ? undefined : createTwoFilesPatch(filePath, filePath, oldText, newText)
  if (patch === undefined || patch.length > MAX_DIFF_PATCH_CHARS) {
    const { oldMid, newMid } = trimCommonLines(oldText, newText)
    return rewriteMarker(filePath, oldMid, newMid, oldText, newText)
  }
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
// rewrite/binary 标记正文行是空格前缀的 context 行，天然不计数（计数由显式字段携带）。
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
