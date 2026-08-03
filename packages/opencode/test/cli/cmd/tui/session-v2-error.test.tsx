/** @jsxImportSource @opentui/solid */
import { expect, spyOn, test as baseTest } from "bun:test"
import { Global } from "@opencode-ai/core/global"
import type { TuiRouteDefinition } from "@opencode-ai/plugin/tui"
import type { SessionMessageAssistant } from "@opencode-ai/sdk/v2"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { onCleanup } from "solid-js"
import { ArgsProvider } from "@/cli/cmd/tui/context/args"
import { ExitProvider } from "@/cli/cmd/tui/context/exit"
import { KVProvider } from "@/cli/cmd/tui/context/kv"
import { LocalProvider } from "@/cli/cmd/tui/context/local"
import { ProjectProvider } from "@/cli/cmd/tui/context/project"
import { RouteProvider } from "@/cli/cmd/tui/context/route"
import { SDKProvider } from "@/cli/cmd/tui/context/sdk"
import { SyncProvider } from "@/cli/cmd/tui/context/sync"
import { SyncProviderV2 } from "@/cli/cmd/tui/context/sync-v2"
import { ThemeProvider } from "@/cli/cmd/tui/context/theme"
import { TuiConfigProvider } from "@/cli/cmd/tui/context/tui-config"
import { internalTuiPlugins } from "@/cli/cmd/tui/plugin/internal"
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "@/cli/cmd/tui/keymap"
import { ToastProvider } from "@/cli/cmd/tui/ui/toast"
import { tmpdir } from "../../../fixture/fixture"
import { createTuiPluginApi } from "../../../fixture/tui-plugin"
import { createTuiResolvedConfig } from "../../../fixture/tui-runtime"
import { createEventSource, createFetch, directory, json } from "./sync-fixture"

const sessionID = "ses_v2_error"
// 本用例临时改写全局KV目录并持有native renderer，串行执行可避免与其他TUI fixture争用进程状态。
// fixture只拥有当前测试的state目录，不能读取开发机的旧KV配置来改变renderer分支。
// serial不是为了放宽断言，而是为了保护真实native资源的生命周期边界。
const test = baseTest.serial

test("v2 Session route renders a structured error message without object coercion", async () => {
  const plugin = internalTuiPlugins({ experimentalEventSystem: true }).find(
    (candidate) => candidate.id === "internal:session-v2-debug",
  )
  if (!plugin) throw new Error("experimental Session v2 plugin was not registered")
  // 通过internal plugin注册表取得production route，确保测试覆盖v2调用链而非复制渲染实现。

  const definitions: TuiRouteDefinition[] = []
  const api = createTuiPluginApi()
  // 收集route definition只用于调用公开render接口，不断言register次数或私有helper。
  // 从公开plugin注册接口取得route，避免直接导出或调用私有View组件形成测试专用生产seam。
  const register = spyOn(api.route, "register").mockImplementation((items) => {
    definitions.push(...items)
    return () => {}
  })
  await plugin.tui(api, undefined, {
    id: plugin.id,
    source: "internal",
    spec: plugin.id,
    target: plugin.id,
    first_time: 0,
    last_time: 0,
    time_changed: 0,
    load_count: 1,
    fingerprint: plugin.id,
    state: "first",
  })
  register.mockRestore()
  const definition = definitions.find((candidate) => candidate.name === "session.v2.messages")
  if (!definition) throw new Error("Session v2 plugin did not register its message route")

  const previous = Global.Path.state
  await using tmp = await tmpdir()
  Global.Path.state = tmp.path
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  // 空KV只提供最小默认偏好，structured error的可见性不应依赖动画或用户配置。

  const message = {
    id: "msg_v2_error",
    type: "assistant",
    agent: "build",
    model: { id: "test-model", providerID: "test", variant: "" },
    content: [],
    error: { type: "unknown", message: "v2 failure" },
    time: { created: 1, completed: 2 },
  } satisfies SessionMessageAssistant
  // message.error故意保持对象shape；只有owner读取message字段才能证明兼容迁移真正生效。
  // v2 SDK endpoint提供真实公开schema；expected文字来自fixture，不复制renderer的格式化逻辑。
  const calls = createFetch((url) => {
    // fixture只响应生产v2 message endpoint，任何意外请求都会保持undefined并暴露调用路径漂移。
    if (url.pathname === `/api/session/${sessionID}/message`) return json({ items: [message], cursor: {} })
    return undefined
  })
  const events = createEventSource()
  const app = await testRender(
    () => <Harness definition={definition} fetch={calls.fetch} events={events.source} />,
    { width: 80, height: 24, footerHeight: 0, useThread: false },
  )

  try {
    const frame = await waitForFrame(app)
    // 用户可观察seam是最终字符帧：必须显示schema message，不能依赖object默认字符串化。
    expect(frame).toContain("v2 failure")
    expect(frame).not.toContain("[object Object]")
    // object coercion是旧路径的可观察失败，不允许只用typecheck替代真实cell frame验证。
  } finally {
    events.dispose()
    app.renderer.destroy()
    Global.Path.state = previous
  }
})

