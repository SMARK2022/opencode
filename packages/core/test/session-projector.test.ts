import { describe, expect } from "bun:test"
import { DateTime, Effect, Layer, Schema } from "effect"
import { asc, eq, inArray, sql } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { DatabaseMigration } from "@opencode-ai/core/database/migration"
import stepUsageMigration from "@opencode-ai/core/database/migration/20260623000000_session_step_usage"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { EventV2 } from "@opencode-ai/core/event"
import { EventTable } from "@opencode-ai/core/event/sql"
import { ModelV2 } from "@opencode-ai/core/model"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { AbsolutePath, RelativePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { Prompt } from "@opencode-ai/core/session/prompt"
import { SessionMessageUpdater } from "@opencode-ai/core/session/message-updater"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionInput } from "@opencode-ai/core/session/input"
import { ColdStorageTable, PartTable, SessionInputTable, SessionMessageTable, SessionTable } from "@opencode-ai/core/session/sql"
import { searchCondition } from "@opencode-ai/core/session/search"
import { ColdStorage } from "@opencode-ai/core/storage/cold-storage"
import { SessionRequestUsage } from "@opencode-ai/core/session/request-usage"
import { RequestUsageTable, RequestUsageAssistantTable } from "@opencode-ai/core/session/request-usage.sql"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { testEffect } from "./lib/effect"
import { Snapshot } from "@opencode-ai/core/snapshot"
import { Location } from "@opencode-ai/core/location"
import { SessionHistory } from "@opencode-ai/core/session/history"
import { SessionPreview } from "@opencode-ai/core/session/preview"
import { ToolDiffs } from "@opencode-ai/core/session/tool-diffs"
import { SessionRevert } from "@opencode-ai/core/session/revert"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, SessionProjector.node])))
const previewIt = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, SessionProjector.node]),
  [[Database.node, Database.layerFromPath(":memory:")]]))
// 查询服务与写入fixture共用同一内存DB图，避免内层provide另建空库。
const listingIt = testEffect(AppNodeBuilder.build(
  LayerNode.group([Database.node, EventV2.node, SessionProjector.node, SessionV2.node]),
  [[Database.node, Database.layerFromPath(":memory:")], [SessionExecution.node, SessionExecution.noopLayer]]))
const sessionsLayer = AppNodeBuilder.build(SessionV2.node, [[SessionExecution.node, SessionExecution.noopLayer]])
const sessionID = SessionV2.ID.make("ses_projector_test")
const created = DateTime.makeUnsafe(0)
const model = { id: ModelV2.ID.make("model"), providerID: ProviderV2.ID.make("provider") }
const encodeMessage = Schema.encodeSync(SessionMessage.Message)

const assistantRow = (
  id: SessionMessage.ID,
  seq: number,
  time: { created: DateTime.Utc; completed?: DateTime.Utc } = { created },
) => {
  const {
    id: _,
    type,
    ...data
  } = encodeMessage(SessionMessage.Assistant.make({ id, type: "assistant", agent: "build", model, content: [], time }))
  return { id, session_id: sessionID, type, seq, time_created: DateTime.toEpochMillis(time.created), data }
}

