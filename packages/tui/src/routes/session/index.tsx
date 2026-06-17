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
import path from "node:path"
import { mkdir, writeFile } from "node:fs/promises"
import { useRoute, useRouteData } from "../../context/route"
import { useProject } from "../../context/project"
import { useSync } from "../../context/sync"
import { useEvent } from "../../context/event"
import { SplitBorder } from "../../ui/border"
import { useTuiPaths, useTuiTerminalEnvironment } from "../../context/runtime"
import { Spinner } from "../../component/spinner"
import { selectedForeground, useTheme } from "../../context/theme"
import {
  BoxRenderable,
  ScrollBoxRenderable,
  addDefaultParsers,
  TextAttributes,
  RGBA,
  MouseButton,
  type MouseEvent as TuiMouseEvent,
  type OptimizedBuffer,
  type Renderable,
} from "@opentui/core"
import { Prompt, type PromptRef } from "../../component/prompt"
import { Flag } from "@opencode-ai/core/flag/flag"
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
import { webSearchProviderLabel } from "../../util/tool-display"
import { useRenderer, useTerminalDimensions, type JSX } from "@opentui/solid"
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
import { sessionMessageContentWidth } from "./layout"
import { SubagentFooter } from "./subagent-footer.tsx"
import { filetype } from "../../util/filetype"
import parsers from "../../parsers-config"
import { errorMessage } from "../../util/error"
import { Toast, useToast } from "../../ui/toast"
import { useKV } from "../../context/kv.tsx"
import stripAnsi from "strip-ansi"
import { usePromptRef } from "../../context/prompt"
import { useEpilogue } from "../../context/epilogue"
import { normalizePath } from "../../util/path"
import { PermissionPrompt } from "./permission"
import { QuestionPrompt } from "./question"
import { DialogExportOptions } from "../../ui/dialog-export-options"
import * as Model from "../../util/model"
import { formatTranscript } from "../../util/transcript"
import { sessionEpilogue } from "../../util/presentation"
import { setPreLayoutSiblingMargin } from "../../util/layout"
import { useTuiConfig } from "../../config"
import { useClipboard } from "../../context/clipboard"
import { nextThinkingMode, reasoningSummary, useThinkingMode, type ThinkingMode } from "../../context/thinking"
import { getScrollAcceleration } from "../../util/scroll"
import { createThrottledSignal } from "../../util/signal"
import { usePluginRuntime } from "../../plugin/runtime"
import { DialogRetryAction } from "../../component/dialog-retry-action"
import { getRevertDiffFiles } from "../../util/revert-diff"
import { OPENCODE_BASE_MODE, useBindings, useCommandShortcut, useOpencodeKeymap } from "../../keymap"
import { PathFormatterProvider, usePathFormatter } from "../../context/path-format"
// [local-smark] Local TUI features
import { drawSmoothScrollbar, type SmoothScrollbarMarker } from "../../util/smooth-scrollbar"
import { previewDiff } from "../../util/preview-diff"
import {
  assistantTurnDuration,
  pendingAssistantID,
  shouldCullSessionViewport,
  shouldRefreshStaleBusyStatus,
} from "../../util/session-pending"
import { ConnectionError } from "../../util/connection-error"
import { ContextUsagePanel } from "./context-usage"
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

