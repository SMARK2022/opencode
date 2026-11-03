import { expect } from "bun:test"
import { eq, sql } from "drizzle-orm"
import { Effect, Layer } from "effect"
import path from "node:path"
import { Database } from "@opencode-ai/core/database/database"
import { DatabaseMigration } from "@opencode-ai/core/database/migration"
import migration from "@opencode-ai/core/database/migration/20260911173121_session_context_epoch"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SessionContextEpoch } from "../../src/session/context-epoch"
import { MessageID, SessionID } from "../../src/session/schema"
import { tmpdir } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const memory = testEffect(LayerNode.compile(Database.node))
const isolated = testEffect(Layer.empty)
const seed = (id: SessionID) =>
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/context"), sandboxes: [] })
      .run()
    yield* db
      .insert(SessionTable)
      .values({
        id,
        project_id: Project.ID.global,
        slug: id,
        directory: "/context",
        title: "original title",
        version: "test",
        time_updated: 1234,
      })
      .run()
  })

memory.effect("context migration adds nullable storage without changing existing rows", () =>
  Effect.gen(function* () {
    const id = SessionID.make("ses_context_migration")
    yield* seed(id)
    const db = (yield* Database.Service).db
    // 从等价旧schema及已有行起步，走真实迁移journal，不手动写出目标列来冒充升级。
    yield* db.run(sql`ALTER TABLE session DROP COLUMN context_epoch`)
    yield* db.run(sql`DELETE FROM migration WHERE id = ${migration.id}`)
    yield* DatabaseMigration.applyOnly(db, [migration])
    expect(
      yield* db
        .select({ epoch: SessionTable.context_epoch, title: SessionTable.title, updated: SessionTable.time_updated })
        .from(SessionTable)
        .where(eq(SessionTable.id, id))
        .get(),
    ).toEqual({ epoch: null, title: "original title", updated: 1234 })
  }),
)

isolated.live("context epoch survives independent database layers on one isolated file", () =>
  Effect.acquireUseRelease(
    Effect.promise(() => tmpdir()),
    (tmp) =>
      Effect.gen(function* () {
        const file = path.join(tmp.path, "context.db")
        const id = SessionID.make("ses_context_file")
        const history = { boundary: "null", messageIDs: [MessageID.make("msg_seed")] }
        const first = yield* Effect.gen(function* () {
          yield* seed(id)
          return yield* SessionContextEpoch.prepare({
            sessionID: id,
            history,
            now: new Date("2026-09-11T12:00:00"),
            captureGit: Effect.succeed("git-A"),
          })
        }).pipe(Effect.provide(Database.layerFromPath(file)))
        // 新连接只从持久文件恢复；禁止第二次Git采集，避免通过共享闭包缓存得到假阳性。
        const second = yield* SessionContextEpoch.prepare({
          sessionID: id,
          history,
          now: new Date("2026-09-12T12:00:00"),
          captureGit: Effect.die("persisted Git must not be sampled again"),
        }).pipe(Effect.provide(Database.layerFromPath(file)))
        expect(second.snapshot["smark/git"].value).toBe("git-A")
        expect(second.baseline).toBe(first.baseline)
        expect(second.updates).toHaveLength(1)
        expect(second.updates[0]?.message.text).toContain("Today's date is now:")
        expect(second.updates[0]?.after_message_id).toBe(history.messageIDs[0])
      }),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  ),
)
