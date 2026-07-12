import type { Argv } from "yargs"
import { Effect, Queue } from "effect"
import { effectCmd } from "../effect-cmd"
import { InstanceRef } from "@/effect/instance-ref"
import { aggregateStats, type StatsReport } from "./stats/data"
import { renderInsights } from "./stats/insights"
import {
  renderBreakdown,
  renderDashboard,
  renderModels,
  renderProviders,
  renderSessions,
  renderTimeline,
  type BreakdownDimension,
  type ColorMode,
  type StatsRenderOptions,
} from "./stats/render"

export { formatNumber } from "./stats/render"

type BaseArgs = {
  // 未显式传入 `--all-time` 时，所有 stats 子命令共享同一默认时间窗口。
  // 这里保留原始参数，而不是提前转换，便于交互模式在多个窗口间复用筛选条件。
  days?: number
  allTime?: boolean
  project?: string
  color?: string
  session?: string
  model?: string
  provider?: string
  source?: string
  agent?: string
  status?: string
  tool?: string
}

type DashboardArgs = BaseArgs & {
  // Dashboard 的快捷参数只控制展示数量，不能泄漏到不消费这些参数的其他端点。
  interactive?: boolean
  limit?: number
  models?: unknown
  tools?: unknown
}

type LimitArgs = BaseArgs & {
  limit?: number
}

type BreakdownArgs = LimitArgs & {
  // Breakdown 只接受可实际排序的聚合指标；会话更新时间不属于分组维度。
  metric?: string
  sort?: string
  dimension?: string
  by?: string
}

type TimelineArgs = BaseArgs & {
  // Timeline 不暴露 sort/limit，避免命令行接受后又静默忽略。
  metric?: string
  heatmap?: boolean
}

type SessionsArgs = LimitArgs & {
  // 会话页允许按更新时间排序，但不接受没有消费路径的 metric 参数。
  sort?: string
}

type InsightsArgs = BaseArgs & {
  forecast?: boolean
}

const colorChoices = ["auto", "always", "never"] as const
// Breakdown 与 Sessions 的可排序字段不同，拆开集合可让 yargs 在入口直接拒绝无效组合。
const metricChoices = ["tokens", "cost"] as const
const sortChoices = ["tokens", "cost", "calls", "updated"] as const
const breakdownSortChoices = ["tokens", "cost", "calls"] as const
const breakdownChoices = ["model", "provider", "agent", "source", "project", "tool", "status"] as const
const statusChoices = ["running", "completed", "error", "aborted"] as const
// “默认两个月”按 60 个自然日定义；该常量同时驱动 CLI 和交互范围，防止口径漂移。
// 固定日数也让不同月份的趋势比较拥有相同采样点数量。
const DEFAULT_STATS_DAYS = 60

const nonNegativeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0

const shortcutLimit = (value: unknown): number | undefined => {
  if (nonNegativeInteger(value)) return value
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value)
  return undefined
}

const validateStatsArgs = (args: { days?: unknown; limit?: unknown; tools?: unknown; models?: unknown }) => {
  // 数量参数必须在解析边界失败，不能让负数进入切片或日期计算后产生隐式行为。
  for (const key of ["days", "limit"] as const) {
    const value = args[key]
    if (value === undefined) continue
    if (!nonNegativeInteger(value)) throw new Error(`--${key} must be a non-negative integer`)
  }
  // root shortcuts 接受无值 boolean true；只有显式给值时才要求非负整数。
  if (args.tools !== undefined && args.tools !== true && shortcutLimit(args.tools) === undefined) {
    throw new Error("--tools must be a non-negative integer when a value is provided")
  }
  if (args.models !== undefined && args.models !== true && shortcutLimit(args.models) === undefined) {
    throw new Error("--models must be a non-negative integer when a value is provided")
  }
  return true
}

const withBaseOptions = (yargs: Argv) =>
  // 基础选项由所有 stats 端点复用，保证默认范围、项目筛选和颜色模式完全一致。
  // 新增公共筛选必须先确认五个端点都会消费，否则应放到专属 builder。
  yargs
    .option("days", {
      describe: "show stats for the last N days (0 means today)",
      type: "number",
      default: DEFAULT_STATS_DAYS,
    })
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

const withFilterOptions = (yargs: Argv) =>
  // 过滤条件只改变聚合输入，不改变各页面自己的展示职责。
  withBaseOptions(yargs)
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

