/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { SessionPath } from "@opencode-ai/core/session/path"
import path from "path"
import type { GlobalEvent } from "@opencode-ai/sdk/v2"
import { tmpdir } from "../../../fixture/fixture"
import { json, mount, wait } from "./sync-fixture"

const sessionID = "ses_hydration_race"
const messageID = "msg_hydration_race"
const partID = "prt_hydration_race"
const session = {
  id: sessionID,
  title: "race",
  time: { created: 0, updated: 0 },
  version: "1.15.13",
  directory: "/tmp/opencode/packages/opencode",
}
const assistant = {
  id: messageID,
  sessionID,
  role: "assistant" as const,
  agent: "build",
  modelID: "model",
  providerID: "test",
  mode: "build",
  parentID: "msg_user",
  path: { cwd: session.directory, root: session.directory },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, completed: 2 },
}

function global(payload: GlobalEvent["payload"]): GlobalEvent {
  return { directory: "/tmp/other", project: "proj_test", payload }
}

test("live messages use creation time with an ID tie-break", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const { app, emit, sync } = await mount(undefined, tmp.path)
  const messages = [
    { ...assistant, id: "msg_a", time: { created: 30, completed: 31 } },
    { ...assistant, id: "msg_z", time: { created: 10, completed: 11 } },
    { ...assistant, id: "msg_m", time: { created: 20, completed: 21 } },
    { ...assistant, id: "msg_b", time: { created: 20, completed: 21 } },
  ]

  try {
    for (const info of messages) {
      emit(global({ id: `evt_${info.id}`, type: "message.updated", properties: { sessionID, info } }))
    }
    await wait(() => sync.data.message[sessionID]?.length === messages.length)

    expect(sync.data.message[sessionID].map((message) => message.id)).toEqual(["msg_z", "msg_b", "msg_m", "msg_a"])
  } finally {
    app.renderer.destroy()
  }
})

test("stale session hydration does not overwrite live message parts", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")

  let resolveMessages!: (response: Response) => void
  const messages = new Promise<Response>((resolve) => {
    resolveMessages = resolve
  })
  let requested = false
  const { app, emit, sync } = await mount((url) => {
    if (url.pathname === `/session/${sessionID}`) return json(session)
    if (url.pathname === `/session/${sessionID}/message`) {
      requested = true
      return messages
    }
    if (url.pathname === `/session/${sessionID}/todo` || url.pathname === `/session/${sessionID}/diff`) return json([])
    return undefined
  }, tmp.path)

  try {
    const hydrate = sync.session.sync(sessionID)
    await wait(() => requested)
    emit(global({ id: "evt_message", type: "message.updated", properties: { sessionID, info: assistant } }))
    emit(
      global({
        id: "evt_part",
        type: "message.part.updated",
        properties: {
          sessionID,
          time: 2,
          part: { id: partID, sessionID, messageID, type: "text", text: "visible live content" },
        },
      }),
    )
    await wait(() => sync.data.part[messageID]?.[0]?.type === "text")

    resolveMessages(
      json([
        {
          info: assistant,
          parts: [{ id: partID, sessionID, messageID, type: "text", text: "" }],
        },
      ]),
    )
    await hydrate

    expect(sync.data.part[messageID][0]).toMatchObject({ text: "visible live content" })
  } finally {
    app.renderer.destroy()
  }
})

