/**
 * Notebook cell formatting, metadata extraction, and summary serialization.
 *
 * Provides compact cell representations, execution state text, MIME helpers,
 * artifact summary formatting, runtime label extraction, and virtual-document
 * line range computation.
 * Shared across all notebook handler modules.
 */
import * as vscode from "vscode"
import * as crypto from "node:crypto"
import {
  isRecord,
  stringProp,
  numberProp,
  nestedStringAt,
  firstString,
  previewText,
  formatBytes,
  quoteForSummary,
  toPosixPath,
} from "../util"

// ---------------------------------------------------------------------------
// MIME type helpers
// ---------------------------------------------------------------------------

/** Abbreviates a full MIME type into a short label for summary display. */
export function shortMime(mime: string) {
  if (mime === "application/vnd.code.notebook.stdout") return "stdout"
  if (mime === "application/vnd.code.notebook.stderr") return "stderr"
  if (mime === "application/vnd.code.notebook.error") return "error"
  if (mime === "image/png") return "png"
  if (mime === "image/jpeg") return "jpeg"
  if (mime === "text/plain") return "text"
  if (mime === "text/html") return "html"
  if (mime === "text/markdown") return "markdown"
  if (mime === "application/json") return "json"
  if (mime.includes("datawrangler")) return "datawrangler"
  return mime.split("/").pop() ?? mime
}

/** Maps a MIME type to an appropriate file extension for artifact output files. */
export function extensionForMime(mime: string) {
  if (mime === "image/png") return ".png"
  if (mime === "image/jpeg") return ".jpg"
  if (mime === "image/svg+xml") return ".svg"
  if (mime === "text/html") return ".html"
  if (mime === "text/plain") return ".txt"
  if (mime === "application/json") return ".json"
  if (mime.includes("datawrangler")) return ".json"
  if (mime === "application/vnd.code.notebook.error") return ".json"
  if (mime === "application/vnd.code.notebook.stdout") return ".txt"
  if (mime === "application/vnd.code.notebook.stderr") return ".txt"
  if (mime.startsWith("text/")) return ".txt"
  return ".bin"
}

/** Returns true if the MIME type carries text content that can be inlined in summaries. */
export function isTextLikeMime(mime: string) {
  return (
    mime.startsWith("text/") ||
    mime === "application/json" ||
    mime === "application/vnd.code.notebook.stdout" ||
    mime === "application/vnd.code.notebook.stderr" ||
    mime === "application/vnd.code.notebook.error" ||
    shortMime(mime) === "datawrangler"
  )
}

// ---------------------------------------------------------------------------
// Cell identity & metadata
// ---------------------------------------------------------------------------

/**
 * Generates a Copilot-compatible cell identifier: `#VSC-` + first 8 hex chars
 * of SHA1(cell.document.uri.toString()). This is the same algorithm Copilot uses
 * (`getCellId` in platform/notebook/common/helpers.ts).
 *
 * The ID is derived from the cell's VS Code document URI and is stable for
 * existing cells within the current open notebook session (insert/delete/move
 * preserves the URI). Cell replacement (e.g. type change via replaceCells)
 * creates a new URI and thus a new ID.
 *
 * ≠ cell.index (which shifts on insert/delete)
 * ≠ cell.metadata.id (the .ipynb id field)
 */
export function copilotLikeCellId(cell: vscode.NotebookCell) {
  return (
    "#VSC-" +
    crypto
      .createHash("sha1")
      .update(cell.document.uri.toString(), "utf8")
      .digest("hex")
      .slice(0, 8)
  )
}

/** Gathers all possible identifiers for a notebook cell, with Copilot-style ID first. */
export function cellIdentifiers(cell: vscode.NotebookCell) {
  return [
    copilotLikeCellId(cell),
    cell.document.uri.fragment,
    stringProp(cell.metadata, "id"),
    stringProp(cell.metadata, "cellId"),
    nestedStringAt(cell.metadata, "vscode", "cellId"),
    nestedStringAt(cell.metadata, "custom", "id"),
  ].filter((value): value is string => !!value)
}

/** Normalizes model-returned cell IDs to canonical #VSC-xxxxxxxx format. */
export function normalizeCellId(cellId: string) {
  const v = cellId.trim()
  if (v.startsWith("#VSC-")) return v
  if (v.startsWith("VSC-")) return `#${v}`
  if (v.startsWith("#V-") && v.length === 11) return `#VSC-${v.substring(3)}`
  if (v.toLowerCase().startsWith("vscode-") && v.length === 15) return `#VSC-${v.substring(7)}`
  if (/^[a-f0-9]{8}$/i.test(v)) return `#VSC-${v}`
  return v
}

