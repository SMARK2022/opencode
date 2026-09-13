/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { Renderable, ScrollBoxRenderable, engine } from "@opentui/core"
import { testRender, useRenderer } from "@opentui/solid"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { onCleanup, onMount } from "solid-js"
import type { Agent, AssistantMessage, GlobalEvent, Model, Part, Provider, UserMessage } from "@opencode-ai/sdk/v2"
import { Session } from "../../../../src/routes/session"
import { registerOpencodeSpinner } from "../../../../src/component/register-spinner"
import { ArgsProvider } from "../../../../src/context/args"
import { ClipboardProvider } from "../../../../src/context/clipboard"
import { DataProvider } from "../../../../src/context/data"
import { EditorContextProvider } from "../../../../src/context/editor"
import { ExitProvider } from "../../../../src/context/exit"
import { KVProvider } from "../../../../src/context/kv"
import { LocalProvider, useLocal } from "../../../../src/context/local"
import { LocationProvider } from "../../../../src/context/location"
import { PermissionProvider } from "../../../../src/context/permission"
import { ProjectProvider } from "../../../../src/context/project"
import { PromptRefProvider } from "../../../../src/context/prompt"
import { RouteProvider } from "../../../../src/context/route"
import { SDKProvider } from "../../../../src/context/sdk"
import { SyncProvider, useSync } from "../../../../src/context/sync"
import { ThemeProvider } from "../../../../src/context/theme"
import { TuiConfigProvider } from "../../../../src/config"
import { OpencodeKeymapProvider, registerOpencodeKeymap, useOpencodeKeymap } from "../../../../src/keymap"
import { createPluginRuntime, PluginRuntimeProvider } from "../../../../src/plugin/runtime"
import { DialogProvider } from "../../../../src/ui/dialog"
import { ToastProvider } from "../../../../src/ui/toast"
import { FrecencyProvider } from "../../../../src/component/prompt/frecency"
import { PromptHistoryProvider } from "../../../../src/component/prompt/history"
import { PromptStashProvider } from "../../../../src/component/prompt/stash"
import { tmpdir } from "../../../fixture/fixture"
import { TestTuiContexts } from "../../../fixture/tui-environment"
import { createTuiResolvedConfig } from "../../../fixture/tui-runtime"
import { createEventSource, createFetch, directory, json, worktree } from "./sync-fixture"

const sid = "ses_residency"
const model = { id: "model", providerID: "provider", api: { id: "model", url: "", npm: "" }, name: "Test Model",
  capabilities: { temperature: true, reasoning: false, attachment: true, toolcall: true,
    input: { text: true, audio: false, image: false, video: false, pdf: false },
    output: { text: true, audio: false, image: false, video: false, pdf: false }, interleaved: false },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } }, limit: { context: 100_000, output: 4_000 },
  status: "active", options: {}, headers: {}, release_date: "2024-01-01" } satisfies Model
const provider = { id: "provider", name: "Provider", source: "custom", env: [], options: {}, models: { model } } satisfies Provider
const agent = { name: "general", mode: "primary", permission: [], options: {} } satisfies Agent
const user = (id: string, created: number): UserMessage => ({ id, sessionID: sid, role: "user", time: { created }, agent: "general", model: { providerID: provider.id, modelID: model.id } })
const assistant = (id: string, created: number, parentID = "msg_user"): AssistantMessage => ({
  id, sessionID: sid, parentID, role: "assistant", agent: "general", mode: "general", modelID: model.id, providerID: provider.id,
  path: { cwd: directory, root: worktree }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created, completed: created + 1 }, finish: "stop",
})
const textPart = (id: string, messageID: string, text: string): Part => ({ id, sessionID: sid, messageID, type: "text", text })
const toolPart = (id: string, messageID: string, output: string, contextOutput = output) => ({ id, sessionID: sid, messageID, type: "tool", callID: id, tool: "bash",
  state: { status: "completed", input: { command: "fixture" }, output: contextOutput, title: "fixture", metadata: { output }, time: { start: 1, end: 2 } },
} satisfies Part)
type App = Awaited<ReturnType<typeof testRender>>
type Context = { sync: ReturnType<typeof useSync>; local: ReturnType<typeof useLocal>; keymap: ReturnType<typeof useOpencodeKeymap> }

