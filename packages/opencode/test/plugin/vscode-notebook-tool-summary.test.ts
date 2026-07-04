import { beforeEach, expect, mock, spyOn, test } from "bun:test"

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
// selectKernel 的返回值可被单个测试覆盖：默认 true（立即接受），
// 测试可设为永不结算的 promise 来模拟用户未交互的超时场景。
let selectKernelResult: unknown = true
// Keep extension activation injectable per test. Most notebook tests should see
// no Jupyter/Python extension, while restart/configure tests can provide only the
// public shape they need; this avoids a broad mock that would hide missing-env
// behavior exercised elsewhere in the file.
let extensionLookup = new Map<string, { isActive: boolean; packageJSON?: Record<string, unknown>; exports?: unknown; activate(): Promise<unknown> }>()
const notebookListeners = new Set<(event: { notebook: typeof activeNotebook; cellChanges: Array<{ cell: NotebookCell; executionSummary?: NotebookCell["executionSummary"] }> }) => void>()
const textListeners = new Set<(event: { document: NotebookCell["document"] }) => void>()

// The VS Code extension package does not expose a lightweight test harness, so
// this behavior test exercises the public bridge handlers through a minimal fake
// `vscode` module. The fake owns only stable API surface used by notebook tools;
// it intentionally avoids reaching into private helper functions.
mock.module("vscode", () => ({
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
      if (command === "notebook.selectKernel") return selectKernelResult
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
}))

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
  selectKernelResult = true
  extensionLookup = new Map()
  notebookListeners.clear()
  textListeners.clear()
})

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

test("source rejects stale cell IDs instead of reading a different notebook range", async () => {
  await expect(notebookSource({ filePath: notebookPath, cellId: "#VSC-deadbeef", offset: 1, limit: 5 })).rejects.toThrow("Notebook cell not found")
})

test("edit rejects empty source arrays before they can clear a notebook cell", async () => {
  // Empty arrays are valid JSON but ambiguous notebook-edit intent. The public
  // behavior should reject them before any document mutation, preserving the
  // existing explicit-empty-string path for callers that really want to clear a
  // cell.
  await expect(editNotebook({ filePath: notebookPath, cellId: cellFragment(2), editType: "edit", newCode: [] })).rejects.toThrow("newCode cannot be an empty array")
})

test("language-only edit preserves source and returns the replacement cell ID", async () => {
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
})

test("language-only edit changes kind even when the language ID already matches", async () => {
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
})

test("string edit preserves CRLF notebook cell content around the replacement", async () => {
  const cell = activeNotebook.cellAt(1)
  cell.document.eol = EndOfLine.CRLF
  cell.document.setText("alpha\r\nbeta\r\ngamma")

  const result = await editNotebook({ filePath: notebookPath, cellId: cellFragment(2), editType: "edit", oldCode: "beta", newCode: "BETA" })

  expect((result.data as Record<string, unknown>).afterSource).toBe("alpha\r\nBETA\r\ngamma")
  expect(cell.document.getText()).toBe("alpha\r\nBETA\r\ngamma")
})

test("source includes a bounded preview for a single oversized source line", async () => {
  activeNotebook.cellAt(1).document.setText(`visible-prefix-${"x".repeat(20_000)}-hidden-suffix`)

  const result = await notebookSource({ filePath: notebookPath, cellId: cellFragment(2), limit: 5 })

  expect((result.data as Record<string, unknown>).returned).toBe(1)
  expect(result.summary).toContain("visible-prefix")
  expect(result.summary).not.toContain("hidden-suffix")
  expect(result.summary).not.toContain("Use offset=0")
})

test("source does not consume a normal line that only overflows the current page", async () => {
  const secondLine = `second-line-fits-next-page-${"y".repeat(600)}`
  activeNotebook.cellAt(1).document.setText(`${"x".repeat(15_900)}\n${secondLine}`)

  const firstPage = await notebookSource({ filePath: notebookPath, cellId: cellFragment(2), limit: 10 })
  const secondPage = await notebookSource({ filePath: notebookPath, cellId: cellFragment(2), offset: 5, limit: 10 })

  expect((firstPage.data as Record<string, unknown>).returned).toBe(1)
  expect(firstPage.summary).not.toContain(secondLine)
  expect(firstPage.summary).toContain("Use offset=5")
  expect(secondPage.summary).toContain(secondLine)
})

