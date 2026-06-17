/** @jsxImportSource @opentui/solid */
import { expect, spyOn, test } from "bun:test"
import { Global } from "@opencode-ai/core/global"
import { testRender, useRenderer } from "@opentui/solid"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import type { Part, Session as SessionInfo, UserMessage } from "@opencode-ai/sdk/v2"
import { existsSync } from "fs"
import path from "path"
import { onCleanup, onMount } from "solid-js"
import { tmpdir } from "../../../fixture/fixture"
import { createTuiResolvedConfig } from "../../../fixture/tui-runtime"
import { TestTuiContexts } from "../../../fixture/tui-environment"
import { ArgsProvider } from "../../../../src/cli/cmd/tui/context/args"
import { CommandPaletteProvider } from "../../../../src/cli/cmd/tui/context/command-palette"
import { EditorContextProvider } from "../../../../src/cli/cmd/tui/context/editor"
import { DataProvider } from "@opencode-ai/tui/context/data"
import { EpilogueProvider } from "@opencode-ai/tui/context/epilogue"
import { ExitProvider } from "@opencode-ai/tui/context/exit"
import { KVProvider } from "../../../../src/cli/cmd/tui/context/kv"
import { LocalProvider } from "../../../../src/cli/cmd/tui/context/local"
import { ProjectProvider } from "../../../../src/cli/cmd/tui/context/project"
import { PromptRefProvider } from "../../../../src/cli/cmd/tui/context/prompt"
import { RouteProvider } from "../../../../src/cli/cmd/tui/context/route"
import { SDKProvider } from "../../../../src/cli/cmd/tui/context/sdk"
import { SyncProvider, useSync } from "../../../../src/cli/cmd/tui/context/sync"
import { ThemeProvider } from "../../../../src/cli/cmd/tui/context/theme"
import { TuiConfigProvider } from "../../../../src/cli/cmd/tui/context/tui-config"
import { FrecencyProvider } from "../../../../src/cli/cmd/tui/component/prompt/frecency"
import { PromptHistoryProvider } from "../../../../src/cli/cmd/tui/component/prompt/history"
import { PromptStashProvider } from "../../../../src/cli/cmd/tui/component/prompt/stash"
import { Session } from "../../../../src/cli/cmd/tui/routes/session"
import { OpencodeKeymapProvider, registerOpencodeKeymap, useOpencodeKeymap } from "../../../../src/cli/cmd/tui/keymap"
import { DialogProvider } from "../../../../src/cli/cmd/tui/ui/dialog"
import { DialogExportOptions } from "../../../../src/cli/cmd/tui/ui/dialog-export-options"
import { ToastProvider } from "../../../../src/cli/cmd/tui/ui/toast"
import { createPluginRuntime, PluginRuntimeProvider } from "@opencode-ai/tui/plugin/runtime"
import * as Editor from "../../../../src/cli/cmd/tui/util/editor"
import { createEventSource, createFetch, directory, json } from "./sync-fixture"

const sessionID = "ses_export"
const filename = "session export.md"

test("session export reads complete transcript from daemon instead of the local render window", async () => {
  const info = sessionInfo()
  // 这个 fixture 刻意让 TUI 初始同步只看到 recent message，模拟真实界面的 200 条渲染窗口；
  // daemon 全量读取额外返回 old message，用用户可见导出内容证明 export 没有复用本地窗口快照。
  const localMessages = [userMessage("msg_recent", 2)]
  const fullMessages = [userMessage("msg_old", 1), ...localMessages]
  const parts: Record<string, Part[]> = {
    msg_old: [textPart("part_old", "msg_old", "old message only available from daemon full export")],
    msg_recent: [textPart("part_recent", "msg_recent", "recent message in TUI render window")],
  }

  await withExportApp({
    info,
    dialogResult: exportDialogResult(),
    message(url) {
      // `limit > 0` 对应 TUI 常规渲染同步；未传 limit 或 limit=0 对应后端已有的全量消息语义。
      const source = Number(url.searchParams.get("limit") ?? 0) > 0 ? localMessages : fullMessages
      return json(source.map((message) => ({ info: message, parts: parts[message.id] ?? [] })))
    },
    async run({ context, file }) {
      await runSessionExport(context)

      const exported = await Bun.file(file).text()
      expect(exported).toContain("old message only available from daemon full export")
      expect(exported).toContain("recent message in TUI render window")
    },
  })
})

