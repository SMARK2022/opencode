/**
 * `vscode_notebook_summary` — returns notebook structure, cell metadata,
 * execution state, and output MIME types as a compact LLM-friendly summary.
 */
import * as vscode from "vscode"
import { toPosixPath, quoteForSummary } from "../util"
import { compactCell, runtimeLabel } from "./format"
import { resolveNotebook } from "./resolve"

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/** Bridge endpoint handler: builds a compact notebook summary for LLM consumption. */
export async function notebookSummary(filePath?: string) {
  const notebook = await resolveNotebook(filePath)
  return compactNotebookResult(notebook, false)
}

// ---------------------------------------------------------------------------
// Result builders
// ---------------------------------------------------------------------------

/**
 * Builds the dual-layer response (summary + data) for a notebook snapshot.
 * Also reused by run results when a full notebook view is needed.
 */
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

/**
 * Generates the LLM-facing summary text listing all cells with their metadata.
 * Includes overall notebook stats (type, dirty, cell count, execution status).
 */
function notebookSummaryText(notebook: vscode.NotebookDocument, cells: ReturnType<typeof compactCell>[]) {
  const code = cells.filter((cell) => cell.kind === "code")
  const executed = code.filter((cell) => cell.exec !== "not-run")
  const failed = code.filter((cell) => cell.exec.startsWith("fail"))
  const status = failed.length
    ? `${failed.length} failed`
    : executed.length === code.length && code.length > 0
      ? "All code cells executed successfully."
      : `${executed.length}/${code.length} code cells executed`

  return [
    `Notebook: ${toPosixPath(notebook.uri.fsPath || notebook.uri.toString())}`,
    `Type: ${notebook.notebookType}, dirty=${notebook.isDirty}, cells=${notebook.cellCount}, runtime=${runtimeLabel(notebook) ?? "unknown"}. ${status}`,
    "",
    'Cells (format: i id=<stable short cell id> <kind>/<lang> lines=<line count> exec="<run state: current-run/saved-output/not-run, order, status, duration, end time>" existing_outs="<current saved output MIME summary>" first="<first source line>"):',
    ...cells.map(
      (cell) =>
        `${cell.i} id=${cell.id} ${cell.kind}/${cell.lang} lines=${cell.lines} exec=${quoteForSummary(cell.exec)} existing_outs=${quoteForSummary(cell.existing_outs.join(",") || "none")} first=${JSON.stringify(cell.first)}`,
    ),
    "",
    "Next: use vscode_notebook_source with cellIndex=N, offset=1, limit=120 for source; use vscode_notebook_output for outputs.",
  ].join("\n")
}
