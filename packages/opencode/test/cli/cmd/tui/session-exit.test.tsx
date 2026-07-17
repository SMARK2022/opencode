/** @jsxImportSource @opentui/solid */
import { expect, spyOn, test as baseTest } from "bun:test"
import { Global } from "@opencode-ai/core/global"
import { testRender, useRenderer } from "@opentui/solid"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import type { AssistantMessage, Part, Session as SessionInfo, UserMessage as SDKUserMessage } from "@opencode-ai/sdk/v2"
import { onCleanup, type JSX } from "solid-js"
import { tmpdir } from "../../../fixture/fixture"
import { createTuiResolvedConfig } from "../../../fixture/tui-runtime"
import { ArgsProvider } from "../../../../src/cli/cmd/tui/context/args"
import { CommandPaletteProvider } from "../../../../src/cli/cmd/tui/context/command-palette"
import { EditorContextProvider } from "../../../../src/cli/cmd/tui/context/editor"
import { ExitProvider, useExit } from "../../../../src/cli/cmd/tui/context/exit"
import { KVProvider } from "../../../../src/cli/cmd/tui/context/kv"
import { LocalProvider } from "../../../../src/cli/cmd/tui/context/local"
import { ProjectProvider } from "../../../../src/cli/cmd/tui/context/project"
import { PromptRefProvider } from "../../../../src/cli/cmd/tui/context/prompt"
import { RouteProvider } from "../../../../src/cli/cmd/tui/context/route"
import { SDKProvider } from "../../../../src/cli/cmd/tui/context/sdk"
import { SyncProvider } from "../../../../src/cli/cmd/tui/context/sync"
import { ThemeProvider } from "../../../../src/cli/cmd/tui/context/theme"
import { TuiConfigProvider } from "../../../../src/cli/cmd/tui/context/tui-config"
import { FrecencyProvider } from "../../../../src/cli/cmd/tui/component/prompt/frecency"
import { PromptHistoryProvider } from "../../../../src/cli/cmd/tui/component/prompt/history"
import { PromptStashProvider } from "../../../../src/cli/cmd/tui/component/prompt/stash"
import { Session } from "../../../../src/cli/cmd/tui/routes/session"
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "../../../../src/cli/cmd/tui/keymap"
import { DialogProvider } from "../../../../src/cli/cmd/tui/ui/dialog"
import { ToastProvider } from "../../../../src/cli/cmd/tui/ui/toast"
import { createEventSource, createFetch, directory, json } from "./sync-fixture"
import { formatUsageStats } from "../../../../src/cli/cmd/tui/routes/session/exit-summary"

const sessionID = "ses_exit"
const test = baseTest.serial

test("formats each usage field independently", () => {
  // normal fixture 同时包含三类值，锁定 OpenCode 既有 flow/cost 分隔符，而不是只验证字段存在。
  expect(formatUsageStats({ input: 12_300, output: 970, cost: 0.01 })).toBe("↑12.3K ↓970 · $0.01")
  // input-only 是中断 Session 的有效记录，不能用 output/cost 的零值制造噪声。
  // 全零则返回空字符串，由两个 consumer 共同省略整行，避免永久记录出现 Stats 0。
  expect(formatUsageStats({ input: 1_200, output: 0, cost: 0 })).toBe("↑1.2K")
  // input+cost 锁定 token flow 与费用之间的中点，避免过滤零 output 后把 cost 当成第二个 flow 字段。
  expect(formatUsageStats({ input: 1_200, output: 0, cost: 0.01 })).toBe("↑1.2K · $0.01")
  // output+cost 证明同一分隔规则不依赖 input 存在，cost-only 则证明不会产生孤立中点。
  expect(formatUsageStats({ input: 0, output: 970, cost: 0.01 })).toBe("↓970 · $0.01")
  expect(formatUsageStats({ input: 0, output: 0, cost: 0.01 })).toBe("$0.01")
  expect(formatUsageStats({ input: 0, output: 0, cost: 0 })).toBe("")
})

test("emits Session stats through the real ExitProvider stdout path", async () => {
  const user = userMessage("msg_user")
  const assistant = assistantMessage("msg_assistant", user.id)
  const output = await captureExitOutput(
    [user, assistant],
    {
      [user.id]: [],
      [assistant.id]: [
        textPart("part_text", assistant.id, "Session exit answer"),
        stepFinishPart("part_finish", assistant.id),
      ],
    },
    "Fix parser bug",
  )
  expect(output).toContain("Stats")
  // 970 output + 30 reasoning 必须显示为 1.0K，防止 Session projection 静默丢弃 reasoning。
  expect(output).toContain("↑12.3K ↓1.0K · $0.01")
  expect(output).toContain("Continue")
})

test("keeps empty Session stdout free of a zero Stats row", async () => {
  const output = await captureExitOutput([], {}, "Empty session")
  expect(output).not.toContain("Stats")
  expect(output).toContain("Session")
  expect(output).toContain("Continue")
})