test("session export cancel keeps daemon full transcript unread and writes no file", async () => {
  const info = sessionInfo()
  let fullReads = 0

  await withExportApp({
    info,
    dialogResult: null,
    message(url) {
      if (Number(url.searchParams.get("limit") ?? 0) <= 0) fullReads++
      return json([])
    },
    async run({ context, file }) {
      await runSessionExport(context)

      expect(fullReads).toBe(0)
      expect(existsSync(file)).toBe(false)
    },
  })
})

test("session export does not write a partial local transcript when daemon full read fails", async () => {
  const info = sessionInfo()
  const localMessages = [userMessage("msg_recent", 2)]
  let failedFullReads = 0

  await withExportApp({
    info,
    dialogResult: exportDialogResult(),
    message(url) {
      if (Number(url.searchParams.get("limit") ?? 0) > 0) {
        return json(localMessages.map((message) => ({ info: message, parts: [] })))
      }

      failedFullReads++
      return json({ message: "full export failed" }, { status: 500 })
    },
    async run({ context, file }) {
      await runSessionExport(context)

      expect(failedFullReads).toBe(1)
      expect(existsSync(file)).toBe(false)
    },
  })
})

type ExportDialogResult = {
  filename: string
  thinking: boolean
  toolDetails: boolean
  assistantMetadata: boolean
  openWithoutSaving: boolean
} | null

async function withExportApp(input: {
  info: SessionInfo
  dialogResult: ExportDialogResult
  message: (url: URL) => Response
  run: (context: {
    context: ExportHarnessContext
    file: string
  }) => Promise<void>
}) {
  // 这个 helper 只收敛 TUI provider 挂载样板；各测试仍通过 Session 注册到 keymap 的真实 command 触发 export，
  // 避免断言源码结构或绕过命令注册链路，从而覆盖用户可见行为而不是字符串级实现细节。
  const previous = Global.Path.state
  await using tmp = await tmpdir()
  Global.Path.state = tmp.path
  await Bun.write(path.join(tmp.path, "kv.json"), "{}")

  const cwd = spyOn(process, "cwd").mockImplementation(() => tmp.path)
  const dialog = spyOn(DialogExportOptions, "show").mockResolvedValue(input.dialogResult)
  const editor = spyOn(Editor, "open").mockResolvedValue(undefined)
  const calls = createFetch((url) => {
    if (url.pathname === "/session") return json([input.info])
    const match = url.pathname.match(/^\/session\/([^/]+)(?:\/(message|todo|diff))?$/)
    if (!match || match[1] !== sessionID) return
    if (!match[2]) return json(input.info)
    if (match[2] !== "message") return json([])
    return input.message(url)
  })
  const events = createEventSource()
  let context: ExportHarnessContext | undefined
  const app = await testRender(() => (
    <ExportHarness fetch={calls.fetch} events={events.source} onReady={(next) => (context = next)} />
  ))

  try {
    await waitForApp(app, () => context?.sync.session.get(sessionID) !== undefined)
    await input.run({
      context: context!,
      file: path.join(tmp.path, filename),
    })
  } finally {
    app.renderer.destroy()
    cwd.mockRestore()
    dialog.mockRestore()
    editor.mockRestore()
    Global.Path.state = previous
  }
}

function exportDialogResult(): Exclude<ExportDialogResult, null> {
  return {
    filename,
    thinking: true,
    toolDetails: true,
    assistantMetadata: true,
    openWithoutSaving: false,
  }
}

type ExportHarnessContext = {
  keymap: ReturnType<typeof useOpencodeKeymap>
  sync: ReturnType<typeof useSync>
}

