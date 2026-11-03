import { expect, test } from "bun:test"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EffectDrizzleSqlite } from "@opencode-ai/effect-drizzle-sqlite"
import { Effect } from "effect"
import { sql } from "drizzle-orm"
import { DatabaseMigration } from "@opencode-ai/core/database/migration"
import requestMigration from "@opencode-ai/core/database/migration/20261009114905_session_request_usage"

test("resumes renamed migrations from named, timestamp-only and partially imported journals", async () => {
  for (const mode of ["named", "unnamed", "partial"] as const) {
    await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* EffectDrizzleSqlite.makeWithDefaults()
        // 用真实生产迁移建立旧表，迁移身份变化不得导致重复建表或丢失费用。
        yield* db.run(sql`CREATE TABLE session (id text PRIMARY KEY)`)
        yield* db.transaction(requestMigration.up)
        yield* db.run(sql`INSERT INTO session (id) VALUES ('session')`)
        yield* db.run(
          sql`INSERT INTO request_usage (session_id, request_id, root_request_id, source, status, agent, provider_id, model_id, tokens_total, cost_micros, time_created, time_updated) VALUES ('session', 'request', 'request', 'prompt', 'completed', 'build', 'provider', 'model', 1234, 5678, 1, 2)`,
        )
        const before = yield* db.all(sql`SELECT * FROM request_usage`)
        if (mode === "unnamed") {
          // 旧Drizzle版本仅有时间戳，仍须找到同一条迁移的历史身份。
          yield* db.run(sql`CREATE TABLE __drizzle_migrations (created_at integer)`)
          yield* db.run(sql`INSERT INTO __drizzle_migrations VALUES (${Date.UTC(2026, 3, 22, 13, 6, 33)})`)
        }
        if (mode !== "unnamed") {
          yield* db.run(sql`CREATE TABLE __drizzle_migrations (name text)`)
          yield* db.run(sql`INSERT INTO __drizzle_migrations VALUES ('20260422130633_request_usage_tracking')`)
        }
        if (mode === "partial") {
          // 失败启动已导入旧身份并完成部分新迁移，非空账本同样需要接续。
          yield* db.run(sql`CREATE TABLE migration (id text PRIMARY KEY, time_completed integer NOT NULL)`)
          yield* db.run(
            sql`INSERT INTO migration VALUES ('20260422130633_request_usage_tracking', 1), ('unrelated', 1)`,
          )
        }
        yield* DatabaseMigration.applyOnly(db, [requestMigration])
        expect(yield* db.all(sql`SELECT * FROM request_usage`)).toEqual(before)
        expect(yield* db.all(sql`SELECT id FROM migration WHERE id = ${requestMigration.id}`)).toEqual([
          { id: requestMigration.id },
        ])
        const completed = yield* db.all(sql`SELECT * FROM migration ORDER BY id`)
        // 第二次启动既不重跑DDL，也不重写完成时间和原账本。
        yield* DatabaseMigration.applyOnly(db, [requestMigration])
        expect(yield* db.all(sql`SELECT * FROM migration ORDER BY id`)).toEqual(completed)
        expect(yield* db.all(sql`SELECT * FROM request_usage`)).toEqual(before)
        expect(yield* db.get(sql`SELECT count(*) AS count FROM __drizzle_migrations`)).toEqual({ count: 1 })
      }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })), Effect.scoped),
    )
  }
})
