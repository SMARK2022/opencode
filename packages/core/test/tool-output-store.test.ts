import { describe, expect } from "bun:test"
import path from "path"
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Option, PlatformError } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { Config } from "@opencode-ai/core/config"
import { ConfigToolOutput } from "@opencode-ai/core/config/tool-output"
import { SessionV2 } from "@opencode-ai/core/session"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { testEffect } from "./lib/effect"
import { tmpdir } from "./fixture/tmpdir"

const sessionID = SessionV2.ID.make("ses_tool_output_store")

const withStore = <A, E, R>(
  body: (input: { root: string; store: ToolOutputStore.Interface; fs: FSUtil.Interface }) => Effect.Effect<A, E, R>,
  config?: Config.Info,
  filesystem: Layer.Layer<FSUtil.Service> = LayerNode.compile(FSUtil.node),
) =>
  Effect.acquireUseRelease(
    Effect.promise(() => tmpdir()),
    (tmp) => {
      const global = Global.layerWith({ data: tmp.path })
      const configured = config
        ? Layer.succeed(
            Config.Service,
            Config.Service.of({
              entries: () => Effect.succeed([new Config.Document({ type: "document", info: config })]),
            }),
          )
        : Layer.empty

      const store = AppNodeBuilder.build(LayerNode.group([ToolOutputStore.node, FSUtil.node]), [
        [Global.node, global],
        [Config.node, configured],
        [FSUtil.node, filesystem],
      ])
      return Effect.gen(function* () {
        return yield* body({ root: tmp.path, store: yield* ToolOutputStore.Service, fs: yield* FSUtil.Service })
      }).pipe(Effect.provide(store))
    },
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  )

const it = testEffect(Layer.empty)