test.each(["todo", "diff"] as const)(
  "forced hydration waits for pending %s and restores a missed finish",
  async (pending) => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    let resolveMessages!: (response: Response) => void
    const messages = new Promise<Response>((resolve) => {
      resolveMessages = resolve
    })
    let resolvePending!: (response: Response) => void
    const pendingResponse = new Promise<Response>((resolve) => {
      resolvePending = resolve
    })
    let resolveFreshMessages!: (response: Response) => void
    const freshMessages = new Promise<Response>((resolve) => {
      resolveFreshMessages = resolve
    })
    const calls = { get: 0, message: 0, todo: 0, diff: 0 }
    const stale = json([
      {
        info: { ...assistant, time: { created: 1 } },
        parts: [{ id: partID, sessionID, messageID, type: "text", text: "unfinished" }],
      },
    ])
    const finished = { id: partID, sessionID, messageID, type: "text" as const, text: "completed while disconnected" }
    const live = { ...finished, id: "prt_reconnect_live", text: "live during forced hydration" }
    const { app, emit, sync } = await mount((url) => {
      if (url.pathname === `/session/${sessionID}`) {
        calls.get++
        return json(calls.get === 1 ? session : { ...session, title: "reconnected" })
      }
      if (url.pathname === `/session/${sessionID}/message`) {
        calls.message++
        return calls.message === 1 ? messages : freshMessages
      }
      if (url.pathname === `/session/${sessionID}/todo` || url.pathname === `/session/${sessionID}/diff`) {
        const kind = url.pathname.endsWith("/todo") ? "todo" : "diff"
        calls[kind]++
        return kind === pending && calls[kind] === 1 ? pendingResponse : json([])
      }
      return undefined
    }, tmp.path)
    try {
      const hydrate = sync.session.sync(sessionID)
      const joined = sync.session.sync(sessionID)
      await wait(() => calls.message === 1 && calls.todo === 1)
      resolveMessages(stale)
      // #132：messages 已读取但另一 RPC 尚未结束，force 不能复用这轮断线前快照。
      await wait(() => stale.bodyUsed)
      // diff在历史发布后才发起；todo阻塞时应尚未请求diff，diff阻塞时则等待其真实到达。
      if (pending === "diff") await wait(() => calls.diff === 1)
      const forced = sync.session.sync(sessionID, { force: true })
      expect(calls).toEqual({ get: 1, message: 1, todo: 1, diff: pending === "todo" ? 0 : 1 })
      resolvePending(json([]))
      await Promise.all([hydrate, joined])
      await wait(() => calls.message === 2 && calls.todo === 2)
      expect(sync.session.status(sessionID)).toBe("working")
      expect(sync.data.message[sessionID][0].time).not.toHaveProperty("completed")
      emit(
        global({
          id: "evt_reconnect_live_part",
          type: "message.part.updated",
          properties: {
            sessionID,
            time: 3,
            part: live,
          },
        }),
      )
      await wait(() => sync.data.part[messageID]?.some((part) => part.id === live.id) ?? false)
      // #132：不发送完成事件；新快照恢复漏收的结束状态，同时保留本轮实时部件。
      resolveFreshMessages(json([{ info: assistant, parts: [finished] }]))
      await forced
      expect(calls).toEqual({ get: 2, message: 2, todo: 2, diff: 2 })
      expect(sync.session.get(sessionID)?.title).toBe("reconnected")
      expect(sync.data.message[sessionID][0].time).toMatchObject({ completed: assistant.time.completed })
      expect(sync.session.status(sessionID)).toBe("idle")
      expect(sync.data.part[messageID]).toContainEqual(finished)
      expect(sync.data.part[messageID]).toContainEqual(live)
      await sync.session.sync(sessionID)
      expect(calls).toEqual({ get: 2, message: 2, todo: 2, diff: 2 })
    } finally {
      resolveMessages(json([]))
      resolvePending(json([]))
      resolveFreshMessages(json([]))
      app.renderer.destroy()
    }
  },
)

test.each(["success", "failure"] as const)(
  "forced hydration after an old rejection preserves fresh %s",
  async (outcome) => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    let resolveSession!: (response: Response) => void
    const response = new Promise<Response>((resolve) => {
      resolveSession = resolve
    })
    let requested = 0
    const { app, sync } = await mount((url) => {
      if (url.pathname === `/session/${sessionID}`) {
        requested++
        if (requested === 1) return response
        if (requested === 2 && outcome === "failure") return json({ message: "fresh snapshot failed" }, { status: 500 })
        return json(session)
      }
      if (url.pathname === `/session/${sessionID}/message`) return json([{ info: assistant, parts: [] }])
      if (url.pathname === `/session/${sessionID}/todo` || url.pathname === `/session/${sessionID}/diff`)
        return json([])
      return undefined
    }, tmp.path)
    try {
      const hydrate = sync.session.sync(sessionID)
      const oldFailure = hydrate.catch((error: unknown) => error)
      await wait(() => requested === 1)
      const forced = sync.session.sync(sessionID, { force: true })
      const fresh = forced.catch((error: unknown) => error)
      resolveSession(json({ message: "old snapshot failed" }, { status: 500 }))
      expect(await oldFailure).toMatchObject({ message: "old snapshot failed" })
      expect(await fresh).toEqual(
        outcome === "success" ? undefined : expect.objectContaining({ message: "fresh snapshot failed" }),
      )
      expect(requested).toBe(2)
      await sync.session.sync(sessionID)
      expect(requested).toBe(outcome === "failure" ? 3 : 2)
      expect(sync.session.status(sessionID)).toBe("idle")
      expect(sync.data.message[sessionID][0].time).toMatchObject({ completed: assistant.time.completed })
    } finally {
      resolveSession(json([]))
      app.renderer.destroy()
    }
  },
)

