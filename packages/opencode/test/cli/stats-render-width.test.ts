import { describe, expect, test } from "bun:test"
import { fitVisible, truncateVisible, visibleLength } from "../../src/cli/cmd/stats-charts"
import { renderBreakdown } from "../../src/cli/cmd/stats-render"
import type { StatsReport } from "../../src/cli/cmd/stats-data"

// #176：CJK 显示列宽与 breakdown 冒烟
describe("stats render width (#176)", () => {
  test("cost sorting selects groups before limiting without changing token defaults", async () => {
    const { renderModels, renderProviders, renderCosts } = await import("../../src/cli/cmd/stats-render")
    const { emptyComponents } = await import("../../src/cli/cmd/stats-data")
    // #177：token 榜首成本低，显式 cost 必须在限行前选出高成本行
    const groups = [
      { id: "token-heavy", tokens: 100, cost: 1, calls: 1 },
      { id: "cost-heavy", tokens: 10, cost: 9, calls: 20 },
    ].map((group) => ({
      id: group.id,
      label: group.id,
      tokens: { input: group.tokens, output: 0, reasoning: 0, cache: { read: 0, write: 0 }, total: group.tokens },
      components: emptyComponents(),
      cost: group.cost,
      requests: 1,
      assistantCalls: group.calls,
      errors: 0,
      aborted: 0,
      durationMs: 0,
      sessions: 1,
      providers: [],
      models: [],
    }))
    const report = {
      totalSessions: 1, sessionsWithUsage: 1, totalMessages: 2, totalTools: 0, days: 1,
      dateRange: { earliest: 0, latest: 0 },
      total: {
        ...groups[0],
        tokens: { input: 110, output: 0, reasoning: 0, cache: { read: 0, write: 0 }, total: 110 },
        cost: 10,
        requests: 2,
        assistantCalls: 2,
      },
      models: groups, providers: groups, agents: groups, sources: groups, statuses: groups, projects: groups,
      daily: [], modelSeries: [], providerSeries: [], agentSeries: [], sourceSeries: [], statusSeries: [], projectSeries: [],
      tokenPartSeries: [], sessions: [], toolUsage: [], toolSeries: [], modelProviderTokens: [],
      tokensPerSession: 110, medianTokensPerSession: 110,
    } satisfies StatsReport
    for (const render of [renderModels, renderProviders, renderBreakdown, renderCosts]) {
      for (const metric of ["tokens", "cost"] as const) {
        for (const sort of [undefined, "tokens", "cost", "calls"] as const) {
          const text = render(report, { sort, metric, limit: 1, color: "never" })
          expect(text).toContain(sort === "cost" || sort === "calls" ? "cost-heavy" : "token-heavy")
          // 排名限行只约束榜单；后续完整费用瀑布仍应展示其他供应商。
          expect(text.split("\n").slice(0, 4).join("\n")).not.toContain(sort === "cost" || sort === "calls" ? "token-heavy" : "cost-heavy")
        }
      }
    }
    expect(groups.map((group) => group.id)).toEqual(["token-heavy", "cost-heavy"])
  })

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

  test("renderBreakdown tool dimension includes tool context series title", () => {
    const report = {
      totalSessions: 1,
      sessionsWithUsage: 1,
      totalMessages: 1,
      totalTools: 1,
      days: 1,
      dateRange: { earliest: 0, latest: 1 },
      total: {
        tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 }, total: 2 },
        cost: 0,
        requests: 1,
        assistantCalls: 1,
      },
      models: [],
      providers: [],
      agents: [],
      sources: [],
      statuses: [],
      projects: [],
      daily: [{ day: 0, label: "d0", tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 }, total: 0 }, cost: 0, requests: 0, assistantCalls: 0 }],
      modelSeries: [],
      providerSeries: [],
      agentSeries: [],
      sourceSeries: [],
      statusSeries: [],
      projectSeries: [],
      tokenPartSeries: [],
      sessions: [],
      toolUsage: [{ id: "bash", count: 1, inputChars: 1, outputChars: 1, contextTokens: 3 }],
      toolSeries: [
        {
          id: "bash",
          label: "bash",
          points: [{ day: 0, label: "d0", tokens: { input: 3, output: 0, reasoning: 0, cache: { read: 0, write: 0 }, total: 3 }, cost: 0, requests: 1, assistantCalls: 0 }],
          tokens: { input: 3, output: 0, reasoning: 0, cache: { read: 0, write: 0 }, total: 3 },
          cost: 0,
          requests: 1,
          assistantCalls: 0,
        },
      ],
      modelProviderTokens: [],
      tokensPerSession: 2,
      medianTokensPerSession: 2,
    } as unknown as StatsReport
    const text = renderBreakdown(report, { by: "tool", metric: "tokens" })
    // #177：主路径必须出现系列标题
    expect(text).toContain("Tool context tokens over time")
  })
})
