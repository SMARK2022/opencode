/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import { EventV2 } from "@opencode-ai/core/event"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { tmpdir } from "../../../fixture/fixture"
import { directory, json, mount, wait, worktree } from "./sync-fixture"
import type { AssistantMessage, GlobalEvent, PermissionRequest, QuestionRequest, ToolPart } from "@opencode-ai/sdk/v2"

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

describe("tui sync", () => {
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

      kv.set("session_directory_filter_enabled", false)
      await sync.session.refresh()

      expect(session.at(-1)?.searchParams.get("scope")).toBe("project")
      expect(session.at(-1)?.searchParams.get("path")).toBeNull()
      expect(session.at(-1)?.searchParams.get("roots")).toBeNull()
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
})

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

function partEvent(part: ToolPart): GlobalEvent {
  return {
    directory,
    project: "proj_test",
    payload: { id: "evt_part", type: "message.part.updated", properties: { sessionID: part.sessionID, part, time: 1 } },
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
          sync.data.part.msg_1[0].state.raw === "hello world",
      )
      expect(sync.data.part.msg_1?.[0]).toMatchObject({ state: { raw: "hello world" } })
      await wait(() => logs.some((entry) => entry.extra?.phase === "delta.apply"))
      const phases = logs.map((entry) => entry.extra?.phase)
      expect(phases.filter((phase) => phase === "delta.receive")).toHaveLength(1)
      expect(phases).toContain("delta.drop")
      expect(phases).toContain("delta.apply")
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
})
