import { describe, expect } from "bun:test"
import path from "path"
import { Effect, FileSystem, Schema } from "effect"
import { LayerNodePlatform } from "@opencode-ai/core/effect/app-node-platform"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { ReadToolFileSystem } from "@opencode-ai/core/tool/read-filesystem"
import { testEffect } from "./lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([FSUtil.node, LayerNodePlatform.filesystem])))
const fixture = Effect.gen(function* () {
  const fs = yield* FSUtil.Service
  const files = yield* FileSystem.FileSystem
  const directory = yield* files.makeTempDirectoryScoped()
  return { fs, files, directory }
})

describe("ReadToolFileSystem", () => {
  it.live("separates default pages from accepted limits and preserves byte and next boundaries", () =>
    Effect.gen(function* () {
      const fixtureData = yield* fixture
      const file = path.join(fixtureData.directory, "lines.txt")
      // 正文小于字节预算却超默认页，专门覆盖完整短文件捷径绕过行数的缺口。
      yield* fixtureData.files.writeFileString(file, Array.from({ length: 1601 }, () => "x").join("\n"))
      const first = yield* ReadToolFileSystem.read(fixtureData.fs, file, "lines.txt")
      expect(first).toMatchObject({ type: "text-page", truncated: true, next: 201 })
      expect(first.content.split("\n")).toHaveLength(200)
      expect("read" in first ? first.read : undefined).toMatchObject({ start: 1, end: 200, returned: 200, total: 1601, totalExact: true, size: 3201, stub: false })
      expect("read" in first ? first.read?.modifiedMs : undefined).toBeNumber()
      // 默认和显式上限分别验证，不能用扩大后续请求来绕过新的 200 行分页。
      // 每个中间页都用默认值锁定连续 next，不能把末页改为显式大页绕过新默认。
      yield* Effect.forEach([201, 401, 601, 801, 1001, 1201, 1401], (offset) => Effect.gen(function* () {
        const page = yield* ReadToolFileSystem.read(fixtureData.fs, file, "lines.txt", { offset })
        expect(page.content.split("\n")).toHaveLength(200)
        expect(page).toMatchObject({ truncated: true, next: offset + 200 })
      }))
      // next 是续页 offset，末页恰好返回余下正文且不制造另一页。
      const last = yield* ReadToolFileSystem.read(fixtureData.fs, file, "lines.txt", { offset: 1601 })
      expect(last.content.split("\n")).toHaveLength(1)
      expect(last).toMatchObject({ truncated: false })
      expect("next" in last ? last.next : undefined).toBeUndefined()
      // schema 与实际执行一起锁定原有可接受范围，不能只测试绕过解码的直接调用。
      expect(Schema.is(ReadToolFileSystem.PageInput)({ limit: 1500 })).toBe(true)
      expect(Schema.is(ReadToolFileSystem.PageInput)({ limit: 2000 })).toBe(true)
      expect(Schema.is(ReadToolFileSystem.PageInput)({ limit: 2001 })).toBe(false)
      const explicit = yield* ReadToolFileSystem.read(fixtureData.fs, file, "lines.txt", { limit: 1500 })
      expect(explicit.content.split("\n")).toHaveLength(1500)
      expect(explicit).toMatchObject({ next: 1501, truncated: true })
      // 内部直接调用也沿原有 clamp，不因参数超上限扩大文本页。
      yield* fixtureData.files.writeFileString(file, Array.from({ length: 2101 }, () => "x").join("\n"))
      const clamped = yield* ReadToolFileSystem.read(fixtureData.fs, file, "lines.txt", { limit: 2500 })
      expect(clamped.content.split("\n")).toHaveLength(2000)
      expect(clamped).toMatchObject({ truncated: true, next: 2001 })
      // 多字节每行计 2000 字节，16 KiB 可容纳八行，第九行必须留给 next。
      yield* fixtureData.files.writeFileString(file, Array.from({ length: 20 }, () => "é".repeat(1000)).join("\n"))
      const bytes = yield* ReadToolFileSystem.read(fixtureData.fs, file, "lines.txt")
      expect(bytes).toMatchObject({ type: "text-page", truncated: true, next: 9 })
      expect(bytes.content.split("\n")).toHaveLength(8)
      expect(Buffer.byteLength(bytes.content)).toBe(16_007)
      // 文本页预算独立于媒体摄入，不让降默认行数顺带降图片上限。
      expect(ReadToolFileSystem.MAX_MEDIA_INGEST_BYTES).toBe(20 * 1024 * 1024)
      const directory = path.join(fixtureData.directory, "entries")
      yield* fixtureData.files.makeDirectory(directory)
      // 使用真实 entries，过滤、排序和 next 都由实际 list 实现承担，不伪造 FS 返回值。
      yield* Effect.forEach(Array.from({ length: 1501 }, (_, index) => String(index).padStart(4, "0")),
        (name) => fixtureData.files.writeFileString(path.join(directory, name), ""), { concurrency: 16, discard: true })
      const entries = yield* ReadToolFileSystem.list(fixtureData.fs, directory)
      expect(entries.entries).toHaveLength(200)
      expect(entries).toMatchObject({ total: 1501, truncated: true, next: 201 })
      // 目录显式 1500 的接受范围继续与 schema oracle 一致，不能随默认页缩小。
      const requested = yield* ReadToolFileSystem.list(fixtureData.fs, directory, { limit: 1500 })
      expect(requested.entries).toHaveLength(1500)
      expect(requested).toMatchObject({ truncated: true, next: 1501 })
      // 过滤排序后的目录页也逐页推进，不能仅修改首页数量而漏掉中间 entries。
      yield* Effect.forEach([201, 401, 601, 801, 1001, 1201], (offset) => Effect.gen(function* () {
        const page = yield* ReadToolFileSystem.list(fixtureData.fs, directory, { offset })
        expect(page.entries).toHaveLength(200)
        expect(page).toMatchObject({ total: 1501, truncated: true, next: offset + 200 })
      }))
      const remaining = yield* ReadToolFileSystem.list(fixtureData.fs, directory, { offset: 1401 })
      expect(remaining.entries).toHaveLength(101)
      expect(remaining.truncated).toBe(false)
      expect(remaining.next).toBeUndefined()
    }),
  )

  it.live("keeps cross-chunk long lines whole within the byte budget", () =>
    Effect.gen(function* () {
      const fixtureData = yield* fixture
      const file = path.join(fixtureData.directory, "long-lines.txt")
      const long = "\u00e9".repeat(3000)
      // 首行跳过，第二行在 64 KiB 读取块末尾留下 2048 字符，覆盖旧 pending 截短。
      yield* fixtureData.files.writeFileString(
        file,
        `${"p".repeat(64 * 1024 - 4097)}\n${Array.from({ length: 5 }, () => long).join("\n")}`,
      )
      const first = yield* ReadToolFileSystem.read(fixtureData.fs, file, "long-lines.txt", { offset: 2 })
      expect(first.content).toBe(Array.from({ length: 2 }, () => long).join("\n"))
      expect(first).toMatchObject({ type: "text-page", truncated: true, next: 4 })
      expect(Buffer.byteLength(first.content)).toBe(12_001)
      // 预算缩小后仍逐页检查完整长行，不能跳过中间两行来放宽原来的连续性断言。
      const middle = yield* ReadToolFileSystem.read(fixtureData.fs, file, "long-lines.txt", { offset: 4 })
      expect(middle.content).toBe(Array.from({ length: 2 }, () => long).join("\n"))
      expect(middle).toMatchObject({ type: "text-page", truncated: true, next: 6 })
      const last = yield* ReadToolFileSystem.read(fixtureData.fs, file, "long-lines.txt", { offset: 6 })
      expect(last.content).toBe(long)
      expect(last).toMatchObject({ type: "text-page", truncated: false })
      expect("next" in last ? last.next : undefined).toBeUndefined()
    }),
  )

  it.effect("fails with a typed filesystem error when a resolved file disappears", () =>
    Effect.gen(function* () {
      const { fs, directory } = yield* fixture
      const file = path.join(directory, "missing.txt")

      const error = yield* ReadToolFileSystem.read(fs, file, "missing.txt").pipe(Effect.flip)

      expect(error).toMatchObject({ _tag: "PlatformError" })
    }),
  )

  it.effect("fails when a file becomes the wrong path kind", () =>
    Effect.gen(function* () {
      const { fs, directory } = yield* fixture

      const error = yield* ReadToolFileSystem.read(fs, directory, "folder").pipe(Effect.flip)

      expect(error).toBeInstanceOf(ReadToolFileSystem.PathKindError)
    }),
  )

  it.effect("fails with a typed filesystem error when directory listing fails", () =>
    Effect.gen(function* () {
      const { fs, files, directory } = yield* fixture
      const file = path.join(directory, "file.txt")
      yield* files.writeFileString(file, "hello")

      const error = yield* ReadToolFileSystem.list(fs, file).pipe(Effect.flip)

      expect(error).toBeInstanceOf(FSUtil.FileSystemError)
      if (error instanceof FSUtil.FileSystemError) expect(error.method).toBe("readDirectoryEntries")
    }),
  )

  it.effect("reports binary and malformed UTF-8 content as typed errors", () =>
    Effect.gen(function* () {
      const { fs, files, directory } = yield* fixture
      const binary = path.join(directory, "archive.dat")
      const malformed = path.join(directory, "malformed.txt")
      yield* files.writeFile(binary, Uint8Array.of(0, 1, 2, 3))
      const malformedContent = new Uint8Array(64 * 1024 + 1).fill(97)
      malformedContent[64 * 1024] = 0x80
      yield* files.writeFile(malformed, malformedContent)

      const binaryError = yield* ReadToolFileSystem.read(fs, binary, "archive.dat").pipe(Effect.flip)
      const malformedError = yield* ReadToolFileSystem.read(fs, malformed, "malformed.txt").pipe(Effect.flip)

      expect(binaryError).toBeInstanceOf(ReadToolFileSystem.BinaryFileError)
      expect(binaryError.message).toBe("Cannot read binary file: archive.dat")
      expect(malformedError).toBeInstanceOf(ReadToolFileSystem.MalformedUtf8Error)
    }),
  )

  it.effect("reports out-of-range pagination as a typed error", () =>
    Effect.gen(function* () {
      const { fs, files, directory } = yield* fixture
      const file = path.join(directory, "short.txt")
      yield* files.writeFileString(file, "one\n")

      const error = yield* ReadToolFileSystem.read(fs, file, "short.txt", { offset: 2 }).pipe(Effect.flip)

      expect(error).toBeInstanceOf(ReadToolFileSystem.OffsetOutOfRangeError)
      expect(error.message).toBe("Offset 2 is out of range")
    }),
  )

  it.effect("stops reading after the requested page is complete", () =>
    Effect.gen(function* () {
      const { fs, files, directory } = yield* fixture
      const prefix = new TextEncoder().encode("one\n")
      for (const [name, trailing] of [
        ["malformed.txt", 0x80],
        ["nul.txt", 0],
      ] as const) {
        const file = path.join(directory, name)
        yield* files.writeFile(file, Uint8Array.from([...prefix, trailing]))

        const result = yield* ReadToolFileSystem.read(fs, file, name, { limit: 1 })

        expect(result).toMatchObject({ type: "text-page", content: "one", truncated: true, next: 2 })
      }
    }),
  )

  it.effect("preserves the media ingestion limit message", () =>
    Effect.gen(function* () {
      const { fs, files, directory } = yield* fixture
      const file = path.join(directory, "oversized.png")
      yield* files.writeFile(file, Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))
      yield* files.truncate(file, ReadToolFileSystem.MAX_MEDIA_INGEST_BYTES + 1)

      const error = yield* ReadToolFileSystem.read(fs, file, "oversized.png").pipe(Effect.flip)

      expect(error).toBeInstanceOf(ReadToolFileSystem.MediaIngestLimitError)
      expect(error.message).toBe(
        `Media exceeds ${ReadToolFileSystem.MAX_MEDIA_INGEST_BYTES} byte ingestion limit: oversized.png`,
      )
    }),
  )
})
