// summary 只读取结构化状态与实时文档，不根据显示文本推断执行成功。
import vscode from "vscode"
import { toPosixPath, quoteForSummary } from "../util"
import { compactCell, runtimeLabel } from "./format"
import { resolveNotebook } from "./resolve"

export async function notebookSummary(filePath?: string) {
  // summary 投影 format 提供的结构化状态，不能把显示字符串当跨模块的状态 API。
  const notebook = await resolveNotebook(filePath)
  // 读取打开文档的实时内容，不用磁盘版本覆盖用户尚未保存的编辑。
  // ran=false 保持只读性质，已有输出不改变本次操作，不能隐式执行或保存文档。
  return compactNotebookResult(notebook, false)
}

export function compactNotebookResult(notebook: vscode.NotebookDocument, ran: boolean, extra?: Record<string, unknown>) {
  const cells = notebook.getCells().map(compactCell)
  return {
    ran,
    summary: notebookSummaryText(notebook, cells),
    data: {
      // dirty 与 runtime 元数据随同一文档返回，不能采用别的活动编辑器状态。
      path: notebook.uri.fsPath || notebook.uri.toString(),
      dirty: notebook.isDirty,
      runtime: runtimeLabel(notebook),
      cells,
      ...extra,
    },
  }
}

function notebookSummaryText(notebook: vscode.NotebookDocument, cells: ReturnType<typeof compactCell>[]) {
  // 总计只统计 code 格，markdown 格不需要原生代码执行摘要。
  const code = cells.filter((cell) => cell.kind === "code")
  // 有输出但 success 未知的格不计入已执行数量，保存结果不冒充本次执行。
  const executed = code.filter((cell) => cell.execution.status !== "unknown")
  const failed = code.filter((cell) => cell.execution.status === "failed")
  // status 读取结构化 success 派生值，不依赖 exec 文案的前缀或词序。
  const status = failed.length
    // 先报告失败数，防止所有格都有输出时把失败格归入全成功分支。
    ? `${failed.length} failed`
    // 没有代码格时保留零比零统计，不能用空数组 every 的真值宣称全部执行成功。
    : executed.length === code.length && code.length > 0
      ? "All code cells executed successfully."
      : `${executed.length}/${code.length} code cells executed`

  return [
    `Notebook: ${toPosixPath(notebook.uri.fsPath || notebook.uri.toString())}`,
    `Type: ${notebook.notebookType}, dirty=${notebook.isDirty}, cells=${notebook.cellCount}, runtime=${runtimeLabel(notebook) ?? "unknown"}. ${status}`,
    "",
    'Cells (format: i id=<canonical stable cell id> <kind>/<lang> lines=<line count> exec="<provenance: unknown/saved, order, status, duration, end time>" existing_outs="<output MIME summary>" first="<first source line>"):',
    ...cells.map(
      // first 是有预算的预览，完整源码应通过 source 读取，不能反解摘要。
      (cell) =>
        `${cell.i} id=${cell.id} ${cell.kind}/${cell.lang} lines=${cell.lines} exec=${quoteForSummary(cell.exec)} existing_outs=${quoteForSummary(cell.existing_outs.join(",") || "none")} first=${JSON.stringify(cell.first)}`,
    ),
    "",
    "Next: use vscode_notebook_source with cellIndex=N, offset=1, limit=120 for source; use vscode_notebook_output for outputs.",
  ].join("\n")
}