test.each(["streaming", "completed"] as const)(
  "orphan live deltas replay only onto unfinished hydrated parts: %s",
  async (state) => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")

    let resolveMessages!: (response: Response) => void
    const messages = new Promise<Response>((resolve) => {
      resolveMessages = resolve
    })
    let requested = false
    const { app, emit, sync } = await mount((url) => {
      if (url.pathname === `/session/${sessionID}`) return json(session)
      if (url.pathname === `/session/${sessionID}/message`) {
        requested = true
        return messages
      }
      if (url.pathname === `/session/${sessionID}/todo` || url.pathname === `/session/${sessionID}/diff`)
        return json([])
      return undefined
    }, tmp.path)

    try {
      const hydrate = sync.session.sync(sessionID)
      await wait(() => requested)
      emit(
        global({
          id: "evt_delta",
          type: "message.part.delta",
          properties: { sessionID, messageID, partID, field: "text", delta: "ignored until part exists" },
        }),
      )
      resolveMessages(
        json([
          {
            info: assistant,
            parts: [
              {
                id: partID,
                sessionID,
                messageID,
                type: "text",
                text: "hydrated",
                time: { start: 1, ...(state === "completed" ? { end: 2 } : {}) },
              },
            ],
          },
        ]),
      )
      await hydrate

      // 未完成快照恢复早到正文；终态快照仍权威，不能追加旧 delta 污染最终值。
      expect(sync.data.part[messageID][0]).toMatchObject({
        text: state === "streaming" ? "hydratedignored until part exists" : "hydrated",
      })
    } finally {
      app.renderer.destroy()
    }
  },
)

test("hydration does not clear text streamed before it starts", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")

  let resolveMessages!: (response: Response) => void
  const messages = new Promise<Response>((resolve) => {
    resolveMessages = resolve
  })
  let requested = false
  const { app, emit, sync } = await mount((url) => {
    if (url.pathname === `/session/${sessionID}`) return json(session)
    if (url.pathname === `/session/${sessionID}/message`) {
      requested = true
      return messages
    }
    if (url.pathname === `/session/${sessionID}/todo` || url.pathname === `/session/${sessionID}/diff`) return json([])
    return undefined
  }, tmp.path)

  try {
    emit(global({ id: "evt_message", type: "message.updated", properties: { sessionID, info: assistant } }))
    emit(
      global({
        id: "evt_part",
        type: "message.part.updated",
        properties: {
          sessionID,
          time: 1,
          part: { id: partID, sessionID, messageID, type: "text", text: "" },
        },
      }),
    )
    emit(
      global({
        id: "evt_delta",
        type: "message.part.delta",
        properties: { sessionID, messageID, partID, field: "text", delta: "visible streamed content" },
      }),
    )
    await wait(() => sync.data.part[messageID]?.[0]?.type === "text" && sync.data.part[messageID][0].text !== "")
    const hydrate = sync.session.sync(sessionID)
    await wait(() => requested)
    resolveMessages(json([{ info: assistant, parts: [{ id: partID, sessionID, messageID, type: "text", text: "" }] }]))
    await hydrate

    expect(sync.data.part[messageID][0]).toMatchObject({ text: "visible streamed content" })
  } finally {
    app.renderer.destroy()
  }
})

