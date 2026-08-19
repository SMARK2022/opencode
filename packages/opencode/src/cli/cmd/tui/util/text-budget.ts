// Assistant Text 的 Markdown 渲染预算：超限内容必须在构造 parser-backed
// renderable（markdown/code）之前降级为纯文本，这是对输入域的确定性分类，
// 不是解析失败后的 fallback。
export const MARKDOWN_CHAR_BUDGET = 32 * 1024
export const MARKDOWN_LINE_BUDGET = 1000

// 逻辑行数 = 1 + 换行数；任一预算超限即短路返回，不分配 split 数组，
// 保证超长内容本身的判定成本与内容长度线性且无额外拷贝。
export function withinMarkdownBudget(content: string): boolean {
  if (content.length > MARKDOWN_CHAR_BUDGET) return false
  let lines = 1
  for (let index = 0; index < content.length; index++) {
    if (content.charCodeAt(index) === 10 && ++lines > MARKDOWN_LINE_BUDGET) return false
  }
  return true
}
