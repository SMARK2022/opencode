import { SessionID } from "../../src/session/schema"
import type { InputComponentTotals, StatsReport, TokenTotals, UsageTotals } from "../../src/cli/cmd/stats-data"

export { day, start, tokens, components, contextUsage, addUsage }

const day = 86_400_000
// 跨越四月和五月，能抓到把本地化 label 错当成坐标日期的迁移错误。
const start = new Date(2026, 3, 27).getTime()

// cache read 故意占多数，低占比 Output 曲线只有独立归一化后才能保留形状。
// value 是输入规模而非总 Token，预期 2.3B 因此不能换成日输入之和 507M。
const tokens = (value: number): TokenTotals => ({
  input: value,
  output: value / 2,
  reasoning: 0,
  cache: { read: value * 3, write: value / 10 },
  total: value + value / 2 + value * 3 + value / 10,
})

// 十类占比总和为 1，且 skills/attachments/reasoning 都非零，避免合并小类别仍通过测试。
// 输入来源的 reasoning 与计费输出的 reasoning 不是同一个字段，二者不应互相补值。
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

const usage = (
  // 独立传入请求数和 Assistant 调用数，夹具不能隐含“一请求等于一次调用”。
  value: number,
  cost: number,
  requests: number,
  calls: number,
  errors = 0,
  durationMs = 0,
): UsageTotals => ({
  // 页面测试消费普通报告对象，不依赖目标 aggregateStats 的计算作为自己的 expected。
  tokens: tokens(value),
  components: components(value),
  cost,
  requests,
  assistantCalls: calls,
  errors,
  aborted: 0,
  durationMs,
})

// 工具趋势只编码估算上下文；不凭一次工具记录额外制造 request、费用或 Assistant call。
// 将 output/cache 清零可以抓到把工具估算误画成模型计费 Token 的错误。
const contextUsage = (value: number): UsageTotals => ({
  tokens: { input: value, output: 0, reasoning: 0, cache: { read: 0, write: 0 }, total: value },
  components: components(),
  cost: 0,
  requests: 0,
  assistantCalls: 0,
  errors: 0,
  aborted: 0,
  durationMs: 0,
})

const addUsage = (items: UsageTotals[]): UsageTotals =>
  // 此 helper 只组合手工报告的输入，不用于验证真实数据库聚合，也不生成页面预期输出。
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
        // 独立十类保持同一集合，测试改动某一小类时不会因忽略该字段而错误变绿。
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
      // 请求、调用和失败计数分别相加，不能让 fixture 自己预先抹平 owner 的差异。
      requests: acc.requests + item.requests,
      assistantCalls: acc.assistantCalls + item.assistantCalls,
      errors: acc.errors + item.errors,
      aborted: acc.aborted + item.aborted,
      durationMs: acc.durationMs + item.durationMs,
    }),
    usage(0, 0, 0, 0),
  )

