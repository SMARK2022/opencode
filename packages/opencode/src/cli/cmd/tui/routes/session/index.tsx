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
import { Dynamic } from "solid-js/web"
import path from "path"
import { useRoute, useRouteData } from "@tui/context/route"
import { useProject } from "@tui/context/project"
import { useSync } from "@tui/context/sync"
import { useEvent } from "@tui/context/event"
import { SplitBorder } from "@tui/component/border"
import { Spinner } from "@tui/component/spinner"
import { selectedForeground, useTheme } from "@tui/context/theme"
import {
  BoxRenderable,
  ScrollBoxRenderable,
  addDefaultParsers,
  TextAttributes,
  RGBA,
  MouseButton,
  TextBuffer,
  TextBufferView,
  type MouseEvent as TuiMouseEvent,
  type OptimizedBuffer,
  type Renderable,
  type WidthMethod,
} from "@opentui/core"
import { Prompt, type PromptRef } from "@tui/component/prompt"
import type {
  AssistantMessage,
  Part,
  Provider,
  ToolPart,
  UserMessage,
  TextPart,
  ReasoningPart,
} from "@opencode-ai/sdk/v2"
import { useLocal } from "@tui/context/local"
import { Locale } from "@/util/locale"
import type { Tool } from "@/tool/tool"
import type { ReadTool } from "@/tool/read"
import type { WriteTool } from "@/tool/write"
import { ShellTool } from "@/tool/shell"
import { ShellID } from "@/tool/shell/id"
import type { GlobTool } from "@/tool/glob"
import { TodoWriteTool } from "@/tool/todo"
import type { GrepTool } from "@/tool/grep"
import type { EditTool } from "@/tool/edit"
import type { ApplyPatchTool } from "@/tool/apply_patch"
import type { WebFetchTool } from "@/tool/webfetch"
import { webSearchProviderLabel, type WebSearchTool } from "@/tool/websearch"
import type { TaskTool } from "@/tool/task"
import type { QuestionTool } from "@/tool/question"
import type { SkillTool } from "@/tool/skill"
import { useRenderer, useTerminalDimensions, type JSX } from "@opentui/solid"
import { useSDK } from "@tui/context/sdk"
import { useEditorContext } from "@tui/context/editor"
import type { DialogContext } from "@tui/ui/dialog"
import { useDialog } from "../../ui/dialog"
import { TodoItem } from "../../component/todo-item"
import { DialogMessage } from "./dialog-message"
import type { PromptInfo } from "../../component/prompt/history"
import { DialogConfirm } from "@tui/ui/dialog-confirm"
import { DialogTimeline } from "./dialog-timeline"
import { DialogForkFromTimeline } from "./dialog-fork-from-timeline"
import { DialogSessionRename } from "../../component/dialog-session-rename"
import { Sidebar } from "./sidebar"
import { sessionMessageContentWidth } from "./layout"
import { SubagentFooter } from "./subagent-footer.tsx"
import { LANGUAGE_EXTENSIONS } from "@/lsp/language"
import parsers from "../../../../../../parsers-config.ts"
import * as Clipboard from "../../util/clipboard"
import { errorMessage } from "@/util/error"
import { Toast, useToast } from "../../ui/toast"
import { useKV } from "../../context/kv.tsx"
import * as Editor from "../../util/editor"
import stripAnsi from "strip-ansi"
import { usePromptRef } from "../../context/prompt"
import { useExit } from "../../context/exit"
import { Filesystem } from "@/util/filesystem"
import { Flag } from "@opencode-ai/core/flag/flag"
import { PermissionPrompt } from "./permission"
import { QuestionPrompt } from "./question"
import { DialogExportOptions } from "../../ui/dialog-export-options"
import * as Model from "../../util/model"
import { formatTranscript } from "../../util/transcript"
import { UI } from "@/cli/ui.ts"
import { useTuiConfig } from "../../context/tui-config"
import { getScrollAcceleration } from "../../util/scroll"
import { TuiPluginRuntime } from "@/cli/cmd/tui/plugin/runtime"
import { DialogRetryAction } from "../../component/dialog-retry-action"
import { SessionRetry } from "@/session/retry"
import { getRevertDiffFiles } from "../../util/revert-diff"
import { useCommandPalette } from "../../context/command-palette"
import { useBindings, useCommandShortcut } from "../../keymap"
import { PathFormatterProvider, usePathFormatter } from "../../context/path-format"
// [local-smark] Local TUI features
import { drawSmoothScrollbar, type SmoothScrollbarMarker } from "@tui/util/smooth-scrollbar"
import { previewDiff } from "@tui/util/preview-diff"
import {
  assistantTurnDuration,
  pendingAssistantID,
  shouldCullSessionViewport,
  shouldRefreshStaleBusyStatus,
} from "@tui/util/session-pending"
import { ConnectionError } from "../../util/connection-error"
import { ContextUsagePanel } from "./context-usage"
import { tokenAccounting } from "@/token/accounting"
import { formatSessionExitMessage, formatUsageStats } from "./exit-summary"
import {
  createPendingToolInputParser,
  PENDING_TOOL_INPUT_PROGRESS_INTERVAL,
  type PendingToolInputStats,
} from "./pending-tool-input"
import { useVscodeNotebookToolView } from "./notebook-tool"

addDefaultParsers(parsers.parsers)

const GO_UPSELL_FREE_TIER_LAST_SEEN_AT = "go_upsell_last_seen_at"
const GO_UPSELL_FREE_TIER_DONT_SHOW = "go_upsell_dont_show"
const GO_UPSELL_ACCOUNT_RATE_LIMIT_LAST_SEEN_AT = "go_upsell_account_rate_limit_last_seen_at"
const GO_UPSELL_ACCOUNT_RATE_LIMIT_DONT_SHOW = "go_upsell_account_rate_limit_dont_show"
const GO_UPSELL_WINDOW = 86_400_000 // 24 hrs
const GO_UPSELL_PROVIDERS = new Set(["opencode", "opencode-go"])

