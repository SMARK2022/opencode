import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { Effect } from "effect"
import * as fs from "fs/promises"
import * as path from "path"
import { tmpdir } from "os"
import { Patch } from "../../src/patch"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { testEffect } from "../lib/effect"

const it = testEffect(AppFileSystem.defaultLayer)

describe("Patch namespace", () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(tmpdir(), "patch-test-"))
  })

  afterEach(async () => {
    // Clean up temp directory
    await fs.rm(tempDir, { recursive: true, force: true })
  })

  describe("parsePatch", () => {
    test("should parse simple add file patch", () => {
      const patchText = `*** Begin Patch
*** Add File: test.txt
+Hello World
*** End Patch`

      const result = Patch.parsePatch(patchText)
      expect(result.hunks).toHaveLength(1)
      expect(result.hunks[0]).toEqual({
        type: "add",
        path: "test.txt",
        contents: "Hello World",
      })
    })

    test("should parse delete file patch", () => {
      const patchText = `*** Begin Patch
*** Delete File: old.txt
*** End Patch`

      const result = Patch.parsePatch(patchText)
      expect(result.hunks).toHaveLength(1)
      const hunk = result.hunks[0]
      expect(hunk.type).toBe("delete")
      expect(hunk.path).toBe("old.txt")
    })

    test("should parse patch with multiple hunks", () => {
      const patchText = `*** Begin Patch
*** Add File: new.txt
+This is a new file
*** Update File: existing.txt
@@
 old line
-new line
+updated line
*** End Patch`

      const result = Patch.parsePatch(patchText)
      expect(result.hunks).toHaveLength(2)
      expect(result.hunks[0].type).toBe("add")
      expect(result.hunks[1].type).toBe("update")
    })

    test("should parse file move operation", () => {
      const patchText = `*** Begin Patch
*** Update File: old-name.txt
*** Move to: new-name.txt
@@
-Old content
+New content
*** End Patch`

      const result = Patch.parsePatch(patchText)
      expect(result.hunks).toHaveLength(1)
      const hunk = result.hunks[0]
      expect(hunk.type).toBe("update")
      expect(hunk.path).toBe("old-name.txt")
      if (hunk.type === "update") {
        expect(hunk.move_path).toBe("new-name.txt")
      }
    })

    test("should throw error for invalid patch format", () => {
      const invalidPatch = `This is not a valid patch`

      expect(() => Patch.parsePatch(invalidPatch)).toThrow("Invalid patch format")
    })
  })

  describe("deriveNewContentsFromChunks", () => {
    // 整行匹配失败后只能替换唯一的字面跨度，不能把同一行未提交的前缀一起删除。
    // 这个断言直接锁定用户的 ABCDEFG/CDEFG 症状，而不依赖私有 matcher 的实现形状。
    test("preserves surrounding text for a unique substring", () => {
      const result = Patch.deriveNewContentsFromChunks(
        "fixture.txt",
        [{ old_lines: ["CDEFG"], new_lines: ["fixed"] }],
        "ABCDEFG\n",
      )

      expect(result.content).toBe("ABfixed\n")
    })

    // 旧 trim pass 会把整行外围空格一起替换；字面跨度模式只能拥有 CDEFG 本身。
    // 前后空格都是调用方未提交的内容，必须在成功结果中逐字符保留。
    test("preserves both sides when the literal is inside a line", () => {
      const result = Patch.deriveNewContentsFromChunks(
        "fixture.txt",
        [{ old_lines: ["CDEFG"], new_lines: ["fixed"] }],
        "  CDEFG  \n",
      )

      expect(result.content).toBe("  fixed  \n")
    })

    // 唯一性只在 exact whole-line 失败后的 substring 分支生效；两个候选不能猜第一个。
    // 错误必须在 owner 内产生，保证所有 Patch consumers 都继承相同拒绝语义。
    test("rejects ambiguous substring matches", () => {
      expect(() =>
        Patch.deriveNewContentsFromChunks(
          "fixture.txt",
          [{ old_lines: ["target"], new_lines: ["fixed"] }],
          "prefix target\nother target\n",
        ),
      ).toThrow("Found multiple matches")
    })

    // 多行 substring 的第一行前缀和末行后缀都不属于 replacement。
    // 使用完整 old block 而非首行匹配，才能证明跨行边界没有被扩大。
    test("preserves multiline substring boundaries", () => {
      const result = Patch.deriveNewContentsFromChunks(
        "fixture.txt",
        [{ old_lines: ["alpha", "beta"], new_lines: ["one", "two"] }],
        "before alpha\nbeta after\n",
      )

      expect(result.content).toBe("before one\ntwo after\n")
    })

    // rstrip、trim、Unicode normalization 和 trailing-empty 缩短都不是字面成功。
    // 每个输入都在旧实现中可达，失败断言防止兼容 pass 悄悄回流。
    test("rejects nonliteral and shortened old blocks", () => {
      const cases = [
        { content: "value\t\n", old: ["value "], name: "trailing whitespace" },
        { content: "\tvalue\n", old: ["  value"], name: "trimmed whitespace" },
        { content: "He said “hello”\n", old: ['He said "hello"'], name: "Unicode punctuation" },
        { content: "foo", old: ["foo", ""], name: "trailing empty line" },
      ]

      for (const item of cases) {
        expect(() =>
          Patch.deriveNewContentsFromChunks(
            item.name,
            [{ old_lines: item.old, new_lines: ["changed"] }],
            item.content,
          ),
        ).toThrow("Failed to find expected lines")
      }
    })

    // 文件真实终止 LF 属于 current working text，完整 old block `foo\n` 应能唯一命中。
    // 该正向断言与 no-tail 失败成对，防止通过恢复 shortened retry 伪装修复。
    test("matches a complete old block that includes the file terminator", () => {
      const result = Patch.deriveNewContentsFromChunks(
        "fixture.txt",
        [{ old_lines: ["foo", ""], new_lines: ["bar"] }],
        "foo\n",
      )

      expect(result.content).toBe("bar\n")
    })

    // cursor 以第一次 replacement 后的 current text 为坐标，允许同一存活行继续向右匹配。
    // 两个修改必须同时保留；退回 whole-line tuple 会拒绝第二个或覆盖第一个。
    test("composes ordered substring chunks on the same line", () => {
      const result = Patch.deriveNewContentsFromChunks(
        "fixture.txt",
        [
          { old_lines: ["DEF"], new_lines: ["X"] },
          { old_lines: ["JKL"], new_lines: ["Y"] },
        ],
        "abcDEFghiJKL",
      )

      expect(result.content).toBe("abcXghiY\n")
    })

    // 后续 chunk 只能搜索前一 replacement 之后的存活原文，不能重新消费生成文本。
    // 整个 working copy 在失败时被丢弃，因此 owner 不会泄漏第一步的局部成功。
    test("does not rematch text introduced by an earlier chunk", () => {
      expect(() =>
        Patch.deriveNewContentsFromChunks(
          "fixture.txt",
          [
            { old_lines: ["alpha"], new_lines: ["generated"] },
            { old_lines: ["generated"], new_lines: ["wrong"] },
          ],
          "alpha",
        ),
      ).toThrow("Failed to find expected lines")
    })

    // 零长度内容仍会生成一个逻辑行，cursor 不能因 replacement 字符数为零而停在该行起点。
    // 第二个 chunk 若能匹配这个空行，就违反了与非空 generated text 相同的隔离契约。
    test("does not rematch an empty line introduced by an earlier chunk", () => {
      expect(() =>
        Patch.deriveNewContentsFromChunks(
          "fixture.txt",
          [
            { old_lines: ["alpha"], new_lines: [""] },
            { old_lines: [""], new_lines: ["wrong"] },
          ],
          "alpha\nomega\n",
        ),
      ).toThrow("Failed to find expected lines")
    })

    // 整行删除继续使用 line splice，不能把被删行留下成一个空逻辑行。
    // 首、中、末、唯一及多行 block 覆盖所有相邻分隔符位置。
    test("preserves exact-line deletion semantics", () => {
      const cases = [
        { content: "a\nb\nc\n", old: ["a"], expected: "b\nc\n" },
        { content: "a\nb\nc\n", old: ["b"], expected: "a\nc\n" },
        { content: "a\nb\nc\n", old: ["c"], expected: "a\nb\n" },
        { content: "a\n", old: ["a"], expected: "" },
        { content: "a\nb\nc\n", old: ["a", "b"], expected: "c\n" },
      ]

      for (const item of cases) {
        const result = Patch.deriveNewContentsFromChunks(
          "fixture.txt",
          [{ old_lines: item.old, new_lines: [] }],
          item.content,
        )
        expect(result.content).toBe(item.expected)
      }
    })

    // pure insertion 是 EOF 行操作：多个 block 保持 patch 顺序，且空文件没有前导空行。
    // 追加动作在匹配全部成功后发生，因此不会成为后续 chunk 的候选文本。
    test("preserves pure insertion order for empty and nonempty files", () => {
      const chunks = [
        { old_lines: [], new_lines: ["beta"] },
        { old_lines: [], new_lines: ["gamma"] },
      ]

      expect(Patch.deriveNewContentsFromChunks("empty.txt", chunks, "").content).toBe("beta\ngamma\n")
      expect(Patch.deriveNewContentsFromChunks("full.txt", chunks, "alpha").content).toBe("alpha\nbeta\ngamma\n")
    })

    // 插入分隔符取决于所有普通 chunk 处理后的 working lines，而不是原文件是否非空。
    // 删除唯一原行后追加必须直接从 beta 开始，不能继承原文计算出的前导 LF。
    test("composes deletion of all content with pure insertion", () => {
      const result = Patch.deriveNewContentsFromChunks(
        "fixture.txt",
        [
          { old_lines: ["alpha"], new_lines: [] },
          { old_lines: [], new_lines: ["beta"] },
        ],
        "alpha",
      )

      expect(result.content).toBe("beta\n")
    })

    // substring context 只定位其包含行，并把 old block 的 lower bound 移到下一行。
    // context 本身不得被修改，否则定位辅助信息会变成第二种 replacement。
    test("locates a unique substring context before replacing the next line", () => {
      const result = Patch.deriveNewContentsFromChunks(
        "fixture.txt",
        [{ change_context: "CDEFG", old_lines: ["old"], new_lines: ["new"] }],
        "ABCDEFG\nold\n",
      )

      expect(result.content).toBe("ABCDEFG\nnew\n")
    })

    // pure insertion 没有 old block，但公开的 @@ context 仍必须走同一 exact locator。
    // 唯一 context 成功后只影响校验与 cursor，实际新行仍统一追加到 EOF。
    test("validates substring context before pure insertion", () => {
      const result = Patch.deriveNewContentsFromChunks(
        "fixture.txt",
        [{ change_context: "marker", old_lines: [], new_lines: ["beta"] }],
        "prefix marker suffix\n",
      )

      expect(result.content).toBe("prefix marker suffix\nbeta\n")
      expect(() =>
        Patch.deriveNewContentsFromChunks(
          "fixture.txt",
          [{ change_context: "missing", old_lines: [], new_lines: ["beta"] }],
          "prefix marker suffix\n",
        ),
      ).toThrow("Failed to find context")
      expect(() =>
        Patch.deriveNewContentsFromChunks(
          "fixture.txt",
          [{ change_context: "marker", old_lines: [], new_lines: ["beta"] }],
          "one marker here\ntwo marker there\n",
        ),
      ).toThrow("Failed to find context")
    })
  })

  describe("maybeParseApplyPatch", () => {
    test("should parse direct apply_patch command", () => {
      const patchText = `*** Begin Patch
*** Add File: test.txt
+Content
*** End Patch`

      const result = Patch.maybeParseApplyPatch(["apply_patch", patchText])
      expect(result.type).toBe(Patch.MaybeApplyPatch.Body)
      if (result.type === Patch.MaybeApplyPatch.Body) {
        expect(result.args.patch).toBe(patchText)
        expect(result.args.hunks).toHaveLength(1)
      }
    })

    test("should parse applypatch command", () => {
      const patchText = `*** Begin Patch
*** Add File: test.txt
+Content
*** End Patch`

      const result = Patch.maybeParseApplyPatch(["applypatch", patchText])
      expect(result.type).toBe(Patch.MaybeApplyPatch.Body)
    })

    test("should handle bash heredoc format", () => {
      const script = `apply_patch <<'PATCH'
*** Begin Patch
*** Add File: test.txt
+Content
*** End Patch
PATCH`

      const result = Patch.maybeParseApplyPatch(["bash", "-lc", script])
      expect(result.type).toBe(Patch.MaybeApplyPatch.Body)
      if (result.type === Patch.MaybeApplyPatch.Body) {
        expect(result.args.hunks).toHaveLength(1)
      }
    })

    test("should return NotApplyPatch for non-patch commands", () => {
      const result = Patch.maybeParseApplyPatch(["echo", "hello"])
      expect(result.type).toBe(Patch.MaybeApplyPatch.NotApplyPatch)
    })
  })

  describe("maybeParseApplyPatchVerified", () => {
    // verified parser 是 owner 的独立 consumer；substring success 必须以精确 new_content 进入 Body。
    // 只测 derive 无法发现 adapter 丢失或改写 owner 结果的回归。
    it.live("returns Body with unique-substring new content", () =>
      Effect.gen(function* () {
        const filePath = path.join(tempDir, "verified.txt")
        yield* Effect.promise(() => fs.writeFile(filePath, "ABCDEFG\n"))
        const patchText = "*** Begin Patch\n*** Update File: verified.txt\n@@\n-CDEFG\n+fixed\n*** End Patch"

        const result = yield* Patch.maybeParseApplyPatchVerified(["apply_patch", patchText], tempDir)

        expect(result.type).toBe(Patch.MaybeApplyPatchVerified.Body)
        if (result.type === Patch.MaybeApplyPatchVerified.Body) {
          expect(result.action.changes.get(filePath)).toEqual({
            type: "update",
            unified_diff: expect.any(String),
            move_path: undefined,
            new_content: "ABfixed\n",
          })
        }
      }),
    )

    // verified parser 不能把 owner ambiguity 降级为 Body 或选择一个 occurrence。
    // CorrectnessError 中保留 owner 语义，shell/preview 路径才不会与 ApplyPatchTool 分叉。
    it.live("returns CorrectnessError for ambiguous substring matches", () =>
      Effect.gen(function* () {
        const filePath = path.join(tempDir, "verified-ambiguous.txt")
        yield* Effect.promise(() => fs.writeFile(filePath, "target one target\n"))
        const patchText =
          "*** Begin Patch\n*** Update File: verified-ambiguous.txt\n@@\n-target\n+fixed\n*** End Patch"

        const result = yield* Patch.maybeParseApplyPatchVerified(["apply_patch", patchText], tempDir)

        expect(result.type).toBe(Patch.MaybeApplyPatchVerified.CorrectnessError)
        if (result.type === Patch.MaybeApplyPatchVerified.CorrectnessError) {
          expect(result.error.message).toContain("Found multiple matches")
        }
      }),
    )
  })

  describe("applyPatch", () => {
    it.live("should add a new file", () =>
      Effect.gen(function* () {
        const patchText = `*** Begin Patch
*** Add File: ${tempDir}/new-file.txt
+Hello World
+This is a new file
*** End Patch`

        const result = yield* Patch.applyPatch(patchText)
        expect(result.added).toHaveLength(1)
        expect(result.modified).toHaveLength(0)
        expect(result.deleted).toHaveLength(0)

        const content = yield* Effect.promise(() => fs.readFile(result.added[0], "utf-8"))
        expect(content).toBe("Hello World\nThis is a new file")
      }),
    )

    it.live("should delete an existing file", () =>
      Effect.gen(function* () {
        const filePath = path.join(tempDir, "to-delete.txt")
        yield* Effect.promise(() => fs.writeFile(filePath, "This file will be deleted"))

        const patchText = `*** Begin Patch
*** Delete File: ${filePath}
*** End Patch`

        const result = yield* Patch.applyPatch(patchText)
        expect(result.deleted).toHaveLength(1)
        expect(result.deleted[0]).toBe(filePath)

        const exists = yield* Effect.promise(() =>
          fs
            .access(filePath)
            .then(() => true)
            .catch(() => false),
        )
        expect(exists).toBe(false)
      }),
    )

    it.live("should update an existing file", () =>
      Effect.gen(function* () {
        const filePath = path.join(tempDir, "to-update.txt")
        yield* Effect.promise(() => fs.writeFile(filePath, "line 1\nline 2\nline 3\n"))

        const patchText = `*** Begin Patch
*** Update File: ${filePath}
@@
 line 1
-line 2
+line 2 updated
 line 3
*** End Patch`

        const result = yield* Patch.applyPatch(patchText)
        expect(result.modified).toHaveLength(1)
        expect(result.modified[0]).toBe(filePath)

        const content = yield* Effect.promise(() => fs.readFile(filePath, "utf-8"))
        expect(content).toBe("line 1\nline 2 updated\nline 3\n")
      }),
    )

    it.live("should move and update a file", () =>
      Effect.gen(function* () {
        const oldPath = path.join(tempDir, "old-name.txt")
        const newPath = path.join(tempDir, "new-name.txt")
        yield* Effect.promise(() => fs.writeFile(oldPath, "old content\n"))

        const patchText = `*** Begin Patch
*** Update File: ${oldPath}
*** Move to: ${newPath}
@@
-old content
+new content
*** End Patch`

        const result = yield* Patch.applyPatch(patchText)
        expect(result.modified).toHaveLength(1)
        expect(result.modified[0]).toBe(newPath)

        const oldExists = yield* Effect.promise(() =>
          fs
            .access(oldPath)
            .then(() => true)
            .catch(() => false),
        )
        expect(oldExists).toBe(false)

        const newContent = yield* Effect.promise(() => fs.readFile(newPath, "utf-8"))
        expect(newContent).toBe("new content\n")
      }),
    )

    it.live("should handle multiple operations in one patch", () =>
      Effect.gen(function* () {
        const file1 = path.join(tempDir, "file1.txt")
        const file2 = path.join(tempDir, "file2.txt")
        const file3 = path.join(tempDir, "file3.txt")

        yield* Effect.promise(() => fs.writeFile(file1, "content 1"))
        yield* Effect.promise(() => fs.writeFile(file2, "content 2"))

        const patchText = `*** Begin Patch
*** Add File: ${file3}
+new file content
*** Update File: ${file1}
@@
-content 1
+updated content 1
*** Delete File: ${file2}
*** End Patch`

        const result = yield* Patch.applyPatch(patchText)
        expect(result.added).toHaveLength(1)
        expect(result.modified).toHaveLength(1)
        expect(result.deleted).toHaveLength(1)
      }),
    )

    it.live("should create parent directories when adding files", () =>
      Effect.gen(function* () {
        const nestedPath = path.join(tempDir, "deep", "nested", "file.txt")

        const patchText = `*** Begin Patch
*** Add File: ${nestedPath}
+Deep nested content
*** End Patch`

        const result = yield* Patch.applyPatch(patchText)
        expect(result.added).toHaveLength(1)
        expect(result.added[0]).toBe(nestedPath)

        const exists = yield* Effect.promise(() =>
          fs
            .access(nestedPath)
            .then(() => true)
            .catch(() => false),
        )
        expect(exists).toBe(true)
      }),
    )
  })

  describe("error handling", () => {
    it.live("should fail when updating non-existent file", () =>
      Effect.gen(function* () {
        const nonExistent = path.join(tempDir, "does-not-exist.txt")

        const patchText = `*** Begin Patch
*** Update File: ${nonExistent}
@@
-old line
+new line
*** End Patch`

        const exit = yield* Effect.exit(Patch.applyPatch(patchText))
        expect(exit._tag).toBe("Failure")
      }),
    )

    it.live("should fail when deleting non-existent file", () =>
      Effect.gen(function* () {
        const nonExistent = path.join(tempDir, "does-not-exist.txt")

        const patchText = `*** Begin Patch
*** Delete File: ${nonExistent}
*** End Patch`

        const exit = yield* Effect.exit(Patch.applyPatch(patchText))
        expect(exit._tag).toBe("Failure")
      }),
    )
  })

  describe("edge cases", () => {
    it.live("should handle empty files", () =>
      Effect.gen(function* () {
        const emptyFile = path.join(tempDir, "empty.txt")
        yield* Effect.promise(() => fs.writeFile(emptyFile, ""))

        const patchText = `*** Begin Patch
*** Update File: ${emptyFile}
@@
+First line
*** End Patch`

        const result = yield* Patch.applyPatch(patchText)
        expect(result.modified).toHaveLength(1)

        const content = yield* Effect.promise(() => fs.readFile(emptyFile, "utf-8"))
        expect(content).toBe("First line\n")
      }),
    )

    it.live("should handle files with no trailing newline", () =>
      Effect.gen(function* () {
        const filePath = path.join(tempDir, "no-newline.txt")
        yield* Effect.promise(() => fs.writeFile(filePath, "no newline"))

        const patchText = `*** Begin Patch
*** Update File: ${filePath}
@@
-no newline
+has newline now
*** End Patch`

        const result = yield* Patch.applyPatch(patchText)
        expect(result.modified).toHaveLength(1)

        const content = yield* Effect.promise(() => fs.readFile(filePath, "utf-8"))
        expect(content).toBe("has newline now\n")
      }),
    )

    it.live("should handle multiple update chunks in single file", () =>
      Effect.gen(function* () {
        const filePath = path.join(tempDir, "multi-chunk.txt")
        yield* Effect.promise(() => fs.writeFile(filePath, "line 1\nline 2\nline 3\nline 4\n"))

        const patchText = `*** Begin Patch
*** Update File: ${filePath}
@@
 line 1
-line 2
+LINE 2
@@
 line 3
-line 4
+LINE 4
*** End Patch`

        const result = yield* Patch.applyPatch(patchText)
        expect(result.modified).toHaveLength(1)

        const content = yield* Effect.promise(() => fs.readFile(filePath, "utf-8"))
        expect(content).toBe("line 1\nLINE 2\nline 3\nLINE 4\n")
      }),
    )
  })
})
