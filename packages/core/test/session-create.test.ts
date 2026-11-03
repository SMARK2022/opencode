import { describe, expect } from "bun:test"
import path from "path"
import { DateTime, Effect, Layer, Stream } from "effect"
import { AgentV2 } from "@opencode-ai/core/agent"
import { asc, eq } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { EventTable } from "@opencode-ai/core/event/sql"
import { Location } from "@opencode-ai/core/location"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { AbsolutePath, RelativePath } from "@opencode-ai/core/schema"
import { SessionPath } from "@opencode-ai/core/session/path"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Prompt } from "@opencode-ai/core/session/prompt"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionInput } from "@opencode-ai/core/session/input"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SessionStore } from "@opencode-ai/core/session/store"
import { WorkspaceV2 } from "@opencode-ai/core/workspace"
import { testEffect } from "./lib/effect"
import { tmpdir } from "./fixture/tmpdir"

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
const id = SessionV2.ID.create()

describe("SessionV2.create", () => {
  it.effect("lists related project subpaths without widening exact directories", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const db = (yield* Database.Service).db
      const projectID = ProjectV2.ID.make("1".repeat(40))
      const otherID = ProjectV2.ID.make("2".repeat(40))
      const workspaceID = WorkspaceV2.ID.make("wrk_related")
      const otherWorkspace = WorkspaceV2.ID.make("wrk_other")
      const outer = path.resolve("/scope")
      const repo = path.join(outer, "repo")
      const child = path.join(repo, "packages", "a")
      const foreign = path.resolve("/unrelated")
      yield* db
        .insert(ProjectTable)
        .values([
          { id: projectID, worktree: AbsolutePath.make(repo), sandboxes: [] },
          { id: otherID, worktree: AbsolutePath.make(foreign), sandboxes: [] },
          { id: ProjectV2.ID.global, worktree: AbsolutePath.make(path.parse(repo).root), sandboxes: [] },
        ])
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      const rows = [
        { title: "root", project_id: projectID, directory: repo, path: "" },
        { title: "parent", project_id: projectID, directory: path.join(repo, "packages"), path: "packages" },
        { title: "current", project_id: projectID, directory: child, path: "packages/a" },
        { title: "deeper", project_id: projectID, directory: path.join(child, "src"), path: "packages/a/src" },
        { title: "sibling", project_id: projectID, directory: path.join(repo, "packages", "b"), path: "packages/b" },
        {
          title: "global-parent",
          project_id: ProjectV2.ID.global,
          directory: outer,
          path: SessionPath.relative("/", outer),
        },
        { title: "legacy", project_id: projectID, directory: child, path: null },
        { title: "cross-owner-parent", project_id: otherID, directory: path.join(repo, "packages"), path: null },
        {
          title: "global-alias",
          project_id: ProjectV2.ID.global,
          directory: foreign,
          path: SessionPath.relative("/", outer).replace(/^[A-Za-z]:\//, ""),
        },
        { title: "unrelated", project_id: otherID, directory: foreign, path: "unrelated" },
        { title: "unrelated-child", project_id: otherID, directory: path.join(foreign, "child"), path: "child" },
        { title: "other-workspace", project_id: projectID, directory: child, path: "packages/a" },
      ]
      // 同一创建时间强制验证 ID 破同分和双向 cursor；数据只进入隔离测试数据库。
      yield* db
        .insert(SessionTable)
        .values(
          rows.map((row, index) => ({
            ...row,
            id: SessionV2.ID.make(`ses_related_${String(index).padStart(2, "0")}`),
            slug: row.title,
            version: "test",
            workspace_id: index === rows.length - 1 ? otherWorkspace : workspaceID,
            time_created: 1000,
            time_updated: 1000,
          })),
        )
        .run()
        .pipe(Effect.orDie)
      const query = { project: projectID, subpath: RelativePath.make("packages/a"), workspaceID, order: "asc" as const }
      const all = yield* session.list(query)
      expect(all.map((item) => item.title)).toEqual([
        "root",
        "parent",
        "current",
        "deeper",
        "global-parent",
        "legacy",
        "cross-owner-parent",
        "global-alias",
      ])
      expect((yield* session.list({ ...query, search: "current" })).map((item) => item.title)).toEqual(["current"])
      expect(
        (yield* session.list({ directory: AbsolutePath.make(child), workspaceID, order: "asc" })).map(
          (item) => item.title,
        ),
      ).toEqual(["current", "legacy"])
      const wholeProject = yield* session.list({ project: projectID, order: "asc" })
      expect(wholeProject.map((item) => item.title)).toEqual([
        "root",
        "parent",
        "current",
        "deeper",
        "sibling",
        "legacy",
        "other-workspace",
      ])
      expect((yield* session.list({ ...query, subpath: RelativePath.make("") })).map((item) => item.title)).toContain(
        "sibling",
      )
      const first = yield* session.list({ ...query, limit: 2 })
      const edge = first.at(-1)
      if (!edge) return yield* Effect.die("Missing first related page")
      const next = yield* session.list({
        ...query,
        limit: 2,
        anchor: { id: edge.id, time: DateTime.toEpochMillis(edge.time.created), direction: "next" },
      })
      expect(next.map((item) => item.id)).toEqual(all.slice(2, 4).map((item) => item.id))
      const back = next[0]
      if (!back) return yield* Effect.die("Missing next related page")
      expect(
        (yield* session.list({
          ...query,
          limit: 2,
          anchor: { id: back.id, time: DateTime.toEpochMillis(back.time.created), direction: "previous" },
        })).map((item) => item.id),
      ).toEqual(first.map((item) => item.id))

      // 同一真实查询覆盖home全局视图，环境只在当前测试作用域内切换并恢复。
      const previousHome = process.env.OPENCODE_TEST_HOME
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          if (previousHome === undefined) delete process.env.OPENCODE_TEST_HOME
          if (previousHome !== undefined) process.env.OPENCODE_TEST_HOME = previousHome
        }),
      )
      process.env.OPENCODE_TEST_HOME = child
      const home = yield* session.list(query)
      expect(home.map((item) => item.title)).toEqual([
        "root",
        "parent",
        "current",
        "deeper",
        "sibling",
        "global-parent",
        "legacy",
        "cross-owner-parent",
        "global-alias",
        "unrelated",
        "unrelated-child",
      ])
      expect((yield* session.list({ ...query, search: "unrelated", limit: 1 })).map((item) => item.title)).toEqual([
        "unrelated",
      ])
      expect(
        (yield* session.list({ directory: AbsolutePath.make(child), workspaceID, order: "asc" })).map(
          (item) => item.title,
        ),
      ).toEqual(["current", "legacy"])
      // 配置HOME隔离时，会话仍按源用户目录识别，过滤继续由同一真实SQL执行。
      const previousSessionHome = process.env.OPENCODE_SESSION_HOME
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          if (previousSessionHome === undefined) delete process.env.OPENCODE_SESSION_HOME
          if (previousSessionHome !== undefined) process.env.OPENCODE_SESSION_HOME = previousSessionHome
        }),
      )
      process.env.OPENCODE_SESSION_HOME = child
      process.env.OPENCODE_TEST_HOME = foreign
      expect((yield* session.list(query)).map((item) => item.title)).toEqual(home.map((item) => item.title))
      expect((yield* session.list({ ...query, search: "unrelated", limit: 1 })).map((item) => item.title)).toEqual([
        "unrelated",
      ])
      expect(
        (yield* session.list({ directory: AbsolutePath.make(child), workspaceID, order: "asc" })).map(
          (item) => item.title,
        ),
      ).toEqual(["current", "legacy"])
      // 非home视图只并入源home本身，不连带展开它的子目录或整个其他项目。
      process.env.OPENCODE_SESSION_HOME = foreign
      const isolated = (yield* session.list(query)).map((item) => item.title)
      expect(isolated).toContain("unrelated")
      expect(isolated).not.toContain("unrelated-child")
      expect((yield* session.list({ project: projectID, workspaceID })).map((item) => item.title)).not.toContain(
        "unrelated",
      )
      if (previousSessionHome === undefined) delete process.env.OPENCODE_SESSION_HOME
      if (previousSessionHome !== undefined) process.env.OPENCODE_SESSION_HOME = previousSessionHome
      // 非home查询只并入home本身，不能把其子目录或其他兄弟目录一并展开。
      process.env.OPENCODE_TEST_HOME = foreign
      const outside = (yield* session.list(query)).map((item) => item.title)
      expect(outside).toContain("unrelated")
      expect(outside).not.toContain("unrelated-child")
      expect(outside).not.toContain("sibling")
      expect((yield* session.list({ project: projectID, workspaceID })).map((item) => item.title)).not.toContain(
        "unrelated",
      )
      if (process.platform === "win32") {
        // 历史Windows拼写与派生绝对cwd应命中同一home，不能再受盘符或尾斜杠分裂影响。
        process.env.OPENCODE_TEST_HOME = child.replaceAll("\\", "/").toUpperCase() + "/"
        expect((yield* session.list(query)).map((item) => item.title)).toContain("unrelated")
      }
      // 创建更晚但早已不活跃的行排在前面，证明更新时间过滤必须发生在LIMIT之前。
      const timedDirectory = AbsolutePath.make(path.join(child, "timed"))
      const timed = [
        { title: "inactive", time_created: 3000, time_updated: 999 },
        { title: "edge", time_created: 2000, time_updated: 1000 },
        { title: "active-old", time_created: 1000, time_updated: 1001 },
        { title: "other-workspace", time_created: 4000, time_updated: 2000 },
      ]
      yield* db
        .insert(SessionTable)
        .values(
          timed.map((row, index) => ({
            ...row,
            id: SessionV2.ID.make(`ses_timed_${index}`),
            slug: row.title,
            version: "test",
            project_id: projectID,
            directory: timedDirectory,
            path: "packages/a/timed",
            workspace_id: index === 3 ? otherWorkspace : workspaceID,
          })),
        )
        .run()
        .pipe(Effect.orDie)
      const window = { directory: timedDirectory, workspaceID, start: 1000, limit: 1 }
      expect(
        (yield* session.list({ directory: timedDirectory, workspaceID, limit: 1 })).map((row) => row.title),
      ).toEqual(["inactive"])
      const head = yield* session.list(window)
      expect(head.map((row) => row.title)).toEqual(["edge"])
      expect((yield* session.list({ ...window, start: 1001 })).map((row) => row.title)).toEqual(["active-old"])
      expect(yield* session.list({ ...window, start: 1002 })).toEqual([])
      const timeEdge = head[0]
      if (!timeEdge) return yield* Effect.die("Missing time-filtered first page")
      const tail = yield* session.list({
        ...window,
        anchor: { id: timeEdge.id, time: DateTime.toEpochMillis(timeEdge.time.created), direction: "next" },
      })
      expect(tail.map((row) => row.title)).toEqual(["active-old"])
      const end = tail[0]
      if (!end) return yield* Effect.die("Missing time-filtered next page")
      expect(
        (yield* session.list({
          ...window,
          anchor: { id: end.id, time: DateTime.toEpochMillis(end.time.created), direction: "previous" },
        })).map((row) => row.id),
      ).toEqual(head.map((row) => row.id))
    }),
  )

  it.effect("creates a fresh projected session when the ID is omitted", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service

      const first = yield* session.create({ location })
      const second = yield* session.create({ location })

      expect(second.id).not.toBe(first.id)
      expect(yield* session.list()).toHaveLength(2)
    }),
  )

  it.effect("returns the original session when the ID is retried", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const input = { id, location }

      const first = yield* session.create(input)
      const retried = yield* session.create(input)

      expect(retried).toEqual(first)
      expect(yield* session.list()).toEqual([first])
    }),
  )

  it.effect("stores supplied immutable create attributes", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const workspaceID = WorkspaceV2.ID.make("wrk_test")
      const model = ModelV2.Ref.make({
        id: ModelV2.ID.make("sonnet"),
        providerID: ProviderV2.ID.anthropic,
        variant: ModelV2.VariantID.make("fast"),
      })

      expect(
        yield* session.create({
          location: Location.Ref.make({ directory: location.directory, workspaceID }),
          agent: AgentV2.ID.make("build"),
          model,
        }),
      ).toMatchObject({ location: { directory: location.directory, workspaceID }, agent: "build", model })
    }),
  )

  it.effect("returns the existing Session when one ID is reused with different create arguments", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const created = yield* session.create({ id, location })
      const changed = [
        { id, location: Location.Ref.make({ directory: AbsolutePath.make("/other") }) },
        { id, location, agent: AgentV2.ID.make("build") },
        {
          id,
          location,
          model: ModelV2.Ref.make({ id: ModelV2.ID.make("sonnet"), providerID: ProviderV2.ID.anthropic }),
        },
      ]

      for (const input of changed) {
        expect(yield* session.create(input)).toEqual(created)
      }
      expect(yield* session.list()).toHaveLength(1)
    }),
  )

  it.effect("returns one recorded session to concurrent exact retries", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const input = { id, location }

      const created = yield* Effect.all([session.create(input), session.create(input)], { concurrency: "unbounded" })

      expect(created[1]).toEqual(created[0])
      expect(yield* session.list()).toEqual([created[0]])
    }),
  )

  it.effect("returns the current Session projection after updates", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const { db } = yield* Database.Service
      const input = { id, location }
      const created = yield* session.create(input)

      yield* db.update(SessionTable).set({ agent: "build" }).where(eq(SessionTable.id, id)).run().pipe(Effect.orDie)

      expect(yield* session.create(input)).toMatchObject({ id: created.id, agent: "build" })
    }),
  )

  it.effect("returns the current Session projection after projected updates", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const input = { id, location }
      const created = yield* session.create(input)

      yield* events.publish(SessionV1.Event.Updated, {
        sessionID: id,
        info: SessionV1.SessionInfo.make({
          id,
          slug: "updated",
          version: "test",
          projectID: created.projectID,
          directory: created.location.directory,
          title: "updated",
          agent: "build",
          time: { created: 0, updated: 1 },
        }),
      })

      expect(yield* session.create(input)).toMatchObject({ id, agent: "build" })
      const store = yield* SessionStore.Service
      const db = (yield* Database.Service).db
      yield* db
        .update(SessionTable)
        .set({ cost: 3, tokens_input: 4, metadata: { custom: "keep" } })
        .where(eq(SessionTable.id, id))
        .run()
        .pipe(Effect.orDie)
      const permissions = [{ action: "bash", resource: "*", effect: "auto" as const }]
      // 真正调用Session setter并重读wire、投影及事件；不运行任何子会话或后台job。
      yield* session.setPermissions({ sessionID: id, permissions })
      expect(yield* store.permissions(id)).toEqual(permissions)
      expect(
        yield* db.select().from(SessionTable).where(eq(SessionTable.id, id)).get().pipe(Effect.orDie),
      ).toMatchObject({
        agent: "build",
        title: "updated",
        slug: "updated",
        cost: 3,
        tokens_input: 4,
        metadata: { custom: "keep" },
        permission: [{ permission: "bash", pattern: "*", action: "auto" }],
        time_created: 0,
      })
      const recorded = yield* db
        .select()
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, id))
        .orderBy(asc(EventTable.seq))
        .all()
        .pipe(Effect.orDie)
      expect(recorded.at(-1)).toMatchObject({
        type: EventV2.versionedType(SessionV1.Event.Updated.type, 1),
        data: { info: { title: "updated", permission: [{ permission: "bash", pattern: "*", action: "auto" }] } },
      })
      // 恢复是替换而非累加，空集合也必须清掉旧grant。
      yield* session.setPermissions({
        sessionID: id,
        permissions: [{ action: "read", resource: "blocked/*", effect: "deny" }],
      })
      expect(yield* store.permissions(id)).toEqual([{ action: "read", resource: "blocked/*", effect: "deny" }])
      yield* session.setPermissions({ sessionID: id, permissions: [] })
      expect(yield* store.permissions(id)).toEqual([])
      expect(yield* session.get(id)).toMatchObject({ id, title: "updated", agent: "build" })
    }),
  )

  it.effect("persists creation through the existing legacy created event", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const { db } = yield* Database.Service
      const created = yield* session.create({ location })

      expect(
        yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, created.id)).all().pipe(Effect.orDie),
      ).toMatchObject([{ type: EventV2.versionedType(SessionV1.Event.Created.type, 1) }])
    }),
  )

  it.effect("persists caller-ID creation through the existing created event", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const { db } = yield* Database.Service
      const created = yield* session.create({ id, location })

      expect(
        yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, created.id)).get().pipe(Effect.orDie),
      ).toMatchObject({
        data: { sessionID: id },
      })
    }),
  )

  it.effect("omits legacy creation rows from the V2 Session event stream", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const created = yield* session.create({ location })
      yield* session.prompt({ sessionID: created.id, prompt: Prompt.make({ text: "Hello" }), resume: false })
      yield* SessionInput.promoteSteers(db, events, created.id, Number.MAX_SAFE_INTEGER)

      expect(
        Array.from(yield* session.events({ sessionID: created.id }).pipe(Stream.take(2), Stream.runCollect)),
      ).toMatchObject([
        { durable: { seq: 1 }, type: "session.next.prompt.admitted", data: { prompt: { text: "Hello" } } },
        { durable: { seq: 2 }, type: "session.next.prompted" },
      ])
    }),
  )

  it.effect("replays one prompt lifecycle into a fresh target database", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const sourceEvents = yield* EventV2.Service
      const sourceDb = (yield* Database.Service).db
      const created = yield* session.create({ id: SessionV2.ID.make("ses_fresh_target_replay"), location })
      const admitted = yield* session.prompt({
        sessionID: created.id,
        prompt: Prompt.make({ text: "Replay lifecycle" }),
        resume: false,
      })
      yield* SessionInput.promoteSteers(sourceDb, sourceEvents, created.id, Number.MAX_SAFE_INTEGER)
      const serialized = (yield* sourceDb
        .select()
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, created.id))
        .orderBy(asc(EventTable.seq))
        .all()
        .pipe(Effect.orDie)).map((event) => ({
        id: event.id,
        aggregateID: event.aggregate_id,
        seq: event.seq,
        type: event.type,
        data: event.data,
      }))

      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      )
      const targetDatabase = Database.layerFromPath(path.join(tmp.path, "target.sqlite"))
      const targetLayer = AppNodeBuilder.build(
        LayerNode.group([Database.node, EventV2.node, SessionProjector.node, SessionStore.node]),
        [[Database.node, targetDatabase]],
      )

      yield* Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const events = yield* EventV2.Service
        const store = yield* SessionStore.Service
        yield* db
          .insert(ProjectTable)
          .values({ id: ProjectV2.ID.global, worktree: location.directory, sandboxes: [] })
          .run()
          .pipe(Effect.orDie)

        expect(yield* store.get(created.id)).toBeUndefined()
        expect(yield* events.replayAll(serialized.slice(0, 2))).toBe(created.id)
        expect(yield* SessionInput.find(db, admitted.id)).toMatchObject({
          id: admitted.id,
          sessionID: created.id,
          prompt: { text: "Replay lifecycle" },
          delivery: "steer",
          admittedSeq: 1,
        })
        expect(yield* store.context(created.id)).toEqual([])

        expect(yield* events.replayAll(serialized.slice(2))).toBe(created.id)
        expect(yield* SessionInput.find(db, admitted.id)).toMatchObject({
          id: admitted.id,
          sessionID: created.id,
          prompt: { text: "Replay lifecycle" },
          delivery: "steer",
          admittedSeq: 1,
          promotedSeq: 2,
        })
        expect(yield* store.context(created.id)).toMatchObject([
          { id: admitted.id, type: "user", text: "Replay lifecycle" },
        ])
        expect(
          (yield* db
            .select()
            .from(EventTable)
            .where(eq(EventTable.aggregate_id, created.id))
            .orderBy(asc(EventTable.seq))
            .all()
            .pipe(Effect.orDie)).map((event) => [event.seq, event.type]),
        ).toEqual([
          [0, EventV2.versionedType(SessionV1.Event.Created.type, 1)],
          [1, EventV2.versionedType(SessionEvent.PromptAdmitted.type, 1)],
          [2, EventV2.versionedType(SessionEvent.Prompted.type, 1)],
        ])
      }).pipe(Effect.provide(Layer.fresh(targetLayer)))
    }),
  )

  it.effect("does not mask unrelated created projector defects", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const event = yield* EventV2.Service
      const defect = new Error("unrelated projector defect")
      yield* event.project(SessionV1.Event.Created, () => Effect.die(defect))

      expect(yield* session.create({ id, location }).pipe(Effect.catchDefect(Effect.succeed))).toBe(defect)
    }),
  )

  it.effect("reports unfinished Session operations as unavailable", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const created = yield* session.create({ location })
      const unavailable = (
        effect: Effect.Effect<void, SessionV2.NotFoundError | SessionV2.OperationUnavailableError>,
      ) =>
        effect.pipe(
          Effect.flip,
          Effect.map((error) => (error instanceof SessionV2.OperationUnavailableError ? error.operation : "not-found")),
        )

      expect(yield* unavailable(session.shell({ sessionID: created.id, command: "pwd" }))).toBe("shell")
      expect(yield* unavailable(session.skill({ sessionID: created.id, skill: "review" }))).toBe("skill")
    }),
  )

  it.effect("switches the selected agent through the durable Session event", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const created = yield* session.create({ location })

      yield* session.switchAgent({ sessionID: created.id, agent: "plan" })

      expect(yield* session.get(created.id)).toMatchObject({ agent: "plan" })
      expect(
        Array.from(yield* session.events({ sessionID: created.id }).pipe(Stream.take(1), Stream.runCollect)),
      ).toMatchObject([{ type: "session.next.agent.switched", data: { agent: "plan" } }])
    }),
  )

  it.effect("rejects an agent switch for a missing Session", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const missing = SessionV2.ID.make("ses_missing_agent_switch")

      expect(
        yield* session.switchAgent({ sessionID: missing, agent: "plan" }).pipe(
          Effect.flip,
          Effect.map((error) => error._tag),
        ),
      ).toBe("Session.NotFoundError")
    }),
  )

  it.effect("switches the selected model through the durable Session event", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const created = yield* session.create({ location })
      const model = ModelV2.Ref.make({
        id: ModelV2.ID.make("sonnet"),
        providerID: ProviderV2.ID.anthropic,
        variant: ModelV2.VariantID.make("high"),
      })

      yield* session.switchModel({ sessionID: created.id, model })

      expect(yield* session.get(created.id)).toMatchObject({ model })
      expect(
        Array.from(yield* session.events({ sessionID: created.id }).pipe(Stream.take(1), Stream.runCollect)),
      ).toMatchObject([{ type: "session.next.model.switched", data: { model } }])
    }),
  )

  it.effect("ignores a model switch when the selected model is unchanged", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const created = yield* session.create({ location })
      const model = ModelV2.Ref.make({ id: ModelV2.ID.make("sonnet"), providerID: ProviderV2.ID.anthropic })

      yield* session.switchModel({ sessionID: created.id, model })
      yield* session.switchModel({ sessionID: created.id, model })

      const { db } = yield* Database.Service
      expect(
        yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, created.id)).all().pipe(Effect.orDie),
      ).toHaveLength(2)
      expect(yield* session.get(created.id)).toMatchObject({ model })
    }),
  )

  it.effect("treats an omitted variant as the default variant", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const model = ModelV2.Ref.make({ id: ModelV2.ID.make("sonnet"), providerID: ProviderV2.ID.anthropic })
      const created = yield* session.create({ location, model })

      yield* session.switchModel({
        sessionID: created.id,
        model: ModelV2.Ref.make({ ...model, variant: ModelV2.VariantID.make("default") }),
      })

      const { db } = yield* Database.Service
      expect(
        yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, created.id)).all().pipe(Effect.orDie),
      ).toHaveLength(1)
    }),
  )

  it.effect("rejects a model switch for a missing Session", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const missing = SessionV2.ID.make("ses_missing_model_switch")

      expect(
        yield* session
          .switchModel({
            sessionID: missing,
            model: ModelV2.Ref.make({ id: ModelV2.ID.make("sonnet"), providerID: ProviderV2.ID.anthropic }),
          })
          .pipe(
            Effect.flip,
            Effect.map((error) => error._tag),
          ),
      ).toBe("Session.NotFoundError")
    }),
  )
})
