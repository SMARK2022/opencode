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
import { BlockTool, context } from "../../../src/routes/session"

// shell 卡片互斥回归：preview 与 body 都含 "$ <command>"。#344 之前 preview 用
// maxHeight=0 隐藏，OpenTUI updateFromLayout 的 Math.max(layout.height, 1) 会泄漏
// 1 行，导致命令行同时出现在 preview 泄漏行与 body 中（双显）。

const stateDir = path.join(tmpdir(), `blocktool-once-kv-${randomUUID()}`)
await mkdir(stateDir, { recursive: true })
await writeFile(path.join(stateDir, "kv.json"), "{}")

function ShellCard(props: { command: string; output: string }) {
  // 预览始终申报，是否可见由容器折叠状态决定；interaction store 使用真实响应式对象。
  const [interaction, setInteraction] = createSignal<Record<string, boolean>>({})
  const text = `$ ${props.command}\n${props.output}`
  const value = {
    interaction: {
      get: (key: string) => interaction()[key] ?? false,
      set: (key: string, value: boolean) => setInteraction((previous) => ({ ...previous, [key]: value })),
    },
  } as never
  return (
    <TuiPathsProvider value={{ cwd: "/work", home: "/home/t", state: stateDir, worktree: "/work" }}>
      <TuiStartupProvider value={{ skipInitialLoading: true }}>
        <KVProvider>
          <TuiConfigProvider config={{ theme: undefined } as never}>
            <ThemeProvider mode="dark" source={{ discover: async () => ({}) }}>
              <RouteProvider>
                <context.Provider value={value}>
                  <BlockTool
                    title="bash"
                    autoReview={false}
                    totalLines={text.split("\n").length}
                    totalChars={text.length}
                    preview={<text>{`$ ${props.command}`}</text>}
                  >
                    <text>{text}</text>
                  </BlockTool>
                </context.Provider>
              </RouteProvider>
            </ThemeProvider>
          </TuiConfigProvider>
        </KVProvider>
      </TuiStartupProvider>
    </TuiPathsProvider>
  )
}

test("non-collapsed shell block shows command once", async () => {
  const app = await testRender(() => <ShellCard command="echo hello" output={"hello\n"} />, { width: 60, height: 40, useThread: false })
  try {
    await new Promise((resolve) => setTimeout(resolve, 100))
    await app.waitForFrame((frame) => frame.includes("$ echo hello"))
    // 短内容不满足 collapsible，申报的 preview 必须保持隐藏，不能与正文双显。
    expect(app.captureCharFrame()).not.toContain("Click to expand")
    // 无预览的初始展开态也只能显示一次命令。
    const rows = app.captureCharFrame().split("\n")
    expect(rows.filter((line) => line.includes("$ echo hello")).length).toBe(1)
  } finally {
    app.renderer.destroy()
    engine.detach()
  }
})

test("expanded shell block does not leak preview first row", async () => {
  const longOutput = Array.from({ length: 30 }, (_, index) => `line ${index}`).join("\n")
  const app = await testRender(() => <ShellCard command="echo test" output={longOutput} />, { width: 60, height: 40, useThread: false })
  try {
    await new Promise((resolve) => setTimeout(resolve, 100))
    await app.waitForFrame((frame) => frame.includes("Click to expand"))
    // 长输出初始只显示预览，随后通过真实点击切换到完整正文。
    expect(app.captureCharFrame()).not.toContain("line 29")
    await app.mockMouse.click(10, app.captureCharFrame().split("\n").findIndex((line) => line.includes("Click to expand")))
    await app.waitForFrame((frame) => frame.includes("Click to collapse"))
    // 展开态：只有 body 可见；preview 首行泄漏会让 "$ echo test" 出现 2 次。
    const rows = app.captureCharFrame().split("\n")
    // 展开后 preview 区 visible=false 且正文重建，命令行恰好出现一次即证明两区没有同时泄漏。
    expect(rows.filter((line) => line.includes("$ echo test")).length).toBe(1)
  } finally {
    app.renderer.destroy()
    // 命令互斥断言保留，同时确认窗口结束不会留下仍活着的native根。
    expect(app.renderer.root.isDestroyed).toBe(true)
    engine.detach()
  }
})
