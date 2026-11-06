import { describe, expect, test } from "bun:test"
import { SessionID } from "../../src/session/schema"
import { buildForecast, renderInsights } from "../../src/cli/cmd/stats-insights"
import {
  renderBreakdown,
  renderDashboard,
  renderModels,
  renderProviders,
  renderSessions,
  renderTimeline,
} from "../../src/cli/cmd/stats-render"
import {
  fitVisible,
  paint,
  renderContext,
  renderRoundedLineChart,
  stripAnsi,
  truncateVisible,
  useColor,
  visibleLength,
} from "../../src/cli/cmd/stats-charts"
import { report, emptyReport, day, tokens, components, contextUsage, addUsage } from "../fixture/stats"

const dimensions = ["model", "provider", "agent", "source", "project", "tool", "status"] as const
// 只控制公开终端宽度，不替换布局 helper；每次恢复属性描述符，防止串行用例相互污染。
const withColumns = (columns: number, run: () => void) => {
  const original = Object.getOwnPropertyDescriptor(process.stdout, "columns")
  Object.defineProperty(process.stdout, "columns", { value: columns, configurable: true })
  try {
    run()
  } finally {
    if (original) Object.defineProperty(process.stdout, "columns", original)
    else Reflect.deleteProperty(process.stdout, "columns")
  }
}
const calendarRows = (output: string) =>
  // 周编号和密度单元共同定位实际日历行，不能把别的章节出现的块字符误当日历。
  output
    .split("\n")
    .map(stripAnsi)
    .filter((line) => /^\s+\d{1,2}\s+[·░▒▓█]/.test(line))
const concreteBackgroundAnsi = (output: string) =>
  // 解析完整组合 SGR；49m 只恢复默认背景，38 的色彩参数不能被误认成背景码。
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

