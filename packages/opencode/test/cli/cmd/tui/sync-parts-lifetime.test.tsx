/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import type { GlobalEvent, Part, UserMessage } from "@opencode-ai/sdk/v2"
import { directory, mount, json, wait } from "./sync-fixture"

type Harness = Awaited<ReturnType<typeof mount>>
const active = "ses_lifetime_active"
const other = "ses_lifetime_other"
let sequence = 0

function message(id: string, sessionID = active, created = 1): UserMessage {
  return { id, sessionID, role: "user", time: { created }, agent: "build", model: { providerID: "test", modelID: "test" } }
}

function session(id: string) {
  return { id, directory, projectID: "proj_test", slug: id, version: "1", title: id, time: { created: 1, updated: 1 } }
}

function tool(messageID: string, sessionID: string, output: string, created = 1): Part {
  return {
    id: `prt_${messageID}`,
    messageID,
    sessionID,
    type: "tool",
    callID: messageID,
    tool: "bash",
    state: { status: "completed", input: { command: "echo fixture" }, output, title: "fixture", metadata: {}, time: { start: 1, end: 2 } },
  }
}

function emit(h: Harness, type: string, properties: object) {
  h.emit({ directory, project: "proj_test", payload: { id: `evt_lifetime_${++sequence}`, type, properties } } as GlobalEvent)
}

async function barrier(h: Harness) {
  const branch = `lifetime_${++sequence}`
  emit(h, "vcs.branch.updated", { branch })
  await wait(() => h.sync.data.vcs?.branch === branch)
}

function bytes(h: Harness, sessionID: string) {
  return Object.values(h.sync.data.part)
    .flat()
    .reduce((n, p) => n + (p.sessionID === sessionID && p.type === "tool" && p.state.status === "completed" ? p.state.output.length : 0), 0)
}

function put(h: Harness, id: string, sessionID: string, output: string, created = 1) {
  emit(h, "message.updated", { sessionID, info: message(id, sessionID, created) })
  emit(h, "message.part.updated", { sessionID, part: tool(id, sessionID, output), time: 2 })
}

function transport(rows: { info: UserMessage; parts: Part[] }[]) {
  return (url: URL) => {
    if (url.pathname === `/session/${active}` || url.pathname === `/session/${other}`) return json(session(url.pathname.split("/")[2]))
    if (url.pathname.endsWith("/message")) return json(rows)
    if (url.pathname.endsWith("/goal")) return json({ goal: null })
    if (url.pathname.endsWith("/todo") || url.pathname.endsWith("/diff")) return json([])
  }
}

test("completed background session bodies are never admitted to the store", async () => {
  const h = await mount(undefined, { type: "session", sessionID: active })
  try {
    emit(h, "session.updated", { sessionID: other, info: session(other) })
    emit(h, "session.status", { sessionID: other, status: { type: "busy" } })
    put(h, "msg_other", other, "X".repeat(1024 * 1024))
    await barrier(h)
    // metadata 保留（sidebar/status 需要），已持久终态正文不入 store。
    expect(h.sync.data.message[other]).toHaveLength(1)
    expect(h.sync.data.session_status[other]).toEqual({ type: "busy" })
    expect(bytes(h, other)).toBe(0)
    expect(h.sync.data.part.msg_other).toBeUndefined()
  } finally {
    h.app.renderer.destroy()
  }
})

test("switching route releases previous session bodies; re-enter restores them from sync", async () => {
  const rows = [{ info: message("msg_active", active), parts: [tool("msg_active", active, "X".repeat(1024 * 1024))] }]
  const h = await mount(transport(rows), { type: "session", sessionID: active })
  try {
    await h.sync.session.sync(active)
    expect(bytes(h, active)).toBe(1024 * 1024)
    h.route.navigate({ type: "session", sessionID: other })
    await barrier(h)
    expect(bytes(h, active)).toBe(0)
    // 重新进入后由现有 sync 恢复，内容逐字一致。
    h.route.navigate({ type: "session", sessionID: active })
    await h.sync.session.sync(active)
    expect(bytes(h, active)).toBe(1024 * 1024)
    expect(h.sync.data.part.msg_active?.[0]).toMatchObject({ type: "tool", state: { output: "X".repeat(1024 * 1024) } })
  } finally {
    h.app.renderer.destroy()
  }
})

