import * as vscode from "vscode"
import * as http from "node:http"
import { randomUUID } from "node:crypto"
import * as path from "node:path"

const TERMINAL_NAME = "opencode"
const BRIDGE_HOST = "127.0.0.1"

let bridgeServer: http.Server | undefined
let bridgeOutput: vscode.OutputChannel | undefined

type BridgeInfo = {
  port: number
  token: string
}

export function deactivate() {
  bridgeServer?.close()
  bridgeOutput?.dispose()
}

export function activate(context: vscode.ExtensionContext) {
  const output = vscode.window.createOutputChannel("opencode")
  bridgeOutput = output
  const bridge = startBridge(output).catch((error) => {
    output.appendLine(`[bridge] failed to start: ${error instanceof Error ? error.message : String(error)}`)
    throw error
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
      // @ts-ignore
      const port = terminal.creationOptions.env?.["_EXTENSION_OPENCODE_PORT"]
      port ? await appendPrompt(parseInt(port), fileRef) : terminal.sendText(fileRef, false)
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
    const port = Math.floor(Math.random() * (65535 - 16384 + 1)) + 16384
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
      env: {
        _EXTENSION_OPENCODE_PORT: port.toString(),
        OPENCODE_VSCODE_BRIDGE_PORT: bridgeInfo.port.toString(),
        OPENCODE_VSCODE_BRIDGE_TOKEN: bridgeInfo.token,
        OPENCODE_CALLER: "vscode",
      },
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
    do {
      await new Promise((resolve) => setTimeout(resolve, 200))
      try {
        await fetch(`http://localhost:${port}/app`)
        connected = true
        break
      } catch {}

      tries--
    } while (tries > 0)

    // If connected, append the prompt to the terminal
    if (connected) {
      await appendPrompt(port, `In ${fileRef}`)
      terminal.show()
    }
  }

  async function appendPrompt(port: number, text: string) {
    await fetch(`http://localhost:${port}/tui/append-prompt`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text }),
    })
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
  const token = randomUUID()

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", `http://${BRIDGE_HOST}`)
    output.appendLine(`[bridge] ${request.method} ${url.pathname}`)

    try {
      if (request.method === "GET" && url.pathname === "/health") {
        writeJson(response, 200, {
          ok: true,
          service: "opencode-vscode-bridge",
          tools: vscode.lm.tools.length,
        })
        return
      }

      if (!authorized(request, url, token)) {
        writeJson(response, 401, { ok: false, error: "Unauthorized" })
        return
      }

      if (request.method === "GET" && url.pathname === "/tools/list") {
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
        const body = await readJson(request)
        if (!isRecord(body)) {
          writeJson(response, 400, { ok: false, error: "Expected JSON object body" })
          return
        }

        const filePath = typeof body.filePath === "string" ? body.filePath : undefined
        const cellIndex = typeof body.cellIndex === "number" ? body.cellIndex : undefined
        const cellId = typeof body.cellId === "string" ? body.cellId : undefined
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
        const body = await readJson(request)
        writeJson(response, 200, await notebookEnv(isRecord(body) ? stringProp(body, "filePath") : undefined))
        return
      }

      writeJson(response, 404, { ok: false, error: "Not found" })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      output.appendLine(`[bridge] error: ${message}`)
      writeJson(response, 500, { ok: false, error: message })
    }
  })

  return await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, BRIDGE_HOST, () => {
      bridgeServer = server
      const address = server.address()
      if (!address || typeof address === "string") {
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
  return request.headers.authorization === `Bearer ${token}` || url.searchParams.get("token") === token
}

function writeJson(response: http.ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" })
  response.end(JSON.stringify(value, null, 2))
}

function readJson(request: http.IncomingMessage) {
  return new Promise<unknown>((resolve, reject) => {
    let body = ""
    request.setEncoding("utf8")
    request.on("data", (chunk) => {
      body += chunk
    })
    request.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {})
      } catch (error) {
        reject(error)
      }
    })
    request.on("error", reject)
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
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
  if (tools.length === 0) {
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
  const result = await vscode.lm.invokeTool(name, {
    toolInvocationToken: undefined,
    input,
  })
  return {
    ok: true,
    content: result.content.map(serializeToolResultPart),
  }
}

