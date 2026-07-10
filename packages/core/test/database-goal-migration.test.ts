import { describe, expect, test } from "bun:test"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EffectDrizzleSqlite } from "@opencode-ai/effect-drizzle-sqlite"
import { Effect } from "effect"
import { sql } from "drizzle-orm"
import type { SqlClient } from "effect/unstable/sql/SqlClient"
import { DatabaseMigration } from "@opencode-ai/core/database/migration"
import { migrations } from "@opencode-ai/core/database/migration.gen"
import goalMigration from "@opencode-ai/core/database/migration/20260726100000_session_goal"
import continueMigration from "@opencode-ai/core/database/migration/20260812100000_goal_continue_on_error"
import { SessionGoalTable } from "@opencode-ai/core/session/goal.sql"

// 两次独立内存连接分别验证升级与新库，不能复制SQL自证或触碰全局数据库。
const run = (body: Effect.Effect<void, unknown, SqlClient>) =>
  Effect.runPromise(body.pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })), Effect.scoped))

describe("goal continue_on_error migration", () => {
  test("runs real upgrade and fresh initialization while preserving goal data", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* EffectDrizzleSqlite.makeWithDefaults()
        // 仅提供真实Goal建表迁移所需的父表，其余结构由生产工件创建。
        yield* db.run(sql`CREATE TABLE session (id text PRIMARY KEY)`)
        yield* db.run(sql`INSERT INTO session (id) VALUES ('ses_test')`)
        yield* db.transaction(goalMigration.up)
        yield* db.run(sql`INSERT INTO session_goal (session_id, id, objective, status, token_budget, tokens_used, time_used_seconds, time_created, time_updated) VALUES ('ses_test', 'goal_1', 'test objective', 'active', 50000, 1000, 30, 1, 1)`)
        // journal与ALTER都走实际迁移owner，旧行默认关闭且所有原字段保持。
        yield* DatabaseMigration.applyOnly(db, [continueMigration])
        expect(yield* db.get(sql`SELECT * FROM session_goal WHERE session_id = 'ses_test'`)).toEqual({
          session_id: "ses_test", id: "goal_1", objective: "test objective", status: "active",
          token_budget: 50000, tokens_used: 1000, time_used_seconds: 30, time_created: 1, time_updated: 1,
          continue_on_error: 0,
        })
        expect(migrations).toContain(continueMigration)
        yield* db.run(sql`UPDATE session_goal SET continue_on_error = 1 WHERE session_id = 'ses_test'`)
        yield* DatabaseMigration.applyOnly(db, [continueMigration])
        // 重复初始化不重放ALTER或重置值，真实Drizzle列按boolean解码。
        expect((yield* db.select().from(SessionGoalTable).get())?.continue_on_error).toBe(true)
        expect(yield* db.all(sql`SELECT id FROM migration`)).toEqual([{ id: continueMigration.id }])
      }),
    )
    await run(
      Effect.gen(function* () {
        const db = yield* EffectDrizzleSqlite.makeWithDefaults()
        // 新库使用fresh schema并登记迁移，不执行ALTER；两条路径必须得到同一列。
        yield* DatabaseMigration.apply(db)
        const columns = yield* db.all<{ name: string; notnull: number; dflt_value: string }>(sql`PRAGMA table_info(session_goal)`)
        expect(columns.find((column) => column.name === "continue_on_error")).toMatchObject({ notnull: 1, dflt_value: "false" })
        yield* DatabaseMigration.apply(db)
        expect(yield* db.all(sql`SELECT id FROM migration WHERE id = ${continueMigration.id}`)).toEqual([{ id: continueMigration.id }])
      }),
    )
  })
})
