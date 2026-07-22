import type { Argv } from "yargs"
import { spawn } from "child_process"
import { Database } from "@/storage/db"
import { drizzle } from "drizzle-orm/bun-sqlite"
import { Database as BunDatabase } from "bun:sqlite"
import { UI } from "../ui"
import { cmd } from "./cmd"
import { JsonMigration } from "@/storage/json-migration"
import { EOL } from "os"
import { errorMessage } from "../../util/error"
import { ColdStorage } from "@/storage/cold"
import { ServerLock } from "./tui/server-lock"
import path from "path"
import { SessionID } from "@/session/schema"

class MaintenanceUnavailableError extends Error {}

// duration parser 只接受带单位的完整字符串，裸数字不能被不同调用层解释成秒或毫秒。
// 结果统一为毫秒后进入 ColdStorage request，resume 则始终复用持久化后的数值。
// 使用显式 switch 保持单位集合可穷尽，避免索引任意字符串绕过类型和范围验证。
function durationMs(value: string) {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d|w)$/.exec(value.trim().toLowerCase())
  if (!match) throw new ColdStorage.ValidationError({ message: `Invalid duration: ${value}` })
  const amount = Number(match[1])
  const factor = (() => {
    switch (match[2]) {
      case "ms":
        return 1
      case "s":
        return 1_000
      case "m":
        return 60_000
      case "h":
        return 3_600_000
      case "d":
        return 86_400_000
      case "w":
        return 604_800_000
      default:
        throw new ColdStorage.ValidationError({ message: `Invalid duration unit: ${match[2]}` })
    }
  })()
  return amount * factor
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

// daemon 判定同时绑定 pid、dbPath 与私有 controlPort，不能把其他 channel 的 daemon 当作当前 DB owner。
// stale pid 只按 lock token 清理；live daemon 缺 controlPort 时拒绝 direct fallback，避免双 writer 竞争。
// 返回 undefined 只代表启动前已确定的 offline 域，后续 control 失败不会重新选择运行域。
async function liveDaemon() {
  const lock = await ServerLock.read()
  if (!lock) return
  if (path.resolve(lock.dbPath) !== path.resolve(Database.getPath())) return
  if (!ServerLock.alive(lock.pid)) {
    await ServerLock.clearIfOwner(lock.token)
    return
  }
  if (!lock.controlPort) throw new MaintenanceUnavailableError("Live daemon does not expose a maintenance control port")
  return lock
}

// control request 总是携带当前 lock token；短 timeout 只约束快速 control acknowledgement。
// 完整 status 扫描随数据库增长，显式 false 避免把合法长计算误报为 daemon 不可达。
// 非 2xx 响应保留 daemon 错误语义，调用方不得在失败后改走 offline 并伪造成功。
// 该 helper 只传输 request/result，不包含 operation SQL、eligibility 或 cursor 推进逻辑。
async function daemonRequest(lock: ServerLock.ServerLock, pathname: string, init?: RequestInit, timeoutMs: number | false = 2_000) {
  const response = await fetch(`http://127.0.0.1:${lock.controlPort}${pathname}`, {
    ...init,
    headers: {
      [ServerLock.CONTROL_TOKEN_HEADER]: lock.token,
      ...(init?.headers ?? {}),
    },
    // false 表示调用方已确认本地 daemon 身份，不再用固定 deadline 截断合法长计算。
    signal: timeoutMs === false ? undefined : AbortSignal.timeout(timeoutMs),
  })
  const body: unknown = await response.json().catch(() => ({ error: `daemon returned ${response.status}` }))
  if (!response.ok) {
    const error = isRecord(body) && typeof body.error === "string" ? body.error : `daemon returned ${response.status}`
    throw new MaintenanceUnavailableError(error)
  }
  return body
}

function printMaintenance(value: unknown) {
  UI.println(JSON.stringify(value, null, 2))
}

