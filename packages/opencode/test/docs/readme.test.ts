import { describe, expect, test } from "bun:test"

describe("README branch onboarding", () => {
  test("root readmes retain migration and branch notices before installation", async () => {
    for (const [file, warning, branch, install] of [
      ["README.md", "> **数据库迁移提示**", "> **关于本分支**", "## 快速安装"],
      ["README.en.md", "> **Database migration notice**", "> **About this branch**", "## Quick Install"],
    ]) {
      const content = await readReadme(file)
      const warningIndex = content.indexOf(warning)
      const branchIndex = content.indexOf(branch)
      const installIndex = content.indexOf(install)
      // 保留当前 README 的排版，仅验证安装前仍有迁移风险和分支身份提示。
      expect(warningIndex).toBeGreaterThanOrEqual(0)
      expect(branchIndex).toBeGreaterThanOrEqual(0)
      expect(installIndex).toBeGreaterThan(Math.max(warningIndex, branchIndex))
      expect(content.slice(warningIndex, installIndex)).toContain("opencode.db")
      expect(content.slice(branchIndex, installIndex)).toContain("1.19.17-smark")
    }
  })
})

async function readReadme(file: string) {
  // 测试文件位于 packages/opencode/test/docs；相对 repo root 读取可避免依赖当前 shell 的启动目录。
  return Bun.file(new URL(`../../../../${file}`, import.meta.url)).text()
}
