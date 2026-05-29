import { afterEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import Http, { type IncomingMessage, type ServerResponse } from "node:http"
import { Server } from "../../src/server/server"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

// #258：这是 TUI sidebar 读取 daemon 统一网络状态的公开 HTTP 入口。测试使用字面
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
            // #258：fake provider 只统计真实出站 HEAD probe。测试从 TUI HTTP API 入口
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
      // #258：x-opencode-directory 让 daemon 在多实例中路由到正确 workspace 的 endpoint cache
    })
    return {
      status: response.status,
      body: await response.json().catch(() => undefined),
    }
  })
}

describe("tui.providerEndpointStatus endpoint", () => {
  test("returns daemon-owned provider route and latency for a reachable endpoint", async () => {
    await using tmp = await tmpdir()
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const provider = yield* probeServer()
          const response = yield* request(tmp.path, provider.origin)
          expect(response.status).toBe(200)
          // #258：单次请求只允许一次真实出站 HEAD——首次探测完成前 handler 会等待，
          // 后续请求直接命中 daemon 缓存
          expect(provider.hits()).toBe(1)
          expect(response.body).toMatchObject({
            url: provider.origin,
            status: "ok",
            route: { type: "direct" },
          })
          expect(response.body.latency).toEqual(expect.any(Number))
          expect(response.body.checkedAt).toEqual(expect.any(Number))
        }),
      ),
    )
  })

  test("coalesces concurrent TUI reads for the same provider endpoint", async () => {
    await using tmp = await tmpdir()
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const provider = yield* probeServer((req, res) => {
            setTimeout(() => {
              res.writeHead(req.method === "HEAD" ? 204 : 405)
              res.end()
            }, 25)
          })
          const [first, second] = yield* Effect.all(
            [request(tmp.path, provider.origin), request(tmp.path, provider.origin)],
            { concurrency: "unbounded" },
          )
          expect(first.status).toBe(200)
          expect(second.status).toBe(200)
          // #258：并发去重核心断言——25ms 探测窗口内两个请求必须共享同一次 HEAD
          expect(provider.hits()).toBe(1)
          expect(first.body).toMatchObject(second.body)
        }),
      ),
    )
  })

  test("reports a down endpoint without failing the TUI request", async () => {
    await using tmp = await tmpdir()
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const provider = yield* probeServer()
          yield* Effect.promise(() => provider.close())
          const response = yield* request(tmp.path, provider.origin)
          // #258：endpoint 不可达时 HTTP 仍返回 200 + down——sidebar 辅助信息
          // 不允许把 TUI 请求本身拖成失败
          expect(response.status).toBe(200)
          expect(response.body).toMatchObject({
            url: provider.origin,
            status: "down",
            latency: null,
            route: { type: "direct" },
          })
          expect(response.body.checkedAt).toEqual(expect.any(Number))
        }),
      ),
    )
  })

  test("rejects malformed endpoint URLs before probing", async () => {
    await using tmp = await tmpdir()
    const response = await Server.Default().app.request(`${path}?url=${encodeURIComponent("not a provider URL")}`, {
      headers: { "x-opencode-directory": tmp.path },
    })
    // #258：非法 URL 在探测前就被拒——daemon 不应把无意义字符串交给网络层
    expect(response.status).toBe(400)
  })
})
