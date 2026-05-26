/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import { Global } from "@opencode-ai/core/global"
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

function partEvent(part: ToolPart): GlobalEvent {
  return {
    directory,
    project: "proj_test",
    payload: { id: "evt_part", type: "message.part.updated", properties: { sessionID: part.sessionID, part, time: 1 } },
  }
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

describe("tui sync", () => {
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

      kv.set("session_directory_filter_enabled", false)
      await sync.session.refresh()

      expect(session.at(-1)?.searchParams.get("scope")).toBe("project")
      expect(session.at(-1)?.searchParams.get("path")).toBeNull()
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
      emit(deltaEvent("delta_missing", "secret"))
      await wait(() => logs.some((entry) => entry.extra?.phase === "delta.drop"))

      emit(messageEvent(assistantMessage()))
      emit(partEvent(pendingToolPart()))
      await wait(() => sync.data.part.msg_1?.[0]?.id === "part_1")

      emit(deltaEvent("delta_1", "hel"))
      emit(deltaEvent("delta_2", "lo"))
      emit(deltaEvent("delta_3", " world"))

      await wait(
        () =>
          sync.data.part.msg_1?.[0]?.type === "tool" &&
          sync.data.part.msg_1[0].state.status === "pending" &&
          sync.data.part.msg_1[0].state.raw === "hello world",
      )
      await wait(() => logs.some((entry) => entry.extra?.phase === "delta.apply"))
      expect(sync.data.part.msg_1?.[0]).toMatchObject({ state: { raw: "hello world" } })
      const phases = logs.map((entry) => entry.extra?.phase)
      expect(phases.filter((phase) => phase === "delta.receive")).toHaveLength(1)
      expect(phases).toContain("delta.drop")
      expect(phases).toContain("delta.apply")
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
})