describe("SessionProjector", () => {
  listingIt.effect("intersects Native list tokens across real titles and admitted user messages", () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const events = yield* EventV2.Service
      const ids = ["cross", "title", "body", "neither"].map(value => SessionV2.ID.make(`ses_search_${value}`))
      const titles = ["alpha-holder", "alpha-only-title", "body-holder", "unrelated-holder"]
      yield* db.insert(ProjectTable).values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] }).run()
      yield* db.insert(SessionTable).values(ids.map((id, index) => ({ id, project_id: Project.ID.global, slug: id, directory: "/project", title: titles[index], version: "test" }))).run()
      // 正文经过真实admission与提升，跨字段交集不能退化成标题内整串匹配。
      for (const [index, text] of [[0, "contains beta token"], [2, "alpha and beta together"]] as const) {
        const input = yield* SessionInput.admit(db, events, { sessionID: ids[index], id: SessionMessage.ID.make(`msg_search_${index}`), prompt: Prompt.make({ text }), delivery: "steer" })
        yield* SessionInput.promoteSteers(db, events, ids[index], input.admittedSeq)
      }
      const sessions = yield* SessionV2.Service
      const search = (query: string) => sessions.list({ search: query, limit: 1600 }).pipe(Effect.map(items => items.map(item => item.id).toSorted()))
      expect(yield* search("alpha beta")).toEqual([ids[0], ids[2]].toSorted())
      // 单词、大小写和空白仍用同一SQL谓词；空搜索不丢会话，零命中不回退。
      expect(yield* search(" ALPHA\t beta ")).toEqual([ids[0], ids[2]].toSorted())
      expect(yield* search("alpha")).toEqual(ids.slice(0, 3).toSorted())
      expect(yield* search("beta")).toEqual([ids[0], ids[2]].toSorted())
      expect(yield* search("alpha absent")).toEqual([])
      expect(yield* search(" \t ")).toEqual(ids.toSorted())
      // 首屏仅标题是刻意子集；真实Native正文继续由同一all谓词完整召回，不构建第二搜索器。
      const title = yield* db.select({ id: SessionTable.id }).from(SessionTable).where(searchCondition("alpha", { mode: "title" })).all().pipe(Effect.orDie)
      expect(title.map(row => row.id).toSorted()).toEqual(ids.slice(0, 2).toSorted())
      const cross = yield* db.select({ id: SessionTable.id }).from(SessionTable).where(searchCondition("alpha beta", { mode: "title" })).all().pipe(Effect.orDie)
      expect(cross).toEqual([])
    }),
  )
  previewIt.effect("checks Native root and child idle clocks at exact boundaries", () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const day = 24 * 60 * 60 * 1000
      const now = Date.now()
      const parent = SessionV2.ID.make("ses_native_idle_parent")
      // 相反的Session/消息时钟排除误用；边缘前后1ms与合法0不依赖调度等待。
      const fixtures = [
        { key: "root_old", child: false, updated: now - 7 * day - 1, last: now, eligible: true },
        { key: "root_hot", child: false, updated: now - 7 * day + 1, last: 0, eligible: false },
        { key: "child_old", child: true, updated: now, last: now - day - 1, eligible: true },
        { key: "child_hot", child: true, updated: 0, last: now - day + 1, eligible: false },
        { key: "child_zero", child: true, updated: now, last: 0, eligible: true },
      ].map(entry => ({ ...entry, id: SessionV2.ID.make(`ses_idle_${entry.key}`), messageID: SessionMessage.ID.make(`msg_idle_${entry.key}`) }))
      yield* db.insert(ProjectTable).values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] }).run()
      yield* db.insert(SessionTable).values({ id: parent, project_id: Project.ID.global, slug: parent, directory: "/project", title: "idle parent", version: "test", time_updated: now }).run()
      yield* db.insert(SessionTable).values(fixtures.map(entry => ({ id: entry.id, project_id: Project.ID.global,
        slug: entry.id, directory: "/project", title: entry.key, version: "test", parent_id: entry.child ? parent : null, time_updated: entry.updated,
      }))).run()
      yield* db.insert(SessionMessageTable).values(fixtures.map(entry => {
        const message = assistantRow(entry.messageID, 1, { created: DateTime.makeUnsafe(entry.last) })
        return { ...message, session_id: entry.id, data: { ...message.data, content: [{ type: "reasoning", id: "reason", text: "Native idle field ".repeat(200) }] } }
      })).run()
      yield* Database.withSync({ db, sync: db.sync }, sync => {
        for (const entry of fixtures) {
          const input = { type: "session_message" as const, id: entry.messageID, now }
          expect(ColdStorage.isEligibleOwner(sync, input)).toBe(entry.eligible)
          // 同一override只强制root年龄，不能把尚不足24h的child误冻。
          expect(ColdStorage.isEligibleOwner(sync, { ...input, olderThanMs: 0 })).toBe(entry.child ? entry.eligible : true)
        }
        expect(ColdStorage.parseMaintenanceRequest({ operation: "compress" })).toMatchObject({ olderThanMs: 7 * day })
      })
    }),
  )

  previewIt.effect("maintains Native cold owners by seq and rolls back corrupted reads", () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const outside = SessionV2.ID.make("ses_cold_outside")
      yield* db.insert(ProjectTable).values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] }).run()
      yield* db.insert(SessionTable).values([sessionID, outside].map(id => ({ id, project_id: Project.ID.global,
        slug: id, directory: "/project", title: id, version: "test" }))).run()
      const body = [{ type: "reasoning" as const, id: "reason", text: "native cold reason ".repeat(500) }]
      const oldID = SessionMessage.ID.make("msg_z_old")
      const hiddenID = SessionMessage.ID.make("msg_y_hidden")
      const tailID = SessionMessage.ID.make("msg_a_tail")
      const otherID = SessionMessage.ID.make("msg_outside")
      // 时间和ID不决定Native边界；seq=1可冻，compaction后的两个助手暂不可冻。
      const messages = [
        { ...assistantRow(oldID, 1), data: { ...assistantRow(oldID, 1).data, content: body } },
        { ...assistantRow(hiddenID, 4), data: { ...assistantRow(hiddenID, 4).data, content: body,
          metadata: { hidden: { time: 0, reason: "permission-reviewer-protocol-retry" } } } },
        { ...assistantRow(tailID, 5), data: { ...assistantRow(tailID, 5).data, content: body } },
        { ...assistantRow(otherID, 1), session_id: outside, data: { ...assistantRow(otherID, 1).data, content: body } },
      ]
      yield* db.insert(SessionMessageTable).values(messages).run()
      const { id, type, ...data } = encodeMessage(SessionMessage.Compaction.make({ id: SessionMessage.ID.make("msg_compaction"),
        type: "compaction", reason: "manual", summary: "summary", recent: "recent", time: { created } }))
      yield* db.insert(SessionMessageTable).values({ id: SessionMessage.ID.make(id), type, data, session_id: sessionID, seq: 3, time_created: 0 }).run()
      const runtime = { lease: { assertOwned() {} }, checkpoint: async (_task: ColdStorage.MaintenanceTask) => {},
        run: <A>(body: () => A) => Effect.runPromise(Database.withSync({ db, sync: db.sync }, body)) }
      const compressed = yield* Effect.promise(() => ColdStorage.maintain(db.sync, ColdStorage.prepareMaintenance({
        operation: "compress", sessionID, olderThanMs: 30 * 24 * 60 * 60 * 1000, batchSize: 1,
      }), runtime))
      expect(compressed).toMatchObject({ type: "task", task: { status: "completed", processed: 3, skipped: 2,
        cursor: { owner: "session_message" } } })
      if (compressed.type !== "task") return yield* Effect.die("Missing maintenance task")
      expect(ColdStorage.parseMaintenanceTask(compressed.task)).toEqual(compressed.task)
      expect((yield* db.select().from(SessionMessageTable).where(eq(SessionMessageTable.id, oldID)).get())?.cold_ref).toBeTruthy()
      expect((yield* db.select().from(SessionMessageTable).where(eq(SessionMessageTable.id, tailID)).get())?.cold_ref).toBeNull()
      expect((yield* db.select().from(SessionMessageTable).where(eq(SessionMessageTable.id, otherID)).get())?.cold_ref).toBeNull()
      // 强制老化只用于此精确owner；隐藏消息即使已冷也不能因普通history读取被预热。
      yield* Database.withSync({ db, sync: db.sync }, sync => {
        expect(ColdStorage.freezeOwner(sync, { type: "session_message", id: hiddenID, olderThanMs: 0, now: Date.now() + 1 }).type).toBe("frozen")
        expect(ColdStorage.status(sync).coldOwners).toBe(2)
        expect(ColdStorage.verify(sync, { repair: false })).toMatchObject({ checkedOwners: 2, missingPayloads: 0, corruptPayloads: 0, refCountMismatches: 0 })
      })
      const history = yield* SessionHistory.load(db, sessionID)
      expect(history.map(message => message.id)).toEqual([SessionMessage.ID.make(id), tailID])
      const cold = (yield* db.select().from(SessionMessageTable).all()).filter(row => row.cold_ref !== null)
      expect(cold.map(row => row.id).sort()).toEqual([oldID, hiddenID].sort())
      const payload = yield* db.select().from(ColdStorageTable).get()
      if (!payload) return yield* Effect.die("Missing shared Native payload")
      expect(payload.ref_count).toBe(2)
      // 相同entry的真实共享仍计两份逻辑Raw，不能把所有pack简单按blob计一次。
      expect(new Set(cold.map(row => row.cold_key?.toString("hex"))).size).toBe(1)
      // 破坏真实payload后整段读取必须回滚，不能交回空reasoning或消耗引用。
      yield* db.update(ColdStorageTable).set({ payload: Buffer.from([0]) }).where(eq(ColdStorageTable.hash, payload.hash)).run()
      // Native已打包owner的status只读metadata；坏body不能被此报告解压或被悄悄修复。
      // 与随后业务读取必失败形成对照，完整行比较继续保护seq/ref/key/stats及共享引用。
      yield* Database.withSync({ db, sync: db.sync }, sync => {
        const owners = sync.select().from(SessionMessageTable).all()
        const payloads = sync.select().from(ColdStorageTable).all()
        const report = ColdStorage.status(sync)
        expect(Object.keys(report)).toHaveLength(17)
        expect(report).toMatchObject({
          targetBytes: 1_500_000_000, eligibleOwners: 0, coldOwners: 2, payloads: 1,
          summaryOwners: 0, summaryPayloads: 0, summaryRawBytes: 0, summaryCompressedBytes: 0,
          rawBytes: payload.raw_bytes * 2, compressedBytes: payload.compressed_bytes,
          sharedBytes: payload.raw_bytes, refCountMismatches: 0, orphans: 0,
        })
        expect(report.pageSize).toBeGreaterThan(0)
        expect(report.pageCount).toBeGreaterThan(0)
        expect(report.freelistPages).toBeGreaterThanOrEqual(0)
        expect(report.activeBytes).toBe((report.pageCount - report.freelistPages) * report.pageSize)
        expect(ColdStorage.status(sync)).toEqual(report)
        expect(sync.select().from(SessionMessageTable).all()).toEqual(owners)
        expect(sync.select().from(ColdStorageTable).all()).toEqual(payloads)
      })
      const failed = yield* ColdStorage.readSessionMessageRows(db, cold).pipe(Effect.exit)
      expect(failed._tag).toBe("Failure")
      expect((yield* db.select().from(SessionMessageTable).all()).filter(row => row.cold_ref !== null)).toEqual(cold)
      expect((yield* db.select().from(ColdStorageTable).get())?.ref_count).toBe(2)
      yield* db.update(ColdStorageTable).set({ payload: payload.payload }).where(eq(ColdStorageTable.hash, payload.hash)).run()
      const expanded = yield* Effect.promise(() => ColdStorage.maintain(db.sync, ColdStorage.prepareMaintenance({
        operation: "expand", sessionID, all: false, batchSize: 1,
      }), runtime))
      expect(expanded).toMatchObject({ type: "task", task: { status: "completed", processed: 2 } })
      const restored = yield* db.select().from(SessionMessageTable).where(eq(SessionMessageTable.id, oldID)).get()
      expect(restored?.data).toMatchObject({ content: body })
      expect(restored?.seq).toBe(1)
      expect(restored?.time_created).toBe(0)
      expect(yield* db.select().from(ColdStorageTable).all()).toEqual([])
      expect((yield* db.select().from(SessionMessageTable).where(eq(SessionMessageTable.id, otherID)).get())?.data).toMatchObject({ content: body })
      const hidden = yield* db.select().from(SessionMessageTable).where(eq(SessionMessageTable.id, hiddenID)).get()
      if (!hidden) return yield* Effect.die("Native hidden fixture is missing")
      const distinctData = { ...hidden.data, content: [{ type: "reasoning" as const, id: "distinct", text: "a different Native entry" }] }
      yield* db.update(SessionMessageTable).set({ data: distinctData }).where(eq(SessionMessageTable.id, hiddenID)).run()
      const originals = yield* db.select().from(SessionMessageTable).where(inArray(SessionMessageTable.id, [oldID, hiddenID])).orderBy(SessionMessageTable.seq).all()
      // 同Session不同内容必须共享一个pack并保留不同entry key，而不是只证明相同envelope去重。
      yield* Database.withSync({ db, sync: db.sync }, sync => {
        expect(ColdStorage.freezeOwner(sync, { type: "session_message", id: oldID, olderThanMs: 0, now: Date.now() + 1 }).type).toBe("frozen")
        expect(ColdStorage.freezeOwner(sync, { type: "session_message", id: hiddenID, olderThanMs: 0, now: Date.now() + 1 }).type).toBe("frozen")
      })
      const packed = yield* db.select().from(SessionMessageTable).where(inArray(SessionMessageTable.id, [oldID, hiddenID])).orderBy(SessionMessageTable.seq).all()
      expect(new Set(packed.map(row => row.cold_ref)).size).toBe(1)
      expect(new Set(packed.map(row => row.cold_key?.toString("hex"))).size).toBe(2)
      const packPayload = yield* db.select().from(ColdStorageTable).get()
      if (!packPayload) return yield* Effect.die("Missing multi-key Native pack")
      // 两个不同entry已包含在一包中；独立期望来自真实metadata，不复制F4公式。
      yield* Database.withSync({ db, sync: db.sync }, sync => {
        expect(ColdStorage.status(sync)).toMatchObject({ rawBytes: packPayload.raw_bytes, compressedBytes: packPayload.compressed_bytes, sharedBytes: 0 })
      })
      // 同一内存DB同时承载Native冷pack和历史热Tool，修复只经真实显式维护入口。
      const events = yield* EventV2.Service
      const legacyID = SessionV1.MessageID.make("msg_568_input")
      yield* events.publish(SessionV1.Event.MessageUpdated, { sessionID, info: {
        id: legacyID, sessionID, role: "assistant", parentID: SessionV1.MessageID.make("msg_568_parent"), agent: "build", mode: "build", modelID: model.id, providerID: model.providerID,
        path: { cwd: "/project", root: "/project" }, time: { created: 0, completed: 1 }, cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      } })
      for (const [index, input] of ["{bad json", '{"command":"ls"}', []].entries()) {
        yield* db.insert(PartTable).values({
          id: SessionV1.PartID.make(`prt_568_${index}`), message_id: legacyID, session_id: sessionID,
          time_created: 1, time_updated: 1,
          data: { type: "tool", tool: "invalid", callID: `call_568_${index}`,
            state: index === 1
              ? { status: "completed", input, output: "", title: "historical input", metadata: {}, time: { start: 0, end: 1 } }
              : { status: "error", input, error: "Invalid input", time: { start: 0, end: 1 } } },
        }).run()
      }
      const hotBefore = yield* db.select().from(PartTable).where(eq(PartTable.message_id, legacyID)).orderBy(PartTable.id).all()
      const coldBefore = yield* db.select().from(SessionMessageTable).orderBy(SessionMessageTable.id).all()
      const payloadBefore = yield* db.select().from(ColdStorageTable).all()
      // 只读报告不吞损坏；坏行保持原样，默认status仍明确失败。
      yield* Database.withSync({ db, sync: db.sync }, sync => {
        expect(ColdStorage.verify(sync, { repair: false }).toolInputFixed).toBe(0)
        expect(() => ColdStorage.status(sync)).toThrow("Stored tool input is invalid")
        expect(sync.select().from(PartTable).where(eq(PartTable.message_id, legacyID)).orderBy(PartTable.id).all()).toEqual(hotBefore)
      })
      const prepared = ColdStorage.prepareMaintenance(ColdStorage.parseMaintenanceRequest({ operation: "verify", repairToolInput: true, batchSize: 50 }))
      if (prepared.type !== "task") return yield* Effect.die("Missing explicit input repair task")
      expect(ColdStorage.parseMaintenanceTask(prepared.task).args).toMatchObject({ operation: "verify", repair: false, repairToolInput: true })
      expect(yield* Effect.promise(() => ColdStorage.maintain(db.sync, prepared, runtime))).toMatchObject({ type: "task", task: { status: "completed" } })
      const fixed = yield* db.select().from(PartTable).where(eq(PartTable.message_id, legacyID)).orderBy(PartTable.id).all()
      expect(fixed.map(row => row.data.type === "tool" ? row.data.state.input : undefined)).toEqual([{}, { command: "ls" }, {}])
      expect(fixed.map(row => row.time_updated)).toEqual([1, 1, 1])
      // 写授权不改变Native冷数据或共享payload，再次修复必须幂等。
      expect(yield* db.select().from(SessionMessageTable).orderBy(SessionMessageTable.id).all()).toEqual(coldBefore)
      expect(yield* db.select().from(ColdStorageTable).all()).toEqual(payloadBefore)
      yield* Database.withSync({ db, sync: db.sync }, sync => {
        expect(ColdStorage.verify(sync, { repair: false, repairToolInput: true }).toolInputFixed).toBe(0)
      })
      const bad = packed.find(row => row.id === hiddenID)
      if (!bad?.cold_key) return yield* Effect.die("Native pack key is missing")
      const key = Buffer.from(bad.cold_key)
      // 第二个key损坏时完整选集必须回滚，不能先热化第一条或消耗共享引用。
      yield* db.update(SessionMessageTable).set({ cold_key: Buffer.alloc(1), time_updated: bad.time_updated }).where(eq(SessionMessageTable.id, hiddenID)).run()
      const broken = yield* db.select().from(SessionMessageTable).where(inArray(SessionMessageTable.id, [oldID, hiddenID])).orderBy(SessionMessageTable.seq).all()
      expect((yield* ColdStorage.readSessionMessageRows(db, broken).pipe(Effect.exit))._tag).toBe("Failure")
      expect(yield* db.select().from(SessionMessageTable).where(inArray(SessionMessageTable.id, [oldID, hiddenID])).orderBy(SessionMessageTable.seq).all()).toEqual(broken)
      expect((yield* db.select().from(ColdStorageTable).get())?.ref_count).toBe(2)
      yield* db.update(SessionMessageTable).set({ cold_key: key, time_updated: bad.time_updated }).where(eq(SessionMessageTable.id, hiddenID)).run()
      expect(yield* Effect.promise(() => ColdStorage.maintain(db.sync, ColdStorage.prepareMaintenance({
        operation: "expand", sessionID, all: false, batchSize: 1,
      }), runtime))).toMatchObject({ type: "task", task: { status: "completed", processed: 2 } })
      // 全行比较同时锁定seq、时间、正文及ref/key/stats清理，不靠删断言掩盖格式差异。
      expect(yield* db.select().from(SessionMessageTable).where(inArray(SessionMessageTable.id, [oldID, hiddenID])).orderBy(SessionMessageTable.seq).all()).toEqual(originals)
      expect(yield* db.select().from(ColdStorageTable).all()).toEqual([])
    }),
  )
  previewIt.effect("reads complete legacy turns without populating the request ledger", () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const events = yield* EventV2.Service
      yield* db.insert(ProjectTable).values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] }).run()
      yield* db.insert(SessionTable).values({ id: sessionID, project_id: Project.ID.global, slug: "legacy-usage", directory: "/project", title: "legacy", version: "test" }).run()
      const requestID = SessionV1.MessageID.make("msg_legacy_request")
      const other = SessionV1.MessageID.make("msg_legacy_stream")
      for (const id of [requestID, other]) yield* events.publish(SessionV1.Event.MessageUpdated, { sessionID, info: {
        id, sessionID, role: "user", time: { created: 0 }, agent: "build", model: { providerID: model.providerID, modelID: model.id },
      } })
      const first = SessionV1.MessageID.make("msg_legacy_first")
      const last = SessionV1.MessageID.make("msg_legacy_last")
      const streamed = SessionV1.MessageID.make("msg_legacy_streaming")
      // 多助手、多step及另一个流式parent是真实持久化输入，不用分页窗口构造总量。
      const assistant = (id: SessionV1.MessageID, parentID: SessionV1.MessageID, completed: number | undefined) => ({
        id, sessionID, role: "assistant" as const, parentID, agent: "build", mode: "build", modelID: model.id, providerID: model.providerID,
        path: { cwd: "/project", root: "/project" }, time: { created: id === first ? 1 : 2, completed }, cost: 0.03,
        tokens: { input: 77, output: 11, reasoning: 3, cache: { read: 8, write: 2 } },
      })
      yield* events.publish(SessionV1.Event.MessageUpdated, { sessionID, info: assistant(first, requestID, 3) })
      yield* events.publish(SessionV1.Event.MessageUpdated, { sessionID, info: assistant(last, requestID, 4) })
      yield* events.publish(SessionV1.Event.MessageUpdated, { sessionID, info: assistant(streamed, other, undefined) })
      for (const factor of [1, 2]) yield* events.publish(SessionV1.Event.PartUpdated, { sessionID, time: 3, part: {
        id: SessionV1.PartID.make(`prt_legacy_${factor}`), sessionID, messageID: first, type: "step-finish", reason: "stop", cost: factor / 10,
        tokens: { input: 100 * factor, output: 20 * factor, reasoning: 5 * factor, cache: { read: 30 * factor, write: 40 * factor } },
      } })
      const usage = SessionRequestUsage.make(db)
      expect(yield* db.select().from(RequestUsageTable).all()).toEqual([])
      const full = yield* usage.get({ sessionID, requestID })
      expect(full).toMatchObject({ source: "unknown", status: "completed", assistantCount: 2, stepCount: 3, cost: 0.33,
        tokens: { input: 377, output: 71, reasoning: 18, cache: { read: 98, write: 122 }, total: 686 }, time: { completed: 4 } })
      const details = yield* usage.assistants({ sessionID, requestID })
      expect(details.map(item => item.assistantMessageID).sort()).toEqual([first, last].sort())
      expect(details.find(item => item.assistantMessageID === first)).toMatchObject({ stepCount: 2, cost: 0.3, tokens: { input: 300 } })
      expect(details.find(item => item.assistantMessageID === last)).toMatchObject({ stepCount: 1, cost: 0.03, tokens: { input: 77 } })
      // 查询不补写账本，重复调用不会修改Session费用或消息；真正缺失仍返回undefined。
      expect(yield* usage.get({ sessionID, requestID })).toEqual(full)
      expect(yield* db.select().from(RequestUsageTable).all()).toEqual([])
      expect(yield* db.select().from(RequestUsageAssistantTable).all()).toEqual([])
      expect(yield* usage.get({ sessionID, requestID: SessionV1.MessageID.make("msg_legacy_missing") })).toBeUndefined()
      expect(yield* usage.get({ sessionID: SessionV2.ID.make("ses_other"), requestID })).toBeUndefined()
      // 一旦有真实账本，零确认也是权威；不能被存量消息反填或另一个parent污染。
      yield* usage.begin({ sessionID, requestID, source: "prompt", agent: "build", providerID: model.providerID, modelID: model.id })
      expect(yield* usage.get({ sessionID, requestID })).toMatchObject({ source: "prompt", assistantCount: 0, stepCount: 0, cost: 0, tokens: { total: 0 } })
      expect(yield* usage.assistants({ sessionID, requestID })).toEqual([])
      yield* db.delete(SessionTable).where(eq(SessionTable.id, sessionID)).run()
    }),
  )
  previewIt.effect("batches previews from each real message store without compaction or inbox leakage", () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const events = yield* EventV2.Service
      const a = SessionV2.ID.make("ses_preview_a")
      const b = SessionV2.ID.make("ses_preview_b")
      yield* db.insert(ProjectTable).values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] }).run()
      yield* db.insert(SessionTable).values([a, b].map(id => ({ id, project_id: Project.ID.global,
        slug: id, directory: "/project", title: id, version: "test" }))).run()
      const promote = (sessionID: SessionV2.ID, id: string, text: string) => Effect.gen(function* () {
        const input = yield* SessionInput.admit(db, events, { id: SessionMessage.ID.make(id), sessionID,
          prompt: Prompt.make({ text }), delivery: "steer" })
        yield* SessionInput.promoteSteers(db, events, sessionID, input.admittedSeq)
        return input.id
      })
      yield* promote(a, "msg_preview_old", "old before compaction")
      const hidden = yield* promote(a, "msg_preview_hidden", "hidden")
      yield* events.publish(SessionEvent.MessagesHidden, { sessionID: a, timestamp: created, messageIDs: [hidden],
        hidden: SessionMessage.Hidden.make({ time: 0, reason: "permission-reviewer-protocol-retry" }) })
      const visible = yield* promote(a, "msg_preview_false", "false marker")
      const row = yield* db.select().from(SessionMessageTable).where(eq(SessionMessageTable.id, visible)).get()
      if (!row) return yield* Effect.die("Missing projected preview user")
      // 非法隐藏值保留可见性，防止把metadata键存在误当作协议隐藏。
      yield* db.update(SessionMessageTable).set({ data: { ...row.data, metadata: { hidden: false } } })
        .where(eq(SessionMessageTable.id, visible)).run()
      yield* promote(a, "msg_preview_middle", "middle")
      yield* events.publish(SessionEvent.Synthetic, { sessionID: a, messageID: SessionMessage.ID.make("msg_preview_synthetic"),
        timestamp: created, text: "internal synthetic" })
      const compactionID = SessionMessage.ID.make("msg_preview_compaction")
      yield* events.publish(SessionEvent.Compaction.Started, { sessionID: a, messageID: compactionID, timestamp: created, reason: "manual" })
      yield* events.publish(SessionEvent.Compaction.Ended, { sessionID: a, messageID: compactionID,
        timestamp: DateTime.makeUnsafe(1), reason: "manual", text: "summary", recent: "recent" })
      yield* promote(a, "msg_preview_latest", " latest\n  user ")
      const pending = yield* SessionInput.admit(db, events, { id: SessionMessage.ID.make("msg_preview_pending"), sessionID: a,
        prompt: Prompt.make({ text: "pending inbox" }), delivery: "queue" })
      yield* promote(b, "msg_preview_b_first", "b first")
      yield* promote(b, "msg_preview_b_latest", "b latest")
      expect((yield* SessionInput.find(db, pending.id))?.promotedSeq).toBeUndefined()
      expect(yield* SessionPreview.load(db, { sessionIDs: [] })).toEqual({})
      expect(yield* SessionPreview.load(db, { sessionIDs: [a, b, "ses_missing"] })).toEqual({
        [a]: ["middle", "latest user"], [b]: ["b first", "b latest"],
      })
      expect(yield* SessionPreview.load(db, { sessionIDs: [a], limit: 1 })).toEqual({ [a]: ["latest user"] })
      // 全量窗口证明压缩前正文仍可取，hidden/synthetic/inbox都不能占名额。
      expect(yield* SessionPreview.load(db, { sessionIDs: [a], limit: 10 })).toEqual({
        [a]: ["old before compaction", "false marker", "middle", "latest user"],
      })
      const v1 = (text: string | undefined, options: { hidden?: boolean; synthetic?: boolean; ignored?: boolean; partHidden?: boolean } = {}) => Effect.gen(function* () {
        const id = SessionV1.MessageID.ascending()
        yield* events.publish(SessionV1.Event.MessageUpdated, { sessionID: a, info: { id, sessionID: a, role: "user",
          time: { created: 10 }, agent: "build", model: { providerID: model.providerID, modelID: model.id },
          ...(options.hidden ? { hidden: { time: 0, reason: "undo" as const } } : {}) } })
        if (text !== undefined) yield* events.publish(SessionV1.Event.PartUpdated, { sessionID: a, time: 10, part: {
          id: SessionV1.PartID.ascending(), sessionID: a, messageID: id, type: "text", text,
          synthetic: options.synthetic, ignored: options.ignored,
          ...(options.partHidden ? { hidden: { time: 0, reason: "undo" as const } } : {}),
        } })
        return id
      })
      const first = yield* v1(" part1\n")
      yield* events.publish(SessionV1.Event.PartUpdated, { sessionID: a, time: 10, part: {
        id: SessionV1.PartID.ascending(), sessionID: a, messageID: first, type: "text", text: " part2 ",
      } })
      yield* v1("second")
      yield* v1("hidden", { hidden: true })
      yield* v1("synthetic", { synthetic: true })
      yield* v1("ignored", { ignored: true })
      yield* v1("part hidden", { partHidden: true })
      yield* v1(undefined)
      expect(yield* SessionPreview.load(db, { sessionIDs: [a, b, "ses_missing"] }, "v1")).toEqual({ [a]: ["part1 part2", "second"] })
      expect(yield* SessionPreview.load(db, { sessionIDs: [a], limit: 1 }, "v1")).toEqual({ [a]: ["second"] })
      // 同一Session内的两代表不能互相补查，Native结果不受V1新行影响。
      expect(yield* SessionPreview.load(db, { sessionIDs: [a], limit: 2 })).toEqual({ [a]: ["middle", "latest user"] })
      expect(yield* SessionPreview.load(db, { sessionIDs: [] }, "v1")).toEqual({})
    }),
  )

  listingIt.effect("keeps Native viewer summaries cold while restoring visible attachments and tools", () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const sessions = yield* SessionV2.Service
      yield* db.insert(ProjectTable).values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] }).run()
      yield* db.insert(SessionTable).values({ id: sessionID, project_id: Project.ID.global, slug: "viewer", directory: "/project", title: "viewer", version: "test", time_updated: 0 }).run()
      const first = SessionMessage.ID.make("msg_viewer_summary")
      const second = SessionMessage.ID.make("msg_viewer_attachment")
      const assistant = SessionMessage.ID.make("msg_viewer_tool")
      const summary = { diffs: [{ file: "large.ts", patch: "+summary\n".repeat(512), additions: 512, deletions: 0, status: "modified" as const }] }
      const files = [{ uri: "data:text/plain;base64," + "YQ==".repeat(512), mime: "text/plain", name: "evidence.txt" }]
      // 同一选集同时放summary-only、冷附件User及冷Tool，不能用统一跳解压换取假优化。
      const users = [
        SessionMessage.User.make({ id: first, type: "user", text: "summary-only body", summary, time: { created } }),
        SessionMessage.User.make({ id: second, type: "user", text: "attachment body", summary, files, time: { created } }),
      ]
      yield* db.insert(SessionMessageTable).values(users.map((message, index) => {
        const { id, type, ...data } = encodeMessage(message)
        return { id: SessionMessage.ID.make(id), session_id: sessionID, seq: index + 1, time_created: 0, type, data }
      })).run()
      const content = [
        { type: "reasoning", id: "reason", text: "visible reasoning ".repeat(300) },
        { type: "tool", id: "edit", name: "edit", time: { created: 0, completed: 1 }, state: { status: "completed", input: { path: "large.ts" }, structured: { changed: true }, content: [{ type: "text", text: "visible tool ".repeat(300) }] } },
      ] satisfies (typeof SessionMessage.Assistant)["Encoded"]["content"]
      const message = { ...assistantRow(assistant, 3), data: { ...assistantRow(assistant, 3).data, content } }
      yield* db.insert(SessionMessageTable).values(message).run()
      yield* Database.withSync({ db, sync: db.sync }, sync => {
        for (const id of [first, second, assistant]) expect(ColdStorage.freezeOwner(sync, { type: "session_message", id, olderThanMs: 0, now: Date.now() + 1 }).type).toBe("frozen")
      })
      const before = yield* db.select().from(SessionMessageTable).orderBy(asc(SessionMessageTable.seq)).all()
      expect(before.map(row => Boolean(row.cold_ref))).toEqual([true, true, true])
      const view = yield* sessions.messages({ sessionID, order: "asc", messageProjection: "viewer" })
      expect(view.map(message => message.id)).toEqual([first, second, assistant])
      expect(view[0]).toMatchObject({ type: "user", text: "summary-only body" })
      expect(view[0]).not.toHaveProperty("summary")
      expect(view[1]).toMatchObject({ type: "user", text: "attachment body", files })
      expect(view[1]).not.toHaveProperty("summary")
      expect(view[2] && encodeMessage(view[2])).toMatchObject({ type: "assistant", content })
      // 只读省略不能持久删除summary；附件和Tool则必须已真实恢复，而非返回骨架。
      const after = yield* db.select().from(SessionMessageTable).orderBy(asc(SessionMessageTable.seq)).all()
      expect(after.map(row => row.cold_ref)).toEqual([before[0]?.cold_ref, null, null])
      expect(after[0]?.cold_key).toEqual(before[0]?.cold_key)
      expect(after[1]?.data).toMatchObject({ summary })
      expect((yield* db.select().from(ColdStorageTable).all()).map(row => row.ref_count)).toEqual([1])
      // 默认API仍返回完整摘要并释放最后引用；不能让viewer污染SDK/模型历史的后续读取。
      const complete = yield* sessions.messages({ sessionID, order: "asc" })
      expect(complete[0]).toMatchObject({ summary })
      expect(complete[1]).toMatchObject({ files, summary })
      expect(complete[2] && encodeMessage(complete[2])).toMatchObject({ content })
      expect((yield* db.select().from(SessionMessageTable).all()).every(row => row.cold_ref === null)).toBe(true)
      expect(yield* db.select().from(ColdStorageTable).all()).toEqual([])
    }),
  )

  previewIt.effect("persists request-owned tool diffs through the native completion event", () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const events = yield* EventV2.Service
      yield* db.insert(ProjectTable).values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] }).run()
      yield* db.insert(SessionTable).values({ id: sessionID, project_id: Project.ID.global, slug: "diff",
        directory: "/project/app", title: "diff", version: "test" }).run()
      const files = [{ uri: "data:text/plain;base64," + "YQ==".repeat(2000), mime: "text/plain", name: "evidence.txt" }]
      const first = yield* SessionInput.admit(db, events, { id: SessionMessage.ID.make("msg_diff_first"), sessionID,
        prompt: Prompt.make({ text: "edit first", files }), delivery: "steer" })
      yield* SessionInput.promoteSteers(db, events, sessionID, first.admittedSeq)
      const assistantMessageID = SessionMessage.ID.make("msg_diff_assistant")
      yield* events.publish(SessionEvent.Step.Started, { sessionID, assistantMessageID, timestamp: created, agent: "build", model, snapshot: "tree_before" })
      const complete = (id: SessionMessage.ID, callID: string, name: string, structured: Record<string, unknown>, input: Record<string, unknown> = {}) => Effect.gen(function* () {
        yield* events.publish(SessionEvent.Tool.Input.Started, { sessionID, assistantMessageID: id, callID, name, timestamp: created })
        yield* events.publish(SessionEvent.Tool.Called, { sessionID, assistantMessageID: id, callID, tool: name, input, provider: { executed: false }, timestamp: created })
        yield* events.publish(SessionEvent.Tool.Success, { sessionID, assistantMessageID: id, callID, structured, content: [{ type: "text", text: "native output ".repeat(600) }], provider: { executed: false }, timestamp: created })
      })
      // 真实完成投影同时覆盖三种工具形状、嵌套Location和最终格式化diff，不使用展示正文反推。
      const truth = { path: "a.ts", edits: [{ oldString: "\u201Cbefore\u201D", newString: "after" }] }
      yield* complete(assistantMessageID, "edit", "edit", { files: [{ file: "a.ts", patch: "+edit\n", additions: 1, deletions: 0, status: "modified" }], syncInput: truth },
        { path: "a.ts", oldString: '"before"', newString: "after" })
      yield* complete(assistantMessageID, "patch", "apply_patch", { files: [
        { file: "a.ts", patch: "+patch\n", additions: 1, deletions: 0, status: "modified" },
        { file: "gone.ts", patch: "-gone\n", additions: 0, deletions: 1, status: "deleted" },
      ] })
      yield* complete(assistantMessageID, "write", "write", { target: "/project/app/new.ts", resource: "new.ts", existed: false,
        diff: "--- before\n+++ after\n+formatted\n", formattedContent: "formatted\n" })
      const expected = (yield* SessionHistory.load(db, sessionID)).find(message => message.id === assistantMessageID)
      if (!expected || expected.type !== "assistant") return yield* Effect.die("Missing native tool fixture")
      // 整参数面替换旧字段，暂态真值不在 structured 与历史输入重复保存。
      const edited = expected.content.find(part => part.type === "tool" && part.id === "edit")
      expect(edited).toMatchObject({ state: { input: truth } })
      expect(edited && "state" in edited && edited.state.status === "completed" ? edited.state.structured : undefined).not.toHaveProperty("syncInput")
      const before = yield* db.select().from(SessionMessageTable).where(eq(SessionMessageTable.id, assistantMessageID)).get()
      // 两次独立冻结分别检验普通history和runner入口，不能把第二次热读冒充恢复。
      for (const runner of [false, true]) {
        yield* db.update(SessionTable).set({ time_updated: 0 }).where(eq(SessionTable.id, sessionID)).run()
        const frozen = yield* Database.withSync({ db, sync: db.sync }, sync => ColdStorage.freezeOwner(sync, { type: "session_message", id: assistantMessageID }))
        expect(frozen.type).toBe("frozen")
        expect((yield* db.select().from(ColdStorageTable).get())?.ref_count).toBe(1)
        const history = yield* (runner ? SessionHistory.loadForRunner(db, sessionID, 0) : SessionHistory.load(db, sessionID))
        expect(history.find(message => message.id === assistantMessageID)).toEqual(expected)
        const restored = yield* db.select().from(SessionMessageTable).where(eq(SessionMessageTable.id, assistantMessageID)).get()
        expect(restored?.cold_ref).toBeNull()
        expect(restored?.data).toEqual(before?.data)
        expect(restored?.seq).toBe(before?.seq)
        expect(restored?.time_created).toBe(before?.time_created)
        expect(yield* db.select().from(ColdStorageTable).all()).toEqual([])
        expect((yield* SessionHistory.load(db, sessionID)).find(message => message.id === assistantMessageID)).toEqual(expected)
      }
      // 新提升的输入和助手不能认领旧轮结果；无快照请求仍然保留工具流归因。
      // 技术提醒不创建 Goal turn，当前 turn 的冷助手也必须按真实选集恢复。
      yield* events.publish(SessionEvent.Synthetic, { sessionID, messageID: SessionMessage.ID.make("msg_progress_reminder"), timestamp: created, text: "Technical plan reminder" })
      expect((yield* SessionHistory.goalTurn(db, sessionID))?.id).toBe(first.id)
      yield* Database.withSync({ db, sync: db.sync }, sync => {
        expect(ColdStorage.freezeOwner(sync, { type: "session_message", id: assistantMessageID }).type).toBe("frozen")
      })
      expect(yield* SessionHistory.goalTurnMessages(db, sessionID)).toEqual([expected])
      expect((yield* db.select().from(SessionMessageTable).where(eq(SessionMessageTable.id, assistantMessageID)).get())?.cold_ref).toBeNull()
      expect(yield* db.select().from(ColdStorageTable).all()).toEqual([])
      const later = yield* SessionInput.admit(db, events, { id: SessionMessage.ID.make("msg_diff_later"), sessionID,
        prompt: Prompt.make({ text: "edit later" }), delivery: "steer" })
      yield* SessionInput.promoteSteers(db, events, sessionID, later.admittedSeq)
      const other = SessionMessage.ID.make("msg_diff_other")
      yield* events.publish(SessionEvent.Step.Started, { sessionID, assistantMessageID: other, timestamp: created, agent: "build", model })
      yield* complete(other, "other", "edit", { files: [{ file: "other.ts", patch: "+other\n", additions: 1, deletions: 0 }] })
      const input = { sessionID, assistantMessageID, directory: "/project/app", worktree: "/project" }
      yield* db.update(SessionTable).set({ time_updated: 0 }).where(eq(SessionTable.id, sessionID)).run()
      yield* Database.withSync({ db, sync: db.sync }, sync => {
        expect(ColdStorage.freezeOwner(sync, { type: "session_message", id: assistantMessageID }).type).toBe("frozen")
        expect(ColdStorage.freezeOwner(sync, { type: "session_message", id: other }).type).toBe("frozen")
      })
      const withoutSnapshots = yield* ToolDiffs.summarize(db, input)
      expect((yield* db.select().from(SessionMessageTable).where(eq(SessionMessageTable.id, other)).get())?.cold_ref).toBeTruthy()
      expect(withoutSnapshots?.messageID).toBe(first.id)
      expect(withoutSnapshots?.diffs.map(item => item.file)).toEqual(["app/a.ts", "app/gone.ts", "app/new.ts"])
      const withSnapshots = { ...input, snapshot: Snapshot.ID.make("tree_after"),
        diff: () => Effect.die("tool-only summary must not read whole-tree snapshots") }
      const summary = yield* ToolDiffs.summarize(db, withSnapshots)
      // 即使消息及旧调用载荷仍有快照，也只保留工具文件；shell等外部变更不再偷偷补入。
      expect(summary?.diffs).toEqual(withoutSnapshots?.diffs)
      expect(summary?.diffs[3]).toBeUndefined()
      expect(summary?.diffs[0]).toMatchObject({ file: "app/a.ts", patch: "+edit\n+patch\n", additions: 2, deletions: 0, status: "modified" })
      expect(summary?.diffs[1]?.status).toBe("deleted")
      expect(summary?.diffs[2]).toMatchObject({ status: "added", additions: 1, patch: "--- before\n+++ after\n+formatted\n" })
      const settlement = { sessionID, assistantMessageID, timestamp: created, finish: "stop", cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, summary }
      // late completion先恢复完整tool内容，再在同一事件事务中覆盖结算。
      yield* db.update(SessionTable).set({ time_updated: 0 }).where(eq(SessionTable.id, sessionID)).run()
      yield* Database.withSync({ db, sync: db.sync }, sync => {
        // 内部摘要只inspect，必须仍是冷owner；迟到完成事件随后自行恢复并交换引用。
        expect(ColdStorage.freezeOwner(sync, { type: "session_message", id: assistantMessageID })).toMatchObject({ type: "skipped", reason: "already-cold" })
        expect(sync.select().from(SessionMessageTable).where(eq(SessionMessageTable.id, assistantMessageID)).get()?.cold_ref).toBeTruthy()
      })
      yield* events.publish(SessionEvent.Step.Ended, settlement)
      expect((yield* SessionHistory.load(db, sessionID)).find(message => message.id === assistantMessageID)).toMatchObject({ content: expected.content })
      yield* events.publish(SessionEvent.Step.Ended, settlement)
      const row = yield* db.select().from(SessionMessageTable).where(eq(SessionMessageTable.id, first.id)).get()
      expect(row?.data).toMatchObject({ summary: { diffs: summary?.diffs } })
      const otherUser = yield* db.select().from(SessionMessageTable).where(eq(SessionMessageTable.id, later.id)).get()
      expect(otherUser?.data).not.toHaveProperty("summary")
      // 同一事件经内存updater重放，也必须更新同一user而非最近user，且不重复累计。
      const memory = { messages: [SessionMessage.User.make({ id: first.id, type: "user", text: "first", time: { created } }),
        SessionMessage.User.make({ id: later.id, type: "user", text: "later", time: { created } })] as SessionMessage.Message[] }
      const event = yield* events.publish(SessionEvent.Step.Ended, settlement)
      yield* SessionMessageUpdater.update(SessionMessageUpdater.memory(memory), event)
      expect(memory.messages[0]).toMatchObject({ summary: { diffs: summary?.diffs } })
      expect(memory.messages[1]).not.toHaveProperty("summary")
      expect(encodeMessage(SessionMessage.User.make({ id: later.id, type: "user", text: "old", time: { created } }))).not.toHaveProperty("summary")
      // 保留边界user的冷附件，撤回仅清其摘要并释放真实seq后缀。
      yield* db.update(SessionTable).set({ time_updated: 0 }).where(eq(SessionTable.id, sessionID)).run()
      yield* Database.withSync({ db, sync: db.sync }, sync => {
        expect(ColdStorage.freezeOwner(sync, { type: "session_message", id: first.id }).type).toBe("frozen")
        expect(ColdStorage.freezeOwner(sync, { type: "session_message", id: assistantMessageID }).type).toBe("frozen")
      })
      yield* events.publish(SessionEvent.RevertEvent.Committed, { sessionID, messageID: first.id, timestamp: created })
      const reverted = yield* db.select().from(SessionMessageTable).where(eq(SessionMessageTable.id, first.id)).get()
      expect(reverted?.data).not.toHaveProperty("summary")
      expect(reverted?.data).toMatchObject({ files })
      expect(yield* db.select().from(ColdStorageTable).all()).toEqual([])
      yield* db.delete(SessionTable).where(eq(SessionTable.id, sessionID)).run()
    }),
  )
  it.effect("keeps native request ownership and rolls back incomplete ledger updates", () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const events = yield* EventV2.Service
      // 使用真实 projector、事务和外键；不在测试里复制请求聚合算法。
      yield* db.insert(ProjectTable).values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] }).run()
      yield* db.insert(SessionTable).values({ id: sessionID, project_id: Project.ID.global, slug: "test",
        directory: "/project", title: "test", version: "test" }).run()
      const first = yield* SessionInput.admit(db, events, { id: SessionMessage.ID.make("msg_usage_first"),
        sessionID, prompt: Prompt.make({ text: "first" }), delivery: "steer" })
      const firstRequestID = SessionV1.MessageID.make(first.id)
      const usage = SessionRequestUsage.make(db)
      // admit-only 必须已有零用量请求，尚未产生可见用户消息或助手归属。
      expect(yield* usage.get({ sessionID, requestID: firstRequestID })).toMatchObject({ source: "prompt", assistantCount: 0, cost: 0 })
      expect(yield* db.select().from(SessionMessageTable).all()).toEqual([])
      const second = yield* SessionInput.admit(db, events, { id: SessionMessage.ID.make("msg_usage_second"),
        sessionID, prompt: Prompt.make({ text: "second" }), delivery: "steer" })
      const requestID = SessionV1.MessageID.make(second.id)
      // 两个真实 admission 一次 promote，不能只修最终输入而留下前一行永久 running。
      yield* SessionInput.promoteSteers(db, events, sessionID, second.admittedSeq)
      const assistantMessageID = SessionMessage.ID.make("msg_usage_assistant")
      yield* events.publish(SessionEvent.Step.Started, { sessionID, assistantMessageID, timestamp: created, agent: "resolved", model })
      // 后来接纳的 queue 不能抢走已经开始的 turn，结束时只读冻结的助手归属。
      const queued = yield* SessionInput.admit(db, events, { id: SessionMessage.ID.make("msg_usage_queued"),
        sessionID, prompt: Prompt.make({ text: "later" }), delivery: "queue" })
      const tokens = { input: 2, output: 3, reasoning: 4, cache: { read: 5, write: 6 } }
      const settlement = { sessionID, assistantMessageID, timestamp: DateTime.makeUnsafe(0), finish: "stop", cost: 0.5, tokens }
      yield* events.publish(SessionEvent.Step.Ended, settlement)
      expect(yield* usage.get({ sessionID, requestID })).toMatchObject({ agent: "resolved", assistantCount: 1,
        stepCount: 1, cost: 0.5, tokens: { ...tokens, total: 20 }, status: "completed", time: { completed: 0 } })
      expect(yield* usage.get({ sessionID, requestID: firstRequestID })).toMatchObject({ rootRequestID: requestID,
        status: "completed", assistantCount: 0, stepCount: 0, cost: 0, tokens: { total: 0 } })
      expect(yield* usage.list({ sessionID, before: 0 })).toEqual([])
      expect(yield* usage.get({ sessionID, requestID: SessionV1.MessageID.make(queued.id) })).toMatchObject({
        rootRequestID: queued.id, status: "running", assistantCount: 0, cost: 0 })
      // 同一助手修订覆盖快照，request 与 #9 Session 累计都不能把两次结算相加。
      yield* events.publish(SessionEvent.Step.Ended, { ...settlement, cost: 0.75 })
      expect(yield* usage.get({ sessionID, requestID })).toMatchObject({ assistantCount: 1, stepCount: 1, cost: 0.75 })
      expect(yield* db.select().from(SessionTable).get()).toMatchObject({ cost: 0.75, tokens_input: 2, tokens_reasoning: 4 })
      // 模拟最终请求回写失败，验证前面的助手 upsert 真正回滚，而非只有接口声明为原子。
      yield* db.run(sql`CREATE TRIGGER reject_request_update BEFORE UPDATE ON request_usage BEGIN SELECT RAISE(ABORT, 'ledger failure'); END`)
      const exit = yield* usage.recordAssistant({ sessionID, requestID,
        assistant: { id: SessionV1.MessageID.make(assistantMessageID), agent: "resolved", providerID: model.providerID,
          modelID: model.id, time: { created: 0, completed: 10 } },
        usage: { count: 1, costMicros: 900000, tokens: { ...tokens, total: 20 } },
      }).pipe(Effect.exit)
      expect(exit._tag).toBe("Failure")
      expect(yield* db.select().from(RequestUsageAssistantTable).get()).toMatchObject({ cost_micros: 750000 })
      expect(yield* usage.get({ sessionID, requestID })).toMatchObject({ cost: 0.75 })
      yield* db.run(sql`DROP TRIGGER reject_request_update`)
      // 中断通过事件标志区分 error；已结算 usage 仍保留，不把 provider 消耗退款。
      yield* events.publish(SessionEvent.Step.Failed, { sessionID, assistantMessageID, timestamp: DateTime.makeUnsafe(11),
        aborted: true, error: { type: "unknown", message: "interrupted" } })
      expect(yield* usage.get({ sessionID, requestID })).toMatchObject({ status: "aborted", cost: 0.75, error: "interrupted" })
      expect(yield* usage.get({ sessionID, requestID: firstRequestID })).toMatchObject({
        status: "aborted", error: "interrupted", cost: 0, tokens: { total: 0 } })
      // 重放 Failed→Ended 的补结算顺序，不能将 aborted 降成 UnknownError 或重复收费。
      yield* events.publish(SessionEvent.Step.Ended, { ...settlement, timestamp: DateTime.makeUnsafe(11), cost: 0.75 })
      expect(yield* usage.get({ sessionID, requestID })).toMatchObject({ status: "aborted", cost: 0.75,
        assistantCount: 1, stepCount: 1, tokens: { ...tokens, total: 20 }, error: "interrupted" })
      expect(yield* usage.assistants({ sessionID, requestID })).toMatchObject([{ status: "aborted", cost: 0.75, stepCount: 1 }])
      expect(yield* usage.get({ sessionID, requestID: firstRequestID })).toMatchObject({ status: "aborted", cost: 0 })
      expect(yield* db.select().from(SessionTable).get()).toMatchObject({ cost: 0.75, tokens_input: 2, tokens_reasoning: 4 })
      expect((yield* db.select().from(SessionMessageTable).all()).find(row => row.id === assistantMessageID)?.data).toMatchObject({
        finish: "error", error: { type: "unknown", message: "interrupted" }, tokens,
      })
      // 压缩失败结算也有独立请求和根请求；失败不能投影成成功摘要。
      const compactID = SessionMessage.ID.make("msg_usage_compaction")
      yield* events.publish(SessionEvent.Compaction.Started, { sessionID, messageID: compactID,
        timestamp: DateTime.makeUnsafe(12), reason: "auto", model })
      yield* events.publish(SessionEvent.Compaction.Failed, { sessionID, messageID: compactID, timestamp: DateTime.makeUnsafe(13),
        error: { type: "unknown", message: "summary failed" }, usage: { tokens, cost: 0, stepCount: 1 } })
      expect(yield* usage.get({ sessionID, requestID: SessionV1.MessageID.make(compactID) })).toMatchObject({
        source: "system_compaction", rootRequestID: requestID, status: "error", stepCount: 1 })
      expect((yield* db.select().from(SessionMessageTable).all()).some(row => row.type === "compaction")).toBe(false)
      // 后续 steer 属于新的提升批次，不得把旧的零用量成员重新归属到新助手。
      const future = yield* SessionInput.admit(db, events, { id: SessionMessage.ID.make("msg_usage_future"),
        sessionID, prompt: Prompt.make({ text: "future" }), delivery: "steer" })
      yield* SessionInput.promoteSteers(db, events, sessionID, future.admittedSeq)
      yield* events.publish(SessionEvent.Step.Started, { sessionID, assistantMessageID: SessionMessage.ID.make("msg_usage_future_assistant"),
        timestamp: DateTime.makeUnsafe(14), agent: "resolved", model })
      yield* events.publish(SessionEvent.Step.Ended, { ...settlement, assistantMessageID: SessionMessage.ID.make("msg_usage_future_assistant"),
        timestamp: DateTime.makeUnsafe(15), cost: 0 })
      // 新的零美元事件按零记录；旧批次错误和未提升 queue 均不能被这次终态清除。
      expect(yield* usage.get({ sessionID, requestID: firstRequestID })).toMatchObject({ rootRequestID: requestID, status: "aborted", cost: 0 })
      expect(yield* usage.get({ sessionID, requestID: SessionV1.MessageID.make(future.id) })).toMatchObject({ status: "completed", cost: 0 })
      expect(yield* usage.get({ sessionID, requestID: SessionV1.MessageID.make(queued.id) })).toMatchObject({ status: "running", cost: 0 })
      // 删除 Session 由 SQL 外键清理两张明细表，与 Drizzle 定义和迁移契约一致。
      yield* db.delete(SessionTable).where(eq(SessionTable.id, sessionID)).run()
      expect(yield* db.select().from(RequestUsageTable).all()).toEqual([])
      expect(yield* db.select().from(RequestUsageAssistantTable).all()).toEqual([])
    }),
  )

  it.effect("projects native settlements into public Session totals exactly once", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const events = yield* EventV2.Service
      const sessions = yield* SessionV2.Service
      // 只建立会话容器，助手必须由真实 Started 事件产生，避免手工行掩盖 projector 缺口。
      yield* database.db.insert(ProjectTable).values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] }).run()
      yield* database.db.insert(SessionTable).values({
        id: sessionID, project_id: Project.ID.global, slug: "usage", directory: "/project", title: "usage", version: "test",
      }).run()
      // 请求由真实 Prompted 事件归属，不能在测试中给 native 助手伪造 parentID。
      yield* events.publish(SessionEvent.Prompted, {
        sessionID, messageID: SessionMessage.ID.make("msg_native_request"), timestamp: created,
        prompt: Prompt.make({ text: "request" }), delivery: "steer",
      })
      // admission 与 promotion 的边界由现有 projector 持久化，测试不另建 SQL 归属算法。
      // 每轮给五项不同的非零计数，能发现只累加最后一轮、遗漏 reasoning 或合并 cache 的错误。
      const records = yield* Effect.forEach([1, 2], (factor) => Effect.gen(function* () {
        const assistantMessageID = SessionMessage.ID.make(`msg_native_usage_${factor}`)
        const inputEstimate = { input: 777, bodyChars: 3108, confirmed: false, charsPerToken: 4,
          contextLimit: factor === 1 ? 2000 : 8000,
          inputBreakdown: { system: 2000, instructions: 108, skills: 0, tools: 200,
            messages: { userText: 500, assistantText: 100, reasoning: 50, toolInput: 50, toolOutput: 100, attachments: 0, total: 800 } } }
        // 首包前估算使用真实请求身份，不创建助手，也不重置历史确认累计。
        yield* events.publish(SessionEvent.RequestEstimated, {
          sessionID, messageID: SessionMessage.ID.make("msg_native_request"), timestamp: DateTime.makeUnsafe(factor),
          model, inputEstimate,
        })
        expect((yield* sessions.get(sessionID)).request).toMatchObject({
          messageID: "msg_native_request", input: factor === 1 ? 0 : 14, output: factor === 1 ? 0 : 4,
          stepInput: 0, stepOutput: 0, estimatedInput: 777,
        })
        expect((yield* sessions.get(sessionID)).request?.assistantID).toBeUndefined()
        expect((yield* sessions.get(sessionID)).request?.model).toEqual({ providerID: model.providerID, modelID: model.id, contextLimit: factor === 1 ? 2000 : 8000 })
        // 此刻还没有本轮Started助手，get/list仍须从RequestEstimated持久事件得到同一carrier，不能靠消息窗口补值。
        expect((yield* sessions.get(sessionID)).request?.inputEstimate).toEqual(inputEstimate)
        expect((yield* sessions.list({ project: Project.ID.global })).find(item => item.id === sessionID)?.request?.inputEstimate).toEqual(inputEstimate)
        yield* events.publish(SessionEvent.Step.Started, {
          sessionID, assistantMessageID, timestamp: DateTime.makeUnsafe(factor), agent: "build", model,
          inputEstimate,
        })
        // 第二个原生助手没有 tokens；首轮 14 输入和 4 输出仍是本请求的在途基数。
        expect((yield* sessions.get(sessionID)).request).toMatchObject({ assistantID: assistantMessageID, stepInput: 0, stepOutput: 0 })
        expect((yield* sessions.get(sessionID)).request?.pendingInput).toBe(factor === 1 ? undefined : 18)
        // Started 估算不改变任何确认累计或费用；get/list 共用 canonical 投影。
        expect((yield* sessions.get(sessionID)).request?.estimatedInput).toBe(777)
        expect((yield* sessions.list({ project: Project.ID.global })).find(item => item.id === sessionID)?.request?.estimatedInput).toBe(777)
        const ended = yield* events.publish(SessionEvent.Step.Ended, {
          sessionID, assistantMessageID, timestamp: DateTime.makeUnsafe(factor + 1), finish: "stop", cost: factor / 4,
          tokens: { input: factor * 2, output: factor * 3, reasoning: factor, cache: { read: factor * 5, write: factor * 7 } },
        })
        // replay 使用原 durable ID/seq/version，重新 publish 一个新事件不属于重复重放测试。
        if (!ended.durable) return yield* Effect.die("Native settlement must be durable")
        return {
          id: ended.id, aggregateID: ended.durable.aggregateID, seq: ended.durable.seq,
          type: EventV2.versionedType(ended.type, ended.durable.version),
          data: Schema.encodeSync(SessionEvent.Step.Ended.data)(ended.data),
        }
      }))
      const expected = { cost: 0.75, tokens: { input: 6, output: 9, reasoning: 3, cache: { read: 15, write: 21 } } }
      // 验证公开 get/list，而非只读 message.tokens；本次缺陷恰好发生在消息和会话行之间。
      expect(yield* sessions.get(sessionID)).toMatchObject(expected)
      expect((yield* sessions.list({ project: Project.ID.global })).find((item) => item.id === sessionID)).toMatchObject(expected)
      // native 两轮请求必须累计五项，V1 parts 表为空也不能得到零。
      expect((yield* sessions.get(sessionID)).request).toMatchObject({
        messageID: "msg_native_request", input: 42, output: 12, cost: 0.75,
        assistantID: "msg_native_usage_2", model: { providerID: "provider", modelID: "model" },
        // 最后 native step 与两轮请求累计不同，验证 #14 没把请求总量显示成 step。
        stepInput: 28, stepOutput: 8,
        // 此确认值不依赖任何 V1 step-finish，也不依赖 TUI 消息窗口。
      })
      expect((yield* sessions.get(sessionID)).request?.pendingInput).toBeUndefined()
      expect((yield* sessions.get(sessionID)).request?.estimatedInput).toBeUndefined()
      // 确认停止 provisional input，但字段证明与冻结预算仍随同一末步投影保留。
      expect((yield* sessions.get(sessionID)).request?.inputEstimate).toMatchObject({ confirmed: true, bodyChars: 3108, charsPerToken: 4, inputBreakdown: { system: 2000 } })
      const selected = ModelV2.Ref.make({
        providerID: model.providerID, id: ModelV2.ID.make("other-alias"), variant: ModelV2.VariantID.make("later"),
      })
      // 真实切换 producer 创建独立消息，不能覆盖已有用户与请求身份。
      yield* sessions.switchModel({ sessionID, model: selected })
      expect((yield* sessions.get(sessionID)).model?.id).toBe(selected.id)
      expect((yield* sessions.get(sessionID)).model?.variant).toBe(ModelV2.VariantID.make("later"))
      expect((yield* sessions.messages({ sessionID, order: "asc" })).at(-1)).toMatchObject({ type: "model-switched", model: selected })
      expect(yield* sessions.message({ sessionID, messageID: SessionMessage.ID.make("msg_native_request") })).toMatchObject({ type: "user", text: "request" })
      expect((yield* sessions.get(sessionID)).request?.model).toEqual({ providerID: model.providerID, modelID: model.id, contextLimit: 8000 })
      expect((yield* sessions.list({ project: Project.ID.global })).find(item => item.id === sessionID)?.request?.model?.contextLimit).toBe(8000)
      expect((yield* sessions.get(sessionID)).tokens).toEqual(expected.tokens)
      // 这里检查公开 get 的投影，不在断言里重复实现事件到请求的归属计算。
      // 重放已经落盘的两次结算，保留现有 sequencer 的去重边界，不在投影中另建标记。
      for (const record of records) yield* events.replay(record)
      expect(yield* sessions.get(sessionID)).toMatchObject(expected)
      expect((yield* sessions.list({ project: Project.ID.global })).find((item) => item.id === sessionID)).toMatchObject(expected)
      // updater 可覆盖旧助手的结算；修订应该替换第一轮，不能在两轮总量上再叠加完整用量。
      yield* events.publish(SessionEvent.Step.Ended, {
        sessionID, assistantMessageID: SessionMessage.ID.make("msg_native_usage_1"),
        timestamp: DateTime.makeUnsafe(4), finish: "stop", cost: 1,
        tokens: { input: 6, output: 9, reasoning: 3, cache: { read: 15, write: 21 } },
      })
      const corrected = { cost: 1.5, tokens: { input: 10, output: 15, reasoning: 5, cache: { read: 25, write: 35 } } }
      expect(yield* sessions.get(sessionID)).toMatchObject(corrected)
      expect((yield* sessions.list({ project: Project.ID.global })).find((item) => item.id === sessionID)).toMatchObject(corrected)
      // 此会话没有 V1 part，用旧的仅 part 回填会得到零；模拟未安装修正的旧 native 数据库。
      yield* database.db.run(sql`DELETE FROM migration WHERE id = ${stepUsageMigration.id}`)
      yield* database.db.update(SessionTable).set({
        tokens_input: 0, tokens_output: 0, tokens_reasoning: 0, tokens_cache_read: 0, tokens_cache_write: 0,
      }).where(eq(SessionTable.id, sessionID)).run()
      yield* DatabaseMigration.applyOnly(database.db, [stepUsageMigration])
      // 同一回填仅恢复五项 token，不能以修复旧 native 计数为由重写已有费用。
      expect(yield* sessions.get(sessionID)).toMatchObject(corrected)
      expect((yield* sessions.list({ project: Project.ID.global })).find((item) => item.id === sessionID)).toMatchObject(corrected)
      // stage 仅设边界，公开 commit 才删第二轮；保留修订后的第一轮并保持已花费用。
      yield* events.publish(SessionEvent.RevertEvent.Staged, {
        sessionID, timestamp: DateTime.makeUnsafe(5),
        revert: { messageID: SessionMessage.ID.make("msg_native_usage_1"), diff: "", files: [] },
      })
      yield* sessions.revert.commit(sessionID)
      const reverted = { cost: 1.5, tokens: { input: 6, output: 9, reasoning: 3, cache: { read: 15, write: 21 } } }
      expect(yield* sessions.get(sessionID)).toMatchObject(reverted)
      expect((yield* sessions.list({ project: Project.ID.global })).find((item) => item.id === sessionID)).toMatchObject(reverted)
      // 删除后重放旧结算仍由 sequencer 去重，不能复活已删消息或重新加回 token。
      for (const record of records) yield* events.replay(record)
      yield* sessions.revert.commit(sessionID)
      expect(yield* sessions.get(sessionID)).toMatchObject(reverted)
      expect((yield* sessions.list({ project: Project.ID.global })).find((item) => item.id === sessionID)).toMatchObject(reverted)
      // revert 删除第二轮后请求费用只取保留助手，会话已花费用仍不退款。
      expect((yield* sessions.get(sessionID)).request).toMatchObject({ input: 42, output: 12, cost: 1 })
      const activeRequest = (yield* sessions.get(sessionID)).request
      yield* events.publish(SessionEvent.PromptAdmitted, {
        sessionID, messageID: SessionMessage.ID.make("msg_waiting_request"), timestamp: DateTime.makeUnsafe(6),
        prompt: Prompt.make({ text: "waiting" }), delivery: "queue",
      })
      // 入队只增加待处理输入，当前轮的累计、模型和未确认状态均保持原快照。
      expect((yield* sessions.get(sessionID)).request).toEqual(activeRequest)
      expect((yield* sessions.get(sessionID)).cost).toBe(1.5)
      // 旧助手迟到结算不改变请求身份；只比较 admission/promotion，不比较 Ended 序号。
      yield* events.publish(SessionEvent.Step.Ended, {
        sessionID, assistantMessageID: SessionMessage.ID.make("msg_native_usage_1"),
        timestamp: DateTime.makeUnsafe(7), finish: "stop", cost: 1,
        tokens: { input: 6, output: 9, reasoning: 3, cache: { read: 15, write: 21 } },
      })
      expect((yield* sessions.get(sessionID)).request).toEqual(activeRequest)
      // get/list共用同一活跃请求，模型与助手不能被未提升的queue清空。
      expect((yield* sessions.list({ project: Project.ID.global })).find((item) => item.id === sessionID)?.request).toEqual((yield* sessions.get(sessionID)).request)
      // 真实 V1 turn 更换助手；旧 native 的确认不得混入新 V1 请求的上下文。
      const userID = SessionV1.MessageID.ascending()
      yield* events.publish(SessionV1.Event.MessageUpdated, { sessionID, info: {
        id: userID, sessionID, role: "user", time: { created: 8 }, agent: "build",
        model: { providerID: model.providerID, modelID: model.id },
      } })
      const legacy: SessionV1.Assistant = { id: SessionV1.MessageID.ascending(), sessionID, role: "assistant", parentID: userID,
        agent: "build", mode: "build", modelID: model.id, providerID: model.providerID,
        path: { cwd: "/project", root: "/project" }, cost: 0,
        tokens: { input: 2, output: 3, reasoning: 1, cache: { read: 5, write: 7 } }, time: { created: 9, completed: 10 } }
      yield* events.publish(SessionV1.Event.MessageUpdated, { sessionID, info: legacy })
      const finish: SessionV1.StepFinishPart = { id: SessionV1.PartID.ascending(), sessionID, messageID: legacy.id,
        type: "step-finish", reason: "stop", cost: 0, tokens: legacy.tokens }
      yield* events.publish(SessionV1.Event.PartUpdated, { sessionID, part: finish,
        time: 10 })
      // 第二次确认改变上下文基数，下一轮不能使用请求累计 54 或最早一轮 18。
      const prior = { ...legacy, id: SessionV1.MessageID.ascending(), tokens: { input: 4, output: 6, reasoning: 2, cache: { read: 10, write: 14 } }, time: { created: 10, completed: 11 } }
      yield* events.publish(SessionV1.Event.MessageUpdated, { sessionID, info: prior })
      yield* events.publish(SessionV1.Event.PartUpdated, { sessionID, part: { ...finish, id: SessionV1.PartID.ascending(), messageID: prior.id, tokens: prior.tokens },
        time: 11 })
      const next = { ...legacy, id: SessionV1.MessageID.ascending(), tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 12 } }
      yield* events.publish(SessionV1.Event.MessageUpdated, { sessionID, info: next })
      // 新助手无 parts 时也必须得到上一轮 36，不能借用其他请求或全部轮次。
      expect((yield* sessions.get(sessionID)).request).toMatchObject({
        messageID: userID, assistantID: next.id, input: 42, output: 12, stepInput: 0, stepOutput: 0, pendingInput: 36,
      })
      expect((yield* sessions.list({ project: Project.ID.global })).find((item) => item.id === sessionID)?.request).toEqual((yield* sessions.get(sessionID)).request)
      // V1 元数据先到，tokens 仍为零；真实请求体估算不进入确认 input=42。
      yield* events.publish(SessionV1.Event.MessageUpdated, { sessionID, info: { ...next,
        inputEstimate: { input: 777, bodyChars: 3108, confirmed: false } } })
      expect((yield* sessions.get(sessionID)).request).toMatchObject({ input: 42, output: 12, estimatedInput: 777 })
      // fixture 后续零 step-finish 必须直接遮掉 provisional input，不能等待完成时间。
      // 零 step-finish 是确认边界，不得因为累计仍非零就保留上一轮估算。
      yield* events.publish(SessionV1.Event.PartUpdated, { sessionID, part: { ...finish, id: SessionV1.PartID.ascending(), messageID: next.id, tokens: next.tokens },
        time: 12 })
      expect((yield* sessions.get(sessionID)).request).toMatchObject({ input: 42, output: 12, stepInput: 0, stepOutput: 0 })
      expect((yield* sessions.get(sessionID)).request?.pendingInput).toBeUndefined()
      expect((yield* sessions.get(sessionID)).request?.estimatedInput).toBeUndefined()
      // completed=0 同样是终态；展示输入不能恢复到先前非零上下文。
      yield* events.publish(SessionV1.Event.MessageUpdated, { sessionID, info: { ...next, time: { created: 12, completed: 0 } } })
      expect((yield* sessions.get(sessionID)).request?.pendingInput).toBeUndefined()
      // 无回复用户仍属排队窗口，不应抹去配对轮次的确认值；首包前估算不复活。
      yield* events.publish(SessionV1.Event.MessageUpdated, { sessionID, info: {
        id: SessionV1.MessageID.ascending(), sessionID, role: "user", time: { created: 13 }, agent: "build", model: { providerID: model.providerID, modelID: model.id },
      } })
      expect((yield* sessions.get(sessionID)).request?.pendingInput).toBeUndefined()
      expect((yield* sessions.get(sessionID)).request).toMatchObject({ input: 42, output: 12, stepInput: 0, stepOutput: 0 })
      expect((yield* sessions.get(sessionID)).request?.assistantID).toBe(next.id)
      // 原生零确认没有 V1 part，必须依靠 tokens 是否存在而不是数字真值。
      const zeroRequest = SessionMessage.ID.make("msg_zero_estimate")
      const zeroAssistant = SessionMessage.ID.make("msg_zero_estimate_assistant")
      const inputEstimate = { input: 777, bodyChars: 3108, confirmed: false }
      yield* events.publish(SessionEvent.Prompted, { sessionID, messageID: zeroRequest,
        timestamp: DateTime.makeUnsafe(14), prompt: Prompt.make({ text: "zero" }), delivery: "steer" })
      yield* events.publish(SessionEvent.RequestEstimated, { sessionID, messageID: zeroRequest,
        timestamp: DateTime.makeUnsafe(15), model, inputEstimate })
      yield* events.publish(SessionEvent.Step.Started, { sessionID, assistantMessageID: zeroAssistant,
        timestamp: DateTime.makeUnsafe(16), agent: "build", model, inputEstimate })
      yield* events.publish(SessionEvent.Step.Ended, { sessionID, assistantMessageID: zeroAssistant,
        timestamp: DateTime.makeUnsafe(17), finish: "stop", cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } })
      expect((yield* sessions.get(sessionID)).request).toMatchObject({ input: 0, output: 0, stepInput: 0, stepOutput: 0 })
      expect((yield* sessions.get(sessionID)).request?.estimatedInput).toBeUndefined()
      // 空成功只闭合现有请求，估算事件不制造零用量助手或额外 provider turn。
      const emptyRequest = SessionMessage.ID.make("msg_empty_estimate")
      yield* events.publish(SessionEvent.Prompted, { sessionID, messageID: emptyRequest,
        timestamp: DateTime.makeUnsafe(18), prompt: Prompt.make({ text: "empty" }), delivery: "steer" })
      yield* events.publish(SessionEvent.RequestEstimated, { sessionID, messageID: emptyRequest,
        timestamp: DateTime.makeUnsafe(19), model, inputEstimate })
      yield* events.publish(SessionEvent.PromptCompleted, { sessionID, messageID: emptyRequest,
        timestamp: DateTime.makeUnsafe(20), requestIDs: [emptyRequest] })
      expect((yield* sessions.get(sessionID)).request?.assistantID).toBeUndefined()
      expect((yield* sessions.get(sessionID)).request?.estimatedInput).toBeUndefined()
      expect((yield* sessions.get(sessionID)).request?.model).toBeUndefined()
    }).pipe(Effect.provide(sessionsLayer)),
  )

  it.effect("projects moved sessions without the transitional context epoch table", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const events = yield* EventV2.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .run()
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: Project.ID.global,
          slug: "test",
          directory: "/project",
          title: "test",
          version: "test",
        })
        .run()
      yield* db.run(sql`DROP TABLE session_context_epoch`)

      yield* events.publish(SessionEvent.Moved, {
        sessionID,
        timestamp: DateTime.makeUnsafe(1),
        location: Location.Ref.make({ directory: AbsolutePath.make("/project/subdir") }),
      })

      expect(yield* db.select({ directory: SessionTable.directory }).from(SessionTable).get()).toEqual({
        directory: "/project/subdir",
      })
    }),
  )

  it.effect("stages tool-owned native revert paths and keeps metadata-free history message-only", () => {
    const restores: [RelativePath, Snapshot.ID][][] = []
    const directory = AbsolutePath.make("/project/app")
    return Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const events = yield* EventV2.Service
      yield* db.insert(ProjectTable).values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] }).run()
      yield* db.insert(SessionTable).values({ id: sessionID, project_id: Project.ID.global, slug: "revert",
        directory, title: "revert", version: "test" }).run()
      const session = { id: sessionID, projectID: Project.ID.global, title: "revert", location: { directory },
        cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created, updated: created } }
      const first = yield* SessionInput.admit(db, events, { id: SessionMessage.ID.make("msg_revert_first"), sessionID,
        prompt: Prompt.make({ text: "edit mine" }), delivery: "steer" })
      yield* SessionInput.promoteSteers(db, events, sessionID, first.admittedSeq)
      const assistantMessageID = SessionMessage.ID.make("msg_revert_assistant")
      yield* events.publish(SessionEvent.Step.Started, { sessionID, assistantMessageID, timestamp: created, agent: "build", model, snapshot: "tree_before" })
      yield* events.publish(SessionEvent.Tool.Input.Started, { sessionID, assistantMessageID, callID: "write", name: "write", timestamp: created })
      yield* events.publish(SessionEvent.Tool.Called, { sessionID, assistantMessageID, callID: "write", tool: "write", input: {}, provider: { executed: false }, timestamp: created })
      yield* events.publish(SessionEvent.Tool.Success, { sessionID, assistantMessageID, callID: "write", timestamp: created,
        structured: { target: "/project/app/mine.ts", resource: "mine.ts", existed: false, diff: "+mine\n" }, content: [], provider: { executed: false } })
      const settlement = { sessionID, assistantMessageID, timestamp: created, finish: "stop", cost: 0,
        tokens: session.tokens, snapshot: "tree_after", files: [RelativePath.make("app/mine.ts"), RelativePath.make("app/other.ts")] }
      yield* events.publish(SessionEvent.Step.Ended, settlement)
      // 真实Step投影含同目录其他会话文件；生产plan必须只留下本工具触碰的项目相对键。
      const revert = yield* SessionRevert.stage({ session, messageID: first.id })
      expect(restores).toEqual([[[RelativePath.make("app/mine.ts"), Snapshot.ID.make("tree_before")]]])
      expect(revert.files?.map(file => file.path)).toEqual([RelativePath.make("app/mine.ts")])
      expect((yield* db.select({ revert: SessionTable.revert }).from(SessionTable).get())?.revert?.files).toEqual(revert.files)
      yield* SessionRevert.clear({ ...session, revert })
      expect(restores[1]).toEqual([[RelativePath.make("app/mine.ts"), Snapshot.ID.make("tree_current")]])
      expect((yield* db.select({ revert: SessionTable.revert }).from(SessionTable).get())?.revert).toBeNull()
      // 再次撤回沿用上次原树和精确文件清单，不能把未触碰文件加入恢复Map。
      yield* SessionRevert.stage({ session: { ...session, revert }, messageID: first.id })
      expect(restores[2]).toEqual([[RelativePath.make("app/mine.ts"), Snapshot.ID.make("tree_before")]])
      const later = yield* SessionInput.admit(db, events, { id: SessionMessage.ID.make("msg_revert_legacy"), sessionID,
        prompt: Prompt.make({ text: "old shell turn" }), delivery: "steer" })
      yield* SessionInput.promoteSteers(db, events, sessionID, later.admittedSeq)
      const legacy = SessionMessage.ID.make("msg_revert_legacy_assistant")
      yield* events.publish(SessionEvent.Step.Started, { sessionID, assistantMessageID: legacy, timestamp: created, agent: "build", model, snapshot: "tree_legacy" })
      yield* events.publish(SessionEvent.Step.Ended, { ...settlement, assistantMessageID: legacy, files: [RelativePath.make("app/legacy.ts")] })
      const legacyRevert = yield* SessionRevert.stage({ session, messageID: later.id })
      // 无声明时仍成功记录消息撤回，但不能恢复该时间窗混入的其他文件。
      expect(restores).toHaveLength(3)
      expect(legacyRevert.files).toEqual([])
      expect(legacyRevert.messageID).toBe(later.id)
      // 显式仅撤消息时不进行文件恢复；未知边界保持原typed错误，而非成功空结果。
      const messageOnly = yield* SessionRevert.stage({ session, messageID: later.id, files: false })
      expect(messageOnly.files).toEqual([])
      expect(restores).toHaveLength(3)
      expect(yield* SessionRevert.stage({ session, messageID: SessionMessage.ID.make("msg_missing") }).pipe(Effect.flip)).toBeInstanceOf(SessionRevert.MessageNotFoundError)
      yield* db.delete(SessionTable).where(eq(SessionTable.id, sessionID)).run()
    }).pipe(
      Effect.provideService(Location.Service, Location.Service.of({ directory, project: { id: Project.ID.global, directory: AbsolutePath.make("/project") } })),
      Effect.provide(Layer.mock(Snapshot.Service, {
        capture: () => Effect.succeed(Snapshot.ID.make("tree_current")),
        restore: ({ files }) => Effect.sync(() => { restores.push([...files]) }),
        // 替身只记录生产传入路径，实际筛选和持久化均由真实owner完成，不复制归属算法。
        diff: ({ paths }) => Effect.succeed((paths ?? []).map(path => ({ path, status: "modified" as const, patch: "-new\n+old\n", additions: 1, deletions: 1 }))),
      })),
    )
  })

  it.effect("projects staged, cleared, and committed reverts", () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .run()
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: Project.ID.global,
          slug: "test",
          directory: "/project",
          title: "test",
          version: "test",
        })
        .run()
      const boundary = SessionMessage.ID.make("msg_boundary")
      yield* db
        .insert(SessionMessageTable)
        .values([assistantRow(boundary, 1), assistantRow(SessionMessage.ID.make("msg_later"), 2)])
        .run()
      const events = yield* EventV2.Service
      yield* events.publish(SessionEvent.RevertEvent.Staged, {
        sessionID,
        timestamp: DateTime.makeUnsafe(1),
        revert: { messageID: boundary, snapshot: Snapshot.ID.make("tree"), diff: "patch", files: [] },
      })
      expect((yield* db.select({ revert: SessionTable.revert }).from(SessionTable).get())?.revert).toMatchObject({
        messageID: boundary,
        snapshot: "tree",
        files: [],
      })
      yield* events.publish(SessionEvent.RevertEvent.Cleared, { sessionID, timestamp: DateTime.makeUnsafe(2) })
      expect((yield* db.select({ revert: SessionTable.revert }).from(SessionTable).get())?.revert).toBeNull()
      yield* events.publish(SessionEvent.RevertEvent.Staged, {
        sessionID,
        timestamp: DateTime.makeUnsafe(3),
        revert: { messageID: boundary, files: [] },
      })
      yield* events.publish(SessionEvent.RevertEvent.Committed, {
        sessionID,
        messageID: boundary,
        timestamp: DateTime.makeUnsafe(4),
      })
      expect(
        (yield* db.select({ id: SessionMessageTable.id }).from(SessionMessageTable).all()).map((row) => row.id),
      ).toEqual([boundary])
    }),
  )

  it.effect("orders projected messages and context by durable aggregate sequence", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: Project.ID.global,
          slug: "test",
          directory: "/project",
          title: "test",
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)
      const events = yield* EventV2.Service

      yield* events.publish(
        SessionEvent.Prompted,
        {
          sessionID,
          messageID: SessionMessage.ID.make("msg_first"),
          timestamp: created,
          prompt: Prompt.make({ text: "first" }),
          delivery: "steer",
        },
        { id: EventV2.ID.make("evt_z") },
      )
      yield* events.publish(
        SessionEvent.Prompted,
        {
          sessionID,
          messageID: SessionMessage.ID.make("msg_second"),
          timestamp: created,
          prompt: Prompt.make({ text: "second" }),
          delivery: "steer",
        },
        { id: EventV2.ID.make("evt_a") },
      )

      const sessions = yield* SessionV2.Service
      const firstPage = yield* sessions.messages({ sessionID, limit: 1, order: "asc" })
      expect(firstPage.map((message) => (message.type === "user" ? message.text : message.type))).toEqual(["first"])
      const secondPage = yield* sessions.messages({
        sessionID,
        limit: 1,
        order: "asc",
        cursor: { id: firstPage[0]!.id, direction: "next" },
      })
      expect(secondPage.map((message) => (message.type === "user" ? message.text : message.type))).toEqual(["second"])
      expect(
        (yield* sessions.messages({
          sessionID,
          limit: 1,
          order: "asc",
          cursor: { id: secondPage[0]!.id, direction: "previous" },
        })).map((message) => (message.type === "user" ? message.text : message.type)),
      ).toEqual(["first"])
      expect(
        (yield* sessions.context(sessionID)).map((message) => (message.type === "user" ? message.text : message.type)),
      ).toEqual(["first", "second"])
    }).pipe(Effect.provide(sessionsLayer)),
  )

  it.effect("marks an inbox row promoted with the Prompted event sequence", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: Project.ID.global,
          slug: "test",
          directory: "/project",
          title: "test",
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)
      const events = yield* EventV2.Service
      const id = SessionMessage.ID.make("msg_admitted")
      const admitted = yield* SessionInput.admit(db, events, {
        id,
        sessionID,
        prompt: Prompt.make({ text: "promote me" }),
        delivery: "steer",
      })
      if (!admitted) return yield* Effect.die("Prompt admission failed")

      const event = yield* events.publish(SessionEvent.Prompted, {
        sessionID,
        timestamp: admitted.timeCreated,
        messageID: id,
        prompt: Prompt.make({ text: "promote me" }),
        delivery: "steer",
      })

      expect(
        yield* db.select().from(SessionInputTable).where(eq(SessionInputTable.id, id)).get().pipe(Effect.orDie),
      ).toMatchObject({ promoted_seq: event.durable?.seq })
    }),
  )

  it.effect("projects durable context messages supported by the updater", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: Project.ID.global,
          slug: "test",
          directory: "/project",
          title: "test",
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)
      const events = yield* EventV2.Service

      yield* events.publish(SessionEvent.AgentSwitched, {
        sessionID,
        messageID: SessionMessage.ID.create(),
        timestamp: created,
        agent: "build",
      })
      yield* events.publish(SessionEvent.ModelSwitched, {
        sessionID,
        messageID: SessionMessage.ID.create(),
        timestamp: created,
        model,
      })
      yield* events.publish(SessionEvent.Synthetic, {
        sessionID,
        messageID: SessionMessage.ID.create(),
        timestamp: created,
        text: "synthetic context",
      })
      yield* events.publish(SessionEvent.Shell.Started, {
        sessionID,
        messageID: SessionMessage.ID.create(),
        timestamp: created,
        callID: "shell-1",
        command: "pwd",
      })
      yield* events.publish(SessionEvent.Shell.Ended, {
        sessionID,
        timestamp: DateTime.makeUnsafe(1),
        callID: "shell-1",
        output: "/project",
      })
      const compactionID = SessionMessage.ID.create()
      yield* events.publish(SessionEvent.Compaction.Started, {
        sessionID,
        messageID: compactionID,
        timestamp: created,
        reason: "manual",
      })
      yield* events.publish(SessionEvent.Compaction.Delta, {
        sessionID,
        messageID: compactionID,
        timestamp: created,
        text: "partial",
      })
      expect(
        yield* db
          .select({ id: EventTable.id })
          .from(EventTable)
          .where(eq(EventTable.type, SessionEvent.Compaction.Delta.type))
          .all()
          .pipe(Effect.orDie),
      ).toEqual([])
      expect(
        yield* db
          .select({ id: SessionMessageTable.id })
          .from(SessionMessageTable)
          .where(eq(SessionMessageTable.type, "compaction"))
          .all()
          .pipe(Effect.orDie),
      ).toEqual([])
      yield* events.publish(SessionEvent.Compaction.Ended, {
        sessionID,
        messageID: compactionID,
        timestamp: DateTime.makeUnsafe(1),
        reason: "manual",
        text: "summary",
        recent: "recent context",
        recent_user_messages: [{ id: SessionMessage.ID.make("msg_instruction"), text: "Exact instruction", truncated: true }],
        file_evidence: "## Evidence Handoff\n| file.ts | 1-2 | 2 | local time | stale |",
      })

      const rows = yield* db
        .select()
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.session_id, sessionID))
        .orderBy(asc(SessionMessageTable.seq))
        .all()
        .pipe(Effect.orDie)
      const messages = rows.map((row) =>
        Schema.decodeUnknownSync(SessionMessage.Message)({ ...row.data, id: row.id, type: row.type }),
      )

      expect(messages.map((message) => message.type)).toEqual([
        "agent-switched",
        "model-switched",
        "synthetic",
        "shell",
        "compaction",
      ])
      expect(messages.find((message) => message.type === "shell")).toMatchObject({
        output: "/project",
        time: { completed: DateTime.makeUnsafe(1) },
      })
      expect(messages.find((message) => message.type === "compaction")).toMatchObject({
        summary: "summary",
        recent: "recent context",
        recent_user_messages: [{ id: "msg_instruction", text: "Exact instruction", truncated: true }],
        file_evidence: "## Evidence Handoff\n| file.ts | 1-2 | 2 | local time | stale |",
      })
      expect(rows.find(row => row.type === "compaction")?.data).toMatchObject({ recent_user_messages: [{ id: "msg_instruction", text: "Exact instruction", truncated: true }] })
      expect(rows.find(row => row.type === "compaction")?.data).toHaveProperty("file_evidence", "## Evidence Handoff\n| file.ts | 1-2 | 2 | local time | stale |")
      expect(
        yield* db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get().pipe(Effect.orDie),
      ).toMatchObject({
        agent: "build",
        model,
        time_updated: DateTime.toEpochMillis(created),
      })
      // 第二轮压缩仍能取到旧边界前真实Read；未来行不属于本次快照。
      const receipt = { path: "/project/file.ts", canonicalPath: "/project/file.ts", type: "file", size: 1,
        modified: "2026-05-18 01:00:00", modifiedMs: 0, start: 1, end: 1, total: 1,
        totalExact: true, returned: 1, stub: false }
      const tool = Schema.encodeSync(SessionMessage.AssistantTool)(SessionMessage.AssistantTool.make({
        type: "tool", id: "read-evidence", name: "read", time: { created, completed: created },
        state: SessionMessage.ToolStateCompleted.make({ status: "completed", input: {}, content: [{ type: "text", text: "x" }], structured: { read: receipt } }),
      }))
      const boundary = rows.find(row => row.type === "compaction")
      if (!boundary) return yield* Effect.die("Missing persisted compaction boundary")
      const earlier = assistantRow(SessionMessage.ID.make("msg_receipt_before"), boundary.seq - 1)
      const later = assistantRow(SessionMessage.ID.make("msg_receipt_after"), boundary.seq + 1)
      const searches = [
        { ...tool, id: "grep", name: "grep", state: { ...tool.state, input: { pattern: "needle", path: "src" }, structured: { items: [{ path: "file.ts" }], partial: true, truncated: false } } },
        { ...tool, id: "glob", name: "glob", state: { ...tool.state, input: { pattern: "*.ts" }, structured: { value: [{ path: "file.ts" }] } } },
      ]
      const earlierData = { ...earlier.data, content: [tool, ...searches] }
      const laterData = { ...later.data, content: [{ ...tool, id: "future-read", state: { ...tool.state, structured: { read: { ...receipt, path: "future.ts" } } } }] }
      yield* db.insert(SessionMessageTable).values([
        { ...earlier, data: earlierData },
        { ...later, data: laterData },
      ]).run().pipe(Effect.orDie)
      expect(yield* SessionHistory.readReceipts(db, sessionID, boundary.seq)).toEqual([receipt])
      const evidence = yield* SessionHistory.evidence(db, sessionID, boundary.seq)
      expect(evidence.compactionCount).toBe(2)
      expect(evidence.searches).toEqual([
        { tool: "grep", pattern: "needle", path: "src", matches: 1, partial: true },
        { tool: "glob", pattern: "*.ts", path: ".", matches: 1, partial: false },
      ])
      expect((yield* SessionHistory.load(db, sessionID)).some(message => message.id === earlier.id)).toBe(false)
      // 旧消息缺少optional证据字段仍能解码，已保存表格则保持逐字回放而不重新stat。
      const compacted = messages.find(message => message.type === "compaction")
      if (!compacted || compacted.type !== "compaction") return yield* Effect.die("Missing compaction projection")
      const encoded = Schema.encodeSync(SessionMessage.Compaction)(compacted)
      expect(Schema.decodeUnknownSync(SessionMessage.Compaction)(encoded).file_evidence).toBe(compacted.file_evidence)
      const { file_evidence: _fileEvidence, ...legacy } = encoded
      expect(Schema.decodeUnknownSync(SessionMessage.Compaction)(legacy).file_evidence).toBeUndefined()
    }),
  )

  it.effect("rejects distinct creator events that reuse one projected message ID", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: Project.ID.global,
          slug: "test",
          directory: "/project",
          title: "test",
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)
      const events = yield* EventV2.Service
      const id = SessionMessage.ID.make("msg_creator_collision")

      yield* events.publish(SessionEvent.Synthetic, { sessionID, messageID: id, timestamp: created, text: "keep me" })
      const exit = yield* events
        .publish(SessionEvent.Step.Started, {
          sessionID,
          assistantMessageID: id,
          timestamp: created,
          agent: "build",
          model,
        })
        .pipe(Effect.exit)

      expect(exit._tag).toBe("Failure")
      expect(
        yield* db.select().from(SessionMessageTable).where(eq(SessionMessageTable.id, id)).get().pipe(Effect.orDie),
      ).toMatchObject({ type: "synthetic" })
    }),
  )

  it.effect("does not revive a stale incomplete in-memory assistant projection", () =>
    Effect.gen(function* () {
      const stale = SessionMessage.Assistant.make({
        id: SessionMessage.ID.make("msg_assistant_stale"),
        type: "assistant",
        agent: "build",
        model,
        content: [],
        time: { created },
      })
      const completed = SessionMessage.Assistant.make({
        id: SessionMessage.ID.make("msg_assistant_completed"),
        type: "assistant",
        agent: "build",
        model,
        content: [],
        time: { created: DateTime.makeUnsafe(1), completed: DateTime.makeUnsafe(2) },
      })

      expect(
        yield* SessionMessageUpdater.memory({ messages: [stale, completed] }).getCurrentAssistant(),
      ).toBeUndefined()
    }),
  )

  it.effect("updates only the newest incomplete assistant projection", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: Project.ID.global,
          slug: "test",
          directory: "/project",
          title: "test",
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionMessageTable)
        .values([
          assistantRow(SessionMessage.ID.make("msg_assistant_1"), 0),
          assistantRow(SessionMessage.ID.make("msg_assistant_2"), 1),
        ])
        .run()
        .pipe(Effect.orDie)

      const service = yield* EventV2.Service
      yield* service.publish(SessionEvent.Step.Ended, {
        sessionID,
        timestamp: DateTime.makeUnsafe(1),
        assistantMessageID: SessionMessage.ID.make("msg_assistant_2"),
        finish: "stop",
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      })

      const rows = yield* db
        .select()
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.session_id, sessionID))
        .orderBy(asc(SessionMessageTable.id))
        .all()
        .pipe(Effect.orDie)
      const messages = rows.map((row) =>
        Schema.decodeUnknownSync(SessionMessage.Message)({ ...row.data, id: row.id, type: row.type }),
      )
      expect(messages[0]).not.toHaveProperty("time.completed")
      expect(messages[1]).toMatchObject({
        type: "assistant",
        finish: "stop",
        time: { completed: DateTime.makeUnsafe(1) },
      })
    }),
  )

  it.effect("does not revive a stale incomplete assistant projection", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: Project.ID.global,
          slug: "test",
          directory: "/project",
          title: "test",
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionMessageTable)
        .values([
          assistantRow(SessionMessage.ID.make("msg_assistant_stale"), 0),
          assistantRow(SessionMessage.ID.make("msg_assistant_completed"), 1, {
            created: DateTime.makeUnsafe(1),
            completed: DateTime.makeUnsafe(2),
          }),
        ])
        .run()
        .pipe(Effect.orDie)

      const service = yield* EventV2.Service
      yield* service.publish(SessionEvent.Text.Started, {
        sessionID,
        assistantMessageID: SessionMessage.ID.make("msg_assistant_completed"),
        timestamp: DateTime.makeUnsafe(3),
        textID: "text-stale",
      })

      const rows = yield* db
        .select()
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.session_id, sessionID))
        .orderBy(asc(SessionMessageTable.id))
        .all()
        .pipe(Effect.orDie)
      const messages = rows.map((row) =>
        Schema.decodeUnknownSync(SessionMessage.Message)({ ...row.data, id: row.id, type: row.type }),
      )
      expect(messages).toEqual([
        SessionMessage.Assistant.make({
          id: SessionMessage.ID.make("msg_assistant_completed"),
          type: "assistant",
          agent: "build",
          model,
          content: [SessionMessage.AssistantText.make({ type: "text", id: "text-stale", text: "" })],
          time: { created: DateTime.makeUnsafe(1), completed: DateTime.makeUnsafe(2) },
        }),
        SessionMessage.Assistant.make({
          id: SessionMessage.ID.make("msg_assistant_stale"),
          type: "assistant",
          agent: "build",
          model,
          content: [],
          time: { created },
        }),
      ])
    }),
  )
})
