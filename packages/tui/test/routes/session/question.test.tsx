/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { engine } from "@opentui/core"
import { testRender, useRenderer } from "@opentui/solid"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { onCleanup } from "solid-js"
import type { QuestionRequest } from "@opencode-ai/sdk/v2"
import { tmpdir } from "../../fixture/fixture"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { createEventSource, createFetch, directory, json, wait } from "../../cli/cmd/tui/sync-fixture"
import { ArgsProvider } from "../../../src/context/args"
import { ExitProvider } from "../../../src/context/exit"
import { KVProvider } from "../../../src/context/kv"
import { RouteProvider } from "../../../src/context/route"
import { SDKProvider } from "../../../src/context/sdk"
import { ThemeProvider } from "../../../src/context/theme"
import { TuiConfigProvider } from "../../../src/config"
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "../../../src/keymap"
import { DialogProvider } from "../../../src/ui/dialog"
import { ToastProvider } from "../../../src/ui/toast"
import { QuestionPrompt } from "../../../src/routes/session/question"

// 三种交互共用同一 Session/request 身份，只有 multiple 改变需要经过的键盘路径。
function request(multiple = false): QuestionRequest {
  return {
    id: "que_session_prompt",
    sessionID: "ses_session_prompt",
    questions: [{
      question: "Choose an answer",
      header: "Answer",
      options: [{ label: "Alpha", description: "Use the Session-owned route" }],
      multiple,
    }],
    tool: { messageID: "msg_question", callID: "call_question" },
  }
}

// 该 helper 通过真实组件和 keymap 触发操作，最终只观察 SDK transport，不调用组件私有函数。
async function expectQuestionRequest(
  info: QuestionRequest,
  action: (app: Awaited<ReturnType<typeof testRender>>) => Promise<void>,
  expected: { operation: "reply" | "reject"; answers?: string[][] },
) {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const events = createEventSource()
  // 同时记录路径、viewer workspace 和 Request body，防止只验证 URL 而遗漏 answers 合同。
  const requests: { path: string; workspace: string | null; body: unknown }[] = []
  const calls = createFetch(async (url, request, init) => {
    if (!url.pathname.startsWith("/question/session/")) return
    // 生成 SDK 将 body 放在 Request 上；clone 读取后仍保留原请求给后续 transport 使用。
    const text = request ? await request.clone().text() : typeof init?.body === "string" ? init.body : ""
    requests.push({
      path: url.pathname,
      workspace: url.searchParams.get("workspace"),
      body: text ? JSON.parse(text) : undefined,
    })
    return json(true)
  })

  function Harness() {
    const renderer = useRenderer()
    const config = createTuiResolvedConfig()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    onCleanup(registerOpencodeKeymap(keymap, renderer, config))
    // 刻意不挂 Project/Sync：问题回答只能使用 request 自带身份，不能回退 viewer placement。
    return (
      <TestTuiContexts paths={{ state: tmp.path }}>
        <OpencodeKeymapProvider keymap={keymap}>
          <ArgsProvider><ExitProvider exit={() => {}}><KVProvider><ToastProvider>
            <RouteProvider initialRoute={{ type: "session", sessionID: info.sessionID }}>
              <TuiConfigProvider config={config}>
                <SDKProvider url="http://test" directory={directory} testTransport={{ fetch: calls.fetch, events: events.source }}>
                  <ThemeProvider mode="dark"><DialogProvider><QuestionPrompt request={info} /></DialogProvider></ThemeProvider>
                </SDKProvider>
              </TuiConfigProvider>
            </RouteProvider>
          </ToastProvider></KVProvider></ExitProvider></ArgsProvider>
        </OpencodeKeymapProvider>
      </TestTuiContexts>
    )
  }

  const app = await testRender(Harness, { width: 100, height: 24, footerHeight: 0, useThread: false })
  try {
    // 先等真实选项出现在字符帧中，确保 mode stack 和键盘绑定已挂载再发送输入。
    for (let pass = 0; pass < 100 && !app.captureCharFrame().includes("Alpha"); pass++) {
      await app.renderOnce()
      await Bun.sleep(10)
    }
    expect(app.captureCharFrame()).toContain("Alpha")
    await action(app)
    await wait(() => requests.length === 1)
    // 三者必须同时成立：Session/request 身份正确、无 viewer workspace 回退、操作 payload 完整。
    expect(requests[0]).toEqual({
      path: `/question/session/${info.sessionID}/${info.id}/${expected.operation}`,
      workspace: null,
      body: expected.answers ? { answers: expected.answers } : undefined,
    })
  } finally {
    // 先停止事件源再销毁 renderer，避免卸载后的语音或键盘回调继续访问组件。
    events.dispose()
    try { app.renderer.destroy() } finally { engine.detach() }
  }
}

test("single-pick replies with the request Session identity", async () => {
  // 数字键直接选择会绕过 Confirm，因此单独锁定这条立即 reply 分支。
  await expectQuestionRequest(request(), async (app) => {
    app.mockInput.pressKey("1")
  }, { operation: "reply", answers: [["Alpha"]] })
})

test("multi-select submit replies with the request Session identity", async () => {
  // 选择、切到 Confirm、提交是三个真实按键阶段，答案必须在最后一起发送。
  await expectQuestionRequest(request(true), async (app) => {
    app.mockInput.pressKey("1")
    app.mockInput.pressKey("TAB")
    app.mockInput.pressEnter()
  }, { operation: "reply", answers: [["Alpha"]] })
})

test("escape rejects with the request Session identity", async () => {
  // ESC 走 dismiss/reject，不应误用 reply 或遗留 viewer directory 参数。
  await expectQuestionRequest(request(), async (app) => {
    app.mockInput.pressKey("ESCAPE")
  }, { operation: "reject" })
})
