import { EventV2 } from "@opencode-ai/core/event"
import { OpenCodeEvent } from "@opencode-ai/protocol/groups/event"
import { Cause, Effect, FiberHandle, Queue, Schema, Stream } from "effect"
import { HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import * as Sse from "effect/unstable/encoding/Sse"
import { Api } from "../api"
import { EventClients } from "../event-clients"

const backlog = 256
export const burstCapacity = 4096

export function eventOffer<A, E>(queue: Queue.Queue<A, E>, overflow: () => void) {
  return Effect.gen(function* () {
    const run = yield* FiberHandle.makeRuntime<never>()
    const check = Effect.yieldNow.pipe(Effect.map(() => {
      if (Queue.sizeUnsafe(queue) > backlog) overflow()
    }))
    return (event: A) => {
      if (!Queue.offerUnsafe(queue, event)) return overflow()
      // fromQueue 整批取走积压；再次跨线时由新一批替换上次的检查。
      if (Queue.sizeUnsafe(queue) === backlog + 1) run(check)
    }
  })
}

export const subscribeEvents = (events: EventV2.Interface, predicate?: (event: EventV2.Payload) => boolean) =>
  Effect.gen(function* () {
    const queue = yield* Queue.dropping<EventV2.Payload, EventV2.SubscriberOverflowError>(burstCapacity)
    const offer = yield* eventOffer(queue, () => Queue.failCauseUnsafe(queue, Cause.fail(new EventV2.SubscriberOverflowError({ capacity: backlog }))))
    const off = yield* events.listen(event => Effect.sync(() => {
      if (!predicate || predicate(event)) offer(event)
    }), { finalizerSafe: true })
    yield* Effect.addFinalizer(() => off.pipe(Effect.andThen(Queue.shutdown(queue))))
    return Stream.fromQueue(queue)
  })

function eventData(data: unknown): Sse.Event {
  return {
    _tag: "Event",
    event: "message",
    id: undefined,
    // Success没有工具名，不按structured形状猜生产者；正式编码和背压保持原路径。
    data: JSON.stringify(Schema.encodeUnknownSync(OpenCodeEvent)(data)),
  }
}

export const EventHandler = HttpApiBuilder.group(Api, "server.event", (handlers) =>
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    // native handler 与 legacy handler 使用装配时注入的同一个 daemon 服务。
    const clients = yield* EventClients.Service
    return handlers.handleRaw("event.subscribe", () =>
      Effect.gen(function* () {
        const connected = {
          id: EventV2.ID.create(),
          type: "server.connected",
          data: {},
        }
        const output = Stream.unwrap(
          Effect.gen(function* () {
            // 租约和事件订阅同属此 scope，取消/失败不会留下客户端计数。
            yield* clients.acquire
            // Acquiring the bounded stream installs its listener before readiness is observable.
            const live = yield* subscribeEvents(events)
            return Stream.make(connected).pipe(Stream.concat(live))
          }),
        ).pipe(Stream.map(eventData), Stream.pipeThroughChannel(Sse.encode()))
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
