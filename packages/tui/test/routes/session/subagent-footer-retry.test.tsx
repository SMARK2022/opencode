/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { engine } from "@opentui/core"
import { testRender, useRenderer } from "@opentui/solid"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { onCleanup } from "solid-js"
import { tmpdir } from "../../fixture/fixture"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { createEventSource, createFetch, directory, json, wait } from "../../cli/cmd/tui/sync-fixture"
import { ArgsProvider } from "../../../src/context/args"
import { ExitProvider } from "../../../src/context/exit"
import { KVProvider } from "../../../src/context/kv"
import { PermissionProvider } from "../../../src/context/permission"
import { ProjectProvider } from "../../../src/context/project"
import { RouteProvider } from "../../../src/context/route"
import { SDKProvider } from "../../../src/context/sdk"
import { SyncProvider, useSync } from "../../../src/context/sync"
import { ThemeProvider } from "../../../src/context/theme"
import { TuiConfigProvider } from "../../../src/config"
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "../../../src/keymap"
import { DialogProvider } from "../../../src/ui/dialog"
import { ToastProvider } from "../../../src/ui/toast"
import { SubagentFooter } from "../../../src/routes/session/subagent-footer"

test("child footer consumes retry events and opens original error details", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const childID = "ses_footer_retry_child"
  const parentID = "ses_footer_retry_parent"
  const events = createEventSource()
  const child = {
    id: childID, parentID, projectID: "proj_test", directory,
    slug: "footer-retry", version: "1", title: "retry child (@permission-reviewer subagent)",
    time: { created: 1, updated: 1 },
  }
  // 沿真实SDK传输提供子会话身份，绝不直接修改Sync store来伪造可见状态。
  const calls = createFetch((url) => {
    if (url.pathname === "/session") return json([child])
    if (url.pathname === `/session/${childID}`) return json(child)
  }, events)
  let sync!: ReturnType<typeof useSync>
  function Probe() {
    sync = useSync()
    return <SubagentFooter />
  }
  function Harness() {
    const renderer = useRenderer()
    const config = createTuiResolvedConfig()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    onCleanup(registerOpencodeKeymap(keymap, renderer, config))
    // 只挂footer所需上下文；不导入App、Prompt或任何daemon/worker入口。
    return (
      <TestTuiContexts paths={{ state: tmp.path }}>
        <OpencodeKeymapProvider keymap={keymap}>
          <ArgsProvider><ExitProvider exit={() => {}}><KVProvider><ToastProvider>
            <RouteProvider initialRoute={{ type: "session", sessionID: childID }}>
              <TuiConfigProvider config={config}>
                <SDKProvider url="http://test" directory={directory} testTransport={{ fetch: calls.fetch, events: events.source }}>
                  <PermissionProvider><ProjectProvider><SyncProvider><ThemeProvider mode="dark">
                    <DialogProvider><Probe /></DialogProvider>
                  </ThemeProvider></SyncProvider></ProjectProvider></PermissionProvider>
                </SDKProvider>
              </TuiConfigProvider>
            </RouteProvider>
          </ToastProvider></KVProvider></ExitProvider></ArgsProvider>
        </OpencodeKeymapProvider>
      </TestTuiContexts>
    )
  }
  const app = await testRender(Harness, { width: 140, height: 16, footerHeight: 0, useThread: false })
  async function frame() {
    // Yoga与usage节流分别在渲染帧和时钟推进；等待实际帧而非只检查JSX源码。
    await Bun.sleep(60)
    for (let index = 0; index < 5; index++) await app.renderOnce()
    return app.captureCharFrame().split("\n")
  }
  function retry(id: string, message: string) {
    events.emit({ directory, project: "proj_test", payload: {
      id: `evt-${id}`, type: "session.status",
      properties: { sessionID: id, status: { type: "retry", attempt: 3, next: Date.now() + 9000, message } },
    } })
  }
  try {
    await wait(() => !!sync && sync.status === "complete")
    expect((await frame()).some((line) => line.includes("(details)"))).toBe(false)
    // 父会话重试不能污染当前child，permission-reviewer仍走同一个footer owner。
    retry(parentID, "Parent-only error")
    await wait(() => sync.data.session_status[parentID]?.type === "retry")
    expect((await frame()).join("\n")).not.toContain("Parent-only error")
    const original = "Short error\nline two"
    retry(childID, original)
    await wait(() => sync.data.session_status[childID]?.type === "retry")
    const rows = await frame()
    const footer = rows.find((line) => line.includes("(details)")) ?? ""
    expect(footer).toContain("Permission-Reviewer")
    expect(footer).toContain("Short error line two (details)")
    expect(footer).toMatch(/retry(?: in .+)? · #3/)
    expect(footer).toContain("Parent")
    expect(footer).toContain("Next")
    // 正在重试但尚无助手时仍有零值usage，诊断必须排在它前面。
    expect(footer.search(/[↑↓]/)).toBeGreaterThan(footer.indexOf("Short error"))
    const spans = app.captureSpans().lines.flatMap((line) => line.spans)
    const errorSpan = spans.find((span) => span.text.includes("Short error"))
    const detailsSpan = spans.find((span) => span.text.includes("(details)"))
    expect(errorSpan).toBeDefined()
    expect(detailsSpan).toBeDefined()
    expect(detailsSpan?.fg.toInts()).toEqual(errorSpan?.fg.toInts())
    const y = rows.findIndex((line) => line.includes("(details)"))
    const x = rows[y].indexOf("(details)") + 4
    // 坐标来自真实字符帧，经鼠标命中测试进入DialogAlert，不直接调用handler。
    app.renderer.clearSelection()
    await app.mockMouse.moveTo(x, y)
    await app.renderOnce()
    await app.mockMouse.click(x, y)
    const details = (await frame()).join("\n")
    expect(details).toContain("Retry Error")
    expect(details).toContain("Short error")
    expect(details).toContain("line two")
  } finally {
    // 同步销毁真实组件owner，停止retry clock并退订SDK事件，再分离headless engine。
    events.dispose()
    try { app.renderer.destroy() } finally { engine.detach() }
  }
})
