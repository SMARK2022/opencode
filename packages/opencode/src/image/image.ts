import { Image } from "@opencode-ai/core/image"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Config } from "@/config/config"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import photonWasm from "@silvia-odwyer/photon-node/photon_rs_bg.wasm" with { type: "file" }
import { Context, Effect, Layer, Schema } from "effect"
import path from "node:path"
import { fileURLToPath } from "node:url"

const MAX_BASE64_BYTES = 5 * 1024 * 1024
const MAX_WIDTH = 2000
const MAX_HEIGHT = 2000
const AUTO_RESIZE = true
const JPEG_QUALITIES = [80, 85, 70, 55, 40]
// #277：token 估算以 base64 字符为单位，常数必须与 token/estimate.ts 的图片估算保持一致
const TOKEN_ESTIMATE_BASE64_CHARS = 750
export class ResizerUnavailableError extends Schema.TaggedErrorClass<ResizerUnavailableError>()(
  "ImageResizerUnavailableError",
  {},
) {
  override get message() {
    return "Image resizer is unavailable"
  }
}

export class InvalidDataUrlError extends Schema.TaggedErrorClass<InvalidDataUrlError>()("ImageInvalidDataUrlError", {
  url: Schema.String,
}) {
  override get message() {
    return "Image URL must be a base64 data URL"
  }
}

export class DecodeError extends Schema.TaggedErrorClass<DecodeError>()("ImageDecodeError", {}) {
  override get message() {
    return "Image could not be decoded"
  }
}

export class SizeError extends Schema.TaggedErrorClass<SizeError>()("ImageSizeError", {
  bytes: Schema.Number,
  max: Schema.Number,
  width: Schema.Number,
  height: Schema.Number,
  max_width: Schema.Number,
  max_height: Schema.Number,
}) {
  override get message() {
    return `Image ${this.width}x${this.height} with base64 size ${this.bytes} exceeds configured limits and could not be resized below ${this.max_width}x${this.max_height}/${this.max} bytes`
  }
}

export type Error = ResizerUnavailableError | InvalidDataUrlError | DecodeError | SizeError

export interface Interface {
  readonly normalize: (
    input: SessionV1.FilePart,
    // #277：调用方可传入更小的 token budget，在不放宽配置上限的前提下收紧单图 base64 上限
    options?: {
      readonly tokenBudget?: number
    },
  ) => Effect.Effect<SessionV1.FilePart, Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Image") {}

// #485：导出 layer 供离线维护脚本（script/migrate-image-attachment.ts）复用生产 normalize 链
export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const loadSharp = yield* Effect.cached(
      Effect.tryPromise({
        try: () => import("@opencode-ai/core/image/sharp"),
        catch: () => new Image.ResizerUnavailableError(),
      }).pipe(Effect.flatMap((adapter) => adapter.make)),
    )
    const loadPhoton = yield* Effect.cached(
      Effect.sync(() => {
        // Patched photon-node reads this during module init so Bun compiled binaries use the embedded wasm path.
        ;(globalThis as typeof globalThis & { __OPENCODE_PHOTON_WASM_PATH?: string }).__OPENCODE_PHOTON_WASM_PATH =
          path.isAbsolute(photonWasm) ? photonWasm : fileURLToPath(new URL(photonWasm, import.meta.url))
      }).pipe(
        Effect.andThen(() => Effect.tryPromise(() => import("@silvia-odwyer/photon-node"))),
        Effect.tapError((error) => Effect.logWarning("failed to load photon", { error })),
        Effect.mapError(() => new ResizerUnavailableError()),
      ),
    )

