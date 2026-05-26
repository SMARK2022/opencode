import { Effect } from "effect"
import { tool, type ToolContext } from "@opencode-ai/plugin"
import { createTwoFilesPatch } from "diff"
import { z } from "zod"
import * as VscodeBridge from "@/ide/vscode-bridge"
import { VscodeNotebookDescriptions } from "./vscode-bridge-descriptions"

// Notebook 工具是 plugin tool，不能直接复用内置 edit/write 的专用 renderer。
// 这个 fork-local metadata key 是 TUI 和 VS Code bridge 之间的内部展示契约：
// 只让 generic renderer 选择性升级展示，不扩大 public plugin API，也不为每个
// vscode_notebook_* 工具在 session/index.tsx 增加分支。
const NOTEBOOK_METADATA_KEY = "vscodeNotebook"
// notebook edit diff 会持久化到 session part metadata；16KB 与现有工具输出
// 默认内联上限保持同一量级，超过后只保留统计和摘要，避免大 cell/full replace
// 把 notebook 源码整段复制进会话状态。
const NOTEBOOK_DIFF_METADATA_MAX_CHARS = 16 * 1024
// Inserted cells behave like write-new-file in the TUI, so they need bounded
// source metadata for the code renderer instead of relying on an empty-file
// diff. Keep this aligned with the 10-line collapsed card budget: the metadata
// remains bounded, and large notebook sources still require vscode_notebook_source.
const NOTEBOOK_INSERT_PREVIEW_LINES = 10
const NOTEBOOK_INSERT_PREVIEW_MAX_CHARS = 4 * 1024

const requiredFilePath = {
  filePath: z
    .string()
    .describe("Absolute notebook path or file URI. Required; the bridge never infers a notebook from VS Code focus or open documents."),
}

const optionalCellId = {
  cellId: z
    .string()
    .optional()
    .describe("Stable notebook cell ID from vscode_notebook_summary, formatted like #VSC-xxxxxxxx. Prefer this over display indexes."),
}

const requiredEditCellId = {
  cellId: z
    .string()
    .describe(
      "Target cell ID. Use #VSC-xxxxxxxx from vscode_notebook_summary. For editType=insert, use TOP, BOTTOM, or a #VSC cell ID to insert after that cell.",
    ),
}

const sourceArgs = {
  ...requiredFilePath,
  ...optionalCellId,
  offset: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("1-based global virtual source line offset. With cellId, omit this to start at that cell's first global line."),
  limit: z
    .number()
    .int()
    .positive()
    .max(1000)
    .optional()
    .describe("Maximum rendered source lines to return, capped at 1000. Output is also capped at 16 KB."),
}

const runArgs = {
  ...requiredFilePath,
  type: z
    .enum(["cell", "range"])
    .optional()
    .describe("Optional run kind hint. The bridge runs a range whenever endCellId is provided; otherwise it runs one cell."),
  cellId: z.string().describe("Stable start cell ID from vscode_notebook_summary, formatted like #VSC-xxxxxxxx. Also supports TOP and BOTTOM for the first/last cell."),
  endCellId: z
    .string()
    .optional()
    .describe("Stable ending cell ID, formatted like #VSC-xxxxxxxx. When provided, the bridge runs from cellId through this cell, inclusive."),
  timeoutMs: z
    .number()
    .int()
    .positive()
    .max(3_000_000)
    .optional()
    .describe("Per-cell execution timeout in milliseconds. Defaults to 300000, maximum 3000000."),
}

const outputArgs = {
  ...requiredFilePath,
  ...optionalCellId,
}

const editArgs = {
  ...requiredFilePath,
  ...requiredEditCellId,
  editType: z
    .enum(["insert", "edit", "delete"])
    .describe("Notebook edit kind: insert a new cell, edit an existing cell, or delete the target cell."),
  oldCode: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .describe("Existing source fragment to replace inside the target cell. It must identify one unique match; include enough surrounding lines from vscode_notebook_source."),
  newCode: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .describe("New source for insert or edit. Required for insert, full-cell replacement, and oldCode replacement. Do not wrap in Markdown fences unless the fences are literal content."),
  language: z
    .string()
    .optional()
    .describe("Cell language. Use 'markdown' for Markdown cells; use 'python' or another language for code cells. On edit, language alone changes cell kind/language while preserving source."),
}

