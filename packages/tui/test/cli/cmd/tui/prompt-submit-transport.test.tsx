/** @jsxImportSource @opentui/solid */
// #192：prompt 提交传输层行为测试——失败保留 draft / 成功清除 / shell 后台 / slash / 新会话
import { expect, test } from "bun:test"
import { testRender, useRenderer } from "@opentui/solid"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { onCleanup } from "solid-js"
import type { Agent, Model, Provider } from "@opencode-ai/sdk/v2"
import { tmpdir } from "../../../fixture/fixture"
import { createTuiResolvedConfig } from "../../../fixture/tui-runtime"
import { TestTuiContexts } from "../../../fixture/tui-environment"
import { Prompt, type PromptRef } from "../../../../src/component/prompt"
import { FrecencyProvider } from "../../../../src/component/prompt/frecency"
import { PromptHistoryProvider } from "../../../../src/component/prompt/history"
import { PromptStashProvider } from "../../../../src/component/prompt/stash"
import { ArgsProvider } from "../../../../src/context/args"
// #192：DataProvider——Autocomplete 组件通过 useData 获取数据
import { DataProvider } from "../../../../src/context/data"
import { ExitProvider } from "../../../../src/context/exit"
import { KVProvider } from "../../../../src/context/kv"
import { LocalProvider, useLocal } from "../../../../src/context/local"
import { LocationProvider } from "../../../../src/context/location"
import { PermissionProvider } from "../../../../src/context/permission"
import { ProjectProvider } from "../../../../src/context/project"
import { PromptRefProvider } from "../../../../src/context/prompt"
import { RouteProvider, useRoute, type Route } from "../../../../src/context/route"
import { SDKProvider } from "../../../../src/context/sdk"
import { SyncProvider, useSync } from "../../../../src/context/sync"
import { ThemeProvider } from "../../../../src/context/theme"
import { TuiConfigProvider } from "../../../../src/config"
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "../../../../src/keymap"
import { EditorContextProvider } from "../../../../src/context/editor"
import { DialogProvider } from "../../../../src/ui/dialog"
import { ToastProvider } from "../../../../src/ui/toast"
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

// #192：prompt 提交失败时 draft 必须保留——用户不会丢失输入
test("failed TUI prompt submission keeps the draft text", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  let attempts = 0

  // #192：/config/providers 和 /provider 返回测试 model——LocalProvider 初始化需要
  // #192：/agent 返回 general agent——Prompt 组件需要可用 agent 列表
  // #192：/message 和 /prompt_async 都抛异常——覆盖两种提交路径
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
      // #192：set 设置 draft 文本和空 parts——模拟用户输入
      prompt.set({ input: "Keep this draft", parts: [] })
      // #192：submit 触发 promptAsync——应失败并保留 draft
      prompt.submit()

      await wait(() => attempts > 0)
      await Bun.sleep(20)

      // #192：失败后 draft 必须保留——用户输入不丢失
      expect(prompt.current.input).toBe("Keep this draft")
    },
    tmp.path,
  )
})

// #192：shell 提交失败时 draft 必须保留——含空格/引号的复杂命令不丢失
test("failed TUI shell submission keeps the draft text", async () => {
  await using tmp = await tmpdir()
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
      // #192：mode: "shell" 切换到 shell 模式——走 /shell 端点
      prompt.set({ input: draft, mode: "shell", parts: [] })
      prompt.submit()

      await wait(() => attempts > 0)
      await Bun.sleep(20)

      // #192：shell 失败后 draft 和 mode 都必须保留
      expect(prompt.current.input).toBe(draft)

      // #192：不重新 set，直接重试以验证输入框与 shell 模式都已恢复。
      prompt.submit()
      await wait(() => attempts === 2)
      await Bun.sleep(20)
      expect(prompt.current.input).toBe(draft)
    },
    tmp.path,
  )
})

// #192：shell 提交成功后立即清除——不等后台完成，避免阻塞用户输入
test("accepted TUI shell submission clears without waiting for completion", async () => {
  await using tmp = await tmpdir()
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
      // #192：mode: "shell"——成功提交后应立即清除输入
      prompt.set({ input: draft, mode: "shell", parts: [] })
      prompt.submit()

      await wait(() => attempts > 0)
      await Bun.sleep(20)

      // #192：成功后 input 为空——不等 shell 后台完成
      expect(prompt.current.input).toBe("")
    },
    tmp.path,
  )
})

