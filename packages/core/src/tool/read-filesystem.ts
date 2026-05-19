export * as ReadToolFileSystem from "./read-filesystem"

import path from "path"
import { pathToFileURL } from "url"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { FileSystem } from "../filesystem"
import { FSUtil } from "../fs-util"
import { makeLocationNode } from "../effect/app-node"
import { AbsolutePath, PositiveInt, RelativePath } from "../schema"
import { ReadPresentation } from "./read-presentation"
import { readOutline } from "./read-outline"

// 默认页与可接受上限分离，过去合法的显式 limit=1500 不能因降低默认值而被 schema 拒绝。
// 短文件是否分页与目录缺省页复用这个常量，400 行不能只作用于大文件分支。
export const DEFAULT_READ_LINES = 200
const MAX_SCAN_BYTES = 256 * 1024
export const MAX_READ_LINES = 2_000
// UTF-8 文本页按实际字节受限；原生图片仍使用独立的媒体摄入上限。
// #178：V2 读路径对齐 16KiB
export const MAX_READ_BYTES = 16 * 1024
export const MAX_MEDIA_INGEST_BYTES = 20 * 1024 * 1024

export class BinaryFileError extends Schema.TaggedErrorClass<BinaryFileError>()("ReadTool.BinaryFileError", {
  resource: Schema.String,
}) {
  override get message() {
    return `Cannot read binary file: ${this.resource}`
  }
}

export class MediaIngestLimitError extends Schema.TaggedErrorClass<MediaIngestLimitError>()(
  "ReadTool.MediaIngestLimitError",
  {
    resource: Schema.String,
    maximumBytes: Schema.Number,
  },
) {
  override get message() {
    return `Media exceeds ${this.maximumBytes} byte ingestion limit: ${this.resource}`
  }
}

export class MalformedUtf8Error extends Schema.TaggedErrorClass<MalformedUtf8Error>()("ReadTool.MalformedUtf8Error", {
  resource: Schema.String,
}) {
  override get message() {
    return `File is not valid UTF-8: ${this.resource}`
  }
}

export class OffsetOutOfRangeError extends Schema.TaggedErrorClass<OffsetOutOfRangeError>()(
  "ReadTool.OffsetOutOfRangeError",
  { offset: Schema.Number },
) {
  override get message() {
    return `Offset ${this.offset} is out of range`
  }
}

export class PathKindError extends Schema.TaggedErrorClass<PathKindError>()("ReadTool.PathKindError", {
  resource: Schema.String,
  expected: Schema.Literals(["a file", "a file or directory"]),
}) {
  override get message() {
    return `Path is not ${this.expected}: ${this.resource}`
  }
}

export type InspectError = FSUtil.Error | PathKindError
export type ReadError =
  | FSUtil.Error
  | BinaryFileError
  | MediaIngestLimitError
  | MalformedUtf8Error
  | OffsetOutOfRangeError
  | PathKindError

export const PageInput = Schema.Struct({
  offset: PositiveInt.pipe(Schema.optional),
  limit: PositiveInt.check(Schema.isLessThanOrEqualTo(MAX_READ_LINES)).pipe(Schema.optional),
})
export type PageInput = typeof PageInput.Type

const readFields = {
  read: Schema.optional(ReadPresentation.ReadRangeMeta),
  outline: Schema.optional(ReadPresentation.OutlineOutput),
}
export const Content = Schema.Struct({ ...FileSystem.Content.fields, ...readFields })
export type Content = typeof Content.Type

export class TextPage extends Schema.Class<TextPage>("ReadTool.TextPage")({
  ...readFields,
  type: Schema.Literal("text-page"),
  content: Schema.String,
  mime: Schema.String,
  offset: PositiveInt,
  truncated: Schema.Boolean,
  next: PositiveInt.pipe(Schema.optional),
}) {}

export class ListPage extends Schema.Class<ListPage>("ReadTool.ListPage")({
  entries: Schema.Array(FileSystem.Entry),
  total: Schema.optional(Schema.Number),
  truncated: Schema.Boolean,
  next: PositiveInt.pipe(Schema.optional),
}) {}

