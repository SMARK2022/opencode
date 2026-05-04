// resolve 在调用方指定的文档内解释路径和格身份，不能跨文档借用活动选区。
import vscode from "vscode"
import { uriFromInput } from "../util"
import { cellIdentifiers, shortId } from "./format"

export async function resolveNotebook(filePath: string) {
  // 明确路径是所有工具的共同边界，缺失时不能借用活动文档或首个打开文档。
  if (!filePath) throw new Error("filePath is required")

  const existing = vscode.workspace.notebookDocuments.find(
    // 匹配完整 URI 或 fsPath，同 basename 的多个文档不能互相替代。
    (notebook) => notebook.uri.fsPath === filePath || notebook.uri.toString() === filePath,
  )
  // 已打开文档优先返回，保留其 dirty 源码、输出及瞬态执行摘要。
  if (existing) return existing

  // 打开前由 uriFromInput 区分 Windows 盘符与 URI scheme，避免盘符被误当协议。
  // 显式路径打开失败沿 await 传播，不能转而执行另一份活动文档。
  return await vscode.workspace.openNotebookDocument(uriFromInput(filePath))
}

// resolve 接口在调用方给定的文档内匹配 canonical ID，不能跨文档借用全局选区。
export function resolveNotebookCell(notebook: vscode.NotebookDocument, cellIndex?: number, cellId?: string) {
  if (cellId) {
    const normalized = cellId.replace(/^#/, "")
    // 仅在给定文档内以 summary 同款 canonical ID 匹配，不比较截短显示片段。
    const cells = notebook.getCells().filter((candidate) => cellIdentifiers(candidate).some((id) => shortId(id) === shortId(normalized)))
    // 多个别名命中同一格不算歧义，多个不同格命中必须拒绝。
    if (cells.length > 1) throw new Error(`Ambiguous notebook cell ID: ${cellId}`)
    if (cells.length === 1) return cells[0]
    // 显式 ID 不命中直接抛错，不能猜前缀或降级选择首格。
    throw new Error(`Notebook cell not found: ${cellId}`)
  }

  // 显式 ID 的不命中或歧义先拒绝，不能被同时传入的数字位置掩盖。
  if (cellIndex !== undefined) return notebook.cellAt(cellIndex)

  // 缺省选择只沿既有同文档选区路径，不把 cN 显示文本新增为另一种 ID。
  const active = vscode.window.activeNotebookEditor
  // 仅在缺省格参数时考虑选区，并先验证活动编辑器的完整 notebook URI。
  if (active?.notebook.uri.toString() === notebook.uri.toString()) {
    const range = active.selection
    if (range && !range.isEmpty) return notebook.cellAt(range.start)
  }

  return notebook.cellAt(0)
}

