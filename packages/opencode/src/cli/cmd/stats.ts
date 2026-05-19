import type { Argv } from "yargs"
import { Effect } from "effect"
import { effectCmd } from "../effect-cmd"
import { InstanceRef } from "@/effect/instance-ref"
import { aggregateStats, type StatsReport } from "./stats-data"
import { renderForecast, renderInsights } from "./stats-insights"
import {
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

export { formatNumber } from "./stats-render"

type BaseArgs = {
  days?: number
  project?: string
  color?: string
}

type DashboardArgs = BaseArgs & {
  interactive?: boolean
  limit?: number
  models?: unknown
  tools?: number
}

type DetailArgs = BaseArgs & {
  limit?: number
  metric?: string
  sort?: string
}

const colorChoices = ["auto", "always", "never"] as const
const metricChoices = ["tokens", "cost"] as const
const sortChoices = ["cost", "tokens", "calls", "updated"] as const

const nonNegativeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0

const modelLimit = (value: unknown): number | undefined => {
  if (nonNegativeInteger(value)) return value
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value)
  return
}

const validateStatsArgs = (args: { days?: unknown; limit?: unknown; tools?: unknown; models?: unknown }) => {
  for (const key of ["days", "limit", "tools"] as const) {
    const value = args[key]
    if (value === undefined) continue
    if (!nonNegativeInteger(value)) throw new Error(`--${key} must be a non-negative integer`)
  }
  if (args.models !== undefined && args.models !== true && modelLimit(args.models) === undefined) {
    throw new Error("--models must be a non-negative integer when a value is provided")
  }
  return true
}

const withBaseOptions = (yargs: Argv) =>
  yargs
    .option("days", {
      describe: "show stats for the last N days (0 means today, default: all time)",
      type: "number",
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

const withDetailOptions = (yargs: Argv) =>
  withBaseOptions(yargs)
    .option("limit", {
      alias: "n",
      describe: "number of rows to show",
      type: "number",
    })
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
      default: "cost",
    })

const loadReport = Effect.fn("Cli.stats.load")(function* (args: BaseArgs) {
  const ctx = yield* InstanceRef
  return yield* aggregateStats({ days: args.days, projectFilter: args.project, currentProject: ctx?.project })
})

const colorMode = (value?: string): ColorMode => {
  if (value === "always" || value === "never") return value
  return "auto"
}

const metricMode = (value?: string): StatsRenderOptions["metric"] => {
  if (value === "cost") return "cost"
  return "tokens"
}

const sortMode = (value?: string): StatsRenderOptions["sort"] => {
  if (value === "tokens" || value === "calls" || value === "updated") return value
  return "cost"
}

const renderOptions = (args: DetailArgs | DashboardArgs): StatsRenderOptions => ({
  color: colorMode(args.color),
  limit: "limit" in args ? args.limit : undefined,
  metric: "metric" in args ? metricMode(args.metric) : undefined,
  sort: "sort" in args ? sortMode(args.sort) : undefined,
})

export const StatsOverviewCommand = effectCmd({
  command: "overview",
  aliases: ["summary"],
  describe: "show a rich usage overview",
  builder: (yargs) =>
    withBaseOptions(yargs).option("limit", {
      alias: "n",
      describe: "number of tools to show",
      type: "number",
    }),
  handler: Effect.fn("Cli.stats.overview")(function* (args: BaseArgs & { limit?: number }) {
    console.log(renderOverview(yield* loadReport(args), { color: colorMode(args.color), limit: args.limit }))
  }),
})

export const StatsModelsCommand = effectCmd({
  command: "models",
  aliases: ["model"],
  describe: "rank token usage and cost by model id",
  builder: withDetailOptions,
  handler: Effect.fn("Cli.stats.models")(function* (args: DetailArgs) {
    console.log(renderModels(yield* loadReport(args), renderOptions(args)))
  }),
})

export const StatsProvidersCommand = effectCmd({
  command: "providers",
  aliases: ["provider"],
  describe: "rank token usage and cost by provider",
  builder: withDetailOptions,
  handler: Effect.fn("Cli.stats.providers")(function* (args: DetailArgs) {
    console.log(renderProviders(yield* loadReport(args), renderOptions(args)))
  }),
})

export const StatsTimelineCommand = effectCmd({
  command: "timeline",
  aliases: ["daily"],
  describe: "render daily token stacks or cost bars",
  builder: withDetailOptions,
  handler: Effect.fn("Cli.stats.timeline")(function* (args: DetailArgs) {
    console.log(renderTimeline(yield* loadReport(args), renderOptions(args)))
  }),
})

export const StatsSessionsCommand = effectCmd({
  command: "sessions",
  aliases: ["session"],
  describe: "rank individual sessions by cost, tokens, calls, or recency",
  builder: withDetailOptions,
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
      const reports = yield* interactiveReports(args)
      yield* runInteractiveDashboard(reports, args)
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
  builder: withDetailOptions,
  handler: Effect.fn("Cli.stats.tokens")(function* (args: DetailArgs) {
    console.log(renderTokens(yield* loadReport(args), renderOptions(args)))
  }),
})

