/**
 * vscode_notebook_source 返回一基全局虚拟源码，身份解析仍归 resolve。
 * 每格使用未编号头部 --: --- cN kind/lang id=#VSC-xxx lines=N range=[A,B] ---。
 * A..B 为该格的源码闭区间；格头和视觉分隔行均不消耗全局编号。
 * cellId 可限定窗口，offset 始终解释为全局编号；编辑或重排后应重新读取。
 * 读取不执行、保存单元格或切换内核。
 */
import vscode from "vscode"
import { stringProp, numberProp, quoteForSummary } from "../util"
import { c1, copilotLikeCellId, cellTypeLabel, computeVirtualRanges, runtimeLabel, notebookHeader, cellRef } from "./format"
import { resolveNotebook, resolveNotebookCell } from "./resolve"
import { writeArtifact } from "./output"

/**
 * filePath 必填，主定位参数为完整规范化 cellId。
 * offset 默认 1，所选格默认从其全局起点读取；越界时警告并重置到格起点。
 * limit 默认 400，源码长行完整保留；未编号格头不占正文行预算。
 * 16 KiB UTF-8 渲染预算包含格头和行号文本，不覆盖 XML 封装与续读提示；首个正文行可超预算以保证推进。
 * 返回 ran=false、实际 globalStart、returned、totalLines 与续读提示；分页只省略未返回的完整行。
 */
