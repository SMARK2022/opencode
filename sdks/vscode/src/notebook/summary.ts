/**
 * `vscode_notebook_summary` — returns notebook structure, cell metadata,
 * execution state, and output MIME types as a compact LLM-friendly summary.
 */
import * as vscode from "vscode"
import { toPosixPath, quoteForSummary } from "../util"
import { compactCell, runtimeLabel, computeVirtualRanges } from "./format"
import { resolveNotebook } from "./resolve"

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/** Bridge endpoint handler: builds a compact notebook summary for LLM consumption. */
export async function notebookSummary(filePath: string) {
  const notebook = await resolveNotebook(filePath)
  return compactNotebookResult(notebook, false)
}

// ---------------------------------------------------------------------------
// Result builders
// ---------------------------------------------------------------------------

/** Builds the dual-layer response (summary + data) for a notebook snapshot. */
export function compactNotebookResult(notebook: vscode.NotebookDocument, ran: boolean, extra?: Record<string, unknown>) {
  const cells = notebook.getCells().map(compactCell)
  return {
    ran,
    summary: notebookSummaryText(notebook, cells),
    data: {
      path: notebook.uri.fsPath || notebook.uri.toString(),
      dirty: notebook.isDirty,
      runtime: runtimeLabel(notebook),
      cells,
      ...extra,
    },
  }
}

// ---------------------------------------------------------------------------
// Summary text
// ---------------------------------------------------------------------------

function notebookSummaryText(notebook: vscode.NotebookDocument, cells: ReturnType<typeof compactCell>[]) {
  const virtualRanges = computeVirtualRanges(notebook)
  const code = cells.filter((cell) => cell.kind === "code")
  const executed = code.filter((cell) => cell.exec !== "not-run")
  const failed = code.filter((cell) => cell.exec.startsWith("fail"))
  const status = failed.length
    ? `${failed.length} failed`
    : executed.length === code.length && code.length > 0
      ? "All code cells report successful execution state (may be from a previous session)."
      : `${executed.length}/${code.length} code cells executed`

  return [
    `Notebook: ${toPosixPath(notebook.uri.fsPath || notebook.uri.toString())}`,
    `Type: ${notebook.notebookType}, dirty=${notebook.isDirty}, num_cells=${notebook.cellCount}, runtime=${runtimeLabel(notebook) ?? "unknown"}. ${status}`,
    "",
    `Conventions: cell indexes (cN) are 1-based; cell IDs (#VSC-xxxxxxxx) are stable across insert/delete; line range=[A,B] is 1-based inclusive in the virtual source document; headers and visual separators are unnumbered.`,
    "",
    'Cells (format: cN id=<#VSC-xxx> <kind>/<lang> lines=<count> range=[A,B] exec="<run state>" existing_outs="<mime list>" first="<first source line>"):',
    ...cells.map((cell) => {
      const range = virtualRanges.get(cell.i - 1)
      const rangeText = range ? `range=[${range.start},${range.end}]` : "range=?"
      return `c${cell.i} id=${cell.id} ${cell.kind}/${cell.lang} lines=${cell.lines} ${rangeText} exec=${quoteForSummary(cell.exec)} existing_outs=${quoteForSummary(cell.existing_outs.join(",") || "none")} first=${JSON.stringify(cell.first)}`
    }),
    "",
    "Next: use vscode_notebook_source with cellId=#VSC-xxx, offset=1, limit=120 for source; use vscode_notebook_run to execute; use vscode_notebook_output for outputs; use vscode_notebook_edit to modify.",
  ].join("\n")
}