export interface Interface {
  readonly inspect: (path: AbsolutePath) => Effect.Effect<"file" | "directory", InspectError>
  readonly read: (
    path: AbsolutePath,
    resource: string,
    page?: PageInput,
  ) => Effect.Effect<Content | TextPage, ReadError>
  readonly list: (path: AbsolutePath, page?: PageInput) => Effect.Effect<ListPage, FSUtil.Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ReadToolFileSystem") {}

const extensions = new Set([
  ".zip",
  ".tar",
  ".gz",
  ".exe",
  ".dll",
  ".so",
  ".class",
  ".jar",
  ".war",
  ".7z",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
  ".ppt",
  ".pptx",
  ".odt",
  ".ods",
  ".odp",
  ".bin",
  ".dat",
  ".obj",
  ".o",
  ".a",
  ".lib",
  ".wasm",
  ".pyc",
  ".pyo",
])
const startsWith = (bytes: Uint8Array, prefix: number[]) => prefix.every((value, index) => bytes[index] === value)
const imageMime = (bytes: Uint8Array) => {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png"
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg"
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return "image/gif"
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes.subarray(8), [0x57, 0x45, 0x42, 0x50]))
    return "image/webp"
  // BMP 需有结构化文件头，不能把以 BM 开头的纯文本当图片。
  if (bytes.length >= 26 && startsWith(bytes, [0x42, 0x4d])) {
    const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const size = header.getUint32(14, true)
    if (
      [12, 16, 40, 52, 56, 64, 108, 124].includes(size) &&
      bytes.length >= 14 + size &&
      header.getUint32(10, true) >= 14 + size &&
      header.getUint16(size === 12 ? 22 : 26, true) === 1
    )
      return "image/bmp"
  }
  // Require the complete TIFF signature, not just the printable byte-order marker.
  if (
    (bytes.length >= 8 &&
      (startsWith(bytes, [0x49, 0x49, 0x2a, 0x00]) || startsWith(bytes, [0x4d, 0x4d, 0x00, 0x2a]))) ||
    (bytes.length >= 16 &&
      (startsWith(bytes, [0x49, 0x49, 0x2b, 0x00, 0x08, 0x00, 0x00, 0x00]) ||
        startsWith(bytes, [0x4d, 0x4d, 0x00, 0x2b, 0x00, 0x08, 0x00, 0x00])))
  )
    return "image/tiff"
  if (bytes.length >= 16 && startsWith(bytes.subarray(4), [0x66, 0x74, 0x79, 0x70])) {
    const size = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0)
    if (size >= 16 && size <= bytes.length && size % 4 === 0) {
      // Check both the major and compatible brands, excluding the minor version.
      const brands = [8, ...Array.from({ length: (size - 16) / 4 }, (_, index) => 16 + index * 4)].map((offset) =>
        Buffer.from(bytes.subarray(offset, offset + 4)).toString("ascii"),
      )
      if (brands.some((brand) => ["avif", "avis"].includes(brand))) return "image/avif"
      if (brands.some((brand) => ["heic", "heix", "hevc", "hevx"].includes(brand))) return "image/heic"
      if (brands.some((brand) => ["mif1", "msf1"].includes(brand))) return "image/heif"
    }
  }
}
const binary = (resource: string, bytes: Uint8Array) => {
  if (extensions.has(path.extname(resource).toLowerCase())) return true
  if (bytes.length === 0) return false
  let nonPrintable = 0
  for (const byte of bytes) {
    if (byte === 0) return true
    if (byte < 9 || (byte > 13 && byte < 32)) nonPrintable++
  }
  return nonPrintable / bytes.length > 0.3
}
const decodeUtf8 = (resource: string, decoder: TextDecoder, bytes?: Uint8Array) =>
  Effect.try({
    try: () => decoder.decode(bytes, { stream: bytes !== undefined }),
    catch: (error) => {
      if (error instanceof TypeError) return new MalformedUtf8Error({ resource })
      throw error
    },
  })
const decodeChunk = (resource: string, decoder: TextDecoder, bytes: Uint8Array) =>
  bytes.includes(0) ? Effect.fail(new BinaryFileError({ resource })) : decodeUtf8(resource, decoder, bytes)

export const inspect = Effect.fn("ReadTool.inspect")(function* (fs: FSUtil.Interface, input: string) {
  const info = yield* fs.stat(input)
  const type = info.type === "File" ? "file" : info.type === "Directory" ? "directory" : undefined
  if (!type) return yield* Effect.fail(new PathKindError({ resource: input, expected: "a file or directory" }))
  return type
})

