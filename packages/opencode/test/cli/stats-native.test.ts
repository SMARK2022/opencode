import { expect } from "bun:test"
import { createHash } from "node:crypto"
import { eq } from "drizzle-orm"
import { DateTime, Effect } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { ColdStorage } from "@opencode-ai/core/storage/cold-storage"
import { extractSessionMessageCore } from "@opencode-ai/core/storage/cold-codec"
import { RequestUsageAssistantTable, RequestUsageTable } from "@opencode-ai/core/session/request-usage.sql"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Prompt } from "@opencode-ai/core/session/prompt"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { ColdStorageTable, SessionMessageTable, SessionTable } from "@opencode-ai/core/session/sql"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Session } from "../../src/session/session"
import { aggregateStats } from "../../src/cli/cmd/stats-data"
import { renderSessions } from "../../src/cli/cmd/stats-render"
import { testEffect } from "../lib/effect"

// 独立内存库、真实事件投影和查询服务，不靠手造 StatsReport 证明原生统计。
const it = testEffect(
  LayerNode.compile(LayerNode.group([Session.node, Database.node, EventV2.node, SessionProjector.node]), [
    [Database.node, Database.layerFromPath(":memory:")],
  ]),
)

it.effect("stats counts native and mixed transcripts without duplicate projections", () =>
  Effect.gen(function* () {
    const database = yield* Database.Service
    const events = yield* EventV2.Service
    const projectID = ProjectV2.ID.make("stats-native")
    const sessionID = SessionSchema.ID.make("ses_stats_native")
    const directory = AbsolutePath.make(process.cwd())
    const now = Date.now()
    const timestamp = DateTime.makeUnsafe(now)
    const model = { id: ModelV2.ID.make("native-model"), providerID: ProviderV2.ID.make("native-provider") }
    const tokens = { input: 5, output: 3, reasoning: 2, cache: { read: 0, write: 0 } }
    yield* database.db.insert(ProjectTable).values({ id: projectID, worktree: directory, sandboxes: [] }).run()
    yield* database.db
      .insert(SessionTable)
      .values({
        id: sessionID,
        project_id: projectID,
        directory,
        slug: "native",
        title: "native",
        version: "test",
        time_created: now,
        time_updated: now,
      })
      .run()
    const userID = SessionMessage.ID.make("msg_stats_native_user")
    const assistantMessageID = SessionMessage.ID.make("msg_stats_native_assistant")
    // 同一工具的输入、调用、进度和完成只能在最终工具榜贡献一次。
    yield* events.publish(SessionEvent.Prompted, {
      sessionID,
      messageID: userID,
      timestamp,
      prompt: Prompt.make({ text: "hello" }),
      delivery: "steer",
    })
    yield* events.publish(SessionEvent.Step.Started, {
      sessionID,
      assistantMessageID,
      timestamp,
      agent: "build",
      model,
    })
    const call = { sessionID, assistantMessageID, timestamp, callID: "stats-call" }
    yield* events.publish(SessionEvent.Tool.Input.Started, { ...call, name: "echo" })
    yield* events.publish(SessionEvent.Tool.Called, { ...call, tool: "echo", input: {}, provider: { executed: false } })
    yield* events.publish(SessionEvent.Tool.Progress, {
      ...call,
      structured: {},
      content: [{ type: "text", text: "progress" }],
    })
    const structured = { legacy: "native legacy ".repeat(500) }
    yield* events.publish(SessionEvent.Tool.Success, {
      ...call,
      structured,
      content: [{ type: "text", text: "done" }],
      provider: { executed: false },
    })
    yield* events.publish(SessionEvent.Step.Ended, {
      sessionID,
      assistantMessageID,
      timestamp,
      finish: "stop",
      cost: 0.5,
      tokens,
    })
    const native = yield* aggregateStats({ projectFilter: projectID })
    expect(native.totalMessages).toBe(2)
    expect(native.totalTools).toBe(1)
    expect(native.toolUsage.map((tool) => ({ id: tool.id, count: tool.count }))).toEqual([{ id: "echo", count: 1 }])
    expect(native.toolUsage[0]).toMatchObject({ inputChars: 2, outputChars: 4 })
    expect(native.total).toMatchObject({ cost: 0.5, tokens: { total: 10 } })
    expect(native.sessions[0]).toMatchObject({ messages: 2, tools: 1 })
    // 三种持久表示须生成同一完整报表；统计不得回热owner、交换引用或补写账本。
    const stored = Effect.all([
      database.db.select().from(SessionMessageTable).all(),
      database.db.select().from(ColdStorageTable).all(),
      database.db.select().from(RequestUsageTable).all(),
      database.db.select().from(RequestUsageAssistantTable).all(),
    ])
    const legacyFields = yield* Database.withSync(database, (sync) => {
      // 旧格式夹具复用真实writer字段，不能依赖当前v3包的tuple排布。
      const hot = sync.select().from(SessionMessageTable).where(eq(SessionMessageTable.id, assistantMessageID)).get()
      if (!hot) throw new Error("Native hot fixture is missing")
      const extracted = extractSessionMessageCore(hot, false)
      expect(
        ColdStorage.freezeOwner(sync, {
          type: "session_message",
          id: assistantMessageID,
          olderThanMs: 0,
          now: Date.now() + 1,
        }).type,
      ).toBe("frozen")
      return extracted?.fields
    })
    const packed = yield* database.db
      .select()
      .from(SessionMessageTable)
      .where(eq(SessionMessageTable.id, assistantMessageID))
      .get()
    if (!packed?.cold_ref) return yield* Effect.die("Native packed fixture is missing")
    const packedRef = packed.cold_ref
    // 四字节slot归属包内寻址，摘要仍由真实codec用于去重。
    expect(packed.cold_key).toHaveLength(4)
    expect(packed.cold_stats?.tools["0"]).toEqual({ inputChars: 2, outputChars: 4 })
    const archive = yield* database.db.select().from(ColdStorageTable).where(eq(ColdStorageTable.hash, packedRef)).get()
    if (!archive) return yield* Effect.die("Native pack payload is missing")
    expect(archive.kind).toBe("session-message-pack")
    // 损坏frame仍可读同行统计，证明Stats没有暗中解包；完整业务读取另由codec负责拒绝。
    yield* database.db
      .update(ColdStorageTable)
      .set({ payload: Buffer.from([0]) })
      .where(eq(ColdStorageTable.hash, packedRef))
      .run()
    const packedBefore = yield* stored
    expect(yield* aggregateStats({ projectFilter: projectID })).toEqual(native)
    expect(yield* stored).toEqual(packedBefore)
    yield* database.db
      .update(ColdStorageTable)
      .set({ payload: archive.payload })
      .where(eq(ColdStorageTable.hash, packedRef))
      .run()
    // 字段提取在冻结前完成，完整旧envelope仍通过正式读取和升级路径。
    if (!legacyFields) return yield* Effect.die("Native pack fields are missing")
    const raw = Buffer.from(JSON.stringify({ fields: legacyFields, owner: "session_message", version: 1 }))
    const payload = Buffer.from(Bun.zstdCompressSync(raw))
    const hash = createHash("sha256")
      .update("session_message")
      .update(Buffer.from([0]))
      .update(raw)
      .digest("hex")
    yield* Database.withSync(database, (sync) =>
      sync.transaction(
        (tx) => {
          tx.insert(ColdStorageTable)
            .values({
              hash,
              kind: "session_message",
              codec: "zstd",
              payload,
              raw_bytes: raw.byteLength,
              compressed_bytes: payload.byteLength,
              ref_count: 1,
              time_created: now,
              time_updated: now,
            })
            .run()
          tx.update(SessionMessageTable)
            .set({ cold_ref: hash, cold_key: null, cold_stats: null })
            .where(eq(SessionMessageTable.id, assistantMessageID))
            .run()
          tx.delete(ColdStorageTable).where(eq(ColdStorageTable.hash, packedRef)).run()
        },
        { behavior: "immediate" },
      ),
    )
    const legacyBefore = yield* stored
    expect(yield* aggregateStats({ projectFilter: projectID })).toEqual(native)
    expect(yield* stored).toEqual(legacyBefore)
    yield* Database.withSync(database, (sync) => {
      expect(
        ColdStorage.freezeOwner(sync, {
          type: "session_message",
          id: assistantMessageID,
          olderThanMs: 0,
          now: Date.now() + 1,
        }).type,
      ).toBe("frozen")
    })
    const upgradedBefore = yield* stored
    expect(yield* aggregateStats({ projectFilter: projectID })).toEqual(native)
    expect(yield* stored).toEqual(upgradedBefore)
    // 同 ID 的迁移副本不双计；另一个旧消息仍进入全历史统计，但不进入最近一天。
    for (const item of [
      { id: SessionV1.MessageID.make(assistantMessageID), tool: "echo", time: now },
      { id: SessionV1.MessageID.make("msg_stats_legacy"), tool: "legacy-tool", time: now - 2 * 86400000 },
    ]) {
      const info: SessionV1.Assistant = {
        id: item.id,
        sessionID,
        role: "assistant",
        parentID: SessionV1.MessageID.make(userID),
        agent: "build",
        mode: "build",
        modelID: model.id,
        providerID: model.providerID,
        path: { cwd: directory, root: directory },
        cost: 0,
        tokens: { ...tokens, input: 0, output: 0, reasoning: 0 },
        time: { created: item.time, completed: item.time },
      }
      yield* events.publish(SessionV1.Event.MessageUpdated, { sessionID, info })
      yield* events.publish(SessionV1.Event.PartUpdated, {
        sessionID,
        time: item.time,
        part: {
          id: SessionV1.PartID.ascending(),
          sessionID,
          messageID: info.id,
          type: "tool",
          callID: item.tool,
          tool: item.tool,
          state: {
            status: "completed",
            input: {},
            output: "done",
            title: item.tool,
            metadata: {},
            time: { start: item.time, end: item.time },
          },
        },
      })
    }
    const mixed = yield* aggregateStats({ projectFilter: projectID })
    expect(mixed.totalMessages).toBe(3)
    expect(mixed.totalTools).toBe(2)
    expect(mixed.toolUsage.map((tool) => ({ id: tool.id, count: tool.count }))).toEqual(
      expect.arrayContaining([
        { id: "echo", count: 1 },
        { id: "legacy-tool", count: 1 },
      ]),
    )
    expect(mixed.total).toMatchObject({ cost: 0.5, tokens: { total: 10 } })
    const recent = yield* aggregateStats({ projectFilter: projectID, days: 1 })
    expect(recent.totalMessages).toBe(2)
    expect(recent.totalTools).toBe(1)
    expect(recent.toolUsage.map((tool) => ({ id: tool.id, count: tool.count }))).toEqual([{ id: "echo", count: 1 }])
    // canonical 会话页继续展示迁移去重后的消息/工具数，不依赖已退役 Overview 文本。
    expect(renderSessions(mixed, { color: "never" })).toContain("3 msg / 2 tools")
    expect(native.models.find((group) => group.id === model.id)).toMatchObject({ cost: 0.5, tokens: { total: 10 } })
  }),
)
