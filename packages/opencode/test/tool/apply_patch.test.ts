import { describe, expect } from "bun:test"
import path from "path"
import * as fs from "fs/promises"
import { Cause, Effect, Exit, Layer } from "effect"
import { ApplyPatchTool } from "../../src/tool/apply_patch"
import { WriteTool } from "../../src/tool/write"
import { EditTool } from "../../src/tool/edit"
import { SummaryCache } from "@/session/summary-cache"
import { LSP } from "@/lsp/lsp"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Format } from "../../src/format"
import { Agent } from "../../src/agent/agent"
import { Bus } from "../../src/bus"
import { Truncate } from "@/tool/truncate"
import { TestInstance } from "../fixture/fixture"
import { SessionID, MessageID } from "../../src/session/schema"
import { testEffect } from "../lib/effect"

const it = testEffect(
  Layer.mergeAll(
    LSP.defaultLayer,
    AppFileSystem.defaultLayer,
    Format.defaultLayer,
    Bus.layer,
    Truncate.defaultLayer,
    Agent.defaultLayer,
  ),
)

// 该 formatter 既改内容又强制 LF；三个写盘分支必须在各自实际 target 上恢复 source/proposal EOL。
const lineEndingFormatLayer = Layer.succeed(Format.Service, {
  init: () => Effect.void,
  status: () => Effect.succeed([]),
  file: (filepath: string) =>
    Effect.promise(async () => {
      // fixture 必须把 formatter 的默认 LF 行为显式化，否则 add/update/move 的恢复缺口不会变红。
      const content = await fs.readFile(filepath, "utf-8")
      await fs.writeFile(filepath, content.replace("new", "formatted").replace(/\r\n?/g, "\n"))
      return true
    }),
})

const itLineEndingFormatted = testEffect(
  Layer.mergeAll(
    LSP.defaultLayer,
    AppFileSystem.defaultLayer,
    lineEndingFormatLayer,
    Bus.layer,
    Truncate.defaultLayer,
    Agent.defaultLayer,
  ),
)

const baseCtx = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
}

type AskInput = {
  permission: string
  patterns: string[]
  always: string[]
  metadata: {
    diff: string
    filepath: string
    files: Array<{
      filePath: string
      relativePath: string
      type: "add" | "update" | "delete" | "move"
      patch: string
      additions: number
      deletions: number
      movePath?: string
    }>
  }
}

type ToolCtx = typeof baseCtx & {
  ask: (input: AskInput) => Effect.Effect<void>
}

const execute = Effect.fn("ApplyPatchToolTest.execute")(function* (params: { patchText: string }, ctx: ToolCtx) {
  const info = yield* ApplyPatchTool
  const tool = yield* info.init()
  return yield* tool.execute(params, ctx)
})

const makeCtx = () => {
  const calls: AskInput[] = []
  const ctx: ToolCtx = {
    ...baseCtx,
    ask: (input) =>
      Effect.sync(() => {
        calls.push(input)
      }),
  }

  return { ctx, calls }
}

const readText = (filepath: string) => Effect.promise(() => fs.readFile(filepath, "utf-8"))
const writeText = (filepath: string, content: string) => Effect.promise(() => fs.writeFile(filepath, content, "utf-8"))
const makeDir = (dir: string) => Effect.promise(() => fs.mkdir(dir, { recursive: true }))

const expectFailure = <A, E, R>(effect: Effect.Effect<A, E, R>, message?: string) =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(effect)
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit) && message) expect(Cause.pretty(exit.cause)).toContain(message)
  })

const expectReadFailure = (filepath: string) => expectFailure(readText(filepath))

