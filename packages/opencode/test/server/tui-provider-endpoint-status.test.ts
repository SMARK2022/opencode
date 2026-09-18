import { describe, expect, spyOn } from "bun:test"
import { Context, Effect, Fiber, Layer, Stream } from "effect"
import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import fs from "node:fs/promises"
import os from "node:os"
import nodePath from "node:path"
import { Global } from "@opencode-ai/core/global"
import { NetworkProxy } from "@opencode-ai/core/network-proxy"
import { SessionActivity } from "@/session/activity"
import { Project } from "@/project/project"
import Http, { type IncomingMessage, type ServerResponse } from "node:http"
import * as Log from "@opencode-ai/core/util/log"
import { Session } from "@/session/session"
import { Server } from "../../src/server/server"
import { TestInstance, tmpdirScoped } from "../fixture/fixture"
import { awaitWithTimeout, pollWithTimeout, testEffect } from "../lib/effect"

void Log.init({ print: false })

const it = testEffect(Session.defaultLayer)
// 这是 TUI sidebar 读取 daemon 统一网络状态的公开 HTTP 入口。测试使用字面
// path 覆盖真实 wire contract，避免只验证内部导出的常量名称。
const path = "/tui/provider-endpoint-status"

// 使用生产监听器和完整路由树，真实socket close才能覆盖传输owner到Effect finalizer。
// 上游fixture仍独立管理；客户端只替换外部地址，不复制生产HTTP取消行为。
const voice = testEffect(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer, Project.defaultLayer))
// 最小 PCM WAV 包含合法 RIFF/fmt/data 头和非文本样本，避免只证明字符串上传可用。
const wav = Buffer.from("524946462800000057415645666d74201000000001000100401f0000803e00000200100064617461040000000000ff7f", "hex")

// 每个scope用生产监听器取得当前认证配置，隔离其他测试曾初始化的全局web handler。
function listen() {
  return Effect.acquireRelease(
    Effect.promise(() => Server.listen({ hostname: "127.0.0.1", port: 0 })),
    (listener) => Effect.promise(() => listener.stop(true)),
  )
}

