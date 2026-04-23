import { Effect } from "effect"
import { define } from "../internal"

export const AnthropicPlugin = define({
  id: "anthropic",
  effect: Effect.fn(function* (ctx) {
    yield* ctx.catalog.transform(
      Effect.fn(function* (evt) {
        for (const item of evt.provider.list()) {
          if (item.provider.api.type !== "aisdk") continue
          if (item.provider.api.package !== "@ai-sdk/anthropic") continue
          evt.provider.update(item.provider.id, (provider) => {
            // 原生 catalog 也恢复源 beta；不在这里强改模型 thinking 配置。
            provider.request.headers["anthropic-beta"] =
              "interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14,redact-thinking-2026-02-12"
          })
        }
      }),
    )
    yield* ctx.aisdk.sdk(
      Effect.fn(function* (evt) {
        if (evt.package !== "@ai-sdk/anthropic") return
        const mod = yield* Effect.promise(() => import("@ai-sdk/anthropic"))
        evt.sdk = mod.createAnthropic(evt.options)
      }),
    )
  }),
})