/** Returns 1-based display index for summary text. All LLM-facing cN MUST use this. */
export const c1 = (cell: vscode.NotebookCell) => cell.index + 1

/** Returns "markdown" or "code" for a cell kind enum value. */
export function cellTypeLabel(kind: vscode.NotebookCellKind) {
  return kind === vscode.NotebookCellKind.Markup ? "markdown" : "code"
}

/** Returns de-duplicated short MIME labels for all output items on a cell. */
export function existingOuts(cell: vscode.NotebookCell) {
  return [...new Set(cell.outputs.flatMap((cellOutput) => cellOutput.items.map((item) => shortMime(item.mime))))]
}

// ---------------------------------------------------------------------------
// Execution state
// ---------------------------------------------------------------------------

/**
 * Builds a compact, human-readable execution status string for a cell.
 * Format: `<state> #<order> <status> <duration> ended=<ISO timestamp>`
 */
export function executionText(cell: vscode.NotebookCell) {
  const summary = cell.executionSummary
  if (!summary?.executionOrder && !summary?.timing) {
    if (cell.outputs.length === 0) return "not-run"
    const saved = savedExecution(cell)
    return `not-run but-saved-output #${saved.order} ${saved.status}${saved.duration}${saved.ended}`
  }
  const state = summary.timing ? "current-run" : "session-state"
  const status =
    summary.success === false
      ? "failed"
      : summary.success === true || cell.outputs.length > 0
        ? "succeeded"
        : "unknown-status"
  const order = summary.executionOrder ?? "?"
  const duration = summary.timing ? ` ${Math.max(0, summary.timing.endTime - summary.timing.startTime)}ms` : " ?ms"
  const ended = summary.timing ? ` ended=${new Date(summary.timing.endTime).toISOString()}` : " ended=?"
  return `${state} #${order} ${status}${duration}${ended}`
}

function savedExecution(cell: vscode.NotebookCell) {
  const outputMetadata = cell.outputs.map((output) => output.metadata).filter(isRecord)
  const endedRaw = firstString(
    stringProp(cell.metadata, "execution_end_time"),
    stringProp(cell.metadata, "end_time"),
    ...outputMetadata.flatMap((metadata) => [
      stringProp(metadata, "execution_end_time"),
      stringProp(metadata, "end_time"),
      stringProp(metadata, "timestamp"),
    ]),
  )
  const startedRaw = firstString(
    stringProp(cell.metadata, "execution_start_time"),
    stringProp(cell.metadata, "start_time"),
    ...outputMetadata.flatMap((metadata) => [
      stringProp(metadata, "execution_start_time"),
      stringProp(metadata, "start_time"),
    ]),
  )
  return {
    order: numberProp(cell.metadata, "execution_count") ?? "?",
    status: existingOuts(cell).includes("error") ? "failed" : "succeeded",
    duration: durationText(startedRaw, endedRaw),
    ended: endedRaw ? ` ended=${formatDate(endedRaw)}` : " ended=?",
  }
}

function durationText(startedRaw?: string, endedRaw?: string) {
  if (!startedRaw || !endedRaw) return " ?ms"
  const started = Date.parse(startedRaw)
  const ended = Date.parse(endedRaw)
  if (!Number.isFinite(started) || !Number.isFinite(ended)) return " ?ms"
  return ` ${Math.max(0, ended - started)}ms`
}

function formatDate(input: string) {
  const value = Date.parse(input)
  return Number.isFinite(value) ? new Date(value).toISOString() : input
}

// ---------------------------------------------------------------------------
// Notebook metadata
// ---------------------------------------------------------------------------

/** Extracts a kernel/runtime display label from notebook-level metadata. */
export function runtimeLabel(notebook: vscode.NotebookDocument) {
  const kernelspec = isRecord(notebook.metadata.kernelspec) ? notebook.metadata.kernelspec : undefined
  const language = isRecord(notebook.metadata.language_info) ? notebook.metadata.language_info : undefined
  const kernelName = stringProp(kernelspec ?? {}, "display_name") ?? stringProp(kernelspec ?? {}, "name")
  const languageName = stringProp(language ?? {}, "name")
  const languageVersion = stringProp(language ?? {}, "version")
  if (kernelName && languageName && languageVersion) return `${kernelName} (${languageName} ${languageVersion})`
  if (kernelName) return kernelName
  if (languageName && languageVersion) return `${languageName} ${languageVersion}`
  return languageName ?? null
}

