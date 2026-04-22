import type { AssistantMessage } from "@opencode-ai/sdk/v2"
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
  const cost = createMemo(() => msg().reduce((sum, item) => sum + (item.role === "assistant" ? item.cost : 0), 0))

  type StateValue = { tokens: number; input: number; output: number; percent: number | null }

  const stateRaw = createMemo((): StateValue => {
    const messages = msg()
    const assistants = messages.filter((item): item is AssistantMessage => item.role === "assistant")

    // If no assistant messages yet, show zeros
    if (assistants.length === 0) {
      return { tokens: 0, input: 0, output: 0, percent: null }
    }

    // Sum confirmed tokens across all assistant messages (each tool-call round creates a new message)
    const last = assistants.at(-1)!
    const agg = assistants.reduce(
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
        return { input: acc.input + input, output: acc.output + output, providerID: a.providerID, modelID: a.modelID }
      },
      { input: 0, output: 0, providerID: "", modelID: "" },
    )

    // Add streaming estimates from the last (potentially in-flight) message
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

    const totalInput = agg.input + Math.round(pendingIn / 4)
    const totalOutput = agg.output + Math.round(streamingOut / 4)
    const tokens = totalInput + totalOutput
    const model = props.api.state.provider.find((item) => item.id === agg.providerID)?.models[agg.modelID]
    return {
      tokens,
      input: totalInput,
      output: totalOutput,
      percent: model?.limit.context ? Math.round((tokens / model.limit.context) * 100) : null,
    }
  })

  const [state, setStateThrottled] = createSignal<StateValue>({ tokens: 0, input: 0, output: 0, percent: null })
  const triggerStateUpdate = leadingAndTrailing(throttle, (v: StateValue) => setStateThrottled(() => v), 50)
  createEffect(() => triggerStateUpdate(stateRaw()))
  const flow = createTokenFlowPulse(state)

  return (
    <box>
      <text fg={theme().text}>
        <b>Context</b>
      </text>
      <text fg={theme().textMuted}>
        <span style={{ fg: flow().input ? theme().text : theme().textMuted }}>↑</span> {state().input.toLocaleString()} ·{" "}
        <span style={{ fg: flow().output ? theme().text : theme().textMuted }}>↓</span> {state().output.toLocaleString()}
      </text>
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

const plugin: TuiPluginModule & { id: string } = {
  id,
  tui,
}

export default plugin
