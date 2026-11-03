import type { Argv } from "yargs"
import { Effect, Queue } from "effect"
// #174：effectCmd 包装 handler 为 Effect
import { effectCmd } from "../effect-cmd"
// #174：InstanceRef 提供 currentProject
import { InstanceRef } from "@/effect/instance-ref"
import { aggregateStats, type StatsReport } from "./stats-data"
import { renderForecast, renderInsights } from "./stats-insights"
import {
  renderBreakdown,
  renderCharts,
  renderCosts,
  renderDashboard,
  renderHeatmapPage,
  renderModels,
  renderOverview,
  renderProviders,
  renderSessions,
  renderTimeline,
  renderTokens,
  type ColorMode,
  type StatsRenderOptions,
} from "./stats-render"

export { formatNumber } from "../format"

// #174：BaseArgs 共享三字段
type BaseArgs = {
  // #483：未显式传入 --all-time 时所有 stats 子命令共享同一默认窗口；
  // 保留原始参数而不是提前转换，便于交互模式在多个窗口间复用筛选条件
  // days 由 yargs default 保证存在（默认 60），因此为必填
  days: number
  allTime?: boolean
  project?: string
  color?: string
}

// #174：DashboardArgs 含 interactive
type DashboardArgs = BaseArgs & {
  // #174：interactive 非 TTY 不进键盘循环
  interactive?: boolean
  limit?: number
  models?: unknown
  // #483：Dashboard 的快捷参数只控制展示数量；无值表示全部，带值必须是十进制非负整数
  tools?: unknown
}

// #174：DetailArgs 扩 limit/metric/sort
type DetailArgs = BaseArgs & {
  limit?: number
  metric?: string
  sort?: string
  // #176：明细过滤透传到 aggregateStats
  session?: string
  model?: string
  provider?: string
  source?: string
  agent?: string
  status?: string
  tool?: string
}

// #176：breakdown 参数含维度
type BreakdownArgs = DetailArgs & {
  dimension?: string
  by?: string
}

// #174：colorChoices 限制取值
const colorChoices = ["auto", "always", "never"] as const
// #174：metricChoices 限制取值
const metricChoices = ["tokens", "cost"] as const
// #174：sortChoices 限制取值
// #177：默认排序优先 tokens
const sortChoices = ["tokens", "cost", "calls", "updated"] as const
// #483：Breakdown 无跨分组可比较的 updated 时间，排序集合与 Sessions 分开
// —— updated 是会话级时间戳，模型/provider 维不存在可比值
const breakdownSortChoices = ["tokens", "cost", "calls"] as const
// #483：“默认两个月”按 60 个自然日定义；该常量同时驱动 CLI 和交互范围，防止口径漂移；
// 固定日数也让不同月份的趋势比较拥有相同采样点数量
const DEFAULT_STATS_DAYS = 60

// #174：nonNegativeInteger 拒浮点与负数
const nonNegativeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0

// #483：shortcutLimit 解析 true（全部）或十进制数字（top N）
const shortcutLimit = (value: unknown): number | undefined => {
  if (nonNegativeInteger(value)) return value
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value)
  return undefined
}

// #174：非法 days/limit/tools 在 check 失败
const breakdownChoices = ["model", "provider", "agent", "source", "project", "tool", "status"] as const
const statusChoices = ["running", "completed", "error", "aborted"] as const

// #176：breakdown 维度默认 model
const breakdownMode = (value?: string) => {
  if (
    value === "provider" ||
    value === "agent" ||
    value === "source" ||
    value === "project" ||
    value === "tool" ||
    value === "status"
  )
    return value
  return "model"
}

// #483：数量参数必须在解析边界失败，不能让负数进入切片或日期计算后产生隐式行为
const validateStatsArgs = (args: { days?: unknown; limit?: unknown; tools?: unknown; models?: unknown }) => {
  for (const key of ["days", "limit"] as const) {
    const value = args[key]
    if (value === undefined) continue
    if (!nonNegativeInteger(value)) throw new Error(`--${key} must be a non-negative integer`)
  }
  // root shortcuts 接受无值 boolean true；只有显式给值时才要求非负整数
  if (args.tools !== undefined && args.tools !== true && shortcutLimit(args.tools) === undefined) {
    throw new Error("--tools must be a non-negative integer when a value is provided")
  }
  if (args.models !== undefined && args.models !== true && shortcutLimit(args.models) === undefined) {
    throw new Error("--models must be a non-negative integer when a value is provided")
  }
  return true
}

