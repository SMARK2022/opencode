import { describe, expect } from "bun:test"
import { DateTime, Effect, Layer, Schema } from "effect"
import { asc, eq } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { Location } from "@opencode-ai/core/location"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionStore } from "@opencode-ai/core/session/store"
import { SessionMessageTable, SessionTable } from "@opencode-ai/core/session/sql"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { testEffect } from "./lib/effect"
import { SessionHistory } from "../src/session/history"

const projects = Layer.succeed(
  ProjectV2.Service,
  ProjectV2.Service.of({
    resolve: (directory) => Effect.succeed({ id: ProjectV2.ID.global, directory }),
    directories: () => Effect.succeed([]),
    commit: () => Effect.void,
  }),
)
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, EventV2.node, SessionProjector.node, SessionStore.node, SessionV2.node]),
    [
      [ProjectV2.node, projects],
      [SessionExecution.node, SessionExecution.noopLayer],
    ],
  ),
)
const location = Location.Ref.make({ directory: AbsolutePath.make("/project") })

const GapEvent = EventV2.define({
  type: "test.session.history.gap",
  durable: { aggregate: "sessionID", version: 1 },
  schema: { sessionID: SessionV2.ID, value: Schema.String },
})

describe("SessionV2.history", () => {
  it.effect("returns an exhausted page for a migrated Session with no event sequence", () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const session = yield* SessionV2.Service
      const sessionID = SessionV2.ID.make("ses_empty_history")
      yield* db
        .insert(ProjectTable)
        .values({ id: ProjectV2.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .onConflictDoNothing()
        .run()
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: ProjectV2.ID.global,
          slug: "empty-history",
          directory: "/project",
          title: "Empty history",
          version: "test",
        })
        .run()

      const first = yield* session.history({ sessionID, limit: 10 })

      expect(first).toEqual({ events: [], hasMore: false })
    }),
  )

  it.effect("treats after as an exclusive aggregate sequence", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const created = yield* session.create({ location })
      yield* session.switchAgent({ sessionID: created.id, agent: "one" })
      yield* session.switchAgent({ sessionID: created.id, agent: "two" })

      const page = yield* session.history({ sessionID: created.id, after: 1, limit: 10 })

      expect(page.events.map((event) => event.durable?.seq)).toEqual([2])
      expect(page.hasMore).toBe(false)
    }),
  )

  it.effect("paginates public events in aggregate order across filtered gaps without duplicates", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const created = yield* session.create({ location })
      yield* session.switchAgent({ sessionID: created.id, agent: "one" })
      yield* events.publish(GapEvent, { sessionID: created.id, value: "filtered" })
      yield* session.switchAgent({ sessionID: created.id, agent: "two" })
      yield* session.switchAgent({ sessionID: created.id, agent: "three" })

      const first = yield* session.history({ sessionID: created.id, limit: 2 })
      const after = first.events.at(-1)?.durable?.seq
      const second = yield* session.history({
        sessionID: created.id,
        after,
        limit: 2,
      })
      const sequence = [...first.events, ...second.events].map((event) => event.durable?.seq)

      expect(first.hasMore).toBe(true)
      expect(second.hasMore).toBe(false)
      expect(sequence).toEqual([1, 3, 4])
      expect(new Set(sequence).size).toBe(sequence.length)
    }),
  )

  it.effect("includes events committed between pages", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const created = yield* session.create({ location })
      yield* session.switchAgent({ sessionID: created.id, agent: "one" })
      yield* session.switchAgent({ sessionID: created.id, agent: "two" })

      const first = yield* session.history({ sessionID: created.id, limit: 1 })
      yield* session.switchAgent({ sessionID: created.id, agent: "later" })
      const second = yield* session.history({
        sessionID: created.id,
        after: first.events.at(-1)?.durable?.seq,
        limit: 10,
      })

      expect(first.hasMore).toBe(true)
      expect([...first.events, ...second.events].map((event) => event.durable?.seq)).toEqual([1, 2, 3])
      expect(second.hasMore).toBe(false)
    }),
  )

  it.effect("reports exhaustion for exact-limit and limit-plus-one pages", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const created = yield* session.create({ location })
      yield* session.switchAgent({ sessionID: created.id, agent: "one" })
      yield* session.switchAgent({ sessionID: created.id, agent: "two" })

      const exact = yield* session.history({ sessionID: created.id, limit: 2 })
      const oneMore = yield* session.history({ sessionID: created.id, limit: 1 })
      const exhausted = yield* session.history({
        sessionID: created.id,
        after: oneMore.events.at(-1)?.durable?.seq,
        limit: 1,
      })

      expect(exact.events).toHaveLength(2)
      expect(exact.hasMore).toBe(false)
      expect(oneMore.events).toHaveLength(1)
      expect(oneMore.hasMore).toBe(true)
      expect(exhausted.events).toHaveLength(1)
      expect(exhausted.hasMore).toBe(false)
    }),
  )

  it.effect("keeps hidden Native messages out of public pages and point reads while retaining raw history", () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const session = yield* SessionV2.Service
      const store = yield* SessionStore.Service
      const events = yield* EventV2.Service
      const created = yield* session.create({ location })
      const ids = Array.from({ length: 4 }, () => SessionMessage.ID.create())
      for (const [index, id] of ids.entries())
        yield* events.publish(SessionEvent.Synthetic, {
          sessionID: created.id, messageID: id, timestamp: DateTime.makeUnsafe(index), text: `visible-${index}`,
          ...(index === 2 ? { metadata: { hidden: { time: 0, reason: "unrelated" } } } : {}),
        })
      // 仅合法Native tombstone隐藏记录；其他metadata不误判，隐藏行不占正反向分页容量。
      yield* events.publish(SessionEvent.MessagesHidden, {
        sessionID: created.id, messageIDs: [ids[1], ids[3]], timestamp: DateTime.makeUnsafe(4),
        hidden: { time: 4, reason: "permission-reviewer-protocol-retry" },
      })
      const before = yield* db.select().from(SessionMessageTable).where(eq(SessionMessageTable.session_id, created.id)).orderBy(asc(SessionMessageTable.seq)).all().pipe(Effect.orDie)
      expect((yield* session.messages({ sessionID: created.id, limit: 1 })).map(message => message.id)).toEqual([ids[2]])
      expect((yield* session.messages({ sessionID: created.id, limit: 1, cursor: { id: ids[2], direction: "next" } })).map(message => message.id)).toEqual([ids[0]])
      expect((yield* session.messages({ sessionID: created.id, limit: 1, cursor: { id: ids[0], direction: "previous" } })).map(message => message.id)).toEqual([ids[2]])
      expect((yield* session.messages({ sessionID: created.id, order: "asc", limit: 2 })).map(message => message.id)).toEqual([ids[0], ids[2]])
      expect(yield* session.message({ sessionID: created.id, messageID: ids[3] })).toBeUndefined()
      expect(yield* session.message({ sessionID: created.id, messageID: ids[2] })).toMatchObject({ id: ids[2] })
      // raw Store仍服务审计/结构恢复；公开读取既不删除记录，也不重写元数据。
      expect((yield* store.message(ids[3], created.id))?.message).toMatchObject({ id: ids[3], metadata: { hidden: { reason: "permission-reviewer-protocol-retry" } } })
      expect(yield* db.select().from(SessionMessageTable).where(eq(SessionMessageTable.session_id, created.id)).orderBy(asc(SessionMessageTable.seq)).all().pipe(Effect.orDie)).toEqual(before)
      // 同毫秒原位修改必须让后缀重载；稳定前缀保留同一解码对象，而非只比较最终文本。
      const cache = SessionHistory.makeCache()
      const cold = yield* SessionHistory.entriesForRunner(db, created.id, -1, cache)
      const warm = yield* SessionHistory.entriesForRunner(db, created.id, -1, cache)
      expect(warm.map(entry => entry.message.id)).toEqual([ids[0], ids[2]])
      expect(warm[0]?.message).toBe(cold[0]?.message)
      expect(warm[1]?.message).toBe(cold[1]?.message)
      yield* db.update(SessionMessageTable).set({ data: Schema.encodeSync(SessionMessage.Synthetic)(SessionMessage.Synthetic.make({
        id: ids[2], sessionID: created.id, type: "synthetic", text: "changed", time: { created: DateTime.makeUnsafe(2) },
      })) }).where(eq(SessionMessageTable.id, ids[2])).run().pipe(Effect.orDie)
      const changed = yield* SessionHistory.entriesForRunner(db, created.id, -1, cache)
      expect(changed[0]?.message).toBe(cold[0]?.message)
      expect(changed[1]?.message).not.toBe(cold[1]?.message)
      expect(changed[1]?.message).toMatchObject({ text: "changed" })
      // 最新隐藏用户不得消耗limit(2)；普通技术Synthetic也不产生Goal turn。
      const turns = Array.from({ length: 3 }, () => SessionMessage.ID.create())
      for (const [index, id] of turns.entries()) yield* db.insert(SessionMessageTable).values({
        id, session_id: created.id, type: "user", seq: 100 + index,
        data: Schema.encodeSync(SessionMessage.User)(SessionMessage.User.make({
          id, type: "user", text: "goal", files: [], agents: [], time: { created: DateTime.makeUnsafe(5) },
          ...(index === 2 ? { metadata: { hidden: { time: 0, reason: "permission-reviewer-protocol-retry" } } } : {}),
        })),
      }).run().pipe(Effect.orDie)
      expect(yield* SessionHistory.goalTurn(db, created.id)).toEqual({ id: turns[1], previousID: turns[0], userInitiated: true })
    }),
  )

  it.effect("fails with NotFoundError for a missing Session", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const error = yield* session.history({ sessionID: SessionV2.ID.make("ses_missing"), limit: 10 }).pipe(Effect.flip)

      expect(error._tag).toBe("Session.NotFoundError")
    }),
  )
})
