import { createEffect, createMemo, createSignal, Show } from "solid-js"
import { useRouteData } from "@tui/context/route"
import { useSync } from "@tui/context/sync"
import { useTheme } from "@tui/context/theme"
import { SplitBorder } from "@tui/component/border"
import type { AssistantMessage } from "@opencode-ai/sdk/v2"
import { useCommandDialog } from "@tui/component/dialog-command"
import { useKeybind } from "../../context/keybind"
import { Locale } from "@/util"
import { createThrottledSignal, createTokenFlowPulse } from "../../util/signal"
import { useTerminalDimensions } from "@opentui/solid"

export function SubagentFooter() {
  const route = useRouteData("session")
  const sync = useSync()
  const messages = createMemo(() => sync.data.message[route.sessionID] ?? [])
  const session = createMemo(() => sync.session.get(route.sessionID))

  const subagentInfo = createMemo(() => {
    const s = session()
    if (!s) return { label: "Subagent", index: 0, total: 0 }
    const agentMatch = s.title.match(/@(\w+) subagent/)
    const label = agentMatch ? Locale.titlecase(agentMatch[1]) : "Subagent"

    if (!s.parentID) return { label, index: 0, total: 0 }

    const siblings = sync.data.session
      .filter((x) => x.parentID === s.parentID)
      .toSorted((a, b) => a.time.created - b.time.created)
    const index = siblings.findIndex((x) => x.id === s.id)

    return { label, index: index + 1, total: siblings.length }
  })

  const status = createMemo(() => sync.data.session_status?.[route.sessionID])

  const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" })

  type UsageInfo = { input: number; output: number; context: string | undefined; cost: string | undefined }

  const usageRaw = createMemo((): UsageInfo | undefined => {
    const isRunning = (status()?.type ?? "idle") !== "idle"
    const msg = messages()
    const assistants = msg.filter((item): item is AssistantMessage => item.role === "assistant")

    // If no assistant messages yet, show zeros when running
    if (assistants.length === 0) {
      if (!isRunning) return
      return { input: 0, output: 0, context: undefined, cost: undefined }
    }

    // Sum confirmed tokens across all assistant messages (each tool-call round creates a new message)
    const last = assistants.at(-1)!
    const agg = assistants.reduce(
      (acc, a) => {
        const parts = sync.data.part[a.id] ?? []
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
    const lastParts = sync.data.part[last.id] ?? []
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

    if (tokens <= 0) {
      if (!isRunning) return
      return { input: 0, output: 0, context: undefined, cost: undefined }
    }

    const model = sync.data.provider.find((item) => item.id === agg.providerID)?.models[agg.modelID]
    const pct = model?.limit.context ? `${Math.round((tokens / model.limit.context) * 100)}%` : undefined
    const cost = msg.reduce((sum, item) => sum + (item.role === "assistant" ? item.cost : 0), 0)
    return {
      input: totalInput,
      output: totalOutput,
      context: pct ? `${Locale.number(tokens)} (${pct})` : Locale.number(tokens),
      cost: cost > 0 ? money.format(cost) : undefined,
    }
  })

  const [usage, setUsageThrottled] = createThrottledSignal<UsageInfo | undefined>(undefined, 50)
  createEffect(() => setUsageThrottled(usageRaw()))
  const usageFlow = createTokenFlowPulse(usage)

  const { theme } = useTheme()
  const keybind = useKeybind()
  const command = useCommandDialog()
  const [hover, setHover] = createSignal<"parent" | "prev" | "next" | null>(null)
  useTerminalDimensions()

  return (
    <box flexShrink={0}>
      <box
        paddingTop={1}
        paddingBottom={1}
        paddingLeft={2}
        paddingRight={1}
        {...SplitBorder}
        border={["left"]}
        borderColor={theme.border}
        flexShrink={0}
        backgroundColor={theme.backgroundPanel}
      >
        <box flexDirection="row" justifyContent="space-between" gap={1}>
          <box flexDirection="row" gap={1}>
            <text fg={theme.text}>
              <b>{subagentInfo().label}</b>
            </text>
            <Show when={subagentInfo().total > 0}>
              <text style={{ fg: theme.textMuted }}>
                ({subagentInfo().index} of {subagentInfo().total})
              </text>
            </Show>
            <Show when={usage()}>
              {(item) => (
                <text fg={theme.textMuted} wrapMode="none">
                  <span style={{ fg: usageFlow().input ? theme.text : theme.textMuted }}>↑</span> {Locale.number(item().input)} ·{" "}
                  <span style={{ fg: usageFlow().output ? theme.text : theme.textMuted }}>↓</span> {Locale.number(item().output)}
                  {item().context ? ` · ${item().context}` : ""}
                  {item().cost ? ` · ${item().cost}` : ""}
                </text>
              )}
            </Show>
          </box>
          <box flexDirection="row" gap={2}>
            <box
              onMouseOver={() => setHover("parent")}
              onMouseOut={() => setHover(null)}
              onMouseUp={() => command.trigger("session.parent")}
              backgroundColor={hover() === "parent" ? theme.backgroundElement : theme.backgroundPanel}
            >
              <text fg={theme.text}>
                Parent <span style={{ fg: theme.textMuted }}>{keybind.print("session_parent")}</span>
              </text>
            </box>
            <box
              onMouseOver={() => setHover("prev")}
              onMouseOut={() => setHover(null)}
              onMouseUp={() => command.trigger("session.child.previous")}
              backgroundColor={hover() === "prev" ? theme.backgroundElement : theme.backgroundPanel}
            >
              <text fg={theme.text}>
                Prev <span style={{ fg: theme.textMuted }}>{keybind.print("session_child_cycle_reverse")}</span>
              </text>
            </box>
            <box
              onMouseOver={() => setHover("next")}
              onMouseOut={() => setHover(null)}
              onMouseUp={() => command.trigger("session.child.next")}
              backgroundColor={hover() === "next" ? theme.backgroundElement : theme.backgroundPanel}
            >
              <text fg={theme.text}>
                Next <span style={{ fg: theme.textMuted }}>{keybind.print("session_child_cycle")}</span>
              </text>
            </box>
          </box>
        </box>
      </box>
    </box>
  )
}
