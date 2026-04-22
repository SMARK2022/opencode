import { createEffect, createMemo, createSignal, Show } from "solid-js"
import { useRouteData } from "../../context/route"
import { useSync } from "../../context/sync"
import { useTheme } from "../../context/theme"
import { SplitBorder } from "../../ui/border"
import type { AssistantMessage } from "@opencode-ai/sdk/v2"
import { Locale } from "../../util/locale"
import { createThrottledSignal, createTokenFlowPulse } from "../../util/signal"
import { useTerminalDimensions } from "@opentui/solid"
import { useCommandShortcut, useOpencodeKeymap } from "../../keymap"

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

  // 获取会话状态，用于判断是否正在运行
  // 子代理有独立 sessionID，必须读取其自身状态而非父请求的运行状态。
  const status = createMemo(() => sync.data.session_status?.[route.sessionID])

  // 将 money 提升到组件作用域，避免每次 memo 求值时重建
  const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" })

  // 子代理用数值分开两方向，使仅有工具输入增长时不会同时点亮输出箭头。
  // 子代理主值与括号使用自己的请求/全局范围，不能读父会话请求投影。
  // 保留数值输入输出字段，节流和箭头脉冲仍消费原来契约。
  type UsageInfo = { input: number; output: number; totalInput: number; totalOutput: number; context: string | undefined; cost: string | undefined }

  const usageRaw = createMemo((): UsageInfo | undefined => {
    // 会话运行中（非 idle）时即使没有助手回复也显示零值用量
    const isRunning = (status()?.type ?? "idle") !== "idle"
    const msg = messages()
    const assistants = msg.filter((item): item is AssistantMessage => item.role === "assistant")
    // 子代理使用自己的全量投影，不能把父会话的工具轮次并入子代理流量。
    const confirmed = session()?.tokens

    if (!confirmed) {
      if (!isRunning) return
      // 零值仍是有效运行快照，随后增长能与零基线比较。
      return { input: 0, output: 0, totalInput: 0, totalOutput: 0, context: undefined, cost: undefined }
    }

    // 用户消息淘汰后仍按持久化请求身份取尾部，不能退回全局最后助手。
    const request = session()?.request
    // 子代理也按自己的持久化回复身份判空，不能用父请求或有限缓存补偿。
    if (!request?.assistantID) {
      if (!isRunning) return
      return { input: 0, output: 0, totalInput: 0, totalOutput: 0, context: undefined, cost: undefined }
    }
    const requestConfirmed = { input: request?.input ?? 0, output: request?.output ?? 0 }
    const requestAssistants = assistants.filter((item) => item.id === request?.assistantID)
    const last = requestAssistants.at(-1)
    // 主值属于当前 step；括号与费用都属于该子代理的完整当前请求。

    // 从最后一条消息添加流式估算
    const lastParts = last ? (sync.data.part[last.id] ?? []) : []
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
    // 最后一个 step-finish 后的 completed 工具输出将在下一轮 API 调用中计入输入，当前仅作流式估算。
    const pendingIn = !last || last.time.completed
      ? 0
      : lastParts.reduce((sum, p, i) => {
          if (i <= lastSFIdx) return sum
          if (p.type === "tool" && p.state.status === "completed") return sum + p.state.output.length
          return sum
        }, 0)

    // native 每步确认值也在投影中，不能因没有 V1 parts 而退回零历史累计。
    const hasInFlightTail = !!last && !last.time.completed && lastParts.some((_, i) => i > lastSFIdx)
    const currentInput = (hasInFlightTail ? 0 : request.stepInput) + Math.round(pendingIn / 4)
    const currentOutput = (hasInFlightTail ? 0 : request.stepOutput) + Math.round(streamingOut / 4)
    // 请求累计与 step 确认值独立，流式尾部在各自范围只计一次。
    const totalInput = requestConfirmed.input + Math.round(pendingIn / 4)
    const totalOutput = requestConfirmed.output + Math.round(streamingOut / 4)
    const requestTokens = currentInput + currentOutput
    const totalTokens = totalInput + totalOutput

    if (requestTokens <= 0 && totalTokens <= 0) {
      if (!isRunning) return
      return { input: 0, output: 0, totalInput, totalOutput, context: undefined, cost: undefined }
    }

    // 原生模型信息也从当前请求投影读取，不要求先有 V1 助手消息。
    const model = request?.model ? sync.data.provider.find((item) => item.id === request.model?.providerID)?.models[request.model.modelID] : undefined
    const pct = requestTokens > 0 && model?.limit.context ? `${Math.round((requestTokens / model.limit.context) * 100)}%` : undefined
    // 恢复 footer 的请求费用 hunk，不把子代理 Session.cost 当作请求费用。
    // 仍使用共享费用生产策略和现有 money 格式化，费用不参与箭头增长判断。
    const cost = request.cost
    return {
      input: currentInput,
      output: currentOutput,
      totalInput,
      totalOutput,
      context: requestTokens > 0 ? (pct ? `${Locale.number(requestTokens)} (${pct})` : Locale.number(requestTokens)) : undefined,
      cost: cost > 0 ? money.format(cost) : undefined,
    }
  })

  // footer 的 Show 以 usage 是否存在决定可见性，空结果必须参与节流而不能被过滤。
  // 此处在组件 owner 下创建计时器；切换导致卸载时，旧 footer 的待发快照由 helper 取消。
  const [usage, setUsageThrottled] = createThrottledSignal<UsageInfo | undefined>(undefined, 50)
  createEffect(() => setUsageThrottled(usageRaw()))

  // 在 footer owner 内观察完整 usage 生命周期，Show 暂时隐藏不会另外创建一套脉冲计时器。
  const usageFlow = createTokenFlowPulse(usage)

  const { theme } = useTheme()
  const keymap = useOpencodeKeymap()
  const parentShortcut = useCommandShortcut("session.parent")
  const previousShortcut = useCommandShortcut("session.child.previous")
  const nextShortcut = useCommandShortcut("session.child.next")
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
                  {/* Show 提供有效 item 后才格式化计数，undefined 的清空快照不进入这段文本。 */}
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
              onMouseUp={() => keymap.dispatchCommand("session.parent")}
              backgroundColor={hover() === "parent" ? theme.backgroundElement : theme.backgroundPanel}
            >
              <text fg={theme.text}>
                Parent <span style={{ fg: theme.textMuted }}>{parentShortcut()}</span>
              </text>
            </box>
            <box
              onMouseOver={() => setHover("prev")}
              onMouseOut={() => setHover(null)}
              onMouseUp={() => keymap.dispatchCommand("session.child.previous")}
              backgroundColor={hover() === "prev" ? theme.backgroundElement : theme.backgroundPanel}
            >
              <text fg={theme.text}>
                Prev <span style={{ fg: theme.textMuted }}>{previousShortcut()}</span>
              </text>
            </box>
            <box
              onMouseOver={() => setHover("next")}
              onMouseOut={() => setHover(null)}
              onMouseUp={() => keymap.dispatchCommand("session.child.next")}
              backgroundColor={hover() === "next" ? theme.backgroundElement : theme.backgroundPanel}
            >
              <text fg={theme.text}>
                Next <span style={{ fg: theme.textMuted }}>{nextShortcut()}</span>
              </text>
            </box>
          </box>
        </box>
      </box>
    </box>
  )
}
