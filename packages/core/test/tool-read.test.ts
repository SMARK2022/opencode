import { beforeEach, describe, expect } from "bun:test"
import path from "path"
import { Effect, Exit, Layer, PlatformError, Schema } from "effect"
import { SessionStore } from "@opencode-ai/core/session/store"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { Config } from "@opencode-ai/core/config"
import { ConfigAttachments } from "@opencode-ai/core/config/attachments"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FileSystem } from "@opencode-ai/core/filesystem"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Location } from "@opencode-ai/core/location"
import { Image } from "@opencode-ai/core/image"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { SessionV2 } from "@opencode-ai/core/session"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Global } from "@opencode-ai/core/global"
import { LocationMutation } from "@opencode-ai/core/location-mutation"
import { location } from "./fixture/location"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { ReadTool } from "@opencode-ai/core/tool/read"
import { ReadToolFileSystem } from "@opencode-ai/core/tool/read-filesystem"
import { ReadPresentation } from "@opencode-ai/core/tool/read-presentation"
import { testEffect } from "./lib/effect"
import { toolIdentity, executeTool, settleTool, toolDefinitions } from "./lib/tool"

const assertions: PermissionV2.AssertInput[] = []
const missingPath = "__missing_read_target__.txt"
const missingAbsolutePath = path.join(process.cwd(), missingPath)
const readCalls: {
  input: AbsolutePath
  page: ReadToolFileSystem.PageInput
}[] = []
const listCalls: ReadToolFileSystem.PageInput[] = []
let resolvedType: "file" | "directory" = "file"
let resolveFailure: unknown
let readResult: FileSystem.Content | ReadToolFileSystem.TextPage = {
  uri: "file:///README.md",
  name: "README.md",
  content: "hello",
  encoding: "utf8",
  mime: "text/plain",
}
let readFailure: ReadToolFileSystem.ReadError | undefined
let configEntries: Config.Entry[] = []
const reader = Layer.succeed(
  ReadToolFileSystem.Service,
  ReadToolFileSystem.Service.of({
    inspect: () => (resolveFailure === undefined ? Effect.succeed(resolvedType) : Effect.die(resolveFailure)),
    read: (input, _resource, page = {}) => {
      readCalls.push({ input, page })
      if (readFailure !== undefined) return Effect.fail(readFailure)
      return Effect.succeed(readResult)
    },
    list: (_path, input = {}) =>
      Effect.sync(() => {
        listCalls.push(input)
        return new ReadToolFileSystem.ListPage({ entries: [], truncated: false })
      }),
  }),
)
let allow = true
const permission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    assert: (input) =>
      Effect.sync(() => {
        assertions.push(input)
      }).pipe(Effect.andThen(allow ? Effect.void : Effect.fail(new PermissionV2.BlockedError({ rules: [] })))),
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)
const config = Layer.succeed(Config.Service, Config.Service.of({ entries: () => Effect.succeed(configEntries) }))
const imageLayer = AppNodeBuilder.build(Image.node, [[Config.node, config]])
const testFileSystem = Layer.effect(
  FSUtil.Service,
  FSUtil.Service.use((fs) =>
    Effect.succeed(
      FSUtil.Service.of({
        ...fs,
        realPath: (path) =>
          path === missingAbsolutePath
            ? Effect.fail(
                PlatformError.systemError({
                  _tag: "NotFound",
                  module: "FileSystem",
                  method: "realPath",
                  pathOrDescriptor: path,
                }),
              )
            : Effect.succeed(path),
      }),
    ),
  ),
).pipe(Layer.provide(LayerNode.compile(FSUtil.node)))
const locationLayer = Layer.succeed(
  Location.Service,
  Location.Service.of(location({ directory: AbsolutePath.make(process.cwd()) })),
)
const mutation = Layer.succeed(
  LocationMutation.Service,
  LocationMutation.Service.of({
    resolve: (input) => {
      if (input.path === missingPath)
        return Effect.fail(new LocationMutation.PathError({ path: input.path, reason: "non_directory_ancestor" }))
      const canonical = path.resolve(process.cwd(), input.path)
      const external = path.isAbsolute(input.path) && !FSUtil.contains(process.cwd(), canonical)
      const resource = external ? canonical.replaceAll("\\", "/") : path.relative(process.cwd(), canonical) || "."
      const directory = path.dirname(canonical)
      const externalResource = path.join(directory, "*").replaceAll("\\", "/")
      return Effect.succeed({
        canonical,
        resource,
        externalDirectory: external
          ? {
              action: "external_directory" as const,
              directory,
              resource: externalResource,
              save: externalResource,
            }
          : undefined,
      })
    },
  }),
)
const unavailableImage = Layer.succeed(
  Image.Service,
  Image.Service.of({ normalize: () => Effect.fail(new Image.ResizerUnavailableError()) }),
)
const readLayer = (imageLayer: Layer.Layer<Image.Service>, readerLayer: Layer.Layer<ReadToolFileSystem.Service> = reader, replacements: LayerNode.Replacements = []) =>
  AppNodeBuilder.build(LayerNode.group([ToolRegistry.node, ToolRegistry.toolsNode, ReadTool.node]), [
    [ReadToolFileSystem.node, readerLayer],
    [PermissionV2.node, permission],
    [Config.node, config],
    [Image.node, imageLayer],
    [LocationMutation.node, mutation],
    [FSUtil.node, testFileSystem],
    [Location.node, locationLayer],
    [Global.node, Global.layerWith({ data: Global.Path.data })],
    [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
    ...replacements,
  ])
const it = testEffect(readLayer(imageLayer))
const itWithoutResizer = testEffect(readLayer(unavailableImage))
const itFiles = testEffect(
  Layer.mergeAll(readLayer(imageLayer, LayerNode.compile(ReadToolFileSystem.node)), LayerNode.compile(FSUtil.node)),
)
const sessionID = SessionV2.ID.make("ses_read_tool_test")

describe("ReadTool", () => {
  beforeEach(() => {
    assertions.length = 0
    readCalls.length = 0
    listCalls.length = 0
    allow = true
    resolvedType = "file"
    resolveFailure = undefined
    readResult = {
      uri: "file:///README.md",
      name: "README.md",
      content: "hello",
      encoding: "utf8",
      mime: "text/plain",
    }
    readFailure = undefined
    configEntries = []
  })

  it.effect("registers, authorizes, and reads through the location filesystem", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service

      expect(yield* toolDefinitions(registry)).toMatchObject([{ name: "read", description: expect.stringContaining("After a successful edit, write, or apply_patch, skip re-reading the file to confirm—the tool errors if it didn't work.") }])
      expect(yield* toolDefinitions(registry, [{ action: "read", resource: "*", effect: "deny" }])).toEqual([])
      expect(
        yield* executeTool(registry, {
          sessionID,
          ...toolIdentity,
          call: { type: "tool-call", id: "call-read", name: "read", input: { path: "README.md" } },
        }),
      ).toEqual({
        type: "json",
        value: {
          uri: "file:///README.md",
          name: "README.md",
          content: "hello",
          encoding: "utf8",
          mime: "text/plain",
        },
      })
      expect(assertions).toMatchObject([{ sessionID, action: "read", resources: ["README.md"], save: ["*"] }])
      expect(readCalls).toEqual([
        {
          input: AbsolutePath.make(path.join(process.cwd(), "README.md")),
          page: { offset: undefined, limit: undefined },
        },
      ])
    }),
  )

  itFiles.live("attaches nearby rules using actual visible results without hiding file contents", () => Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const directory = yield* fs.makeTempDirectoryScoped()
    const nested = path.join(directory, "nested")
    const target = path.join(nested, "notes.txt")
    const rules = path.join(nested, "AGENTS.md")
    yield* fs.makeDirectory(nested, { recursive: true })
    yield* fs.writeFileString(path.join(directory, "AGENTS.md"), "Ambient root rule")
    yield* fs.writeFileString(rules, "Nearby rule body")
    yield* fs.writeFileString(path.join(nested, "CLAUDE.md"), "Shadowed rule")
    yield* fs.writeFileString(target, "Actual file body")
    let visible: SessionMessage.Message[] = []
    let lookups = 0
    yield* Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const read = (id = sessionID) => settleTool(registry, {
        sessionID: id, ...toolIdentity,
        call: { type: "tool-call", id: "nearby-read", name: "read", input: { path: target } },
      })
      const first = yield* read()
      if (!first.output) throw new Error("expected actual read output")
      expect(first.output.structured).toMatchObject({ content: "Actual file body", instructions: [{ path: rules, content: "Nearby rule body" }] })
      const text = first.output.content.flatMap(part => part.type === "text" ? [part.text] : []).join("\n")
      expect(text).toContain("Actual file body")
      expect(text).toContain(`Instructions from: ${rules}\nNearby rule body`)
      expect(text).not.toContain("Ambient root rule")
      expect(text).not.toContain("Shadowed rule")
      // 使用真实settlement构造持久结果；路径列表本身不能证明正文已经进入模型上下文。
      const history = (pruned?: number, bounded = false) => Schema.decodeUnknownSync(SessionMessage.Message)({
        id: "msg_nearby", type: "assistant", agent: "build", model: { id: "test", providerID: "test" }, time: { created: 0 },
        content: [{ type: "tool", id: "nearby-read", name: "read", time: { created: 0, ...(pruned === undefined ? {} : { pruned }) },
          state: { status: "completed", input: { path: target }, structured: first.output?.structured,
            content: bounded ? [{ type: "text", text: "[truncated]" }] : first.output?.content } }],
      })
      visible = [history()]
      expect((yield* read()).output?.structured).not.toHaveProperty("instructions")
      // 时间为零仍表示pruned；已截断正文、压缩后历史和另一Session均须重新发送规则。
      visible = [history(0)]
      expect((yield* read()).output?.structured).toHaveProperty("instructions")
      visible = [history(undefined, true)]
      expect((yield* read()).output?.structured).toHaveProperty("instructions")
      visible = []
      expect((yield* read()).output?.structured).toHaveProperty("instructions")
      visible = [history()]
      expect((yield* read(SessionV2.ID.make("ses_nearby_other"))).output?.structured).toHaveProperty("instructions")
      const source = path.join(nested, "large.ts")
      yield* fs.writeFileString(source, Array.from({ length: 700 }, (_, index) => index === 9 ? "export function alpha() {}" : index === 119 ? "export class Beta {}" : `// line ${index + 1} ${"x".repeat(48)}`).join("\n"))
      const sourceRead = (offset: number) => settleTool(registry, { sessionID, ...toolIdentity,
        call: { type: "tool-call", id: "outline-read", name: "read", input: { path: source, offset, limit: 20 } } })
      const head = yield* sourceRead(1)
      expect(head.output?.structured).toMatchObject({ read: { start: 1, totalExact: true, stub: false, cut: false } })
      const metadata = Schema.decodeUnknownSync(Schema.Struct({ read: ReadPresentation.ReadRangeMeta }))(head.output?.structured).read
      expect(metadata.total).toBe(700)
      const body = head.output?.content.flatMap(part => part.type === "text" ? [part.text] : []).join("\n") ?? ""
      expect(body).toContain("<outline")
      expect(body).toContain("10 function alpha")
      expect(body).toContain("120 class Beta")
      expect(body).toContain('<range start="1" end="20" total="700" returned="20" />')
      expect(body).toContain('reason="line_limit"')
      expect((yield* sourceRead(50)).output?.structured).not.toHaveProperty("outline")
      // 原生 schema 和 registry 后的真实结果必须保留证据，不能只测试纯 helper。
      const rawRead = (file: string) => settleTool(registry, { sessionID, ...toolIdentity,
        call: { type: "tool-call", id: "raw-channel", name: "read", input: { path: file } } })
      const xmlFile = path.join(nested, "raw.txt")
      yield* fs.writeFileString(xmlFile, '<tag attr="x">&</tag>\n')
      const rawFile = yield* rawRead(xmlFile)
      const fileText = rawFile.result.type === "text" ? rawFile.result.value : ""
      expect(fileText).toContain('1: <tag attr="x">&</tag>')
      expect(fileText).not.toContain("&lt;tag")
      const rawDirectory = path.join(nested, "raw-directory")
      yield* fs.makeDirectory(rawDirectory)
      yield* fs.writeFileString(path.join(rawDirectory, "a&b.txt"), "content")
      const directoryResult = yield* rawRead(rawDirectory)
      expect(directoryResult.result).toMatchObject({ type: "json", value: { entries: [{ path: "a&b.txt" }], total: 1, truncated: false } })
      const rustFile = path.join(nested, "generic.rs")
      yield* fs.writeFileString(rustFile, ["impl<T> Parser<T> where T: Clone {", ...Array.from({ length: 650 }, () => "// filler")].join("\n"))
      const rustResult = yield* rawRead(rustFile)
      const rustText = rustResult.result.type === "text" ? rustResult.result.value : ""
      expect(rustText).toContain("1 impl Parser<T>")
      expect(rustText).not.toContain("Parser&lt;T&gt;")
      // 三通道经过实际 reader、schema 和统一结算，不能只用纯渲染器自证原文。
      const before = lookups
      allow = false
      expect((yield* read()).result.type).toBe("error")
      expect(lookups).toBe(before)
    }).pipe(Effect.provide(readLayer(imageLayer, LayerNode.compile(ReadToolFileSystem.node), [
      [Location.node, Layer.succeed(Location.Service, location({ directory: AbsolutePath.make(directory) }))],
      [SessionStore.node, Layer.mock(SessionStore.Service, { context: id => Effect.sync(() => { lookups++; return id === sessionID ? visible : [] }) })],
      // 与生产Location构建一致隔离layer memo，不能复用外层fixture已捕获的cwd工具实例。
    ]).pipe(Layer.fresh)))
  }))

  it.effect("omits malware reminders without changing typed text or permission ordering", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      // 完整文件、无凭证旧结果和真实分页凭证都停用额外提醒，正文及next仍完整。
      for (const output of [readResult, new ReadToolFileSystem.TextPage({
        type: "text-page", content: "hello", mime: "text/plain", offset: 2, truncated: true, next: 3,
      }), new ReadToolFileSystem.TextPage({
        type: "text-page", content: "hello", mime: "text/plain", offset: 2, truncated: true, next: 3,
        read: {
          path: "sample.TS", canonicalPath: path.resolve("sample.TS"),
          type: "file", size: 12, modified: "2026-10-25 00:00:00", modifiedMs: 0,
          start: 2, end: 2, total: 3, totalExact: true, returned: 1, stub: false,
        },
      })]) {
        readResult = output
        const settled = yield* settleTool(registry, {
          sessionID,
          ...toolIdentity,
          call: { type: "tool-call", id: "call-cyber", name: "read", input: { path: "sample.TS" } },
        })
        expect(settled.output?.structured).toEqual(output)
        expect(JSON.stringify(settled.output)).not.toContain("MUST refuse to improve")
        if ("read" in output && ReadPresentation.isReadRangeMeta(output.read)) {
          expect(settled.output?.content).toEqual([{ type: "text", text: ReadPresentation.renderNativeRead({ ...output, read: output.read }) }])
        } else {
          // 旧结果继续走真实structured→JSON结算，不用空提醒替代正文与分页字段。
          expect(settled.output?.content).toEqual([])
          expect(settled.result).toEqual({ type: "json", value: output })
        }
      }
      // 停用模型提醒不改变权限门禁：拒绝时仍不执行读取。
      allow = false
      readCalls.length = 0
      expect(yield* executeTool(registry, {
        sessionID,
        ...toolIdentity,
        call: { type: "tool-call", id: "call-cyber-denied", name: "read", input: { path: "sample.ts" } },
      })).toEqual({ type: "error", value: "Unable to read sample.ts" })
      expect(readCalls).toEqual([])
    }),
  )

  it.effect("asks for external_directory approval before reading an external absolute path", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const external = path.join(path.parse(process.cwd()).root, "external-read", "notes.txt")

      expect(
        yield* executeTool(registry, {
          sessionID,
          ...toolIdentity,
          call: { type: "tool-call", id: "call-external-read", name: "read", input: { path: external } },
        }),
      ).toMatchObject({ type: "json" })
      expect(assertions).toMatchObject([
        {
          sessionID,
          action: "external_directory",
          resources: [path.join(path.dirname(external), "*").replaceAll("\\", "/")],
        },
        { sessionID, action: "read", resources: [external.replaceAll("\\", "/")], save: ["*"] },
      ])
      expect(readCalls).toEqual([{ input: AbsolutePath.make(external), page: { offset: undefined, limit: undefined } }])
    }),
  )

  itFiles.live("returns small PNG, BMP, TIFF and AVIF files as native model-supported media", () =>
    Effect.gen(function* () {
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
      const photon = yield* Effect.promise(() => import("@silvia-odwyer/photon-node"))
      const source = new photon.PhotonImage(new Uint8Array([255, 0, 0, 255]), 1, 1)
      const png = Buffer.from(source.get_bytes())
      source.free()
      const fs = yield* FSUtil.Service
      const directory = yield* fs.makeTempDirectoryScoped()
      const registry = yield* ToolRegistry.Service
      const { default: sharp } = yield* Effect.promise(() => import("sharp"))
      const tiff = yield* Effect.promise(() => sharp(png).tiff({ compression: "lzw" }).toBuffer())
      const avif = yield* Effect.promise(() => sharp(png).avif({ lossless: true }).toBuffer())
      for (const [name, data] of [
        ["pixel.png", png],
        ["pixel.bmp", bmp],
        ["pixel.tiff", tiff],
        ["pixel.avif", avif],
      ] as const) {
        const file = path.join(directory, name)
        yield* fs.writeFile(file, data)
        const settled = yield* settleTool(registry, {
          sessionID,
          ...toolIdentity,
          call: { type: "tool-call", id: `call-image-${name}`, name: "read", input: { path: file } },
        })
        expect(settled.result.type).toBe("content")
        if (settled.result.type !== "content") throw new Error("expected native image output")
        expect(settled.result.value).toHaveLength(2)
        expect(settled.result.value[0]).toEqual({ type: "text", text: "Image read successfully" })
        const attachment = settled.result.value[1]
        if (attachment.type !== "file" || !attachment.uri) throw new Error("expected image attachment")
        expect(attachment.name).toBe(file)
        expect(["image/jpeg", "image/png", "image/gif", "image/webp"]).toContain(attachment.mime)
        expect(attachment.mime).toBe("image/png")
        expect(attachment.uri.startsWith(`data:${attachment.mime};base64,`)).toBe(true)
        expect(Buffer.byteLength(attachment.uri.slice(attachment.uri.indexOf(";base64,") + 8), "utf-8")).toBeLessThanOrEqual(1600 * 750)
        const bytes = Buffer.from(attachment.uri.slice(attachment.uri.indexOf(";base64,") + 8), "base64")
        expect(Array.from(bytes.subarray(0, 8)))
          .toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
        const decoded = photon.PhotonImage.new_from_byteslice(bytes)
        expect(decoded.get_width()).toBe(1)
        expect(decoded.get_height()).toBe(1)
        decoded.free()
        expect(settled.output?.structured).toMatchObject({
          name,
          mime: attachment.mime,
          encoding: "base64",
        })
        expect(settled.output?.content).toMatchObject([
          { type: "text", text: "Image read successfully" },
          { type: "file", mime: attachment.mime, uri: attachment.uri },
        ])
        if (name === "pixel.png") {
          expect(attachment.mime).toBe("image/png")
          expect(attachment.uri).toBe(`data:image/png;base64,${png.toString("base64")}`)
        }
      }
      expect(readCalls).toEqual([])
    }),
  )

  it.effect("preserves a PNG above the generic text limit as native media", () =>
    Effect.gen(function* () {
      const photon = yield* Effect.promise(() => import("@silvia-odwyer/photon-node"))
      const pixels = Uint8Array.from({ length: 256 * 256 * 4 }, (_, index) => (index * 73 + (index >> 3)) % 256)
      const source = new photon.PhotonImage(pixels, 256, 256)
      const png = Buffer.from(source.get_bytes()).toString("base64")
      source.free()
      expect(Buffer.byteLength(png)).toBeGreaterThan(50 * 1024)
      readResult = {
        uri: "file:///large.png",
        name: "large.png",
        content: png,
        encoding: "base64",
        mime: "image/png",
      }
      const registry = yield* ToolRegistry.Service

      const settled = yield* settleTool(registry, {
        sessionID,
        ...toolIdentity,
        call: { type: "tool-call", id: "call-large-image", name: "read", input: { path: "large.png" } },
      })

      expect(settled.outputPaths).toBeUndefined()
      expect(settled.output?.structured).toMatchObject({
        uri: "file:///large.png",
        name: "large.png",
        mime: "image/png",
        encoding: "base64",
      })
      expect(settled.result).toEqual({
        type: "content",
        value: [
          { type: "text", text: "Image read successfully" },
          { type: "file", uri: `data:image/png;base64,${png}`, mime: "image/png", name: "large.png" },
        ],
      })

      const oversized = Buffer.from(yield* Effect.promise(() =>
        Bun.file(path.join(import.meta.dir, "../../opencode/test/image/fixtures/picture-5mb-base64.png")).arrayBuffer(),
      )).toString("base64")
      expect(oversized.length).toBe(5 * 1024 * 1024)
      readResult = { ...readResult, uri: "file:///budget.png", name: "budget.png", content: oversized }
      const bounded = yield* settleTool(registry, {
        sessionID,
        ...toolIdentity,
        call: { type: "tool-call", id: "call-image-budget", name: "read", input: { path: "budget.png" } },
      })
      expect(bounded.outputPaths).toBeUndefined()
      expect(bounded.result.type).toBe("content")
      if (bounded.result.type !== "content") throw new Error("expected bounded native image output")
      expect(bounded.result.value[0]).toEqual({ type: "text", text: "Image read successfully" })
      const attachment = bounded.result.value[1]
      if (attachment.type !== "file" || !attachment.uri) throw new Error("expected bounded image attachment")
      expect(["image/jpeg", "image/png", "image/gif", "image/webp"]).toContain(attachment.mime)
      expect(attachment.uri.startsWith(`data:${attachment.mime};base64,`)).toBe(true)
      const base64 = attachment.uri.slice(attachment.uri.indexOf(";base64,") + 8)
      expect(Buffer.byteLength(base64, "utf-8")).toBeLessThanOrEqual(1600 * 750)
      expect(base64).not.toBe(oversized)
      const decoded = photon.PhotonImage.new_from_byteslice(Buffer.from(base64, "base64"))
      expect(decoded.get_width()).toBeLessThanOrEqual(2_000)
      expect(decoded.get_height()).toBeLessThanOrEqual(2_000)
      decoded.free()
    }),
  )

  // #534：图片内容错误变为文本省略，不发送原始bytes；读取与权限错误仍失败。
  itWithoutResizer.effect("omits the image when the resizer is unavailable", () =>
    Effect.gen(function* () {
      const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
      readResult = {
        uri: "file:///pixel.png",
        name: "pixel.png",
        content: png,
        encoding: "base64",
        mime: "image/png",
      }
      const registry = yield* ToolRegistry.Service

      expect(
        yield* executeTool(registry, {
          sessionID,
          ...toolIdentity,
          call: { type: "tool-call", id: "call-image-fallback", name: "read", input: { path: "pixel.png" } },
        }),
      ).toMatchObject({ type: "json", value: { encoding: "utf8", mime: "text/plain", content: "Image omitted: could not be decoded or resized within the image size limit." } })
    }),
  )

  it.effect("omits invalid image data returned by the filesystem", () =>
    Effect.gen(function* () {
      readResult = {
        uri: "file:///truncated.png",
        name: "truncated.png",
        content: "iVBORw0KGgo=",
        encoding: "base64",
        mime: "image/png",
      }
      const registry = yield* ToolRegistry.Service

      expect(
        yield* executeTool(registry, {
          sessionID,
          ...toolIdentity,
          call: { type: "tool-call", id: "call-truncated-image", name: "read", input: { path: "truncated.png" } },
        }),
      ).toMatchObject({ type: "json", value: { encoding: "utf8", mime: "text/plain", content: "Image omitted: could not be decoded or resized within the image size limit." } })
    }),
  )

  it.effect("omits oversized images when resizing is disabled", () =>
    Effect.gen(function* () {
      const photon = yield* Effect.promise(() => import("@silvia-odwyer/photon-node"))
      const source = new photon.PhotonImage(new Uint8Array(Array.from({ length: 16 * 4 }, () => 255)), 16, 1)
      const base64 = Buffer.from(source.get_bytes()).toString("base64")
      source.free()
      readResult = {
        uri: "file:///wide.png",
        name: "wide.png",
        content: base64,
        encoding: "base64",
        mime: "image/png",
      }
      configEntries = [
        new Config.Document({
          type: "document",
          info: new Config.Info({
            attachments: new ConfigAttachments.Info({
              image: new ConfigAttachments.Image({ auto_resize: false, max_width: 4 }),
            }),
          }),
        }),
      ]
      const registry = yield* ToolRegistry.Service
      const result = yield* executeTool(registry, {
        sessionID,
        ...toolIdentity,
        call: { type: "tool-call", id: "call-wide-image", name: "read", input: { path: "wide.png" } },
      })

      expect(result.type).toBe("json")
      if (result.type === "json") expect(result.value).toMatchObject({ encoding: "utf8", mime: "text/plain", content: "Image omitted: could not be decoded or resized within the image size limit." })
    }),
  )

  it.effect("resizes images to configured dimensions before returning media", () =>
    Effect.gen(function* () {
      const photon = yield* Effect.promise(() => import("@silvia-odwyer/photon-node"))
      const source = new photon.PhotonImage(new Uint8Array(Array.from({ length: 16 * 4 }, () => 255)), 16, 1)
      const base64 = Buffer.from(source.get_bytes()).toString("base64")
      source.free()
      readResult = {
        uri: "file:///wide.png",
        name: "wide.png",
        content: base64,
        encoding: "base64",
        mime: "image/png",
      }
      configEntries = [
        new Config.Document({
          type: "document",
          info: new Config.Info({
            attachments: new ConfigAttachments.Info({ image: new ConfigAttachments.Image({ max_width: 4 }) }),
          }),
        }),
      ]
      const registry = yield* ToolRegistry.Service
      const result = yield* executeTool(registry, {
        sessionID,
        ...toolIdentity,
        call: { type: "tool-call", id: "call-resize-image", name: "read", input: { path: "wide.png" } },
      })

      expect(result.type).toBe("content")
      if (result.type !== "content") return
      const media = result.value[1]
      expect(media?.type).toBe("file")
      if (media?.type !== "file") return
      const resized = photon.PhotonImage.new_from_byteslice(Buffer.from(media.uri.split(",")[1] ?? "", "base64"))
      expect(resized.get_width()).toBeLessThanOrEqual(4)
      expect(resized.get_height()).toBeLessThanOrEqual(2_000)
      resized.free()
    }),
  )

  it.effect("enforces max base64 bytes after resize attempts", () =>
    Effect.gen(function* () {
      const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
      readResult = {
        uri: "file:///pixel.png",
        name: "pixel.png",
        content: png,
        encoding: "base64",
        mime: "image/png",
      }
      configEntries = [
        new Config.Document({
          type: "document",
          info: new Config.Info({
            attachments: new ConfigAttachments.Info({
              image: new ConfigAttachments.Image({ max_base64_bytes: 1 }),
            }),
          }),
        }),
      ]
      const registry = yield* ToolRegistry.Service
      const result = yield* executeTool(registry, {
        sessionID,
        ...toolIdentity,
        call: { type: "tool-call", id: "call-max-bytes", name: "read", input: { path: "pixel.png" } },
      })

      expect(result.type).toBe("json")
      if (result.type === "json") expect(result.value).toMatchObject({ encoding: "utf8", mime: "text/plain", content: "Image omitted: could not be decoded or resized within the image size limit." })
    }),
  )

  it.effect("returns supported image contents despite a misleading binary extension", () =>
    Effect.gen(function* () {
      const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
      readResult = {
        uri: "file:///pixel.bin",
        name: "pixel.bin",
        content: png,
        encoding: "base64",
        mime: "image/png",
      }
      const registry = yield* ToolRegistry.Service

      expect(
        yield* executeTool(registry, {
          sessionID,
          ...toolIdentity,
          call: { type: "tool-call", id: "call-disguised-image", name: "read", input: { path: "pixel.bin" } },
        }),
      ).toMatchObject({
        type: "content",
        value: [{ type: "text" }, { type: "file", mime: "image/png", name: "pixel.bin" }],
      })
    }),
  )

  it.effect("returns expected filesystem failures to the model", () =>
    Effect.gen(function* () {
      readFailure = new ReadToolFileSystem.BinaryFileError({ resource: "archive.dat" })
      const registry = yield* ToolRegistry.Service

      expect(
        yield* executeTool(registry, {
          sessionID,
          ...toolIdentity,
          call: {
            type: "tool-call",
            id: "call-binary",
            name: "read",
            input: { path: "archive.dat", offset: 2, limit: 1 },
          },
        }),
      ).toEqual({ type: "error", value: "Cannot read binary file: archive.dat" })
      expect(readCalls).toEqual([
        { input: AbsolutePath.make(path.join(process.cwd(), "archive.dat")), page: { offset: 2, limit: 1 } },
      ])
    }),
  )

  it.effect("preserves unexpected filesystem defects", () =>
    Effect.gen(function* () {
      resolveFailure = new Error("unexpected")
      const registry = yield* ToolRegistry.Service

      expect(
        Exit.isFailure(
          yield* executeTool(registry, {
            sessionID,
            ...toolIdentity,
            call: { type: "tool-call", id: "call-defect", name: "read", input: { path: "README.md" } },
          }).pipe(Effect.exit),
        ),
      ).toBe(true)
    }),
  )

  it.effect("does not read when permission is denied", () =>
    Effect.gen(function* () {
      allow = false
      const registry = yield* ToolRegistry.Service

      expect(
        yield* executeTool(registry, {
          sessionID,
          ...toolIdentity,
          call: { type: "tool-call", id: "call-read", name: "read", input: { path: "README.md" } },
        }),
      ).toEqual({ type: "error", value: "Unable to read README.md" })
      expect(readCalls).toEqual([])
    }),
  )

  it.effect("returns missing paths as model-visible tool failures", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service

      expect(
        yield* executeTool(registry, {
          sessionID,
          ...toolIdentity,
          call: { type: "tool-call", id: "call-missing-path", name: "read", input: { path: missingPath } },
        }),
      ).toEqual({ type: "error", value: `Unable to read ${missingPath}` })
      expect(assertions).toEqual([])
      expect(readCalls).toEqual([])
    }),
  )

  it.effect("lists a bounded directory page through read", () =>
    Effect.gen(function* () {
      resolvedType = "directory"
      const registry = yield* ToolRegistry.Service

      expect(
        yield* executeTool(registry, {
          sessionID,
          ...toolIdentity,
          call: {
            type: "tool-call",
            id: "call-read-directory",
            name: "read",
            input: { path: "src", offset: 2, limit: 10 },
          },
        }),
      ).toEqual({ type: "json", value: { entries: [], truncated: false } })
      expect(assertions).toMatchObject([{ sessionID, action: "read", resources: ["src"], save: ["*"] }])
      expect(listCalls).toEqual([{ offset: 2, limit: 10 }])
    }),
  )

  it.effect("does not list a directory when permission is denied", () =>
    Effect.gen(function* () {
      allow = false
      resolvedType = "directory"
      const registry = yield* ToolRegistry.Service

      expect(
        yield* executeTool(registry, {
          sessionID,
          ...toolIdentity,
          call: { type: "tool-call", id: "call-read-directory-denied", name: "read", input: { path: "src" } },
        }),
      ).toEqual({ type: "error", value: "Unable to read src" })
      expect(listCalls).toEqual([])
    }),
  )

  it.effect("preserves unexpected resolution defects", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service

      resolveFailure = new Error("missing")
      expect(
        Exit.isFailure(
          yield* executeTool(registry, {
            sessionID,
            ...toolIdentity,
            call: { type: "tool-call", id: "call-missing", name: "read", input: { path: "missing.txt" } },
          }).pipe(Effect.exit),
        ),
      ).toBe(true)

      expect(readCalls).toEqual([])
    }),
  )

  it.effect("forwards pagination and returns bounded text pages with continuation", () =>
    Effect.gen(function* () {
      readResult = new ReadToolFileSystem.TextPage({
        type: "text-page",
        content: "hello",
        mime: "text/plain",
        offset: 2,
        truncated: true,
        next: 3,
      })
      const registry = yield* ToolRegistry.Service

      expect(
        yield* executeTool(registry, {
          sessionID,
          ...toolIdentity,
          call: {
            type: "tool-call",
            id: "call-large",
            name: "read",
            input: { path: "large.txt", offset: 2, limit: 1 },
          },
        }),
      ).toEqual({
        type: "json",
        value: { type: "text-page", content: "hello", mime: "text/plain", offset: 2, truncated: true, next: 3 },
      })
      expect(readCalls).toEqual([
        { input: AbsolutePath.make(path.join(process.cwd(), "large.txt")), page: { offset: 2, limit: 1 } },
      ])
    }),
  )

  it.effect("rejects unsupported binary discovered by a direct read", () =>
    Effect.gen(function* () {
      readResult = {
        uri: "file:///late-binary",
        name: "late-binary",
        content: "AAECAw==",
        encoding: "base64",
        mime: "application/octet-stream",
      }
      const registry = yield* ToolRegistry.Service

      expect(
        yield* executeTool(registry, {
          sessionID,
          ...toolIdentity,
          call: { type: "tool-call", id: "call-direct-binary", name: "read", input: { path: "late-binary" } },
        }),
      ).toEqual({ type: "error", value: "Cannot read binary file: late-binary" })
    }),
  )
})
