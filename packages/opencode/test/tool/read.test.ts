import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { afterEach, describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Cause, Effect, Exit, Layer, Schema, Stream } from "effect"
import path from "path"
import { readOutline } from "../../src/tool/read-outline"
import { Agent } from "../../src/agent/agent"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { Config } from "@/config/config"
import { Image } from "@/image/image"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { LSP } from "@/lsp/lsp"
import { Permission } from "../../src/permission"
import { SessionID, MessageID, PartID } from "../../src/session/schema"
import { Instruction } from "../../src/session/instruction"
import { ReadTool } from "../../src/tool/read"
import { FILE_UNCHANGED_STUB } from "../../src/tool/read"
import { Truncate } from "@/tool/truncate"
import { Tool } from "@/tool/tool"
import { Filesystem } from "@/util/filesystem"
import {
  disposeAllInstances,
  provideInstance,
  testInstanceStoreLayer,
  TestInstance,
  tmpdirScoped,
} from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const FIXTURES_DIR = path.join(import.meta.dir, "fixtures")

afterEach(async () => {
  await disposeAllInstances()
})

const ctx = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

const readLayer = (flags: Partial<RuntimeFlags.Info> = {}, imageNode = Image.node) =>
  LayerNode.compile(
    LayerNode.group([
      Agent.node,
      FSUtil.node,
      CrossSpawnSpawner.node,
      Instruction.node,
      // 可注入失败的 Image.Service，默认仍使用真实 Photon resizer。
      imageNode,
      LSP.node,
      Ripgrep.node,
      Truncate.node,
    ]),
  )

const it = testEffect(Layer.mergeAll(readLayer(), testInstanceStoreLayer))

// 只模拟 resizer 无法加载，解码与预算用例继续走真实实现。
const noResizerImageNode = LayerNode.make({
  service: Image.Service,
  layer: Layer.succeed(
    Image.Service,
    Image.Service.of({
      normalize: () => Effect.fail(new Image.ResizerUnavailableError()),
    }),
  ),
  deps: [],
})
const noResizer = testEffect(Layer.mergeAll(readLayer({}, noResizerImageNode), testInstanceStoreLayer))

const init = Effect.fn("ReadToolTest.init")(function* () {
  const info = yield* ReadTool
  return yield* info.init()
})

const run = Effect.fn("ReadToolTest.run")(function* (
  args: Tool.InferParameters<typeof ReadTool>,
  next: Tool.Context = ctx,
) {
  const tool = yield* init()
  return yield* tool.execute(args, next)
})

const exec = Effect.fn("ReadToolTest.exec")(function* (
  dir: string,
  args: Tool.InferParameters<typeof ReadTool>,
  next: Tool.Context = ctx,
) {
  return yield* provideInstance(dir)(run(args, next))
})

const fail = Effect.fn("ReadToolTest.fail")(function* (
  dir: string,
  args: Tool.InferParameters<typeof ReadTool>,
  next: Tool.Context = ctx,
) {
  const exit = yield* exec(dir, args, next).pipe(Effect.exit)
  if (Exit.isFailure(exit)) {
    const err = Cause.squash(exit.cause)
    return err instanceof Error ? err : new Error(String(err))
  }
  throw new Error("expected read to fail")
})

const full = (p: string) => (process.platform === "win32" ? Filesystem.normalizePath(p) : p)
const glob = (p: string) =>
  process.platform === "win32" ? Filesystem.normalizePathPattern(p) : p.replaceAll("\\", "/")
const githubBase = <A, E, R>(url: string, self: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = process.env.OPENCODE_REPO_CLONE_GITHUB_BASE_URL
      process.env.OPENCODE_REPO_CLONE_GITHUB_BASE_URL = url
      return previous
    }),
    () => self,
    (previous) =>
      Effect.sync(() => {
        if (previous) process.env.OPENCODE_REPO_CLONE_GITHUB_BASE_URL = previous
        else delete process.env.OPENCODE_REPO_CLONE_GITHUB_BASE_URL
      }),
  )
