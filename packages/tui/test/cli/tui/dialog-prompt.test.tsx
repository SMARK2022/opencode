/** @jsxImportSource @opentui/solid */
import { TextareaRenderable } from "@opentui/core"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { onCleanup, onMount } from "solid-js"
import { tmpdir } from "../../fixture/fixture"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { createEventSource, createFetch, directory } from "../../fixture/tui-sdk"
import type { TuiKeybind } from "../../../src/config/keybind"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { SDKProvider } from "../../../src/context/sdk"

async function wait(fn: () => boolean, timeout = 2000) {
  // #296：单调时钟防墙钟跳变——同源 sdk.test.tsx 修复迁移到目标 helper owner
  const start = performance.now()
  while (!fn()) {
    if (performance.now() - start > timeout) throw new Error("timed out waiting for condition")
    await Bun.sleep(10)
  }
}

async function mountPrompt(input: {
  root: string
  keybinds: Partial<TuiKeybind.Keybinds>
  onConfirm: (value: string) => void
  onGenerate?: () => void
  onGlobalFirst?: () => void
}) {
  const state = path.join(input.root, "state")
  await mkdir(state, { recursive: true })
  await Bun.write(path.join(state, "kv.json"), "{}")

  const [
    { DialogProvider },
    { DialogPrompt },
    { KVProvider },
    { ThemeProvider },
    { TuiConfigProvider },
    { ToastProvider },
    { OpencodeKeymapProvider, registerOpencodeKeymap, useBindings },
  ] = await Promise.all([
    import("../../../src/ui/dialog"),
    import("../../../src/ui/dialog-prompt"),
    import("../../../src/context/kv"),
    import("../../../src/context/theme"),
    import("../../../src/config"),
    import("../../../src/ui/toast"),
    import("../../../src/keymap"),
  ])

  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const resolvedConfig = createTuiResolvedConfig({
      keybinds: input.keybinds,
      leader_timeout: 1000,
    })
    const off = registerOpencodeKeymap(keymap, renderer, resolvedConfig)
    onCleanup(off)
    function GlobalBindings() {
      // messages_first 是配置键，session.first 才是可执行 command，二者不能混用。
      // 独立全局 probe 能发现局部 binding 漏跑或错误吞键，而不是只检查 callback 被调用。
      useBindings(() => ({
        commands: [{
          name: "session.first",
          title: "Navigate to first message",
          category: "Messages",
          run: () => input.onGlobalFirst?.(),
        }],
        bindings: resolvedConfig.keybinds.get("session.first"),
      }))
      return null
    }
    // 复用真实 SDK Provider，仅在传输边界隔离网络；Dialog 的语音依赖仍由正常 context 提供。
    const calls = createFetch()
    const events = createEventSource()
    // 显式绑定 owner 清理，异步订阅即使没有及时注销也不会保留跨测试的事件回调。
    onCleanup(() => events.dispose())

    return (
      <TestTuiContexts
        directory={input.root}
        paths={{
          home: input.root,
          state,
          worktree: input.root,
        }}
      >
        <OpencodeKeymapProvider keymap={keymap}>
          {/* 只有需要验证全局行为的用例注册 probe，避免改变其他 DialogPrompt 基线。 */}
          {input.onGlobalFirst ? <GlobalBindings /> : null}
          <TuiConfigProvider config={resolvedConfig}>
            <KVProvider>
              <ThemeProvider mode="dark">
                <ToastProvider>
                  <SDKProvider url="http://test" directory={directory} testTransport={{ fetch: calls.fetch, events: events.source }}>
                    <DialogProvider>
                      <DialogPrompt
                        title="Rename Session"
                        value="draft"
                        onConfirm={input.onConfirm}
                        onGenerate={input.onGenerate}
                      />
                    </DialogProvider>
                  </SDKProvider>
                </ToastProvider>
              </ThemeProvider>
            </KVProvider>
          </TuiConfigProvider>
        </OpencodeKeymapProvider>
      </TestTuiContexts>
    )
  }

  const app = await testRender(() => <Harness />, { kittyKeyboard: true })
  return {
    app,
    async cleanup() {
      app.renderer.destroy()
    },
  }
}

test("dialog prompt submit wins when return is also input newline", async () => {
  await using tmp = await tmpdir()
  const confirmed: string[] = []
  const prompt = await mountPrompt({
    root: tmp.path,
    keybinds: {
      input_submit: "super+return",
      input_newline: "return,shift+return,alt+return,ctrl+j",
    },
    onConfirm: (value) => confirmed.push(value),
  })

  try {
    await wait(() => prompt.app.renderer.currentFocusedEditor instanceof TextareaRenderable)
    const textarea = prompt.app.renderer.currentFocusedEditor
    if (!(textarea instanceof TextareaRenderable)) throw new Error("expected focused dialog textarea")
    // 高度只改变显示窗口；内容回缩后原提交快捷键和草稿必须保持。
    await prompt.app.renderOnce()
    expect(textarea.height).toBe(3)
    textarea.setText(Array.from({ length: 20 }, (_, index) => `line ${index}`).join("\n"))
    await prompt.app.renderOnce()
    expect(textarea.height).toBe(15)
    textarea.setText("draft")
    await prompt.app.renderOnce()
    expect(textarea.height).toBe(3)

    prompt.app.mockInput.pressEnter()

    expect(confirmed).toEqual(["draft"])
    expect(textarea.plainText).toBe("draft")
  } finally {
    await prompt.cleanup()
  }
})

