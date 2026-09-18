import { PromptVoiceInput } from "../../src/prompt-voice-input"
import { resolveVoiceTarget } from "@opencode-ai/core/voice"
import { describe, expect, spyOn, test } from "bun:test"
import { createRequire } from "node:module"
import path from "path"
import { createRoot, createSignal } from "solid-js"
import { Effect } from "effect"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { TuiConfigHost } from "../../src/config/host"
import { tmpdir } from "../fixture/fixture"
import {
  createVoiceInputController,
  VOICE_TRANSCRIBE_TIMEOUT_MS,
  voiceInputStatusText,
  voiceHintVisible,
  type VoiceRecorderHandle,
} from "../../src/prompt-voice-input"
// createRefreshClock 是录音计时器走数的基础设施（主 Prompt 的 now 信号由它驱动）
import { createRefreshClock } from "../../src/util/signal"

const compiledVoice = process.platform === "win32" ? test : test.skip

// standalone 必须加载真实 native addon 后再走上传，才能覆盖 Bun.file 正文的实际所有权，而非只验证源码运行时。
async function compileVoiceUploadFixture(directory: string, file: string, native: string) {
  // 入口和产物都放在测试临时目录，避免编译测试依赖仓库外的音频或留下仓库文件。
  const entry = path.join(directory, "compiled-submit-voice.ts")
  const production = path.resolve(import.meta.dir, "../../src/prompt-voice-input.ts")
  // 入口绝对导入当前生产模块，不能复制 submitVoice 实现来制造假绿。
  await Bun.write(entry, `
    import { createRequire } from "node:module"
    import { submitVoice } from ${JSON.stringify(production.replaceAll("\\", "/"))}
    const require = createRequire(import.meta.url)
    require(${JSON.stringify(native)})
    const received = Promise.withResolvers<{ authorization: string | null; directory: string | null; bytes: number[] }>()
    // 回环服务只观察真实上传协议，正文消费完成后才返回响应。
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        received.resolve({
          authorization: request.headers.get("authorization"),
          directory: new URL(request.url).searchParams.get("directory"),
          bytes: [...new Uint8Array(await request.arrayBuffer())],
        })
        // 固定响应正文验证 compiled 请求完成后仍能交付文字。
        return Response.json({ text: "standalone transcript" })
      },
    })
    try {
      const text = await submitVoice(${JSON.stringify(file)}, new AbortController().signal, {
        url: server.url.href,
        directory: "standalone-directory",
        fetch: (input, init) => fetch(input, {
          ...init,
          // 认证从 SDK fetch 边界进入，submitVoice 不能绕过既有认证传输。
          headers: { ...init?.headers, authorization: "Bearer standalone-token" },
        }),
      })
      console.log(JSON.stringify({ text, ...(await received.promise) }))
    } finally {
      // 失败路径也关闭测试自己的 listener，避免污染后续测试。
      await server.stop(true)
    }
  `)
  const outfile = path.join(directory, process.platform === "win32" ? "compiled-submit-voice.exe" : "compiled-submit-voice")
  const result = await Bun.build({
    entrypoints: [entry],
    // 不指定跨平台 target，直接使用当前 Bun 的 standalone runtime，避免下载不同版本掩盖回归。
    compile: { outfile, autoloadBunfig: false, autoloadDotenv: false },
  })
  if (!result.success) throw new AggregateError(result.logs, "compiled submitVoice fixture failed to build")
  return { outfile, entry }
}

