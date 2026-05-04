/**
 * `vscode_notebook_edit` — insert, edit, or delete notebook cells
 * via the `vscode.WorkspaceEdit` + `vscode.NotebookEdit` API.
 *
 * Three operations via `editType`:
 *   insert – new cell after cellId ("TOP"|"BOTTOM" for edges; default "TOP" if empty)
 *   edit   – TextEdit when language unchanged; full cell replacement when language changes
 *   delete – remove a cell
 *
 * Required: filePath, editType, cellId.
 * newCode required for insert and for edit (unless pure type-change).
 * language determines cell kind: "markdown" → Markup; anything else → Code.
 *
 * Edit summary conventions:
 *   Anchor  – target cell; type-change shows old→new; delete shows ~~strikethrough~~
 *   Affected – insert: NEW->cN; delete: c(old)→c(new) shifted cell
 *   Context  – only with range edits, showing surrounding lines
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
import { c1, copilotLikeCellId, cellTypeLabel, computeVirtualRanges } from "./format"
import { resolveNotebook, resolveNotebookCell } from "./resolve"

const EDIT_TYPES = new Set(["insert", "edit", "delete"])

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function editNotebook(input: Record<string, unknown>) {
  const filePath = stringProp(input, "filePath")
  if (!filePath) throw new Error("filePath is required")
  const notebook = await resolveNotebook(filePath)
  const editType = stringProp(input, "editType")
  if (!editType || !EDIT_TYPES.has(editType)) {
    throw new Error(`Invalid editType: ${editType ?? "<missing>"}. Must be one of: insert, edit, delete`)
  }

  const cellId = stringProp(input, "cellId")
  if (!cellId) throw new Error("cellId is required")

  const beforeCount = notebook.cellCount

  if (editType === "delete") return await handleDelete(notebook, cellId, beforeCount)
  if (editType === "insert") return await handleInsert(notebook, input, cellId, beforeCount)
  return await handleEdit(notebook, input, cellId, beforeCount)
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

async function handleDelete(notebook: vscode.NotebookDocument, cellId: string, beforeCount: number) {
  const targetCell = resolveNotebookCell(notebook, undefined, cellId)
  const deletedIndex = targetCell.index
  const deletedPreview = targetCell.document.getText()
  const deletedLineCount = targetCell.document.lineCount
  const deletedFirst = previewText((targetCell.document.getText().split("\n")[0] ?? "").trim(), 50)
  const deletedKind = cellTypeLabel(targetCell.kind)
  const deletedLang = targetCell.document.languageId
  const deletedId = copilotLikeCellId(targetCell)
  const hasNext = deletedIndex < notebook.cellCount - 1

  const edit = new vscode.WorkspaceEdit()
  edit.set(notebook.uri, [vscode.NotebookEdit.deleteCells(new vscode.NotebookRange(deletedIndex, deletedIndex + 1))])
  const applied = await vscode.workspace.applyEdit(edit)

  // Capture the cell that shifted into the deleted cell's place (if any)
  let shiftedOldIdx: number | undefined
  let shiftedCell: vscode.NotebookCell | undefined
  if (hasNext) {
    shiftedOldIdx = deletedIndex + 1
    shiftedCell = notebook.cellAt(deletedIndex)
  }

  return compactEditResult(notebook, {
    applied,
    editType: "delete",
    opIndex: `~~${deletedIndex + 1}~~`,
    beforeCount,
    afterCount: notebook.cellCount,
    anchorCell: targetCell,
    deletedCellIndex: deletedIndex,
    deletedKind,
    deletedLang,
    deletedId,
    deletedLineCount,
    deletedFirst,
    shiftedCell,
    shiftedOldIdx,
    sourcePreview: deletedPreview,
  })
}

// ---------------------------------------------------------------------------
// Insert
// ---------------------------------------------------------------------------

async function handleInsert(notebook: vscode.NotebookDocument, input: Record<string, unknown>, cellId: string, beforeCount: number) {
  const sourceRaw = sourceProp(input, "newCode", "\n")
  if (sourceRaw === undefined) throw new Error("newCode is required for insert")

  const language = stringProp(input, "language")
  const kind = kindFromLang(language)
  const lang = language ?? (kind === vscode.NotebookCellKind.Markup ? "markdown" : "python")
  const source = kind === vscode.NotebookCellKind.Code ? stripCodeFence(sourceRaw) : sourceRaw

  const upperCellId = cellId.toUpperCase()
  let insertIndex: number
  let anchorCell: vscode.NotebookCell | undefined

  if (upperCellId === "TOP" || (upperCellId === "BOTTOM" && notebook.cellCount === 0)) {
    insertIndex = 0
  } else if (upperCellId === "BOTTOM") {
    insertIndex = notebook.cellCount
  } else {
    anchorCell = resolveNotebookCell(notebook, undefined, cellId)
    insertIndex = anchorCell.index + 1
  }

  const newCell = new vscode.NotebookCellData(kind, source, lang)
  const shiftedOldIdx = insertIndex < notebook.cellCount ? insertIndex : undefined
  const edit = new vscode.WorkspaceEdit()
  edit.set(notebook.uri, [vscode.NotebookEdit.replaceCells(new vscode.NotebookRange(insertIndex, insertIndex), [newCell])])
  const applied = await vscode.workspace.applyEdit(edit)
  const shiftedCell = shiftedOldIdx !== undefined ? notebook.cellAt(shiftedOldIdx + 1) : undefined
  return compactEditResult(notebook, { applied, editType: "insert", opIndex: String(insertIndex + 1), beforeCount, afterCount: notebook.cellCount, anchorCell, shiftedCell, shiftedOldIdx, kind: cellTypeLabel(kind), language: lang, sourcePreview: source })
}

// ---------------------------------------------------------------------------
// Edit
// ---------------------------------------------------------------------------

async function handleEdit(notebook: vscode.NotebookDocument, input: Record<string, unknown>, cellId: string, beforeCount: number) {
  const targetCell = resolveNotebookCell(notebook, undefined, cellId)
  const language = stringProp(input, "language")
  const range = readLineRange(input)
  const typeChange = language !== undefined && language !== targetCell.document.languageId

  if (typeChange) {
    const newKind = kindFromLang(language!)
    const oldKind = cellTypeLabel(targetCell.kind)
    const oldLang = targetCell.document.languageId
    return await handleTypeChange(notebook, targetCell, input, range, newKind, language!, oldKind, oldLang, beforeCount)
  }

  // language unchanged → TextEdit only
  if (range) {
    return await handleTextEditSource(notebook, targetCell, input, range, beforeCount)
  }

  const sourceRaw = sourceProp(input, "newCode", documentEol(targetCell.document))
  if (sourceRaw === undefined) throw new Error("newCode is required for edit")
  const source = targetCell.kind === vscode.NotebookCellKind.Code ? stripCodeFence(sourceRaw) : sourceRaw

  const edit = new vscode.WorkspaceEdit()
  edit.replace(targetCell.document.uri, fullDocumentRange(targetCell.document), source)
  const applied = await vscode.workspace.applyEdit(edit)
  return compactEditResult(notebook, { applied, editType: "edit", opIndex: String(c1(targetCell)), beforeCount, afterCount: notebook.cellCount, anchorCell: targetCell, kind: cellTypeLabel(targetCell.kind), language: targetCell.document.languageId, sourcePreview: source })
}

// ---------------------------------------------------------------------------
// Type change (language changed → full cell replacement)
// ---------------------------------------------------------------------------

async function handleTypeChange(
  notebook: vscode.NotebookDocument,
  targetCell: vscode.NotebookCell,
  input: Record<string, unknown>,
  range: { start: number; end: number } | undefined,
  newKind: vscode.NotebookCellKind,
  newLang: string,
  oldKind: string,
  oldLang: string,
  beforeCount: number,
) {
  let newSource: string
  let contextSummary: string | undefined

  if (range) {
    const result = applyRangeEdit(notebook, targetCell, range, sourceProp(input, "newCode", documentEol(targetCell.document)))
    if (!result) throw new Error("newCode is required for edit with range")
    newSource = result.source
    contextSummary = result.context
  } else {
    const sourceRaw = sourceProp(input, "newCode", documentEol(targetCell.document))
    if (sourceRaw !== undefined) {
      newSource = newKind === vscode.NotebookCellKind.Code ? stripCodeFence(sourceRaw) : sourceRaw
    } else {
      newSource = targetCell.document.getText()
    }
  }

  const newCell = new vscode.NotebookCellData(newKind, newSource, newLang)
  const edit = new vscode.WorkspaceEdit()
  edit.set(notebook.uri, [vscode.NotebookEdit.replaceCells(new vscode.NotebookRange(targetCell.index, targetCell.index + 1), [newCell])])
  const applied = await vscode.workspace.applyEdit(edit)
  return compactEditResult(notebook, { applied, editType: "edit", opIndex: String(c1(targetCell)), beforeCount, afterCount: notebook.cellCount, anchorCell: targetCell, kind: cellTypeLabel(newKind), language: newLang, oldKind, oldLang, sourcePreview: newSource, contextSummary })
}

// ---------------------------------------------------------------------------
// TextEdit — line range (no type change)
// ---------------------------------------------------------------------------

async function handleTextEditSource(notebook: vscode.NotebookDocument, targetCell: vscode.NotebookCell, input: Record<string, unknown>, range: { start: number; end: number }, beforeCount: number) {
  const result = applyRangeEdit(notebook, targetCell, range, sourceProp(input, "newCode", documentEol(targetCell.document)))
  if (!result) throw new Error("newCode is required for edit with range")

  const edit = new vscode.WorkspaceEdit()
  edit.replace(targetCell.document.uri, fullDocumentRange(targetCell.document), result.source)
  const applied = await vscode.workspace.applyEdit(edit)
  return compactEditResult(notebook, { applied, editType: "edit", opIndex: String(c1(targetCell)), beforeCount, afterCount: notebook.cellCount, anchorCell: targetCell, kind: cellTypeLabel(targetCell.kind), language: targetCell.document.languageId, sourcePreview: result.source, contextSummary: result.context })
}

// ---------------------------------------------------------------------------
// Shared: apply a line range to a cell's source + capture context
// ---------------------------------------------------------------------------

function applyRangeEdit(notebook: vscode.NotebookDocument, targetCell: vscode.NotebookCell, range: { start: number; end: number }, newCode: string | undefined) {
  if (newCode === undefined) return undefined

  const vr = computeVirtualRanges(notebook)
  const cellRange = vr.get(targetCell.index)
  if (!cellRange) throw new Error(`Cell c${c1(targetCell)} has no virtual range`)

  const globalStart = Math.max(cellRange.start, range.start)
  const globalEnd = Math.min(cellRange.end, range.end)
  if (globalStart > globalEnd) {
    throw new Error(`Global range [${range.start},${range.end}] out of bounds for cell c${c1(targetCell)}`)
  }

  const localStart = globalStart - cellRange.start + 1
  const localEnd = globalEnd - cellRange.start + 1
  const cellLines = targetCell.document.getText().split(/\r?\n/)

  const aboveIdx = localStart - 2
  const belowIdx = localEnd
  const aboveLine = aboveIdx >= 0 ? cellLines[aboveIdx] : undefined
  const belowLine = belowIdx < cellLines.length ? cellLines[belowIdx] : undefined

  const ctxLines: string[] = []
  if (aboveLine !== undefined) {
    ctxLines.push(`${globalStart - 1}: ${aboveLine}`)
  } else {
    ctxLines.push(`--: <cell_top> --- c${c1(targetCell)} ${cellTypeLabel(targetCell.kind)}/${targetCell.document.languageId}`)
  }
  const modifiedLabel = globalStart === globalEnd ? `${globalStart}` : `${globalStart}~${globalEnd}`
  ctxLines.push(`${modifiedLabel}: ${previewText(newCode, 50)}`)
  if (belowLine !== undefined) {
    ctxLines.push(`${globalEnd + 1}: ${belowLine}`)
  } else {
    ctxLines.push(`--: <cell_end>`)
  }

  const eol = documentEol(targetCell.document)
  const source = [...cellLines.slice(0, localStart - 1), newCode, ...cellLines.slice(localEnd)].join(eol)
  return { source, context: ctxLines.join("\n") }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function kindFromLang(language?: string) {
  return language === "markdown" ? vscode.NotebookCellKind.Markup : vscode.NotebookCellKind.Code
}

function readLineRange(input: Record<string, unknown>) {
  const range = input.range
  if (!isRecord(range)) return undefined
  const start = numberProp(range, "start")
  const end = numberProp(range, "end")
  if (start === undefined || end === undefined) return undefined
  return { start, end }
}

function stripCodeFence(source: string) {
  const match = source.match(/^```[\w-]*\r?\n([\s\S]*?)\r?\n```$/)
  return match ? match[1] : source
}

// ---------------------------------------------------------------------------
// Edit result
// ---------------------------------------------------------------------------

function compactEditResult(
  notebook: vscode.NotebookDocument,
  info: {
    applied: boolean
    editType: string
    opIndex: string
    beforeCount: number
    afterCount: number
    anchorCell?: vscode.NotebookCell
    deletedCellIndex?: number
    affectedCellIndex?: number
    kind?: string
    language?: string
    oldKind?: string
    oldLang?: string
    deletedKind?: string
    deletedLang?: string
    deletedId?: string
    deletedLineCount?: number
    deletedFirst?: string
    shiftedCell?: vscode.NotebookCell
    shiftedOldIdx?: number
    sourcePreview?: string
    contextSummary?: string
  },
) {
  const lines: Array<string | undefined> = [
    `Notebook edit: applied=${info.applied} op=${info.editType} at=${info.opIndex} num_cells=${info.beforeCount}->${info.afterCount} dirty=${notebook.isDirty}.`,
  ]

  // --- Anchor ---
  if (info.editType === "delete" && info.deletedId) {
    // Deleted cell: strikethrough with full metadata
    const dIdx = (info.deletedCellIndex ?? 0) + 1
    lines.push(`Anchor: ~~c${dIdx} id=${info.deletedId} ${info.deletedKind}/${info.deletedLang} lines=${info.deletedLineCount} first=${JSON.stringify(info.deletedFirst)}~~`)
  } else if (info.anchorCell) {
    const displayIdx = info.deletedCellIndex !== undefined ? info.deletedCellIndex + 1 : c1(info.anchorCell)
    const anchorId = copilotLikeCellId(info.anchorCell)
    const typePart = info.oldKind
      ? `${info.oldKind}/${info.oldLang}->${info.kind}/${info.language}`
      : `${cellTypeLabel(info.anchorCell.kind)}/${info.anchorCell.document.languageId}`
    lines.push(`Anchor: c${displayIdx} id=${anchorId} ${typePart}.`)
  }

  // --- Affected ---
  if (info.editType === "delete" && info.shiftedCell) {
    const oldIdx = (info.shiftedOldIdx ?? 0) + 1
    const newIdx = c1(info.shiftedCell)
    lines.push(`Affected: c${oldIdx}->c${newIdx} id=${copilotLikeCellId(info.shiftedCell)} ${cellTypeLabel(info.shiftedCell.kind)}/${info.shiftedCell.document.languageId} lines=${info.shiftedCell.document.lineCount} first=${JSON.stringify(previewText((info.shiftedCell.document.getText().split("\n")[0] ?? "").trim(), 50))}`)
  } else if (info.editType === "insert" && info.shiftedCell) {
    const oldIdx = (info.shiftedOldIdx ?? 0) + 1
    const newIdx = c1(info.shiftedCell)
    lines.push(`Affected: c${oldIdx}->c${newIdx} id=${copilotLikeCellId(info.shiftedCell)} ${cellTypeLabel(info.shiftedCell.kind)}/${info.shiftedCell.document.languageId} lines=${info.shiftedCell.document.lineCount} first=${JSON.stringify(previewText((info.shiftedCell.document.getText().split("\n")[0] ?? "").trim(), 50))}`)
  }

  if (info.contextSummary) {
    lines.push(`Context:\n${info.contextSummary}`)
  }
  if (info.sourcePreview) {
    lines.push(`Preview: ${JSON.stringify(previewText(info.sourcePreview, 50))}`)
  }

  return {
    ran: false,
    summary: lines.join("\n"),
    data: {
      applied: info.applied,
      operation: info.editType,
      cellCountBefore: info.beforeCount,
      cellCountAfter: info.afterCount,
      anchorCellIndex: info.anchorCell?.index,
      affectedCellIndex: info.affectedCellIndex,
      dirty: notebook.isDirty,
      kind: info.kind,
      language: info.language,
    },
  }
}
