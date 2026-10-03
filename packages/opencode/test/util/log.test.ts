import { expect } from "bun:test"
import { Effect } from "effect"
import fs from "fs/promises"
import path from "path"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Global } from "@opencode-ai/core/global"
import * as Log from "@opencode-ai/core/util/log"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(CrossSpawnSpawner.defaultLayer)

function files(dir: string) {
  return Effect.gen(function* () {
    let last = ""
    let same = 0

    for (let i = 0; i < 50; i++) {
      const list = yield* Effect.promise(() => fs.readdir(dir).then((files) => files.sort()))
      const next = JSON.stringify(list)
      same = next === last ? same + 1 : 0
      if (same >= 2 && list.length === 11) return list
      last = next
      yield* Effect.sleep("10 millis")
    }

    return yield* Effect.promise(() => fs.readdir(dir).then((files) => files.sort()))
  })
}

function readEventually(file: string, expected: string) {
  return Effect.gen(function* () {
    for (let i = 0; i < 50; i++) {
      const content = yield* Effect.promise(() => fs.readFile(file, "utf8").catch(() => undefined))
      if (content?.includes(expected)) return content
      yield* Effect.sleep("10 millis")
    }

    return yield* Effect.promise(() => fs.readFile(file, "utf8"))
  })
}

it.live("init cleanup keeps the newest timestamped logs", () =>
  Effect.gen(function* () {
    const log = Global.Path.log
    yield* Effect.addFinalizer(() => Effect.sync(() => (Global.Path.log = log)))
    const dir = yield* tmpdirScoped()
    Global.Path.log = dir

    const list = Array.from({ length: 12 }, (_, i) => `2000-01-${String(i + 1).padStart(2, "0")}T000000.log`)

    yield* Effect.all(list.map((file) => Effect.promise(() => fs.writeFile(path.join(dir, file), file))))

    // 清理合同是 count + mtime 保留窗：writeFile 造的 fixture mtime 全是当前时刻，
    // 必须回拨超出 keep 名额的 list[0..2]，删除路径才会被真实执行（保留方向由
    // "cleanup retains recently written logs" 测试钉住）。
    const stale = new Date(Date.now() - 48 * 60 * 60 * 1000)
    yield* Effect.all(
      list.slice(0, 3).map((file) => Effect.promise(() => fs.utimes(path.join(dir, file), stale, stale))),
    )

    yield* Effect.promise(() => Log.init({ print: false, dev: false }))

    const next = yield* files(dir)

    expect(next).not.toContain(list[0])
    expect(next).toContain(list.at(-1)!)
  }),
)

it.live("cleanup retains recently written logs beyond the keep limit", () =>
  Effect.gen(function* () {
    const log = Global.Path.log
    yield* Effect.addFinalizer(() => Effect.sync(() => (Global.Path.log = log)))

    const dir = yield* tmpdirScoped()
    Global.Path.log = dir

    const list = Array.from({ length: 12 }, (_, i) => `2000-01-${String(i + 1).padStart(2, "0")}T000000.log`)
    yield* Effect.all(list.map((file) => Effect.promise(() => fs.writeFile(path.join(dir, file), file))))

    // writeFile 会把 mtime 写成当前时刻，必须显式回拨才能制造判别窗口：
    // list[1] 回拨到保留窗之前（超出 keep 且过期，新旧合同都应删除，兼作 cleanup 完成的等待信号）；
    // list[0] 保持新鲜（超出 keep 但仍在写入，旧合同误删、新合同保留——INV-08 的判别点）。
    const stale = new Date(Date.now() - 48 * 60 * 60 * 1000)
    yield* Effect.promise(() => fs.utimes(path.join(dir, list[1]), stale, stale))

    yield* Effect.promise(() => Log.init({ print: false, dev: false }))

    // cleanup 在 init 内 fire-and-forget：等 list[1] 消失即删除已真实发生，此时再断言 list[0]。
    let gone = false
    for (let i = 0; i < 50 && !gone; i++) {
      gone = !(yield* Effect.promise(() => fs.readdir(dir))).includes(list[1])
      if (!gone) yield* Effect.sleep("10 millis")
    }

    expect(gone).toBe(true)
    expect(yield* Effect.promise(() => fs.readdir(dir))).toContain(list[0])
  }),
)

