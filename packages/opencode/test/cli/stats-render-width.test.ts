import { describe, expect, test } from "bun:test"
import { fitVisible, paint, renderContext, renderHeatmap, stripAnsi, truncateVisible, visibleLength } from "../../src/cli/cmd/stats-charts"
import { renderBreakdown, renderCharts, renderCosts, renderDashboard, renderHeatmapPage, renderModels, renderOverview, renderProviders, renderSessions, renderTimeline, renderTokens } from "../../src/cli/cmd/stats-render"
import { renderForecast, renderInsights } from "../../src/cli/cmd/stats-insights"
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

describe("stats dashboard sectioned overview (#182)", () => {
  const report = {
    totalSessions: 2, sessionsWithUsage: 2, totalMessages: 2, totalTools: 0, days: 2,
    dateRange: { earliest: 0, latest: 2 },
    total: { tokens: { input: 100, output: 40, reasoning: 0, cache: { read: 50, write: 10 }, total: 200 }, cost: 2, requests: 10, assistantCalls: 10, errors: 2, aborted: 1 },
    models: [{ id: "m1", label: "model-one", tokens: { input: 20, output: 5, reasoning: 0, cache: { read: 0, write: 0 }, total: 25 }, cost: 1, requests: 2, assistantCalls: 2, errors: 0, aborted: 0, sessions: 1, providers: [], models: [] }],
    providers: [{ id: "p1", label: "provider-one", tokens: { input: 30, output: 10, reasoning: 0, cache: { read: 0, write: 0 }, total: 40 }, cost: 1.5, requests: 3, assistantCalls: 3, errors: 0, aborted: 0, sessions: 2, providers: [], models: [] }],
    agents: [], sources: [], statuses: [], projects: [],
    daily: [
      { day: 1, label: "d1", tokens: { input: 50, output: 20, reasoning: 0, cache: { read: 25, write: 5 }, total: 100 }, cost: 1, requests: 5, assistantCalls: 5, errors: 1, aborted: 0 },
      { day: 2, label: "d2", tokens: { input: 50, output: 20, reasoning: 0, cache: { read: 25, write: 5 }, total: 100 }, cost: 1, requests: 5, assistantCalls: 5, errors: 1, aborted: 1 },
    ],
    modelSeries: [], providerSeries: [], agentSeries: [], sourceSeries: [], statusSeries: [], projectSeries: [],
    tokenPartSeries: [
      { id: "input", label: "Input", points: [{ day: 1, label: "a", value: 10 }, { day: 2, label: "b", value: 90 }], total: 100 },
      { id: "output", label: "Output", points: [{ day: 1, label: "a", value: 5 }, { day: 2, label: "b", value: 35 }], total: 40 },
      { id: "cacheRead", label: "Cache Read", points: [{ day: 1, label: "a", value: 20 }, { day: 2, label: "b", value: 30 }], total: 50 },
      { id: "cacheWrite", label: "Cache Write", points: [{ day: 1, label: "a", value: 4 }, { day: 2, label: "b", value: 6 }], total: 10 },
    ],
    sessions: [
      { id: "s1" as any, title: "big", projectID: "p", directory: "/", created: 1, updated: Date.UTC(2026, 3, 27, 3), messages: 1, tools: 0, providers: [], models: [], tokens: { input: 80, output: 40, reasoning: 0, cache: { read: 0, write: 0 }, total: 120000 }, cost: 1, requests: 1, assistantCalls: 1, errors: 0, aborted: 0 },
      { id: "s2" as any, title: "tiny", projectID: "p", directory: "/", created: 1, updated: Date.UTC(2026, 3, 28, 15), messages: 1, tools: 0, providers: [], models: [], tokens: { input: 5, output: 2, reasoning: 0, cache: { read: 0, write: 0 }, total: 7 }, cost: 0.1, requests: 1, assistantCalls: 1, errors: 0, aborted: 0 },
    ],
    toolUsage: [], toolSeries: [], modelProviderTokens: [], tokensPerSession: 15, medianTokensPerSession: 15,
  } as unknown as StatsReport

  test("renders sections, trends and session distribution", () => {
    // #182：分区标题、趋势、分桶与失败率必须出现
    const text = renderDashboard(report as any, { limit: 5 })
    expect(text).toContain("Daily activity")
    expect(text).toContain("Token components")
    expect(text).toMatch(/Input[^\n]*total=100 peak=90/)
    expect(text).toContain("Cost & health")
    expect(text).toContain("Session size distribution")
    expect(text).toContain("p90=120.0K p99=120.0K")
    expect(text).toContain("top-10=")
    expect(text).toContain("Top sessions by tokens")
    expect(text).toContain("big")
    expect(text).toMatch(/cost trend/)
    expect(text).toMatch(/cache-hit trend/)
    // #182：日失败率趋势必须存在
    expect(text).toMatch(/error-rate trend/)
    expect(text).toMatch(/Input\s+[\u2581-\u2588]+/)
    expect(text).toContain("Cache hit (%): 25")
    expect(text).not.toContain("Model activity rows")
    for (const columns of [58, 80]) {
      const previous = process.stdout.columns
      Object.defineProperty(process.stdout, "columns", { configurable: true, value: columns })
      try {
        const lines = renderDashboard({ ...report, tokenPartSeries: [{ id: "output", label: "Output + Reasoning", total: 1_000_000, points: [{ day: 1, label: "d1", value: 1_000_000 }] }] }).split("\n")
        const index = lines.findIndex((line) => line.includes("Output + Reasoning"))
        expect(index).toBeGreaterThanOrEqual(0)
        expect(lines[index].length).toBeLessThanOrEqual(columns)
        expect(lines[index + 1].length).toBeLessThanOrEqual(columns)
        expect(lines.slice(index, index + 2).join(" ")).toContain("total=1.0M peak=1.0M")
      } finally {
        Object.defineProperty(process.stdout, "columns", { configurable: true, value: previous })
      }
    }
  })

  test("keeps cross-day session tokens on local usage weekdays", () => {
    // #182：同一会话周一、周二各用 100 token，周二续聊不能搬走周一用量
    const monday = new Date(2026, 3, 27).getTime()
    const tuesday = new Date(2026, 3, 28).getTime()
    // 此用例检查日期和权重，固定窄屏使独立行断言不受宽屏多列排版影响。
    const text = (() => {
      const width = process.stdout.columns
      Object.defineProperty(process.stdout, "columns", { configurable: true, value: 58 })
      try { return renderDashboard({
      ...report,
      totalSessions: 1,
      sessionsWithUsage: 1,
      dateRange: { earliest: monday, latest: tuesday },
      daily: [
        { ...report.daily[0], day: monday, label: "04-27" },
        { ...report.daily[1], day: tuesday, label: "04-28" },
      ],
      sessions: [{ ...report.sessions[0], ...report.total, requests: 100, created: monday, updated: new Date(2026, 3, 28, 9).getTime() }, { ...report.sessions[1], requests: 1, updated: new Date(2026, 3, 28, 15).getTime() }],
      }) } finally {
        Object.defineProperty(process.stdout, "columns", { configurable: true, value: width })
      }
    })()
    const lines = text.split("\n")
    const start = lines.indexOf("Day of week share")
    expect(start).toBeGreaterThanOrEqual(0)
    expect(lines.slice(start + 1, start + 8).map((line) => Number(line.split(" ").at(-1)))).toEqual([100, 100, 0, 0, 0, 0, 0])
    // 日历必须能定位周起点，小时图必须按本地请求量而非会话数计权。
    const calendar = lines.indexOf("Calendar activity")
    expect(lines[calendar + 1]).toContain("M T W T F S S")
    expect(lines[calendar + 2]).toContain("04-27")
    const hour = lines[lines.indexOf("Hour of day") + 1]
    expect(hour?.[11]).toBe("█")
    expect(hour?.[17]).toBe("·")
  })

  test("abort and error rate comes from report totals", () => {
    // #182：3 次失败/10 次请求 => 30%
    const text = renderDashboard(report as any, { limit: 5 })
    expect(text).toContain("Abort & error rate (%): 30")
    expect(text).not.toContain("Abort & error rate (%): n/a")
    expect(text).toMatch(/Failed\/aborted requests: 3 \(30%\)/)
  })
})