test("v2 Session route collapses long bash output without an ellipsis sentinel row", async () => {
  const plugin = internalTuiPlugins({ experimentalEventSystem: true }).find(
    (candidate) => candidate.id === "internal:session-v2-debug",
  )
  if (!plugin) throw new Error("experimental Session v2 plugin was not registered")

  const definitions: TuiRouteDefinition[] = []
  const api = createTuiPluginApi()
  // 与上方 error 用例同一公开注册 seam：route definition 只用于调用公开 render 接口。
  const register = spyOn(api.route, "register").mockImplementation((items) => {
    definitions.push(...items)
    return () => {}
  })
  await plugin.tui(api, undefined, {
    id: plugin.id,
    source: "internal",
    spec: plugin.id,
    target: plugin.id,
    first_time: 0,
    last_time: 0,
    time_changed: 0,
    load_count: 1,
    fingerprint: plugin.id,
    state: "first",
  })
  register.mockRestore()
  const definition = definitions.find((candidate) => candidate.name === "session.v2.messages")
  if (!definition) throw new Error("Session v2 plugin did not register its message route")

  const previous = Global.Path.state
  await using tmp = await tmpdir()
  Global.Path.state = tmp.path
  await Bun.write(`${tmp.path}/kv.json`, "{}")

  // 12 行输出超过 v2 Bash 的 10 行折叠阈值；expected 行序列来自 fixture 真实内容，
  // 不复制生产的截断算法。
  const output = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join("\n")
  const message = {
    id: "msg_v2_bash",
    type: "assistant",
    agent: "build",
    model: { id: "test-model", providerID: "test", variant: "" },
    content: [
      {
        type: "tool",
        id: "prt_v2_bash",
        name: "bash",
        state: {
          status: "completed",
          input: { command: "seq 1 12", description: "List numbers" },
          content: [{ type: "text", text: output }],
          structured: {},
        },
        time: { created: 1, completed: 2 },
      },
    ],
    time: { created: 1, completed: 2 },
  } satisfies SessionMessageAssistant
  const calls = createFetch((url) => {
    if (url.pathname === `/api/session/${sessionID}/message`) return json({ items: [message], cursor: {} })
    return undefined
  })
  const events = createEventSource()
  const app = await testRender(
    () => <Harness definition={definition} fetch={calls.fetch} events={events.source} />,
    { width: 80, height: 24, footerHeight: 0, useThread: false },
  )

  try {
    const deadline = Date.now() + 2_000
    let frame = ""
    while (Date.now() < deadline) {
      await app.renderOnce()
      frame = app.captureCharFrame()
      if (frame.includes("Click to expand")) break
      await Bun.sleep(10)
    }
    if (!frame.includes("Click to expand")) throw new Error(`timed out waiting for collapsed bash card:\n${frame}`)

    // INV-01：折叠预览只能有真实内容行；独立的 `…` sentinel 行是“点击展开前后高度不变”的根因，
    // disclosure（Click to expand）才是“还有更多”的唯一信号。10 行预算内应显示到 line 10、不含 line 11。
    // frame 行带边框字符（`┃  …`，v2 卡片用 heavy vertical），行级正则只匹配内容为空白/边框加
    // sentinel 的行，避免断言恒真。
    expect(frame).toContain("line 10")
    expect(frame).not.toContain("line 11")
    expect(frame.split("\n").some((row) => /^[\s│┃]*…[\s│┃]*$/.test(row))).toBe(false)
  } finally {
    events.dispose()
    app.renderer.destroy()
    Global.Path.state = previous
  }
})

function Harness(props: {
  definition: TuiRouteDefinition
  fetch: typeof globalThis.fetch
  events: ReturnType<typeof createEventSource>["source"]
}) {
  // provider层级与生产app一致，structured error必须穿过SDK、sync、route和theme完整链路。
  // 省略其中一层会把真实兼容问题降级成静态组件测试。
  const renderer = useRenderer()
  const config = createTuiResolvedConfig()
  const keymap = createDefaultOpenTuiKeymap(renderer)
  // 生产route使用useBindings；注册同一keymap资源使测试覆盖真实插件生命周期而非静态JSX片段。
  onCleanup(registerOpencodeKeymap(keymap, renderer, config))

  return (
    <OpencodeKeymapProvider keymap={keymap}>
      <ArgsProvider>
        <ExitProvider>
          <KVProvider>
            <ToastProvider>
              <RouteProvider initialRoute={{ type: "plugin", id: "session.v2.messages", data: { sessionID } }}>
                <TuiConfigProvider config={config}>
                  <SDKProvider
                    url="http://test"
                    directory={directory}
                    testTransport={{ fetch: props.fetch, events: props.events }}
                  >
                    <ProjectProvider>
                      <SyncProvider>
                        <SyncProviderV2>
                          <ThemeProvider mode="dark">
                            <LocalProvider>{props.definition.render({ params: { sessionID } })}</LocalProvider>
                          </ThemeProvider>
                        </SyncProviderV2>
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

async function waitForFrame(app: Awaited<ReturnType<typeof testRender>>) {
  // 同时观察成功文字和旧object coercion，让旧实现能快速red而不是等到timeout。
  // timeout后的完整frame进入错误消息，便于区分未挂载与错误内容两类失败。
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    await app.renderOnce()
    const frame = app.captureCharFrame()
    if (frame.includes("v2 failure") || frame.includes("[object Object]")) return frame
    await Bun.sleep(10)
  }
  throw new Error(`timed out waiting for v2 error frame:\n${app.captureCharFrame()}`)
}