export const read = Effect.fn("ReadTool.read")(function* (
  fs: FSUtil.Interface,
  input: string,
  resource: string,
  page: PageInput = {},
) {
  const real = yield* fs.realPath(input)
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const file = yield* fs.open(real, { flag: "r" })
      const info = yield* file.stat
      if (info.type !== "File") return yield* Effect.fail(new PathKindError({ resource, expected: "a file" }))
      const first = Option.getOrElse(
        yield* file.readAlloc(Math.min(64 * 1024, Number(info.size) || 4 * 1024)),
        () => new Uint8Array(),
      )
      const mime = imageMime(first)
      if (mime) {
        if (info.size > MAX_MEDIA_INGEST_BYTES)
          return yield* Effect.fail(new MediaIngestLimitError({ resource, maximumBytes: MAX_MEDIA_INGEST_BYTES }))
        const chunks = [first]
        let total = first.length
        while (total <= MAX_MEDIA_INGEST_BYTES) {
          const chunk = yield* file.readAlloc(Math.min(64 * 1024, MAX_MEDIA_INGEST_BYTES + 1 - total))
          if (Option.isNone(chunk)) break
          chunks.push(chunk.value)
          total += chunk.value.length
        }
        if (total > MAX_MEDIA_INGEST_BYTES)
          return yield* Effect.fail(new MediaIngestLimitError({ resource, maximumBytes: MAX_MEDIA_INGEST_BYTES }))
        return {
          uri: pathToFileURL(real).href,
          name: path.basename(real),
          content: Buffer.concat(
            chunks.map((chunk) => Buffer.from(chunk)),
            total,
          ).toString("base64"),
          encoding: "base64" as const,
          mime,
        }
      }
      if (startsWith(first, [0x25, 0x50, 0x44, 0x46]) || extensions.has(path.extname(resource).toLowerCase()))
        return yield* Effect.fail(new BinaryFileError({ resource }))
      let scanned = 0
      let totalLines = 0
      let lastByte: number | undefined
      // 额外计数只看行界字节，页外的坏 UTF-8 或 NUL 不得推翻已成功读取的页。
      const count = (chunk: Uint8Array) => {
        scanned += chunk.length
        totalLines += chunk.reduce((sum, byte) => sum + Number(byte === 10), 0)
        lastByte = chunk.at(-1)
      }
      count(first)
      const finish = Effect.fnUntraced(function* (offset: number, returned: number, cut: boolean, eof: boolean) {
        const total = totalLines + Number(scanned > 0 && lastByte !== 10)
        const exact = eof || scanned === Number(info.size)
        const outline = yield* Effect.promise(() => readOutline(real, total, offset, exact))
        const after = yield* file.stat
        const modified = Option.getOrUndefined(info.mtime)?.getTime()
        const stable = modified !== undefined && after.size === info.size && Option.getOrUndefined(after.mtime)?.getTime() === modified
        return {
          read: {
            path: real,
            canonicalPath: ReadPresentation.canonicalReadPath(real),
            type: "file" as const,
            size: Number(info.size),
            modified: modified === undefined ? "unknown" : ReadPresentation.formatModified(modified),
            ...(stable ? { modifiedMs: Math.floor(modified) } : {}),
            start: offset,
            end: Math.max(offset - 1, offset + returned - 1),
            total,
            totalExact: exact && stable,
            returned,
            stub: false,
            cut,
          },
          ...(outline === undefined ? {} : { outline }),
        }
      })
      // 小于字节预算也可能超过默认行数；只扫描已读取的字节，不预先解码页外的无效 UTF-8。
      const firstLines = first.reduce((count, byte) => count + Number(byte === 10), 0) + Number(first.length > 0 && first.at(-1) !== 10)
      const paged =
        info.size > MAX_READ_BYTES ||
        first.length < info.size ||
        page.offset !== undefined ||
        page.limit !== undefined ||
        firstLines > DEFAULT_READ_LINES
      if (!paged) {
        if (binary(resource, first)) return yield* Effect.fail(new BinaryFileError({ resource }))
        const decoder = new TextDecoder("utf-8", { fatal: true })
        const text = [yield* decodeUtf8(resource, decoder, first)]
        while (true) {
          const chunk = yield* file.readAlloc(64 * 1024)
          if (Option.isNone(chunk)) break
          count(chunk.value)
          text.push(yield* decodeChunk(resource, decoder, chunk.value))
        }
        text.push(yield* decodeUtf8(resource, decoder))
        return {
          uri: pathToFileURL(real).href,
          name: path.basename(real),
          content: text.join(""),
          encoding: "utf8" as const,
          mime: FSUtil.mimeType(real),
          ...(yield* finish(1, totalLines + Number(scanned > 0 && lastByte !== 10), false, true)),
        }
      }
      const offset = page.offset ?? 1
      // 显式页仍按原有上限 clamp，缺省才使用较小页；next 继续定位首个未返回行。
      const limit = Math.min(page.limit ?? DEFAULT_READ_LINES, MAX_READ_LINES)
      const lines: string[] = []
      const decoder = new TextDecoder("utf-8", { fatal: true })
      let pending = ""
      let line = 1
      let bytes = 0
      let next: number | undefined
      let consumed = 0
      const append = (input: string) => {
        if (line < offset) {
          line++
          return true
        }
        if (lines.length >= limit || bytes >= MAX_READ_BYTES) {
          next = line
          return false
        }
        const text = input
        const size = Buffer.byteLength(text, "utf-8") + (lines.length > 0 ? 1 : 0)
        if (bytes + size > MAX_READ_BYTES) {
          next = line
          return false
        }
        lines.push(text)
        bytes += size
        line++
        return true
      }
      const consume = (input: string) => {
        let text = input
        while (true) {
          const index = text.indexOf("\n")
          if (index === -1) {
            // 跨块保留完整行，由 append 的字节预算决定整行是否进入当前页。
            pending += text
            break
          }
          const current = pending + text.slice(0, index)
          pending = ""
          text = text.slice(index + 1)
          if (!append(current.endsWith("\r") ? current.slice(0, -1) : current)) return false
        }
        return true
      }
      const consumeChunk = Effect.fnUntraced(function* (chunk: Uint8Array) {
        let start = 0
        while (start < chunk.length) {
          if (lines.length >= limit || bytes >= MAX_READ_BYTES) {
            next = line
            return false
          }
          const newline = chunk.indexOf(10, start)
          const end = newline === -1 ? chunk.length : newline + 1
          const segment = chunk.subarray(start, end)
          consumed += segment.length
          if (binary(resource, segment)) return yield* Effect.fail(new BinaryFileError({ resource }))
          if (!consume(yield* decodeUtf8(resource, decoder, segment))) return false
          start = end
        }
        return true
      })
      let done = !(yield* consumeChunk(first))
      while (!done) {
        const chunk = yield* file.readAlloc(64 * 1024)
        if (Option.isNone(chunk)) break
        count(chunk.value)
        done = !(yield* consumeChunk(chunk.value))
      }
      if (!done) {
        const tail = yield* decodeUtf8(resource, decoder)
        pending += tail
        if (pending) append(pending.endsWith("\r") ? pending.slice(0, -1) : pending)
      }
      if (lines.length === 0 && offset !== 1) return yield* Effect.fail(new OffsetOutOfRangeError({ offset }))
      // 正文停止后最多再计数固定字节预算；总行数不足 EOF 时明确作为下界。
      const scanEnd = consumed + MAX_SCAN_BYTES
      let eof = !done
      while (!eof && scanned < Number(info.size) && scanned < scanEnd) {
        const chunk = yield* file.readAlloc(Math.min(64 * 1024, scanEnd - scanned))
        if (Option.isNone(chunk)) {
          eof = true
          break
        }
        count(chunk.value)
      }
      const metadata = yield* finish(offset, lines.length, next !== undefined && lines.length < limit, eof)
      return new TextPage({
        type: "text-page",
        content: lines.join("\n"),
        mime: FSUtil.mimeType(real),
        offset,
        truncated: next !== undefined,
        ...(next === undefined ? {} : { next }),
        ...metadata,
      })
    }),
  )
})