async function withRenderedSession(messages: Array<UserMessage | AssistantMessage>, parts: Record<string, Part[]>,
  run: (app: App, emit: ReturnType<typeof createEventSource>["emit"], ctx: Context) => Promise<void>, size = { width: 80, height: 24 },
  override?: Parameters<typeof createFetch>[0]) {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, JSON.stringify({ thinking_mode: "show" }))
  const events = createEventSource()
  const info = { id: sid, directory, projectID: "proj_test", slug: sid, version: "1", title: sid, time: { created: 1, updated: 1 } }
  const calls = createFetch(async (url, request, init) => {
    const response = await override?.(url, request, init)
    if (response) return response
    if (url.pathname === "/session") return json([info])
    if (url.pathname === `/session/${sid}`) return json(info)
    if (url.pathname === `/session/${sid}/message`) return json(messages.map((message) => ({ info: message, parts: parts[message.id] ?? [] })))
    if (url.pathname.endsWith("/todo") || url.pathname.endsWith("/diff")) return json([])
    if (url.pathname.endsWith("/goal")) return json({})
    if (url.pathname === "/session/status") return json({ [sid]: { type: "idle" } })
    if (url.pathname === "/agent") return json([agent])
    if (url.pathname === "/config/providers") return json({ providers: [provider], default: { [provider.id]: model.id } })
    if (url.pathname === "/provider") return json({ all: [provider], default: { [provider.id]: model.id }, connected: [] })
    return undefined
  })
  let ctx: Context | undefined
  function Probe() {
    const value = { sync: useSync(), local: useLocal(), keymap: useOpencodeKeymap() }
    onMount(() => { ctx = value })
    return <Session />
  }
  function Harness() {
    const renderer = useRenderer()
    const config = createTuiResolvedConfig()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const runtime = createPluginRuntime()
    onCleanup(registerOpencodeKeymap(keymap, renderer, config))
    onCleanup(() => runtime.clear())
    // 挂真实Session，不启动app或插件host；驻留、跟随与重测仍由生产renderAfter驱动。
    return <TestTuiContexts paths={{ state: tmp.path }}><ClipboardProvider value={{ write: async () => {} }}>
      <OpencodeKeymapProvider keymap={keymap}><ArgsProvider><ExitProvider exit={() => {}}><KVProvider><ToastProvider>
      <RouteProvider initialRoute={{ type: "session", sessionID: sid }}><TuiConfigProvider config={config}>
      <PluginRuntimeProvider value={runtime}><SDKProvider url="http://test" directory={directory} testTransport={{ fetch: calls.fetch, events: events.source }}>
      <ProjectProvider><PermissionProvider><LocationProvider><DataProvider><SyncProvider>
      <ThemeProvider mode="dark" source={{ discover: async () => ({}) }}><LocalProvider><PromptStashProvider><DialogProvider>
      <FrecencyProvider><PromptHistoryProvider><PromptRefProvider><EditorContextProvider><Probe />
      </EditorContextProvider></PromptRefProvider></PromptHistoryProvider></FrecencyProvider></DialogProvider></PromptStashProvider></LocalProvider></ThemeProvider>
      </SyncProvider></DataProvider></LocationProvider></PermissionProvider></ProjectProvider></SDKProvider></PluginRuntimeProvider>
      </TuiConfigProvider></RouteProvider></ToastProvider></KVProvider></ExitProvider></ArgsProvider></OpencodeKeymapProvider>
      </ClipboardProvider></TestTuiContexts>
  }
  registerOpencodeSpinner()
  const app = await testRender(() => <Harness />, { ...size, footerHeight: 0, useThread: false })
  try {
    await waitForFrame(app, () => Boolean(ctx && ctx.sync.status === "complete" && ctx.local.model.ready && ctx.sync.data.message[sid]?.length))
    if (!ctx) throw new Error("Session harness did not mount")
    await run(app, events.emit, ctx)
  } finally {
    events.dispose()
    app.renderer.destroy()
    engine.detach()
  }
}

