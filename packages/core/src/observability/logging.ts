import { Formatter, Logger, Schema, type LogLevel } from "effect"
import fs from "fs"
import path from "path"
import { Global } from "../global"
import { runID } from "./shared"

function formatter(id: string = runID) {
  return Logger.map(Logger.formatStructured, (output) => {
    const messages = Array.isArray(output.message) ? output.message : [output.message]
    return [
      ["timestamp", output.timestamp],
      ["level", output.level],
      ["run", id],
      ...messages.flatMap((value) => (plain(value) ? flatten(value) : [["message", value] as const])),
      ...(output.cause === undefined ? [] : [["cause", output.cause] as const]),
      ...flatten(output.spans),
      ...flatten(output.annotations),
    ]
      .map(([key, value]) => `${key}=${format(value)}`)
      .join(" ")
  })
}

function flatten(
  input: Record<string, unknown>,
  prefix = "",
  seen = new WeakSet<object>(),
): Array<readonly [string, unknown]> {
  if (seen.has(input)) return [[prefix, "[Circular]"]]
  seen.add(input)
  const entries = Object.entries(input)
  if (entries.length === 0 && prefix) return [[prefix, input]]
  return entries.flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key
    return plain(value) ? flatten(value, path, seen) : [[path, value] as const]
  })
}

function plain(input: unknown): input is Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return false
  const prototype = Object.getPrototypeOf(input)
  return prototype === Object.prototype || prototype === null
}

function format(input: unknown) {
  const value = typeof input === "string" ? input : Formatter.format(input)
  return /^[^\s="\\]+$/.test(value) ? value : JSON.stringify(value)
}

// Source 0321 snapshots the log directory into a local variable before any async work and
// self-heals a missing directory, guarding against Global.Path.log being swapped mid-run.
// The Effect-based fileLogger here captures `file` eagerly at call time and Logger.toFile is a
// pure Effect with no mutable stream/logpath state, so the same race cannot occur; the
// directory self-heal itself was already ported by source 0304's makeDirectory adaptation.
export function fileLogger(file = path.join(Global.Path.log, "opencode.log"), id: string = runID) {
  // Do not set batchWindow to 0; it causes high idle CPU usage.
  // #304：测试会把 Global.Path.log 临时切到 scoped tmpdir，生产环境用户也可能删除日志目录；
  // Logger.toFile 不自建目录，打开前先自愈，日志失败不能污染业务流程。
  fs.mkdirSync(path.dirname(file), { recursive: true })
  return Logger.toFile(formatter(id), file, { flag: "a" })
}

const stderrLogger = Logger.make((options) => process.stderr.write(formatter().log(options) + "\n"))

export function minimumLogLevel() {
  const value = process.env.OPENCODE_LOG_LEVEL?.toUpperCase()
  const levels = {
    DEBUG: "Debug",
    INFO: "Info",
    WARN: "Warn",
    ERROR: "Error",
  } as const satisfies Record<string, LogLevel.LogLevel>
  return value && value in levels ? levels[value as keyof typeof levels] : levels.INFO
}

export function loggers() {
  return process.env.OPENCODE_PRINT_LOGS === "1" ? [fileLogger(), stderrLogger] : [fileLogger()]
}

// 仅治理daemon-native证据，不改变scoped文件logger、普通日志保留或关闭时flush的目标合同。
export async function cleanupDaemonNative(dir = Global.Path.log) {
  const since = Date.now() - 24 * 60 * 60 * 1000
  // daemon-native 诊断目录与普通日志同治理：活跃目录保留；完成目录保留最新10个或24h窗口；
  // start-only 且进程已死且超窗的目录是 wrapper 夭折残留，删除。
  const native = path.join(dir, "daemon-native")
  const names = (await fs.promises.readdir(native, { withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
  const decode = Schema.decodeUnknownSync(
    Schema.Struct({
      workerPID: Schema.optional(Schema.Number),
      wrapperPID: Schema.optional(Schema.Number),
      exitedAt: Schema.optional(Schema.String),
    }),
  )
  const runs = (
    await Promise.all(
      names.map(async (name) => {
        const full = path.join(native, name)
        const file = path.join(full, "lifecycle.json")
        const record = await Bun.file(file)
          .json()
          .then(decode)
          .catch(() => undefined)
        // 已有记录暂不可读时无法确认owner死亡，不能按无记录孤儿删除正在更新的证据。
        if (!record && (await Bun.file(file).exists())) return
        // worker或supervisor尚活时均保留；PID复用只会多保留证据，不会误删。
        const active = [record?.workerPID, record?.wrapperPID].some((pid) => {
          if (pid === undefined) return false
          try {
            process.kill(pid, 0)
            return true
          } catch {
            return false
          }
        })
        if (active) return
        // 无记录目录包含启动中间态；用目录年龄保护它，不能把缺记录当作时间零。
        const stat = await fs.promises.stat(record ? file : full).catch(() => undefined)
        return { full, mtime: stat?.mtimeMs ?? Date.now(), exited: record?.exitedAt !== undefined }
      }),
    )
  )
    .filter((run) => run !== undefined)
    .sort((a, b) => b.mtime - a.mtime)
  const retained = new Set(runs.filter((run) => run.exited).slice(0, 10))
  await Promise.all(
    runs.map(async (run) => {
      if (run.mtime > since || retained.has(run)) return
      await fs.promises.rm(run.full, { recursive: true, force: true }).catch(() => {})
    }),
  )
}

export * as Logging from "./logging"
