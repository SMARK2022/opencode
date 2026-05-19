// #174：从 format 导入 formatNumber 解环
import type { Argv } from "yargs"
import { Effect } from "effect"
import { cmd } from "./cmd"
import { effectCmd, fail } from "../effect-cmd"
import { SessionPath } from "@opencode-ai/core/session/path"
import { Session } from "@/session/session"
import * as InstanceState from "@/effect/instance-state"
import { SessionID } from "../../session/schema"
import { UI } from "../ui"
import { Locale } from "@/util/locale"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Filesystem } from "@/util/filesystem"
import { Process } from "@/util/process"
import { NotFoundError } from "@/storage/storage"
import { EOL } from "os"
import path from "path"
import { which } from "@opencode-ai/core/util/which"
import { Database } from "@opencode-ai/core/database/database"
import { sql } from "drizzle-orm"
import { RequestUsageTable, RequestUsageAssistantTable } from "@opencode-ai/core/session/request-usage.sql"
import { formatNumber } from "../format"

// CLI 复用 source 的微美元存储单位，不能按微美分换算而放大费用。
const MICROS = 1_000_000

function pagerCmd(): string[] {
  const lessOptions = ["-R", "-S"]
  if (process.platform !== "win32") {
    return ["less", ...lessOptions]
  }

  // user could have less installed via other options
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

  // Fall back to Windows built-in more (via cmd.exe)
  return ["cmd", "/c", "more"]
}

export const SessionCommand = cmd({
  command: "session",
  describe: "manage sessions",
  builder: (yargs: Argv) => yargs.command(SessionListCommand).command(SessionInfoCommand).command(SessionDeleteCommand).demandCommand(),
  async handler() {},
})

