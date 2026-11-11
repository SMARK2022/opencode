import { createHash } from "node:crypto"
import { describe, expect } from "bun:test"
import { Flag } from "@opencode-ai/core/flag/flag"
import { ConfigProvider, Effect, Exit, Layer, Option } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import {
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { ServerAuth } from "../../src/server/auth"
import { authorizationRouterMiddleware } from "../../src/server/routes/instance/httpapi/middleware/authorization"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { serveEmbeddedUIEffect, serveUIEffect } from "../../src/server/shared/ui"
import { testEffect } from "../lib/effect"

const testStateLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const original = {
      OPENCODE_SERVER_PASSWORD: Flag.OPENCODE_SERVER_PASSWORD,
      OPENCODE_SERVER_USERNAME: Flag.OPENCODE_SERVER_USERNAME,
      envPassword: process.env.OPENCODE_SERVER_PASSWORD,
      envUsername: process.env.OPENCODE_SERVER_USERNAME,
    }

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        Flag.OPENCODE_SERVER_PASSWORD = original.OPENCODE_SERVER_PASSWORD
        Flag.OPENCODE_SERVER_USERNAME = original.OPENCODE_SERVER_USERNAME
        restoreEnv("OPENCODE_SERVER_PASSWORD", original.envPassword)
        restoreEnv("OPENCODE_SERVER_USERNAME", original.envUsername)
      }),
    )
  }),
)

const fsUtilLayer = AppNodeBuilder.build(FSUtil.node)
const it = testEffect(Layer.mergeAll(testStateLayer, fsUtilLayer, RuntimeFlags.layer()))

function authConfigLayer(input?: { password?: string; username?: string }) {
  return ServerAuth.Config.configLayer({
    password: input?.password === undefined ? Option.none() : Option.some(input.password),
    username: input?.username ?? "opencode",
  })
}

function restoreEnv(key: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[key]
    return
  }
  process.env[key] = value
}

// Web 层在首次请求时才构建；factory 返回前登记清理，调用方 yield 后才能发请求。
const app = Effect.fnUntraced(function* (input?: { password?: string; username?: string }) {
  const { handler, dispose } = HttpRouter.toWebHandler(
    HttpApiApp.routes.pipe(
      Layer.provide(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({
            OPENCODE_SERVER_PASSWORD: input?.password,
            OPENCODE_SERVER_USERNAME: input?.username,
          }),
        ),
      ),
    ),
    { disableLogger: true },
  )
  yield* Effect.addFinalizer(() => Effect.promise(dispose))
  return {
    request(input: string | URL | Request, init?: RequestInit) {
      return Effect.promise(() =>
        Promise.resolve(
          handler(
            input instanceof Request ? input : new Request(new URL(input, "http://localhost"), init),
            HttpApiApp.context,
          ),
        ),
      )
    },
  }
})

// 每个 UI app 归当前测试的 body scope 所有，断言失败也先释放资源，再恢复全局 flag。
const uiApp = Effect.fnUntraced(function* (input?: {
  password?: string
  username?: string
  client?: Layer.Layer<HttpClient.HttpClient>
  disableEmbeddedWebUi?: boolean
}) {
  const { handler, dispose } = HttpRouter.toWebHandler(
    HttpRouter.use((router) =>
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const client = yield* HttpClient.HttpClient
        const flags = yield* RuntimeFlags.Service
        yield* router.add("*", "/*", (request) =>
          serveUIEffect(request, { fs, client, disableEmbeddedWebUi: flags.disableEmbeddedWebUi }),
        )
      }),
    ).pipe(
      Layer.provide(authorizationRouterMiddleware.layer.pipe(Layer.provide(authConfigLayer(input)))),
      Layer.provide([
        fsUtilLayer,
        input?.client ?? httpClient(new Response("ui")),
        RuntimeFlags.layer({ disableEmbeddedWebUi: input?.disableEmbeddedWebUi ?? false }),
        HttpServer.layerServices,
      ]),
    ),
    { disableLogger: true },
  )
  yield* Effect.addFinalizer(() => Effect.promise(dispose))
  return {
    request(input: string | URL | Request, init?: RequestInit) {
      return Effect.promise(() =>
        Promise.resolve(
          handler(
            input instanceof Request ? input : new Request(new URL(input, "http://localhost"), init),
            HttpApiApp.context,
          ),
        ),
      )
    },
  }
})

