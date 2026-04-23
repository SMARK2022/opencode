import type { AssistantMessage, UserMessage } from "@opencode-ai/sdk/v2"
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createEffect, createMemo, createSignal } from "solid-js"
import { createThrottledSignal, createTokenFlowPulse } from "../../util/signal"
import { getBootstrapInputTokens, computeFinalTokens } from "../../util/token-estimate"

const id = "internal:sidebar-context"

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
})

function View(props: { api: TuiPluginApi; session_id: string }) {
  const theme = () => props.api.theme.current
  const msg = createMemo(() => props.api.state.session.messages(props.session_id))
  const session = createMemo(() => props.api.state.session.get(props.session_id))

  // retry 也属于等待；首次引导不能在重试间隙闪回空闲零值。
  const isRunning = createMemo(() => (props.api.state.session.status(props.session_id)?.type ?? "idle") !== "idle")
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
    // 侧栏和 Prompt 共用引导 owner，synthetic 文件正文也参与首轮输入估算。
    const getParts = (id: string) => props.api.state.part(id)
    const bootstrapInputTokens = getBootstrapInputTokens(messages, request, getParts)
    // 空闲无回复保持全字段零值，避免新 Session 留下上一请求的费用或百分比。
    if (!request || (!request.assistantID && !isRunning())) {
      return { tokens: 0, totalTokens: 0, input: 0, output: 0, totalInput: 0, totalOutput: 0, percent: null, cost: 0 }
    }
    const requestAssistants = assistants.filter((item) => item.id === request?.assistantID)
    const last = requestAssistants.at(-1)
    // 当前 step 确认值由完整请求投影提供，窗口只保留流式字符近似的职责。

    // 参数只含当前助手尾部，不能把其他请求的缓存 parts 传给共享计算。
    const lastParts = last ? props.api.state.part(last.id) : []
    // 确认值低于估算时仍取真实 step，百分比和其他视图保持同一口径。
    const { input, output, totalInput, totalOutput } = computeFinalTokens(last, lastParts, request, bootstrapInputTokens)
    const tokens = input + output
    const totalTokens = totalInput + totalOutput
    // 未确认请求可用其用户模型；已确认 native 请求不依赖用户仍在显示窗口。
    const modelRef = request.model ?? messages.find((item): item is UserMessage => item.role === "user" && item.id === request.messageID)?.model
    const model = modelRef ? props.api.state.provider.find((item) => item.id === modelRef.providerID)?.models[modelRef.modelID] : undefined
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
