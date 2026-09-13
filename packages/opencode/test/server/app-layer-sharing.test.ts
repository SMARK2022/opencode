import { expect, test } from "bun:test"
import { ConfigProvider, Layer } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"

// 共用目标应用图，但认证配置与关闭资源仍由每个listener独立拥有。
test(
  "two listeners keep their own auth while serving the same route tree",
  async () => {
    const shared = HttpApiApp.createSharedServices()
    const make = (password: string) =>
      HttpRouter.toWebHandler(
        HttpApiApp.createRoutes(undefined, undefined, shared).pipe(
          Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ OPENCODE_SERVER_PASSWORD: password }))),
        ),
        { memoMap: Layer.makeMemoMapUnsafe(), disableLogger: true },
      )
    const first = make("first-secret")
    const second = make("second-secret")
    const request = (password: string) =>
      new Request("http://localhost/global/health", {
        headers: { authorization: `Basic ${btoa(`opencode:${password}`)}` },
      })
    try {
      expect((await first.handler(request("first-secret"), HttpApiApp.context)).status).toBe(200)
      expect((await second.handler(request("second-secret"), HttpApiApp.context)).status).toBe(200)
      // 交叉密码必须 401：listener 本地鉴权不因路由树复用而串号。
      expect((await second.handler(request("first-secret"), HttpApiApp.context)).status).toBe(401)
      await first.dispose()
      expect((await second.handler(request("second-secret"), HttpApiApp.context)).status).toBe(200)
    } finally {
      await first.dispose()
      await second.dispose()
    }
  },
  60000,
)
