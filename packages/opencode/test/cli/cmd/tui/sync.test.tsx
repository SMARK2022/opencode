/** @jsxImportSource @opentui/solid */
import { describe, expect, spyOn, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { Global } from "@opencode-ai/core/global"
import { tmpdir } from "../../../fixture/fixture"
import { createTuiPluginApi } from "../../../fixture/tui-plugin"
import { directory, json, mount, wait, worktree } from "./sync-fixture"
import type { TuiSlotPlugin } from "@opencode-ai/plugin/tui"
import type { AssistantMessage, GlobalEvent, Part, PermissionRequest, QuestionRequest, ToolPart } from "@opencode-ai/sdk/v2"
import type { JSX } from "solid-js"
import { internalTuiPlugins } from "@/cli/cmd/tui/plugin/internal"

function branchEvent(branch: string, workspace?: string): GlobalEvent {
  return {
    directory: "/tmp/other",
    project: "proj_test",
    workspace,
    payload: {
      id: `evt_vcs_${branch}`,
      type: "vcs.branch.updated",
      properties: { branch },
    },
  }
}

function serverConnectedEvent(id: string): GlobalEvent {
  return {
    directory: "global",
    payload: { id, type: "server.connected", properties: {} },
  }
}

function permissionAskedEvent(request: PermissionRequest): GlobalEvent {
  return {
    directory,
    project: "proj_test",
    payload: { id: `evt_${request.id}`, type: "permission.asked", properties: request },
  }
}

function questionAskedEvent(request: QuestionRequest): GlobalEvent {
  return {
    directory,
    project: "proj_test",
    payload: { id: `evt_${request.id}`, type: "question.asked", properties: request },
  }
}

function permissionRepliedEvent(request: PermissionRequest): GlobalEvent {
  return {
    directory,
    project: "proj_test",
    payload: {
      id: `evt_${request.id}_replied`,
      type: "permission.replied",
      properties: { sessionID: request.sessionID, requestID: request.id, reply: "once" },
    },
  }
}

function questionRejectedEvent(request: QuestionRequest): GlobalEvent {
  return {
    directory,
    project: "proj_test",
    payload: {
      id: `evt_${request.id}_rejected`,
      type: "question.rejected",
      properties: { sessionID: request.sessionID, requestID: request.id },
    },
  }
}

function permissionRequest(id: string): PermissionRequest {
  return {
    id,
    sessionID: "ses_1",
    permission: "edit",
    patterns: ["/tmp/opencode/**/*.ts"],
    metadata: { reason: "tool approval" },
    always: [],
    tool: { messageID: "msg_1", callID: "call_1" },
  }
}

function questionRequest(id: string): QuestionRequest {
  return {
    id,
    sessionID: "ses_1",
    questions: [
      {
        question: "Which file should I inspect first?",
        header: "Inspect",
        options: [{ label: "Sync", description: "Review the sync store." }],
        multiple: false,
      },
    ],
    tool: { messageID: "msg_1", callID: "call_question_1" },
  }
}

function assistantMessage(): AssistantMessage {
  return {
    id: "msg_1",
    sessionID: "ses_1",
    role: "assistant",
    time: { created: 1 },
    parentID: "user_1",
    modelID: "model",
    providerID: "provider",
    mode: "build",
    agent: "general",
    path: { cwd: directory, root: worktree },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  }
}

function pendingToolPart(id = "part_1", callID = "call_1"): ToolPart {
  return {
    id,
    sessionID: "ses_1",
    messageID: "msg_1",
    type: "tool",
    callID,
    tool: "apply_patch",
    state: { status: "pending", input: {}, raw: "" },
  }
}

function messageEvent(info: AssistantMessage): GlobalEvent {
  return {
    directory,
    project: "proj_test",
    payload: { id: "evt_message", type: "message.updated", properties: { sessionID: info.sessionID, info } },
  }
}

function partEvent(part: Part): GlobalEvent {
  return {
    directory,
    project: "proj_test",
    payload: { id: "evt_part", type: "message.part.updated", properties: { sessionID: part.sessionID, part, time: 1 } },
  }
}

function progressEvent(part: ToolPart): GlobalEvent {
  return {
    directory,
    project: "proj_test",
    payload: {
      id: `evt_progress_${part.id}`,
      type: "message.part.progress",
      properties: { sessionID: part.sessionID, part, time: Date.now() },
    },
  } as unknown as GlobalEvent
}

function runningShellPart(output: string, progressVersion?: number): ToolPart {
  return {
    id: "part_shell",
    sessionID: "ses_1",
    messageID: "msg_1",
    type: "tool",
    callID: "call_shell",
    tool: "bash",
    state: {
      status: "running",
      input: { command: "build" },
      time: { start: 1 },
      metadata: { output, description: "", ...(progressVersion === undefined ? {} : { progressVersion }) },
    },
  }
}

function completedShellPart(output: string): ToolPart {
  return {
    ...runningShellPart(output, 1),
    state: {
      status: "completed",
      input: { command: "build" },
      time: { start: 1, end: 2 },
      title: "",
      metadata: { output, description: "" },
      output,
    },
  }
}

// 构造 text part 测试 fixture，模拟 text-start 阶段的初始状态（text 可为空或短文本）
function textPart(id = "part_text", text = ""): Part {
  return {
    id,
    sessionID: "ses_1",
    messageID: "msg_1",
    type: "text",
    text,
    time: { start: 1 },
  } as Part
}

// 构造 reasoning part 测试 fixture，与 textPart 同构但 type 为 reasoning
function reasoningPart(id = "part_reasoning", text = ""): Part {
  return {
    id,
    sessionID: "ses_1",
    messageID: "msg_1",
    type: "reasoning",
    text,
    time: { start: 1 },
  } as Part
}

function deltaEvent(id: string, delta: string, partID = "part_1"): GlobalEvent {
  return {
    directory,
    project: "proj_test",
    payload: {
      id,
      type: "message.part.delta",
      properties: { sessionID: "ses_1", messageID: "msg_1", partID, field: "raw", delta },
    },
  }
}

// 构造 text delta 事件，模拟流式 token 到达（field="text"）
function textDeltaEvent(id: string, delta: string, partID = "part_text"): GlobalEvent {
  return {
    directory,
    project: "proj_test",
    payload: {
      id,
      type: "message.part.delta",
      properties: { sessionID: "ses_1", messageID: "msg_1", partID, field: "text", delta },
    },
  }
}

describe("tui sync", () => {
  test("projects bounded patch-free TUI data through HTTP and SSE", async () => {
    // 同一 public sync 覆盖两个 transport producer；任一 header 漏传都会恢复完整 payload。
    // HTTP fixture 故意返回 101 个带唯一 patch 的对象，证明 client-side cap 也守住测试/旧 daemon 边界。
    // totals headers 使用完整 101 项 worked values，不能由截断后的 store 重新计算冒充。
    const previous = Global.Path.state
    await using tmp = await tmpdir()
    Global.Path.state = tmp.path
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const messageProjections: string[] = []
    const diffProjections: string[] = []
    const message = assistantMessage()
    const visibleDiffs = Array.from({ length: 101 }, (_, index) => ({
      file: `http-${index}.ts`,
      patch: `http-patch-${index}`,
      additions: index + 1,
      deletions: index,
    }))
    // missing-file legacy 项放在首位；HTTP transport 模拟旧 daemon，client reducer仍须在cap前归一化。
    // server测试不能覆盖共享SSE和旧transport；此处故意让client直接接收raw source以锁定第二个producer。
    // 900/800不能进入预先算好的5151/5050，避免测试用实现同样的reduce重新生成expected值。
    const diffs = [{ patch: "legacy-patch", additions: 900, deletions: 800 }, ...visibleDiffs]
    const { app, emit, sync } = await mount((url, request, init) => {
      if (url.pathname === "/session/ses_1") return json({ id: "ses_1", time: { created: 1, updated: 1 }, directory })
      if (url.pathname === "/session/ses_1/messages" || url.pathname === "/session/ses_1/message") {
        const projection = request?.headers.get("x-opencode-tui-message-projection") ?? new Headers(init?.headers).get("x-opencode-tui-message-projection")
        if (projection) messageProjections.push(projection)
        return json([{ info: message, parts: [] }])
      }
      if (url.pathname === "/session/ses_1/todo") return json([])
      if (url.pathname === "/session/ses_1/diff") {
        const projection = request?.headers.get("x-opencode-tui-message-projection") ?? new Headers(init?.headers).get("x-opencode-tui-message-projection")
        if (projection) diffProjections.push(projection)
        return json(diffs, {
          headers: {
            "x-opencode-tui-total-files": "101",
            "x-opencode-tui-total-additions": "5151",
            "x-opencode-tui-total-deletions": "5050",
          },
        })
      }
    })

    try {
      await sync.session.sync("ses_1", { force: true })
      // 真实 SDK transport 同时锁定 Message 与 diff producer；只测 handler 无法捕获任一请求漏传。
      expect(messageProjections).toEqual(["viewer"])
      expect(diffProjections).toEqual(["viewer"])
      expect(sync.data.session_diff.ses_1).toHaveLength(100)
      expect(sync.data.session_diff.ses_1.every((item) => item.file !== undefined)).toBe(true)
      expect(sync.data.session_diff.ses_1.some((item) => item.patch !== undefined)).toBe(false)
      expect(sync.session.get("ses_1")?.summary).toEqual({ files: 101, additions: 5151, deletions: 5050 })

      // SSE producer 仍是完整共享事件；这里验证 TUI reducer 不会在 HTTP 修复后把 patch 和第 101 项重新灌回。
      // 每项固定 +2/-1，使 expected totals 202/101 与 HTTP totals 明确不同，防止断言误读旧状态。
      // 等待首文件切到 event 前缀是公开 store readiness，不使用 sleep 或内部 callback 次数。
      const eventDiffs = [
        { patch: "event-legacy-patch", additions: 700, deletions: 600 },
        ...visibleDiffs.map((item, index) => ({ ...item, file: `event-${index}.ts`, additions: 2, deletions: 1 })),
      ]
      emit({
        directory,
        project: "proj_test",
        payload: { id: "evt_diff", type: "session.diff", properties: { sessionID: "ses_1", diff: eventDiffs } },
      })
      await wait(() => sync.data.session_diff.ses_1?.[0]?.file === "event-0.ts")
      expect(sync.data.session_diff.ses_1).toHaveLength(100)
      expect(sync.data.session_diff.ses_1.every((item) => item.file !== undefined)).toBe(true)
      expect(sync.data.session_diff.ses_1.some((item) => item.patch !== undefined)).toBe(false)
      expect(sync.session.get("ses_1")?.summary).toEqual({ files: 101, additions: 202, deletions: 101 })

      // Revert的真实顺序是normalized session.diff后跟完整session.updated；后者只能更新普通Session metadata。
      // raw summary刻意计入missing-file项，若reducer整对象替换就会重新制造false ellipsis。
      // title必须更新而summary必须保留，这两个断言共同防止实现简单丢弃整个session.updated事件。
      // 该顺序与Summary的updated后diff相反，故测试必须在同一公开event stream连续发出两类事件。
      emit({
        directory,
        project: "proj_test",
        payload: {
          id: "evt_session_after_diff",
          type: "session.updated",
          properties: {
            sessionID: "ses_1",
            info: {
              id: "ses_1",
              slug: "reverted",
              projectID: "proj_test",
              title: "reverted",
              version: "1.0.0",
              time: { created: 1, updated: 2 },
              directory,
              summary: { files: 102, additions: 902, deletions: 701 },
            },
          },
        },
      })
      await wait(() => sync.session.get("ses_1")?.title === "reverted")
      expect(sync.session.get("ses_1")?.summary).toEqual({ files: 101, additions: 202, deletions: 101 })
    } finally {
      app.renderer.destroy()
      Global.Path.state = previous
    }
  })

  test("renders bounded Files rows with a final ellipsis", async () => {
    // 从 internal plugin registry 取得 production View，避免为了测试导出私有组件或复制 JSX。
    // 100 visible rows + total 101 是最小真实 truncation；total=100 时同一 View 不应产生省略号。
    const plugin = internalTuiPlugins({ experimentalEventSystem: false }).find(
      (candidate) => candidate.id === "internal:sidebar-files",
    )
    if (!plugin) throw new Error("Files sidebar plugin was not registered")
    const diffs = Array.from({ length: 100 }, (_, index) => ({
      file: `file-${index}.ts`,
      additions: index + 1,
      deletions: index,
    }))
    let totalFiles = 101
    let currentDiffs = diffs
    const api = createTuiPluginApi({
      state: {
        session: {
          get: () => ({
            id: "ses_1",
            slug: "files",
            projectID: "proj_test",
            directory,
            title: "files",
            version: "1.0.0",
            summary: { files: totalFiles, additions: 5151, deletions: 5050 },
            time: { created: 1, updated: 1 },
          }),
          diff: () => currentDiffs,
        },
      },
    })
    let view: (() => JSX.Element) | undefined
    function capture(definition: TuiSlotPlugin): string
    function capture<Slots extends Record<string, object>>(definition: TuiSlotPlugin<Slots>): string
    function capture(definition: TuiSlotPlugin) {
      // 只通过 plugin 的公开 slot registration seam 捕获 renderer，不断言注册次数或私有 id 分派。
      const content = definition.slots.sidebar_content
      if (content) view = () => content({ theme: api.theme }, { session_id: "ses_1" })
      return "files-test"
    }
    const register = spyOn(api.slots, "register").mockImplementation(capture)
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
    if (!view) throw new Error("Files sidebar plugin did not register its content slot")

    const app = await testRender(view, { width: 60, height: 110, footerHeight: 0, useThread: false })
    try {
      await app.renderOnce()
      const frame = app.captureCharFrame()
      const lines = frame.split("\n").map((line) => line.trim())
      // 默认展开语义必须保留；首尾文件共同证明列表不是 aggregate-only 或默认折叠。
      // 省略号按独立 frame row 断言，禁止实现把它粘到第 100 个文件名或标题。
      // forbidden phrase 直接来自用户要求，防止高信息量 title 被固定解释文案稀释。
      expect(frame).toContain("Modified Files")
      expect(frame).toContain("(101)")
      expect(frame).toContain("+5151")
      expect(frame).toContain("-5050")
      expect(frame).toContain("file-0.ts")
      expect(frame).toContain("file-99.ts")
      expect(lines).toContain("...")
      expect(frame).not.toContain("showing first 100")
    } finally {
      app.renderer.destroy()
    }

    // Session先到、diff尚未发布时不能把空列表误报成截断；恰好100项同样没有省略号。
    currentDiffs = []
    const pending = await testRender(view, { width: 60, height: 8, footerHeight: 0, useThread: false })
    try {
      await pending.renderOnce()
      expect(pending.captureCharFrame().split("\n").map((line) => line.trim())).not.toContain("...")
    } finally {
      pending.renderer.destroy()
    }
    totalFiles = 100
    currentDiffs = diffs
    const exact = await testRender(view, { width: 60, height: 110, footerHeight: 0, useThread: false })
    try {
      await exact.renderOnce()
      const frame = exact.captureCharFrame()
      expect(frame).toContain("file-99.ts")
      expect(frame.split("\n").map((line) => line.trim())).not.toContain("...")
    } finally {
      exact.renderer.destroy()
    }
  })

  test("publishes session history before starting the TUI diff request", async () => {
    // messages readiness 与 diff start 是两个明确 latch；旧 Promise.all 会在第一个 latch 释放前启动 diff。
    // diff handler读取公开 sync store，证明 history 已提交，而不是仅证明 messages HTTP 已 resolve。
    // delayed diff 保持 sync 未完成，确保测试观察的是中间首屏状态而非最终批量结果。
    const previous = Global.Path.state
    await using tmp = await tmpdir()
    Global.Path.state = tmp.path
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const delayedMessages = Promise.withResolvers<Response>()
    const delayedDiff = Promise.withResolvers<Response>()
    let messagesStarted = false
    let diffStarted = false
    let historyVisibleWhenDiffStarted = false
    const message = assistantMessage()
    const mounted = await mount((url) => {
      if (url.pathname === "/session/ses_1") return json({ id: "ses_1", time: { created: 1, updated: 1 }, directory })
      if (url.pathname === "/session/ses_1/messages" || url.pathname === "/session/ses_1/message") {
        messagesStarted = true
        return delayedMessages.promise
      }
      if (url.pathname === "/session/ses_1/todo") return json([])
      if (url.pathname === "/session/ses_1/diff") {
        diffStarted = true
        historyVisibleWhenDiffStarted = mounted.sync.data.message.ses_1?.some((item) => item.id === message.id) === true
        return delayedDiff.promise
      }
      if (url.pathname === "/session/status") return json({})
    })

    try {
      const syncing = mounted.sync.session.sync("ses_1", { force: true })
      await wait(() => messagesStarted)
      expect(diffStarted).toBe(false)
      delayedMessages.resolve(json([{ info: message, parts: [] }]))
      await wait(() => diffStarted)
      expect(historyVisibleWhenDiffStarted).toBe(true)
      delayedDiff.resolve(json([]))
      await syncing
    } finally {
      delayedMessages.resolve(json([{ info: message, parts: [] }]))
      delayedDiff.resolve(json([]))
      mounted.app.renderer.destroy()
      Global.Path.state = previous
    }
  })

  test("preserves resolved and rejected diff error semantics after history publication", async () => {
    // ses_1 锁定 generated SDK 的 resolved HTTP error 兼容：空 diff 是既有成功语义并允许 full-sync short circuit。
    // ses_2 锁定 genuine JSON parse rejection；独立 Session 避免前一次成功的 full-sync 标记污染失败结论。
    // 两种错误都在真实 SDK fetch/parse seam 产生，不注入假的 rejected client method。
    const previous = Global.Path.state
    await using tmp = await tmpdir()
    Global.Path.state = tmp.path
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const message = assistantMessage()
    const malformedMessage = { ...assistantMessage(), id: "msg_2", sessionID: "ses_2" }
    let diffRequests = 0
    const { app, sync } = await mount((url) => {
      const id = url.pathname.match(/^\/session\/(ses_[12])(?:\/(?:messages|message|todo|diff))?$/)?.[1]
      if (!id) return
      if (url.pathname === `/session/${id}`)
        return json({
          id,
          time: { created: 1, updated: 1 },
          directory,
          summary: id === "ses_1" ? { files: 101, additions: 5151, deletions: 5050 } : undefined,
        })
      if (url.pathname === `/session/${id}/messages` || url.pathname === `/session/${id}/message`)
        return json([{ info: id === "ses_1" ? message : malformedMessage, parts: [] }])
      if (url.pathname === `/session/${id}/todo`) return json([])
      if (url.pathname === `/session/${id}/diff`) {
        diffRequests += 1
        if (id === "ses_1") return json({ error: "diff unavailable" }, { status: 500 })
        return new Response("{", { status: 200, headers: { "content-type": "application/json" } })
      }
    })

    try {
      await sync.session.sync("ses_1", { force: true })
      expect(sync.data.session_diff.ses_1).toEqual([])
      // resolved error 的当前 source 是既有 `data ?? []`；rows与totals必须一起清空，不能保留旧summary制造假省略号。
      expect(sync.session.get("ses_1")?.summary).toEqual({ files: 0, additions: 0, deletions: 0 })
      await sync.session.sync("ses_1")
      expect(diffRequests).toBe(1)

      await expect(sync.session.sync("ses_2", { force: true })).rejects.toBeInstanceOf(SyntaxError)
      // history 已在 parse failure 前可见，证明 barrier 修复没有通过吞错或 fire-and-forget 获得首屏。
      expect(sync.data.message.ses_2?.some((item) => item.id === malformedMessage.id)).toBe(true)
      await expect(sync.session.sync("ses_2")).rejects.toBeInstanceOf(SyntaxError)
      expect(diffRequests).toBe(3)
    } finally {
      app.renderer.destroy()
      Global.Path.state = previous
    }
  })

  test("projects active Session Message and Part events across Projects", async () => {
    const previous = Global.Path.state
    await using tmp = await tmpdir()
    Global.Path.state = tmp.path
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const message = assistantMessage()
    const part = textPart("part_cross_project", "streamed")
    const { app, emit, sync } = await mount(undefined, { type: "session", sessionID: "ses_1" })

    try {
      // daemon 事件携带 Session 实际 Project，而 TUI 可能从另一个启动 Project 打开该 Session。
      // 两类事件都必须穿过 useEvent 后进入同一个活动 Session projection，不能只验证 callback 到达。
      // message.updated 验证消息索引，part.updated 验证消息下的 part 索引；两者共同覆盖渲染数据源。
      // route 固定为 ses_1，故测试失败时可以区分 event admission 与 projection reducer 问题。
      emit({ ...messageEvent(message), project: "proj_session_owner" })
      emit({ ...partEvent(part), project: "proj_session_owner" })
      await wait(() => sync.data.message.ses_1?.some((item) => item.id === message.id))
      await wait(() => sync.data.part[message.id]?.some((item) => item.id === part.id))

      expect(sync.data.message.ses_1).toContainEqual(message)
      expect(sync.data.part[message.id]).toContainEqual(part)
    } finally {
      app.renderer.destroy()
      Global.Path.state = previous
    }
  })

  test("projects LSP status through the active Session route and rejects a late response", async () => {
    const [sessionA, sessionB] = [{ id: "ses_lsp_a", directory: "/workspace/a", workspaceID: "wrk_a", time: { created: 1, updated: 1 } }, { id: "ses_lsp_b", directory: "/workspace/b", workspaceID: "wrk_b", time: { created: 1, updated: 1 } }]
    const requests: Array<{ directory: string | null; workspace: string | null }> = []
    const delayedA = Promise.withResolvers<void>(), delayedB = Promise.withResolvers<void>()
    let refreshA = false
    const { app, emit, route, sync } = await mount((url) => {
        if (url.pathname === "/session") return json([sessionA, sessionB])
        if (url.pathname !== "/lsp") return
        return (async () => {
          requests.push({ directory: url.searchParams.get("directory"), workspace: url.searchParams.get("workspace") })
          if (url.searchParams.get("directory") === sessionA.directory) {
            if (refreshA) await delayedA.promise
            return json([{ id: "typescript", name: "typescript", root: "a", status: "connected", sessionIDs: [sessionA.id] }])
          }
          await delayedB.promise
          return json([{ id: "typescript", name: "typescript", root: "b", status: "connected", sessionIDs: [sessionB.id] }])
        })()
    }, { type: "session", sessionID: sessionA.id })

    try {
      await wait(() => sync.data.lsp[0]?.root === "a")
      refreshA = true
      // project 不同的 LSP invalidation 仍须进入当前 route 的唯一 refresh。
      emit({ directory: sessionA.directory, project: "proj_b", payload: { id: "evt_lsp_a", type: "lsp.updated", properties: {} } })
      await wait(() => requests.filter((request) => request.directory === sessionA.directory).length === 2)

      route.navigate({ type: "session", sessionID: sessionB.id })
      await wait(() => requests.some((request) => request.directory === sessionB.directory))
      // B 响应仍被阻塞时，route owner 已变化；旧 A snapshot 必须同步失效，
      // 否则 sidebar/footer 会继续把 A 的 LSP 显示在 B 下。
      expect(sync.data.lsp).toEqual([])
      expect(requests).toContainEqual({ directory: sessionB.directory, workspace: sessionB.workspaceID })
      delayedB.resolve()
      await wait(() => sync.data.lsp[0]?.root === "b")

      delayedA.resolve()
      await wait(() => sync.data.lsp[0]?.root === "b")

      route.navigate({ type: "home" })
      await wait(() => sync.data.lsp.length === 0)
    } finally {
      delayedA.resolve()
      delayedB.resolve()
      app.renderer.destroy()
    }
  })

  test("recovers pending permission and question requests after reconnect", async () => {
    const previous = Global.Path.state
    await using tmp = await tmpdir()
    Global.Path.state = tmp.path
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    let reconnected = false
    const permission = permissionRequest("perm_1")
    const question = questionRequest("question_1")
    const { app, emit, sync } = await mount((url) => {
      if (url.pathname === "/permission") return json(reconnected ? [permission] : [])
      if (url.pathname === "/question") return json(reconnected ? [question] : [])
    })

    try {
      expect(sync.data.permission.ses_1).toBeUndefined()
      expect(sync.data.question.ses_1).toBeUndefined()

      // The first server.connected marks the initial SSE attachment; only later
      // connected events represent reconnects that should force a bootstrap.
      emit(serverConnectedEvent("evt_connected_initial"))
      await Bun.sleep(30)
      reconnected = true
      emit(serverConnectedEvent("evt_connected_reconnect"))

      await wait(() => sync.data.permission.ses_1?.[0]?.id === permission.id)
      await wait(() => sync.data.question.ses_1?.[0]?.id === question.id)

      expect(sync.data.permission.ses_1).toEqual([permission])
      expect(sync.data.question.ses_1).toEqual([question])
    } finally {
      app.renderer.destroy()
      Global.Path.state = previous
    }
  })

  test("keeps asked events that arrive while reconnect snapshots are in flight", async () => {
    const previous = Global.Path.state
    await using tmp = await tmpdir()
    Global.Path.state = tmp.path
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    let reconnected = false
    const permission = permissionRequest("perm_race")
    const question = questionRequest("question_race")
    let permissionSnapshots = 0
    let questionSnapshots = 0
    let stalePermissionSnapshot: (() => void) | undefined
    let staleQuestionSnapshot: (() => void) | undefined
    const { app, emit, sync } = await mount((url) => {
      if (url.pathname === "/permission") {
        if (!reconnected) return json([])
        permissionSnapshots += 1
        if (permissionSnapshots > 1) return json([permission])
        return new Promise<Response>((resolve) => {
          stalePermissionSnapshot = () => resolve(json([]))
        })
      }
      if (url.pathname === "/question") {
        if (!reconnected) return json([])
        questionSnapshots += 1
        if (questionSnapshots > 1) return json([question])
        return new Promise<Response>((resolve) => {
          staleQuestionSnapshot = () => resolve(json([]))
        })
      }
    })

    try {
      emit(serverConnectedEvent("evt_connected_initial"))
      await Bun.sleep(30)
      reconnected = true
      emit(serverConnectedEvent("evt_connected_reconnect"))
      await wait(() => Boolean(stalePermissionSnapshot && staleQuestionSnapshot))

      emit(permissionAskedEvent(permission))
      emit(questionAskedEvent(question))
      await wait(() => sync.data.permission.ses_1?.[0]?.id === permission.id)
      await wait(() => sync.data.question.ses_1?.[0]?.id === question.id)

      if (!stalePermissionSnapshot || !staleQuestionSnapshot) throw new Error("reconnect snapshots were not requested")
      stalePermissionSnapshot()
      staleQuestionSnapshot()
      await Bun.sleep(30)

      expect(sync.data.permission.ses_1).toEqual([permission])
      expect(sync.data.question.ses_1).toEqual([question])
    } finally {
      app.renderer.destroy()
      Global.Path.state = previous
    }
  })

  test("clears requests that are absent from reconnect snapshots", async () => {
    const previous = Global.Path.state
    await using tmp = await tmpdir()
    Global.Path.state = tmp.path
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const permission = permissionRequest("perm_cleared")
    const question = questionRequest("question_cleared")
    const { app, emit, sync } = await mount()

    try {
      emit(serverConnectedEvent("evt_connected_initial"))
      await Bun.sleep(30)
      emit(permissionAskedEvent(permission))
      emit(questionAskedEvent(question))
      await wait(() => sync.data.permission.ses_1?.[0]?.id === permission.id)
      await wait(() => sync.data.question.ses_1?.[0]?.id === question.id)

      emit(serverConnectedEvent("evt_connected_reconnect"))

      await wait(() => sync.data.permission.ses_1 === undefined && sync.data.question.ses_1 === undefined)
      expect(sync.data.permission.ses_1).toBeUndefined()
      expect(sync.data.question.ses_1).toBeUndefined()
    } finally {
      app.renderer.destroy()
      Global.Path.state = previous
    }
  })

  test("keeps replied events that arrive while reconnect snapshots are in flight", async () => {
    const previous = Global.Path.state
    await using tmp = await tmpdir()
    Global.Path.state = tmp.path
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    let reconnected = false
    const permission = permissionRequest("perm_reply_race")
    const question = questionRequest("question_reply_race")
    let permissionSnapshots = 0
    let questionSnapshots = 0
    let stalePermissionSnapshot: (() => void) | undefined
    let staleQuestionSnapshot: (() => void) | undefined
    const { app, emit, sync } = await mount((url) => {
      if (url.pathname === "/permission") {
        if (!reconnected) return json([])
        permissionSnapshots += 1
        if (permissionSnapshots > 1) return json([])
        return new Promise<Response>((resolve) => {
          stalePermissionSnapshot = () => resolve(json([permission]))
        })
      }
      if (url.pathname === "/question") {
        if (!reconnected) return json([])
        questionSnapshots += 1
        if (questionSnapshots > 1) return json([])
        return new Promise<Response>((resolve) => {
          staleQuestionSnapshot = () => resolve(json([question]))
        })
      }
    })

    try {
      emit(serverConnectedEvent("evt_connected_initial"))
      await Bun.sleep(30)
      emit(permissionAskedEvent(permission))
      emit(questionAskedEvent(question))
      await wait(() => sync.data.permission.ses_1?.[0]?.id === permission.id)
      await wait(() => sync.data.question.ses_1?.[0]?.id === question.id)

      reconnected = true
      emit(serverConnectedEvent("evt_connected_reconnect"))
      await wait(() => Boolean(stalePermissionSnapshot && staleQuestionSnapshot))

      emit(permissionRepliedEvent(permission))
      emit(questionRejectedEvent(question))
      await wait(() => (sync.data.permission.ses_1?.length ?? 0) === 0 && (sync.data.question.ses_1?.length ?? 0) === 0)

      if (!stalePermissionSnapshot || !staleQuestionSnapshot) throw new Error("reconnect snapshots were not requested")
      stalePermissionSnapshot()
      staleQuestionSnapshot()
      await Bun.sleep(30)

      expect(sync.data.permission.ses_1 ?? []).toEqual([])
      expect(sync.data.question.ses_1 ?? []).toEqual([])
    } finally {
      app.renderer.destroy()
      Global.Path.state = previous
    }
  })

  test("clears stale requests while preserving rapid asked events during reconnect recovery", async () => {
    const previous = Global.Path.state
    await using tmp = await tmpdir()
    Global.Path.state = tmp.path
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    let reconnected = false
    const stale = permissionRequest("perm_stale")
    const liveFirst = permissionRequest("perm_live_1")
    const liveSecond = permissionRequest("perm_live_2")
    let staleSnapshot: (() => void) | undefined
    const { app, emit, sync } = await mount((url) => {
      if (url.pathname !== "/permission") return
      if (!reconnected) return json([])
      if (staleSnapshot) return new Promise<Response>(() => {})
      return new Promise<Response>((resolve) => {
        staleSnapshot = () => resolve(json([]))
      })
    })

    try {
      emit(serverConnectedEvent("evt_connected_initial"))
      await Bun.sleep(30)
      emit(permissionAskedEvent(stale))
      await wait(() => sync.data.permission.ses_1?.[0]?.id === stale.id)

      reconnected = true
      emit(serverConnectedEvent("evt_connected_reconnect"))
      await wait(() => Boolean(staleSnapshot))

      emit(permissionAskedEvent(liveFirst))
      await wait(() => sync.data.permission.ses_1?.some((request) => request.id === liveFirst.id))
      if (!staleSnapshot) throw new Error("reconnect snapshot was not requested")
      staleSnapshot()
      emit(permissionAskedEvent(liveSecond))
      await wait(() => sync.data.permission.ses_1?.some((request) => request.id === liveSecond.id))

      await wait(() => !sync.data.permission.ses_1?.some((request) => request.id === stale.id))
      expect(sync.data.permission.ses_1?.map((request) => request.id)).toEqual([liveFirst.id, liveSecond.id])
    } finally {
      app.renderer.destroy()
      Global.Path.state = previous
    }
  })

  test("keeps the newest reconnect snapshot when an earlier snapshot resolves last", async () => {
    const previous = Global.Path.state
    await using tmp = await tmpdir()
    Global.Path.state = tmp.path
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    let reconnected = false
    let permissionSnapshots = 0
    let questionSnapshots = 0
    let stalePermissionSnapshot: (() => void) | undefined
    let staleQuestionSnapshot: (() => void) | undefined
    const permission = permissionRequest("perm_latest")
    const question = questionRequest("question_latest")
    const { app, emit, sync } = await mount((url) => {
      if (url.pathname === "/permission") {
        if (!reconnected) return json([])
        permissionSnapshots += 1
        if (permissionSnapshots > 1) return json([permission])
        return new Promise<Response>((resolve) => {
          stalePermissionSnapshot = () => resolve(json([]))
        })
      }
      if (url.pathname === "/question") {
        if (!reconnected) return json([])
        questionSnapshots += 1
        if (questionSnapshots > 1) return json([question])
        return new Promise<Response>((resolve) => {
          staleQuestionSnapshot = () => resolve(json([]))
        })
      }
    })

    try {
      emit(serverConnectedEvent("evt_connected_initial"))
      await Bun.sleep(30)
      reconnected = true
      emit(serverConnectedEvent("evt_connected_reconnect_1"))
      await wait(() => Boolean(stalePermissionSnapshot && staleQuestionSnapshot))
      emit(serverConnectedEvent("evt_connected_reconnect_2"))

      await wait(() => sync.data.permission.ses_1?.[0]?.id === permission.id)
      await wait(() => sync.data.question.ses_1?.[0]?.id === question.id)

      if (!stalePermissionSnapshot || !staleQuestionSnapshot) throw new Error("stale reconnect snapshots were not requested")
      stalePermissionSnapshot()
      staleQuestionSnapshot()
      await Bun.sleep(30)

      expect(sync.data.permission.ses_1).toEqual([permission])
      expect(sync.data.question.ses_1).toEqual([question])
    } finally {
      app.renderer.destroy()
      Global.Path.state = previous
    }
  })

  test("refresh scopes sessions by default and lists project sessions when disabled", async () => {
    const previous = Global.Path.state
    await using tmp = await tmpdir()
    Global.Path.state = tmp.path
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const { app, kv, sync, session } = await mount()

    try {
      expect(kv.get("session_directory_filter_enabled", true)).toBe(true)
      expect(session.at(-1)?.searchParams.get("scope")).toBeNull()
      expect(session.at(-1)?.searchParams.get("path")).toBe("packages/opencode")
      // Path A：半年 lookback + browse limit 1600（与 session-list-params 对齐）
      expect(session.at(-1)?.searchParams.get("limit")).toBe("1600")
      const start = Number(session.at(-1)?.searchParams.get("start"))
      const lookback = 180 * 24 * 60 * 60 * 1000
      expect(start).toBeGreaterThan(Date.now() - lookback - 60_000)
      expect(start).toBeLessThanOrEqual(Date.now() - lookback + 60_000)

      kv.set("session_directory_filter_enabled", false)
      await sync.session.refresh()

      expect(session.at(-1)?.searchParams.get("scope")).toBe("project")
      expect(session.at(-1)?.searchParams.get("path")).toBeNull()
      expect(session.at(-1)?.searchParams.get("limit")).toBe("1600")
    } finally {
      app.renderer.destroy()
      Global.Path.state = previous
    }
  })

  test("vcs branch updates only apply for the active workspace", async () => {
    const previous = Global.Path.state
    await using tmp = await tmpdir()
    Global.Path.state = tmp.path
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const { app, emit, project, sync } = await mount()

    try {
      expect(sync.data.vcs?.branch).toBe("main")

      project.workspace.set("ws_a")
      emit(branchEvent("other", "ws_b"))
      await Bun.sleep(30)

      expect(sync.data.vcs?.branch).toBe("main")

      emit(branchEvent("feature", "ws_a"))
      await wait(() => sync.data.vcs?.branch === "feature")

      expect(sync.data.vcs?.branch).toBe("feature")
    } finally {
      app.renderer.destroy()
      Global.Path.state = previous
    }
  })

  test("applies queued streaming part deltas to the sync store", async () => {
    const previous = Global.Path.state
    await using tmp = await tmpdir()
    Global.Path.state = tmp.path
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const logs: Array<{ extra?: Record<string, unknown> }> = []
    const { app, emit, sync } = await mount((url, request, init) => {
      if (url.pathname !== "/log") return
      // /log 失败模拟 daemon log 写入不可用；同步 reducer 仍必须应用 delta，
      // 且日志 payload 不能携带 delta 正文或其他流式内容。
      return (request ?? new Request(url, init)).text().then((body) => {
        logs.push(JSON.parse(body))
        throw new Error("log endpoint unavailable")
      })
    })

    try {
      // delta 在 part 创建前到达（模拟 fire-and-forget 竞态），被缓冲而非永久丢弃
      emit(deltaEvent("delta_missing", "secret"))
      await wait(() => logs.some((entry) => entry.extra?.phase === "delta.drop"))

      emit(messageEvent(assistantMessage()))
      emit(partEvent(pendingToolPart()))
      await wait(() => sync.data.part.msg_1?.[0]?.id === "part_1")

      emit(deltaEvent("delta_1", "hel"))
      emit(deltaEvent("delta_2", "lo"))
      emit(deltaEvent("delta_3", " world"))

      // 缓冲的 "secret" 在 part 创建时被 replay，所以 raw = "secret" + "hello world"
      await wait(
        () =>
          sync.data.part.msg_1?.[0]?.type === "tool" &&
          sync.data.part.msg_1[0].state.status === "pending" &&
          sync.data.part.msg_1[0].state.raw === "secrethello world",
      )
      await wait(() => logs.some((entry) => entry.extra?.phase === "delta.apply"))
      expect(sync.data.part.msg_1?.[0]).toMatchObject({ state: { raw: "secrethello world" } })
      const phases = logs.map((entry) => entry.extra?.phase)
      expect(phases.filter((phase) => phase === "delta.receive")).toHaveLength(1)
      expect(phases).toContain("delta.drop")
      expect(phases).toContain("delta.apply")
      // 日志 payload 不携带 delta 正文
      expect(JSON.stringify(logs)).not.toContain("hello world")
      expect(JSON.stringify(logs)).not.toContain("secret")
    } finally {
      app.renderer.destroy()
      Global.Path.state = previous
    }
  })

  test("flushes queued part deltas before non-delta event boundaries", async () => {
    const previous = Global.Path.state
    await using tmp = await tmpdir()
    Global.Path.state = tmp.path
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const { app, emit, sync } = await mount()

    try {
      emit(messageEvent(assistantMessage()))
      emit(partEvent(pendingToolPart()))
      emit(partEvent(pendingToolPart("part_2", "call_2")))
      await wait(() => sync.data.part.msg_1?.length === 2)

      emit(deltaEvent("delta_1", "a"))
      emit(deltaEvent("delta_2", "b", "part_2"))
      emit(deltaEvent("delta_3", "c"))
      emit(branchEvent("flush"))

      await wait(
        () =>
          sync.data.part.msg_1?.[0]?.type === "tool" &&
          sync.data.part.msg_1[0].state.status === "pending" &&
          sync.data.part.msg_1[0].state.raw === "ac" &&
          sync.data.part.msg_1[1]?.type === "tool" &&
          sync.data.part.msg_1[1].state.status === "pending" &&
          sync.data.part.msg_1[1].state.raw === "b",
      )
      expect(sync.data.vcs?.branch).toBe("flush")
    } finally {
      app.renderer.destroy()
      Global.Path.state = previous
    }
  })

  // 验证 session.sync HTTP 快照路径：delta 累积 "hello world" 后，
  // 强制重新拉取返回 DB 中的短快照 "hello " — mergeLiveParts 必须保留本地长文本。
  // 随后终态 part.updated（带 time.end）到达时，必须接受权威最终值 "final"。
  test("preserves streaming text when a stale session sync snapshot arrives", async () => {
    const previous = Global.Path.state
    await using tmp = await tmpdir()
    Global.Path.state = tmp.path
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const message = assistantMessage()
    const stalePart = textPart("part_text", "hello ")
    const { app, emit, sync } = await mount((url) => {
      if (url.pathname === "/session/ses_1") return json({ id: "ses_1", time: { created: 1, updated: 1 }, directory })
      if (url.pathname === "/session/ses_1/messages") return json([{ info: message, parts: [stalePart] }])
      if (url.pathname === "/session/ses_1/todo") return json([])
      if (url.pathname === "/session/ses_1/diff") return json([])
    })

    try {
      emit(messageEvent(message))
      emit(partEvent(stalePart))
      await wait(() => sync.data.part.msg_1?.[0]?.type === "text" && sync.data.part.msg_1[0].text === "hello ")

      emit(textDeltaEvent("delta_text", "world"))
      await wait(() => sync.data.part.msg_1?.[0]?.type === "text" && sync.data.part.msg_1[0].text === "hello world")

      await sync.session.sync("ses_1", { force: true })

      expect(sync.data.part.msg_1?.[0]).toMatchObject({ type: "text", text: "hello world" })

      emit(partEvent({ ...stalePart, text: "final", time: { start: 1, end: 2 } } as Part))
      await wait(() => sync.data.part.msg_1?.[0]?.type === "text" && sync.data.part.msg_1[0].text === "final")
      expect(sync.data.part.msg_1?.[0]).toMatchObject({ type: "text", text: "final" })
    } finally {
      app.renderer.destroy()
      Global.Path.state = previous
    }
  })

  // 验证 reasoning part 的 session.sync 快照路径：与 text 同构，
  // delta 累积 "step two" 后强制重拉返回短快照 "step " — 必须保留本地长文本。
  test("preserves streaming reasoning when a stale session sync snapshot arrives", async () => {
    const previous = Global.Path.state
    await using tmp = await tmpdir()
    Global.Path.state = tmp.path
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const message = assistantMessage()
    const stalePart = reasoningPart("part_reasoning", "step ")
    const { app, emit, sync } = await mount((url) => {
      if (url.pathname === "/session/ses_1") return json({ id: "ses_1", time: { created: 1, updated: 1 }, directory })
      if (url.pathname === "/session/ses_1/messages") return json([{ info: message, parts: [stalePart] }])
      if (url.pathname === "/session/ses_1/todo") return json([])
      if (url.pathname === "/session/ses_1/diff") return json([])
    })

    try {
      emit(messageEvent(message))
      emit(partEvent(stalePart))
      await wait(() => sync.data.part.msg_1?.[0]?.type === "reasoning" && sync.data.part.msg_1[0].text === "step ")

      emit(textDeltaEvent("delta_reasoning", "two", "part_reasoning"))
      await wait(() => sync.data.part.msg_1?.[0]?.type === "reasoning" && sync.data.part.msg_1[0].text === "step two")

      await sync.session.sync("ses_1", { force: true })

      expect(sync.data.part.msg_1?.[0]).toMatchObject({ type: "reasoning", text: "step two" })
    } finally {
      app.renderer.destroy()
      Global.Path.state = previous
    }
  })

  test("keeps shell progress monotonic across legacy session sync snapshots", async () => {
    const previous = Global.Path.state
    await using tmp = await tmpdir()
    Global.Path.state = tmp.path
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const message = assistantMessage()
    const legacy = runningShellPart("legacy")
    const { app, emit, sync } = await mount((url) => {
      if (url.pathname === "/session/ses_1") return json({ id: "ses_1", time: { created: 1, updated: 1 }, directory })
      if (url.pathname === "/session/ses_1/messages") return json([{ info: message, parts: [legacy] }])
      if (url.pathname === "/session/ses_1/todo") return json([])
      if (url.pathname === "/session/ses_1/diff") return json([])
    })

    try {
      emit(messageEvent(message))
      // 缺失版本的旧 SQLite running Part 归一化为 v0；本地无该 Part 时必须接受，
      // 否则升级后的 client 无法恢复最近 durable display。
      emit(partEvent(legacy))
      await wait(() => sync.data.part.msg_1?.[0]?.type === "tool")
      expect(sync.data.part.msg_1?.[0]).toMatchObject({ state: { status: "running", metadata: { output: "legacy" } } })

      emit(progressEvent(runningShellPart("live", 1)))
      await wait(
        () =>
          sync.data.part.msg_1?.[0]?.type === "tool" &&
          sync.data.part.msg_1[0].state.status === "running" &&
          sync.data.part.msg_1[0].state.metadata?.output === "live",
      )
      // force sync 模拟 server.connected 后的真实 HTTP recovery，而不是只验证 SSE 顺序。
      // 旧 v0 在 live v1 之后到达时必须保持最新显示，不能因 reconnect 重新闪回。
      // 后到 HTTP legacy v0 不得覆盖 live v1；terminal 一旦到达，任何 running
      // 快照都不得把界面恢复为执行中。
      await sync.session.sync("ses_1", { force: true })
      expect(sync.data.part.msg_1?.[0]).toMatchObject({ state: { status: "running", metadata: { output: "live" } } })

      emit(partEvent(completedShellPart("done")))
      await wait(
        () =>
          sync.data.part.msg_1?.[0]?.type === "tool" && sync.data.part.msg_1[0].state.status === "completed",
      )
      await sync.session.sync("ses_1", { force: true })
      expect(sync.data.part.msg_1?.[0]).toMatchObject({ state: { status: "completed", output: "done" } })
    } finally {
      app.renderer.destroy()
      Global.Path.state = previous
    }
  })

  test("enriches equal-v0 bash running from raw-only autoReview to structured command", async () => {
    const previous = Global.Path.state
    await using tmp = await tmpdir()
    Global.Path.state = tmp.path
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const message = assistantMessage()
    const command = "git push origin dev"
    // equal-v0 生命周期：先到 reviewing raw-only 不得永久挡住后到 structured command，
    // 且 autoReview envelope 必须保留（否则会出现 Writing command... 或丢审核行）。
    // 旧 merge 整对象 keep first：command 永久缺失；本用例必须在修复前红、修复后绿。
    // progressVersion 均缺省 → legacy v0，触发字段 enrich 而非 progress 前进分支。
    const reviewingRaw = {
      ...runningShellPart(""),
      state: {
        status: "running" as const,
        input: { raw: JSON.stringify({ command, description: "Push branch" }) },
        title: "Auto review: cautious",
        metadata: {
          autoReview: {
            reviewID: "review_raw",
            status: "reviewing",
            precheck: { level: "cautious", reason: "push requires review" },
          },
        },
        time: { start: 1 },
      },
    } satisfies ToolPart
    const structured = {
      ...reviewingRaw,
      state: {
        status: "running" as const,
        input: { command, description: "Push branch" },
        time: { start: 2 },
      },
    } satisfies ToolPart
    const { app, emit, sync } = await mount()

    try {
      emit(messageEvent(message))
      emit(partEvent(reviewingRaw))
      await wait(() => {
        const part = sync.data.part.msg_1?.[0]
        if (part?.type !== "tool" || part.state.status !== "running") return false
        const review = (part.state.metadata as { autoReview?: { status?: string } } | undefined)?.autoReview
        return review?.status === "reviewing"
      })

      emit(partEvent(structured))
      await Bun.sleep(30)

      expect(sync.data.part.msg_1?.[0]).toMatchObject({
        state: {
          status: "running",
          input: { command },
          metadata: { autoReview: { status: "reviewing" } },
        },
      })
    } finally {
      app.renderer.destroy()
      Global.Path.state = previous
    }
  })

  test("enriches equal-v0 bash running autoReview without dropping structured command", async () => {
    const previous = Global.Path.state
    await using tmp = await tmpdir()
    Global.Path.state = tmp.path
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const message = assistantMessage()
    const command = "cat id_rsa"
    // tool-call-first：先 structured running，再 reviewing envelope，equal-v0 须补 autoReview。
    // 不得为了补 envelope 而丢掉已有 command，也不得要求 progressVersion 递增。
    const structured = {
      ...runningShellPart(""),
      state: {
        status: "running" as const,
        input: { command, description: "Read key" },
        time: { start: 1 },
      },
    } satisfies ToolPart
    const reviewing = {
      ...structured,
      state: {
        status: "running" as const,
        input: { command, description: "Read key" },
        title: "Auto review: cautious",
        metadata: {
          autoReview: {
            reviewID: "review_cmd",
            status: "reviewing",
            precheck: { level: "cautious", reason: "key path" },
          },
        },
        time: { start: 1 },
      },
    } satisfies ToolPart
    const { app, emit, sync } = await mount()

    try {
      emit(messageEvent(message))
      emit(partEvent(structured))
      await wait(
        () =>
          sync.data.part.msg_1?.[0]?.type === "tool" &&
          sync.data.part.msg_1[0].state.status === "running" &&
          (sync.data.part.msg_1[0].state.input as { command?: string }).command === command,
      )

      emit(partEvent(reviewing))
      await Bun.sleep(30)

      expect(sync.data.part.msg_1?.[0]).toMatchObject({
        state: {
          status: "running",
          input: { command },
          metadata: { autoReview: { status: "reviewing" } },
        },
      })
    } finally {
      app.renderer.destroy()
      Global.Path.state = previous
    }
  })

  // 复现核心竞态：daemon 的 message.part.updated 事件通过 fire-and-forget
  // 发送（void Effect.runPromise），而 message.part.delta 通过 yield* await
  // 发送。当 text-start 的 part.updated（text=""）因 fiber 调度延迟到 delta
  // 累积之后才到达时，不带 time.end 的短快照不应覆盖已流式拼接的长文本。
  test("preserves streaming text when a stale part.updated arrives without time.end", async () => {
    const previous = Global.Path.state
    await using tmp = await tmpdir()
    Global.Path.state = tmp.path
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const message = assistantMessage()
    const startPart = textPart("part_text", "hello ")
    const { app, emit, sync } = await mount()

    try {
      emit(messageEvent(message))
      emit(partEvent(startPart))
      await wait(() => sync.data.part.msg_1?.[0]?.type === "text" && sync.data.part.msg_1[0].text === "hello ")

      emit(textDeltaEvent("delta_text", "world"))
      await wait(() => sync.data.part.msg_1?.[0]?.type === "text" && sync.data.part.msg_1[0].text === "hello world")

      // 模拟 fire-and-forget 竞态：text-start 的 part.updated 延迟到达，
      // 携带短文本且无 time.end — mergeLivePart 必须保留本地更长的 "hello world"
      emit(partEvent(textPart("part_text", "hello")))
      await Bun.sleep(30)

      expect(sync.data.part.msg_1?.[0]).toMatchObject({ type: "text", text: "hello world" })

      // 终态 part.updated 携带 time.end 时，必须接受权威最终值
      emit(partEvent({ ...startPart, text: "final", time: { start: 1, end: 2 } } as Part))
      await wait(() => sync.data.part.msg_1?.[0]?.type === "text" && sync.data.part.msg_1[0].text === "final")
      expect(sync.data.part.msg_1?.[0]).toMatchObject({ type: "text", text: "final" })
    } finally {
      app.renderer.destroy()
      Global.Path.state = previous
    }
  })

  // 验证 tool pending 阶段的 raw 守卫：delta 累积长 raw 后，
  // 收到不带状态转换的 stale part.updated（更短 raw）— mergeLivePart 必须保留本地长 raw。
  // running/completed/error 状态的 part.updated 携带权威状态，不进入守卫。
  test("preserves streaming tool raw when a stale part.updated arrives in pending state", async () => {
    const previous = Global.Path.state
    await using tmp = await tmpdir()
    Global.Path.state = tmp.path
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const message = assistantMessage()
    const tool = pendingToolPart("part_tool", "call_tool")
    const { app, emit, sync } = await mount()

    try {
      emit(messageEvent(message))
      emit(partEvent(tool))
      await wait(() => sync.data.part.msg_1?.[0]?.type === "tool")

      // 累积 raw 到完整 JSON 参数（partID 必须与 tool part 一致）
      emit(deltaEvent("delta_raw_1", '{"path"', "part_tool"))
      emit(deltaEvent("delta_raw_2", ':"test.ts"}', "part_tool"))
      await wait(
        () =>
          sync.data.part.msg_1?.[0]?.type === "tool" &&
          sync.data.part.msg_1[0].state.status === "pending" &&
          sync.data.part.msg_1[0].state.raw === '{"path":"test.ts"}',
      )

      // stale part.updated 携带更短 raw，仍为 pending — 守卫必须保留本地完整 raw
      emit(partEvent({ ...tool, state: { status: "pending", input: {}, raw: '{"path' } } as Part))
      await Bun.sleep(30)

      const part = sync.data.part.msg_1?.[0]
      // 先断言类型和状态，再断言 raw 值——避免类型不匹配时静默跳过
      expect(part?.type).toBe("tool")
      if (part?.type === "tool" && part.state.status === "pending") expect(part.state.raw).toBe('{"path":"test.ts"}')
    } finally {
      app.renderer.destroy()
      Global.Path.state = previous
    }
  })

  // 复现子会话进入时的核心问题：子会话在用户进入前已在 streaming，
  // 但 TUI store 中没有子会话的 message/part，delta 因 missing-message 被 drop。
  // 修复后 delta 被缓冲，当 part.updated 终于到达创建 part 时 replay，
  // 恢复进入前已生成的完整流式文本。
  test("replays buffered deltas when part.updated arrives after delta was dropped", async () => {
    const previous = Global.Path.state
    await using tmp = await tmpdir()
    Global.Path.state = tmp.path
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const message = assistantMessage()
    const startPart = textPart("part_sub", "")
    const { app, emit, sync } = await mount()

    try {
      // 子会话 streaming 已开始：delta 先于 part.updated 到达（fire-and-forget 竞态）
      // 此时 store 中没有子会话的 message/part，delta 被缓冲而非永久丢弃
      emit(textDeltaEvent("delta_pre_1", "ASDF", "part_sub"))
      emit(textDeltaEvent("delta_pre_2", "GHJKL", "part_sub"))
      await Bun.sleep(30)

      // part.updated 终于到达，创建 part — 缓冲的 delta 应被 replay
      emit(messageEvent(message))
      emit(partEvent(startPart))
      await wait(() => sync.data.part.msg_1?.[0]?.type === "text")

      // 缓冲的 delta 被 replay，text 恢复为 "ASDFGHJKL"（而非 part.updated 的空文本）
      expect(sync.data.part.msg_1?.[0]?.type).toBe("text")
      if (sync.data.part.msg_1?.[0]?.type === "text") expect(sync.data.part.msg_1[0].text).toBe("ASDFGHJKL")
    } finally {
      app.renderer.destroy()
      Global.Path.state = previous
    }
  })
})
