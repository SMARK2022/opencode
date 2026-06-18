import { beforeEach, describe, expect, mock, test } from "bun:test"
import { randomUUID } from "crypto"
import fs from "fs/promises"
import path from "path"
import { Global } from "@opencode-ai/core/global"

class FakePvRecorder {
  static last: FakePvRecorder | undefined
  static readStatus = 0
  static releaseCount = 0
  static readCount = 0
  static readWaiters: Array<() => void> = []
  static queuedFrameValues: number[] = []
  static queuedReadDelayMs = 0
  static liveReadDelayMs = 0
  static liveFrameValue = 321
  static _pvRecorder = {
    read: (_handle: bigint, pcm: Int16Array) => {
      FakePvRecorder.readCount++
      FakePvRecorder.readWaiters.splice(0).forEach((resolve) => resolve())
      if (FakePvRecorder.readStatus !== 0) return FakePvRecorder.readStatus
      // queuedFrameValues 模拟 native circular buffer 中已经录好的历史帧，应该被 stop drain 快速读走。
      const queued = FakePvRecorder.queuedFrameValues.shift()
      if (queued !== undefined && FakePvRecorder.queuedReadDelayMs > 0) busyWait(FakePvRecorder.queuedReadDelayMs)
      // 队列耗尽后的 live read 会阻塞一个帧周期；测试用它证明实现不会继续录入 stop 之后的声音。
      if (queued === undefined && FakePvRecorder.liveReadDelayMs > 0) busyWait(FakePvRecorder.liveReadDelayMs)
      pcm.fill(queued ?? FakePvRecorder.liveFrameValue)
      return 0
    },
  }
  _handle = 1n
  frameLength = 4
  bufferedFramesCount = 50
  started = false

  constructor(_frameLength: number, _deviceIndex = -1, bufferedFramesCount = 50) {
    FakePvRecorder.last = this
    this.bufferedFramesCount = bufferedFramesCount
  }

  start() {
    this.started = true
  }

  stop() {
    this.started = false
  }

  release() {
    FakePvRecorder.releaseCount++
  }

  static queueNativeFrames(count: number) {
    // 保留数量受 constructor 传入的 bufferedFramesCount 限制，行为上贴近 PvRecorder 的内部 circular buffer。
    const retained = Array.from({ length: count }, (_, index) => 1_000 + index).slice(
      -Math.max(0, FakePvRecorder.last?.bufferedFramesCount ?? 0),
    )
    FakePvRecorder.queuedFrameValues.push(...retained)
  }
}

void mock.module("@picovoice/pvrecorder-node", () => ({
  PvRecorder: FakePvRecorder,
}))

