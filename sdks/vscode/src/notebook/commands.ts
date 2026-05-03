// palette 与 HTTP 路由复用处理器；此模块只收集用户参数，不拥有执行或编辑资源。
import vscode from "vscode"
import { openJsonDocument } from "../util"
import { cellKindLabel, cellIdentifiers, shortId } from "./format"
import { notebookSummary } from "./summary"
import { notebookSource } from "./source"
import { runNotebook } from "./run"
import { editNotebook } from "./edit"
import { readNotebookCellOutput } from "./output"
import { notebookEnv } from "./env"

export async function notebookBridgeTools(output: vscode.OutputChannel) {
  // palette 与 HTTP 路由导入同一组处理器，交互调试不能再维护一套执行实现。
  const picked = await vscode.window.showQuickPick(
    [
      {
        label: "vscode_notebook_summary",
        description: "structure, cells, execution, output MIME",
        run: async () => {
          const notebook = await selectNotebook()
          return notebook ? await notebookSummary(notebook.uri.toString()) : undefined
        },
      },
      {
        label: "vscode_notebook_source",
        description: "read LLM-friendly cell source code",
        run: async () => await notebookSourceCommand(),
      },
      {
        label: "vscode_notebook_run",
        description: "run one cell, range, or all via native notebook command",
        run: async () => await runNotebookCommand(),
      },
      {
        label: "vscode_notebook_edit",
        description: "insert, delete, or replace cells via NotebookEdit",
        run: async () => await editNotebookCommand(),
      },
      {
        label: "vscode_notebook_output",
        description: "artifact-first output export under .opencode/cache/notebook-outputs",
        run: async () => {
          const notebook = await selectNotebook()
          if (!notebook) return undefined
          const cell = await pickNotebookCell(notebook, "vscode_notebook_output")
          return cell ? await readNotebookCellOutput(notebook.uri.toString(), undefined, cell.cellId) : undefined
        },
      },
      {
        label: "vscode_notebook_env",
        description: "kernel/environment capability snapshot",
        run: async () => {
          const notebook = await selectNotebook(false)
          return await notebookEnv(notebook?.uri.toString())
        },
      },
    ],
    {
      title: "opencode Notebook Bridge Tools",
      placeHolder: "Select a native notebook bridge tool",
      matchOnDescription: true,
    },
  )
  if (!picked) return

  output.show(true)
  output.appendLine(`[notebook-bridge] ${picked.label}`)
  const result = await picked.run()
  if (result === undefined) return
  output.appendLine(`[notebook-bridge] result ${JSON.stringify(result, null, 2)}`)
  await openJsonDocument(result)
}

async function selectNotebook(required = true) {
  // 已打开文档按完整 URI 去重，同名文件不合并成同一个候选项。
  const notebooks = [
    ...new Map(vscode.workspace.notebookDocuments.map((nb) => [nb.uri.toString(), nb])).values(),
  ]
  if (notebooks.length === 0) {
    // required=false 用于环境快照，允许在没有 notebook 时检查扩展能力。
    if (required) void vscode.window.showWarningMessage("No open notebook documents found.")
    return undefined
  }
  // 单候选自动返回保留原交互便利，多个候选必须让用户明确选择。
  if (notebooks.length === 1) return notebooks[0]

  const picked = await vscode.window.showQuickPick(
    notebooks.map((notebook) => ({
      label: notebook.uri.fsPath || notebook.uri.toString(),
      description: notebook.notebookType,
      detail: `${notebook.cellCount} cells`,
      notebook,
    })),
    {
      title: "opencode Notebook Bridge Tools",
      placeHolder: "Select an open notebook",
      matchOnDescription: true,
      matchOnDetail: true,
    },
  )
  // 取消不借用活动文档继续操作；返回打开的文档对象以保留 dirty 源码和输出。
  return picked?.notebook
}

async function pickNotebookCell(notebook: vscode.NotebookDocument, title = "opencode Notebook Bridge Tools") {
  // 候选格来自传入文档，不从另一个活动 notebook 读取全局选区。
  const picked = await vscode.window.showQuickPick(
    notebook.getCells().map((cell) => ({
      label: `Cell ${cell.index}`,
      // 首行与语言仅供人工辨识，不作为身份或执行成功证据；零基编号随结构编辑改变。
      description: cell.kind === vscode.NotebookCellKind.Code ? "code" : "markup",
      detail: `${cell.outputs.length} outputs · ${cell.document.languageId} · ${cell.document.getText().split("\n")[0] ?? ""}`,
      cell,
      // picker 等待前捕获完整 ID，删除后的 index=-1 或插格后的新位置不能替换用户所选的身份。
      cellId: shortId(cellIdentifiers(cell)[0] ?? cell.document.uri.toString()),
    })),
    {
      title,
      placeHolder: "Select a cell",
      matchOnDescription: true,
      matchOnDetail: true,
    },
  )
  // 用户取消不会隐式选择首格，因此手工输出和执行命令可以安全退出。
  return picked
}

