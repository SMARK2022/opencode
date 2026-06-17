/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { Global } from "@opencode-ai/core/global"
import { testRender, useRenderer } from "@opentui/solid"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { onCleanup } from "solid-js"
import type { Agent, Model, Provider } from "@opencode-ai/sdk/v2"
import { tmpdir } from "../../../fixture/fixture"
import { createTuiResolvedConfig } from "../../../fixture/tui-runtime"
import { TestTuiContexts } from "../../../fixture/tui-environment"
import { Prompt, type PromptRef } from "../../../../src/cli/cmd/tui/component/prompt"
import { FrecencyProvider } from "../../../../src/cli/cmd/tui/component/prompt/frecency"
import { PromptHistoryProvider } from "../../../../src/cli/cmd/tui/component/prompt/history"
import { PromptStashProvider } from "../../../../src/cli/cmd/tui/component/prompt/stash"
import { ArgsProvider } from "../../../../src/cli/cmd/tui/context/args"
import { CommandPaletteProvider } from "../../../../src/cli/cmd/tui/context/command-palette"
import { EditorContextProvider } from "../../../../src/cli/cmd/tui/context/editor"
import { DataProvider } from "@opencode-ai/tui/context/data"
import { ExitProvider } from "@opencode-ai/tui/context/exit"
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
import { createPluginRuntime, PluginRuntimeProvider } from "@opencode-ai/tui/plugin/runtime"
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

type FetchHandler = Parameters<typeof createFetch>[0]

async function withPrompt(
  override: FetchHandler,
  run: (prompt: PromptRef, route: ReturnType<typeof useRoute>, app: Awaited<ReturnType<typeof testRender>>) => Promise<void>,
  options: { initialRoute?: Route; promptSessionID?: string } = {},
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
      />
    ),
    {
      width: 100,
      height: 20,
      footerHeight: 0,
    },
  )

  try {
    await mounted
    await wait(() => sync.status === "complete" && local.model.ready)
    // 只把 renderer 传给需要断言用户可见帧的测试；既有 transport 测试会自然忽略第三个参数。
    await run(prompt, route, app)
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
  onContext: (sync: ReturnType<typeof useSync>, local: ReturnType<typeof useLocal>) => void
  onRoute: (route: ReturnType<typeof useRoute>) => void
  onPrompt: (prompt: PromptRef) => void
}) {
  const renderer = useRenderer()
  const config = createTuiResolvedConfig()
  const keymap = createDefaultOpenTuiKeymap(renderer)
  const pluginRuntime = createPluginRuntime()
  onCleanup(registerOpencodeKeymap(keymap, renderer, config))

  return (
    <TestTuiContexts directory={directory} paths={{ state: Global.Path.state }}>
      <OpencodeKeymapProvider keymap={keymap}>
        <ArgsProvider>
          <ExitProvider exit={() => {}}>
            <KVProvider>
            <ToastProvider>
              <RouteProvider initialRoute={props.initialRoute}>
                <TuiConfigProvider config={config}>
                  <PluginRuntimeProvider value={pluginRuntime}>
                    <SDKProvider url="http://test" directory={directory} testTransport={{ fetch: props.fetch, events: props.events }}>
                      <ProjectProvider>
                        <SyncProvider>
                          <DataProvider>
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
                          </DataProvider>
                        </SyncProvider>
                      </ProjectProvider>
                    </SDKProvider>
                  </PluginRuntimeProvider>
                </TuiConfigProvider>
              </RouteProvider>
            </ToastProvider>
            </KVProvider>
          </ExitProvider>
        </ArgsProvider>
      </OpencodeKeymapProvider>
    </TestTuiContexts>
  )
}

function PromptProbe(props: {
  sessionID: string | undefined
  onContext: (sync: ReturnType<typeof useSync>, local: ReturnType<typeof useLocal>) => void
  onRoute: (route: ReturnType<typeof useRoute>) => void
  onPrompt: (prompt: PromptRef) => void
}) {
  props.onContext(useSync(), useLocal())
  props.onRoute(useRoute())
  return (
    <Prompt
      sessionID={props.sessionID}
      placeholders={{ normal: [], shell: [] }}
      ref={(ref) => {
        if (!ref) return
        props.onPrompt(ref)
      }}
    />
  )
}
