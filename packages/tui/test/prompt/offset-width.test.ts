import { describe, expect, test } from "bun:test"
import { promptOffsetWidth } from "../../src/prompt/display"

describe("prompt offset width", () => {
  test("converts JS indices to textarea display offsets for wide prefixes", () => {
    // #247：复现宽字符前插漂移——8 个汉字 + 空格的 JS 长度是 9，
    // Textarea offset 是 17；part source 恢复必须用后者，否则高亮错位
    const prefix = "就按照这种来修改 "
    expect(prefix.length).toBe(9)
    expect(promptOffsetWidth(prefix)).toBe(17)

    // #247：占位符在宽前缀之后的起点等于 promptOffsetWidth(prefix)，
    // 这正是 /editor 返回与 extmark 同步重建时使用的换算
    // #247：断言镜像了生产代码的换算方向：indexOf 给 JS 索引，
    // slice 后经 promptOffsetWidth 得到 Textarea offset，修复前后分别为 17/9
    const content = `${prefix}[Image 1] `
    const start = promptOffsetWidth(content.slice(0, content.indexOf("[Image 1]")))
    expect(start).toBe(17)
  })
})
