import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { InternalTuiPlugin } from "../../plugin/internal"
import { createMemo, For, Show, createSignal } from "solid-js"

const id = "internal:sidebar-files"

function View(props: { api: TuiPluginApi; session_id: string }) {
  const [open, setOpen] = createSignal(true)
  const theme = () => props.api.theme.current
  const list = createMemo(() => props.api.state.session.diff(props.session_id))
  // diff 是 capped rows，Session summary 是同一 transport 提供的 authoritative totals；两者不可互相反推。
  // summary 缺失时只展示可证明的 rows，禁止猜测完整计数或伪造 truncation。
  const summary = createMemo(() => props.api.state.session.get(props.session_id)?.summary)

  return (
    <Show when={(summary()?.files ?? list().length) > 0}>
      <box>
        <box flexDirection="row" justifyContent="space-between" onMouseDown={() => list().length > 2 && setOpen((x) => !x)}>
          {/* 标题只承载高信息量 totals；不能加入 showing-first 等固定解释文案。 */}
          <box flexDirection="row" gap={1}>
            <Show when={list().length > 2}>
              <text fg={theme().text}>{open() ? "▼" : "▶"}</text>
            </Show>
            <text fg={theme().text}>
              <b>
                Modified Files<Show when={summary()}>{(value) => <> ({value().files})</>}</Show>
              </b>
            </text>
          </box>
          <Show when={summary()}>
            {(value) => (
              <box flexDirection="row" gap={1}>
                <Show when={value().additions}>
                  <text fg={theme().diffAdded}>+{value().additions}</text>
                </Show>
                <Show when={value().deletions}>
                  <text fg={theme().diffRemoved}>-{value().deletions}</text>
                </Show>
              </box>
            )}
          </Show>
        </box>
        <Show when={list().length <= 2 || open()}>
          <For each={list()}>
            {(item) => (
              <box flexDirection="row" gap={1} justifyContent="space-between">
                <text fg={theme().textMuted} wrapMode="none">
                  {item.file}
                </text>
                <box flexDirection="row" gap={1} flexShrink={0}>
                  <Show when={item.additions}>
                    <text fg={theme().diffAdded}>+{item.additions}</text>
                  </Show>
                  <Show when={item.deletions}>
                    <text fg={theme().diffRemoved}>-{item.deletions}</text>
                  </Show>
                </box>
              </box>
            )}
          </For>
          {/* 总数来自同一 diff projection；只有真实截断时才在列表末尾标记，不向标题塞固定说明。 */}
          {/* 默认 open=true 保持既有语义；ellipsis 约束的是结果上限，不是折叠或延迟加载。 */}
          <Show when={list().length === 100 && (summary()?.files ?? list().length) > list().length}>
            <text fg={theme().textMuted}>...</text>
          </Show>
        </Show>
      </box>
    </Show>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 500,
    slots: {
      sidebar_content(_ctx, props) {
        return <View api={api} session_id={props.session_id} />
      },
    },
  })
}

const plugin: InternalTuiPlugin = {
  id,
  tui,
}

export default plugin
