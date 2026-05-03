/**
 * `vscode_notebook_run` — executes one cell, a range of cells, or all cells
 * via the native VS Code `notebook.cell.execute` command, waits for completion,
 * and returns per-cell execution results with artifact-first output.
 */
import * as vscode from "vscode"
import { isRecord, stringProp, numberProp, toPosixPath, quoteForSummary, formatBytes } from "../util"
import {
  shortId,
  cellIdentifiers,
  shortMime,
  existingOuts,
  executionText,
  runtimeLabel,
  formatArtifactSummary,
} from "./format"
import { resolveNotebook, notebookRange } from "./resolve"
import { serializeNotebookOutputItem } from "./output"

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Bridge endpoint handler: runs notebook cells and returns execution results.
 * Accepts `target: { type: "all"|"range"|"cell", ... }` and optional `timeoutMs`.
 */
export async function runNotebook(input: Record<string, unknown>) {
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
  const completed = await waitForExecution(notebook, range, startedAt, numberProp(input, "timeoutMs") ?? 60_000)
  return await compactRunResult(notebook, range, completed)
}

// ---------------------------------------------------------------------------
// Result builders
// ---------------------------------------------------------------------------

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
    ...cells.map(
      (c) =>
        `c${c.i} id=${c.id} exec=${quoteForSummary(c.exec)} outs=${quoteForSummary(c.existing_outs.join(",") || "none")}`,
    ),
    "",
    "Artifacts:",
    ...cells.flatMap((c) => c.artifacts.map((a) => formatArtifactSummary(a, c.i))),
  ].join("\n")
}

function runTarget(range: vscode.NotebookRange, cellCount: number) {
  if (range.start === 0 && range.end === cellCount) return "all"
  if (range.end === range.start + 1) return `cell ${range.start}`
  return `range ${range.start}-${range.end - 1}`
}

// ---------------------------------------------------------------------------
// Execution polling
// ---------------------------------------------------------------------------

/**
 * Waits for all code cells in the given range to finish executing
 * by watching `executionSummary.timing.endTime`. Returns `false` on timeout.
 */
async function waitForExecution(
  notebook: vscode.NotebookDocument,
  range: vscode.NotebookRange,
  startedAt: number,
  timeoutMs: number,
) {
  const done = () =>
    notebook
      .getCells(range)
      .filter((cell) => cell.kind === vscode.NotebookCellKind.Code)
      .every((cell) => {
        const timing = cell.executionSummary?.timing
        return timing?.endTime !== undefined && timing.endTime >= startedAt
      })

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
