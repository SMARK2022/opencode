import { createMemo, For, Show, type Accessor } from "solid-js"
import type { JSX } from "@opentui/solid"
import type { PendingToolInputStats } from "./pending-tool-input"
import { useTheme } from "../../context/theme"
import { usePathFormatter } from "../../context/path-format"
import { previewDiff } from "../../util/preview-diff"
import { filetype } from "../../util/filetype"

// #224：这个文件只负责把 metadata.vscodeNotebook 翻译成 GenericTool 可消费的
// inline/block 描述，不拥有 BlockTool/InlineTool 本身。这样 notebook 的差异化
// 展示集中在一个小 seam，同时保持上游 session/index.tsx 的工具 card 框架不被复制。
export type VscodeNotebookToolView =
  | {
      mode: "inline"
      icon: string
      complete: unknown
      pending: JSX.Element
      children: JSX.Element
    }
  | {
      mode: "block"
      title: string
      body: JSX.Element
      preview?: JSX.Element
      totalLines?: number
      totalChars?: number
      maxLines?: number
      threshold?: number
    }

export function useVscodeNotebookToolView(props: {
  tool: Accessor<string>
  input: Accessor<Record<string, unknown>>
  metadata: Accessor<Record<string, unknown>>
  output: Accessor<string>
  status: Accessor<string>
  pendingStats: Accessor<PendingToolInputStats | undefined>
  width: Accessor<number>
  diffWrapMode: Accessor<"word" | "none">
}) {
  const { theme, syntax } = useTheme()
  const pathFormatter = usePathFormatter()
  return createMemo<VscodeNotebookToolView | undefined>(() => {
    // #224：完成态优先使用 plugin 写入的 compact metadata；pending/running 阶段 metadata
    // 尚不存在，只能用 streaming raw parser 提供的 file/cell/+/- 摘要，避免读 VS Code。
    const metadata = notebookMetadata(props.metadata())
    if (metadata) return blockView(metadata, props.output())
    if (!props.tool().startsWith("vscode_notebook_")) return undefined
    return inlineView(props.tool(), props.input(), props.status(), props.pendingStats())
  })

  function blockView(metadata: Record<string, unknown>, output: string): VscodeNotebookToolView | undefined {
    const view = stringValue(metadata.view)
    // #224：view 字段分派到 edit/summary/source/run/output/env 六种 block 视图
    // #224：未知 view 值返回 undefined，回退到 generic renderer
    if (view === "edit") return editView(metadata)
    if (view === "summary") return summaryView(metadata)
    if (view === "source") return textView(metadata, output, "Notebook source")
    if (view === "run") return runView(metadata)
    if (view === "output") return outputView(metadata)
    if (view === "env") return envView(metadata)
  }

  // #224：notebook inline 视图——pending 态从流式参数提取摘要，完成态回退到 inline
  function inlineView(tool: string, input: Record<string, unknown>, status: string, stats?: PendingToolInputStats): VscodeNotebookToolView {
    const op = stats?.operation ?? stringValue(input.editType) ?? stringValue(input.operation) ?? tool.replace("vscode_notebook_", "")
    // #224：target 从 filePath 或 stats.filePath 派生——pathFormatter 统一格式化
    const target = notebookTarget(stringValue(input.filePath) ?? stats?.filePath)
    const cell = stats?.cellId ?? stringValue(input.cellId)
    const label = tool === "vscode_notebook_edit" ? notebookEditLabel(op) : notebookToolLabel(tool)
    // #224：lineStats 是 pending 阶段的 +N/-N 色标，只在有统计时显示
    const lineStats = <NotebookPendingStats stats={stats} />
    const content = (
      <>
        {label} <Show when={target}>{target}</Show> <Show when={cell}>{cell}</Show>{lineStats}
      </>
    )
    return {
      mode: "inline",
    // #224：icon 用 ← 表示 edit（写入），⚙ 表示其他 notebook 工具
      icon: tool === "vscode_notebook_edit" ? "←" : "⚙",
      complete: status !== "pending",
      pending: (
        <Show when={stats || target !== "notebook" || cell} fallback={<>Preparing {label.toLowerCase()}...</>}>
          {content}
        </Show>
      ),
      children: content,
    }
  }

  // #224：notebook edit block 视图——从 metadata.diff 渲染 diff card，无 diff 时显示 summary
  function editView(metadata: Record<string, unknown>): VscodeNotebookToolView {
    const diff = stringValue(metadata.diff) ?? ""
    // #224：stats 从 metadata.added/removed 派生——如果 diff 被省略，stats 仍保留行数
    const stats = { added: numberValue(metadata.added) ?? 0, removed: numberValue(metadata.removed) ?? 0 }
    const title = [
      "←",
      notebookEditLabel(stringValue(metadata.editType)),
      notebookTarget(stringValue(metadata.path)),
      stringValue(metadata.cellLabel) ?? stringValue(metadata.cellId),
        stats.added > 0 || stats.removed > 0 ? `+${stats.added} -${stats.removed}` : undefined,
    ].filter(Boolean).join(" ")
    const filePath = notebookDiffPath(metadata)
    // #224：preview 用 previewDiff 截断到 10 行，body 用完整 diff
    return {
      mode: "block",
      title,
      maxLines: 10,
      threshold: 20,
      totalLines: diff.split("\n").length,
      totalChars: diff.length,
      preview: diff ? <NotebookDiff diff={previewDiff(diff, 10)} filePath={filePath} maxLines={10} /> : undefined,
      // #224：body 在 diff 和 summary 之间用 Show 切换；diffOmitted 时显示提示
      body: (
        <box gap={1} flexDirection="column">
          <Show when={diff} fallback={<text fg={theme.text}>{summaryLine(metadata)}</text>}>
            <NotebookDiff diff={diff} filePath={filePath} />
          </Show>
          <Show when={stringValue(metadata.diffOmitted)}>
            <text fg={theme.textMuted}>Diff omitted from metadata because it exceeds the notebook inline display budget.</text>
          </Show>
          <text fg={theme.textMuted}>{summaryLine(metadata)}</text>
        </box>
      ),
    }
  }

  // #224：notebook summary block 视图——渲染 cell 列表和 runtime/dirty 状态
  function summaryView(metadata: Record<string, unknown>): VscodeNotebookToolView {
    const cells = arrayRecords(metadata.cells)
    const title = `# Notebook summary ${notebookTarget(stringValue(metadata.path))}${cells.length ? ` · ${cells.length} cells` : ""}`
    const lines = cells.length + 2
    return {
      mode: "block",
      title,
      maxLines: 10,
      threshold: 20,
      totalLines: lines,
      totalChars: JSON.stringify(metadata).length,
      preview: <NotebookCells cells={cells.slice(0, 8)} runtime={stringValue(metadata.runtime)} dirty={booleanValue(metadata.dirty)} />,
      body: <NotebookCells cells={cells} runtime={stringValue(metadata.runtime)} dirty={booleanValue(metadata.dirty)} />,
    }
  }

  // #224：notebook source block 视图——从 output 渲染源码文本
  function textView(metadata: Record<string, unknown>, output: string, label: string): VscodeNotebookToolView {
    const title = `→ ${label} ${notebookTarget(stringValue(metadata.path))}`
    return {
      mode: "block",
      title,
      maxLines: 10,
      threshold: 20,
      totalLines: output.split("\n").length,
      totalChars: output.length,
      preview: <text fg={theme.text}>{previewText(output, 10)}</text>,
      body: <text fg={theme.text}>{output}</text>,
    }
  }

  // #224：notebook run block 视图——渲染执行结果 cells 和 artifacts
  function runView(metadata: Record<string, unknown>): VscodeNotebookToolView {
    const cells = arrayRecords(metadata.cells)
    const completed = booleanValue(metadata.completed)
    return {
      mode: "block",
      title: `▶ Notebook run ${notebookTarget(stringValue(metadata.path))} ${stringValue(metadata.target) ?? ""} · ${completed === false ? "failed" : "completed"}`,
      maxLines: 10,
      threshold: 20,
      totalLines: cells.length + artifactRows(cells).length + 2,
      totalChars: JSON.stringify(metadata).length,
      preview: <NotebookRun cells={cells.slice(0, 6)} />,
      body: <NotebookRun cells={cells} />,
    }
  }

  // #224：notebook output block 视图——渲染 cell artifacts 和 cell 元信息
  function outputView(metadata: Record<string, unknown>): VscodeNotebookToolView {
    const artifacts = arrayRecords(metadata.artifacts)
    const cell = recordValue(metadata.cell)
    return {
      mode: "block",
      title: `→ Notebook output ${notebookTarget(stringValue(metadata.path))} ${cellLabel(cell)} · ${artifacts.length ? `${artifacts.length} artifacts` : "no outputs"}`,
      maxLines: 10,
      threshold: 20,
      totalLines: artifacts.length + 2,
      totalChars: JSON.stringify(metadata).length,
      preview: <NotebookArtifacts artifacts={artifacts.slice(0, 6)} />,
      body: (
        <box flexDirection="column">
          <text fg={theme.textMuted}>Cell: {cellLabel(cell)} {stringValue(cell.kind)}/{stringValue(cell.lang)}</text>
          <NotebookArtifacts artifacts={artifacts} />
        </box>
      ),
    }
  }

  // #224：notebook env block 视图——渲染操作/状态/guidance/dirty 变化
  function envView(metadata: Record<string, unknown>): VscodeNotebookToolView {
    const status = stringValue(metadata.status) ?? envStatus(metadata)
    return {
      mode: "block",
      title: `# Notebook env ${notebookTarget(stringValue(metadata.path))} · ${status ?? stringValue(metadata.operation) ?? "info"}`,
      maxLines: 10,
      threshold: 20,
      totalLines: 4,
      totalChars: JSON.stringify(metadata).length,
      body: (
        <box flexDirection="column">
          <Show when={stringValue(metadata.operation)}>{(operation) => <text fg={theme.textMuted}>Operation: {operation()}</text>}</Show>
          <Show when={status}>{(item) => <text fg={statusColor(item())}>Status: {item()}</text>}</Show>
          <Show when={stringValue(metadata.guidance)}>{(guidance) => <text fg={theme.text}>{guidance()}</text>}</Show>
          <Show when={metadata.beforeDirty !== undefined || metadata.afterDirty !== undefined}>
            <text fg={theme.textMuted}>Dirty: {String(booleanValue(metadata.beforeDirty))} -&gt; {String(booleanValue(metadata.afterDirty))}</text>
          </Show>
        </box>
      ),
    }
  }

  // #224：NotebookDiff 组件——用 opentui diff 渲染 unified/split diff，根据宽度自动选 view
  function NotebookDiff(diffProps: { diff: string; filePath?: string; maxLines?: number }) {
    return (
      <box paddingLeft={1} maxHeight={diffProps.maxLines} overflow={diffProps.maxLines ? "hidden" : undefined}>
        <diff
          diff={diffProps.diff}
          view={props.width() > 120 ? "split" : "unified"}
          filetype={filetype(diffProps.filePath)}
          syntaxStyle={syntax()}
          showLineNumbers={true}
          width="100%"
          wrapMode={props.diffWrapMode()}
          fg={theme.text}
          addedBg={theme.diffAddedBg}
          removedBg={theme.diffRemovedBg}
          contextBg={theme.diffContextBg}
          addedSignColor={theme.diffHighlightAdded}
          removedSignColor={theme.diffHighlightRemoved}
          lineNumberFg={theme.diffLineNumber}
          lineNumberBg={theme.diffContextBg}
          addedLineNumberBg={theme.diffAddedLineNumberBg}
          removedLineNumberBg={theme.diffRemovedLineNumberBg}
        />
      </box>
    )
  }

  // #224：pending 阶段的 +N/-N 行数标签
  function NotebookPendingStats(statProps: { stats?: PendingToolInputStats }) {
    return (
      <>
        <Show when={statProps.stats?.added}><span style={{ fg: theme.diffAdded }}> +{statProps.stats!.added}</span></Show>
        <Show when={statProps.stats?.removed}><span style={{ fg: theme.diffRemoved }}> -{statProps.stats!.removed}</span></Show>
      </>
    )
  }

  // #224：summary/run 的 cell 列表渲染
  function NotebookCells(cellProps: { cells: Record<string, unknown>[]; runtime?: string; dirty?: boolean }) {
    return (
      <box flexDirection="column">
        <text fg={theme.textMuted}>runtime={cellProps.runtime ?? "unknown"} dirty={String(cellProps.dirty ?? "unknown")}</text>
        <For each={cellProps.cells}>{(cell) => <text fg={execColor(stringValue(cell.exec))}>{cellLine(cell)}</text>}</For>
      </box>
    )
  }

  // #224：run 结果的 cell + artifacts 渲染
  function NotebookRun(runProps: { cells: Record<string, unknown>[] }) {
    const artifacts = artifactRows(runProps.cells)
    return (
      <box flexDirection="column">
        <For each={runProps.cells}>{(cell) => <text fg={execColor(stringValue(cell.exec))}>{cellLine(cell)}</text>}</For>
        <Show when={artifacts.length}>
          <text fg={theme.textMuted}>Artifacts:</text>
          <NotebookArtifacts artifacts={artifacts} />
        </Show>
      </box>
    )
  }

  // #224：artifact 列表渲染
  function NotebookArtifacts(artifactProps: { artifacts: Record<string, unknown>[] }) {
    return (
      <box flexDirection="column">
        <For each={artifactProps.artifacts}>{(artifact) => <text fg={theme.text}>{artifactLine(artifact)}</text>}</For>
      </box>
    )
  }

  // #224：路径格式化——用 pathFormatter 统一显示
  function notebookTarget(value?: string) {
    return value ? pathFormatter.format(value) : "notebook"
  }

  // #224：env 状态颜色——成功绿/失败红/其他默认
  function statusColor(status: string) {
    if (["configured", "selected", "completed", "saved"].includes(status)) return theme.success
    if (["failed", "needs-selection"].includes(status)) return theme.error
    return theme.text
  }

  // #224：cell 执行状态颜色——失败红/跳过灰/其他默认
  function execColor(exec?: string) {
    if (exec?.includes("failed") || exec?.includes("error")) return theme.error
    if (exec?.includes("skipped") || exec?.includes("not-run")) return theme.textMuted
    return theme.text
  }
}

