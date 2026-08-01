import { describe, expect, test } from "bun:test"
import { CodeRenderable, SyntaxStyle } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"

// 核对真实消费版本，防止派生安装的旧链接冒充catalog中的新发布包。
describe("installed OpenTUI streaming runtime", () => {
  test("keeps Markdown tables, fences, formulas, and callbacks coherent across deltas", async () => {
    const manifest = await Bun.file(new URL("../../../../../../package.json", import.meta.url)).json()
    const installed = await Bun.file(new URL("./package.json", import.meta.resolve("@opentui/core"))).json()
    expect(installed.version).toBe(manifest.workspaces.catalog["@opentui/core"])
    // 渲染器禁用控制台/独立线程：测试只关心 highlight 管线本身，不引入终端副作用。
    const setup = await createTestRenderer({
      width: 100,
      height: 20,
      footerHeight: 0,
      useThread: false,
      consoleMode: "disabled",
    })
    const callbackText: string[] = []
    const code = new CodeRenderable(setup.renderer, {
      id: "installed-streaming-code",
      filetype: "markdown",
      // 空主题 + 不画无样式文本：排除着色层干扰，断言只锁定 streaming 分块语义。
      syntaxStyle: SyntaxStyle.fromTheme([]),
      conceal: false,
      drawUnstyledText: false,
      // streaming 是本断言的核心前置：增量解析不得把每个 delta 当独立文档重解析。
      streaming: true,
      // onChunks 必须原样返回 chunks——收集副本的同时不得改变渲染管线输入。
      onChunks: (chunks) => {
        callbackText.push(chunks.map((chunk) => chunk.text).join(""))
        return chunks
      },
    })
    setup.renderer.root.add(code)
    try {
      let content = ""
      // 每个delta都故意停在未闭合结构内，验证真实安装包不会把片段当作独立Markdown文档。
      for (const delta of [
        "| name | value |\n| --- | --- |\n| first |",
        " second |\n\n```typescript\nconst value = 1\n",
        "```\n\n$$x\n+y$$",
      ]) {
        content += delta
        code.content = content
        // renderOnce/highlightingDone/renderOnce 的顺序锁定增量高亮完成边界：先提交帧、等解析、再取终帧。
        await setup.renderOnce()
        await code.highlightingDone
        await setup.renderOnce()
      }
      // plainText 必须与累积内容逐字相等——任何分块丢失/重复都会在这里暴露。
      expect(code.plainText).toBe(content)
      expect(callbackText.join("")).toContain("| name | value |")
      expect(callbackText.join("")).toContain("const value = 1")
      // 公式块断言含换行——验证 chunk 切分不吞结构内的空白边界。
      expect(callbackText.join("")).toContain("$$x\n+y$$")
    } finally {
      // destroy 是测试自己的清理责任：highlight 线程不随断言失败泄漏。
      setup.renderer.destroy()
    }
  })
})
