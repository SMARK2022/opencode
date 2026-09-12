import { afterEach, describe, expect, spyOn, test } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { Cause, Deferred, Effect, Exit, Fiber, Layer } from "effect"
import { EditTool, trimDiff } from "../../src/tool/edit"
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
import { closestWindow } from "@/patch/match"
import { canonicalReadPath } from "../../src/tool/read"
import { renderFileDiff } from "@/tool/file-diff"

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

// mock format：文件末尾追加换行，用于 create+format 的 _syncInput 真值回写
const mockFormatLayer = Layer.succeed(Format.Service, {
  init: () => Effect.void,
  status: () => Effect.succeed([]),
  file: (filepath: string) =>
    Effect.promise(async () => {
      const content = await fs.readFile(filepath, "utf-8")
      await fs.writeFile(filepath, content + "\n")
      return true
    }),
})

const itFormatted = testEffect(
  Layer.mergeAll(
    LSP.defaultLayer,
    AppFileSystem.defaultLayer,
    Bus.layer,
    mockFormatLayer,
    Truncate.defaultLayer,
    Agent.defaultLayer,
  ),
)

// 同时改文本并强制 LF，确保测试能区分 formatter authority 与 existing-file EOL authority。
const lineEndingFormatLayer = Layer.succeed(Format.Service, {
  init: () => Effect.void,
  status: () => Effect.succeed([]),
  file: (filepath: string) =>
    Effect.promise(async () => {
      // fixture 主动制造 formatter 的 LF 输出，才能验证 restore 位于 formatter 之后。
      const content = await fs.readFile(filepath, "utf-8")
      await fs.writeFile(filepath, content.replace("new", "formatted").replace(/\r\n?/g, "\n"))
      return true
    }),
})

const itLineEndingFormatted = testEffect(
  Layer.mergeAll(
    LSP.defaultLayer,
    AppFileSystem.defaultLayer,
    Bus.layer,
    lineEndingFormatLayer,
    Truncate.defaultLayer,
    Agent.defaultLayer,
  ),
)

// [local-smark] 小 limits + pass-through 截断：隔离 wrapper 截断，迫使 edit 组装段自身
// 遵守 limits 预算（真实 wrapper 会按同一 limits 做 head 截断，丢末尾 warning）。
const itTruncated = testEffect(
  Layer.mergeAll(
    LSP.defaultLayer,
    AppFileSystem.defaultLayer,
    Format.defaultLayer,
    Bus.layer,
    Layer.mock(Truncate.Service, {
      limits: () => Effect.succeed({ maxLines: 20, maxBytes: 1024 }),
      output: (text: string) => Effect.succeed({ content: text, truncated: false }),
      // C01 工件兜底路径：超预算 diff 会调 write，mock 必须提供而不是抛 UnimplementedError。
      write: () => Effect.succeed("<artifact>"),
    }),
    Agent.defaultLayer,
  ),
)

// [local-smark] 中档预算层：diff 预算（limits−2048B/10行 保留额）落在「部分可显示」
// 区间，C01 前缀测试才能区分连续前缀与跳行截断；itTruncated 的 1024B 会裁到 0 行。
const itMidBudget = testEffect(
  Layer.mergeAll(
    LSP.defaultLayer,
    AppFileSystem.defaultLayer,
    Format.defaultLayer,
    Bus.layer,
    Layer.mock(Truncate.Service, {
      limits: () => Effect.succeed({ maxLines: 100, maxBytes: 4096 }),
      output: (text: string) => Effect.succeed({ content: text, truncated: false }),
      write: () => Effect.succeed("<artifact>"),
    }),
    Agent.defaultLayer,
  ),
)

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

// 测试入参允许 legacy 顶层字段；execute 前由 prepareArguments 折成 edits[]。
type EditTestArgs =
  | Tool.InferParameters<typeof EditTool>
  | {
      filePath: string
      oldString: string
      newString: string
      replaceAll?: boolean
    }

// 多 part 历史 fixture（INV-04/05/09 共享）：state.time.end 是时效判定的时间源；
// readRange 走 metadata.read 才能进入 collectVisibleReads 的可见性协议（生产同构）。
type HistoryEntry = {
  tool: "read" | "edit" | "write" | "apply_patch"
  end: number
  file?: string
  readRange?: { start: number; end: number }
  // compacted 会话压缩标记：可见性协议（visibleReadMeta）必须将其排除
  compacted?: boolean
}

function ctxWithHistory(filePath: string, entries: HistoryEntry[]): Tool.Context {
  const messageID = MessageID.make("msg_history")
  const parts = entries.map((entry, index) => {
    const file = entry.file ?? filePath
    const input =
      entry.tool === "apply_patch" ? { patchText: `*** Update File: ${file}` } : { filePath: file }
    // 生产上每个 completed read 都携带 metadata.read；fixture 缺省补一个单行区间，
    // 只有携带 metadata 的 read 才能进入可见性协议（无 metadata 的历史形态不算可见读取）。
    const readRange = entry.readRange ?? { start: 1, end: 1 }
    const metadata =
      entry.tool === "read"
        ? {
            read: {
              type: "file",
              path: file,
              canonicalPath: canonicalReadPath(file),
              size: 1,
              modified: "",
              modifiedMs: 1,
              fp: "fp",
              start: readRange.start,
              end: readRange.end,
              total: readRange.end,
              returned: readRange.end - readRange.start + 1,
              stub: false,
            },
          }
        : {}
    return {
      id: PartID.make(`prt_history_${index}`),
      messageID,
      sessionID: ctx.sessionID,
      type: "tool" as const,
      tool: entry.tool,
      callID: `call_history_${index}`,
      state: {
        status: "completed" as const,
        input,
        output: "ok",
        title: entry.tool,
        metadata,
        time: { start: entry.end - 1, end: entry.end, ...(entry.compacted ? { compacted: entry.end } : {}) },
      },
    } satisfies MessageV2.ToolPart
  })
  return {
    ...ctx,
    messages: [
      {
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
        parts,
      } satisfies MessageV2.WithParts,
    ],
  }
}

function isCreateArgs(args: EditTestArgs) {
  if ("edits" in args && Array.isArray(args.edits) && args.edits.length > 0) {
    return args.edits.length === 1 && args.edits[0]?.oldString === ""
  }
  return "oldString" in args && args.oldString === ""
}

const failWith = Effect.fn("EditToolTest.failWith")(function* (args: EditTestArgs, context: Tool.Context) {
  const exit = yield* run(args, context).pipe(Effect.exit)
  if (Exit.isFailure(exit)) {
    const err = Cause.squash(exit.cause)
    return err instanceof Error ? err : new Error(String(err))
  }
  throw new Error("expected edit to fail")
})