test.each(["refresh", "bootstrap", "directory"] as const)(
  "live usage and deletion survive stale %s lists",
  async (mode) => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const old = {
      ...session,
      slug: "race",
      projectID: "proj_test",
      path: "packages/tui",
      cost: 1,
      tokens: { input: 20, output: 30, reasoning: 10, cache: { read: 50, write: 70 } },
    }
    // revert 可以降低全部五项，且 usage 不推进 time.updated；max 或时间戳合并都会漏掉它。
    const current = { ...old, tokens: { input: 2, output: 3, reasoning: 1, cache: { read: 5, write: 7 } } }
    const deleted = { ...old, id: "ses_deleted" }
    const excluded = { ...old, id: "ses_excluded" }
    const marker = { ...old, id: "ses_list_accepted" }
    // 新行不在旧 HTTP 列表里，仍需保留已到达的完整用量；子目录也属于当前筛选。
    const added = {
      ...current,
      id: "ses_live_new",
      path: "packages/tui/new",
      time: { created: Date.now(), updated: Date.now() },
    }
    const outside = { ...added, id: "ses_live_outside" }
    const foreign = { ...added, id: "ses_live_foreign", projectID: "proj_other" }
    // 旧 pathless 行依靠请求目录匹配，不能仅靠相对 path 判定遗漏这类合法成员。
    const pathless = { ...added, id: "ses_live_pathless", path: undefined, directory: "/tmp/opencode/packages/tui" }
    // #143：旧 HTTP 中已存在且被事件触碰的祖先/global 行，与新补入行共用成员判定。
    const relatives = [
      { ...current, id: "ses_live_root", path: "", directory: path.resolve("/tmp/opencode") },
      { ...current, id: "ses_live_ancestor", path: "packages", directory: path.resolve("/tmp/opencode/packages") },
      {
        ...current,
        id: "ses_live_global",
        projectID: "global",
        path: SessionPath.relative("/", "/tmp/opencode"),
        directory: path.resolve("/tmp/opencode"),
      },
      {
        ...current,
        id: "ses_live_global_alias",
        projectID: "global",
        path: SessionPath.relative("/", "/tmp/opencode").replace(/^[A-Za-z]:\//, ""),
        directory: path.resolve("/tmp/unrelated"),
      },
      {
        ...current,
        id: "ses_live_directory_relative",
        projectID: "proj_other",
        path: undefined,
        directory: path.resolve("/tmp/opencode/packages"),
      },
    ].map((info) => ({ ...info, time: { created: Date.now(), updated: Date.now() } }))
    const sibling = {
      ...added,
      id: "ses_live_sibling",
      path: "packages/tui-other",
      directory: path.resolve("/tmp/unrelated"),
    }
    let resolveList!: (response: Response) => void
    const response = new Promise<Response>((resolve) => {
      resolveList = resolve
    })
    let delayed = false
    let requested = false
    const { app, emit, sync, kv } = await mount((url) => {
      if (url.pathname !== "/session") return undefined
      // 初次 mount 正常完成；仅把被测 refresh/bootstrap 的列表 HTTP 延迟。
      if (!delayed) return json([old, deleted, excluded, ...relatives.map((info) => ({ ...info, tokens: old.tokens }))])
      requested = true
      expect(url.searchParams.get("scope")).toBe(mode === "directory" ? null : "project")
      expect(url.searchParams.get("path")).toBe(mode === "directory" ? "packages/tui" : null)
      return response
    }, tmp.path)
    try {
      kv.set("session_directory_filter_enabled", mode === "directory")
      delayed = true
      const request = mode === "bootstrap" ? sync.bootstrap({ fatal: false }) : sync.session.refresh()
      await wait(() => requested)
      emit(global({ id: `evt_${mode}_usage`, type: "session.updated", properties: { sessionID, info: current } }))
      emit(
        global({
          id: `evt_${mode}_deleted`,
          type: "session.deleted",
          properties: { sessionID: deleted.id, info: deleted },
        }),
      )
      for (const info of [added, outside, foreign, pathless, ...relatives, sibling])
        emit(
          global({ id: `evt_${mode}_${info.id}`, type: "session.updated", properties: { sessionID: info.id, info } }),
        )
      // 移出子树的 placement delta 改变成员资格；project scope 仍应保留同项目行。
      emit(
        global({
          id: `evt_${mode}_move_out`,
          type: "session.next.moved",
          properties: {
            sessionID: outside.id,
            timestamp: Date.now(),
            location: { directory: outside.directory },
            subdirectory: "packages/other",
          },
        }),
      )
      // 确认事件已落入 store 后才完成旧快照，避免把事件晚到误当成竞态修复。
      await wait(
        () =>
          sync.session.get(sessionID)?.tokens?.input === 2 &&
          !sync.session.get(deleted.id) &&
          sync.session.get(outside.id)?.path === "packages/other" &&
          !!sync.session.get(foreign.id),
      )
      // 接收时切换偏好不改变已发出请求的筛选；否则迟到结果会按另一个查询解释。
      kv.set("session_directory_filter_enabled", mode !== "directory")
      resolveList(json([old, deleted, marker, ...relatives.map((info) => ({ ...info, tokens: old.tokens })), sibling]))
      await request
      // 非 continue 的 bootstrap 返回早于非阻塞列表，marker 证明列表已实际接收。
      await wait(() => !!sync.session.get(marker.id))
      expect(sync.session.get(sessionID)?.tokens).toEqual(current.tokens)
      expect(sync.session.get(sessionID)?.cost).toBe(1)
      expect(sync.session.get(deleted.id)).toBeUndefined()
      // 只补本次触碰的行，服务器排除的未触碰旧成员仍消失。
      expect(sync.session.get(excluded.id)).toBeUndefined()
      expect(sync.session.get(added.id)?.tokens).toEqual(current.tokens)
      expect(sync.session.get(added.id)?.cost).toBe(1)
      expect(sync.session.get(pathless.id)?.tokens).toEqual(current.tokens)
      // #143：项目模式保留兄弟目录，目录模式排除无关分支；全局事件本身不是成员证明。
      expect(sync.session.get(foreign.id)).toBeUndefined()
      expect(!!sync.session.get(outside.id)).toBe(mode !== "directory")
      for (const info of relatives)
        expect(sync.session.get(info.id)?.tokens).toEqual(
          mode === "directory" || info.projectID === old.projectID ? current.tokens : undefined,
        )
      expect(sync.session.get(sibling.id)?.tokens).toEqual(mode === "directory" ? undefined : current.tokens)
      delayed = false
      kv.set("session_directory_filter_enabled", false)
      emit(
        global({
          id: `evt_${mode}_after`,
          type: "session.updated",
          properties: {
            sessionID,
            info: { ...current, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } },
          },
        }),
      )
      await wait(() => sync.session.get(sessionID)?.tokens?.input === 0)
      // 已完成请求的 touched 集必须释放；新请求没有并发事件时仍接收服务器快照。
      await sync.session.refresh()
      expect(sync.session.get(sessionID)?.tokens).toEqual(old.tokens)
    } finally {
      resolveList(json([]))
      app.renderer.destroy()
    }
  },
)

