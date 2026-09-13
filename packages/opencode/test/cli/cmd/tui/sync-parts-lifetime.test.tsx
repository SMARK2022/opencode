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
