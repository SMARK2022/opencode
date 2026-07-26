import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { randomUUID } from "crypto"
import fs from "fs/promises"
import path from "path"
import { Global } from "@opencode-ai/core/global"
import { mkdtemp } from "node:fs/promises"
import os from "node:os"
import { PromptVoiceAssets } from "../../src/prompt-voice-assets"

test("generates the same recorder resources for legacy and native build roots", () => {
  const roots = [path.resolve("legacy-build"), path.resolve("native", "nested", "build")]
  const targets = [
    ["win32", "x64", ["windows/amd64/pv_recorder.node"]],
    ["win32", "arm64", ["windows/arm64/pv_recorder.node"]],
    ["darwin", "x64", ["mac/x86_64/pv_recorder.node"]],
    ["darwin", "arm64", ["mac/arm64/pv_recorder.node"]],
    ["linux", "x64", ["linux/x86_64/pv_recorder.node"]],
    ["linux", "arm64", ["raspberry-pi/cortex-a53-aarch64/pv_recorder.node", "raspberry-pi/cortex-a72-aarch64/pv_recorder.node", "raspberry-pi/cortex-a76-aarch64/pv_recorder.node"]],
  ] as const
  for (const [os, arch, expected] of targets) {
    const paths = roots.map((root) => {
      const text = PromptVoiceAssets.createPvRecorderNativeFileMap({ os, arch }, root)
      expected.forEach((key, index) => expect(text).toContain(`${JSON.stringify(key)}: file_${index},`))
      // 只解析真实生成函数的file-loader引用，不编译产物、加载addon或读取二进制计算校验码。
      const files = [...text.matchAll(/^import file_\d+ from (".*") with \{ type: "file" \};$/gm)].map((match) => {
        const spec: unknown = JSON.parse(match[1])
        if (typeof spec !== "string") throw new Error("Expected a generated file import")
        return path.resolve(root, spec)
      })
      expect(files).toHaveLength(expected.length)
      expected.forEach((key, index) => expect(files[index]?.replaceAll("\\", "/")).toEndWith(`/lib/${key}`))
      return files
    })
    expect(paths[0]).toEqual(paths[1])
  }
})

// #558：fake Worker 保持与真实 Worker 相同的 SharedArrayBuffer stop 契约；
// 帧值 7777 证明 WAV 内容来自 Worker 消息而非主线程构造。
class FakeVoiceWorker {
  static terminalError: string | undefined
  static startupError: string | undefined
  static terminateCount = 0
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  private timer: ReturnType<typeof setInterval> | undefined

