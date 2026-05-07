// #108：revert-diff 路径分隔在 Windows 下行为不同
import { describe, expect, test } from "bun:test"
import { createTwoFilesPatch } from "diff"
import { getRevertDiffFiles } from "../../src/util/revert-diff"

describe("revert diff", () => {
  test.skipIf(process.platform === "win32")("prefers the actual file path over /dev/null for added and deleted files", () => {
    const files = getRevertDiffFiles(`diff --git a/new.txt b/new.txt
new file mode 100644
index 0000000..3b18e51
--- /dev/null
+++ b/new.txt
@@ -0,0 +1,2 @@
+new content
+++counter
diff --git a/old.txt b/old.txt
deleted file mode 100644
index 3b18e51..0000000
--- a/old.txt
+++ /dev/null
@@ -1,2 +0,0 @@
-old content
---counter
`)

    expect(files).toEqual([
      {
        filename: "new.txt",
        additions: 2,
        deletions: 0,
      },
      {
        filename: "old.txt",
        additions: 0,
        deletions: 2,
      },
    ])
  })

  test("counts header-like content in producer-generated diffs", () => {
    // 使用工具相同的 producer，验证文件头之外的三符号前缀仍是内容。
    const files = getRevertDiffFiles(
      createTwoFilesPatch("counter.ts", "counter.ts", "--counter\n--- heading\nold\n", "++counter\n+++ heading\nnew\n"),
    )
    expect(files).toEqual([{ filename: "counter.ts", additions: 3, deletions: 3 }])
  })
})
