/**
 * Notebook and cell resolution — locating open notebooks and cells by path, index, or ID.
 */
import * as vscode from "vscode"
import { stringProp, numberProp, uriFromInput } from "../util"
import { cellIdentifiers } from "./format"

// ---------------------------------------------------------------------------
// Notebook resolution
// ---------------------------------------------------------------------------

/**
 * Resolves a notebook document from a file path, URI string, or falls back
 * to the active/first-open notebook. Throws if nothing can be found.
 */
export async function resolveNotebook(filePath?: string) {
  if (!filePath) {
    const active = vscode.window.activeNotebookEditor?.notebook
    if (active) return active
    if (vscode.workspace.notebookDocuments.length > 0) return vscode.workspace.notebookDocuments[0]
    throw new Error("No active or open notebook document")
  }

  const existing = vscode.workspace.notebookDocuments.find(
    (notebook) => notebook.uri.fsPath === filePath || notebook.uri.toString() === filePath,
  )
  if (existing) return existing

  return await vscode.workspace.openNotebookDocument(uriFromInput(filePath))
}

// ---------------------------------------------------------------------------
// Cell resolution
// ---------------------------------------------------------------------------

/**
 * Resolves a single cell inside a notebook by index, cell ID, or falls back
 * to the active editor's selection / cell 0.
 */
export function resolveNotebookCell(notebook: vscode.NotebookDocument, cellIndex?: number, cellId?: string) {
  if (cellIndex !== undefined) return notebook.cellAt(cellIndex)

  if (cellId) {
    const normalized = cellId.replace(/^#/, "")
    const cell = notebook
      .getCells()
      .find((candidate) => cellIdentifiers(candidate).some((id) => id.replace(/^#/, "") === normalized))
    if (cell) return cell
    throw new Error(`Notebook cell not found: ${cellId}`)
  }

  const active = vscode.window.activeNotebookEditor
  if (active?.notebook.uri.toString() === notebook.uri.toString()) {
    const range = active.selection
    if (range && !range.isEmpty) return notebook.cellAt(range.start)
  }

  return notebook.cellAt(0)
}

// ---------------------------------------------------------------------------
// Range construction
// ---------------------------------------------------------------------------

/**
 * Converts a target descriptor (`{ type: "all"|"range"|"cell", ... }`) into
 * a `vscode.NotebookRange`. Used by `runNotebook` to select which cells to execute.
 */
export function notebookRange(notebook: vscode.NotebookDocument, target: Record<string, unknown>, fallbackCellIndex?: number) {
  const type = stringProp(target, "type") ?? "cell"
  if (type === "all") return new vscode.NotebookRange(0, notebook.cellCount)
  if (type === "range") {
    const start = Math.max(0, numberProp(target, "start") ?? 0)
    const end = Math.min(notebook.cellCount, numberProp(target, "end") ?? start + 1)
    return new vscode.NotebookRange(start, Math.max(start + 1, end))
  }
  const index = Math.max(0, Math.min(notebook.cellCount - 1, numberProp(target, "cellIndex") ?? fallbackCellIndex ?? 0))
  return new vscode.NotebookRange(index, index + 1)
}
