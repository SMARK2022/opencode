import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { randomUUID } from "crypto"
import fs from "fs/promises"
import path from "path"
import { Global } from "@opencode-ai/core/global"
import { tmpdir } from "../../fixture/fixture"

class FakeVoiceWorker {
  static terminalError: string | undefined
  static startupError: string | undefined
  static terminateCount = 0
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  private timer: ReturnType<typeof setInterval> | undefined

  postMessage(message: { type: string; control?: SharedArrayBuffer }) {
    if (message.type !== "start" || !message.control) return
    const control = new Int32Array(message.control) // fake keeps the same shared stop contract as the real Worker.
    queueMicrotask(() => {
      if (FakeVoiceWorker.startupError) {
        this.onerror?.(new ErrorEvent("error", { message: FakeVoiceWorker.startupError })) // startup error must reject before started.
        return
      }
      this.onmessage?.(new MessageEvent("message", { data: { type: "started" } })) // readiness precedes frame delivery.
      this.onmessage?.(new MessageEvent("message", { data: { type: "frame", frame: new Int16Array(4).fill(7_777) } })) // deterministic PCM proves the public WAV path.
      if (FakeVoiceWorker.terminalError) this.onmessage?.(new MessageEvent("message", { data: { type: "error", message: FakeVoiceWorker.terminalError } })) // terminal error never becomes a successful stop.
    })
    if (FakeVoiceWorker.terminalError) return
    this.timer = setInterval(() => {
      if (Atomics.load(control, 0) === 0) return
      clearInterval(this.timer)
      this.onmessage?.(new MessageEvent("message", { data: { type: "stopped" } }))
    }, 1)
  }

  terminate() {
    FakeVoiceWorker.terminateCount++
    clearInterval(this.timer)
  }
}

const NativeWorker = globalThis.Worker

