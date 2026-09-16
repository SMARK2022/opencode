import { describe, expect, test } from "bun:test"
import { partitionTestFiles } from "../../script/test-ci"

describe("partitionTestFiles", () => {
  test("normalizes separators and assigns every test to one shard", async () => {
    // 混合两种真实平台表示；expected 只使用仓库路径，不复制 normalization 实现。
    const files = [
      "test/account/repo.test.ts",
      "test\\cli\\tui\\dialog-select.test.tsx",
      "test/cli/cmd/tui/dialog-prompt.test.tsx",
      "test\\cli\\run\\footer.view.test.tsx",
      "test/cli/cmd/tui/session-list-params.test.ts",
      "test\\session\\prompt.test.ts",
      "test/server/tui-provider-endpoint-status.test.ts",
      "test/cli/db-maintenance.test.ts",
      "test/tool/shell.test.ts",
      "test/future/new.test.ts",
    ]

    // TUI 必须优先于 cli 目录分组；未知目录自动归入 runtime，避免新增测试被漏掉。
    expect(partitionTestFiles(files)).toEqual({
      integration: [
        "test/session/prompt.test.ts",
        "test/server/tui-provider-endpoint-status.test.ts",
        "test/cli/db-maintenance.test.ts",
      ],
      runtime: ["test/account/repo.test.ts", "test/tool/shell.test.ts", "test/future/new.test.ts"],
      tui: [
        "test/cli/tui/dialog-select.test.tsx",
        "test/cli/cmd/tui/dialog-prompt.test.tsx",
        "test/cli/run/footer.view.test.tsx",
        "test/cli/cmd/tui/session-list-params.test.ts",
      ],
    })
    // 同时检查真实发现集：三个分片必须非空，且每个文件恰好出现一次。
    const discovered = await Array.fromAsync(
      new Bun.Glob("test/**/*.test.{ts,tsx}").scan({ cwd: `${import.meta.dir}/../..`, onlyFiles: true }),
    )
    const shards = Object.values(partitionTestFiles(discovered))
    expect(shards.every((files) => files.length > 0)).toBe(true)
    expect(shards.flat().sort()).toEqual(discovered.map((file) => file.replaceAll("\\", "/")).sort())
    expect(new Set(shards.flat()).size).toBe(discovered.length)
    // 拼写错误必须在启动测试与清理报告前失败，不能静默退回全量执行。
    const invalid = Bun.spawn([process.execPath, `${import.meta.dir}/../../script/test-ci.ts`], {
      env: { ...process.env, OPENCODE_TEST_SHARD: "invalid" },
      stdout: "ignore",
      stderr: "pipe",
    })
    const error = await new Response(invalid.stderr).text()
    expect(await invalid.exited).toBe(1)
    expect(error).toContain("OPENCODE_TEST_SHARD must be integration, runtime, or tui")
  })
})
