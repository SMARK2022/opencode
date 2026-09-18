import { isRecord } from "@/util/record"

// 整轮从 WAV 完成后计时，上传和锁等待也消耗同一份预算。
export const VOICE_TRANSCRIBE_TIMEOUT_MS = 120_000
// voice 提示标签(footer "alt+v voice")的显示宽度阈值：promptWidth 超过该值才显示。
// 比 usage 显示阈值(>90，见 Prompt 组件 showSplitFlow)更晚出现，确保窄终端优先保留 usage/commands 等更高频 chrome。
// 阈值由 140 下调至 120：usage 阈值由 100 降至 90 后，voice 仍需晚于 usage 出现，但 140 过晚导致中宽终端长期无 voice 引导。
export const VOICE_HINT_MIN_PROMPT_WIDTH = 120

export async function submitVoice(file: string, signal: AbortSignal, sdk: {
  url: string; directory?: string; fetch: (input: string | URL, init?: RequestInit) => Promise<Response>
}): Promise<string> {
  signal.throwIfAborted()
  // standalone + native addon 的 Bun.file 正文释放会触发运行时崩溃；先取得独立字节所有权保护上传完成点。
  const bytes = await Bun.file(file).arrayBuffer()
  // 文件读取本身不可中断，但读取完成后的取消必须阻止请求进入认证传输。
  signal.throwIfAborted()
  // 每次提交读取当前连接，重连后的端口与 attach 认证沿 SDK 一起生效。
  const url = new URL("/tui/voice/transcribe", sdk.url)
  if (sdk.directory) url.searchParams.set("directory", sdk.directory)
  const response = await sdk.fetch(url, { method: "POST", headers: { "content-type": "audio/wav" }, body: bytes, signal })
  // 响应正文仍归本轮信号；取消优先于响应解析和文字交付。
  const body: unknown = await response.json().catch(() => undefined)
  signal.throwIfAborted()
  if (!response.ok) throw new Error(isRecord(body) && typeof body.message === "string" ? body.message : `Voice request returned HTTP ${response.status}`)
  // 只接收文字，凭据始终停留在共享后端的响应处理和配置中。
  if (!isRecord(body) || typeof body.text !== "string") throw new Error("Voice response must contain text")
  return body.text
}

export type VoiceInputStatus =
  | { type: "idle" }
  | { type: "starting" }
  | { type: "recording"; startedAt: number }
  | { type: "stopping" }
  | { type: "transcribing" }

export type VoiceRecorderHandle = {
  file: string
  stop: () => Promise<void>
  abort: () => Promise<void>
}

