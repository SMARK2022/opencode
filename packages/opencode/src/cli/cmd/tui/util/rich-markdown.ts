import { TextRenderable, type MarkdownRenderNode, type RenderContext, type ColorInput } from "@opentui/core"
import { render } from "lovely-mermaid"
import { renderLatex } from "./latex"
import { makeMathExtensions } from "./math-markdown"

export const mathExtensions = makeMathExtensions(renderLatex)

function closedLanguage(token: Parameters<MarkdownRenderNode>[0]) {
  if (token.type !== "code") return
  const lang = token.lang?.trim().split(/\s+/, 1)[0]?.toLowerCase()
  if (lang !== "mermaid" && lang !== "math" && lang !== "latex") return
  // 源码超限仍使用原生节点，避免引用或列表切换到不会产生图形的路径。
  if (token.text.length > (lang === "mermaid" ? 20_000 : 4096)) return
  // 数学扩展只发布已闭合的显示块；普通 code token 即使围栏还没闭合，也可能已经由 Marked 发出。
  if ("math" in token && token.math === true) return lang
  const opener = /^ {0,3}(`{3,}|~{3,})/.exec(token.raw)?.[1]
  if (!opener) return
  const raw = token.raw.trimEnd()
  const newline = raw.lastIndexOf("\n")
  if (newline < 0) return
  // 更短或不同字符的围栏仍是块内源码，等真正闭合再交给图形布局。
  const closer = /^ {0,3}(`{3,}|~{3,})$/.exec(raw.slice(newline + 1))?.[1]
  if (closer && closer[0] === opener[0] && closer.length >= opener.length) return lang
}

export function richMarkdown(ctx: RenderContext, fg: () => ColorInput): MarkdownRenderNode {
  const renderNode: MarkdownRenderNode = (token, context) => {
    if (token.type !== "code") return
    const lang = closedLanguage(token)
    if (!lang) return
    let text: string | undefined
    try {
      text = lang === "mermaid" ? render(token.text)?.plain.join("\n") : renderLatex(token.text, { display: true })
    } catch {}
    // 无法绘制的已闭合块回到原生代码节点，仍能选取和阅读原围栏内容。
    if (!text) return context.defaultRender()
    const rendered = text
    // 首次窄屏也保留已布局的结果，随后容器变宽只切换当前节点的显示内容。
    const columns = Math.max(...rendered.split("\n").map((line) => Bun.stringWidth(line)))
    let fits = false
    const node = new TextRenderable(ctx, {
      content: token.text,
      fg: fg(),
      width: "100%",
      wrapMode: "word",
      flexShrink: 0,
      marginTop: 0,
      marginBottom: 1,
    })
    // 用 Yoga 实际分到的列宽，父列表和引用的边距已经从该宽度扣除。
    node.on("line-info-change", () => {
      const next = node.width >= columns
      if (next === fits) return
      fits = next
      node.wrapMode = fits ? "none" : "word"
      node.content = fits ? rendered : token.text
    })
    return node
  }
  // 容器和代码回调共用判定，普通引用和列表无需换成富文本子节点。
  renderNode.handlesCode = (token) => closedLanguage(token) !== undefined
  return renderNode
}
