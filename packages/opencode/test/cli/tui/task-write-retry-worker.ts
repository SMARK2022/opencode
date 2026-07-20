import { mock } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"

const dbPath = process.env.OPENCODE_TEST_MAINTENANCE_DB
if (!dbPath) throw new Error("OPENCODE_TEST_MAINTENANCE_DB is required")

const taskFile = path.join(`${dbPath}.maintenance`, "tasks", "dbm_write_atomic_retry.json")
let blocked = false

await mock.module("fs/promises", () => ({
  ...fs,
  rename: async (...args: Parameters<typeof fs.rename>) => {
    // 首次把 task tmp 发布到正式 json 时注入 EPERM，验证 writeAtomic 与 stale rename 共用重试合同。
    if (!blocked && String(args[1]) === taskFile) {
      blocked = true
      process.stdout.write("rename-blocked\n")
      await new Response(Bun.stdin.stream()).text()
      throw Object.assign(new Error("injected Windows sharing violation"), { code: "EPERM" })
    }
    return fs.rename(...args)
  },
}))

const ServerLock = await import("../../../src/cli/cmd/tui/server-lock")
await ServerLock.writeMaintenanceTask({
  version: 1,
  taskID: "dbm_write_atomic_retry",
  dbPath,
  operation: "compress",
  args: { operation: "compress", olderThanMs: 0, batchSize: 1 },
  status: "interrupted",
  cursor: { owner: "message", lastID: "" },
  processed: 0,
  skipped: 0,
  failed: 0,
  rawBytes: 0,
  compressedBytes: 0,
  createdAt: Date.now(),
  updatedAt: Date.now(),
})
const recovered = await ServerLock.readMaintenanceTask("dbm_write_atomic_retry", dbPath)
if (recovered?.status !== "interrupted") throw new Error(`unexpected task: ${JSON.stringify(recovered)}`)
process.stdout.write("write-ok\n")