describe("tool.apply_patch freeform", () => {
  it.live("requires patchText", () =>
    Effect.gen(function* () {
      const { ctx } = makeCtx()
      yield* expectFailure(execute({ patchText: "" }, ctx), "patchText is required")
    }),
  )

  it.live("rejects invalid patch format", () =>
    Effect.gen(function* () {
      const { ctx } = makeCtx()
      yield* expectFailure(execute({ patchText: "invalid patch" }, ctx), "apply_patch verification failed")
    }),
  )

  it.live("rejects empty patch", () =>
    Effect.gen(function* () {
      const { ctx } = makeCtx()
      yield* expectFailure(execute({ patchText: "*** Begin Patch\n*** End Patch" }, ctx), "patch rejected: empty patch")
    }),
  )

  it.instance(
    "applies add/update/delete in one patch",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const { ctx, calls } = makeCtx()
        const modifyPath = path.join(test.directory, "modify.txt")
        const deletePath = path.join(test.directory, "delete.txt")
        yield* writeText(modifyPath, "line1\nline2\n")
        yield* writeText(deletePath, "obsolete\n")

        const patchText =
          "*** Begin Patch\n*** Add File: nested/new.txt\n+created\n*** Delete File: delete.txt\n*** Update File: modify.txt\n@@\n-line2\n+changed\n*** End Patch"

        const result = yield* execute({ patchText }, ctx)

        expect(result.title).toContain("Success. Updated the following files")
        expect(result.output).toContain("Success. Updated the following files")
        // Strict formatting assertions for slashes
        expect(result.output).toMatch(/A nested\/new\.txt/)
        expect(result.output).toMatch(/D delete\.txt/)
        expect(result.output).toMatch(/M modify\.txt/)
        if (process.platform === "win32") {
          expect(result.output).not.toContain("\\")
        }
        expect(result.metadata.diff).toContain("Index:")
        expect(calls.length).toBe(1)

        // Verify permission metadata includes files array for UI rendering
        const permissionCall = calls[0]
        expect(permissionCall.metadata.files).toHaveLength(3)
        expect(permissionCall.metadata.files.map((f) => f.type).sort()).toEqual(["add", "delete", "update"])

        const addFile = permissionCall.metadata.files.find((f) => f.type === "add")
        expect(addFile?.relativePath).toBe("nested/new.txt")
        expect(addFile?.patch).toContain("+created")

        const updateFile = permissionCall.metadata.files.find((f) => f.type === "update")
        expect(updateFile?.patch).toContain("-line2")
        expect(updateFile?.patch).toContain("+changed")

        expect(yield* readText(path.join(test.directory, "nested", "new.txt"))).toBe("created\n")
        expect(yield* readText(modifyPath)).toBe("line1\nchanged\n")
        yield* expectReadFailure(deletePath)
      }),
    { git: true },
  )

  it.instance(
    "permission metadata includes move file info",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const { ctx, calls } = makeCtx()
        const original = path.join(test.directory, "old", "name.txt")
        yield* makeDir(path.dirname(original))
        yield* writeText(original, "old content\n")

        const patchText =
          "*** Begin Patch\n*** Update File: old/name.txt\n*** Move to: renamed/dir/name.txt\n@@\n-old content\n+new content\n*** End Patch"

        yield* execute({ patchText }, ctx)

        expect(calls.length).toBe(1)
        const permissionCall = calls[0]
        expect(permissionCall.metadata.files).toHaveLength(1)

        const moveFile = permissionCall.metadata.files[0]
        expect(moveFile.type).toBe("move")
        expect(moveFile.relativePath).toBe("renamed/dir/name.txt")
        expect(moveFile.movePath).toBe(path.join(test.directory, "renamed/dir/name.txt"))
        expect(moveFile.patch).toContain("-old content")
        expect(moveFile.patch).toContain("+new content")
      }),
    { git: true },
  )

  it.instance("applies multiple hunks to one file", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { ctx } = makeCtx()
      const target = path.join(test.directory, "multi.txt")
      yield* writeText(target, "line1\nline2\nline3\nline4\n")

      const patchText =
        "*** Begin Patch\n*** Update File: multi.txt\n@@\n-line2\n+changed2\n@@\n-line4\n+changed4\n*** End Patch"

      yield* execute({ patchText }, ctx)

      expect(yield* readText(target)).toBe("line1\nchanged2\nline3\nchanged4\n")
    }),
  )

  // Tool 必须直接消费 owner 的 unique substring success，并在 diff/write 中保留同一行外围文本。
  // 该测试覆盖用户实际调用边界，而不是只证明纯函数能返回正确字符串。
  it.instance("applies a unique substring without deleting surrounding text", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { ctx, calls } = makeCtx()
      const target = path.join(test.directory, "substring.txt")
      yield* writeText(target, "ABCDEFG\n")

      const patchText = "*** Begin Patch\n*** Update File: substring.txt\n@@\n-CDEFG\n+fixed\n*** End Patch"
      yield* execute({ patchText }, ctx)

      expect(yield* readText(target)).toBe("ABfixed\n")
      expect(calls[0].metadata.files[0].patch).toContain("ABfixed")
    }),
  )

  // 两个 eligible literal occurrences 必须在写入前形成 ambiguity，不能由 Tool 选择第一处。
  // ambiguity 指令可以要求补上下文，但不能复制 Tool input 已携带的完整 old block。
  // 文件不变断言证明 owner failure 没被 wrapper 转换为 catch-and-success。
  it.instance("rejects ambiguous substring matches without modifying the file", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { ctx } = makeCtx()
      const target = path.join(test.directory, "ambiguous.txt")
      yield* writeText(target, "target one target\n")

      const patchText = "*** Begin Patch\n*** Update File: ambiguous.txt\n@@\n-target\n+fixed\n*** End Patch"
      const exit = yield* execute({ patchText }, ctx).pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const error = Cause.squash(exit.cause) as Error
        expect(error.message).toContain("Found multiple matches")
        // input/result 合并后仍只能有一份 target；文件中的重复 occurrence 不属于模型上下文计数。
        expect((patchText + error.message).split("target").length - 1).toBe(1)
        expect(error.message).not.toContain("target")
      }

      expect(yield* readText(target)).toBe("target one target\n")
    }),
  )

  // current-text cursor 允许第二个 chunk 在同一存活行继续向右匹配，而不覆盖第一处结果。
  // 这个真实 Tool 输出会在退回 line tuple 或原始 line cursor 时立即变红。
  it.instance("composes multiple substring chunks on one line", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { ctx } = makeCtx()
      const target = path.join(test.directory, "same_line.txt")
      yield* writeText(target, "abcDEFghiJKL")

      const patchText = [
        "*** Begin Patch",
        "*** Update File: same_line.txt",
        "@@",
        "-DEF",
        "+X",
        "@@",
        "-JKL",
        "+Y",
        "*** End Patch",
      ].join("\n")
      yield* execute({ patchText }, ctx)

      expect(yield* readText(target)).toBe("abcXghiY\n")
    }),
  )

  // 空 replacement line 与非空生成文本服从同一 cursor 隔离，不能被下一 chunk 重新消费。
  // Tool 失败且原文件不变证明修复位于 owner，而不是写入后再尝试回滚。
  it.instance("does not rematch an empty line generated by a prior chunk", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { ctx } = makeCtx()
      const target = path.join(test.directory, "empty_generated.txt")
      yield* writeText(target, "alpha\nomega\n")

      const patchText = [
        "*** Begin Patch",
        "*** Update File: empty_generated.txt",
        "@@",
        "-alpha",
        "+",
        "@@",
        "-",
        "+wrong",
        "*** End Patch",
      ].join("\n")
      yield* expectFailure(execute({ patchText }, ctx), "Failed to find expected lines")

      expect(yield* readText(target)).toBe("alpha\nomega\n")
    }),
  )

  // 乱序唯一 chunk 对 original 定位后应按位置统一成功，不再因 forward cursor 失败。
  // 固定完整文件结果证明两处改动一次提交，而不是模型重试后只保留部分修改。
  it.instance("applies unique out-of-order chunks in one update", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { ctx } = makeCtx()
      const target = path.join(test.directory, "cursor_candidate.txt")
      yield* writeText(target, "alpha\nmiddle\nomega\n")
      const patchText = [
        "*** Begin Patch",
        "*** Update File: cursor_candidate.txt",
        "@@",
        "-middle",
        "+MIDDLE",
        "@@",
        "-alpha",
        "+ALPHA",
        "*** End Patch",
      ].join("\n")

      yield* execute({ patchText }, ctx)
      expect(yield* readText(target)).toBe("ALPHA\nMIDDLE\nomega\n")
    }),
  )

  // CRLF 原文同样支持乱序唯一 chunk；写回必须保留原换行风格。
  // 该断言把匹配坐标与持久化行尾分开，防止 reverse apply 偷偷规范化为 LF。
  it.instance("applies unique out-of-order chunks on CRLF files", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { ctx } = makeCtx()
      const target = path.join(test.directory, "crlf_cursor_candidate.txt")
      yield* writeText(target, "alpha\r\nbeta\r\nmiddle\r\nomega\r\n")
      const patchText = [
        "*** Begin Patch",
        "*** Update File: crlf_cursor_candidate.txt",
        "@@",
        "-middle",
        "+MIDDLE",
        "@@",
        "-alpha",
        "-beta",
        "+ALPHA",
        "+BETA",
        "*** End Patch",
      ].join("\n")

      yield* execute({ patchText }, ctx)
      expect(yield* readText(target)).toBe("ALPHA\r\nBETA\r\nMIDDLE\r\nomega\r\n")
    }),
  )

  itLineEndingFormatted.instance("restores source CRLF after formatting an update", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { ctx } = makeCtx()
      const target = path.join(test.directory, "formatted-update.txt")
      yield* writeText(target, "before\r\ncontent\r\n")

      yield* execute(
        { patchText: "*** Begin Patch\n*** Update File: formatted-update.txt\n@@\n-before\n+new\n*** End Patch" },
        ctx,
      )

      // update 的 ending 必须来自 source snapshot；formatter 文本变化不能把它降为 LF。
      // update 没有 move target，因而该测试直接锁定 shared loop 的普通 edited 路径。
      expect(yield* readText(target)).toBe("formatted\r\ncontent\r\n")
    }),
  )

  // 两个 chunk 争用同一 original span 必须原子失败；错误是 overlap，不是 cursor unavailable。
  it.instance("rejects overlapping chunks for the same original span", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { ctx } = makeCtx()
      const target = path.join(test.directory, "consumed_candidate.txt")
      yield* writeText(target, "alpha\nomega\n")
      const patchText = [
        "*** Begin Patch",
        "*** Update File: consumed_candidate.txt",
        "@@",
        "-alpha",
        "+consumed",
        "@@",
        "-alpha",
        "+wrong",
        "*** End Patch",
      ].join("\n")

      const exit = yield* execute({ patchText }, ctx).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const error = Cause.squash(exit.cause) as Error
        expect(error.message).toContain("Overlapping expected lines")
        expect(error.message).not.toContain("unavailable to the current patch step")
      }
      expect(yield* readText(target)).toBe("alpha\nomega\n")
    }),
  )

  // @@ suffix 是唯一字面 context 时只定位其包含行，随后从下一行解析 old block。
  // context 行保持逐字不变，防止定位信息被误用成 replacement target。
  it.instance("uses a unique substring change context", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { ctx } = makeCtx()
      const target = path.join(test.directory, "substring_context.txt")
      yield* writeText(target, "ABCDEFG\nold\n")

      const patchText = "*** Begin Patch\n*** Update File: substring_context.txt\n@@ CDEFG\n-old\n+new\n*** End Patch"
      yield* execute({ patchText }, ctx)

      expect(yield* readText(target)).toBe("ABCDEFG\nnew\n")
    }),
  )

  // pure insertion 只跳过 old block；它的 substring context 仍先通过同一个 locator 校验。
  // 缺失或多义 context 必须失败，但错误不能复制 input 中已有的 `@@ marker` 请求文本。
  // 成功 context 的新行仍统一追加到 transformed EOF，去重只改变失败信息而不改变匹配。
  it.instance("validates change context for pure insertions", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { ctx } = makeCtx()
      const valid = path.join(test.directory, "valid_insert.txt")
      const missing = path.join(test.directory, "missing_insert.txt")
      const ambiguous = path.join(test.directory, "ambiguous_insert.txt")
      yield* writeText(valid, "prefix marker suffix\n")
      yield* writeText(missing, "other\n")
      yield* writeText(ambiguous, "one marker here\ntwo marker there\n")

      yield* execute({
        patchText: "*** Begin Patch\n*** Update File: valid_insert.txt\n@@ marker\n+beta\n*** End Patch",
      }, ctx)
      const failures = [
        "*** Begin Patch\n*** Update File: missing_insert.txt\n@@ marker\n+beta\n*** End Patch",
        "*** Begin Patch\n*** Update File: ambiguous_insert.txt\n@@ marker\n+beta\n*** End Patch",
      ]
      for (const patchText of failures) {
        const exit = yield* execute({ patchText }, ctx).pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          const error = Cause.squash(exit.cause) as Error
          expect(error.message).toContain("Failed to find context")
          // context 在 input/result 两个 model-visible 部分合计恰好一份，适用于零匹配和多匹配。
          expect((patchText + error.message).split("marker").length - 1).toBe(1)
          expect(error.message).not.toContain("marker")
        }
      }

      expect(yield* readText(valid)).toBe("prefix marker suffix\nbeta\n")
      expect(yield* readText(missing)).toBe("other\n")
      expect(yield* readText(ambiguous)).toBe("one marker here\ntwo marker there\n")
    }),
  )

  // parser 中显式的末尾空删除行属于完整 old block，不能在 miss 后被缩短。
  // no-tail 文件没有字面 `foo\n`，因此 Tool 必须失败并保持原始 `foo`。
  it.instance("rejects a shortened trailing-empty old block", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { ctx } = makeCtx()
      const target = path.join(test.directory, "trailing_empty.txt")
      yield* writeText(target, "foo")

      const patchText = "*** Begin Patch\n*** Update File: trailing_empty.txt\n@@\n-foo\n-\n+bar\n*** End Patch"
      yield* expectFailure(execute({ patchText }, ctx), "Failed to find expected lines")

      expect(yield* readText(target)).toBe("foo")
    }),
  )

  // 同一完整 old block 在 terminated 文件中确实存在，Tool 必须沿 unique literal 主路径成功。
  // 与上一个 no-tail case 共用 patch 形状，唯一变量就是 persisted file 的终止 LF。
  it.instance("matches a trailing-empty old block against a terminated file", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { ctx } = makeCtx()
      const target = path.join(test.directory, "terminated_old_block.txt")
      yield* writeText(target, "foo\n")

      const patchText = "*** Begin Patch\n*** Update File: terminated_old_block.txt\n@@\n-foo\n-\n+bar\n*** End Patch"
      yield* execute({ patchText }, ctx)

      expect(yield* readText(target)).toBe("bar\n")
    }),
  )

  // exact-line 删除继续由 line splice 拥有分隔符，删除中间行不能留下空逻辑行。
  // 删除唯一原行后 pure insertion 应直接成为第一行，不得继承原文件的前导 LF。
  it.instance("preserves line deletion and delete-all insertion semantics", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { ctx } = makeCtx()
      const middle = path.join(test.directory, "middle_delete.txt")
      const all = path.join(test.directory, "delete_insert.txt")
      yield* writeText(middle, "a\nb\nc\n")
      yield* writeText(all, "alpha")

      yield* execute({
        patchText: "*** Begin Patch\n*** Update File: middle_delete.txt\n@@\n-b\n*** End Patch",
      }, ctx)
      yield* execute({
        patchText: "*** Begin Patch\n*** Update File: delete_insert.txt\n@@\n-alpha\n@@\n+beta\n*** End Patch",
      }, ctx)

      expect(yield* readText(middle)).toBe("a\nc\n")
      expect(yield* readText(all)).toBe("beta\n")
    }),
  )

  // 可靠候选超过 500 字符时只展示变化点附近的 actual，并分别标明首尾省略字符数。
  // 长公共前后缀不能再次吞掉单字符差异，也不能把完整 expected 复制进 Tool result。
  it.instance("marks omitted text when a reliable candidate is long", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { ctx } = makeCtx()
      const target = path.join(test.directory, "long_candidate.txt")
      const actual = "a".repeat(300) + "X" + "b".repeat(300)
      const expected = "a".repeat(300) + "Y" + "b".repeat(300)
      yield* writeText(target, actual + "\n")

      const patchText = `*** Begin Patch\n*** Update File: long_candidate.txt\n@@\n-${expected}\n+changed\n*** End Patch`
      const exit = yield* execute({ patchText }, ctx).pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const error = Cause.squash(exit.cause) as Error
        expect(error.message).toContain("Closest match at line 1")
        expect(error.message).toContain("line 1 actual")
        expect(error.message).toContain("chars omitted")
        expect(error.message).toContain("difference: requested columns 301-301 differ from actual columns 301-301")
        // 完整长 expected 只能留在原始 patchText；错误正文只提供实际差异窗口。
        expect((patchText + error.message).split(expected).length - 1).toBe(1)
        expect(error.message).not.toContain(expected)
      }
    }),
  )

  it.instance("does not invent a first-line diff for BOM files", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { ctx, calls } = makeCtx()
      const bom = String.fromCharCode(0xfeff)
      const target = path.join(test.directory, "example.cs")
      yield* writeText(target, `${bom}using System;\n\nclass Test {}\n`)

      const patchText =
        "*** Begin Patch\n*** Update File: example.cs\n@@\n class Test {}\n+class Next {}\n*** End Patch"

      yield* execute({ patchText }, ctx)

      expect(calls.length).toBe(1)
      const shown = calls[0].metadata.files[0]?.patch ?? ""
      expect(shown).not.toContain(bom)
      expect(shown).not.toContain("-using System;")
      expect(shown).not.toContain("+using System;")

      const content = yield* readText(target)
      expect(content.charCodeAt(0)).toBe(0xfeff)
      expect(content.slice(1)).toBe("using System;\n\nclass Test {}\nclass Next {}\n")
    }),
  )

  it.instance("inserts lines with insert-only hunk", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { ctx } = makeCtx()
      const target = path.join(test.directory, "insert_only.txt")
      yield* writeText(target, "alpha\nomega\n")

      const patchText = "*** Begin Patch\n*** Update File: insert_only.txt\n@@\n alpha\n+beta\n omega\n*** End Patch"

      yield* execute({ patchText }, ctx)

      expect(yield* readText(target)).toBe("alpha\nbeta\nomega\n")
    }),
  )

  it.instance("appends trailing newline on update", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { ctx } = makeCtx()
      const target = path.join(test.directory, "no_newline.txt")
      yield* writeText(target, "no newline at end")

      const patchText =
        "*** Begin Patch\n*** Update File: no_newline.txt\n@@\n-no newline at end\n+first line\n+second line\n*** End Patch"

      yield* execute({ patchText }, ctx)

      const contents = yield* readText(target)
      expect(contents.endsWith("\n")).toBe(true)
      expect(contents).toBe("first line\nsecond line\n")
    }),
  )

  it.instance("moves file to a new directory", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { ctx } = makeCtx()
      const original = path.join(test.directory, "old", "name.txt")
      yield* makeDir(path.dirname(original))
      yield* writeText(original, "old content\n")

      const patchText =
        "*** Begin Patch\n*** Update File: old/name.txt\n*** Move to: renamed/dir/name.txt\n@@\n-old content\n+new content\n*** End Patch"

      yield* execute({ patchText }, ctx)

      const moved = path.join(test.directory, "renamed", "dir", "name.txt")
      yield* expectReadFailure(original)
      expect(yield* readText(moved)).toBe("new content\n")
    }),
  )

  it.instance("accepts repeated identical move declarations for one source", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { ctx } = makeCtx()
      const original = path.join(test.directory, "old", "name.txt")
      yield* makeDir(path.dirname(original))
      yield* writeText(original, "old content\nsecond line\n")

      const patchText =
        "*** Begin Patch\n*** Update File: old/name.txt\n*** Move to: renamed/name.txt\n@@\n-old content\n+new content\n*** Update File: old/name.txt\n*** Move to: renamed/name.txt\n@@\n-second line\n+third line\n*** End Patch"

      yield* execute({ patchText }, ctx)

      yield* expectReadFailure(original)
      expect(yield* readText(path.join(test.directory, "renamed/name.txt"))).toBe("new content\nthird line\n")
    }),
  )

  // repeated Update File entries 也属于一个 proposal；先写后方 entry 不应阻断前方唯一 old block。
  // Tool seam 覆盖 permission/mutation adapter，补足 owner 单测无法发现的 entry grouping 分叉。
  // 一次 execute 的固定结果证明 permission 后仍只形成一个 FileChange 和一个 mutation commit。
  it.instance("applies repeated update entries out of file order", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { ctx } = makeCtx()
      const target = path.join(test.directory, "repeated-order.txt")
      yield* writeText(target, "alpha\nmiddle\nomega\n")
      const patchText = [
        "*** Begin Patch",
        "*** Update File: repeated-order.txt",
        "@@",
        "-omega",
        "+OMEGA",
        "*** Update File: repeated-order.txt",
        "@@",
        "-alpha",
        "+ALPHA",
        "*** End Patch",
      ].join("\n")

      yield* execute({ patchText }, ctx)
      expect(yield* readText(target)).toBe("ALPHA\nmiddle\nOMEGA\n")
    }),
  )

  // 同文件 repeated entries 属于一个 original proposal；entry2 不能消费 entry1 在本次调用生成的文本。
  // 失败前不写盘，防止 Tool grouping 保留旧 incremental working 成功路径。
  // 错误必须来自 Patch locate owner，Tool 不能捕获后退回旧 entry-by-entry apply。
  it.instance("rejects generated-text dependencies across repeated update entries", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { ctx } = makeCtx()
      const target = path.join(test.directory, "repeated-generated.txt")
      yield* writeText(target, "alpha\nomega\n")
      const patchText = [
        "*** Begin Patch",
        "*** Update File: repeated-generated.txt",
        "@@",
        "-alpha",
        "+generated",
        "*** Update File: repeated-generated.txt",
        "@@",
        "-generated",
        "+wrong",
        "*** End Patch",
      ].join("\n")

      yield* expectFailure(execute({ patchText }, ctx), "Failed to find expected lines")
      expect(yield* readText(target)).toBe("alpha\nomega\n")
    }),
  )

  // real source 与 symlink alias 必须归入同一 proposal，alias 拼写不能恢复 incremental generated-text 成功。
  // 原文件不变同时证明 alias grouping 与单文件原子写入都在真实 Tool boundary 生效。
  it.instance("rejects generated-text dependencies through a source alias", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { ctx } = makeCtx()
      const realDir = path.join(test.directory, "source-real")
      const aliasDir = path.join(test.directory, "source-alias")
      yield* makeDir(realDir)
      yield* Effect.promise(() => fs.symlink(realDir, aliasDir))
      const target = path.join(realDir, "source.txt")
      yield* writeText(target, "alpha\nomega\n")
      const patchText = [
        "*** Begin Patch",
        "*** Update File: source-real/source.txt",
        "@@",
        "-alpha",
        "+generated",
        "*** Update File: source-alias/source.txt",
        "@@",
        "-generated",
        "+wrong",
        "*** End Patch",
      ].join("\n")

      yield* expectFailure(execute({ patchText }, ctx), "Failed to find expected lines")
      expect(yield* readText(target)).toBe("alpha\nomega\n")
    }),
  )

  it.instance("accepts canonical-equivalent repeated move destinations", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { ctx } = makeCtx()
      const original = path.join(test.directory, "old", "name.txt")
      const renamed = path.join(test.directory, "renamed")
      yield* makeDir(path.dirname(original))
      yield* makeDir(renamed)
      yield* Effect.promise(() => fs.symlink(renamed, path.join(test.directory, "alias")))
      yield* writeText(original, "old content\nsecond line\n")
      yield* writeText(path.join(renamed, "name.txt"), "existing\n")

      const patchText =
        "*** Begin Patch\n*** Update File: old/name.txt\n*** Move to: renamed/name.txt\n@@\n-old content\n+new content\n*** Update File: old/name.txt\n*** Move to: alias/name.txt\n@@\n-second line\n+third line\n*** End Patch"

      yield* execute({ patchText }, ctx)

      yield* expectReadFailure(original)
      expect(yield* readText(path.join(renamed, "name.txt"))).toBe("new content\nthird line\n")
    }),
  )

  it.instance("moves file overwriting existing destination", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { ctx } = makeCtx()
      const original = path.join(test.directory, "old", "name.txt")
      const destination = path.join(test.directory, "renamed", "dir", "name.txt")
      yield* makeDir(path.dirname(original))
      yield* makeDir(path.dirname(destination))
      yield* writeText(original, "from\n")
      yield* writeText(destination, "existing\n")

      const patchText =
        "*** Begin Patch\n*** Update File: old/name.txt\n*** Move to: renamed/dir/name.txt\n@@\n-from\n+new\n*** End Patch"

      yield* execute({ patchText }, ctx)

      yield* expectReadFailure(original)
      expect(yield* readText(destination)).toBe("new\n")
    }),
  )

  itLineEndingFormatted.instance("restores source CRLF at the formatted move destination", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { ctx } = makeCtx()
      const source = path.join(test.directory, "move-source.txt")
      const destination = path.join(test.directory, "move-destination.txt")
      yield* writeText(source, "before\r\ncontent\r\n")
      yield* writeText(destination, "destination\n")

      yield* execute(
        {
          patchText:
            "*** Begin Patch\n*** Update File: move-source.txt\n*** Move to: move-destination.txt\n@@\n-before\n+new\n*** End Patch",
        },
        ctx,
      )

      // move 的内容属性来自 source；恢复必须落在 destination，同时原 source 仍按既有语义删除。
      // destination 预先存在但其 LF 不参与 ownership，测试锁定 source ending 的优先级。
      // source 删除断言确保恢复逻辑没有通过复制而非 move 来绕开原有 mutation 语义。
      expect(yield* readText(destination)).toBe("formatted\r\ncontent\r\n")
      yield* expectReadFailure(source)
    }),
  )

  it.instance("adds file overwriting existing file", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { ctx } = makeCtx()
      const target = path.join(test.directory, "duplicate.txt")
      yield* writeText(target, "old\r\ncontent\r\n")

      const patchText = "*** Begin Patch\n*** Add File: duplicate.txt\n+new\n+content\n*** End Patch"

      yield* execute({ patchText }, ctx)
      // Add File 在 existing path 上是 overwrite；patch LF 表示逻辑行，不得清洗 proposal 的 CRLF 属性。
      // 初次写盘断言与 formatter-sensitive Add 分开，分别定位 proposal 转换和后置恢复责任。
      expect(yield* readText(target)).toBe("new\r\ncontent\r\n")
    }),
  )

  itLineEndingFormatted.instance("restores existing CRLF after formatting an add-overwrite", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { ctx } = makeCtx()
      const target = path.join(test.directory, "formatted-add.txt")
      yield* writeText(target, "old\r\ncontent\r\n")

      yield* execute(
        { patchText: "*** Begin Patch\n*** Add File: formatted-add.txt\n+new\n+content\n*** End Patch" },
        ctx,
      )

      // add 的初次转换与 formatter 后恢复是两个边界；最终文本和原 CRLF 必须同时成立。
      // Add File 覆写的目标仍是原路径，不能只用 update 测试覆盖 shared loop。
      expect(yield* readText(target)).toBe("formatted\r\ncontent\r\n")
    }),
  )

  it.instance("rejects update when target file is missing", () =>
    Effect.gen(function* () {
      const { ctx } = makeCtx()
      const patchText = "*** Begin Patch\n*** Update File: missing.txt\n@@\n-nope\n+better\n*** End Patch"

      yield* expectFailure(
        execute({ patchText }, ctx),
        // [local-smark] per-file atomicity 后，单 hunk 失败走 "all hunks failed" 路径
        "all hunks failed",
      )
    }),
  )

  it.instance("rejects delete when file is missing", () =>
    Effect.gen(function* () {
      const { ctx } = makeCtx()
      const patchText = "*** Begin Patch\n*** Delete File: missing.txt\n*** End Patch"

      yield* expectFailure(execute({ patchText }, ctx))
    }),
  )

  it.instance("rejects delete when target is a directory", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { ctx } = makeCtx()
      const dirPath = path.join(test.directory, "dir")
      yield* makeDir(dirPath)

      const patchText = "*** Begin Patch\n*** Delete File: dir\n*** End Patch"

      yield* expectFailure(execute({ patchText }, ctx))
    }),
  )

  it.instance("rejects invalid hunk header", () =>
    Effect.gen(function* () {
      const { ctx } = makeCtx()
      const patchText = "*** Begin Patch\n*** Frobnicate File: foo\n*** End Patch"

      yield* expectFailure(execute({ patchText }, ctx), "apply_patch verification failed")
    }),
  )

  it.instance("rejects update with missing context", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { ctx } = makeCtx()
      const target = path.join(test.directory, "modify.txt")
      yield* writeText(target, "line1\nline2\n")

      const patchText = "*** Begin Patch\n*** Update File: modify.txt\n@@\n-missing\n+changed\n*** End Patch"

      yield* expectFailure(execute({ patchText }, ctx), "apply_patch verification failed")
      expect(yield* readText(target)).toBe("line1\nline2\n")
    }),
  )

  // [local-smark] per-file atomicity 后，多文件 patch 中成功的文件会被 apply。
  // 此测试验证 add 成功但 update 失败时，add 的文件存在，update 的文件未变。
  it.instance("partial success applies successful files when some fail", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { ctx } = makeCtx()
      const patchText =
        "*** Begin Patch\n*** Add File: created.txt\n+hello\n*** Update File: missing.txt\n@@\n-old\n+new\n*** End Patch"

      const result = yield* execute({ patchText }, ctx)
      // add 成功：created.txt 应存在
      expect(yield* readText(path.join(test.directory, "created.txt"))).toBe("hello\n")
      // output 应同时包含成功和失败信息
      expect(result.output).toContain("created.txt")
      expect(result.output).toContain("missing.txt")
    }),
  )

  it.instance("supports end of file anchor", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { ctx } = makeCtx()
      const target = path.join(test.directory, "tail.txt")
      yield* writeText(target, "alpha\nlast\n")

      const patchText = "*** Begin Patch\n*** Update File: tail.txt\n@@\n-last\n+end\n*** End of File\n*** End Patch"

      yield* execute({ patchText }, ctx)
      expect(yield* readText(target)).toBe("alpha\nend\n")
    }),
  )

  it.instance("rejects missing second chunk context", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { ctx } = makeCtx()
      const target = path.join(test.directory, "two_chunks.txt")
      yield* writeText(target, "a\nb\nc\nd\n")

      const patchText = "*** Begin Patch\n*** Update File: two_chunks.txt\n@@\n-b\n+B\n\n-d\n+D\n*** End Patch"

      yield* expectFailure(execute({ patchText }, ctx))
      expect(yield* readText(target)).toBe("a\nb\nc\nd\n")
    }),
  )

  it.instance("disambiguates change context with @@ header", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { ctx } = makeCtx()
      const target = path.join(test.directory, "multi_ctx.txt")
      yield* writeText(target, "fn a\nx=10\ny=2\nfn b\nx=10\ny=20\n")

      const patchText = "*** Begin Patch\n*** Update File: multi_ctx.txt\n@@ fn b\n-x=10\n+x=11\n*** End Patch"

      yield* execute({ patchText }, ctx)
      expect(yield* readText(target)).toBe("fn a\nx=10\ny=2\nfn b\nx=11\ny=20\n")
    }),
  )

  it.instance("EOF anchor matches from end of file first", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { ctx } = makeCtx()
      const target = path.join(test.directory, "eof_anchor.txt")
      // File has duplicate "marker" lines - one in middle, one at end
      yield* writeText(target, "start\nmarker\nmiddle\nmarker\nend\n")

      // With EOF anchor, should match the LAST "marker" line, not the first
      const patchText =
        "*** Begin Patch\n*** Update File: eof_anchor.txt\n@@\n-marker\n-end\n+marker-changed\n+end\n*** End of File\n*** End Patch"

      yield* execute({ patchText }, ctx)
      // First marker unchanged, second marker changed
      expect(yield* readText(target)).toBe("start\nmarker\nmiddle\nmarker-changed\nend\n")
    }),
  )

  it.instance("parses heredoc-wrapped patch", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { ctx } = makeCtx()
      const patchText = `cat <<'EOF'
*** Begin Patch
*** Add File: heredoc_test.txt
+heredoc content
*** End Patch
EOF`

      yield* execute({ patchText }, ctx)
      expect(yield* readText(path.join(test.directory, "heredoc_test.txt"))).toBe("heredoc content\n")
    }),
  )

  it.instance("parses heredoc-wrapped patch without cat", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { ctx } = makeCtx()
      const patchText = `<<EOF
*** Begin Patch
*** Add File: heredoc_no_cat.txt
+no cat prefix
*** End Patch
EOF`

      yield* execute({ patchText }, ctx)
      expect(yield* readText(path.join(test.directory, "heredoc_no_cat.txt"))).toBe("no cat prefix\n")
    }),
  )

  // PI normalize 在 exact miss 后统一 trimEnd；空格与 Tab 行尾差异应落到唯一 whole-line replacement。
  it.instance("applies a unique trailing-whitespace normalized match", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { ctx } = makeCtx()
      const target = path.join(test.directory, "trailing_ws.txt")
      yield* writeText(target, "line1\nline2\t\n")

      const patchText = "*** Begin Patch\n*** Update File: trailing_ws.txt\n@@\n-line2 \n+changed\n*** End Patch"

      yield* execute({ patchText }, ctx)
      expect(yield* readText(target)).toBe("line1\nchanged\n")
    }),
  )

  // PI normalize 不 trimStart；两种前导缩进逐字不同，不能产生 whole-line success。
  // 真实 Tool 文件不变断言同时覆盖 owner error 到写入边界的原子性。
  it.instance("rejects nonliteral leading whitespace differences", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { ctx } = makeCtx()
      const target = path.join(test.directory, "leading_ws.txt")
      yield* writeText(target, "\tline2\n")

      const patchText = "*** Begin Patch\n*** Update File: leading_ws.txt\n@@\n-  line2\n+changed\n*** End Patch"

      yield* expectFailure(execute({ patchText }, ctx), "Failed to find expected lines")
      expect(yield* readText(target)).toBe("\tline2\n")
    }),
  )

  // exact miss 后，唯一 Unicode punctuation 等价行由同一 locator 规范化并替换。
  it.instance("applies a unique Unicode-normalized whole-line match", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { ctx } = makeCtx()
      const target = path.join(test.directory, "unicode.txt")
      // File has fancy Unicode quotes (U+201C, U+201D) and em-dash (U+2014)
      const leftQuote = "\u201C"
      const rightQuote = "\u201D"
      const emDash = "\u2014"
      yield* writeText(target, `He said ${leftQuote}hello${rightQuote}\nsome${emDash}dash\nend\n`)

      const patchText =
        '*** Begin Patch\n*** Update File: unicode.txt\n@@\n-He said "hello"\n+He said "hi"\n*** End Patch'

      yield* execute({ patchText }, ctx)
      expect(yield* readText(target)).toBe(`He said "hi"\nsome${emDash}dash\nend\n`)
    }),
  )

  // Tool 必须透传 Patch owner 的 normalized raw span；引号等价不能扩大为整行 replacement 或改写两侧文本。
  it.instance("applies a unique Unicode-normalized proper substring", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { ctx } = makeCtx()
      const target = path.join(test.directory, "unicode_substring.txt")
      yield* writeText(target, "prefix He said “hello” suffix\n")
      const patchText =
        '*** Begin Patch\n*** Update File: unicode_substring.txt\n@@\n-He said "hello"\n+fixed\n*** End Patch'

      yield* execute({ patchText }, ctx)
      expect(yield* readText(target)).toBe("prefix fixed suffix\n")
    }),
  )

  // 完全无关的 expected 与文件没有可靠 candidate，展示任意 actual excerpt 会制造 false precision。
  // Tool 输入已向模型保留请求文本，失败正文不能再次复制它，否则同一上下文会出现两份 old block。
  // 低于阈值时应明确要求 read，而不是把 real content 错标为附近位置。
  it.instance("suppresses unrelated candidates when context mismatches", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { ctx } = makeCtx()
      const target = path.join(test.directory, "mismatch.txt")
      // 文件含 "real content"，patch 搜索 "missing context"
      yield* writeText(target, "line1\nreal content here\nline3\n")

      const patchText =
        "*** Begin Patch\n*** Update File: mismatch.txt\n@@\n-missing context\n+changed\n*** End Patch"

      const exit = yield* execute({ patchText }, ctx).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const err = Cause.squash(exit.cause) as Error
        expect(err.message).toContain("No reliable nearby candidate was found")
        expect(err.message).not.toContain("real content")
        // 组合真实 Tool input/result，而不是只检查 error，才能捕获用户看到的上下文级重复。
        expect((patchText + err.message).split("missing context").length - 1).toBe(1)
        expect(err.message).not.toContain("missing context")
      }
      }),
    )

  // 两个不同 end 与 failed chunk 具有相同最小距离；Patch 不能按文件顺序挑选一个 actual。
  // 文件不变断言同时证明 tie 仍属于 diagnostic failure，而不是 fuzzy replacement success。
  it.instance("suppresses a multi-end closest tie", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { ctx } = makeCtx()
      const target = path.join(test.directory, "multi-end-tie.txt")
      const original = "target sequence alpha beta gammo\nfiller\ntarget sequence alpha beta gammi\n"
      yield* writeText(target, original)
      const patchText = [
        "*** Begin Patch",
        "*** Update File: multi-end-tie.txt",
        "@@",
        "-target sequence alpha beta gamma",
        "+replacement",
        "*** End Patch",
      ].join("\n")

      const exit = yield* execute({ patchText }, ctx).pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const error = Cause.squash(exit.cause) as Error
        expect(error.message).toContain("No reliable nearby candidate was found")
        expect(error.message).not.toContain("gammo")
        expect(error.message).not.toContain("gammi")
      }
      expect(yield* readText(target)).toBe(original)
    }),
  )

  // Tool wrapper 不能在 owner 丢失身份后重扫第一个 chunk；提示必须绑定真正失败的第二个 chunk。
  // 失败身份由 Patch owner 的主路径确定，wrapper 只负责组合既有错误文案和 actual 证据。
  // 长字符集 decoy 同时证明 bounded window 选择第 4 行候选，而不是重复旧的无界 scorer。
  // 失败 chunk 的 requested 只留在 patchText，result 用 actual 与列区间提供增量证据。
  // 断言因此同时锁定失败归因、去重约束和列差异 renderer，避免测试只验证“有错误”。
  it.instance("reports the reliable candidate for the chunk that actually failed", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { ctx } = makeCtx()
      const target = path.join(test.directory, "failed_chunk.txt")
      const decoy = "a".repeat(180) + "t".repeat(180) + "e".repeat(180)
      const candidate = "prefix target sequence alpha beta gamxa suffix"
      yield* writeText(target, `first\n${decoy}\nfiller\n${candidate}\n`)

      const patchText = [
        "*** Begin Patch",
        "*** Update File: failed_chunk.txt",
        "@@",
        "-first",
        "+FIRST",
        "@@",
        "-target sequence alpha beta gamma",
        "+replacement",
        "*** End Patch",
      ].join("\n")
      const exit = yield* execute({ patchText }, ctx).pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const error = Cause.squash(exit.cause) as Error
        expect(error.message).toContain("Closest match at line 4")
        expect(error.message).toContain(candidate)
        expect(error.message).toContain("difference: requested columns")
        expect((patchText + error.message).split("target sequence alpha beta gamma").length - 1).toBe(1)
        expect(error.message).not.toContain("target sequence alpha beta gamma")
        expect(error.message).not.toContain(decoy)
      }
      expect(yield* readText(target)).toBe(`first\n${decoy}\nfiller\n${candidate}\n`)
    }),
  )

  // [local-smark] per-file atomicity：多文件 patch 中一个文件失败时，
  // 成功的文件应正常 apply，失败的文件在 output 中报告 error。
  // 部分成功走 output-available，但同样不能复制 input 已携带的失败 old block。
  // 旧行为是整个 patch 失败（all-or-nothing），成功的 hunk 也被丢弃。
  it.instance("applies successful files and reports failed files in multi-file patch", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { ctx } = makeCtx()
      const goodFile = path.join(test.directory, "good.txt")
      const badFile = path.join(test.directory, "bad.txt")
      yield* writeText(goodFile, "hello\n")
      yield* writeText(badFile, "world\n")

      // good.txt 的 context 正确，bad.txt 的 context 错误。
      // 多文件聚合仍允许成功文件落盘，但失败文件只能报告诊断，不得改变其内容。
      const patchText = [
        "*** Begin Patch",
        "*** Update File: good.txt",
        "@@",
        "-hello",
        "+hi",
        "*** Update File: bad.txt",
        "@@",
        "-missing line",
        "+changed",
        "*** End Patch",
      ].join("\n")

      const result = yield* execute({ patchText }, ctx)

      // good.txt 应被成功修改
      expect(yield* readText(goodFile)).toBe("hi\n")
      // output 应同时包含成功和失败信息
      expect(result.output).toContain("good.txt")
      expect(result.output).toContain("bad.txt")
      expect(result.output).toContain("No reliable nearby candidate was found")
      // 成功 result 与失败 error 共用 Patch owner 文案；两条 Provider 路径必须保持同一去重不变量。
      expect((patchText + result.output).split("missing line").length - 1).toBe(1)
      expect(result.output).not.toContain("missing line")
      // bad.txt 内容不应被修改
      expect(yield* readText(badFile)).toBe("world\n")
    }),
  )
})

