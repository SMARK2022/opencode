import { createEffect, createMemo, createSignal, Show } from "solid-js"
import { useRouteData } from "../../context/route"
import { useSync } from "../../context/sync"
import { useTheme } from "../../context/theme"
import { SplitBorder } from "../../ui/border"
import type { AssistantMessage, UserMessage } from "@opencode-ai/sdk/v2"
import { Locale } from "../../util/locale"
import { getContextLimit } from "../../util/token-estimate"
import { tokenAccounting } from "../../util/token-accounting"
// #122：subagent footer 共用 accounting
// #550：retry 门控刷新时钟——只在 retry 态驱动 now 重算，非 retry 不持 interval。
import { createRefreshClock, createThrottledSignal, createTokenFlowPulse } from "../../util/signal"
import { useDialog } from "../../ui/dialog"
import { DialogAlert } from "../../ui/dialog-alert"
import { formatDuration } from "../../util/format"
import { useCommandShortcut, useOpencodeKeymap } from "../../keymap"

export function SubagentFooter() {
  const route = useRouteData("session")
  const sync = useSync()
  // #550：DialogAlert 经全局 dialog 上下文展示 retry 原文。
  const dialog = useDialog()
  const messages = createMemo(() => sync.data.message[route.sessionID] ?? [])
  const session = createMemo(() => sync.session.get(route.sessionID))

  const subagentInfo = createMemo(() => {
    const s = session()
    if (!s) return { label: "Subagent", index: 0, total: 0 }
    // agent 名可含连字符(如 permission-reviewer);\w 不含 '-',\w+ 在连字符处
    // 截断导致正则整体匹配失败,label 回退为泛化的 "Subagent"。[\w-] 补上连字符。
    const agentMatch = s.title.match(/@([\w-]+) subagent/)
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
  // #550：仅认当前 child 的 retry 态——禁止回读 parent 的 status 造成跨会话串味。
  const retry = createMemo(() => {
    const s = status()
    if (s?.type !== "retry") return
    return s
  })
  // #550：countdown 只驱动 UI 重算；attempt/next 边界来自 session_status 的 durable 事件。
  const now = createRefreshClock(() => !!retry())

  // 将 money 提升到组件作用域，避免每次 memo 求值时重建
  const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" })

  // 子代理用数值分开两方向，使仅有工具输入增长时不会同时点亮输出箭头。
  // 子代理只显示自己的当前 step；请求累计交给 sidebar，不借父会话投影。
  // 保留数值输入输出字段，节流和箭头脉冲仍消费原来契约。
  type UsageInfo = { input: number; output: number; context: string | undefined; cost: string | undefined }

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
      return { input: 0, output: 0, context: undefined, cost: undefined }
    }

    // 用户消息淘汰后仍按持久化请求身份取尾部，不能退回全局最后助手。
    const request = session()?.request
    // 子代理只消费自己的服务端请求体估算，不借用父 Session 或本地 bootstrap。
    // 无回复且空闲保持隐藏；运行中使用引导，确认后仍读自己的完整投影。
    if (!request || (!request.assistantID && !isRunning)) {
      if (!isRunning) return
      return { input: 0, output: 0, context: undefined, cost: undefined }
    }
    const requestAssistants = assistants.filter((item) => item.id === request?.assistantID)
    const last = requestAssistants.at(-1)
    // 主值属于当前 step，费用仍属于该子代理的完整当前请求。

    // footer 的缓存只供未确认尾部，助手淘汰后不能丢掉已确认请求累计。
    const lastParts = last ? (sync.data.part[last.id] ?? []) : []
    // 保留 step/request 区别；累计仍参与可见性判断，但不再追加到箭头后。
    // 子会话的 prepared 密度只随它自己的请求读取，父会话与旧模型确认样本不参与。
    // 子代理传自己的完整投影，沿既有节流与费用范围展示统计。
    const {
      input: currentInput,
      output: currentOutput,
      totalInput,
      totalOutput,
    } = tokenAccounting(msg, (id) => sync.data.part[id] ?? [], undefined, {
      session: session(),
      last,
      parts: lastParts,
    }).request
    const requestTokens = currentInput + currentOutput
    const totalTokens = totalInput + totalOutput

    if (requestTokens <= 0 && totalTokens <= 0) {
      if (!isRunning) return
      return { input: 0, output: 0, context: undefined, cost: undefined }
    }

    // 原生模型信息也从当前请求投影读取，不要求先有 V1 助手消息。
    // 用户模型仅用于首次等待；确认模型仍由子代理请求投影提供。
    const modelRef =
      request.model ??
      msg.find((item): item is UserMessage => item.role === "user" && item.id === request.messageID)?.model
    const contextLimit = getContextLimit(
      sync.data.provider,
      modelRef?.providerID,
      modelRef?.modelID,
      request.model?.contextLimit,
    )
    const pct = requestTokens > 0 && contextLimit ? `${Math.round((requestTokens / contextLimit) * 100)}%` : undefined
    // 恢复 footer 的请求费用 hunk，不把子代理 Session.cost 当作请求费用。
    // 仍使用共享费用生产策略和现有 money 格式化，费用不参与箭头增长判断。
    const cost = request.cost
    return {
      input: currentInput,
      output: currentOutput,
      context:
        requestTokens > 0
          ? pct
            ? `${Locale.number(requestTokens)} (${pct})`
            : Locale.number(requestTokens)
          : undefined,
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

  // #550：压平摘要——与主 Prompt footer 同款（含 gemini quota 特例），原文只进详情对话框。
  const retrySummary = createMemo(() => {
    const r = retry()
    if (!r) return
    if (r.message.includes("exceeded your current quota") && r.message.includes("gemini"))
      return "gemini is way too hot right now"
    return r.message.replace(/\s+/g, " ").trim()
  })
  // #550：倒计时元数据——next 差值不足 1s 显示 0，不向上取整（与 Prompt seconds 同口径）。
  // attempt/next 均来自 durable session_status；本组件不猜测重试调度。
  const retryMeta = createMemo(() => {
    const r = retry()
    if (!r) return ""
    const seconds = r.next ? Math.round((r.next - now()) / 1000) : 0
    const duration = formatDuration(seconds)
    return duration ? `retry in ${duration} · #${r.attempt}` : `retry · #${r.attempt}`
  })
  // details 对所有 retry 稳定可用——与 #491 的无阈值合同一致。
  const openRetryDetails = () => {
    const r = retry()
    if (!r) return
    void DialogAlert.show(dialog, "Retry Error", r.message)
  }

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
        <box flexDirection="row" justifyContent="space-between" gap={1} minWidth={0} overflow="hidden">
          <box flexDirection="row" gap={1} minWidth={0} flexGrow={1} flexShrink={1} overflow="hidden">
            <text fg={theme.text} flexShrink={0}>
              <b>{subagentInfo().label}</b>
            </text>
            {/* 计数标签不参与收缩——它是身份信息而非诊断数据。 */}
            <Show when={subagentInfo().total > 0}>
              <text style={{ fg: theme.textMuted }} flexShrink={0}>
                ({subagentInfo().index} of {subagentInfo().total})
              </text>
            </Show>
            {/* #550：retry 红字簇优先于 usage——宽度不足先挤 usage 不挤诊断。 */}
            <Show when={retry()}>
              <box
                minWidth={0}
                flexShrink={1}
                flexDirection="row"
                gap={1}
                overflow="hidden"
                onMouseUp={openRetryDetails}
              >
                <text
                  minWidth={0}
                  flexShrink={1}
                  fg={theme.error}
                  wrapMode="none"
                  truncate
                  onMouseUp={openRetryDetails}
                >
                  {retrySummary()}
                </text>
                <text flexShrink={0} fg={theme.error} wrapMode="none" onMouseUp={openRetryDetails}>
                  (details)
                </text>
                <text flexShrink={0} fg={theme.error} wrapMode="none">
                  {retryMeta()}
                </text>
              </box>
            </Show>
            <Show when={usage()}>
              {(item) => (
                <text fg={theme.textMuted} wrapMode="none" flexShrink={1} minWidth={0} truncate>
                  {/* Show 提供有效 item 后才格式化计数，undefined 的清空快照不进入这段文本。 */}
                  {/* 两方向用空格内聚并保留独立脉冲；context/cost 仍以中点分组。 */}
                  <span style={{ fg: usageFlow().input ? theme.text : theme.textMuted }}>↑</span>{" "}
                  {Locale.number(item().input)}{" "}
                  <span style={{ fg: usageFlow().output ? theme.text : theme.textMuted }}>↓</span>{" "}
                  {Locale.number(item().output)}
                  {item().context ? ` · ${item().context}` : ""}
                  {item().cost ? ` · ${item().cost}` : ""}
                </text>
              )}
            </Show>
          </box>
          {/* #550：nav 不被挤出视口——先由 usage/retry 收缩。 */}
          <box flexDirection="row" gap={2} flexShrink={0}>
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
