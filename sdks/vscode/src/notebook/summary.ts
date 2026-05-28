// summary 只读取结构化状态与实时文档，不根据显示文本推断执行成功。
import vscode from "vscode"
import { quoteForSummary } from "../util"
import { compactCell, runtimeLabel, computeVirtualRanges, notebookHeader } from "./format"
import { resolveNotebook } from "./resolve"

export async function notebookSummary(filePath: string) {
  // summary 投影 format 提供的结构化状态，不能把显示字符串当跨模块的状态 API。
  const notebook = await resolveNotebook(filePath)
  // 读取打开文档的实时内容，不用磁盘版本覆盖用户尚未保存的编辑。
  // ran=false 保持只读性质，已有输出不改变本次操作，不能隐式执行或保存文档。
  return compactNotebookResult(notebook, false)
}

/** 返回笔记本快照的 summary/data 双层响应。 */
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
  // 范围与格快照在同一同步读取中投影，不根据摘要文本反推可编辑行号。
  const virtualRanges = computeVirtualRanges(notebook)
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
      ? "All code cells report successful execution state (may be from a previous session)."
      : `${executed.length}/${code.length} code cells executed`

  return [
    ...notebookHeader(notebook, "Summary", [
      `type=${notebook.notebookType}`,
      `dirty=${notebook.isDirty}`,
      `cells=${notebook.cellCount}`,
      `runtime=${quoteForSummary(runtimeLabel(notebook) ?? "unknown")}`,
      `status=${quoteForSummary(status)}`,
    ]),
    "",
    `Fields: cN is 1-based display position; id is the stable #VSC handle; range=[A,B] uses global virtual source lines.`,
    "",
    'Cells (format: cN id=<#VSC-xxx> <kind>/<lang> lines=<count> range=[A,B] exec="<run state>" existing_outs="<mime list>" first="<first source line>"):',
    ...cells.map((cell) => {
      // compactCell.i 已是一基显示值，查 Map 时必须还原为内部零基索引。
      const range = virtualRanges.get(cell.i - 1)
      const rangeText = range ? `range=[${range.start},${range.end}]` : "range=?"
      return `c${cell.i} id=${cell.id} ${cell.kind}/${cell.lang} lines=${cell.lines} ${rangeText} exec=${quoteForSummary(cell.exec)} existing_outs=${quoteForSummary(cell.existing_outs.join(",") || "none")} first=${JSON.stringify(cell.first)}`
    }),
    "",
    // 单格 offset 仍是全局虚拟行号，省略默认值可避免后续格错误地从全局第一行读取。
    "后续：单格源码用 vscode_notebook_source 的 cellId=#VSC-xxx 并省略 offset；全局分页才使用 offset/limit。用 vscode_notebook_run 执行、vscode_notebook_output 读取输出、vscode_notebook_edit 修改。",
  ].join("\n")
}