const withLimitOptions = (yargs: Argv) =>
  // 只有真正展示可变行数的页面才挂载 `--limit`，避免“参数可用但无效果”。
  withFilterOptions(yargs).option("limit", {
    alias: "n",
    describe: "number of rows to show",
    type: "number",
  })

const withMetricOptions = (yargs: Argv) =>
  // Timeline 只需要主指标，不需要 Breakdown/Sessions 的排序参数。
  withFilterOptions(yargs).option("metric", {
    describe: "primary metric",
    type: "string",
    choices: metricChoices,
  })

const withTimelineOptions = (yargs: Argv) =>
  withMetricOptions(yargs).option("heatmap", {
    describe: "include the calendar heatmap section",
    type: "boolean",
    default: false,
  })

const withBreakdownDetailOptions = (yargs: Argv) =>
  // 分组页允许 tokens/cost/calls 排序，但没有跨分组可比较的 updated 时间。
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
    .check((args) => {
      const dimension = args.by ?? args.dimension
      // Tool 聚合没有费用归因，拒绝 cost 比把调用量伪装成费用更安全。
      if (dimension === "tool" && (args.metric === "cost" || args.sort === "cost")) {
        throw new Error("tool breakdown supports token context and call volume, not cost")
      }
      return true
    })

const withSessionsOptions = (yargs: Argv) =>
  // Sessions 的 updated 排序有明确语义，因此与 Breakdown 的排序集合分离。
  withLimitOptions(yargs).option("sort", {
    describe: "sort order",
    type: "string",
    choices: sortChoices,
    default: "tokens",
  })

const withInsightsOptions = (yargs: Argv) =>
  withFilterOptions(yargs).option("forecast", {
    describe: "include run-rate projection charts",
    type: "boolean",
    default: false,
  })

const loadReport = Effect.fn("Cli.stats.load")(function* (args: BaseArgs) {
  const ctx = yield* InstanceRef
  // 过滤与窗口在一次聚合中完成，渲染层不得二次筛数据，否则总计与图表会失配。
  const report: StatsReport = yield* aggregateStats({
    // 同时传入两个参数时 `--all-time` 必须胜出；这样既保留 yargs 可见的 days 默认值，
    // 又为用户提供不受默认窗口约束的显式全历史路径。
    days: args.allTime ? undefined : args.days ?? DEFAULT_STATS_DAYS,
    projectFilter: args.project,
    currentProject: ctx?.project,
    sessionFilter: args.session,
    modelFilter: args.model,
    providerFilter: args.provider,
    sourceFilter: args.source,
    agentFilter: args.agent,
    statusFilter: args.status,
    toolFilter: args.tool,
  })
  return report
})

const colorMode = (value?: string): ColorMode => {
  // 未识别值回落 auto，保持配置和终端能力探测的既有行为。
  if (value === "always" || value === "never") return value
  return "auto"
}

const metricMode = (value?: string): StatsRenderOptions["metric"] => {
  // yargs 已完成枚举校验；这里仅把可选字符串收窄为渲染器类型。
  if (value === "cost") return "cost"
  return "tokens"
}

const sortMode = (value?: string): StatsRenderOptions["sort"] => {
  // 未传 sort 时返回 tokens，显式 updated 仅会从 Sessions 构建器进入。
  if (value === "cost") return "cost"
  if (value === "tokens" || value === "calls" || value === "updated") return value
  return "tokens"
}

const breakdownMode = (value?: string): BreakdownDimension => {
  // model 是 canonical 默认维度，隐藏 wrapper 与主 breakdown 必须落到同一渲染路径。
  if (value === "provider" || value === "agent" || value === "source" || value === "project" || value === "tool" || value === "status") return value
  return "model"
}

const renderOptions = (args: BaseArgs & { limit?: number; metric?: string; sort?: string }): StatsRenderOptions => ({
  // 仅映射调用方真实拥有的字段，不在此制造端点未声明的默认参数。
  color: colorMode(args.color),
  limit: args.limit,
  metric: args.metric !== undefined ? metricMode(args.metric) : undefined,
  sort: args.sort !== undefined ? sortMode(args.sort) : undefined,
})

const timelineOptions = (args: TimelineArgs): StatsRenderOptions => ({
  ...renderOptions(args),
  heatmap: args.heatmap,
})

const breakdownOptions = (args: BreakdownArgs): StatsRenderOptions => ({
  ...renderOptions(args),
  by: breakdownMode(args.by ?? args.dimension),
})