async function runSessionExport(context: ExportHarnessContext) {
  const entry = context.keymap
    .getCommandEntries({ visibility: "registered", namespace: "palette" })
    .find((entry) => entry.command.name === "session.export")
  if (!entry) throw new Error("session.export command was not registered")

  // OpenTUI dispatch intentionally fire-and-forgets async commands; invoking the registered command lets
  // tests wait for the export boundary to settle without reaching into Session component internals.
  await Promise.resolve((entry.command.run as () => void | Promise<void>)())
}

function ExportHarness(props: {
  fetch: typeof globalThis.fetch
  events: ReturnType<typeof createEventSource>["source"]
  onReady: (context: ExportHarnessContext) => void
}) {
  const renderer = useRenderer()
  const config = createTuiResolvedConfig()
  const keymap = createDefaultOpenTuiKeymap(renderer)
  const pluginRuntime = createPluginRuntime()
  // Session command 通过 OpenTUI keymap 注册；测试必须挂完整 provider 链，才能从用户入口触发 export。
  onCleanup(registerOpencodeKeymap(keymap, renderer, config))

  return (
    <TestTuiContexts directory={directory} cwd={Global.Path.state} paths={{ state: Global.Path.state }}>
      <OpencodeKeymapProvider keymap={keymap}>
        <ArgsProvider>
          <ExitProvider exit={() => {}}>
            <KVProvider>
            <ToastProvider>
              <RouteProvider initialRoute={{ type: "session", sessionID }}>
                <TuiConfigProvider config={config}>
                  <PluginRuntimeProvider value={pluginRuntime}>
                    <SDKProvider url="http://test" directory={directory} testTransport={{ fetch: props.fetch, events: props.events }}>
                      <ProjectProvider>
                        <SyncProvider>
                          <DataProvider>
                            <ThemeProvider mode="dark">
                              <LocalProvider>
                                <PromptStashProvider>
                                  <DialogProvider>
                                    <CommandPaletteProvider>
                                      <FrecencyProvider>
                                        <PromptHistoryProvider>
                                          <PromptRefProvider>
                                            <EditorContextProvider>
                                              <EpilogueProvider set={() => {}}>
                                                <Session />
                                                <ExportProbe onReady={props.onReady} />
                                              </EpilogueProvider>
                                            </EditorContextProvider>
                                          </PromptRefProvider>
                                        </PromptHistoryProvider>
                                      </FrecencyProvider>
                                    </CommandPaletteProvider>
                                  </DialogProvider>
                                </PromptStashProvider>
                              </LocalProvider>
                            </ThemeProvider>
                          </DataProvider>
                        </SyncProvider>
                      </ProjectProvider>
                    </SDKProvider>
                  </PluginRuntimeProvider>
                </TuiConfigProvider>
              </RouteProvider>
            </ToastProvider>
            </KVProvider>
          </ExitProvider>
        </ArgsProvider>
      </OpencodeKeymapProvider>
    </TestTuiContexts>
  )
}

function ExportProbe(props: { onReady: (context: ExportHarnessContext) => void }) {
  const keymap = useOpencodeKeymap()
  const sync = useSync()
  onMount(() => props.onReady({ keymap, sync }))
  return <box />
}

async function waitForApp(app: Awaited<ReturnType<typeof testRender>>, predicate: () => boolean, timeout = 2000) {
  const start = Date.now()
  for (;;) {
    await app.renderOnce()
    if (predicate()) return
    if (Date.now() - start > timeout) throw new Error("timed out waiting for condition")
    await Bun.sleep(10)
  }
}

function sessionInfo() {
  return {
    id: sessionID,
    slug: "export",
    projectID: "proj_test",
    directory,
    title: "export",
    version: "1.0.0",
    time: { created: 1, updated: 2 },
  } satisfies SessionInfo
}

function userMessage(id: string, created: number) {
  return {
    id,
    sessionID,
    role: "user",
    time: { created },
    agent: "build",
    model: { providerID: "provider", modelID: "model" },
  } satisfies UserMessage
}

function textPart(id: string, messageID: string, text: string) {
  return {
    id,
    sessionID,
    messageID,
    type: "text",
    text,
  } satisfies Extract<Part, { type: "text" }>
}
