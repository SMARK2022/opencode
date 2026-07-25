/** @jsxImportSource @opentui/solid */
// #209：auto-review 渲染逻辑单元测试
import { describe, expect, test } from "bun:test"
import { autoReviewLabel, autoReviewMetadata, toolDisplay } from "../../../src/routes/session"
import { sessionMessageContentWidth } from "../../../src/routes/session/layout"
import { testRender, useRenderer } from "@opentui/solid"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { createEffect, onCleanup } from "solid-js"
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
import { SyncProvider, useSync } from "../../../src/context/sync"
import { ThemeProvider } from "../../../src/context/theme"
import { TuiConfigProvider } from "../../../src/config"
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "../../../src/keymap"
import { createPluginRuntime, PluginRuntimeProvider } from "../../../src/plugin/runtime"
import { FrecencyProvider } from "../../../src/component/prompt/frecency"
import { PromptHistoryProvider } from "../../../src/component/prompt/history"
import { PromptStashProvider } from "../../../src/component/prompt/stash"
import { DialogProvider } from "../../../src/ui/dialog"
import { ToastProvider } from "../../../src/ui/toast"

describe("auto review rendering (#209)", () => {
  test("autoReviewMetadata returns undefined for missing autoReview", () => {
    // #209：无 autoReview 字段时返回 undefined
    // #209：覆盖 null/string/array 四种非法类型——确保 type guard 不被 falsy 或非对象值欺骗
    expect(autoReviewMetadata({}, "bash")).toBeUndefined()
    expect(autoReviewMetadata({ autoReview: null }, "bash")).toBeUndefined()
    expect(autoReviewMetadata({ autoReview: "string" }, "bash")).toBeUndefined()
    expect(autoReviewMetadata({ autoReview: [] }, "bash")).toBeUndefined()
  })

  test("autoReviewMetadata returns undefined when reviewID is missing", () => {
    // #209：缺少 reviewID 字段时返回 undefined——防止部分写入的 metadata 被误用
    expect(autoReviewMetadata({ autoReview: { status: "reviewing" } }, "bash")).toBeUndefined()
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
    const review = autoReviewMetadata(metadata, "edit")
    expect(review).toBeDefined()
    expect(review?.reviewID).toBe("review_1")
    // #296：tool 参数由调用方注入并透传，供父卡片兜底区分 shell 与 inline 工具坐标语义
    expect(review?.tool).toBe("edit")
    expect(review?.sessionID).toBe("ses_reviewer")
    expect(review?.status).toBe("allowed")
    expect(review?.precheck?.level).toBe("cautious")
    expect(review?.result?.risk_level).toBe("high")
  })

  test("autoReviewLabel shows reviewing state with precheck level", () => {
    // #209：reviewing 状态展示 ◌ + precheck level + @permission-reviewer
    const label = autoReviewLabel({
      tool: "bash",
      reviewID: "review_2",
      status: "reviewing",
      precheck: { level: "cautious", reason: "sensitive read" },
    })
    expect(label).toBe("◌ auto review · cautious · @permission-reviewer")
  })

  test("autoReviewLabel shows allowed state with auth level", () => {
    // #209：allowed 状态展示 ✓ + auth level + @permission-reviewer
    const label = autoReviewLabel({
      tool: "bash",
      reviewID: "review_3",
      status: "allowed",
      result: { risk_level: "high", user_authorization: "high", rationale: "authorized" },
    })
    expect(label).toBe("✓ auto review · allowed · auth high · @permission-reviewer")
  })

  test("autoReviewLabel shows denied state with risk and auth", () => {
    // #209：denied 状态展示 ! + risk + auth + @permission-reviewer
    const label = autoReviewLabel({
      tool: "bash",
      reviewID: "review_4",
      status: "denied",
      result: { risk_level: "high", user_authorization: "unknown", rationale: "not authorized" },
    })
    expect(label).toBe("! auto review · denied · high risk · auth unknown · @permission-reviewer")
  })

  test("autoReviewLabel shows timed_out state as failed closed", () => {
    // #209：timed_out 状态展示 ! + timed out + failed closed
    const label = autoReviewLabel({ reviewID: "review_5", tool: "bash", status: "timed_out" })
    expect(label).toBe("! auto review · timed out · failed closed · @permission-reviewer")
  })

  test("autoReviewLabel shows failed state as failed closed", () => {
    // #209：failed 状态展示 ! + failed + failed closed
    const label = autoReviewLabel({ reviewID: "review_6", tool: "bash", status: "failed" })
    expect(label).toBe("! auto review · failed · failed closed · @permission-reviewer")
  })

  test("autoReviewLabel shows fallback_user state as asking user", () => {
    // #209：fallback_user 状态展示 ! + unavailable + asking user
    const label = autoReviewLabel({ reviewID: "review_7", tool: "bash", status: "fallback_user" })
    expect(label).toBe("! auto review · unavailable · asking user · @permission-reviewer")
  })

  test("autoReviewLabel shows aborted state", () => {
    // #216：aborted 状态展示 ! + aborted + @permission-reviewer——工具执行被取消时的审查终态
    const label = autoReviewLabel({ reviewID: "review_9", tool: "bash", status: "aborted" })
    expect(label).toBe("! auto review · aborted · @permission-reviewer")
  })

  test("autoReviewLabel defaults to reviewing when status is undefined", () => {
    // #209：无 status 时默认展示 reviewing + precheck level
    // #209：默认 reviewing 是安全假设——metadata 写入与状态更新非原子，读取时可能尚未标记终态
    const label = autoReviewLabel({
      tool: "bash",
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

// 中止与原六种场景共用真实Session，确保终态审查行仍可见且可以导航。
test.each(["running", "completed", "collapsed", "error", "decision", "transcript", "aborted"] as const)(
  "renders the real review session: %s",
  async (scenario) => {
    const review = {
      reviewID: "review_render",
      sessionID: "ses_reviewer_child",
      status: scenario === "aborted" ? "aborted" : scenario === "running" ? "reviewing" : scenario === "error" ? "denied" : "allowed",
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
      state: scenario === "error" || scenario === "aborted"
        ? { status: "error", input, error: scenario === "aborted" ? "Tool execution aborted" : "auto reviewer denied", metadata: { autoReview: review }, time: { start: 1, end: 2 } }
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
        const expected = scenario === "aborted" ? "! auto review · aborted · @permission-reviewer"
          : scenario === "running" ? "◌ auto review"
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
        if (scenario === "running" || scenario === "error" || scenario === "aborted") expect(reviewRow).toBe(row + 1)
        expect(lines.filter((line) => line.includes(expected))).toHaveLength(1)
        if (scenario === "collapsed") expect(lines.join("\n")).toContain("Click to expand")
        if (scenario === "running") {
          await app.mockMouse.click(lines[row].indexOf(command), row)
          expect(route.data).toMatchObject({ type: "session", sessionID })
          await app.renderOnce()
          await clickVisibleText(app, "auto review")
          expect(route.data).toMatchObject({ type: "session", sessionID: "ses_reviewer_child" })
        }
        // 错误卡的命令行仍可展开错误，独立审查行的鼠标操作必须抵达子会话路由。
        if (scenario === "error" || scenario === "aborted") {
          // 审查标签不再可选择；在命令正文上验证拖选不会变成导航。
          const x = lines[row].indexOf(command)
          await app.mockMouse.drag(x, row, x + 6, row)
          expect(route.data).toMatchObject({ type: "session", sessionID })
          await app.renderOnce()
          app.renderer.clearSelection()
          await clickVisibleText(app, "auto review")
          expect(route.data).toMatchObject({ type: "session", sessionID: "ses_reviewer_child" })
        }
      },
    )
  },
)

// 复用真实Session夹具，分别验证自动压缩标题及没有普通用户正文时的滚动条标记。
test.each(["label", "scrollbar"] as const)("compaction boundary is rendered: %s", async (scenario) => {
  const user: UserMessage = {
    id: "msg_compaction", sessionID, role: "user", time: { created: 1 },
    agent: "build", model: { providerID: "provider", modelID: "model" },
  }
  const assistant: AssistantMessage = {
    id: "msg_compaction_summary", sessionID, role: "assistant", parentID: user.id,
    time: { created: 2, completed: 3 }, modelID: "model", providerID: "provider", mode: "build", agent: "build",
    path: { cwd: directory, root: directory }, cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  }
  const compaction: Part = {
    id: "part_compaction", sessionID, messageID: user.id, type: "compaction", auto: true,
  }
  const summary: Part = {
    id: "part_compaction_summary", sessionID, messageID: assistant.id, type: "text",
    text: scenario === "scrollbar" ? `${"content after compaction ".repeat(500)}SCROLL_BOTTOM` : "Compacted summary",
  }
  await withRenderedReview([{ info: user, parts: [compaction] }, { info: assistant, parts: [summary] }], async (app) => {
    const expected = scenario === "scrollbar" ? "SCROLL_BOTTOM" : "Auto Compaction"
    await waitForReviewFrame(app, async (frame) => {
      if (frame.includes(expected)) return true
      await Bun.sleep(10)
      return false
    }, { maxPasses: 300 })
    await app.renderOnce()
    await app.renderOnce()
    if (scenario === "label") {
      expect(app.captureCharFrame()).toContain("Auto Compaction")
      return
    }
    // 没有普通用户正文，右侧半格标记只能来自压缩边界，不能由普通prompt标记代替。
    const rows = app.captureCharFrame().split("\n")
    expect(rows.some((row) => /[▀▄]/.test(row.slice(-4)))).toBe(true)
  }, { width: 100, height: scenario === "scrollbar" ? 14 : 30 })
})

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
          : { status: "completed", input, metadata, output: scenario === "generic" ? "GENERIC_OUTPUT" : "", title: "completed", time: { start: 1, end: 2 } },
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
      // 缺省KV必须显示真实非空generic输出，空字符串不会经过被修改的分支。
      if (scenario === "generic") expect(lines.join("\n")).toContain("GENERIC_OUTPUT")
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
        await clickVisibleText(app, "auto review")
        await waitForReviewFrame(app, async (frame) => {
          if (frame.includes("reviewer child visible")) return true
          await Bun.sleep(10)
          return false
        }, { maxPasses: 300 })
        // 导航到真实审查子会话后，页脚必须保留含连字符的代理名。
        expect(app.captureCharFrame()).toContain("Permission-Reviewer")
        expect(app.captureCharFrame()).not.toContain("Click to collapse")
      }
    }, {}, { [childID]: () => [{ info: { ...info, id: "msg_reviewer_shared", sessionID: childID, agent: "permission-reviewer" },
      parts: [{ id: "part_reviewer_shared", sessionID: childID, messageID: "msg_reviewer_shared", type: "text", text: "reviewer child visible" }] }] })
  },
)