test.each(["get", "project", "directory"] as const)(
  "moved before %s initialization preserves the full row",
  async (mode) => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const full = {
      ...session,
      slug: "race",
      projectID: "proj_test",
      path: "packages/old",
      workspaceID: "ws_old",
      cost: 1,
      tokens: { input: 2, output: 3, reasoning: 1, cache: { read: 5, write: 7 } },
    }
    let resolveSnapshot!: (response: Response) => void
    const response = new Promise<Response>((resolve) => {
      resolveSnapshot = resolve
    })
    let delayed = false
    let requested = false
    const { app, emit, sync, kv } = await mount((url) => {
      // 列表先让 mount 完成；GET 和列表共用同一缺失本地行的部分更新场景。
      if (url.pathname === "/session" && (mode === "get" || !delayed)) return json([])
      if ((mode !== "get" && url.pathname === "/session") || url.pathname === `/session/${sessionID}`) {
        requested = true
        return response
      }
      if (url.pathname.startsWith(`/session/${sessionID}/`)) return json([])
      return undefined
    }, tmp.path)
    try {
      kv.set("session_directory_filter_enabled", mode === "directory")
      delayed = true
      const request = mode === "get" ? sync.session.sync(sessionID) : sync.session.refresh()
      await wait(() => requested)
      // 两个 delta 验证最后 placement 胜出；第一条不能被当作完整会话或删除。
      emit(
        global({
          id: `evt_${mode}_first_move`,
          type: "session.next.moved",
          properties: {
            sessionID,
            timestamp: 11,
            location: { directory: "/tmp/old", workspaceID: "ws_move" },
            subdirectory: "packages/stale",
          },
        }),
      )
      emit(
        global({
          id: `evt_${mode}_last_move`,
          type: "session.next.moved",
          properties: {
            sessionID,
            timestamp: 12,
            location: { directory: session.directory },
            subdirectory: mode === "directory" ? "packages/tui/moved" : undefined,
          },
        }),
      )
      // FIFO 后续事件证明 moved 已处理；无需等一个此时不应存在的 Session 行。
      emit(global({ id: `evt_${mode}_move_ready`, type: "todo.updated", properties: { sessionID, todos: [] } }))
      await wait(() => sync.data.todo[sessionID] !== undefined)
      expect(sync.session.get(sessionID)).toBeUndefined()
      resolveSnapshot(json(mode === "get" ? full : [full]))
      await request
      // title/created/usage 来自 HTTP，placement 来自最后 delta；不能把半行标成 fullSynced。
      expect(sync.session.get(sessionID)).toMatchObject({
        title: full.title,
        cost: 1,
        tokens: full.tokens,
        time: { created: 0, updated: 12 },
        directory: session.directory,
        path: mode === "directory" ? "packages/tui/moved" : undefined,
        workspaceID: undefined,
      })
    } finally {
      resolveSnapshot(json([]))
      app.renderer.destroy()
    }
  },
)

