import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceState } from "@/effect/instance-state"
import { GlobalBus } from "@/bus/global"
import { EventV2 } from "@opencode-ai/core/event"
import { Cause, Effect, Queue } from "effect"
import * as Stream from "effect/Stream"
import { HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import * as Sse from "effect/unstable/encoding/Sse"
import { EventApi } from "../groups/event"
import { EventClients } from "@opencode-ai/server/event-clients"

const CLIENT_EVENT_CAPACITY = 256
const serializedEvents = new WeakMap<object, Sse.Event>()

function eventData(data: unknown, source?: object): Sse.Event {
  const key = source ?? (data !== null && typeof data === "object" ? data : undefined)
  const cached = key ? serializedEvents.get(key) : undefined
  if (cached) return cached
  const serialized = {
    _tag: "Event",
    event: "message",
    id: undefined,
    data: JSON.stringify(data),
  } satisfies Sse.Event
  // EventV2 payload 是共享的不可变广播对象，绕开每个连接新建的包装对象。
  if (key) serializedEvents.set(key, serialized)
  return serialized
}

function eventID() {
  return EventV2.ID.create()
}

function eventResponse(events: EventV2.Interface, clients: EventClients.Interface) {
  return Effect.gen(function* () {
    const instance = yield* InstanceState.context
    const workspaceID = yield* InstanceState.workspaceID
    // 注册先于 server.connected，容量溢出会失败当前响应并触发客户端重连刷新。
    const input = yield* EventV2.allBounded(events, CLIENT_EVENT_CAPACITY)
    const stream = input.pipe(
      Stream.filter(
        (event) =>
          event.location?.directory === instance.directory &&
          (event.location.workspaceID === undefined || event.location.workspaceID === workspaceID),
      ),
      Stream.map((event) => ({ id: event.id, type: event.type, properties: event.data, source: event })),
    )
    const compatibility = yield* Queue.dropping<{ id: string; type: string; properties: unknown }, EventV2.SubscriberOverflowError>(CLIENT_EVENT_CAPACITY)
    const listener = (event: {
      directory?: string
      workspace?: string
      payload: { id?: string; type?: string; properties?: unknown; metadata?: { projection?: boolean } }
    }) => {
      if (event.directory !== instance.directory) return
      // 普通事件已由EventV2送达；这里只补转bridge的读投影与原有销毁通知，避免双重投递。
      const snapshot = event.payload.type === "session.updated" && event.payload.metadata?.projection === true
      if (!snapshot && event.payload.type !== "server.instance.disposed") return
      if (snapshot && event.workspace !== undefined && event.workspace !== workspaceID) return
      const accepted = Queue.offerUnsafe(compatibility, {
        id: event.payload.id ?? eventID(),
        type: snapshot ? "session.updated" : "server.instance.disposed",
        properties: event.payload.properties ?? {},
      })
      if (!accepted) Queue.failCauseUnsafe(compatibility, Cause.fail(new EventV2.SubscriberOverflowError({ capacity: CLIENT_EVENT_CAPACITY })))
    }
    // 与Core listener一样在响应前注册；退出随同一Scope退订，不丢首包前的请求投影。
    yield* Effect.acquireRelease(
      Effect.sync(() => GlobalBus.on("event", listener)),
      () => Effect.sync(() => GlobalBus.off("event", listener)),
    )
    const output = stream.pipe(
      Stream.merge(Stream.fromQueue(compatibility), { haltStrategy: "left" }),
      Stream.takeUntil((event) => event.type === "server.instance.disposed"),
    )
    const heartbeat = Stream.tick("10 seconds").pipe(
      Stream.drop(1),
      Stream.map(() => ({ id: eventID(), type: "server.heartbeat", properties: {} })),
    )

    yield* Effect.logInfo("event connected")
    return HttpServerResponse.stream(
      // /event 使用相同 body-scope 租约，不能因为未订阅 /global/event 被误判为空闲。
      Stream.unwrap(Effect.as(clients.acquire, Stream.make({ id: eventID(), type: "server.connected", properties: {} }).pipe(
        Stream.concat(output.pipe(Stream.merge(heartbeat, { haltStrategy: "left" }))),
        Stream.map((event) => eventData(
          { id: event.id, type: event.type, properties: event.properties },
          "source" in event ? event.source : undefined,
        )),
        Stream.pipeThroughChannel(Sse.encode()),
        Stream.encodeText,
        Stream.ensuring(Effect.logInfo("event disconnected")),
      ))),
      {
        contentType: "text/event-stream",
        headers: {
          "Cache-Control": "no-cache, no-transform",
          "X-Accel-Buffering": "no",
          "X-Content-Type-Options": "nosniff",
        },
      },
    )
  })
}

export const eventHandlers = HttpApiBuilder.group(EventApi, "event", (handlers) =>
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    // 只跨闭包传递稳定服务；原有 eager EventV2 listener 的无丢事件顺序不变。
    const clients = yield* EventClients.Service
    return handlers.handleRaw(
      "subscribe",
      Effect.fn("EventHttpApi.subscribe")(function* () {
        return yield* eventResponse(events, clients)
      }),
    )
  }),
)
