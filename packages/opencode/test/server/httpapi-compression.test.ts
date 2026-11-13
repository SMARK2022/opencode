import { afterEach, describe, expect, test } from "bun:test"
import { gunzipSync, inflateSync } from "node:zlib"
import { randomBytes } from "node:crypto"
import { Effect, Layer } from "effect"
import { HttpBody, HttpRouter, HttpServer, HttpServerResponse } from "effect/unstable/http"
import { Server } from "../../src/server/server"
import { compressionLayer } from "../../src/server/routes/instance/httpapi/middleware/compression"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

function app() {
  return Server.Default().app
}

// /config echoes the config back. Padding the config pushes the response body
// well past the 1024 B threshold so we can observe compression behavior.
function fatConfig() {
  const instructions: string[] = []
  for (let i = 0; i < 50; i++) {
    instructions.push(`padding-instruction-${i}-${"x".repeat(40)}`)
  }
  return {
    formatter: false,
    lsp: false,
    username: "compression-test-user",
    instructions,
  }
}

describe("HttpApi compression", () => {
  describe("encodes responses", () => {
    test("gzips JSON when Accept-Encoding includes gzip and body exceeds threshold", async () => {
      await using tmp = await tmpdir({ config: fatConfig() })
      const response = await app().request("/config", {
        headers: { "x-opencode-directory": tmp.path, "accept-encoding": "gzip" },
      })
      expect(response.status).toBe(200)
      expect(response.headers.get("content-encoding")).toBe("gzip")
      const compressed = new Uint8Array(await response.arrayBuffer())
      const decompressed = gunzipSync(compressed)
      const json = JSON.parse(new TextDecoder().decode(decompressed))
      expect(json).toMatchObject({ username: "compression-test-user" })
      expect(compressed.byteLength).toBeLessThan(decompressed.byteLength)
    })

    test("lets the event loop run while compressing a high-entropy body", async () => {
      let heartbeat = false // 定时器在 contentType 读取点排入，直接观察压缩是否让出主线程。
      const { handler, dispose } = HttpRouter.toWebHandler(
        HttpRouter.use((router) => router.add("GET", "/", () => {
          const body = HttpBody.uint8Array(randomBytes(4_000_000), "application/json") // 高熵正文避免高压缩率样本掩盖同步 zlib 停顿。
          // contentType 紧邻压缩执行；此时排入定時器才能准确观察压缩是否让出主线程。
          Object.defineProperty(body, "contentType", {
            get() {
              setTimeout(() => { heartbeat = true }, 0)
              return "application/json"
            },
          })
          return Effect.succeed(HttpServerResponse.setBody(HttpServerResponse.empty(), body))
        })).pipe(Layer.provide(compressionLayer), Layer.provide(HttpServer.layerServices)),
        { disableLogger: true },
      )
      try {
        const response = await handler(new Request("http://localhost/", { headers: { "accept-encoding": "gzip" } })) // 通过真实 middleware 与 HTTP 编码路径执行压缩。
        expect(heartbeat).toBe(true) // 同步 gzip 返回前定时器为 false，异步实现应先让定时器运行。
        expect(response.headers.get("content-encoding")).toBe("gzip") // 让出事件循环不能改变既有 Content-Encoding 合同。
        expect(gunzipSync(new Uint8Array(await response.arrayBuffer()))).toHaveLength(4_000_000) // 解压字节长度验证压缩结果完整且未截断。
      } finally {
        await dispose()
      }
    }, 20_000)

    test("uses deflate when only deflate is acceptable", async () => {
      await using tmp = await tmpdir({ config: fatConfig() })
      const response = await app().request("/config", {
        headers: { "x-opencode-directory": tmp.path, "accept-encoding": "deflate" },
      })
      expect(response.status).toBe(200)
      expect(response.headers.get("content-encoding")).toBe("deflate")
      const compressed = new Uint8Array(await response.arrayBuffer())
      const decompressed = inflateSync(compressed)
      const json = JSON.parse(new TextDecoder().decode(decompressed))
      expect(json).toMatchObject({ username: "compression-test-user" })
    })

    test("prefers gzip when both gzip and deflate are acceptable", async () => {
      await using tmp = await tmpdir({ config: fatConfig() })
      const response = await app().request("/config", {
        headers: { "x-opencode-directory": tmp.path, "accept-encoding": "gzip, deflate" },
      })
      expect(response.headers.get("content-encoding")).toBe("gzip")
    })

    test("does not include the original Content-Length when compressed", async () => {
      await using tmp = await tmpdir({ config: fatConfig() })
      const response = await app().request("/config", {
        headers: { "x-opencode-directory": tmp.path, "accept-encoding": "gzip" },
      })
      const compressed = new Uint8Array(await response.arrayBuffer())
      const declared = response.headers.get("content-length")
      // Either absent (transfer-encoding chunked) or matches the compressed length.
      if (declared !== null) expect(Number(declared)).toBe(compressed.byteLength)
    })
  })

  describe("skips", () => {
    test("when no Accept-Encoding header is present", async () => {
      await using tmp = await tmpdir({ config: fatConfig() })
      const response = await app().request("/config", {
        headers: { "x-opencode-directory": tmp.path },
      })
      expect(response.headers.get("content-encoding")).toBeNull()
    })

    test("when Accept-Encoding only allows unsupported encodings", async () => {
      await using tmp = await tmpdir({ config: fatConfig() })
      const response = await app().request("/config", {
        headers: { "x-opencode-directory": tmp.path, "accept-encoding": "br" },
      })
      expect(response.headers.get("content-encoding")).toBeNull()
    })

    test("when the response body is below the 1024-byte threshold", async () => {
      // A bare config produces a tiny response (~few hundred bytes).
      await using tmp = await tmpdir({ config: { formatter: false, lsp: false } })
      const response = await app().request("/config", {
        headers: { "x-opencode-directory": tmp.path, "accept-encoding": "gzip" },
      })
      expect(response.status).toBe(200)
      const body = new Uint8Array(await response.arrayBuffer())
      expect(body.byteLength).toBeLessThan(1024)
      expect(response.headers.get("content-encoding")).toBeNull()
    })

    test("HEAD requests", async () => {
      await using tmp = await tmpdir({ config: fatConfig() })
      const response = await app().request("/config", {
        method: "HEAD",
        headers: { "x-opencode-directory": tmp.path, "accept-encoding": "gzip" },
      })
      expect(response.headers.get("content-encoding")).toBeNull()
    })
  })

  describe("streaming exclusions", () => {
    test("/event SSE is not compressed", async () => {
      await using tmp = await tmpdir({ config: { formatter: false, lsp: false } })
      const controller = new AbortController()
      const response = await app().request("/event", {
        headers: { "x-opencode-directory": tmp.path, "accept-encoding": "gzip" },
        signal: controller.signal,
      })
      try {
        expect(response.status).toBe(200)
        expect(response.headers.get("content-encoding")).toBeNull()
      } finally {
        controller.abort()
        await response.body?.cancel().catch(() => {})
      }
    })

    test("/global/event SSE is not compressed", async () => {
      const controller = new AbortController()
      const response = await app().request("/global/event", {
        headers: { "accept-encoding": "gzip" },
        signal: controller.signal,
      })
      try {
        expect(response.status).toBe(200)
        expect(response.headers.get("content-encoding")).toBeNull()
      } finally {
        controller.abort()
        await response.body?.cancel().catch(() => {})
      }
    })
  })
})
