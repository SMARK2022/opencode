import {
  BoxRenderable,
  // #107：renderBefore 清屏需要 OptimizedBuffer 类型
  RGBA,
  TextareaRenderable,
  MouseEvent,
  PasteEvent,
  decodePasteBytes,
  type KeyEvent,
  type Renderable,
} from "@opentui/core"
import type { CommandContext } from "@opentui/keymap"
import { createEffect, createMemo, onMount, createSignal, onCleanup, on, Show, Switch, Match, untrack } from "solid-js"
import { registerOpencodeSpinner } from "../register-spinner"
import path from "path"
import { fileURLToPath } from "url"
import { useLocal } from "../../context/local"
import { Flag } from "@opencode-ai/core/flag/flag"
import { tint, useTheme } from "../../context/theme"
import { EmptyBorder, SplitBorder } from "../../ui/border"
import { useTuiPaths, useTuiTerminalEnvironment } from "../../context/runtime"
import { useClipboard } from "../../context/clipboard"
import { Spinner } from "../spinner"
import { useSDK } from "../../context/sdk"
import { useRoute } from "../../context/route"
import { useProject } from "../../context/project"
import { useSync } from "../../context/sync"
import { useEvent } from "../../context/event"
import { editorSelectionKey, useEditorContext, type EditorSelection } from "../../context/editor"
import { normalizePromptContent, openEditor } from "../../editor"
import { useExit } from "../../context/exit"
import { promptOffsetWidth } from "../../prompt/display"
import { createStore, produce, unwrap } from "solid-js/store"
import { usePromptHistory, type PromptInfo } from "../../prompt/history"
import { computePromptTraits } from "../../prompt/traits"
import { expandPastedTextPlaceholders, expandTrackedPastedText } from "../../prompt/part"
import { usePromptStash } from "../../prompt/stash"
import { DialogStash } from "../dialog-stash"
import { PromptVoiceInput } from "../../prompt-voice-input"
import { PromptVoiceRecorder } from "../../prompt-voice-recorder"
import { parseGoalSlashInput } from "../../util/parse-goal-slash"
import { executeGoalSlashIntent } from "../../util/goal-http"
import { openGoalDialog } from "../dialog-goal"
import { type AutocompleteRef, Autocomplete } from "./autocomplete"
import { useRenderer, useTerminalDimensions, type JSX } from "@opentui/solid"
import type { AssistantMessage, FilePart, UserMessage } from "@opencode-ai/sdk/v2"
import { Locale } from "../../util/locale"
import { errorMessage } from "../../util/error"
import { formatDuration } from "../../util/format"
import { getContextLimit } from "../../util/token-estimate"
import { tokenAccounting } from "../../util/token-accounting"
// #122：统一 token 统计入口
import { createColors, createFrames } from "../../ui/spinner"
import { useDialog } from "../../ui/dialog"
import { DialogProvider as DialogProviderConnect } from "../dialog-provider"
import { DialogAlert } from "../../ui/dialog-alert"
import { useToast } from "../../ui/toast"
import { useKV } from "../../context/kv"
import { createFadeIn, createRefreshClock, createThrottledSignal, createTokenFlowPulse } from "../../util/signal"
import { activeTurnDuration } from "../../util/session-pending"
import { DialogSkill } from "../dialog-skill"
import { DialogWorkspaceUnavailable } from "../dialog-workspace-unavailable"
import { OPENCODE_BASE_MODE, useBindings, useCommandShortcut, useLeaderActive, useOpencodeKeymap } from "../../keymap"
import { useTuiConfig } from "../../config"
import { usePromptWorkspace } from "./workspace"
import { usePromptMove } from "./move"
import { readLocalAttachment } from "./local-attachment"
import { advanceInterruptCount, canInterruptSession, INTERRUPT_CONFIRMATION_MS } from "./interrupt"
import { useLocation } from "../../context/location"

registerOpencodeSpinner()

export type PromptProps = {
  sessionID?: string
  visible?: boolean
  disabled?: boolean
  onSubmit?: () => void
  ref?: (ref: PromptRef | undefined) => void
  hint?: JSX.Element
  right?: JSX.Element
  showPlaceholder?: boolean
  placeholders?: {
    normal?: string[]
    shell?: string[]
  }
}

function pastedFilepath(value: string, platform: string) {
  const raw = value.replace(/^['"]+|['"]+$/g, "")
  if (raw.startsWith("file://")) {
    try {
      return fileURLToPath(raw)
    } catch {}
  }
  if (platform === "win32") return raw
  return raw.replace(/\\(.)/g, "$1")
}

export type PromptRef = {
  focused: boolean
  current: PromptInfo
  set(prompt: PromptInfo): void
  reset(): void
  blur(): void
  focus(): void
  submit(): void
}

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
})

const DRAFT_RETENTION_MIN_CHARS = 20

function randomIndex(count: number) {
  if (count <= 0) return 0
  return Math.floor(Math.random() * count)
}

function fadeColor(color: RGBA, alpha: number) {
  return RGBA.fromValues(color.r, color.g, color.b, color.a * alpha)
}

function hasEditorRangeSelection(selection: EditorSelection["ranges"][number]) {
  return (
    selection.selection.start.line !== selection.selection.end.line ||
    selection.selection.start.character !== selection.selection.end.character
  )
}

function getEditorRangeLabel(selection: EditorSelection["ranges"][number]) {
  if (!hasEditorRangeSelection(selection)) return
  if (selection.selection.start.line === selection.selection.end.line) return `#${selection.selection.start.line}`
  return `#${selection.selection.start.line}-${selection.selection.end.line}`
}

function formatEditorContext(selection: EditorSelection) {
  const selected = selection.ranges.filter(hasEditorRangeSelection)
  if (selected.length === 0)
    return `<system-reminder>Note: The user opened the file "${selection.filePath}". This may or may not be relevant to the current task.</system-reminder>\n`

  const ranges = selected.map((range, index) => {
    const prefix = selected.length > 1 ? `Selection ${index + 1}: ` : ""
    return `Note: The user selected ${prefix}${getEditorRangeLabel(range)} from "${selection.filePath}". \`\`\`${range.text}\`\`\`\n\n`
  })

  return `<system-reminder>${ranges.join("\n")} This may or may not be relevant to the current task.</system-reminder>\n`
}

let stashed: { prompt: PromptInfo; cursor: number } | undefined

