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
let initID = 0
let fileInit = Promise.resolve()
let latestInit = Promise.resolve()
const writeStderr = (msg: any) => {
  process.stderr.write(msg)
  return msg.length
}
let write = writeStderr

export async function init(options: Options) {
  const id = ++initID
  const dir = Global.Path.log
  if (options.level) level = options.level
  void cleanup(dir)
  if (options.print) {
    // print 是即时控制分支：先使排队中的 file token 失效，不能等待文件 I/O。
    latestInit = Promise.resolve()
    const active = stream
    stream = undefined
    write = writeStderr
    active?.destroy()
    return
  }

  // 文件变更和 candidate 发布共享同一个 FIFO owner，旧 truncate 不能越过新调用。
  const predecessor = fileInit
  const slot = Promise.withResolvers<void>()
  fileInit = slot.promise
  latestInit = slot.promise
  const stale = await (async () => {
    await predecessor
    try {
      if (id !== initID) return true
      // Global.Path.log 可能指向刚被清理的目录；owner 必须先恢复目录再创建 stream。
      await fs.mkdir(dir, { recursive: true }).catch(() => {})
      if (id !== initID) return true
      const nextLogpath = path.join(
        dir,
        options.dev ? "dev.log" : new Date().toISOString().split(".")[0].replace(/:/g, "") + ".log",
      )
      const runID = process.env.OPENCODE_RUN_ID
      if (!options.dev || !runID || process.env[initializedRunID] !== runID) {
        await fs.truncate(nextLogpath).catch(() => {})
        if (id !== initID) return true
      }
      const current = createWriteStream(nextLogpath, { flags: "a" })
      current.on("error", () => {
        // 日志是诊断通道，stream 失败不能产生未处理异常；下一次 init 会重新建目标。
      })
      const ready = await new Promise<"open" | "error" | "close">((resolve) => {
        const finish = (state: "open" | "error" | "close") => {
          // 三个终止事件只完成一次，并移除其余 listener，避免竞态留下悬挂回调。
          current.off("open", onOpen)
          current.off("error", onError)
          current.off("close", onClose)
          resolve(state)
        }
        const onOpen = () => finish("open")
        const onError = () => finish("error")
        const onClose = () => finish("close")
        current.once("open", onOpen)
        current.once("error", onError)
        current.once("close", onClose)
      })
      if (id !== initID) {
        current.destroy()
        return true
      }
      const active = stream
      logpath = nextLogpath
      if (options.dev && runID) process.env[initializedRunID] = runID
      stream = current
      write = async (msg: any) => {
        if (current.destroyed || current.closed || !current.writable) return 0
        return new Promise((resolve) => {
          try {
            current.write(msg, (err) => resolve(err ? 0 : msg.length))
          } catch {
            resolve(0)
          }
        })
      }
      // failed candidate 仍成为当前 terminal writer，退休旧 active，避免回退到旧日志目标。
      if (ready !== "open") current.destroy()
      // candidate 状态发布后再销毁旧 active，重初始化期间始终保留可写路径。
      active?.destroy()
      return false
    } finally {
      slot.resolve()
    }
  })()
  if (!stale) return

  // stale 调用先释放自己的 slot，再等待稳定的最新 completion，避免死锁或过早返回。
  let current = latestInit
  await current
  while (current !== latestInit) {
    current = latestInit
    await current
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