describe("ToolOutputStore", () => {
  it.live("bounds the provider-facing text channel with one managed file", () =>
    withStore(({ store, fs }) =>
      Effect.gen(function* () {
        const first = "HEAD-\u001b[31msafe\u0007end\u001b[0m\r\n" + "x".repeat(30_000)
        const second = "y".repeat(30_000) + "-TAIL"
        const result = yield* store.bound({
          sessionID,
          toolCallID: "call-aggregate",
          output: {
            structured: { kind: "report" },
            content: [
              { type: "text", text: first },
              { type: "text", text: second },
            ],
          },
        })
        expect(result.output.structured).toEqual({ kind: "report" })
        expect(result.outputPaths).toHaveLength(1)
        expect(yield* fs.readFileString(result.outputPaths[0])).toBe(first + second)
        if (result.output.content[0]?.type !== "text") throw new Error("expected text preview")
        expect(Buffer.byteLength(result.output.content[0].text)).toBeLessThanOrEqual(ToolOutputStore.MAX_BYTES)
        expect(result.output.content[0].text).toContain("HEAD-safe\\x07end\n")
        expect(result.output.content[0].text).not.toContain("\u0007")
        expect(result.output.content[0].text).not.toContain("\u001b")
        // total对应归档，shown只对应head/tail正文，不将notice自身算入预览。
        const visible = result.output.content[0].text
        expect(visible).toContain('type="output_truncated" source="tool"')
        expect(visible).toContain(`path="${result.outputPaths[0]}" />`)
        expect(visible).toMatch(/total="2L\/59KB"/)
        const excerpt = visible.replace(/\n\n<opencode_notice[^>]+ \/>\n\n/, "\n")
        expect(visible).toContain(`shown="head+tail ${excerpt.split("\n").length}L/`)
      }),
    ),
  )

  it.live("uses bounded text for oversized structured-only output", () =>
    withStore(({ store, fs }) =>
      Effect.gen(function* () {
        const structured = { text: "x".repeat(ToolOutputStore.MAX_BYTES) }
        const result = yield* store.bound({ sessionID, toolCallID: "call-json", output: { structured, content: [] } })
        expect(result.output.structured).toEqual(structured)
        expect(result.outputPaths).toHaveLength(1)
        expect(JSON.parse(yield* fs.readFileString(result.outputPaths[0]))).toEqual(structured)
        expect(result.output.content).toHaveLength(1)
      }),
    ),
  )

  it.live("preserves native media and structured metadata without applying a settlement media limit", () =>
    withStore(({ store }) =>
      Effect.gen(function* () {
        const data = "a".repeat(6 * 1024 * 1024)
        const result = yield* store.bound({
          sessionID,
          toolCallID: "call-file",
          output: {
            structured: { caption: "pixel" },
            content: [{ type: "file", uri: `data:image/png;base64,${data}`, mime: "image/png", name: "pixel.png" }],
          },
        })
        expect(result.outputPaths).toEqual([])
        expect(result.output.structured).toEqual({ caption: "pixel" })
        expect(result.output.content).toHaveLength(1)
        expect(result.output.content[0]).toEqual({
          type: "file",
          uri: `data:image/png;base64,${data}`,
          mime: "image/png",
          name: "pixel.png",
        })
      }),
    ),
  )

  it.live("preserves structured metadata and native media when bounding text", () =>
    withStore(({ store, fs }) =>
      Effect.gen(function* () {
        const text = "x".repeat(ToolOutputStore.MAX_BYTES + 1)
        const media = {
          type: "file" as const,
          uri: "data:image/png;base64,aGVsbG8=",
          mime: "image/png",
          name: "pixel.png",
        }
        const result = yield* store.bound({
          sessionID,
          toolCallID: "call-text-and-media",
          output: { structured: { caption: "pixel", formattedContent: "code\u0007\r\n" }, content: [{ type: "text", text }, media] },
        })

        // structured承载后续历史回写真值，不能随正文一起改写真实代码。
        expect(result.output.structured).toEqual({ caption: "pixel", formattedContent: "code\u0007\r\n" })
        expect(result.output.content[1]).toEqual(media)
        expect(yield* fs.readFileString(result.outputPaths[0])).toBe(text)
      }),
    ),
  )

  it.live("does not double-count structured data duplicated in projected text", () =>
    withStore(({ root, store, fs }) =>
      Effect.gen(function* () {
        // 非 capture 调用的最终清理不能创建目录或影响其它托管文件。
        const directory = path.join(root, ToolOutputStore.MANAGED_DIRECTORY)
        yield* store.discard({ sessionID, toolCallID: "call-duplicated" })
        expect(yield* fs.exists(directory)).toBe(false)
        // 固定单份低于预算、双份超过预算；不能让 fixture 随实现常量一起漂移而失去辨错力。
        const text = "x".repeat(16_000)
        expect(ToolOutputStore.MAX_BYTES).toBe(16 * 1024)
        expect(Buffer.byteLength(text)).toBeLessThan(ToolOutputStore.MAX_BYTES)
        expect(Buffer.byteLength(text) * 2).toBeGreaterThan(ToolOutputStore.MAX_BYTES)
        const output = { structured: { output: text }, content: [{ type: "text" as const, text }] }
        expect(yield* store.bound({ sessionID, toolCallID: "call-duplicated", output })).toEqual({
          output,
          outputPaths: [],
        })
        // 小输出只存在有界内存中，bound/discard 均不能为它创建目录。
        const input = { sessionID, toolCallID: "call-captured", output }
        yield* store.capture(input, (write) => write(Buffer.from(text)).pipe(Effect.as({ value: output, retain: false })))
        expect(yield* fs.exists(directory)).toBe(false)
        expect(yield* store.bound(input)).toEqual({ output, outputPaths: [] })
        yield* store.discard(input)
        expect(yield* fs.exists(directory)).toBe(false)
        yield* store.discard(input)
        expect(yield* fs.exists(directory)).toBe(false)
        // bound 已发布的原文脱离暂存表，最终清理不能删除模型仍需要恢复的内容。
        yield* store.capture(input, (write) => write(Buffer.from(text)).pipe(Effect.as({ value: output, retain: true })))
        const published = yield* store.bound(input)
        expect(published.outputPaths).toHaveLength(1)
        yield* store.discard(input)
        const saved = published.outputPaths[0]
        if (!saved) throw new Error("expected published raw output")
        expect(yield* fs.readFileString(saved)).toBe(text)
        expect(yield* fs.readDirectory(directory)).toHaveLength(1)
        // 两次写入跨越flush；UTF-16原字节不能由UTF-8模型窗口反推。
        const bytes = Buffer.from("AB".repeat(20_000), "utf16le")
        yield* store.capture(input, (write) => Effect.gen(function* () {
          yield* write(bytes.subarray(0, 20_000))
          yield* write(bytes.subarray(20_000))
          return { value: undefined, retain: true }
        }))
        const captured = yield* store.bound({ ...input, output: { structured: {}, content: [{ type: "text", text: "x".repeat(20_000) }] } })
        expect(Buffer.from(yield* fs.readFile(captured.outputPaths[0]))).toEqual(bytes)
        const notice = captured.output.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("")
        expect(notice).toContain('total="78KB"')
        expect(notice).not.toContain('total="1L/')
        expect(notice).toContain(`path="${captured.outputPaths[0]}" />`)
        expect(Buffer.byteLength(notice)).toBeLessThanOrEqual(ToolOutputStore.MAX_BYTES)
      }),
    ),
  )

  it.live("fails oversized settlement when complete retention cannot be written", () => {
    // 故障只注入 append 的字节写入，初始文件创建与清理继续使用真实文件系统。
    const failure = PlatformError.systemError({ _tag: "Unknown", module: "FileSystem", method: "writeFile", description: "ENOSPC: quota exhausted" })
    const filesystem = Layer.effect(FSUtil.Service, Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      return FSUtil.Service.of({ ...fs, writeFile: () => Effect.fail(failure) })
    })).pipe(Layer.provide(LayerNode.compile(FSUtil.node)))
    return withStore(({ root, store, fs }) =>
      Effect.gen(function* () {
        yield* fs.writeFileString(path.join(root, "tool-output"), "not a directory")
        const exit = yield* store
          .bound({
            sessionID,
            toolCallID: "call-lossy",
            output: { structured: {}, content: [{ type: "text", text: "x".repeat(ToolOutputStore.MAX_BYTES + 1) }] },
          })
          .pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit))
          expect(Option.getOrUndefined(Cause.findErrorOption(exit.cause))?._tag).toBe("ToolOutputStore.StorageError")
      }),
    ).pipe(Effect.andThen(withStore(({ root, store, fs }) => Effect.gen(function* () {
      const input = { sessionID, toolCallID: "call-append-failure" }
      const directory = path.join(root, ToolOutputStore.MANAGED_DIRECTORY)
      const exit = yield* store.capture(input, (write) => Effect.gen(function* () {
        // 跨阈值触发真实创建后 append 失败，不能以初始 write 失败替代回归。
        expect(yield* fs.exists(directory)).toBe(false)
        yield* write(Buffer.alloc(ToolOutputStore.MAX_BYTES + 1))
        return { value: undefined, retain: true }
      })).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const error = Option.getOrUndefined(Cause.findErrorOption(exit.cause))
        // 错误保持原始 cause 身份，不能通过包装成 defect 或丢失配额原因来通过断言。
        if (!(error instanceof ToolOutputStore.StorageError)) throw new Error("expected typed append failure")
        expect(error.operation).toBe("write")
        expect(error.cause).toBe(failure)
      }
      yield* store.discard(input)
      expect(yield* fs.readDirectory(directory)).toEqual([])
    }), undefined, filesystem)), Effect.andThen(Effect.gen(function* () {
      const created = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      let bodies = 0
      let writes = 0
      // 初始 wx 已创建文件但尚未返回，取消请求必须在挂接清理后才被交付。
      const delayed = Layer.effect(FSUtil.Service, Effect.gen(function* () {
        const native = yield* FSUtil.Service
        return FSUtil.Service.of({ ...native, writeFileString: (file, text, options) => native.writeFileString(file, text, options).pipe(
          Effect.andThen(Effect.sync(() => writes++)),
          Effect.andThen(Deferred.succeed(created, undefined)),
          Effect.andThen(Deferred.await(release)),
        ) })
      })).pipe(Layer.provide(LayerNode.compile(FSUtil.node)))
      yield* withStore(({ root, store, fs }) => Effect.gen(function* () {
        const directory = path.join(root, ToolOutputStore.MANAGED_DIRECTORY)
        const foreign = path.join(directory, "foreign-output")
        yield* fs.ensureDir(directory)
        yield* fs.writeFile(foreign, Buffer.from("owned by another call"))
        const input = { sessionID, toolCallID: "call-initial-cancel" }
        // 正文必须保持可中断，挂起的创建阶段结束后不能执行用户副作用。
        const fiber = yield* store.capture(input, (write) => write(Buffer.alloc(ToolOutputStore.MAX_BYTES + 1)).pipe(Effect.andThen(Effect.sync(() => { bodies++; return { value: undefined, retain: true } })))).pipe(Effect.forkChild)
        yield* Deferred.await(created)
        expect(yield* fs.readDirectory(directory)).toHaveLength(2)
        // 中断等待者另起 fiber，主测试仍能释放被保护的短 acquisition。
        const interrupting = yield* Fiber.interrupt(fiber).pipe(Effect.forkChild)
        yield* Effect.yieldNow
        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(interrupting)
        yield* store.discard(input)
        expect(bodies).toBe(0)
        expect(writes).toBe(1)
        // 清理只删除本次取得的路径，不以清空目录替代所有权判断。
        expect(yield* fs.readDirectory(directory)).toEqual(["foreign-output"])
        expect(yield* fs.readFileString(foreign)).toBe("owned by another call")
      }), undefined, delayed)
      // 真实 wx 碰撞不授予所有权，失败 cause 必须保留且既有文件不能被删除。
      let collision: FSUtil.Error | undefined
      const colliding = Layer.effect(FSUtil.Service, Effect.gen(function* () {
        const native = yield* FSUtil.Service
        return FSUtil.Service.of({ ...native, writeFileString: (file, text, options) => native.writeFileString(file, "collision owner").pipe(
          Effect.andThen(native.writeFileString(file, text, options)),
          Effect.tapError((cause) => Effect.sync(() => { collision = cause })),
        ) })
      })).pipe(Layer.provide(LayerNode.compile(FSUtil.node)))
      yield* withStore(({ root, store, fs }) => Effect.gen(function* () {
        const exit = yield* store.capture({ sessionID, toolCallID: "call-collision" }, (write) => write(Buffer.alloc(ToolOutputStore.MAX_BYTES + 1)).pipe(Effect.andThen(Effect.die("collision must not continue body")))).pipe(Effect.exit)
        if (!Exit.isFailure(exit)) throw new Error("expected exclusive creation failure")
        const error = Option.getOrUndefined(Cause.findErrorOption(exit.cause))
        if (!(error instanceof ToolOutputStore.StorageError)) throw new Error("expected typed collision failure")
        expect(error.cause).toBe(collision)
        const directory = path.join(root, ToolOutputStore.MANAGED_DIRECTORY)
        const files = yield* fs.readDirectory(directory)
        expect(files).toHaveLength(1)
        // 文件内容和原始失败身份共同证明 wx 没有覆盖或删除别人的输出。
        expect(yield* fs.readFileString(path.join(directory, files[0]))).toBe("collision owner")
      }), undefined, colliding)
    })))
  },
  )

  it.live("does not encode ignored structured metadata when projected content exists", () =>
    withStore(({ store }) =>
      Effect.gen(function* () {
        const output = { structured: { value: 1n }, content: [{ type: "text" as const, text: "readable text" }] }
        expect(yield* store.bound({ sessionID, toolCallID: "call-unencodable", output })).toEqual({
          output,
          outputPaths: [],
        })
      }),
    ),
  )

  it.live("preserves interruption while retaining complete output", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => tmpdir())
      const blockedFilesystem = Layer.effect(
        FSUtil.Service,
        Effect.gen(function* () {
          const fs = yield* FSUtil.Service
          return FSUtil.Service.of({
            ...fs,
            ensureDir: () => Effect.void,
            writeFileString: () => Effect.never,
          })
        }),
      ).pipe(Layer.provide(LayerNode.compile(FSUtil.node)))
      const store = AppNodeBuilder.build(ToolOutputStore.nodeWithoutConfig, [
        [Global.node, Global.layerWith({ data: root.path })],
        [FSUtil.node, blockedFilesystem],
      ])
      const exit = yield* Effect.gen(function* () {
        const service = yield* ToolOutputStore.Service
        const fiber = yield* service
          .bound({
            sessionID,
            toolCallID: "call-interrupted",
            output: { structured: {}, content: [{ type: "text", text: "x".repeat(ToolOutputStore.MAX_BYTES + 1) }] },
          })
          .pipe(Effect.forkChild)
        yield* Fiber.interrupt(fiber)
        return yield* Fiber.await(fiber)
      }).pipe(Effect.provide(store))
      expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
      yield* Effect.promise(() => root[Symbol.asyncDispose]())
    }),
  )

  it.live("honors configured limits", () =>
    withStore(
      ({ store, fs }) =>
        Effect.gen(function* () {
          expect(yield* store.limits()).toEqual({ maxLines: 2, maxBytes: 1 })
          const result = yield* store.bound({
            sessionID,
            toolCallID: "call-config",
            output: { structured: {}, content: [{ type: "text", text: "one\ntwo\nthree" }] },
          })
          expect(result.outputPaths).toHaveLength(1)
          // 恢复地址即使超过极小预算也必须完整；空预览不能报成原文丢失。
          const text = result.output.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("")
          expect(text).toContain('total="3L/13B" shown="head 0L/0B"')
          expect(text).toContain(`path="${result.outputPaths[0]}" />`)
          expect(text).toStartWith("<opencode_notice ")
          expect(yield* fs.readFileString(result.outputPaths[0])).toBe("one\ntwo\nthree")
        }),
      new Config.Info({ tool_output: new ConfigToolOutput.Info({ max_lines: 2, max_bytes: 1 }) }),
    ),
  )

  it.live("cleans expired managed files and preserves unrelated files", () =>
    withStore(({ root, store, fs }) =>
      Effect.gen(function* () {
        const old = path.join(root, "tool-output", "tool_old")
        const recent = path.join(root, "tool-output", "tool_recent")
        const unrelated = path.join(root, "tool-output", "keep.txt")
        yield* fs.ensureDir(path.join(root, "tool-output"))
        yield* fs.writeFileString(old, "old")
        yield* fs.writeFileString(recent, "recent")
        yield* fs.writeFileString(unrelated, "keep")
        const expired = new Date(Date.now() - 8 * 24 * 60 * 60 * 1_000)
        yield* fs.utimes(old, expired, expired)
        yield* store.cleanup()
        expect(yield* fs.exists(old)).toBe(false)
        expect(yield* fs.exists(recent)).toBe(true)
        expect(yield* fs.exists(unrelated)).toBe(true)
      }),
    ),
  )
})