export async function notebookSource(input: Record<string, unknown>) {
  // source 复用身份解析接口并独占虚拟行分页，读取源码不能调用 run 模块。
  const filePath = stringProp(input, "filePath")
  if (!filePath) throw new Error("filePath is required")
  const notebook = await resolveNotebook(filePath)
  // limit 与字节预算分别约束正文数量和 UTF-8 输出，400 只作为缺省页大小。
  // requestedLimit 区分"用户显式传了 limit"和"使用默认值"：
  // 仅在未显式传 limit 且指定了 cellId 时自动扩展到整个 cell，避免破坏显式分页
  const requestedLimit = numberProp(input, "limit")
  let limit = Math.max(1, requestedLimit ?? 400)
  // 行数预算与字节预算互补，大量空行或短行虽少占字节也不能无限占用提示版面。
  const offset = Math.max(1, numberProp(input, "offset") ?? 1)

  const ranges = computeVirtualRanges(notebook)

  const cellId = stringProp(input, "cellId")
  // 显式 ID 的失败和碰撞沿共享 resolver 拒绝，不能 .find 未命中后静默读取全本。
  const cell = cellId ? resolveNotebookCell(notebook, undefined, cellId) : undefined
  const targetCellIndex = cell?.index

  // 全本终点取共享范围的最大 end，不把未编号格头或末尾分隔行塞进可编辑区间。
  const totalLines = lastRangeEnd(ranges) ?? 0
  let globalStart = 1
  let globalEnd = totalLines
  let warning = ""

  if (targetCellIndex !== undefined && ranges.has(targetCellIndex)) {
    const range = ranges.get(targetCellIndex)!
    // 指定 cellId 但未显式传 limit 时，自动扩展到整个 cell 行数（上限 1000）。
    // 数据库取证显示 source_before_edit 成功率反而低于 edit_before_edit，
    // 根因是 agent 分页读取后 oldCode 跨越页面边界。自动扩展让 agent 一次
    // 获取完整 cell，16KB 字节上限仍作为硬边界。
    if (requestedLimit === undefined) {
      limit = Math.max(limit, Math.min(range.end - range.start + 1, 1000))
    }
    if (input.offset !== undefined) {
      if (offset >= range.start && offset <= range.end) {
        // 全局续读行号优先，避免同一数值也可作局部偏移时跳过上一页指定的继续位置。
        globalStart = offset
      } else {
        globalStart = range.start
        warning = "Offset is outside the target cell range; reset to the cell range start. Offsets are global virtual source line numbers."
      }
    } else {
      globalStart = range.start
    }
    globalEnd = range.end
  } else if (input.offset !== undefined) {
    globalStart = offset
  }

  // 空文档仍使用一作为起点，零总行数不能使 clamp 生成负的续读位置。
  globalStart = Math.max(1, Math.min(globalStart, totalLines > 0 ? totalLines : 1))

  // #178：源码页预算降为16KiB，保留既有长行推进与全局续读坐标。
  const maxBytes = 16 * 1024
  let bytes = 0
  // 正文行数与字节截断分开记录，格头只计入字节预算。
  let renderedLines = 0
  let bytesCut = false
  let sourceArtifact: string | undefined
  let lastRenderedLine = 0
  const outputCells: string[] = []
  const cells: { cellID: string; offset: number; content: string }[] = []

  for (const cell of notebook.getCells()) {
    const cellRange = ranges.get(cell.index)
    if (!cellRange) continue

    // 当前格正文与全局窗口取交集，页外格既不打印头部也不占正文预算。
    const srcStart = Math.max(globalStart, cellRange.start)
    const srcEnd = Math.min(globalEnd, cellRange.end)

    if (srcStart > srcEnd) {
      continue
    }

    if (renderedLines >= limit) break
    const headerLine = buildHeader(cell, cellRange)
    const hdrBytes = Buffer.byteLength(headerLine, "utf8") + 4 // "--: "
    if (bytes + hdrBytes > maxBytes && outputCells.length > 0) {
      bytesCut = true
      break
    }
    outputCells.push(headerLine)
    bytes += hdrBytes
    const lines: string[] = []

    // 格头计入字节但不占编号正文预算，limit=1 也必须能读取并推进一行源码。
    for (let i = 0; i < cell.document.lineCount; i++) {
      // 直接按共享起点定位，分页跳过前格也不依赖累积计数。
      const globalLineNum = cellRange.start + i
      if (globalLineNum < globalStart) continue
      if (globalLineNum > globalEnd) {
        break
      }
      if (renderedLines >= limit) break
      // 精确编辑需要完整源行，分页仍沿既有行数与 UTF-8 字节预算。
      const sourceLine = cell.document.lineAt(i).text
      const outLine = `${globalLineNum}: ${sourceLine}`
      // UTF-8 预算包括真实行号前缀，多字节正文不能用字符数冒充输出字节。
      const outBytes = Buffer.byteLength(outLine, "utf8")
      // 首行超整页预算时保留编号与有界前缀，避免只返回格头而无法推进分页。
      if (bytes + outBytes > maxBytes) {
        if (renderedLines > 0) {
          // 当前页放不下的完整行留给下一页，不能按字节裁掉无法续读的后缀。
          bytesCut = true
          break
        }
        // 行内尾段不能以offset+1恢复；按300码点JSON分片导出dirty全文，仍复用唯一writer。
        const chunks = Array.from(cell.document.getText().matchAll(/[\s\S]{1,300}/gu), (match) => JSON.stringify(match[0]))
        const artifact = await writeArtifact(notebook, cell, { mime: "application/json", data: Buffer.from(chunks.join("\n")) }, 0, 0)
        // 远程提供者必须保留scheme/authority，不能只交付其本地形状fsPath。
        sourceArtifact = artifact.uri.scheme === "file" ? artifact.fsPath : artifact.uri.toString()

        const prefix = `${globalLineNum}: `
        const prefixBytes = Buffer.byteLength(prefix, "utf8")
        const available = maxBytes - bytes - prefixBytes
        if (available > 0) {
          const content = takeUtf8Prefix(sourceLine, available)
          outputCells.push(prefix + content)
          lines.push(content)
          renderedLines++
          lastRenderedLine = globalLineNum
        }
        bytesCut = true
        break
      }
      outputCells.push(outLine)
      lines.push(sourceLine)
      bytes += outBytes
      renderedLines++
      lastRenderedLine = globalLineNum
    }

    // 只收取同一分页器已选择的正文，保留cell边界而不解析带行号的展示文本。
    if (lines.length > 0) cells.push({ cellID: copilotLikeCellId(cell), offset: srcStart, content: lines.join("\n") })
    if (bytesCut || renderedLines >= limit) break
  }

  // 仅有剩余正文容量时补齐窗口终点，满额页按实际返回编号判断是否仍需续读。
  if (!bytesCut && renderedLines < limit) lastRenderedLine = Math.max(lastRenderedLine, Math.min(globalEnd, totalLines))
  const more = lastRenderedLine < globalEnd

  const targetRange = targetCellIndex !== undefined ? ranges.get(targetCellIndex) : undefined
  let output = [
    ...notebookHeader(notebook, "Source", [
      `target=${quoteForSummary(cell ? cellRef(cell) : "all")}`,
      targetRange ? `range=[${targetRange.start},${targetRange.end}]` : undefined,
      `offset=${globalStart}`,
      `limit=${limit}`,
      `returned=${renderedLines}`,
      `total=${totalLines}`,
      `truncated=${bytesCut || more}`,
      `dirty=${notebook.isDirty}`,
      `runtime=${quoteForSummary(runtimeLabel(notebook) ?? "unknown")}`,
    ]),
    warning ? `Warning: ${warning}` : undefined,
    "",
  ].filter((line): line is string => line !== undefined).join("\n")
  output += "\n"
  output +=
    [`<path>${notebook.uri.fsPath || notebook.uri.toString()}</path>`, `<type>notebook</type>`, "<content>"].join(
      "\n",
    ) + "\n"
  output += outputCells.join("\n")

  if (sourceArtifact) {
    // 每行是独立JSON字符串；按顺序解析再连接，不引入额外换行。
    output += `\n\n(Full current cell source: ${sourceArtifact}. Read this artifact with offset/limit; JSON-decode each line and concatenate the strings to recover the exact source.)`
  } else if (bytesCut) {
    output += `\n\n(Output capped at 16 KB. Showing lines ${globalStart}-${lastRenderedLine}. Use offset=${lastRenderedLine + 1} to continue.)`
  } else if (more) {
    output += `\n\n(Showing lines ${globalStart}-${lastRenderedLine} of ${totalLines}. Use offset=${lastRenderedLine + 1} to continue.)`
  }
  output += "\n</content>"

  return {
    ran: false,
    summary: output,
    data: {
      path: notebook.uri.fsPath || notebook.uri.toString(),
      target: targetCellIndex !== undefined ? `cell ${targetCellIndex + 1}` : "all",
      cellId: cellId ?? (targetCellIndex !== undefined ? copilotLikeCellId(notebook.cellAt(targetCellIndex)) : undefined),
      globalStart,
      limit,
      returned: renderedLines,
      totalLines,
      sourceArtifact,
      cells,
      ...(!sourceArtifact && (bytesCut || more) ? { next: lastRenderedLine + 1 } : {}),
      truncated: bytesCut || more,
    },
  }
}

