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

    // trailing-empty 缩短仍不是完整字面/ fuzzy whole-line 成功域：无终止符的 foo 不能匹配 ["foo",""]。
    // 空白与 Unicode whole-line fuzzy 由独立正向用例锁定，这里只保留仍应失败的 shortened 形状。
    test("rejects shortened trailing-empty old blocks", () => {
      expect(() =>
        Patch.deriveNewContentsFromChunks(
          "trailing empty line",
          [{ old_lines: ["foo", ""], new_lines: ["changed"] }],
          "foo",
        ),
      ).toThrow("Failed to find expected lines")
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
    // 同行多个唯一 substring 按位置统一应用；顺序与乱序由其它用例分别锁定。
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

    // 多 chunk 对原始文件独立定位后按位置统一应用；patch 内顺序可以晚于文件顺序。
    // 这锁住 Session 里 “先改后面再改前面” 仍应一次成功的用户症状，而不是拆多次 tool 调用。
    test("applies unique out-of-order whole-line chunks against the original file", () => {
      const result = Patch.deriveNewContentsFromChunks(
        "multi.txt",
        [
          { old_lines: ["e"], new_lines: ["E"] },
          { old_lines: ["b"], new_lines: ["B"] },
        ],
        "a\nb\nc\nd\ne\nf\n",
      )

      expect(result.content).toBe("a\nB\nc\nd\nE\nf\n")
    })

    // 每个 @@ context 都只约束自己的 chunk；后方 context 不能推进共享 cursor 并屏蔽前方目标。
    // 固定最终文本同时证明 context 行未被替换，两个 old block 也没有按 patch 顺序增量消费。
    test("applies out-of-order chunks with independent change contexts", () => {
      const result = Patch.deriveNewContentsFromChunks(
        "context-order.txt",
        [
          { change_context: "section-b", old_lines: ["last"], new_lines: ["LAST"] },
          { change_context: "section-a", old_lines: ["first"], new_lines: ["FIRST"] },
        ],
        "section-a\nfirst\ngap\nsection-b\nlast\n",
      )

      expect(result.content).toBe("section-a\nFIRST\ngap\nsection-b\nLAST\n")
    })

    // 同行两个唯一 substring 即使在 patch 中颠倒顺序，也必须落到同一最终字面结果。
    test("applies unique out-of-order substring chunks on the same line", () => {
      const result = Patch.deriveNewContentsFromChunks(
        "fixture.txt",
        [
          { old_lines: ["JKL"], new_lines: ["Y"] },
          { old_lines: ["DEF"], new_lines: ["X"] },
        ],
        "abcDEFghiJKL",
      )

      expect(result.content).toBe("abcXghiY\n")
    })

    // 整行命中也必须全局唯一；取第一处会掩盖模型漏掉的重复结构。
    test("rejects ambiguous whole-line matches", () => {
      expect(() =>
        Patch.deriveNewContentsFromChunks(
          "fixture.txt",
          [{ old_lines: ["dup"], new_lines: ["fixed"] }],
          "dup\nother\ndup\n",
        ),
      ).toThrow("Found multiple matches")
    })

    // exact whole-line 是优先候选层；另一更长行内的同 literal 只属于低层 substring，不能造成旧成功域退化。
    // 固定结果同时证明外围行未被修改，Session 中 outer/inner while 的缩进形状不会再被误判。
    test("preserves a unique exact whole-line match when the literal is nested elsewhere", () => {
      const result = Patch.deriveNewContentsFromChunks(
        "nested-literal.txt",
        [{ old_lines: ["  target"], new_lines: ["fixed"] }],
        "prefix  target suffix\n  target\n",
      )

      expect(result.content).toBe("prefix  target suffix\nfixed\n")
    })

    // 两个 chunk 指向同一原文 span 时必须失败且不产生部分成功内容。
    // 明确断言 overlap 文案，避免实现退回偶然的 cursor unavailable 或任取一个 replacement。
    test("rejects overlapping replacements for the same original span", () => {
      expect(() =>
        Patch.deriveNewContentsFromChunks(
          "fixture.txt",
          [
            { old_lines: ["alpha"], new_lines: ["consumed"] },
            { old_lines: ["alpha"], new_lines: ["wrong"] },
          ],
          "alpha\nomega\n",
        ),
      ).toThrow("Overlapping expected lines")
    })

    // PI normalize 只移除行尾空白，并覆盖 NFKC、特殊空格与常见标点；不得忽略前导缩进。
    // 固定字面矩阵防止实现只覆盖其中一种转换却声称与 PI 对齐。
    test("accepts PI-normalized whole-line matches after exact failure", () => {
      expect(
        Patch.deriveNewContentsFromChunks(
          "trailing.txt",
          [{ old_lines: ["value "], new_lines: ["changed"] }],
          "value\t\n",
        ).content,
      ).toBe("changed\n")
      expect(
        Patch.deriveNewContentsFromChunks(
          "unicode.txt",
          [{ old_lines: ['He said "hello"'], new_lines: ["ok"] }],
          "He said “hello”\n",
        ).content,
      ).toBe("ok\n")
      expect(
        Patch.deriveNewContentsFromChunks(
          "nfkc.txt",
          [{ old_lines: ["Hello"], new_lines: ["ok"] }],
          "Ｈｅｌｌｏ\n",
        ).content,
      ).toBe("ok\n")
      expect(
        Patch.deriveNewContentsFromChunks(
          "space.txt",
          [{ old_lines: ["alpha beta"], new_lines: ["ok"] }],
          "alpha\u00a0beta\n",
        ).content,
      ).toBe("ok\n")
      expect(() =>
        Patch.deriveNewContentsFromChunks(
          "leading.txt",
          [{ old_lines: ["  value"], new_lines: ["changed"] }],
          "\tvalue\n",
        ),
      ).toThrow("Failed to find expected lines")
      expect(
        Patch.deriveNewContentsFromChunks(
          "substring-first.txt",
          [{ old_lines: ["value"], new_lines: ["changed"] }],
          "value\t\n",
        ).content,
      ).toBe("changed\t\n")
    })

    // normalized proper substring 必须回到 original 连续 span；PI 等价引号只改变候选，不拥有行内前后缀。
    // 断言保留 prefix/suffix，防止实现复制 PI 的 touched-line normalized writeback 而污染未提交字节。
    test("preserves surrounding text for a unique normalized proper substring", () => {
      const result = Patch.deriveNewContentsFromChunks(
        "normalized-substring.txt",
        [{ old_lines: ['He said "hello"'], new_lines: ["fixed"] }],
        "prefix He said “hello” suffix\n",
      )

      expect(result.content).toBe("prefix fixed suffix\n")
    })

    // normalized start/end 只能落在 raw grapheme boundary；组合字符与完整 compatibility expansion 都应拥有完整原文。
    // 这些固定结果会击穿按 normalized UTF-16 offset 直接切 raw text 的错误实现。
    // 完整 ligature 可映射而半个 expansion 不可映射，区分“可连续拥有”与“看起来相似”。
    test("maps normalized proper substrings to complete raw grapheme spans", () => {
      expect(
        Patch.deriveNewContentsFromChunks(
          "decomposed.txt",
          [{ old_lines: ["Å"], new_lines: ["X"] }],
          "prefix A\u030A tail\n",
        ).content,
      ).toBe("prefix X tail\n")
      expect(
        Patch.deriveNewContentsFromChunks(
          "ligature.txt",
          [{ old_lines: ["ffi"], new_lines: ["X"] }],
          "prefix ﬃ tail\n",
        ).content,
      ).toBe("prefix X tail\n")
      expect(() =>
        Patch.deriveNewContentsFromChunks(
          "partial-expansion.txt",
          [{ old_lines: ["f"], new_lines: ["X"] }],
          "lead ﬁ tail\n",
        ),
      ).toThrow("Failed to find expected lines")
    })

    // 无法映回 raw boundary 的 normalized occurrence 仍参与全局唯一性；不能忽略它后误写另一处 exact span。
    // 该候选虽不能写回，但仍证明模型 old block 在 normalized 域并不唯一。
    test("rejects a safe match when another normalized occurrence cuts a grapheme expansion", () => {
      expect(() =>
        Patch.deriveNewContentsFromChunks(
          "mixed-boundary.txt",
          [{ old_lines: ["f"], new_lines: ["X"] }],
          "f and ﬁ\n",
        ),
      ).toThrow("Found multiple matches")
    })

    // normalized proper substring 仍遵守完整 old block 的全局唯一性，并能跨无 trim gap 的换行映回连续 raw span。
    // multiline 固定结果证明首行前缀与末行后缀都不属于 normalized replacement ownership。
    test("enforces uniqueness and multiline boundaries for normalized substrings", () => {
      expect(() =>
        Patch.deriveNewContentsFromChunks(
          "normalized-duplicates.txt",
          [{ old_lines: ['"hello"'], new_lines: ["fixed"] }],
          "first “hello” then “hello”\n",
        ),
      ).toThrow("Found multiple matches")
      expect(
        Patch.deriveNewContentsFromChunks(
          "normalized-multiline.txt",
          [{ old_lines: ['"alpha', 'beta"'], new_lines: ["one", "two"] }],
          "before “alpha\nbeta” after\n",
        ).content,
      ).toBe("before one\ntwo after\n")
    })

    // 一个 exact 行与另一个 PI-normalized 等价行属于两个候选，exact 不能绕过全局唯一性。
    // 两者同属 whole-line active tier，因此不能借 lower-tier 规则选中 ASCII 第一处。
    test("rejects exact matches with another normalized-equivalent candidate", () => {
      expect(() =>
        Patch.deriveNewContentsFromChunks(
          "normalized-ambiguous.txt",
          [{ old_lines: ['He said "hello"'], new_lines: ["ok"] }],
          'He said "hello"\nHe said “hello”\n',
        ),
      ).toThrow("Found multiple matches")
    })

    // context 保留 first eligible 整行契约；重复 context 不应继承 old-block 的全局唯一拒绝。
    // context 只缩小当前 old block 的搜索域，本身不是 replacement candidate。
    test("preserves repeated whole-line context when the old block is unique", () => {
      const result = Patch.deriveNewContentsFromChunks(
        "context.txt",
        [{ change_context: "section", old_lines: ["target"], new_lines: ["fixed"] }],
        "section\nx\nsection\ntarget\n",
      )

      expect(result.content).toBe("section\nx\nsection\nfixed\n")
    })

    // EOF 只能在全局唯一已证明后影响定位；末尾候选不能掩盖文件前方的第二个完整候选。
    // anchor 表达位置偏好而非歧义选择器，否则同一 old block 会因标记存在而静默猜测。
    test("rejects ambiguous complete blocks even when one occurrence is at EOF", () => {
      expect(() =>
        Patch.deriveNewContentsFromChunks(
          "eof.txt",
          [{ old_lines: ["marker"], new_lines: ["fixed"], is_end_of_file: true }],
          "marker\nother\nmarker\n",
        ),
      ).toThrow("Found multiple matches")
    })

    // fuzzy 不得抢在 exact 字面子串之前，否则会吞掉调用方未提交的行内空格。
    test("prefers exact substring over fuzzy whole-line when both could apply", () => {
      const result = Patch.deriveNewContentsFromChunks(
        "fixture.txt",
        [{ old_lines: ["CDEFG"], new_lines: ["fixed"] }],
        "  CDEFG  \n",
      )

      expect(result.content).toBe("  fixed  \n")
    })

    // 全部对 original 定位，因此后续 chunk 不能消费前序生成文本。
    // 失败发生在统一 apply 前，保证第一块成功定位也不会泄漏成部分文件结果。
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

    // 空行替换同样不得让第二 chunk 命中生成的空逻辑行。
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
    // 这些位置共同锁住半开 span 对换行分隔符的 ownership，避免 reverse slice 留双换行。
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
    // 空文件与非空文件共享同一数组追加契约，最终终止换行仍由 derive owner 统一补齐。
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

    // verified preview 必须把同一 canonical source 的 repeated entries 合成一个完整 new_content。
    // 后一个 Map.set 覆盖前一个完整文件结果会静默丢失修改，因此这里直接断言两个独立结果。
    // 单一 change key 与双修改内容一起证明 grouping 同时解决 identity 和 overwrite 两类分叉。
    it.live("combines repeated update entries against one original file", () =>
      Effect.gen(function* () {
        const filePath = path.join(tempDir, "verified-repeated.txt")
        yield* Effect.promise(() => fs.writeFile(filePath, "alpha\nmiddle\nomega\n"))
        const patchText = "*** Begin Patch\n*** Update File: verified-repeated.txt\n@@\n-omega\n+OMEGA\n*** Update File: verified-repeated.txt\n@@\n-alpha\n+ALPHA\n*** End Patch"

        const result = yield* Patch.maybeParseApplyPatchVerified(["apply_patch", patchText], tempDir)

        expect(result.type).toBe(Patch.MaybeApplyPatchVerified.Body)
        if (result.type === Patch.MaybeApplyPatchVerified.Body) {
          expect(result.action.changes).toHaveLength(1)
          const change = result.action.changes.get(filePath)
          expect(change?.type).toBe("update")
          if (change?.type === "update") expect(change.new_content).toBe("ALPHA\nmiddle\nOMEGA\n")
        }
      }),
    )

    // verified 只返回校验结果但仍须执行 original-only：entry2 依赖生成文本时必须是 CorrectnessError。
    // 此 seam 不写盘，故错误类型而非文件副作用是 consumer parity 的直接可观察结果。
    // CorrectnessError 还证明 preview 没有用前一 entry 的 new_content 合成第二次成功定位。
    it.live("rejects generated-text dependencies across repeated entries in verified preview", () =>
      Effect.gen(function* () {
        const filePath = path.join(tempDir, "verified-generated.txt")
        yield* Effect.promise(() => fs.writeFile(filePath, "alpha\nomega\n"))
        const patchText = "*** Begin Patch\n*** Update File: verified-generated.txt\n@@\n-alpha\n+generated\n*** Update File: verified-generated.txt\n@@\n-generated\n+wrong\n*** End Patch"

        const result = yield* Patch.maybeParseApplyPatchVerified(["apply_patch", patchText], tempDir)

        expect(result.type).toBe(Patch.MaybeApplyPatchVerified.CorrectnessError)
        if (result.type === Patch.MaybeApplyPatchVerified.CorrectnessError) {
          expect(result.error.message).toContain("Failed to find expected lines")
        }
      }),
    )

    // canonical identity 而非 lexical path 决定 proposal；symlink alias 不能生成第二个 full-file change。
    // changes 长度锁住 identity 聚合，固定 new_content 锁住两个 entry 均未被 Map 覆盖丢失。
    // realpath 归并必须发生在读取与 changes.set 前，事后合并两个完整结果无法恢复丢失的修改。
    it.live("combines canonical-equivalent source aliases in verified preview", () =>
      Effect.gen(function* () {
        const realDir = path.join(tempDir, "verified-real")
        const aliasDir = path.join(tempDir, "verified-alias")
        yield* Effect.promise(() => fs.mkdir(realDir))
        yield* Effect.promise(() => fs.symlink(realDir, aliasDir))
        const filePath = path.join(realDir, "source.txt")
        yield* Effect.promise(() => fs.writeFile(filePath, "alpha\nmiddle\nomega\n"))
        const patchText = "*** Begin Patch\n*** Update File: verified-real/source.txt\n@@\n-omega\n+OMEGA\n*** Update File: verified-alias/source.txt\n@@\n-alpha\n+ALPHA\n*** End Patch"

        const result = yield* Patch.maybeParseApplyPatchVerified(["apply_patch", patchText], tempDir)

        expect(result.type).toBe(Patch.MaybeApplyPatchVerified.Body)
        if (result.type === Patch.MaybeApplyPatchVerified.Body) {
          expect(result.action.changes).toHaveLength(1)
          const change = result.action.changes.get(filePath)
          expect(change?.type).toBe("update")
          if (change?.type === "update") expect(change.new_content).toBe("ALPHA\nmiddle\nOMEGA\n")
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

    // direct consumer 先聚合同 source entries，再一次对 original 派生；文件顺序不再成为成功门闸。
    // modified 只出现一次也证明 direct apply 没有恢复逐 entry 写盘和重读的旧路径。
    // 固定最终文件同时验证 reverse apply 使用 original offsets，而非按 entry 顺序修正位置。
    it.live("applies repeated update entries out of file order", () =>
      Effect.gen(function* () {
        const filePath = path.join(tempDir, "direct-repeated.txt")
        yield* Effect.promise(() => fs.writeFile(filePath, "alpha\nmiddle\nomega\n"))
        const patchText = `*** Begin Patch\n*** Update File: ${filePath}\n@@\n-omega\n+OMEGA\n*** Update File: ${filePath}\n@@\n-alpha\n+ALPHA\n*** End Patch`

        const result = yield* Patch.applyPatch(patchText)

        expect(result.modified).toEqual([filePath])
        expect(yield* Effect.promise(() => fs.readFile(filePath, "utf-8"))).toBe("ALPHA\nmiddle\nOMEGA\n")
      }),
    )

    // direct Patch consumer 与 Tool/verified 共用 original-only proposal；entry2 不得消费 entry1 生成文本。
    // 文件未变断言把 locate failure 与 direct filesystem atomicity 绑定在同一公开 seam。
    it.live("rejects generated-text dependencies across repeated update entries", () =>
      Effect.gen(function* () {
        const filePath = path.join(tempDir, "direct-generated.txt")
        yield* Effect.promise(() => fs.writeFile(filePath, "alpha\nomega\n"))
        const patchText = `*** Begin Patch
*** Update File: ${filePath}
@@
-alpha
+generated
*** Update File: ${filePath}
@@
-generated
+wrong
*** End Patch`

        const exit = yield* Effect.exit(Patch.applyPatch(patchText))

        expect(exit._tag).toBe("Failure")
        expect(yield* Effect.promise(() => fs.readFile(filePath, "utf-8"))).toBe("alpha\nomega\n")
      }),
    )

    // direct consumer 也必须按 realpath 聚合同一物理 source，不能让 symlink 拼写绕过 original-only。
    // 文件保持原文证明失败发生在统一 derive 之前，第一 entry 没有先通过 alias 写盘。
    // alias entry 若被当成第二文件会错误消费 generated；该测试因此对 canonical grouping 敏感。
    it.live("rejects generated-text dependencies through a source alias", () =>
      Effect.gen(function* () {
        const realDir = path.join(tempDir, "direct-real")
        const aliasDir = path.join(tempDir, "direct-alias")
        yield* Effect.promise(() => fs.mkdir(realDir))
        yield* Effect.promise(() => fs.symlink(realDir, aliasDir))
        const filePath = path.join(realDir, "source.txt")
        yield* Effect.promise(() => fs.writeFile(filePath, "alpha\nomega\n"))
        const patchText = `*** Begin Patch
*** Update File: ${filePath}
@@
-alpha
+generated
*** Update File: ${path.join(aliasDir, "source.txt")}
@@
-generated
+wrong
*** End Patch`

        const exit = yield* Effect.exit(Patch.applyPatch(patchText))

        expect(exit._tag).toBe("Failure")
        expect(yield* Effect.promise(() => fs.readFile(filePath, "utf-8"))).toBe("alpha\nomega\n")
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