test("explicit acquireParts holds bodies; release drops them; acquire again reloads", async () => {
  const rows = [{ info: message("msg_other", other, 1), parts: [tool("msg_other", other, "Y".repeat(1024))] }]
  const h = await mount(transport(rows), { type: "session", sessionID: active })
  try {
    const handle = await h.sync.session.acquireParts(other)
    expect(bytes(h, other)).toBe(1024)
    handle.release()
    expect(bytes(h, other)).toBe(0)
    const again = await h.sync.session.acquireParts(other)
    expect(bytes(h, other)).toBe(1024)
    again.release()
  } finally {
    h.app.renderer.destroy()
  }
})

test("acquireParts rolls back the consumer count when sync rejects", async () => {
  // sync 失败（Session 删除竞态/守护进程重启）必须回滚计数：否则该 Session 的
  // 正文使用权永久泄漏，后台完成事件会持续补入。
  const h = await mount((url) => {
    if (url.pathname === `/session/${other}`) return new Response("boom", { status: 500 })
    if (url.pathname === `/session/${active}`) return json(session(active))
    if (url.pathname.endsWith("/message")) return json([])
    if (url.pathname.endsWith("/goal")) return json({ goal: null })
    if (url.pathname.endsWith("/todo") || url.pathname.endsWith("/diff")) return json([])
  }, { type: "session", sessionID: active })
  try {
    await expect(h.sync.session.acquireParts(other)).rejects.toBeDefined()
    // 回滚的证据： acquire 失败后该 Session 没有消费者，迟到的终态正文仍被拒绝。
    emit(h, "session.updated", { sessionID: other, info: session(other) })
    put(h, "msg_late", other, "LATE".repeat(1024))
    await barrier(h)
    expect(bytes(h, other)).toBe(0)
  } finally {
    h.app.renderer.destroy()
  }
})

test("assistant completion releases all already-admitted parts, not just alternating ones", async () => {
  const h = await mount(undefined, { type: "session", sessionID: active })
  const assistant = {
    id: "msg_multi",
    sessionID: other,
    role: "assistant",
    time: { created: 1 },
    parentID: "msg_multi_user",
    agent: "build",
    mode: "build",
    modelID: "test",
    providerID: "test",
    path: { cwd: directory, root: directory },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  }
  try {
    emit(h, "session.updated", { sessionID: other, info: session(other) })
    // 完成事件前先到达的流式 Part 因父 Message 未完成而准入；完成边界必须把它们全部释放。
    emit(h, "message.updated", { sessionID: other, info: assistant })
    for (let i = 0; i < 4; i++) {
      emit(h, "message.part.updated", {
        sessionID: other,
        part: { id: `prt_multi_${i}`, messageID: "msg_multi", sessionID: other, type: "text", text: `body ${i}` },
      })
    }
    await barrier(h)
    expect(h.sync.data.part.msg_multi).toHaveLength(4)
    emit(h, "message.updated", { sessionID: other, info: { ...assistant, time: { created: 1, completed: 2 } } })
    await barrier(h)
    expect(h.sync.data.part.msg_multi).toBeUndefined()
  } finally {
    h.app.renderer.destroy()
  }
})

test("terminal tool update removes the previously admitted running body", async () => {
  const h = await mount(undefined, { type: "session", sessionID: active })
  const running = {
    id: "prt_tool_replace",
    messageID: "msg_tool_replace",
    sessionID: other,
    type: "tool",
    callID: "call_replace",
    tool: "bash",
    state: { status: "running", input: { command: "echo" }, metadata: { output: "RUNNING_BODY" }, time: { start: 1 } },
  } as unknown as Part
  try {
    emit(h, "session.updated", { sessionID: other, info: session(other) })
    emit(h, "message.part.updated", { sessionID: other, part: running })
    await barrier(h)
    expect(h.sync.data.part.msg_tool_replace?.[0]).toMatchObject({ state: { status: "running" } })
    // completed 是同一 Part 的持久替换：旧 running 正文必须随终值一起离开，
    // 不能拒绝新事件却把旧版本留在 store。
    emit(h, "message.part.updated", {
      sessionID: other,
      part: {
        ...running,
        state: { status: "completed", input: { command: "echo" }, output: "FINAL", title: "done", metadata: {}, time: { start: 1, end: 2 } },
      },
    })
    await barrier(h)
    expect(h.sync.data.part.msg_tool_replace).toBeUndefined()
  } finally {
    h.app.renderer.destroy()
  }
})

