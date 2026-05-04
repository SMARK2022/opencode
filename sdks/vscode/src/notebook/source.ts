/**
 * `vscode_notebook_source` — reads cell source code as a flat virtual text document
 * with 1-based global line numbering and offset/limit pagination.
 *
 * Virtual document format per cell:
 *   --: --- cN kind/lang id=#VSC-xxx lines=N range=[A,B] ---   (no line number)
 *   A: <source line 0>                                          (1-based global)
 *   ...
 *   B: <source line last>
 *
 * Cell headers and visual separators do NOT consume line numbers. Line ranges
 * in headers are 1-based inclusive. Target a cell with `cellId`
 * (Copilot-style #VSC-xxxxxxxx).
 */
import * as vscode from "vscode"
import { stringProp, numberProp } from "../util"
import { c1, copilotLikeCellId, cellTypeLabel, computeVirtualRanges } from "./format"
import { resolveNotebook } from "./resolve"

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Bridge endpoint handler: returns notebook source code with global line numbering.
 * Primary input: `cellId` (#VSC-xxxxxxxx). Output capped at 12 KB.
 */
export async function notebookSource(input: Record<string, unknown>) {
  const filePath = stringProp(input, "filePath")
  if (!filePath) throw new Error("filePath is required")
  const notebook = await resolveNotebook(filePath)
  const limit = Math.max(1, numberProp(input, "limit") ?? 400)
  const offset = Math.max(1, numberProp(input, "offset") ?? 1)

  const ranges = computeVirtualRanges(notebook)

  // Resolve target cell via cellId (only stable identifier; no cellIndex in schema)
  const cellId = stringProp(input, "cellId")
  const cell = cellId ? notebook.getCells().find((c) => copilotLikeCellId(c) === cellId) : undefined
  const targetCellIndex = cell?.index

  // Determine line window
  const totalLines = lastRangeEnd(ranges) ?? 0
  let globalStart = 1
  let globalEnd = totalLines
  let warning = ""

  if (targetCellIndex !== undefined && ranges.has(targetCellIndex)) {
    const range = ranges.get(targetCellIndex)!
    if (input.offset !== undefined) {
      if (offset >= range.start && offset <= range.end) {
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

  globalStart = Math.max(1, Math.min(globalStart, totalLines > 0 ? totalLines : 1))

  // Render cells one by one, emitting headers + in-range source lines
  const maxBytes = 12 * 1024
  let bytes = 0
  let rendered = 0
  let cut = false
  let lastRenderedLine = 0
  const outputCells: string[] = []

  for (const cell of notebook.getCells()) {
    const cellRange = ranges.get(cell.index)
    if (!cellRange) continue

    // Determine which source lines of this cell fall in [globalStart, globalEnd]
    const srcStart = Math.max(globalStart, cellRange.start)
    const srcEnd = Math.min(globalEnd, cellRange.end)

    if (srcStart > srcEnd) {
      continue
    }

    // Render header
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
    rendered++

    // Render source lines
    for (let i = 0; i < cell.document.lineCount; i++) {
      const globalLineNum = cellRange.start + i
      if (globalLineNum < globalStart) continue
      if (globalLineNum > globalEnd) {
        break
      }
      if (rendered >= limit) {
        cut = true
        break
      }
      const sourceLine = cell.document.lineAt(i).text
      const src = sourceLine.length > 2000
        ? sourceLine.substring(0, 2000) + "... (line truncated to 2000 chars)"
        : sourceLine
      const outLine = `${globalLineNum}: ${src}`
      const outBytes = Buffer.byteLength(outLine, "utf8")
      if (bytes + outBytes > maxBytes && outputCells.length > 0) {
        cut = true
        break
      }
      outputCells.push(outLine)
      bytes += outBytes
      rendered++
      lastRenderedLine = globalLineNum
    }

    if (cut) break
  }

  if (!cut) lastRenderedLine = Math.max(lastRenderedLine, Math.min(globalEnd, totalLines))
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
  }
  output += "\n</content>"

  return {
    ran: false,
    summary: output,
    data: {
      path: notebook.uri.fsPath || notebook.uri.toString(),
      target: targetCellIndex !== undefined ? `cell ${targetCellIndex}` : "all",
      cellId: cellId ?? (targetCellIndex !== undefined ? copilotLikeCellId(notebook.cellAt(targetCellIndex)) : undefined),
      globalStart,
      limit,
      returned: outputCells.length,
      totalLines,
      truncated: cut || more,
    },
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
