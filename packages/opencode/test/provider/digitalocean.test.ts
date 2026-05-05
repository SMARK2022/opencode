import { expect, spyOn } from "bun:test"
import { NetworkProxy } from "@opencode-ai/core/network-proxy"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Provider } from "../../src/provider/provider"

import { Effect } from "effect"
import { testEffect } from "../lib/effect"
import { ProviderV2 } from "@opencode-ai/core/provider"

const DIGITALOCEAN = ProviderV2.ID.make("digitalocean")
const it = testEffect(LayerNode.compile(Provider.node))

const withEnv = <A, E, R>(values: Record<string, string>, effect: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      // 刷新会保存凭据，其他用例必须使用显式空认证，避免读取前一用例写入的文件。
      const vars = { OPENCODE_AUTH_CONTENT: "{}", ...values }
      const previous = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]] as const))
      Object.assign(process.env, vars)
      return previous
    }),
    () => effect,
    (previous) =>
      Effect.sync(() => {
        for (const [key, value] of Object.entries(previous)) {
          if (value === undefined) delete process.env[key]
          else process.env[key] = value
        }
      }),
  )

const withAuth = <A, E, R>(metadata: Record<string, string> | undefined, effect: Effect.Effect<A, E, R>) =>
  withEnv(
    {
      OPENCODE_AUTH_CONTENT: JSON.stringify({
        digitalocean: {
          type: "api",
          key: "sk_do_test",
          ...(metadata ? { metadata } : {}),
        },
      }),
    },
    effect,
  )

it.instance(
  "digitalocean provider autoloads from DIGITALOCEAN_ACCESS_TOKEN",
  () =>
    withEnv(
      { DIGITALOCEAN_ACCESS_TOKEN: "test-token" },
      Effect.gen(function* () {
        const provider = yield* Provider.Service
        const providers = yield* provider.list()
        expect(providers[DIGITALOCEAN]).toBeDefined()
        expect(providers[DIGITALOCEAN].source).toBe("env")
        const baseModel = Object.values(providers[DIGITALOCEAN].models)[0]
        expect(baseModel.api.url).toBe("https://inference.do-ai.run/v1")
        expect(baseModel.api.npm).toBe("@ai-sdk/openai-compatible")
        const routerEntries = Object.keys(providers[DIGITALOCEAN].models).filter((id) => id.startsWith("router:"))
        expect(routerEntries.length).toBe(0)
      }),
    ),
  { config: {} },
)

it.instance(
  "digitalocean provider.models refreshes stale routers through NetworkProxy",
  () =>
    withAuth(
      {
        routers: JSON.stringify([
          { name: "my-router", uuid: "11f1499a-aaaa-bbbb-cccc-4e013e2ddde4" },
          { name: "other-router", uuid: "22f1499a-aaaa-bbbb-cccc-4e013e2ddde4" },
        ]),
        routers_fetched_at: "0",
        oauth_access: "doo_v1_test",
        oauth_expires: String(Date.now() + 60 * 60 * 1000),
      },
      Effect.gen(function* () {
        const fetchSpy = spyOn(NetworkProxy, "fetch").mockResolvedValue(
          Response.json({
            model_routers: [
              { name: "my-router", uuid: "11f1499a-aaaa-bbbb-cccc-4e013e2ddde4" },
              { name: "other-router", uuid: "22f1499a-aaaa-bbbb-cccc-4e013e2ddde4" },
            ],
          }),
        )
        yield* Effect.addFinalizer(() => Effect.sync(() => fetchSpy.mockRestore()))
        const provider = yield* Provider.Service
        const providers = yield* provider.list()
        const models = providers[DIGITALOCEAN].models
        expect(models["router:my-router"]).toBeDefined()
        expect(models["router:my-router"].api.id).toBe("router:my-router")
        expect(models["router:my-router"].api.url).toBe("https://inference.do-ai.run/v1")
        expect(models["router:my-router"].api.npm).toBe("@ai-sdk/openai-compatible")
        expect(models["router:other-router"]).toBeDefined()
        expect(fetchSpy).toHaveBeenCalledTimes(1)
        expect(fetchSpy.mock.calls[0]?.[1]?.purpose).toBe("plugin")
        expect(fetchSpy.mock.calls[0]?.[0]).toBe("https://api.digitalocean.com/v2/gen-ai/models/routers")
        expect(new Headers(fetchSpy.mock.calls[0]?.[1]?.headers).get("authorization")).toBe("Bearer doo_v1_test")
        expect(fetchSpy.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal)
      }),
    ),
  { config: {} },
)

it.instance(
  "digitalocean provider.models skips refresh when oauth bearer is expired",
  () =>
    withAuth(
      {
        routers: JSON.stringify([{ name: "stale-router", uuid: "stale" }]),
        routers_fetched_at: "0",
        oauth_access: "doo_v1_expired",
        oauth_expires: "1",
      },
      Effect.gen(function* () {
        const provider = yield* Provider.Service
        const providers = yield* provider.list()
        const models = providers[DIGITALOCEAN].models
        expect(models["router:stale-router"]).toBeDefined()
      }),
    ),
  { config: {} },
)

it.instance(
  "digitalocean provider.models passes through base models when no auth metadata",
  () =>
    withEnv(
      { DIGITALOCEAN_ACCESS_TOKEN: "test-token" },
      Effect.gen(function* () {
        const provider = yield* Provider.Service
        const providers = yield* provider.list()
        const models = providers[DIGITALOCEAN].models
        expect(Object.keys(models).length).toBeGreaterThan(0)
        expect(Object.keys(models).filter((id) => id.startsWith("router:")).length).toBe(0)
      }),
    ),
  { config: {} },
)
