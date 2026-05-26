import { beforeEach, expect, mock, test } from "bun:test"

const NotebookCellKind = { Markup: 1, Code: 2 } as const
const EndOfLine = { LF: 1, CRLF: 2 } as const
const notebookPath = "/tmp/notebook tool demo.ipynb"

let activeNotebook: ReturnType<typeof createNotebook>
let cellSequence = 0
let executionOrder = 0
const notebookListeners = new Set<(event: { notebook: typeof activeNotebook; cellChanges: Array<{ cell: NotebookCell; executionSummary?: NotebookCell["executionSummary"] }> }) => void>()
const textListeners = new Set<(event: { document: NotebookCell["document"] }) => void>()

// 仅替换VS Code公开API以调用真实处理器，不启动扩展或内核，也不直接测试私有辅助函数。
const vscode = {
  NotebookCellKind,
  EndOfLine,
  ConfigurationTarget: { Global: 1 },
  NotebookRange: class {
    constructor(readonly start: number, readonly end: number) {}
  },
  NotebookCellData: class {
    metadata?: Record<string, unknown>
    constructor(readonly kind: number, readonly value: string, readonly languageId: string) {}
  },
  NotebookEdit: {
    replaceCells: (range: { start: number; end: number }, cells: Array<{ kind: number; value: string; languageId: string }>) => ({ type: "replace", range, cells }),
    deleteCells: (range: { start: number; end: number }) => ({ type: "delete", range }),
  },
  WorkspaceEdit: class {
    readonly entries: Array<Record<string, unknown>> = []
    set(uri: UriLike, edits: unknown[]) {
      this.entries.push({ type: "notebook", uri, edits })
    }
    replace(uri: UriLike, range: unknown, text: string) {
      this.entries.push({ type: "text", uri, range, text })
    }
  },
  Position: class {
    constructor(readonly line: number, readonly character: number) {}
  },
  Range: class {
    constructor(readonly start: unknown, readonly end: unknown) {}
  },
  Uri: {
    file: (value: string) => createUri(value),
    parse: (value: string) => createUri(value.replace(/^file:\/\//, "")),
    joinPath: (base: UriLike, ...parts: string[]) => createUri([base.fsPath, ...parts].join("/").replace(/\/+/g, "/")),
  },
  workspace: {
    notebookDocuments: [] as Array<typeof activeNotebook>,
    workspaceFolders: [{ uri: createUri("/tmp") }],
    fs: {
      createDirectory: async () => undefined,
      writeFile: async () => undefined,
      readFile: async () => new Uint8Array(),
    },
    getWorkspaceFolder: () => ({ uri: createUri("/tmp") }),
    openNotebookDocument: async () => activeNotebook,
    // #234：notebook 内存 fake 的 executeCode 仅用于 info 探测路径
    applyEdit: async (edit: { entries: Array<Record<string, unknown>> }) => applyEdit(edit.entries),
    onDidChangeNotebookDocument: (listener: (event: { notebook: typeof activeNotebook; cellChanges: Array<{ cell: NotebookCell; executionSummary?: NotebookCell["executionSummary"] }> }) => void) => {
      notebookListeners.add(listener)
      return { dispose: () => notebookListeners.delete(listener) }
    },
    onDidChangeTextDocument: (listener: (event: { document: NotebookCell["document"] }) => void) => {
      textListeners.add(listener)
      return { dispose: () => textListeners.delete(listener) }
    },
    getConfiguration: () => ({
      get: () => false,
      update: async () => undefined,
    }),
  },
  window: {
    activeNotebookEditor: undefined as NotebookEditor | undefined,
    visibleNotebookEditors: [] as NotebookEditor[],
    showNotebookDocument: async (notebook: typeof activeNotebook, options?: { selections?: Array<{ start: number; end: number }> }) => {
      const editor: NotebookEditor = {
        notebook,
        selection: options?.selections?.[0] ?? { start: 0, end: 1 },
        revealRange: () => undefined,
      }
      vscodeMock.window.activeNotebookEditor = editor
      vscodeMock.window.visibleNotebookEditors = [editor]
      return editor
    },
  },
  commands: {
    getCommands: async () => ["notebook.cell.execute", "jupyter.restartkernel", "notebook.selectKernel"],
    executeCommand: async (command: string) => {
      if (command === "notebook.cell.execute") executeSelectedCell()
      if (command === "notebook.selectKernel") return true
      return undefined
    },
  },
  extensions: {
    getExtension: () => undefined,
  },
  CancellationTokenSource: class {
    readonly token = {}
    cancel() {}
    dispose() {}
  },
}
mock.module("vscode", () => ({ default: vscode, ...vscode }))

const vscodeModule = "vscode"
const vscodeMock = (await import(vscodeModule)) as {
  workspace: { notebookDocuments: Array<typeof activeNotebook> }
  window: { activeNotebookEditor?: NotebookEditor; visibleNotebookEditors: NotebookEditor[] }
}
const { notebookSummary } = (await import(sdkNotebookUrl("summary"))) as { notebookSummary: (filePath: string) => Promise<ToolResult> }
const { notebookSource } = (await import(sdkNotebookUrl("source"))) as { notebookSource: (input: Record<string, unknown>) => Promise<ToolResult> }
const { editNotebook } = (await import(sdkNotebookUrl("edit"))) as { editNotebook: (input: Record<string, unknown>) => Promise<ToolResult> }
const { runNotebook } = (await import(sdkNotebookUrl("run"))) as { runNotebook: (input: Record<string, unknown>) => Promise<ToolResult> }
const { readNotebookCellOutput } = (await import(sdkNotebookUrl("output"))) as {
  readNotebookCellOutput: (filePath: string, index?: number, cellId?: string) => Promise<ToolResult>
}
const { notebookEnv } = (await import(sdkNotebookUrl("env"))) as { notebookEnv: (input: Record<string, unknown>) => Promise<ToolResult> }

beforeEach(() => {
  cellSequence = 0
  executionOrder = 0
  activeNotebook = createNotebook()
  vscodeMock.workspace.notebookDocuments = [activeNotebook]
  vscodeMock.window.activeNotebookEditor = undefined
  vscodeMock.window.visibleNotebookEditors = []
  notebookListeners.clear()
  textListeners.clear()
})

// #234：头部不变量是 234 的核心契约——所有工具 summary 第二行必须携带 target
// #234：本测试以 source/output/env 三家抽样验证，字段缺失即回归
test("notebook tools expose a consistent Notebook plus tool header before details", async () => {
  const summary = await notebookSummary(notebookPath)
  await expectHeader(summary, "Summary")
  expect(summary.summary).toContain("Fields: cN is 1-based display position")
  expect(summary.summary).not.toContain("Conventions:")

  const source = await notebookSource({ filePath: notebookPath, cellId: cellFragment(1), limit: 5 })
  await expectHeader(source, "Source")
  expect(source.summary.split("\n")[1]).toContain("target=")

  await expectHeader(await editNotebook({ filePath: notebookPath, cellId: cellFragment(1), editType: "insert", newCode: "value = 1", language: "python" }), "Edit")
  await expectHeader(await runNotebook({ filePath: notebookPath, cellId: cellFragment(2), timeoutMs: 1_000 }), "Run")

  const output = await readNotebookCellOutput(notebookPath, undefined, cellFragment(2))
  await expectHeader(output, "Output")
  expect(output.summary.split("\n")[1]).toContain("target=")
  expect(output.summary.split("\n")[1]).toContain("dirty=true")
  expect(output.summary.split("\n")[1]).toContain("runtime=")

  const env = await notebookEnv({ filePath: notebookPath, operation: "info" })
  await expectHeader(env, "Env")
  expect(env.summary.split("\n")[1]).toContain("target=notebook")
  expect(env.summary.split("\n")[1]).toContain("dirty=true")
  expect(env.summary.split("\n")[1]).toContain("runtime=")
})

// #234：stale id 必须抛错而不是静默回退——回退会让模型误读无关源码
// #234：resolveNotebookCell 的失败语义被 source 直接透传，此处验证硬失败
test("source rejects stale cell IDs instead of reading a different notebook range", async () => {
  await expect(notebookSource({ filePath: notebookPath, cellId: "#VSC-deadbeef", offset: 1, limit: 5 })).rejects.toThrow("Notebook cell not found")
})

// #234：insert 结果的 insertedCellId 是模型后续 run/source 的直接输入
// #234：Shifted 行不能与 Inserted 行混淆——两者语义完全不同
test("insert result identifies the inserted cell ID before reporting shifted cells", async () => {
  const result = await editNotebook({ filePath: notebookPath, cellId: cellFragment(1), editType: "insert", newCode: "value = 1", language: "python" })
  const data = result.data as Record<string, unknown>
  const insertedCellId = data.insertedCellId

  expect(typeof insertedCellId).toBe("string")
  expect(result.summary).toContain(`Inserted: c2 id=${insertedCellId}`)
  expect(result.summary.indexOf("Inserted:")).toBeLessThan(result.summary.indexOf("Shifted:"))
})

async function expectHeader(result: { summary: string }, label: string) {
  const lines = result.summary.split("\n")
  expect(lines[0]).toBe(`Notebook: ${notebookPath}`)
  expect(lines[1].startsWith(`${label}: `)).toBe(true)
}

function cellFragment(index: number) {
  return activeNotebook.cellAt(index - 1).document.uri.fragment
}

function sdkNotebookUrl(module: string) {
  return new URL(`../../../../sdks/vscode/src/notebook/${module}.ts`, import.meta.url).href
}

function createNotebook() {
  const notebook = {
    uri: createUri(notebookPath),
    notebookType: "jupyter-notebook",
    metadata: { kernelspec: { display_name: "Python 3.11" }, language_info: { name: "python", version: "3.11" } },
    isDirty: true,
    isUntitled: false,
    isClosed: false,
    version: 1,
    cells: [] as NotebookCell[],
    get cellCount() {
      return this.cells.length
    },
    getCells() {
      return this.cells
    },
    cellAt(index: number) {
      return this.cells[index]
    },
    async save() {
      this.isDirty = false
      this.version++
      return true
    },
  }
  notebook.cells = [
    createCell(notebook, NotebookCellKind.Markup, "markdown", "# Demo\n\nIntro"),
    createCell(notebook, NotebookCellKind.Code, "python", "print('ready')", [{ mime: "application/vnd.code.notebook.stdout", text: "ready\n" }]),
  ]
  updateIndexes(notebook)
  return notebook
}

function createCell(notebook: ReturnType<typeof createNotebook>, kind: number, languageId: string, text: string, outputs: Array<{ mime: string; text: string }> = []): NotebookCell {
  const fragment = `cell-${++cellSequence}`
  const document = createDocument(`${notebookPath}#${fragment}`, fragment, languageId, text)
  return {
    index: 0,
    notebook,
    kind,
    document,
    metadata: {},
    outputs: outputs.map((output, outputIndex) => ({
      metadata: {},
      items: [{ mime: output.mime, data: new TextEncoder().encode(output.text) }],
      outputIndex,
    })),
    executionSummary: outputs.length ? { executionOrder: ++executionOrder, success: true, timing: { startTime: 1, endTime: 2 } } : undefined,
  }
}

function createDocument(value: string, fragment: string, languageId: string, text: string) {
  return {
    uri: createUri(value, fragment),
    languageId,
    eol: EndOfLine.LF,
    version: 1,
    get lineCount() {
      return this.getText().split("\n").length
    },
    getText: () => text,
    setText(next: string) {
      text = next
      this.version++
    },
    lineAt(index: number) {
      return { text: text.split("\n")[index] ?? "", range: { end: {} } }
    },
  }
}

function createUri(value: string, fragment = ""): UriLike {
  return {
    fsPath: value.split("#")[0],
    fragment,
    toString: () => `file://${value}`,
  }
}

// #234：fake 只实现工具用到的稳定 API——索引按 entries 顺序推进
// #234：与真实 WorkspaceEdit 的 cellAt 后序语义保持一致
function applyEdit(entries: Array<Record<string, unknown>>) {
  for (const entry of entries) {
    if (entry.type === "notebook") {
      for (const edit of entry.edits as Array<{ type: string; range: { start: number; end: number }; cells?: Array<{ kind: number; value: string; languageId: string }> }>) {
        if (edit.type === "delete") activeNotebook.cells.splice(edit.range.start, edit.range.end - edit.range.start)
        if (edit.type === "replace") activeNotebook.cells.splice(edit.range.start, edit.range.end - edit.range.start, ...(edit.cells ?? []).map((cell) => createCell(activeNotebook, cell.kind, cell.languageId, cell.value)))
      }
      activeNotebook.version++
      activeNotebook.isDirty = true
      updateIndexes(activeNotebook)
    }
    if (entry.type === "text") {
      const document = activeNotebook.cells.map((cell) => cell.document).find((item) => item.uri.toString() === (entry.uri as UriLike).toString())
      document?.setText(String(entry.text))
      for (const listener of textListeners) if (document) listener({ document })
    }
  }
  return true
}

function updateIndexes(notebook: ReturnType<typeof createNotebook>) {
  notebook.cells.forEach((cell, index) => {
    cell.index = index
  })
}

function executeSelectedCell() {
  const index = vscodeMock.window.activeNotebookEditor?.selection.start ?? 0
  const cell = activeNotebook.cellAt(index)
  cell.executionSummary = { executionOrder: ++executionOrder, success: true, timing: { startTime: 10, endTime: 12 } }
  for (const listener of notebookListeners) listener({ notebook: activeNotebook, cellChanges: [{ cell, executionSummary: cell.executionSummary }] })
}

type UriLike = { fsPath: string; fragment: string; toString(): string }
type ToolResult = { summary: string; data?: unknown }
type NotebookEditor = { notebook: typeof activeNotebook; selection: { start: number; end: number }; revealRange(range: { start: number; end: number }): void }
type NotebookCell = {
  index: number
  notebook: ReturnType<typeof createNotebook>
  kind: number
  document: ReturnType<typeof createDocument>
  metadata: Record<string, unknown>
  outputs: Array<{ metadata: Record<string, unknown>; items: Array<{ mime: string; data: Uint8Array }>; outputIndex: number }>
  executionSummary?: { executionOrder?: number; success?: boolean; timing?: { startTime: number; endTime: number } }
}