export const StatsBreakdownCommand = effectCmd({
  // 公开 breakdown 是所有分组别名的唯一行为入口，避免 wrapper 逐渐分叉。
  // 隐藏别名只预填 by 参数，不复制聚合或渲染实现。
  command: "breakdown [dimension]",
  aliases: ["by"],
  describe: "attribute cost, tokens, and requests by one dimension",
  builder: withBreakdownOptions,
  handler: Effect.fn("Cli.stats.breakdown")(function* (args: BreakdownArgs) {
    console.log(renderBreakdown(yield* loadReport(args), breakdownOptions(args)))
  }),
})

export const StatsModelsCommand = effectCmd({
  command: "models",
  aliases: ["model"],
  describe: false,
  builder: withBreakdownDetailOptions,
  handler: Effect.fn("Cli.stats.models")(function* (args: BreakdownArgs) {
    console.log(renderModels(yield* loadReport(args), { ...renderOptions(args), by: "model" }))
  }),
})

export const StatsProvidersCommand = effectCmd({
  command: "providers",
  aliases: ["provider"],
  describe: false,
  builder: withBreakdownDetailOptions,
  handler: Effect.fn("Cli.stats.providers")(function* (args: BreakdownArgs) {
    console.log(renderProviders(yield* loadReport(args), { ...renderOptions(args), by: "provider" }))
  }),
})

export const StatsTimelineCommand = effectCmd({
  // Timeline 负责时间变化，不重复承担分组排名或会话诊断。
  command: "timeline",
  aliases: ["daily"],
  describe: "inspect daily volume, composition, health, and active days",
  builder: withTimelineOptions,
  handler: Effect.fn("Cli.stats.timeline")(function* (args: TimelineArgs) {
    console.log(renderTimeline(yield* loadReport(args), timelineOptions(args)))
  }),
})

export const StatsSessionsCommand = effectCmd({
  // Sessions 只比较单会话多维指标，跨会话全局工具排名留给 tool breakdown。
  command: "sessions",
  aliases: ["session"],
  describe: "rank individual sessions by tokens, cost, calls, or recency",
  builder: withSessionsOptions,
  handler: Effect.fn("Cli.stats.sessions")(function* (args: SessionsArgs) {
    console.log(renderSessions(yield* loadReport(args), renderOptions(args)))
  }),
})

export const StatsDashboardCommand = effectCmd({
  command: "dashboard",
  aliases: ["dash", "overview", "summary"],
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
        describe: "cycle stats views with keyboard shortcuts",
        type: "boolean",
        default: false,
      }),
  handler: Effect.fn("Cli.stats.dashboard")(function* (args: DashboardArgs) {
    if (args.interactive) {
      yield* runInteractiveDashboard(args)
      return
    }
    console.log(renderDashboard(yield* loadReport(args), renderOptions(args)))
  }),
})

export const StatsHeatmapCommand = effectCmd({
  command: "heatmap",
  aliases: ["heat"],
  describe: false,
  builder: withTimelineOptions,
  handler: Effect.fn("Cli.stats.heatmap")(function* (args: TimelineArgs) {
    console.log(renderTimeline(yield* loadReport(args), { ...timelineOptions(args), heatmap: true }))
  }),
})

export const StatsCostsCommand = effectCmd({
  command: "costs",
  aliases: ["cost"],
  describe: false,
  builder: withFilterOptions,
  handler: Effect.fn("Cli.stats.costs")(function* (args: BaseArgs) {
    console.log(renderTimeline(yield* loadReport(args), { ...renderOptions(args), metric: "cost" }))
  }),
})

export const StatsTokensCommand = effectCmd({
  command: "tokens",
  aliases: ["token"],
  describe: false,
  builder: withFilterOptions,
  handler: Effect.fn("Cli.stats.tokens")(function* (args: BaseArgs) {
    console.log(renderTimeline(yield* loadReport(args), { ...renderOptions(args), metric: "tokens" }))
  }),
})

export const StatsInsightsCommand = effectCmd({
  // Insights 默认只展示观测事实；预测必须由 `--forecast` 明确开启。
  command: "insights",
  aliases: ["insight"],
  describe: "show quantitative usage shape, attribution, outliers, and actions",
  builder: withInsightsOptions,
  handler: Effect.fn("Cli.stats.insights")(function* (args: InsightsArgs) {
    console.log(renderInsights(yield* loadReport(args), { color: colorMode(args.color), forecast: args.forecast }))
  }),
})

