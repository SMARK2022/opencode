import { Cause, Clock, Effect, Option, Schedule, Stream } from "effect"
import { FetchHttpClient, Headers, HttpClientRequest, type HttpClientResponse } from "effect/unstable/http"
import { FetchTiming } from "../http-timing"
import { Auth } from "../auth"
import { render as renderEndpoint } from "../endpoint"
import { Framing, type Framing as FramingDef } from "../framing"
import type { Transport, TransportPrepareInput } from "./index"
import * as ProviderShared from "../../protocols/shared"
import { LLMError, TransportReason, mergeJsonRecords, type LLMRequest } from "../../schema"

const progressTimeout = () =>
  new LLMError({
    module: "HttpTransport",
    method: "frames",
    reason: new TransportReason({ message: "SSE read timed out", kind: "timeout" }),
  })

function observeSSE(response: HttpClientResponse.HttpClientResponse, request: LLMRequest, startedAt: number) {
  const timing = FetchTiming.responses.get(response)
  if (!response.headers["content-type"]?.includes("text/event-stream")) return response.stream
  const chunkTimeout = request.http?.chunkTimeout ?? 180_000
  // 必须在framing前按原始字节计时，心跳/注释也续期，且不依赖是否采集timing。
  const stream =
    chunkTimeout === false
      ? response.stream
      : Stream.transformPull(response.stream, (pull) =>
          Effect.sync(() => {
            let progressedAt = startedAt
            // headers与首块共享dispatch起点；之后每个raw pull成功才续期，不按semantic frame续期。
            return Effect.gen(function* () {
              const remaining = chunkTimeout - ((yield* Clock.currentTimeMillis) - progressedAt)
              const chunk = yield* pull.pipe(
                Effect.timeoutOrElse({
                  duration: Math.max(0, remaining),
                  orElse: () => Effect.fail(progressTimeout()),
                }),
              )
              progressedAt = yield* Clock.currentTimeMillis
              return chunk
            })
          }),
        )
  if (!timing) return stream
  return Stream.unwrap(
    Effect.gen(function* () {
      let lastChunkAt = yield* Clock.currentTimeMillis
      let chunkCount = 0
      let bytes = 0
      let maxGapMs = 0
      const log = (phase: string, extra: Record<string, unknown> = {}) =>
        Clock.currentTimeMillis.pipe(
          Effect.flatMap((now) =>
            Effect.logInfo("timing", {
              phase,
              requestID: timing.requestID,
              elapsedMs: now - timing.startedAt,
              providerID: request.model.provider,
              modelID: request.model.id,
              sessionID:
                response.request.headers["x-session-affinity"] ?? response.request.headers["x-opencode-session"],
              chunkCount,
              bytes,
              maxGapMs,
              idleMs: now - lastChunkAt,
              ...extra,
            }),
          ),
          Effect.annotateLogs({ service: "provider.fetch" }),
        )
      return stream.pipe(
        Stream.tap((chunk) =>
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis
            const gapMs = now - lastChunkAt
            lastChunkAt = now
            chunkCount++
            bytes += chunk.byteLength
            maxGapMs = Math.max(maxGapMs, gapMs)
            // 心跳先计原始首块，191的started仍只在交付协议frame时改变。
            if (chunkCount === 1) yield* log("sse.first_chunk", { gapMs, bytes: chunk.byteLength })
          }),
        ),
        Stream.tapError((error) => {
          const cause = "cause" in error.reason ? error.reason.cause : undefined
          const timeout =
            Cause.isTimeoutError(cause) ||
            (typeof cause === "object" && cause !== null && "code" in cause && cause.code === "SSE_READ_TIMEOUT") ||
            (error instanceof LLMError && error.reason._tag === "Transport" && error.reason.kind === "timeout")
          return log(timeout ? "sse.timeout" : "sse.error", { errorName: error.name, errorKind: error.reason._tag })
        }),
        // 只在原始EOF记end；语义提前结束或取消不额外drain，也不伪报完成。
        Stream.onEnd(log("sse.end")),
      )
    }),
  )
}

export type JsonRequestInput<Body> = TransportPrepareInput<Body>

export interface JsonRequestParts<Body = unknown> {
  readonly url: string
  readonly jsonBody: Body | Record<string, unknown>
  readonly bodyText: string
  readonly headers: Headers.Headers
}

export interface HttpPrepared<Frame> {
  readonly request: HttpClientRequest.HttpClientRequest
  readonly framing: FramingDef<Frame>
}

const applyQuery = (url: string, query: Record<string, string> | undefined) => {
  if (!query) return url
  const next = new URL(url)
  Object.entries(query).forEach(([key, value]) => next.searchParams.set(key, value))
  return next.toString()
}

const PROTOCOL_BODY_OVERLAY_DENYLIST = new Set([
  "content",
  "contents",
  "frequencyPenalty",
  "frequency_penalty",
  "generationConfig",
  "inferenceConfig",
  "input",
  "maxTokens",
  "max_tokens",
  "messages",
  "model",
  "presencePenalty",
  "presence_penalty",
  "responseFormat",
  "response_format",
  "seed",
  "stop",
  "stopSequences",
  "stop_sequences",
  "stream",
  "streamOptions",
  "stream_options",
  "system",
  "systemInstruction",
  "system_instruction",
  "temperature",
  "thinking",
  "toolChoice",
  "toolConfig",
  "tool_choice",
  "tool_config",
  "tools",
  "topK",
  "topP",
  "top_k",
  "top_p",
])

