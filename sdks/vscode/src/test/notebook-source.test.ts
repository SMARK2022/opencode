import { doesNotMatch, equal, match } from "node:assert/strict"
import { test } from "mocha"
import vscode from "vscode"
import { copilotLikeCellId } from "../notebook/format"
import { notebookSource } from "../notebook/source"

test("distinguishes source-line pages from UTF-8 byte truncation", async () => {
  const serializer = vscode.workspace.registerNotebookSerializer("opencode-source-test", {
    deserializeNotebook() {
      return new vscode.NotebookData([])
    },
    serializeNotebook() {
      return new Uint8Array()
    },
  })
  try {
    const notebook = await vscode.workspace.openNotebookDocument(
      "opencode-source-test",
      new vscode.NotebookData([
        new vscode.NotebookCellData(vscode.NotebookCellKind.Code, "alpha\nbeta", "python"),
        new vscode.NotebookCellData(vscode.NotebookCellKind.Markup, "gamma\ndelta", "markdown"),
        new vscode.NotebookCellData(vscode.NotebookCellKind.Code, "\u754c".repeat(9 * 1024) + "\ntail", "python"),
      ]),
    )
    const filePath = notebook.uri.toString()
    const version = notebook.version
    const first = await notebookSource({ filePath, limit: 1 })
    equal(first.data.returned, 1)
    equal(first.data.truncated, true)
    match(first.summary, /^1: alpha$/m)
    match(first.summary, /Use offset=2/)
    doesNotMatch(first.summary, /Output capped|--: --- c2/)

    const across = await notebookSource({ filePath, offset: 2, limit: 3 })
    equal(across.data.returned, 3)
    equal(across.data.truncated, true)
    match(across.summary, /^2: beta$/m)
    match(across.summary, /^3: gamma$/m)
    match(across.summary, /^4: delta$/m)
    match(across.summary, /Use offset=5/)
    doesNotMatch(across.summary, /Output capped|--: --- c3/)

    const target = await notebookSource({
      filePath,
      cellId: copilotLikeCellId(notebook.cellAt(1)),
      limit: 2,
    })
    equal(target.data.returned, 2)
    equal(target.data.truncated, false)
    match(target.summary, /^3: gamma$/m)
    match(target.summary, /^4: delta$/m)
    doesNotMatch(target.summary, /Output capped|Use offset=/)

    // UTF-8 超预算只省略整行，首条超长正文仍必须返回以推进 offset。
    const bytes = await notebookSource({ filePath, limit: 400 })
    equal(bytes.data.returned, 4)
    equal(bytes.data.truncated, true)
    match(bytes.summary, /Output capped at 24 KB/)
    match(bytes.summary, /Use offset=5/)
    doesNotMatch(bytes.summary, /^5:/m)

    const long = await notebookSource({ filePath, offset: 5, limit: 400 })
    equal(long.data.returned, 1)
    equal(long.data.truncated, true)
    match(long.summary, /^5: \u754c+$/m)
    match(long.summary, /Output capped at 24 KB/)
    match(long.summary, /Use offset=6/)

    const end = await notebookSource({ filePath, offset: 6, limit: 1 })
    equal(end.data.returned, 1)
    equal(end.data.truncated, false)
    match(end.summary, /^6: tail$/m)
    doesNotMatch(end.summary, /Output capped|Use offset=/)
    equal(notebook.version, version)
  } finally {
    serializer.dispose()
  }
})
