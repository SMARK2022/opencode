export * as NotebookView from "./notebook-view"

import { createTwoFilesPatch } from "diff"

// 展示差分有界，完整原生data及模型summary仍由各自执行链保留。
const NOTEBOOK_DIFF_METADATA_MAX_CHARS = 16 * 1024
// 插入预览供两代代码组件共享；完整源码仍由source工具读取，不能复制进展示metadata。
const NOTEBOOK_INSERT_PREVIEW_LINES = 10
const NOTEBOOK_INSERT_PREVIEW_MAX_CHARS = 4 * 1024

export function build(endpoint: string, args: Record<string, unknown>, value: unknown) {
  const data = recordValue(recordValue(value).data)
  const path = stringValue(data.path) ?? stringValue(args.filePath)
  // #224：summary view——cells 列表 + dirty/runtime 状态
  if (endpoint === "/notebook/summary") {
    return { view: "summary", path, dirty: booleanValue(data.dirty), runtime: stringValue(data.runtime), cells: compactCells(data.cells) }
  }
  // #224：source view——返回的行数/截断信息，不含源码文本
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
  // #224：run view——cells 执行结果 + artifacts
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
  // #224：output view——单个 cell 的 artifacts 列表
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
  // #224：env view——操作状态 + guidance 文案
  if (endpoint === "/notebook/env") {
    return notebookEnvView(path, data)
  }
  // #224：edit view——从 before/after 源码生成 diff
  if (endpoint === "/notebook/edit") {
    return notebookEditView(path, args, data)
  }
}

// #224：notebook edit view——从 beforeSource/afterSource 生成 unified diff，
// #224：超过 16KB 只保留统计和 diffOmitted 标记
function notebookEditView(path: string | undefined, args: Record<string, unknown>, data: Record<string, unknown>) {
  const before = stringValue(data.beforeSource)
  const after = stringValue(data.afterSource)
  // #224：createTwoFilesPatch 生成 unified diff——两路径用 cell index + language 标记
  const fullDiff = before !== undefined && after !== undefined && before !== after
    ? createTwoFilesPatch(notebookDiffPath(path, data, "old"), notebookDiffPath(path, data, "new"), before, after)
    : undefined
  const stats = diffStats(fullDiff ?? "")
  // #224：diff 超过 16KB 只保留统计，diff 设为 undefined，diffOmitted 标记 "too-large"
  const diff = fullDiff && fullDiff.length <= NOTEBOOK_DIFF_METADATA_MAX_CHARS ? fullDiff : undefined
  const cellIndex = numberValue(data.affectedCellIndex) ?? numberValue(data.anchorCellIndex) ?? numberValue(data.deletedCellIndex)
  const editType = stringValue(data.editType) ?? stringValue(args.editType)
  // #233：insert 有 afterSource 时生成有界预览——TUI 用代码渲染器展示插入内容
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

// #233：insert 源码预览——去掉单个尾部空行（diff 构造会补换行），取前 10 行并
// #233：按 4KB 截断；truncated 标记真实行数或字符被裁剪。
function previewNotebookInsertSource(source: string) {
  // #233：rawLines 兼容 CRLF/LF——notebook cell 源码可能来自 Windows 编辑器
  const rawLines = source.split(/\r?\n/)
  const lines = rawLines.at(-1) === "" ? rawLines.slice(0, -1) : rawLines
  const linePreview = lines.slice(0, NOTEBOOK_INSERT_PREVIEW_LINES).join("\n")
  const text = linePreview.length > NOTEBOOK_INSERT_PREVIEW_MAX_CHARS
    ? linePreview.slice(0, NOTEBOOK_INSERT_PREVIEW_MAX_CHARS)
    : linePreview
  return {
    text,
    // #233：截断判定——行数超 10 或字符被 4KB 上限裁剪，二者任一即为 truncated
    truncated: lines.length > NOTEBOOK_INSERT_PREVIEW_LINES || text.length < linePreview.length,
  }
}

// #224：notebook env view——从 status 派生 guidance 文案，让 agent 知道下一步
function notebookEnvView(path: string | undefined, data: Record<string, unknown>) {
  const operation = stringValue(data.operation)
  const status = stringValue(data.status)
  // #224：guidance 从 status 派生——让 agent 知道下一步操作
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

// #224：diff 路径标签——用 path + cell index + language 组成虚拟文件名，
// 让 diff component 能选对语法高亮
function notebookDiffPath(path: string | undefined, data: Record<string, unknown>, fallback: string) {
  const cellIndex = numberValue(data.affectedCellIndex) ?? numberValue(data.anchorCellIndex) ?? numberValue(data.deletedCellIndex)
  const language = stringValue(data.language)
  return [path ?? "notebook", cellIndex === undefined ? undefined : `#c${cellIndex + 1}`, language ? `.${language}` : undefined]
    .filter((item): item is string => Boolean(item))
    .join("") || fallback
}

// #224：run cells 压缩——每个 cell 追加 artifacts 列表
function compactRunCells(value: unknown) {
  return arrayValue(value).map((item) => ({ ...compactCell(item), artifacts: compactArtifacts(recordValue(item).artifacts) }))
}

// #224：summary cells 压缩——只保留 TUI 需要的字段
function compactCells(value: unknown) {
  return arrayValue(value).map(compactCell)
}

// #224：只保留 TUI 需要的 cell 字段——i/id/kind/lang/lines/exec/existing_outs/first
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

// #224：artifact 只保留 mime/bytes/preview/artifactPath——text 字段可能是大 stdout/json/blob，
// 不复制进 session part metadata，完整内容仍在 bridge 返回的 artifact 文件中
function compactArtifacts(value: unknown) {
  return arrayValue(value).map((entry) => {
    const item = recordValue(entry)
    return {
      mime: stringValue(item.mime),
      bytes: numberValue(item.bytes),
      preview: stringValue(item.preview),
      artifactPath: stringValue(item.artifactPath),
    }
  })
}

// #224：从 diff 文本统计 added/removed 行数
function diffStats(diff: string) {
  // #233：只统计 hunk 体内行——patch 文件头在首个 hunk 之前；进入 hunk 后
  // #233：`+++`/`---` 可能是合法 notebook 源码行，不再按文件头排除。
  // #233：added/removed 只在 hunk 体内累计——header 行不计入变更统计
  let added = 0
  let removed = 0
  let hunk = false
  for (const line of diff.split("\n")) {
    if (line.startsWith("@@ ")) {
      hunk = true
      continue
    }
    if (!hunk) continue
    if (line.startsWith("+")) added++
    if (line.startsWith("-")) removed++
  }
  return { added, removed }
}

function recordValue(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  return value as Record<string, unknown>
}

// #224：类型安全守卫——非数组返回空数组
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
