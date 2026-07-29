/** @jsxImportSource @opentui/solid */
import { Global } from "@opencode-ai/core/global"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { afterAll, expect, mock, test as baseTest } from "bun:test"
import { onCleanup, onMount } from "solid-js"
import type { Session as SessionInfo } from "@opencode-ai/sdk/v2"
import { ArgsProvider } from "@/cli/cmd/tui/context/args"
import { ExitProvider } from "@/cli/cmd/tui/context/exit"
import { KVProvider } from "@/cli/cmd/tui/context/kv"
import { LocalProvider } from "@/cli/cmd/tui/context/local"
import { ProjectProvider } from "@/cli/cmd/tui/context/project"
import { RouteProvider } from "@/cli/cmd/tui/context/route"
import { SDKProvider, type SDKTestTransport } from "@/cli/cmd/tui/context/sdk"
import { SyncProvider, useSync } from "@/cli/cmd/tui/context/sync"
import { ThemeProvider } from "@/cli/cmd/tui/context/theme"
import { TuiConfigProvider } from "@/cli/cmd/tui/context/tui-config"
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "@/cli/cmd/tui/keymap"
import { CommandPaletteProvider } from "@/cli/cmd/tui/context/command-palette"
import { createTuiResolvedConfig } from "../../../fixture/tui-runtime"
import { tmpdir } from "../../../fixture/fixture"
import { createEventSource, createFetch, directory, json } from "./sync-fixture"
import { DialogProvider, useDialog } from "../../../../src/cli/cmd/tui/ui/dialog"
import { ToastProvider } from "../../../../src/cli/cmd/tui/ui/toast"

// Solid 的 server test runtime 会让 scheduled.debounce 直接 no-op；只替换这一层
// 的 trailing timer，保留真实 DialogSessionList、SDK transport 和 renderer seam。
// timer 只恢复既有 150ms 提交契约，不放宽失败终态或改变请求顺序。
mock.module("@solid-primitives/scheduled", () => ({
  debounce: (callback: (value: string) => void, wait: number) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const schedule = (value: string) => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => callback(value), wait)
    }
    return Object.assign(schedule, { clear: () => timer && clearTimeout(timer) })
  },
  leadingAndTrailing: (_scheduler: unknown, callback: (...args: unknown[]) => void) => callback,
  throttle: (callback: (...args: unknown[]) => void) => callback,
}))

const { DialogSessionList } = await import("@/cli/cmd/tui/component/dialog-session-list")
// module mock 只服务本文件的 Solid server runtime，测试结束必须恢复全局模块注册。
afterAll(() => mock.restore())

// 用例共享原生 renderer，串行运行才能把输入、frame 和 cleanup 保持在同一生命周期内。
const test = baseTest.serial
const sessionID = "ses_search_failure"
const SPINNER = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/

test("title HTTP failure ends search without starting a scan", async () => {
  // schema-valid 503 必须在 Response.ok 分支终止；plain-text 503 会因 json() 误入 catch。
  // scan 故意 pending：若 early-return 缺失，组件会停在 Searching 而不是 Not Found。
  let releaseScan!: () => void
  const pendingScan = new Promise<Response>((resolve) => {
    releaseScan = () => resolve(json({ sessions: [], nextCursor: null, done: true }))
  })

  await withSessionList({
    title: () => json([], { status: 503 }),
    scan: () => pendingScan,
    run: async ({ app }) => {
      await enterSearch(app, "needle")
      const frame = await waitForFrame(app, (value) => value.includes("Not Found needle"))
      expect(frame).not.toContain("Search failed")
      expect(frame).not.toMatch(SPINNER)
    },
  })
  releaseScan()
})

test("scan HTTP failure stops later scans and preserves visible title hits", async () => {
  // 第一页 503 带 nextCursor；第二页若被请求会渲染 Forbidden later scan。
  // 公开 Spinner 先出现后消失，证明 complete 而不是停在 partial。
  let scanCount = 0
  await withSessionList({
    title: () => json([sessionInfo()]),
    scan: () => {
      scanCount += 1
      if (scanCount === 1) {
        return json(
          {
            sessions: [],
            nextCursor: { time_updated: 1, id: sessionID },
            done: false,
          },
          { status: 503 },
        )
      }
      return json({
        sessions: [sessionInfo({ id: "ses_forbidden_later", title: "Forbidden later scan" })],
        nextCursor: null,
        done: true,
      })
    },
    run: async ({ app }) => {
      await enterSearch(app, "needle")
      await waitForFrame(app, (value) => value.includes("Visible search session") && SPINNER.test(value))
      const frame = await waitForFrame(
        app,
        (value) => value.includes("Visible search session") && !SPINNER.test(value),
      )
      expect(frame).not.toContain("Forbidden later scan")
      expect(frame).not.toContain("Search failed")
    },
  })
})

