import type { AssistantMessage, UserMessage } from "@opencode-ai/sdk/v2"
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { createEffect, createMemo, createSignal } from "solid-js"
import { leadingAndTrailing, throttle } from "@solid-primitives/scheduled"
import { createTokenFlowPulse } from "../../util/signal"
import { sumConfirmed as sharedSumConfirmed, computeFinalTokens } from "../../util/token-estimate"

const id = "internal:sidebar-context"

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
})

function View(props: { api: TuiPluginApi; session_id: string }) {
  const theme = () => props.api.theme.current
  const msg = createMemo(() => props.api.state.session.messages(props.session_id))
  const isRunning = createMemo(() => (props.api.state.session.status(props.session_id)?.type ?? "idle") !== "idle")

  type StateValue = {
    tokens: number
    totalTokens: number
    input: number
    output: number
    totalInput: number
    totalOutput: number
    percent: number | null
    cost: number
  }

  const stateRaw = createMemo((): StateValue => {
    const messages = msg()
    const assistants = messages.filter((item): item is AssistantMessage => item.role === "assistant")
    const users = messages.filter((item): item is UserMessage => item.role === "user")

    const getParts = (id: string) => props.api.state.part(id)

    const lastUser = users.at(-1)
    const requestAssistants = lastUser ? assistants.filter((item) => item.parentID === lastUser.id) : []

    if (requestAssistants.length === 0) {
      return { tokens: 0, totalTokens: 0, input: 0, output: 0, totalInput: 0, totalOutput: 0, percent: null, cost: 0 }
    }

    // 显示规则：外面是最后一个 step 的累计（真实上下文大小）；括号里是当前 user request / agent loop 的累计。
    const requestConfirmed = sharedSumConfirmed(requestAssistants, getParts)

    // Add streaming estimates from the last (potentially in-flight) message of current request
    const last = requestAssistants.at(-1)!
    const lastParts = props.api.state.part(last.id)
    const {
      input,
      output,
      totalInput,
      totalOutput,
    } = computeFinalTokens(last, lastParts, requestConfirmed)
    const tokens = input + output
    const totalTokens = totalInput + totalOutput
    const model = props.api.state.provider.find((item) => item.id === last.providerID)?.models[last.modelID]

    const cost = requestAssistants.reduce((sum, item) => sum + (item.cost || 0), 0)
    return {
      tokens,
      totalTokens,
      input,
      output,
      totalInput,
      totalOutput,
      percent: tokens > 0 && model?.limit.context ? Math.round((tokens / model.limit.context) * 100) : null,
      cost,
    }
  })

  const [state, setStateThrottled] = createSignal<StateValue>({
    tokens: 0,
    totalTokens: 0,
    input: 0,
    output: 0,
    totalInput: 0,
    totalOutput: 0,
    percent: null,
    cost: 0,
  })
  const triggerStateUpdate = leadingAndTrailing(throttle, (v: StateValue) => setStateThrottled(() => v), 50)
  createEffect(() => triggerStateUpdate(stateRaw()))
  const flow = createTokenFlowPulse(state)

  return (
    <box>
      <text fg={theme().text}>
        <b>Context</b>
      </text>
      <text fg={theme().textMuted}>
        <span style={{ fg: flow().input ? theme().text : theme().textMuted }}>↑</span> {state().input.toLocaleString()}({state().totalInput.toLocaleString()}) ·{" "}
        <span style={{ fg: flow().output ? theme().text : theme().textMuted }}>↓</span> {state().output.toLocaleString()}({state().totalOutput.toLocaleString()})
      </text>
      <text fg={theme().textMuted}>
        {state().tokens.toLocaleString()} ({state().totalTokens.toLocaleString()}) tokens
      </text>
      <text fg={theme().textMuted}>
        {state().percent != null ? `${state().percent}% of ctx limit` : "—"}
      </text>
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

const plugin: TuiPluginModule & { id: string } = {
  id,
  tui,
}

export default plugin
