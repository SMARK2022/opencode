/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { createSignal, onCleanup, onMount } from "solid-js"
import { tmpdir } from "../../fixture/fixture"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { DialogSelect, type DialogSelectOption } from "../../../src/ui/dialog-select"
import { TuiConfigProvider } from "../../../src/config"
import { ThemeProvider } from "../../../src/context/theme"
import { KVProvider } from "../../../src/context/kv"
import { ToastProvider } from "../../../src/ui/toast"
import { DialogProvider } from "../../../src/ui/dialog"
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "../../../src/keymap"

async function waitForFrame(app: Awaited<ReturnType<typeof testRender>>, text: string) {
  // 超时返回末帧，由原有断言报告实际渲染差异。
  const timeout = Date.now() + 2000
  while (Date.now() < timeout) {
    await app.renderOnce()
    const frame = app.captureCharFrame()
    if (frame.includes(text)) return frame
    await Bun.sleep(10)
  }
  return app.captureCharFrame()
}

// 复用 headless fixture 的完整上下文，包括停机提示；不加载真实 App。
function DialogSelectHarness(props: {
  root: string
  state: string
  header?: string
  options: DialogSelectOption<unknown>[]
  current?: unknown
  currentKey?: string
  onMove?: (option: DialogSelectOption<unknown>) => void
}) {
  const renderer = useRenderer()
  const keymap = createDefaultOpenTuiKeymap(renderer)
  const resolvedConfig = createTuiResolvedConfig()
  const off = registerOpencodeKeymap(keymap, renderer, resolvedConfig)
  onCleanup(off)

  return (
    <TestTuiContexts
      directory={props.root}
      paths={{
        home: props.root,
        state: props.state,
        worktree: props.root,
      }}
    >
      <OpencodeKeymapProvider keymap={keymap}>
        <TuiConfigProvider config={resolvedConfig}>
          <KVProvider>
            <ThemeProvider mode="dark">
              <ToastProvider>
                <DialogProvider>
                  <DialogSelect
                    title="Models"
                    header={props.header ? <text>{props.header}</text> : undefined}
                    options={props.options}
                    current={props.current}
                    currentKey={props.currentKey}
                    onMove={props.onMove}
                    renderFilter={false}
                  />
                </DialogProvider>
              </ToastProvider>
            </ThemeProvider>
          </KVProvider>
        </TuiConfigProvider>
      </OpencodeKeymapProvider>
    </TestTuiContexts>
  )
}

async function mountHarness(input: {
  root: string
  header?: string
  options: DialogSelectOption<unknown>[]
  current?: unknown
  currentKey?: string
  onMove?: (option: DialogSelectOption<unknown>) => void
  deferredKey?: (
    setCurrentKey: (key: string) => void,
    setOptions: (options: DialogSelectOption<unknown>[]) => void,
  ) => void
}) {
  const state = path.join(input.root, "state")
  await mkdir(state, { recursive: true })
  await Bun.write(path.join(state, "kv.json"), "{}")

  function Harness() {
    const [currentKey, setCurrentKey] = createSignal<string | undefined>(input.currentKey)
    const [options, setOptions] = createSignal(input.options)
    onMount(() => input.deferredKey?.((key) => setCurrentKey(key), (next) => setOptions(next)))

    return (
      <DialogSelectHarness
        root={input.root}
        header={input.header}
        state={state}
        options={options()}
        current={input.current}
        currentKey={currentKey()}
        onMove={input.onMove}
      />
    )
  }

  const app = await testRender(() => <Harness />, { width: 80, height: 30 })
  return { app, cleanup: () => app.renderer.destroy() }
}

