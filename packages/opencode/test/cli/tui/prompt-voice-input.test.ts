import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "path"
import { createRoot, createSignal } from "solid-js"
import { tmpdir } from "../../fixture/fixture"
import {
  createVoiceInputController,
  transcribeVoiceFile,
  voiceInputStatusText,
  voiceHintVisible,
  type VoiceRecorderHandle,
  type VoiceTranscriber,
} from "../../../src/cli/cmd/tui/prompt-voice-input"
import { createRefreshClock } from "../../../src/cli/cmd/tui/util/signal"

const nodeJson = (script: string): VoiceTranscriber => ({
  command: process.execPath,
  args: ["-e", script, "{file}"],
})

const voiceE2E = process.env.CHATGPT_VOICE_E2E === "1" ? test : test.skip

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
  // 这个用例锁定 argv 传参边界：录音文件路径只能作为一个参数进入转写器。
  // 路径里的空格、分号和变量字符都必须保持字面量，不能被 shell 展开。
  // 这里不检查实现函数名，只观察转写器实际收到的参数值，避免测试和实现耦合。
  // out.wav 不存在用于证明命令字符串没有被拼接执行，也没有触发额外重定向或副作用。
  // 该边界直接保护用户临时录音文件名，不能因为平台差异退回 shell 字符串。
  test("passes the audio file as one argv argument without shell expansion", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "voice $HOME ; echo nope.wav")
    await Bun.write(file, "RIFF....WAVE")

    const text = await transcribeVoiceFile({
      file,
      transcriber: nodeJson("process.stdout.write(JSON.stringify({ text: process.argv[1] }))"),
    })

    expect(text).toBe(file)
    expect(await Bun.file(path.join(tmp.path, "out.wav")).exists()).toBe(false)
  })

  // `{file}` 是唯一允许把录音文件传给外部转写器的占位符。
  // 缺少它时即使命令能运行，也不能证明实际录音被提交给后端。
  // 提前拒绝可以避免用户录完才发现配置吞掉了音频文件。
  // 这个错误路径也防止未来把默认转写命令简化成固定 stdin 或隐式路径。
  // 测试只断言用户可见行为，不依赖参数解析内部结构。
  test("requires a file placeholder so the transcriber cannot ignore the recording", async () => {
    await expect(
      transcribeVoiceFile({
        file: "voice.wav",
        transcriber: { command: process.execPath, args: ["-e", "process.stdout.write('{}')"] },
      }),
    ).rejects.toThrow(/\{file\}/)
  })

  // 外部转写器是独立进程，成功退出也可能返回非 JSON 或空文本。
  // TUI 不能把这些输出直接插入 prompt，否则用户会看到不可诊断的脏文本。
  // 非 JSON 和空白 text 是两个不同失败面：前者是协议错误，后者是转写失败。
  // 这里分别覆盖它们，保证错误提示来自 controller 边界而不是后续 UI 崩溃。
  // 该测试保持真实子进程路径，覆盖 stdout 解析而不是 mock 解析器。
  test("rejects invalid and empty transcriber output", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "voice.wav")
    await Bun.write(file, "RIFF....WAVE")

    await expect(
      transcribeVoiceFile({
        file,
        transcriber: nodeJson("process.stdout.write('not json')"),
      }),
    ).rejects.toThrow(/JSON/)

    await expect(
      transcribeVoiceFile({
        file,
        transcriber: nodeJson("process.stdout.write(JSON.stringify({ text: '   ' }))"),
      }),
    ).rejects.toThrow(/empty/)
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
  // 未配置转写器时无论多宽都不显示，避免引导用户使用未启用的能力。
  // 该判定只管显示文案，不影响 Alt+V 绑定——窄终端仍可转录，测试只断言显示决策本身。
  test("shows the voice hint only when a transcriber is configured and the prompt is wide enough", () => {
    const transcriber: VoiceTranscriber = { command: "transcriber", args: ["{file}"] }
    expect(voiceHintVisible(undefined, 999)).toBe(false)
    // 100 低于 voice 阈值 120，仍隐藏(虽已过 usage 阈值 90，但 voice 需更晚露出)
    expect(voiceHintVisible(transcriber, 100)).toBe(false)
    // 120 为开区间边界，本身不显示
    expect(voiceHintVisible(transcriber, 120)).toBe(false)
    // 121 刚过阈值，开始显示
    expect(voiceHintVisible(transcriber, 121)).toBe(true)
    expect(voiceHintVisible(transcriber, 200)).toBe(true)
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
      transcriber: () => ({ command: "transcriber", args: ["{file}"] }),
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

  // 没有转写器时必须在录音前失败，不能占用麦克风后再报错。
  // 这个边界保护未配置用户的体验，也避免产生无人消费的临时 WAV。
  // startRecorder 被设成会抛错，用来证明 controller 没有进入录音层。
  // 错误文本保持明确，方便用户知道需要配置 voice.transcriber。
  test("does not start recording when no transcriber is configured", async () => {
    let started = false
    const errors: string[] = []
    const controller = createVoiceInputController({
      transcriber: () => undefined,
      startRecorder: async () => {
        started = true
        throw new Error("should not start")
      },
      transcribe: async () => "text",
      insertText: () => {},
      onError: (message) => errors.push(message),
    })

    await controller.toggle()

    expect(started).toBe(false)
    expect(errors).toEqual(["Voice input is not configured"])
  })

  // command 缺失属于录音前校验：用户说话前就应知道转写器不可执行。
  // 这里不 mock which，而是使用明显不存在的命令走真实校验分支。
  // startRecorder 不能被调用，否则会出现“录完才 ENOENT”的坏体验。
  // 错误消息包含命令名，便于用户定位是哪一个配置项写错。
  test("does not start recording when the transcriber command is missing", async () => {
    let started = false
    const errors: string[] = []
    const controller = createVoiceInputController({
      transcriber: () => ({ command: "__opencode_missing_voice_transcriber__", args: ["{file}"] }),
      startRecorder: async () => {
        started = true
        throw new Error("should not start")
      },
      insertText: () => {},
      onError: (message) => errors.push(message),
    })

    await controller.toggle()

    expect(started).toBe(false)
    expect(errors[0]).toContain("Voice transcriber command not found")
    expect(errors[0]).toContain("__opencode_missing_voice_transcriber__")
  })

  // 默认 ChatGPT 转写器由 MCP 目录推导，因此脚本文件缺失也要提前失败。
  // 只检查 argv[0] 不够，chatgpt.js 本体丢失时 spawn 能启动但业务必然失败。
  // 该测试覆盖带空格的相对路径形态，避免路径判断只适配简单文件名。
  // 失败同样必须发生在录音前，不能消耗用户麦克风输入。
  test("does not start recording when the inferred ChatGPT script is missing", async () => {
    let started = false
    const errors: string[] = []
    const controller = createVoiceInputController({
      transcriber: () => ({
        command: process.execPath,
        args: [path.join("missing chatgpt agent", "chatgpt.js"), "transcribe-file", "--file", "{file}", "--json"],
      }),
      startRecorder: async () => {
        started = true
        throw new Error("should not start")
      },
      insertText: () => {},
      onError: (message) => errors.push(message),
    })

    await controller.toggle()

    expect(started).toBe(false)
    expect(errors[0]).toContain("Voice transcriber script not found")
    expect(errors[0]).toContain("chatgpt.js")
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
      transcriber: () => ({ command: "transcriber", args: ["{file}"] }),
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
      transcriber: () => ({ command: "transcriber", args: ["{file}"] }),
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
      transcriber: () => ({ command: "transcriber", args: ["{file}"] }),
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
      transcriber: () => ({ command: "transcriber", args: ["{file}"] }),
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
      transcriber: () => ({ command: "transcriber", args: ["{file}"] }),
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
      transcriber: () => ({ command: "transcriber", args: ["{file}"] }),
      startRecorder: async () => {
        startCount++
        return {
          file: startCount === 1 ? "first.wav" : "second.wav",
          stop: async () => {},
          abort: async () => {
            if (startCount === 1) firstAborted = true
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
      transcriber: () => ({ command: "transcriber", args: ["{file}"] }),
      startRecorder: async () => ({ file: "voice.wav", stop: async () => {}, abort: async () => {} }),
      transcribe: (_file, _transcriber, signal) => {
        transcribeSignal = signal
        resolveTranscribe?.()
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
      transcriber: () => ({ command: "transcriber", args: ["{file}"] }),
      startRecorder: async () => ({ file: "voice.wav", stop: async () => {}, abort: async () => {} }),
      transcribe: (_file, _transcriber, signal) => {
        resolveTranscribe?.()
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
      transcriber: () => ({ command: "transcriber", args: ["{file}"] }),
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
      transcriber: () => ({ command: "transcriber", args: ["{file}"] }),
      startRecorder: async () => ({ file: "voice.wav", stop: async () => {}, abort: async () => {} }),
      transcribe: (_file, _transcriber, signal) => {
        transcribeSignal = signal
        transcribeStarted()
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
      transcriber: () => ({ command: "transcriber", args: ["{file}"] }),
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
      const transcriber = { command: "node", args: [script, "transcribe-file", "--file", "{file}", "--json"] }
      const controller = createVoiceInputController({
        transcriber: () => transcriber,
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
              status: completed && stopExitCode === 0 && daemonObserved && daemonExited && stateRemoved ? "passed" : "failed",
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
})
