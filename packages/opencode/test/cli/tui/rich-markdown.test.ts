import { describe, expect, test } from "bun:test"
import { BoxRenderable, createMarkdownLexer, MarkdownRenderable, SyntaxStyle, TextRenderable, type RenderNodeContext } from "@opentui/core"
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing"
import { mathExtensions, richMarkdown } from "../../../src/cli/cmd/tui/util/rich-markdown"

const diagram = "graph LR\nA[Start] --> B[End]"

function mathTokens(node: unknown): string[] {
  if (!node || typeof node !== "object") return []
  const { type, text } = node as Record<string, unknown>
  return type === "opencode_math_inline" && typeof text === "string" ? [text] : Object.values(node).flatMap(mathTokens)
}

const lexer = createMarkdownLexer(mathExtensions)

function lex(source: string) {
  const tokens = lexer(source)
  // 字形独立于原文；增量解析需用 raw 匹配后续流式前缀。
  expect(tokens.map((token) => token.raw).join("")).toBe(source)
  return tokens
}

async function paint(setup: TestRendererSetup, settle?: MarkdownRenderable): Promise<void> {
  // 第一帧让 Yoga 分配可用宽度，第二帧才读取 source→图形切换后的真实布局。
  for (let frame = 0; frame < 2; frame++) await setup.renderOnce()
  // 真实高亮仍可能改写节点内容；用同样的布局节拍读取高亮后的屏幕。
  if (settle) await finishHighlighting(settle).then(() => paint(setup))
}

type MarkdownOptions = Partial<ConstructorParameters<typeof MarkdownRenderable>[1]>

function richNode(setup: TestRendererSetup, content: string, syntaxStyle: SyntaxStyle, options: MarkdownOptions = {}) {
  return new MarkdownRenderable(setup.renderer, {
    ...options,
    content,
    syntaxStyle,
    markdownExtensions: mathExtensions,
    renderNode: richMarkdown(setup.renderer, () => "#ffffff"),
  })
}

const fence = (lang: string, text: string) => "```" + lang + "\n" + text + "\n```"

describe("rich markdown source tokens", () => {
  test.each([
    ["前 $x^2$ 后", ["x²"]],
    ["**$x^2$** and _$y^2$_", ["x²", "y²"]],
    // 链接标签中的美元可成公式，目的地里的美元留在 URL，不生成字形 token。
    ["[公式 $x^2$](https://x/$y^2$)", ["x²"]],
    ["a $x^2$ b $x^2$ c", ["x²", "x²"]],
    ["| $x^2$ | $y^2$ |\n|---|---|\n| $a_1$ | z |", ["x²", "y²", "a₁"]],
    ["- $x^2$\n- $y^2$", ["x²", "y²"]],
  ] as const)("preserves surrounding markdown: %s", (source, expected) => {
    expect(mathTokens(lex(source))).toEqual([...expected])
  })

  test.each([
    "`$x^2$`",
    "```js\nconst s = '$x^2$'\n```",
    "[x][id]\n\n[id]: https://x/$y^2$",
    "costs $5 and $10",
    "\\$x^2$",
    "$$\nx^2",
  ])("preserves literal or unfinished content: %s", (source) => {
    expect(mathTokens(lex(source))).toEqual([])
  })

  test("passes a complete display formula to the block renderer", () => {
    // 显示公式共用原生代码块回调；原公式交给布局器，不重新拼接 Markdown 围栏。
    expect(lex("$$\n\\frac{a}{b}\n$$")[0]).toMatchObject({
      type: "code",
      text: "\\frac{a}{b}",
      lang: "latex",
      math: true,
    })
  })

  test.each(["> $x^2$\n> next", "- first\n  $x^2$", "- **$x^2$**\n  second"])(
    "recognizes math inside multiline containers: %s",
    (source) => {
      expect(mathTokens(lex(source))).toEqual(["x²"])
    },
  )
})