// 与 UI factory 保持相同归属，不让路由顺序测试的客户端层逃出测试 scope。
const routeOrderingApp = Effect.fnUntraced(function* () {
  let proxiedUrl: string | undefined
  const { handler, dispose } = HttpRouter.toWebHandler(
    HttpRouter.use((router) =>
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const client = yield* HttpClient.HttpClient
        const flags = yield* RuntimeFlags.Service
        yield* router.add("GET", "/session/:sessionID", () =>
          Effect.succeed(HttpServerResponse.jsonUnsafe({ error: "Not Found" }, { status: 404 })),
        )
        yield* router.add("*", "/*", (request) =>
          serveUIEffect(request, { fs, client, disableEmbeddedWebUi: flags.disableEmbeddedWebUi }),
        )
      }),
    ).pipe(
      Layer.provide([
        fsUtilLayer,
        RuntimeFlags.layer({ disableEmbeddedWebUi: true }),
        httpClient(new Response("ui"), (request) => {
          proxiedUrl = request.url
        }),
        HttpServer.layerServices,
      ]),
    ),
    { disableLogger: true },
  )
  yield* Effect.addFinalizer(() => Effect.promise(dispose))
  return {
    proxiedUrl: () => proxiedUrl,
    request(input: string | URL | Request, init?: RequestInit) {
      return Effect.promise(() =>
        Promise.resolve(
          handler(
            input instanceof Request ? input : new Request(new URL(input, "http://localhost"), init),
            HttpApiApp.context,
          ),
        ),
      )
    },
  }
})

function httpClient(response: Response, onRequest?: (request: HttpClientRequest.HttpClientRequest) => void) {
  return Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      onRequest?.(request)
      return Effect.succeed(HttpClientResponse.fromWeb(request, response))
    }),
  )
}

function responseText(response: Response) {
  return Effect.promise(() => response.text())
}