test("restart can invoke a Jupyter command that is hidden from the public command list", async () => {
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
})

test("insert result identifies the inserted cell ID before reporting shifted cells", async () => {
  const result = await editNotebook({ filePath: notebookPath, cellId: cellFragment(1), editType: "insert", newCode: "value = 1", language: "python" })
  const data = result.data as Record<string, unknown>
  const insertedCellId = data.insertedCellId

  expect(typeof insertedCellId).toBe("string")
  expect(result.summary).toContain(`Inserted: c2 id=${insertedCellId}`)
  expect(result.summary.indexOf("Inserted:")).toBeLessThan(result.summary.indexOf("Shifted:"))
})

// ---------------------------------------------------------------------------
// after-source 预览：edit 响应摘要必须包含足够多的 after-source 行，
// 让 agent 能精确复制作为下一次 edit 的 oldCode，避免模型重建字符漂移。
// ---------------------------------------------------------------------------

test("string-match edit summary includes after-source preview for the next oldCode anchor", async () => {
  activeNotebook.cellAt(1).document.setText("line_a\nline_b\nline_c\nline_d")
  // 对 cell 2 做局部替换：line_b → line_B，cell 其余行保持不变
  const result = await editNotebook({ filePath: notebookPath, cellId: cellFragment(2), editType: "edit", oldCode: "line_b", newCode: "line_B" })
  // after-source 预览必须包含 cell 的完整首行，让 agent 知道 cell 当前从哪行开始
  expect(result.summary).toContain("AfterSource")
  expect(result.summary).toContain("line_a")
  expect(result.summary).toContain("line_B")
  expect(result.summary).toContain("line_c")
})

test("full-cell replace edit summary includes after-source preview of the new content", async () => {
  // full-cell replace（不传 oldCode）后 agent 需要知道 cell 的完整新内容
  const result = await editNotebook({ filePath: notebookPath, cellId: cellFragment(2), editType: "edit", newCode: "new_alpha\nnew_beta\nnew_gamma" })
  expect(result.summary).toContain("AfterSource")
  expect(result.summary).toContain("new_alpha")
  expect(result.summary).toContain("new_gamma")
})

test("delete edit summary does not include after-source preview", async () => {
  // delete 后 cell 内容为空，AfterSource 没有意义且会误导 agent
  const result = await editNotebook({ filePath: notebookPath, cellId: cellFragment(2), editType: "delete" })
  expect(result.summary).not.toContain("AfterSource")
})

test("after-source preview is bounded to ten lines with a truncation indicator", async () => {
  // 超过 10 行的 cell 只显示前 10 行，避免 edit 摘要膨胀
  const lines = Array.from({ length: 15 }, (_, i) => `row_${i + 1}`)
  activeNotebook.cellAt(1).document.setText(lines.join("\n"))
  const result = await editNotebook({ filePath: notebookPath, cellId: cellFragment(2), editType: "edit", newCode: "replaced_first\n" + lines.slice(1).join("\n") })
  expect(result.summary).toContain("AfterSource")
  expect(result.summary).toContain("row_10")
  // 第 11~15 行不应出现在预览中
  expect(result.summary).not.toContain("row_15")
  expect(result.summary).toContain("more lines")
})

// ---------------------------------------------------------------------------
// 非字符串数组检测：agent 偶尔会把结构化对象数组传给 oldCode/newCode，
// sourceProp 静默返回 undefined 会导致 "newCode is required" 误导性错误，
// 或 oldCode 被忽略后静默执行 full-cell replacement 造成数据丢失。
// ---------------------------------------------------------------------------

test("edit rejects non-string items in newCode array with a clear type error", async () => {
  await expect(
    editNotebook({ filePath: notebookPath, cellId: cellFragment(2), editType: "edit", newCode: [{ key: "val" }] as unknown as string[] }),
  ).rejects.toThrow("must be a string or an array of strings")
})

test("edit rejects non-string items in oldCode array before any cell mutation", async () => {
  // oldCode 含非字符串项时必须在 notebook 变更前抛出，防止静默 full-cell replace
  await expect(
    editNotebook({ filePath: notebookPath, cellId: cellFragment(2), editType: "edit", oldCode: [1, 2] as unknown as string[], newCode: "print('safe')" }),
  ).rejects.toThrow("must be a string or an array of strings")
  // cell 内容未被修改
  expect(activeNotebook.cellAt(1).document.getText()).toBe("print('ready')")
})

