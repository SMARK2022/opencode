/** @jsxImportSource @opentui/solid */
import { Renderable, engine } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { TuiPathsProvider, TuiStartupProvider } from "../../../src/context/runtime"
import { KVProvider } from "../../../src/context/kv"
import { TuiConfigProvider } from "../../../src/config"
import { ThemeProvider } from "../../../src/context/theme"
import { RouteProvider } from "../../../src/context/route"
import { BlockTool } from "../../../src/routes/session"

// preview存在性检查不能弃用刚构造的树；快照隔离其他测试遗留节点，只检查本次新增对象。
// 排空正常延迟销毁后沿父链查root，保留源测试的永久脱树泄漏判据。

const stateDir = path.join(tmpdir(), `blocktool-preview-kv-${randomUUID()}`)
await mkdir(stateDir, { recursive: true })
await writeFile(path.join(stateDir, "kv.json"), "{}")

function PreviewCard(props: { text: string }) {
  return (
    <TuiPathsProvider value={{ cwd: "/work", home: "/home/t", state: stateDir, worktree: "/work" }}>
      <TuiStartupProvider value={{ skipInitialLoading: true }}>
        <KVProvider>
          <TuiConfigProvider config={{ theme: undefined } as never}>
            <ThemeProvider mode="dark" source={{ discover: async () => ({}) }}>
              <RouteProvider>
                <BlockTool title="bash" autoReview={false} preview={<text>{props.text}</text>}>
                  <text>{`${props.text}\napplied`}</text>
                </BlockTool>
              </RouteProvider>
            </ThemeProvider>
          </TuiConfigProvider>
        </KVProvider>
      </TuiStartupProvider>
    </TuiPathsProvider>
  )
}

test("preview card mounts without leaking discarded preview tree", async () => {
  const before = new Set((Renderable as { renderablesByNumber: Map<number, unknown> }).renderablesByNumber.keys())
  const app = await testRender(() => <PreviewCard text="$ patch preview" />, {
    width: 60,
    height: 40,
    useThread: false,
  })
  try {
    // Provider 初始化（KV/主题）需要沉淀——与 block-tool-visible-once 同款 100ms。
    await new Promise((resolve) => setTimeout(resolve, 100))
    await app.waitForFrame((frame) => frame.includes("patch preview"))
    // 固定10轮20ms让正常nextTick销毁排空，避免把待销毁对象误判为永久泄漏。
    for (let i = 0; i < 10; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20))
      await app.renderOnce()
    }
    const detached: number[] = []
    for (const key of (Renderable as { renderablesByNumber: Map<number, Renderable> }).renderablesByNumber.keys()) {
      if (before.has(key)) continue
      // 父链深度界沿用源判据；仍存活但无法到root的对象才计为脱树泄漏。
      let node: Renderable | undefined = (
        Renderable as { renderablesByNumber: Map<number, Renderable> }
      ).renderablesByNumber.get(key)
      let top: Renderable | undefined = node
      for (let depth = 0; depth < 100 && top; depth++) {
        node = top
        top = (top as { parent?: Renderable }).parent
      }
      if (node !== app.renderer.root) detached.push(key)
    }
    expect(detached).toEqual([])
  } finally {
    app.renderer.destroy()
    // 预览只有一棵树；Provider卸载后其真实native根也应退休。
    expect(app.renderer.root.isDestroyed).toBe(true)
    engine.detach()
  }
})