describe("rich markdown terminal renderers", () => {
  // 同一个真实终端缓冲区同时容纳行内字形、三行分式和图连线。
  // 逐行固定分式期望能捕获块间距错误，仅检查字母存在无法验证垂直布局。
  test("renders inline math, a display fraction and Mermaid in the real buffer", async () => {
    const setup = await createTestRenderer({ width: 60, height: 16 })
    const syntax = SyntaxStyle.create()
    try {
      const source = `Before $x^2$ after\n\n$$\n\\frac{a}{b}\n$$\n\n\`\`\`mermaid\n${diagram}\n\`\`\``
      setup.renderer.root.add(richNode(setup, source, syntax))
      await paint(setup)
      const frame = setup.captureCharFrame()
      const lines = frame.split("\n").map((line) => line.trimEnd())
      expect(lines[0]).toBe("Before x² after")
      expect(lines.slice(2, 5)).toEqual(["a", "─", "b"])
      // 固定连线片段来自预期图形，不能用渲染函数自身生成期望。
      // 再检查源码消失，排除仅把图定义打印出来也让节点名称断言通过。
      expect(frame).toContain("│ Start ├───▶│ End │")
      expect(frame).not.toContain("graph LR")
      expect(frame).not.toContain("$x^2$")
    } finally {
      await finishHighlighting(setup.renderer.root)
      setup.renderer.destroy()
      syntax.destroy()
    }
  })

  test("keeps default code for oversized, invalid and unsupported special blocks", async () => {
    const setup = await createTestRenderer({ width: 40, height: 8 })
    const syntax = SyntaxStyle.create()
    try {
      let calls = 0
      const fallback = new TextRenderable(setup.renderer, { content: "source" })
      const context: RenderNodeContext = {
        syntaxStyle: syntax,
        conceal: false,
        concealCode: false,
        defaultRender: () => {
          calls++
          return fallback
        },
      }
      const rich = richMarkdown(setup.renderer, () => "#ffffff")
      const oversize = "x".repeat(4097)
      expect(
        rich({ type: "code", raw: fence("mermaid", "invalid diagram"), text: "invalid diagram", lang: "mermaid" }, context),
      ).toBe(fallback)
      // 超限块不调用布局或 defaultRender；对照实际尝试布局失败的图所请求的原生节点。
      expect(rich({ type: "code", raw: fence("latex", oversize), text: oversize, lang: "latex" }, context)).toBeUndefined()
      // 已有未闭合 code token 的原生展示由调用方接手，禁止提前使用已布局的节点。
      expect(rich({ type: "code", raw: "```mermaid\n" + diagram, text: diagram, lang: "mermaid" }, context)).toBeUndefined()
      expect(rich({ type: "code", raw: fence("typescript", "x"), text: "x", lang: "typescript" }, context)).toBeUndefined()
      expect(calls).toBe(1)
      fallback.destroy()
    } finally {
      await finishHighlighting(setup.renderer.root)
      setup.renderer.destroy()
      syntax.destroy()
    }
  })
})

// 语法矩阵覆盖参考实现提供的九类图和五类公式，不扩大到图片渲染。
// 每项选择足以辨认布局的固定片段，避免只凭输入里已有的标签判定成功。
const richExamples: [string, string, string, string][] = [
  ["flowchart", "mermaid", "flowchart LR\nA[Start] --> B[End]", "│ Start ├───▶│ End │"],
  ["state", "mermaid", "stateDiagram-v2\n[*] --> Idle\nIdle --> Running", "│ Running │"],
  ["class", "mermaid", "classDiagram\nAnimal <|-- Dog\nAnimal : +name", "│ Animal │"],
  ["er", "mermaid", "erDiagram\nUSER ||--o{ ORDER : places", "│ ORDER │"],
  ["sequence", "mermaid", "sequenceDiagram\nAlice->>Bob: Hello", "Hello"],
  ["pie", "mermaid", 'pie\n"A" : 3\n"B" : 2', "60%"],
  ["mindmap", "mermaid", "mindmap\n  root((Root))\n    Child", "└── Child"],
  ["timeline", "mermaid", "timeline\n2024 : Launch\n2025 : Grow", "Launch"],
  ["gitGraph", "mermaid", "gitGraph\ncommit\ncommit", "● c1 (main)"],
  ["matrix", "latex", String.raw`\begin{pmatrix} 1 & 2 \\ 3 & 4 \end{pmatrix}`, "⎛ 1 │ 2 ⎞"],
  ["cases", "latex", String.raw`f(x) = \begin{cases} x^2 & x \ge 0 \\ -x & x < 0 \end{cases}`, "⎧ x² if x ≥ 0"],
  ["sum", "math", String.raw`\sum_{i=1}^{n} i^2`, "∑  i²"],
  ["integral", "math", String.raw`\int_{-\infty}^{\infty} e^{-x^2}\,dx`, "∫"],
  ["radical fraction", "math", String.raw`x = \frac{-b \pm \sqrt{b^2-4ac}}{2a}`, "-b ± √(b²-4ac)"],
]

