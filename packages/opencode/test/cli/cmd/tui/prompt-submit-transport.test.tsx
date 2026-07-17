/** @jsxImportSource @opentui/solid */
import { expect, spyOn, test } from "bun:test"
import { Global } from "@opencode-ai/core/global"
import { testRender, useRenderer } from "@opentui/solid"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { onCleanup } from "solid-js"
import fs from "fs/promises"
import path from "path"
import { pathToFileURL } from "url"
import type { Agent, Model, Provider } from "@opencode-ai/sdk/v2"
import { tmpdir } from "../../../fixture/fixture"
import { createTuiResolvedConfig } from "../../../fixture/tui-runtime"
import { Prompt, type PromptRef } from "../../../../src/cli/cmd/tui/component/prompt"
import { PromptVoiceRecorder } from "../../../../src/cli/cmd/tui/prompt-voice-recorder"
import { FrecencyProvider } from "../../../../src/cli/cmd/tui/component/prompt/frecency"
import { PromptHistoryProvider } from "../../../../src/cli/cmd/tui/component/prompt/history"
import { PromptStashProvider } from "../../../../src/cli/cmd/tui/component/prompt/stash"
import { ArgsProvider } from "../../../../src/cli/cmd/tui/context/args"
import { CommandPaletteProvider } from "../../../../src/cli/cmd/tui/context/command-palette"
import { EditorContextProvider } from "../../../../src/cli/cmd/tui/context/editor"
import { ExitProvider } from "../../../../src/cli/cmd/tui/context/exit"
import { KVProvider } from "../../../../src/cli/cmd/tui/context/kv"
import { LocalProvider, useLocal } from "../../../../src/cli/cmd/tui/context/local"
import { ProjectProvider } from "../../../../src/cli/cmd/tui/context/project"
import { PromptRefProvider } from "../../../../src/cli/cmd/tui/context/prompt"
import { RouteProvider, useRoute, type Route } from "../../../../src/cli/cmd/tui/context/route"
import { SDKProvider } from "../../../../src/cli/cmd/tui/context/sdk"
import { SyncProvider, useSync } from "../../../../src/cli/cmd/tui/context/sync"
import { ThemeProvider } from "../../../../src/cli/cmd/tui/context/theme"
import { TuiConfigProvider } from "../../../../src/cli/cmd/tui/context/tui-config"
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "../../../../src/cli/cmd/tui/keymap"
import { DialogProvider } from "../../../../src/cli/cmd/tui/ui/dialog"
import { ToastProvider } from "../../../../src/cli/cmd/tui/ui/toast"
import { createEventSource, createFetch, directory, json, wait } from "./sync-fixture"

const sessionID = "ses_prompt_transport"

const model = {
  id: "model",
  providerID: "provider",
  api: { id: "model", url: "", npm: "" },
  name: "Test Model",
  capabilities: {
    temperature: true,
    reasoning: false,
    attachment: true,
    toolcall: true,
    input: { text: true, audio: false, image: false, video: false, pdf: false },
    output: { text: true, audio: false, image: false, video: false, pdf: false },
    interleaved: false,
  },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  limit: { context: 100_000, output: 4_000 },
  status: "active",
  options: {},
  headers: {},
  release_date: "2024-01-01",
} satisfies Model

const provider = {
  id: "provider",
  name: "Provider",
  source: "custom",
  env: [],
  options: {},
  models: { model },
} satisfies Provider

const agent = {
  name: "general",
  mode: "primary",
  permission: [],
  options: {},
} satisfies Agent

test("failed TUI prompt submission keeps the draft text", async () => {
  const previous = Global.Path.state
  await using tmp = await tmpdir()
  Global.Path.state = tmp.path
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  let attempts = 0
  let shellPath = ""

  await withPrompt(
    (url) => {
      if (url.pathname === "/config/providers") return json({ providers: [provider], default: { provider: model.id } })
      if (url.pathname === "/provider") return json({ all: [provider], default: { provider: model.id }, connected: [] })
      if (url.pathname === "/agent") return json([agent])
      if (url.pathname === `/session/${sessionID}/message`) {
        attempts += 1
        throw new Error("simulated transport failure")
      }
      if (url.pathname === `/session/${sessionID}/prompt_async`) {
        attempts += 1
        throw new Error("simulated transport failure")
      }
    },
    async (prompt) => {
      prompt.set({ input: "Keep this draft", parts: [] })
      prompt.submit()

      await wait(() => attempts > 0)
      await Bun.sleep(20)

      expect(prompt.current.input).toBe("Keep this draft")
    },
  ).finally(() => {
    Global.Path.state = previous
  })
})

