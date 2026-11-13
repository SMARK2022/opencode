import { expect, test } from "bun:test"
import { Worker } from "node:worker_threads"
import path from "node:path"
import { ColdMaintain } from "@opencode-ai/core/storage/cold-maintain"
import { DatabaseGate } from "@opencode-ai/core/database/gate"
import { tmpdir } from "../../fixture/fixture"
import { ServerLock } from "../../../src/cli/tui/server-lock"

function spawnMaintenanceWorker(dbPath: string, prepared: ColdMaintain.PreparedMaintenance, env: Record<string, string> = {}) {
  const root = path.dirname(dbPath) // 每个临时数据库目录同时隔离 XDG，避免 Worker 接触开发机状态。
  return new Worker(new URL("../../../src/cli/tui/worker.ts", import.meta.url), {
    workerData: { role: "maintenance", dbPath, prepared },
    env: { ...process.env, OPENCODE_PROCESS_ROLE: "worker", OPENCODE_DB: dbPath,
      XDG_DATA_HOME: path.join(root, "data"), XDG_CONFIG_HOME: path.join(root, "config"),
      XDG_STATE_HOME: path.join(root, "state"), XDG_CACHE_HOME: path.join(root, "cache"), ...env },
  })
}

test("maintenance Worker preserves a live lease conflict as busy", async () => {
  await using tmp = await tmpdir()
  const dbPath = path.join(tmp.path, "maintenance-busy.db") // 冲突场景的 lease 与任务文件都限制在一次性数据库命名空间。
  const prepared = ColdMaintain.prepareMaintenance({ operation: "compress", olderThanMs: 0, batchSize: 1 })
  if (prepared.type !== "task") throw new Error("expected task")
  prepared.task.dbPath = dbPath
  const lease = await ServerLock.acquireMaintenanceLease({ taskID: "dbm_existing", dbPath }) // 先持有真实 lease，确保 Worker 在获取阶段遇到确定性冲突。
  const worker = spawnMaintenanceWorker(dbPath, prepared)
  try {
    const failure = new Promise<string | undefined>((resolve, reject) => { // 直接观察线上消息的 kind，防止普通 Error 吞掉 busy 语义。
      worker.on("message", (message: { type: string; kind?: string; requestID?: string }) => {
        if (message.type === "hold" && message.requestID) {
          worker.postMessage({ type: "hold-ack", requestID: message.requestID, holdID: message.requestID })
        }
        if (message.type === "failure") resolve(message.kind)
      })
      worker.once("error", reject)
    })
    expect(await failure).toBe("busy") // busy 必须能映射回既有 409，而不是成为内部 500。
  } finally {
    await lease.release() // 测试持有者与 Worker 失败路径都必须释放，避免影响后续临时目录清理。
    await worker.terminate()
  }
}, 30_000)

test("maintenance Worker rejects native initialization before the first hold is denied", async () => {
  await using tmp = await tmpdir()
  const dbPath = path.join(tmp.path, "maintenance-open-denied.db")
  const prepared = ColdMaintain.prepareMaintenance({ operation: "compress", olderThanMs: 0, batchSize: 1 })
  if (prepared.type !== "task") throw new Error("expected task")
  prepared.task.dbPath = dbPath
  const worker = spawnMaintenanceWorker(dbPath, prepared)
  const failure = new Promise<void>((resolve, reject) => {
    worker.on("message", (message: { type: string; requestID?: string }) => {
      if (message.type === "hold" && message.requestID) {
        worker.postMessage({ type: "hold-error", requestID: message.requestID, error: "denied" })
      }
      if (message.type === "failure") resolve()
    })
    worker.once("error", reject)
  })
  try {
    await failure
    expect(await Bun.file(dbPath).exists()).toBe(false) // 首次 hold 被拒绝时数据库尚未初始化，证明 native open 也受父侧 admission 管理。
  } finally {
    await worker.terminate()
  }
}, 30_000)