// 会话详情命令保留 source 的参数与模型明细展示，使用 Effect 服务访问持久化用量。
export const SessionInfoCommand = effectCmd({
  command: "info",
  describe: "show detailed session info with token usage by model",
  builder: (yargs) => yargs
    .option("session", { alias: "s", describe: "session ID", type: "string", demandOption: true }),
  handler: Effect.fn("Cli.session.info")(function* (args) {
    // 保留原入口 --session/-s；让 builder 推导字符串，避免断言掩盖参数契约。
    const sessionID = SessionID.make(args.session)
    const session = yield* Session.Service.use((svc) => svc.get(sessionID)).pipe(
      Effect.catchIf(NotFoundError.isInstance, () => { UI.error(`Session not found: ${args.session}`); return fail(`Session not found: ${args.session}`) }),
    )
    const { db } = yield* Database.Service
    // 模型分组只影响展示，calls 仍按助手明细行计数而不是按分组数计数。
    const rows = yield* db.select({
      providerId: RequestUsageAssistantTable.provider_id, modelId: RequestUsageAssistantTable.model_id,
      calls: sql<number>`count(*)`, inputTokens: sql<number>`sum(${RequestUsageAssistantTable.tokens_input})`,
      cacheWrite: sql<number>`sum(${RequestUsageAssistantTable.tokens_cache_write})`, cacheRead: sql<number>`sum(${RequestUsageAssistantTable.tokens_cache_read})`,
      outputTokens: sql<number>`sum(${RequestUsageAssistantTable.tokens_output})`,
      reasoningTokens: sql<number>`sum(${RequestUsageAssistantTable.tokens_reasoning})`, costMicros: sql<number>`sum(${RequestUsageAssistantTable.cost_micros})`,
    }).from(RequestUsageAssistantTable).where(sql`${RequestUsageAssistantTable.session_id} = ${sessionID}`)
      .groupBy(RequestUsageAssistantTable.provider_id, RequestUsageAssistantTable.model_id).all().pipe(Effect.orDie)
    // 命令详情使用已持久化模型明细；不调用模型也不从当前 provider 配置反推历史费用。
    displaySessionInfo(session, rows.map(r => ({
      providerId: r.providerId, modelId: r.modelId, calls: r.calls,
      tokensInput: r.inputTokens, tokensOutput: r.outputTokens, tokensReasoning: r.reasoningTokens,
      tokensCacheRead: r.cacheRead, tokensCacheWrite: r.cacheWrite, costMicros: r.costMicros,
    })))
  }),
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
      // 默认不查账本，--cost 只扩展表格输出，JSON 保留既有字段契约。
    .option("cost", { alias: "c", describe: "show token and cost summary per session", type: "boolean", default: false })
    .option("format", {
        describe: "output format",
        type: "string",
        choices: ["table", "json"],
        default: "table",
      }),
  handler: Effect.fn("Cli.session.list")(function* (args) {
    // #143：列表按实例目录相对 path 过滤，含父路径会话
    const instance = yield* InstanceState.context
    const sessions = yield* Session.Service.use((svc) =>
      svc.list({
        roots: true,
        limit: args.maxCount,
        directory: instance.directory,
        path: SessionPath.relative(instance.worktree, instance.directory),
      }),
    )

    if (sessions.length === 0) return

    // 请求汇总用于 source 的追踪列表，不能替代 stats 的完整 Session 计费。
    let costBySession: Map<string, { costMicros: number; tokensTotal: number }> | undefined
    if (args.cost && args.format !== "json") {
      const { db } = yield* Database.Service
      const costRows = yield* db.select({ sessionId: RequestUsageTable.session_id, costMicros: sql<number>`sum(${RequestUsageTable.cost_micros})`, tokensTotal: sql<number>`sum(${RequestUsageTable.tokens_total})` }).from(RequestUsageTable).groupBy(RequestUsageTable.session_id).all().pipe(Effect.orDie)
      costBySession = new Map(costRows.map((r) => [r.sessionId, { costMicros: r.costMicros, tokensTotal: r.tokensTotal }]))
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

// 模型详情是 source 的显式请求明细视图，历史没有跟踪行时不能伪造精确分组。
function displaySessionInfo(session: Session.Info, rows: ModelRow[]): void {
  const width = 56

  // 超长模型或数字保持可输出，padding 不能为负导致 CLI 直接抛错。
  function renderRow(label: string, value: string): string {
    const paddingNeeded = width - 1 - label.length - value.length
    return `│${label}${" ".repeat(Math.max(0, paddingNeeded))}${value} │`
  }

  console.log(`Session: ${session.id}`)
  console.log(`Title:   ${session.title}`)
  console.log(`Created: ${new Date(session.time.created).toLocaleString()}`)
  console.log(`Updated: ${new Date(session.time.updated).toLocaleString()}`)
  console.log()

  // 没有跟踪行与真实零用量不同，保留 source 的历史提示而不输出虚假的零计费模型。
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

  console.log("┌" + "─".repeat(width) + "┐")
  console.log("│                   TOKEN USAGE BY MODEL                 │")
  console.log("├" + "─".repeat(width) + "┤")

  for (const row of rows) {
    // CLI 的展示输出把 reasoning 并入 output，但存储与 API 继续分列保存。
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
    console.log("├" + "─".repeat(width) + "┤")

    totalCalls += row.calls
    totalInput += row.tokensInput
    totalOutput += output
    totalCacheRead += row.tokensCacheRead
    totalCacheWrite += row.tokensCacheWrite
    totalCost += cost
  }

  // 多模型总计仅累加各模型明细一次，不能再把请求汇总叠加进展示总额。
  if (rows.length > 1) {
    console.log(renderRow("Total Calls", String(totalCalls)))
    console.log(renderRow("Total Input", formatNumber(totalInput)))
    console.log(renderRow("Total Cache Write", formatNumber(totalCacheWrite)))
    console.log(renderRow("Total Cache Read", formatNumber(totalCacheRead)))
    console.log(renderRow("Total Output", formatNumber(totalOutput)))
    console.log(renderRow("Total Cost", `$${totalCost.toFixed(4)}`))
    console.log("├" + "─".repeat(width) + "┤")
  }

  // source 的最后分隔线由底边替换，不能再输出一条分隔线造成每次模型统计多一行。
  process.stdout.write("\x1B[1A")
  console.log("└" + "─".repeat(width) + "┘")
}

function formatSessionTable(sessions: Session.Info[], costBySession?: Map<string, { costMicros: number; tokensTotal: number }>): string {
  const lines: string[] = []
  // 空 Map 也表示用户显式请求费用列，不能以是否存在计费记录决定隐藏表头。
  const showCost = !!costBySession

  const maxIdWidth = Math.max(20, ...sessions.map((s) => s.id.length))
  const maxTitleWidth = Math.max(25, ...sessions.map((s) => s.title.length))

  const header = showCost
    ? `Session ID${" ".repeat(maxIdWidth - 10)}  Title${" ".repeat(maxTitleWidth - 5)}  Updated          Cost        Tokens`
    : `Session ID${" ".repeat(maxIdWidth - 10)}  Title${" ".repeat(maxTitleWidth - 5)}  Updated`
  lines.push(header)
  lines.push("─".repeat(header.length))
  for (const session of sessions) {
    const truncatedTitle = Locale.truncate(session.title, maxTitleWidth)
    const timeStr = Locale.todayTimeOrDateTime(session.time.updated)
    if (showCost) {
      // 缺失记录显示占位，已跟踪但尚未执行的零值不能被当作缺失。
      const cost = costBySession?.get(session.id)
      const costStr = cost ? `$${(cost.costMicros / MICROS).toFixed(3)}` : "—"
      const tokensStr = cost ? formatNumber(cost.tokensTotal) : "—"
      lines.push(`${session.id.padEnd(maxIdWidth)}  ${truncatedTitle.padEnd(maxTitleWidth)}  ${timeStr.padEnd(16)}  ${costStr.padStart(10)}  ${tokensStr.padStart(12)}`)
    } else {
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
