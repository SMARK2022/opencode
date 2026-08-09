// #165：测试统一 testTransport，禁止顶层 fetch/events 生产缝
/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import type { Event, GlobalEvent } from "@opencode-ai/sdk/v2"
import { onMount } from "solid-js"
import { ProjectProvider, useProject } from "../../../src/context/project"
import { SDKProvider } from "../../../src/context/sdk"
import { RouteProvider, type Route } from "../../../src/context/route"
import { useEvent } from "../../../src/context/event"
import { createEventSource, createFetch, directory } from "../../fixture/tui-sdk"
import { TestTuiContexts } from "../../fixture/tui-environment"

const projectID = "proj_test"

async function wait(fn: () => boolean, timeout = 2000) {
  // #296：单调时钟防墙钟跳变——同源 sdk.test.tsx 修复迁移到目标 helper owner
  const start = performance.now()
  while (!fn()) {
    if (performance.now() - start > timeout) throw new Error("timed out waiting for condition")
    await Bun.sleep(10)
  }
}

function event(payload: Event, input: { directory: string; project?: string; workspace?: string }): GlobalEvent {
  return {
    directory: input.directory,
    project: input.project,
    workspace: input.workspace,
    payload,
  }
}

function vcs(branch: string): Event {
  return {
    id: `evt_vcs_${branch}`,
    type: "vcs.branch.updated",
    properties: {
      branch,
    },
  }
}

function update(version: string): Event {
  return {
    id: `evt_update_${version}`,
    type: "installation.update-available",
    properties: {
      version,
    },
  }
}

async function mount(initialRoute?: Route) {
  const events = createEventSource()
  const calls = createFetch()
  const seen: Event[] = []
  const workspaces: Array<string | undefined> = []
  let project!: ReturnType<typeof useProject>
  let done!: () => void
  const ready = new Promise<void>((resolve) => {
    done = resolve
  })

  const app = await testRender(() => (
    <TestTuiContexts>
      <SDKProvider url="http://test" directory={directory} testTransport={{ events: events.source, fetch: calls.fetch }}>
        {/* #570：RouteProvider 供 useEvent 读取活动 Session；包裹位置与 sync-fixture 同型。 */}
        <RouteProvider initialRoute={initialRoute}>
          <ProjectProvider>
            <Probe
              onReady={async (ctx) => {
                project = ctx.project
                await project.sync()
                done()
              }}
              seen={seen}
              workspaces={workspaces}
            />
          </ProjectProvider>
        </RouteProvider>
      </SDKProvider>
    </TestTuiContexts>
  ))

  await ready
  return { app, emit: events.emit, project, seen, workspaces }
}

function Probe(props: {
  seen: Event[]
  workspaces: Array<string | undefined>
  onReady: (ctx: { project: ReturnType<typeof useProject> }) => void
}) {
  const project = useProject()
  const event = useEvent()

  onMount(async () => {
    // 对齐插件初始化跨 Promise 的调用方式，订阅不能再依赖当前 Solid owner。
    await Promise.resolve()
    event.subscribe((evt, { workspace }) => {
      props.seen.push(evt)
      props.workspaces.push(workspace)
    })
    props.onReady({ project })
  })

  return <box />
}

describe("useEvent", () => {
  test("delivers events for the current project", async () => {
    const { app, emit, seen, workspaces } = await mount()

    try {
      emit(event(vcs("main"), { directory: "/tmp/other", project: projectID, workspace: "ws_a" }))

      await wait(() => seen.length === 1)

      expect(seen).toEqual([vcs("main")])
      expect(workspaces).toEqual(["ws_a"])
    } finally {
      app.renderer.destroy()
    }
  })

  test("delivers current project events regardless of active workspace", async () => {
    const { app, emit, project, seen } = await mount()

    try {
      project.workspace.set("ws_a")
      emit(event(vcs("ws"), { directory: "/tmp/other", project: projectID, workspace: "ws_b" }))

      await wait(() => seen.length === 1)

      expect(seen).toEqual([vcs("ws")])
    } finally {
      app.renderer.destroy()
    }
  })

  test("delivers truly global events even when a workspace is active", async () => {
    const { app, emit, project, seen } = await mount()

    try {
      project.workspace.set("ws_a")
      emit(event(update("1.2.3"), { directory: "global" }))

      await wait(() => seen.length === 1)

      expect(seen).toEqual([update("1.2.3")])
    } finally {
      app.renderer.destroy()
    }
  })

  // 活动Session资格只取顶层sessionID；无Session及另一Session仍保持Project隔离。
  test("delivers events for the active Session across Projects", async () => {
    const { app, emit, seen } = await mount({ type: "session", sessionID: "ses_1" })

    try {
      emit(
        event(
          {
            id: "evt_status_cross",
            type: "session.status",
            properties: { sessionID: "ses_1", status: { type: "idle" } },
          },
          { directory: "/tmp/other", project: "proj_other" },
        ),
      )

      await wait(() => seen.length === 1)
      emit(event({ id: "evt_other_session", type: "session.status", properties: { sessionID: "ses_other", status: { type: "idle" } } }, { directory: "/tmp/other", project: "proj_other" }))

      // 无 sessionID 的跨 Project 事件仍被 admission 拒绝（seen 不再增长）。
      emit(event(vcs("foreign"), { directory: "/tmp/other", project: "proj_other" }))
      await Bun.sleep(50)
      expect(seen.length).toBe(1)
    } finally {
      app.renderer.destroy()
    }
  })
})