const git = Effect.fn("ReadToolTest.git")(function* (cwd: string, args: string[]) {
  return yield* Effect.promise(async () => {
    const proc = Bun.spawn(["git", ...args], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    if (code !== 0) throw new Error(stderr.trim() || stdout.trim() || `git ${args.join(" ")} failed`)
    return stdout.trim()
  })
})
const put = Effect.fn("ReadToolTest.put")(function* (p: string, content: string | Buffer | Uint8Array) {
  const fs = yield* FSUtil.Service
  yield* fs.writeWithDirs(p, content)
})
const load = Effect.fn("ReadToolTest.load")(function* (p: string) {
  const fs = yield* FSUtil.Service
  return yield* fs.readFileString(p)
})
const asks = () => {
  const items: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
  return {
    items,
    next: {
      ...ctx,
      ask: (req: Omit<PermissionV1.Request, "id" | "sessionID" | "tool">) =>
        Effect.sync(() => {
          items.push(req)
        }),
    },
  }
}

describe("tool.read external_directory permission", () => {
  it.live("allows reading absolute path inside project directory", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* put(path.join(dir, "test.txt"), "hello world")

      const result = yield* exec(dir, { filePath: path.join(dir, "test.txt") })
      expect(result.output).toContain("hello world")
    }),
  )

  it.live("allows reading file in subdirectory inside project directory", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* put(path.join(dir, "subdir", "test.txt"), "nested content")

      const result = yield* exec(dir, { filePath: path.join(dir, "subdir", "test.txt") })
      expect(result.output).toContain("nested content")
    }),
  )

  it.live("asks for external_directory permission when reading absolute path outside project", () =>
    Effect.gen(function* () {
      const outer = yield* tmpdirScoped()
      const dir = yield* tmpdirScoped({ git: true })
      yield* put(path.join(outer, "secret.txt"), "secret data")

      const { items, next } = asks()

      yield* exec(dir, { filePath: path.join(outer, "secret.txt") }, next)
      const ext = items.find((item) => item.permission === "external_directory")
      expect(ext).toBeDefined()
      expect(ext!.patterns).toContain(glob(path.join(outer, "*")))
    }),
  )

  if (process.platform === "win32") {
    it.live("normalizes read permission paths on Windows", () =>
      Effect.gen(function* () {
        const dir = yield* tmpdirScoped({ git: true })
        yield* put(path.join(dir, "test.txt"), "hello world")

        const { items, next } = asks()
        const target = path.join(dir, "test.txt")
        // 驱动器别名交给实际路径规范化；保留其余路径大小写，不能改写文件身份。
        const alt = target.replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`).replaceAll("\\", "/")

        yield* exec(dir, { filePath: alt }, next)
        const read = items.find((item) => item.permission === "read")
        expect(read).toBeDefined()
        expect(read!.patterns).toEqual([path.relative(dir, full(target))])
      }),
    )
  }

  it.live("uses worktree-relative path for read permission so user rules match like edit/write", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      yield* put(path.join(dir, "src", "secret.ts"), "shh")

      const { items, next } = asks()
      yield* exec(dir, { filePath: path.join(dir, "src", "secret.ts") }, next)
      const read = items.find((item) => item.permission === "read")
      expect(read).toBeDefined()
      expect(read!.patterns).toEqual([path.join("src", "secret.ts")])
    }),
  )

  it.live("asks for directory-scoped external_directory permission when reading external directory", () =>
    Effect.gen(function* () {
      const outer = yield* tmpdirScoped()
      const dir = yield* tmpdirScoped({ git: true })
      yield* put(path.join(outer, "external", "a.txt"), "a")

      const { items, next } = asks()

      yield* exec(dir, { filePath: path.join(outer, "external") }, next)
      const ext = items.find((item) => item.permission === "external_directory")
      expect(ext).toBeDefined()
      expect(ext!.patterns).toContain(glob(path.join(outer, "external", "*")))
    }),
  )

  it.live("asks for external_directory permission when reading relative path outside project", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })

      const { items, next } = asks()

      yield* fail(dir, { filePath: "../outside.txt" }, next)
      const ext = items.find((item) => item.permission === "external_directory")
      expect(ext).toBeDefined()
    }),
  )

  it.live("does not ask for external_directory permission when reading inside project", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      yield* put(path.join(dir, "internal.txt"), "internal content")

      const { items, next } = asks()

      yield* exec(dir, { filePath: path.join(dir, "internal.txt") }, next)
      const ext = items.find((item) => item.permission === "external_directory")
      expect(ext).toBeUndefined()
    }),
  )
})

describe("tool.read env file permissions", () => {
  const cases: [string, boolean][] = [
    [".env", true],
    [".env.local", true],
    [".env.production", true],
    [".env.development.local", true],
    [".env.example", false],
    [".envrc", false],
    ["environment.ts", false],
  ]

  for (const agentName of ["build", "plan"] as const) {
    describe(`agent=${agentName}`, () => {
      for (const [filename, shouldAsk] of cases) {
        it.live(`${filename} asks=${shouldAsk}`, () =>
          Effect.gen(function* () {
            const dir = yield* tmpdirScoped()
            yield* put(path.join(dir, filename), "content")

            const asked = yield* provideInstance(dir)(
              Effect.gen(function* () {
                const agent = yield* Agent.Service
                const info = yield* agent.get(agentName)
                let asked = false
                const next = {
                  ...ctx,
                  ask: (req: Omit<PermissionV1.Request, "id" | "sessionID" | "tool">) =>
                    Effect.sync(() => {
                      for (const pattern of req.patterns) {
                        const rule = Permission.evaluate(req.permission, pattern, info.permission)
                        if (rule.action === "ask" && req.permission === "read") {
                          asked = true
                        }
                        if (rule.action === "deny") {
                          throw new PermissionV1.DeniedError({ ruleset: info.permission })
                        }
                      }
                    }),
                }

                yield* run({ filePath: path.join(dir, filename) }, next)
                return asked
              }),
            )

            expect(asked).toBe(shouldAsk)
          }),
        )
      }
    })
  }
})

describe("tool.read truncation", () => {
  it.live("deduplicates only the current session's visible complete version", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const target = path.join(dir, "version.txt")
      if (process.platform === "linux") {
        const fs = yield* FSUtil.Service
        const device = path.join(dir, "device")
        // 使用真实设备软链接证明实际 stat guard，不能只测试 /dev/zero 的字面黑名单。
        yield* fs.symlink("/dev/zero", device)
        const denied = yield* fail(dir, { filePath: device }).pipe(Effect.timeout("1 second"))
        expect(denied.message).toContain("Cannot read non-regular file")
      }
      const history = (result: Tool.ExecuteResult, sessionID = ctx.sessionID): Tool.Context["messages"] => {
        // 使用真实持久化 Schema 构造历史，不以 any 伪造工具结果的身份字段。
        // 分页历史保存真实请求范围，不用测试侧缓存或比较算法伪造命中。
        const input = { filePath: target, offset: 1, limit: 1 }
        const decoded = Schema.decodeUnknownSync(SessionV1.WithParts)({
          info: {
            id: "msg_prior", sessionID, role: "assistant", parentID: "msg_parent",
            time: { created: 1 }, modelID: "test", providerID: "test", mode: "build", agent: "build",
            path: { cwd: dir, root: dir }, cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          },
          parts: [{
            id: "prt_prior", sessionID, messageID: "msg_prior", type: "tool", tool: "read", callID: "prior",
            state: { status: "completed", input, ...result, time: { start: 1, end: 2 } },
          }],
        })
        return [decoded as SessionV1.WithParts]
      }
      // 多行文件强制形成分页视图，覆盖取消部分视图排除的原始意图。
      yield* put(target, "v1\ntail")
      const request = { filePath: target, offset: 1, limit: 1 }
      const first = yield* exec(dir, request)
      const visible = history(first)
      // 同会话已有完整页面可预热命中，第一次历史调用也无需进程级初始化。
      expect((yield* exec(dir, request, { ...ctx, messages: visible })).output).toContain('status="stub_same_range_visible"')
      // B 读 v2 后，A 的 v1 历史仍不能证明 v2；此序列捕获原全局缓存缺陷。
      yield* put(target, "v2\ntail")
      const b = { ...ctx, sessionID: SessionID.make("ses_b") }
      const second = yield* exec(dir, request, b)
      // 独立预期来自实际写入文字，不只比较两次可能同时错误的返回值。
      expect(second.output).toContain("1: v2")
      expect(second.output).not.toContain("1: v1")
      expect(second.metadata.truncated).toBe(true)
      const reread = yield* exec(dir, request, { ...ctx, messages: visible })
      expect(reread.output).toContain("1: v2")
      expect(reread.output).not.toContain("1: v1")
      // B 的本会话可见页面证明当前版本；A 的旧页面不能借用这个证明。
      expect((yield* exec(dir, request, { ...b, messages: history(second, b.sessionID) })).output).toContain('status="stub_same_range_visible"')
      // 外会话即使包含当前版本，也不构成本会话的可见证明。
      expect((yield* exec(dir, request, { ...ctx, messages: history(second, b.sessionID) })).output).toContain("v2")
      const current = history(second)
      const part = current[0].parts[0]
      if (part.type !== "tool" || part.state.status !== "completed") throw new Error("invalid fixture")
      // 压缩时间为零仍是压缩；stub 不能作为新的正文证明。
      part.state.time.compacted = 0
      expect((yield* exec(dir, request, { ...ctx, messages: current })).output).toContain("v2")
      delete part.state.time.compacted
      const read = part.state.metadata.read as NonNullable<typeof second.metadata.read>
      part.state.output = FILE_UNCHANGED_STUB
      read.stub = true
      expect((yield* exec(dir, request, { ...ctx, messages: current })).output).toContain("v2")
      part.state.output = second.output
      read.stub = false
      // 非覆盖范围必须返回正文；输入和元数据同时模拟另一真实范围。
      part.state.input.offset = 2
      read.start = 2
      read.end = 2
      expect((yield* exec(dir, request, { ...ctx, messages: current })).output).toContain("v2")
      part.state.input.offset = 1
      read.start = 1
      read.end = 1
      // 恢复范围确实命中，避免拒绝断言仅因测试历史失配而偶然成立。
      expect((yield* exec(dir, request, { ...ctx, messages: current })).output).toContain('status="stub_same_range_visible"')
      const denied = yield* fail(dir, request, {
        ...ctx, messages: current, ask: () => Effect.die(new Error("read denied")),
      })
      expect(denied.message).toBe("read denied")
      // 完整长行可证明同版本，2000 字符之后的变化也必须返回新正文。
      yield* put(target, "x".repeat(3000))
      const whole = yield* exec(dir, request)
      expect((yield* exec(dir, request, { ...ctx, messages: history(whole) })).output).toContain('status="stub_same_range_visible"')
      yield* put(target, "x".repeat(3000) + "changed")
      const changed = yield* exec(dir, request, { ...ctx, messages: history(whole) })
      expect(changed.metadata.read).toMatchObject({ size: 3007, returned: 1, stub: false })
      expect(changed.output).toContain("<content>")
      expect(changed.output).not.toContain("<stub")
      expect(changed.output).toContain("line truncated to 2000 chars")
      expect((yield* exec(dir, request, { ...ctx, messages: history(changed) })).output).toContain('status="stub_same_range_visible"')
      // 字节预算省略的正文仍不构成完整版本证明。
      yield* put(target, "x".repeat(24 * 1024 + 1))
      const partial = yield* exec(dir, request)
      expect((yield* exec(dir, request, { ...ctx, messages: history(partial) })).output)
        .not.toContain('<stub status=')
    }),
  )

  it.instance("truncates large file by bytes and sets truncated metadata", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance

      const content = Array.from({ length: 100 }, (_, i) => `${i}: ${"x".repeat(1024)}`).join("\n")
      yield* put(path.join(test.directory, "large.txt"), content)
      const result = yield* run({ filePath: path.join(test.directory, "large.txt") })
      expect(result.metadata.truncated).toBe(true)
      // #142：正文被 24 KiB 截断，但有界尾部扫描足以精确计完原始 100 行样例。
      expect(result.metadata.read).toMatchObject({ total: 100, totalExact: true })
      expect(result.output).toContain('total="100"')
      expect(result.output).toContain('reason="byte_limit"')
    }),
  )

  it.instance("stops streaming after the byte cap", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filepath = path.join(test.directory, "huge.txt")
      // #142：长行迫使 MAX_BYTES 先于默认行限触发 ReadStop
      const content = `${"x".repeat(4000)}
`.repeat(200)
      yield* put(filepath, content)

      const fs = yield* FSUtil.Service
      const counter = { bytes: 0 }
      const result = yield* run({ filePath: filepath }).pipe(
        Effect.provideService(
          FSUtil.Service,
          FSUtil.Service.of({
            ...fs,
            stream: (file, options) =>
              fs.stream(file, options).pipe(
                Stream.tap((chunk) =>
                  Effect.sync(() => {
                    counter.bytes += chunk.length
                  }),
                ),
              ),
          }),
        ),
      )

      expect(result.metadata.truncated).toBe(true)
      // #142：长行文件触发 byte_limit 并 ReadStop 停流
      expect(result.output).toContain('reason="byte_limit"')
      expect(result.output).toContain('total_exact="false"')
      expect(result.metadata.read?.totalExact).toBe(false)
      expect(result.metadata.read?.total).toBeLessThan(200)
      expect(counter.bytes).toBeLessThan(Buffer.byteLength(content, "utf-8") / 2)
    }),
  )

  it.instance("truncates by line count when limit is specified", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const lines = Array.from({ length: 100 }, (_, i) => `line${i}`).join("\n")
      yield* put(path.join(test.directory, "many-lines.txt"), lines)

      const result = yield* run({ filePath: path.join(test.directory, "many-lines.txt"), limit: 10 })
      expect(result.metadata.truncated).toBe(true)
      // #142：行截断用 range + more line_limit
      expect(result.output).toContain('<range start="1" end="10" total="100" returned="10" />')
      expect(result.output).toContain('<more offset="11" reason="line_limit" />')
      expect(result.output).toContain("line0")
      expect(result.output).toContain("line9")
      expect(result.output).not.toContain("line10")
    }),
  )

  it.instance("does not truncate small file", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* put(path.join(test.directory, "small.txt"), "hello world")

      const result = yield* run({ filePath: path.join(test.directory, "small.txt") })
      expect(result.metadata.truncated).toBe(false)
      // #142：完整读取有 range，无 more
      expect(result.output).toContain('<range start="1" end="1" total="1" returned="1" />')
      expect(result.output).not.toContain("<more")
      expect(result.metadata.display).toMatchObject({
        type: "file",
        path: path.join(test.directory, "small.txt"),
        text: "hello world",
        lineStart: 1,
        lineEnd: 1,
        totalLines: 1,
        truncated: false,
      })
    }),
  )

  it.live("respects offset parameter", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const lines = Array.from({ length: 20 }, (_, i) => `line${i + 1}`).join("\n")
      yield* put(path.join(dir, "offset.txt"), lines)

      const result = yield* exec(dir, { filePath: path.join(dir, "offset.txt"), offset: 10, limit: 5 })
      expect(result.output).toContain("10: line10")
      expect(result.output).toContain("14: line14")
      expect(result.output).not.toContain("9: line10")
      expect(result.output).not.toContain("15: line15")
      expect(result.output).toContain("line10")
      expect(result.output).toContain("line14")
      expect(result.output).not.toContain("line0")
      expect(result.output).not.toContain("line15")
    }),
  )

  it.live("throws when offset is beyond end of file", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const lines = Array.from({ length: 3 }, (_, i) => `line${i + 1}`).join("\n")
      yield* put(path.join(dir, "short.txt"), lines)

      const err = yield* fail(dir, { filePath: path.join(dir, "short.txt"), offset: 4, limit: 5 })
      expect(err.message).toContain("Offset 4 is out of range for this file (3 lines)")
    }),
  )

  it.live("allows reading empty file at default offset", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* put(path.join(dir, "empty.txt"), "")

      const result = yield* exec(dir, { filePath: path.join(dir, "empty.txt") })
      expect(result.metadata.truncated).toBe(false)
      // #142：空文件 range returned=0
      expect(result.output).toContain('<range start="1" end="0" total="0" returned="0" />')
      expect(result.output).not.toContain("<more")
    }),
  )

  it.live("throws when offset > 1 for empty file", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* put(path.join(dir, "empty.txt"), "")

      const err = yield* fail(dir, { filePath: path.join(dir, "empty.txt"), offset: 2 })
      expect(err.message).toContain("Offset 2 is out of range for this file (0 lines)")
    }),
  )

  it.live("does not mark final directory page as truncated", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* Effect.forEach(
        Array.from({ length: 10 }, (_, i) => i),
        (i) => put(path.join(dir, "dir", `file-${i + 1}.txt`), `line${i}`),
        {
          concurrency: "unbounded",
        },
      )

      const result = yield* exec(dir, { filePath: path.join(dir, "dir"), offset: 6, limit: 5 })
      expect(result.metadata.truncated).toBe(false)
      expect(result.output).not.toContain("Showing 5 of 10 entries")
      expect(result.metadata.display).toMatchObject({
        type: "directory",
        path: path.join(dir, "dir"),
        entries: ["file-5.txt", "file-6.txt", "file-7.txt", "file-8.txt", "file-9.txt"],
        offset: 6,
        totalEntries: 10,
        truncated: false,
      })
    }),
  )

  it.live("bounds displayed long lines within the byte budget", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const long = "x".repeat(3000)
      yield* put(path.join(dir, "long-line.txt"), long)

      const result = yield* exec(dir, { filePath: path.join(dir, "long-line.txt") })
      expect(result.output).toContain(`1: ${long.slice(0, 2000)}`)
      expect(result.output).toContain("line truncated to 2000")
      expect(result.metadata.truncated).toBe(false)
    }),
  )

  it.live("PNG, BMP, TIFF and AVIF files attach without truncation and normalize for the processor", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
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
      const image = yield* Image.Service
      const { default: sharp } = yield* Effect.promise(() => import("sharp"))
      const tiff = yield* Effect.promise(() => sharp(png).tiff({ compression: "lzw" }).toBuffer())
      const avif = yield* Effect.promise(() => sharp(png).avif({ lossless: true }).toBuffer())
      for (const [name, , data] of [
        ["image.png", "image/png", png],
        ["image.bmp", "image/bmp", bmp],
        ["image.tiff", "image/tiff", tiff],
        ["image.avif", "image/avif", avif],
      ] as const) {
        yield* put(path.join(dir, name), data)

        const result = yield* exec(dir, { filePath: path.join(dir, name) })
        expect(result.output).toBe("Image read successfully")
        expect(result.metadata.truncated).toBe(false)
        expect(result.attachments).toBeDefined()
        expect(result.attachments?.length).toBe(1)
        const attachment = result.attachments?.[0]
        if (!attachment) throw new Error("expected image attachment")
        // Read已完成归一化，不支持的源格式在工具边界即转为模型可用的PNG。
        expect(attachment.mime).toBe("image/png")
        expect(attachment).not.toHaveProperty("id")
        expect(attachment).not.toHaveProperty("sessionID")
        expect(attachment).not.toHaveProperty("messageID")
        const normalized = yield* provideInstance(dir)(
          image.normalize(
            { ...attachment, id: PartID.ascending(), sessionID: ctx.sessionID, messageID: ctx.messageID },
            { tokenBudget: 1600 },
          ),
        )
        expect(["image/jpeg", "image/png", "image/gif", "image/webp"]).toContain(normalized.mime)
        expect(normalized.mime).toBe("image/png")
        expect(normalized.url.startsWith(`data:${normalized.mime};base64,`)).toBe(true)
        expect(Buffer.byteLength(normalized.url.slice(normalized.url.indexOf(";base64,") + 8), "utf-8")).toBeLessThanOrEqual(1600 * 750)
        const bytes = Buffer.from(normalized.url.slice(normalized.url.indexOf(";base64,") + 8), "base64")
        expect(Array.from(bytes.subarray(0, 8)))
          .toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
        const decoded = photon.PhotonImage.new_from_byteslice(bytes)
        expect(decoded.get_width()).toBe(1)
        expect(decoded.get_height()).toBe(1)
        decoded.free()
      }
    }),
  )

  it.live("detects attachment media from file contents", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      // 用真实 Photon 生成 JPEG，覆盖按内容识别 MIME，而不是只伪造字节头。
      const photon = yield* Effect.promise(() => import("@silvia-odwyer/photon-node"))
      const source = new photon.PhotonImage(
        new Uint8Array(
          Array.from(
            { length: 8 * 8 * 4 },
            (_, index) => (index % 4 === 3 ? 255 : ((index >> 2) * (index % 4 === 0 ? 1 : index % 4 === 1 ? 7 : 13)) % 251),
          ),
        ),
        8,
        8,
      )
      const jpeg = Buffer.from(source.get_bytes_jpeg(90))
      source.free()
      yield* put(path.join(dir, "image.bin"), jpeg)

      const result = yield* exec(dir, { filePath: path.join(dir, "image.bin") })
      // 图片文案允许附加说明；原生附件 MIME 与 data URL 断言继续保留。
      expect(result.output).toStartWith("Image read successfully")
      expect(result.attachments?.[0].mime).toBe("image/jpeg")
      expect(result.attachments?.[0].url.startsWith("data:image/jpeg;base64,")).toBe(true)
    }),
  )

  // #276：损坏图片应返回解码错误，而非当作附件继续返回
  it.live("fails invalid image attachments instead of returning undecodable bytes", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* put(path.join(dir, "broken.jpg"), Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]))

      const error = yield* fail(dir, { filePath: path.join(dir, "broken.jpg") })
      expect(error.message).toBe("Image could not be decoded")
    }),
  )

  it.live("large image files are properly attached without error", () =>
    Effect.gen(function* () {
      const result = yield* exec(FIXTURES_DIR, { filePath: path.join(FIXTURES_DIR, "large-image.png") })
      const attachment = result.attachments?.[0]
      expect(result.metadata.truncated).toBe(false)
      expect(result.attachments).toBeDefined()
      expect(result.attachments?.length).toBe(1)
      expect(attachment?.type).toBe("file")
      if (!attachment) throw new Error("expected image attachment")
      const base64 = attachment.url.slice(attachment.url.indexOf(";base64,") + ";base64,".length)
      // read 的 1_600 token 预算必须约束真实附件的 base64 长度。
      expect(base64.length).toBeLessThanOrEqual(1_600 * 750)
      expect(attachment).not.toHaveProperty("id")
      expect(attachment).not.toHaveProperty("sessionID")
      expect(attachment).not.toHaveProperty("messageID")
    }),
  )

  // resizer 不可用时，附件必须保留原始 MIME 和逐字节相同的内容。
  noResizer.live("falls back to original image bytes when the image resizer is unavailable", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const png = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
        "base64",
      )
      yield* put(path.join(dir, "image.png"), png)

      const result = yield* exec(dir, { filePath: path.join(dir, "image.png") })
      expect(result.output).toStartWith("Image read successfully")
      expect(result.attachments?.[0]).toMatchObject({
        type: "file",
        mime: "image/png",
        url: `data:image/png;base64,${png.toString("base64")}`,
      })
    }),
  )

  it.live(".fbs files (FlatBuffers schema) are read as text, not images", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const fbs = `namespace MyGame;

table Monster {
  pos:Vec3;
  name:string;
  inventory:[ubyte];
}

root_type Monster;`
      yield* put(path.join(dir, "schema.fbs"), fbs)

      const result = yield* exec(dir, { filePath: path.join(dir, "schema.fbs") })
      expect(result.attachments).toBeUndefined()
      expect(result.output).toContain("namespace MyGame")
      expect(result.output).toContain("table Monster")
    }),
  )

  it.live("falls through unsupported image mime types to text", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const cases = [
        ["image.bmp", "BM text content"],
        ["photo.tiff", "II text content"],
        ["photo.avif", "avif text content"],
      ] as const

      for (const item of cases) {
        yield* put(path.join(dir, item[0]), item[1])
        const result = yield* exec(dir, { filePath: path.join(dir, item[0]) })
        expect(result.attachments).toBeUndefined()
        expect(result.output).toContain(item[1])
      }
    }),
  )
})

describe("tool.read loaded instructions", () => {
  it.live("loads AGENTS.md from parent directory and includes in metadata", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* put(path.join(dir, "subdir", "AGENTS.md"), "# Test Instructions\nDo something special.")
      yield* put(path.join(dir, "subdir", "nested", "test.txt"), "test content")

      const result = yield* exec(dir, { filePath: path.join(dir, "subdir", "nested", "test.txt") })
      expect(result.output).toContain("test content")
      expect(result.output).toContain("system-reminder")
      expect(result.output).toContain("Test Instructions")
      expect(result.metadata.loaded).toBeDefined()
      expect(result.metadata.loaded).toContain(path.join(dir, "subdir", "AGENTS.md"))
    }),
  )
})

describe("tool.read binary detection", () => {
  it.live("rejects text extension files with null bytes", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const bytes = Buffer.from([0x68, 0x65, 0x6c, 0x6c, 0x6f, 0x00, 0x77, 0x6f, 0x72, 0x6c, 0x64])
      yield* put(path.join(dir, "null-byte.txt"), bytes)

      const err = yield* fail(dir, { filePath: path.join(dir, "null-byte.txt") })
      expect(err.message).toContain("Cannot read binary file")
    }),
  )

  it.live("rejects known binary extensions", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* put(path.join(dir, "module.wasm"), "not really wasm")

      const err = yield* fail(dir, { filePath: path.join(dir, "module.wasm") })
      expect(err.message).toContain("Cannot read binary file")
    }),
  )
})
describe("tool.read XML preserve channels", () => {
  // #145：目录条目保留原文
  it.instance("preserves XML-sensitive directory entries", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const dir = path.join(test.directory, "dir-xml")
      yield* Effect.promise(() => import("fs/promises").then((fs) => fs.mkdir(dir, { recursive: true })))
      yield* put(path.join(dir, "a&b.txt"), "x\n")
      const result = yield* run({ filePath: dir })
      expect(result.output).toContain("a&b.txt")
      expect(result.output).not.toContain("a&amp;b.txt")
    }),
  )

    // #145：outline 使用含 <> 的 impl 标签，硬断言未转义
  it.instance("preserves XML-sensitive outline labels", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const file = path.join(test.directory, "generic.rs")
      const body = Array.from({ length: 700 }, (_, i) => {
        if (i === 20) return "impl Parser<T> for Foo {}"
        return `// line ${i + 1}`
      }).join("\n")
      yield* put(file, body + "\n")
      const head = yield* run({ filePath: file, offset: 1, limit: 30 })
      expect(head.output).toContain("<outline")
      // #145：outline 原文应含 <T>，不得变成 &lt;T&gt;
      expect(head.output).toContain("Parser<T>")
      expect(head.output).not.toContain("Parser&lt;T&gt;")
    }),
  )

  it.instance("preserves XML-sensitive outline labels", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const file = path.join(test.directory, "generic.ts")
      const body = Array.from({ length: 700 }, (_, i) => {
        if (i === 20) return "export function Parser<T>() { return null as any }"
        return `// line ${i + 1}`
      }).join("\n")
      yield* put(file, body + "\n")
      const head = yield* run({ filePath: file, offset: 1, limit: 30 })
      expect(head.output).toContain("<outline")
      expect(head.output).toContain("Parser")
      expect(head.output).not.toContain("Parser&lt;T&gt;")
    }),
  )
})


