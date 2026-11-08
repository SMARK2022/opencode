import { expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { testRender } from "@opentui/solid"
import { engine, MouseButton } from "@opentui/core"
import { createSignal, Show } from "solid-js"
import { TuiPathsProvider, TuiStartupProvider } from "../../../src/context/runtime"
import { KVProvider } from "../../../src/context/kv"
import { TuiConfigProvider } from "../../../src/config"
import { ThemeProvider } from "../../../src/context/theme"
import { RouteProvider } from "../../../src/context/route"
import { BlockTool, context } from "../../../src/routes/session"
import type { ToolPart } from "@opencode-ai/sdk/v2"

import { collapseToolOutput } from "../../../src/util/collapse-tool-output"
// 回归测试：BlockTool 折叠→展开→再折叠→再展开后内容不能变为空白。
// 折叠销毁正文，重开通过getter构造新树并恢复完整内容；preview仍复用，不能重复挂载已销毁对象。
// 原preview边界、完整正文与命令不双显断言全部保留。
test("block tool keeps content after collapse and re-expand", async () => {
  const stateDir = await createStateDir()
  const output = Array.from({ length: 24 }, (_, index) => `source line ${index + 1}`).join("\n")
  // 组件边界记录真实挂载次数，不能把折叠后隐藏误当成首帧未挂载。
  let bodyMounts = 0
  function Body() {
    bodyMounts++
    return <text>{output}</text>
  }

  const app = await testRender(() => (
    <SessionContent stateDir={stateDir}>
      <BlockTool
        title="source · cell 3"
        autoReview={false}
        // totals 只描述正文尺寸；24 行超过默认 20 行阈值，首帧必须直接挂载预览。
        totalLines={output.split("\n").length}
        totalChars={output.length}
        preview={<text>{collapseToolOutput(output, 10, 600, false).output}</text>}
      >
        <Body />
      </BlockTool>
    </SessionContent>
  ), { width: 60, height: 40, useThread: false })

  // KV/theme 的 init 走真实文件 I/O（Flock + 读 kv.json），需要真实异步节拍后 ready 才置位。
  await new Promise((resolve) => setTimeout(resolve, 100))
  try {
    await app.waitForFrame((frame) => frame.includes("Click to expand"))

    // 初始折叠态：preview 可见，完整 body 被裁剪隐藏。
    let frame = app.captureCharFrame()
    expect(frame).toContain("source line 10")
    expect(frame).not.toContain("source line 11")
    expect(frame).not.toContain("…")
    expect(frame).not.toContain("source line 24")
    expect(bodyMounts).toBe(0)

    await clickText(app, "Click to expand")
    await app.waitForFrame((f) => f.includes("Click to collapse"))
    frame = app.captureCharFrame()
    expect(frame).toContain("source line 24")
    expect(bodyMounts).toBe(1)

    await clickText(app, "Click to collapse")
    await app.waitForFrame((f) => f.includes("Click to expand"))
    frame = app.captureCharFrame()
    expect(frame).not.toContain("source line 24")
    expect(bodyMounts).toBe(1)

    // 回归点：再展开后完整内容必须恢复——旧的 <Show> 卸载实现在此处会渲染空白。
    await clickText(app, "Click to expand")
    await app.waitForFrame((f) => f.includes("Click to collapse"))
    frame = app.captureCharFrame()
    expect(frame).toContain("source line 24")
    // 第二次展开确实重建正文owner，而不是把隐藏误报成释放。
    expect(bodyMounts).toBe(2)
  } finally {
    app.renderer.destroy()
    engine.detach()
  }
})

function SessionContent(props: { stateDir: string; children: import("@opentui/solid").JSX.Element }) {
  // 响应式 interaction store 与生产 Session 同键同缺省值，才能验证真实点击与卸载重建。
  const [interaction, setInteraction] = createSignal<Record<string, boolean>>({})
  // BlockTool 在此 seam 只消费 interaction；上下文按真实读写字段提供，不复制无关 Session 状态。
  const value = {
    interaction: {
      get: (key: string) => interaction()[key] ?? false,
      set: (key: string, value: boolean) => setInteraction((previous) => ({ ...previous, [key]: value })),
    },
  } as never
  return (
    <TuiPathsProvider value={{ cwd: "/work", home: "/home/t", state: props.stateDir, worktree: "/work" }}>
      <TuiStartupProvider value={{ skipInitialLoading: true }}>
        <KVProvider>
          <TuiConfigProvider config={{ theme: undefined } as never}>
            <ThemeProvider mode="dark" source={{ discover: async () => ({}) }}>
              <RouteProvider>
                <context.Provider value={value}>{props.children}</context.Provider>
              </RouteProvider>
            </ThemeProvider>
          </TuiConfigProvider>
        </KVProvider>
      </TuiStartupProvider>
    </TuiPathsProvider>
  )
}

async function createStateDir() {
  // 每个用例使用独立 KV 目录，避免文件锁和历史配置把状态泄漏到其它渲染测试。
  const stateDir = path.join(tmpdir(), `blocktool-session-${randomUUID()}`)
  await mkdir(stateDir, { recursive: true })
  await writeFile(path.join(stateDir, "kv.json"), "{}")
  return stateDir
}

async function clickText(app: Awaited<ReturnType<typeof testRender>>, label: string) {
  // 通过真实鼠标坐标点击可见提示，不调用内部 setter，覆盖用户实际收放路径。
  const row = app.captureCharFrame().split("\n").findIndex((line) => line.includes(label))
  expect(row).toBeGreaterThanOrEqual(0)
  await app.mockMouse.click(10, row)
}

function errorPart(error: string, id = "prt_block_tool_error"): ToolPart {
  // 与 failToolCall 写入的 error 状态同形，确保测试进入真实 BlockTool 错误消费路径。
  return {
    ...completedPart(id),
    tool: "bash",
    state: {
      status: "error",
      input: { command: "fixture" },
      error,
      metadata: { output: "" },
      time: { start: 1, end: 2 },
    },
  }
}

test("block tool folds long body and tool error through one container", async () => {
  const stateDir = await createStateDir()
  const output = Array.from({ length: 24 }, (_, index) => `source line ${index + 1}`).join("\n")
  // 尾部独立标记直接证明长错误没有被全量直出；正文与错误只允许一个收放入口。
  const error = `${"x".repeat(6000)}TAIL-MARKER`
  const app = await testRender(() => (
    <SessionContent stateDir={stateDir}>
      <BlockTool
        title="shell"
        autoReview={false}
        part={errorPart(error)}
        totalLines={output.split("\n").length}
        totalChars={output.length}
        preview={<text>{collapseToolOutput(output, 10, 600, false).output}</text>}
      >
        <text>{output}</text>
      </BlockTool>
    </SessionContent>
  ), { width: 60, height: 160, useThread: false })
  try {
    await new Promise((resolve) => setTimeout(resolve, 100))
    await app.waitForFrame((frame) => frame.includes("Click to expand"))
    let frame = app.captureCharFrame()
    expect(frame).not.toContain("TAIL-MARKER")
    expect(frame.split("Click to expand")).toHaveLength(2)

    await clickText(app, "Click to expand")
    // 同一次点击必须同时恢复完整正文与完整错误，证明不存在错误专属第二状态。
    await app.waitForFrame((frame) => frame.includes("Click to collapse") && frame.includes("TAIL-MARKER") && frame.includes("source line 24"))

    await clickText(app, "Click to collapse")
    await app.waitForFrame((frame) => frame.includes("Click to expand") && !frame.includes("TAIL-MARKER"))
    frame = app.captureCharFrame()
    // 再收缩后仍只有一个入口，且完整错误尾部重新离开可见帧。
    expect(frame.split("Click to expand")).toHaveLength(2)
  } finally {
    app.renderer.destroy()
    engine.detach()
  }
})

test.each(["short ordinary error", "specified a rule"])("block tool keeps short error fully visible: %s", async (error) => {
  const stateDir = await createStateDir()
  const app = await testRender(() => (
    <SessionContent stateDir={stateDir}>
      <BlockTool title="shell" autoReview={false} part={errorPart(error)}>
        <text>short body</text>
      </BlockTool>
    </SessionContent>
  ), { width: 60, height: 30, useThread: false })
  try {
    await new Promise((resolve) => setTimeout(resolve, 100))
    // 短错误与短 denied 都属于未超预算输入，不能因错误状态出现折叠入口或截断。
    await app.waitForFrame((frame) => frame.includes(error) && frame.includes("short body"))
    const frame = app.captureCharFrame()
    // 两个输入分别覆盖普通失败与 denied 文案，防止只对某一种错误文本保留全显。
    expect(frame).not.toContain("Click to expand")
    expect(frame).not.toContain("Click to collapse")
  } finally {
    app.renderer.destroy()
    engine.detach()
  }
})

test("block tool folds long denied error with the same container budget", async () => {
  const stateDir = await createStateDir()
  const error = `specified a rule ${"d".repeat(1000)}DENIED-TAIL`
  const app = await testRender(() => (
    <SessionContent stateDir={stateDir}>
      <BlockTool title="shell" autoReview={false} part={errorPart(error)}>
        <text>short body</text>
      </BlockTool>
    </SessionContent>
  ), { width: 60, height: 50, useThread: false })
  try {
    await new Promise((resolve) => setTimeout(resolve, 100))
    // denied 文本不再拥有豁免分支；进入 BlockTool 后与其它超长内容使用同一预算。
    await app.waitForFrame((frame) => frame.includes("Click to expand"))
    // 独立的 denied 尾部标记能敏感识别任何恢复 denied 豁免分支的回退。
    expect(app.captureCharFrame()).not.toContain("DENIED-TAIL")
    await clickText(app, "Click to expand")
    await app.waitForFrame((frame) => frame.includes("Click to collapse") && frame.includes("DENIED-TAIL"))
  } finally {
    app.renderer.destroy()
    engine.detach()
  }
})

function completedPart(id: string): ToolPart {
  // completed part 不携带错误，用于隔离正文尺寸和 stateKey 对折叠状态的影响。
  return {
    id,
    sessionID: "ses_block_tool",
    messageID: "msg_block_tool",
    type: "tool",
    callID: `call_${id}`,
    tool: "apply_patch",
    state: {
      status: "completed",
      input: {},
      output: "",
      title: "patch",
      metadata: {},
      time: { start: 1, end: 2 },
    },
  }
}

test("block tool restores expansion after rebuild", async () => {
  const stateDir = await createStateDir()
  const output = Array.from({ length: 24 }, (_, index) => `patch line ${index + 1}`).join("\n")
  const part = completedPart("prt_patch")
  const [mounted, setMounted] = createSignal(true)
  const app = await testRender(() => (
    <SessionContent stateDir={stateDir}>
      <Show when={mounted()}>
        <BlockTool
          title="alpha"
          autoReview={false}
          part={part}
          totalLines={output.split("\n").length}
          totalChars={output.length}
          preview={<text>{collapseToolOutput(output, 10, 600, false).output}</text>}
        >
          <text>{output}</text>
        </BlockTool>
      </Show>
    </SessionContent>
  ), { width: 60, height: 70, useThread: false })
  try {
    await new Promise((resolve) => setTimeout(resolve, 100))
    await app.waitForFrame((frame) => frame.includes("Click to expand"))
    await clickText(app, "Click to expand")
    await app.waitForFrame((frame) => frame.includes("Click to collapse") && frame.includes("patch line 24"))

    setMounted(false)
    await app.renderOnce()
    // Show 卸载的是卡片 owner，不是外层 Session store；重建后应读取已保存的展开值。
    setMounted(true)
    await app.renderOnce()
    // 卡片 owner 销毁重建后从 Session store 恢复，而不是重置为本地收缩。
    await app.waitForFrame((frame) => frame.includes("Click to collapse") && frame.includes("patch line 24"))
  } finally {
    app.renderer.destroy()
    engine.detach()
  }
})

test("block tool without a part uses the native missing-key expansion fallback", async () => {
  const stateDir = await createStateDir()
  const output = Array.from({ length: 24 }, (_, index) => `local line ${index + 1}`).join("\n")
  const app = await testRender(() => (
    <SessionContent stateDir={stateDir}>
      <BlockTool
        title="local"
        autoReview={false}
        totalLines={output.split("\n").length}
        totalChars={output.length}
        preview={<text>{collapseToolOutput(output, 10, 600, false).output}</text>}
      >
        <text>{output}</text>
      </BlockTool>
    </SessionContent>
  ), { width: 60, height: 40, useThread: false })
  try {
    await new Promise((resolve) => setTimeout(resolve, 100))
    await app.waitForFrame((frame) => frame.includes("Click to expand"))
    await clickText(app, "Click to expand")
    await app.waitForFrame((frame) => frame.includes("Click to collapse") && frame.includes("local line 24"))
    // 无 part 只表示缺少 store 键，仍由 dev-smark 原生本地状态完成收放。
    await clickText(app, "Click to collapse")
    // 本地 signal 也能完成往返，证明缺键分支不是只支持展开的单向展示路径。
    await app.waitForFrame((frame) => frame.includes("Click to expand") && !frame.includes("local line 24"))
  } finally {
    app.renderer.destroy()
    engine.detach()
  }
})

test("block tool preserves selection and routes right click without toggling", async () => {
  const stateDir = await createStateDir()
  const output = Array.from({ length: 24 }, (_, index) => `source line ${index + 1}`).join("\n")
  let rightClicks = 0
  const app = await testRender(() => (
    <SessionContent stateDir={stateDir}>
      <BlockTool
        title="shell"
        autoReview={false}
        totalLines={output.split("\n").length}
        totalChars={output.length}
        preview={<text>{collapseToolOutput(output, 10, 600, false).output}</text>}
        onRightClick={() => rightClicks++}
      >
        <text>{output}</text>
      </BlockTool>
    </SessionContent>
  ), { width: 60, height: 40, useThread: false })
  try {
    await new Promise((resolve) => setTimeout(resolve, 100))
    await app.waitForFrame((frame) => frame.includes("Click to expand"))
    const lines = app.captureCharFrame().split("\n")
    const y = lines.findIndex((line) => line.includes("source line 1"))
    const x = lines[y].indexOf("source line")
    const affordanceY = lines.findIndex((line) => line.includes("Click to expand"))
    await app.mockMouse.drag(x, y, 10, affordanceY)
    await app.renderOnce()
    expect(app.renderer.getSelection()?.getSelectedText()?.length).toBeGreaterThan(0)
    // 拖选结束即使落在收放提示上也只能完成选择，不能同时触发容器动作。
    expect(app.captureCharFrame()).toContain("Click to expand")
    expect(app.captureCharFrame()).not.toContain("source line 24")

    app.renderer.clearSelection()
    await app.mockMouse.click(10, app.captureCharFrame().split("\n").findIndex((line) => line.includes("Click to expand")), MouseButton.RIGHT)
    await app.renderOnce()
    // 右键始终属于调用方独立动作，不能同时驱动容器展开。
    expect(rightClicks).toBe(1)
    expect(app.captureCharFrame()).toContain("Click to expand")
  } finally {
    app.renderer.destroy()
    engine.detach()
  }
})