async function pumpFrames(app: App, rounds: number) {
  for (let i = 0; i < rounds; i++) {
    await app.renderOnce()
    await Promise.resolve()
    await new Promise((resolve) => process.nextTick(resolve))
    await Bun.sleep(0)
  }
}
async function waitForFrame(app: App, predicate: (frame: string) => boolean) {
  // 单调时钟保证受控推进Date.now时也有真实超时，不把等待变成无界循环。
  const start = performance.now()
  while (performance.now() - start < 5_000) {
    await pumpFrames(app, 1)
    const frame = app.captureCharFrame()
    if (predicate(frame)) return frame
  }
  throw new Error(`frame did not settle:\n${app.captureCharFrame()}`)
}
function messageRoot(app: App, id: string) {
  const root = app.renderer.root.findDescendantById(id)
  if (!root) throw new Error(`missing message root ${id}`)
  return root
}
function sessionScrollBox(app: App, id: string) {
  let node: Renderable | null = messageRoot(app, id).parent
  while (node && !(node instanceof ScrollBoxRenderable)) node = node.parent
  if (!node) throw new Error("missing Session scrollbox")
  return node
}
function contentNode(app: App, id: string) {
  const root = messageRoot(app, id)
  const stack = [root]
  while (stack.length) {
    const node = stack.pop()
    if (!node) break
    if (node !== root && "textBuffer" in node) return node
    stack.push(...node.getChildren())
  }
}
const released = (app: App, id: string) => contentNode(app, id) === undefined
async function stableHeight(app: App, scroll: ScrollBoxRenderable) {
  let last = -1
  let stable = 0
  await waitForFrame(app, () => { const current = scroll.scrollHeight; stable = current === last ? stable + 1 : 0; last = current; return stable >= 2 })
  return last
}
async function click(app: App, text: string) {
  const frame = await waitForFrame(app, (value) => value.includes(text))
  const row = frame.split("\n").findIndex((line) => line.includes(text))
  await app.mockMouse.click(5, row)
  // 普通按钮点击不是拖选测试；退休空选区，避免native mouse模拟把已展开卡片意外pin住。
  app.renderer.clearSelection()
}
function windowFixture(marker: string) {
  const messages: Array<UserMessage | AssistantMessage> = []
  const parts: Record<string, Part[]> = {}
  for (let index = 0; index < 24; index++) {
    const tag = String(index).padStart(2, "0")
    const first = user(`msg_window_user_${tag}`, index * 2 + 1)
    const second = assistant(`msg_window_assistant_${tag}`, index * 2 + 2, first.id)
    messages.push(first, second)
    parts[first.id] = [textPart(`part_window_user_${tag}`, first.id, `${marker} user ${tag}`)]
    parts[second.id] = [textPart(`part_window_assistant_${tag}`, second.id, `${marker} assistant ${tag} ${"wrap content ".repeat(18)}`)]
  }
  return { messages, parts }
}
async function withFakeNow(run: (advance: (milliseconds: number) => void) => Promise<void>) {
  const original = Date.now
  let now = original()
  Date.now = () => now
  try { await run((milliseconds) => { now += milliseconds }) } finally { Date.now = original }
}
const AGE = 31_000

