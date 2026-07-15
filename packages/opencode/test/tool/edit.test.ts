import { afterEach, describe, expect, spyOn } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { Cause, Deferred, Effect, Exit, Fiber, Layer } from "effect"
import { EditTool } from "../../src/tool/edit"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { LSP } from "@/lsp/lsp"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Format } from "../../src/format"
import { Agent } from "../../src/agent/agent"
import { Bus } from "../../src/bus"
import { Truncate } from "@/tool/truncate"
import { SessionID, MessageID, PartID } from "../../src/session/schema"
import { MessageV2 } from "../../src/session/message-v2"
import { ModelID, ProviderID } from "../../src/provider/schema"
import * as Tool from "../../src/tool/tool"
import { testEffect } from "../lib/effect"
import { FileWatcher } from "../../src/file/watcher"

const ctx = {
  sessionID: SessionID.make("ses_test-edit-session"),
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

const layer = Layer.mergeAll(
  LSP.defaultLayer,
  AppFileSystem.defaultLayer,
  Format.defaultLayer,
  Bus.layer,
  Truncate.defaultLayer,
  Agent.defaultLayer,
)

const it = testEffect(layer)

const init = Effect.fn("EditToolTest.init")(function* () {
  const info = yield* EditTool
  return yield* info.init()
})

// [local-smark] 构造包含 prior read 的 context，模拟生产环境中 edit 前已 read 文件的正常流程。
// blind edit 检查要求 ctx.messages 中有指向同一文件的已完成 read/write/edit tool part。
function ctxWithPriorRead(filePath: string): Tool.Context {
  // 使用 branded message/part/provider/model IDs，让 fixture 漂移能被真实 Tool.Context 类型立即发现。
  const messageID = MessageID.make("msg_prior")
  return {
    ...ctx,
    messages: [
      {
        // Assistant parentID 与模型品牌字段完整构造，避免 prior-read 测试只验证一个伪造的局部对象。
        info: {
          id: messageID,
          role: "assistant",
          sessionID: ctx.sessionID,
          parentID: ctx.messageID,
          agent: "build",
          mode: "build",
          path: { cwd: ".", root: "." },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: ModelID.make("test"),
          providerID: ProviderID.make("test"),
          time: { created: 0 },
        } satisfies MessageV2.Assistant,
        parts: [
          // completed read state 必须含 title 和完整时间，才能与生产消息历史的 read gate 使用同一契约。
          {
            id: PartID.make("prt_prior"),
            messageID,
            sessionID: ctx.sessionID,
            type: "tool",
            tool: "read",
            callID: "call_prior",
            state: {
              status: "completed",
              input: { filePath },
              output: "content",
              title: "Read",
              metadata: {},
              time: { start: 0, end: 1 },
            },
          } satisfies MessageV2.ToolPart,
        ],
      } satisfies MessageV2.WithParts,
    ],
  }
}

const run = Effect.fn("EditToolTest.run")(function* (
  args: Tool.InferParameters<typeof EditTool>,
  next?: Tool.Context,
) {
  const tool = yield* init()
  // [local-smark] 当未指定 next 且 oldString 非空时，自动注入 prior read context，
  // 模拟生产环境中 edit 前已 read 文件的正常流程。
  // 显式传入 next 的测试（如 blind edit 检查测试）使用传入的 context。
  const context = next ?? (args.oldString !== "" ? ctxWithPriorRead(args.filePath) : ctx)
  return yield* tool.execute(args, context)
})

const fail = Effect.fn("EditToolTest.fail")(function* (args: Tool.InferParameters<typeof EditTool>) {
  const exit = yield* run(args).pipe(Effect.exit)
  if (Exit.isFailure(exit)) {
    const err = Cause.squash(exit.cause)
    return err instanceof Error ? err : new Error(String(err))
  }
  throw new Error("expected edit to fail")
})

const put = Effect.fn("EditToolTest.put")(function* (p: string, content: string) {
  const fs = yield* AppFileSystem.Service
  yield* fs.writeWithDirs(p, content)
})

const load = Effect.fn("EditToolTest.load")(function* (p: string) {
  const fs = yield* AppFileSystem.Service
  return yield* fs.readFileString(p)
})

const loadRaw = Effect.fn("EditToolTest.loadRaw")(function* (p: string) {
  return yield* Effect.promise(() => fs.readFile(p, "utf-8"))
})

const makeDirectory = Effect.fn("EditToolTest.makeDirectory")(function* (p: string) {
  const fs = yield* AppFileSystem.Service
  yield* fs.makeDirectory(p)
})

const onceBus = Effect.fn("EditToolTest.onceBus")(function* (def: typeof FileWatcher.Event.Updated) {
  const bus = yield* Bus.Service
  const deferred = yield* Deferred.make<void>()
  const unsub = yield* bus.subscribeCallback(def, () => Effect.runSync(Deferred.succeed(deferred, undefined)))
  yield* Effect.addFinalizer(() => Effect.sync(unsub))
  return deferred
})

describe("tool.edit", () => {
  describe("creating new files", () => {
    it.instance("creates new file when oldString is empty", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "newfile.txt")
        const result = yield* run({ filePath: filepath, oldString: "", newString: "new content" })

        expect(result.metadata.diff).toContain("new content")
        expect(yield* load(filepath)).toBe("new content")
      }),
    )

    it.instance("preserves BOM when oldString is empty on existing files", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "existing.cs")
        const bom = String.fromCharCode(0xfeff)
        yield* put(filepath, `${bom}using System;\n`)

        const result = yield* run({ filePath: filepath, oldString: "", newString: "using Up;\n" })

        expect(result.metadata.diff).toContain("-using System;")
        expect(result.metadata.diff).toContain("+using Up;")

        const content = yield* loadRaw(filepath)
        expect(content.charCodeAt(0)).toBe(0xfeff)
        expect(content.slice(1)).toBe("using Up;\n")
      }),
    )

    it.instance("creates new file with nested directories", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "nested", "dir", "file.txt")

        yield* run({ filePath: filepath, oldString: "", newString: "nested file" })

        expect(yield* load(filepath)).toBe("nested file")
      }),
    )

    it.instance("emits add event for new files", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const updated = yield* onceBus(FileWatcher.Event.Updated)

        yield* run({ filePath: path.join(test.directory, "new.txt"), oldString: "", newString: "content" })
        yield* Deferred.await(updated)
      }),
    )
  })

  describe("editing existing files", () => {
    it.instance("replaces text in existing file", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "existing.txt")
        yield* put(filepath, "old content here")

        const result = yield* run({ filePath: filepath, oldString: "old content", newString: "new content" })

        expect(result.output).toContain("Edit applied successfully")
        expect(yield* load(filepath)).toBe("new content here")
      }),
    )

    it.instance("replaces the first visible line in BOM files", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "existing.cs")
        const bom = String.fromCharCode(0xfeff)
        yield* put(filepath, `${bom}using System;\nclass Test {}\n`)

        const result = yield* run({ filePath: filepath, oldString: "using System;", newString: "using Up;" })

        expect(result.metadata.diff).toContain("-using System;")
        expect(result.metadata.diff).toContain("+using Up;")
        expect(result.metadata.diff).not.toContain(bom)

        const content = yield* loadRaw(filepath)
        expect(content.charCodeAt(0)).toBe(0xfeff)
        expect(content.slice(1)).toBe("using Up;\nclass Test {}\n")
      }),
    )

    it.instance("throws error when file does not exist", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        expect(
          (yield* fail({ filePath: path.join(test.directory, "nonexistent.txt"), oldString: "old", newString: "new" }))
            .message,
        ).toContain("not found")
      }),
    )

    it.instance("throws error when oldString equals newString", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "file.txt")
        yield* put(filepath, "content")

        expect((yield* fail({ filePath: filepath, oldString: "same", newString: "same" })).message).toContain(
          "identical",
        )
      }),
    )

    it.instance("throws error when oldString not found in file", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "file.txt")
        yield* put(filepath, "actual content")

        expect(yield* fail({ filePath: filepath, oldString: "not in file", newString: "replacement" })).toBeInstanceOf(
          Error,
        )
      }),
    )

    // [local-smark] 当 oldString 未匹配时，error 应包含 actual content 的最近似区域，
    // 帮助模型自纠正而无需单独 re-read 文件。
    it.instance("error includes closest match when oldString not found", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "file.txt")
        // 文件内容含 "actual content"，模型搜索 "actual contnet"（拼写错误）
        yield* put(filepath, "line1\nactual content here\nline3")

        const error = yield* fail({
          filePath: filepath,
          oldString: "actual contnet",
          newString: "replacement",
        })

        expect(error).toBeInstanceOf(Error)
        // error 消息应包含文件中的实际内容片段，帮助模型发现拼写差异
        expect(error.message).toContain("actual content")
      }),
    )

    // 旧 scorer 会因候选越长而得到大于 1 的分数，并把字符重排的长行误报为 closest。
    // 有序 bigram window 必须选择第 4 行的真实近似文本，并报告候选本身的起始行。
    it.instance("closest match rejects an unrelated long-line decoy", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "decoy.txt")
        const decoy = "a".repeat(180) + "t".repeat(180) + "e".repeat(180)
        const candidate = "prefix target sequence alpha beta gammo suffix"
        yield* put(filepath, `${decoy}\nfiller one\nfiller two\n${candidate}\n`)

        const error = yield* fail({
          filePath: filepath,
          oldString: "target sequence alpha beta gamma",
          newString: "replacement",
        })

        expect(error.message).toContain("Closest match at line 4")
        expect(error.message).toContain(candidate)
        expect(error.message).not.toContain(decoy)
      }),
    )

    // 两行窗口只有一个字符不同，bounded score 应可靠选择真实候选并报告其起始行。
    // requested 全文已存在于 Tool input；错误只展示 actual 局部和一基差异列，避免再次复制 oldString。
    // 独立列号断言同时证明长公共前缀不会掩盖真正变化字符。
    it.instance("closest match shows actual candidate for a single-char mismatch", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "charmatch.txt")
        // 文件用 x = 0，模型用 x = 1 匹配
        yield* put(filepath, "return value;\nprivate int x = 0;")

        const error = yield* fail({
          filePath: filepath,
          oldString: "return value;\nprivate int x = 1;",
          newString: "replacement",
        })

        expect(error).toBeInstanceOf(Error)
        expect(error.message).toContain("Closest match at line 1")
        expect(error.message).toContain('line 2 actual: "private int x = 0;"')
        expect(error.message).toContain("difference: requested columns 17-17 differ from actual columns 17-17")
        expect(error.message).not.toContain("private int x = 1;")
      }),
    )

    // oldString 与文件结构完全无关时没有可信位置，任何 excerpt 都会制造 false precision。
    // 低于阈值的候选必须被抑制，并明确要求重新读取文件。
    it.instance("suppresses candidates when oldString structure mismatches file", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "mismatch.txt")
        yield* put(filepath, "public class Foo {\n    private int x;\n    public void bar() {\n        x = 42;\n    }\n}")

        const error = yield* fail({
          filePath: filepath,
          oldString: "def hello():\n    print('hello')\n    return True",
          newString: "replacement",
        })

        expect(error).toBeInstanceOf(Error)
        expect(error.message).toContain("No reliable nearby candidate was found")
        expect(error.message).not.toContain("public class Foo")
      }),
    )

    // 两个窗口与 expected 只有最后一个字符不同且得分完全相同，任何择一都会制造假精度。
    // tie gate 必须省略两处文本并明确要求重新 read，而不是依赖文件顺序。
    it.instance("suppresses tied closest candidates", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "tied.txt")
        yield* put(
          filepath,
          "target sequence alpha beta gammo\nfiller\ntarget sequence alpha beta gammi\n",
        )

        const error = yield* fail({
          filePath: filepath,
          oldString: "target sequence alpha beta gamma",
          newString: "replacement",
        })

        expect(error.message).toContain("No reliable nearby candidate was found")
        expect(error.message).not.toContain("gammo")
        expect(error.message).not.toContain("gammi")
      }),
    )

    // [local-smark] 当文件在当前 session 中从未被 read 或 write 过时，
    // edit 应拒绝执行并提示先 read，避免 oldString 基于过期/假设内容匹配失败。
    // 显式使用 ctx（messages 为空）模拟"从未读过"的场景。
    it.instance("rejects edit on file not previously read or written", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "unread.txt")
        yield* put(filepath, "content")

        // 显式传入 ctx（无 prior read）使 blind edit 检查生效
        const tool = yield* init()
        const exit = yield* tool.execute({ filePath: filepath, oldString: "content", newString: "modified" }, ctx).pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          const err = Cause.squash(exit.cause) as Error
          expect(err.message).toContain("not been read")
        }
      }),
    )

    // 已经 read 过的文件可以正常 edit
    // [local-smark] 通过 ctx.messages 模拟"已读过"的场景：
    // 构造一个包含 read tool part 的 assistant message，使 edit 能检测到文件已被读过
    it.instance("allows edit when messages contain prior read of same file", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "read-then-edit.txt")
        yield* put(filepath, "original")

        // 构造 ctx，messages 中包含一个已完成的 read tool part 指向同一文件
        const ctxWithRead = {
          ...ctx,
          messages: [
            {
              info: { id: "msg_prior", role: "assistant" as const, sessionID: ctx.sessionID, agent: "build", mode: "build", path: { cwd: test.directory, root: test.directory }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, modelID: "test", providerID: "test", time: { created: 0 } },
              parts: [
                {
                  id: "p_read",
                  messageID: "msg_prior",
                  sessionID: ctx.sessionID,
                  type: "tool" as const,
                  tool: "read",
                  callID: "call_read",
                  state: { status: "completed" as const, input: { filePath: filepath }, output: "content", metadata: {}, time: { start: 0, end: 1 } },
                },
              ],
            },
          ] as any,
        }

        // edit 应该成功，因为 messages 中有 prior read
        const result = yield* run({ filePath: filepath, oldString: "original", newString: "modified" }, ctxWithRead)
        expect(result.output).toContain("Edit applied successfully")
      }),
    )

    // oldString 为空（创建文件）时不检查是否读过
    it.instance("allows edit with empty oldString without prior read", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "new-file.txt")

        const result = yield* run({ filePath: filepath, oldString: "", newString: "new content" })
        expect(result.output).toContain("Edit applied successfully")
      }),
    )

    it.instance("replaces all occurrences with replaceAll option", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "file.txt")
        yield* put(filepath, "foo bar foo baz foo")

        yield* run({ filePath: filepath, oldString: "foo", newString: "qux", replaceAll: true })

        expect(yield* load(filepath)).toBe("qux bar qux baz qux")
      }),
    )

    // Edit 的唯一成功语义是 exact literal；历史 trim/whitespace/indent/escape/anchor 路径全部退出成功域。
    // 每个失败后都读取原文件，防止某个兼容 replacer 在报错前已经写入非字面替换。
    it.instance("rejects every nonliteral replacement class", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const cases = [
          { actual: "\tvalue", old: "  value", name: "trim" },
          { actual: "alpha\tbeta", old: "alpha beta", name: "whitespace" },
          { actual: "  first\n  second", old: "first\nsecond", name: "indent" },
          { actual: "line\nnext", old: "line\\nnext", name: "escape" },
          { actual: "value", old: " value ", name: "boundary" },
          { actual: "start\nactual middle\nend", old: "start\nwrong middle\nend", name: "anchor" },
        ]

        for (const [index, item] of cases.entries()) {
          const filepath = path.join(test.directory, `${index}-${item.name}.txt`)
          yield* put(filepath, item.actual)
          const error = yield* fail({ filePath: filepath, oldString: item.old, newString: "changed" })
          expect(error.message).toContain("Could not find oldString")
          expect(yield* load(filepath)).toBe(item.actual)
        }
      }),
    )

    // 多处 exact occurrence 不能默认选择第一处；只有显式 replaceAll 才授权全部替换。
    // 失败路径必须发生在 permission/write 之前，文件内容因此保持逐字不变。
    it.instance("rejects duplicate exact matches without replaceAll", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "duplicates.txt")
        yield* put(filepath, "foo bar foo")

        const error = yield* fail({ filePath: filepath, oldString: "foo", newString: "qux" })

        expect(error.message).toContain("Found multiple matches")
        expect(yield* load(filepath)).toBe("foo bar foo")
      }),
    )

    it.instance("emits change event for existing files", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "file.txt")
        yield* put(filepath, "original")
        const updated = yield* onceBus(FileWatcher.Event.Updated)

        yield* run({ filePath: filepath, oldString: "original", newString: "modified" })
        yield* Deferred.await(updated)
      }),
    )
  })

  describe("edge cases", () => {
    it.instance("handles multiline replacements", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "file.txt")
        yield* put(filepath, "line1\nline2\nline3")

        yield* run({ filePath: filepath, oldString: "line2", newString: "new line 2\nextra line" })

        expect(yield* load(filepath)).toBe("line1\nnew line 2\nextra line\nline3")
      }),
    )

    it.instance("handles CRLF line endings", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "file.txt")
        yield* put(filepath, "line1\r\nold\r\nline3")

        yield* run({ filePath: filepath, oldString: "old", newString: "new" })

        expect(yield* load(filepath)).toBe("line1\r\nnew\r\nline3")
      }),
    )

    it.instance("throws error when oldString equals newString", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "file.txt")
        yield* put(filepath, "content")

        expect((yield* fail({ filePath: filepath, oldString: "", newString: "" })).message).toContain("identical")
      }),
    )

    it.instance("throws error when path is directory", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const dirpath = path.join(test.directory, "adir")
        yield* makeDirectory(dirpath)

        expect((yield* fail({ filePath: dirpath, oldString: "old", newString: "new" })).message).toContain("directory")
      }),
    )

    it.instance("tracks file diff statistics", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "file.txt")
        yield* put(filepath, "line1\nline2\nline3")

        const result = yield* run({ filePath: filepath, oldString: "line2", newString: "new line a\nnew line b" })

        expect(result.metadata.filediff).toBeDefined()
        expect(result.metadata.filediff.file).toBe(filepath)
        expect(result.metadata.filediff.additions).toBeGreaterThan(0)
      }),
    )
  })

  describe("line endings", () => {
    const old = "alpha\nbeta\ngamma"
    const next = "alpha\nbeta-updated\ngamma"
    const alt = "alpha\nbeta\nomega"

    const normalize = (text: string, ending: "\n" | "\r\n") => {
      const normalized = text.replaceAll("\r\n", "\n")
      if (ending === "\n") return normalized
      return normalized.replaceAll("\n", "\r\n")
    }

    const count = (content: string) => {
      const crlf = content.match(/\r\n/g)?.length ?? 0
      const lf = content.match(/\n/g)?.length ?? 0
      return {
        crlf,
        lf: lf - crlf,
      }
    }

    const expectLf = (content: string) => {
      const counts = count(content)
      expect(counts.crlf).toBe(0)
      expect(counts.lf).toBeGreaterThan(0)
    }

    const expectCrlf = (content: string) => {
      const counts = count(content)
      expect(counts.lf).toBe(0)
      expect(counts.crlf).toBeGreaterThan(0)
    }

    type Input = {
      content: string
      oldString: string
      newString: string
      replaceAll?: boolean
    }

    const apply = Effect.fn("EditToolTest.lineEndings.apply")(function* (input: Input) {
      const test = yield* TestInstance
      const filePath = path.join(test.directory, "test.txt")
      yield* put(filePath, input.content)
      yield* run({
        filePath,
        oldString: input.oldString,
        newString: input.newString,
        replaceAll: input.replaceAll,
      })
      return yield* load(filePath)
    })

    it.instance("preserves LF with LF multi-line strings", () =>
      Effect.gen(function* () {
        const content = normalize(old + "\n", "\n")
        const output = yield* apply({
          content,
          oldString: normalize(old, "\n"),
          newString: normalize(next, "\n"),
        })
        expect(output).toBe(normalize(next + "\n", "\n"))
        expectLf(output)
      }),
    )

    it.instance("preserves CRLF with CRLF multi-line strings", () =>
      Effect.gen(function* () {
        const content = normalize(old + "\n", "\r\n")
        const output = yield* apply({
          content,
          oldString: normalize(old, "\r\n"),
          newString: normalize(next, "\r\n"),
        })
        expect(output).toBe(normalize(next + "\n", "\r\n"))
        expectCrlf(output)
      }),
    )

    it.instance("preserves LF when old/new use CRLF", () =>
      Effect.gen(function* () {
        const content = normalize(old + "\n", "\n")
        const output = yield* apply({
          content,
          oldString: normalize(old, "\r\n"),
          newString: normalize(next, "\r\n"),
        })
        expect(output).toBe(normalize(next + "\n", "\n"))
        expectLf(output)
      }),
    )

    it.instance("preserves CRLF when old/new use LF", () =>
      Effect.gen(function* () {
        const content = normalize(old + "\n", "\r\n")
        const output = yield* apply({
          content,
          oldString: normalize(old, "\n"),
          newString: normalize(next, "\n"),
        })
        expect(output).toBe(normalize(next + "\n", "\r\n"))
        expectCrlf(output)
      }),
    )

    it.instance("preserves LF when newString uses CRLF", () =>
      Effect.gen(function* () {
        const content = normalize(old + "\n", "\n")
        const output = yield* apply({
          content,
          oldString: normalize(old, "\n"),
          newString: normalize(next, "\r\n"),
        })
        expect(output).toBe(normalize(next + "\n", "\n"))
        expectLf(output)
      }),
    )

    it.instance("preserves CRLF when newString uses LF", () =>
      Effect.gen(function* () {
        const content = normalize(old + "\n", "\r\n")
        const output = yield* apply({
          content,
          oldString: normalize(old, "\r\n"),
          newString: normalize(next, "\n"),
        })
        expect(output).toBe(normalize(next + "\n", "\r\n"))
        expectCrlf(output)
      }),
    )

    it.instance("preserves LF with mixed old/new line endings", () =>
      Effect.gen(function* () {
        const content = normalize(old + "\n", "\n")
        const output = yield* apply({
          content,
          oldString: "alpha\nbeta\r\ngamma",
          newString: "alpha\r\nbeta\nomega",
        })
        expect(output).toBe(normalize(alt + "\n", "\n"))
        expectLf(output)
      }),
    )

    it.instance("preserves CRLF with mixed old/new line endings", () =>
      Effect.gen(function* () {
        const content = normalize(old + "\n", "\r\n")
        const output = yield* apply({
          content,
          oldString: "alpha\r\nbeta\ngamma",
          newString: "alpha\nbeta\r\nomega",
        })
        expect(output).toBe(normalize(alt + "\n", "\r\n"))
        expectCrlf(output)
      }),
    )

    it.instance("replaceAll preserves LF for multi-line blocks", () =>
      Effect.gen(function* () {
        const blockOld = "alpha\nbeta"
        const blockNew = "alpha\nbeta-updated"
        const content = normalize(blockOld + "\n" + blockOld + "\n", "\n")
        const output = yield* apply({
          content,
          oldString: normalize(blockOld, "\n"),
          newString: normalize(blockNew, "\n"),
          replaceAll: true,
        })
        expect(output).toBe(normalize(blockNew + "\n" + blockNew + "\n", "\n"))
        expectLf(output)
      }),
    )

    it.instance("replaceAll preserves CRLF for multi-line blocks", () =>
      Effect.gen(function* () {
        const blockOld = "alpha\nbeta"
        const blockNew = "alpha\nbeta-updated"
        const content = normalize(blockOld + "\n" + blockOld + "\n", "\r\n")
        const output = yield* apply({
          content,
          oldString: normalize(blockOld, "\r\n"),
          newString: normalize(blockNew, "\r\n"),
          replaceAll: true,
        })
        expect(output).toBe(normalize(blockNew + "\n" + blockNew + "\n", "\r\n"))
        expectCrlf(output)
      }),
    )
  })

  describe("concurrent editing", () => {
    it.instance("preserves concurrent edits to different sections of the same file", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "file.txt")
        yield* put(filepath, "top = 0\nmiddle = keep\nbottom = 0\n")

        const firstAsk = yield* Deferred.make<void>()
        let asks = 0
        // [local-smark] delayedCtx 需要包含 prior read 才能通过 blind edit 检查
        const delayedCtx = {
          ...ctxWithPriorRead(filepath),
          ask: () =>
            Effect.gen(function* () {
              asks++
              if (asks !== 1) return
              yield* Deferred.succeed(firstAsk, undefined)
              yield* Effect.sleep("50 millis")
            }),
        }

        const first = yield* run(
          {
            filePath: filepath,
            oldString: "top = 0",
            newString: "top = 1",
          },
          delayedCtx,
        ).pipe(Effect.forkScoped)

        yield* Deferred.await(firstAsk)
        yield* Effect.all([
          Fiber.join(first),
          run(
            {
              filePath: filepath,
              oldString: "bottom = 0",
              newString: "bottom = 2",
            },
            delayedCtx,
          ),
        ])

        expect(yield* load(filepath)).toBe("top = 1\nmiddle = keep\nbottom = 2\n")
      }),
    )
  })

  // [local-smark] 当 LSP 不可用时（无 language server 运行），edit 的 output
  // 应包含 "LSP diagnostics unavailable" 提示，避免模型误认为"无类型错误"。
  // 测试环境可能有 bridge registry 残留，需 mock status() 返回空才能可靠验证。
  describe("LSP unavailable notice", () => {
    it.instance("appends LSP unavailable notice when no language server is running", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "file.txt")
        yield* put(filepath, "content")
        // [local-smark] mock LSP status 返回空，模拟无 LSP 可用。
        const lsp = yield* LSP.Service
        const statusSpy = spyOn(lsp, "status").mockReturnValue(Effect.succeed([]))

        try {
          const result = yield* run({ filePath: filepath, oldString: "content", newString: "modified" })

          // 无 LSP server 时 output 应包含不可用提示
          expect(result.output).toContain("LSP diagnostics unavailable")
          // metadata 不携带 summary，TUI 才不会把 unavailable 误渲染成绿色 clean。
          expect("diagnosticSummary" in result.metadata).toBe(false)
        } finally {
          statusSpy.mockRestore()
        }
      }),
    )
  })
})