describe("prompt voice input", () => {
  // 录音句柄只交给上传函数文件和取消信号，后端目标已从 TUI 参数中移出。
  test("controller submits the recording with its request signal", async () => {
    let submitted: unknown
    const text: string[] = []
    const controller = createVoiceInputController({
      startRecorder: async () => ({ file: "voice.wav", stop: async () => {}, abort: async () => {} }),
      transcribe: async (_file, signal) => { submitted = signal; return "recorded text" },
      insertText: (value) => text.push(value),
    })
    await controller.toggle()
    await controller.toggle()
    expect(submitted).toBeInstanceOf(AbortSignal)
    expect(text).toEqual(["recorded text"])
  })

  // 客户端只上传本地录音字节；认证 fetch、当前 daemon URL 和目录由 SDK 提供。
  test("submits the WAV through the current authenticated daemon transport", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "voice.wav")
    await Bun.write(file, new Uint8Array([82, 73, 70, 70]))
    const signal = new AbortController().signal
    const text = await PromptVoiceInput.submitVoice(file, signal, {
      url: "http://localhost:1234", directory: tmp.path,
      fetch: async (url, init) => {
        expect(new URL(String(url)).pathname).toBe("/tui/voice/transcribe")
        expect(new URL(String(url)).searchParams.get("directory")).toBe(tmp.path)
        expect(init?.signal).toBe(signal)
        expect(await new Response(init?.body).arrayBuffer()).toEqual(await Bun.file(file).arrayBuffer())
        return Response.json({ text: "daemon transcript" })
      },
    })
    expect(text).toBe("daemon transcript")
  })

  // standalone 的 exe 只在 Windows 执行：native addon、真实生产 import 和本地回环必须处于同一进程。
  // 回环服务独立检查认证、目录、响应和完整字节，避免测试重新实现 submitVoice 的正文逻辑。
  compiledVoice("uploads bytes safely from a native-loaded standalone executable", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "standalone.wav")
    const wav = Buffer.alloc(48)
    // fixture 使用独立已知 PCM 字节，不依赖麦克风、Worker 或未 checkout 的音频资源。
    wav.write("RIFF", 0, "ascii")
    wav.writeUInt32LE(40, 4)
    wav.write("WAVE", 8, "ascii")
    wav.write("fmt ", 12, "ascii")
    wav.writeUInt32LE(16, 16)
    wav.writeUInt16LE(1, 20)
    wav.writeUInt16LE(1, 22)
    // 单声道 8kHz、16-bit PCM 的 byteRate 为 16000；头部长度与两个 sample 的 data 长度一致。
    wav.writeUInt32LE(8_000, 24)
    wav.writeUInt32LE(16_000, 28)
    wav.writeUInt16LE(2, 32)
    wav.writeUInt16LE(16, 34)
    wav.write("data", 36, "ascii")
    wav.writeUInt32LE(4, 40)
    wav.writeInt16LE(321, 44)
    wav.writeInt16LE(-321, 46)
    await Bun.write(file, wav)

    const packageRoot = path.dirname(createRequire(import.meta.url).resolve("@picovoice/pvrecorder-node/package.json"))
    const native = path.join(packageRoot, "lib", "windows", process.arch === "x64" ? "amd64" : "arm64", "pv_recorder.node")
    // 缺少已安装 addon 时必须失败，不能回退到源码路径来绕过 native 输入域。
    expect(await Bun.file(native).exists()).toBe(true)
    const compiled = await compileVoiceUploadFixture(tmp.path, file, native)
    // 子进程上界早于测试期限，挂起时先结束 exe，临时目录才不会因 Windows 文件占用而清理失败。
    const child = Bun.spawn([compiled.outfile], { stdout: "pipe", stderr: "pipe", timeout: 10_000 })
    const [exit, stdout, stderr] = await Promise.all([
      // 同时消费两个管道，避免崩溃输出反压掩盖 standalone 的真实退出码。
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" })
    // 期望值来自回环协议和 fixture 字面量，不从 submitVoice 重新计算。
    expect(JSON.parse(stdout.trim())).toEqual({
      text: "standalone transcript",
      authorization: "Bearer standalone-token",
      directory: "standalone-directory",
      bytes: [...wav],
    })
  }, 30_000)

  // 预取消必须在读取文件前结束，避免取消请求仍建立网络副作用。
  test("does not read or fetch when submission is already cancelled", async () => {
    const abort = new AbortController()
    abort.abort()
    let read = false
    let fetched = false
    const originalFile = Bun.file
    const file = originalFile("voice.wav")
    const reading = spyOn(file, "arrayBuffer").mockImplementation(async () => {
      read = true
      return new ArrayBuffer(0)
    })
    const fileCall = spyOn(Bun, "file").mockReturnValue(file)
    // 只替代文件系统边界；被测入口仍是实际 submitVoice。
    try {
      await expect(PromptVoiceInput.submitVoice("voice.wav", abort.signal, {
        url: "http://localhost:1234",
        fetch: async () => {
          fetched = true
          return Response.json({ text: "unexpected" })
        },
      })).rejects.toMatchObject({ name: "AbortError" })
      expect(read).toBe(false)
      expect(fetched).toBe(false)
    } finally {
      // 还原全局文件入口，防止取消测试影响后续真实文件读取。
      fileCall.mockRestore()
      reading.mockRestore()
    }
  })

  // 读取完成后取消仍不得进入 SDK fetch；该闸门直接保护“读取后再检查 signal”的批准顺序。
  test("does not fetch when cancellation arrives after the file has been read", async () => {
    await using tmp = await tmpdir()
    const filePath = path.join(tmp.path, "voice.wav")
    await Bun.write(filePath, "known wav bytes")
    const abort = new AbortController()
    const originalFile = Bun.file
    const file = originalFile(filePath)
    const reading = spyOn(file, "arrayBuffer").mockImplementation(async () => {
      // 取消点位于真实字节读取完成之后，用来区分读后检查与 fetch 内检查。
      const bytes = await originalFile(filePath).arrayBuffer()
      abort.abort()
      return bytes
    })
    const fileCall = spyOn(Bun, "file").mockReturnValue(file)
    let fetched = false
    try {
      await expect(PromptVoiceInput.submitVoice(filePath, abort.signal, {
        url: "http://localhost:1234",
        fetch: async () => {
          fetched = true
          return Response.json({ text: "unexpected" })
        },
      })).rejects.toMatchObject({ name: "AbortError" })
      expect(fetched).toBe(false)
    } finally {
      // 闸门结束后恢复文件边界，保持其它上传协议测试相互独立。
      fileCall.mockRestore()
      reading.mockRestore()
    }
  })

  // R9 将上传、等锁和转录合并为固定整轮预算，不再保留浏览器四轮重试窗口。
  test("limits the complete submission to 120 seconds", () => {
    expect(VOICE_TRANSCRIBE_TIMEOUT_MS).toBe(120_000)
  })

  // 使用真实计时器而非替换 timeout：常量正确但未接到提交信号的实现也必须报红。
  // 两个 TUI 错开启动，首轮到点不能中断次轮；每轮必须从各自 WAV 完成时开始计时。
  test("independently aborts each transcription at its real 120-second deadline", async () => {
    const signals: AbortSignal[] = []
    const elapsed: number[] = []
    const errors: string[][] = [[], []]
    const inserted: string[] = []
    const cleaned: number[] = []
    const controllers = errors.map((messages, index) => createVoiceInputController({
      startRecorder: async () => ({ file: `${index}.wav`, stop: async () => {}, abort: async () => { cleaned.push(index) } }),
      transcribe: (_file, signal) => {
        signals.push(signal)
        const start = performance.now()
        return new Promise<string>((_resolve, reject) => signal.addEventListener("abort", () => {
          elapsed[index] = performance.now() - start
          reject(signal.reason)
        }, { once: true }))
      },
      insertText: (text) => inserted.push(text),
      onError: (message) => messages.push(message),
    }))
    // Bun 的未决 Promise 检测需要活跃句柄；此 interval 不参与生产 timeout 的触发。
    const keepAlive = setInterval(() => {}, 1_000)
    const first = controllers[0]
    const second = controllers[1]
    try {
      await first.toggle()
      const pending = first.toggle()
      await Bun.sleep(1_000)
      await second.toggle()
      const next = second.toggle()
      await pending
      // 必须同时观察首轮超时原因和次轮仍在运行，才能排除多个 controller 共享取消源。
      expect(signals[0].aborted).toBe(true)
      expect(signals[0].reason.name).toBe("TimeoutError")
      expect(signals[1].aborted).toBe(false)
      expect(second.status().type).toBe("transcribing")
      await next
      expect(signals[1].reason.name).toBe("TimeoutError")
      // 独立字面量来自 R9 合同；容忍调度延迟，但绝不能提前到点或沿用旧 1237 秒预算。
      for (const duration of elapsed) {
        expect(duration).toBeGreaterThanOrEqual(119_900)
        expect(duration).toBeLessThan(125_000)
      }
      expect(errors).toEqual([["语音转录超时（120 秒）"], ["语音转录超时（120 秒）"]])
      // 超时提示不能代替资源收尾；两轮都必须删除自己的录音且不向 prompt 交付任何文字。
      expect(inserted).toEqual([])
      expect(cleaned).toEqual([0, 1])
      expect(controllers.map((controller) => controller.status().type)).toEqual(["idle", "idle"])
    } finally {
      await Promise.all(controllers.map((controller) => controller.abort()))
      clearInterval(keepAlive)
    }
  }, 135_000)

  // 真正的 HTTP 请求分别停在响应头之前与 JSON 正文中间，不能只验证 signal 参数相等。
  // 部分正文保证 fetch 已成功而 json 仍挂起，覆盖容易被提前结束预算遗漏的阶段。
  test.each(["submission", "body"])("cancels the HTTP %s without returning late text", async (phase) => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "voice.wav")
    await Bun.write(file, "RIFF....WAVE")
    const ready = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const abort = new AbortController()
    const server = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      async fetch(request) {
        // 先确认完整 WAV 已到达再触发取消，避免仅测试到连接尚未建立的提前 abort。
        expect(request.method).toBe("POST")
        expect(request.headers.get("content-type")).toBe("audio/wav")
        expect(await request.text()).toBe("RIFF....WAVE")
        if (phase === "submission") {
          ready.resolve()
          await release.promise
          return Response.json({ text: "late text" })
        }
        return new Response(new ReadableStream({
          start(controller) { controller.enqueue(new TextEncoder().encode('{"text":"')) },
        }), { headers: { "content-type": "application/json" } })
      },
    })
    try {
      const pending = PromptVoiceInput.submitVoice(file, abort.signal, {
        url: server.url.href,
        fetch: async (url, init) => {
          const response = await fetch(url, init)
          if (phase === "body") ready.resolve()
          return response
        },
      })
      // 先安装 rejection 观察者，避免真实 socket 取消被测试框架误报为未处理错误。
      const outcome = pending.then((text) => ({ text }), (error: unknown) => ({ error }))
      await ready.promise
      abort.abort()
      expect(await outcome).toMatchObject({ error: { name: "AbortError" } })
    } finally {
      // 即使取消断言失败也关闭本测试的 socket，防止悬挂正文影响下一条用例。
      abort.abort()
      release.resolve()
      await server.stop(true)
    }
  })

  // stop 仍在写入时不能删除 WAV，也不能在写入迟到完成后上传已被用户取消的录音。
  test("waits for delayed stop before cleanup and never transcribes a cancelled recording", async () => {
    const saving = Promise.withResolvers<void>()
    const saved = Promise.withResolvers<void>()
    const events: string[] = []
    const controller = createVoiceInputController({
      startRecorder: async () => ({
        file: "voice.wav",
        stop: async () => { saving.resolve(); await saved.promise; events.push("saved") },
        abort: async () => { events.push("removed") },
      }),
      transcribe: async () => { events.push("uploaded"); return "stale text" },
      insertText: () => { events.push("inserted") },
    })
    await controller.toggle()
    const stopping = controller.toggle()
    await saving.promise
    await controller.abort()
    expect(events).toEqual([])
    // idle 只代表界面允许重新操作；保存句柄仍由原 stop 调用负责完成后清理。
    expect(controller.status().type).toBe("idle")
    saved.resolve()
    await stopping
    expect(events).toEqual(["saved", "removed"])
  })

  // 取消后旧上传与清理各有自己的完成点；新录音不能被旧 finally 的迟到状态覆盖。
  test("starts a new recording while cancelled transcription cleanup is still pending", async () => {
    const submitted = Promise.withResolvers<AbortSignal>()
    const response = Promise.withResolvers<string>()
    const cleaning = Promise.withResolvers<void>()
    const cleaned = Promise.withResolvers<void>()
    const inserted: string[] = []
    const errors: string[] = []
    let starts = 0
    const controller = createVoiceInputController({
      startRecorder: async () => {
        const file = `${++starts}.wav`
        return { file, stop: async () => {}, abort: async () => {
          if (file !== "1.wav") return
          cleaning.resolve()
          await cleaned.promise
        } }
      },
      transcribe: (_file, signal) => { submitted.resolve(signal); return response.promise },
      insertText: (text) => inserted.push(text),
      onError: (message) => errors.push(message),
      now: () => 1_000,
    })
    await controller.toggle()
    const old = controller.toggle()
    const signal = await submitted.promise
    await controller.abort()
    expect(signal.aborted).toBe(true)
    // 故意让上传忽略 abort 并迟到成功，验证 controller 自身的交付屏障而非 transport 的善意。
    response.resolve("late text")
    await cleaning.promise
    await controller.toggle()
    expect(controller.status()).toEqual({ type: "recording", startedAt: 1_000 })
    cleaned.resolve()
    await old
    // 旧 finally 已实际返回后再次检查新录音，防止仅在清理前检查状态而漏掉覆盖竞态。
    expect(controller.status()).toEqual({ type: "recording", startedAt: 1_000 })
    expect(inserted).toEqual([])
    expect(errors).toEqual([])
    await controller.abort()
  })

  // footer 文案是用户判断当前语音状态的唯一 TUI 反馈。
  // starting/stopping/transcribing 需要短词提示，recording 必须保留停止快捷键。
  // 这里固定 alt+v 展示，防止未来改文案时隐藏"如何结束录音"。
  // 使用传入 now 可以稳定测试计时显示，不依赖真实时间。
  test("formats active footer status without hiding the stop shortcut", () => {
    expect(voiceInputStatusText({ type: "starting" }, "alt+v", 4_400)).toBe("Starting voice...")
    expect(voiceInputStatusText({ type: "recording", startedAt: 1_000 }, "alt+v", 4_400)).toBe(
      "Recording 00:03 · alt+v stop",
    )
    expect(voiceInputStatusText({ type: "stopping" }, "alt+v", 4_400)).toBe("Saving voice...")
    expect(voiceInputStatusText({ type: "transcribing" }, "alt+v", 4_400)).toBe("Transcribing voice...")
  })
  // createRefreshClock 是三处组件（主 Prompt / QuestionPrompt / DialogPrompt）录音计时器走数的
  // 基础设施：recording 期间每秒刷新 now 信号驱动 voiceInputStatusText 重算，idle 时停止。
  // 该契约此前零测试覆盖——一旦被破坏，question/dialog 组件的计时器会冻结在 00:00
  // （voiceInputStatusText 的 now 参数只在录音开始瞬间求值一次，之后无周期信号触发重算）。
  // 使用 createRoot 隔离响应式作用域，10ms 短间隔加速测试，避免真实 1s 等待。
  test("createRefreshClock ticks while active, stops when inactive, and cleans up on dispose", async () => {
    let readNow: () => number = () => 0
    let setActive: (v: boolean) => void = () => {}
    const dispose = createRoot((d) => {
      const [active, setA] = createSignal(false)
      setActive = setA
      readNow = createRefreshClock(active, 10)
      return d
    })
    try {
      // createEffect 延迟到 microtask 执行；先冲刷一次让初始 effect（active=false）跑完，
      // 确保 idle 基线值取的是 effect 执行后的 now，而非 createSignal 初始值。
      await new Promise((r) => setTimeout(r, 0))
      const idle = readNow()

      // active=true → effect 重跑启动 setInterval，now 应随 interval tick 前进
      setActive(true)
      await new Promise((r) => setTimeout(r, 50))
      expect(readNow()).toBeGreaterThan(idle)

      // active=false → onCleanup 清理 interval，now 停止前进
      setActive(false)
      await new Promise((r) => setTimeout(r, 50))
      const stopped = readNow()
      await new Promise((r) => setTimeout(r, 50))
      expect(readNow()).toBe(stopped)

      // 再次 active 后立即 dispose，模拟组件在录音中被卸载：
      // dispose 必须触发 onCleanup 清理正在运行的 interval，否则定时器泄漏
      setActive(true)
      await new Promise((r) => setTimeout(r, 30))
      const beforeDispose = readNow()
      dispose()
      await new Promise((r) => setTimeout(r, 50))
      // dispose 后 now 不再前进，证明 onCleanup 清理了活跃 interval
      expect(readNow()).toBe(beforeDispose)
    } catch (e) {
      dispose()
      throw e
    }
  })

  // voice 提示是 footer 的引导文案，窄终端会挤占输入区，必须延迟到 prompt 足够宽才显示。
  // 阈值为开区间 ">120"：120 本身仍隐藏，与 usage 显示的 ">90" 同语义，避免边界行为漂移。
  // 后端配置由 daemon 解析，前端不再按本地转写器配置隐藏引导。
  // 该判定只管显示文案，不影响 Alt+V 绑定——窄终端仍可转录，测试只断言显示决策本身。
  test("shows the voice hint only when the prompt is wide enough", () => {
    // 100 低于 voice 阈值 120，仍隐藏(虽已过 usage 阈值 90，但 voice 需更晚露出)
    expect(voiceHintVisible(100)).toBe(false)
    // 120 为开区间边界，本身不显示
    expect(voiceHintVisible(120)).toBe(false)
    // 121 刚过阈值，开始显示
    expect(voiceHintVisible(121)).toBe(true)
    expect(voiceHintVisible(200)).toBe(true)
  })

  // 这是完整的正常路径：第一次 toggle 开始录音，第二次 toggle 停止并转写。
  // 断言文本插入的是停止后的 WAV 文件结果，而不是录音中途的旧状态。
  // stop 后仍调用 abort，是为了删除临时文件；这个 cleanup 不应影响已插入文本。
  // 状态序列锁定 TUI 用户能看到的阶段，避免后续重构跳过保存或转写提示。
  test.each(["default", "mcp", "direct", "explicit"] as const)("host config reaches the voice controller: %s", async (scenario) => {
    await using tmp = await tmpdir()
    await Bun.write(path.join(tmp.path, "tui.json"), JSON.stringify({
      tui: { theme: "ancestor", attention: { sounds: { done: "alert.wav" } }, keybinds: { prompt_voice_toggle: "alt+x" } },
    }))
    const script = path.join(tmp.path, "chatgpt browser agent", "chatgpt.js")
    // 只提供配置推导所需的脚本存在证据；转写和录音均不启动真实设备或MCP进程。
    if (scenario !== "default") {
      await Bun.write(script, "")
      await Bun.write(path.join(tmp.path, "opencode.json"), JSON.stringify({ mcp: {
        other: { command: ["unrelated", path.join(path.dirname(script), "mcp-server.js")] },
        // 同一个host入口覆盖显式runtime与直接脚本，两种配置均不启动真实进程。
        chatgpt: { type: "local", command: scenario === "direct" ? [path.join(path.dirname(script), "mcp-server.js")] : [process.execPath, path.join(path.dirname(script), "mcp-server.js")] },
      } }))
    }
    if (scenario === "explicit") {
      await Bun.write(path.join(tmp.path, ".opencode", "tui.json"), JSON.stringify({
        voice: { transcriber: { command: "explicit-voice", args: ["{file}"] } },
      }))
    }
    // 与Native CLI调用同一个host producer，配置发现、规范化和优先级不能被手写对象替代。
    const config = await Effect.runPromise(TuiConfigHost.load(tmp.path, { terminalSuspend: false }).pipe(
      Effect.provide(AppNodeBuilder.build(FSUtil.node)),
    ))
    expect(config.theme).toBe("ancestor")
    expect(config.attention.sounds.done).toBe(path.join(tmp.path, "alert.wav"))
    expect(config.keybinds.get("prompt.voice.toggle")?.[0]?.key).toBe("alt+x")
    expect(config.keybinds.get("terminal.suspend")).toEqual([])
    expect(config).not.toHaveProperty("voice")
    const file = path.join(tmp.path, "voice.wav")
    await Bun.write(file, new Uint8Array([82, 73, 70, 70]))
    const inserted: string[] = []
    const errors: string[] = []
    const states: string[] = []
    let aborted = false
    const recorder: VoiceRecorderHandle = {
      file,
      stop: async () => {},
      abort: async () => {
        aborted = true
      },
    }
    const controller = createVoiceInputController({
      startRecorder: async () => recorder,
      // 真实controller和上传函数连到同一个Core selector，只替换HTTP与音频设备边界。
      transcribe: (file, signal) => PromptVoiceInput.submitVoice(file, signal, {
        url: "http://localhost:1234", directory: tmp.path,
        fetch: async (url, init) => {
          expect(new URL(String(url)).pathname).toBe("/tui/voice/transcribe")
          expect(await new Response(init?.body).arrayBuffer()).toEqual(await Bun.file(file).arrayBuffer())
          const target = await resolveVoiceTarget(scenario === "default" ? [] : [path.join(tmp.path, "opencode.json")])
            .catch((error: unknown) => { if (!(error instanceof Error)) throw error; return error })
          if (target instanceof Error) return Response.json({ message: target.message }, { status: 502 })
          expect(target).toMatchObject({ config: path.join(tmp.path, "opencode.json"), key: "chatgpt", script, interpreter: scenario === "direct" ? "node" : process.execPath })
          return Response.json({ text: `text from ${path.basename(file)}` })
        },
      }),
      insertText: (text) => inserted.push(text),
      onError: (message) => errors.push(message),
      onStatus: (status) => states.push(status.type),
      now: () => 1_000,
    })

    await controller.toggle()
    await controller.toggle()

    expect(inserted).toEqual(scenario === "default" ? [] : ["text from voice.wav"])
    expect(errors).toEqual(scenario === "default" ? ["Voice input requires a user-configured ChatGPT MCP"] : [])
    expect(states).toEqual(["starting", "recording", "stopping", "transcribing", "idle"])
    expect(aborted).toBe(true)
  })

  // 静音的空文字是成功结果：输入框保持不变，也不产生错误提示。
  // 后端协议切片（非 JSON 输出、缺 text 字段）在 opencode 侧 tui-control-voice 测试覆盖。
  test("accepts silence without inserting text or reporting an error", async () => {
    const inserted: string[] = []
    const errors: string[] = []
    const controller = createVoiceInputController({
      startRecorder: async () => ({ file: "voice.wav", stop: async () => {}, abort: async () => {} }),
      transcribe: async () => "   ",
      insertText: (text) => inserted.push(text),
      onError: (message) => errors.push(message),
    })
    await controller.toggle()
    await controller.toggle()
    expect(inserted).toEqual([])
    // 没有插入也可能是转录失败；无错误提示才能证明静音被当作成功处理。
    expect(errors).toEqual([])
    expect(controller.status()).toEqual({ type: "idle" })
  })

  // 转写失败时 prompt 必须保持原样，不能插入部分文本或空字符串。
  // 即使转写器失败，临时录音文件仍需要通过 abort 清理。
  // stopped 证明 controller 先完成录音保存，再进入外部转写错误路径。
  // 这个用例保护网络失败、ChatGPT 掉线和 JSON 协议漂移等实际场景。
  test("cleans up recorder and leaves the prompt unchanged when transcription fails", async () => {
    const inserted: string[] = []
    let stopped = false
    let aborted = false
    const errors: string[] = []
    const controller = createVoiceInputController({
      startRecorder: async () => ({
        file: "voice.wav",
        stop: async () => {
          stopped = true
        },
        abort: async () => {
          aborted = true
        },
      }),
      transcribe: async () => {
        throw new Error("network down")
      },
      insertText: (text) => inserted.push(text),
      onError: (message) => errors.push(message),
    })

    await controller.toggle()
    await controller.toggle()

    expect(stopped).toBe(true)
    expect(aborted).toBe(true)
    expect(inserted).toEqual([])
    expect(errors).toEqual(["network down"])
  })

  // cleanup abort 是无转写路径：它只负责释放麦克风和删除临时文件。
  // 用户切换会话、Prompt 卸载或退出 TUI 时会走这个边界。
  // 这里断言 transcribe 没有被调用，防止后台 cleanup 意外上传用户录音。
  // 最终状态必须回到 idle，让下一次 alt+v 可以重新开始。
  test("aborts an active recorder without transcribing during cleanup", async () => {
    let aborted = false
    let transcribed = false
    const controller = createVoiceInputController({
      startRecorder: async () => ({
        file: "voice.wav",
        stop: async () => {},
        abort: async () => {
          aborted = true
        },
      }),
      transcribe: async () => {
        transcribed = true
        return "text"
      },
      insertText: () => {},
    })

    await controller.toggle()
    await controller.abort()

    expect(aborted).toBe(true)
    expect(transcribed).toBe(false)
    expect(controller.status()).toEqual({ type: "idle" })
  })

  // starting 是异步阶段，连续按快捷键不能创建两个 native recorder。
  // resolveStarts 模拟录音设备启动较慢，复现用户快速连按 alt+v 的竞争。
  // 第二次 toggle 应该被忽略，而不是取消或启动第二条录音链路。
  // 该边界保护麦克风句柄，避免两个 recorder 同时抢默认输入设备。
  test("does not start a second recorder while the first recorder is starting", async () => {
    let starts = 0
    const resolveStarts: Array<(recorder: VoiceRecorderHandle) => void> = []
    let startPending: (() => void) | undefined
    const pending = new Promise<void>((resolve) => {
      startPending = resolve
    })
    const controller = createVoiceInputController({
      startRecorder: async () => {
        starts++
        return await new Promise<VoiceRecorderHandle>((resolve) => {
          resolveStarts.push(resolve)
          startPending?.()
        })
      },
      transcribe: async () => "text",
      insertText: () => {},
      now: () => 1_000,
    })

    const first = controller.toggle()
    await pending
    const second = controller.toggle()
    resolveStarts.forEach((resolve) => resolve({ file: "voice.wav", stop: async () => {}, abort: async () => {} }))
    await Promise.all([first, second])

    expect(starts).toBe(1)
    expect(controller.status()).toEqual({ type: "recording", startedAt: 1_000 })
  })

  // recorder 启动完成可能晚于用户 abort，这时迟到 handle 不能接管 UI 状态。
  // 它只能自清理 native 资源和临时文件，避免麦克风后台悬挂。
  // 这个测试覆盖 startRecorder Promise 与 cleanup Promise 的真实竞态。
  // 最终状态保持 idle，证明迟到结果没有重新点亮录音状态。
  test("cleans up a recorder that becomes ready after startup was aborted", async () => {
    let aborted = false
    let resolveStart: ((recorder: VoiceRecorderHandle) => void) | undefined
    let startPending: (() => void) | undefined
    const pending = new Promise<void>((resolve) => {
      startPending = resolve
    })
    const controller = createVoiceInputController({
      startRecorder: async () =>
        await new Promise<VoiceRecorderHandle>((resolve) => {
          resolveStart = resolve
          startPending?.()
        }),
      transcribe: async () => "text",
      insertText: () => {},
      now: () => 1_000,
    })

    const start = controller.toggle()
    await pending
    await controller.abort()
    resolveStart?.({
      file: "voice.wav",
      stop: async () => {},
      abort: async () => {
        aborted = true
      },
    })
    await start

    expect(aborted).toBe(true)
    expect(controller.status()).toEqual({ type: "idle" })
  })

  // 转写是外部进程/浏览器链路，可能在用户已经 abort 后才返回。
  // generation guard 必须让迟到文本失效，避免把旧录音插入新的 prompt。
  // abort 仍要清理旧 recorder，不能因为转写 Promise 挂起而泄漏文件。
  // 该测试只观察插入结果和状态，保证实现可继续调整内部 guard 形态。
  test("does not insert transcribed text after cleanup aborts an in-flight transcription", async () => {
    const inserted: string[] = []
    let aborted = false
    let resolveTranscribe: ((text: string) => void) | undefined
    let transcribeStarted: (() => void) | undefined
    const transcribing = new Promise<void>((resolve) => {
      transcribeStarted = resolve
    })
    const controller = createVoiceInputController({
      startRecorder: async () => ({
        file: "voice.wav",
        stop: async () => {},
        abort: async () => {
          aborted = true
        },
      }),
      transcribe: async () => {
        transcribeStarted?.()
        return await new Promise<string>((resolve) => {
          resolveTranscribe = resolve
        })
      },
      insertText: (text) => inserted.push(text),
    })

    await controller.toggle()
    const stopping = controller.toggle()
    await transcribing
    await controller.abort()
    resolveTranscribe?.("late text")
    await stopping

    expect(aborted).toBe(true)
    expect(inserted).toEqual([])
    expect(controller.status()).toEqual({ type: "idle" })
  })

  // 旧转写完成时，用户可能已经开始了新的录音。
  // 旧 finally 不能把新 recorder 清掉，否则会出现新录音突然回 idle 的回归。
  // startCount 区分两代 recorder，firstAborted 证明旧资源仍被清理。
  // 这个用例锁定 generation 与 recorder identity 的组合边界。
  test("stale transcription cleanup does not clear a newer recording", async () => {
    let startCount = 0
    let firstAborted = false
    let resolveTranscribe: ((text: string) => void) | undefined
    let transcribeStarted: (() => void) | undefined
    const transcribing = new Promise<void>((resolve) => {
      transcribeStarted = resolve
    })
    const controller = createVoiceInputController({
      startRecorder: async () => {
        startCount++
        // 文件身份属于创建时的录音，不能在旧 cleanup 中读取已被下一轮改变的计数。
        const file = startCount === 1 ? "first.wav" : "second.wav"
        return {
          file,
          stop: async () => {},
          abort: async () => {
            if (file === "first.wav") firstAborted = true
          },
        }
      },
      transcribe: async () => {
        transcribeStarted?.()
        return await new Promise<string>((resolve) => {
          resolveTranscribe = resolve
        })
      },
      insertText: () => {},
      now: () => 1_000,
    })

    await controller.toggle()
    const oldStop = controller.toggle()
    await transcribing
    await controller.abort()
    await controller.toggle()
    resolveTranscribe?.("stale text")
    await oldStop

    expect(firstAborted).toBe(true)
    expect(startCount).toBe(2)
    expect(controller.status()).toEqual({ type: "recording", startedAt: 1_000 })
  })

  // 转写中用户按快捷键应能中断卡死的转写，而不是被 `status.type !== "idle"` 跳过。
  // 这覆盖最严重场景：空音频、噪音无语音或网络 hang 时，用户必须能自救。
  // mock transcribe 返回永不 resolve 的 promise 但监听 signal abort 来模拟被 kill 的上传请求。
  test("interrupts a stuck transcription when toggled again", async () => {
    let transcribeSignal: AbortSignal | undefined
    let resolveTranscribe: (() => void) | undefined
    const transcribeStarted = new Promise<void>((resolve) => {
      resolveTranscribe = resolve
    })
    const inserted: string[] = []
    const controller = createVoiceInputController({
      startRecorder: async () => ({ file: "voice.wav", stop: async () => {}, abort: async () => {} }),
      transcribe: (_file, signal) => {
        transcribeSignal = signal
        resolveTranscribe?.()
        // 模拟上传请求被 signal kill 后 promise reject 的真实行为。
        // 用 polling 而非 addEventListener 避免 bun:test 的 pending promise tracker 误判测试未结束。
        return new Promise<string>((_, reject) => {
          const timer = setInterval(() => {
            if (signal.aborted) { clearInterval(timer); reject(new Error("aborted")) }
          }, 5)
        })
      },
      insertText: (text) => inserted.push(text),
    })

    // toggle#1 开始录音, toggle#2 停止进入转写, toggle#3 取消转写。
    await controller.toggle()
    const stopping = controller.toggle()
    await transcribeStarted
    await controller.toggle()
    await stopping

    // 取消后 signal 必须被 abort，状态回 idle，迟到文本不会插入。
    expect(transcribeSignal?.aborted).toBe(true)
    expect(controller.status()).toEqual({ type: "idle" })
    expect(inserted).toEqual([])
  })

  // 用户主动取消转写时不应弹出 error toast，否则用户会以为出错了。
  test("does not show an error when the user cancels a stuck transcription", async () => {
    const errors: string[] = []
    let resolveTranscribe: (() => void) | undefined
    const transcribeStarted = new Promise<void>((resolve) => {
      resolveTranscribe = resolve
    })
    const controller = createVoiceInputController({
      startRecorder: async () => ({ file: "voice.wav", stop: async () => {}, abort: async () => {} }),
      transcribe: (_file, signal) => {
        resolveTranscribe?.()
        // 网络错误仍应提示；这里仅由用户 signal 驱动拒绝，锁定主动取消静默的语义。
        return new Promise<string>((_, reject) => {
          const timer = setInterval(() => {
            if (signal.aborted) { clearInterval(timer); reject(new Error("aborted")) }
          }, 5)
        })
      },
      insertText: () => {},
      onError: (message) => errors.push(message),
    })

    await controller.toggle()
    const stopping = controller.toggle()
    await transcribeStarted
    await controller.toggle()
    await stopping

    // 用户主动取消不是错误，不应弹出 error toast。
    expect(errors).toEqual([])
    expect(controller.status()).toEqual({ type: "idle" })
  })

  // [local-smark] 以下测试覆盖 DialogPrompt / QuestionPrompt voice 接入所依赖的 controller 安全边界。
  // 对话框场景生命周期更复杂（onCleanup + createEffect 可能先后触发 abort、
  // textarea ref 可能已销毁），需独立锁定以防止重构破坏对话框 voice 的安全假设。

  // abort 幂等性：onCleanup（组件卸载）和 createEffect（editing→false）可能在同一轮
  // 事件循环中先后调用 abort。第二次 abort 必须是无副作用 no-op，不能抛错或重复释放 native 资源。
  test("abort is idempotent when called from both onCleanup and createEffect", async () => {
    let abortCount = 0
    const controller = createVoiceInputController({
      startRecorder: async () => ({
        file: "voice.wav",
        stop: async () => {},
        abort: async () => {
          abortCount++
        },
      }),
      transcribe: async () => "text",
      insertText: () => {},
    })

    await controller.toggle()
    // 模拟 onCleanup 和 createEffect 先后触发
    await controller.abort()
    await controller.abort()

    // recorder 只被 abort 一次：第一次 abort 后 status 已是 idle，
    // 第二次 abort 时 recorder 为 undefined，不会重复调用 abort()。
    expect(abortCount).toBe(1)
    expect(controller.status()).toEqual({ type: "idle" })
  })

  // abort 期间转写可能已发出但尚未 resolve；abort 后迟到结果不能触发 insertText。
  // 覆盖 QuestionPrompt 的 stale ref 场景：退出 editing 后 textarea 已销毁，
  // 迟到的转写文本不能尝试插入到已销毁的 renderable。
  test("does not invoke insertText after abort during in-flight transcription", async () => {
    let transcribeSignal: AbortSignal | undefined
    let transcribeStarted: () => void
    const started = new Promise<void>((resolve) => {
      transcribeStarted = resolve
    })
    let lateResolve: ((text: string) => void) | undefined
    const inserted: string[] = []
    const controller = createVoiceInputController({
      startRecorder: async () => ({ file: "voice.wav", stop: async () => {}, abort: async () => {} }),
      transcribe: (_file, signal) => {
        transcribeSignal = signal
        transcribeStarted()
        // 消费方卸载继续经过公开 controller 取消，不依赖已删除的本地命令选择器。
        // 模拟上传请求被 signal kill 后 reject 的真实行为
        return new Promise<string>((resolve, reject) => {
          lateResolve = resolve
          const timer = setInterval(() => {
            if (signal.aborted) {
              clearInterval(timer)
              reject(new Error("aborted"))
            }
          }, 5)
        })
      },
      insertText: (text) => inserted.push(text),
    })

    await controller.toggle()
    const stopping = controller.toggle()
    await started
    // abort 模拟 QuestionPrompt editing→false 时的 createEffect 触发
    await controller.abort()
    await stopping
    // 迟到的转写结果 resolve——controller 内部 generation 已 bump，insertText 不会被调用
    lateResolve?.("late text")

    // 给 microtask 一个 tick 让迟到 Promise 的 then 回调执行
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(transcribeSignal?.aborted).toBe(true)
    expect(inserted).toEqual([])
    expect(controller.status()).toEqual({ type: "idle" })
  })

  // insertText 回调中对已销毁 textarea 的守卫由消费方（DialogPrompt/QuestionPrompt）负责。
  // 此测试验证 controller 在正常路径下把完整转写文本传给 insertText——
  // 即 controller 不会跳过 insertText 或传入空值，消费方的 isDestroyed 守卫可以正确拦截。
  test("insertText receives the full transcribed text for consumer-side guards to check", async () => {
    const inserted: string[] = []
    const controller = createVoiceInputController({
      startRecorder: async () => ({ file: "voice.wav", stop: async () => {}, abort: async () => {} }),
      transcribe: async () => "hello world",
      insertText: (text) => inserted.push(text),
    })

    await controller.toggle()
    await controller.toggle()

    expect(inserted).toEqual(["hello world"])
    expect(controller.status()).toEqual({ type: "idle" })
  })

  // 后端目标与真实浏览器/直连协议切片已随共享 daemon 迁移到 opencode 侧
  // （test/server/tui-control-voice.test.ts）；本文件只保留 controller 与上传传输合同。
  // 真实 E2E 门禁（darwin 五分钟 WAV、真实 profile 收割直连）同样位于该 opencode 文件。
})

