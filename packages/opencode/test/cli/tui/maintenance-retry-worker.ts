import { mock } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"

const dbPath = process.env.OPENCODE_TEST_MAINTENANCE_DB
if (!dbPath) throw new Error("OPENCODE_TEST_MAINTENANCE_DB is required")

const lockDir = path.join(`${dbPath}.maintenance`, "lock")
await fs.mkdir(lockDir, { recursive: true })
await Bun.write(
  path.join(lockDir, "owner.json"),
  JSON.stringify({
    pid: 2_147_483_647,
    token: "dead-injected-owner",
    taskID: "dbm_dead_injected",
    dbPath: path.resolve(dbPath),
    startedAt: 1,
  }),
)

let blocked = false
await mock.module("fs/promises", () => ({
  ...fs,
  rename: async (...args: Parameters<typeof fs.rename>) => {
    if (!blocked && path.resolve(String(args[0])) === lockDir) {
      blocked = true
      // marker发布后父测试才允许本次系统边界返回EACCES，建立确定的conflict-before-retry时序。
      process.stdout.write("rename-blocked\n")
      await new Response(Bun.stdin.stream()).text()
      throw Object.assign(new Error("injected Windows sharing violation"), { code: "EACCES" })
    }
    return fs.rename(...args)
  },
}))

// 动态import保证production命名绑定读取上面的系统边界；测试仍调用公开lease API而非复制retry算法。
const ServerLock = await import("../../../src/cli/cmd/tui/server-lock")
const lease = await ServerLock.acquireMaintenanceLease({ taskID: "dbm_recovered_injected", dbPath })
lease.assertOwned()
process.stdout.write("lease-owned\n")
await lease.release()
