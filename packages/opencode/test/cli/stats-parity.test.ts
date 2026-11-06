import { expect } from "bun:test"
import { Effect } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import {
  ColdStorageTable,
  MessageTable,
  PartTable,
  SessionMessageTable,
  SessionTable,
} from "@opencode-ai/core/session/sql"
import { RequestUsageAssistantTable, RequestUsageTable } from "@opencode-ai/core/session/request-usage.sql"
import { Session } from "../../src/session/session"
import { aggregateStats, type StatsFilter, type StatsReport } from "../../src/cli/cmd/stats-data"
import {
  renderBreakdown,
  renderDashboard,
  renderSessions,
  renderTimeline,
  type ColorMode,
} from "../../src/cli/cmd/stats-render"
import { renderInsights } from "../../src/cli/cmd/stats-insights"
import { testEffect } from "../lib/effect"
import { expectedTotals, filters, seedStatsDatabase, setStatsScenario } from "../fixture/stats-database"
import baseline from "../fixture/stats-baseline.json"

// 只运行当前源码；固定 JSON 由旧 git SHA 独立查询同样的真实 rows 后生成，不在 CI 携带旧算法。
const it = testEffect(
  // Session 服务保留当前 Native/cold 读取能力；内存库只隔离存储，不替换任何查询实现。
  LayerNode.compile(LayerNode.group([Session.node, Database.node]), [
    [Database.node, Database.layerFromPath(":memory:")],
  ]),
)
const pages: Record<string, (report: StatsReport, color: ColorMode) => string> = {
  // 这里只选择公开页面和公开选项，不复制绘图算法或从目标输出构造预期。
  dashboard: (report, color) => renderDashboard(report, { color }),
  "breakdown-model": (report, color) => renderBreakdown(report, { color, by: "model" }),
  "breakdown-provider": (report, color) => renderBreakdown(report, { color, by: "provider" }),
  "breakdown-agent": (report, color) => renderBreakdown(report, { color, by: "agent" }),
  "breakdown-source": (report, color) => renderBreakdown(report, { color, by: "source" }),
  "breakdown-project": (report, color) => renderBreakdown(report, { color, by: "project" }),
  "breakdown-tool": (report, color) => renderBreakdown(report, { color, by: "tool" }),
  "breakdown-status": (report, color) => renderBreakdown(report, { color, by: "status" }),
  "timeline-tokens": (report, color) => renderTimeline(report, { color, metric: "tokens" }),
  "timeline-cost": (report, color) => renderTimeline(report, { color, metric: "cost" }),
  "timeline-heatmap": (report, color) => renderTimeline(report, { color, heatmap: true }),
  sessions: (report, color) => renderSessions(report, { color }),
  insights: (report, color) => renderInsights(report, { color }),
  forecast: (report, color) => renderInsights(report, { color, forecast: true }),
}

// 唯一允许忽略的内部缓存是日点 label：源本地化名称和当前 MM-DD 不参与最终坐标生成。
// 此处理只用于报告结构比较；下面所有页面仍比较包含 ANSI、空格和换行的原始完整字符串。
const comparable = (report: unknown): unknown =>
  // 比较对象语义而非对象属性插入顺序；精确字节只在用户实际看到的页面层约束。
  JSON.parse(
    JSON.stringify(report, function (this: { day?: number }, key, value: unknown) {
      return key === "label" && typeof this.day === "number" ? undefined : value
    }),
  )

