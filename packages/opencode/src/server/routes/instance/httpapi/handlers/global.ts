import { Config } from "@/config/config"
import { GlobalBus, type GlobalEvent as GlobalBusEvent } from "@/bus/global"
import { EffectBridge } from "@/effect/bridge"
import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { Installation } from "@/installation"
import { disposeAllInstancesAndEmitGlobalDisposed } from "@/server/global-lifecycle"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import * as Log from "@opencode-ai/core/util/log"
import { Effect, Schema } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { RootHttpApi } from "../api"
import { GlobalUpgradeInput } from "../groups/global"
import { PassThrough } from "node:stream"

const log = Log.create({ service: "server" })

// [local-smark] SSE client count tracking for daemon idle-timeout
export const GlobalDisposedEvent = BusEvent.define("global.disposed", Schema.Struct({}))

let sseClientCount = 0
let onSseCountChange: ((n: number) => void) | undefined

export function onSseClientCountChange(cb: (n: number) => void) {
  onSseCountChange = cb
}

function eventData(data: unknown) {
  return `data: ${JSON.stringify(data)}\n\n`
}

function parseBody(body: string) {
  try {
    return JSON.parse(body || "{}") as unknown
  } catch {
    return undefined
  }
}

type AbortSource = {
  once: (event: "aborted", listener: () => void) => unknown
  off: (event: "aborted", listener: () => void) => unknown
}

function abortSource(source: object): AbortSource | undefined {
  const candidate = source as { once?: unknown; off?: unknown }
  if (typeof candidate.once !== "function" || typeof candidate.off !== "function") return
  return candidate as AbortSource
}

function onRequestAbort(request: HttpServerRequest.HttpServerRequest, close: () => void) {
  if (request.source instanceof Request) {
    request.source.signal.addEventListener("abort", close, { once: true })
    return () => request.source instanceof Request && request.source.signal.removeEventListener("abort", close)
  }

  const source = abortSource(request.source)
  if (!source) return () => {}
  source.once("aborted", close)
  return () => source.off("aborted", close)
}

function eventResponse(request: HttpServerRequest.HttpServerRequest) {
  // [local-smark] Track SSE client count for daemon idle-timeout
  sseClientCount++
  onSseCountChange?.(sseClientCount)
  log.info("global event connected")

  const stream = new PassThrough()
  const write = (event: GlobalBusEvent) => {
    if (stream.destroyed) return
    stream.write(eventData(event))
  }
  const handler = (event: GlobalBusEvent) => write(event)
  const heartbeat = setInterval(
    () => write({ payload: { id: Bus.createID(), type: "server.heartbeat", properties: {} } }),
    10_000,
  )
  let closed = false
  let unsubscribeRequestAbort = () => {}
  const close = () => {
    if (closed) return
    closed = true
    clearInterval(heartbeat)
    GlobalBus.off("event", handler)
    unsubscribeRequestAbort()
    if (!stream.destroyed) stream.end()
    sseClientCount = Math.max(0, sseClientCount - 1)
    onSseCountChange?.(sseClientCount)
    log.info("global event disconnected")
  }

  heartbeat.unref?.()
  GlobalBus.on("event", handler)
  unsubscribeRequestAbort = onRequestAbort(request, close)
  stream.once("close", close)
  stream.once("error", close)
  write({ payload: { id: Bus.createID(), type: "server.connected", properties: {} } })

  return HttpServerResponse.raw(
    stream,
    {
      contentType: "text/event-stream",
      headers: {
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no",
        "X-Content-Type-Options": "nosniff",
      },
    },
  )
}

export const globalHandlers = HttpApiBuilder.group(RootHttpApi, "global", (handlers) =>
  Effect.gen(function* () {
    const config = yield* Config.Service
    const installation = yield* Installation.Service
    const bridge = yield* EffectBridge.make()

    const health = Effect.fn("GlobalHttpApi.health")(function* () {
      return { healthy: true as const, version: InstallationVersion }
    })

    const event = Effect.fn("GlobalHttpApi.event")(function* () {
      return eventResponse(yield* HttpServerRequest.HttpServerRequest)
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
        return {
          status: 400,
          body: { success: false as const, error: "Unknown installation method" },
        }
      }
      const target = ctx.payload.target || (yield* installation.latest(method))
      const result = yield* installation.upgrade(method, target).pipe(
        Effect.as({ status: 200, body: { success: true as const, version: target } }),
        Effect.catch((err) =>
          Effect.succeed({
            status: 500,
            body: {
              success: false as const,
              error: err instanceof Error ? err.message : String(err),
            },
          }),
        ),
      )
      if (!result.body.success) return result
      GlobalBus.emit("event", {
        directory: "global",
        payload: {
          type: Installation.Event.Updated.type,
          properties: { version: target },
        },
      })
      return result
    })

    const upgradeRaw = Effect.fn("GlobalHttpApi.upgradeRaw")(function* (ctx: {
      request: HttpServerRequest.HttpServerRequest
    }) {
      const body = yield* Effect.orDie(ctx.request.text)
      const json = parseBody(body)
      if (json === undefined) {
        return HttpServerResponse.jsonUnsafe({ success: false, error: "Invalid request body" }, { status: 400 })
      }
      const payload = yield* Schema.decodeUnknownEffect(GlobalUpgradeInput)(json).pipe(
        Effect.map((payload) => ({ valid: true as const, payload })),
        Effect.catch(() => Effect.succeed({ valid: false as const })),
      )
      if (!payload.valid) {
        return HttpServerResponse.jsonUnsafe({ success: false, error: "Invalid request body" }, { status: 400 })
      }
      const result = yield* upgrade({ payload: payload.payload })
      return HttpServerResponse.jsonUnsafe(result.body, { status: result.status })
    })

    return handlers
      .handle("health", health)
      .handleRaw("event", event)
      .handle("configGet", configGet)
      .handle("configUpdate", configUpdate)
      .handle("dispose", dispose)
      .handleRaw("upgrade", upgradeRaw)
  }),
)
