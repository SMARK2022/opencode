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
    const parent = Effect.runPromise(DatabaseGate.wait(file)).then(() => { resumed = true })
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
    await Effect.runPromise(DatabaseGate.wait(file))
  })

  test("defers worker acknowledgement until an existing parent reservation exits", async () => {
    const file = "D:/Temp/opencode/gate-reservation.db"
    const exit = await Effect.runPromise(DatabaseGate.enter(file)) // enter 模拟一个已经打开且尚未提交的父事务。
    const worker = DatabaseGate.hold(file, "worker")
    let admitted = false
    const parent = Effect.runPromise(DatabaseGate.wait(file)).then(() => { admitted = true })
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

  test("supports interrupting a queued parent effect", async () => {
    const file = "D:/Temp/opencode/gate-interrupt.db" // Effect timeout 验证父侧等待可中断且不会转换为成功。
    const hold = await DatabaseGate.hold(file, "worker")
    try {
      await expect(Effect.runPromise(Effect.timeout(DatabaseGate.wait(file), 5))).rejects.toThrow()
    } finally {
      DatabaseGate.release(file, hold) // finally 释放确保超时后的后续数据库工作仍可运行。
    }
  })
})
