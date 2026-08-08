import type { Auth } from "@/auth"
import { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import { errorMessage } from "@/util/error"
import { isRecord } from "@/util/record"
import { asSchema, type ModelMessage, type Tool } from "ai"
import { Cause, Effect, FiberSet, Queue } from "effect"
import * as Stream from "effect/Stream"
import { FetchHttpClient } from "effect/unstable/http"
import { NetworkProxy } from "@opencode-ai/core/network-proxy"
import {
  LLMError,
  HttpOptions,
  LLMRequest,
  Tool as NativeTool,
  ToolFailure,
  ToolRuntime,
  TransportReason,
  toDefinitions,
  type JsonSchema,
  type LLMEvent,
} from "@opencode-ai/llm"
import type { LLMClientShape } from "@opencode-ai/llm/route"
import { LLMNative } from "./native-request"
import { isOpenaiOauthByModelNpm } from "@/provider/alias"

export type RuntimeStatus =
  | { readonly type: "supported"; readonly apiKey: string; readonly baseURL?: string }
  | { readonly type: "unsupported"; readonly reason: string }
export type StreamResult =
  | { readonly type: "supported"; readonly stream: Stream.Stream<LLMEvent, unknown> }
  | { readonly type: "unsupported"; readonly reason: string }

type StreamInput = {
  readonly model: Provider.Model
  readonly provider: Provider.Info
  readonly auth: Auth.Info | undefined
  readonly llmClient: LLMClientShape
  readonly messages: ModelMessage[]
  readonly tools: Record<string, Tool>
  readonly toolChoice?: "auto" | "required" | "none"
  readonly temperature?: number
  readonly topP?: number
  readonly topK?: number
  readonly maxOutputTokens?: number
  readonly providerOptions?: Record<string, any>
  readonly headers: Record<string, string>
  readonly abort: AbortSignal
  readonly onRequestPrepared?: (body: unknown) => Effect.Effect<void>
}

export function status(input: Pick<StreamInput, "model" | "provider" | "auth">): RuntimeStatus {
  return statusWithFetch(input, providerFetch(input))
}

function statusWithFetch(
  input: Pick<StreamInput, "model" | "provider" | "auth">,
  fetch: typeof globalThis.fetch | undefined,
): RuntimeStatus {
  const providerID = input.model.providerID
  if (providerID !== "openai" && providerID !== "anthropic" && !providerID.startsWith("opencode"))
    return { type: "unsupported", reason: "provider is not openai, opencode, or anthropic" }
  const npm = input.model.api.npm
  if (npm !== "@ai-sdk/openai" && npm !== "@ai-sdk/openai-compatible" && npm !== "@ai-sdk/anthropic")
    return { type: "unsupported", reason: "provider package is not OpenAI, OpenAI-compatible, or Anthropic" }
  // #114：oauth + openai(含别名 npm) + fetch 才支持 native
  if (
    input.auth?.type === "oauth" &&
    !(isOpenaiOauthByModelNpm(input.provider.id, input.model.api.npm) && fetch)
  ) {
    return { type: "unsupported", reason: "OAuth auth requires a provider fetch override" }
  }

  const apiKey = typeof input.provider.options.apiKey === "string" ? input.provider.options.apiKey : input.provider.key
  if (!apiKey) return { type: "unsupported", reason: "API key is not configured" }

  return {
    type: "supported",
    apiKey,
    baseURL: typeof input.provider.options.baseURL === "string" ? input.provider.options.baseURL : undefined,
  }
}

export function stream(input: StreamInput): StreamResult {
  const fetch = providerFetch(input)
  const current = statusWithFetch(input, fetch)
  if (current.type === "unsupported") return current
  // native 沿 V1 SDK 工厂的 provider.options 期限，不把协议正文选项误当运输配置。
  const timeout = input.provider.options.timeout

  // Integration point with @opencode-ai/llm: native-request lowers session data
  // into an LLMRequest, then LLMClient handles route selection and transport.
  //
  // ProviderTransform.providerOptions builds AI-SDK-shaped options for the
  // selected SDK key (e.g. "openai") and the native LLM SDK reads the same
  // keys via OpenAIOptions.* (store, reasoningEffort, reasoningSummary,
  // include, textVerbosity, promptCacheKey). Both sides intentionally use
  // OpenAI's official wire field names, so this is identity, not translation
  // — if a field ever needs to differ between the two surfaces, the
  // translation belongs here, not split across both packages.
  const tools = nativeTools(input.tools, input)
  // 与 SDK 的最终发送策略一致，配置 UA 在插件合并之后落实且不产生大小写重复头。
  const headers = new Headers({ ...Provider.requestHeaders(input.provider.options), ...input.headers })
  const userAgent = Provider.requestUserAgent(input.provider.options)
  if (userAgent) headers.set("User-Agent", userAgent)
  const request = LLMNative.request({
    model: input.model,
    apiKey: current.apiKey,
    baseURL: current.baseURL,
    messages: ProviderTransform.message(input.messages, input.model, input.providerOptions ?? {}),
    toolChoice: input.toolChoice,
    temperature: input.temperature,
    topP: input.topP,
    topK: input.topK,
    maxOutputTokens: input.maxOutputTokens,
    providerOptions: ProviderTransform.providerOptions(input.model, input.providerOptions ?? {}),
    // 其他模型/插件头保留原合并结果，只将配置 UA 的优先级对齐本项。
    headers: Object.fromEntries(headers),
  })
  // 估算和唯一 stream 共享最终工具定义，不重建权限或 Schema。
  const chunkTimeout = input.provider.options.chunkTimeout
  const advertised = LLMRequest.update(request, {
    // 内部repair保留执行注册，但与SDK的activeTools一致，不向模型广告invalid。
    tools: [...request.tools, ...toDefinitions(tools).filter((tool) => tool.name !== "invalid")],
    // 运输选项留在HTTP合同，原headers/body/query不能因增加期限而被覆盖。
    http: HttpOptions.make({ ...request.http,
      chunkTimeout: chunkTimeout === false || typeof chunkTimeout === "number" ? chunkTimeout : undefined }),
  })
  const stream = Stream.scoped(
    Stream.unwrap(
      Effect.gen(function* () {
        const settlements = yield* FiberSet.make<void>()
        const results = yield* Queue.unbounded<LLMEvent, Cause.Done>()
        const provider = input.llmClient
          // native 与 V2 使用同一 compile 回调，模型默认 system 不得在提前估算时漏掉。
          .stream(advertised, input.onRequestPrepared)
          .pipe(
            // 固定总期限只包 provider 流，活跃 chunks 不续期，结束后的本地工具等待仍归 settlement。
            // 同一provider的native入口也使用十分钟缺省，显式值与false不变。
            Stream.interruptWhen(timeout === false ? Effect.never : Effect.sleep(typeof timeout === "number" ? timeout : 600_000).pipe(
              Effect.andThen(Effect.fail(new LLMError({
                module: "LLMNativeRuntime",
                method: "stream",
                reason: new TransportReason({ message: "Provider request timed out", kind: "timeout" }),
              }))),
            )),
            Stream.flatMap((event) =>
              event.type !== "tool-call" || event.providerExecuted
                ? Stream.make(event)
                : Stream.make(event).pipe(
                    Stream.concat(
                      Stream.fromEffectDrain(
                        ToolRuntime.dispatch(tools, event).pipe(
                          Effect.flatMap((dispatched) => Queue.offerAll(results, dispatched.events)),
                          Effect.catchCause((cause) => Queue.failCause(results, cause)),
                          Effect.asVoid,
                          FiberSet.run(settlements, { startImmediately: true }),
                        ),
                      ),
                    ),
                  ),
            ),
            Stream.concat(
              Stream.fromEffectDrain(
                FiberSet.awaitEmpty(settlements).pipe(Effect.andThen(Queue.end(results)), Effect.asVoid),
              ),
            ),
          )
        return provider.pipe(Stream.concat(Stream.fromQueue(results)))
      }),
    ),
  )

  return {
    ...current,
    stream: fetch ? stream.pipe(Stream.provideService(
      FetchHttpClient.Fetch,
      Object.assign(
        (value: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => NetworkProxy.fetchWithRoute(fetch, value, { ...init, purpose: "provider" }),
        // OAuth fetch 仍负责鉴权；局部 reference 取代默认 transport，不能再绕过代理或改写信号。
        { preconnect: fetch.preconnect },
      ),
    )) : stream,
  }
}

function providerFetch(input: Pick<StreamInput, "provider" | "auth">): typeof globalThis.fetch | undefined {
  // #114：openai 别名 oauth：id 为 openai 或模型 npm 为 @ai-sdk/openai
  // #114：providerFetch 无 model 参数，只能扫 provider.models 推断 npm
  if (input.auth?.type !== "oauth") return undefined
  const npmHit = Object.values(input.provider.models ?? {}).some((m) => m.api?.npm === "@ai-sdk/openai")
  // #114：非 openai id 且无 openai npm 模型则不是目标别名
  if (input.provider.id !== "openai" && !npmHit) return undefined
  const value: unknown = input.provider.options.fetch
  if (typeof value !== "function") return undefined
  return value as typeof globalThis.fetch
}

function providerHeaders(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  )
}

function nativeSchema(value: unknown): JsonSchema {
  if (!value || typeof value !== "object") return { type: "object", properties: {} }
  if ("jsonSchema" in value && value.jsonSchema && typeof value.jsonSchema === "object")
    return value.jsonSchema as JsonSchema
  return asSchema(value as Parameters<typeof asSchema>[0]).jsonSchema as JsonSchema
}

export function nativeTools(tools: Record<string, Tool>, input: Pick<StreamInput, "messages" | "abort">) {
  return Object.fromEntries(
    Object.entries(tools).map(([name, item]) => [
      name,
      // Tool execution remains opencode-owned. The native runtime only adapts
      // the @opencode-ai/llm tool call back into the AI SDK Tool.execute shape.
      NativeTool.make({
        description: item.description ?? "",
        jsonSchema: nativeSchema(item.inputSchema),
        execute: (args: unknown, ctx) =>
          Effect.tryPromise({
            try: () => {
              if (!item.execute) throw new Error(`Tool has no execute handler: ${name}`)
              return item.execute(args, {
                toolCallId: ctx?.id ?? name,
                messages: input.messages,
                abortSignal: input.abort,
              })
            },
            catch: (error) => new ToolFailure({ message: errorMessage(error), error }),
          }),
      }),
    ]),
  )
}

export * as LLMNativeRuntime from "./native-runtime"
