/**
 * vscode_notebook_source 返回一基全局虚拟源码，身份解析仍归 resolve。
 * 每格使用未编号头部 --: --- cN kind/lang id=#VSC-xxx lines=N range=[A,B] ---。
 * A..B 为该格的源码闭区间；格头和视觉分隔行均不消耗全局编号。
 * cellId 可限定窗口，offset 始终解释为全局编号；编辑或重排后应重新读取。
 * 读取不执行、保存单元格或切换内核。
 */
import vscode from "vscode"
import { stringProp, numberProp } from "../util"
import { c1, copilotLikeCellId, cellTypeLabel, computeVirtualRanges } from "./format"
import { resolveNotebook, resolveNotebookCell } from "./resolve"

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
  const limit = Math.max(1, numberProp(input, "limit") ?? 400)
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
    if (input.offset !== undefined) {
      if (offset >= range.start && offset <= range.end) {
        // 全局续读行号优先，避免同一数值也可作局部偏移时跳过上一页指定的继续位置。
        globalStart = offset
      } else {
        globalStart = range.start
        warning =
          "WARNING: Offset out of bounds for the specified cell! ALWAYS use GLOBAL document line numbers (1-based). Offset reset to default."
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
  let lastRenderedLine = 0
  const outputCells: string[] = []

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
      // 首个正文行允许推进，未编号格头不能让空正文页永远重复同一 offset。
      if (bytes + outBytes > maxBytes && renderedLines > 0) {
        bytesCut = true
        break
      }
      outputCells.push(outLine)
      bytes += outBytes
      renderedLines++
      lastRenderedLine = globalLineNum
    }

    if (bytesCut || renderedLines >= limit) break
  }

  // 仅有剩余正文容量时补齐窗口终点，满额页按实际返回编号判断是否仍需续读。
  if (!bytesCut && renderedLines < limit) lastRenderedLine = Math.max(lastRenderedLine, Math.min(globalEnd, totalLines))
  const more = lastRenderedLine < globalEnd

  let output = warning ? `${warning}\n\n` : ""
  output +=
    [`<path>${notebook.uri.fsPath || notebook.uri.toString()}</path>`, `<type>notebook</type>`, "<content>"].join(
      "\n",
    ) + "\n"
  output += outputCells.join("\n")

  if (bytesCut) {
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
