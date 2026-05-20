import { expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { testRender } from "@opentui/solid"
import { engine } from "@opentui/core"
import { createSignal } from "solid-js"
import { TuiPathsProvider, TuiStartupProvider } from "../../../src/context/runtime"
import { KVProvider } from "../../../src/context/kv"
import { TuiConfigProvider } from "../../../src/config"
import { ThemeProvider } from "../../../src/context/theme"
import { RouteProvider } from "../../../src/context/route"
import { BlockTool } from "../../../src/routes/session"

// 回归测试：BlockTool 折叠→展开→再折叠→再展开后内容不能变为空白。
// 该 bug 由 OpenTUI renderable 销毁后无法重新挂载同一 JSX 对象引起，
// 修复方式为 preview/body 常驻挂载，隐藏态由 #344 起改用 visible 属性整体
// 不可见（maxHeight=0 会经 Math.max(height,1) 泄漏首行），而非 <Show> 卸载。
test("block tool keeps content after collapse and re-expand", async () => {
  // 24 行输出超过 threshold=20，确保 BlockTool 进入可折叠状态。
  // KV 预置空对象文件，避免 init 读缺失文件时的错误日志噪音。
  const stateDir = path.join(tmpdir(), `blocktool-kv-${randomUUID()}`)
  await mkdir(stateDir, { recursive: true })
  await writeFile(path.join(stateDir, "kv.json"), "{}")
  const output = Array.from({ length: 24 }, (_, index) => `source line ${index + 1}`).join("\n")
  // 组件边界记录真实挂载次数，不能把折叠后隐藏误当成首帧未挂载。
  let bodyMounts = 0
  function Body() {
    bodyMounts++
    return <text>{output}</text>
  }

  function Harness() {
    const [expanded, setExpanded] = createSignal(false)
    const preview = <text>PREVIEW-FRONT preview body PREVIEW-END</text>
    return (
      <TuiPathsProvider value={{ cwd: "/work", home: "/home/t", state: stateDir, worktree: "/work" }}>
        <TuiStartupProvider value={{ skipInitialLoading: true }}>
          <KVProvider>
            <TuiConfigProvider config={{ theme: undefined } as never}>
              <ThemeProvider mode="dark" source={{ discover: async () => ({}) }}>
                <RouteProvider>
                  <BlockTool
                    title="source · cell 3"
                    autoReview={false}
                    onClick={() => setExpanded((value) => !value)}
                    preview={expanded() ? undefined : preview}>
                    <Body />
                    <text>Click to collapse</text>
                  </BlockTool>
                </RouteProvider>
              </ThemeProvider>
            </TuiConfigProvider>
          </KVProvider>
        </TuiStartupProvider>
      </TuiPathsProvider>
    )
  }

  const app = await testRender(() => <Harness />, { width: 60, height: 40, useThread: false })
  const click = async (label: string) => {
    const row = app.captureCharFrame().split("\n").findIndex((line) => line.includes(label))
    expect(row).toBeGreaterThanOrEqual(0)
    await app.mockMouse.click(10, row)
  }

  // KV/theme 的 init 走真实文件 I/O（Flock + 读 kv.json），需要真实异步节拍后 ready 才置位。
  await new Promise((resolve) => setTimeout(resolve, 100))
  try {
    await app.waitForFrame((frame) => frame.includes("Click to expand"))

    // 初始折叠态：preview 可见，完整 body 被裁剪隐藏。
    let frame = app.captureCharFrame()
    expect(frame).toContain("PREVIEW-FRONT")
    expect(frame).not.toContain("source line 24")
    expect(bodyMounts).toBe(0)

    await click("Click to expand")
    await app.waitForFrame((f) => f.includes("Click to collapse"))
    frame = app.captureCharFrame()
    expect(frame).toContain("source line 24")
    expect(bodyMounts).toBe(1)

    await click("Click to collapse")
    await app.waitForFrame((f) => f.includes("Click to expand"))
    frame = app.captureCharFrame()
    expect(frame).not.toContain("source line 24")
    expect(bodyMounts).toBe(1)

    // 回归点：再展开后完整内容必须恢复——旧的 <Show> 卸载实现在此处会渲染空白。
    await click("Click to expand")
    await app.waitForFrame((f) => f.includes("Click to collapse"))
    frame = app.captureCharFrame()
    expect(frame).toContain("source line 24")
    expect(bodyMounts).toBe(1)
  } finally {
    app.renderer.destroy()
    engine.detach()
  }
})
