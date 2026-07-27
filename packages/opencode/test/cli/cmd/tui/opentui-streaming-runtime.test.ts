import { describe, expect, test } from "bun:test"
import { CodeRenderable, SyntaxStyle } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"

describe("installed OpenTUI streaming runtime", () => {
  test("keeps Markdown tables, fences, formulas, and callbacks coherent across deltas", async () => {
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
      syntaxStyle: SyntaxStyle.fromTheme([]),
      conceal: false,
      drawUnstyledText: false,
      streaming: true,
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
        await setup.renderOnce()
        await code.highlightingDone
        await setup.renderOnce()
      }

      expect(code.plainText).toBe(content)
      expect(callbackText.join("")).toContain("| name | value |")
      expect(callbackText.join("")).toContain("const value = 1")
      expect(callbackText.join("")).toContain("$$x\n+y$$")
    } finally {
      setup.renderer.destroy()
    }
  })
})