async function runOffline(prepared: ColdStorage.PreparedMaintenance) {
  if (prepared.type === "immediate") {
    if (prepared.request.operation !== "vacuum") return ColdStorage.maintain(prepared)
    const existing = await ServerLock.findNonterminalMaintenanceTask()
    if (existing) throw new ServerLock.MaintenanceBusyError(`Maintenance task already exists: ${existing.taskID}`)
    // vacuum 没有可恢复 cursor，但仍持有同一 maintenance lease，防止与 daemon/offline task 并行写入。
    // pseudo taskID 只标识 lease owner，不创建会误导 status/resume 的持久 task record。
    const lease = await ServerLock.acquireMaintenanceLease({ taskID: `vacuum_${crypto.randomUUID()}`, dbPath: Database.getPath() })
    try {
      return await ColdStorage.maintain(prepared, { lease, checkpoint: async () => {} })
    } finally {
      await lease.release()
    }
  }
  const existing = await ServerLock.findNonterminalMaintenanceTask()
  if (existing) throw new ServerLock.MaintenanceBusyError(`Maintenance task already exists: ${existing.taskID}`)
  // lease owner 先于 queued record 可见，status 不会把仍在启动的 offline task 误判为 interrupted。
  // queued 仍在第一批 DB transaction 前原子落盘；其后 crash 可由 cursor/owner reconcile 恢复。
  // checkpoint 和数据批次由同一 ColdStorage.maintain owner 推进，offline CLI 不复制状态机。
  const lease = await ServerLock.acquireMaintenanceLease(prepared.task)
  try {
    await ServerLock.writeMaintenanceTask(prepared.task)
    return await ColdStorage.maintain(prepared, {
      task: prepared.task,
      lease,
      checkpoint: (task) => ServerLock.writeMaintenanceTask(task),
    })
  } finally {
    await lease.release()
  }
}

// 执行域只在命令开始时选择一次：live daemon 只走 control，daemon 缺席才走同一 maintain 的 offline 入口。
// 两个域都先调用 prepareMaintenance，保证默认值、写授权、task 分类和错误类型完全一致。
// CLI 只渲染 task/report JSON，不等待 daemon 后台 task，也不把 disconnect 解释为 task failure。
async function executeMaintenance(request: ColdStorage.MaintenanceRequest) {
  const lock = await liveDaemon()
  if (lock) {
    const body = await daemonRequest(lock, ServerLock.CONTROL_MAINTENANCE_PATH, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    })
    printMaintenance(body)
    return
  }
  const result = await runOffline(ColdStorage.prepareMaintenance(request))
  printMaintenance(result.type === "task" ? result.task : result)
}

// resume 从持久 record 恢复 operation/args/cursor，用户不能借同一 taskID 改写 scope 或 batchSize。
// live daemon 负责 active lifecycle；offline 域则获取同一文件 lease并同步执行到 terminal checkpoint。
// queued/completed/failed/running 都拒绝显式 resume，只有 reconcile 后的 interrupted 是合法来源。
async function executeResume(taskID: string) {
  const lock = await liveDaemon()
  if (lock) {
    printMaintenance(
      await daemonRequest(lock, ServerLock.CONTROL_MAINTENANCE_RESUME_PATH, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ taskID }),
      }),
    )
    return
  }
  const task = await ServerLock.reconcileMaintenanceTask(taskID)
  if (!task) throw new ColdStorage.ValidationError({ message: `Maintenance task not found: ${taskID}` })
  if (task.status !== "interrupted") throw new ColdStorage.ValidationError({ message: `Maintenance task is ${task.status}` })
  const prepared = ColdStorage.prepareMaintenance(task.args)
  if (prepared.type !== "task") throw new ColdStorage.ValidationError({ message: "Task is not resumable" })
  const lease = await ServerLock.acquireMaintenanceLease(task)
  try {
    const result = await ColdStorage.maintain(prepared, {
      task,
      lease,
      checkpoint: (next) => ServerLock.writeMaintenanceTask(next),
    })
    printMaintenance(result.type === "task" ? result.task : result)
  } finally {
    await lease.release()
  }
}

// compress 默认只改变满足 30 天或 compact boundary 的白名单字段；--session 只是缩小 owner scope。
// batch 默认值来自本机 2.2 GB 实测，不在 CLI 复制魔法数字，daemon JSON 缺省也使用同一常量。
const CompressCommand = cmd({
  command: "compress",
  describe: "freeze eligible cold fields into the database cold store",
  builder: (yargs: Argv) =>
    yargs
      .option("session", { type: "string" })
      .option("older-than", { type: "string", default: "30d" })
      .option("batch-size", { type: "number", default: ColdStorage.DEFAULT_BATCH_SIZE }),
  handler: async (args: { session?: string; olderThan: string; batchSize: number }) => {
    await executeMaintenance({
      operation: "compress",
      ...(args.session ? { sessionID: SessionID.make(args.session) } : {}),
      olderThanMs: durationMs(args.olderThan),
      batchSize: args.batchSize,
    })
  },
})

