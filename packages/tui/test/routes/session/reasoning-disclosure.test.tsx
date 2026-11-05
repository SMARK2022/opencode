import { expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { testRender } from "@opentui/solid"
import { engine } from "@opentui/core"
import { createSignal } from "solid-js"
import type { ReasoningPart } from "@opencode-ai/sdk/v2"
import { TuiPathsProvider, TuiStartupProvider } from "../../../src/context/runtime"
import { KVProvider } from "../../../src/context/kv"
import { TuiConfigProvider } from "../../../src/config"
import { ThemeProvider } from "../../../src/context/theme"
import { RouteProvider } from "../../../src/context/route"
import { ReasoningRun, context } from "../../../src/routes/session"

function makePart(text: string, id = "prt_test", done = true): ReasoningPart {
  return { id, sessionID: "ses_test", messageID: "msg_test", type: "reasoning", text, time: { start: 0, end: done ? 10 : undefined } }
}

async function waitForFrame(app: Awaited<ReturnType<typeof testRender>>, predicate: (frame: string) => boolean) {
  // 手动renderer空闲时内置wait提前结束；主动驱动帧并等待真实KV/高亮I/O。
  for (let pass = 0; pass < 300; pass++) {
    await app.renderOnce()
    if (predicate(app.captureCharFrame())) return
    await Bun.sleep(10)
  }
  expect(predicate(app.captureCharFrame())).toBe(true)
}

async function setup() {
  const stateDir = path.join(tmpdir(), `reasoning-kv-${randomUUID()}`)
  await mkdir(stateDir, { recursive: true })
  await writeFile(path.join(stateDir, "kv.json"), JSON.stringify({ thinking_mode: "show" }))
  return stateDir
}

function Harness(props: { showThinking: () => boolean; parts: ReasoningPart[]; stateDir: string; width?: number; conceal?: () => boolean }) {
  // 响应式交互存储才能验证真实点击，不使用不会通知渲染的普通对象。
  const [interaction, setInteraction] = createSignal<Record<string, boolean>>({})
  const value = {
    get width() { return props.width ?? 60 },
    sessionID: "ses_test",
    conceal: () => props.conceal?.() ?? false,
    showThinking: props.showThinking,
    showTimestamps: () => false,
    showDetails: () => true,
    showGenericToolOutput: () => true,
    diffWrapMode: () => "word" as const,
    providers: () => new Map(),
    sync: {} as never,
    tui: {} as never,
    messageView: () => undefined,
    pinnedMessages: () => new Set<string>(),
    requestUsage: () => new Map(),
    markMessageDirty: () => {},
    interaction: {
      get: (key: string) => interaction()[key] ?? false,
      set: (key: string, value: boolean) => setInteraction((previous) => ({ ...previous, [key]: value })),
    },
  }
  return (
    <TuiPathsProvider value={{ cwd: "/work", home: "/home/t", state: props.stateDir, worktree: "/work" }}>
      <TuiStartupProvider value={{ skipInitialLoading: true }}>
        <KVProvider>
          <TuiConfigProvider config={{ theme: undefined } as never}>
            <ThemeProvider mode="dark" source={{ discover: async () => ({}) }}>
              <RouteProvider>
                <context.Provider value={value}>
                  <ReasoningRun parts={props.parts} />
                  <text>answer remains visible</text>
                </context.Provider>
              </RouteProvider>
            </ThemeProvider>
          </TuiConfigProvider>
        </KVProvider>
      </TuiStartupProvider>
    </TuiPathsProvider>
  )
}

test("done reasoning renders Thought header for short content", async () => {
  const stateDir = await setup()
  const app = await testRender(() => <Harness showThinking={() => true} parts={[makePart("第一行推理\n第二行推理")]} stateDir={stateDir} />, { width: 60, height: 30, useThread: false })
  try {
    await waitForFrame(app, (frame) => frame.includes("Thought"))
    expect(app.captureCharFrame()).not.toContain("展开查看完整推理")
  } finally {
    app.renderer.destroy()
    engine.detach()
  }
})

test("clicking short reasoning does not preset disclosure", async () => {
  const stateDir = await setup()
  const app = await testRender(() => <Harness showThinking={() => true} parts={[makePart("短内容")]} stateDir={stateDir} />, { width: 60, height: 30, useThread: false })
  try {
    await waitForFrame(app, (frame) => frame.includes("Thought"))
    const row = app.captureCharFrame().split("\n").findIndex((line) => line.includes("Thought"))
    await app.mockMouse.click(5, row)
    expect(app.captureCharFrame()).toContain("Thought")
    expect(app.captureCharFrame()).not.toContain("展开查看完整推理")
  } finally {
    app.renderer.destroy()
    engine.detach()
  }
})

test("visibility off hides header and body without hiding the answer", async () => {
  const stateDir = await setup()
  const app = await testRender(() => <Harness showThinking={() => false} parts={[makePart("隐藏推理")]} stateDir={stateDir} />, { width: 60, height: 30, useThread: false })
  try {
    await waitForFrame(app, (frame) => frame.includes("answer remains visible"))
    expect(app.captureCharFrame()).not.toContain("Thought")
    expect(app.captureCharFrame()).not.toContain("隐藏推理")
  } finally {
    app.renderer.destroy()
    engine.detach()
  }
})

test("real run preserves word-wrap, shared budget, streaming and conceal disclosure", async () => {
  const stateDir = await setup()
  const [visible, setVisible] = createSignal(true)
  const [conceal, setConceal] = createSignal(true)
  const [parts, setParts] = createSignal([makePart("short stream thought", "prt_test", false)])
  const app = await testRender(() => <Harness showThinking={visible} conceal={conceal} parts={parts()} width={21} stateDir={stateDir} />, { width: 31, height: 30, useThread: false })
  const click = async (label: string) => {
    const row = app.captureCharFrame().split("\n").findIndex((line) => line.includes(label))
    expect(row).toBeGreaterThanOrEqual(0)
    await app.mockMouse.click(5, row)
  }
  try {
    await waitForFrame(app, (frame) => frame.includes("short stream thought"))
    expect(app.captureCharFrame()).not.toContain("展开查看完整推理")
    await click("short stream thought")
    const grown = "short stream thought" + Array.from({ length: 6 }, (_, index) => `\nstream line ${index + 2}`).join("")
    setParts([makePart(grown, "prt_test", false)])
    await app.renderOnce()
    // 不等待最终toggle才检查首帧，避免漏掉流式增长时的短暂尾部泄漏。
    expect(app.captureCharFrame()).not.toContain("stream line 7")
    await waitForFrame(app, (frame) => frame.includes("展开查看完整推理"))
    setParts([makePart(grown)])
    await waitForFrame(app, (frame) => frame.includes("Thought") && frame.includes("展开查看完整推理"))
    expect(app.captureCharFrame()).not.toContain("stream line 7")

    // 此宽度下char-wrap仅五行而word-wrap超过五行，必须仍然提供真实展开入口。
    const wrapped = "abcdefghijkl 123456789012 longword12xx reasoningxxx abcdefghijkl 123456789012 longword12xx"
    setParts([makePart(wrapped)])
    await waitForFrame(app, (frame) => frame.includes("abcdefghijkl") && frame.includes("展开查看完整推理"))
    await click("展开查看完整推理")
    await waitForFrame(app, (frame) => frame.includes("收起推理"))
    // 内容完整性对照剥离恢复的左轨；轨道穿过折行不应被误认为 reasoning 正文丢失。
    expect(app.captureCharFrame().replace(/[┃\s]/g, "")).toContain(wrapped.replace(/\s/g, ""))
    await click("收起推理")
    setParts(Array.from({ length: 8 }, (_, index) => makePart(`mode source ${index + 1}`, index === 0 ? "prt_test" : `prt_${index}`)))
    await waitForFrame(app, (frame) => frame.includes("mode source 1") && frame.includes("展开查看完整推理"))
    expect(app.captureCharFrame()).not.toContain("mode source 8")
    await click("展开查看完整推理")
    await waitForFrame(app, (frame) => frame.includes("mode source 8") && frame.includes("收起推理"))
    setVisible(false)
    await waitForFrame(app, (frame) => frame.includes("answer remains visible") && !frame.includes("Thought"))
    setVisible(true)
    await waitForFrame(app, (frame) => frame.includes("mode source 8") && frame.includes("收起推理"))
    await click("收起推理")

    const privateURL = `private-url/${"hidden-path/".repeat(20)}image.png`
    setParts([makePart("visible first source"), makePart(`![](${privateURL})`, "prt_concealed")])
    await waitForFrame(app, (frame) => frame.includes("visible first source") && !frame.includes("展开查看完整推理"))
    expect(app.captureCharFrame()).not.toContain("private-url")
    setConceal(false)
    await waitForFrame(app, (frame) => frame.includes("private-url") && frame.includes("展开查看完整推理"))
    setConceal(true)
    await waitForFrame(app, (frame) => !frame.includes("private-url") && !frame.includes("展开查看完整推理"))
  } finally {
    app.renderer.destroy()
    engine.detach()
  }
})
