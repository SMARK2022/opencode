import type { AssistantMessage, UserMessage } from "@opencode-ai/sdk/v2"
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { createEffect, createMemo, createSignal } from "solid-js"
import { leadingAndTrailing, throttle } from "@solid-primitives/scheduled"
import { createTokenFlowPulse } from "../../util/signal"

const id = "internal:sidebar-context"

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
})

function View(props: { api: TuiPluginApi; session_id: string }) {
  const theme = () => props.api.theme.current
  const msg = createMemo(() => props.api.state.session.messages(props.session_id))

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

    // If no assistant messages yet, show zeros
    if (assistants.length === 0) {
      return { tokens: 0, totalTokens: 0, input: 0, output: 0, totalInput: 0, totalOutput: 0, percent: null, cost: 0 }
    }

    const sumConfirmed = (items: AssistantMessage[]) =>
      items.reduce(
        (acc, a) => {
          const parts = props.api.state.part(a.id)
          const { input, output } = parts.reduce(
            (t, p) => {
              if (p.type !== "step-finish") return t
              return {
                input: t.input + p.tokens.input + p.tokens.cache.read + p.tokens.cache.write,
                output: t.output + p.tokens.output + p.tokens.reasoning,
              }
            },
            { input: 0, output: 0 },
          )
          return { input: acc.input + input, output: acc.output + output }
        },
        { input: 0, output: 0 },
      )

    const lastUser = users.at(-1)
    const requestAssistants = lastUser ? assistants.filter((item) => item.parentID === lastUser.id) : []

    if (requestAssistants.length === 0) {
      return { tokens: 0, totalTokens: 0, input: 0, output: 0, totalInput: 0, totalOutput: 0, percent: null, cost: 0 }
    }

    // 显示规则：外面是最后一个 step 的累计（真实上下文大小）；括号里是当前 user request / agent loop 的累计。
    const requestConfirmed = sumConfirmed(requestAssistants)

    // Add streaming estimates from the last (potentially in-flight) message of current request
    const last = requestAssistants.at(-1)!
    const lastParts = props.api.state.part(last.id)
    const lastSFIdx = lastParts.reduce((idx: number, p, i) => (p.type === "step-finish" ? i : idx), -1)
    const streamingOut = last.time.completed
      ? 0
      : lastParts.reduce((sum, p, i) => {
          if (i <= lastSFIdx) return sum
          if (p.type === "text" && !p.ignored) return sum + p.text.length
          if (p.type === "reasoning") return sum + p.text.length
          if (p.type === "tool" && p.state.status === "pending") return sum + p.state.raw.length
          if (p.type === "tool" && p.state.status !== "pending") return sum + JSON.stringify(p.state.input).length
          return sum
        }, 0)
    const pendingIn = last.time.completed
      ? 0
      : lastParts.reduce((sum, p, i) => {
          if (i <= lastSFIdx) return sum
          if (p.type === "tool" && p.state.status === "completed") return sum + p.state.output.length
          return sum
        }, 0)

    const pendingInputTokens = Math.round(pendingIn / 4)
    const pendingOutputTokens = Math.round(streamingOut / 4)
    const hasInFlightTail = !last.time.completed && lastParts.some((_, i) => i > lastSFIdx)
    const lastStepFinish = [...lastParts].reverse().find((p) => p.type === "step-finish")
    const currentStepInputConfirmed =
      !hasInFlightTail && lastStepFinish
        ? lastStepFinish.tokens.input + lastStepFinish.tokens.cache.read + lastStepFinish.tokens.cache.write
        : 0
    const currentStepOutputConfirmed =
      !hasInFlightTail && lastStepFinish
        ? lastStepFinish.tokens.output + lastStepFinish.tokens.reasoning
        : 0
    const input = currentStepInputConfirmed + pendingInputTokens
    const output = currentStepOutputConfirmed + pendingOutputTokens
    const totalInput = requestConfirmed.input + pendingInputTokens
    const totalOutput = requestConfirmed.output + pendingOutputTokens
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
