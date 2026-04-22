import type { AssistantMessage } from "@opencode-ai/sdk/v2"
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createEffect, createMemo, createSignal } from "solid-js"
import { createThrottledSignal, createTokenFlowPulse } from "../../util/signal"

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

  type StateValue = { tokens: number; input: number; output: number; percent: number | null }

  const stateRaw = createMemo((): StateValue => {
    const messages = msg()
    const assistants = messages.filter((item): item is AssistantMessage => item.role === "assistant")
    // plugin 的 session.get 直通 sync，复用同一服务端投影，不另建 sidebar 私有累计。
    const confirmed = session()?.tokens
    if (!confirmed) {
      return { tokens: 0, input: 0, output: 0, percent: null }
    }

    // 本项仍是会话 all-assistant 总量，不能提前引入 parentID 请求筛选。
    const last = assistants.at(-1)
    const agg = {
      input: confirmed.input + confirmed.cache.read + confirmed.cache.write,
      output: confirmed.output + confirmed.reasoning,
    }

    // 从最后一条消息添加流式估算
    const lastParts = last ? props.api.state.part(last.id) : []
    const lastSFIdx = lastParts.reduce((idx: number, p, i) => (p.type === "step-finish" ? i : idx), -1)
    // 流式输出：text/reasoning + pending 工具 raw + completed 工具 input
    const streamingOut = !last || last.time.completed
      ? 0
      : lastParts.reduce((sum, p, i) => {
          if (i <= lastSFIdx) return sum
          if (p.type === "text" && !p.ignored) return sum + p.text.length
          if (p.type === "reasoning") return sum + p.text.length
          // pending 工具的 state.raw 由 processor.ts 累积流式 delta。
          if (p.type === "tool" && p.state.status === "pending") return sum + p.state.raw.length
          if (p.type === "tool" && p.state.status !== "pending") return sum + JSON.stringify(p.state.input).length
          return sum
        }, 0)
    // 流式输入：最后一个 step-finish 之后的 completed 工具输出
    const pendingIn = !last || last.time.completed
      ? 0
      : lastParts.reduce((sum, p, i) => {
          if (i <= lastSFIdx) return sum
          if (p.type === "tool" && p.state.status === "completed") return sum + p.state.output.length
          return sum
        }, 0)

    // 缺少模型 context limit 时保留 token 实数，不能捏造百分比上限。
    const totalInput = agg.input + Math.round(pendingIn / 4)
    const totalOutput = agg.output + Math.round(streamingOut / 4)
    const tokens = totalInput + totalOutput
    const model = last ? props.api.state.provider.find((item) => item.id === last.providerID)?.models[last.modelID] : undefined
    return {
      tokens,
      input: totalInput,
      output: totalOutput,
      percent: model?.limit.context ? Math.round((tokens / model.limit.context) * 100) : null,
    }
  })

  // 插件视图始终需要可读对象，用零值而非 undefined 支撑 state().tokens 等直接读取。
  // tokens、input、output、percent 整体发布，避免侧栏在同一帧显示不同版本的统计字段。
  const [state, setStateThrottled] = createThrottledSignal<StateValue>({ tokens: 0, input: 0, output: 0, percent: null }, 50)
  createEffect(() => setStateThrottled(stateRaw()))

  // sidebar 总有零值 state，零值到正值可触发增长；tokens/percent 的单独变化不会续期。
  const flow = createTokenFlowPulse(state)

  return (
    <box>
      <text fg={theme().text}>
        <b>Context</b>
      </text>
      {/* 插件主题在渲染时读取，脉冲只存布尔值，不缓存可能被换肤替换的颜色。 */}
      <text fg={theme().textMuted}><span style={{ fg: flow().input ? theme().text : theme().textMuted }}>↑</span> {state().input.toLocaleString()} · <span style={{ fg: flow().output ? theme().text : theme().textMuted }}>↓</span> {state().output.toLocaleString()}</text>
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