// #174：withBaseOptions 统一基参
// #483：基础选项由所有 stats 端点复用，保证默认范围、项目筛选和颜色模式完全一致
const withBaseOptions = (yargs: Argv) =>
  yargs
    .option("days", {
      // #174：describe 供 --help
      describe: "show stats for the last N days (0 means today)",
      type: "number",
      default: DEFAULT_STATS_DAYS,
    })
    // #483：--all-time 是显式全历史路径；同时传两个参数时 all-time 胜出
    .option("all-time", {
      describe: "include all recorded usage instead of the default 60 days",
      type: "boolean",
      default: false,
    })
    .option("project", {
      describe: "filter by project (default: all projects, empty string: current project)",
      type: "string",
    })
    .option("color", {
      describe: "ANSI color mode",
      type: "string",
      choices: colorChoices,
      default: "auto",
    })
    .check(validateStatsArgs)

// #483：过滤条件只改变聚合输入，不改变各页面自己的展示职责
const withFilterOptions = (yargs: Argv) =>
  withBaseOptions(yargs)
    // #176：明细过滤选项
    .option("session", {
      describe: "filter by session id/title/directory substring",
      type: "string",
    })
    .option("model", {
      describe: "filter by model id substring",
      type: "string",
    })
    .option("provider", {
      describe: "filter by provider id substring",
      type: "string",
    })
    .option("source", {
      describe: "filter by request source substring",
      type: "string",
    })
    .option("agent", {
      describe: "filter by agent substring",
      type: "string",
    })
    .option("status", {
      describe: "filter by request status",
      type: "string",
      choices: statusChoices,
    })
    .option("tool", {
      describe: "filter by tool name substring",
      type: "string",
    })

// #483：只有真正展示可变行数的页面才挂载 --limit，避免“参数可用但无效果”
const withLimitOptions = (yargs: Argv) =>
  withFilterOptions(yargs).option("limit", {
    alias: "n",
    describe: "number of rows to show",
    type: "number",
  })

// #483：Timeline 只需要主指标，不需要 Breakdown/Sessions 的排序参数
const withMetricOptions = (yargs: Argv) =>
  withFilterOptions(yargs).option("metric", {
    describe: "primary metric",
    type: "string",
    choices: metricChoices,
  })

// #174：withDetailOptions 追加展示参（保留给 charts/heatmap 等多参页面）
const withDetailOptions = (yargs: Argv) =>
  withLimitOptions(yargs)
    .option("metric", {
      describe: "primary bar metric",
      type: "string",
      choices: metricChoices,
      default: "tokens",
    })
    .option("sort", {
      describe: "sort order",
      type: "string",
      choices: sortChoices,
      default: "tokens",
    })

// #483：Timeline 不暴露 sort/limit，避免命令行接受后又静默忽略
const withTimelineOptions = (yargs: Argv) =>
  withMetricOptions(yargs).option("heatmap", {
    describe: "include the calendar heatmap section",
    type: "boolean",
    default: false,
  })

// #483：分组页允许 tokens/cost/calls 排序，但没有跨分组可比较的 updated 时间
const withBreakdownDetailOptions = (yargs: Argv) =>
  withLimitOptions(yargs)
    .option("metric", {
      describe: "primary attribution metric",
      type: "string",
      choices: metricChoices,
    })
    .option("sort", {
      describe: "sort order",
      type: "string",
      choices: breakdownSortChoices,
    })

// #483：Sessions 的 updated 排序有明确语义，因此与 Breakdown 的排序集合分离
const withSessionsOptions = (yargs: Argv) =>
  withLimitOptions(yargs).option("sort", {
    describe: "sort order",
    type: "string",
    choices: sortChoices,
    default: "tokens",
  })

// 预测需要显式开启，默认观察页不计算或展示预测。
const withInsightsOptions = (yargs: Argv) =>
  withFilterOptions(yargs).option("forecast", {
    describe: "include run-rate projection charts",
    type: "boolean",
    default: false,
  })