export function Prompt(props: PromptProps) {
  let input: TextareaRenderable
  let anchor: BoxRenderable
  const [inputTarget, setInputTarget] = createSignal<TextareaRenderable | undefined>()

  const leader = useLeaderActive()
  const local = useLocal()
  const paths = useTuiPaths()
  const location = useLocation()
  const terminalEnvironment = useTuiTerminalEnvironment()
  const clipboard = useClipboard()
  const sdk = useSDK()
  const editor = useEditorContext()
  const route = useRoute()
  const project = useProject()
  const sync = useSync()
  const tuiConfig = useTuiConfig()
  const dialog = useDialog()
  const toast = useToast()
  const status = createMemo(() => sync.data.session_status?.[props.sessionID ?? ""] ?? { type: "idle" })
  const history = usePromptHistory()
  const stash = usePromptStash()
  const keymap = useOpencodeKeymap()
  const agentShortcut = useCommandShortcut("agent.cycle")
  const paletteShortcut = useCommandShortcut("command.palette.show")
  const voiceShortcut = useCommandShortcut("prompt.voice.toggle")
  // 正常情况下 shortcut 来自 TuiConfig；fallback 只用于配置缺失/解析异常时保持 footer 和平台默认一致。
  const voiceShortcutFallback = process.platform === "darwin" ? "f8" : "alt+v"
  const renderer = useRenderer()
  const exit = useExit()
  const dimensions = useTerminalDimensions()
  // #109：窄终端隐藏累计 token 括号
  // #189：改按 prompt 实际分配宽度，侧栏挤压时即使终端很宽也要紧凑
  const [promptWidth, setPromptWidth] = createSignal(dimensions().width)
  // 实际prompt槽超过90列才分拆流量，voice超过120列才显示，保持信息露出梯度。
  const showSplitFlow = createMemo(() => promptWidth() > 90)
  const { theme, syntax } = useTheme()
  const kv = useKV()
  const animationsEnabled = createMemo(() => kv.get("animations_enabled", true))
  const list = createMemo(() => props.placeholders?.normal ?? [])
  const shell = createMemo(() => props.placeholders?.shell ?? [])
  const fileContextEnabled = createMemo(() => kv.get("file_context_enabled", true))
  const [dismissedEditorSelectionKey, setDismissedEditorSelectionKey] = createSignal<string>()
  const editorContext = createMemo(() => {
    const selection = fileContextEnabled() ? editor.selection() : undefined
    if (!selection) return
    return editorSelectionKey(selection) === dismissedEditorSelectionKey() ? undefined : selection
  })
  const editorPath = createMemo(() => editorContext()?.filePath)
  const editorSelectionLabel = createMemo(() => {
    const ranges = editorContext()?.ranges
    if (!ranges) return
    const first = ranges.find(hasEditorRangeSelection) ?? ranges[0]
    if (!first) return
    return [getEditorRangeLabel(first), ranges.length > 1 ? `+${ranges.length - 1}` : undefined]
      .filter(Boolean)
      .join(" ")
  })
  const editorFileLabel = createMemo(() => {
    const value = editorPath()
    if (!value) return
    const filename = path.basename(value)
    const file = /^index\.[^./]+$/.test(filename)
      ? [path.basename(path.dirname(value)), filename].filter(Boolean).join("/")
      : filename
    return `${file.split(path.sep).join("/")}${editorSelectionLabel() ?? ""}`
  })
  const editorFileLabelDisplay = createMemo(() => {
    const file = editorFileLabel()
    if (!file) return
    // 预算基于 Prompt 实际 Yoga 宽度；分栏时借用终端总宽会让文件标签预算过大。
    return Locale.truncateMiddle(file, Math.max(12, Math.min(48, Math.floor(promptWidth() / 3))))
  })
  const editorContextLabelState = createMemo(() => editor.labelState())
  const [auto, setAuto] = createSignal<AutocompleteRef>()
  const workspace = usePromptWorkspace(props.sessionID)
  const move = usePromptMove({ projectID: project.project, sessionID: () => props.sessionID })
  const [cursorVersion, setCursorVersion] = createSignal(0)
  const currentProviderLabel = createMemo(() => local.model.parsed().provider)
  const hasRightContent = createMemo(() => Boolean(props.right))
  const [voiceInputStatus, setVoiceInputStatus] = createSignal<PromptVoiceInput.VoiceInputStatus>({ type: "idle" })

  function promptModelWarning() {
    toast.show({
      variant: "warning",
      message: "Connect a provider to send prompts",
      duration: 3000,
    })
    if (sync.data.provider.length === 0) {
      dialog.replace(() => <DialogProviderConnect />)
    }
  }

  function dismissEditorContext() {
    setDismissedEditorSelectionKey(editorSelectionKey(editorContext()))
    editor.clearSelection()
  }
  const fileStyleId = syntax().getStyleId("extmark.file")!
  const agentStyleId = syntax().getStyleId("extmark.agent")!
  const pasteStyleId = syntax().getStyleId("extmark.paste")!
  let promptPartTypeId = 0
  const event = useEvent()

  event.on("tui.prompt.append", (evt, { workspace }) => {
    if (workspace !== project.workspace.current()) return
    if (!input || input.isDestroyed) return
    input.insertText(evt.properties.text)
    setTimeout(() => {
      // setTimeout is a workaround and needs to be addressed properly
      if (!input || input.isDestroyed) return
      input.getLayoutNode().markDirty()
      input.gotoBufferEnd()
      renderer.requestRender()
    }, 0)
  })

  createEffect(() => {
    if (!input || input.isDestroyed) return
    if (props.disabled) input.cursorColor = theme.backgroundElement
    if (!props.disabled) input.cursorColor = theme.text
    if (tuiConfig.cursor) input.cursorStyle = tuiConfig.cursor
  })

  const lastUserMessage = createMemo(() => {
    if (!props.sessionID) return undefined
    const messages = sync.data.message[props.sessionID]
    if (!messages) return undefined
    return messages.findLast((m): m is UserMessage => m.role === "user")
  })

  // 首次等待没有 API 用量，context 可缺省以免把零流量解释成已测得的上下文。
  // 保留原始计数供增长比较，避免 Locale 的缩写或分隔符掩盖数值变化。
  // 主值是请求累计，括号是全局累计；数值字段仍供节流后的增长脉冲比较。
  // context 与 cost 继续是文本，不混入 token 信号的比较口径。
  type UsageInfo = { input: number; output: number; totalInput: number; totalOutput: number; context: string | undefined; cost: string | undefined }
  const isRunning = createMemo(() => status().type !== "idle")

  const usageRaw = createMemo((): UsageInfo | undefined => {
    if (!props.sessionID) return
    // 会话运行中（非 idle）时即使没有助手回复也显示零值用量
    // retry 也属于未结束请求；不能只认 busy，否则重试间隙会隐藏等待中的流量。
    const isRunning = status().type !== "idle"
    const session = sync.session.get(props.sessionID)
    const msg = sync.data.message[props.sessionID] ?? []
    // transcript 只保留 100 条，已确认总量不能由这个显示窗口重新累计。
    const assistants = msg.filter((item): item is AssistantMessage => item.role === "assistant")
    const confirmed = session?.tokens
    if (!confirmed) {
      // 会话快照尚未到达时保留 index 6 的运行中零值占位，不从窗口推算历史总量。
      if (!isRunning) return
      return { input: 0, output: 0, totalInput: 0, totalOutput: 0, context: undefined, cost: undefined }
    }

    // 身份和已确认请求累计来自完整投影；缓存中用户缺失不等于请求缺失。
    // 这里只读取最后助手的流式尾部，不从 100 条显示页计算已确认总量。
    const request = session?.request
    // 首轮等待真实请求体估算；身份与窗口外确认累计继续取 Session.request。
    // 空闲无回复仍隐藏；运行中无回复进入共享估算，不借用旧请求的确认值。
    if (!request || (!request.assistantID && !isRunning)) {
      if (!isRunning) return
      return { input: 0, output: 0, totalInput: 0, totalOutput: 0, context: undefined, cost: undefined }
    }
    const requestAssistants = assistants.filter((item) => item.id === request?.assistantID)
    const last = requestAssistants.at(-1)
    // #14 主值改为当前 step，括号改为当前请求累计，全局 tokens 不被改写。

    // 当前助手缺失时仍显示 native 或已分页淘汰的确认投影，不恢复窗口累计。
    const lastParts = last ? (sync.data.part[last.id] ?? []) : []
    // 同一共享 owner 给出 step 与 request 两种范围，各保留一次未确认尾部。
    // 密度随完整 request.inputEstimate 投影到达，100条窗口不再重新校准或累加确认点。
    // 统一统计入口保留完整请求投影与当前尾部，不因分页或首包前无助手而丢失计数。
    const { input: currentInput, output: currentOutput, totalInput, totalOutput } = tokenAccounting(msg, (id) => sync.data.part[id] ?? [], undefined, { session, last, parts: lastParts }).request
    const requestTokens = currentInput + currentOutput
    const totalTokens = totalInput + totalOutput
    if (requestTokens <= 0 && totalTokens <= 0) {
      if (!isRunning) return
      return { input: 0, output: 0, totalInput, totalOutput, context: undefined, cost: undefined }
    }

    // 模型随完整请求投影提供，窗口淘汰助手后仍不丢真实上下文上限。
    // 首次等待的模型来自同一用户，确认后继续优先使用请求投影中的实际模型。
    const modelRef = request.model ?? msg.find((item): item is UserMessage => item.role === "user" && item.id === request.messageID)?.model
    const contextLimit = getContextLimit(sync.data.provider, modelRef?.providerID, modelRef?.modelID, request.model?.contextLimit)
    const pct = requestTokens > 0 && contextLimit ? `${Math.round((requestTokens / contextLimit) * 100)}%` : undefined
    // 恢复源提交的请求费用范围；服务端来源并不使 Session.cost 等同请求 cost。
    // 确认价格继续由原生产者计算，此处只消费完整请求的助手费用求和。
    const cost = request.cost
    return {
      input: currentInput,
      output: currentOutput,
      totalInput,
      totalOutput,
      // context 与 cost 仍是展示文本，不参与流量判断，费用变化不应点亮 token 箭头。
      context: requestTokens > 0 ? (pct ? `${Locale.number(requestTokens)} (${pct})` : Locale.number(requestTokens)) : undefined,
      cost: cost > 0 ? money.format(cost) : undefined,
    }
  })

  // 只合并发布给视图的快照，usageRaw 仍跟踪每次变更，不能据此认为统计计算也被节流。
  // 无会话或无助手时的 undefined 必须进入尾值，使 Match 最终撤下旧用量而非保留旧快照。
  const [usage, setUsageThrottled] = createThrottledSignal<UsageInfo | undefined>(undefined, 50)
  createEffect(() => setUsageThrottled(usageRaw()))

  // 观察 usage 而非 usageRaw，使箭头增长与 prompt 实际显示的节流计数对齐。
  const usageFlow = createTokenFlowPulse(usage)

  const [store, setStore] = createStore<{
    prompt: PromptInfo
    mode: "normal" | "shell"
    extmarkToPartIndex: Map<number, number>
    interrupt: number
    placeholder: number
  }>({
    placeholder: randomIndex(list().length),
    prompt: {
      input: "",
      parts: [],
    },
    mode: "normal",
    extmarkToPartIndex: new Map(),
    interrupt: 0,
  })

  createEffect(
    on(
      () => props.sessionID,
      () => {
        setStore("placeholder", randomIndex(list().length))
      },
      { defer: true },
    ),
  )

  // #243：耗时口径统一——运行中 footer 用 transcript 时间戳（parent user.created）+
  // 刷新时钟，重挂载/重连不重新起算
  // 时钟仅绑定 isRunning：idle 后停 tick，重进 busy 重新起 tick（口径边界不变）
  // voice recording 也需要刷新时钟，否则 footer 的录音时长会停在开始时刻。
  const now = createRefreshClock(() => isRunning() || voiceInputStatus().type === "recording")
  // busy 覆盖 starting/stopping/transcribing，避免用户在语音文本尚未落入 prompt 前提交旧草稿。
  const voiceInputBusy = createMemo(() => voiceInputStatus().type !== "idle")
  const voiceInputStatusText = createMemo(() =>
    // shortcut 来自 keymap；兜底值只影响展示，不注册额外 keybind。
    // #491/#505：compact 与 DialogPrompt / QuestionPrompt 统一 short profile；默认长文案留给兼容 consumer。
    PromptVoiceInput.voiceInputStatusText(voiceInputStatus(), voiceShortcut() || voiceShortcutFallback, now(), { compact: true }),
  )
  const voiceInput = PromptVoiceInput.createVoiceInputController({
    // controller 每次启动前读取当前配置，但录音开始后会固定 activeTranscriber，避免停止时后端漂移。
    transcriber: () => tuiConfig.voice?.transcriber,
    // recorder 单独放在 native 边界文件，Prompt 组件不直接加载 optional addon。
    startRecorder: PromptVoiceRecorder.startPromptVoiceRecorder,
    insertText: insertVoiceText,
    onStatus: setVoiceInputStatus,
    onError: (message) =>
      toast.show({
        message,
        variant: "error",
      }),
  })
  onCleanup(() => {
    // [语音退出清理] Prompt 卸载时不能留下仍占用麦克风的 Node 子进程；这里只 abort
    // 已开始的录音，不触发转写，也不改动用户当前草稿。
    void voiceInput.abort()
  })
  // activeDuration 派生自 now 信号：now 不变时 memo 不重算，tick 成本仅为一次比较
  const activeDuration = createMemo(() => {
    // 无 sessionID 时组件尚未绑定会话，耗时无意义；0 让 Show 直接隐藏 footer 计时
    if (!props.sessionID) return 0
    // messages 来自 sync 缓存：SSE 重连恢复后时间戳仍在，耗时天然连续
    return activeTurnDuration(sync.data.message[props.sessionID] ?? [], status(), now())
  })

  const promptCommands = createMemo(() =>
    [
      {
        title: "Clear prompt",
        name: "prompt.clear",
        category: "Prompt",
        hidden: true,
        run: () => {
          clearPrompt()
          dialog.clear()
        },
      },
      {
        title: "Submit prompt",
        name: "prompt.submit",
        category: "Prompt",
        hidden: true,
        run: async () => {
          if (!input.focused) return
          const handled = await submit()
          if (!handled) return

          dialog.clear()
        },
      },
      {
        title: "Remove editor context",
        name: "prompt.editor_context.clear",
        category: "Prompt",
        enabled: Boolean(editorContext()),
        run: () => {
          dismissEditorContext()
          dialog.clear()
        },
      },
      {
        title: "Paste",
        name: "prompt.paste",
        category: "Prompt",
        hidden: true,
        run: async (ctx: CommandContext<Renderable, KeyEvent>) => {
          ctx.event.preventDefault()
          ctx.event.stopPropagation()
          const content = await clipboard.read?.()
          if (content?.mime.startsWith("image/")) {
            await pasteAttachment({
              filename: "clipboard",
              mime: content.mime,
              content: content.data,
            })
            return
          }
          if (content?.mime === "text/plain") {
            await pasteInputText(content.data)
          }
        },
      },
      {
        title: "Interrupt session",
        name: "session.interrupt",
        category: "Session",
        hidden: true,
        // #151：sessionID 在场即可中断，不依赖可能过期的 busy status
        enabled: canInterruptSession(props.sessionID),
        run: () => {
          if (auto()?.visible) return
          if (!input.focused) return
          // TODO: this should be its own command
          if (store.mode === "shell") {
            setStore("mode", "normal")
            return
          }
          if (!props.sessionID) return

          // #151：advance 后 count 封顶 1；abort 后不立即清零，窗口内可重复 abort
          const interrupt = advanceInterruptCount(store.interrupt)
          setStore("interrupt", interrupt.count)

          setTimeout(() => {
            setStore("interrupt", 0)
          }, INTERRUPT_CONFIRMATION_MS)

          if (interrupt.abort) {
            void sdk.client.session.abort({
              sessionID: props.sessionID,
            })
          }
          dialog.clear()
        },
      },
      {
        title: "Open editor",
        category: "Session",
        name: "prompt.editor",
        slashName: "editor",
        run: async () => {
          dialog.clear()

          // replace summarized text parts with the actual text
          const text = store.prompt.parts
            .filter((p) => p.type === "text")
            .reduce((acc, p) => {
              if (!p.source) return acc
              return acc.replace(p.source.text.value, p.text)
            }, store.prompt.input)

          const nonTextParts = store.prompt.parts.filter((p) => p.type !== "text")

          const value = text
          const content = await openEditor({
            renderer,
            value,
            cwd:
              (project.instance.path().worktree === "/" ? undefined : project.instance.path().worktree) ||
              project.instance.directory() ||
              paths.cwd,
          })
          if (!content) return
          const normalized = normalizePromptContent(content)

          input.setText(normalized)

          // Update positions for nonTextParts based on their location in new content
          // Filter out parts whose virtual text was deleted
          // this handles a case where the user edits the text in the editor
          // such that the virtual text moves around or is deleted
          const updatedNonTextParts = nonTextParts
            .map((part) => {
              let virtualText = ""
              if (part.type === "file" && part.source?.text) {
                virtualText = part.source.text.value
              } else if (part.type === "agent" && part.source) {
                virtualText = part.source.value
              }

              if (!virtualText) return part

              const newStart = normalized.indexOf(virtualText)
              // if the virtual text is deleted, remove the part
              if (newStart === -1) return null

              // #247：Editor 回调给的是 JS 字符索引；part source 保存 Textarea offset，
              // 宽字符下两者不一致，必须用 promptOffsetWidth 转换后再恢复高亮。
              const start = promptOffsetWidth(normalized.slice(0, newStart))
              // #247：end 用同口径累加而非 promptOffsetWidth(normalized) 全量计算，
              // 避免占位符后缀里的宽字符影响本段边界
              const end = start + promptOffsetWidth(virtualText)

              if (part.type === "file" && part.source?.text) {
                return {
                  ...part,
                  source: {
                    ...part.source,
                    text: {
                      ...part.source.text,
                      start,
                      end,
                    },
                  },
                }
              }

              if (part.type === "agent" && part.source) {
                return {
                  ...part,
                  source: {
                    ...part.source,
                    start,
                    end,
                  },
                }
              }

              return part
            })
            .filter((part) => part !== null)

          setStore("prompt", {
            input: normalized,
            // keep only the non-text parts because the text parts were
            // already expanded inline
            parts: updatedNonTextParts,
          })
          restoreExtmarksFromParts(updatedNonTextParts)
          // #247：cursorOffset 用显示宽度口径——换行按 1 计，Bun.stringWidth 按 0 计；
          // 若与 source offsets 口径不一致，恢复后光标会落在占位符中间
          input.cursorOffset = promptOffsetWidth(normalized)
        },
      },
      {
        title: "Skills",
        name: "prompt.skills",
        category: "Prompt",
        slashName: "skills",
        run: () => {
          dialog.replace(() => (
            <DialogSkill
              onSelect={(skill) => {
                input.setText(`/${skill} `)
                setStore("prompt", {
                  input: `/${skill} `,
                  parts: [],
                })
                input.gotoBufferEnd()
              }}
            />
          ))
        },
      },
      {
        title: "Warp",
        desc: "Change the workspace for the session",
        name: "workspace.set",
        category: "Session",
        enabled: Flag.OPENCODE_EXPERIMENTAL_WORKSPACES,
        slashName: "warp",
        run: () => {
          workspace.open()
        },
      },
      {
        title: "Move session",
        desc: "Move to another project dir",
        name: "session.move",
        category: "Session",
        slashName: "move",
        run: () => {
          move.open()
        },
      },
    ].map((entry) => ({
      namespace: "palette",
      ...entry,
    })),
  )

  useBindings(() => ({
    commands: promptCommands(),
  }))

  useBindings(() => ({
    mode: OPENCODE_BASE_MODE,
    bindings: tuiConfig.keybinds.gather("prompt.palette", [
      "prompt.submit",
      "prompt.editor",
      "prompt.editor_context.clear",
      "prompt.stash",
      "prompt.stash.pop",
      "prompt.stash.list",
      "prompt.skills",
      "session.interrupt",
      "workspace.set",
      "session.move",
    ]),
  }))

  const ref: PromptRef = {
    get focused() {
      return input.focused
    },
    get current() {
      return store.prompt
    },
    focus() {
      input.focus()
    },
    blur() {
      input.blur()
    },
    set(prompt) {
      input.setText(prompt.input)
      setStore("prompt", prompt)
      // #192：还原草稿必须同时还原 mode，否则 shell 模式残留会让普通输入误走 /shell
      if (prompt.mode) { setStore("mode", prompt.mode) }
      restoreExtmarksFromParts(prompt.parts)
      input.gotoBufferEnd()
    },
    reset() {
      input.clear()
      input.extmarks.clear()
      setStore("prompt", {
        input: "",
        parts: [],
      })
      setStore("extmarkToPartIndex", new Map())
    },
    submit() {
      void submit()
    },
  }

  onMount(() => {
    const saved = stashed
    stashed = undefined
    if (store.prompt.input) return
    if (saved && saved.prompt.input) {
      input.setText(saved.prompt.input)
      setStore("prompt", saved.prompt)
      restoreExtmarksFromParts(saved.prompt.parts)
      input.cursorOffset = saved.cursor
    }
  })

  onCleanup(() => {
    if (store.prompt.input) {
      stashed = { prompt: unwrap(store.prompt), cursor: input.cursorOffset }
    }
    setInputTarget(undefined)
    props.ref?.(undefined)
  })

  createEffect(() => {
    if (!input || input.isDestroyed) return
    if (props.visible === false || dialog.stack.length > 0) {
      if (input.focused) input.blur()
      return
    }

    // Slot/plugin updates can remount the background prompt while a dialog is open.
    // Keep focus with the dialog and let the prompt reclaim it after the dialog closes.
    if (!input.focused) input.focus()
  })

  createEffect(() => {
    if (!input || input.isDestroyed) return
    input.traits = {
      ...input.traits,
      ...computePromptTraits({
        mode: store.mode,
        autocompleteVisible: !!auto()?.visible,
      }),
    }
  })

  function restoreExtmarksFromParts(parts: PromptInfo["parts"]) {
    input.extmarks.clear()
    setStore("extmarkToPartIndex", new Map())

    parts.forEach((part, partIndex) => {
      let start = 0
      let end = 0
      let virtualText = ""
      let styleId: number | undefined

      if (part.type === "file" && part.source?.text) {
        start = part.source.text.start
        end = part.source.text.end
        virtualText = part.source.text.value
        styleId = fileStyleId
      } else if (part.type === "agent" && part.source) {
        start = part.source.start
        end = part.source.end
        virtualText = part.source.value
        styleId = agentStyleId
      } else if (part.type === "text" && part.source?.text) {
        start = part.source.text.start
        end = part.source.text.end
        virtualText = part.source.text.value
        styleId = pasteStyleId
      }

      if (virtualText) {
        const extmarkId = input.extmarks.create({
          start,
          end,
          virtual: true,
          styleId,
          typeId: promptPartTypeId,
        })
        setStore("extmarkToPartIndex", (map: Map<number, number>) => {
          const newMap = new Map(map)
          newMap.set(extmarkId, partIndex)
          return newMap
        })
      }
    })
  }

  function syncExtmarksWithPromptParts() {
    const allExtmarks = input.extmarks.getAllForTypeId(promptPartTypeId)
    // #247：直接信任 extmark 坐标会把漂移同步回 parts——OpenTUI 按 JS 长度
    // 移动 extmark，中文/emoji 前插后坐标已不可靠，必须以可见文本重建。
    // 从 store 而非 produce draft 读取：漂移数据禁止进入写事务，
    // 重建完成前 store 保持上一个一致状态。
    const text = input.plainText
    const used: Array<{ start: number; end: number }> = []
    const parts: PromptInfo["parts"] = []

    for (const extmark of allExtmarks) {
      const partIndex = store.extmarkToPartIndex.get(extmark.id)
      if (partIndex === undefined) continue

      const part = store.prompt.parts[partIndex]
      if (!part) continue

      const virtualText = part.type === "agent" ? part.source?.value : part.source?.text?.value
      // #247：value 是用户可见的占位符文本（含方括号样式），而非底层文件路径——
      // 用它做 indexOf 才能命中编辑器里实际渲染的那段字符串
      if (!virtualText) continue

      // 以当前可见占位符文本为准重建 span：选距 extmark.start 最近且不重叠的出现位置，
      // 找不到则丢弃该 part，绝不把漂移坐标写回 store。
      let from = 0
      let best: { start: number; end: number; distance: number } | undefined
      // #247：同一占位符文本可能出现多次，used 数组保证已分配区间不重叠，
      // 距离最近的候选优先——extmark 只作为近似锚点参与排序，不参与坐标计算
      while (true) {
        const index = text.indexOf(virtualText, from)
        if (index === -1) break

        // #247：from 按 JS 索引推进（indexOf 语义），换算只在 span 边界处发生
        const start = promptOffsetWidth(text.slice(0, index))
        const end = start + promptOffsetWidth(virtualText)
        if (!used.some((span) => span.start < end && start < span.end)) {
          // #247：与漂移后的 extmark.start 比距离——extmark 是唯一可用的近似锚点
          const distance = Math.abs(start - extmark.start)
          if (!best || distance < best.distance) best = { start, end, distance }
        }

        from = index + virtualText.length
      }
      if (!best) continue
      // #247：丢弃无候选的 part 是刻意的——保留它会带着漂移坐标进入下一轮，
      // 而用户已删除的占位符本就不该继续占位

      used.push(best)
      // #247：agent part 的 source 顶层直接持有 start/end，与 file/text 的嵌套 text 形状不同
      if (part.type === "agent" && part.source) {
        parts.push({ ...part, source: { ...part.source, start: best.start, end: best.end } })
        continue
      }
      // #247：file part 保留 source 的其余字段（mime/path 等），只替换 text 的坐标
      if (part.type === "file" && part.source?.text) {
        parts.push({
          ...part,
          source: { ...part.source, text: { ...part.source.text, start: best.start, end: best.end } },
        })
        continue
      }
      if (part.type === "text" && part.source?.text) {
        // #247：text part 的 source 形状没有外层 source 字段，重建时直接换 text 键，
        // 其余 part 类型保持既有 source 结构展开
        parts.push({
          ...part,
          source: { text: { ...part.source.text, start: best.start, end: best.end } },
        })
      }
    }

    // #247：先替换 parts 再 restore extmarks——restore 以重建后的 offset 为准，
    // 顺序颠倒会把刚算好的坐标立即覆盖回漂移值
    setStore("prompt", "parts", parts)
    restoreExtmarksFromParts(parts)
  }

  const stashCommands = createMemo(() =>
    [
      {
        title: "Stash prompt",
        name: "prompt.stash",
        category: "Prompt",
        enabled: !!store.prompt.input,
        run: () => {
          if (!store.prompt.input) return
          stash.push({
            input: store.prompt.input,
            parts: store.prompt.parts,
          })
          input.extmarks.clear()
          input.clear()
          setStore("prompt", { input: "", parts: [] })
          setStore("extmarkToPartIndex", new Map())
          dialog.clear()
        },
      },
      {
        title: "Stash pop",
        name: "prompt.stash.pop",
        category: "Prompt",
        enabled: stash.list().length > 0,
        run: () => {
          const entry = stash.pop()
          if (entry) {
            input.setText(entry.input)
            setStore("prompt", { input: entry.input, parts: entry.parts })
            restoreExtmarksFromParts(entry.parts)
            input.gotoBufferEnd()
          }
          dialog.clear()
        },
      },
      {
        title: "Stash list",
        name: "prompt.stash.list",
        category: "Prompt",
        enabled: stash.list().length > 0,
        run: () => {
          dialog.replace(() => (
            <DialogStash
              onSelect={(entry) => {
                input.setText(entry.input)
                setStore("prompt", { input: entry.input, parts: entry.parts })
                restoreExtmarksFromParts(entry.parts)
                input.gotoBufferEnd()
              }}
            />
          ))
        },
      },
    ].map((entry) => ({
      namespace: "palette",
      ...entry,
    })),
  )

  useBindings(() => ({
    commands: stashCommands(),
  }))

  useBindings(() => {
    return {
      target: inputTarget,
      enabled: inputTarget() !== undefined && !props.disabled,
      bindings: tuiConfig.keybinds.get("prompt.paste"),
    }
  })

  useBindings(() => {
    return {
      target: inputTarget,
      enabled: inputTarget() !== undefined && !props.disabled && store.prompt.input !== "",
      bindings: tuiConfig.keybinds.get("prompt.clear"),
    }
  })

  useBindings(() => {
    return {
      target: inputTarget,
      enabled: (() => {
        cursorVersion()
        return (
          inputTarget() !== undefined &&
          !props.disabled &&
          store.mode === "normal" &&
          !auto()?.visible &&
          input?.visualCursor.offset === 0
        )
      })(),
      bindings: [
        {
          key: "!",
          desc: "Shell mode",
          group: "Prompt",
          cmd: () => {
            setStore("placeholder", randomIndex(shell().length))
            setStore("mode", "shell")
          },
        },
      ],
    }
  })

  useBindings(() => {
    return {
      target: inputTarget,
      enabled: inputTarget() !== undefined && store.mode === "shell",
      bindings: [{ key: "escape", desc: "Exit shell mode", group: "Prompt", cmd: () => setStore("mode", "normal") }],
    }
  })

  useBindings(() => {
    return {
      target: inputTarget,
      enabled: (() => {
        cursorVersion()
        return inputTarget() !== undefined && store.mode === "shell" && input?.visualCursor.offset === 0
      })(),
      bindings: [{ key: "backspace", desc: "Exit shell mode", group: "Prompt", cmd: () => setStore("mode", "normal") }],
    }
  })

  useBindings(() => {
    return {
      target: inputTarget,
      enabled: (() => {
        cursorVersion()
        return inputTarget() !== undefined && !props.disabled && !auto()?.visible && input !== undefined
      })(),
      commands: [
        {
          name: "prompt.history.previous",
          title: "Previous prompt history",
          category: "Prompt",
          run() {
            if (input.cursorOffset !== 0) {
              if (input.scrollY + input.visualCursor.visualRow === 0) input.cursorOffset = 0
              return false
            }

            const item = history.move(-1, input.plainText)
            if (!item) return false
            input.setText(item.input)
            setStore("prompt", item)
            setStore("mode", item.mode ?? "normal")
            restoreExtmarksFromParts(item.parts)
            input.cursorOffset = 0
          },
        },
      ],
      bindings: tuiConfig.keybinds.get("prompt.history.previous"),
    }
  })

  useBindings(() => {
    return {
      target: inputTarget,
      enabled: (() => {
        cursorVersion()
        return inputTarget() !== undefined && !props.disabled && !auto()?.visible && input !== undefined
      })(),
      commands: [
        {
          name: "prompt.history.next",
          title: "Next prompt history",
          category: "Prompt",
          run() {
            if (input.cursorOffset !== input.plainText.length) {
              if (
                input.scrollY + input.visualCursor.visualRow ===
                Math.max(0, input.editorView.getTotalVirtualLineCount() - 1)
              )
                input.cursorOffset = input.plainText.length
              return false
            }

            const item = history.move(1, input.plainText)
            if (!item) return false
            input.setText(item.input)
            setStore("prompt", item)
            setStore("mode", item.mode ?? "normal")
            restoreExtmarksFromParts(item.parts)
            input.cursorOffset = input.plainText.length
          },
        },
      ],
      bindings: tuiConfig.keybinds.get("prompt.history.next"),
    }
  })

  useBindings(() => {
    return {
      target: inputTarget,
      enabled:
        inputTarget() !== undefined &&
        !props.disabled &&
        !auto()?.visible &&
        !dialog.stack.length,
      // [local-smark] 流式期间也允许发起/停止/取消录音：录音不写 prompt，转写文本落盘前由 submitInner 的
      // voiceInputBusy 提交保护拦截，不会与 assistant 输出竞争 prompt；仅保留对话框/autocomplete/disabled 通用约束。
      commands: [
        {
          name: "prompt.voice.toggle",
          title: "Toggle voice input",
          category: "Prompt",
          run() {
            void voiceInput.toggle()
            return true
          },
        },
      ],
      bindings: tuiConfig.keybinds.get("prompt.voice.toggle"),
    }
  })

  let submitting = false
  async function submit() {
    // Prevent overlapping invocations (e.g. a double-pressed Enter, or the
    // input's native onSubmit racing another dispatch). Without this guard,
    // a second call slips past the empty-input check before the first call
    // clears `store.prompt.input`, then awaits its own `session.create` and
    // ultimately reads the now-empty store — sending a phantom empty prompt
    // to a freshly created session.
    if (submitting) return false
    submitting = true
    try {
      return await submitInner()
    } finally {
      submitting = false
    }
  }

  async function submitInner() {
    workspace.clearNotice()

    // IME: double-defer may fire before onContentChange flushes the last
    // composed character (e.g. Korean hangul) to the store, so read
    // plainText directly and sync before any downstream reads.
    if (input && !input.isDestroyed && input.plainText !== store.prompt.input) {
      setStore("prompt", "input", input.plainText)
      syncExtmarksWithPromptParts()
    }
    if (props.disabled) return false
    // [语音提交边界] 正在录音、保存或转写时禁止发送 prompt；否则 Enter 会把尚未插入的旧草稿提交出去。
    if (voiceInputBusy()) return false
    if (workspace.creating() || move.creating()) return false
    if (auto()?.visible) return false
    if (!store.prompt.input) return false
    const agent = local.agent.current()
    if (!agent) return false
    const trimmed = store.prompt.input.trim()
    if (trimmed === "exit" || trimmed === "quit" || trimmed === ":q") {
      void exit()
      return true
    }
    const selectedModel = local.model.current()
    if (!selectedModel) {
      void promptModelWarning()
      return false
    }

    const workspaceSession = props.sessionID ? sync.session.get(props.sessionID) : undefined
    const workspaceID = workspaceSession?.workspaceID
    const workspaceStatus = workspaceID ? (project.workspace.status(workspaceID) ?? "error") : undefined
    if (props.sessionID && workspaceID && workspaceStatus !== "connected") {
      dialog.replace(() => (
        <DialogWorkspaceUnavailable
          onRestore={() => {
            workspace.open()
            return false
          }}
        />
      ))
      return false
    }

    const variant = local.model.variant.current()
    let sessionID = props.sessionID
    let finishMoveProgress = false
    if (sessionID == null) {
      const selectedWorkspace = workspace.selection()
      const workspaceID = selectedWorkspace?.type === "existing" ? selectedWorkspace.workspaceID : undefined

      const directory = await move.getDirectory(store.prompt.input)
      if (move.pending() && !directory) return false
      finishMoveProgress = Boolean(move.progress())

      const res = await sdk.client.session.create({
        directory,
        workspace: workspaceID,
        agent: agent.name,
        model: {
          providerID: selectedModel.providerID,
          id: selectedModel.modelID,
          variant,
        },
      })

      if (res.error) {
        if (finishMoveProgress) move.finishSubmit()
        console.log("Creating a session failed:", res.error)

        toast.show({
          message: "Creating a session failed. Open console for more details.",
          variant: "error",
        })

        return true
      }

      sessionID = res.data.id
    }

    const inputText = expandTrackedPastedText(
      store.prompt.input,
      input.extmarks.getAllForTypeId(promptPartTypeId).flatMap((extmark) => {
        const partIndex = store.extmarkToPartIndex.get(extmark.id)
        const part = partIndex === undefined ? undefined : store.prompt.parts[partIndex]
        if (part?.type !== "text") return []
        return [{ start: extmark.start, end: extmark.end, text: part.text }]
      }),
    )

    // Filter out text parts (pasted content) since they're now expanded inline
    const nonTextParts = store.prompt.parts.filter((part) => part.type !== "text")

    // Capture mode before it gets reset
    const currentMode = store.mode
    const editorSelection = editorContext()
    const editorParts =
      editorSelection && editor.labelState() === "pending"
        ? [
            {
              type: "text" as const,
              text: formatEditorContext(editorSelection),
              synthetic: true,
              metadata: {
                kind: "editor_context",
                source: editorSelection.source ?? "editor",
                filePath: editorSelection.filePath,
                ranges: editorSelection.ranges,
              },
            },
          ]
        : []

    // #192：draft 保留——提交失败时恢复输入
    // #192：新会话跳转可取消——后台失败时不跳转
    let newSessionNavigation: ReturnType<typeof setTimeout> | undefined
    let cancelNewSessionNavigation = false

    function showSubmitFailureToast() {
      toast.show({ message: "Sending prompt failed. Your draft was kept.", variant: "error" })
    }
    // #192：move 状态与 draft 一起还原，保证失败后 UI 回到提交前形态
    function keepDraftAfterSubmitFailure() {
      showSubmitFailureToast()
      if (finishMoveProgress) move.finishSubmit()
      return false
    }
    // #192：shell/command 后台失败时恢复 draft
      // #192：shell/command 无接受回执，失败只能靠恢复草稿兜底，且不覆盖用户新输入
    function restoreDraftAfterBackgroundFailure(prompt: typeof store.prompt, mode: typeof currentMode) {
      // #192：后台请求迟到失败不得覆盖用户已输入的新内容，仅空 draft 时恢复
      showSubmitFailureToast()
      cancelNewSessionNavigation = true
      if (newSessionNavigation) clearTimeout(newSessionNavigation)
      if (store.prompt.input || store.prompt.parts.length > 0) return
      // #192：复用 set 同步输入框与附件标记，避免再次提交时把恢复的草稿同步为空。
      ref.set({ ...prompt, mode })
    }

    if (store.mode === "shell") {
      move.startSubmit()
      // #192：快照仅用于失败恢复，成功路径直接清空输入，两条路径互斥——后台调用无法 await
      const submitted = { input: store.prompt.input, parts: store.prompt.parts }
      void sdk.client.session
        .shell({
          sessionID,
          agent: agent.name,
          model: { providerID: selectedModel.providerID, modelID: selectedModel.modelID },
          command: inputText,
        })
        .then((response) => { if (response.error) restoreDraftAfterBackgroundFailure(submitted, currentMode) })
        .catch(() => restoreDraftAfterBackgroundFailure(submitted, currentMode))
      setStore("mode", "normal")
    } else if (
      // #0503：local Goal 控制面优先于 server template slash：避免未来同名 command 误进 LLM
      parseGoalSlashInput(inputText) !== undefined
    ) {
      // #0503：sessionID 是 submit 头部 create 后的权威值——home 提交 /goal 也能命中正确实例
      const intent = parseGoalSlashInput(inputText)!
      // #0503：失败 early-return 保留草稿；成功 fall-through 共享尾（含 home navigate，INV-11）
      const ok = await executeGoalSlashIntent({
        intent,
        sessionID,
        sdkUrl: sdk.url,
        directory: sync.path.directory || sdk.directory,
        fetch: (input, init) => sdk.fetch(input, init),
        onError: (message) => toast.show({ message, variant: "error" }),
        onReconcile: (goal) => {
          // #0503：Schema optional tokenBudget/reason 与 TUI store 必填 null 的窄化对齐
          sync.goal.reconcile(sessionID, {
            ...goal,
            tokenBudget: goal.tokenBudget ?? null,
            reason: goal.reason ?? null,
          })
        },
        openDialog: (hasGoal) => {
          openGoalDialog({
            sessionID,
            hasGoal,
            replace: (view) => dialog.replace(view),
          })
        },
        // #0503：hasGoal 在提交时读取快照——零参数 dialog 的菜单/编辑分支由此决定
        hasGoal: !!sync.data.session_goal[sessionID],
      })
      // #0503：失败 return false——上层 stopPropagation 语义保持，草稿仍在输入框
      if (!ok) return false
    } else if (
      inputText.startsWith("/") &&
      sync.data.command.some((x) => x.name === inputText.split("\n")[0].split(" ")[0].slice(1))
    ) {
      move.startSubmit()
      // Parse command from first line, preserve multi-line content in arguments
      const firstLineEnd = inputText.indexOf("\n")
      const firstLine = firstLineEnd === -1 ? inputText : inputText.slice(0, firstLineEnd)
      const [command, ...firstLineArgs] = firstLine.split(" ")
      const restOfInput = firstLineEnd === -1 ? "" : inputText.slice(firstLineEnd + 1)
      const args = firstLineArgs.join(" ") + (restOfInput ? "\n" + restOfInput : "")

      // #192：draft 快照在失败路径被还原，是后台失败时的唯一恢复来源
      const submitted = { input: store.prompt.input, parts: store.prompt.parts }
      void sdk.client.session
        .command({
          sessionID,
          command: command.slice(1),
          arguments: args,
          agent: agent.name,
          model: `${selectedModel.providerID}/${selectedModel.modelID}`,
          variant,
          parts: nonTextParts.filter((x) => x.type === "file"),
        })
        .then((response) => { if (response.error) restoreDraftAfterBackgroundFailure(submitted, currentMode) })
        .catch(() => restoreDraftAfterBackgroundFailure(submitted, currentMode))
    } else {
      move.startSubmit()
      // #192：promptAsync 替代 prompt+throwOnError——daemon 确认接收后才清 draft
        // #192：response.error 表示 daemon 未接受，保留 draft 并终止提交流程
      const response = await sdk.client.session
        .promptAsync({
          sessionID,
          ...selectedModel,
          agent: agent.name,
          model: selectedModel,
          variant,
          parts: [
            ...editorParts,
            { type: "text", text: inputText },
            ...nonTextParts,
          ],
        })
        .catch((error) => ({ error }))
      // #192：promptAsync 的 error 信封是 daemon 拒绝的信号，与本地异常同等处理
      if (response.error) return keepDraftAfterSubmitFailure()
      if (editorParts.length > 0) editor.markSelectionSent()
    }
    history.append({
      ...store.prompt,
      mode: currentMode,
    })
    // #0503：await 的 control 路径（如 /goal HTTP）返回时 textarea 可能已销毁；清草稿以 store 为准
    if (input && !input.isDestroyed) {
      input.extmarks.clear()
    }
    setStore("prompt", {
      input: "",
      parts: [],
    })
    setStore("extmarkToPartIndex", new Map())
    props.onSubmit?.()

    // temporary hack to make sure the message is sent
    if (!props.sessionID) {
      if (editorParts.length > 0) editor.preserveSelectionFromNewSession()
      // #192：后台失败时取消跳转，避免进入空会话丢失输入
      newSessionNavigation = setTimeout(() => {
        if (cancelNewSessionNavigation) return
        route.navigate({ type: "session", sessionID })
      }, 50)
    }
    // #0503：同上——销毁后的 clear 调用会在旧 renderer 上复活幽灵状态
    if (input && !input.isDestroyed) {
      input.clear()
    }
    if (finishMoveProgress) move.finishSubmit()
    return true
  }

  function pasteText(text: string, virtualText: string) {
    const currentOffset = input.cursorOffset
    const extmarkStart = currentOffset
    const extmarkEnd = extmarkStart + promptOffsetWidth(virtualText)

    input.insertText(virtualText + " ")

    const extmarkId = input.extmarks.create({
      start: extmarkStart,
      end: extmarkEnd,
      virtual: true,
      styleId: pasteStyleId,
      typeId: promptPartTypeId,
    })

    setStore(
      produce((draft) => {
        const partIndex = draft.prompt.parts.length
        draft.prompt.parts.push({
          type: "text" as const,
          text,
          source: {
            text: {
              start: extmarkStart,
              end: extmarkEnd,
              value: virtualText,
            },
          },
        })
        draft.extmarkToPartIndex.set(extmarkId, partIndex)
      }),
    )
  }

  async function pasteInputText(text: string) {
    const normalizedText = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n")
    const pastedContent = normalizedText.trim()
    const filepath = pastedFilepath(pastedContent, terminalEnvironment.platform)
    const isUrl = /^(https?):\/\//.test(filepath)
    if (!isUrl) {
      const attachment = await readLocalAttachment(filepath)
      const filename = path.basename(filepath)
      if (attachment?.type === "text") {
        pasteText(attachment.content, `[SVG: ${filename ?? "image"}]`)
        return
      }
      if (attachment?.type === "binary") {
        await pasteAttachment({
          filename,
          filepath,
          mime: attachment.mime,
          content: Buffer.from(attachment.content).toString("base64"),
        })
        return
      }
    }

    const lineCount = (pastedContent.match(/\n/g)?.length ?? 0) + 1
    if (
      (lineCount >= 3 || pastedContent.length > 150) &&
      kv.get("paste_summary_enabled", !sync.data.config.experimental?.disable_paste_summary)
    ) {
      pasteText(pastedContent, `[Pasted ~${lineCount} lines]`)
      return
    }

    input.insertText(normalizedText)

    setTimeout(() => {
      if (!input || input.isDestroyed) return
      input.getLayoutNode().markDirty()
      renderer.requestRender()
    }, 0)
  }

  async function pasteAttachment(file: { filename?: string; filepath?: string; content: string; mime: string }) {
    const currentOffset = input.cursorOffset
    const extmarkStart = currentOffset
    const pdf = file.mime === "application/pdf"
    const count = store.prompt.parts.filter((x) => {
      if (x.type !== "file") return false
      if (pdf) return x.mime === "application/pdf"
      return x.mime.startsWith("image/")
    }).length
    const virtualText = pdf ? `[PDF ${count + 1}]` : `[Image ${count + 1}]`
    // extmark 偏移使用显示宽度而非字符串长度，确保非 ASCII 内容坐标正确
    const extmarkEnd = extmarkStart + promptOffsetWidth(virtualText)
    const textToInsert = virtualText + " "

    input.insertText(textToInsert)

    const extmarkId = input.extmarks.create({
      start: extmarkStart,
      end: extmarkEnd,
      virtual: true,
      styleId: pasteStyleId,
      typeId: promptPartTypeId,
    })

    const part: Omit<FilePart, "id" | "messageID" | "sessionID"> = {
      type: "file" as const,
      mime: file.mime,
      filename: file.filename,
      url: `data:${file.mime};base64,${file.content}`,
      source: {
        type: "file",
        path: file.filepath ?? file.filename ?? "",
        text: {
          start: extmarkStart,
          end: extmarkEnd,
          value: virtualText,
        },
      },
    }
    setStore(
      produce((draft) => {
        const partIndex = draft.prompt.parts.length
        draft.prompt.parts.push(part)
        draft.extmarkToPartIndex.set(extmarkId, partIndex)
      }),
    )
    return
  }

  function insertVoiceText(text: string) {
    if (!input || input.isDestroyed) return
    // insertText 保持当前光标位置语义：语音转写结果像用户手动输入一样进入 textarea。
    input.insertText(text)
    // 写入 renderable 后立即同步 store/extmarks，否则后续 submit 会读到插入前的旧 prompt。
    setStore("prompt", "input", input.plainText)
    syncExtmarksWithPromptParts()
    // cursorVersion 触发现有光标同步链路，不为语音输入新增独立光标状态。
    setCursorVersion((value) => value + 1)

    setTimeout(() => {
      if (!input || input.isDestroyed) return
      // OpenTUI textarea 的布局在插入后需要下一 tick 标脏，避免转写文本显示滞后一帧。
      input.getLayoutNode().markDirty()
      renderer.requestRender()
    }, 0)
  }

  function clearPrompt() {
    if (store.prompt.input.trim().length >= DRAFT_RETENTION_MIN_CHARS || store.prompt.parts.length > 0) {
      history.append({
        ...store.prompt,
        mode: store.mode,
      })
    }
    input.clear()
    input.extmarks.clear()
    setStore("prompt", {
      input: "",
      parts: [],
    })
    setStore("extmarkToPartIndex", new Map())
  }

  const highlight = createMemo(() => {
    if (leader()) return theme.border
    if (store.mode === "shell") return theme.primary
    const agent = local.agent.current()
    if (!agent) return theme.border
    return local.agent.color(agent.name)
  })

  const showVariant = createMemo(() => {
    const variants = local.model.variant.list()
    if (variants.length === 0) return false
    const current = local.model.variant.current()
    return !!current
  })

  const agentMetaAlpha = createFadeIn(() => !!local.agent.current(), animationsEnabled)
  const modelMetaAlpha = createFadeIn(() => !!local.agent.current() && store.mode === "normal", animationsEnabled)
  const variantMetaAlpha = createFadeIn(
    () => !!local.agent.current() && store.mode === "normal" && showVariant(),
    animationsEnabled,
  )
  const borderHighlight = createMemo(() => tint(theme.border, highlight(), agentMetaAlpha()))

  const placeholderText = createMemo(() => {
    if (props.showPlaceholder === false) return undefined
    if (store.mode === "shell") {
      if (!shell().length) return undefined
      const example = shell()[store.placeholder % shell().length]
      return `Run a command… "${example}"`
    }
    if (!list().length) return undefined
    return `Ask anything… "${list()[store.placeholder % list().length]}"`
  })

  const spinnerDef = createMemo(() => {
    const agent =
      status().type !== "idle"
        ? (local.agent.list().find((a) => a.name === lastUserMessage()?.agent) ?? local.agent.current())
        : local.agent.current()
    const color = agent ? local.agent.color(agent.name) : theme.border
    return {
      frames: createFrames({
        color,
        style: "blocks",
        inactiveFactor: 0.6,
        // enableFading: false,
        minAlpha: 0.3,
      }),
      color: createColors({
        color,
        style: "blocks",
        inactiveFactor: 0.6,
        // enableFading: false,
        minAlpha: 0.3,
      }),
    }
  })
  const maxHeight = createMemo(() => tuiConfig.prompt?.max_height ?? Math.max(6, Math.floor(dimensions().height / 3)))
  const moveLabelWidth = createMemo(() => Math.max(12, Math.min(44, dimensions().width - 48)))

  function syncPromptWidth(this: BoxRenderable) {
    // #189：renderBefore 读取 flex 后最终宽度，避免只看终端列数
    // #189：宽度未变则跳过 setStore，减少无意义重渲染
    const width = Math.max(1, this.width)
    if (width === untrack(promptWidth)) return
    setPromptWidth(width)
  }

  return (
    <>
      <box ref={(r: BoxRenderable) => (anchor = r)} visible={props.visible !== false} width="100%" renderBefore={syncPromptWidth}>
        <box
          width="100%"
          border={["left"]}
          borderColor={borderHighlight()}
          customBorderChars={{
            ...SplitBorder.customBorderChars,
            bottomLeft: "╹",
          }}
        >
          <box
            paddingLeft={2}
            paddingRight={2}
            paddingTop={1}
            flexShrink={0}
            backgroundColor={theme.backgroundElement}
            flexGrow={1}
            width="100%"
          >
            <textarea
              width="100%"
              placeholder={placeholderText()}
              placeholderColor={theme.textMuted}
              textColor={leader() ? theme.textMuted : theme.text}
              focusedTextColor={leader() ? theme.textMuted : theme.text}
              minHeight={1}
              maxHeight={maxHeight()}
              onContentChange={() => {
                const value = input.plainText
                setStore("prompt", "input", value)
                auto()?.onInput(value)
                syncExtmarksWithPromptParts()
                setCursorVersion((value) => value + 1)
              }}
              onCursorChange={() => setCursorVersion((value) => value + 1)}
              onKeyDown={(e: { preventDefault(): void }) => {
                if (props.disabled) {
                  e.preventDefault()
                  return
                }
              }}
              onSubmit={() => {
                // IME: double-defer so the last composed character (e.g. Korean
                // hangul) is flushed to plainText before we read it for submission.
                setTimeout(() => setTimeout(() => submit(), 0), 0)
              }}
              onPaste={async (event: PasteEvent) => {
                if (props.disabled) {
                  event.preventDefault()
                  return
                }

                // Normalize line endings at the boundary
                // Windows ConPTY/Terminal often sends CR-only newlines in bracketed paste
                // Replace CRLF first, then any remaining CR
                const normalizedText = decodePasteBytes(event.bytes).replace(/\r\n/g, "\n").replace(/\r/g, "\n")
                const pastedContent = normalizedText.trim()

                // Windows Terminal <1.25 can surface image-only clipboard as an
                // empty bracketed paste. Windows Terminal 1.25+ does not.
                if (!pastedContent) {
                  keymap.dispatchCommand("prompt.paste")
                  return
                }

                // Once we cross an async boundary below, the terminal may perform its
                // default paste unless we suppress it first and handle insertion ourselves.
                event.preventDefault()

                await pasteInputText(normalizedText)
              }}
              ref={(r: TextareaRenderable) => {
                input = r
                Object.assign(r, {
                  getClipboardText: (text: string) => expandPastedTextPlaceholders(text, store.prompt.parts),
                })
                setInputTarget(r)
                if (promptPartTypeId === 0) {
                  promptPartTypeId = input.extmarks.registerType("prompt-part")
                }
                props.ref?.(ref)
                setTimeout(() => {
                  // setTimeout is a workaround and needs to be addressed properly
                  if (!input || input.isDestroyed) return
                  input.cursorColor = theme.text
                  if (tuiConfig.cursor) input.cursorStyle = tuiConfig.cursor
                }, 0)
              }}
              onMouseDown={(r: MouseEvent) => r.target?.focus()}
              focusedBackgroundColor={theme.backgroundElement}
              cursorColor={props.disabled ? theme.backgroundElement : theme.text}
              cursorStyle={tuiConfig.cursor}
              syntaxStyle={syntax()}
            />
            <box flexDirection="row" flexShrink={0} paddingTop={1} gap={1} justifyContent="space-between">
              <box flexDirection="row" gap={1}>
                <Show when={local.agent.current()} fallback={<box height={1} />}>
                  {(agent) => (
                    <>
                      <text fg={fadeColor(highlight(), agentMetaAlpha())}>
                        {store.mode === "shell" ? "Shell" : Locale.titlecase(agent().name)}
                      </text>
                      <Show when={store.mode === "normal" && local.permission.mode === "auto"}>
                        <text fg={fadeColor(theme.textMuted, agentMetaAlpha())}>auto</text>
                      </Show>
                      <Show when={store.mode === "normal"}>
                        <box flexDirection="row" gap={1}>
                          <text fg={fadeColor(theme.textMuted, modelMetaAlpha())}>·</text>
                          <text
                            flexShrink={0}
                            fg={fadeColor(leader() ? theme.textMuted : theme.text, modelMetaAlpha())}
                          >
                            {local.model.parsed().model}
                          </text>
                          <text fg={fadeColor(theme.textMuted, modelMetaAlpha())}>{currentProviderLabel()}</text>
                          <Show when={showVariant()}>
                            <text fg={fadeColor(theme.textMuted, variantMetaAlpha())}>·</text>
                            <text>
                              <span style={{ fg: fadeColor(theme.warning, variantMetaAlpha()), bold: true }}>
                                {local.model.variant.current()}
                              </span>
                            </text>
                          </Show>
                        </box>
                      </Show>
                    </>
                  )}
                </Show>
              </box>
              <Show when={hasRightContent()}>
                <box flexDirection="row" gap={1} alignItems="center">
                  {props.right}
                </box>
              </Show>
            </box>
          </box>
        </box>
        <box
          height={1}
          border={["left"]}
          borderColor={borderHighlight()}
          customBorderChars={{
            ...EmptyBorder,
            vertical: theme.backgroundElement.a !== 0 ? "╹" : " ",
          }}
        >
          <box
            height={1}
            border={["bottom"]}
            borderColor={theme.backgroundElement}
            customBorderChars={
              theme.backgroundElement.a !== 0
                ? {
                    ...EmptyBorder,
                    horizontal: "▀",
                  }
                : {
                    ...EmptyBorder,
                    horizontal: " ",
                  }
            }
          />
        </box>
        {/* #491：单行外框契约——retry 态由内层 flex 收缩接管，其余状态保持左右分布。 */}
        <box width="100%" height={1} minWidth={0} flexDirection="row" alignItems="center" justifyContent="space-between" gap={1} overflow="hidden">
          <Switch>
            <Match when={voiceInputBusy()}>
              {/* 语音状态和停止快捷键不参与收缩，文件身份与普通 chrome 先让出宽度。 */}
              <box height={1} paddingLeft={3} flexShrink={0} flexDirection="row" alignItems="center" gap={1}>
                {/* 录音中显示红点，保存/转写阶段显示 spinner，让用户区分“仍在收音”和“正在处理”。 */}
                <Show when={voiceInputStatus().type === "recording"} fallback={<Spinner color={theme.accent} />}>
                  <text fg={theme.error}>●</text>
                </Show>
                <text fg={theme.accent} wrapMode="none">
                  {/* #491：语音态文本同样不可换行，避免窄终端把状态行挤成多行。 */}
                  {voiceInputStatusText()}
                </text>
              </box>
            </Match>
            <Match when={isRunning()}>
              {/* #491：running 行允许消息区域降到零宽，保证 interrupt 不会被长错误反向挤出。 */}
              <box flexDirection="row" gap={1} flexGrow={1} minWidth={0} height={1} overflow="hidden" alignItems="center" justifyContent="flex-start">
                <box marginLeft={1} flexShrink={0}>
                  {/* #491：spinner 是运行态的锚定视觉，不参与收缩竞争，防止长错误把它挤出可视区。 */}
                  <Show when={kv.get("animations_enabled", true)} fallback={<text fg={theme.textMuted}>[⋯]</text>}>
                    <spinner color={spinnerDef().color} frames={spinnerDef().frames} interval={40} />
                  </Show>
                </box>
                {(() => {
                  const retry = createMemo(() => {
                    const s = status()
                    if (s.type !== "retry") return
                    return s
                  })
                  const message = createMemo(() => {
                    const r = retry()
                    if (!r) return
                    if (r.message.includes("exceeded your current quota") && r.message.includes("gemini"))
                      return "gemini is way too hot right now"
                    // #491：footer 摘要压平空白即可，原始 message 仍原样交给详情对话框。
                    return r.message.replace(/\s+/g, " ").trim()
                  })
                  // retry 倒计时与耗时显示共享同一 now，两个 UI 不各自持表
                  const seconds = createMemo(() => {
                    const next = retry()?.next
                    // 倒计时复用 UI refresh clock，不另建 interval；保留毫秒差经 Math.round 换算秒的既有口径。
                    return next ? Math.round((next - now()) / 1000) : 0
                  })
                  const handleMessageClick = () => {
                    const r = retry()
                    if (!r) return
                    // #491：details 对所有 retry 都稳定可用，避免 80/120 两套阈值制造不可展开区间。
                    void DialogAlert.show(dialog, "Retry Error", r.message)
                  }

                  const retryInfo = () => {
                    const r = retry()
                    if (!r) return ""
                    // #491：retry 元数据独立于摘要段，固定渲染让用户始终能看到第几次重试。
                    const duration = formatDuration(seconds())
                    return duration ? `retry in ${duration} · #${r.attempt}` : `retry · #${r.attempt}`
                  }

                  return (
                    <Show when={retry()}>
                      {/* #505：外层组可伸展以承接剩余宽度，但摘要文本本身不 grow，避免短错误与 (details) 被拉开。 */}
                      <box minWidth={0} flexBasis={0} flexGrow={1} flexShrink={1} flexDirection="row" gap={1} overflow="hidden">
                        <box minWidth={0} flexShrink={1} flexDirection="row" gap={1} overflow="hidden" onMouseUp={handleMessageClick}>
                          {/* OpenTUI 命中的子 text 不可靠冒泡到 box；可见摘要本身也必须承接详情点击。 */}
                          {/* #505：content-based shrinkable——minWidth=0+flexShrink，禁止 flexBasis=0 把短文压成零宽。 */}
                          <text minWidth={0} flexShrink={1} fg={theme.error} wrapMode="none" truncate onMouseUp={handleMessageClick}>
                            {message()}
                          </text>
                          {/* #505：括号化红色入口与错误同色，既短又保持“属于诊断”的视觉归属。 */}
                          <text flexShrink={0} fg={theme.error} wrapMode="none" onMouseUp={handleMessageClick}>
                            (details)
                          </text>
                        </box>
                        <text flexShrink={0} fg={theme.error} wrapMode="none">
                          {retryInfo()}
                        </text>
                      </box>
                    </Show>
                  )
                })()}
                {/* #491：interrupt 和活跃时长是运行态的固定操作反馈，不参与错误摘要的收缩竞争。 */}
                <box height={1} flexShrink={0} flexDirection="row" alignItems="center" gap={1}>
                  <text fg={store.interrupt > 0 ? theme.primary : theme.text} wrapMode="none">
                    esc{" "}
                    <span style={{ fg: store.interrupt > 0 ? theme.primary : theme.textMuted }}>
                      {store.interrupt > 0 ? "again to interrupt" : "interrupt"}
                    </span>
                  </text>
                  {/* 同一运行区在 retry 时仍可见，正秒数才占用 footer 的横向空间。 */}
                  <Show when={activeDuration() > 0}>
                    {/* 0 值隐藏：会话尚未产生任何 assistant 消息时不占 footer 空间 */}
                    <text fg={theme.textMuted} wrapMode="none">
                      {"· "}
                      <span style={{ fg: theme.text }}>{Locale.durationClock(activeDuration())}</span>
                    </text>
                  </Show>
                </box>
              </box>
            </Match>
            <Match when={workspace.notice()}>
              {(notice) => (
                <box paddingLeft={3}>
                  <text fg={theme.accent}>{notice()}</text>
                </box>
              )}
            </Match>
            <Match when={workspace.label()}>
              {(label) => (
                <box paddingLeft={3} flexDirection="row" gap={1}>
                  <Show when={workspace.creating()}>
                    <Spinner color={theme.accent} />
                  </Show>
                  <text fg={workspace.creating() ? theme.accent : theme.text}>
                    {(() => {
                      const item = label()
                      if (item.type === "new") {
                        if (workspace.creating())
                          return `Creating ${item.workspaceType}${".".repeat(workspace.creatingDots())}`
                        return (
                          <>
                            Workspace <span style={{ fg: theme.textMuted }}>(new {item.workspaceType})</span>
                          </>
                        )
                      }
                      return (
                        <>
                          Workspace <span style={{ fg: theme.textMuted }}>{item.workspaceName}</span>
                        </>
                      )
                    })()}
                  </text>
                </box>
              )}
            </Match>
            <Match when={move.progress()}>
              {(progress) => (
                <box paddingLeft={3}>
                  <Spinner color={theme.accent}>
                    {progress()}
                    <span style={{ fg: theme.textMuted }}>{".".repeat(move.creatingDots())}</span>
                  </Spinner>
                </box>
              )}
            </Match>
            <Match when={move.pendingNew()}>
              <box paddingLeft={3}>
                <text fg={theme.accent}>(new working copy)</text>
              </box>
            </Match>
            <Match when={true}>
              {props.hint ?? (
                <Show when={props.sessionID} fallback={<text />}>
                  <box marginLeft={1}>
                    <text fg={theme.textMuted}>{location()?.directory ?? paths.cwd}</text>
                  </box>
                </Show>
              )}
            </Match>
          </Switch>
          {/* #491：retry 已在左侧承载完整 P0 链；其他状态才分配文件身份与普通快捷键区域。 */}
          {/* #491：右侧区域 height=1 + overflow hidden 是双保险；真正防换行靠子元素 wrapMode=none。 */}
          <Show when={status().type !== "retry"}>
            <box height={1} minWidth={0} flexShrink={1} gap={2} flexDirection="row" alignItems="center" overflow="hidden">
              <Show when={editorContextLabelState() !== "none" ? editorFileLabelDisplay() : undefined}>
                {(file) => (
                  // #491：文件身份保留可辨识后缀，但仍先于不可换行的操作提示收缩。
                  <text minWidth={0} flexShrink={1} fg={editorContextLabelState() === "pending" ? theme.secondary : theme.textMuted} wrapMode="none" truncate>
                    {file()}
                  </text>
                )}
              </Show>
              <Switch>
                <Match when={store.mode === "normal"}>
                  <Switch>
                    <Match when={usage()}>
                      {(item) => (
                        <Show
                          when={showSplitFlow()}
                          fallback={
                            // #125：窄屏合并 ↑↓，只保留 context/cost
                            <text fg={theme.textMuted} wrapMode="none">
                              <span style={{ fg: usageFlow().input || usageFlow().output ? theme.text : theme.textMuted }}>↑↓</span>
                              {item().context ? ` ${item().context}` : ""}
                              {item().cost ? ` · ${item().cost}` : ""}
                            </text>
                          }
                        >
                          <text fg={theme.textMuted} wrapMode="none">
                            {/* 只移除重复累计括号，step/request的原始数值与增长脉冲继续由完整投影提供。 */}
                            <span style={{ fg: usageFlow().input ? theme.text : theme.textMuted }}>↑</span> {Locale.number(item().input)} <span style={{ fg: usageFlow().output ? theme.text : theme.textMuted }}>↓</span> {Locale.number(item().output)}
                            {item().context ? ` · ${item().context}` : ""}
                            {item().cost ? ` · ${item().cost}` : ""}
                          </text>
                        </Show>
                      )}
                    </Match>
                    <Match when={true}>
                      <text flexShrink={0} fg={theme.text} wrapMode="none">
                        {agentShortcut()} <span style={{ fg: theme.textMuted }}>agents</span>
                      </text>
                    </Match>
                  </Switch>
                  <text flexShrink={0} fg={theme.text} wrapMode="none">
                    {paletteShortcut()} <span style={{ fg: theme.textMuted }}>commands</span>
                  </text>
                  {/* 仅显示判定：promptWidth>120 才露出 voice 提示（比 usage 的 >90 更晚），窄终端把 chrome 让给更高频信息；
                      不影响 Alt+V 绑定本身，窄终端隐藏提示文案但快捷键仍可转录。 */}
                  <Show when={PromptVoiceInput.voiceHintVisible(tuiConfig.voice?.transcriber, promptWidth())}>
                    <text flexShrink={0} fg={theme.text} wrapMode="none">
                      {voiceShortcut() || voiceShortcutFallback} <span style={{ fg: theme.textMuted }}>voice</span>
                    </text>
                  </Show>
                </Match>
                <Match when={store.mode === "shell"}>
                  <text flexShrink={0} fg={theme.text} wrapMode="none">
                    esc <span style={{ fg: theme.textMuted }}>exit shell mode</span>
                  </text>
                </Match>
              </Switch>
            </box>
          </Show>
        </box>
      </box>
      <Autocomplete
        sessionID={props.sessionID}
        ref={(r) => {
          setAuto(() => r)
        }}
        anchor={() => anchor}
        input={() => input}
        setPrompt={(cb) => {
          setStore("prompt", produce(cb))
        }}
        setExtmark={(partIndex, extmarkId) => {
          setStore("extmarkToPartIndex", (map: Map<number, number>) => {
            const newMap = new Map(map)
            newMap.set(extmarkId, partIndex)
            return newMap
          })
        }}
        value={store.prompt.input}
        fileStyleId={fileStyleId}
        agentStyleId={agentStyleId}
        promptPartTypeId={() => promptPartTypeId}
      />
    </>
  )
}