test("failed TUI shell submission keeps the draft text", async () => {
  const previous = Global.Path.state
  await using tmp = await tmpdir()
  Global.Path.state = tmp.path
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  let attempts = 0
  const draft = `printf '%s' "$HOME/path with spaces" | cat > "./quoted file.txt" && echo $(pwd) # rm -rf /tmp/nope`

  await withPrompt(
    (url) => {
      if (url.pathname === "/config/providers") return json({ providers: [provider], default: { provider: model.id } })
      if (url.pathname === "/provider") return json({ all: [provider], default: { provider: model.id }, connected: [] })
      if (url.pathname === "/agent") return json([agent])
      if (url.pathname === `/session/${sessionID}/shell`) {
        attempts += 1
        throw new Error("simulated shell transport failure")
      }
    },
    async (prompt) => {
      prompt.set({ input: draft, mode: "shell", parts: [] })
      prompt.submit()

      await wait(() => attempts > 0)
      await Bun.sleep(20)

      expect(prompt.current.input).toBe(draft)
    },
  ).finally(() => {
    Global.Path.state = previous
  })
})

test("accepted TUI shell submission clears without waiting for completion", async () => {
  const previous = Global.Path.state
  await using tmp = await tmpdir()
  Global.Path.state = tmp.path
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  let attempts = 0
  const draft = `printf '%s' "$HOME/path with spaces" | cat > "./quoted file.txt" && echo $(pwd) # rm -rf /tmp/nope`

  await withPrompt(
    (url) => {
      if (url.pathname === "/config/providers") return json({ providers: [provider], default: { provider: model.id } })
      if (url.pathname === "/provider") return json({ all: [provider], default: { provider: model.id }, connected: [] })
      if (url.pathname === "/agent") return json([agent])
      if (url.pathname === `/session/${sessionID}/shell`) {
        attempts += 1
        return new Promise<Response>(() => {})
      }
    },
    async (prompt) => {
      prompt.set({ input: draft, mode: "shell", parts: [] })
      prompt.submit()

      await wait(() => attempts > 0)
      await Bun.sleep(20)

      expect(prompt.current.input).toBe("")
    },
  ).finally(() => {
    Global.Path.state = previous
  })
})

test("failed new-session shell submission stays on home with the draft", async () => {
  const previous = Global.Path.state
  await using tmp = await tmpdir()
  Global.Path.state = tmp.path
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  let attempts = 0
  let shellPath = ""
  const nextSessionID = "ses_new_prompt_transport"
  const draft = `printf '%s' "$HOME/path with spaces" | cat > "./quoted file.txt" && echo $(pwd) # rm -rf /tmp/nope`

  await withPrompt(
    (url, request, init) => {
      if (url.pathname === "/config/providers") return json({ providers: [provider], default: { provider: model.id } })
      if (url.pathname === "/provider") return json({ all: [provider], default: { provider: model.id }, connected: [] })
      if (url.pathname === "/agent") return json([agent])
      if (url.pathname === "/session" && (request?.method ?? init?.method) === "POST") {
        return json({
          id: nextSessionID,
          slug: nextSessionID,
          projectID: "proj_test",
          directory,
          title: "New Session",
          version: "1",
          time: { created: 1, updated: 1 },
        })
      }
      if (url.pathname.endsWith("/shell")) {
        attempts += 1
        shellPath = url.pathname
        throw new Error("simulated shell transport failure")
      }
    },
    async (prompt, route) => {
      prompt.set({ input: draft, mode: "shell", parts: [] })
      prompt.submit()

      await wait(() => attempts > 0)
      await Bun.sleep(80)

      expect(shellPath).toBe(`/session/${nextSessionID}/shell`)
      expect(route.data.type).toBe("home")
      expect(prompt.current.input).toBe(draft)
    },
    { initialRoute: { type: "home" }, promptSessionID: undefined },
  ).finally(() => {
    Global.Path.state = previous
  })
})

