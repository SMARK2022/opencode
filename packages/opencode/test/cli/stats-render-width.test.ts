import { describe, expect, test } from "bun:test"
import { fitVisible, truncateVisible, visibleLength } from "../../src/cli/cmd/stats-charts"
import { renderBreakdown, renderDashboard } from "../../src/cli/cmd/stats-render"
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

describe("stats dashboard responsive top tables (#181)", () => {
    // #181：临时改 stdout.columns 驱动响应式分支
  const withColumns = (cols: number, fn: () => void) => {
    const prev = process.stdout.columns
    Object.defineProperty(process.stdout, "columns", { configurable: true, value: cols })
    try {
      fn()
    } finally {
      Object.defineProperty(process.stdout, "columns", { configurable: true, value: prev })
    }
  }

  const report = {
    totalSessions: 2,
    sessionsWithUsage: 2,
    totalMessages: 4,
    totalTools: 1,
    days: 3,
    dateRange: { earliest: 0, latest: 2 },
    total: {
      tokens: { input: 30, output: 10, reasoning: 0, cache: { read: 0, write: 0 }, total: 40 },
      cost: 1.5,
      requests: 3,
      assistantCalls: 3,
    },
    models: [
      {
        id: "m1",
        label: "model-one",
        tokens: { input: 20, output: 5, reasoning: 0, cache: { read: 0, write: 0 }, total: 25 },
        cost: 1,
        requests: 2,
        assistantCalls: 2,
        sessions: 1,
        providers: [],
        models: [],
      },
      {
        id: "m2",
        label: "model-two",
        tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 }, total: 15 },
        cost: 0.5,
        requests: 1,
        assistantCalls: 1,
        sessions: 1,
        providers: [],
        models: [],
      },
    ],
    providers: [
      {
        id: "p1",
        label: "provider-one",
        tokens: { input: 30, output: 10, reasoning: 0, cache: { read: 0, write: 0 }, total: 40 },
        cost: 1.5,
        requests: 3,
        assistantCalls: 3,
        sessions: 2,
        providers: [],
        models: [],
      },
    ],
    agents: [],
    sources: [],
    statuses: [],
    projects: [],
    daily: [
      { day: 0, label: "d0", tokens: { input: 10, output: 3, reasoning: 0, cache: { read: 0, write: 0 }, total: 13 }, cost: 0.4, requests: 1, assistantCalls: 1 },
      { day: 1, label: "d1", tokens: { input: 10, output: 3, reasoning: 0, cache: { read: 0, write: 0 }, total: 13 }, cost: 0.5, requests: 1, assistantCalls: 1 },
      { day: 2, label: "d2", tokens: { input: 10, output: 4, reasoning: 0, cache: { read: 0, write: 0 }, total: 14 }, cost: 0.6, requests: 1, assistantCalls: 1 },
    ],
    modelSeries: [
      {
        id: "m1",
        label: "model-one",
        points: [
          { day: 0, label: "d0", tokens: { input: 5, output: 1, reasoning: 0, cache: { read: 0, write: 0 }, total: 6 }, cost: 0.2, requests: 1, assistantCalls: 1 },
          { day: 1, label: "d1", tokens: { input: 8, output: 2, reasoning: 0, cache: { read: 0, write: 0 }, total: 10 }, cost: 0.4, requests: 1, assistantCalls: 1 },
          { day: 2, label: "d2", tokens: { input: 7, output: 2, reasoning: 0, cache: { read: 0, write: 0 }, total: 9 }, cost: 0.4, requests: 0, assistantCalls: 0 },
        ],
        tokens: { input: 20, output: 5, reasoning: 0, cache: { read: 0, write: 0 }, total: 25 },
        cost: 1,
        requests: 2,
        assistantCalls: 2,
      },
    ],
    providerSeries: [
      {
        id: "p1",
        label: "provider-one",
        points: [
          { day: 0, label: "d0", tokens: { input: 10, output: 3, reasoning: 0, cache: { read: 0, write: 0 }, total: 13 }, cost: 0.4, requests: 1, assistantCalls: 1 },
          { day: 1, label: "d1", tokens: { input: 10, output: 3, reasoning: 0, cache: { read: 0, write: 0 }, total: 13 }, cost: 0.5, requests: 1, assistantCalls: 1 },
          { day: 2, label: "d2", tokens: { input: 10, output: 4, reasoning: 0, cache: { read: 0, write: 0 }, total: 14 }, cost: 0.6, requests: 1, assistantCalls: 1 },
        ],
        tokens: { input: 30, output: 10, reasoning: 0, cache: { read: 0, write: 0 }, total: 40 },
        cost: 1.5,
        requests: 3,
        assistantCalls: 3,
      },
    ],
    agentSeries: [],
    sourceSeries: [],
    statusSeries: [],
    projectSeries: [],
    tokenPartSeries: [],
    sessions: [],
    toolUsage: [],
    toolSeries: [],
    modelProviderTokens: [],
    tokensPerSession: 20,
    medianTokensPerSession: 20,
  } as unknown as StatsReport

    // #181：宽屏必须出现 trend 且无独立 activity 区
  test("wide dashboard folds activity into top tables with trend", () => {
    withColumns(120, () => {
      const text = renderDashboard(report, { limit: 5, metric: "tokens" })
      expect(text).toContain("Top models")
      expect(text).toContain("Top providers")
            // #181：宽屏契约：share 与 trend 同头
      expect(text).toContain("share │ trend")
            // #181：activity 已并入顶表
      expect(text).not.toContain("Model activity rows")
      expect(text).not.toContain("Provider trend rows")
      for (const line of text.split("\n")) {
        // ignore ANSI-ish; plain visible length via string length upper bound
        expect(line.replace(/\x1b\[[0-9;]*m/g, "").length).toBeLessThanOrEqual(120)
      }
    })
  })

    // #181：窄屏折叠 trend，避免碎列
  test("narrow dashboard drops trend column", () => {
    withColumns(58, () => {
      const text = renderDashboard(report, { limit: 5 })
      expect(text).toContain("Top models")
            // #181：窄屏不得残留 trend 表头
      expect(text).not.toContain("│ trend")
      expect(text).not.toContain("Model activity rows")
    })
  })
})

