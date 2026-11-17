import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { DatabaseGate } from "../src/database/gate"
import { Database } from "../src/database/database"
import path from "node:path"
import { tmpdir } from "./fixture/tmpdir"

describe("DatabaseGate", () => {
  test("queues worker holds FIFO and blocks parent admission until the last release", async () => {
    const file = "D:/Temp/opencode/gate-fifo.db" // 独立逻辑路径只验证调度，不打开真实数据库文件。
    const first = await DatabaseGate.hold(file, "worker")
    let resumed = false // 父侧完成标记直接证明 Worker 持有期间 SQL admission 被暂停。
    const parent = Effect.runPromise(DatabaseGate.enter(file).pipe(Effect.flatMap((exit) => exit))).then(() => { resumed = true })
    await Promise.resolve()
    expect(resumed).toBe(false)

    const secondPending = DatabaseGate.hold(file, "worker") // 第二个请求必须等第一个释放后才能收到确认。
    DatabaseGate.release(file, first)
    const second = await secondPending
    await Promise.resolve()
    expect(resumed).toBe(false)

    DatabaseGate.release(file, second) // 最后释放才恢复父侧，避免持有间隙被新 SQL 插队。
    await parent
    expect(resumed).toBe(true)
  })

  test("removes an aborted hold request without stranding parent waiters", async () => {
    const file = "D:/Temp/opencode/gate-abort.db" // 每个中断场景使用独立键，防止测试间共享等待状态。
    const first = await DatabaseGate.hold(file, "worker")
    const controller = new AbortController()
    const pending = DatabaseGate.hold(file, "worker", controller.signal)
    controller.abort() // 主动取消排队请求，验证清理不会遗留无法唤醒的父侧等待者。
    await expect(pending).rejects.toThrow("aborted")
    DatabaseGate.release(file, first)
    await Effect.runPromise(DatabaseGate.enter(file).pipe(Effect.flatMap((exit) => exit)))
  })

  test("defers worker acknowledgement until an existing parent reservation exits", async () => {
    const file = "D:/Temp/opencode/gate-reservation.db"
    const exit = await Effect.runPromise(DatabaseGate.enter(file)) // enter 模拟一个已经打开且尚未提交的父事务。
    const worker = DatabaseGate.hold(file, "worker")
    let admitted = false
    const parent = Effect.runPromise(DatabaseGate.enter(file).pipe(Effect.flatMap((exit) => exit))).then(() => { admitted = true })
    await Promise.resolve()
    expect(admitted).toBe(false)
    await Effect.runPromise(exit) // 只有事务收尾后，Worker 的 hold Promise 才允许完成。
    const hold = await worker
    DatabaseGate.release(file, hold)
    await parent
    expect(admitted).toBe(true)
  })

  test("queues real SQL behind a worker hold and resumes after release", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "gate.db") // core 临时目录在 Windows、Linux 和 macOS 都可创建并自动清理。
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const database = yield* Database.Service
      yield* database.db.run("CREATE TABLE probe (id INTEGER PRIMARY KEY)")
      const hold = yield* Effect.promise(() => DatabaseGate.hold(file, "worker"))
      let completed = false // 真实 INSERT 的完成状态用于证明等待发生在 SQLite 执行之前。
      const pending = Effect.runPromise(database.db.run("INSERT INTO probe VALUES (1)"))
        .then(() => { completed = true })
      yield* Effect.sleep(20)
      expect(completed).toBe(false)
      DatabaseGate.release(file, hold) // 释放后同一个 Effect SQL 必须继续执行并写入一行。
      yield* Effect.promise(() => pending)
      expect(yield* database.db.run("SELECT id FROM probe")).toHaveLength(1)
    })).pipe(Effect.provide(Database.layerFromPath(file))))
  })

  test("resumes a synchronously completed parent only once", async () => {
    // 独立文件键隔离本次重入状态，避免其他 Gate 用例的等待者影响计数。
    const file = path.resolve(`gate-reentrancy-${process.pid}-${Date.now()}.db`)
    const first = await DatabaseGate.hold(file, "first")
    try {
      let completed = false
      // Worker 释放会同步恢复父侧 fiber，父侧又可能立即退出并嵌套调用 settle。
      // 这个顺序覆盖旧实现重复 resume 后 reservations 永久为正的死锁。
      const parent = Effect.runPromise(Effect.gen(function* () {
        const exit = yield* DatabaseGate.enter(file)
        yield* exit
        yield* Effect.sync(() => { completed = true })
      }))
      await Promise.resolve()
      DatabaseGate.release(file, first)
      // 第二个 hold 能直接观察嵌套 settle 是否重复消费了同一个等待回调。
      const second = DatabaseGate.hold(file, "second")
      second.catch(() => undefined)
      const result = await Promise.race([second.then(() => "granted"), Bun.sleep(50).then(() => "blocked")])
      // granted 证明首个父请求只登记一次，后续 Worker 没有被残留 reservation 阻塞。
      // 同步完成会嵌套 settle；先消费等待者才能避免同一许可被重复登记。
      expect(result).toBe("granted")
      DatabaseGate.releaseSupervisor(file, "second")
      // 原 fiber 也必须正常收尾，不能把后续请求意外通过误当成完整修复。
      await parent
      expect(completed).toBe(true)
    } finally {
      DatabaseGate.releaseSupervisor(file, "first")
      DatabaseGate.releaseSupervisor(file, "second")
    }
  })

  test("supports interrupting a queued parent effect", async () => {
    const file = "D:/Temp/opencode/gate-interrupt.db" // Effect timeout 验证父侧等待可中断且不会转换为成功。
    const hold = await DatabaseGate.hold(file, "worker")
    try {
      await expect(Effect.runPromise(Effect.timeout(DatabaseGate.enter(file).pipe(Effect.flatMap((exit) => exit)), 5))).rejects.toThrow()
    } finally {
      DatabaseGate.release(file, hold) // finally 释放确保超时后的后续数据库工作仍可运行。
    }
  })

  test("node adapter reserves through the same worker gate", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "node-gate.db")
    // target=node 与 conditions=node 选择生产 Node 适配器，而不是 Bun 分支的替代证明。
    // 虚拟入口覆盖真实 reserve→Gate 生命周期，避免只测一个脱离运行时的 helper。
    const build = await Bun.build({
      root: path.join(import.meta.dir, ".."),
      target: "node",
      conditions: ["node"],
      files: {
        "node-gate.gen.ts": `
          import { test } from "node:test"
          import assert from "node:assert/strict"
          import { Effect } from "effect"
          import { Database } from "./src/database/database"
          import { DatabaseGate } from "./src/database/gate"
          test("node gate", async () => {
            await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
              const database = yield* Database.Service
              yield* database.db.run("CREATE TABLE probe (id INTEGER PRIMARY KEY)")
              const hold = yield* Effect.promise(() => DatabaseGate.hold(${JSON.stringify(file)}, "worker"))
              let completed = false
              const pending = Effect.runPromise(Effect.scoped(database.db.$client.reserve)).then(() => { completed = true })
              yield* Effect.sleep(20)
              assert.equal(completed, false)
              DatabaseGate.release(${JSON.stringify(file)}, hold)
              yield* Effect.promise(() => pending)
              yield* database.db.run("INSERT INTO probe VALUES (1)")
              assert.equal((yield* database.db.run("SELECT id FROM probe")).length, 1)
            })).pipe(Effect.provide(Database.layerFromPath(${JSON.stringify(file)}))))
          })
        `,
      },
      entrypoints: ["node-gate.gen.ts"],
      outdir: tmp.path,
    })
    // 构建产物写入本用例临时目录，仓库中不会新增 fixture 或 runner 文件。
    // 失败时保留构建日志，防止把入口解析问题误报为 Gate 行为差异。
    if (!build.success) throw new AggregateError(build.logs, "Node gate bundle failed")
    const output = build.outputs.find((file) => file.kind === "entry-point")
    if (!output) throw new Error("Node gate bundle has no entry point")
    // Node 24 的 node:test 负责最终执行，Bun 只承担构建与进程启动，不能替代目标运行时。
    // 虚拟 entry 只存在于测试进程；真实 Node 24 执行同一 #sqlite 条件导出，不新增 fixture/runner 文件。
    const result = Bun.spawnSync(["node", "--test", output.path], { cwd: tmp.path, stdout: "pipe", stderr: "pipe" })
    if (result.exitCode !== 0) throw new Error(result.stdout.toString() + result.stderr.toString())
    expect(result.exitCode).toBe(0)
  })
})
