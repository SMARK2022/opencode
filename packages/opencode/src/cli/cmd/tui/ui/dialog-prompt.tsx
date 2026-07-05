import { TextareaRenderable, TextAttributes } from "@opentui/core"
import { useRenderer } from "@opentui/solid"
import { useTheme } from "../context/theme"
import { useTuiConfig } from "../context/tui-config"
import { useDialog, type DialogContext } from "./dialog"
import { useToast } from "./toast"
import { useBindings, useCommandShortcut } from "../keymap"
import { PromptVoiceInput } from "../prompt-voice-input"
import { PromptVoiceRecorder } from "../prompt-voice-recorder"
import { Spinner } from "../component/spinner"
import { createRefreshClock } from "../util/signal"
import { Show, createEffect, onCleanup, onMount, createSignal, type JSX } from "solid-js"

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
  // 录音计时器需要每秒刷新 now 信号驱动 footer 的 Recording MM:SS 走数；
  // 缺少它时 voiceInputStatusText 的 now 参数只在录音开始瞬间求值一次，计时器冻结在 00:00。
  const now = createRefreshClock(() => voiceInputStatus().type === "recording")

  function insertVoiceText(text: string) {
    // isDestroyed 守卫：录音转写完成时 textarea 可能已被 busy/ESC 销毁，
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

  // voice toggle keybind：复用 prompt.voice.toggle 命令和 prompt_voice_toggle 配置，
  // 保持与主 Prompt 相同的肌肉记忆。busy 状态下禁用，避免与消费者异步操作竞争。
  useBindings(() => ({
    enabled: !props.busy,
    commands: [
      {
        name: "prompt.voice.toggle",
        title: "Toggle voice input",
        category: "Dialog",
        run() {
          void voiceInput.toggle()
        },
      },
    ],
    bindings: tuiConfig.keybinds.get("prompt.voice.toggle"),
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
        {props.description}
        <textarea
          onSubmit={() => {
            if (props.busy) return
            // voice 转写进行中时拦截 submit，防止用户提交转写前的旧草稿。
            // 转写最长 90s，期间用户按 Enter 不应触发 onConfirm。
            if (voiceInputBusy()) return
            props.onConfirm?.(textarea.plainText)
          }}
          // minHeight=3 保证空态有足够视觉空间；maxHeight=15 让长文本（如 4000 字符的 goal objective）
          // 能随内容增长显示更多行，避免固定 3 行只能看到一小段。与主 Prompt 的 minHeight+maxHeight 模式一致。
          // 对话框 medium 宽度 60 chars，减去 padding 各 2 chars 后 textarea 可用 56 chars 宽。
          // maxHeight=15 在 24 行终端中 title(1)+gap(1)+textarea(15)+footer(2)+padding(2)=21 行仍 fits。
          minHeight={3}
          maxHeight={15}
          ref={(val: TextareaRenderable) => {
            textarea = val
          }}
          initialValue={props.value}
          placeholder={props.placeholder ?? "Enter text"}
          placeholderColor={theme.textMuted}
          textColor={props.busy ? theme.textMuted : theme.text}
          focusedTextColor={props.busy ? theme.textMuted : theme.text}
          cursorColor={props.busy ? theme.backgroundElement : theme.text}
        />
        <Show when={props.busy}>
          <Spinner color={theme.textMuted}>{props.busyText ?? "Working..."}</Spinner>
        </Show>
      </box>
      <box paddingBottom={1} gap={1} flexDirection="row">
        <Show when={!props.busy} fallback={<text fg={theme.textMuted}>processing...</text>}>
          {/* 录音中显示红点 + 计时器和停止快捷键，让用户知道如何结束录音 */}
          <Show when={voiceInputBusy()}>
            <box flexDirection="row" gap={1}>
              <Show when={voiceInputStatus().type === "recording"} fallback={<Spinner color={theme.accent} />}>
                <text fg={theme.error}>●</text>
              </Show>
              <text fg={theme.accent}>
                {PromptVoiceInput.voiceInputStatusText(voiceInputStatus(), voiceShortcut() || voiceShortcutFallback, now())}
              </text>
            </box>
          </Show>
          <text fg={theme.text}>
            enter <span style={{ fg: theme.textMuted }}>submit</span>
          </text>
          {/* 对话框宽度远小于 140，不复用 voiceHintVisible；配置了转写器就始终露出快捷键提示。
              录音中隐藏提示，避免与录音状态栏的 "f8 stop" 冗余显示。 */}
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
