import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { drizzle } from "drizzle-orm/bun-sqlite"
import { migrate } from "drizzle-orm/bun-sqlite/migrator"
import { mkdtemp, rm } from "fs/promises"
import os from "os"
import path from "path"
import { existsSync, readFileSync, readdirSync } from "fs"

// 迁移目录名带生成时间戳，按后缀匹配避免测试与具体生成日期耦合。
const target = "session_context_epoch"

function migrations() {
  // 与生产加载器（src/storage/db.ts）一致：跳过没有 migration.sql 的目录残骸（如中断的 generate）。
  return readdirSync(path.join(import.meta.dirname, "../../migration"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const file = path.join(import.meta.dirname, "../../migration", entry.name, "migration.sql")
      if (!existsSync(file)) return
      return {
        name: entry.name,
        timestamp: Number(entry.name.split("_")[0]),
        sql: readFileSync(file, "utf-8"),
      }
    })
    .filter((entry) => entry !== undefined)
    .sort((a, b) => a.timestamp - b.timestamp)
}

describe("session context_epoch migration", () => {
  test("adds the column to existing databases without touching prior rows", () => {
    const sqlite = new Database(":memory:")
    const db = drizzle({ client: sqlite })
    const entries = migrations()
    const index = entries.findIndex((entry) => entry.name.endsWith(target))

    // index 必须大于 0：目标迁移之前有完整历史链，升级测试从旧 schema 起步才有意义。
    expect(index).toBeGreaterThan(0)

    migrate(db, entries.slice(0, index))
    sqlite.run(
      "INSERT INTO project (id, worktree, vcs, name, time_created, time_updated, sandboxes) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ["project_1", "/tmp/project", "git", "project", 1, 1, "[]"],
    )
    sqlite.run(
      "INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ["session_1", "project_1", "slug-1", "/tmp/project", "title", "test", 1, 1],
    )

    expect(() => migrate(db, entries.slice(index))).not.toThrow()
    // 旧行升级后为 NULL：首次请求才初始化，绝不伪造历史快照。
    expect(sqlite.query("SELECT context_epoch FROM session WHERE id = ?").get("session_1")).toEqual({
      context_epoch: null,
    })
    // 迁移不得触碰既有列：标题等字段逐字保留，证明是单纯 ADD COLUMN。
    expect(sqlite.query("SELECT title FROM session WHERE id = ?").get("session_1")).toEqual({ title: "title" })
  })

  // 真实文件数据库 + 两个独立 bun 子进程：证明恢复路径不依赖任何进程内内存状态。
  // OPENCODE_DB 由子进程 env 在模块加载前传入；数据库路径在模块加载时定形，不能靠共享进程切换。
  test("persists the epoch across independent processes on a real database file", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "opencode-context-epoch-"))
    const file = path.join(dir, "context.db")
    const pkg = path.join(import.meta.dirname, "../..")
    try {
      const seed = await Bun.$`bun -e ${`
        import { Database } from "./src/storage/db"
        import { ProjectTable } from "./src/project/project.sql"
        import { SessionTable } from "./src/session/session.sql"
        import { SessionContextEpoch } from "./src/session/context-epoch"
        import { Effect } from "effect"
        const db = Database.Client()
        db.insert(ProjectTable).values({ id: "project_ctx", worktree: "/tmp/ctx", vcs: "git", sandboxes: [] }).run()
        db.insert(SessionTable).values({ id: "session_ctx", project_id: "project_ctx", slug: "ctx", directory: "/tmp/ctx", title: "ctx", version: "test" }).run()
        const epoch = await Effect.runPromise(SessionContextEpoch.prepare({
          sessionID: "session_ctx",
          history: { boundary: "null", messageIDs: ["msg_seed"] },
          now: new Date("2026-09-11T12:00:00"),
          captureGit: Effect.succeed("git-A"),
        }))
        console.log(JSON.stringify(epoch))
        Database.close()
      `}`.cwd(pkg).env({ ...process.env, OPENCODE_DB: file }).quiet().nothrow()
      expect(seed.exitCode).toBe(0)

      const resume = await Bun.$`bun -e ${`
        import { Database } from "./src/storage/db"
        import { SessionContextEpoch } from "./src/session/context-epoch"
        import { Effect } from "effect"
        Database.Client()
        const epoch = await Effect.runPromise(SessionContextEpoch.prepare({
          sessionID: "session_ctx",
          history: { boundary: "null", messageIDs: ["msg_seed"] },
          now: new Date("2026-09-12T12:00:00"),
          captureGit: Effect.succeed("git-B"),
        }))
        console.log(JSON.stringify(epoch))
        Database.close()
      `}`.cwd(pkg).env({ ...process.env, OPENCODE_DB: file }).quiet().nothrow()
      expect(resume.exitCode).toBe(0)

      const first = JSON.parse(seed.text())
      const second = JSON.parse(resume.text())
      // 跨日后 Git 仍逐字来自首个进程；日期只追加一条更新，baseline 不变。
      expect(second.snapshot["smark/git"].value).toBe("git-A")
      expect(second.baseline).toBe(first.baseline)
      // 更新携带上游 Session.Message.System 的持久编码与锚点，恢复方不需要任何进程内上下文。
      expect(second.updates.length).toBe(1)
      expect(second.updates[0].message.text).toContain("Today's date is now:")
      expect(second.updates[0].after_message_id).toBe("msg_seed")
    } finally {
      // 临时目录只容纳本用例的数据库文件；finally 清理不依赖任何断言结果。
      await rm(dir, { recursive: true, force: true })
    }
    // 两次 bun 冷启动远大于正常测试耗时，显式给出 30s 预算而不是依赖全局默认。
  }, 30_000)
})