// [local-smark] 元数据 diff 有界切片：二进制 delete 的全文行 diff 是 407MB part 行事故的
// 直接构成物；本组切片锁定"标记 + 度量 + sha256 身份"的有界表示与计数精确性（INV-01/07/08）。
describe("tool.apply_patch metadata diff bounding", () => {
  it.instance("bounds metadata diff for binary file deletion", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const binPath = path.join(test.directory, "bin.dat")
      // 覆盖全部字节值的确定性二进制：前 8KB 必然含 NUL（与 git buffer_is_binary 同窗口）。
      const buf = Buffer.alloc(512 * 1024)
      for (let i = 0; i < buf.length; i++) buf[i] = (i * 7 + 13) & 0xff
      yield* Effect.promise(() => fs.writeFile(binPath, buf))

      const { ctx, calls } = makeCtx()
      const result = yield* execute({ patchText: "*** Begin Patch\n*** Delete File: bin.dat\n*** End Patch" }, ctx)

      const meta = result.metadata as {
        diff: string
        files: Array<{ patch: string; additions: number; deletions: number }>
      }
      for (const diff of [meta.diff, ...meta.files.map((f) => f.patch), calls[0].metadata.diff]) {
        expect(diff.length).toBeLessThan(64 * 1024)
        expect(diff).toContain("Binary file")
      }
      // 二进制计数与 snapshot git 路径对齐（0/0）；变更执行不受表示影响。
      expect(meta.files[0].additions).toBe(0)
      expect(meta.files[0].deletions).toBe(0)
      yield* expectReadFailure(binPath)
    }),
  )

  it.instance("keeps full line diff for normal small text deletion", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const target = path.join(test.directory, "notes.txt")
      yield* writeText(target, "alpha\n-- sql comment\nbravo\n")
      const { ctx } = makeCtx()

      const result = yield* execute({ patchText: "*** Begin Patch\n*** Delete File: notes.txt\n*** End Patch" }, ctx)

      const meta = result.metadata as {
        diff: string
        files: Array<{ patch: string; additions: number; deletions: number }>
      }
      // 正常文本的行级 diff 逐字保留（审计保真），含 "--" 前缀内容行；计数 = 变更行数。
      expect(meta.files[0].patch).toContain("-- sql comment")
      expect(meta.files[0].deletions).toBe(3)
      expect(meta.files[0].additions).toBe(0)
    }),
  )
})