test("overlapping filtered lists do not erase full event snapshots from pending requests", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const old = {
    ...session,
    slug: "overlap",
    projectID: "proj_test",
    path: "packages/other",
    cost: 1,
    tokens: { input: 20, output: 30, reasoning: 10, cache: { read: 50, write: 70 } },
    time: { created: Date.now(), updated: Date.now() },
  }
  // 新旧 snapshot 的 updated 完全相等，事件证据必须独立于时间戳或 token 大小。
  const current = { ...old, cost: 2, tokens: { input: 2, output: 3, reasoning: 1, cache: { read: 5, write: 7 } } }
  const getID = "ses_overlap_get"
  const added = { ...current, id: "ses_overlap_new" }
  const hydrated = { ...current, id: getID }
  const deleted = { ...old, id: "ses_overlap_deleted" }
  const excluded = { ...old, id: "ses_overlap_excluded" }
  let resolveWide!: (response: Response) => void
  const wideResponse = new Promise<Response>((resolve) => {
    resolveWide = resolve
  })
  let resolveNarrow!: (response: Response) => void
  const narrowResponse = new Promise<Response>((resolve) => {
    resolveNarrow = resolve
  })
  let resolveGet!: (response: Response) => void
  const getResponse = new Promise<Response>((resolve) => {
    resolveGet = resolve
  })
  let delayed = false
  const requested = new Set<string>()
  const { app, emit, sync, kv } = await mount((url) => {
    if (url.pathname === "/session") {
      // mount 正常完成后才挂起请求，三个响应各用独立 Promise，不能串行伪造重叠。
      if (!delayed) return json([old, deleted, excluded])
      const key = url.searchParams.get("scope") === "project" ? "wide" : "narrow"
      requested.add(key)
      return key === "wide" ? wideResponse : narrowResponse
    }
    if (url.pathname === `/session/${getID}`) {
      requested.add("get")
      return getResponse
    }
    if (url.pathname.startsWith(`/session/${getID}/`)) return json([])
    return undefined
  }, tmp.path)
  try {
    delayed = true
    kv.set("session_directory_filter_enabled", false)
    const wide = sync.session.refresh()
    // 宽请求仍在途时切换筛选并发起窄请求，随后 GET 也覆盖同一事件窗口。
    kv.set("session_directory_filter_enabled", true)
    const narrow = sync.session.refresh()
    const get = sync.session.sync(getID)
    await wait(() => requested.size === 3)
    // 后到的 full 必须清除先前 moved 的 placement，否则窄列表会误把它保留在子树中。
    emit(
      global({
        id: "evt_overlap_move",
        type: "session.next.moved",
        properties: {
          sessionID,
          timestamp: old.time.updated,
          location: { directory: old.directory },
          subdirectory: "packages/tui/stale",
        },
      }),
    )
    for (const info of [current, added, hydrated])
      emit(global({ id: `evt_overlap_${info.id}`, type: "session.updated", properties: { sessionID: info.id, info } }))
    emit(
      global({
        id: "evt_overlap_deleted",
        type: "session.deleted",
        properties: { sessionID: deleted.id, info: deleted },
      }),
    )
    // 等事件处理完成再让窄列表覆盖共享 store，确保宽请求和 GET 确实已知完整更新。
    await wait(
      () =>
        sync.session.get(sessionID)?.tokens?.input === 2 &&
        !!sync.session.get(added.id) &&
        !!sync.session.get(getID) &&
        !sync.session.get(deleted.id),
    )
    resolveNarrow(json([]))
    await narrow
    expect(sync.session.get(sessionID)).toBeUndefined()
    expect(sync.session.get(added.id)).toBeUndefined()
    expect(sync.session.get(getID)).toBeUndefined()
    resolveGet(json({ ...old, id: getID }))
    await get
    // GET 只能恢复自己的最新 full；另两行仍缺失，宽请求不能借它们的共享 store 状态取证。
    expect(sync.session.get(getID)).toMatchObject({ tokens: current.tokens, cost: 2, time: current.time })
    expect(sync.session.get(sessionID)).toBeUndefined()
    resolveWide(json([old, deleted]))
    await wide
    // 同时覆盖旧返回成员与不在响应里的新成员，二者均从各自请求的事件快照恢复。
    expect(sync.session.get(sessionID)).toMatchObject({ tokens: current.tokens, cost: 2, time: current.time })
    expect(sync.session.get(added.id)).toMatchObject({ tokens: current.tokens, cost: 2, time: current.time })
    expect(sync.session.get(sessionID)?.path).toBe("packages/other")
    // 筛选移除和真实删除保持区分；宽响应仍含 deleted 旧行也不能将它复活。
    expect(sync.session.get(deleted.id)).toBeUndefined()
    expect(sync.session.get(excluded.id)).toBeUndefined()
  } finally {
    resolveWide(json([]))
    resolveNarrow(json([]))
    resolveGet(json([]))
    app.renderer.destroy()
  }
})

