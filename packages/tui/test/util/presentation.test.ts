import { describe, expect, test } from "bun:test"
import { formatUsageStats, sessionEpilogue } from "../../src/util/presentation"
import { tokenAccounting } from "../../src/util/token-accounting"

test("formats session continuation summary", () => {
  const epilogue = sessionEpilogue({ title: "A session", sessionID: "ses_123" })
  expect(epilogue).toContain("A session")
  expect(epilogue).toContain("opencode -s ses_123")
  // 直接覆盖 stdout 最终消费的 epilogue 文本，不能只验证孤立 formatter。
  const populated = sessionEpilogue({
    title: "A session",
    sessionID: "ses_123",
    usage: { input: 12_300, output: 1_000, cost: 0.01 },
  })
  expect(populated).toContain("↑ 12.3K ↓ 1.0K · $0.01")
  expect(populated).toContain("Stats")
  expect(populated.indexOf("Stats")).toBeGreaterThan(populated.indexOf("Session"))
  expect(populated.indexOf("Stats")).toBeLessThan(populated.indexOf("Continue"))
  expect(
    sessionEpilogue({ title: "Empty", sessionID: "ses_zero", usage: { input: 0, output: 0, cost: 0 } }),
  ).not.toContain("Stats")
})

describe("formatUsageStats", () => {
  // #490/#506：字段单独门控 + 箭头后空格（对齐主面板 live compact flow ↑ n ↓ n）；
  // normal fixture 同时锁定 flow/cost 分隔符，而不是只验证字段存在。
  test("gates each field independently and joins flow with cost", () => {
    // input-only 是中断 Session 的有效记录，不能用 output/cost 的零值制造噪声。
    // input+cost 锁定 token flow 与费用之间的中点；output+cost 证明规则不依赖 input 存在。
    expect(formatUsageStats({ input: 12_300, output: 1_000, cost: 0.01 })).toBe("↑ 12.3K ↓ 1.0K · $0.01")
    expect(formatUsageStats({ input: 1_200, output: 0, cost: 0 })).toBe("↑ 1.2K")
    expect(formatUsageStats({ input: 1_200, output: 0, cost: 0.01 })).toBe("↑ 1.2K · $0.01")
    expect(formatUsageStats({ input: 0, output: 970, cost: 0.01 })).toBe("↓ 970 · $0.01")
    expect(formatUsageStats({ input: 12_300, output: 0, cost: 0 })).toBe("↑ 12.3K")
    expect(formatUsageStats({ input: 0, output: 1_000, cost: 0 })).toBe("↓ 1.0K")
    expect(formatUsageStats({ input: 0, output: 0, cost: 0.25 })).toBe("$0.25")
    expect(formatUsageStats({ input: 0, output: 0, cost: 0 })).toBe("")
    expect(formatUsageStats({ input: 100, output: 0, cost: 0.25 })).toBe("↑ 100 · $0.25")
    expect(formatUsageStats({ input: 0, output: 100, cost: 0.25 })).toBe("↓ 100 · $0.25")
  })

  // #506：epilogue 集成——usage 经 sessionEpilogue 输出 Stats 行（源 session-exit stdout 路径的
  // 目标等价承载；970 output + 30 reasoning 由调用方 projection 合并为 1.0K 后进入 formatter）。
  test("session epilogue renders compact spaced flow stats line", () => {
    const tokens = { input: 12_300, output: 970, reasoning: 30, cache: { read: 100, write: 50 } }
    const usage = tokenAccounting([{ id: "a", role: "assistant", tokens, cost: 0.01, time: { completed: 1 } }], () => [
      { type: "step-finish", tokens, cost: 0.01 },
    ]).session
    const epilogue = sessionEpilogue({
      title: "Usage session",
      sessionID: "ses_u",
      usage: { input: usage.input, output: usage.output + usage.reasoning, cost: usage.cost },
    })
    expect(epilogue).toContain("Stats")
    // 箭头后空格是用户可见 compact 形态，与 message footer 共用 formatUsageStats。
    expect(epilogue).toContain("↑ 12.3K ↓ 1.0K · $0.01")
  })

  // #506：multi-step request 累计经调用方聚合后仍走同一 compact 模板；
  // subagent footer 只投影当前 step（组件内部形态），formatter 层锁定模板本身。
  test("multi-step accumulated usage renders through the same compact template", () => {
    const tokens = [
      { input: 6_000, output: 100, reasoning: 0, cache: { read: 100, write: 50 } },
      { input: 6_300, output: 900, reasoning: 100, cache: { read: 100, write: 50 } },
    ]
    const messages = [
      { id: "u", role: "user" },
      ...tokens.map((tokens, index) => ({
        id: `a${index}`,
        role: "assistant",
        parentID: "u",
        tokens,
        cost: 0.005,
        time: { completed: index + 1 },
      })),
    ]
    const parts = new Map(tokens.map((tokens, index) => [`a${index}`, [{ type: "step-finish", tokens, cost: 0.005 }]]))
    const usage = tokenAccounting(messages, (id) => parts.get(id) ?? [])
    // 当前 step 含缓存且只取最后一步；永久记录取 pure input 和含 reasoning 的请求累计。
    expect(usage.step).toEqual({ input: 6450, output: 1000, confirmed: true })
    expect(usage.request).toMatchObject({ totalInput: 12600, totalInputPure: 12300, totalOutput: 1100, cost: 0.01 })
    expect(
      formatUsageStats({
        input: usage.request.totalInputPure,
        output: usage.request.totalOutput,
        cost: usage.request.cost,
      }),
    ).toBe("↑ 12.3K ↓ 1.1K · $0.01")
    // 累计为零字段仍被独立门控，禁止空格箭头后的零值噪声。
    expect(formatUsageStats({ input: 0, output: 0, cost: 0 })).toBe("")
  })
})
