import { afterEach, describe, expect, test } from "bun:test"
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
})