test("live full usage survives stale hydration and transcript eviction", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  let resolveSession!: (response: Response) => void
  const response = new Promise<Response>((resolve) => {
    resolveSession = resolve
  })
  let requested = false
  const current = {
    ...session,
    slug: "race",
    projectID: "proj_test",
    cost: 1,
    tokens: { input: 204, output: 306, reasoning: 102, cache: { read: 510, write: 714 } },
  }
  const { app, emit, sync } = await mount((url) => {
    if (url.pathname === `/session/${sessionID}`) {
      requested = true
      return response
    }
    if (url.pathname === `/session/${sessionID}/message`) return json([])
    if (url.pathname === `/session/${sessionID}/todo` || url.pathname === `/session/${sessionID}/diff`) return json([])
    return undefined
  }, tmp.path)
  try {
    const hydrate = sync.session.sync(sessionID)
    // 等 HTTP 已发出再推进实时事件，避免测试只是比较两个顺序读取的快照。
    await wait(() => requested)
    emit(global({ id: "evt_usage", type: "session.updated", properties: { sessionID, info: current } }))
    // 300 条窗口仍需越界，持久 usage 的正确性不能靠取消 transcript 淘汰保证。
    for (let index = 0; index < 301; index++) {
      const info = { ...assistant, id: `msg_usage_${index}`, time: { created: index, completed: index + 1 } }
      emit(global({ id: `evt_usage_${index}`, type: "message.updated", properties: { sessionID, info } }))
      emit(
        global({
          id: `evt_usage_part_${index}`,
          type: "message.part.updated",
          properties: {
            sessionID,
            time: index,
            part: { id: `prt_usage_${index}`, sessionID, messageID: info.id, type: "text", text: "visible" },
          },
        }),
      )
    }
    // 窗口满后长度不再增长，等待第 301 条证明淘汰实际发生。
    await wait(() => sync.data.message[sessionID]?.some((item) => item.id === "msg_usage_300") ?? false)
    // GET 保留旧零值；若 hydration 覆盖了较新事件，本断言会观察到倒退。
    resolveSession(
      json({ ...current, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }),
    )
    await hydrate
    expect(sync.session.get(sessionID)?.tokens).toEqual(current.tokens)
    expect(sync.session.get(sessionID)?.cost).toBe(1)
    expect(sync.data.message[sessionID]).toHaveLength(300)
    // 连 parts 也必须随最老消息回收，不能把完整 transcript 偷藏在 part store。
    expect(sync.data.part.msg_usage_0).toBeUndefined()
    expect(sync.data.message[sessionID].some((item) => item.id === "msg_usage_0")).toBe(false)
  } finally {
    app.renderer.destroy()
  }
})

// #162：窗口扩大后仍必须真正越界，验证实时合并与最旧 parts 的淘汰。
// #290：窗口 300 后越界种子同步升至 300，断言仍锁定最旧淘汰
test("live messages merged during hydration retain the 300 message window", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")

  let resolveMessages!: (response: Response) => void
  const messages = new Promise<Response>((resolve) => {
    resolveMessages = resolve
  })
  let requested = false
  const { app, emit, sync } = await mount((url) => {
    if (url.pathname === `/session/${sessionID}`) return json(session)
    if (url.pathname === `/session/${sessionID}/message`) {
      requested = true
      return messages
    }
    if (url.pathname === `/session/${sessionID}/todo` || url.pathname === `/session/${sessionID}/diff`) return json([])
    return undefined
  }, tmp.path)

  try {
    const hydrate = sync.session.sync(sessionID)
    await wait(() => requested)
    const live = { ...assistant, id: "msg_z_live" }
    emit(global({ id: "evt_live", type: "message.updated", properties: { sessionID, info: live } }))
    await wait(() => sync.data.message[sessionID]?.some((message) => message.id === live.id) ?? false)
    resolveMessages(
      json(
        Array.from({ length: 300 }, (_, index) => {
          const id = `msg_${String(index).padStart(3, "0")}`
          return {
            info: { ...assistant, id },
            parts: [{ id: `prt_${id}`, sessionID, messageID: id, type: "text", text: id }],
          }
        }),
      ),
    )
    await hydrate

    expect(sync.data.message[sessionID]).toHaveLength(300)
    expect(sync.data.message[sessionID].at(-1)?.id).toBe(live.id)
    expect(sync.data.message[sessionID].some((message) => message.id === "msg_000")).toBe(false)
    expect(sync.data.part.msg_000).toBeUndefined()
  } finally {
    app.renderer.destroy()
  }
})

test("a message removed during hydration does not regain stale parts", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")

  let resolveMessages!: (response: Response) => void
  const messages = new Promise<Response>((resolve) => {
    resolveMessages = resolve
  })
  let requested = false
  const { app, emit, sync } = await mount((url) => {
    if (url.pathname === `/session/${sessionID}`) return json(session)
    if (url.pathname === `/session/${sessionID}/message`) {
      requested = true
      return messages
    }
    if (url.pathname === `/session/${sessionID}/todo` || url.pathname === `/session/${sessionID}/diff`) return json([])
    return undefined
  }, tmp.path)

  try {
    emit(global({ id: "evt_message", type: "message.updated", properties: { sessionID, info: assistant } }))
    await wait(() => sync.data.message[sessionID]?.length === 1)
    const hydrate = sync.session.sync(sessionID)
    await wait(() => requested)
    emit(global({ id: "evt_removed", type: "message.removed", properties: { sessionID, messageID } }))
    await wait(() => sync.data.message[sessionID]?.length === 0)
    resolveMessages(
      json([{ info: assistant, parts: [{ id: partID, sessionID, messageID, type: "text", text: "stale" }] }]),
    )
    await hydrate

    expect(sync.data.message[sessionID]).toEqual([])
    expect(sync.data.part[messageID]).toBeUndefined()
  } finally {
    app.renderer.destroy()
  }
})

