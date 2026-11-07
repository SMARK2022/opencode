import {
  batch,
  createContext,
  createEffect,
  createMemo,
  createSignal,
  For,
  Match,
  on,
  onCleanup,
  onMount,
  Show,
  Switch,
  untrack,
  useContext,
} from "solid-js"
import { createStore, produce } from "solid-js/store"
import { sessionMessageContentWidth } from "./layout"
import { goalContinuation } from "./goal-continuation"
import { createRequestUsage } from "./request-usage"

// #185：可见 part 判定（空 text / 隐藏 completed tool 不占首距）
export const isVisibleAssistantPart = (
  part: { type?: string; tool?: string; text?: string; state?: { status?: string; metadata?: { partial?: unknown }; structured?: unknown } },
  opts: { showDetails: boolean; showThinking: boolean },
) => {
  // #185：text 仅非空可见
  if (part.type === "text") return Boolean((part.text ?? "").trim())
  // #185：reasoning 受 thinking 开关约束
  if (part.type === "reasoning") return opts.showThinking && Boolean((part.text ?? "").trim())
  if (part.type === "tool") {
    // #185：详情关闭时隐藏已完成工具
    // #244：completed 的 glob/grep 携带 partial=true 时豁免——details 关闭会折叠
    // 输出，part 可见性是「搜索不完整」的唯一信号（源 isIncompleteSearch 语义）
    const completedPartialSearch =
      (part.tool === "glob" || part.tool === "grep") &&
      part.state?.status === "completed" &&
      (part.state?.metadata?.partial === true || toolDisplayMetadata(part.state).partial === true)
    if (!opts.showDetails && part.state?.status === "completed" && !completedPartialSearch) return false
    return true
  }
  return true
}

import path from "node:path"
import { mkdir, writeFile } from "node:fs/promises"
import { useRoute, useRouteData } from "../../context/route"
import { useProject } from "../../context/project"
import { useSync } from "../../context/sync"
import { useEvent } from "../../context/event"
import { SplitBorder } from "../../ui/border"
import { useTuiPaths } from "../../context/runtime"
import { Spinner } from "../../component/spinner"
import { createSyntaxStyleMemo, generateSubtleSyntax, selectedForeground, useTheme } from "../../context/theme"
import {
  BoxRenderable,
  CodeRenderable,
  ScrollBoxRenderable,
  addDefaultParsers,
  TextAttributes,
  RGBA,
  MouseButton,
  type MouseEvent,
  type OptimizedBuffer,
  type Renderable,
  TextBuffer,
  TextBufferView,
  type WidthMethod,
} from "@opentui/core"
import { Prompt, type PromptRef } from "../../component/prompt"
import { drawSmoothScrollbar, type SmoothScrollbarMarker } from "../../util/smooth-scrollbar"
import { ConnectionError } from "../../util/connection-error"
import { previewDiff } from "../../util/preview-diff"
import {
  // #187：formatPendingCounts/formatPendingPathLabel 仅供测试消费，不在生产 index 导入
  createPendingToolInputParser,
  PENDING_TOOL_INPUT_PROGRESS_INTERVAL,
  type PendingToolInputStats,
} from "./pending-tool-input"
// #224：notebook 工具的 inline/block 视图 seam——把 metadata.vscodeNotebook 翻译成 GenericTool 可消费的描述
import { useVscodeNotebookToolView } from "./notebook-tool"
// #154：pending/streaming 判定抽到 util，便于单测与去重
import {
  assistantTurnDuration,
  pendingAssistantIndex,
  shouldCullSessionViewport,
  shouldRefreshStaleBusyStatus,
  // 裁剪判定收敛到 util：V1 主视口与 helper 单测共用同一语义；流式判定随 streamingActive 一并移交 helper。
} from "../../util/session-pending"
import type {
  AssistantMessage,
  Part,
  Provider,
  ToolPart,
  UserMessage,
  TextPart,
  ReasoningPart,
  SessionStatus,
} from "@opencode-ai/sdk/v2"
import { useLocal } from "../../context/local"
import { Locale } from "../../util/locale"
import { withinMarkdownBudget } from "../../util/text-budget"
import { toolDisplayMetadata, webSearchProviderLabel } from "../../util/tool-display"
import { Dynamic, useRenderer, useTerminalDimensions, type JSX } from "@opentui/solid"
import { useSDK } from "../../context/sdk"
import { useEditorContext } from "../../context/editor"
import { openEditor } from "../../editor"
import { useDialog } from "../../ui/dialog"
import { DialogAlert } from "../../ui/dialog-alert"
import { TodoItem } from "../../component/todo-item"
import { DialogMessage } from "./dialog-message"
import type { PromptInfo } from "../../component/prompt/history"
import { DialogConfirm } from "../../ui/dialog-confirm"
import { DialogTimeline } from "./dialog-timeline"
import { DialogForkFromTimeline } from "./dialog-fork-from-timeline"
import { DialogSessionRename } from "../../component/dialog-session-rename"
import { Sidebar } from "./sidebar"
import { SubagentFooter } from "./subagent-footer.tsx"
import { filetype } from "../../util/filetype"
import parsers from "../../parsers-config"
import { errorMessage } from "../../util/error"
import { Toast, useToast } from "../../ui/toast"
import { useKV } from "../../context/kv.tsx"
import stripAnsi from "strip-ansi"
import { usePromptRef } from "../../context/prompt"
import { useEpilogue } from "../../context/epilogue"
import { PermissionPrompt } from "./permission"
import { QuestionPrompt } from "./question"
import { ContextUsagePanel } from "./context-usage"
import { DialogExportOptions } from "../../ui/dialog-export-options"
import * as Model from "../../util/model"
import { formatTranscript } from "../../util/transcript"
import { formatUsageStats, sessionEpilogue } from "../../util/presentation"
import { setPreLayoutSiblingMargin } from "../../util/layout"
import { useTuiConfig } from "../../config"
import { useClipboard } from "../../context/clipboard"
import { reasoningSummary } from "../../context/thinking"
import { getScrollAcceleration } from "../../util/scroll"
import { collapseToolOutput } from "../../util/collapse-tool-output"
import { usePluginRuntime } from "../../plugin/runtime"
import { DialogRetryAction } from "../../component/dialog-retry-action"
import { getRevertDiffFiles } from "../../util/revert-diff"
import { OPENCODE_BASE_MODE, useBindings, useCommandShortcut, useOpencodeKeymap } from "../../keymap"
import { usePathFormatter } from "../../context/path-format"
import { LocationProvider } from "../../context/location"

addDefaultParsers(parsers.parsers)

const GO_UPSELL_FREE_TIER_LAST_SEEN_AT = "go_upsell_last_seen_at"
const GO_UPSELL_FREE_TIER_DONT_SHOW = "go_upsell_dont_show"
const GO_UPSELL_ACCOUNT_RATE_LIMIT_LAST_SEEN_AT = "go_upsell_account_rate_limit_last_seen_at"
const GO_UPSELL_ACCOUNT_RATE_LIMIT_DONT_SHOW = "go_upsell_account_rate_limit_dont_show"
const GO_UPSELL_WINDOW = 86_400_000 // 24 hrs
const GO_UPSELL_PROVIDERS = new Set(["opencode", "opencode-go"])

export const alwaysSeparate = new WeakSet<BoxRenderable>()

type RetryAction = Extract<SessionStatus, { type: "retry" }>["action"]

function goUpsellKeys(action: RetryAction) {
  if (!action) return
  if (!GO_UPSELL_PROVIDERS.has(action.provider)) return
  if (action.reason === "free_tier_limit") {
    return {
      lastSeenAt: GO_UPSELL_FREE_TIER_LAST_SEEN_AT,
      dontShow: GO_UPSELL_FREE_TIER_DONT_SHOW,
    }
  }
  if (action.reason === "account_rate_limit") {
    return {
      lastSeenAt: GO_UPSELL_ACCOUNT_RATE_LIMIT_LAST_SEEN_AT,
      dontShow: GO_UPSELL_ACCOUNT_RATE_LIMIT_DONT_SHOW,
    }
  }
}

const sessionBindingCommands = [
  "session.rename",
  "session.timeline",
  "session.fork",
  "session.compact",
  "session.undo",
  "session.redo",
  "session.sidebar.toggle",
  "session.toggle.conceal",
  "session.toggle.timestamps",
  "session.toggle.thinking",
  "session.toggle.actions",
  "session.toggle.scrollbar",
  "session.toggle.generic_tool_output",
  "session.first",
  "session.last",
  "session.messages_last_user",
  "session.message.next",
  "session.message.previous",
  "messages.copy",
  "session.copy",
  "session.export",
  "session.child.first",
  "session.parent",
  "session.child.next",
  "session.child.previous",
] as const

const sessionGlobalBindingCommands = [
  "session.page.up",
  "session.page.down",
  "session.line.up",
  "session.line.down",
  "session.half.page.up",
  "session.half.page.down",
] as const

const sessionGlobalUnfocusedBindingCommands = ["session.first", "session.last"] as const

export const context = createContext<{
  width: number
  sessionID: string
  conceal: () => boolean
  showThinking: () => boolean
  showTimestamps: () => boolean
  showDetails: () => boolean
  showGenericToolOutput: () => boolean
  diffWrapMode: () => "word" | "none"
  providers: () => ReadonlyMap<string, Provider>
  sync: ReturnType<typeof useSync>
  tui: ReturnType<typeof useTuiConfig>
  // [0624] 渲染资源窗口的只读视图与回写入口：messageView 无记录时按默认挂载/auto 处理。
  messageView: (id: string) => { mounted: boolean; height: number | "auto" } | undefined
  pinnedMessages: () => ReadonlySet<string>
  requestUsage: ReturnType<typeof createRequestUsage>
  markMessageDirty: (id: string) => void
  interaction: { get: (key: string) => boolean; set: (key: string, value: boolean) => void }
}>()

function use() {
  const ctx = useContext(context)
  if (!ctx) throw new Error("useContext must be used within a Session component")
  return ctx
}

// [0624] 驻留预算常数（R3，plan §10.3，经重型负载实测选择）：64MiB 估算正文容量覆盖
// 300×100KiB 的活跃会话，滚动与 resize 在预算内保持零重挂载；30s 时间窗让最近浏览的
// 内容在来回滚动中保持挂载。两者是驻留预算参数而不是功能开关，超出预算的超长/超大
// 历史仍被有界释放。
const RESIDENCY_MAX_AGE_MS = 30_000
const RESIDENCY_MAX_BYTES = 64 * 1024 * 1024

// 展开选择留在Session，正文owner可销毁；key由实际工具/推理run提供，不把折叠职责搬回BlockTool。
function useInteraction(key: () => string) {
  const ctx = use()
  const get = () => ctx.interaction.get(key())
  const set = (next: boolean | ((previous: boolean) => boolean)) =>
    ctx.interaction.set(key(), typeof next === "function" ? next(get()) : next)
  return [get, set] as const
}