async function openJsonDocument(value: unknown) {
  const document = await vscode.workspace.openTextDocument({
    content: JSON.stringify(value, null, 2),
    language: "json",
  })
  await vscode.window.showTextDocument(document, { preview: false })
}

function schemaTemplate(schema: object | undefined) {
  if (!isRecord(schema) || !isRecord(schema.properties)) {
    return {}
  }

  return Object.fromEntries(
    Object.entries(schema.properties).map(([key, value]) => [key, templateValue(isRecord(value) ? value : {})]),
  )
}

function templateValue(schema: Record<string, unknown>): unknown {
  if (schema.default !== undefined) {
    return schema.default
  }
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
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
  const notebooks = notebookCandidates()
  if (notebooks.length === 0) {
    if (required) {
      void vscode.window.showWarningMessage("No open notebook documents found.")
    }
    return undefined
  }
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
  return picked?.notebook
}

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

async function notebookSummary(filePath?: string) {
  const notebook = await resolveNotebook(filePath)
  return compactNotebookResult(notebook, false)
}

async function readNotebookCellOutput(filePath?: string, cellIndex?: number, cellId?: string) {
  const notebook = await resolveNotebook(filePath)
  const cell = resolveNotebookCell(notebook, cellIndex, cellId)
  return await serializeNotebookCellOutput(notebook, cell)
}

async function runNotebookCommand() {
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
    return await runNotebook({ filePath: notebook.uri.toString(), target: { type: "all" } })
  }

  if (target.label === "cell") {
    const cell = await pickNotebookCell(notebook, "vscode_notebook_run")
    return cell ? await runNotebook({ filePath: notebook.uri.toString(), target: { type: "cell", cellIndex: cell.index } }) : undefined
  }

  const rangeText = await vscode.window.showInputBox({
    title: "vscode_notebook_run range",
    prompt: "Enter start,end zero-based indices. End is inclusive in this prompt.",
    value: "0,0",
    ignoreFocusOut: true,
  })
  if (!rangeText) {
    return undefined
  }
  const [start, end] = rangeText.split(",").map((value) => Number(value.trim()))
  return await runNotebook({ filePath: notebook.uri.toString(), target: { type: "range", start, end: end + 1 } })
}

