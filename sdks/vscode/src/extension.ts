/**
 * opencode VS Code Extension — entry point.
 *
 * Responsibilities:
 *   1. Start the HTTP bridge server for opencode CLI daemon integration.
 *   2. Register terminal management commands (open, focus, file-mention).
 *   3. Register the interactive notebook bridge testing command.
 *
 * All notebook tool logic lives under `./notebook/`, bridge HTTP handling
 * in `./bridge.ts`, and shared utilities in `./util.ts`.
 */
import * as vscode from "vscode"
import { startBridge, closeBridge, type BridgeInfo } from "./bridge"
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
      // @ts-ignore — creationOptions.env is not in the public type
      const port = terminal.creationOptions.env?.["_EXTENSION_OPENCODE_PORT"]
      port ? await appendPrompt(parseInt(port), fileRef) : terminal.sendText(fileRef, false)
      terminal.show()
    }),
    vscode.commands.registerCommand("opencode.showBridgeLog", () => output.show()),
    vscode.commands.registerCommand("opencode.notebookBridgeTools", () => notebookBridgeTools(output)),
  )
}

// ---------------------------------------------------------------------------
// Terminal management
// ---------------------------------------------------------------------------

async function openTerminal(context: vscode.ExtensionContext, bridge: Promise<BridgeInfo>) {
  const bridgeInfo = await bridge
  const port = Math.floor(Math.random() * (65535 - 16384 + 1)) + 16384
  const terminal = vscode.window.createTerminal({
    name: TERMINAL_NAME,
    iconPath: {
      light: vscode.Uri.file(context.asAbsolutePath("images/button-dark.svg")),
      dark: vscode.Uri.file(context.asAbsolutePath("images/button-light.svg")),
    },
    location: { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
    env: {
      _EXTENSION_OPENCODE_PORT: port.toString(),
      OPENCODE_CALLER: "vscode",
    },
  })

  terminal.show()
  terminal.sendText(`opencode --port ${port}`)

  const fileRef = getActiveFileRef()
  if (!fileRef) return

  // Wait for the opencode TUI to be ready before appending the prompt
  let tries = 10
  while (tries-- > 0) {
    await new Promise((resolve) => setTimeout(resolve, 200))
    try {
      await fetch(`http://localhost:${port}/app`)
      await appendPrompt(port, `In ${fileRef}`)
      terminal.show()
      return
    } catch {
      // not ready yet
    }
  }
}

async function appendPrompt(port: number, text: string) {
  await fetch(`http://localhost:${port}/tui/append-prompt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  })
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
