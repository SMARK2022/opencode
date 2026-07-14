import { describe, expect, test } from "bun:test"
import { SessionID } from "../../src/session/schema"
import type { InputComponentTotals, StatsReport, TokenTotals, UsageTotals } from "../../src/cli/cmd/stats/data"
import { buildForecast, renderInsights } from "../../src/cli/cmd/stats/insights"
import { renderBreakdown, renderDashboard, renderModels, renderProviders, renderSessions, renderTimeline } from "../../src/cli/cmd/stats/render"
import { fitVisible, paint, renderContext, renderRoundedLineChart, stripAnsi, truncateVisible, useColor, visibleLength } from "../../src/cli/cmd/stats/charts"

const day = 86_400_000
const start = new Date(2026, 3, 27).getTime()

const tokens = (value: number): TokenTotals => ({
  input: value,
  output: value / 2,
  reasoning: 0,
  cache: { read: value * 3, write: value / 10 },
  total: value + value / 2 + value * 3 + value / 10,
})

const components = (value = 0): InputComponentTotals => ({
  system: value * 0.08,
  instructions: value * 0.05,
  skills: value * 0.04,
  toolSchemas: value * 0.12,
  userMessages: value * 0.24,
  assistantText: value * 0.1,
  reasoning: value * 0.04,
  toolCalls: value * 0.06,
  toolResults: value * 0.22,
  attachments: value * 0.05,
})

const usage = (value: number, cost: number, requests: number, calls: number, errors = 0, durationMs = 0): UsageTotals => ({
  tokens: tokens(value),
  components: components(value),
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
      components: {
        system: acc.components.system + item.components.system,
        instructions: acc.components.instructions + item.components.instructions,
        skills: acc.components.skills + item.components.skills,
        toolSchemas: acc.components.toolSchemas + item.components.toolSchemas,
        userMessages: acc.components.userMessages + item.components.userMessages,
        assistantText: acc.components.assistantText + item.components.assistantText,
        reasoning: acc.components.reasoning + item.components.reasoning,
        toolCalls: acc.components.toolCalls + item.components.toolCalls,
        toolResults: acc.components.toolResults + item.components.toolResults,
        attachments: acc.components.attachments + item.components.attachments,
      },
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
    projects: [{ ...group("本地项目", 1), path: "/tmp/本地项目" }],
    daily,
    // 合计与 total.requests 闭合，同时保留明确 peak/quiet 供 Dashboard 行为断言。
    requestsByHour: Array.from({ length: 24 }, (_, hour) => hour === 4 ? 374 : hour === 6 ? 7 : hour === 17 ? 126 : 0),
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
        id: SessionID.make("ses_cjk"),
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
        id: SessionID.make("ses_long"),
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
    // attribution fixture 与 toolUsage 总调用数一致，同时提供两个不同发起模型供 runtime mix 验证。
    toolCalls: [
      { toolID: "apply_patch", modelID: "claude-opus-4-6", providerID: "DaXiao Codex", agent: "build", projectID: "本地项目", source: "prompt", status: "completed", calls: 70, inputChars: 1200, outputChars: 2400, errors: 1, durationMs: 700 },
      { toolID: "bash", modelID: "gpt-5.5", providerID: "本地提供商", agent: "build", projectID: "本地项目", source: "prompt", status: "completed", calls: 50, inputChars: 900, outputChars: 1800, errors: 2, durationMs: 2500 },
    ],
    tokensPerSession: total.tokens.total / 6,
    medianTokensPerSession: 20_000_000,
  }
}

