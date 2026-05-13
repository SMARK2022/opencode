import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import type { GlobalEvent } from "@opencode-ai/sdk/v2"
import { Flag } from "@opencode-ai/core/flag/flag"
import { createSimpleContext } from "./helper"
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
    // #139：守护进程死后重解析 URL 并重建 client
    reconnect?: () => Promise<string>
    // #139：无事件心跳超时，默认 15s（服务端 ~10s 心跳）
    heartbeatTimeout?: number
  }) => {
    const abort = new AbortController()
    let sse: AbortController | undefined
    // #139：可变 base URL，重连后指向新端口
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

    const handlers = new Set<(event: GlobalEvent) => void>()
    const emitter = {
      emit(_type: "event", event: GlobalEvent) {
        for (const handler of handlers) handler(event)
      },
      on(_type: "event", handler: (event: GlobalEvent) => void) {
        handlers.add(handler)
        return () => {
          handlers.delete(handler)
        }
      },
    }

    let queue: GlobalEvent[] = []
    let timer: Timer | undefined
    let last = 0
    const retryDelay = 1000
    const maxRetryDelay = 30000
    // #139：默认 15s，与 source 服务端 10s 心跳匹配
    const heartbeatTimeout = props.heartbeatTimeout ?? 15000

    const flush = () => {
      if (queue.length === 0) return
      const events = queue
      queue = []
      timer = undefined
      last = Date.now()
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
      if (elapsed < 16) {
        timer = setTimeout(flush, 16)
        return
      }
      flush()
    }

    // #139：daemon 恢复后 rebind URL + 重建 SDK client
    async function reconnectDaemon() {
      if (!props.reconnect) return
      const next = await props.reconnect()
      if (next === url) return
      // #139：会话读写与下一次 SSE 都离开死端口
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
            // #139：无心跳/事件超时则中止当前 SSE 并重建
            heartbeat = setTimeout(() => run.abort(), heartbeatTimeout)
          }

          try {
            const events = await sdk.global.event({
              signal: run.signal,
              sseMaxRetryAttempts: 0,
            })

            if (Flag.OPENCODE_EXPERIMENTAL_WORKSPACES) {
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
            // #139：连接错误静默；API 调用点仍暴露真实错误
            if (!run.signal.aborted && !ConnectionError.isConnectionError(error)) {
              // intentional quiet for recovery loops
            }
          } finally {
            abort.signal.removeEventListener("abort", stop)
            ctrl.signal.removeEventListener("abort", stop)
            if (heartbeat) clearTimeout(heartbeat)
            if (timer) clearTimeout(timer)
            if (queue.length > 0) flush()
          }

          if (abort.signal.aborted || ctrl.signal.aborted) break

          // #139：流结束后先 rebind daemon URL
          await reconnectDaemon().catch(() => undefined)

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
      handlers.clear()
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
      // 读取拥有者共享退出信号，消费者只处理自身生命周期产生的取消。
      signal: abort.signal,
    }
  },
})
