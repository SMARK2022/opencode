import fs from "fs/promises"
import path from "path"
import { randomUUID } from "crypto"
import { Global } from "@opencode-ai/core/global"
import type { VoiceRecorderHandle } from "./prompt-voice-input"

type NativePvRecorder = {
  read(handle: bigint, pcm: Int16Array): number
}

type PvRecorderConstructor = {
  new (frameLength: number, deviceIndex?: number, bufferedFramesCount?: number): PvRecorderInstance
  _pvRecorder: NativePvRecorder
}

type PvRecorderInstance = {
  _handle: bigint
  readonly frameLength: number
  start(): void
  stop(): void
  release(): void
}

// PvRecorder 固定输出 16kHz 单声道 16-bit PCM；WAV 头必须保持这个常量，否则 browser-agent 侧的转写入口会拒绝文件。
const VOICE_RECORDER_SAMPLE_RATE = 16_000
const VOICE_RECORDER_CHANNELS = 1
// 512 是 Picovoice Node 示例和当前录音 helper 使用的帧长；继续沿用它以避免改变延迟和缓冲行为。
const VOICE_RECORDER_FRAME_LENGTH = 512
// -1 表示系统默认输入设备；这是跨平台录音库的约定，不额外暴露 TUI 配置，避免扩大配置面。
const VOICE_RECORDER_DEVICE_INDEX = -1
// 50 是 PvRecorder 默认推荐的内部缓冲帧数；保留缓冲可减少 TUI 停顿时丢帧和 overflow 的概率。
const VOICE_RECORDER_BUFFERED_FRAMES = 50

export async function startPromptVoiceRecorder(): Promise<VoiceRecorderHandle> {
  const dir = path.join(Global.Path.tmp, "voice")
  await fs.mkdir(dir, { recursive: true })
  // 文件名包含时间戳和 UUID，避免连续录音或并发 Prompt 实例写到同一个临时 WAV。
  const file = path.join(dir, `prompt-${Date.now()}-${randomUUID()}.wav`)
  // native addon 延迟到真正录音时加载，未使用语音的 TUI 启动路径不受 optional 依赖影响。
  const PvRecorder = await loadPvRecorder()
  const recorder = new PvRecorder(VOICE_RECORDER_FRAME_LENGTH, VOICE_RECORDER_DEVICE_INDEX, VOICE_RECORDER_BUFFERED_FRAMES)
  const frames: Int16Array[] = []
  const state = { active: true, closed: false }
  let closePromise: Promise<void> | undefined

  try {
    recorder.start()
  } catch (error) {
    // start 失败时 controller 还拿不到 handle；这里必须释放 native 资源并删除目标文件，避免麦克风句柄残留。
    try {
      recorder.release()
    } catch {}
    await fs.rm(file, { force: true })
    throw error
  }
  // 后台录音循环的错误不能成为未处理 rejection；统一延迟到 stop() 边界抛出，TUI 才能按既有错误路径展示失败信息。
  const recording = recordFrames(PvRecorder, recorder, frames, state).then(
    () => undefined,
    (error: unknown) => error,
  )

  const close = async (writeFile: boolean) => {
    closePromise ??= (async () => {
      // active=false 只阻止下一轮读取；正在进行的 native read 会先返回，确保最后一帧不被中断。
      state.active = false
      const recordingError = await recording
      try {
        // stop 需要把录音错误反馈给用户；abort 是 cleanup 边界，必须尽力释放资源和删临时文件，不能因旧错误阻塞清理。
        if (writeFile && recordingError) throw recordingError
      } finally {
        state.closed = true
        // stop/release 必须在同一个 close 边界内执行一次；重复释放 native handle 会触发底层库错误。
        try {
          recorder.stop()
        } catch {}
        try {
          recorder.release()
        } catch {}
      }
      if (!writeFile) return
      // 只有 stop 路径写 WAV；abort 路径绝不把取消中的隐私语音落盘。
      await writeWav(file, flattenFrames(frames))
    })()
    await closePromise
  }

  return {
    file,
    stop: async () => {
      await close(true)
      // 写入后再检查文件存在，能把磁盘权限或临时目录删除这类 IO 问题反馈给用户。
      if (!(await Bun.file(file).exists())) throw new Error("Voice recorder did not write a WAV file")
    },
    abort: async () => {
      if (!state.closed) await close(false)
      await fs.rm(file, { force: true })
    },
  }
}

