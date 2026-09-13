import { expect, test } from "bun:test"
import { ConfigProvider, Context, Effect, Exit, Layer, Scope } from "effect"
import { FetchHttpClient, HttpRouter } from "effect/unstable/http"
import { AppLayer, sharedLayer } from "../../src/effect/app-runtime"
import { InstanceStore } from "../../src/project/instance-store"
import { Provider } from "../../src/provider/provider"
import { SessionGoal } from "../../src/session/goal"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionStatus } from "../../src/session/status"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { SessionV2 } from "../../src/v2/session"
import { layer as v2LocationLayer, V2LocationMiddleware } from "../../src/server/routes/instance/httpapi/groups/v2/location"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.empty)
const options = { config: { plugin: [], lsp: false as const, formatter: false as const, goal_max_turns: 0 } }

it.instance("sharedLayer builds application services once across listener scopes", () =>
  Effect.gen(function* () {
    const root = yield* Scope.Scope
    const firstScope = yield* Scope.fork(root)
    const secondScope = yield* Scope.fork(root)
    // 与 httpapi/server.ts 的 applicationLayer 同形：两次构建必须落到同一张应用图。
    const application = Layer.unwrap(
      Effect.promise(async () => sharedLayer(Layer.mergeAll(AppLayer, SessionGoal.defaultLayer, FetchHttpClient.layer))),
    )
    const first = yield* Layer.buildWithMemoMap(application, Layer.makeMemoMapUnsafe(), firstScope)
    const second = yield* Layer.buildWithMemoMap(application, Layer.makeMemoMapUnsafe(), secondScope)
    // 异构 Service tag 逐条断言，不拼联合类型数组。
    expect(Context.get(second, SessionStatus.Service)).toBe(Context.get(first, SessionStatus.Service))
    expect(Context.get(second, SessionPrompt.Service)).toBe(Context.get(first, SessionPrompt.Service))
    expect(Context.get(second, Provider.Service)).toBe(Context.get(first, Provider.Service))
    expect(Context.get(second, InstanceStore.Service)).toBe(Context.get(first, InstanceStore.Service))
    // v2 的服务依赖同样共享；handler/router 不进入该层。
    const v2 = Layer.unwrap(Effect.promise(async () => sharedLayer(Layer.mergeAll(v2LocationLayer, SessionV2.defaultLayer))))
    const v2First = yield* Layer.buildWithMemoMap(v2, Layer.makeMemoMapUnsafe(), firstScope)
    const v2Second = yield* Layer.buildWithMemoMap(v2, Layer.makeMemoMapUnsafe(), secondScope)
    expect(Context.get(v2Second, SessionV2.Service)).toBe(Context.get(v2First, SessionV2.Service))
    expect(Context.get(v2Second, V2LocationMiddleware)).toBe(Context.get(v2First, V2LocationMiddleware))
    // EventV2Bridge 由 AppLayer 输出；经 sharedLayer 单独构建必须解析为同一实例。
    const bridge = Layer.unwrap(Effect.promise(async () => sharedLayer(EventV2Bridge.defaultLayer)))
    const bridgeFirst = yield* Layer.buildWithMemoMap(bridge, Layer.makeMemoMapUnsafe(), firstScope)
    expect(Context.get(bridgeFirst, EventV2Bridge.Service)).toBe(Context.get(first, EventV2Bridge.Service))
    // 关闭一个 listener scope 不得回收仍被另一 scope 使用的共享服务。
    yield* Scope.close(firstScope, Exit.void)
    const status = Context.get(second, SessionStatus.Service)
    yield* status.set("ses_shared_layer_probe" as never, { type: "busy" })
    expect(yield* Context.get(second, SessionStatus.Service).get("ses_shared_layer_probe" as never)).toEqual({
      type: "busy",
    })
    // 共享图是进程级的：探针状态必须清走，idle 语义会从快照中删除该条目，
    // 否则同进程的其他 server 测试会读到这个残留 Session。
    yield* status.set("ses_shared_layer_probe" as never, { type: "idle" })
  }),
  options,
  60000,
)

test("two listeners keep their own auth while sharing the application graph", async () => {
  const make = (password: string) =>
    HttpRouter.toWebHandler(
      HttpApiApp.createRoutes().pipe(
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
    // 共享应用图之后鉴权仍属于各自 listener：交叉密码必须 401。
    expect((await second.handler(request("first-secret"), HttpApiApp.context)).status).toBe(401)
  } finally {
    await first.dispose()
    await second.dispose()
  }
}, 60000)
