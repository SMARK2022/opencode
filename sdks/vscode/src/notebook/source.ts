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
import { stringProp, numberProp, quoteForSummary } from "../util"
import { c1, copilotLikeCellId, cellTypeLabel, computeVirtualRanges, runtimeLabel, notebookHeader, cellRef } from "./format"
import { resolveNotebook, resolveNotebookCell } from "./resolve"

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Bridge endpoint handler: returns notebook source code with global line numbering.
 * Primary input: `cellId` (#VSC-xxxxxxxx). Output capped at 24 KB.
 */
export async function notebookSource(input: Record<string, unknown>) {
  const filePath = stringProp(input, "filePath")
  if (!filePath) throw new Error("filePath is required")
  const notebook = await resolveNotebook(filePath)
  const limit = Math.max(1, numberProp(input, "limit") ?? 400)
  const offset = Math.max(1, numberProp(input, "offset") ?? 1)

  const ranges = computeVirtualRanges(notebook)

  // A supplied cellId is a precise request, not a hint. If it is stale or bogus,
  // fail like edit/run/output instead of silently returning unrelated source.
  const cellId = stringProp(input, "cellId")
  const cell = cellId ? resolveNotebookCell(notebook, undefined, cellId) : undefined
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
        warning = "Offset is outside the target cell range; reset to the cell range start. Offsets are global virtual source line numbers."
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
  const maxBytes = 24 * 1024
  let bytes = 0
  // `limit` applies to numbered virtual source lines only; headers are context and
  // must not consume the same budget because they do not have real line numbers.
  let renderedLines = 0
  let bytesCut = false
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

    // Avoid emitting a dangling header once the source-line page is already full.
    if (renderedLines >= limit) break
    const headerLine = buildHeader(cell, cellRange)
    const hdrBytes = Buffer.byteLength(headerLine, "utf8") + 4 // "--: "
    if (bytes + hdrBytes > maxBytes && outputCells.length > 0) {
      bytesCut = true
      break
    }
    outputCells.push(headerLine)
    bytes += hdrBytes

    // Render source lines
    for (let i = 0; i < cell.document.lineCount; i++) {
      const globalLineNum = cellRange.start + i
      if (globalLineNum < globalStart) continue
      if (globalLineNum > globalEnd) {
        break
      }
      if (renderedLines >= limit) break
      const sourceLine = cell.document.lineAt(i).text
      const outLine = `${globalLineNum}: ${sourceLine}`
      const outBytes = Buffer.byteLength(outLine, "utf8")
      if (bytes + outBytes > maxBytes) {
        if (renderedLines > 0) {
          // The current line can be rendered intact on the next page. Do not
          // consume it here with a partial preview, because pagination is by
          // virtual source line rather than byte column and the skipped suffix
          // would otherwise be unrecoverable.
          bytesCut = true
          break
        }
        // A single notebook source line can be wider than the entire 24 KB tool
        // response budget. Returning only the cell header gives the agent no
        // source anchor and can produce invalid pagination such as offset=0.
        // Keep the line-number prefix and a UTF-8 bounded prefix of the source,
        // then mark the response truncated; the tool remains line-paginated, so
        // the next offset still advances to the following virtual source line.
        const prefix = `${globalLineNum}: `
        const prefixBytes = Buffer.byteLength(prefix, "utf8")
        const available = maxBytes - bytes - prefixBytes
        if (available > 0) {
          outputCells.push(prefix + takeUtf8Prefix(sourceLine, available))
          renderedLines++
          lastRenderedLine = globalLineNum
        }
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

  // Only fill to the requested end when the page still has source-line capacity;
  // otherwise `more` below must report the next page instead of hiding it.
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

  if (bytesCut) {
    output += `\n\n(Output capped at 24 KB. Showing lines ${globalStart}-${lastRenderedLine}. Use offset=${lastRenderedLine + 1} to continue.)`
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

function takeUtf8Prefix(text: string, maxBytes: number) {
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
