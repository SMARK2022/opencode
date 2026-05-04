/**
 * Generic type-safe utility helpers shared across the extension.
 *
 * Contains JSON parsing, record/property accessors, URI conversion,
 * and formatting primitives used by bridge, notebook, and commands.
 */
import * as vscode from "vscode"

// ---------------------------------------------------------------------------
// Type guards & record accessors
// ---------------------------------------------------------------------------

/** Checks whether a value is a non-null, non-array plain object. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Extracts a string property from a record, returning `undefined` if missing or wrong type. */
export function stringProp(record: Record<string, unknown>, key: string) {
  const value = record[key]
  return typeof value === "string" ? value : undefined
}

/** Extracts a finite number property from a record. */
export function numberProp(record: Record<string, unknown>, key: string) {
  const value = record[key]
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

/** Shorthand for `stringProp` when reading notebook metadata dictionaries. */
export function stringAt(record: Record<string, unknown>, key: string) {
  return stringProp(record, key)
}

/** Reads `record[key][nestedKey]` as a string, safely. */
export function nestedStringAt(record: Record<string, unknown>, key: string, nestedKey: string) {
  const value = record[key]
  return isRecord(value) ? stringAt(value, nestedKey) : undefined
}

/** Shorthand for `numberProp` when reading notebook metadata. */
export function numberAt(record: Record<string, unknown>, key: string) {
  return numberProp(record, key)
}

/** Returns the first non-empty string from a list of candidates. */
export function firstString(...values: Array<string | undefined>) {
  return values.find((value) => value && value.trim())
}

// ---------------------------------------------------------------------------
// Input parsing helpers
// ---------------------------------------------------------------------------

/**
 * Reads `record[key]` as a string, or joins an array of strings with `eol`.
 * Used to accept either `"source": "line1\nline2"` or `"source": ["line1","line2"]`.
 */
export function sourceProp(record: Record<string, unknown>, key: string, eol = "\n") {
  const value = record[key]
  if (typeof value === "string") return value
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    return value.join(eol)
  }
  return undefined
}

/**
 * Converts a user-supplied file path or URI string into a `vscode.Uri`.
 * Handles Windows drive-letter paths, absolute Unix paths, and scheme-based URIs.
 */
export function uriFromInput(input: string) {
  if (/^[a-zA-Z]:[\\/]/.test(input)) return vscode.Uri.file(input)
  if (input.startsWith("/")) return vscode.Uri.file(input)
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(input)) return vscode.Uri.parse(input)
  return vscode.Uri.file(input)
}

// ---------------------------------------------------------------------------
// Text & path formatting
// ---------------------------------------------------------------------------

/** Converts a Windows path to forward-slash POSIX style to reduce `\\` token bloat in LLM context. */
export function toPosixPath(p: string) {
  return p.replace(/\\/g, "/")
}

/**
 * Wraps a metadata string in double quotes, escaping embedded newlines.
 * Only used for short structural labels (exec state, MIME lists) — NOT for raw source content.
 */
export function quoteForSummary(s: string) {
  return `"${s.replace(/\n/g, "\\n")}"`
}

/** Truncates text to `max` chars with `...` suffix. Default max = 500. */
export function previewText(text: string, max = 500) {
  return text.length > max ? `${text.slice(0, max)}...` : text
}

/** Human-readable byte size: B / KB / MB. */
export function formatBytes(n: number) {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`
  if (n >= 1024) return `${(n / 1024).toFixed(1)}KB`
  return `${n}B`
}

/** Returns the full document range covering all lines (for replace edits). */
export function fullDocumentRange(document: vscode.TextDocument) {
  if (document.lineCount === 0) return new vscode.Range(0, 0, 0, 0)
  return new vscode.Range(new vscode.Position(0, 0), document.lineAt(document.lineCount - 1).range.end)
}

/** Returns the line separator for a document (`\r\n` or `\n`). */
export function documentEol(document: vscode.TextDocument) {
  return document.eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n"
}

// ---------------------------------------------------------------------------
// VS Code extension helpers
// ---------------------------------------------------------------------------

/** Returns human-readable activation state of a VS Code extension. */
export function extensionState(id: string) {
  const extension = vscode.extensions.getExtension(id)
  if (!extension) return "missing"
  return extension.isActive ? "active" : "installed"
}

/** Returns id, isActive, version for a VS Code extension, or `undefined` if not installed. */
export function extensionInfo(id: string) {
  const extension = vscode.extensions.getExtension(id)
  return extension
    ? { id: extension.id, isActive: extension.isActive, version: extension.packageJSON?.version }
    : undefined
}

/** Opens a JSON document in a new editor tab for inspection. */
export async function openJsonDocument(value: unknown) {
  const document = await vscode.workspace.openTextDocument({
    content: JSON.stringify(value, null, 2),
    language: "json",
  })
  await vscode.window.showTextDocument(document, { preview: false })
}
