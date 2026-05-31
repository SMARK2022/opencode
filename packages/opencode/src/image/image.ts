import { Config } from "@/config/config"
import type { MessageV2 } from "@/session/message-v2"
import * as Log from "@opencode-ai/core/util/log"
import { Context, Effect, Layer, Schema } from "effect"

const MAX_BASE64_BYTES = 5 * 1024 * 1024
const MAX_WIDTH = 2000
const MAX_HEIGHT = 2000
const AUTO_RESIZE = true
// Keep this in sync with token/estimate.ts: image payload budget is estimated from base64 characters.
const TOKEN_ESTIMATE_BASE64_CHARS = 750
const RESIZE_STEPS = 32
const RESIZE_STEP_RATIO = 0.75
const JPEG_QUALITIES = [85, 70, 55, 40]
const log = Log.create({ service: "image" })
type Sharp = typeof import("sharp")
type SharpMetadata = import("sharp").Metadata

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
    input: MessageV2.FilePart,
    options?: {
      readonly tokenBudget?: number
    },
  ) => Effect.Effect<MessageV2.FilePart, Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Image") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const loadSharp = yield* Effect.cached(
      Effect.tryPromise({
        try: async () => {
          const mod = await import("sharp")
          const value: unknown = Reflect.get(mod, "default")
          if (isSharp(value)) return value
          if (isSharp(mod)) return mod
          throw new Error("sharp module did not expose a callable export")
        },
        catch: (error) => {
          log.warn("failed to load sharp", { error })
          return new ResizerUnavailableError()
        },
      }),
    )

    const normalize = Effect.fn("Image.normalize")(function* (
      input: MessageV2.FilePart,
      options?: {
        readonly tokenBudget?: number
      },
    ) {
      const image = (yield* config.get()).attachment?.image
      const info = {
        autoResize: image?.auto_resize ?? AUTO_RESIZE,
        maxWidth: image?.max_width ?? MAX_WIDTH,
        maxHeight: image?.max_height ?? MAX_HEIGHT,
        maxBase64Bytes: targetMaxBase64Bytes(image?.max_base64_bytes ?? MAX_BASE64_BYTES, options),
      }
      if (!input.url.startsWith("data:") || !input.url.includes(";base64,"))
        return yield* new InvalidDataUrlError({ url: input.url })

      const base64 = input.url.slice(input.url.indexOf(";base64,") + ";base64,".length)
      const bytes = Buffer.byteLength(base64, "utf8")
      const buffer = Buffer.from(base64, "base64")
      if (buffer.length === 0) return yield* new DecodeError()

      const sharp = yield* loadSharp
      const metadata = yield* readMetadata(sharp, buffer)
      if (!metadata.width || !metadata.height) return yield* new DecodeError()

      const originalWidth = metadata.width
      const originalHeight = metadata.height
      // Historical session images may be normalized again during replay; metadata-only pass-through avoids lossy rewrites.
      if (originalWidth <= info.maxWidth && originalHeight <= info.maxHeight && bytes <= info.maxBase64Bytes) return input
      if (!info.autoResize)
        return yield* new SizeError({
          bytes,
          max: info.maxBase64Bytes,
          width: originalWidth,
          height: originalHeight,
          max_width: info.maxWidth,
          max_height: info.maxHeight,
        })

      const hasAlpha = Boolean(metadata.hasAlpha)
      const preserveAlpha = hasAlpha && options?.tokenBudget === undefined
      for (const size of resizeSizes(originalWidth, originalHeight, info.maxWidth, info.maxHeight)) {
        const candidate = yield* encodeCandidate(sharp, buffer, size, hasAlpha, preserveAlpha, info.maxBase64Bytes)
        if (candidate) {
          log.info("using resized image", {
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
    })

    return Service.of({ normalize })
  }),
)

function targetMaxBase64Bytes(
  configuredMax: number,
  options?: {
    readonly tokenBudget?: number
  },
) {
  if (options?.tokenBudget === undefined) return configuredMax
  return Math.min(configuredMax, Math.max(0, Math.floor(options.tokenBudget * TOKEN_ESTIMATE_BASE64_CHARS)))
}

function isSharp(value: unknown): value is Sharp {
  return typeof value === "function"
}

function readMetadata(sharp: Sharp, buffer: Buffer): Effect.Effect<SharpMetadata, DecodeError> {
  return Effect.tryPromise({
    try: () => sharp(buffer).metadata(),
    catch: (error) => {
      log.warn("failed to decode image metadata", { error })
      return new DecodeError()
    },
  })
}

function resizeSizes(originalWidth: number, originalHeight: number, maxWidth: number, maxHeight: number) {
  const scale = Math.min(1, maxWidth / originalWidth, maxHeight / originalHeight)
  return Array.from({ length: RESIZE_STEPS }).reduce<Array<{ width: number; height: number }>>((acc) => {
    const previous = acc.at(-1) ?? {
      width: Math.max(1, Math.round(originalWidth * scale)),
      height: Math.max(1, Math.round(originalHeight * scale)),
    }
    const next =
      acc.length === 0
        ? previous
        : {
            width: previous.width === 1 ? 1 : Math.max(1, Math.floor(previous.width * RESIZE_STEP_RATIO)),
            height: previous.height === 1 ? 1 : Math.max(1, Math.floor(previous.height * RESIZE_STEP_RATIO)),
          }
    return acc.some((item) => item.width === next.width && item.height === next.height) ? acc : [...acc, next]
  }, [])
}

function encodeCandidate(
  sharp: Sharp,
  buffer: Buffer,
  size: { width: number; height: number },
  hasAlpha: boolean,
  preserveAlpha: boolean,
  maxBase64Bytes: number,
) {
  return Effect.tryPromise({
    try: async () => {
      const resized = sharp(buffer).rotate().resize(size.width, size.height, {
        fit: "inside",
        withoutEnlargement: true,
      })
      if (preserveAlpha) {
        const encoded = (await resized.clone().png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer()).toString(
          "base64",
        )
        if (Buffer.byteLength(encoded, "utf8") <= maxBase64Bytes) return { data: encoded, mime: "image/png" }
      }

      for (const quality of JPEG_QUALITIES) {
        // Transparent inputs prefer PNG above unless a strict token budget makes bounded latency more important.
        const encoded = (await (hasAlpha ? resized.clone().flatten({ background: "#ffffff" }) : resized.clone())
          .jpeg({ quality })
          .toBuffer()).toString("base64")
        if (Buffer.byteLength(encoded, "utf8") <= maxBase64Bytes) return { data: encoded, mime: "image/jpeg" }
      }

      return undefined
    },
    catch: (error) => {
      log.warn("failed to resize image", { error })
      return new DecodeError()
    },
  })
}

export const defaultLayer = layer.pipe(Layer.provide(Config.defaultLayer))

export * as Image from "./image"
