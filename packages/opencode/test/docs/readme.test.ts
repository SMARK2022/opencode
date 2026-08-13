import { describe, expect, test } from "bun:test"

describe("README branch onboarding", () => {
  test("root readmes show migration and branch notices before the screenshot", async () => {
    for (const file of ["README.md", "README.en.md"]) {
      const content = await readReadme(file)
      const warning = content.indexOf("> [!WARNING]")
      const tip = content.indexOf("> [!TIP]", warning)
      const screenshot = content.indexOf("[![OpenCode Terminal UI]")
      // 根入口是用户首次接触迁移风险的位置，两个语种都必须在截图前依次展示风险与分支提示。
      expect(warning).toBeGreaterThan(content.indexOf("</p>", content.indexOf('href="README.md"')))
      expect(tip).toBeGreaterThan(warning)
      expect(screenshot).toBeGreaterThan(tip)
      // 分支身份仍沿用目标发布版本，不能随文案重排退回 source 的旧版本。
      expect(content.slice(tip, screenshot)).toContain("1.19.17-smark")
    }
  })
})

async function readReadme(file: string) {
  // 测试文件位于 packages/opencode/test/docs；相对 repo root 读取可避免依赖当前 shell 的启动目录。
  return Bun.file(new URL(`../../../../${file}`, import.meta.url)).text()
}
