import { afterEach, describe, expect, test } from "bun:test"
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
})