test("tool card collapse and expand 100 times keeps identical frames and releases the body owner", async () => {
  const info = assistant("msg_hundred_toggle", 1)
  const output = Array.from({ length: 30 }, (_, index) => `hundred toggle line ${index}`).join("\n")
  await withRenderedSession([info], { [info.id]: [toolPart("part_hundred_toggle", info.id, output)] }, async (app) => {
    await click(app, "Click to expand")
    await waitForFrame(app, (frame) => frame.includes("Click to collapse"))
    await click(app, "Click to collapse")
    const baseline = await waitForFrame(app, (frame) => frame.includes("Click to expand"))
    const registry = (Renderable as { renderablesByNumber: Map<number, Renderable> }).renderablesByNumber
    const size = registry.size
    // 先预热再比较100轮稳态帧和真实renderable数，不能把visible隐藏误当资源销毁。
    for (let round = 0; round < 100; round++) {
      await click(app, "Click to expand")
      await waitForFrame(app, (frame) => frame.includes("hundred toggle line 15") && frame.includes("Click to collapse"))
      await click(app, "Click to collapse")
      expect(await waitForFrame(app, (frame) => frame.includes("Click to expand"))).toBe(baseline)
      expect(registry.size).toBe(size)
    }
  }, { width: 80, height: 40 })
})

test("offscreen messages release content after aging while roots geometry and expanded state stay exact", async () => {
  const fixture = windowFixture("window")
  fixture.parts[fixture.messages[1].id] = [toolPart("part_window_tool_00", fixture.messages[1].id, Array.from({ length: 30 }, (_, index) => `window expanded line ${index}`).join("\n"))]
  await withRenderedSession(fixture.messages, fixture.parts, async (app, _emit, ctx) => {
    await waitForFrame(app, (frame) => frame.includes("window assistant 23"))
    const scroll = sessionScrollBox(app, fixture.messages[47].id)
    ctx.keymap.dispatchCommand("session.first")
    await click(app, "Click to expand")
    const card = fixture.messages[1].id
    scroll.scrollBy(messageRoot(app, card).y - scroll.y - 1)
    await waitForFrame(app, (frame) => frame.includes("window expanded line 15"))
    const heights = fixture.messages.map((item) => [item.id, messageRoot(app, item.id).height])
    const fullHeight = await stableHeight(app, scroll)
    ctx.keymap.dispatchCommand("session.last")
    await waitForFrame(app, (frame) => frame.includes("window assistant 23") && frame.includes("window user 23"))
    await withFakeNow(async (advance) => {
      await pumpFrames(app, 3)
      expect(released(app, fixture.messages[0].id)).toBe(false)
      expect(released(app, card)).toBe(false)
      advance(AGE)
      const before = app.captureCharFrame()
      await pumpFrames(app, 8)
      // 根/逐根高度/滚动全长/可见帧同时不变，才能证明释放的是正文而非布局。
      expect({ user: released(app, fixture.messages[0].id), card: released(app, card) }).toEqual({ user: true, card: true })
      expect(await stableHeight(app, scroll)).toBe(fullHeight)
      expect(fixture.messages.map((item) => [item.id, messageRoot(app, item.id).height])).toEqual(heights)
      expect(app.captureCharFrame()).toBe(before)
    })
    ctx.keymap.dispatchCommand("session.first")
    scroll.scrollBy(messageRoot(app, card).y - scroll.y - 1)
    await waitForFrame(app, (frame) => frame.includes("window expanded line 15"))
    expect(released(app, card)).toBe(false)
    expect(await stableHeight(app, scroll)).toBe(fullHeight)
  })
})

test("durable update remeasures only the offscreen frozen message exactly", async () => {
  const fixture = windowFixture("stream")
  const target = "msg_window_user_04"
  await withRenderedSession(fixture.messages, fixture.parts, async (app, emit) => {
    await waitForFrame(app, (frame) => frame.includes("stream assistant 23"))
    const scroll = sessionScrollBox(app, fixture.messages[47].id)
    await withFakeNow(async (advance) => { advance(AGE); await pumpFrames(app, 8); expect(released(app, target)).toBe(true) })
    const fullHeight = await stableHeight(app, scroll)
    const height = messageRoot(app, target).height
    emit({ directory, project: "proj_test", payload: { id: "evt_stream_offscreen", type: "message.part.updated", properties: {
      sessionID: sid, part: textPart("part_window_user_04", target, "stream user 04\nsecond added line\nthird added line\nfourth added line"), time: Date.now(),
    } } } satisfies GlobalEvent)
    // 一行换四行，根高与scrollbar都恰好+3；不以全量重挂掩盖单条失效。
    await waitForFrame(app, () => scroll.scrollHeight === fullHeight + 3)
    expect(messageRoot(app, target).height).toBe(height + 3)
    scroll.scrollBy(messageRoot(app, target).y - scroll.y)
    await waitForFrame(app, (frame) => frame.includes("fourth added line"))
  })
})