async function runNotebook(input: Record<string, unknown>) {
  const notebook = await resolveNotebook(stringProp(input, "filePath"))
  const target = isRecord(input.target) ? input.target : {}
  const range = notebookRange(notebook, target, typeof input.cellIndex === "number" ? input.cellIndex : undefined)
  const editor = await vscode.window.showNotebookDocument(notebook, { selections: [range] })
  editor.selection = range
  editor.revealRange(range)

  const commands = await vscode.commands.getCommands(true)
  if (!commands.includes("notebook.cell.execute")) {
    throw new Error("VS Code command notebook.cell.execute is not available")
  }

  const startedAt = Date.now()
  await vscode.commands.executeCommand("notebook.cell.execute")
  const completed = await waitForNotebookExecution(notebook, range, startedAt, numberProp(input, "timeoutMs") ?? 60_000)
  return await compactRunResult(notebook, range, completed)
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
          value: operation === "replace_source" && cell ? cell.document.getText().replace(/\n/g, "\\n") : "",
          ignoreFocusOut: true,
        })

  if (operation !== "delete" && source === undefined) {
    return undefined
  }

  return await editNotebook({
    filePath: notebook.uri.toString(),
    operation,
    cellIndex: cell?.index,
    source: source?.replace(/\\n/g, "\n"),
    language: cell?.document.languageId,
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

  if (!operation || !EDIT_OPERATIONS.has(operation)) {
    throw new Error(`Invalid notebook edit operation: ${operation ?? "<missing>"}`)
  }

  const beforeCount = notebook.cellCount

  if (operation === "delete") {
    const cell = resolveNotebookCell(notebook, numberProp(input, "cellIndex"), stringProp(input, "cellId"))
    const edit = new vscode.WorkspaceEdit()
    edit.set(notebook.uri, [vscode.NotebookEdit.deleteCells(new vscode.NotebookRange(cell.index, cell.index + 1))])
    const applied = await vscode.workspace.applyEdit(edit)
    if (input.save === true) {
      await notebook.save()
    }
    return compactEditResult(notebook, {
      applied,
      operation,
      beforeCount,
      afterCount: notebook.cellCount,
      affectedCellIndex: cell.index,
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

  if (operation === "replace_source") {
    if (!targetCell) {
      throw new Error("replace_source requires a target cell")
    }
    const edit = new vscode.WorkspaceEdit()
    edit.replace(targetCell.document.uri, fullDocumentRange(targetCell.document), source)
    const applied = await vscode.workspace.applyEdit(edit)
    if (input.save === true) {
      await notebook.save()
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

  const range =
    operation === "replace_cell"
      ? new vscode.NotebookRange(targetCell!.index, targetCell!.index + 1)
      : new vscode.NotebookRange(insertIndex, insertIndex)

  const newCell = new vscode.NotebookCellData(kind, source, language)
  const edit = new vscode.WorkspaceEdit()
  edit.set(notebook.uri, [vscode.NotebookEdit.replaceCells(range, [newCell])])
  const applied = await vscode.workspace.applyEdit(edit)
  if (input.save === true) {
    await notebook.save()
  }

  return compactEditResult(notebook, {
    applied,
    operation,
    beforeCount,
    afterCount: notebook.cellCount,
    anchorCellIndex: targetCell?.index,
    affectedCellIndex: insertIndex,
    kind: cellKindLabel(kind),
    language,
    sourcePreview: source,
  })
}

async function notebookEnv(filePath?: string) {
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

async function resolveNotebook(filePath?: string) {
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
    (notebook) => notebook.uri.fsPath === filePath || notebook.uri.toString() === filePath,
  )
  if (existing) {
    return existing
  }

  return await vscode.workspace.openNotebookDocument(uriFromInput(filePath))
}

function resolveNotebookCell(notebook: vscode.NotebookDocument, cellIndex?: number, cellId?: string) {
  if (cellIndex !== undefined) {
    return notebook.cellAt(cellIndex)
  }

  if (cellId) {
    const normalized = cellId.replace(/^#/, "")
    const cell = notebook.getCells().find((candidate) => cellIdentifiers(candidate).some((id) => id.replace(/^#/, "") === normalized))
    if (cell) {
      return cell
    }
    throw new Error(`Notebook cell not found: ${cellId}`)
  }

  const active = vscode.window.activeNotebookEditor
  if (active?.notebook.uri.toString() === notebook.uri.toString()) {
    const range = active.selection
    if (range && !range.isEmpty) {
      return notebook.cellAt(range.start)
    }
  }

  return notebook.cellAt(0)
}

async function serializeNotebookCellOutput(notebook: vscode.NotebookDocument, cell: vscode.NotebookCell) {
  const artifacts = (
    await Promise.all(
      cell.outputs.flatMap((cellOutput, outputIndex) =>
        cellOutput.items.map((item, itemIndex) => serializeNotebookOutputItem(notebook, cell, item, outputIndex, itemIndex)),
      ),
    )
  ).flat()

  const summaryLines = [
    `Cell ${cell.index} existing outputs: ${existingOuts(cell).join(", ") || "none"}.`,
    `ArtifactsRoot: .opencode/cache/notebook-outputs/`,
    "",
    "Artifacts:",
    ...artifacts.map((a) => formatArtifactSummary(a)),
  ].join("\n")

  return {
    ran: false,
    summary: summaryLines,
    data: {
      path: notebook.uri.fsPath || notebook.uri.toString(),
      dirty: notebook.isDirty,
      runtime: runtimeLabel(notebook),
      cell: compactCell(cell),
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
  const text = outputItemText(item)
  const artifact = await writeNotebookArtifact(notebook, cell, item, outputIndex, itemIndex)
  return {
    output: outputIndex,
    item: itemIndex,
    mime: item.mime,
    bytes: item.data.byteLength,
    preview: previewText(text ?? `<${item.mime} ${item.data.byteLength} bytes>`),
    text: text && item.data.byteLength <= 8_192 ? text : undefined,
    artifactPath: artifact.fsPath,
  }
}

function outputItemText(item: vscode.NotebookCellOutputItem) {
  if (
    item.mime.startsWith("text/") ||
    item.mime === "application/json" ||
    item.mime === "application/vnd.code.notebook.stdout" ||
    item.mime === "application/vnd.code.notebook.stderr" ||
    item.mime === "application/vnd.code.notebook.error"
  ) {
    return Buffer.from(item.data).toString("utf8")
  }
  return undefined
}

function compactNotebookResult(notebook: vscode.NotebookDocument, ran: boolean, extra?: Record<string, unknown>) {
  const cells = notebook.getCells().map(compactCell)
  return {
    ran,
    summary: notebookSummaryText(notebook, cells),
    data: {
      path: notebook.uri.fsPath || notebook.uri.toString(),
      dirty: notebook.isDirty,
      runtime: runtimeLabel(notebook),
      cells,
      ...extra,
    },
  }
}

async function compactRunResult(notebook: vscode.NotebookDocument, range: vscode.NotebookRange, completed: boolean) {
  const cells = await Promise.all(notebook.getCells(range).map((cell) => compactRunCell(notebook, cell)))
  return {
    ran: true,
    summary: runSummaryText(notebook, range, completed, cells),
    data: {
      path: notebook.uri.fsPath || notebook.uri.toString(),
      dirty: notebook.isDirty,
      runtime: runtimeLabel(notebook),
      target: runTarget(range, notebook.cellCount),
      completed,
      cells,
    },
  }
}

async function compactRunCell(notebook: vscode.NotebookDocument, cell: vscode.NotebookCell) {
  return {
    i: cell.index,
    id: shortId(cellIdentifiers(cell)[0] ?? `cell-${cell.index}`),
    exec: executionText(cell),
    existing_outs: existingOuts(cell),
    artifacts: await Promise.all(
      cell.outputs.flatMap((cellOutput, outputIndex) =>
        cellOutput.items.map((item, itemIndex) => serializeNotebookOutputItem(notebook, cell, item, outputIndex, itemIndex)),
      ),
    ),
  }
}

function quoteForSummary(s: string) {
  return `"${s.replace(/\n/g, "\\n")}"`
}

function runSummaryText(
  notebook: vscode.NotebookDocument,
  range: vscode.NotebookRange,
  completed: boolean,
  cells: Array<Awaited<ReturnType<typeof compactRunCell>>>,
) {
  const artifactRoot = ".opencode/cache/notebook-outputs/"
  return [
    `Notebook: ${toPosixPath(notebook.uri.fsPath || notebook.uri.toString())}`,
    `Run: target=${runTarget(range, notebook.cellCount)} completed=${completed} dirty=${notebook.isDirty} runtime=${runtimeLabel(notebook) ?? "unknown"}`,
    `ArtifactsRoot: ${artifactRoot}`,
    "",
    "Cells:",
    ...cells.map((c) => `c${c.i} id=${c.id} exec=${quoteForSummary(c.exec)} outs=${quoteForSummary(c.existing_outs.join(",") || "none")}`),
    "",
    "Artifacts:",
    ...cells.flatMap((c) => c.artifacts.map((a) => formatArtifactSummary(a, c.i))),
  ].join("\n")
}

function formatArtifactSummary(a: any, cellIndex?: number) {
  const prefix = cellIndex !== undefined ? `c${cellIndex} ` : ""
  const baseInfo = `${prefix}output=${a.output} item=${a.item} ${shortMime(a.mime)} ${formatBytes(a.bytes)}`

  const isTextLike =
    a.mime.startsWith("text/") ||
    a.mime === "application/json" ||
    a.mime === "application/vnd.code.notebook.stdout" ||
    a.mime === "application/vnd.code.notebook.stderr" ||
    a.mime === "application/vnd.code.notebook.error" ||
    shortMime(a.mime) === "datawrangler"

  if (isTextLike && a.text !== undefined && a.text.length <= 1024) {
    const isMultiLine = a.text.includes("\n")
    if (isMultiLine) {
      return `${baseInfo}\n<content>\n${a.text}\n</content>`
    } else {
      return `${baseInfo} ${JSON.stringify(a.text)}`
    }
  } else if (isTextLike) {
    const content = a.text !== undefined ? a.text.slice(0, 1024) : a.preview
    return `${baseInfo} -> ${artifactName(a.artifactPath)}\n<content>\n${content}\n... (truncated, full output in the file)\n</content>`
  } else {
    return `${baseInfo} -> ${artifactName(a.artifactPath)}${a.preview ? ` ${quoteForSummary(a.preview)}` : ""}`
  }
}

function artifactName(p: string) {
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
    return await notebookSource({ filePath: notebook.uri.toString(), cellIndex: cell.index })
  }
}

async function notebookSource(input: Record<string, unknown>) {
  const notebook = await resolveNotebook(stringProp(input, "filePath"))
  const limit = Math.max(1, Math.min(numberProp(input, "limit") ?? 1000, 1000))
  let offset = Math.max(1, numberProp(input, "offset") ?? 1)

  const { lines, cellRanges } = notebookSourceVirtualLines(notebook)
  const targetCellIndex = typeof input.cellIndex === "number" ? input.cellIndex : undefined

  let globalStart = 1
  let globalEnd = lines.length
  let warning = ""

  if (targetCellIndex !== undefined && cellRanges.has(targetCellIndex)) {
    const range = cellRanges.get(targetCellIndex)!
    if (input.offset !== undefined) {
      if (offset >= range.start && offset <= range.end) {
        globalStart = offset
      } else if (range.start + offset - 1 >= range.start && range.start + offset - 1 <= range.end) {
        globalStart = range.start + offset - 1
      } else {
        globalStart = range.start
        warning = "WARNING: Offset out of bounds for the specified cell! ALWAYS use GLOBAL document line numbers. Offset reset to default."
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

  globalStart = Math.max(1, Math.min(globalStart, lines.length > 0 ? lines.length : 1))

  let bytes = 0
  const maxBytes = 12 * 1024
  let cut = false
  const returnedLines: string[] = []
  let currentLineIndex = globalStart - 1

  while (currentLineIndex < globalEnd && currentLineIndex < lines.length && returnedLines.length < limit) {
    const line = lines[currentLineIndex]
    const lineBytes = Buffer.byteLength(line, "utf8")
    if (bytes + lineBytes > maxBytes && returnedLines.length > 0) {
      cut = true
      break
    }
    returnedLines.push(`${currentLineIndex + 1}: ${line}`)
    bytes += lineBytes
    currentLineIndex++
  }

  const more = currentLineIndex < globalEnd && currentLineIndex < lines.length

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
  const cellRanges = new Map<number, { start: number; end: number }>()

  for (const cell of notebook.getCells()) {
    const start = lines.length + 1
    const id = shortId(cellIdentifiers(cell)[0] ?? `cell-${cell.index}`)
    lines.push(`--- c${cell.index} ${cellKindLabel(cell.kind)}/${cell.document.languageId} id=${id} lines=${cell.document.lineCount} ---`)
    const sourceLines = cell.document.getText().split(/\r?\n/).map((line) =>
      line.length > 2000 ? line.substring(0, 2000) + "... (line truncated to 2000 chars)" : line
    )
    lines.push(...sourceLines)
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
  const code = cells.filter((cell) => cell.kind === "code")
  const executed = code.filter((cell) => cell.exec !== "not-run")
  const failed = code.filter((cell) => cell.exec.startsWith("fail"))
  const status = failed.length
    ? `${failed.length} failed`
    : executed.length === code.length && code.length > 0
      ? "All code cells executed successfully."
      : `${executed.length}/${code.length} code cells executed`
  return [
    `Notebook: ${toPosixPath(notebook.uri.fsPath || notebook.uri.toString())}`,
    `Type: ${notebook.notebookType}, dirty=${notebook.isDirty}, cells=${notebook.cellCount}, runtime=${runtimeLabel(notebook) ?? "unknown"}. ${status}`,
    "",
    'Cells (format: i id=<stable short cell id> <kind>/<lang> lines=<line count> exec="<run state: current-run/saved-output/not-run, order, status, duration, end time>" existing_outs="<current saved output MIME summary>" first="<first source line>"):',
    ...cells.map(
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
    id: shortId(cellIdentifiers(cell)[0] ?? `cell-${cell.index}`),
    kind: cell.kind === vscode.NotebookCellKind.Code ? "code" : "markdown",
    lang: cell.document.languageId,
    lines: cell.document.lineCount,
    exec: executionText(cell),
    existing_outs: existingOuts(cell),
    first: previewText((cell.document.getText().split("\n")[0] ?? "").trim()).slice(0, 120),
  }
}

function existingOuts(cell: vscode.NotebookCell) {
  return [...new Set(cell.outputs.flatMap((cellOutput) => cellOutput.items.map((item) => shortMime(item.mime))))]
}

function executionText(cell: vscode.NotebookCell) {
  const summary = cell.executionSummary
  if (!summary?.executionOrder && !summary?.timing) {
    if (cell.outputs.length === 0) {
      return "not-run"
    }
    const saved = savedExecution(cell)
    return `not-run but-saved-output #${saved.order} ${saved.status}${saved.duration}${saved.ended}`
  }
  const state = summary.timing ? "current-run" : "session-state"
  const status = summary.success === false ? "failed" : summary.success === true || cell.outputs.length > 0 ? "succeeded" : "unknown-status"
  const order = summary.executionOrder ?? "?"
  const duration = summary.timing ? ` ${Math.max(0, summary.timing.endTime - summary.timing.startTime)}ms` : " ?ms"
  const ended = summary.timing ? ` ended=${new Date(summary.timing.endTime).toISOString()}` : " ended=?"
  return `${state} #${order} ${status}${duration}${ended}`
}

function savedExecution(cell: vscode.NotebookCell) {
  const outputMetadata = cell.outputs.map((output) => output.metadata).filter(isRecord)
  const endedRaw = firstString(
    stringAt(cell.metadata, "execution_end_time"),
    stringAt(cell.metadata, "end_time"),
    ...outputMetadata.flatMap((metadata) => [
      stringAt(metadata, "execution_end_time"),
      stringAt(metadata, "end_time"),
      stringAt(metadata, "timestamp"),
    ]),
  )
  const startedRaw = firstString(
    stringAt(cell.metadata, "execution_start_time"),
    stringAt(cell.metadata, "start_time"),
    ...outputMetadata.flatMap((metadata) => [stringAt(metadata, "execution_start_time"), stringAt(metadata, "start_time")]),
  )
  const duration = durationText(startedRaw, endedRaw)
  return {
    order: numberAt(cell.metadata, "execution_count") ?? "?",
    status: existingOuts(cell).includes("error") ? "failed" : "succeeded",
    duration,
    ended: endedRaw ? ` ended=${formatDate(endedRaw)}` : " ended=?",
  }
}

function durationText(startedRaw?: string, endedRaw?: string) {
  if (!startedRaw || !endedRaw) {
    return " ?ms"
  }
  const started = Date.parse(startedRaw)
  const ended = Date.parse(endedRaw)
  if (!Number.isFinite(started) || !Number.isFinite(ended)) {
    return " ?ms"
  }
  return ` ${Math.max(0, ended - started)}ms`
}

function formatDate(input: string) {
  const value = Date.parse(input)
  return Number.isFinite(value) ? new Date(value).toISOString() : input
}

function firstString(...values: Array<string | undefined>) {
  return values.find((value) => value && value.trim())
}

function runtimeLabel(notebook: vscode.NotebookDocument) {
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
  return id.replace(/^#?VSC-/, "").replace(/^#/, "").slice(0, 8)
}

function extensionState(id: string) {
  const extension = vscode.extensions.getExtension(id)
  if (!extension) {
    return "missing"
  }
  return extension.isActive ? "active" : "installed"
}

function notebookInfo(notebook: vscode.NotebookDocument) {
  return {
    uri: notebook.uri.toString(),
    fsPath: notebook.uri.fsPath,
    notebookType: notebook.notebookType,
    version: notebook.version,
    isDirty: notebook.isDirty,
    isUntitled: notebook.isUntitled,
    cellCount: notebook.cellCount,
  }
}

function notebookRange(notebook: vscode.NotebookDocument, target: Record<string, unknown>, fallbackCellIndex?: number) {
  const type = stringProp(target, "type") ?? "cell"
  if (type === "all") {
    return new vscode.NotebookRange(0, notebook.cellCount)
  }
  if (type === "range") {
    const start = Math.max(0, numberProp(target, "start") ?? 0)
    const end = Math.min(notebook.cellCount, numberProp(target, "end") ?? start + 1)
    return new vscode.NotebookRange(start, Math.max(start + 1, end))
  }
  const index = Math.max(0, Math.min(notebook.cellCount - 1, numberProp(target, "cellIndex") ?? fallbackCellIndex ?? 0))
  return new vscode.NotebookRange(index, index + 1)
}

async function waitForNotebookExecution(notebook: vscode.NotebookDocument, range: vscode.NotebookRange, startedAt: number, timeoutMs: number) {
  const done = () =>
    notebook.getCells(range)
      .filter((cell) => cell.kind === vscode.NotebookCellKind.Code)
      .every((cell) => {
        const timing = cell.executionSummary?.timing
        return timing?.endTime !== undefined && timing.endTime >= startedAt
      })

  if (done()) {
    return true
  }

  return await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      subscription.dispose()
      resolve(false)
    }, timeoutMs)
    const subscription = vscode.workspace.onDidChangeNotebookDocument((event) => {
      if (event.notebook.uri.toString() !== notebook.uri.toString()) {
        return
      }
      if (!done()) {
        return
      }
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
  await vscode.workspace.fs.createDirectory(root)
  const filename = [
    path.basename(notebook.uri.fsPath || "untitled", path.extname(notebook.uri.fsPath || "untitled")),
    `cell-${cell.index}`,
    `output-${outputIndex}`,
    `item-${itemIndex}`,
  ].join("-") + extensionForMime(item.mime)
  const uri = vscode.Uri.joinPath(root, filename)
  await vscode.workspace.fs.writeFile(uri, item.data)
  return { uri, fsPath: uri.fsPath || uri.toString() }
}

function artifactRoot(notebook: vscode.NotebookDocument) {
  const folder = vscode.workspace.getWorkspaceFolder(notebook.uri) ?? vscode.workspace.workspaceFolders?.[0]
  if (!folder) {
    throw new Error("Notebook output artifacts require an open workspace folder")
  }
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
  return [
    cell.document.uri.fragment,
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
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function numberProp(record: Record<string, unknown>, key: string) {
  const value = record[key]
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function uriFromInput(input: string) {
  if (/^[a-zA-Z]:[\\/]/.test(input)) {
    return vscode.Uri.file(input)
  }
  if (input.startsWith("/")) {
    return vscode.Uri.file(input)
  }
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(input)) {
    return vscode.Uri.parse(input)
  }
  return vscode.Uri.file(input)
}

function fullDocumentRange(document: vscode.TextDocument) {
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
  if (typeof value === "string") return value
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    return value.join(eol)
  }
  return undefined
}

function cellKindFromInput(input: Record<string, unknown>, existing?: vscode.NotebookCell) {
  const kind = stringProp(input, "kind")
  const language = stringProp(input, "language")

  if (kind === "markdown" || language === "markdown") {
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
  if (language) return language
  if (kind === vscode.NotebookCellKind.Markup) return "markdown"
  return existing?.document.languageId ?? "python"
}

function cellKindLabel(kind: vscode.NotebookCellKind) {
  return kind === vscode.NotebookCellKind.Markup ? "markdown" : "code"
}

function stripCodeFence(source: string) {
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
