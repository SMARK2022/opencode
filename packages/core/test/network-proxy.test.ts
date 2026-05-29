import { afterEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { HttpClient } from "effect/unstable/http"
import { NetworkProxy } from "../src/network-proxy"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe("NetworkProxy", () => {
  test("routedFetch still uses proxy routing when global fetch is mocked", async () => {
    let called = false
    globalThis.fetch = Object.assign(() => {
      called = true
      return Promise.resolve(new Response("mocked"))
    }, { preconnect: originalFetch.preconnect })

    const response = await NetworkProxy.routedFetch("http://127.0.0.1:1", { purpose: "infrastructure" }).catch(
      (error) => error,
    )

    expect(called).toBe(false)
    expect(response).toBeInstanceOf(Error)
  })

  test("infrastructureHttpClientLayer keeps Effect HTTP calls off global fetch mocks", async () => {
    let called = false
    globalThis.fetch = Object.assign(() => {
      called = true
      return Promise.resolve(new Response("mocked"))
    }, { preconnect: originalFetch.preconnect })
    // 本地 Bun server 固定成功路径：缺少 HttpClient layer 会直接失败，误用 globalThis.fetch 会返回
    // "mocked"，只有走 NetworkProxy 捕获的 native fetch 才能拿到真实服务端返回的 "native"。
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response("native")
      },
    })

    try {
      const body = await Effect.runPromise(
        HttpClient.get(`${server.url}`).pipe(
          Effect.provide(NetworkProxy.infrastructureHttpClientLayer),
          Effect.flatMap((response) => response.text),
        ),
      )

      expect(body).toBe("native")
      expect(called).toBe(false)
    } finally {
      server.stop(true)
    }
  })
})
