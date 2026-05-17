import { expect, test } from "bun:test"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EffectDrizzleSqlite } from "@opencode-ai/effect-drizzle-sqlite"
import { Effect } from "effect"
import { sql } from "drizzle-orm"
import { DatabaseMigration } from "@opencode-ai/core/database/migration"
import migrateReviewAgent from "@opencode-ai/core/database/migration/20260725100000_migrate_review_agent"
import type { SqlClient as SqlClientService } from "effect/unstable/sql/SqlClient"

const run = <A, E>(effect: Effect.Effect<A, E, SqlClientService>) =>
  Effect.runPromise(
    effect.pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })), Effect.scoped),
  )

const makeDb = EffectDrizzleSqlite.makeWithDefaults()

// #159：review → interactive 数据迁移（目标不是 decide）
test("migrates persisted review agents to interactive", async () => {
  await run(
    Effect.gen(function* () {
      const db = yield* makeDb
      // 最小表结构，仅覆盖 migration 触及的列
      yield* db.run(sql`
        CREATE TABLE project (
          id text PRIMARY KEY,
          worktree text NOT NULL,
          vcs text,
          name text,
          time_created integer NOT NULL,
          time_updated integer NOT NULL,
          sandboxes text
        );
      `)
      yield* db.run(sql`
        CREATE TABLE session (
          id text PRIMARY KEY,
          project_id text NOT NULL,
          slug text NOT NULL,
          directory text NOT NULL,
          title text NOT NULL,
          version text NOT NULL,
          agent text,
          time_created integer NOT NULL,
          time_updated integer NOT NULL
        );
      `)
      yield* db.run(sql`
        CREATE TABLE message (
          id text PRIMARY KEY,
          session_id text NOT NULL,
          time_created integer NOT NULL,
          time_updated integer NOT NULL,
          data text NOT NULL
        );
      `)
      yield* db.run(sql`
        CREATE TABLE session_message (
          id text PRIMARY KEY,
          session_id text NOT NULL,
          type text NOT NULL,
          time_created integer NOT NULL,
          time_updated integer NOT NULL,
          data text NOT NULL
        );
      `)
      yield* db.run(sql`
        CREATE TABLE event_sequence (
          aggregate_id text PRIMARY KEY,
          seq integer NOT NULL
        );
      `)
      yield* db.run(sql`
        CREATE TABLE event (
          id text PRIMARY KEY,
          aggregate_id text NOT NULL,
          seq integer NOT NULL,
          type text NOT NULL,
          data text NOT NULL
        );
      `)
      yield* db.run(sql`
        CREATE TABLE request_usage (
          session_id text NOT NULL,
          request_id text NOT NULL,
          root_request_id text NOT NULL,
          source text NOT NULL,
          status text NOT NULL,
          agent text NOT NULL,
          provider_id text NOT NULL,
          model_id text NOT NULL,
          time_created integer NOT NULL,
          time_updated integer NOT NULL,
          PRIMARY KEY (session_id, request_id)
        );
      `)

      yield* db.run(sql`
        INSERT INTO project (id, worktree, vcs, name, time_created, time_updated, sandboxes)
        VALUES ('proj_review', '/tmp/review', 'git', 'Review Project', 1, 1, '[]');
      `)
      yield* db.run(sql`
        INSERT INTO session (id, project_id, slug, directory, title, version, agent, time_created, time_updated)
        VALUES ('ses_review', 'proj_review', 'review', '/tmp/review', 'Review', '1.0.0', 'review', 1, 1);
      `)
      yield* db.run(sql`
        INSERT INTO message (id, session_id, time_created, time_updated, data)
        VALUES (
          'msg_user_review',
          'ses_review',
          1,
          1,
          '{"role":"user","time":{"created":1},"agent":"review","model":{"providerID":"test","modelID":"test-model"}}'
        );
      `)
      yield* db.run(sql`
        INSERT INTO message (id, session_id, time_created, time_updated, data)
        VALUES (
          'msg_assistant_review',
          'ses_review',
          2,
          2,
          '{"role":"assistant","time":{"created":2},"parentID":"msg_user_review","mode":"review","agent":"review","path":{"cwd":"/tmp/review","root":"/tmp/review"},"cost":0,"tokens":{"input":0,"output":0,"reasoning":0,"cache":{"read":0,"write":0}},"modelID":"test-model","providerID":"test"}'
        );
      `)
      yield* db.run(sql`
        INSERT INTO session_message (id, session_id, type, time_created, time_updated, data)
        VALUES ('sm_review', 'ses_review', 'agent-switched', 1, 1, '{"agent":"review"}');
      `)
      yield* db.run(sql`INSERT INTO event_sequence (aggregate_id, seq) VALUES ('ses_review', 1);`)
      yield* db.run(sql`
        INSERT INTO event (id, aggregate_id, seq, type, data)
        VALUES ('evt_review', 'ses_review', 1, 'session.next.agent.switched', '{"agent":"review"}');
      `)
      yield* db.run(sql`
        INSERT INTO request_usage (
          session_id, request_id, root_request_id, source, status, agent, provider_id, model_id, time_created, time_updated
        ) VALUES ('ses_review', 'msg_user_review', 'msg_user_review', 'prompt', 'completed', 'review', 'test', 'test-model', 1, 1);
      `)

      yield* DatabaseMigration.applyOnly(db, [migrateReviewAgent])

      // 全部应落到 interactive，而非 decide
      expect(yield* db.get(sql`SELECT agent AS value FROM session WHERE id = 'ses_review'`)).toEqual({
        value: "interactive",
      })
      expect(
        yield* db.get(sql`SELECT agent AS value FROM request_usage WHERE request_id = 'msg_user_review'`),
      ).toEqual({ value: "interactive" })
      expect(
        yield* db.get(sql`SELECT json_extract(data, '$.agent') AS value FROM message WHERE id = 'msg_user_review'`),
      ).toEqual({ value: "interactive" })
      expect(
        yield* db.get(sql`SELECT json_extract(data, '$.agent') AS value FROM message WHERE id = 'msg_assistant_review'`),
      ).toEqual({ value: "interactive" })
      expect(
        yield* db.get(sql`SELECT json_extract(data, '$.mode') AS value FROM message WHERE id = 'msg_assistant_review'`),
      ).toEqual({ value: "interactive" })
      expect(
        yield* db.get(sql`SELECT json_extract(data, '$.agent') AS value FROM session_message WHERE id = 'sm_review'`),
      ).toEqual({ value: "interactive" })
      expect(yield* db.get(sql`SELECT json_extract(data, '$.agent') AS value FROM event WHERE id = 'evt_review'`)).toEqual(
        { value: "interactive" },
      )
    }),
  )
})
