import { expect, test } from "bun:test"
import { createPendingToolInputParser } from "../../../src/routes/session/pending-tool-input"

test.each([
  { code: ["a", ""], lines: 1 },
  { code: ["", "b"], lines: 2 },
  { code: ["a", "b"], lines: 2 },
  { code: ["a\n", "b"], lines: 3 },
  { code: [], lines: 0 },
])("notebook array input preserves source lines: %j", ({ code, lines }) => {
  // 数组空项和已有换行不能吞掉 bridge join 产生的源码边界。
  const raw = JSON.stringify({ filePath: "a.ipynb", newCode: code, cellId: "TOP", editType: "insert" })
  for (let split = 0; split <= raw.length; split++) {
    // 每个分片位置均走真实 scanner，包括冒号、数组边界及转义序列中间。
    const parser = createPendingToolInputParser("vscode_notebook_edit")
    parser.push(raw.slice(0, split))
    parser.push(raw.slice(split))
    expect(parser.stats()).toMatchObject({ filePath: "a.ipynb", cellId: "TOP", operation: "insert", added: lines })
  }
})

test("notebook next line is counted before its closing quote", () => {
  const parser = createPendingToolInputParser("vscode_notebook_edit")
  // UI 在字符串尚未结束时就读取统计，不能等最后引号才补数组分隔符。
  parser.push('{"newCode":["first","sec')
  expect(parser.stats()?.added).toBe(2)
  parser.push('ond"],"oldCode":"before\\n","filePath":"a.ipynb"}')
  // 数组结束后仍须恢复普通字段解析，不能把路径并入前一数组。
  expect(parser.stats()).toMatchObject({ filePath: "a.ipynb", added: 2, removed: 1 })
})

// 普通 edit/write/apply_patch 的冒号转换由 pending-tool-input.test.ts 同时回归。
