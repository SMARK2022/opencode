import * as vscode from "vscode"
import http from "node:http"
import { randomUUID } from "node:crypto"
import path from "node:path"

const TERMINAL_NAME = "opencode"
const BRIDGE_HOST = "127.0.0.1"
// 桥接服务仅绑定本机回环地址，杜绝网络暴露风险

let bridgeServer: http.Server | undefined
// 句柄必须覆盖尚未发布端口的启动期，卸载不能只靠已发布的 BridgeInfo 找到待关闭服务器。
let bridgeOutput: vscode.OutputChannel | undefined
// 启动失败可能早于终端打开，日志引用须独立于终端寿命并在关闭握手后释放。
let bridgeLifetime: Promise<void> | undefined
let bridgeClosing = true
// 屏障覆盖尚未分配端口的启动；关闭意图不能由迟到的 listen 回调重新开放。

type BridgeInfo = {
// 端口只能定位 listener，token 才是实例凭证；两者未齐备时不能发布可用的桥接身份。
  port: number
  token: string
}

export async function deactivate() {
  // 重复卸载共享同一个关闭屏障，不能在第一个 close 回调前清空 owner 并重新激活。
  if (bridgeClosing) return bridgeLifetime
  bridgeClosing = true
  const startup = bridgeLifetime
  bridgeLifetime = (async () => {
    // 先等启动成功、失败或取消结算，避免在 pending listen 上误判 listening=false。
    await startup
    const server = bridgeServer
    try {
      // Node 的关闭完成发生在回调；未监听的启动失败实例不需要调用 close 制造第二个错误。
      if (server?.listening) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    } finally {
      // 关闭意图保持有效，先完成资源握手再释放日志和引用，取消路径也不能发布 token。
      bridgeServer = undefined
      bridgeOutput?.dispose()
      bridgeOutput = undefined
      bridgeLifetime = undefined
    }
  })()
  return bridgeLifetime
}

export function activate(context: vscode.ExtensionContext) {
  // 未完成关闭的 owner 不允许叠加服务器；标志只在实际 activate 中复位。
  if (bridgeLifetime) throw new Error("VS Code bridge activation is already owned")
  bridgeClosing = false
  const output = vscode.window.createOutputChannel("opencode")
  // 日志通道保留启动失败诊断，由 bridgeOutput 持有至关闭握手完成。
  bridgeOutput = output
  // 激活只创建一份 bridge Promise；多个打开终端请求共享其端口和凭证。
  const bridge = startBridge(output)
  // 资源屏障只等待启动结算；终端仍持有原 Promise，启动失败不会被转成成功凭证。
  bridgeLifetime = bridge.then(() => undefined, () => undefined)
  // 激活不等待 notebook 或内核；显式观察早启动的拒绝，用户未打开终端也不会遗留 rejection。
  void bridge.catch((error) => {
    // 卸载取消不向已经退出的日志上下文写入；正常启动失败仍保留原诊断。
    if (!bridgeClosing) output.appendLine(`[bridge] failed to start: ${error instanceof Error ? error.message : String(error)}`)
  })

  const openNewTerminalDisposable = vscode.commands.registerCommand("opencode.openNewTerminal", async () => {
    await openTerminal()
  })

  const openTerminalDisposable = vscode.commands.registerCommand("opencode.openTerminal", async () => {
    // An opencode terminal already exists => focus it
    const existingTerminal = vscode.window.terminals.find((t) => t.name === TERMINAL_NAME)
    if (existingTerminal) {
      existingTerminal.show()
      return
    }

    await openTerminal()
  })

  const addFilepathDisposable = vscode.commands.registerCommand("opencode.addFilepathToTerminal", async () => {
    const fileRef = getActiveFile()
    if (!fileRef) {
      return
    }

    const terminal = vscode.window.activeTerminal
    if (!terminal) {
      return
    }

    if (terminal.name === TERMINAL_NAME) {
      const env = "env" in terminal.creationOptions ? terminal.creationOptions.env : undefined
      const port = env?.["_EXTENSION_OPENCODE_PORT"]
      port ? await appendPrompt(parseInt(port), fileRef, env) : terminal.sendText(fileRef, false)
      terminal.show()
    }
  })

  const showBridgeLogDisposable = vscode.commands.registerCommand("opencode.showBridgeLog", () => {
    output.show()
  })

  const runVscodeToolDisposable = vscode.commands.registerCommand("opencode.runVscodeTool", async () => {
    await runVscodeTool(output)
  })

  const notebookBridgeToolsDisposable = vscode.commands.registerCommand("opencode.notebookBridgeTools", async () => {
    await notebookBridgeTools(output)
  })

  context.subscriptions.push(
  // 命令回调和输出通道共同归宿主 subscriptions，避免重新激活后旧入口仍可被调用。
    output,
    openNewTerminalDisposable,
    openTerminalDisposable,
    addFilepathDisposable,
    showBridgeLogDisposable,
    runVscodeToolDisposable,
    notebookBridgeToolsDisposable,
  )

  async function openTerminal() {
    // Create a new terminal in split screen
    const bridgeInfo = await bridge
    // 等待桥接启动完成以获取端口和 token，确保环境变量可用；终端不能在未知桥接地址下开始工作。
    const port = Math.floor(Math.random() * (65535 - 16384 + 1)) + 16384
    // 凭证与终端共用同一环境快照，不能在请求时重读宿主环境而错配已启动 CLI 的认证配置。
    const env = {
      _EXTENSION_OPENCODE_PORT: port.toString(),
      OPENCODE_SERVER_USERNAME: process.env.OPENCODE_SERVER_USERNAME ?? "opencode",
      OPENCODE_SERVER_PASSWORD: process.env.OPENCODE_SERVER_PASSWORD ?? "",
      OPENCODE_VSCODE_BRIDGE_PORT: bridgeInfo.port.toString(),
      // 桥接端口由 listen(0) 实际分配，不能从另一个 CLI/TUI 端口推算，必须显式传输。
      OPENCODE_VSCODE_BRIDGE_TOKEN: bridgeInfo.token,
      // 本机端口可被其他进程发现，子进程仍须携带本次实例 token，不能用固定凭证替代。
      OPENCODE_CALLER: "vscode",
    }
    const terminal = vscode.window.createTerminal({
      name: TERMINAL_NAME,
      iconPath: {
        light: vscode.Uri.file(context.asAbsolutePath("images/button-dark.svg")),
        dark: vscode.Uri.file(context.asAbsolutePath("images/button-light.svg")),
      },
      location: {
        viewColumn: vscode.ViewColumn.Beside,
        preserveFocus: false,
      },
      env,
    })

    terminal.show()
    terminal.sendText(`opencode --port ${port}`)

    const fileRef = getActiveFile()
    if (!fileRef) {
      return
    }

    // Wait for the terminal to be ready
    let tries = 10
    let connected = false
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

    if (!connected) throw new Error("CLI listener did not become ready")
    // 非幂等追加留在只读探测循环之外，失败直接传播，不重试或另起 CLI。
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

  function getActiveFile() {
    const activeEditor = vscode.window.activeTextEditor
    if (!activeEditor) {
      return
    }

    const document = activeEditor.document
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri)
    if (!workspaceFolder) {
      return
    }

    // Get the relative path from workspace root
    const relativePath = vscode.workspace.asRelativePath(document.uri)
    let filepathWithAt = `@${relativePath}`

    // Check if there's a selection and add line numbers
    const selection = activeEditor.selection
    if (!selection.isEmpty) {
      // Convert to 1-based line numbers
      const startLine = selection.start.line + 1
      const endLine = selection.end.line + 1

      if (startLine === endLine) {
        // Single line selection
        filepathWithAt += `#L${startLine}`
      } else {
        // Multi-line selection
        filepathWithAt += `#L${startLine}-${endLine}`
      }
    }

    return filepathWithAt
  }
}

