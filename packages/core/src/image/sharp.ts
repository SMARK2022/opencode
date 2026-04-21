export * as CoreImageSharp from "./sharp"

import { Effect } from "effect"
import { FileSystem } from "../filesystem"
import { Image } from "../image"

export const make = Effect.gen(function* () {
  const sharp = yield* Effect.tryPromise({
    try: async () => {
      const module = await import("sharp")
      return module.default
    },
    catch: () => new Image.ResizerUnavailableError(),
  })
  return Effect.fn("Image.Sharp.normalize")(function* (
    resource: string,
    content: FileSystem.Content & { readonly encoding: "base64" },
    limits: {
      readonly autoResize: boolean
      readonly maxWidth: number
      readonly maxHeight: number
      readonly maxBase64Bytes: number
    },
  ) {
    const buffer = Buffer.from(content.content, "base64")
    const metadata = yield* Effect.tryPromise({
      try: () => sharp(buffer).metadata(),
      catch: () => new Image.DecodeError({ resource }),
    })
    if (!metadata.width || !metadata.height) return yield* new Image.DecodeError({ resource })
    const swapped = metadata.orientation !== undefined && metadata.orientation >= 5 && metadata.orientation <= 8
    const width = swapped ? metadata.height : metadata.width
    const height = swapped ? metadata.width : metadata.height
    const bytes = Buffer.byteLength(content.content, "utf-8")
    const withinLimits = width <= limits.maxWidth && height <= limits.maxHeight && bytes <= limits.maxBase64Bytes
    if (withinLimits && ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(content.mime)) return content
    const sizeError = new Image.SizeError({
      resource,
      width,
      height,
      bytes,
      maxWidth: limits.maxWidth,
      maxHeight: limits.maxHeight,
      maxBytes: limits.maxBase64Bytes,
    })
    if (!limits.autoResize && !withinLimits) return yield* sizeError
    const scale = Math.min(1, limits.maxWidth / width, limits.maxHeight / height)
    for (const step of Array.from({ length: limits.autoResize ? 32 : 1 }, (_, index) => index)) {
      const size = {
        width: Math.max(1, Math.floor(width * scale * 0.75 ** step)),
        height: Math.max(1, Math.floor(height * scale * 0.75 ** step)),
      }
      const candidate = yield* Effect.tryPromise({
        try: async () => {
          const rotated = sharp(buffer).rotate()
          const resized =
            size.width < width || size.height < height
              ? rotated.resize(size.width, size.height, { fit: "inside", withoutEnlargement: true })
              : rotated
          if (metadata.hasAlpha) {
            const data = (await resized.clone().png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer()).toString(
              "base64",
            )
            if (Buffer.byteLength(data, "utf-8") <= limits.maxBase64Bytes) return { data, mime: "image/png" }
          }
          for (const quality of [85, 70, 55, 40]) {
            // 透明图转 JPEG 时沿用原始白底语义，避免透明像素变成黑色。
            const data = (await (metadata.hasAlpha ? resized.clone().flatten({ background: "#ffffff" }) : resized.clone())
              .jpeg({ quality })
              .toBuffer()).toString("base64")
            if (Buffer.byteLength(data, "utf-8") <= limits.maxBase64Bytes) return { data, mime: "image/jpeg" }
          }
        },
        catch: () => new Image.DecodeError({ resource }),
      })
      if (candidate) return { ...content, content: candidate.data, mime: candidate.mime }
      if (size.width === 1 && size.height === 1) break
    }
    return yield* sizeError
  })
})
