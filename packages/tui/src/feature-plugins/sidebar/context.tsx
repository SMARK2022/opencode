import type { AssistantMessage } from "@opencode-ai/sdk/v2"
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createMemo } from "solid-js"

const id = "internal:sidebar-context"

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
})

function View(props: { api: TuiPluginApi; session_id: string }) {
  const theme = () => props.api.theme.current
  const msg = createMemo(() => props.api.state.session.messages(props.session_id))
  const session = createMemo(() => props.api.state.session.get(props.session_id))
  const cost = createMemo(() => session()?.cost ?? 0)

  const state = createMemo(() => {
    // 放宽 last 查找条件：不再要求 output > 0，流式输出中也需展示用量
    const last = msg().findLast((item): item is AssistantMessage => item.role === "assistant")
    if (!last) {
      return {
        tokens: 0,
        input: 0,
        output: 0,
        percent: null,
      }
    }

    // 分离输入/输出 token 统计，流式输出时用字符数估算输出 token
    const chars = props.api.state.part(last.id).reduce((sum, part) => {
      if (part.type === "text" && !part.ignored) return sum + part.text.length
      if (part.type === "reasoning") return sum + part.text.length
      return sum
    }, 0)
    // 缓存命中仍占上下文输入，不能因为无需重复生成就从流量中扣除。
    const input = last.tokens.input + last.tokens.cache.read + last.tokens.cache.write
    const outputActual = last.tokens.output + last.tokens.reasoning
    const outputEstimated = Math.round(chars / 4)
    // 流式输出未完成时，取实际值与估算值的较大值，避免用量低估
    const output = last.time.completed ? outputActual : Math.max(outputActual, outputEstimated)
    const tokens = input + output
    // 缺少模型 context limit 时保留 token 实数，不能捏造百分比上限。
    const model = props.api.state.provider.find((item) => item.id === last.providerID)?.models[last.modelID]
    return {
      tokens,
      input,
      output,
      percent: model?.limit.context ? Math.round((tokens / model.limit.context) * 100) : null,
    }
  })

  return (
    <box>
      <text fg={theme().text}>
        <b>Context</b>
      </text>
      {/* 添加输入/输出流量显示 */}
      <text fg={theme().textMuted}>↑ {state().input.toLocaleString()} · ↓ {state().output.toLocaleString()}</text>
      <text fg={theme().textMuted}>{state().tokens.toLocaleString()} tokens</text>
      <text fg={theme().textMuted}>{state().percent ?? 0}% used</text>
      <text fg={theme().textMuted}>{money.format(cost())} spent</text>
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 100,
    slots: {
      sidebar_content(_ctx, props) {
        return <View api={api} session_id={props.session_id} />
      },
    },
  })
}

const plugin: BuiltinTuiPlugin = {
  id,
  tui,
}

export default plugin