// 此手工夹具只供 renderer 行为测试；真实数据库 oracle 使用 stats-database，不能混作聚合证据。
export const report = (): StatsReport => {
  // 六天包含低谷、峰值和一个错误日，健康趋势不会退化为全常量或单点样例。
  const daily = [20, 80, 12, 160, 35, 200].map((value, index) => ({
    day: start + index * day,
    label: `5月${index + 1}`,
    // label 保留旧夹具原文；timestamp 才是实际日序，不能为了方便把二者修成相同。
    ...usage(value * 1_000_000, value / 4, value, value * 3, index === 1 ? 2 : 0, value * 60_000),
  }))
  const total = addUsage(daily)
  // 模型为 60/40、Provider 为 70/30，可发现两维共用同一排名或分母的错误。
  // 主体仍使用固定源中的组权重，金额、Token 和调用不是从待验收 renderer 反算。
  const group = (id: string, multiplier: number) => ({
    id,
    label: id,
    ...usage(
      total.tokens.input * multiplier,
      total.cost * multiplier,
      Math.round(total.requests * multiplier),
      Math.round(total.assistantCalls * multiplier),
      0,
      total.durationMs * multiplier,
    ),
    sessions: Math.max(1, Math.round(8 * multiplier)),
    // 默认路由留空；细分维度测试按需放入带长尾的真实组合，以独立验证 other 语义。
    providers: [],
    models: [],
  })
  const part = (
    // selector 分离计费 Token 字段，Output 组合在这里明确包含 reasoning。
    id: "input" | "output" | "cacheRead" | "cacheWrite",
    label: string,
    pick: (input: TokenTotals) => number,
  ) => ({
    id,
    label,
    points: daily.map((item) => ({ day: item.day, label: item.label, value: pick(item.tokens) })),
    // total 与 points 对应同一组件；低占比组件也不能在测试输入阶段就被裁掉。
    total: daily.reduce((sum, item) => sum + pick(item.tokens), 0),
  })
  const series = (item: ReturnType<typeof group>) => ({
    // 保留实体 id/label，同时让不同模型有不同量级，才能验证颜色身份贯穿多个区块。
    ...item,
    points: daily.map((point) => ({
      ...point,
      ...usage(
        // 请求日序保持一致而数值可不同，不能用一个复制的曲线冒充所有实体。
        point.tokens.input * (item.id.includes("claude") ? 1 : 0.35),
        point.cost * (item.id.includes("claude") ? 1 : 0.35),
        point.requests,
        point.assistantCalls,
      ),
    })),
  })
  const toolTrend = (id: string, values: number[]) => ({
    // tools 使用 contextUsage 而非普通 usage，避免夹具替生产代码重复计入账单用量。
    id,
    label: id,
    ...addUsage(values.map(contextUsage)),
    points: daily.map((point, index) => ({ day: point.day, label: point.label, ...contextUsage(values[index] ?? 0) })),
  })
  return {
    // 这里保留源渲染夹具的独立总体和会话样本，真正 SQL 闭合由 stats-database 验收。
    // 因此不得拿渲染夹具的加总关系替代真实聚合器的独立数值断言。
    totalSessions: 8,
    sessionsWithUsage: 6,
    totalMessages: 40,
    totalTools: 120,
    days: daily.length,
    requestedDays: 0,
    dateRange: { earliest: start, latest: start + (daily.length - 1) * day },
    total,
    models: [group("claude-opus-4-6", 0.6), group("gpt-5.5", 0.4)],
    // 中文 Provider 与项目名让宽度检查覆盖双列字符，不能只在 ASCII 身份上证明对齐。
    providers: [group("DaXiao Codex", 0.7), group("本地提供商", 0.3)],
    agents: [group("build", 1)],
    sources: [group("prompt", 1)],
    statuses: [group("completed", 1)],
    projects: [{ ...group("本地项目", 1), path: "/tmp/本地项目" }],
    daily,
    // 请求小时来自 request shell；峰值和安静小时独立于 Session 更新时间。
    requestsByHour: Array.from({ length: 24 }, (_, hour) =>
      // 峰值四点与最安静的六点不相邻；小时选择不能被压成“最早/最晚活跃时段”。
      hour === 4 ? 374 : hour === 6 ? 7 : hour === 17 ? 126 : 0,
    ),
    modelSeries: [series(group("claude-opus-4-6", 0.6)), series(group("gpt-5.5", 0.4))],
    // 每个维度有独立 series，缺某条曲线的测试可删除序列而不删除其实体分析行。
    providerSeries: [series(group("DaXiao Codex", 0.7)), series(group("本地提供商", 0.3))],
    agentSeries: [series(group("build", 1))],
    sourceSeries: [series(group("prompt", 1))],
    statusSeries: [series(group("completed", 1))],
    projectSeries: [series(group("本地项目", 1))],
    toolSeries: [
      toolTrend("apply_patch", [80, 100, 90, 180, 150, 200]),
      toolTrend("bash", [20, 40, 30, 100, 110, 300]),
    ],
    tokenPartSeries: [
      // 数据顺序故意不等于最终小图顺序，renderer 必须按固定组件语义选择而非沿数组绘制。
      part("input", "Input", (item) => item.input),
      part("output", "Output + Reasoning", (item) => item.output + item.reasoning),
      part("cacheRead", "Cache Read", (item) => item.cache.read),
      part("cacheWrite", "Cache Write", (item) => item.cache.write),
    ],
    sessions: [
      {
        id: SessionID.make("ses_cjk"),
        // 标题包含 CJK，模型包含两个身份，能同时覆盖换行与不丢模型信息的契约。
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
        // 第二个会话的更新时间不同，按 recency 排序不能误用创建时间。
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
      // global 工具榜与 Session 的 tools 不在同一粒度；展示层不能混用两种计数。
      { id: "apply_patch", count: 70, inputChars: 1200, outputChars: 2400, contextTokens: 800 },
      { id: "bash", count: 50, inputChars: 900, outputChars: 1800, contextTokens: 600 },
    ],
    // 调用归因总数与 ToolUsage 相同，但两个 owner 不同，防止把 Token 份额误作调用份额。
    toolCalls: [
      // 带 issuing model/provider/project 的 tuple 是路由证据，不从 estimated context 推导调用数。
      {
        toolID: "apply_patch",
        modelID: "claude-opus-4-6",
        providerID: "DaXiao Codex",
        agent: "build",
        projectID: "本地项目",
        source: "prompt",
        status: "completed",
        calls: 70,
        inputChars: 1200,
        outputChars: 2400,
        errors: 1,
        durationMs: 700,
        // 明确时长和一次错误，使 Footprint 的 error/avg-call 列不能只输出静态零。
      },
      {
        toolID: "bash",
        modelID: "gpt-5.5",
        providerID: "本地提供商",
        agent: "build",
        projectID: "本地项目",
        source: "prompt",
        status: "completed",
        calls: 50,
        inputChars: 900,
        outputChars: 1800,
        errors: 2,
        durationMs: 2500,
      },
    ],
    tokensPerSession: total.tokens.total / 6,
    // 总体均值来自 usage population，不是这份展示样本的两个会话；防止页面层重新聚合改分母。
    medianTokensPerSession: 20_000_000,
  }
}

export const emptyReport = () => {
  // 沿用同一完整接口再清零，可发现公开页面对缺字段的依赖，不用 unchecked cast 假装空报告。
  const input = report()
  input.totalSessions = 0
  input.sessionsWithUsage = 0
  input.totalMessages = 0
  input.totalTools = 0
  input.total = usage(0, 0, 0, 0)
  // 历史坐标仍存在但 usage 为空，空态短路必须先于日历/曲线组合。
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
  input.tokenPartSeries = input.tokenPartSeries.map((item) => ({
    // 组件定义仍保留，零值不能诱导 renderer 生成“有观测活动”的小多图。
    ...item,
    total: 0,
    points: item.points.map((point) => ({ ...point, value: 0 })),
  }))
  input.sessions = []
  // 清掉实际实体列表而保留时间定义，能识别 Header 为空但旧排行榜仍残留的错误。
  input.toolUsage = []
  input.toolCalls = []
  input.tokensPerSession = 0
  input.medianTokensPerSession = 0
  return input
}
