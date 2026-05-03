/**
 * `vscode_notebook_edit` — insert, delete, or replace notebook cells
 * via the `vscode.WorkspaceEdit` + `vscode.NotebookEdit` API.
 *
 * Supported operations:
 *   insert_before, insert_after, insert_top, insert_bottom,
 *   replace_source (TextEdit on cell content), replace_cell, delete.
 */
import * as vscode from "vscode"
import {
  isRecord,
  stringProp,
  numberProp,
  sourceProp,
  fullDocumentRange,
  documentEol,
  previewText,
} from "../util"
import { cellKindLabel, runtimeLabel } from "./format"
import { resolveNotebook, resolveNotebookCell } from "./resolve"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const EDIT_OPERATIONS = new Set([
  "insert_before",
  "insert_after",
  "insert_top",
  "insert_bottom",
  "replace_source",
  "replace_cell",
  "delete",
])

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Bridge endpoint handler: applies a structural or content edit to a notebook.
 * Returns a delta-first summary (not a full notebook dump).
 */
export async function editNotebook(input: Record<string, unknown>) {
  const notebook = await resolveNotebook(stringProp(input, "filePath"))
  const operation = stringProp(input, "operation")

  if (!operation || !EDIT_OPERATIONS.has(operation)) {
    throw new Error(`Invalid notebook edit operation: ${operation ?? "<missing>"}`)
  }

  const beforeCount = notebook.cellCount

  // --- delete ---------------------------------------------------------------
  if (operation === "delete") {
    const cell = resolveNotebookCell(notebook, numberProp(input, "cellIndex"), stringProp(input, "cellId"))
    const edit = new vscode.WorkspaceEdit()
    edit.set(notebook.uri, [vscode.NotebookEdit.deleteCells(new vscode.NotebookRange(cell.index, cell.index + 1))])
    const applied = await vscode.workspace.applyEdit(edit)
    if (input.save === true) await notebook.save()
    return compactEditResult(notebook, {
      applied,
      operation,
      beforeCount,
      afterCount: notebook.cellCount,
      affectedCellIndex: cell.index,
    })
  }

  // --- resolve target cell (not needed for insert_top / insert_bottom) ------
  const targetCell =
    operation === "insert_top" || operation === "insert_bottom"
      ? undefined
      : resolveNotebookCell(notebook, numberProp(input, "cellIndex"), stringProp(input, "cellId"))

  const kind = cellKindFromInput(input, targetCell)
  const language = cellLanguageFromInput(input, kind, targetCell)
  const sourceRaw = sourceProp(input, "source", targetCell ? documentEol(targetCell.document) : "\n")

  if (sourceRaw === undefined) {
    throw new Error(`source is required for ${operation}`)
  }

  const source = kind === vscode.NotebookCellKind.Code ? stripCodeFence(sourceRaw) : sourceRaw

  // --- replace_source: TextEdit on existing cell content --------------------
  if (operation === "replace_source") {
    if (!targetCell) throw new Error("replace_source requires a target cell")
    const edit = new vscode.WorkspaceEdit()
    edit.replace(targetCell.document.uri, fullDocumentRange(targetCell.document), source)
    const applied = await vscode.workspace.applyEdit(edit)
    if (input.save === true) await notebook.save()
    return compactEditResult(notebook, {
      applied,
      operation,
      beforeCount,
      afterCount: notebook.cellCount,
      affectedCellIndex: targetCell.index,
      kind: cellKindLabel(targetCell.kind),
      language: targetCell.document.languageId,
      sourcePreview: source,
    })
  }

  // --- insert / replace_cell ------------------------------------------------
  const insertIndex =
    operation === "insert_top"
      ? 0
      : operation === "insert_bottom"
        ? notebook.cellCount
        : operation === "insert_after"
          ? targetCell!.index + 1
          : targetCell!.index // insert_before or replace_cell

  const range =
    operation === "replace_cell"
      ? new vscode.NotebookRange(targetCell!.index, targetCell!.index + 1)
      : new vscode.NotebookRange(insertIndex, insertIndex)

  const newCell = new vscode.NotebookCellData(kind, source, language)
  const edit = new vscode.WorkspaceEdit()
  edit.set(notebook.uri, [vscode.NotebookEdit.replaceCells(range, [newCell])])
  const applied = await vscode.workspace.applyEdit(edit)
  if (input.save === true) await notebook.save()

  return compactEditResult(notebook, {
    applied,
    operation,
    beforeCount,
    afterCount: notebook.cellCount,
    anchorCellIndex: targetCell?.index,
    affectedCellIndex: insertIndex,
    kind: cellKindLabel(kind),
    language,
    sourcePreview: source,
  })
}

