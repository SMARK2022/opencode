import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import type { GlobalEvent } from "@opencode-ai/sdk/v2"
import { createSimpleContext } from "./helper"
import { createGlobalEmitter } from "@solid-primitives/event-bus"
import { Flag } from "@opencode-ai/core/flag/flag"
import { batch, onCleanup, onMount } from "solid-js"
import { ConnectionError } from "../util/connection-error"

export type EventSource = {
  subscribe: (handler: (event: GlobalEvent) => void) => Promise<() => void>
}

export const { use: useSDK, provider: SDKProvider } = createSimpleContext({
  name: "SDK",
  init: (props: {
    url: string
    directory?: string
    fetch?: typeof fetch
    headers?: RequestInit["headers"]
    events?: EventSource
    reconnect?: () => Promise<string>
    heartbeatTimeout?: number
  }) => {
    const abort = new AbortController()
    let sse: AbortController | undefined
    let url = props.url

    function createSDK() {
      return createOpencodeClient({
        baseUrl: url,
        signal: abort.signal,
        directory: props.directory,
        fetch: props.fetch,
        headers: props.headers,
      })
    }

    let sdk = createSDK()

    const emitter = createGlobalEmitter<{
      event: GlobalEvent
    }>()

    let queue: GlobalEvent[] = []
    let timer: Timer | undefined
    let last = 0
    const retryDelay = 1000
    const maxRetryDelay = 30000
    const heartbeatTimeout = props.heartbeatTimeout ?? 15000

    const flush = () => {
      if (queue.length === 0) return
      const events = queue
      queue = []
      timer = undefined
      last = Date.now()
      // Batch all event emissions so all store updates result in a single render
      batch(() => {
        for (const event of events) {
          emitter.emit("event", event)
        }
      })
    }

    const handleEvent = (event: GlobalEvent) => {
      queue.push(event)
      const elapsed = Date.now() - last

      if (timer) return
      // If we just flushed recently (within 16ms), batch this with future events
      // Otherwise, process immediately to avoid latency
      if (elapsed < 16) {
        timer = setTimeout(flush, 16)
        return
      }
      flush()
    }

    async function reconnectDaemon() {
      if (!props.reconnect) return
      const next = await props.reconnect()
      if (next === url) return
      // All normal SDK calls read through the getter below.  Rebuilding this
      // single client after daemon recovery is enough to move session reads,
      // writes, and the next SSE attempt away from the dead port.
      url = next
      sdk = createSDK()
    }

    function startSSE() {
      sse?.abort()
      const ctrl = new AbortController()
      sse = ctrl
      ;(async () => {
        let attempt = 0
        while (!abort.signal.aborted && !ctrl.signal.aborted) {
          if (abort.signal.aborted || ctrl.signal.aborted) break
          const run = new AbortController()
          const stop = () => run.abort()
          abort.signal.addEventListener("abort", stop, { once: true })
          ctrl.signal.addEventListener("abort", stop, { once: true })
          let heartbeat: Timer | undefined
          const resetHeartbeat = () => {
            if (heartbeat) clearTimeout(heartbeat)
            // A dead TCP/proxy stream can stay open without yielding or ending.
            // The server emits heartbeat events every 10s, so 15s without any
            // event means this attempt should be aborted and rebuilt.
            heartbeat = setTimeout(() => run.abort(), heartbeatTimeout)
          }

          try {
            const events = await sdk.global.event({
              signal: run.signal,
              sseMaxRetryAttempts: 0,
            })

            if (Flag.OPENCODE_EXPERIMENTAL_WORKSPACES) {
              // Start syncing workspaces after the event stream exists; otherwise
              // workspace writes can race ahead of the listener that observes them.
              await sdk.sync.start().catch(() => {})
            }

            resetHeartbeat()
            for await (const event of events.stream) {
              if (run.signal.aborted) break
              resetHeartbeat()
              attempt = 0
              handleEvent(event)
            }
          } catch (error) {
            // Network errors are expected while a shared daemon is being killed
            // and replaced.  Non-connection errors are also swallowed here to
            // match the previous fire-and-forget SSE behavior; regular SDK calls
            // still surface real API errors at their call sites.
            if (!run.signal.aborted && !ConnectionError.isConnectionError(error)) {
              // Intentionally no log spam: this loop can run while the user is
              // deliberately stopping/restarting the daemon from another TUI.
            }
          } finally {
            abort.signal.removeEventListener("abort", stop)
            ctrl.signal.removeEventListener("abort", stop)
            if (heartbeat) clearTimeout(heartbeat)
            if (timer) clearTimeout(timer)
            if (queue.length > 0) flush()
          }

          if (abort.signal.aborted || ctrl.signal.aborted) break

          await reconnectDaemon().catch(() => undefined)

          // Exponential backoff
          attempt += 1
          const backoff = Math.min(retryDelay * 2 ** (attempt - 1), maxRetryDelay)
          await new Promise((resolve) => setTimeout(resolve, backoff))
        }
      })().catch(() => {})
    }

    onMount(async () => {
      if (props.events) {
        const unsub = await props.events.subscribe(handleEvent)
        onCleanup(unsub)

        if (Flag.OPENCODE_EXPERIMENTAL_WORKSPACES) {
          // Start syncing workspaces, it's important to do this after
          // we've started listening to events
          await sdk.sync.start().catch(() => {})
        }
      } else {
        startSSE()
      }
    })

    onCleanup(() => {
      abort.abort()
      sse?.abort()
      if (timer) clearTimeout(timer)
    })

    return {
      get client() {
        return sdk
      },
      directory: props.directory,
      event: emitter,
      fetch: props.fetch ?? fetch,
      get url() {
        return url
      },
    }
  },
})
