import { afterEach, describe, expect } from "bun:test"
import { DateTime, Effect, Layer, Queue, Schema, Stream } from "effect"
import { Sse } from "effect/unstable/encoding"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID } from "../../src/session/schema"
import { EventPaths } from "../../src/server/routes/instance/httpapi/groups/event"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"
import { GlobalBus } from "../../src/bus/global"
import { SessionProcessor } from "../../src/session/processor"
import { Token } from "@opencode-ai/core/util/token"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { EventV2 } from "@opencode-ai/core/event"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { OpenCodeEvent } from "@opencode-ai/protocol/groups/event"

const EventData = Schema.Struct({
  id: Schema.optional(Schema.String),
  type: Schema.String,
  properties: Schema.Record(Schema.String, Schema.Any),
})

const readEvent = (reader: Queue.Dequeue<typeof EventData.Type>) =>
  Effect.gen(function* () {
    const value = yield* Queue.take(reader).pipe(
      Effect.timeoutOrElse({
        duration: "5 seconds",
        orElse: () => Effect.fail(new Error("timed out waiting for event")),
      }),
    )
    return value
  })

const openEventStream = (directory: string) =>
  Effect.gen(function* () {
    const response = yield* requestInDirectory(EventPaths.event, directory)
    const reader = yield* Queue.unbounded<typeof EventData.Type>()
    // 网络chunk可以合并或拆分事件；使用实际SSE分帧后才逐条解码请求快照。
    yield* response.stream.pipe(
      Stream.decodeText(),
      Stream.pipeThroughChannel(Sse.decodeDataSchema(EventData)),
      Stream.runForEach((event) => Queue.offer(reader, event.data)),
      Effect.forkScoped,
    )
    return { response, reader }
  })

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

// 真实projector必须与bridge共享测试依赖图，否则SSE只证明事件转发，不能证明提交后的请求投影。
const it = testEffect(Layer.mergeAll(httpApiLayer, LayerNode.compile(LayerNode.group([EventV2Bridge.node, SessionProjector.node]))))

