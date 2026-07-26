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
// build.ts 把 voice Worker 作为独立 entrypoint；compiled 运行时必须使用 bunfs 路径，不能回退到源码位置。
declare const OPENCODE_VOICE_WORKER_PATH: string | undefined

type VoiceWorkerMessage =
  | { type: "started" }
  | { type: "frame"; frame: Int16Array }
  | { type: "stopped" }
  | { type: "error"; message: string } // 只允许 Worker 宣布一个终态；主线程据此决定是否落盘。
// PvRecorder 固定输出 16kHz 单声道 16-bit PCM；WAV 头必须保持这个常量，否则 browser-agent 侧的转写入口会拒绝文件。
const VOICE_RECORDER_SAMPLE_RATE = 16_000
const VOICE_RECORDER_CHANNELS = 1
// 512 是 Picovoice Node 示例和当前录音 helper 使用的帧长；继续沿用它以避免改变延迟和缓冲行为。
const VOICE_RECORDER_FRAME_LENGTH = 512
// -1 表示系统默认输入设备；这是跨平台录音库的约定，不额外暴露 TUI 配置，避免扩大配置面。
// 250 帧约等于 8 秒 native 缓冲；实测 TUI/JS 线程阻塞 3 秒会让 50 帧默认缓冲短录约 1-2 秒。
const VOICE_RECORDER_BUFFERED_FRAMES = 250
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
  // 同步 native read 由独立 Worker 持有，TUI 渲染或输入阻塞时录音仍会持续消费 native buffer。
  const worker = new Worker(voiceWorkerPath()) // 主线程只管理消息和 WAV，不同步调用 native。
  const control = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT) // 单个 atomic cell 足以表达 stop boundary。
  const frames: Int16Array[] = [] // frame 消息按 Worker message order 进入，terminal 前全部可落盘。
  const started = Promise.withResolvers<void>()
  const terminal = Promise.withResolvers<Error | undefined>()
  let closePromise: Promise<void> | undefined
  // closePromise 把 stop 与 abort 合并到一个边界，防止两个调用同时发布不同的 stop 顺序。
  const fail = (error: Error) => {
    started.reject(error) // startup failure 直接拒绝 start，不让调用方拿到半初始化 recorder。
    terminal.resolve(error) // stop 仍能观察同一个 primary failure。
  }

  worker.onmessage = (event: MessageEvent<VoiceWorkerMessage>) => {
    const message = event.data
    if (message.type === "frame") {
      frames.push(message.frame) // 只接收经过 Int16Array 校验的跨线程 payload。
      return
    }
    if (message.type === "started") {
      started.resolve() // started 是公开 recorder handle 的 readiness signal。
      return
    }
    if (message.type === "error") {
      fail(new Error(message.message)) // Worker 的阶段错误保留给既有 TUI error surface。
      return
    }
    started.reject(new Error("Voice recorder Worker stopped before startup"))
    terminal.resolve(undefined)
  }
  worker.onerror = (event) => fail(new Error(event.message || "Voice recorder Worker failed"))
  // native 路径先解析再发送给 Worker，避免 Worker 收到无法拥有的半初始化资源。
  try {
    worker.postMessage({
      type: "start",
      native: await pvRecorderNativePath(), // 路径解析完成后才把 native owner 交给 Worker。
      frameLength: VOICE_RECORDER_FRAME_LENGTH,
      bufferedFrames: VOICE_RECORDER_BUFFERED_FRAMES,
      control,
    })
    await started.promise // 等 Worker 明确 ready，禁止用固定 sleep 猜测启动完成。
  } catch (error) {
    worker.terminate()
    await fs.rm(file, { force: true })
    throw error
  }
  // startup 成功后所有 native 生命周期都转移给 Worker；主线程只累计有序消息。
  const close = async (writeFile: boolean) => {
    closePromise ??= (async () => {
      // stop flag 是 Worker 接受 frame 的唯一边界；terminal 之前的消息有序入队，之后才可以写 WAV。
      Atomics.store(new Int32Array(control), 0, 1) // 发布 stop 后，Worker 仍会完成当前 read 但不会发送该帧。
      const recordingError = await terminal.promise
      try {
        if (writeFile && recordingError) throw recordingError
      } finally {
        worker.terminate()
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
      if (!closePromise) await close(false)
      await fs.rm(file, { force: true })
    },
  }
}
async function pvRecorderNativePath() { // 源码和 compiled 只改变资源地址，录音协议保持相同。
  // libraryPath 使用包内相对路径作为 key；build.ts 生成的资源表和运行时选择逻辑必须保持同一套字符串。
  const libraryPath = await pvRecorderLibraryPath()
  if (!libraryPath) throw new Error(`Voice recorder does not support ${process.platform}/${process.arch}`)
  const nativePath = await embeddedPvRecorderNativePath(libraryPath)
  if (nativePath) return nativePath
  if (typeof OPENCODE_COMPILED !== "undefined" && OPENCODE_COMPILED) {
    // compiled exe 不能回退到构建机 node_modules；资源缺失必须在 Worker 启动前明确失败。
    throw new Error("Voice recorder native addon is missing from this opencode installation")
  }
  const packageRoot = path.dirname(createRequire(import.meta.url).resolve("@picovoice/pvrecorder-node/package.json"))
  const sourcePath = path.join(packageRoot, "lib", ...libraryPath.split("/"))
  if (!(await Bun.file(sourcePath).exists())) throw new Error(`Voice recorder native addon is missing: ${sourcePath}`)
  return sourcePath
}

export function voiceWorkerPath() {
  if (typeof OPENCODE_COMPILED !== "undefined" && OPENCODE_COMPILED) {
    if (typeof OPENCODE_VOICE_WORKER_PATH === "undefined") throw new Error("Voice recorder Worker is missing from this installation")
    return OPENCODE_VOICE_WORKER_PATH
  }
  return new URL("./prompt-voice-recorder-worker.ts", import.meta.url).href
}
// compiled Worker 必须使用 build.ts 注入的 bunfs 地址，缺失时直接暴露安装损坏。
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