test("maintenance Worker checkpoints interrupted when aborted at a database boundary", async () => {
  await using tmp = await tmpdir()
  const dbPath = path.join(tmp.path, "maintenance-abort.db") // 中断测试只操作独立任务记录和临时数据库。
  const prepared = ColdMaintain.prepareMaintenance({ operation: "compress", olderThanMs: 0, batchSize: 1 })
  if (prepared.type !== "task") throw new Error("expected task")
  prepared.task.dbPath = dbPath
  const worker = spawnMaintenanceWorker(dbPath, prepared)
  let holdRequests = 0
  const terminal = new Promise<void>((resolve, reject) => { // failure 也算一次完成观察，真正断言落在持久 interrupted 状态。
    const timeout = setTimeout(() => reject(new Error("maintenance abort timed out")), 20_000)
    worker.on("message", (message: { type: string; requestID?: string }) => {
      if (message.type === "result" || message.type === "failure") {
        clearTimeout(timeout)
        resolve()
        return
      }
      if (message.type !== "hold" || !message.requestID) return
      holdRequests++
      if (holdRequests === 2) {
        // open 已完成后才在业务批次边界中断，保留 durable queued/running 到 interrupted 的原始覆盖。
        worker.postMessage({ type: "abort" })
        worker.postMessage({ type: "hold-error", requestID: message.requestID, error: "aborted" })
        return
      }
      worker.postMessage({ type: "hold-ack", requestID: message.requestID, holdID: message.requestID })
    })
    worker.once("error", reject)
  })
  try {
    await terminal
    const task = await Bun.file(`${dbPath}.maintenance/tasks/${prepared.task.taskID}.json`).json() // 直接读取 durable task，避免把 Worker 返回外形当成持久事实。
    expect(task.status).toBe("interrupted")
  } finally {
    await worker.terminate()
  }
}, 30_000)

test("maintenance Worker reports ready after durable running state and releases database holds", async () => {
  await using tmp = await tmpdir()
  const dbPath = path.join(tmp.path, "maintenance-worker.db")
  const lockPath = path.join(tmp.path, "daemon-lock.json") // 继承 worker 角色时该 discovery 路径仍必须保持不存在。
  const prepared = ColdMaintain.prepareMaintenance({ operation: "compress", olderThanMs: 0, batchSize: 1 })
  if (prepared.type !== "task") throw new Error("expected task")
  prepared.task.dbPath = dbPath
  const worker = spawnMaintenanceWorker(dbPath, prepared, { OPENCODE_LOCK_PATH: lockPath, OPENCODE_DISABLE_MODELS_FETCH: "1" })
  const holds = new Map<string, string>() // requestID 映射父侧 holdID，保证每次 release 精确对应一次确认。
  let holdRequests = 0 // 打开、首批 SQL 和关闭三个生命周期阶段都必须经过同一预约协议。
  let ready = false // ready 只应在首个 running checkpoint 持久化之后出现。
  let durableAtReady: string | undefined // 在 ready 回调内同步读取任务文件，验证协议顺序而非响应文案。
  let lease = false // token 上报必须先于任务执行，供父侧异常清理使用。
  const terminal = new Promise<ColdMaintain.MaintenanceResult>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("maintenance Worker timed out")), 20_000)
    worker.on("message", (message: {
      type: string
      token?: string
      task?: ColdMaintain.MaintenanceTask
      result?: ColdMaintain.MaintenanceResult
      error?: string
      requestID?: string
      holdID?: string
    }) => {
      void (async () => {
        if (message.type === "lease") lease = true
        if (message.type === "ready") {
          ready = true
          const file = Bun.file(`${dbPath}.maintenance/tasks/${prepared.task.taskID}.json`)
          durableAtReady = (await file.json()).status // running 是磁盘事实，queued 则是此前的受理记录。
        }
        if (message.type === "hold" && message.requestID) {
          holdRequests++
          const holdID = await DatabaseGate.hold(dbPath, "test-worker")
          holds.set(message.requestID, holdID)
          worker.postMessage({ type: "hold-ack", requestID: message.requestID, holdID })
        }
        if (message.type === "release" && message.requestID) {
          const holdID = holds.get(message.requestID)
          holds.delete(message.requestID)
          if (holdID) DatabaseGate.release(dbPath, holdID)
        }
        if (message.type === "result" && message.result) {
          clearTimeout(timeout)
          resolve(message.result)
        }
        if (message.type === "failure") {
          clearTimeout(timeout)
          reject(new Error(message.error))
        }
      })().catch(reject)
    })
    worker.once("error", reject)
  })
  try {
    const result = await terminal
    expect(lease).toBe(true) // 没有 token 时异常退出无法安全清理 maintenance owner。
    expect(ready).toBe(true)
    expect(durableAtReady).toBe("running") // ready 不得提前到 queued 或第一个 SQL 批次之前。
    expect(result.type).toBe("task")
    if (result.type === "task") expect(result.task.status).toBe("completed")
    expect(holds.size).toBe(0) // 正常完成后所有数据库持有项必须归零。
    expect(holdRequests).toBe(10) // 当前空压缩有八段维护预约，open/close 必须再各增加一段，总计十段。
    expect(await Bun.file(lockPath).exists()).toBe(false) // maintenance-only 分支不能启动监听或写 discovery owner。
  } finally {
    DatabaseGate.releaseSupervisor(dbPath, "test-worker") // finally 按监督身份清理，避免失败用例污染后续 gate 测试。
    await worker.terminate()
  }
}, 30_000)
