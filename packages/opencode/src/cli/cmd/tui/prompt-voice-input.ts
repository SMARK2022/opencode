import { Process } from "@/util/process"
import { which } from "@/util/which"
import path from "path"

export const VOICE_FILE_PLACEHOLDER = "{file}"
// 90 秒覆盖网页端冷启动、录音上传和 ChatGPT 私有转写接口波动；超时后必须把控制权还给 TUI。
export const VOICE_TRANSCRIBE_TIMEOUT_MS = 90_000

export type VoiceTranscriber = {
  command: string
  args?: string[]
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
  transcriber: () => VoiceTranscriber | undefined
  startRecorder: () => Promise<VoiceRecorderHandle>
  // signal 让外部 controller 可以中断长时间挂起的转写（如空音频导致浏览器 hang）。
  transcribe?: (file: string, transcriber: VoiceTranscriber, signal: AbortSignal) => Promise<string>
  insertText: (text: string) => void
  onStatus?: (status: VoiceInputStatus) => void
  onError?: (message: string) => void
  now?: () => number
}) {
  let status: VoiceInputStatus = { type: "idle" }
  let recorder: VoiceRecorderHandle | undefined
  let activeTranscriber: VoiceTranscriber | undefined
  let generation = 0
  // 持有当前转写的 AbortController，让 toggle/abort 能中断卡死的外部转写器进程。
  let transcribeAbort: AbortController | undefined
  const transcribe = input.transcribe ?? ((file, transcriber, signal) => transcribeVoiceFile({ file, transcriber, signal }))
  const validateTranscriber = input.transcribe ? async () => {} : validateVoiceTranscriber

  const setStatus = (next: VoiceInputStatus) => {
    status = next
    // 状态只通过 onStatus 向 Prompt 暴露，controller 内部不直接操作 TUI renderable。
    input.onStatus?.(next)
  }

  const fail = async (error: unknown) => {
    // 只有 recording 状态才拥有已启动的 native recorder；starting 的迟到 handle 会在启动分支自行清理。
    if (status.type === "recording") await recorder?.abort()
    recorder = undefined
    activeTranscriber = undefined
    setStatus({ type: "idle" })
    // 错误统一在 controller 边界转成 message，避免 TUI toast 需要理解 unknown/Error 差异。
    input.onError?.(error instanceof Error ? error.message : String(error))
  }

  // cancel 是 abort 和 toggle(transcribing) 共享的取消逻辑：bump generation 让迟到结果失效，
  // abort signal 中断 in-flight transcribe 进程，清理 recorder 并回 idle。
  const cancel = async () => {
    generation++
    transcribeAbort?.abort()
    if (status.type !== "idle") await recorder?.abort().catch(() => {})
    recorder = undefined
    activeTranscriber = undefined
    setStatus({ type: "idle" })
  }

  return {
    status: () => status,
    abort: async () => {
      // abort 是取消语义，不调用 stop/transcribe，避免把用户明确取消的录音上传给外部服务。
      await cancel()
    },
    toggle: async () => {
      if (status.type === "recording") {
        // stop 使用当前 recorder 快照；finally 通过 identity 判断，避免旧 stop 清掉新录音。
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
          // transcriber 在开始录音时固定，停止时不重新读配置，防止录音期间配置变更导致错用后端。
          const text = await transcribe(active.file, requireTranscriber(activeTranscriber), transcribeAbort.signal)
          if (stopGeneration !== generation) return
          // 空白文本由 transcribeVoiceFile 当错误处理；这里仍 trim 一次，保护自定义测试转写器和未来调用者。
          if (text.trim()) input.insertText(text)
        } catch (error) {
          if (stopGeneration !== generation) return
          input.onError?.(error instanceof Error ? error.message : String(error))
        } finally {
          // stop 后也通过 abort 做最终清理：录音实现可能已停止，但临时 WAV 必须删除，避免转写后残留音频。
          await active?.abort().catch(() => {})
          if (stopGeneration === generation || recorder === active) {
            recorder = undefined
            activeTranscriber = undefined
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

      const transcriber = input.transcriber()
      if (!transcriber) {
        // 未配置时不启动麦克风，避免用户说完后才发现没有任何转写后端可用。
        input.onError?.("Voice input is not configured")
        return
      }

      const startGeneration = ++generation
      try {
        // 录音期间固定 transcriber，确保 stop 阶段使用的是启动时用户确认过的后端。
        activeTranscriber = transcriber
        setStatus({ type: "starting" })
        // 校验放在 startRecorder 前，避免 PATH/script 错误消耗一次用户录音。
        await validateTranscriber(transcriber)
        if (startGeneration !== generation || (status as VoiceInputStatus).type !== "starting") return
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

export async function transcribeVoiceFile(input: {
  file: string
  transcriber: VoiceTranscriber
  timeout?: number
  // 外部 signal 让 controller 的 cancel/abort 能真正中断 Process.run。
  signal?: AbortSignal
}) {
  const command = input.transcriber.command.trim()
  // command 允许用户配置时带空格，但进入 spawn 前必须归一成真正 argv[0]。
  if (!command) throw new Error("Voice transcriber command is empty")
  const args = input.transcriber.args ?? []
  if (!args.some((arg) => arg.includes(VOICE_FILE_PLACEHOLDER))) {
      // 没有占位符时转写器无法拿到本次录音文件，继续执行只会制造假成功。
      throw new Error(`Voice transcriber args must include ${VOICE_FILE_PLACEHOLDER}`)
  }
  await validateVoiceTranscriber({ ...input.transcriber, command })

  // 录音路径只替换 argv 项，绝不拼进 shell 字符串；空格、重定向符、管道、变量和分号都保持字面量。
  // 这个边界保证临时录音文件名不能变成命令语法，也不会触发 shell expansion。
  // AbortSignal.any 合并外部取消信号和兜底超时：用户主动取消 或 90s 超时，任一触发都杀进程。
  const timeoutSignal = AbortSignal.timeout(input.timeout ?? VOICE_TRANSCRIBE_TIMEOUT_MS)
  const result = await Process.run([command, ...args.map((arg) => arg.replaceAll(VOICE_FILE_PLACEHOLDER, input.file))], {
    abort: input.signal ? AbortSignal.any([input.signal, timeoutSignal]) : timeoutSignal,
    nothrow: true,
    timeout: 1_000,
  })
  // stderr 优先展示外部转写器自己的诊断；没有 stderr 时才落回退出码。
  if (result.code !== 0) throw new Error(result.stderr.toString().trim() || `Voice transcriber exited with code ${result.code}`)

  const parsed = parseTranscriberOutput(result.stdout.toString())
  // 返回值保持原始转写文本，不在这里 trim，避免破坏模型返回的标点或用户口述的前后空白意图。
  if (!parsed.text.trim()) throw new Error("Voice transcriber returned empty text")
  return parsed.text
}

async function validateVoiceTranscriber(transcriber: VoiceTranscriber) {
  const command = transcriber.command.trim()
  if (!command) throw new Error("Voice transcriber command is empty")
  // 这里只验证 argv[0] 是否存在，不解析 args，确保不会提前触发 shell 语义或环境变量展开。
  const commandExists =
    Boolean(which(command)) ||
    ((path.isAbsolute(command) || command.includes("/") || command.includes("\\")) && (await Bun.file(command).exists()))
  if (!commandExists) {
    // 这里仅检查 argv[0] 是否可执行，不解释 args、不走 shell；缺失时在录音前失败，避免用户说完后才看到 spawn ENOENT。
    throw new Error(
      `Voice transcriber command not found: ${command}. Configure tui.voice.transcriber or enable a local ChatGPT MCP server.`,
    )
  }
  const script = transcriber.args?.[0]
  // ChatGPT 默认后端是 `runner chatgpt.js ...` 形态，脚本缺失需要在录音前给出明确错误。
  if (
    script &&
    path.basename(script).toLowerCase() === "chatgpt.js" &&
    (path.isAbsolute(script) || script.includes("/") || script.includes("\\")) &&
    !(await Bun.file(script).exists())
  ) {
    // MCP 推导出的默认转写器形如 `node <agent-dir>/chatgpt.js ...`；脚本缺失时也要在录音前失败。
    throw new Error(`Voice transcriber script not found: ${script}`)
  }
}

export function voiceInputStatusText(status: VoiceInputStatus, shortcut: string, now = Date.now()) {
  // 这些文案直接显示在 prompt footer；保持短文本，避免小终端下挤掉输入区。
  if (status.type === "starting") return "Starting voice..."
  // recording 必须显示停止快捷键，用户不需要记住开始录音时按了哪个绑定。
  if (status.type === "recording") return `Recording ${formatClock(now - status.startedAt)} · ${shortcut} stop`
  if (status.type === "stopping") return "Saving voice..."
  if (status.type === "transcribing") return "Transcribing voice..."
  return ""
}

function parseTranscriberOutput(text: string): { text: string } {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    // 转写器协议必须是 JSON；直接插入原始 stdout 可能把诊断日志写进用户 prompt。
    throw new Error("Voice transcriber did not return JSON")
  }
  if (!parsed || typeof parsed !== "object" || typeof (parsed as { text?: unknown }).text !== "string") {
    // text 字段是唯一业务输出，额外字段留给后端诊断但不进入 TUI prompt。
    throw new Error("Voice transcriber JSON must contain text")
  }
  return parsed as { text: string }
}

function formatClock(ms: number) {
  // 计时只向下取整，避免录音开始后的首秒在 footer 中抖动。
  const seconds = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(seconds / 60).toString().padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}`
}

function requireTranscriber(transcriber: VoiceTranscriber | undefined) {
  // 这个错误只应在内部状态不一致时出现；正常未配置路径会在启动前被拦截。
  if (!transcriber) throw new Error("Voice input is not configured")
  return transcriber
}

export * as PromptVoiceInput from "./prompt-voice-input"