function notebookMetadata(metadata: Record<string, unknown>) {
  const value = metadata.vscodeNotebook
  // #224：非对象或数组的 vscodeNotebook 值不合法，返回 undefined 回退到 generic 渲染
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

// #224：notebook edit 操作标签——insert/delete/edit 三种，与 editType 枚举对齐
function notebookEditLabel(operation?: string) {
  if (operation === "insert") return "Notebook insert"
  if (operation === "delete") return "Notebook delete"
  return "Notebook edit"
}

// #224：非 edit 的 notebook 工具标签——从工具名派生可读名称
// #224：vscode_notebook_run → "Notebook run"，vscode_notebook_source → "Notebook source"
function notebookToolLabel(tool: string) {
  return tool.replace(/^vscode_notebook_/, "Notebook ").replaceAll("_", " ")
}

// #224：diff 路径标签——path + cellLabel + language 组成虚拟文件名供语法高亮
function notebookDiffPath(metadata: Record<string, unknown>) {
  return [stringValue(metadata.path), stringValue(metadata.cellLabel), stringValue(metadata.language) ? `.${stringValue(metadata.language)}` : undefined]
    .filter((item): item is string => Boolean(item))
    .join("")
}

// #224：edit 完成态摘要行——cell 数变化 + dirty 状态 + editType
function summaryLine(metadata: Record<string, unknown>) {
  const before = numberValue(metadata.cellCountBefore)
  const after = numberValue(metadata.cellCountAfter)
  const count = before === undefined || after === undefined ? undefined : `${before} -> ${after} cells`
  return [count, `dirty=${String(booleanValue(metadata.dirty) ?? "unknown")}`, stringValue(metadata.editType)].filter(Boolean).join(" · ")
}

// #224：cell 单行摘要——label/id/kind/lang/lines/exec/outs/first 七段拼接
function cellLine(cell: Record<string, unknown>) {
  return [
    cellLabel(cell),
    stringValue(cell.id),
    [stringValue(cell.kind), stringValue(cell.lang)].filter(Boolean).join("/"),
    numberValue(cell.lines) === undefined ? undefined : `${numberValue(cell.lines)} lines`,
    stringValue(cell.exec),
    arrayStrings(cell.existing_outs).length ? `outs=${arrayStrings(cell.existing_outs).join(",")}` : undefined,
    stringValue(cell.first) ? `first=${JSON.stringify(stringValue(cell.first))}` : undefined,
  ].filter(Boolean).join("  ")
}

// #224：cell 标签——有 index 显示 cN，否则用 id 或默认 'cell'
function cellLabel(cell: Record<string, unknown>) {
  const index = numberValue(cell.i)
  return index === undefined ? stringValue(cell.id) ?? "cell" : `c${index}`
}

// #224：从 run cells 中收集所有 artifacts 供 summary 展示
function artifactRows(cells: Record<string, unknown>[]) {
  return cells.flatMap((cell) => arrayRecords(cell.artifacts))
}

// #224：artifact 单行摘要——mime/bytes/path/preview 四段
function artifactLine(artifact: Record<string, unknown>) {
  return [stringValue(artifact.mime), bytesText(numberValue(artifact.bytes)), stringValue(artifact.artifactPath), stringValue(artifact.preview)].filter(Boolean).join("  ")
}

// #224：env 状态从 saved 布尔值派生——save 操作没有显式 status 字段
function envStatus(metadata: Record<string, unknown>) {
  if (booleanValue(metadata.saved) !== undefined) return booleanValue(metadata.saved) ? "saved" : "save not confirmed"
}

// #224：notebook 内部用的 previewText——截断时用 '…' 省略号行
function previewText(input: string, maxLines: number) {
  const lines = input.split("\n")
  return lines.length > maxLines ? [...lines.slice(0, maxLines), "…"].join("\n") : input
}

// #224：bytes 可读化——小于 1KB 显示 B，否则显示 KB
function bytesText(value?: number) {
  if (value === undefined) return undefined
  if (value < 1024) return `${value} B`
  return `${(value / 1024).toFixed(1)} KB`
}

// #224：类型安全守卫——非对象返回空 Record，避免后续访问报错
function recordValue(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  return value as Record<string, unknown>
}

// #224：类型安全守卫——非数组返回空数组
function arrayRecords(value: unknown) {
  return Array.isArray(value) ? value.flatMap((item) => (item && typeof item === "object" && !Array.isArray(item) ? [item as Record<string, unknown>] : [])) : []
}

// #224：类型安全守卫——过滤出 string 元素
function arrayStrings(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
}

// #224：类型安全守卫——string 提取，非 string 返回 undefined
function stringValue(value: unknown) {
  return typeof value === "string" ? value : undefined
}

// #224：类型安全守卫——有限 number 提取
function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

// #224：类型安全守卫——boolean 提取
function booleanValue(value: unknown) {
  return typeof value === "boolean" ? value : undefined
}