describe("stats top table share (#181)", () => {
  test("share uses global total tokens not top-N sum", () => {
    // #181：两模型各 25/15，全局 total 200 → share 约 13%/8% 而非 62%/38%
    const report = {
      totalSessions: 1, sessionsWithUsage: 1, totalMessages: 1, totalTools: 0, days: 1,
      dateRange: { earliest: 0, latest: 1 },
      total: { tokens: { input: 100, output: 50, reasoning: 0, cache: { read: 0, write: 0 }, total: 200 }, cost: 1, requests: 1, assistantCalls: 1 },
      models: [
        { id: "m1", label: "m1", tokens: { input: 20, output: 5, reasoning: 0, cache: { read: 0, write: 0 }, total: 25 }, cost: 0.5, requests: 1, assistantCalls: 1, sessions: 1, providers: [], models: [] },
        { id: "m2", label: "m2", tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 }, total: 15 }, cost: 0.3, requests: 1, assistantCalls: 1, sessions: 1, providers: [], models: [] },
      ],
      providers: [], agents: [], sources: [], statuses: [], projects: [],
      daily: [], modelSeries: [], providerSeries: [], agentSeries: [], sourceSeries: [], statusSeries: [], projectSeries: [],
      tokenPartSeries: [], sessions: [], toolUsage: [], toolSeries: [], modelProviderTokens: [],
      tokensPerSession: 200, medianTokensPerSession: 200,
    } as unknown as StatsReport
    const text = renderDashboard(report as any, { limit: 5 })
    expect(text).toContain("13%") // 25/200
    expect(text).toContain("8%") // 15/200
    expect(text).not.toMatch(/62%/)
  })
})

describe("sparkline aggregation (#181)", () => {
  test("bucket max keeps spikes when values exceed width", async () => {
    // #181：超采样必须保留尖峰，不能被步进采样丢掉
    const { sparkline } = await import("../../src/cli/cmd/stats-charts")
    const values = Array.from({ length: 40 }, (_, i) => (i === 7 ? 100 : 1))
    const out = sparkline(values, 8)
    expect(out.length).toBe(8)
    expect(out).toContain("\u2588")
  })

  test("pads to width when values are fewer than columns", async () => {
    // #181：点数不足时右侧补末值，列宽稳定
    const { sparkline } = await import("../../src/cli/cmd/stats-charts")
    expect(sparkline([1, 2, 3], 6).length).toBe(6)
  })
})