describe("event HttpApi", () => {
  it.instance(
    "serves event stream",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const { response, reader } = yield* openEventStream(directory)

        expect(response.status).toBe(200)
        expect(response.headers["content-type"]).toContain("text/event-stream")
        expect(response.headers["cache-control"]).toBe("no-cache, no-transform")
        expect(response.headers["x-accel-buffering"]).toBe("no")
        expect(response.headers["x-content-type-options"]).toBe("nosniff")
        expect(yield* readEvent(reader)).toMatchObject({ type: "server.connected", properties: {} })
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "keeps the event stream open after the initial event",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const { reader } = yield* openEventStream(directory)
        expect(yield* readEvent(reader)).toMatchObject({ type: "server.connected", properties: {} })

        // If no second event arrives within 250ms, the stream is still open.
        const status = yield* Queue.take(reader).pipe(
          Effect.as("event" as const),
          Effect.timeoutOrElse({ duration: "250 millis", orElse: () => Effect.succeed("open" as const) }),
        )
        expect(status).toBe("open")
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "delivers instance events after the initial event",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
        const { reader } = yield* openEventStream(directory)
        expect(yield* readEvent(reader)).toMatchObject({ type: "server.connected", properties: {} })

        const created = yield* requestInDirectory("/session", directory, { method: "POST" })
        expect(created.status).toBe(200)
        expect(yield* readEvent(reader)).toMatchObject({ type: "session.created" })
        // 真实 Scope 退出发布助手终态，同一 /event 响应必须继续送达该快照。
        const info = Schema.decodeUnknownSync(SessionV1.SessionInfo)(yield* created.json)
        const terminal: SessionV1.Assistant = {
          id: MessageID.ascending(), parentID: MessageID.ascending(), sessionID: info.id,
          role: "assistant", agent: "build", mode: "build", path: { cwd: directory, root: directory },
          modelID: ModelV2.ID.make("test"), providerID: ProviderV2.ID.make("test"),
          cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: 1, completed: 2 }, finish: "error",
          error: { name: "MessageAbortedError", data: { message: "Cancelled before provider" } },
        }
        const events = yield* EventV2Bridge.Service
        yield* Effect.addFinalizer(() => events.publish(MessageV2.Event.Updated, { sessionID: info.id, info: terminal }, { finalizer: true }).pipe(Effect.asVoid)).pipe(Effect.scoped)
        // Session读投影可与原message事件交错，但不能替代原终态及其错误内容。
        const terminalEvent = yield* Effect.gen(function* () {
          while (true) {
            const event = yield* readEvent(reader)
            if (event.type !== "session.updated") return event
          }
        })
        expect(terminalEvent).toMatchObject({
          type: MessageV2.Event.Updated.type,
          properties: { sessionID: info.id, info: { id: terminal.id, error: terminal.error, time: { completed: 2 } } },
        })
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance("projects prepared breakdown and zero confirmation through the real SSE stream", () => Effect.gen(function* () {
    const instance = yield* TestInstance
    const stream = yield* openEventStream(instance.directory)
    expect(yield* readEvent(stream.reader)).toMatchObject({ type: "server.connected" })
    const created = yield* requestInDirectory("/session", instance.directory, { method: "POST" })
    const info = Schema.decodeUnknownSync(SessionV1.SessionInfo)(yield* created.json)
    expect(yield* readEvent(stream.reader)).toMatchObject({ type: "session.created" })
    const events = yield* EventV2Bridge.Service
    const userID = MessageID.ascending()
    const nextSnapshot = Effect.fnUntraced(function* (confirmed?: boolean) {
      while (true) {
        const event = yield* readEvent(stream.reader)
        if (event.type !== "session.updated") continue
        const data = Schema.decodeUnknownSync(Schema.Struct({ info: SessionV1.SessionInfo }))(event.properties)
        // 同一更新可排入多个快照，按请求身份及确认版本过滤，防止上一发布的迟到快照满足下一阶段断言。
        if (data.info.id === info.id && data.info.request?.messageID === userID && (confirmed === undefined || data.info.request.inputEstimate?.confirmed === confirmed)) return data.info
      }
    })
    // 用户先持久化再发布明确parentID的助手，请求归属不能靠事件时间或当前最后用户猜测。
    yield* events.publish(MessageV2.Event.Updated, { sessionID: info.id, info: { id: userID, sessionID: info.id, role: "user",
      time: { created: 1 }, agent: "build", model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") } } })
    expect((yield* nextSnapshot()).request).toMatchObject({ messageID: userID, input: 0, output: 0 })
    const inputEstimate = { ...Token.estimateRequest({ system: "fixture", messages: [{ role: "user", content: "hello" }], tools: [] }, [], []), contextLimit: 8000 }
    const assistant: SessionV1.Assistant = { id: MessageID.ascending(), parentID: userID, sessionID: info.id,
      role: "assistant", agent: "build", mode: "build", path: { cwd: instance.directory, root: instance.directory },
      modelID: ModelV2.ID.make("test"), providerID: ProviderV2.ID.make("test"), time: { created: 2 }, cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, inputEstimate }
    yield* SessionProcessor.publishAssistant(assistant, events)
    const prepared = yield* nextSnapshot(false)
    expect(prepared.request).toMatchObject({ messageID: userID, input: 0, output: 0, estimatedInput: inputEstimate.input, inputEstimate })
    assistant.inputEstimate = { ...inputEstimate, confirmed: true }
    // completed=0与全零tokens同时存在仍是权威终态；真值判断会错误保留旧estimatedInput。
    assistant.time.completed = 0
    yield* SessionProcessor.publishAssistant(assistant, events)
    const settled = yield* nextSnapshot(true)
    expect(settled.request?.estimatedInput).toBeUndefined()
    expect(settled.request?.inputEstimate).toEqual({ ...inputEstimate, confirmed: true })
    expect(settled.request?.model?.contextLimit).toBe(8000)
    expect(settled.request).toMatchObject({ input: 0, output: 0, cost: 0, stepInput: 0, stepOutput: 0 })
  }), { git: true, config: { formatter: false, lsp: false } })

  it.instance(
    "viewer event stream projects duplicate part fields; default stream stays complete",
    () =>
      Effect.gen(function* () {
        const { directory } = yield* TestInstance
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
        // [0624] /global/event 是 GlobalBus 包装流（帧为 {directory, payload}），与 /event 的
        // payload-直接流不同；TUI SDK 的 sdk.global.event 连接的就是这一端点。
        const Frame = Schema.Struct({ payload: Schema.Struct({
          type: Schema.String,
          properties: Schema.optionalKey(Schema.Struct({ part: Schema.optionalKey(SessionV1.Part) })),
        }) })
        // 两个全局流由本用例拥有；取消 reader 不保证 raw Response 的底层订阅一起退出，
        // 请求 signal 才能释放 heartbeat、GlobalBus 订阅和连接计数。
        const controller = new AbortController()
        const openGlobalStream = (viewer: boolean) =>
          Effect.gen(function* () {
            const headers = new Headers({ "x-opencode-directory": directory })
            if (viewer) headers.set("x-opencode-tui-message-projection", "viewer")
            const response = yield* requestInDirectory("/global/event", directory, { headers, signal: controller.signal })
            const reader = yield* Queue.unbounded<typeof Frame.Type["payload"]>()
            yield* response.stream.pipe(
              // 网络chunk可拆分/合并SSE帧，复用正式decoder后再读取完整事件。
              Stream.decodeText(),
              Stream.pipeThroughChannel(Sse.decodeDataSchema(Frame)),
              Stream.runForEach((event) => Queue.offer(reader, event.data.payload)),
              Effect.forkScoped,
            )
            return { reader }
          })
        const readPayload = (reader: Queue.Dequeue<typeof Frame.Type["payload"]>) =>
          Effect.gen(function* () {
            const value = yield* Queue.take(reader).pipe(
              Effect.timeoutOrElse({
                duration: "5 seconds",
                orElse: () => Effect.fail(new Error("timed out waiting for global event")),
              }),
            )
            return value
          })
        const readPartEvent = (reader: Queue.Dequeue<typeof Frame.Type["payload"]>) =>
          Effect.gen(function* () {
            for (;;) {
              const event = yield* readPayload(reader)
              if (event?.type === "message.part.updated") return event
            }
          })
        const viewer = yield* openGlobalStream(true)
        const complete = yield* openGlobalStream(false)
        try {
          expect((yield* readPayload(viewer.reader))?.type).toBe("server.connected")
          expect((yield* readPayload(complete.reader))?.type).toBe("server.connected")

          GlobalBus.emit("event", {
            directory,
            payload: { type: "message.part.updated", properties: { sessionID: "ses_viewer_sse", part, time: 2 } },
          })

          // viewer 连接剪掉与 diff 逐字重复的 patch；默认连接的合同字段原样保留。
          const viewerEvent = yield* readPartEvent(viewer.reader)
          const completeEvent = yield* readPartEvent(complete.reader)
          const viewerPart = viewerEvent?.properties?.part
          const completePart = completeEvent?.properties?.part
          expect(viewerPart).toMatchObject({ type: "tool", state: { status: "completed", metadata: { diff: patch } } })
          expect(viewerPart?.type === "tool" && viewerPart.state.status === "completed" ? viewerPart.state.metadata.filediff : undefined)
            .toEqual({ file: "a.ts", additions: 64, deletions: 0 })
          expect(completePart).toMatchObject({ type: "tool", state: { metadata: { filediff: { patch } } } })
        } finally {
          // 先沿请求 signal 释放 heartbeat、GlobalBus 订阅和连接计数，再结算两个 reader。
          controller.abort()
          yield* Queue.shutdown(viewer.reader)
          yield* Queue.shutdown(complete.reader)
        }
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance("native viewer HTTP and both SSE transports preserve identity order and complete data", () => Effect.gen(function* () {
    const instance = yield* TestInstance
    const response = yield* requestInDirectory("/session", instance.directory, { method: "POST" })
    const info = Schema.decodeUnknownSync(SessionV1.SessionInfo)(yield* response.json)
    const events = yield* EventV2Bridge.Service
    const sessionID = SessionV2.ID.make(info.id)
    const assistantMessageID = SessionMessage.ID.create()
    const timestamp = DateTime.makeUnsafe(1)
    yield* events.publish(SessionEvent.Step.Started, { sessionID, assistantMessageID, timestamp, agent: "build", model: { id: ModelV2.ID.make("test"), providerID: ProviderV2.ID.make("test") } })
    for (const [callID, tool] of [["call-a", "edit"], ["call-b", "third_party_custom"]]) {
      yield* events.publish(SessionEvent.Tool.Input.Started, { sessionID, assistantMessageID, timestamp, callID, name: tool })
      yield* events.publish(SessionEvent.Tool.Called, { sessionID, assistantMessageID, timestamp, callID, tool, input: { filePath: "a.ts" }, provider: { executed: false } })
    }
    // 流使用正式SSE分帧；四条连接都先ready，避免把订阅竞态误认为投影丢事件。
    const open = (url: string, viewer: boolean) => Effect.gen(function* () {
      const response = yield* requestInDirectory(url, instance.directory, { headers: viewer ? { "x-opencode-tui-message-projection": "viewer" } : {} })
      const reader = yield* Queue.unbounded<unknown>()
      yield* response.stream.pipe(Stream.decodeText(), Stream.pipeThroughChannel(Sse.decodeDataSchema(Schema.Unknown)), Stream.runForEach((event) => Queue.offer(reader, event.data)), Effect.forkScoped)
      return reader
    })
    const take = (reader: Queue.Dequeue<unknown>) => Queue.take(reader).pipe(Effect.timeout("5 seconds"))
    const nativeViewer = yield* open("/api/event", true)
    const nativeComplete = yield* open("/api/event", false)
    const globalViewer = yield* open("/global/event", true)
    const globalComplete = yield* open("/global/event", false)
    const GlobalFrame = Schema.Struct({ payload: Schema.Struct({ id: Schema.String, type: Schema.String, properties: Schema.optionalKey(Schema.Unknown), syncEvent: Schema.optionalKey(Schema.Unknown) }) })
    for (const reader of [nativeViewer, nativeComplete]) expect(Schema.decodeUnknownSync(OpenCodeEvent)(yield* take(reader)).type).toBe("server.connected")
    for (const reader of [globalViewer, globalComplete]) expect(Schema.decodeUnknownSync(GlobalFrame)(yield* take(reader)).payload.type).toBe("server.connected")
    const patch = "+duplicate\n".repeat(64)
    const structured = Object.freeze({ diff: patch, filediff: Object.freeze({ file: "a.ts", patch, additions: 64, deletions: 0 }), diagnostics: {} })
    const published = []
    for (const callID of ["call-a", "call-b"]) published.push(yield* events.publish(SessionEvent.Tool.Success, {
      sessionID, assistantMessageID, callID, timestamp: DateTime.makeUnsafe(2), structured,
      content: [{ type: "text", text: "done" }], result: { kept: true }, outputPaths: ["a.ts"], provider: { executed: false },
    }))
    const marker = yield* events.publish(SessionEvent.ContextUpdated, { sessionID, messageID: SessionMessage.ID.create(), text: "marker", timestamp: DateTime.makeUnsafe(0) })
    published.push(marker)
    const wanted = new Set(published.map((event) => event.id))
    const collectNative = (reader: Queue.Dequeue<unknown>) => Effect.gen(function* () {
      const result = []
      for (;;) {
        const event = Schema.decodeUnknownSync(OpenCodeEvent)(yield* take(reader))
        if (!wanted.has(event.id)) continue
        result.push(event)
        if (event.id === marker.id) return result
      }
    })
    const Sync = Schema.Struct({ id: Schema.String, type: Schema.String, seq: Schema.Number, aggregateID: Schema.String, data: Schema.Unknown })
    const collectGlobal = (reader: Queue.Dequeue<unknown>) => Effect.gen(function* () {
      const result = []
      const syncs = []
      for (;;) {
        const payload = Schema.decodeUnknownSync(GlobalFrame)(yield* take(reader)).payload
        if (payload.type === "sync") {
          const event = Schema.decodeUnknownSync(Sync)(payload.syncEvent)
          if (wanted.has(EventV2.ID.make(event.id))) syncs.push(event)
        } else if (wanted.has(EventV2.ID.make(payload.id))) result.push({ id: payload.id, type: payload.type, data: payload.properties })
        if (result.some((event) => event.id === marker.id) && syncs.some((event) => event.id === marker.id)) return { result, syncs }
      }
    })
    const [nv, nc, gv, gc] = yield* Effect.all([collectNative(nativeViewer), collectNative(nativeComplete), collectGlobal(globalViewer), collectGlobal(globalComplete)])
    const identities = published.map((event) => ({ id: event.id, type: event.type }))
    for (const list of [nv, nc, gv.result, gc.result]) expect(list.map((event) => ({ id: event.id, type: event.type }))).toEqual(identities)
    const durable = published.map((event) => {
      if (!event.durable) throw new Error("native fixture event did not commit")
      return { id: event.id, type: EventV2.versionedType(event.type, event.durable.version), seq: event.durable.seq, aggregateID: event.durable.aggregateID }
    })
    for (const list of [gv.syncs, gc.syncs]) expect(list.map(({ id, type, seq, aggregateID }) => ({ id, type, seq, aggregateID }))).toEqual(durable)
    const Fields = Schema.Struct({ structured: Schema.Struct({ diff: Schema.String, filediff: Schema.Record(Schema.String, Schema.Unknown) }) })
    // Success本身缺工具身份，全部连接保留patch；HTTP持有工具对象后才精确裁剪edit。
    for (const list of [nv, gv.result, gv.syncs]) for (const event of list.slice(0, 2)) {
      expect(Schema.decodeUnknownSync(Fields)(event.data).structured.filediff).toEqual({ file: "a.ts", patch, additions: 64, deletions: 0 })
      expect(event.data).toMatchObject({ structured: { diff: patch, diagnostics: {} }, content: [{ type: "text", text: "done" }], result: { kept: true }, outputPaths: ["a.ts"] })
    }
    for (const list of [nc, gc.result, gc.syncs]) for (const event of list.slice(0, 2)) expect(event.data).toMatchObject({ structured: { filediff: { patch } } })
    expect(structured.filediff.patch).toBe(patch)
    expect(published[0].data).toMatchObject({ structured: { filediff: { patch } } })
    const Page = Schema.Struct({ data: Schema.Array(SessionMessage.Message), cursor: Schema.Struct({ previous: Schema.optionalKey(Schema.String), next: Schema.optionalKey(Schema.String) }) })
    const page = (viewer: boolean, cursor?: string) => Effect.gen(function* () {
      const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "?limit=1&order=asc"
      const response = yield* requestInDirectory(`/api/session/${sessionID}/message${query}`, instance.directory, { headers: viewer ? { "x-opencode-tui-message-projection": "viewer" } : {} })
      expect(response.status).toBe(200)
      return Schema.decodeUnknownSync(Page)(yield* response.json)
    })
    const firstViewer = yield* page(true)
    const firstComplete = yield* page(false)
    expect(firstViewer.data.map((message) => message.id)).toEqual([assistantMessageID])
    expect(firstViewer.cursor).toEqual(firstComplete.cursor)
    for (const [view, full] of firstViewer.data.map((message, index) => [message, firstComplete.data[index]] as const)) {
      if (view.type !== "assistant" || full.type !== "assistant") throw new Error("native assistant page is missing")
      expect(view.content.map((part) => part.type === "tool" ? part.id : part.type)).toEqual(full.content.map((part) => part.type === "tool" ? part.id : part.type))
      expect(view.content.filter((part) => part.type === "tool").map((part) => part.name)).toEqual(["edit", "third_party_custom"])
      for (const part of view.content) if (part.type === "tool" && part.state.status === "completed") expect(part.state.structured.filediff).toEqual({ file: "a.ts", additions: 64, deletions: 0, ...(part.name === "edit" ? {} : { patch }) })
      for (const part of full.content) if (part.type === "tool" && part.state.status === "completed") expect(part.state.structured.filediff).toMatchObject({ patch })
    }
    if (!firstViewer.cursor.next || !firstComplete.cursor.next) throw new Error("native next cursor is missing")
    const nextViewer = yield* page(true, firstViewer.cursor.next)
    const nextComplete = yield* page(false, firstComplete.cursor.next)
    expect(nextViewer).toEqual(nextComplete)
    expect(nextViewer.data.map((message) => message.id)).toEqual([marker.data.messageID])
    // 最后再读完整页，确认viewer从未改写持久消息。
    expect(yield* page(false)).toEqual(firstComplete)
  }), { git: true, config: { formatter: false, lsp: false } })
})
