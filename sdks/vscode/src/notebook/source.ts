/**
 * `vscode_notebook_source` — reads cell source code as a flat virtual text document
 * with 1-based global line numbering and offset/limit pagination.
 *
 * The virtual document format uses `--- cN kind/lang id=... lines=... ---` separators
 * between cells so that line numbers are stable across the entire notebook.
 */
import * as vscode from "vscode"
import { stringProp, numberProp } from "../util"
import { shortId, cellIdentifiers, cellKindLabel } from "./format"
import { resolveNotebook } from "./resolve"

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Bridge endpoint handler: returns notebook source code with global line numbering.
 * Supports `cellIndex` to focus on one cell, and `offset`/`limit` for pagination.
 * Output is capped at 12 KB and 1000 lines per request.
 */
export async function notebookSource(input: Record<string, unknown>) {
  const notebook = await resolveNotebook(stringProp(input, "filePath"))
  const limit = Math.max(1, Math.min(numberProp(input, "limit") ?? 1000, 1000))
  const offset = Math.max(1, numberProp(input, "offset") ?? 1)

  const { lines, cellRanges } = buildVirtualLines(notebook)
  const targetCellIndex = typeof input.cellIndex === "number" ? input.cellIndex : undefined

  let globalStart = 1
  let globalEnd = lines.length
  let warning = ""

  // When a specific cell is targeted, constrain the window to that cell's range
  if (targetCellIndex !== undefined && cellRanges.has(targetCellIndex)) {
    const range = cellRanges.get(targetCellIndex)!
    if (input.offset !== undefined) {
      if (offset >= range.start && offset <= range.end) {
        globalStart = offset
      } else if (range.start + offset - 1 >= range.start && range.start + offset - 1 <= range.end) {
        globalStart = range.start + offset - 1
      } else {
        globalStart = range.start
        warning =
          "WARNING: Offset out of bounds for the specified cell! ALWAYS use GLOBAL document line numbers. Offset reset to default."
      }
    } else {
      globalStart = range.start
    }
    globalEnd = range.end
  } else {
    if (input.offset !== undefined) {
      globalStart = offset
    }
  }

  globalStart = Math.max(1, Math.min(globalStart, lines.length > 0 ? lines.length : 1))

  // Stream lines until the byte budget (12 KB) or line limit is reached
  const maxBytes = 12 * 1024
  let bytes = 0
  let cut = false
  const returnedLines: string[] = []
  let currentLineIndex = globalStart - 1

  while (currentLineIndex < globalEnd && currentLineIndex < lines.length && returnedLines.length < limit) {
    const line = lines[currentLineIndex]
    const lineBytes = Buffer.byteLength(line, "utf8")
    if (bytes + lineBytes > maxBytes && returnedLines.length > 0) {
      cut = true
      break
    }
    returnedLines.push(`${currentLineIndex + 1}: ${line}`)
    bytes += lineBytes
    currentLineIndex++
  }

  const more = currentLineIndex < globalEnd && currentLineIndex < lines.length

  // Assemble output in the same format as the opencode `read` tool
  let output = warning ? `${warning}\n\n` : ""
  output +=
    [`<path>${notebook.uri.fsPath || notebook.uri.toString()}</path>`, `<type>notebook</type>`, "<content>"].join(
      "\n",
    ) + "\n"
  output += returnedLines.join("\n")

  if (cut) {
    output += `\n\n(Output capped at 12 KB. Showing lines ${globalStart}-${currentLineIndex}. Use offset=${currentLineIndex + 1} to continue.)`
  } else if (more) {
    output += `\n\n(Showing lines ${globalStart}-${currentLineIndex} of ${lines.length}. Use offset=${currentLineIndex + 1} to continue.)`
  } else {
    if (targetCellIndex !== undefined) {
      output += `\n\n(End of cell ${targetCellIndex})`
    } else {
      output += `\n\n(End of file - total ${lines.length} lines)`
    }
  }
  output += "\n</content>"

  return {
    ran: false,
    summary: output,
    data: {
      path: notebook.uri.fsPath || notebook.uri.toString(),
      target: targetCellIndex !== undefined ? `cell ${targetCellIndex}` : "all",
      offset: globalStart,
      limit,
      returned: returnedLines.length,
      totalLines: lines.length,
      truncated: cut || more,
    },
  }
}

// ---------------------------------------------------------------------------
// Virtual line builder
// ---------------------------------------------------------------------------

/**
 * Flattens all notebook cells into a single array of text lines with
 * `--- cN kind/lang id=... ---` separator headers. Returns a map from
 * cell index to its 1-based global line range for offset targeting.
 */
function buildVirtualLines(notebook: vscode.NotebookDocument) {
  const lines: string[] = []
  const cellRanges = new Map<number, { start: number; end: number }>()

  for (const cell of notebook.getCells()) {
    const start = lines.length + 1
    const id = shortId(cellIdentifiers(cell)[0] ?? `cell-${cell.index}`)
    lines.push(
      `--- c${cell.index} ${cellKindLabel(cell.kind)}/${cell.document.languageId} id=${id} lines=${cell.document.lineCount} ---`,
    )
    const sourceLines = cell.document
      .getText()
      .split(/\r?\n/)
      .map((line) => (line.length > 2000 ? line.substring(0, 2000) + "... (line truncated to 2000 chars)" : line))
    lines.push(...sourceLines)
    lines.push("")
    const end = lines.length
    cellRanges.set(cell.index, { start, end })
  }

  return { lines, cellRanges }
}