const envArgs = {
  ...requiredFilePath,
  operation: z
    .enum(["info", "configure", "restart", "save"])
    .describe("Which notebook environment operation to perform."),
  reason: z
    .string()
    .optional()
    .describe("Brief description of why this operation is being performed, shown to the user."),
}

async function callRaw(
  endpoint: string,
  args: Record<string, unknown>,
  context: Pick<ToolContext, "directory" | "abort">,
  timeoutMs?: number,
) {
  return await VscodeBridge.callBridge({
    cwd: context.directory,
    path: endpoint,
    body: args,
    filePath: typeof args.filePath === "string" ? args.filePath : undefined,
    signal: context.abort,
    timeoutMs,
  })
}

function notebookResult(endpoint: string, args: Record<string, unknown>, value: unknown) {
  const view = notebookView(endpoint, args, value)
  return {
    output: VscodeBridge.summaryOnly(value),
    metadata: {
      endpoint,
      ...(view && { [NOTEBOOK_METADATA_KEY]: view }),
    },
  }
}

function notebookView(endpoint: string, args: Record<string, unknown>, value: unknown) {
  const data = recordValue(recordValue(value).data)
  const path = stringValue(data.path) ?? stringValue(args.filePath)
  if (endpoint === "/notebook/summary") {
    return { view: "summary", path, dirty: booleanValue(data.dirty), runtime: stringValue(data.runtime), cells: compactCells(data.cells) }
  }
  if (endpoint === "/notebook/source") {
    return {
      view: "source",
      path,
      target: stringValue(data.target),
      cellId: stringValue(data.cellId) ?? stringValue(args.cellId),
      returned: numberValue(data.returned),
      totalLines: numberValue(data.totalLines),
      truncated: booleanValue(data.truncated),
    }
  }
  if (endpoint === "/notebook/run") {
    return {
      view: "run",
      path,
      dirty: booleanValue(data.dirty),
      runtime: stringValue(data.runtime),
      target: stringValue(data.target),
      completed: booleanValue(data.completed),
      stoppedAt: numberValue(data.stoppedAt),
      cells: compactRunCells(data.cells),
    }
  }
  if (endpoint === "/notebook/output") {
    return {
      view: "output",
      path,
      dirty: booleanValue(data.dirty),
      runtime: stringValue(data.runtime),
      cell: compactCell(data.cell),
      artifacts: compactArtifacts(data.artifacts),
    }
  }
  if (endpoint === "/notebook/env") {
    return notebookEnvView(path, data)
  }
  if (endpoint === "/notebook/edit") {
    return notebookEditView(path, args, data)
  }
}

function notebookEditView(path: string | undefined, args: Record<string, unknown>, data: Record<string, unknown>) {
  const before = stringValue(data.beforeSource)
  const after = stringValue(data.afterSource)
  const fullDiff = before !== undefined && after !== undefined && before !== after
    ? createTwoFilesPatch(notebookDiffPath(path, data, "old"), notebookDiffPath(path, data, "new"), before, after)
    : undefined
  const stats = diffStats(fullDiff ?? "")
  const diff = fullDiff && fullDiff.length <= NOTEBOOK_DIFF_METADATA_MAX_CHARS ? fullDiff : undefined
  const cellIndex = numberValue(data.affectedCellIndex) ?? numberValue(data.anchorCellIndex) ?? numberValue(data.deletedCellIndex)
  const editType = stringValue(data.editType) ?? stringValue(args.editType)
  const insertedSourcePreview = editType === "insert" && after !== undefined
    ? previewNotebookInsertSource(after)
    : undefined
  return {
    view: "edit",
    path,
    cellLabel: cellIndex === undefined ? undefined : `c${cellIndex + 1}`,
    cellId: stringValue(args.cellId),
    editType,
    cellCountBefore: numberValue(data.cellCountBefore),
    cellCountAfter: numberValue(data.cellCountAfter),
    dirty: booleanValue(data.dirty),
    kind: stringValue(data.kind),
    language: stringValue(data.language),
    diff,
    diffOmitted: fullDiff !== undefined && diff === undefined ? "too-large" : undefined,
    ...(insertedSourcePreview && {
      insertedSourcePreview: insertedSourcePreview.text,
      insertedSourcePreviewTruncated: insertedSourcePreview.truncated,
    }),
    added: stats.added,
    removed: stats.removed,
  }
}

