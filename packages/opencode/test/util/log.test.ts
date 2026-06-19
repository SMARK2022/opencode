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

    yield* Effect.promise(() => Log.init({ print: false, dev: false }))

    const next = yield* files(dir)

    expect(next).not.toContain(list[0])
    expect(next).toContain(list.at(-1)!)
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