export const StatsInsightsCommand = effectCmd({
  command: "insights",
  aliases: ["insight"],
  describe: "show trend insights, risks, recommendations, and outliers",
  builder: withDetailOptions,
  handler: Effect.fn("Cli.stats.insights")(function* (args: DetailArgs) {
    console.log(renderInsights(yield* loadReport(args), { color: colorMode(args.color), limit: args.limit }))
  }),
})

export const StatsForecastCommand = effectCmd({
  command: "forecast",
  aliases: ["run-rate"],
  describe: "project cost run-rate and month-end spend",
  builder: withDetailOptions,
  handler: Effect.fn("Cli.stats.forecast")(function* (args: DetailArgs) {
    console.log(renderForecast(yield* loadReport(args), { color: colorMode(args.color) }))
  }),
})

export const StatsCommand = effectCmd({
  command: "stats",
  describe: "show token usage and cost statistics",
  builder: (yargs: Argv) =>
    withBaseOptions(yargs)
      .option("tools", {
        describe: "number of tools to show in overview mode",
        type: "number",
      })
      .option("models", {
        describe: "legacy shortcut: show top model rows in the dashboard; pass a number for top N",
      })
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
      })
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
    const limit = args.models === true ? Number.POSITIVE_INFINITY : modelLimit(args.models) ?? args.limit
    if (args.interactive) {
      const reports = yield* interactiveReports(args)
      yield* runInteractiveDashboard(reports, { ...args, limit })
      return
    }
    if (args.tools !== undefined) {
      console.log(renderOverview(yield* loadReport(args), { color: colorMode(args.color), limit: args.tools }))
      return
    }
    console.log(renderDashboard(yield* loadReport(args), { color: colorMode(args.color), limit }))
  }),
})

function interactiveReports(args: BaseArgs) {
  const ranges = [args.days, undefined, 7, 30, 0].filter(
    (days, index, list) => list.findIndex((item) => item === days) === index,
  )
  return Effect.forEach(ranges, (days) =>
    Effect.gen(function* () {
      const report = yield* loadReport({ ...args, days })
      return { days, report }
    }),
  )
}

function runInteractiveDashboard(reports: { days?: number; report: StatsReport }[], args: DashboardArgs) {
  return Effect.promise(
    () =>
      new Promise<void>((resolve) => {
        if (!process.stdin.isTTY || !process.stdout.isTTY) {
          console.log(renderDashboard(reports[0].report, { color: colorMode(args.color), limit: args.limit }))
          resolve()
          return
        }

        const views = [
          { name: "dashboard", render: (report: StatsReport) => renderDashboard(report, { color: colorMode(args.color), limit: args.limit }) },
          { name: "models", render: (report: StatsReport) => renderModels(report, { color: colorMode(args.color), limit: args.limit }) },
          {
            name: "providers",
            render: (report: StatsReport) => renderProviders(report, { color: colorMode(args.color), limit: args.limit, metric: "cost" }),
          },
          { name: "timeline", render: (report: StatsReport) => renderTimeline(report, { color: colorMode(args.color), limit: 30 }) },
          { name: "sessions", render: (report: StatsReport) => renderSessions(report, { color: colorMode(args.color), limit: args.limit }) },
          { name: "insights", render: (report: StatsReport) => renderInsights(report, { color: colorMode(args.color), limit: args.limit }) },
          { name: "forecast", render: (report: StatsReport) => renderForecast(report, { color: colorMode(args.color) }) },
        ]
        const stdin = process.stdin as NodeJS.ReadStream & { setRawMode?: (mode: boolean) => NodeJS.ReadStream }
        let view = 0
        let range = 0
        let closed = false

        const restoreTerminal = () => {
          stdin.setRawMode?.(false)
          process.stdout.write("\x1b[?25h\x1b[0m")
        }

        const draw = () => {
          process.stdout.write("\x1b[2J\x1b[H")
          process.stdout.write(views[view].render(reports[range].report))
          process.stdout.write(
            `\n\n${views[view].name} · range ${range + 1}/${reports.length} · n/→ next · p/← previous · r range · q/Esc quit\n`,
          )
        }
        const cleanup = () => {
          if (closed) return
          closed = true
          stdin.off("data", onData)
          stdin.off("end", cleanup)
          stdin.off("error", cleanup)
          process.off("SIGINT", cleanup)
          process.off("SIGTERM", cleanup)
          process.off("exit", restoreTerminal)
          restoreTerminal()
          stdin.pause()
          process.stdout.write("\n")
          resolve()
        }
        const onData = (chunk: Buffer) => {
          const key = chunk.toString("utf8")
          if (key === "q" || key === "\u001b" || key === "\u0003") {
            cleanup()
            return
          }
          if (key === "n" || key === "\t" || key === "\u001b[C" || key === "\u001b[B") {
            view = (view + 1) % views.length
            draw()
            return
          }
          if (key === "p" || key === "\u001b[D" || key === "\u001b[A") {
            view = (view + views.length - 1) % views.length
            draw()
            return
          }
          if (key === "r") {
            range = (range + 1) % reports.length
            draw()
          }
        }

        process.stdout.write("\x1b[?25l")
        stdin.setRawMode?.(true)
        stdin.resume()
        stdin.on("data", onData)
        stdin.once("end", cleanup)
        stdin.once("error", cleanup)
        process.once("SIGINT", cleanup)
        process.once("SIGTERM", cleanup)
        process.once("exit", restoreTerminal)
        draw()
      }),
  )
}
