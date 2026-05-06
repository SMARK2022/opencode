/**
 * `vscode_notebook_restart_kernel` — restarts the Jupyter kernel for a notebook.
 *
 * Uses the public `jupyter.restartkernel` command. Before invocation it temporarily
 * sets `jupyter.askForKernelRestart=false` to suppress the Jupyter restart
 * confirmation modal, then restores the original value afterward.
 *
 * Does not call `vscode.lm.invokeTool`, so VS Code LM Tool confirmation is
 * never triggered. Kernel restart errors are swallowed by Jupyter's public command
 * path (`.catch(noop)`), so this handler reports `requested` rather than `confirmed`.
 */
import * as vscode from "vscode"
import { resolveNotebook } from "./resolve"
import { stringProp } from "../util"

const JUPYTER_ID = "ms-toolsai.jupyter"
const RESTART_CMD = "jupyter.restartkernel"
const CONFIG_SECTION = "jupyter"
const CONFIG_KEY = "askForKernelRestart"

export async function restartNotebookKernel(input: Record<string, unknown>) {
  const filePath = stringProp(input, "filePath")
  if (!filePath) throw new Error("filePath is required")

  const notebook = await resolveNotebook(filePath)
  const reason = stringProp(input, "reason")
  const primaryPath = notebook.uri.fsPath || notebook.uri.toString()

  // Ensure the Jupyter extension is present and active
  const jupyter = vscode.extensions.getExtension(JUPYTER_ID)
  if (!jupyter) {
    return {
      ran: true,
      summary: "Jupyter extension (ms-toolsai.jupyter) is not installed. Install it and select a kernel first.",
      data: { path: primaryPath, reason, jupyterFound: false },
    }
  }
  if (!jupyter.isActive) await jupyter.activate()

  // Ensure the public restart command is registered
  const allCommands = await vscode.commands.getCommands(true)
  if (!allCommands.includes(RESTART_CMD)) {
    return {
      ran: true,
      summary: "The jupyter.restartkernel command is not registered. Check that the Jupyter extension is correctly installed.",
      data: { path: primaryPath, reason, jupyterFound: true, jupyterActive: jupyter.isActive },
    }
  }

  // Temporarily suppress Jupyter's built-in restart confirmation modal.
  // The public command internally calls `shouldAskForRestart()` which reads
  // `jupyter.askForKernelRestart`; setting it to false skips the modal.
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION)
  const original = config.get<boolean>(CONFIG_KEY)
  const needsRestore = original === true

  if (needsRestore) {
    await config.update(CONFIG_KEY, false, vscode.ConfigurationTarget.Global)
  }

  const startedAt = Date.now()
  try {
    // The public command swallows errors internally (`.catch(noop)`), so
    // this invocation will not reject on kernel-level failures.
    await vscode.commands.executeCommand(RESTART_CMD, {
      notebookEditor: { notebookUri: notebook.uri },
    })

    return {
      ran: true,
      summary: [
        "Kernel restart requested.",
        "All runtime state from previous cell executions should be cleared.",
        "Rerun setup or import cells before running dependent cells.",
        reason ? `Reason: ${reason}` : "",
      ].filter(Boolean).join("\n"),
      data: {
        path: primaryPath,
        reason,
        requested: true,
        askForKernelRestartOriginal: original,
        askForKernelRestartSuppressed: needsRestore,
        durationMs: Date.now() - startedAt,
      },
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      ran: true,
      summary: `Kernel restart invocation failed: ${message}.`,
      data: {
        path: primaryPath,
        reason,
        error: message,
        durationMs: Date.now() - startedAt,
      },
    }
  } finally {
    // Restore the user's original setting so no permanent change is left behind
    if (needsRestore) {
      await config.update(CONFIG_KEY, original, vscode.ConfigurationTarget.Global)
    }
  }
}
