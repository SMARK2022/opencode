import { BusEvent } from "@/bus/bus-event"
import { AsyncQueue } from "@/util/queue"
import { Schema } from "effect"
import type { Context } from "hono"

export const Event = {
  Connected: BusEvent.define("server.connected", Schema.Struct({})),
  Disposed: BusEvent.define("global.disposed", Schema.Struct({})),
}

const encoder = new TextEncoder()

export function streamEventSource(
  c: Context,
  input: {
    initial: string[]
    heartbeat: () => string
    subscribe: (q: AsyncQueue<string | null>) => () => void
    onClose?: () => void
  },
) {
  const q = new AsyncQueue<string | null>()
  let done = false
  input.initial.forEach((item) => q.push(item))

  // Keep the connection active through proxies.  This helper intentionally
  // writes SSE frames directly instead of Hono's streamSSE wrapper because Bun
  // on Windows can buffer small TransformStream writes, delaying token deltas.
  const heartbeat = setInterval(() => q.push(input.heartbeat()), 10_000)
  const unsub = input.subscribe(q)

  const stop = () => {
    if (done) return
    done = true
    clearInterval(heartbeat)
    unsub()
    q.push(null)
    input.onClose?.()
  }

  const body = new ReadableStream({
    async start(controller) {
      const abortHandler = () => {
        stop()
        try {
          controller.close()
        } catch {
          // The normal stream finalizer may have already closed the controller.
        }
      }
      c.req.raw.signal.addEventListener("abort", abortHandler, { once: true })

      try {
        for await (const data of q) {
          if (data === null) break
          controller.enqueue(encoder.encode(`data: ${data}\n\n`))
        }
      } catch {
        // The client disconnected while the stream was being written.
      } finally {
        c.req.raw.signal.removeEventListener("abort", abortHandler)
        stop()
        try {
          controller.close()
        } catch {
          // The abort path may have already closed the controller.
        }
      }
    },
    cancel() {
      stop()
    },
  })

  c.header("Transfer-Encoding", "chunked")
  c.header("Content-Type", "text/event-stream")
  c.header("Cache-Control", "no-cache, no-transform")
  c.header("Connection", "keep-alive")
  c.header("X-Accel-Buffering", "no")
  c.header("X-Content-Type-Options", "nosniff")
  return c.newResponse(body)
}
