import { rejects } from "node:assert/strict"
import { test } from "mocha"
import { NotebookCellData, NotebookCellKind, NotebookData, workspace } from "vscode"
import { copilotLikeCellId } from "../notebook/format"
import { runNotebook } from "../notebook/run"

test("rejects multiple cells before executing an explicit single-cell request", async () => {
  const serializer = workspace.registerNotebookSerializer("opencode-run-test", {
    deserializeNotebook: () => new NotebookData([]),
    serializeNotebook: () => new Uint8Array(),
  })
  try {
    const notebook = await workspace.openNotebookDocument("opencode-run-test", new NotebookData([
      new NotebookCellData(NotebookCellKind.Code, "first = 1", "python"),
      new NotebookCellData(NotebookCellKind.Code, "second = 2", "python"),
    ]))
    // 拒绝发生在界面与原生命令之前，不需要启动内核来证明执行范围边界。
    await rejects(runNotebook({
      filePath: notebook.uri.toString(),
      type: "cell",
      cellId: copilotLikeCellId(notebook.cellAt(0)),
      endCellId: copilotLikeCellId(notebook.cellAt(1)),
    }), /endCellId must not be set when type is cell/)
  } finally {
    serializer.dispose()
  }
})