test("hidden messages and parts survive stale session hydration", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const removed = { ...assistant, id: "msg_a", time: { created: 3, completed: 4 } }
  const absent = { ...assistant, id: "msg_absent", time: { created: 5, completed: 6 } }
  const unloaded = { ...assistant, id: "msg_unloaded", time: { created: 7, completed: 8 } }
  const live = { id: partID, sessionID, messageID, type: "text" as const, text: "visible live content" }
  const removedPart = { ...live, id: "prt_removed", text: "hidden part" }
  const absentPart = { ...live, id: "prt_absent", text: "absent part" }
  const unloadedPart = { ...live, id: "prt_unloaded", messageID: unloaded.id, text: "unloaded part" }
  const messagePart = { ...live, id: "prt_hidden_message", messageID: removed.id, text: "hidden message part" }

  let resolveMessages!: (response: Response) => void
  const messages = new Promise<Response>((resolve) => {
    resolveMessages = resolve
  })
  let requested = false
  const { app, emit, sync } = await mount((url) => {
    if (url.pathname === `/session/${sessionID}`) return json(session)
    if (url.pathname === `/session/${sessionID}/message`) {
      requested = true
      return messages
    }
    if (url.pathname === `/session/${sessionID}/todo` || url.pathname === `/session/${sessionID}/diff`) return json([])
    return undefined
  }, tmp.path)

  try {
    // 先填 store 再发请求；时间与 ID 反序，trace 只能由隐藏事件建立。
    for (const info of [assistant, removed]) {
      emit(global({ id: `evt_live_${info.id}`, type: "message.updated", properties: { sessionID, info } }))
    }
    for (const part of [live, removedPart, messagePart]) {
      emit(
        global({
          id: `evt_live_${part.id}`,
          type: "message.part.updated",
          properties: {
            sessionID,
            time: 2,
            part,
          },
        }),
      )
    }
    await wait(() => sync.data.part[removed.id]?.length === 1)
    expect(sync.data.message[sessionID].map((message) => message.id)).toEqual([messageID, removed.id])

    const hydrate = sync.session.sync(sessionID)
    await wait(() => requested)
    const hidden = { time: 9, reason: "undo" as const }
    for (const info of [
      { ...removed, hidden },
      { ...absent, hidden },
    ]) {
      emit(global({ id: `evt_hide_${info.id}`, type: "message.updated", properties: { sessionID, info } }))
    }
    for (const part of [
      { ...removedPart, hidden },
      { ...absentPart, hidden },
      { ...unloadedPart, hidden },
    ]) {
      emit(
        global({
          id: `evt_hide_${part.id}`,
          type: "message.part.updated",
          properties: {
            sessionID,
            time: 9,
            part,
          },
        }),
      )
    }
    // FIFO 标记证明隐藏事件已处理，再放行旧快照。
    emit(global({ id: "evt_hidden_ready", type: "todo.updated", properties: { sessionID, todos: [] } }))
    await wait(() => sync.data.todo[sessionID] !== undefined)
    expect(sync.data.message[sessionID].map((message) => message.id)).toEqual([messageID])
    expect(sync.data.part[messageID]).toEqual([live])

    resolveMessages(
      json([
        { info: assistant, parts: [absentPart, { ...live, text: "" }, removedPart] },
        { info: removed, parts: [messagePart] },
        { info: absent, parts: [] },
        { info: unloaded, parts: [unloadedPart] },
      ]),
    )
    await hydrate

    // 未触碰消息正常接收，已有正文保留；隐藏项和旧部件不得回填。
    expect(sync.data.message[sessionID].map((message) => message.id)).toEqual([messageID, unloaded.id])
    expect(sync.data.part[messageID]).toEqual([live])
    expect(sync.data.part[removed.id]).toBeUndefined()
    expect(sync.data.part[absent.id]).toBeUndefined()
    expect(sync.data.part[unloaded.id]).toEqual([])
  } finally {
    resolveMessages(json([]))
    app.renderer.destroy()
  }
})
