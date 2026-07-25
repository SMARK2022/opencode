/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { Global } from "@opencode-ai/core/global"
import { mkdir } from "fs/promises"
import path from "path"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { onCleanup, onMount } from "solid-js"
import { DialogPrompt } from "@/cli/cmd/tui/ui/dialog-prompt"
import { TuiConfigProvider } from "@/cli/cmd/tui/context/tui-config"
import { ThemeProvider } from "@/cli/cmd/tui/context/theme"
import { KVProvider } from "@/cli/cmd/tui/context/kv"
import { ToastProvider } from "@/cli/cmd/tui/ui/toast"
import { DialogProvider } from "@/cli/cmd/tui/ui/dialog"
import { useDialog } from "@/cli/cmd/tui/ui/dialog"
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "@/cli/cmd/tui/keymap"
import { createTuiResolvedConfig } from "../../../fixture/tui-runtime"

function Harness() {
  // provider层和theme/KV层保持真实组合，避免用裸DialogPrompt掩盖owner缺少context的问题。
  const renderer = useRenderer()
  const config = createTuiResolvedConfig()
  const keymap = createDefaultOpenTuiKeymap(renderer)
  // keymap注册的cleanup绑定renderer生命周期，测试结束不能留下全局intrinsic状态。
  onCleanup(registerOpencodeKeymap(keymap, renderer, config))

  return (
    <OpencodeKeymapProvider keymap={keymap}>
      <TuiConfigProvider config={config}>
        <KVProvider>
          <ThemeProvider mode="dark">
            <ToastProvider>
              <DialogProvider>
                <OpenPrompt />
              </DialogProvider>
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
  await mkdir(Global.Path.state, { recursive: true })
  // KVProvider 读取真实空快照，避免把首次挂载的缺失文件分支与 native renderer 行为混为同一变量。
  await Bun.write(path.join(Global.Path.state, "kv.json"), "{}")
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

// INV-01：Dialog 必须显式选择 compact；formatter 单测无法覆盖该 call site。
test("DialogPrompt voice status call site selects compact profile", async () => {
  const source = await Bun.file(path.resolve(import.meta.dir, "../../../../src/cli/cmd/tui/ui/dialog-prompt.tsx")).text()
  expect(source).toMatch(/voiceInputStatusText\([\s\S]*?compact:\s*true/)
})