// 复用现有真实Session和隔离SDK transport，断言字符帧与鼠标/SSE行为而非源码字符串。
test.each(["bounded", "boundary", "conceal", "insert", "remove", "show"] as const)("reasoning run replay: %s", async (scenario) => {
  const messageID = `msg_reasoning_${scenario}`
  const reasoning = (id: string, text: string): Part => ({ id, sessionID, messageID, type: "reasoning", text, time: { start: 1, end: 2 } })
  const long = Array.from({ length: 7 }, (_, index) => `middle ${index}`).join("\n")
  const boundary: Part = { id: "part_b", sessionID, messageID, type: "text", text: "   " }
  const parts = scenario === "bounded" || scenario === "show"
    ? Array.from({ length: 10 }, (_, index) => reasoning(`part_${String(index).padStart(2, "0")}`, `short thought ${index + 1}`))
    : scenario === "boundary" ? [reasoning("part_a", "left source"), boundary, reasoning("part_c", "right source")]
    : scenario === "conceal" ? [reasoning("part_a", "visible first source"), reasoning("part_b", "![](private-url)")]
    : scenario === "remove" ? [reasoning("part_a", long), boundary, reasoning("part_c", "right source")]
    : [reasoning("part_b", long)]
  const info: AssistantMessage = {
    id: messageID, sessionID, role: "assistant", parentID: "msg_request", finish: "stop",
    time: { created: 1, completed: 3 }, modelID: "model", providerID: "provider", mode: "build", agent: "build",
    path: { cwd: directory, root: directory }, cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  }
  await withRenderedReview([{ info, parts }], async (app, _route, emit) => {
    const frame = async (...texts: string[]) => {
      await waitForReviewFrame(app, async (value) => {
        if (texts.every((text) => value.includes(text))) return true
        await Bun.sleep(5)
        return false
      }, { maxPasses: 400 })
      // 等预布局间距落定后才使用可见文本坐标点击。
      await app.renderOnce()
      await app.renderOnce()
      return app.captureCharFrame()
    }
    if (scenario === "boundary") {
      const value = await frame("left source", "right source")
      expect(value.split("\n").filter((line) => line.includes("Thought")).length).toBe(2)
      expect(value).not.toContain("2 segments")
      return
    }
    if (scenario === "conceal") {
      await frame("visible first source")
      for (let index = 0; index < 12; index++) {
        await app.renderOnce()
        expect(app.captureCharFrame()).not.toContain("private-url")
        await Bun.sleep(5)
      }
      app.mockInput.pressKey("x", { ctrl: true })
      app.mockInput.pressKey("h")
      await frame("private-url")
      app.mockInput.pressKey("x", { ctrl: true })
      app.mockInput.pressKey("h")
      // 固定分隔符属于结构；隐藏image后仍逐帧确认正文不会被晚到highlight复活。
      await waitForReviewFrame(app, async (value) => { if (!value.includes("private-url")) return true; await Bun.sleep(5); return false }, { maxPasses: 400 })
      for (let index = 0; index < 12; index++) {
        await app.renderOnce()
        expect(app.captureCharFrame()).not.toContain("private-url")
        await Bun.sleep(5)
      }
      return
    }
    if (scenario === "bounded" || scenario === "show") {
      if (scenario === "show") {
        // visibility=true 不预设 disclosure；原 #481 契约要求用户先展开局部 run。
        await frame("▼ 展开查看完整推理")
        await clickVisibleText(app, "▼ 展开查看完整推理")
        expect(await frame("short thought 10", "▲ 收起推理")).not.toContain("▼ 展开查看完整推理")
        await clickVisibleText(app, "▲ 收起推理")
      }
      const value = await frame("10 segments", "short thought 2", "▼ 展开查看完整推理")
      const lines = value.split("\n")
      expect(lines.filter((line) => line.includes("Thought")).length).toBe(1)
      const header = lines.findIndex((line) => line.includes("10 segments"))
      const footer = lines.findIndex((line) => line.includes("▼ 展开查看完整推理"))
      expect(footer - header + 1).toBeLessThanOrEqual(7)
      expect(value).not.toContain("short thought 10")
      await clickVisibleText(app, "▼ 展开查看完整推理")
      expect(await frame("short thought 10", "▲ 收起推理")).toContain("short thought 10")
      // 再折叠再展开，完整正文不能因renderable销毁而变空。
      await clickVisibleText(app, "▲ 收起推理")
      await frame("▼ 展开查看完整推理")
      await clickVisibleText(app, "▼ 展开查看完整推理")
      await frame("short thought 10", "▲ 收起推理")
      return
    }
    await frame("▼ 展开查看完整推理")
    await clickVisibleText(app, "▼ 展开查看完整推理")
    await frame("middle 6", "▲ 收起推理")
    if (scenario === "insert") {
      emit({ directory, project: "proj_test", payload: { id: "evt_prepend", type: "message.part.updated", properties: { sessionID, part: reasoning("part_a", "earlier source"), time: 3 } } })
      await frame("earlier source", "2 segments", "▲ 收起推理")
      emit({ directory, project: "proj_test", payload: { id: "evt_append", type: "message.part.updated", properties: { sessionID, part: reasoning("part_c", "later source"), time: 4 } } })
      const value = await frame("later source", "3 segments", "▲ 收起推理")
      expect(value.split("\n").filter((line) => line.includes("earlier source")).length).toBe(1)
      return
    }
    emit({ directory, project: "proj_test", payload: { id: "evt_boundary_remove", type: "message.part.removed", properties: { sessionID, messageID, partID: "part_b" } } })
    const value = await frame("right source", "2 segments", "▲ 收起推理")
    expect(value.split("\n").filter((line) => line.includes("right source")).length).toBe(1)
    emit({ directory, project: "proj_test", payload: { id: "evt_member_remove", type: "message.part.removed", properties: { sessionID, messageID, partID: "part_c" } } })
    await waitForReviewFrame(app, async (next) => {
      if (!next.includes("right source") && !next.includes("2 segments") && next.includes("middle 6")) return true
      await Bun.sleep(5)
      return false
    }, { maxPasses: 400 })
  }, { width: 110, height: 48 }, {}, { thinking_visibility: true })
})