describe("tool.read structured output", () => {
  // #142：正常读取输出 file/range 结构
  it.instance("returns structured file metadata and range for normal reads", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* put(path.join(test.directory, "structured.txt"), "alpha\nbeta\n")
      const result = yield* run({ filePath: path.join(test.directory, "structured.txt") })
      expect(result.output).toContain("<type>file</type>")
      expect(result.output).toContain('<file size="')
      expect(result.output).toContain('<range start="1"')
      expect(result.output).toContain("<content>")
      expect(result.output).toContain("1: alpha")
      expect(result.output).not.toContain("<stub")
      // #142：metadata.read 供后续 stub 比对
      expect(result.metadata.read).toMatchObject({
        type: "file",
        start: 1,
        stub: false,
      })
    }),
  )

  // #142：XML 敏感内容在 #142 阶段转义（#145 再改为原文）
  it.instance("preserves XML-sensitive file content in structured output", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* put(path.join(test.directory, "xml-sensitive.txt"), '<tag attr="x">&</tag>\n')
      const result = yield* run({ filePath: path.join(test.directory, "xml-sensitive.txt") })
      // #145：内容行不转义
      expect(result.output).toContain('1: <tag attr="x">&</tag>')
      expect(result.output).not.toContain("1: &lt;tag")
    }),
  )
})