const run = Effect.fn("EditToolTest.run")(function* (args: EditTestArgs, next?: Tool.Context) {
  const tool = yield* init()
  // [local-smark] 非 create 时注入 prior read；兼容 edits[] 与 legacy 顶层 oldString。
  const context = next ?? (!isCreateArgs(args) ? ctxWithPriorRead(args.filePath) : ctx)
  return yield* tool.execute(args as Tool.InferParameters<typeof EditTool>, context)
})

const fail = Effect.fn("EditToolTest.fail")(function* (args: EditTestArgs) {
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

function scalarDistance(left: string[], right: string[]) {
  // oracle 使用普通二维递推的一行压缩形式，与 production bit-vector 不共享 profile、carry 或 block 边界。
  // tiny fixture 仍逐个比较 Unicode point，避免 JS UTF-16 下标替 oracle 引入另一套距离定义。
  const row = Array.from({ length: right.length + 1 }, (_, index) => index)
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex++) {
    let diagonal = row[0]
    row[0] = leftIndex
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex++) {
      const above = row[rightIndex]
      row[rightIndex] = Math.min(
        above + 1,
        row[rightIndex - 1] + 1,
        diagonal + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      )
      diagonal = above
    }
  }
  return row[right.length]
}

function scalarClosest(content: string, expected: string) {
  const text = Array.from(content)
  const pattern = Array.from(expected)
  let distance = Number.POSITIVE_INFINITY
  let spans: { start: number; end: number }[] = []
  // 穷举只接受非空 half-open span，直接对应 diagnostic 必须展示实际文件证据的契约。
  // 该 oracle 不假定候选等长，因此能独立覆盖 insertion/deletion 产生的变长最优窗口。
  for (let start = 0; start < text.length; start++) {
    for (let end = start + 1; end <= text.length; end++) {
      const current = scalarDistance(pattern, text.slice(start, end))
      if (current > distance) continue
      if (current < distance) {
        distance = current
        spans = []
      }
      spans.push({ start, end })
    }
  }
  // 全部 span 的最小值确定后才判断 tie，避免枚举顺序替某个 endpoint 或长度背书。
  if (spans.length !== 1) return undefined
  const span = spans[0]
  const score = 1 - distance / Math.max(pattern.length, span.end - span.start)
  // score gate 与 production 使用同一公开契约常量，但距离和唯一性均来自独立标量证据。
  return score >= 0.5 ? { line: 1, score } : undefined
}

test("closestWindow agrees with an exhaustive scalar span oracle", () => {
  // 二元字母表穷举所有 1..5 长输入，包含 unique、same-end tie、multi-end tie 和低分结果。
  // expected value 完全由 pairwise Levenshtein 生成，不读取 private helper 或 production 中间状态。
  for (let contentLength = 1; contentLength <= 5; contentLength++) {
    for (let contentBits = 0; contentBits < 2 ** contentLength; contentBits++) {
      const content = Array.from({ length: contentLength }, (_, index) => ((contentBits >>> index) & 1 ? "a" : "b")).join("")
      for (let expectedLength = 1; expectedLength <= 5; expectedLength++) {
        for (let expectedBits = 0; expectedBits < 2 ** expectedLength; expectedBits++) {
          const expected = Array.from({ length: expectedLength }, (_, index) =>
            (expectedBits >>> index) & 1 ? "a" : "b",
          ).join("")
          const oracle = scalarClosest(content, expected)
          const actual = closestWindow(content, expected)
          // 仅比较公开的 candidate existence、line 与 score；excerpt 格式由真实 Edit seam 单独验证。
          expect(actual && { line: actual.line, score: actual.score }).toEqual(oracle)
        }
      }
    }
  }
})

