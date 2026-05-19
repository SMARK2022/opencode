import { describe, expect, test } from "bun:test"
import { fitVisible, truncateVisible, visibleLength } from "../../src/cli/cmd/stats-charts"
import { renderBreakdown } from "../../src/cli/cmd/stats-render"
import type { StatsReport } from "../../src/cli/cmd/stats-data"

// #176：CJK 显示列宽与 breakdown 冒烟
describe("stats render width (#176)", () => {
  test("counts CJK glyphs as two columns", () => {
    expect(visibleLength("中文")).toBe(4)
    expect(visibleLength("abc")).toBe(3)
  })

  test("truncateVisible respects display columns not string length", () => {
    const out = truncateVisible("中文测试台", 5)
    expect(visibleLength(out)).toBeLessThanOrEqual(5)
    expect(out.includes("…") || out.includes("...")).toBe(true)
  })

  test("fitVisible pads to width", () => {
    const out = fitVisible("中", 4)
    expect(visibleLength(out)).toBe(4)
  })

  test("renderBreakdown tool dimension includes context fields", () => {
    const report = {
      totalSessions: 1,
      sessionsWithUsage: 1,
      totalMessages: 1,
      totalTools: 2,
      days: 1,
      dateRange: { earliest: 0, latest: 0 },
      total: {
        tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 }, total: 15 },
        cost: 0.1,
        requests: 1,
        assistantCalls: 1,
      },
      models: [],
      providers: [],
      agents: [],
      sources: [],
      statuses: [],
      projects: [],
      daily: [],
      modelSeries: [],
      providerSeries: [],
      agentSeries: [],
      sourceSeries: [],
      statusSeries: [],
      projectSeries: [],
      tokenPartSeries: [],
      sessions: [],
      toolUsage: [{ id: "bash", count: 2, inputChars: 10, outputChars: 20, contextTokens: 42 }],
      modelProviderTokens: [],
      tokensPerSession: 15,
      medianTokensPerSession: 15,
    } as unknown as StatsReport
    const text = renderBreakdown(report, { by: "tool", metric: "tokens" })
    expect(text).toContain("bash")
    expect(text).toContain("ctx=42")
    // with toolSeries present, breakdown must surface the #177 chart title
  })

})
