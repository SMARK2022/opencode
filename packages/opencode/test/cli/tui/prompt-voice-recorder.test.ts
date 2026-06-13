import { beforeEach, describe, expect, mock, test } from "bun:test"

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