const forbiddenBodyOverlayKeys = (body: Record<string, unknown>) =>
  Object.keys(body).filter((key) => PROTOCOL_BODY_OVERLAY_DENYLIST.has(key))

const bodyWithOverlay = <Body>(body: Body, request: LLMRequest, encodeBody: (body: Body) => string) =>
  Effect.gen(function* () {
    if (request.http?.body === undefined) return { jsonBody: body, bodyText: encodeBody(body) }
    const forbiddenKeys = forbiddenBodyOverlayKeys(request.http.body)
    if (forbiddenKeys.length > 0)
      return yield* ProviderShared.invalidRequest(
        `http.body cannot overlay protocol-owned field(s): ${forbiddenKeys.join(", ")}`,
      )
    if (ProviderShared.isRecord(body)) {
      const overlaid = mergeJsonRecords(body, request.http.body) ?? {}
      return { jsonBody: overlaid, bodyText: ProviderShared.encodeJson(overlaid) }
    }
    return yield* ProviderShared.invalidRequest("http.body can only overlay JSON object request bodies")
  })

export const jsonRequestParts = <Body>(input: JsonRequestInput<Body>) =>
  Effect.gen(function* () {
    const url = applyQuery(
      renderEndpoint(input.endpoint, { request: input.request, body: input.body }).toString(),
      input.request.http?.query,
    )
    const body = yield* bodyWithOverlay(input.body, input.request, input.encodeBody)
    const headers = yield* Auth.toEffect(input.auth)({
      request: input.request,
      method: "POST",
      url,
      body: body.bodyText,
      headers: Headers.fromInput({
        ...input.headers?.({ request: input.request }),
        ...input.request.http?.headers,
      }),
    })
    return { url, jsonBody: body.jsonBody, bodyText: body.bodyText, headers }
  })

export interface HttpJsonInput<_Body, Frame> {
  readonly framing: FramingDef<Frame>
}

export type HttpJsonPatch<Body, Frame> = Partial<HttpJsonInput<Body, Frame>>

export interface HttpJsonTransport<Body, Frame> extends Transport<Body, HttpPrepared<Frame>, Frame> {
  readonly with: (patch: HttpJsonPatch<Body, Frame>) => HttpJsonTransport<Body, Frame>
}

export const httpJson = <Body, Frame>(input: HttpJsonInput<Body, Frame>): HttpJsonTransport<Body, Frame> => ({
  id: "http-json",
  with: (patch) => httpJson({ ...input, ...patch }),
  prepare: (prepareInput) =>
    jsonRequestParts({
      ...prepareInput,
    }).pipe(
      Effect.map((parts) => ({
        request: ProviderShared.jsonPost({ url: parts.url, body: parts.bodyText, headers: parts.headers }),
        framing: input.framing,
      })),
    ),
  frames: (prepared, request, runtime) =>
    Stream.suspend(() => {
      let started = false
      const frames = Stream.unwrap(
        Effect.gen(function* () {
          const startedAt = yield* Clock.currentTimeMillis
          const timeout = request.http?.chunkTimeout ?? 180_000
          const init = yield* Effect.serviceOption(FetchHttpClient.RequestInit)
          // 只覆盖本次运输的Bun idle选项；原fetch配置、取消和有限重试仍归现有owner。
          const transport = { ...Option.getOrElse(init, () => ({})), timeout: false }
          const execute = runtime.http.execute(prepared.request).pipe(
            Effect.annotateLogs({
              providerID: request.model.provider,
              modelID: request.model.id,
              sessionID:
                prepared.request.headers["x-session-affinity"] ?? prepared.request.headers["x-opencode-session"],
            }),
            Effect.provideService(FetchHttpClient.RequestInit, transport),
          )
          const response = yield* timeout === false
            ? execute
            : execute.pipe(Effect.timeoutOrElse({ duration: timeout, orElse: () => Effect.fail(progressTimeout()) }))
          return prepared.framing.frame(
            observeSSE(response, request, startedAt).pipe(
              // 字节读取失败是运输故障；协议/JSON解码仍在原有不可重试分支。
              Stream.mapError((error) =>
                error instanceof LLMError
                  ? error
                  : new LLMError({
                      module: "HttpTransport",
                      method: "frames",
                      reason: new TransportReason({
                        message: `Failed to read ${request.model.provider}/${request.model.route.id} stream: ${ProviderShared.errorText(error)}`,
                        kind: error.reason._tag,
                      }),
                    }),
              ),
            ),
          )
        }),
      )
      return frames.pipe(
        // 已交付的frame可能包含工具副作用，之后绝不自动重放本provider turn。
        Stream.tap(() =>
          Effect.sync(() => {
            started = true
          }),
        ),
        Stream.retry(($) =>
          $(Schedule.exponential(500).pipe(Schedule.take(2))).pipe(
            // 仅重取此处的body故障，不重复包裹executor已耗尽的建连/status重试。
            Schedule.while(
              ({ input }) => !started && input.module === "HttpTransport" && input.reason._tag === "Transport",
            ),
          ),
        ),
      )
    }),
})

export const sseJson = {
  id: "http-json/sse",
  with: <Body>() => httpJson<Body, string>({ framing: Framing.sse }),
} as const