describe("stats breakdown analysis", () => {
  test("keeps colored breakdown trend lines free of point markers", () => {
    // 彩色折线依赖颜色区分，plot 中不能再用粗点遮挡路径；完整名称在图下直接回显。
    withColumns(140, () => {
      const lines = renderBreakdown(report(), { color: "always", by: "model" }).split("\n").map(stripAnsi)
      const start = lines.findIndex((line) => line.includes("Token trend"))
      // 截到下一节，既观察真实 plot，又保留其下直接图例；不能只测一个标题片段。
      const end = lines.findIndex((line) => line.includes("Model portfolio"))
      expect(start).toBeGreaterThanOrEqual(0)
      const trend = lines.slice(start + 1, end).join("\n")
      expect(trend).not.toMatch(/[●◆■▲◇○✕+]/)
      for (const name of ["claude-opus-4-6", "gpt-5.5"]) expect(trend).toContain(name)
      expect(trend).not.toMatch(/\[\d+\]/)
      // 拒绝编号同时要求完整名称，防止另一种静默 clip 实现只因没有省略号而漏检。
      const tools = stripAnsi(renderBreakdown(report(), { color: "always", by: "tool" }))
      // Tool 走估算上下文 series，必须与模型图一样保留名称，不能沿用旧编号矩阵。
      const toolTrend = tools.slice(tools.indexOf("Estimated context trend"), tools.indexOf("Tool footprint"))
      expect(toolTrend).toContain("apply_patch")
      expect(toolTrend).toContain("bash")
      expect(toolTrend).not.toMatch(/\[\d+\]/)
    })
  })

  test("carries each entity series color across trends, legends, and analytical rows", () => {
    // Provider 默认按 cost 排序，身份映射必须从该可见顺序贯穿多个后续透视。
    // 同一实体的颜色要跨 plot、legend、分析表、短趋势保持一致，缺失 series 不能重新编号。
    withColumns(140, () => {
      const colored = renderBreakdown(report(), { color: "always", by: "provider" })
      const trend = colored.slice(colored.indexOf("Cost trend"), colored.indexOf("Provider economics"))
      expect(trend).toContain("\x1b[94mDaXiao Codex")
      expect(trend).toContain("\x1b[92m本地提供商")
      const economics = colored.slice(
        colored.indexOf("Provider economics"),
        colored.indexOf("Model portfolio by provider"),
      )
      expect(economics.split("\n").find((line) => stripAnsi(line).trimStart().startsWith("DaXiao Codex"))).toContain(
        "\x1b[94mDaXiao Codex",
      )
      const capacity = colored.slice(colored.indexOf("Capacity & reliability"))
      // 同一实体在标签和短趋势各有前景色，单一有色行标题不足以满足这个断言。
      expect(
        capacity
          .split("\n")
          .find((line) => stripAnsi(line).trimStart().startsWith("DaXiao Codex"))
          ?.match(/\x1b\[94m/g)?.length,
      ).toBeGreaterThanOrEqual(2)
      const tools = renderBreakdown(report(), { color: "always", by: "tool" })
      const toolTrend = tools.slice(tools.indexOf("Estimated context trend"), tools.indexOf("Tool footprint"))
      expect(toolTrend).toContain("\x1b[94mapply_patch")
      expect(toolTrend).toContain("\x1b[92mbash")
      const project = renderBreakdown(report(), { color: "always", by: "project" })
      // Project 不经普通 table 第一列，单独观察它能防止自定义身份卡片漏掉实体色。
      expect(project.slice(project.indexOf("Project portfolio"), project.indexOf("Runtime mix"))).toContain(
        "\x1b[94m本地项目",
      )
      const timeline = renderTimeline(report(), { color: "always" })
      // 日期排名不承载实体身份色；不能把日期当另一个系列而套用分类色盘。
      const models = timeline.slice(timeline.indexOf("Models"), timeline.indexOf("Providers"))
      expect(models).toContain("\x1b[94mclaude-opus-4-6")
      expect(models).toContain("\x1b[92mgpt-5.5")
      expect(timeline.slice(timeline.indexOf("Providers"))).toContain("\x1b[94mDaXiao Codex")
      expect(timeline.slice(timeline.indexOf("Top active days"), timeline.indexOf("Entity trends"))).not.toMatch(
        /\x1b\[(?:34|32|33|35|95|36|93|31)m\d{2}-\d{2}/,
      )
      const partial = report()
      // 删除第一条 series 而保留所有 group，逼出“压缩索引后换颜色”的真实迁移错误。
      partial.providerSeries = partial.providerSeries.slice(1)
      partial.toolSeries = partial.toolSeries.slice(1)
      const provider = renderBreakdown(partial, { color: "always", by: "provider" })
      const tool = renderBreakdown(partial, { color: "always", by: "tool" })
      expect(provider.slice(provider.indexOf("Cost trend"), provider.indexOf("Provider economics"))).toContain(
        "\x1b[92m本地提供商",
      )
      expect(tool.slice(tool.indexOf("Estimated context trend"), tool.indexOf("Tool footprint"))).toContain(
        "\x1b[92mbash",
      )
      expect(stripAnsi(colored)).toBe(renderBreakdown(report(), { color: "never", by: "provider" }))
      // 去色仅用于这里的语义等价断言；整页 oracle 另外直接比较完整 ANSI 字符串。
      expect(stripAnsi(timeline)).toBe(renderTimeline(report(), { color: "never" }))
    })
  })

  test("marks provider risk outliers without treating a high cache share as failure", () => {
    // 高缓存属于健康信号，但同一 Provider 可同时是费用异常；不能按行统一染红。
    // 风险标记必须在无色终端保留，颜色并非唯一能读取结论的通道。
    const input = report()
    // 十一个样本锁定 3σ 费用尖峰和两个 2σ 失败尖峰，limit 不得改变基线。
    input.providers = [
      "cost-outlier",
      "failure-a",
      "failure-b",
      ...Array.from({ length: 8 }, (_, index) => `baseline-${index + 1}`),
    ].map((id, index) => ({
      ...input.providers[0],
      id,
      label: id,
      tokens: {
        input: index === 0 ? 30 : 500,
        output: index === 0 ? 10 : 100,
        reasoning: 0,
        cache: { read: index === 0 ? 960 : 400, write: 0 },
        total: 1000,
      },
      cost: index === 0 ? 1000 : 10,
      requests: 10,
      assistantCalls: index === 0 ? 1 : 10,
      errors: index === 1 || index === 2 ? 10 : 0,
      aborted: 0,
      durationMs: 10_000,
    }))
    input.providerSeries = input.providers.map((item) => ({
      ...item,
      points: input.daily.map((point) => ({ ...point, ...item, day: point.day, label: point.label })),
    }))
    input.total = addUsage(input.providers)
    // 只显示两行仍与十一项总体比较，能区分先 limit 再算 sigma 的错误实现。
    withColumns(160, () => {
      const colored = renderBreakdown(input, { color: "always", by: "provider", limit: 2 })
      const plain = renderBreakdown(input, { color: "never", by: "provider", limit: 2 })
      expect(colored).toContain("\x1b[91m$1000!")
      expect(colored).toContain("\x1b[33m100.0%^")
      expect(plain).toContain("! >=3σ")
      expect(plain).toContain("^ >=2σ")
      expect(colored).toContain("\x1b[92m96.0%")
      // 颜色的加入不能顺手改变原数字、风险 marker、列间距或行顺序。
      expect(stripAnsi(colored)).toBe(plain)
    })
  })

  test("sorts tool breakdown by calls when requested", () => {
    // calls 是实际执行次数，context 是后续消费估算，二者排序不能总是绑定。
    // 让 context 和调用量顺序相反，才能发现先限行或静默忽略 sort 的错误。
    const input = report()
    input.toolUsage = [
      { id: "large-context", count: 1, inputChars: 10, outputChars: 20, contextTokens: 1000 },
      { id: "frequent-calls", count: 20, inputChars: 200, outputChars: 400, contextTokens: 100 },
    ]
    withColumns(140, () => {
      const output = renderBreakdown(input, { color: "never", by: "tool", sort: "calls" })
      // 比较首次实体出现位置即可观察主排名，无需窥探内部排序函数或调用次数。
      expect(output.indexOf("frequent-calls")).toBeLessThan(output.indexOf("large-context"))
    })
  })

  test("gives every breakdown dimension a distinct analytical view", () => {
    // 按维度列出独立章节，避免一张通用表带不同标题就被误认成七个已恢复页面。
    // 相同排名壳不能替代维度专属分析；章节齐全后仍须保持源页面的信息密度。
    const expected = {
      model: ["Model portfolio", "Token composition", "Routing & tools"],
      provider: ["Provider economics", "Model portfolio by provider", "Capacity & reliability"],
      agent: ["Agent workload", "Input context composition", "Runtime mix"],
      source: ["Source workload", "Input context composition", "Routing mix"],
      project: ["Project portfolio", "Runtime mix", "Largest sessions inside each project"],
      status: ["Outcome distribution", "Status efficiency", "Failure leaders within each dimension"],
      tool: ["Tool footprint", "Issuing runtime", "avg/call"],
    }
    withColumns(120, () => {
      for (const by of dimensions) {
        const output = renderBreakdown(report(), { color: "never", by })
        for (const section of expected[by]) expect(output).toContain(section)
        expect(output.split("\n").length).toBeLessThanOrEqual(64)
        // 原已退役 detail/matrix 不能与 canonical 章节一起重复输出，挤掉源版紧凑结构。
        for (const retired of ["token detail", "Token composition across all", "Provider × model token matrix"])
          expect(output).not.toContain(retired)
        expect(output).not.toMatch(/\[\d+\]/)
      }
      const provider = renderBreakdown(report(), { color: "never", by: "provider" })
      expect(provider).toContain("Cost trend · top 2 providers")
      expect(provider).toContain("2 total · sorted by cost")
      expect(renderBreakdown(report(), { color: "never", by: "model", limit: 1 })).toContain("2 total")
      // 限行只限制可见对象，不能让用户误以为筛选后只剩一个模型。
    })
  })

  test("renders the complete model breakdown analysis instead of a generic table shell", () => {
    // 第四个 Provider 与工具强制进入 other，主表与路由表必须保留不同分母和长尾。
    // 同时保留 owner 与 Assistant 术语，避免请求数、调用数同名后丢失来源差异。
    withColumns(140, () => {
      const input = report()
      input.models[0].providers = [60, 20, 10, 10].map((value, index) => ({ id: `provider-${index}`, tokens: value }))
      // 四项而非恰好三项，让 Top-3 之外的 10% 有明确、独立的可观察归宿。
      input.toolCalls = ["read", "bash", "grep", "task"].map((toolID, index) => ({
        ...input.toolCalls[0],
        toolID,
        modelID: input.models[0].id,
        calls: [60, 20, 10, 10][index],
      }))
      const output = renderBreakdown(input, { color: "never", by: "model" })
      expect(output).toContain("opencode stats · Breakdown / Model")
      expect(output).toContain("Models · top claude-opus-4-6 1.4B (60.0%) · 2 total · sorted by tokens")
      expect(output).toContain("Token trend · top 2 models")
      const portfolio = output.slice(output.indexOf("Model portfolio"), output.indexOf("Token composition"))
      // 在对应 section 内检查每列，不能让相同单词出现在页头或别的表便掩盖列丢失。
      for (const metric of [
        "tokens",
        "share",
        "cost",
        "owned req",
        "calls",
        "tok/call",
        "sessions",
        "owner fail",
        "owner avg",
        "RequestUsage owner",
        "Assistant usage",
      ])
        expect(portfolio).toContain(metric)
      const composition = output.slice(output.indexOf("Token composition"), output.indexOf("Routing & tools"))
      // 必须存在实质组成图和五项细节，只有“Token composition”文字不构成图形验收。
      expect(composition).toMatch(/[█▓▒░]{3}/)
      for (const part of ["cache read", "input", "output", "reasoning", "cache write"])
        expect(composition).toContain(part)
      const routing = output.slice(output.indexOf("Routing & tools"))
      // ToolPart 归因不是计费归因，明确文案防止把这一百分比错误解释成模型工具费用。
      for (const text of ["other 10.0%", "ToolParts issued by each model", "not Tool cost or billed tokens"])
        expect(routing).toContain(text)
    })
  })

  test("aligns model token composition as exact 100% stacks without inflating tiny parts", () => {
    // 一枚 reasoning Token 必须在精确明细里保留，但不足一个字符格时不得强行抬高其条宽。
    // 极小 reasoning、均分组成和全零三种行共同验证图形舍入与无色精确值。
    const input = report()
    input.models[0].label = "m"
    input.models[0].tokens = {
      input: 100_000,
      output: 100_000,
      reasoning: 1,
      cache: { read: 799_999, write: 0 },
      total: 1_000_000,
    }
    input.models[1].label = "model-with-long-name"
    input.models[1].tokens = { input: 200, output: 200, reasoning: 200, cache: { read: 200, write: 200 }, total: 1000 }
    input.models.push({ ...input.models[1], id: "zero-model", label: "zero-model", tokens: tokens(0) })
    input.total = addUsage(input.models)
    withColumns(140, () => {
      const colored = renderBreakdown(input, { color: "always", by: "model" })
      const composition = colored.slice(colored.indexOf("Token composition"), colored.indexOf("Routing & tools"))
      const bars = composition.split("\n").filter((line) => stripAnsi(line).includes("█"))
      // 两种模型规模不同，组成条仍应拥有相同起点和总宽度，而非各自按名称长度漂移。
      expect(bars).toHaveLength(2)
      const visibleBars = bars.map(stripAnsi)
      expect(visibleBars[1]).toContain("model-with-long-name")
      expect(new Set(visibleBars.map((line) => line.indexOf("█"))).size).toBe(1)
      const widths = visibleBars.map((line) => line.match(/█+/)?.[0].length ?? 0)
      expect(new Set(widths).size).toBe(1)
      expect(widths[0]).toBeGreaterThan(20)
      for (const ansi of [94, 92, 95, 93, 35]) expect(composition).toMatch(new RegExp(`\x1b\\[${ansi}m█`))
      expect(bars[0]).not.toContain("\x1b[95m█")
      // 此处只拒绝虚增图形面积；下面的 reasoning 精确值必须继续存在，不能一起丢掉。
      expect(stripAnsi(composition)).toContain("reasoning 1 0.0%")
      expect(stripAnsi(composition)).toContain("cache write 200 20.0%")
      expect(stripAnsi(composition)).toMatch(/zero-model\s+░{20,} 0%/)
      // 全零行明确为 0%，不能因为 largest-remainder 分配而给任一类别补成 100%。
      expect(stripAnsi(colored)).toBe(renderBreakdown(input, { color: "never", by: "model" }))
    })
  })
})

describe("stats complete dimensions", () => {
  test("renders provider economics and reliability with their complete request and Assistant denominators", () => {
    // Provider 的 Token 权重和 cost 权重已固定为不同口径，默认费用主图必须独立于模型页。
    // 路由总和为 100，前三项只覆盖 90，缺少 other 会在用户层直接丢失归因。
    withColumns(140, () => {
      const input = report()
      input.providers[0].models = [60, 20, 10, 10].map((value, index) => ({ id: `model-${index}`, tokens: value }))
      const output = renderBreakdown(input, { color: "never", by: "provider" })
      expect(output).toContain("opencode stats · Breakdown / Provider")
      expect(output).toContain("Providers · top DaXiao Codex $89 (70.0%) · 2 total · sorted by cost")
      expect(output).toContain("Cost trend · top 2 providers")
      // owned request 健康和 Assistant 计费使用不同分母，不能在同一费用表中混算。
      const economics = output.slice(
        output.indexOf("Provider economics"),
        output.indexOf("Model portfolio by provider"),
      )
      for (const metric of [
        "tokens",
        "share",
        "cost",
        "cost share",
        "owned req",
        "calls",
        "$/call",
        "cache",
        "owner fail",
        "owner avg",
        "Request-owner metrics can be zero",
      ])
        expect(economics).toContain(metric)
      expect(
        output.slice(output.indexOf("Model portfolio by provider"), output.indexOf("Capacity & reliability")),
      ).toContain("other 10.0%")
      const capacity = output.slice(output.indexOf("Capacity & reliability"))
      // reliability 使用真实结果数，短趋势使用费用量纲，两者都必须出现在专属 section。
      for (const metric of ["tok/$", "tok/call", "output", "errors", "aborted", "completed", "recent cost/day"])
        expect(capacity).toContain(metric)
      expect(capacity).toMatch(/[▁▂▃▄▅▆▇█]{8,}/)
    })
  })

  test("renders Agent workload and the complete input context denominator", () => {
    // 工作负载不仅是 Token 排名，需同时回答覆盖会话数与每请求调用密度。
    // 十类组成分别核对字段名，防止仅保留大类的简化实现用一个合计百分比代替。
    withColumns(140, () => {
      const output = renderBreakdown(report(), { color: "never", by: "agent" })
      expect(output).toContain("opencode stats · Breakdown / Agent")
      expect(output).toContain("Agents · top build 2.3B (100.0%) · 1 total · sorted by tokens")
      expect(output).toContain("Token trend · top 1 agents")
      const workload = output.slice(output.indexOf("Agent workload"), output.indexOf("Input context composition"))
      // 明细截在章节边界，后续 Runtime 的同名词不能补救工作负载表缺列。
      for (const metric of [
        "tokens",
        "sessions",
        "cost",
        "owned req",
        "calls",
        "calls/req",
        "tok/session",
        "cache",
        "owner fail",
        "owner avg",
      ])
        expect(workload).toContain(metric)
      // 十类输入必须分别可读；Runtime 计量也不能吞掉未计费的工具调用。
      const context = output.slice(output.indexOf("Input context composition"), output.indexOf("Runtime mix"))
      for (const component of [
        "system",
        "instruct",
        "skills",
        "schemas",
        "user",
        "assistant",
        "reasoning",
        "tool calls",
        "tool results",
        "attach",
      ])
        expect(context).toContain(component)
      // Runtime 保持不同权重说明，不能把所有 mix 都标成 Token share。
      for (const metric of ["Runtime mix", "models by tokens", "providers by tokens", "tools by calls"])
        expect(output).toContain(metric)
    })
  })

  test("renders Source workload with request-owner availability and complete context attribution", () => {
    // legacy-message 有合法 Assistant 用量而没有 request shell，不应被当空来源隐藏。
    withColumns(140, () => {
      const input = report()
      // 合法的 legacy Assistant 没有 request 分母，四类不可用必须明确出现。
      const legacy = {
        ...input.sources[0],
        id: "legacy-message",
        label: "legacy-message",
        tokens: tokens(1000),
        components: components(0),
        cost: 5,
        requests: 0,
        assistantCalls: 10,
        errors: 0,
        aborted: 0,
        durationMs: 0,
      }
      input.sources.push(legacy)
      // 既保留实体又提供时间序列，路径会进入趋势和分析两层，不是只测试空图短路。
      input.sourceSeries.push({
        ...input.sourceSeries[0],
        ...legacy,
        points: input.sourceSeries[0].points.map((point) => ({ ...point, ...contextUsage(100) })),
      })
      const output = renderBreakdown(input, { color: "never", by: "source" })
      expect(output).toContain("opencode stats · Breakdown / Source")
      expect(output).toContain("Token trend · request sources")
      const workload = output.slice(output.indexOf("Source workload"), output.indexOf("Input context composition"))
      for (const metric of [
        "owned req",
        "calls",
        "tokens",
        "tok/req*",
        "cost",
        "cost/req*",
        "sessions",
        "cache",
        "output",
        "fail*",
        "avg*",
      ])
        expect(workload).toContain(metric)
      expect(
        workload
          .split("\n")
          .find((line) => line.includes("legacy-message"))
          ?.match(/—/g)?.length,
      ).toBeGreaterThanOrEqual(4)
      expect(workload).toContain("request-owner denominator and health")
      // 四个 unavailable 对应每请求数量、费用、失败与时延，不能只省略一个异常字段。
      const context = output.slice(output.indexOf("Input context composition"), output.indexOf("Routing mix"))
      expect(context).toContain("component attribution unavailable for these records")
      // 无归因与零占比是不同事实，保留不可用文案而非伪造十个精确的 0%。
      expect(context).toContain("other")
      const routing = output.slice(output.indexOf("Routing mix"))
      expect(routing).toContain("models by tokens")
      expect(routing).toContain("providers by tokens")
      expect(routing).not.toContain("issued tool calls")
      // Source 的 routing 职责只列模型和 Provider，不引回已归一化到 Tool 的重复明细。
    })
  })

  test("renders Project identity, portfolio, runtime mix, and largest Session as one complete page", () => {
    // 使用稳定 Project ID 连接 Session，同时单独检查中文名称和完整路径。
    // 这样改名或同名项目不会靠标题字符串相等意外通过最大 Session 归属断言。
    withColumns(140, () => {
      const input = report()
      input.sessions.forEach((session) => {
        session.projectID = input.projects[0].id
      })
      // fixture 原先的占位 Project ID 在此显式关联，最大会话不能因没有匹配就默默输出破折号。
      const output = renderBreakdown(input, { color: "never", by: "project" })
      expect(output).toContain("opencode stats · Breakdown / Project")
      expect(output).toContain("Projects · top 本地项目 2.3B (100.0%) · 1 total · sorted by tokens")
      expect(output).toContain("Token trend · top 1 projects")
      expect(output).toContain("━━━ Project portfolio")
      const portfolio = output.slice(output.indexOf("Project portfolio"), output.indexOf("Runtime mix"))
      for (const text of ["/tmp/本地项目", "tok 100.0%", "sessions", "req", "calls", "active days", "cache", "fail"])
        expect(portfolio).toContain(text)
      expect(portfolio).not.toContain("Active days")
      // active days 是卡片内指标，不再复制成一张空布局的独立旧图。
      const runtime = output.slice(
        output.indexOf("Runtime mix"),
        output.indexOf("Largest sessions inside each project"),
      )
      for (const metric of ["models by tokens", "providers by tokens", "tools by calls"])
        expect(runtime).toContain(metric)
      const sessions = output.slice(output.indexOf("Largest sessions inside each project"))
      // 必须展示真实会话标题、用量和请求数，仅有“largest”章节无法证明关联正确。
      for (const text of ["分支与dev分支合并冲突检测", "322.0M", "requests", "│ 12"]) expect(sessions).toContain(text)
    })
  })

  test("renders Tool context estimates separately from measured ToolPart footprint", () => {
    // 真实执行足迹和后续 context 消费估算来源不同，不能共享一个含混的 Token 数。
    // in/out chars 每调用量、errors、耗时是实际执行信息，计费未知不应使这些列消失。
    withColumns(140, () => {
      const output = renderBreakdown(report(), { color: "never", by: "tool" })
      expect(output).toContain("opencode stats · Breakdown / Tool")
      expect(output).toContain("estimated context tokens · sorted by estimated context tokens")
      expect(output).toContain("Estimated context trend · top 2 tools")
      const footprint = output.slice(output.indexOf("Tool footprint"), output.indexOf("Issuing runtime"))
      // 费用不是工具调用计量，精确数值、估算语义和 request/ToolState 筛选都必须可审计。
      for (const metric of [
        "calls",
        "call share",
        "est ctx tok",
        "ctx share",
        "ctx/call",
        "in chars/c",
        "out chars/c",
        "errors",
        "avg/call",
        "prior Tool input/output",
        "no row represents Tool cost or billed tokens",
        "Tool errors are ToolPart execution errors",
        "--status filters associated request/Assistant status",
      ])
        expect(footprint).toContain(metric)
      // 这些说明必须属于足迹 section，不能只存在于命令帮助或独立文档。
      const runtime = output.slice(output.indexOf("Issuing runtime"))
      // Tool runtime 以 calls 归因，模型/Agent/Project 三个视角不得由 context 权重猜测。
      for (const metric of ["top models by calls", "top agents by calls", "projects by calls"])
        expect(runtime).toContain(metric)
    })
  })

  test("renders Status as request outcomes with ratios, unattributed usage, and cross-dimension failure leaders", () => {
    // 四种 outcome 总和恰好为 100，另加无 owner 的 Assistant，能发现请求分母重复计数。
    // statusSeries 与分组分别提供，测试会驱动百分比主图而不只经过静态结果列表。
    withColumns(140, () => {
      const input = report()
      const base = input.statuses[0]
      Object.assign(input.total, { requests: 100, errors: 12, aborted: 7 })
      input.statuses = [
        { ...base, id: "completed", label: "completed", requests: 80, errors: 0, aborted: 0 },
        { ...base, id: "error", label: "error", requests: 12, errors: 12, aborted: 0 },
        { ...base, id: "aborted", label: "aborted", requests: 7, errors: 0, aborted: 7 },
        { ...base, id: "running", label: "running", requests: 1, errors: 0, aborted: 0 },
        { ...base, id: "unattributed", label: "unattributed", requests: 0, errors: 0, aborted: 0, assistantCalls: 4 },
      ]
      input.statusSeries = input.statuses.map((status) => ({
        // 同时驱动趋势图与结果列表，单纯恢复状态静态排名无法覆盖这条测试。
        ...input.statusSeries[0],
        ...status,
        points: input.daily.map((day) => ({ ...day, requests: status.requests / input.daily.length })),
      }))
      for (const groups of [input.models, input.providers, input.sources, input.agents, input.projects])
        Object.assign(groups[0], { requests: 100, errors: 10, aborted: 5 })
      const output = renderBreakdown(input, { color: "never", by: "status" })
      const colored = renderBreakdown(input, { color: "always", by: "status" })
      expect(output).toContain("opencode stats · Breakdown / Status")
      expect(output).toContain("Request outcomes · 100 total · 80 completed · 12 error · 7 aborted · 1 running")
      expect(output).toContain("Request outcome trend")
      const distribution = output.slice(output.indexOf("Outcome distribution"), output.indexOf("Status efficiency"))
      for (const text of [
        "completed",
        "error",
        "aborted",
        "running",
        "tokens",
        "$127",
        "avg",
        "Unattributed usage",
        "no owning request outcome",
      ])
        expect(distribution).toContain(text)
      const efficiency = output.slice(
        // 同一个状态需在分布、效率表和趋势中使用一致语义，不随当前数值排序换色。
        output.indexOf("Status efficiency"),
        output.indexOf("Failure leaders within each dimension"),
      )
      for (const metric of ["req share", "tokens/req", "cost/req", "calls/req", "cache", "output", "sessions"])
        expect(efficiency).toContain(metric)
      const coloredEfficiency = colored.slice(
        colored.indexOf("Status efficiency"),
        colored.indexOf("Failure leaders within each dimension"),
      )
      // Outcome 必须使用语义色，不能套用任意实体的序号色。
      for (const [ansi, status] of [
        [92, "completed"],
        [91, "error"],
        [93, "aborted"],
        [94, "running"],
      ] as const)
        expect(coloredEfficiency).toContain(`\x1b[${ansi}m${status}`)
      expect(stripAnsi(colored)).toBe(output)
      const leaders = output.slice(output.indexOf("Failure leaders within each dimension"))
      // 每一维都是对同一失败集合的独立查询；表头必须区分维内比率与所有失败份额。
      for (const text of [
        "model",
        "provider",
        "source",
        "agent",
        "project",
        "failed req",
        "rate in leader",
        "share of all failures",
        "Outcome ratios exclude unattributed usage",
        "Errors and aborted requests remain separate outcomes",
      ])
        expect(leaders).toContain(text)
    })
  })
})

describe("stats timeline and insights", () => {
  test("keeps colored timeline driver sparklines as ANSI instead of visible SGR text", () => {
    // 标签是不可信存储文本，sparkline 是 renderer 生成的样式，两者必须经过不同清洗边界。
    // 同时要求真实前景色存在，避免“把所有 ANSI 都删掉”也通过泄漏检查。
    // 可信图形样式不能走实体清洗路径，否则 ESC 被删后参数会直接显示在正文。
    withColumns(120, () => {
      const output = renderTimeline(report(), { color: "always" })
      const plain = stripAnsi(output)
      expect(output).toContain("\x1b[94m")
      for (const heading of ["Entity trends", "Models", "Providers"]) expect(plain).toContain(heading)
      expect(plain).not.toContain("Model trends")
      expect(plain).not.toMatch(/\[(?:\d+;)*\d+m/)
    })
  })

  test("keeps minor token components visible when cache dominates the timeline", () => {
    // 各天乘数不同，低占比组件仍有可辨曲线，不能用一条水平零线冒充“组件存在”。
    // 总量和峰值是独立手算常量，而非调用目标缩放函数反算预期形状。
    // 99% Cache Read 不能量化掉小组件；量级由 total/share/peak 给出，不比较独立 spark 的高度。
    withColumns(120, () => {
      const input = report()
      const multipliers = [1, 2, 1, 3, 2, 4]
      input.daily = input.daily.map((item, index) => ({
        ...item,
        tokens: {
          input: 70 * multipliers[index],
          output: 20 * multipliers[index],
          reasoning: 0,
          cache: { read: 9900 * multipliers[index], write: 10 * multipliers[index] },
          total: 10_000 * multipliers[index],
        },
      }))
      input.total.tokens = {
        // 完整 130K 分母与四类分量闭合，小组件不得被当作 rounding error 合并进 Cache。
        input: 910,
        output: 260,
        reasoning: 0,
        cache: { read: 128_700, write: 130 },
        total: 130_000,
      }
      input.tokenPartSeries = input.tokenPartSeries.map((part) => ({
        ...part,
        points: input.daily.map((item) => ({
          day: item.day,
          label: item.label,
          value:
            part.id === "input"
              ? item.tokens.input
              : part.id === "output"
                ? item.tokens.output
                : part.id === "cacheRead"
                  ? item.tokens.cache.read
                  : item.tokens.cache.write,
        })),
        total: part.id === "input" ? 910 : part.id === "output" ? 260 : part.id === "cacheRead" ? 128_700 : 130,
      }))
      const timeline = renderTimeline(input, { color: "never" })
      for (const text of [
        "━━━ Daily token volume",
        "total 130.0K · peak 40.0K/day · avg 21.7K/day",
        "each trend independently normalized",
        "Cache Read 128.7K 99.0% · peak 39.6K/day",
        "Input 910 0.7% · peak 280/day",
        "Cache Write 130 0.1% · peak 40/day",
        "Output + Reasoning 260 0.2% · peak 80/day",
        "━━━ Health and efficiency",
        "Top active days",
      ])
        expect(timeline).toContain(text)
      expect(timeline.split("\n").length).toBeLessThanOrEqual(64)
      // 信息恢复不能通过把同一份 daily 重复打印成多个旧页来堆积文本行数。
      const sessions = renderSessions(report(), { color: "never" })
      // Sessions 关注总体、分布和单个会话；旧的 Top tools 不应被一起塞回此页面。
      for (const text of [
        "━━━ Session population",
        "p90",
        "p99",
        "━━━ Session size distribution · tokens",
        "━━━ Session cost distribution · positive recorded cost",
        "━━━ Session leaderboard · sorted by tokens · bar = token share",
        "models",
        "providers",
      ])
        expect(sessions).toContain(text)
      expect(sessions).not.toContain("Top tools")
      const lines = sessions.split("\n").map(stripAnsi)
      const distribution = lines.findIndex((line) => line.includes("Session size distribution"))
      // 必须存在分布条与每个 Session 的占比条，不以章节名代替图形正向断言。
      const leaderboard = lines.findIndex((line) => line.includes("Session leaderboard"))
      expect(
        lines.slice(distribution + 1, leaderboard).filter((line) => line.includes("█") || line.includes("░")).length,
      ).toBeGreaterThanOrEqual(5)
      expect(
        lines.slice(leaderboard + 1).filter((line) => line.includes("token share") && line.includes("█")).length,
      ).toBe(report().sessions.length)
      expect(sessions.split("\n").length).toBeLessThanOrEqual(64)
    })
  })

  test("gives Cost Timeline its own health, ranking, drivers, and peak-date semantics", () => {
    // 费用峰值的日期与日均值需来自同一选择窗口，不能复用 Token 排行的主量纲。
    // 固定源夹具跨月，05-02 的 peak 文案能检测改用本地化 label 或系统当前日期。
    withColumns(140, () => {
      const output = renderTimeline(report(), { color: "never", metric: "cost" })
      for (const text of [
        "opencode stats · Timeline / Cost",
        "━━━ Daily cost",
        "total $127 · avg $21.1/day · peak $50.0 on 05-02 · 6/6 active days",
        "Top cost days",
        "Cost drivers",
      ])
        expect(output).toContain(text)
      // Cost 主图已承担费用趋势，health 不能再重复相同一条数据。
      const health = output.slice(output.indexOf("Health and efficiency"), output.indexOf("Top cost days"))
      for (const metric of ["Tokens", "Requests", "Cache read", "Failures", "Latency"]) expect(health).toContain(metric)
      expect(health).not.toContain("Daily cost")
      // 主量纲切到 Cost 后，其余健康维度仍须保留，而非简单复用 Token 页整段拼接。
      expect(output).not.toContain("Entity trends")
    })
  })

  test("renders Timeline heatmap zero cells and all peak-relative legend bands", () => {
    // 把一个真实日点设零以区别无数据；其余日点保留正数，使相对 peak 图例仍有意义。
    withColumns(140, () => {
      const input = report()
      input.daily[0] = { ...input.daily[0], tokens: tokens(0) }
      const output = renderTimeline(input, { color: "never", heatmap: true })
      // 零单元和四档 peak 相对区间必须一起可读，不把空格误作无数据。
      for (const legend of [
        "━━━ Token heatmap · calendar view",
        "· 0",
        "░ <=25% peak",
        "▒ <=50% peak",
        "▓ <=75% peak",
        "█ >75% peak",
        "peak 920.0M",
      ])
        expect(output).toContain(legend)
      const cost = renderTimeline(input, { color: "never", metric: "cost", heatmap: true })
      // 同一热图图元切换量纲后必须使用金额单位，不能只改标题而保留 Token formatter。
      expect(cost).toContain("━━━ Cost heatmap · calendar view")
      expect(cost).toContain("peak $50")
      expect(cost).not.toContain("peak 50.0M")
      // 同一个数字被错误 formatter 缩成 Token 单位也属于功能退化，不是主题差异。
    })
  })

  test("renders insights as quantitative evidence instead of prose cards", () => {
    // 旧叙事卡片可以只写文字而没有定量结构，必须明确排除其代表文案。
    // 章节呼吸行与信息密度共同约束，Forecast 只能由显式选项追加。
    withColumns(120, () => {
      const output = renderInsights(report(), { color: "never" })
      for (const text of ["Usage shape", "Attribution", "Daily cost", "Session cost", "Actions"])
        expect(output).toContain(text)
      expect(output).not.toContain("Daily cost increased from")
      expect(output).not.toContain("Run-rate forecast")
      const lines = output.split("\n")
      for (const heading of ["Usage shape", "Attribution", "Variability & outliers", "Actions"])
        expect(lines[lines.findIndex((line) => line.includes(`━━━ ${heading}`)) + 1]?.trim()).toBe("")
      expect(lines.length).toBeLessThanOrEqual(64)
      // 章节后留白与完整定量信息同时约束，避免只加大间距制造“更丰富”的空白页。
      const forecast = renderInsights(report(), { color: "never", forecast: true })
      // 预测是显式附录；默认 Insights 的存在不能依赖费用预测是否有样本。
      expect(forecast).toContain("Forecast")
      const forecastLines = forecast.split("\n")
      expect(
        forecastLines[
          forecastLines.findIndex((line) => line.includes("━━━ Forecast · observed activity run rate")) + 1
        ]?.trim(),
      ).toBe("")
      expect(forecastLines.length).toBeLessThanOrEqual(64)
    })
  })

  test("keeps the complete Insights denominators and excludes unavailable ownership", () => {
    // 无 owner 的 usage 刻意比真实状态用量更大，若误纳入 leader 选择就必然改变结果。
    withColumns(140, () => {
      const input = report()
      // 未归属 Token 故意大于真实 outcome；它不能成为 Status leader 或改变请求分母。
      const unattributed = {
        ...structuredClone(input.statuses[0]),
        id: "unattributed",
        label: "unattributed",
        tokens: tokens(100_000_000),
      }
      input.statuses[0].tokens = tokens(1_000_000)
      input.statuses.push(unattributed)
      input.sessions.push({ ...structuredClone(input.sessions[1]), id: SessionID.make("ses_unpriced"), cost: 0 })
      // 加入零费用会话，只能影响 Token 人口，不得把正费用 p50 拉成更低值。
      const output = renderInsights(input, { color: "never" })
      const normalized = output.replace(/\s+/g, " ")
      // 本条字段断言可跨换行；整页 oracle 仍逐字保留所有空格，不能用它代替排版验收。
      for (const part of [
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
      ])
        expect(normalized).toContain(part)
      for (const text of [
        "token share",
        // 准确的 mean/median 和 top-2 比例同时约束长尾量纲，不能用一句“高集中度”替代。
        "recent cost change",
        "owner fail",
        "Status leader excludes unattributed usage; 460.0M tokens without request outcome are reported separately.",
        "Session cost p50 $30.0",
        "Session tokens mean 388.7M · median 20.0M · mean/median 19.4x · top 2 share 17.8%",
      ])
        expect(output).toContain(text)
      expect(normalized).toContain("status │ completed")
      // 大额 unattributed 已存在却不能成为 status leader，直接观察实际 leader 身份。
    })
  })

  test("guards Insights actions when Token denominators are unavailable", () => {
    // 有工具而无 Assistant Token 是真实部分报告；未知缓存率不是缓存命中率为零。
    // 本测试拒绝假 Action，但不要求删除工具事实或把整页转换成异常返回。
    withColumns(120, () => {
      const input = emptyReport()
      // 只有 ToolPart 是合法部分数据，但没有 Assistant Token 分母可供计算 cache share。
      input.toolUsage = [{ id: "read", count: 1, inputChars: 10, outputChars: 20, contextTokens: 5 }]
      expect(renderInsights(input, { color: "never" })).not.toContain("Cache read 0.0% < 20%")
    })
  })

  test("renders Forecast drivers by cost with an explicit projection method", () => {
    // 同时改变 series 总额和日点，确保 driver 的费用排序与其趋势来自同一输入。
    withColumns(140, () => {
      const input = report()
      // 用相反 Token/Cost 顺序证明 driver 按费用选取，而不是复用输入排名。
      input.providerSeries[0].cost = 1
      input.providerSeries[0].points.forEach((point) => {
        point.cost = 1
      })
      input.providerSeries[1].cost = 100
      input.providerSeries[1].points.forEach((point) => {
        point.cost = 10
      })
      const output = renderInsights(input, { color: "never", forecast: true })
      const drivers = output.slice(output.indexOf("Forecast drivers"))
      // 30-day、自然月末和置信带是三个不同指标，不能只保留一个“月费用”数字。
      for (const text of [
        "30-day $634",
        "projected month-end",
        "endpoint confidence band",
        "Projection uses only the selected window and observed active-day frequency; month-end uses the latest date's local month.",
      ])
        expect(output).toContain(text)
      expect(drivers.indexOf("本地提供商")).toBeLessThan(drivers.indexOf("DaXiao Codex"))
      // 两个 Provider 的原数组顺序相反，才可排除原样遍历输入数组的伪排序。
    })
  })
})

describe("stats availability and complete identities", () => {
  test("preserves complete labels in analytical views", () => {
    // 两条短模型外再加第三个身份，能抓到只保留前两个名称而不出现省略号的静默丢失。
    // 长模型、Provider、Session 和第三个模型都是定位信息，不得被静默 clip。
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
      // 使用独立第三个字符串而非重复前两项，名称去重不会让丢失第三项的实现碰巧通过。
      expect(renderBreakdown(input, { color: "never", by: "model" })).toContain(model)
      expect(renderBreakdown(input, { color: "never", by: "provider" })).toContain(provider)
      expect(renderSessions(input, { color: "never" })).toContain(session)
      const dashboard = renderDashboard(input, { color: "never" })
      // Dashboard 与详细页各自经过不同组合路径，两处均须保留完整身份。
      for (const text of [model, provider, "complete-third-session-model"]) expect(dashboard).toContain(text)
    })
  })

  test("labels an explicitly unbounded report as all time", () => {
    // requestedDays 与实际 earliest/latest 是不同输入，历史跨度再短也不应显示成 today。
    // undefined 是用户选择全历史的意图，不能被系统当前日期推断成其他窗口。
    withColumns(120, () => {
      const input = report()
      input.requestedDays = undefined
      expect(renderDashboard(input, { color: "never" })).toContain("All time")
      // 不拿报告实际跨度推断意图，默认窗口与显式全历史才能保持各自稳定文案。
    })
  })

  test("weights forecast run rates by observed active-day frequency", () => {
    // 三个零日是观测到的低频率，而非缺测值；不能在计算 calendar run-rate 前过滤掉。
    // 40 美元只发生于四天之一，日历日均是 10，不能把活跃日均直接外推。
    const input = report()
    input.daily = input.daily
      .slice(0, 4)
      .map((item, index) => ({ ...item, day: new Date(2026, 3, index + 1).getTime(), cost: index === 0 ? 40 : 0 }))
    input.dateRange = { earliest: input.daily[0].day, latest: input.daily.at(-1)?.day ?? input.daily[0].day }
    const forecast = buildForecast(input)
    expect(forecast.dailyAverage).toBe(40)
    expect(forecast.activityRate).toBe(0.25)
    expect(forecast.weeklyRunRate).toBe(70)
    // 稀疏使用仍有不确定性，不能因为只有一个正费用样本就生成零宽置信区间。
    expect(forecast.confidence).toBeLessThan(1)
    expect(forecast.points.at(-1)?.upper).toBeGreaterThan(forecast.projectedMonthEnd)
  })

  test("renders empty reports without truncation or exceptions", () => {
    // 空态仍保留宽度和 Header 事实；“不抛错”不足以证明源版空窗口体验已恢复。
    // 新安装与严格筛选都可为空，必须 header 后短路，不绘制一组伪观测零图。
    for (const columns of [40, 120])
      withColumns(columns, () => {
        const input = emptyReport()
        const outputs = [
          renderDashboard(input, { color: "never" }),
          ...dimensions.map((by) => renderBreakdown(input, { color: "never", by })),
          renderTimeline(input, { color: "never" }),
          renderSessions(input, { color: "never" }),
          renderInsights(input, { color: "never" }),
          renderInsights(input, { color: "never", forecast: true }),
        ]
        for (const output of outputs) {
          expect(output).not.toContain("…")
          expect(output.split("\n").every((line) => visibleLength(line) === columns - 2)).toBe(true)
          expect(output).toContain("No usage data for the selected")
        }
      })
    withColumns(120, () => {
      const input = emptyReport()
      input.totalTools = 1
      // 真实 ToolPart 没有 context breakdown 时，工具足迹仍应展示，不能沿完全空态短路。
      input.toolUsage = [{ id: "read", count: 1, inputChars: 12, outputChars: 20, contextTokens: 0 }]
      input.toolCalls = [
        {
          toolID: "read",
          modelID: "test",
          providerID: "test",
          agent: "build",
          projectID: "project",
          source: "legacy-message",
          status: "completed",
          calls: 1,
          inputChars: 12,
          outputChars: 20,
          errors: 0,
          durationMs: 10,
        },
      ]
      expect(renderBreakdown(input, { color: "never", by: "tool" })).toContain("Tool footprint")
      // 只在完全空态测试 not.toThrow 会遗漏这类部分报告，故另加实际工具足迹正向断言。
    })
  })

  test("renders missing cost as unavailable without hiding token usage", () => {
    // 无正费用可能代表价格未知而非免费，不能让成本效率、费用分布或预测输出精确零。
    withColumns(120, () => {
      const input = report()
      // 全部费用投影一致清零，防止残余正费用让测试错过无费用分支。
      input.total.cost = 0
      input.daily.forEach((item) => {
        item.cost = 0
      })
      for (const groups of [input.models, input.providers, input.agents, input.sources, input.statuses, input.projects])
        groups.forEach((item) => {
          item.cost = 0
        })
      for (const series of [
        input.modelSeries,
        input.providerSeries,
        input.agentSeries,
        input.sourceSeries,
        input.statusSeries,
        input.projectSeries,
      ])
        series.forEach((item) => {
          item.cost = 0
          item.points.forEach((point) => {
            point.cost = 0
          })
        })
      input.sessions.forEach((session) => {
        session.cost = 0
      })
      expect(renderDashboard(input, { color: "never" })).toContain("No positive cost recorded in this range")
      const timeline = renderTimeline(input, { color: "never", metric: "cost" })
      expect(timeline).toContain("No positive cost recorded in this range.")
      expect(timeline).toContain("Health and efficiency")
      const providers = renderBreakdown(input, { color: "never", by: "provider" })
      // Provider 仍有 Token 可比较，费用不可用只改变默认主指标，不移除该维度页面。
      expect(providers).toContain("sorted by tokens")
      expect(providers).not.toContain("$0.0000")
      expect(renderProviders(input, { color: "never" })).toBe(providers)
      const sessions = renderSessions(input, { color: "never" })
      expect(sessions).toContain("Cost distribution unavailable")
      expect(sessions).not.toContain("<$0.10")
      // 全零费用不应落入“便宜”的档位，空的费用分布要与 Token 分布保留明确区别。
      const insights = renderInsights(input, { color: "never", forecast: true })
      // 显式要求 Forecast 时应解释不可用，而非悄悄隐藏用户请求的整个附录。
      expect(insights).toContain("cost/M — · tok/$ —")
      expect(insights).toContain("Forecast unavailable: no positive cost recorded in the selected range.")
    })
  })

  test("separates sessions with no positive recorded cost from measured cost bands", () => {
    // 两个会话但只有一个正费用样本，可以区分 population 与 billed-cost distribution 的分母。
    withColumns(120, () => {
      const input = report()
      input.sessions[0].cost = 1
      input.sessions[1].cost = 0
      // 样本数与未记录数并列，费用分布的分母才能被用户核对。
      const output = renderSessions(input, { color: "never" })
      expect(output).toContain("Session cost distribution · positive recorded cost (1 sessions)")
      expect(output).toContain("No positive recorded cost · 1 sessions")
    })
  })

  test("uses responsive default limits while preserving explicit limits and canonical wrappers", () => {
    // 输入项数超过窄屏与宽屏两个默认限额，避免小样本让错误默认值碰巧输出同样内容。
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
      const automatic = renderBreakdown(input, { color: "never", by: "model" })
      expect(automatic).toContain("model-3")
      expect(automatic).not.toContain("model-4")
      // 显式 limit 是用户意图，不能被窄屏默认策略截回三项。
      expect(renderBreakdown(input, { color: "never", by: "model", limit: 6 })).toContain("model-6")
      const sessions = renderSessions(input, { color: "never" })
      expect(sessions).toContain("responsive-session-3")
      expect(sessions).not.toContain("responsive-session-4")
    })
    withColumns(120, () => {
      const breakdown = renderBreakdown(input, { color: "never", by: "model" })
      // 默认五项与显式八项分别验证；wrapper 不能在转发时额外补一个不同的 limit。
      expect(breakdown).toContain("model-5")
      expect(breakdown).not.toContain("model-6")
      expect(renderBreakdown(input, { color: "never", by: "model", limit: 8 })).toContain("model-8")
      const sessions = renderSessions(input, { color: "never" })
      expect(sessions).toContain("responsive-session-5")
      expect(sessions).not.toContain("responsive-session-6")
      expect(renderSessions(input, { color: "never", limit: 8 })).toContain("responsive-session-8")
      // 分别观察两个端点的显式限额，不能由 Breakdown 的通过代替 Sessions 的验收。
      const dashboard = renderDashboard(input, { color: "never" })
      expect(dashboard).toContain("model-5")
      expect(dashboard).not.toContain("model-6")
      expect(renderModels(input, { color: "never" })).toBe(renderBreakdown(input, { color: "never", by: "model" }))
      expect(renderProviders(input, { color: "never" })).toBe(
        renderBreakdown(input, { color: "never", by: "provider" }),
      )
    })
  })

  test("renders every breakdown page without ellipses", () => {
    // 各维度专属表格仍经过同一个 panel 宽度边界，不能二次截断标签。
    for (const columns of [40, 80, 120, 160])
      withColumns(columns, () => {
        for (const by of dimensions) {
          const output = renderBreakdown(report(), { color: "never", by })
          // 校验所有物理行，而不是只看最长一行；短行漏 padding 也会破坏多区块对齐。
          expect(output).not.toContain("…")
          expect(output.split("\n").every((line) => visibleLength(line) === columns - 2)).toBe(true)
        }
      })
  })

  test("renders every detailed stats page without ellipses", () => {
    // 每个端点都经过自己的布局组合，不能只证明 Dashboard 不裁切就推断其余页面正确。
    // 此处锁定公共宽度边界；具体章节和数字另由上方正向断言与固定整页 oracle 共同保护。
    for (const columns of [40, 80, 120, 160])
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
  })
})

