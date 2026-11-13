import { Config } from "@/config/config"
import { GlobalBus, type GlobalEvent as GlobalBusEvent } from "@/bus/global"
import { EffectBridge } from "@/effect/bridge"
import { EventV2 } from "@opencode-ai/core/event"
import { Installation } from "@/installation"
import { disposeAllInstancesAndEmitGlobalDisposed } from "@/server/global-lifecycle"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { Effect, Queue } from "effect"
import * as Stream from "effect/Stream"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import * as Sse from "effect/unstable/encoding/Sse"
import { RootHttpApi } from "../api"
import { GlobalUpgradeInput } from "../groups/global"
import { EventClients } from "@opencode-ai/server/event-clients"
import { PartView } from "@opencode-ai/core/session/part-view"
import { DisposedReason, Event } from "@/server/event"
import type { MessageV2 } from "@/session/message-v2"

const CLIENT_EVENT_CAPACITY = 256
const serializedEvents = new WeakMap<GlobalBusEvent, { complete?: Sse.Event; viewer?: Sse.Event }>()

function eventData(event: GlobalBusEvent, viewer: boolean): Sse.Event {
  const variant = viewer ? "viewer" : "complete"
  const cached = serializedEvents.get(event)
  const existing = cached?.[variant]
  if (existing) return existing
  // 同一广播对象在所有连接间共享；完整与 viewer 投影各占独立缓存槽。
  const serialized = {
    _tag: "Event",
    event: "message",
    id: undefined,
    data: JSON.stringify(viewer ? projectViewerEvent(event) : event),
  } satisfies Sse.Event
  serializedEvents.set(event, { ...cached, [variant]: serialized })
  return serialized
}

// 只投影当前viewer连接的副本，ID/顺序/次数与其他listener的完整事件保持不变。
function projectViewerEvent(event: GlobalBusEvent): GlobalBusEvent {
  const payload = event.payload
  if (payload.type === "message.part.updated" || payload.type === "message.part.progress") {
    const part = (payload.properties as { part?: MessageV2.Part }).part
    if (!part) return event
    const next = PartView.project(part)
    return next === part ? event : { ...event, payload: { ...payload, properties: { ...payload.properties, part: next } } }
  }
  // native Success没有工具身份；普通帧和sync副本都保留完整，不增加传输侧状态。
  if (payload.type === "session.next.tool.success") return event
  if (payload.type === "sync" && payload.syncEvent?.data) {
    const syncEvent = payload.syncEvent
    const data = syncEvent.data
    if (syncEvent.type === EventV2.versionedType("session.next.tool.success", 1)) return event
    const part = (data as { part?: MessageV2.Part }).part
    if (!part) return event
    const next = PartView.project(part)
    return next === part ? event : { ...event, payload: { ...payload, syncEvent: { ...syncEvent, data: { ...data, part: next } } } }
  }
  return event
}

function eventResponse(clients: EventClients.Interface, viewer: boolean) {
  return Effect.gen(function* () {
    yield* Effect.logInfo("global event connected")
    const events = Stream.callback<GlobalBusEvent>((queue) => {
      const handler = (event: GlobalBusEvent) => {
        // 慢客户端溢出后结束当前流，重连以 server.connected 为边界重新同步。
        if (!Queue.offerUnsafe(queue, event)) Queue.endUnsafe(queue)
      }
      return Effect.acquireRelease(
        Effect.sync(() => GlobalBus.on("event", handler)),
        () => Effect.sync(() => GlobalBus.off("event", handler)),
      )
    }, { bufferSize: CLIENT_EVENT_CAPACITY, strategy: "dropping" })
    const heartbeat = Stream.tick("10 seconds").pipe(
      Stream.drop(1),
      Stream.map(() => ({ payload: { id: EventV2.ID.create(), type: "server.heartbeat", properties: {} } })),
    )

    return HttpServerResponse.stream(
      // 计数属于响应 body 的 scope；未消费响应不虚增，取消流自动释放。
      Stream.unwrap(Effect.as(clients.acquire, Stream.make({ payload: { id: EventV2.ID.create(), type: "server.connected", properties: {} } }).pipe(
        Stream.concat(events.pipe(Stream.merge(heartbeat, { haltStrategy: "left" }))),
        // 仅主动停机成为末帧；普通 dispose/凭证刷新仍保留同一订阅。
        Stream.takeUntil((event) =>
          event.payload?.type === Event.Disposed.type && event.payload.properties?.reason === DisposedReason.DaemonStop,
        ),
        Stream.map((event) => eventData(event, viewer)),
        Stream.pipeThroughChannel(Sse.encode()),
        Stream.encodeText,
        Stream.ensuring(Effect.logInfo("global event disconnected")),
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

export const globalHandlers = HttpApiBuilder.group(RootHttpApi, "global", (handlers) =>
  Effect.gen(function* () {
    const config = yield* Config.Service
    const installation = yield* Installation.Service
    const bridge = yield* EffectBridge.make()
    // Handler 只持有注入的共享服务，不另建 global-event 专属计数器。
    const clients = yield* EventClients.Service

    const health = Effect.fn("GlobalHttpApi.health")(function* () {
      return { healthy: true as const, version: InstallationVersion }
    })

    const event = Effect.fn("GlobalHttpApi.event")(function* (ctx: { request: HttpServerRequest.HttpServerRequest }) {
      return yield* eventResponse(clients, ctx.request.headers["x-opencode-tui-message-projection"] === "viewer")
    })

    const configGet = Effect.fn("GlobalHttpApi.configGet")(function* () {
      return yield* config.getGlobal()
    })

    const configUpdate = Effect.fn("GlobalHttpApi.configUpdate")(function* (ctx) {
      const result = yield* config.updateGlobal(ctx.payload)
      if (result.changed) bridge.fork(disposeAllInstancesAndEmitGlobalDisposed({ swallowErrors: true }))
      return result.info
    })

    const dispose = Effect.fn("GlobalHttpApi.dispose")(function* () {
      yield* disposeAllInstancesAndEmitGlobalDisposed()
      return true
    })

    const upgrade = Effect.fn("GlobalHttpApi.upgrade")(function* (ctx: { payload: typeof GlobalUpgradeInput.Type }) {
      const method = yield* installation.method()
      if (method === "unknown") {
        return HttpServerResponse.jsonUnsafe(
          { success: false as const, error: "Unknown installation method" },
          { status: 400 },
        )
      }
      const target = ctx.payload.target
      const result = yield* installation.upgrade(method, target).pipe(
        Effect.as({ success: true as const, version: target }),
        Effect.catch((err) =>
          Effect.succeed({
            success: false as const,
            error: err instanceof Error ? err.message : String(err),
          }),
        ),
      )
      if (!result.success) return HttpServerResponse.jsonUnsafe(result, { status: 500 })
      GlobalBus.emit("event", {
        directory: "global",
        payload: {
          type: Installation.Event.Updated.type,
          properties: { version: target },
        },
      })
      return HttpServerResponse.jsonUnsafe(result)
    })

    return handlers
      .handle("health", health)
      .handleRaw("event", event)
      .handle("configGet", configGet)
      .handle("configUpdate", configUpdate)
      .handle("dispose", dispose)
      .handle("upgrade", upgrade)
  }),
)
