/** @jsxImportSource @opentui/solid */
// #209：auto-review 渲染逻辑单元测试
import { describe, expect, test } from "bun:test"
import { autoReviewLabel, autoReviewMetadata, toolDisplay } from "../../../src/routes/session"
import { testRender, useRenderer } from "@opentui/solid"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { onCleanup } from "solid-js"
import type { AssistantMessage, Part, UserMessage } from "@opencode-ai/sdk/v2"
import { tmpdir } from "../../fixture/fixture"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createEventSource, createFetch, directory, json } from "../../fixture/tui-sdk"
import { Session } from "../../../src/routes/session"
import { ArgsProvider } from "../../../src/context/args"
import { ClipboardProvider } from "../../../src/context/clipboard"
import { DataProvider } from "../../../src/context/data"
import { EditorContextProvider } from "../../../src/context/editor"
import { EpilogueProvider } from "../../../src/context/epilogue"
import { ExitProvider } from "../../../src/context/exit"
import { KVProvider } from "../../../src/context/kv"
import { LocalProvider } from "../../../src/context/local"
import { LocationProvider } from "../../../src/context/location"
import { PermissionProvider } from "../../../src/context/permission"
import { ProjectProvider } from "../../../src/context/project"
import { PromptRefProvider } from "../../../src/context/prompt"
import { RouteProvider, useRoute } from "../../../src/context/route"
import { SDKProvider } from "../../../src/context/sdk"
import { SyncProvider } from "../../../src/context/sync"
import { ThemeProvider } from "../../../src/context/theme"
import { TuiConfigProvider } from "../../../src/config"
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "../../../src/keymap"
import { createPluginRuntime, PluginRuntimeProvider } from "../../../src/plugin/runtime"
import { FrecencyProvider } from "../../../src/component/prompt/frecency"
import { PromptHistoryProvider } from "../../../src/component/prompt/history"
import { PromptStashProvider } from "../../../src/component/prompt/stash"
import { DialogProvider } from "../../../src/ui/dialog"
import { ToastProvider } from "../../../src/ui/toast"
import { wait } from "../../cli/cmd/tui/sync-fixture"

