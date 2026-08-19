import { expect, test } from "bun:test"
import {
  MARKDOWN_CHAR_BUDGET,
  MARKDOWN_LINE_BUDGET,
  withinMarkdownBudget,
} from "../../../../src/cli/cmd/tui/util/text-budget"

test("内容在字符与行数预算内时保持 Markdown 渲染", () => {
  // 预算内输入必须完全保持既有 Markdown 路径，防止谓词误杀正常内容。
  expect(withinMarkdownBudget("# 标题\n\n正文")).toBe(true)
  expect(withinMarkdownBudget("x".repeat(32 * 1024))).toBe(true)
  expect(withinMarkdownBudget("\n".repeat(999))).toBe(true)
})

test("超过任一预算即降级纯文本", () => {
  // 逻辑行 = 1 + 换行：999 个换行恰为 1000 行边界内，1000 个换行即 1001 行越界。
  expect(withinMarkdownBudget("x".repeat(32 * 1024 + 1))).toBe(false)
  expect(withinMarkdownBudget("\n".repeat(1000))).toBe(false)
  expect(withinMarkdownBudget("x".repeat(32 * 1024) + "\n")).toBe(false)
})

test("预算常量与渲染熔断合同一致", () => {
  expect(MARKDOWN_CHAR_BUDGET).toBe(32 * 1024)
  expect(MARKDOWN_LINE_BUDGET).toBe(1000)
})