export function Session() {
  const setEpilogue = useEpilogue()
  const clipboard = useClipboard()
  const writeExport = async (file: string, content: string) => {
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, content)
  }
  const pluginRuntime = usePluginRuntime()
  const route = useRouteData("session")
  const { navigate } = useRoute()
  const sync = useSync()
  // #123：首屏前固定 local，避免 Bun TDZ 在 memo/handler 中抛错
  const local = useLocal()
  const event = useEvent()
  const project = useProject()
  const paths = useTuiPaths()
  const tuiConfig = useTuiConfig()
  const kv = useKV()
  const { theme } = useTheme()
  const promptRef = usePromptRef()
  const session = createMemo(() => sync.session.get(route.sessionID))
  const location = createMemo(() => {
    const current = session()
    return current ? { directory: current.directory, workspaceID: current.workspaceID } : undefined
  })


  const children = createMemo(() => {
    const parentID = session()?.parentID ?? session()?.id
    return sync.data.session
      .filter((x) => x.parentID === parentID || x.id === parentID)
      .toSorted((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  })
  const messages = createMemo(() => sync.data.message[route.sessionID] ?? [])
  // 保留粘底信号供既有跟随逻辑使用，离底浏览不再关闭视口裁剪。
  const [viewportStuckToBottom, setViewportStuckToBottom] = createSignal(true)
  // [0624] 测量阶段必须关闭 viewport culling：Diff/Markdown 的宽度相关更新在渲染裁剪下
  // 不会可靠提交（混合 fixture 实测滚动高度失真）；正常浏览恢复现有恒定裁剪。
  const [remeasuring, setRemeasuring] = createSignal(false)
  // 恒定裁剪限制屏外遍历；用户滚动和显式导航仍由 scrollbox 处理。
  const viewportCulling = createMemo(() =>
    remeasuring() ? false : shouldCullSessionViewport(messages(), { stuckToBottom: viewportStuckToBottom() }),
  )
  // 退出只保留共享 owner 的数字。销毁后读取最后值，不重建已释放正文的统计。
  const epilogueUsage = createMemo(() => sync.session.accounting(route.sessionID).session)
  onMount(() =>
    setEpilogue(() => {
      const usage = epilogueUsage()
      return sessionEpilogue({
        title: Locale.truncate(session()?.title ?? "", 50),
        sessionID: session()?.id,
        usage: { input: usage.input, output: usage.output + usage.reasoning, cost: usage.cost },
      })
    }),
  )

  const messagesBeforeRevert = () => {
    const messageID = session()?.revert?.messageID
    if (!messageID) return messages()
    const index = messages().findIndex((message) => message.id === messageID)
    // 窗口缺少回退边界时不猜可操作前缀，避免 undo/copy 消费已回退内容。
    return index === -1 ? [] : messages().slice(0, index)
  }
  const foregroundTasks = createMemo(() =>
    sync.data.capabilities.experimentalBackgroundSubagents
      ? messages().flatMap((message) =>
          (sync.data.part[message.id] ?? []).filter(
            (part): part is ToolPart =>
              part.type === "tool" &&
              part.tool === "task" &&
              part.state.status === "running" &&
              part.state.metadata?.background !== true,
          ),
        )
      : [],
  )
  const permissions = createMemo(() => {
    if (session()?.parentID) return []
    return children().flatMap((x) => sync.data.permission[x.id] ?? [])
  })
  const questions = createMemo(() => {
    if (session()?.parentID) return []
    return children().flatMap((x) => sync.data.question[x.id] ?? [])
  })
  // 权限/问题拥有插槽优先级，打开面板不能同时启用普通输入；关闭只恢复可见性而不回复审批。
  const [contextVisible, setContextVisible] = createSignal(false)
  const visible = createMemo(
    () => !session()?.parentID && permissions().length === 0 && questions().length === 0 && !contextVisible(),
  )
  const disabled = createMemo(() => permissions().length > 0 || questions().length > 0 || contextVisible())

  const pending = createMemo(() => {
    // #154：算法沉淀到 session-pending util（含 completed 游标），此处只保留状态读取
    const status = sync.data.session_status?.[route.sessionID]
    return pendingAssistantIndex(messages(), status)
  })

  // #154：busy 却没有流式 assistant，说明 SSE 状态更新丢失而 DB 已有完成消息；
  // 延迟 1.5s 强制一次全量 sync，避免 prompt 因状态陈旧被永久禁用
  createEffect(
    on(
      () => {
        // 依赖键只取末条消息的 id/role/completed：流式 delta 不应反复重启定时器
        const last = messages().at(-1)
        return [
          route.sessionID,
          sync.data.session_status?.[route.sessionID]?.type,
          last?.id,
          last?.role,
          last?.role === "assistant" ? last.time.completed : undefined,
        ] as const
      },
      ([sessionID]) => {
        if (!shouldRefreshStaleBusyStatus(messages(), sync.data.session_status?.[sessionID])) return
        // 1.5s 容忍短暂竞态，超时才认定状态更新丢失
        const timer = setTimeout(() => {
          void sync.session.sync(sessionID, { force: true })
        }, 1_500)
        onCleanup(() => clearTimeout(timer))
      },
    ),
  )

  const lastAssistant = createMemo(() => {
    return messages().findLast((x) => x.role === "assistant")
  })

  const dimensions = useTerminalDimensions()
  const [sidebar, setSidebar] = kv.signal<"auto" | "hide">("sidebar", "auto")
  const [sidebarOpen, setSidebarOpen] = createSignal(false)
  const [conceal, setConceal] = createSignal(true)
  // 整块可见性沿历史主键持久化；局部disclosure不再受thinking_mode驱动。
  const [showThinking, setShowThinking] = kv.signal("thinking_visibility", true)
  const [timestamps, setTimestamps] = kv.signal<"hide" | "show">("timestamps", "hide")
  const [showDetails, setShowDetails] = kv.signal("tool_details_visibility", true)
  const [showAssistantMetadata, _setShowAssistantMetadata] = kv.signal("assistant_metadata_visibility", true)
  // 使用新偏好键启用滚动条，避免旧键的默认 false 抵消本次默认值迁移。
  const [showScrollbar, setShowScrollbar] = kv.signal("scrollbar_enabled", true)
  const [diffWrapMode] = kv.signal<"word" | "none">("diff_wrap_mode", "word")
  const [_animationsEnabled, _setAnimationsEnabled] = kv.signal("animations_enabled", true)
  // 默认 true：goal、MCP、ChatGPT 等 generic 工具的返回结果默认以块状显示，
  // 与 bash 等内置工具一致。旧用户的 kv.json 中若已持久化 false 则不受影响。
  const [showGenericToolOutput, setShowGenericToolOutput] = kv.signal("generic_tool_output_visibility", true)

  const wide = createMemo(() => dimensions().width > 120)
  const sidebarVisible = createMemo(() => {
    if (session()?.parentID) return false
    if (sidebarOpen()) return true
    if (sidebar() === "auto" && wide()) return true
    return false
  })
  const showTimestamps = createMemo(() => timestamps() === "show")
  const sidebarInLayout = createMemo(() => sidebarVisible() && wide())
  // #184：可读宽按 docked 侧栏与滚动条精确扣减
  const messageContentWidth = createMemo(() =>
    sessionMessageContentWidth({
      terminalWidth: dimensions().width,
      sidebarInLayout: sidebarInLayout(),
      scrollbarEnabled: showScrollbar(),
    }),
  )
  const providers = createMemo(() => Model.index(sync.data.provider))

  const scrollAcceleration = createMemo(() => getScrollAcceleration(tuiConfig))
  // #109：user 消息 agent 色映射为滚动条 marker
  const userMessageAgentColors = createMemo(() => {
    return new Map(
      messages()
        .filter((m) => m.role === "user")
        .map((m) => [m.id, local.agent.color(m.agent)]),
    )
  })
  const compactionMessageIDs = createMemo(() => {
    return new Set(
      messages().flatMap((m) => {
        if (m.role !== "user") return []
        const parts = sync.data.part[m.id] ?? []
        if (!parts.some((part) => part.type === "compaction")) return []
        if (parts.some((part) => part.type === "text" && !part.synthetic && !part.ignored)) return []
        return [m.id]
      }),
    )
  })
  // #109：renderAfter 回调：委托 smooth-scrollbar 重绘
  function drawSessionScrollbar(this: unknown, buffer: OptimizedBuffer) {
    const s = scroll
    if (!s) return
    const colors = userMessageAgentColors()
    const compactions = compactionMessageIDs()
    drawSmoothScrollbar({
      buffer,
      scrollBox: s,
      markers: s.content.getChildrenSortedByPrimaryAxis().flatMap((child): SmoothScrollbarMarker[] => {
        const offset = Math.max(0, child.screenY - s.content.screenY)
        // compaction 正文节点使用 theme.borderActive；滚动条 marker 复用同一 source color，
        // 再交给 smooth-scrollbar 做和普通 prompt marker 一致的低干扰 muted 处理。
        if (compactions.has(child.id)) return [{ offset, color: theme.borderActive }]
        const color = colors.get(child.id)
        if (!color) return []
        // #109：content 坐标 = screenY 差
        return [{ offset, color }]
      }),
    })
  }
  const toast = useToast()
  const sdk = useSDK()
  const editor = useEditorContext()

  createEffect(() => {
    const sessionID = route.sessionID
    void (async () => {
      const previousWorkspace = untrack(() => project.workspace.current())
      const result = await sdk.client.session.get({ sessionID }, { throwOnError: true })
      if (!result.data) {
        toast.show({
          message: `Session not found: ${sessionID}`,
          variant: "error",
          duration: 5000,
        })
        navigate({ type: "home" })
        return
      }

      if (result.data.workspaceID !== previousWorkspace) {
        project.workspace.set(result.data.workspaceID)

        // Sync all the data for this workspace. Note that this
        // workspace may not exist anymore which is why this is not
        // fatal. If it doesn't we still want to show the session
        // (which will be non-interactive)
        try {
          await sync.bootstrap({ fatal: false })
        } catch {}
      }
      editor.reconnect(result.data.directory)
      await sync.session.sync(sessionID)
      // #551：会话打开滚动统一入口——锚点优先，否则贴底。
      // 594：路径 A 是同会话 sync 完成后的补滚，必须尊重用户已滚离位置（INV-05）；
      // 首次mount由stickyStart初始化，sync完成后才由带守卫的路径A补滚。
      if (route.sessionID === sessionID) scheduleSessionOpenScroll(true)
    })().catch((error) => {
      if (route.sessionID !== sessionID) return
      toast.show({
        message: errorMessage(error),
        variant: "error",
        duration: 5000,
      })
      // #139：可恢复连接错误留在会话；server.connected 会强制刷新
      if (ConnectionError.isConnectionError(error)) return
      navigate({ type: "home" })
    })
  })

  let lastSwitch: string | undefined = undefined
  // #132：重连强制刷新当前会话
  event.on("server.connected", () => {
    void sync.session.sync(route.sessionID, { force: true })
  })
  event.on("message.part.updated", (evt) => {
    const part = evt.properties.part
    if (part.type !== "tool") return
    // #553：plan transition 是 visible Tool 语义，hidden completion 不得切换当前 Agent。
    if ("hidden" in part && part.hidden) return
    if (part.sessionID !== route.sessionID) return
    if (part.state.status !== "completed") return
    if (part.id === lastSwitch) return

    if (part.tool === "plan_exit") {
      local.agent.set("build")
      lastSwitch = part.id
    } else if (part.tool === "plan_enter") {
      local.agent.set("plan")
      lastSwitch = part.id
    }
  })

  let seeded = false
  let scroll: ScrollBoxRenderable
  let prompt: PromptRef | undefined
  const bind = (r: PromptRef | undefined) => {
    prompt = r
    promptRef.set(r)
    if (seeded || !route.prompt || !r) return
    seeded = true
    r.set(route.prompt)
  }
  const keymap = useOpencodeKeymap()
  const dialog = useDialog()
  const renderer = useRenderer()

  // #212：布局后读取滚动范围，避免文本更新早于原生尺寸刷新。
  function syncSessionViewportStuckToBottom() {
    if (!scroll || scroll.isDestroyed) return
    // 位置保持与贴底由容器在布局期处理；这里只调度驻留并发布已绘制状态。
    syncMessageResidency()
    const maxScrollTop = Math.max(0, scroll.scrollHeight - scroll.viewport.height)
    const stuckToBottom = scroll.scrollTop >= maxScrollTop - 1
    if (stuckToBottom === untrack(viewportStuckToBottom)) return
    queueMicrotask(() => setViewportStuckToBottom(stuckToBottom))
  }

  // ── [0624] 渲染资源窗口（INV-03/INV-04，R3 容量+时间有界驻留）────────────
  // Message 根 renderable 常驻并携带实测高度，scrollbar、导航与 selection 继续读到
  // 真实几何。驻留集合 = 视口上下各一屏 ∪ 最近 RESIDENCY_MAX_AGE_MS 内渲染过的内容
  // ∪ selection/导航 pin，且受 RESIDENCY_MAX_BYTES 估算正文容量约束（超限按最久未
  // 渲染先驱逐）。预算内不驱逐、不重挂载——普通滚动与基线同构、零重挂载（R1 固定
  // 窗口被实测证伪：scroll p95 劣化 12–14×，证据见 plan §20 R1 实测记录）。
  const [messageView, setMessageView] = createStore<Record<string, { mounted: boolean; height: number | "auto" }>>({})
  const [renderPins, setRenderPins] = createSignal<ReadonlySet<string>>(new Set<string>())
  const requestUsage = createRequestUsage({
    messages,
    mounted: id => messageView[id]?.mounted !== false || renderPins().has(id),
    get: async (sessionID, requestID) => (await sdk.client.session.requestUsage.get({ sessionID, requestID })).data,
  })
  // 轻量交互状态（工具展开、Shell 上下文输出、reasoning 展开）决定重建后的实测高度，
  // 必须活在可销毁的内容 owner 之外，否则屏外重建会把用户展开状态重置回折叠。
  const [interaction, setInteraction] = createStore<Record<string, boolean>>({})
  // 冻结只允许在“高度连续两帧不变”后发生：异步高亮/conceal 会在首帧后继续改变
  // 真实行数，过早冻结会把错误高度钉在已销毁的正文上，scrollbar 随之失真。
  const lastSeenHeights = new Map<string, number>()
  // LRU 与年龄驱逐的唯一时间来源：进入视口（真实渲染）才刷新。无后台计时器，
  // 年龄只在渲染驱动的 pass 中求值（plan §10.3 的授权约束）。
  const lastRenderedAt = new Map<string, number>()
  // 分帧重测队列：每帧最多一批（累计冻结高度≈一屏），把壳化消息的重挂摊到多帧，
  // 避免 R1 一次性全量重挂产生的 250–320MiB 瞬态 commit（证据见 plan §20）。
  let remeasureQueue: string[] = []
  let remeasureBatch: string[] = []
  let batchStablePasses = 0
  const batchHeights = new Map<string, number>()

  const interactionState = {
    get: (key: string) => interaction[key] ?? false,
    set: (key: string, value: boolean) => setInteraction(key, value),
  }

  function pinRenderedMessage(id: string) {
    setRenderPins((previous) => new Set(previous).add(id))
  }

  function markMessageDirty(id: string) {
    // [0625] 驻留中的 Message 本来就是 auto 高度，无需重测；但正文增长必须同步进容量估算，
    // 否则挂载中的流式输出逃出预算（估算差额更新，不重复计入）。
    if (messageView[id]?.mounted !== false) {
      const cached = estimateBytes.get(id)
      if (cached !== undefined) {
        const next = estimateMessageBytes(id)
        residentBytesTotal += next - cached
        estimateBytes.set(id, next)
      }
      return
    }
    // 壳化消息的流式/durable 更新只重测变化的那一条，排在分帧队列首优先于 resize 积压。
    estimateBytes.delete(id)
    remeasureQueue = [id, ...remeasureQueue.filter((queued) => queued !== id)]
    setRemeasuring(true)
  }

  // 估算正文字节：只加 text/reasoning 正文与 tool 的 output/metadata 大字段，是驻留
  // 成本的代理记账（渲染树规模随正文增长），不是精确内存字节数。
  function estimateMessageBytes(id: string) {
    let total = 0
    for (const part of sync.data.part[id] ?? []) {
      if (part.type === "text" || part.type === "reasoning") {
        total += part.text.length
        continue
      }
      if (part.type === "tool") {
        if ("output" in part.state && typeof part.state.output === "string") total += part.state.output.length
        const metadata = "metadata" in part.state ? part.state.metadata : undefined
        if (typeof metadata?.output === "string") total += metadata.output.length
        if (typeof metadata?.diff === "string") total += metadata.diff.length
      }
    }
    return total
  }

  function subtreeHasPendingHighlight(root: Renderable): boolean {
    // Markdown/Diff 的异步高亮落地后 conceal 才会定稿行数；冻结高度前必须排空。
    const stack = [root]
    while (stack.length) {
      const node = stack.pop()!
      if (node instanceof CodeRenderable && node.isHighlighting) return true
      stack.push(...node.getChildren())
    }
    return false
  }

  // 估算字节缓存与增量总量：store 代理读取慢（300 次/帧实测约 2ms），估算只在挂载
  // 转换、内容标脏与会话重置时刷新；普通滚动帧不做任何 store 读取。
  const estimateBytes = new Map<string, number>()
  let residentBytesTotal = 0

  // [0625] 驻留记账口径：false→true 计入、true→false 减出。驻留重建、重测批进出、
  // stale 清理与内容标脏的差额刷新都经由这两个入口；首次见到已挂载消息的补账
  // 由下方带 estimateBytes.has 守卫的循环直接加总（每 ID 只计一次，不会双计）。
  function accountMounted(id: string) {
    const estimate = estimateBytes.get(id) ?? estimateMessageBytes(id)
    estimateBytes.set(id, estimate)
    residentBytesTotal += estimate
  }
  function accountShelled(id: string) {
    residentBytesTotal -= estimateBytes.get(id) ?? 0
  }

  function syncMessageResidency() {
    if (!scroll || scroll.isDestroyed) return
    queueMicrotask(() => {
      if (!scroll || scroll.isDestroyed) return
      // 几何读取与 store 写入推迟到渲染完成后的 microtask：渲染进行中改树会破坏
      // 当帧 render list；本 pass 读取的是刚完成的布局。
      const viewport = scroll.viewport
      const top = viewport.screenY - viewport.height
      const bottom = viewport.screenY + viewport.height * 2
      const byId = new Map<string, Renderable>()
      for (const child of scroll.getChildren()) if (child.id) byId.set(child.id, child)

      // selection pin 用几何区间而不是 renderable 引用：区间内的冻结壳同样占高，
      // 跨屏复制要求整条穿越区间的正文保持存活；anchor 起点节点由区间覆盖。
      const selection = renderer.getSelection()
      let selectionTop = Number.POSITIVE_INFINITY
      let selectionBottom = Number.NEGATIVE_INFINITY
      if (selection?.isActive) {
        for (const selected of selection.selectedRenderables) {
          if (selected.isDestroyed) continue
          let node: Renderable | null = selected
          while (node && node.parent !== scroll.content) node = node.parent
          if (node?.id && byId.has(node.id)) {
            selectionTop = Math.min(selectionTop, node.screenY)
            selectionBottom = Math.max(selectionBottom, node.screenY + node.height)
          }
        }
      }

      const pins = untrack(renderPins)
      const desired = new Set<string>()
      for (const [id, child] of byId) {
        const visible = child.screenY + child.height > top && child.screenY < bottom
        const covered = child.screenY + child.height > selectionTop && child.screenY < selectionBottom
        if (visible || covered || pins.has(id)) desired.add(id)
      }
      // pin 只护航到进入驻留窗口；已在窗口内的 pin 及时解除，避免集合随导航增长。
      const nextPins = new Set<string>()
      for (const id of pins) {
        const child = byId.get(id)
        if (!child) continue
        const inWindow = child.screenY + child.height > top && child.screenY < bottom
        if (!inWindow) nextPins.add(id)
      }
      if (nextPins.size !== pins.size) setRenderPins(nextPins)

      if (remeasuring()) {
        let finalized = false
        batch(() => {
          // 驻留窗口内的壳立即重建，不等批轮次：用户滚动优先于后台重测。
          // [0625] false→true 的唯一记账口径同样适用于重测路径，否则重测期间的重建只进不出。
          for (const id of desired) {
            const record = messageView[id]
            if (record && !record.mounted) {
              accountMounted(id)
              setMessageView(id, { mounted: true, height: "auto" })
              remeasureQueue = remeasureQueue.filter((queued) => queued !== id)
              remeasureBatch = remeasureBatch.filter((queued) => queued !== id)
              batchHeights.delete(id)
            }
          }
          if (remeasureBatch.length === 0) {
            // 取下一批：累计冻结高度达到一屏为止；队列保持当前几何位置顺序。
            let rows = 0
            while (remeasureQueue.length > 0 && rows < viewport.height) {
              const id = remeasureQueue.shift()!
              const record = messageView[id]
              if (!record || record.mounted || desired.has(id)) continue
              rows += typeof record.height === "number" ? record.height : 0
              remeasureBatch.push(id)
              batchHeights.delete(id)
              // [0625] 重测批进队即按挂载计入，批次提交门决定是否再壳化减出。
              accountMounted(id)
              setMessageView(id, { mounted: true, height: "auto" })
            }
            if (remeasureBatch.length === 0 && remeasureQueue.length === 0) finalized = true
          } else {
            // 批次提交门：批内根高连续两帧不变且无在途高亮——与冻结同一规则，
            // 只是按批求值；异步高亮落地前绝不写回冻结高度。
            let stable = true
            for (const id of remeasureBatch) {
              const child = byId.get(id)
              if (!child) continue
              if (batchHeights.get(id) !== child.height || subtreeHasPendingHighlight(child)) stable = false
              batchHeights.set(id, child.height)
            }
            batchStablePasses = stable ? batchStablePasses + 1 : 0
            if (batchStablePasses >= 2) {
              for (const id of remeasureBatch) {
                const child = byId.get(id)
                batchHeights.delete(id)
                if (!child) continue
                lastSeenHeights.set(id, child.height)
                // [0625] 批处理期间滚入驻留窗口的不再壳化（批次进队时已记账），auto 高度继续跟随内容。
                if (desired.has(id)) setMessageView(id, { mounted: true, height: "auto" })
                else {
                  accountShelled(id)
                  setMessageView(id, { mounted: false, height: child.height })
                }
              }
              remeasureBatch = []
              batchStablePasses = 0
            }
          }
          if (finalized) {
            // [0628] 重测完成不再滞后一帧恢复位置：容器补偿在每帧布局前生效，
            // 尾批冻结后的 scrollHeight 对齐由同帧 recalculateBarProps 完成。
            setRemeasuring(false)
          }
        })
        // 分帧重测期间主动预约下一帧：渲染空闲时 renderAfter 不会自发触发。
        if (!finalized) scroll.requestRender()
        return
      }

      let followUp = false
      const now = Date.now()
      batch(() => {
        // 驻留集合：进入视口/pin/选区即挂载并刷新渲染 recency；预算内绝不驱逐，
        // 普通滚动因此零重挂载。
        for (const id of byId.keys()) {
          if (!desired.has(id)) continue
          lastRenderedAt.set(id, now)
          const record = messageView[id]
          if (record && !record.mounted) {
            // [0625] 重建挂载计入驻留容量；估算缓存在标脏时已删除，这里取到新内容的真实量级。
            accountMounted(id)
            setMessageView(id, { mounted: true, height: "auto" })
          }
        }
        // 挂载消息记账：首次见到的挂载消息补记估算（store 代理读取只发生在此，
        // 之后命中缓存）。初始加载即挂载与重建挂载都经由这里或上方驻留块进入。
        for (const id of byId.keys()) {
          const record = messageView[id]
          if (record && !record.mounted) continue
          if (estimateBytes.has(id)) continue
          const estimate = estimateMessageBytes(id)
          estimateBytes.set(id, estimate)
          residentBytesTotal += estimate
        }
        // 驱逐候选：已挂载但不在驻留集合。预算内（未超龄且未超容量）直接保留。
        const candidates: { id: string; child: Renderable }[] = []
        for (const [id, child] of byId) {
          if (desired.has(id)) continue
          const record = messageView[id]
          if (record && !record.mounted) continue
          candidates.push({ id, child })
        }
        if (candidates.length > 0) {
          // 从未进入视口的消息没有渲染时间戳：以首次成为驱逐候选的时刻起算并写入，
          // 否则从未访问的屏外内容永远不可能超龄（只受容量驱逐）。
          for (const { id } of candidates) {
            if (!lastRenderedAt.has(id)) lastRenderedAt.set(id, now)
          }
          // 便宜的前置闸：没有超龄候选且总量未超预算时完全不评估，不排序不读取。
          const anyAged = candidates.some(({ id }) => now - lastRenderedAt.get(id)! > RESIDENCY_MAX_AGE_MS)
          if (anyAged || residentBytesTotal > RESIDENCY_MAX_BYTES) {
            // 超容量时按最久未渲染先驱逐（LRU）；pin/选区在驻留集合内不会被选中。
            candidates.sort((a, b) => (lastRenderedAt.get(a.id) ?? 0) - (lastRenderedAt.get(b.id) ?? 0))
            for (const { id, child } of candidates) {
              const agedOut = now - lastRenderedAt.get(id)! > RESIDENCY_MAX_AGE_MS
              const overBudget = residentBytesTotal > RESIDENCY_MAX_BYTES
              if (!agedOut && !overBudget) continue
              const previousHeight = lastSeenHeights.get(id)
              lastSeenHeights.set(id, child.height)
              if (previousHeight !== child.height || subtreeHasPendingHighlight(child)) {
                followUp = true
                continue
              }
              // [0625] 冻结值直接读当前布局（内容本帧仍挂载），不需要额外测量通道。
              accountShelled(id)
              setMessageView(id, { mounted: false, height: child.height })
            }
          }
        }
        // 300 窗口淘汰、会话切换或 revert 隐藏后清理无主记录，不随会话时长累积。
        const stale = Object.keys(messageView).filter((id) => !byId.has(id))
        if (stale.length) {
          for (const id of stale) {
            // [0625] 先减账再删记录：删除后 mounted 状态不可读，顺序颠倒会让容量只进不出。
            if (messageView[id]?.mounted) accountShelled(id)
            lastSeenHeights.delete(id)
            lastRenderedAt.delete(id)
            estimateBytes.delete(id)
          }
          setMessageView(
            produce((state) => {
              for (const id of stale) delete state[id]
            }),
          )
        }
      })
      // 有候选高度还在收敛时主动预约下一帧，否则两条稳定观察规则永远等不到第二帧。
      if (followUp) scroll.requestRender()
    })
  }

  // 全局布局失效（终端宽度、conceal、thinking/timestamps/details 等影响行高的开关）：
  // 只有壳化（已驱逐）消息需要解除冻结重建测量，自然挂载内容随布局自然 reflow 不参与；
  // 壳化消息按一屏一批分帧重测。这是正常测量路径，不是失败后的备用渲染。
  createEffect(
    on(
      () =>
        [
          messageContentWidth(),
          conceal(),
          showThinking(),
          showTimestamps(),
          showDetails(),
          showGenericToolOutput(),
          diffWrapMode(),
        ] as const,
      () => {
        if (!scroll || scroll.isDestroyed) return
        // [0628] 重测启动不再捕获旧位置锚点：宽度/显示切换期间的位置由容器在
        // 每帧布局前保持；这里只重建分帧队列与冻结判定输入。
        remeasureBatch = []
        batchStablePasses = 0
        batchHeights.clear()
        remeasureQueue = []
        for (const child of scroll.getChildren()) {
          if (!child.id) continue
          if (messageView[child.id]?.mounted === false) remeasureQueue.push(child.id)
        }
        // 无壳化消息时纯自然 reflow，不进入测量阶段：预算内 resize 零重挂载。
        if (remeasureQueue.length > 0) setRemeasuring(true)
      },
      { defer: true },
    ),
  )

  // 切换 Session 时窗口状态全部作废：旧 Session 的测量记录、pin、脏标记与交互状态
  // 不带入新 transcript（既有行为也是卸载整棵树后从零开始）。
  createEffect(
    on(
      () => route.sessionID,
      () => {
        batch(() => {
          setMessageView(
            produce((state) => {
              for (const id of Object.keys(state)) delete state[id]
            }),
          )
          setInteraction(
            produce((state) => {
              for (const key of Object.keys(state)) delete state[key]
            }),
          )
          setRenderPins(new Set<string>())
          setRemeasuring(false)
        })
        lastSeenHeights.clear()
        lastRenderedAt.clear()
        estimateBytes.clear()
        residentBytesTotal = 0
        remeasureQueue = []
        remeasureBatch = []
        batchStablePasses = 0
        batchHeights.clear()
      },
      { defer: true },
    ),
  )

  event.on("session.status", (evt) => {
    if (evt.properties.sessionID !== route.sessionID) return
    if (evt.properties.status.type !== "retry") return
    if (!evt.properties.status.action) return
    if (dialog.stack.length > 0) return

    const keys = goUpsellKeys(evt.properties.status.action)
    if (!keys) return

    const seen = kv.get(keys.lastSeenAt)
    if (typeof seen === "number" && Date.now() - seen < GO_UPSELL_WINDOW) return

    if (kv.get(keys.dontShow)) return

    void DialogRetryAction.show(dialog, evt.properties.status.action).then((dontShowAgain) => {
      if (dontShowAgain) kv.set(keys.dontShow, true)
      kv.set(keys.lastSeenAt, Date.now())
    })
  })

  // Helper: Find next visible message boundary in direction
  const findNextVisibleMessage = (direction: "next" | "prev"): string | null => {
    const children = scroll.getChildren()
    const messagesList = messages()
    const scrollTop = scroll.y

    // Get visible messages sorted by position, filtering for valid non-synthetic, non-ignored content
    const visibleMessages = children
      .filter((c) => {
        if (!c.id) return false
        const message = messagesList.find((m) => m.id === c.id)
        if (!message) return false

        // Check if message has valid non-synthetic, non-ignored text parts
        const parts = sync.data.part[message.id]
        if (!parts || !Array.isArray(parts)) return false

        return parts.some((part) => part && part.type === "text" && !part.synthetic && !part.ignored)
      })
      .sort((a, b) => a.y - b.y)

    if (visibleMessages.length === 0) return null

    if (direction === "next") {
      // Find first message below current position
      return visibleMessages.find((c) => c.y > scrollTop + 10)?.id ?? null
    }
    // Find last message above current position
    return [...visibleMessages].reverse().find((c) => c.y < scrollTop - 10)?.id ?? null
  }

  // Helper: Scroll to message in direction or fallback to page scroll
  const scrollToMessage = (direction: "next" | "prev", dialog: ReturnType<typeof useDialog>) => {
    const targetID = findNextVisibleMessage(direction)

    if (!targetID) {
      scroll.scrollBy(direction === "next" ? scroll.height : -scroll.height)
      dialog.clear()
      return
    }

    const child = scroll.getChildren().find((c) => c.id === targetID)
    if (child) {
      // [0624] 目标可能在驻留窗口外：先 pin 让内容随滚动同帧挂载，再按冻结几何滚动。
      pinRenderedMessage(targetID)
      scroll.scrollBy(child.y - scroll.y - 1)
    }
    dialog.clear()
  }

  function toBottom() {
    setTimeout(() => {
      if (!scroll || scroll.isDestroyed) return
      scroll.scrollTo(scroll.scrollHeight)
    }, 50)
  }

  // #551：会话打开的唯一滚动语义——reviewID 锚点定位到对应 reviewer 返回消息，
  // 无锚点才贴底；defer 50ms 与 toBottom 同拍，防止旧 toBottom 定时器覆盖锚点。
  function applySessionOpenScroll(respectUserScroll = false) {
    if (!scroll || scroll.isDestroyed) return
    // 594：贴底前按调用者意图检查——补滚不得覆盖用户已滚离位置（INV-05）；
    // reviewID 锚点 scrollBy 不经此守卫，导航锚点定位语义保持不变。
    const pinAllowed = () => !respectUserScroll || untrack(viewportStuckToBottom)
    const reviewID = route.reviewID
    if (!reviewID) {
      if (pinAllowed()) scroll.scrollTo(scroll.scrollHeight)
      return
    }
    const target = resolveReviewAnchorMessageID(
      sync.data.message[route.sessionID] ?? [],
      (messageID) => sync.data.part[messageID] ?? [],
      reviewID,
    )
    if (!target) {
      // 锚点 miss（300 条窗口裁剪或消息尚未同步）退化为贴底，不阻断导航。
      if (pinAllowed()) scroll.scrollTo(scroll.scrollHeight)
      return
    }
    const child = scroll.getChildren().find((c) => c.id === target)
    if (child) {
      // [0624] 导航目标先 pin：目标可能在驻留窗口外，先 pin 让内容随滚动同帧挂载。
      pinRenderedMessage(target)
      scroll.scrollBy(child.y - scroll.y - 1)
    } else if (pinAllowed()) scroll.scrollTo(scroll.scrollHeight)
  }

  function scheduleSessionOpenScroll(respectUserScroll = false) {
    setTimeout(() => {
      if (!scroll || scroll.isDestroyed) return
      applySessionOpenScroll(respectUserScroll)
    }, 50)
  }


  function enterChild(sessionID: string) {
    navigate({
      type: "session",
      sessionID,
    })
    const status = sync.data.session_status[sessionID]
    if (status?.type === "retry") void DialogAlert.show(dialog, "Retry Error", status.message)
  }

  function moveFirstChild() {
    if (children().length === 1) return
    const next = children().find((x) => !!x.parentID)
    if (next) enterChild(next.id)
  }

  function moveChild(direction: number) {
    if (children().length === 1) return

    const sessions = children().filter((x) => !!x.parentID)
    let next = sessions.findIndex((x) => x.id === session()?.id) - direction

    if (next >= sessions.length) next = 0
    if (next < 0) next = sessions.length - 1
    if (sessions[next]) enterChild(sessions[next].id)
  }

  function childSessionHandler(func: () => void) {
    return () => {
      if (!session()?.parentID || dialog.stack.length > 0) return
      func()
    }
  }

  const sessionCommandList = createMemo(() => [
    {
      title: "Rename session",
      value: "session.rename",
      category: "Session",
      slash: {
        name: "rename",
      },
      run: () => {
        dialog.replace(() => <DialogSessionRename session={route.sessionID} />)
      },
    },
    {
      title: "Jump to message",
      value: "session.timeline",
      category: "Session",
      slash: {
        name: "timeline",
      },
      run: () => {
        dialog.replace(() => (
          <DialogTimeline
            onMove={(messageID) => {
              const child = scroll.getChildren().find((child) => {
                return child.id === messageID
              })
              if (child) {
                // [0624] 时间线导航目标先 pin，避免跳转帧出现已释放的空壳。
                pinRenderedMessage(messageID)
                scroll.scrollBy(child.y - scroll.y - 1)
              }
            }}
            sessionID={route.sessionID}
            setPrompt={(promptInfo) => prompt?.set(promptInfo)}
            submit={() => promptRef.current?.submit()}
          />
        ))
      },
    },
    {
      title: "Fork session",
      value: "session.fork",
      category: "Session",
      slash: {
        name: "fork",
      },
      run: () => {
        dialog.replace(() => (
          <DialogForkFromTimeline
            onMove={(messageID) => {
              if (!messageID) return
              const child = scroll.getChildren().find((child) => {
                return child.id === messageID
              })
              if (child) {
                // [0624] fork 时间线导航目标先 pin，与主时间线同一驻留合同。
                pinRenderedMessage(messageID)
                scroll.scrollBy(child.y - scroll.y - 1)
              }
            }}
            sessionID={route.sessionID}
          />
        ))
      },
    },
    {
      title: "Compact session",
      value: "session.compact",
      category: "Session",
      slash: {
        name: "compact",
        aliases: ["summarize"],
      },
      run: async () => {
        const selectedModel = local.model.current()
        if (!selectedModel) {
          toast.show({
            variant: "warning",
            message: "Connect a provider to summarize this session",
            duration: 3000,
          })
          return
        }
        // 请求前退出面板；这不构成并发锁，跨入口的重复提交仍由会话执行 owner 协调。
        dialog.clear()
        // 此提示只表示请求已发起；durable admission 与模型执行分离，不在这里显示成功。
        toast.show({
          variant: "info",
          message: "Starting session compaction...",
          duration: 3000,
        })
        try {
          // SDK 默认返回 error 对象；显式抛错才能让非 2xx 响应进入同一可见错误出口。
          await sdk.client.session.summarize(
            {
              sessionID: route.sessionID,
              modelID: selectedModel.modelID,
              providerID: selectedModel.providerID,
            },
            { throwOnError: true },
          )
          // await 只捕获请求失败；已接纳压缩的异步终态由事件通道通知。
        } catch (error) {
          toast.show({
            variant: "error",
            message: errorMessage(error),
            duration: 8000,
          })
        }
      },
    },
    {
      title: "Undo previous message",
      value: "session.undo",
      category: "Session",
      slash: {
        name: "undo",
      },
      run: async () => {
        const status = sync.data.session_status?.[route.sessionID]
        // #153：undo 重写消息尾部，模型仍在运行时先 abort，避免迟到的流事件复活隐藏消息
        // abort 失败静默：消息重写不因网络抖动被阻塞，下一轮状态同步会再次收敛
        if (status?.type !== "idle") await sdk.client.session.abort({ sessionID: route.sessionID }).catch(() => {})
        const message = messagesBeforeRevert().findLast((item) => item.role === "user")
        if (!message) return
        void sdk.client.session
          .revert({
            sessionID: route.sessionID,
            messageID: message.id,
          })
          .then(() => {
            toBottom()
          })
        const parts = sync.data.part[message.id]
        prompt?.set(
          parts.reduce(
            (agg, part) => {
              if (part.type === "text") {
                if (!part.synthetic) agg.input += part.text
              }
              if (part.type === "file") agg.parts.push(part)
              return agg
            },
            { input: "", parts: [] as PromptInfo["parts"] },
          ),
        )
        dialog.clear()
      },
    },
    {
      title: "Redo",
      value: "session.redo",
      category: "Session",
      enabled: !!session()?.revert?.messageID,
      slash: {
        name: "redo",
      },
      run: () => {
        dialog.clear()
        const messageID = session()?.revert?.messageID
        if (!messageID) return
        // 0584：命令保持显式 fail closed：boundary 不在 bounded snapshot 时 no-op，
        // 不猜测 raw 位置也不触发服务端写。
        const boundary = messages().findIndex((message) => message.id === messageID)
        if (boundary === -1) return
        const message = messages().find((x, index) => x.role === "user" && index > boundary)
        if (!message) {
          void sdk.client.session.unrevert({
            sessionID: route.sessionID,
          })
          prompt?.set({ input: "", parts: [] })
          return
        }
        void sdk.client.session.revert({
          sessionID: route.sessionID,
          messageID: message.id,
        })
      },
    },
    {
      // 命令只切换本会话视图信号，不向 runner 发起 prompt、resume 或 interrupt，查看不会改变执行账本。
      title: contextVisible() ? "Hide context usage" : "Context usage",
      value: "session.context",
      category: "Session",
      slash: {
        name: "context",
      },
      run: () => {
        setContextVisible((visible) => !visible)
      },
    },
    {
      title: sidebarVisible() ? "Hide sidebar" : "Show sidebar",
      value: "session.sidebar.toggle",
      category: "Session",
      run: () => {
        batch(() => {
          const isVisible = sidebarVisible()
          setSidebar(() => (isVisible ? "hide" : "auto"))
          setSidebarOpen(!isVisible)
        })
        dialog.clear()
      },
    },
    {
      title: conceal() ? "Disable code concealment" : "Enable code concealment",
      value: "session.toggle.conceal",
      category: "Session",
      run: () => {
        setConceal((prev) => !prev)
        dialog.clear()
      },
    },
    {
      title: showTimestamps() ? "Hide timestamps" : "Show timestamps",
      value: "session.toggle.timestamps",
      category: "Session",
      slash: {
        name: "timestamps",
        aliases: ["toggle-timestamps"],
      },
      run: () => {
        setTimestamps((prev) => (prev === "show" ? "hide" : "show"))
        dialog.clear()
      },
    },
    {
      title: showThinking() ? "Hide thinking" : "Show thinking",
      value: "session.toggle.thinking",
      category: "Session",
      slash: {
        name: "thinking",
        aliases: ["toggle-thinking"],
      },
      run: () => {
        setShowThinking((visible) => !visible)
        dialog.clear()
      },
    },
    {
      title: showDetails() ? "Hide tool details" : "Show tool details",
      value: "session.toggle.actions",
      category: "Session",
      run: () => {
        setShowDetails((prev) => !prev)
        dialog.clear()
      },
    },
    {
      title: "Toggle session scrollbar",
      value: "session.toggle.scrollbar",
      category: "Session",
      run: () => {
        setShowScrollbar((prev) => !prev)
        dialog.clear()
      },
    },
    {
      title: showGenericToolOutput() ? "Hide generic tool output" : "Show generic tool output",
      value: "session.toggle.generic_tool_output",
      category: "Session",
      run: () => {
        setShowGenericToolOutput((prev) => !prev)
        dialog.clear()
      },
    },
    {
      title: "Page up",
      value: "session.page.up",
      category: "Session",
      hidden: true,
      run: () => {
        scroll.scrollBy(-scroll.height / 2)
        dialog.clear()
      },
    },
    {
      title: "Page down",
      value: "session.page.down",
      category: "Session",
      hidden: true,
      run: () => {
        scroll.scrollBy(scroll.height / 2)
        dialog.clear()
      },
    },
    {
      title: "Line up",
      value: "session.line.up",
      category: "Session",
      hidden: true,
      run: () => {
        scroll.scrollBy(-1)
        dialog.clear()
      },
    },
    {
      title: "Line down",
      value: "session.line.down",
      category: "Session",
      hidden: true,
      run: () => {
        scroll.scrollBy(1)
        dialog.clear()
      },
    },
    {
      title: "Half page up",
      value: "session.half.page.up",
      category: "Session",
      hidden: true,
      run: () => {
        scroll.scrollBy(-scroll.height / 4)
        dialog.clear()
      },
    },
    {
      title: "Half page down",
      value: "session.half.page.down",
      category: "Session",
      hidden: true,
      run: () => {
        scroll.scrollBy(scroll.height / 4)
        dialog.clear()
      },
    },
    {
      title: "First message",
      value: "session.first",
      category: "Session",
      hidden: true,
      run: () => {
        // [0624] 顶部跳转同样先 pin 首条 Message，避免跳转帧出现已释放的空壳。
        const first = scroll.getChildren().find((child) => child.id)
        if (first) pinRenderedMessage(first.id!)
        scroll.scrollTo(0)
        dialog.clear()
      },
    },
    {
      title: "Last message",
      value: "session.last",
      category: "Session",
      hidden: true,
      run: () => {
        // [0624] 底部跳转同样先 pin 最后一条 Message，避免跳转帧出现已释放的空壳。
        const last = scroll.getChildren().findLast((child) => child.id)
        if (last) pinRenderedMessage(last.id!)
        scroll.scrollTo(scroll.scrollHeight)
        dialog.clear()
      },
    },
    {
      title: "Jump to last user message",
      value: "session.messages_last_user",
      category: "Session",
      hidden: true,
      run: () => {
        const messages = sync.data.message[route.sessionID]
        if (!messages || !messages.length) return

        // Find the most recent user message with non-ignored, non-synthetic text parts
        for (let i = messages.length - 1; i >= 0; i--) {
          const message = messages[i]
          if (!message || message.role !== "user") continue

          const parts = sync.data.part[message.id]
          if (!parts || !Array.isArray(parts)) continue

          const hasValidTextPart = parts.some(
            (part) => part && part.type === "text" && !part.synthetic && !part.ignored,
          )

          if (hasValidTextPart) {
            const child = scroll.getChildren().find((child) => {
              return child.id === message.id
            })
            if (child) {
              // [0624] 跳转目标先 pin，与其它导航入口同一驻留合同。
              pinRenderedMessage(message.id)
              scroll.scrollBy(child.y - scroll.y - 1)
            }
            break
          }
        }
      },
    },
    {
      title: "Next message",
      value: "session.message.next",
      category: "Session",
      hidden: true,
      run: () => scrollToMessage("next", dialog),
    },
    {
      title: "Previous message",
      value: "session.message.previous",
      category: "Session",
      hidden: true,
      run: () => scrollToMessage("prev", dialog),
    },
    {
      title: "Copy last assistant message",
      value: "messages.copy",
      category: "Session",
      run: () => {
        const lastAssistantMessage = messagesBeforeRevert().findLast((message) => message.role === "assistant")
        if (!lastAssistantMessage) {
          toast.show({ message: "No assistant messages found", variant: "error" })
          dialog.clear()
          return
        }

        const parts = sync.data.part[lastAssistantMessage.id] ?? []
        const textParts = parts.filter((part) => part.type === "text")
        if (textParts.length === 0) {
          toast.show({ message: "No text parts found in last assistant message", variant: "error" })
          dialog.clear()
          return
        }

        const text = textParts
          .map((part) => part.text)
          .join("\n")
          .trim()
        if (!text) {
          toast.show({
            message: "No text content found in last assistant message",
            variant: "error",
          })
          dialog.clear()
          return
        }

        clipboard
          .write?.(text)
          .then(() => toast.show({ message: "Message copied to clipboard!", variant: "success" }))
          .catch(() => toast.show({ message: "Failed to copy to clipboard", variant: "error" }))
        dialog.clear()
      },
    },
    {
      title: "Copy session transcript",
      value: "session.copy",
      category: "Session",
      slash: {
        name: "copy",
      },
      run: async () => {
        try {
          const sessionData = session()
          if (!sessionData) return
          const sessionMessages = messages()
          const transcript = formatTranscript(
            sessionData,
            sessionMessages.map((msg) => ({ info: msg, parts: sync.data.part[msg.id] ?? [] })),
            {
              thinking: showThinking(),
              toolDetails: showDetails(),
              assistantMetadata: showAssistantMetadata(),
              providers: sync.data.provider,
            },
          )
          await clipboard.write?.(transcript)
          toast.show({ message: "Session transcript copied to clipboard!", variant: "success" })
        } catch {
          toast.show({ message: "Failed to copy session transcript", variant: "error" })
        }
        dialog.clear()
      },
    },
    {
      title: "Export session transcript",
      value: "session.export",
      category: "Session",
      slash: {
        name: "export",
      },
      run: async () => {
        try {
          const sessionData = session()
          if (!sessionData) return
          const defaultFilename = `session-${sessionData.id.slice(0, 8)}.md`

          const options = await DialogExportOptions.show(
            dialog,
            defaultFilename,
            showThinking(),
            showDetails(),
            showAssistantMetadata(),
            false,
          )

          if (options === null) return

          // #254：导出必须绕过 TUI 本地 200 条渲染窗口，直接让 daemon 从数据库读取完整可见会话；
          // 这样只影响 export 的快照来源，不改变当前页面渲染、copy transcript 或 sync store 的内存边界。
          // #254：throwOnError 让非 2xx 直接抛出——由外层既有 catch 统一转为失败 toast
          const sessionMessages = await sdk.client.session.messages({ sessionID: sessionData.id }, { throwOnError: true })
          // #254：200 响应必须携带 messages 数组；SDK/daemon 返回异常形态时沿用既有失败 toast，不能静默写出空 Markdown
          if (!sessionMessages.data) throw new Error("Missing session messages for export")

          const transcript = formatTranscript(
            sessionData,
            sessionMessages.data,
            {
              thinking: options.thinking,
              toolDetails: options.toolDetails,
              assistantMetadata: options.assistantMetadata,
              providers: sync.data.provider,
            },
          )

          if (options.openWithoutSaving) {
            // Just open in editor without saving
            await openEditor({
              renderer,
              value: transcript,
              cwd:
                (project.instance.path().worktree === "/" ? undefined : project.instance.path().worktree) ||
                project.instance.directory() ||
                paths.cwd,
            })
          } else {
            const exportDir = paths.cwd
            const filename = options.filename.trim()
            const filepath = path.join(exportDir, filename)

            await writeExport(filepath, transcript)

            // Open with EDITOR if available
            const result = await openEditor({
              renderer,
              value: transcript,
              cwd:
                (project.instance.path().worktree === "/" ? undefined : project.instance.path().worktree) ||
                project.instance.directory() ||
                paths.cwd,
            })
            if (result !== undefined) {
              await writeExport(filepath, result)
            }

            toast.show({ message: `Session exported to ${filename}`, variant: "success" })
          }
        } catch {
          toast.show({ message: "Failed to export session", variant: "error" })
        }
        dialog.clear()
      },
    },
    {
      title: "Background subagents",
      value: "session.background",
      category: "Session",
      hidden: true,
      enabled: foregroundTasks().length > 0,
      run: () => {
        void sdk.client.experimental.session.background({
          sessionID: route.sessionID,
          workspace: project.workspace.current(),
        })
        dialog.clear()
      },
    },
    {
      title: "Go to child session",
      value: "session.child.first",
      category: "Session",
      hidden: true,
      run: () => {
        dialog.clear()
        moveFirstChild()
      },
    },
    {
      title: "Go to parent session",
      value: "session.parent",
      category: "Session",
      hidden: true,
      enabled: !!session()?.parentID,
      run: childSessionHandler(() => {
        const parentID = session()?.parentID
        if (parentID) {
          navigate({
            type: "session",
            sessionID: parentID,
          })
        }
        dialog.clear()
      }),
    },
    {
      title: "Next child session",
      value: "session.child.next",
      category: "Session",
      hidden: true,
      enabled: !!session()?.parentID,
      run: childSessionHandler(() => {
        dialog.clear()
        moveChild(1)
      }),
    },
    {
      title: "Previous child session",
      value: "session.child.previous",
      category: "Session",
      hidden: true,
      enabled: !!session()?.parentID,
      run: childSessionHandler(() => {
        dialog.clear()
        moveChild(-1)
      }),
    },
  ])

  const sessionCommands = createMemo(() =>
    sessionCommandList().map((command) => ({
      namespace: "palette",
      name: command.value,
      desc: "description" in command ? command.description : undefined,
      slashName: "slash" in command ? command.slash?.name : undefined,
      slashAliases: "slash" in command ? command.slash?.aliases : undefined,
      ...command,
    })),
  )

  useBindings(() => ({
    commands: sessionCommands(),
  }))

  useBindings(() => ({
    bindings: tuiConfig.keybinds.gather("session.global", sessionGlobalBindingCommands),
  }))

  useBindings(() => ({
    enabled: () => renderer.currentFocusedEditor === null,
    bindings: tuiConfig.keybinds.gather("session.global.unfocused", sessionGlobalUnfocusedBindingCommands),
  }))

  useBindings(() => ({
    mode: OPENCODE_BASE_MODE,
    bindings: tuiConfig.keybinds.gather("session", sessionBindingCommands),
  }))

  useBindings(() => ({
    mode: OPENCODE_BASE_MODE,
    enabled: foregroundTasks().length > 0,
    priority: 1,
    bindings: tuiConfig.keybinds.get("session.background"),
  }))

  const revertInfo = createMemo(() => session()?.revert)
  const revertMessageID = createMemo(() => revertInfo()?.messageID)
  const revertMessageIndex = createMemo(() => {
    const messageID = revertMessageID()
    if (!messageID) return -1
    return messages().findIndex((message) => message.id === messageID)
  })

  const revertDiffFiles = createMemo(() => getRevertDiffFiles(revertInfo()?.diff ?? ""))

  const revertRevertedMessages = createMemo(() => {
    const messageID = revertMessageID()
    if (!messageID) return []
    const index = revertMessageIndex()
    // 缺失边界时按本地保守展示合同隐藏窗口，不据此推断边界的真实时间位置。
    return messages()
      .slice(index === -1 ? 0 : index)
      .filter((message) => message.role === "user")
  })

  const revert = createMemo(() => {
    const info = revertInfo()
    if (!info) return
    if (!info.messageID) return
    return {
      messageID: info.messageID,
      reverted: revertRevertedMessages(),
      diff: info.diff,
      diffFiles: revertDiffFiles(),
    }
  })

  // snap to bottom when session changes
  // #551：会话/reviewID 变化统一走 session-open 滚动——reviewID 存在时锚点优先于贴底。
  // 594：defer 跳过 mount 发射——mount 不是导航，mount 期贴底由 stickyStart 初始位置
  // 与守卫后的路径 A 承担；dep 变化（真实导航/锚点）仍无条件贴底或锚定（INV-03/04）。
  createEffect(on(() => ({ sessionID: route.sessionID, reviewID: route.reviewID }), () => scheduleSessionOpenScroll(), { defer: true }))

  return (
    <LocationProvider location={location()}>
      <context.Provider
        value={{
          get width() {
            return messageContentWidth()
          },
          sessionID: route.sessionID,
          conceal,
          showThinking,
          showTimestamps,
          showDetails,
          showGenericToolOutput,
          diffWrapMode,
          providers,
          sync,
          tui: tuiConfig,
          // [0624] 渲染资源窗口向 Message 渲染层暴露只读视图与标脏/交互回写入口。
          messageView: (id: string) => messageView[id],
          pinnedMessages: renderPins,
          requestUsage,
          markMessageDirty,
          interaction: interactionState,
        }}
      >
        <box flexDirection="row" flexGrow={1} minHeight={0}>
          <box flexGrow={1} minHeight={0} paddingBottom={1} paddingLeft={2} paddingRight={1} gap={1}>
            <Show when={session()}>
              <scrollbox
                ref={(r) => (scroll = r)}
                // #212：由原生 renderAfter 在布局后跟随增长，无需 part 长度信号。
                renderAfter={syncSessionViewportStuckToBottom}
                // 裁剪与粘底跟随独立，布局后仍同步原有跟随信号。
                viewportCulling={viewportCulling()}
                viewportOptions={{
                  // #144：滚动条占位，避免消息贴到 scrollbar 轨道
                  paddingRight: showScrollbar() ? 1 : 0,
                }}
                // #144：contentOptions 再留一列，viewport padding 不足以避开 overlay 字形
                contentOptions={{
                  paddingRight: showScrollbar() ? 1 : 0,
                }}
                verticalScrollbarOptions={{
                  paddingLeft: 0, // viewport 已预留一列，轨道不再重复挤占内容宽度。
                  visible: showScrollbar(),
                  trackOptions: {
                    backgroundColor: theme.backgroundElement,
                    foregroundColor: theme.textMuted, // 跟随终端主题，避免固定颜色在深浅背景上失去对比度。
                    // #109：原生滚动条后接平滑重绘
                    renderAfter: drawSessionScrollbar,
                  },
                }}
                stickyScroll={true}
                stickyStart="bottom"
                // [0628] 布局前保持可见内容：前方几何变化（挂载/壳化/换行重排）
                // 不再事后补偿，分帧重测的中间帧也不推走正在阅读的消息。
                preserveVisibleContent={true}
                // [0628] 一行贴底容差：终端舍入/滚动条半格绘制下最新行看似脱节时
                // 仍跟随增长；普通一行上滚保持阅读位置不被吞。
                stickyScrollTolerance={1}
                flexGrow={1}
                scrollAcceleration={scrollAcceleration()}
              >
                <box height={1} />
                <For each={messages()}>
                  {(message, index) => (
                    <Switch>
                      <Match when={message.id === revert()?.messageID}>
                        {(function () {
                          const redoShortcut = useCommandShortcut("session.redo")
                          const [hover, setHover] = createSignal(false)
                          const dialog = useDialog()

                          const handleUnrevert = async () => {
                            const confirmed = await DialogConfirm.show(
                              dialog,
                              "Confirm Redo",
                              "Are you sure you want to restore the reverted messages?",
                            )
                            if (confirmed) {
                              keymap.dispatchCommand("session.redo")
                            }
                          }

                          return (
                            <box
                              onMouseOver={() => setHover(true)}
                              onMouseOut={() => setHover(false)}
                              onMouseUp={handleUnrevert}
                              marginTop={1}
                              flexShrink={0}
                              border={["left"]}
                              customBorderChars={SplitBorder.customBorderChars}
                              borderColor={theme.backgroundPanel}
                            >
                              <box
                                paddingTop={1}
                                paddingBottom={1}
                                paddingLeft={2}
                                backgroundColor={hover() ? theme.backgroundElement : theme.backgroundPanel}
                              >
                                <text fg={theme.textMuted}>{revert()!.reverted.length} message reverted</text>
                                <text fg={theme.textMuted}>
                                  <span style={{ fg: theme.text }}>{redoShortcut()}</span> or /redo to restore
                                </text>
                                <Show when={revert()!.diffFiles?.length}>
                                  <box marginTop={1}>
                                    <For each={revert()!.diffFiles}>
                                      {(file) => (
                                        <text fg={theme.text}>
                                          {file.filename}
                                          <Show when={file.additions > 0}>
                                            <span style={{ fg: theme.diffAdded }}> +{file.additions}</span>
                                          </Show>
                                          <Show when={file.deletions > 0}>
                                            <span style={{ fg: theme.diffRemoved }}> -{file.deletions}</span>
                                          </Show>
                                        </text>
                                      )}
                                    </For>
                                  </box>
                                </Show>
                              </box>
                            </box>
                          )
                        })()}
                      </Match>
                      <Match
                        // 0584：boundary 不在窗口时 revertMessageIndex() 为 -1，
                        // 全部 index >= -1 均隐藏（fail closed），不再用 !== -1 守卫误显示已回退消息。
                        when={revert()?.messageID && index() >= revertMessageIndex()}
                      >
                        <></>
                      </Match>
                      <Match when={message.role === "user"}>
                        <UserMessage
                          index={index()}
                          onMouseUp={(goalContinuation) => {
                            if (renderer.getSelection()?.getSelectedText()) return
                            dialog.replace(() => (
                              <DialogMessage
                                messageID={message.id}
                                sessionID={route.sessionID}
                                goalContinuation={goalContinuation}
                                setPrompt={(promptInfo) => prompt?.set(promptInfo)}
                                submit={() => promptRef.current?.submit()}
                              />
                            ))
                          }}
                          message={message as UserMessage}
                          parts={sync.data.part[message.id] ?? []}
                          pending={pending()}
                        />
                      </Match>
                      <Match when={message.role === "assistant"}>
                        <AssistantMessage
                          // 使用整个消息列表的位置，用户消息之后的助手也保留旧版外部断行。
                          index={index()}
                          last={lastAssistant()?.id === message.id}
                          message={message as AssistantMessage}
                          parts={sync.data.part[message.id] ?? []}
                        />
                      </Match>
                    </Switch>
                  )}
                </For>
              </scrollbox>
              <box
              flexShrink={0}
              // #109：从 prompt 顶清到屏底，消除滚动残影
              renderBefore={function (this: BoxRenderable, buffer: OptimizedBuffer) {
                const x = Math.max(0, this.screenX)
                const y = Math.max(0, this.screenY)
                const width = Math.min(this.width, buffer.width - x)
                // #109：高度必须是剩余全高，不能只刷一行
                const height = buffer.height - y
                if (width > 0 && height > 0) {
                  buffer.fillRect(x, y, width, height, theme.background)
                }
              }}
            >
                <Show when={permissions().length > 0}>
                  <PermissionPrompt
                    request={permissions()[0]}
                    directory={sync.session.get(permissions()[0].sessionID)?.directory}
                  />
                </Show>
                <Show when={permissions().length === 0 && questions().length > 0}>
                  <QuestionPrompt
                    request={questions()[0]}
                    directory={sync.session.get(questions()[0].sessionID)?.directory}
                  />
                </Show>
                {/* 面板归此 Show owner 管理，隐藏时释放订阅，已开始的文件读取仍可自然完成。 */}
                <Show when={permissions().length === 0 && questions().length === 0 && contextVisible()}>
                  <ContextUsagePanel sessionID={route.sessionID} onClose={() => setContextVisible(false)} />
                </Show>
                <Show when={session()?.parentID}>
                  <SubagentFooter />
                </Show>
                <Show when={visible()}>
                  <pluginRuntime.Slot
                    name="session_prompt"
                    mode="replace"
                    session_id={route.sessionID}
                    visible={visible()}
                    disabled={disabled()}
                    on_submit={toBottom}
                    ref={bind}
                  >
                    <Prompt
                      visible={visible()}
                      ref={bind}
                      disabled={disabled()}
                      onSubmit={() => {
                        toBottom()
                      }}
                      sessionID={route.sessionID}
                      right={<pluginRuntime.Slot name="session_prompt_right" session_id={route.sessionID} />}
                    />
                  </pluginRuntime.Slot>
                </Show>
              </box>
            </Show>
            <Toast />
          </box>
          <Show when={sidebarVisible()}>
            <Switch>
              <Match when={wide()}>
                <Sidebar sessionID={route.sessionID} />
              </Match>
              <Match when={!wide()}>
                <box
                  position="absolute"
                  top={0}
                  left={0}
                  right={0}
                  bottom={0}
                  alignItems="flex-end"
                  backgroundColor={RGBA.fromInts(0, 0, 0, 70)}
                >
                  <Sidebar sessionID={route.sessionID} />
                </box>
              </Match>
            </Switch>
          </Show>
        </box>
      </context.Provider>
    </LocationProvider>
  )
}

function UserMessage(props: {
  message: UserMessage
  parts: Part[]
  onMouseUp: (goalContinuation: boolean) => void
  index: number
  pending?: number
}) {
  const ctx = use()
  const local = useLocal()
  // #520：同一个 memo 同时驱动正文、badge 和动作 subtype，三处不会产生不同识别结果。
  const goal = createMemo(() => goalContinuation(props.parts))
  // 普通用户文本仍走原路径；旧 continuation 暂时保留既有 objective 提取，
  // 新 marker 由 goal view 独占，避免同一内容在卡片内重复渲染。
  const text = createMemo(() => {
    const texts = props.parts
      .map((x) => {
        if (x.type !== "text") return null
        // #520：synthetic Goal 已由上方 exact parser 消费；其他 synthetic 文本不属于用户可见正文。
        if (!x.synthetic) return x.text
        return null
      })
      .filter(Boolean)
    return texts.join("\n\n")
  })
  // #520：continuation 只替换现有卡片的正文来源，外层 Agent 身份、时间和附件布局保持共享。
  const content = createMemo(() => goal()?.objective ?? text())
  const files = createMemo(() => props.parts.flatMap((x) => (x.type === "file" ? [x] : [])))
  const { theme } = useTheme()
  const [hover, setHover] = createSignal(false)
  const queued = createMemo(() => props.pending !== undefined && props.index > props.pending)
  const color = createMemo(() => local.agent.color(props.message.agent))
  const queuedFg = createMemo(() => selectedForeground(theme, color()))
  const metadataVisible = createMemo(() => queued() || ctx.showTimestamps())

  const compaction = createMemo(() => props.parts.find((x) => x.type === "compaction"))

  // [0624] 渲染窗口视图：无记录时默认挂载/auto（初始加载等价旧行为）；pin 覆盖释放决定，
  // 保证导航目标与选区穿越区间在滚动同帧完成挂载，而不是下一帧才补齐。
  const view = createMemo(() => ctx.messageView(props.message.id))
  const mounted = createMemo(() => (view()?.mounted ?? true) || ctx.pinnedMessages().has(props.message.id))
  // 驻留时保持 auto 跟随流式/异步高度；只有已释放的根才使用冻结的实测高度。
  const fixedHeight = createMemo(() => (mounted() ? ("auto" as const) : (view()?.height ?? "auto")))
  // 内容 owner 已销毁时正文仍可能被 durable Part 更新：标脏交给 Session 统一重测
  // 这一条的真实高度，其余根的冻结几何不动。Sync store 用 reconcile 原位合并，Part
  // 对象与数组引用都不变，因此监听影响行高的属性级内容签名（文本正文 + 附件行数）。
  const contentVersion = createMemo(() => [content(), files().length] as const)
  createEffect(
    on(
      contentVersion,
      () => {
        ctx.markMessageDirty(props.message.id)
      },
      { defer: true },
    ),
  )

  return (
    <>
      <Show when={content()}>
        <box
          id={props.message.id}
          ref={(el: BoxRenderable) => alwaysSeparate.add(el)}
          border={["left"]}
          borderColor={color()}
          customBorderChars={SplitBorder.customBorderChars}
          marginTop={props.index === 0 ? 0 : 1}
          height={fixedHeight()}
        >
          <box
            onMouseOver={() => {
              setHover(true)
            }}
            onMouseOut={() => {
              setHover(false)
            }}
            // #520：marker 已在同一 Message 内完成识别；动作菜单只接收 subtype 结果，不重复解析 XML。
            onMouseUp={() => props.onMouseUp(goal() !== undefined)}
            paddingTop={1}
            paddingBottom={1}
            paddingLeft={2}
            backgroundColor={hover() ? theme.backgroundElement : theme.backgroundPanel}
            flexShrink={0}
          >
            <Show when={mounted()}>
              <text fg={theme.text}>{content()}</text>
            </Show>
            <Show when={mounted() && goal()}>
              {(item) => (
                // #520：gap={1} 是两个独立 badge 之间的可见列，不依赖文本尾部空格碰巧分隔。
                <box flexDirection="row" paddingTop={1} gap={1}>
                  {/* GOAL badge 与左边框共享 Agent 身份色；mode badge 保持中性，不能伪造新角色。 */}
                  <text fg={theme.text}>
                    <span style={{ bg: color(), fg: queuedFg(), bold: true }}> GOAL </span>
                  </text>
                  <text fg={theme.text}>
                    <span style={{ bg: theme.backgroundElement, fg: theme.textMuted }}>
                      {` ${item().label}${item().count ? ` · ${item().count}` : ""} `}
                    </span>
                  </text>
                </box>
              )}
            </Show>
            <Show when={mounted() && files().length}>
              <box flexDirection="row" paddingBottom={metadataVisible() ? 1 : 0} paddingTop={1} gap={1} flexWrap="wrap">
                <For each={files()}>
                  {(file) => {
                    const directory = file.mime === "application/x-directory"
                    return (
                      <text fg={theme.text}>
                        <span style={{ bg: theme.secondary, fg: theme.background }}>
                          {directory ? " Directory " : " File "}
                        </span>
                        <span style={{ bg: theme.backgroundElement, fg: theme.textMuted }}> {file.filename} </span>
                      </text>
                    )
                  }}
                </For>
              </box>
            </Show>
            <Show
              when={mounted() && queued()}
              fallback={
                <Show when={mounted() && ctx.showTimestamps()}>
                  <text fg={theme.textMuted}>
                    <span style={{ fg: theme.textMuted }}>
                      {Locale.todayTimeOrDateTime(props.message.time.created)}
                    </span>
                  </text>
                </Show>
              }
            >
              <text fg={theme.textMuted}>
                <span style={{ bg: color(), fg: queuedFg(), bold: true }}> QUEUED </span>
              </text>
            </Show>
          </box>
        </box>
      </Show>
      <Show when={compaction()}>
        <box
          id={content() ? undefined : props.message.id}
          marginTop={1}
          border={["top"]}
          // compaction.auto 是持久化边界上区分自动/手动压缩的来源；主视图文案需要和 v2 调试视图保持一致。
          title={compaction()?.auto ? " Auto Compaction " : " Compaction "}
          titleAlignment="center"
          borderColor={theme.borderActive}
        />
      </Show>
    </>
  )
}

type MessageRenderItem =
  | { kind: "part"; key: string; part: Part }
  | { kind: "reasoning-run"; key: string; parts: ReasoningPart[] }

function projectMessageParts(messageID: string, parts: Part[]) {
  // 只投影本消息的原始Part引用，不改持久化身份、正文或delta路由。
  const result: MessageRenderItem[] = []
  let reasoning: ReasoningPart[] = []
  let boundary: Part | undefined
  const flush = () => {
    if (reasoning.length === 0) return
    // 身份锚定前置硬边界，乱序前插成员不会清掉用户的展开状态。
    result.push({
      kind: "reasoning-run",
      key: boundary ? `${messageID}:reasoning:after:${boundary.id}` : `${messageID}:reasoning:start`,
      parts: reasoning,
    })
    // 新数组不再修改已交给描述符的成员列表。
    reasoning = []
  }
  parts.forEach((part) => {
    if (part.type === "reasoning") {
      reasoning.push(part)
      return
    }
    // 空text和隐藏工具仍是原始边界，不能先按可见性过滤再聚合。
    flush()
    result.push({ kind: "part", key: `part:${part.id}`, part })
    boundary = part
  })
  flush()
  return result
}

// 三态沿用旧版：首块 false、正文后 true、连续工具 undefined（交给实际兄弟行测量）。
const ToolPartTopMargin = createContext<() => boolean | undefined>(() => undefined)

function AssistantMessage(props: { index: number; message: AssistantMessage; parts: Part[]; last: boolean }) {
  const ctx = use()
  const local = useLocal()
  const { theme } = useTheme()
  const sync = useSync()
  const messages = createMemo(() => sync.data.message[props.message.sessionID] ?? [])
  const model = createMemo(() => Model.name(ctx.providers(), props.message.providerID, props.message.modelID))
  const renderItems = createMemo(() => projectMessageParts(props.message.id, props.parts))
  const itemByKey = createMemo(() => new Map(renderItems().map((item) => [item.key, item])))
  const renderItemKeys = createMemo(() => renderItems().map((item) => item.key))

  const final = createMemo(() => {
    return props.message.finish && !["tool-calls", "unknown"].includes(props.message.finish)
  })
  const presentation = createMemo(() => {
    const margins = new Map<string, { top: boolean; tool: boolean | undefined }>()
    let previous: MessageRenderItem | undefined
    let content = false
    // 只遍历当前消息一次，复用旧版可见前驱关系；可见性不改原始 run 边界和 primitive key。
    renderItems().forEach((item) => {
      const body = item.kind === "reasoning-run"
        ? ctx.showThinking() && item.parts.some((part) => normalizeReasoning(part.text))
        : (item.part.type === "text" || item.part.type === "tool") && isVisibleAssistantPart(
            item.part, { showDetails: ctx.showDetails(), showThinking: ctx.showThinking() },
          )
      // 新版 opaque Thought 有标题但没有正文：参与首距，仍不单独触发完成态 footer。
      if (!body && !(item.kind === "reasoning-run" && ctx.showThinking() && item.parts.some((part) => part.metadata))) return
      margins.set(item.key, {
        top: previous !== undefined,
        tool: !previous ? false : previous.kind === "part" && previous.part.type === "tool" ? undefined : true,
      })
      previous = item
      content ||= body
    })
    return { margins, content }
  })
  const footerVisible = createMemo(() => {
    // 中断可能发生在首个正文之前，错误身份不能因消息为空而被这道可见性门槛吞掉。
    if (!presentation().content && !props.message.error) return false
    // 最后一条仍在流式生成不等于完成，不能恢复原 props.last 触发的过早元信息。
    return final() || props.message.error?.name === "MessageAbortedError"
  })

  const duration = createMemo(() => {
    // final() 在 assistant completed 后为真；未完成时 footer 不显示耗时
    if (!final()) return 0
    // #243：消息 footer 是完成态的权威展示，耗时必须和运行中 footer 共用
    // parent user -> assistant completed 的 transcript 口径，避免两套算法漂移。
    // final() 已保证 completed 存在；此处仅做口径统一，不重算起点
    return assistantTurnDuration(messages(), props.message)
  })
  const turnUsage = createMemo(() => {
    if (!footerVisible()) return ""
    // 多个助手共享同一请求的权威累计，历史分页和其他请求的更新不改变其统计口径。
    const turnRequest = ctx.requestUsage().get(props.message.parentID)
    if (!turnRequest) return ""
    // 失败不退回不完整窗口；状态文本保留可见性，避免把缺证据伪装成零费用。
    if (turnRequest.error) return "usage unavailable"
    const usage = turnRequest()
    if (!usage) return turnRequest.loading ? "usage pending" : "usage unavailable"
    // SDK允许特殊数值的wire字符串，不能把它们当成已确认的数字相加。
    if (typeof usage.tokens.input !== "number" || typeof usage.tokens.output !== "number" || typeof usage.tokens.reasoning !== "number" || typeof usage.cost !== "number" || typeof usage.tokens.cache.read !== "number" || typeof usage.tokens.cache.write !== "number") return "usage unavailable"
    // 先取本次用户请求已确认的累计，再补尚未报告用量的估算；费用只取原来记录的真实费用。
    const value = sync.session.accounting(props.message.sessionID, undefined, props.message.parentID, {
      input: usage.tokens.input + usage.tokens.cache.read + usage.tokens.cache.write,
      inputPure: usage.tokens.input,
      output: usage.tokens.output + usage.tokens.reasoning,
      cost: usage.cost,
    }).request
    // 压缩要展示本次实际处理的全部输入；普通回复底部仍只展示新增输入。
    return formatUsageStats({ input: props.message.summary ? value.totalInput : value.totalInputPure, output: value.totalOutput, cost: value.cost })
  })

  const childShortcut = useCommandShortcut("session.child.first")
  const backgroundShortcut = useCommandShortcut("session.background")

  // [0624] 与 UserMessage 同一份渲染窗口视图：根保留 id/边框/实测高度，正文 owner 按
  // 驻留窗口与 pin 决定存亡；pin 覆盖释放，保证导航目标在滚动同帧挂载。
  const view = createMemo(() => ctx.messageView(props.message.id))
  const mounted = createMemo(() => (view()?.mounted ?? true) || ctx.pinnedMessages().has(props.message.id))
  // 驻留时 auto 跟随流式高度；只有已释放的根使用冻结的实测高度。
  const fixedHeight = createMemo(() => (mounted() ? ("auto" as const) : (view()?.height ?? "auto")))
  // 已释放后收到 durable Part 更新 → 标脏，由 Session 统一重测这一条的真实高度。
  // Sync store 用 reconcile 原位合并，Part/Message 对象身份不变，因此监听影响行高的
  // 属性级内容签名：text/reasoning 正文、tool 的 status/output/title/error，以及
  // Message 级 footer/error 的可见性来源。文件徽标等只影响同行内容的字段不改变行数，
  // 不在签名内；遗漏字段的代价是重建时读到新数据但冻结高度保持旧值，属已知边界。
  const contentVersion = createMemo(
    () =>
      [
        props.message.time.completed,
        props.message.finish,
        props.message.error?.name,
        ...props.parts.map((part) => {
          if (part.type === "text" || part.type === "reasoning") return part.text
          if (part.type === "tool")
            return [
              part.state.status,
              "output" in part.state ? part.state.output : undefined,
              "title" in part.state ? part.state.title : undefined,
              "error" in part.state ? part.state.error : undefined,
              // [0625] Shell 等工具的流式 progress 经 metadata.output 落地，状态字段不变；
              // 壳化后缺这个签名会让冻结高度与 scrollbar 落后于持续增长的真实正文。
              // pending 的 schema 没有 metadata 字段，in 守卫是类型与行为的双重边界。
              "metadata" in part.state ? part.state.metadata?.output : undefined,
            ]
          return part.type
        }),
      ] as const,
  )
  createEffect(
    on(
      contentVersion,
      () => {
        ctx.markMessageDirty(props.message.id)
      },
      { defer: true },
    ),
  )

  // 外部间距留在消息线之外；内部 part 空行仍在同一个根内，不能逐 part 分别画消息边框。
  // 保留直接子节点 ID 与冻结高度，正文释放和导航继续沿用现有 owner。
  return (
    <box id={props.message.id} flexShrink={0} border={["left"]} customBorderChars={SplitBorder.customBorderChars}
      borderColor={theme.backgroundElement} marginTop={props.index === 0 ? 0 : 1} height={fixedHeight()}>
      <Show when={mounted()}>
      <For each={renderItemKeys()}>
        {(key, index) => {
          // For保留primitive key对应的root，普通正文delta不重挂run。
          const item = createMemo(() => itemByKey().get(key)!)
          const margin = createMemo(() => presentation().margins.get(key))
          return (
            <Switch>
              <Match when={item().kind === "reasoning-run" && item()}>
                {(current) => <ReasoningRun parts={(current() as Extract<MessageRenderItem, { kind: "reasoning-run" }>).parts} topMargin={margin()?.top} />}
              </Match>
              <Match when={item().kind === "part" && item()}>
                {(current) => {
                  const part = () => (current() as Extract<MessageRenderItem, { kind: "part" }>).part
                  const component = createMemo(() => PART_MAPPING[part().type as keyof typeof PART_MAPPING])
                  return <Show when={component()}><ToolPartTopMargin.Provider value={() => margin()?.tool}>
                    <Dynamic last={index() === renderItemKeys().length - 1} component={component()} part={part() as any} message={props.message} topMargin={margin()?.top} />
                  </ToolPartTopMargin.Provider></Show>
                }}
              </Match>
            </Switch>
          )
        }}
      </For>
      </Show>
      <Show when={mounted() && props.parts.some((x) => x.type === "tool" && x.tool === "task")}>
        <box paddingTop={1} paddingLeft={3}>
          <text fg={theme.text}>
            {childShortcut()}
            <span style={{ fg: theme.textMuted }}> view subagents</span>
            <Show
              when={
                sync.data.capabilities.experimentalBackgroundSubagents &&
                props.parts.some(
                  (x) =>
                    x.type === "tool" &&
                    x.tool === "task" &&
                    x.state.status === "running" &&
                    x.state.metadata?.background !== true,
                )
              }
            >
              <span style={{ fg: theme.textMuted }}> · </span>
              {backgroundShortcut()}
              <span style={{ fg: theme.textMuted }}> background</span>
            </Show>
          </text>
        </box>
      </Show>
      <Show when={mounted() && props.message.error && props.message.error.name !== "MessageAbortedError"}>
        <box
          ref={(el: BoxRenderable) => alwaysSeparate.add(el)}
          border={["left"]}
          paddingTop={1}
          paddingBottom={1}
          paddingLeft={2}
          marginTop={1}
          backgroundColor={theme.backgroundPanel}
          customBorderChars={SplitBorder.customBorderChars}
          borderColor={theme.error}
        >
          <text fg={theme.textMuted}>{errorMessage(props.message.error)}</text>
        </box>
      </Show>
      <Switch>
        <Match when={mounted() && footerVisible()}>
          <box ref={(el: BoxRenderable) => alwaysSeparate.add(el)} paddingLeft={3}>
            <text marginTop={1}>
              <span
                style={{
                  fg:
                    props.message.error?.name === "MessageAbortedError"
                      ? theme.textMuted
                      : local.agent.color(props.message.agent),
                }}
              >
                ▣{" "}
              </span>{" "}
              <span style={{ fg: theme.text }}>{Locale.titlecase(props.message.mode)}</span>
              <span style={{ fg: theme.textMuted }}> · {model()}</span>
              <Show when={duration()}>
                <span style={{ fg: theme.textMuted }}> · {Locale.durationClock(duration())}</span>
                {/* #243：durationClock 入参毫秒，与运行中 footer 同一口径 */}
              </Show>
              <Show when={turnUsage()}>{(usage) => <span style={{ fg: theme.textMuted }}> · {usage()}</span>}</Show>
              <Show when={props.message.error?.name === "MessageAbortedError"}>
                <span style={{ fg: theme.textMuted }}> · interrupted</span>
              </Show>
            </text>
          </box>
        </Match>
      </Switch>
    </box>
  )
}

const PART_MAPPING = {
  text: TextPart,
  tool: ToolPart,
}

const INLINE_TOOL_ICON_WIDTH = 2

const REASONING_PREVIEW_ROWS = 5
// 分隔符只在显示投影中加入，各原Part仍独立解析且不改transcript。
const REASONING_SEPARATOR = "---\n"
function normalizeReasoning(text: string) {
  return text.replace("[REDACTED]", "").trim()
}

function reasoningRowsTotal(content: string[], width: number, widthMethod: WidthMethod) {
  const buffer = TextBuffer.create(widthMethod)
  const view = TextBufferView.create(buffer)
  try {
    view.setWrapWidth(Math.max(width, 1))
    view.setWrapMode("word")
    // 按真实终端宽度与宽字算法测量，每个Part的高亮chunk先拼回完整可见文本。
    return content.reduce((total, text) => {
      buffer.setText(text)
      return total + view.getVirtualLineCount()
    }, 0)
  } finally {
    // view借用buffer，先释放view，流式重算不得积累native句柄。
    view.destroy()
    buffer.destroy()
  }
}

export function ReasoningRun(props: { parts: ReasoningPart[]; topMargin?: boolean }) {
  const { theme } = useTheme()
  const ctx = use()
  const renderer = useRenderer()
  // 展开选择属于已有成员；前插或合并推理组不能因首 Part 改变而丢失选择。
  const expanded = createMemo(() => props.parts.some((part) => ctx.interaction.get(`reasoning:${part.messageID}:${part.id}`)))
  const [rendered, setRendered] = createSignal<Record<string, string | undefined>>({})
  const parts = createMemo(() => props.parts.filter((part) => normalizeReasoning(part.text)))
  // 加密占位仍显示上游Thought标题，不从metadata猜测正文或长度。
  const opaque = createMemo(() => parts().length === 0 && props.parts.some((part) => Boolean(part.metadata)))
  const texts = createMemo(() => parts().map((part) => normalizeReasoning(part.text)))
  const syntax = createSyntaxStyleMemo(() => generateSubtleSyntax(theme))
  const done = createMemo(() => props.parts.every((part) => part.time.end !== undefined))
  // 高亮未就绪时不伪造toggle；外层始终限高，首帧也不会先泄漏尾部再收回。
  const overflow = createMemo(() => {
    const content = parts().map((part) => rendered()[part.id])
    if (content.some((text) => text === undefined)) return false
    return reasoningRowsTotal(content.filter((text): text is string => text !== undefined), ctx.width, renderer.widthMethod) > REASONING_PREVIEW_ROWS
  })
  const duration = createMemo(() => Math.max(0, Math.max(...props.parts.map((part) => part.time.end ?? part.time.start)) - Math.min(...props.parts.map((part) => part.time.start))))
  return (
    <Show when={ctx.showThinking() && (parts().length > 0 || opaque())}>
      <box ref={(el: BoxRenderable) => alwaysSeparate.add(el)} border={["left"]} customBorderChars={SplitBorder.customBorderChars}
        borderColor={theme.backgroundElement} paddingLeft={2} marginTop={props.topMargin ? 1 : 0} flexDirection="column" flexShrink={0}
        onMouseUp={() => {
          if (renderer.getSelection()?.getSelectedText() || opaque() || !overflow()) return
          const value = !expanded()
          // 折叠清除全部成员，避免首片段移除后旧选择重新展开。
          batch(() => props.parts.forEach((part) => ctx.interaction.set(`reasoning:${part.messageID}:${part.id}`, value)))
        }}>
        <ReasoningHeader toggleable={overflow() && !opaque()} open={expanded()} done={done()}
          title={[reasoningSummary(texts()[0] ?? "").title, texts().length > 1 ? `${texts().length} segments` : undefined].filter(Boolean).join(" · ") || null}
          characters={opaque() ? undefined : texts().reduce((total, text) => total + text.length, 0)}
          duration={done() ? Locale.duration(duration()) : undefined} encrypted={opaque()} />
        {/* 每Part从首帧常驻，展开只改变共享裁剪约束，不挂第二棵异步高亮树。 */}
        <box maxHeight={expanded() ? undefined : REASONING_PREVIEW_ROWS} overflow={expanded() ? "visible" : "hidden"}>
          <For each={parts().map((part) => part.id)}>{(id, index) => {
            const part = createMemo(() => parts().find((item) => item.id === id)!)
            return <ReasoningBody id={`text-${id}`} part={part} separator={index() > 0} expanded={expanded() || !overflow()}
              width={ctx.width} syntaxStyle={syntax()} conceal={ctx.conceal()}
              onContent={(content) => setRendered((current) => current[id] === content ? current : { ...current, [id]: content })} />
          }}</For>
        </box>
        <Show when={overflow()}><text fg={theme.textMuted}>{expanded() ? "▲ 收起推理" : "▼ 展开查看完整推理"}</text></Show>
      </box>
    </Show>
  )
}

function ReasoningBody(props: { id: string; part: () => ReasoningPart; separator: boolean; expanded: boolean; width: number; syntaxStyle: ReturnType<typeof generateSubtleSyntax>; conceal: boolean; onContent: (content: string | undefined) => void }) {
  const { theme } = useTheme()
  // accessor跟随Part快照替换；固定分隔符不依赖source序号和总数。
  const content = createMemo(() => {
    const text = normalizeReasoning(props.part().text)
    return props.separator ? REASONING_SEPARATOR + text : text
  })
  // conceal改变会立即使旧可见文本失效，普通delta则保留已知文本直到新generation回报。
  createEffect(on(() => props.conceal, () => props.onContent(undefined)))
  // 保留上游per-Part完成判定，不等待父消息或其他成员结束。
  const done = createMemo(() => props.part().time.end !== undefined)
  return (
    <box flexShrink={0}>
      {/* 成员不参与共享五行约束的shrink；原宽度固定，独立Markdown只由外层裁尾。 */}
      <code id={props.id} width={props.width} filetype="markdown" drawUnstyledText={false} streaming={!done()}
        syntaxStyle={props.syntaxStyle} content={content()} conceal={props.conceal} fg={theme.textMuted} wrapMode={props.expanded ? "word" : "char"}
        onChunks={(chunks, context) => {
          // 只接受当前正文的高亮回报，旧异步结果不能覆盖新delta的测量依据。
          if (context.content !== content()) return chunks
          props.onContent(chunks.map((chunk) => chunk.text).join(""))
          return chunks
        }} />
    </box>
  )
}

function ReasoningHeader(props: {
  toggleable: boolean
  open: boolean
  done: boolean
  title: string | null
  characters?: number
  duration?: string
  encrypted?: boolean
}) {
  const { theme } = useTheme()
  // 沿源保留斜体强调色，展开透明度仍由现有思考状态决定。
  const fg = () =>
    props.open
      ? RGBA.fromValues(theme.markdownEmph.r, theme.markdownEmph.g, theme.markdownEmph.b, theme.thinkingOpacity)
      : theme.markdownEmph
  // 统计清理后全文，不受预览或摘要截断影响；加密块不传此值，标题不推测密文长度。
  const characters = () => (props.characters === undefined ? "" : `${props.characters.toLocaleString()} chars`)
  const completed = () => {
    if (props.encrypted) return `Thought${props.duration ? ` · ${props.duration}` : ""}`
    const detail = [props.title, characters(), props.duration].filter(Boolean).join(" · ")
    return `${props.toggleable ? (props.open ? "- " : "+ ") : ""}Thought${detail ? `: ${detail}` : ""}`
  }

  return (
    <Switch>
      <Match when={!props.done}>
        <box flexDirection="row" gap={1}>
          <Spinner color={fg()} />
          <text fg={fg()} attributes={TextAttributes.ITALIC}>
            {[props.title ? "Thinking: " + props.title : "Thinking", characters()].filter(Boolean).join(" · ")}
          </text>
        </box>
      </Match>
      <Match when={true}>
        <text fg={fg()} attributes={TextAttributes.ITALIC} wrapMode="none">
          {completed()}
        </text>
      </Match>
    </Switch>
  )
}

function TextPart(props: { last: boolean; part: TextPart; message: AssistantMessage; topMargin?: boolean }) {
  const ctx = use()
  const { theme, syntax } = useTheme()
  // #135：assistant 未完成则流式渲染
  const streaming = createMemo(() => !props.message.time?.completed)
  // [local-smark] 渲染熔断：超预算内容在构造 parser-backed Markdown 前降级纯文本；
  // streaming 与完成态共用同一确定性判定，分类不依赖完成状态，避免同一内容在流式中改变投影。
  const content = createMemo(() => props.part.text.trim())
  // 超预算内容改走纯 text renderable：32KiB/1000 行由 text-budget 模块固定，
  // per-Part 判定与完成态无关（streaming 与 settled 共用同一分类）。
  const overBudget = createMemo(() => !withinMarkdownBudget(content()))
  return (
    <Show when={content()}>
      <box ref={(el: BoxRenderable) => alwaysSeparate.add(el)} paddingLeft={3} marginTop={props.topMargin ? 1 : 0} flexShrink={0}>
        <Show
          when={overBudget()}
          fallback={
            <markdown
              syntaxStyle={syntax()}
              streaming={streaming()}
              internalBlockMode="top-level"
              content={content()}
              tableOptions={{ style: "grid" }}
              conceal={ctx.conceal()}
              fg={theme.markdownText}
              bg={theme.background}
            />
          }
        >
          {/* 超预算纯文本投影：构造前分类，非 parser 失败 fallback。 */}
          <text fg={theme.markdownText}>{content()}</text>
        </Show>
      </box>
    </Show>
  )
}

// Pending messages moved to individual tool pending functions

function ToolPart(props: { last: boolean; part: ToolPart; message: AssistantMessage }) {
  const ctx = use()
  const display = createMemo(() => toolDisplay(props.part.tool))

  // Hide tool if showDetails is false and tool completed successfully
  const shouldHide = createMemo(() => {
    // 子调用由父 execute 列表呈现；独立记录继续供归因和审计读取。
    if (typeof props.part.metadata?.executeParent === "string") return true
    // #185：与 isVisibleAssistantPart 同口径（详情关+completed 隐藏）
    if (ctx.showDetails()) return false
    return !isVisibleAssistantPart(
      { type: "tool", tool: props.part.tool, state: props.part.state },
      { showDetails: ctx.showDetails(), showThinking: true },
    )
  })

  const toolprops = {
    get metadata() {
      // V2结果在structured，历史V1仍在metadata；共用展示入口而不改变持久化信封。
      return props.part.state.status === "pending" ? {} : { ...props.part.state.metadata, ...toolDisplayMetadata(props.part.state) }
    },
    get input() {
      return props.part.state.input ?? {}
    },
    get output() {
      return props.part.state.status === "completed" ? props.part.state.output : undefined
    },
    get tool() {
      return props.part.tool
    },
    get part() {
      return props.part
    },
  }

  return (
    <Show when={!shouldHide()}>
      {/* #214：ToolAutoReview.Provider 提供 autoReview metadata——InlineTool/BlockTool 从 context 渲染共享审查状态行 */}
      <ToolAutoReview.Provider value={() => autoReviewMetadata(toolprops.metadata, props.part.tool)}>
        <Switch>
          <Match when={display() === "bash"}>
            <Shell {...toolprops} />
          </Match>
          <Match when={display() === "glob"}>
            <Glob {...toolprops} />
          </Match>
          <Match when={display() === "read"}>
            <Read {...toolprops} />
          </Match>
          <Match when={display() === "grep"}>
            <Grep {...toolprops} />
          </Match>
          <Match when={display() === "webfetch"}>
            <WebFetch {...toolprops} />
          </Match>
          <Match when={display() === "websearch"}>
            <WebSearch {...toolprops} />
          </Match>
          <Match when={display() === "write"}>
            <Write {...toolprops} />
          </Match>
          <Match when={display() === "edit"}>
            <Edit {...toolprops} />
          </Match>
          <Match when={display() === "task"}>
            <Task {...toolprops} />
          </Match>
          <Match when={display() === "execute"}>
            <Execute {...toolprops} />
          </Match>
          <Match when={display() === "apply_patch"}>
            <ApplyPatch {...toolprops} />
          </Match>
          <Match when={display() === "todowrite"}>
            <TodoWrite {...toolprops} />
          </Match>
          <Match when={display() === "question"}>
            <Question {...toolprops} />
          </Match>
          {/* #209：permission_review_decision 渲染为 reviewer 决策 cell */}
          <Match when={display() === "permission_review_decision"}>
            <PermissionReviewDecision {...toolprops} />
          </Match>
          <Match when={display() === "skill"}>
            <Skill {...toolprops} />
          </Match>
          <Match when={true}>
            <GenericTool {...toolprops} />
          </Match>
        </Switch>
      </ToolAutoReview.Provider>
    </Show>
  )
}

type ToolProps = {
  input: Record<string, unknown>
  metadata: Record<string, unknown>
  tool: string
  output?: string
  part: ToolPart
}
// #144：折叠预览沿用现有行数与字符预算，避免长单行绕过限幅
// 长单行也会占满终端；800 是字符上界，窄屏仍沿用更小的宽度预算。
const DEFAULT_BLOCK_CHAR_THRESHOLD = 800

function previewText(input: string, maxLines: number, maxChars = DEFAULT_BLOCK_CHAR_THRESHOLD) {
  // 折叠信号由footer承载，仍保留Unicode安全与随宽度变化的原字符预算。
  return collapseToolOutput(input, maxLines, Math.min(maxChars, DEFAULT_BLOCK_CHAR_THRESHOLD), false).output
}

// #224：工具标题只承担单行摘要职责，不能承载多行源码。这个阈值只影响
// generic/plugin tool 的标题参数展示；真实内容仍由完成态的 notebook diff/source
// card 或 generic output card 展示，避免 pending 阶段刷屏但不丢失结果可见性。
const TOOL_INPUT_VALUE_MAX_LENGTH = 120

function GenericTool(props: ToolProps) {
  const { theme } = useTheme()
  const ctx = use()
  const output = createMemo(() => props.output?.trim() ?? "")
  const [expanded, setExpanded] = useInteraction(() => `expanded:${props.part.id}`)
  // 20 行判断是否折叠，预览保留 10 行；字符预算继续随终端宽度变化。
  const maxLines = 10
  const maxChars = createMemo(() => maxLines * Math.max(20, ctx.width - 6))
  const collapsed = createMemo(() => collapseToolOutput(output(), 20, Math.min(maxChars() * 2, DEFAULT_BLOCK_CHAR_THRESHOLD)))
  const limited = createMemo(() => {
    if (expanded() || !collapsed().overflow) return output()
    return previewText(output(), maxLines, maxChars())
  })
  // Notebook完成态消费紧凑元数据，流式参数只用于pending摘要，不访问VS Code。
  const pendingStats = createPendingToolInputStats(() => props.part)
  const notebook = useVscodeNotebookToolView({
    tool: () => props.tool,
    input: () => props.input as Record<string, unknown>,
    metadata: () => props.metadata as Record<string, unknown>,
    output,
    status: () => props.part.state.status,
    pendingStats,
    width: () => ctx.width,
    diffWrapMode: ctx.diffWrapMode,
  })
  // #224：notebookInline 只在 view.mode === "inline" 时有值——控制 Switch 的第一个 Match
  const notebookInline = createMemo(() => {
    const view = notebook()
    return view?.mode === "inline" ? view : undefined
  })
  // #224：notebookBlock 只在 view.mode === "block" 时有值——控制 Switch 的第二个 Match
  const notebookBlock = createMemo(() => {
    const view = notebook()
    return view?.mode === "block" ? view : undefined
  })
  // 外层沿用同一展开状态；小卡片直接显示正文，超预算时才使用Notebook预览。
  const notebookOverflow = createMemo(() => {
    const view = notebookBlock()
    return Boolean(view?.preview) && ((view?.totalLines ?? 0) > (view?.threshold ?? 20) || (view?.totalChars ?? 0) > maxChars() * 2)
  })

  return (
    <Switch>
      {/* #224：notebook inline 视图——pending 态和完成态的轻量单行摘要 */}
      <Match when={notebookInline()}>
        {(view) => (
          <InlineTool icon={view().icon} pending={view().pending} complete={view().complete} part={props.part}>
            {view().children}
          </InlineTool>
        )}
      </Match>
      {/* #224：notebook block 视图——完成态的 diff/source/summary/run/output/env card */}
      <Match when={notebookBlock()}>
        {(view) => (
          <BlockTool
            title={view().title}
            part={props.part}
            onClick={notebookOverflow() ? () => setExpanded((prev) => !prev) : undefined}
            preview={notebookOverflow() && !expanded() ? view().preview : undefined}
            footer={notebookOverflow() ? "Click to collapse" : undefined}
          >
            {/* [0624] view().body 是工厂：BlockTool 每次展开重新调用，得到全新内容树 */}
            {view().body()}
          </BlockTool>
        )}
      </Match>
      {/* #94/#144：通用工具输出——保留折叠/展开逻辑，仅当有 output 且 showGenericToolOutput 时进入 */}
      <Match when={props.output && ctx.showGenericToolOutput()}>
        <BlockTool
          title={`# ${props.tool} ${input(props.input)}`}
          part={props.part}
          onClick={collapsed().overflow ? () => setExpanded((prev) => !prev) : undefined}
          footer={collapsed().overflow ? "Click to collapse" : undefined}
          // #144：通用工具折叠预览
          preview={
            collapsed().overflow && !expanded() ? <text fg={theme.text}>{previewText(limited(), 10, maxChars())}</text> : undefined
          }
        >
          <box gap={1}>
            <text fg={theme.text}>{expanded() || !collapsed().overflow ? output() : limited()}</text>
          </box>
        </BlockTool>
      </Match>
      {/* #224：无 output 或关闭 generic 输出时回退到 inline 单行摘要 */}
      <Match when={true}>
        <InlineTool icon="⚙" pending="Writing command…" complete={true} part={props.part}>
          {props.tool} {input(props.input)}
        </InlineTool>
      </Match>
    </Switch>
  )
}

// #209：auto-review metadata 类型——reviewID/sessionID/status/precheck/result 描述 reviewer 状态
// #209：AutoReviewMetadata 由 service.ts updateToolAutoReview 写入工具 part 的 state.metadata.autoReview
// #214：ToolAutoReview context——BlockTool/InlineTool 共享一行审查状态，无需各工具显式传 prop
const ToolAutoReview = createContext<() => AutoReviewMetadata | undefined>(() => undefined)
type AutoReviewMetadata = {
  reviewID: string
  tool: string
  sessionID?: string
  // #216：aborted 状态——工具执行被取消时审查终止，与 reviewing/allowed/denied 等终态并列
  status?: "reviewing" | "allowed" | "denied" | "timed_out" | "failed" | "fallback_user" | "aborted"
  precheck?: { level: string; reason: string }
  result?: { risk_level: string; user_authorization: string; rationale: string }
}

// #209：从工具 metadata 提取 autoReview——非对象或缺少 reviewID 返回 undefined
export function autoReviewMetadata(metadata: Record<string, unknown>, tool: string): AutoReviewMetadata | undefined {
  const value = metadata.autoReview
  // #209：非对象或数组直接拒绝——防止 string/number 等 metadata 被强转为 review 结构
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  const review = value as Record<string, unknown>
  // #209：reviewID 是 reviewer 写入的必填锚点——缺少则非有效 auto-review 注解，避免渲染空壳状态行
  if (typeof review.reviewID !== "string") return
  // #296：tool 由调用方从 part.tool 注入，供父卡片兜底区分 shell 与 inline 工具坐标语义
  return { ...(review as AutoReviewMetadata), tool }
}

// #209：auto-review 状态标签——两行合约：命令 + 一行紧凑审查状态
export function autoReviewLabel(review: AutoReviewMetadata) {
  const agent = "@permission-reviewer"
// #214：autoReviewLabel 注释更新——placement 归 InlineTool/BlockTool，此函数仅拥有紧凑状态文案
// #214：◌/✓/! 三态字形是协议状态——reviewing 进行中、allowed 通过、! 覆盖所有非 allow 终态
// ◌ reviewing, ✓ allowed, ! all non-allow terminal outcomes
  switch (review.status) {
    case "allowed":
      return `✓ auto review · allowed · auth ${review.result?.user_authorization ?? "unknown"} · ${agent}`
    case "denied":
      return `! auto review · denied · ${review.result?.risk_level ?? "unknown"} risk · auth ${review.result?.user_authorization ?? "unknown"} · ${agent}`
    case "timed_out":
      return `! auto review · timed out · failed closed · ${agent}`
    case "failed":
      return `! auto review · failed · failed closed · ${agent}`
    case "fallback_user":
      return `! auto review · unavailable · asking user · ${agent}`
    // #216：aborted 状态——工具执行被取消时审查终止，展示 ! + aborted + @permission-reviewer
    case "aborted":
      return `! auto review · aborted · ${agent}`
    default:
      return `◌ auto review · ${review.precheck?.level ?? "reviewing"} · ${agent}`
  }
}

// #209：auto-review 颜色——allowed 绿色，非 reviewing 非 allowed 橙色，其他蓝色
// #209：颜色与字形分工——字形区分通过/失败，颜色补充严重度：终态失败橙色比 reviewing 蓝色更醒目
function autoReviewColor(review: AutoReviewMetadata, theme: ReturnType<typeof useTheme>["theme"]) {
  if (review.status === "allowed") return theme.success
  if (review.status && review.status !== "reviewing") return theme.warning
  return theme.info
}

// #209：AutoReviewLine——可点击导航到 reviewer 子会话的审查状态行
function AutoReviewLine(props: { review: AutoReviewMetadata }) {
  const { theme } = useTheme()
  const { navigate } = useRoute()
  const renderer = useRenderer()
  const [hover, setHover] = createSignal(false)
  // #209：仅当有 sessionID 时可点击——无子会话的审查不可导航，hover 也不高亮
  const clickable = createMemo(() => Boolean(props.review.sessionID))
  const openReview = (evt: MouseEvent) => openAutoReviewSession(props.review, navigate, renderer, evt)
  // 审查行是导航入口，关闭文本选择并让整行处理点击，避免普通点击被当成选区。
  return (
    <box
      id={autoReviewLineID(props.review)}
      width="100%"
      height={1}
      flexShrink={0}
      onMouseUp={openReview}
      onMouseOver={() => clickable() && setHover(true)}
      onMouseOut={() => setHover(false)}
    >
      <text
        id={autoReviewLabelID(props.review)}
        selectable={false}
        fg={hover() ? theme.text : autoReviewColor(props.review, theme)}
        wrapMode="none"
        onMouseUp={openReview}
      >
        {autoReviewLabel(props.review)}
      </text>
    </box>
  )
}

function autoReviewLineID(review: AutoReviewMetadata) {
  return `auto-review-${review.reviewID}`
}

function autoReviewLabelID(review: AutoReviewMetadata) {
  // 鼠标目标可能是内部文本；标签与外层行共享reviewID，只参与本地命中判断。
  return `${autoReviewLineID(review)}-label`
}

function autoReviewLineTarget(review: AutoReviewMetadata, target: Renderable | null | undefined) {
  const id = autoReviewLineID(review)
  const label = autoReviewLabelID(review)
  for (let item = target; item; item = item.parent) {
    if (item.id === id || item.id === label) return { row: item, direct: true }
    const child = item.findDescendantById(id)
    if (child) return { row: child, direct: false }
  }
}

function openAutoReviewSession(
  review: AutoReviewMetadata | undefined,
  navigate: ReturnType<typeof useRoute>["navigate"],
  renderer: ReturnType<typeof useRenderer>,
  evt?: MouseEvent,
) {
  // #209：无 sessionID 不可导航——无子会话的纯流式审查不产生可跳转目标
  if (!review?.sessionID) return false
  // #214：审查行可能位于可点击/可折叠工具卡片内——stop event 避免打开 reviewer 同时切换父 diff/输出卡片
  evt?.preventDefault()
  evt?.stopPropagation()
  // review 行不是 transcript 正文，并且内部 text 已关闭 selection。前序 TUI
  // 测试或真实用户留下的旧 selection 不能让这次明确点击只消费事件不导航。
  renderer.clearSelection()
  // #551：navigate 携带 reviewID——SessionRoute 深链锚点（无此字段的 navigate 会清除旧锚点）。
  navigate({ type: "session", sessionID: review.sessionID, reviewID: review.reviewID })
  return true
}

// #551：resolve reviewID → 锚点消息 ID（纯函数，按 autoReviewMetadata 先例导出供测试）。
// 主路径：request 顶层 part metadata（permissionReviewerRequest+reviewID）命中的 user 消息，
// assistant.parentID 指向该 request；优先定位返回区，多匹配取最后可见 request。
// 次选：tool part state.metadata.reviewID 命中的 assistant（decision 所在消息）。
// hidden 消息/part 已从 store 删除——"取最后可见匹配"天然成立。
export function resolveReviewAnchorMessageID(
  messages: Array<{ id: string; role: string; parentID?: string }>,
  // SDK Part 的 metadata/state 是具名 schema union（tool state 仅部分分支带 metadata）——
  // 签名用 unknown[] 承载，读取点经 metaOf 局部收窄，避免 any 且不复制 SDK 类型。
  partsOf: (messageID: string) => ReadonlyArray<unknown>,
  reviewID: string,
): string | undefined {
  const metaOf = (part: unknown) => {
    const p = part as { type?: unknown; metadata?: unknown; state?: { metadata?: unknown } } | undefined
    return {
      type: p?.type,
      request: p?.metadata as { permissionReviewerRequest?: unknown; reviewID?: unknown } | undefined,
      tool: p?.state?.metadata as { reviewID?: unknown } | undefined,
    }
  }
  // #551：request（text part + 顶层 metadata）与 decision（tool part 的 state.metadata）单趟同扫；
  // 多匹配取最后——协议重试 hide 后可见的是最终 request 轮。
  let requestID: string | undefined
  let decisionMessageID: string | undefined
  for (const m of messages) {
    for (const part of partsOf(m.id)) {
      const meta = metaOf(part)
      if (meta.type === "text" && meta.request?.permissionReviewerRequest === true && meta.request?.reviewID === reviewID) {
        requestID = m.id
      }
      if (meta.type === "tool" && meta.tool?.reviewID === reviewID) {
        decisionMessageID = m.id
      }
    }
  }
  if (requestID) {
    // #551：生产链方向是 reviewer assistant 壳挂 request 下（assistant.parentID === requestID），
    // request 自身不写 parentID；reviewing 尚无决策时退到 request 本身，深链不得贴底。
    const answer = [...messages].reverse().find((message) => message.role === "assistant" && message.parentID === requestID)
    return answer?.id ?? requestID
  }
  // 次选：仅有 decision tool 元数据时的残缺 transcript。
  return decisionMessageID
}

function openAutoReviewFromToolChrome(
  review: AutoReviewMetadata | undefined,
  navigate: ReturnType<typeof useRoute>["navigate"],
  renderer: ReturnType<typeof useRenderer>,
  evt: MouseEvent | undefined,
) {
  // 标题换行和 padding 会移动审查行，按稳定 id 查找，避免误中正文。
  if (!review?.sessionID || !evt?.target) return false
  const match = autoReviewLineTarget(review, evt.target)
  // OpenTUI 已把终端坐标转成零基；screenY 与鼠标 y 可直接比较。
  if (!match || evt.y !== match.row.screenY) return false
  return openAutoReviewSession(review, navigate, renderer, evt)
}

// #214：ToolAutoReviewLine——从 context 读取 autoReview 并渲染共享审查状态行
function ToolAutoReviewLine() {
  const review = useContext(ToolAutoReview)
  return <Show when={review()}>{(item) => <AutoReviewLine review={item()} />}</Show>
}

// #209：PermissionReviewDecision——reviewer 决策 tool cell，展示 outcome/risk/auth/rationale
function PermissionReviewDecision(props: ToolProps) {
  const { theme } = useTheme()
  // #209：合并 input 与 metadata——tool-call 事件把 assessment 同时写入 input 和 metadata，合并确保字段完整
  const decision = createMemo(() => ({ ...props.input, ...props.metadata }) as Record<string, unknown>)
  const outcome = createMemo(() => (decision().outcome === "allow" ? "allowed" : "denied"))
  const risk = createMemo(() => String(decision().risk_level ?? "unknown"))
  const auth = createMemo(() => String(decision().user_authorization ?? "unknown"))
  const rationale = createMemo(() => {
    const value = decision().rationale
    return typeof value === "string" ? value : ""
  })
  return (
    <BlockTool title={`Permission review decision`} part={props.part}>
      <box flexDirection="column" gap={1}>
        {/* #209：结构化决策证据——assistant text 可能辩论替代方案，此 metadata 是审计的最终 reviewer 输出 */}
        <box gap={1}>
          <text fg={theme.textMuted}>outcome</text>
          <text fg={theme.text}>{outcome()}</text>
        </box>
        <box gap={1}>
          <text fg={theme.textMuted}>risk</text>
          <text fg={theme.text}>{risk()}</text>
        </box>
        <box gap={1}>
          <text fg={theme.textMuted}>auth</text>
          <text fg={theme.text}>{auth()}</text>
        </box>
        <Show when={rationale()}>
          <box flexDirection="column">
            <text fg={theme.textMuted}>rationale</text>
            <text fg={theme.text}>{rationale()}</text>
          </box>
        </Show>
      </box>
    </BlockTool>
  )
}

export function createPendingToolInputStats(part: () => ToolPart) {
  const [stats, setStats] = createSignal<PendingToolInputStats>()
  let parser = createPendingToolInputParser(part().tool)
  let key = ""
  let consumed = 0
  let timer: Timer | undefined
  function flush() {
    timer = undefined
    // #187：只在 tick 边界读 stats，避免每个 delta 触发渲染
    setStats(parser.stats())
  }
  createEffect(() => {
    const current = part()
    const raw = current.state.status === "pending" ? current.state.raw : ""
    const nextKey = `${current.id}:${current.tool}`
    if (nextKey !== key || raw.length < consumed) {
      // #187：换 part/tool 或 raw 回退时重置解析器
      if (timer) clearTimeout(timer)
      timer = undefined
      parser = createPendingToolInputParser(current.tool)
      key = nextKey
      consumed = 0
      setStats(undefined)
    }
    const delta = raw.slice(consumed)
    consumed = raw.length
    if (!delta) return
    // #187：只 push 增量，不重放全文
    parser.push(delta)
    if (!timer) timer = setTimeout(flush, PENDING_TOOL_INPUT_PROGRESS_INTERVAL)
  })
  onCleanup(() => {
    if (timer) clearTimeout(timer)
  })
  return stats
}

function PendingStats(props: { stats: PendingToolInputStats | undefined }) {
  const { theme } = useTheme()
  return (
    <>
      {/* #189：先 + 后 -，与 diff 习惯及测试期望 +N -M 一致 */}
      <Show when={props.stats?.added}>
        <span style={{ fg: theme.diffAdded }}> +{props.stats!.added}</span>
      </Show>
      <Show when={props.stats?.removed}>
        <span style={{ fg: theme.diffRemoved }}> -{props.stats!.removed}</span>
      </Show>
    </>
  )
}

// #187：有路径则相对化，空路径留给 Preparing 占位
function pendingPath(pathFormatter: ReturnType<typeof usePathFormatter>, filePath?: string) {
  if (!filePath) return undefined
  return pathFormatter.format(filePath)
}

function InlineTool(props: {
  icon: string
  iconColor?: RGBA
  color?: RGBA
  complete: unknown
  // #187：pending 支持字符串或流式统计 JSX
  pending: JSX.Element
  failure?: string
  spinner?: boolean
  separate?: boolean
  children: JSX.Element
  part: ToolPart
  onClick?: () => void
  // #214：autoReview=false 时跳过共享审查状态行——shell inline 等布局需要 bespoke 位置
  autoReview?: false
}) {
  const { theme } = useTheme()
  const ctx = use()
  const sync = useSync()
  const renderer = useRenderer()
  const { navigate } = useRoute()
  const review = useContext(ToolAutoReview)
  const [hover, setHover] = createSignal(false)
  const [errorExpanded, setErrorExpanded] = createSignal(false)

  const permission = createMemo(() => {
    const callID = sync.data.permission[ctx.sessionID]?.at(0)?.tool?.callID
    if (!callID) return false
    return callID === props.part.callID
  })

  const error = createMemo(() => (props.part.state.status === "error" ? props.part.state.error : undefined))

  const denied = createMemo(
    () =>
      error()?.includes("QuestionRejectedError") ||
      error()?.includes("rejected permission") ||
      error()?.includes("specified a rule") ||
      error()?.includes("user dismissed"),
  )

  const failed = createMemo(() => Boolean(error() && !denied()))
  const clickable = createMemo(() => Boolean(props.onClick || failed()))
  const fg = createMemo(() => {
    if (props.color) return props.color
    if (permission()) return theme.warning
    if (failed()) return theme.error
    if (hover() && props.onClick) return theme.text
    if (props.complete) return theme.textMuted
    return theme.text
  })

  return (
    <InlineToolRow
      icon={props.icon}
      iconColor={props.iconColor}
      color={fg()}
      errorColor={theme.error}
      failed={failed()}
      denied={Boolean(denied())}
      error={error()}
      errorExpanded={errorExpanded()}
      complete={props.complete}
      pending={props.pending}
      failure={props.failure}
      spinner={props.spinner}
      separate={props.separate}
      onMouseOver={() => clickable() && setHover(true)}
      onMouseOut={() => setHover(false)}
      onMouseUp={(evt: MouseEvent) => {
        if (openAutoReviewFromToolChrome(review(), navigate, renderer, evt)) return
        if (renderer.getSelection()?.getSelectedText()) return
        if (failed()) {
          setErrorExpanded((value) => !value)
          return
        }
        props.onClick?.()
      }}
      review={
        <Show when={props.autoReview !== false}>
          <ToolAutoReviewLine />
        </Show>
      }
    >
      {props.children}
    </InlineToolRow>
  )
}

export function InlineToolRow(props: {
  icon: string
  iconColor?: RGBA
  color?: RGBA
  errorColor?: RGBA
  failed?: boolean
  denied?: boolean
  error?: string
  errorExpanded?: boolean
  complete: unknown
  // #187：与 InlineTool 同口径，允许 pending 统计片段
  pending: JSX.Element
  failure?: string
  spinner?: boolean
  separate?: boolean
  children: JSX.Element
  // 审查行含 box，必须独立于 text/Spinner 的正文 children。
  review?: JSX.Element
  onMouseOver?: () => void
  onMouseOut?: () => void
  onMouseUp?: (evt: MouseEvent) => void
}) {
  const topMargin = useContext(ToolPartTopMargin)
  return (
    <box
      paddingLeft={3}
      onMouseOver={props.onMouseOver}
      onMouseOut={props.onMouseOut}
      onMouseUp={props.onMouseUp}
      ref={(el: BoxRenderable) => {
        if (props.separate) alwaysSeparate.add(el)
        // 旧版多行分隔一旦成立就保留；在 Yoga 前改几何，避免 renderBefore 信号导致下一帧跳动。
        let margin = 0
        setPreLayoutSiblingMargin(el, (previous) => {
          if (props.separate || el.height > 1 ||
            (previous instanceof BoxRenderable && (previous.height > 1 || alwaysSeparate.has(previous)))) margin = 1
          // 首个可见工具必须覆盖自分隔；连续工具才采用各自真实行高和前驱行高。
          const explicit = topMargin()
          return explicit === undefined ? margin : explicit ? 1 : 0
        })
      }}
    >
      <Switch>
        <Match when={props.spinner}>
          <Spinner color={props.color} children={props.children} />
        </Match>
        <Match when={true}>
          <Show
            fallback={
              // #187：真实 pending 包含裸文本与有色 span，必须由 text 父节点承载。
              <text
                paddingLeft={3}
                fg={props.color}
                attributes={props.denied ? TextAttributes.STRIKETHROUGH : undefined}
              >
                ~ {props.pending}
              </text>
            }
            when={props.complete || props.failed}
          >
            <box flexDirection="row">
              <text
                width={INLINE_TOOL_ICON_WIDTH}
                fg={props.failed ? props.errorColor : (props.iconColor ?? props.color)}
                attributes={props.denied ? TextAttributes.STRIKETHROUGH : undefined}
              >
                {props.icon}
              </text>
              <text
                flexGrow={1}
                fg={props.failed ? props.errorColor : props.color}
                attributes={props.denied ? TextAttributes.STRIKETHROUGH : undefined}
              >
                {props.failed && !props.complete ? (props.failure ?? props.children) : props.children}
              </text>
            </box>
          </Show>
        </Match>
      </Switch>
      {props.review}
      <Show when={props.failed && props.errorExpanded}>
        <box paddingLeft={INLINE_TOOL_ICON_WIDTH}>
          <text fg={props.errorColor}>{props.error}</text>
        </box>
      </Show>
    </box>
  )
}

// 导出供 block-tool-collapse 回归测试直接挂载：测试是唯一新增消费点，不改变运行时语义。
export function BlockTool(props: {
  title?: string
  children: JSX.Element
  onClick?: () => void
  // 右键是独立动作，不能复用左键折叠导致完成态无法切换模型视图。
  onRightClick?: () => void
  part?: ToolPart
  spinner?: boolean
  contextView?: boolean
  contextLabel?: string
  // #144：可选预览节点；折叠时优先于 maxHeight 裁切 children
  preview?: JSX.Element
  // 只接收展示文字，展开状态仍归调用方；公共 section 统一承担旧版提示前的一行留白。
  footer?: string
  // #214：autoReview=false 时跳过共享审查状态行——apply_patch 内部 BlockTool 由外部统一渲染
  autoReview?: false
}) {
  const { theme } = useTheme()
  const renderer = useRenderer()
  const { navigate } = useRoute()
  const review = useContext(ToolAutoReview)
  const topMargin = useContext(ToolPartTopMargin)
  const [hover, setHover] = createSignal(false)
  const error = createMemo(() => (props.part?.state.status === "error" ? props.part.state.error : undefined))
  // 上下文状态优先于 hover，鼠标移入不能抹掉当前视图的颜色提示。
  const background = createMemo(() => {
    if (props.contextView) return theme.diffContextBg
    if (hover()) return theme.backgroundMenu
    return theme.backgroundPanel
  })
  // 外层拥有展开状态；保存预览节点，使它暂时缺席时不会销毁后再挂载。
  // getter会创建renderable；存在性、挂载和提示必须复用同一次求值，不能留下弃用树。
  const previewTree = createMemo(() => props.preview)
  const collapsed = createMemo(() => previewTree() !== undefined)
  const preview = createMemo<JSX.Element>((previous) => previewTree() ?? previous)
  // 展开仍归调用方；折叠销毁正文owner，重开通过children getter创建新树，不重挂已销毁对象。
  return (
    <box
      ref={(el: BoxRenderable) => alwaysSeparate.add(el)}
      border={["left"]}
      paddingTop={1}
      paddingBottom={1}
      paddingLeft={2}
      // Part 级首距同时适用于多文件 Patch，不能擅自改成逐卡片分组。
      marginTop={topMargin() === false ? 0 : 1}
      // #109：去掉 gap，改由子块 marginTop 承担间距
      backgroundColor={background()}
      customBorderChars={SplitBorder.customBorderChars}
      borderColor={props.contextView ? theme.info : theme.background}
      onMouseOver={() => (props.onClick || props.onRightClick) && setHover(true)}
      onMouseOut={() => setHover(false)}
      onMouseUp={(evt?: MouseEvent) => {
        if (openAutoReviewFromToolChrome(review(), navigate, renderer, evt)) return
        // 文本选择优先于视图动作，右键不会在复制日志时意外切换内容。
        if (renderer.getSelection()?.getSelectedText()) return
        if (evt?.button === MouseButton.RIGHT) {
          if (!props.onRightClick) return
          evt.preventDefault()
          evt.stopPropagation()
          props.onRightClick()
          return
        }
        props.onClick?.()
      }}
    >
      <Show when={props.title}>
        {(title) => (
          <Show
            when={props.spinner}
            fallback={
              <text paddingLeft={3} fg={theme.textMuted}>
                {title()}
                <Show when={props.contextView && props.contextLabel}> · {props.contextLabel}</Show>
              </text>
            }
          >
            <Spinner color={theme.textMuted}>{title().replace(/^# /, "")}</Spinner>
          </Show>
        )}
      </Show>
      {/* #214：共享审查状态行——autoReview !== false 时从 context 渲染，位于标题与内容之间 */}
      <Show when={props.autoReview !== false}>
        <ToolAutoReviewLine />
      </Show>
      {/* visible隐藏整块但不销毁节点，避免零高度仍泄漏首行；状态继续由外层驱动。 */}
      <box marginTop={collapsed() ? 1 : 0} visible={collapsed()}>
        {preview()}
      </box>
      <Show when={!collapsed()}>
        <box marginTop={1}>
          {props.children}
        </box>
      </Show>
      {/* 提示独立于可销毁的正文；收放正文不重建另一套按钮或改变调用方的展开状态。 */}
      <Show when={collapsed() ? "Click to expand" : props.footer}>
        {(label) => <box marginTop={1}><text fg={theme.textMuted}>{label()}</text></box>}
      </Show>
      <Show when={error()}>
        <box marginTop={1}>
        <text fg={theme.error}>{error()}</text>
      </box>
      </Show>
    </box>
  )
}

function Shell(props: ToolProps) {
  const { theme } = useTheme()
  const pathFormatter = usePathFormatter()
  const ctx = use()
  const isRunning = createMemo(() => props.part.state.status === "running")
  // 模型输出视图和展开选择跨正文重建保留，折叠/右键仍由Shell唯一owner处理。
  const [showContextOutput, setShowContextOutput] = useInteraction(() => `context:${props.part.id}`)
  // 只有 completed 的 props.output 才是已返回模型的内容，不能显示运行中的半成品。
  const contextOutputAvailable = createMemo(() => props.output !== undefined && props.part.state.status === "completed")
  const output = createMemo(() => {
    const text = showContextOutput() && contextOutputAvailable() ? props.output : stringValue(props.metadata.output)
    return stripAnsi(text?.trim() ?? "")
  })
  const [expanded, setExpanded] = useInteraction(() => `expanded:${props.part.id}`)
  // 命令和非空输出共用同一文本；空输出不添加分隔行，长命令不能绕过折叠。
  const shellPreviewText = createMemo(() => {
    if (!output()) return `$ ${stringValue(props.input.command) ?? ""}`
    return [`$ ${stringValue(props.input.command) ?? ""}`, "", output()].join("\n")
  })
  const maxLines = 10
  const maxChars = createMemo(() => maxLines * Math.max(20, ctx.width - 6))
  const collapsed = createMemo(() => {
    if (isRunning() || showContextOutput()) return { output: shellPreviewText(), overflow: false }
    return collapseToolOutput(shellPreviewText(), 20, Math.min(maxChars() * 2, DEFAULT_BLOCK_CHAR_THRESHOLD))
  })
  // #111：外置 collapseToolOutput 主路径 sticky（Shell 唯一折叠 owner）
  const [shellCanCollapse, setShellCanCollapse] = createSignal(false)
  createEffect(() => {
    if (shellCanCollapse()) return
    if (collapsed().overflow) setShellCanCollapse(true)
  })
  const limited = createMemo(() => {
    if (isRunning() || showContextOutput() || expanded() || !shellCanCollapse()) return shellPreviewText()
    return previewText(shellPreviewText(), maxLines, maxChars())
  })

  const workdirDisplay = createMemo(() => {
    const workdir = stringValue(props.input.workdir)
    if (!workdir || workdir === ".") return undefined
    // 显式选择项目根目录仍有展示意义；只沿用旧版对缺省值和字面点的省略。
    return pathFormatter.format(workdir)
  })

  const title = createMemo(() => {
    // 历史输入可能没有可选说明；标题直接消费已保存的 input，不复制到流式 metadata。
    const desc = stringValue(props.input.description) ?? "Shell"
    const wd = workdirDisplay()
    if (!wd || desc.includes(wd)) return `# ${desc}`
    return `# ${desc} in ${wd}`
  })

  // 上下文视图完整展示，右键切换不改变普通输出的展开状态。
  const toggleContextOutput = () => {
    if (!contextOutputAvailable()) return
    setShowContextOutput((prev) => !prev)
  }

  return (
    <Switch>
      <Match when={stringValue(props.metadata.output) !== undefined}>
        <BlockTool
          title={title()}
          spinner={isRunning()}
          part={props.part}
          // 运行态和模型上下文均展示完整输出，沿用旧版不显示折叠入口的语义。
          footer={shellCanCollapse() && !isRunning() && !showContextOutput() ? "Click to collapse" : undefined}
          onClick={shellCanCollapse() ? () => setExpanded((prev) => !prev) : undefined}
          onRightClick={contextOutputAvailable() ? toggleContextOutput : undefined}
          contextView={showContextOutput()}
          contextLabel="returned to model"
          // 折叠判定和可见预览共用命令/输出预算，运行及模型上下文视图仍完整展示。
          preview={
            shellCanCollapse() && !expanded() && !isRunning() && !showContextOutput() ? (
              <text fg={theme.text}>{limited()}</text>
            ) : undefined
          }
        >
          <box gap={1}>
            {/* 运行态动效归意图标题，命令正文保持静态，便于定位和复制原始调用。 */}
            <text fg={theme.text}>$ {stringValue(props.input.command)}</text>
            <Show when={output()}>
              <text fg={theme.text}>{output()}</text>
            </Show>
          </box>
        </BlockTool>
      </Match>
      <Match when={true}>
        <InlineTool icon="$" pending="Writing command…" complete={stringValue(props.input.command)} part={props.part}>
          {stringValue(props.input.command)}
        </InlineTool>
      </Match>
    </Switch>
  )
}

// #154：展开态统一走 DiffView（集中 theme/filetype/syntax props），
// 折叠态走 DiffPreview：独立挂载裁剪后的短 diff，maxHeight 只作用于预览，
// 避免旧 maxHeight 内联裁剪把滚轮事件灌进全量 diff、重开时带着 stale offset
function DiffView(props: { diff: string; filePath?: string; view: "split" | "unified"; syncScroll?: boolean }) {
  const ctx = use()
  const { theme, syntax } = useTheme()

  return (
    <box paddingLeft={1}>
      <diff
        diff={props.diff}
        view={props.view}
        syncScroll={props.syncScroll ?? true}
        filetype={filetype(props.filePath)}
        syntaxStyle={syntax()}
        showLineNumbers={true}
        width="100%"
        wrapMode={ctx.diffWrapMode()}
        fg={theme.text}
        addedBg={theme.diffAddedBg}
        removedBg={theme.diffRemovedBg}
        contextBg={theme.diffContextBg}
        addedSignColor={theme.diffHighlightAdded}
        removedSignColor={theme.diffHighlightRemoved}
        lineNumberFg={theme.diffLineNumber}
        lineNumberBg={theme.diffContextBg}
        addedLineNumberBg={theme.diffAddedLineNumberBg}
        removedLineNumberBg={theme.diffRemovedLineNumberBg}
      />
    </box>
  )
}

function DiffPreview(props: { diff: string; filePath?: string; view: "split" | "unified"; maxLines: number }) {
  // 预览与展开是两个独立 Renderable：syncScroll=false 防止预览回写主滚动位置
  return (
    <box maxHeight={props.maxLines} overflow="hidden">
      <DiffView diff={props.diff} filePath={props.filePath} view={props.view} syncScroll={false} />
    </box>
  )
}

function Write(props: ToolProps) {
  const { theme, syntax } = useTheme()
  const pathFormatter = usePathFormatter()
  const ctx = use()
  // 两代输入采用不同字段名，展示使用实际调用路径，不改写模型输入。
  const filepath = createMemo(() => stringValue(props.input.filePath) ?? stringValue(props.input.path))
  // #187：流式 raw → 路径/+行 统计
  const writePendingStats = createPendingToolInputStats(() => props.part)
  // #187：无路径且无 added 时回落 Preparing write...
  const writePending = createMemo(() => {
    const stats = writePendingStats()
    const filePath = pendingPath(pathFormatter, stats?.filePath)
    if (!filePath && !stats?.added) return "Preparing write…"
    return (
      <>
        Write
        <Show when={filePath}> {filePath}</Show>
        <PendingStats stats={stats} />
      </>
    )
  })
  // 文件预览默认收缩；展开信号只控制显示，不改写工具输入或诊断。
  const [expanded, setExpanded] = useInteraction(() => `expanded:${props.part.id}`)
  const code = createMemo(() => {
    return stringValue(props.input.content) ?? ""
  })
  const maxLines = 10
  // 完整展示阈值为 20 行，折叠预览为 10 行；两者都保留字符预算。
  const maxChars = createMemo(() => maxLines * Math.max(20, ctx.width - 6))
  const collapsed = createMemo(() => collapseToolOutput(code(), 20, Math.min(maxChars() * 2, DEFAULT_BLOCK_CHAR_THRESHOLD)))
  // #111：Write 外置折叠 sticky（唯一折叠 owner；勿传 totalLines 给 BlockTool）
  const [writeCanCollapse, setWriteCanCollapse] = createSignal(false)
  createEffect(() => {
    if (writeCanCollapse()) return
    if (collapsed().overflow) setWriteCanCollapse(true)
  })
  const limited = createMemo(() => {
    if (expanded() || !writeCanCollapse()) return code()
    return previewText(code(), maxLines, maxChars())
  })
  // 文件覆写 diff：当 write 工具覆写已有文件时，metadata.diff 包含 git diff 格式的变更
  const diff = createMemo(() => props.metadata.diff as string | undefined)
  // 覆写判断：文件已存在且 diff 非空时显示 diff 视图
  const isOverwrite = createMemo(() => (props.metadata.exists === true || props.metadata.existed === true) && !!diff())
  // diff 样式：跟随用户配置的 diff_style，stacked 模式下使用 unified 视图
  // diff 视图模式：stacked 模式强制 unified，auto 模式按终端宽度选择 split/unified
  const diffView = createMemo(() => {
    const diffStyle = ctx.tui.diff_style
    if (diffStyle === "stacked") return "unified"
    return ctx.width > 120 ? "split" : "unified"
  })
  // diff 统计：计算添加/删除行数，超过 20 行时显示展开/收缩
  const diffStats = createMemo(() => {
    const d = diff()
    if (!d) return { added: 0, removed: 0, total: 0 }
    // 0086 source 语义：+/- 计数用 startsWith（内容首字符为 +/- 的行也计入），
    // total=diff 全部行数——大上下文覆写 diff 以 ctx 行为主，不得永久折叠
    const lines = d.split("\n")
    const added = lines.filter((line) => line.startsWith("+") && !line.startsWith("+++")).length
    const removed = lines.filter((line) => line.startsWith("-") && !line.startsWith("---")).length
    return { added, removed, total: lines.length }
  })
  // 字符超限只决定是否折叠，预览仍保留合法 hunk，展开正文不截断。
  const diffOverflow = createMemo(() => diffStats().total > 20 || (diff() ?? "").length > DEFAULT_BLOCK_CHAR_THRESHOLD)

  return (
    <Switch>
      <Match when={isOverwrite()}>
        <BlockTool
          // #144：Write diff 折叠预览
          // 短 diff 独立挂载，折叠滚动不污染展开后的完整 diff。
          preview={diffOverflow() && !expanded() ? <DiffPreview diff={previewDiff(diff() ?? "", 10)} filePath={filepath()} view={diffView()} maxLines={10} /> : undefined}
          title={"← Write " + pathFormatter.format(filepath()) + (diffStats().added > 0 || diffStats().removed > 0 ? ` (+${diffStats().added}/-${diffStats().removed})` : "")}
          part={props.part}
          onClick={diffOverflow() ? () => setExpanded((prev) => !prev) : undefined}
          footer={diffOverflow() ? "Click to collapse" : undefined}
        >
          <DiffView diff={diff()!} filePath={filepath()} view={diffView()} />
        </BlockTool>
      </Match>
      {/* V1 成功结果已有 filepath；卡片就绪取文件结果，V2 仍沿用 operation。 */}
      <Match when={props.metadata.filepath !== undefined || props.metadata.operation === "write"}>
        <BlockTool
          title={"# Wrote " + pathFormatter.format(filepath())}
          part={props.part}
          onClick={writeCanCollapse() ? () => setExpanded((prev) => !prev) : undefined}
          footer={writeCanCollapse() ? "Click to collapse" : undefined}
          // #144：Write 内容折叠预览
          preview={writeCanCollapse() && !expanded() ? <text fg={theme.text}>{previewText(limited(), 10, maxChars())}</text> : undefined}
        >
          <line_number fg={theme.textMuted} minWidth={3} paddingRight={1}>
            <code
              conceal={false}
              fg={theme.text}
              filetype={filetype(filepath())}
              syntaxStyle={syntax()}
              content={limited()}
            />
          </line_number>
        </BlockTool>
      </Match>
      <Match when={true}>
        <InlineTool icon="←" pending={writePending()} complete={filepath()} part={props.part}>
          Write {pathFormatter.format(filepath())}
        </InlineTool>
      </Match>
    </Switch>
  )
}

function Glob(props: ToolProps) {
  const pathFormatter = usePathFormatter()
  return (
    <InlineTool icon="✱" pending="Finding files…" complete={stringValue(props.input.pattern)} part={props.part}>
      Glob "{stringValue(props.input.pattern)}"{" "}
      <Show when={stringValue(props.input.path)}>in {pathFormatter.format(stringValue(props.input.path))} </Show>
      <Show when={numberValue(props.metadata.count)}>
        ({numberValue(props.metadata.count)} {numberValue(props.metadata.count) === 1 ? "match" : "matches"})
      </Show>
      {/* #244：partial 时补 (incomplete) 标记——=== true 与 grepResult 同口径，
          防第三方工具同名字段改变 Glob 行可见性 */}
      <Show when={props.metadata.partial === true}> (incomplete)</Show>
    </InlineTool>
  )
}

function Read(props: ToolProps) {
  const { theme } = useTheme()
  const pathFormatter = usePathFormatter()
  const isRunning = createMemo(() => props.part.state.status === "running")
  const loaded = createMemo(() => {
    if (props.part.state.status !== "completed") return []
    if (props.part.state.time.compacted) return []
    const value = props.metadata.loaded
    if (!value || !Array.isArray(value)) return []
    return value.filter((p): p is string => typeof p === "string")
  })
  return (
    <>
      <InlineTool
        icon="→"
        pending="Reading file…"
        complete={stringValue(props.input.filePath)}
        spinner={isRunning()}
        part={props.part}
      >
        Read {pathFormatter.format(stringValue(props.input.filePath))} {input(props.input, ["filePath"])}
      </InlineTool>
      <For each={loaded()}>
        {(filepath) => (
          <box paddingLeft={3}>
            <text paddingLeft={3} fg={theme.textMuted}>
              ↳ Loaded {pathFormatter.format(filepath)}
            </text>
          </box>
        )}
      </For>
    </>
  )
}

// #246：TUI 侧 grep 摘要与 run 模式同语义；目标 ToolProps 的 input/metadata
// 是 Record<string, unknown>，helper 用 typeof 收窄而非具体工具类型。
// helpers 与 Grep 组件同文件同居——这三个 helper 只服务 TUI inline 渲染，
// 抽到共享模块反而让 run/tui 两侧产生跨包依赖
function grepPatterns(value: unknown, exclude = false) {
  const items = typeof value === "string" ? [value] : Array.isArray(value) ? value.filter((item) => typeof item === "string") : []
  // #246：数组形态来自 PatternList，脏项（非 string）静默剔除而非抛错，
  // 避免 V1 历史会话的残留 input 让 TUI 渲染整条消息失败
  // TUI 的 grep 行必须保持短促；不显示 include=/exclude= 字段名，
  // exclude 用 !glob 表达真实过滤语义，和 rg/glob 习惯保持一致。
  return items.filter(Boolean).map((item) => (exclude && !item.startsWith("!") ? `!${item}` : item))
}

function grepFilter(value: unknown, exclude = false) {
  const items = grepPatterns(value, exclude)
  if (items.length === 0) return ""
  // exclude 往往比 include 更长，显示第一个并压缩其余项，避免 inline 行横向溢出；
  // include 最多显示两个常见扩展名，保留足够上下文但不降级成参数 dump。
  const shown = items.slice(0, exclude ? 1 : 2)
  const hidden = items.length - shown.length
  return hidden > 0 ? `${shown.join(",")} +${hidden}` : shown.join(",")
}

// #246：numberValue 收窄后的 matches 才参与单复数与截断判断；
// 字段缺失或类型不符时退化为空串/超时提示，不渲染误导性数字。
function grepResult(metadata: { matches?: unknown; truncated?: unknown; timedOut?: unknown; partial?: unknown }) {
  const matches = typeof metadata.matches === "number" ? metadata.matches : undefined
  const timedOut = metadata.timedOut === true
  // #246：TUI 与 run 模式的超时/截断组合语义保持一致——
  // metadata 缺 matches 字段时只显示 timed out，绝不渲染 undefined 字符串
  // #244：partial 与 timeout/truncated 独立组合，不能用一个状态覆盖另一个完整性提示
  const incomplete = metadata.partial === true
  if (matches === undefined) return [timedOut && "timed out", incomplete && "incomplete"].filter(Boolean).join(", ")
  if (matches === 0 && timedOut) return incomplete ? "timed out, incomplete" : "timed out"
  const label = `${matches}${metadata.truncated === true ? "+" : ""} ${matches === 1 && metadata.truncated !== true ? "match" : "matches"}`
  return [label, timedOut && "timed out", incomplete && "incomplete"].filter(Boolean).join(", ")
}

function Grep(props: ToolProps) {
  const pathFormatter = usePathFormatter()
  // #246：filters/result 各自 memo 化，输入段与结果段独立响应 metadata 回填
  // #246：filters 段在 start 阶段即可渲染（仅依赖 input），
  // result 段等待 metadata 回填——两个 memo 分离避免回显闪断
  const filters = createMemo(() => [grepFilter(props.input.include), grepFilter(props.input.exclude, true)].filter(Boolean).join(" · "))
  const result = createMemo(() => grepResult(props.metadata))
  return (
    <InlineTool icon="✱" pending="Searching content…" complete={stringValue(props.input.pattern)} part={props.part}>
      Grep "{stringValue(props.input.pattern)}"{" "}
      <Show when={stringValue(props.input.path)}>in {pathFormatter.format(stringValue(props.input.path))} </Show>
      <Show when={filters()}>· {filters()} </Show>
      <Show when={result()}>({result()})</Show>
    </InlineTool>
  )
}

function WebFetch(props: ToolProps) {
  return (
    <InlineTool icon="%" pending="Fetching from the web…" complete={stringValue(props.input.url)} part={props.part}>
      WebFetch {stringValue(props.input.url)}
    </InlineTool>
  )
}

function WebSearch(props: ToolProps) {
  return (
    <InlineTool icon="◈" pending="Searching web…" complete={stringValue(props.input.query)} part={props.part}>
      {webSearchProviderLabel(props.metadata.provider)} "{stringValue(props.input.query)}"{" "}
      <Show when={numberValue(props.metadata.numResults)}>({numberValue(props.metadata.numResults)} results)</Show>
    </InlineTool>
  )
}

function Task(props: ToolProps) {
  const { theme } = useTheme()
  const { navigate } = useRoute()
  const sync = useSync()
  const dialog = useDialog()

  // [0625] 可见 Task 卡片持有子会话正文使用权；卡片销毁即释放，正文不再长期驻留。
  // 子 Session ID 在工具执行后才写入 metadata（pending 阶段不存在），acquisition 必须
  // 跟随 metadata 响应式出现而不是只在 mount 取样一次；ID 变化先释放旧消费者。
  // 同步触发交给 acquireParts 内部的 fullSynced 去重，与 message[].length 无关。
  createEffect(() => {
    const child = stringValue(props.metadata.sessionId)
    if (!child) return
    let release: (() => void) | undefined
    let released = false
    void sync.session
      .acquireParts(child)
      .then((handle) => {
        if (released) {
          handle.release()
          return
        }
        release = handle.release
      })
      .catch(() => {
        // [0625] 子 Session 删除竞态或守护进程失败：计数已在 acquireParts 内回滚，
        // 卡片没有正文可展示时保持现状，不重试不合成。
      })
    onCleanup(() => {
      released = true
      release?.()
    })
  })

  const sessionID = createMemo(() => stringValue(props.metadata.sessionId))
  const messages = createMemo(() => sync.data.message[sessionID() ?? ""] ?? [])

  const tools = createMemo(() => {
    return messages().flatMap((msg) =>
      (sync.data.part[msg.id] ?? [])
        .filter((part): part is ToolPart => part.type === "tool")
        .map((part) => ({ tool: part.tool, state: part.state })),
    )
  })

  const current = createMemo(() =>
    tools().findLast((x) => (x.state.status === "running" || x.state.status === "completed") && x.state.title),
  )

  const status = createMemo(() => sync.data.session_status[sessionID() ?? ""])
  const isRunning = createMemo(() => {
    const value = status()
    return (
      props.part.state.status === "running" ||
      (props.metadata.background === true && value !== undefined && value.type !== "idle")
    )
  })
  const retry = createMemo(() => {
    const value = status()
    if (value?.type !== "retry") return
    return value
  })

  const duration = createMemo(() => {
    const first = messages().find((x) => x.role === "user")?.time.created
    const assistant = messages().findLast((x) => x.role === "assistant")?.time.completed
    if (!first || !assistant) return 0
    return assistant - first
  })

  const content = createMemo(() => {
    const description = stringValue(props.input.description)
    if (!description) return ""
    let content = [
      formatSubagentTitle(
        Locale.titlecase(stringValue(props.input.subagent_type) ?? "General"),
        description,
        props.metadata.background === true,
      ),
    ]

    const retrying = retry()
    if (isRunning() && retrying) {
      content.push(`↳ ${formatSubagentRetry(retrying.attempt, Locale.truncate(retrying.message, 80))}`)
    } else if (isRunning() && tools().length > 0) {
      if (current()) {
        const state = current()!.state
        const title = state.status === "running" || state.status === "completed" ? state.title : undefined
        content.push(`↳ ${Locale.titlecase(current()!.tool)} ${title}`)
      } else content.push(`↳ ${formatSubagentToolcalls(tools().length)}`)
    }

    if (!isRunning() && props.part.state.status === "completed") {
      content.push(`↳ ${formatCompletedSubagentDetail(tools().length, Locale.duration(duration()))}`)
    }

    return content.join("\n")
  })

  return (
    <InlineTool
      icon={props.part.state.status === "completed" ? "✓" : "│"}
      color={retry() ? theme.error : undefined}
      spinner={isRunning()}
      complete={stringValue(props.input.description)}
      pending="Delegating…"
      part={props.part}
      onClick={() => {
        if (sessionID()) {
          // #213：Task metadata 在子会话创建时即写入，但其消息可能尚未到达
          // #213：先前的 prefetch 可能标记子会话为已同步而实际为空；显式导航时强制刷新
          // #213：点击 task 始终打开实时 agent 视图，而非可能为空的缓存快照
          void sync.session.sync(sessionID()!, { force: true })
          navigate({ type: "session", sessionID: sessionID()! })
        }
        const status = retry()
        if (status) void DialogAlert.show(dialog, "Retry Error", status.message)
      }}
    >
      {content()}
    </InlineTool>
  )
}

export function formatSubagentToolcalls(count: number) {
  return `${count} toolcall${count === 1 ? "" : "s"}`
}

export function formatSubagentTitle(agent: string, description: string, background: boolean) {
  return `${agent} Task${background ? " (background)" : ""} — ${description}`
}

export function formatSubagentRetry(attempt: number, message: string) {
  return `Retrying (attempt ${attempt}) · ${message}`
}

export function formatCompletedSubagentDetail(toolcalls: number, duration: string) {
  if (toolcalls === 0) return duration
  return `${formatSubagentToolcalls(toolcalls)} · ${duration}`
}

type ExecuteCall = { tool: string; status: "running" | "completed" | "error"; input?: Record<string, unknown> }

function executeCalls(value: unknown): ExecuteCall[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((call) => {
    const item = recordValue(call)
    const tool = stringValue(item?.tool)
    const status = stringValue(item?.status)
    if (!tool || !status || !["running", "completed", "error"].includes(status)) return []
    return [{ tool, status: status as ExecuteCall["status"], input: recordValue(item?.input) }]
  })
}

// The `execute` tool streams child tool calls through metadata, not a child session like Task.
function Execute(props: ToolProps) {
  const ctx = use()
  const { theme } = useTheme()
  const isLoading = createMemo(() => props.part.state.status === "pending" || props.part.state.status === "running")
  const calls = createMemo(() => executeCalls(props.metadata.toolCalls))
  const output = createMemo(() => stripAnsi(props.output?.trim() ?? ""))
  const hasRuntimeError = createMemo(() => props.metadata.error === true)
  const outputPreview = createMemo(() => collapseToolOutput(output(), 4, 4 * Math.max(20, ctx.width - 6)).output)
  const showOutput = createMemo(() => output() && hasRuntimeError())
  const content = createMemo(() => {
    const lines = ["execute"]
    for (const call of calls()) {
      const args = input(call.input ?? {})
      lines.push(`↳ ${call.tool}${args ? ` ${args}` : ""}${call.status === "error" ? " (failed)" : ""}`)
    }
    return lines.join("\n")
  })

  return (
    <>
      <InlineTool
        icon={hasRuntimeError() ? "✗" : props.part.state.status === "completed" ? "✓" : "│"}
        color={hasRuntimeError() ? theme.error : undefined}
        spinner={isLoading()}
        pending="execute"
        complete={true}
        part={props.part}
      >
        {content()}
      </InlineTool>
      <Show when={showOutput()}>
        <box paddingLeft={3}>
          <For each={outputPreview().split("\n")}>
            {(line, index) => (
              <text paddingLeft={3} fg={theme.error}>
                {index() === 0 ? "↳ " : "  "}
                {line}
              </text>
            )}
          </For>
        </box>
      </Show>
    </>
  )
}

function Edit(props: ToolProps) {
  const ctx = use()
  const { theme, syntax } = useTheme()
  const pathFormatter = usePathFormatter()
  // #187：流式 raw → 路径/+- 行统计
  const editPendingStats = createPendingToolInputStats(() => props.part)
  // #187：无路径且无 +/- 时回落 Preparing edit...
  const editPending = createMemo(() => {
    const stats = editPendingStats()
    const filePath = pendingPath(pathFormatter, stats?.filePath)
    if (!filePath && !stats?.added && !stats?.removed) return "Preparing edit…"
    return (
      <>
        Edit
        <Show when={filePath}> {filePath}</Show>
        <PendingStats stats={stats} />
      </>
    )
  })
  // diff 内容展开/收缩：超过 20 行时默认收缩，避免长 diff 占满终端
  const [expanded, setExpanded] = useInteraction(() => `expanded:${props.part.id}`)

  const view = createMemo(() => {
    const diffStyle = ctx.tui.diff_style
    if (diffStyle === "stacked") return "unified"
    // Default to "auto" behavior
    return ctx.width > 120 ? "split" : "unified"
  })

  const diffContent = createMemo(() => stringValue(props.metadata.diff) ?? "")
  // 复用已有 parsePatch 路径，仅统计 hunk 内容；+++ 与 --- 开头的代码不是文件头。
  const stats = createMemo(() => {
    const changes = getRevertDiffFiles(diffContent()).reduce(
      (sum, file) => ({ added: sum.added + file.additions, removed: sum.removed + file.deletions }),
      { added: 0, removed: 0 },
    )
    // 收缩阈值仍按完整展示行数判断，不能用变更行数忽略上下文和文件头。
    return { ...changes, total: diffContent().split("\n").length }
  })
  // 20 行是展开阈值，10 行仅是长 diff 的预览高度；短 diff 不应被裁掉。
  // 与 Write 共享字符门槛，少量超长行也能进入现有 DiffPreview。
  const overflow = createMemo(() => stats().total > 20 || diffContent().length > DEFAULT_BLOCK_CHAR_THRESHOLD)

  return (
    <Switch>
      <Match when={stringValue(props.metadata.diff) !== undefined}>
        <BlockTool
          // #144：Edit diff 折叠预览
          // 与 Write 共用短 diff 的合法 hunk 重写，展开时仍显示完整内容。
          preview={overflow() && !expanded() ? <DiffPreview diff={previewDiff(diffContent(), 10)} filePath={stringValue(props.input.filePath)} view={view()} maxLines={10} /> : undefined}
          // 保留路径格式化与 unknown 解码，只给真实变更附加统计后缀。
          title={"← Edit " + pathFormatter.format(stringValue(props.input.filePath)) + (stats().added > 0 || stats().removed > 0 ? ` +${stats().added} -${stats().removed}` : "")}
          part={props.part}
          onClick={overflow() ? () => setExpanded((prev) => !prev) : undefined}  // 展开只改变本地预览状态，不重新执行编辑工具。
          footer={overflow() ? "Click to collapse" : undefined}
        >
          <DiffView diff={diffContent()} filePath={stringValue(props.input.filePath)} view={view()} />
        </BlockTool>
      </Match>
      <Match when={true}>
        <InlineTool icon="←" pending={editPending()} complete={stringValue(props.input.filePath)} part={props.part}>
          {/* #514：replaceAll 徽标读 edits[]——任一条目显式 replaceAll 即展示，兼容 legacy 顶层字段回放 */}
          Edit {pathFormatter.format(stringValue(props.input.filePath))}{" "}
          {input({
            replaceAll: Array.isArray(props.input.edits)
              ? props.input.edits.some((e) => e?.replaceAll === true)
              : props.input.replaceAll === true,
          })}
        </InlineTool>
      </Match>
    </Switch>
  )
}

function ApplyPatch(props: ToolProps) {
  const ctx = use()
  const { theme, syntax } = useTheme()
  const pathFormatter = usePathFormatter()
  // #187：流式 patchText → 文件数与 +/- 
  const patchPendingStats = createPendingToolInputStats(() => props.part)
  // #187：stats 空回落 Preparing patch...；多文件用 fileCount
  const patchPending = createMemo(() => {
    const stats = patchPendingStats()
    if (!stats) return "Preparing patch…"
    const filePath = pendingPath(pathFormatter, stats.filePath)
    return (
      <>
        Patch{" "}
        <Show when={filePath} fallback={`${stats.fileCount} file${stats.fileCount === 1 ? "" : "s"}`}>
          {filePath}
        </Show>
        <PendingStats stats={stats} />
      </>
    )
  })

  const files = createMemo(() => parseApplyPatchFiles(props.metadata.files))
  // #214：从 context 读取 autoReview——多文件 patch 共享一行审查状态
  const review = useContext(ToolAutoReview)

  const view = createMemo(() => {
    const diffStyle = ctx.tui.diff_style
    if (diffStyle === "stacked") return "unified"
    return ctx.width > 120 ? "split" : "unified"
  })

  // 文件动作标题保留上游 add/delete/move 语义，行统计不能覆盖路径或动作。
  function title(file: { type: string; relativePath: string; filePath: string; deletions: number; patch?: string }) {
    const baseTitle = (() => {
      if (file.type === "delete") return "# Deleted " + file.relativePath
      if (file.type === "add") return "# Created " + file.relativePath
      if (file.type === "move") return "# Moved " + pathFormatter.format(file.filePath) + " → " + file.relativePath
      return "← Patched " + file.relativePath
    })()

    // 删除带真实patch时沿同一hunk统计；legacy缺少patch才保留纯动作标题。
    if (!file.patch) return baseTitle

    // 与 Edit 共享按 hunk 解析的统计，包含多文件与 ++counter/--counter 内容。
    const stats = getRevertDiffFiles(file.patch).reduce(
      (sum, item) => ({ added: sum.added + item.additions, removed: sum.removed + item.deletions }),
      { added: 0, removed: 0 },
    )

    // 仅重命名或模式变更不显示 +0 -0，保持原动作标题可读。
    if (stats.added === 0 && stats.removed === 0) return baseTitle
    return `${baseTitle} +${stats.added} -${stats.removed}`
  }

  return (
    <Switch>
      <Match when={files().length > 0}>
        {/* #214：多文件 patch 审查状态行——位于文件块之上，整 patch 共享一行 */}
        {/* #214：每个内部 BlockTool 设 autoReview={false}——避免审查状态行在每文件块重复渲染 */}
        <box>
          <Show when={review()}>
            <box paddingLeft={3} marginTop={1}>
              <text paddingLeft={3} fg={theme.textMuted} wrapMode="none">
                % Patch {files().length} file{files().length === 1 ? "" : "s"}
              </text>
              <ToolAutoReviewLine />
            </box>
          </Show>
          <For each={files()}>
          {(file) => {
            // patch 内容展开/收缩：多文件 patch 超过 20 行时收缩，避免长 patch 占满终端
            // 同Part的各文件使用独立key，原文件级展开owner及删除diff展示保持不变。
            const [patchExpanded, setPatchExpanded] = useInteraction(() => `expanded:${props.part.id}:${file.filePath}`)
            const patchLines = createMemo(() => (file.patch || "").split("\n"))
            // 每文件沿用独立展开状态，字符门槛不改变 add/delete/move 语义。
            const patchOverflow = createMemo(() => patchLines().length > 20 || (file.patch ?? "").length > DEFAULT_BLOCK_CHAR_THRESHOLD)

            return (
            <BlockTool
              // 文件各自拥有展开状态；有patch的删除项也预览diff，legacy仍走删除摘要。
          // #214：autoReview=false——审查状态行由外层 box 统一渲染，避免每个文件块重复
          autoReview={false}
              preview={!!file.patch && patchOverflow() && !patchExpanded() ? <DiffPreview diff={previewDiff(file.patch || "", 10)} filePath={file.filePath} view={view()} maxLines={10} /> : undefined}
              title={title(file)}
              part={props.part}
              onClick={!!file.patch && patchOverflow() ? () => setPatchExpanded((prev) => !prev) : undefined}
              footer={file.patch && patchOverflow() ? "Click to collapse" : undefined}
            >
              <Show
                // 正文与折叠预览按相同patch就绪条件分流，避免删除diff只能看到预览。
                when={!!file.patch}
                fallback={
                  // 删除文件仍显示权威 deletions，缩进与普通 diff 的内容列一致。
                  <text fg={theme.diffRemoved} paddingLeft={1}>
                    -{file.deletions} line{file.deletions !== 1 ? "s" : ""}
                  </text>
                }
              >
                <DiffView diff={file.patch || ""} filePath={file.filePath} view={view()} />
              </Show>
            </BlockTool>
            )
          }}
        </For>
        </box>
      </Match>
      <Match when={true}>
        <InlineTool icon="%" pending={patchPending()} failure="Patch failed" complete={false} part={props.part}>
          Patch
        </InlineTool>
      </Match>
    </Switch>
  )
}

function TodoWrite(props: ToolProps) {
  const todos = createMemo(() => parseTodos(props.input.todos))
  return (
    <Switch>
      <Match when={parseTodos(props.metadata.todos).length}>
        <BlockTool title="# Todos" part={props.part}>
          <box>
            <For each={todos()}>{(todo) => <TodoItem status={todo.status} content={todo.content} />}</For>
          </box>
        </BlockTool>
      </Match>
      <Match when={true}>
        <InlineTool icon="⚙" pending="Updating todos…" failure="Todo update failed" complete={false} part={props.part}>
          Updating todos…
        </InlineTool>
      </Match>
    </Switch>
  )
}

function Question(props: ToolProps) {
  const { theme } = useTheme()
  const questions = createMemo(() => parseQuestions(props.input.questions))
  const answers = createMemo(() => parseQuestionAnswers(props.metadata.answers))
  const count = createMemo(() => questions().length)

  function format(answer?: ReadonlyArray<string>) {
    if (!answer?.length) return "(no answer)"
    return answer.join(", ")
  }

  return (
    <Switch>
      <Match when={answers()}>
        <BlockTool title="# Questions" part={props.part}>
          <box gap={1}>
            <For each={questions()}>
              {(q, i) => (
                <box flexDirection="column">
                  <text fg={theme.textMuted}>{q.question}</text>
                  <text fg={theme.text}>{format(answers()?.[i()])}</text>
                </box>
              )}
            </For>
          </box>
        </BlockTool>
      </Match>
      <Match when={true}>
        <InlineTool icon="→" pending="Asking questions…" complete={count()} part={props.part}>
          Asked {count()} question{count() !== 1 ? "s" : ""}
        </InlineTool>
      </Match>
    </Switch>
  )
}

function Skill(props: ToolProps) {
  return (
    <InlineTool icon="→" pending="Loading skill…" complete={stringValue(props.input.name)} part={props.part}>
      Skill "{stringValue(props.input.name)}"
    </InlineTool>
  )
}

function input(input: Record<string, unknown>, omit?: string[]): string {
  const primitives = Object.entries(input).filter(([key, value]) => {
    if (omit?.includes(key)) return false
    return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
  })
  if (primitives.length === 0) return ""
    // #224：多行 string 参数在标题中只显示行数/字符数摘要，不刷屏
  // #224：inputValue 对多行/超长值做截断，单行短值原样返回
  return `[${primitives.map(([key, value]) => `${key}=${inputValue(value as string | number | boolean)}`).join(", ")}]`
}

// #224：标题参数值截断——多行 string 显示 <N lines, M chars>，
// #224：单行超长 string 截断到 TOOL_INPUT_VALUE_MAX_LENGTH 并追加省略号
// #224：这只影响 generic/plugin tool 的标题，不影响 notebook block card 的完整展示
function inputValue(value: string | number | boolean) {
  if (typeof value !== "string") return String(value)
  const lines = value.split("\n")
  if (lines.length > 1) return `<${lines.length} lines, ${value.length} chars>`
  if (value.length <= TOOL_INPUT_VALUE_MAX_LENGTH) return value
  return value.slice(0, TOOL_INPUT_VALUE_MAX_LENGTH).trimEnd() + "..."
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : undefined
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

const toolDisplays = new Set([
  "bash",
  "glob",
  "read",
  "grep",
  "webfetch",
  "websearch",
  "write",
  "edit",
  "task",
  "apply_patch",
  "todowrite",
  "question",
  "skill",
  "execute",
  "permission_review_decision",
])

export function toolDisplay(tool: string) {
  return toolDisplays.has(tool) ? tool : "generic"
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return
  return value as Record<string, unknown>
}

export function parseApplyPatchFiles(value: unknown) {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    const file = recordValue(item)
    if (!file) return []
    const type = stringValue(file.type)
    const relativePath = stringValue(file.relativePath)
    const filePath = stringValue(file.filePath)
    const deletions = numberValue(file.deletions)
    // #248：仅 delete 允许 patch 缺失（legacy V1 删除条目仍可渲染 -N lines 摘要）；
    // 其余类型无 patch 无法渲染 diff，继续丢弃
    const patch = stringValue(file.patch)
    if (!type || !relativePath || !filePath || deletions === undefined) return []
    if (patch === undefined && type !== "delete") return []
    return [{ type, relativePath, filePath, patch: patch ?? "", deletions, movePath: stringValue(file.movePath) }]
  })
}

export function parseTodos(value: unknown) {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    const todo = recordValue(item)
    const status = stringValue(todo?.status)
    const content = stringValue(todo?.content)
    return status && content ? [{ status, content }] : []
  })
}

export function parseQuestions(value: unknown) {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    const question = stringValue(recordValue(item)?.question)
    return question ? [{ question }] : []
  })
}

export function parseQuestionAnswers(value: unknown) {
  if (!Array.isArray(value)) return
  return value.map((answer) =>
    Array.isArray(answer) ? answer.filter((item): item is string => typeof item === "string") : [],
  )
}