describe("auto review rendering (#209)", () => {
  test("autoReviewMetadata returns undefined for missing autoReview", () => {
    // #209：无 autoReview 字段时返回 undefined
    // #209：覆盖 null/string/array 四种非法类型——确保 type guard 不被 falsy 或非对象值欺骗
    expect(autoReviewMetadata({})).toBeUndefined()
    expect(autoReviewMetadata({ autoReview: null })).toBeUndefined()
    expect(autoReviewMetadata({ autoReview: "string" })).toBeUndefined()
    expect(autoReviewMetadata({ autoReview: [] })).toBeUndefined()
  })

  test("autoReviewMetadata returns undefined when reviewID is missing", () => {
    // #209：缺少 reviewID 字段时返回 undefined——防止部分写入的 metadata 被误用
    expect(autoReviewMetadata({ autoReview: { status: "reviewing" } })).toBeUndefined()
  })

  test("autoReviewMetadata extracts valid autoReview metadata", () => {
    // #209：有效 autoReview metadata 提取 reviewID/sessionID/status/precheck/result
    // #209：验证全字段透传——service.ts updateToolAutoReview 写入的所有渐进字段都能被 UI 读取
    const metadata = {
      autoReview: {
        reviewID: "review_1",
        sessionID: "ses_reviewer",
        status: "allowed",
        precheck: { level: "cautious", reason: "sensitive read" },
        result: { risk_level: "high", user_authorization: "high", rationale: "authorized" },
      },
    }
    const review = autoReviewMetadata(metadata)
    expect(review).toBeDefined()
    expect(review?.reviewID).toBe("review_1")
    expect(review?.sessionID).toBe("ses_reviewer")
    expect(review?.status).toBe("allowed")
    expect(review?.precheck?.level).toBe("cautious")
    expect(review?.result?.risk_level).toBe("high")
  })

  test("autoReviewLabel shows reviewing state with precheck level", () => {
    // #209：reviewing 状态展示 ◌ + precheck level + @permission-reviewer
    const label = autoReviewLabel({
      reviewID: "review_2",
      status: "reviewing",
      precheck: { level: "cautious", reason: "sensitive read" },
    })
    expect(label).toBe("◌ auto review · cautious · @permission-reviewer")
  })

  test("autoReviewLabel shows allowed state with auth level", () => {
    // #209：allowed 状态展示 ✓ + auth level + @permission-reviewer
    const label = autoReviewLabel({
      reviewID: "review_3",
      status: "allowed",
      result: { risk_level: "high", user_authorization: "high", rationale: "authorized" },
    })
    expect(label).toBe("✓ auto review · allowed · auth high · @permission-reviewer")
  })

  test("autoReviewLabel shows denied state with risk and auth", () => {
    // #209：denied 状态展示 ! + risk + auth + @permission-reviewer
    const label = autoReviewLabel({
      reviewID: "review_4",
      status: "denied",
      result: { risk_level: "high", user_authorization: "unknown", rationale: "not authorized" },
    })
    expect(label).toBe("! auto review · denied · high risk · auth unknown · @permission-reviewer")
  })

  test("autoReviewLabel shows timed_out state as failed closed", () => {
    // #209：timed_out 状态展示 ! + timed out + failed closed
    const label = autoReviewLabel({ reviewID: "review_5", status: "timed_out" })
    expect(label).toBe("! auto review · timed out · failed closed · @permission-reviewer")
  })

  test("autoReviewLabel shows failed state as failed closed", () => {
    // #209：failed 状态展示 ! + failed + failed closed
    const label = autoReviewLabel({ reviewID: "review_6", status: "failed" })
    expect(label).toBe("! auto review · failed · failed closed · @permission-reviewer")
  })

  test("autoReviewLabel shows fallback_user state as asking user", () => {
    // #209：fallback_user 状态展示 ! + unavailable + asking user
    const label = autoReviewLabel({ reviewID: "review_7", status: "fallback_user" })
    expect(label).toBe("! auto review · unavailable · asking user · @permission-reviewer")
  })

  test("autoReviewLabel defaults to reviewing when status is undefined", () => {
    // #209：无 status 时默认展示 reviewing + precheck level
    // #209：默认 reviewing 是安全假设——metadata 写入与状态更新非原子，读取时可能尚未标记终态
    const label = autoReviewLabel({
      reviewID: "review_8",
      precheck: { level: "general", reason: "unknown" },
    })
    expect(label).toBe("◌ auto review · general · @permission-reviewer")
  })

  test("toolDisplay routes permission_review_decision to dedicated renderer", () => {
    // #209：permission_review_decision 有专属渲染器——不走 generic 回退
    // #209：toolDisplay 返回工具名本身——ToolPart switch 据此路由到 PermissionReviewDecision 组件
    expect(toolDisplay("permission_review_decision")).toBe("permission_review_decision")
  })
})

const sessionID = "ses_review_render"
const command = "git push origin main"
const rationale = "private key read was not explicitly authorized"

