/**
 * `vscode_notebook_env` — returns a capability snapshot of the notebook runtime,
 * including kernel info, Python/Jupyter extension states, and available commands.
 */
import * as vscode from "vscode"
import { extensionState, extensionInfo } from "../util"
import { runtimeLabel } from "./format"
import { resolveNotebook } from "./resolve"

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Bridge endpoint handler: returns kernel/environment information.
 * Falls back gracefully when no notebook is open.
 */
export async function notebookEnv(filePath?: string) {
  const notebook = await resolveNotebook(filePath).catch(() => undefined)
  const commands = await vscode.commands.getCommands(true)
  const names = [
    "notebook.cell.execute",
    "notebook.execute",
    "notebook.selectKernel",
    "notebook.kernel.restart",
    "jupyter.selectKernel",
    "jupyter.restartkernel",
    "python.setInterpreter",
  ]
  return {
    ran: false,
    summary: `Notebook runtime: ${notebook ? (runtimeLabel(notebook) ?? "unknown") : "unknown"}; Python/Jupyter extensions: ${extensionState("ms-python.python")}/${extensionState("ms-toolsai.jupyter")}.`,
    data: {
      path: notebook?.uri.fsPath || notebook?.uri.toString(),
      runtime: notebook ? runtimeLabel(notebook) : null,
      active_notebook: vscode.window.activeNotebookEditor?.notebook.uri.toString(),
      extensions: {
        python: extensionInfo("ms-python.python"),
        jupyter: extensionInfo("ms-toolsai.jupyter"),
      },
      commands: Object.fromEntries(names.map((name) => [name, commands.includes(name)])),
    },
    note: "Native public VS Code API does not expose full Jupyter kernel/package details; bridge can fallback to extension commands/tools when needed.",
  }
}