test("selection dragged across screens keeps the traversed range alive for copy", async () => {
  const fixture = windowFixture("drag")
  await withRenderedSession(fixture.messages, fixture.parts, async (app, _emit, ctx) => {
    await waitForFrame(app, (frame) => frame.includes("drag assistant 23"))
    ctx.keymap.dispatchCommand("session.first")
    const initial = await waitForFrame(app, (frame) => frame.includes("drag user 00"))
    const scroll = sessionScrollBox(app, fixture.messages[0].id)
    const lines = initial.split("\n")
    const y0 = lines.findIndex((line) => line.includes("drag user 00"))
    const x0 = lines[y0].indexOf("drag user 00")
    const edge = scroll.viewport.screenY + scroll.viewport.height - 2
    await app.mockMouse.pressDown(x0, y0)
    let rows: string[] = []
    let y1 = -1
    for (let attempt = 0; attempt < 30 && y1 < 0; attempt++) {
      await app.mockMouse.moveTo(x0, edge)
      await pumpFrames(app, 1)
      rows = app.captureCharFrame().split("\n")
      y1 = rows.findIndex((line) => line.includes("drag user 06"))
      if (y1 < 0) ctx.keymap.dispatchCommand("session.message.next")
      await app.renderOnce()
    }
    expect(y1).toBeGreaterThanOrEqual(0)
    const x1 = rows[y1].indexOf("drag user 06") + 13
    await app.mockMouse.moveTo(x1, y1)
    await app.mockMouse.release(x1, y1)
    await pumpFrames(app, 1)
    expect(app.renderer.getSelection()?.getSelectedText()).toContain("drag user 00")
    expect(app.renderer.getSelection()?.getSelectedText()).toContain("drag user 06")
    await withFakeNow(async (advance) => {
      advance(AGE)
      ctx.keymap.dispatchCommand("session.last")
      await pumpFrames(app, 6)
      expect(app.captureCharFrame()).toContain("drag assistant 23")
      expect(released(app, "msg_window_user_00")).toBe(false)
      expect(released(app, "msg_window_user_06")).toBe(false)
      expect(app.renderer.getSelection()?.getSelectedText()).toContain("drag user 00")
      expect(app.renderer.getSelection()?.getSelectedText()).toContain("drag user 06")
      // 松开鼠标不等于清除选区；清除后重新计龄才能退休整段正文。
      app.renderer.clearSelection()
      advance(AGE)
      await pumpFrames(app, 8)
      expect(released(app, "msg_window_user_00")).toBe(true)
      expect(released(app, "msg_window_user_06")).toBe(true)
    })
  })
})

