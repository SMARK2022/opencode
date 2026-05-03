import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer, Queue, Schema, Stream } from "effect"
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
import { SessionProcessor } from "../../src/session/processor"
import { Token } from "@opencode-ai/core/util/token"
import { SessionProjector } from "@opencode-ai/core/session/projector"

const EventData = Schema.Struct({
  id: Schema.optional(Schema.String),
  type: Schema.String,
  properties: Schema.Record(Schema.String, Schema.Any),
})

const readEvent = (reader: Queue.Dequeue<Uint8Array>) =>
  Effect.gen(function* () {
    const value = yield* Queue.take(reader).pipe(
      Effect.timeoutOrElse({
        duration: "5 seconds",
        orElse: () => Effect.fail(new Error("timed out waiting for event")),
      }),
    )
    return Schema.decodeUnknownSync(EventData)(JSON.parse(new TextDecoder().decode(value).replace(/^data: /, "")))
  })

const openEventStream = (directory: string) =>
  Effect.gen(function* () {
    const response = yield* requestInDirectory(EventPaths.event, directory)
    const reader = yield* Queue.unbounded<Uint8Array>()
    yield* response.stream.pipe(
      Stream.runForEach((value) => Queue.offer(reader, value)),
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
        expect(yield* readEvent(reader)).toMatchObject({
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
})
