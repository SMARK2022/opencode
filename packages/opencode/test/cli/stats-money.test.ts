import { expect, test } from "bun:test"
import {
  renderDashboard,
  renderModels,
  renderProviders,
  renderSessions,
  renderTimeline,
} from "../../src/cli/cmd/stats-render"
import { formatNumber } from "../../src/cli/format"
import { renderHeatmap, renderRoundedLineChart } from "../../src/cli/cmd/stats-charts"
import { report } from "../fixture/stats"

test("small costs survive total, model, daily and session rendering", () => {
  const input = report()
  // 同一笔小额费用出现在每个 canonical 透视中，不能靠通用 Token formatter 保留小数。
  for (const rows of [
    input.daily,
    input.models,
    input.providers,
    input.agents,
    input.sources,
    input.statuses,
    input.projects,
    input.sessions,
  ])
    rows.forEach((row, index) => {
      row.cost = index === 0 ? 0.25 : 0
    })
  input.total.cost = 0.25
  // 所有 canonical 页都观察 Header 与各自明细，不能只证明一个独立 money helper 有小数。
  for (const output of [
    renderDashboard(input, { color: "never" }),
    renderModels(input, { color: "never" }),
    renderProviders(input, { color: "never" }),
    renderTimeline(input, { color: "never", metric: "cost" }),
    renderSessions(input, { color: "never" }),
  ]) {
    expect(output).toContain("Cost $0.2500")
    expect(output).not.toContain("Cost $0.0000")
  }
  expect(renderModels(input, { color: "never" })).toMatch(/claude-opus-4-6[\s\S]*\$0\.2500/)
  // 图轴可用紧凑单位，但日总量摘要与会话费用必须保留可核对的小额金额。
  expect(renderTimeline(input, { color: "never", metric: "cost" })).toContain("total $0.2500")
  expect(renderSessions(input, { color: "never" })).toMatch(/分支与dev分支合并冲突检测[\s\S]*\$0\.2500/)
  expect(formatNumber(100)).toBe("100")
  expect(formatNumber(1000)).toBe("1.0K")
  // Token 整数舍入与金额四位小数是两个既有公开契约，不能再次合并成一个格式器。
  expect(formatNumber(2.5)).toBe("3")
})

test("canonical model and provider ranking sorts before applying limit", () => {
  const input = report()
  // 费用序与 Token/calls 序相反，单行展示才能抓到先 limit 后 sort 的退化。
  const groups = [
    {
      ...input.models[0],
      id: "cost-top",
      label: "cost-top",
      cost: 10,
      assistantCalls: 1,
      tokens: { ...input.models[0].tokens, total: 100 },
    },
    {
      ...input.models[0],
      id: "token-top",
      label: "token-top",
      cost: 1,
      assistantCalls: 2,
      tokens: { ...input.models[0].tokens, total: 10000 },
    },
  ]
  const ranked = { ...input, models: groups, providers: groups }
  // 两个 wrapper 都走同一 Breakdown 路径，但仍各自执行，防止某个 wrapper 私自补默认 sort。
  for (const render of [renderModels, renderProviders])
    for (const sort of ["cost", "tokens", "calls"] as const) {
      const output = render(ranked, { color: "never", limit: 1, sort })
      expect(output).toContain(sort === "cost" ? "cost-top" : "token-top")
      expect(output).not.toContain(sort === "cost" ? "token-top" : "cost-top")
      // 同时拒绝另一实体，避免一个错误的未限行结果因为含有目标名称而通过。
    }
  // 排名不得就地改写报告，其他页面随后仍消费相同的输入顺序。
  expect(groups.map((group) => group.id)).toEqual(["cost-top", "token-top"])
})

test("heatmaps retain the complete month rather than the final twelve days", () => {
  // 最大值故意在首日，截掉月初时仍然有图可画，但 peak 999 会明确消失。
  const points = Array.from({ length: 31 }, (_, index) => ({
    day: new Date(2026, 0, index + 1).getTime(),
    value: index === 0 ? 999 : index,
    label: `01-${String(index + 1).padStart(2, "0")}`,
  }))
  const output = renderHeatmap({ title: "January", points, color: "never", width: 48 })
  // 源热图以每自然日双字符格编码，没有逐日日期标签；31 格和首日峰值共同锁定完整月份。
  expect(
    output
      .slice(1, 8)
      .join("")
      .match(/[·░▒▓█]/g),
  ).toHaveLength(62)
  expect(output.join("\n")).toContain("peak 999")
})

test("line charts retain every series and its identity", () => {
  // 同一天两个不同量级并保留两种身份，能抓到只取第一条 series 的简化实现。
  const first = new Date(2026, 0, 1).getTime()
  const text = renderRoundedLineChart({
    title: "Bounds",
    color: "never",
    series: [
      { id: "lower", label: "lower-bound", color: "blue", points: [{ x: first, y: 1 }] },
      { id: "upper", label: "upper-bound", color: "red", points: [{ x: first, y: 9 }] },
    ],
  }).join("\n")
  expect(text).toContain("lower-bound")
  expect(text).toContain("upper-bound")
  expect(text).toContain("01-01")
  // 二维图不再逐点列数值；早期峰值通过坐标范围、末端通过日期保留，均为真实输出。
  const full = renderRoundedLineChart({
    // 75 天大于 20 列，可观察时间轴压缩；不要求恢复旧逐点列表来获得每个数字。
    title: "Full interval",
    color: "never",
    formatter: String,
    width: 20,
    series: [
      {
        id: "full",
        label: "Full",
        color: "blue",
        points: Array.from({ length: 75 }, (_, index) => ({
          x: new Date(2026, 0, index + 1).getTime(),
          y: index === 0 ? 999 : 1,
        })),
      },
    ],
  }).join("\n")
  expect(full).toContain("1000")
  // 轴上圆整峰值验证早期数据仍参与域计算，首尾日期验证窗口未被静默缩为最后几天。
  expect(full).toContain("01-01")
  expect(full).toContain("03-16")
})