// 格头只显示 source/edit/summary 共用的范围，不独立重算源行数的坐标。
function buildHeader(cell: vscode.NotebookCell, range: { start: number; end: number }) {
  const id = copilotLikeCellId(cell)
  return `--: --- c${c1(cell)} ${cellTypeLabel(cell.kind)}/${cell.document.languageId} id=${id} lines=${cell.document.lineCount} range=[${range.start},${range.end}] ---`
}

function lastRangeEnd(ranges: Map<number, { start: number; end: number }>) {
  let max = 0
  for (const r of ranges.values()) {
    if (r.end > max) max = r.end
  }
  return max > 0 ? max : undefined
}

function takeUtf8Prefix(text: string, maxBytes: number) {
  // #252：按码点迭代而非按字节切片——预览保持合法 UTF-8，同时尊重字节预算
  // #252：多字节字符被腰斩会产生无效序列，下游终端渲染直接损坏
  // Iterate by Unicode code point instead of slicing bytes directly. This keeps
  // the preview valid UTF-8 while still honoring the byte budget enforced by the
  // notebook source tool output cap.
  let bytes = 0
  let out = ""
  for (const char of text) {
    const next = Buffer.byteLength(char, "utf8")
    if (bytes + next > maxBytes) return out
    bytes += next
    out += char
  }
  return out
}