describe("stats terminal color contracts", () => {
  test("never emits terminal background ANSI in color output", () => {
    // 逐行默认背景复位允许终端保持用户主题，不能为恢复深色面板重新设置具体背景色。
    // 默认背景复位保护上游残留状态，禁止的始终是具体背景色而非 49m。
    withColumns(140, () => {
      for (const output of [
        renderDashboard(report(), { color: "always" }),
        renderBreakdown(report(), { color: "always", by: "tool" }),
        renderSessions(report(), { color: "always" }),
        renderTimeline(report(), { color: "always" }),
        renderInsights(report(), { color: "always" }),
      ]) {
        expect(output).not.toContain("\x1b[38;2;")
        expect(concreteBackgroundAnsi(output)).toEqual([])
        expect(output.split("\n").every((line) => line.startsWith("\x1b[49m") && line.endsWith("\x1b[49m"))).toBe(true)
      }
      for (const output of [
        renderDashboard(report(), { color: "never" }),
        renderInsights(report(), { color: "never" }),
      ])
        expect(output).not.toContain("\x1b[49m")
    })
  })

  test("treats persisted entity identities as plain terminal text", () => {
    // 这些名字可从历史数据进入页面，不经过命令枚举校验，因此清洗责任属于终端图元边界。
    // 同时覆盖 CSI、OSC 和 C1 形式，防止只删除 ESC 字节后把协议参数露到正文。
    withColumns(140, () => {
      const input = report()
      input.models[0].label = "model\u001b[41m\nforged"
      input.modelSeries[0].label = input.models[0].label
      input.providers[0].label = "provider\u001b]8;;https://malicious.invalid\u0007forged\u001b]8;;\u0007"
      input.providerSeries[0].label = input.providers[0].label
      input.sessions[0].title = "session\nforged"
      input.sessions[0].models = ["model\u001b[41m"]
      // 未终止 OSC 不能把 URL 留给终端执行，也不能泄漏协议参数到可见正文。
      input.sessions[0].providers = ["provider\u001b]8;;https://unterminated.invalid"]
      input.toolUsage[0].id = "tool\u009b31mforged"
      input.toolCalls[0].toolID = input.toolUsage[0].id
      // 显示与关联使用同一恶意工具 ID，清洗不能通过让调用记录失联后消失来伪装安全。
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
      // 去掉 renderer 的合法 SGR 后，恶意链接与控制参数也不能成为可见身份的一部分。
      for (const fragment of ["[41m", "[31m", "]8;;", "malicious.invalid", "unterminated.invalid"])
        expect(plain).not.toContain(fragment)
      for (const name of ["model forged", "provider forged", "tool forged", "session forged"])
        expect(plain).toContain(name)
    })
  })

  test("keeps breakdown analytical rows within the terminal width", () => {
    // 使用固定 140 列宽观察真实行，不能在测试阶段裁剪、trim 或补空格制造对齐。
    // Tool 与 Source 的列数不同，固定行宽必须由共享布局自然满足，不能截断后伪装。
    withColumns(140, () => {
      const tool = renderBreakdown(report(), { color: "never", by: "tool" })
      expect(tool).toContain("Estimated context trend")
      for (const output of [tool, renderBreakdown(report(), { color: "never", by: "source" })]) {
        expect(new Set(output.split("\n").map(visibleLength))).toEqual(new Set([138]))
        expect(output).not.toContain("ctx tok ·")
        expect(output).not.toContain("…")
      }
    })
  })

  test("does not let grid dim state leak into series glyphs", () => {
    // 复位缺陷只影响有色数据线的强度，stripAnsi 后布局相同并不能发现它。
    // 从公开 SGR 输出重建终端 intensity，前景色本身不会清除 dim；网格之后的数据线必须复位。
    const chart = renderRoundedLineChart({
      title: "dim leak probe",
      // 多次上下折返让数据路径穿越网格，单调水平线不足以覆盖样式切换缺陷。
      series: [
        {
          id: "a",
          label: "a",
          color: "blue",
          points: [
            { x: 0, y: 0 },
            { x: 1, y: 8 },
            { x: 2, y: 2 },
            { x: 3, y: 6 },
          ],
        },
      ],
      color: "always",
      width: 30,
      height: 6,
      points: false,
      legend: false,
    })
    const dimLines: string[] = []
    // 仅解释公开终端控制协议，不访问 ChartCanvas 私有格子或检查内部绘制顺序。
    for (const line of chart.slice(1, -1)) {
      let dim = false
      for (const token of line.match(/\x1b\[[0-9;]*m|[\s\S]/g) ?? []) {
        if (token.startsWith("\x1b[")) {
          for (const value of token.slice(2, -1).split(";").map(Number)) {
            if (value === 0 || value === 22) dim = false
            if (value === 2) dim = true
          }
          continue
        }
        if (dim && /[│─└╭╮╰╯├┤┬┴┼●◆■▲◇○✕+]/.test(token)) dimLines.push(token)
      }
    }
    expect(dimLines).toEqual([])
  })

  test("emits the exact R6 semantic ANSI role contract", () => {
    // bright ANSI 槽位由宿主主题决定实际颜色；固定 RGB 即使在当前主题好看也违反契约。
    const ctx = renderContext("always")
    for (const [role, code] of [
      ["title", 95],
      ["subtitle", 96],
      ["blue", 94],
      ["cyan", 96],
      ["green", 92],
      ["yellow", 93],
      ["orange", 33],
      ["purple", 95],
      ["pink", 35],
      ["red", 91],
      ["axis", 39],
      ["white", 39],
    ] as const) {
      const output = paint("x", role, ctx)
      expect(output).toContain(`\x1b[${code}m`)
      expect(output).not.toMatch(/\x1b\[2(?:;|m)/)
      // 非参照层不应携带 dim，不能只证明 bright 前景码出现后就忽略残留 intensity。
    }
    expect(paint("x", "muted", ctx)).toContain("\x1b[2;39m")
    // dim 只属于非数据参照层，普通系列不能因为与 muted 共用样式而失去对比度。
    expect(paint("x", "grid", ctx)).toContain("\x1b[2;39m")
  })

  test("keeps colored empty reports safe under the R6 foreground and background contract", () => {
    // 全空页面也必须遵守颜色/背景契约，但不能替代上方非空图形的正向颜色断言。
    withColumns(120, () => {
      const input = emptyReport()
      const outputs = [
        renderDashboard(input, { color: "always" }),
        ...dimensions.map((by) => renderBreakdown(input, { color: "always", by })),
        renderTimeline(input, { color: "always" }),
        renderSessions(input, { color: "always" }),
        renderInsights(input, { color: "always" }),
      ]
      for (const output of outputs) {
        expect(output).not.toContain("\x1b[38;2;")
        expect(concreteBackgroundAnsi(output)).toEqual([])
        expect(stripAnsi(output)).not.toContain("\x1b[")
      }
      expect(stripAnsi(renderDashboard(input, { color: "always" }))).toBe(renderDashboard(input, { color: "never" }))
      expect(stripAnsi(renderInsights(input, { color: "always" }))).toBe(renderInsights(input, { color: "never" }))
      // 空态去色等价只约束同一事实的两种呈现，不把它当成有数据图形颜色完整性的替代。
    })
  })

  test("respects color mode precedence with NO_COLOR truthy contract", () => {
    // 空字符串与未设置不同于 truthy NO_COLOR；always 则必须覆盖环境，供强制输出和回归使用。
    const originalTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY")
    const originalNoColor = process.env.NO_COLOR
    try {
      for (const tty of [false, true])
        for (const noColor of [undefined, "", "1"]) {
          Object.defineProperty(process.stdout, "isTTY", { value: tty, configurable: true })
          if (noColor === undefined) delete process.env.NO_COLOR
          else process.env.NO_COLOR = noColor
          for (const mode of ["auto", "always", "never"] as const) {
            const enabled = mode === "always" || (mode === "auto" && tty && !noColor)
            expect(useColor(mode)).toBe(enabled)
            // 必须观察实际页面发射，不能仅证明公开 mode 查询正确却放过内部片段漏色。
            const input = report()
            for (const output of [
              renderDashboard(input, { color: mode }),
              ...dimensions.map((by) => renderBreakdown(input, { color: mode, by })),
              renderTimeline(input, { color: mode }),
              renderSessions(input, { color: mode }),
              renderInsights(input, { color: mode }),
              renderInsights(input, { color: mode, forecast: true }),
            ])
              expect(output.includes("\x1b[")).toBe(enabled)
          }
        }
    } finally {
      if (originalTTY) Object.defineProperty(process.stdout, "isTTY", originalTTY)
      // 原属性不存在时必须删除，不能留下一个值相同但性质不同的宿主属性。
      else Reflect.deleteProperty(process.stdout, "isTTY")
      if (originalNoColor === undefined) delete process.env.NO_COLOR
      else process.env.NO_COLOR = originalNoColor
    }
  })
})

describe("stats render width", () => {
  test("counts CJK text by terminal display columns", () => {
    // 低层摘要 primitive 仍可截短；最终页面不使用它们，二者不能混淆成同一裁剪契约。
    // 中英文混排验证终端列而非 UTF-16 长度，后续面板宽度才有可靠前提。
    expect(visibleLength("中文abc")).toBe(7)
    expect(visibleLength(fitVisible("中文", 6))).toBe(6)
    expect(visibleLength(truncateVisible("中文abc", 5))).toBe(5)
  })

  test("keeps CJK-heavy dashboard and session output fixed-width", () => {
    // 在同一页面上同时出现中文标题与 ANSI，能抓到用字符串 length 代替显示列的错误。
    // 标题来自用户数据，彩色模式下 ANSI 字节也不能挤占中文的显示列。
    for (const columns of [80, 120])
      withColumns(columns, () => {
        for (const output of [
          renderDashboard(report(), { color: "always" }),
          renderSessions(report(), { color: "always" }),
        ]) {
          expect(new Set(output.split("\n").map(visibleLength))).toEqual(new Set([columns - 2]))
        }
      })
  })

  test("renders dashboard as the new responsive sectioned overview", () => {
    // 主图应独占超过百列的 plot；逐点字符列表即使包含相同数字，也不满足二维布局。
    // 验证完整区块及顺序；只有有色标题或逐点文本无法通过全宽主图的断言。
    withColumns(120, () => {
      const output = renderDashboard(report(), { color: "never" })
      expect(output).toContain("━━━ Daily activity")
      expect(output).toContain("Daily token volume")
      const lines = output.split("\n")
      const mainTitle = lines.findIndex((line) => stripAnsi(line).includes("Daily token volume"))
      const mainAxis = lines.slice(mainTitle + 1).find((line) => stripAnsi(line).includes("┄"))
      expect(visibleLength(stripAnsi(mainAxis ?? "").trimEnd())).toBeGreaterThan(100)
      for (const text of [
        "Calendar · cell intensity = daily tokens",
        "legend  · =0",
        "Token components",
        "Each panel auto-normalizes",
        "Cost & health trends",
        "Top models · by token volume",
        "Top providers · share of total tokens",
        "━━━ Sessions",
        "━━━ Insights",
      ])
        expect(output).toContain(text)
      expect(output).toMatch(/M\s+T\s+W\s+T\s+F\s+S\s+S/)
      expect(output.indexOf("Abort & error rate")).toBeLessThan(output.indexOf("Cache hit rate (%)"))
      // 中屏先并排 Cost/Failure，再展开 Cache；宽屏顺序另测，不能统一成一个固定三列壳。
      for (const retired of [
        "Error rate (errors per 100 req)",
        "Cumulative spend",
        "Why small multiples",
        "Model mix over time",
      ])
        expect(output).not.toContain(retired)
      expect(new Set(lines.map(visibleLength))).toEqual(new Set([118]))
    })
  })

  test("renders dashboard token components as auto-normalized small multiples", () => {
    // 160 列触发真正三列健康区，与上一条中屏布局形成源断点两侧的行为约束。
    // 四组件的独立尺度保证低占比输出可见，并禁止旧堆叠/粗 marker 再次遮挡趋势。
    withColumns(160, () => {
      const output = renderDashboard(report(), { color: "never" })
      for (const part of ["Cache Read", "Input", "Cache Write", "Output", "per-call"]) expect(output).toContain(part)
      expect(output.indexOf("Cache hit rate (%)")).toBeLessThan(output.indexOf("Abort & error rate"))
      for (const retired of ["■ Cache Read · ■ Input · ■ Cache Write · ■ Output", "● cost", "● cache", "● errors"])
        expect(output).not.toContain(retired)
      expect(
        output
          .split("\n")
          .some((line) => ["▓ Cache Read", "░ Input", "▒ Cache Write", "▎ Output"].includes(line.trim())),
      ).toBe(false)
      expect(new Set(output.split("\n").map(visibleLength))).toEqual(new Set([158]))
    })
  })

  test("does not truncate dashboard rows with ellipses", () => {
    // 四种宽度同时覆盖极窄、堆叠、中屏与宽屏，禁止只在某一个桌面尺寸保留全名。
    // 物理宽度不足只能增加行数，不能静默丢失实体身份和数值。
    for (const columns of [40, 80, 120, 160])
      withColumns(columns, () => expect(renderDashboard(report(), { color: "never" })).not.toContain("…"))
  })

  test("keeps chart grids and stable date labels", () => {
    // 输入有意保留中文 label，真实日期仍须由 timestamp 产生，才能兼容不同终端语言。
    // 日期来自本地自然日 timestamp，聚合中本地化 label 不应泄漏到坐标轴。
    withColumns(160, () => {
      const output = renderDashboard(report(), { color: "never" })
      expect(output).toContain("┄")
      expect(output).toContain("04-27")
      // 固定 timestamp 与故意不一致的中文 label 联合存在，能识别数据缓存标签被误复用。
      expect(output).not.toContain("5月")
      expect(output).not.toContain("$0.000")
    })
  })

  test("keeps calendar cells adaptive and hour strip uncompressed", () => {
    // 日历可改每格字符数，但一天和一小时的语义单位不能被重新采样。
    // Calendar 允许改变字符单元宽度，24 个小时则必须保持逐槽无采样。
    withColumns(160, () =>
      expect(calendarRows(renderDashboard(report(), { color: "never" })).join("\n")).toMatch(/[░▒▓█]{2}/),
    )
    withColumns(40, () =>
      expect(calendarRows(renderDashboard(report(), { color: "never" })).join("\n")).not.toMatch(/[░▒▓█]{2}/),
    )
    withColumns(80, () => {
      const lines = renderDashboard(report(), { color: "never" }).split("\n").map(stripAnsi)
      const header = lines.findIndex((line) => line.includes("00  04  08  12  16  20"))
      expect(lines[header + 1].trim()).toHaveLength(24)
      // 小时槽数按协议固定，不能像曲线那样为了宽度自动抽样成更短的 sparkline。
    })
  })

  test("keeps calendar activity aligned across irregular natural-day durations", () => {
    // 不修改生产时区或私有日期 helper，直接用公开 daily 输入表示 23 小时相邻自然日。
    // 23 小时相邻 bucket 模拟 DST；固定 24h 查表会把第三天错误画成空白。
    withColumns(120, () => {
      const input = report()
      const first = new Date(2026, 2, 7).getTime()
      input.daily = input.daily
        .slice(0, 3)
        .map((item, index) => ({ ...item, day: [first, first + day, first + day * 2 - 60 * 60 * 1000][index] }))
      input.dateRange = { earliest: input.daily[0].day, latest: input.daily[2].day }
      expect(calendarRows(renderDashboard(input, { color: "never" })).join("\n")).toMatch(/▒▒.*██[\s\S]*▒▒/)
    })
  })

  test("renders request start hours instead of assigning requests to Session updates", () => {
    // Session 可在请求结束后继续更新，小时图必须尊重聚合层保存的 request-start 投影。
    withColumns(140, () => {
      const input = report()
      // 故意把 Session 更新时间和请求数指向错误时段，只有 RequestUsage 小时投影是权威。
      input.sessions.forEach((session) => {
        session.updated = new Date(2026, 5, 1, 23).getTime()
        session.requests = 10_000
      })
      input.requestsByHour = Array.from({ length: 24 }, (_, hour) => (hour === 4 ? 12 : hour === 6 ? 3 : 0))
      const output = stripAnsi(renderDashboard(input, { color: "never" }))
      expect(output).toContain("Request starts by hour")
      expect(output).toContain("peak  04:00 — 12 req")
      expect(output).toContain("quiet 06:00 — 3 req")
      expect(output).not.toContain("23:00")
      // 二十三点只来自被故意污染的 Session update，是可定位错误来源的负向信号。
    })
  })

  test("keeps calendar monochrome while spacing provider legend columns", () => {
    // Calendar 的单一密度维度不应引入 RGB；Provider 图例依赖稳定的实体留白。
    withColumns(80, () => {
      const lines = renderDashboard(report(), { color: "always" }).split("\n")
      const start = lines.findIndex((line) => stripAnsi(line).includes("Calendar · cell intensity"))
      const end = lines.findIndex((line, index) => index > start && stripAnsi(line).includes("Request starts by hour"))
      // 章节边界必须真实存在，找不到旧标题的 -1 切片会让负向颜色断言无效。
      expect(start).toBeGreaterThanOrEqual(0)
      expect(end).toBeGreaterThan(start)
      expect(lines.slice(start, end).join("\n")).not.toContain("\x1b[38;2")
      const hourEnd = lines.findIndex((line, index) => index > end && stripAnsi(line).includes("Day-of-week"))
      expect(hourEnd).toBeGreaterThan(end)
      // 先验证真实边界再检查颜色，防止空切片天然满足 not.toContain。
      expect(lines.slice(end, hourEnd).join("\n")).not.toContain("\x1b[38;2")
    })
    withColumns(160, () =>
      expect(renderDashboard(report(), { color: "never" })).toMatch(/DaXiao Codex.* {4,}█ 本地提供商/),
    )
  })

  test("uses differentiated session distribution colors", () => {
    // 检查 bucket 行的实际前景码集合，页头或 section 的单个强调色不能替代体量分档颜色。
    // bucket 色区分体量而非好坏；必须验证主体图形存在不同前景，而不只是标题颜色。
    withColumns(160, () => {
      const lines = renderDashboard(report(), { color: "always" }).split("\n")
      const start = lines.findIndex((line) => stripAnsi(line).includes("Session size distribution"))
      const buckets = lines
        .slice(start, start + 8)
        .filter((line) => /<100K|100K-1M|1M-5M|5M-50M|>50M/.test(stripAnsi(line)))
      expect(
        new Set(buckets.flatMap((line) => Array.from(line.matchAll(/\x1b\[(?:3[0-7]|9[0-7])m/g), (match) => match[0])))
          .size,
      ).toBeGreaterThan(1)
    })
  })
})
