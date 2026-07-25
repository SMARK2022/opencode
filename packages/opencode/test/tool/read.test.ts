import { afterEach, describe, expect, test } from "bun:test"
import { Database as SQLite } from "bun:sqlite"
import { Cause, Effect, Exit, Layer } from "effect"
import path from "path"
import { Agent } from "../../src/agent/agent"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Global } from "@opencode-ai/core/global"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Git } from "@/git"
import { LSP } from "@/lsp/lsp"
import { Permission } from "../../src/permission"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionID, MessageID, PartID } from "../../src/session/schema"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Instruction } from "../../src/session/instruction"
import { ReadTool } from "../../src/tool/read"
import { readOutline } from "../../src/tool/read-outline"
import { createAuxiliaryBudget, readTextPage } from "../../src/tool/read-lines"
import { Truncate } from "@/tool/truncate"
import { Tool } from "@/tool/tool"
import { Filesystem } from "@/util/filesystem"
import { disposeAllInstances, provideInstance, TestInstance, tmpdir, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { Reference } from "@/reference/reference"
import { Image } from "@/image/image"

const FIXTURES_DIR = path.join(import.meta.dir, "fixtures")
const MIGRATION_SCRIPT = path.join(import.meta.dir, "../../script/migrate-image-attachment.ts")

async function migrateImageAttachment(args: string[]) {
  // 子进程覆盖用户实际调用的CLI边界，避免测试绕过参数校验、只读模式或进程退出码。
  // 迁移 CLI 子进程在 Windows 上隐藏 console，覆盖真实入口时不弹 conhost。
  const child = Bun.spawn([process.execPath, MIGRATION_SCRIPT, ...args], {
    cwd: path.join(import.meta.dir, "../.."),
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: process.platform === "win32",
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { exitCode, stdout, stderr }
}

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

const referenceLayer = (flags: Partial<RuntimeFlags.Info> = {}) =>
  Reference.layer.pipe(
    Layer.provide(Config.defaultLayer),
    Layer.provide(AppFileSystem.defaultLayer),
    Layer.provide(Git.defaultLayer),
    Layer.provide(RuntimeFlags.layer(flags)),
  )

const readLayer = (flags: Partial<RuntimeFlags.Info> = {}, imageLayer = Image.defaultLayer) =>
  Layer.mergeAll(
    Agent.defaultLayer,
    AppFileSystem.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
    Instruction.defaultLayer,
    LSP.defaultLayer,
    referenceLayer(flags),
    Truncate.defaultLayer,
    imageLayer,
  )

const it = testEffect(readLayer())
const scout = testEffect(readLayer({ experimentalScout: true }))
const noResizer = testEffect(
  readLayer(
    {},
    Layer.succeed(
      Image.Service,
      Image.Service.of({
        normalize: () => Effect.fail(new Image.ResizerUnavailableError()),
      }),
    ),
  ),
)

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
const canonical = (p: string) => {
  const normalized = full(p).replaceAll("\\", "/")
  return process.platform === "win32" ? normalized.toLowerCase() : normalized
}
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
  const fs = yield* AppFileSystem.Service
  yield* fs.writeWithDirs(p, content)
})
const load = Effect.fn("ReadToolTest.load")(function* (p: string) {
  const fs = yield* AppFileSystem.Service
  return yield* fs.readFileString(p)
})
const asks = () => {
  const items: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
  return {
    items,
    next: {
      ...ctx,
      ask: (req: Omit<Permission.Request, "id" | "sessionID" | "tool">) =>
        Effect.sync(() => {
          items.push(req)
        }),
    },
  }
}

function readMessage(
  input: Tool.InferParameters<typeof ReadTool>,
  result: Tool.ExecuteResult,
  options?: { compacted?: boolean },
): MessageV2.WithParts {
  const messageID = MessageID.make(`msg-read-${options?.compacted ? "compacted" : "visible"}`)
  return {
    info: {
      id: messageID,
      sessionID: ctx.sessionID,
      role: "assistant",
      time: { created: 0 },
      parentID: MessageID.make("msg-user"),
      modelID: ModelID.make("test-model"),
      providerID: ProviderID.make("test-provider"),
      mode: "default",
      agent: "build",
      path: { cwd: "/", root: "/" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts: [
      {
        id: PartID.make(`prt_read_${options?.compacted ? "compacted" : "visible"}`),
        messageID,
        sessionID: ctx.sessionID,
        type: "tool",
        callID: "call-read",
        tool: "read",
        state: {
          status: "completed",
          input,
          output: result.output,
          title: result.title,
          metadata: result.metadata,
          time: { start: 0, end: 1, ...(options?.compacted ? { compacted: 2 } : {}) },
        },
      },
    ],
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
        const alt = target
          .replace(/^[A-Za-z]:/, "")
          .replaceAll("\\", "/")
          .toLowerCase()

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

  scout.live("does not ask for external_directory permission when reading configured references", () =>
    Effect.gen(function* () {
      const fs = yield* AppFileSystem.Service
      const cache = path.join(Global.Path.repos, "github.com", "opencode-read-reference", "repo")
      yield* fs.remove(cache, { recursive: true }).pipe(Effect.ignore)
      yield* Effect.addFinalizer(() => fs.remove(cache, { recursive: true }).pipe(Effect.ignore))

      const source = yield* tmpdirScoped({ git: true })
      const remoteRoot = yield* tmpdirScoped()
      const remoteDir = path.join(remoteRoot, "opencode-read-reference")
      const remoteRepo = path.join(remoteDir, "repo.git")
      yield* put(path.join(source, "notes.md"), "reference notes")
      yield* git(source, ["add", "."])
      yield* git(source, ["commit", "-m", "add notes"])
      yield* fs.makeDirectory(remoteDir, { recursive: true }).pipe(Effect.orDie)
      yield* git(remoteRoot, ["clone", "--bare", source, remoteRepo])

      const dir = yield* tmpdirScoped({
        git: true,
        config: {
          reference: {
            docs: "opencode-read-reference/repo",
          },
        },
      })

      const { items, next } = asks()
      const result = yield* githubBase(
        `file://${remoteRoot}/`,
        exec(dir, { filePath: path.join(cache, "notes.md") }, next),
      )
      const ext = items.find((item) => item.permission === "external_directory")

      expect(result.output).toContain("reference notes")
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
                  ask: (req: Omit<Permission.Request, "id" | "sessionID" | "tool">) =>
                    Effect.sync(() => {
                      for (const pattern of req.patterns) {
                        const rule = Permission.evaluate(req.permission, pattern, info.permission)
                        if (rule.action === "ask" && req.permission === "read") {
                          asked = true
                        }
                        if (rule.action === "deny") {
                          throw new Permission.DeniedError({ ruleset: info.permission })
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
  it.instance("returns structured file metadata and range for normal reads", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* put(path.join(test.directory, "structured.txt"), "alpha\nbeta")

      const result = yield* run({ filePath: path.join(test.directory, "structured.txt") })
      expect(result.output).toContain("<type>file</type>")
      expect(result.output).toContain('<file size="10" modified="')
      expect(result.output).toContain('<range start="1" end="2" total="2" returned="2" />')
      expect(result.output).toContain("<content>\n1: alpha\n2: beta\n</content>")
      expect(result.output).not.toContain("<stub")
      expect(result.output).not.toContain("status=\"fresh\"")
      expect(result.metadata.read).toMatchObject({
        type: "file",
        size: 10,
        canonicalPath: canonical(path.join(test.directory, "structured.txt")),
        start: 1,
        end: 2,
        total: 2,
        returned: 2,
        stub: false,
      })
    }),
  )

  it.instance("preserves XML-sensitive file content in structured output", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* put(path.join(test.directory, "xml-sensitive.txt"), "<tag attr=\"x\">&</tag>")

      const result = yield* run({ filePath: path.join(test.directory, "xml-sensitive.txt") })
      expect(result.output).toContain("1: <tag attr=\"x\">&</tag>")
      expect(result.output).not.toContain("1: &lt;tag")
    }),
  )

  it.instance("truncates large file by bytes and sets truncated metadata", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const content = Array.from({ length: 100 }, (_, i) => `${i}: ${"x".repeat(1024)}`).join("\n")
      yield* put(path.join(test.directory, "large.txt"), content)

      const result = yield* run({ filePath: path.join(test.directory, "large.txt") })
      expect(result.metadata.truncated).toBe(true)
      // 约 100 KiB 尾部落在辅助额度内，因此 byte_limit 与精确 total 可以同时成立。
      expect(result.output).toContain('total="100"')
      expect(result.metadata.read?.total).toBe(100)
      expect(result.metadata.read?.returned).toBeLessThan(100)
      expect(result.output).toContain('<more offset="')
      expect(result.output).toContain('reason="byte_limit"')
    }),
  )

  it.instance("truncates by line count when limit is specified", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const lines = Array.from({ length: 100 }, (_, i) => `line${i}`).join("\n")
      yield* put(path.join(test.directory, "many-lines.txt"), lines)

      const result = yield* run({ filePath: path.join(test.directory, "many-lines.txt"), limit: 10 })
      expect(result.metadata.truncated).toBe(true)
      // count-only 到达 EOF 后仍保留 more，因为返回窗口只包含前 10 行。
      expect(result.output).toContain('<range start="1" end="10" total="100" returned="10" />')
      expect(result.output).toContain('<more offset="11" reason="line_limit" />')
      expect(result.output).toContain("line0")
      expect(result.output).toContain("line9")
      expect(result.output).not.toContain("line10")
    }),
  )

  it.instance("bounds post-window line accounting on a large text file", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const trueLineCount = 100_000
      // 文件刻意远大于 16 KiB + 256 KiB，避免“预算内恰好到 EOF”伪装成早停。
      const content = Array.from(
        { length: trueLineCount },
        (_, i) => `line-${i.toString().padStart(6, "0")} ${"x".repeat(32)}`,
      ).join("\n")
      const filePath = path.join(test.directory, "large-post-window.txt")
      yield* put(filePath, content)

      const result = yield* run({ filePath })
      const read = result.metadata.read

      expect(read).toBeDefined()
      if (!read) return
      expect(read?.returned).toBeGreaterThan(0)
      // 只要求 lower-bound，不把测试与具体 chunk 边界或计数精度绑定。
      // end+1 来自确实观察到的未返回行，因此不会把任意估算伪装成可导航 total。
      expect(read.total).toBeGreaterThanOrEqual(read.end + 1)
      expect(read.total).toBeLessThan(trueLineCount)
      expect(result.metadata.truncated).toBe(true)
      expect(result.output).toContain('<more offset="')
    }),
  )

  it.instance("bounds physical post-window input on a large text file", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const trueLineCount = 200_000
      // 真实文件读取验证物理输入，而不是复制 production 算法计算一个预期数字。
      const content = "line with a stable payload\n".repeat(trueLineCount)
      const filePath = path.join(test.directory, "large-physical-bound.txt")
      yield* put(filePath, content)

      const page = yield* Effect.promise(() =>
        readTextPage(filePath, {
          limit: 200,
          offset: 1,
          budget: createAuxiliaryBudget(),
        }),
      )

      expect(page.raw.length).toBe(200)
      expect(page.more).toBe(true)
      expect(page.count).toBeLessThan(trueLineCount)
      // 256 KiB 是共享辅助预算，16 KiB 是唯一允许的 chunk read-ahead。
      // 同时约束总物理输入，防止实现只伪造 postWindowBytes 而底层仍读取完整文件。
      expect(page.postWindowBytes).toBeLessThanOrEqual(256 * 1024 + 16 * 1024)
      expect(page.physicalBytesRead).toBeLessThanOrEqual(256 * 1024 + 16 * 1024)
      expect(page.physicalBytesRead).toBeLessThan(Buffer.byteLength(content))
    }),
  )

  it.instance("preserves text line boundaries across delimiter forms", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filePath = path.join(test.directory, "line-boundaries.txt")
      // 同时覆盖 CRLF、孤立 CR、LF、空行和末尾未终止行的既有 readline 语义。
      yield* put(filePath, "alpha\r\n\rbravo\ncharlie")

      const page = yield* Effect.promise(() => readTextPage(filePath, { limit: 20, offset: 1 }))

      expect(page.raw).toEqual(["alpha", "", "bravo", "charlie"])
      expect(page.count).toBe(4)
      expect(page.more).toBe(false)
    }),
  )

  it.instance("preserves a UTF-8 sequence split at a chunk boundary", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filePath = path.join(test.directory, "utf8-chunk-boundary.txt")
      // BOM 和四字节字符共同跨越 16 KiB chunk，锁定增量 decoder 不能丢字节。
      const firstLine = `${"a".repeat(16 * 1024 - 4)}😀`
      yield* put(filePath, `\uFEFF${firstLine}\nbeta`)

      const page = yield* Effect.promise(() =>
        readTextPage(filePath, {
          limit: 20,
          offset: 1,
          contentBytesLimit: Number.POSITIVE_INFINITY,
        }),
      )

      expect(page.raw).toEqual([`\uFEFF${firstLine}`, "beta"])
      expect(page.count).toBe(2)
      expect(page.more).toBe(false)
    }),
  )

  it.instance("bounds an oversized unterminated line without assembling it", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filePath = path.join(test.directory, "oversized-unterminated.txt")
      // 没有分隔符的百万字节行必须只产生一条观察到的下界，不能等待整行结束。
      yield* put(filePath, "x".repeat(1024 * 1024))

      const page = yield* Effect.promise(() =>
        readTextPage(filePath, {
          limit: 200,
          offset: 1,
          budget: createAuxiliaryBudget(),
        }),
      )

      expect(page.raw).toEqual([])
      expect(page.count).toBe(1)
      expect(page.cut).toBe(true)
      expect(page.more).toBe(true)
      // 该断言同时锁住物理流上界和“不会组装任意完整超长行”的实现责任。
      expect(page.postWindowBytes).toBeLessThanOrEqual(256 * 1024 + 16 * 1024)
      expect(page.physicalBytesRead).toBeLessThanOrEqual(256 * 1024 + 16 * 1024)
    }),
  )

  it.instance("resolves CRLF at the auxiliary boundary with one read-ahead chunk", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const filePath = path.join(test.directory, "crlf-budget-boundary.txt")
      // CR 落在预算末尾时必须读取一个受限 lookahead，避免把 CRLF 拆成两条逻辑线。
      yield* put(filePath, `${"a".repeat(256 * 1024 - 1)}\r\nb`)

      const page = yield* Effect.promise(() =>
        readTextPage(filePath, {
          limit: 1_000_000,
          offset: 1,
          budget: createAuxiliaryBudget(),
          auxiliaryFromStart: true,
          captureRaw: false,
          contentBytesLimit: Number.POSITIVE_INFINITY,
        }),
      )

      expect(page.count).toBe(2)
      expect(page.more).toBe(true)
      // lookahead 可以补足下界，但不能恢复成一次无界 EOF 扫描。
      expect(page.postWindowBytes).toBeLessThanOrEqual(256 * 1024 + 16 * 1024)
      expect(page.physicalBytesRead).toBeLessThanOrEqual(256 * 1024 + 16 * 1024)
    }),
  )

  it.instance("does not truncate small file", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      yield* put(path.join(test.directory, "small.txt"), "hello world")

      const result = yield* run({ filePath: path.join(test.directory, "small.txt") })
      expect(result.metadata.truncated).toBe(false)
      // 返回窗口自身覆盖末行时才允许省略 more，这是 schema-free EOF 判据的正向样例。
      expect(result.output).toContain('<range start="1" end="1" total="1" returned="1" />')
      expect(result.output).not.toContain("<more")
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
    }),
  )

  it.live("preserves XML-sensitive directory entries", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* put(path.join(dir, "dir", "a&b.txt"), "content")

      const result = yield* exec(dir, { filePath: path.join(dir, "dir") })
      expect(result.output).toContain("a&b.txt")
      expect(result.output).not.toContain("a&amp;b.txt")
    }),
  )

  it.live("truncates long lines", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* put(path.join(dir, "long-line.txt"), "x".repeat(3000))

      const result = yield* exec(dir, { filePath: path.join(dir, "long-line.txt") })
      expect(result.output).toContain("(line truncated to 2000 chars)")
      expect(result.output.length).toBeLessThan(3000)
    }),
  )

  it.live("image files set truncated to false", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const png = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
        "base64",
      )
      yield* put(path.join(dir, "image.png"), png)

      const result = yield* exec(dir, { filePath: path.join(dir, "image.png") })
      expect(result.metadata.truncated).toBe(false)
      expect(result.attachments).toBeDefined()
      expect(result.attachments?.length).toBe(1)
      expect(result.attachments?.[0]).not.toHaveProperty("id")
      expect(result.attachments?.[0]).not.toHaveProperty("sessionID")
      expect(result.attachments?.[0]).not.toHaveProperty("messageID")
      // 未超限图片虽保持原 bytes，也必须先完整 decode；精确相等锁定无损 pass-through 合同。
      expect(result.attachments?.[0].url).toBe(`data:image/png;base64,${png.toString("base64")}`)
    }),
  )

  it.live("detects attachment media from file contents", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const jpeg = Buffer.from(
        "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAH/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAEFAqf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/ASP/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/ASP/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAY/Al//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/IV//2gAMAwEAAgADAAAAEP/EFBQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQMBAT8QH//EFBQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQIBAT8QH//EFBABAQAAAAAAAAAAAAAAAAAAABD/2gAIAQEAAT8QH//Z",
        "base64",
      )
      // fixture 必须能完成像素 decode；旧样本只有 metadata 可读，会掩盖 metadata-only pass-through 回归。
      yield* put(
        path.join(dir, "image.bin"),
        Buffer.from(
          "/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAACAAIDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAwT/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCbAFAH/9k=",
          "base64",
        ),
      )

      const result = yield* exec(dir, { filePath: path.join(dir, "image.bin") })
      expect(result.output).toStartWith("Image read successfully")
      expect(result.attachments?.[0].mime).toBe("image/jpeg")
      const persisted = Buffer.from(yield* Effect.promise(() => Bun.file(path.join(dir, "image.bin")).arrayBuffer()))
      // content-sniff 只改变 MIME 识别，不得让完整 decode 的成功 JPEG 被重编码。
      // 精确 data URL 同时锁定 MIME 与 base64，单纯断言 image/jpeg 无法发现隐式质量损失。
      expect(result.attachments?.[0].url).toBe(`data:image/jpeg;base64,${persisted.toString("base64")}`)
    }),
  )

  it.live("omits invalid image attachments instead of returning undecodable bytes", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* put(path.join(dir, "broken.jpg"), Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]))

      const result = yield* exec(dir, { filePath: path.join(dir, "broken.jpg") })
      // 内容错误必须被压成稳定文本，既不泄漏坏 bytes，也不终止后续 tool 交互。
      expect(result.output).toStartWith("Image omitted")
      expect(result.attachments).toBeUndefined()
    }),
  )

  it.live("omits a png whose IDAT stream is corrupt after valid metadata", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const png = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
        "base64",
      )
      const idat = png.indexOf(Buffer.from("IDAT"))
      // IHDR 和尺寸保持有效，仅破坏压缩流；metadata-only 实现会错误放行该向量。
      png[idat + 4] ^= 0xff
      yield* put(path.join(dir, "broken.png"), png)

      const result = yield* exec(dir, { filePath: path.join(dir, "broken.png") })
      expect(result.output).toStartWith("Image omitted")
      expect(result.attachments).toBeUndefined()
    }),
  )

  it.live("rejects PNG first chunks whose IHDR length or type is invalid", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const png = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
        "base64",
      )
      const badLength = Buffer.from(png)
      badLength.writeUInt32BE(12, 8)
      const badType = Buffer.from(png)
      badType.write("JHDR", 12, "ascii")
      for (const [name, data] of [["bad-length.png", badLength], ["bad-type.png", badType]] as const) {
        yield* put(path.join(dir, name), data)
        const result = yield* exec(dir, { filePath: path.join(dir, name) })
        // 两个向量仍保留 PNG magic，只有固定首块规则能在 decoder 前稳定区分。
        // length 与 type 分开变异，避免一个宽松检查恰好因另一个字段失败而让测试误绿。
        // omission 结果还证明结构拒绝不会回退到文本读取或原附件透传。
        expect(result.output).toStartWith("Image omitted")
        expect(result.attachments).toBeUndefined()
      }
    }),
  )

  it.live("opens valid BMP with Photon and rejects malformed BMP headers", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const bmp = Buffer.alloc(58)
      bmp.write("BM", 0, "ascii")
      bmp.writeUInt32LE(bmp.length, 2)
      bmp.writeUInt32LE(54, 10)
      bmp.writeUInt32LE(40, 14)
      bmp.writeInt32LE(1, 18)
      bmp.writeInt32LE(1, 22)
      bmp.writeUInt16LE(1, 26)
      bmp.writeUInt16LE(24, 28)
      bmp.writeUInt32LE(4, 34)
      bmp.set([0, 0, 255, 0], 54)
      yield* put(path.join(dir, "valid.bmp"), bmp)

      const valid = yield* exec(dir, { filePath: path.join(dir, "valid.bmp") })
      expect(valid.attachments?.[0].mime).toBe("image/png")
      expect(Buffer.from(valid.attachments?.[0].url.split(",")[1] ?? "", "base64").subarray(0, 8)).toEqual(
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      )

      const badSize = Buffer.from(bmp)
      badSize.writeUInt32LE(1, 2)
      const badOffset = Buffer.from(bmp)
      badOffset.writeUInt32LE(10, 10)
      const badPlanes = Buffer.from(bmp)
      badPlanes.writeUInt16LE(2, 26)
      const badBpp = Buffer.from(bmp)
      badBpp.writeUInt16LE(48, 28)
      for (const [name, data] of [
        ["bad-size.bmp", badSize],
        ["bad-offset.bmp", badOffset],
        ["bad-planes.bmp", badPlanes],
        ["bad-bpp.bmp", badBpp],
      ] as const) {
        yield* put(path.join(dir, name), data)
        const result = yield* exec(dir, { filePath: path.join(dir, name) })
        // Photon 本身会宽松接受这些头；测试必须证明 owner 的结构门禁先行生效。
        // planes=2 与 bpp=48 专门锁定 Pi 离散规则，不能仅依赖 offset/file-size 覆盖。
        // 每个错误向量都要求无 attachment，防止 WASM trap 被捕获后仍误走成功输出。
        expect(result.output).toStartWith("Image omitted")
        expect(result.attachments).toBeUndefined()
      }
    }),
  )

  it.live("validates every frame before passing through a GIF", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const gif = Buffer.from(
        "R0lGODlhBAAEAIAAAExpcUxpcSH/C05FVFNDQVBFMi4wAwEAAAAh+QQFAAAAACwAAAAABAAEAAACBIyPGQUAIfkEBQAAAAAsAAAAAAQABACATGlx/wAAAgSMjxkFADs=",
        "base64",
      )
      yield* put(path.join(dir, "valid.gif"), gif)
      const valid = yield* exec(dir, { filePath: path.join(dir, "valid.gif") })
      // 全帧验证成功后必须保留动画容器和逐字 bytes，不能把 GIF 压成首帧或其他格式。
      // 合法与损坏向量只差第二帧一个字节，使测试能够区分默认首帧 decode 和 pages:-1。
      expect(valid.attachments?.[0].mime).toBe("image/gif")
      expect(valid.attachments?.[0].url).toBe(`data:image/gif;base64,${gif.toString("base64")}`)
      // 第二帧尾部损坏时默认第一页 decode 仍成功，pages:-1 必须拒绝整个附件。
      // 先复制再变异保持合法 fixture 不变，避免两个断言共享可变 buffer 而相互污染。
      const broken = Buffer.from(gif)
      broken[89] = 0
      yield* put(path.join(dir, "broken.gif"), broken)

      const result = yield* exec(dir, { filePath: path.join(dir, "broken.gif") })
      expect(result.output).toStartWith("Image omitted")
      expect(result.attachments).toBeUndefined()
    }),
  )

  it.live("decodes generic SVG image media instead of reading it as text", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const svg = Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><rect width="2" height="2" fill="red"/></svg>',
      )
      yield* put(path.join(dir, "vector.svg"), svg)

      const result = yield* exec(dir, { filePath: path.join(dir, "vector.svg") })
      expect(result.output).toStartWith("Image read successfully")
      expect(result.attachments?.[0].mime).toBe("image/svg+xml")
      expect(result.attachments?.[0].url).toBe(`data:image/svg+xml;base64,${svg.toString("base64")}`)

      yield* put(path.join(dir, "broken.svg"), "<svg><broken")
      const broken = yield* exec(dir, { filePath: path.join(dir, "broken.svg") })
      // malformed SVG 仍会被扩展名识别为 image/*；只有统一 Image owner 能阻止 ReadTool 直接成功透传。
      expect(broken.output).toStartWith("Image omitted")
      expect(broken.attachments).toBeUndefined()
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
      if (!attachment) return
      const base64 = attachment.url.slice(attachment.url.indexOf(";base64,") + ";base64,".length)
      expect(base64.length).toBeLessThanOrEqual(1_600 * 750)
      expect(attachment).not.toHaveProperty("id")
      expect(attachment).not.toHaveProperty("sessionID")
      expect(attachment).not.toHaveProperty("messageID")
    }),
  )

  noResizer.live("omits the image when the decoder is unavailable", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const png = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
        "base64",
      )
      yield* put(path.join(dir, "image.png"), png)

      // 后端不可用时仍禁止原图回退，但 Read 本身以 bounded omission 成功返回，保证会话可继续。
      const result = yield* exec(dir, { filePath: path.join(dir, "image.png") })
      expect(result.output).toStartWith("Image omitted")
      expect(result.attachments).toBeUndefined()
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

  it.live("routes generic image mime types through the decoder", () =>
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
        // 扩展名声明的 image/* 不再落入文本读取；这些伪造内容应被 decoder 安全 omit。
        expect(result.output).toStartWith("Image omitted")
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

describe("tool.read visible context", () => {
  it.live("stubs an unchanged same range already visible in context", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const filePath = path.join(dir, "same.txt")
      yield* put(filePath, "one\ntwo\nthree")
      const input = { filePath, offset: 1, limit: 2 }

      const first = yield* exec(dir, input)
      const second = yield* exec(dir, input, { ...ctx, messages: [readMessage(input, first)] })

      expect(second.output).toContain('<range start="1" end="2" total="3" returned="0" />')
      expect(second.output).toContain('<stub status="stub_same_range_visible">')
      // 断言新文案：声明"最新版本"消除重读动机，并给出精确 offset=3 跳读出口
      // （文件共 3 行，已读 1-2，下一段未读起始即第 3 行）
      expect(second.output).toContain("are the latest version and already in context")
      expect(second.output).toContain("offset=3 for unread lines")
      expect(second.output).toContain("grep to locate symbols")
      expect(second.output).not.toContain("<content>")
      expect(second.metadata.read).toMatchObject({
        type: "file",
        start: 1,
        end: 2,
        returned: 0,
        stub: true,
        stubStatus: "stub_same_range_visible",
      })
    }),
  )

  it.live("stubs a smaller range fully covered by visible context", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const filePath = path.join(dir, "covered.txt")
      yield* put(filePath, Array.from({ length: 120 }, (_, i) => `line${i + 1}`).join("\n"))
      const firstInput = { filePath, offset: 1, limit: 100 }
      const secondInput = { filePath, offset: 40, limit: 20 }

      const first = yield* exec(dir, firstInput)
      const second = yield* exec(dir, secondInput, { ...ctx, messages: [readMessage(firstInput, first)] })

      expect(second.output).toContain('<range start="40" end="59" total="120" returned="0" />')
      expect(second.output).toContain('<stub status="stub_covered_range_visible" covered_by="1-100">')
      // 断言新文案：引用覆盖源 1-100、声明"file unchanged"消除重读动机、
      // 精确 offset=101（可见末行 100 + 1）指向下一段未读内容
      expect(second.output).toContain("covered by visible read 1-100")
      expect(second.output).toContain("file unchanged")
      expect(second.output).toContain("offset=101 for unread lines")
      expect(second.output).not.toContain("<content>")
      expect(second.metadata.read).toMatchObject({
        stub: true,
        stubStatus: "stub_covered_range_visible",
        coveredBy: "1-100",
      })
    }),
  )

  it.live("publishes the covering lower-bound total for a large covered range", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const filePath = path.join(dir, "large-covered.txt")
      const trueLineCount = 100_000
      // 两次请求在不同窗口位置结束，使 nested lower-bound 有机会弱于 covering total。
      yield* put(
        filePath,
        Array.from(
          { length: trueLineCount },
          (_, i) => `line-${i.toString().padStart(6, "0")} ${"x".repeat(160)}`,
        ).join("\n"),
      )
      const firstInput = { filePath, offset: 10_000, limit: 80 }
      const secondInput = { filePath, offset: 10_000, limit: 20 }

      const first = yield* exec(dir, firstInput)
      const coveringTotal = first.metadata.read?.total
      expect(coveringTotal).toBeDefined()
      if (coveringTotal === undefined) return
      expect(coveringTotal).toBeLessThan(trueLineCount)

      const second = yield* exec(dir, secondInput, { ...ctx, messages: [readMessage(firstInput, first)] })

      expect(second.output).toContain(`<range start="10000" end="10019" total="${coveringTotal}" returned="0" />`)
      expect(second.output).toContain('covered_by="10000-10079"')
      expect(second.output).toContain("offset=10080 for unread lines")
      // stub 的 total 和导航必须由 covering read 拥有，不能被 nested read 覆盖。
      expect(second.output).not.toContain("end of file reached")
      expect(second.metadata.read?.total).toBe(coveringTotal)
    }),
  )

  it.live("stubs same range reaching EOF: declares end of file instead of misleading offset", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const filePath = path.join(dir, "eof-same.txt")
      // 2 行文件：首次读 1-2 即读完整个文件，visibleEnd=2=total=2 → reachedEof
      yield* put(filePath, "one\ntwo")
      const input = { filePath, offset: 1, limit: 2 }

      const first = yield* exec(dir, input)
      const second = yield* exec(dir, input, { ...ctx, messages: [readMessage(input, first)] })

      expect(second.output).toContain('<stub status="stub_same_range_visible">')
      expect(second.output).toContain("are the latest version and already in context")
      // end===total 且原读取确实返回内容时，stub 才能关闭下一 offset 出口。
      // 关键回归：可见范围已覆盖到末行时不应给出 offset=3（指向 EOF 之后的空行），
      // 应改为显式声明已达文件末尾，避免模型发起必失败的 read
      expect(second.output).toContain("end of file reached")
      expect(second.output).not.toContain("offset=3 for unread lines")
      expect(second.output).toContain("grep to locate symbols")
    }),
  )

  it.live("stubs covered range reaching EOF: declares end of file instead of misleading offset", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const filePath = path.join(dir, "eof-covered.txt")
      // 50 行文件：首次读 1-50 读完整文件，第二次请求 10-20 被 1-50 覆盖，
      // visibleEnd=50=total=50 → reachedEof，不应输出 offset=51
      yield* put(filePath, Array.from({ length: 50 }, (_, i) => `line${i + 1}`).join("\n"))
      const firstInput = { filePath, offset: 1, limit: 50 }
      const secondInput = { filePath, offset: 10, limit: 11 }

      const first = yield* exec(dir, firstInput)
      const second = yield* exec(dir, secondInput, { ...ctx, messages: [readMessage(firstInput, first)] })

      expect(second.output).toContain('<stub status="stub_covered_range_visible" covered_by="1-50">')
      expect(second.output).toContain("covered by visible read 1-50")
      expect(second.output).toContain("file unchanged")
      // 关键回归：covering.end=50=total 时不应给出 offset=51（指向 EOF 之后），
      // 应改为声明已达末尾，并保留 grep 兜底出口
      expect(second.output).toContain("end of file reached")
      expect(second.output).not.toContain("offset=51 for unread lines")
      expect(second.output).toContain("grep to locate symbols")
    }),
  )

  it.live("does not stub compacted previous reads", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const filePath = path.join(dir, "compacted.txt")
      yield* put(filePath, "one\ntwo\nthree")
      const input = { filePath, offset: 1, limit: 2 }

      const first = yield* exec(dir, input)
      const second = yield* exec(dir, input, { ...ctx, messages: [readMessage(input, first, { compacted: true })] })

      expect(second.output).toContain("<content>")
      expect(second.output).toContain("1: one")
      expect(second.output).not.toContain("<stub")
    }),
  )

  it.live("does not stub when the file version changed", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const filePath = path.join(dir, "changed.txt")
      const input = { filePath, offset: 1, limit: 2 }
      yield* put(filePath, "one\ntwo\nthree")

      const first = yield* exec(dir, input)
      yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 20)))
      yield* put(filePath, "one changed\ntwo\nthree")
      const second = yield* exec(dir, input, { ...ctx, messages: [readMessage(input, first)] })

      expect(second.output).toContain("<content>")
      expect(second.output).toContain("1: one changed")
      expect(second.output).not.toContain("<stub")
    }),
  )

  // 等长改写 + utimes 锁死 mtime：size/mtime 无法区分版本，必须靠 head-sample fp 失效 suppress。
  it.live("does not stub when equal-size rewrite preserves mtime but head content changes", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const filePath = path.join(dir, "equal-mtime.txt")
      const input = { filePath, offset: 1, limit: 2 }
      const before = "AAA\nBBB\nCCC"
      const after = "XXX\nBBB\nCCC"
      expect(Buffer.byteLength(before)).toBe(Buffer.byteLength(after))
      yield* put(filePath, before)

      const first = yield* exec(dir, input)
      const stamp = yield* Effect.promise(async () => {
        const { stat } = await import("fs/promises")
        return stat(filePath)
      })
      yield* put(filePath, after)
      yield* Effect.promise(async () => {
        const { utimes } = await import("fs/promises")
        await utimes(filePath, stamp.atime, stamp.mtime)
      })
      const second = yield* exec(dir, input, { ...ctx, messages: [readMessage(input, first)] })

      expect(second.output).toContain("<content>")
      expect(second.output).toContain("1: XXX")
      expect(second.output).not.toContain("<stub")
    }),
  )

  // 历史 read 缺 fp：证明不足，禁止回退到 size+mtime 弱键 suppress。
  it.live("does not stub when visible history matches size and mtime but lacks fp", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const filePath = path.join(dir, "legacy-fp.txt")
      const input = { filePath, offset: 1, limit: 2 }
      yield* put(filePath, "one\ntwo\nthree")

      const first = yield* exec(dir, input)
      const legacy = structuredClone(first)
      const readMeta = legacy.metadata.read as Record<string, unknown> | undefined
      if (readMeta) delete readMeta.fp
      const second = yield* exec(dir, input, { ...ctx, messages: [readMessage(input, legacy)] })

      expect(second.output).toContain("<content>")
      expect(second.output).toContain("1: one")
      expect(second.output).not.toContain("<stub")
    }),
  )

  // 未改文件时 suppress 收益必须保留：新 read 写入非空 fp，同版本同区间仍 stub。
  it.live("writes non-empty fp on non-stub reads and still stubs unchanged same range", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const filePath = path.join(dir, "fp-stub.txt")
      const input = { filePath, offset: 1, limit: 2 }
      yield* put(filePath, "one\ntwo\nthree")

      const first = yield* exec(dir, input)
      // 前向写入 fp，供后续 turn 做内容身份比对（无历史回填）。
      const fp = (first.metadata.read as { fp?: string } | undefined)?.fp
      expect(typeof fp).toBe("string")
      expect(fp!.length).toBeGreaterThan(0)

      const second = yield* exec(dir, input, { ...ctx, messages: [readMessage(input, first)] })
      expect(second.output).toContain('<stub status="stub_same_range_visible">')
      expect(second.output).not.toContain("<content>")
    }),
  )

  it.live("returns full content with a short note for significant overlap", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const filePath = path.join(dir, "overlap.txt")
      yield* put(filePath, Array.from({ length: 260 }, (_, i) => `line${i + 1}`).join("\n"))
      const firstInput = { filePath, offset: 100, limit: 100 }
      const secondInput = { filePath, offset: 150, limit: 100 }

      const first = yield* exec(dir, firstInput)
      const second = yield* exec(dir, secondInput, { ...ctx, messages: [readMessage(firstInput, first)] })

        expect(second.output).toContain('<note type="overlap" ranges="150-199"')
        expect(second.output).toContain("avoid re-reading this range unnecessarily")
      expect(second.output).toContain("<content>")
      expect(second.output).toContain("150: line150")
      expect(second.output).toContain("249: line249")
      expect(second.output).not.toContain("<stub")
    }),
  )

  it.live("does not use a visible stub as coverage for later reads", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const filePath = path.join(dir, "stub-source.txt")
      yield* put(filePath, "one\ntwo\nthree")
      const input = { filePath, offset: 1, limit: 2 }

      const first = yield* exec(dir, input)
      const second = yield* exec(dir, input, { ...ctx, messages: [readMessage(input, first)] })
      const third = yield* exec(dir, input, { ...ctx, messages: [readMessage(input, second)] })

      expect(second.output).toContain('<stub status="stub_same_range_visible">')
      expect(third.output).toContain("<content>")
      expect(third.output).toContain("1: one")
      expect(third.output).not.toContain("<stub")
    }),
  )

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
})

