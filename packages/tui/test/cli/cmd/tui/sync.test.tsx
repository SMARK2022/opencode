/** @jsxImportSource @opentui/solid */
import { describe, expect, spyOn, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { EventV2 } from "@opencode-ai/core/event"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { tmpdir } from "../../../fixture/fixture"
import { directory, json, mount, wait, worktree } from "./sync-fixture"
import type { useSync } from "../../../../src/context/sync"
import type { AssistantMessage, GlobalEvent, Message, Part, PermissionRequest, QuestionRequest, ToolPart, UserMessage } from "@opencode-ai/sdk/v2"
import type { TuiSlotPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { JSX } from "solid-js"
import { createBuiltinPlugins } from "../../../../src/feature-plugins/builtins"

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

// #192：sync 重连测试辅助——构造 server.connected / permission / question 事件
// #192：server.connected 事件——触发 sync 重连和 bootstrap
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

test("tool raw deltas update pending state and ignore late running fragments", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const { app, emit, sync } = await mount(undefined, tmp.path)
  // 使用真实品牌 ID 工厂，并让根级 sessionID 与嵌套 part 共用身份，覆盖生产事件的完整契约。
  const part = {
    id: SessionV1.PartID.ascending(),
    messageID: SessionV1.MessageID.ascending(),
    sessionID: SessionSchema.ID.create(), type: "tool" as const,
    callID: "call-raw", tool: "bash", state: { status: "pending" as const, input: {}, raw: "" },
  } satisfies SessionV1.ToolPart
  const update = (state: typeof part.state | { status: "running"; input: { cmd: string }; time: { start: number } }) =>
    emit({ directory: "/tmp/other", project: "proj_test", payload: {
      id: EventV2.ID.create(),
      type: "message.part.updated", properties: { sessionID: part.sessionID, part: { ...part, state }, time: 1 },
    } })
  const delta = (text: string) => emit({ directory: "/tmp/other", project: "proj_test", payload: {
    id: EventV2.ID.create(),
    type: "message.part.delta", properties: {
      sessionID: part.sessionID, messageID: part.messageID, partID: part.id, field: "raw", delta: text,
    },
  } })
  try {
    // 走真实 SDK event 与 SyncProvider，避免在测试中复制 reducer 算法。
    update(part.state)
    await wait(() => sync.data.part[part.messageID]?.length === 1)
    delta('{"cmd":')
    delta('"pwd"}')
    await wait(() => {
      const value = sync.data.part[part.messageID]?.[0]
      return value?.type === "tool" && value.state.status === "pending" && value.state.raw === '{"cmd":"pwd"}'
    })
    // 顶层 raw 即使同时有正确 state.raw 仍是协议污染，单独断言其不存在。
    expect(Object.hasOwn(sync.data.part[part.messageID][0], "raw")).toBe(false)
    update({ status: "running", input: { cmd: "pwd" }, time: { start: 1 } })
    await wait(() => {
      const value = sync.data.part[part.messageID]?.[0]
      return value?.type === "tool" && value.state.status === "running"
    })
    delta("late")
    // 同一 event 队列的哨兵确认迟到片段已处理，而不是用固定 sleep 猜测处理完成。
    emit(branchEvent("raw-done"))
    await wait(() => sync.data.vcs?.branch === "raw-done")
    expect(sync.data.part[part.messageID][0]).toMatchObject({ state: { status: "running", input: { cmd: "pwd" } } })
    expect(Object.hasOwn(sync.data.part[part.messageID][0], "raw")).toBe(false)
  } finally { app.renderer.destroy() }
})

test("unloaded deletion events preserve projection absence and later live delivery", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const { app, emit, sync } = await mount(undefined, tmp.path)
  const info = assistantMessage()
  const hidden = { ...info, id: "msg_unloaded", sessionID: "ses_unloaded", hidden: { time: 1, reason: "undo" } } satisfies AssistantMessage
  try {
    // 合法但未加载的投影事件必须走真实队列，不能因缺席数组击穿后续消费。
    emit(messageEvent(hidden))
    emit({
      directory, project: "proj_test",
      payload: {
        id: "evt_unloaded_message_removed", type: "message.removed",
        properties: { sessionID: hidden.sessionID, messageID: hidden.id },
      },
    })
    emit({
      directory, project: "proj_test",
      payload: {
        id: "evt_unloaded_part_removed", type: "message.part.removed",
        properties: { sessionID: hidden.sessionID, messageID: hidden.id, partID: "part_unloaded" },
      },
    })
    // 正常消息与part都必须到达；仅无异常或daemon事件存在不足以证明投影存活。
    emit(messageEvent(info))
    emit(partEvent(textPart("part_post_remove", "still live")))
    await wait(() => sync.data.message[info.sessionID]?.[0]?.id === info.id)
    await wait(() => sync.data.part[info.id]?.[0]?.id === "part_post_remove")
    // no-op不创建幽灵集合，后续正常内容保持真实文本。
    expect(sync.data.message[hidden.sessionID]).toBeUndefined()
    expect(sync.data.part[hidden.id]).toBeUndefined()
    expect(sync.data.message[info.sessionID][0].id).toBe(info.id)
    expect(sync.data.part[info.id][0]).toMatchObject({ type: "text", text: "still live" })
  } finally {
    app.renderer.destroy()
  }
})

