import { beforeEach, expect, mock, test } from "bun:test"

const NotebookCellKind = { Markup: 1, Code: 2 } as const
const EndOfLine = { LF: 1, CRLF: 2 } as const
const notebookPath = "/tmp/notebook tool demo.ipynb"

let activeNotebook: ReturnType<typeof createNotebook>
let cellSequence = 0
let executionOrder = 0
// The fake VS Code command registry intentionally separates public commands
// (`getCommands(true)`) from the full extension-host surface (`getCommands(false)`).
// Jupyter contributes some commands as hidden/internal commands, so this fixture
// must preserve that distinction to catch restart regressions without depending
// on a real VS Code extension host.
let commandLists = {
  public: ["notebook.cell.execute", "jupyter.restartkernel", "notebook.selectKernel"],
  all: ["notebook.cell.execute", "jupyter.restartkernel", "notebook.selectKernel"],
}
let executedCommands: string[] = []
// Keep extension activation injectable per test. Most notebook tests should see
// no Jupyter/Python extension, while restart/configure tests can provide only the
// public shape they need; this avoids a broad mock that would hide missing-env
// behavior exercised elsewhere in the file.
let extensionLookup = new Map<string, { isActive: boolean; packageJSON?: Record<string, unknown>; exports?: unknown; activate(): Promise<unknown> }>()
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
    getCommands: async (filterInternal = false) => filterInternal ? commandLists.public : commandLists.all,
    executeCommand: async (command: string) => {
      executedCommands.push(command)
      if (command === "notebook.cell.execute") executeSelectedCell()
      if (command === "notebook.selectKernel") return true
      return undefined
    },
  },
  extensions: {
    getExtension: (id: string) => extensionLookup.get(id),
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
  commandLists = {
    public: ["notebook.cell.execute", "jupyter.restartkernel", "notebook.selectKernel"],
    all: ["notebook.cell.execute", "jupyter.restartkernel", "notebook.selectKernel"],
  }
  executedCommands = []
  extensionLookup = new Map()
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
test("edit rejects empty source arrays before they can clear a notebook cell", async () => {
  // #252：空数组是合法 JSON 但歧义的编辑意图——在文档变更前拒绝，保留显式空串清空路径
  // Empty arrays are valid JSON but ambiguous notebook-edit intent. The public
  // behavior should reject them before any document mutation, preserving the
  // existing explicit-empty-string path for callers that really want to clear a
  // cell.
  await expect(editNotebook({ filePath: notebookPath, cellId: cellFragment(2), editType: "edit", newCode: [] })).rejects.toThrow("newCode cannot be an empty array")
  // #252：错误消息必须点名字段并给出两条出路，调用方才能自行纠正意图
})

test("language-only edit preserves source and returns the replacement cell ID", async () => {
  // #252：language-only 契约的完整链路——源保持不变、旧句柄失效、新句柄可用且 kind 变 Markup
  const beforeSource = activeNotebook.cellAt(1).document.getText()
  const oldCellId = cellFragment(2)
  const result = await editNotebook({ filePath: notebookPath, cellId: oldCellId, editType: "edit", language: "markdown" })
  const updatedCellId = (result.data as Record<string, unknown>).updatedCellId

  expect(typeof updatedCellId).toBe("string")
  expect(updatedCellId).not.toBe(oldCellId)
  await expect(notebookSource({ filePath: notebookPath, cellId: oldCellId })).rejects.toThrow("Notebook cell not found")
  const source = await notebookSource({ filePath: notebookPath, cellId: updatedCellId })
  expect(source.summary).toContain(beforeSource)
  expect(activeNotebook.cellAt(1).kind).toBe(NotebookCellKind.Markup)
  expect(activeNotebook.cellAt(1).document.languageId).toBe("markdown")
  // #252：source 保持不变是「language-only 不破坏内容」的核心用户可见承诺
})

test("language-only edit changes kind even when the language ID already matches", async () => {
  // #252：混合态回归——languageId 已匹配不代表 kind 匹配，编辑仍需触发 kind 转换
  // A code cell can report languageId="markdown" while still being a code cell.
  // The language-only edit contract is about the notebook cell kind as well as
  // languageId, so this regression test keeps that mixed-state boundary covered.
  activeNotebook.cells.push(createCell(activeNotebook, NotebookCellKind.Code, "markdown", "# markdown stored as code"))
  updateIndexes(activeNotebook)

  const result = await editNotebook({ filePath: notebookPath, cellId: cellFragment(3), editType: "edit", language: "markdown" })
  const updatedCellId = (result.data as Record<string, unknown>).updatedCellId
  const source = await notebookSource({ filePath: notebookPath, cellId: updatedCellId })

  expect(activeNotebook.cellAt(2).kind).toBe(NotebookCellKind.Markup)
  expect(source.summary).toContain("# markdown stored as code")
  // #252：kind 转换后原文本必须原样保留——转换不是重建
})

test("string edit preserves CRLF notebook cell content around the replacement", async () => {
  // #252：CRLF cell 的坐标不变量——替换后 EOL 保持 CRLF 且相邻行不被偏移损坏
  const cell = activeNotebook.cellAt(1)
  cell.document.eol = EndOfLine.CRLF
  cell.document.setText("alpha\r\nbeta\r\ngamma")

  const result = await editNotebook({ filePath: notebookPath, cellId: cellFragment(2), editType: "edit", oldCode: "beta", newCode: "BETA" })

  expect((result.data as Record<string, unknown>).afterSource).toBe("alpha\r\nBETA\r\ngamma")
  expect(cell.document.getText()).toBe("alpha\r\nBETA\r\ngamma")
  // #252：文档级 EOL 不变量与返回的 afterSource 双重锁定，防止实现只修一层
})

test("source includes a bounded preview for a single oversized source line", async () => {
  // #252：单行超整页预算时必须有界预览——无锚点会诱发 offset=0 这类非法分页
  activeNotebook.cellAt(1).document.setText(`visible-prefix-${"x".repeat(20_000)}-hidden-suffix`)

  const result = await notebookSource({ filePath: notebookPath, cellId: cellFragment(2), limit: 5 })

  expect((result.data as Record<string, unknown>).returned).toBe(1)
  // #252：returned=1 锁定「只渲染超长行自身」——隐式吞掉下一行即失败
  expect(result.summary).toContain("visible-prefix")
  expect(result.summary).not.toContain("hidden-suffix")
  expect(result.summary).not.toContain("Use offset=0")
  // #252：合法分页提示不得指向不存在的 offset=0——有界预览同时修复提示有效性
})

test("source does not consume a normal line that only overflows the current page", async () => {
  // #252：分页按虚拟源行推进——当前页放不下的整行必须留给下一页而非截断吞掉
  const secondLine = `second-line-fits-next-page-${"y".repeat(600)}`
  activeNotebook.cellAt(1).document.setText(`${"x".repeat(15_900)}\n${secondLine}`)

  const firstPage = await notebookSource({ filePath: notebookPath, cellId: cellFragment(2), limit: 10 })
  const secondPage = await notebookSource({ filePath: notebookPath, cellId: cellFragment(2), offset: 5, limit: 10 })

  expect((firstPage.data as Record<string, unknown>).returned).toBe(1)
  expect(firstPage.summary).not.toContain(secondLine)
  expect(firstPage.summary).toContain("Use offset=5")
  expect(secondPage.summary).toContain(secondLine)
  // #252：被换页保留的行必须在下一页完整出现——「不吞行」的正反两面都要锁
})

test("restart can invoke a Jupyter command that is hidden from the public command list", async () => {
  // #252：隐藏命令可执行性回归——restart 的门禁检查面必须与 executeCommand 的可调用面一致
  // VS Code exposes hidden commands to extensions through getCommands(false).
  // The restart tool should use that full surface because executeCommand can
  // still invoke Jupyter's restart command even when it is absent from the
  // public command-palette list.
  commandLists = {
    public: ["notebook.cell.execute", "notebook.selectKernel"],
    all: ["notebook.cell.execute", "notebook.selectKernel", "jupyter.restartkernel"],
  }
  extensionLookup.set("ms-toolsai.jupyter", {
    isActive: true,
    packageJSON: { version: "test" },
    exports: {},
    async activate() {
      this.isActive = true
      return this.exports
    },
  })

  const result = await notebookEnv({ filePath: notebookPath, operation: "restart" })

  expect((result.data as Record<string, unknown>).requested).toBe(true)
  expect(executedCommands).toContain("jupyter.restartkernel")
  // #252：requested=true 不够——命令必须真的被执行，才证明检查面与执行面一致
})

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
    eol: EndOfLine.LF as number,
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
    scheme: "file",
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

type UriLike = { fsPath: string; fragment: string; scheme: string; toString(): string }
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
