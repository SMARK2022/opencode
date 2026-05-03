// resolve 在调用方指定的文档内解释路径、格身份和范围，不能跨文档借用活动选区。
import vscode from "vscode"
import { stringProp, numberProp, uriFromInput } from "../util"
import { cellIdentifiers, shortId } from "./format"

export async function resolveNotebook(filePath?: string) {
  // filePath 可选属于 69 的源行为，不能提前套用后续工具的强制路径规则。
  if (!filePath) {
    const active = vscode.window.activeNotebookEditor?.notebook
    if (active) return active
    if (vscode.workspace.notebookDocuments.length > 0) return vscode.workspace.notebookDocuments[0]
    throw new Error("No active or open notebook document")
  }

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
  // cellAt 保留 VS Code 的边界检查，index 只表示当前位置，不是稳定身份。
  if (cellIndex !== undefined) return notebook.cellAt(cellIndex)

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

  const active = vscode.window.activeNotebookEditor
  // 仅在缺省格参数时考虑选区，并先验证活动编辑器的完整 notebook URI。
  if (active?.notebook.uri.toString() === notebook.uri.toString()) {
    const range = active.selection
    if (range && !range.isEmpty) return notebook.cellAt(range.start)
  }

  return notebook.cellAt(0)
}

export function notebookRange(notebook: vscode.NotebookDocument, target: Record<string, unknown>, fallbackCellIndex?: number) {
  // 只有未提供 type 才默认单格；显式 null、非字符串和拼错的类型必须保留给拒绝分支。
  const type = target.type === undefined ? "cell" : target.type
  // all 的终点取总 cellCount 而非代码格数量，Markup 也占原生索引；用代码格数量会截掉后面的代码格。
  if (type === "all") return new vscode.NotebookRange(0, notebook.cellCount)
  if (type === "range") {
    const start = Math.max(0, numberProp(target, "start") ?? 0)
    const end = Math.min(notebook.cellCount, numberProp(target, "end") ?? start + 1)
    // target.end 是排他终点；至少一格的源钳制与手工闭区间转换分开。
    return new vscode.NotebookRange(start, Math.max(start + 1, end))
  }
  // 未知目标不能降级执行首格；先拒绝再计算 cell 索引，避免认证输入的拼写错误触发错误代码。
  if (type !== "cell") throw new Error(`Invalid notebook target type: ${String(type)}`)
  const cellId = stringProp(target, "cellId")
  // 文档 await 后先按选中 ID 定位，失效 ID 必须由 resolver 抛错，不能进入数字钳制而执行首格。
  const index = cellId
    ? resolveNotebookCell(notebook, undefined, cellId).index
    // 只有数字定位仍按 target.cellIndex、顶层 fallback、零的源顺序钳制，不因 UI 竞态改变 HTTP 数字契约。
    : Math.max(0, Math.min(notebook.cellCount - 1, numberProp(target, "cellIndex") ?? fallbackCellIndex ?? 0))
  return new vscode.NotebookRange(index, index + 1)
}