// 六种源场景均挂载生产Session组件，纯标签测试不能证明实际卡片仍显示审查结果。
test.each(["running", "completed", "collapsed", "error", "decision", "transcript"] as const)(
  "renders the real review session: %s",
  async (scenario) => {
    const review = {
      reviewID: "review_render",
      sessionID: "ses_reviewer_child",
      status: scenario === "running" ? "reviewing" : scenario === "error" ? "denied" : "allowed",
      precheck: { level: "cautious", reason: "requires review" },
      result: { risk_level: "high", user_authorization: scenario === "error" ? "unknown" : "high", rationale },
    }
    const decision = { outcome: "deny", risk_level: "high", user_authorization: "unknown", rationale }
    const input = scenario === "decision" || scenario === "transcript" ? decision : { command }
    const metadata = scenario === "decision" || scenario === "transcript"
      ? decision
      : { output: scenario === "collapsed" ? Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n") : "pushed", autoReview: review }
    const tool: Part = {
      id: "part_review_tool",
      sessionID,
      messageID: "msg_review_answer",
      type: "tool",
      tool: scenario === "decision" || scenario === "transcript" ? "permission_review_decision" : "bash",
      callID: "call_review",
      state: scenario === "error"
        ? { status: "error", input, error: "auto reviewer denied", metadata: { autoReview: review }, time: { start: 1, end: 2 } }
        : scenario === "running"
          ? { status: "running", input, title: "Review", metadata: { autoReview: review }, time: { start: 1 } }
          : { status: "completed", input, title: "Review", metadata, output: "", time: { start: 1, end: 2 } },
    }
    const assistant: AssistantMessage = {
      id: "msg_review_answer", sessionID, role: "assistant", parentID: "msg_review_request",
      time: { created: 2, completed: 3 }, modelID: "model", providerID: "provider", mode: "build", agent: "build",
      path: { cwd: directory, root: directory }, cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    }
    const user: UserMessage = {
      id: "msg_review_request", sessionID, role: "user", time: { created: 1 },
      agent: "permission-reviewer", model: { providerID: "provider", modelID: "model" },
    }
    // 可见协议请求与助手解释使用不同消息，验证展示顺序而不把请求当作人类授权。
    const request: Part = {
      id: "part_review_request", sessionID, messageID: user.id, type: "text",
      text: ">>> TRANSCRIPT START\nuser: inspect this key\n>>> TRANSCRIPT END\n>>> APPROVAL REQUEST START\n{\"permission\":\"bash\"}\n>>> APPROVAL REQUEST END",
      metadata: { permissionReviewerRequest: true },
    }
    const explanation: Part = {
      id: "part_review_explanation", sessionID, messageID: assistant.id, type: "text",
      text: "The requested private key read is not explicitly authorized.",
    }
    await withRenderedReview(
      scenario === "transcript"
        ? [{ info: user, parts: [request] }, { info: assistant, parts: [explanation, tool] }]
        : [{ info: assistant, parts: [tool] }],
      async (app, route) => {
        const expected = scenario === "running" ? "◌ auto review"
          : scenario === "error" ? "! auto review"
          : scenario === "decision" || scenario === "transcript" ? rationale : "✓ auto review"
        // 等待真实帧达到可观察条件，不用固定sleep冒充组件已完成异步水合。
        await app.waitForFrame(async (frame) => {
          if (frame.includes(expected)) return true
          await Bun.sleep(10)
          return false
        }, { maxPasses: 300 })
        // 行间距在预布局阶段写入，完成后续帧再使用屏幕坐标，避免点击时目标移动。
        await app.renderOnce()
        await app.renderOnce()
        const lines = app.captureCharFrame().split("\n")
        if (scenario === "decision" || scenario === "transcript") {
          expect(lines.join("\n")).toContain("Permission review decision")
          expect(lines.join("\n")).toContain("unknown")
          expect(lines.join("\n")).not.toContain("! Permission review decision")
          if (scenario === "transcript") {
            expect(lines.join("\n")).toContain(">>> TRANSCRIPT START")
            expect(lines.join("\n")).toContain(">>> APPROVAL REQUEST START")
            expect(lines.findIndex((line) => line.includes("requested private key"))).toBeLessThan(
              lines.findIndex((line) => line.includes("Permission review decision")),
            )
          }
          return
        }
        const row = lines.findIndex((line) => line.includes(command))
        expect(row).toBeGreaterThanOrEqual(0)
        const reviewRow = lines.findIndex((line) => line.includes(expected))
        expect(reviewRow).toBeGreaterThanOrEqual(0)
        if (scenario === "completed" || scenario === "collapsed") expect(reviewRow).toBeLessThan(row)
        if (scenario === "running" || scenario === "error") expect(reviewRow).toBe(row + 1)
        expect(lines.filter((line) => line.includes(expected))).toHaveLength(1)
        if (scenario === "collapsed") expect(lines.join("\n")).toContain("Click to expand")
        if (scenario === "running") {
          await app.mockMouse.click(lines[row].indexOf(command), row)
          expect(route.data).toMatchObject({ type: "session", sessionID })
          await app.renderOnce()
          await app.mockMouse.click(lines[reviewRow].indexOf("auto review"), reviewRow)
          expect(route.data).toMatchObject({ type: "session", sessionID: "ses_reviewer_child" })
        }
        // 错误卡的命令行仍可展开错误，独立审查行的鼠标操作必须抵达子会话路由。
        if (scenario === "error") {
          const x = lines[row + 1].indexOf("auto review")
          await app.mockMouse.drag(x, row + 1, x + 6, row + 1)
          expect(route.data).toMatchObject({ type: "session", sessionID })
          await app.renderOnce()
          await app.mockMouse.click(x, row + 1)
          expect(route.data).toMatchObject({ type: "session", sessionID: "ses_reviewer_child" })
        }
      },
    )
  },
)

// 与原回归一样经过正文delta和Markdown布局，而非仅调用滚动计算函数。
test("session follows streamed text from a one-row bottom gap", async () => {
  const message: AssistantMessage = {
    id: "msg_bottom", sessionID, role: "assistant", parentID: "msg_user",
    time: { created: 1 }, modelID: "model", providerID: "provider", mode: "build", agent: "build",
    path: { cwd: directory, root: directory }, cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  }
  const part: Part = { id: "part_bottom", sessionID, messageID: message.id, type: "text", text: `${"wrapped content ".repeat(180)}OLD_BOTTOM` }
  await withRenderedReview([{ info: message, parts: [part] }], async (app, _route, emit) => {
    await waitForReviewFrame(app, async (frame) => {
      if (frame.includes("OLD_BOTTOM")) return true
      await Bun.sleep(10)
      return false
    }, { maxPasses: 300 })
    await app.renderOnce()
    await app.renderOnce()
    // 沿实际快捷键进入一行容差区，未增长时仍尊重手动上滚。
    app.mockInput.pressKey("y", { ctrl: true, meta: true })
    await app.renderOnce()
    await app.renderOnce()
    expect(app.captureCharFrame()).not.toContain("OLD_BOTTOM")
    emit({
      directory, project: "proj_test",
      payload: { id: "evt_bottom_growth", type: "message.part.delta", properties: {
        sessionID, messageID: message.id, partID: part.id, field: "text", delta: `${" new content".repeat(80)} NEW_BOTTOM`,
      } },
    })
    await waitForReviewFrame(app, async (frame) => {
      if (frame.includes("NEW_BOTTOM")) return true
      await Bun.sleep(10)
      return false
    }, { maxPasses: 300 })
    expect(app.captureCharFrame()).toContain("NEW_BOTTOM")
  }, { width: 100, height: 18 })
})

// 同时覆盖正常导航与先空后有的预取，必须看到子会话正文而不只检查路由值。
test.each([false, true])("task opens its current child after stale prefetch: %s", async (stale) => {
  const childID = "ses_task_child"
  let requests = 0
  const parent: AssistantMessage = {
    id: "msg_task", sessionID, role: "assistant", parentID: "msg_user",
    time: { created: 1, completed: 2 }, modelID: "model", providerID: "provider", mode: "build", agent: "build",
    path: { cwd: directory, root: directory }, cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  }
  const task: Part = {
    id: "part_task", sessionID, messageID: parent.id, type: "tool", tool: "task", callID: "task_call",
    state: { status: "completed", input: { description: "inspect child", subagent_type: "general" },
      output: "", title: "inspect child", metadata: { sessionId: childID }, time: { start: 1, end: 2 } },
  }
  await withRenderedReview([{ info: parent, parts: [task] }], async (app) => {
    await waitForReviewFrame(app, async (frame) => {
      if (frame.includes("inspect child") && requests > 0) return true
      await Bun.sleep(10)
      return false
    }, { maxPasses: 300 })
    await app.renderOnce()
    await app.renderOnce()
    const lines = app.captureCharFrame().split("\n")
    const y = lines.findIndex((line) => line.includes("inspect child"))
    expect(y).toBeGreaterThanOrEqual(0)
    await app.mockMouse.click(lines[y].indexOf("inspect child"), y)
    await waitForReviewFrame(app, async (frame) => {
      if (frame.includes("child session refreshed")) return true
      await Bun.sleep(10)
      return false
    }, { maxPasses: 300 })
    expect(requests).toBeGreaterThan(1)
  }, {}, { [childID]: () => {
    requests++
    if (stale && requests === 1) return []
    return [{ info: { ...parent, id: "msg_child", sessionID: childID, agent: "general" },
      parts: [{ id: "part_child", sessionID: childID, messageID: "msg_child", type: "text", text: "child session refreshed" }] }]
  } })
})

// 覆盖源新增的共享槽位、无审查外观、多文件去重和非Shell导航，不复制生产组件布局。
test.each(["read", "read-error", "generic", "edit", "write", "running-output", "plain-read", "patch", "plain-patch"] as const)(
  "shared auto review is rendered by the real tool: %s", async (scenario) => {
    const childID = "ses_reviewer_child"
    const plain = scenario.startsWith("plain-")
    const patch = scenario === "patch" || scenario === "plain-patch"
    const toolName = patch ? "apply_patch" : scenario === "generic" ? "future_tool" : scenario === "running-output" ? "bash" : scenario.replace("plain-", "").replace("-error", "")
    const review = { reviewID: "review_shared", sessionID: childID, status: scenario === "read-error" ? "denied" : "allowed",
      result: { risk_level: "high", user_authorization: "high", rationale: "authorized" } }
    const info: AssistantMessage = {
      id: "msg_shared", sessionID, role: "assistant", parentID: "msg_user", time: { created: 1, completed: 2 },
      modelID: "model", providerID: "provider", mode: "build", agent: "build", path: { cwd: directory, root: directory }, cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    }
    const files = (plain ? ["a"] : ["a", "b"]).map((name) => ({ filePath: `external/${name}.ts`, relativePath: `external/${name}.ts`,
      type: "update", patch: `--- external/${name}.ts\n+++ external/${name}.ts\n@@ -1 +1 @@\n-old\n+new`, additions: 1, deletions: 1 }))
    const metadata = {
      ...(plain ? {} : { autoReview: review }),
      ...(patch ? { files, diagnostics: {} } : {}),
      ...(scenario === "edit" ? { diff: Array.from({ length: 30 }, (_, i) => `+line ${i}`).join("\n"), diagnostics: {} } : {}),
      ...(scenario === "running-output" ? { output: "streamed output" } : {}),
    }
    const input = patch ? { patchText: "*** Begin Patch\n*** End Patch" } : scenario === "running-output" ? { command } : scenario === "edit" ? { filePath: "external/config.ts", oldString: "old", newString: "new" } : scenario === "write" ? { filePath: "external/config.ts", content: "created" } : { filePath: "external/config.ts" }
    const part: Part = {
      id: "part_shared", sessionID, messageID: info.id, type: "tool", tool: toolName, callID: "shared_call",
      state: scenario === "read-error"
        ? { status: "error", input, error: "auto reviewer denied", metadata, time: { start: 1, end: 2 } }
        : scenario === "running-output"
          ? { status: "running", input, metadata, title: "running", time: { start: 1 } }
          : { status: "completed", input, metadata, output: "", title: "completed", time: { start: 1, end: 2 } },
    }
    await withRenderedReview([{ info, parts: [part] }], async (app) => {
      await waitForReviewFrame(app, async (frame) => {
        if (plain ? frame.includes(patch ? "a.ts" : "config.ts") : frame.includes("@permission-reviewer")) return true
        await Bun.sleep(10)
        return false
      }, { maxPasses: 300 })
      await app.renderOnce()
      await app.renderOnce()
      const lines = app.captureCharFrame().split("\n")
      const reviewRows = lines.filter((line) => line.includes("auto review"))
      expect(reviewRows).toHaveLength(plain ? 0 : 1)
      if (plain) {
        expect(lines.join("\n")).not.toContain("% Patch")
        return
      }
      const row = lines.findIndex((line) => line.includes("auto review"))
      if (patch) {
        expect(lines.join("\n")).toContain("b.ts")
        expect(row).toBeLessThan(lines.findIndex((line) => line.includes("a.ts")))
      }
      if (scenario === "running-output") expect(row).toBeLessThan(lines.findIndex((line) => line.includes(command)))
      if (scenario === "read" || scenario === "read-error") expect(row).toBe(lines.findIndex((line) => line.includes("config.ts")) + 1)
      if (scenario === "read" || scenario === "edit") {
        await app.mockMouse.click(lines[row].indexOf("auto review"), row)
        await waitForReviewFrame(app, async (frame) => {
          if (frame.includes("reviewer child visible")) return true
          await Bun.sleep(10)
          return false
        }, { maxPasses: 300 })
        expect(app.captureCharFrame()).not.toContain("Click to collapse")
      }
    }, {}, { [childID]: () => [{ info: { ...info, id: "msg_reviewer_shared", sessionID: childID, agent: "permission-reviewer" },
      parts: [{ id: "part_reviewer_shared", sessionID: childID, messageID: "msg_reviewer_shared", type: "text", text: "reviewer child visible" }] }] })
  },
)

// 没有已排队的渲染不等于事件合并定时器已完成，等待可观察帧并持续推进原生绘制。
async function waitForReviewFrame(app: Awaited<ReturnType<typeof testRender>>, predicate: (frame: string) => Promise<boolean>, options: { maxPasses: number }) {
  for (let pass = 0; pass < options.maxPasses; pass++) {
    await app.renderOnce()
    if (await predicate(app.captureCharFrame())) return
  }
  throw new Error(`Expected session frame did not appear:\n${app.captureCharFrame()}`)
}

async function withRenderedReview(
  messages: { info: AssistantMessage | UserMessage; parts: Part[] }[],
  run: (app: Awaited<ReturnType<typeof testRender>>, route: ReturnType<typeof useRoute>, emit: ReturnType<typeof createEventSource>["emit"]) => Promise<void>,
  dimensions: { width?: number; height?: number } = {},
  children: Record<string, () => typeof messages> = {},
) {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const info = {
    id: sessionID, slug: "review-render", projectID: "proj_test", directory,
    version: "1", title: "Review render", time: { created: 1, updated: 3 },
  }
  const events = createEventSource()
  // 默认审查子会话和Task子会话共用按ID分发的真实响应形状。
  const sessions: Record<string, () => typeof messages> = { [sessionID]: () => messages, ses_reviewer_child: () => [], ...children }
  const calls = createFetch((url) => {
    const details = (id: string) => ({ ...info, id, ...(id === sessionID ? {} : { parentID: sessionID }) })
    if (url.pathname === "/session") return json(Object.keys(sessions).map(details))
    const match = url.pathname.match(/^\/session\/([^/]+)(?:\/(message|todo|diff))?$/)
    if (match && sessions[match[1]]) {
      if (!match[2]) return json(details(match[1]))
      if (match[2] === "message") return json(sessions[match[1]]())
      return json([])
    }
    if (url.pathname.startsWith("/session/")) return json([])
  }, events)
  const observed: { route?: ReturnType<typeof useRoute> } = {}
  const app = await testRender(() => <ReviewHarness state={tmp.path} fetch={calls.fetch} events={events.source} observe={(route) => { observed.route = route }} />, {
    width: dimensions.width ?? 110, height: dimensions.height ?? 56, footerHeight: 0, screenMode: "alternate-screen",
  })
  try {
    await wait(() => Boolean(observed.route))
    if (!observed.route) throw new Error("review route was not mounted")
    await run(app, observed.route, events.emit)
  } finally {
    app.renderer.destroy()
  }
}

function ReviewHarness(props: {
  state: string
  fetch: typeof globalThis.fetch
  events: ReturnType<typeof createEventSource>["source"]
  observe: (route: ReturnType<typeof useRoute>) => void
}) {
  const renderer = useRenderer()
  const config = createTuiResolvedConfig()
  const keymap = createDefaultOpenTuiKeymap(renderer)
  const runtime = createPluginRuntime()
  onCleanup(registerOpencodeKeymap(keymap, renderer, config))
  return (
    <TestTuiContexts paths={{ state: props.state }}>
      <OpencodeKeymapProvider keymap={keymap}>
        <ArgsProvider><ExitProvider exit={() => {}}><EpilogueProvider set={() => {}}>
          <ClipboardProvider value={{}}><KVProvider><ToastProvider>
            <RouteProvider initialRoute={{ type: "session", sessionID }}><TuiConfigProvider config={config}>
              <PluginRuntimeProvider value={runtime}>
                <SDKProvider url="http://test" directory={directory} testTransport={{ fetch: props.fetch, events: props.events }}>
                  <ProjectProvider><PermissionProvider><LocationProvider><DataProvider><SyncProvider>
                    <ThemeProvider mode="dark"><LocalProvider><PromptStashProvider><DialogProvider>
                      <FrecencyProvider><PromptHistoryProvider><PromptRefProvider><EditorContextProvider>
                        <ReviewProbe observe={props.observe} />
                      </EditorContextProvider></PromptRefProvider></PromptHistoryProvider></FrecencyProvider>
                    </DialogProvider></PromptStashProvider></LocalProvider></ThemeProvider>
                  </SyncProvider></DataProvider></LocationProvider></PermissionProvider></ProjectProvider>
                </SDKProvider>
              </PluginRuntimeProvider>
            </TuiConfigProvider></RouteProvider>
          </ToastProvider></KVProvider></ClipboardProvider>
        </EpilogueProvider></ExitProvider></ArgsProvider>
      </OpencodeKeymapProvider>
    </TestTuiContexts>
  )
}

function ReviewProbe(props: { observe: (route: ReturnType<typeof useRoute>) => void }) {
  props.observe(useRoute())
  return <Session />
}
