import { AISDK } from "@opencode-ai/core/aisdk"
import { describe, expect, spyOn } from "bun:test"
import type { LanguageModelV3 } from "@ai-sdk/provider"
import { Effect } from "effect"
import { Catalog } from "@opencode-ai/core/catalog"
import { Integration } from "@opencode-ai/core/integration"
import { ModelV2 } from "@opencode-ai/core/model"
import { NetworkProxy } from "@opencode-ai/core/network-proxy"
import { PluginV2 } from "@opencode-ai/core/plugin"
import { PluginHost } from "@opencode-ai/core/plugin/host"
import { CodexHeaders } from "@opencode-ai/core/plugin/provider/codex-headers"
import { OpenAIPlugin } from "@opencode-ai/core/plugin/provider/openai"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

const it = testEffect(PluginTestLayer)

const addPlugin = Effect.fn(function* () {
  const plugin = yield* PluginV2.Service
  const aisdk = yield* AISDK.Service
  const host = yield* PluginHost.make(plugin)
  const integrations = yield* Integration.Service
  yield* OpenAIPlugin.effect(host).pipe(Effect.provideService(Integration.Service, integrations))
})

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Expected value")
  return value
}

function fakeSelectorSdk(calls: string[]) {
  const make = (method: string) => (id: string) => {
    calls.push(`${method}:${id}`)
    return { modelId: id, provider: method, specificationVersion: "v3" } as unknown as LanguageModelV3
  }
  return {
    responses: make("responses"),
    messages: make("messages"),
    chat: make("chat"),
    languageModel: make("languageModel"),
  }
}