// [local-smark] write/edit 的有界切片按 plan §15 寄居本文件（文件数契约：总触碰 ≤6）。
// 公共头尾 + 8000 行差异中段（~640KB）：中段超 64KiB 触发重写标记，同时避免全异行
// Myers 最坏 case 在现状代码上无限挂起（现状实测 >139s，PROBE2 二次方增长）。
const bigRewriteFixture = (v: string) =>
  [
    ...Array.from({ length: 1000 }, (_, i) => `common head ${i} ${"h".repeat(40)}`),
    ...Array.from({ length: 8000 }, (_, i) => `${v} middle ${i} ${"m".repeat(40)}`),
    ...Array.from({ length: 1000 }, (_, i) => `common tail ${i} ${"t".repeat(40)}`),
  ].join("\n")

describe("tool.write metadata diff bounding (hosted per plan §15)", () => {
  it.instance("bounds metadata diff for large whole-file rewrite", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const bigPath = path.join(test.directory, "big.txt")
      yield* Effect.promise(() => fs.writeFile(bigPath, bigRewriteFixture("old"), "utf-8"))
      const { ctx, calls } = makeCtx()
      const info = yield* WriteTool
      const tool = yield* info.init()

      const result = yield* tool.execute({ filePath: bigPath, content: bigRewriteFixture("new") }, ctx)

      const meta = result.metadata as { diff: string; additions: number; deletions: number }
      // 三处消费面同界：result metadata、ask metadata；标记携带中段行数与全文件 sha256 身份。
      expect(meta.diff.length).toBeLessThan(64 * 1024)
      expect(meta.diff).toContain("whole-file rewrite")
      expect(meta.diff).toContain("old: 8000 mid lines")
      expect(meta.diff).toContain("new: 8000 mid lines")
      expect(meta.deletions).toBe(8000)
      expect(meta.additions).toBe(8000)
      expect(calls[0].metadata.diff.length).toBeLessThan(64 * 1024)
      // 变更执行不受表示影响：新内容落盘。
      expect(yield* readText(bigPath)).toBe(bigRewriteFixture("new"))
    }),
  )
})