describe("stats humanized labels (#183)", () => {
  test("production dateLabel uses local MM-DD without locale month glyphs", async () => {
    // #183：必须 import 生产 dateLabel，禁止测试内克隆实现
    const { dateLabel } = await import("../../src/cli/cmd/stats-data")
    const localMidnight = new Date(2026, 3, 27, 0, 0, 0, 0).getTime()
    expect(dateLabel(localMidnight)).toBe("04-27")
    expect(dateLabel(localMidnight)).not.toMatch(/月/)
    // #183：与 dayStart 本地日界一致：当日 15:00 仍标 04-27
    const afternoon = new Date(2026, 3, 27, 15, 0, 0, 0).getTime()
    expect(dateLabel(afternoon)).toBe("04-27")
  })

  test("top models table includes per-call column", () => {
    // #183：人性化顶表含 per-call
    const report = {
      totalSessions: 1, sessionsWithUsage: 1, totalMessages: 1, totalTools: 0, days: 1,
      dateRange: { earliest: 0, latest: 1 },
      total: { tokens: { input: 20, output: 5, reasoning: 0, cache: { read: 0, write: 0 }, total: 25 }, cost: 1, requests: 1, assistantCalls: 5, errors: 0, aborted: 0 },
      models: [{ id: "m1", label: "model-one", tokens: { input: 20, output: 5, reasoning: 0, cache: { read: 0, write: 0 }, total: 25 }, cost: 1, requests: 1, assistantCalls: 5, errors: 0, aborted: 0, sessions: 1, providers: [], models: [] }],
      providers: [], agents: [], sources: [], statuses: [], projects: [],
      daily: [], modelSeries: [], providerSeries: [], agentSeries: [], sourceSeries: [], statusSeries: [], projectSeries: [],
      tokenPartSeries: [], sessions: [], toolUsage: [], toolSeries: [], modelProviderTokens: [],
      tokensPerSession: 25, medianTokensPerSession: 25,
    } as unknown as StatsReport
    expect(renderDashboard(report as any, { limit: 5 })).toContain("per-call")
    const large = renderDashboard({ ...report, models: report.models.map((model) => ({ ...model, tokens: { ...model.tokens, total: 1_000_000_000 } })) }, { limit: 5 })
    expect(large).toContain("1.0B")
    expect(large).toContain("200.0M")
    // 在真实 58 列输入下检查表头和数据行，而不是只断言趋势列隐藏。
    const previous = process.stdout.columns
    Object.defineProperty(process.stdout, "columns", { configurable: true, value: 58 })
    try {
      const lines = renderDashboard(report, { limit: 5 }).split("\n")
      const start = lines.indexOf("▸ Top models")
      expect(start).toBeGreaterThanOrEqual(0)
      expect(lines[start + 1].length).toBeLessThanOrEqual(58)
      expect(lines[start + 2].length).toBeLessThanOrEqual(58)
    } finally {
      Object.defineProperty(process.stdout, "columns", { configurable: true, value: previous })
    }
  })
})

  // 固定真实宽度owner，环境变量COLUMNS不会改变process.stdout.columns。
  const withColumns = (cols: number, fn: () => void) => {
    const prev = Object.getOwnPropertyDescriptor(process.stdout, "columns")
    Object.defineProperty(process.stdout, "columns", { configurable: true, value: cols })
    try {
      fn()
    } finally {
      if (prev) Object.defineProperty(process.stdout, "columns", prev)
      else Reflect.deleteProperty(process.stdout, "columns")
    }
  }
  // 空报告构造：全空集合 + 零总量，R6 空态前景/背景安全契约的输入。
  const emptyReport = () => ({
    totalSessions: 0, sessionsWithUsage: 0, totalMessages: 0, totalTools: 0, days: 0,
    dateRange: { earliest: 0, latest: 0 },
    total: { tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 }, total: 0 }, cost: 0, requests: 0, assistantCalls: 0 },
    models: [], providers: [], agents: [], sources: [], statuses: [], projects: [],
    daily: [], modelSeries: [], providerSeries: [], agentSeries: [], sourceSeries: [],
    statusSeries: [], projectSeries: [], tokenPartSeries: [], sessions: [], toolUsage: [],
    modelProviderTokens: [], tokensPerSession: 0, medianTokensPerSession: 0,
  } as unknown as StatsReport)
  // 具体背景色扫描：40-47/100-107 与 24-bit/256 色背景均视为违规。
  const concreteBackgroundAnsi = (s: string) => s.match(/\x1b\[(?:4[0-7]|10[0-7])m|\x1b\[48;(?:2|5)[^\x1b]*/g) ?? []

  test("emits the R6 bright ANSI palette contract", () => {
    // 直接检查发射的槽位与强度复位；纯文本图元不恢复已不存在的Canvas状态机。
    const desc = Object.getOwnPropertyDescriptor(process.stdout, "isTTY")
    try {
      Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true })
      const ctx = renderContext("always")
      expect(paint("x", "blue", ctx)).toContain("\x1b[94m")
      expect(paint("x", "green", ctx)).toContain("\x1b[92m")
      expect(paint("x", "yellow", ctx)).toContain("\x1b[93m")
      expect(paint("x", "red", ctx)).toContain("\x1b[91m")
      expect(paint("x", "magenta", ctx)).toContain("\x1b[95m")
      expect(paint("x", "cyan", ctx)).toContain("\x1b[96m")
      expect(paint("x", "white", ctx)).toBe("\x1b[22m\x1b[39m\x1b[39mx\x1b[0m")
      // bright 前景不得携带 SGR dim（2）——dim 仅属于网格/低优先级结构。
      for (const color of ["blue", "green", "yellow", "red", "magenta", "cyan"] as const) {
        expect(paint("x", color, ctx)).toStartWith("\x1b[22m\x1b[39m")
        expect(paint("x", color, ctx)).not.toMatch(/\x1b\[2(?:;|m)/)
      }
    } finally {
      if (desc) Object.defineProperty(process.stdout, "isTTY", desc)
      else Reflect.deleteProperty(process.stdout, "isTTY")
    }
  })

  test("keeps colored empty reports safe under the R6 foreground and background contract", () => {
    // 空报告彩色输出不得含 24-bit RGB 前景或具体背景色。
    withColumns(120, () => {
      const input = emptyReport()
      const renders = [renderDashboard, renderOverview, renderModels, renderProviders, renderTimeline, renderSessions, renderCharts, renderHeatmapPage, renderCosts, renderTokens, renderInsights, renderForecast]
      const outputs = [
        ...renders.map((render) => ({ colored: render(input, { color: "always" }), plain: render(input, { color: "never" }) })),
        ...(["model", "provider", "agent", "source", "project", "tool", "status"] as const).map((by) => ({ colored: renderBreakdown(input, { color: "always", by }), plain: renderBreakdown(input, { color: "never", by }) })),
      ]
      for (const output of outputs) {
        expect(output.colored).not.toContain("\x1b[38;2;")
        expect(concreteBackgroundAnsi(output.colored)).toEqual([])
        // 不能两侧都剥色，否则never泄漏会被等价断言掩盖。
        expect(output.plain).not.toContain("\x1b[")
        expect(stripAnsi(output.colored)).toBe(output.plain)
        for (const line of output.colored.split("\n")) expect(visibleLength(line)).toBeLessThanOrEqual(120)
      }
    })
  })

  test("respects color mode precedence with NO_COLOR truthy contract", () => {
    // R6 truthy NO_COLOR 语义由 renderContext 生产实现承载：always 恒开、never 恒关、
    // auto 在非 TTY 或非空 NO_COLOR 下禁用；空字符串按 truthiness 等同未设置。
    // isTTY 桩为 true，使 auto 分支对 NO_COLOR 回归可失败（而非恒 never 空转）。
    const originalNoColor = process.env.NO_COLOR
    const ttyDesc = Object.getOwnPropertyDescriptor(process.stdout, "isTTY")
    try {
      Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true })
      // auto + TTY + NO_COLOR 未设置 → 彩色。
      delete process.env.NO_COLOR
      expect(renderContext("auto").color).toBe("auto")
      // auto + TTY + NO_COLOR="" → 彩色（空串按 truthiness 等同未设置）。
      process.env.NO_COLOR = ""
      expect(renderContext("auto").color).toBe("auto")
      // auto + TTY + NO_COLOR="1" → 纯文本（非空字符串禁用）。
      process.env.NO_COLOR = "1"
      expect(renderContext("auto").color).toBe("never")
      // always 无视 NO_COLOR；never 恒关。
      expect(renderContext("always").color).toBe("always")
      expect(renderContext("never").color).toBe("never")
      // auto + 非 TTY → 纯文本。
      Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true })
      delete process.env.NO_COLOR
      expect(renderContext("auto").color).toBe("never")
      expect(paint("x", "red", renderContext("always"))).toContain("\x1b[91m")
      expect(paint("\x1b[31mx\x1b[0m", "red", renderContext("never"))).toBe("x")
      // 端到端：paint 必须消费 renderContext 的裁决——NO_COLOR=1 + isTTY=true 时
      // paint 输出不得携带 ANSI（对回归可失败的输出面断言，非仅模式字段）。
      Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true })
      process.env.NO_COLOR = "1"
      expect(paint("x", "red", renderContext("auto"))).toBe("x")
      expect(paint("x", "red", renderContext("always"))).toContain("\x1b[91m")
      delete process.env.NO_COLOR
      expect(paint("x", "red", renderContext("auto"))).toContain("\x1b[91m")
      // 页面级端到端：dashboard/heatmap 标题发射点必须消费模式裁决。
      const dashNever = renderDashboard(emptyReport(), { color: "never" })
      expect(dashNever).not.toMatch(/\x1b\[/)
      // auto + TTY + NO_COLOR="1" → 页面级纯文本（契约核心断言）。
      process.env.NO_COLOR = "1"
      const dashNoColor = renderDashboard(emptyReport(), { color: "auto" })
      expect(dashNoColor).not.toMatch(/\x1b\[/)
      const costsNever = renderCosts(emptyReport(), { color: "never" })
      expect(costsNever).not.toMatch(/\x1b\[/)
      const tokensNever = renderTokens(emptyReport(), { color: "never" })
      expect(tokensNever).not.toMatch(/\x1b\[/)
      const costsNoColor = renderCosts(emptyReport(), { color: "auto" })
      expect(costsNoColor).not.toMatch(/\x1b\[/)
      const tokensNoColor = renderTokens(emptyReport(), { color: "auto" })
      expect(tokensNoColor).not.toMatch(/\x1b\[/)
      delete process.env.NO_COLOR
      const dashAlways = renderDashboard(emptyReport(), { color: "always" })
      expect(dashAlways).toMatch(/\x1b\[95m/)
      const heatNever = renderHeatmap({ title: "hm", points: [], color: "never" })
      expect(heatNever.join("\n")).not.toMatch(/\x1b\[/)
    } finally {
      if (ttyDesc) Object.defineProperty(process.stdout, "isTTY", ttyDesc)
      else Reflect.deleteProperty(process.stdout, "isTTY")
      if (originalNoColor === undefined) delete process.env.NO_COLOR
      else process.env.NO_COLOR = originalNoColor
    }
  })