test("failed TUI slash-command submission keeps the draft text", async () => {
  const previous = Global.Path.state
  await using tmp = await tmpdir()
  Global.Path.state = tmp.path
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  let attempts = 0
  const draft = `/review "path with spaces" '$HOME' | cat > out.txt $(pwd) rm -rf /tmp/nope`

  await withPrompt(
    (url) => {
      if (url.pathname === "/config/providers") return json({ providers: [provider], default: { provider: model.id } })
      if (url.pathname === "/provider") return json({ all: [provider], default: { provider: model.id }, connected: [] })
      if (url.pathname === "/agent") return json([agent])
      if (url.pathname === "/command") {
        return json([{ name: "review", source: "command", template: "", hints: [] }])
      }
      if (url.pathname === `/session/${sessionID}/command`) {
        attempts += 1
        throw new Error("simulated command transport failure")
      }
    },
    async (prompt) => {
      prompt.set({ input: draft, parts: [] })
      prompt.submit()

      await wait(() => attempts > 0)
      await Bun.sleep(20)

      expect(prompt.current.input).toBe(draft)
    },
  ).finally(() => {
    Global.Path.state = previous
  })
})

test("accepted TUI slash-command submission clears without waiting for completion", async () => {
  const previous = Global.Path.state
  await using tmp = await tmpdir()
  Global.Path.state = tmp.path
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  let attempts = 0
  const draft = `/review "path with spaces" '$HOME' | cat > out.txt $(pwd) rm -rf /tmp/nope`

  await withPrompt(
    (url) => {
      if (url.pathname === "/config/providers") return json({ providers: [provider], default: { provider: model.id } })
      if (url.pathname === "/provider") return json({ all: [provider], default: { provider: model.id }, connected: [] })
      if (url.pathname === "/agent") return json([agent])
      if (url.pathname === "/command") {
        return json([{ name: "review", source: "command", template: "", hints: [] }])
      }
      if (url.pathname === `/session/${sessionID}/command`) {
        attempts += 1
        return new Promise<Response>(() => {})
      }
    },
    async (prompt) => {
      prompt.set({ input: draft, parts: [] })
      prompt.submit()

      await wait(() => attempts > 0)
      await Bun.sleep(20)

      expect(prompt.current.input).toBe("")
    },
  ).finally(() => {
    Global.Path.state = previous
  })
})

test("TUI prompt keeps pasted text summary highlighted after wide text is inserted before it", async () => {
  const previous = Global.Path.state
  await using tmp = await tmpdir()
  Global.Path.state = tmp.path
  await Bun.write(`${tmp.path}/kv.json`, "{}")

  await withPrompt(
    (url) => {
      if (url.pathname === "/config/providers") return json({ providers: [provider], default: { provider: model.id } })
      if (url.pathname === "/provider") return json({ all: [provider], default: { provider: model.id }, connected: [] })
      if (url.pathname === "/agent") return json([agent])
    },
    async (_prompt, _route, app) => {
      // 三行 bracketed paste 会触发产品内置的摘要文案；prefix 刻意使用中文宽字符复现坐标漂移。
      const summary = "[Pasted ~3 lines]"
      const prefix = "就按照这种来修改 "

      await app.mockInput.pasteBracketedText("one\ntwo\nthree")
      await wait(() => app.captureCharFrame().includes(summary))

      app.mockInput.pressKey("HOME")
      await app.mockInput.typeText(prefix)

      // 行为断言走真实 TUI 渲染帧：用户可见的黄色高亮必须只覆盖粘贴摘要，
      // 不能因为摘要前插入中文宽字符而吞掉前缀或漏掉摘要尾部。
      const line = await waitForSpanLine(app, prefix.trim(), summary)
      const prefixSpan = line.spans.find((span) => span.text.includes(prefix.trim()))
      const summarySpan = line.spans.find((span) => span.text === summary)

      expect(prefixSpan).toBeDefined()
      expect(summarySpan).toBeDefined()
      expect(colorKey(summarySpan!.bg)).not.toBe(colorKey(prefixSpan!.bg))
    },
  ).finally(() => {
    Global.Path.state = previous
  })
})