const emptyReport = () => {
  const input = report()
  input.totalSessions = 0
  input.sessionsWithUsage = 0
  input.totalMessages = 0
  input.totalTools = 0
  input.total = usage(0, 0, 0, 0)
  input.models = []
  input.providers = []
  input.agents = []
  input.sources = []
  input.statuses = []
  input.projects = []
  input.daily = input.daily.map((item) => ({ day: item.day, label: item.label, ...usage(0, 0, 0, 0) }))
  input.modelSeries = []
  input.providerSeries = []
  input.agentSeries = []
  input.sourceSeries = []
  input.statusSeries = []
  input.projectSeries = []
  input.toolSeries = []
  input.tokenPartSeries = input.tokenPartSeries.map((item) => ({ ...item, total: 0, points: item.points.map((point) => ({ ...point, value: 0 })) }))
  input.sessions = []
  input.toolUsage = []
  input.toolCalls = []
  input.tokensPerSession = 0
  input.medianTokensPerSession = 0
  return input
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

const calendarRows = (output: string) =>
  output
    .split("\n")
    .map(stripAnsi)
    .filter((line) => /^\s+\d{1,2}\s+[·░▒▓█]/.test(line))

const concreteBackgroundAnsi = (output: string) =>
  // SGR 可以把多个属性合在同一个 escape 里，例如 0;44m 或 39;48;5;12m；
  // 这里解析完整参数列表，确保只允许 49m 默认背景重置，不漏掉组合背景色。
  (output.match(/\x1b\[[0-9;]*m/g) ?? []).filter((code) => {
    const values = code.slice(2, -1).split(";").map(Number)
    for (let index = 0; index < values.length; index++) {
      const value = values[index]
      if ((value >= 40 && value <= 47) || (value >= 100 && value <= 107)) return true
      if (value === 48 && (values[index + 1] === 2 || values[index + 1] === 5)) return true
      if (value === 38 && values[index + 1] === 2) index += 4
      if (value === 38 && values[index + 1] === 5) index += 2
    }
    return false
  })

describe("stats render width", () => {
  test("counts CJK text by terminal display columns", () => {
    // 宽度 helper 是所有 panel 的公共边界；这里用中英文混排验证终端列而非字符串长度。
    // 若该断言回归，后续固定行宽测试会产生误报，因此先锁定最小 seam。
    expect(visibleLength("中文abc")).toBe(7)
    expect(visibleLength(fitVisible("中文", 6))).toBe(6)
    expect(visibleLength(truncateVisible("中文abc", 5))).toBe(5)
  })

  test("keeps CJK-heavy dashboard and session output fixed-width", () => {
    // Dashboard 与 Sessions 都包含用户可控中文标签，必须在颜色开启时仍保持整行宽度。
    // 80/120 分别覆盖堆叠布局和目标桌面布局。
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
    // 该测试锁定用户认可的主端点信息层级，子页面优化不得顺带重排 Dashboard。
    // 断言关注可见区块和顺序，不依赖内部 helper 名称。
    // 因此内部拆分或重命名不会造成无意义测试失败。
    withColumns(120, () => {
      const output = renderDashboard(report(), { color: "never" })
      expect(output).toContain("━━━ Daily activity")
      // Dashboard 的长时间轴必须保留全宽主图，不能只剩 Calendar 与三张局促小图。
      expect(output).toContain("Daily token volume")
      const lines = output.split("\n")
      const mainTitle = lines.findIndex((line) => stripAnsi(line).includes("Daily token volume"))
      const mainAxis = lines.slice(mainTitle + 1).find((line) => stripAnsi(line).includes("┄"))
      expect(visibleLength(stripAnsi(mainAxis ?? "").trimEnd())).toBeGreaterThan(100)
      expect(output).toContain("Calendar · cell intensity = daily tokens")
      expect(output).toMatch(/M\s+T\s+W\s+T\s+F\s+S\s+S/)
      expect(output).toContain("legend  · =0")
      expect(output).toContain("Token components")
      expect(output).toContain("Each panel auto-normalizes")
      expect(output).toContain("Cost & health trends")
      expect(output).toContain("Top models · by token volume")
      expect(output).toContain("Top providers · share of total tokens")
      expect(output).toContain("━━━ Sessions")
      expect(output).toContain("━━━ Insights")
      expect(output.indexOf("Abort & error rate")).toBeLessThan(output.indexOf("Cache hit rate (%)"))
      expect(output).not.toContain("Error rate (errors per 100 req)")
      expect(output).not.toContain("Cumulative spend")
      expect(output).not.toContain("Why small multiples")
      expect(output).not.toContain("Model mix over time")
      expect(new Set(output.split("\n").map(visibleLength))).toEqual(new Set([118]))
    })
  })

  test("renders dashboard token components as auto-normalized small multiples", () => {
    // 四个组成量级差异很大，独立归一化必须让低占比 Output 仍有可见趋势。
    // 同时禁止恢复重复 legend 或逐点 marker，维持主端点的流畅线型。
    withColumns(160, () => {
      const output = renderDashboard(report(), { color: "never" })
      expect(output).toContain("Cache Read")
      expect(output).toContain("Input")
      expect(output).toContain("Cache Write")
      expect(output).toContain("Output")
      expect(output.indexOf("Cache hit rate (%)")).toBeLessThan(output.indexOf("Abort & error rate"))
      expect(output).toContain("per-call")
      expect(output).not.toContain("■ Cache Read · ■ Input · ■ Cache Write · ■ Output")
      expect(output).not.toContain("● cost")
      expect(output).not.toContain("● cache")
      expect(output).not.toContain("● errors")
      expect(output.split("\n").some((line) => ["▓ Cache Read", "░ Input", "▒ Cache Write", "▎ Output"].includes(line.trim()))).toBe(false)
      expect(new Set(output.split("\n").map(visibleLength))).toEqual(new Set([158]))
    })
  })

  test("does not truncate dashboard rows with ellipses", () => {
    // 从极窄到宽屏都不允许用省略号掩盖布局错误；窄屏可以增加行数。
    // 该断言直接观察最终用户输出，不检查 truncate helper 是否存在。
    // 多断点覆盖可防止修复桌面宽度后重新破坏 40 列终端。
    for (const columns of [40, 80, 120, 160]) {
      withColumns(columns, () => {
        expect(renderDashboard(report(), { color: "never" })).not.toContain("…")
      })
    }
  })

  test("keeps chart grids and stable date labels", () => {
    // 图表日期必须来自本地自然日 timestamp，而不是聚合时的本地化 label。
    // 稳定 MM-DD 可避免不同系统语言改变坐标轴宽度。
    withColumns(160, () => {
      const output = renderDashboard(report(), { color: "never" })
      expect(output).toContain("┄")
      expect(output).toContain("04-27")
      expect(output).not.toContain("5月")
      expect(output).not.toContain("$0.000")
    })
  })

  test("keeps calendar cells adaptive and hour strip uncompressed", () => {
    // Calendar 色块可随宽度从双字符降为单字符，但 24 小时条不能少采样。
    // 这锁定的是信息完整性，而不是某个具体布局函数。
    withColumns(160, () => {
      expect(calendarRows(renderDashboard(report(), { color: "never" })).join("\n")).toMatch(/[░▒▓█]{2}/)
    })

    withColumns(40, () => {
      expect(calendarRows(renderDashboard(report(), { color: "never" })).join("\n")).not.toMatch(/[░▒▓█]{2}/)
    })

    withColumns(80, () => {
      const lines = renderDashboard(report(), { color: "never" }).split("\n").map(stripAnsi)
      const header = lines.findIndex((line) => line.includes("00  04  08  12  16  20"))
      expect(lines[header + 1].trim()).toHaveLength(24)
    })
  })

  test("keeps calendar activity aligned across irregular natural-day durations", () => {
    // 23 小时的相邻 bucket 模拟 DST；三个自然日必须各出现一个完整色块。
    // 若渲染重新使用固定 24 小时查表，第三天会被显示为空。
    withColumns(120, () => {
      const input = report()
      const first = new Date(2026, 2, 7).getTime()
      input.daily = input.daily.slice(0, 3).map((item, index) => ({
        ...item,
        day: [first, first + day, first + day * 2 - 60 * 60 * 1000][index],
      }))
      input.dateRange = { earliest: input.daily[0].day, latest: input.daily[2].day }
      expect(calendarRows(renderDashboard(input, { color: "never" })).join("\n")).toMatch(/▒▒.*██[\s\S]*▒▒/)
    })
  })

  test("renders request start hours instead of assigning requests to Session updates", () => {
    withColumns(140, () => {
      const input = report()
      // Session 更新时间和 request 数故意指向 23:00；renderer 只能读取真实 request-hour 投影。
      input.sessions.forEach((session) => {
        session.updated = new Date(2026, 5, 1, 23).getTime()
        session.requests = 10_000
      })
      Object.assign(input, {
        requestsByHour: Array.from({ length: 24 }, (_, hour) => hour === 4 ? 12 : hour === 6 ? 3 : 0),
      })
      const output = stripAnsi(renderDashboard(input, { color: "never" }))

      expect(output).toContain("Request starts by hour")
      expect(output).toContain("peak  04:00 — 12 req")
      expect(output).toContain("quiet 06:00 — 3 req")
      expect(output).not.toContain("peak  23:00")
    })
  })

  test("keeps calendar monochrome while spacing provider legend columns", () => {
    // 日历强度只编码一个维度，额外颜色会制造错误语义，因此保持单色。
    // Provider legend 则依赖间距和颜色区分多个实体，宽屏需保持列间留白。
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
    // 固定会话区间需要视觉层级，但颜色只区分 bucket，不表达好坏判断。
    // 断言至少存在两种终端基础前景色，既防止恢复同色，也不把测试绑定到深色专用 RGB。
    withColumns(160, () => {
      const lines = renderDashboard(report(), { color: "always" }).split("\n")
      const start = lines.findIndex((line) => stripAnsi(line).includes("Session size distribution"))
      const bucketLines = lines.slice(start, start + 8).filter((line) => /<100K|100K-1M|1M-5M|5M-50M|>50M/.test(stripAnsi(line)))
      const colors = new Set(bucketLines.flatMap((line) => Array.from(line.matchAll(/\x1b\[(?:3[0-7]|9[0-7])m/g), (match) => match[0])))
      expect(colors.size).toBeGreaterThan(1)
    })
  })

  test("keeps colored breakdown trend lines free of point markers", () => {
    // 彩色折线已经能区分系列，逐点形状会形成粗点并遮挡交叉线。
    // 只检查 plot 区域，编号键和其他图例符号不属于观测点。
    withColumns(140, () => {
      const lines = renderBreakdown(report(), { color: "always", by: "model" }).split("\n").map(stripAnsi)
      const title = lines.findIndex((line) => line.includes("Token trend"))
      const portfolio = lines.findIndex((line) => line.includes("Model portfolio"))
      expect(title).toBeGreaterThanOrEqual(0)
      const trend = lines.slice(title + 1, portfolio).join("\n")
      expect(trend).not.toMatch(/[●◆■▲◇○✕+]/)
      // 颜色只区分线条，图下必须直接给完整名称与量级，不能再让用户查 [1]/A/B 键。
      expect(trend).toContain("claude-opus-4-6")
      expect(trend).toContain("gpt-5.5")
      expect(trend).not.toMatch(/\[\d+\]/)

      const tools = renderBreakdown(report(), { color: "always", by: "tool" }).split("\n").map(stripAnsi)
      const toolTitle = tools.findIndex((line) => line.includes("Tool context trend"))
      const toolTable = tools.findIndex((line) => line.includes("Tool footprint"))
      const toolTrend = tools.slice(toolTitle + 1, toolTable).join("\n")
      // Tool 趋势与其他 Breakdown 一样直接显示实体名称，不能保留隐藏的 [1]/[2] 映射。
      expect(toolTrend).toContain("apply_patch")
      expect(toolTrend).toContain("bash")
      expect(toolTrend).not.toMatch(/\[\d+\]/)
    })
  })

  test("carries each entity series color across trends, legends, and analytical rows", () => {
    withColumns(140, () => {
      const colored = renderBreakdown(report(), { color: "always", by: "provider" })
      const trend = colored.slice(colored.indexOf("Cost trend"), colored.indexOf("Provider economics"))
      // 图下实体名是折线的直接图例，必须复用画布中的稳定系列色。
      // R6 palette: blue=94m, green=92m（bright 槽位避免深色 profile 过暗）。
      expect(trend).toContain("\x1b[94mDaXiao Codex")
      expect(trend).toContain("\x1b[92m本地提供商")

      const economics = colored.slice(colored.indexOf("Provider economics"), colored.indexOf("Model portfolio by provider"))
      const firstEconomicsRow = economics.split("\n").find((line) => stripAnsi(line).trimStart().startsWith("DaXiao Codex")) ?? ""
      expect(firstEconomicsRow).toContain("\x1b[94mDaXiao Codex")

      const capacity = colored.slice(colored.indexOf("Capacity & reliability"))
      const firstCapacityRow = capacity.split("\n").find((line) => stripAnsi(line).trimStart().startsWith("DaXiao Codex")) ?? ""
      // 同一行的实体名和 recent-cost sparkline 都应与对应主折线保持同色。
      expect(firstCapacityRow.match(/\x1b\[94m/g)?.length).toBeGreaterThanOrEqual(2)

      const tools = renderBreakdown(report(), { color: "always", by: "tool" })
      const toolTrend = tools.slice(tools.indexOf("Estimated context trend"), tools.indexOf("Tool footprint"))
      expect(toolTrend).toContain("\x1b[94mapply_patch")
      expect(toolTrend).toContain("\x1b[92mbash")

      const project = renderBreakdown(report(), { color: "always", by: "project" })
      const projectPortfolio = project.slice(project.indexOf("Project portfolio"), project.indexOf("Runtime mix"))
      // Project portfolio 是自定义卡片而非通用 table，也必须延续该项目在主趋势中的身份色。
      expect(projectPortfolio).toContain("\x1b[94m本地项目")

      const timeline = renderTimeline(report(), { color: "always" })
      const timelineModels = timeline.slice(timeline.indexOf("Models"), timeline.indexOf("Providers"))
      const timelineProviders = timeline.slice(timeline.indexOf("Providers"))
      // Timeline 的短趋势与实体名构成同一直接图例，不能只给 sparkline 着色而保留白色名称。
      expect(timelineModels).toContain("\x1b[94mclaude-opus-4-6")
      expect(timelineModels).toContain("\x1b[92mgpt-5.5")
      expect(timelineProviders).toContain("\x1b[94mDaXiao Codex")
      const topDays = timeline.slice(timeline.indexOf("Top active days"), timeline.indexOf("Entity trends"))
      // 日期排行没有跨 section 的系列身份，不能仅因复用 table primitive 就被循环染成分类色。
      expect(topDays).not.toMatch(/\x1b\[(?:34|32|33|35|95|36|93|31)m\d{2}-\d{2}/)

      const partial = report()
      partial.providerSeries = partial.providerSeries.slice(1)
      partial.toolSeries = partial.toolSeries.slice(1)
      // 缺失趋势只能隐藏该线，不能让后续实体在图例与表格之间重新编号换色。
      const partialProvider = renderBreakdown(partial, { color: "always", by: "provider" })
      const partialTool = renderBreakdown(partial, { color: "always", by: "tool" })
      expect(partialProvider.slice(partialProvider.indexOf("Cost trend"), partialProvider.indexOf("Provider economics"))).toContain("\x1b[92m本地提供商")
      expect(partialTool.slice(partialTool.indexOf("Estimated context trend"), partialTool.indexOf("Tool footprint"))).toContain("\x1b[92mbash")

      // 颜色仅增加编码；去色后文本、间距和数值必须与 color=never 完全相同。
      expect(stripAnsi(colored)).toBe(renderBreakdown(report(), { color: "never", by: "provider" }))
      expect(stripAnsi(timeline)).toBe(renderTimeline(report(), { color: "never" }))
    })
  })

  test("marks provider risk outliers without treating a high cache share as failure", () => {
    const input = report()
    const provider = (id: string, index: number) => {
      const cacheRead = index === 0 ? 960 : 400
      const failed = index === 1 || index === 2 ? 10 : 0
      return {
        ...input.providers[0],
        id,
        label: id,
        tokens: { input: index === 0 ? 30 : 500, output: index === 0 ? 10 : 100, reasoning: 0, cache: { read: cacheRead, write: 0 }, total: 1_000 },
        // 十一个样本中的单一费用尖峰超过 3σ；两个失败尖峰各自位于 2σ 与 3σ 之间。
        cost: index === 0 ? 1_000 : 10,
        requests: 10,
        assistantCalls: index === 0 ? 1 : 10,
        errors: failed,
        aborted: 0,
        durationMs: 10_000,
      }
    }
    input.providers = ["cost-outlier", "failure-a", "failure-b", ...Array.from({ length: 8 }, (_, index) => `baseline-${index + 1}`)]
      .map(provider)
    // 主趋势仍需拥有同一批实体，测试通过公开页面而不是绕过 renderer 调私有统计 helper。
    input.providerSeries = input.providers.map((item) => ({
      ...item,
      points: input.daily.map((point) => ({ ...point, ...item, day: point.day, label: point.label })),
    }))
    input.total = addUsage(input.providers)

    withColumns(160, () => {
      // 只显示两行，确保 sigma 仍读取其余九个不可见 Provider，而不是从 UI limit 反推基线。
      const colored = renderBreakdown(input, { color: "always", by: "provider", limit: 2 })
      const plain = renderBreakdown(input, { color: "never", by: "provider", limit: 2 })
      // 红/橙同时带文本记号，告警不能在 NO_COLOR 或低辨色终端中消失。
      // R6 palette: red=91m, orange=33m（次级 amber，与 bright warning 93m 区分）。
      expect(colored).toContain("\x1b[91m$1000!")
      expect(colored).toContain("\x1b[33m100.0%^")
      expect(plain).toContain("! >=3σ")
      expect(plain).toContain("^ >=2σ")
      // 高缓存是健康信号，数值较大不能被通用“高值异常”规则误判为风险。
      expect(colored).toContain("\x1b[92m96.0%")
      expect(stripAnsi(colored)).toBe(plain)
    })
  })

  test("sorts tool breakdown by calls when requested", () => {
    // 构造上下文规模和调用次数相反的两个工具，避免默认数据恰好掩盖排序错误。
    // 断言公开表格中的可见顺序，而不是检查 renderBreakdown 内部比较函数。
    const input = report()
    input.toolUsage = [
      { id: "large-context", count: 1, inputChars: 10, outputChars: 20, contextTokens: 1_000 },
      { id: "frequent-calls", count: 20, inputChars: 200, outputChars: 400, contextTokens: 100 },
    ]

    withColumns(140, () => {
      const output = stripAnsi(renderBreakdown(input, { color: "never", by: "tool", sort: "calls" }))
      // 显式 calls 排序必须覆盖默认 context token 顺序，CLI 参数不能被静默接受后忽略。
      expect(output.indexOf("frequent-calls")).toBeLessThan(output.indexOf("large-context"))
    })
  })

  test("gives every breakdown dimension a distinct analytical view", () => {
    // 每个维度必须回答不同用户问题，不能重新套用同一排行条和 ledger 壳。
    // 同时限制 120 列下行数，确保页面维持一到两屏的中高密度。
    // 维度专属标题作为用户可见证据，不绑定内部数据转换结构。
    withColumns(120, () => {
      const expected = {
        model: ["Model portfolio", "Token composition", "Routing & tools"],
        provider: ["Provider economics", "Model portfolio by provider", "Capacity & reliability"],
        agent: ["Agent workload", "Input context composition", "Runtime mix"],
        source: ["Source workload", "Input context composition", "Routing mix"],
        project: ["Project portfolio", "Runtime mix", "Largest sessions inside each project"],
        status: ["Outcome distribution", "Status efficiency", "Failure leaders within each dimension"],
        tool: ["Tool footprint", "Issuing runtime", "avg/call"],
      } as const

      for (const by of ["model", "provider", "agent", "source", "project", "status", "tool"] as const) {
        const output = renderBreakdown(report(), { color: "never", by })
        const sections = expected[by]
        for (const section of sections) expect(output).toContain(section)
        expect(output).not.toContain("token detail")
        expect(output).not.toContain("Token composition across all")
        // richer 维度页仍须控制在约两屏内，不能退化成长篇文字报告。
        expect(output.split("\n").length).toBeLessThanOrEqual(64)
        expect(output).not.toMatch(/\[\d+\]/)
        expect(output).not.toContain("Provider × model token matrix")
      }
      const providers = renderBreakdown(report(), { color: "never", by: "provider" })
      expect(providers).toContain("Cost trend · top 2 providers")
      expect(providers).toContain("2 total · sorted by cost")
      expect(renderBreakdown(report(), { color: "never", by: "model", limit: 1 })).toContain("2 total")
    })
  })

  test("renders the complete model breakdown analysis instead of a generic table shell", () => {
    withColumns(140, () => {
      const input = report()
      input.models[0].providers = [
        { id: "provider-a", tokens: 60 },
        { id: "provider-b", tokens: 20 },
        { id: "provider-c", tokens: 10 },
        { id: "provider-d", tokens: 10 },
      ]
      input.toolCalls = [
        { ...input.toolCalls[0], toolID: "read", modelID: input.models[0].id, calls: 60 },
        { ...input.toolCalls[0], toolID: "bash", modelID: input.models[0].id, calls: 20 },
        { ...input.toolCalls[0], toolID: "grep", modelID: input.models[0].id, calls: 10 },
        { ...input.toolCalls[0], toolID: "task", modelID: input.models[0].id, calls: 10 },
      ]
      const output = stripAnsi(renderBreakdown(input, { color: "never", by: "model" }))

      // Breadcrumb 和 summary 必须同时公开当前维度、top 绝对量及全局占比，不能只留下通用 Breakdown 壳。
      expect(output).toContain("opencode stats · Breakdown / Model")
      expect(output).toContain("Models · top claude-opus-4-6 1.4B (60.0%) · 2 total · sorted by tokens")
      expect(output).toContain("Token trend · top 2 models")

      const portfolio = output.slice(output.indexOf("Model portfolio"), output.indexOf("Token composition"))
      for (const metric of ["tokens", "share", "cost", "owned req", "calls", "tok/call", "sessions", "owner fail", "owner avg"]) {
        expect(portfolio).toContain(metric)
      }
      expect(portfolio).toContain("RequestUsage owner")
      expect(portfolio).toContain("Assistant usage")

      // Composition 必须是可比较的图形，不只是把五个数字重新塞进宽表。
      const composition = output.slice(output.indexOf("Token composition"), output.indexOf("Routing & tools"))
      expect(composition).toMatch(/[█▓▒░]{3}/)
      for (const component of ["cache read", "input", "output", "reasoning", "cache write"]) expect(composition).toContain(component)

      // 被折叠的长尾必须显式归入 other，百分比才会闭合为完整 Provider/ToolPart 分母。
      const routing = output.slice(output.indexOf("Routing & tools"))
      expect(routing).toContain("other 10.0%")
      expect(routing).toContain("ToolParts issued by each model")
      expect(routing).toContain("not Tool cost or billed tokens")
    })
  })

  test("aligns model token composition as exact 100% stacks without inflating tiny parts", () => {
    const input = report()
    input.models[0].label = "m"
    input.models[0].tokens = { input: 100_000, output: 100_000, reasoning: 1, cache: { read: 799_999, write: 0 }, total: 1_000_000 }
    input.models[1].label = "model-with-long-name"
    input.models[1].tokens = { input: 200, output: 200, reasoning: 200, cache: { read: 200, write: 200 }, total: 1_000 }
    // 零 token 模型仍可能因费用或 request attribution 留在分组中，composition 不能因此崩溃。
    input.models.push({ ...input.models[1], id: "zero-model", label: "zero-model", tokens: tokens(0) })
    // Header 分母同步到三个可见模型，避免测试用失真的 share 文本掩盖真实 composition 行为。
    input.total = addUsage(input.models)

    withColumns(140, () => {
      const colored = renderBreakdown(input, { color: "always", by: "model" })
      const composition = colored.slice(colored.indexOf("Token composition"), colored.indexOf("Routing & tools"))
      const bars = composition.split("\n").filter((line) => stripAnsi(line).includes("█"))
      expect(bars).toHaveLength(2)
      const visibleBars = bars.map(stripAnsi)
      const starts = visibleBars.map((line) => line.indexOf("█"))
      const widths = visibleBars.map((line) => line.match(/█+/)?.[0].length ?? 0)
      // 名称长度只能影响 label 留白，不能让每个模型的组成条从不同列起步或拥有不同总宽度。
      expect(visibleBars[1]).toContain("model-with-long-name")
      expect(new Set(starts).size).toBe(1)
      expect(new Set(widths).size).toBe(1)
      expect(widths[0]).toBeGreaterThan(20)

      // 第二行的均分数据必须在 bar 中呈现全部五类；颜色来自终端基础前景而非背景块。
      // R6 palette: blue=94, green=92, purple=95, yellow=93, pink=35。
      for (const ansi of [94, 92, 95, 93, 35]) expect(composition).toMatch(new RegExp(`\\x1b\\[${ansi}m█`))
      // 1 / 1,000,000 的 reasoning 仍保留精确值，但不能为了"可见"伪造一个比例格。
      // R6 purple=95m；reasoning 用 purple，但 1 token 不应形成可见段。
      expect(bars[0]).not.toContain("\x1b[95m█")
      expect(stripAnsi(composition)).toContain("reasoning 1 0.0%")
      expect(stripAnsi(composition)).toContain("cache write 200 20.0%")
      expect(stripAnsi(composition)).toMatch(/zero-model\s+░{20,} 0%/)
      expect(stripAnsi(colored)).toBe(renderBreakdown(input, { color: "never", by: "model" }))
    })
  })

  test("renders provider economics and reliability with their complete request and Assistant denominators", () => {
    withColumns(140, () => {
      const input = report()
      input.providers[0].models = [
        { id: "model-a", tokens: 60 },
        { id: "model-b", tokens: 20 },
        { id: "model-c", tokens: 10 },
        { id: "model-d", tokens: 10 },
      ]
      const output = stripAnsi(renderBreakdown(input, { color: "never", by: "provider" }))

      expect(output).toContain("opencode stats · Breakdown / Provider")
      expect(output).toContain("Providers · top DaXiao Codex $89 (70.0%) · 2 total · sorted by cost")
      expect(output).toContain("Cost trend · top 2 providers")

      const economics = output.slice(output.indexOf("Provider economics"), output.indexOf("Model portfolio by provider"))
      for (const metric of ["tokens", "share", "cost", "cost share", "owned req", "calls", "$/call", "cache", "owner fail", "owner avg"]) {
        expect(economics).toContain(metric)
      }
      expect(economics).toContain("Request-owner metrics can be zero")

      const models = output.slice(output.indexOf("Model portfolio by provider"), output.indexOf("Capacity & reliability"))
      expect(models).toContain("other 10.0%")

      const capacity = output.slice(output.indexOf("Capacity & reliability"))
      for (const metric of ["tok/$", "tok/call", "output", "errors", "aborted", "completed", "recent cost/day"]) {
        expect(capacity).toContain(metric)
      }
      expect(capacity).toMatch(/[▁▂▃▄▅▆▇█]{8,}/)
    })
  })

  test("renders Agent workload and the complete input context denominator", () => {
    withColumns(140, () => {
      const output = stripAnsi(renderBreakdown(report(), { color: "never", by: "agent" }))
      expect(output).toContain("opencode stats · Breakdown / Agent")
      expect(output).toContain("Agents · top build 2.3B (100.0%) · 1 total · sorted by tokens")
      expect(output).toContain("Token trend · top 1 agents")

      const workload = output.slice(output.indexOf("Agent workload"), output.indexOf("Input context composition"))
      for (const metric of ["tokens", "sessions", "cost", "owned req", "calls", "calls/req", "tok/session", "cache", "owner fail", "owner avg"]) {
        expect(workload).toContain(metric)
      }

      const context = output.slice(output.indexOf("Input context composition"), output.indexOf("Runtime mix"))
      for (const component of ["system", "instruct", "skills", "schemas", "user", "assistant", "reasoning", "tool calls", "tool results", "attach"]) {
        expect(context).toContain(component)
      }
      expect(output).toContain("Runtime mix")
      expect(output).toContain("models by tokens")
      expect(output).toContain("providers by tokens")
      expect(output).toContain("tools by calls")
    })
  })

  test("renders Source workload with request-owner availability and complete context attribution", () => {
    withColumns(140, () => {
      const input = report()
      const legacy = {
        ...input.sources[0],
        id: "legacy-message",
        label: "legacy-message",
        tokens: tokens(1_000),
        components: components(0),
        cost: 5,
        requests: 0,
        assistantCalls: 10,
        errors: 0,
        aborted: 0,
        durationMs: 0,
      }
      input.sources.push(legacy)
      input.sourceSeries.push({ ...input.sourceSeries[0], ...legacy, points: input.sourceSeries[0].points.map((point) => ({ ...point, ...contextUsage(100) })) })
      const output = stripAnsi(renderBreakdown(input, { color: "never", by: "source" }))

      expect(output).toContain("opencode stats · Breakdown / Source")
      expect(output).toContain("Token trend · request sources")
      const workload = output.slice(output.indexOf("Source workload"), output.indexOf("Input context composition"))
      for (const metric of ["owned req", "calls", "tokens", "tok/req*", "cost", "cost/req*", "sessions", "cache", "output", "fail*", "avg*"]) {
        expect(workload).toContain(metric)
      }
      const legacyRow = workload.split("\n").find((line) => line.includes("legacy-message")) ?? ""
      expect(legacyRow.match(/—/g)?.length).toBeGreaterThanOrEqual(4)
      expect(workload).toContain("request-owner denominator and health")

      const context = output.slice(output.indexOf("Input context composition"), output.indexOf("Routing mix"))
      expect(context).toContain("component attribution unavailable for these records")
      expect(context).toContain("other")
      const routing = output.slice(output.indexOf("Routing mix"))
      expect(routing).toContain("models by tokens")
      expect(routing).toContain("providers by tokens")
      expect(routing).not.toContain("issued tool calls")
    })
  })

  test("renders Project identity, portfolio, runtime mix, and largest Session as one complete page", () => {
    withColumns(140, () => {
      const input = report()
      input.sessions.forEach((session) => { session.projectID = input.projects[0].id })
      const output = stripAnsi(renderBreakdown(input, { color: "never", by: "project" }))
      expect(output).toContain("opencode stats · Breakdown / Project")
      expect(output).toContain("Projects · top 本地项目 2.3B (100.0%) · 1 total · sorted by tokens")
      expect(output).toContain("Token trend · top 1 projects")
      expect(output).toContain("━━━ Project portfolio")
      const portfolio = output.slice(output.indexOf("Project portfolio"), output.indexOf("Runtime mix"))
      for (const value of ["/tmp/本地项目", "tok 100.0%", "sessions", "req", "calls", "active days", "cache", "fail"]) expect(portfolio).toContain(value)
      expect(portfolio).not.toContain("Active days")
      const runtime = output.slice(output.indexOf("Runtime mix"), output.indexOf("Largest sessions inside each project"))
      expect(runtime).toContain("models by tokens")
      expect(runtime).toContain("providers by tokens")
      expect(runtime).toContain("tools by calls")
      const sessions = output.slice(output.indexOf("Largest sessions inside each project"))
      expect(sessions).toContain("分支与dev分支合并冲突检测")
      expect(sessions).toContain("322.0M")
      expect(sessions).toContain("requests")
      expect(sessions).toContain("│ 12")
    })
  })

  test("renders Tool context estimates separately from measured ToolPart footprint", () => {
    withColumns(140, () => {
      const output = stripAnsi(renderBreakdown(report(), { color: "never", by: "tool" }))
      expect(output).toContain("opencode stats · Breakdown / Tool")
      expect(output).toContain("estimated context tokens · sorted by estimated context tokens")
      expect(output).toContain("Estimated context trend · top 2 tools")
      expect(output).toContain("est ctx tok")

      const footprint = output.slice(output.indexOf("Tool footprint"), output.indexOf("Issuing runtime"))
      for (const metric of ["calls", "call share", "est ctx tok", "ctx share", "ctx/call", "in chars/c", "out chars/c", "errors", "avg/call"]) {
        expect(footprint).toContain(metric)
      }
      expect(footprint).toContain("prior Tool input/output")
      expect(footprint).toContain("no row represents Tool cost or billed tokens")
      expect(footprint).toContain("Tool errors are ToolPart execution errors")
      expect(footprint).toContain("--status filters associated request/Assistant status")

      const runtime = output.slice(output.indexOf("Issuing runtime"))
      expect(runtime).toContain("top models by calls")
      expect(runtime).toContain("top agents by calls")
      expect(runtime).toContain("projects by calls")
    })
  })

  test("renders Status as request outcomes with ratios, unattributed usage, and cross-dimension failure leaders", () => {
    withColumns(140, () => {
      const input = report()
      const base = input.statuses[0]
      input.total.requests = 100
      input.total.errors = 12
      input.total.aborted = 7
      input.statuses = [
        { ...base, id: "completed", label: "completed", requests: 80, errors: 0, aborted: 0 },
        { ...base, id: "error", label: "error", requests: 12, errors: 12, aborted: 0 },
        { ...base, id: "aborted", label: "aborted", requests: 7, errors: 0, aborted: 7 },
        { ...base, id: "running", label: "running", requests: 1, errors: 0, aborted: 0 },
        { ...base, id: "unattributed", label: "unattributed", requests: 0, errors: 0, aborted: 0, assistantCalls: 4 },
      ]
      input.statusSeries = input.statuses.map((status) => ({
        ...input.statusSeries[0],
        ...status,
        points: input.daily.map((day) => ({ ...day, requests: status.requests / input.daily.length })),
      }))
      ;[input.models, input.providers, input.sources, input.agents, input.projects].forEach((groups) => {
        groups[0].requests = 100
        groups[0].errors = 10
        groups[0].aborted = 5
      })
      const output = stripAnsi(renderBreakdown(input, { color: "never", by: "status" }))
      const colored = renderBreakdown(input, { color: "always", by: "status" })

      expect(output).toContain("opencode stats · Breakdown / Status")
      expect(output).toContain("Request outcomes · 100 total · 80 completed · 12 error · 7 aborted · 1 running")
      expect(output).toContain("Request outcome trend")
      const distribution = output.slice(output.indexOf("Outcome distribution"), output.indexOf("Status efficiency"))
      for (const status of ["completed", "error", "aborted", "running"]) expect(distribution).toContain(status)
      for (const metric of ["tokens", "$127", "avg"]) expect(distribution).toContain(metric)
      expect(distribution).toContain("Unattributed usage")
      expect(distribution).toContain("no owning request outcome")

      const efficiency = output.slice(output.indexOf("Status efficiency"), output.indexOf("Failure leaders within each dimension"))
      for (const metric of ["req share", "tokens/req", "cost/req", "calls/req", "cache", "output", "sessions"]) expect(efficiency).toContain(metric)
      const coloredEfficiency = colored.slice(colored.indexOf("Status efficiency"), colored.indexOf("Failure leaders within each dimension"))
      // Status 第一列使用结果语义色，而不是普通实体的 blue/green 系列轮换。
      // R6 palette: green=92, red=91, yellow=93, blue=94（bright 槽位）。
      for (const [ansi, status] of [[92, "completed"], [91, "error"], [93, "aborted"], [94, "running"]] as const) expect(coloredEfficiency).toContain(`\x1b[${ansi}m${status}`)
      expect(stripAnsi(colored)).toBe(output)

      const leaders = output.slice(output.indexOf("Failure leaders within each dimension"))
      for (const dimension of ["model", "provider", "source", "agent", "project"]) expect(leaders).toContain(dimension)
      for (const metric of ["failed req", "rate in leader", "share of all failures"]) expect(leaders).toContain(metric)
      expect(leaders).toContain("Outcome ratios exclude unattributed usage")
      expect(leaders).toContain("Errors and aborted requests remain separate outcomes")
    })
  })

  test("keeps colored timeline driver sparklines as ANSI instead of visible SGR text", () => {
    // `--color always` 的 sparkline 应由终端解释；去色后的用户文本绝不能残留 `[34m`、`[22m` 等参数。
    // 同时经过 Model 与 Provider 两组 driver，防止只修其中一个调用点。
    withColumns(120, () => {
      const output = renderTimeline(report(), { color: "always" })
      const plain = stripAnsi(output)
      expect(output).toContain("\x1b[94m")
      expect(plain).toContain("Entity trends")
      expect(plain).toContain("Models")
      expect(plain).toContain("Providers")
      expect(plain).not.toContain("Model trends")
      expect(plain).not.toMatch(/\[(?:\d+;)*\d+m/)
    })
  })

  test("keeps minor token components visible when cache dominates the timeline", () => {
    // 99% Cache Read 会把其他组成量化到堆积图的一行以下；公开页面仍需给每个组成独立趋势和精确量级。
    // 使用不同比例的日值同时证明总量主图与组件趋势来自同一 report，而不是静态说明文本。
    withColumns(120, () => {
      const input = report()
      const multipliers = [1, 2, 1, 3, 2, 4]
      input.daily = input.daily.map((item, index) => ({
        ...item,
        tokens: {
          input: 70 * multipliers[index],
          output: 20 * multipliers[index],
          reasoning: 0,
          cache: { read: 9_900 * multipliers[index], write: 10 * multipliers[index] },
          total: 10_000 * multipliers[index],
        },
      }))
      input.total.tokens = { input: 910, output: 260, reasoning: 0, cache: { read: 128_700, write: 130 }, total: 130_000 }
      input.tokenPartSeries = input.tokenPartSeries.map((part) => ({
        ...part,
        points: input.daily.map((item) => ({
          day: item.day,
          label: item.label,
          value: part.id === "input" ? item.tokens.input : part.id === "output" ? item.tokens.output : part.id === "cacheRead" ? item.tokens.cache.read : item.tokens.cache.write,
        })),
        total: part.id === "input" ? 910 : part.id === "output" ? 260 : part.id === "cacheRead" ? 128_700 : 130,
      }))

      const timeline = renderTimeline(input, { color: "never" })
      expect(timeline).toContain("━━━ Daily token volume")
      expect(timeline).toContain("total 130.0K · peak 40.0K/day · avg 21.7K/day")
      expect(timeline).toContain("each trend independently normalized")
      // 精确 total/share/peak 是跨独立尺度比较量级的唯一依据，不能只留下四个颜色图例。
      expect(timeline).toContain("Cache Read 128.7K 99.0% · peak 39.6K/day")
      expect(timeline).toContain("Input 910 0.7% · peak 280/day")
      expect(timeline).toContain("Cache Write 130 0.1% · peak 40/day")
      expect(timeline).toContain("Output + Reasoning 260 0.2% · peak 80/day")
      expect(timeline).toContain("━━━ Health and efficiency")
      expect(timeline).toContain("Top active days")
      expect(timeline.split("\n").length).toBeLessThanOrEqual(64)

      const sessions = renderSessions(report(), { color: "never" })
      expect(sessions).toContain("━━━ Session population")
      expect(sessions).toContain("p90")
      expect(sessions).toContain("p99")
      expect(sessions).toContain("━━━ Session size distribution · tokens")
      expect(sessions).toContain("━━━ Session cost distribution · positive recorded cost")
      expect(sessions).toContain("━━━ Session leaderboard · sorted by tokens · bar = token share")
      expect(sessions).toContain("models")
      expect(sessions).toContain("providers")
      expect(sessions).not.toContain("Top tools")
      // Distribution 与每个 Session 都必须有真实横向条；纯表格不能满足分布和集中度分析。
      const lines = sessions.split("\n").map(stripAnsi)
      const distribution = lines.findIndex((line) => line.includes("Session size distribution"))
      const leaderboard = lines.findIndex((line) => line.includes("Session leaderboard"))
      expect(lines.slice(distribution + 1, leaderboard).filter((line) => line.includes("█") || line.includes("░")).length).toBeGreaterThanOrEqual(5)
      expect(lines.slice(leaderboard + 1).filter((line) => line.includes("token share") && line.includes("█")).length).toBe(report().sessions.length)
      expect(sessions.split("\n").length).toBeLessThanOrEqual(64)
    })
  })

  test("gives Cost Timeline its own health, ranking, drivers, and peak-date semantics", () => {
    withColumns(140, () => {
      const output = stripAnsi(renderTimeline(report(), { color: "never", metric: "cost" }))
      expect(output).toContain("opencode stats · Timeline / Cost")
      expect(output).toContain("━━━ Daily cost")
      expect(output).toContain("total $127 · avg $21.1/day · peak $50.0 on 05-02 · 6/6 active days")
      const health = output.slice(output.indexOf("Health and efficiency"), output.indexOf("Top cost days"))
      expect(health).toContain("Tokens")
      expect(health).not.toContain("Daily cost")
      for (const metric of ["Requests", "Cache read", "Failures", "Latency"]) expect(health).toContain(metric)
      expect(output).toContain("Top cost days")
      expect(output).toContain("Cost drivers")
      expect(output).not.toContain("Entity trends")
    })
  })

  test("renders Timeline heatmap zero cells and all peak-relative legend bands", () => {
    withColumns(140, () => {
      const input = report()
      input.daily[0] = { ...input.daily[0], tokens: tokens(0) }
      const tokensOutput = stripAnsi(renderTimeline(input, { color: "never", heatmap: true }))
      expect(tokensOutput).toContain("━━━ Token heatmap · calendar view")
      for (const legend of ["· 0", "░ <=25% peak", "▒ <=50% peak", "▓ <=75% peak", "█ >75% peak", "peak 920.0M"]) {
        expect(tokensOutput).toContain(legend)
      }
      const costOutput = stripAnsi(renderTimeline(input, { color: "never", metric: "cost", heatmap: true }))
      expect(costOutput).toContain("━━━ Cost heatmap · calendar view")
      expect(costOutput).toContain("peak $50")
      expect(costOutput).not.toContain("peak 50.0M")
    })
  })

  test("renders insights as quantitative evidence instead of prose cards", () => {
    // Insights 应输出可核对数值，而不是固定模板生成的大段机械结论。
    // Forecast 默认关闭，显式开启后仍需保持两屏以内。
    // 两种模式分别断言，防止可选预测意外泄漏到默认页面。
    withColumns(120, () => {
      const output = renderInsights(report(), { color: "never" })
      expect(output).toContain("Usage shape")
      expect(output).toContain("Attribution")
      expect(output).toContain("Daily cost")
      expect(output).toContain("Session cost")
      expect(output).toContain("Actions")
      expect(output).not.toContain("Daily cost increased from")
      expect(output).not.toContain("Run-rate forecast")
      // 全宽 divider 后保留一行呼吸空间，Insights 才与其他详细页共享同一章节节奏。
      const lines = stripAnsi(output).split("\n")
      for (const heading of ["Usage shape", "Attribution", "Variability & outliers", "Actions"]) {
        const index = lines.findIndex((line) => line.includes(`━━━ ${heading}`))
        expect(lines[index + 1]?.trim()).toBe("")
      }
      expect(output.split("\n").length).toBeLessThanOrEqual(64)

      const forecast = renderInsights(report(), { color: "never", forecast: true })
      expect(forecast).toContain("Forecast")
      const forecastLines = stripAnsi(forecast).split("\n")
      const forecastHeading = forecastLines.findIndex((line) => line.includes("━━━ Forecast · observed activity run rate"))
      expect(forecastLines[forecastHeading + 1]?.trim()).toBe("")
      expect(forecast.split("\n").length).toBeLessThanOrEqual(64)
    })
  })

  test("keeps the complete Insights denominators and excludes unavailable ownership", () => {
    withColumns(140, () => {
      const input = report()
      // 未归因状态故意拥有更多 Token；Status leader 仍必须回答“哪个真实 outcome 主导”。
      const unattributed = structuredClone(input.statuses[0])
      unattributed.id = "unattributed"
      unattributed.label = "unattributed"
      unattributed.tokens = tokens(100_000_000)
      input.statuses[0].tokens = tokens(1_000_000)
      input.statuses.push(unattributed)
      // 零费用表示价格未知，不能进入正费用 Session 分位数并把 p50 人为压低。
      input.sessions.push({ ...structuredClone(input.sessions[1]), id: SessionID.make("ses_unpriced"), cost: 0 })

      const output = stripAnsi(renderInsights(input, { color: "never" }))
      // 比例可能在终端边界换行，归一化空白只忽略布局，不放宽标签与数值行为。
      const normalized = output.replace(/\s+/g, " ")
      for (const component of [
        "system 8.0%",
        "instructions 5.0%",
        "skills 4.0%",
        "schemas 12.0%",
        "user 24.0%",
        "assistant 10.0%",
        "reasoning 4.0%",
        "tool calls 6.0%",
        "tool results 22.0%",
        "attach 5.0%",
      ]) expect(normalized).toContain(component)
      expect(output).toContain("token share")
      expect(output).toContain("recent cost change")
      expect(output).toContain("owner fail")
      expect(normalized).toContain("status │ completed")
      expect(output).toContain("Status leader excludes unattributed usage; 460.0M tokens without request outcome are reported separately.")
      expect(output).toContain("Session cost p50 $30.0")
      expect(output).toContain("Session tokens mean 388.7M · median 20.0M · mean/median 19.4x · top 2 share 17.8%")
    })
  })

  test("guards Insights actions when Token denominators are unavailable", () => {
    withColumns(120, () => {
      const input = emptyReport()
      // ToolPart 可以独立存在，但它不构成可计算 cache share 的 Assistant Token 分母。
      input.toolUsage = [{ id: "read", count: 1, inputChars: 10, outputChars: 20, contextTokens: 5 }]
      expect(stripAnsi(renderInsights(input, { color: "never" }))).not.toContain("Cache read 0.0% < 20%")
    })
  })

  test("renders Forecast drivers by cost with an explicit projection method", () => {
    withColumns(140, () => {
      const input = report()
      // 输入顺序按 Token 排列，反转费用规模可验证 Forecast 使用自己的费用 driver 口径。
      input.providerSeries[0].cost = 1
      input.providerSeries[0].points.forEach((point) => { point.cost = 1 })
      input.providerSeries[1].cost = 100
      input.providerSeries[1].points.forEach((point) => { point.cost = 10 })
      const output = stripAnsi(renderInsights(input, { color: "never", forecast: true }))
      const drivers = output.slice(output.indexOf("Forecast drivers"))

      // 30-day run rate 使用固定 30 天；锚点月份天数只属于独立的 month-end 投影。
      expect(output).toContain("30-day $634")
      expect(output).toContain("projected month-end")
      expect(output).toContain("endpoint confidence band")
      expect(drivers.indexOf("本地提供商")).toBeLessThan(drivers.indexOf("DaXiao Codex"))
      expect(output).toContain("Projection uses only the selected window and observed active-day frequency; month-end uses the latest date's local month.")
    })
  })

  test("preserves complete labels in analytical views", () => {
    // 模型、供应商、会话和第三个模型名都是定位数据，不能用无省略号的静默裁剪丢失。
    // 同时覆盖 Dashboard 和详细页，防止只修一条渲染链。
    withColumns(120, () => {
      const input = report()
      const model = "claude-opus-4-6-long-context-complete-model-name"
      const provider = "DaXiao Codex production routing provider"
      const session = "README 文档更新与中文本地化完整会话标题"
      input.models[0].label = model
      input.modelSeries[0].label = model
      input.providers[0].label = provider
      input.providerSeries[0].label = provider
      input.sessions[0].title = session
      input.sessions[0].models.push("complete-third-session-model")

      expect(renderBreakdown(input, { color: "never", by: "model" })).toContain(model)
      expect(renderBreakdown(input, { color: "never", by: "provider" })).toContain(provider)
      expect(renderSessions(input, { color: "never" })).toContain(session)
      const dashboard = renderDashboard(input, { color: "never" })
      expect(dashboard).toContain(model)
      expect(dashboard).toContain(provider)
      expect(dashboard).toContain("complete-third-session-model")
    })
  })

  test("labels an explicitly unbounded report as all time", () => {
    // requestedDays=undefined 表示用户明确选择全历史，标题应表达意图而非猜测日期跨度。
    // 该行为也用于 interactive 的 all-time 范围标签。
    withColumns(120, () => {
      const input = report()
      input.requestedDays = undefined
      expect(renderDashboard(input, { color: "never" })).toContain("All time")
    })
  })

  test("weights forecast run rates by observed active-day frequency", () => {
    // 一个活跃日加三个零日的日历均值应为 10，而不是把 40 外推到每天。
    // 置信度和区间也必须包含“不一定活跃”的波动来源。
    const input = report()
    input.daily = input.daily.slice(0, 4).map((item, index) => ({ ...item, day: new Date(2026, 3, index + 1).getTime(), cost: index === 0 ? 40 : 0 }))
    input.dateRange = { earliest: input.daily[0].day, latest: input.daily.at(-1)?.day ?? input.daily[0].day }
    const forecast = buildForecast(input)

    expect(forecast.dailyAverage).toBe(40)
    expect(forecast.activityRate).toBe(0.25)
    expect(forecast.weeklyRunRate).toBe(70)
    expect(forecast.confidence).toBeLessThan(1)
    expect(forecast.points.at(-1)?.upper).toBeGreaterThan(forecast.projectedMonthEnd)
  })

  test("renders empty reports without truncation or exceptions", () => {
    // 新安装或严格筛选可能返回全空 report，所有公开页面都应产生稳定空态。
    // 40/120 同时验证窄屏降级和目标桌面布局，不允许 NaN 或省略号逃逸。
    for (const columns of [40, 120]) {
      withColumns(columns, () => {
        const input = emptyReport()
        const outputs = [
          renderDashboard(input, { color: "never" }),
          ...(["model", "provider", "agent", "source", "project", "tool", "status"] as const).map((by) => renderBreakdown(input, { color: "never", by })),
          renderTimeline(input, { color: "never" }),
          renderSessions(input, { color: "never" }),
          renderInsights(input, { color: "never" }),
          renderInsights(input, { color: "never", forecast: true }),
        ]
        expect(outputs.every((output) => !output.includes("…"))).toBe(true)
        expect(outputs.every((output) => output.split("\n").every((line) => visibleLength(line) === columns - 2))).toBe(true)
        // 全空页面只保留共享 header 与明确空态，不能绘制一组零值图表伪装成观测数据。
        expect(outputs.every((output) => output.includes("No usage data for the selected"))).toBe(true)
      })
    }

    withColumns(120, () => {
      const partial = emptyReport()
      // Tool-only report 是合法的部分数据，统一空态不能只检查 token/cost/request。
      partial.totalTools = 1
      partial.toolUsage = [{ id: "read", count: 1, inputChars: 12, outputChars: 20, contextTokens: 0 }]
      partial.toolCalls = [{ toolID: "read", modelID: "test", providerID: "test", agent: "build", projectID: "project", source: "legacy-message", status: "completed", calls: 1, inputChars: 12, outputChars: 20, errors: 0, durationMs: 10 }]
      expect(renderBreakdown(partial, { color: "never", by: "tool" })).toContain("Tool footprint")
    })
  })

  test("renders missing cost as unavailable without hiding token usage", () => {
    withColumns(120, () => {
      const input = report()
      input.total.cost = 0
      // 所有费用投影同步归零，避免某个 series 残留正值掩盖全局无费用边界。
      input.daily.forEach((item) => { item.cost = 0 })
      ;[input.models, input.providers, input.agents, input.sources, input.statuses, input.projects].flat().forEach((item) => { item.cost = 0 })
      ;[input.modelSeries, input.providerSeries, input.agentSeries, input.sourceSeries, input.statusSeries, input.projectSeries].flat().forEach((item) => {
        item.cost = 0
        item.points.forEach((point) => { point.cost = 0 })
      })
      input.sessions.forEach((session) => { session.cost = 0 })

      // Dashboard 仍保留 token 主体，只追加费用不可用声明。
      expect(renderDashboard(input, { color: "never" })).toContain("No positive cost recorded in this range")
      const timeline = renderTimeline(input, { color: "never", metric: "cost" })
      // Cost Timeline 不绘制全零费用图，但健康行仍回答请求、缓存和失败问题。
      expect(timeline).toContain("No positive cost recorded in this range.")
      expect(timeline).toContain("Health and efficiency")
      const providers = renderBreakdown(input, { color: "never", by: "provider" })
      // 默认 cost 排序在无正费用时没有区分度，必须稳定回退 token 而非沿用输入顺序。
      expect(providers).toContain("sorted by tokens")
      expect(providers).not.toContain("$0.0000")
      // provider/providers alias 必须复用 canonical 的零费用 token 回退，不能强制绘制空 cost 趋势。
      expect(renderProviders(input, { color: "never" })).toBe(providers)
      const sessions = renderSessions(input, { color: "never" })
      // 零费用不能进入最低费用档，否则会把“未知价格”描述成“便宜”。
      expect(sessions).toContain("Cost distribution unavailable")
      expect(sessions).not.toContain("<$0.10")
      const insights = renderInsights(input, { color: "never", forecast: true })
      // 两个费用效率和 Forecast 依赖同一正费用前提，缺失时必须一起禁用。
      expect(insights).toContain("cost/M — · tok/$ —")
      expect(insights).toContain("Forecast unavailable: no positive cost recorded in the selected range.")
    })
  })

  test("separates sessions with no positive recorded cost from measured cost bands", () => {
    withColumns(120, () => {
      const input = report()
      input.sessions[0].cost = 1
      input.sessions[1].cost = 0
      const output = renderSessions(input, { color: "never" })
      // 标题和补充行共同公开正费用样本与未记录样本，分母不再隐式变化。
      expect(output).toContain("Session cost distribution · positive recorded cost (1 sessions)")
      expect(output).toContain("No positive recorded cost · 1 sessions")
    })
  })

  test("uses responsive default limits while preserving explicit limits and canonical wrappers", () => {
    const input = report()
    input.models = Array.from({ length: 9 }, (_, index) => ({
      ...input.models[0],
      id: `model-${index + 1}`,
      label: `model-${index + 1}`,
      tokens: { ...input.models[0].tokens, total: 900 - index },
    }))
    input.modelSeries = input.models.map((model) => ({ ...input.modelSeries[0], id: model.id, label: model.label }))
    input.sessions = Array.from({ length: 10 }, (_, index) => ({
      ...input.sessions[0],
      id: SessionID.make(`ses_responsive_${index + 1}`),
      title: `responsive-session-${index + 1}`,
    }))

    withColumns(40, () => {
      // 自动 limit 只受宽度控制；同一 report 在 40 列应压缩到三个实体。
      const automatic = renderBreakdown(input, { color: "never", by: "model" })
      expect(automatic).toContain("model-3")
      expect(automatic).not.toContain("model-4")
      const explicit = renderBreakdown(input, { color: "never", by: "model", limit: 6 })
      // 显式 limit 是用户意图，即使窄屏增加行数也不能被自动策略覆盖。
      expect(explicit).toContain("model-6")
      const sessions = renderSessions(input, { color: "never" })
      expect(sessions).toContain("responsive-session-3")
      expect(sessions).not.toContain("responsive-session-4")
    })
    withColumns(120, () => {
      const breakdown = renderBreakdown(input, { color: "never", by: "model" })
      expect(breakdown).toContain("model-5")
      expect(breakdown).not.toContain("model-6")
      expect(renderBreakdown(input, { color: "never", by: "model", limit: 8 })).toContain("model-8")
      // Session 每项包含占比条和四行明细，桌面默认五项与完整页面的 64 行预算绑定。
      const sessions = renderSessions(input, { color: "never" })
      expect(sessions).toContain("responsive-session-5")
      expect(sessions).not.toContain("responsive-session-6")
      expect(renderSessions(input, { color: "never", limit: 8 })).toContain("responsive-session-8")
      const dashboard = renderDashboard(input, { color: "never" })
      expect(dashboard).toContain("model-5")
      expect(dashboard).not.toContain("model-6")
      // 隐藏 canonical wrappers 必须逐字复用主 Breakdown，防止后续重构再次分叉样式。
      expect(renderModels(input, { color: "never" })).toBe(renderBreakdown(input, { color: "never", by: "model" }))
      expect(renderProviders(input, { color: "never" })).toBe(renderBreakdown(input, { color: "never", by: "provider" }))
    })
  })

  test("renders every breakdown page without ellipses", () => {
    // 七个维度逐一经过公共 panel，任何专属表格超宽都必须通过换行解决。
    // 固定行宽断言同时覆盖 ASCII 和 fixture 中的 CJK 标签。
    // 循环调用公开 renderBreakdown，测试不需要知道维度内部 helper。
    for (const columns of [40, 80, 120, 160]) {
      withColumns(columns, () => {
        for (const by of ["model", "provider", "agent", "source", "project", "tool", "status"] as const) {
          const output = renderBreakdown(report(), { color: "never", by })
          expect(output).not.toContain("…")
          expect(output.split("\n").every((line) => visibleLength(line) === columns - 2)).toBe(true)
        }
      })
    }
  })

  test("renders every detailed stats page without ellipses", () => {
    // Timeline 两种指标、Sessions、Insights 与 Forecast 构成所有详细页面主链。
    // 多宽度循环防止只在 120 列通过、其他断点仍由外层截断。
    for (const columns of [40, 80, 120, 160]) {
      withColumns(columns, () => {
        for (const output of [
          renderTimeline(report(), { color: "never" }),
          renderTimeline(report(), { color: "never", metric: "cost", heatmap: false }),
          renderSessions(report(), { color: "never" }),
          renderInsights(report(), { color: "never" }),
          renderInsights(report(), { color: "never", forecast: true }),
        ]) {
          expect(output).not.toContain("…")
          expect(output.split("\n").every((line) => visibleLength(line) === columns - 2)).toBe(true)
        }
      })
    }
  })

  test("never emits terminal background ANSI in color output", () => {
    // 回归测试：stats 只能把背景重置为终端默认值，不能选择任何具体背景色。
    // 49m 是“恢复默认背景”；40-47/100-107/48;2/48;5 才会绘制实际背景色。
    // 覆盖主渲染路径，避免后续重构让整行空格再次继承上游残留背景状态。
    // 这直接保护 macOS 深色模式，避免 stats 自绘背景与终端主题冲突。
    withColumns(140, () => {
      for (const output of [
        renderDashboard(report(), { color: "always" }),
        renderBreakdown(report(), { color: "always", by: "tool" }),
        renderSessions(report(), { color: "always" }),
        renderTimeline(report(), { color: "always" }),
        renderInsights(report(), { color: "always" }),
      ]) {
        // 基础 ANSI 色由终端主题决定明暗；固定 RGB 前景会在浅色终端重新产生低对比问题。
        expect(output).not.toContain("\x1b[38;2;")
        expect(concreteBackgroundAnsi(output)).toEqual([])
        expect(output.split("\n").every((line) => line.startsWith("\x1b[49m") && line.endsWith("\x1b[49m"))).toBe(true)
      }

      for (const output of [renderDashboard(report(), { color: "never" }), renderInsights(report(), { color: "never" })]) {
        expect(output).not.toContain("\x1b[49m")
      }
    })
  })

  test("treats persisted entity identities as plain terminal text", () => {
    // 标签来自数据库或 Provider，任何控制序列都只能作为普通显示文本处理，不能清屏、着背景或注入新行。
    withColumns(140, () => {
      const input = report()
      input.models[0].label = "model\u001b[41m\nforged"
      input.modelSeries[0].label = input.models[0].label
      input.providers[0].label = "provider\u001b]8;;https://malicious.invalid\u0007forged\u001b]8;;\u0007"
      input.providerSeries[0].label = input.providers[0].label
      input.sessions[0].title = "session\nforged"
      input.sessions[0].models = ["model\u001b[41m"]
      // 未终止 OSC 必须丢弃到字符串末尾，否则 URL 参数仍会作为普通文本泄漏。
      input.sessions[0].providers = ["provider\u001b]8;;https://unterminated.invalid"]
      input.toolUsage[0].id = "tool\u009b31mforged"
      input.toolCalls[0].toolID = input.toolUsage[0].id

      const output = [
        renderDashboard(input, { color: "always" }),
        renderBreakdown(input, { color: "always", by: "model" }),
        renderBreakdown(input, { color: "always", by: "provider" }),
        renderBreakdown(input, { color: "always", by: "tool" }),
        renderSessions(input, { color: "always" }),
        renderInsights(input, { color: "always" }),
      ].join("\n")
      expect(output).not.toContain("\u001b[41m")
      const plain = stripAnsi(output)
      for (const fragment of ["[41m", "[31m", "]8;;", "malicious.invalid", "unterminated.invalid"]) expect(plain).not.toContain(fragment)
      expect(plain).toContain("model forged")
      expect(plain).toContain("provider forged")
      expect(plain).toContain("tool forged")
      expect(plain).toContain("session forged")
    })
  })

  test("keeps breakdown analytical rows within the terminal width", () => {
    // Tool 和 Source 使用不同专属列，均不得依赖父级二次截断修复宽度。
    // 140 列覆盖宽屏表格路径，并确认旧 ledger 分隔符未泄漏。
    withColumns(140, () => {
      const toolOutput = renderBreakdown(report(), { color: "never", by: "tool" })
      expect(toolOutput).toContain("Estimated context trend")
      for (const output of [toolOutput, renderBreakdown(report(), { color: "never", by: "source" })]) {
        const widths = new Set(output.split("\n").map(visibleLength))
        expect(widths).toEqual(new Set([138]))
        expect(output).not.toContain("ctx tok ·")
        expect(output).not.toContain("…")
      }
    })
  })

  test("does not let grid dim state leak into series glyphs", () => {
    // 网格使用 \x1b[2;39m（dim + 默认前景）；数据线只设置 foreground 色码。
    // 如果 ChartCanvas.render() 在 style 切换时不先清除 dim，折线 glyph 会继承
    // 网格的 dim 状态，导致用户在 macOS 深色模式看到"虚线后折线变暗"。
    // 该测试把公开输出当作 SGR 状态机解析，断言 canvas 行中 dim 只出现在 grid 字符上。
    withColumns(120, () => {
      const chart = renderRoundedLineChart({
        title: "dim leak probe",
        series: [{
          id: "a", label: "a", color: "blue",
          points: [
            { x: 0, y: 0 }, { x: 1, y: 8 }, { x: 2, y: 2 }, { x: 3, y: 6 },
          ],
        }],
        color: "always",
        width: 30,
        height: 6,
        points: false,
        legend: false,
      })

      // Y 轴标签通过 paint("muted") 输出，本身就该是 dim；只检查 canvas 行部分。
      // 每行格式为 `${yAxisLabel} ${canvasLine}`，canvas 部分从 TEXT_RESET 后的空格之后开始。
      const canvasLines = chart.slice(1, -1).map((line) => {
        // Y 轴标签以 TEXT_RESET (\x1b[22m\x1b[39m) 结尾，后跟一个空格，然后是 canvas 内容。
        const resetIdx = line.indexOf("\x1b[22m\x1b[39m")
        if (resetIdx === -1) return ""
        return line.slice(resetIdx + 8)
      })

      // 解析 SGR 序列，跟踪每个可见字符输出时的 dim 状态。
      let dim = false
      let inEscape = false
      let escapeBuf = ""
      // grid 字符 ┆ 和 ┄ 可以是 dim；其他 canvas glyph 不能是 dim。
      const gridChars = "┆┄"
      const dimNonGridGlyphs: string[] = []
      for (const line of canvasLines) {
        dim = false
        inEscape = false
        escapeBuf = ""
        for (const char of line) {
          if (char === "\x1b") { inEscape = true; escapeBuf = char; continue }
          if (inEscape) {
            escapeBuf += char
            if (char === "m") {
              const params = escapeBuf.slice(2, -1).split(";").map(Number)
              for (const p of params) {
                if (p === 0) dim = false
                else if (p === 2) dim = true
                else if (p === 22) dim = false
              }
              inEscape = false; escapeBuf = ""
            }
            continue
          }
          if (char !== " " && char !== "\n" && !gridChars.includes(char) && dim) {
            dimNonGridGlyphs.push(char)
          }
        }
      }

      // canvas 行中除 grid 字符外的任何 glyph 都不能处于 dim 状态。
      expect(dimNonGridGlyphs).toEqual([])
    })
  })

  test("emits the exact R6 semantic ANSI role contract", () => {
    // R6 把前景色收敛为终端语义 ANSI 槽位：标题/主题用 bright magenta，
    // 辅助用 bright cyan，系列用 bright blue/green/yellow 等，状态用 bright red。
    // 这些 escape code 是 public --color always 输出契约，不是实现者可自由选择的。
    // 通过公开 paint() seam 验证每个 role 的实际 escape code。
    const ctx = renderContext("always")
    // title 使用 bright magenta（95m），复用 OpenCode system theme accent 语义。
    expect(paint("x", "title", ctx)).toContain("\x1b[95m")
    // subtitle 使用 bright cyan（96m），对应 primary/info 语义。
    expect(paint("x", "subtitle", ctx)).toContain("\x1b[96m")
    // blue 使用 bright blue（94m），避免普通蓝在深色 profile 中过暗。
    expect(paint("x", "blue", ctx)).toContain("\x1b[94m")
    // cyan 使用 bright cyan（96m），对应 primary/highlight。
    expect(paint("x", "cyan", ctx)).toContain("\x1b[96m")
    // green 使用 bright green（92m），对应 success 语义。
    expect(paint("x", "green", ctx)).toContain("\x1b[92m")
    // yellow 使用 bright yellow（93m），对应 warning 语义。
    expect(paint("x", "yellow", ctx)).toContain("\x1b[93m")
    // orange 使用 normal yellow（33m），作为次级 amber 和 bright warning 保持可区分。
    expect(paint("x", "orange", ctx)).toContain("\x1b[33m")
    // purple 使用 bright magenta（95m），对应 accent/forecast。
    expect(paint("x", "purple", ctx)).toContain("\x1b[95m")
    // pink 使用 normal magenta（35m），作为次级 magenta 与 bright accent 对照。
    expect(paint("x", "pink", ctx)).toContain("\x1b[35m")
    // red 使用 bright red（91m），对应 error/danger。
    expect(paint("x", "red", ctx)).toContain("\x1b[91m")
    // axis/white 使用终端默认前景（39m），正文和精确值不依赖彩色。
    expect(paint("x", "axis", ctx)).toContain("\x1b[39m")
    expect(paint("x", "white", ctx)).toContain("\x1b[39m")
    // muted/grid 使用 dim 默认前景（2;39m），只能表达低优先级结构。
    expect(paint("x", "muted", ctx)).toContain("\x1b[2;39m")
    expect(paint("x", "grid", ctx)).toContain("\x1b[2;39m")
    // 只有 muted/grid 可以携带 dim；其他 role 都不能设置 SGR dim（2）。
    for (const role of ["title", "subtitle", "blue", "cyan", "green", "yellow", "orange", "purple", "pink", "red", "axis", "white"] as const) {
      expect(paint("x", role, ctx)).not.toMatch(/\x1b\[2(?:;|m)/)
    }
  })

  test("keeps colored empty reports safe under the R6 foreground and background contract", () => {
    // 新安装或严格筛选返回全空 report 时，彩色输出仍须遵守 R6 前景契约和背景安全。
    // 现有空态测试只覆盖 color=never，无法检测空报告路径中的前景/背景回归。
    withColumns(120, () => {
      const input = emptyReport()
      const outputs = [
        renderDashboard(input, { color: "always" }),
        ...(["model", "provider", "agent", "source", "project", "tool", "status"] as const).map((by) => renderBreakdown(input, { color: "always", by })),
        renderTimeline(input, { color: "always" }),
        renderSessions(input, { color: "always" }),
        renderInsights(input, { color: "always" }),
      ]
      for (const output of outputs) {
        // 空报告彩色输出不得包含固定 24-bit RGB 前景。
        expect(output).not.toContain("\x1b[38;2;")
        // 不得包含具体背景色（40-47/100-107/48;2/48;5）。
        expect(concreteBackgroundAnsi(output)).toEqual([])
        // stripAnsi 后的可见正文必须与 color=never 完全一致。
        const plain = output.replace(/\x1b\[[0-9;]*m/g, "")
        expect(plain).not.toContain("\x1b[")
      }
      // Dashboard 和 Insights 空报告的 stripAnsi 等价性。
      expect(stripAnsi(renderDashboard(input, { color: "always" }))).toBe(renderDashboard(input, { color: "never" }))
      expect(stripAnsi(renderInsights(input, { color: "always" }))).toBe(renderInsights(input, { color: "never" }))
    })
  })

  test("respects color mode precedence with NO_COLOR truthy contract", () => {
    // R6 保留当前 truthy NO_COLOR 语义：只有非空字符串在 auto 模式禁用颜色。
    // 空字符串和未设置都不禁用 TTY 颜色。explicit always 始终开启，never 始终关闭。
    const originalTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY")
    const originalNoColor = process.env.NO_COLOR
    try {
      // auto + non-TTY → 纯文本。
      Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true })
      delete process.env.NO_COLOR
      expect(useColor("auto")).toBe(false)

      // auto + TTY + NO_COLOR 未设置 → 彩色。
      Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true })
      delete process.env.NO_COLOR
      expect(useColor("auto")).toBe(true)

      // auto + TTY + NO_COLOR="" → 彩色（空字符串按 truthiness 等同未设置）。
      process.env.NO_COLOR = ""
      expect(useColor("auto")).toBe(true)

      // auto + TTY + NO_COLOR="1" → 纯文本（非空字符串禁用）。
      process.env.NO_COLOR = "1"
      expect(useColor("auto")).toBe(false)

      // explicit always 即使 NO_COLOR 非空也输出彩色。
      process.env.NO_COLOR = "1"
      expect(useColor("always")).toBe(true)

      // explicit never 始终纯文本，不受 TTY/NO_COLOR 影响。
      Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true })
      process.env.NO_COLOR = "1"
      expect(useColor("never")).toBe(false)
      delete process.env.NO_COLOR
      expect(useColor("never")).toBe(false)
    } finally {
      if (originalTTY) Object.defineProperty(process.stdout, "isTTY", originalTTY)
      if (originalNoColor === undefined) delete process.env.NO_COLOR
      else process.env.NO_COLOR = originalNoColor
    }
  })
})
