export * as Image from "./image"

import { makeLocationNode } from "./effect/app-node"
import { Context, Effect, Layer, Schema } from "effect"
import { Config } from "./config"
import { FileSystem } from "./filesystem"
import { hasPngHeader, hasValidBmpHeader, isBmp, isPng } from "./image/header"

export class ResizerUnavailableError extends Schema.TaggedErrorClass<ResizerUnavailableError>()(
  "Image.ResizerUnavailableError",
  {},
) {}

export class DecodeError extends Schema.TaggedErrorClass<DecodeError>()("Image.DecodeError", {
  resource: Schema.String,
}) {
  override get message() {
    return `Image could not be decoded: ${this.resource}`
  }
}

export class SizeError extends Schema.TaggedErrorClass<SizeError>()("Image.SizeError", {
  resource: Schema.String,
  width: Schema.Number,
  height: Schema.Number,
  bytes: Schema.Number,
  maxWidth: Schema.Number,
  maxHeight: Schema.Number,
  maxBytes: Schema.Number,
}) {
  override get message() {
    return `Image ${this.resource} is ${this.width}x${this.height} with base64 size ${this.bytes}, exceeding configured limits ${this.maxWidth}x${this.maxHeight}/${this.maxBytes} bytes`
  }
}

export interface Interface {
  readonly normalize: (
    resource: string,
    content: FileSystem.Content & { readonly encoding: "base64" },
    maxBase64Bytes?: number,
  ) => Effect.Effect<
    FileSystem.Content & { readonly encoding: "base64" },
    ResizerUnavailableError | DecodeError | SizeError
  >
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Image") {}

// 离线维护显式提供空配置复用同一生产策略，不装配Location或应用运行时。
export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const loadAdapter = yield* Effect.cached(
      Effect.tryPromise({
        try: () => import("./image/photon"),
        catch: () => new ResizerUnavailableError(),
      }).pipe(Effect.flatMap((adapter) => adapter.make)),
    )
    const loadSharpAdapter = yield* Effect.cached(
      Effect.tryPromise({
        try: () => import("./image/sharp"),
        catch: () => new ResizerUnavailableError(),
      }).pipe(Effect.flatMap((adapter) => adapter.make)),
    )
    const normalize = Effect.fn("Image.normalize")(function* (
      resource: string,
      content: FileSystem.Content & { readonly encoding: "base64" },
      maxBase64Bytes = Infinity,
    ) {
      const image = Object.assign(
        {},
        ...(yield* config.entries()).flatMap((entry) =>
          entry.type === "document" && entry.info.attachments?.image ? [entry.info.attachments.image] : [],
        ),
      )
      const buffer = Buffer.from(content.content, "base64")
      // 与V1同一header合同；错误仍使用当前Location/资源的typed Image错误。
      if (buffer.length === 0 || (isPng(buffer) && !hasPngHeader(buffer)) || (isBmp(buffer) && !hasValidBmpHeader(buffer)))
        return yield* new DecodeError({ resource })
      // 互斥格式分支保留BMP WASM能力，其余格式共用generic全页解码。
      const normalize = yield* (isBmp(buffer) ? loadAdapter : loadSharpAdapter)
      return yield* normalize(resource, content, {
        autoResize: image.auto_resize ?? true,
        maxWidth: image.max_width ?? 2_000,
        maxHeight: image.max_height ?? 2_000,
        // Read's budget intersects configuration without changing other callers' limits.
        maxBase64Bytes: Math.min(image.max_base64_bytes ?? 5 * 1024 * 1024, maxBase64Bytes),
      })
    })
    return Service.of({ normalize })
  }),
)

export const locationLayer = layer.pipe(Layer.provide(Config.locationLayer))

export const node = makeLocationNode({ service: Service, layer, deps: [Config.node] })