test("TUI prompt keeps image placeholder highlighted after wide text is inserted before it", async () => {
  const previous = Global.Path.state
  await using tmp = await tmpdir()
  Global.Path.state = tmp.path
  await Bun.write(`${tmp.path}/kv.json`, "{}")

  await withPrompt(
    (url) => {
      if (url.pathname === "/config/providers") return json({ providers: [provider], default: { provider: model.id } })
      if (url.pathname === "/provider") return json({ all: [provider], default: { provider: model.id }, connected: [] })
      if (url.pathname === "/agent") return json([agent])
    },
    async (prompt, _route, app) => {
      // [Image 1] 是首个图片附件的用户可见占位符；中文 prefix 用来验证文件 extmark 不被前插宽字符拖偏。
      const placeholder = "[Image 1]"
      const prefix = "就按照这种来修改 "

      prompt.set({
        input: `${placeholder} `,
        parts: [
          {
            type: "file",
            mime: "image/png",
            filename: "clipboard.png",
            url: "data:image/png;base64,abc",
            // 模拟真实图片粘贴后的可见占位符；断言用户可见 span，不依赖内部 extmark id。
            source: { type: "file", path: "clipboard.png", text: { start: 0, end: placeholder.length, value: placeholder } },
          },
        ],
      })
      await wait(() => app.captureCharFrame().includes(placeholder))

      app.mockInput.pressKey("HOME")
      await app.mockInput.typeText(prefix)

      // 图片占位符使用文件 extmark 样式；这里比较前景色，避免绑定具体主题色值。
      const line = await waitForSpanLine(app, prefix.trim(), placeholder)
      const prefixSpan = line.spans.find((span) => span.text.includes(prefix.trim()))
      const imageSpan = line.spans.find((span) => span.text === placeholder)

      expect(prefixSpan).toBeDefined()
      expect(imageSpan).toBeDefined()
      expect(colorKey(imageSpan!.fg)).not.toBe(colorKey(prefixSpan!.fg))
    },
  ).finally(() => {
    Global.Path.state = previous
  })
})

