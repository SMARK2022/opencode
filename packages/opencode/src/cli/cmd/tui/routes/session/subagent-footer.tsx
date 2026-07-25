import { createEffect, createMemo, createSignal, Show } from "solid-js"
import { useRouteData } from "@tui/context/route"
import { useSync } from "@tui/context/sync"
import { useTheme } from "@tui/context/theme"
import { useDialog } from "@tui/ui/dialog"
import { DialogAlert } from "@tui/ui/dialog-alert"
import { SplitBorder } from "@tui/component/border"
import { Locale } from "@/util/locale"
import { formatDuration } from "@/util/format"
import { tokenAccounting } from "@/token/accounting"
import { createRefreshClock, createThrottledSignal, createTokenFlowPulse } from "../../util/signal"
import { activeTurnPair } from "../../util/session-pending"
import { useCommandPalette } from "../../context/command-palette"
import { useCommandShortcut } from "../../keymap"

export function SubagentFooter() {
  const route = useRouteData("session")
  const sync = useSync()
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

  const status = createMemo(() => sync.data.session_status?.[route.sessionID])
  // child 无 Prompt；retry 诊断必须挂在本 footer，不能依赖主会话输入栏。
  // task / general / permission-reviewer（auto reviewer）共用此栏，禁止再挂第二套 chrome。
  // 只认当前 route.sessionID 的 status，禁止回读 parent 的 retry 以免串会话。
  const retry = createMemo(() => {
    const s = status()
    if (s?.type !== "retry") return
    return s
  })
  // countdown 只驱动 UI 重算“现在”；attempt/next 边界仍来自 session_status。
  // 不在此模块持有业务计时起点，避免重挂载后与 processor 倒计时分叉。
  const now = createRefreshClock(() => !!retry())

  const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" })

  // 与主面板 prompt 宽屏 compact 同构：只投影当前 step，request 累积由 sidebar 承载。
  type UsageInfo = {
    input: number
    output: number
    context: string | undefined
    cost: string | undefined
  }

  const usageRaw = createMemo((): UsageInfo | undefined => {
    const isRunning = (status()?.type ?? "idle") !== "idle"
    const msg = messages()
    const getParts = (id: string) => sync.data.part[id] ?? []

    // 以活跃轮次对解析当前 assistant，跳过尚未派生 assistant 的 queued orphan user，
    // 避免 subagent footer usage 在 orphan 窗口期归零。
    const pair = activeTurnPair(msg)
    if (!pair?.assistant) return
    const last = pair.assistant

    const model = sync.data.provider.find((item) => item.id === last.providerID)?.models[last.modelID]
    // [local-smark] token accounting for detailed usage tracking
    const acc = tokenAccounting(msg, getParts, model?.limit.context)
    const stepTotal = acc.step.input + acc.step.output
    const requestTotal = acc.request.totalInput + acc.request.totalOutput

    if (stepTotal <= 0 && requestTotal <= 0) {
      if (!isRunning) return
      // running 占位仅维持流量脉冲，不携带 request 累积字段。
      return { input: 0, output: 0, context: undefined, cost: undefined }
    }

    const pct = acc.contextPercent != null ? `${acc.contextPercent}%` : undefined
    return {
      input: acc.step.input,
      output: acc.step.output,
      context: stepTotal > 0 ? (pct ? `${Locale.number(stepTotal)} (${pct})` : Locale.number(stepTotal)) : undefined,
      cost: acc.request.cost > 0 ? money.format(acc.request.cost) : undefined,
    }
  })

  const [usage, setUsageThrottled] = createThrottledSignal<UsageInfo | undefined>(undefined, 50)
  createEffect(() => setUsageThrottled(usageRaw()))
  const usageFlow = createTokenFlowPulse(usage)

  const { theme } = useTheme()
  const command = useCommandPalette()
  const parentShortcut = useCommandShortcut("session.parent")
  const previousShortcut = useCommandShortcut("session.child.previous")
  const nextShortcut = useCommandShortcut("session.child.next")
  const [hover, setHover] = createSignal<"parent" | "prev" | "next" | null>(null)

  // 展示层压平空白；DialogAlert 仍拿 status.message 原文。
  // gemini quota 特例与主 Prompt footer 同条件，避免两处摘要语义漂移。
  const retrySummary = createMemo(() => {
    const r = retry()
    if (!r) return
    if (r.message.includes("exceeded your current quota") && r.message.includes("gemini"))
      return "gemini is way too hot right now"
    return r.message.replace(/\s+/g, " ").trim()
  })
  // attempt/next 来自 SessionStatus.retry；formatDuration 与 Prompt 共用 util。
  const retryMeta = createMemo(() => {
    const r = retry()
    if (!r) return ""
    const seconds = Math.round((r.next - now()) / 1000)
    const duration = formatDuration(seconds)
    return duration ? `retry in ${duration} · #${r.attempt}` : `retry · #${r.attempt}`
  })
  // details 必须走 DialogAlert 原文路径，禁止把压平后的摘要写回 status。
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
        {/* 单行 chrome：label → retry 红字 → usage → 导航；与用户截图同一 footer 行。 */}
        <box flexDirection="row" justifyContent="space-between" gap={1} minWidth={0} overflow="hidden">
          <box flexDirection="row" gap={1} minWidth={0} flexGrow={1} flexShrink={1} overflow="hidden">
            <text fg={theme.text} flexShrink={0}>
              <b>{subagentInfo().label}</b>
            </text>
            <Show when={subagentInfo().total > 0}>
              <text style={{ fg: theme.textMuted }} flexShrink={0}>
                ({subagentInfo().index} of {subagentInfo().total})
              </text>
            </Show>
            {/* 红字诊断优先于 usage：宽度不足时先挤 usage，不能把 error 簇挤没。 */}
            {/* theme.error + truncate：对齐主 Prompt retry 契约，摘要可缩 details/meta 不缩。 */}
            <Show when={retry()}>
              <box minWidth={0} flexShrink={1} flexDirection="row" gap={1} overflow="hidden">
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
                  {/* (details) 与摘要同色且不 truncate，保证窄宽下入口仍可点。 */}
                  <text flexShrink={0} fg={theme.error} wrapMode="none" onMouseUp={openRetryDetails}>
                    (details)
                  </text>
                </box>
                {/* retry meta 固定展示 attempt；倒计时文案可随 now 刷新。 */}
                <text flexShrink={0} fg={theme.error} wrapMode="none">
                  {retryMeta()}
                </text>
              </box>
            </Show>
            {/* usage 在 error 之后：retry 时仍可显示，但不得抢在诊断前占用左簇。 */}
            <Show when={usage()}>
              {(item) => (
                <text fg={theme.textMuted} wrapMode="none" flexShrink={1} minWidth={0} truncate>
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
          {/* 导航固定不收缩，避免长错误把 Parent/Prev/Next 挤出视口。 */}
          <box flexDirection="row" gap={2} flexShrink={0}>
            <box
              onMouseOver={() => setHover("parent")}
              onMouseOut={() => setHover(null)}
              onMouseUp={() => command.run("session.parent")}
              backgroundColor={hover() === "parent" ? theme.backgroundElement : theme.backgroundPanel}
            >
              <text fg={theme.text}>
                Parent <span style={{ fg: theme.textMuted }}>{parentShortcut()}</span>
              </text>
            </box>
            <box
              onMouseOver={() => setHover("prev")}
              onMouseOut={() => setHover(null)}
              onMouseUp={() => command.run("session.child.previous")}
              backgroundColor={hover() === "prev" ? theme.backgroundElement : theme.backgroundPanel}
            >
              <text fg={theme.text}>
                Prev <span style={{ fg: theme.textMuted }}>{previousShortcut()}</span>
              </text>
            </box>
            <box
              onMouseOver={() => setHover("next")}
              onMouseOut={() => setHover(null)}
              onMouseUp={() => command.run("session.child.next")}
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
