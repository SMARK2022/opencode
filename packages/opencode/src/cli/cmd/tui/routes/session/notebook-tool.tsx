import { createMemo, For, Show, type Accessor } from "solid-js"
import type { JSX } from "@opentui/solid"
import type { PendingToolInputStats } from "./pending-tool-input"
import { useTheme } from "../../context/theme"
import { usePathFormatter } from "../../context/path-format"
import { previewDiff } from "@tui/util/preview-diff"
import { LANGUAGE_EXTENSIONS } from "@/lsp/language"

// 这个文件只负责把 metadata.vscodeNotebook 翻译成 GenericTool 可消费的
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
    // 完成态优先使用 plugin 写入的 compact metadata；pending/running 阶段 metadata
    // 尚不存在，只能用 streaming raw parser 提供的 file/cell/+/- 摘要，避免读 VS Code。
    const metadata = notebookMetadata(props.metadata())
    if (metadata) return blockView(metadata, props.output())
    if (!props.tool().startsWith("vscode_notebook_")) return undefined
    return inlineView(props.tool(), props.input(), props.status(), props.pendingStats())
  })

  function blockView(metadata: Record<string, unknown>, output: string): VscodeNotebookToolView | undefined {
    const view = stringValue(metadata.view)
    if (view === "edit") return editView(metadata)
    if (view === "summary") return summaryView(metadata)
    if (view === "source") return textView(metadata, output, "Notebook source")
    if (view === "run") return runView(metadata)
    if (view === "output") return outputView(metadata)
    if (view === "env") return envView(metadata)
  }

  function inlineView(tool: string, input: Record<string, unknown>, status: string, stats?: PendingToolInputStats): VscodeNotebookToolView {
    const op = stats?.operation ?? stringValue(input.editType) ?? stringValue(input.operation) ?? tool.replace("vscode_notebook_", "")
    const target = notebookTarget(stringValue(input.filePath) ?? stats?.filePath)
    const cell = stats?.cellId ?? stringValue(input.cellId)
    const label = tool === "vscode_notebook_edit" ? notebookEditLabel(op) : notebookToolLabel(tool)
    const lineStats = <NotebookPendingStats stats={stats} />
    const content = (
      <>
        {label} <Show when={target}>{target}</Show> <Show when={cell}>{cell}</Show>{lineStats}
      </>
    )
    return {
      mode: "inline",
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

  function editView(metadata: Record<string, unknown>): VscodeNotebookToolView {
    const diff = stringValue(metadata.diff) ?? ""
    const stats = { added: numberValue(metadata.added) ?? 0, removed: numberValue(metadata.removed) ?? 0 }
    const title = [
      "←",
      notebookEditLabel(stringValue(metadata.editType)),
      notebookTarget(stringValue(metadata.path)),
      stringValue(metadata.cellLabel) ?? stringValue(metadata.cellId),
      stats.added > 0 || stats.removed > 0 ? `+${stats.added} -${stats.removed}` : undefined,
    ].filter(Boolean).join(" ")
    const filePath = notebookDiffPath(metadata)
    return {
      mode: "block",
      title,
      maxLines: 10,
      threshold: 20,
      totalLines: diff.split("\n").length,
      totalChars: diff.length,
      preview: diff ? <NotebookDiff diff={previewDiff(diff, 10)} filePath={filePath} maxLines={10} /> : undefined,
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

  function NotebookPendingStats(statProps: { stats?: PendingToolInputStats }) {
    return (
      <>
        <Show when={statProps.stats?.added}><span style={{ fg: theme.diffAdded }}> +{statProps.stats!.added}</span></Show>
        <Show when={statProps.stats?.removed}><span style={{ fg: theme.diffRemoved }}> -{statProps.stats!.removed}</span></Show>
      </>
    )
  }

  function NotebookCells(cellProps: { cells: Record<string, unknown>[]; runtime?: string; dirty?: boolean }) {
    return (
      <box flexDirection="column">
        <text fg={theme.textMuted}>runtime={cellProps.runtime ?? "unknown"} dirty={String(cellProps.dirty ?? "unknown")}</text>
        <For each={cellProps.cells}>{(cell) => <text fg={execColor(stringValue(cell.exec))}>{cellLine(cell)}</text>}</For>
      </box>
    )
  }

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

  function NotebookArtifacts(artifactProps: { artifacts: Record<string, unknown>[] }) {
    return (
      <box flexDirection="column">
        <For each={artifactProps.artifacts}>{(artifact) => <text fg={theme.text}>{artifactLine(artifact)}</text>}</For>
      </box>
    )
  }

  function notebookTarget(value?: string) {
    return value ? pathFormatter.format(value) : "notebook"
  }

  function statusColor(status: string) {
    if (["configured", "selected", "completed", "saved"].includes(status)) return theme.success
    if (["failed", "needs-selection"].includes(status)) return theme.error
    return theme.text
  }

  function execColor(exec?: string) {
    if (exec?.includes("failed") || exec?.includes("error")) return theme.error
    if (exec?.includes("skipped") || exec?.includes("not-run")) return theme.textMuted
    return theme.text
  }
}

function notebookMetadata(metadata: Record<string, unknown>) {
  const value = metadata.vscodeNotebook
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function notebookEditLabel(operation?: string) {
  if (operation === "insert") return "Notebook insert"
  if (operation === "delete") return "Notebook delete"
  return "Notebook edit"
}

function notebookToolLabel(tool: string) {
  return tool.replace(/^vscode_notebook_/, "Notebook ").replaceAll("_", " ")
}

function notebookDiffPath(metadata: Record<string, unknown>) {
  return [stringValue(metadata.path), stringValue(metadata.cellLabel), stringValue(metadata.language) ? `.${stringValue(metadata.language)}` : undefined]
    .filter((item): item is string => Boolean(item))
    .join("")
}

function summaryLine(metadata: Record<string, unknown>) {
  const before = numberValue(metadata.cellCountBefore)
  const after = numberValue(metadata.cellCountAfter)
  const count = before === undefined || after === undefined ? undefined : `${before} -> ${after} cells`
  return [count, `dirty=${String(booleanValue(metadata.dirty) ?? "unknown")}`, stringValue(metadata.editType)].filter(Boolean).join(" · ")
}

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

function cellLabel(cell: Record<string, unknown>) {
  const index = numberValue(cell.i)
  return index === undefined ? stringValue(cell.id) ?? "cell" : `c${index}`
}

function artifactRows(cells: Record<string, unknown>[]) {
  return cells.flatMap((cell) => arrayRecords(cell.artifacts))
}

function artifactLine(artifact: Record<string, unknown>) {
  return [stringValue(artifact.mime), bytesText(numberValue(artifact.bytes)), stringValue(artifact.artifactPath), stringValue(artifact.preview)].filter(Boolean).join("  ")
}

function envStatus(metadata: Record<string, unknown>) {
  if (booleanValue(metadata.saved) !== undefined) return booleanValue(metadata.saved) ? "saved" : "save not confirmed"
}

function previewText(input: string, maxLines: number) {
  const lines = input.split("\n")
  return lines.length > maxLines ? [...lines.slice(0, maxLines), "…"].join("\n") : input
}

function filetype(input?: string) {
  const ext = input?.match(/\.[^.]+$/)?.[0]
  const language = ext ? LANGUAGE_EXTENSIONS[ext] : undefined
  if (language && ["typescriptreact", "javascriptreact", "javascript"].includes(language)) return "typescript"
  return language
}

function bytesText(value?: number) {
  if (value === undefined) return undefined
  if (value < 1024) return `${value} B`
  return `${(value / 1024).toFixed(1)} KB`
}

function recordValue(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  return value as Record<string, unknown>
}

function arrayRecords(value: unknown) {
  return Array.isArray(value) ? value.flatMap((item) => (item && typeof item === "object" && !Array.isArray(item) ? [item as Record<string, unknown>] : [])) : []
}

function arrayStrings(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
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