test("keeps the constrained Prompt extension bar on one row across active states", async () => {
  const previousState = Global.Path.state
  const previousRegistry = process.env.OPENCODE_IDE_REGISTRY_DIR
  await using tmp = await tmpdir()
  Global.Path.state = tmp.path
  process.env.OPENCODE_IDE_REGISTRY_DIR = path.join(tmp.path, "ide")
  await fs.mkdir(process.env.OPENCODE_IDE_REGISTRY_DIR, { recursive: true })
  await Bun.write(path.join(tmp.path, "kv.json"), "{}")
  // 重复片段刻意让路径超过 75 个终端单元，验证的是可见 suffix 而非 JavaScript 字符数阈值。
  await Bun.write(
    path.join(process.env.OPENCODE_IDE_REGISTRY_DIR, "vscode.json"),
    JSON.stringify({
      schema: 1,
      updatedAt: Date.now(),
      workspaceFolders: [{ fsPath: process.cwd(), uri: pathToFileURL(process.cwd()).toString() }],
      active: { textEditor: pathToFileURL(path.join(process.cwd(), `${"very-long-".repeat(8)}hotspots.md`)).toString() },
    }),
  )
  // recorder 只隔离本机麦克风边界；状态切换仍走真实 controller、快捷键和挂起转写进程。
  const recorder = spyOn(PromptVoiceRecorder, "startPromptVoiceRecorder").mockResolvedValue({ file: path.join(tmp.path, "voice.wav"), stop: async () => {}, abort: async () => {} })

  try {
    await withPrompt(
      () => undefined,
      async (_prompt, _route, app, context) => {
        // 160 列终端内限制真实 Prompt 为首页的 75 列，专门锁定“终端宽但 Prompt 窄”的首个偏差。
        // 断言最终字符帧而非复制 Yoga 算法，确保宽字符、flex 收缩和 renderer 换行都走生产路径。
        const waitForFrame = async (predicate: (frame: string) => boolean) => {
          for (let index = 0; index < 200; index++) {
            await app.renderOnce()
            const frame = app.captureCharFrame()
            if (predicate(frame)) return frame
            await Bun.sleep(10)
          }
          throw new Error("Prompt footer frame did not settle")
        }
        const extensionRows = (frame: string) => {
          const lines = frame.split("\n")
          // 输入框底边是稳定的用户可见边界，避免用组件节点或私有 renderer 尺寸定义“扩展栏”。
          const separator = lines.findIndex((line) => line.includes("╹"))
          return lines.slice(separator + 1).filter((line) => line.trim()).length
        }

        const idle = await waitForFrame((frame) => frame.includes("hotspots.md"))
        app.mockInput.pressKey("v", { meta: true })
        const recording = await waitForFrame((frame) => frame.includes("Recording") || frame.includes("Rec 00:"))
        app.mockInput.pressKey("v", { meta: true })
        const transcribing = await waitForFrame((frame) => frame.includes("Transcribing"))

        // 再次触发同一绑定必须先取消挂起转写，避免测试把子进程和 90 秒超时泄漏到后续用例。
        app.mockInput.pressKey("v", { meta: true })
        await waitForFrame((frame) => !frame.includes("Transcribing"))
        emitSessionStatus(context, "evt-prompt-footer-busy", { type: "busy" })
        await wait(() => context.sync.data.session_status?.[sessionID]?.type === "busy")
        const busy = await settlePromptFrame(app)

        // 超长 retry 同时施压摘要、固定元数据和 interrupt，防止仅修普通文件行却漏掉错误态。
        emitSessionStatus(context, "evt-prompt-footer-retry", {
          type: "retry",
          attempt: 7,
          next: Date.now() + 9_000,
          message: "Cannot connect to API: The socket connection was closed unexpectedly. Inspect the full provider transport failure for additional diagnostic information.",
        })
        await wait(() => context.sync.data.session_status?.[sessionID]?.type === "retry")
        const retry = await settlePromptFrame(app)

        // idle 当前可能恰好单行，但仍必须进入矩阵，防止修 active 状态时破坏原始长文件场景。
        expect([idle, busy, recording, transcribing, retry].map(extensionRows)).toEqual([1, 1, 1, 1, 1])
        expect(idle).toContain("hotspots.md")
        expect(busy).toContain("hotspots.md")
        expect(busy).toContain("interrupt")
        expect(recording).toContain("Rec 00:")
        expect(recording).toContain("alt+v stop")
        expect(transcribing).toContain("Transcribing...")
        expect(transcribing).not.toContain("Transcribing voice...")
      },
      {
        width: 160,
        promptWidth: 75,
        config: createTuiResolvedConfig({ voice: { transcriber: { command: process.execPath, args: ["-e", "await new Promise(() => {})", "{file}"] } } }),
      },
    )
  } finally {
    recorder.mockRestore()
    Global.Path.state = previousState
    if (previousRegistry === undefined) delete process.env.OPENCODE_IDE_REGISTRY_DIR
    else process.env.OPENCODE_IDE_REGISTRY_DIR = previousRegistry
  }
})

