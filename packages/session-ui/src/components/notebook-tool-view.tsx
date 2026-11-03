import { createMemo, For, Show } from "solid-js"
import { Dynamic } from "solid-js/web"
import { useI18n } from "@opencode-ai/ui/context/i18n"
import { useFileComponent } from "@opencode-ai/ui/context/file"
import type { ToolProps } from "./message-part"
import { BasicTool } from "./basic-tool"
import { resolveFileDiff } from "./session-diff"
import {
  notebookFields,
  notebookInsertSource,
  notebookLanguage,
  notebookLine,
  notebookMetadata,
  notebookPreviewCells,
  notebookRows,
  notebookTools,
  notebookValue,
} from "./notebook-tool"

export function NotebookTool(props: ToolProps & { title: (typeof notebookTools)[keyof typeof notebookTools] }) {
  const i18n = useI18n()
  const fileComponent = useFileComponent()
  const view = createMemo(() => notebookMetadata(props.metadata.vscodeNotebook))
  const path = () => notebookValue(view()?.path ?? props.input.filePath) ?? ""
  // 与现有文件工具共用diff组件；差分来自实际执行结果，不从newCode重建。
  const inserted = createMemo(() => notebookInsertSource(view()))
  const language = () => notebookLanguage(view()?.language)
  const patch = createMemo(() => {
    const diff = view()?.diff
    if (typeof diff !== "string" || !diff) return
    return { ...resolveFileDiff({ file: path(), patch: diff }), lang: language() }
  })
  const title = () =>
    props.tool === "vscode_notebook_edit" && props.input.editType === "insert"
      ? i18n.t("ui.notebook.insert")
      : props.tool === "vscode_notebook_edit" && props.input.editType === "delete"
        ? i18n.t("ui.notebook.delete")
        : i18n.t(props.title)
  const cells = () =>
    [...notebookRows(view()?.cells), ...notebookRows(view()?.cell ? [view()?.cell] : [])].filter((cell) =>
      notebookLine(cell),
    )
  return (
    <BasicTool
      {...props}
      icon="code-lines"
      defaultOpen
      allowOpenWhilePending
      trigger={(open) => (
        <div class="flex min-w-0 flex-col gap-1 text-left">
          {/* 格序号和可续用句柄同时显示，不能让cN遮住类型替换后的新身份。 */}
          <span>
            {title()} {path()} {notebookValue(view()?.cellLabel)} {notebookValue(view()?.cellId ?? props.input.cellId)}{" "}
            {notebookValue(view()?.editType ?? props.input.operation)}
          </span>
          <Show when={!open()}>
            <For each={notebookPreviewCells(cells())}>
              {(cell) => <pre style={{ "white-space": "pre-wrap" }}>{notebookLine(cell)}</pre>}
            </For>
            <Show when={cells().flatMap((cell) => notebookRows(cell.artifacts)).length}>
              {(count) => <span>{i18n.t("ui.notebook.availableArtifacts", { count: count() })}</span>}
            </Show>
            <Show when={inserted()}>
              {(source) => (
                <pre style={{ "white-space": "pre-wrap" }}>{source().text.split("\n").slice(0, 10).join("\n")}</pre>
              )}
            </Show>
          </Show>
        </div>
      )}
    >
      <div data-component="notebook-tool" class="text-13-regular">
        <dl style={{ display: "grid", "grid-template-columns": "max-content 1fr", gap: "4px 12px" }}>
          <For each={notebookFields}>
            {([key, label]) => (
              <Show when={notebookValue(view()?.[key])}>
                {(value) => (
                  <>
                    <dt>{i18n.t(label)}</dt>
                    <dd>{value()}</dd>
                  </>
                )}
              </Show>
            )}
          </For>
        </dl>
        {/* 插入显示真实源码而非diff头；只有有界预览才给出source工具恢复提示。 */}
        <Show
          when={inserted()}
          fallback={
            <Show when={patch()}>
              {(diff) => (
                <Dynamic
                  component={fileComponent}
                  mode="diff"
                  fileDiff={diff()}
                  virtualize={props.virtualizeDiff}
                  onRendered={props.onContentRendered}
                />
              )}
            </Show>
          }
        >
          {(source) => (
            <>
              <Dynamic
                component={fileComponent}
                mode="text"
                file={{ name: path(), contents: source().text, lang: language() }}
                overflow="scroll"
                onRendered={props.onContentRendered}
              />
              <Show when={source().truncated}>
                <p>{i18n.t("ui.notebook.insertPreviewTruncated")}</p>
              </Show>
            </>
          )}
        </Show>
        <Show when={view()?.diffOmitted && !inserted()}>
          <p>{i18n.t("ui.notebook.diffOmitted")}</p>
        </Show>
        <Show when={cells().length}>
          <h4>{i18n.t("ui.notebook.cells")}</h4>
          <For each={cells()}>
            {(cell) => (
              <div>
                <pre style={{ "white-space": "pre-wrap" }}>{notebookLine(cell)}</pre>
                <For each={notebookRows(cell.artifacts)}>
                  {(artifact) => <pre style={{ "white-space": "pre-wrap" }}>{notebookLine(artifact)}</pre>}
                </For>
              </div>
            )}
          </For>
        </Show>
        <Show when={notebookRows(view()?.artifacts).length}>
          <h4>{i18n.t("ui.notebook.artifacts")}</h4>
          <For each={notebookRows(view()?.artifacts)}>
            {(artifact) => <pre style={{ "white-space": "pre-wrap" }}>{notebookLine(artifact)}</pre>}
          </For>
        </Show>
        <Show when={notebookValue(view()?.guidance)}>
          {(guidance) => <p style={{ "white-space": "pre-wrap" }}>{guidance()}</p>}
        </Show>
        <Show when={!view() || view()?.view === "source"}>
          <pre data-scrollable style={{ "white-space": "pre-wrap" }}>
            {props.output}
          </pre>
        </Show>
      </div>
    </BasicTool>
  )
}