describe("rich renderer supported syntax", () => {
  test.each(richExamples)(
    "draws %s with custom text rather than source fallback",
    async (_name, language, source, expected) => {
      // 宽屏为支持语法提供实际布局空间，防止宽度不足掩盖引擎能力。
      const setup = await createTestRenderer({ width: 100, height: 40 })
      const syntax = SyntaxStyle.create()
      try {
        const renderNode = richMarkdown(setup.renderer, () => "#ffffff")
        let fallback = false
        const rendered = renderNode(
          { type: "code", raw: fence(language, source), text: source, lang: language },
          {
            syntaxStyle: syntax,
            conceal: false,
            concealCode: false,
            defaultRender: () => {
              fallback = true
              return null
            },
          },
        )
        // 同时确认自定义节点和缓冲区内容，默认源码显示不能算语法渲染成功。
        expect(fallback).toBe(false)
        expect(rendered).toBeInstanceOf(TextRenderable)
        setup.renderer.root.add(rendered!)
        await paint(setup)
        expect(setup.captureCharFrame()).toContain(expected)
      } finally {
        await finishHighlighting(setup.renderer.root)
        setup.renderer.destroy()
        syntax.destroy()
      }
    },
  )
})

describe("rich markdown streaming and container regressions", () => {
  // 空引用行也承担段落边界，投影不能删除它或让下一行逃出引用。
  // HTML代码元素保持字面量，验证公式扩展尊重原始块状态。
  test("preserves empty quote lines and raw HTML code", () => {
    expect(mathTokens(lex("> $x^2$\n>\n> next"))).toEqual(["x²"])
    expect(mathTokens(lex("<code>$x^2$</code>"))).toEqual([])
    expect(mathTokens(lex("<pre>$x^2$</pre>"))).toEqual([])
  })

  // 两种OpenTUI块组织模式都会出现在真实消费入口，使用同一输入覆盖更新合同。
  // 复用一个Markdown实例持续修改正文，避免重建节点掩盖流式更新缺陷。
  test.each(["top-level", "coalesced"] as const)("updates real streaming buffer in %s mode", async (mode) => {
    const setup = await createTestRenderer({ width: 70, height: 20 })
    const syntax = SyntaxStyle.create()
    try {
      const node = richNode(setup, "", syntax, {
        streaming: true,
        internalBlockMode: mode,
      })
      setup.renderer.root.add(node)
      async function show(source: string) {
        node.content = source
        await paint(setup)
        return setup.captureCharFrame()
      }
      // 先给未闭合公式再补齐尾部，检查用户看到的前缀在完成前后都有内容。
      expect(await show("Before $x^")).toContain("Before $x^")
      expect(await show("Before $x^2$ after")).toContain("Before x² after")
      const body = "Before $x^2$ after\n\n`$y^2$`\n\n```mermaid\n"
      const open = await show(body + "graph LR\nA[Start]")
      expect(open).toContain("graph LR")
      expect(open).not.toContain("▶")
      const frame = await show(body + diagram + "\n```")
      expect(frame).toContain("Before x² after")
      expect(frame).toContain("$y^2$")
      expect(frame).toContain("│ Start ├───▶│ End │")
      expect(frame).not.toContain("graph LR")
      // 完成状态切换不重新提供正文，验证节点能承接最后一帧流式内容。
      node.streaming = false
      await paint(setup)
      const final = setup.captureCharFrame()
      expect(final).toContain("Before x² after")
      expect(final).toContain("$y^2$")
      expect(final).toContain("│ Start ├───▶│ End │")
    } finally {
      await finishHighlighting(setup.renderer.root)
      setup.renderer.destroy()
      syntax.destroy()
    }
  })
})

