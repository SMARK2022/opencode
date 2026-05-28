// palette 与 HTTP 路由复用处理器；此模块只收集用户参数，不拥有执行或编辑资源。
import vscode from "vscode"
import { openJsonDocument } from "../util"
import { c1, copilotLikeCellId } from "./format"
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
        description: "run one cell or a cell-id range via native notebook command",
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
        description: "info / configure / restart / save operations",
        run: async () => {
          // 环境探测也绑定已选文档，取消选择不能发布一个无目标快照。
          const notebook = await selectNotebook()
          if (!notebook) return undefined
          const operation = await vscode.window.showQuickPick(
            [
              { label: "info", description: "kernel / interpreter / saved metadata snapshot" },
              { label: "configure", description: "open notebook + trigger kernel selection" },
              { label: "restart", description: "restart Jupyter kernel, clear all runtime state" },
              { label: "save", description: "persist notebook document to disk" },
            ],
            { title: "vscode_notebook_env", placeHolder: "Select operation" },
          )
          if (!operation) return undefined
          const reason = await vscode.window.showInputBox({
            prompt: "Brief reason for this operation (optional)",
            ignoreFocusOut: true,
          })
          if (reason === undefined) return undefined
          return notebookEnv({ filePath: notebook.uri.toString(), operation: operation.label, reason: reason || undefined })
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

async function selectNotebook() {
  // 已打开文档按完整 URI 去重，同名文件不合并成同一个候选项。
  const notebooks = [
    ...new Map(vscode.workspace.notebookDocuments.map((nb) => [nb.uri.toString(), nb])).values(),
  ]
  if (notebooks.length === 0) {
    // 所有入口都要求明确文档，无候选时提示并退出，不借用缺省运行时。
    void vscode.window.showWarningMessage("No open notebook documents found.")
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
      label: `Cell ${c1(cell)}`,
      // 一基序号与 summary 一致，但仍只作显示；跨 UI 等待的定位沿捕获的 cellId。
      description: cell.kind === vscode.NotebookCellKind.Code ? "code" : "markup",
      detail: `${cell.outputs.length} outputs · ${cell.document.languageId} · ${cell.document.getText().split("\n")[0] ?? ""}`,
      cell,
      // picker 等待前捕获完整 ID，删除后的 index=-1 或插格后的新位置不能替换用户所选的身份。
      cellId: copilotLikeCellId(cell),
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
  // 单格与范围共用同一文档 URI，选择过程中切换编辑器不改目标。
  const notebook = await selectNotebook()
  if (!notebook) return undefined

  const target = await vscode.window.showQuickPick(
    [
      { label: "cell", description: "run one selected cell" },
      { label: "range", description: "run from one selected cell through another selected cell" },
    ],
    { title: "vscode_notebook_run", placeHolder: "Select run target" },
  )
  if (!target) return undefined

  if (target.label === "cell") {
    const cell = await pickNotebookCell(notebook, "vscode_notebook_run")
    return cell
      ? await runNotebook({ filePath: notebook.uri.toString(), type: "cell", cellId: cell.cellId })
      : undefined
  }

  // 两次选择沿 picker 预先捕获的 ID 提交，等待期间插格不能改变端点身份。
  const startCell = await pickNotebookCell(notebook, "vscode_notebook_run range start")
  if (!startCell) return undefined
  const endCell = await pickNotebookCell(notebook, "vscode_notebook_run range end")
  if (!endCell) return undefined
  return await runNotebook({
    filePath: notebook.uri.toString(),
    type: "range",
    cellId: startCell.cellId,
    endCellId: endCell.cellId,
  })
}

async function editNotebookCommand() {
  const notebook = await selectNotebook()
  if (!notebook) return undefined

  // 面板提交与 HTTP 相同的三元契约，不能继续生成已移除的 operation 名称。
  const editType = await vscode.window.showQuickPick(["insert", "edit", "delete"], {
    title: "vscode_notebook_edit", placeHolder: "选择编辑类型",
  })
  if (!editType) return undefined

  // cell 保留 picker 的文档对象和预先捕获的 ID，不在输入源码后重算选中身份。
  let cellId: string
  let cell: Awaited<ReturnType<typeof pickNotebookCell>>

  if (editType === "insert") {
    // 位置哨兵只属于 insert，编辑与删除仍必须经过真实格选择。
    const pos = await vscode.window.showQuickPick(["TOP", "BOTTOM", "所选格之后"], {
      title: "插入位置", placeHolder: "选择插入位置",
    })
    if (!pos) return undefined
    if (pos === "TOP") {
      cellId = "TOP"
    } else if (pos === "BOTTOM") {
      cellId = "BOTTOM"
    } else {
      // 插入锚点与后续 newCode 输入分离，焦点切换不能改成另一个文档的格。
      cell = await pickNotebookCell(notebook, "vscode_notebook_edit")
      if (!cell) return undefined
      cellId = cell.cellId
    }
  } else {
    cell = await pickNotebookCell(notebook, "vscode_notebook_edit")
    if (!cell) return undefined
    cellId = cell.cellId
  }

  // 编辑框预填实时格源码；空字符串是显式清空，不能伪装成仅修改类型。
  const newCode = editType === "delete"
    ? undefined
    : await vscode.window.showInputBox({
        title: "vscode_notebook_edit newCode",
        // 输入框的空串仍是显式清空；仅修改语言需要桥接 API 真正省略源码字段。
        prompt: "newCode 可用 \\n 表示换行；空文本清空内容，取消退出。仅修改语言请通过桥接 API 省略 oldCode/newCode。",
        value: editType === "edit" && cell ? cell.cell.document.getText().replace(/\n/g, "\\n") : "",
        ignoreFocusOut: true,
      })
  // 取消输入不进入编辑 owner，避免 undefined 意外触发纯类型变更路径。
  if (editType !== "delete" && newCode === undefined) return undefined

  return await editNotebook({
    // 交互层只收集参数，所有写入交给 editNotebook，避免再建立一个编辑 owner。
    filePath: notebook.uri.toString(),
    editType,
    cellId,
    // literal \\n 只属于手工快速输入语法，HTTP 源码字符串不经这层替换。
    newCode: newCode?.replace(/\\n/g, "\n"),
  })
}
