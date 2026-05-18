// [local-smark] Token accounting and detailed usage tracking
import type { AssistantMessage, UserMessage } from "@opencode-ai/sdk/v2"
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import type { InternalTuiPlugin } from "../../plugin/internal"
import { createEffect, createMemo, createSignal, on, onCleanup } from "solid-js"
import { leadingAndTrailing, throttle } from "@solid-primitives/scheduled"
import { createTokenFlowPulse } from "../../util/signal"
import { tokenAccounting } from "../../util/token-accounting"
import { NetworkProxy } from "@opencode-ai/core/network-proxy"
import { useLocal } from "@tui/context/local"

const id = "internal:sidebar-context"

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
})
const PING_INTERVAL = 1_000

function View(props: { api: TuiPluginApi; session_id: string }) {
  const theme = () => props.api.theme.current
  const local = useLocal()
  const msg = createMemo(() => props.api.state.session.messages(props.session_id))
  // [local-smark] Detailed token accounting state
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
    const getParts = (id: string) => props.api.state.part(id)

    const lastUser = messages.findLast((item) => item.role === "user")
    if (!lastUser) return { tokens: 0, totalTokens: 0, input: 0, output: 0, totalInput: 0, totalOutput: 0, percent: null, cost: 0 }

    const last = messages.findLast((item): item is AssistantMessage => item.role === "assistant" && item.parentID === lastUser.id)
    if (!last) return { tokens: 0, totalTokens: 0, input: 0, output: 0, totalInput: 0, totalOutput: 0, percent: null, cost: 0 }

    const model = props.api.state.provider.find((item) => item.id === last.providerID)?.models[last.modelID]
    const acc = tokenAccounting(messages, getParts, model?.limit.context)

    return {
      tokens: acc.step.input + acc.step.output,
      totalTokens: acc.request.totalInput + acc.request.totalOutput,
      input: acc.step.input,
      output: acc.step.output,
      totalInput: acc.request.totalInput,
      totalOutput: acc.request.totalOutput,
      percent: acc.contextPercent,
      cost: acc.request.cost,
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

  const targetApiUrl = createMemo(() => {
    const selected = local.model.current()
    if (!selected) return null

    const provider = props.api.state.provider.find((item) => item.id === selected.providerID)
    const model = provider?.models[selected.modelID]
    const configuredBaseUrl = provider?.options?.baseURL
    const baseUrl =
      typeof configuredBaseUrl === "string" && configuredBaseUrl !== ""
        ? configuredBaseUrl
        : model?.api.url
    if (typeof baseUrl !== "string" || baseUrl === "") return null

    // Ping the origin only — avoids 404 from appended paths and minimizes
    // server-side processing so the measurement reflects pure network RTT.
    return new URL(baseUrl).origin
  })

  const [latency, setLatency] = createSignal<number | null>(null)
  const [pingStatus, setPingStatus] = createSignal<"ok" | "down" | "init">("init")
  const [isProxy, setIsProxy] = createSignal<boolean>(false)

  createEffect(on(targetApiUrl, (url) => {
    if (!url) {
      setLatency(null)
      setPingStatus("init")
      setIsProxy(false)
      return
    }

    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const ping = async () => {
      if (!active) return

      const t0 = Date.now()
      try {
        const route = await NetworkProxy.resolveProxyRoute(url, "provider")
        if (!active) return
        setIsProxy(route.type === "proxy")

        const res = await NetworkProxy.routedFetch(url, {
          method: "HEAD",
          signal: AbortSignal.timeout(3000),
          purpose: "provider",
        } as RequestInit)
        const elapsed = Date.now() - t0
        if (!active) return

        if (res.status === 502 || res.status === 503 || res.status === 504) {
          setPingStatus("down")
          setLatency(null)
        } else {
          setPingStatus("ok")
          setLatency(elapsed)
        }
      } catch (err: any) {
        if (active) {
          setPingStatus("down")
          setLatency(null)
        }
      }
      if (active) timer = setTimeout(ping, PING_INTERVAL)
    }

    ping()

    onCleanup(() => {
      active = false
      if (timer) clearTimeout(timer)
    })
  }))

  const latencyDisplay = createMemo(() => {
    const icon = isProxy() ? "🌐" : "⚡"
    if (pingStatus() === "init") return { text: `${icon} ...`, fg: theme().textMuted }
    if (pingStatus() === "down") return { text: `${icon} offline`, fg: theme().error }
    const l = latency()!
    const fg = l < 300 ? theme().success : l < 800 ? theme().warning : theme().error
    return { text: `${icon} ${l}ms`, fg }
  })

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
        {state().percent != null ? ` · ${state().percent}%` : ""}
      </text>
      <text fg={theme().textMuted}>
        {money.format(state().cost)} spent
        {targetApiUrl() && (
          <>
            {" · "}
            <span style={{ fg: latencyDisplay().fg }}>{latencyDisplay().text}</span>
          </>
        )}
      </text>
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

const plugin: InternalTuiPlugin = {
  id,
  tui,
}

export default plugin