// ---------------------------------------------------------------------------
// Edit result
// ---------------------------------------------------------------------------

/**
 * Builds a delta-first summary of the edit result.
 * Shows what changed (anchor cell, affected cell) rather than the full notebook state.
 */
function compactEditResult(
  notebook: vscode.NotebookDocument,
  info: {
    applied: boolean
    operation: string
    beforeCount: number
    afterCount: number
    anchorCellIndex?: number
    affectedCellIndex?: number
    kind?: string
    language?: string
    sourcePreview?: string
  },
) {
  const target =
    info.affectedCellIndex !== undefined && info.affectedCellIndex >= 0 && info.affectedCellIndex < notebook.cellCount
      ? notebook.cellAt(info.affectedCellIndex)
      : undefined

  const targetText = target
    ? `c${target.index} ${cellKindLabel(target.kind)}/${target.document.languageId} lines=${target.document.lineCount} first=${JSON.stringify(previewText((target.document.getText().split("\n")[0] ?? "").trim()).slice(0, 120))}`
    : "none"

  return {
    ran: false,
    summary: [
      `Notebook edit: applied=${info.applied} op=${info.operation} cells=${info.beforeCount}->${info.afterCount} dirty=${notebook.isDirty}.`,
      info.anchorCellIndex !== undefined ? `Anchor: c${info.anchorCellIndex}.` : undefined,
      info.affectedCellIndex !== undefined ? `Affected: c${info.affectedCellIndex}. ${targetText}` : undefined,
      info.sourcePreview ? `Preview: ${JSON.stringify(info.sourcePreview.slice(0, 160))}` : undefined,
      `Next: use vscode_notebook_source for full cell source; use vscode_notebook_summary for full notebook state.`,
    ]
      .filter(Boolean)
      .join("\n"),
    data: {
      applied: info.applied,
      operation: info.operation,
      cellCountBefore: info.beforeCount,
      cellCountAfter: info.afterCount,
      anchorCellIndex: info.anchorCellIndex,
      affectedCellIndex: info.affectedCellIndex,
      dirty: notebook.isDirty,
      kind: info.kind,
      language: info.language,
    },
  }
}

// ---------------------------------------------------------------------------
// Cell kind / language inference
// ---------------------------------------------------------------------------

/** Infers `NotebookCellKind` from explicit `kind`/`language` input or the existing cell. */
function cellKindFromInput(input: Record<string, unknown>, existing?: vscode.NotebookCell) {
  const kind = stringProp(input, "kind")
  const language = stringProp(input, "language")
  if (kind === "markdown" || language === "markdown") return vscode.NotebookCellKind.Markup
  if (kind === "code") return vscode.NotebookCellKind.Code
  return existing?.kind ?? vscode.NotebookCellKind.Code
}

/** Infers cell language from explicit input, cell kind, or the existing cell. */
function cellLanguageFromInput(
  input: Record<string, unknown>,
  kind: vscode.NotebookCellKind,
  existing?: vscode.NotebookCell,
) {
  const language = stringProp(input, "language")
  if (language) return language
  if (kind === vscode.NotebookCellKind.Markup) return "markdown"
  return existing?.document.languageId ?? "python"
}

/** Strips surrounding markdown code fences from source text if present. */
function stripCodeFence(source: string) {
  const match = source.match(/^```[\w-]*\r?\n([\s\S]*?)\r?\n```$/)
  return match ? match[1] : source
}
