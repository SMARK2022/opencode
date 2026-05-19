import type { Argv } from "yargs"
import { Effect } from "effect"
import { cmd } from "./cmd"
import { effectCmd, fail } from "../effect-cmd"
import { Session } from "@/session/session"
import { SessionID } from "../../session/schema"
import { UI } from "../ui"
import { Locale } from "@/util/locale"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Filesystem } from "@/util/filesystem"
import { Process } from "@/util/process"
import { NotFoundError } from "@/storage/storage"
import { EOL } from "os"
import path from "path"
import { which } from "../../util/which"
import { AppRuntime } from "@/effect/app-runtime"
import { Database, eq, sql } from "@/storage"
import { RequestUsageAssistantTable, RequestUsageTable } from "@/session/request-usage.sql"
import { formatNumber } from "../format"
import { Instance } from "@/project/instance"
import { SessionPath } from "@/session/path"

const MICROS = 1_000_000

function pagerCmd(): string[] {
  const lessOptions = ["-R", "-S"]
  if (process.platform !== "win32") {
    return ["less", ...lessOptions]
  }

  const lessOnPath = which("less")
  if (lessOnPath) {
    if (Filesystem.stat(lessOnPath)?.size) return [lessOnPath, ...lessOptions]
  }

  if (Flag.OPENCODE_GIT_BASH_PATH) {
    const less = path.join(Flag.OPENCODE_GIT_BASH_PATH, "..", "..", "usr", "bin", "less.exe")
    if (Filesystem.stat(less)?.size) return [less, ...lessOptions]
  }

  const git = which("git")
  if (git) {
    const less = path.join(git, "..", "..", "usr", "bin", "less.exe")
    if (Filesystem.stat(less)?.size) return [less, ...lessOptions]
  }

  return ["cmd", "/c", "more"]
}

export const SessionCommand = cmd({
  command: "session",
  describe: "manage sessions",
  builder: (yargs: Argv) =>
    yargs.command(SessionListCommand).command(SessionInfoCommand).command(SessionDeleteCommand).demandCommand(),
  async handler() {},
})

export const SessionDeleteCommand = effectCmd({
  command: "delete <sessionID>",
  describe: "delete a session",
  builder: (yargs) =>
    yargs.positional("sessionID", {
      describe: "session ID to delete",
      type: "string",
      demandOption: true,
    }),
  handler: Effect.fn("Cli.session.delete")(function* (args) {
    const svc = yield* Session.Service
    const sessionID = SessionID.make(args.sessionID)
    yield* svc
      .remove(sessionID)
      .pipe(Effect.catchIf(NotFoundError.isInstance, () => fail(`Session not found: ${args.sessionID}`)))
    UI.println(UI.Style.TEXT_SUCCESS_BOLD + `Session ${args.sessionID} deleted` + UI.Style.TEXT_NORMAL)
  }),
})

export const SessionListCommand = effectCmd({
  command: "list",
  describe: "list sessions",
  builder: (yargs) =>
    yargs
      .option("max-count", {
        alias: "n",
        describe: "limit to N most recent sessions",
        type: "number",
      })
      .option("format", {
        describe: "output format",
        type: "string",
        choices: ["table", "json"],
        default: "table",
      })
      .option("cost", {
        alias: "c",
        describe: "show token and cost summary per session",
        type: "boolean",
        default: false,
      }),
  handler: Effect.fn("Cli.session.list")(function* (args) {
    const sessions = yield* Session.Service.use((svc) =>
      svc.list({
        directory: Instance.directory,
        path: SessionPath.relative(Instance.worktree, Instance.directory),
        roots: true,
        limit: args.maxCount,
      }),
    )

    if (sessions.length === 0) return

    // Batch-load cost/token totals if requested.
    let costBySession: Map<string, { costMicros: number; tokensTotal: number }> | undefined
    if (args.cost && args.format !== "json") {
      const rows = Database.use((db) =>
        db
          .select({
            sessionId: RequestUsageTable.session_id,
            costMicros: sql<number>`sum(${RequestUsageTable.cost_micros})`,
            tokensTotal: sql<number>`sum(${RequestUsageTable.tokens_total})`,
          })
          .from(RequestUsageTable)
          .groupBy(RequestUsageTable.session_id)
          .all(),
      )
      costBySession = new Map(rows.map((r) => [r.sessionId, { costMicros: r.costMicros, tokensTotal: r.tokensTotal }]))
    }

    const output = args.format === "json" ? formatSessionJSON(sessions) : formatSessionTable(sessions, costBySession)

    const shouldPaginate = process.stdout.isTTY && !args.maxCount && args.format === "table"

    if (shouldPaginate) {
      yield* Effect.promise(async () => {
        const proc = Process.spawn(pagerCmd(), {
          stdin: "pipe",
          stdout: "inherit",
          stderr: "inherit",
        })

        if (!proc.stdin) {
          console.log(output)
          return
        }

        proc.stdin.write(output)
        proc.stdin.end()
        await proc.exited
      })
    } else {
      console.log(output)
    }
  }),
})