describe("tool.read outline", () => {
  // #142：长源文件头部读取附带 outline
  it.instance("includes outline for large source files at offset 1", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const file = path.join(test.directory, "big.ts")
      const body = Array.from({ length: 700 }, (_, i) => {
        if (i === 9) return "export function alpha() {}"
        if (i === 119) return "export class Beta {}"
        return `// line ${i + 1} ${"x".repeat(2048)}`
      }).join("\n")
      yield* put(file, body + "\n")
      const head = yield* run({ filePath: file, offset: 1, limit: 20 })
      // #142：offset=1 的长源文件必须带 outline
      // #145：硬断言 outline 节点必须出现
      expect(head.output).toContain("<outline")
      expect(head.output).toContain("function alpha")
      expect(head.output).toContain("class Beta")
      expect(head.metadata.read?.totalExact).toBe(false)
      expect(head.metadata.read?.total).toBeLessThan(600)
      expect(head.output).toContain('total_exact="false"')
      expect(head.output).toContain('reason="byte_limit"')
      const bodyRead = yield* run({ filePath: file, offset: 50, limit: 10 })
      // #142：非头部读取不重复贴 outline
      expect(bodyRead.output).not.toContain("<outline")
    }),
  )
})

describe("tool.read visible context stubs", () => {
  // #142：同区间二次读取必须 structured stub（硬断言）；合并 ctx 保留 ask
  it.instance("stubs when the same range is already visible", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const file = path.join(test.directory, "nested", "same-range.txt")
      yield* put(file, ["one", "two", "three"].join("\n") + "\n")
      const first = yield* run({ filePath: file, offset: 1, limit: 2 })
      expect(first.output).toContain("<content>")
      expect(first.metadata.read?.stub).toBe(false)
      expect(first.metadata.loaded).toEqual([])
      yield* put(path.join(test.directory, "nested", "AGENTS.md"), "new directory instructions")
      const second = yield* run(
        { filePath: file, offset: 1, limit: 2 },
        {
          ...ctx,
          messages: [
            {
              info: { role: "assistant", id: "a1", sessionID: ctx.sessionID },
              parts: [
                {
                  type: "tool",
                  tool: "read",
                  callID: "c1",
                  state: {
                    status: "completed",
                    time: { start: 1, end: Date.now() + 1000 },
                    input: { filePath: file, offset: 1, limit: 2 },
                    output: first.output,
                    title: "t",
                    metadata: first.metadata,
                  },
                },
              ],
            } as any,
          ],
        },
      )
      expect(second.output).toContain('status="stub_same_range_visible"')
      // 断言新文案：声明"最新版本"消除重读动机，并给出精确 offset=3 跳读出口
      // （文件共 3 行，已读 1-2，下一段未读起始即第 3 行）
      expect(second.output).toContain("are the latest version and already in context")
      expect(second.output).toContain("offset=3 for unread lines")
      expect(second.output).toContain("grep to locate symbols")
      expect(second.output).not.toContain("<content>")
      expect(second.metadata.read?.stub).toBe(true)
      expect(second.output).toContain("<system-reminder>")
      expect(second.output).toContain("new directory instructions")
      expect(second.metadata.loaded).toEqual([path.join(test.directory, "nested", "AGENTS.md")])
    }),
  )

  // #142：被更大可见区间覆盖时 covered stub
  it.instance("stubs when range is covered by a larger visible range", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const file = path.join(test.directory, "cover.txt")
      const body = Array.from({ length: 50 }, (_, i) => `line${i}`).join("\n")
      yield* put(file, body + "\n")
      const wide = yield* run({ filePath: file, offset: 1, limit: 40 })
      const narrow = yield* run(
        { filePath: file, offset: 5, limit: 5 },
        {
          ...ctx,
          messages: [
            {
              info: { role: "assistant", id: "a1", sessionID: ctx.sessionID },
              parts: [
                {
                  type: "tool",
                  tool: "read",
                  callID: "c1",
                  state: {
                    status: "completed",
                    time: { start: 1, end: Date.now() + 1000 },
                    input: { filePath: file, offset: 1, limit: 40 },
                    output: wide.output,
                    title: "t",
                    metadata: wide.metadata,
                  },
                },
              ],
            } as any,
          ],
        },
      )
      expect(narrow.output).toContain("stub_covered_range_visible")
      // 断言新文案：引用覆盖源 1-40、声明"file unchanged"消除重读动机、
      // 精确 offset=41（可见末行 40 + 1）指向下一段未读内容
      expect(narrow.output).toContain("covered by visible read 1-40")
      expect(narrow.output).toContain("file unchanged")
      expect(narrow.output).toContain("offset=41 for unread lines")
      expect(narrow.output).not.toContain("<content>")
    }),
  )

  // EOF 钳制回归：可见范围已覆盖到末行时不再给出 offset 出口，
  // 改为显式声明已达文件末尾，避免模型发起必失败的 read 陷入循环。
  it.instance("stubs same range reaching EOF: declares end of file instead of misleading offset", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const file = path.join(test.directory, "eof-same.txt")
      // 2 行文件：首次读 1-2 即读完整个文件，visibleEnd=2=total=2 → reachedEof
      yield* put(file, "one\ntwo")
      const input = { filePath: file, offset: 1, limit: 2 }

      const first = yield* run(input)
      const second = yield* run(input, {
        ...ctx,
        messages: [
          {
            info: { role: "assistant", id: "a1", sessionID: ctx.sessionID },
            parts: [
              {
                type: "tool",
                tool: "read",
                callID: "c1",
                state: {
                  status: "completed",
                  time: { start: 1, end: Date.now() + 1000 },
                  input: { filePath: file, offset: 1, limit: 2 },
                  output: first.output,
                  title: "t",
                  metadata: first.metadata,
                },
              },
            ],
          } as any,
        ],
      })

      expect(second.output).toContain('<stub status="stub_same_range_visible">')
      expect(second.output).toContain("are the latest version and already in context")
      expect(second.output).toContain("end of file reached")
      expect(second.output).not.toContain("offset=3 for unread lines")
      expect(second.output).toContain("grep to locate symbols")
    }),
  )

  it.instance("stubs covered range reaching EOF: declares end of file instead of misleading offset", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const file = path.join(test.directory, "eof-covered.txt")
      // 50 行文件：首次读 1-50 读完整文件，第二次请求 10-20 被 1-50 覆盖，
      // visibleEnd=50=total=50 → reachedEof，不应输出 offset=51
      yield* put(file, Array.from({ length: 50 }, (_, i) => `line${i + 1}`).join("\n"))
      const firstInput = { filePath: file, offset: 1, limit: 50 }
      const secondInput = { filePath: file, offset: 10, limit: 11 }

      const first = yield* run(firstInput)
      const second = yield* run(secondInput, {
        ...ctx,
        messages: [
          {
            info: { role: "assistant", id: "a1", sessionID: ctx.sessionID },
            parts: [
              {
                type: "tool",
                tool: "read",
                callID: "c1",
                state: {
                  status: "completed",
                  time: { start: 1, end: Date.now() + 1000 },
                  input: { filePath: file, offset: 1, limit: 50 },
                  output: first.output,
                  title: "t",
                  metadata: first.metadata,
                },
              },
            ],
          } as any,
        ],
      })

      expect(second.output).toContain('<stub status="stub_covered_range_visible" covered_by="1-50">')
      expect(second.output).toContain("covered by visible read 1-50")
      expect(second.output).toContain("file unchanged")
      expect(second.output).toContain("end of file reached")
      expect(second.output).not.toContain("offset=51 for unread lines")
      expect(second.output).toContain("grep to locate symbols")
    }),
  )

  // #142：已 compact 的历史读不得参与 stub 覆盖
  it.instance("does not stub compacted previous reads", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const file = path.join(test.directory, "compacted.txt")
      yield* put(file, ["a", "b", "c"].join("\n") + "\n")
      const first = yield* run({ filePath: file, offset: 1, limit: 2 })
      expect(first.metadata.read?.stub).toBe(false)
      const second = yield* run(
        { filePath: file, offset: 1, limit: 2 },
        {
          ...ctx,
          messages: [
            {
              info: { role: "assistant", id: "a1", sessionID: ctx.sessionID },
              parts: [
                {
                  type: "tool",
                  tool: "read",
                  callID: "c1",
                  state: {
                    status: "completed",
                    time: { start: 1, end: Date.now() + 1000, compacted: Date.now() },
                    input: { filePath: file, offset: 1, limit: 2 },
                    output: first.output,
                    title: "t",
                    metadata: first.metadata,
                  },
                },
              ],
            } as any,
          ],
        },
      )
      // #142：compacted 历史被 collectVisibleReads 跳过，必须完整 content
      expect(second.output).toContain("<content>")
      expect(second.output).not.toContain('status="stub_')
      expect(second.metadata.read?.stub).toBe(false)
    }),
  )

  // #142：size/mtime 变化后不得沿用旧可见区间 stub
  it.instance("does not stub when the file version changed", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const file = path.join(test.directory, "versioned.txt")
      yield* put(file, ["one", "two", "three"].join("\n") + "\n")
      const first = yield* run({ filePath: file, offset: 1, limit: 2 })
      const staleMeta = {
        ...first.metadata,
        read: {
          ...first.metadata.read!,
          size: (first.metadata.read?.size ?? 1) + 999,
          modifiedMs: (first.metadata.read?.modifiedMs ?? 1) - 10_000,
        },
      }
      const second = yield* run(
        { filePath: file, offset: 1, limit: 2 },
        {
          ...ctx,
          messages: [
            {
              info: { role: "assistant", id: "a1", sessionID: ctx.sessionID },
              parts: [
                {
                  type: "tool",
                  tool: "read",
                  callID: "c1",
                  state: {
                    status: "completed",
                    time: { start: 1, end: Date.now() + 1000 },
                    input: { filePath: file, offset: 1, limit: 2 },
                    output: first.output,
                    title: "t",
                    metadata: staleMeta,
                  },
                },
              ],
            } as any,
          ],
        },
      )
      expect(second.output).toContain("<content>")
      expect(second.output).not.toContain('status="stub_')
      expect(second.metadata.read?.stub).toBe(false)
    }),
  )

  // #142：显著重叠时返回全文并附 short overlap note
  it.instance("returns full content with a short note for significant overlap", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const file = path.join(test.directory, "overlap.txt")
      const body = Array.from({ length: 80 }, (_, i) => `line ${i + 1}`).join("\n") + "\n"
      yield* put(file, body)
      const first = yield* run({ filePath: file, offset: 1, limit: 40 })
      expect(first.metadata.read?.stub).toBe(false)
      const second = yield* run(
        { filePath: file, offset: 21, limit: 40 },
        {
          ...ctx,
          messages: [
            {
              info: { role: "assistant", id: "a1", sessionID: ctx.sessionID },
              parts: [
                {
                  type: "tool",
                  tool: "read",
                  callID: "c1",
                  state: {
                    status: "completed",
                    time: { start: 1, end: Date.now() + 1000 },
                    input: { filePath: file, offset: 1, limit: 20 },
                    output: first.output,
                    title: "t",
                    metadata: first.metadata,
                  },
                },
              ],
            } as any,
          ],
        },
      )
      // #142：部分重叠不 stub，应有全文 + overlap note
      expect(second.output).toContain("<content>")
      expect(second.output).toContain('<note type="overlap"')
      // [local-smark] overlap note 现在携带引导文案，避免不必要的重复读取
      expect(second.output).toContain("avoid re-reading this range unnecessarily")
      expect(second.output).not.toContain('status="stub_')
      expect(second.metadata.read?.stub).toBe(false)
    }),
  )

  // #142：已是 stub 的可见读不得作为后续覆盖来源
  it.instance("does not use a visible stub as coverage for later reads", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const file = path.join(test.directory, "stub-not-cover.txt")
      yield* put(file, ["a", "b", "c", "d"].join("\n") + "\n")
      const first = yield* run({ filePath: file, offset: 1, limit: 3 })
      // craft a stub metadata as if previous was stubbed
      const stubMeta = {
        ...first.metadata,
        read: {
          ...first.metadata.read!,
          stub: true,
          status: "stub_same_range_visible",
        },
      }
      const second = yield* run(
        { filePath: file, offset: 1, limit: 2 },
        {
          ...ctx,
          messages: [
            {
              info: { role: "assistant", id: "a1", sessionID: ctx.sessionID },
              parts: [
                {
                  type: "tool",
                  tool: "read",
                  callID: "c1",
                  state: {
                    status: "completed",
                    time: { start: 1, end: Date.now() + 1000 },
                    input: { filePath: file, offset: 1, limit: 3 },
                    output: 'FILE_UNCHANGED_STUB',
                    title: "t",
                    metadata: stubMeta,
                  },
                },
              ],
            } as any,
          ],
        },
      )
      expect(second.output).toContain("<content>")
      expect(second.output).not.toContain('status="stub_')
      expect(second.metadata.read?.stub).toBe(false)
    }),
  )

  // [local-smark] 构造包含 completed read part 的 ctx message，供 overlap/suppress 判定消费
  const readMessage = (
    input: { filePath: string; offset?: number; limit?: number },
    result: { output: string; metadata: Record<string, unknown> },
  ): any => ({
    info: { id: "msg_rm", role: "assistant" as const, sessionID: ctx.sessionID, agent: "build", mode: "build", path: { cwd: ".", root: "." }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, modelID: "test", providerID: "test", time: { created: 0 } },
    parts: [
      {
        id: "p_read",
        messageID: "msg_rm",
        sessionID: ctx.sessionID,
        type: "tool" as const,
        tool: "read",
        callID: "call_rm",
        state: {
          status: "completed" as const,
          input: { filePath: input.filePath, offset: input.offset ?? 1, limit: input.limit },
          output: result.output,
          metadata: result.metadata,
          time: { start: 0, end: 1 },
        },
      },
    ],
  })

  // [local-smark] 80% overlap suppress 测试：阈值设为 80%，
  // 80%+ 重叠且内容足够长时 suppress（返回 stub + 引导式文案）。
  it.live("suppresses at 80% overlap with guided message pointing to unread lines", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const filePath = path.join(dir, "suppress80.txt")
      // 200 行文件，请求 1-200，已读 1-160（80% 重叠）
      yield* put(filePath, Array.from({ length: 200 }, (_, i) => `line${i + 1}`).join("\n"))
      const firstInput = { filePath, offset: 1, limit: 160 }
      const secondInput = { filePath, offset: 1, limit: 200 }

      const first = yield* exec(dir, firstInput)
      const second = yield* exec(dir, secondInput, { ...ctx, messages: [readMessage(firstInput, first)] })

      // suppress 触发：返回 stub 而非内容（内容 > 300 字符）
      expect(second.output).toContain('<stub status="stub_high_overlap_visible"')
      // 引导式文案：告诉模型哪些行是新的、如何精确读取
      expect(second.output).toContain("New unread lines: 161-200")
      expect(second.output).toContain("Read offset=161 limit=40")
      // 告诉模型已可见的范围
      expect(second.output).toContain("1-160")
      // 引导避免不必要的重复读取
      expect(second.output).toContain("re-reading this range unnecessarily")
      // 不再使用 "do NOT re-read" 绝对禁止语气
      expect(second.output).not.toContain("do NOT re-read")
    }),
  )

  // [local-smark] 79% overlap 不 suppress：阈值以下仍返回完整内容 + note
  it.live("does not suppress at 79% overlap, returns content with note", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const filePath = path.join(dir, "nosuppress79.txt")
      // 200 行文件，请求 1-200，已读 1-158（79% 重叠 < 80%）
      yield* put(filePath, Array.from({ length: 200 }, (_, i) => `line${i + 1}`).join("\n"))
      const firstInput = { filePath, offset: 1, limit: 158 }
      const secondInput = { filePath, offset: 1, limit: 200 }

      const first = yield* exec(dir, firstInput)
      const second = yield* exec(dir, secondInput, { ...ctx, messages: [readMessage(firstInput, first)] })

      // 不 suppress：返回 content 而非 stub
      expect(second.output).toContain("<content>")
      expect(second.output).not.toContain("<stub")
    }),
  )

  // [local-smark] 短读取不 suppress：80% 重叠但内容 < 300 字符，
  // 直接返回内容（stub 文案比内容还长时 suppress 无意义）。
  // 注意：findOverlapNote 需 >= 20 行重叠才触发，5 行文件不会进入 suppress 分支。
  it.live("does not suppress short read even at 80% overlap, returns content", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const filePath = path.join(dir, "shortread.txt")
      // 5 行文件，请求 1-5，已读 1-4（80% 重叠，但内容仅 ~35 字符 < 300）
      yield* put(filePath, "one\ntwo\nthree\nfour\nfive")
      const firstInput = { filePath, offset: 1, limit: 4 }
      const secondInput = { filePath, offset: 1, limit: 5 }

      const first = yield* exec(dir, firstInput)
      const second = yield* exec(dir, secondInput, { ...ctx, messages: [readMessage(firstInput, first)] })

      // 不 suppress：返回 content 而非 stub
      expect(second.output).toContain("<content>")
      expect(second.output).toContain("1: one")
      expect(second.output).not.toContain("<stub")
    }),
  )

  // [local-smark] 中等长度短读取不 suppress：25 行重叠（>= 20 行门控），
  // 但内容 < 300 字符 → suppress 分支判断 contentLength < 300 → 不 suppress
  it.live("does not suppress medium-short read under 300 chars even at 80% overlap", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const filePath = path.join(dir, "mediumshort.txt")
      // 25 行文件，每行 ~5 字符，请求 1-25，已读 1-20（80% 重叠，>= 20 行门控通过）
      // 内容约 125 字符 < 300 → 不 suppress
      yield* put(filePath, Array.from({ length: 25 }, (_, i) => `l${i + 1}`).join("\n"))
      const firstInput = { filePath, offset: 1, limit: 20 }
      const secondInput = { filePath, offset: 1, limit: 25 }

      const first = yield* exec(dir, firstInput)
      const second = yield* exec(dir, secondInput, { ...ctx, messages: [readMessage(firstInput, first)] })

      // 不 suppress：返回 content + overlap note（内容 < 300 字符）
      expect(second.output).toContain("<content>")
      expect(second.output).not.toContain("<stub")
      // 带 overlap notice（findOverlapNote 触发，>= 20 行）
      expect(second.output).toContain('<note type="overlap"')
      expect(second.output).toContain("avoid re-reading this range unnecessarily")
    }),
  )

  // [local-smark] 多区间联合全覆盖：已读 1-160 + 161-200，请求 1-200
  // computeUnreadRanges 应返回空，文案说 "no new content"
  it.live("guided message says no new content when multiple reads fully cover request", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const filePath = path.join(dir, "fullcover.txt")
      yield* put(filePath, Array.from({ length: 200 }, (_, i) => `line${i + 1}`).join("\n"))
      const input1 = { filePath, offset: 1, limit: 160 }
      const input2 = { filePath, offset: 161, limit: 40 }
      const inputAll = { filePath, offset: 1, limit: 200 }

      const first = yield* exec(dir, input1)
      const second = yield* exec(dir, input2)
      // 两个 read 的 messages 都传入，模拟上下文中已有两个区间
      const third = yield* exec(dir, inputAll, {
        ...ctx,
        messages: [readMessage(input1, first), readMessage(input2, second)],
      })

      // 80% overlap（1-160 是 best 单区间 = 80%）→ suppress
      expect(third.output).toContain('<stub status="stub_high_overlap_visible"')
      // 多区间联合全覆盖 → "no new content"
      expect(third.output).toContain("no new content")
    }),
  )


    // #142：多语言声明应抽出至少一条 outline label
  it.instance("extracts conservative labels for common language declarations", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const cases = [
        ["sample.py", "def py_func():\nclass PyClass:\n"],
        ["sample.go", "type Server struct {}\nfunc (s *Server) Serve() {}\n"],
        ["sample.rs", "pub struct State {}\npub async fn run() {}\nimpl State {\n"],
        ["sample.java", "public record User(String name) {}\npublic void run() {\n"],
        ["sample.cs", "public class Worker {}\npublic async Task RunAsync() {\n"],
        ["sample.kt", "data class User(val name: String)\nfun run() {}\n"],
        ["sample.swift", "struct User {}\nfunc run() {\n"],
        ["sample.rb", "class Worker\ndef perform\n"],
        ["sample.php", "class Worker {}\nfunction perform() {}\n"],
        ["sample.cpp", "struct Worker {};\nint run() {\n"],
      ] as const
      for (const [filename, header] of cases) {
        const filePath = path.join(test.directory, filename)
        const body = header + Array.from({ length: 650 }, (_, i) => `// filler ${i + 1}`).join("\n")
        yield* put(filePath, body)
        // #142：直接测 outline 抽取，避免整文件 read 干扰
        const outline = yield* Effect.promise(() => readOutline(filePath, 650, 1))
        expect(outline?.items.length).toBeGreaterThan(0)
      }
    }),
  )

  // #142：单条 outline 截断 60 字且总预算不变
  it.instance("limits outline item length and total size", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filePath = path.join(test.directory, "long-outline.rs")
      const source = [
        "impl VeryLongGenericTypeNameWithManySegmentsAndTraitsAndBoundsThatShouldBeTrimmed where T: Clone {",
        ...Array.from({ length: 650 }, (_, i) => `pub fn function_${i}_with_a_very_long_suffix_that_should_not_bloat_the_outline() {}`),
      ].join("\n")
      yield* put(filePath, source)
      const outline = yield* Effect.promise(() => readOutline(filePath, 651, 1))
      expect(outline).toBeDefined()
      expect(outline!.items.length).toBeLessThanOrEqual(32)
      expect(outline!.items.join("\n").length).toBeLessThanOrEqual(640)
      expect(outline!.items.every((item) => item.length <= 60)).toBe(true)
      expect(outline!.items.some((item) => item.endsWith("..."))).toBe(true)
      const pending = yield* Effect.promise(() => readOutline(filePath, 1, 1, false))
      expect(pending).toEqual(outline)
      yield* put(filePath, source.split("\n").slice(0, 100).join("\n"))
      expect(yield* Effect.promise(() => readOutline(filePath, 1, 1, false))).toBeUndefined()
    }),
  )

