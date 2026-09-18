import { describe, expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import { createRequire } from "node:module"
import os from "node:os"
import path from "path"
import { createRoot, createSignal } from "solid-js"
import { tmpdir } from "../../fixture/fixture"
import {
  PromptVoiceInput,
  createVoiceInputController,
  VOICE_TRANSCRIBE_TIMEOUT_MS,
  voiceInputStatusText,
  voiceHintVisible,
  type VoiceRecorderHandle,
} from "../../../src/cli/cmd/tui/prompt-voice-input"
import { readVoiceAuth, resolveVoiceTarget, transcribeVoiceFile, type VoiceTarget } from "../../../src/server/shared/tui-control"
import { NetworkProxy } from "@opencode-ai/core/network-proxy"
import { Process } from "../../../src/util/process"
import { createRefreshClock } from "../../../src/cli/cmd/tui/util/signal"

// 后端 CLI 固定接收 transcribe-file/--file；测试只提供真实可执行脚本，不重建已退役的 argv 配置。
// 空配置让 profile 步骤明确失败后进入浏览器协议 fixture，不向真实 ChatGPT 发送测试凭据。
async function browserFixture(directory: string, source: string): Promise<VoiceTarget> {
  const script = path.join(directory, "chatgpt.cjs")
  const config = path.join(directory, "opencode.json")
  await Bun.write(config, JSON.stringify({ mcp: { chatgpt: { type: "local" } } }))
  await Bun.write(script, `if (process.argv[2] === 'auth-export') process.exit(1);\n${source}`)
  return { config, key: "chatgpt", interpreter: process.execPath, script, environment: {} }
}

const voiceE2E = process.env.CHATGPT_VOICE_E2E === "1" ? test : test.skip
const defaultProfileE2E = process.env.CHATGPT_VOICE_E2E === "1" && process.env.CHATGPT_VOICE_DEFAULT_PROFILE_E2E === "1" ? test : test.skip
const compiledVoice = process.platform === "win32" ? test : test.skip

// standalone 必须加载真实 native addon 后再走上传，才能覆盖 Bun.file 正文的实际所有权，而非只验证源码运行时。
async function compileVoiceUploadFixture(directory: string, file: string, native: string) {
  // 入口和产物都放在测试临时目录，避免编译测试依赖仓库外的音频或留下仓库文件。
  const entry = path.join(directory, "compiled-submit-voice.ts")
  const production = path.resolve(import.meta.dir, "../../../src/cli/cmd/tui/prompt-voice-input.ts")
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

async function writeLateMarkerWav(source: string, target: string, seconds: number) {
  const input = Buffer.from(await Bun.file(source).arrayBuffer())
  // RIFF允许fmt、LIST等可变长度chunk，data位置不能从常见的44字节PCM头反推。
  // 每个chunk按偶数字节对齐；漏掉padding会把后续四字节标识读到错误边界。
  // 只接受真实RIFF/WAVE和可达data chunk，损坏fixture必须在调用ChatGPT前本地失败。
  let chunk = 12
  while (chunk + 8 <= input.length && input.toString("ascii", chunk, chunk + 4) !== "data") {
    const size = input.readUInt32LE(chunk + 4)
    chunk += 8 + size + (size % 2)
  }
  if (input.toString("ascii", 0, 4) !== "RIFF" || input.toString("ascii", 8, 12) !== "WAVE" || chunk + 8 > input.length) {
    throw new Error("voice E2E source is not a supported RIFF/WAVE file")
  }
  const blockAlign = input.readUInt16LE(32)
  // WAV的fmt chunk不保证固定16字节；按真实data chunk扩展，避免44字节头假设破坏合法PCM容器。
  // 使用header byteRate保持源采样格式，按blockAlign取整保证最后一个sample frame完整。
  const dataBytes = Math.floor((seconds * input.readUInt32LE(28)) / blockAlign) * blockAlign
  const dataStart = chunk + 8
  const sourceBytes = Math.floor(Math.min(input.readUInt32LE(chunk + 4), input.length - dataStart) / blockAlign) * blockAlign
  if (sourceBytes === 0 || sourceBytes > dataBytes) throw new Error("voice E2E marker has no usable PCM frames")
  const output = Buffer.alloc(dataStart + dataBytes)
  input.copy(output, 0, 0, dataStart)
  // marker只放在容器末端；若传输或转写只处理开头，两个独立expected都会缺失并确定性报红。
  input.copy(output, dataStart + dataBytes - sourceBytes, dataStart, dataStart + sourceBytes)
  output.writeUInt32LE(output.length - 8, 4)
  output.writeUInt32LE(dataBytes, chunk + 4)
  await Bun.write(target, output)
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

  // transcriber只是TUI拥有的父进程；它启动的daemon/browser有独立生命周期，取消不能递归强杀后代。
  // grandchild在父进程被timeout后写marker，测试观察真实OS进程结果而不是Process helper调用次数。
  test("cancels only the transcriber process and leaves its lifecycle child running", async () => {
    await using tmp = await tmpdir()
    const marker = path.join(tmp.path, "grandchild-alive")
    const ready = path.join(tmp.path, "grandchild-started")
    const grandchild = path.join(tmp.path, "grandchild.cjs")
    const file = path.join(tmp.path, "voice.wav")
    await Bun.write(file, "RIFF....WAVE")
    await Bun.write(grandchild, "require('fs').writeFileSync(process.argv[3], 'ready'); setTimeout(() => require('fs').writeFileSync(process.argv[2], 'alive'), 500)")
    // 取消应由后端持有的 CLI 接收；浏览器后代仍按原 ownership 自行存活。
    const target = await browserFixture(tmp.path, `require('child_process').spawn(process.execPath, [${JSON.stringify(grandchild)}, ${JSON.stringify(marker)}, ${JSON.stringify(ready)}], { detached: true, stdio: 'ignore' }).unref(); setInterval(() => {}, 1000)`)
    const abort = new AbortController()
    const transcription = transcribeVoiceFile(file, target, abort.signal)
    const cancelled = transcription.then((text) => ({ text }), (error: unknown) => ({ error }))
    for (let attempts = 0; attempts < 100 && !(await Bun.file(ready).exists()); attempts++) await Bun.sleep(25)
    expect(await Bun.file(ready).text()).toBe("ready")
    abort.abort()
    expect(await cancelled).toMatchObject({ error: { name: "AbortError" } })
    await Bun.sleep(700)
    expect(await Bun.file(marker).text()).toBe("alive")
  })

  // 这个用例锁定 argv 传参边界：录音文件路径只能作为一个参数进入转写器。
  // 路径里的空格、分号和变量字符都必须保持字面量，不能被 shell 展开。
  // 这里不检查实现函数名，只观察转写器实际收到的参数值，避免测试和实现耦合。
  // out.wav 不存在用于证明命令字符串没有被拼接执行，也没有触发额外重定向或副作用。
  // 该边界直接保护用户临时录音文件名，不能因为平台差异退回 shell 字符串。
  test("passes the audio file as one argv argument without shell expansion", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "voice $HOME ; echo nope.wav")
    await Bun.write(file, "RIFF....WAVE")

    // 新协议同次返回 Cookie；只测路径字面量，不依赖旧的 {file} 替换器。
    const target = await browserFixture(tmp.path, "process.stdout.write(JSON.stringify({ text: process.argv[4], auth: { cookies: [], fetchedAt: '2026-09-18T00:00:00Z' } }))")
    const text = await transcribeVoiceFile(file, target, new AbortController().signal)

    expect(text).toBe(file)
    expect(await Bun.file(path.join(tmp.path, "out.wav")).exists()).toBe(false)
  })

  // 外部转写器是独立进程，成功退出也可能返回非 JSON。
  // TUI 不能把这些输出直接插入 prompt，否则用户会看到不可诊断的脏文本。
  // 非 JSON 是协议错误；R9 的静音空文本则应成功返回，由 controller 保持输入不变。
  // 这里分别覆盖它们，保证错误提示来自 controller 边界而不是后续 UI 崩溃。
  // 该测试保持真实子进程路径，覆盖 stdout 解析而不是 mock 解析器。
  test("rejects invalid browser output and accepts silence without inserting text", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "voice.wav")
    await Bun.write(file, "RIFF....WAVE")

    const invalid = await browserFixture(tmp.path, "process.stdout.write('not json')")
    await expect(transcribeVoiceFile(file, invalid, new AbortController().signal)).rejects.toThrow(/JSON/)
    const silent = await browserFixture(tmp.path, "process.stdout.write(JSON.stringify({ text: '   ', auth: { cookies: [], fetchedAt: '2026-09-18T00:00:00Z' } }))")
    const inserted: string[] = []
    const errors: string[] = []
    const controller = createVoiceInputController({
      startRecorder: async () => ({ file, stop: async () => {}, abort: async () => {} }),
      transcribe: (file, signal) => transcribeVoiceFile(file, silent, signal),
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

  // footer 文案是用户判断当前语音状态的唯一 TUI 反馈。
  // starting/stopping/transcribing 需要短词提示，recording 必须保留停止快捷键。
  // 这里固定 alt+v 展示，防止未来改文案时隐藏“如何结束录音”。
  // 使用传入 now 可以稳定测试计时显示，不依赖真实时间。
  test("formats active footer status without hiding the stop shortcut", () => {
    expect(voiceInputStatusText({ type: "starting" }, "alt+v", 4_400)).toBe("Starting voice...")
    expect(voiceInputStatusText({ type: "recording", startedAt: 1_000 }, "alt+v", 4_400)).toBe(
      "Recording 00:03 · alt+v stop",
    )
    expect(voiceInputStatusText({ type: "stopping" }, "alt+v", 4_400)).toBe("Saving voice...")
    expect(voiceInputStatusText({ type: "transcribing" }, "alt+v", 4_400)).toBe("Transcribing voice...")
  })

  // 三面板统一 short profile：主 Prompt / DialogPrompt / QuestionPrompt 共用 compact 文案。
  // recording 仍保留 stop 快捷键，缩短阶段词不能牺牲用户如何停止录音的信息。
  // 固定 now 继续验证计时值，避免 compact 分支绕过原有录音时钟。
  test("formats compact shared voice status without losing the stop shortcut", () => {
    const compact = { compact: true }
    expect(voiceInputStatusText({ type: "starting" }, "alt+v", 4_400, compact)).toBe("Starting...")
    expect(voiceInputStatusText({ type: "recording", startedAt: 1_000 }, "alt+v", 4_400, compact)).toBe("Rec 00:03 · alt+v stop")
    expect(voiceInputStatusText({ type: "stopping" }, "alt+v", 4_400, compact)).toBe("Saving...")
    expect(voiceInputStatusText({ type: "transcribing" }, "alt+v", 4_400, compact)).toBe("Transcribing...")
  })

  // INV-01 硬门禁：formatter 双 profile 不能证明 call-site 选择；任一 consumer 漏传 compact 必须失败。
  // 完整挂载 Question/Dialog 生命周期成本过高，因此对生产 call-site 源码做 fail-capable 契约断言。
  test("DialogPrompt and QuestionPrompt call sites select the compact voice profile", async () => {
    const root = path.resolve(import.meta.dir, "../../../src/cli/cmd/tui")
    const dialogSource = await Bun.file(path.join(root, "ui/dialog-prompt.tsx")).text()
    const questionSource = await Bun.file(path.join(root, "routes/session/question.tsx")).text()
    // 必须同时包含 voiceInputStatusText 调用与 compact: true，防止只写注释或死代码。
    expect(dialogSource).toMatch(/voiceInputStatusText\([\s\S]*?compact:\s*true/)
    expect(questionSource).toMatch(/voiceInputStatusText\([\s\S]*?compact:\s*true/)
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
  test("toggles recording, transcribes the stopped file, and inserts returned text", async () => {
    const inserted: string[] = []
    const errors: string[] = []
    const states: string[] = []
    let aborted = false
    const recorder: VoiceRecorderHandle = {
      file: "voice.wav",
      stop: async () => {},
      abort: async () => {
        aborted = true
      },
    }
    const controller = createVoiceInputController({
      startRecorder: async () => recorder,
      transcribe: async (file) => `text from ${file}`,
      insertText: (text) => inserted.push(text),
      onError: (message) => errors.push(message),
      onStatus: (status) => states.push(status.type),
      now: () => 1_000,
    })

    await controller.toggle()
    await controller.toggle()

    expect(inserted).toEqual(["text from voice.wav"])
    expect(errors).toEqual([])
    expect(states).toEqual(["starting", "recording", "stopping", "transcribing", "idle"])
    expect(aborted).toBe(true)
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
  // mock transcribe 返回永不 resolve 的 promise 但监听 signal abort 来模拟被 kill 的 Process.run。
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
        // R9 回调第二参数直接承载整轮取消，不能保留旧 transcriber 占位导致信号错位。
        // 模拟 Process.run 被 signal kill 后 promise reject 的真实行为。
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

  // [local-smark] 以下测试覆盖 DialogPrompt / QuestionPrompt 新增 voice 接入所依赖的 controller 安全边界。
  // 这些边界在主 Prompt 组件中已隐含覆盖，但对话框场景的生命周期更复杂
  // （onCleanup + createEffect 可能先后触发 abort、textarea ref 可能已销毁），
  // 需要独立锁定以防止未来重构破坏对话框 voice 的安全假设。

  // abort 幂等性：onCleanup（组件卸载）和 createEffect（editing→false）可能在同一轮
  // 事件循环中先后调用 abort。第二次 abort 必须是无副作用 no-op，不能抛错或重复释放 native 资源。
  // 该边界保护 QuestionPrompt 中 createEffect + onCleanup 双重 cleanup 路径。
  test("abort is idempotent when called from both onCleanup and createEffect", async () => {
    let abortCount = 0
    const controller = createVoiceInputController({
      startRecorder: async () => ({
        file: "voice.wav",
        stop: async () => {},
        abort: async () => { abortCount++ },
      }),
      transcribe: async () => "text",
      insertText: () => {},
    })

    await controller.toggle()
    // 模拟 onCleanup 和 createEffect 先后触发
    await controller.abort()
    await controller.abort()

    // recorder 只被 abort 一次：cancel() 在第一次 abort 后 status 已是 idle，
    // 第二次 abort 时 recorder 为 undefined，不会重复调用 abort()。
    expect(abortCount).toBe(1)
    expect(controller.status()).toEqual({ type: "idle" })
  })

  // abort 期间转写可能已发出但尚未 resolve；abort 后迟到结果不能触发 insertText。
  // 这覆盖 QuestionPrompt 的 stale ref 场景：用户退出 editing 模式后 textarea 已销毁，
  // 此时迟到的转写文本不能尝试插入到已销毁的 renderable。
  test("does not invoke insertText after abort during in-flight transcription", async () => {
    let transcribeSignal: AbortSignal | undefined
    let transcribeStarted: () => void
    const started = new Promise<void>((resolve) => { transcribeStarted = resolve })
    let lateResolve: ((text: string) => void) | undefined
    const inserted: string[] = []
    const controller = createVoiceInputController({
      startRecorder: async () => ({ file: "voice.wav", stop: async () => {}, abort: async () => {} }),
      transcribe: (_file, signal) => {
        transcribeSignal = signal
        transcribeStarted()
        // 消费方卸载继续经过公开 controller 取消，不依赖已删除的本地命令选择器。
        // 模拟 Process.run 被 signal kill 后 reject 的真实行为
        return new Promise<string>((resolve, reject) => {
          lateResolve = resolve
          const timer = setInterval(() => {
            if (signal.aborted) { clearInterval(timer); reject(new Error("aborted")) }
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

  // insertText 回调中对已销毁 textarea 的守卫是 DialogPrompt/QuestionPrompt 的安全边界。
  // controller 本身不判断 textarea 状态，但 insertText 回调必须由消费方守卫。
  // 此测试验证 controller 在正常路径下调用 insertText 时传入的是转写文本，
  // 让消费方的 isDestroyed 守卫可以正确拦截——即 controller 不会跳过 insertText 或传入空值。
  test("insertText receives the full transcribed text for consumer-side guards to check", async () => {
    const inserted: string[] = []
    const controller = createVoiceInputController({
      startRecorder: async () => ({ file: "voice.wav", stop: async () => {}, abort: async () => {} }),
      transcribe: async () => "hello world",
      insertText: (text) => inserted.push(text),
    })

    await controller.toggle()
    await controller.toggle()

    // 消费方（DialogPrompt/QuestionPrompt）的 insertText 回调会检查 textarea.isDestroyed；
    // controller 保证只在转写成功后调用一次 insertText，传入完整文本。
    expect(inserted).toEqual(["hello world"])
  })

  voiceE2E(
    "runs a five-minute WAV through the configured ChatGPT transcriber",
    async () => {
      // Bun测试preload会隔离XDG_DATA_HOME；E2E必须显式复用真实agent profile，不能拿临时空profile制造假未登录。
      if (!process.env.CHATGPT_BROWSER_USER_DATA_DIR) {
        throw new Error("voice E2E requires CHATGPT_BROWSER_USER_DATA_DIR for a logged-in agent profile")
      }
      if (process.platform !== "darwin") throw new Error("voice E2E late-marker fixture requires Darwin system audio tools")
      const agent = path.resolve(import.meta.dir, "../../../../../thirdparty/chatgpt-browser-agent")
      const script = path.join(agent, "chatgpt.js")
      const source = path.join(agent, "test-voice-hello.wav")
      const root = path.join(process.env.TMPDIR || "/private/tmp", "opencode", "voice")
      const evidence = process.env.CHATGPT_VOICE_E2E_EVIDENCE
      const state = path.join(root, `e2e-state-${process.pid}`)
      const previousState = process.env.CHATGPT_STATE_DIR
      // 固定本次daemon state，保证transcriber与finally命中同一个PID，不受test preload临时XDG清理时序影响。
      // profile与state刻意分离：前者复用登录，后者隔离daemon token、日志和PID索引。
      // 动态环境必须显式传给cleanup子进程，否则Bun可能回到preload的临时XDG并漏停owned Edge。
      process.env.CHATGPT_STATE_DIR = state
      const long = path.join(root, `tui-long-${process.pid}.wav`)
      const short = path.join(root, `tui-short-${process.pid}.wav`)
      const markerAiff = path.join(root, `tui-marker-${process.pid}.aiff`)
      const marker = path.join(root, `tui-marker-${process.pid}.wav`)
      await fs.mkdir(root, { recursive: true })
      // 系统TTS只生成本地测试输入；argv调用避免shell解释，普通CI因voiceE2E门禁不会进入该分支。
      const say = Bun.spawn(["/usr/bin/say", "-v", "Samantha", "-o", markerAiff, "purple checkpoint orange"], { stdout: "ignore", stderr: "ignore" })
      if (await say.exited !== 0) throw new Error("voice E2E could not synthesize its late marker")
      const convert = Bun.spawn(["/usr/bin/afconvert", markerAiff, "-o", marker, "-f", "WAVE", "-d", "LEI16@48000", "-c", "1"], { stdout: "ignore", stderr: "ignore" })
      if (await convert.exited !== 0) throw new Error("voice E2E could not convert its late marker to PCM WAV")
      await writeLateMarkerWav(marker, long, 300)
      await fs.copyFile(source, short)
      // long必须先于short消费；交换顺序会让独立expected失去检测迟到回放的能力。
      const files = [long, short]
      // 只记录本地断言所需事实；真实转录文本不得写入证据文件或daemon状态。
      const inserted: string[] = []
      const errors: string[] = []
      const startedAt = Date.now()
      let completed = false
      let longRemoved = false
      let shortRemoved = false
      let longMarkersMatched = false
      let shortMarkersMatched = false
      let stopExitCode: number | null = null
      let daemonObserved = false
      let daemonExited = false
      // 复用后端公开事务入口，保留长音频末端 marker 与下一次录音隔离的真实验证。
      // 测试配置独立于用户文件；profile/state 显式传入子进程，不依赖 TUI 的旧认证配置。
      const config = path.join(root, `e2e-config-${process.pid}.json`)
      await Bun.write(config, JSON.stringify({ mcp: { chatgpt: { type: "local", command: ["node", script] } } }))
      const target: VoiceTarget = { config, key: "chatgpt", interpreter: "node", script, environment: {
        CHATGPT_STATE_DIR: state, CHATGPT_BROWSER_USER_DATA_DIR: process.env.CHATGPT_BROWSER_USER_DATA_DIR,
      } }
      const controller = createVoiceInputController({
        transcribe: (file, signal) => transcribeVoiceFile(file, target, signal),
        startRecorder: async () => {
          const file = files.shift()
          if (!file) throw new Error("voice E2E fixture queue is empty")
          return {
            file,
            stop: async () => {},
            // controller最终cleanup必须删除实际交给子进程的WAV，成功和timeout共用同一隐私边界。
            abort: async () => fs.rm(file, { force: true }),
          }
        },
        insertText: (text) => inserted.push(text),
        onError: (message) => errors.push(message),
      })
      try {
        await controller.toggle()
        await controller.toggle()
        expect(controller.status()).toEqual({ type: "idle" })
        longRemoved = !(await Bun.file(long).exists())
        expect(longRemoved).toBe(true)
        // 长音频必须返回只存在于本fixture末端的两个marker；任意非空或short旧结果都不能证明末端被处理。
        if (errors.length > 0) throw new Error(`five-minute voice failed: ${errors.join(" | ")}`)
        const longText = inserted[0]?.toLowerCase() ?? ""
        longMarkersMatched = longText.includes("purple") && longText.includes("orange")
        expect(longText).toContain("purple")
        expect(longText).toContain("orange")

        const errorsBeforeShort = errors.length
        await controller.toggle()
        await controller.toggle()
        expect(controller.status()).toEqual({ type: "idle" })
        shortRemoved = !(await Bun.file(short).exists())
        expect(shortRemoved).toBe(true)
        if (errors.length !== errorsBeforeShort) throw new Error(`subsequent short voice failed: ${errors.slice(errorsBeforeShort).join(" | ")}`)
        // short使用另一组独立expected，确保第二次结果不是long marker的迟到回放。
        const shortText = inserted.at(-1)?.toLowerCase() ?? ""
        shortMarkersMatched = shortText.includes("hello") && shortText.includes("world")
        expect(shortText).toContain("hello")
        expect(shortText).toContain("world")
        completed = true
      } finally {
        // 任一marker断言失败也必须先删除音频，再处理daemon；敏感WAV不能依赖成功路径清理。
        await fs.rm(long, { force: true })
        await fs.rm(short, { force: true })
        await fs.rm(markerAiff, { force: true })
        await fs.rm(marker, { force: true })
        await fs.rm(config, { force: true })
        try {
          const daemon = await Bun.file(path.join(state, "daemon.json")).json().catch(() => null) as { pid?: number } | null
          daemonObserved = typeof daemon?.pid === "number"
          // stop走真实CLI ownership：shared CDP只disconnect，owned browser才关闭自身窗口。
          // 退出码只证明stop请求被接受；必须继续观察精确PID，才能证明profile锁和浏览器进程已释放。
          // stop CLI 隐藏 console（Windows 生效；本测仅 darwin 可达，true 在其它平台为 no-op）。
          const stop = Bun.spawn(["node", script, "--stop"], {
            cwd: agent,
            env: process.env,
            stdout: "ignore",
            stderr: "ignore",
            windowsHide: true,
          })
          stopExitCode = await stop.exited
          if (stopExitCode !== 0) throw new Error("voice E2E could not stop its isolated daemon")
          // 不能只相信stop退出码；精确旧PID仍存活时profile锁尚未安全释放。
          const daemonAlive = () => {
            if (!daemon?.pid) return false
            try { process.kill(daemon.pid, 0); return true }
            catch { return false }
          }
          const deadline = Date.now() + 10_000
          while (daemonAlive() && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 100))
          }
          daemonExited = !daemonAlive()
          if (!daemonExited) throw new Error(`voice E2E daemon ${daemon?.pid} did not exit after stop`)
        } finally {
          // state只能在daemon真实退出后删除，否则后续cleanup失去PID/token并留下无法管理的孤儿进程。
          // 恢复调用方环境保证同一Bun进程中的其它测试不会误用已删除的隔离state。
          await fs.rm(state, { recursive: true, force: true })
          if (previousState === undefined) delete process.env.CHATGPT_STATE_DIR
          else process.env.CHATGPT_STATE_DIR = previousState
          // state删除是证据合同的一部分，防止本地bearer索引或测试PID残留在临时目录。
          const stateRemoved = await fs.stat(state).then(() => false, () => true)
          if (evidence) {
            await fs.mkdir(path.dirname(evidence), { recursive: true })
            // 可选本地证据只保留布尔结果和长度；普通CI不登录，也不依赖任何被忽略目录。
            await Bun.write(evidence, JSON.stringify({
              schemaVersion: 1,
              generatedAt: new Date().toISOString(),
              command: 'CHATGPT_VOICE_E2E=1 CHATGPT_BROWSER_USER_DATA_DIR=<agent-profile> bun test prompt-voice-input.test.ts --test-name-pattern "five-minute WAV"',
              // Cookie 直连成功不必启动 browser daemon；若曾启动，仍必须证明精确 PID 已退出。
              status: completed && stopExitCode === 0 && daemonExited && stateRemoved ? "passed" : "failed",
              elapsedMs: Date.now() - startedAt,
              long: { durationSeconds: 300, markersMatched: longMarkersMatched, chars: inserted[0]?.trim().length ?? 0, wavRemoved: longRemoved },
              short: { markersMatched: shortMarkersMatched, chars: inserted.at(-1)?.trim().length ?? 0, wavRemoved: shortRemoved },
              cleanup: { stopExitCode, daemonObserved, daemonExited, stateRemoved },
            }, null, 2) + "\n")
          }
        }
      }
    },
    240_000,
  )

  // 目标解析已归后端所有；缺失脚本仍须在 spawn 前明确报错，不能删除原来的诊断覆盖。
  test("rejects a backend target whose agent script is missing", async () => {
    await using tmp = await tmpdir()
    const config = path.join(tmp.path, "opencode.json")
    await Bun.write(config, JSON.stringify({ mcp: { chatgpt: { type: "local", command: [process.execPath, path.join(tmp.path, "mcp-server.js")] } } }))
    await expect(resolveVoiceTarget([config])).rejects.toThrow("Voice MCP executable is unavailable")
  })

  // slice 1：直连失败（如 Cloudflare 403 或收割不可用）后进入后端浏览器 CLI，仍返回浏览器页面路径的转写文本；
  // 回退成功不吞直连诊断：直连错误只影响本次请求的路径选择。
  test("falls back to the backend browser transcriber when the direct path fails", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "voice.wav")
    await Bun.write(file, "RIFF....WAVE")
    const target = await browserFixture(tmp.path, "process.stdout.write(JSON.stringify({ text: 'fallback browser text', auth: { cookies: [], fetchedAt: '2026-09-18T00:00:00Z' } }))")
    await Bun.write(target.config, JSON.stringify({ mcp: { chatgpt: { auth: { cookies: {}, fetched_at: "2026-09-18T00:00:00Z" } } } }))
    // 直连 403 与收割不可用同时注入：两级失败都压到同一回退口，覆盖最坏链路。
    // 只隔离真实远端网络，profile 失败与浏览器协议解析仍执行实际子进程。
    const transport = spyOn(NetworkProxy, "fetch").mockResolvedValue(new Response("{}", { status: 403 }))
    try {
      expect(await transcribeVoiceFile(file, target, new AbortController().signal)).toBe("fallback browser text")
    } finally { transport.mockRestore() }
  })

  // slice 2：直连成功时浏览器 argv 不得被调用（marker 文件是 argv 被调用的磁盘证据）。
  // 该断言锁定"直连是主路径"：成功场景回落浏览器会浪费整段 daemon 生命周期。
  test("uses the direct path without spawning the fallback argv", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "voice.wav")
    await Bun.write(file, "RIFF....WAVE")
    const marker = path.join(tmp.path, "argv-invoked")
    const target = await browserFixture(tmp.path, `require('fs').writeFileSync(${JSON.stringify(marker)}, '1')`)
    // R12仍支持没有Bearer的Cookie快照；此fixture验证匿名成功时不启动浏览器。
    await Bun.write(target.config, JSON.stringify({ mcp: { chatgpt: { auth: { cookies: { session: { value: "fixture", expires: 0 } }, fetched_at: "2026-09-18T00:00:00Z" } } } }))
    const transport = spyOn(NetworkProxy, "fetch").mockImplementation(async (_url, init) => {
      expect(new Headers(init?.headers).get("cookie")).toBe("session=fixture")
      expect(new Headers(init?.headers).has("authorization")).toBe(false)
      return Response.json({ text: "direct text" })
    })
    try {
      expect(await transcribeVoiceFile(file, target, new AbortController().signal)).toBe("direct text")
      expect(await Bun.file(marker).exists()).toBe(false)
    } finally { transport.mockRestore() }
  })

  // 双重 opt-in 才允许关闭真实默认 MCP；普通 CI 和旧隔离 profile 用例不改变生命周期。
  defaultProfileE2E(
    "accepts the actual default MCP profile and browser snapshots across subsequent requests",
    async () => {
      const userConfig = process.env.CHATGPT_VOICE_USER_CONFIG
      if (process.platform !== "win32" || !userConfig || !process.env.LOCALAPPDATA) throw new Error("Default profile acceptance requires explicit Windows user config")
      const configured = await resolveVoiceTarget([userConfig])
      const environment = { ...process.env, ...configured.environment }
      // 非默认 profile/CDP 不能借本测试获得关闭授权；配置读取只用于绑定真实 Node 和 CLI。
      for (const key of ["CHATGPT_STATE_DIR", "CHATGPT_BROWSER_USER_DATA_DIR", "CHATGPT_BROWSER_PROFILE_DIRECTORY", "CHATGPT_BROWSER_CDP_URL", "CHATGPT_BROWSER_WS_ENDPOINT", "CHATGPT_BROWSER_DEBUG_PORT", "OPENCODE_DATA_DIR"]) {
        if (environment[key]) throw new Error("Default profile acceptance refuses overridden browser ownership")
      }
      const state = path.join(process.env.LOCALAPPDATA, "opencode", "chatgpt-browser-agent", "state")
      // 保留原字节用于最终比较，证明 fixture 写回没有误伤用户配置中的旧认证或其他设置。
      const originalConfig = Buffer.from(await Bun.file(userConfig).arrayBuffer())
      // 凭据只经过内存管道；CLI 的完整 stdout/stderr 不进入测试断言或错误报告。
      const cli = (args: string[]) => Process.run([configured.interpreter, configured.script, ...args], {
        env: configured.environment, nothrow: true, killTree: false, abort: AbortSignal.timeout(120_000),
      })
      const status = async () => {
        const daemon = await Bun.file(path.join(state, "daemon.json")).json()
        // 本地管理Bearer只发到回环地址；外部Bearer必须来自本次浏览器成功快照，不能混用。
        const response = await fetch(`http://127.0.0.1:${daemon.port}/status`, {
          headers: { authorization: `Bearer ${daemon.token}` }, signal: AbortSignal.timeout(5_000),
        })
        const body = await response.json()
        // 重读状态文件并校验 daemonID，避免旧端口被复用后对错误进程执行生命周期操作。
        if (!response.ok || body.daemonID !== daemon.daemonID) throw new Error("MCP status identity failed")
        return { ...body, version: daemon.version }
      }
      const before = await status()
      // ask 锁、pending 和 voice 队列都必须为空；仅 CLI 摘要的 Active locks 不足以证明可停。
      expect(before.browserConnected === true && before.activeLocks === 0 && before.pendingPageCount === 0 && before.voiceActive === 0 && before.voiceQueued === 0).toBe(true)
      const browser = await Bun.file(path.join(state, "browser-pid.json")).json()
      expect(Number.isInteger(browser.pid) && Number.isInteger(before.pid)).toBe(true)
      const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
      const root = path.join(os.tmpdir(), "opencode", "voice")
      await fs.mkdir(root, { recursive: true })
      const directory = await fs.mkdtemp(path.join(root, "default-profile-acceptance-"))
      const wav = path.join(directory, "hello.wav")
      const config = path.join(directory, "opencode.json")
      // 只替换写回目的地，解释器、脚本和 MCP 环境全部沿真实配置，避免隔离 state 偷换实际 profile。
      const target = { ...configured, config }
      const failures: string[] = []
      let stopped = false
      let restored = before.browserConnected === true
      try {
        // Windows 不执行 POSIX mode；取消继承并仅授权当前账户，保证临时 auth 配置是私有文件。
        const acl = await Process.run(["icacls", directory, "/inheritance:r", "/grant:r", `${os.userInfo().username}:(OI)(CI)F`], { nothrow: true })
        expect(acl.code).toBe(0)
        await fs.copyFile(path.join(path.dirname(configured.script), "test-voice-hello.wav"), wav)
        expect((await cli(["--stop"])).code).toBe(0)
        stopped = true
        restored = false
        const deadline = Date.now() + 35_000
        // 等待精确记录的两个 PID 退出，不能把 stop 的 HTTP 接受当作 Cookie 已落盘。
        while ((alive(before.pid) || alive(browser.pid)) && Date.now() < deadline) await Bun.sleep(100)
        expect(alive(before.pid) || alive(browser.pid)).toBe(false)
        console.log(JSON.stringify({ profileClosed: true }))
        for (const scenario of ["profile", "browser"] as const) {
          const evidence = { scenario, exportCode: -1, exportedCookies: 0, profileCookieOnly: false, directStatuses: [] as number[], bearerSent: [] as boolean[], snapshotReused: true, helloWorld: [] as boolean[], persistedCookies: 0, persistedBearer: false, browserSubmitted: 0, daemonVersion: 0, challenge: false, retryAfterSeconds: 0, proxyRouted: false, errorJson: false, rateLimited: false, authRejected: false }
          // 前一个真实场景可能触发浏览器回退；只比较本场景增量，不把累计提交误判为重复发送。
          const initialSubmitted = await status().then((value) => value.voiceSubmitted, () => 0)
          // 原网络实现始终留存；仅 browser 场景首个外部请求注入 503，不伪造成功正文。
          const originalFetch = NetworkProxy.fetch
          let requests = 0
          let saved: Awaited<ReturnType<typeof readVoiceAuth>>
          const transport = spyOn(NetworkProxy, "fetch").mockImplementation(async (url, init) => {
            requests++
            const headers = new Headers(init?.headers)
            evidence.bearerSent.push(headers.has("authorization"))
            // R12同时比对Cookie和实际落盘Bearer；只断言布尔值，失败也不能打印认证头。
            if (saved) evidence.snapshotReused &&= headers.get("cookie") === Object.entries(saved.cookies).filter(([, c]) => c.expires <= 0 || c.expires > Date.now() / 1000).map(([name, c]) => `${name}=${c.value}`).join("; ") && headers.get("authorization") === (saved.access_token ? `Bearer ${saved.access_token}` : null)
            if (scenario === "browser" && requests === 1) { evidence.directStatuses.push(503); return new Response(null, { status: 503 }) }
            const response = await originalFetch(url, init)
            evidence.directStatuses.push(response.status)
            evidence.challenge ||= response.headers.get("cf-mitigated") === "challenge"
            evidence.retryAfterSeconds = Number(response.headers.get("retry-after")) || 0
            // 只观察既有请求的错误副本，不增加远端重试；正文只转成已知类别布尔值。
            if (!response.ok) {
              const body = await response.clone().text()
              evidence.proxyRouted = (await NetworkProxy.resolveProxyRoute(String(url), "provider")).type === "proxy"
              evidence.errorJson ||= (response.headers.get("content-type") ?? "").includes("application/json")
              evidence.rateLimited ||= /rate.limit|too many requests|quota|limit for dictation without an account/i.test(body)
              evidence.authRejected ||= /unauthorized|invalid.token|expired.token|authentication.required/i.test(body)
            }
            return response
          })
          try {
            // 绝不复制用户旧 auth：profile 从缺席开始，browser 从空节点进入受控 503。
            await Bun.write(config, JSON.stringify({ mcp: { [target.key]: scenario === "profile" ? {} : { auth: { cookies: {}, fetched_at: new Date().toISOString() } } } }))
            if (scenario === "profile") {
              const exported = await cli(["auth-export", "--json"])
              evidence.exportCode = exported.code
              if (exported.code !== 0) {
                // 只分类已知环境错误，避免 Node 或远端错误意外携带凭据正文。
                failures.push(exported.stderr.includes("unable to open database") ? "profile:sqlite-open" : "profile:export-failed")
                continue
              }
              // 独立导出只证明关闭后的 reader 可用；后端必须自行再次收割，测试不向它注入导出结果。
              const payload = JSON.parse(exported.stdout.toString())
              evidence.exportedCookies = payload.cookies.length
              evidence.profileCookieOnly = payload.accessToken === undefined && payload.access_token === undefined
              expect(evidence.exportedCookies > 0).toBe(true)
              expect(evidence.profileCookieOnly).toBe(true)
            }
            for (let call = 0; call < 2; call++) {
              const text = await transcribeVoiceFile(wav, target, AbortSignal.timeout(120_000))
              // 独立已知音频 marker 排除空文字或错误页被视作成功，日志只保留匹配布尔值。
              evidence.helloWorld.push(/hello/i.test(text) && /world/i.test(text))
              expect(evidence.helloWorld.at(-1)).toBe(true)
              const auth = await readVoiceAuth(config, target.key)
              evidence.persistedCookies = Object.keys(auth?.cookies ?? {}).length
              evidence.persistedBearer = typeof auth?.access_token === "string" && auth.access_token.length > 0
              expect(evidence.persistedCookies > 0).toBe(true)
              if (call === 0) saved = auth
              // profile匿名额度不足可进入浏览器；后继请求必须只复用该次成功写回的完整快照。
              if (await Bun.file(path.join(state, "daemon.json")).exists()) {
                const current = await status()
                evidence.browserSubmitted = current.voiceSubmitted - initialSubmitted
                evidence.daemonVersion = current.version
                restored = current.browserConnected === true
                expect(evidence.daemonVersion).toBe(26)
              }
            }
            // 保留R11的429红信号；R12修复的是后继账户请求，不把首次匿名失败伪装成200。
            const recovered = scenario === "browser" || evidence.directStatuses[0] === 429
            expect(evidence.browserSubmitted).toBe(recovered ? 1 : 0)
            expect(evidence.snapshotReused).toBe(true)
            expect(evidence.persistedBearer).toBe(recovered)
            expect(evidence.bearerSent).toEqual([false, recovered])
            // profile匿名额度尚可用时允许200；两种输入域的第二次实际直连都必须200且不再提交浏览器。
            expect(evidence.directStatuses).toEqual(scenario === "profile" ? [recovered ? 429 : 200, 200] : [503, 200])
          } catch {
            // 测试失败仍继续另一条真实链路；不把凭据对象或响应文本放入 Bun 的失败快照。
            failures.push(`${scenario}:acceptance-failed`)
          } finally {
            // 场景异常也恢复网络 seam，首个 503 注入不得污染后继场景或同进程普通测试。
            transport.mockRestore()
            console.log(JSON.stringify(evidence))
          }
        }
      } finally {
        // profile 失败也必须恢复正常 MCP；仅真实转录启动既有 CLI，不发送 ask 或改写登录状态。
        try {
          if (stopped && !restored) {
            const result = await cli(["transcribe-file", "--file", wav, "--json"])
            console.log(JSON.stringify({ restoreVoiceExitCode: result.code }))
            restored = await status().then((value) => value.browserConnected === true, () => false)
          }
        } finally {
          // 即使恢复命令超时也必须清除私有配置；真实 profile 和正常 daemon 始终保留。
          await fs.rm(directory, { recursive: true, force: true })
        }
        const configUnchanged = originalConfig.equals(Buffer.from(await Bun.file(userConfig).arrayBuffer()))
        const temporaryRemoved = !await Bun.file(config).exists() && !await Bun.file(wav).exists()
        // 连接可用还不足以证明清理完成；voice队列和ask锁都归零才交还正常MCP。
        const finalStatus = await status()
        const idle = finalStatus.activeLocks === 0 && finalStatus.pendingPageCount === 0 && finalStatus.voiceActive === 0 && finalStatus.voiceQueued === 0
        console.log(JSON.stringify({ restored, idle, configUnchanged, temporaryRemoved }))
        expect(restored && idle && configUnchanged && temporaryRemoved).toBe(true)
      }
      expect(failures).toEqual([])
    },
    360_000,
  )

  // 此窄门禁保留profile匿名额度可用时的无浏览器断言；R12账户恢复由上方默认profile验收覆盖。
  // 运行：CHATGPT_VOICE_E2E=1 CHATGPT_BROWSER_USER_DATA_DIR=<agent-profile> bun test test/cli/tui/prompt-voice-input.test.ts --test-name-pattern "direct harvest"
  voiceE2E(
    "harvests real credentials and transcribes directly without the browser page path",
    async () => {
      if (!process.env.CHATGPT_BROWSER_USER_DATA_DIR) {
        throw new Error("voice E2E requires CHATGPT_BROWSER_USER_DATA_DIR for a logged-in agent profile")
      }
      const agent = path.resolve(import.meta.dir, "../../../../../thirdparty/chatgpt-browser-agent")
      const script = path.join(agent, "chatgpt.js")
      const source = path.join(agent, "test-voice-hello.wav")
      const root = path.join(os.tmpdir(), "opencode", "voice")
      const state = path.join(root, `direct-e2e-state-${process.pid}`)
      const previousState = process.env.CHATGPT_STATE_DIR
      // daemon state 隔离（同 darwin E2E 模式）：profile 复用登录，state/token/日志按 PID 分离。
      process.env.CHATGPT_STATE_DIR = state
      const wav = path.join(root, `direct-e2e-${process.pid}.wav`)
      const config = path.join(root, `direct-e2e-config-${process.pid}.json`)
      await fs.mkdir(root, { recursive: true })
      await fs.copyFile(source, wav)
      await Bun.write(config, JSON.stringify({ mcp: { chatgpt: { type: "local", command: ["node", script] } } }))
      // 真实 profile 收割由后端完成；TUI 不再持有 token 或嵌套转写器配置。
      const direct: VoiceTarget = {
        config,
        key: "chatgpt",
        interpreter: "node",
        script,
        environment: { CHATGPT_STATE_DIR: state, CHATGPT_BROWSER_USER_DATA_DIR: process.env.CHATGPT_BROWSER_USER_DATA_DIR },
      }
      try {
        const text = await transcribeVoiceFile(wav, direct, AbortSignal.timeout(120_000))
        const lowered = text.toLowerCase()
        // markers 与 darwin 五分钟 E2E 独立：hello/world 只能来自真实直连响应体。
        if (!lowered.includes("hello") || !lowered.includes("world")) throw new Error(`direct E2E markers missing: ${text.slice(0, 120)}`)
        // 本用例限定profile匿名直连成功，落盘仍只有Cookie；浏览器成功快照在R12另附Bearer。
        const authNode = await readVoiceAuth(config, "chatgpt")
        if (!authNode) throw new Error("direct E2E did not persist the harvested auth node")
        if (Object.keys(authNode.cookies).length === 0) throw new Error("direct E2E auth node has no cookies")
        // 文字本身不能证明走了直连；隔离 state 中出现 daemon 则说明末级浏览器被启动。
        expect(await Bun.file(path.join(state, "daemon.json")).exists()).toBe(false)
        expect(lowered).toContain("hello")
        expect(lowered).toContain("world")
      } finally {
        // 隔离 daemon 用真实 CLI ownership 收敛；删除顺序与 darwin E2E 一致（先停进程再删 state）。
        const stop = Bun.spawn(["node", script, "--stop"], { cwd: agent, env: process.env, stdout: "ignore", stderr: "ignore", windowsHide: true })
        await stop.exited
        await fs.rm(state, { recursive: true, force: true })
        await fs.rm(wav, { force: true })
        await fs.rm(config, { force: true })
        if (previousState === undefined) delete process.env.CHATGPT_STATE_DIR
        else process.env.CHATGPT_STATE_DIR = previousState
      }
    },
    300_000,
  )
})