export const list = Effect.fn("ReadTool.list")(function* (fs: FSUtil.Interface, input: string, page: PageInput = {}) {
  const real = yield* fs.realPath(input)
  const items = yield* fs.readDirectoryEntries(real)
  const offset = page.offset ?? 1
  // 目录也只改变默认页大小，显式请求与按过滤后 entries 推进 next 的行为保持不变。
  const limit = Math.min(page.limit ?? DEFAULT_READ_LINES, MAX_READ_LINES)
  const entries = yield* Effect.forEach(
    items,
    (item) =>
      Effect.gen(function* () {
        const absolute = path.join(real, item.name)
        const target = yield* fs.realPath(absolute).pipe(Effect.catch(() => Effect.void))
        if (!target || !FSUtil.contains(real, target)) return
        const info = yield* fs.stat(target).pipe(Effect.catch(() => Effect.void))
        const type = info?.type === "Directory" ? "directory" : info?.type === "File" ? "file" : undefined
        if (!type) return
        return FileSystem.Entry.make({
          path: RelativePath.make(item.name + (type === "directory" ? path.sep : "")),
          type,
        })
      }),
    { concurrency: 16 },
  )
  const visible = entries
    .filter((item): item is FileSystem.Entry => item !== undefined)
    .sort((a, b) => (a.type === b.type ? a.path.localeCompare(b.path) : a.type === "directory" ? -1 : 1))
  const selected = visible.slice(offset - 1, offset - 1 + limit)
  const truncated = offset - 1 + selected.length < visible.length
  return new ListPage({ entries: selected, total: visible.length, truncated, ...(truncated ? { next: offset + selected.length } : {}) })
})

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    return Service.of({
      inspect: (path) => inspect(fs, path),
      read: (path, resource, page) => read(fs, path, resource, page),
      list: (path, page) => list(fs, path, page),
    })
  }),
)

export const node = makeLocationNode({ service: Service, layer, deps: [FSUtil.node] })
