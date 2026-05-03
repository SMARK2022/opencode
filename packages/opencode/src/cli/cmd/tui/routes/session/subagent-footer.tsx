import { createEffect, createMemo, createSignal, Show } from "solid-js"
import { useRouteData } from "@tui/context/route"
import { useSync } from "@tui/context/sync"
import { useTheme } from "@tui/context/theme"
import { SplitBorder } from "@tui/component/border"
import type { AssistantMessage, UserMessage } from "@opencode-ai/sdk/v2"
import { useCommandDialog } from "@tui/component/dialog-command"
import { useKeybind } from "../../context/keybind"
import { Locale } from "@/util/locale"
import { sumConfirmed as sharedSumConfirmed, computeFinalTokens, charsPerTokenFromHistory } from "../../util/token-estimate"
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

  type UsageInfo = {
    input: number
    output: number
    totalInput: number
    totalOutput: number
    context: string | undefined
    cost: string | undefined
  }

  const usageRaw = createMemo((): UsageInfo | undefined => {
    const isRunning = (status()?.type ?? "idle") !== "idle"
    const msg = messages()
    const assistants = msg.filter((item): item is AssistantMessage => item.role === "assistant")
    const users = msg.filter((item): item is UserMessage => item.role === "user")

    const getParts = (id: string) => sync.data.part[id] ?? []

    const lastUser = users.at(-1)
    const requestAssistants = lastUser ? assistants.filter((item) => item.parentID === lastUser.id) : []

    if (requestAssistants.length === 0) {
      return
    }

    // 显示规则：外面是当前 step 的估算 token；括号里是当前 user request / agent loop 的累计 token。
    const requestConfirmed = sharedSumConfirmed(requestAssistants, getParts)
    const ratio = charsPerTokenFromHistory(msg, getParts)

    // Add streaming estimates from the last (potentially in-flight) message of current request
    const last = requestAssistants.at(-1)!
    const lastParts = sync.data.part[last.id] ?? []
    const {
      input: currentInput,
      output: currentOutput,
      totalInput,
      totalOutput,
    } = computeFinalTokens(last, lastParts, requestConfirmed, ratio)
    const requestTokens = currentInput + currentOutput
    const totalTokens = totalInput + totalOutput

    if (requestTokens <= 0 && totalTokens <= 0) {
      if (!isRunning) return
      return {
        input: 0,
        output: 0,
        totalInput,
        totalOutput,
        context: undefined,
        cost: undefined,
      }
    }

    const model = sync.data.provider.find((item) => item.id === last.providerID)?.models[last.modelID]
    const pct =
      requestTokens > 0 && model?.limit.context
        ? `${Math.round((requestTokens / model.limit.context) * 100)}%`
        : undefined
    const cost = requestAssistants.reduce((sum, item) => sum + (item.cost || 0), 0)
    return {
      input: currentInput,
      output: currentOutput,
      totalInput,
      totalOutput,
      context: requestTokens > 0 ? (pct ? `${Locale.number(requestTokens)} (${pct})` : Locale.number(requestTokens)) : undefined,
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
                  <span style={{ fg: usageFlow().input ? theme.text : theme.textMuted }}>↑</span> {Locale.number(item().input)}({Locale.number(item().totalInput)}) ·{" "}
                  <span style={{ fg: usageFlow().output ? theme.text : theme.textMuted }}>↓</span> {Locale.number(item().output)}({Locale.number(item().totalOutput)})
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
