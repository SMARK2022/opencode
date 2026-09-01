import { Audio, type AudioErrorContext, type AudioPlayOptions, type AudioSound, type AudioVoice } from "@opentui/core"
import * as Log from "@opencode-ai/core/util/log"

const log = Log.create({ service: "tui.audio" })

let audio: Audio | null | undefined
const sounds = new Map<string, Promise<AudioSound | null>>()

function getAudio() {
  if (audio !== undefined) return audio
  try {
    // idleReleaseMs=3000:末次发声后 3s 宽限即完整释放输出通道(对齐 WirePlumber
    // idle-suspend 惯例),静默期不锁死音频设备(蓝牙 multipoint 可被其他设备抢占);
    // 无声卡环境 start() 静默失败且无状态,下一次事件自然重试(热插拔友好)
    const next = Audio.create({ autoStart: false, idleReleaseMs: 3000 })
    next.on("error", (error: Error, context: AudioErrorContext) => {
      log.debug("tui audio error", { error, context })
    })
    audio = next
    return next
  } catch (error) {
    log.debug("failed to create tui audio", { error })
    audio = null
    return null
  }
}

export function loadSoundFile(file: string) {
  return loadSound(file, () => Bun.file(file).bytes())
}

// 直接从 bytes 加载并缓存，避免落临时文件；key 必须稳定且唯一
// 先查 cache 再调用 bytes factory，防止每次 completion 都重复 Base64 decode
export function loadSound(key: string, bytes: () => Uint8Array | Promise<Uint8Array>) {
  const current = getAudio()
  if (!current) return Promise.resolve(null)
  const cached = sounds.get(key)
  if (cached) return cached
  const task = Promise.resolve(bytes())
    .then((value) => current.loadSound(value))
    .catch((error) => {
      log.debug("failed to load tui sound bytes", { key, error })
      return null
    })
  sounds.set(key, task)
  return task
}

export function play(sound: AudioSound, options?: AudioPlayOptions) {
  const current = getAudio()
  if (!current) return null
  if (!current.isStarted() && !current.start()) return null
  return current.play(sound, options)
}

export function stopVoice(voice: AudioVoice) {
  return audio?.stopVoice(voice) ?? false
}

export function dispose() {
  audio?.dispose()
  audio = undefined
  sounds.clear()
}

export * as TuiAudio from "./audio"