// [local-smark] edit 盲改保护要求 ctx.messages 含同文件的已完成 read part（与 edit.test.ts 同构造）。
const editCtxWithPriorRead = (ctx: ToolCtx, filePath: string, directory: string) =>
  ({
    ...ctx,
    messages: [
      {
        info: {
          id: "msg_prior",
          role: "assistant" as const,
          sessionID: ctx.sessionID,
          agent: "build",
          mode: "build",
          path: { cwd: directory, root: directory },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: "test",
          providerID: "test",
          time: { created: 0 },
        },
        parts: [
          {
            id: "p_read",
            messageID: "msg_prior",
            sessionID: ctx.sessionID,
            type: "tool" as const,
            tool: "read",
            callID: "call_read",
            state: { status: "completed" as const, input: { filePath }, output: "content", metadata: {}, time: { start: 0, end: 1 } },
          },
        ],
      },
    ],
  }) as unknown as ToolCtx

describe("tool.edit metadata diff bounding (hosted per plan §15)", () => {
  it.instance("emits rewrite marker with exact mid-line counts for oversized middle", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const target = path.join(test.directory, "gen.txt")
      // 公共头尾各 1000 行，中段各 2000 行（~90KB > 64KiB 界）。
      const mk = (v: string) =>
        [
          ...Array.from({ length: 1000 }, (_, i) => `common head ${i} ${"h".repeat(20)}`),
          ...Array.from({ length: 2000 }, (_, i) => `${v} ${i} ${"x".repeat(34)}`),
          ...Array.from({ length: 1000 }, (_, i) => `common tail ${i} ${"t".repeat(20)}`),
        ].join("\n")
      yield* writeText(target, mk("old"))
      const { ctx } = makeCtx()
      const info = yield* EditTool
      const tool = yield* info.init()

      const result = yield* tool.execute(
        { filePath: target, edits: [{ oldString: mk("old"), newString: mk("new") }] },
        editCtxWithPriorRead(ctx, target, test.directory),
      )

      const meta = result.metadata as { filediff: { patch: string; additions: number; deletions: number } }
      expect(meta.filediff.patch).toContain("whole-file rewrite")
      // 中段口径计数：公共头尾不计，变更行 = 中段行数（INV-08）。
      expect(meta.filediff.deletions).toBe(2000)
      expect(meta.filediff.additions).toBe(2000)
      expect(yield* readText(target)).toBe(mk("new"))
    }),
  )

  it.instance("keeps exact counts for changed lines with -- and ++ prefixes", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const target = path.join(test.directory, "sql.txt")
      yield* writeText(target, "alpha\n-- sql comment\nbravo\n++ keep\n")
      const { ctx } = makeCtx()
      const info = yield* EditTool
      const tool = yield* info.init()

      const result = yield* tool.execute(
        { filePath: target, edits: [{ oldString: "-- sql comment\nbravo", newString: "bravo\n++ added line" }] },
        editCtxWithPriorRead(ctx, target, test.directory),
      )

      const meta = result.metadata as { filediff: { patch: string; additions: number; deletions: number } }
      // 独立推导（行级 LCS）：公共行 "bravo" 被匹配，变更 = 删 "-- sql comment"、增 "++ added line"。
      // "--"/"++" 前缀内容行与 unified 文件头同形，锁定 hunk 门控计数不误杀（PROBE1 教训）。
      expect(meta.filediff.deletions).toBe(1)
      expect(meta.filediff.additions).toBe(1)
      expect(meta.filediff.patch).toContain("+++ added line")
    }),
  )
})

