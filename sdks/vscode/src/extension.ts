/**
 * OpenCode VS Code Extension — entry point.
 *
 * Responsibilities:
 *   1. Start the HTTP bridge server for OpenCode CLI daemon integration.
 *   2. Register terminal management commands (open, focus, insert file reference).
 *   3. Register the interactive notebook bridge testing command.
 *
 * All notebook tool logic lives under `./notebook/`, bridge HTTP handling
 * in `./bridge.ts`, and shared utilities in `./util.ts`.
 */
import * as vscode from "vscode"
import { startBridge, closeBridge } from "./bridge"
import { registryDir } from "./bridge-registry"
import { notebookBridgeTools } from "./notebook/commands"

const TERMINAL_NAME = "opencode"

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export function deactivate() {
  return closeBridge()
}

export function activate(context: vscode.ExtensionContext) {
  const output = vscode.window.createOutputChannel("opencode")

  // Start bridge — the promise is awaited lazily when a terminal is opened
  const bridge = startBridge(output).catch((error) => {
    output.appendLine(`[bridge] failed to start: ${error instanceof Error ? error.message : String(error)}`)
    throw error
  })

  context.subscriptions.push(
    output,
    vscode.commands.registerCommand("opencode.openNewTerminal", () => openTerminal(context, bridge)),
    vscode.commands.registerCommand("opencode.openTerminal", async () => {
      const existing = vscode.window.terminals.find((t) => t.name === TERMINAL_NAME)
      if (existing) {
        existing.show()
        return
      }
      await openTerminal(context, bridge)
    }),
    vscode.commands.registerCommand("opencode.addFilepathToTerminal", async () => {
      const fileRef = getActiveFileRef()
      const terminal = vscode.window.activeTerminal
      if (!fileRef || !terminal || terminal.name !== TERMINAL_NAME) return

      // [dev-smark] File references are plain TUI input, not transport control.
      // This shortcut is intentionally restored through VS Code's terminal
      // stream only; do not couple it back to the removed random-port
      // /tui/append-prompt transport.
      terminal.sendText(fileRef, false)
      terminal.show()
    }),
    vscode.commands.registerCommand("opencode.showBridgeLog", () => output.show()),
    vscode.commands.registerCommand("opencode.notebookBridgeTools", () => notebookBridgeTools(output)),
  )
}

// ---------------------------------------------------------------------------
// Terminal management
// ---------------------------------------------------------------------------

async function openTerminal(context: vscode.ExtensionContext, bridge: Promise<unknown>) {
  await bridge
  const terminal = vscode.window.createTerminal({
    name: TERMINAL_NAME,
    iconPath: {
      light: vscode.Uri.file(context.asAbsolutePath("images/button-dark.svg")),
      dark: vscode.Uri.file(context.asAbsolutePath("images/button-light.svg")),
    },
    location: { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
    env: {
      OPENCODE_CALLER: "vscode",
      OPENCODE_IDE_REGISTRY_DIR: registryDir(),
    },
  })

  terminal.show()
  // [dev-smark] The CLI/TUI now discovers VS Code state exclusively through
  // the bridge registry written by startBridge(). Do not reintroduce a random
  // opencode --port launch or auto-prompt injection here; those create a second,
  // stale transport path that can diverge from the daemon/IDE bridge.
  terminal.sendText("opencode")
}

/**
 * Returns an `@relative/path#L1-L5` reference for the active editor,
 * or `undefined` if no suitable editor/workspace is open.
 */
function getActiveFileRef() {
  const editor = vscode.window.activeTextEditor
  if (!editor) return undefined

  const folder = vscode.workspace.getWorkspaceFolder(editor.document.uri)
  if (!folder) return undefined

  let ref = `@${vscode.workspace.asRelativePath(editor.document.uri)}`
  const sel = editor.selection
  if (!sel.isEmpty) {
    const startLine = sel.start.line + 1
    const endLine = sel.end.line + 1
    ref += startLine === endLine ? `#L${startLine}` : `#L${startLine}-${endLine}`
  }
  return ref
}
