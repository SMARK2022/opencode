/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { engine } from "@opentui/core"
import { onMount } from "solid-js"
import { ArgsProvider } from "@opencode-ai/tui/context/args"
import { KVProvider, useKV } from "@opencode-ai/tui/context/kv"
import { ProjectProvider, useProject } from "@opencode-ai/tui/context/project"
import { SDKProvider } from "@opencode-ai/tui/context/sdk"
import { SyncProvider, useSync } from "@opencode-ai/tui/context/sync"
import { createEventSource, createFetch, type FetchHandler, directory } from "../../../fixture/tui-sdk"
import { TestTuiContexts } from "../../../fixture/tui-environment"

export { createEventSource, createFetch, directory, eventSource, json, worktree } from "../../../fixture/tui-sdk"

export async function wait(fn: () => boolean, timeout = 2000) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error("timed out waiting for condition")
    await Bun.sleep(10)
  }
}

type Ctx = { kv: ReturnType<typeof useKV>; project: ReturnType<typeof useProject>; sync: ReturnType<typeof useSync> }

export async function mount(override?: FetchHandler, state?: string) {
  const calls = createFetch(override)
  const events = createEventSource()
  let sync!: ReturnType<typeof useSync>
  let project!: ReturnType<typeof useProject>
  let kv!: ReturnType<typeof useKV>
  let done!: () => void
  const ready = new Promise<void>((resolve) => {
    done = resolve
  })

  function Probe() {
    const ctx: Ctx = { kv: useKV(), project: useProject(), sync: useSync() }
    onMount(() => {
      sync = ctx.sync
      project = ctx.project
      kv = ctx.kv
      done()
    })
    return <box />
  }

  const app = await testRender(() => (
    <TestTuiContexts paths={state ? { state } : undefined}>
      <ArgsProvider>
        <KVProvider>
          <SDKProvider url="http://test" directory={directory} testTransport={{ fetch: calls.fetch, events: events.source }}>
            <ProjectProvider>
              <SyncProvider>
                <Probe />
              </SyncProvider>
            </ProjectProvider>
          </SDKProvider>
        </KVProvider>
      </ArgsProvider>
    </TestTuiContexts>
  ))

  const destroy = app.renderer.destroy.bind(app.renderer)
  app.renderer.destroy = () => {
    // Solid cleanup should unsubscribe the test event source, but Windows full-run
    // failures showed cleanup timeouts after individual sync tests had passed.
    events.dispose()
    try {
      destroy()
    } finally {
      engine.detach()
    }
  }

  await ready
  await wait(() => sync.status === "complete")
  return { app, emit: events.emit, kv, project, sync, session: calls.session }
}
