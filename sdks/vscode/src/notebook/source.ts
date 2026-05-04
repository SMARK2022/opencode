/**
 * vscode_notebook_source 返回一基全局虚拟源码，身份解析仍归 resolve。
 * 每格使用未编号头部 --: --- cN kind/lang id=#VSC-xxx lines=N range=[A,B] ---。
 * A..B 为该格的源码闭区间，B+1 为空分隔行；格头不消耗全局编号。
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
 * limit 默认 400，源码长行仍在 2000 字符处标为预览；未编号格头不占正文行预算。
 * 12 KiB UTF-8 渲染预算包含格头和行号文本，不覆盖 XML 封装与续读提示；首个正文行可超预算以保证推进。
 * 返回 ran=false、实际 globalStart、returned、totalLines 与续读提示，不承诺未截短原文。
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

  const maxBytes = 12 * 1024
  let bytes = 0
  let rendered = 0
  let cut = false
  let globalLineNum = 0
  let lastRenderedLine = 0
  const outputCells: string[] = []

  for (const cell of notebook.getCells()) {
    const cellRange = ranges.get(cell.index)
    if (!cellRange) continue

    // 当前格正文与全局窗口取交集，页外格既不打印头部也不占正文预算。
    const srcStart = Math.max(globalStart, cellRange.start)
    const srcEnd = Math.min(globalEnd, cellRange.end)

    if (srcStart > srcEnd) {
      globalLineNum = cellRange.end
      continue
    }

    // 每格从共享 start 重新对齐，跳过前格时不能漏算其空分隔行而让编号偏移一行。
    globalLineNum = cellRange.start - 1
    if (rendered >= limit) {
      cut = true
      break
    }
    const headerLine = buildHeader(cell, cellRange)
    const hdrBytes = Buffer.byteLength(headerLine, "utf8") + 4 // "--: "
    if (bytes + hdrBytes > maxBytes && outputCells.length > 0) {
      cut = true
      break
    }
    outputCells.push(headerLine)
    bytes += hdrBytes

    // 格头计入字节但不占编号正文预算，limit=1 也必须能读取并推进一行源码。
    const sourceLines = cell.document.getText().split(/\r?\n/)
    for (let i = 0; i < sourceLines.length; i++) {
      globalLineNum++
      if (globalLineNum < globalStart) continue
      if (globalLineNum > globalEnd) {
        // 单格窗口的终点不重算局部编号，下一格仍由共享范围起点对齐。
        globalLineNum = cellRange.end
        break
      }
      if (rendered >= limit) {
        cut = true
        break
      }
      // 长行预览明确带截短标记，不能让调用方把 2000 字符当成完整源行。
      const src = sourceLines[i].length > 2000
        ? sourceLines[i].substring(0, 2000) + "... (line truncated to 2000 chars)"
        : sourceLines[i]
      const outLine = `${globalLineNum}: ${src}`
      // UTF-8 预算包括真实行号前缀，多字节正文不能用字符数冒充输出字节。
      const outBytes = Buffer.byteLength(outLine, "utf8")
      // 首个正文行允许推进，未编号格头不能让空正文页永远重复同一 offset。
      if (bytes + outBytes > maxBytes && rendered > 0) {
        cut = true
        break
      }
      outputCells.push(outLine)
      bytes += outBytes
      rendered++
      lastRenderedLine = globalLineNum
    }

    if (cut) break

    // 空分隔行占全局编号，预算足够时才输出，不能加入前格的可编辑 range。
    globalLineNum++
    if (globalLineNum >= globalStart && globalLineNum <= globalEnd) {
      if (rendered < limit) {
        const blankLine = `${globalLineNum}: `
        const blBytes = Buffer.byteLength(blankLine, "utf8")
        if (bytes + blBytes <= maxBytes) {
          outputCells.push(blankLine)
          bytes += blBytes
          rendered++
          lastRenderedLine = globalLineNum
        }
      }
    }
  }

  // 字节或行数截断时只从最后实际输出的正文编号续读，不能跳过尚未返回的源码。
  if (!cut) lastRenderedLine = Math.min(globalEnd, globalLineNum)
  const more = lastRenderedLine < globalEnd

  let output = warning ? `${warning}\n\n` : ""
  output +=
    [`<path>${notebook.uri.fsPath || notebook.uri.toString()}</path>`, `<type>notebook</type>`, "<content>"].join(
      "\n",
    ) + "\n"
  output += outputCells.join("\n")

  if (cut) {
    output += `\n\n(Output capped at 12 KB. Showing lines ${globalStart}-${lastRenderedLine}. Use offset=${lastRenderedLine + 1} to continue.)`
  } else if (more) {
    output += `\n\n(Showing lines ${globalStart}-${lastRenderedLine} of ${totalLines}. Use offset=${lastRenderedLine + 1} to continue.)`
  } else {
    output += `\n\n(End of file - total ${totalLines} lines)`
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
      returned: outputCells.length,
      totalLines,
      truncated: cut || more,
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
