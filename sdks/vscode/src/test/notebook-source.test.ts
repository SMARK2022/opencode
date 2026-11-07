import { deepEqual, doesNotMatch, equal, match, ok } from "node:assert/strict"
import { test } from "mocha"
import vscode from "vscode"
import { copilotLikeCellId } from "../notebook/format"
import { notebookSource } from "../notebook/source"
import { notebookSummary } from "../notebook/summary"

test("distinguishes source-line pages from UTF-8 byte truncation", async () => {
  // 使用VS Code内置且已贡献编辑器类型的serializer，不另注册无view type的替身。
  const notebook = await vscode.workspace.openNotebookDocument(
    "jupyter-notebook",
    new vscode.NotebookData(
      [
        new vscode.NotebookCellData(vscode.NotebookCellKind.Code, "alpha\nbeta", "python"),
        new vscode.NotebookCellData(vscode.NotebookCellKind.Markup, "gamma\ndelta", "markdown"),
        new vscode.NotebookCellData(vscode.NotebookCellKind.Code, "\u754c".repeat(9 * 1024) + "\ntail", "python"),
        // 预置ipynb真实默认metadata，隔离serializer规范化与只读操作的版本断言。
      ].map((cell, index) =>
        Object.assign(cell, {
          outputs:
            index === 0
              ? [
                  new vscode.NotebookCellOutput(
                    ["image/png", "application/x-png", "text/plain"].map(
                      (mime) => new vscode.NotebookCellOutputItem(new Uint8Array([1]), mime),
                    ),
                  ),
                ]
              : [],
          metadata: {
            id: `source-${index}`,
            metadata: {},
            ...(cell.kind === vscode.NotebookCellKind.Code ? { execution_count: null } : {}),
          },
        }),
      ),
    ),
  )
  const filePath = notebook.uri.toString()
  const version = notebook.version
  const first = await notebookSource({ filePath, limit: 1 })
  equal(first.data.returned, 1)
  equal(first.data.truncated, true)
  deepEqual(first.data.cells, [{ cellID: copilotLikeCellId(notebook.cellAt(0)), offset: 1, content: "alpha" }])
  equal(first.data.next, 2)
  match(first.summary, /^1: alpha$/m)
  match(first.summary, /Use offset=2/)
  doesNotMatch(first.summary, /Output capped|--: --- c2/)

  const across = await notebookSource({ filePath, offset: 2, limit: 3 })
  equal(across.data.returned, 3)
  equal(across.data.truncated, true)
  // 跨格分页保留各自稳定身份与全局偏移，不能把格头和行号混入源码。
  deepEqual(across.data.cells, [
    { cellID: copilotLikeCellId(notebook.cellAt(0)), offset: 2, content: "beta" },
    { cellID: copilotLikeCellId(notebook.cellAt(1)), offset: 3, content: "gamma\ndelta" },
  ])
  const summary = await notebookSummary(filePath)
  // 真实producer同时提供旧展示缩写和原MIME，不能由手写bridge夹具冒充此保证。
  deepEqual(summary.data.cells[0].existing_outs, ["png", "x-png", "text"])
  deepEqual(summary.data.cells[0].outputMimes, ["image/png", "application/x-png", "text/plain"])
  deepEqual(
    summary.data.cells.map((cell) => cell.range),
    [
      { start: 1, end: 2 },
      { start: 3, end: 4 },
      { start: 5, end: 6 },
    ],
  )
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
  match(bytes.summary, /Output capped at 16 KB/)
  match(bytes.summary, /Use offset=5/)
  doesNotMatch(bytes.summary, /^5:/m)

  const long = await notebookSource({ filePath, offset: 5, limit: 400 })
  equal(long.data.returned, 1)
  equal(long.data.truncated, true)
  match(long.summary, /^5: \u754c+$/m)
  match(long.summary, /Full current cell source:/)
  ok(long.data.sourceArtifact)
  // 长行裁剪不能靠下一行恢复；验证真实导出内容，而非只检查路径非空。
  const artifact = await vscode.workspace.fs.readFile(vscode.Uri.file(long.data.sourceArtifact))
  equal(
    new TextDecoder()
      .decode(artifact)
      .split("\n")
      .map((line) => JSON.parse(line))
      .join(""),
    "\u754c".repeat(9 * 1024) + "\ntail",
  )

  const end = await notebookSource({ filePath, offset: 6, limit: 1 })
  equal(end.data.returned, 1)
  equal(end.data.truncated, false)
  match(end.summary, /^6: tail$/m)
  doesNotMatch(end.summary, /Output capped|Use offset=/)
  equal(notebook.version, version)
})