export const StatsForecastCommand = effectCmd({
  command: "forecast",
  aliases: ["run-rate"],
  describe: false,
  builder: withFilterOptions,
  handler: Effect.fn("Cli.stats.forecast")(function* (args: BaseArgs) {
    console.log(renderInsights(yield* loadReport(args), { color: colorMode(args.color), forecast: true }))
  }),
})

export const StatsCommand = effectCmd({
  command: "stats",
  describe: "show token usage and cost statistics",
  builder: (yargs: Argv) =>
    withBaseOptions(yargs)
      // 这些选项只属于 root Dashboard/shortcut；global=false 防止子命令接收后静默忽略。
      // days/all-time/project/color 仍由 withBaseOptions 保持全局，所有 Stats 页面继续共享筛选口径。
      .option("tools", {
        describe: "shortcut to tool breakdown; optionally pass number of tools",
        global: false,
      })
      .option("models", {
        describe: "shortcut to model breakdown; pass a number for top N",
        global: false,
      })
      // Root limit 只控制 Dashboard 或 shortcut 行数；Breakdown/Sessions 会在自己的 builder 中重新声明。
      .option("limit", {
        alias: "n",
        describe: "number of rows to show",
        type: "number",
        global: false,
      })
      // 交互循环属于 Dashboard；未来其他页面若需要交互，必须显式定义自己的参数和清理协议。
      .option("interactive", {
        alias: "i",
        describe: "cycle stats views with keyboard shortcuts",
        type: "boolean",
        default: false,
        global: false,
      })
      .command(StatsDashboardCommand)
      .command(StatsBreakdownCommand)
      .command(StatsModelsCommand)
      .command(StatsProvidersCommand)
      .command(StatsTimelineCommand)
      .command(StatsSessionsCommand)
      .command(StatsHeatmapCommand)
      .command(StatsCostsCommand)
      .command(StatsTokensCommand)
      .command(StatsInsightsCommand)
      .command(StatsForecastCommand),
  handler: Effect.fn("Cli.stats")(function* (args: DashboardArgs) {
    const limit = args.models === true ? Number.POSITIVE_INFINITY : shortcutLimit(args.models) ?? args.limit
    // 无值 --tools 与 --models 对称地表示全部；带值只覆盖对应 Breakdown 的行数。
    const toolLimit = args.tools === true ? Number.POSITIVE_INFINITY : shortcutLimit(args.tools) ?? args.limit
    if (args.interactive) {
      yield* runInteractiveDashboard({ ...args, limit })
      return
    }
    if (args.tools !== undefined) {
      console.log(renderBreakdown(yield* loadReport(args), { color: colorMode(args.color), limit: toolLimit, by: "tool" }))
      return
    }
    if (args.models !== undefined) {
      console.log(renderBreakdown(yield* loadReport(args), { color: colorMode(args.color), limit, by: "model" }))
      return
    }
    console.log(renderDashboard(yield* loadReport(args), { color: colorMode(args.color), limit }))
  }),
})

const interactiveRanges = (args: BaseArgs) => {
  // 用户显式窗口排在首位，其余预设去重后保持固定循环顺序。
  // undefined 专门表示 all-time，不能与 today 的 0 混用。
  // 固定顺序也是底部帮助栏和左右切换行为的用户契约。
  const selected = args.allTime ? undefined : args.days ?? DEFAULT_STATS_DAYS
  return [selected, DEFAULT_STATS_DAYS, 30, 7, 0, undefined].filter(
    (days, index, list) => list.findIndex((item) => item === days) === index,
  )
}

const rangeLabel = (days?: number) => days === undefined ? "all time" : days === 0 ? "today" : `${days} days`

