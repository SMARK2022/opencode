import { Config } from "@/config/config"
import type { MessageV2 } from "@/session/message-v2"
import { Global } from "@opencode-ai/core/global"
import * as Log from "@opencode-ai/core/util/log"
import { Context, Effect, Layer, Schema } from "effect"
import { createHash, randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"

declare const OPENCODE_COMPILED: boolean | undefined

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
type EmbeddedSharp = {
  target: string
  version: string
  addon: string
  files: Record<string, string>
}

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
          // compiled和源码路径只区别Sharp的装载位置，后续metadata/resize/encode始终共用同一Sharp实现。
          // compiled资源准备失败直接映射为ResizerUnavailable，不允许绕过Sharp返回输入附件。
          if (typeof OPENCODE_COMPILED !== "undefined" && OPENCODE_COMPILED) await prepareCompiledSharp()
          const mod = await import("sharp")
          const value: unknown = Reflect.get(mod, "default")
          // Sharp 0.34.5的动态import契约是default callable；其他形状不是可支持的第二后端。
          if (isSharp(value)) return value
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

async function prepareCompiledSharp() {
  // build.ts 同时把虚拟模块放入files/entrypoints；compiled缺失时直接失败，不猜测开发机node_modules位置。
  // @ts-expect-error generated at build time
  const embedded = (await import("opencode-sharp.gen.ts")).default as EmbeddedSharp
  // Sharp版本和target共同隔离cache，升级或切换libc时不能复用ABI不兼容的addon。
  const root = path.join(Global.Path.cache, "native", "sharp", embedded.version, embedded.target)
  // addon加载前必须等待所有DLL/dylib/so完成校验，避免并发看到“node存在但依赖库未就绪”的半状态。
  // Promise并行只影响释放速度；全量完成前不会向官方loader公开addon绝对路径。
  await Promise.all(
    Object.entries(embedded.files).map(([relative, source]) =>
      ensureExtractedNativeFile(source, path.join(root, ...relative.split("/"))),
    ),
  )
  // Sharp 的动态 package require 无法从 bunfs 找到 addon；build plugin 只让官方 loader优先读取该绝对路径。
  // 全局值只承载打包产物确定的路径，不暴露配置入口，也不接受外部覆盖。
  ;(globalThis as typeof globalThis & { __OPENCODE_SHARP_NATIVE_PATH?: string }).__OPENCODE_SHARP_NATIVE_PATH = path.join(
    root,
    ...embedded.addon.split("/"),
  )
}

async function ensureExtractedNativeFile(source: string, target: string) {
  // 已验证文件直接复用；只看存在/大小不足以防止崩溃遗留或同名错误native资源。
  // source来自Bun内嵌只读资源，因此与target内容hash相等即可作为完整提交标志。
  if (await sameFileContent(source, target)) return
  await fs.mkdir(path.dirname(target), { recursive: true })
  const temp = `${target}.tmp-${process.pid}-${randomUUID()}`
  try {
    // 临时文件和目标同目录，使rename保持同卷原子替换语义。
    // PID和UUID避免同进程任务及不同进程之间复用未完成的临时文件。
    await Bun.write(temp, Bun.file(source))
    try {
      await fs.rename(temp, target)
    } catch (error) {
      // Windows会锁住已加载的node/DLL；并发loser只在winner内容完全一致时复用，不能覆盖未知文件。
      // 内容不同则保留原错误，防止用删除或覆盖绕过正在使用的ABI冲突文件。
      if (await sameFileContent(source, target)) return
      throw error
    }
    if (!(await sameFileContent(source, target))) throw new Error(`Extracted Sharp resource failed verification: ${target}`)
  } finally {
    await fs.rm(temp, { force: true }).catch(() => {})
  }
}

async function sameFileContent(source: string, target: string) {
  if (!(await Bun.file(target).exists())) return false
  // 先比较大小避免每次图片请求都无条件hash较大的libvips文件。
  if (Bun.file(source).size !== Bun.file(target).size) return false
  return (await fileDigest(source)) === (await fileDigest(target))
}

async function fileDigest(file: string) {
  return createHash("sha256").update(Buffer.from(await Bun.file(file).arrayBuffer())).digest("hex")
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
