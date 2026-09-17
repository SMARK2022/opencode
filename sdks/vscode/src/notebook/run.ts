/**
 * `vscode_notebook_run` — executes notebook cells via the native VS Code
 * `notebook.cell.execute` command, waits for completion, and returns per-cell
 * execution results with artifact-first output.
 *
 * For `range` targets, cells are executed **sequentially** one-by-one.
 * Execution stops immediately if any cell fails — remaining cells are skipped.
 *
 * Primary input: `cellId` (Copilot-style #VSC-xxxxxxxx).
 */
import * as vscode from "vscode"
import { stringProp, numberProp, quoteForSummary } from "../util"
import {
  c1,
  copilotLikeCellId,
  existingOuts,
  executionText,
  runtimeLabel,
  formatArtifactSummary,
  notebookHeader,
  cellRef,
} from "./format"
import { resolveNotebook, resolveNotebookCell } from "./resolve"
import { serializeNotebookOutputItem } from "./output"

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Bridge endpoint handler: runs notebook cells and returns execution results.
 * Accepts `cellId` and optional `endCellId`.
 * Default timeout: 300 000 ms (5 minutes).
 */
export async function runNotebook(input: Record<string, unknown>, signal?: AbortSignal) {
  signal?.throwIfAborted()
  const filePath = stringProp(input, "filePath")
  if (!filePath) throw new Error("filePath is required")
  const type = stringProp(input, "type")
  if (type !== undefined && type !== "cell" && type !== "range") throw new Error("type must be one of: cell, range")
  const cellId = stringProp(input, "cellId")
  if (!cellId) throw new Error("cellId is required")
  const endCellId = stringProp(input, "endCellId")
  if (type === "cell" && endCellId && endCellId.replace(/^#/, "") !== cellId.replace(/^#/, "")) {
    throw new Error("endCellId must not be set when type is cell unless it equals cellId")
  }

  const notebook = await resolveNotebook(filePath)
  const commands = await vscode.commands.getCommands(true)
  if (!commands.includes("notebook.cell.execute")) {
    // 引导 agent 安装 Jupyter 扩展并配置 kernel，而非返回不可操作的原始错误
    throw new Error(
      "VS Code command notebook.cell.execute is not available. " +
      "Ensure the Jupyter extension (ms-toolsai.jupyter) is installed and activated, " +
      "then call vscode_notebook_env with operation=configure to select a kernel."
    )
  }

  // 冷启动由原生执行入口负责，metadata和已启动kernel都不是执行资格。
  const timeoutMs = numberProp(input, "timeoutMs") ?? 300_000

  // Resolve target cells via stable cell IDs. No cellIndex or "all" mode is accepted.
  const cells = resolveRunTarget(notebook, cellId, endCellId)

  // Open notebook and reveal first cell
  const editor = await vscode.window.showNotebookDocument(notebook, {
    selections: [new vscode.NotebookRange(cells[0].index, cells[0].index + 1)],
  })
  editor.revealRange(new vscode.NotebookRange(cells[0].index, cells[0].index + 1))

  // Execute sequentially, stop on first error
  const results: Array<Awaited<ReturnType<typeof compactRunCell>>> = []
  let stopped = false
  let failedIndex: number | undefined

  for (const cell of cells) {
    // 断开只取消本请求；不得继续调度下一cell，也不擅自中断其他运行。
    signal?.throwIfAborted()
    if (cell.kind !== vscode.NotebookCellKind.Code) {
      results.push({ i: c1(cell), id: copilotLikeCellId(cell), exec: "skipped (not code)", existing_outs: [], artifacts: [] })
      continue
    }
    if (stopped) {
      const outs = existingOuts(cell)
      results.push({ i: c1(cell), id: copilotLikeCellId(cell), exec: "skipped (previous cell failed)", existing_outs: outs.length > 0 ? [`stale:${outs.join(",")}`] : outs, artifacts: [] })
      continue
    }

    editor.selection = new vscode.NotebookRange(cell.index, cell.index + 1)
    editor.revealRange(new vscode.NotebookRange(cell.index, cell.index + 1))

    const wait = waitForSingleCell(cell, timeoutMs, signal)
    let executionSummary: vscode.NotebookCellExecutionSummary | undefined
    try {
      // 命令本身可能不返回；期限覆盖命令等待，不能只覆盖后续事件等待。
      // 显式文档与范围保证活动编辑器变化不会把代码执行到另一个notebook。
      executionSummary = await Promise.race([
        wait.promise,
        vscode.commands.executeCommand("notebook.cell.execute", {
          document: notebook.uri, ranges: [{ start: cell.index, end: cell.index + 1 }], autoReveal: false,
        }).then(() => wait.promise),
      ])
      signal?.throwIfAborted()
    } finally {
      wait.dispose()
    }

    if (!executionSummary) {
      stopped = true
      failedIndex = cell.index
    } else if (executionSummary.success === false) {
      stopped = true
      failedIndex = cell.index
    }

    const result = await compactRunCell(notebook, notebook.cellAt(cell.index))
    // 超时后引导 agent 调用 env stop 中断（手动），或 env info 检查 kernel 状态。
    // 不自动 interrupt——用户明确不想要自动中断机制。
    if (!executionSummary) result.exec = "timed out — the cell may still be running. Use vscode_notebook_env operation=stop to interrupt the kernel, or operation=info to check kernel status."
    results.push(result)
  }

  const targetDesc = describeRunTarget(cells)
  return {
    ran: true,
    summary: runSummaryText(notebook, targetDesc, !stopped, results),
    data: {
      path: notebook.uri.fsPath || notebook.uri.toString(),
      dirty: notebook.isDirty,
      runtime: runtimeLabel(notebook),
      target: targetDesc,
      completed: !stopped,
      stoppedAt: failedIndex,
      cells: results,
    },
  }
}

// ---------------------------------------------------------------------------
// Target resolution
// ---------------------------------------------------------------------------

function resolveRunTarget(notebook: vscode.NotebookDocument, cellId: string, endCellId?: string) {
  function resolveCell(id: string) {
    const upper = id.toUpperCase()
    if (upper === "TOP") return notebook.cellAt(0)
    if (upper === "BOTTOM") return notebook.cellAt(Math.max(0, notebook.cellCount - 1))
    return resolveNotebookCell(notebook, undefined, id)
  }
  const startCell = resolveCell(cellId)
  if (!endCellId) return [startCell]

  const endCell = resolveCell(endCellId)
  if (endCell.index < startCell.index) {
    throw new Error("endCellId must refer to the same cell or a later cell than cellId")
  }
  return notebook.getCells().slice(startCell.index, endCell.index + 1)
}

function describeRunTarget(cells: vscode.NotebookCell[]) {
  if (cells.length === 1) return cellRef(cells[0])
  return `${cellRef(cells[0])}..${cellRef(cells[cells.length - 1])}`
}

// ---------------------------------------------------------------------------
// Result builders
// ---------------------------------------------------------------------------

async function compactRunCell(notebook: vscode.NotebookDocument, cell: vscode.NotebookCell) {
  return {
    i: c1(cell),
    id: copilotLikeCellId(cell),
    exec: executionText(cell),
    existing_outs: existingOuts(cell),
    artifacts: await Promise.all(
      cell.outputs.flatMap((cellOutput, outputIndex) =>
        cellOutput.items.map((item, itemIndex) =>
          serializeNotebookOutputItem(notebook, cell, item, outputIndex, itemIndex),
        ),
      ),
    ),
  }
}

// ---------------------------------------------------------------------------
// Summary text
// ---------------------------------------------------------------------------

function runSummaryText(
  notebook: vscode.NotebookDocument,
  target: string,
  completed: boolean,
  cells: Array<Awaited<ReturnType<typeof compactRunCell>>>,
) {
  const artifactRoot = ".opencode/cache/notebook-outputs/"
  return [
    ...notebookHeader(notebook, "Run", [
      `target=${quoteForSummary(target)}`,
      `completed=${completed}`,
      `dirty=${notebook.isDirty}`,
      `runtime=${quoteForSummary(runtimeLabel(notebook) ?? "unknown")}`,
    ]),
    "",
    "Cells:",
    ...cells.map(
      (c) =>
        `c${c.i} id=${c.id} exec=${quoteForSummary(c.exec)} outs=${quoteForSummary(c.existing_outs.join(",") || "none")}`,
    ),
    "",
    `ArtifactsRoot: ${artifactRoot}`,
    "Artifacts:",
    ...cells.flatMap((c) => c.artifacts.map((a) => formatArtifactSummary(a, c.i))),
  ].join("\n")
}

// ---------------------------------------------------------------------------
// Execution polling (single cell)
// ---------------------------------------------------------------------------

/**
 * Waits for a single code cell to publish a fresh execution summary.
 * The waiter is created before invoking `notebook.cell.execute`, matching the
 * VS Code/Copilot pattern so fast executions are not missed.
 */
function waitForSingleCell(cell: vscode.NotebookCell, timeoutMs: number, signal?: AbortSignal) {
  const targetUri = cell.document.uri.toString()
  let subscription: vscode.Disposable | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let abort: (() => void) | undefined
  const promise = new Promise<vscode.NotebookCellExecutionSummary | undefined>((resolve) => {
    abort = () => resolve(undefined)
    signal?.addEventListener("abort", abort, { once: true })
    if (signal?.aborted) abort()
    timer = setTimeout(() => {
      subscription?.dispose()
      resolve(undefined)
    }, timeoutMs)
    subscription = vscode.workspace.onDidChangeNotebookDocument((event) => {
      if (event.notebook.uri.toString() !== cell.notebook.uri.toString()) return
      for (const change of event.cellChanges) {
        if (change.cell.document.uri.toString() !== targetUri || typeof change.executionSummary?.success !== "boolean") continue
        const summary = change.executionSummary
        clearTimeout(timer)
        subscription?.dispose()
        resolve(summary)
        return
      }
    })
  })
  return {
    promise,
    dispose() {
      // 成功、失败和超时均移除请求监听，避免后续取消影响已完成cell。
      if (abort) signal?.removeEventListener("abort", abort)
      if (timer) {
        clearTimeout(timer)
        timer = undefined
      }
      subscription?.dispose()
    },
  }
}