export const SessionInfoCommand = effectCmd({
  command: "info",
  describe: "show detailed session info with token usage by model",
  builder: (yargs: Argv) => {
    return yargs.option("session", {
      alias: "s",
      describe: "session ID",
      type: "string",
      demandOption: true,
    })
  },
  handler: Effect.fn("Cli.session.info")(function* (args) {
    const sessionID = SessionID.make(args.session)
    const session = yield* Session.Service.use((svc) =>
      svc.get(sessionID).pipe(
        Effect.catchIf(NotFoundError.isInstance, () => fail(`Session not found: ${args.session}`)),
      ),
    )

    // Per-model breakdown from request_usage_assistant.
    const rows = Database.use((db) =>
      db
        .select({
          providerId: RequestUsageAssistantTable.provider_id,
          modelId: RequestUsageAssistantTable.model_id,
          calls: sql<number>`count(*)`,
          tokensInput: sql<number>`sum(${RequestUsageAssistantTable.tokens_input})`,
          tokensOutput: sql<number>`sum(${RequestUsageAssistantTable.tokens_output})`,
          tokensReasoning: sql<number>`sum(${RequestUsageAssistantTable.tokens_reasoning})`,
          tokensCacheRead: sql<number>`sum(${RequestUsageAssistantTable.tokens_cache_read})`,
          tokensCacheWrite: sql<number>`sum(${RequestUsageAssistantTable.tokens_cache_write})`,
          costMicros: sql<number>`sum(${RequestUsageAssistantTable.cost_micros})`,
        })
        .from(RequestUsageAssistantTable)
        .where(eq(RequestUsageAssistantTable.session_id, sessionID))
        .groupBy(RequestUsageAssistantTable.provider_id, RequestUsageAssistantTable.model_id)
        .all(),
    )

    displaySessionInfo(session, rows)
  }),
})

function formatSessionTable(
  sessions: Session.Info[],
  costBySession?: Map<string, { costMicros: number; tokensTotal: number }>,
): string {
  const lines: string[] = []

  const maxIdWidth = Math.max(20, ...sessions.map((s) => s.id.length))
  const maxTitleWidth = Math.max(25, ...sessions.map((s) => s.title.length))

  if (costBySession) {
    const header = `Session ID${" ".repeat(maxIdWidth - 10)}  Title${" ".repeat(maxTitleWidth - 5)}  Updated              Cost      Tokens`
    lines.push(header)
    lines.push("─".repeat(header.length))
    for (const session of sessions) {
      const truncatedTitle = Locale.truncate(session.title, maxTitleWidth)
      const timeStr = Locale.todayTimeOrDateTime(session.time.updated)
      const usage = costBySession.get(session.id)
      const costStr = usage ? `$${(usage.costMicros / MICROS).toFixed(3)}` : "—"
      const tokensStr = usage ? formatNumber(usage.tokensTotal) : "—"
      lines.push(
        `${session.id.padEnd(maxIdWidth)}  ${truncatedTitle.padEnd(maxTitleWidth)}  ${timeStr.padEnd(20)} ${costStr.padStart(8)}  ${tokensStr.padStart(7)}`,
      )
    }
  } else {
    const header = `Session ID${" ".repeat(maxIdWidth - 10)}  Title${" ".repeat(maxTitleWidth - 5)}  Updated`
    lines.push(header)
    lines.push("─".repeat(header.length))
    for (const session of sessions) {
      const truncatedTitle = Locale.truncate(session.title, maxTitleWidth)
      const timeStr = Locale.todayTimeOrDateTime(session.time.updated)
      lines.push(`${session.id.padEnd(maxIdWidth)}  ${truncatedTitle.padEnd(maxTitleWidth)}  ${timeStr}`)
    }
  }

  return lines.join(EOL)
}

