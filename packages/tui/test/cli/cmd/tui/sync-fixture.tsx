// #165：测试统一 testTransport，禁止顶层 fetch/events 生产缝
/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { engine } from "@opentui/core"
import { onMount } from "solid-js"
import { ArgsProvider } from "../../../../src/context/args"
import { KVProvider, useKV } from "../../../../src/context/kv"
import { ProjectProvider, useProject } from "../../../../src/context/project"
import { SDKProvider } from "../../../../src/context/sdk"
import { SyncProvider, useSync } from "../../../../src/context/sync"
import { RouteProvider, useRoute, type Route } from "../../../../src/context/route"
import { PermissionProvider } from "../../../../src/context/permission"
import { ExitProvider } from "../../../../src/context/exit"
import { createEventSource, createFetch, type FetchHandler, directory } from "../../../fixture/tui-sdk"
import { TestTuiContexts } from "../../../fixture/tui-environment"
export { createEventSource, createFetch, directory, eventSource, json, worktree } from "../../../fixture/tui-sdk"

export async function wait(fn: () => boolean, timeout = 2000) {
  // #296：单调时钟防墙钟跳变——同源 sdk.test.tsx 修复迁移到目标 helper owner
  const start = performance.now()
  while (!fn()) {
    if (performance.now() - start > timeout) throw new Error("timed out waiting for condition")
    await Bun.sleep(10)
  }
}

type Ctx = { kv: ReturnType<typeof useKV>; project: ReturnType<typeof useProject>; sync: ReturnType<typeof useSync>; route: ReturnType<typeof useRoute> }

export async function mount(override?: FetchHandler, state?: string, initialRoute?: Route) {
  const calls = createFetch(override)
  const events = createEventSource()
  let sync!: ReturnType<typeof useSync>
  let project!: ReturnType<typeof useProject>
  let kv!: ReturnType<typeof useKV>
  let route!: ReturnType<typeof useRoute>
  let done!: () => void
  const ready = new Promise<void>((resolve) => {
    done = resolve
  })

  function Probe() {
    const ctx: Ctx = { kv: useKV(), project: useProject(), sync: useSync(), route: useRoute() }
    onMount(() => {
      sync = ctx.sync
      project = ctx.project
      kv = ctx.kv
      route = ctx.route
      done()
    })
    return <box />
  }

  const app = await testRender(
    () => (
    <TestTuiContexts paths={state ? { state } : undefined}>
      <ArgsProvider>
        <KVProvider>
          <SDKProvider url="http://test" directory={directory} testTransport={{ fetch: calls.fetch, events: events.source }}>
            {/* 活动Session资格由现有Route提供，fixture与生产同序，不添加可选context回退。 */}
            <RouteProvider initialRoute={initialRoute}>
              <PermissionProvider>
                <ProjectProvider>
                  <ExitProvider exit={() => {}}>
                    <SyncProvider>
                      <Probe />
                    </SyncProvider>
                  </ExitProvider>
                </ProjectProvider>
              </PermissionProvider>
            </RouteProvider>
          </SDKProvider>
        </KVProvider>
      </ArgsProvider>
    </TestTuiContexts>
    ),
    {
      // core/testing 在 Linux 默认关闭 renderer 线程，但 Windows 默认开启。
      // sync 套件会反复 mount/destroy；禁用线程让 Windows 清理路径和 Linux 一致，避免文件级 hook 等待 native renderer 线程退出超时。
      useThread: false,
    },
  )

  // Solid cleanup 应退订测试事件源，但 Windows full-run 在所有命名 sync 用例
  // 通过后仍出现文件级清理超时；显式清理测试传输并分离 OpenTUI 全局 engine，
  // 确保销毁后的 renderer 或事件回调不会活过最后一次 sync fixture teardown。
  const destroy = app.renderer.destroy.bind(app.renderer)
  app.renderer.destroy = () => {
    events.dispose()
    try {
      destroy()
    } finally {
      engine.detach()
    }
  }

  await ready
  await wait(() => sync.status === "complete")
  return { app, emit: events.emit, kv, project, sync, route, session: calls.session }
}