describe("tui sync", () => {
  test.each(["/command", "/lsp"])("settles a pending %s response when its renderer closes", async endpoint => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    let pending: AbortSignal | undefined
    let refresh = false
    const { app, emit } = await mount((url, request) => {
      if (!refresh || url.pathname !== endpoint) return
      pending = request!.signal
      // SDK 收到响应头后仍在读 body，退出必须沿同一个 Promise 链完成取消。
      return new Response(new ReadableStream({
        start: controller => request!.signal.addEventListener("abort", () => controller.error(request!.signal.reason), { once: true }),
      }), { headers: { "content-type": "application/json" } })
    }, tmp.path)
    try {
      refresh = true
      emit({ directory: "global", payload: { id: "evt_refresh", type: endpoint === "/lsp" ? "lsp.updated" : "global.disposed", properties: {} } })
      await wait(() => pending !== undefined)
      app.renderer.destroy()
      expect(pending!.aborted).toBe(true)
      await Bun.sleep(0)
    } finally {
      app.renderer.destroy()
    }
  })

  test("projects bounded patch-free TUI data through HTTP and SSE", async () => {
    // 同一 public sync 覆盖两个 transport producer；任一 header 漏传都会恢复完整 payload。
    // HTTP fixture 故意返回 101 个带唯一 patch 的对象，证明 client-side cap 也守住测试/旧 daemon 边界。
    // totals headers 使用完整 101 项 worked values，不能由截断后的 store 重新计算冒充。
    // 目标 fixture 经 TestTuiContexts paths 注入 state 目录，替代 source 的 Global.Path.state 改写。
    await using tmp = await tmpdir()
    // KVProvider 需要 kv.json 存在；空对象即干净启动。
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
      if (url.pathname === "/session/status") return json({})
    }, tmp.path)

    try {
      await sync.session.sync("ses_1", { force: true })
      // 真实 SDK transport 同时锁定 Message 与 diff producer；只测 handler 无法捕获任一请求漏传。
      expect(messageProjections).toEqual(["viewer"])
      expect(diffProjections).toEqual(["viewer"])
      expect(sync.data.session_diff.ses_1).toHaveLength(100)
      expect(sync.data.session_diff.ses_1.every((item) => item.file !== undefined)).toBe(true)
      expect(sync.data.session_diff.ses_1.some((item) => (item as { patch?: string }).patch !== undefined)).toBe(false)
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
      } as GlobalEvent)
      // 目标 SDK 类型面未列全测试字面量的缺省字段；as 收窄不绕过运行时 reducer。
      await wait(() => sync.data.session_diff.ses_1?.[0]?.file === "event-0.ts")
      expect(sync.data.session_diff.ses_1).toHaveLength(100)
      expect(sync.data.session_diff.ses_1.every((item) => item.file !== undefined)).toBe(true)
      expect(sync.data.session_diff.ses_1.some((item) => (item as { patch?: string }).patch !== undefined)).toBe(false)
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
      } as GlobalEvent)
      await wait(() => sync.session.get("ses_1")?.title === "reverted")
      expect(sync.session.get("ses_1")?.summary).toEqual({ files: 101, additions: 202, deletions: 101 })
    } finally {
      app.renderer.destroy()
    }
  })

  test("renders bounded Files rows with a final ellipsis", async () => {
    // 从 builtin plugin registry 取得 production View，避免为了测试导出私有组件或复制 JSX。
    // 100 visible rows + total 101 是最小真实 truncation；total=100 时同一 View 不应产生省略号。
    const plugin = createBuiltinPlugins({ experimentalEventSystem: false }).find(
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
    // 最小 api stub：Files View 只消费 theme/state.session/slots.register 三个 seam；
    // spyOn 的对象必须事先存在，stub slots 保留 plugin 公开注册面而不是导出私有组件。
    // createBuiltinPlugins 是目标 internalTuiPlugins 的等价 registry owner。
    const api = {
      theme: { current: { text: "#ffffff", textMuted: "#888888", diffAdded: "#22c55e", diffRemoved: "#ef4444" } },
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
      slots: { register: (_definition: TuiSlotPlugin) => "files-test" },
    } as unknown as TuiPluginApi
    let view: (() => JSX.Element) | undefined
    function capture(definition: TuiSlotPlugin) {
      // 只通过 plugin 的公开 slot registration seam 捕获 renderer，不断言注册次数或私有 id 分派。
      const content = definition.slots.sidebar_content
      if (content) view = () => content({} as never, { session_id: "ses_1" })
      return "files-test"
    }
    const register = spyOn(api.slots as { register: (definition: TuiSlotPlugin) => string }, "register").mockImplementation(capture)
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
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const delayedMessages = Promise.withResolvers<Response>()
    const delayedDiff = Promise.withResolvers<Response>()
    let messagesStarted = false
    let diffStarted = false
    let historyVisibleWhenDiffStarted = false
    const message = assistantMessage()
    // mounted 先声明后引用：diff handler 闭包要在 mount 返回前就能读公开 store。
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
    }, tmp.path)

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
    }
  })

  test("preserves resolved and rejected diff error semantics after history publication", async () => {
    // ses_1 锁定 generated SDK 的 resolved HTTP error 兼容：空 diff 是既有成功语义并允许 full-sync short circuit。
    // ses_2 锁定 genuine JSON parse rejection；独立 Session 避免前一次成功的 full-sync 标记污染失败结论。
    // 两种错误都在真实 SDK fetch/parse seam 产生，不注入假的 rejected client method。
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const message = assistantMessage()
    const malformedMessage = { ...assistantMessage(), id: "msg_2", sessionID: "ses_2" }
    let diffRequests = 0
    // diffRequests 锁定 full-sync short-circuit 与失败重试的真实请求次数。
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
        // 半个 JSON 对象体：真实 transport parse seam 产生 SyntaxError 而非合成 client 异常。
        if (id === "ses_1") return json({ error: "diff unavailable" }, { status: 500 })
        return new Response("{", { status: 200, headers: { "content-type": "application/json" } })
      }
    }, tmp.path)

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
    }
  })

  // #192：重连后恢复 pending permission/question 请求——bootstrap refresh 从 API 拉取
  // #192：reconnected 标志控制 API 返回——初始为空，重连后返回 pending 请求
  // #192：server.connected 事件触发 bootstrap——第一个是初始连接，后续是重连
  // #192：permission/question 快照必须与 API 返回一致——不能丢请求
  test("recovers pending permission and question requests after reconnect", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    let reconnected = false
    const permission = permissionRequest("perm_1")
    const question = questionRequest("question_1")
    const { app, emit, sync } = await mount((url) => {
      if (url.pathname === "/permission") return json(reconnected ? [permission] : [])
      if (url.pathname === "/question") return json(reconnected ? [question] : [])
    }, tmp.path)

    try {
      expect(sync.data.permission.ses_1).toBeUndefined()
      expect(sync.data.question.ses_1).toBeUndefined()

      emit(serverConnectedEvent("evt_connected_initial"))
      await Bun.sleep(30)
      reconnected = true
      emit(serverConnectedEvent("evt_connected_reconnect"))

      // #192：bootstrap 拉取快照后 store 必须出现 pending 请求，验证刷新链路
      await wait(() => sync.data.permission.ses_1?.[0]?.id === permission.id)
      await wait(() => sync.data.question.ses_1?.[0]?.id === question.id)

      // #192：恢复语义是快照对 store 的整体替换，缺失任何请求都违反全量契约
      expect(sync.data.permission.ses_1).toEqual([permission])
      expect(sync.data.question.ses_1).toEqual([question])
    } finally {
      app.renderer.destroy()
    }
  })

  // #192：重连快照在途时到达的 asked 事件应保留——版本追踪防止快照覆盖
  test("keeps asked events that arrive while reconnect snapshots are in flight", async () => {
    await using tmp = await tmpdir()
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
    }, tmp.path)

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
    }
  })

  // #192：快照是权威状态，快照中不存在的请求视为已解决，必须从 store 移除
  // #192：初始连接后 asked 事件推送请求——sync store 有 pending 请求
  // #192：重连后 mount 的默认 fetch 返回空——API 不再有这些请求
  // #192：sync store 必须清除——不能保留已过期的请求
  test("clears requests that are absent from reconnect snapshots", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const permission = permissionRequest("perm_cleared")
    const question = questionRequest("question_cleared")
    const { app, emit, sync } = await mount(undefined, tmp.path)

    try {
      emit(serverConnectedEvent("evt_connected_initial"))
      await Bun.sleep(30)
      emit(permissionAskedEvent(permission))
      emit(questionAskedEvent(question))
      await wait(() => sync.data.permission.ses_1?.[0]?.id === permission.id)
      await wait(() => sync.data.question.ses_1?.[0]?.id === question.id)

      emit(serverConnectedEvent("evt_connected_reconnect"))

      // #192：快照为空表示 API 已无 pending，store 必须同步清除过期请求
      await wait(() => sync.data.permission.ses_1 === undefined && sync.data.question.ses_1 === undefined)
      // #192：快照空表经 ?? [] 落到空集合，store 同步清空是空快照的必然结果
      expect(sync.data.permission.ses_1).toBeUndefined()
      expect(sync.data.question.ses_1).toBeUndefined()
    } finally {
      app.renderer.destroy()
    }
  })

  // #192：重连快照在途时到达的 replied 事件应保留——清除优先于快照恢复
  // #192：第一次快照延迟返回 [permission]——stale 快照仍包含已回复的请求
  // #192：replied/rejected 事件在 stale 快照到达前推送——应清除请求
  // #192：replied 事件是最终状态，stale 快照携带的旧状态不得反超
  // #192：最终 sync store 必须为空——replied 和 stale 快照都不能恢复请求
  test("keeps replied events that arrive while reconnect snapshots are in flight", async () => {
    await using tmp = await tmpdir()
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
    }, tmp.path)

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
      // #192：replied/rejected 是本地权威信号，即使快照在途也立即清除
      await wait(() => (sync.data.permission.ses_1?.length ?? 0) === 0 && (sync.data.question.ses_1?.length ?? 0) === 0)

      if (!stalePermissionSnapshot || !staleQuestionSnapshot) throw new Error("reconnect snapshots were not requested")
      // #192：stale 快照不得恢复已由 replied 清除的请求，版本机制保证
      stalePermissionSnapshot()
      staleQuestionSnapshot()
      await Bun.sleep(30)

      // #192：replied 与 stale 快照竞态下 replied 恒优先，最终 store 为空
      expect(sync.data.permission.ses_1 ?? []).toEqual([])
      expect(sync.data.question.ses_1 ?? []).toEqual([])
    } finally {
      app.renderer.destroy()
    }
  })

  // #192：重连恢复期间清除 stale 请求同时保留快速到达的 asked 事件
  // #192：stale 请求在重连前 asked——重连后快照不包含它
  // #192：快照延迟返回——staleSnapshot 控制时机
  // #192：liveFirst asked 在 stale 快照到达前推送——应保留
  // #192：stale 快照到达后清除 stale 请求——但不能清除 liveFirst
  // #192：liveSecond asked 在 stale 快照到达后推送——应保留
  // #192：最终 sync store 只含 liveFirst + liveSecond——stale 被清除
  test("clears stale requests while preserving rapid asked events during reconnect recovery", async () => {
    await using tmp = await tmpdir()
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
    }, tmp.path)

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

      // #192：重连快照不包含 stale 请求时须清除，保留 live 请求
      await wait(() => !sync.data.permission.ses_1?.some((request) => request.id === stale.id))
      // #192：asked 事件通过版本号保护，stale 快照不能覆盖新到达的 live 请求
      expect(sync.data.permission.ses_1?.map((request) => request.id)).toEqual([liveFirst.id, liveSecond.id])
    } finally {
      app.renderer.destroy()
    }
  })

  // #192：多次重连快照中最新者胜出——旧快照延迟到达不覆盖新快照
  // #192：第一次重连快照延迟返回空——stalePermissionSnapshot 控制
  // #192：第二次重连快照立即返回 [permission]——新快照包含请求
  // #192：多轮重连竞态下以最高 refreshVersion 的快照为准，低版本延迟响应被忽略
  // #192：最终 sync store 必须与新快照一致——permission 和 question 都在
  test("keeps the newest reconnect snapshot when an earlier snapshot resolves last", async () => {
    await using tmp = await tmpdir()
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
    }, tmp.path)

    try {
      emit(serverConnectedEvent("evt_connected_initial"))
      await Bun.sleep(30)
      reconnected = true
      emit(serverConnectedEvent("evt_connected_reconnect_1"))
      await wait(() => Boolean(stalePermissionSnapshot && staleQuestionSnapshot))
      emit(serverConnectedEvent("evt_connected_reconnect_2"))

      // #192：新快照携带请求时 store 更新，验证最新版本号生效
      await wait(() => sync.data.permission.ses_1?.[0]?.id === permission.id)
      await wait(() => sync.data.question.ses_1?.[0]?.id === question.id)

      if (!stalePermissionSnapshot || !staleQuestionSnapshot) throw new Error("stale reconnect snapshots were not requested")
      // #192：竞态守卫比较 refreshVersion，旧响应即使后到也不写 store
      stalePermissionSnapshot()
      staleQuestionSnapshot()
      await Bun.sleep(30)

      // #192：竞态结束后 store 必须等于最新快照，验证版本号单调性
      expect(sync.data.permission.ses_1).toEqual([permission])
      expect(sync.data.question.ses_1).toEqual([question])
    } finally {
      app.renderer.destroy()
    }
  })

  test("refresh scopes sessions by default and lists project sessions when disabled", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const { app, kv, sync, session } = await mount(undefined, tmp.path)

    try {
      expect(kv.get("session_directory_filter_enabled", true)).toBe(true)
      expect(session.at(-1)?.searchParams.get("roots")).toBeNull()
      expect(session.at(-1)?.searchParams.get("scope")).toBeNull()
      expect(session.at(-1)?.searchParams.get("path")).toBe("packages/tui")
      // #529：Path A 半年 lookback + browse limit 1600（与 session-list-params 常量对齐）
      expect(session.at(-1)?.searchParams.get("limit")).toBe("1600")
      const start = Number(session.at(-1)?.searchParams.get("start"))
      const lookback = 180 * 24 * 60 * 60 * 1000
      expect(start).toBeGreaterThan(Date.now() - lookback - 60_000)
      expect(start).toBeLessThanOrEqual(Date.now() - lookback + 60_000)

      kv.set("session_directory_filter_enabled", false)
      await sync.session.refresh()

      expect(session.at(-1)?.searchParams.get("scope")).toBe("project")
      expect(session.at(-1)?.searchParams.get("path")).toBeNull()
      expect(session.at(-1)?.searchParams.get("roots")).toBeNull()
      // #529：目录过滤关闭后仅换 scope，窗口/上限不变
      expect(session.at(-1)?.searchParams.get("limit")).toBe("1600")
    } finally {
      app.renderer.destroy()
    }
  })

  test("vcs branch updates only apply for the active workspace", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const { app, emit, project, sync } = await mount(undefined, tmp.path)

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
    }
  })
  // #570：daemon 事件携带 Session 实际 Project（proj_session_owner）、TUI route 固定 ses_1 时，
  // message.updated/part.updated 必须穿过 useEvent admission 进入同一活动 Session 投影；
  // 验证渲染数据源（sync.data）而非 callback 到达。route 固定使失败时可区分 admission 与 reducer 问题。
  test("delivers cross-project session events into the active session projection", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const { app, emit, sync, route } = await mount(
      () => undefined,
      tmp.path,
      { type: "session", sessionID: "ses_1" },
    )
    try {
      const foreignProject = "proj_session_owner"
      const info = assistantMessage()
      const part = textPart("part_cross", "cross")
      emit({
        directory: "/tmp/other",
        project: foreignProject,
        payload: { id: "evt_cross_message", type: "message.updated", properties: { sessionID: info.sessionID, info } },
      })
      await wait(() => sync.data.message.ses_1?.[0]?.id === info.id)
      emit({
        directory: "/tmp/other",
        project: foreignProject,
        payload: { id: "evt_cross_part", type: "message.part.updated", properties: { sessionID: part.sessionID, part, time: 1 } },
      })
      await wait(() => sync.data.part[part.messageID]?.[0]?.id === part.id)
      expect(sync.data.message.ses_1?.[0]).toMatchObject(info)
      expect(sync.data.part[part.messageID]?.[0]).toMatchObject(part)
      // route切换必须重新判定Session资格，不能把初始会话缓存进订阅。
      route.navigate({ type: "session", sessionID: "ses_other" })
      const other = { ...info, id: "msg_other", sessionID: "ses_other" }
      emit({ directory, project: foreignProject, payload: { id: "evt_cross_other", type: "message.updated", properties: { sessionID: other.sessionID, info: other } } })
      await wait(() => sync.data.message.ses_other?.[0]?.id === other.id)
      const rejected = { ...info, id: "msg_rejected", sessionID: "ses_rejected" }
      emit({ directory, project: foreignProject, payload: { id: "evt_cross_rejected", type: "message.updated", properties: { sessionID: rejected.sessionID, info: rejected } } })
      emit(branchEvent("route-switch-processed"))
      await wait(() => sync.data.vcs?.branch === "route-switch-processed")
      expect(sync.data.message.ses_rejected).toBeUndefined()
    } finally {
      app.renderer.destroy()
    }
  })

  test("keeps Message lifecycle chronological across ID rollover", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    // 前180条仍在回绕前的 lexical-high 区间，后120条已进入 lexical-low；
    // worked times 独立规定 chronology，测试不能借 ID 排序生成 expected。
    const history = Array.from({ length: 300 }, (_, index) =>
      userMessage(
        index < 180 ? `msg_ffff${String(index).padStart(8, "0")}` : `msg_0000${String(index).padStart(8, "0")}`,
        index + 1,
      ),
    )
    // 与 snapshot 末条同毫秒，较大的 ID 是服务端合同规定的稳定 tie-break。
    const target = userMessage("msg_000100000001", 300)
    const { app, emit, sync } = await mount((url) => {
      if (url.pathname === "/session/ses_1")
        return json({ id: "ses_1", time: { created: 1, updated: 1 }, directory })
      if (url.pathname === "/session/ses_1/message" || url.pathname === "/session/ses_1/messages")
        return json(history.map((info) => ({ info, parts: [] })))
      if (url.pathname === "/session/ses_1/todo") return json([])
      if (url.pathname === "/session/ses_1/diff") return json([])
      if (url.pathname === "/session/status") return json({})
    }, tmp.path)

    try {
      await sync.session.sync("ses_1", { force: true })
      // 插入使长度瞬时 301；窗口 shift 必须裁掉 chronology 首项而非数组首项误判。
      emit(messageEvent(target))
      // 后续公开事件是 reducer 队列边界；它生效后即可断言前一条 Message 事件，避免时间等待竞态。
      emit(branchEvent("rollover-inserted"))
      await wait(() => sync.data.vcs?.branch === "rollover-inserted")

      // 300 条边界的 worked result：旧首项必须离开，新项必须占据 chronology 末尾。
      // 两端断言共同防止“只保留目标但裁错另一条 Message”的近似修复。
      expect(sync.data.message.ses_1).toHaveLength(300)
      expect(sync.data.message.ses_1?.[0]?.id).toBe("msg_ffff00000001")
      expect(sync.data.message.ses_1?.at(-1)?.id).toBe(target.id)

      emit(messageEvent({ ...target, agent: "updated" }))
      emit(branchEvent("rollover-updated"))
      await wait(() => sync.data.vcs?.branch === "rollover-updated")
      // 同一 Message 必须原位 reconcile；错误 locator 会留下重复 ID 或更新旧位置。
      expect(sync.data.message.ses_1?.filter((message) => message.id === target.id)).toEqual([
        expect.objectContaining({ agent: "updated" }),
      ])

      // 使用SDK已有hidden形状，删除按ID定位，不能让回绕后的消息留在窗口里。
      emit(messageEvent({ ...target, hidden: { time: 301, reason: "undo" } }))
      emit(branchEvent("rollover-hidden"))
      await wait(() => sync.data.vcs?.branch === "rollover-hidden")
      // hidden保留目标ID定位，与chronology插入互不争夺删除责任。
      expect(sync.data.message.ses_1?.some((message) => message.id === target.id)).toBe(false)
    } finally {
      app.renderer.destroy()
    }
  })

  test("removes arbitrary Message IDs through chronology order", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const { app, emit, sync } = await mount(undefined, tmp.path)

    try {
      // 不走 HTTP snapshot：首条 event 必须创建数组并保持 chronology 插入序。
      // 后续 ID 故意形成 m,z,a,y，证明公开 caller ID 既非全局升序也非单次旋转数组。
      const messages = [
        userMessage("msg_m", 8),
        userMessage("msg_z", 9),
        userMessage("msg_a", 10),
        userMessage("msg_y", 11),
      ]
      for (const message of messages) emit(messageEvent(message))
      emit(branchEvent("arbitrary-created"))
      await wait(() => sync.data.vcs?.branch === "arbitrary-created")
      // 此顺序只能由 time.created 得出；若实现悄悄恢复 ID sort，remove 测试会失去判别力。
      expect(sync.data.message.ses_1?.map((message) => message.id)).toEqual(["msg_m", "msg_z", "msg_a", "msg_y"])

      emit(messageRemovedEvent("msg_y"))
      emit(branchEvent("arbitrary-removed"))
      await wait(() => sync.data.vcs?.branch === "arbitrary-removed")
      // remove 只有 ID；目标按 ID 线性查找定位，不依赖数组按 ID 有序。
      expect(sync.data.message.ses_1?.map((message) => message.id)).toEqual(["msg_m", "msg_z", "msg_a"])

      emit(messageRemovedEvent("msg_missing"))
      emit(branchEvent("arbitrary-missing"))
      await wait(() => sync.data.vcs?.branch === "arbitrary-missing")
      // missing ID 是 contracted no-op；不能触发重排或删除邻近 chronology 项。
      expect(sync.data.message.ses_1?.map((message) => message.id)).toEqual(["msg_m", "msg_z", "msg_a"])
    } finally {
      app.renderer.destroy()
    }
  })

  test("matches SQLite BINARY order for same-millisecond Message IDs", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    // SQLite BINARY 比较 UTF-8 bytes：大写 B(0x42) 必须排在小写 a(0x61) 之前。
    // 两条 time.created 相同，确保测试只对 tie-break 敏感，不让时间主键掩盖 collation 分歧。
    const upper = userMessage("msg_B", 100)
    const lower = userMessage("msg_a", 100)
    const bmp = userMessage("msg_\ue000", 100)
    const nonBmp = userMessage("msg_\u{10000}", 100)
    const { app, emit, sync } = await mount((url) => {
      if (url.pathname === "/session/ses_1")
        return json({ id: "ses_1", time: { created: 1, updated: 1 }, directory })
      if (url.pathname === "/session/ses_1/message" || url.pathname === "/session/ses_1/messages")
        return json([upper, lower, bmp, nonBmp].map((info) => ({ info, parts: [] })))
      if (url.pathname === "/session/ses_1/todo") return json([])
      if (url.pathname === "/session/ses_1/diff") return json([])
      if (url.pathname === "/session/status") return json({})
    }, tmp.path)

    try {
      await sync.session.sync("ses_1", { force: true })
      // 字面expected独立规定UTF-8顺序，非BMP必须在U+E000之后，不能复用生产比较器生成答案。
      expect(sync.data.message.ses_1?.map((message) => message.id)).toEqual(["msg_B", "msg_a", "msg_\ue000", "msg_\u{10000}"])

      emit(messageEvent({ ...upper, agent: "binary-updated" }))
      emit(branchEvent("binary-updated"))
      await wait(() => sync.data.vcs?.branch === "binary-updated")
      // update 必须命中 snapshot 原位；locale 顺序不一致会在末尾插入第二条 msg_B。
      expect(sync.data.message.ses_1?.map((message) => message.id)).toEqual(["msg_B", "msg_a", "msg_\ue000", "msg_\u{10000}"])
      expect(sync.data.message.ses_1?.[0]).toMatchObject({ agent: "binary-updated" })

      emit(messageEvent({ ...upper, hidden: { time: 101, reason: "undo" } }))
      emit(branchEvent("binary-hidden"))
      await wait(() => sync.data.vcs?.branch === "binary-hidden")
      expect(sync.data.message.ses_1?.map((message) => message.id)).toEqual(["msg_a", "msg_\ue000", "msg_\u{10000}"])

      emit(messageRemovedEvent(lower.id))
      emit(messageRemovedEvent(bmp.id))
      emit(messageRemovedEvent(nonBmp.id))
      emit(branchEvent("binary-removed"))
      await wait(() => sync.data.vcs?.branch === "binary-removed")
      // explicit remove 复用同一 ID 线性定位，证明 BINARY chronology 前提未被绕过。
      expect(sync.data.message.ses_1).toEqual([])
    } finally {
      app.renderer.destroy()
    }
  })
})

