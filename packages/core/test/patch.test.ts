import { describe, expect, test } from "bun:test"
import { Patch } from "@opencode-ai/core/patch"

describe("Patch", () => {
  test("parses add, update, and delete hunks", () => {
    expect(
      Patch.parse(
        "*** Begin Patch\n*** Add File: add.txt\n+added\n*** Update File: update.txt\n@@ section\n-old\n+new\n*** Delete File: delete.txt\n*** End Patch",
      ),
    ).toEqual([
      { type: "add", path: "add.txt", contents: "added" },
      {
        type: "update",
        path: "update.txt",
        chunks: [{ oldLines: ["old"], newLines: ["new"], changeContext: "section", endOfFile: undefined }],
        movePath: undefined,
      },
      { type: "delete", path: "delete.txt" },
    ])
  })

  test("strips a heredoc wrapper", () => {
    expect(Patch.parse("cat <<'EOF'\n*** Begin Patch\n*** Add File: add.txt\n+added\n*** End Patch\nEOF")).toEqual([
      { type: "add", path: "add.txt", contents: "added" },
    ])
  })

  test("derives exact line updates while preserving BOM", () => {
    const update = Patch.derive("update.txt", [{ oldLines: ["old"], newLines: ["new"] }], "\uFEFFold\n")
    expect(update).toEqual({ content: "new\n", bom: true })
    expect(Patch.joinBom(update.content, update.bom)).toBe("\uFEFFnew\n")
    // source明确移除规范化成功，BOM断言仍保留，不能靠fuzzy路径验证它。
    expect(() => Patch.derive("update.txt", [{ oldLines: ["  old   "], newLines: ["new"] }], "old\n")).toThrow("Failed to find expected lines")
    // 同时验证补丁解析、上下文匹配、BOM 与精确行尾，不能只归一后比较正文。
    for (const ending of ["\n", "\r\n", "\r"]) {
      const hunk = Patch.parse(["*** Begin Patch", "*** Update File: update.txt", "@@", " one", "-two", "+changed", " three", "*** End Patch"].join(ending))[0]
      if (hunk?.type !== "update") throw new Error("Expected update hunk")
      const derived = Patch.derive(hunk.path, hunk.chunks, `\uFEFF${["one", "two", "three", ""].join(ending)}`)
      expect(derived).toEqual({ content: ["one", "changed", "three", ""].join(ending), bom: true })
      expect(Patch.joinBom(derived.content, derived.bom)).toBe(`\uFEFF${["one", "changed", "three", ""].join(ending)}`)
    }
    // 文件级检测沿用 CRLF 优先级；混合输入不承诺逐分隔符保留。
    expect(Patch.derive("mixed.txt", [{ oldLines: ["two"], newLines: ["changed"] }], "one\r\ntwo\rthree\n").content).toBe("one\r\nchanged\r\nthree\r\n")
    expect(Patch.derive("no-eol.txt", [{ oldLines: ["one"], newLines: ["two"] }], "one").content).toBe("two\n")
    expect(Patch.parse("*** Begin Patch\r*** Add File: add.txt\r+one\r+two\r*** End Patch")).toEqual([{ type: "add", path: "add.txt", contents: "one\ntwo" }])
    expect(Patch.derive("empty.txt", [{ oldLines: [], newLines: ["one"] }], "").content).toBe("one\n")
  })

  test("preserves complete unique substring semantics and failed chunk diagnostics", () => {
    const derive = (content: string, chunks: ReadonlyArray<Patch.UpdateFileChunk>) => Patch.derive("file.txt", chunks, content).content
    // 原生owner沿相同字符cursor组合行内chunk，且所有原行尾均原样写回。
    for (const ending of ["\n", "\r\n", "\r"]) {
      expect(derive(`abcdef${ending}`, [{ oldLines: ["bc"], newLines: ["BC"] }, { oldLines: ["ef"], newLines: ["EF"] }])).toBe(`aBCdEF${ending}`)
    }
    expect(() => derive("prefix old old suffix\n", [{ oldLines: ["old"], newLines: ["new"] }])).toThrow("multiple matches")
    expect(() => derive("aaaa\n", [{ oldLines: ["aa"], newLines: ["x"] }])).toThrow("multiple matches")
    // 完整trailing-empty参与字面匹配，不能删除末空行来伪造命中。
    expect(derive("prefix target\n", [{ oldLines: ["target", ""], newLines: ["changed"] }])).toBe("prefix changed\n")
    expect(() => derive("prefix target", [{ oldLines: ["target", ""], newLines: ["changed"] }])).toThrow("Failed to find expected lines")
    expect(() => derive("anchor\n", [{ oldLines: [], newLines: ["x"], changeContext: "missing" }])).toThrow("Failed to find context")
    expect(derive("old\n", [{ oldLines: [], newLines: ["inserted"] }, { oldLines: ["old"], newLines: [] }])).toBe("inserted\n")
    // 提示只取失败chunk的磁盘候选，不能显示第一chunk已丢弃的replacement。
    expect(() => derive("alpha\nconst after = good()\n", [{ oldLines: ["alpha"], newLines: ["ALPHA"] }, { oldLines: ["const after = good(1)"], newLines: ["done"] }])).toThrow("Closest match at line 2:\nconst after = good()")
    expect(() => derive("“old”\n", [{ oldLines: ['"old"'], newLines: ["new"] }])).toThrow("Failed to find expected lines")
  })

  test("matches EOF-anchored chunks from the end", () => {
    expect(
      Patch.derive(
        "update.txt",
        [{ oldLines: ["marker", "end"], newLines: ["marker changed", "end"], endOfFile: true }],
        "marker\nmiddle\nmarker\nend\n",
      ).content,
    ).toBe("marker\nmiddle\nmarker changed\nend\n")
  })

  test("parses the EOF marker inside update chunks", () => {
    expect(
      Patch.parse("*** Begin Patch\n*** Update File: update.txt\n@@\n-last\n+end\n*** End of File\n*** End Patch"),
    ).toEqual([
      {
        type: "update",
        path: "update.txt",
        movePath: undefined,
        chunks: [{ oldLines: ["last"], newLines: ["end"], changeContext: undefined, endOfFile: true }],
      },
    ])
  })

  test("rejects malformed hunk bodies", () => {
    expect(() => Patch.parse("*** Begin Patch\n*** Add File: add.txt\nmissing plus\n*** End Patch")).toThrow(
      "Invalid add file line",
    )
    expect(() => Patch.parse("*** Begin Patch\n*** Update File: update.txt\n*** End Patch")).toThrow(
      "expected at least one @@ chunk",
    )
    expect(() => Patch.parse("*** Begin Patch\n*** Delete File: delete.txt\nunexpected body\n*** End Patch")).toThrow(
      "Invalid patch line",
    )
  })
})
