export * as NotebookView from "./notebook-view"

import { createTwoFilesPatch } from "diff"

// 展示差分有界，完整原生data及模型summary仍由各自执行链保留。
const NOTEBOOK_DIFF_METADATA_MAX_CHARS = 16 * 1024

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
  return {
    view: "edit",
    path,
    cellLabel: cellIndex === undefined ? undefined : `c${cellIndex + 1}`,
    cellId: stringValue(args.cellId),
    editType: stringValue(data.editType) ?? stringValue(args.editType),
    cellCountBefore: numberValue(data.cellCountBefore),
    cellCountAfter: numberValue(data.cellCountAfter),
    dirty: booleanValue(data.dirty),
    kind: stringValue(data.kind),
    language: stringValue(data.language),
    diff,
    diffOmitted: fullDiff !== undefined && diff === undefined ? "too-large" : undefined,
    added: stats.added,
    removed: stats.removed,
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
  const lines = diff.split("\n")
  return {
    added: lines.filter((line) => line.startsWith("+") && !line.startsWith("+++")).length,
    removed: lines.filter((line) => line.startsWith("-") && !line.startsWith("---")).length,
  }
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