test("dialog select can mark the current object by stable key", async () => {
  // 临时目录由用例持有，renderer 销毁前 KV 状态必须仍然存在。
  await using tmp = await tmpdir()
  const app = await mountHarness({
    root: tmp.path,
    header: "Goal summary",
    current: { providerID: "test", modelID: "two" },
    currentKey: "test/two",
    options: [
      {
        key: "test/one",
        title: "Model One",
        value: { providerID: "test", modelID: "one", metadata: { created: 1 } },
      },
      {
        key: "test/two",
        title: "Model Two",
        value: { providerID: "test", modelID: "two", metadata: { created: 2 } },
      },
    ],
  })

  try {
    const frame = (await waitForFrame(app.app, "Model Two")).split("\n")
    const current = frame.find((line) => line.includes("Model Two")) ?? ""
    const other = frame.find((line) => line.includes("Model One")) ?? ""
    // header位于标题和选项之间，不能吞掉原有identity高亮或进入业务选项集合。
    expect(frame.findIndex((line) => line.includes("Goal summary"))).toBeGreaterThanOrEqual(0)
    expect(frame.findIndex((line) => line.includes("Goal summary"))).toBeLessThan(frame.findIndex((line) => line.includes("Model One")))

    // value 多出的 metadata 使对象不相等，高亮必须来自稳定 key。
    expect(current).toContain("●")
    expect(other).not.toContain("●")
  } finally {
    app.cleanup()
  }
})

test("dialog select resolves deferred current movement against the latest options", async () => {
  await using tmp = await tmpdir()
  const moves: string[] = []
  const app = await mountHarness({
    root: tmp.path,
    current: { providerID: "test", modelID: "two" },
    currentKey: "test/one",
    deferredKey: (setCurrentKey, setOptions) => {
      // 先让初始效果排入 timeout，再在回调执行前切换 key 和列表顺序。
      queueMicrotask(() => {
        setCurrentKey("test/two")
        setOptions([
          { key: "test/two", title: "Model Two", value: { providerID: "test", modelID: "two" } },
          { key: "test/one", title: "Model One", value: { providerID: "test", modelID: "one" } },
        ])
      })
    },
    onMove: (option) => moves.push(option.title),
    options: [
      { key: "test/one", title: "Model One", value: { providerID: "test", modelID: "one" } },
      { key: "test/two", title: "Model Two", value: { providerID: "test", modelID: "two" } },
    ],
  })

  try {
    const frame = await waitForFrame(app.app, "Model Two")
    await Bun.sleep(30)
    await app.app.renderOnce()

    expect(frame.indexOf("Model Two")).toBeLessThan(frame.indexOf("Model One"))
    expect(moves).toContain("Model Two")
    expect(moves).not.toContain("Model One")
  } finally {
    app.cleanup()
  }
})

test("dialog select keeps current fallback for unkeyed object values", async () => {
  await using tmp = await tmpdir()
  const app = await mountHarness({
    root: tmp.path,
    current: { id: "two", label: "Model Two" },
    options: [
      { title: "Model One", value: { id: "one", label: "Model One" } },
      { title: "Model Two", value: { id: "two", label: "Model Two" } },
    ],
  })

  try {
    const line = (await waitForFrame(app.app, "Model Two")).split("\n").find((item) => item.includes("Model Two")) ?? ""

    // 未提供 key 的对象仍按原有深比较语义匹配 current。
    expect(line).toContain("●")
  } finally {
    app.cleanup()
  }
})

test("goal menu mounts large without a search filter", async () => {
  const source = await Bun.file(new URL("../../../src/component/dialog-goal.tsx", import.meta.url)).text()
  const menu = source.match(/export function DialogGoalMenu\([\s\S]*?\n\}/)?.[0]
  const mount = menu?.match(/onMount\(\(\) => dialog\.setSize\("large"\)\)/)?.[0]
  expect(mount).toBeDefined()
  const sizes: string[] = []
  // 执行真实挂载语句，不在测试中重写 setSize 决策，也不导入 App/SDK 初始化链。
  new Function(
    "onMount",
    "dialog",
    mount!,
  )((run: () => void) => run(), { setSize: (size: string) => sizes.push(size) })
  expect(sizes).toEqual(["large"])
  // 菜单自身关闭 filter 才能省行，其他 DialogSelect 用例继续验证真实列表布局。
  expect(menu).toMatch(/<DialogSelect\s[\s\S]*?renderFilter=\{false\}/)
})
