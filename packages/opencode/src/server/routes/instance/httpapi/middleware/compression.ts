import { deflate, gzip } from "node:zlib"
import { promisify } from "node:util"
import { Effect, Stream } from "effect"
import { HttpBody, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"

// Keep the server's compressible content-type set stable across HTTP backend changes.
const COMPRESSIBLE_CONTENT_TYPE_REGEX =
  /^\s*(?:text\/(?!event-stream(?:[;\s]|$))[^;\s]+|application\/(?:javascript|json|xml|xml-dtd|ecmascript|dart|postscript|rtf|tar|toml|vnd\.dart|vnd\.ms-fontobject|vnd\.ms-opentype|wasm|x-httpd-php|x-javascript|x-ns-proxy-autoconfig|x-sh|x-tar|x-www-form-urlencoded)|font\/(?:otf|ttf)|image\/(?:bmp|vnd\.adobe\.photoshop|vnd\.microsoft\.icon|vnd\.ms-dds|x-icon|x-ms-bmp)|message\/rfc822|model\/gltf-binary|x-shader\/x-fragment|x-shader\/x-vertex|[^;\s]+?\+(?:json|text|xml|yaml))(?:[;\s]|$)/i

const NO_TRANSFORM_REGEX = /(?:^|,)\s*?no-transform\s*?(?:,|$)/i

const STREAMING_PATHS = new Set(["/event", "/global/event", "/api/event"])
const STREAMING_POST_REGEX = /^\/session\/[^/]+\/(?:message|prompt_async)$/

const THRESHOLD_BYTES = 1024
const gzipAsync = promisify(gzip)
const deflateAsync = promisify(deflate)

type Encoding = "gzip" | "deflate"

function pickEncoding(acceptEncoding: string | undefined): Encoding | undefined {
  if (!acceptEncoding) return undefined
  const lower = acceptEncoding.toLowerCase()
  if (lower.includes("gzip")) return "gzip"
  if (lower.includes("deflate")) return "deflate"
  return undefined
}

function pathOf(url: string): string {
  const queryIndex = url.indexOf("?")
  return queryIndex === -1 ? url : url.slice(0, queryIndex)
}

export const compressionLayer = HttpRouter.middleware<{ handles: unknown }>()((effect) =>
  Effect.gen(function* () {
    const response = yield* effect
    const request = yield* HttpServerRequest.HttpServerRequest

    if (request.method === "HEAD") return response
    if (response.headers["content-encoding"]) return response

    const body = response.body
    if (body._tag !== "Uint8Array" && body._tag !== "Stream") return response
    if (body._tag === "Uint8Array" && response.headers["transfer-encoding"]) return response
    if (body._tag === "Uint8Array" && body.body.byteLength < THRESHOLD_BYTES) return response

    const cacheControl = response.headers["cache-control"]
    if (cacheControl && NO_TRANSFORM_REGEX.test(cacheControl)) return response

    const path = pathOf(request.url)
    if (STREAMING_PATHS.has(path)) return response
    if (request.method === "POST" && STREAMING_POST_REGEX.test(path)) return response

    const contentType = body.contentType
    if (!COMPRESSIBLE_CONTENT_TYPE_REGEX.test(contentType)) return response

    const encoding = pickEncoding(request.headers["accept-encoding"])
    if (!encoding) return response

    const headers = {
      ...Object.fromEntries(Object.entries(response.headers).filter(([key]) => key.toLowerCase() !== "content-length")),
      "content-encoding": encoding,
    }
    if (body._tag === "Stream") {
      // 保留当前请求的 Context/FiberRef；CompressionStream 在流上压缩，不把正文聚合成主线程大 Buffer。
      const compressed = Stream.unwrap(
        Effect.gen(function* () {
          const readable = yield* Stream.toReadableStreamEffect(
            Stream.map(body.stream, (chunk) =>
              chunk.buffer instanceof ArrayBuffer
                ? new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)
                : new Uint8Array(chunk),
            ),
          )
          return Stream.fromReadableStream({
            evaluate: () => readable.pipeThrough(new CompressionStream(encoding)),
            onError: (error) => error,
          })
        }),
      )
      return HttpServerResponse.stream(compressed, {
        status: response.status,
        statusText: response.statusText,
        cookies: response.cookies,
        contentType,
        headers,
      })
    }
    // zlib 在线程池压缩大响应，主线程可以继续处理 health、SSE 和其他短请求。
    const compressed = yield* Effect.promise(() =>
      encoding === "gzip" ? gzipAsync(body.body) : deflateAsync(body.body),
    )
    return response.pipe(
      HttpServerResponse.setBody(HttpBody.uint8Array(compressed, contentType)),
      HttpServerResponse.setHeader("content-encoding", encoding),
    )
  }),
).layer
