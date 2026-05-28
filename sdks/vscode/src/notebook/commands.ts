/**
 * Interactive command-palette commands for testing notebook bridge tools.
 *
 * These are registered as VS Code commands and provide a quick-pick UI
 * to manually invoke each notebook endpoint for debugging/verification.
 * They are NOT called by the bridge server — only by the user via the command palette.
 */
import * as vscode from "vscode"
import { openJsonDocument } from "../util"
import { c1, copilotLikeCellId } from "./format"
import { notebookSummary } from "./summary"
import { notebookSource } from "./source"
import { runNotebook } from "./run"
import { editNotebook } from "./edit"
import { readNotebookCellOutput } from "./output"
import { notebookEnv } from "./env"

// ---------------------------------------------------------------------------
// Main command
// ---------------------------------------------------------------------------

/**
 * Shows a quick-pick menu listing all notebook bridge tools.
 * The user selects one, fills in parameters via sub-pickers, and the result
 * is logged to the output channel and opened as a JSON document.
 */
export async function notebookBridgeTools(output: vscode.OutputChannel) {
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
          return cell ? await readNotebookCellOutput(notebook.uri.toString(), cell.index) : undefined
        },
      },
      {
        label: "vscode_notebook_env",
        description: "info / configure / restart / save operations",
        run: async () => await notebookEnvCommand(),
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

// ---------------------------------------------------------------------------
// Notebook / cell pickers
// ---------------------------------------------------------------------------

/**
 * Prompts the user to select an open notebook document.
 * Returns the single open notebook without prompting if there is exactly one.
 */
async function selectNotebook(required = true) {
  const notebooks = [
    ...new Map(vscode.workspace.notebookDocuments.map((nb) => [nb.uri.toString(), nb])).values(),
  ]
  if (notebooks.length === 0) {
    if (required) void vscode.window.showWarningMessage("No open notebook documents found.")
    return undefined
  }
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
  return picked?.notebook
}

/** Prompts the user to select a cell within a notebook. */
async function pickNotebookCell(notebook: vscode.NotebookDocument, title = "opencode Notebook Bridge Tools") {
  const picked = await vscode.window.showQuickPick(
    notebook.getCells().map((cell) => ({
      label: `Cell ${c1(cell)}`,
      description: cell.kind === vscode.NotebookCellKind.Code ? "code" : "markup",
      detail: `${cell.outputs.length} outputs · ${cell.document.languageId} · ${cell.document.getText().split("\n")[0] ?? ""}`,
      cell,
    })),
    {
      title,
      placeHolder: "Select a cell",
      matchOnDescription: true,
      matchOnDetail: true,
    },
  )
  return picked?.cell
}

// ---------------------------------------------------------------------------
// Sub-command flows
// ---------------------------------------------------------------------------

async function notebookSourceCommand() {
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
    return await notebookSource({ filePath: notebook.uri.toString(), cellId: copilotLikeCellId(cell) })
  }
}

async function runNotebookCommand() {
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
      ? await runNotebook({ filePath: notebook.uri.toString(), type: "cell", cellId: copilotLikeCellId(cell) })
      : undefined
  }

  const startCell = await pickNotebookCell(notebook, "vscode_notebook_run range start")
  if (!startCell) return undefined
  const endCell = await pickNotebookCell(notebook, "vscode_notebook_run range end")
  if (!endCell) return undefined
  return await runNotebook({
    filePath: notebook.uri.toString(),
    type: "range",
    cellId: copilotLikeCellId(startCell),
    endCellId: copilotLikeCellId(endCell),
  })
}

async function editNotebookCommand() {
  const notebook = await selectNotebook()
  if (!notebook) return undefined

  const editType = await vscode.window.showQuickPick(["insert", "edit", "delete"], {
    title: "vscode_notebook_edit", placeHolder: "Select editType",
  })
  if (!editType) return undefined

  let cellId: string
  let cell: vscode.NotebookCell | undefined

  if (editType === "insert") {
    const pos = await vscode.window.showQuickPick(["TOP", "BOTTOM", "After cell..."], {
      title: "Insert position", placeHolder: "Pick insert position",
    })
    if (!pos) return undefined
    if (pos === "TOP") {
      cellId = "TOP"
    } else if (pos === "BOTTOM") {
      cellId = "BOTTOM"
    } else {
      cell = await pickNotebookCell(notebook, "vscode_notebook_edit")
      if (!cell) return undefined
      cellId = copilotLikeCellId(cell)
    }
  } else {
    cell = await pickNotebookCell(notebook, "vscode_notebook_edit")
    if (!cell) return undefined
    cellId = copilotLikeCellId(cell)
  }

  const newCode = editType === "delete"
    ? undefined
    : await vscode.window.showInputBox({
        title: "vscode_notebook_edit newCode",
        prompt: "newCode. Use \\n for newlines. Empty sends an explicit empty source; language-only edits require omitting oldCode/newCode through the bridge API.",
        value: editType === "edit" && cell ? cell.document.getText().replace(/\n/g, "\\n") : "",
        ignoreFocusOut: true,
      })

  // Keep the command-palette tester backward compatible: an empty input box
  // still sends the explicit empty string that clears a cell. The prompt points
  // language-only callers to the bridge API because that mode depends on true
  // field omission, which this simple input box cannot distinguish safely.
  return await editNotebook({
    filePath: notebook.uri.toString(),
    editType,
    cellId,
    newCode: newCode?.replace(/\\n/g, "\n"),
  })
}

async function notebookEnvCommand() {
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

  const notebook = await selectNotebook()
  if (!notebook) return undefined

  const reason = await vscode.window.showInputBox({
    prompt: "Brief reason for this operation (optional)",
    ignoreFocusOut: true,
  })

  return notebookEnv({
    filePath: notebook.uri.toString(),
    operation: operation.label,
    reason: reason || undefined,
  })
}
