import { createEffect, createMemo, createSignal, Show } from "solid-js"
import { useRouteData } from "../../context/route"
import { useSync } from "../../context/sync"
import { useTheme } from "../../context/theme"
import { SplitBorder } from "../../ui/border"
import type { AssistantMessage } from "@opencode-ai/sdk/v2"
import { Locale } from "../../util/locale"
import { createThrottledSignal } from "../../util/signal"
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

  type UsageInfo = { flow: string; context: string | undefined; cost: string | undefined }

  const usageRaw = createMemo((): UsageInfo | undefined => {
    // 会话运行中（非 idle）时即使没有助手回复也显示零值用量
    const isRunning = (status()?.type ?? "idle") !== "idle"
    const msg = messages()
    // 放宽 last 查找条件：不再要求 output > 0，流式输出中也需展示用量
    const last = msg.findLast((item): item is AssistantMessage => item.role === "assistant")

    if (!last) {
      if (!isRunning) return
      // 已发送 prompt 但尚无助手回复时立即显示零值
      return { flow: `↑ ${Locale.number(0)} · ↓ ${Locale.number(0)}`, context: undefined, cost: undefined }
    }

    // 分离输入/输出 token 统计，流式输出时用字符数估算输出 token
    const parts = sync.data.part[last.id] ?? []
    const chars = parts.reduce((sum, part) => {
      if (part.type === "text" && !part.ignored) return sum + part.text.length
      // 子代理可能先流出思考而无正文；reasoning 字符也必须驱动实时输出显示。
      if (part.type === "reasoning") return sum + part.text.length
      return sum
    }, 0)

    // 子代理 footer 只读取当前路由消息的 parts，不把父会话的工具输出混入本轮估算。
    // 仅 completed 工具有稳定 output；pending/running 的部分结果不满足这个估算契约。
    const lastStepFinishIdx = parts.reduce((idx: number, part, i) => (part.type === "step-finish" ? i : idx), -1)
    // 消息完成后撤销工具字符补量，避免离开流式阶段后仍显示临时估算输入。
    const toolOutputChars = !last.time.completed
      ? parts.reduce((sum, part, i) => {
          if (i <= lastStepFinishIdx) return sum
          if (part.type === "tool" && part.state.status === "completed") return sum + part.state.output.length
          return sum
        }, 0)
      : 0

    // 累加所有 step-finish parts 的 token（last.tokens 仅含最后一步）
    const cumTokens = parts.reduce(
      (acc, part) => {
        if (part.type !== "step-finish") return acc
        return {
          input: acc.input + part.tokens.input + part.tokens.cache.read + part.tokens.cache.write,
          output: acc.output + part.tokens.output + part.tokens.reasoning,
        }
      },
      // 首步尚无 step-finish 时累计从零开始，不回退到可能已被覆盖的 last.tokens。
      { input: 0, output: 0 },
    )
    const inputBase = cumTokens.input
    const input = inputBase + Math.round(toolOutputChars / 4)
    const outputActual = cumTokens.output
    const outputEstimated = Math.round(chars / 4)
    // 流式输出未完成时，取实际值与估算值的较大值，避免用量低估
    const output = last.time.completed ? outputActual : Math.max(outputActual, outputEstimated)
    const tokens = input + output
    if (tokens <= 0 && input <= 0 && output <= 0) {
      // 运行中但 token 尚未到达时显示零值，避免 footer 闪烁
      if (!isRunning) return
      return { flow: `↑ ${Locale.number(0)} · ↓ ${Locale.number(0)}`, context: undefined, cost: undefined }
    }

    const model = sync.data.provider.find((item) => item.id === last.providerID)?.models[last.modelID]
    const pct = model?.limit.context ? `${Math.round((tokens / model.limit.context) * 100)}%` : undefined
    const cost = session()?.cost ?? 0

    const money = new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
    })

    return {
      // 添加输入/输出流量显示，用于 footer 展示
      flow: `↑ ${Locale.number(input)} · ↓ ${Locale.number(output)}`,
      context: pct ? `${Locale.number(tokens)} (${pct})` : Locale.number(tokens),
      cost: cost > 0 ? money.format(cost) : undefined,
    }
  })

  // footer 的 Show 以 usage 是否存在决定可见性，空结果必须参与节流而不能被过滤。
  // 此处在组件 owner 下创建计时器；切换导致卸载时，旧 footer 的待发快照由 helper 取消。
  const [usage, setUsageThrottled] = createThrottledSignal<UsageInfo | undefined>(undefined, 50)
  createEffect(() => setUsageThrottled(usageRaw()))

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
                  {[item().flow, item().context, item().cost].filter(Boolean).join(" · ")}
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