async function startBridge(output: vscode.OutputChannel): Promise<BridgeInfo> {
  // 工厂不复位关闭意图；关闭后的重启必须经过实际激活入口。
  if (bridgeClosing) throw new Error("VS Code bridge startup cancelled")
  // token 属于本次服务器实例，不能跨扩展重启复用为永久凭证。
  const token = randomUUID()

  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", `http://${BRIDGE_HOST}`)
      // URL 解析也可能抛错，必须由同一个请求边界结束响应，不能留下未观察的拒绝。
      output.appendLine(`[bridge] ${request.method} ${url.pathname}`)

      if (request.method === "GET" && url.pathname === "/health") {
        // 健康响应只证明桥接进程存活，不能证明某个 notebook 内核就绪。
        writeJson(response, 200, {
          ok: true,
          service: "opencode-vscode-bridge",
          tools: vscode.lm.tools.length,
        })
        return
      }

      if (!authorized(request, url, token)) {
        // 先鉴权再读取工具或 notebook 参数，未授权请求不能触发编辑器操作。
        writeJson(response, 401, { ok: false, error: "Unauthorized" })
        return
      }

      if (request.method === "GET" && url.pathname === "/tools/list") {
        // 工具清单同样受前置鉴权保护，不能因其只读就泄露扩展能力。
        const tools = vscode.lm.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
          tags: tool.tags,
        }))
        output.appendLine(`[bridge] listed ${tools.length} VS Code language model tools`)
        writeJson(response, 200, { ok: true, tools })
        return
      }

      if (request.method === "POST" && url.pathname === "/tools/invoke") {
        const body = await readJson(request)
        if (!isRecord(body) || typeof body.name !== "string" || !isRecord(body.input)) {
          writeJson(response, 400, { ok: false, error: "Expected JSON body: { name: string, input: object }" })
          return
        }

        output.appendLine(`[bridge] invoking VS Code tool ${body.name}`)
        writeJson(response, 200, await invokeVscodeTool(body.name, body.input))
        return
      }

      if (request.method === "POST" && url.pathname === "/notebook/summary") {
        // 已解析的非对象参数属于客户端 400；JSON 语法错误仍进入原来的 500 错误边界。
        const body = await readJson(request)
        if (!isRecord(body)) {
          writeJson(response, 400, { ok: false, error: "Expected JSON object body" })
          return
        }

        writeJson(response, 200, await notebookSummary(stringProp(body, "filePath")))
        return
      }

      if (request.method === "POST" && url.pathname === "/notebook/source") {
        const body = await readJson(request)
        if (!isRecord(body)) {
          writeJson(response, 400, { ok: false, error: "Expected JSON object body" })
          return
        }

        writeJson(response, 200, await notebookSource(body))
        return
      }

      if (request.method === "POST" && (url.pathname === "/notebook/output" || url.pathname === "/notebook/cell-output")) {
        // 输出别名复用前置鉴权路径，不另设免认证入口。
        const body = await readJson(request)
        if (!isRecord(body)) {
          writeJson(response, 400, { ok: false, error: "Expected JSON object body" })
          return
        }

        const filePath = typeof body.filePath === "string" ? body.filePath : undefined
        // 省略路径的文档选择由 resolveNotebook 执行，HTTP 层不提前绑定读取参数时的编辑器焦点。
        const cellIndex = typeof body.cellIndex === "number" ? body.cellIndex : undefined
        // 缺省索引须在选定文档内解析，不能在 HTTP 层抓取另一个活动 notebook 的全局选区。
        const cellId = typeof body.cellId === "string" ? body.cellId : undefined
        // 完整 cellId 原样交给文档内解析器，截短字符串会让共享前缀的不同格产生歧义。
        output.appendLine(`[bridge] reading raw notebook output ${filePath ?? "<active>"} ${cellId ?? cellIndex ?? "<active cell>"}`)
        writeJson(response, 200, await readNotebookCellOutput(filePath, cellIndex, cellId))
        return
      }

      if (request.method === "POST" && url.pathname === "/notebook/run") {
        const body = await readJson(request)
        if (!isRecord(body)) {
          writeJson(response, 400, { ok: false, error: "Expected JSON object body" })
          return
        }

        writeJson(response, 200, await runNotebook(body))
        return
      }

      if (request.method === "POST" && url.pathname === "/notebook/edit") {
        const body = await readJson(request)
        if (!isRecord(body)) {
          writeJson(response, 400, { ok: false, error: "Expected JSON object body" })
          return
        }

        writeJson(response, 200, await editNotebook(body))
        return
      }

      if (request.method === "POST" && url.pathname === "/notebook/env") {
        // env 的源契约允许非对象 JSON 作为无路径检查，不能套用另外五个路由的 400 校验。
        const body = await readJson(request)
        writeJson(response, 200, await notebookEnv(isRecord(body) ? stringProp(body, "filePath") : undefined))
        return
      }

      writeJson(response, 404, { ok: false, error: "Not found" })
      // 未匹配路径不读取请求体，坏 JSON 或非对象 body 都不能把原 404 改成处理错误。
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      output.appendLine(`[bridge] error: ${message}`)
      writeJson(response, 500, { ok: false, error: message })
    }
  })

  return await new Promise((resolve, reject) => {
    // createServer 尚未绑定端口，凭证 Promise 必须等 listen 完成后才能返回可注入终端的地址。
    // 创建出的实例在 listen 前就归 owner 持有，卸载不会漏掉尚未触发回调的句柄。
    bridgeServer = server
    server.once("error", reject)
    // 监听错误须结算凭证 Promise，否则 openTerminal 的 await bridge 会无限等待不可用地址。
    // 回环地址约束监听范围，随机 token 约束能访问本机端口的调用者。
    server.listen(0, BRIDGE_HOST, () => {
      // 系统原子分配端口，避免先挑选或探测空闲端口再 listen 之间的抢占窗口。
      // 迟到的回调只结算取消，不能记录端口/token 或向终端发布 BridgeInfo。
      if (bridgeClosing) return reject(new Error("VS Code bridge startup cancelled"))
      const address = server.address()
      if (!address || typeof address === "string") {
        // 只有 TCP 地址对象提供可注入的端口，未绑定或 socket 地址不能冒充可用 BridgeInfo。
        reject(new Error("Failed to resolve bridge server port"))
        return
      }

      output.appendLine(`[bridge] listening on http://${BRIDGE_HOST}:${address.port}`)
      output.appendLine(`[bridge] token ${token}`)
      output.appendLine(`[bridge] health http://${BRIDGE_HOST}:${address.port}/health`)
      output.appendLine(`[bridge] tools  http://${BRIDGE_HOST}:${address.port}/tools/list?token=${token}`)
      output.appendLine(`[bridge] notebook summary POST http://${BRIDGE_HOST}:${address.port}/notebook/summary?token=${token}`)
      output.appendLine(`[bridge] notebook source  POST http://${BRIDGE_HOST}:${address.port}/notebook/source?token=${token}`)
      output.appendLine(`[bridge] notebook run     POST http://${BRIDGE_HOST}:${address.port}/notebook/run?token=${token}`)
      output.appendLine(`[bridge] notebook edit    POST http://${BRIDGE_HOST}:${address.port}/notebook/edit?token=${token}`)
      output.appendLine(`[bridge] notebook output  POST http://${BRIDGE_HOST}:${address.port}/notebook/output?token=${token}`)
      output.appendLine(`[bridge] notebook env     POST http://${BRIDGE_HOST}:${address.port}/notebook/env?token=${token}`)
      resolve({ port: address.port, token })
    })
  })
}

function authorized(request: http.IncomingMessage, url: URL, token: string) {
  // 完整 Bearer 比较与源 query-token 契约共用实例凭证；回环监听不能替代认证。
  return request.headers.authorization === `Bearer ${token}` || url.searchParams.get("token") === token
}

function writeJson(response: http.ServerResponse, status: number, value: unknown) {
  // HTTP 状态码表达路由、鉴权或处理失败，不能只在 JSON 内写错误文案。
  // UTF-8 响应保留中文诊断与 notebook 内容，避免依赖系统默认编码。
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" })
  // 一次结束响应并序列化原结构；异常沿请求错误边界传播，不能返回截断的成功 JSON。
  response.end(JSON.stringify(value, null, 2))
}

function readJson(request: http.IncomingMessage) {
  return new Promise<unknown>((resolve, reject) => {
    let body = ""
    // setEncoding 保证跨 chunk 的多字节字符由流解码器正确拼接。
    request.setEncoding("utf8")
    request.on("data", (chunk) => {
      body += chunk
    })
    request.on("end", () => {
      // 等到 end 才解析完整请求；空体默认对象保留源契约，字段仍由路由校验。
      try {
        resolve(body ? JSON.parse(body) : {})
      } catch (error) {
        reject(error)
      }
    })
    request.on("error", reject)
    // 流错误与 JSON 语法错误都拒绝 Promise，由路由的错误边界生成响应。
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  // 需对象参数的路由不能接受数组，否则按名取值会使 filePath/target 静默缺省并选中默认文档或格。
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function serializeToolResultPart(part: unknown) {
  if (part instanceof vscode.LanguageModelTextPart) {
    return { type: "text", value: part.value }
  }
  if (part instanceof vscode.LanguageModelPromptTsxPart) {
    return { type: "prompt-tsx", value: part.value }
  }
  return part
}

async function runVscodeTool(output: vscode.OutputChannel) {
  const tools = [...vscode.lm.tools].sort((a, b) => a.name.localeCompare(b.name))
  // UI 需要稳定排序，但不能为展示顺序原地重排 VS Code 提供的工具注册表。
  if (tools.length === 0) {
    // LM 注册表为空只关闭此代理入口，不能据此判定独立的原生 notebook 桥接不可用。
    void vscode.window.showWarningMessage("No VS Code language model tools are registered.")
    output.appendLine("[tool-test] no VS Code language model tools registered")
    return
  }

  const items: Array<vscode.QuickPickItem & { tool: vscode.LanguageModelToolInformation }> = tools.map((tool) => ({
    label: tool.name,
    description: tool.tags.join(", "),
    detail: tool.description,
    tool,
  }))
  const picked = await vscode.window.showQuickPick(
    items,
    {
      title: "Run VS Code Language Model Tool",
      placeHolder: "Select a VS Code LM tool to invoke",
      matchOnDescription: true,
      matchOnDetail: true,
    },
  )
  if (!picked) {
    return
  }

  output.show(true)
  output.appendLine(`[tool-test] selected ${picked.tool.name}`)
  output.appendLine(`[tool-test] schema ${JSON.stringify(picked.tool.inputSchema ?? {}, null, 2)}`)

  const inputText = await vscode.window.showInputBox({
    title: `Input JSON for ${picked.tool.name}`,
    prompt: "Edit the JSON input. It will be passed to vscode.lm.invokeTool.",
    value: JSON.stringify(schemaTemplate(picked.tool.inputSchema), null, 2),
    ignoreFocusOut: true,
    validateInput(value) {
      try {
        const parsed = JSON.parse(value)
        if (!isRecord(parsed)) {
          return "Input must be a JSON object"
        }
        return undefined
      } catch (error) {
        return error instanceof Error ? error.message : String(error)
      }
    },
  })
  if (inputText === undefined) {
    return
  }

  const input = JSON.parse(inputText) as Record<string, unknown>
  // 交互校验后的文本仍须解码为工具入参对象，不能把 JSON 字符串原样当作 LM input。
  output.appendLine(`[tool-test] invoking ${picked.tool.name} with ${JSON.stringify(input, null, 2)}`)

  const started = Date.now()
  const result = await invokeVscodeTool(picked.tool.name, input)
  const payload = {
    tool: picked.tool.name,
    elapsedMs: Date.now() - started,
    input,
    result,
  }

  output.appendLine(`[tool-test] result ${JSON.stringify(payload, null, 2)}`)
  await openJsonDocument(payload)
}

async function invokeVscodeTool(name: string, input: Record<string, unknown>) {
  // 69 的 LM 入口独立于 notebook 原生命令；调用错误沿 await 传播，不伪报 ok=true。
  const result = await vscode.lm.invokeTool(name, {
    // 缺省 token 遵循源调用契约，不伪造聊天授权上下文。
    toolInvocationToken: undefined,
    // 对象形状已校验，具体 schema 仍由所选工具解释。
    input,
  })
  return {
    ok: true,
    content: result.content.map(serializeToolResultPart),
    // 文本与 prompt-tsx 结果保留类型标签，不能一律强制拼成纯文本。
  }
}

async function openJsonDocument(value: unknown) {
  const document = await vscode.workspace.openTextDocument({
    content: JSON.stringify(value, null, 2),
    language: "json",
  })
  await vscode.window.showTextDocument(document, { preview: false })
}

// 模板仅是手工工具调用的输入建议，不是对工具 schema 的完整实现。
function schemaTemplate(schema: object | undefined) {
  // 缺少 properties 时返回空对象，不能擅自猜测工具需要的字段。
  if (!isRecord(schema) || !isRecord(schema.properties)) {
    return {}
  }

  return Object.fromEntries(
    // 属性名保留为输入键；非对象描述按空 schema 处理，default/enum 由 templateValue 优先解释。
    Object.entries(schema.properties).map(([key, value]) => [key, templateValue(isRecord(value) ? value : {})]),
  )
}

function templateValue(schema: Record<string, unknown>): unknown {
  // 显式 default 即使为 null、false 或零也须保留，不能被模板生成器的占位值覆盖。
  if (schema.default !== undefined) {
    return schema.default
  }
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    // 没有默认值时只从工具公布的候选中取值，不能为受限枚举猜一个字符串占位符。
    return schema.enum[0]
  }
  if (schema.type === "number" || schema.type === "integer") {
    return 0
  }
  if (schema.type === "boolean") {
    return false
  }
  if (schema.type === "array") {
    return []
  }
  if (schema.type === "object") {
    return schemaTemplate(schema)
  }
  return ""
}

async function notebookBridgeTools(output: vscode.OutputChannel) {
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
          if (!notebook) {
            return undefined
          }
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
      {
        label: "debug: VS Code LM tool proxy",
        description: "compare native bridge with vscode.lm.invokeTool",
        run: async () => {
          await runVscodeTool(output)
          return undefined
        },
      },
    ],
    {
      title: "opencode Notebook Bridge Tools",
      placeHolder: "Select a native notebook bridge tool",
      matchOnDescription: true,
    },
  )
  if (!picked) {
    return
  }

  output.show(true)
  output.appendLine(`[notebook-bridge] ${picked.label}`)
  const result = await picked.run()
  if (result === undefined) {
    return
  }
  output.appendLine(`[notebook-bridge] result ${JSON.stringify(result, null, 2)}`)
  await openJsonDocument(result)
}

