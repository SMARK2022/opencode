// #165：重连测试只注入 testTransport.fetch，事件仍走生产 SSE
/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
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
