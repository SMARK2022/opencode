import { describe, expect } from "bun:test"
import { Effect } from "effect"
import Http, { type IncomingMessage, type ServerResponse } from "node:http"
import * as Log from "@opencode-ai/core/util/log"
import { Session } from "@/session/session"
import { Server } from "../../src/server/server"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

void Log.init({ print: false })

const it = testEffect(Session.defaultLayer)
// 这是 TUI sidebar 读取 daemon 统一网络状态的公开 HTTP 入口。测试使用字面
// path 覆盖真实 wire contract，避免只验证内部导出的常量名称。
const path = "/tui/provider-endpoint-status"

type ProbeServer = {
  origin: string
  hits: () => number
}

function probeServer(handler?: (req: IncomingMessage, res: ServerResponse) => void) {
  return Effect.acquireRelease(
    Effect.promise(
      () =>
        new Promise<ProbeServer & { close: () => Promise<void> }>((resolve) => {
          let hits = 0
          const server = Http.createServer((req, res) => {
            // fake provider 只统计真实出站 HEAD probe。测试从 TUI HTTP API 入口
            // 进入，如果 daemon cache/并发去重失效，这里的 hit 数会直接暴露。
            hits += 1
            if (handler) {
              handler(req, res)
              return
            }
            res.writeHead(req.method === "HEAD" ? 204 : 405)
            res.end()
          })
          server.listen(0, "127.0.0.1", () => {
            const address = server.address()
            if (!address || typeof address === "string") throw new Error("probe server did not bind to TCP")
            resolve({
              origin: `http://127.0.0.1:${address.port}`,
              hits: () => hits,
              close: () => new Promise<void>((done) => server.close(() => done())),
            })
          })
        }),
    ),
    (server) => Effect.promise(() => server.close()),
  )
}

function request(dir: string, endpoint: string) {
  return Effect.promise(async () => {
    const response = await Server.Default().app.request(`${path}?url=${encodeURIComponent(endpoint)}`, {
      headers: { "x-opencode-directory": dir },
    })
    return {
      status: response.status,
      body: await response.json().catch(() => undefined),
    }
  })
}

describe("tui.providerEndpointStatus endpoint", () => {
  it.instance("returns daemon-owned provider route and latency for a reachable endpoint", () =>
    Effect.gen(function* () {
      const tmp = yield* TestInstance
      const provider = yield* probeServer()

      const response = yield* request(tmp.directory, provider.origin)

      expect(response.status).toBe(200)
      expect(provider.hits()).toBe(1)
      expect(response.body).toMatchObject({
        url: provider.origin,
        status: "ok",
        route: { type: "direct" },
      })
      expect(response.body.latency).toEqual(expect.any(Number))
      expect(response.body.checkedAt).toEqual(expect.any(Number))
    }),
  )

  it.instance("coalesces concurrent TUI reads for the same provider endpoint", () =>
    Effect.gen(function* () {
      const tmp = yield* TestInstance
      const provider = yield* probeServer((req, res) => {
        setTimeout(() => {
          res.writeHead(req.method === "HEAD" ? 204 : 405)
          res.end()
        }, 25)
      })

      const [first, second] = yield* Effect.all([request(tmp.directory, provider.origin), request(tmp.directory, provider.origin)], {
        concurrency: "unbounded",
      })

      expect(first.status).toBe(200)
      expect(second.status).toBe(200)
      expect(provider.hits()).toBe(1)
      expect(first.body).toMatchObject(second.body)
    }),
  )

  it.instance("reports a down endpoint without failing the TUI request", () =>
    Effect.gen(function* () {
      const tmp = yield* TestInstance
      const provider = yield* probeServer()
      yield* Effect.promise(() => provider.close())

      const response = yield* request(tmp.directory, provider.origin)

      expect(response.status).toBe(200)
      expect(response.body).toMatchObject({
        url: provider.origin,
        status: "down",
        latency: null,
        route: { type: "direct" },
      })
      expect(response.body.checkedAt).toEqual(expect.any(Number))
    }),
  )

  it.instance("rejects malformed endpoint URLs before probing", () =>
    Effect.gen(function* () {
      const tmp = yield* TestInstance
      const response = yield* request(tmp.directory, "not a provider URL")

      expect(response.status).toBe(400)
    }),
  )
})
