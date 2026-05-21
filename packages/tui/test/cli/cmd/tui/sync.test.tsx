/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import { EventV2 } from "@opencode-ai/core/event"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { tmpdir } from "../../../fixture/fixture"
import { directory, mount, wait, worktree } from "./sync-fixture"
import type { AssistantMessage, GlobalEvent, ToolPart } from "@opencode-ai/sdk/v2"

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
    const { app, emit, sync } = await mount(undefined, tmp.path)

    try {
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