// #174：loadReport 是唯一聚合入口
// #174：loadReport 把 CLI 参数映射为过滤条件后聚合
const withBreakdownOptions = (yargs: Argv) =>
  withBreakdownDetailOptions(yargs)
    .positional("dimension", {
      describe: "attribution dimension",
      type: "string",
      choices: breakdownChoices,
      default: "model",
    })
    .option("by", {
      alias: "b",
      describe: "attribution dimension",
      type: "string",
      choices: breakdownChoices,
    })
    // #483：Tool 聚合没有费用归因，拒绝 cost 比把调用量伪装成费用更安全
    .check((args) => {
      const dimension = (args as { by?: string; dimension?: string }).by ?? (args as { dimension?: string }).dimension
      if (
        dimension === "tool" &&
        ((args as { metric?: string }).metric === "cost" || (args as { sort?: string }).sort === "cost")
      ) {
        throw new Error("tool breakdown supports token context and call volume, not cost")
      }
      return true
    })

// #483：days 在交互范围间可为 undefined（all-time）；用 Omit 避免交叉类型把可选重新变必填
const loadReport = Effect.fn("Cli.stats.load")(function* (
  args: Omit<BaseArgs, "days"> & { days?: number | undefined } & Partial<DetailArgs>,
) {
  const ctx = yield* InstanceRef
  // #483：过滤与窗口在一次聚合中完成，渲染层不得二次筛数据，否则总计与图表会失配
  return yield* aggregateStats({
    // #483：--all-time 胜出默认窗口；这样既保留 yargs 可见的 days 默认值，
    // 又为用户提供不受默认窗口约束的显式全历史路径
    days: args.allTime ? undefined : (args.days ?? DEFAULT_STATS_DAYS),
    projectFilter: args.project,
    currentProject: ctx?.project,
    // #176：映射 CLI session → sessionFilter
    sessionFilter: args.session,
    // #176：映射 CLI model → modelFilter
    modelFilter: args.model,
    providerFilter: args.provider,
    sourceFilter: args.source,
    agentFilter: args.agent,
    statusFilter: args.status,
    // #176：映射 CLI tool → toolFilter
    toolFilter: args.tool,
  })
})

const colorMode = (value?: string): ColorMode => {
  if (value === "always" || value === "never") return value
  return "auto"
}

const metricMode = (value?: string): StatsRenderOptions["metric"] => {
  // #177：metric 与 sort 解耦，cost 必须仍可选
  if (value === "cost") return "cost"
  return "tokens"
}

const sortMode = (value?: string): StatsRenderOptions["sort"] => {
  // #177：显式 cost 仍可选；默认 tokens
  if (value === "cost" || value === "tokens" || value === "calls" || value === "updated") return value
  return "tokens"
}

// #174：renderOptions 从 args 组装
const renderOptions = (args: DetailArgs | DashboardArgs | BreakdownArgs): StatsRenderOptions => ({
  color: colorMode(args.color),
  limit: "limit" in args ? args.limit : undefined,
  metric: "metric" in args ? metricMode(args.metric) : undefined,
  sort: "sort" in args ? sortMode(args.sort) : undefined,
  // #176：breakdown 维度
  by:
    "by" in args || "dimension" in args
      ? breakdownMode(
          ("by" in args ? args.by : undefined) ?? ("dimension" in args ? (args as BreakdownArgs).dimension : undefined),
        )
      : undefined,
})

// #176：按维度归因成本/tokens/请求
// #176：breakdown 是维度归因主入口
export const StatsBreakdownCommand = effectCmd({
  command: "breakdown [dimension]",
  aliases: ["by"],
  describe: "attribute cost, tokens, and requests by one dimension",
  builder: withBreakdownOptions,
  handler: Effect.fn("Cli.stats.breakdown")(function* (args: BreakdownArgs) {
    console.log(
      renderBreakdown(yield* loadReport(args), {
        ...renderOptions(args),
        // #176：--by 优先于 positional dimension
        by: breakdownMode(args.by ?? args.dimension),
      }),
    )
  }),
})