function voiceFixture(mode: "normal" | "headers" | "body" = "normal", refresh = false) {
  return Effect.gen(function* () {
    const dir = yield* tmpdirScoped({ git: true })
    yield* Project.use.fromDirectory(dir)
    // listener与测试scope同寿命；通过公开stop释放连接，保持生产shutdown路径的覆盖。
    const server = yield* listen()
    const baseline = SessionActivity.count()
    const config = nodePath.join(Global.Path.config, "opencode.json")
    const script = nodePath.join(dir, "chatgpt.js")
    const original = yield* Effect.promise(async () => await Bun.file(config).exists() ? Bun.file(config).bytes() : undefined)
    // 只写 preload 隔离目录，先登记还原再写入，失败路径也不能遗留用户配置快照。
    yield* Effect.addFinalizer(() => Effect.promise(async () => {
      if (original) await Bun.write(config, original)
      else await fs.rm(config, { force: true })
    }))
    // CLI fixture 只提供外部导出协议；命令选择、进程启动和持久化仍走生产实现。
    yield* Effect.promise(() => Bun.write(script, `console.log(JSON.stringify({cookies:[{name:'session',value:'fresh',expires:-1}],fetchedAt:'2026-09-18T00:00:00Z'}))`))
    yield* Effect.promise(() => Bun.write(config, JSON.stringify({ mcp: { chatgpt: {
      type: "local", command: [process.execPath, nodePath.join(dir, "mcp-server.js")],
      auth: { cookies: { session: { value: refresh ? "stale" : "fresh", expires: 0 } }, fetched_at: "old" },
    } } })))
    // entered 由上游收完上传后发布，不以定时 sleep 猜测 handler 是否已经拿到锁。
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const aborted = Promise.withResolvers<void>()
    const settled = Promise.withResolvers<void>()
    const finish = Promise.withResolvers<void>()
    const headers = Promise.withResolvers<void>()
    const calls: { cookie: string | null; file: string; bytes: Uint8Array; signal: AbortSignal | null | undefined }[] = []
    // 第二个服务器仍由 Effect scope 管理；这里只模拟外部 ChatGPT，不替换后端事务。
    const context = yield* Layer.build(NodeHttpServer.layer(Http.createServer, { host: "127.0.0.1", port: 0 }))
    const upstream = Context.get(context, HttpServer.HttpServer)
    yield* upstream.serve(Effect.gen(function* () {
      const req = yield* HttpServerRequest.HttpServerRequest
      // 消费真实 multipart 请求后才响应，避免仅验证客户端构造而没有实际上传。
      expect(Buffer.from(yield* req.arrayBuffer).includes(wav)).toBe(true)
      if (req.headers.cookie === "session=stale") return HttpServerResponse.empty({ status: 401 })
      entered.resolve()
      // 在响应头前和正文读取中分别悬停，以覆盖两个不同的 fetch 取消阶段。
      if (mode === "body") return HttpServerResponse.stream(Stream.concat(
        Stream.make(new TextEncoder().encode('{"text":')),
        Stream.fromEffect(Effect.promise(() => release.promise).pipe(Effect.as(new TextEncoder().encode('"hello WAV"}')))),
      ), { contentType: "application/json" })
      yield* Effect.promise(() => release.promise)
      return HttpServerResponse.jsonUnsafe({ text: "hello WAV" })
    }))
    // 重定向保留原始 FormData 和 signal；检查源 URL 防止错误的 session 刷新被伪装成功。
    const redirect = spyOn(NetworkProxy, "fetch").mockImplementation(async (input, init) => {
      expect(String(input)).toBe("https://chatgpt.com/backend-api/transcribe")
      const upload = init?.body instanceof FormData ? init.body.get("file") : undefined
      if (!(upload instanceof File)) throw new Error("expected production multipart WAV")
      const file = nodePath.join(os.tmpdir(), "opencode", "voice", upload.name)
      // multipart 文件名来自生产临时路径；读取实际落盘文件可同时发现上传前写入的退化。
      expect(new Uint8Array(await Bun.file(file).arrayBuffer())).toEqual(new Uint8Array(await upload.arrayBuffer()))
      calls.push({ cookie: new Headers(init?.headers).get("cookie"), file, bytes: new Uint8Array(await upload.arrayBuffer()), signal: init?.signal })
      init?.signal?.addEventListener("abort", () => aborted.resolve(), { once: true })
      try {
        const response = await fetch(HttpServer.formatAddress(upstream.address), init)
        headers.resolve()
        return response
      } finally {
        // 把取消后的网络收尾保持为同一个被生产代码 await 的 Promise，不能另造后台操作。
        if (init?.signal?.aborted && mode === "headers") await finish.promise
        settled.resolve()
      }
    })
    // 红测试也必须先让真实 operation 退出，再还原网络入口和配置，避免污染后续 provider 用例。
    yield* Effect.addFinalizer(() => Effect.gen(function* () {
      release.resolve()
      finish.resolve()
      yield* pollWithTimeout(Effect.sync(() => SessionActivity.count() === baseline ? true : undefined), "fixture operations did not settle")
    }).pipe(Effect.orDie, Effect.ensuring(Effect.sync(() => redirect.mockRestore()))))
    const send = (bytes: Uint8Array = wav) => HttpClientRequest.post(new URL("/tui/voice/transcribe", server.url).toString()).pipe(
      // 正常客户端使用生产监听地址，保留完整HTTP与directory头合同。
      HttpClientRequest.setHeader("x-opencode-directory", dir),
      HttpClientRequest.bodyUint8Array(bytes, "audio/wav"),
      HttpClient.execute,
      Effect.flatMap((response) => response.json.pipe(Effect.map((body) => ({ status: response.status, body })))),
    )
    // 取消探针显式销毁 socket 并等待 close，排除“只取消客户端 fiber、连接仍存活”的歧义。
    const disconnectable = Effect.acquireRelease(Effect.sync(() => {
      const closed = Promise.withResolvers<void>()
      const request = Http.request(new URL("/tui/voice/transcribe", server.url), {
        method: "POST", headers: { "content-type": "audio/wav", "x-opencode-directory": dir },
      })
      // destroy 导致的 ECONNRESET 是预期传输结果；业务结果仍由正常 HttpClient 用例检查。
      request.on("error", () => {})
      request.once("close", () => closed.resolve())
      request.end(wav)
      return { close: () => { request.destroy(); return closed.promise } }
    }), (request) => Effect.promise(() => request.close()))
    return { config, calls, entered, release, aborted, settled, finish, headers, send, disconnectable }
  })
}