// 原生高亮可能仍引用已挂载节点，销毁前沿实际子树等待其结算。
// 递归覆盖嵌套引用和列表，不能只等待顶层Markdown节点。
async function finishHighlighting(node: { getChildren(): unknown[] }) {
  await Promise.all(
    node.getChildren().map(async (child) => {
      if (child && typeof child === "object" && "highlightingDone" in child) await child.highlightingDone
      if (child && typeof child === "object" && "getChildren" in child) {
        await finishHighlighting(child as { getChildren(): unknown[] })
      }
    }),
  )
}

describe("rich markdown nested blocks", () => {
  // 引用与列表分别走不同嵌套节点路径，分式需要在二者内部保持多行布局。
  // 只改变分子后复用同一节点，验证嵌套自定义渲染能更新而非停留在初始结果。
  test.each(["quote", "list"] as const)("renders and updates a display fraction inside a %s", async (container) => {
    const setup = await createTestRenderer({ width: 60, height: 12 })
    const syntax = SyntaxStyle.create()
    const source = (numerator: string) =>
      container === "quote" ? `> $$\n> \\frac{${numerator}}{b}\n> $$` : `- $$\n  \\frac{${numerator}}{b}\n  $$`
    try {
      const node = richNode(setup, source("a"), syntax, {
        streaming: true,
        internalBlockMode: container === "quote" ? "top-level" : "coalesced",
      })
      setup.renderer.root.add(node)
      await paint(setup)
      let frame = setup.captureCharFrame()
      expect(frame).toContain("a")
      expect(frame).toContain("─")
      expect(frame).toContain("b")
      expect(frame).not.toContain("frac")
      node.content = source("z")
      await paint(setup)
      frame = setup.captureCharFrame()
      expect(frame).toContain("z")
      expect(frame).toContain("─")
      expect(frame).not.toContain("frac")
      node.streaming = false
      await paint(setup)
      expect(setup.captureCharFrame()).toContain("─")
    } finally {
      await finishHighlighting(setup.renderer.root)
      setup.renderer.destroy()
      syntax.destroy()
    }
  })

  // 图定义嵌入容器后仍应经过renderNode，不能退回普通嵌套代码高亮。
  test.each(["quote", "list"] as const)("draws Mermaid nested inside a %s", async (container) => {
    const setup = await createTestRenderer({ width: 60, height: 12 })
    const syntax = SyntaxStyle.create()
    const source =
      container === "quote"
        ? "> ```mermaid\n> graph LR\n> A[Start] --> B[End]\n> ```"
        : "- ```mermaid\n  graph LR\n  A[Start] --> B[End]\n  ```"
    try {
      setup.renderer.root.add(
        richNode(setup, source, syntax, {
          internalBlockMode: container === "quote" ? "top-level" : "coalesced",
        }),
      )
      await paint(setup)
      const frame = setup.captureCharFrame()
      expect(frame).toContain("│ Start ├───▶│ End │")
      expect(frame).not.toContain("graph LR")
    } finally {
      await finishHighlighting(setup.renderer.root)
      setup.renderer.destroy()
      syntax.destroy()
    }
  })
})

