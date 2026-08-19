import { describe, expect, test } from "bun:test"
import { MARKDOWN_CHAR_BUDGET, MARKDOWN_LINE_BUDGET, withinMarkdownBudget } from "../../src/util/text-budget"

describe("withinMarkdownBudget", () => {
  test("allows content within both budgets", () => {
    // 常规正文远小于两个预算；边界值本身（等于预算）仍属预算内。
    expect(withinMarkdownBudget("hello")).toBe(true)
    expect(withinMarkdownBudget("a".repeat(MARKDOWN_CHAR_BUDGET))).toBe(true)
  })

  test("rejects content exceeding the char budget", () => {
    // 超预算判定必须在任何 parser 构造前；单字符越界即短路，不分配 split 数组。
    expect(withinMarkdownBudget("a".repeat(MARKDOWN_CHAR_BUDGET + 1))).toBe(false)
  })

  test("counts logical lines as one plus newlines", () => {
    // 逻辑行数 = 1 + 换行数；1000 换行（1001 逻辑行）越界，999 换行仍在预算内。
    expect(withinMarkdownBudget("\n".repeat(MARKDOWN_LINE_BUDGET - 1))).toBe(true)
    expect(withinMarkdownBudget("\n".repeat(MARKDOWN_LINE_BUDGET))).toBe(false)
  })

  test("short-circuits on char budget before line scan", () => {
    // 超长无换行内容必须由字符预算短路；行扫描不会执行，保证判定成本线性。
    expect(withinMarkdownBudget("x".repeat(MARKDOWN_CHAR_BUDGET * 2))).toBe(false)
  })
})
