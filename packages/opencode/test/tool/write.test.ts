import { afterEach, describe, expect, spyOn } from "bun:test"
import { Effect, Layer } from "effect"
import path from "path"
import fs from "fs/promises"
import { WriteTool } from "../../src/tool/write"
import { LSP } from "@/lsp/lsp"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Bus } from "../../src/bus"
import { Format } from "../../src/format"
import { Truncate } from "@/tool/truncate"
import { Tool } from "@/tool/tool"
import { Agent } from "../../src/agent/agent"
import { SessionID, MessageID } from "../../src/session/schema"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { disposeAllInstances, provideTmpdirInstance, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const ctx = {
  sessionID: SessionID.make("ses_test-write-session"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

afterEach(async () => {
  await disposeAllInstances()
})

const it = testEffect(
  Layer.mergeAll(
    LSP.defaultLayer,
    AppFileSystem.defaultLayer,
    Bus.layer,
    Format.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
    Truncate.defaultLayer,
    Agent.defaultLayer,
  ),
)

// [local-smark] mock Format 层：模拟 auto-format 在文件末尾追加换行，
// 使 write.ts 能检测到内容变化并设置 _formattedContent。
// 真实 formatter（prettier/gofmt）在测试环境中不可用，需要 mock。
// 用 Effect.promise 避免引入 service 依赖，保持返回类型与 Format.Service 一致。
const mockFormatLayer = Layer.succeed(Format.Service, {
  init: () => Effect.void,
  status: () => Effect.succeed([]),
  file: (filepath: string) =>
    Effect.promise(async () => {
      const content = await fs.readFile(filepath, "utf-8")
      // 模拟格式化：在末尾添加换行符（模拟 prettier 的 final newline 行为）
      await fs.writeFile(filepath, content + "\n")
      return true
    }),
})

// 使用 mock Format 层的 testEffect 实例
const itFormatted = testEffect(
  Layer.mergeAll(
    LSP.defaultLayer,
    AppFileSystem.defaultLayer,
    Bus.layer,
    mockFormatLayer,
    CrossSpawnSpawner.defaultLayer,
    Truncate.defaultLayer,
    Agent.defaultLayer,
  ),
)

// 该 formatter 同时改变语义内容并强制 LF，区分“保留格式化结果”与“恢复文件行尾属性”。
const lineEndingFormatLayer = Layer.succeed(Format.Service, {
  init: () => Effect.void,
  status: () => Effect.succeed([]),
  file: (filepath: string) =>
    Effect.promise(async () => {
      const content = await fs.readFile(filepath, "utf-8")
      await fs.writeFile(filepath, content.replace("before", "formatted").replace(/\r\n?/g, "\n"))
      return true
    }),
})

const itLineEndingFormatted = testEffect(
  Layer.mergeAll(
    LSP.defaultLayer,
    AppFileSystem.defaultLayer,
    Bus.layer,
    lineEndingFormatLayer,
    CrossSpawnSpawner.defaultLayer,
    Truncate.defaultLayer,
    Agent.defaultLayer,
  ),
)

const init = Effect.fn("WriteToolTest.init")(function* () {
  const info = yield* WriteTool
  return yield* info.init()
})

const run = Effect.fn("WriteToolTest.run")(function* (
  args: Tool.InferParameters<typeof WriteTool>,
  next: Tool.Context = ctx,
) {
  const tool = yield* init()
  return yield* tool.execute(args, next)
})

describe("tool.write", () => {
  describe("new file creation", () => {
    it.instance("writes content to new file", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "newfile.txt")
        const result = yield* run({ filePath: filepath, content: "Hello, World!" })

        expect(result.output).toContain("Wrote file successfully")
        expect(result.metadata.exists).toBe(false)

        const content = yield* Effect.promise(() => fs.readFile(filepath, "utf-8"))
        expect(content).toBe("Hello, World!")
      }),
    )

    it.instance("creates parent directories if needed", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "nested", "deep", "file.txt")
        yield* run({ filePath: filepath, content: "nested content" })

        const content = yield* Effect.promise(() => fs.readFile(filepath, "utf-8"))
        expect(content).toBe("nested content")
      }),
    )

    it.instance("handles relative paths by resolving to instance directory", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        yield* run({ filePath: "relative.txt", content: "relative content" })

        const content = yield* Effect.promise(() => fs.readFile(path.join(test.directory, "relative.txt"), "utf-8"))
        expect(content).toBe("relative content")
      }),
    )
  })

  describe("existing file overwrite", () => {
    it.instance("overwrites existing file content", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "existing.txt")
        yield* Effect.promise(() => fs.writeFile(filepath, "old content", "utf-8"))
        const result = yield* run({ filePath: filepath, content: "new content" })

        expect(result.output).toContain("Wrote file successfully")
        expect(result.metadata.exists).toBe(true)

        const content = yield* Effect.promise(() => fs.readFile(filepath, "utf-8"))
        expect(content).toBe("new content")
      }),
    )

    it.instance("preserves BOM when overwriting existing files", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "existing.cs")
        const bom = String.fromCharCode(0xfeff)
        yield* Effect.promise(() => fs.writeFile(filepath, `${bom}using System;\n`, "utf-8"))

        yield* run({ filePath: filepath, content: "using Up;\n" })

        const content = yield* Effect.promise(() => fs.readFile(filepath, "utf-8"))
        expect(content.charCodeAt(0)).toBe(0xfeff)
        expect(content.slice(1)).toBe("using Up;\n")
      }),
    )

    it.instance(
      "restores BOM after formatter strips it",
      () =>
        Effect.gen(function* () {
          const test = yield* TestInstance
          const filepath = path.join(test.directory, "formatted.cs")
          const bom = String.fromCharCode(0xfeff)
          yield* Effect.promise(() => fs.writeFile(filepath, `${bom}using System;\n`, "utf-8"))

          yield* run({ filePath: filepath, content: "using Up;\n" })

          const content = yield* Effect.promise(() => fs.readFile(filepath, "utf-8"))
          expect(content.charCodeAt(0)).toBe(0xfeff)
          expect(content.slice(1)).toBe("using Up;\n")
        }),
      {
        config: {
          formatter: {
            stripbom: {
              extensions: [".cs"],
              command: [
                "node",
                "-e",
                "const fs = require('fs'); const file = process.argv[1]; let text = fs.readFileSync(file, 'utf8'); if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); fs.writeFileSync(file, text, 'utf8')",
                "$FILE",
              ],
            },
          },
        },
      },
    )

    it.instance("returns diff in metadata for existing files", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "file.txt")
        yield* Effect.promise(() => fs.writeFile(filepath, "old", "utf-8"))
        const result = yield* run({ filePath: filepath, content: "new" })

        expect(result.metadata).toHaveProperty("filepath", filepath)
        expect(result.metadata).toHaveProperty("exists", true)
      }),
    )

    it.instance("does not show CRLF-only overwrites as content changes", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "crlf-existing.txt")
        const content = "Line 1\nLine 2\n"
        yield* Effect.promise(() => fs.writeFile(filepath, content.replaceAll("\n", "\r\n"), "utf-8"))

        const result = yield* run({ filePath: filepath, content })
        const diff = result.metadata.diff ?? ""

        expect(diff).toContain("Index:")
        expect(diff).not.toContain("-Line 1")
        expect(diff).not.toContain("+Line 1")
        expect(diff).not.toContain("-Line 2")
        expect(diff).not.toContain("+Line 2")
        // 覆写参数表示逻辑行，已有文件的 CRLF 是磁盘属性；断言磁盘字节而非归一化 diff。
        expect(yield* Effect.promise(() => fs.readFile(filepath, "utf-8"))).toBe(content.replaceAll("\n", "\r\n"))
      }),
    )

    it.instance("does not show CR-only overwrites as content changes", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "cr-existing.txt")
        const content = "Line 1\nLine 2\n"
        yield* Effect.promise(() => fs.writeFile(filepath, content.replaceAll("\n", "\r"), "utf-8"))

        const result = yield* run({ filePath: filepath, content })
        const diff = result.metadata.diff ?? ""

        expect(diff).toContain("Index:")
        expect(diff).not.toContain("-Line 1")
        expect(diff).not.toContain("+Line 1")
        expect(diff).not.toContain("-Line 2")
        expect(diff).not.toContain("+Line 2")
        // CR-only 也属于已有文件的物理属性，不能因模型统一提交 LF 而被静默清洗。
        expect(yield* Effect.promise(() => fs.readFile(filepath, "utf-8"))).toBe(content.replaceAll("\n", "\r"))
      }),
    )
  })

  describe("LSP unavailable notice", () => {
    it.instance("does not send diagnosticSummary metadata when no language server is running", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "plain.txt")
        // [local-smark] mock LSP status 返回空，模拟无 LSP 可用。
        // 测试环境可能有 bridge registry 残留导致 status() 非空，需 spy 才能可靠验证。
        const lsp = yield* LSP.Service
        const statusSpy = spyOn(lsp, "status").mockReturnValue(Effect.succeed([]))

        try {
          const result = yield* run({ filePath: filepath, content: "plain text" })

          // 无 LSP server 时只能提示 unavailable，不能给 TUI 绿色 clean 的 summary。
          expect(result.output).toContain("LSP diagnostics unavailable")
          expect("diagnosticSummary" in result.metadata).toBe(false)
        } finally {
          statusSpy.mockRestore()
        }
      }),
    )
  })

  describe("file permissions", () => {
    it.instance("sets file permissions when writing sensitive data", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "sensitive.json")
        yield* run({ filePath: filepath, content: JSON.stringify({ secret: "data" }) })

        if (process.platform !== "win32") {
          const stats = yield* Effect.promise(() => fs.stat(filepath))
          expect(stats.mode & 0o777).toBe(0o644)
        }
      }),
    )
  })

  describe("content types", () => {
    it.instance("writes JSON content", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "data.json")
        const data = { key: "value", nested: { array: [1, 2, 3] } }
        yield* run({ filePath: filepath, content: JSON.stringify(data, null, 2) })

        const content = yield* Effect.promise(() => fs.readFile(filepath, "utf-8"))
        expect(JSON.parse(content)).toEqual(data)
      }),
    )

    it.instance("writes binary-safe content", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "binary.bin")
        const content = "Hello\x00World\x01\x02\x03"
        yield* run({ filePath: filepath, content })

        const buf = yield* Effect.promise(() => fs.readFile(filepath))
        expect(buf.toString()).toBe(content)
      }),
    )

    it.instance("writes empty content", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "empty.txt")
        yield* run({ filePath: filepath, content: "" })

        const content = yield* Effect.promise(() => fs.readFile(filepath, "utf-8"))
        expect(content).toBe("")

        const stats = yield* Effect.promise(() => fs.stat(filepath))
        expect(stats.size).toBe(0)
      }),
    )

    it.instance("writes multi-line content", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "multiline.txt")
        const lines = ["Line 1", "Line 2", "Line 3", ""].join("\n")
        yield* run({ filePath: filepath, content: lines })

        const content = yield* Effect.promise(() => fs.readFile(filepath, "utf-8"))
        expect(content).toBe(lines)
      }),
    )

    it.instance("handles different line endings", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "crlf.txt")
        const content = "Line 1\r\nLine 2\r\nLine 3"
        yield* run({ filePath: filepath, content })

        const buf = yield* Effect.promise(() => fs.readFile(filepath))
        expect(buf.toString()).toBe(content)
      }),
    )
  })

  describe("error handling", () => {
    it.instance("throws error when OS denies write access", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const readonlyPath = path.join(test.directory, "readonly.txt")
        yield* Effect.promise(() => fs.writeFile(readonlyPath, "test", "utf-8"))
        yield* Effect.promise(() => fs.chmod(readonlyPath, 0o444))
        const exit = yield* run({ filePath: readonlyPath, content: "new content" }).pipe(Effect.exit)
        expect(exit._tag).toBe("Failure")
      }),
    )
  })

  describe("title generation", () => {
    it.instance("returns relative path as title", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "src", "components", "Button.tsx")
        yield* Effect.promise(() => fs.mkdir(path.dirname(filepath), { recursive: true }))

        const result = yield* run({ filePath: filepath, content: "export const Button = () => {}" })
        expect(result.title).toEndWith(path.join("src", "components", "Button.tsx"))
      }),
    )
  })

  // [local-smark] 测试 auto-format 改变内容时 _formattedContent 的设置行为。
  // mockFormatLayer 模拟 formatter 在文件末尾追加换行符。
  // _formattedContent 由 processor 的 completeToolCall 消费，用于覆盖 state.input.content，
  // 使 DB 中持久化的 input 与磁盘实际内容一致。
  describe("auto-format _formattedContent", () => {
    itLineEndingFormatted.instance("restores existing CRLF after formatter while keeping formatted content", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "formatted-crlf.ts")
        yield* Effect.promise(() => fs.writeFile(filepath, "old\r\ncontent\r\n"))

        const result = yield* run({ filePath: filepath, content: "before\ncontent\n" })

        // formatter 的文本变化必须存活，但它选择的 LF 不能覆盖 proposal 已有的 CRLF 属性。
        expect(yield* Effect.promise(() => fs.readFile(filepath, "utf-8"))).toBe("formatted\r\ncontent\r\n")
        // Tool wrapper 的可见文本 sanitizer 仍输出 LF；物理行尾保真只属于磁盘 owner。
        expect(result.metadata._formattedContent).toBe("formatted\ncontent\n")
      }),
    )

    // 格式化改变了内容（末尾追加换行）→ metadata 应包含 _formattedContent
    itFormatted.instance("sets _formattedContent when format changes content", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "file.ts")
        // 先创建已有文件，使 write 走覆写路径
        yield* Effect.promise(() => fs.writeFile(filepath, "old"))

        // 写入不含末尾换行的内容；mock formatter 会追加换行
        const result = yield* run({ filePath: filepath, content: "const x=1" })

        // _formattedContent 应为格式化后的内容（含追加的换行）
        expect(result.metadata._formattedContent).toBe("const x=1\n")
      }),
    )

    // 内容本身已含末尾换行 → formatter 追加后变为双换行，仍算"改变"
    itFormatted.instance("sets _formattedContent when format adds extra newline", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "file2.ts")
        yield* Effect.promise(() => fs.writeFile(filepath, "old"))

        const result = yield* run({ filePath: filepath, content: "const y=2\n" })

        // formatter 在已有换行后再追加一个换行
        expect(result.metadata._formattedContent).toBe("const y=2\n\n")
      }),
    )

    // 无 formatter 时 _formattedContent 不应存在（使用默认 Format 层，无 formatter 配置）
    it.instance("does not set _formattedContent when no formatter is configured", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "file3.ts")
        yield* Effect.promise(() => fs.writeFile(filepath, "old"))

        const result = yield* run({ filePath: filepath, content: "const z=3" })

        // 默认 Format 层无 formatter → formatted=false → _formattedContent 不设置
        expect(result.metadata._formattedContent).toBeUndefined()
      }),
    )
  })

  // [local-smark] 新文件写入必须携带 diff metadata，使 computeDiff 的工具流
  // 能按工具归因追踪新文件改动，而非依赖 git 兜底（后者在多 session 共享
  // worktree 时可能混入其他 session 的改动）。
  describe("new file diff metadata", () => {
    // 新文件（exists=false）无格式化：metadata.diff 应为空内容 → 写入内容的 patch
    it.instance("sets diff metadata for new file without formatting", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "new-diff.txt")
        const result = yield* run({ filePath: filepath, content: "line1\nline2\n" })

        // exists=false 确认是新文件
        expect(result.metadata.exists).toBe(false)
        // 新文件必须有 diff metadata，供 collectToolDiffs 按工具归因
        expect(result.metadata.diff).toBeDefined()
        // diff 文本应包含新增的行（+ 前缀）
        expect(result.metadata.diff).toContain("+line1")
        expect(result.metadata.diff).toContain("+line2")
      }),
    )

    // 新文件（exists=false）被 formatter 改变内容：metadata.diff 应基于格式化后的最终内容
    itFormatted.instance("sets diff metadata for new file with formatting", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "new-fmt-diff.ts")
        // 写入不含末尾换行的内容；mock formatter 会追加换行
        const result = yield* run({ filePath: filepath, content: "const x=1" })

        expect(result.metadata.exists).toBe(false)
        expect(result.metadata.diff).toBeDefined()
        // diff 应反映格式化后的最终内容（含追加的换行）
        expect(result.metadata.diff).toContain("+const x=1")
      }),
    )

    // 已有文件覆写：metadata.diff 应为旧内容 → 新内容的 patch（保持既有行为）
    it.instance("sets diff metadata for existing file overwrite", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "overwrite-diff.txt")
        yield* Effect.promise(() => fs.writeFile(filepath, "old content", "utf-8"))

        const result = yield* run({ filePath: filepath, content: "new content" })

        expect(result.metadata.exists).toBe(true)
        expect(result.metadata.diff).toBeDefined()
        expect(result.metadata.diff).toContain("-old content")
        expect(result.metadata.diff).toContain("+new content")
      }),
    )
  })
})