function previewNotebookInsertSource(source: string) {
  const rawLines = source.split(/\r?\n/)
  const lines = rawLines.at(-1) === "" ? rawLines.slice(0, -1) : rawLines
  const linePreview = lines.slice(0, NOTEBOOK_INSERT_PREVIEW_LINES).join("\n")
  const text = linePreview.length > NOTEBOOK_INSERT_PREVIEW_MAX_CHARS
    ? linePreview.slice(0, NOTEBOOK_INSERT_PREVIEW_MAX_CHARS)
    : linePreview
  return {
    text,
    truncated: lines.length > NOTEBOOK_INSERT_PREVIEW_LINES || text.length < linePreview.length,
  }
}

function notebookEnvView(path: string | undefined, data: Record<string, unknown>) {
  const operation = stringValue(data.operation)
  const status = stringValue(data.status)
  const guidance = status === "configured"
    ? "Notebook is ready for cell execution."
    : status === "selected"
      ? "Proceed to run cells — the kernel will start on first execution."
      : status === "needs-selection"
        ? "Select a kernel manually from the notebook toolbar, then call configure to verify."
        : status === "selection-requested"
          ? "Retry configure or select a kernel manually."
          : status === "failed"
            ? "Check Jupyter/Python extensions and workspace trust."
            : undefined
  return {
    view: "env",
    path,
    operation,
    status,
    guidance,
    runtime: recordValue(data.runtime),
    saved: booleanValue(data.saved),
    beforeDirty: booleanValue(data.beforeDirty),
    afterDirty: booleanValue(data.afterDirty),
  }
}

function notebookDiffPath(path: string | undefined, data: Record<string, unknown>, fallback: string) {
  const cellIndex = numberValue(data.affectedCellIndex) ?? numberValue(data.anchorCellIndex) ?? numberValue(data.deletedCellIndex)
  const language = stringValue(data.language)
  return [path ?? "notebook", cellIndex === undefined ? undefined : `#c${cellIndex + 1}`, language ? `.${language}` : undefined]
    .filter((item): item is string => Boolean(item))
    .join("") || fallback
}

function compactRunCells(value: unknown) {
  return arrayValue(value).map((item) => ({ ...compactCell(item), artifacts: compactArtifacts(recordValue(item).artifacts) }))
}

function compactCells(value: unknown) {
  return arrayValue(value).map(compactCell)
}

function compactCell(value: unknown) {
  const item = recordValue(value)
  return {
    i: numberValue(item.i),
    id: stringValue(item.id),
    kind: stringValue(item.kind),
    lang: stringValue(item.lang),
    lines: numberValue(item.lines),
    exec: stringValue(item.exec),
    existing_outs: arrayValue(item.existing_outs).filter((entry): entry is string => typeof entry === "string"),
    first: stringValue(item.first),
  }
}

function compactArtifacts(value: unknown) {
  return arrayValue(value).map((entry) => {
    const item = recordValue(entry)
    // artifact.text 可能是大 stdout/json/blob；metadata 只保留 preview/path，
    // 保证 session part 持久化体积稳定。完整内容仍在 bridge 返回的 artifact 文件中，
    // TUI 只展示路径，不把大输出复制进会话状态。
    return {
      mime: stringValue(item.mime),
      bytes: numberValue(item.bytes),
      preview: stringValue(item.preview),
      artifactPath: stringValue(item.artifactPath),
    }
  })
}

