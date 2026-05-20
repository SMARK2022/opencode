import { describe, expect, test } from "bun:test"
import type { SessionID } from "../../src/session/schema"
import type { InputComponentTotals, StatsReport, TokenTotals, UsageTotals } from "../../src/cli/cmd/stats/data"
import { renderBreakdown, renderDashboard, renderSessions } from "../../src/cli/cmd/stats/render"
import { fitVisible, stripAnsi, truncateVisible, visibleLength } from "../../src/cli/cmd/stats/charts"

const day = 86_400_000
const start = Date.UTC(2026, 3, 27)

const tokens = (value: number): TokenTotals => ({
  input: value,
  output: value / 2,
  reasoning: 0,
  cache: { read: value * 3, write: value / 10 },
  total: value + value / 2 + value * 3 + value / 10,
})

const components = (): InputComponentTotals => ({
  system: 0,
  instructions: 0,
  skills: 0,
  toolSchemas: 0,
  userMessages: 0,
  assistantText: 0,
  reasoning: 0,
  toolCalls: 0,
  toolResults: 0,
  attachments: 0,
})

const usage = (value: number, cost: number, requests: number, calls: number, errors = 0, durationMs = 0): UsageTotals => ({
  tokens: tokens(value),
  components: components(),
  cost,
  requests,
  assistantCalls: calls,
  errors,
  aborted: 0,
  durationMs,
})

const contextUsage = (value: number): UsageTotals => ({
  tokens: {
    input: value,
    output: 0,
    reasoning: 0,
    cache: { read: 0, write: 0 },
    total: value,
  },
  components: components(),
  cost: 0,
  requests: 0,
  assistantCalls: 0,
  errors: 0,
  aborted: 0,
  durationMs: 0,
})

const addUsage = (items: UsageTotals[]): UsageTotals =>
  items.reduce(
    (acc, item) => ({
      tokens: {
        input: acc.tokens.input + item.tokens.input,
        output: acc.tokens.output + item.tokens.output,
        reasoning: acc.tokens.reasoning + item.tokens.reasoning,
        cache: {
          read: acc.tokens.cache.read + item.tokens.cache.read,
          write: acc.tokens.cache.write + item.tokens.cache.write,
        },
        total: acc.tokens.total + item.tokens.total,
      },
      components: components(),
      cost: acc.cost + item.cost,
      requests: acc.requests + item.requests,
      assistantCalls: acc.assistantCalls + item.assistantCalls,
      errors: acc.errors + item.errors,
      aborted: acc.aborted + item.aborted,
      durationMs: acc.durationMs + item.durationMs,
    }),
    usage(0, 0, 0, 0),
  )