async function captureExitOutput(
  messages: Array<AssistantMessage | SDKUserMessage>,
  parts: Record<string, Part[]>,
  title: string,
) {
  const previous = Global.Path.state
  await using tmp = await tmpdir()
  Global.Path.state = tmp.path
  await Bun.write(`${tmp.path}/kv.json`, "{}")

  const calls = createFetch((url) => {
    if (url.pathname === "/session") return json([sessionInfo({ title })])
    if (url.pathname === `/session/${sessionID}`) return json(sessionInfo({ title }))
    if (url.pathname === `/session/${sessionID}/message`)
      return json(messages.map((message) => ({ info: message, parts: parts[message.id] ?? [] })))
    return undefined
  })
  const events = createEventSource()
  let requestExit: ReturnType<typeof useExit> | undefined
  // 该 harness 使用真实 ExitProvider；测试只替换最终 stdout 边界，不替换 Session route 或 accounting。
  // 每个用例串行执行并在 finally 恢复 write，避免全局 stdout 状态泄漏到其他 TUI 测试。
  const app = await testRender(
    () => <SessionHarness fetch={calls.fetch} events={events.source} bindExit={(exit) => (requestExit = exit)} />,
    { width: 80, height: 16, footerHeight: 0 },
  )
  let exited = false

  try {
    // message.get() 是 ExitProvider 已发布的 readiness signal，比固定 sleep 更能证明 route 已更新最终文本。
    const exit = await waitForExitMessage(app, () => requestExit, title)
    let output = ""
    const stdout = spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      output += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk)
      return true
    })
    try {
      await exit()
      exited = true
    } finally {
      // ExitProvider 会先销毁 renderer 再写 stdout；恢复原函数不能放在 exit 调用之前。
      stdout.mockRestore()
    }
    return output
  } finally {
    if (!exited) app.renderer.destroy()
    Global.Path.state = previous
  }
}

function SessionHarness(props: {
  fetch: typeof globalThis.fetch
  events: ReturnType<typeof createEventSource>["source"]
  bindExit: (exit: ReturnType<typeof useExit>) => void
}) {
  const renderer = useRenderer()
  const config = createTuiResolvedConfig()
  const keymap = createDefaultOpenTuiKeymap(renderer)
  onCleanup(registerOpencodeKeymap(keymap, renderer, config))

  return (
    <OpencodeKeymapProvider keymap={keymap}>
      <ArgsProvider>
        <ExitProvider>
          <ExitCapture bind={props.bindExit}>
            <KVProvider>
              <ToastProvider>
                <RouteProvider initialRoute={{ type: "session", sessionID }}>
                  <TuiConfigProvider config={config}>
                    <SDKProvider
                      url="http://test"
                      directory={directory}
                      testTransport={{ fetch: props.fetch, events: props.events }}
                    >
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
                                            <Session />
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
          </ExitCapture>
        </ExitProvider>
      </ArgsProvider>
    </OpencodeKeymapProvider>
  )
}

function ExitCapture(props: { bind: (exit: ReturnType<typeof useExit>) => void; children: JSX.Element }) {
  props.bind(useExit())
  return props.children
}

async function waitForExitMessage(
  app: Awaited<ReturnType<typeof testRender>>,
  getExit: () => ReturnType<typeof useExit> | undefined,
  expected: string,
) {
  const start = Date.now()
  for (;;) {
    await app.renderOnce()
    const exit = getExit()
    const message = exit?.message.get()
    // 只在 route 已把目标 title 写入 stored message 后退出，避免测试抢在异步 Sync bootstrap 之前发射旧文本。
    if (exit && message?.includes(expected)) return exit
    if (Date.now() - start > 2_000) throw new Error(`timed out waiting for exit message containing ${expected}`)
    await Bun.sleep(10)
  }
}

function sessionInfo(extra: Partial<SessionInfo> = {}) {
  return {
    id: sessionID,
    slug: "exit",
    projectID: "proj_test",
    directory,
    title: "Fix parser bug",
    version: "1.0.0",
    time: { created: 1, updated: 1 },
    ...extra,
  } satisfies SessionInfo
}

function userMessage(id: string) {
  return {
    id,
    sessionID,
    role: "user",
    time: { created: 1 },
    agent: "build",
    model: { providerID: "provider", modelID: "model" },
  } satisfies SDKUserMessage
}

function assistantMessage(id: string, parentID: string) {
  return {
    id,
    sessionID,
    role: "assistant",
    time: { created: 2, completed: 3 },
    parentID,
    modelID: "model",
    providerID: "provider",
    mode: "build",
    agent: "build",
    path: { cwd: directory, root: directory },
    cost: 0.01,
    finish: "stop",
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  } satisfies AssistantMessage
}

function textPart(id: string, messageID: string, text: string) {
  return { id, sessionID, messageID, type: "text", text } satisfies Extract<Part, { type: "text" }>
}

function stepFinishPart(id: string, messageID: string, reasoning = 30) {
  // cache 数值故意非零，证明 Session Stats 的 ↑ 只来自 pure input，而不是 cache-inclusive totalInput。
  // output/reasoning/cost 仍使用独立 literal，便于断言退出文本的三个显示字段。
  return {
    id,
    sessionID,
    messageID,
    type: "step-finish",
    reason: "stop",
    cost: 0.01,
    tokens: { input: 12_300, output: 970, reasoning, cache: { read: 100, write: 50 } },
  } satisfies Extract<Part, { type: "step-finish" }>
}