function runInteractiveDashboard(args: DashboardArgs) {
  return Effect.gen(function* () {
    // 非 TTY 环境只渲染一次，不能切 raw mode，保证管道和重定向仍可使用。
    const initial = yield* loadReport(args)
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      console.log(renderDashboard(initial, { color: colorMode(args.color), limit: args.limit }))
      return
    }

    const views = [
      { name: "dashboard", render: (report: StatsReport) => renderDashboard(report, { color: colorMode(args.color), limit: args.limit }) },
      { name: "breakdown", render: (report: StatsReport) => renderBreakdown(report, { color: colorMode(args.color), limit: args.limit, by: "model" }) },
      { name: "timeline", render: (report: StatsReport) => renderTimeline(report, { color: colorMode(args.color) }) },
      { name: "sessions", render: (report: StatsReport) => renderSessions(report, { color: colorMode(args.color), limit: args.limit }) },
      { name: "insights", render: (report: StatsReport) => renderInsights(report, { color: colorMode(args.color) }) },
    ]
    const ranges = interactiveRanges(args)
    // 缓存键使用用户可见范围语义，同一窗口切回来时不得再次扫描数据库。
    const cache = new Map<string, StatsReport>([[rangeLabel(ranges[0]), initial]])
    const stdin = process.stdin as NodeJS.ReadStream & { isRaw?: boolean; setRawMode?: (mode: boolean) => NodeJS.ReadStream }
    const keys = yield* Queue.make<string>()
    let input = ""
    let escapeTimer: ReturnType<typeof setTimeout> | undefined
    let view = 0
    let range = 0
    let running = true

    const reportFor = (days?: number) => Effect.gen(function* () {
      // 未命中时才聚合；加载 Effect 可被按键 race 中断，不留下半成品缓存。
      const key = rangeLabel(days)
      const cached = cache.get(key)
      if (cached) return cached
      const report = yield* loadReport({ ...args, days, allTime: days === undefined })
      cache.set(key, report)
      return report
    })
    const offerKey = (key: string) => Queue.offerUnsafe(keys, key)
    const flushKeys = () => {
      // ESC 既可能是退出键，也可能是方向键前缀；短暂等待可兼容分片输入。
      if (escapeTimer) clearTimeout(escapeTimer)
      escapeTimer = undefined
      while (input) {
        if (input[0] === "\u001b") {
          if (input.length < 3 && (input.length === 1 || input[1] === "[")) {
            // timer 回调再次校验前缀，避免迟到回调误消费后续普通按键。
            escapeTimer = setTimeout(() => {
              escapeTimer = undefined
              if (input[0] !== "\u001b") return flushKeys()
              input = input.slice(1)
              offerKey("escape")
              flushKeys()
            }, 20)
            return
          }
          const arrow = { "\u001b[A": "up", "\u001b[B": "down", "\u001b[C": "right", "\u001b[D": "left" }[input.slice(0, 3)]
          if (arrow) {
            // 一次 data chunk 可能包含多个按键，循环逐个入队而不是丢弃尾部。
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
    const onEnd = () => offerKey("q")

    yield* Effect.acquireUseRelease(
      Effect.sync(() => {
        // 保存进入前状态，退出后恢复调用者的 raw/paused 约定，而不是强制设为默认值。
        const state = { paused: stdin.isPaused(), raw: stdin.isRaw ?? false }
        process.stdout.write("\x1b[?25l")
        stdin.setRawMode?.(true)
        stdin.resume()
        stdin.on("data", onData)
        stdin.once("end", onEnd)
        stdin.once("error", onEnd)
        return state
      }),
      () => Effect.whileLoop({
        while: () => running,
        body: () => Effect.gen(function* () {
          // 加载与输入竞争，确保 all-time 聚合期间仍可退出或切换范围。
          // 竞争结果使用显式 tag 收窄，避免按键字符串与 report 对象被混淆。
          const result = yield* Effect.race(
            reportFor(ranges[range]).pipe(Effect.map((report) => ({ type: "report" as const, report }))),
            Queue.take(keys).pipe(Effect.map((key) => ({ type: "key" as const, key }))),
          )
          if (result.type === "key") return result.key
          // 只有完整 report 才绘制，避免终端出现半更新页面。
          process.stdout.write("\x1b[2J\x1b[H")
          process.stdout.write(views[view].render(result.report))
          const help = process.stdout.columns && process.stdout.columns < 60
            ? `\n\n${views[view].name} · ${rangeLabel(ranges[range])}\nn/p view · r/R range · q quit\n`
            : `\n\n${views[view].name} · ${rangeLabel(ranges[range])} · n/→ next · p/← previous · r/R range · q/Esc quit\n`
          process.stdout.write(help)
          return yield* Queue.take(keys)
        }),
        step: (key) => {
          // view 和 range 仅由单个循环步更新，避免重叠 key handler 产生竞态。
          if (key === "q" || key === "escape" || key === "ctrl-c") running = false
          if (key === "n" || key === "tab" || key === "right" || key === "down") view = (view + 1) % views.length
          if (key === "p" || key === "left" || key === "up") view = (view + views.length - 1) % views.length
          if (key === "r") range = (range + 1) % ranges.length
          if (key === "R") range = (range + ranges.length - 1) % ranges.length
        },
      }),
      (state) => Effect.sync(() => {
        // finalizer 覆盖正常退出、EOF、错误和 Effect 中断，光标必须始终恢复。
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
