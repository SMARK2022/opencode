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

  // sidebar 保持直接可读对象，新增括号累计也随同一节流快照发布。
  // 主值属于请求，total 字段属于全局，不能复用一个变量伪装两种范围。
  // 费用随 token 同一快照发布，不能继续读取独立的会话 cost memo。
  // 零值状态也必须含 cost，避免新请求等待时保留上一请求费用。
  type StateValue = { tokens: number; totalTokens: number; input: number; output: number; totalInput: number; totalOutput: number; percent: number | null; cost: number }

  const stateRaw = createMemo((): StateValue => {
    const messages = msg()
    const assistants = messages.filter((item): item is AssistantMessage => item.role === "assistant")
    // plugin 的 session.get 直通 sync，复用同一服务端投影，不另建 sidebar 私有累计。
    const confirmed = session()?.tokens
    if (!confirmed) {
      return { tokens: 0, totalTokens: 0, input: 0, output: 0, totalInput: 0, totalOutput: 0, percent: null, cost: 0 }
    }

    // plugin 的 session.get 已直通同步 Session，不能另建 sidebar 私有请求账本。
    const request = session()?.request
    // 没有持久化助手才是新请求无回复；用户和早期助手被窗口淘汰不触发此分支。
    if (!request?.assistantID) {
      return { tokens: 0, totalTokens: 0, input: 0, output: 0, totalInput: 0, totalOutput: 0, percent: null, cost: 0 }
    }
    const requestConfirmed = { input: request?.input ?? 0, output: request?.output ?? 0 }
    const requestAssistants = assistants.filter((item) => item.id === request?.assistantID)
    const last = requestAssistants.at(-1)
    // 当前 step 确认值由完整请求投影提供，窗口只保留流式字符近似的职责。

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
    // 两个范围各加入一次当前尾部，stepInput 已排除尚未确认的 V1 尾部。
    const hasInFlightTail = !!last && !last.time.completed && lastParts.some((_, i) => i > lastSFIdx)
    const input = (hasInFlightTail ? 0 : request.stepInput) + Math.round(pendingIn / 4)
    const output = (hasInFlightTail ? 0 : request.stepOutput) + Math.round(streamingOut / 4)
    // 括号保留全部请求轮次，用投影而非缓存 sumConfirmed 保证长请求完整。
    const totalInput = requestConfirmed.input + Math.round(pendingIn / 4)
    const totalOutput = requestConfirmed.output + Math.round(streamingOut / 4)
    const tokens = input + output
    const totalTokens = totalInput + totalOutput
    const model = request?.model ? props.api.state.provider.find((item) => item.id === request.model?.providerID)?.models[request.model.modelID] : undefined
    return {
      tokens,
      totalTokens,
      input,
      output,
      totalInput,
      totalOutput,
      // 没有当前 step 的上下文或模型上限时，保留缺省百分比而不捏造测量值。
      percent: tokens > 0 && model?.limit.context ? Math.round((tokens / model.limit.context) * 100) : null,
      // 请求费用是所有助手 cost 的完整求和，不是最后 step 的费用。
      cost: request.cost,
    }
  })

  // 插件视图始终需要可读对象，用零值而非 undefined 支撑 state().tokens 等直接读取。
  // tokens、input、output、percent 整体发布，避免侧栏在同一帧显示不同版本的统计字段。
  // 初始值补齐 total 字段，保留 50ms 发布节奏与原来的箭头脉冲 API。
  // 保留既有节流与脉冲生命周期，只把请求费用并入同一初始快照。
  const [state, setStateThrottled] = createThrottledSignal<StateValue>({ tokens: 0, totalTokens: 0, input: 0, output: 0, totalInput: 0, totalOutput: 0, percent: null, cost: 0 }, 50)
  createEffect(() => setStateThrottled(stateRaw()))

  // sidebar 总有零值 state，零值到正值可触发增长；tokens/percent 的单独变化不会续期。
  const flow = createTokenFlowPulse(state)

  return (
    <box>
      <text fg={theme().text}>
        <b>Context</b>
      </text>
      {/* 插件主题在渲染时读取，脉冲只存布尔值，不缓存可能被换肤替换的颜色。 */}
      <text fg={theme().textMuted}><span style={{ fg: flow().input ? theme().text : theme().textMuted }}>↑</span> {state().input.toLocaleString()}({state().totalInput.toLocaleString()}) · <span style={{ fg: flow().output ? theme().text : theme().textMuted }}>↓</span> {state().output.toLocaleString()}({state().totalOutput.toLocaleString()})</text>
      <text fg={theme().textMuted}>{state().tokens.toLocaleString()} ({state().totalTokens.toLocaleString()}) tokens</text>
      <text fg={theme().textMuted}>{state().percent != null ? `${state().percent}% of ctx limit` : "—"}</text>
      <text fg={theme().textMuted}>{money.format(state().cost)} spent</text>
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
