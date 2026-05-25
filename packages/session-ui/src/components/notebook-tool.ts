import { Option, Schema } from "effect"

const record = Schema.Record(Schema.String, Schema.Unknown)
const decode = Schema.decodeUnknownOption(record)
const decodeRows = Schema.decodeUnknownOption(Schema.Array(record))
const views = new Set(["summary", "source", "run", "output", "edit", "env"])

export const notebookTools = {
  vscode_notebook_summary: "ui.notebook.summary",
  vscode_notebook_source: "ui.notebook.source",
  vscode_notebook_run: "ui.notebook.run",
  vscode_notebook_output: "ui.notebook.output",
  vscode_notebook_edit: "ui.notebook.edit",
  vscode_notebook_env: "ui.notebook.env",
} as const

export const notebookFields = [
  ["operation", "ui.notebook.operation"],
  ["editType", "ui.notebook.operation"],
  ["target", "ui.notebook.target"],
  ["cellCountBefore", "ui.notebook.beforeCells"],
  ["cellCountAfter", "ui.notebook.afterCells"],
  ["added", "ui.notebook.added"],
  ["removed", "ui.notebook.removed"],
  ["dirty", "ui.notebook.dirty"],
  ["language", "ui.notebook.language"],
  ["returned", "ui.notebook.returned"],
  ["totalLines", "ui.notebook.totalLines"],
  ["truncated", "ui.notebook.truncated"],
  ["completed", "ui.notebook.completed"],
  ["stoppedAt", "ui.notebook.stoppedAt"],
  ["status", "ui.notebook.status"],
  ["saved", "ui.notebook.saved"],
  ["beforeDirty", "ui.notebook.beforeDirty"],
  ["afterDirty", "ui.notebook.afterDirty"],
  ["runtime", "ui.notebook.runtime"],
] as const

export function notebookMetadata(value: unknown) {
  const next = Option.getOrUndefined(decode(value))
  // 只读取既有六类展示信封，不把原始data或工具参数重新解释成执行结果。
  return next && typeof next.view === "string" && views.has(next.view) ? next : undefined
}

export function notebookValue(value: unknown) {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? String(value) : undefined
}

export function notebookRows(value: unknown) {
  return Option.getOrUndefined(decodeRows(value)) ?? []
}

export function notebookLine(value: Record<string, unknown>) {
  const id = typeof value.i === "number" ? `c${value.i}` : undefined
  const values = ["id", "kind", "lang", "lines", "exec", "first", "mime", "bytes", "artifactPath", "preview"].map((key) => notebookValue(value[key]))
  const outputs = Array.isArray(value.existing_outs) ? value.existing_outs.filter((item): item is string => typeof item === "string") : []
  return [id, ...values, ...outputs].filter((item): item is string => item !== undefined).join("  ")
}