test("window eviction forgets terminal release facts so a re-announced part is admitted", async () => {
  const h = await mount(undefined, { type: "session", sessionID: active })
  try {
    emit(h, "session.updated", { sessionID: other, info: session(other) })
    // 301 条完成消息让首条滑出 300 窗口；其终态 Part ID 事实必须随淘汰释放。
    for (let i = 0; i <= 300; i++) {
      const id = `msg_evict_${i}`
      emit(h, "message.updated", { sessionID: other, info: message(id, other, i + 1) })
      emit(h, "message.part.updated", { sessionID: other, part: tool(id, other, "done", i + 1) })
    }
    await barrier(h)
    expect(h.sync.data.message[other]).toHaveLength(300)
    // 同一 Part 以非终态重新宣布（如重试场景）：陈旧 ID 事实不得再拒绝准入。
    const running = {
      id: "prt_msg_evict_0",
      messageID: "msg_evict_0",
      sessionID: other,
      type: "tool",
      callID: "msg_evict_0",
      tool: "bash",
      state: { status: "running", input: { command: "echo" }, metadata: {}, time: { start: 1 } },
    } as unknown as Part
    emit(h, "message.part.updated", { sessionID: other, part: running })
    await barrier(h)
    expect(h.sync.data.part.msg_evict_0?.[0]).toMatchObject({ state: { status: "running" } })
  } finally {
    h.app.renderer.destroy()
  }
})

test("concurrent acquisitions both resolve only after bodies are loaded", async () => {
  // sync 并发取代曾让第一个 acquire 在正文尚未提交时就返回成功；两个并发消费者
  // 都必须等到正文真实可用。串行化后第二个请求只看到已提交的 fullSynced 状态。
  const gates = [Promise.withResolvers<Response>(), Promise.withResolvers<Response>()]
  let requests = 0
  const row = { info: message("msg_concurrent", other), parts: [tool("msg_concurrent", other, "FULL".repeat(256))] }
  const h = await mount(
    (url) => {
      if (url.pathname === `/session/${other}/message`) return gates[Math.min(requests++, 1)].promise
      if (url.pathname === `/session/${other}`) return json(session(other))
      if (url.pathname.endsWith("/goal")) return json({ goal: null })
      if (url.pathname.endsWith("/todo") || url.pathname.endsWith("/diff")) return json([])
    },
    { type: "session", sessionID: active },
  )
  try {
    const first = h.sync.session.acquireParts(other)
    await wait(() => requests === 1)
    const second = h.sync.session.acquireParts(other)
    gates[0].resolve(json([row]))
    const h1 = await first
    expect(bytes(h, other)).toBe(1024)
    gates[1].resolve(json([row]))
    const h2 = await second
    expect(bytes(h, other)).toBe(1024)
    h1.release()
    h2.release()
    expect(bytes(h, other)).toBe(0)
  } finally {
    h.app.renderer.destroy()
  }
})

test("switching into a streaming session retains bus-only delta before HTTP parent arrives", async () => {
  const rows = [
    { info: message("msg_stream", other), parts: [{ id: "prt_stream", messageID: "msg_stream", sessionID: other, type: "text", text: "" } as Part] },
  ]
  const h = await mount(transport(rows), { type: "session", sessionID: active })
  try {
    emit(h, "message.part.delta", { sessionID: other, messageID: "msg_stream", partID: "prt_stream", field: "text", delta: "BUS_ONLY" })
    await barrier(h)
    h.route.navigate({ type: "session", sessionID: other })
    await h.sync.session.sync(other)
    // bus-only delta 不写 DB；切换后必须与 HTTP 快照合并而不是丢失。
    expect(h.sync.data.part.msg_stream?.[0]).toMatchObject({ text: "BUS_ONLY" })
  } finally {
    h.app.renderer.destroy()
  }
})
