import type { Argv } from "yargs"
import { Effect } from "effect"
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
  days?: number
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

type TimelineArgs = DetailArgs & {
  heatmap?: boolean
}

type BreakdownArgs = DetailArgs & {
  dimension?: string
  by?: string
}

type InsightsArgs = DetailArgs & {
  forecast?: boolean
}

const colorChoices = ["auto", "always", "never"] as const
const metricChoices = ["tokens", "cost"] as const
const sortChoices = ["tokens", "cost", "calls", "updated"] as const
const breakdownChoices = ["model", "provider", "agent", "source", "project", "tool", "status"] as const
const statusChoices = ["running", "completed", "error", "aborted"] as const

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
    })
    .option("sort", {
      describe: "sort order",
      type: "string",
      choices: sortChoices,
      default: "tokens",
    })
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

const withTimelineOptions = (yargs: Argv) =>
  withDetailOptions(yargs).option("heatmap", {
    describe: "include the calendar heatmap section",
    type: "boolean",
    default: true,
  })

const withBreakdownOptions = (yargs: Argv) =>
  withDetailOptions(yargs)
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

const withInsightsOptions = (yargs: Argv) =>
  withDetailOptions(yargs).option("forecast", {
    describe: "include run-rate projection charts",
    type: "boolean",
    default: false,
  })

const loadReport = Effect.fn("Cli.stats.load")(function* (args: BaseArgs) {
  const ctx = yield* InstanceRef
  const report: StatsReport = yield* aggregateStats({
    days: args.days,
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
  if (value === "always" || value === "never") return value
  return "auto"
}

const metricMode = (value?: string): StatsRenderOptions["metric"] => {
  if (value === "cost") return "cost"
  return "tokens"
}

const sortMode = (value?: string): StatsRenderOptions["sort"] => {
  if (value === "cost") return "cost"
  if (value === "tokens" || value === "calls" || value === "updated") return value
  return "tokens"
}

const breakdownMode = (value?: string): BreakdownDimension => {
  if (value === "provider" || value === "agent" || value === "source" || value === "project" || value === "tool" || value === "status") return value
  return "model"
}

const renderOptions = (args: DetailArgs | DashboardArgs): StatsRenderOptions => ({
  color: colorMode(args.color),
  limit: "limit" in args ? args.limit : undefined,
  metric: "metric" in args && args.metric !== undefined ? metricMode(args.metric) : undefined,
  sort: "sort" in args ? sortMode(args.sort) : undefined,
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
  builder: withDetailOptions,
  handler: Effect.fn("Cli.stats.models")(function* (args: DetailArgs) {
    console.log(renderModels(yield* loadReport(args), { ...renderOptions(args), by: "model" }))
  }),
})

export const StatsProvidersCommand = effectCmd({
  command: "providers",
  aliases: ["provider"],
  describe: false,
  builder: withDetailOptions,
  handler: Effect.fn("Cli.stats.providers")(function* (args: DetailArgs) {
    console.log(renderProviders(yield* loadReport(args), { ...renderOptions(args), by: "provider", metric: args.metric === "tokens" ? "tokens" : "cost" }))
  }),
})

export const StatsTimelineCommand = effectCmd({
  command: "timeline",
  aliases: ["daily"],
  describe: "inspect daily trends, token mix, request outcomes, and heatmap",
  builder: withTimelineOptions,
  handler: Effect.fn("Cli.stats.timeline")(function* (args: TimelineArgs) {
    console.log(renderTimeline(yield* loadReport(args), timelineOptions(args)))
  }),
})

export const StatsSessionsCommand = effectCmd({
  command: "sessions",
  aliases: ["session"],
  describe: "rank individual sessions by tokens, cost, calls, or recency",
  builder: withDetailOptions,
  handler: Effect.fn("Cli.stats.sessions")(function* (args: DetailArgs) {
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
      const reports = yield* interactiveReports(args)
      yield* runInteractiveDashboard(reports, args)
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
  builder: withTimelineOptions,
  handler: Effect.fn("Cli.stats.costs")(function* (args: TimelineArgs) {
    console.log(renderTimeline(yield* loadReport(args), { ...renderOptions(args), metric: "cost" }))
  }),
})

export const StatsTokensCommand = effectCmd({
  command: "tokens",
  aliases: ["token"],
  describe: false,
  builder: withTimelineOptions,
  handler: Effect.fn("Cli.stats.tokens")(function* (args: TimelineArgs) {
    console.log(renderTimeline(yield* loadReport(args), { ...renderOptions(args), metric: "tokens" }))
  }),
})

export const StatsInsightsCommand = effectCmd({
  command: "insights",
  aliases: ["insight"],
  describe: "show trend insights, risks, recommendations, and outliers",
  builder: withInsightsOptions,
  handler: Effect.fn("Cli.stats.insights")(function* (args: InsightsArgs) {
    console.log(renderInsights(yield* loadReport(args), { color: colorMode(args.color), limit: args.limit, forecast: args.forecast }))
  }),
})

export const StatsForecastCommand = effectCmd({
  command: "forecast",
  aliases: ["run-rate"],
  describe: false,
  builder: withDetailOptions,
  handler: Effect.fn("Cli.stats.forecast")(function* (args: DetailArgs) {
    console.log(renderInsights(yield* loadReport(args), { color: colorMode(args.color), limit: args.limit, forecast: true }))
  }),
})

export const StatsCommand = effectCmd({
  command: "stats",
  describe: "show token usage and cost statistics",
  builder: (yargs: Argv) =>
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
      .option("tools", {
        describe: "shortcut to tool breakdown; optionally pass number of tools",
        type: "number",
      })
      .option("models", {
        describe: "shortcut to model breakdown; pass a number for top N",
      })
      .option("limit", {
        alias: "n",
        describe: "number of rows to show",
        type: "number",
      })
      .option("interactive", {
        alias: "i",
        describe: "cycle stats views with keyboard shortcuts",
        type: "boolean",
        default: false,
      })
      .check(validateStatsArgs)
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
    const limit = args.models === true ? Number.POSITIVE_INFINITY : modelLimit(args.models) ?? args.limit
    if (args.interactive) {
      const reports = yield* interactiveReports(args)
      yield* runInteractiveDashboard(reports, { ...args, limit })
      return
    }
    if (args.tools !== undefined) {
      console.log(renderBreakdown(yield* loadReport(args), { color: colorMode(args.color), limit: args.tools, by: "tool" }))
      return
    }
    if (args.models !== undefined) {
      console.log(renderBreakdown(yield* loadReport(args), { color: colorMode(args.color), limit, by: "model" }))
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
          { name: "breakdown", render: (report: StatsReport) => renderBreakdown(report, { color: colorMode(args.color), limit: args.limit, by: "model" }) },
          { name: "timeline", render: (report: StatsReport) => renderTimeline(report, { color: colorMode(args.color), limit: 30 }) },
          { name: "sessions", render: (report: StatsReport) => renderSessions(report, { color: colorMode(args.color), limit: args.limit }) },
          { name: "insights", render: (report: StatsReport) => renderInsights(report, { color: colorMode(args.color), limit: args.limit }) },
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
