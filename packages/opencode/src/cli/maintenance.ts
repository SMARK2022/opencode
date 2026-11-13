import { randomUUID } from "node:crypto"
import { Effect } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { ColdMaintain } from "@opencode-ai/core/storage/cold-maintain"
import { ServerLock } from "./tui/server-lock"

export type OfflineOptions = {
  task?: ColdMaintain.MaintenanceTask
  signal?: AbortSignal
  reserve?: () => Promise<void | (() => void | Promise<void>)> // 宿主只注入预约协议，核心维护算法不感知 Worker 消息细节。
  onLease?: (lease: ServerLock.MaintenanceLease) => void // lease token 在获取后立即上报，供异常退出时的监督清理使用。
}

function maintain(
  database: Database.Interface,
  prepared: ColdMaintain.PreparedMaintenance,
  runtime: ColdMaintain.MaintenanceRuntime = { checkpoint: async () => {} },
  options?: Pick<OfflineOptions, "reserve">,
) {
  return ColdMaintain.maintain(database.sync, prepared, {
    ...runtime,
    run: async (body) => {
      const release = await options?.reserve?.() // 每段 SQL 都先等待父侧确认，编码和 checkpoint 不占用数据库预约。
      try {
        return await Effect.runPromise(Database.withSync(database, body)) // Worker 内部仍复用同一连接与既有事务边界。
      } finally {
        await release?.() // 成功、损坏和中断都释放当前持有项，父侧队列才能继续前进。
      }
    },
  })
}

export async function runOffline(
  db: Database.Interface,
  prepared: ColdMaintain.PreparedMaintenance,
  onTask?: (task: ColdMaintain.MaintenanceTask) => void,
  options: OfflineOptions = {},
): Promise<ColdMaintain.MaintenanceResult> {
  if (prepared.type === "immediate") {
    if (prepared.request.operation !== "vacuum") return maintain(db, prepared, { checkpoint: async () => {}, signal: options.signal }, options)
    const existing = await ServerLock.findNonterminalMaintenanceTask() // vacuum 也必须尊重待恢复任务，不能并行重排数据库页面。
    if (existing) throw new ServerLock.MaintenanceBusyError(`Maintenance task already exists: ${existing.taskID}`)
    const lease = await ServerLock.acquireMaintenanceLease({ taskID: `vacuum_${randomUUID()}`, dbPath: Database.path() })
    try {
      options.onLease?.(lease) // 上报发生在任何 SQL 之前，父侧始终知道潜在残留 token。
      return await maintain(db, prepared, { lease, checkpoint: async () => {}, signal: options.signal }, options)
    } finally {
      await lease.release()
    }
  }

  if (!options.task) { // resume 使用已 reconciled 身份，新任务才执行 nonterminal 冲突检查。
    const existing = await ServerLock.findNonterminalMaintenanceTask()
    if (existing) throw new ServerLock.MaintenanceBusyError(`Maintenance task already exists: ${existing.taskID}`)
  }
  const task = options.task ?? prepared.task // resume 保留原 taskID、cursor 和累计计数，不采用新随机任务身份。
  const lease = await ServerLock.acquireMaintenanceLease(task)
  try {
    options.onLease?.(lease) // task-backed lease 同样在 queued 与 running 之前上报。
    // 新任务先持久化 queued；resume 从已 reconciled cursor 的首个 running checkpoint 继续。
    if (!options.task) await ServerLock.writeMaintenanceTask(prepared.task) // queued 先于首批 SQL 落盘，为崩溃恢复提供稳定锚点。
    return await maintain(db, prepared, {
      task,
      lease,
      signal: options.signal,
      checkpoint: async (next) => {
        await ServerLock.writeMaintenanceTask(next) // 进度通知只跟随已持久化 checkpoint，不领先数据库提交。
        if (next.status !== "completed") onTask?.(next) // ready 从 running 状态产生，completed 由最终结果统一交付。
      },
    }, options)
  } finally {
    await lease.release()
  }
}

export * as MaintenanceExecutor from "./maintenance"
