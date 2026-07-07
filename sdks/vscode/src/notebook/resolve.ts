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

  // 文件不存在时 openNotebookDocument 会失败。补充 create 引导，
  // 让 agent 知道可以用 env create 创建新 notebook 而非用 write 写入原始 JSON。
  // 此错误被所有工具共用，消息不能只提某个工具的操作。
  try {
    return await vscode.workspace.openNotebookDocument(uriFromInput(filePath))
  } catch {
    throw new Error(
      `Notebook not found: ${filePath}. ` +
      `If this is a new notebook, use vscode_notebook_env with operation=create to create it. ` +
      `Otherwise, check the exact path from vscode_notebook_summary.`
    )
  }
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
    // cell ID 在 type-change（replaceCells）后失效，因为新 cell 获得新的 URI。
    // 此错误被 edit/run/source/output 共用，消息不能只提 "edit response"。
    // 建议调用 summary 获取当前 cell map，这是所有工具通用的恢复路径。
    throw new Error(`Notebook cell not found: ${cellId}. Cell IDs change after type-change edits — call vscode_notebook_summary to get the current cell map.`)
  }

  if (cellIndex !== undefined) return notebook.cellAt(cellIndex)

  const active = vscode.window.activeNotebookEditor
  if (active?.notebook.uri.toString() === notebook.uri.toString()) {
    const range = active.selection
    if (range && !range.isEmpty) return notebook.cellAt(range.start)
  }

  return notebook.cellAt(0)
}