  postMessage(message: { type: string; control?: SharedArrayBuffer }) {
    if (message.type !== "start" || !message.control) return
    const control = new Int32Array(message.control) // fake沿生产原子停止边界，不创建线程。
    queueMicrotask(() => {
      if (FakeVoiceWorker.startupError) {
        this.onerror?.(new ErrorEvent("error", { message: FakeVoiceWorker.startupError })) // 启动错误必须先于ready拒绝。
        return
      }
      this.onmessage?.(new MessageEvent("message", { data: { type: "started" } })) // ready先于帧投递。
      this.onmessage?.(new MessageEvent("message", { data: { type: "frame", frame: new Int16Array(4).fill(7_777) } })) // 固定PCM证明实际WAV路径。
      if (FakeVoiceWorker.terminalError) this.onmessage?.(new MessageEvent("message", { data: { type: "error", message: FakeVoiceWorker.terminalError } })) // 错误终态不能变成成功停止。
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
  const tmpRoot = Global.Path.tmp
  beforeEach(async () => {
    // 每例只扫描自己创建的目录，旧WAV清理不能碰全局缓存或其它会话的录音。
    Global.Path.tmp = await fs.mkdtemp(path.join(tmpRoot, "voice-recorder-test-"))
    FakeVoiceWorker.terminalError = undefined
    FakeVoiceWorker.startupError = undefined
    FakeVoiceWorker.terminateCount = 0
    Reflect.set(globalThis, "Worker", FakeVoiceWorker)
    Reflect.deleteProperty(globalThis, "OPENCODE_COMPILED")
    Reflect.deleteProperty(globalThis, "OPENCODE_VOICE_WORKER_PATH")
  })

  afterEach(async () => {
    const dir = Global.Path.tmp
    Global.Path.tmp = tmpRoot
    Reflect.set(globalThis, "Worker", NativeWorker)
    // 两个 compile define 都必须还原，否则最后一个用例的值会泄漏给同进程的其它测试文件。
    Reflect.deleteProperty(globalThis, "OPENCODE_COMPILED")
    Reflect.deleteProperty(globalThis, "OPENCODE_VOICE_WORKER_PATH")
    // 先还原所有共享配置，再回收本例唯一目录。
    await fs.rm(dir, { recursive: true, force: true })
  })

  // #558（INV-B1）：Worker 独立拥有同步 native read——TUI 主线程 busyWait 100ms 期间帧仍持续投递。
  test("continues native reads while the TUI event loop is stalled", async () => {
    await using tmp = await tmpdir()
    const result = await runNativeWorker(tmp.path, fakeNativeSource({ log: path.join(tmp.path, "native.log") }), {
      stallMain: 100,
    })

    expect(result.frames.length).toBeGreaterThan(2)
  })

  // #558（INV-B2）：stop 原子位发布后，正在阻塞中的 read 完成帧不得再投递。
  test("does not deliver a native read that completes after stop is requested", async () => {
    await using tmp = await tmpdir()
    const result = await runNativeWorker(
      tmp.path,
      fakeNativeSource({ log: path.join(tmp.path, "native.log"), readDelay: 50, sample: 9_999 }),
    )

    expect(result.terminal).toBe("stopped")
    expect(result.frames).toEqual([])
  })

  // #558（INV-B4）：init/start/read 各自取得不同的清理权——cleanup 动作序列按阶段收敛。
  const failures = [
    { name: "init", input: { initStatus: 8 }, actions: ["init"], message: "initialize failed" },
    { name: "start", input: { startStatus: 8 }, actions: ["init", "start", "delete"], message: "start failed" },
    { name: "read", input: { readStatus: 8, stopStatus: 8 }, actions: ["init", "start", "read", "stop", "delete"], message: "read failed" },
  ] as const

  // #558（INV-B4）：清理权矩阵——每阶段只清理已取得的资源，动作序列逐字断言。
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

  // #558（INV-B4b）：stop/delete 清理失败是 best-effort 诊断——不能改写已完成的录音结果。
  // #558（INV-B4b）：cleanup 失败不改写录音结果——terminal 仍为 stopped。
  test("keeps normal completion when native cleanup fails", async () => {
    for (const failure of [{ stopStatus: 8 }, { deleteThrows: true }]) {
      await using tmp = await tmpdir()
      const log = path.join(tmp.path, "native.log")
      const result = await runNativeWorker(tmp.path, fakeNativeSource({ ...failure, log }), { stopOnStarted: false, stopOnFrame: true })

      expect(result.terminal).toBe("stopped") // cleanup状态不能改写已完成录音。
      expect(result.frames.length).toBeGreaterThan(0)
      const actions = (await Bun.file(log).text()).trim().split("\n")
      expect(actions.filter((action) => action === "stop")).toEqual(["stop"])
      expect(actions.filter((action) => action === "delete")).toEqual(["delete"])
    }
  })

  // 崩溃或强杀会绕过 handle.abort()，因此下一次真实录音启动前要清理很久以前的 prompt WAV。
  // #558：清理只针对 24h 前崩溃残留——新近 WAV 不得被前缀误删。
  test("removes only stale prompt wav files on startup", async () => {
    const { startPromptVoiceRecorder } = await import("../../src/prompt-voice-recorder")
    const dir = path.join(Global.Path.tmp, "voice")
    const stale = path.join(dir, `prompt-${Date.now() - 25 * 60 * 60 * 1_000}-${randomUUID()}.wav`)
    const fresh = path.join(dir, `prompt-${Date.now()}-${randomUUID()}.wav`)
    await fs.mkdir(dir, { recursive: true })
    await Promise.all([fs.writeFile(stale, "stale"), fs.writeFile(fresh, "fresh")])
    // 目标 isStaleFile 以 mtime 判定——文件名时间戳之外还需回写 utimes 才能制造真实陈旧态。
    const old = new Date(Date.now() - 25 * 60 * 60 * 1_000)
    await fs.utimes(stale, old, old)

    const recorder = await startPromptVoiceRecorder()
    try {
      await waitForMissing(stale)
      // 新近文件代表另一个可能仍在转写的 Prompt，清理任务不能按 prompt-*.wav 前缀全部删除。
      expect(await Bun.file(fresh).exists()).toBe(true)
    } finally {
      await recorder.abort()
      await fs.rm(fresh, { force: true })
    }
  })

  // #558：WAV 帧来自 Worker 消息序——RIFF/WAVE 头与首个 sample 7777 是公开结果。
  // #558：WAV 公开结果来自 Worker 帧（7777），RIFF/WAVE 头由主线程写。
  test("writes WAV frames delivered by the recorder Worker", async () => {
    const { startPromptVoiceRecorder } = await import("../../src/prompt-voice-recorder")

    const recorder = await startPromptVoiceRecorder()
    await recorder.stop()

    const wav = Buffer.from(await Bun.file(recorder.file).arrayBuffer())
    expect(wav.subarray(0, 4).toString()).toBe("RIFF")
    expect(wav.subarray(8, 12).toString()).toBe("WAVE")
    expect(wav.readInt16LE(44)).toBe(7_777)

    await recorder.abort()
    expect(await Bun.file(recorder.file).exists()).toBe(false)
  })

  // compiled exe 不能在 native 资源缺失时回退到 @picovoice 包路径，否则会重新触发 CI 绝对路径加载错误。
  test("compiled builds fail clearly when the embedded recorder addon is unavailable", async () => {
    Reflect.set(globalThis, "OPENCODE_COMPILED", true)
    Reflect.set(globalThis, "OPENCODE_VOICE_WORKER_PATH", "voice-worker.js")
    const { startPromptVoiceRecorder } = await import("../../src/prompt-voice-recorder")
    await expect(startPromptVoiceRecorder()).rejects.toThrow(/native addon is missing/)
  })

  // native read 失败必须反馈给 stop 调用者，TUI 才能展示明确错误。
  // abort 在 stop 失败后仍可调用，覆盖 close finally 中的二次清理路径。
  // #558：read 失败经 error terminal 反馈 stop——terminate 恰一次且无 WAV 残留。
  test("releases the recorder and leaves no WAV file when native reading fails", async () => {
    FakeVoiceWorker.terminalError = "PvRecorder read failed with status 8"
    const { startPromptVoiceRecorder } = await import("../../src/prompt-voice-recorder")
    const recorder = await startPromptVoiceRecorder()
    await expect(recorder.stop()).rejects.toThrow(/PvRecorder read failed/)
    expect(FakeVoiceWorker.terminateCount).toBe(1)
    expect(await Bun.file(recorder.file).exists()).toBe(false)
    await recorder.abort()
  })

  // abort 是 cleanup 边界：旧错误不得阻塞资源释放与临时文件删除。
  // terminateCount 保持一次，避免重复释放 native handle 引发 addon 错误。
  // #558：abort 是 cleanup 边界——旧错误不得阻塞资源释放与文件删除。
  test("abort is best-effort after native reading fails", async () => {
    FakeVoiceWorker.terminalError = "PvRecorder read failed with status 8"
    const { startPromptVoiceRecorder } = await import("../../src/prompt-voice-recorder")
    const recorder = await startPromptVoiceRecorder()
    await expect(recorder.abort()).resolves.toBeUndefined()
    expect(FakeVoiceWorker.terminateCount).toBe(1)
    expect(await Bun.file(recorder.file).exists()).toBe(false)
  })

  // #558（INV-B4a）：Worker 启动前失败——start 直接拒绝且 Worker 被 terminate，无半初始化 recorder。
  test("rejects startup and terminates a Worker that fails before started", async () => {
    FakeVoiceWorker.startupError = "voice Worker module failed"
    const { startPromptVoiceRecorder } = await import("../../src/prompt-voice-recorder")

    await expect(startPromptVoiceRecorder()).rejects.toThrow("voice Worker module failed")
    expect(FakeVoiceWorker.terminateCount).toBe(1)
  })
})

// 目标 tui 无共享 tmpdir fixture——本地 helper 保持 await using 语义（结束即清理）。
async function tmpdir() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "opencode-tui-voice-"))
  return {
    path: directory,
    async [Symbol.asyncDispose]() {
      await fs.rm(directory, { recursive: true, force: true })
    },
  }
}

async function waitForMissing(file: string) {
  // 清理在录音启动路径上异步 fire-and-forget；轮询文件结果比检查内部 Promise 更贴近用户可见行为。
  for (let attempt = 0; attempt < 100 && (await Bun.file(file).exists()); attempt++) await Bun.sleep(10)
  if (await Bun.file(file).exists()) throw new Error(`file still exists: ${file}`)
}

// #558：busyWait 只用于主线程阻塞模拟——真实 Worker 独立线程不受影响，这正是本修复的 INV。
function busyWait(ms: number) {
  for (const start = performance.now(); performance.now() < start + ms;) {}
}

// 真实 Worker + 临时 fake `.cjs` native addon——验证 Worker 侧 native 所有权与原子 stop 边界。
// #558：真实 Worker + fake `.cjs` native——验证原子 stop 边界与帧所有权转移。
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
  const worker = new NativeWorker(new URL("../../src/prompt-voice-recorder-worker.ts", import.meta.url).href)
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

// fake native addon：动作日志（init/start/read/stop/delete）+ 状态码/延迟/样本值全可控。
  // #558：fake addon 动作日志——断言 Worker 清理权序列的唯一证据源。
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
