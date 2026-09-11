import { expect } from "bun:test"
import { eq } from "drizzle-orm"
import { DateTime, Effect, Schema } from "effect"
import { adjust, setTime } from "effect/testing/TestClock"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionContextEpoch } from "@opencode-ai/core/session/context-epoch"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionContextEpochTable, SessionMessageTable, SessionTable } from "@opencode-ai/core/session/sql"
import { SystemContext } from "@opencode-ai/core/system-context"
import { testEffect } from "../lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, SessionProjector.node])))

it.effect("persists frozen Session Git across reload, dates and committed rewind", () => Effect.gen(function* () {
  yield* setTime(Date.parse("2026-09-11T12:00:00Z"))
  const db = (yield* Database.Service).db
  const events = yield* EventV2.Service
  const firstID = SessionSchema.ID.make("ses_epoch_first")
  const secondID = SessionSchema.ID.make("ses_epoch_second")
  yield* db.insert(ProjectTable).values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] }).run()
  yield* db.insert(SessionTable).values([firstID, secondID].map(id => ({ id, project_id: Project.ID.global,
    slug: id, directory: "/project", title: "context", version: "test" }))).run()
  let currentGit = "git:first"
  let loads = 0
  // 每次构造新carrier模拟服务层重建；冻结事实只能来自数据库而非闭包缓存。
  const context = () => Effect.succeed(SystemContext.combine([
    SystemContext.make({ key: SystemContext.Key.make("core/git"), codec: Schema.toCodecJson(Schema.String), lifetime: "session",
      load: Effect.sync(() => { loads++; return currentGit }), baseline: text => text, update: (_old, text) => text }),
    SystemContext.make({ key: SystemContext.Key.make("core/date"), codec: Schema.toCodecJson(Schema.String),
      load: DateTime.nowAsDate.pipe(Effect.map(date => date.toDateString())),
      baseline: date => `Today's date: ${date}`, update: (_old, date) => `Today's date is now: ${date}` }),
  ]))
  const first = yield* SessionContextEpoch.prepare(db, events, context(), firstID)
  expect(loads).toBe(1)
  const boundary = SessionMessage.ID.make("msg_epoch_boundary")
  yield* events.publish(SessionEvent.ContextUpdated, { sessionID: firstID, messageID: boundary,
    timestamp: yield* DateTime.now, text: "boundary" })
  currentGit = "git:second"
  expect(yield* SessionContextEpoch.prepare(db, events, context(), firstID)).toEqual(first)
  yield* adjust(25 * 60 * 60 * 1000)
  const day2 = yield* SessionContextEpoch.prepare(db, events, context(), firstID)
  expect(day2.baseline).toBe(first.baseline)
  const rows = yield* db.select().from(SessionMessageTable).all()
  expect(rows).toHaveLength(2)
  expect(JSON.stringify(rows.at(-1)?.data)).toContain("Today's date is now:")
  expect(yield* SessionContextEpoch.prepare(db, events, context(), firstID)).toEqual(day2)
  expect(yield* db.select().from(SessionMessageTable).all()).toHaveLength(2)
  expect(loads).toBe(1)
  const second = yield* SessionContextEpoch.prepare(db, events, context(), secondID)
  expect(second.baseline).toContain("git:second")
  expect(loads).toBe(2)
  const stored = yield* db.select().from(SessionContextEpochTable).where(eq(SessionContextEpochTable.session_id, firstID)).get()
  const snapshot = Schema.decodeUnknownSync(Schema.Struct({ sources: SystemContext.Snapshot }))(JSON.parse(JSON.stringify(stored?.snapshot)))
  expect(snapshot.sources[SystemContext.Key.make("core/git")]?.value).toBe("git:first")
  currentGit = "git:third"
  // replacement同样读取已保存Git，但日期仍是当前值，不冻结整个上下文。
  expect(yield* SystemContext.replace(yield* context(), snapshot.sources)).toMatchObject({
    _tag: "ReplacementReady", generation: { baseline: expect.stringContaining("git:first") },
  })
  yield* events.publish(SessionEvent.RevertEvent.Committed, { sessionID: firstID, messageID: boundary,
    timestamp: yield* DateTime.now })
  expect(yield* db.select().from(SessionMessageTable).all()).toHaveLength(1)
  const rebuilt = yield* SessionContextEpoch.prepare(db, events, context(), firstID)
  expect(rebuilt.baseline).not.toBe(first.baseline)
  expect(rebuilt.baseline).toContain("git:first")
  expect(rebuilt.baseline).toContain(`Today's date: ${(yield* DateTime.nowAsDate).toDateString()}`)
  expect(loads).toBe(2)
  const final = yield* db.select().from(SessionContextEpochTable).where(eq(SessionContextEpochTable.session_id, firstID)).get()
  expect(final?.snapshot).toMatchObject({ sources: { "core/git": { value: "git:first" } } })
  expect(final?.snapshot).not.toHaveProperty("anchor")
  expect(yield* SessionContextEpoch.prepare(db, events, context(), firstID)).toEqual(rebuilt)
}))
