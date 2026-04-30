import { describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Cause, Effect, Exit } from "effect"
import { Image } from "@/image/image"
import { Config } from "@/config/config"
import { MessageID, PartID, SessionID } from "@/session/schema"
import path from "node:path"
import { TestConfig } from "../fixture/config"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(Image.node, [[Config.node, TestConfig.layer()]]))
const tiny = testEffect(
  LayerNode.compile(Image.node, [
    [Config.node, TestConfig.layer({ get: () => Effect.succeed({ attachment: { image: { max_base64_bytes: 1 } } }) })],
  ]),
)

// 禁用缩放使错误的全局预算直接暴露，上传仍按原尺寸配置和默认 5 MiB 接收。
const uploads = testEffect(LayerNode.compile(Image.node, [[Config.node, TestConfig.layer({
  get: () => Effect.succeed({ attachment: { image: { auto_resize: false, max_width: 10000, max_height: 10000 } } }),
})]]))

function part(mime: string, data: string) {
  return {
    id: PartID.ascending(),
    messageID: MessageID.ascending(),
    sessionID: SessionID.make("ses_test"),
    type: "file" as const,
    mime,
    url: `data:${mime};base64,${data}`,
  }
}

describe("Image", () => {
  it.effect("normalizes generated PNG, JPEG, BMP, TIFF and AVIF attachments", () =>
    Effect.gen(function* () {
      const photon = yield* Effect.promise(() => import("@silvia-odwyer/photon-node"))
      const source = new photon.PhotonImage(
        new Uint8Array(Array.from({ length: 64 * 64 * 4 }, (_, index) => (index % 4 === 3 ? 255 : index % 251))),
        64,
        64,
      )
      const { default: sharp } = yield* Effect.promise(() => import("sharp"))
      const png = Buffer.from(source.get_bytes())
      const tiff = yield* Effect.promise(() => sharp(png).tiff({ compression: "lzw" }).toBuffer())
      const avif = yield* Effect.promise(() => sharp(png).avif({ lossless: true }).toBuffer())
      const bmp = Buffer.alloc(58)
      bmp.set([0x42, 0x4d])
      bmp.writeUInt32LE(bmp.length, 2)
      bmp.writeUInt32LE(54, 10)
      bmp.writeUInt32LE(40, 14)
      bmp.writeInt32LE(1, 18)
      bmp.writeInt32LE(1, 22)
      bmp.writeUInt16LE(1, 26)
      bmp.writeUInt16LE(24, 28)
      bmp.writeUInt32LE(4, 34)
      bmp.set([0, 0, 255, 0], 54)
      const image = yield* Image.Service
      // 模型不支持的格式即使未超预算，也必须先转成 PNG。
      const results = yield* Effect.all([
        image.normalize(part("image/png", png.toString("base64"))),
        image.normalize(part("image/jpeg", Buffer.from(source.get_bytes_jpeg(90)).toString("base64"))),
        image.normalize(part("image/bmp", bmp.toString("base64")), 1600 * 750),
        image.normalize(part("image/tiff", tiff.toString("base64")), 1600 * 750),
        image.normalize(part("image/avif", avif.toString("base64")), 1600 * 750),
      ])

      source.free()
      expect(results.map((result) => result.url.startsWith(`data:${result.mime};base64,`))).toEqual([true, true, true, true, true])
      expect(results.every((result) => result.mime === "image/png" || result.mime === "image/jpeg")).toBe(true)
      for (const [index, result] of results.entries()) {
        const base64 = result.url.slice(result.url.indexOf(";base64,") + 8)
        expect(Buffer.byteLength(base64, "utf-8")).toBeLessThanOrEqual(1600 * 750)
        if (index === 1) {
          expect(result.mime).toBe("image/jpeg")
          continue
        }
        expect(result.mime).toBe("image/png")
        const bytes = Buffer.from(base64, "base64")
        expect(Array.from(bytes.subarray(0, 8))).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
        const decoded = photon.PhotonImage.new_from_byteslice(bytes)
        expect(decoded.get_width()).toBe(index === 2 ? 1 : 64)
        expect(decoded.get_height()).toBe(index === 2 ? 1 : 64)
        decoded.free()
      }
    }),
  )

  it.effect("accepts webp attachments that are already within limits", () =>
    Effect.gen(function* () {
      const image = yield* Image.Service
      const input = part("image/webp", "UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA")

      expect(yield* image.normalize(input)).toEqual(input)
    }),
  )

  it.effect("resizes images that fit the byte limit but exceed dimension limits", () =>
    Effect.gen(function* () {
      const photon = yield* Effect.promise(() => import("@silvia-odwyer/photon-node"))
      const source = new photon.PhotonImage(new Uint8Array(Array.from({ length: 9_000 * 4 }, () => 255)), 9_000, 1)
      const image = yield* Image.Service
      const result = yield* image.normalize(part("image/png", Buffer.from(source.get_bytes()).toString("base64")))
      const resized = photon.PhotonImage.new_from_byteslice(
        Buffer.from(result.url.slice(result.url.indexOf(";base64,") + ";base64,".length), "base64"),
      )

      source.free()
      expect(resized.get_width()).toBeLessThanOrEqual(2_000)
      expect(resized.get_height()).toBeLessThanOrEqual(2_000)
      // Photon 必须真正缩放并保持单像素高度，输出声明也须匹配实际 PNG 编码。
      expect(resized.get_width()).toBe(2_000)
      expect(resized.get_height()).toBe(1)
      expect(result.mime).toBe("image/png")
      expect(result.url.startsWith("data:image/png;base64,")).toBe(true)
      resized.free()
    }),
  )

  it.effect("resizes the 5MB base64 picture fixture", () =>
    Effect.gen(function* () {
      const photon = yield* Effect.promise(() => import("@silvia-odwyer/photon-node"))
      const data = Buffer.from(
        yield* Effect.promise(() =>
          Bun.file(path.join(import.meta.dir, "fixtures", "picture-5mb-base64.png")).arrayBuffer(),
        ),
      )
      const input = part("image/png", data.toString("base64"))
      const image = yield* Image.Service
      // 此预算仅模拟 Read 调用；默认 normalize 仍保持上传附件的配置语义。
      const result = yield* image.normalize(input, 1600 * 750)
      const base64 = result.url.slice(result.url.indexOf(";base64,") + ";base64,".length)
      const resized = photon.PhotonImage.new_from_byteslice(Buffer.from(base64, "base64"))

      expect(input.url.slice(input.url.indexOf(";base64,") + ";base64,".length).length).toBe(5 * 1024 * 1024)
      expect(result.url).not.toBe(input.url)
      expect(base64.length).toBeLessThan(5 * 1024 * 1024)
      // 使用真实大图验证编码预算，不能仅验证旧的 5 MiB 上限。
      expect(base64.length).toBeLessThanOrEqual(1600 * 750)
      expect(resized.get_width()).toBeLessThanOrEqual(2_000)
      expect(resized.get_height()).toBeLessThanOrEqual(2_000)
      resized.free()
    }),
  )

  uploads.effect("keeps upload limits while applying an explicit Read-only budget", () =>
    Effect.gen(function* () {
      const input = part("image/png", Buffer.from(yield* Effect.promise(() =>
        Bun.file(path.join(import.meta.dir, "fixtures", "picture-5mb-base64.png")).arrayBuffer(),
      )).toString("base64"))
      const image = yield* Image.Service
      // 同一真实图片在上传调用中必须保持原样，不能悄悄继承 Read 的 1.2 MB。
      expect(yield* image.normalize(input)).toEqual(input)
      const exit = yield* image.normalize(input, 1600 * 750).pipe(Effect.exit)
      // Read 禁用缩放时仍由同一个 typed SizeError 报告预算，不返回伪装压缩的原图。
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const error = Cause.squash(exit.cause)
        expect(error).toBeInstanceOf(Image.SizeError)
        if (error instanceof Image.SizeError) expect(error.max).toBe(1600 * 750)
      }
    }),
  )

  tiny.effect("fails with a typed size error when no resized candidate fits", () =>
    Effect.gen(function* () {
      const photon = yield* Effect.promise(() => import("@silvia-odwyer/photon-node"))
      const source = new photon.PhotonImage(new Uint8Array(Array.from({ length: 4 }, () => 255)), 1, 1)
      const image = yield* Image.Service
      const exit = yield* image
        .normalize(part("image/png", Buffer.from(source.get_bytes()).toString("base64")))
        .pipe(Effect.exit)

      source.free()
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const error = Cause.squash(exit.cause)
        expect(error).toBeInstanceOf(Image.SizeError)
        if (error instanceof Image.SizeError) {
          expect(error.width).toBe(1)
          expect(error.height).toBe(1)
          expect(error.max).toBe(1)
        }
      }
    }),
  )
})
