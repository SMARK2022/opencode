/**
 * `vscode_notebook_output` — reads cell outputs, writes them to artifact files
 * under `.opencode/cache/notebook-outputs/`, and returns a summary pointing
 * to the artifact paths. Short text outputs are inlined in the summary.
 */
import * as vscode from "vscode"
import * as path from "node:path"
import { previewText } from "../util"
import {
  existingOuts,
  compactCell,
  runtimeLabel,
  shortMime,
  isTextLikeMime,
  extensionForMime,
  formatArtifactSummary,
} from "./format"
import { resolveNotebook, resolveNotebookCell } from "./resolve"

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/** Bridge endpoint handler: reads and serializes all outputs for a specific cell. */
export async function readNotebookCellOutput(filePath?: string, cellIndex?: number, cellId?: string) {
  const notebook = await resolveNotebook(filePath)
  const cell = resolveNotebookCell(notebook, cellIndex, cellId)
  return await serializeNotebookCellOutput(notebook, cell)
}

// ---------------------------------------------------------------------------
// Output serialization
// ---------------------------------------------------------------------------

async function serializeNotebookCellOutput(notebook: vscode.NotebookDocument, cell: vscode.NotebookCell) {
  const artifacts = (
    await Promise.all(
      cell.outputs.flatMap((cellOutput, outputIndex) =>
        cellOutput.items.map((item, itemIndex) =>
          serializeNotebookOutputItem(notebook, cell, item, outputIndex, itemIndex),
        ),
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

// ---------------------------------------------------------------------------
// Single output item
// ---------------------------------------------------------------------------

/**
 * Serializes a single output item: writes the raw data to an artifact file
 * and returns metadata + optional text content for inline display.
 * Exported so that `run.ts` can reuse it for per-cell run results.
 */
export async function serializeNotebookOutputItem(
  notebook: vscode.NotebookDocument,
  cell: vscode.NotebookCell,
  item: vscode.NotebookCellOutputItem,
  outputIndex: number,
  itemIndex: number,
) {
  const text = outputItemText(item)
  const artifact = await writeArtifact(notebook, cell, item, outputIndex, itemIndex)
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

/** Attempts to decode an output item as UTF-8 text for text-like MIME types. */
function outputItemText(item: vscode.NotebookCellOutputItem) {
  if (isTextLikeMime(item.mime)) {
    return Buffer.from(item.data).toString("utf8")
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Artifact writing
// ---------------------------------------------------------------------------

/**
 * Writes a single output item's raw data to a file under
 * `.opencode/cache/notebook-outputs/` in the workspace folder.
 */
async function writeArtifact(
  notebook: vscode.NotebookDocument,
  cell: vscode.NotebookCell,
  item: vscode.NotebookCellOutputItem,
  outputIndex: number,
  itemIndex: number,
) {
  const root = artifactRoot(notebook)
  await vscode.workspace.fs.createDirectory(root)
  const filename =
    [
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
  if (!folder) throw new Error("Notebook output artifacts require an open workspace folder")
  return vscode.Uri.joinPath(folder.uri, ".opencode", "cache", "notebook-outputs")
}
