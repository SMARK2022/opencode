/**
 * `vscode_notebook_edit` — insert, edit, or delete notebook cells
 * via the `vscode.WorkspaceEdit` + `vscode.NotebookEdit` API.
 *
 * Three operations via `editType`:
 *   insert — new cell after cellId ("TOP"|"BOTTOM" for edges)
 *   edit   — TextEdit (oldCode/newCode string match); full cell replacement when language changes
 *   delete — remove a cell
 *
 * Required: filePath, editType, cellId.
 * language determines cell kind: "markdown" → Markup; anything else → Code.
 *
 * Edit via string matching (like opencode's edit tool):
 *   oldCode: exact string to find within the target cell
 *   newCode: replacement string
 *   Falls back through line-trimmed → boundary-trimmed matching.
 *   No line numbers — immune to index shift from parallel edits.
 */
import * as vscode from "vscode"
import {
  stringProp,
  sourceProp,
  fullDocumentRange,
  documentEol,
  previewText,
} from "../util"
import { c1, copilotLikeCellId, cellTypeLabel, computeVirtualRanges } from "./format"
import { resolveNotebook, resolveNotebookCell } from "./resolve"

const EDIT_TYPES = new Set(["insert", "edit", "delete"])
const EDIT_SYNC_TIMEOUT_MS = 10_000

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function editNotebook(input: Record<string, unknown>) {
  const filePath = stringProp(input, "filePath")
  if (!filePath) throw new Error("filePath is required")
  const notebook = await resolveNotebook(filePath)
  const editType = stringProp(input, "editType")
  if (!editType || !EDIT_TYPES.has(editType)) {
    throw new Error(
      `Invalid editType: ${editType ?? "<missing>"}. Expected one of: insert, edit, delete.`,
    )
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
  const applied = await applyNotebookEditAndWait(notebook, edit)

  let shiftedCell: vscode.NotebookCell | undefined
  let shiftedOldIdx: number | undefined
  if (hasNext) {
    shiftedOldIdx = deletedIndex + 1
    shiftedCell = notebook.cellAt(deletedIndex)
  }

  return compactEditResult(notebook, {
    applied, editType: "delete", opIndex: `~~${deletedIndex + 1}~~`, beforeCount, afterCount: notebook.cellCount,
    anchorCell: targetCell, deletedCellIndex: deletedIndex,
    deletedKind, deletedLang, deletedId, deletedLineCount, deletedFirst,
    shiftedCell, shiftedOldIdx, sourcePreview: deletedPreview,
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

  const shiftedOldIdx = insertIndex < notebook.cellCount ? insertIndex : undefined
  const newCell = new vscode.NotebookCellData(kind, source, lang)
  const edit = new vscode.WorkspaceEdit()
  edit.set(notebook.uri, [vscode.NotebookEdit.replaceCells(new vscode.NotebookRange(insertIndex, insertIndex), [newCell])])
  const applied = await applyNotebookEditAndWait(notebook, edit)
  const shiftedCell = shiftedOldIdx !== undefined ? notebook.cellAt(shiftedOldIdx + 1) : undefined
  return compactEditResult(notebook, { applied, editType: "insert", opIndex: String(insertIndex + 1), beforeCount, afterCount: notebook.cellCount, anchorCell, shiftedCell, shiftedOldIdx, kind: cellTypeLabel(kind), language: lang, sourcePreview: source })
}

// ---------------------------------------------------------------------------
// Edit
// ---------------------------------------------------------------------------

async function handleEdit(notebook: vscode.NotebookDocument, input: Record<string, unknown>, cellId: string, beforeCount: number) {
  let targetCell: vscode.NotebookCell
  try {
    targetCell = resolveNotebookCell(notebook, undefined, cellId)
  } catch (resolveErr) {
    const oldCodeRaw = sourceProp(input, "oldCode")
    if (!oldCodeRaw) throw resolveErr
    const candidates = scanNotebookCellsForOldCode(notebook, oldCodeRaw)
    if (candidates.length === 0) throw resolveErr
    const parts = candidates.map((c) =>
      `c${c1(c)} id=${copilotLikeCellId(c)} ${cellTypeLabel(c.kind)}/${c.document.languageId} first=${JSON.stringify(previewText((c.document.getText().split("\n")[0] ?? "").trim(), 50))}`
    )
    throw new Error(
      `Cell not found: ${cellId}. ` +
      (candidates.length === 1
        ? `Did you mean ${parts[0]}? Retry with this cellId.`
        : `oldCode matches ${candidates.length} cells:\n  ${parts.join("\n  ")}\nSpecify the correct cellId.`)
    )
  }
  const language = stringProp(input, "language")
  const oldCodeRaw = sourceProp(input, "oldCode")
  const typeChange = language !== undefined && language !== targetCell.document.languageId

  if (typeChange) {
    const newKind = kindFromLang(language!)
    const oldKind = cellTypeLabel(targetCell.kind)
    const oldLang = targetCell.document.languageId
    return await handleTypeChange(notebook, targetCell, input, newKind, language!, oldKind, oldLang, oldCodeRaw, beforeCount)
  }

  // --- TextEdit (no type change) ---

  // string-match edit (oldCode → newCode within cell)
  if (oldCodeRaw) {
    const sourceRaw = sourceProp(input, "newCode", documentEol(targetCell.document))
    if (sourceRaw === undefined) throw new Error("newCode is required with oldCode")
    return await handleStringEdit(notebook, targetCell, oldCodeRaw, sourceRaw, beforeCount)
  }

  // full cell replace (newCode only, no oldCode)
  const sourceRaw = sourceProp(input, "newCode", documentEol(targetCell.document))
  if (sourceRaw === undefined) throw new Error("newCode is required for edit")
  const source = targetCell.kind === vscode.NotebookCellKind.Code ? stripCodeFence(sourceRaw) : sourceRaw

  const edit = new vscode.WorkspaceEdit()
  edit.replace(targetCell.document.uri, fullDocumentRange(targetCell.document), source)
  const applied = await applyTextEditAndWait(targetCell.document, edit, source !== targetCell.document.getText())
  return compactEditResult(notebook, { applied, editType: "edit", opIndex: String(c1(targetCell)), beforeCount, afterCount: notebook.cellCount, anchorCell: targetCell, kind: cellTypeLabel(targetCell.kind), language: targetCell.document.languageId, sourcePreview: source })
}

// ---------------------------------------------------------------------------
// Type change (language changed → full cell replacement)
// ---------------------------------------------------------------------------

async function handleTypeChange(
  notebook: vscode.NotebookDocument,
  targetCell: vscode.NotebookCell,
  input: Record<string, unknown>,
  newKind: vscode.NotebookCellKind,
  newLang: string,
  oldKind: string,
  oldLang: string,
  oldCode: string | undefined,
  beforeCount: number,
) {
  let newSource: string
  let contextSummary: string | undefined

  const sourceRaw = sourceProp(input, "newCode", documentEol(targetCell.document))

  if (oldCode) {
    // string-match on old source, then create new cell with changed type
    if (sourceRaw === undefined) throw new Error("newCode is required with oldCode")
    const result = matchAndReplace(targetCell, oldCode, sourceRaw)
    newSource = result.source
    contextSummary = buildContext(notebook, targetCell, result, sourceRaw)
  } else if (sourceRaw !== undefined) {
    newSource = newKind === vscode.NotebookCellKind.Code ? stripCodeFence(sourceRaw) : sourceRaw
  } else {
    newSource = targetCell.document.getText()
  }

  const newCell = new vscode.NotebookCellData(newKind, newSource, newLang)
  newCell.metadata = targetCell.metadata ? { ...targetCell.metadata } : undefined
  const edit = new vscode.WorkspaceEdit()
  edit.set(notebook.uri, [vscode.NotebookEdit.replaceCells(new vscode.NotebookRange(targetCell.index, targetCell.index + 1), [newCell])])
  const targetIndex = targetCell.index
  const applied = await applyNotebookEditAndWait(notebook, edit)
  const updatedCell = notebook.cellAt(targetIndex)
  return compactEditResult(notebook, { applied, editType: "edit", opIndex: String(c1(updatedCell)), beforeCount, afterCount: notebook.cellCount, anchorCell: updatedCell, kind: cellTypeLabel(newKind), language: newLang, oldKind, oldLang, sourcePreview: newSource, contextSummary })
}

// ---------------------------------------------------------------------------
// String-match edit (oldCode → newCode within cell, TextEdit only)
// ---------------------------------------------------------------------------

async function handleStringEdit(notebook: vscode.NotebookDocument, targetCell: vscode.NotebookCell, oldCode: string, newCode: string, beforeCount: number) {
  const result = matchAndReplace(targetCell, oldCode, newCode)
  const contextSummary = buildContext(notebook, targetCell, result, newCode)

  const edit = new vscode.WorkspaceEdit()
  edit.replace(targetCell.document.uri, fullDocumentRange(targetCell.document), result.source)
  const applied = await applyTextEditAndWait(targetCell.document, edit, result.source !== targetCell.document.getText())
  return compactEditResult(notebook, { applied, editType: "edit", opIndex: String(c1(targetCell)), beforeCount, afterCount: notebook.cellCount, anchorCell: targetCell, kind: cellTypeLabel(targetCell.kind), language: targetCell.document.languageId, sourcePreview: newCode, contextSummary })
}

// ---------------------------------------------------------------------------
// String matching (openCode-style: exact → line-trimmed → boundary-trimmed)
// ---------------------------------------------------------------------------

function matchAndReplace(targetCell: vscode.NotebookCell, oldCode: string, newCode: string) {
  const content = targetCell.document.getText()
  const normalize = (s: string) => s.replace(/\r\n/g, "\n")
  const src = normalize(content)
  const old = normalize(oldCode)
  const rep = normalize(newCode)

  let matchIdx = -1
  let matchLen = 0
  let strategy = ""

  // 1. Exact match
  matchIdx = src.indexOf(old)
  if (matchIdx !== -1) {
    if (src.indexOf(old, matchIdx + 1) !== -1) {
      throw new Error(`oldCode matches multiple locations in cell c${c1(targetCell)}. Provide more surrounding context to make the match unique.`)
    }
    matchLen = old.length
    strategy = "exact"
  }

  // 2. Line-trimmed match
  if (matchIdx === -1) {
    const result = lineTrimmedMatch(src, old)
    if (result) {
      matchIdx = result.index
      matchLen = result.length
      strategy = "line-trimmed"
    }
  }

  // 3. Boundary-trimmed match
  if (matchIdx === -1) {
    const trimmedOld = old.trim()
    if (trimmedOld && trimmedOld !== old) {
      matchIdx = src.indexOf(trimmedOld)
      if (matchIdx !== -1) {
        if (src.indexOf(trimmedOld, matchIdx + 1) !== -1) {
          throw new Error(`oldCode matches multiple locations in cell c${c1(targetCell)}. Provide more surrounding context.`)
        }
        matchLen = trimmedOld.length
        strategy = "border-trimmed"
      }
    }
  }

  if (matchIdx === -1) {
    throw new Error(`oldCode not found in cell c${c1(targetCell)}. Try re-reading the source with vscode_notebook_source.`)
  }

  // Indent migration: for non-exact strategies, carry source block indentation to newCode
  let replacement = rep
  if (strategy !== "exact") {
    const matchedBlock = src.slice(matchIdx, matchIdx + matchLen)
    const srcIndent = baseIndent(matchedBlock)
    if (srcIndent) {
      const firstNewLine = rep.split("\n").find((l) => l.trim())
      if (firstNewLine && !firstNewLine.startsWith(srcIndent)) {
        replacement = migrateIndent(rep, srcIndent)
      }
    }
  }

  const source = content.substring(0, matchIdx) + replacement + content.substring(matchIdx + matchLen)

  // Compute 1-based (local) line range of the match for context
  const preMatch = content.substring(0, matchIdx)
  const preLines = preMatch.split(/\r?\n/)
  const matchStartLine = preLines.length
  const matchLines = oldCode.split(/\r?\n/)
  const matchEndLine = matchStartLine + matchLines.length - 1

  return { source, matchStartLine, matchEndLine, strategy }
}

function lineTrimmedMatch(src: string, old: string) {
  const oldLines = old.split("\n")
  const srcLines = src.split("\n")
  if (oldLines.length > srcLines.length) return undefined

  let found: { index: number; length: number } | undefined
  for (let i = 0; i <= srcLines.length - oldLines.length; i++) {
    let matches = true
    for (let j = 0; j < oldLines.length; j++) {
      if (srcLines[i + j].trim() !== oldLines[j].trim()) {
        matches = false
        break
      }
    }
    if (!matches) continue
    if (found) throw new Error("oldCode matches multiple locations (line-trimmed). Provide more surrounding context.")
    let start = 0
    for (let k = 0; k < i; k++) start += srcLines[k].length + 1
    let end = start
    for (let k = 0; k < oldLines.length; k++) {
      end += srcLines[i + k].length
      if (k < oldLines.length - 1) end += 1
    }
    found = { index: start, length: end - start }
  }
  return found
}

function baseIndent(text: string) {
  const lines = text.split("\n").filter((l) => l.trim())
  if (!lines.length) return ""
  const indents = lines.map((l) => l.match(/^[ \t]*/)?.[0] ?? "")
  let prefix = indents[0]
  for (const indent of indents.slice(1)) {
    let i = 0
    while (i < prefix.length && i < indent.length && prefix[i] === indent[i]) i++
    prefix = prefix.slice(0, i)
    if (!prefix) return ""
  }
  return prefix
}

function migrateIndent(newCode: string, targetIndent: string) {
  const lines = newCode.split("\n")
  const srcBase = baseIndent(newCode)
  return lines
    .map((line) => {
      if (!line.trim()) return line
      if (srcBase && line.startsWith(srcBase)) return targetIndent + line.slice(srcBase.length)
      return targetIndent + line.trimStart()
    })
    .join("\n")
}

// ---------------------------------------------------------------------------
// Context builder (surrounding lines for summary)
// ---------------------------------------------------------------------------

function buildContext(notebook: vscode.NotebookDocument, targetCell: vscode.NotebookCell, result: { matchStartLine: number; matchEndLine: number; strategy: string }, newCode: string) {
  const cellLines = targetCell.document.getText().split(/\r?\n/)
  const vr = computeVirtualRanges(notebook)
  const globalOffset = (vr.get(targetCell.index)?.start ?? 1) - 1
  const gStart = result.matchStartLine + globalOffset
  const gEnd = result.matchEndLine + globalOffset

  const ctxLines: string[] = []

  // Above line
  if (result.matchStartLine > 1) {
    ctxLines.push(`${gStart - 1}: ${cellLines[result.matchStartLine - 2]}`)
  } else {
    ctxLines.push(`--: <cell_top> --- c${c1(targetCell)} ${cellTypeLabel(targetCell.kind)}/${targetCell.document.languageId}`)
  }

  // Match indicator
  const label = gStart === gEnd ? `${gStart}` : `${gStart}~${gEnd}`
  ctxLines.push(`${label} (${result.strategy}): ${previewText(newCode, 50)}`)

  // Below line
  if (result.matchEndLine < cellLines.length) {
    ctxLines.push(`${gEnd + 1}: ${cellLines[result.matchEndLine]}`)
  } else {
    ctxLines.push(`--: <cell_end>`)
  }

  return ctxLines.join("\n")
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function kindFromLang(language?: string) {
  return language === "markdown" ? vscode.NotebookCellKind.Markup : vscode.NotebookCellKind.Code
}

function stripCodeFence(source: string) {
  const match = source.match(/^```[\w-]*\r?\n([\s\S]*?)\r?\n```$/)
  return match ? match[1] : source
}

async function applyNotebookEditAndWait(notebook: vscode.NotebookDocument, edit: vscode.WorkspaceEdit) {
  const beforeVersion = notebook.version
  const applied = await vscode.workspace.applyEdit(edit)
  if (!applied) throw new Error("VS Code notebook edit was not applied")
  await waitForNotebookVersionChange(notebook, beforeVersion, EDIT_SYNC_TIMEOUT_MS)
  return applied
}

async function applyTextEditAndWait(document: vscode.TextDocument, edit: vscode.WorkspaceEdit, expectContentChange: boolean) {
  const beforeVersion = document.version
  const applied = await vscode.workspace.applyEdit(edit)
  if (!applied) throw new Error("VS Code text edit was not applied")
  if (expectContentChange) await waitForTextDocumentVersionChange(document, beforeVersion, EDIT_SYNC_TIMEOUT_MS)
  return applied
}

async function waitForNotebookVersionChange(notebook: vscode.NotebookDocument, beforeVersion: number, timeoutMs: number) {
  if (notebook.version !== beforeVersion) return
  await new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const subscription = vscode.workspace.onDidChangeNotebookDocument((event) => {
      if (event.notebook.uri.toString() !== notebook.uri.toString()) return
      if (event.notebook.version === beforeVersion) return
      finish()
    })
    const finish = (error?: Error) => {
      if (timer) clearTimeout(timer)
      subscription.dispose()
      error ? reject(error) : resolve()
    }
    timer = setTimeout(() => finish(new Error("Timed out waiting for VS Code notebook edit events to finish")), timeoutMs)
  })
}

async function waitForTextDocumentVersionChange(document: vscode.TextDocument, beforeVersion: number, timeoutMs: number) {
  if (document.version !== beforeVersion) return
  await new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const subscription = vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.document.uri.toString() !== document.uri.toString()) return
      if (event.document.version === beforeVersion) return
      finish()
    })
    const finish = (error?: Error) => {
      if (timer) clearTimeout(timer)
      subscription.dispose()
      error ? reject(error) : resolve()
    }
    timer = setTimeout(() => finish(new Error("Timed out waiting for VS Code cell text edit events to finish")), timeoutMs)
  })
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
    if (info.oldKind) {
      lines.push(`NOTE: Type change replaced the cell. Use id=${anchorId} for subsequent operations on this cell.`)
    }
  }

  // --- Affected ---
  if ((info.editType === "delete" || info.editType === "insert") && info.shiftedCell) {
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
      editType: info.editType,
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

function scanNotebookCellsForOldCode(notebook: vscode.NotebookDocument, oldCode: string) {
  const normalize = (s: string) => s.replace(/\r\n/g, "\n")
  const old = normalize(oldCode)
  return notebook.getCells().filter((c) => normalize(c.document.getText()).includes(old))
}