describe("tool.edit", () => {
  test("trimDiff preserves source indentation", () => {
    const diff = "@@ -1 +1 @@\n-        return 1\n+        return 2"

    // diff 是模型重构文件状态的字节证据；公共缩进不可为展示紧凑而被删除。
    expect(trimDiff(diff)).toBe(diff)
  })

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

    it.instance("preserves existing CRLF when oldString is empty", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "existing-crlf.txt")
        yield* put(filepath, "old\r\ncontent\r\n")

        yield* run({ filePath: filepath, oldString: "", newString: "new\ncontent\n" })

        // oldString="" 兼有 create/overwrite 语义；proposal 已存在时仍须尊重磁盘 CRLF 属性。
        expect(yield* loadRaw(filepath)).toBe("new\r\ncontent\r\n")
      }),
    )

    itLineEndingFormatted.instance("restores existing CRLF after formatting a create-overwrite", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "formatted-create-overwrite.txt")
        yield* put(filepath, "old\r\ncontent\r\n")

        yield* run({ filePath: filepath, oldString: "", newString: "new\ncontent\n" })

        // create 与 overwrite 共用参数形态但不是同一磁盘属性域；existing proposal 必须在 formatter 后还原。
        expect(yield* loadRaw(filepath)).toBe("formatted\r\ncontent\r\n")
      }),
    )

    it.instance("keeps submitted LF when creating a missing file", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "new-lf.txt")

        yield* run({ filePath: filepath, oldString: "", newString: "new\ncontent\n" })

        // 缺失文件没有可继承的物理属性；该断言防止 overwrite 修复侵入纯 create 语义。
        expect(yield* loadRaw(filepath)).toBe("new\ncontent\n")
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
        // oldString 必须真实存在于文件中：命中后跳写，由批级内容等值门报 identical。
        yield* put(filepath, "same")

        expect((yield* fail({ filePath: filepath, oldString: "same", newString: "same" })).message).toContain(
          "identical",
        )
      }),
    )

    // [local-smark] 混入 identical 条目的多 edit batch 必须成功：只报 warning，不整批失败。
    it.instance("succeeds with warning when one of multiple edits is identical", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "file.txt")
        yield* put(filepath, "a\nb\nc")

        const result = yield* run({
          filePath: filepath,
          edits: [
            { oldString: "a", newString: "x" },
            { oldString: "b", newString: "y" },
            { oldString: "c", newString: "c" },
          ],
        })

        expect(result.output).toContain("Edit applied successfully")
        expect(result.output).toContain("Warning: 1 of 3 edit(s) were no-ops")
        expect(yield* load(filepath)).toBe("x\ny\nc")
      }),
    )

    // [local-smark] 归一化漂移角：identical 条目仅能经 Unicode 折叠命中时也必须零写入。
    // 该 slice 在改动前也通过（逐条预检同样报 identical）；它锁定的是防止 R1 式实现
    // （apply identical → preserve 重写擦洗 en-dash → 成功 + 虚假 warning）滚动回来。
    it.instance("identical single edit matching only via normalization fails without writes", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "file.txt")
        yield* put(filepath, "x\nfoo \u2013 bar\n")

        const error = yield* fail({ filePath: filepath, oldString: "foo - bar", newString: "foo - bar" })

        expect(error.message).toContain("identical")
        expect(yield* loadRaw(filepath)).toBe("x\nfoo \u2013 bar\n")
      }),
    )

    // [local-smark] 混合 batch：真实变化正常应用，归一化命中的 identical 条目所在行字节保持原样。
    it.instance("mixed batch keeps drift line bytes untouched", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "file.txt")
        yield* put(filepath, "x\nfoo \u2013 bar\n")

        const result = yield* run({
          filePath: filepath,
          edits: [
            { oldString: "x", newString: "y" },
            { oldString: "foo - bar", newString: "foo - bar" },
          ],
        })

        expect(result.output).toContain("Warning: 1 of 2 edit(s) were no-ops")
        expect(yield* loadRaw(filepath)).toBe("y\nfoo \u2013 bar\n")
      }),
    )

    // [local-smark] B-01：被跳写 identical 条目的持久化历史必须保持提交形态；
    // 否则 resolveCompletedToolInput 覆写 state.input 后，模型看到的输入与
    // output 的 "oldString equals newString" warning 自相矛盾。
    it.instance("keeps identical form in synced input for skipped identical edits", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "file.txt")
        yield* put(filepath, "x\nfoo \u2013 bar\n")

        const result = yield* run({
          filePath: filepath,
          edits: [
            { oldString: "x", newString: "y" },
            { oldString: "foo - bar", newString: "foo - bar" },
          ],
        })

        expect(result.metadata._syncInput).toEqual({
          filePath: filepath,
          edits: [
            { oldString: "x", newString: "y" },
            { oldString: "foo - bar", newString: "foo - bar" },
          ],
        })
        // located slice 是 en-dash 但该条目跳写且 history 不覆写；不能误报为 normalized truth rewrite。
        expect(result.metadata.inputProvenance).toBeUndefined()
        expect(result.output).not.toContain("normalized oldString truth rewrites")
        // processor 消费面：公开回写契约直接验证，不重复 edit.ts 内部拼装逻辑。
        const resolved = resolveCompletedToolInput(
          { filePath: filepath, edits: [] as unknown[] },
          { _syncInput: result.metadata._syncInput },
        )
        expect(resolved.edits).toEqual([
          { oldString: "x", newString: "y" },
          { oldString: "foo - bar", newString: "foo - bar" },
        ])
      }),
    )

    // [local-smark] R-01：成功 output 用最终 diff 形态逐条说明实际变化（-/+ 行），
    // identical 条目无字节变化故不出现；模型可见通道只有 output。
    it.instance("output lists actual changes as final diff lines", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "file.txt")
        yield* put(filepath, "a\nb\nc")

        const result = yield* run({
          filePath: filepath,
          edits: [
            { oldString: "a", newString: "x" },
            { oldString: "b", newString: "y" },
            { oldString: "c", newString: "c" },
          ],
        })

        const lines = result.output.split(/\r?\n/)
        expect(lines).toContain("Changed:")
        expect(lines).toContain("-a")
        expect(lines).toContain("+x")
        expect(lines).toContain("-b")
        expect(lines).toContain("+y")
        expect(lines).not.toContain("-c")
        expect(lines).not.toContain("+c")
        expect(result.output).toContain("Warning: 1 of 3 edit(s) were no-ops")
      }),
    )

    // [local-smark] 归一化命中的真实编辑在 diff 行里展示文件实际 old 文本
    // （归一化差异是模型重构文件状态时最缺的信息）。
    it.instance("output lists actual matched text for normalized edits", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "file.txt")
        yield* put(filepath, "x\nfoo \u2013 bar\n")

        const result = yield* run({
          filePath: filepath,
          edits: [{ oldString: "foo - bar", newString: "foo - bat" }],
        })

        expect(result.output).toContain("-foo \u2013 bar")
        expect(result.output).toContain("+foo - bat")
      }),
    )

    // [local-smark] create/overwrite 也必须说明变化（R-01 无 create 例外），
    // 且权限请求的 metadata.diff 预计算保持非空（审批预览不回归）。
    it.instance("create output lists changes and keeps permission diff", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "new.txt")
        const asked: Array<{ metadata?: Record<string, unknown> }> = []
        const captureCtx: Tool.Context = {
          ...ctx,
          ask: (request) => {
            asked.push(request)
            return Effect.void
          },
        }

        const result = yield* run({ filePath: filepath, oldString: "", newString: "line1\nline2\n" }, captureCtx)

        expect(result.output).toContain("Changed:")
        expect(result.output).toContain("+line1")
        expect(asked[0]?.metadata?.diff).toContain("+line1")
      }),
    )

    // [local-smark] formatter 后真值：Changed 段必须反映最终磁盘内容（mock 追加尾换行）。
    itFormatted.instance("output reflects post-formatter content for non-create edits", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "fmt.txt")
        yield* put(filepath, "a\nb")

        const result = yield* run({ filePath: filepath, oldString: "a", newString: "d" })

        expect(result.output).toContain("-a")
        expect(result.output).toContain("+d")
        expect(yield* loadRaw(filepath)).toBe("d\nb\n")
      }),
    )

    // [local-smark] 预算保护：超长 diff 时 output 仍 ≤ limits 且末尾 warning 存在
    // （真实 wrapper 对同一 limits 做 head 截断会丢尾部 warning，edit 必须自限）。
    itTruncated.instance("keeps trailing warning within output size limit", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "big.txt")
        const long = "x".repeat(2000)
        yield* put(filepath, `${long}\nb\nc`)

        const result = yield* run({
          filePath: filepath,
          edits: [
            { oldString: long, newString: `${long}y` },
            { oldString: "c", newString: "c" },
          ],
        })

        expect(result.output).toContain("Warning: 1 of 2 edit(s) were no-ops")
        expect(Buffer.byteLength(result.output, "utf-8")).toBeLessThanOrEqual(1024)
      }),
    )

    itTruncated.instance("bounds many rewrite fingerprints while preserving full provenance metadata", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "many-rewrites.txt")
        const rewrites = Array.from({ length: 14 }, (_, index) => ({
          oldString: `"v${index}"`,
          newString: `"n${index}"`,
        }))
        yield* put(filepath, `${rewrites.map((_, index) => `say “v${index}”`).join("\n")}\nstable\n`)

        const result = yield* run({
          filePath: filepath,
          edits: [...rewrites, { oldString: "stable", newString: "stable" }],
        })

        // DB metadata 是完整取证面；模型 output 只在既有 tail budget 内放完整 fingerprint 与省略数。
        expect(result.metadata.inputProvenance?.rewrites).toHaveLength(14)
        expect(result.output).toContain("Warning: 1 of 15 edit(s) were no-ops")
        expect(result.output).toContain("Warning: normalized oldString truth rewrites were recorded:")
        expect(result.output).toMatch(/- edits\[0\]: original=4 UTF-8 bytes sha256=[0-9a-f]{64}/)
        expect(result.output).toMatch(/- \.\.\. \d+ more rewrite fingerprint\(s\) stored in metadata\.inputProvenance/)
        expect(Buffer.byteLength(result.output, "utf-8")).toBeLessThanOrEqual(1024)
        expect(result.output.split("\n").length).toBeLessThanOrEqual(20)
      }),
    )

    // [local-smark] identical 条目仍须通过 locate 校验：垃圾 oldString 不得因"无操作"而静默通过。
    it.instance("still validates oldString of identical edits", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "file.txt")
        yield* put(filepath, "a\nb\nc")

        const error = yield* fail({
          filePath: filepath,
          edits: [
            { oldString: "a", newString: "x" },
            { oldString: "not in file", newString: "not in file" },
          ],
        })

        expect(error).toBeInstanceOf(Error)
        expect(error.message).toContain("Could not find edits[1]")
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
        // 文件内容含 "actual content"，模型搜索 "actual contxnt"（单字符拼写错误）
        yield* put(filepath, "line1\nactual content here\nline3")

        const error = yield* fail({
          filePath: filepath,
          oldString: "actual contxnt",
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
        const candidate = "prefix target sequence alpha beta gamxa suffix"
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
    it.instance("closest match prioritizes ordered edit distance over context length", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "ordered-distance.txt")
        const candidate = "prefix target sequence alpha beta gamxa suffix"
        yield* put(filepath, `target sequence alpha beta deltta\n${candidate}\n`)

        const error = yield* fail({
          filePath: filepath,
          oldString: "target sequence alpha beta gamma",
          newString: "replacement",
        })

        expect(error.message).toContain("Closest match at line 2")
        expect(error.message).toContain(candidate)
        expect(error.message).not.toContain("target sequence alpha beta deltta")
      }),
    )

    it.instance("closest match preserves raw offsets across CRLF and astral text", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "raw-offsets.txt")
        // astral 字符占两个 UTF-16 单元，CRLF 又会在比较空间折叠成一个 point。
        // 用户最终看到的行号和 actual 片段仍必须来自原始边界，而不是 code-point index。
        yield* put(filepath, "😀 prefix\r\nactual content\r\n")

        const error = yield* fail({
          filePath: filepath,
          oldString: "actual contxnt",
          newString: "replacement",
        })

        expect(error.message).toContain("Closest match at line 2")
        expect(error.message).toContain('line 2 actual: "actual content"')
      }),
    )

    it.instance("closest match renders the DP span when a line is inserted", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "variable-span.txt")
        // DP 返回的候选跨过一个空行，renderer 只能展示同一 raw span，不能重选等长行窗口。
        // 这个断言保护变长候选的证据完整性，并让模型看到实际插入的空行。
        yield* put(filepath, "alpha\n\nbeta\n")

        const error = yield* fail({
          filePath: filepath,
          oldString: "alpha\nbeta",
          newString: "replacement",
        })

        expect(error.message).toContain("Closest match at line 1")
        expect(error.message).toContain("alpha\n\nbeta")
      }),
    )

    it.instance("keeps a long variable candidate span visible", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "long-variable-span.txt")
        const prefix = "p".repeat(400)
        const suffix = "s".repeat(400)
        // 完整行上下文会把 DP 选中的中间 span 推入 omission marker，测试必须锁定 span 本身仍可见。
        // 预期值是手写的 raw candidate，不从 matcher 反向生成，避免测试与实现共享错误。
        // 这条断言只验证诊断证据保留，不允许相似文本进入成功替换路径。
        yield* put(filepath, `${prefix}alpha\n\nbeta${suffix}\n`)

        const error = yield* fail({
          filePath: filepath,
          oldString: "alpha\nbeta",
          newString: "replacement",
        })

        expect(error.message).toContain("alpha\n\nbeta")
      }),
    )

    // renderer 只允许有限 diff 输入；超限时必须回到既有 no-reliable 文案，不能把大型 actual 作为诊断证据提交。
    // 该行为保护四秒预算，同时不改变 replacement success，因为 closest 只在 applyEdits 失败后运行。
    it.instance("suppresses actual when diagnostic rendering budget is exceeded", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "render-budget.txt")
        const body = Array.from({ length: 2200 }, (_, index) => String.fromCharCode(33 + ((index * 37) % 90))).join("")
        const actual = "actual-only:" + body
        const actualPoints = Array.from(actual)
        const mismatchIndex = 1000
        const requested = actualPoints
          .slice(0, mismatchIndex)
          .concat(actualPoints[mismatchIndex] === "X" ? "Y" : "X", actualPoints.slice(mismatchIndex + 1))
          .join("")
        yield* put(filepath, actual)

        const error = yield* fail({ filePath: filepath, oldString: requested, newString: "replacement" })

        expect(error.message).toContain("No reliable nearby candidate was found")
        expect(error.message).not.toContain(actual)
      }),
    )

    // working-set 预检必须先于 closest 的 expected 归一化分配；超限只复用既有 no-reliable 文案。
    // 真实 Edit seam 同时证明大型 oldString 不会被截短后误报某段 actual。
    it.instance("suppresses actual when diagnostic workspace budget is exceeded", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "workspace-budget.txt")
        yield* put(filepath, "actual content must remain private")

        const error = yield* fail({ filePath: filepath, oldString: "x".repeat(1_000_000), newString: "replacement" })

        expect(error.message).toContain("No reliable nearby candidate was found")
        expect(error.message).not.toContain("actual content")
      }),
    )

    // 31/32/33 等边界覆盖跨 word carry 和最后 partial block；actual 与差异列均由 fixture 独立确定。
    // 每个候选都放在第二行，避免测试通过 private matcher state 观察实现细节。
    it.instance("keeps Myers word boundary candidates exact", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "word-boundary.txt")
        for (const length of [31, 32, 33, 63, 64, 65, 127, 128, 129, 255, 256, 257, 399, 400]) {
          const actual = Array.from({ length }, (_, index) => String.fromCharCode(33 + ((index * 37) % 90))).join("")
          const points = Array.from(actual)
          const mismatchIndex = Math.floor(length / 2)
          const requested = points
            .slice(0, mismatchIndex)
            .concat(points[mismatchIndex] === "X" ? "Y" : "X", points.slice(mismatchIndex + 1))
            .join("")
          yield* put(filepath, `unrelated decoy\n${actual}\n`)

          const error = yield* fail({ filePath: filepath, oldString: requested, newString: "replacement" })

          expect(error.message).toContain("Closest match at line 2")
          expect(error.message).toContain(`difference: requested columns ${mismatchIndex + 1}-${mismatchIndex + 1}`)
        }
      }),
    )

    // lineStarts/lineContentEnds 必须直接定位尾部候选，不能复制并 split 它前面的完整文件。
    // 二万行 fixture 的一基行号是独立常量，覆盖大前缀与 renderer handoff。
    it.instance("reports a candidate after a large file prefix", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "large-prefix.txt")
        yield* put(filepath, "filler\n".repeat(20_000) + "target sequence alpha beta gamxa\n")

        const error = yield* fail({
          filePath: filepath,
          oldString: "target sequence alpha beta gamma",
          newString: "replacement",
        })

        expect(error.message).toContain("Closest match at line 20001")
        expect(error.message).toContain("gamxa")
      }),
    )

    it.instance("closest match accepts the normalized score boundary", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "score-boundary.txt")
        yield* put(filepath, "ab")

        const error = yield* fail({
          filePath: filepath,
          oldString: "abcd",
          newString: "replacement",
        })

        expect(error.message).toContain("Closest match at line 1")
        expect(error.message).toContain('line 1 actual: "ab"')

        yield* put(filepath, "a")
        const below = yield* fail({
          filePath: filepath,
          oldString: "abcd",
          newString: "replacement",
        })
        // 低于阈值时即使存在数学上的最小窗口，也不能把它包装成可行动的定位信息。
        // 该断言锁定一次性 gate，避免未来为了“多匹配到一些”增加退化重试。
        expect(below.message).toContain("No reliable nearby candidate was found")
      }),
    )

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
    // 该行为是一次性 reliability gate，不允许通过第二次匹配降低证据标准。
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
    // 断言只锁定用户可见的“无唯一证据即不展示”契约，不依赖 matcher 的内部遍历顺序。
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

    // 候选可以从更长窗口的内部起点开始；等距时不能因为 DP 转移顺序丢掉内部候选。
    // 该最小反例专门覆盖 empty predecessor，否则较长窗口会错误覆盖内部子串。
    // 失败信息必须要求重新读取，而不是选择其中一个同距位置制造假精度。
    it.instance("suppresses a tied inner candidate", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "inner-tie.txt")
        yield* put(filepath, "xb")

        const error = yield* fail({
          filePath: filepath,
          oldString: "ab",
          newString: "replacement",
        })

        expect(error.message).toContain("No reliable nearby candidate was found")
      }),
    )

    // `aa` 到同一 end 的 `ba` 与 `a` 都是 distance=1；forward end 唯一仍必须由 reverse length 判 tie。
    it.instance("suppresses a same-end closest tie", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "same-end-tie.txt")
        yield* put(filepath, "ba")

        const error = yield* fail({ filePath: filepath, oldString: "aa", newString: "replacement" })

        expect(error.message).toContain("No reliable nearby candidate was found")
        expect(error.message).not.toContain('actual: "ba"')
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
        const exit = yield* tool
          .execute({ filePath: filepath, edits: [{ oldString: "content", newString: "modified" }] }, ctx)
          .pipe(Effect.exit)
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

    // 歧义诊断的用户可观察合同：候选行号 + 最小唯一扩展建议（INV-03）。
    // 该断言锁死失败文本的信息量，不断言内部枚举实现。
    it.instance("reports candidate lines and minimal unique extension on ambiguity", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "ambiguous.txt")
        yield* put(filepath, "alpha\nshared A\nshared B\nbeta\nshared A\nshared B\ngamma")

        const error = yield* fail({ filePath: filepath, oldString: "shared A\nshared B", newString: "changed" })

        expect(error.message).toContain("Found multiple matches")
        expect(error.message).toContain("lines 2, 5")
        expect(error.message).toContain("1 more line(s) above")
        expect(yield* load(filepath)).toBe("alpha\nshared A\nshared B\nbeta\nshared A\nshared B\ngamma")
      }),
    )

    // 同一行内重复无法通过行扩展去歧：此时只给候选行号，不得给出会再次失败的扩展建议。
    it.instance("degrades to candidate lines when line extension cannot disambiguate", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "sameline.txt")
        yield* put(filepath, "foo bar foo")

        const error = yield* fail({ filePath: filepath, oldString: "foo", newString: "qux" })

        expect(error.message).toContain("Found multiple matches")
        expect(error.message).toContain("line 1")
        expect(error.message).not.toContain("makes the match unique")
      }),
    )

    // INV-04 时效事实：自写晚于自读时，失败错误必须点明时效并指向作用后结果；
    // 文案不得诱导 re-read（用户决策）。控制组证明无陈旧时句子不出现。
    it.instance("notes own-write-after-read staleness on mismatch failure", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "stale.txt")
        yield* put(filepath, "changed by earlier edit")
        const context = ctxWithHistory(filepath, [
          { tool: "read", end: 1 },
          { tool: "edit", end: 3 },
        ])

        const error = yield* failWith({ filePath: filepath, oldString: "missing text", newString: "x" }, context)

        expect(error.message).toContain("modified by your own edit after your last read")
        // 新增事实句自身不得携带 re-read 祈使（INV-02）；既有 closest 回退文案不属于本合同。
        expect(error.message).toContain("Use the result returned by that call")
        expect(error.message).not.toContain("re-read")
      }),
    )

    it.instance("omits staleness note when the last read is newer than the last write", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "fresh.txt")
        yield* put(filepath, "current content")
        const context = ctxWithHistory(filepath, [
          { tool: "edit", end: 3 },
          { tool: "read", end: 5 },
        ])

        const error = yield* failWith({ filePath: filepath, oldString: "missing text", newString: "x" }, context)

        expect(error.message).not.toContain("modified by your own")
      }),
    )

    // INV-05 已读区间：融合同 canonicalPath 的全部可见 read metadata，只陈述事实。
    it.instance("lists previously read line ranges on mismatch failure", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "paged.txt")
        yield* put(filepath, "line\n".repeat(600))
        const context = ctxWithHistory(filepath, [
          { tool: "read", end: 1, readRange: { start: 120, end: 260 } },
          { tool: "read", end: 2, readRange: { start: 250, end: 400 } },
        ])

        const error = yield* failWith({ filePath: filepath, oldString: "missing text", newString: "x" }, context)

        expect(error.message).toContain("120-400")
      }),
    )

    // 已压缩读取的内容不在模型上下文中（可见性协议）：不得计入已读区间与时效判定。
    it.instance("does not count compacted reads as visible history", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "compacted.txt")
        yield* put(filepath, "changed by earlier edit")
        const context = ctxWithHistory(filepath, [
          { tool: "read", end: 1, compacted: true, readRange: { start: 5, end: 40 } },
          { tool: "edit", end: 3 },
        ])

        const error = yield* failWith({ filePath: filepath, oldString: "missing text", newString: "x" }, context)

        expect(error.message).toContain("has not been read since")
        expect(error.message).not.toContain("5-40")
      }),
    )

    // INV-09 同名异路径提醒：存在同 basename 异路径已读文件时提示一次。
    it.instance("notes a same-named read from a different path on mismatch failure", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const original = path.join(test.directory, "original", "x.patch")
        const current = path.join(test.directory, "current", "x.patch")
        yield* put(current, "actual current content")
        const context = ctxWithHistory(current, [
          { tool: "read", file: original, end: 1 },
          { tool: "read", end: 2 },
        ])

        const error = yield* failWith({ filePath: current, oldString: "missing text", newString: "x" }, context)

        expect(error.message).toContain("different file with the same name")
        expect(error.message).toContain(original)
      }),
    )

    // INV-08/C01：Changed 段截断必须是真实 diff 的连续前缀 + 显式省略计数；
    // 旧实现逐行跳塞（continue）会让展示中间出现不可见的洞，却报「只裁尾部」。
    itMidBudget.instance("truncates the Changed diff as a strict prefix with an omission count", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "budget.txt")
        // 夹具刻意在 del 段中部放一条 1300B 长行：旧跳行实现跳过它后继续收后面的
        // 短行（展示中间出洞仍报「只裁尾部」），连续前缀实现必须在长行处一次性截止。
        const before = Array.from({ length: 60 }, (_, i) =>
          i === 20 ? `line ${i} ${"x".repeat(1300)}` : `line ${i} ${"x".repeat(24)}`,
        ).join("\n")
        const after = Array.from({ length: 60 }, (_, i) => `line ${i} ${"y".repeat(12)}`).join("\n")
        yield* put(filepath, before)

        const context = ctxWithHistory(filepath, [{ tool: "read", end: 1 }])
        const result = yield* run(
          { filePath: filepath, edits: [{ oldString: before, newString: after }] },
          context,
        )

        const full = renderFileDiff(filepath, before, after).patch
        const shown = result.output.split("\n\nChanged:\n")[1]?.split("\n… (")[0] ?? ""
        // 前缀性质：展示段必须是完整 diff 的逐字节前缀（旧跳行实现必然违反）。
        expect(full.startsWith(shown)).toBe(true)
        expect(result.output).toMatch(/… \(\d+ more lines omitted/)
        expect(shown.length).toBeGreaterThan(0)
      }),
    )

    // INV-10：工具 description 必须携带三条用户可观察合同——陈旧转写禁令、
    // 门禁不认可 bash 输出、歧义条目的 more-than-3-lines 诱导。文案即合同。
    it.instance("description carries staleness, bash-gate, and context-size guidance", () =>
      Effect.gen(function* () {
        const tool = yield* init()
        expect(tool.description).toContain("latest read")
        expect(tool.description).toContain("Bash output")
        expect(tool.description).toContain("more than 3 lines")
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

    itLineEndingFormatted.instance("restores existing CRLF after formatting a normal edit", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filePath = path.join(test.directory, "formatted-update.txt")
        yield* put(filePath, "before\r\ncontent\r\n")

        yield* run({ filePath, oldString: "before", newString: "new" })

        // 普通 edit 的 formatter 写回仍在同一 mutation 中，最终文件必须保留文本变化与 CRLF。
        expect(yield* loadRaw(filePath)).toBe("formatted\r\ncontent\r\n")
      }),
    )

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

  /**
   * multi-edit / 归一化 / 统一主路径行为片：
   * - 单条与多条 edits 必须共用 applyEdits，禁止按条数分叉算法
   * - 期望文件内容用手写字面量，不反向调用 applyEdits 生成
   * - 失败路径必须在写盘前拒绝（文件字节不变）
   */
  describe("multi-edit and normalized match", () => {
    // 一次调用两个不相交区域：证明 batch 快照 + reverse apply 可落地多块
    it.instance("applies two disjoint edits in one call", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "multi.txt")
        yield* put(filepath, "alpha\nbeta\ngamma\n")
        yield* run({
          filePath: filepath,
          edits: [
            { oldString: "alpha", newString: "A" },
            { oldString: "gamma", newString: "G" },
          ],
        })
        expect(yield* load(filepath)).toBe("A\nbeta\nG\n")
      }),
    )

    // INV-01/02：高偏移在前 + 变长替换的乱序提交必须按位置应用。
    // 历史缺陷：exact 分支按提交顺序逆序写回，低偏移变长替换使高偏移记录失效，
    // 产生 "B = " + newString + 残尾 的中线拼接（生产事故同构样本）。
    it.instance("applies out-of-order edits by match position", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "out-of-order.txt")
        yield* put(filepath, "A = 1 \nB = 2\ndef target():\n    pass \nC = 3\n")
        yield* run({
          filePath: filepath,
          edits: [
            { oldString: "def target():\n    pass", newString: "def target():\n    return 1" },
            { oldString: "A = 1", newString: "A = 111" },
          ],
        })
        expect(yield* load(filepath)).toBe("A = 111 \nB = 2\ndef target():\n    return 1 \nC = 3\n")
      }),
    )

    // replaceAll 展开区间与其他 edit 交错：首区间看似升序、全局非升序，
    // 必须按展开后区间的全局位置套用，而不是按提交顺序。
    it.instance("applies interleaved replaceAll ranges by global position", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "interleaved-replaceall.txt")
        yield* put(filepath, "old A\nline1\nMID TARGET\nline2\nold B\nend\n")
        yield* run({
          filePath: filepath,
          edits: [
            { oldString: "MID TARGET", newString: "MID REPLACED WITH LONGER TEXT" },
            { oldString: "old", newString: "OLDISH", replaceAll: true },
          ],
        })
        expect(yield* load(filepath)).toBe(
          "OLDISH A\nline1\nMID REPLACED WITH LONGER TEXT\nline2\nOLDISH B\nend\n",
        )
      }),
    )

    // 用户不变量：同一组互不重叠 edits，A→B→C 与 C→B→A 两种提交顺序的结果必须逐字节一致。
    it.instance("submission order does not change multi-edit result", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const forward = path.join(test.directory, "order-forward.txt")
        const backward = path.join(test.directory, "order-backward.txt")
        const content = "one\ntwo HEAD\nthree\nmid TARGET\nfour\nfive HEAD\nsix\n"
        yield* put(forward, content)
        yield* put(backward, content)
        yield* run({
          filePath: forward,
          edits: [
            { oldString: "two HEAD", newString: "two REPLACED LONGER" },
            { oldString: "mid TARGET", newString: "mid R" },
            { oldString: "five HEAD", newString: "five REPLACED MUCH LONGER" },
          ],
        })
        yield* run({
          filePath: backward,
          edits: [
            { oldString: "five HEAD", newString: "five REPLACED MUCH LONGER" },
            { oldString: "mid TARGET", newString: "mid R" },
            { oldString: "two HEAD", newString: "two REPLACED LONGER" },
          ],
        })
        expect(yield* load(backward)).toBe(yield* load(forward))
        expect(yield* load(forward)).toBe(
          "one\ntwo REPLACED LONGER\nthree\nmid R\nfour\nfive REPLACED MUCH LONGER\nsix\n",
        )
      }),
    )

    // INV-05 锁定（现状正确，防回退）：字面缩进语义与未触碰前缀字节保真。
    // (a) 中线锚点：未变的深缩进段必须原样保留；(b) oldString 带缩进、newString 无缩进 → 该缩进按字面移除；
    // (c) 归一化匹配（ASCII 引号 vs 磁盘弯引号）下缩进严格按 newString 字面变化。
    it.instance("preserves indentation semantics for exact and normalized matches", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const midline = path.join(test.directory, "indent-midline.txt")
        yield* put(midline, "        head tail\n")
        yield* run({ filePath: midline, edits: [{ oldString: "tail", newString: "TAIL" }] })
        expect(yield* load(midline)).toBe("        head TAIL\n")

        const dedent = path.join(test.directory, "indent-dedent.txt")
        yield* put(dedent, "    def f():\n        pass\n")
        yield* run({ filePath: dedent, edits: [{ oldString: "    def f():", newString: "def f():" }] })
        expect(yield* load(dedent)).toBe("def f():\n        pass\n")

        const normalized = path.join(test.directory, "indent-normalized.txt")
        yield* put(normalized, "        say “x”\n")
        yield* run({
          filePath: normalized,
          edits: [{ oldString: '        say "x"', newString: '            say "x"' }],
        })
        expect(yield* load(normalized)).toBe('            say "x"\n')
      }),
    )

    // 若顺序应用会得到 baz；快照匹配必须拒绝第二条（bar 不在原文）。
    it.instance("rejects sequential-dependent edits against original snapshot", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "snap.txt")
        yield* put(filepath, "foo")
        const error = yield* fail({
          filePath: filepath,
          edits: [
            { oldString: "foo", newString: "bar" },
            { oldString: "bar", newString: "baz" },
          ],
        })
        expect(error.message).toMatch(/Could not find|bar/)
        expect(yield* load(filepath)).toBe("foo")
      }),
    )

    // 前一条 normalized edit 可以成功定位，但失败报告必须只携带真正缺失条目的 actual 证据。
    // 该断言同时保护 editIndex 传播和错误正文去重，防止 wrapper 回退到第一条 oldString。
    it.instance("diagnoses only the missing normalized edit", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "missing-normalized-edit.txt")
        yield* put(filepath, "say “hello”\nworld\n")

        const error = yield* fail({
          filePath: filepath,
          edits: [
            { oldString: '"hello"', newString: '"hi"' },
            { oldString: "worxd", newString: "mars" },
          ],
        })

        expect(error.message).toContain("Closest match at line 2")
        expect(error.message).toContain("world")
        expect(error.message).not.toContain("say “hello”")
      }),
    )

    // sole domain：ASCII 连字符与 en-dash 在归一化后合并计数，无 replaceAll 必须歧义失败
    it.instance("rejects hybrid hyphen uniqueness without replaceAll", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "hybrid.txt")
        yield* put(filepath, "x-y and x\u2013y")
        const error = yield* fail({
          filePath: filepath,
          edits: [{ oldString: "x-y", newString: "z" }],
        })
        expect(error.message).toContain("multiple")
        expect(yield* load(filepath)).toBe("x-y and x\u2013y")
      }),
    )

    // INV-16：归一化成功后 _syncInput.oldString 必须是原文弯引号 needle，不是模型 ASCII
    it.instance("normalized smart-quote match rewrites syncInput oldString", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "quote.txt")
        yield* put(filepath, "say \u201Chello\u201D end")
        const result = yield* run({
          filePath: filepath,
          edits: [{ oldString: '"hello"', newString: '"hi"' }],
        })
        expect(yield* load(filepath)).toBe('say "hi" end')
        const metadata = result.metadata as {
          _syncInput?: { edits: Array<{ oldString: string }> }
          inputProvenance?: { rewrites: Array<{ editIndex: number; original: { byteLength: number; sha256: string } }> }
        }
        expect(metadata._syncInput?.edits[0]?.oldString).toBe("\u201Chello\u201D")
        // fingerprint 取模型提交的 ASCII oldString UTF-8 字节，不取命中的弯引号磁盘切片。
        expect(metadata.inputProvenance).toEqual({
          rewrites: [
            {
              editIndex: 0,
              original: {
                byteLength: 7,
                sha256: "5aa762ae383fbb727af3c7a36d4940a5b8c40a989452d2304fc958ff3f354e7a",
              },
            },
          ],
        })
        expect(result.output).toContain("Warning: normalized oldString truth rewrites were recorded:")
        expect(result.output).toContain(
          "- edits[0]: original=7 UTF-8 bytes sha256=5aa762ae383fbb727af3c7a36d4940a5b8c40a989452d2304fc958ff3f354e7a",
        )
      }),
    )

    it.instance("exact match does not emit rewrite provenance", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "exact-provenance.txt")
        yield* put(filepath, "before")

        const result = yield* run({ filePath: filepath, oldString: "before", newString: "after" })

        // fingerprint 只解释 normalized truth rewrite；字面命中没有被覆写的原输入可披露。
        expect(result.metadata.inputProvenance).toBeUndefined()
        expect(result.output).not.toContain("normalized oldString truth rewrites")
      }),
    )

    // 区间重叠在写盘前拒绝，防止部分成功污染文件
    it.instance("overlapping edits reject without write", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "overlap.txt")
        yield* put(filepath, "abcdef")
        const error = yield* fail({
          filePath: filepath,
          edits: [
            { oldString: "abcd", newString: "XXXX" },
            { oldString: "cdef", newString: "YYYY" },
          ],
        })
        expect(error.message).toContain("overlap")
        expect(yield* load(filepath)).toBe("abcdef")
      }),
    )

    // INV-04：归一化触碰行 rewrite 时，未触碰行的行尾空白必须保留
    it.instance("preserves trailing spaces on untouched lines under normalized match", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "preserve.txt")
        // 第一行仅空白漂移无关；第二行含弯引号待替换
        yield* put(filepath, "pad  \nsay \u201Chello\u201D\n")
        yield* run({
          filePath: filepath,
          edits: [{ oldString: '"hello"', newString: '"hi"' }],
        })
        expect(yield* load(filepath)).toBe('pad  \nsay "hi"\n')
      }),
    )

    // R9 slice 13：触碰行行尾空白 — preserve 落盘会 strip，continuous actualOld 替换不会；
    // 必须同时锁定磁盘字节与 _syncInput mid-line needle，防止把 continuous 当 apply oracle。
    it.instance("normalized mid-line match: preserve disk drops touched trailing spaces; sync old is continuous needle", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "joint-preserve.txt")
        // 同一行：弯引号 needle + 行尾两空格
        yield* put(filepath, "code(\u201Chello\u201D);  \n")
        const result = yield* run({
          filePath: filepath,
          edits: [{ oldString: '"hello"', newString: '"hi"' }],
        })
        // preserve：触碰整行从归一化基重写 → 行尾空白消失
        expect(yield* load(filepath)).toBe('code("hi");\n')
        // 若误用 continuous replace(actualOld) 作 apply，会得到 'code("hi");  \n'（保留行尾空格）
        expect(yield* load(filepath)).not.toBe('code("hi");  \n')
        const sync = (result.metadata as { _syncInput?: { edits: Array<{ oldString: string }> } })._syncInput
        // 历史 needle 仍是 mid-line 弯引号片段，不是整行
        expect(sync?.edits[0]?.oldString).toBe("\u201Chello\u201D")
        expect(sync?.edits[0]?.oldString).not.toContain("code(")
      }),
    )

    // INV-07：hybrid 连字符在 replaceAll 下应两处都替换（elevation + sole domain 展开）
    it.instance("replaceAll elevates hybrid hyphen siblings", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "hybrid-all.txt")
        yield* put(filepath, "x-y and x\u2013y")
        const result = yield* run({
          filePath: filepath,
          edits: [{ oldString: "x-y", newString: "z", replaceAll: true }],
        })
        expect(yield* load(filepath)).toBe("z and z")
        // 两个实际 slice 异构时 sync oldString 只能回退模型形态，但 mismatch 事实不得随之丢失。
        expect(result.metadata.inputProvenance).toEqual({
          rewrites: [
            {
              editIndex: 0,
              original: {
                byteLength: 3,
                sha256: "cc96fed8b030120e59a6a0372a92de2d6abebf40d83d57012d449419c6799b7f",
              },
            },
          ],
        })
      }),
    )

    // INV-14：空白-only oldString 归一化后为空 needle，必须拒绝且不写盘
    it.instance("rejects whitespace-only oldString after normalization", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "empty-norm.txt")
        yield* put(filepath, "keep me")
        const error = yield* fail({
          filePath: filepath,
          edits: [{ oldString: "   ", newString: "x" }],
        })
        expect(error.message).toMatch(/empty after normalization|empty/)
        expect(yield* load(filepath)).toBe("keep me")
      }),
    )

    it.instance("rejects tab-only oldString after normalization", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "tab-norm.txt")
        yield* put(filepath, "keep me")
        const error = yield* fail({
          filePath: filepath,
          edits: [{ oldString: "\t", newString: "x" }],
        })
        expect(error.message).toMatch(/empty after normalization|empty/)
        expect(yield* load(filepath)).toBe("keep me")
      }),
    )

    // INV-16 create+format：format 改写落盘后 _syncInput.newString 必须是最终磁盘内容
    itFormatted.instance("create+format sets _syncInput newString to final disk text", () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const filepath = path.join(test.directory, "created.txt")
        const result = yield* run({
          filePath: filepath,
          edits: [{ oldString: "", newString: "hello" }],
        })
        expect(yield* load(filepath)).toBe("hello\n")
        const sync = (result.metadata as { _syncInput?: { edits: Array<{ newString: string }> } })._syncInput
        expect(sync?.edits[0]?.newString).toBe("hello\n")
      }),
    )
  })
})

