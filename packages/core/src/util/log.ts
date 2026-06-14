export * as Log from "./log"

import path from "path"
import fs from "fs/promises"
import { createWriteStream } from "fs"
import * as Global from "../global"
import { Schema } from "effect"
import { Glob } from "./glob"

export const Level = Schema.Literals(["DEBUG", "INFO", "WARN", "ERROR"]).annotate({
  identifier: "LogLevel",
  description: "Log level",
})
export type Level = Schema.Schema.Type<typeof Level>

const levelPriority: Record<Level, number> = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
}
const keep = 10
const initializedRunID = "OPENCODE_LOG_INITIALIZED_RUN_ID"

let level: Level = "INFO"

function shouldLog(input: Level): boolean {
  return levelPriority[input] >= levelPriority[level]
}

export type Logger = {
  debug(message?: any, extra?: Record<string, any>): void
  info(message?: any, extra?: Record<string, any>): void
  error(message?: any, extra?: Record<string, any>): void
  warn(message?: any, extra?: Record<string, any>): void
  tag(key: string, value: string): Logger
  clone(): Logger
  time(
    message: string,
    extra?: Record<string, any>,
  ): {
    stop(): void
    [Symbol.dispose](): void
  }
}

const loggers = new Map<string, Logger>()

export const Default = create({ service: "default" })

export interface Options {
  print: boolean
  dev?: boolean
  level?: Level
}

let logpath = ""
export function file() {
  return logpath
}
let stream: ReturnType<typeof createWriteStream> | undefined
const writeStderr = (msg: any) => {
  process.stderr.write(msg)
  return msg.length
}
let write = writeStderr

export async function init(options: Options) {
  if (options.level) level = options.level
  void cleanup(Global.Path.log)
  stream?.destroy()
  stream = undefined
  if (options.print) {
    // print=true 表示恢复到 stderr；不能继续持有上一次 dev log 的 writer，
    // 否则测试或重初始化后仍可能写入已经被清理的临时日志文件。
    write = writeStderr
    return
  }
  // Global.Path.log 在测试中会临时切到 scoped tmpdir，生产环境下用户也可能
  // 删除日志目录；init() 必须自愈目录，日志失败不能污染业务流程。
  await fs.mkdir(Global.Path.log, { recursive: true }).catch(() => {})
  logpath = path.join(
    Global.Path.log,
    options.dev ? "dev.log" : new Date().toISOString().split(".")[0].replace(/:/g, "") + ".log",
  )
  const runID = process.env.OPENCODE_RUN_ID
  const shouldTruncate = !options.dev || !runID || process.env[initializedRunID] !== runID
  if (shouldTruncate) await fs.truncate(logpath).catch(() => {})
  if (options.dev && runID) process.env[initializedRunID] = runID
  const current = createWriteStream(logpath, { flags: "a" })
  stream = current
  current.on("error", () => {
    // 日志输出是诊断辅助通道，不能因为目录被删除或句柄被系统回收而让
    // 调用方出现 unhandled error；下一次 init() 会重新创建可写目标。
  })
  write = async (msg: any) => {
    if (current.destroyed || current.closed || !current.writable) return 0
    return new Promise((resolve) => {
      try {
        current.write(msg, (err) => {
          resolve(err ? 0 : msg.length)
        })
      } catch {
        resolve(0)
      }
    })
  }
}

async function cleanup(dir: string) {
  const files = (
    await Glob.scan("????-??-??T??????.log", {
      cwd: dir,
      absolute: false,
      include: "file",
    }).catch(() => [])
  )
    .filter((file) => path.basename(file) === file)
    .sort()
  if (files.length <= keep) return

  const doomed = files.slice(0, -keep)
  await Promise.all(doomed.map((file) => fs.unlink(path.join(dir, file)).catch(() => {})))
}

function formatError(error: Error, depth = 0): string {
  const result = error.message
  return error.cause instanceof Error && depth < 10
    ? result + " Caused by: " + formatError(error.cause, depth + 1)
    : result
}

let last = Date.now()
export function create(tags?: Record<string, any>) {
  tags = tags || {}

  const service = tags["service"]
  if (service && typeof service === "string") {
    const cached = loggers.get(service)
    if (cached) {
      return cached
    }
  }

  function build(message: any, extra?: Record<string, any>) {
    const prefix = Object.entries({
      ...tags,
      ...extra,
    })
      .filter(([_, value]) => value !== undefined && value !== null)
      .map(([key, value]) => {
        const prefix = `${key}=`
        if (value instanceof Error) return prefix + formatError(value)
        if (typeof value === "object") return prefix + JSON.stringify(value)
        return prefix + value
      })
      .join(" ")
    const next = new Date()
    const diff = next.getTime() - last
    last = next.getTime()
    return [next.toISOString().split(".")[0], "+" + diff + "ms", prefix, message].filter(Boolean).join(" ") + "\n"
  }
  const result: Logger = {
    debug(message?: any, extra?: Record<string, any>) {
      if (shouldLog("DEBUG")) {
        write("DEBUG " + build(message, extra))
      }
    },
    info(message?: any, extra?: Record<string, any>) {
      if (shouldLog("INFO")) {
        write("INFO  " + build(message, extra))
      }
    },
    error(message?: any, extra?: Record<string, any>) {
      if (shouldLog("ERROR")) {
        write("ERROR " + build(message, extra))
      }
    },
    warn(message?: any, extra?: Record<string, any>) {
      if (shouldLog("WARN")) {
        write("WARN  " + build(message, extra))
      }
    },
    tag(key: string, value: string) {
      if (tags) tags[key] = value
      return result
    },
    clone() {
      return create({ ...tags })
    },
    time(message: string, extra?: Record<string, any>) {
      const now = Date.now()
      result.info(message, { status: "started", ...extra })
      function stop() {
        result.info(message, {
          status: "completed",
          duration: Date.now() - now,
          ...extra,
        })
      }
      return {
        stop,
        [Symbol.dispose]() {
          stop()
        },
      }
    },
  }

  if (service && typeof service === "string") {
    loggers.set(service, result)
  }

  return result
}
