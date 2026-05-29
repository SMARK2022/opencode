import { afterEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { HttpClient } from "effect/unstable/http"
import { NetworkProxy } from "../src/network-proxy"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe("NetworkProxy", () => {
  // #150：全局 fetch mock 不得劫持 routedFetch/native 主路径
  test("routedFetch still uses proxy routing when global fetch is mocked", async () => {
    let called = false
    globalThis.fetch = Object.assign(
      () => {
        called = true
        return Promise.resolve(new Response("mocked"))
      },
      { preconnect: originalFetch.preconnect },
    )

    const response = await NetworkProxy.routedFetch("http://127.0.0.1:1", { purpose: "infrastructure" }).catch(
      (error) => error,
    )

    // #150：native 捕获路径不应触发全局 mock
    expect(called).toBe(false)
    expect(response).toBeInstanceOf(Error)
  })

  test("infrastructureHttpClientLayer keeps Effect HTTP calls off global fetch mocks", async () => {
  // #268：mock fetch 计数必须为 0——证明 Effect HTTP 走原生 fetch 桥而非全局 mock
    let called = false
  // #268：Object.assign 保留原 fetch 引用——afterEach 恢复后不影响同文件其他用例
    globalThis.fetch = Object.assign(() => {
      called = true
      return Promise.resolve(new Response("mocked"))
    }, { preconnect: originalFetch.preconnect })
    // #268：本地 Bun server 固定成功路径：缺少 HttpClient layer 会直接失败
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
