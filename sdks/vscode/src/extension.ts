// OpenCode VS Code 扩展入口注册终端与 palette，bridge 模块独占监听资源，notebook 模块独占工具行为。
import vscode from "vscode"
import { activateBridge, closeBridge } from "./bridge"
import { registryDir } from "./bridge-registry"
import { notebookBridgeTools } from "./notebook/commands"

const TERMINAL_NAME = "opencode"

export function deactivate() {
  // 入口把卸载委派给负责启动的 bridge 模块，模块拆分不产生第二个生命周期 owner。
  // 入口返回关闭 Promise 供宿主等待 pending startup/close 握手；此钩子不保存文档或重启用户内核。
  return closeBridge()
}

export function activate(context: vscode.ExtensionContext) {
  // 日志通道保留启动失败诊断，并交给宿主 subscriptions 管理。
  const output = vscode.window.createOutputChannel("opencode")

  // 入口调用公共 activateBridge 而不直接监听，启动屏障和早启动错误观察都留在资源 owner，用户未打开终端也不丢诊断。
  const bridge = activateBridge(output)

  context.subscriptions.push(
    // 日志通道和原终端命令归宿主 subscriptions 管理，工具模块不拥有其副本。
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
      // #171：文件引用只走终端输入流，禁止再绑 random-port /tui/append-prompt
      terminal.sendText(fileRef, false)
      terminal.show()
    }),
    vscode.commands.registerCommand("opencode.showBridgeLog", () => output.show()),
    vscode.commands.registerCommand("opencode.notebookBridgeTools", () => notebookBridgeTools(output)),
  )
}

// #171：等待 bridge 注册完成后，仅启动普通 opencode（无 --port 第二传输）
async function openTerminal(context: vscode.ExtensionContext, bridge: Promise<unknown>) {
  // 终端启动前仍等待桥接完成注册，端口和 token 改由 registry 发现。
  await bridge
  const env = {
    // #171：发现和写入共用 registry 根，不再为提示文本另开 HTTP 端口。
    OPENCODE_IDE_REGISTRY_DIR: registryDir(),
    OPENCODE_SERVER_USERNAME: process.env.OPENCODE_SERVER_USERNAME ?? "opencode",
    OPENCODE_SERVER_PASSWORD: process.env.OPENCODE_SERVER_PASSWORD ?? "",
    OPENCODE_CALLER: "vscode",
  }
  const terminal = vscode.window.createTerminal({
    name: TERMINAL_NAME,
    iconPath: {
      light: vscode.Uri.file(context.asAbsolutePath("images/button-dark.svg")),
      dark: vscode.Uri.file(context.asAbsolutePath("images/button-light.svg")),
    },
    location: { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
    env,
  })

  terminal.show()
  // #171：禁止 random port + /tui/append-prompt；文件上下文走 registry + 用户输入
  terminal.sendText("opencode")
}

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
