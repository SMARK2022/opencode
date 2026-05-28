import { describe, expect, test } from "bun:test"
import { parseApplyPatchFiles } from "../../../src/routes/session"


// #248：本文件避开 CRLF 既有测试宿主，独立锁定 legacy delete 的解析放宽行为
describe("apply patch files parsing", () => {
  test("keeps legacy delete entries without patch data", () => {
    // #248：删除条目允许缺 patch（legacy V1 数据）仍保留，渲染层按 !!file.patch
    // 回落 -N lines 摘要；其他类型缺 patch 依旧丢弃——空 diff 块没有渲染价值
    expect(
      parseApplyPatchFiles([
        { type: "delete", relativePath: "stale.ts", filePath: "src/stale.ts", deletions: 5 },
        {
          type: "delete",
          relativePath: "gone.ts",
          filePath: "src/gone.ts",
          patch: "--- a/src/gone.ts\\n+++ b/src/gone.ts\\n@@ -1 +1 @@\\n-old\\n",
          deletions: 1,
        },
        { type: "add", relativePath: "new.ts", filePath: "src/new.ts", deletions: 0 },
      ]),
    ).toEqual([
      { type: "delete", relativePath: "stale.ts", filePath: "src/stale.ts", patch: "", deletions: 5, movePath: undefined },
      {
        type: "delete",
        relativePath: "gone.ts",
        filePath: "src/gone.ts",
        patch: "--- a/src/gone.ts\\n+++ b/src/gone.ts\\n@@ -1 +1 @@\\n-old\\n",
        deletions: 1,
        movePath: undefined,
      },
    ])
  })
})
