import { AISDK } from "@opencode-ai/core/aisdk"
import { describe, expect, spyOn } from "bun:test"
import { NetworkProxy } from "@opencode-ai/core/network-proxy"
import { Effect } from "effect"
import { ModelV2 } from "@opencode-ai/core/model"
import { PluginV2 } from "@opencode-ai/core/plugin"
import { PluginHost } from "@opencode-ai/core/plugin/host"
import { OpenAICompatiblePlugin } from "@opencode-ai/core/plugin/provider/openai-compatible"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

const it = testEffect(PluginTestLayer)

const addPlugin = Effect.fn(function* () {
  const plugin = yield* PluginV2.Service
  const aisdk = yield* AISDK.Service
  const host = yield* PluginHost.make(plugin)
  yield* OpenAICompatiblePlugin.effect(host)
})

describe("OpenAICompatiblePlugin", () => {
  it.effect("preserves explicit includeUsage false and defaults it to true", () =>
    Effect.gen(function* () {
      const plugin = yield* PluginV2.Service
      const aisdk = yield* AISDK.Service
      yield* addPlugin()
      const defaulted = yield* aisdk.runSDK({
        model: ModelV2.Info.make({
          ...ModelV2.Info.empty(ProviderV2.ID.make("custom"), ModelV2.ID.make("model")),
          api: { id: ModelV2.ID.make("model"), type: "aisdk", package: "test-provider" },
        }),
        package: "@ai-sdk/openai-compatible",
        options: { name: "custom" },
      })
      const disabled = yield* aisdk.runSDK({
        model: ModelV2.Info.make({
          ...ModelV2.Info.empty(ProviderV2.ID.make("custom"), ModelV2.ID.make("model")),
          api: { id: ModelV2.ID.make("model"), type: "aisdk", package: "test-provider" },
        }),
        package: "@ai-sdk/openai-compatible",
        options: { name: "custom", includeUsage: false },
      })
      expect(defaulted.options.includeUsage).toBe(true)
      expect(disabled.options.includeUsage).toBe(false)
    }),
  )

  it.effect("defaults includeUsage for OpenAI-compatible package matches", () =>
    Effect.gen(function* () {
      const plugin = yield* PluginV2.Service
      const aisdk = yield* AISDK.Service
      yield* addPlugin()
      const result = yield* aisdk.runSDK({
        model: ModelV2.Info.make({
          ...ModelV2.Info.empty(ProviderV2.ID.make("custom"), ModelV2.ID.make("model")),
          api: { id: ModelV2.ID.make("model"), type: "aisdk", package: "test-provider" },
        }),
        package: "file:///tmp/@ai-sdk/openai-compatible-provider.js",
        options: { name: "custom" },
      })
      expect(result.options.includeUsage).toBe(true)
    }),
  )

  it.effect("uses the provider ID as the OpenAI-compatible provider name", () =>
    Effect.gen(function* () {
      const plugin = yield* PluginV2.Service
      const aisdk = yield* AISDK.Service
      const observed: string[] = []
      const controller = new AbortController()
      const signal = controller.signal
      const fetchSpy = spyOn(NetworkProxy, "fetch").mockResolvedValue(new Response("ok"))
      yield* Effect.addFinalizer(() => Effect.sync(() => fetchSpy.mockRestore()))
      yield* addPlugin()
      yield* aisdk.hook.sdk((event) =>
        Effect.promise(async () => {
          observed.push(event.sdk.languageModel("model").provider)
          await event.options.fetch("http://127.0.0.1:9/v1/chat/completions", { signal })
        }),
      )
      yield* aisdk.language(
        ModelV2.Info.make({
          ...ModelV2.Info.empty(ProviderV2.ID.make("custom-provider"), ModelV2.ID.make("model")),
          api: {
            id: ModelV2.ID.make("model"),
            type: "aisdk",
            package: "@ai-sdk/openai-compatible",
            url: "http://127.0.0.1:9/v1",
            settings: { timeout: false },
          },
        }),
      )
      expect(observed).toEqual(["custom-provider.chat"])
      expect(fetchSpy).toHaveBeenCalledTimes(1)
      expect(fetchSpy.mock.calls[0]?.[1]?.purpose).toBe("provider")
      // SSE期限会组合信号，原取消原因必须仍穿透，不能要求对象引用同一。
      const forwarded = fetchSpy.mock.calls[0]?.[1]?.signal
      expect(forwarded?.aborted).toBe(false)
      controller.abort("caller cancelled")
      expect(forwarded?.aborted).toBe(true)
      expect(forwarded?.reason).toBe("caller cancelled")
    }),
  )

  it.effect("does not overwrite an SDK created by an earlier provider-specific plugin", () =>
    Effect.gen(function* () {
      const aisdk = yield* AISDK.Service
      const sentinel = { languageModel: (modelID: string) => ({ modelID }) }
      yield* aisdk.hook.sdk((event) => {
        event.sdk = sentinel
      })
      yield* addPlugin()
      const result = yield* aisdk.runSDK({
        model: ModelV2.Info.make({
          ...ModelV2.Info.empty(ProviderV2.ID.make("cloudflare-workers-ai"), ModelV2.ID.make("model")),
          api: { id: ModelV2.ID.make("model"), type: "aisdk", package: "test-provider" },
        }),
        package: "@ai-sdk/openai-compatible",
        options: { name: "cloudflare-workers-ai" },
      })
      expect(result.sdk).toBe(sentinel)
    }),
  )
})