test("dialog prompt submit can be rebound separately from input submit", async () => {
  await using tmp = await tmpdir()
  const confirmed: string[] = []
  const prompt = await mountPrompt({
    root: tmp.path,
    keybinds: {
      input_submit: "return",
      "dialog.prompt.submit": "ctrl+y",
    },
    onConfirm: (value) => confirmed.push(value),
  })

  try {
    await wait(() => prompt.app.renderer.currentFocusedEditor instanceof TextareaRenderable)
    const textarea = prompt.app.renderer.currentFocusedEditor
    if (!(textarea instanceof TextareaRenderable)) throw new Error("expected focused dialog textarea")

    prompt.app.mockInput.pressEnter()
    expect(confirmed).toEqual([])
    expect(textarea.plainText).toBe("draft")

    prompt.app.mockInput.pressKey("y", { ctrl: true })

    expect(confirmed).toEqual(["draft"])
  } finally {
    await prompt.cleanup()
  }
})

test("dialog prompt generate stays local and renders the short label", async () => {
  await using tmp = await tmpdir()
  const generated: string[] = []
  const global: string[] = []
  const prompt = await mountPrompt({
    root: tmp.path,
    keybinds: { messages_first: "ctrl+g" },
    onConfirm: () => {},
    onGenerate: () => generated.push("generate"),
    onGlobalFirst: () => global.push("messages_first"),
  })

  try {
    await wait(() => prompt.app.renderer.currentFocusedEditor instanceof TextareaRenderable)
    await prompt.app.renderOnce()
    // 真实 frame 同时锁定短文案存在和 Generate Title 不存在，防止商业文案回退。
    // 快捷键断言与文案断言分离，任何一项缺失都不能靠另一项假绿。
    const frame = prompt.app.captureCharFrame()
    expect(frame).toContain("Generate")
    expect(frame).not.toContain("Generate Title")
    // 局部 Generate 必须执行一次，同时全局 session.first 必须保持零调用。
    prompt.app.mockInput.pressKey("g", { ctrl: true })
    expect(generated).toEqual(["generate"])
    expect(global).toEqual([])
  } finally {
    await prompt.cleanup()
  }
})

test("dialog prompt generate can be rebound", async () => {
  await using tmp = await tmpdir()
  const generated: string[] = []
  const global: string[] = []
  const prompt = await mountPrompt({
    root: tmp.path,
    // 覆盖配置把 Generate 移到 Ctrl+Y，验证默认键不是硬编码在生产组件内。
    keybinds: { messages_first: "ctrl+g", "dialog.prompt.generate": "ctrl+y" },
    onConfirm: () => {},
    onGenerate: () => generated.push("generate"),
    onGlobalFirst: () => global.push("messages_first"),
  })

  try {
    await wait(() => prompt.app.renderer.currentFocusedEditor instanceof TextareaRenderable)
    // rebind 后原 Ctrl+G 不再属于局部 action，全局命令应恢复处理该键。
    prompt.app.mockInput.pressKey("g", { ctrl: true })
    expect(generated).toEqual([])
    expect(global).toEqual(["messages_first"])
    // 新快捷键只触发 Generate，不能再落到全局 messages_first。
    prompt.app.mockInput.pressKey("y", { ctrl: true })
    expect(generated).toEqual(["generate"])
  } finally {
    await prompt.cleanup()
  }
})

test("dialog prompt without generate preserves the global shortcut", async () => {
  await using tmp = await tmpdir()
  const global: string[] = []
  // 未传 onGenerate 模拟其他既有 DialogPrompt，条件 binding 不得改变它们的全局快捷键。
  const prompt = await mountPrompt({
    root: tmp.path,
    keybinds: { messages_first: "ctrl+g" },
    onConfirm: () => {},
    onGlobalFirst: () => global.push("messages_first"),
  })

  try {
    await wait(() => prompt.app.renderer.currentFocusedEditor instanceof TextareaRenderable)
    await prompt.app.renderOnce()
    // 无 action 时连 footer 也不能出现 Generate，避免展示一个不可执行入口。
    expect(prompt.app.captureCharFrame()).not.toContain("Generate")
    // 同一 Ctrl+G 在没有局部注册时必须到达 session.first。
    prompt.app.mockInput.pressKey("g", { ctrl: true })
    await prompt.app.renderOnce()
    expect(global).toEqual(["messages_first"])
  } finally {
    await prompt.cleanup()
  }
})