// expand 反向回填完整热 JSON；全库操作必须同时给 --all 和 --yes，session scope 不需要全库确认。
// --all 与 --session 可以并存，但 session 仍限定范围，实际 normalization 由 ColdStorage owner 完成。
const ExpandCommand = cmd({
  command: "expand",
  describe: "thaw cold fields back into the primary tables",
  builder: (yargs: Argv) =>
    yargs.option("session", { type: "string" }).option("all", { type: "boolean", default: false }).option("yes", { type: "boolean", default: false }).option("batch-size", { type: "number", default: ColdStorage.DEFAULT_BATCH_SIZE }),
  handler: async (args: { session?: string; all: boolean; yes: boolean; batchSize: number }) => {
    if (!args.all && !args.session) throw new ColdStorage.ValidationError({ message: "expand requires --all or --session" })
    if (args.all && !args.yes) throw new ColdStorage.ValidationError({ message: "expand --all requires --yes" })
    await executeMaintenance({ operation: "expand", ...(args.session ? { sessionID: SessionID.make(args.session) } : {}), all: args.all, batchSize: args.batchSize })
  },
})

// status 无 task 时返回 DB metrics，带 task 时只查询持久 control record；两种语义不混入 daemon health。
// offline task 查询先 reconcile dead owner，使强制终止后的 running record 可立即显示 interrupted。
const StatusCommand = cmd({
  command: "status",
  describe: "show cold-storage metrics or a persisted task",
  builder: (yargs: Argv) => yargs.option("task", { type: "string" }),
  handler: async (args: { task?: string }) => {
    const lock = await liveDaemon()
    if (args.task) {
      if (lock) {
        printMaintenance(await daemonRequest(lock, `${ServerLock.CONTROL_MAINTENANCE_STATUS_PATH}?task=${encodeURIComponent(args.task)}`))
        return
      }
      const task = await ServerLock.reconcileMaintenanceTask(args.task)
      if (!task) throw new ColdStorage.ValidationError({ message: `Maintenance task not found: ${args.task}` })
      printMaintenance(task)
      return
    }
    if (lock) {
      // status 没有持久 task 结果可轮询，必须在同一 control 请求中等到完整 StatusReport。
      printMaintenance(
        await daemonRequest(
          lock,
          ServerLock.CONTROL_MAINTENANCE_PATH,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ operation: "status" }),
          },
          false,
        ),
      )
      return
    }
    printMaintenance(ColdStorage.status())
  },
})

// resume 是独立命令而非 compress/expand flag，避免新参数覆盖持久 task 的原始请求。
const ResumeCommand = cmd({
  command: "resume <taskID>",
  describe: "resume an interrupted cold-storage task",
  builder: (yargs: Argv) => yargs.positional("taskID", { type: "string", demandOption: true }),
  handler: async (args: { taskID: string }) => {
    await executeResume(args.taskID)
  },
})

// verify 默认只读完整性报告；--repair 才生成可恢复 task，并且只修正可证明的 ref_count。
const VerifyCommand = cmd({
  command: "verify",
  describe: "verify cold payload hashes and reference counts",
  builder: (yargs: Argv) => yargs.option("repair", { type: "boolean", default: false }).option("batch-size", { type: "number", default: ColdStorage.DEFAULT_BATCH_SIZE }),
  handler: async (args: { repair: boolean; batchSize: number }) => {
    await executeMaintenance({ operation: "verify", repair: args.repair, batchSize: args.batchSize })
  },
})

// cleanup 默认等价 dry-run，只有 --yes 且未显式 --dry-run 才授予 payload 删除权限。
// cleanup 不调用 VACUUM，用户可先核对 logical bytes，再单独决定物理页面回收。
const CleanupCommand = cmd({
  command: "cleanup",
  describe: "report or remove unreferenced cold payloads",
  builder: (yargs: Argv) => yargs.option("dry-run", { type: "boolean", default: false }).option("yes", { type: "boolean", default: false }).option("batch-size", { type: "number", default: ColdStorage.DEFAULT_BATCH_SIZE }),
  handler: async (args: { dryRun: boolean; yes: boolean; batchSize: number }) => {
    await executeMaintenance({ operation: "cleanup", delete: args.yes && !args.dryRun, batchSize: args.batchSize })
  },
})

