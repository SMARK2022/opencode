/**
 * `vscode_notebook_run` — executes notebook cells via the native VS Code
 * `notebook.cell.execute` command, waits for completion, and returns per-cell
 * execution results with artifact-first output.
 *
 * For `range` and `all` targets, cells are executed **sequentially** one-by-one.
 * Execution stops immediately if any cell fails — remaining cells are skipped.
 *
 * Primary input: `cellId` (Copilot-style #VSC-xxxxxxxx).
 */
import * as vscode from "vscode"
import { isRecord, stringProp, numberProp, toPosixPath, quoteForSummary } from "../util"
import {
  c1,
  copilotLikeCellId,
  existingOuts,
  executionText,
  runtimeLabel,
  formatArtifactSummary,
} from "./format"
import { resolveNotebook, resolveNotebookCell } from "./resolve"
import { serializeNotebookOutputItem } from "./output"

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Bridge endpoint handler: runs notebook cells and returns execution results.
 * Accepts `target: { type: "all" | "range" | "cell", cellId?, start?, end? }`.
 * Default timeout: 300 000 ms (5 minutes).
 */
export async function runNotebook(input: Record<string, unknown>) {
  const notebook = await resolveNotebook(stringProp(input, "filePath"))
  const commands = await vscode.commands.getCommands(true)
  if (!commands.includes("notebook.cell.execute")) {
    throw new Error("VS Code command notebook.cell.execute is not available")
  }

  const timeoutMs = numberProp(input, "timeoutMs") ?? 300_000
  const target = isRecord(input.target) ? input.target : {}

  // Resolve target cells via cellId (only stable identifier; no cellIndex in schema)
  const cells = resolveRunTarget(notebook, target, stringProp(input, "cellId"))

  // Open notebook and reveal first cell
  const editor = await vscode.window.showNotebookDocument(notebook, {
    selections: [new vscode.NotebookRange(cells[0].index, cells[0].index + 1)],
  })

  // Execute sequentially, stop on first error
  const results: Array<Awaited<ReturnType<typeof compactRunCell>>> = []
  let stopped = false
  let failedIndex: number | undefined

  for (const cell of cells) {
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

    const startedAt = Date.now()
    await vscode.commands.executeCommand("notebook.cell.execute")
    const completed = await waitForSingleCell(notebook, cell.index, startedAt, timeoutMs)

    if (!completed) {
      stopped = true
    } else {
      // Check if the cell execution failed
      const exec = executionText(cell)
      if (exec.includes("failed")) {
        stopped = true
        failedIndex = cell.index
      }
    }

    results.push(await compactRunCell(notebook, cell))
  }

  const targetDesc = describeRunTarget(cells, notebook.cellCount)
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

function resolveRunTarget(
  notebook: vscode.NotebookDocument,
  target: Record<string, unknown>,
  cellId?: string,
): vscode.NotebookCell[] {
  const type = stringProp(target, "type") ?? "cell"

  if (type === "all") return notebook.getCells().slice()

  if (type === "range") {
    const start = Math.max(0, numberProp(target, "start") ?? 0)
    const end = Math.min(notebook.cellCount, numberProp(target, "end") ?? start + 1)
    return notebook.getCells().slice(start, Math.max(start + 1, end))
  }

  // type === "cell" or missing — resolve by cellId (no cellIndex fallback)
  const resolved = resolveNotebookCell(notebook, undefined, cellId ?? stringProp(target, "cellId"))
  return [resolved]
}

function describeRunTarget(cells: vscode.NotebookCell[], cellCount: number) {
  if (cells.length === cellCount) return "all"
  if (cells.length === 1) return `cell ${c1(cells[0])}`
  const indices = cells.map((c) => c1(c))
  return `range ${indices[0]}-${indices[indices.length - 1]}`
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
    `Notebook: ${toPosixPath(notebook.uri.fsPath || notebook.uri.toString())}`,
    `Run: target=${target} completed=${completed} dirty=${notebook.isDirty} runtime=${runtimeLabel(notebook) ?? "unknown"}`,
    `ArtifactsRoot: ${artifactRoot}`,
    "",
    "Cells:",
    ...cells.map(
      (c) =>
        `c${c.i} id=${c.id} exec=${quoteForSummary(c.exec)} outs=${quoteForSummary(c.existing_outs.join(",") || "none")}`,
    ),
    "",
    "Artifacts:",
    ...cells.flatMap((c) => c.artifacts.map((a) => formatArtifactSummary(a, c.i))),
  ].join("\n")
}

// ---------------------------------------------------------------------------
// Execution polling (single cell)
// ---------------------------------------------------------------------------

/**
 * Waits for a single code cell to finish executing by watching
 * `executionSummary.timing.endTime`. Returns `false` on timeout.
 */
async function waitForSingleCell(
  notebook: vscode.NotebookDocument,
  cellIndex: number,
  startedAt: number,
  timeoutMs: number,
) {
  const cell = notebook.cellAt(cellIndex)
  if (cell.kind !== vscode.NotebookCellKind.Code) return true

  const done = () => {
    const timing = cell.executionSummary?.timing
    return timing?.endTime !== undefined && timing.endTime >= startedAt
  }

  if (done()) return true

  return await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      subscription.dispose()
      resolve(false)
    }, timeoutMs)
    const subscription = vscode.workspace.onDidChangeNotebookDocument((event) => {
      if (event.notebook.uri.toString() !== notebook.uri.toString()) return
      if (!done()) return
      clearTimeout(timer)
      subscription.dispose()
      resolve(true)
    })
  })
}
