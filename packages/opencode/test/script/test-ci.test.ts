import { describe, expect, test } from "bun:test"
import { partitionTestFiles } from "../../script/test-ci"

describe("partitionTestFiles", () => {
  test("normalizes separators and assigns every test to one shard", () => {
    // 混合两种真实平台表示；expected 只使用仓库路径，不复制 normalization 实现。
    const files = [
      "test/account/repo.test.ts",
      "test\\cli\\tui\\dialog-select.test.tsx",
      "test/cli/cmd/tui/dialog-prompt.test.tsx",
      "test\\cli\\run\\footer.view.test.tsx",
      "test/cli/cmd/tui/session-list-params.test.ts",
    ]

    // 两个 literal 分组共同覆盖全部输入，使遗漏或重复分配都能直接令断言失败。
    expect(partitionTestFiles(files)).toEqual({
      core: ["test/account/repo.test.ts"],
      tui: [
        "test/cli/tui/dialog-select.test.tsx",
        "test/cli/cmd/tui/dialog-prompt.test.tsx",
        "test/cli/run/footer.view.test.tsx",
        "test/cli/cmd/tui/session-list-params.test.ts",
      ],
    })
  })
})
