import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"

// #163：锁定 Claude tool_usage_policy 为 task-first 精炼文案（#29/#163 终态）
// #163：禁止回落到 #162 的 glob-first / task-only 旧策略
describe("anthropic tool_usage_policy", () => {
  const text = readFileSync(
    path.join(import.meta.dir, "../../../core/src/system-context/prompt/anthropic.txt"),
    "utf8",
  )

  test("forbids deep multi-file glob/grep as task substitute", () => {
    // #163：深度多文件语义不得只用 glob/grep 替代 task
    expect(text).toMatch(/Do not use glob or grep directly when/i)
  })

  test("still allows glob/grep/read for surveys", () => {
    // #163：结构盘点仍允许直接 glob/grep/read
    expect(text.toLowerCase()).toMatch(/glob/)
    expect(text.toLowerCase()).toMatch(/grep/)
  })

  test("does not restore inverted task-only survey policy", () => {
    // #163：不得恢复 #162 倒置句式
    expect(text).not.toMatch(/task tool only for broad semantic analysis/i)
  })
})
