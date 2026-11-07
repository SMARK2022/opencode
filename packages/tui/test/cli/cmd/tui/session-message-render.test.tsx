/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { MouseButton, Renderable, ScrollBoxRenderable, engine } from "@opentui/core"
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
function completedToolPart(id: string, messageID: string, tool: string, input: Record<string, unknown>, metadata: Record<string, unknown> = {}): Part {
  const part = toolPart(id, messageID, "")
  return { ...part, tool, state: { ...part.state, input, metadata } }
}
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
function messageFrame(app: App, id: string) {
  const root = messageRoot(app, id)
  // 按实际消息矩形裁帧，排除侧栏和滚动条；断言仍观察用户看到的字符，而非 border 属性。
  return app.captureCharFrame().split("\n").slice(root.screenY, root.screenY + root.height)
    .map((line) => line.slice(root.screenX, root.screenX + root.width).trimEnd())
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
function spanColor(app: App, text: string) {
  // 只读取用户可见颜色，不断言内部节点类型或复制高亮规则。
  return app.captureSpans().lines.flatMap((line) => line.spans).find((span) => span.text.includes(text))?.fg?.toInts()
}
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

// 同一真实 Session 入口覆盖可选说明和目录输入；预期标题直接取旧版合同，不复制格式化算法。
test.each([
  { input: { command: "echo done" }, title: "# Shell" },
  { input: { command: "echo done", description: "Inspect files" }, title: "# Inspect files" },
  { input: { command: "echo done", workdir: "." }, title: "# Shell" },
  { input: { command: "echo done", workdir: "src" }, title: "# Shell in src" },
  { input: { command: "echo done", description: "Inspect files", workdir: directory }, title: "# Inspect files in ." },
  { input: { command: "echo done", description: "Inspect src", workdir: "src" }, title: "# Inspect src" },
])("legacy shell title preserves intent and directory: $title", async (sample) => {
  const info = { ...assistant("msg_shell_title", 1), finish: "tool-calls" }
  const part = toolPart("part_shell_title", info.id, "done")
  await withRenderedSession([info], {
    [info.id]: [{ ...part, state: { ...part.state, input: sample.input } }],
  }, async (app) => {
    const frame = await waitForFrame(app, (value) => value.includes("$ echo done"))
    // 显式项目根目录仍应展示点；缺省目录和字面点继续沿用旧版省略规则。
    expect(frame).toContain(sample.title)
    expect(frame).not.toContain("Running in")
    expect(frame.split("$ echo done")).toHaveLength(2)
  })
})

test("legacy shell running animation labels intent while keeping the command visible", async () => {
  const info = { ...assistant("msg_shell_running", 1), finish: "tool-calls" }
  const part = { id: "part_shell_running", sessionID: sid, messageID: info.id, type: "tool", callID: "call_shell_running", tool: "bash",
    state: { status: "running", input: { command: "echo working", description: "Inspect files", workdir: "src" }, metadata: { output: "" }, time: { start: 1 } },
  } satisfies Part
  await withRenderedSession([info], { [info.id]: [part] }, async (app) => {
    const frame = await waitForFrame(app, (value) => value.includes("echo working"))
    // 只锁定动画承载的语义文字，不依赖定时器此刻选中了哪一个 spinner 字形。
    expect(frame).toContain("Inspect files in src")
    expect(frame).toContain("$ echo working")
  })
})

test("execute renders its child summary without a duplicate child tool row", async () => {
  const info = { ...assistant("msg_execute", 1), finish: "tool-calls" }
  const child = completedToolPart("part_execute_child", info.id, "read", { filePath: "child-audit-only.ts" })
  if (child.type !== "tool") throw new Error("Expected child tool")
  child.metadata = { executeParent: "execute" }
  await withRenderedSession([info], { [info.id]: [
    completedToolPart("part_execute", info.id, "execute", { code: "return 1" }, {
      toolCalls: [{ tool: "$opencode.read", status: "completed", input: { filePath: "from-parent.ts" } }],
    }), child,
  ] }, async (app) => {
    const frame = await waitForFrame(app, (value) => value.includes("from-parent.ts"))
    // 真实 Session 帧保留父工具的进度列表，持久化 child 只服务审计与归因。
    expect(frame).toContain("execute")
    expect(frame).not.toContain("child-audit-only.ts")
  })
})

test("legacy message rail continues through internal gaps and breaks between messages", async () => {
  const first = { ...assistant("msg_legacy_parts", 1), finish: "tool-calls" }
  const second = { ...assistant("msg_legacy_next", 2), finish: "tool-calls" }
  await withRenderedSession([first, second], {
    [first.id]: [textPart("part_legacy_text", first.id, "Legacy text"),
      completedToolPart("part_legacy_read", first.id, "read", { filePath: "alpha.ts" }),
      completedToolPart("part_legacy_grep", first.id, "grep", { pattern: "needle" }, { matches: 1 })],
    [second.id]: [textPart("part_legacy_next", second.id, "Next message")],
  }, async (app) => {
    await waitForFrame(app, (frame) => frame.includes('Grep "needle"') && frame.includes("Next message"))
    // 旧版帧的内部空行带消息线；单行连续工具紧排，跨消息的空行留在边框外。
    // 原生 text 的 padding 不额外占列，预期图标位置采用旧 JSX 实测值，避免凭属性重复加宽。
    expect(messageFrame(app, first.id)).toEqual([
      "┃   Legacy text", "┃", "┃   → Read alpha.ts", '┃   ✱ Grep "needle" (1 match)',
    ])
    expect(messageFrame(app, second.id)).toEqual(["┃   Next message"])
    const next = messageRoot(app, second.id)
    expect(app.captureCharFrame().split("\n")[next.screenY - 1].slice(next.screenX, next.screenX + next.width).trim()).toBe("")
  }, { width: 100, height: 24 })
})

test("legacy message first visible spacing follows hidden tools and partial searches live", async () => {
  const info = { ...assistant("msg_legacy_hidden", 1), finish: "tool-calls" }
  await withRenderedSession([info], {
    [info.id]: [textPart("part_legacy_empty", info.id, "  "),
      completedToolPart("part_legacy_hidden_read", info.id, "read", { filePath: "hidden.ts" }),
      textPart("part_legacy_visible", info.id, "After hidden"),
      completedToolPart("part_legacy_partial", info.id, "grep", { pattern: "needle" }, { matches: 0, partial: true })],
  }, async (app, _emit, ctx) => {
    await waitForFrame(app, (frame) => frame.includes("Read hidden.ts"))
    ctx.keymap.dispatchCommand("session.toggle.actions")
    await waitForFrame(app, (frame) => frame.includes("After hidden") && !frame.includes("Read hidden.ts"))
    // 真实详情开关移除前驱后，首个正文不应继承旧顶距；partial 搜索继续作为可见工具。
    expect(messageFrame(app, info.id)).toEqual([
      "┃   After hidden", "┃", '┃   ✱ Grep "needle" (0 matches, incomplete)',
    ])
  })
})

test.each([false, true])("legacy message reasoning chrome preserves newer Thought visibility: opaque=%s", async (opaque) => {
  const info = { ...assistant("msg_legacy_reasoning", 1), finish: "tool-calls" }
  const reasoning = { id: "part_legacy_reasoning", sessionID: sid, messageID: info.id, type: "reasoning",
    text: opaque ? "" : "Legacy reasoning", metadata: opaque ? { signature: "encrypted" } : undefined, time: { start: 1, end: 2 },
  } satisfies Part
  await withRenderedSession([info], {
    [info.id]: [reasoning, textPart("part_legacy_answer", info.id, "Visible answer")],
  }, async (app, _emit, ctx) => {
    await waitForFrame(app, (frame) => frame.includes("Thought") && frame.includes("Visible answer"))
    // 推理内部线属于旧样式；Thought/opaque 的可见性来自新版，不能因恢复首距而过滤掉。
    expect(messageFrame(app, info.id)[0].startsWith("┃┃")).toBe(true)
    expect(messageFrame(app, info.id).find((line) => line.includes("Visible answer"))).toBe("┃   Visible answer")
    ctx.keymap.dispatchCommand("session.toggle.thinking")
    await waitForFrame(app, (frame) => !frame.includes("Thought"))
    expect(messageFrame(app, info.id)).toEqual(["┃   Visible answer"])
  })
})

test("legacy message first multiline tool has no leading gap and separates following tools", async () => {
  const info = { ...assistant("msg_legacy_task", 1), finish: "tool-calls" }
  await withRenderedSession([info], {
    [info.id]: [completedToolPart("part_legacy_task", info.id, "task", { description: "Inspect tree", subagent_type: "general" }),
      completedToolPart("part_legacy_task_read", info.id, "read", { filePath: "alpha.ts" }, { loaded: ["beta.ts"] }),
      completedToolPart("part_legacy_task_grep", info.id, "grep", { pattern: "needle" }, { matches: 1 })],
  }, async (app) => {
    await waitForFrame(app, (frame) => frame.includes("Loaded beta.ts") && frame.includes('Grep "needle"'))
    // 兄弟间距在布局前消费上一帧的实测高度；等几何稳定后比较旧版静态帧，不以首帧文字出现代替布局完成。
    await stableHeight(app, sessionScrollBox(app, info.id))
    const rows = messageFrame(app, info.id)
    // 首块三态 false 覆盖多行工具的自分隔；后续工具仍按实际前驱高度决定间距。
    expect(rows[0]).toContain("Inspect tree")
    const read = rows.findIndex((line) => line.includes("Read alpha.ts"))
    expect(rows[read - 1]).toBe("┃")
    // Loaded 是 Read 的真实兄弟行，缩进应与完成态图标一致，后续单行 Grep 不额外隔行。
    expect(rows[read + 1]).toBe("┃   ↳ Loaded beta.ts")
    expect(rows[read + 2]).toBe('┃   ✱ Grep "needle" (1 match)')
  }, { width: 100, height: 24 })
})

test.each(["bash", "write", "write-overwrite", "edit", "apply_patch", "fixture_tool", "vscode_notebook_source"])("legacy card section gaps survive collapse and expand: %s", async (tool) => {
  const info = { ...assistant("msg_legacy_card", 1), finish: "tool-calls" }
  const output = Array.from({ length: 30 }, (_, index) => `card body line ${index}`).join("\n")
  // 合法 hunk 让 Edit/Patch 走真实 DiffView；其余工具走各自 source/output，不伪造共享 body。
  const diff = ["diff --git a/alpha.txt b/alpha.txt", "--- a/alpha.txt", "+++ b/alpha.txt", "@@ -1 +1,30 @@", "-old", ...output.split("\n").map((line) => `+${line}`)].join("\n")
  const input = tool === "bash" ? { command: "fixture" } : { filePath: "alpha.txt", content: output }
  const metadata = tool === "bash" ? { output }
    : tool === "write" ? { filepath: "alpha.txt" }
    : tool === "write-overwrite" ? { exists: true, diff }
    : tool === "edit" ? { diff }
    : tool === "apply_patch" ? { files: [{ type: "update", filePath: "alpha.txt", relativePath: "alpha.txt", deletions: 1, patch: diff }] }
    : tool === "vscode_notebook_source" ? { vscodeNotebook: { view: "source", path: "alpha.ipynb" } } : {}
  const part = toolPart("part_legacy_card", info.id, output)
  await withRenderedSession([info], { [info.id]: [{ ...part, tool: tool === "write-overwrite" ? "write" : tool, state: { ...part.state, input, metadata } }] }, async (app) => {
    await waitForFrame(app, (frame) => frame.includes("Click to expand"))
    let rows = messageFrame(app, info.id)
    // 共享 chrome 的留白必须在每一种卡片都成立，不能只由 Shell 的 body gap 偶然保证。
    expect(rows[rows.findIndex((line) => line.includes("Click to expand")) - 1].replaceAll("┃", "").trim()).toBe("")
    await click(app, "Click to expand")
    await waitForFrame(app, (frame) => frame.includes("Click to collapse") && frame.includes("card body line 29"))
    rows = messageFrame(app, info.id)
    expect(rows[rows.findIndex((line) => line.includes("Click to collapse")) - 1].replaceAll("┃", "").trim()).toBe("")
    // exists 与 diff 共同选中覆写卡片；该字面标题防止夹具误入新文件 Write 分支而假绿。
    if (tool === "write-overwrite") expect(app.captureCharFrame()).toContain("← Write alpha.txt (+30/-1)")
    // 再次收起只保留预览，既不双显 hint，也不把完整正文留在画面或截断十行之外。
    await click(app, "Click to collapse")
    await waitForFrame(app, (frame) => frame.includes("Click to expand") && !frame.includes("card body line 29"))
    expect(messageFrame(app, info.id).filter((line) => line.includes("Click to expand"))).toHaveLength(1)
  }, { width: 100, height: 60 })
})

test("new Write collapsed preview preserves expanded line numbers and syntax color", async () => {
  const info = { ...assistant("msg_write_source_preview", 1), finish: "tool-calls" }
  // 30 行 Markdown 触发真实折叠；普通正文尾行同时提供默认颜色和独立完整性标记。
  const content = ["# Canonical Implementation Plan", "", "> Status: audit-required",
    ...Array.from({ length: 26 }, (_, index) => `> Body line ${index + 4}`), "Body line 30"].join("\n")
  const part = completedToolPart("part_write_source_preview", info.id, "write", { filePath: "plan.md", content }, { filepath: "plan.md", exists: false })
  await withRenderedSession([info], { [info.id]: [part] }, async (app) => {
    await click(app, "Click to expand")
    // 尾部字面量不是算法推导值，能直接证明展开正文没有被 preview 预算截断。
    await waitForFrame(app, (frame) => frame.includes("Click to collapse") && frame.includes("Body line 30"))
    // 普通正文提供默认文本色，collapsed 即使提前完成高亮也不会破坏该同步条件。
    const bodyColor = spanColor(app, "Body line 30")
    expect(bodyColor).toBeDefined()
    const scroll = sessionScrollBox(app, info.id)
    // 展开会跟随尾部；回到消息顶部才能在同一公开视口读取标题行号和颜色。
    scroll.scrollBy(messageRoot(app, info.id).y - scroll.y - 1)
    await waitForFrame(app, () => {
      const line = app.captureCharFrame().split("\n").find((row) => row.includes("Canonical Implementation Plan"))
      return /\b1\s+# Canonical/.test(line ?? "") && spanColor(app, "Canonical Implementation Plan")?.join(",") !== bodyColor?.join(",")
    })
    // 展开态是已知正常表示，行号与颜色都作为折叠态的独立参照。
    const expandedLine = app.captureCharFrame().split("\n").find((line) => line.includes("Canonical Implementation Plan"))
    expect(expandedLine).toMatch(/\b1\s+# Canonical/)
    const expectedColor = spanColor(app, "Canonical Implementation Plan")
    expect(expectedColor).toBeDefined()

    scroll.scrollTo(scroll.scrollHeight)
    await click(app, "Click to collapse")
    await waitForFrame(app, (frame) => frame.includes("Click to expand") && !frame.includes("Body line 30"))
    scroll.scrollBy(messageRoot(app, info.id).y - scroll.y - 1)
    // 轮询公开帧等待异步高亮，避免固定 sleep 或首帧未落地造成假绿。
    await waitForFrame(app, () => {
      const line = app.captureCharFrame().split("\n").find((row) => row.includes("Canonical Implementation Plan"))
      return /\b1\s+# Canonical/.test(line ?? "") && spanColor(app, "Canonical Implementation Plan")?.join(",") === expectedColor?.join(",")
    })
    const collapsedLine = app.captureCharFrame().split("\n").find((line) => line.includes("Canonical Implementation Plan"))
    // 同一断言覆盖行号、语法色和十行预算，防止只恢复部分视觉合同。
    expect({
      numbered: /\b1\s+# Canonical/.test(collapsedLine ?? ""),
      color: spanColor(app, "Canonical Implementation Plan"),
      bounded: !app.captureCharFrame().includes("Body line 30"),
    }).toEqual({ numbered: true, color: expectedColor, bounded: true })

    // 再次展开验证 preview 驻留不妨碍 BlockTool 重建完整 body。
    await click(app, "Click to expand")
    await waitForFrame(app, (frame) => frame.includes("Click to collapse") && frame.includes("Body line 30"))
  }, { width: 100, height: 60 })
})

test.each([false, true])("legacy patch card gaps inherit one Part margin: afterText=%s", async (afterText) => {
  const info = { ...assistant("msg_legacy_patch", 1), finish: "tool-calls" }
  const part = completedToolPart("part_legacy_patch", info.id, "apply_patch", {}, {
    files: ["alpha.txt", "beta.txt"].map((file) => ({ type: "delete", filePath: file, relativePath: file, deletions: 1 })),
  })
  await withRenderedSession([info], { [info.id]: [...(afterText ? [textPart("part_patch_intro", info.id, "Patch follows")] : []), part] }, async (app) => {
    await waitForFrame(app, (frame) => frame.includes("# Deleted beta.txt"))
    const rows = messageFrame(app, info.id)
    const first = rows.findIndex((line) => line.includes("# Deleted alpha.txt"))
    const second = rows.findIndex((line) => line.includes("# Deleted beta.txt"))
    // 旧版三态归整个 Part；首块时每张卡片都是零外距，正文后则每张卡片各有一行外距。
    expect(second - first).toBe(afterText ? 6 : 5)
    expect(rows[first - 1]).toBe("┃┃")
    expect(rows.filter((line) => line.includes("-1 line"))).toHaveLength(2)
  })
})

test("legacy shell context view keeps the intent directory title and one command", async () => {
  const info = { ...assistant("msg_shell_context", 1), finish: "tool-calls" }
  const part = toolPart("part_shell_context", info.id, "terminal output", "model output")
  await withRenderedSession([info], {
    [info.id]: [{ ...part, state: { ...part.state, input: { command: "fixture", description: "Inspect files", workdir: "src" } } }],
  }, async (app) => {
    const frame = await waitForFrame(app, (value) => value.includes("$ fixture"))
    const row = frame.split("\n").findIndex((line) => line.includes("$ fixture"))
    await app.mockMouse.click(messageRoot(app, info.id).screenX + 5, row, MouseButton.RIGHT)
    await waitForFrame(app, (value) => value.includes("returned to model"))
    // 右键只切换结果视图；原调用意图、目录与命令仍是同一份输入事实。
    expect(app.captureCharFrame()).toContain("# Inspect files in src · returned to model")
    expect(app.captureCharFrame().split("$ fixture")).toHaveLength(2)
    expect(app.captureCharFrame()).toContain("model output")
  })
})

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
    await waitForFrame(app, () => { const current = scroll.scrollHeight; stable = current === last ? stable + 1 : 0; last = current; return stable >= 2 && anchor.y - scroll.y === 0 && released(app, fixture.messages[0].id) })
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

test.each([false, true])("session keeps every resize frame stable with released content=%s", async (shelled) => {
  const fixture = windowFixture("stable")
  await withRenderedSession(fixture.messages, fixture.parts, async (app, _emit, ctx) => {
    await waitForFrame(app, (frame) => frame.includes("stable assistant 23"))
    const scroll = sessionScrollBox(app, fixture.messages[0].id)
    if (shelled) await withFakeNow(async (advance) => {
      advance(AGE)
      await pumpFrames(app, 8)
      expect(released(app, fixture.messages[0].id)).toBe(true)
    })
    const reader = messageRoot(app, "msg_window_user_20")
    scroll.scrollBy(reader.y - scroll.viewport.y)
    await waitForFrame(app, () => reader.y - scroll.viewport.y === 0)
    const previousMax = scroll.scrollHeight - scroll.viewport.height
    const previousTop = scroll.scrollTop
    // 前方增长必须跨旧剩余到底距离，才能暴露补偿被帧后贴底误覆盖。
    app.resize(40, 24)
    let movement = 0
    for (let frame = 0; frame < 100; frame++) {
      if (frame === 15) {
        ctx.keymap.dispatchCommand("session.line.down")
        movement = 1
      }
      await app.renderOnce()
      await new Promise<void>((resolve) => process.nextTick(resolve))
      // 每一帧都检查，不等重测结束后才恢复；已经接受的用户位移必须保留。
      expect(reader.y - scroll.viewport.y).toBe(0 - movement)
    }
    expect(scroll.scrollTop - previousTop).toBeGreaterThan(previousMax - previousTop)
    expect(app.captureCharFrame()).toContain("stable user 20")
    ctx.keymap.dispatchCommand("session.last")
    await waitForFrame(app, (frame) => frame.includes("stable assistant 23"))
  })
})

test("session preserves selected text while a preceding message grows", async () => {
  const fixture = windowFixture("selection")
  await withRenderedSession(fixture.messages, fixture.parts, async (app, emit) => {
    await waitForFrame(app, (frame) => frame.includes("selection assistant 23"))
    const scroll = sessionScrollBox(app, fixture.messages[0].id)
    const reader = messageRoot(app, "msg_window_user_20")
    scroll.scrollBy(reader.y - scroll.viewport.y)
    await waitForFrame(app, () => reader.y - scroll.viewport.y === 0)
    const lines = app.captureCharFrame().split("\n")
    const y = lines.findIndex((line) => line.includes("selection user 20"))
    const x = lines[y].indexOf("selection user 20")
    await app.mockMouse.pressDown(x, y)
    await app.mockMouse.moveTo(x + "selection user 20".length, y)
    await app.mockMouse.release(x + "selection user 20".length, y)
    const selected = app.renderer.getSelection()?.getSelectedText()
    // 先证明选区非空，再沿真实Part事件改变前方正文，拒绝undefined对照假绿。
    expect(selected).toContain("selection user 20")
    emit(partUpdatedEvent("evt_selection_growth", textPart("part_window_user_00", fixture.messages[0].id, "selection user 00\n" + "extra line\n".repeat(60))))
    for (let frame = 0; frame < 20; frame++) {
      await app.renderOnce()
      await new Promise<void>((resolve) => process.nextTick(resolve))
      expect(reader.y - scroll.viewport.y).toBe(0)
      expect(app.renderer.getSelection()?.getSelectedText()).toBe(selected)
    }
  })
})
