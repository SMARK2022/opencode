import { EventV2 } from "@opencode-ai/core/event"
import { OpenCodeEvent } from "@opencode-ai/protocol/groups/event"
import { Effect, Schema, Stream } from "effect"
import { HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import * as Sse from "effect/unstable/encoding/Sse"
import { Api } from "../api"
import { EventClients } from "../event-clients"
import { PartView } from "@opencode-ai/core/session/part-view"

const subscriberCapacity = 256

function eventData(data: unknown, viewer: boolean): Sse.Event {
  const encoded = Schema.encodeUnknownSync(OpenCodeEvent)(data)
  // 先走正式编码，再投影当前连接的native成功事件；背压、事件身份与完整订阅不变。
  const projected = viewer && encoded.type === "session.next.tool.success"
    ? { ...encoded, data: { ...encoded.data, structured: PartView.projectFields(encoded.data.structured) } }
    : encoded
  return {
    _tag: "Event",
    event: "message",
    id: undefined,
    data: JSON.stringify(projected),
  }
}

export const EventHandler = HttpApiBuilder.group(Api, "server.event", (handlers) =>
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    // native handler 与 legacy handler 使用装配时注入的同一个 daemon 服务。
    const clients = yield* EventClients.Service
    return handlers.handleRaw("event.subscribe", (ctx) =>
      Effect.gen(function* () {
        const viewer = ctx.request.headers["x-opencode-tui-message-projection"] === "viewer"
        const connected = {
          id: EventV2.ID.create(),
          type: "server.connected",
          data: {},
        }
        const output = Stream.unwrap(
          Effect.gen(function* () {
            // 租约和 allBounded listener 同属此 scope，取消/失败不会留下客户端计数。
            yield* clients.acquire
            // Acquiring the bounded stream installs its listener before readiness is observable.
            const live = yield* EventV2.allBounded(events, subscriberCapacity)
            return Stream.make(connected).pipe(Stream.concat(live))
          }),
        ).pipe(Stream.map((event) => eventData(event, viewer)), Stream.pipeThroughChannel(Sse.encode()))
        const heartbeat = Stream.tick("15 seconds").pipe(Stream.map(() => ": heartbeat\n\n"))
        return HttpServerResponse.stream(
          output.pipe(Stream.merge(heartbeat, { haltStrategy: "left" }), Stream.encodeText),
          {
            contentType: "text/event-stream",
            headers: {
              "Cache-Control": "no-cache, no-transform",
              "X-Accel-Buffering": "no",
              "X-Content-Type-Options": "nosniff",
            },
          },
        )
      }),
    )
  }),
)