function diffStats(diff: string) {
  let added = 0
  let removed = 0
  let hunk = false
  for (const line of diff.split("\n")) {
    if (line.startsWith("@@ ")) {
      hunk = true
      continue
    }
    // Count only hunk body rows. Patch file headers are before the first hunk;
    // inside a hunk, `+++`/`---` can be legitimate notebook source lines.
    if (!hunk) continue
    if (line.startsWith("+")) added++
    if (line.startsWith("-")) removed++
  }
  return {
    added,
    removed,
  }
}

function recordValue(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  return value as Record<string, unknown>
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : undefined
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function booleanValue(value: unknown) {
  return typeof value === "boolean" ? value : undefined
}

async function ask(context: ToolContext, permission: string, args: Record<string, unknown>) {
  const pattern = typeof args.filePath === "string" ? args.filePath : "*"
  await Effect.runPromise(
    context.ask({
      permission,
      patterns: [pattern],
      always: [pattern],
      metadata: { args },
    }),
  )
}

export const VscodeBridgePlugin = async () => ({
  tool: {
    vscode_notebook_summary: tool({
      description: VscodeNotebookDescriptions.summary,
      args: requiredFilePath,
      execute: async (args, context) => notebookResult("/notebook/summary", args, await callRaw("/notebook/summary", args, context, 10_000)),
    }),
    vscode_notebook_source: tool({
      description: VscodeNotebookDescriptions.source,
      args: sourceArgs,
      execute: async (args, context) => notebookResult("/notebook/source", args, await callRaw("/notebook/source", args, context, 10_000)),
    }),
    vscode_notebook_run: tool({
      description: VscodeNotebookDescriptions.run,
      args: runArgs,
      execute: async (args, context) => {
        await ask(context, "vscode_notebook_run", args)
        const timeoutMs = args.timeoutMs ?? 300_000
        const body = { ...args, timeoutMs }
        return notebookResult("/notebook/run", body, await callRaw("/notebook/run", body, context, timeoutMs + 5_000))
      },
    }),
    vscode_notebook_output: tool({
      description: VscodeNotebookDescriptions.output,
      args: outputArgs,
      execute: async (args, context) => notebookResult("/notebook/output", args, await callRaw("/notebook/output", args, context, 30_000)),
    }),
    vscode_notebook_edit: tool({
      description: VscodeNotebookDescriptions.edit,
      args: editArgs,
      execute: async (args, context) => {
        // notebook 编辑是独立工具能力，必须使用自己的权限 key；否则 plan
        // mode 对 vscode_notebook_edit 的 deny 不会覆盖到这里，只会落到通用
        // edit 规则，导致 notebook 写入权限和普通文件编辑权限混在一起。
        await ask(context, "vscode_notebook_edit", args)
        // 继续保留通用 edit 门禁：既有配置若用 permission.edit 禁止写入，
        // notebook cell 修改也不能绕过。顺序先专属后通用，确保更精确的
        // vscode_notebook_edit deny/ask 先表达，再由 edit 维持历史兼容边界。
        await ask(context, "edit", args)
        return notebookResult("/notebook/edit", args, await callRaw("/notebook/edit", args, context, 30_000))
      },
    }),
    vscode_notebook_env: tool({
      description: VscodeNotebookDescriptions.env,
      args: envArgs,
      execute: async (args, context) => {
        // env 包含 configure/restart/save 等会改变 VS Code/Jupyter 状态的操作；
        // 即使 info 偏只读，也保持工具级权限和 agent 配置中的
        // vscode_notebook_env 完全一致，避免新增 operation 级配置面。
        await ask(context, "vscode_notebook_env", args)
        return notebookResult("/notebook/env", args, await callRaw("/notebook/env", args, context, 120_000))
      },
    }),
  },
})