// INV-16 processor 参数面替换：legacy 入参 + _syncInput → 仅 { filePath, edits }
// INV-07 non-abort fail 保留 task sessionId
import { failedToolMetadata, resolveCompletedToolInput, stripToolTruthMetadata } from "../../src/session/processor"

describe("tool input truth sync (processor contract)", () => {
  test("legacy top-level fields dropped when _syncInput present", () => {
    const prev = {
      filePath: "/a.ts",
      oldString: '"hello"',
      newString: '"hi"',
      replaceAll: false,
    }
    const next = resolveCompletedToolInput(prev, {
      _syncInput: {
        filePath: "/a.ts",
        edits: [{ oldString: "\u201Chello\u201D", newString: '"hi"' }],
      },
    })
    expect(next).toEqual({
      filePath: "/a.ts",
      edits: [{ oldString: "\u201Chello\u201D", newString: '"hi"' }],
    })
    expect("oldString" in next).toBe(false)
    expect("newString" in next).toBe(false)
  })

  test("write _formattedContent still only rewrites content", () => {
    const prev = { filePath: "/b.ts", content: "x" }
    const next = resolveCompletedToolInput(prev, { _formattedContent: "x\n" })
    expect(next).toEqual({ filePath: "/b.ts", content: "x\n" })
  })

  test("strip removes temporary truth keys", () => {
    const inputProvenance = {
      rewrites: [{ editIndex: 0, original: { byteLength: 7, sha256: "a".repeat(64) } }],
    }
    const stripped = stripToolTruthMetadata({
      diff: "d",
      _syncInput: { edits: [] },
      _formattedContent: "x",
      inputProvenance,
    })
    // underscore keys 是短生命周期 truth transport；公开 provenance 是 completed Message 的取证记录。
    expect(stripped).toEqual({ diff: "d", inputProvenance })
  })

  // INV-07：failToolCall non-abort 终态化的 metadata 合同。
  // create 后已写入的 sessionId/parentSessionId 必须保留，否则投影层无 resume 源；
  // title/model 等 running 进度字段必须丢弃，避免 error 态泄漏无关状态。
  test("failedToolMetadata keeps sessionId and drops progress-only fields", () => {
    const id = "ses_0123456789abcdef01234567"
    expect(
      failedToolMetadata({
        sessionId: id,
        parentSessionId: "ses_parentparentparentparentpa",
        title: "Audit runtime",
        model: { modelID: "x" },
        autoReview: { status: "pending" },
      }),
    ).toEqual({
      sessionId: id,
      parentSessionId: "ses_parentparentparentparentpa",
      autoReview: { status: "pending" },
    })
    expect(failedToolMetadata({ title: "only" })).toBeUndefined()
    expect(failedToolMetadata(undefined)).toBeUndefined()
  })
})