function userMessage(id: string, created: number): UserMessage {
  // userMessage 工厂只填 chronology 断言所需字段；model 三元组满足 SDK User 必填。
  return {
    id,
    sessionID: "ses_1",
    role: "user",
    time: { created },
    agent: "build",
    model: { providerID: "provider", modelID: "model" },
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

function messageEvent(info: Message): GlobalEvent {
  return {
    directory,
    project: "proj_test",
    payload: { id: "evt_message", type: "message.updated", properties: { sessionID: info.sessionID, info } },
  }
}

function messageRemovedEvent(messageID: string): GlobalEvent {
  // remove 事件只携带 ID；与 update 事件同源目录保证进入同一 reducer 队列。
  return {
    directory,
    project: "proj_test",
    payload: { id: `evt_removed_${messageID}`, type: "message.removed", properties: { sessionID: "ses_1", messageID } },
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


function deltaEvent(id: string, delta: string, partID = "part_1"): GlobalEvent {
  // #186：测试事件工厂：field 固定 raw，覆盖 pending tool 路径
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

describe("tui sync part delta coalesce (#186)", () => {
  test("applies queued streaming part deltas to the sync store", async () => {
    // #186：同 part raw 多段 delta 合并后仍得到完整文本
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const logs: Array<{ extra?: Record<string, unknown> }> = []
    const { app, emit, sync } = await mount((url, request) => {
      if (url.pathname !== "/log") return
      // /log 失败模拟 daemon log 写入不可用；同步 reducer 仍必须应用 delta，
      // 且日志 payload 不能携带 delta 正文或其他流式内容。
      return request!.text().then((body) => {
        logs.push(JSON.parse(body))
        throw new Error("log endpoint unavailable")
      }) as unknown as Response
    }, tmp.path)

    try {
      // delta 在 part 创建前到达（模拟 fire-and-forget 竞态），被缓冲而非永久丢弃
      emit(deltaEvent("delta_missing", "secret"))
      await wait(() => logs.some((entry) => entry.extra?.phase === "delta.drop"))

      emit(messageEvent(assistantMessage()))
      emit(partEvent(pendingToolPart()))
      await wait(() => sync.data.part.msg_1?.[0]?.id === "part_1")

      // #186：三段相邻 delta，合并后应为 "hello world"
      emit(deltaEvent("delta_1", "hel"))
      emit(deltaEvent("delta_2", "lo"))
      emit(deltaEvent("delta_3", " world"))

      await wait(
        () =>
          sync.data.part.msg_1?.[0]?.type === "tool" &&
          sync.data.part.msg_1[0].state.status === "pending" &&
          // 缓冲的 "secret" 在 part 创建时被 replay，所以 raw = "secret" + "hello world"
          sync.data.part.msg_1[0].state.raw === "secrethello world",
      )
      expect(sync.data.part.msg_1?.[0]).toMatchObject({ state: { raw: "secrethello world" } })
      await wait(() => logs.some((entry) => entry.extra?.phase === "delta.apply"))
      const phases = logs.map((entry) => entry.extra?.phase)
      expect(phases.filter((phase) => phase === "delta.receive")).toHaveLength(1)
      expect(phases).toContain("delta.drop")
      expect(phases).toContain("delta.apply")
      // 日志 payload 不携带 delta 正文
      expect(JSON.stringify(logs)).not.toContain("hello world")
      expect(JSON.stringify(logs)).not.toContain("secret")
    } finally {
      app.renderer.destroy()
    }
  })

  test("flushes queued part deltas before non-delta event boundaries", async () => {
    // #186：vcs 等非 delta 边界会先 flush，两 part 各自文本完整
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const { app, emit, project, sync } = await mount(undefined, tmp.path)

    try {
      project.workspace.set("ws_a")
      emit(messageEvent(assistantMessage()))
      emit(partEvent(pendingToolPart()))
      emit(partEvent(pendingToolPart("part_2", "call_2")))
      await wait(() => sync.data.part.msg_1?.length === 2)

      // #186：交替 part 的 delta 不能跨 part 粘连；vcs 触发边界 flush
      emit(deltaEvent("delta_1", "a"))
      emit(deltaEvent("delta_2", "b", "part_2"))
      emit(deltaEvent("delta_3", "c"))
      emit(branchEvent("flush", "ws_a"))

      await wait(
        () =>
          sync.data.part.msg_1?.[0]?.type === "tool" &&
          sync.data.part.msg_1[0].state.status === "pending" &&
          sync.data.part.msg_1[0].state.raw === "ac" &&
          sync.data.part.msg_1[1]?.type === "tool" &&
          sync.data.part.msg_1[1].state.status === "pending" &&
          sync.data.part.msg_1[1].state.raw === "b" &&
          sync.data.vcs?.branch === "flush",
      )
      expect(sync.data.part.msg_1?.[0]).toMatchObject({ state: { raw: "ac" } })
      expect(sync.data.part.msg_1?.[1]).toMatchObject({ state: { raw: "b" } })
      expect(sync.data.vcs?.branch).toBe("flush")
    } finally {
      app.renderer.destroy()
    }
  })

  // 验证 session.sync HTTP 快照路径：delta 累积 "hello world" 后，
  // 强制重新拉取返回 DB 中的短快照 "hello " — mergeLiveParts 必须保留本地长文本。
  // 随后终态 part.updated（带 time.end）到达时，必须接受权威最终值 "final"。
  test("preserves streaming text when a stale session sync snapshot arrives", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const message = assistantMessage()
    const stalePart = textPart("part_text", "hello ")
    const { app, emit, sync } = await mount((url) => {
      if (url.pathname === "/session/ses_1") return json({ id: "ses_1", time: { created: 1, updated: 1 }, directory })
      if (url.pathname === "/session/ses_1/messages") return json([{ info: message, parts: [stalePart] }])
      if (url.pathname === "/session/ses_1/todo") return json([])
      if (url.pathname === "/session/ses_1/diff") return json([])
    }, tmp.path)

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
    }
  })

  test("keeps shell progress monotonic across legacy session sync snapshots", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const message = assistantMessage()
    const legacy = runningShellPart("legacy")
    const { app, emit, sync } = await mount(
      (url) => {
        if (url.pathname === "/session/ses_1") return json({ id: "ses_1", time: { created: 1, updated: 1 }, directory })
        if (url.pathname === "/session/ses_1/messages") return json([{ info: message, parts: [legacy] }])
        if (url.pathname === "/session/ses_1/todo") return json([])
        if (url.pathname === "/session/ses_1/diff") return json([])
        return undefined
      },
      tmp.path,
      { type: "session", sessionID: "ses_1" },
    )

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
    }
  })

  // 验证 reasoning part 的 session.sync 快照路径：与 text 同构，
  // delta 累积 "step two" 后强制重拉返回短快照 "step " — 必须保留本地长文本。
  test("preserves streaming reasoning when a stale session sync snapshot arrives", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const message = assistantMessage()
    const stalePart = reasoningPart("part_reasoning", "step ")
    const { app, emit, sync } = await mount((url) => {
      if (url.pathname === "/session/ses_1") return json({ id: "ses_1", time: { created: 1, updated: 1 }, directory })
      if (url.pathname === "/session/ses_1/messages") return json([{ info: message, parts: [stalePart] }])
      if (url.pathname === "/session/ses_1/todo") return json([])
      if (url.pathname === "/session/ses_1/diff") return json([])
    }, tmp.path)

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
    }
  })

  // #531 equal-v0 生命周期：先到 reviewing raw-only 不得永久挡住后到 structured command，
  // 且 autoReview envelope 必须保留（否则会出现 Writing command... 或丢审核行）。
  // progressVersion 均缺省 → legacy v0，触发字段 enrich 而非 progress 前进分支。
  test("enriches equal-v0 bash running from raw-only autoReview to structured command", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const message = assistantMessage()
    const command = "git push origin dev"
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
    const { app, emit, sync } = await mount(undefined, tmp.path)

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
    }
  })

  // #531 tool-call-first：先 structured running，再 reviewing envelope，equal-v0 须补 autoReview。
  // 不得为了补 envelope 而丢掉已有 command，也不得要求 progressVersion 递增。
  test("enriches equal-v0 bash running autoReview without dropping structured command", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const message = assistantMessage()
    const command = "cat id_rsa"
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
    const { app, emit, sync } = await mount(undefined, tmp.path)

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
    }
  })

  // 复现核心竞态：daemon 的 message.part.updated 事件通过 fire-and-forget
  // 发送（void Effect.runPromise），而 message.part.delta 通过 yield* await
  // 发送。当 text-start 的 part.updated（text=""）因 fiber 调度延迟到 delta
  // 累积之后才到达时，不带 time.end 的短快照不应覆盖已流式拼接的长文本。
  test("preserves streaming text when a stale part.updated arrives without time.end", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const message = assistantMessage()
    const startPart = textPart("part_text", "hello ")
    const { app, emit, sync } = await mount(undefined, tmp.path)

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
    }
  })

  // 验证 tool pending 阶段的 raw 守卫：delta 累积长 raw 后，
  // 收到不带状态转换的 stale part.updated（更短 raw）— mergeLivePart 必须保留本地长 raw。
  // running/completed/error 状态的 part.updated 携带权威状态，不进入守卫。
  test("preserves streaming tool raw when a stale part.updated arrives in pending state", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const message = assistantMessage()
    const tool = pendingToolPart("part_tool", "call_tool")
    const { app, emit, sync } = await mount(undefined, tmp.path)

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
    }
  })

  // 复现子会话进入时的核心问题：子会话在用户进入前已在 streaming，
  // 但 TUI store 中没有子会话的 message/part，delta 因 missing-message 被 drop。
  // 修复后 delta 被缓冲，当 part.updated 终于到达创建 part 时 replay，
  // 恢复进入前已生成的完整流式文本。
  test("replays buffered deltas when part.updated arrives after delta was dropped", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const message = assistantMessage()
    const startPart = textPart("part_sub", "")
    const { app, emit, sync } = await mount(undefined, tmp.path)

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
    }
  })
})

