/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import path from "path"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { onCleanup, onMount } from "solid-js"
import { DialogPrompt } from "@/cli/cmd/tui/ui/dialog-prompt"
import { TuiConfigProvider } from "@/cli/cmd/tui/context/tui-config"
import { ThemeProvider, useTheme } from "@/cli/cmd/tui/context/theme"
import { KVProvider } from "@/cli/cmd/tui/context/kv"
import { SDKProvider } from "@/cli/cmd/tui/context/sdk"
import { ToastProvider } from "@/cli/cmd/tui/ui/toast"
import { DialogProvider } from "@/cli/cmd/tui/ui/dialog"
import { useDialog } from "@/cli/cmd/tui/ui/dialog"
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "@/cli/cmd/tui/keymap"
import { createTuiResolvedConfig } from "../../../fixture/tui-runtime"
import { createEventSource, createFetch, directory } from "./sync-fixture"

function Harness() {
  // provider层和theme/KV层保持真实组合，避免用裸DialogPrompt掩盖owner缺少context的问题。
  const renderer = useRenderer()
  const config = createTuiResolvedConfig()
  const keymap = createDefaultOpenTuiKeymap(renderer)
  // 复用真实 SDK Provider，仅在传输边界隔离网络；Dialog 的语音依赖仍由正常 context 提供。
  const calls = createFetch()
  const events = createEventSource()
  // 显式绑定 owner 清理，异步订阅即使没有及时注销也不会保留跨测试的事件回调。
  onCleanup(() => events.dispose())
  // keymap注册的cleanup绑定renderer生命周期，测试结束不能留下全局intrinsic状态。
  onCleanup(registerOpencodeKeymap(keymap, renderer, config))

  return (
    <OpencodeKeymapProvider keymap={keymap}>
      <TuiConfigProvider config={config}>
        <KVProvider>
          <ThemeProvider mode="dark">
            <ToastProvider>
              <SDKProvider url="http://test" directory={directory} testTransport={{ fetch: calls.fetch, events: events.source }}>
                <DialogProvider>
                  <OpenPrompt />
                </DialogProvider>
              </SDKProvider>
            </ToastProvider>
          </ThemeProvider>
        </KVProvider>
      </TuiConfigProvider>
    </OpencodeKeymapProvider>
  )
}

function OpenPrompt() {
  // factory在dialog replace边界传入，测试不会直接求值description绕过组件owner。
  const dialog = useDialog()
  onMount(() =>
    dialog.replace(<DialogPrompt title="Prompt" description={() => <text>Factory description</text>} />),
  )
  return null
}

test("DialogPrompt renders the JSX returned by its description factory", async () => {
  const app = await testRender(() => (
    <box width={80} height={24}>
      <Harness />
    </box>
  ), { width: 80, height: 24 })
  try {
    // 轮询最终frame而非断言JSX对象，证明Solid reconciler确实完成了factory返回值的渲染。
    const timeout = Date.now() + 1_000
    let frame = ""
    while (Date.now() < timeout) {
      await app.renderOnce()
      frame = app.captureCharFrame()
      if (frame.includes("Factory description")) break
      await Bun.sleep(10)
    }
    // public prop承诺的是factory；只有owner求值后，其返回的JSX才应进入最终frame。
    // 如果回退到把函数当child，frame只会缺少文字或出现object coercion，不能通过该断言。
    expect(frame).toContain("Factory description")
  } finally {
    app.renderer.destroy()
  }
})

test("ThemeProvider releases superseded and current syntax styles", async () => {
  const mounted = Promise.withResolvers<ReturnType<typeof useTheme>>()
  function Probe() {
    mounted.resolve(useTheme())
    return null
  }
  const app = await testRender(() => (
    <box width={80} height={24}>
      <TuiConfigProvider config={createTuiResolvedConfig()}>
        <KVProvider>
          <ThemeProvider mode="dark">
            <Probe />
          </ThemeProvider>
        </KVProvider>
      </TuiConfigProvider>
    </box>
  ), { width: 80, height: 24 })
  try {
    // Provider 的 ready 门禁包含异步 KV/主题初始化；子组件挂载才是就绪信号。
    const theme = await mounted.promise
    // readiness signal 来自真实 Provider child，而不是固定 sleep，避免测试与异步初始化竞态。
    theme.setMode("dark")
    await app.renderOnce()
    await app.renderer.idle()
    // 两个公开 accessor 都求值，避免只验证未被消费的惰性 memo。
    for (const mode of ["light", "dark", "light"] as const) {
      const previous = [theme.syntax(), theme.subtleSyntax()]
      // 每次切换都同时保存旧/new pair，确保 replacement cleanup 不会误销毁当前样式。
      theme.setMode(mode)
      const current = [theme.syntax(), theme.subtleSyntax()]
      await app.renderOnce()
      await app.renderer.idle()
      // idle 后才检查旧 pair，确保断言的是 cleanup 完成而非调度尚未执行。
      // 旧样式失效与新样式仍可用必须同时成立，防止误销毁当前 owner。
      for (const style of previous) {
        expect(() => style.getRegisteredNames()).toThrow("NativeSyntaxStyle is destroyed")
      }
      // 旧 pair 必须失效而当前 pair 仍可读，分别验证释放与继续渲染两个方向。
      for (const style of current) {
        expect(style.getRegisteredNames().length).toBeGreaterThan(0)
      }
    }
    const current = [theme.syntax(), theme.subtleSyntax()]
    app.renderer.destroy()
    await app.renderer.idle()
    // Provider unmount 没有 memo replacement，cleanup 必须负责最后一对样式。
    // renderer 销毁触发 Provider cleanup，最后一对样式也不能留在 native registry。
    for (const style of current) {
      expect(() => style.getRegisteredNames()).toThrow("NativeSyntaxStyle is destroyed")
    }
  } finally {
    app.renderer.destroy()
  }
})

// INV-01：Dialog 必须显式选择 compact；formatter 单测无法覆盖该 call site。
test("DialogPrompt voice status call site selects compact profile", async () => {
  const source = await Bun.file(path.resolve(import.meta.dir, "../../../../src/cli/cmd/tui/ui/dialog-prompt.tsx")).text()
  expect(source).toMatch(/voiceInputStatusText\([\s\S]*?compact:\s*true/)
})
