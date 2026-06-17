/** @jsxImportSource @opentui/solid */
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { onCleanup } from "solid-js"
import { tmpdir } from "../../fixture/fixture"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { TuiConfigProvider } from "../../../src/config"
import { KVProvider } from "../../../src/context/kv"
import { ThemeProvider } from "../../../src/context/theme"
import { registerOpencodeKeymap, OpencodeKeymapProvider } from "../../../src/keymap"
import { DialogProvider } from "../../../src/ui/dialog"
import { DialogSelect } from "../../../src/ui/dialog-select"
import { ToastProvider } from "../../../src/ui/toast"

async function waitForFrame(app: Awaited<ReturnType<typeof testRender>>, text: string) {
  for (let attempt = 0; attempt < 20; attempt++) {
    await app.renderOnce()
    const frame = app.captureCharFrame()
    if (frame.includes(text)) return frame
    await Bun.sleep(10)
  }
  return app.captureCharFrame()
}

test("dialog select renders option details", async () => {
  await using tmp = await tmpdir()
  const state = path.join(tmp.path, "state")
  await mkdir(state, { recursive: true })
  await Bun.write(path.join(state, "kv.json"), "{}")

  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const config = createTuiResolvedConfig()
    const off = registerOpencodeKeymap(keymap, renderer, config)
    onCleanup(off)

    return (
      <TestTuiContexts directory={tmp.path} paths={{ home: tmp.path, state, worktree: tmp.path }}>
        <OpencodeKeymapProvider keymap={keymap}>
          <TuiConfigProvider config={config}>
            <KVProvider>
              <ThemeProvider mode="dark">
                <ToastProvider>
                <DialogProvider>
                  <box width={80} height={20}>
                    <DialogSelect
                        title="Sessions"
                        renderFilter={false}
                        options={[
                          {
                            title: "Preview Session",
                            value: "session-1",
                            details: ["latest user message", "previous user message"],
                          },
                        ]}
                      />
                  </box>
                </DialogProvider>
                </ToastProvider>
              </ThemeProvider>
            </KVProvider>
          </TuiConfigProvider>
        </OpencodeKeymapProvider>
      </TestTuiContexts>
    )
  }

  const app = await testRender(() => <Harness />, { width: 80, height: 20 })
  try {
    const frame = await waitForFrame(app, "latest user message")
    expect(frame).toContain("latest user message")
    expect(frame).toContain("previous user message")
  } finally {
    app.renderer.destroy()
  }
})
