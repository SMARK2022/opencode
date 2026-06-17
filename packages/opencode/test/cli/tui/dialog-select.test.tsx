/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { Global } from "@opencode-ai/core/global"
import { testRender, useRenderer } from "@opentui/solid"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { createSignal, onCleanup, onMount } from "solid-js"
import { DialogSelect, type DialogSelectOption } from "@opencode-ai/tui/ui/dialog-select"
import { TuiConfigProvider } from "@/cli/cmd/tui/context/tui-config"
import { ThemeProvider } from "@/cli/cmd/tui/context/theme"
import { KVProvider } from "@/cli/cmd/tui/context/kv"
import { ToastProvider } from "@/cli/cmd/tui/ui/toast"
import { DialogProvider } from "@/cli/cmd/tui/ui/dialog"
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "@/cli/cmd/tui/keymap"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { TestTuiContexts } from "../../fixture/tui-environment"

async function waitForFrame(app: Awaited<ReturnType<typeof testRender>>, text: string) {
  const timeout = Date.now() + 1000
  while (Date.now() < timeout) {
    await app.renderOnce()
    const frame = app.captureCharFrame()
    if (frame.includes(text)) return frame
    await Bun.sleep(10)
  }
  return app.captureCharFrame()
}

function DialogSelectHarness(props: {
  options: DialogSelectOption<any>[]
  current?: any
  currentKey?: string
  onMove?: (option: DialogSelectOption<any>) => void
}) {
  const renderer = useRenderer()
  const config = createTuiResolvedConfig()
  const keymap = createDefaultOpenTuiKeymap(renderer)
  onCleanup(registerOpencodeKeymap(keymap, renderer, config))

  return (
    <TestTuiContexts paths={{ state: Global.Path.state }}>
      <OpencodeKeymapProvider keymap={keymap}>
        <TuiConfigProvider config={config}>
          <KVProvider>
          <ThemeProvider mode="dark">
            <ToastProvider>
              <DialogProvider>
                <DialogSelect
                  title="Models"
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

test("dialog select can mark the current object by stable key", async () => {
  const app = await testRender(() => (
    <box width={80} height={30}>
      <DialogSelectHarness
        current={{ providerID: "test", modelID: "two" }}
        currentKey="test/two"
        options={[
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
        ]}
      />
    </box>
  ), { width: 80, height: 30 })

  try {
    const frame = (await waitForFrame(app, "Model Two")).split("\n")
    const current = frame.find((line) => line.includes("Model Two")) ?? ""
    const other = frame.find((line) => line.includes("Model One")) ?? ""

    expect(current).toContain("●")
    expect(other).not.toContain("●")
  } finally {
    app.renderer.destroy()
  }
})

test("dialog select resolves deferred current movement against the latest options", async () => {
  const moves: string[] = []
  const App = () => {
    const [currentKey, setCurrentKey] = createSignal("test/one")
    onMount(() => setCurrentKey("test/two"))

    return (
      <box width={80} height={30}>
        <DialogSelectHarness
          current={{ providerID: "test", modelID: "two" }}
          currentKey={currentKey()}
          onMove={(option) => moves.push(option.title)}
          options={[
            { key: "test/one", title: "Model One", value: { providerID: "test", modelID: "one" } },
            { key: "test/two", title: "Model Two", value: { providerID: "test", modelID: "two" } },
          ]}
        />
      </box>
    )
  }
  const app = await testRender(() => <App />, { width: 80, height: 30 })

  try {
    await waitForFrame(app, "Model Two")
    await Bun.sleep(10)
    await app.renderOnce()

    expect(moves).toContain("Model Two")
    expect(moves).not.toContain("Model One")
  } finally {
    app.renderer.destroy()
  }
})

test("dialog select keeps current fallback for unkeyed object values", async () => {
  const app = await testRender(() => (
    <box width={80} height={30}>
      <DialogSelectHarness
        current={{ id: "two", label: "Model Two" }}
        options={[
          { title: "Model One", value: { id: "one", label: "Model One" } },
          { title: "Model Two", value: { id: "two", label: "Model Two" } },
        ]}
      />
    </box>
  ), { width: 80, height: 30 })

  try {
    const line = (await waitForFrame(app, "Model Two")).split("\n").find((item) => item.includes("Model Two")) ?? ""

    expect(line).toContain("●")
  } finally {
    app.renderer.destroy()
  }
})