describe("prompt voice recorder", () => {
  beforeEach(() => {
    FakePvRecorder.last = undefined
    FakePvRecorder.readStatus = 0
    FakePvRecorder.releaseCount = 0
    FakePvRecorder.readCount = 0
    FakePvRecorder.readWaiters = []
    FakePvRecorder.queuedFrameValues = []
    FakePvRecorder.queuedReadDelayMs = 0
    FakePvRecorder.liveReadDelayMs = 40
    FakePvRecorder.liveFrameValue = 321
    delete (globalThis as { OPENCODE_COMPILED?: boolean }).OPENCODE_COMPILED
  })

  // 崩溃或强杀会绕过 handle.abort()，因此下一次真实录音启动前要清理很久以前的 prompt WAV。
  // 新近 WAV 可能来自另一个仍在停止/转写中的 Prompt，不能只按文件名前缀粗暴删除。
  test("removes stale prompt voice files without deleting recent recordings", async () => {
    const dir = path.join(Global.Path.tmp, "voice")
    await fs.mkdir(dir, { recursive: true })
    const stale = path.join(dir, `prompt-stale-${randomUUID()}.wav`)
    const recent = path.join(dir, `prompt-recent-${randomUUID()}.wav`)
    await Bun.write(stale, "old voice")
    await Bun.write(recent, "recent voice")
    // 48 小时足够越过 24 小时清理窗口，同时避免依赖文件系统秒级 mtime 精度。
    const old = new Date(Date.now() - 48 * 60 * 60 * 1_000)
    await fs.utimes(stale, old, old)

    const { startPromptVoiceRecorder } = await import("../../../src/cli/cmd/tui/prompt-voice-recorder")
    const recorder = await startPromptVoiceRecorder()
    try {
      await waitForFakeRead()
      await waitForMissing(stale)

      // 新近文件代表另一个可能仍在转写的 Prompt，清理任务不能按 prompt-*.wav 前缀全部删除。
      expect(await Bun.file(recent).exists()).toBe(true)
      // start 阶段只创建目标路径，不应在用户 stop 前留下当前录音 WAV。
      expect(await Bun.file(recorder.file).exists()).toBe(false)
    } finally {
      await recorder.abort()
      await fs.rm(recent, { force: true })
    }
  })

  // compiled exe 不能在 native 资源缺失时回退到 @picovoice 包路径，否则会重新触发 CI 绝对路径加载错误。
  // 这里保留 @picovoice 的 fake mock：如果实现错误地 fallback，测试会进入录音成功路径而不是用户可见错误。
  test("compiled builds fail clearly when the embedded recorder addon is unavailable", async () => {
    const globals = globalThis as { OPENCODE_COMPILED?: boolean }
    globals.OPENCODE_COMPILED = true
    const { startPromptVoiceRecorder } = await import("../../../src/cli/cmd/tui/prompt-voice-recorder")

    await expect(startPromptVoiceRecorder()).rejects.toThrow(/native addon is missing/)
  })

  // 这个正常路径证明录音实现完全在 Bun 进程内完成，不依赖系统 node 可执行文件。
  // FakePvRecorder 写入固定 PCM 值，测试只观察最终 WAV 头和首个 sample。
  // 临时文件随后通过 abort 删除，覆盖 stop 后 cleanup 仍然幂等的行为。
  // OPENCODE_NODE_PATH 被故意设成不存在，用来防止未来退回 node -e 子进程实现。
  // 该用例保护 compile 后单文件 exe 的核心约束：录音不能依赖项目 checkout。
  test("records a WAV file without requiring a system node executable", async () => {
    const previous = process.env.OPENCODE_NODE_PATH
    process.env.OPENCODE_NODE_PATH = "__opencode_missing_node_for_voice_test__"
    const { startPromptVoiceRecorder } = await import("../../../src/cli/cmd/tui/prompt-voice-recorder")

    try {
      const recorder = await startPromptVoiceRecorder()
      await waitForFakeRead()
      await recorder.stop()

      const wav = Buffer.from(await Bun.file(recorder.file).arrayBuffer())

      expect(wav.subarray(0, 4).toString()).toBe("RIFF")
      expect(wav.subarray(8, 12).toString()).toBe("WAVE")
      expect(wav.readInt16LE(44)).toBe(321)

      await recorder.abort()
      expect(await Bun.file(recorder.file).exists()).toBe(false)
    } finally {
      if (previous === undefined) delete process.env.OPENCODE_NODE_PATH
      else process.env.OPENCODE_NODE_PATH = previous
    }
  })

  // 这个回归用例锁定“按 stop 前读取循环必须追上 native 缓冲”的行为。
  // 旧实现每 32ms sleep 后只读一帧，事件循环一旦落后就会把尾部帧留在 PvRecorder 缓冲里。
  // 70ms 内至少读到三帧用于证明 JS 侧没有再人为按帧节流。
  // WAV data size 断言最终写入的是真实读到的多帧 PCM，而不是只看 readCount。
  // finally 中 abort 是测试安全边界，红灯失败也不能留下后台录音循环。
  // 这个缺口对应用户观察到的最后约 1.6 到 2 秒音频未被转写。
  test("keeps native audio reads caught up before the stop key writes the WAV", async () => {
    FakePvRecorder.queuedFrameValues = [321, 321, 321]
    const { startPromptVoiceRecorder } = await import("../../../src/cli/cmd/tui/prompt-voice-recorder")

    const recorder = await startPromptVoiceRecorder()
    try {
      await waitForFakeReadCount(3, 70)
      await recorder.stop()

      const wav = Buffer.from(await Bun.file(recorder.file).arrayBuffer())

      expect(wav.readUInt32LE(40)).toBeGreaterThanOrEqual(3 * FakePvRecorder.last!.frameLength * 2)
    } finally {
      await recorder.abort()
    }
  })

  // 这个用例复现真实诊断：TUI/JS 线程阻塞时，PvRecorder native buffer 会继续积累音频帧。
  // stop 写 WAV 前必须把这些已经存在的 queued 帧读出来，否则最终文件会比用户实际录音短。
  // fake recorder 用 bufferedFramesCount 限制可保留帧数，测试通过行为验证 buffer 预算，而不是读取源码常量。
  // 断言帧数来自 WAV data chunk，确保最终落盘内容完整，而不只是 readCount 变大。
  // 当前旧实现只写首帧；完整修复应写首帧加阻塞期间保留下来的 120 帧。
  test("writes audio buffered during a stalled TUI tick before stopping", async () => {
    const { startPromptVoiceRecorder } = await import("../../../src/cli/cmd/tui/prompt-voice-recorder")

    const recorder = await startPromptVoiceRecorder()
    try {
      await waitForFakeRead()
      FakePvRecorder.queueNativeFrames(120)
      FakePvRecorder.queuedReadDelayMs = 4
      FakePvRecorder.liveReadDelayMs = 40
      FakePvRecorder.liveFrameValue = 9_999
      await recorder.stop()

      const wav = Buffer.from(await Bun.file(recorder.file).arrayBuffer())

      expect(wavFrameCount(wav)).toBe(121)
      expect(wavSamples(wav)).not.toContain(9_999)
    } finally {
      await recorder.abort()
    }
  })

  // native read 失败必须反馈给 stop 调用者，TUI 才能展示明确错误。
  // 失败后 recorder 要停止并释放一次，避免麦克风句柄被坏状态占住。
  // 不写 WAV 是重要不变量：损坏或不完整的音频不能继续交给转写器。
  // abort 在 stop 失败后仍可调用，覆盖 controller finally 中的二次清理路径。
  // 该测试用 status=8 模拟底层库错误，不依赖真实硬件故障。
  test("releases the recorder and leaves no WAV file when native reading fails", async () => {
    FakePvRecorder.readStatus = 8
    const { startPromptVoiceRecorder } = await import("../../../src/cli/cmd/tui/prompt-voice-recorder")

    const recorder = await startPromptVoiceRecorder()
    await waitForFakeRead()

    await expect(recorder.stop()).rejects.toThrow(/PvRecorder read failed/)
    expect(FakePvRecorder.last?.started).toBe(false)
    expect(FakePvRecorder.releaseCount).toBe(1)
    expect(await Bun.file(recorder.file).exists()).toBe(false)

    await recorder.abort()
  })

  // abort 是卸载/取消边界，语义上必须 best-effort，而不是把旧 read 错误再抛给 UI。
  // 即使后台 recording Promise 已经失败，abort 仍要释放 native recorder。
  // 这里验证没有 WAV 残留，防止用户取消后留下包含隐私语音的临时文件。
  // releaseCount 保持一次，避免重复释放 native handle 引发 addon 错误。
  // 该用例保护 Prompt 卸载和用户中断时的清理可靠性。
  test("abort is best-effort after native reading fails", async () => {
    FakePvRecorder.readStatus = 8
    const { startPromptVoiceRecorder } = await import("../../../src/cli/cmd/tui/prompt-voice-recorder")

    const recorder = await startPromptVoiceRecorder()
    await waitForFakeRead()

    await expect(recorder.abort()).resolves.toBeUndefined()
    expect(FakePvRecorder.last?.started).toBe(false)
    expect(FakePvRecorder.releaseCount).toBe(1)
    expect(await Bun.file(recorder.file).exists()).toBe(false)
  })
})