describe("tui sync memory lifetime", () => {
  // [失效语义] 持久删除/hidden 与 300 窗口淘汰不同：前者释放 payload 并拒绝迟到复活，后者保持现有加载合同。
  // 本组测试只观察公开 store 与 sync Promise，不断言私有 Map/Set。
  const sid = "ses_1"
  let lifeSeq = 0
  function lifeMessage(id: string, session = sid, created = 1): UserMessage {
    return { id, sessionID: session, role: "user", time: { created }, agent: "build", model: { providerID: "provider", modelID: "model" } }
  }
  function lifePart(messageID: string, session = sid, text = "payload", id = `prt_${messageID}`): Part {
    return { id, sessionID: session, messageID, type: "text", text } as Part
  }
  function lifeEvent(type: string, properties: object): GlobalEvent {
    return { directory, project: "proj_test", payload: { id: `evt_life_${++lifeSeq}`, type, properties } } as GlobalEvent
  }
  function lifeSession(id = sid) {
    return { id, directory, projectID: "proj_test", slug: id, version: "1", title: id, time: { created: 1, updated: 1 } }
  }
  function lifeTransport(rows: () => { info: UserMessage; parts: Part[] }[]) {
    // [0624] 服务任意 Session：正文消费计数下，测试可对 sibling Session 显式 acquireParts；
    // 只有 sid 由 rows() 提供数据，其余 Session 返回空页。
    return (url: URL) => {
      if (url.pathname.endsWith("/goal")) return json({ goal: null })
      if (url.pathname.endsWith("/todo") || url.pathname.endsWith("/diff")) return json([])
      const sessionMatch = url.pathname.match(/^\/session\/([^/]+?)(\/message)?$/)
      if (sessionMatch?.[2]) return json(sessionMatch[1] === sid ? rows() : [])
      if (sessionMatch) return json(lifeSession(sessionMatch[1]))
      return undefined
    }
  }
  async function pump(emit: (event: GlobalEvent) => void, sync: ReturnType<typeof useSync>) {
    const branch = `life_${++lifeSeq}`
    emit(branchEvent(branch))
    await wait(() => sync.data.vcs?.branch === branch)
  }
  function put(emit: (event: GlobalEvent) => void, id: string, session = sid, text = "payload", created = 1) {
    emit(lifeEvent("message.updated", { sessionID: session, info: lifeMessage(id, session, created) }))
    emit(lifeEvent("message.part.updated", { sessionID: session, part: lifePart(id, session, text), time: 1 }))
  }

  for (const mode of ["removed", "hidden"] as const) {
    test(`${mode} Message releases only its own Part payload`, async () => {
      // [0624] sid 由 route 持有正文使用权；ses_other 用显式 acquisition（与可见 Task 卡片同级）持有。
      const { app, emit, sync } = await mount(lifeTransport(() => []), undefined, { type: "session", sessionID: sid })
      const otherParts = await sync.session.acquireParts("ses_other")
      try {
        put(emit, "msg_drop")
        put(emit, "msg_keep", sid, "keep", 2)
        put(emit, "msg_other", "ses_other", "other")
        await pump(emit, sync)
        if (mode === "removed") emit(lifeEvent("message.removed", { sessionID: sid, messageID: "msg_drop" }))
        if (mode === "hidden") emit(lifeEvent("message.updated", { sessionID: sid, info: { ...lifeMessage("msg_drop"), hidden: { time: 2, reason: "undo" } } }))
        await pump(emit, sync)
        // sibling 与其他 Session 不受影响；只有失效 Message 的正文离开公开 store。
        expect(sync.data.message[sid].map((m) => m.id)).toEqual(["msg_keep"])
        expect(sync.data.part.msg_keep?.[0]).toMatchObject({ text: "keep" })
        expect(sync.data.part.msg_other?.[0]).toMatchObject({ text: "other" })
        expect(sync.data.part.msg_drop).toBeUndefined()
      } finally {
        otherParts.release()
        app.renderer.destroy()
      }
    })
  }

  // 四个桶分属不同 reducer 分支；一次性断言全覆盖，防止实现只清 message 而留下 todo/status 残留。
  test("deleted Session releases its message, part, todo, and status buckets", async () => {
    const { app, emit, sync } = await mount(lifeTransport(() => []), undefined, { type: "session", sessionID: sid })
    const otherParts = await sync.session.acquireParts("ses_other")
    try {
      emit(lifeEvent("session.updated", { sessionID: sid, info: lifeSession() }))
      put(emit, "msg_owned")
      put(emit, "msg_other", "ses_other", "other")
      emit(lifeEvent("todo.updated", { sessionID: sid, todos: [{ content: "owned", status: "pending", priority: "high" }] }))
      emit(lifeEvent("session.status", { sessionID: sid, status: { type: "busy" } }))
      await pump(emit, sync)
      emit(lifeEvent("session.deleted", { sessionID: sid, info: lifeSession() }))
      await pump(emit, sync)
      expect(sync.session.get(sid)).toBeUndefined()
      expect(sync.data.part.msg_other?.[0]).toMatchObject({ text: "other" })
      expect(sync.data.message[sid]?.length ?? 0).toBe(0)
      expect(sync.data.part.msg_owned).toBeUndefined()
      expect(sync.data.todo[sid]?.length ?? 0).toBe(0)
      expect(sync.data.session_status[sid]).toBeUndefined()
    } finally {
      otherParts.release()
      app.renderer.destroy()
    }
  })

  for (const mode of ["message.removed", "message.part.removed", "session.deleted"] as const) {
    // 三种失效路径各有独立的 early-return 位置；参数化锁定任一漏网都会复活缓冲 delta。
    // 对照：无关 live part 的缓冲 delta 不属于失效对象，必须在局部删除后存活并回放。
    test(`buffered orphan delta cannot rehydrate after ${mode}`, async () => {
      const { app, emit, sync } = await mount()
      try {
        emit(lifeEvent("message.part.delta", { sessionID: sid, messageID: "msg_late", partID: "prt_msg_late", field: "text", delta: "STALE" }))
        const aliveSession = mode === "session.deleted" ? "ses_alive" : sid
        emit(lifeEvent("message.part.delta", { sessionID: aliveSession, messageID: "msg_alive", partID: "prt_msg_alive", field: "text", delta: "ALIVE" }))
        if (mode === "message.removed") emit(lifeEvent(mode, { sessionID: sid, messageID: "msg_late" }))
        if (mode === "message.part.removed") emit(lifeEvent(mode, { sessionID: sid, messageID: "msg_late", partID: "prt_msg_late" }))
        if (mode === "session.deleted") emit(lifeEvent(mode, { sessionID: sid, info: lifeSession() }))
        await pump(emit, sync)
        emit(lifeEvent("message.part.updated", { sessionID: sid, part: lifePart("msg_late", sid, ""), time: 1 }))
        emit(lifeEvent("message.part.updated", { sessionID: aliveSession, part: lifePart("msg_alive", aliveSession, ""), time: 1 }))
        await pump(emit, sync)
        expect(sync.data.part.msg_late).toBeUndefined()
        expect((sync.data.part.msg_alive?.[0] as { text?: string } | undefined)?.text).toBe("ALIVE")
      } finally {
        app.renderer.destroy()
      }
    })
  }

  // 完整 Part 更新走与 delta 不同的 admission 分支；失效 Message 的两个入口都必须拒绝。
  test("late full Part update cannot rehydrate a removed Message", async () => {
    const { app, emit, sync } = await mount()
    try {
      put(emit, "msg_dead")
      await pump(emit, sync)
      emit(lifeEvent("message.removed", { sessionID: sid, messageID: "msg_dead" }))
      await pump(emit, sync)
      expect(sync.data.part.msg_dead).toBeUndefined()
      emit(lifeEvent("message.part.updated", { sessionID: sid, part: lifePart("msg_dead", sid, "late"), time: 2 }))
      await pump(emit, sync)
      expect(sync.data.message[sid]).toHaveLength(0)
      expect(sync.data.part.msg_dead).toBeUndefined()
    } finally {
      app.renderer.destroy()
    }
  })

  test("force sync prunes out-of-window Parts and part-first orphans", async () => {
    const { app, emit, sync } = await mount(
      lifeTransport(() => [{ info: lifeMessage("msg_keep"), parts: [lifePart("msg_keep", sid, "fresh")] }]),
      undefined,
      { type: "session", sessionID: sid },
    )
    const otherParts = await sync.session.acquireParts("ses_other")
    try {
      put(emit, "msg_old")
      put(emit, "msg_other", "ses_other", "other")
      emit(lifeEvent("message.part.updated", { sessionID: sid, part: lifePart("msg_part_first"), time: 1 }))
      await pump(emit, sync)
      await sync.session.sync(sid, { force: true })
      expect(sync.data.message[sid].map((m) => m.id)).toEqual(["msg_keep"])
      expect(sync.data.part.msg_keep?.[0]).toMatchObject({ text: "fresh" })
      expect(sync.data.part.msg_other?.[0]).toMatchObject({ text: "other" })
      expect(sync.data.part.msg_old).toBeUndefined()
      expect(sync.data.part.msg_part_first).toBeUndefined()
    } finally {
      otherParts.release()
      app.renderer.destroy()
    }
  })

  test("force sync preserves a Message arriving after the request started", async () => {
    const gate = Promise.withResolvers<Response>()
    const normal = lifeTransport(() => [])
    const { app, emit, sync } = await mount(
      (url) => (url.pathname === `/session/${sid}/message` ? gate.promise : normal(url)),
      undefined,
      { type: "session", sessionID: sid },
    )
    let pending: Promise<void> | undefined
    try {
      pending = sync.session.sync(sid, { force: true })
      put(emit, "msg_live", sid, "live", 10)
      await pump(emit, sync)
      gate.resolve(json([]))
      await pending
      // 请求期间的合法新增必须并入最终投影，不能被旧快照抹掉。
      expect(sync.data.message[sid].map((m) => m.id)).toEqual(["msg_live"])
      expect(sync.data.part.msg_live?.[0]).toMatchObject({ text: "live" })
    } finally {
      gate.resolve(json([]))
      await pending
      app.renderer.destroy()
    }
  })

  test("in-flight force sync cannot resurrect a deleted Session", async () => {
    const gate = Promise.withResolvers<Response>()
    const normal = lifeTransport(() => [{ info: lifeMessage("msg_old"), parts: [lifePart("msg_old")] }])
    const { app, emit, sync } = await mount((url) => (url.pathname === `/session/${sid}/message` ? gate.promise : normal(url)))
    let pending: Promise<void> | undefined
    try {
      emit(lifeEvent("session.updated", { sessionID: sid, info: lifeSession() }))
      await pump(emit, sync)
      pending = sync.session.sync(sid, { force: true })
      emit(lifeEvent("session.deleted", { sessionID: sid, info: lifeSession() }))
      await pump(emit, sync)
      expect(sync.session.get(sid)).toBeUndefined()
      gate.resolve(json([{ info: lifeMessage("msg_old"), parts: [lifePart("msg_old")] }]))
      await pending
      // 迟到快照不得重建已删除 Session 的行、消息或正文。
      expect(sync.session.get(sid)?.id).toBeUndefined()
      expect(sync.data.message[sid]?.length ?? 0).toBe(0)
      expect(sync.data.part.msg_old).toBeUndefined()
    } finally {
      gate.resolve(json([]))
      await pending
      app.renderer.destroy()
    }
  })

  // diff 是 sync 的最后一个 await；只检 history 竞态挡不住 diff 提交重建 summary 与行。
  test("late diff response cannot repopulate a deleted Session", async () => {
    const gate = Promise.withResolvers<Response>()
    const normal = lifeTransport(() => [])
    const { app, emit, sync } = await mount((url) => (url.pathname.endsWith("/diff") ? gate.promise : normal(url)))
    let pending: Promise<void> | undefined
    try {
      pending = sync.session.sync(sid, { force: true })
      emit(lifeEvent("session.deleted", { sessionID: sid, info: lifeSession() }))
      await pump(emit, sync)
      gate.resolve(json([{ file: "stale.ts", additions: 1, deletions: 0, before: "", after: "x" }]))
      await pending
      expect(sync.session.get(sid)).toBeUndefined()
      expect(sync.data.session_diff[sid]).toBeUndefined()
    } finally {
      gate.resolve(json([]))
      await pending
      app.renderer.destroy()
    }
  })
})