describe("OpenAIPlugin", () => {
  it.effect("registers browser and headless ChatGPT OAuth methods", () =>
    Effect.gen(function* () {
      yield* addPlugin()
      expect((yield* (yield* Integration.Service).get(Integration.ID.make("openai")))?.methods).toEqual([
        {
          id: Integration.MethodID.make("chatgpt-browser"),
          type: "oauth",
          label: "ChatGPT Pro/Plus (browser)",
        },
        {
          id: Integration.MethodID.make("chatgpt-headless"),
          type: "oauth",
          label: "ChatGPT Pro/Plus (headless)",
        },
      ])
    }),
  )

  it.live("uses Codex identity for device authorization, exchange and refresh", () =>
    Effect.gen(function* () {
      const calls: Request[] = []
      // 只隔离外部 HTTP 边界；实际注册方法、异步 admission 和凭据刷新仍由 Integration 执行。
      yield* Effect.acquireRelease(
        Effect.sync(() => spyOn(NetworkProxy, "fetch").mockImplementation(async (input, init) => {
          const request = new Request(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, init)
          calls.push(request)
          expect(init?.purpose).toBe("plugin")
          const pathname = new URL(request.url).pathname
          if (pathname === "/api/accounts/deviceauth/usercode")
            return Response.json({ device_auth_id: "device", user_code: "1234", interval: "1" })
          if (pathname === "/api/accounts/deviceauth/token")
            return Response.json({ authorization_code: "code", code_verifier: "verifier" })
          if (pathname === "/oauth/token")
            return Response.json({ id_token: "fixture", access_token: "access", refresh_token: "refresh", expires_in: 0 })
          throw new Error(`Unexpected auth request: ${request.url}`)
        })),
        spy => Effect.sync(() => spy.mockRestore()),
      )
      yield* addPlugin()
      const integration = yield* Integration.Service
      const integrationID = Integration.ID.make("openai")
      const attempt = yield* integration.connection.oauth({
        integrationID, methodID: Integration.MethodID.make("chatgpt-headless"), inputs: {},
      })
      // 失败时先关闭自动轮询的 scope，再恢复网络边界，避免迟到回调触及真实网络。
      yield* Effect.addFinalizer(() => integration.attempt.cancel(attempt.attemptID))
      const connection = yield* Effect.gen(function* () {
        while (true) {
          const active = yield* integration.connection.active(integrationID)
          if (active) return active
          yield* Effect.promise(() => Bun.sleep(1))
        }
      }).pipe(Effect.timeout(5000))
      const refreshed = yield* integration.connection.resolve(connection)
      expect(refreshed).toMatchObject({ type: "oauth", access: "access", refresh: "refresh" })
      expect(calls.map(request => new URL(request.url).pathname)).toEqual([
        "/api/accounts/deviceauth/usercode", "/api/accounts/deviceauth/token", "/oauth/token", "/oauth/token",
      ])
      for (const request of calls) {
        expect(request.headers.get("originator")).toBe("codex-tui")
        expect(request.headers.get("user-agent")).toBe(CodexHeaders.USER_AGENT)
      }
      // 交换和刷新验证实际编码与 grant，不把统一身份误做成统一 JSON 请求体。
      expect(calls.map(request => request.headers.get("content-type"))).toEqual([
        "application/json", "application/json", "application/x-www-form-urlencoded", "application/x-www-form-urlencoded",
      ])
      const exchange = new URLSearchParams(yield* Effect.promise(() => required(calls[2]).text()))
      const refresh = new URLSearchParams(yield* Effect.promise(() => required(calls[3]).text()))
      expect(exchange.get("grant_type")).toBe("authorization_code")
      expect(exchange.get("code_verifier")).toBe("verifier")
      expect(refresh.get("grant_type")).toBe("refresh_token")
      expect(refresh.get("refresh_token")).toBe("refresh")
    }),
  )

  it.effect("creates an OpenAI SDK for @ai-sdk/openai using the provider ID as SDK name", () =>
    Effect.gen(function* () {
      const plugin = yield* PluginV2.Service
      const aisdk = yield* AISDK.Service
      yield* addPlugin()
      const result = yield* aisdk.runSDK({
        model: ModelV2.Info.make({
          ...ModelV2.Info.empty(ProviderV2.ID.make("custom-openai"), ModelV2.ID.make("gpt-5")),
          api: { id: ModelV2.ID.make("gpt-5"), type: "aisdk", package: "test-provider" },
        }),
        package: "@ai-sdk/openai",
        options: { name: "custom-openai", apiKey: "test" },
      })
      expect(result.sdk?.responses("gpt-5").provider).toBe("custom-openai.responses")
    }),
  )

  it.effect("ignores non-OpenAI SDK packages", () =>
    Effect.gen(function* () {
      const plugin = yield* PluginV2.Service
      const aisdk = yield* AISDK.Service
      yield* addPlugin()
      const result = yield* aisdk.runSDK({
        model: ModelV2.Info.make({
          ...ModelV2.Info.empty(ProviderV2.ID.openai, ModelV2.ID.make("gpt-5")),
          api: { id: ModelV2.ID.make("gpt-5"), type: "aisdk", package: "test-provider" },
        }),
        package: "@ai-sdk/openai-compatible",
        options: { name: "openai" },
      })
      expect(result.sdk).toBeUndefined()
    }),
  )

  it.effect("uses the Responses API for language models", () =>
    Effect.gen(function* () {
      const plugin = yield* PluginV2.Service
      const aisdk = yield* AISDK.Service
      const calls: string[] = []
      yield* addPlugin()
      const result = yield* aisdk.runLanguage({
        model: ModelV2.Info.make({
          ...ModelV2.Info.empty(ProviderV2.ID.openai, ModelV2.ID.make("alias")),
          api: { id: ModelV2.ID.make("gpt-5"), type: "aisdk", package: "test-provider" },
        }),
        sdk: fakeSelectorSdk(calls),
        options: {},
      })
      expect(calls).toEqual(["responses:gpt-5"])
      expect(result.language).toBeDefined()
    }),
  )

  it.effect("ignores non-OpenAI providers", () =>
    Effect.gen(function* () {
      const plugin = yield* PluginV2.Service
      const aisdk = yield* AISDK.Service
      const calls: string[] = []
      yield* addPlugin()
      const result = yield* aisdk.runLanguage({
        model: ModelV2.Info.make({
          ...ModelV2.Info.empty(ProviderV2.ID.anthropic, ModelV2.ID.make("gpt-5")),
          api: { id: ModelV2.ID.make("gpt-5"), type: "aisdk", package: "test-provider" },
        }),
        sdk: fakeSelectorSdk(calls),
        options: {},
      })
      expect(calls).toEqual([])
      expect(result.language).toBeUndefined()
    }),
  )

  it.effect("disables gpt-5-chat-latest during catalog transforms", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      yield* catalog.transform((catalog) => {
        const item = ProviderV2.Info.make({
          ...ProviderV2.Info.empty(ProviderV2.ID.openai),
          api: { type: "aisdk", package: "@ai-sdk/openai" },
        })
        catalog.provider.update(item.id, (draft) => {
          draft.api = item.api
        })
        catalog.model.update(item.id, ModelV2.ID.make("gpt-5"), () => {})
        catalog.model.update(item.id, ModelV2.ID.make("gpt-5-chat-latest"), () => {})
      })
      yield* addPlugin()
      expect(required(yield* catalog.model.get(ProviderV2.ID.openai, ModelV2.ID.make("gpt-5"))).enabled).toBe(true)
      expect(
        required(yield* catalog.model.get(ProviderV2.ID.openai, ModelV2.ID.make("gpt-5-chat-latest"))).enabled,
      ).toBe(false)
    }),
  )

  it.effect("does not disable gpt-5-chat-latest for non-OpenAI providers", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      yield* catalog.transform((catalog) => {
        const item = ProviderV2.Info.make({
          ...ProviderV2.Info.empty(ProviderV2.ID.make("custom-openai")),
          api: { type: "aisdk", package: "test-provider" },
        })
        catalog.provider.update(item.id, (draft) => {
          draft.api = item.api
        })
        catalog.model.update(item.id, ModelV2.ID.make("gpt-5-chat-latest"), () => {})
      })
      yield* addPlugin()
      expect(
        required(yield* catalog.model.get(ProviderV2.ID.make("custom-openai"), ModelV2.ID.make("gpt-5-chat-latest")))
          .enabled,
      ).toBe(true)
    }),
  )
})