test("DialogPrompt renders the JSX returned by its description factory", async () => {
  // #489：public prop 承诺的是 factory；只有 owner 求值后其返回的 JSX 才应进入最终 frame。
  // 若回退为把函数当 child，frame 会缺少文字或出现 object coercion，本断言即失败。
  await using tmp = await tmpdir()
  const state = path.join(tmp.path, "state")
  await mkdir(state, { recursive: true })
  await Bun.write(path.join(state, "kv.json"), "{}")

  const [
    { DialogProvider },
    { DialogPrompt },
    { KVProvider },
    { ThemeProvider },
    { TuiConfigProvider },
    { ToastProvider },
    { OpencodeKeymapProvider, registerOpencodeKeymap },
    { useDialog },
  ] = await Promise.all([
    import("../../../src/ui/dialog"),
    import("../../../src/ui/dialog-prompt"),
    import("../../../src/context/kv"),
    import("../../../src/context/theme"),
    import("../../../src/config"),
    import("../../../src/ui/toast"),
    import("../../../src/keymap"),
    import("../../../src/ui/dialog"),
  ])

    // 独立 OpenPrompt 组件保证 dialog.replace 发生在 provider 树挂载完成后（onMount 时机）。
  function OpenPrompt() {
    // factory 在 dialog replace 边界传入，测试不会直接求值 description 绕过组件 owner。
    const dialog = useDialog()
    onMount(() =>
      dialog.replace(<DialogPrompt title="Prompt" description={() => <text>Factory description</text>} />),
    )
    return null
  }

  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const resolvedConfig = createTuiResolvedConfig()
    const off = registerOpencodeKeymap(keymap, renderer, resolvedConfig)
    onCleanup(off)
    // DialogPrompt 读取 SDK context 组装语音上传；真实 Provider + 注入传输保持该依赖可见。
    const calls = createFetch()
    const events = createEventSource()
    onCleanup(() => events.dispose())

    return (
      <TestTuiContexts
        directory={tmp.path}
        paths={{
          home: tmp.path,
          state,
          worktree: tmp.path,
        }}
      >
        <OpencodeKeymapProvider keymap={keymap}>
          <TuiConfigProvider config={resolvedConfig}>
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
      </TestTuiContexts>
    )
  }

  // 固定 80x24 与轮询窗口：factory 渲染是异步 reconcile，不能假设首帧即包含文字。
  const app = await testRender(() => <Harness />, { width: 80, height: 24 })
  try {
    // 轮询最终 frame 而非断言 JSX 对象，证明 Solid reconciler 确实完成了 factory 返回值的渲染。
    const timeout = performance.now() + 2000
    let frame = ""
    while (performance.now() < timeout) {
      await app.renderOnce()
      frame = app.captureCharFrame()
      if (frame.includes("Factory description")) break
      await Bun.sleep(10)
    }
    expect(frame).toContain("Factory description")
  } finally {
    app.renderer.destroy()
  }
})

// INV-01：Dialog 必须显式选择 compact；formatter 单测无法覆盖该 call site。
test("DialogPrompt voice status call site selects compact profile", async () => {
  const source = await Bun.file(path.resolve(import.meta.dir, "../../../src/ui/dialog-prompt.tsx")).text()
  expect(source).toMatch(/voiceInputStatusText\([\s\S]*?compact:\s*true/)
})

// 主题切换后旧pair须在idle边界销毁，当前pair保持可读，退出再释放最后一对。
// TestTuiContexts与KVProvider提供真实初始化依赖，不以固定sleep假定ready。
test("ThemeProvider releases superseded and current syntax styles", async () => {
  await using tmp = await tmpdir()
  const state = path.join(tmp.path, "state")
  await mkdir(state, { recursive: true })
  await Bun.write(path.join(state, "kv.json"), "{}")

  const [{ ThemeProvider, useTheme }, { TuiConfigProvider }, { KVProvider }] = await Promise.all([
    import("../../../src/context/theme"),
    import("../../../src/config"),
    import("../../../src/context/kv"),
  ])

  // Provider 的 ready 门禁包含异步 KV/主题初始化；子组件挂载才是就绪信号。
  const mounted = Promise.withResolvers<ReturnType<typeof useTheme>>()
  function Probe() {
    mounted.resolve(useTheme())
    return null
  }

  function Harness() {
    return (
      <TestTuiContexts
        directory={tmp.path}
        paths={{
          home: tmp.path,
          state,
          worktree: tmp.path,
        }}
      >
        <TuiConfigProvider config={createTuiResolvedConfig()}>
          <KVProvider>
            <ThemeProvider mode="dark">
              <Probe />
            </ThemeProvider>
          </KVProvider>
        </TuiConfigProvider>
      </TestTuiContexts>
    )
  }

  const app = await testRender(() => <Harness />, { width: 80, height: 24 })
  try {
    // readiness signal 来自真实 Provider child，而不是固定 sleep，避免测试与异步初始化竞态。
    const theme = await mounted.promise
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