function notebookCandidates() {
  return [...new Map(vscode.workspace.notebookDocuments.map((notebook) => [notebook.uri.toString(), notebook])).values()]
}

async function selectNotebook(required = true) {
  // 已打开文档按完整 URI 去重，同名文件不合并成同一个候选项。
  const notebooks = notebookCandidates()
  if (notebooks.length === 0) {
    // required=false 用于环境快照，允许在没有 notebook 时检查扩展能力。
    if (required) {
      void vscode.window.showWarningMessage("No open notebook documents found.")
    }
    return undefined
  }
  // 单候选自动返回保留原交互便利，多个候选必须让用户明确选择。
  return notebooks.length === 1 ? notebooks[0] : await pickNotebook(notebooks)
}

async function pickNotebook(notebooks: vscode.NotebookDocument[]) {
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
  // 取消文档选择不借用新的活动文档，后续操作只接受此次列表中持有的 notebook 对象。
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

async function notebookSummary(filePath?: string) {
  // 读取打开文档的实时内容，不用磁盘版本覆盖用户尚未保存的编辑。
  const notebook = await resolveNotebook(filePath)
  // ran=false 保持只读性质，已有输出不改变本次操作，不能隐式执行或保存文档。
  return compactNotebookResult(notebook, false)
}

async function readNotebookCellOutput(filePath?: string, cellIndex?: number, cellId?: string) {
  const notebook = await resolveNotebook(filePath)
  // index 保留源优先级，canonical ID 与 summary 同源；后续写入不得重选文档或格。
  const cell = resolveNotebookCell(notebook, cellIndex, cellId)
  // 此端点只导出已有输出，不能为了补齐缺失输出而启动内核执行。
  return await serializeNotebookCellOutput(notebook, cell)
}

async function runNotebookCommand() {
  // all、range 和 cell 共用同一文档 URI，选择过程中切换编辑器不改目标。
  const notebook = await selectNotebook()
  if (!notebook) {
    return undefined
  }

  const target = await vscode.window.showQuickPick(
    [
      { label: "cell", description: "run one selected cell" },
      { label: "range", description: "run inclusive zero-based start/end cell range" },
      { label: "all", description: "run all cells" },
    ],
    { title: "vscode_notebook_run", placeHolder: "Select run target" },
  )
  if (!target) {
    return undefined
  }

  if (target.label === "all") {
    // 手工 UI 调用现有 runNotebook，不建立第二个原生执行入口。
    return await runNotebook({ filePath: notebook.uri.toString(), target: { type: "all" } })
  }

  if (target.label === "cell") {
    const cell = await pickNotebookCell(notebook, "vscode_notebook_run")
    return cell ? await runNotebook({ filePath: notebook.uri.toString(), target: { type: "cell", cellId: cell.cellId } }) : undefined
  }

  const rangeText = await vscode.window.showInputBox({
    title: "vscode_notebook_run range",
    prompt: "Enter start,end zero-based indices. End is inclusive in this prompt.",
    value: "0,0",
    ignoreFocusOut: true,
  })
  if (!rangeText) {
    // 取消文本输入直接退出，不能把缺失范围替换成当前活动选区执行。
    return undefined
  }
  const [start, end] = rangeText.split(",").map((value) => Number(value.trim()))
  // 此提示接受零基闭区间，仅此处 end 加一；HTTP target.end 已是排他终点，仍由 notebookRange 解释。
  return await runNotebook({ filePath: notebook.uri.toString(), target: { type: "range", start, end: end + 1 } })
}

async function runNotebook(input: Record<string, unknown>) {
  // 文档和范围先绑定到局部变量，所有 await 之后仍使用这一组目标。
  const notebook = await resolveNotebook(stringProp(input, "filePath"))
  const target = isRecord(input.target) ? input.target : {}
  const range = notebookRange(notebook, target, typeof input.cellIndex === "number" ? input.cellIndex : undefined)
  const cells = notebook.getCells(range)
  // await 前保留目标格对象；其它格的源码或输出变化不应阻止本次执行。
  // showNotebookDocument 为官方 URI 解析提供已打开的编辑器，不把焦点当身份。
  const editor = await vscode.window.showNotebookDocument(notebook, { selections: [range] })

  const commands = await vscode.commands.getCommands(true)
  if (!commands.includes("notebook.cell.execute")) {
    // 原生执行入口只有 notebook.cell.execute，能力检测失败就直接报错。
    throw new Error("VS Code command notebook.cell.execute is not available")
  }
  // 所有界面与能力查询结束后再校验目标，结构漂移时不调用命令或更新旧选区。
  if (notebook.isClosed || cells.some((cell, index) => notebook.getCells()[range.start + index] !== cell)) {
    // 按原范围核对对象，目标移位、删除或替换仍拒绝；不要求整份文档版本保持不变。
    throw new Error("Notebook changed before execution; select the target cells again")
  }
  editor.selection = range
  editor.revealRange(range)

  const startedAt = Date.now()
  // 观察起点必须早于命令 await，快速执行可能在命令返回前结束，晚采样会误判为旧结果。
  // 半开 ranges 与完整 URI 对象交给官方解析器；autoReveal=false 不借自动聚焦改变已绑定的执行目标。
  await vscode.commands.executeCommand("notebook.cell.execute", { ranges: cells.map((cell) => ({ start: cell.index, end: cell.index + 1 })), document: notebook.uri, autoReveal: false })
  // 官方多格参数以 document 找编辑器，再按半开 ranges 取格；焦点切换不改变执行目标。
  const completed = await waitForNotebookExecution(notebook, cells, startedAt, numberProp(input, "timeoutMs") ?? 60_000)
  return await compactRunResult(notebook, range, completed, cells)
}

async function editNotebookCommand() {
  const notebook = await selectNotebook()
  if (!notebook) {
    return undefined
  }
  const operation = await vscode.window.showQuickPick(
    ["insert_before", "insert_after", "insert_top", "insert_bottom", "replace_source", "replace_cell", "delete"],
    {
      title: "vscode_notebook_edit",
      placeHolder: "Select edit operation",
    },
  )
  if (!operation) {
    return undefined
  }

  const isPositional = operation === "insert_top" || operation === "insert_bottom"
  // 顶部和底部插入不需要锚点，删除和替换必须保留已选格的定位信息。
  const cell = isPositional ? undefined : await pickNotebookCell(notebook, "vscode_notebook_edit")

  if (!isPositional && !cell) {
    return undefined
  }

  const source =
    operation === "delete"
      ? undefined
      : await vscode.window.showInputBox({
          title: "vscode_notebook_edit source",
          prompt: "Cell source. Use literal \\n for newlines in this quick test input.",
          value: operation === "replace_source" && cell ? cell.cell.document.getText().replace(/\n/g, "\\n") : "",
          ignoreFocusOut: true,
        })

  if (operation !== "delete" && source === undefined) {
    // delete 没有 source 参数也可执行，不能强迫用户提供将被忽略的内容。
    // undefined 表示取消，空字符串是合法清空内容，不能被当作取消。
    return undefined
  }

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

const EDIT_OPERATIONS = new Set([
  "insert_before",
  "insert_after",
  "insert_top",
  "insert_bottom",
  "replace_source",
  "replace_cell",
  "delete",
])

async function editNotebook(input: Record<string, unknown>) {
  const notebook = await resolveNotebook(stringProp(input, "filePath"))
  const operation = stringProp(input, "operation")

  // operation 白名单在构建 WorkspaceEdit 前校验，未知操作不得降级成插入。
  if (!operation || !EDIT_OPERATIONS.has(operation)) {
    throw new Error(`Invalid notebook edit operation: ${operation ?? "<missing>"}`)
  }

  // 结构编辑会改变 cellCount，差分基线必须在 applyEdit 前记录，不能在返回后反推原格数。
  const beforeCount = notebook.cellCount

  if (operation === "delete") {
    const cell = resolveNotebookCell(notebook, numberProp(input, "cellIndex"), stringProp(input, "cellId"))
    // 删除后旧格 index 会变为 -1；编辑范围和结果必须共享删除前的位置。
    const affectedCellIndex = cell.index
    const edit = new vscode.WorkspaceEdit()
    edit.set(notebook.uri, [vscode.NotebookEdit.deleteCells(new vscode.NotebookRange(affectedCellIndex, affectedCellIndex + 1))])
    const applied = await vscode.workspace.applyEdit(edit)
    if (input.save === true) {
      await saveNotebook(notebook)
    }
    return compactEditResult(notebook, {
      applied,
      operation,
      beforeCount,
      afterCount: notebook.cellCount,
      affectedCellIndex,
    })
  }

  const targetCell =
    operation === "insert_top" || operation === "insert_bottom"
      ? undefined
      : resolveNotebookCell(notebook, numberProp(input, "cellIndex"), stringProp(input, "cellId"))

  const kind = cellKindFromInput(input, targetCell)
  const language = cellLanguageFromInput(input, kind, targetCell)
  const sourceRaw = sourceProp(input, "source", targetCell ? documentEol(targetCell.document) : "\n")

  if (sourceRaw === undefined) {
    throw new Error(`source is required for ${operation}`)
  }

  const source = kind === vscode.NotebookCellKind.Code ? stripCodeFence(sourceRaw) : sourceRaw
  // 代码围栏只在 code 格剥离，markdown 格中的围栏是文档正文。

  if (operation === "replace_source") {
    if (!targetCell) {
      throw new Error("replace_source requires a target cell")
    }
    const edit = new vscode.WorkspaceEdit()
    // 源码替换作用于 cell 文档 URI；结构替换作用于 notebook URI，二者不可混用。
    edit.replace(targetCell.document.uri, fullDocumentRange(targetCell.document), source)
    const applied = await vscode.workspace.applyEdit(edit)
    if (input.save === true) {
      await saveNotebook(notebook)
    }
    return compactEditResult(notebook, {
      applied,
      operation,
      beforeCount,
      afterCount: notebook.cellCount,
      affectedCellIndex: targetCell.index,
      kind: cellKindLabel(targetCell.kind),
      language: targetCell.document.languageId,
      sourcePreview: source,
    })
  }

  const insertIndex =
    operation === "insert_top"
      ? 0
      : operation === "insert_bottom"
        ? notebook.cellCount
        : operation === "insert_after"
          ? targetCell!.index + 1
          : targetCell!.index // insert_before or replace_cell

  // 结构替换会移除目标格；anchor 报告提交编辑时的位置，不读取失效格的动态索引。
  const anchorCellIndex = targetCell?.index
  const range =
    operation === "replace_cell"
      ? new vscode.NotebookRange(targetCell!.index, targetCell!.index + 1)
      : new vscode.NotebookRange(insertIndex, insertIndex)

  const newCell = new vscode.NotebookCellData(kind, source, language)
  const edit = new vscode.WorkspaceEdit()
  edit.set(notebook.uri, [vscode.NotebookEdit.replaceCells(range, [newCell])])
  const applied = await vscode.workspace.applyEdit(edit)
  // save=true 是显式请求，默认编辑只改变打开文档；dirty 保存失败必须传播，不能伪报持久化成功。
  if (input.save === true) {
    await saveNotebook(notebook)
  }

  return compactEditResult(notebook, {
    // applyEdit 的布尔结果必须随响应返回，不能仅凭构造成功宣称已经应用。
    applied,
    operation,
    beforeCount,
    afterCount: notebook.cellCount,
    anchorCellIndex,
    affectedCellIndex: insertIndex,
    kind: cellKindLabel(kind),
    language,
    sourcePreview: source,
  })
}

async function saveNotebook(notebook: vscode.NotebookDocument) {
  // 捕获调用 save 前的 dirty 状态；clean 文档返回 false 代表无需写盘，不能误报失败。
  const dirty = notebook.isDirty
  // false 对 dirty 文档表示真实失败；拒绝或抛错自然沿现有 HTTP/palette 错误边界传播。
  if (!(await notebook.save()) && dirty) throw new Error(`Failed to save notebook: ${notebook.uri.toString()}`)
}

async function notebookEnv(filePath?: string) {
  // 此版本 env 是能力快照，不执行 Python 探针来代替内核就绪证据。
  const notebook = await resolveNotebook(filePath).catch(() => undefined)
  // 文档解析失败可返回未知环境，仍保留 Python/Jupyter 扩展的安装状态。
  // commands 表只说明命令已注册，不能据此推断命令调用会成功完成。
  const commands = await vscode.commands.getCommands(true)
  const names = [
    "notebook.cell.execute",
    "notebook.execute",
    "notebook.selectKernel",
    "notebook.kernel.restart",
    "jupyter.selectKernel",
    "jupyter.restartkernel",
    // Python 解释器命令与 notebook 内核命令分别报告，不把二者视为同一运行时。
    "python.setInterpreter",
  ]
  return {
    ran: false,
    summary: `Notebook runtime: ${notebook ? (runtimeLabel(notebook) ?? "unknown") : "unknown"}; Python/Jupyter extensions: ${extensionState("ms-python.python")}/${extensionState("ms-toolsai.jupyter")}.`,
    data: {
      path: notebook?.uri.fsPath || notebook?.uri.toString(),
      runtime: notebook ? runtimeLabel(notebook) : null,
      // active_notebook 只记录 UI 焦点；路径解析失败或焦点指向别的文档时，不能拿它补齐本次目标的 runtime。
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

async function resolveNotebook(filePath?: string) {
  // filePath 可选属于 69 的源行为，不能提前套用后续工具的强制路径规则。
  if (!filePath) {
    const active = vscode.window.activeNotebookEditor?.notebook
    if (active) {
      return active
    }
    if (vscode.workspace.notebookDocuments.length > 0) {
      return vscode.workspace.notebookDocuments[0]
    }
    throw new Error("No active or open notebook document")
  }

  const existing = vscode.workspace.notebookDocuments.find(
    // 匹配完整 URI 或 fsPath，同 basename 的多个文档不能互相替代。
    (notebook) => notebook.uri.fsPath === filePath || notebook.uri.toString() === filePath,
  )
  if (existing) {
    // 已打开文档优先返回，保留其 dirty 源码、输出及瞬态执行摘要。
    return existing
  }

  // 打开前由 uriFromInput 区分 Windows 盘符与 URI scheme，避免盘符被误当协议。
  // 显式路径打开失败沿 await 传播，不能转而执行另一份活动文档。
  return await vscode.workspace.openNotebookDocument(uriFromInput(filePath))
}

function resolveNotebookCell(notebook: vscode.NotebookDocument, cellIndex?: number, cellId?: string) {
  if (cellIndex !== undefined) {
    // cellAt 保留 VS Code 的边界检查，index 只表示当前位置，不是稳定身份。
    return notebook.cellAt(cellIndex)
  }

  if (cellId) {
    const normalized = cellId.replace(/^#/, "")
    // 仅在给定文档内以 summary 同款 canonical ID 匹配，不比较截短显示片段。
    const cells = notebook.getCells().filter((candidate) => cellIdentifiers(candidate).some((id) => shortId(id) === shortId(normalized)))
    // 多个别名命中同一格不算歧义，多个不同格命中必须拒绝。
    if (cells.length > 1) throw new Error(`Ambiguous notebook cell ID: ${cellId}`)
    if (cells.length === 1) {
      return cells[0]
    }
    // 显式 ID 不命中直接抛错，不能猜前缀或降级选择首格。
    throw new Error(`Notebook cell not found: ${cellId}`)
  }

  const active = vscode.window.activeNotebookEditor
  // 仅在缺省格参数时考虑选区，并先验证活动编辑器的完整 notebook URI。
  if (active?.notebook.uri.toString() === notebook.uri.toString()) {
    const range = active.selection
    if (range && !range.isEmpty) {
      return notebook.cellAt(range.start)
    }
  }

  return notebook.cellAt(0)
}

function captureNotebookCellOutput(notebook: vscode.NotebookDocument, cell: vscode.NotebookCell) {
  // outputs 是原模型的可变列表，先复制层级，后续输出替换不能改变请求的 item 集合。
  // item.data 还可能原地改写，复制 Uint8Array 才能同时固定预览字节和 artifact 字节。
  const outputs = cell.outputs.map((output) => ({ items: output.items.map((item) => ({ mime: item.mime, data: Uint8Array.from(item.data) })) }))
  // 捕获函数没有 I/O；run 可以先完成全部目标的投影，再启动任一格的文件写入。
  return {
    outputs,
    data: {
      path: notebook.uri.fsPath || notebook.uri.toString(),
      dirty: notebook.isDirty,
      // runtime 是捕获时的元数据描述，不与文件写入完成时的内核标签重新拼接。
      runtime: runtimeLabel(notebook),
      // 捕获中没有 await，compactCell 已同步生成私有 MIME 列表，无需再投影一次。
      cell: compactCell(cell),
    },
  }
}

async function serializeNotebookCellOutput(notebook: vscode.NotebookDocument, cell: vscode.NotebookCell) {
  // path、dirty、runtime 与格状态在同一同步边界捕获，不能晚于输出字节选取。
  const snapshot = captureNotebookCellOutput(notebook, cell)
  const artifacts = (
    // 任一 item 写入失败都会拒绝整体导出，不能把缺失 artifact 隐藏在成功列表中。
    await Promise.all(
      // 每个 output 可含多个 MIME item，导出必须保留所有替代表示而非只取第一项。
      snapshot.outputs.flatMap((cellOutput, outputIndex) =>
        // 输出序号只定位快照；统一 serializer 以每次导出的 UUID 避免覆盖旧文件。
        cellOutput.items.map((item, itemIndex) => serializeNotebookOutputItem(notebook, cell, item, outputIndex, itemIndex)),
      ),
    )
  ).flat()

  const summaryLines = [
    // 标题只读取快照格编号与 MIME，即使写入期间发生插格或第二次运行也保持 A 的描述。
    `Cell ${snapshot.data.cell.i} existing outputs: ${snapshot.data.cell.existing_outs.join(", ") || "none"}.`,
    `ArtifactsRoot: .opencode/cache/notebook-outputs/`,
    "",
    "Artifacts:",
    // 文本摘要中的路径与 data.artifacts 指向同一次导出，不能返回尚未写入的文件。
    ...artifacts.map((a) => formatArtifactSummary(a)),
  ].join("\n")

  return {
    ran: false,
    summary: summaryLines,
    data: {
      // await 后只附加实际写入路径，不能重新 compactCell 将 B 的状态贴到 A 的输出上。
      ...snapshot.data,
      artifacts,
    },
  }
}

async function serializeNotebookOutputItem(
  notebook: vscode.NotebookDocument,
  cell: vscode.NotebookCell,
  item: vscode.NotebookCellOutputItem,
  outputIndex: number,
  itemIndex: number,
) {
  // 原始 data 用于 artifact，UTF-8 解码仅产生可选文本预览，不参与二进制写入。
  const text = outputItemText(item)
  // MIME、大小、预览及内联阈值也须早于写入 await，不能只固定文件中的字节。
  const data = {
    output: outputIndex,
    item: itemIndex,
    // MIME、字节数和输出序号一起返回，让消费者无需靠扩展名猜测真实内容。
    mime: item.mime,
    bytes: item.data.byteLength,
    // previewText 的字符预算与原始 byteLength 不同，中文和 emoji 不能按字符估字节。
    preview: previewText(text ?? `<${item.mime} ${item.data.byteLength} bytes>`),
    // 8192 字节只限制内联 text，超过上限或零字节输出仍须完整导出真实 artifact。
    text: text && item.data.byteLength <= 8_192 ? text : undefined,
  }
  // 同一格重跑可能替换 outputs；写入器在首次异步边界前复制当前 item 字节。
  const artifact = await writeNotebookArtifact(notebook, cell, item, outputIndex, itemIndex)
  return {
    ...data,
    artifactPath: artifact.fsPath,
    // 两个地址来自同一 writer；URI 保留远程 scheme/authority，path 继续供本地消费者使用。
    artifactURI: artifact.uri.toString(),
  }
}

function outputItemText(item: vscode.NotebookCellOutputItem) {
  // stdout、stderr 和 notebook error 使用 VS Code 专用 MIME，不能只检测 text/。
  if (
    item.mime.startsWith("text/") ||
    item.mime === "application/json" ||
    item.mime === "application/vnd.code.notebook.stdout" ||
    item.mime === "application/vnd.code.notebook.stderr" ||
    item.mime === "application/vnd.code.notebook.error"
  ) {
    // JSON 只解码展示，不格式化原字节；解码不赋予 current-run 来源，也不判定运行成功。
    return Buffer.from(item.data).toString("utf8")
  }
  // PNG 或未知 MIME 不进入 UTF-8 解码，摘要引用原始 artifact，避免乱码预览。
  return undefined
}

function compactNotebookResult(notebook: vscode.NotebookDocument, ran: boolean, extra?: Record<string, unknown>) {
  const cells = notebook.getCells().map(compactCell)
  return {
    ran,
    summary: notebookSummaryText(notebook, cells),
    data: {
      // dirty 与 runtime 元数据随同一文档返回，不能采用别的活动编辑器状态。
      path: notebook.uri.fsPath || notebook.uri.toString(),
      dirty: notebook.isDirty,
      runtime: runtimeLabel(notebook),
      cells,
      ...extra,
    },
  }
}

async function compactRunResult(notebook: vscode.NotebookDocument, range: vscode.NotebookRange, completed: boolean, targets: vscode.NotebookCell[]) {
  const info = {
    path: notebook.uri.fsPath || notebook.uri.toString(),
    // dirty 是发起导出时的文档状态，不在异步写入后重新查询或自动保存。
    dirty: notebook.isDirty,
    runtime: runtimeLabel(notebook),
    // target 是原请求范围的显示描述，结构编辑后须按 cells 的稳定 ID 重选，不能把旧范围字符串当新选择器。
    target: runTarget(range, notebook.cellCount),
  }
  // 多格请求先同步捕获全部格；逐格先写文件再捕获下一格会混合不同观察时刻。
  const snapshots = targets.map((cell) => captureNotebookCellOutput(notebook, cell))
  // 遍历保留格和全格快照，不能重新解析旧范围；所有 artifact 写入结束后才返回路径。
  const cells = await Promise.all(targets.map((cell, index) => compactRunCell(notebook, cell, snapshots[index])))
  // artifact 导出也有异步边界，目标在导出期间被删除或替换时明确拒绝返回完成结果。
  if (notebook.isClosed || targets.some((cell) => notebook.getCells()[cell.index] !== cell)) throw new Error("Notebook target cells changed during execution")
  // 此处读取原模型只用于身份失效判定，不用于刷新已经捕获的响应内容。
  return {
    ran: true,
    // 外层标题与 data 共用捕获值，不能在首格 I/O 后再查询文档描述。
    summary: runSummaryText(info, completed, cells),
    data: {
      ...info,
      // completed 只描述等待边界；超时仍提供已有输出供诊断，不偷换成单格 success。
      completed,
      cells,
    },
  }
}

async function compactRunCell(notebook: vscode.NotebookDocument, cell: vscode.NotebookCell, snapshot: ReturnType<typeof captureNotebookCellOutput>) {
  return {
    // 当前 index 只用于解释范围和输出归属，插入删除后应重新读取 summary。
    i: snapshot.data.cell.i,
    // 返回 canonical ID 供后续 source/output/edit 回传，不能再生成截短的运行专用 ID。
    id: snapshot.data.cell.id,
    exec: snapshot.data.cell.exec,
    // 原生 success/provenance 已在同步捕获阶段投影，stdout、第二次运行或等待完成不能补写结果。
    execution: snapshot.data.cell.execution,
    // run 与 output 共用从复制 items 得到的 MIME 列表，不增设另一套输出状态观察器。
    existing_outs: snapshot.data.cell.existing_outs,
    artifacts: await Promise.all(
      // existing_outs 去重仅作能力列表；artifact 是输出序列，同 MIME 的重复输出也须逐项保留原顺序。
      // Promise.all 的拒绝不会撤销兄弟写入，失败响应后可能仍留有已写成的 artifact，不能按事务回滚理解。
      snapshot.outputs.flatMap((cellOutput, outputIndex) =>
        cellOutput.items.map((item, itemIndex) => serializeNotebookOutputItem(notebook, cell, item, outputIndex, itemIndex)),
      ),
    ),
  }
}

function quoteForSummary(s: string) {
  // 短标签转义换行以保持每格一条摘要；展示转义不能回写源码或原始 artifact 字节。
  return `"${s.replace(/\n/g, "\\n")}"`
}

function runSummaryText(
  // 四个文档字段都是捕获后的标量，格式化接口不再接收可变 NotebookDocument。
  info: { path: string; dirty: boolean; runtime: string | null; target: string },
  completed: boolean,
  cells: Array<Awaited<ReturnType<typeof compactRunCell>>>,
) {
  const artifactRoot = ".opencode/cache/notebook-outputs/"
  return [
    // summary 仅组合 info、完成标志及格快照，与 data 描述同一批已选取输出。
    `Notebook: ${toPosixPath(info.path)}`,
    `Run: target=${info.target} completed=${completed} dirty=${info.dirty} runtime=${info.runtime ?? "unknown"}`,
    `ArtifactsRoot: ${artifactRoot}`,
    "",
    "Cells:",
    ...cells.map((c) => `c${c.i} id=${c.id} exec=${quoteForSummary(c.exec)} outs=${quoteForSummary(c.existing_outs.join(",") || "none")}`),
    "",
    "Artifacts:",
    ...cells.flatMap((c) => c.artifacts.map((a) => formatArtifactSummary(a, c.i))),
  ].join("\n")
}

type NotebookArtifact = {
  // 摘要接受 serializer 返回的标量结构，不直接读取可变 cell/output 代理来补齐字段。
  output: number
  item: number
  mime: string
  bytes: number
  preview?: string
  text?: string
  artifactPath: string
  // URI 不参与摘要 basename 提取，因此此字段可选；远程读取仍须使用 writer 返回的完整地址。
  artifactURI?: string
}

function formatArtifactSummary(a: NotebookArtifact, cellIndex?: number) {
  // output/item 序号可在不同格内重复，多格 run 需要格前缀；单格导出已由标题绑定身份。
  const prefix = cellIndex !== undefined ? `c${cellIndex} ` : ""
  // MIME 短标签只用于显示，真实 MIME 和字节数仍保留在结构化数据中。
  const baseInfo = `${prefix}output=${a.output} item=${a.item} ${shortMime(a.mime)} ${formatBytes(a.bytes)}`

  const isTextLike =
    a.mime.startsWith("text/") ||
    a.mime === "application/json" ||
    a.mime === "application/vnd.code.notebook.stdout" ||
    a.mime === "application/vnd.code.notebook.stderr" ||
    a.mime === "application/vnd.code.notebook.error" ||
    shortMime(a.mime) === "datawrangler"

  // 1024 字符只控制内联展示，完整内容已写入 artifact，不能误作文件字节上限。
  if (isTextLike && a.text !== undefined && a.text.length <= 1024) {
    const isMultiLine = a.text.includes("\n")
    if (isMultiLine) {
      // 多行展示保留真实换行便于读回，单行用 JSON 转义防止引号或控制字符破坏条目边界。
      return `${baseInfo}\n<content>\n${a.text}\n</content>`
    } else {
      return `${baseInfo} ${JSON.stringify(a.text)}`
    }
  } else if (isTextLike) {
    // 缺省 text 的大输出只展示 preview，完整内容须读取返回路径。
    const content = a.text !== undefined ? a.text.slice(0, 1024) : a.preview
    return `${baseInfo} -> ${artifactName(a.artifactPath)}\n<content>\n${content}\n... (truncated, full output in the file)\n</content>`
  } else {
    return `${baseInfo} -> ${artifactName(a.artifactPath)}${a.preview ? ` ${quoteForSummary(a.preview)}` : ""}`
  }
}

function artifactName(p: string) {
  // basename 仅用于紧凑展示，不能作为读取地址；真实路径与远程 URI 保留在结构化 artifact 中。
  return p.replace(/\\/g, "/").split("/").pop() ?? p
}

function formatBytes(n: number) {
  if (n >= 1024 * 1024) {
    return `${(n / 1024 / 1024).toFixed(1)}MB`
  }
  if (n >= 1024) {
    return `${(n / 1024).toFixed(1)}KB`
  }
  return `${n}B`
}

function runTarget(range: vscode.NotebookRange, cellCount: number) {
  if (range.start === 0 && range.end === cellCount) {
    return "all"
  }
  if (range.end === range.start + 1) {
    return `cell ${range.start}`
  }
  return `range ${range.start}-${range.end - 1}`
}

async function notebookSourceCommand() {
  // 选择后持有文档对象和 URI，后续 UI await 或焦点切换不能把读取转到另一份 notebook。
  const notebook = await selectNotebook()
  if (!notebook) {
    return undefined
  }

  const target = await vscode.window.showQuickPick(
    [
      { label: "all", description: "all cells" },
      { label: "cell", description: "one cell" },
    ],
    { title: "vscode_notebook_source target" },
  )
  if (!target) {
    return undefined
  }

  if (target.label === "all") {
    return await notebookSource({ filePath: notebook.uri.toString() })
  }

  if (target.label === "cell") {
    const cell = await pickNotebookCell(notebook, "vscode_notebook_source cell")
    if (!cell) return undefined
    return await notebookSource({ filePath: notebook.uri.toString(), cellId: cell.cellId })
  }
}

async function notebookSource(input: Record<string, unknown>) {
  const notebook = await resolveNotebook(stringProp(input, "filePath"))
  const limit = Math.max(1, Math.min(numberProp(input, "limit") ?? 1000, 1000))
  // 行数预算与字节预算互补，大量空行或短行虽少占字节也不能无限占用提示版面。
  let offset = Math.max(1, numberProp(input, "offset") ?? 1)

  const { lines, cellRanges } = notebookSourceVirtualLines(notebook)
  // cellId 通过共享格解析器选定窗口，虚拟行号仍是整个 notebook 的全局编号。
  const targetCellIndex = input.cellIndex !== undefined || input.cellId !== undefined ? resolveNotebookCell(notebook, numberProp(input, "cellIndex"), stringProp(input, "cellId")).index : undefined

  let globalStart = 1
  let globalEnd = lines.length
  let warning = ""

  if (targetCellIndex !== undefined && cellRanges.has(targetCellIndex)) {
    // 单格窗口只限制读取终点，仍保留全局行号，不能将所选格的首行重新编号为一。
    const range = cellRanges.get(targetCellIndex)!
    if (input.offset !== undefined) {
      if (offset >= range.start && offset <= range.end) {
        // 全局续读行号优先，避免同一数值也可作局部偏移时跳过上一页指定的继续位置。
        globalStart = offset
      } else if (range.start + offset - 1 >= range.start && range.start + offset - 1 <= range.end) {
        // 仅在全局解释不适用时保留源相对偏移契约，不能把既有读格调用改成无条件拒绝。
        globalStart = range.start + offset - 1
      } else {
        globalStart = range.start
        warning = "WARNING: Offset out of bounds for the specified cell! ALWAYS use GLOBAL document line numbers. Offset reset to default."
        // 两种解释都越界时显式警告并返回实际 offset，不能让调用方误以为错误位置已被采用。
      }
    } else {
      globalStart = range.start
    }
    globalEnd = range.end
  } else {
    if (input.offset !== undefined) {
      globalStart = offset
    }
  }

  // 空 notebook 的虚拟行数为零，起点仍须保持一；以零作上界会产生负数组索引，把正常 EOF 读成错误。
  globalStart = Math.max(1, Math.min(globalStart, lines.length > 0 ? lines.length : 1))

  let bytes = 0
  const maxBytes = 12 * 1024
  // 12 KiB 预算只计虚拟行内容，行号前缀和响应封装另有开销，不能承诺完整 HTTP 响应的硬上限。
  let cut = false
  const returnedLines: string[] = []
  let currentLineIndex = globalStart - 1

  while (currentLineIndex < globalEnd && currentLineIndex < lines.length && returnedLines.length < limit) {
    const line = lines[currentLineIndex]
    // byteLength 按 UTF-8 预算，中文源码的字符数不能替代网络字节数。
    const lineBytes = Buffer.byteLength(line, "utf8")
    // 首行允许进入空窗口以保证分页推进，单行截断由虚拟行构建器单独负责。
    if (bytes + lineBytes > maxBytes && returnedLines.length > 0) {
      cut = true
      break
    }
    returnedLines.push(`${currentLineIndex + 1}: ${line}`)
    bytes += lineBytes
    currentLineIndex++
  }

  const more = currentLineIndex < globalEnd && currentLineIndex < lines.length
  // cut 表示字节截断，more 表示仍有后续行；续读位置按实际消费行号计算。

  let output = warning ? `${warning}\n\n` : ""
  output += [`<path>${notebook.uri.fsPath || notebook.uri.toString()}</path>`, `<type>notebook</type>`, "<content>"].join("\n") + "\n"
  output += returnedLines.join("\n")

  if (cut) {
    output += `\n\n(Output capped at 12 KB. Showing lines ${globalStart}-${currentLineIndex}. Use offset=${currentLineIndex + 1} to continue.)`
  } else if (more) {
    output += `\n\n(Showing lines ${globalStart}-${currentLineIndex} of ${lines.length}. Use offset=${currentLineIndex + 1} to continue.)`
  } else {
    if (targetCellIndex !== undefined) {
      output += `\n\n(End of cell ${targetCellIndex})`
    } else {
      output += `\n\n(End of file - total ${lines.length} lines)`
    }
  }
  output += "\n</content>"

  return {
    ran: false,
    summary: output,
    data: {
      path: notebook.uri.fsPath || notebook.uri.toString(),
      target: targetCellIndex !== undefined ? `cell ${targetCellIndex}` : "all",
      offset: globalStart,
      limit,
      returned: returnedLines.length,
      totalLines: lines.length,
      truncated: cut || more,
    },
  }
}

function notebookSourceVirtualLines(notebook: vscode.NotebookDocument) {
  const lines: string[] = []
  // cellRanges 保留每格窗口的起止，不能按局部 lineCount 直接翻页。
  const cellRanges = new Map<number, { start: number; end: number }>()

  for (const cell of notebook.getCells()) {
    const start = lines.length + 1
    // ID 与 summary 同源，格头不能临时生成基于 index 的另一套身份。
    const id = shortId(cellIdentifiers(cell)[0] ?? cell.document.uri.toString())
    lines.push(`--- c${cell.index} ${cellKindLabel(cell.kind)}/${cell.document.languageId} id=${id} lines=${cell.document.lineCount} ---`)
    // 即使源码为空也保留格头，读取结果才能区分空格与已删除的格。
    const sourceLines = cell.document.getText().split(/\r?\n/).map((line) =>
      // 使用打开格源码保留未保存编辑；CRLF/LF 都拆行，2000 字符截断明确标注为预览。
      line.length > 2000 ? line.substring(0, 2000) + "... (line truncated to 2000 chars)" : line
    )
    lines.push(...sourceLines)
    // 格头与空分隔行均计入一基虚拟行号，消费者须以全局 offset 续读。
    lines.push("")
    const end = lines.length
    cellRanges.set(cell.index, { start, end })
  }

  return { lines, cellRanges }
}

function toPosixPath(p: string) {
  return p.replace(/\\/g, "/")
}

function notebookSummaryText(notebook: vscode.NotebookDocument, cells: ReturnType<typeof compactCell>[]) {
  // 总计只统计 code 格，markdown 格不需要原生代码执行摘要。
  const code = cells.filter((cell) => cell.kind === "code")
  // 有输出但 success 未知的格不计入已执行数量，保存结果不冒充本次执行。
  const executed = code.filter((cell) => cell.execution.status !== "unknown")
  const failed = code.filter((cell) => cell.execution.status === "failed")
  // status 读取结构化 success 派生值，不依赖 exec 文案的前缀或词序。
  const status = failed.length
    // 先报告失败数，防止所有格都有输出时把失败格归入全成功分支。
    ? `${failed.length} failed`
    // 没有代码格时保留零比零统计，不能用空数组 every 的真值宣称全部执行成功。
    : executed.length === code.length && code.length > 0
      ? "All code cells executed successfully."
      : `${executed.length}/${code.length} code cells executed`
  return [
    `Notebook: ${toPosixPath(notebook.uri.fsPath || notebook.uri.toString())}`,
    `Type: ${notebook.notebookType}, dirty=${notebook.isDirty}, cells=${notebook.cellCount}, runtime=${runtimeLabel(notebook) ?? "unknown"}. ${status}`,
    "",
    'Cells (format: i id=<canonical stable cell id> <kind>/<lang> lines=<line count> exec="<provenance: unknown/saved, order, status, duration, end time>" existing_outs="<output MIME summary>" first="<first source line>"):',
    ...cells.map(
      // first 是有预算的预览，完整源码应通过 source 读取，不能反解摘要。
      (cell) =>
        `${cell.i} id=${cell.id} ${cell.kind}/${cell.lang} lines=${cell.lines} exec=${quoteForSummary(cell.exec)} existing_outs=${quoteForSummary(cell.existing_outs.join(",") || "none")} first=${JSON.stringify(cell.first)}`,
    ),
    "",
    "Next: use vscode_notebook_source with cellIndex=N, offset=1, limit=120 for source; use vscode_notebook_output for outputs.",
  ].join("\n")
}

function compactCell(cell: vscode.NotebookCell) {
  return {
    i: cell.index,
    // URI 兜底绑定格文档，不以会随插入删除漂移的索引生成摘要身份。
    id: shortId(cellIdentifiers(cell)[0] ?? cell.document.uri.toString()),
    kind: cell.kind === vscode.NotebookCellKind.Code ? "code" : "markdown",
    // 语言和行数来自实时 cell.document，不用保存 metadata 覆盖未保存编辑。
    lang: cell.document.languageId,
    lines: cell.document.lineCount,
    // execution 是机器可读状态，exec 仅保留人类可读的顺序、时间和来源文案。
    exec: executionText(cell),
    // existing_outs 列出 MIME 能力，不作为成功或失败的业务判定输入。
    existing_outs: existingOuts(cell),
    // 首行预览取真实源码后截短，不执行代码或剥离 markdown 正文。
    first: previewText((cell.document.getText().split("\n")[0] ?? "").trim()).slice(0, 120),
    execution: executionState(cell),
  }
}

function existingOuts(cell: vscode.NotebookCell) {
  return [...new Set(cell.outputs.flatMap((cellOutput) => cellOutput.items.map((item) => shortMime(item.mime))))]
}

function executionText(cell: vscode.NotebookCell) {
  const summary = cell.executionSummary
  if (!summary) {
    if (cell.outputs.length === 0) {
      return "not-run"
    }
    const saved = savedExecution(cell)
    // saved 保留历史时间，但成功仍未知，不能从保存的 MIME 推断。
    return `saved #${saved.order} ${saved.status}${saved.duration}${saved.ended}`
  }
  const state = executionState(cell).provenance
  const status = executionState(cell).status
  // executionOrder 为零也可能存在，不能用真值检查将其判为未运行。
  const order = summary.executionOrder ?? "?"
  // duration 的非负钳制只影响展示，不能让异常时序成为执行完成证据。
  const duration = summary.timing ? ` ${Math.max(0, summary.timing.endTime - summary.timing.startTime)}ms` : " ?ms"
  // 无 timing 明确保留未知结束时间，不拿导出时间充当内核结束时间。
  const ended = summary.timing ? ` ended=${new Date(summary.timing.endTime).toISOString()}` : " ended=?"
  return `${state} #${order} ${status}${duration}${ended}`
}

function savedExecution(cell: vscode.NotebookCell) {
  const outputMetadata = cell.outputs.map((output) => output.metadata).filter(isRecord)
  const endedRaw = firstString(
    // 整格结束时间优先于各输出 timestamp，避免将某一输出的写入时间优先当作整格结束。
    stringAt(cell.metadata, "execution_end_time"),
    stringAt(cell.metadata, "end_time"),
    ...outputMetadata.flatMap((metadata) => [
      stringAt(metadata, "execution_end_time"),
      stringAt(metadata, "end_time"),
      stringAt(metadata, "timestamp"),
    ]),
  )
  const startedRaw = firstString(
    // 历史开始时间只取保存的 cell/output 字段，不能与本次导出开始时间拼成伪造的执行耗时。
    stringAt(cell.metadata, "execution_start_time"),
    stringAt(cell.metadata, "start_time"),
    ...outputMetadata.flatMap((metadata) => [stringAt(metadata, "execution_start_time"), stringAt(metadata, "start_time")]),
  )
  const duration = durationText(startedRaw, endedRaw)
  return {
    // execution_count 只展示顺序，不能替代 executionSummary.success。
    order: numberAt(cell.metadata, "execution_count") ?? "?",
    // serializer 可在 metadata 写入自定义 status/success，但这些同名字段不具原生 executionSummary.success 的语义。
    status: "unknown",
    // 缺失或无法解析的时间保留问号，不补成当前时间或回写 metadata scope。
    duration,
    ended: endedRaw ? ` ended=${formatDate(endedRaw)}` : " ended=?",
  }
}

function durationText(startedRaw?: string, endedRaw?: string) {
  // 历史时间字段是可选字符串，缺少任一端点就不能计算可靠耗时。
  if (!startedRaw || !endedRaw) {
    return " ?ms"
  }
  const started = Date.parse(startedRaw)
  const ended = Date.parse(endedRaw)
  if (!Number.isFinite(started) || !Number.isFinite(ended)) {
    // 排除 Date.parse 的 NaN，问号表示证据缺失，不能用当前时间补齐旧执行。
    return " ?ms"
  }
  // start/end 独立选取保存字段，可能来自不同输出时钟；负差钳零只是展示下限，不证明真实耗时为零。
  return ` ${Math.max(0, ended - started)}ms`
}

function formatDate(input: string) {
  const value = Date.parse(input)
  // 无法解析的历史值原样展示，不能补成当前时间或抛错使整个只读摘要不可用。
  return Number.isFinite(value) ? new Date(value).toISOString() : input
}

function firstString(...values: Array<string | undefined>) {
  // 空白时间戳应继续寻找下一 metadata 来源，不能让首个空白字段遮住后续保存证据。
  return values.find((value) => value && value.trim())
}

function runtimeLabel(notebook: vscode.NotebookDocument) {
  // kernelspec/language_info 是文档元数据描述，不证明当前选中的解释器、内核进程或包版本。
  const kernelspec = isRecord(notebook.metadata.kernelspec) ? notebook.metadata.kernelspec : undefined
  const language = isRecord(notebook.metadata.language_info) ? notebook.metadata.language_info : undefined
  const kernelName = stringProp(kernelspec ?? {}, "display_name") ?? stringProp(kernelspec ?? {}, "name")
  const languageName = stringProp(language ?? {}, "name")
  const languageVersion = stringProp(language ?? {}, "version")
  if (kernelName && languageName && languageVersion) {
    return `${kernelName} (${languageName} ${languageVersion})`
  }
  if (kernelName) {
    return kernelName
  }
  if (languageName && languageVersion) {
    return `${languageName} ${languageVersion}`
  }
  return languageName ?? null
}

function shortMime(mime: string) {
  if (mime === "application/vnd.code.notebook.stdout") {
    return "stdout"
  }
  if (mime === "application/vnd.code.notebook.stderr") {
    return "stderr"
  }
  if (mime === "application/vnd.code.notebook.error") {
    return "error"
  }
  if (mime === "image/png") {
    return "png"
  }
  if (mime === "image/jpeg") {
    return "jpeg"
  }
  if (mime === "text/plain") {
    return "text"
  }
  if (mime === "text/html") {
    return "html"
  }
  if (mime === "text/markdown") {
    return "markdown"
  }
  if (mime === "application/json") {
    return "json"
  }
  if (mime.includes("datawrangler")) {
    return "datawrangler"
  }
  return mime.split("/").pop() ?? mime
}

function shortId(id: string) {
  // canonical ID 必须保留完整内容供摘要、源码与解析器往返，截短会混淆共享前缀的不同格。
  return `#VSC-${id.replace(/^#?VSC-/, "").replace(/^#/, "")}`
}

function executionState(cell: vscode.NotebookCell) {
  return {
    // 状态只取原生 success 布尔值，输出存在或 MIME 名称都不能补成成功/失败证据。
    status: cell.executionSummary?.success === false ? "failed" : cell.executionSummary?.success === true ? "succeeded" : "unknown",
    // 摘要与 timing 可从磁盘恢复，缺少请求身份时来源仍为 unknown；无摘要的历史输出仅标 saved。
    provenance: cell.executionSummary ? "unknown" : cell.outputs.length > 0 ? "saved" : "unknown",
  }
}

function extensionState(id: string) {
  const extension = vscode.extensions.getExtension(id)
  if (!extension) {
    return "missing"
  }
  return extension.isActive ? "active" : "installed"
}

function notebookRange(notebook: vscode.NotebookDocument, target: Record<string, unknown>, fallbackCellIndex?: number) {
  // 只有未提供 type 才默认单格；显式 null、非字符串和拼错的类型必须保留给拒绝分支。
  const type = target.type === undefined ? "cell" : target.type
  if (type === "all") {
    // all 的终点取总 cellCount 而非代码格数量，Markup 也占原生索引；用代码格数量会截掉后面的代码格。
    return new vscode.NotebookRange(0, notebook.cellCount)
  }
  if (type === "range") {
    const start = Math.max(0, numberProp(target, "start") ?? 0)
    const end = Math.min(notebook.cellCount, numberProp(target, "end") ?? start + 1)
    // target.end 是排他终点；至少一格的源钳制与手工闭区间转换分开。
    return new vscode.NotebookRange(start, Math.max(start + 1, end))
  }
  // 未知目标不能降级执行首格；先拒绝再计算 cell 索引，避免认证输入的拼写错误触发错误代码。
  if (type !== "cell") throw new Error(`Invalid notebook target type: ${String(type)}`)
  const cellId = stringProp(target, "cellId")
  // 文档 await 后先按选中 ID 定位，失效 ID 必须由 resolver 抛错，不能进入数字钳制而执行首格。
  const index = cellId
    ? resolveNotebookCell(notebook, undefined, cellId).index
    // 只有数字定位仍按 target.cellIndex、顶层 fallback、零的源顺序钳制，不因 UI 竞态改变 HTTP 数字契约。
    : Math.max(0, Math.min(notebook.cellCount - 1, numberProp(target, "cellIndex") ?? fallbackCellIndex ?? 0))
  return new vscode.NotebookRange(index, index + 1)
}

async function waitForNotebookExecution(notebook: vscode.NotebookDocument, cells: vscode.NotebookCell[], startedAt: number, timeoutMs: number) {
  // 此 waiter 只观察提交时保留的格对象，不把插入到旧范围内的新格当执行目标。
  const valid = () => !notebook.isClosed && cells.every((cell) => notebook.getCells()[cell.index] === cell)
  // 命令 await 期间已删除目标也必须报错，不能让空 code 列表的 every 伪报完成。
  if (!valid()) throw new Error("Notebook target cells changed during execution")
  const done = () =>
    cells
      // Markup 格没有执行时序，不能因缺少其 endTime 让纯文档范围永久等待。
      .filter((cell) => cell.kind === vscode.NotebookCellKind.Code)
      .every((cell) => {
        const timing = cell.executionSummary?.timing
        // code 格需要新于 startedAt 的结束时间，历史输出不能直接满足完成条件。
        return timing?.endTime !== undefined && timing.endTime >= startedAt
      })

  // 首次 done 检查覆盖命令返回前已完成的快速执行，避免漏掉早到事件。
  if (done()) {
    return true
  }

  return await new Promise<boolean>((resolve, reject) => {
  // 观察期限结束与目标失效分别返回 false 或拒绝，二者都清理现有订阅。
    const timer = setTimeout(() => {
      // 超时 dispose 后返回 false 只表示观察期限结束，不宣称已中断内核。
      subscription.dispose()
      if (!valid()) return reject(new Error("Notebook target cells changed during execution"))
      resolve(false)
    }, timeoutMs)
    const subscription = vscode.workspace.onDidChangeNotebookDocument((event) => {
      // 工作区事件来自所有 notebook，必须先匹配完整 URI 再检查本请求的格范围。
      if (event.notebook.uri.toString() !== notebook.uri.toString()) {
        return
      }
      if (!valid()) {
        clearTimeout(timer)
        subscription.dispose()
        reject(new Error("Notebook target cells changed during execution"))
        return
      }
      if (!done()) {
        return
      }
      // 满足条件时同时 clearTimeout 和 dispose，不能让已返回请求继续持有监听器。
      clearTimeout(timer)
      subscription.dispose()
      resolve(true)
    })
  })
}

async function writeNotebookArtifact(
  notebook: vscode.NotebookDocument,
  cell: vscode.NotebookCell,
  item: vscode.NotebookCellOutputItem,
  outputIndex: number,
  itemIndex: number,
) {
  const root = artifactRoot(notebook)
  const data = Uint8Array.from(item.data)
  // 原始字节在 filesystem await 前复制，后续输出变更不能改变已捕获快照。
  const filename = [
    // basename 经 ASCII 化并限长，非 ASCII 文件名不会撑过文件系统预算。
    path.basename(notebook.uri.fsPath || "untitled", path.extname(notebook.uri.fsPath || "untitled")).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 48),
    // 每个导出项已有独立 UUID，同名文档和重跑无需再叠加 URI 哈希来区分。
    randomUUID(),
    `cell-${cell.index}`,
    `output-${outputIndex}`,
    `item-${itemIndex}`,
  ].join("-") + extensionForMime(item.mime)
  const uri = vscode.Uri.joinPath(root, filename)
  // workspace.fs 保留 URI 的文件系统提供者，不能把远程工作区路径当成本地 Node 路径写。
  await vscode.workspace.fs.createDirectory(root)
  // 文件创建失败向上抛出；只有实际写入成功的 URI 才能出现在 artifactPath 中。
  await vscode.workspace.fs.writeFile(uri, data)
  return { uri, fsPath: uri.fsPath || uri.toString() }
}

function artifactRoot(notebook: vscode.NotebookDocument) {
  // 优先所属 workspace folder；无所属根保留源首根回退，导出项仍由 UUID 区分。
  const folder = vscode.workspace.getWorkspaceFolder(notebook.uri) ?? vscode.workspace.workspaceFolders?.[0]
  if (!folder) {
    // 无工作区显式报错，不能擅自写到扩展安装目录或用户主目录。
    throw new Error("Notebook output artifacts require an open workspace folder")
  }
  // joinPath 在 URI 层拼接，保留远程提供者的 scheme 与 authority。
  return vscode.Uri.joinPath(folder.uri, ".opencode", "cache", "notebook-outputs")
}

function extensionForMime(mime: string) {
  if (mime === "image/png") {
    return ".png"
  }
  if (mime === "image/jpeg") {
    return ".jpg"
  }
  if (mime === "image/svg+xml") {
    return ".svg"
  }
  if (mime === "text/html") {
    return ".html"
  }
  if (mime === "application/json") {
    return ".json"
  }
  if (mime.startsWith("text/")) {
    return ".txt"
  }
  return ".bin"
}

function extensionInfo(id: string) {
  // 只读取已公布的扩展状态与版本，不能为环境快照主动 activate 扩展并触发安装或内核副作用。
  const extension = vscode.extensions.getExtension(id)
  return extension
    ? {
        id: extension.id,
        isActive: extension.isActive,
        version: extension.packageJSON?.version,
      }
    : undefined
}

function previewText(text: string) {
  return text.length > 500 ? `${text.slice(0, 500)}...` : text
}

function cellIdentifiers(cell: vscode.NotebookCell) {
  // URI 身份先于可被 serializer 改写的 metadata 别名；解析器仍检查全部别名并拒绝跨格冲突。
  return [
    cell.document.uri.fragment || cell.document.uri.toString(),
    stringAt(cell.metadata, "id"),
    stringAt(cell.metadata, "cellId"),
    nestedStringAt(cell.metadata, "vscode", "cellId"),
    nestedStringAt(cell.metadata, "custom", "id"),
  ].filter((value): value is string => !!value)
}

function stringAt(record: Record<string, unknown>, key: string) {
  const value = record[key]
  return typeof value === "string" ? value : undefined
}

function nestedStringAt(record: Record<string, unknown>, key: string, nestedKey: string) {
  const value = record[key]
  // 不同 notebook serializer 可省略或改变嵌套 metadata 形状，非对象应视为缺失而非使摘要崩溃。
  if (!isRecord(value)) {
    return undefined
  }
  return stringAt(value, nestedKey)
}

function stringProp(record: Record<string, unknown>, key: string) {
  const value = record[key]
  return typeof value === "string" ? value : undefined
}

function numberAt(record: Record<string, unknown>, key: string) {
  const value = record[key]
  // 保存的 execution_count 可以为零；数字字符串不强制转型，缺失证据仍保留未知顺序。
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function numberProp(record: Record<string, unknown>, key: string) {
  const value = record[key]
  // 执行位置和 timeout 只接受有限数字，不能把数字文本或非有限内部输入悄悄用作范围边界。
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function uriFromInput(input: string) {
  // Windows 路径的盘符冒号必须先于 scheme 检测，否则 C: 会被解析成 URI 协议。
  // 盘符判断必须带根斜杠，单字母冒号不足以判定文件路径，否则会把 x:cell 这类 URI 误交给文件提供者。
  if (/^[a-zA-Z]:[\\/]/.test(input)) {
    return vscode.Uri.file(input)
  }
  if (input.startsWith("/")) {
    // Uri.file 负责文件路径编码，不能拼接 file:// 遗漏空格转义。
    return vscode.Uri.file(input)
  }
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(input)) {
    // 显式 scheme 通过 Uri.parse 保留 remote、untitled 等提供者的 URI 身份。
    // URI 的 authority 和 fragment 属于完整文档定位，不应只留下 fsPath。
    return vscode.Uri.parse(input)
  }
  // 普通相对路径继续交给 Uri.file，保持源版本对路径输入的既有解释。
  return vscode.Uri.file(input)
}

function fullDocumentRange(document: vscode.TextDocument) {
  // 源码替换必须覆盖格文档的完整末端，不能借用活动编辑器的选区而残留旧源码。
  if (document.lineCount === 0) {
    return new vscode.Range(0, 0, 0, 0)
  }
  return new vscode.Range(new vscode.Position(0, 0), document.lineAt(document.lineCount - 1).range.end)
}

function documentEol(document: vscode.TextDocument) {
  return document.eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n"
}

function sourceProp(record: Record<string, unknown>, key: string, eol = "\n") {
  const value = record[key]
  // 字符串原样保留换行；空字符串可清空内容，不能与未提供源码的 undefined 合并。
  if (typeof value === "string") return value
  // 数组中的每项都须为字符串，不能把对象或数字隐式转成代码文本。
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    // 空数组按零行输入解释为空源码，不能因数组长度为零拒绝显式清空。
    // 字符串数组只按调用方提供的文档 EOL 拼接，不能强制改为 LF。
    return value.join(eol)
  }
  // 非字符串输入拒绝；code/markdown 围栏处理归 editNotebook，本解析器不改写正文。
  return undefined
}

function cellKindFromInput(input: Record<string, unknown>, existing?: vscode.NotebookCell) {
  const kind = stringProp(input, "kind")
  const language = stringProp(input, "language")

  if (kind === "markdown" || language === "markdown") {
    // markdown 是结构类型并优先于 kind=code，否则按 markdown 语言请求的格会被当成可执行代码。
    return vscode.NotebookCellKind.Markup
  }
  if (kind === "code") {
    return vscode.NotebookCellKind.Code
  }
  return existing?.kind ?? vscode.NotebookCellKind.Code
}

function cellLanguageFromInput(
  input: Record<string, unknown>,
  kind: vscode.NotebookCellKind,
  existing?: vscode.NotebookCell,
) {
  const language = stringProp(input, "language")
  // 非空显式语言允许有意修改语法模式，空字符串仍走原默认，不能成为有效 languageId。
  if (language) return language
  // Markup 默认语言不能沿用原代码格的 python；语言字段仅配置 cell，不切换解释器或内核。
  if (kind === vscode.NotebookCellKind.Markup) return "markdown"
  // Code 保留现有 languageId；无现有格才默认 python，避免意外改变语法模式。
  return existing?.document.languageId ?? "python"
}

function cellKindLabel(kind: vscode.NotebookCellKind) {
  return kind === vscode.NotebookCellKind.Markup ? "markdown" : "code"
}

function stripCodeFence(source: string) {
  // 仅剥离完整包围正文的围栏，源码中间的反引号或未闭合围栏不能被宽松搜索截掉。
  const match = source.match(/^```[\w-]*\r?\n([\s\S]*?)\r?\n```$/)
  return match ? match[1] : source
}

function compactEditResult(
  notebook: vscode.NotebookDocument,
  info: {
    applied: boolean
    operation: string
    beforeCount: number
    afterCount: number
    anchorCellIndex?: number
    affectedCellIndex?: number
    kind?: string
    language?: string
    sourcePreview?: string
  },
) {
  const target =
    // 删除后此位置可能是继任格，摘要只描述当前槽位，不能声称被删除的原格仍存在。
    info.affectedCellIndex !== undefined && info.affectedCellIndex >= 0 && info.affectedCellIndex < notebook.cellCount
      ? notebook.cellAt(info.affectedCellIndex)
      : undefined

  const targetText = target
    ? `c${target.index} ${cellKindLabel(target.kind)}/${target.document.languageId} lines=${target.document.lineCount} first=${JSON.stringify(previewText((target.document.getText().split("\n")[0] ?? "").trim()).slice(0, 120))}`
    : "none"

  return {
    ran: false,
    summary: [
      `Notebook edit: applied=${info.applied} op=${info.operation} cells=${info.beforeCount}->${info.afterCount} dirty=${notebook.isDirty}.`,
      info.anchorCellIndex !== undefined ? `Anchor: c${info.anchorCellIndex}.` : undefined,
      info.affectedCellIndex !== undefined ? `Affected: c${info.affectedCellIndex}. ${targetText}` : undefined,
      info.sourcePreview ? `Preview: ${JSON.stringify(info.sourcePreview.slice(0, 160))}` : undefined,
      `Next: use vscode_notebook_source for full cell source; use vscode_notebook_summary for full notebook state.`,
    ].filter(Boolean).join("\n"),
    data: {
      applied: info.applied,
      operation: info.operation,
      cellCountBefore: info.beforeCount,
      cellCountAfter: info.afterCount,
      anchorCellIndex: info.anchorCellIndex,
      affectedCellIndex: info.affectedCellIndex,
      dirty: notebook.isDirty,
      kind: info.kind,
      language: info.language,
    },
  }
}
