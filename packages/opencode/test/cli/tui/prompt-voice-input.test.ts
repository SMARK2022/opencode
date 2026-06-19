import { describe, expect, test } from "bun:test"
import path from "path"
import { tmpdir } from "../../fixture/fixture"
import {
  createVoiceInputController,
  transcribeVoiceFile,
  voiceInputStatusText,
  type VoiceRecorderHandle,
  type VoiceTranscriber,
} from "../../../src/cli/cmd/tui/prompt-voice-input"

const nodeJson = (script: string): VoiceTranscriber => ({
  command: process.execPath,
  args: ["-e", script, "{file}"],
})

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
})