describe("tool.read outline", () => {
  it.live("includes a short outline only when reading the head of a large source file", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const filePath = path.join(dir, "large.ts")
      const source = Array.from({ length: 650 }, (_, i) => {
        if (i === 9) return "export function alpha() {}"
        if (i === 119) return "class Beta {}"
        if (i === 239) return "const Gamma = () => {}"
        if (i === 479) return "interface Delta {}"
        return `// filler ${i + 1}`
      }).join("\n")
      yield* put(filePath, source)

      const head = yield* exec(dir, { filePath, limit: 20 })
      expect(head.output).toContain("<outline")
      expect(head.output).toContain("10 function alpha")
      expect(head.output).toContain("120 class Beta")
      expect(head.output).not.toContain("import")

      const body = yield* exec(dir, { filePath, offset: 100, limit: 20 })
      expect(body.output).not.toContain("<outline")
    }),
  )

  it.live("preserves XML-sensitive outline labels", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const filePath = path.join(dir, "large.rs")
      const source = [
        "impl<T> Parser<T> where T: Clone {",
        ...Array.from({ length: 650 }, (_, i) => `// filler ${i + 1}`),
      ].join("\n")
      yield* put(filePath, source)

      const result = yield* exec(dir, { filePath, limit: 20 })
      expect(result.output).toContain("1 impl Parser<T>")
      expect(result.output).not.toContain("Parser&lt;T&gt;")
    }),
  )

  it.live("shares the bounded auxiliary budget between page accounting and outline", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const filePath = path.join(dir, "budget-exhausted.ts")
      // page accounting 先耗尽额度；outline 不得另开完整的第二条扫描路径。
      const source = [
        "export function first() {}",
        ...Array.from({ length: 100_000 }, (_, i) => `// filler ${i + 1}`),
      ].join("\n")
      yield* put(filePath, source)

      const result = yield* exec(dir, { filePath, limit: 20 })

      expect(result.metadata.truncated).toBe(true)
      expect(result.output).toContain('<more offset="')
      // 没有 outline 是预算 owner 的可观察结果，不是 MIN_LINES gate 的偶然结果。
      expect(result.output).not.toContain("<outline")
    }),
  )

  it.live("does not use more alone to bypass the outline line gate", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const filePath = path.join(dir, "below-outline-gate.ts")
      // 文件物理很大但可观察行数仍低于 600，more 不能替代既有 outline eligibility。
      const source = [
        `export function first() { ${"x".repeat(1000)} }`,
        ...Array.from({ length: 499 }, (_, i) => `// ${i} ${"x".repeat(1000)}`),
      ].join("\n")
      yield* put(filePath, source)

      const result = yield* exec(dir, { filePath, limit: 20 })

      expect(result.metadata.truncated).toBe(true)
      expect(result.metadata.read?.total).toBeLessThan(600)
      expect(result.output).toContain('<more offset="')
      // 该断言锁定“more 证明有余量”与“达到 outline 最小行数”的语义分离。
      expect(result.output).not.toContain("<outline")
    }),
  )

  it.live("extracts conservative labels for common language declarations", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
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
        const filePath = path.join(dir, filename)
        yield* put(filePath, header + Array.from({ length: 650 }, (_, i) => `// filler ${i + 1}`).join("\n"))
        const outline = yield* Effect.promise(() => readOutline(filePath, 650, 1))
        expect(outline?.items.length).toBeGreaterThan(0)
      }
    }),
  )

  it.live("limits outline item length and total size", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const filePath = path.join(dir, "long-outline.rs")
      const source = [
        "impl VeryLongGenericTypeNameWithManySegmentsAndTraitsAndBoundsThatShouldBeTrimmed where T: Clone {",
        ...Array.from(
          { length: 650 },
          (_, i) => `pub fn function_${i}_with_a_very_long_suffix_that_should_not_bloat_the_outline() {}`,
        ),
      ].join("\n")
      yield* put(filePath, source)

      const outline = yield* Effect.promise(() => readOutline(filePath, 651, 1))
      expect(outline).toBeDefined()
      expect(outline!.items.length).toBeLessThanOrEqual(32)
      expect(outline!.items.join("\n").length).toBeLessThanOrEqual(640)
      expect(outline!.items.every((item) => item.length <= 60)).toBe(true)
      expect(outline!.items.some((item) => item.endsWith("..."))).toBe(true)
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

describe("image attachment migration", () => {
  async function fixture(dbPath: string) {
    // 小WebP作为正常图片基线，能够证明全库扫描不会自动触发重编码。
    const small = "UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA"
    // 同一大图分别落在顶层和Tool中，用于锁定“来源不改变规范化结果”的不变量。
    const large = Buffer.from(await Bun.file(path.join(FIXTURES_DIR, "large-image.png")).arrayBuffer()).toString("base64")
    // 保留合法PNG data URL外形，确保迁移面对的是Sharp DecodeError而非参数错误。
    const broken = Buffer.from("truncated image bytes").toString("base64")
    const rows = [
      JSON.stringify({ type: "file", mime: "image/webp", url: `data:image/webp;base64,${small}`, preserved: "small" }),
      JSON.stringify({ type: "file", mime: "image/png", url: `data:image/png;base64,${large}`, preserved: "large" }),
      JSON.stringify({
        type: "tool",
        tool: "read",
        state: {
          status: "completed",
          output: "large tool output",
          metadata: { preserved: true },
          attachments: [{ type: "file", mime: "image/png", url: `data:image/png;base64,${large}`, filename: "large.png" }],
        },
      }),
      JSON.stringify({
        type: "tool",
        tool: "read",
        state: {
          status: "completed",
          output: "broken tool output",
          metadata: { preserved: true },
          attachments: [{ type: "file", mime: "image/png", url: `data:image/png;base64,${broken}`, filename: "broken.png" }],
        },
      }),
    ]
    const db = new SQLite(dbPath)
    // 最小真实表只保留脚本使用的Part列，测试不复制无关生产schema。
    db.run("CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, data TEXT NOT NULL)")
    rows.forEach((data, index) =>
      db.query("INSERT INTO part VALUES (?, ?, ?, ?)").run(`prt_${index}`, `msg_${index}`, "ses_migrate", data),
    )
    db.close()
    return { rows, small: Buffer.from(small, "base64"), large: Buffer.from(large, "base64"), broken: Buffer.from(broken, "base64") }
  }

  test("previews and applies one unified image migration", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "opencode.db")
    const input = await fixture(dbPath)

    // 路径参数默认必须只读，但仍实际经过Sharp，才能准确识别规范化和不可用图片。
    const preview = await migrateImageAttachment([dbPath])
    expect(preview.exitCode).toBe(0)
    const previewReport = JSON.parse(preview.stdout.slice(preview.stdout.lastIndexOf('{\n  "status"')))
    // 四张图覆盖不变、两处规范化和一处弃用，计数变化能直接暴露漏扫或重复扫描。
    expect(previewReport).toMatchObject({
      status: "preview",
      image_attachments: 4,
      unchanged: 1,
      normalized: 2,
      unavailable: 1,
      changed_parts: 3,
      database_file_shrinks_without_vacuum: false,
    })
    expect(previewReport.unavailable_items).toEqual([{ part: "prt_3", location: "tool", index: 0 }])
    const previewDb = new SQLite(dbPath, { readonly: true })
    // preview不仅报告为只读，四行原始JSON也必须逐字不变，防止隐藏的落库副作用。
    expect(previewDb.query<{ data: string }, []>("SELECT data FROM part ORDER BY id").all().map((row) => row.data)).toEqual(input.rows)
    previewDb.close()

    const applied = await migrateImageAttachment([dbPath, "--apply"])
    expect(applied.exitCode).toBe(0)
    const report = JSON.parse(applied.stdout.slice(applied.stdout.lastIndexOf('{\n  "status"')))
    expect(report.status).toBe("applied")
    // apply断言重新读取SQLite，而不是复用CLI内存计划，确保验证的是实际持久化结果。
    const db = new SQLite(dbPath, { readonly: true })
    const storedText = db.query<{ data: string }, []>("SELECT data FROM part ORDER BY id").all().map((row) => row.data)
    const stored = storedText.map((data) => JSON.parse(data))
    db.close()

    // 正常小图必须保持字节级不变；两种来源的同一大图必须得到完全相同的统一输出。
    expect(storedText[0]).toBe(input.rows[0])
    expect(stored[1].url).not.toBe(JSON.parse(input.rows[1]).url)
    expect(stored[1].mime).toBe(stored[2].state.attachments[0].mime)
    expect(stored[1].url).toBe(stored[2].state.attachments[0].url)
    // 保留断言覆盖两种Part的未知字段，防止迁移用重建对象替代局部更新。
    expect(stored[1].preserved).toBe("large")
    expect(stored[2].state.metadata).toEqual({ preserved: true })

    // 用户授权只弃用无法解码的completed Tool图片，原Tool文本和其他字段都必须保留。
    expect(stored[3].state.attachments).toBeUndefined()
    expect(stored[3].state.output).toBe(
      "broken tool output\n\n[Image unavailable: stored image data could not be decoded.]",
    )
    expect(stored[3].state.metadata).toEqual({ preserved: true })

    // 空间值由实际输入和落库结果独立计算，不能只相信CLI自己的聚合字段。
    const oldPayload = input.small.length + input.large.length * 2 + input.broken.length
    const newPayload = input.small.length + Buffer.from(stored[1].url.split(",")[1], "base64").length * 2
    expect(report.old_payload_bytes).toBe(oldPayload)
    expect(report.new_payload_bytes).toBe(newPayload)
    expect(report.saved_payload_bytes).toBe(oldPayload - newPayload)
    // JSON逻辑空间独立于payload统计，包含data URL编码和不可用说明带来的真实差值。
    expect(report.old_part_json_bytes).toBe(input.rows.reduce((total, data) => total + Buffer.byteLength(data), 0))
    expect(report.new_part_json_bytes).toBe(storedText.reduce((total, data) => total + Buffer.byteLength(data), 0))

    // 已规范化和已标记不可用的数据再次preview必须完全幂等，不重复有损编码或追加说明。
    const repeated = await migrateImageAttachment([dbPath])
    expect(repeated.exitCode).toBe(0)
    expect(JSON.parse(repeated.stdout.slice(repeated.stdout.lastIndexOf('{\n  "status"')))).toMatchObject({
      normalized: 0,
      unavailable: 0,
      changed_parts: 0,
    })
  }, 120_000)

  test("rolls back every row when a later CAS update fails", async () => {
    await using tmp = await tmpdir()
    const dbPath = path.join(tmp.path, "opencode.db")
    const input = await fixture(dbPath)
    const db = new SQLite(dbPath)
    // 只拒绝最后一行，确保测试证明前面成功执行的UPDATE也随事务回滚。
    db.run("CREATE TRIGGER reject_last_update BEFORE UPDATE OF data ON part WHEN OLD.id = 'prt_3' BEGIN SELECT RAISE(IGNORE); END")
    db.close()

    const result = await migrateImageAttachment([dbPath, "--apply"])
    // 非零退出是事务失败的外部契约；随后逐行比对证明没有留下部分成功状态。
    expect(result.exitCode).not.toBe(0)
    const check = new SQLite(dbPath, { readonly: true })
    expect(check.query<{ data: string }, []>("SELECT data FROM part ORDER BY id").all().map((row) => row.data)).toEqual(input.rows)
    check.close()
  }, 120_000)
})