describe("HttpApi UI fallback", () => {
  it.live("serves the web UI through the HTTP API app", () =>
    Effect.gen(function* () {
      let proxiedUrl: string | undefined

      const server = yield* uiApp({
        disableEmbeddedWebUi: true,
        client: httpClient(
          new Response("<html>opencode</html>", { headers: { "content-type": "text/html" } }),
          (request) => {
            proxiedUrl = request.url
          },
        ),
      })
      const response = yield* server.request("/")

      expect(response.status).toBe(200)
      expect(response.headers.get("content-type")).toContain("text/html")
      expect(yield* responseText(response)).toBe("<html>opencode</html>")
      expect(proxiedUrl).toBe("https://app.opencode.ai/")
      // 沿同一真实 UI 服务例覆盖成功和失败的释放出口，不新增独立用例。
      for (const fail of [false, true]) {
        const events: string[] = []
        // 固定哨兵区分故意失败与请求断言异常，避免把所有 failure 都误当作预期结果。
        const failure = new Error("intentional body failure")
        // 先关闭子 scope 再捕获 Exit，使释放阶段的异常也进入检查，不能提前记录成功。
        const exit = yield* Effect.gen(function* () {
          const server = yield* uiApp({
            disableEmbeddedWebUi: true,
            client: httpClient(new Response("scope probe")).pipe(
              // 必须由真实请求触发层构建，防止从未使用 handler 的空 scope 通过清理检查。
              Layer.tap(() =>
                Effect.acquireRelease(
                  Effect.sync(() => events.push("acquired")),
                  () => Effect.sync(() => events.push("disposed")),
                ),
              ),
            ),
          })
          const response = yield* server.request("/")
          expect(response.status).toBe(200)
          expect(yield* responseText(response)).toBe("scope probe")
          expect(events).toEqual(["acquired"])
          if (fail) yield* Effect.die(failure)
        }).pipe(Effect.scoped, Effect.exit)

        expect(exit).toEqual(fail ? Exit.die(failure) : Exit.void)
        expect(events).toEqual(["acquired", "disposed"])
      }
    }),
  )

  it.live("strips upstream transfer encoding headers from proxied assets", () =>
    Effect.gen(function* () {
      let proxiedUrl: string | undefined

      const response = yield* Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const client = yield* HttpClient.HttpClient
        const flags = yield* RuntimeFlags.Service
        return yield* serveUIEffect(HttpServerRequest.fromWeb(new Request("http://localhost/assets/app.js")), {
          fs,
          client,
          disableEmbeddedWebUi: flags.disableEmbeddedWebUi,
        })
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            RuntimeFlags.layer({ disableEmbeddedWebUi: true }),
            Layer.succeed(
              HttpClient.HttpClient,
              HttpClient.make((request) => {
                proxiedUrl = request.url
                return Effect.succeed(
                  HttpClientResponse.fromWeb(
                    request,
                    new Response("console.log('ok')", {
                      headers: {
                        "content-encoding": "br",
                        "content-length": "999",
                        "content-type": "text/javascript",
                      },
                    }),
                  ),
                )
              }),
            ),
          ),
        ),
        Effect.map(HttpServerResponse.toWeb),
      )

      expect(response.status).toBe(200)
      expect(proxiedUrl).toBe("https://app.opencode.ai/assets/app.js")
      expect(response.headers.get("content-encoding")).toBeNull()
      expect(response.headers.get("content-length")).not.toBe("999")
      expect(response.headers.get("content-type")).toContain("text/javascript")
      expect(yield* responseText(response)).toBe("console.log('ok')")
    }),
  )

  // Regression for #25698 (Ope): upstream `transfer-encoding: chunked` was
  // forwarded through the proxy while the proxy itself re-frames the body,
  // causing browsers to fail with `ERR_INVALID_CHUNKED_ENCODING`.
  it.live("strips upstream transfer-encoding header from proxied assets", () =>
    Effect.gen(function* () {
      const response = yield* Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const client = yield* HttpClient.HttpClient
        const flags = yield* RuntimeFlags.Service
        return yield* serveUIEffect(HttpServerRequest.fromWeb(new Request("http://localhost/")), {
          fs,
          client,
          disableEmbeddedWebUi: flags.disableEmbeddedWebUi,
        })
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            RuntimeFlags.layer({ disableEmbeddedWebUi: true }),
            Layer.succeed(
              HttpClient.HttpClient,
              HttpClient.make((request) =>
                Effect.succeed(
                  HttpClientResponse.fromWeb(
                    request,
                    new Response("<html>opencode</html>", {
                      headers: {
                        "transfer-encoding": "chunked",
                        "content-type": "text/html",
                      },
                    }),
                  ),
                ),
              ),
            ),
          ),
        ),
        Effect.map(HttpServerResponse.toWeb),
      )

      expect(response.status).toBe(200)
      expect(response.headers.get("transfer-encoding")).toBeNull()
      expect(yield* responseText(response)).toBe("<html>opencode</html>")
    }),
  )

  it.live("serves embedded UI assets when Bun can read them but access reports missing", () =>
    Effect.gen(function* () {
      let readPath: string | undefined

      const fs = yield* FSUtil.Service
      const response = yield* serveEmbeddedUIEffect(
        "/assets/app.js",
        {
          ...fs,
          existsSafe: () => Effect.die("embedded UI should not rely on filesystem access checks"),
          readFile: (path) => {
            readPath = path
            return path === "/$bunfs/root/assets/app.js"
              ? Effect.succeed(new TextEncoder().encode("console.log('embedded')"))
              : Effect.die(`unexpected embedded UI path: ${path}`)
          },
        },
        { "assets/app.js": "/$bunfs/root/assets/app.js" },
      ).pipe(Effect.map(HttpServerResponse.toWeb))

      expect(response.status).toBe(200)
      expect(readPath).toBe("/$bunfs/root/assets/app.js")
      expect(response.headers.get("content-type")).toContain("text/javascript")
      expect(yield* responseText(response)).toBe("console.log('embedded')")
    }),
  )

  it.live("allows embedded UI terminal wasm, blob attachments, and theme preload CSP", () =>
    Effect.gen(function* () {
      const script = 'document.documentElement.dataset.theme = "dark"'

      const fs = yield* FSUtil.Service
      const response = yield* serveEmbeddedUIEffect(
        "/",
        {
          ...fs,
          readFile: (path) => {
            return path === "/$bunfs/root/index.html"
              ? Effect.succeed(
                  new TextEncoder().encode(
                    `<html><head><script id="oc-theme-preload-script">${script}</script></head></html>`,
                  ),
                )
              : Effect.die(`unexpected embedded UI path: ${path}`)
          },
        },
        { "index.html": "/$bunfs/root/index.html" },
      ).pipe(Effect.map(HttpServerResponse.toWeb))

      const csp = response.headers.get("content-security-policy") ?? ""
      expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval'")
      expect(csp).toContain(`'sha256-${createHash("sha256").update(script).digest("base64")}'`)
      expect(csp).toContain("img-src 'self' data: https: blob:")
      expect(csp).toContain("connect-src * data: blob:")
    }),
  )

  it.live("keeps matched API routes ahead of the UI fallback", () =>
    Effect.gen(function* () {
      const server = yield* routeOrderingApp()
      const response = yield* server.request("/session/ses_nope")

      expect(response.status).toBe(404)
      expect(server.proxiedUrl()).toBeUndefined()
    }),
  )

  it.live("requires server password for the web UI", () =>
    Effect.gen(function* () {
      const server = yield* uiApp({
        password: "secret",
        username: "opencode",
        disableEmbeddedWebUi: true,
      })
      const response = yield* server.request("/")

      expect(response.status).toBe(401)
      expect(response.headers.get("www-authenticate")).toBe('Basic realm="Secure Area"')
    }),
  )

  it.live("accepts auth token for the web UI", () =>
    Effect.gen(function* () {
      const server = yield* uiApp({
        password: "secret",
        username: "opencode",
        disableEmbeddedWebUi: true,
        client: httpClient(new Response("<html>opencode</html>", { headers: { "content-type": "text/html" } })),
      })
      const response = yield* server.request(`/?auth_token=${btoa("opencode:secret")}`)

      expect(response.status).toBe(200)
      expect(yield* responseText(response)).toBe("<html>opencode</html>")
    }),
  )

  it.live("accepts basic auth for the web UI", () =>
    Effect.gen(function* () {
      const server = yield* uiApp({
        password: "secret",
        username: "opencode",
        disableEmbeddedWebUi: true,
      })
      const response = yield* server.request("/", {
        headers: { authorization: `Basic ${btoa("opencode:secret")}` },
      })

      expect(response.status).toBe(200)
    }),
  )

  it.live("accepts basic auth passwords containing colons for the web UI", () =>
    Effect.gen(function* () {
      const server = yield* uiApp({
        password: "sec:ret",
        username: "opencode",
        disableEmbeddedWebUi: true,
      })
      const response = yield* server.request("/", {
        headers: { authorization: `Basic ${btoa("opencode:sec:ret")}` },
      })

      expect(response.status).toBe(200)
    }),
  )

  // Regression for #25698 (Ope): the browser fetches the PWA manifest and
  // its icons via flows that don't carry app-managed credentials (the
  // `<link rel="manifest">` request is not under page-auth control), so the
  // server returning 401 breaks PWA install. These specific public assets
  // should bypass auth.
  it.live("serves the PWA manifest without auth even when a server password is set", () =>
    Effect.gen(function* () {
      // 每个资源使用独立客户端层，全部 handler 都归本例 scope，不能只释放最后创建的一份。
      for (const path of ["/site.webmanifest", "/web-app-manifest-192x192.png", "/web-app-manifest-512x512.png"]) {
        const server = yield* uiApp({
          password: "secret",
          username: "opencode",
          disableEmbeddedWebUi: true,
          client: httpClient(new Response("ok")),
        })
        const response = yield* server.request(path)
        expect(response.status).not.toBe(401)
      }
    }),
  )

  it.live("allows web UI preflight without auth", () =>
    Effect.gen(function* () {
      const server = yield* app({ password: "secret", username: "opencode" })
      const response = yield* server.request("/", {
        method: "OPTIONS",
        headers: {
          origin: "http://localhost:3000",
          "access-control-request-method": "GET",
        },
      })

      expect(response.status).toBe(204)
      expect(response.headers.get("access-control-allow-origin")).toBe("http://localhost:3000")
    }),
  )
})
