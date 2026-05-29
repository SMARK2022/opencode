// #165：重连测试只注入 testTransport.fetch，事件仍走生产 SSE
/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import { onMount } from "solid-js"
import { SDKProvider, useSDK } from "../../src/context/sdk"

// #139：等待生产 SSE rebind 完成
async function wait(fn: () => boolean, timeout = 4000) {
  // #296：单调时钟防墙钟跳变（NTP 回拨会使 Date 差值为负、等待永不超时）
  const start = performance.now()
  while (!fn()) {
    if (performance.now() - start > timeout) throw new Error("timed out waiting for condition")
    await Bun.sleep(10)
  }
}

function sse(data: unknown) {
  return new Response(`data: ${JSON.stringify(data)}\n\n`, {
    headers: { "content-type": "text/event-stream" },
  })
}

// #139：首包后挂起，依赖 heartbeatTimeout 中止并触发 cancel
function stalledSse(data: unknown, onCancel: () => void) {
  const encoder = new TextEncoder()
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`))
      },
      cancel() {
        onCancel()
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  )
}

function Probe(props: { onReady: (sdk: ReturnType<typeof useSDK>) => void }) {
  const sdk = useSDK()
  onMount(() => props.onReady(sdk))
  return <box />
}

describe("SDKProvider reconnect", () => {
  test("owns native SSE cancellation when the provider is destroyed", async () => {
    // 原生 fetch 在 abort 时使响应流报错；静态 Response 替身覆盖不到 cancel() 的拒绝。
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(
                'data: {"directory":"global","payload":{"type":"server.connected","properties":{}}}\n\n',
              ))
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        )
      },
    })
    let sdk: ReturnType<typeof useSDK> | undefined
    let connected = false
    const app = await testRender(() => (
      <SDKProvider url={server.url.href}>
        <Probe onReady={(value) => {
          sdk = value
          value.event.on("event", () => { connected = true })
        }} />
      </SDKProvider>
    ), { useThread: false })
    try {
      await wait(() => connected)
      app.renderer.destroy()
      expect(sdk!.signal.aborted).toBe(true)
      // 让 cancel() 真正结算，未处理拒绝由测试运行器直接判失败。
      await Bun.sleep(20)
    } finally {
      app.renderer.destroy()
      await server.stop(true)
    }
  })

  test("reports unexpected asynchronous SSE cancellation failures", async () => {
    const abort = new AbortController()
    const failure = new Error("stream cancellation failed")
    const errors: unknown[] = []
    let fail!: () => void
    const client = createOpencodeClient({
      baseUrl: "http://test",
      fetch: (async (_input: RequestInfo | URL) => new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: {}\n\n'))
          fail = () => controller.error(failure)
        },
      }))) as typeof fetch,
    })
    const events = await client.global.event({
      signal: abort.signal,
      sseMaxRetryAttempts: 0,
      onSseError: (error) => { errors.push(error) },
    })
    try {
      expect((await events.stream.next()).done).toBe(false)
      // 暂停在 yield 时先让真实响应体失败，随后 cancel() 必须保留这个非取消错误。
      fail()
      await Bun.sleep(0)
      abort.abort()
      await wait(() => errors.length > 0)
      // 只忽略当前 signal 的取消原因，其他清理失败仍进入 SDK 原有错误通道。
      expect(errors).toEqual([failure])
    } finally {
      abort.abort()
      await events.stream.return()
    }
  })

  // #139：死端口失败后 rebind 到新 URL 并重建 client/SSE
  test("rebinds client URL after daemon reconnect", async () => {
    // #139：记录生产 client 实际请求的 origin+path
    const requests: string[] = []
    let ready!: (sdk: ReturnType<typeof useSDK>) => void
    const mounted = new Promise<ReturnType<typeof useSDK>>((resolve) => {
      ready = resolve
    })
    const fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      requests.push(url.origin + url.pathname)
      // #139：旧守护进程端口失败，触发 reconnectDaemon
      if (url.origin === "http://old") throw new Error("fetch failed")
      if (url.origin === "http://new" && url.pathname === "/global/event") {
        return sse({ directory: "global", payload: { id: "evt_connected", type: "server.connected", properties: {} } })
      }
      return new Response("{}", { headers: { "content-type": "application/json" } })
    }) as typeof globalThis.fetch

    // #139：挂载真实 SDKProvider，而非本地伪实现
    const app = await testRender(() => (
      <SDKProvider url="http://old" testTransport={{ fetch: fetch }} reconnect={async () => "http://new"}>
        <Probe onReady={ready} />
      </SDKProvider>
    ))

    try {
      const sdk = await mounted
      // #139：断言生产 sdk.url getter 与新 SSE 请求
      await wait(() => sdk.url === "http://new" && requests.includes("http://new/global/event"))
      expect(requests).toContain("http://old/global/event")
      expect(requests).toContain("http://new/global/event")
    } finally {
      app.renderer.destroy()
    }
  })

  // #139：无心跳挂起流在 heartbeatTimeout 后中止并 rebind
  test("reconnects when an SSE stream stalls without heartbeat", async () => {
    const requests: string[] = []
    // #139：stalled stream cancel 证明 heartbeat 中止了旧 attempt
    let cancelled = false
    let ready!: (sdk: ReturnType<typeof useSDK>) => void
    const mounted = new Promise<ReturnType<typeof useSDK>>((resolve) => {
      ready = resolve
    })
    const connected = {
      directory: "global",
      payload: { id: "evt_connected", type: "server.connected", properties: {} },
    }
    const fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      requests.push(url.origin + url.pathname)
      if (url.origin === "http://old" && url.pathname === "/global/event") {
        return stalledSse(connected, () => {
          cancelled = true
        })
      }
      if (url.origin === "http://new" && url.pathname === "/global/event") return sse(connected)
      return new Response("{}", { headers: { "content-type": "application/json" } })
    }) as typeof globalThis.fetch

    const app = await testRender(() => (
      <SDKProvider
        url="http://old"
        testTransport={{ fetch: fetch }}
        reconnect={async () => "http://new"}
        heartbeatTimeout={50}
      >
        <Probe onReady={ready} />
      </SDKProvider>
    ))

    try {
      const sdk = await mounted
      await wait(() => cancelled && sdk.url === "http://new" && requests.includes("http://new/global/event"))
      expect(requests).toContain("http://old/global/event")
      expect(requests).toContain("http://new/global/event")
    } finally {
      app.renderer.destroy()
    }
  })
})