test("successful empty search still shows Not Found", async () => {
  // 失败路径不得改写成功空结果文案；用户侧 empty 文案必须保持 Not Found。
  await withSessionList({
    title: () => json([]),
    scan: () => json({ sessions: [], nextCursor: null, done: true }),
    run: async ({ app }) => {
      await enterSearch(app, "needle")
      const frame = await waitForFrame(app, (value) => value.includes("Not Found needle"))
      expect(frame).not.toContain("Search failed")
      expect(frame).not.toMatch(SPINNER)
    },
  })
})

test("query edit aborts the previous title request signal", async () => {
  // 改词必须 abort 旧 transport；只观察公开 RequestInit.signal，不读组件私有状态。
  let oldSignal!: AbortSignal
  let oldTitleSeen!: () => void
  const oldTitleReady = new Promise<void>((resolve) => {
    oldTitleSeen = resolve
  })
  let newTitleSeen!: () => void
  const newTitleReady = new Promise<void>((resolve) => {
    newTitleSeen = resolve
  })

  await withSessionList({
    title: (_url, init) => {
      const signal = init?.signal
      if (!signal) throw new Error("title request missing AbortSignal")
      if (!oldSignal) {
        oldSignal = signal
        oldTitleSeen()
        return neverResponse(signal)
      }
      newTitleSeen()
      return json([sessionInfo({ title: "Fresh new result" })])
    },
    scan: () => json({ sessions: [sessionInfo({ title: "Fresh new result" })], nextCursor: null, done: true }),
    run: async ({ app }) => {
      await enterSearch(app, "old")
      await oldTitleReady
      await replaceFilter(app, "old", "new")
      await newTitleReady
      await waitFor(() => oldSignal.aborted)
      await waitForFrame(app, (value) => value.includes("Fresh new result") && !SPINNER.test(value))
    },
  })
})

test("late old title response cannot rewind a completed new query", async () => {
  // transport 故意忽略 abort 并迟到；post-await signal.aborted 必须挡住写回。
  let releaseOld!: (response: Response) => void
  const oldPending = new Promise<Response>((resolve) => {
    releaseOld = resolve
  })
  let titleCount = 0

  await withSessionList({
    title: (_url, init) => {
      titleCount += 1
      if (titleCount === 1) {
        const signal = init?.signal
        if (!signal) throw new Error("title request missing AbortSignal")
        return oldPending
      }
      return json([sessionInfo({ title: "Fresh new result" })])
    },
    scan: () => json({ sessions: [sessionInfo({ title: "Fresh new result" })], nextCursor: null, done: true }),
    run: async ({ app }) => {
      await enterSearch(app, "old")
      await waitFor(() => titleCount === 1)
      await replaceFilter(app, "old", "new")
      await waitForFrame(app, (value) => value.includes("Fresh new result") && !SPINNER.test(value))
      releaseOld(json([sessionInfo({ id: "ses_stale_old", title: "Stale old result" })]))
      await Bun.sleep(50)
      await app.renderOnce()
      const frame = app.captureCharFrame()
      expect(frame).toContain("Fresh new result")
      expect(frame).not.toContain("Stale old result")
      expect(frame).not.toMatch(SPINNER)
    },
  })
})