// #142：outline 预算上限（硬断言必须出现 outline）
  it.instance("outline size stays within budget", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const file = path.join(test.directory, "many-decls.ts")
      const lines = Array.from({ length: 800 }, (_, i) => `export function f${i}() { return ${i} }`)
      yield* put(file, lines.join("\n") + "\n")
      const head = yield* run({ filePath: file, offset: 1, limit: 5 })
      expect(head.output).toContain("<outline")
      const m = head.output.match(/<outline[^>]*>([\s\S]*?)<\/outline>/)
      expect(m).toBeTruthy()
      const items = m![1].trim().split("\n").filter(Boolean)
      expect(items.length).toBeLessThanOrEqual(32)
      expect(items.join("\n").length).toBeLessThanOrEqual(640)
    }),
  )

  // [local-smark] 二进制文件 error 应包含 type-specific 替代建议，
  // 帮助模型知道用什么工具读取而非盲目重试。
  it.live("suggests alternatives for binary file types", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      // .gz 文件应建议 gunzip
      yield* put(path.join(dir, "archive.gz"), Buffer.from([0x1f, 0x8b, 0x08, 0x00]))
      const gzErr = yield* fail(dir, { filePath: path.join(dir, "archive.gz") })
      expect(gzErr.message).toContain("gunzip")

      // .wasm 文件应建议 strings 或 hexdump
      yield* put(path.join(dir, "module.wasm"), "not really wasm")
      const wasmErr = yield* fail(dir, { filePath: path.join(dir, "module.wasm") })
      expect(wasmErr.message).toContain("strings")
    }),
  )
})

