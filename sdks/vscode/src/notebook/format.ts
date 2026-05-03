/**
 * Notebook cell formatting, metadata extraction, and summary serialization.
 *
 * Provides compact cell representations, execution state text, MIME helpers,
 * artifact summary formatting, and runtime/kernel label extraction.
 * These are shared across all notebook handler modules.
 */
import * as vscode from "vscode"
import {
  isRecord,
  stringProp,
  numberProp,
  nestedStringAt,
  firstString,
  previewText,
  formatBytes,
  quoteForSummary,
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
  if (mime === "application/json") return ".json"
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

/** Truncates a cell identifier to its first 8 chars, stripping the `#VSC-` / `#` prefix. */
export function shortId(id: string) {
  return id.replace(/^#?VSC-/, "").replace(/^#/, "").slice(0, 8)
}

/** Gathers all possible identifiers for a notebook cell (fragment, metadata id, etc.). */
export function cellIdentifiers(cell: vscode.NotebookCell) {
  return [
    cell.document.uri.fragment,
    stringProp(cell.metadata, "id"),
    stringProp(cell.metadata, "cellId"),
    nestedStringAt(cell.metadata, "vscode", "cellId"),
    nestedStringAt(cell.metadata, "custom", "id"),
  ].filter((value): value is string => !!value)
}

/** Returns "markdown" or "code" for a cell kind enum value. */
export function cellKindLabel(kind: vscode.NotebookCellKind) {
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

/**
 * Reconstructs execution metadata from saved cell/output metadata.
 * Used when `executionSummary` is unavailable but the cell has persisted outputs.
 */
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

// ---------------------------------------------------------------------------
// Compact cell representation
// ---------------------------------------------------------------------------

/** Builds a compact summary object for a single cell (used in summary / run / output responses). */
export function compactCell(cell: vscode.NotebookCell) {
  return {
    i: cell.index,
    id: shortId(cellIdentifiers(cell)[0] ?? `cell-${cell.index}`),
    kind: cell.kind === vscode.NotebookCellKind.Code ? "code" : "markdown",
    lang: cell.document.languageId,
    lines: cell.document.lineCount,
    exec: executionText(cell),
    existing_outs: existingOuts(cell),
    first: previewText((cell.document.getText().split("\n")[0] ?? "").trim()).slice(0, 120),
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
 * - Short text-like content (≤1024 chars) is inlined via `<content>` tags or `JSON.stringify`.
 * - Large text shows a 1024-char preview plus a pointer to the artifact file.
 * - Binary content (images, etc.) only references the artifact file path.
 */
export function formatArtifactSummary(a: any, cellIndex?: number) {
  const prefix = cellIndex !== undefined ? `c${cellIndex} ` : ""
  const baseInfo = `${prefix}output=${a.output} item=${a.item} ${shortMime(a.mime)} ${formatBytes(a.bytes)}`

  if (isTextLikeMime(a.mime) && a.text !== undefined && a.text.length <= 1024) {
    if (a.text.includes("\n")) {
      return `${baseInfo}\n<content>\n${a.text}\n</content>`
    }
    return `${baseInfo} ${JSON.stringify(a.text)}`
  }

  if (isTextLikeMime(a.mime)) {
    const content = a.text !== undefined ? a.text.slice(0, 1024) : a.preview
    return `${baseInfo} -> ${artifactName(a.artifactPath)}\n<content>\n${content}\n... (truncated, full output in the file)\n</content>`
  }

  return `${baseInfo} -> ${artifactName(a.artifactPath)}${a.preview ? ` ${quoteForSummary(a.preview)}` : ""}`
}
