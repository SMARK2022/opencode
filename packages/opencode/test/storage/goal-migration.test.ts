import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { drizzle } from "drizzle-orm/bun-sqlite"
import { migrate } from "drizzle-orm/bun-sqlite/migrator"
import { readFileSync, readdirSync } from "fs"
import path from "path"

// [local-smark] goal_continue_on_error 迁移兼容性测试
// 验证旧 session_goal 行在添加 continue_on_error 列后：
// 1. 迁移不抛错
// 2. 新列默认 false
// 3. 原有字段（id, objective, status, budget, usage, timestamps）不变
// 复用 workspace-time-migration.test.ts 的按 timestamp 分段应用 migration 模式

// 新 migration 的目录名前缀，生成后实际名称可能不同
const target = "20260710195446_goal_continue_on_error"

function migrations() {
  return readdirSync(path.join(import.meta.dirname, "../../migration"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      name: entry.name,
      timestamp: Number(entry.name.split("_")[0]),
      sql: readFileSync(path.join(import.meta.dirname, "../../migration", entry.name, "migration.sql"), "utf-8"),
    }))
    .sort((a, b) => a.timestamp - b.timestamp)
}

describe("goal continue_on_error migration", () => {
  test("migrates existing session_goal rows with default false", () => {
    const sqlite = new Database(":memory:")
    const db = drizzle({ client: sqlite })
    const entries = migrations()
    const index = entries.findIndex((entry) => entry.name === target)

    // 确认新 migration 存在
    expect(index).toBeGreaterThan(0)

    // 只应用到新 migration 之前（不含新 migration）
    migrate(db, entries.slice(0, index))

    // 插入满足 FK 约束的 project 和 session
    sqlite.run(
      "INSERT INTO project (id, worktree, vcs, name, time_created, time_updated, sandboxes) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ["proj_test", "/tmp/project", "git", "test", 1, 1, "[]"],
    )
    sqlite.run(
      "INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ["ses_test", "proj_test", "test", "/tmp", "Test", "1.0.0", 1, 1],
    )

    // 插入旧结构 session_goal 行（无 continue_on_error 列）
    sqlite.run(
      "INSERT INTO session_goal (session_id, id, objective, status, token_budget, tokens_used, time_used_seconds, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ["ses_test", "goal_1", "test objective", "active", 50000, 1000, 30, 1, 1],
    )

    // 应用新 migration 及其后的剩余 migrations
    expect(() => migrate(db, entries.slice(index))).not.toThrow()

    // 验证新列默认 false
    const row = sqlite
      .query("SELECT * FROM session_goal WHERE session_id = ?")
      .get("ses_test") as any

    expect(row.continue_on_error).toBe(0) // SQLite boolean: 0 = false

    // 验证原有字段不变
    expect(row.id).toBe("goal_1")
    expect(row.objective).toBe("test objective")
    expect(row.status).toBe("active")
    expect(row.token_budget).toBe(50000)
    expect(row.tokens_used).toBe(1000)
    expect(row.time_used_seconds).toBe(30)
    expect(row.time_created).toBe(1)
    expect(row.time_updated).toBe(1)
  })
})