/**
 * Returns the path string shown to the model at the top of every notebook tool
 * result. Keep this display-only path POSIX-normalized for token efficiency;
 * data payloads can continue carrying the original VS Code fsPath/URI shape.
 */
export function notebookPath(notebook: vscode.NotebookDocument) {
  return toPosixPath(notebook.uri.fsPath || notebook.uri.toString())
}

/**
 * All notebook tools start with the same two model-facing lines:
 * `Notebook:` identifies the document, and `<Tool>:` carries operation fields.
 * This invariant lets agents parse summaries without relearning per-tool layout.
 */
export function notebookHeader(notebook: vscode.NotebookDocument, label: string, fields: Array<string | undefined>) {
  return [
    `Notebook: ${notebookPath(notebook)}`,
    `${label}: ${fields.filter(Boolean).join(" ")}`,
  ]
}

/**
 * Compact cell references always pair the shifting display index with the stable
 * #VSC identifier, because agents must never treat cN alone as a durable handle.
 */
export function cellRef(cell: vscode.NotebookCell) {
  return `c${c1(cell)} id=${copilotLikeCellId(cell)} ${cellTypeLabel(cell.kind)}/${cell.document.languageId}`
}

// ---------------------------------------------------------------------------
// Virtual document line ranges
// ---------------------------------------------------------------------------

/**
 * Computes 1-based inclusive source line ranges for every cell in the virtual document.
 * Headers (`--: ...`) and visual separators do NOT consume line numbers.
 *
 * Layout per cell:
 *   --:  header line            (no line number)
 *   N:   source line 0          (numbered)
 *   ...
 *   N+k: source line last       (numbered)
 *
 * Returns a Map from cell index to `{ start, end }` where both are 1-based inclusive.
 */
export function computeVirtualRanges(notebook: vscode.NotebookDocument) {
  const ranges = new Map<number, { start: number; end: number }>()
  let next = 1
  for (const cell of notebook.getCells()) {
    const count = cell.document.lineCount
    if (count > 0) {
      ranges.set(cell.index, { start: next, end: next + count - 1 })
    } else {
      ranges.set(cell.index, { start: next, end: next }) // empty cell — point range
    }
    next += Math.max(1, count)
  }
  return ranges
}

// ---------------------------------------------------------------------------
// Compact cell representation
// ---------------------------------------------------------------------------

/** Builds a compact summary object for a single cell (used in summary / run / output responses). */
export function compactCell(cell: vscode.NotebookCell) {
  return {
    i: c1(cell),                                 // 1-based display index
    id: copilotLikeCellId(cell),                  // #VSC-xxxxxxxx — stable across insert/delete
    kind: cell.kind === vscode.NotebookCellKind.Code ? "code" : "markdown",
    lang: cell.document.languageId,
    lines: cell.document.lineCount,
    exec: executionText(cell),
    existing_outs: existingOuts(cell),
    first: previewText((cell.document.getText().split("\n")[0] ?? "").trim(), 50),
  }
}

// ---------------------------------------------------------------------------
// Artifact summary formatting
// ---------------------------------------------------------------------------

/** Extracts just the filename from a full artifact path. */
function artifactName(p: string) {
  return p.replace(/\\/g, "/").split("/").pop() ?? p
}

/**
 * Formats a single output artifact for inclusion in the LLM summary text.
 *
 * - Short text-like content (≤1024 chars) is inlined via `<full_content>` tag (or `JSON.stringify` for single-line).
 * - Larger text / binary shows only the artifact path + a short preview; full content is in the artifact file.
 * - All entries include the `-> filename` path for model awareness.
 */
export function formatArtifactSummary(a: any, cellIndex?: number) {
  const prefix = cellIndex !== undefined ? `c${cellIndex} ` : ""
  const filename = artifactName(a.artifactPath)
  const baseInfo = `${prefix}output=${a.output} item=${a.item} ${shortMime(a.mime)} ${formatBytes(a.bytes)} -> ${filename}`

  if (isTextLikeMime(a.mime) && a.text !== undefined && a.text.length <= 1024) {
    if (a.text.includes("\n")) {
      return `${baseInfo}\n<full_content>\n${a.text}\n</full_content>`
    }
    return `${baseInfo} ${JSON.stringify(a.text)}`
  }

  // Large text or binary — only preview, no inline content
  return `${baseInfo}${a.preview ? ` ${quoteForSummary(a.preview)}` : ""}`
}