const report = (): StatsReport => {
  const daily = [20, 80, 12, 160, 35, 200].map((value, index) => ({
    day: start + index * day,
    label: `5月${index + 1}`,
    ...usage(value * 1_000_000, value / 4, value, value * 3, index === 1 ? 2 : 0, value * 60_000),
  }))
  const total = addUsage(daily)
  const group = (id: string, multiplier: number) => ({
    id,
    label: id,
    ...usage(total.tokens.input * multiplier, total.cost * multiplier, Math.round(total.requests * multiplier), Math.round(total.assistantCalls * multiplier), 0, total.durationMs * multiplier),
    sessions: Math.max(1, Math.round(8 * multiplier)),
    providers: [],
    models: [],
  })
  const part = (id: "input" | "output" | "cacheRead" | "cacheWrite", label: string, pick: (input: TokenTotals) => number) => ({
    id,
    label,
    points: daily.map((item) => ({ day: item.day, label: item.label, value: pick(item.tokens) })),
    total: daily.reduce((sum, item) => sum + pick(item.tokens), 0),
  })
  const series = (item: ReturnType<typeof group>) => ({
    ...item,
    points: daily.map((point) => ({
      ...point,
      ...usage(point.tokens.input * (item.id.includes("claude") ? 1 : 0.35), point.cost * (item.id.includes("claude") ? 1 : 0.35), point.requests, point.assistantCalls),
    })),
  })
  const toolTrend = (id: string, values: number[]) => ({
    id,
    label: id,
    ...addUsage(values.map(contextUsage)),
    points: daily.map((point, index) => ({
      day: point.day,
      label: point.label,
      ...contextUsage(values[index] ?? 0),
    })),
  })

  return {
    totalSessions: 8,
    sessionsWithUsage: 6,
    totalMessages: 40,
    totalTools: 120,
    days: daily.length,
    requestedDays: 0,
    dateRange: { earliest: start, latest: start + (daily.length - 1) * day },
    total,
    models: [group("claude-opus-4-6", 0.6), group("gpt-5.5", 0.4)],
    providers: [group("DaXiao Codex", 0.7), group("本地提供商", 0.3)],
    agents: [group("build", 1)],
    sources: [group("prompt", 1)],
    statuses: [group("completed", 1)],
    projects: [group("本地项目", 1)],
    daily,
    modelSeries: [series(group("claude-opus-4-6", 0.6)), series(group("gpt-5.5", 0.4))],
    providerSeries: [series(group("DaXiao Codex", 0.7)), series(group("本地提供商", 0.3))],
    agentSeries: [series(group("build", 1))],
    sourceSeries: [series(group("prompt", 1))],
    statusSeries: [series(group("completed", 1))],
    projectSeries: [series(group("本地项目", 1))],
    toolSeries: [toolTrend("apply_patch", [80, 100, 90, 180, 150, 200]), toolTrend("bash", [20, 40, 30, 100, 110, 300])],
    tokenPartSeries: [
      part("input", "Input", (item) => item.input),
      part("output", "Output + Reasoning", (item) => item.output + item.reasoning),
      part("cacheRead", "Cache Read", (item) => item.cache.read),
      part("cacheWrite", "Cache Write", (item) => item.cache.write),
    ],
    sessions: [
      {
        id: "ses_cjk" as SessionID,
        title: "分支与dev分支合并冲突检测",
        projectID: "project",
        directory: "/tmp/project",
        created: start,
        updated: start + day,
        messages: 12,
        tools: 8,
        providers: ["anthropic"],
        models: ["claude-opus-4-6", "deepseek-v4-pro"],
        ...usage(70_000_000, 30, 12, 90, 1, 600_000),
      },
      {
        id: "ses_long" as SessionID,
        title: "README文档更新与中文本地化",
        projectID: "project",
        directory: "/tmp/project",
        created: start,
        updated: start + day * 2,
        messages: 8,
        tools: 5,
        providers: ["openai"],
        models: ["gpt-5.5"],
        ...usage(20_000_000, 3, 6, 20, 0, 400_000),
      },
    ],
    toolUsage: [
      { id: "apply_patch", count: 70, inputChars: 1200, outputChars: 2400, contextTokens: 800 },
      { id: "bash", count: 50, inputChars: 900, outputChars: 1800, contextTokens: 600 },
    ],
    modelProviderTokens: [{ providerID: "DaXiao Codex", modelID: "claude-opus-4-6", tokens: 1000 }],
    tokensPerSession: total.tokens.total / 6,
    medianTokensPerSession: 20_000_000,
  }
}

const withColumns = (columns: number, run: () => void) => {
  const original = Object.getOwnPropertyDescriptor(process.stdout, "columns")
  Object.defineProperty(process.stdout, "columns", { value: columns, configurable: true })
  try {
    run()
  } finally {
    if (original) Object.defineProperty(process.stdout, "columns", original)
  }
}