test(
  "disposed list does not start progressive search after closed-over refetch",
  async () => {
    // 生产 recover：dialog.replace 工厂卸载旧 list，旧闭包 onDelete 仍可能调用 refetchSearch。
    // 预创建 JSX 的 owner 不在 dialog stack，clear/replace 不会 dispose；必须 factory 挂载。
    let titleCount = 0
    let liveSignal!: AbortSignal
    let scanCount = 0
    let deleteCalls = 0
    let removeCalls = 0

    await withSessionList({
      title: (_url, init) => {
        titleCount += 1
        const signal = init?.signal
        if (!signal) throw new Error("title request missing AbortSignal")
        // 同一 controller 贯穿 title→scan；unmount 必须 abort 这个公开 signal。
        liveSignal = signal
        return json([sessionInfo({ workspaceID: "wrk_search" })])
      },
      scan: (_url, init) => {
        scanCount += 1
        const signal = init?.signal
        if (!signal) throw new Error("scan request missing AbortSignal")
        liveSignal = signal
        // scan 挂起，保证 replace 时仍有 live controller 可观察 abort。
        return neverResponse(signal)
      },
      fetch: (url, request, init) => {
        const method = (init?.method ?? request?.method ?? "GET").toUpperCase()
        if (url.pathname === "/experimental/workspace") {
          return json([
            {
              id: "wrk_search",
              name: "Broken workspace",
              projectID: "proj_test",
              directory: null,
              type: "local",
            },
          ])
        }
        if (url.pathname === "/experimental/workspace/status") {
          return json([{ workspaceID: "wrk_search", status: "error" }])
        }
        if (method === "DELETE" && url.pathname.startsWith("/session/")) {
          deleteCalls += 1
          return json({ error: "workspace unavailable" }, { status: 500 })
        }
        if (method === "DELETE" && url.pathname.startsWith("/experimental/workspace/")) {
          removeCalls += 1
          return json({ id: "wrk_search" })
        }
        return undefined
      },
      run: async ({ app }) => {
        await enterSearch(app, "needle")
        await waitForFrame(app, (value) => value.includes("Visible search session"))
        await waitFor(
          () => scanCount >= 1 && !!liveSignal && !liveSignal.aborted,
          4_000,
          `first scan live controller (scan=${scanCount} title=${titleCount})`,
        )

        // 两次 ctrl+d：确认删除；workspace 会话失败后 recover 会 replace 卸载旧 list。
        app.mockInput.pressKey("d", { ctrl: true })
        await waitForFrame(app, (value) => value.includes("again to confirm"), 4_000)
        app.mockInput.pressKey("d", { ctrl: true })
        await waitForFrame(app, (value) => value.includes("Failed to Delete Session"), 4_000)
        expect(deleteCalls).toBeGreaterThan(0)
        await waitFor(() => liveSignal.aborted, 4_000, "abort after recover dialog.replace")

        const titleBeforeRefetch = titleCount
        // recover 选项用 mouse seam 确认；return 可能仍被 filter/keymap 吃掉。
        await clickVisibleText(app, "Delete workspace")
        await waitFor(
          () => removeCalls > 0,
          4_000,
          `workspace remove after recover confirm (remove=${removeCalls} delete=${deleteCalls})`,
        )
        await Bun.sleep(100)
        await app.renderOnce()
        // disposed 后旧闭包 startSearch 必须 no-op；onDone 新 list 以空 search 挂载，不发 progressive title。
        expect(titleCount).toBe(titleBeforeRefetch)
      },
    })
  },
  { timeout: 30_000 },
)

async function withSessionList(input: {
  title: (url: URL, init?: RequestInit) => Response | Promise<Response>
  scan: (url: URL, init?: RequestInit) => Response | Promise<Response>
  fetch?: (url: URL, request?: Request, init?: RequestInit) => Response | Promise<Response> | undefined
  run: (context: {
    app: Awaited<ReturnType<typeof testRender>>
    dialog: ReturnType<typeof useDialog>
  }) => Promise<void>
}) {
  const previousState = Global.Path.state
  await using state = await tmpdir()
  Global.Path.state = state.path
  // KV 文件是 Local/Sync provider 的真实启动输入，不预置它会把测试失败误判为搜索失败。
  await Bun.write(`${state.path}/kv.json`, "{}")

  const events = createEventSource()
  const transport = createFetch((url, request, init) => {
    // title 与 scan 都从同一个真实 SDK transport 进入，避免只测函数级状态转换。
    if (url.pathname === "/session" && url.searchParams.get("searchMode") === "title") {
      return input.title(url, init)
    }
    if (url.pathname === "/session/search/scan") {
      return input.scan(url, init)
    }
    return input.fetch?.(url, request, init)
  })

  let sync!: ReturnType<typeof useSync>
  let dialog!: ReturnType<typeof useDialog>
  let ready!: () => void
  const mounted = new Promise<void>((resolve) => {
    ready = resolve
  })
  const app = await testRender(
    () => (
      <Harness
        fetch={transport.fetch}
        events={events.source}
        onReady={(nextSync, nextDialog) => {
          sync = nextSync
          dialog = nextDialog
          ready()
        }}
      />
    ),
    { width: 100, height: 20, footerHeight: 0, useThread: false },
  )

  try {
    await mounted
    // Sync complete 是公开 readiness signal，防止输入落在首轮 Session fetch 之前。
    await waitFor(() => sync.status === "complete", 2_000, `sync complete (status=${sync?.status})`)
    await input.run({ app, dialog })
  } finally {
    // 先停事件源再销毁 renderer，避免异步 bus 回调在 teardown 后写入 native frame。
    events.dispose()
    app.renderer.destroy()
    Global.Path.state = previousState
  }
}

async function enterSearch(app: Awaited<ReturnType<typeof testRender>>, text: string) {
  await waitForFrame(app, (frame) => frame.includes("Sessions"))
  // DialogSelect 在 ref 后延迟 1ms focus；等待真实 focus tick，避免文字被 renderer 丢弃。
  await Bun.sleep(10)
  await app.renderOnce()
  // 通过 renderer 的输入 seam 驱动 DialogSelect，不能直接调用组件内部的 onFilter。
  await app.mockInput.pasteBracketedText(text)
  await waitForFrame(app, (frame) => frame.includes(text))
}