function formatSessionJSON(sessions: Session.Info[]): string {
  const jsonData = sessions.map((session) => ({
    id: session.id,
    title: session.title,
    updated: session.time.updated,
    created: session.time.created,
    projectId: session.projectID,
    directory: session.directory,
  }))
  return JSON.stringify(jsonData, null, 2)
}

type ModelRow = {
  providerId: string
  modelId: string
  calls: number
  tokensInput: number
  tokensOutput: number
  tokensReasoning: number
  tokensCacheRead: number
  tokensCacheWrite: number
  costMicros: number
}

function displaySessionInfo(session: Session.Info, rows: ModelRow[]) {
  const width = 56

  function renderRow(label: string, value: string): string {
    const paddingNeeded = width - 1 - label.length - value.length
    return `│${label}${" ".repeat(Math.max(0, paddingNeeded))}${value} │`
  }

  console.log(`Session: ${session.id}`)
  console.log(`Title:   ${session.title}`)
  console.log(`Created: ${new Date(session.time.created).toLocaleString()}`)
  console.log(`Updated: ${new Date(session.time.updated).toLocaleString()}`)
  console.log()

  if (rows.length === 0) {
    console.log("No token usage data (session predates tracking or has no completions).")
    return
  }

  let totalCalls = 0
  let totalInput = 0
  let totalOutput = 0
  let totalCacheRead = 0
  let totalCacheWrite = 0
  let totalCost = 0

  console.log("┌────────────────────────────────────────────────────────┐")
  console.log("│                   TOKEN USAGE BY MODEL                 │")
  console.log("├────────────────────────────────────────────────────────┤")

  for (const row of rows) {
    const output = row.tokensOutput + row.tokensReasoning
    const cost = row.costMicros / MICROS
    const modelKey = `${row.providerId}/${row.modelId}`
    console.log(`│ ${modelKey.slice(0, 54).padEnd(54)} │`)
    console.log(renderRow("  Calls", String(row.calls)))
    console.log(renderRow("  Input", formatNumber(row.tokensInput)))
    console.log(renderRow("  Cache Write", formatNumber(row.tokensCacheWrite)))
    console.log(renderRow("  Cache Read", formatNumber(row.tokensCacheRead)))
    console.log(renderRow("  Output", formatNumber(output)))
    console.log(renderRow("  Cost", `$${cost.toFixed(4)}`))
    console.log("├────────────────────────────────────────────────────────┤")

    totalCalls += row.calls
    totalInput += row.tokensInput
    totalOutput += output
    totalCacheRead += row.tokensCacheRead
    totalCacheWrite += row.tokensCacheWrite
    totalCost += cost
  }

  if (rows.length > 1) {
    console.log(renderRow("Total Calls", String(totalCalls)))
    console.log(renderRow("Total Input", formatNumber(totalInput)))
    console.log(renderRow("Total Cache Write", formatNumber(totalCacheWrite)))
    console.log(renderRow("Total Cache Read", formatNumber(totalCacheRead)))
    console.log(renderRow("Total Output", formatNumber(totalOutput)))
    console.log(renderRow("Total Cost", `$${totalCost.toFixed(4)}`))
    console.log("├────────────────────────────────────────────────────────┤")
  }

  process.stdout.write("\x1B[1A")
  console.log("└────────────────────────────────────────────────────────┘")
}
