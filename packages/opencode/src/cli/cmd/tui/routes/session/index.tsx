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
  type MouseEvent as TuiMouseEvent,
  type OptimizedBuffer,
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
import { nextThinkingMode, reasoningTitle, useThinkingMode, type ThinkingMode } from "../../context/thinking"
import { getScrollAcceleration } from "../../util/scroll"
import { createThrottledSignal } from "../../util/signal"
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
import { pendingAssistantID, shouldCullSessionViewport, shouldRefreshStaleBusyStatus } from "@tui/util/session-pending"
import { ConnectionError } from "../../util/connection-error"
import { ContextUsagePanel } from "./context-usage"
import {
  createPendingToolInputParser,
  PENDING_TOOL_INPUT_PROGRESS_INTERVAL,
  type PendingToolInputStats,
} from "./pending-tool-input"

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
  thinkingMode: () => ThinkingMode
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
    return new Map(messages().filter((m) => m.role === "user").map((m) => [m.id, local.agent.color(m.agent)]))
  })
  function drawSessionScrollbar(this: unknown, buffer: OptimizedBuffer) {
    const s = scroll
    if (!s) return

    const colors = userMessageAgentColors()
    drawSmoothScrollbar({
      buffer,
      scrollBox: s,
      markers: s.content.getChildrenSortedByPrimaryAxis().flatMap((child): SmoothScrollbarMarker[] => {
        const color = colors.get(child.id)
        if (!color) return []
        return [{ offset: Math.max(0, child.screenY - s.content.screenY), color }]
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
    const stuckToBottom = scroll.scrollTop >= Math.max(0, scroll.scrollHeight - scroll.viewport.height) - 1
    if (stuckToBottom === untrack(viewportStuckToBottom)) return
    queueMicrotask(() => setViewportStuckToBottom(stuckToBottom))
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
    const title = Locale.truncate(session()?.title ?? "", 50)
    const pad = (text: string) => text.padEnd(10, " ")
    const weak = (text: string) => UI.Style.TEXT_DIM + pad(text) + UI.Style.TEXT_NORMAL
    const logo = UI.logo("  ").split(/\r?\n/)
    return exit.message.set(
      [
        `${logo[0] ?? ""}`,
        `${logo[1] ?? ""}`,
        `${logo[2] ?? ""}`,
        `${logo[3] ?? ""}`,
        ``,
        `  ${weak("Session")}${UI.Style.TEXT_NORMAL_BOLD}${title}${UI.Style.TEXT_NORMAL}`,
        `  ${weak("Continue")}${UI.Style.TEXT_NORMAL_BOLD}opencode -s ${session()?.id}${UI.Style.TEXT_NORMAL}`,
        ``,
      ].join("\n"),
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
          const sessionMessages = messages()

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

          const transcript = formatTranscript(
            sessionData,
            sessionMessages.map((msg) => ({ info: msg, parts: sync.data.part[msg.id] ?? [] })),
            {
              thinking: options.thinking,
              toolDetails: options.toolDetails,
              assistantMetadata: options.assistantMetadata,
              providers: sync.data.provider,
            },
          )

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
          marginTop={1}
          border={["top"]}
          title=" Compaction "
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
    if (!props.message.time.completed) return 0
    const user = messages().find((x) => x.role === "user" && x.id === props.message.parentID)
    if (!user || !user.time) return 0
    return props.message.time.completed - user.time.created
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
          <text fg={theme.textMuted}>{props.message.error?.data.message}</text>
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
                <span style={{ fg: theme.textMuted }}> · {Locale.duration(duration())}</span>
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

  return (
    <Show when={content() && ctx.showThinking()}>
      <box
        id={"text-" + props.part.id}
        paddingLeft={2}
        marginTop={props.topMargin ? 1 : 0}
        flexDirection="column"
        border={["left"]}
        customBorderChars={SplitBorder.customBorderChars}
        borderColor={theme.backgroundElement}
        flexShrink={0}
        onMouseUp={() => {
          if (renderer.getSelection()?.getSelectedText()) return
          setExpanded((prev) => !prev)
        }}
      >
        <box>
          <text fg={theme.markdownEmph} attributes={TextAttributes.ITALIC}>
            Thinking ({renderedContent().length.toLocaleString()} chars):
          </text>
        </box>
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
        <Show when={overflow()}>
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
        <Match when={props.part.tool === "skill"}>
          <Skill {...toolprops} />
        </Match>
        <Match when={true}>
          <GenericTool {...toolprops} />
        </Match>
      </Switch>
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

  return (
    <Show
      when={props.output && ctx.showGenericToolOutput()}
      fallback={
        <InlineTool icon="⚙" pending="Writing command..." complete={true} part={props.part}>
          {props.tool} {input(props.input)}
        </InlineTool>
      }
    >
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
    </Show>
  )
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
}) {
  const [margin, setMargin] = createSignal(0)
  const toolTopMargin = useContext(ToolPartTopMargin)
  const { theme } = useTheme()
  const ctx = use()
  const sync = useSync()
  const renderer = useRenderer()
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
      onMouseUp={() => {
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
          <text paddingLeft={3} fg={fg()} wrapMode="none" attributes={denied() ? TextAttributes.STRIKETHROUGH : undefined}>
            <Show fallback={<>~ {props.pending}</>} when={props.complete}>
              <span style={{ fg: props.iconColor }}>{props.icon}</span> {props.children}
            </Show>
          </text>
        </Match>
      </Switch>
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
}) {
  const { theme } = useTheme()
  const renderer = useRenderer()
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
    if (!output()) return `$ ${props.input.command ?? ""}`
    return [`$ ${props.input.command ?? ""}`, "", output()].join("\n")
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
          <box gap={1}>
            <text fg={theme.text}>$ {props.input.command}</text>
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
        <InlineTool icon="$" pending="Writing command..." complete={props.input.command} part={props.part}>
          {props.input.command}
        </InlineTool>
      </Match>
    </Switch>
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
          preview={<DiffPreview diff={previewDiff(diff()!, 10)} filePath={props.input.filePath} view={view()} maxLines={10} />}
        >
          <box gap={1} flexDirection="column">
            <DiffView diff={diff()!} filePath={props.input.filePath} view={view()} />
            <Diagnostics diagnostics={props.metadata.diagnostics} filePath={props.input.filePath ?? ""} />
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
            <Diagnostics diagnostics={props.metadata.diagnostics} filePath={props.input.filePath ?? ""} />
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

function Grep(props: ToolProps<typeof GrepTool>) {
  const pathFormatter = usePathFormatter()
  return (
    <InlineTool icon="✱" pending="Searching content..." complete={props.input.pattern} part={props.part}>
      Grep "{props.input.pattern}" <Show when={props.input.path}>in {pathFormatter.format(props.input.path)} </Show>
      <Show when={props.metadata.matches}>
        ({props.metadata.matches} {props.metadata.matches === 1 ? "match" : "matches"})
      </Show>
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
          preview={<DiffPreview diff={previewDiff(diffContent(), 10)} filePath={props.input.filePath} view={view()} maxLines={10} />}
        >
          <box gap={1} flexDirection="column">
            <DiffView diff={diffContent()} filePath={props.input.filePath} view={view()} />
            <Diagnostics diagnostics={props.metadata.diagnostics} filePath={props.input.filePath ?? ""} />
          </box>
        </BlockTool>
      </Match>
      <Match when={true}>
        <InlineTool icon="←" pending={pending()} complete={props.input.filePath} part={props.part}>
          Edit {pathFormatter.format(props.input.filePath)} {input({ replaceAll: props.input.replaceAll })}
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
        Patch <Show when={filePath} fallback={`${stats.fileCount} file${stats.fileCount === 1 ? "" : "s"}`}>
          {filePath}
        </Show>
        <PendingStats stats={stats} />
      </>
    )
  })

  const files = createMemo(() => props.metadata.files ?? [])

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

    if (file.type === "delete" || !file.patch) return baseTitle
    const stats = diffLineStats(file.patch)
    if (stats.added === 0 && stats.removed === 0) return baseTitle
    return `${baseTitle} +${stats.added} -${stats.removed}`
  }

  return (
    <Switch>
        <Match when={files().length > 0}>
          <For each={files()}>
            {(file) => (
              <BlockTool
                title={title(file)}
                part={props.part}
                maxLines={10}
                threshold={20}
                totalLines={(file.patch ?? "").split("\n").length}
                totalChars={(file.patch ?? "").length}
                preview={
                  <Show
                    when={file.type !== "delete"}
                    fallback={
                      <text fg={theme.diffRemoved} paddingLeft={1}>
                        -{file.deletions} line{file.deletions !== 1 ? "s" : ""}
                      </text>
                    }
                  >
                    <DiffPreview diff={previewDiff(file.patch || "", 10)} filePath={file.filePath} view={view()} maxLines={10} />
                  </Show>
                }
              >
                <box gap={1} flexDirection="column">
                  <Show
                    when={file.type !== "delete"}
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

function Diagnostics(props: { diagnostics?: Record<string, Record<string, any>[]>; filePath: string }) {
  const { theme } = useTheme()
  const errors = createMemo(() => {
    const normalized = Filesystem.normalizePath(props.filePath)
    const arr = props.diagnostics?.[normalized] ?? []
    return arr.filter((x) => x.severity === 1).slice(0, 3)
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

function input(input: Record<string, any>, omit?: string[]): string {
  const primitives = Object.entries(input).filter(([key, value]) => {
    if (omit?.includes(key)) return false
    return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
  })
  if (primitives.length === 0) return ""
  return `[${primitives.map(([key, value]) => `${key}=${value}`).join(", ")}]`
}

function filetype(input?: string) {
  if (!input) return "none"
  const ext = path.extname(input)
  const language = LANGUAGE_EXTENSIONS[ext]
  if (["typescriptreact", "javascriptreact", "javascript"].includes(language)) return "typescript"
  return language
}
