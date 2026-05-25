import { createMemo, For, Show } from "solid-js"
import { Dynamic } from "solid-js/web"
import { useI18n } from "@opencode-ai/ui/context/i18n"
import { useFileComponent } from "@opencode-ai/ui/context/file"
import type { ToolProps } from "./message-part"
import { BasicTool } from "./basic-tool"
import { resolveFileDiff } from "./session-diff"
import { notebookFields, notebookLine, notebookMetadata, notebookRows, notebookTools, notebookValue } from "./notebook-tool"

export function NotebookTool(props: ToolProps & { title: (typeof notebookTools)[keyof typeof notebookTools] }) {
  const i18n = useI18n()
  const fileComponent = useFileComponent()
  const view = createMemo(() => notebookMetadata(props.metadata.vscodeNotebook))
  const path = () => notebookValue(view()?.path ?? props.input.filePath) ?? ""
  // 与现有文件工具共用diff组件；差分来自实际执行结果，不从newCode重建。
  const patch = createMemo(() => {
    const diff = view()?.diff
    if (typeof diff !== "string" || !diff) return
    return resolveFileDiff({ file: path(), patch: diff })
  })
  const title = () => props.tool === "vscode_notebook_edit" && props.input.editType === "insert" ? i18n.t("ui.notebook.insert") : props.tool === "vscode_notebook_edit" && props.input.editType === "delete" ? i18n.t("ui.notebook.delete") : i18n.t(props.title)
  const cells = () => [...notebookRows(view()?.cells), ...notebookRows(view()?.cell ? [view()?.cell] : [])].filter((cell) => notebookLine(cell))
  return (
    <BasicTool {...props} icon="code-lines" defaultOpen allowOpenWhilePending trigger={{ title: title(), subtitle: path(), args: [notebookValue(view()?.cellLabel ?? props.input.cellId), notebookValue(view()?.editType ?? props.input.operation)].filter((value): value is string => value !== undefined) }}>
      <div data-component="notebook-tool" class="text-13-regular">
        <dl style={{ display: "grid", "grid-template-columns": "max-content 1fr", gap: "4px 12px" }}>
          <For each={notebookFields}>{([key, label]) => <Show when={notebookValue(view()?.[key])}>{(value) => <><dt>{i18n.t(label)}</dt><dd>{value()}</dd></>}</Show>}</For>
        </dl>
        <Show when={patch()}>{(diff) => <Dynamic component={fileComponent} mode="diff" fileDiff={diff()} virtualize={props.virtualizeDiff} onRendered={props.onContentRendered} />}</Show>
        <Show when={view()?.diffOmitted}><p>{i18n.t("ui.notebook.diffOmitted")}</p></Show>
        <Show when={cells().length}>
          <h4>{i18n.t("ui.notebook.cells")}</h4>
          <For each={cells()}>{(cell) => <div>
            <pre style={{ "white-space": "pre-wrap" }}>{notebookLine(cell)}</pre>
            <For each={notebookRows(cell.artifacts)}>{(artifact) => <pre style={{ "white-space": "pre-wrap" }}>{notebookLine(artifact)}</pre>}</For>
          </div>}</For>
        </Show>
        <Show when={notebookRows(view()?.artifacts).length}>
          <h4>{i18n.t("ui.notebook.artifacts")}</h4>
          <For each={notebookRows(view()?.artifacts)}>{(artifact) => <pre style={{ "white-space": "pre-wrap" }}>{notebookLine(artifact)}</pre>}</For>
        </Show>
        <Show when={notebookValue(view()?.guidance)}>{(guidance) => <p style={{ "white-space": "pre-wrap" }}>{guidance()}</p>}</Show>
        <Show when={!view() || view()?.view === "source"}><pre data-scrollable style={{ "white-space": "pre-wrap" }}>{props.output}</pre></Show>
      </div>
    </BasicTool>
  )
}