export const StatsOverviewCommand = effectCmd({
  command: "overview",
  // #174：aliases 保持旧脚本
  aliases: ["summary"],
  describe: "show a rich usage overview",
  // #174：builder 注册 options 与 check
  builder: (yargs) =>
    withBaseOptions(yargs).option("limit", {
      alias: "n",
      describe: "number of tools to show",
      type: "number",
    }),
  // #174：handler 内 loadReport 后 render
  handler: Effect.fn("Cli.stats.overview")(function* (args: BaseArgs & { limit?: number }) {
    console.log(renderOverview(yield* loadReport(args), { color: colorMode(args.color), limit: args.limit }))
  }),
})

export const StatsModelsCommand = effectCmd({
  command: "models",
  aliases: ["model"],
  describe: "rank token usage and cost by model id",
  // #483：models 是 breakdown 的 model 维，不接受无消费路径的 updated 排序
  builder: withBreakdownDetailOptions,
  handler: Effect.fn("Cli.stats.models")(function* (args: DetailArgs) {
    console.log(renderModels(yield* loadReport(args), renderOptions(args)))
  }),
})

export const StatsProvidersCommand = effectCmd({
  command: "providers",
  aliases: ["provider"],
  describe: "rank token usage and cost by provider",
  // #483：providers 与 models 同为 breakdown 维度页，共享严格化后的排序集合
  builder: withBreakdownDetailOptions,
  handler: Effect.fn("Cli.stats.providers")(function* (args: DetailArgs) {
    console.log(renderProviders(yield* loadReport(args), renderOptions(args)))
  }),
})

// #174：StatsTimelineCommand 服务时间线折线，不承担 heatmap 命令
export const StatsTimelineCommand = effectCmd({
  command: "timeline",
  aliases: ["daily"],
  describe: "render daily token stacks or cost bars",
  // #483：Timeline 不暴露 sort/limit，避免命令行接受后又静默忽略
  builder: withTimelineOptions,
  handler: Effect.fn("Cli.stats.timeline")(function* (args: DetailArgs & { heatmap?: boolean }) {
    console.log(renderTimeline(yield* loadReport(args), { ...renderOptions(args), heatmap: args.heatmap }))
  }),
})

export const StatsSessionsCommand = effectCmd({
  command: "sessions",
  aliases: ["session"],
  describe: "rank individual sessions by cost, tokens, calls, or recency",
  // #483：Sessions 的 updated 排序有明确语义，与 Breakdown 集合分离
  builder: withSessionsOptions,
  handler: Effect.fn("Cli.stats.sessions")(function* (args: DetailArgs) {
    console.log(renderSessions(yield* loadReport(args), renderOptions(args)))
  }),
})

export const StatsDashboardCommand = effectCmd({
  command: "dashboard",
  aliases: ["dash"],
  describe: "show a balanced usage dashboard",
  builder: (yargs) =>
    withBaseOptions(yargs)
      .option("limit", {
        alias: "n",
        describe: "number of model/provider rows to show",
        type: "number",
      })
      .option("interactive", {
        alias: "i",
        describe: "cycle dashboard views with keyboard shortcuts",
        type: "boolean",
        default: false,
      }),
  handler: Effect.fn("Cli.stats.dashboard")(function* (args: DashboardArgs) {
    if (args.interactive) {
      // #483：交互循环自带懒加载缓存，handler 不再预载全部范围
      yield* runInteractiveDashboard(args)
      return
    }
    console.log(renderDashboard(yield* loadReport(args), renderOptions(args)))
  }),
})

export const StatsChartsCommand = effectCmd({
  command: "charts",
  aliases: ["graphs"],
  describe: "show the chart gallery for visual diagnostics",
  builder: withDetailOptions,
  handler: Effect.fn("Cli.stats.charts")(function* (args: DetailArgs) {
    console.log(renderCharts(yield* loadReport(args), renderOptions(args)))
  }),
})

// #174：StatsHeatmapCommand 输出密度格/矩阵语义，供 heatmap 命令使用
export const StatsHeatmapCommand = effectCmd({
  command: "heatmap",
  aliases: ["heat"],
  describe: "show density maps for days and provider/model usage",
  builder: withDetailOptions,
  handler: Effect.fn("Cli.stats.heatmap")(function* (args: DetailArgs) {
    console.log(renderHeatmapPage(yield* loadReport(args), renderOptions(args)))
  }),
})

