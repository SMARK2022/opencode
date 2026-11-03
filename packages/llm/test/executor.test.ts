import { describe, expect } from "bun:test"
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Logger, Queue, Random, Ref, References, Stream } from "effect"
import * as TestClock from "effect/testing/TestClock"
import {
  FetchHttpClient,
  Headers,
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http"
import { LLM, LLMError } from "../src"
import { LLMClient, RequestExecutor } from "../src/route"
import * as OpenAIChat from "../src/protocols/openai-chat"
import { dynamicResponse } from "./lib/http"
import { deltaChunk } from "./lib/openai-chunks"
import { sseRaw } from "./lib/sse"
import { it } from "./lib/effect"
import { Framing } from "../src/route/framing"
import { HttpTransport } from "../src/route/transport"

const request = HttpClientRequest.post("https://provider.test/v1/chat?api_key=secret&key=secret&debug=1").pipe(
  HttpClientRequest.setHeaders(Headers.fromInput({ authorization: "Bearer secret", "x-safe": "visible" })),
)

const secretRequest = HttpClientRequest.post("https://provider.test/v1/chat?api_key=query-secret-123&debug=1").pipe(
  HttpClientRequest.setHeaders(Headers.fromInput({ authorization: "Bearer header-secret-456" })),
)

const responsesLayer = (responses: ReadonlyArray<Response>) =>
  RequestExecutor.layer.pipe(
    Layer.provide(
      Layer.unwrap(
        Effect.gen(function* () {
          const cursor = yield* Ref.make(0)
          return Layer.succeed(
            HttpClient.HttpClient,
            HttpClient.make((request) =>
              Effect.gen(function* () {
                const index = yield* Ref.getAndUpdate(cursor, (value) => value + 1)
                return HttpClientResponse.fromWeb(request, responses[index] ?? responses[responses.length - 1])
              }),
            ),
          )
        }),
      ),
    ),
  )

const countedResponsesLayer = (attempts: Ref.Ref<number>, responses: ReadonlyArray<Response>) =>
  RequestExecutor.layer.pipe(
    Layer.provide(
      Layer.unwrap(
        Effect.gen(function* () {
          const cursor = yield* Ref.make(0)
          return Layer.succeed(
            HttpClient.HttpClient,
            HttpClient.make((request) =>
              Effect.gen(function* () {
                yield* Ref.update(attempts, (value) => value + 1)
                const index = yield* Ref.getAndUpdate(cursor, (value) => value + 1)
                return HttpClientResponse.fromWeb(request, responses[index] ?? responses[responses.length - 1])
              }),
            ),
          )
        }),
      ),
    ),
  )

const randomMidpoint = {
  nextDoubleUnsafe: () => 0.5,
  nextIntUnsafe: () => 0,
}

const expectLLMError = (error: unknown) => {
  expect(error).toBeInstanceOf(LLMError)
  if (!(error instanceof LLMError)) throw new Error("expected LLMError")
  return error
}

const errorHttp = (error: LLMError) => ("http" in error.reason ? error.reason.http : undefined)

describe("RequestExecutor", () => {
  it.effect("classifies context overflow responses", () =>
    Effect.gen(function* () {
      const executor = yield* RequestExecutor.Service
      const error = yield* executor.execute(request).pipe(Effect.flip)

      expectLLMError(error)
      expect(error.reason).toMatchObject({ _tag: "InvalidRequest", classification: "context-overflow" })
    }).pipe(
      Effect.provide(
        responsesLayer([
          new Response('{"error":{"code":"context_length_exceeded","message":"prompt too long"}}', {
            status: 400,
          }),
        ]),
      ),
    ),
  )

  it.effect("does not classify generic HTTP 413 payload errors as context overflow", () =>
    Effect.gen(function* () {
      const executor = yield* RequestExecutor.Service
      const error = yield* executor.execute(request).pipe(Effect.flip)

      expectLLMError(error)
      expect(error.reason).toMatchObject({ _tag: "InvalidRequest" })
      expect("classification" in error.reason ? error.reason.classification : undefined).toBeUndefined()
    }).pipe(Effect.provide(responsesLayer([new Response("request too large", { status: 413 })]))),
  )

  it.effect("does not classify ordinary invalid requests as context overflow", () =>
    Effect.gen(function* () {
      const executor = yield* RequestExecutor.Service
      const error = yield* executor.execute(request).pipe(Effect.flip)

      expectLLMError(error)
      expect(error.reason).toMatchObject({ _tag: "InvalidRequest" })
      expect("classification" in error.reason ? error.reason.classification : undefined).toBeUndefined()
    }).pipe(Effect.provide(responsesLayer([new Response("invalid parameter", { status: 400 })]))),
  )

  it.effect("returns redacted diagnostics for retryable rate limits", () =>
    Effect.gen(function* () {
      const executor = yield* RequestExecutor.Service
      const error = yield* executor.execute(request).pipe(Effect.flip)

      expectLLMError(error)
      expect(error).toMatchObject({
        retryable: true,
        retryAfterMs: 0,
        reason: {
          _tag: "RateLimit",
          rateLimit: { retryAfterMs: 0 },
          http: {
            requestId: "req_123",
            request: {
              method: "POST",
              url: "https://provider.test/v1/chat?api_key=%3Credacted%3E&key=%3Credacted%3E&debug=1",
              headers: { authorization: "<redacted>", "x-safe": "visible" },
            },
            response: {
              status: 429,
              headers: {
                "retry-after-ms": "0",
                "x-request-id": "req_123",
                "x-api-key": "<redacted>",
              },
            },
          },
        },
      })
      expect(errorHttp(error)?.body).toBe("rate limited")
    }).pipe(
      Effect.provide(
        responsesLayer(
          Array.from(
            { length: 3 },
            () =>
              new Response("rate limited", {
                status: 429,
                headers: { "retry-after-ms": "0", "x-request-id": "req_123", "x-api-key": "secret" },
              }),
          ),
        ),
      ),
    ),
  )

  it.effect("honors current redacted header names in diagnostics", () =>
    Effect.gen(function* () {
      const executor = yield* RequestExecutor.Service
      const error = yield* executor.execute(request).pipe(Effect.flip)

      expectLLMError(error)
      expect(errorHttp(error)?.request.headers["x-safe"]).toBe("<redacted>")
      expect(errorHttp(error)?.response?.headers["x-safe"]).toBe("<redacted>")
    }).pipe(
      Effect.provide(responsesLayer([new Response("bad", { status: 400, headers: { "x-safe": "response-secret" } })])),
      Effect.provideService(Headers.CurrentRedactedNames, ["x-safe"]),
    ),
  )

  it.effect("extracts OpenAI-style rate-limit diagnostics", () =>
    Effect.gen(function* () {
      const executor = yield* RequestExecutor.Service
      const error = yield* executor.execute(request).pipe(Effect.flip)

      expectLLMError(error)
      expect(error.reason).toMatchObject({ _tag: "RateLimit" })
      expect(error.reason._tag === "RateLimit" ? error.reason.rateLimit : undefined).toEqual({
        retryAfterMs: 0,
        limit: { requests: "500", tokens: "30000" },
        remaining: { requests: "499", tokens: "29900" },
        reset: { requests: "1s", tokens: "10s" },
      })
    }).pipe(
      Effect.provide(
        responsesLayer(
          Array.from(
            { length: 3 },
            () =>
              new Response("rate limited", {
                status: 429,
                headers: {
                  "retry-after-ms": "0",
                  "x-ratelimit-limit-requests": "500",
                  "x-ratelimit-limit-tokens": "30000",
                  "x-ratelimit-remaining-requests": "499",
                  "x-ratelimit-remaining-tokens": "29900",
                  "x-ratelimit-reset-requests": "1s",
                  "x-ratelimit-reset-tokens": "10s",
                },
              }),
          ),
        ),
      ),
    ),
  )

  it.effect("extracts Anthropic-style rate-limit diagnostics", () =>
    Effect.gen(function* () {
      const executor = yield* RequestExecutor.Service
      const error = yield* executor.execute(request).pipe(Effect.flip)

      expectLLMError(error)
      expect(error.reason).toMatchObject({ _tag: "ProviderInternal" })
      expect(errorHttp(error)?.rateLimit).toEqual({
        retryAfterMs: 0,
        limit: { requests: "100", "input-tokens": "10000" },
        remaining: { requests: "12", "input-tokens": "9000" },
        reset: { requests: "2026-05-06T12:00:00Z", "input-tokens": "2026-05-06T12:00:10Z" },
      })
    }).pipe(
      Effect.provide(
        responsesLayer(
          Array.from(
            { length: 3 },
            () =>
              new Response("overloaded", {
                status: 529,
                headers: {
                  "retry-after-ms": "0",
                  "anthropic-ratelimit-requests-limit": "100",
                  "anthropic-ratelimit-requests-remaining": "12",
                  "anthropic-ratelimit-requests-reset": "2026-05-06T12:00:00Z",
                  "anthropic-ratelimit-input-tokens-limit": "10000",
                  "anthropic-ratelimit-input-tokens-remaining": "9000",
                  "anthropic-ratelimit-input-tokens-reset": "2026-05-06T12:00:10Z",
                },
              }),
          ),
        ),
      ),
    ),
  )

  it.effect("retries only identified Cloudflare blocks and preserves cancellation", () =>
    Effect.gen(function* () {
      const headers = { server: " CloudFlare ", "cf-ray": "test-HKG", "retry-after-ms": "0" }
      const challenge = "<html>window._cf_chl_opt={};/cdn-cgi/challenge-platform/</html>"
      // 四种source指纹都走真实executor；第五例把标记放在诊断截断边界之后。
      for (const [body, extra] of [
        ["<!DOCTYPE HTML><html>challenge</html>", { "cf-mitigated": "challenge" }],
        [challenge, {}],
        ['<html><div id="cf-error-details"></div>/cdn-cgi/styles/cf.errors.css</html>', {}],
        ["<html>Unable to load site. Please try again later. https://status.openai.com/</html>", {}],
        [`<html>${"x".repeat(17000)}window._cf_chl_opt={};/cdn-cgi/challenge-platform/</html>`, {}],
      ] as const) {
        const attempts = yield* Ref.make(0)
        const response = yield* Effect.gen(function* () {
          const executor = yield* RequestExecutor.Service
          return yield* executor.execute(request)
        }).pipe(
          Effect.provide(
            countedResponsesLayer(attempts, [
              new Response(body, { status: 403, headers: { ...headers, ...extra } }),
              new Response("ok", { status: 200 }),
            ]),
          ),
        )
        expect(response.status).toBe(200)
        expect(yield* Ref.get(attempts)).toBe(2)
      }
      // 缺来源、缺ray、非HTML、错状态与普通权限页不扩大为网关重试；policy/quota仍优先。
      for (const [status, body, responseHeaders, tag] of [
        [403, challenge, { server: "other", "cf-ray": "test" }, "Authentication"],
        [403, challenge, { server: "cloudflare" }, "Authentication"],
        [403, '{"error":"window._cf_chl_opt /cdn-cgi/challenge-platform/"}', headers, "Authentication"],
        [400, challenge, headers, "InvalidRequest"],
        [403, "<html>Permission denied</html>", headers, "Authentication"],
        [401, challenge, headers, "Authentication"],
        [403, "<html>content_policy window._cf_chl_opt /cdn-cgi/challenge-platform/</html>", headers, "ContentPolicy"],
        [429, '{"error":"insufficient_quota"}', headers, "QuotaExceeded"],
      ] as const) {
        const attempts = yield* Ref.make(0)
        const error = yield* Effect.gen(function* () {
          const executor = yield* RequestExecutor.Service
          return yield* executor.execute(request).pipe(Effect.flip)
        }).pipe(
          Effect.provide(
            countedResponsesLayer(attempts, [
              new Response(body, { status, headers: responseHeaders }),
              new Response("unexpected retry", { status: 200 }),
            ]),
          ),
        )
        expectLLMError(error)
        expect(error.reason._tag).toBe(tag)
        expect(error.retryable).toBe(false)
        expect(yield* Ref.get(attempts)).toBe(1)
      }
      // 取消仍中断既有sleep；推进整个等待窗口也不得再发请求。
      const attempts = yield* Ref.make(0)
      const fiber = yield* Effect.gen(function* () {
        const executor = yield* RequestExecutor.Service
        return yield* executor.execute(request)
      }).pipe(
        Effect.provide(
          countedResponsesLayer(attempts, [
            new Response(challenge, {
              status: 403,
              headers: { server: "cloudflare", "cf-ray": "test", "retry-after": "7" },
            }),
          ]),
        ),
        Effect.forkChild,
      )
      yield* Effect.yieldNow
      expect(yield* Ref.get(attempts)).toBe(1)
      yield* Fiber.interrupt(fiber)
      yield* TestClock.adjust(8000)
      expect(yield* Ref.get(attempts)).toBe(1)
    }),
  )

  it.effect("retries retryable status responses before returning the stream", () =>
    Effect.gen(function* () {
      const executor = yield* RequestExecutor.Service
      const response = yield* executor.execute(request)

      expect(response.status).toBe(200)
      expect(yield* response.text).toBe("ok")
    }).pipe(
      Effect.provide(
        responsesLayer([
          new Response("busy", { status: 503, headers: { "retry-after-ms": "0" } }),
          new Response("ok", { status: 200 }),
        ]),
      ),
    ),
  )

  it.effect("marks 504 and 529 status responses retryable", () =>
    Effect.gen(function* () {
      const failWith = (status: number) =>
        Effect.gen(function* () {
          const executor = yield* RequestExecutor.Service
          const error = yield* executor.execute(request).pipe(Effect.flip)

          expectLLMError(error)
          expect(error.reason).toMatchObject({ _tag: "ProviderInternal", status })
          expect(error.retryable).toBe(true)
        }).pipe(
          Effect.provide(
            responsesLayer(
              Array.from(
                { length: 3 },
                () =>
                  new Response("retry", {
                    status,
                    headers: { "retry-after-ms": "0" },
                  }),
              ),
            ),
          ),
        )

      yield* failWith(504)
      yield* failWith(529)
    }),
  )

  it.effect("does not retry non-retryable status responses and truncates large bodies", () =>
    Effect.gen(function* () {
      const executor = yield* RequestExecutor.Service
      const error = yield* executor.execute(request).pipe(Effect.flip)

      expectLLMError(error)
      expect(error.reason).toMatchObject({ _tag: "Authentication" })
      expect(error.retryable).toBe(false)
      expect(errorHttp(error)?.bodyTruncated).toBe(true)
      expect(errorHttp(error)?.body).toHaveLength(16_384)
    }).pipe(
      Effect.provide(
        responsesLayer([
          new Response("x".repeat(20_000), { status: 401 }),
          new Response("should not retry", { status: 200 }),
        ]),
      ),
    ),
  )

  it.effect("redacts common secret fields in response bodies", () =>
    Effect.gen(function* () {
      const executor = yield* RequestExecutor.Service
      const error = yield* executor.execute(request).pipe(Effect.flip)

      expectLLMError(error)
      expect(errorHttp(error)?.body).toContain('"key":"<redacted>"')
      expect(errorHttp(error)?.body).toContain("api_key=<redacted>")
      expect(errorHttp(error)?.body).not.toContain("body-secret")
      expect(errorHttp(error)?.body).not.toContain("query-secret")
    }).pipe(
      Effect.provide(
        responsesLayer([
          new Response('{"error":{"message":"bad","key":"body-secret","detail":"api_key=query-secret"}}', {
            status: 400,
          }),
        ]),
      ),
    ),
  )

  it.effect("redacts echoed request secret values in response bodies", () =>
    Effect.gen(function* () {
      const executor = yield* RequestExecutor.Service
      const error = yield* executor.execute(secretRequest).pipe(Effect.flip)

      expectLLMError(error)
      expect(errorHttp(error)?.body).toContain("provider echoed <redacted>")
      expect(errorHttp(error)?.body).toContain("authorization <redacted>")
      expect(errorHttp(error)?.body).not.toContain("query-secret-123")
      expect(errorHttp(error)?.body).not.toContain("header-secret-456")
    }).pipe(
      Effect.provide(
        responsesLayer([
          new Response("provider echoed query-secret-123 and authorization header-secret-456", { status: 400 }),
        ]),
      ),
    ),
  )

  it.effect("honors Retry-After delta seconds before retrying", () =>
    Effect.gen(function* () {
      for (const status of [503, 403, 429]) {
        const attempts = yield* Ref.make(0)
        yield* Effect.gen(function* () {
          const executor = yield* RequestExecutor.Service
          const fiber = yield* executor.execute(request).pipe(Effect.forkChild)

          yield* Effect.yieldNow
          expect(yield* Ref.get(attempts)).toBe(1)

          yield* TestClock.adjust(1_999)
          yield* Effect.yieldNow
          expect(yield* Ref.get(attempts)).toBe(1)

          yield* TestClock.adjust(1)
          const response = yield* Fiber.join(fiber)

          expect(response.status).toBe(200)
          expect(yield* Ref.get(attempts)).toBe(2)
        }).pipe(
          Effect.provide(
            countedResponsesLayer(attempts, [
              // 只替换失败证据，仍使用真实时钟/请求数断言验证503、403和429的同一退避入口。
              new Response(status === 403 ? "<html>challenge</html>" : "busy", {
                status,
                headers: { "retry-after": "2", server: "cloudflare", "cf-ray": "test", "cf-mitigated": "challenge" },
              }),
              new Response("ok", { status: 200 }),
            ]),
          ),
        )
      }
    }),
  )

  it.effect("uses exponential jittered delay when retry-after is absent", () =>
    Effect.gen(function* () {
      const attempts = yield* Ref.make(0)
      return yield* Effect.gen(function* () {
        const executor = yield* RequestExecutor.Service
        const fiber = yield* executor.execute(request).pipe(Effect.flip, Effect.forkChild)

        yield* Effect.yieldNow
        expect(yield* Ref.get(attempts)).toBe(1)

        yield* TestClock.adjust(499)
        yield* Effect.yieldNow
        expect(yield* Ref.get(attempts)).toBe(1)

        yield* TestClock.adjust(1)
        yield* Effect.yieldNow
        expect(yield* Ref.get(attempts)).toBe(2)

        yield* TestClock.adjust(999)
        yield* Effect.yieldNow
        expect(yield* Ref.get(attempts)).toBe(2)

        yield* TestClock.adjust(1)
        const error = yield* Fiber.join(fiber)

        expectLLMError(error)
        expect(error.reason).toMatchObject({ _tag: "ProviderInternal" })
        expect(yield* Ref.get(attempts)).toBe(3)
      }).pipe(
        Effect.provide(
          countedResponsesLayer(attempts, [
            new Response("busy", { status: 503 }),
            new Response("still busy", { status: 503 }),
            new Response("done retrying", { status: 503 }),
          ]),
        ),
      )
    }).pipe(Effect.provideService(Random.Random, randomMidpoint)),
  )

  it.live("retries response-body transport failure before the first provider frame", () =>
    Effect.gen(function* () {
      const attempts = yield* Ref.make(0)
      const model = OpenAIChat.route
        .with({ endpoint: { baseURL: "https://api.openai.test/v1" } })
        .model({ id: "gpt-4o-mini" })
      const response = yield* LLMClient.generate(LLM.request({ model, prompt: "Say hello." })).pipe(
        Effect.provide(
          dynamicResponse((input) =>
            Effect.gen(function* () {
              const attempt = yield* Ref.getAndUpdate(attempts, (value) => value + 1)
              if (attempt === 0)
                return input.respond(
                  new ReadableStream({
                    start(controller) {
                      controller.error(Object.assign(new Error("SSE read timed out"), { code: "SSE_READ_TIMEOUT" }))
                    },
                  }),
                  { headers: { "content-type": "text/event-stream" } },
                )
              return input.respond(
                sseRaw(
                  `data: ${JSON.stringify(deltaChunk({ role: "assistant", content: "Hello" }))}`,
                  `data: ${JSON.stringify(deltaChunk({}, "stop"))}`,
                  "data: [DONE]",
                ),
                { headers: { "content-type": "text/event-stream" } },
              )
            }),
          ),
        ),
      )
      // 真实协议成功收口且只重取一次，不在Session层另开provider turn。
      expect(response.events.some((event) => event.type === "finish")).toBe(true)
      expect(yield* Ref.get(attempts)).toBe(2)
    }),
  )

  it.live("bounds response-body retries and preserves their transport classification", () =>
    Effect.gen(function* () {
      const attempts = yield* Ref.make(0)
      const model = OpenAIChat.route
        .with({ endpoint: { baseURL: "https://api.openai.test/v1" } })
        .model({ id: "gpt-4o-mini" })
      const error = yield* LLMClient.generate(LLM.request({ model, prompt: "Say hello." })).pipe(
        Effect.provide(
          dynamicResponse((input) =>
            Ref.update(attempts, (value) => value + 1).pipe(
              Effect.as(
                input.respond(
                  new ReadableStream({
                    start(controller) {
                      controller.error(new Error("connection reset"))
                    },
                  }),
                  { headers: { "content-type": "text/event-stream" } },
                ),
              ),
            ),
          ),
        ),
        Effect.flip,
      )
      // 耗尽仍是真实失败，不伪造完成结果，也不无限重连。
      expectLLMError(error)
      expect(error.reason).toMatchObject({ _tag: "Transport" })
      expect(yield* Ref.get(attempts)).toBe(3)
    }),
  )

  it.effect("enforces raw HTTP progress deadlines without changing cancellation or explicit false", () =>
    Effect.gen(function* () {
      const encoder = new TextEncoder()
      const model = OpenAIChat.route
        .with({ endpoint: { baseURL: "https://api.openai.test/v1" }, http: { chunkTimeout: 50 } })
        .model({ id: "gpt-4o-mini" })
      for (const phase of ["headers", "body", "headers-and-body", "heartbeat", "disabled", "cancel"] as const) {
        const ready = yield* Deferred.make<void>()
        const reading = Promise.withResolvers<void>()
        const controller = Promise.withResolvers<ReadableStreamDefaultController<Uint8Array>>()
        let cancelled = false
        const body = () =>
          new ReadableStream<Uint8Array>(
            {
              start(value) {
                controller.resolve(value)
              },
              pull() {
                reading.resolve()
              },
              cancel() {
                cancelled = true
              },
            },
            { highWaterMark: 0 },
          )
        const fiber = yield* LLMClient.generate(
          LLM.request({
            model,
            prompt: "Hello",
            http: phase === "disabled" ? { chunkTimeout: false } : undefined,
          }),
        ).pipe(
          Effect.provide(
            dynamicResponse((input) =>
              Effect.gen(function* () {
                const init = yield* Effect.serviceOption(FetchHttpClient.RequestInit)
                expect(init).toMatchObject({ value: { cache: "no-store", timeout: false } })
                yield* Deferred.succeed(ready, undefined)
                if (phase === "headers")
                  return yield* Effect.never.pipe(
                    Effect.ensuring(
                      Effect.sync(() => {
                        cancelled = true
                      }),
                    ),
                  )
                if (phase === "disabled" || phase === "headers-and-body")
                  yield* Effect.sleep(phase === "disabled" ? 200 : 30)
                return input.respond(body(), { headers: { "content-type": "text/event-stream" } })
              }),
            ),
          ),
          Effect.provideService(FetchHttpClient.RequestInit, { cache: "no-store" }),
          Effect.match({ onFailure: (error) => ({ error }), onSuccess: (response) => ({ response }) }),
          Effect.forkChild,
        )
        yield* Deferred.await(ready)
        if (phase === "headers-and-body") yield* TestClock.adjust(30)
        if (phase === "headers" || phase === "body" || phase === "headers-and-body") {
          if (phase !== "headers") yield* Effect.promise(() => reading.promise)
          // 首次拉取包含 headers，后续 body 停滞同样给出 typed transport error 并释放 reader。
          yield* TestClock.adjust(phase === "headers-and-body" ? 21 : 51)
          // 未交付frame前仍遵循原有两次有限重试；每次新响应使用独立reader，不能回读已取消body。
          for (const delay of [500, 1000]) yield* TestClock.adjust(delay + 51)
          expect(yield* Fiber.join(fiber)).toMatchObject({
            error: { reason: { _tag: "Transport", kind: "timeout", message: "SSE read timed out" } },
          })
          expect(cancelled).toBe(true)
          continue
        }
        if (phase === "disabled") yield* TestClock.adjust(200)
        yield* Effect.promise(() => reading.promise)
        if (phase === "cancel") {
          yield* Fiber.interrupt(fiber)
          // 取消后的完整窗口不应继续运行期限，也不能遗留一个等待中的原始读取。
          yield* TestClock.adjust(100)
          expect(cancelled).toBe(true)
          continue
        }
        const output = yield* Effect.promise(() => controller.promise)
        if (phase === "heartbeat") {
          // 总等待八十毫秒超过五十毫秒窗口；只有 raw 心跳重置才能完成，semantic event 不足以证明。
          for (let index = 0; index < 4; index++) {
            yield* TestClock.adjust(20)
            output.enqueue(encoder.encode(": heartbeat\n\n"))
            yield* Effect.yieldNow
          }
        }
        output.enqueue(
          encoder.encode(
            sseRaw(
              `data: ${JSON.stringify(deltaChunk({ role: "assistant", content: "Hello" }, "stop"))}`,
              "data: [DONE]",
            ),
          ),
        )
        output.close()
        expect(yield* Fiber.join(fiber)).toMatchObject({ response: { text: "Hello" } })
        // 正常 EOF 同样收尾；继续推进时钟不会把已完成请求变成超时失败。
        yield* TestClock.adjust(100)
        expect(cancelled).toBe(false)
      }
    }),
  )

  it.effect("does not retry after a successful response reaches stream parsing", () =>
    Effect.gen(function* () {
      const attempts = yield* Ref.make(0)
      const model = OpenAIChat.route
        .with({ endpoint: { baseURL: "https://api.openai.test/v1" } })
        .model({ id: "gpt-4o-mini" })
      const error = yield* LLMClient.generate(LLM.request({ model, prompt: "Say hello." })).pipe(
        Effect.provide(
          dynamicResponse((input) =>
            Ref.update(attempts, (value) => value + 1).pipe(
              Effect.as(
                input.respond(
                  sseRaw(
                    `data: ${JSON.stringify(deltaChunk({ role: "assistant", content: "Hello" }))}`,
                    "data: not-json",
                  ),
                  { headers: { "content-type": "text/event-stream" } },
                ),
              ),
            ),
          ),
        ),
        Effect.flip,
      )

      expectLLMError(error)
      expect(error.reason).toMatchObject({ _tag: "InvalidProviderOutput" })
      expect(yield* Ref.get(attempts)).toBe(1)
      const encoder = new TextEncoder()
      // 无timing元数据的真实HTTP body也需空闲失败，不能只测试日志或解析后的frame。
      for (const chunkTimeout of [undefined, 50, false] as const) {
        const raw = yield* Queue.unbounded<Uint8Array, Cause.Done>()
        const consumed = yield* Queue.unbounded<void>()
        const ready = yield* Deferred.make<void>()
        const state = { ended: false, cancelled: false, attempts: 0 }
        const body = yield* Stream.fromQueue(raw).pipe(
          Stream.tap(() => Queue.offer(consumed, undefined)),
          Stream.ensuring(
            Effect.sync(() => {
              state.cancelled = true
            }),
          ),
          (stream) => Stream.toReadableStreamEffect(stream),
        )
        const native = LLM.request({ model, prompt: "idle", http: { chunkTimeout } })
        const response = HttpClientResponse.fromWeb(
          request,
          new Response(body, { headers: { "content-type": "text/event-stream" } }),
        )
        const running = yield* HttpTransport.sseJson
          .with<unknown>()
          .frames({ request, framing: Framing.sse }, native, {
            http: {
              execute: () =>
                Effect.sync(() => {
                  state.attempts++
                  return response
                }),
            },
          })
          .pipe(
            Stream.tap(() => Deferred.succeed(ready, undefined)),
            Stream.runDrain,
            Effect.exit,
            Effect.ensuring(
              Effect.sync(() => {
                state.ended = true
              }),
            ),
            Effect.forkChild,
          )
        yield* Queue.offer(raw, encoder.encode("data: ready\n\n"))
        yield* Deferred.await(ready)
        yield* Queue.take(consumed)
        const window = chunkTimeout === false ? 180_000 : (chunkTimeout ?? 180_000)
        yield* TestClock.adjust(window - 1)
        expect(state.ended).toBe(false)
        // 注释没有provider frame，仍必须重置唯一原始字节期限。
        yield* Queue.offer(raw, encoder.encode(": heartbeat\n\n"))
        yield* Queue.take(consumed)
        yield* Effect.yieldNow
        yield* TestClock.adjust(window - 1)
        expect(state.ended).toBe(false)
        if (chunkTimeout === false) {
          yield* Fiber.interrupt(running)
        } else {
          yield* TestClock.adjust(1)
          const exit = yield* Fiber.join(running)
          expect(Exit.isFailure(exit)).toBe(true)
          if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toMatchObject({ reason: { _tag: "Transport" } })
        }
        expect(state.attempts).toBe(1)
        expect(state.cancelled).toBe(true)
      }
    }),
  )

  it.live("correlates native fetch and raw SSE timing without exposing payload or changing cancellation", () =>
    Effect.suspend(() => {
      const logs: Record<string, unknown>[] = []
      const all: Record<string, unknown>[] = []
      let firstRaw: (() => void) | undefined
      const logger = Logger.make((options) => {
        for (const value of Array.isArray(options.message) ? options.message : [options.message]) {
          if (!value || typeof value !== "object" || !("phase" in value)) continue
          const entry = { ...options.fiber.getRef(References.CurrentLogAnnotations), ...value }
          logs.push(entry)
          all.push(entry)
          if (value.phase === "sse.first_chunk") firstRaw?.()
        }
      })
      return Effect.gen(function* () {
        const encoder = new TextEncoder()
        const native = LLM.request({ model: OpenAIChat.route.model({ id: "timed-native" }), prompt: "PRIVATE_PAYLOAD" })
        const prepared = {
          request: request.pipe(
            HttpClientRequest.bodyText("PRIVATE_PAYLOAD"),
            HttpClientRequest.setHeader("x-session-affinity", "ses_timing"),
          ),
          framing: Framing.sse,
        }
        const collect = (responses: Response[]) =>
          Effect.gen(function* () {
            const executor = yield* RequestExecutor.Service
            return yield* HttpTransport.sseJson
              .with<unknown>()
              .frames(prepared, native, { http: executor })
              .pipe(Stream.runCollect)
          }).pipe(Effect.provide(responsesLayer(responses)), Effect.scoped)
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(": heartbeat\n\n"))
            controller.enqueue(encoder.encode("data: ok\n\n"))
            controller.close()
          },
        })
        expect(yield* collect([new Response(body, { headers: { "content-type": "text/event-stream" } })])).toEqual([
          "ok",
        ])
        expect(logs.map((entry) => entry.phase)).toEqual([
          "fetch.start",
          "fetch.response",
          "sse.first_chunk",
          "sse.end",
        ])
        expect(new Set(logs.map((entry) => entry.requestID)).size).toBe(1)
        expect(logs[0]).toMatchObject({
          method: "POST",
          service: "provider.fetch",
          providerID: native.model.provider,
          modelID: "timed-native",
          sessionID: "ses_timing",
          bodyBytes: 15,
        })
        expect(logs.at(-1)).toMatchObject({
          chunkCount: 2,
          bytes: encoder.encode(": heartbeat\n\ndata: ok\n\n").byteLength,
        })
        // 状态失败也必须先记录真实响应，不能把HTTP错误当成尚未收到响应头。
        logs.length = 0
        const denied = yield* collect([new Response("PRIVATE_RESPONSE", { status: 400 })]).pipe(Effect.exit)
        expect(denied._tag).toBe("Failure")
        expect(logs.map((entry) => entry.phase)).toEqual(["fetch.start", "fetch.response"])
        logs.length = 0
        const failedHTTP = RequestExecutor.layer.pipe(
          Layer.provide(
            Layer.succeed(
              HttpClient.HttpClient,
              HttpClient.make((request) =>
                Effect.fail(
                  new HttpClientError.HttpClientError({
                    reason: new HttpClientError.TransportError({
                      request,
                      cause: new Error("PRIVATE_TRANSPORT_ERROR"),
                    }),
                  }),
                ),
              ),
            ),
          ),
        )
        const failed = yield* Effect.gen(function* () {
          const executor = yield* RequestExecutor.Service
          return yield* executor.execute(prepared.request)
        }).pipe(Effect.provide(failedHTTP), Effect.exit)
        expect(failed._tag).toBe("Failure")
        expect(logs.map((entry) => entry.phase)).toEqual(
          Array.from({ length: 3 }, () => ["fetch.start", "fetch.error"]).flat(),
        )
        expect(new Set(logs.map((entry) => entry.requestID)).size).toBe(3)
        // 已有typed timeout与普通读错误保持失败，不额外设置计时器或重放已交付frame。
        for (const timeout of [false, true]) {
          logs.length = 0
          let pulls = 0
          const broken = new ReadableStream<Uint8Array>({
            pull(controller) {
              if (pulls++ === 0) {
                controller.enqueue(encoder.encode(": heartbeat\n\ndata: ok\n\n"))
                return
              }
              controller.error(timeout ? new Cause.TimeoutError() : new Error("PRIVATE_BODY_ERROR"))
            },
          })
          const exit = yield* collect([
            new Response(broken, { headers: { "content-type": "text/event-stream" } }),
          ]).pipe(Effect.exit)
          expect(exit._tag).toBe("Failure")
          expect(logs.map((entry) => entry.phase)).toEqual([
            "fetch.start",
            "fetch.response",
            "sse.first_chunk",
            timeout ? "sse.timeout" : "sse.error",
          ])
          expect(new Set(logs.map((entry) => entry.requestID)).size).toBe(1)
          expect(JSON.stringify(logs)).not.toContain("PRIVATE_BODY_ERROR")
        }
        logs.length = 0
        const ready = Promise.withResolvers<void>()
        firstRaw = () => ready.resolve()
        const stalled = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(": heartbeat\n\n"))
          },
        })
        const pending = yield* collect([
          new Response(stalled, { headers: { "content-type": "text/event-stream" } }),
        ]).pipe(Effect.forkScoped)
        yield* Effect.promise(() => ready.promise)
        yield* Fiber.interrupt(pending)
        expect(logs.map((entry) => entry.phase)).toEqual(["fetch.start", "fetch.response", "sse.first_chunk"])
        // 所有阶段均只输出计数/分类；不能把error.message、请求URL或正文送入日志。
        expect(JSON.stringify(all)).not.toContain("PRIVATE_")
        expect(JSON.stringify(all)).not.toContain("secret")
        expect(JSON.stringify(all)).not.toContain("heartbeat")
      }).pipe(Effect.provideService(Logger.CurrentLoggers, new Set([logger])))
    }),
  )
})