const context = createContext<{
  width: number
  sessionID: string
  conceal: () => boolean
  thinkingMode: () => ThinkingMode
  showThinking: () => boolean
  showTimestamps: () => boolean
  showDetails: () => boolean
  showGenericToolOutput: () => boolean
  userMessageIDs: () => ReadonlySet<string>
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
  const event = useEvent()
  const project = useProject()
  const paths = useTuiPaths()
  const tuiConfig = useTuiConfig()
  const kv = useKV()
  const { theme } = useTheme()
  const promptRef = usePromptRef()
  const session = createMemo(() => sync.session.get(route.sessionID))

  createEffect(() => {
    const title = Locale.truncate(session()?.title ?? "", 50)
    setEpilogue(sessionEpilogue({ title, sessionID: session()?.id }))
  })
  onCleanup(() => setEpilogue())
  const children = createMemo(() => {
    const parentID = session()?.parentID ?? session()?.id
    return sync.data.session
      .filter((x) => x.parentID === parentID || x.id === parentID)
      .toSorted((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  })
  const messages = createMemo(() => sync.data.message[route.sessionID] ?? [])
  const foregroundTasks = createMemo(() =>
    messages().flatMap((message) =>
      (sync.data.part[message.id] ?? []).filter(
        (part): part is ToolPart =>
          part.type === "tool" &&
          part.tool === "task" &&
          part.state.status === "running" &&
          part.state.metadata?.background !== true,
      ),
    ),
  )
  const userMessageIDs = createMemo(
    () =>
      new Set(
        messages()
          .filter((message) => message.role === "user")
          .map((message) => message.id),
      ),
  )
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
  const thinking = useThinkingMode()
  const thinkingMode = thinking.mode
  const showThinking = createMemo(() => true)
  const [timestamps, setTimestamps] = kv.signal<"hide" | "show">("timestamps", "hide")
  const [showDetails, setShowDetails] = kv.signal("tool_details_visibility", true)
  const [showAssistantMetadata, _setShowAssistantMetadata] = kv.signal("assistant_metadata_visibility", true)
  const [showScrollbar, setShowScrollbar] = kv.signal("scrollbar_enabled", true)
  const [diffWrapMode] = kv.signal<"word" | "none">("diff_wrap_mode", "word")
  const [_animationsEnabled, _setAnimationsEnabled] = kv.signal("animations_enabled", true)
  const [showGenericToolOutput, setShowGenericToolOutput] = kv.signal("generic_tool_output_visibility", false)

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
      if (route.sessionID === sessionID && scroll) scroll.scrollBy(100_000)
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
  const keymap = useOpencodeKeymap()
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
          clipboard
            .write?.(url)
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
        dialog.clear()
        toast.show({
          variant: "info",
          message: "Starting session compaction...",
          duration: 3000,
        })
        try {
          await sdk.client.session.summarize(
            {
              sessionID: route.sessionID,
              modelID: selectedModel.modelID,
              providerID: selectedModel.providerID,
            },
            { throwOnError: true },
          )
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
      title: (() => {
        const next = nextThinkingMode(thinkingMode())
        if (next === "hide") return "Collapse thinking"
        return "Expand thinking"
      })(),
      value: "session.toggle.thinking",
      category: "Session",
      slash: {
        name: "thinking",
        aliases: ["toggle-thinking"],
      },
      run: () => {
        thinking.set(nextThinkingMode(thinkingMode()))
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

          // 导出必须绕过 TUI 本地 200 条渲染窗口，直接让 daemon 从数据库分页读取完整可见会话；
          // 这样只影响 export 的快照来源，不改变当前页面渲染、copy transcript 或 sync store 的内存边界。
          const sessionMessages = await sdk.client.session.messages({ sessionID: sessionData.id }, { throwOnError: true })
          // 200 响应必须携带 messages 数组；如果 SDK/daemon 返回异常形态，应沿用现有失败 toast，不能静默写出空 Markdown。
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

  // snap to bottom when session changes
  createEffect(on(() => route.sessionID, toBottom))

  return (
    <PathFormatterProvider path={session()?.directory}>
      <context.Provider
        value={{
          get width() {
            return messageContentWidth()
          },
          sessionID: route.sessionID,
          conceal,
          thinkingMode,
          showThinking,
          showTimestamps,
          showDetails,
          showGenericToolOutput,
          userMessageIDs,
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
                      <Match when={revert()?.messageID && message.id >= revert()!.messageID}>
                        <></>
                      </Match>
                      <Match when={message.role === "user"}>
                        <UserMessage
                          index={index()}
                          onMouseUp={() => {
                            if (renderer.getSelection()?.getSelectedText()) return
                            dialog.replace(() => (
                              <DialogMessage
                                messageID={message.id}
                                sessionID={route.sessionID}
                                setPrompt={(promptInfo) => prompt?.set(promptInfo)}
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

function UserMessage(props: {
  message: UserMessage
  parts: Part[]
  onMouseUp: () => void
  index: number
  pending?: string
}) {
  const ctx = use()
  const local = useLocal()
  const text = createMemo(() => {
    const texts = props.parts
      .map((x) => {
        if (x.type === "text" && !x.synthetic) {
          return x.text
        }
        return null
      })
      .filter(Boolean)
    return texts.join("\n\n")
  })
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
      <Show when={text()}>
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
            onMouseUp={props.onMouseUp}
            paddingTop={1}
            paddingBottom={1}
            paddingLeft={2}
            backgroundColor={hover() ? theme.backgroundElement : theme.backgroundPanel}
            flexShrink={0}
          >
            <text fg={theme.text}>{text()}</text>
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
          id={text() ? undefined : props.message.id}
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

function AssistantMessage(props: { message: AssistantMessage; parts: Part[]; last: boolean; index: number }) {
  const ctx = use()
  const local = useLocal()
  const { theme } = useTheme()
  const sync = useSync()
  const messages = createMemo(() => sync.data.message[props.message.sessionID] ?? [])
  const model = createMemo(() => Model.name(ctx.providers(), props.message.providerID, props.message.modelID))

  const visiblePartIDs = createMemo(() => {
    return props.parts.flatMap((part) => {
      if (part.type === "text") return part.text.trim().length > 0 ? [part.id] : []
      if (part.type === "reasoning") {
        if (!ctx.showThinking()) return []
        return part.text.replace("[REDACTED]", "").trim().length > 0 ? [part.id] : []
      }
      if (part.type === "tool") {
        if (!ctx.showDetails() && part.state.status === "completed") return []
        return [part.id]
      }
      return []
    })
  })
  const final = createMemo(() => {
    return props.message.finish && !["tool-calls", "unknown"].includes(props.message.finish)
  })
  const visibleParts = createMemo(() => visiblePartIDs().length > 0)
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

  const childShortcut = useCommandShortcut("session.child.first")
  const backgroundShortcut = useCommandShortcut("session.background")

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
      <For each={props.parts}>
        {(part, index) => {
          const component = createMemo(() => PART_MAPPING[part.type as keyof typeof PART_MAPPING])
          const visibleIndex = createMemo(() => visiblePartIDs().indexOf(part.id))
          // First visible part starts immediately under the message border;
          // only later visible parts get an internal separator row.
          const partTopMargin = createMemo(() => visibleIndex() > 0)
          const toolTopMargin = createMemo(() => {
            if (visibleIndex() <= 0) return false
            const previous = props.parts.find((item) => item.id === visiblePartIDs()[visibleIndex() - 1])
            return previous?.type === "tool" ? undefined : true
          })
          return (
            <Show when={component()}>
              <ToolPartTopMargin.Provider value={toolTopMargin}>
                <Dynamic
                  last={index() === props.parts.length - 1}
                  topMargin={partTopMargin()}
                  component={component()}
                  part={part as any}
                  message={props.message}
                />
              </ToolPartTopMargin.Provider>
            </Show>
          )
        }}
      </For>
      <Show when={props.parts.some((x) => x.type === "tool" && x.tool === "task")}>
        <box paddingTop={1} paddingLeft={3}>
          <text fg={theme.text}>
            {childShortcut()}
            <span style={{ fg: theme.textMuted }}> view subagents</span>
            <Show
              when={props.parts.some(
                (x) =>
                  x.type === "tool" &&
                  x.tool === "task" &&
                  x.state.status === "running" &&
                  x.state.metadata?.background !== true,
              )}
            >
              <span style={{ fg: theme.textMuted }}> · </span>
              {backgroundShortcut()}
              <span style={{ fg: theme.textMuted }}> background</span>
            </Show>
          </text>
        </box>
      </Show>
      <Show when={props.message.error && props.message.error.name !== "MessageAbortedError"}>
        <box
          id={`assistant-error-${props.message.id}`}
          border={["left"]}
          paddingTop={1}
          paddingBottom={1}
          paddingLeft={2}
          marginTop={1}
          backgroundColor={theme.backgroundPanel}
          customBorderChars={SplitBorder.customBorderChars}
          borderColor={theme.error}
        >
          <text fg={theme.textMuted}>{props.message.error?.data.message}</text>
        </box>
      </Show>
      <Switch>
        <Match when={props.last || footerVisible()}>
          <box id={`assistant-summary-${props.message.id}`} paddingLeft={3}>
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
  reasoning: ReasoningPart,
}

const INLINE_TOOL_ICON_WIDTH = 2

function ReasoningPart(props: { last: boolean; topMargin: boolean; part: ReasoningPart; message: AssistantMessage }) {
  const { theme, subtleSyntax } = useTheme()
  const ctx = use()
  const renderer = useRenderer()
  const [expanded, setExpanded] = createSignal(false)

  const content = createMemo(() => {
    return props.part.text.replace("[REDACTED]", "").trim()
  })
  const [displayContent, setDisplayContent] = createThrottledSignal("", 50)
  createEffect(() => setDisplayContent(content()))
  const renderedContent = createMemo(() => displayContent() || content())
  const lines = createMemo(() => renderedContent().split("\n"))
  const previewLines = 5
  const overflow = createMemo(() => lines().length > previewLines)
  const preview = createMemo(() => {
    if (expanded() || !overflow()) return renderedContent()
    return [...lines().slice(0, previewLines), "…"].join("\n")
  })
  const streaming = createMemo(() => !props.message.time.completed)
  const completedKey = createMemo(() => `${ctx.width}\u0000${preview()}`)
  const inMinimal = createMemo(() => ctx.thinkingMode() === "hide")
  const duration = createMemo(() => {
    const end = props.part.time.end
    return end === undefined ? 0 : Math.max(0, end - props.part.time.start)
  })
  const summary = createMemo(() => reasoningSummary(preview()))

  const toggle = () => {
    if (renderer.getSelection()?.getSelectedText()) return
    if (!inMinimal() && !overflow()) return
    setExpanded((prev) => !prev)
  }

  return (
    <Show when={content() && ctx.showThinking()}>
      <box
        id={`text-${props.part.messageID}-${props.part.id}`}
        paddingLeft={2}
        marginTop={props.topMargin ? 1 : 0}
        flexDirection="column"
        border={["left"]}
        customBorderChars={SplitBorder.customBorderChars}
        borderColor={theme.backgroundElement}
        flexShrink={0}
        onMouseUp={toggle}
      >
        <box>
          <text fg={theme.markdownEmph} attributes={TextAttributes.ITALIC}>
            Thinking ({renderedContent().length.toLocaleString()} chars):
            <Show when={summary().title}>
              <span> {summary().title}</span>
            </Show>
            <Show when={!streaming() && duration()}>
              <span> · {Locale.duration(duration())}</span>
            </Show>
          </text>
        </box>
        <Show when={!inMinimal() || expanded()}>
          <box>
            <Switch>
              <Match when={streaming()}>
                <code
                  filetype="markdown"
                  drawUnstyledText={false}
                  streaming={true}
                  syntaxStyle={subtleSyntax()}
                  content={preview()}
                  conceal={ctx.conceal()}
                  fg={theme.textMuted}
                />
              </Match>
              <Match when={!streaming()}>
                <Show keyed when={completedKey()}>
                  {(_key) => (
                    <code
                      filetype="markdown"
                      drawUnstyledText={false}
                      streaming={false}
                      syntaxStyle={subtleSyntax()}
                      content={preview()}
                      conceal={ctx.conceal()}
                      fg={theme.textMuted}
                    />
                  )}
                </Show>
              </Match>
            </Switch>
          </box>
        </Show>
        <Show when={inMinimal() || overflow()}>
          <box>
            <text fg={theme.textMuted}>{expanded() ? "▲ collapse" : "▼ expand"}</text>
          </box>
        </Show>
      </box>
    </Show>
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
      <box id={`text-${props.part.messageID}-${props.part.id}`} paddingLeft={3} marginTop={props.topMargin ? 1 : 0} flexShrink={0}>
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
  const display = createMemo(() => toolDisplay(props.part.tool))

  // Hide tool if showDetails is false and tool completed successfully
  const shouldHide = createMemo(() => {
    if (ctx.showDetails()) return false
    if (props.part.state.status !== "completed") return false
    return true
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
          <Match when={display() === "apply_patch"}>
            <ApplyPatch {...toolprops} />
          </Match>
          <Match when={display() === "todowrite"}>
            <TodoWrite {...toolprops} />
          </Match>
          <Match when={display() === "question"}>
            <Question {...toolprops} />
          </Match>
          <Match when={props.part.tool === "permission_review_decision"}>
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
function GenericTool(props: ToolProps) {
  const { theme } = useTheme()
  const ctx = use()
  const output = createMemo(() => props.output?.trim() ?? "")
  const pendingStats = createPendingToolInputStats(() => props.part)
  const notebook = useVscodeNotebookToolView({
    tool: () => props.tool,
    input: () => props.input,
    metadata: () => props.metadata,
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

function autoReviewMetadata(metadata: Partial<Record<string, unknown>>, tool: string): AutoReviewMetadata | undefined {
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
  navigate({ type: "session", sessionID: review.sessionID })
  return true
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
  } else if (evt.y !== match.row.screenY && (review.tool === "bash" || !options?.inline || evt.y !== match.row.screenY - 1)) return false
  return openAutoReviewSession(review, navigate, renderer, evt)
}

function ToolAutoReviewLine() {
  const review = useContext(ToolAutoReview)
  return <Show when={review()}>{(item) => <AutoReviewLine review={item()} />}</Show>
}

function InlineTool(props: {
  icon: string
  iconColor?: RGBA
  color?: RGBA
  complete: unknown
  pending: JSX.Element
  failure?: string
  spinner?: boolean
  subagent?: boolean
  children: JSX.Element
  part: ToolPart
  onClick?: () => void
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
      id={`tool-inline-${props.subagent ? "subagent-" : ""}${props.part.messageID}-${props.part.id}`}
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
      subagent={props.subagent}
      autoReview={props.autoReview}
      separateAfter={(id) => id !== undefined && ctx.userMessageIDs().has(id)}
      onMouseOver={() => clickable() && setHover(true)}
      onMouseOut={() => setHover(false)}
      onMouseUp={(evt?: TuiMouseEvent) => {
        if (openAutoReviewFromToolChrome(review(), navigate, renderer, evt, { inline: true })) return
        if (renderer.getSelection()?.getSelectedText()) return
        if (failed()) {
          setErrorExpanded((value) => !value)
          return
        }
        props.onClick?.()
      }}
    >
      {props.children}
    </InlineToolRow>
  )
}

export function InlineToolRow(props: {
  id?: string
  icon: string
  iconColor?: RGBA
  color?: RGBA
  errorColor?: RGBA
  failed?: boolean
  denied?: boolean
  error?: string
  errorExpanded?: boolean
  complete: unknown
  pending: JSX.Element
  failure?: string
  spinner?: boolean
  subagent?: boolean
  autoReview?: false
  children: JSX.Element
  separateAfter?: (id: string | undefined) => boolean
  onMouseOver?: () => void
  onMouseOut?: () => void
  onMouseUp?: (evt?: TuiMouseEvent) => void
}) {
  return (
    <box
      id={props.id}
      paddingLeft={3}
      onMouseOver={props.onMouseOver}
      onMouseOut={props.onMouseOut}
      onMouseUp={props.onMouseUp}
      ref={(el: BoxRenderable) => {
        setPreLayoutSiblingMargin(el, (previous) => {
          const previousInline = previous?.id.startsWith("tool-inline-") ?? false
          const previousSubagent = previous?.id.startsWith("tool-inline-subagent-") ?? false
          return previous?.id.startsWith("text-") ||
            previous?.id.startsWith("tool-block-") ||
            previous?.id.startsWith("assistant-error-") ||
            previous?.id.startsWith("assistant-summary-") ||
            (previousInline && previousSubagent !== Boolean(props.subagent)) ||
            props.separateAfter?.(previous?.id)
            ? 1
            : 0
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
      <Show when={props.autoReview !== false}>
        <ToolAutoReviewLine />
      </Show>
      <Show when={props.failed && props.errorExpanded}>
        <box paddingLeft={INLINE_TOOL_ICON_WIDTH}>
          <text fg={props.errorColor}>{props.error}</text>
        </box>
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
  // BlockTool spacing is intentionally owned by the section wrappers below.
  // The body, expand affordance, and error rows each use marginTop={1}; adding
  // a root gap would stack with those margins and render two blank rows around
  // shell/edit/patch/write content. Keep this matching the pre-preview layout
  // while preserving the body wrapper needed for collapsed maxHeight clipping.
  return (
    <box
      id={props.part ? `tool-block-${props.part.messageID}-${props.part.id}` : undefined}
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
      <box
        marginTop={1}
        maxHeight={collapsed() && !props.preview ? previewLines() : undefined}
        overflow={collapsed() && !props.preview ? "hidden" : undefined}
      >
        <Show when={!collapsed() || !props.preview} fallback={props.preview}>
          {props.children}
        </Show>
      </box>
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

function Shell(props: ToolProps) {
  const { theme } = useTheme()
  const pathFormatter = usePathFormatter()
  const isRunning = createMemo(() => props.part.state.status === "running")
  const [showContextOutput, setShowContextOutput] = createSignal(false)
  const contextOutputAvailable = createMemo(() => props.output !== undefined && props.part.state.status === "completed")
  const output = createMemo(() => {
    const text = showContextOutput() && contextOutputAvailable() ? props.output : stringValue(props.metadata.output)
    return stripAnsi(text?.trim() ?? "")
  })
  const shellPreviewText = createMemo(() => {
    const header = `$ ${stringValue(props.input.command) ?? ""}`
    // Shell now uses BlockTool's default review slot like edit/write cards, so
    // the body preview only accounts for command/output text. The review row is
    // still visible while collapsed because BlockTool renders it above the body.
    if (!output()) return header
    return [header, "", output()].join("\n")
  })

  const workdirDisplay = createMemo(() => {
    const workdir = stringValue(props.input.workdir)
    if (!workdir || workdir === ".") return undefined
    return pathFormatter.format(workdir)
  })

  const title = createMemo(() => {
    const desc = stringValue(props.input.description) ?? "Shell"
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
      <Match when={stringValue(props.metadata.output) !== undefined}>
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
            <text fg={theme.text}>$ {stringValue(props.input.command)}</text>
            <Show when={showContextOutput()}>
              <text fg={theme.info}>Model context output</text>
            </Show>
            <Show when={output()}>
              <text fg={theme.text}>{output()}</text>
            </Show>
          </box>
        </BlockTool>
      </Match>
      <Match when={true}>
        <InlineTool
          icon="$"
          pending="Writing command..."
          complete={stringValue(props.input.command)}
          part={props.part}
        >
          {stringValue(props.input.command)}
        </InlineTool>
      </Match>
    </Switch>
  )
}

function PermissionReviewDecision(props: ToolProps) {
  const { theme } = useTheme()
  const decision = createMemo(() => ({ ...props.input, ...props.metadata }) as Record<string, unknown>)
  const outcome = createMemo(() => (decision().outcome === "allow" ? "allowed" : "denied"))
  const risk = createMemo(() => String(decision().risk_level ?? "unknown"))
  const auth = createMemo(() => String(decision().user_authorization ?? "unknown"))
  const rationale = createMemo(() => (typeof decision().rationale === "string" ? decision().rationale : ""))
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

function Write(props: ToolProps) {
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
    return stringValue(props.input.content) ?? ""
  })
  const filePath = createMemo(() => stringValue(props.input.filePath) ?? "")
  const diff = createMemo(() => stringValue(props.metadata.diff))
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
            pathFormatter.format(filePath()) +
            (diffStats().added > 0 || diffStats().removed > 0 ? ` +${diffStats().added} -${diffStats().removed}` : "")
          }
          part={props.part}
          maxLines={10}
          threshold={20}
          totalLines={diffStats().total}
          totalChars={diff()!.length}
          preview={
            <DiffPreview diff={previewDiff(diff()!, 10)} filePath={filePath()} view={view()} maxLines={10} />
          }
        >
          <box gap={1} flexDirection="column">
            <DiffView diff={diff()!} filePath={filePath()} view={view()} />
            <Diagnostics diagnostics={props.metadata.diagnostics} filePath={filePath()} />
          </box>
        </BlockTool>
      </Match>
      <Match when={props.metadata.diagnostics !== undefined}>
        <BlockTool
          title={"# Wrote " + pathFormatter.format(filePath())}
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
                filetype={filetype(filePath())}
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
                filetype={filetype(filePath())}
                syntaxStyle={syntax()}
                content={code()}
              />
            </line_number>
            <Diagnostics diagnostics={props.metadata.diagnostics} filePath={filePath()} />
          </box>
        </BlockTool>
      </Match>
      <Match when={true}>
        <InlineTool icon="←" pending={pending()} complete={filePath()} part={props.part}>
          Write {pathFormatter.format(filePath())}
        </InlineTool>
      </Match>
    </Switch>
  )
}

function Glob(props: ToolProps) {
  const pathFormatter = usePathFormatter()
  return (
    <InlineTool icon="✱" pending="Finding files..." complete={stringValue(props.input.pattern)} part={props.part}>
      Glob "{stringValue(props.input.pattern)}"{" "}
      <Show when={stringValue(props.input.path)}>in {pathFormatter.format(stringValue(props.input.path))} </Show>
      <Show when={numberValue(props.metadata.count)}>
        ({numberValue(props.metadata.count)} {numberValue(props.metadata.count) === 1 ? "match" : "matches"})
      </Show>
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
        pending="Reading file..."
        complete={stringValue(props.input.filePath)}
        spinner={isRunning()}
        part={props.part}
      >
        Read {pathFormatter.format(stringValue(props.input.filePath))} {input(props.input, ["filePath"])}
      </InlineTool>
      <For each={loaded()}>
        {(filepath, index) => (
          <box id={`tool-inline-loaded-${props.part.messageID}-${props.part.id}-${index()}`} paddingLeft={3}>
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
  const items = typeof value === "string" ? [value] : Array.isArray(value) ? value.filter((item) => typeof item === "string") : []
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

function grepResult(metadata: { matches?: unknown; truncated?: unknown; timedOut?: unknown }) {
  const matches = typeof metadata.matches === "number" ? metadata.matches : undefined
  const timedOut = metadata.timedOut === true
  if (matches === undefined) return timedOut ? "timed out" : ""
  if (matches === 0 && timedOut) return "timed out"
  const label = `${matches}${metadata.truncated === true ? "+" : ""} ${matches === 1 && metadata.truncated !== true ? "match" : "matches"}`
  return timedOut ? `${label}, timed out` : label
}

function Grep(props: ToolProps) {
  const pathFormatter = usePathFormatter()
  const filters = createMemo(() => [grepFilter(props.input.include), grepFilter(props.input.exclude, true)].filter(Boolean).join(" · "))
  const result = createMemo(() => grepResult(props.metadata))
  return (
    <InlineTool icon="✱" pending="Searching content..." complete={stringValue(props.input.pattern)} part={props.part}>
      Grep "{stringValue(props.input.pattern)}" <Show when={stringValue(props.input.path)}>in {pathFormatter.format(stringValue(props.input.path))} </Show>
      <Show when={filters()}>· {filters()} </Show>
      <Show when={result()}>({result()})</Show>
    </InlineTool>
  )
}

function WebFetch(props: ToolProps) {
  return (
    <InlineTool icon="%" pending="Fetching from the web..." complete={stringValue(props.input.url)} part={props.part}>
      WebFetch {stringValue(props.input.url)}
    </InlineTool>
  )
}

function WebSearch(props: ToolProps) {
  return (
    <InlineTool icon="◈" pending="Searching web..." complete={stringValue(props.input.query)} part={props.part}>
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

  onMount(() => {
    const sessionID = stringValue(props.metadata.sessionId)
    if (sessionID && !sync.data.message[sessionID]?.length) void sync.session.sync(sessionID)
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
      subagent={true}
      color={retry() ? theme.error : undefined}
      spinner={isRunning()}
      complete={stringValue(props.input.description)}
      pending="Delegating..."
      part={props.part}
      onClick={() => {
        const id = sessionID()
        if (id) {
          // Task metadata is written as soon as the child session exists, before
          // its messages necessarily arrive. A previous prefetch can therefore
          // mark the child as synced while it is still empty; force-refresh on
          // explicit navigation so clicking a task always opens the live agent view.
          void sync.session.sync(id, { force: true })
          navigate({ type: "session", sessionID: id })
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

function Edit(props: ToolProps) {
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

  const filePath = createMemo(() => stringValue(props.input.filePath) ?? "")
  const diffContent = createMemo(() => stringValue(props.metadata.diff) ?? "")
  const stats = createMemo(() => diffLineStats(diffContent()))

  return (
    <Switch>
      <Match when={stringValue(props.metadata.diff) !== undefined}>
        <BlockTool
          title={
            "← Edit " +
            pathFormatter.format(filePath()) +
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
              filePath={filePath()}
              view={view()}
              maxLines={10}
            />
          }
        >
          <box gap={1} flexDirection="column">
            <DiffView diff={diffContent()} filePath={filePath()} view={view()} />
            <Diagnostics diagnostics={props.metadata.diagnostics} filePath={filePath()} />
          </box>
        </BlockTool>
      </Match>
      <Match when={true}>
        <InlineTool icon="←" pending={pending()} complete={filePath()} part={props.part}>
          Edit {pathFormatter.format(filePath())} {input({ replaceAll: props.input.replaceAll })}
        </InlineTool>
      </Match>
    </Switch>
  )
}

function ApplyPatch(props: ToolProps) {
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

  const files = createMemo(() => parseApplyPatchFiles(props.metadata.files))
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
                  <Diagnostics diagnostics={props.metadata.diagnostics} filePath={file.movePath ?? file.filePath} />
                </box>
              </BlockTool>
            )}
          </For>
        </box>
      </Match>
      <Match when={true}>
        <InlineTool icon="%" pending={pending()} failure="Patch failed" complete={false} part={props.part}>
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
        <InlineTool
          icon="⚙"
          pending="Updating todos..."
          failure="Todo update failed"
          complete={false}
          part={props.part}
        >
          Updating todos...
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
        <InlineTool icon="→" pending="Asking questions..." complete={count()} part={props.part}>
          Asked {count()} question{count() !== 1 ? "s" : ""}
        </InlineTool>
      </Match>
    </Switch>
  )
}

function Skill(props: ToolProps) {
  return (
    <InlineTool icon="→" pending="Loading skill..." complete={stringValue(props.input.name)} part={props.part}>
      Skill "{stringValue(props.input.name)}"
    </InlineTool>
  )
}

function Diagnostics(props: { diagnostics: unknown; filePath: string }) {
  const { theme } = useTheme()
  const terminalEnvironment = useTuiTerminalEnvironment()
  const errors = createMemo(() => {
    const normalized = normalizePath(
      typeof props.filePath === "string" ? props.filePath : "",
      terminalEnvironment.platform,
    )
    return parseDiagnostics(props.diagnostics, normalized)
  })

  return (
    <Show when={errors().length}>
      <box>
        <For each={errors()}>
          {(diagnostic) => (
            <text fg={theme.error}>
              Error [{diagnostic.range.start.line + 1}:{diagnostic.range.start.character + 1}] {diagnostic.message}
            </text>
          )}
        </For>
      </box>
    </Show>
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

function input(input: Record<string, unknown>, omit?: string[]): string {
  const primitives = Object.entries(input).filter((entry): entry is [string, string | number | boolean] => {
    const [key, value] = entry
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
    const patch = stringValue(file.patch)
    const deletions = numberValue(file.deletions)
    if (!type || !relativePath || !filePath || deletions === undefined) return []
    return [{ type, relativePath, filePath, patch, deletions, movePath: stringValue(file.movePath) }]
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

export function parseDiagnostics(value: unknown, filePath: string) {
  const diagnostics = recordValue(value)?.[filePath]
  if (!Array.isArray(diagnostics)) return []
  return diagnostics
    .flatMap((item) => {
      const diagnostic = recordValue(item)
      const start = recordValue(recordValue(diagnostic?.range)?.start)
      const line = numberValue(start?.line)
      const character = numberValue(start?.character)
      const message = stringValue(diagnostic?.message)
      if (diagnostic?.severity !== 1 || line === undefined || character === undefined || !message) return []
      return [{ range: { start: { line, character } }, message }]
    })
    .slice(0, 3)
}