function waitForFakeRead() {
  if (FakePvRecorder.readCount > 0) return Promise.resolve()
  return waitForFakeReadCount(1, 1_000)
}

function waitForMissing(file: string) {
  return new Promise<void>((resolve, reject) => {
    // 清理在录音启动路径上异步 fire-and-forget；轮询文件结果比检查内部 Promise 更贴近用户可见行为。
    const timer = setTimeout(() => reject(new Error(`file still exists: ${file}`)), 1_000)
    const wait = async () => {
      if (!(await Bun.file(file).exists())) {
        clearTimeout(timer)
        resolve()
        return
      }
      setTimeout(wait, 10)
    }
    void wait()
  })
}

function waitForFakeReadCount(count: number, timeout: number) {
  if (FakePvRecorder.readCount >= count) return Promise.resolve()
  return new Promise<void>((resolve, reject) => {
    // timeout 是测试防挂保护：如果读取循环再次被节流或卡死，失败后 finally 会负责释放 recorder。
    const timer = setTimeout(() => reject(new Error(`fake recorder read ${FakePvRecorder.readCount} frame(s)`)), timeout)
    const wait = () => {
      if (FakePvRecorder.readCount >= count) {
        clearTimeout(timer)
        resolve()
        return
      }
      // 每次 fake native read 都会唤醒 wait；未达到目标时重新注册，避免用固定 sleep 猜测调度。
      FakePvRecorder.readWaiters.push(wait)
    }
    wait()
  })
}

function wavFrameCount(wav: Buffer) {
  return wav.readUInt32LE(40) / (FakePvRecorder.last!.frameLength * Int16Array.BYTES_PER_ELEMENT)
}

function wavSamples(wav: Buffer) {
  // 解码 PCM sample 比搜索字节序列更可靠，避免 WAV header 或跨 sample 字节组合造成误判。
  return Array.from({ length: wav.readUInt32LE(40) / Int16Array.BYTES_PER_ELEMENT }, (_, index) => wav.readInt16LE(44 + index * Int16Array.BYTES_PER_ELEMENT))
}

function busyWait(ms: number) {
  const until = performance.now() + ms
  while (performance.now() < until) {}
}