    const normalize = Effect.fn("Image.normalize")(function* (
      input: SessionV1.FilePart,
      options?: {
        readonly tokenBudget?: number
      },
    ) {
      const image = (yield* config.get()).attachment?.image
      const info = {
        autoResize: image?.auto_resize ?? AUTO_RESIZE,
        maxWidth: image?.max_width ?? MAX_WIDTH,
        maxHeight: image?.max_height ?? MAX_HEIGHT,
        // #277：默认尺寸内的大图在调用方收紧预算后仍会进入压缩，避免绕过模型 token 上限
        maxBase64Bytes: targetMaxBase64Bytes(image?.max_base64_bytes ?? MAX_BASE64_BYTES, options),
      }
      if (!input.url.startsWith("data:") || !input.url.includes(";base64,"))
        return yield* new InvalidDataUrlError({ url: input.url })

      const base64 = input.url.slice(input.url.indexOf(";base64,") + ";base64,".length)
      const bytes = Buffer.byteLength(base64, "utf8")

      const supported = ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(input.mime)
      if (["image/tiff", "image/avif", "image/heif", "image/heic"].includes(input.mime)) {
        const content = yield* loadSharp.pipe(
          Effect.flatMap((normalize) =>
            normalize(
              input.filename ?? input.id,
              { uri: input.url, content: base64, encoding: "base64", mime: input.mime },
              info,
            ),
          ),
          // 保留加载、解码和尺寸三类错误，既有调用方仍决定 resizer 不可用时的回退。
          Effect.mapError((error) =>
            error instanceof Image.SizeError
              ? new SizeError({
                  bytes: error.bytes,
                  max: error.maxBytes,
                  width: error.width,
                  height: error.height,
                  max_width: error.maxWidth,
                  max_height: error.maxHeight,
                })
              : error instanceof Image.ResizerUnavailableError
                ? new ResizerUnavailableError()
                : new DecodeError(),
          ),
        )
        return {
          ...input,
          mime: content.mime,
          url: `data:${content.mime};base64,${content.content}`,
        }
      }

      const photon = yield* loadPhoton

      const decoded = yield* Effect.try({
        try: () => photon.PhotonImage.new_from_byteslice(Buffer.from(base64, "base64")),
        catch: () => new DecodeError(),
      }).pipe(Effect.tapError((error) => Effect.logWarning("failed to decode image", { error })))

      try {
        const originalWidth = decoded.get_width()
        const originalHeight = decoded.get_height()
        const withinLimits =
          originalWidth <= info.maxWidth && originalHeight <= info.maxHeight && bytes <= info.maxBase64Bytes
        // BMP 即使未超限也须转成 PNG/JPEG；禁用缩放不禁止等尺寸转码。
        if (withinLimits && supported) return input
        if (!info.autoResize && !withinLimits)
          return yield* new SizeError({
            bytes,
            max: info.maxBase64Bytes,
            width: originalWidth,
            height: originalHeight,
            max_width: info.maxWidth,
            max_height: info.maxHeight,
          })

        const scale = Math.min(1, info.maxWidth / originalWidth, info.maxHeight / originalHeight)
        for (const size of Array.from({ length: info.autoResize ? 32 : 1 }).reduce<Array<{ width: number; height: number }>>((acc) => {
          const previous = acc.at(-1) ?? {
            width: Math.max(1, Math.round(originalWidth * scale)),
            height: Math.max(1, Math.round(originalHeight * scale)),
          }
          const next =
            acc.length === 0
              ? previous
              : {
                  width: previous.width === 1 ? 1 : Math.max(1, Math.floor(previous.width * 0.75)),
                  height: previous.height === 1 ? 1 : Math.max(1, Math.floor(previous.height * 0.75)),
                }
          return acc.some((item) => item.width === next.width && item.height === next.height) ? acc : [...acc, next]
        }, [])) {
          const resized = photon.resize(decoded, size.width, size.height, photon.SamplingFilter.Lanczos3)
          const candidate = [
            { data: Buffer.from(resized.get_bytes()).toString("base64"), mime: "image/png" },
            ...JPEG_QUALITIES.map((quality) => ({
              data: Buffer.from(resized.get_bytes_jpeg(quality)).toString("base64"),
              mime: "image/jpeg",
            })),
          ]
            .map((item) => ({ ...item, bytes: Buffer.byteLength(item.data, "utf8") }))
            .find((item) => item.bytes <= info.maxBase64Bytes)
          resized.free()

          if (candidate) {
            yield* Effect.logInfo("using resized image", {
              from_mime: input.mime,
              to_mime: candidate.mime,
              from: `${originalWidth}x${originalHeight}`,
              to: `${size.width}x${size.height}`,
            })
            return {
              ...input,
              mime: candidate.mime,
              url: `data:${candidate.mime};base64,${candidate.data}`,
            }
          }
        }

        return yield* new SizeError({
          bytes,
          max: info.maxBase64Bytes,
          width: originalWidth,
          height: originalHeight,
          max_width: info.maxWidth,
          max_height: info.maxHeight,
        })
      } finally {
        decoded.free()
      }
    })

    return Service.of({ normalize })
  }),
)

export const node = LayerNode.make({ service: Service, layer: layer, deps: [Config.node] })

// #277：配置上限与调用方预算取小值，budget 未提供时保持既有配置语义
function targetMaxBase64Bytes(
  configuredMax: number,
  options?: {
    readonly tokenBudget?: number
  },
) {
  if (options?.tokenBudget === undefined) return configuredMax
  return Math.min(configuredMax, Math.max(0, Math.floor(options.tokenBudget * TOKEN_ESTIMATE_BASE64_CHARS)))
}

export * as Image from "./image"
