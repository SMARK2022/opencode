/**
 * Notebook and cell resolution — locating open notebooks and cells by path, index, or ID.
 */
import * as vscode from "vscode"
import { uriFromInput } from "../util"
import { cellIdentifiers, normalizeCellId } from "./format"

// ---------------------------------------------------------------------------
// Notebook resolution
// ---------------------------------------------------------------------------

/** Resolves a notebook document from an explicit file path or URI string. */
export async function resolveNotebook(filePath: string) {
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
 * Resolves a single cell inside a notebook by cell ID (primary) or index (fallback).
 * Falls back to the active editor's selection / cell 0.
 */
export function resolveNotebookCell(notebook: vscode.NotebookDocument, cellIndex?: number, cellId?: string) {
  if (cellId) {
    const normalized = normalizeCellId(cellId)
    const stripped = normalized.replace(/^#/, "")
    const cell = notebook
      .getCells()
      .find((candidate) => cellIdentifiers(candidate).some((id) => id.replace(/^#/, "") === stripped))
    if (cell) return cell
    throw new Error(`Notebook cell not found: ${cellId}. The edit response contains updated cell IDs after type changes.`)
  }

  if (cellIndex !== undefined) return notebook.cellAt(cellIndex)

  const active = vscode.window.activeNotebookEditor
  if (active?.notebook.uri.toString() === notebook.uri.toString()) {
    const range = active.selection
    if (range && !range.isEmpty) return notebook.cellAt(range.start)
  }

  return notebook.cellAt(0)
}