export const StatsCostsCommand = effectCmd({
  command: "costs",
  aliases: ["cost"],
  describe: "show cost-only curves, waterfalls, and distributions",
  builder: withDetailOptions,
  handler: Effect.fn("Cli.stats.costs")(function* (args: DetailArgs) {
    console.log(renderCosts(yield* loadReport(args), renderOptions(args)))
  }),
})

export const StatsTokensCommand = effectCmd({
  command: "tokens",
  aliases: ["token"],
  describe: "show token-only input/output/cache stacks and ledger",
  builder: withLimitOptions,
  handler: Effect.fn("Cli.stats.tokens")(function* (args: DetailArgs) {
    console.log(renderTokens(yield* loadReport(args), renderOptions(args)))
  }),
})

// #174：StatsInsightsCommand 从已有 totals/daily 派生卡片
export const StatsInsightsCommand = effectCmd({
  command: "insights",
  aliases: ["insight"],
  // #483：insights 只呈现定量证据与 outliers，不输出主观建议
  describe: "show quantitative usage shape, attribution, outliers, and run-rate",
  // #483：Insights 不接受排行裁剪，Forecast由独立开关控制。
  builder: withInsightsOptions,
  handler: Effect.fn("Cli.stats.insights")(function* (args: DetailArgs & { forecast?: boolean }) {
    // 显式转发到唯一Insights渲染入口，独立forecast命令仍保留。
    console.log(renderInsights(yield* loadReport(args), { color: colorMode(args.color), forecast: args.forecast }))
  }),
})

// #174：StatsForecastCommand 样本不足则返回说明文案
export const StatsForecastCommand = effectCmd({
  command: "forecast",
  aliases: ["run-rate"],
  describe: "project cost run-rate and month-end spend",
  // #483：forecast 不接受 limit——预测图表行数由算法决定，不是用户可裁剪的排行
  builder: withFilterOptions,
  handler: Effect.fn("Cli.stats.forecast")(function* (args: DetailArgs) {
    console.log(renderForecast(yield* loadReport(args), { color: colorMode(args.color) }))
  }),
})

// #174：无子命令时默认 dashboard
export const StatsCommand = effectCmd({
  command: "stats",
  describe: "show token usage and cost statistics",
  builder: (yargs: Argv) =>
    withBaseOptions(yargs)
      // #483：这些选项只属于 root Dashboard/shortcut；global=false 防止子命令接收后静默忽略
      .option("tools", {
        describe: "shortcut to tool breakdown; optionally pass number of tools",
        global: false,
      })
      .option("models", {
        describe: "legacy shortcut: show top model rows in the dashboard; pass a number for top N",
        global: false,
      })
      // #483：root limit 只控制 Dashboard 或 shortcut 行数；Breakdown/Sessions 在自己的 builder 中重新声明
      .option("limit", {
        alias: "n",
        describe: "number of model/provider rows to show",
        type: "number",
        global: false,
      })
      .option("interactive", {
        alias: "i",
        describe: "cycle dashboard views with keyboard shortcuts",
        type: "boolean",
        default: false,
        global: false,
      })
      // #176：注册 breakdown 子命令
      .command(StatsBreakdownCommand)
      .command(StatsOverviewCommand)
      .command(StatsDashboardCommand)
      .command(StatsModelsCommand)
      .command(StatsProvidersCommand)
      .command(StatsTimelineCommand)
      .command(StatsSessionsCommand)
      .command(StatsChartsCommand)
      .command(StatsHeatmapCommand)
      .command(StatsCostsCommand)
      .command(StatsTokensCommand)
      .command(StatsInsightsCommand)
      .command(StatsForecastCommand),
  handler: Effect.fn("Cli.stats")(function* (args: DashboardArgs) {
    const limit = args.models === true ? Number.POSITIVE_INFINITY : (shortcutLimit(args.models) ?? args.limit)
    // #483：无值 --tools 与 --models 对称地表示全部；带值只覆盖对应 Breakdown 的行数
    const toolLimit = args.tools === true ? Number.POSITIVE_INFINITY : (shortcutLimit(args.tools) ?? args.limit)
    if (args.interactive) {
      yield* runInteractiveDashboard({ ...args, limit })
      return
    }
    if (args.tools !== undefined) {
      console.log(
        renderBreakdown(yield* loadReport(args), { color: colorMode(args.color), limit: toolLimit, by: "tool" }),
      )
      return
    }
    if (args.models !== undefined) {
      console.log(renderBreakdown(yield* loadReport(args), { color: colorMode(args.color), limit, by: "model" }))
      return
    }
    console.log(renderDashboard(yield* loadReport(args), { color: colorMode(args.color), limit }))
  }),
})

