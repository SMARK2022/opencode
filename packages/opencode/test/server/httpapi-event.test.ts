import { afterEach, describe, expect, test } from "bun:test"
import { Bus } from "../../src/bus"
import { AppRuntime } from "../../src/effect/app-runtime"
import { InstanceRef } from "../../src/effect/instance-ref"
import { Server } from "../../src/server/server"
import { EventPaths } from "../../src/server/routes/instance/httpapi/groups/event"
import { Event as ServerEvent } from "../../src/server/event"
import * as Log from "@opencode-ai/core/util/log"
import { Effect, Schema } from "effect"
import { resetDatabase } from "../fixture/db"
import { GlobalBus } from "../../src/bus/global"
import { disposeAllInstances, reloadTestInstance, tmpdir } from "../fixture/fixture"

void Log.init({ print: false })

function app() {
  return Server.Default().app
}

const EventData = Schema.Struct({
  id: Schema.optional(Schema.String),
  type: Schema.String,
  properties: Schema.Record(Schema.String, Schema.Any),
})

async function readChunk(reader: ReadableStreamDefaultReader<Uint8Array>) {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("timed out waiting for event")), 5_000)
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

async function readFirstEvent(response: Response) {
  if (!response.body) throw new Error("missing response body")
  const reader = response.body.getReader()
  try {
    return await readEvent(reader)
  } finally {
    await reader.cancel()
  }
}

async function readEvent(reader: ReadableStreamDefaultReader<Uint8Array>) {
  const result = await readChunk(reader)
  if (result.done || !result.value) throw new Error("event stream closed")
  return Schema.decodeUnknownSync(EventData)(JSON.parse(new TextDecoder().decode(result.value).replace(/^data: /, "")))
}

async function readStatusWithin(reader: ReadableStreamDefaultReader<Uint8Array>, delay: number) {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      reader.read().then((result) => (result.done ? "closed" : "event")),
      new Promise<"open">((resolve) => {
        timeout = setTimeout(() => resolve("open"), delay)
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("event HttpApi", () => {
  test("serves event stream", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    const response = await app().request(EventPaths.event, { headers: { "x-opencode-directory": tmp.path } })

    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("text/event-stream")
    expect(response.headers.get("cache-control")).toBe("no-cache, no-transform")
    expect(response.headers.get("x-accel-buffering")).toBe("no")
    expect(response.headers.get("x-content-type-options")).toBe("nosniff")
    expect(await readFirstEvent(response)).toMatchObject({ type: "server.connected", properties: {} })
  })

  test("keeps the event stream open after the initial event", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    const response = await app().request(EventPaths.event, { headers: { "x-opencode-directory": tmp.path } })
    if (!response.body) throw new Error("missing response body")

    const reader = response.body.getReader()
    try {
      expect(await readEvent(reader)).toMatchObject({ type: "server.connected", properties: {} })
      expect(await readStatusWithin(reader, 250)).toBe("open")
    } finally {
      await reader.cancel()
    }
  })

  test("delivers instance bus events after the initial event", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    const response = await app().request(EventPaths.event, { headers: { "x-opencode-directory": tmp.path } })
    if (!response.body) throw new Error("missing response body")

    const reader = response.body.getReader()
    try {
      expect(await readEvent(reader)).toMatchObject({ type: "server.connected", properties: {} })

      const next = readEvent(reader)
      const ctx = await reloadTestInstance({ directory: tmp.path })
      await AppRuntime.runPromise(
        Bus.Service.use((svc) => svc.publish(ServerEvent.Connected, {})).pipe(Effect.provideService(InstanceRef, ctx)),
      )

      expect(await next).toMatchObject({ type: "server.connected", properties: {} })
    } finally {
      await reader.cancel()
    }
  })

  test("viewer event stream projects duplicate part fields; default stream stays complete", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    const patch = "+duplicate patch line\n".repeat(64)
    const part = {
      id: "prt_viewer_sse",
      messageID: "msg_viewer_sse",
      sessionID: "ses_viewer_sse",
      type: "tool",
      callID: "call_1",
      tool: "edit",
      state: {
        status: "completed",
        input: { filePath: "a.ts" },
        output: "Edit applied successfully.",
        title: "a.ts",
        metadata: { diff: patch, filediff: { file: "a.ts", patch, additions: 64, deletions: 0 } },
        time: { start: 1, end: 2 },
      },
    }
    // 两个全局流由本用例拥有；取消reader不保证raw Response的底层订阅一起退出。
    const controller = new AbortController()
    const viewer = await app().request("/global/event", {
      signal: controller.signal,
      headers: { "x-opencode-directory": tmp.path, "x-opencode-tui-message-projection": "viewer" },
    })
    const complete = await app().request("/global/event", { signal: controller.signal, headers: { "x-opencode-directory": tmp.path } })
    if (!viewer.body || !complete.body) throw new Error("missing response body")
    const viewerReader = viewer.body.getReader()
    const completeReader = complete.body.getReader()
    // 全局流会带 heartbeat 等无 part 帧；用宽松解析跳过，只取目标 part 事件。
    // 全局端点的帧是 GlobalBusEvent 包装 {directory, payload}；读取时先解包 payload。
    const readPayload = async (reader: ReadableStreamDefaultReader<Uint8Array>) => {
      const chunk = await readChunk(reader)
      if (chunk.done || !chunk.value) throw new Error("event stream closed")
      const frame = JSON.parse(new TextDecoder().decode(chunk.value).replace(/^data: /, "")) as {
        payload?: { type?: string; properties?: { part?: typeof part } }
      }
      return frame.payload
    }
    const readPartEvent = async (reader: ReadableStreamDefaultReader<Uint8Array>) => {
      for (;;) {
        const event = await readPayload(reader)
        if (event?.type === "message.part.updated") return event
      }
    }
    try {
      expect((await readPayload(viewerReader))?.type).toBe("server.connected")
      expect((await readPayload(completeReader))?.type).toBe("server.connected")

      const viewerNext = readPartEvent(viewerReader)
      const completeNext = readPartEvent(completeReader)
      GlobalBus.emit("event", {
        directory: tmp.path,
        payload: { type: "message.part.updated", properties: { sessionID: "ses_viewer_sse", part, time: 2 } },
      })

      // viewer 连接剪掉与 diff 逐字重复的 patch；默认连接的合同字段原样保留。
      const viewerEvent = await viewerNext
      const completeEvent = await completeNext
      const viewerPart = viewerEvent?.properties?.part
      const completePart = completeEvent?.properties?.part
      expect(viewerPart?.state.metadata.diff).toBe(patch)
      expect(viewerPart?.state.metadata.filediff as unknown).toEqual({ file: "a.ts", additions: 64, deletions: 0 })
      expect((completePart?.state.metadata.filediff as { patch?: unknown }).patch).toBe(patch)
    } finally {
      // 先沿请求signal释放heartbeat、GlobalBus订阅和连接计数，再结算两个reader。
      controller.abort()
      await viewerReader.cancel()
      await completeReader.cancel()
    }
  })
})