// #192：新会话 shell 提交失败时留在 home 且 draft 保留——导航可取消
test("failed new-session shell submission stays on home with the draft", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  let attempts = 0
  let shellPath = ""
  const nextSessionID = "ses_new_prompt_transport"
  const draft = `printf '%s' "$HOME/path with spaces" | cat > "./quoted file.txt" && echo $(pwd) # rm -rf /tmp/nope`

  await withPrompt(
    (url) => {
      if (url.pathname === "/config/providers") return json({ providers: [provider], default: { provider: model.id } })
      if (url.pathname === "/provider") return json({ all: [provider], default: { provider: model.id }, connected: [] })
      if (url.pathname === "/agent") return json([agent])
      // #192：POST /session 创建新会话——FetchHandler 只接收 url，用 search 区分 GET/POST
      // #192：GET /session?... 返回空列表——避免 sync 上下文 toSorted 报错
      if (url.pathname === "/session" && url.search) return json([])
      if (url.pathname === "/session") {
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
      // #192：promptSessionID 为 undefined——触发新会话创建
      // #192：POST /session 返回新 sessionID——shell 发送到新端点
      prompt.set({ input: draft, mode: "shell", parts: [] })
      prompt.submit()

      await wait(() => attempts > 0)
      await Bun.sleep(80)

      // #192：shell 发送到了新会话端点——不是当前 sessionID
      expect(shellPath).toBe(`/session/${nextSessionID}/shell`)
      // #192：失败后留在 home——导航被取消
      expect(route.data.type).toBe("home")
      // #192：draft 保留——新会话创建失败不丢输入
      expect(prompt.current.input).toBe(draft)
    },
    tmp.path,
    { initialRoute: { type: "home" }, promptSessionID: undefined },
  )
})

// #192：slash 命令提交失败时 draft 必须保留
test("failed TUI slash-command submission keeps the draft text", async () => {
  await using tmp = await tmpdir()
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
      // #192：/review 开头的输入识别为 slash 命令
      prompt.set({ input: draft, parts: [] })
      prompt.submit()

      await wait(() => attempts > 0)
      await Bun.sleep(20)

      // #192：slash 命令失败后 draft 保留
      expect(prompt.current.input).toBe(draft)

      // #192：直接重试必须再次到达 command 端点，不能被空输入框抹掉草稿。
      prompt.submit()
      await wait(() => attempts === 2)
      await Bun.sleep(20)
      expect(prompt.current.input).toBe(draft)
    },
    tmp.path,
  )
})

// #192：slash 命令提交成功后立即清除——不等后台完成
test("accepted TUI slash-command submission clears without waiting for completion", async () => {
  await using tmp = await tmpdir()
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
      // #192：slash 命令成功——返回 pending Promise 模拟后台
      prompt.set({ input: draft, parts: [] })
      prompt.submit()

      await wait(() => attempts > 0)
      await Bun.sleep(20)

      // #192：命令后台执行期间输入即可清空，无需等待完成回执
      expect(prompt.current.input).toBe("")
    },
    tmp.path,
  )
})

type FetchHandler = Parameters<typeof createFetch>[0]

// #192：withPrompt——挂载完整 TUI Provider 树并暴露 PromptRef
// #192：override 控制 fetch 行为——模拟 transport 成功/失败
// #192：run 回调接收 PromptRef 和 route——测试操作 prompt 并验证路由
// #192：options 控制 initialRoute 和 promptSessionID——新会话测试需要
// #192：mounted promise 确保 Prompt ref 就绪后再执行测试
// #192：state 传入 tmp.path——TestTuiContexts 设置路径
// #192：mounted promise 是测试同步屏障，避免在 ref 未挂载时操作导致空指针
async function withPrompt(
  override: FetchHandler,
  run: (prompt: PromptRef, route: ReturnType<typeof useRoute>) => Promise<void>,
  state: string,
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
        state={state}
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
    await run(prompt, route)
  } finally {
    app.renderer.destroy()
  }
}

function PromptHarness(props: {
  state: string
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
  onCleanup(registerOpencodeKeymap(keymap, renderer, config))

  return (
    <TestTuiContexts paths={{ state: props.state }}>
      <OpencodeKeymapProvider keymap={keymap}>
        <ArgsProvider>
          <ExitProvider exit={() => {}}>
            <KVProvider>
              <ToastProvider>
                <RouteProvider initialRoute={props.initialRoute}>
                  <TuiConfigProvider config={config}>
                    <SDKProvider url="http://test" directory={directory} testTransport={{ fetch: props.fetch, events: props.events }}>
                      <ProjectProvider>
                        <PermissionProvider>
                          <LocationProvider>
                            <DataProvider>
                            <SyncProvider>
                          <ThemeProvider mode="dark">
                            <LocalProvider>
                              <PromptStashProvider>
                                <DialogProvider>
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
                                </DialogProvider>
                              </PromptStashProvider>
                            </LocalProvider>
                          </ThemeProvider>
                        </SyncProvider>
                            </DataProvider>
                          </LocationProvider>
                        </PermissionProvider>
                      </ProjectProvider>
                    </SDKProvider>
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
