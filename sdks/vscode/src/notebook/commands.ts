/**
 * Interactive command-palette commands for testing notebook bridge tools.
 *
 * These are registered as VS Code commands and provide a quick-pick UI
 * to manually invoke each notebook endpoint for debugging/verification.
 * They are NOT called by the bridge server — only by the user via the command palette.
 */
import * as vscode from "vscode"
import { openJsonDocument } from "../util"
import { cellKindLabel } from "./format"
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
          return cell ? await readNotebookCellOutput(notebook.uri.toString(), cell.index) : undefined
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
      label: `Cell ${cell.index}`,
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
    return await notebookSource({ filePath: notebook.uri.toString(), cellIndex: cell.index })
  }
}

async function runNotebookCommand() {
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
    return await runNotebook({ filePath: notebook.uri.toString(), target: { type: "all" } })
  }
  if (target.label === "cell") {
    const cell = await pickNotebookCell(notebook, "vscode_notebook_run")
    return cell
      ? await runNotebook({ filePath: notebook.uri.toString(), target: { type: "cell", cellIndex: cell.index } })
      : undefined
  }

  const rangeText = await vscode.window.showInputBox({
    title: "vscode_notebook_run range",
    prompt: "Enter start,end zero-based indices. End is inclusive in this prompt.",
    value: "0,0",
    ignoreFocusOut: true,
  })
  if (!rangeText) return undefined
  const [start, end] = rangeText.split(",").map((value) => Number(value.trim()))
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
  const cell = isPositional ? undefined : await pickNotebookCell(notebook, "vscode_notebook_edit")
  if (!isPositional && !cell) return undefined

  const source =
    operation === "delete"
      ? undefined
      : await vscode.window.showInputBox({
          title: "vscode_notebook_edit source",
          prompt: "Cell source. Use literal \\n for newlines in this quick test input.",
          value: operation === "replace_source" && cell ? cell.document.getText().replace(/\n/g, "\\n") : "",
          ignoreFocusOut: true,
        })

  if (operation !== "delete" && source === undefined) return undefined

  return await editNotebook({
    filePath: notebook.uri.toString(),
    operation,
    cellIndex: cell?.index,
    source: source?.replace(/\\n/g, "\n"),
    language: cell?.document.languageId,
  })
}