describe("voice HTTP lifecycle", () => {
  // 文本、二进制和准入目录一起断言，避免成功响应掩盖音频被截断或临时路径不合法。
  voice.live("uploads binary WAV through production HTTP and removes the accepted temporary path", () => Effect.gen(function* () {
    const fixture = yield* voiceFixture()
    fixture.release.resolve()
    // 不假设其他测试的 activity 必为零，只验证本次请求没有留下额外活动。
    const baseline = SessionActivity.count()
    expect(yield* fixture.send()).toEqual({ status: 200, body: { text: "hello WAV" } })
    expect(fixture.calls).toHaveLength(1)
    expect(fixture.calls[0].bytes).toEqual(new Uint8Array(wav))
    expect(nodePath.dirname(fixture.calls[0].file)).toBe(nodePath.join(os.tmpdir(), "opencode", "voice"))
    expect(yield* Effect.promise(() => Bun.file(fixture.calls[0].file).exists())).toBe(false)
    expect(SessionActivity.count()).toBe(baseline)
  }))

  // 首个请求先真实运行 profile CLI，第二个必须在锁内重新读到已提交快照。
  voice.live("serializes two HTTP clients and reuses the committed Cookie snapshot", () => Effect.gen(function* () {
    const fixture = yield* voiceFixture("normal", true)
    const baseline = SessionActivity.count()
    const first = yield* fixture.send().pipe(Effect.forkScoped)
    yield* awaitWithTimeout(Effect.promise(() => fixture.entered.promise), "first client never reached upstream", "5 seconds")
    const second = yield* fixture.send().pipe(Effect.forkScoped)
    // activity 在等锁之前建立；双 activity 证明第二个 HTTP 已进入生产 handler。
    yield* pollWithTimeout(Effect.sync(() => SessionActivity.count() === baseline + 2 ? true : undefined), "second HTTP never entered")
    expect(fixture.calls.map((call) => call.cookie)).toEqual(["session=stale", "session=fresh"])
    fixture.release.resolve()
    expect(yield* Fiber.join(first)).toEqual({ status: 200, body: { text: "hello WAV" } })
    // 等待第二个真实 HTTP 响应，防止只看持久化文件就误判串行调用完成。
    expect(yield* Fiber.join(second)).toEqual({ status: 200, body: { text: "hello WAV" } })
    // 若在取锁前缓存 auth，第二个会再次发送 stale 并执行 profile，序列会多两项。
    expect(fixture.calls.map((call) => call.cookie)).toEqual(["session=stale", "session=fresh", "session=fresh"])
    expect(yield* Effect.promise(() => Bun.file(fixture.config).json())).toMatchObject({ mcp: { chatgpt: {
      auth: { cookies: { session: { value: "fresh", expires: 0 } }, fetched_at: "2026-09-18T00:00:00Z" },
    } } })
    expect(SessionActivity.count()).toBe(baseline)
  }))

  // 取消等待者必须只撤销它自己的租约等待，不能把持锁客户端的操作一并中止。
  voice.live("cancels a waiting HTTP client without aborting the lock holder", () => Effect.gen(function* () {
    const fixture = yield* voiceFixture()
    const baseline = SessionActivity.count()
    const holder = yield* fixture.send().pipe(Effect.forkScoped)
    yield* awaitWithTimeout(Effect.promise(() => fixture.entered.promise), "holder never reached upstream", "5 seconds")
    const waiting = yield* fixture.disconnectable
    // activity 数量是 handler 发布的就绪信号，不依赖 Flock 私有队列结构。
    yield* pollWithTimeout(Effect.sync(() => SessionActivity.count() === baseline + 2 ? true : undefined), "waiting HTTP never entered")
    yield* Effect.promise(() => waiting.close())
    yield* pollWithTimeout(Effect.sync(() => SessionActivity.count() === baseline + 1 ? true : undefined), "waiting HTTP was not cleaned up")
    // 保持上游未响应，确保 holder 的存活不是已经成功结束造成的假象。
    expect(fixture.calls).toHaveLength(1)
    expect(fixture.calls[0].signal?.aborted).toBe(false)
    expect(yield* Effect.promise(() => Bun.file(fixture.calls[0].file).exists())).toBe(true)
    fixture.release.resolve()
    expect(yield* Fiber.join(holder)).toEqual({ status: 200, body: { text: "hello WAV" } })
    expect(yield* fixture.send()).toEqual({ status: 200, body: { text: "hello WAV" } })
    expect(SessionActivity.count()).toBe(baseline)
  }))

  // 收尾门在原 fetch Promise 的 finally 内，精确区分 abort 通知和操作真正完成。
  voice.live("waits for cancelled HTTP work before deleting WAV and releasing activity and config lock", () => Effect.gen(function* () {
    const fixture = yield* voiceFixture("headers")
    const baseline = SessionActivity.count()
    const active = yield* fixture.disconnectable
    yield* awaitWithTimeout(Effect.promise(() => fixture.entered.promise), "active client never reached upstream", "5 seconds")
    yield* Effect.promise(() => active.close())
    yield* awaitWithTimeout(Effect.promise(() => fixture.aborted.promise), "closed HTTP socket did not abort the underlying fetch", "5 seconds")
    // abort 已发生而完成门未开，正是 WAV 和 activity 最容易被提前释放的窗口。
    expect(SessionActivity.count()).toBe(baseline + 1)
    expect(yield* Effect.promise(() => Bun.file(fixture.calls[0].file).exists())).toBe(true)
    const next = yield* fixture.send().pipe(Effect.forkScoped)
    yield* pollWithTimeout(Effect.sync(() => SessionActivity.count() === baseline + 2 ? true : undefined), "next HTTP never entered")
    // 后续请求已经到达，却还不能触碰上游，证明配置锁仍属于被取消的原操作。
    expect(fixture.calls).toHaveLength(1)
    fixture.finish.resolve()
    // 只打开原操作完成门；配置锁必须由生产 finally 释放，测试不能代为解锁。
    yield* Effect.promise(() => fixture.settled.promise)
    yield* pollWithTimeout(Effect.sync(() => fixture.calls.length === 2 ? true : undefined), "config lock never released")
    // 解锁与 handler 删除 WAV 相邻但并非原子事件，等待文件完成信号而非竞争调度顺序。
    yield* pollWithTimeout(Effect.promise(async () => await Bun.file(fixture.calls[0].file).exists() ? undefined : true), "cancelled WAV was not deleted")
    fixture.release.resolve()
    expect(yield* Fiber.join(next)).toEqual({ status: 200, body: { text: "hello WAV" } })
    expect(SessionActivity.count()).toBe(baseline)
  }))

  // 上游已发响应头但 JSON 未完成时，客户端断开仍需传到正在读取正文的 signal。
  voice.live("aborts HTTP during response body work and accepts the next request", () => Effect.gen(function* () {
    const fixture = yield* voiceFixture("body")
    const baseline = SessionActivity.count()
    const active = yield* fixture.disconnectable
    yield* awaitWithTimeout(Effect.promise(() => fixture.headers.promise), "upstream response headers never arrived", "5 seconds")
    expect(SessionActivity.count()).toBe(baseline + 1)
    yield* Effect.promise(() => active.close())
    yield* awaitWithTimeout(Effect.promise(() => fixture.aborted.promise), "closed HTTP socket did not abort response body work", "5 seconds")
    yield* pollWithTimeout(Effect.sync(() => SessionActivity.count() === baseline ? true : undefined), "body cancellation never settled")
    // 取消不能推进浏览器恢复或交付迟到文本；新请求才允许再次使用网络。
    expect(fixture.calls).toHaveLength(1)
    expect(yield* Effect.promise(() => Bun.file(fixture.calls[0].file).exists())).toBe(false)
    fixture.release.resolve()
    expect(yield* fixture.send()).toEqual({ status: 200, body: { text: "hello WAV" } })
    expect(SessionActivity.count()).toBe(baseline)
  }))

  // 超额上传必须在解码阶段拒绝，不能先创建 activity、临时 WAV 或发起转录。
  voice.live("rejects uploads above the existing 50 MiB limit before transcription", () => Effect.gen(function* () {
    const fixture = yield* voiceFixture()
    fixture.release.resolve()
    const baseline = SessionActivity.count()
    // 只超出一字节，避免把任意巨大载荷失败误当成既有边界值的精确保护。
    const response = yield* fixture.send(new Uint8Array(50 * 1024 * 1024 + 1))
    expect(response.status).toBe(400)
    expect(fixture.calls).toHaveLength(0)
    expect(SessionActivity.count()).toBe(baseline)
  }))
})