// #483：用户显式窗口排在首位，其余预设去重后保持固定循环顺序；
// undefined 专门表示 all-time，不能与 today 的 0 混用
const interactiveRanges = (args: BaseArgs) => {
  const selected = args.allTime ? undefined : (args.days ?? DEFAULT_STATS_DAYS)
  return [selected, DEFAULT_STATS_DAYS, 30, 7, 0, undefined].filter(
    (days, index, list) => list.findIndex((item) => item === days) === index,
  )
}

// #483：范围标签直接使用用户可见语义（all time/today/N days），
// 同时作为交互缓存键——同一窗口切回来时不得再次扫描数据库
const rangeLabel = (days?: number) => (days === undefined ? "all time" : days === 0 ? "today" : `${days} days`)

function runInteractiveDashboard(args: DashboardArgs) {
  // #483：源形态循环——Queue 按键队列 + race 让 all-time 聚合可被按键中断，
  // 首屏只加载第一个范围，其余范围首次打开时才聚合
  return Effect.gen(function* () {
    const ranges = interactiveRanges(args)
    // #483：首屏只聚合用户显式选择的范围；all-time 全历史聚合延迟到首次切换时
    const initial = yield* loadReport({ ...args, days: ranges[0], allTime: ranges[0] === undefined })
    // 非 TTY 环境只渲染一次，不能切 raw mode，保证管道和重定向仍可使用
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      console.log(renderDashboard(initial, { color: colorMode(args.color), limit: args.limit }))
      return
    }

    // #483：视图集合保留目标全部页面；渲染器不持有状态，切换仅换渲染入口
    const views = [
      {
        name: "dashboard",
        render: (report: StatsReport) => renderDashboard(report, { color: colorMode(args.color), limit: args.limit }),
      },
      {
        name: "models",
        render: (report: StatsReport) => renderModels(report, { color: colorMode(args.color), limit: args.limit }),
      },
      {
        name: "providers",
        render: (report: StatsReport) =>
          renderProviders(report, { color: colorMode(args.color), limit: args.limit, metric: "cost" }),
      },
      { name: "timeline", render: (report: StatsReport) => renderTimeline(report, { color: colorMode(args.color) }) },
      {
        name: "sessions",
        render: (report: StatsReport) => renderSessions(report, { color: colorMode(args.color), limit: args.limit }),
      },
      { name: "insights", render: (report: StatsReport) => renderInsights(report, { color: colorMode(args.color) }) },
      { name: "forecast", render: (report: StatsReport) => renderForecast(report, { color: colorMode(args.color) }) },
    ]
    const cache = new Map<string, StatsReport>([[rangeLabel(ranges[0]), initial]])
    const stdin = process.stdin as NodeJS.ReadStream & {
      isRaw?: boolean
      setRawMode?: (mode: boolean) => NodeJS.ReadStream
    }
    const keys = yield* Queue.make<string>()
    let input = ""
    let escapeTimer: ReturnType<typeof setTimeout> | undefined
    let view = 0
    let range = 0
    let running = true

    // #483：按需聚合入口——懒加载与缓存共用同一路径，重复打开同范围零额外扫描
    const reportFor = (days?: number) =>
      Effect.gen(function* () {
        // 未命中时才聚合；加载 Effect 可被按键 race 中断，不留下半成品缓存
        const key = rangeLabel(days)
        const cached = cache.get(key)
        if (cached) return cached
        const report = yield* loadReport({ ...args, days, allTime: days === undefined })
        cache.set(key, report)
        return report
      })
    // #483：v4 的 offerUnsafe 是同步 boolean——入队永不阻塞，无需 Effect 包装
    const offerKey = (key: string) => {
      Queue.offerUnsafe(keys, key)
    }
    const flushKeys = () => {
      // ESC 既可能是退出键，也可能是方向键前缀；短暂等待可兼容分片输入
      if (escapeTimer) clearTimeout(escapeTimer)
      escapeTimer = undefined
      while (input) {
        if (input[0] === "\u001b") {
          if (input.length < 3 && (input.length === 1 || input[1] === "[")) {
            // timer 回调再次校验前缀，避免迟到回调误消费后续普通按键
            escapeTimer = setTimeout(() => {
              escapeTimer = undefined
              if (input[0] !== "\u001b") return flushKeys()
              input = input.slice(1)
              Queue.offerUnsafe(keys, "escape")
              flushKeys()
            }, 20)
            return
          }
          const arrow = { "\u001b[A": "up", "\u001b[B": "down", "\u001b[C": "right", "\u001b[D": "left" }[
            input.slice(0, 3)
          ]
          if (arrow) {
            // 一次 data chunk 可能包含多个按键，循环逐个入队而不是丢弃尾部
            input = input.slice(3)
            offerKey(arrow)
            continue
          }
          input = input.slice(1)
          offerKey("escape")
          continue
        }
        const key = Array.from(input)[0]
        input = input.slice(key.length)
        offerKey(key === "\u0003" ? "ctrl-c" : key === "\t" ? "tab" : key)
      }
    }
    const onData = (chunk: Buffer) => {
      input += chunk.toString("utf8")
      flushKeys()
    }
    const onEnd = () => {
      Queue.offerUnsafe(keys, "q")
    }

    // #483：生命周期包裹——acquire 注册输入、body 循环绘制、release 恢复终端，
    // 三段覆盖正常退出、EOF、错误与 Effect 中断四条路径
    yield* Effect.acquireUseRelease(
      Effect.sync(() => {
        // 保存进入前状态，退出后恢复调用者的 raw/paused 约定，而不是强制设为默认值
        const state = { paused: stdin.isPaused(), raw: stdin.isRaw ?? false }
        process.stdout.write("\x1b[?25l")
        stdin.setRawMode?.(true)
        stdin.resume()
        stdin.on("data", onData)
        stdin.once("end", onEnd)
        stdin.once("error", onEnd)
        return state
      }),
      () =>
        Effect.whileLoop({
          while: () => running,
          body: () =>
            Effect.gen(function* () {
              // 加载与输入竞争：all-time 聚合期间仍可退出或切换范围
              const result = yield* Effect.race(
                reportFor(ranges[range]).pipe(Effect.map((report) => ({ type: "report" as const, report }))),
                Queue.take(keys).pipe(Effect.map((key) => ({ type: "key" as const, key }))),
              )
              if (result.type === "key") return result.key
              // 只有完整 report 才绘制，避免终端出现半更新页面；
              // race 败者（被中断的加载）不写入缓存，下次进入重算
              process.stdout.write("\x1b[2J\x1b[H")
              process.stdout.write(views[view].render(result.report))
              const help =
                process.stdout.columns && process.stdout.columns < 60
                  ? `\n\n${views[view].name} · ${rangeLabel(ranges[range])}\nn/p view · r/R range · q quit\n`
                  : `\n\n${views[view].name} · ${rangeLabel(ranges[range])} · n/→ next · p/← previous · r/R range · q/Esc quit\n`
              process.stdout.write(help)
              return yield* Queue.take(keys)
            }),
          step: (key) => {
            // view 和 range 仅由单个循环步更新，避免重叠 key handler 产生竞态
            if (key === "q" || key === "escape" || key === "ctrl-c") running = false
            if (key === "n" || key === "tab" || key === "right" || key === "down") view = (view + 1) % views.length
            if (key === "p" || key === "left" || key === "up") view = (view + views.length - 1) % views.length
            if (key === "r") range = (range + 1) % ranges.length
            if (key === "R") range = (range + ranges.length - 1) % ranges.length
          },
        }),
      (state) =>
        Effect.sync(() => {
          // finalizer 覆盖正常退出、EOF、错误和 Effect 中断，光标必须始终恢复
          if (escapeTimer) clearTimeout(escapeTimer)
          stdin.off("data", onData)
          stdin.off("end", onEnd)
          stdin.off("error", onEnd)
          stdin.setRawMode?.(state.raw)
          if (state.paused) stdin.pause()
          else stdin.resume()
          process.stdout.write("\x1b[?25h\x1b[0m\n")
        }),
    )
  })
}
