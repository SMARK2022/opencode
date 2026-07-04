import { TextareaRenderable, TextAttributes } from "@opentui/core"
import { useTheme } from "../context/theme"
import { useDialog, type DialogContext } from "./dialog"
import { Show, createEffect, createSignal, onCleanup, onMount, type JSX } from "solid-js"
import { Spinner } from "../component/spinner"
import { useTuiConfig } from "../config"
import { useBindings, useCommandShortcut } from "../keymap"
import { useRenderer } from "@opentui/solid"
import { PromptVoiceInput } from "../prompt-voice-input"
import { PromptVoiceRecorder } from "../prompt-voice-recorder"
import { useToast } from "./toast"

export type DialogPromptProps = {
  title: string
  description?: () => JSX.Element
  placeholder?: string
  value?: string
  busy?: boolean
  busyText?: string
  onConfirm?: (value: string) => void
  onCancel?: () => void
}

export function DialogPrompt(props: DialogPromptProps) {
  const dialog = useDialog()
  const { theme } = useTheme()
  const tuiConfig = useTuiConfig()
  const toast = useToast()
  const renderer = useRenderer()
  const submitShortcut = useCommandShortcut("dialog.prompt.submit")
  const [textareaTarget, setTextareaTarget] = createSignal<TextareaRenderable>()
  let textarea: TextareaRenderable

  // [local-smark] voice 输入：复用主 Prompt 的 createVoiceInputController，
  // 让 DialogPrompt 的所有消费者（Goal 创建/编辑、Session 重命名、Provider 配置、Plugin API）
  // 自动获得 alt+v / f8 语音转写能力，零新增配置面。
  const [voiceInputStatus, setVoiceInputStatus] = createSignal<PromptVoiceInput.VoiceInputStatus>({
    type: "idle",
  })
  const voiceInputBusy = () => voiceInputStatus().type !== "idle"
  const voiceShortcut = useCommandShortcut("prompt.voice.toggle")
  const voiceShortcutFallback = process.platform === "darwin" ? "f8" : "alt+v"

  function insertVoiceText(text: string) {
    // isDestroyed 守卫：转写完成时 textarea 可能已被 busy/ESC 销毁（dialog.replace），
    // 向已销毁的 renderable 插入文本会抛错或静默失败。
    if (!textarea || textarea.isDestroyed) return
    textarea.insertText(text)
    // 下一 tick 标脏布局，避免转写文本显示滞后一帧（与主 Prompt 的 insertVoiceText 行为一致）
    setTimeout(() => {
      if (!textarea || textarea.isDestroyed) return
      textarea.getLayoutNode().markDirty()
      renderer.requestRender()
    }, 0)
  }

  const voiceInput = PromptVoiceInput.createVoiceInputController({
    transcriber: () => tuiConfig.voice?.transcriber,
    startRecorder: PromptVoiceRecorder.startPromptVoiceRecorder,
    insertText: insertVoiceText,
    onStatus: setVoiceInputStatus,
    onError: (message) => toast.show({ message, variant: "error" }),
  })

  // 组件卸载（ESC / dialog.clear / dialog.replace）时必须释放麦克风，
  // 否则 native PvRecorder 进程会悬挂到转写超时（最长 90s）。
  onCleanup(() => {
    void voiceInput.abort()
  })

  function confirm() {
    if (props.busy) return
    // voice 转写进行中时拦截提交，防止用户提交转写前的旧草稿。
    // 转写最长 90s，期间用户按 Enter 不应触发 onConfirm。
    if (voiceInputBusy()) return
    props.onConfirm?.(textarea.plainText)
  }

  useBindings(() => ({
    target: textareaTarget,
    enabled: textareaTarget() !== undefined && !props.busy,
    // Dialog form semantics must win over the global managed textarea input layer.
    priority: 1,
    commands: [
      {
        name: "dialog.prompt.submit",
        title: "Submit dialog prompt",
        category: "Dialog",
        run: confirm,
      },
      // [local-smark] voice toggle：busy 时 bindings enabled 已为 false，无需重复守卫；
      // 复用 prompt.voice.toggle 配置，与主 Prompt 保持相同快捷键
      {
        name: "prompt.voice.toggle",
        title: "Toggle voice input",
        category: "Dialog",
        run() {
          void voiceInput.toggle()
        },
      },
    ],
    bindings: [
      ...tuiConfig.keybinds.gather("dialog.prompt", ["dialog.prompt.submit"]),
      ...tuiConfig.keybinds.get("prompt.voice.toggle"),
    ],
  }))

  onMount(() => {
    dialog.setSize("medium")
    setTimeout(() => {
      if (!textarea || textarea.isDestroyed) return
      if (props.busy) return
      textarea.focus()
    }, 1)
    textarea.gotoLineEnd()
  })

  createEffect(() => {
    if (!textarea || textarea.isDestroyed) return
    const traits = props.busy
      ? {
          suspend: true,
          status: "BUSY",
        }
      : {}
    textarea.traits = traits
    if (props.busy) {
      textarea.blur()
      return
    }
    textarea.focus()
  })

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          {props.title}
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>
      <box gap={1}>
        {props.description?.()}
        <textarea
          // minHeight=3 保证空态有足够视觉空间；maxHeight=9 让长文本（如 4000 字符的 goal objective）
          // 能随内容增长显示更多行，避免固定 3 行只能看到一小段。与主 Prompt 的 minHeight+maxHeight 模式一致。
          // 对话框 medium 宽度 60 chars，减去 padding 各 2 chars 后 textarea 可用 56 chars 宽。
          minHeight={3}
          maxHeight={9}
          ref={(val: TextareaRenderable) => {
            textarea = val
            setTextareaTarget(val)
          }}
          initialValue={props.value}
          placeholder={props.placeholder ?? "Enter text"}
          placeholderColor={theme.textMuted}
          textColor={props.busy ? theme.textMuted : theme.text}
          focusedTextColor={props.busy ? theme.textMuted : theme.text}
          cursorColor={props.busy ? theme.backgroundElement : theme.text}
          cursorStyle={tuiConfig.cursor}
        />
        <Show when={props.busy}>
          <Spinner color={theme.textMuted}>{props.busyText ?? "Working…"}</Spinner>
        </Show>
      </box>
      <box paddingBottom={1} gap={1} flexDirection="row">
        <Show when={!props.busy} fallback={<text fg={theme.textMuted}>processing…</text>}>
          <Show when={submitShortcut()}>
            <text fg={theme.text}>
              {submitShortcut()} <span style={{ fg: theme.textMuted }}>submit</span>
            </text>
          </Show>
          {/* [local-smark] 录音状态栏 + 快捷键提示；对话框宽度固定，不复用 voiceHintVisible 的 140 列宽度门 */}
          <Show when={voiceInputBusy()}>
            <box flexDirection="row" gap={1}>
              <Show when={voiceInputStatus().type === "recording"} fallback={<Spinner color={theme.accent} />}>
                <text fg={theme.error}>●</text>
              </Show>
              <text fg={theme.accent}>
                {PromptVoiceInput.voiceInputStatusText(voiceInputStatus(), voiceShortcut() || voiceShortcutFallback)}
              </text>
            </box>
          </Show>
          <Show when={tuiConfig.voice?.transcriber && !voiceInputBusy()}>
            <text fg={theme.text}>
              {voiceShortcut() || voiceShortcutFallback} <span style={{ fg: theme.textMuted }}>voice</span>
            </text>
          </Show>
        </Show>
      </box>
    </box>
  )
}

DialogPrompt.show = (dialog: DialogContext, title: string, options?: Omit<DialogPromptProps, "title">) => {
  return new Promise<string | null>((resolve) => {
    dialog.replace(
      () => (
        <DialogPrompt title={title} {...options} onConfirm={(value) => resolve(value)} onCancel={() => resolve(null)} />
      ),
      () => resolve(null),
    )
  })
}
