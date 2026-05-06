// OpenCode VS Code 扩展入口注册终端与 palette，bridge 模块独占监听资源，notebook 模块独占工具行为。
import vscode from "vscode"
import { activateBridge, closeBridge, type BridgeInfo } from "./bridge"
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
      const env = "env" in terminal.creationOptions ? terminal.creationOptions.env : undefined
      const port = env?.["_EXTENSION_OPENCODE_PORT"]
      // 文件引用发往 CLI 的提示端口，不能误用 notebook bridge 的凭证端口作为 appendPrompt 地址。
      port ? await appendPrompt(parseInt(port), fileRef, env) : terminal.sendText(fileRef, false)
      terminal.show()
    }),
    vscode.commands.registerCommand("opencode.showBridgeLog", () => output.show()),
    vscode.commands.registerCommand("opencode.notebookBridgeTools", () => notebookBridgeTools(output)),
  )
}

async function openTerminal(context: vscode.ExtensionContext, bridge: Promise<BridgeInfo>) {
  // 终端启动前仍等待桥接完成注册，端口和 token 改由 registry 发现。
  await bridge
  const port = Math.floor(Math.random() * (65535 - 16384 + 1)) + 16384
  // CLI/TUI 自身仍保留源随机端口策略，不能与 bridge 的 listen(0) 端口合并为一个服务。
  // 凭证与终端共用同一环境快照，不能在请求时重读宿主环境而错配已启动 CLI 的认证配置。
  const env = {
    _EXTENSION_OPENCODE_PORT: port.toString(),
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
  terminal.sendText(`opencode --port ${port}`)

  const fileRef = getActiveFileRef()
  if (!fileRef) return

  let tries = 10
  let connected = false
  // CLI 的 /global/health 就绪与 notebook bridge 的端口是不同接口，探测不能转发到 bridge。
  while (tries-- > 0) {
    await new Promise((resolve) => setTimeout(resolve, 200))
    // 仅 fetch 的网络拒绝进入就绪重试，HTTP 认证错误必须在 catch 外传播。
    const response = await fetch(`http://localhost:${port}/global/health`, { headers: cliHeaders(env) }).catch(() => undefined)
    // 401/403 不会靠等待修复，立即交还命令 owner，不能反复探测同一错误凭证。
    if (response?.status === 401 || response?.status === 403) throw new Error(`CLI authentication failed: HTTP ${response.status}`)
    // fetch 收到 4xx/5xx 也会 resolve，只有 2xx 能作为监听器已就绪的证据。
    if (!response?.ok) continue
    connected = true
    break
  }
  // 未就绪显式失败，不能伪报文件引用已交付，也不能用另起 CLI 或绕过认证恢复。
  if (!connected) throw new Error("CLI listener did not become ready")
  // appendPrompt 是非幂等写入，仅执行一次；失败沿调用方传播，不能进入探测重试。
  await appendPrompt(port, `In ${fileRef}`, env)
  terminal.show()
}

async function appendPrompt(port: number, text: string, env: vscode.TerminalOptions["env"]) {
  const headers = cliHeaders(env)
  headers.set("Content-Type", "application/json")
  const response = await fetch(`http://localhost:${port}/tui/append-prompt`, {
    method: "POST",
    headers,
    body: JSON.stringify({ text }),
  })
  // 收到错误 HTTP 响应不代表 PromptAppend 已发生，必须拒绝这次调用且不能重放副作用。
  if (!response.ok) throw new Error(`Failed to append CLI prompt: HTTP ${response.status}`)
}

function cliHeaders(env: vscode.TerminalOptions["env"]) {
  const headers = new Headers()
  // 空或缺失密码保持 ServerAuth 的匿名语义；此处只构造 CLI Basic，不能借用 notebook Bearer。
  if (!env?.OPENCODE_SERVER_PASSWORD) return headers
  // 仅缺省用户名采用 opencode，显式空字符串不能被真值回退改写成另一个认证身份。
  const username = env.OPENCODE_SERVER_USERNAME ?? "opencode"
  headers.set("Authorization", `Basic ${Buffer.from(`${username}:${env.OPENCODE_SERVER_PASSWORD}`).toString("base64")}`)
  return headers
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
