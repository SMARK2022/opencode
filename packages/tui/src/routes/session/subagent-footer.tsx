import { createEffect, createMemo, createSignal, Show } from "solid-js"
import { useRouteData } from "../../context/route"
import { useSync } from "../../context/sync"
import { useTheme } from "../../context/theme"
import { SplitBorder } from "../../ui/border"
import type { AssistantMessage, UserMessage } from "@opencode-ai/sdk/v2"
import { Locale } from "../../util/locale"
import { computeFinalTokens, getContextLimit } from "../../util/token-estimate"
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
    // 子代理只消费自己的服务端请求体估算，不借用父 Session 或本地 bootstrap。
    // 无回复且空闲保持隐藏；运行中使用引导，确认后仍读自己的完整投影。
    if (!request || (!request.assistantID && !isRunning)) {
      if (!isRunning) return
      return { input: 0, output: 0, totalInput: 0, totalOutput: 0, context: undefined, cost: undefined }
    }
    const requestAssistants = assistants.filter((item) => item.id === request?.assistantID)
    const last = requestAssistants.at(-1)
    // 主值属于当前 step；括号与费用都属于该子代理的完整当前请求。

    // footer 的缓存只供未确认尾部，助手淘汰后不能丢掉已确认请求累计。
    const lastParts = last ? (sync.data.part[last.id] ?? []) : []
    // 保留 #14 的 step/request 区别；共享估算不会把全局 tokens 填入括号。
    // 子会话的 prepared 密度只随它自己的请求读取，父会话与旧模型确认样本不参与。
    const { input: currentInput, output: currentOutput, totalInput, totalOutput } = computeFinalTokens(last, lastParts, request)
    const requestTokens = currentInput + currentOutput
    const totalTokens = totalInput + totalOutput

    if (requestTokens <= 0 && totalTokens <= 0) {
      if (!isRunning) return
      return { input: 0, output: 0, totalInput, totalOutput, context: undefined, cost: undefined }
    }

    // 原生模型信息也从当前请求投影读取，不要求先有 V1 助手消息。
    // 用户模型仅用于首次等待；确认模型仍由子代理请求投影提供。
    const modelRef = request.model ?? msg.find((item): item is UserMessage => item.role === "user" && item.id === request.messageID)?.model
    const contextLimit = getContextLimit(sync.data.provider, modelRef?.providerID, modelRef?.modelID, request.model?.contextLimit)
    const pct = requestTokens > 0 && contextLimit ? `${Math.round((requestTokens / contextLimit) * 100)}%` : undefined
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