async function recordFrames(
  PvRecorder: PvRecorderConstructor,
  recorder: PvRecorderInstance,
  frames: Int16Array[],
  state: { active: boolean },
) {
  while (state.active) {
    // native read 本身会等到下一帧可用；这里不能再额外按帧 sleep，否则 TUI 卡顿后会永久落后于 PvRecorder 内部缓冲并在 stop 时丢尾。
    // 读取结果立即追加到内存 frames，stop 写文件时不会再碰 native handle，降低释放顺序风险。
    frames.push(readFrame(PvRecorder, recorder))
    // 读完一帧后只让出一次事件循环，保证快捷键和渲染能被处理，同时允许有 backlog 时尽快追平缓冲。
    // setTimeout(0) 是调度让步，不是录音节流；帧节奏由 PvRecorder.read 自己控制。
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

async function loadPvRecorder() {
  // recorder 是 optional native 依赖；只有用户实际启动语音录制时才加载，避免未使用语音的 TUI 启动路径被 native 安装问题拖垮。
  const mod = (await import("@picovoice/pvrecorder-node")) as unknown as { PvRecorder: PvRecorderConstructor }
  return mod.PvRecorder
}

function readFrame(PvRecorder: PvRecorderConstructor, recorder: PvRecorderInstance) {
  // 不能调用 PvRecorder.read()/readSync()：Bun 1.3.x 与该 native addon 的 N-API TypedArray 写回存在兼容差异。
  // 显式创建 ArrayBuffer backing store 后再传入 native read，是当前已验证的 Bun 源码态和 compile exe 态共同可用路径。
  const pcm = new Int16Array(new ArrayBuffer(recorder.frameLength * Int16Array.BYTES_PER_ELEMENT))
  const status = PvRecorder._pvRecorder.read(recorder._handle, pcm)
  if (status !== 0) throw new Error(`PvRecorder read failed with status ${status}`)
  return pcm
}

function flattenFrames(frames: Int16Array[]) {
  // WAV 需要连续 PCM；这里一次性分配目标数组，避免写文件时逐帧拼 Buffer 产生额外复制边界。
  const samples = frames.reduce((total, frame) => total + frame.length, 0)
  const pcm = new Int16Array(samples)
  let offset = 0
  for (const frame of frames) {
    pcm.set(frame, offset)
    offset += frame.length
  }
  return pcm
}

async function writeWav(filePath: string, pcm: Int16Array) {
  // dataSize 是字节数不是 sample 数；16-bit PCM 每个 sample 固定 2 字节。
  const dataSize = pcm.length * 2
  const buffer = Buffer.alloc(44 + dataSize)
  // 44 字节 RIFF/WAVE header 是 browser-agent 和 ChatGPT 上传路径都能直接识别的最小 PCM WAV 格式。
  buffer.write("RIFF", 0)
  buffer.writeUInt32LE(36 + dataSize, 4)
  buffer.write("WAVE", 8)
  buffer.write("fmt ", 12)
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(VOICE_RECORDER_CHANNELS, 22)
  buffer.writeUInt32LE(VOICE_RECORDER_SAMPLE_RATE, 24)
  buffer.writeUInt32LE(VOICE_RECORDER_SAMPLE_RATE * VOICE_RECORDER_CHANNELS * 2, 28)
  buffer.writeUInt16LE(VOICE_RECORDER_CHANNELS * 2, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write("data", 36)
  buffer.writeUInt32LE(dataSize, 40)
  // writeInt16LE 保持 little-endian PCM；PvRecorder 输出已经是 16-bit 单声道样本，不做重采样。
  for (let index = 0; index < pcm.length; index++) buffer.writeInt16LE(pcm[index] || 0, 44 + index * 2)
  await Bun.write(filePath, buffer)
}

export * as PromptVoiceRecorder from "./prompt-voice-recorder"