it.effect("matches pinned dev-smark output from a real tiny database without writes", () =>
  Effect.gen(function* () {
    const database = yield* Database.Service
    const original = {
      // 所有宿主状态都在 finally 归还，不能让本条固定时区/TTY 影响后续真实命令测试。
      timezone: process.env.TZ,
      now: Date.now,
      columns: Object.getOwnPropertyDescriptor(process.stdout, "columns"),
      tty: Object.getOwnPropertyDescriptor(process.stdout, "isTTY"),
    }
    process.env.TZ = baseline.timezone
    // 空筛选窗口也经过真实聚合；固定当前自然日，避免快照混入执行当天的日期。
    Date.now = () => baseline.now
    try {
      expect(baseline.source).toBe("26061b595b3140d37717248222c7ed2016421db0")
      yield* seedStatsDatabase()
      const stored = Effect.all([
        database.db.select().from(ProjectTable).all(),
        database.db.select().from(SessionTable).all(),
        database.db.select().from(MessageTable).all(),
        database.db.select().from(PartTable).all(),
        database.db.select().from(RequestUsageTable).all(),
        database.db.select().from(RequestUsageAssistantTable).all(),
        database.db.select().from(SessionMessageTable).all(),
        database.db.select().from(ColdStorageTable).all(),
      ])
      const reports: Record<string, StatsReport> = {}
      // 每种筛选报告只聚合一次，再通过多宽度/色彩观察同一结果，避免视图各自改用量。
      const expectedReports: Record<string, unknown> = baseline.reports
      const collect = (name: string, filter: StatsFilter) =>
        Effect.gen(function* () {
          const before = yield* stored
          const report = yield* aggregateStats(filter)
          expect(comparable(report), `report ${name}`).toEqual(comparable(expectedReports[name]))
          // 报告全字段先与固定旧查询对齐，防止两个 renderer 恰好同时省略某字段而掩盖 Data 丢失。
          // 包括空 Native/Cold 表在内逐行比较，不能只证明 Part 没变便宣称查询完全只读。
          expect(yield* stored, `read-only ${name}`).toEqual(before)
          reports[name] = report
          return report
        })
      for (const name of ["all", "provider", "agent", "status", "tool"] as const) {
        const report = yield* collect(name, filters[name])
        expect(report.total.tokens.total).toBe(expectedTotals[name].tokens)
        expect(report.total.cost).toBe(expectedTotals[name].cost)
        expect(report.total.requests).toBe(expectedTotals[name].requests)
        // 事件、逐日、模型和会话共享同一权威；这些独立值不从任何页面字符串反算。
        expect(report.daily.reduce((sum, row) => sum + row.tokens.total, 0)).toBe(expectedTotals[name].tokens)
        expect(report.models.reduce((sum, row) => sum + row.cost, 0)).toBeCloseTo(expectedTotals[name].cost, 10)
        expect(report.sessions.reduce((sum, row) => sum + row.tokens.total, 0)).toBe(expectedTotals[name].tokens)
      }
      yield* collect("empty", { modelFilter: "missing-model" })
      for (const scenario of ["no-cost", "tool-only"] as const) {
        // 输入变化属于显式 fixture 阶段，统计自身的只读快照从变化完成后开始检查。
        yield* setStatsScenario(scenario)
        yield* collect(scenario, {})
      }
      const beforeRender = yield* stored
      // 65/66、105/106、135/136 的源断点样本也在固定矩阵中，不能只验证常用四个整宽。
      for (const entry of baseline.cases) {
        if (entry.color !== "always" && entry.color !== "never") throw new Error(`Invalid oracle color ${entry.color}`)
        Object.defineProperty(process.stdout, "columns", { value: entry.columns, configurable: true })
        Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true })
        const key = `${entry.fixture}/${entry.page}/${entry.columns}/${entry.color}`
        const actual = pages[entry.page](reports[entry.fixture], entry.color)
        if (actual !== entry.expected) {
          // 失败只展示首个差异行，保留精确字节而不把整份大图冲进终端诊断。
          const lines = actual.split("\n")
          const expected = entry.expected.split("\n")
          const first = lines.findIndex((line, index) => line !== expected[index])
          const index = first < 0 ? lines.length : first
          expect(lines[index], `${key}: first difference at line ${index + 1}`).toBe(expected[index])
        }
        expect(actual, key).toBe(entry.expected)
        // 不 trim、不 stripAnsi、不格式化数字；连末行留白和样式复位都属于完整输出契约。
      }
      expect(yield* stored).toEqual(beforeRender)
      // 防止错误地删掉一组 case 后仍绿；覆盖的是完整页面×筛选×宽度×色彩，而非抽样标题。
      expect(baseline.cases).toHaveLength(1064)
    } finally {
      Date.now = original.now
      if (original.timezone === undefined) delete process.env.TZ
      else process.env.TZ = original.timezone
      if (original.columns) Object.defineProperty(process.stdout, "columns", original.columns)
      else Reflect.deleteProperty(process.stdout, "columns")
      if (original.tty) Object.defineProperty(process.stdout, "isTTY", original.tty)
      else Reflect.deleteProperty(process.stdout, "isTTY")
    }
  }),
)