it.live("close flushes pending writes before exit", () =>
  Effect.gen(function* () {
    const log = Global.Path.log
    // close 会终结进程级日志流；finalizer 必须恢复 Global.Path.log 并 re-init，
    // 否则同进程后续测试文件的日志写入会落在已降级到 stderr 的关闭状态上。
    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        Global.Path.log = log
        await Log.init({ print: false, dev: true, level: "DEBUG" })
      }),
    )

    const dir = yield* tmpdirScoped()
    Global.Path.log = dir
    yield* Effect.promise(() => Log.init({ print: false, dev: true, level: "DEBUG" }))
    Log.Default.info("close durability sentinel")

    yield* Effect.promise(() => Log.close())

    // close 返回即代表文件流已 finish：此处必须同步读得到 sentinel，才能证明
    // gracefulShutdown 在 process.exit 前 await 它是有意义的（INV-07）。
    const content = yield* Effect.promise(() => fs.readFile(path.join(dir, "dev.log"), "utf8"))
    expect(content).toContain("close durability sentinel")
  }),
)

it.live("local dev log is not truncated twice for the same run", () =>
  Effect.gen(function* () {
    const log = Global.Path.log
    const runID = process.env.OPENCODE_RUN_ID
    const initialized = process.env.OPENCODE_LOG_INITIALIZED_RUN_ID
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        Global.Path.log = log
        if (runID === undefined) delete process.env.OPENCODE_RUN_ID
        else process.env.OPENCODE_RUN_ID = runID
        if (initialized === undefined) delete process.env.OPENCODE_LOG_INITIALIZED_RUN_ID
        else process.env.OPENCODE_LOG_INITIALIZED_RUN_ID = initialized
      }),
    )

    const dir = yield* tmpdirScoped()
    Global.Path.log = dir
    process.env.OPENCODE_RUN_ID = "run-1"
    delete process.env.OPENCODE_LOG_INITIALIZED_RUN_ID

    yield* Effect.promise(() => Log.init({ print: false, dev: true }))
    yield* Effect.promise(() => fs.writeFile(path.join(dir, "dev.log"), "main startup\n"))
    yield* Effect.promise(() => Log.init({ print: false, dev: true }))

    expect(yield* Effect.promise(() => fs.readFile(path.join(dir, "dev.log"), "utf8"))).toContain("main startup")
  }),
)

it.live("dev logging recreates a missing log directory", () =>
  Effect.gen(function* () {
    const log = Global.Path.log
    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        Global.Path.log = log
        await Log.init({ print: false, dev: true, level: "DEBUG" })
      }),
    )

    const dir = yield* tmpdirScoped()
    const missing = path.join(dir, "missing-log")
    Global.Path.log = missing

    // 测试模拟 CI 中临时日志目录被清理或尚未创建的边界；日志系统
    // 应该自己恢复目录并写入 dev.log，而不是把 ENOENT 泄漏到业务测试。
    yield* Effect.promise(() => Log.init({ print: false, dev: true, level: "DEBUG" }))
    Log.Default.info("log directory was recreated")

    const content = yield* readEventually(path.join(missing, "dev.log"), "log directory was recreated")
    expect(content).toContain("log directory was recreated")
  }),
)

it.live("init uses one log directory snapshot", () =>
  Effect.gen(function* () {
    const log = Global.Path.log
    const mkdir = fs.mkdir
    const runID = process.env.OPENCODE_RUN_ID
    const initialized = process.env.OPENCODE_LOG_INITIALIZED_RUN_ID
    let releaseMkdir = () => {}
    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        releaseMkdir()
        fs.mkdir = mkdir
        Global.Path.log = log
        if (runID === undefined) delete process.env.OPENCODE_RUN_ID
        else process.env.OPENCODE_RUN_ID = runID
        if (initialized === undefined) delete process.env.OPENCODE_LOG_INITIALIZED_RUN_ID
        else process.env.OPENCODE_LOG_INITIALIZED_RUN_ID = initialized
        await Log.init({ print: false, dev: true, level: "DEBUG" })
      }),
    )

    const dir = yield* tmpdirScoped()
    const target = path.join(dir, "target")
    const later = path.join(dir, "later")
    const mkdirStarted = new Promise<void>((resolve) => {
      fs.mkdir = ((file, options) => {
        if (file !== target) return mkdir(file, options)
        resolve()
        return new Promise<void>((release) => {
          releaseMkdir = () => {
            release()
            releaseMkdir = () => {}
          }
        }).then(() => mkdir(file, options))
      }) as typeof fs.mkdir
    })

    delete process.env.OPENCODE_RUN_ID
    delete process.env.OPENCODE_LOG_INITIALIZED_RUN_ID
    Global.Path.log = target
    const initializing = Log.init({ print: false, dev: true, level: "DEBUG" })
    yield* Effect.promise(() => mkdirStarted)
    Global.Path.log = later
    releaseMkdir()
    yield* Effect.promise(() => initializing)

    Log.Default.info("snapshot target receives logs")

    const content = yield* readEventually(path.join(target, "dev.log"), "snapshot target receives logs")
    expect(content).toContain("snapshot target receives logs")
  }),
)