describe("prompt voice recorder", () => {
  beforeEach(() => {
    FakeVoiceWorker.terminalError = undefined
    FakeVoiceWorker.startupError = undefined
    FakeVoiceWorker.terminateCount = 0
    Reflect.set(globalThis, "Worker", FakeVoiceWorker)
    Reflect.deleteProperty(globalThis, "OPENCODE_COMPILED")
    Reflect.deleteProperty(globalThis, "OPENCODE_VOICE_WORKER_PATH")
  })

  afterEach(() => {
    Reflect.set(globalThis, "Worker", NativeWorker)
    // 两个 compile define 都必须还原，否则最后一个用例的值会泄漏给同进程的其它测试文件。
    Reflect.deleteProperty(globalThis, "OPENCODE_COMPILED")
    Reflect.deleteProperty(globalThis, "OPENCODE_VOICE_WORKER_PATH")
  })

  test("continues native reads while the TUI event loop is stalled", async () => {
    await using tmp = await tmpdir()
    const result = await runNativeWorker(tmp.path, fakeNativeSource({ log: path.join(tmp.path, "native.log") }), {
      stallMain: 100,
    })

    // Worker 独立拥有同步 native read；堵住 TUI 线程时，录音帧仍会排进 message queue。
    expect(result.frames.length).toBeGreaterThan(2)
  })

  test("does not deliver a native read that completes after stop is requested", async () => {
    await using tmp = await tmpdir()
    const result = await runNativeWorker(
      tmp.path,
      fakeNativeSource({ log: path.join(tmp.path, "native.log"), readDelay: 50, sample: 9_999 }),
    )

    // started 后 Worker 已进入同步 read；主线程此时发布 stop，完成中的 sample 不得越过原子边界。
    expect(result.terminal).toBe("stopped")
    expect(result.frames).toEqual([])
  })

  const failures = [ // matrix mirrors ownership: init, start, and read acquire different cleanup rights.
    { name: "init", input: { initStatus: 8 }, actions: ["init"], message: "initialize failed" },
    { name: "start", input: { startStatus: 8 }, actions: ["init", "start", "delete"], message: "start failed" },
    { name: "read", input: { readStatus: 8, stopStatus: 8 }, actions: ["init", "start", "read", "stop", "delete"], message: "read failed" },
  ] as const

  test("owns native init, start, and read failure cleanup before the error terminal", async () => {
    for (const failure of failures) {
      await using tmp = await tmpdir()
      const log = path.join(tmp.path, "native.log")
      const result = await runNativeWorker(tmp.path, fakeNativeSource({ ...failure.input, log }), {
        stopOnStarted: failure.name !== "read",
      })

      // 每个阶段只清理自己已经取得的资源；后续 cleanup 不能覆盖最先发生的 native 错误。
      expect(result.terminal).toBe("error")
      expect(result.message).toContain(failure.message)
      expect((await Bun.file(log).text()).trim().split("\n")).toEqual([...failure.actions])
    }
  })

  test("keeps normal completion when native cleanup fails", async () => {
    for (const failure of [{ stopStatus: 8 }, { deleteThrows: true }]) {
      await using tmp = await tmpdir()
      const log = path.join(tmp.path, "native.log")
      const result = await runNativeWorker(tmp.path, fakeNativeSource({ ...failure, log }), { stopOnStarted: false, stopOnFrame: true })

      // stop/delete 是单次 best-effort cleanup；已经接受的录音不能因清理诊断被改写成失败。
      expect(result.terminal).toBe("stopped") // cleanup status cannot rewrite a completed recording.
      expect(result.frames.length).toBeGreaterThan(0)
      const actions = (await Bun.file(log).text()).trim().split("\n")
      expect(actions.filter((action) => action === "stop")).toEqual(["stop"])
      expect(actions.filter((action) => action === "delete")).toEqual(["delete"])
    }
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

  test("writes WAV frames delivered by the recorder Worker", async () => {
    const { startPromptVoiceRecorder } = await import("../../../src/cli/cmd/tui/prompt-voice-recorder")
    const recorder = await startPromptVoiceRecorder()
    await recorder.stop()

    // WAV 头与首个 sample 是转写入口可见的公开结果，7777 来自 Worker 而非主线程构造。
    const wav = Buffer.from(await Bun.file(recorder.file).arrayBuffer())
    expect(wav.subarray(0, 4).toString()).toBe("RIFF")
    expect(wav.subarray(8, 12).toString()).toBe("WAVE")
    expect(wav.readInt16LE(44)).toBe(7_777)
    await recorder.abort()
    expect(await Bun.file(recorder.file).exists()).toBe(false)
  })

  // compiled exe 不能在 native 资源缺失时回退到 @picovoice 包路径，否则会重新触发 CI 绝对路径加载错误。
  // 这里保留 @picovoice 的 fake mock：如果实现错误地 fallback，测试会进入录音成功路径而不是用户可见错误。
  test("compiled builds fail clearly when the embedded recorder addon is unavailable", async () => {
    Reflect.set(globalThis, "OPENCODE_COMPILED", true)
    Reflect.set(globalThis, "OPENCODE_VOICE_WORKER_PATH", "voice-worker.js")
    const { startPromptVoiceRecorder } = await import("../../../src/cli/cmd/tui/prompt-voice-recorder")

    await expect(startPromptVoiceRecorder()).rejects.toThrow(/native addon is missing/)
  })

  // native read 失败必须反馈给 stop 调用者，TUI 才能展示明确错误。
  // 失败后 recorder 要停止并释放一次，避免麦克风句柄被坏状态占住。
  // 不写 WAV 是重要不变量：损坏或不完整的音频不能继续交给转写器。
  // abort 在 stop 失败后仍可调用，覆盖 controller finally 中的二次清理路径。
  // 该测试用 status=8 模拟底层库错误，不依赖真实硬件故障。
  test("releases the recorder and leaves no WAV file when native reading fails", async () => {
    FakeVoiceWorker.terminalError = "PvRecorder read failed with status 8"
    const { startPromptVoiceRecorder } = await import("../../../src/cli/cmd/tui/prompt-voice-recorder")

    const recorder = await startPromptVoiceRecorder()

    await expect(recorder.stop()).rejects.toThrow(/PvRecorder read failed/)
    expect(FakeVoiceWorker.terminateCount).toBe(1)
    expect(await Bun.file(recorder.file).exists()).toBe(false)

    await recorder.abort()
  })

  // abort 是卸载/取消边界，语义上必须 best-effort，而不是把旧 read 错误再抛给 UI。
  // 即使后台 recording Promise 已经失败，abort 仍要释放 native recorder。
  // 这里验证没有 WAV 残留，防止用户取消后留下包含隐私语音的临时文件。
  // releaseCount 保持一次，避免重复释放 native handle 引发 addon 错误。
  // 该用例保护 Prompt 卸载和用户中断时的清理可靠性。
  test("abort is best-effort after native reading fails", async () => {
    FakeVoiceWorker.terminalError = "PvRecorder read failed with status 8"
    const { startPromptVoiceRecorder } = await import("../../../src/cli/cmd/tui/prompt-voice-recorder")

    const recorder = await startPromptVoiceRecorder()

    await expect(recorder.abort()).resolves.toBeUndefined()
    expect(FakeVoiceWorker.terminateCount).toBe(1)
    expect(await Bun.file(recorder.file).exists()).toBe(false)
  })

  test("rejects startup and terminates a Worker that fails before started", async () => {
    FakeVoiceWorker.startupError = "voice Worker module failed"
    const { startPromptVoiceRecorder } = await import("../../../src/cli/cmd/tui/prompt-voice-recorder")

    await expect(startPromptVoiceRecorder()).rejects.toThrow("voice Worker module failed")
    expect(FakeVoiceWorker.terminateCount).toBe(1)
  })
})

async function waitForMissing(file: string) {
  // 清理在录音启动路径上异步 fire-and-forget；轮询文件结果比检查内部 Promise 更贴近用户可见行为。
  for (let attempt = 0; attempt < 100 && (await Bun.file(file).exists()); attempt++) await Bun.sleep(10)
  if (await Bun.file(file).exists()) throw new Error(`file still exists: ${file}`)
}


function busyWait(ms: number) {
  for (const start = performance.now(); performance.now() < start + ms;) {}
}

async function runNativeWorker(
  dir: string,
  source: string,
  options: { stopOnStarted?: boolean; stopOnFrame?: boolean; stallMain?: number } = { stopOnStarted: true },
) {
  const native = path.join(dir, "fake-pvrecorder.cjs")
  await Bun.write(native, source)
  const control = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)
  const frames: number[] = []
  const done = Promise.withResolvers<{ terminal: "stopped" | "error"; message?: string }>()
  const worker = new NativeWorker(new URL("../../../src/cli/cmd/tui/prompt-voice-recorder-worker.ts", import.meta.url).href)
  worker.onmessage = ({ data }: MessageEvent<{ type: string; frame?: Int16Array; message?: string }>) => {
    if (data.type === "started") {
      if (options.stallMain) busyWait(options.stallMain)
      if (options.stopOnStarted !== false) Atomics.store(new Int32Array(control), 0, 1)
    }
    if (data.type === "frame" && data.frame) {
      frames.push(data.frame[0] ?? 0)
      if (options.stopOnFrame) Atomics.store(new Int32Array(control), 0, 1)
    }
    if (data.type === "stopped") done.resolve({ terminal: "stopped" })
    if (data.type === "error") done.resolve({ terminal: "error", message: data.message })
  }
  worker.onerror = (event) => done.reject(new Error(event.message))

  try {
    worker.postMessage({ type: "start", native, frameLength: 4, bufferedFrames: 250, control })
    return { ...(await done.promise), frames }
  } finally {
    worker.terminate()
  }
}

function fakeNativeSource(input: {
  log: string
  initStatus?: number
  startStatus?: number
  readStatus?: number
  stopStatus?: number
  deleteThrows?: boolean
  readDelay?: number
  sample?: number
}) {
  return [
    `const fs = require("fs")`,
    `const wait = new Int32Array(new SharedArrayBuffer(4))`,
    `const mark = (action) => fs.appendFileSync(${JSON.stringify(input.log)}, action + "\\n")`,
    `module.exports = {`,
    `  init: () => { mark("init"); return { status: ${input.initStatus ?? 0}, handle: 1n } },`,
    `  start: () => { mark("start"); return ${input.startStatus ?? 0} },`,
    `  read: (_handle, pcm) => { mark("read"); Atomics.wait(wait, 0, 0, ${input.readDelay ?? 1}); pcm.fill(${input.sample ?? 321}); return ${input.readStatus ?? 0} },`,
    `  stop: () => { mark("stop"); return ${input.stopStatus ?? 0} },`,
    `  delete: () => { mark("delete"); ${input.deleteThrows ? 'throw new Error("delete failed")' : ""} },`,
    `}`,
  ].join("\n")
}