// 语音端点由 daemon 解析配置；空测试环境应返回明确配置错误，区别于路由缺席的404。
it.instance("accepts WAV uploads on the daemon voice endpoint", () =>
  Effect.gen(function* () {
    const tmp = yield* TestInstance
    const server = yield* listen()
    const response = yield* Effect.promise(() => fetch(new URL("/tui/voice/transcribe", server.url), {
      method: "POST", headers: { "content-type": "audio/wav", "x-opencode-directory": tmp.directory },
      body: new Uint8Array([82, 73, 70, 70]),
    }))
    expect(response.status).toBe(502)
    expect(yield* Effect.promise(() => response.json())).toMatchObject({ message: "Voice input requires a user-configured ChatGPT MCP" })
  }),
)

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
  return Effect.gen(function* () {
    const server = yield* listen()
    return yield* Effect.promise(async () => {
      const response = await fetch(new URL(`${path}?url=${encodeURIComponent(endpoint)}`, server.url), {
        headers: { "x-opencode-directory": dir },
      })
      return {
        status: response.status,
        body: await response.json().catch(() => undefined),
      }
    })
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
      // 保持端口归 fixture 所有，以连接中断制造失败，避免释放后被其他监听者复用。
      const provider = yield* probeServer((_req, res) => res.destroy())

      // origin 可能复用上一用例的短期缓存；必须观察到真实探测才判断网络失败结果。
      // 等待行为信号，不固定 sleep，也不清空生产缓存来绕过真实刷新语义。
      const response = yield* pollWithTimeout(
        request(tmp.directory, provider.origin).pipe(
          Effect.map((response) => provider.hits() > 0 ? response : undefined),
        ),
        "down endpoint was never probed",
      )

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
