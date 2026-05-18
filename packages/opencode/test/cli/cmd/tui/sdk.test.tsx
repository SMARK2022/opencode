/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { onMount } from "solid-js"
import { SDKProvider, useSDK } from "../../../../src/cli/cmd/tui/context/sdk"

async function wait(fn: () => boolean, timeout = 2000) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error("timed out waiting for condition")
    await Bun.sleep(10)
  }
}

function sse(data: unknown) {
  return new Response(`data: ${JSON.stringify(data)}\n\n`, {
    headers: { "content-type": "text/event-stream" },
  })
}

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

describe("SDKProvider", () => {
  test("rebinds client URL after daemon reconnect", async () => {
    const requests: string[] = []
    let ready!: (sdk: ReturnType<typeof useSDK>) => void
    const mounted = new Promise<ReturnType<typeof useSDK>>((resolve) => {
      ready = resolve
    })
    const fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      requests.push(url.origin + url.pathname)
      if (url.origin === "http://old") throw new Error("fetch failed")
      if (url.origin === "http://new" && url.pathname === "/global/event") {
        return sse({ directory: "global", payload: { id: "evt_connected", type: "server.connected", properties: {} } })
      }
      return new Response("{}", { headers: { "content-type": "application/json" } })
    }) as typeof globalThis.fetch

    const app = await testRender(() => (
      <SDKProvider url="http://old" testTransport={{ fetch }} reconnect={async () => "http://new"}>
        <Probe onReady={ready} />
      </SDKProvider>
    ))

    try {
      const sdk = await mounted
      await wait(() => sdk.url === "http://new" && requests.includes("http://new/global/event"))
      expect(requests).toContain("http://old/global/event")
      expect(requests).toContain("http://new/global/event")
    } finally {
      app.renderer.destroy()
    }
  })

  test("reconnects when an SSE stream stalls without heartbeat", async () => {
    const requests: string[] = []
    let cancelled = false
    let ready!: (sdk: ReturnType<typeof useSDK>) => void
    const mounted = new Promise<ReturnType<typeof useSDK>>((resolve) => {
      ready = resolve
    })
    const connected = { directory: "global", payload: { id: "evt_connected", type: "server.connected", properties: {} } }
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
      <SDKProvider url="http://old" testTransport={{ fetch }} reconnect={async () => "http://new"} heartbeatTimeout={50}>
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