async function notebookSourceCommand() {
  // 选择后持有文档对象和 URI，后续 UI await 或焦点切换不能把读取转到另一份 notebook。
  const notebook = await selectNotebook()
  if (!notebook) return undefined

  const target = await vscode.window.showQuickPick(
    [
      { label: "all", description: "all cells" },
      { label: "cell", description: "one cell" },
    ],
    { title: "vscode_notebook_source target" },
  )
  if (!target) return undefined

  if (target.label === "all") {
    return await notebookSource({ filePath: notebook.uri.toString() })
  }
  if (target.label === "cell") {
    const cell = await pickNotebookCell(notebook, "vscode_notebook_source cell")
    if (!cell) return undefined
    return await notebookSource({ filePath: notebook.uri.toString(), cellId: cell.cellId })
  }
}

async function runNotebookCommand() {
  // all、range 和 cell 共用同一文档 URI，选择过程中切换编辑器不改目标。
  const notebook = await selectNotebook()
  if (!notebook) return undefined

  const target = await vscode.window.showQuickPick(
    [
      { label: "cell", description: "run one selected cell" },
      { label: "range", description: "run inclusive zero-based start/end cell range" },
      { label: "all", description: "run all cells" },
    ],
    { title: "vscode_notebook_run", placeHolder: "Select run target" },
  )
  if (!target) return undefined

  if (target.label === "all") {
    // 手工 UI 调用现有 runNotebook，不建立第二个原生执行入口。
    return await runNotebook({ filePath: notebook.uri.toString(), target: { type: "all" } })
  }
  if (target.label === "cell") {
    const cell = await pickNotebookCell(notebook, "vscode_notebook_run")
    return cell
      ? await runNotebook({ filePath: notebook.uri.toString(), target: { type: "cell", cellId: cell.cellId } })
      : undefined
  }

  const rangeText = await vscode.window.showInputBox({
    title: "vscode_notebook_run range",
    prompt: "Enter start,end zero-based indices. End is inclusive in this prompt.",
    value: "0,0",
    ignoreFocusOut: true,
  })
  // 取消文本输入直接退出，不能把缺失范围替换成当前活动选区执行。
  if (!rangeText) return undefined
  const [start, end] = rangeText.split(",").map((value) => Number(value.trim()))
  // 此提示接受零基闭区间，仅此处 end 加一；HTTP target.end 已是排他终点，仍由 notebookRange 解释。
  return await runNotebook({ filePath: notebook.uri.toString(), target: { type: "range", start, end: end + 1 } })
}

async function editNotebookCommand() {
  const notebook = await selectNotebook()
  if (!notebook) return undefined

  const operation = await vscode.window.showQuickPick(
    ["insert_before", "insert_after", "insert_top", "insert_bottom", "replace_source", "replace_cell", "delete"],
    { title: "vscode_notebook_edit", placeHolder: "Select edit operation" },
  )
  if (!operation) return undefined

  const isPositional = operation === "insert_top" || operation === "insert_bottom"
  // 顶部和底部插入不需要锚点，删除和替换必须保留已选格的定位信息。
  const cell = isPositional ? undefined : await pickNotebookCell(notebook, "vscode_notebook_edit")
  if (!isPositional && !cell) return undefined

  const source =
    operation === "delete"
      ? undefined
      : await vscode.window.showInputBox({
          title: "vscode_notebook_edit source",
          prompt: "Cell source. Use literal \\n for newlines in this quick test input.",
          value: operation === "replace_source" && cell ? cell.cell.document.getText().replace(/\n/g, "\\n") : "",
          ignoreFocusOut: true,
        })

  // delete 没有 source 参数也可执行，不能强迫用户提供将被忽略的内容。
  // undefined 表示取消，空字符串是合法清空内容，不能被当作取消。
  if (operation !== "delete" && source === undefined) return undefined

  return await editNotebook({
    // 交互层只收集参数，所有写入交给 editNotebook，避免再建立一个编辑 owner。
    filePath: notebook.uri.toString(),
    operation,
    cellId: cell?.cellId,
    // literal \\n 只属于手工快速输入语法，HTTP 源码字符串不经这层替换。
    source: source?.replace(/\\n/g, "\n"),
    // languageId 标识 VS Code 语法模式，不能用内核 display_name 或版本标签替代所选格的语言标识。
    language: cell?.cell.document.languageId,
  })
}