async function replaceFilter(app: Awaited<ReturnType<typeof testRender>>, from: string, to: string) {
  for (let i = 0; i < from.length; i++) {
    app.mockInput.pressKey("BACKSPACE")
    await app.renderOnce()
  }
  await app.mockInput.pasteBracketedText(to)
  await waitForFrame(app, (frame) => frame.includes(to))
}

function neverResponse(signal: AbortSignal) {
  return new Promise<Response>((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Aborted", "AbortError"))
      return
    }
    signal.addEventListener(
      "abort",
      () => reject(new DOMException("Aborted", "AbortError")),
      { once: true },
    )
  })
}

async function waitFor(predicate: () => boolean, timeout = 2_000, label = "Session list signal") {
  const deadline = Date.now() + timeout
  // 轮询的是请求/同步状态等可观察信号，避免慢机器上的固定 sleep 竞态。
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`)
    await Bun.sleep(10)
  }
}

async function waitForFrame(
  app: Awaited<ReturnType<typeof testRender>>,
  predicate: (frame: string) => boolean,
  timeout = 2_000,
) {
  const deadline = Date.now() + timeout
  for (;;) {
    // frame 是用户可见的公共 seam；每轮主动 render 才能观察 deferred focus 和终态文本。
    await app.renderOnce()
    const frame = app.captureCharFrame()
    if (predicate(frame)) return frame
    if (Date.now() >= deadline) throw new Error(`timed out waiting for Session list frame:\n${frame}`)
    await Bun.sleep(10)
  }
}

async function clickVisibleText(app: Awaited<ReturnType<typeof testRender>>, text: string) {
  // mockMouse 使用当前 char frame 的 0-based 坐标；先落帧再点，避免点到旧布局。
  const frame = await waitForFrame(app, (value) => value.includes(text), 4_000)
  const rows = frame.split("\n")
  const y = rows.findIndex((row) => row.includes(text))
  if (y < 0) throw new Error(`missing clickable text ${JSON.stringify(text)}:\n${frame}`)
  const x = rows[y]!.indexOf(text)
  if (x < 0) throw new Error(`missing clickable text column ${JSON.stringify(text)}:\n${rows[y]}`)
  const targetX = x + Math.floor(text.length / 2)
  await app.mockMouse.moveTo(targetX, y)
  await app.mockMouse.click(targetX, y)
  await app.renderOnce()
}

function Harness(props: {
  fetch: typeof globalThis.fetch
  events: SDKTestTransport["events"]
  onReady: (sync: ReturnType<typeof useSync>, dialog: ReturnType<typeof useDialog>) => void
}) {
  const renderer = useRenderer()
  const config = createTuiResolvedConfig()
  // provider 顺序镜像 TUI 真实依赖：SDK/Project/Sync 先就绪，Dialog 再挂载 Session list。
  const keymap = createDefaultOpenTuiKeymap(renderer)
  onCleanup(registerOpencodeKeymap(keymap, renderer, config))

  return (
    <OpencodeKeymapProvider keymap={keymap}>
      <ArgsProvider>
        <ExitProvider>
          <KVProvider>
            <ToastProvider>
              <RouteProvider initialRoute={{ type: "home" }}>
                <TuiConfigProvider config={config}>
                  <SDKProvider url="http://test" directory={directory} testTransport={{ fetch: props.fetch, events: props.events }}>
                    <ProjectProvider>
                      <SyncProvider>
                        <ThemeProvider mode="dark">
                          <LocalProvider>
                            <DialogProvider>
                              <CommandPaletteProvider>
                                <OpenSessionList onReady={props.onReady} />
                              </CommandPaletteProvider>
                            </DialogProvider>
                          </LocalProvider>
                        </ThemeProvider>
                      </SyncProvider>
                    </ProjectProvider>
                  </SDKProvider>
                </TuiConfigProvider>
              </RouteProvider>
            </ToastProvider>
          </KVProvider>
        </ExitProvider>
      </ArgsProvider>
    </OpencodeKeymapProvider>
  )
}

function OpenSessionList(props: {
  onReady: (sync: ReturnType<typeof useSync>, dialog: ReturnType<typeof useDialog>) => void
}) {
  const dialog = useDialog()
  const sync = useSync()
  onMount(() => {
    props.onReady(sync, dialog)
    // 生产 app/recover 都传 factory；预创建 JSX 的 owner 不在 dialog stack，clear 不会 dispose。
    dialog.replace(() => <DialogSessionList />)
  })
  return null
}

function sessionInfo(extra: Partial<SessionInfo> = {}) {
  // fixture 使用稳定的 SessionID 与标题，响应体仍由 SDK test transport 通过公开 fetch 返回。
  return {
    id: sessionID,
    slug: "search-failure",
    projectID: "proj_test",
    directory,
    title: "Visible search session",
    version: "1.0.0",
    time: { created: 1, updated: 1 },
    ...extra,
  } satisfies SessionInfo
}
