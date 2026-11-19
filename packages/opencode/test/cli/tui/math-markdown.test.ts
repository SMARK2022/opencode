import { describe, expect, test } from "bun:test"
import { createMarkdownLexer } from "@opentui/core"
import { makeMathExtensions } from "../../../src/cli/cmd/tui/util/math-markdown"

// 测试和组件使用同一个 bundled lexer，独立 Marked 实例可能掩盖实际的正文合并行为。
function makeMathLexer(render: (formula: string) => string | undefined) {
  return createMarkdownLexer(makeMathExtensions(render))
}
const lexer = makeMathLexer((source) => (source === "x^2" ? "x²" : undefined))

describe("math markdown lexer", () => {
  // 输入故意不在中文与美元之间留空格，约束自然中文段落中的闭合边界。
  // 同时断言raw与显示text，避免只得到正确字形却丢掉后续文字。
  test("renders inline formulas adjacent to Chinese and preserves raw source", () => {
    const block = lexer("公式$x^2$结束")[0]
    expect(block).toMatchObject({
      type: "paragraph",
      tokens: [
        { type: "text", text: "公式" },
        { type: "opencode_math_inline", raw: "$x^2$", text: "x²", math: true },
        { type: "text", text: "结束" },
      ],
    })
  })

  // 两种显示定界符都应交给块渲染，固定token形状验证它们共用入口。
  test.each(["$$\nx^2\n$$", "\\[x^2\\]"])("routes display %s to latex code", (source) => {
    expect(lexer(source)[0]).toMatchObject({ type: "code", raw: source, text: "x^2", lang: "latex", math: true })
  })

  // 环境名称与对齐符属于公式引擎的输入，lexer应把整个环境原样交下去。
  test("preserves display environments", () => {
    const source = "\\begin{align}x&=1\\\\y&=2\\end{align}"
    expect(lexer(source)[0]).toMatchObject({ type: "code", text: source, lang: "latex" })
  })

  // 这些输入是模型流式输出可见的前缀，未闭合时必须还能读到定界符。
  // 固定text token断言防止前缀被Markdown当作别的块结构处理。
  test.each(["$$\nx^2", "\\[x^2", "\\begin{align}x&=1"])("preserves unfinished block %s", (source) => {
    expect(lexer(source)[0]).toMatchObject({ type: "paragraph", tokens: [{ type: "text", text: source }] })
  })

  // 代码示例中的美元是用户要展示的源码，既有代码分词必须优先。
  // 跨行code span用例专门约束块start扫描，单行用例不能覆盖这条路径。
  test("keeps code fences and code spans literal", () => {
    expect(lexer("```ts\nconst x = '$x^2$'\n```")[0]).toMatchObject({
      type: "code",
      lang: "ts",
      text: "const x = '$x^2$'",
    })
    expect(lexer("`$x^2$`")[0]).toMatchObject({ tokens: [{ type: "codespan", text: "$x^2$" }] })
    expect(lexer("`example\n$$\nx^2\n$$\nend`")[0]).toMatchObject({ tokens: [{ type: "codespan" }] })
  })

  // 金额、shell变量、缺闭合和转义美元分别来自普通正文，不能误变成数学字形。
  // 检查段落类型防止无字形变化却把正文误分为公式块。
  test.each(["costs $5 and $10", "$HOME/$USER", "echo $$", "$x^2", "\\$x^2$"])("keeps prose %s", (source) => {
    const tokens = lexer(source)
    expect(JSON.stringify(tokens)).not.toContain("x²")
    expect(tokens[0]?.type).toBe("paragraph")
  })

  // 三种失败来自引擎拒绝、行内布局不适配和抛错，均须保留可读原式。
  // 期望值直接写源文本，不调用渲染器回算期望。
  test("keeps unsupported and multiline inline results as source", () => {
    expect(lexer("$\\unknown{x}$")[0]).toMatchObject({ tokens: [{ type: "text", text: "$\\unknown{x}$" }] })
    expect(makeMathLexer(() => "a\nb")("$x^2$")[0]).toMatchObject({ tokens: [{ type: "text", text: "$x^2$" }] })
    expect(
      makeMathLexer(() => {
        throw new Error("unsupported")
      })("$x^2$")[0],
    ).toMatchObject({ tokens: [{ type: "text", text: "$x^2$" }] })
  })

  // 两个独立lexer交错使用，捕获块扫描状态意外共享给另一个实例的回归。
  // 最终段落与代码的固定顺序验证扫描偏移恢复，不依赖内部缓存字段。
  test("lexers keep block scanning state independent", () => {
    const second = makeMathLexer(() => "y")
    second("plain text")
    expect(lexer("text\n$$\nx^2\n$$").map((token) => token.type)).toEqual(["paragraph", "code"])
  })
})
