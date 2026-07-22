export * as CoreImageSharp from "./sharp"

import { Effect } from "effect"
import { FileSystem } from "../filesystem"
import { Image } from "../image"
import { Global } from "../global"
import { createHash, randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"

declare const OPENCODE_COMPILED: boolean | undefined
type EmbeddedSharp = { target: string; version: string; addon: string | null; files: Record<string, string> }

export const make = Effect.gen(function* () {
  const sharp = yield* Effect.tryPromise({
    try: async () => {
      // V1和原生Image共用此adapter，compiled只改变装载位置，不改变规整/预算算法。
      if (typeof OPENCODE_COMPILED !== "undefined" && OPENCODE_COMPILED) await prepareCompiledSharp()
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
    // metadata不消费像素；透传、禁缩放和多页编码前必须验证所有待发送pages。
    // 单页后续编码本身完整解码，不额外生成一份raw副本。
    if (withinLimits || !limits.autoResize || (metadata.pages ?? 1) > 1)
      yield* Effect.tryPromise({
        try: async () => void (await sharp(buffer, (metadata.pages ?? 1) > 1 ? { pages: -1 } : undefined).raw().toBuffer()),
        catch: () => new Image.DecodeError({ resource }),
      })

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

async function prepareCompiledSharp() {
  // 虚拟模块与构建入口成对；不猜测开发机node_modules路径或临时切换第二后端。
  // @ts-expect-error generated at build time
  const embedded = (await import("opencode-sharp.gen.ts")).default as EmbeddedSharp
  if (!embedded.addon) throw new Error(`Sharp is unavailable for ${embedded.target}`)
  const root = path.join(Global.Path.cache, "native", "sharp", embedded.version, embedded.target)
  await Promise.all(Object.entries(embedded.files).map(async ([relative, source]) => {
    const target = path.join(root, ...relative.split("/"))
    if (await sameFileContent(source, target)) return
    await fs.mkdir(path.dirname(target), { recursive: true })
    const temp = `${target}.tmp-${process.pid}-${randomUUID()}`
    try {
      await Bun.write(temp, Bun.file(source))
      try { await fs.rename(temp, target) } catch (error) {
        // Windows的并发winner可能已加载DLL；只有内容完全一致才复用，否则保留原错误。
        if (!(await sameFileContent(source, target))) throw error
      }
      if (!(await sameFileContent(source, target))) throw new Error(`Extracted Sharp resource failed verification: ${target}`)
    } finally {
      await fs.rm(temp, { force: true }).catch(() => {})
    }
  }))
  // 所有shared library校验完成后才公开addon路径，不能让加载器观察到半释放状态。
  ;(globalThis as typeof globalThis & { __OPENCODE_SHARP_NATIVE_PATH?: string }).__OPENCODE_SHARP_NATIVE_PATH = path.join(root, ...embedded.addon.split("/"))
}

async function sameFileContent(source: string, target: string) {
  if (!(await Bun.file(target).exists()) || Bun.file(source).size !== Bun.file(target).size) return false
  return (await fileDigest(source)) === (await fileDigest(target))
}

async function fileDigest(file: string) {
  return createHash("sha256").update(Buffer.from(await Bun.file(file).arrayBuffer())).digest("hex")
}