describe("stats render width", () => {
  test("counts CJK text by terminal display columns", () => {
    expect(visibleLength("中文abc")).toBe(7)
    expect(visibleLength(fitVisible("中文", 6))).toBe(6)
    expect(visibleLength(truncateVisible("中文abc", 5))).toBe(5)
  })

  test("keeps CJK-heavy dashboard and session output fixed-width", () => {
    for (const columns of [80, 120]) {
      withColumns(columns, () => {
        for (const output of [renderDashboard(report(), { color: "always" }), renderSessions(report(), { color: "always" })]) {
          const widths = new Set(output.split("\n").map(visibleLength))
          expect(widths).toEqual(new Set([columns - 2]))
        }
      })
    }
  })

  test("renders dashboard as the new responsive sectioned overview", () => {
    withColumns(120, () => {
      const output = renderDashboard(report(), { color: "never" })
      expect(output).toContain("━━━ Daily activity")
      expect(output).toContain("Calendar · cell intensity = daily tokens")
      expect(output).toContain("Mon Tue Wed Thu Fri Sat Sun")
      expect(output).toContain("legend  · =0")
      expect(output).toContain("Token components · small multiples")
      expect(output).toContain("Cost & health trends")
      expect(output).toContain("Top models · by token volume")
      expect(output).toContain("Top providers · share of total tokens")
      expect(output).toContain("━━━ Sessions")
      expect(output).toContain("━━━ Insights")
      expect(output.indexOf("Error rate (errors per 100 req)")).toBeLessThan(output.indexOf("Cache hit rate (%)"))
      expect(output).not.toContain("Cumulative spend")
      expect(output).not.toContain("Why small multiples")
      expect(output).not.toContain("Model mix over time")
      expect(new Set(output.split("\n").map(visibleLength))).toEqual(new Set([118]))
    })
  })

  test("renders dashboard token components as auto-normalized small multiples", () => {
    withColumns(160, () => {
      const output = renderDashboard(report(), { color: "never" })
      expect(output).toContain("Cache Read")
      expect(output).toContain("Input")
      expect(output).toContain("Cache Write")
      expect(output).toContain("Output")
      expect(output.indexOf("Cache hit rate (%)")).toBeLessThan(output.indexOf("Error rate (errors per 100 req)"))
      expect(output).not.toContain("■ Cache Read · ■ Input · ■ Cache Write · ■ Output")
      expect(output).not.toContain("● cost")
      expect(output).not.toContain("● cache")
      expect(output).not.toContain("● errors")
      expect(output.split("\n").some((line) => ["▓ Cache Read", "░ Input", "▒ Cache Write", "▎ Output"].includes(line.trim()))).toBe(false)
      expect(new Set(output.split("\n").map(visibleLength))).toEqual(new Set([158]))
    })
  })

  test("does not truncate dashboard rows with ellipses", () => {
    for (const columns of [80, 120, 160]) {
      withColumns(columns, () => {
        expect(renderDashboard(report(), { color: "never" })).not.toContain("…")
      })
    }
  })

  test("keeps calendar monochrome while spacing provider legend columns", () => {
    withColumns(80, () => {
      const lines = renderDashboard(report(), { color: "always" }).split("\n")
      const start = lines.findIndex((line) => stripAnsi(line).includes("Calendar · cell intensity"))
      const end = lines.findIndex((line, index) => index > start && stripAnsi(line).includes("Hour-of-day"))
      expect(lines.slice(start, end).join("\n")).not.toContain("\x1b[38;2")

      const hourStart = end
      const hourEnd = lines.findIndex((line, index) => index > hourStart && stripAnsi(line).includes("Day-of-week"))
      expect(lines.slice(hourStart, hourEnd).join("\n")).not.toContain("\x1b[38;2")
    })

    withColumns(160, () => {
      const output = renderDashboard(report(), { color: "never" })
      expect(output).toContain("DaXiao Codex")
      expect(output).toMatch(/DaXiao Codex.* {4,}█ 本地提供商/)
    })
  })

  test("uses differentiated session distribution colors", () => {
    withColumns(160, () => {
      const lines = renderDashboard(report(), { color: "always" }).split("\n")
      const start = lines.findIndex((line) => stripAnsi(line).includes("Session size distribution"))
      const bucketLines = lines.slice(start, start + 8).filter((line) => /<100K|100K-1M|1M-5M|5M-50M|>50M/.test(stripAnsi(line)))
      const colors = new Set(bucketLines.flatMap((line) => Array.from(line.matchAll(/\x1b\[38;2;[^m]+m/g), (match) => match[0])))
      expect(colors.size).toBeGreaterThan(1)
    })
  })

  test("keeps breakdown rank bars from being double-truncated", () => {
    withColumns(140, () => {
      const toolOutput = renderBreakdown(report(), { color: "never", by: "tool" })
      expect(toolOutput).toContain("Tool context tokens over time")
      for (const output of [toolOutput, renderBreakdown(report(), { color: "never", by: "source" })]) {
        const widths = new Set(output.split("\n").map(visibleLength))
        expect(widths).toEqual(new Set([138]))
        expect(output).not.toContain("ctx tok ·")
        expect(output).not.toContain("…")
      }
    })
  })
})