test("edit still accepts empty-string oldCode for full-cell replacement", async () => {
  // oldCode: "" 是 falsy，历史上有 45 次成功使用此模式做 full-cell replacement；
  // 非字符串数组检测不能破坏此兼容路径
  const result = await editNotebook({ filePath: notebookPath, cellId: cellFragment(2), editType: "edit", oldCode: "", newCode: "print('replaced')" })
  expect((result.data as Record<string, unknown>).applied).toBe(true)
  expect(activeNotebook.cellAt(1).document.getText()).toBe("print('replaced')")
})

// ---------------------------------------------------------------------------
// source 自动扩展 limit：指定 cellId 但不传 limit 时，应返回整个 cell 内容
// （上限 1000 行），避免 agent 分页读取后 oldCode 跨越页面边界。
// ---------------------------------------------------------------------------

test("source returns full cell content when cellId is specified without explicit limit", async () => {
  // 创建一个超过默认 limit(400) 行的 cell，验证不传 limit 时能一次返回全部
  const bigLines = Array.from({ length: 450 }, (_, i) => `big_line_${i + 1}`)
  activeNotebook.cellAt(1).document.setText(bigLines.join("\n"))
  const result = await notebookSource({ filePath: notebookPath, cellId: cellFragment(2) })
  // 返回的行数应覆盖整个 cell（450 行），而非被默认 limit 400 截断
  expect((result.data as Record<string, unknown>).returned).toBe(450)
  expect(result.summary).toContain("big_line_450")
  expect(result.summary).not.toContain("Use offset=")
})

// ---------------------------------------------------------------------------
// configure 超时：selectKernel 打开内核选择器 UI 后可能无限期阻塞，
// 服务端需在 15s 内超时并返回 selection-requested，让 agent 继续工作。
// ---------------------------------------------------------------------------

test("configure returns selection-requested when selectKernel does not resolve in time", async () => {
  // 模拟用户未交互：selectKernel 返回永不结算的 promise
  selectKernelResult = new Promise(() => {})
  // 安装 Jupyter 扩展以满足 configure 前置条件；getKernel 返回 undefined
  // 表示尚无活跃内核，configure 会继续调用 selectKernel
  extensionLookup.set("ms-toolsai.jupyter", {
    isActive: true,
    packageJSON: { version: "test" },
    exports: { kernels: { getKernel: async () => undefined } },
    async activate() { this.isActive = true; return this.exports },
  })
  // 加速测试：将 >=10s 的 setTimeout 回调立即执行，模拟 selectKernel 超时
  const originalSetTimeout = globalThis.setTimeout
  spyOn(globalThis, "setTimeout").mockImplementation(((cb: Function, delay?: number) => {
    if (delay !== undefined && delay >= 10_000) { cb(); return 0 as never }
    return originalSetTimeout(cb as TimerHandler, delay) as never
  }) as never)

  const result = await notebookEnv({ filePath: notebookPath, operation: "configure" })

  mock.restore()
  // 超时后应返回 selection-requested，而非阻塞或失败
  const data = result.data as Record<string, unknown>
  expect(data.status).toBe("selection-requested")
  expect(result.summary).toContain("selection-requested")
})

test("configure returns configured when selectKernel immediately accepts and kernel is active", async () => {
  // 正常路径：selectKernel 立即返回 true，且内核已活跃
  selectKernelResult = true
  extensionLookup.set("ms-toolsai.jupyter", {
    isActive: true,
    packageJSON: { version: "test" },
    exports: {
      kernels: {
        getKernel: async () => ({
          language: "python",
          status: "idle",
          async *executeCode(_code: string, _token: unknown) {
            yield { items: [{ mime: "text/plain", data: new TextEncoder().encode("__OPENCODE_RUNTIME_PROBE_START__\n{\"language\":\"python\"}\n__OPENCODE_RUNTIME_PROBE_END__") }] }
          },
        }),
      },
    },
    async activate() { this.isActive = true; return this.exports },
  })

  const result = await notebookEnv({ filePath: notebookPath, operation: "configure" })
  const data = result.data as Record<string, unknown>
  expect(data.status).toBe("configured")
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