test.each(["glob", "grep"] as const)("completed partial %s remains visibly incomplete with details off", async (tool) => {
  const messageID = `msg_partial_${tool}`
  const info: AssistantMessage = {
    id: messageID, sessionID, role: "assistant", parentID: "msg_request", finish: "stop",
    time: { created: 1, completed: 3 }, modelID: "model", providerID: "provider", mode: "build", agent: "build",
    path: { cwd: directory, root: directory }, cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  }
  const part: Part = { id: "part_search", sessionID, messageID, type: "tool", tool, callID: "call_search", state: {
    status: "completed", title: "search", input: { pattern: "needle", path: directory }, output: "No files found in accessible paths.",
    metadata: { count: 0, matches: 0, partial: true, truncated: false }, time: { start: 1, end: 2 },
  } }
  await withRenderedReview([{ info, parts: [part] }], async (app) => {
    await waitForReviewFrame(app, async (frame) => {
      if (frame.includes("incomplete")) return true
      await Bun.sleep(5)
      return false
    }, { maxPasses: 400 })
    expect(app.captureCharFrame()).toContain("incomplete")
  }, {}, {}, { tool_details_visibility: false })
})

async function clickVisibleText(app: Awaited<ReturnType<typeof testRender>>, text: string) {
  const lines = app.captureCharFrame().split("\n")
  const y = lines.findIndex((line) => line.includes(text))
  if (y < 0) throw new Error(`missing clickable text ${JSON.stringify(text)}:\n${lines.join("\n")}`)
  const x = lines[y].indexOf(text)
  if (x < 0) throw new Error(`missing clickable text column ${JSON.stringify(text)}:\n${lines[y]}`)
  // 文本锚点跟随布局变化；当前mockMouse使用零基行号，列坐标进入标签内部。
  await app.mockMouse.click(x + 1, y)
}