// 初次建节点时父容器和入口都很窄；后续只改变宽度，原图仍应能恢复。
test("special blocks recover in place after an initially narrow layout", async () => {
  const setup = await createTestRenderer({ width: 100, height: 20 })
  const syntax = SyntaxStyle.create()
  try {
    const parent = new BoxRenderable(setup.renderer, { width: 11, flexDirection: "column" })
    const prefix = "Prefix"
    const fraction = String.raw`\frac{abcdefghijklmnopqrst}{abcdefghijklmno}`
    setup.renderer.root.add(parent)
    const source = prefix + "\n\n```mermaid\n" + diagram + "\n```\n\n```latex\n" + fraction + "\n```"
    const node = richNode(setup, source, syntax, {
      streaming: true,
      width: "100%",
    })
    parent.add(node)
    await paint(setup)
    const children = node.getChildren()
    for (const width of [11, 80, 11, 80]) {
      parent.width = width
      await paint(setup, node)
      const frame = setup.captureCharFrame()
      expect(frame).toContain(prefix)
      expect(frame.includes("graph LR")).toBe(width === 11)
      expect(frame.includes("│ Start ├───▶│ End │")).toBe(width === 80)
      expect(frame.includes("abcdefghijklmnopqrst")).toBe(width === 80)
      // 宽度改变只切换块的呈现，已经显示的前缀和原生布局节点继续使用。
      expect(node.getChildren().every((child, i) => child === children[i])).toBe(true)
    }
    // 结束流式会提交最后一个未稳定块，富文本节点在这一步也要继续复用。
    node.streaming = false
    await paint(setup)
    expect(node.getChildren().every((child, i) => child === children[i])).toBe(true)
    expect(setup.captureCharFrame()).toContain("│ Start ├───▶│ End │")
  } finally {
    await finishHighlighting(setup.renderer.root)
    setup.renderer.destroy()
    syntax.destroy()
  }
})

// 公式字形在关闭 conceal 且高亮结算后仍保持字面量；代码 span 里的原反斜线仍归 Markdown。
test.each(["top-level", "coalesced"] as const)(
  "shows literal math with conceal disabled after highlighting (%s)",
  async (internalBlockMode) => {
    const setup = await createTestRenderer({ width: 60, height: 20 })
    const syntax = SyntaxStyle.create()
    try {
      const source =
        "$\\alpha_i + \\beta^2$\n\n$$\n\\frac{a}{b}\n$$\n\n$$\nx^2\n$$\n\n`\\+` and **$a*b*c$**\n\n- $\\alpha_i + \\beta^2$\n\n> $\\alpha_i + \\beta^2$"
      const node = richNode(setup, source, syntax, {
        internalBlockMode,
        conceal: false,
      })
      setup.renderer.root.add(node)
      // R19 的初始 seed 已能显示干净字形；等异步高亮结算才能捕获串入的转义。
      await paint(setup, node)
      const lines = setup
        .captureCharFrame()
        .split("\n")
        .map((line) => line.trimEnd())
      // 固定前八行同时验证连续公式的空行与分式高度，不能只比较去空白文本。
      expect(lines.slice(0, 8)).toEqual(["αᵢ + β²", "", "a", "─", "b", "", "x²", ""])
      expect(lines.join("\n")).toContain("`\\+` and **a*b*c**")
      expect(lines.join("\n")).toContain("- αᵢ + β²")
      expect(lines.join("\n")).toContain("│ αᵢ + β²")
      expect(lines.join("\n")).not.toContain("αᵢ \\+")
      node.conceal = true
      await paint(setup, node)
      expect(setup.captureCharFrame()).toContain("a*b*c")
      node.streaming = true
      node.content = "- first"
      await paint(setup)
      await finishHighlighting(node)
      // 在现有列表尾追加公式，捕获只在构造时设置字面范围、节点更新漏传的回归。
      node.content = "- first\n- $a+b$"
      await paint(setup, node)
      expect(setup.captureCharFrame()).toContain("- a+b")
    } finally {
      await finishHighlighting(setup.renderer.root)
      setup.renderer.destroy()
      syntax.destroy()
    }
  },
)