test("opens the original retry error from the compact details affordance", async () => {
  const previousState = Global.Path.state
  await using tmp = await tmpdir()
  Global.Path.state = tmp.path
  await Bun.write(path.join(tmp.path, "kv.json"), "{}")
  // 长度落在旧 80/120 门槛夹缝内，并携带换行与重复空格以区分摘要和原始详情。
  const message = "Retry provider request failed:\nThe socket   closed before the response completed. diagnostic-tail-81-to-120"

  try {
    await withPrompt(
      () => undefined,
      async (prompt, _route, app, context) => {
        // 模块级 draft stash 会跨同文件用例保留，先清空以免前一条图片草稿污染对话框帧。
        prompt.reset()
        emitSessionStatus(context, "evt-prompt-footer-details", { type: "retry", attempt: 2, next: Date.now() + 9_000, message })
        await wait(() => context.sync.data.session_status?.[sessionID]?.type === "retry")
        let frame = await settlePromptFrame(app)

        // footer 只展示压平后的单行摘要；换行和重复空格不能重新占用状态栏宽度。
        const lines = frame.split("\n")
        const detailsY = lines.findIndex((line) => line.includes("details"))
        const footerLine = lines[detailsY] ?? ""
        expect(footerLine).toContain("Retry provider request f")
        expect(footerLine).toContain("tail-81-to-120")
        expect(footerLine).not.toContain("socket   closed")
        expect(footerLine).not.toContain("click to expand")
        const detailsX = lines[detailsY]?.indexOf("details") ?? -1
        expect(detailsX).toBeGreaterThanOrEqual(0)
        // 坐标来自最终字符帧中的可见令牌，确保测试覆盖用户实际能点击的命中区域。
        const targetX = detailsX + Math.floor("details".length / 2)
        app.renderer.clearSelection()
        await app.mockMouse.moveTo(targetX, detailsY)
        await app.renderOnce()
        await app.mockMouse.click(targetX, detailsY)

        // 点击行为通过真实 dialog frame 验证，避免断言私有 handler 或 DialogAlert 调用次数。
        frame = await settlePromptFrame(app)
        expect(frame).toContain("Retry Error")
        // 对话框保留三连空格，证明压平只属于 footer 展示层，没有污染诊断原文。
        expect(frame).toContain("The socket   closed before the response completed")
        expect(frame).toContain("diagnostic-tail-81-to-120")
      },
      { width: 160, promptWidth: 100 },
    )
  } finally {
    Global.Path.state = previousState
  }
})

type FetchHandler = Parameters<typeof createFetch>[0]
type PromptContext = { emit: ReturnType<typeof createEventSource>["emit"]; sync: ReturnType<typeof useSync> }
type PromptStatus = NonNullable<PromptContext["sync"]["data"]["session_status"]>[string]

function emitSessionStatus(context: PromptContext, id: string, status: PromptStatus) {
  // 状态必须经过 SDK event source 进入 SyncProvider，测试不能直接写 store 绕过生产消费链。
  context.emit({ directory, project: "proj_test", payload: { id, type: "session.status", properties: { sessionID, status } } })
}

async function settlePromptFrame(app: Awaited<ReturnType<typeof testRender>>) {
  // promptWidth 在首帧由 Yoga 回填；等待固定数量的真实渲染帧后再读取最终布局。
  for (let index = 0; index < 5; index++) await app.renderOnce()
  return app.captureCharFrame()
}

async function withPrompt(
  override: FetchHandler,
  run: (
    prompt: PromptRef,
    route: ReturnType<typeof useRoute>,
    app: Awaited<ReturnType<typeof testRender>>,
    context: PromptContext,
  ) => Promise<void>,
  options: {
    initialRoute?: Route
    promptSessionID?: string
    width?: number
    promptWidth?: number
    config?: ReturnType<typeof createTuiResolvedConfig>
  } = {},
) {
  const calls = createFetch(override)
  const events = createEventSource()
  let prompt!: PromptRef
  let sync!: ReturnType<typeof useSync>
  let local!: ReturnType<typeof useLocal>
  let route!: ReturnType<typeof useRoute>
  let ready!: () => void
  const mounted = new Promise<void>((resolve) => {
    ready = resolve
  })

  const app = await testRender(
    () => (
      <PromptHarness
        fetch={calls.fetch}
        events={events.source}
        initialRoute={options.initialRoute ?? { type: "session", sessionID }}
        promptSessionID={"promptSessionID" in options ? options.promptSessionID : sessionID}
        onContext={(nextSync, nextLocal) => {
          sync = nextSync
          local = nextLocal
        }}
        onRoute={(nextRoute) => {
          route = nextRoute
        }}
        onPrompt={(ref) => {
          prompt = ref
          ready()
        }}
        config={options.config}
        promptWidth={options.promptWidth}
      />
    ),
    {
      // 默认 100 列保持旧 transport 用例不变，只有布局回归显式模拟首页的 75 列 Prompt。
      width: options.width ?? 100,
      height: 20,
      footerHeight: 0,
    },
  )

  try {
    await mounted
    await wait(() => sync.status === "complete" && local.model.ready)
    // 只把 renderer 传给需要断言用户可见帧的测试；既有 transport 测试会自然忽略第三个参数。
    await run(prompt, route, app, { emit: events.emit, sync })
  } finally {
    app.renderer.destroy()
  }
}