// vacuum 是不可 resume 的 SQLite 原子操作，必须显式 --yes 并持有 maintenance lease。
// pages before/after 是唯一物理文件收益口径，不与 cold payload compressedBytes 混用。
const VacuumCommand = cmd({
  command: "vacuum",
  describe: "reclaim unused SQLite pages",
  builder: (yargs: Argv) => yargs.option("yes", { type: "boolean", default: false }),
  handler: async (args: { yes: boolean }) => {
    if (!args.yes) throw new ColdStorage.ValidationError({ message: "vacuum requires --yes" })
    await executeMaintenance({ operation: "vacuum", confirm: true })
  },
})

const QueryCommand = cmd({
  command: "$0 [query]",
  describe: "open an interactive sqlite3 shell or run a query",
  builder: (yargs: Argv) => {
    return yargs
      .positional("query", {
        type: "string",
        describe: "SQL query to execute",
      })
      .option("format", {
        type: "string",
        choices: ["json", "tsv"],
        default: "tsv",
        describe: "Output format",
      })
  },
  handler: async (args: { query?: string; format: string }) => {
    const query = args.query as string | undefined
    if (query) {
      const db = new BunDatabase(Database.getPath(), { readonly: true })
      try {
        const result = db.query(query).all() as Record<string, unknown>[]
        if (args.format === "json") {
          console.log(JSON.stringify(result, null, 2))
        } else if (result.length > 0) {
          const keys = Object.keys(result[0])
          console.log(keys.join("\t"))
          for (const row of result) {
            console.log(keys.map((k) => row[k]).join("\t"))
          }
        }
      } catch (err) {
        UI.error(errorMessage(err))
        process.exit(1)
      }
      db.close()
      return
    }
    const child = spawn("sqlite3", [Database.getPath()], {
      stdio: "inherit",
    })
    await new Promise((resolve) => child.on("close", resolve))
  },
})

const PathCommand = cmd({
  command: "path",
  describe: "print the database path",
  handler: () => {
    console.log(Database.getPath())
  },
})

const MigrateCommand = cmd({
  command: "migrate",
  describe: "migrate JSON data to SQLite (merges with existing data)",
  handler: async () => {
    const sqlite = new BunDatabase(Database.getPath())
    const tty = process.stderr.isTTY
    const width = 36
    const orange = "\x1b[38;5;214m"
    const muted = "\x1b[0;2m"
    const reset = "\x1b[0m"
    let last = -1
    if (tty) process.stderr.write("\x1b[?25l")
    try {
      const stats = await JsonMigration.run(drizzle({ client: sqlite }), {
        progress: (event) => {
          const percent = Math.floor((event.current / event.total) * 100)
          if (percent === last) return
          last = percent
          if (tty) {
            const fill = Math.round((percent / 100) * width)
            const bar = `${"■".repeat(fill)}${"･".repeat(width - fill)}`
            process.stderr.write(
              `\r${orange}${bar} ${percent.toString().padStart(3)}%${reset} ${muted}${event.current}/${event.total}${reset} `,
            )
          } else {
            process.stderr.write(`sqlite-migration:${percent}${EOL}`)
          }
        },
      })
      if (tty) process.stderr.write("\n")
      if (tty) process.stderr.write("\x1b[?25h")
      else process.stderr.write(`sqlite-migration:done${EOL}`)
      UI.println(
        `Migration complete: ${stats.projects} projects, ${stats.sessions} sessions, ${stats.messages} messages`,
      )
      if (stats.errors.length > 0) {
        UI.println(`${stats.errors.length} errors occurred during migration`)
      }
    } catch (err) {
      if (tty) process.stderr.write("\x1b[?25h")
      UI.error(`Migration failed: ${errorMessage(err)}`)
      process.exit(1)
    } finally {
      sqlite.close()
    }
  },
})

export const DbCommand = cmd({
  command: "db",
  describe: "database tools",
  builder: (yargs: Argv) => {
    return yargs
      .command(CompressCommand)
      .command(ExpandCommand)
      .command(StatusCommand)
      .command(ResumeCommand)
      .command(VerifyCommand)
      .command(CleanupCommand)
      .command(VacuumCommand)
      .command(QueryCommand)
      .command(PathCommand)
      .command(MigrateCommand)
      .demandCommand()
  },
  handler: () => {},
})