export function createVoiceInputController(input: {
  startRecorder: () => Promise<VoiceRecorderHandle>
  // signal 让外部 controller 可以中断长时间挂起的转写（如空音频导致浏览器 hang）。
  transcribe: (file: string, signal: AbortSignal) => Promise<string>
  insertText: (text: string) => void
  onStatus?: (status: VoiceInputStatus) => void
  onError?: (message: string) => void
  now?: () => number
}) {
  let status: VoiceInputStatus = { type: "idle" }
  let recorder: VoiceRecorderHandle | undefined
  let generation = 0
  // 持有当前转写的 AbortController，让 toggle/abort 能中断卡死的外部转写器进程。
  let transcribeAbort: AbortController | undefined

  const setStatus = (next: VoiceInputStatus) => {
    status = next
    // 状态只通过 onStatus 向 Prompt 暴露，controller 内部不直接操作 TUI renderable。
    input.onStatus?.(next)
  }

  const fail = async (error: unknown) => {
    // 只有 recording 状态才拥有已启动的 native recorder；starting 的迟到 handle 会在启动分支自行清理。
    if (status.type === "recording") await recorder?.abort()
    recorder = undefined
    setStatus({ type: "idle" })
    // 错误统一在 controller 边界转成 message，避免 TUI toast 需要理解 unknown/Error 差异。
    input.onError?.(error instanceof Error ? error.message : String(error))
  }

  // 先解除本轮共享引用，再等待清理；stop/上传中的局部句柄由原调用 finally 收尾。
  // generation 使迟到结果自然退出，避免旧取消清空已经开始的新录音。
  const cancel = async () => {
    const current = ++generation
    const active = recorder
    const closeHere = status.type === "recording"
    const abort = transcribeAbort
    recorder = undefined
    transcribeAbort = undefined
    setStatus({ type: closeHere ? "stopping" : "idle" })
    abort?.abort()
    try {
      if (closeHere) await active?.abort()
    } finally {
      if (generation === current) setStatus({ type: "idle" })
    }
  }

  return {
    status: () => status,
    abort: async () => {
      // abort 是取消语义，不调用 stop/transcribe，避免把用户明确取消的录音上传给外部服务。
      await cancel()
    },
    toggle: async () => {
      if (status.type === "recording") {
        // stop 固定本轮句柄；finally 只清理该录音，generation 保护后继录音状态。
        const active = recorder
        const stopGeneration = generation
        try {
          if (!active) throw new Error("Voice recorder is not active")
          setStatus({ type: "stopping" })
          // active.stop() 负责把 WAV 写完整；成功后才允许进入外部转写阶段。
          await active.stop()
          if (stopGeneration !== generation) return
          setStatus({ type: "transcribing" })
          // 为本轮转写创建独立 AbortController，让 cancel/abort 能真正中断外部进程。
          transcribeAbort = new AbortController()
          const signal = AbortSignal.any([transcribeAbort.signal, AbortSignal.timeout(VOICE_TRANSCRIBE_TIMEOUT_MS)])
          const text = await input.transcribe(active.file, signal).catch((error) => {
            signal.throwIfAborted()
            throw error
          })
          signal.throwIfAborted()
          if (stopGeneration !== generation) return
          // 静音返回空文字仍是成功，输入框只插入实际识别出的内容。
          if (text.trim()) input.insertText(text)
        } catch (error) {
          if (stopGeneration !== generation) return
          input.onError?.(error instanceof Error && error.name === "TimeoutError"
            ? "语音转录超时（120 秒）" : error instanceof Error ? error.message : String(error))
        } finally {
          // stop 后也通过 abort 做最终清理：录音实现可能已停止，但临时 WAV 必须删除，避免转写后残留音频。
          await active?.abort().catch(() => {})
          if (stopGeneration === generation) {
            recorder = undefined
            transcribeAbort = undefined
            setStatus({ type: "idle" })
          }
        }
        return
      }
      // transcribing 表示转写正在运行（可能 hang）；用户再次按快捷键时直接取消，让 TUI 恢复可操作。
      // 不调 onError：用户主动取消不是错误，不应弹出 error toast。
      if (status.type === "transcribing") {
        await cancel()
        return
      }
      if (status.type !== "idle") return

      const startGeneration = ++generation
      try {
        setStatus({ type: "starting" })
        const started = await input.startRecorder()
        const stillStarting = (status as VoiceInputStatus).type === "starting"
        if (startGeneration !== generation || !stillStarting) {
          // 启动期间用户可能已 abort 或切换上下文；迟到的 recorder 不能接管 UI，只能释放自己的 native/临时文件资源。
          await started.abort().catch(() => {})
          return
        }
        recorder = started
        setStatus({ type: "recording", startedAt: input.now?.() ?? Date.now() })
      } catch (error) {
        if (startGeneration !== generation) return
        await fail(error)
      }
    },
  }
}

// 语音后端由 daemon 统一选择；footer 只根据可用宽度展示快捷键。
export function voiceHintVisible(promptWidth: number): boolean {
  return promptWidth > VOICE_HINT_MIN_PROMPT_WIDTH
}

export function voiceInputStatusText(status: VoiceInputStatus, shortcut: string, now = Date.now(), options: { compact?: boolean } = {}) {
  // 这些文案直接显示在 footer；compact 是主 Prompt / DialogPrompt / QuestionPrompt 的统一 short profile。
  // 默认长文案保留作兼容 profile，避免未来非 UI consumer 被静默改写。
  if (status.type === "starting") return options.compact ? "Starting..." : "Starting voice..."
  // recording 必须显示停止快捷键，用户不需要记住开始录音时按了哪个绑定。
  if (status.type === "recording") return `${options.compact ? "Rec" : "Recording"} ${formatClock(now - status.startedAt)} · ${shortcut} stop`
  if (status.type === "stopping") return options.compact ? "Saving..." : "Saving voice..."
  if (status.type === "transcribing") return options.compact ? "Transcribing..." : "Transcribing voice..."
  return ""
}

function formatClock(ms: number) {
  // 计时只向下取整，避免录音开始瞬间出现负数或跳秒。
  const seconds = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(seconds / 60).toString().padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}`
}

export * as PromptVoiceInput from "./prompt-voice-input"
