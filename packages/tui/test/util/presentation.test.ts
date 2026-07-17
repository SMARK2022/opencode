import { describe, expect, test } from "bun:test"
import { formatUsageStats, sessionEpilogue } from "../../src/util/presentation"

test("formats session continuation summary", () => {
  const epilogue = sessionEpilogue({ title: "A session", sessionID: "ses_123" })
  expect(epilogue).toContain("A session")
  expect(epilogue).toContain("opencode -s ses_123")
  // 直接覆盖 stdout 最终消费的 epilogue 文本，不能只验证孤立 formatter。
  const populated = sessionEpilogue({ title: "A session", sessionID: "ses_123", usage: { input: 12_300, output: 1_000, cost: 0.01 } })
  expect(populated).toContain("↑12.3K ↓1.0K · $0.01")
  expect(populated).toContain("Stats")
  expect(populated.indexOf("Stats")).toBeGreaterThan(populated.indexOf("Session"))
  expect(populated.indexOf("Stats")).toBeLessThan(populated.indexOf("Continue"))
  expect(sessionEpilogue({ title: "Empty", sessionID: "ses_zero", usage: { input: 0, output: 0, cost: 0 } })).not.toContain("Stats")
})

describe("formatUsageStats", () => {
  // #490：字段单独门控——input-only 不出现零 output/cost；flow 与 cost 的分隔符随组形态变化。
  test("gates each field independently and joins flow with cost", () => {
    expect(formatUsageStats({ input: 12_300, output: 1_000, cost: 0.01 })).toBe("↑12.3K ↓1.0K · $0.01")
    expect(formatUsageStats({ input: 12_300, output: 0, cost: 0 })).toBe("↑12.3K")
    expect(formatUsageStats({ input: 0, output: 1_000, cost: 0 })).toBe("↓1.0K")
    expect(formatUsageStats({ input: 0, output: 0, cost: 0.25 })).toBe("$0.25")
    expect(formatUsageStats({ input: 0, output: 0, cost: 0 })).toBe("")
    expect(formatUsageStats({ input: 100, output: 0, cost: 0.25 })).toBe("↑100 · $0.25")
    expect(formatUsageStats({ input: 0, output: 100, cost: 0.25 })).toBe("↓100 · $0.25")
  })
})
