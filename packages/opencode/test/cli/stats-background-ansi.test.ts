import { describe, expect, test } from "bun:test"
import { renderBreakdown, renderDashboard, renderTimeline, renderSessions } from "../../src/cli/cmd/stats-render"
import { renderInsights } from "../../src/cli/cmd/stats-insights"
import { report } from "../fixture/stats"

// #249：解析完整 SGR 参数表判断是否发射具体背景色——组合序列（如 0;44m、
// 39;48;5;12m）拆参后逐段判断；38;2/38;5 是前景色按参数个数跳过，避免误报
function concreteBackgroundAnsi(text: string): string[] {
  const hits: string[] = []
  const re = /\x1b\[([0-9;]*)m/g
  for (const match of text.matchAll(re)) {
    const params = match[1].split(";").filter(Boolean)
    for (let i = 0; i < params.length; i++) {
      const code = Number(params[i])
      if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) {
        // #249：标准 8 色与高亮 8 色背景区间一次性命中，避免逐码展开漏判
        hits.push(match[0])
        break
      }
      if ((code === 48 || code === 38) && (params[i + 1] === "2" || params[i + 1] === "5")) {
        // #249：48 是背景色直接命中；38 是前景色，跳过其后的色彩空间与参数继续扫描
        if (code === 48) {
          hits.push(match[0])
          break
        }
        i += params[i + 1] === "2" ? 4 : 3
      }
    }
  }
  return hits
}

describe("stats background ansi (#249)", () => {
  test("never emits terminal background ANSI in color output", () => {
    // 必须使用有数据报告驱动画布和表格；空态无法覆盖实际图元的颜色发射。
    const input = report()
    const outputs = [
      renderDashboard(input, { color: "always", limit: 5 }),
      ...(["model", "provider", "agent", "source", "project", "tool", "status"] as const).map((by) =>
        renderBreakdown(input, { color: "always", by }),
      ),
      renderSessions(input, { color: "always", limit: 5 }),
      renderTimeline(input, { color: "always" }),
      renderTimeline(input, { color: "always", metric: "cost", heatmap: true }),
      renderInsights(input, { color: "always" }),
      renderInsights(input, { color: "always", forecast: true }),
    ]
    for (const output of outputs) {
      // 49m 恢复用户默认背景，不能与设置具体背景色的 40-47/100-107/48 混为一谈。
      expect(concreteBackgroundAnsi(output)).toEqual([])
      expect(output).toContain("\x1b[49m")
      expect(output).toMatch(/\x1b\[9[1-6]m/)
    }
  })
})
