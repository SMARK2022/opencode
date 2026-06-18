import fs from "fs/promises"
import path from "path"
import { createHash, randomUUID } from "crypto"
import { createRequire } from "module"
import { Global } from "@opencode-ai/core/global"
import type { VoiceRecorderHandle } from "./prompt-voice-input"

// 该常量只在 build.ts 的 compile define 中出现；源码运行时保持 undefined，继续使用 node_modules 里的 optional 依赖。
declare const OPENCODE_COMPILED: boolean | undefined
// 版本号参与 native cache 路径，避免升级后复用旧 `.node`，也让旧版本目录可以被安全识别并延迟清理。
declare const OPENCODE_VERSION: string | undefined

type NativePvRecorder = {
  // 这些签名来自 Picovoice native addon；compiled 模式直接 require `.node`，不能复用包里的 JS class 类型。
  init(frameLength: number, deviceIndex: number, bufferedFramesCount: number): { status: number; handle: bigint }
  read(handle: bigint, pcm: Int16Array): number
  start(handle: bigint): number
  stop(handle: bigint): number
  delete(handle: bigint): void
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
// 帧周期只用于 stop drain 判断“立即返回的 backlog”和“正在录 stop 后新音频的 live read”。
const VOICE_RECORDER_FRAME_INTERVAL_MS = Math.max(1, Math.round((VOICE_RECORDER_FRAME_LENGTH / VOICE_RECORDER_SAMPLE_RATE) * 1_000))
// -1 表示系统默认输入设备；这是跨平台录音库的约定，不额外暴露 TUI 配置，避免扩大配置面。
const VOICE_RECORDER_DEVICE_INDEX = -1
// 250 帧约等于 8 秒 native 缓冲；实测 TUI/JS 线程阻塞 3 秒会让 50 帧默认缓冲短录约 1-2 秒。
const VOICE_RECORDER_BUFFERED_FRAMES = 250
// queued backlog 的 read 应该很快返回；接近一个 live 帧周期说明缓冲已空，不能继续把 stop 后环境音写进 WAV。
const VOICE_RECORDER_DRAIN_BLOCKED_READ_MS = Math.max(8, Math.floor(VOICE_RECORDER_FRAME_INTERVAL_MS * 0.75))
// 只清理 24 小时以前的崩溃残留；更短窗口可能误删仍在转写或另一个进程刚释放的临时文件。
const VOICE_RECORDER_STALE_FILE_MS = 24 * 60 * 60 * 1_000

// 清理任务每个进程只启动一次，避免每次触发语音快捷键都扫描目录造成额外 IO。
let cleanupExtractedPvRecorderCachePromise: Promise<void> | undefined
let cleanupPromptVoiceFilesPromise: Promise<void> | undefined

export async function startPromptVoiceRecorder(): Promise<VoiceRecorderHandle> {
  const dir = path.join(Global.Path.tmp, "voice")
  await fs.mkdir(dir, { recursive: true })
  // 清理只在用户实际触发语音时启动，避免普通 TUI 启动路径扫描临时目录。
  cleanupPromptVoiceFilesPromise ??= cleanupStalePromptVoiceFiles(dir).catch(() => {})
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
        if (writeFile) drainBufferedFrames(PvRecorder, recorder, frames)
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
  const bundled = await loadBundledPvRecorder()
  if (bundled) return bundled
  if (typeof OPENCODE_COMPILED !== "undefined" && OPENCODE_COMPILED) {
    // compiled exe 不应再落回 @picovoice 的 __dirname 路径，否则会重新访问 CI 构建机上的 node_modules 绝对路径。
    throw new Error("Voice recorder native addon is missing from this opencode installation")
  }
  const mod = (await import("@picovoice/pvrecorder-node")) as unknown as { PvRecorder: PvRecorderConstructor }
  return mod.PvRecorder
}

async function loadBundledPvRecorder() {
  // libraryPath 使用包内相对路径作为 key；build.ts 生成的资源表和运行时选择逻辑必须保持同一套字符串。
  const libraryPath = await pvRecorderLibraryPath()
  const nativePath = libraryPath ? await embeddedPvRecorderNativePath(libraryPath) : undefined
  if (!nativePath) return
  let native: NativePvRecorder
  try {
    // createRequire 让 Bun 走 Node addon 加载分支；动态 import 无法加载 `.node` 原生模块。
    native = createRequire(import.meta.url)(nativePath) as NativePvRecorder
  } catch (error) {
    throw new Error(
      `Failed to load bundled PvRecorder native addon from ${nativePath}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  return createBundledPvRecorderConstructor(native)
}

async function embeddedPvRecorderNativePath(libraryPath: string) {
  if (!(typeof OPENCODE_COMPILED !== "undefined" && OPENCODE_COMPILED)) return
  const embedded = await importEmbeddedPvRecorderFiles()
  const source = embedded?.[libraryPath]
  if (!source) return
  // `.node` 不能从 Bun 虚拟文件系统直接 dlopen；必须释放到真实用户 cache 路径后再 require。
  // `native/pvrecorder` 放在用户 cache 下而不是共享 tmp，避免预置同名 `.node` 被 compiled exe 误加载。
  const root = path.join(Global.Path.cache, "native", "pvrecorder")
  // 版本号和 platform 子路径共同组成稳定目标；同一版本重复录音会复用同一份 native 文件。
  const nativePath = path.join(root, opencodeVersion(), ...libraryPath.split("/"))
  await fs.mkdir(path.dirname(nativePath), { recursive: true })
  await ensureExtractedNativeFile(source, nativePath)
  cleanupExtractedPvRecorderCachePromise ??= cleanupExtractedPvRecorderCache(root, opencodeVersion()).catch(() => {})
  return nativePath
}

async function ensureExtractedNativeFile(source: string, nativePath: string) {
  const sourceFile = Bun.file(source)
  // 已有文件必须和嵌入资源 hash 一致才可复用，避免 cache 目录里同大小恶意 `.node` 被加载。
  if (await sameFileContent(source, nativePath)) return
  // 先写唯一临时文件再 rename，避免并发录音或崩溃留下半写入 native addon。
  // `.tmp-<pid>-<uuid>` 只用于同目录原子替换，保证跨 Windows/macOS/Linux 都不会跨设备 rename。
  const tempPath = `${nativePath}.tmp-${process.pid}-${randomUUID()}`
  try {
    await Bun.write(tempPath, sourceFile)
    try {
      await fs.rename(tempPath, nativePath)
    } catch (error) {
      // 另一个并发进程可能已经完成 rename；目标存在时直接复用，避免把并发成功误报为录音失败。
      if (await sameFileContent(source, nativePath)) return
      throw error
    }
  } finally {
    await fs.rm(tempPath, { force: true }).catch(() => {})
  }
}

async function sameFileContent(source: string, target: string) {
  if (!(await Bun.file(target).exists())) return false
  if (Bun.file(source).size !== Bun.file(target).size) return false
  return (await fileDigest(source)) === (await fileDigest(target))
}

async function fileDigest(file: string) {
  // SHA-256 只用于校验本地 native cache 是否等于嵌入资源，不参与安全协议或外部输入解析。
  return createHash("sha256").update(Buffer.from(await Bun.file(file).arrayBuffer())).digest("hex")
}

async function cleanupExtractedPvRecorderCache(root: string, keepVersion: string) {
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => [])
  await Promise.all(
    entries.map(async (entry) => {
      const target = path.join(root, entry.name)
      if (entry.isDirectory() && entry.name === keepVersion) {
        // 当前版本目录只清理崩溃留下的临时文件，不能删除已加载的 pv_recorder.node 本体。
        await cleanupExtractedPvRecorderTempFiles(target)
        return
      }
      // 旧版本目录延迟清理，避免升级期间另一个旧版本 opencode 进程仍持有 native addon。
      if (entry.isDirectory() && entry.name !== keepVersion && (await isStaleFile(target))) {
        await fs.rm(target, { recursive: true, force: true }).catch(() => {})
      }
    }),
  )
}

async function cleanupExtractedPvRecorderTempFiles(dir: string) {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
  await Promise.all(
    entries.map(async (entry) => {
      const target = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        // 平台路径有多级目录，例如 raspberry-pi/cortex-a72-aarch64，需要递归查找 tmp 残留。
        await cleanupExtractedPvRecorderTempFiles(target)
        return
      }
      // `.tmp-` 文件只可能来自原子释放流程；保留 24 小时以内的文件可避免误删正在写入的并发进程。
      if (entry.isFile() && entry.name.includes(".tmp-") && (await isStaleFile(target))) {
        await fs.rm(target, { force: true }).catch(() => {})
      }
    }),
  )
}

async function cleanupStalePromptVoiceFiles(dir: string) {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
  await Promise.all(
    entries
      // 只处理本录音器生成的 WAV，避免清理用户或其它工具放在同一 tmp 目录下的文件。
      .filter((entry) => entry.isFile() && /^prompt-.*\.wav$/i.test(entry.name))
      .map(async (entry) => {
        const file = path.join(dir, entry.name)
        // stop/transcribe 正常路径会立即 abort 删除；这里仅兜底异常退出后遗留的隐私音频文件。
        if (await isStaleFile(file)) await fs.rm(file, { force: true }).catch(() => {})
      }),
  )
}

async function isStaleFile(file: string) {
  const stat = await fs.stat(file).catch(() => undefined)
  return Boolean(stat && Date.now() - stat.mtimeMs > VOICE_RECORDER_STALE_FILE_MS)
}

async function importEmbeddedPvRecorderFiles() {
  try {
    // build.ts 总是生成这个虚拟模块；catch 只保护源码/dev 路径和异常打包产物，避免未使用 voice 时启动失败。
    // @ts-expect-error - generated file at build time
    return (await import("opencode-pvrecorder.gen.ts")).default as Record<string, string>
  } catch {
    return undefined
  }
}

function opencodeVersion() {
  // dev 只作为兜底目录名；正常源码路径不会调用 compiled 释放逻辑。
  return typeof OPENCODE_VERSION !== "undefined" ? OPENCODE_VERSION : "dev"
}

async function pvRecorderLibraryPath() {
  if (process.platform === "win32") {
    // Picovoice Windows x64 目录名为 amd64；必须和 build.ts 的资源 key 完全一致。
    if (process.arch === "x64") return "windows/amd64/pv_recorder.node"
    if (process.arch === "arm64") return "windows/arm64/pv_recorder.node"
    return
  }
  if (process.platform === "darwin") {
    // macOS Intel 使用 x86_64 命名；不要把 Node/Bun 的 x64 直接拼进包路径。
    if (process.arch === "x64") return "mac/x86_64/pv_recorder.node"
    if (process.arch === "arm64") return "mac/arm64/pv_recorder.node"
    return
  }
  if (process.platform === "linux") {
    // Linux x64 的 native 文件不区分 glibc/musl；Bun runtime 的 libc target 不参与 Picovoice 路径选择。
    if (process.arch === "x64") return "linux/x86_64/pv_recorder.node"
    if (process.arch === "arm" || process.arch === "arm64") {
      const machine = await linuxPvRecorderMachine(process.arch)
      if (machine) return `raspberry-pi/${machine}/pv_recorder.node`
    }
  }
}

async function linuxPvRecorderMachine(arch: NodeJS.Architecture) {
  // Raspberry Pi 包需要按 CPU part 选择；读取失败时返回 undefined，让上层给出缺失 native addon 的明确错误。
  const cpuInfo = await Bun.file("/proc/cpuinfo")
    .text()
    .catch(() => "")
  const part = cpuInfo.match(/^CPU part\s*:\s*(0x[0-9a-f]+)/im)?.[1]?.toLowerCase()
  const suffix = arch === "arm64" ? "-aarch64" : ""
  if (part === "0xd03") return `cortex-a53${suffix}`
  if (part === "0xd08") return `cortex-a72${suffix}`
  if (part === "0xd0b") return `cortex-a76${suffix}`
}

function createBundledPvRecorderConstructor(native: NativePvRecorder): PvRecorderConstructor {
  // 这个轻量 class 只补齐本文件实际用到的 PvRecorder API，避免引入 @picovoice 包内会触发错误 __dirname 的 JS wrapper。
  class BundledPvRecorder implements PvRecorderInstance {
    static _pvRecorder = native
    _handle: bigint
    readonly frameLength: number

    constructor(frameLength: number, deviceIndex = -1, bufferedFramesCount = 50) {
      // status=0 是 Picovoice SUCCESS；保持数字判断，避免再加载包内枚举模块导致 compiled 路径回退。
      const result = native.init(frameLength, deviceIndex, bufferedFramesCount)
      if (result.status !== 0) throw new Error(`PvRecorder initialize failed with status ${result.status}`)
      // native handle 是后续 start/read/stop/delete 的唯一资源标识，必须和包内 JS wrapper 的字段名保持一致。
      this._handle = result.handle
      this.frameLength = frameLength
    }

    start() {
      // start 是用户可见的启动边界，权限或设备占用错误必须透传给 controller 展示。
      requirePvRecorderSuccess(native.start(this._handle), "start")
    }

    stop() {
      // stop 保持包内 wrapper 的 status 检查语义；外层 close 把它作为 best-effort 释放边界处理。
      requirePvRecorderSuccess(native.stop(this._handle), "stop")
    }

    release() {
      // delete 对应 Picovoice native 资源释放；重复调用由外层 closePromise 保证不会发生。
      native.delete(this._handle)
    }
  }
  return BundledPvRecorder
}

function requirePvRecorderSuccess(status: number, action: string) {
  if (status !== 0) throw new Error(`PvRecorder ${action} failed with status ${status}`)
}

function readFrame(PvRecorder: PvRecorderConstructor, recorder: PvRecorderInstance) {
  // 不能调用 PvRecorder.read()/readSync()：Bun 1.3.x 与该 native addon 的 N-API TypedArray 写回存在兼容差异。
  // 显式创建 ArrayBuffer backing store 后再传入 native read，是当前已验证的 Bun 源码态和 compile exe 态共同可用路径。
  const pcm = new Int16Array(new ArrayBuffer(recorder.frameLength * Int16Array.BYTES_PER_ELEMENT))
  const status = PvRecorder._pvRecorder.read(recorder._handle, pcm)
  if (status !== 0) throw new Error(`PvRecorder read failed with status ${status}`)
  return pcm
}

function drainBufferedFrames(PvRecorder: PvRecorderConstructor, recorder: PvRecorderInstance, frames: Int16Array[]) {
  // 帧数上限等于 native circular buffer 容量；这样即使 addon 行为异常，也不会无限延长 stop。
  for (let index = 0; index < VOICE_RECORDER_BUFFERED_FRAMES; index++) {
    const startedAt = performance.now()
    const frame = readFrame(PvRecorder, recorder)
    // 同步 native read 不能被 JS timeout 中断；耗时达到 live 帧级别时丢弃该帧并停止，只保留 stop 前已缓冲音频。
    if (performance.now() - startedAt >= VOICE_RECORDER_DRAIN_BLOCKED_READ_MS) return
    frames.push(frame)
  }
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