test("resize naturally reflows mounted content and remeasures shelled roots in batches", async () => {
  const fixture = windowFixture("resize")
  await withRenderedSession(fixture.messages, fixture.parts, async (app, _emit, ctx) => {
    await waitForFrame(app, (frame) => frame.includes("resize assistant 23"))
    const scroll = sessionScrollBox(app, fixture.messages[47].id)
    const before = await stableHeight(app, scroll)
    // 目标spacing owner按角色归一化间距，记录真实基线各相邻边；不恢复source统一+1的旧布局。
    const baseline = fixture.messages.map((item) => messageRoot(app, item.id))
    const gaps = baseline.slice(1).map((root, index) => root.y - baseline[index].y - baseline[index].height)
    const exact = () => {
      const roots = fixture.messages.map((item) => messageRoot(app, item.id))
      for (const [index, root] of roots.entries()) {
        expect(root.height).toBeGreaterThan(0)
        if (index > 0) expect(root.y).toBe(roots[index - 1].y + roots[index - 1].height + gaps[index - 1])
      }
      const children = scroll.getChildren()
      const last = children[children.length - 1]
      expect(scroll.scrollHeight).toBe(last.y + last.height - children[0].y)
    }
    app.resize(48, 24)
    await stableHeight(app, scroll)
    exact()
    expect(scroll.scrollHeight).toBeGreaterThan(before)
    expect(released(app, fixture.messages[0].id)).toBe(false)
    await withFakeNow(async (advance) => { advance(AGE); await pumpFrames(app, 8); expect(released(app, fixture.messages[0].id)).toBe(true) })
    const anchor = messageRoot(app, "msg_window_user_20")
    scroll.scrollBy(anchor.y - scroll.y)
    await waitForFrame(app, () => anchor.y - scroll.y === 0)
    app.resize(80, 24)
    let last = -1
    let stable = 0
    await waitForFrame(app, () => { const current = scroll.scrollHeight; stable = current === last ? stable + 1 : 0; last = current; return stable >= 2 && anchor.y - scroll.y === 0 })
    expect(anchor.y - scroll.y).toBe(0)
    exact()
    expect(released(app, fixture.messages[0].id)).toBe(true)
    ctx.keymap.dispatchCommand("session.last")
    await waitForFrame(app, (frame) => frame.includes("resize assistant 23"))
  })
})

test("scrolling within the residency budget performs zero content remounts", async () => {
  const fixture = windowFixture("parity")
  await withRenderedSession(fixture.messages, fixture.parts, async (app, _emit, ctx) => {
    await waitForFrame(app, (frame) => frame.includes("parity assistant 23"))
    ctx.keymap.dispatchCommand("session.first")
    await waitForFrame(app, (frame) => frame.includes("parity user 00"))
    const first = contentNode(app, "msg_window_user_00")
    const second = contentNode(app, "msg_window_assistant_01")
    expect(first).toBeDefined()
    expect(second).toBeDefined()
    for (let round = 0; round < 2; round++) {
      ctx.keymap.dispatchCommand("session.last")
      await waitForFrame(app, (frame) => frame.includes("parity assistant 23"))
      ctx.keymap.dispatchCommand("session.first")
      await waitForFrame(app, (frame) => frame.includes("parity user 00"))
    }
    expect(contentNode(app, "msg_window_user_00")).toBe(first)
    expect(contentNode(app, "msg_window_assistant_01")).toBe(second)
  })
})

test("content beyond the byte budget is evicted least-recently-rendered first", async () => {
  const fixture = windowFixture("budget")
  // 真实64MiB门槛不变；大模型输出参与记账，屏幕只展示短metadata.output。
  fixture.parts[fixture.messages[1].id] = [toolPart("part_budget_huge", fixture.messages[1].id, "small visible output", "x".repeat(64 * 1024 * 1024 + 1))]
  await withRenderedSession(fixture.messages, fixture.parts, async (app) => {
    await waitForFrame(app, (frame) => frame.includes("budget assistant 23"))
    await pumpFrames(app, 3)
    await waitForFrame(app, () => released(app, "msg_window_user_00"))
    expect(released(app, "msg_window_user_00")).toBe(true)
    expect(released(app, "msg_window_assistant_23")).toBe(false)
  })
})

function partUpdatedEvent(id: string, part: Part): GlobalEvent {
  return { directory, project: "proj_test", payload: { id, type: "message.part.updated", properties: { sessionID: part.sessionID, part, time: Date.now() } } }
}