// 没有已排队的渲染不等于事件合并定时器已完成，等待可观察帧并持续推进原生绘制。
async function waitForReviewFrame(app: Awaited<ReturnType<typeof testRender>>, predicate: (frame: string) => Promise<boolean>, options: { maxPasses: number }) {
  const start = Date.now()
  let passes = 0
  let frame = ""
  while (Date.now() - start < 5_000) {
    passes++
    await app.renderOnce()
    frame = app.captureCharFrame()
    if (await predicate(frame)) return
    await Promise.resolve()
    await new Promise((resolve) => process.nextTick(resolve))
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error(`Expected session frame did not appear after ${Date.now() - start}ms (${passes} passes, prior budget ${options.maxPasses}):\n${frame}`)
}

// 两个source场景共用现有真实Session夹具：有回答定位旧返回，无回答定位请求正文。
test.each(["pending", "completed"] as const)("auto review deep link keeps the matching region: %s", async (scenario) => {
  const childID = "ses_reviewer_child"
  const reviewID = "review_old_deep"
  const request: UserMessage = {
    id: "msg_anchor_request", sessionID: childID, role: "user", time: { created: 10 },
    agent: "permission-reviewer", model: { providerID: "provider", modelID: "model" },
  }
  const answer: AssistantMessage = {
    id: "msg_anchor_answer", sessionID: childID, role: "assistant", parentID: request.id,
    time: { created: 11, completed: 12 }, modelID: "model", providerID: "provider",
    mode: "permission-reviewer", agent: "permission-reviewer", finish: "stop",
    path: { cwd: directory, root: directory }, cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  }
  const text = (info: AssistantMessage | UserMessage, value: string): Extract<Part, { type: "text" }> => ({
    id: `part_${info.id}`, sessionID: childID, messageID: info.id, type: "text", text: value,
  })
  const child: { info: AssistantMessage | UserMessage; parts: Part[] }[] = [
    { info: request, parts: [{ ...text(request, "REVIEWING_REQUEST_MARKER_xyz"), metadata: { permissionReviewerRequest: true, reviewID } }] },
    ...(scenario === "completed" ? [{ info: answer, parts: [text(answer, "OLD_REVIEW_RETURN_MARKER_xyz")] }] : []),
  ]
  // 每个padding回答有自己的parent，避免伪造多条同parent回答干扰真实join方向。
  for (let index = 0; index < 18; index++) {
    const user = { ...request, id: `msg_fill_user_${index}`, time: { created: 20 + index * 2 } }
    const assistant = { ...answer, id: `msg_fill_answer_${index}`, parentID: user.id, time: { created: 21 + index * 2, completed: 22 + index * 2 } }
    child.push({ info: user, parts: [text(user, "filler request")] }, { info: assistant, parts: [text(assistant, `FILLER_${index}_LONG_ENOUGH_TO_HIDE_OLD_REVIEW_WHEN_STUCK_TO_BOTTOM`)] })
  }
  const latestRequest = { ...request, id: "msg_latest_request", time: { created: 200 } }
  const latestAnswer = { ...answer, id: "msg_latest_answer", parentID: latestRequest.id, time: { created: 201, completed: 202 } }
  child.push({ info: latestRequest, parts: [text(latestRequest, "latest request")] }, { info: latestAnswer, parts: [text(latestAnswer, "LATEST_REVIEW_RETURN_MARKER_xyz")] })
  const parent = { ...answer, id: "msg_deep_link_parent", sessionID, parentID: "msg_parent_request" }
  const review = {
    reviewID, sessionID: childID, status: scenario === "completed" ? "allowed" : "reviewing",
    precheck: { level: "cautious", reason: "external file read requires reviewer approval" },
    result: { risk_level: "high", user_authorization: "high", rationale: "requested exact file" },
  }
  const part: Part = {
    id: "part_deep_link_parent", sessionID, messageID: parent.id, type: "tool", callID: "call_deep_link", tool: "read",
    state: scenario === "completed"
      ? { status: "completed", input: { filePath: "external folder/secret.txt" }, title: "secret.txt", output: "read", metadata: { autoReview: review }, time: { start: 1, end: 2 } }
      : { status: "running", input: { filePath: "external folder/secret.txt" }, metadata: { autoReview: review }, time: { start: 1 } },
  }
  await withRenderedReview([{ info: parent, parts: [part] }], async (app, route) => {
    const label = scenario === "completed" ? "✓ auto review · allowed · auth high" : "◌ auto review · cautious"
    await waitForReviewFrame(app, async (value) => { if (value.includes(label)) return true; await Bun.sleep(5); return false }, { maxPasses: 400 })
    await app.renderOnce()
    await app.renderOnce()
    // 点击公开状态行而非直接导航；request/answer marker均为独立字面量。
    await clickVisibleText(app, label)
    expect(route.data).toMatchObject({ type: "session", sessionID: childID, reviewID })
    const marker = scenario === "completed" ? "OLD_REVIEW_RETURN_MARKER_xyz" : "REVIEWING_REQUEST_MARKER_xyz"
    await waitForReviewFrame(app, async (value) => { if (value.includes(marker)) return true; await Bun.sleep(5); return false }, { maxPasses: 400 })
    // 两个50ms入口都完成后仍必须停在锚点，不能以瞬间出现掩盖旧贴底timer覆盖。
    await Bun.sleep(130)
    await app.renderOnce()
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain(marker)
    expect(app.captureCharFrame()).not.toContain("LATEST_REVIEW_RETURN_MARKER_xyz")
    // 普通导航省略reviewID后仍按既有语义贴底，并清除同Session的旧锚点。
    route.navigate({ type: "session", sessionID: childID })
    expect(route.data).not.toHaveProperty("reviewID")
    await waitForReviewFrame(app, async (value) => { if (value.includes("LATEST_REVIEW_RETURN_MARKER_xyz")) return true; await Bun.sleep(5); return false }, { maxPasses: 400 })
    expect(app.captureCharFrame()).toContain("LATEST_REVIEW_RETURN_MARKER_xyz")
  }, { height: 14 }, { [childID]: () => child })
})

async function withRenderedReview(
  messages: { info: AssistantMessage | UserMessage; parts: Part[] }[],
  run: (app: Awaited<ReturnType<typeof testRender>>, route: ReturnType<typeof useRoute>, emit: ReturnType<typeof createEventSource>["emit"]) => Promise<void>,
  dimensions: { width?: number; height?: number } = {},
  children: Record<string, () => typeof messages> = {},
  kv: Record<string, unknown> = {},
) {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, JSON.stringify(kv))
  const info = {
    id: sessionID, slug: "review-render", projectID: "proj_test", directory,
    version: "1", title: "Review render", time: { created: 1, updated: 3 },
  }
  const events = createEventSource()
  // 默认审查子会话和Task子会话共用按ID分发的真实响应形状。
  const sessions: Record<string, () => typeof messages> = { [sessionID]: () => messages, ses_reviewer_child: () => [], ...children }
  const calls = createFetch((url) => {
    const details = (id: string) => ({ ...info, id, ...(id === sessionID ? {} : { parentID: sessionID }), ...(id === "ses_reviewer_child" ? { title: "Permission review (@permission-reviewer subagent)" } : {}) })
    if (url.pathname === "/session") return json(Object.keys(sessions).map(details))
    const match = url.pathname.match(/^\/session\/([^/]+)(?:\/(message|todo|diff))?$/)
    if (match && sessions[match[1]]) {
      if (!match[2]) return json(details(match[1]))
      if (match[2] === "message") return json(sessions[match[1]]())
      return json([])
    }
    if (url.pathname.startsWith("/session/")) return json([])
  }, events)
  const messageIDs = messages.map((message) => message.info.id)
  const observed: { route?: ReturnType<typeof useRoute>; syncReady: boolean } = { syncReady: false }
  const app = await testRender(() => <ReviewHarness state={tmp.path} fetch={calls.fetch} events={events.source} observe={(route) => { observed.route = route }} messageIDs={messageIDs} onSyncReady={() => { observed.syncReady = true }} />, {
    width: dimensions.width ?? 110, height: dimensions.height ?? 56, footerHeight: 0, screenMode: "alternate-screen", useThread: false,
  })
  try {
    // 根挂载不代表 Session transcript 已入库；单循环成功即退出，不留下并行 loser 绘制。
    const syncDeadline = Date.now() + 10_000
    while (!observed.syncReady) {
      if (Date.now() >= syncDeadline) throw new Error(`session sync data missing: ${sessionID}, ${messageIDs.join(",")}`)
      await app.renderOnce()
      await Promise.resolve()
      await new Promise((resolve) => process.nextTick(resolve))
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
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
  messageIDs: string[]
  onSyncReady: () => void
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
                        <ReviewProbe observe={props.observe} messageIDs={props.messageIDs} onSyncReady={props.onSyncReady} />
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

function ReviewProbe(props: { observe: (route: ReturnType<typeof useRoute>) => void; messageIDs: string[]; onSyncReady: () => void }) {
  const sync = useSync()
  props.observe(useRoute())
  let fired = false
  // 观察公开 store 的初始 Session 消息/part 数组，子会话仅在真实导航后由既有路径加载。
  createEffect(() => {
    if (fired || !sync.session.get(sessionID)) return
    const infos = sync.data.message[sessionID]
    if (!infos || props.messageIDs.some((id) => !infos.some((info) => info.id === id) || sync.data.part[id] === undefined)) return
    fired = true
    props.onSyncReady()
  })
  return <Session />
}

// 在真实Session树测量两个正文renderable，不用私有组件名字或手工复制chrome替代布局。
test.each([
  { terminalWidth: 80, sidebarVisible: false, scrollbarEnabled: false },
  { terminalWidth: 80, sidebarVisible: false, scrollbarEnabled: true },
  { terminalWidth: 160, sidebarVisible: false, scrollbarEnabled: true },
  { terminalWidth: 160, sidebarVisible: true, scrollbarEnabled: true },
  { terminalWidth: 160, sidebarVisible: true, scrollbarEnabled: false },
].flatMap((input) => (["hide", "show"] as const).map((thinkingMode) => ({ ...input, thinkingMode }))))("measures actual reasoning and text width: %j", async (input) => {
  const messageID = "msg_layout"
  const info: AssistantMessage = {
    id: messageID, sessionID, role: "assistant", parentID: "msg_request", finish: "stop",
    time: { created: 1, completed: 3 }, modelID: "model", providerID: "provider", mode: "build", agent: "build",
    path: { cwd: directory, root: directory }, cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  }
  const parts: Part[] = [
    { id: "part_a_text", sessionID, messageID, type: "text", text: "reference width" },
    { id: "part_b_reasoning", sessionID, messageID, type: "reasoning", text: "推理宽度".repeat(200), time: { start: 1, end: 2 } },
  ]
  await withRenderedReview([{ info, parts }], async (app) => {
    const id = "text-part_b_reasoning"
    await waitForReviewFrame(app, async () => {
      const code = app.renderer.root.findDescendantById(id)
      const text = app.renderer.root.findDescendantById(messageID)?.getChildren()[0]?.getChildren()[0]
      if (code && text && code.width > 0 && text.width > 0 && (code.parent?.height ?? 0) > 0) return true
      await Bun.sleep(5)
      return false
    }, { maxPasses: 400 })
    // 异步highlight和预布局都落定后再读几何，不以刚挂载时的零尺寸通过。
    await app.renderOnce()
    await app.renderOnce()
    const code = app.renderer.root.findDescendantById(id)
    const text = app.renderer.root.findDescendantById(messageID)?.getChildren()[0]?.getChildren()[0]
    if (!code || !text) throw new Error("expected measured message bodies")
    const expected = sessionMessageContentWidth({ terminalWidth: input.terminalWidth, sidebarInLayout: input.sidebarVisible && input.terminalWidth > 120, scrollbarEnabled: input.scrollbarEnabled })
    expect({ text: text.width, reasoning: code.width }).toEqual({ text: expected, reasoning: expected })
    expect(code.parent?.height).toBeGreaterThan(0)
    // 单个source常驻完整高度，共享run容器负责五行裁尾；实际同宽断言不变。
    if (input.thinkingMode === "hide") expect(code.parent?.parent?.height).toBeLessThanOrEqual(5)
  }, { width: input.terminalWidth, height: 48 }, {}, { sidebar: input.sidebarVisible ? "auto" : "hide", scrollbar_enabled: input.scrollbarEnabled, thinking_mode: input.thinkingMode })
})

// 复用真实Session/事件/鼠标，单树回归必须观察首帧和原生renderable身份。
test.each(["first-frame", "streaming", "resize", "selection", "errors"] as const)("single reasoning tree replay: %s", async (scenario) => {
  const messageID = `msg_single_${scenario}`
  const content = scenario === "first-frame" ? Array.from({ length: 400 }, (_, index) => `stable thought ${index + 1}`).join("\n")
    : scenario === "resize" ? `${"resize content ".repeat(24)}RESIZE_TAIL`
    : Array.from({ length: 7 }, (_, index) => `single thought ${index}`).join("\n")
  const source = { id: "part_source", sessionID, messageID, type: "reasoning" as const, text: content, time: { start: 1, ...(scenario === "streaming" ? {} : { end: 2 }) } }
  const info: AssistantMessage = {
    id: messageID, sessionID, role: "assistant", parentID: "msg_request", finish: scenario === "streaming" ? undefined : "stop",
    time: { created: 1, ...(scenario === "streaming" ? {} : { completed: 3 }) }, modelID: "model", providerID: "provider", mode: "build", agent: "build",
    path: { cwd: directory, root: directory }, cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  }
  const failed: AssistantMessage = { ...info, id: "msg_single_failed", finish: "error", error: { name: "APIError", data: { message: "provider reasoning failed", isRetryable: false } } }
  const messages = scenario === "errors" ? [
    { info: { ...info, error: { name: "MessageAbortedError" as const, data: { message: "interrupted by user" } } }, parts: [{ ...source, text: "partial aborted thought" }] },
    { info: failed, parts: [{ ...source, id: "part_failed", messageID: failed.id, text: "partial failed thought" }] },
  ] : [{ info, parts: [source] }]
  await withRenderedReview(messages, async (app, _route, emit) => {
    const frame = async (...texts: string[]) => {
      await waitForReviewFrame(app, async (value) => { if (texts.every((text) => value.includes(text))) return true; await Bun.sleep(5); return false }, { maxPasses: 400 })
      await app.renderOnce()
      await app.renderOnce()
      return app.captureCharFrame()
    }
    if (scenario === "errors") {
      const value = await frame("partial aborted thought", "partial failed thought", "interrupted", "provider reasoning failed")
      expect(value).toContain("partial aborted thought")
      expect(value).toContain("partial failed thought")
      return
    }
    await frame("▼ 展开查看完整推理", scenario === "first-frame" ? "stable thought 1" : scenario === "resize" ? "resize content" : "single thought 0")
    const body = app.renderer.root.findDescendantById(`text-${source.id}`)
    if (!body) throw new Error("expected mounted reasoning body")
    if (scenario === "selection") {
      const lines = app.captureCharFrame().split("\n")
      const y = lines.findIndex((line) => line.includes("single thought 0"))
      const x = lines[y].indexOf("single thought")
      await app.mockMouse.drag(x, y, x + 12, y)
      await app.renderOnce()
      expect(app.renderer.getSelection()?.getSelectedText()?.length).toBeGreaterThan(0)
      expect(app.captureCharFrame()).toContain("▼ 展开查看完整推理")
      return
    }
    await clickVisibleText(app, "▼ 展开查看完整推理")
    await app.renderOnce()
    if (scenario === "first-frame") {
      // 只检查点击后第一帧，不能以等待最终高亮掩盖双树切换的正文空窗。
      expect(app.captureCharFrame()).toContain("stable thought")
      expect(app.captureCharFrame()).toContain("▲ 收起推理")
      expect(app.renderer.root.findDescendantById(`text-${source.id}`)).toBe(body)
      await frame("stable thought 400", "▲ 收起推理")
    }
    if (scenario === "streaming") {
      await frame("single thought 6", "▲ 收起推理")
      emit({ directory, project: "proj_test", payload: { id: "evt_stream_delta", type: "message.part.delta", properties: { sessionID, messageID, partID: source.id, field: "text", delta: "\nstream final delta" } } })
      await frame("stream final delta")
      // Part先完成而父Message仍pending，沿上游生命周期结束推理，不重挂正文。
      emit({ directory, project: "proj_test", payload: { id: "evt_part_done", type: "message.part.updated", properties: { sessionID, part: { ...source, text: content + "\nstream final delta", time: { start: 1, end: 2 } }, time: 3 } } })
      await frame("Thought", "stream final delta")
      expect(app.renderer.root.findDescendantById(`text-${source.id}`)).toBe(body)
      emit({ directory, project: "proj_test", payload: { id: "evt_message_done", type: "message.updated", properties: { sessionID, info: { ...info, finish: "stop", time: { created: 1, completed: 3 } } } } })
      await frame("stream final delta")
    }
    await frame("▲ 收起推理")
    await clickVisibleText(app, "▲ 收起推理")
    await frame("▼ 展开查看完整推理")
    if (scenario === "resize") {
      app.resize(160, 48)
      await waitForReviewFrame(app, async (value) => { if (value.includes("RESIZE_TAIL") && !value.includes("▼ 展开查看完整推理")) return true; await Bun.sleep(5); return false }, { maxPasses: 400 })
      expect(app.captureCharFrame()).not.toContain("▲ 收起推理")
      app.resize(60, 48)
      expect(await frame("▼ 展开查看完整推理")).not.toContain("RESIZE_TAIL")
      expect(app.renderer.root.findDescendantById(`text-${source.id}`)).toBe(body)
      return
    }
    await clickVisibleText(app, "▼ 展开查看完整推理")
    await app.renderOnce()
    if (scenario === "first-frame") {
      expect(app.captureCharFrame()).toContain("stable thought")
      expect(app.captureCharFrame()).toContain("▲ 收起推理")
    }
    if (scenario === "streaming") expect((await frame("stream final delta")).split("\n").filter((line) => line.includes("stream final delta"))).toHaveLength(1)
    expect(app.renderer.root.findDescendantById(`text-${source.id}`)).toBe(body)
  }, { width: scenario === "resize" ? 60 : 110, height: 48 }, {}, { thinking_mode: "hide", sidebar: "hide" })
})

test.each(["short", "long"] as const)("streaming reasoning defaults to stable collapse: %s", async (scenario) => {
  const messageID = "msg_stream_default"
  const source = { id: "part_stream", sessionID, messageID, type: "reasoning" as const, text: "short stream thought", time: { start: 1 } }
  const info: AssistantMessage = {
    id: messageID, sessionID, role: "assistant", parentID: "msg_request", time: { created: 1 }, modelID: "model", providerID: "provider", mode: "build", agent: "build",
    path: { cwd: directory, root: directory }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  }
  const suffix = scenario === "short" ? "\nsecond stream line" : "\nsecond stream line\nline 3\nline 4\nline 5\nline 6\nSTREAM_TAIL"
  const opaque = { ...source, id: "part_opaque", messageID: "msg_stream_opaque", text: "[REDACTED]", metadata: { encrypted: true } }
  await withRenderedReview([{ info, parts: [source] }, { info: { ...info, id: opaque.messageID }, parts: [opaque] }], async (app, _route, emit) => {
    const frame = async (text: string) => {
      await waitForReviewFrame(app, async (value) => { if (value.includes(text)) return true; await Bun.sleep(5); return false }, { maxPasses: 400 })
      return app.captureCharFrame()
    }
    // #481：首个短正文没有虚假 overflow；先点短正文也不能预写后续 expanded。
    const initial = await frame("short stream thought")
    expect(initial).not.toContain("▼ 展开查看完整推理")
    expect(initial.split("\n").filter((line) => line.includes("▼ 展开查看完整推理"))).toHaveLength(0)
    // 再增长仍受共享五行预算，不能以短内容点击绕过默认收缩。
    await clickVisibleText(app, "short stream thought")
    emit({ directory, project: "proj_test", payload: { id: "evt_default_grow", type: "message.part.delta", properties: { sessionID, messageID, partID: source.id, field: "text", delta: suffix } } })
    const grown = await frame("second stream line")
    if (scenario === "short") expect(grown).not.toContain("▼ 展开查看完整推理")
    if (scenario === "long") expect(await frame("▼ 展开查看完整推理")).not.toContain("STREAM_TAIL")
    const body = app.renderer.root.findDescendantById(`text-${source.id}`)
    expect(body?.parent?.parent?.height).toBeLessThanOrEqual(5)
    // 父Message仍pending，只以原始Part的end解除流式guard。
    emit({ directory, project: "proj_test", payload: { id: "evt_default_done", type: "message.part.updated", properties: { sessionID, part: { ...source, text: source.text + suffix, time: { start: 1, end: 2 } }, time: 3 } } })
    await waitForReviewFrame(app, async (value) => {
      if (value.includes("Thought") && value.includes("second stream line") && (scenario === "long" || !value.includes("▼ 展开查看完整推理"))) return true
      await Bun.sleep(5)
      return false
    }, { maxPasses: 400 })
    expect(app.renderer.root.findDescendantById(`text-${source.id}`)).toBe(body)
    if (scenario === "short") {
      expect(app.captureCharFrame()).not.toContain("▼ 展开查看完整推理")
      expect(app.captureCharFrame()).toContain("short stream thought")
      expect(app.captureCharFrame()).toContain("second stream line")
      return
    }
    expect(app.captureCharFrame()).toContain("▼ 展开查看完整推理")
    expect(app.captureCharFrame()).not.toContain("STREAM_TAIL")
    await clickVisibleText(app, "▼ 展开查看完整推理")
    expect(await frame("STREAM_TAIL")).toContain("STREAM_TAIL")
  }, { width: 80, height: 48 }, {}, { thinking_visibility: true, sidebar: "hide" })
})