// [local-smark] SummaryCache 摄入界切片：聚合端免疫已入库 legacy 巨型 metadata（216MB
// user message 行事故），且 write 显式计数优先于标记重扫描（plan B-02）。
const toolDiffMessages = (metadata: Record<string, unknown>) =>
  [
    {
      info: { id: "m1", hidden: false },
      parts: [{ hidden: false, type: "tool" as const, state: { status: "completed" as const, metadata } }],
    },
  ] as unknown as Parameters<typeof SummaryCache.collectToolDiffs>[0]

describe("summary-cache aggregate bounding (hosted per plan §15)", () => {
  it.effect("bounds aggregate patch while preserving exact counts for legacy giant tool metadata", () =>
    Effect.gen(function* () {
      const giant = "+" + "x".repeat(5 * 1024 * 1024)
      const diffs = SummaryCache.collectToolDiffs(
        toolDiffMessages({ files: [{ relativePath: "a.txt", patch: giant, additions: 1, deletions: 2 }] }),
        "/wt",
      )
      const entry = diffs.find((d) => d.file === "a.txt")
      if (!entry) throw new Error("expected aggregated entry for a.txt")
      expect((entry.patch ?? "").length).toBeLessThan(1024 * 1024)
      // 计数照常累加：聚合界只降级 patch 文本，不丢统计口径（INV-05）。
      expect(entry.additions).toBe(1)
      expect(entry.deletions).toBe(2)
    }),
  )

  it.instance("prefers explicit write counts when ingesting bounded markers", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const bigPath = path.join(test.directory, "ingest.txt")
      yield* Effect.promise(() => fs.writeFile(bigPath, bigRewriteFixture("old"), "utf-8"))
      const { ctx } = makeCtx()
      const info = yield* WriteTool
      const tool = yield* info.init()
      const result = yield* tool.execute({ filePath: bigPath, content: bigRewriteFixture("new") }, ctx)

      const diffs = SummaryCache.collectToolDiffs(toolDiffMessages(result.metadata), test.directory)
      const entry = diffs.find((d) => d.file === "ingest.txt")
      if (!entry) throw new Error("expected ingested entry for ingest.txt")
      // 显式计数优先：rewrite 标记无 +/- 正文，重扫描会退化为 0/0（plan B-02）；三工具计数口径一致。
      expect(entry.additions).toBe(8000)
      expect(entry.deletions).toBe(8000)
    }),
  )

  it.instance("keeps exact counts for normal small write ingestion", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const smallPath = path.join(test.directory, "small.txt")
      const { ctx } = makeCtx()
      const info = yield* WriteTool
      const tool = yield* info.init()
      const result = yield* tool.execute({ filePath: smallPath, content: "hello\nworld\n" }, ctx)

      const meta = result.metadata as { diff: string; additions: number; deletions: number }
      // 新建两行：+2/-0；正常路径 patch 逐字含全文内容行（INV-02 审计保真）。
      expect(meta.diff).toContain("+hello")
      expect(meta.additions).toBe(2)
      expect(meta.deletions).toBe(0)
    }),
  )
})