function goUpsellKeys(action: SessionRetry.Retryable["action"]) {
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
  "session.share",
  "session.rename",
  "session.timeline",
  "session.fork",
  "session.compact",
  "session.context",
  "session.unshare",
  "session.undo",
  "session.redo",
  "session.sidebar.toggle",
  "session.toggle.conceal",
  "session.toggle.timestamps",
  "session.toggle.thinking",
  "session.toggle.actions",
  "session.toggle.scrollbar",
  "session.toggle.generic_tool_output",
  "session.page.up",
  "session.page.down",
  "session.line.up",
  "session.line.down",
  "session.half.page.up",
  "session.half.page.down",
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

const context = createContext<{
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
}>()

function use() {
  const ctx = useContext(context)
  if (!ctx) throw new Error("useContext must be used within a Session component")
  return ctx
}

export function Session() {
  const route = useRouteData("session")
  const { navigate } = useRoute()
  const sync = useSync()
  const event = useEvent()
  const project = useProject()
  const tuiConfig = useTuiConfig()
  const kv = useKV()
  const { theme } = useTheme()
  const promptRef = usePromptRef()
  const session = createMemo(() => sync.session.get(route.sessionID))
  const children = createMemo(() => {
    const parentID = session()?.parentID ?? session()?.id
    return sync.data.session
      .filter((x) => x.parentID === parentID || x.id === parentID)
      .toSorted((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  })
  const messages = createMemo(() => sync.data.message[route.sessionID] ?? [])
  // Session aggregate 只在 route owner 计算一次，退出文本读取它而不让 ExitProvider 接触 Message/Part。
  // getParts 直接使用 Sync store，保证新增 Stats 与当前 TUI 已展示的数据源一致。
  const sessionUsage = createMemo(() => tokenAccounting(messages(), (id) => sync.data.part[id] ?? []))
  const permissions = createMemo(() => {
    if (session()?.parentID) return []
    return children().flatMap((x) => sync.data.permission[x.id] ?? [])
  })
  const questions = createMemo(() => {
    if (session()?.parentID) return []
    return children().flatMap((x) => sync.data.question[x.id] ?? [])
  })
  const [contextVisible, setContextVisible] = createSignal(false)
  const visible = createMemo(
    () => !session()?.parentID && permissions().length === 0 && questions().length === 0 && !contextVisible(),
  )
  const disabled = createMemo(() => permissions().length > 0 || questions().length > 0 || contextVisible())

  const pending = createMemo(() => {
    const status = sync.data.session_status?.[route.sessionID]
    return pendingAssistantID(messages(), status)
  })
  const [viewportStuckToBottom, setViewportStuckToBottom] = createSignal(true)
  const viewportCulling = createMemo(() =>
    shouldCullSessionViewport(messages(), { stuckToBottom: viewportStuckToBottom() }),
  )

  const lastAssistant = createMemo(() => {
    return messages().findLast((x) => x.role === "assistant")
  })

  const dimensions = useTerminalDimensions()
  const [sidebar, setSidebar] = kv.signal<"auto" | "hide">("sidebar", "auto")
  const [sidebarOpen, setSidebarOpen] = createSignal(false)
  const [conceal, setConceal] = createSignal(true)
  // 主 Session 恢复历史 visibility key；含义已混合的 thinking_mode 继续留给独立 v2 debug route。
  const [showThinking, setShowThinking] = kv.signal("thinking_visibility", true)
  const [timestamps, setTimestamps] = kv.signal<"hide" | "show">("timestamps", "hide")
  const [showDetails, setShowDetails] = kv.signal("tool_details_visibility", true)
  const [showAssistantMetadata, _setShowAssistantMetadata] = kv.signal("assistant_metadata_visibility", true)
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
  const sidebarInLayout = createMemo(() => sidebarVisible() && wide())
  const showTimestamps = createMemo(() => timestamps() === "show")
  const messageContentWidth = createMemo(() =>
    sessionMessageContentWidth({
      terminalWidth: dimensions().width,
      sidebarInLayout: sidebarInLayout(),
      scrollbarEnabled: showScrollbar(),
    }),
  )
  const providers = createMemo(() => Model.index(sync.data.provider))

  const scrollAcceleration = createMemo(() => getScrollAcceleration(tuiConfig))
  const local = useLocal()
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
      // sync 后 parts 就绪：与 sessionID→toBottom 共用 applySessionOpenScroll，避免只修贴底路径 A
      if (route.sessionID === sessionID) scheduleSessionOpenScroll()
    })().catch((error) => {
      if (route.sessionID !== sessionID) return
      toast.show({
        message: errorMessage(error),
        variant: "error",
        duration: 5000,
      })
      if (ConnectionError.isConnectionError(error)) return
      navigate({ type: "home" })
    })
  })

  let lastSwitch: string | undefined = undefined
  event.on("message.part.updated", (evt) => {
    const part = evt.properties.part
    if (part.type !== "tool") return
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

  event.on("server.connected", () => {
    void sync.session.sync(route.sessionID, { force: true })
  })

  createEffect(
    on(
      () => {
        const last = messages().at(-1)
        return [
          route.sessionID,
          sync.data.session_status[route.sessionID]?.type,
          last?.id,
          last?.role,
          last?.role === "assistant" ? last.time.completed : undefined,
        ] as const
      },
      ([sessionID]) => {
        if (!shouldRefreshStaleBusyStatus(messages(), sync.data.session_status[sessionID])) return
        const timer = setTimeout(() => {
          void sync.session.sync(sessionID, { force: true })
        }, 1_500)
        onCleanup(() => clearTimeout(timer))
      },
    ),
  )

  let seeded = false
  let scroll: ScrollBoxRenderable
  let lastMaxScrollTop = 0
  let prompt: PromptRef | undefined
  const bind = (r: PromptRef | undefined) => {
    prompt = r
    promptRef.set(r)
    if (seeded || !route.prompt || !r) return
    seeded = true
    r.set(route.prompt)
  }
  const command = useCommandPalette()
  const dialog = useDialog()
  const renderer = useRenderer()

  function syncSessionViewportStuckToBottom() {
    if (!scroll || scroll.isDestroyed) return
    const maxScrollTop = Math.max(0, scroll.scrollHeight - scroll.viewport.height)
    const wasStuckToBottom = scroll.scrollTop >= lastMaxScrollTop - 1
    const maxScrollTopIncreased = maxScrollTop > lastMaxScrollTop
    lastMaxScrollTop = maxScrollTop
    const stuckToBottom = () => scroll.scrollTop >= maxScrollTop - 1
    // The session viewport intentionally treats a one-row gap as visually
    // bottom-aligned so terminal rounding and scrollbar half-cell drawing do not
    // make the latest assistant line look detached. OpenTUI's sticky scroll only
    // follows content growth from the exact max, so when that tolerated bottom
    // band was already active and new rows appear, advance to the new max. Do
    // not normalize on an ordinary render after a manual one-line scroll-up; the
    // user should still be able to inspect the previous row until content grows.
    if (wasStuckToBottom && maxScrollTopIncreased && scroll.scrollTop < maxScrollTop) scroll.scrollTo(maxScrollTop)
    if (stuckToBottom() === untrack(viewportStuckToBottom)) return
    queueMicrotask(() => setViewportStuckToBottom(stuckToBottom()))
  }

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

  const exit = useExit()

  createEffect(() => {
    const usage = sessionUsage().session
    // ExitProvider 只负责销毁 renderer 和发射已存文本；Session route 在这里保留最终统计快照。
    // effect 依赖 messages/parts 的 accounting memo，确保用户退出前 stored message 已反映最新快照。
    // output 与 reasoning 合并为一个 restrained ↓ 字段，避免把内部 step 分类暴露到永久文本。
    // cache 不进入这里的 input，但仍由 accounting.session 的独立字段保存给 /context 使用。
    return exit.message.set(
      formatSessionExitMessage({
        title: session()?.title ?? "",
        sessionID: session()?.id,
        usage: { input: usage.input, output: usage.output + usage.reasoning, cost: usage.cost },
      }),
    )
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
    if (child) scroll.scrollBy(child.y - scroll.y - 1)
    dialog.clear()
  }

  function toBottom() {
    setTimeout(() => {
      if (!scroll || scroll.isDestroyed) return
      scroll.scrollTo(scroll.scrollHeight)
    }, 50)
  }

  // session-open 唯一滚动语义：有 reviewID 则锚到返回区，否则贴底（覆盖路径 A/B）。
  // INV-02：auto review 深链必须停在对应返回区；INV-03/04：无锚点或解析失败时保持今日贴底。
  // 禁止在此之外再挂无条件贴底成功路径，否则 50ms toBottom 会覆盖已完成的 anchor。
  function applySessionOpenScroll() {
    if (!scroll || scroll.isDestroyed) return
    const reviewID = route.reviewID
    if (reviewID) {
      const target = resolveReviewAnchorMessageID(
        sync.data.message[route.sessionID] ?? [],
        (messageID) => sync.data.part[messageID] ?? [],
        reviewID,
      )
      if (target) {
        // message 节点 id 即 scroll child id；与 timeline onMove 同一滚动 API
        const child = scroll.getChildren().find((item) => item.id === target)
        if (child) {
          scroll.scrollBy(child.y - scroll.y - 1)
          return
        }
      }
    }
    // residual / 普通打开：贴底（不是 try-anchor-then-other-algorithm 的 fallback）
    scroll.scrollTo(scroll.scrollHeight)
  }

  // 与历史 toBottom 同 50ms defer，对齐 OpenTUI layout；非轮询重试框架。
  // path A（sync 完成）与 path B（sessionID 变化）都只 schedule 本函数，语义单一。
  function scheduleSessionOpenScroll() {
    setTimeout(() => applySessionOpenScroll(), 50)
  }

  function moveFirstChild() {
    if (children().length === 1) return
    const next = children().find((x) => !!x.parentID)
    if (next) {
      navigate({
        type: "session",
        sessionID: next.id,
      })
    }
  }

  function moveChild(direction: number) {
    if (children().length === 1) return

    const sessions = children().filter((x) => !!x.parentID)
    let next = sessions.findIndex((x) => x.id === session()?.id) - direction

    if (next >= sessions.length) next = 0
    if (next < 0) next = sessions.length - 1
    if (sessions[next]) {
      navigate({
        type: "session",
        sessionID: sessions[next].id,
      })
    }
  }

  function childSessionHandler(func: () => void) {
    return () => {
      if (!session()?.parentID || dialog.stack.length > 0) return
      func()
    }
  }

  const sessionCommandList = createMemo(() => [
    {
      title: session()?.share?.url ? "Copy share link" : "Share session",
      value: "session.share",
      suggested: route.type === "session",
      category: "Session",
      enabled: sync.data.config.share !== "disabled",
      slash: {
        name: "share",
      },
      run: async () => {
        const copy = (url: string) =>
          Clipboard.copy(url)
            .then(() => toast.show({ message: "Share URL copied to clipboard!", variant: "success" }))
            .catch(() => toast.show({ message: "Failed to copy URL to clipboard", variant: "error" }))
        const url = session()?.share?.url
        if (url) {
          await copy(url)
          dialog.clear()
          return
        }
        if (!kv.get("share_consent", false)) {
          const ok = await DialogConfirm.show(dialog, "Share Session", "Are you sure you want to share it?")
          if (ok !== true) return
          kv.set("share_consent", true)
        }
        await sdk.client.session
          .share({
            sessionID: route.sessionID,
          })
          .then((res) => copy(res.data!.share!.url))
          .catch((error) => {
            toast.show({
              message: error instanceof Error ? error.message : "Failed to share session",
              variant: "error",
            })
          })
        dialog.clear()
      },
    },
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
              if (child) scroll.scrollBy(child.y - scroll.y - 1)
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
              if (child) scroll.scrollBy(child.y - scroll.y - 1)
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
      run: () => {
        const selectedModel = local.model.current()
        if (!selectedModel) {
          toast.show({
            variant: "warning",
            message: "Connect a provider to summarize this session",
            duration: 3000,
          })
          return
        }
        void sdk.client.session.summarize({
          sessionID: route.sessionID,
          modelID: selectedModel.modelID,
          providerID: selectedModel.providerID,
        })
        dialog.clear()
      },
    },
    {
      title: contextVisible() ? "Hide context usage" : "Context usage",
      value: "session.context",
      category: "Session",
      slash: {
        name: "context",
      },
      run: () => {
        dialog.clear()
        setContextVisible((visible) => !visible)
      },
    },
    {
      title: "Unshare session",
      value: "session.unshare",
      category: "Session",
      enabled: !!session()?.share?.url,
      slash: {
        name: "unshare",
      },
      run: async () => {
        await sdk.client.session
          .unshare({
            sessionID: route.sessionID,
          })
          .then(() => toast.show({ message: "Session unshared successfully", variant: "success" }))
          .catch((error) => {
            toast.show({
              message: error instanceof Error ? error.message : "Failed to unshare session",
              variant: "error",
            })
          })
        dialog.clear()
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
        if (status?.type !== "idle") await sdk.client.session.abort({ sessionID: route.sessionID }).catch(() => {})
        const revert = session()?.revert?.messageID
        const message = messages().findLast((x) => (!revert || x.id < revert) && x.role === "user")
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
        const message = messages().find((x) => x.role === "user" && x.id > messageID)
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
            if (child) scroll.scrollBy(child.y - scroll.y - 1)
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
        const revertID = session()?.revert?.messageID
        const lastAssistantMessage = messages().findLast(
          (msg) => msg.role === "assistant" && (!revertID || msg.id < revertID),
        )
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

        Clipboard.copy(text)
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
          await Clipboard.copy(transcript)
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

          // 导出必须绕过 TUI 本地 200 条渲染窗口，直接让 daemon 从数据库分页读取完整可见会话；
          // 这样只影响 export 的快照来源，不改变当前页面渲染、copy transcript 或 sync store 的内存边界。
          const sessionMessages = await sdk.client.session.messages(
            { sessionID: sessionData.id },
            { throwOnError: true },
          )
          // 200 响应必须携带 messages 数组；如果 SDK/daemon 返回异常形态，应沿用现有失败 toast，不能静默写出空 Markdown。
          if (!sessionMessages.data) throw new Error("Missing session messages for export")

          const transcript = formatTranscript(sessionData, sessionMessages.data, {
            thinking: options.thinking,
            toolDetails: options.toolDetails,
            assistantMetadata: options.assistantMetadata,
            providers: sync.data.provider,
          })

          if (options.openWithoutSaving) {
            // Just open in editor without saving
            await Editor.open({ value: transcript, renderer })
          } else {
            const exportDir = process.cwd()
            const filename = options.filename.trim()
            const filepath = path.join(exportDir, filename)

            await Filesystem.write(filepath, transcript)

            // Open with EDITOR if available
            const result = await Editor.open({ value: transcript, renderer })
            if (result !== undefined) {
              await Filesystem.write(filepath, result)
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
      title: "Go to child session",
      value: "session.child.first",
      category: "Session",
      hidden: true,
      run: () => {
        moveFirstChild()
        dialog.clear()
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
        moveChild(1)
        dialog.clear()
      }),
    },
    {
      title: "Previous child session",
      value: "session.child.previous",
      category: "Session",
      hidden: true,
      enabled: !!session()?.parentID,
      run: childSessionHandler(() => {
        moveChild(-1)
        dialog.clear()
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
    enabled: command.matcher,
    bindings: tuiConfig.keybinds.gather("session", sessionBindingCommands),
  }))

  const revertInfo = createMemo(() => session()?.revert)
  const revertMessageID = createMemo(() => revertInfo()?.messageID)

  const revertDiffFiles = createMemo(() => getRevertDiffFiles(revertInfo()?.diff ?? ""))

  const revertRevertedMessages = createMemo(() => {
    const messageID = revertMessageID()
    if (!messageID) return []
    return messages().filter((x) => x.id >= messageID && x.role === "user")
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

  // session 切换贴底路径 B：有 reviewID 时不得无条件 toBottom，统一走 applySessionOpenScroll
  createEffect(
    on(
      () => ({ sessionID: route.sessionID, reviewID: route.reviewID }),
      () => scheduleSessionOpenScroll(),
    ),
  )

  return (
    <PathFormatterProvider path={session()?.directory}>
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
        }}
      >
        <box flexDirection="row" flexGrow={1} minHeight={0}>
          <box flexGrow={1} minHeight={0} paddingBottom={1} paddingLeft={2} paddingRight={2} gap={1}>
            <Show when={session()}>
              <scrollbox
                ref={(r) => (scroll = r)}
                viewportCulling={viewportCulling()}
                renderAfter={syncSessionViewportStuckToBottom}
                viewportOptions={{
                  paddingRight: showScrollbar() ? 1 : 0,
                }}
                contentOptions={{
                  paddingRight: showScrollbar() ? 1 : 0,
                }}
                verticalScrollbarOptions={{
                  paddingLeft: 0,
                  visible: showScrollbar(),
                  trackOptions: {
                    backgroundColor: theme.backgroundElement,
                    foregroundColor: theme.textMuted,
                    renderAfter: drawSessionScrollbar,
                  },
                }}
                stickyScroll={true}
                stickyStart="bottom"
                flexGrow={1}
                scrollAcceleration={scrollAcceleration()}
              >
                <box height={1} />
                <For each={messages()}>
                  {(message, index) => (
                    <Switch>
                      <Match when={message.id === revert()?.messageID}>
                        {(function () {
                          const command = useCommandPalette()
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
                              command.run("session.redo")
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
                      <Match when={revert()?.messageID && message.id >= revert()!.messageID}>
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
                renderBefore={function (this: BoxRenderable, buffer: OptimizedBuffer) {
                  const x = Math.max(0, this.screenX)
                  const y = Math.max(0, this.screenY)
                  const width = Math.min(this.width, buffer.width - x)
                  const height = buffer.height - y
                  if (width > 0 && height > 0) buffer.fillRect(x, y, width, height, theme.background)
                }}
              >
                <Show when={permissions().length > 0}>
                  <PermissionPrompt request={permissions()[0]} />
                </Show>
                <Show when={permissions().length === 0 && questions().length > 0}>
                  <QuestionPrompt request={questions()[0]} />
                </Show>
                <Show when={permissions().length === 0 && questions().length === 0 && contextVisible()}>
                  <ContextUsagePanel sessionID={route.sessionID} onClose={() => setContextVisible(false)} />
                </Show>
                <Show when={session()?.parentID}>
                  <SubagentFooter />
                </Show>
                <Show when={visible()}>
                  <TuiPluginRuntime.Slot
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
                      right={<TuiPluginRuntime.Slot name="session_prompt_right" session_id={route.sessionID} />}
                    />
                  </TuiPluginRuntime.Slot>
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
    </PathFormatterProvider>
  )
}

const MIME_BADGE: Record<string, string> = {
  "text/plain": "txt",
  "image/png": "img",
  "image/jpeg": "img",
  "image/gif": "img",
  "image/webp": "img",
  "application/pdf": "pdf",
  "application/x-directory": "dir",
}

const GOAL_CONTINUATION_LABEL = {
  continue: "CONTINUE",
  replan: "REPLAN",
  "block-check": "BLOCK CHECK",
} as const

// exact 根标签把 pre-marker 历史限定在真实 shipped producer，普通 synthetic XML 不进入 Goal 卡片。
// 首尾锚定要求整个 TextPart 就是 continuation envelope，避免正文片段偶然命中。
const GOAL_CONTINUATION_ENVELOPE = /^<session-goal-continuation>\n[\s\S]*\n<\/session-goal-continuation>$/

function goalObjective(text: string) {
  // objective 标签是 shipped envelope 的稳定字段；这里只提取显示正文，不解释其余模型指令。
  const match = text.match(/<objective>([\s\S]*?)<\/objective>/)
  if (!match) return
  // continuationPrompt 只转义这三种 XML 实体；ampersand 最后还原，避免把用户原文 `&lt;` 二次解码。
  return match[1].trim().replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&amp;/g, "&")
}

function goalContinuation(parts: Part[]) {
  // 新记录优先依赖结构化 marker；exact envelope 仅服务已经落库的 pre-marker Message。
  // synthetic 要求阻止真实用户恰好输入同样 XML 时被降级成 Revert-only 卡片。
  const part = parts.find(
    (item) =>
      item.type === "text" &&
      item.synthetic &&
      (item.metadata?.goal_continuation === true || GOAL_CONTINUATION_ENVELOPE.test(item.text)),
  )
  if (!part || part.type !== "text") return
  const objective = goalObjective(part.text)
  const storedMode = part.metadata?.goal_continuation_mode
  // detail metadata 上线前已经持久化的 Message 只拥有 marker/XML；兼容分支严格绑定 shipped tag，
  // 不从英文 Tool prose、当前 Goal 状态或 Message 序号猜测历史展示事实。
  // 已存在但未知的 mode 表示契约不匹配，不能再退回 CONTINUE 掩盖 producer 错误。
  const mode =
    storedMode === "continue" || storedMode === "replan" || storedMode === "block-check"
      ? storedMode
      : storedMode === undefined
        ? part.text.includes('<strategy-switch mode="breadth-first-replan">')
          ? "replan"
          : "continue"
        : undefined
  if (!objective || !mode) return
  const turn = part.metadata?.goal_continuation_turn
  const maxTurns = part.metadata?.goal_continuation_max_turns
  // SDK metadata 是 unknown；只接收内部 producer 承诺的正整数，不在 TUI 构造第二套计数语义。
  // turn 与 max 必须成对有效；历史 Message 缺少任一值时宁可整体省略计数。
  const count =
    typeof turn === "number" &&
    Number.isSafeInteger(turn) &&
    turn > 0 &&
    typeof maxTurns === "number" &&
    Number.isSafeInteger(maxTurns) &&
    maxTurns > 0
      ? `${turn} / ${maxTurns}`
      : undefined
  // view model 只携带卡片真正需要的事实，避免让 JSX 接触原始 metadata 或 XML。
  return { objective, label: GOAL_CONTINUATION_LABEL[mode], count }
}

function UserMessage(props: {
  message: UserMessage
  parts: Part[]
  onMouseUp: (goalContinuation: boolean) => void
  index: number
  pending?: string
}) {
  const ctx = use()
  const local = useLocal()
  // 同一个 memo 同时驱动正文、badge 和动作 subtype，三处不会产生不同识别结果。
  const goal = createMemo(() => goalContinuation(props.parts))
  // 普通用户文本仍走原路径；旧 continuation 暂时保留既有 objective 提取，
  // 新 marker 由 goal view 独占，避免同一内容在卡片内重复渲染。
  const text = createMemo(() => {
    const texts = props.parts
      .map((x) => {
        if (x.type !== "text") return null
        if (!x.synthetic) return x.text
        // synthetic Goal 已由上方 exact parser 消费；其他 synthetic 文本不属于用户可见正文。
        return null
      })
      .filter(Boolean)
    return texts.join("\n\n")
  })
  // continuation 只替换现有卡片的正文来源，外层 Agent 身份、时间和附件布局保持共享。
  const content = createMemo(() => goal()?.objective ?? text())
  const files = createMemo(() => props.parts.flatMap((x) => (x.type === "file" ? [x] : [])))
  const { theme } = useTheme()
  const [hover, setHover] = createSignal(false)
  const queued = createMemo(() => props.pending && props.message.id > props.pending)
  const color = createMemo(() => local.agent.color(props.message.agent))
  const queuedFg = createMemo(() => selectedForeground(theme, color()))
  const metadataVisible = createMemo(() => queued() || ctx.showTimestamps())

  const compaction = createMemo(() => props.parts.find((x) => x.type === "compaction"))

  return (
    <>
      <Show when={content()}>
        <box
          id={props.message.id}
          border={["left"]}
          borderColor={color()}
          customBorderChars={SplitBorder.customBorderChars}
          marginTop={props.index === 0 ? 0 : 1}
          flexShrink={0}
        >
          <box
            onMouseOver={() => {
              setHover(true)
            }}
            onMouseOut={() => {
              setHover(false)
            }}
            // marker 已在同一 Message 内完成识别；动作菜单只接收 subtype 结果，不重复解析 XML。
            onMouseUp={() => props.onMouseUp(goal() !== undefined)}
            paddingTop={1}
            paddingBottom={1}
            paddingLeft={2}
            backgroundColor={hover() ? theme.backgroundElement : theme.backgroundPanel}
            flexShrink={0}
          >
            <text fg={theme.text}>{content()}</text>
            <Show when={goal()}>
              {(item) => (
                // gap={1} 是两个独立 badge 之间的可见列，不依赖文本尾部空格碰巧分隔。
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
            <Show when={files().length}>
              <box flexDirection="row" paddingBottom={metadataVisible() ? 1 : 0} paddingTop={1} gap={1} flexWrap="wrap">
                <For each={files()}>
                  {(file) => {
                    const bg = createMemo(() => {
                      if (file.mime.startsWith("image/")) return theme.accent
                      if (file.mime === "application/pdf") return theme.primary
                      return theme.secondary
                    })
                    return (
                      <text fg={theme.text}>
                        <span style={{ bg: bg(), fg: theme.background }}> {MIME_BADGE[file.mime] ?? file.mime} </span>
                        <span style={{ bg: theme.backgroundElement, fg: theme.textMuted }}> {file.filename} </span>
                      </text>
                    )
                  }}
                </For>
              </box>
            </Show>
            <Show
              when={queued()}
              fallback={
                <Show when={ctx.showTimestamps()}>
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

// AssistantMessage owns spacing between messages so its outer left border can
// stay continuous for all rows that belong to the same message. Tool renderers
// still need one bit of part-level context: false means "first visible part in
// this message, do not add an internal top gap", true means "separate this tool
// from a previous non-tool part", and undefined leaves InlineTool's legacy
// sibling measurement in charge for consecutive tools and external call sites.
const ToolPartTopMargin = createContext<() => boolean | undefined>(() => undefined)
// Auto review state is attached to every reviewed tool part by the permission
// reviewer service. Keep the TUI lookup in a context so BlockTool/InlineTool can
// render one shared status row without each concrete tool remembering to pass a
// prop; shell and patch can opt out where their layouts need a bespoke position.
const ToolAutoReview = createContext<() => AutoReviewMetadata | undefined>(() => undefined)

function isIncompleteSearch(part: Part) {
  // 只放行本次有明确定义的搜索 metadata，避免第三方 Tool 的同名字段改变 details 可见性。
  return (
    part.type === "tool" &&
    (part.tool === "glob" || part.tool === "grep") &&
    part.state.status === "completed" &&
    part.state.metadata.partial === true
  )
}

type MessageRenderItem =
  // 普通 Part 仍交给既有 renderer；投影层只改变遍历单位，不改变 Part 数据。
  | { kind: "part"; key: string; part: Part }
  // run 是纯显示 descriptor，成员继续保留原始 ID、metadata、time 和 delta 路由。
  | { kind: "reasoning-run"; key: string; parts: ReasoningPart[] }

function projectMessageParts(messageID: string, parts: Part[]) {
  // 该 helper 只返回渲染描述符，调用方不得把结果写回 Sync store 或数据库。
  // 单次 O(n) 扫描发生在 Message 内，接口形状从根源上禁止跨 Message 聚合。
  const result: MessageRenderItem[] = []
  // 暂存数组只收集真正相邻的 reasoning；遇到任意其他 Part 必须立即 flush。
  let reasoning: ReasoningPart[] = []
  // boundary 保存最近原始非 reasoning Part，它既是语义切点，也是稳定 identity 锚点。
  let boundary: Part | undefined

  const flush = () => {
    if (reasoning.length === 0) return
    // run 的身份锚定在前置硬边界，乱序前插 reasoning 时不会重置用户的展开状态。
    result.push({
      kind: "reasoning-run",
      // start key 允许更早 reasoning 乱序前插；after key 允许边界左侧继续保留原状态。
      key: boundary ? `${messageID}:reasoning:after:${boundary.id}` : `${messageID}:reasoning:start`,
      parts: reasoning,
    })
    // 新数组避免后续 push 修改已经交给 descriptor 的成员列表。
    reasoning = []
  }

  parts.forEach((part) => {
    if (part.type === "reasoning") {
      // 连续成员只进入当前 run；这里不读取 text，普通 delta 不应重建拓扑。
      reasoning.push(part)
      return
    }
    // 任意原始非 reasoning Part 都是语义边界，不能因当前不可见而被过滤掉。
    flush()
    result.push({ kind: "part", key: `part:${part.id}`, part })
    boundary = part
  })
  flush()
  return result
}

function AssistantMessage(props: { message: AssistantMessage; parts: Part[]; last: boolean; index: number }) {
  const ctx = use()
  const local = useLocal()
  const { theme } = useTheme()
  const sync = useSync()
  const messages = createMemo(() => sync.data.message[props.message.sessionID] ?? [])
  const model = createMemo(() => Model.name(ctx.providers(), props.message.providerID, props.message.modelID))

  const renderItems = createMemo(() => projectMessageParts(props.message.id, props.parts))
  // Map 保存当前 reactive descriptor；For callback 只持有不会随更新重建的字符串 key。
  const itemByKey = createMemo(() => new Map(renderItems().map((item) => [item.key, item])))
  // key 数组只反映 topology；正文 delta 不应因字符变化制造新的 Solid child root。
  const renderItemKeys = createMemo(() => renderItems().map((item) => item.key))
  // 可见性只决定 spacing/footer，绝不能反向影响 raw topology 的 run 分组结果。
  const visibleItemKeys = createMemo(() => {
    return renderItems().flatMap((item) => {
      if (item.kind === "reasoning-run") {
        // 空/redacted reasoning 留在 topology 中，但整个 run 没有正文时不产生视觉占位。
        if (!ctx.showThinking()) return []
        return item.parts.some((part) => normalizeReasoning(part.text)) ? [item.key] : []
      }
      const part = item.part
      if (part.type === "text") return part.text.trim().length > 0 ? [item.key] : []
      if (part.type === "tool") {
        // completed partial 仍需要告知用户搜索不完整，普通成功继续遵守 details 开关。
        if (!ctx.showDetails() && part.state.status === "completed" && !isIncompleteSearch(part)) return []
        return [item.key]
      }
      return []
    })
  })
  const final = createMemo(() => {
    return props.message.finish && !["tool-calls", "unknown"].includes(props.message.finish)
  })
  const visibleParts = createMemo(() => visibleItemKeys().length > 0)
  const footerVisible = createMemo(() => {
    if (!visibleParts() && !props.message.error) return false
    return final() || props.message.error?.name === "MessageAbortedError"
  })

  const duration = createMemo(() => {
    if (!final()) return 0
    // 消息 footer 是完成态的权威展示，耗时必须和运行中 footer 共用
    // parent user -> assistant completed 的 transcript 口径，避免两套算法漂移。
    return assistantTurnDuration(messages(), props.message)
  })
  const turnUsage = createMemo(() => {
    if (!footerVisible()) return ""
    const usage = tokenAccounting(
      messages(),
      (id) => sync.data.part[id] ?? [],
      undefined,
      props.message.parentID,
    ).request
    // 完成 footer 只记录当前 parent 的永久口径，不读取 prompt/sidebar 的 cache-inclusive total。
    // 只在 footerVisible 后计算，避免未完成或不可见的 assistant 为视口中的每条消息重算统计。
    // parentID 是 queued/coalesced turn 的归属边界，不能改用全局 latest assistant。
    // formatter 返回空字符串时，Show 不会人为添加 Stats 0 或 cost 0。
    return formatUsageStats({ input: usage.totalInputPure, output: usage.totalOutput, cost: usage.cost })
  })

  const childShortcut = useCommandShortcut("session.child.first")

  return (
    <box
      id={props.message.id}
      border={["left"]}
      customBorderChars={SplitBorder.customBorderChars}
      borderColor={theme.backgroundElement}
      flexShrink={0}
      // Message-level gap: this row is outside the message border. Internal
      // part gaps remain inside the border, so multi-part messages draw a
      // continuous left edge while adjacent messages have a visible break.
      marginTop={props.index === 0 ? 0 : 1}
    >
      <For each={renderItemKeys()}>
        {(key, index) => {
          // Solid 的 For 按 item identity 保留子树；primitive key 避免每次投影的新对象触发重挂。
          const item = createMemo(() => itemByKey().get(key)!)
          const visibleIndex = createMemo(() => visibleItemKeys().indexOf(key))
          // First visible part starts immediately under the message border;
          // only later visible parts get an internal separator row.
          const partTopMargin = createMemo(() => visibleIndex() > 0)
          const toolTopMargin = createMemo(() => {
            if (visibleIndex() <= 0) return false
            const previous = itemByKey().get(visibleItemKeys()[visibleIndex() - 1])
            // run 对 tool spacing 表现为一个非 tool item，连续 tool 的既有 sibling 测量保持不变。
            return previous?.kind === "part" && previous.part.type === "tool" ? undefined : true
          })
          return (
            <Switch>
              {/* reasoning descriptor 进入统一 run shell，singleton 也不保留第二套旧 renderer。 */}
              <Match when={item().kind === "reasoning-run" && item()}>
                {(current) => (
                  <ReasoningRun
                    key={current().key}
                    parts={(current() as Extract<MessageRenderItem, { kind: "reasoning-run" }>).parts}
                    topMargin={partTopMargin()}
                    message={props.message}
                  />
                )}
              </Match>
              {/* 普通 Part 原样走既有 Dynamic mapping，聚合不能改变 tool/text 的渲染职责。 */}
              <Match when={item().kind === "part" && item()}>
                {(current) => {
                  const part = () => (current() as Extract<MessageRenderItem, { kind: "part" }>).part
                  const component = createMemo(() => PART_MAPPING[part().type as keyof typeof PART_MAPPING])
                  return (
                    <Show when={component()}>
                      <ToolPartTopMargin.Provider value={toolTopMargin}>
                        <Dynamic
                          last={index() === renderItemKeys().length - 1}
                          topMargin={partTopMargin()}
                          component={component()}
                          part={part() as any}
                          message={props.message}
                        />
                      </ToolPartTopMargin.Provider>
                    </Show>
                  )
                }}
              </Match>
            </Switch>
          )
        }}
      </For>
      <Show when={props.parts.some((x) => x.type === "tool" && x.tool === "task")}>
        <box paddingTop={1} paddingLeft={3}>
          <text fg={theme.text}>
            {childShortcut()}
            <span style={{ fg: theme.textMuted }}> view subagents</span>
          </text>
        </box>
      </Show>
      <Show when={props.message.error && props.message.error.name !== "MessageAbortedError"}>
        <box
          border={["left"]}
          paddingTop={1}
          paddingBottom={1}
          paddingLeft={2}
          marginTop={1}
          backgroundColor={theme.backgroundPanel}
          customBorderChars={SplitBorder.customBorderChars}
          borderColor={theme.error}
        >
          {/* legacy error通过统一formatter转成string，保持旧SDK错误和v2错误各自的owner边界。 */}
          <text fg={theme.textMuted}>{errorMessage(props.message.error)}</text>
        </box>
      </Show>
      <Switch>
        <Match when={footerVisible()}>
          <box paddingLeft={3}>
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

const REASONING_PREVIEW_ROWS = 5
// 非首 source 前加 Markdown 水平线，由 CodeRenderable 的 Markdown 高亮自然渲染为分隔符。
const REASONING_SEPARATOR = "---\n"

function normalizeReasoning(text: string) {
  // 沿用旧 renderer 的规范化口径，避免聚合修复顺手改变 redacted 内容的显示语义。
  return text.replace("[REDACTED]", "").trim()
}

function reasoningRowsTotal(content: string[], width: number, widthMethod: WidthMethod) {
  const buffer = TextBuffer.create(widthMethod)
  const view = TextBufferView.create(buffer)
  view.setWrapWidth(Math.max(width, 1))
  // disclosure 以自然 word wrap 为准；只有它超过预算后，正文才切换 char wrap 进入 compact。
  view.setWrapMode("word")
  const rows = content.reduce((total, text) => {
    buffer.setText(text)
    return total + view.getVirtualLineCount()
  }, 0)
  // 每次 memo 计算都释放 native 句柄，不能用准确测量换取随流式 delta 累积的资源泄漏。
  view.destroy()
  buffer.destroy()
  return rows
}

function ReasoningRun(props: { key: string; topMargin: boolean; parts: ReasoningPart[]; message: AssistantMessage }) {
  // run shell 是唯一折叠单位；成员数量增加时不能再复制 header、border 或 toggle。
  const { theme, subtleSyntax } = useTheme()
  const ctx = use()
  const renderer = useRenderer()
  // disclosure 是 run 局部状态；新 Session / 新 run 必须从长正文收缩态开始。
  const [expanded, setExpanded] = createSignal(false)
  const [rendered, setRendered] = createSignal<Record<string, string | undefined>>({})
  // blank 成员仍参与 run identity，但不应进入用户可见 denominator 或字符统计。
  const parts = createMemo(() => props.parts.filter((part) => normalizeReasoning(part.text)))
  // 保持旧实现以父 Message 完成为准，避免本需求混入 per-Part streaming 生命周期迁移。
  const streaming = createMemo(() => !props.message.time.completed)
  // disclosure 只依据 post-conceal 文本；异步高亮未就绪时先限高但不显示无依据的 toggle。
  const overflow = createMemo(() => {
    const current = parts()
    const content = current.map((part) => rendered()[part.id]).filter((text): text is string => text !== undefined)
    if (content.length !== current.length) return false
    return reasoningRowsTotal(content, ctx.width, renderer.widthMethod) > REASONING_PREVIEW_ROWS
  })
  // 字符数保持旧 `.length` 口径，只用于 header，不参与 key 或视觉行估算。
  const characters = createMemo(() => parts().reduce((total, part) => total + normalizeReasoning(part.text).length, 0))
  return (
    <Show when={parts().length > 0 && ctx.showThinking()}>
      <box
        id={`reasoning-run-${props.key}`}
        paddingLeft={2}
        marginTop={props.topMargin ? 1 : 0}
        flexDirection="column"
        border={["left"]}
        customBorderChars={SplitBorder.customBorderChars}
        borderColor={theme.backgroundElement}
        flexShrink={0}
        onMouseUp={() => {
          // 保留既有 selection 保护；拖选 Thinking 文本不能意外触发展开或折叠。
          if (renderer.getSelection()?.getSelectedText()) return
          // 短正文没有 disclosure；禁止预写状态，避免后续增长或 resize 时意外保持展开。
          if (!overflow()) return
          setExpanded((value) => !value)
        }}
      >
        <box>
          {/* 多 source 才显示 segments，singleton 继续保持旧 Thinking (N chars) 兼容格式。 */}
          <text fg={theme.markdownEmph} attributes={TextAttributes.ITALIC}>
            Thinking ({parts().length > 1 ? `${parts().length} segments · ` : ""}
            {characters().toLocaleString()} chars):
          </text>
        </box>
        {/* 唯一正文树只改变布局约束；展开时不能先隐藏已高亮正文再异步挂载另一棵树。 */}
        <box
          maxHeight={expanded() ? undefined : REASONING_PREVIEW_ROWS}
          overflow={expanded() ? "visible" : "hidden"}
        >
          {/* member key 只使用原 Part ID，run 成员前插不会重挂已有 source body。 */}
          <For each={parts().map((part) => part.id)}>
            {(id, index) => {
              const part = createMemo(() => parts().find((item) => item.id === id)!)
              return (
                <ReasoningBody
                  id={`text-${id}`}
                  part={part}
                  separator={index() > 0}
                  // 短正文自然完整并保持 word wrap；只有真实 overflow 且未展开时才用 char wrap。
                  expanded={expanded() || !overflow()}
                  streaming={streaming()}
                  syntaxStyle={subtleSyntax()}
                  conceal={ctx.conceal()}
                  onContent={(content) =>
                    setRendered((current) => (current[id] === content ? current : { ...current, [id]: content }))
                  }
                />
              )
            }}
          </For>
        </box>
        <Show when={overflow()}>
          <box>
            {/* footer 只表达整个 run 的折叠/展开状态。 */}
            <text fg={theme.textMuted}>{expanded() ? "▲ collapse" : "▼ expand"}</text>
          </box>
        </Show>
      </box>
    </Show>
  )
}

function ReasoningBody(props: {
  id: string
  part: () => ReasoningPart
  separator: boolean
  expanded: boolean
  streaming: boolean
  syntaxStyle: ReturnType<ReturnType<typeof useTheme>["subtleSyntax"]>
  conceal: boolean
  onContent: (content: string | undefined) => void
}) {
  const { theme } = useTheme()
  // accessor 跟随 render descriptor replacement；只捕获旧 Part 对象会让 header 更新而正文停在旧 delta。
  // 非首 source 前加 Markdown 水平线，由 CodeRenderable 的 Markdown 高亮自然渲染为视觉分隔符。
  const content = createMemo(() => {
    const text = normalizeReasoning(props.part().text)
    return props.separator ? REASONING_SEPARATOR + text : text
  })
  // delta 期间沿用上一份可见文本可保持 footer 稳定；只有 conceal 变更会使其语义立即失效。
  createEffect(on(() => props.conceal, () => props.onContent(undefined)))

  return (
    // source 不参与父级五行约束的 flex shrink；共享 wrapper 应裁掉尾部，而不是把成员压成隔项可见。
    <box flexShrink={0}>
      <code
        id={props.id}
        filetype="markdown"
        drawUnstyledText={false}
        streaming={props.streaming}
        syntaxStyle={props.syntaxStyle}
        content={content()}
        conceal={props.conceal}
        fg={theme.textMuted}
        wrapMode={props.expanded ? "word" : "char"}
        onChunks={(chunks, context) => {
          // 旧 highlight 回调不能覆盖新 delta；context.content 是 CodeRenderable 的 generation 边界。
          if (context.content !== content()) return chunks
          props.onContent(chunks.map((chunk) => chunk.text).join(""))
          return chunks
        }}
      />
    </box>
  )
}

function TextPart(props: { last: boolean; topMargin: boolean; part: TextPart; message: AssistantMessage }) {
  const ctx = use()
  const { theme, syntax } = useTheme()
  const streaming = createMemo(() => !props.message.time.completed)
  const content = createMemo(() => props.part.text.trim())
  const completedKey = createMemo(() => `${ctx.width}\u0000${content()}`)
  return (
    <Show when={content()}>
      <box id={"text-" + props.part.id} paddingLeft={3} marginTop={props.topMargin ? 1 : 0} flexShrink={0}>
        <Switch>
          <Match when={Flag.OPENCODE_EXPERIMENTAL_MARKDOWN && !streaming()}>
            <Show keyed when={completedKey()}>
              {(_key) => (
                <markdown
                  syntaxStyle={syntax()}
                  streaming={false}
                  internalBlockMode="top-level"
                  content={content()}
                  tableOptions={{ style: "grid" }}
                  conceal={ctx.conceal()}
                  fg={theme.markdownText}
                  bg={theme.background}
                />
              )}
            </Show>
          </Match>
          <Match when={!Flag.OPENCODE_EXPERIMENTAL_MARKDOWN && !streaming()}>
            <Show keyed when={completedKey()}>
              {(_key) => (
                <code
                  filetype="markdown"
                  drawUnstyledText={false}
                  streaming={false}
                  syntaxStyle={syntax()}
                  content={content()}
                  conceal={ctx.conceal()}
                  fg={theme.text}
                />
              )}
            </Show>
          </Match>
          <Match when={streaming()}>
            <code
              filetype="markdown"
              drawUnstyledText={false}
              streaming={true}
              syntaxStyle={syntax()}
              content={content()}
              conceal={ctx.conceal()}
              fg={theme.text}
            />
          </Match>
        </Switch>
      </box>
    </Show>
  )
}

// Pending messages moved to individual tool pending functions

function ToolPart(props: { last: boolean; part: ToolPart; message: AssistantMessage }) {
  const ctx = use()
  const sync = useSync()

  // Hide tool if showDetails is false and tool completed successfully
  const shouldHide = createMemo(() => {
    if (ctx.showDetails()) return false
    if (props.part.state.status !== "completed") return false
    return !isIncompleteSearch(props.part)
  })

  const toolprops = {
    get metadata() {
      return props.part.state.status === "pending" ? {} : (props.part.state.metadata ?? {})
    },
    get input() {
      return props.part.state.input ?? {}
    },
    get output() {
      return props.part.state.status === "completed" ? props.part.state.output : undefined
    },
    get permission() {
      const permissions = sync.data.permission[props.message.sessionID] ?? []
      const permissionIndex = permissions.findIndex((x) => x.tool?.callID === props.part.callID)
      return permissions[permissionIndex]
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
      <ToolAutoReview.Provider value={() => autoReviewMetadata(toolprops.metadata, props.part.tool)}>
        <Switch>
          <Match when={props.part.tool === ShellID.ToolID}>
            <Shell {...toolprops} />
          </Match>
          <Match when={props.part.tool === "glob"}>
            <Glob {...toolprops} />
          </Match>
          <Match when={props.part.tool === "read"}>
            <Read {...toolprops} />
          </Match>
          <Match when={props.part.tool === "grep"}>
            <Grep {...toolprops} />
          </Match>
          <Match when={props.part.tool === "webfetch"}>
            <WebFetch {...toolprops} />
          </Match>
          <Match when={props.part.tool === "websearch"}>
            <WebSearch {...toolprops} />
          </Match>
          <Match when={props.part.tool === "write"}>
            <Write {...toolprops} />
          </Match>
          <Match when={props.part.tool === "edit"}>
            <Edit {...toolprops} />
          </Match>
          <Match when={props.part.tool === "task"}>
            <Task {...toolprops} />
          </Match>
          <Match when={props.part.tool === "apply_patch"}>
            <ApplyPatch {...toolprops} />
          </Match>
          <Match when={props.part.tool === "todowrite"}>
            <TodoWrite {...toolprops} />
          </Match>
          <Match when={props.part.tool === "question"}>
            <Question {...toolprops} />
          </Match>
          <Match when={props.part.tool === "permission_review_decision"}>
            <PermissionReviewDecision {...toolprops} />
          </Match>
          <Match when={props.part.tool === "skill"}>
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

type ToolProps<T> = {
  input: Partial<Tool.InferParameters<T>>
  metadata: Partial<Tool.InferMetadata<T>>
  permission: Record<string, any>
  tool: string
  output?: string
  part: ToolPart
}

const DEFAULT_BLOCK_CHAR_THRESHOLD = 800
// 工具标题只承担单行摘要职责，不能承载多行源码。这个阈值只影响
// generic/plugin tool 的标题参数展示；真实内容仍由完成态的 notebook diff/source
// card 或 generic output card 展示，避免 pending 阶段刷屏但不丢失结果可见性。
const TOOL_INPUT_VALUE_MAX_LENGTH = 120

function previewText(input: string, maxLines: number, maxChars = DEFAULT_BLOCK_CHAR_THRESHOLD) {
  const lines = input.split("\n")
  const lineLimited = lines.length > maxLines
  const text = lineLimited ? lines.slice(0, maxLines).join("\n") : input
  const charLimited = text.length > maxChars
  if (!lineLimited && !charLimited) return input
  const preview = charLimited ? text.slice(0, maxChars).trimEnd() : text
  return preview ? [preview, "…"].join("\n") : "…"
}

function createPendingToolInputStats(part: () => ToolPart) {
  const [stats, setStats] = createSignal<PendingToolInputStats>()
  let parser = createPendingToolInputParser(part().tool)
  let key = ""
  let consumed = 0
  let timer: Timer | undefined

  function flush() {
    timer = undefined
    setStats(parser.stats())
  }

  createEffect(() => {
    const current = part()
    const raw = current.state.status === "pending" ? current.state.raw : ""
    const nextKey = `${current.id}:${current.tool}`
    if (nextKey !== key || raw.length < consumed) {
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

    parser.push(delta)
    // This stays behind the TUI render boundary: raw SDK events and persisted
    // parts keep their original cadence while large streamed tool inputs only
    // refresh the tiny line-count preview at human-visible speed.
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
      <Show when={props.stats?.added}>
        <span style={{ fg: theme.diffAdded }}> +{props.stats!.added}</span>
      </Show>
      <Show when={props.stats?.removed}>
        <span style={{ fg: theme.diffRemoved }}> -{props.stats!.removed}</span>
      </Show>
    </>
  )
}

function pendingPath(pathFormatter: ReturnType<typeof usePathFormatter>, filePath?: string) {
  return filePath ? pathFormatter.format(filePath) : undefined
}
function GenericTool(props: ToolProps<any>) {
  const { theme } = useTheme()
  const ctx = use()
  const output = createMemo(() => props.output?.trim() ?? "")
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
  const notebookInline = createMemo(() => {
    const view = notebook()
    return view?.mode === "inline" ? view : undefined
  })
  const notebookBlock = createMemo(() => {
    const view = notebook()
    return view?.mode === "block" ? view : undefined
  })

  return (
    <Switch>
      <Match when={notebookInline()}>
        {(view) => (
          <InlineTool icon={view().icon} pending={view().pending} complete={view().complete} part={props.part}>
            {view().children}
          </InlineTool>
        )}
      </Match>
      <Match when={notebookBlock()}>
        {(view) => (
          <BlockTool
            title={view().title}
            part={props.part}
            maxLines={view().maxLines ?? 10}
            threshold={view().threshold ?? 20}
            totalLines={view().totalLines}
            totalChars={view().totalChars}
            preview={view().preview}
          >
            {view().body}
          </BlockTool>
        )}
      </Match>
      <Match when={props.output && ctx.showGenericToolOutput()}>
        <BlockTool
          title={`# ${props.tool} ${input(props.input)}`}
          part={props.part}
          maxLines={10}
          threshold={20}
          totalLines={output().split("\n").length}
          totalChars={output().length}
          preview={<text fg={theme.text}>{previewText(output(), 10)}</text>}
        >
          <text fg={theme.text}>{output()}</text>
        </BlockTool>
      </Match>
      <Match when={true}>
        <InlineTool icon="⚙" pending="Writing command..." complete={true} part={props.part}>
          {props.tool} {input(props.input)}
        </InlineTool>
      </Match>
    </Switch>
  )
}

type AutoReviewMetadata = {
  reviewID: string
  tool: string
  sessionID?: string
  status?: "reviewing" | "allowed" | "denied" | "timed_out" | "failed" | "fallback_user" | "aborted"
  precheck?: { level: string; reason: string }
  result?: { risk_level: string; user_authorization: string; rationale: string }
}

function autoReviewMetadata(metadata: Partial<Tool.InferMetadata<any>>, tool: string): AutoReviewMetadata | undefined {
  const value = (metadata as Record<string, unknown>).autoReview
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  const review = value as Record<string, unknown>
  if (typeof review.reviewID !== "string") return
  return { ...(review as AutoReviewMetadata), tool }
}

function autoReviewLabel(review: AutoReviewMetadata) {
  const agent = "@permission-reviewer"
  // Keep the row text stable across inline and block tools: placement belongs to
  // InlineTool/BlockTool, while this function owns only the compact status copy.
  // The three glyphs are protocol states: ◌ means the hidden reviewer agent is
  // running, ✓ means it allowed execution, and ! covers every non-allow terminal
  // outcome without expanding sensitive reviewer details in the parent session.
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
    case "aborted":
      return `! auto review · aborted · ${agent}`
    default:
      return `◌ auto review · ${review.precheck?.level ?? "reviewing"} · ${agent}`
  }
}

function autoReviewColor(review: AutoReviewMetadata, theme: ReturnType<typeof useTheme>["theme"]) {
  if (review.status === "allowed") return theme.success
  if (review.status && review.status !== "reviewing") return theme.warning
  return theme.info
}

function AutoReviewLine(props: { review: AutoReviewMetadata }) {
  const { theme } = useTheme()
  const { navigate } = useRoute()
  const renderer = useRenderer()
  const [hover, setHover] = createSignal(false)
  const clickable = createMemo(() => Boolean(props.review.sessionID))
  const openReview = (evt?: TuiMouseEvent) => openAutoReviewSession(props.review, navigate, renderer, evt)
  // 这行是 reviewer 子会话入口，不是 transcript 正文。把 mouseup 放在整行 box 上，
  // 并关闭内部 text selection，避免 OpenTUI 在不同平台把一次普通点击先解释成
  // 文本选择，导致 openAutoReviewSession 只消费事件而不导航。
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
  // 固定前缀只用于 TUI renderable 查找，reviewID 负责区分同屏多个工具的
  // reviewer 行；不要把这个 id 当作持久化数据或对外 API。
  return `auto-review-${review.reviewID}`
}

function autoReviewLabelID(review: AutoReviewMetadata) {
  // OpenTUI 在不同平台可能把 mouse target 设为 text 内部 renderable，而不是
  // 外层 row box；label id 与 row id 共用 reviewID，仍只服务本地 hit-test。
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
  evt?: TuiMouseEvent,
) {
  if (!review?.sessionID) return false
  // auto review 行经常嵌在可点击或可折叠的工具卡中。这里必须消费事件，
  // 保持「点击审计结果只打开 reviewer 子会话」这个不变量，不能让事件
  // 继续冒泡到父 BlockTool/InlineTool 后触发展开、折叠或工具专属点击。
  evt?.preventDefault()
  evt?.stopPropagation()
  // review 行不是 transcript 正文，并且内部 text 已关闭 selection。前序 TUI
  // 测试或真实用户留下的旧 selection 不能让这次明确点击只消费事件不导航。
  renderer.clearSelection()
  // 携带 reviewID：子会话进页滚动定位到该次返回区，而非一律贴底
  navigate({ type: "session", sessionID: review.sessionID, reviewID: review.reviewID })
  return true
}

// 用父工具 autoReview.reviewID 在子会话可见消息中解析滚动锚点（优先 assistant 返回区）。
// join 真相在 part metadata：request 用顶层 metadata，decision 用 tool state.metadata。
// 不引入后端 by-reviewID API；hidden 协议失败轮已由 Sync 删除，此处只见可见最终轮。
function resolveReviewAnchorMessageID(
  messages: ReadonlyArray<{ id: string; role: string; parentID?: string }>,
  partsOf: (messageID: string) => readonly Part[],
  reviewID: string,
) {
  let requestID: string | undefined
  let decisionMessageID: string | undefined
  for (const message of messages) {
    for (const part of partsOf(message.id)) {
      if (
        part.type === "text" &&
        part.metadata?.permissionReviewerRequest === true &&
        part.metadata?.reviewID === reviewID
      ) {
        // 多匹配取最后：协议重试 hide 后可见的是最终 request 轮
        requestID = message.id
      }
      if (part.type === "tool") {
        // decision 的 reviewID 在 state.metadata，不是顶层 part.metadata
        const meta = part.state && "metadata" in part.state ? part.state.metadata : undefined
        if (meta && typeof meta === "object" && !Array.isArray(meta) && meta.reviewID === reviewID) {
          decisionMessageID = message.id
        }
      }
    }
  }
  if (requestID) {
    const answer = [...messages].reverse().find((message) => message.role === "assistant" && message.parentID === requestID)
    // 用户需求“返回区域”= assistant 决策消息；reviewing 尚无回答时退到 request（同 join）
    return answer?.id ?? requestID
  }
  // 次选：仅有 decision tool 元数据时的残缺 transcript
  return decisionMessageID
}

function openAutoReviewFromToolChrome(
  review: AutoReviewMetadata | undefined,
  navigate: ReturnType<typeof useRoute>["navigate"],
  renderer: ReturnType<typeof useRenderer>,
  evt: TuiMouseEvent | undefined,
  options?: { inline?: boolean },
) {
  // OpenTUI 可能把 review 文本行的 mouseup 冒泡给父工具卡。这里不再用
  // root + 1 这类布局猜测；父卡片兜底必须再经过行坐标校验，因为标题、
  // 命令行、body 或 expand affordance 与 review row 是兄弟区域，不能共享导航语义。
  if (!review?.sessionID || !evt?.target) return false
  const match = autoReviewLineTarget(review, evt.target)
  // mockMouse 和真实终端鼠标事件传入的是 char frame 的 0-based y；OpenTUI
  // renderable.screenY 在当前布局树中是对应行的 1-based 屏幕坐标。direct 命中
  // 说明事件 target 已在 review row 内，沿用归一化坐标。shell 工具的命令行
  // 和 review row 紧邻，父卡片兜底必须只接受真正 status 行；非 shell inline
  // 工具在部分 OpenTUI hit-grid 状态下会把 review 文本报告成上一行内部 text。
  if (!match) return false
  if (match.direct) {
    if (evt.y !== match.row.screenY - 1) return false
  } else if (
    evt.y !== match.row.screenY &&
    (review.tool === ShellID.ToolID || !options?.inline || evt.y !== match.row.screenY - 1)
  )
    return false
  return openAutoReviewSession(review, navigate, renderer, evt)
}

function ToolAutoReviewLine() {
  const review = useContext(ToolAutoReview)
  return <Show when={review()}>{(item) => <AutoReviewLine review={item()} />}</Show>
}

function InlineTool(props: {
  icon: string
  iconColor?: RGBA
  complete: any
  pending: JSX.Element
  spinner?: boolean
  children: JSX.Element
  part: ToolPart
  onClick?: () => void
  autoReview?: false
}) {
  const [margin, setMargin] = createSignal(0)
  const toolTopMargin = useContext(ToolPartTopMargin)
  const { theme } = useTheme()
  const ctx = use()
  const sync = useSync()
  const renderer = useRenderer()
  const { navigate } = useRoute()
  const review = useContext(ToolAutoReview)
  const [hover, setHover] = createSignal(false)

  const permission = createMemo(() => {
    const callID = sync.data.permission[ctx.sessionID]?.at(0)?.tool?.callID
    if (!callID) return false
    return callID === props.part.callID
  })

  const fg = createMemo(() => {
    if (permission()) return theme.warning
    if (hover() && props.onClick) return theme.text
    if (props.complete) return theme.textMuted
    return theme.text
  })

  const error = createMemo(() => (props.part.state.status === "error" ? props.part.state.error : undefined))

  const denied = createMemo(
    () =>
      error()?.includes("QuestionRejectedError") ||
      error()?.includes("rejected permission") ||
      error()?.includes("specified a rule") ||
      error()?.includes("user dismissed"),
  )

  return (
    <box
      marginTop={toolTopMargin() === undefined ? margin() : toolTopMargin() ? 1 : 0}
      paddingLeft={3}
      overflow="hidden"
      onMouseOver={() => props.onClick && setHover(true)}
      onMouseOut={() => setHover(false)}
      onMouseUp={(evt?: TuiMouseEvent) => {
        if (openAutoReviewFromToolChrome(review(), navigate, renderer, evt, { inline: true })) return
        if (renderer.getSelection()?.getSelectedText()) return
        props.onClick?.()
      }}
      renderBefore={function () {
        const el = this as BoxRenderable
        const parent = el.parent
        if (!parent) {
          return
        }
        if (el.height > 1) {
          setMargin(1)
          return
        }
        const children = parent.getChildren()
        const index = children.indexOf(el)
        const previous = children[index - 1]
        if (!previous) {
          return
        }
        if (previous.height > 1 || previous.id.startsWith("text-")) {
          setMargin(1)
          return
        }
      }}
    >
      <Switch>
        <Match when={props.spinner}>
          <Spinner color={fg()} children={props.children} />
        </Match>
        <Match when={true}>
          <text
            paddingLeft={3}
            fg={fg()}
            wrapMode="none"
            attributes={denied() ? TextAttributes.STRIKETHROUGH : undefined}
          >
            <Show fallback={<>~ {props.pending}</>} when={props.complete}>
              <span style={{ fg: props.iconColor }}>{props.icon}</span> {props.children}
            </Show>
          </text>
        </Match>
      </Switch>
      <Show when={props.autoReview !== false}>
        <ToolAutoReviewLine />
      </Show>
      <Show when={error() && !denied()}>
        <text fg={theme.error}>{error()}</text>
      </Show>
    </box>
  )
}

function BlockTool(props: {
  title: string
  children: JSX.Element
  onClick?: () => void
  onRightClick?: () => void
  part?: ToolPart
  spinner?: boolean
  contextView?: boolean
  contextLabel?: string
  maxLines?: number
  threshold?: number
  totalLines?: number
  totalChars?: number
  charThreshold?: number
  preview?: JSX.Element
  autoReview?: false
}) {
  const { theme } = useTheme()
  const renderer = useRenderer()
  const { navigate } = useRoute()
  const review = useContext(ToolAutoReview)
  const toolTopMargin = useContext(ToolPartTopMargin)
  const [hover, setHover] = createSignal(false)
  const error = createMemo(() => (props.part?.state.status === "error" ? props.part.state.error : undefined))
  const background = createMemo(() => {
    if (props.contextView) return theme.diffContextBg
    if (hover()) return theme.backgroundMenu
    return theme.backgroundPanel
  })
  const previewLines = createMemo(() => props.maxLines ?? 10)
  const threshold = createMemo(() => props.threshold ?? 20)
  const charThreshold = createMemo(() => props.charThreshold ?? DEFAULT_BLOCK_CHAR_THRESHOLD)
  const collapsible = createMemo(() => {
    if (previewLines() <= 0) return false
    // OpenTUI wraps very long single lines at terminal width, so newline counts
    // alone miss commands such as `bun --eval "...large inline script..."` that
    // occupy many visual rows.  Keep the historic line threshold, but also
    // collapse blocks whose command/output text exceeds the preview char budget.
    // This must be synchronous for the first render. Using an effect here lets
    // large edit/write diffs mount once before the preview replaces them, which
    // still pays the full DiffRenderable/tree-sitter cost on the hot path.
    return (props.totalLines ?? 0) > threshold() || (props.totalChars ?? 0) > charThreshold()
  })
  const [expanded, setExpanded] = createSignal(false)
  const collapsed = createMemo(() => collapsible() && !expanded())
  const hasPreview = createMemo(() => props.preview !== undefined)
  // OpenTUI 的 renderable 在被 <Show> 销毁后无法可靠重新挂载同一个 JSX 对象，
  // 会导致折叠→展开→再折叠后内容区变为空白。因此 preview 和 body 一旦挂载就
  // 常驻，通过 visible 切换显示（display:none/flex），而非卸载 DOM 节点。
  // 不使用 maxHeight=0 + overflow=hidden：OpenTUI updateFromLayout 中
  // Math.max(layout.height, 1) 会将高度 0 强制为 1 行，导致隐藏区域泄漏首行。
  const [bodyMounted, setBodyMounted] = createSignal(!hasPreview() || !collapsed())
  // body 延迟到首次展开时才挂载，避免在首屏就付出 diff/tree-sitter 渲染开销；
  // 一旦挂载就不再卸载，后续折叠仅靠 visible=false 隐藏。
  createEffect(() => {
    if (!hasPreview() || !collapsed()) setBodyMounted(true)
  })
  // BlockTool spacing is intentionally owned by the section wrappers below.
  // The body, expand affordance, and error rows each use marginTop={1}; adding
  // a root gap would stack with those margins and render two blank rows around
  // shell/edit/patch/write content. Keep this matching the pre-preview layout
  // while preserving the body wrapper needed for collapsed maxHeight clipping.
  return (
    <box
      border={["left"]}
      paddingTop={1}
      paddingBottom={1}
      paddingLeft={2}
      marginTop={toolTopMargin() === false ? 0 : 1}
      backgroundColor={background()}
      customBorderChars={SplitBorder.customBorderChars}
      borderColor={props.contextView ? theme.info : theme.background}
      onMouseOver={() => (props.onClick || props.onRightClick || collapsible()) && setHover(true)}
      onMouseOut={() => setHover(false)}
      onMouseUp={(evt?: TuiMouseEvent) => {
        if (openAutoReviewFromToolChrome(review(), navigate, renderer, evt)) return
        if (renderer.getSelection()?.getSelectedText()) return
        if (evt?.button === MouseButton.RIGHT) {
          if (!props.onRightClick) return
          evt.preventDefault()
          evt.stopPropagation()
          props.onRightClick()
          return
        }
        if (collapsible()) setExpanded((prev) => !prev)
        props.onClick?.()
      }}
    >
      <Show
        when={props.spinner}
        fallback={
          <text paddingLeft={3} fg={theme.textMuted}>
            {props.title}
            <Show when={props.contextView && props.contextLabel}> · {props.contextLabel}</Show>
          </text>
        }
      >
        <Spinner color={theme.textMuted}>{props.title.replace(/^# /, "")}</Spinner>
      </Show>
      <Show when={props.autoReview !== false}>
        <ToolAutoReviewLine />
      </Show>
      {/* preview 区：折叠态 visible=true 可见，展开态 visible=false 隐藏（display:none） */}
      <Show when={hasPreview()}>
        <box marginTop={collapsed() ? 1 : 0} visible={collapsed()}>
          {props.preview}
        </box>
      </Show>
      {/* body 区：有 preview 时延迟挂载；折叠态若有 preview 则 visible=false 隐藏，
          无 preview 时退回 previewLines 裁剪（兼容 TodoWrite 等无 preview 的块） */}
      <Show when={bodyMounted()}>
        <box
          marginTop={hasPreview() && collapsed() ? 0 : 1}
          visible={!collapsed() || !hasPreview()}
          maxHeight={!hasPreview() && collapsed() ? previewLines() : undefined}
          overflow={!hasPreview() && collapsed() ? "hidden" : undefined}
        >
          {props.children}
        </box>
      </Show>
      <Show when={collapsible()}>
        <box marginTop={1}>
          <text fg={theme.textMuted}>{expanded() ? "Click to collapse" : "Click to expand"}</text>
        </box>
      </Show>
      <Show when={error()}>
        <box marginTop={1}>
          <text fg={theme.error}>{error()}</text>
        </box>
      </Show>
    </box>
  )
}

function Shell(props: ToolProps<typeof ShellTool>) {
  const { theme } = useTheme()
  const pathFormatter = usePathFormatter()
  const isRunning = createMemo(() => props.part.state.status === "running")
  const [showContextOutput, setShowContextOutput] = createSignal(false)
  const contextOutputAvailable = createMemo(() => props.output !== undefined && props.part.state.status === "completed")
  const output = createMemo(() => {
    const text = showContextOutput() && contextOutputAvailable() ? props.output : props.metadata.output
    return stripAnsi(text?.trim() ?? "")
  })
  const shellPreviewText = createMemo(() => {
    const header = `$ ${props.input.command ?? ""}`
    // Shell now uses BlockTool's default review slot like edit/write cards, so
    // the body preview only accounts for command/output text. The review row is
    // still visible while collapsed because BlockTool renders it above the body.
    if (!output()) return header
    return [header, "", output()].join("\n")
  })

  const workdirDisplay = createMemo(() => {
    const workdir = props.input.workdir
    if (!workdir || workdir === ".") return undefined
    return pathFormatter.format(workdir)
  })

  const title = createMemo(() => {
    const desc = props.input.description ?? "Shell"
    const wd = workdirDisplay()
    if (!wd) return `# ${desc}`
    if (desc.includes(wd)) return `# ${desc}`
    return `# ${desc} in ${wd}`
  })

  const toggleContextOutput = () => {
    if (!contextOutputAvailable()) return
    setShowContextOutput((prev) => !prev)
  }

  return (
    <Switch>
      <Match when={props.metadata.output !== undefined}>
        <BlockTool
          title={title()}
          part={props.part}
          spinner={isRunning()}
          maxLines={isRunning() || showContextOutput() ? 0 : 10}
          threshold={20}
          totalLines={shellPreviewText().split("\n").length}
          totalChars={shellPreviewText().length}
          onRightClick={contextOutputAvailable() ? toggleContextOutput : undefined}
          contextView={showContextOutput()}
          contextLabel="returned to model"
          preview={<text fg={theme.text}>{previewText(shellPreviewText(), 10)}</text>}
        >
          <box>
            <text fg={theme.text}>$ {props.input.command}</text>
            {/* 上下文输出模式的内联文字标签已移除：标题 · returned to model 和背景色
                已足够区分上下文模式，命令与输出之间统一用空行分隔，与折叠预览保持一致。 */}
            <Show when={output()}>
              <box marginTop={1}>
                <text fg={theme.text}>{output()}</text>
              </box>
            </Show>
          </box>
        </BlockTool>
      </Match>
      <Match when={true}>
        <InlineTool icon="$" pending="Writing command..." complete={props.input.command} part={props.part}>
          {props.input.command}
        </InlineTool>
      </Match>
    </Switch>
  )
}

function PermissionReviewDecision(props: ToolProps<any>) {
  const { theme } = useTheme()
  const decision = createMemo(() => ({ ...props.input, ...props.metadata }) as Record<string, unknown>)
  const outcome = createMemo(() => (decision().outcome === "allow" ? "allowed" : "denied"))
  const risk = createMemo(() => String(decision().risk_level ?? "unknown"))
  const auth = createMemo(() => String(decision().user_authorization ?? "unknown"))
  const rationale = createMemo<string>(() => {
    const value = decision().rationale
    // permission payload来自外部SDK，只有string rationale才允许进入Text child。
    return typeof value === "string" ? value : ""
  })
  return (
    <BlockTool title={`Permission review decision`} part={props.part} maxLines={0}>
      <box flexDirection="column" gap={1}>
        {/* Keep the structured decision evidence in the tool cell: the assistant text may debate alternatives, but this metadata is the audited final reviewer output. */}
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
  return (
    <box maxHeight={props.maxLines} overflow="hidden">
      <DiffView diff={props.diff} filePath={props.filePath} view={props.view} syncScroll={true} />
    </box>
  )
}

function Write(props: ToolProps<typeof WriteTool>) {
  const ctx = use()
  const { theme, syntax } = useTheme()
  const pathFormatter = usePathFormatter()
  const pendingStats = createPendingToolInputStats(() => props.part)
  const pending = createMemo(() => {
    const stats = pendingStats()
    const filePath = pendingPath(pathFormatter, stats?.filePath)
    if (!filePath && !stats?.added) return "Preparing write..."
    return (
      <>
        Write<Show when={filePath}> {filePath}</Show>
        <PendingStats stats={stats} />
      </>
    )
  })
  const code = createMemo(() => {
    if (!props.input.content) return ""
    return props.input.content
  })
  const diff = createMemo(() => props.metadata.diff as string | undefined)
  const isOverwrite = createMemo(() => props.metadata.exists === true && !!diff())
  const view = createMemo(() => {
    const diffStyle = ctx.tui.diff_style
    if (diffStyle === "stacked") return "unified"
    return ctx.width > 120 ? "split" : "unified"
  })
  const diffStats = createMemo(() => diffLineStats(diff() ?? ""))

  return (
    <Switch>
      <Match when={isOverwrite()}>
        <BlockTool
          title={
            "← Write " +
            pathFormatter.format(props.input.filePath) +
            (diffStats().added > 0 || diffStats().removed > 0 ? ` +${diffStats().added} -${diffStats().removed}` : "")
          }
          part={props.part}
          maxLines={10}
          threshold={20}
          totalLines={diffStats().total}
          totalChars={diff()!.length}
          preview={
            <DiffPreview diff={previewDiff(diff()!, 10)} filePath={props.input.filePath} view={view()} maxLines={10} />
          }
        >
          <box gap={1} flexDirection="column">
            <DiffView diff={diff()!} filePath={props.input.filePath} view={view()} />
            <Diagnostics
              diagnostics={props.metadata.diagnostics}
              filePath={props.input.filePath ?? ""}
              summary={props.metadata.diagnosticSummary}
            />
          </box>
        </BlockTool>
      </Match>
      <Match when={props.metadata.diagnostics !== undefined}>
        <BlockTool
          title={"# Wrote " + pathFormatter.format(props.input.filePath)}
          part={props.part}
          maxLines={10}
          threshold={20}
          totalLines={code().split("\n").length}
          totalChars={code().length}
          preview={
            <line_number fg={theme.textMuted} minWidth={3} paddingRight={1}>
              <code
                conceal={false}
                fg={theme.text}
                filetype={filetype(props.input.filePath!)}
                syntaxStyle={syntax()}
                content={previewText(code(), 10)}
              />
            </line_number>
          }
        >
          <box gap={1} flexDirection="column">
            <line_number fg={theme.textMuted} minWidth={3} paddingRight={1}>
              <code
                conceal={false}
                fg={theme.text}
                filetype={filetype(props.input.filePath!)}
                syntaxStyle={syntax()}
                content={code()}
              />
            </line_number>
            <Diagnostics
              diagnostics={props.metadata.diagnostics}
              filePath={props.input.filePath ?? ""}
              summary={props.metadata.diagnosticSummary}
            />
          </box>
        </BlockTool>
      </Match>
      <Match when={true}>
        <InlineTool icon="←" pending={pending()} complete={props.input.filePath} part={props.part}>
          Write {pathFormatter.format(props.input.filePath)}
        </InlineTool>
      </Match>
    </Switch>
  )
}

function Glob(props: ToolProps<typeof GlobTool>) {
  const pathFormatter = usePathFormatter()
  return (
    <InlineTool icon="✱" pending="Finding files..." complete={props.input.pattern} part={props.part}>
      Glob "{props.input.pattern}" <Show when={props.input.path}>in {pathFormatter.format(props.input.path)} </Show>
      <Show when={props.metadata.count}>
        ({props.metadata.count} {props.metadata.count === 1 ? "match" : "matches"})
      </Show>
      <Show when={props.metadata.partial}> (incomplete)</Show>
    </InlineTool>
  )
}

function Read(props: ToolProps<typeof ReadTool>) {
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
        pending="Reading file..."
        complete={props.input.filePath}
        spinner={isRunning()}
        part={props.part}
      >
        Read {pathFormatter.format(props.input.filePath)} {input(props.input, ["filePath"])}
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

function grepPatterns(value: unknown, exclude = false) {
  const items =
    typeof value === "string" ? [value] : Array.isArray(value) ? value.filter((item) => typeof item === "string") : []
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

function grepResult(metadata: { matches?: unknown; truncated?: unknown; timedOut?: unknown; partial?: unknown }) {
  const matches = typeof metadata.matches === "number" ? metadata.matches : undefined
  const timedOut = metadata.timedOut === true
  const incomplete = metadata.partial === true
  if (matches === undefined) return [timedOut && "timed out", incomplete && "incomplete"].filter(Boolean).join(", ")
  if (matches === 0 && timedOut) return incomplete ? "timed out, incomplete" : "timed out"
  const label = `${matches}${metadata.truncated === true ? "+" : ""} ${matches === 1 && metadata.truncated !== true ? "match" : "matches"}`
  // partial 与 timeout/truncated 独立组合，不能用一个状态覆盖另一个完整性提示。
  return [label, timedOut && "timed out", incomplete && "incomplete"].filter(Boolean).join(", ")
}

function Grep(props: ToolProps<typeof GrepTool>) {
  const pathFormatter = usePathFormatter()
  const filters = createMemo(() =>
    [grepFilter(props.input.include), grepFilter(props.input.exclude, true)].filter(Boolean).join(" · "),
  )
  const result = createMemo(() => grepResult(props.metadata))
  return (
    <InlineTool icon="✱" pending="Searching content..." complete={props.input.pattern} part={props.part}>
      Grep "{props.input.pattern}" <Show when={props.input.path}>in {pathFormatter.format(props.input.path)} </Show>
      <Show when={filters()}>· {filters()} </Show>
      <Show when={result()}>({result()})</Show>
    </InlineTool>
  )
}

function WebFetch(props: ToolProps<typeof WebFetchTool>) {
  return (
    <InlineTool icon="%" pending="Fetching from the web..." complete={props.input.url} part={props.part}>
      WebFetch {props.input.url}
    </InlineTool>
  )
}

function WebSearch(props: ToolProps<typeof WebSearchTool>) {
  const metadata = () => props.metadata as { numResults?: number; provider?: unknown }
  return (
    <InlineTool icon="◈" pending="Searching web..." complete={props.input.query} part={props.part}>
      {webSearchProviderLabel(metadata().provider)} "{props.input.query}"{" "}
      <Show when={metadata().numResults}>({metadata().numResults} results)</Show>
    </InlineTool>
  )
}

function Task(props: ToolProps<typeof TaskTool>) {
  const { navigate } = useRoute()
  const sync = useSync()

  onMount(() => {
    if (props.metadata.sessionId && !sync.data.message[props.metadata.sessionId]?.length)
      void sync.session.sync(props.metadata.sessionId)
  })

  const messages = createMemo(() => sync.data.message[props.metadata.sessionId ?? ""] ?? [])

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

  const isRunning = createMemo(() => props.part.state.status === "running")

  const duration = createMemo(() => {
    const first = messages().find((x) => x.role === "user")?.time.created
    const assistant = messages().findLast((x) => x.role === "assistant")?.time.completed
    if (!first || !assistant) return 0
    return assistant - first
  })

  const content = createMemo(() => {
    if (!props.input.description) return ""
    const description =
      props.metadata.background === true ? `${props.input.description} (background)` : props.input.description
    let content = [`${Locale.titlecase(props.input.subagent_type ?? "General")} Task — ${description}`]

    if (isRunning() && tools().length > 0) {
      // content[0] += ` · ${tools().length} toolcalls`
      if (current()) {
        const state = current()!.state
        const title = state.status === "running" || state.status === "completed" ? state.title : undefined
        content.push(`↳ ${Locale.titlecase(current()!.tool)} ${title}`)
      } else content.push(`↳ ${tools().length} toolcalls`)
    }

    if (props.part.state.status === "completed") {
      content.push(
        props.metadata.background === true
          ? `└ ${tools().length} toolcalls`
          : `└ ${tools().length} toolcalls · ${Locale.duration(duration())}`,
      )
    }

    return content.join("\n")
  })

  return (
    <InlineTool
      icon="│"
      spinner={isRunning()}
      complete={props.input.description}
      pending="Delegating..."
      part={props.part}
      onClick={() => {
        if (props.metadata.sessionId) {
          // Task metadata is written as soon as the child session exists, before
          // its messages necessarily arrive. A previous prefetch can therefore
          // mark the child as synced while it is still empty; force-refresh on
          // explicit navigation so clicking a task always opens the live agent view.
          void sync.session.sync(props.metadata.sessionId, { force: true })
          navigate({ type: "session", sessionID: props.metadata.sessionId })
        }
      }}
    >
      {content()}
    </InlineTool>
  )
}

function Edit(props: ToolProps<typeof EditTool>) {
  const ctx = use()
  const pathFormatter = usePathFormatter()
  const pendingStats = createPendingToolInputStats(() => props.part)
  const pending = createMemo(() => {
    const stats = pendingStats()
    const filePath = pendingPath(pathFormatter, stats?.filePath)
    if (!filePath && !stats?.added && !stats?.removed) return "Preparing edit..."
    return (
      <>
        Edit<Show when={filePath}> {filePath}</Show>
        <PendingStats stats={stats} />
      </>
    )
  })

  const view = createMemo(() => {
    const diffStyle = ctx.tui.diff_style
    if (diffStyle === "stacked") return "unified"
    // Default to "auto" behavior
    return ctx.width > 120 ? "split" : "unified"
  })

  const diffContent = createMemo(() => props.metadata.diff || "")
  const stats = createMemo(() => diffLineStats(diffContent()))

  return (
    <Switch>
      <Match when={props.metadata.diff !== undefined}>
        <BlockTool
          title={
            "← Edit " +
            pathFormatter.format(props.input.filePath) +
            (stats().added > 0 || stats().removed > 0 ? ` +${stats().added} -${stats().removed}` : "")
          }
          part={props.part}
          maxLines={10}
          threshold={20}
          totalLines={stats().total}
          totalChars={diffContent().length}
          preview={
            <DiffPreview
              diff={previewDiff(diffContent(), 10)}
              filePath={props.input.filePath}
              view={view()}
              maxLines={10}
            />
          }
        >
          <box gap={1} flexDirection="column">
            <DiffView diff={diffContent()} filePath={props.input.filePath} view={view()} />
            <Diagnostics
              diagnostics={props.metadata.diagnostics}
              filePath={props.input.filePath ?? ""}
              summary={props.metadata.diagnosticSummary}
            />
          </box>
        </BlockTool>
      </Match>
      <Match when={true}>
        <InlineTool icon="←" pending={pending()} complete={props.input.filePath} part={props.part}>
          Edit {pathFormatter.format(props.input.filePath)}{" "}
          {input({
            replaceAll: Array.isArray(props.input.edits)
              ? props.input.edits.some((e) => e?.replaceAll === true)
              : false,
          })}
        </InlineTool>
      </Match>
    </Switch>
  )
}

function ApplyPatch(props: ToolProps<typeof ApplyPatchTool>) {
  const ctx = use()
  const { theme } = useTheme()
  const pathFormatter = usePathFormatter()
  const pendingStats = createPendingToolInputStats(() => props.part)
  const pending = createMemo(() => {
    const stats = pendingStats()
    if (!stats) return "Preparing patch..."
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

  const files = createMemo(() => props.metadata.files ?? [])
  const review = useContext(ToolAutoReview)

  const view = createMemo(() => {
    const diffStyle = ctx.tui.diff_style
    if (diffStyle === "stacked") return "unified"
    return ctx.width > 120 ? "split" : "unified"
  })

  function title(file: { type: string; relativePath: string; filePath: string; deletions: number; patch?: string }) {
    const baseTitle = (() => {
      if (file.type === "delete") return "# Deleted " + file.relativePath
      if (file.type === "add") return "# Created " + file.relativePath
      if (file.type === "move") return "# Moved " + pathFormatter.format(file.filePath) + " → " + file.relativePath
      return "← Patched " + file.relativePath
    })()

    // 删除文件的 patch 字段同样包含完整 unified diff（apply_patch.ts 会读取原文件
    // 内容并生成 deleteDiff），不再按 type 特殊短路。仅在有 patch 数据时才附加行数
    // 统计；legacy 会话的 metadata 可能缺失 patch 字段，此时跳过 stats 保持兼容。
    if (!file.patch) return baseTitle
    const stats = diffLineStats(file.patch)
    if (stats.added === 0 && stats.removed === 0) return baseTitle
    return `${baseTitle} +${stats.added} -${stats.removed}`
  }

  return (
    <Switch>
      <Match when={files().length > 0}>
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
            {(file) => (
              <BlockTool
                title={title(file)}
                part={props.part}
                maxLines={10}
                threshold={20}
                totalLines={(file.patch ?? "").split("\n").length}
                totalChars={(file.patch ?? "").length}
                autoReview={false}
                preview={
                  <Show
                    // 从 file.type 硬编码断路改为按 patch 数据是否就绪来判断:
                    // 删除文件的 metadata 已包含完整 unified diff（包含被删除内容
                    // 的每一行），因此可以通过 DiffPreview 展示折叠态预览;
                    // legacy 数据无 patch 时退回 -N lines 纯文本摘要。
                    when={!!file.patch}
                    fallback={
                      <text fg={theme.diffRemoved} paddingLeft={1}>
                        -{file.deletions} line{file.deletions !== 1 ? "s" : ""}
                      </text>
                    }
                  >
                    <DiffPreview
                      diff={previewDiff(file.patch || "", 10)}
                      filePath={file.filePath}
                      view={view()}
                      maxLines={10}
                    />
                  </Show>
                }
              >
                <box gap={1} flexDirection="column">
                  <Show
                    // 与 preview 分支保持一致：从 type 断路改为 patch 数据就绪判断，
                    // 删除文件的完整 unified diff 通过 DiffView 渲染，legacy 无 patch
                    // 时退回 -N lines 纯文本摘要。
                    when={!!file.patch}
                    fallback={
                      <text fg={theme.diffRemoved} paddingLeft={1}>
                        -{file.deletions} line{file.deletions !== 1 ? "s" : ""}
                      </text>
                    }
                  >
                    <DiffView diff={file.patch || ""} filePath={file.filePath} view={view()} />
                  </Show>
                  <Diagnostics
                    diagnostics={props.metadata.diagnostics}
                    filePath={file.movePath ?? file.filePath}
                    summary={props.metadata.diagnosticSummary}
                  />
                </box>
              </BlockTool>
            )}
          </For>
        </box>
      </Match>
      <Match when={true}>
        <InlineTool icon="%" pending={pending()} complete={false} part={props.part}>
          Patch
        </InlineTool>
      </Match>
    </Switch>
  )
}

function TodoWrite(props: ToolProps<typeof TodoWriteTool>) {
  return (
    <Switch>
      <Match when={props.metadata.todos?.length}>
        <BlockTool title="# Todos" part={props.part}>
          <box>
            <For each={props.input.todos ?? []}>
              {(todo) => <TodoItem status={todo.status} content={todo.content} />}
            </For>
          </box>
        </BlockTool>
      </Match>
      <Match when={true}>
        <InlineTool icon="⚙" pending="Updating todos..." complete={false} part={props.part}>
          Updating todos...
        </InlineTool>
      </Match>
    </Switch>
  )
}

function Question(props: ToolProps<typeof QuestionTool>) {
  const { theme } = useTheme()
  const count = createMemo(() => props.input.questions?.length ?? 0)

  function format(answer?: ReadonlyArray<string>) {
    if (!answer?.length) return "(no answer)"
    return answer.join(", ")
  }

  return (
    <Switch>
      <Match when={props.metadata.answers}>
        <BlockTool title="# Questions" part={props.part}>
          <box gap={1}>
            <For each={props.input.questions ?? []}>
              {(q, i) => (
                <box flexDirection="column">
                  <text fg={theme.textMuted}>{q.question}</text>
                  <text fg={theme.text}>{format(props.metadata.answers?.[i()])}</text>
                </box>
              )}
            </For>
          </box>
        </BlockTool>
      </Match>
      <Match when={true}>
        <InlineTool icon="→" pending="Asking questions..." complete={count()} part={props.part}>
          Asked {count()} question{count() !== 1 ? "s" : ""}
        </InlineTool>
      </Match>
    </Switch>
  )
}

function Skill(props: ToolProps<typeof SkillTool>) {
  return (
    <InlineTool icon="→" pending="Loading skill..." complete={props.input.name} part={props.part}>
      Skill "{props.input.name}"
    </InlineTool>
  )
}

// [local-smark] TUI 诊断渲染：三态（新错误/既有错误/无错误）+ message 单行归一化 + 截断。
// summary 只在 LSP 确认可用时由 tool 层传入，缺失时不推导 clean，避免误报。
function Diagnostics(props: {
  diagnostics?: Record<string, Record<string, any>[]>
  filePath: string
  summary?: { newCount?: number; existingCount?: number }
}) {
  const { theme } = useTheme()
  const errors = createMemo(() => {
    const normalized = Filesystem.normalizePath(props.filePath)
    const arr = props.diagnostics?.[normalized] ?? []
    return arr.filter((x) => x.severity === 1).slice(0, 3)
  })
  // [local-smark] summary 缺失或字段不完整时为 undefined，TUI 不显示 clean/existing。
  const summary = createMemo(() => {
    const s = props.summary
    if (!s || typeof s.newCount !== "number" || typeof s.existingCount !== "number") return undefined
    return s as { newCount: number; existingCount: number }
  })
  // [local-smark] 多行 Pylance message 压成单行，避免撑高 TUI 工具块。
  const normalizeMsg = (msg: string) => msg.trim().replace(/\s+/g, " ")
  // [local-smark] 截断过长 message，保持 TUI 行宽稳定。
  const truncateMsg = (msg: string, limit = 120) => (msg.length <= limit ? msg : msg.slice(0, limit - 3) + "...")
  const more = createMemo(() => {
    const s = summary()
    if (!s || s.newCount <= errors().length) return 0
    return s.newCount - errors().length
  })
  const newCount = createMemo(() => summary()?.newCount ?? errors().length)
  return (
    <Switch>
      {/* [local-smark] 新错误：header + 最多 3 条单行明细 */}
      <Match when={errors().length > 0}>
        <box gap={0}>
          <text fg={theme.error}>
            LSP · {newCount()} new error{newCount() === 1 ? "" : "s"}
            {more() > 0 ? ` · +${more()} more` : ""}
          </text>
          <For each={errors()}>
            {(diagnostic) => (
              <text fg={theme.error}>
                {"  E "}[{diagnostic.range.start.line + 1}:{diagnostic.range.start.character + 1}]{" "}
                {truncateMsg(normalizeMsg(diagnostic.message))}
              </text>
            )}
          </For>
        </box>
      </Match>
      {/* [local-smark] 无新错误但有既有错误：只显示数量，不展开详情 */}
      <Match when={summary() && summary()!.existingCount > 0}>
        <text fg={theme.textMuted}>LSP checked · 0 new · {summary()!.existingCount} existing</text>
      </Match>
      {/* [local-smark] 完全无错误：绿色确认，避免模型误以为 LSP 没工作 */}
      <Match when={summary() && summary()!.newCount === 0 && summary()!.existingCount === 0}>
        <text fg={theme.success ?? theme.textMuted}>✓ LSP checked · no errors in this file</text>
      </Match>
    </Switch>
  )
}

function diffLineStats(diff: string) {
  const lines = diff.split("\n")
  return {
    added: lines.filter((line) => line.startsWith("+") && !line.startsWith("+++")).length,
    removed: lines.filter((line) => line.startsWith("-") && !line.startsWith("---")).length,
    total: lines.length,
  }
}

function input(input: Record<string, any>, omit?: string[]): string {
  const primitives = Object.entries(input).filter(([key, value]) => {
    if (omit?.includes(key)) return false
    return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
  })
  if (primitives.length === 0) return ""
  return `[${primitives.map(([key, value]) => `${key}=${inputValue(value)}`).join(", ")}]`
}

function inputValue(value: string | number | boolean) {
  if (typeof value !== "string") return String(value)
  const lines = value.split("\n")
  if (lines.length > 1) return `<${lines.length} lines, ${value.length} chars>`
  if (value.length <= TOOL_INPUT_VALUE_MAX_LENGTH) return value
  return value.slice(0, TOOL_INPUT_VALUE_MAX_LENGTH).trimEnd() + "..."
}

function filetype(input?: string) {
  if (!input) return "none"
  const ext = path.extname(input)
  const language = LANGUAGE_EXTENSIONS[ext]
  if (["typescriptreact", "javascriptreact", "javascript"].includes(language)) return "typescript"
  return language
}