async function waitForSpanLine(app: Awaited<ReturnType<typeof testRender>>, ...texts: string[]) {
  // captureSpans 按样式切分文本；等待包含所有可见片段的行，避免断言依赖 DOM/组件结构。
  let frame = app.captureSpans()
  await wait(() => {
    frame = app.captureSpans()
    return frame.lines.some((line) => texts.every((text) => line.spans.map((span) => span.text).join("").includes(text)))
  })

  const line = frame.lines.find((line) => texts.every((text) => line.spans.map((span) => span.text).join("").includes(text)))
  if (!line) throw new Error(`missing span line containing ${texts.join(", ")}`)
  return line
}

function colorKey(color: { buffer: ArrayLike<number> }) {
  // 颜色由 OpenTUI 暴露为 RGBA buffer；序列化后只比较“是否同色”，不绑定具体主题色值。
  return Array.from(color.buffer).join(",")
}

function PromptHarness(props: {
  fetch: typeof globalThis.fetch
  events: ReturnType<typeof createEventSource>["source"]
  initialRoute: Route
  promptSessionID: string | undefined
  promptWidth: number | undefined
  config: ReturnType<typeof createTuiResolvedConfig> | undefined
  onContext: (sync: ReturnType<typeof useSync>, local: ReturnType<typeof useLocal>) => void
  onRoute: (route: ReturnType<typeof useRoute>) => void
  onPrompt: (prompt: PromptRef) => void
}) {
  const renderer = useRenderer()
  const config = props.config ?? createTuiResolvedConfig()
  const keymap = createDefaultOpenTuiKeymap(renderer)
  onCleanup(registerOpencodeKeymap(keymap, renderer, config))

  return (
    <OpencodeKeymapProvider keymap={keymap}>
      <ArgsProvider>
        <ExitProvider>
          <KVProvider>
            <ToastProvider>
              <RouteProvider initialRoute={props.initialRoute}>
                <TuiConfigProvider config={config}>
                  <SDKProvider url="http://test" directory={directory} testTransport={{ fetch: props.fetch, events: props.events }}>
                    <ProjectProvider>
                      <SyncProvider>
                        <ThemeProvider mode="dark">
                          <LocalProvider>
                            <PromptStashProvider>
                              <DialogProvider>
                                <CommandPaletteProvider>
                                  <FrecencyProvider>
                                    <PromptHistoryProvider>
                                      <PromptRefProvider>
                                        <EditorContextProvider>
                                          <PromptProbe
                                            sessionID={props.promptSessionID}
                                            width={props.promptWidth}
                                            onContext={props.onContext}
                                            onRoute={props.onRoute}
                                            onPrompt={props.onPrompt}
                                          />
                                        </EditorContextProvider>
                                      </PromptRefProvider>
                                    </PromptHistoryProvider>
                                  </FrecencyProvider>
                                </CommandPaletteProvider>
                              </DialogProvider>
                            </PromptStashProvider>
                          </LocalProvider>
                        </ThemeProvider>
                      </SyncProvider>
                    </ProjectProvider>
                  </SDKProvider>
                </TuiConfigProvider>
              </RouteProvider>
            </ToastProvider>
          </KVProvider>
        </ExitProvider>
      </ArgsProvider>
    </OpencodeKeymapProvider>
  )
}

function PromptProbe(props: {
  sessionID: string | undefined
  width: number | undefined
  onContext: (sync: ReturnType<typeof useSync>, local: ReturnType<typeof useLocal>) => void
  onRoute: (route: ReturnType<typeof useRoute>) => void
  onPrompt: (prompt: PromptRef) => void
}) {
  props.onContext(useSync(), useLocal())
  props.onRoute(useRoute())
  const prompt = (
    <Prompt
      sessionID={props.sessionID}
      placeholders={{ normal: [], shell: [] }}
      ref={(ref) => {
        if (!ref) return
        props.onPrompt(ref)
      }}
    />
  )
  if (!props.width) return prompt
  return <box width={props.width}>{prompt}</box>
}