test("task card acquires the child session when its id arrives after mount", async () => {
  const childID = "ses_task_late_child"
  const info = assistant("msg_task_late", 1)
  const task = { id: "part_task_late", sessionID: sid, messageID: info.id, type: "tool", callID: "call_task", tool: "task",
    state: { status: "running", input: { description: "late child" }, metadata: {}, time: { start: 1 } } } satisfies Part
  const childUser = { ...user("msg_task_late_child_user", 1), sessionID: childID }
  const childBase = toolPart("part_task_late_child_tool", childUser.id, "hi")
  const childTool = { ...childBase, sessionID: childID, state: { ...childBase.state, title: "child work" } }
  await withRenderedSession([info], { [info.id]: [task] }, async (app, emit) => {
    await waitForFrame(app, (frame) => frame.includes("late child"))
    expect(app.captureCharFrame().includes("child work")).toBe(false)
    // 不主动sync或导航：迟到ID必须由Task自身取得正文使用权。
    emit(partUpdatedEvent("evt_task_late_id", { ...task, state: { ...task.state, metadata: { sessionId: childID } } }))
    await waitForFrame(app, (frame) => frame.includes("child work"))
  }, undefined, (url) => {
    if (url.pathname === `/session/${childID}`) return json({ id: childID, parentID: sid, directory, projectID: "proj_test", slug: childID, version: "1", title: childID, time: { created: 1, updated: 1 } })
    if (url.pathname === `/session/${childID}/message`) return json([{ info: childUser, parts: [childTool] }])
    return undefined
  })
})

test("offscreen shell output growth re-measures the frozen height", async () => {
  const fixture = windowFixture("shellgrow")
  const target = fixture.messages[1].id
  // metadata写在state上；running Shell仅接受递增的progressVersion。
  const shell = { id: "part_shell_grow", sessionID: sid, messageID: target, type: "tool", callID: "call_shell", tool: "bash",
    state: { status: "running", input: { command: "echo growing" }, metadata: { output: "shellgrow initial", progressVersion: 1 }, time: { start: 1 } } } satisfies Part
  fixture.parts[target] = [shell]
  await withRenderedSession(fixture.messages, fixture.parts, async (app, emit) => {
    await waitForFrame(app, (frame) => frame.includes("shellgrow assistant 23"))
    const scroll = sessionScrollBox(app, fixture.messages[47].id)
    await withFakeNow(async (advance) => {
      advance(AGE)
      await pumpFrames(app, 8)
      expect(released(app, target)).toBe(true)
    })
    const before = await stableHeight(app, scroll)
    const heightBefore = messageRoot(app, target).height
    emit(partUpdatedEvent("evt_shell_grow", { ...shell, state: { ...shell.state, metadata: {
      output: "shellgrow initial\nsecond added line\nthird added line\nfourth added line", progressVersion: 2,
    } } }))
    // status、命令均不变，根高和滚动全长精确+3只能来自metadata正文的高度失效。
    await waitForFrame(app, () => scroll.scrollHeight === before + 3)
    expect(messageRoot(app, target).height).toBe(heightBefore + 3)
  })
})

test("mounted content growth counts toward the residency byte budget", async () => {
  const fixture = windowFixture("growth")
  const target = fixture.messages[1].id
  const growing = toolPart("part_growth_big", target, "small visible output", "small")
  fixture.parts[target] = [growing]
  await withRenderedSession(fixture.messages, fixture.parts, async (app, emit) => {
    await waitForFrame(app, (frame) => frame.includes("growth assistant 23"))
    await pumpFrames(app, 3)
    expect(released(app, "msg_window_user_00")).toBe(false)
    expect(released(app, target)).toBe(false)
    // 只增长模型output越过真实64MiB；短metadata输出不把大正文送入renderer。
    emit(partUpdatedEvent("evt_growth_big", { ...growing, state: { ...growing.state, output: "x".repeat(64 * 1024 * 1024 + 1) } }))
    // 不推进时钟，也不重挂目标；本轮驱逐必须由挂载中容量差额触发。
    await waitForFrame(app, () => released(app, "msg_window_user_00"))
    expect(released(app, "msg_window_user_00")).toBe(true)
    expect(released(app, "msg_window_assistant_23")).toBe(false)
  })
})
