import type { AssistantMessage } from "@opencode-ai/sdk/v2"
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { createEffect, createMemo, createSignal } from "solid-js"
import { leadingAndTrailing, throttle } from "@solid-primitives/scheduled"

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
    const last = msg().findLast((item): item is AssistantMessage => item.role === "assistant")
    if (!last) {
      // Always show zeros so the display is visible from the moment a prompt is sent.
      // The sidebar always renders something; there is no hidden/fallback state.
      return { tokens: 0, input: 0, output: 0, percent: null }
    }

    const parts = props.api.state.part(last.id)
    const chars = parts.reduce((sum, part) => {
      if (part.type === "text" && !part.ignored) return sum + part.text.length
      if (part.type === "reasoning") return sum + part.text.length
      return sum
    }, 0)

    // Estimate tokens from tool outputs that arrived after the last step-finish.
    const lastStepFinishIdx = parts.reduce((idx: number, part, i) => (part.type === "step-finish" ? i : idx), -1)
    const toolOutputChars = !last.time.completed
      ? parts.reduce((sum, part, i) => {
          if (i <= lastStepFinishIdx) return sum
          if (part.type === "tool" && part.state.status === "completed") return sum + part.state.output.length
          return sum
        }, 0)
      : 0

    // Sum tokens across all completed steps; last.tokens is per-last-step only (processor.ts overwrites it)
    const cumTokens = parts.reduce(
      (acc, part) => {
        if (part.type !== "step-finish") return acc
        return {
          input: acc.input + part.tokens.input + part.tokens.cache.read + part.tokens.cache.write,
          output: acc.output + part.tokens.output + part.tokens.reasoning,
        }
      },
      { input: 0, output: 0 },
    )
    const inputBase = cumTokens.input
    const input = inputBase + Math.round(toolOutputChars / 4)
    const outputActual = cumTokens.output
    const outputEstimated = Math.round(chars / 4)
    const output = last.time.completed ? outputActual : Math.max(outputActual, outputEstimated)
    const tokens = input + output
    const model = props.api.state.provider.find((item) => item.id === last.providerID)?.models[last.modelID]
    return {
      tokens,
      input,
      output,
      percent: model?.limit.context ? Math.round((tokens / model.limit.context) * 100) : null,
    }
  })

  const [state, setStateThrottled] = createSignal<StateValue>({ tokens: 0, input: 0, output: 0, percent: null })
  const triggerStateUpdate = leadingAndTrailing(throttle, (v: StateValue) => setStateThrottled(() => v), 50)
  createEffect(() => triggerStateUpdate(stateRaw()))

  return (
    <box>
      <text fg={theme().text}>
        <b>Context</b>
      </text>
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

const plugin: TuiPluginModule & { id: string } = {
  id,
  tui,
}

export default plugin
