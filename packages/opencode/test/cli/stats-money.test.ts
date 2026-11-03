import { expect, test } from "bun:test"
import {
  renderCharts,
  renderCosts,
  renderModels,
  renderProviders,
  renderSessions,
  renderTokens,
} from "../../src/cli/cmd/stats-render"
import type { StatsReport } from "../../src/cli/cmd/stats-data"
import { emptyComponents } from "../../src/cli/cmd/stats-data"
import { formatNumber } from "../../src/cli/format"
import { renderHeatmap, renderRoundedLineChart } from "../../src/cli/cmd/stats-charts"

test("small costs survive total, model, daily and session rendering", () => {
  // 最小报告只提供这些真实 renderer 消费的字段，金额断言不能仅验证 formatter 本身。
  const tokens = { input: 80, output: 10, reasoning: 10, cache: { read: 0, write: 0 }, total: 100 }
  const report = {
    totalSessions: 1,
    sessionsWithUsage: 1,
    days: 1,
    dateRange: { earliest: 0, latest: 0 },
    total: {
      cost: 0.25,
      tokens,
      components: emptyComponents(),
      requests: 1,
      assistantCalls: 2,
      errors: 0,
      aborted: 0,
      durationMs: 0,
    },
    models: [
      {
        id: "sample-model",
        label: "sample-model",
        cost: 0.25,
        tokens,
        components: emptyComponents(),
        assistantCalls: 2,
        requests: 1,
        sessions: 1,
        errors: 0,
        aborted: 0,
        durationMs: 0,
        models: [],
        providers: [],
      },
    ],
    providers: [
      {
        id: "sample-provider",
        label: "sample-provider",
        cost: 0.25,
        tokens,
        components: emptyComponents(),
        models: [],
        providers: [],
      },
    ],
    modelSeries: [],
    providerSeries: [],
    agentSeries: [],
    sourceSeries: [],
    projectSeries: [],
    statusSeries: [],
    agents: [],
    sources: [],
    projects: [],
    statuses: [],
    toolCalls: [],
    toolUsage: [],
    toolSeries: [],
    tokensPerSession: 100,
    medianTokensPerSession: 100,
    daily: [{ day: 0, label: "day", cost: 0.25, tokens, requests: 1, errors: 0, aborted: 0, durationMs: 0 }],
    sessions: [
      {
        id: "sample-session",
        title: "sample-session",
        projectID: "project",
        cost: 0.25,
        tokens,
        models: [],
        providers: [],
        requests: 1,
        assistantCalls: 2,
        messages: 1,
        tools: 0,
        errors: 0,
        aborted: 0,
        durationMs: 0,
      },
    ],
  } as unknown as StatsReport
  const costs = renderCosts(report, { color: "never" })
  expect(costs).toContain("cost=0.25")
  expect(costs).toMatch(/sample-model[^\n]*0\.25/)
  expect(costs).toMatch(/day[^\n]*0\.25/)
  expect(renderSessions(report, { color: "never" })).toMatch(/sample-session[\s\S]*\$0\.2500/)
  expect(formatNumber(100)).toBe("100")
  expect(formatNumber(1000)).toBe("1.0K")
  expect(formatNumber(0.001)).toBe("0.001")
  expect(costs).toContain("Provider cost waterfall")
  expect(costs).toContain("Session cost distribution")
  expect(renderModels(report)).toMatch(/calls=2 requests=1 sessions=1/)
  expect(renderTokens(report)).toContain("input=80 output=20")
  expect(renderCharts(report)).toContain("Model mix over time")
  // 费用序与 token/calls 序相反，才能发现先限行或沿用费用顺序选错 Top1。
  const groups = report.models.flatMap((group) => [
    { ...group, id: "cost-top", label: "cost-top", cost: 10, tokens, assistantCalls: 1 },
    { ...group, id: "token-top", label: "token-top", cost: 1, tokens: { ...tokens, total: 10000 }, assistantCalls: 2 },
  ])
  const ranked = { ...report, models: groups, providers: groups }
  for (const render of [renderModels, renderProviders]) {
    for (const sort of ["cost", "tokens", "calls"] as const) {
      const text = render(ranked, { color: "never", limit: 1, sort })
      const first = sort === "cost" ? "cost-top" : "token-top"
      expect(text).toContain(first)
      // 新定量面板会再次显示实体；分别锁定排名和原明细各一次，不能用整页次数限制完整信息。
      const detailAt = text.indexOf(`${first} cost=`)
      expect(detailAt).toBeGreaterThanOrEqual(0)
      expect(text.slice(0, detailAt).split(first)).toHaveLength(2)
      expect(text.split(`${first} cost=`)).toHaveLength(2)
      expect(text).not.toContain(sort === "cost" ? "token-top" : "cost-top")
    }
  }
  expect(groups.map((group) => group.id)).toEqual(["cost-top", "token-top"])
  // 完整月份的两个端点都必须保留，不能只渲染最后十二日。
  const points = Array.from({ length: 31 }, (_, index) => ({
    day: new Date(2026, 0, index + 1).getTime(),
    dow: (new Date(2026, 0, index + 1).getDay() + 6) % 7,
    value: index,
    label: `01-${String(index + 1).padStart(2, "0")}`,
  }))
  expect(renderHeatmap({ points }).join("\n")).toContain("01-01 .. 01-31")
})

test("line charts retain every series and its identity", () => {
  // 相异的值与名称保证预测上下界、多个工具都被消费，而非仅输出一条序列。
  const text = renderRoundedLineChart({
    series: [
      { id: "lower", label: "lower-bound", points: [{ x: "day", y: 1 }] },
      { id: "upper", label: "upper-bound", points: [{ x: "day", y: 9 }] },
    ],
  }).join("\n")
  expect(text).toContain("lower-bound")
  expect(text).toContain("upper-bound")
  expect(text).toMatch(/day[^\n]*9/)
  // 宽度只约束显示，不能丢掉长区间的早期峰值或末端日期。
  const full = renderRoundedLineChart({
    width: 20,
    series: [
      {
        id: "full",
        label: "Full",
        points: Array.from({ length: 75 }, (_, day) => ({ x: `day-${day}`, y: day === 0 ? 999 : 1 })),
      },
    ],
  }).join("\n")
  expect(full).toMatch(/day-0[^\n]*999/)
  expect(full).toContain("day-74")
})
