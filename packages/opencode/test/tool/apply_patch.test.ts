import { describe, expect } from "bun:test"
import path from "path"
import * as fs from "fs/promises"
import { Cause, Effect, Exit, Layer } from "effect"
import { ApplyPatchTool } from "../../src/tool/apply_patch"
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

  // 第二个 chunk 的 exact 文本只存在于 forward cursor 之前；matcher 必须继续失败，诊断也不能回显该文本。
  // 位置提示来自 immutable 原文件，但不能把它误当成当前 working copy 中仍可替换的 actual。
  it.instance("does not repeat an exact candidate before the patch cursor", () =>
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

      const exit = yield* execute({ patchText }, ctx).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const error = Cause.squash(exit.cause) as Error
        expect(error.message).toContain("Closest match at line 1")
        expect(error.message).toContain("exists at this location in the original file")
        expect(error.message).not.toContain("alpha")
        expect((patchText + error.message).split("alpha").length - 1).toBe(1)
      }
      expect(yield* readText(target)).toBe("alpha\nmiddle\nomega\n")
    }),
  )

  // 前序 replacement 已从 working copy 消费 alpha；persisted candidate 只能解释原文件位置，不能猜测 cursor 原因。
  // Tool input 有两个独立 `-alpha` 请求，result 不得制造第三份，且整个文件仍按单 hunk 原子失败。
  it.instance("does not repeat an exact candidate consumed by a prior chunk", () =>
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
        expect(error.message).toContain("Closest match at line 1")
        expect(error.message).toContain("unavailable to the current patch step")
        expect(error.message).not.toContain("alpha")
        expect((patchText + error.message).split("alpha").length - 1).toBe(2)
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

  it.instance("adds file overwriting existing file", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { ctx } = makeCtx()
      const target = path.join(test.directory, "duplicate.txt")
      yield* writeText(target, "old content\n")

      const patchText = "*** Begin Patch\n*** Add File: duplicate.txt\n+new content\n*** End Patch"

      yield* execute({ patchText }, ctx)
      expect(yield* readText(target)).toBe("new content\n")
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

  // 空格与 Tab 仅在 trimEnd 后相等，完整旧块并不是文件中的字面 substring。
  // Patch 必须失败并保留文件，防止 rstrip compatibility pass 重新成为第三种 success。
  it.instance("rejects nonliteral trailing whitespace differences", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { ctx } = makeCtx()
      const target = path.join(test.directory, "trailing_ws.txt")
      yield* writeText(target, "line1\nline2\t\n")

      const patchText = "*** Begin Patch\n*** Update File: trailing_ws.txt\n@@\n-line2 \n+changed\n*** End Patch"

      yield* expectFailure(execute({ patchText }, ctx), "Failed to find expected lines")
      expect(yield* readText(target)).toBe("line1\nline2\t\n")
    }),
  )

  // 两种缩进 trim 后相同但逐字不同，不能让 whole-line trim pass 抢在 substring failure 前成功。
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

  // Unicode punctuation normalization 改变了字面值，不能在 exact-only contract 中产生 replacement success。
  // 失败提示可以展示可靠候选，但磁盘必须保持原 Unicode 引号和破折号。
  it.instance("rejects Unicode-normalized matching", () =>
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

      yield* expectFailure(execute({ patchText }, ctx), "Failed to find expected lines")
      expect(yield* readText(target)).toBe(`He said ${leftQuote}hello${rightQuote}\nsome${emDash}dash\nend\n`)
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

  // Tool wrapper 不能在 owner 丢失身份后重扫第一个 chunk；提示必须绑定真正失败的第二个 chunk。
  // 长字符集 decoy 同时证明 bounded window 选择第 4 行候选，而不是重复旧的无界 scorer。
  // 失败 chunk 的 requested 只留在 patchText，result 用 actual 与列区间提供增量证据。
  it.instance("reports the reliable candidate for the chunk that actually failed", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const { ctx } = makeCtx()
      const target = path.join(test.directory, "failed_chunk.txt")
      const decoy = "a".repeat(180) + "t".repeat(180) + "e".repeat(180)
      const candidate = "prefix target sequence alpha beta gammo suffix"
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

      // good.txt 的 context 正确，bad.txt 的 context 错误
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