describe("voiceInputStatusText compact", () => {
  // #491/#505：三面板统一 short profile——主 Prompt / DialogPrompt / QuestionPrompt 共用 compact 文案。
  // recording 仍保留 stop 快捷键，缩短阶段词不能牺牲用户如何停止录音的信息。
  test("provides compact variants while keeping the stop shortcut visible", () => {
    const idle = { type: "idle" as const }
    expect(voiceInputStatusText(idle, "alt+v")).toBe("")
    const startedAt = 1_000
    expect(voiceInputStatusText({ type: "starting" }, "alt+v", 4_400)).toBe("Starting voice...")
    expect(
      voiceInputStatusText({ type: "starting" }, "alt+v", 4_400, { compact: true }),
    ).toBe("Starting...")
    const recording = { type: "recording" as const, startedAt }
    expect(voiceInputStatusText(recording, "alt+v", 4_400, { compact: true })).toBe("Rec 00:03 · alt+v stop")
    expect(voiceInputStatusText(recording, "alt+v", 4_400, { compact: true })).toContain("alt+v stop")
    expect(voiceInputStatusText({ type: "stopping" }, "alt+v", 4_400, { compact: true })).toBe("Saving...")
    expect(voiceInputStatusText({ type: "transcribing" }, "alt+v", 4_400, { compact: true })).toBe(
      "Transcribing...",
    )
  })

  // INV-01 硬门禁：formatter 双 profile 不能证明 call-site 选择；任一 consumer 漏传 compact 必须失败。
  // 完整挂载 Question/Dialog 生命周期成本过高，因此对生产 call-site 源码做 fail-capable 契约断言。
  test("DialogPrompt and QuestionPrompt call sites select the compact voice profile", async () => {
    const root = path.resolve(import.meta.dir, "../../src")
    const dialogSource = await Bun.file(path.join(root, "ui/dialog-prompt.tsx")).text()
    const questionSource = await Bun.file(path.join(root, "routes/session/question.tsx")).text()
    // 必须同时包含 voiceInputStatusText 调用与 compact: true，防止只写注释或死代码。
    expect(dialogSource).toMatch(/voiceInputStatusText\([\s\S]*?compact:\s*true/)
    expect(questionSource).toMatch(/voiceInputStatusText\([\s\S]*?compact:\s*true/)
  })
})
