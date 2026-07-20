import { describe, expect } from "bun:test"
import { Context, Deferred, Effect, Exit, Fiber, Layer } from "effect"
import { ColdStorage } from "@/storage/cold"
import { Database } from "@/storage/db"
import { Session as SessionNs } from "@/session/session"
import { MessageV2 } from "@/session/message-v2"
import { MessageID, PartID } from "@/session/schema"
import { ModelID, ProviderID } from "@/provider/schema"
import { ColdStorageTable, MessageTable, PartTable, SessionTable } from "@/session/session.sql"
import { Bus } from "@/bus"
import { Storage } from "@/storage/storage"
import { SyncEvent } from "@/sync"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { BackgroundJob } from "@/background/job"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { testEffect } from "../lib/effect"
import { SessionSummary } from "@/session/summary"
import { Server } from "@/server/server"
import { SessionPaths } from "@/server/routes/instance/httpapi/groups/session"
import { aggregateStats } from "@/cli/cmd/stats/data"
import { TestInstance } from "../fixture/fixture"
import type { SessionID } from "@/session/schema"
import path from "path"

const sessionLayer = SessionNs.layer.pipe(
  Layer.provide(Bus.layer),
  Layer.provide(Storage.defaultLayer),
  Layer.provide(SyncEvent.defaultLayer),
  Layer.provide(RuntimeFlags.layer({ experimentalWorkspaces: false })),
  Layer.provide(BackgroundJob.defaultLayer),
)
const summaryLayer = SessionSummary.layer.pipe(
  Layer.provide(sessionLayer),
  Layer.provide(Storage.defaultLayer),
  Layer.provide(Bus.layer),
)
const it = testEffect(
  Layer.mergeAll(
    sessionLayer,
    summaryLayer,
    Storage.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
  ),
)

class MirrorReadGate extends Context.Service<
  MirrorReadGate,
  { readonly ready: Deferred.Deferred<void>; readonly release: Deferred.Deferred<void> }
>()("@test/MirrorReadGate") {}

const mirrorReadGateLayer = Layer.effect(
  MirrorReadGate,
  Effect.gen(function* () {
    return MirrorReadGate.of({ ready: yield* Deferred.make<void>(), release: yield* Deferred.make<void>() })
  }),
)
const delayedStorageLayer = Layer.effect(
  Storage.Service,
  Effect.gen(function* () {
    const storage = yield* Storage.Service
    const gate = yield* MirrorReadGate
    return Storage.Service.of({
      ...storage,
      read: <T>(key: string[]) => {
        if (key[0] !== "session_diff") return storage.read<T>(key)
        return Deferred.succeed(gate.ready, undefined).pipe(
          Effect.andThen(Deferred.await(gate.release)),
          Effect.andThen(storage.read<T>(key)),
        )
      },
    })
  }),
).pipe(Layer.provide(Storage.defaultLayer), Layer.provide(mirrorReadGateLayer))
const raceSessionLayer = SessionNs.layer.pipe(
  Layer.provide(Bus.layer),
  Layer.provide(delayedStorageLayer),
  Layer.provide(SyncEvent.defaultLayer),
  Layer.provide(RuntimeFlags.layer({ experimentalWorkspaces: false })),
  Layer.provide(BackgroundJob.defaultLayer),
)
const raceIt = testEffect(
  Layer.mergeAll(raceSessionLayer, delayedStorageLayer, mirrorReadGateLayer, CrossSpawnSpawner.defaultLayer),
)

function addCompletedSummaryEdit(
  sessions: SessionNs.Interface,
  input: { sessionID: SessionID; directory: string; file: string; patch: string },
) {
  return Effect.gen(function* () {
    const userID = MessageID.ascending()
    yield* sessions.updateMessage({
      id: userID,
      sessionID: input.sessionID,
      role: "user",
      time: { created: Date.now() },
      agent: "build",
      model: { providerID: ProviderID.make("test-provider"), modelID: ModelID.make("test-model") },
    })
    const assistantID = MessageID.ascending()
    yield* sessions.updateMessage({
      id: assistantID,
      sessionID: input.sessionID,
      role: "assistant",
      parentID: userID,
      mode: "build",
      agent: "build",
      path: { cwd: input.directory, root: input.directory },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: ModelID.make("test-model"),
      providerID: ProviderID.make("test-provider"),
      time: { created: Date.now(), completed: Date.now() },
    })
    const partID = PartID.ascending()
    yield* sessions.updatePart({
      id: partID,
      sessionID: input.sessionID,
      messageID: assistantID,
      type: "tool",
      callID: `edit-${input.file}`,
      tool: "edit",
      state: {
        status: "completed",
        input: {},
        output: "ok",
        title: "edit",
        metadata: {
          filediff: {
            file: path.join(input.directory, input.file),
            patch: input.patch,
            additions: 1,
            deletions: 0,
          },
        },
        time: { start: 0, end: 1 },
      },
    })
    return { userID, assistantID, partID }
  })
}

function coldOwnerCount(sessionIDs: string[]) {
  const allowed = new Set(sessionIDs)
  return Database.use(
    (db) =>
      db
        .select({ sessionID: MessageTable.session_id, coldRef: MessageTable.cold_ref })
        .from(MessageTable)
        .all()
        .filter((row) => allowed.has(row.sessionID) && row.coldRef).length +
      db
        .select({ sessionID: PartTable.session_id, coldRef: PartTable.cold_ref })
        .from(PartTable)
        .all()
        .filter((row) => allowed.has(row.sessionID) && row.coldRef).length,
  )
}

function coldPayloadCount(sessionIDs: string[]) {
  const allowed = new Set(sessionIDs)
  return Database.use((db) => {
    const refs = new Set<string>()
    for (const row of db
      .select({ sessionID: MessageTable.session_id, coldRef: MessageTable.cold_ref })
      .from(MessageTable)
      .all()) {
      if (allowed.has(row.sessionID) && row.coldRef) refs.add(row.coldRef)
    }
    for (const row of db
      .select({ sessionID: PartTable.session_id, coldRef: PartTable.cold_ref })
      .from(PartTable)
      .all()) {
      if (allowed.has(row.sessionID) && row.coldRef) refs.add(row.coldRef)
    }
    return refs.size
  })
}

describe.serial("ColdStorage", () => {
  // 该用例从真实 Session projector 写入 owner，避免直接构造 table row 绕过完整替换合同。
  // 通过修改 Session.time_updated 触发生产 age eligibility，不使用仅供测试的 force 开关。
  // 首次读取必须走 MessageV2.get 公共业务 seam，而不是测试直接调用内部 restore helper。
  // tool output 与原始字符串逐字比较，锁定 zstd/canonical/merge 的联合可逆性。
  // 首次读取后 cold owner 必须归零，证明 thaw 已持久回填而不是只放入进程内缓存。
  // 第二次读取在 blob 已释放后仍成功，证明业务对象不再依赖已删除的 cold payload。
  // 测试不断言 helper 调用次数，只断言用户可观察的完整 output 和数据库 owner 状态。
  // 任何 placeholder 被误发为成功都会在第一条 output 断言中暴露，而不是被空字符串容忍。
  // 该路径同时覆盖 Message hydrate 批量 Part 查询与单 payload 引用释放。
  // 临时 instance 在 scope 结束时清理，测试不会触碰开发者实际 opencode.db。
  it.instance("restores a frozen tool output through the normal Message read path", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionNs.Service
      const session = yield* sessions.create({ title: "cold round trip" })
      const messageID = MessageID.ascending()
      const partID = PartID.ascending()
      const output = "cold-output-".repeat(512)

      yield* sessions.updateMessage({
        id: messageID,
        sessionID: session.id,
        role: "assistant",
        parentID: MessageID.ascending(),
        modelID: ModelID.make("test-model"),
        providerID: ProviderID.make("test-provider"),
        mode: "build",
        agent: "build",
        path: { cwd: session.directory, root: session.directory },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: Date.now() },
      })
      yield* sessions.updatePart({
        id: partID,
        messageID,
        sessionID: session.id,
        type: "tool",
        callID: "call-1",
        tool: "read",
        state: {
          status: "completed",
          input: { filePath: "large.txt" },
          output,
          title: "Read large.txt",
          metadata: {},
          time: { start: 1, end: 2 },
        },
      })
      // 年龄 eligibility 必须在真实 Session 行上成立；测试不通过 force flag
      // 绕过 production 判定，否则无法证明维护命令和直接 owner 冷冻共享同一规则。
      Database.use((db) =>
        db
          .update(SessionTable)
          .set({ time_updated: Date.now() - 31 * 24 * 60 * 60 * 1000 })
          .where(Database.eq(SessionTable.id, session.id))
          .run(),
      )

      const frozen = ColdStorage.freezeOwner({ type: "part", id: partID, now: Date.now() })
      expect(frozen.type).toBe("frozen")
      expect(coldOwnerCount([session.id])).toBe(1)

      // 断言走真实业务读取 seam，而不是直接查询 projection/cold blob。
      // 首次读取应同步 thaw 并持久回填；第二次读取因此不再依赖 cold payload。
      const first = yield* MessageV2.get({ sessionID: session.id, messageID })
      const firstTool = first.parts.find((part) => part.id === partID)
      expect(
        firstTool?.type === "tool" && firstTool.state.status === "completed" ? firstTool.state.output : undefined,
      ).toBe(output)
      expect(coldOwnerCount([session.id])).toBe(0)

      const second = yield* MessageV2.get({ sessionID: session.id, messageID })
      const secondTool = second.parts.find((part) => part.id === partID)
      expect(
        secondTool?.type === "tool" && secondTool.state.status === "completed" ? secondTool.state.output : undefined,
      ).toBe(output)
    }),
  )

  // 两条 user Message 保存语义相同但插入顺序相反的 FileDiff keys，真实 SQLite JSON bytes 因而可以不同。
  // freeze 后 hash 必须相同，证明 identity 来自 recursive canonical value，而不是原始 stringify 顺序。
  // patch 独立超过 4 KiB，测试不会因门槛 skip 而把两个 skipped 结果误判成去重成功。
  // 第二次 retain 必须把同一 payload ref_count 增至 2，不允许仅碰巧返回相同 digest 却覆盖 owner 生命周期。
  // 断言读取生产 cold_ref/payload row，不复制 SHA-256 输入或 key comparator 到 expected value。
  // 两个 owner 位于同一 aged session，eligibility 差异不能成为 hash 结果的替代解释。
  // session 删除经正常 projector 释放两份引用，确保 canonical 去重仍服从最后 owner 删除规则。
  // 此测试锁定持久协议的对象顺序无关性；array 顺序则仍由 FileDiff 列表原样保留。
  it.instance("deduplicates canonical message payloads with different object key insertion order", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionNs.Service
      const session = yield* sessions.create({ title: "canonical payload" })
      const firstID = MessageID.ascending()
      const secondID = MessageID.ascending()
      const patch = "canonical-patch-".repeat(400)
      const firstDiff = {
        file: "src/canonical.ts",
        patch,
        additions: 1,
        deletions: 0,
        status: "modified" as const,
      }
      const secondDiff = {
        status: "modified" as const,
        deletions: 0,
        additions: 1,
        patch,
        file: "src/canonical.ts",
      }
      for (const [id, diff] of [
        [firstID, firstDiff],
        [secondID, secondDiff],
      ] as const) {
        yield* sessions.updateMessage({
          id,
          sessionID: session.id,
          role: "user",
          time: { created: Date.now() },
          agent: "build",
          model: { providerID: ProviderID.make("test-provider"), modelID: ModelID.make("test-model") },
          summary: { diffs: [diff] },
        })
      }
      const firstInfo = (yield* MessageV2.get({ sessionID: session.id, messageID: firstID })).info
      if (firstInfo.role !== "user") throw new Error("Expected canonical user message")
      Database.use((db) =>
        db
          .update(SessionTable)
          .set({ time_updated: Date.now() - 31 * 24 * 60 * 60 * 1000 })
          .where(Database.eq(SessionTable.id, session.id))
          .run(),
      )
      const first = ColdStorage.freezeOwner({ type: "message", id: firstID })
      const second = ColdStorage.freezeOwner({ type: "message", id: secondID })
      if (first.type !== "frozen" || second.type !== "frozen") throw new Error("Expected canonical messages to freeze")
      expect(second.hash).toBe(first.hash)
      const payload = Database.use((db) =>
        db.select().from(ColdStorageTable).where(Database.eq(ColdStorageTable.hash, first.hash)).get(),
      )
      expect(payload?.ref_count).toBe(2)
      expect(coldOwnerCount([session.id])).toBe(2)
      expect(coldPayloadCount([session.id])).toBe(1)

      // freeze 前持有的完整 business Message 只改 agent 时，diffs 必须随 full replacement 写回并释放自身 ref。
      yield* sessions.updateMessage({ ...firstInfo, agent: "renamed" })
      expect(coldOwnerCount([session.id])).toBe(1)
      const preserved = yield* MessageV2.get({ sessionID: session.id, messageID: firstID })
      expect(preserved.info.role === "user" ? preserved.info.summary?.diffs : undefined).toEqual([firstDiff])

      expect(ColdStorage.freezeOwner({ type: "message", id: firstID }).type).toBe("frozen")
      // 显式空数组是业务替换而非 projection mask；只清 first ref，second 仍应持有共享 payload。
      yield* sessions.updateMessage({ ...firstInfo, summary: { diffs: [] } })
      expect(coldOwnerCount([session.id])).toBe(1)
      const cleared = yield* MessageV2.get({ sessionID: session.id, messageID: firstID })
      expect(cleared.info.role === "user" ? cleared.info.summary?.diffs : undefined).toEqual([])
      expect(coldPayloadCount([session.id])).toBe(1)
      yield* sessions.remove(session.id)
    }),
  )

  // 该矩阵把 Message diff、reasoning、file data URI、tool output 和 attachment URL 放进同一真实会话。
  // 每个 owner 独立超过 4 KiB，避免某字段因另一 owner 的体积而误通过门槛。
  // hot 结构中的 filename、mime、tool input、title 和 attachment 顺序在 freeze 期间保持可用。
  // user summary 通过 MessageV2.get 恢复，证明 Message payload 不与 Part payload 混用。
  // assistant Parts 一次 hydrate 覆盖多个 hash，验证批量 thaw 不会漏掉同 message 的兄弟 owner。
  // attachment 断言使用原 index，锁定 restore 不得重排或重建为不同语义位置。
  // 完成后 session 范围 cold owner 为零，证明所有白名单字段都已持久展开。
  // 非 data URI URL 不在本用例伪造成冷字段，白名单范围由生产 extraction 决定。
  // 比较原始对象值而非压缩 bytes，避免测试复制 canonical 或 zstd 实现算法。
  // 删除 session 验证展开后的热 row 可走普通 cascade，不依赖残留 blob 清理。
  it.instance("round-trips every cold-field family without changing hot structure", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionNs.Service
      const session = yield* sessions.create({ title: "cold field families" })
      const userID = MessageID.ascending()
      const messageID = MessageID.ascending()
      const reasoningID = PartID.ascending()
      const fileID = PartID.ascending()
      const toolID = PartID.ascending()
      const diffs = Array.from({ length: 40 }, (_, index) => ({
        file: `src/file-${index}.ts`,
        patch: `@@ ${"+change ".repeat(100)} ${index}`,
        additions: index + 1,
        deletions: index,
        status: "modified" as const,
      }))
      const reasoning = "reasoning-text-".repeat(512)
      const fileURL = `data:image/png;base64,${"a".repeat(8_000)}`
      const attachmentURL = `data:text/plain;base64,${"b".repeat(8_000)}`
      yield* sessions.updateMessage({
        id: userID,
        sessionID: session.id,
        role: "user",
        time: { created: Date.now() },
        agent: "build",
        model: { providerID: ProviderID.make("test-provider"), modelID: ModelID.make("test-model") },
        summary: { title: "changes", diffs },
        tools: {},
      })
      yield* sessions.updateMessage({
        id: messageID,
        sessionID: session.id,
        role: "assistant",
        parentID: userID,
        modelID: ModelID.make("test-model"),
        providerID: ProviderID.make("test-provider"),
        mode: "build",
        agent: "build",
        path: { cwd: session.directory, root: session.directory },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: Date.now() },
      })
      yield* sessions.updatePart({
        id: reasoningID,
        sessionID: session.id,
        messageID,
        type: "reasoning",
        text: reasoning,
        time: { start: 1, end: 2 },
      })
      yield* sessions.updatePart({
        id: fileID,
        sessionID: session.id,
        messageID,
        type: "file",
        mime: "image/png",
        filename: "image.png",
        url: fileURL,
      })
      yield* sessions.updatePart({
        id: toolID,
        sessionID: session.id,
        messageID,
        type: "tool",
        callID: "field-families",
        tool: "read",
        state: {
          status: "completed",
          input: { path: "image.png" },
          output: "tool-output-".repeat(512),
          title: "read",
          metadata: { source: "test" },
          time: { start: 1, end: 2 },
          attachments: [
            {
              id: PartID.ascending(),
              sessionID: session.id,
              messageID,
              type: "file",
              mime: "text/plain",
              url: attachmentURL,
            },
          ],
        },
      })
      Database.use((db) =>
        db
          .update(SessionTable)
          .set({ time_updated: Date.now() - 31 * 24 * 60 * 60 * 1000 })
          .where(Database.eq(SessionTable.id, session.id))
          .run(),
      )
      expect(ColdStorage.freezeOwner({ type: "message", id: userID }).type).toBe("frozen")
      expect(ColdStorage.freezeOwner({ type: "part", id: reasoningID }).type).toBe("frozen")
      expect(ColdStorage.freezeOwner({ type: "part", id: fileID }).type).toBe("frozen")
      expect(ColdStorage.freezeOwner({ type: "part", id: toolID }).type).toBe("frozen")
      expect(coldOwnerCount([session.id])).toBe(4)

      const restoredUser = yield* MessageV2.get({ sessionID: session.id, messageID: userID })
      expect(restoredUser.info.role === "user" ? restoredUser.info.summary?.diffs : undefined).toEqual(diffs)
      const restored = yield* MessageV2.get({ sessionID: session.id, messageID })
      const restoredReasoning = restored.parts.find((part) => part.id === reasoningID)
      const restoredFile = restored.parts.find((part) => part.id === fileID)
      const restoredTool = restored.parts.find((part) => part.id === toolID)
      expect(restoredReasoning?.type === "reasoning" ? restoredReasoning.text : undefined).toBe(reasoning)
      expect(restoredFile?.type === "file" ? restoredFile.url : undefined).toBe(fileURL)
      expect(
        restoredTool?.type === "tool" && restoredTool.state.status === "completed"
          ? restoredTool.state.attachments?.[0]?.url
          : undefined,
      ).toBe(attachmentURL)
      expect(coldOwnerCount([session.id])).toBe(0)
      yield* sessions.remove(session.id)
    }),
  )

  // durable update 测试先冻结真实 owner，再以调用方持有的完整 Part 修改非冷 title。
  // output 必须随完整对象写回；若 projector 把空 projection 当未触及字段，测试会立即丢失原值。
  // title 修改后 payload 应释放，证明 replacePart 不保留与热 owner 无关的孤儿引用。
  // 第二阶段重新冻结同一内容，覆盖 payload 重新创建和 refcount 从零开始的路径。
  // 明确把 output 设置为空代表真实业务更新，不允许 storage 层猜测为 cold placeholder。
  // 最终读取空字符串锁定“完整替换”而不是 patch mask 语义。
  // 测试同时保护 late durable event 不得绕开 ColdStorage.replacePart owner。
  // cold owner 数使用 session scope，避免并发测试的其他会话影响断言。
  // 这里不 mock projector 或数据库事务，rollback/外键行为由真实实现承担。
  // 两种更新共享同一原始 Part，其差异只在用户明确改变的字段，便于定位回归。
  it.instance("treats durable Part updates as complete replacements", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionNs.Service
      const session = yield* sessions.create({ title: "cold update" })
      const messageID = MessageID.ascending()
      const partID = PartID.ascending()
      const output = "preserve-this-output-".repeat(512)
      const originalPart = {
        id: partID,
        messageID,
        sessionID: session.id,
        type: "tool" as const,
        callID: "call-update",
        tool: "read",
        state: {
          status: "completed" as const,
          input: { filePath: "large.txt" },
          output,
          title: "Read large.txt",
          metadata: {},
          time: { start: 1, end: 2 },
        },
      } satisfies MessageV2.ToolPart
      const message = yield* sessions.updateMessage({
        id: messageID,
        sessionID: session.id,
        role: "assistant",
        parentID: MessageID.ascending(),
        modelID: ModelID.make("test-model"),
        providerID: ProviderID.make("test-provider"),
        mode: "build",
        agent: "build",
        path: { cwd: session.directory, root: session.directory },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: Date.now() },
      })
      void message
      yield* sessions.updatePart(originalPart)
      Database.use((db) =>
        db
          .update(SessionTable)
          .set({ time_updated: Date.now() - 31 * 24 * 60 * 60 * 1000 })
          .where(Database.eq(SessionTable.id, session.id))
          .run(),
      )

      expect(ColdStorage.freezeOwner({ type: "part", id: partID, now: Date.now() }).type).toBe("frozen")

      // 调用方持有的是完整 business Part，而不是 cold projection；只改标题时原 output
      // 必须随完整替换一起写回，不能根据空 projection 猜测并丢弃旧 blob。
      yield* sessions.updatePart({
        ...originalPart,
        state: { ...originalPart.state, title: "Renamed title" },
      })
      expect(coldOwnerCount([session.id])).toBe(0)
      const preserved = yield* sessions.getPart({ sessionID: session.id, messageID, partID })
      expect(
        preserved?.type === "tool" && preserved.state.status === "completed" ? preserved.state.output : undefined,
      ).toBe(output)

      expect(ColdStorage.freezeOwner({ type: "part", id: partID, now: Date.now() }).type).toBe("frozen")
      // 真实清空是完整替换语义，不是“占位值未触及”；旧 cold payload 必须被释放。
      yield* sessions.updatePart({
        ...originalPart,
        state: { ...originalPart.state, output: "" },
      })
      expect(coldOwnerCount([session.id])).toBe(0)
      const cleared = yield* sessions.getPart({ sessionID: session.id, messageID, partID })
      expect(cleared?.type === "tool" && cleared.state.status === "completed" ? cleared.state.output : undefined).toBe(
        "",
      )
    }),
  )

  // corruption 用例先通过正常 freeze 生成合法 hash/ref，再依次破坏 codec、raw size 与同长度 payload frame。
  // owner projection 和 cold_ref 保持原样，模拟外部 SQL、磁盘损坏或非原子工具写入后的真实状态。
  // 读取必须返回 Effect failure，禁止把 reasoning 的空 projection 当作完整业务文本。
  // 失败后 owner 仍为 cold，证明 thaw transaction 没有提前清 ref 或提交半恢复 data。
  // 测试不依赖具体 zstd 错误文案，跨 Bun/Node 平台只锁定 hard-fail 合同。
  // payload hash 不被测试重新计算，避免复制 production digest 算法形成同源错误。
  // Session.getPart 作为单 Part direct read seam，覆盖 page 以外最容易遗漏的 consumer。
  // 删除 session 仍可释放损坏 payload，因为正常 delete 只依赖 ref row，不需要成功解压。
  // 该用例证明“完整性优先于可用性”，模型路径不会在 corruption 时继续运行。
  // cold owner scope 断言同时验证异常后的数据库事务原子性。
  it.instance("fails closed on a corrupted payload instead of returning a placeholder", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionNs.Service
      const session = yield* sessions.create({ title: "cold corruption" })
      const messageID = MessageID.ascending()
      const partID = PartID.ascending()
      yield* sessions.updateMessage({
        id: messageID,
        sessionID: session.id,
        role: "assistant",
        parentID: MessageID.ascending(),
        modelID: ModelID.make("test-model"),
        providerID: ProviderID.make("test-provider"),
        mode: "build",
        agent: "build",
        path: { cwd: session.directory, root: session.directory },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: Date.now() },
      })
      yield* sessions.updatePart({
        id: partID,
        sessionID: session.id,
        messageID,
        type: "reasoning",
        text: "corrupt-me-".repeat(512),
        time: { start: 1, end: 2 },
      })
      Database.use((db) =>
        db
          .update(SessionTable)
          .set({ time_updated: Date.now() - 31 * 24 * 60 * 60 * 1000 })
          .where(Database.eq(SessionTable.id, session.id))
          .run(),
      )
      expect(ColdStorage.freezeOwner({ type: "part", id: partID }).type).toBe("frozen")
      const hash = Database.use(
        (db) =>
          db.select({ hash: PartTable.cold_ref }).from(PartTable).where(Database.eq(PartTable.id, partID)).get()?.hash,
      )
      if (!hash) throw new Error("Expected a cold hash")
      const original = Database.use((db) =>
        db.select().from(ColdStorageTable).where(Database.eq(ColdStorageTable.hash, hash)).get(),
      )
      if (!original) throw new Error("Expected a cold payload")

      // 未知 codec 必须在尝试猜算法前失败；恢复 metadata 后再分别覆盖 raw size 与同长度 frame 损坏。
      Database.use((db) =>
        db
          .update(ColdStorageTable)
          .set({ codec: Database.sql`'gzip'` })
          .where(Database.eq(ColdStorageTable.hash, hash))
          .run(),
      )
      expect(Exit.isFailure(yield* Effect.exit(sessions.getPart({ sessionID: session.id, messageID, partID })))).toBe(
        true,
      )
      Database.use((db) =>
        db
          .update(ColdStorageTable)
          .set({ codec: original.codec, raw_bytes: original.raw_bytes + 1 })
          .where(Database.eq(ColdStorageTable.hash, hash))
          .run(),
      )
      expect(Exit.isFailure(yield* Effect.exit(sessions.getPart({ sessionID: session.id, messageID, partID })))).toBe(
        true,
      )
      Database.use((db) =>
        db
          .update(ColdStorageTable)
          .set({ raw_bytes: original.raw_bytes, payload: Buffer.alloc(original.payload.byteLength) })
          .where(Database.eq(ColdStorageTable.hash, hash))
          .run(),
      )
      const result = yield* Effect.exit(sessions.getPart({ sessionID: session.id, messageID, partID }))
      expect(Exit.isFailure(result)).toBe(true)
      expect(coldOwnerCount([session.id])).toBe(1)
      // ref_count 漂移模拟可由外部 SQL/crash 遗留的 persisted corruption；delete path 不应把它吞成成功。
      Database.use((db) =>
        db.update(ColdStorageTable).set({ ref_count: 99 }).where(Database.eq(ColdStorageTable.hash, hash)).run(),
      )
      // public remove 必须透传 cold corruption；只记录日志并返回成功会让调用方误以为 session 已删除。
      // 删除失败后 session 仍应可见，证明 projector transaction 在 releaseSession 失败时完整 rollback。
      const removal = yield* Effect.exit(sessions.remove(session.id))
      expect(Exit.isFailure(removal)).toBe(true)
      expect((yield* sessions.get(session.id)).id).toBe(session.id)
      // 恢复测试故意破坏的 payload/ref 后再删除 session，避免 corruption fixture 污染同一测试数据库的后续 verify baseline。
      Database.use((db) =>
        db
          .update(ColdStorageTable)
          .set({
            codec: original.codec,
            payload: original.payload,
            raw_bytes: original.raw_bytes,
            compressed_bytes: original.compressed_bytes,
            ref_count: 1,
          })
          .where(Database.eq(ColdStorageTable.hash, hash))
          .run(),
      )
      yield* sessions.remove(session.id)
    }),
  )

  // usage 用例把大型 tool output 与热 step-finish 放在同一 assistant message，制造最易过度 thaw 的组合。
  // 只调用 MessageV2.stepFinishParts，模拟 RequestUsage.recordAssistant 的真实统计读取意图。
  // 返回必须仅含 step-finish，token/cost 结构从主表热 JSON 直接解码。
  // 调用后 tool owner 仍为 cold，证明统计路径没有经过 MessageV2.parts 完整 hydrate。
  // step-finish 本身永不进入冷字段白名单，因此统计无需 codec 或 blob 可用性。
  // 测试不 mock SQL query 次数，只用持久 owner 状态证明没有发生 thaw 副作用。
  // tool output 大于门槛，若 freeze 未实际发生，cold owner 前置断言会阻止假阳性。
  // cost 值单独断言，确保 hot-only 优化没有降低 usage 信息量。
  // 该边界允许后台统计高频运行而不反复解压旧会话上下文。
  // session scope 清理保证测试结束不留下共享 payload 干扰后续 verify。
  it.instance("reads request-usage step finishes without thawing cold tool payloads", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionNs.Service
      const session = yield* sessions.create({ title: "cold usage" })
      const messageID = MessageID.ascending()
      const toolPartID = PartID.ascending()
      const finishPartID = PartID.ascending()
      yield* sessions.updateMessage({
        id: messageID,
        sessionID: session.id,
        role: "assistant",
        parentID: MessageID.ascending(),
        modelID: ModelID.make("test-model"),
        providerID: ProviderID.make("test-provider"),
        mode: "build",
        agent: "build",
        path: { cwd: session.directory, root: session.directory },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: Date.now() },
      })
      yield* sessions.updatePart({
        id: toolPartID,
        sessionID: session.id,
        messageID,
        type: "tool",
        callID: "usage-call",
        tool: "read",
        state: {
          status: "completed",
          input: {},
          output: "usage-tool-output-".repeat(512),
          title: "read",
          metadata: {},
          time: { start: 1, end: 2 },
        },
      })
      yield* sessions.updatePart({
        id: finishPartID,
        sessionID: session.id,
        messageID,
        type: "step-finish",
        reason: "stop",
        cost: 1,
        tokens: { input: 2, output: 3, reasoning: 4, cache: { read: 5, write: 6 } },
      })
      Database.use((db) =>
        db
          .update(SessionTable)
          .set({ time_updated: Date.now() - 31 * 24 * 60 * 60 * 1000 })
          .where(Database.eq(SessionTable.id, session.id))
          .run(),
      )
      expect(ColdStorage.freezeOwner({ type: "part", id: toolPartID, now: Date.now() }).type).toBe("frozen")

      const finishes = MessageV2.stepFinishParts(messageID)
      expect(finishes).toHaveLength(1)
      expect(finishes[0]?.type).toBe("step-finish")
      expect(finishes[0]?.cost).toBe(1)
      expect(coldOwnerCount([session.id])).toBe(1)
    }),
  )

  // search 用例使用互不重叠的 Text/input/output needle，明确区分允许索引与禁止索引的数据面。
  // visible Text 是用户定位 Session 的稳定内容；Tool identity/input/output/metadata 全部属于归档面。
  // output 被实际冻结且超过门槛，排除“搜索没命中只是测试没有冷数据”的假阳性。
  // 两次 list 后 owner 仍为 cold，证明 searchCondition 只执行 SQL 热投影，不调用 decoder。
  // 测试走 Session.list 公共接口，覆盖 TUI quick switch 实际使用的搜索路径。
  // 不断言标题搜索等既有行为，避免把本测试扩展成与冷存储无关的宽泛回归。
  // metadata 故意含 output needle，锁定 provider/internal metadata 同样不可进入结果。
  // visible Text 正向断言防止删除 Tool 分支时误伤仍受支持的 Session 定位内容。
  // 删除会话验证 search 只读操作没有制造额外 owner 或 payload。
  it.instance("excludes Tool fields while preserving visible Text search without thaw", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionNs.Service
      const session = yield* sessions.create({ title: "cold search" })
      const messageID = MessageID.ascending()
      const partID = PartID.ascending()
      const inputNeedle = "visible-search-input-unique"
      const outputNeedle = "hidden-search-output-unique"
      const textNeedle = "visible-session-text-unique"
      yield* sessions.updateMessage({
        id: messageID,
        sessionID: session.id,
        role: "assistant",
        parentID: MessageID.ascending(),
        modelID: ModelID.make("test-model"),
        providerID: ProviderID.make("test-provider"),
        mode: "build",
        agent: "build",
        path: { cwd: session.directory, root: session.directory },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: Date.now() },
      })
      yield* sessions.updatePart({
        id: partID,
        sessionID: session.id,
        messageID,
        type: "tool",
        callID: "search-call",
        tool: "read",
        state: {
          status: "completed",
          input: { query: inputNeedle },
          output: `${outputNeedle}-${"x".repeat(8_000)}`,
          title: "read",
          metadata: { providerSecret: outputNeedle },
          time: { start: 1, end: 2 },
        },
      })
      yield* sessions.updatePart({
        id: PartID.ascending(),
        sessionID: session.id,
        messageID,
        type: "text",
        text: textNeedle,
        time: { start: 1, end: 2 },
      })
      Database.use((db) =>
        db
          .update(SessionTable)
          .set({ time_updated: Date.now() - 31 * 24 * 60 * 60 * 1000 })
          .where(Database.eq(SessionTable.id, session.id))
          .run(),
      )
      expect(ColdStorage.freezeOwner({ type: "part", id: partID }).type).toBe("frozen")

      expect((yield* sessions.list({ search: inputNeedle })).some((item) => item.id === session.id)).toBe(false)
      expect((yield* sessions.list({ search: outputNeedle })).some((item) => item.id === session.id)).toBe(false)
      expect((yield* sessions.list({ search: textNeedle })).some((item) => item.id === session.id)).toBe(true)
      expect(coldOwnerCount([session.id])).toBe(1)
      yield* sessions.remove(session.id)
    }),
  )

  // fork 用例在 source 冷态时调用公开 Session.fork，确保路径不能先 hydrate 再复制完整热内容。
  // child Message/Part ID 必须独立，避免父子更新或删除命中同一 primary key。
  // child 与 source cold_ref 完全相同，证明 payload 按内容地址共享而非重新压缩副本。
  // 两个 owner、一个 payload 的断言锁定 grouped refcount 与去重收益。
  // 先读取 child 只应 thaw child，source owner 继续持有共享 hash 和完整恢复能力。
  // 再读取 source 才删除最后引用，证明父子 thaw 生命周期相互独立。
  // child assistant 通过 role 定位，不假设 fork 后生成 ID 的具体字面值。
  // output 在父子两次读取中逐字相等，验证 raw projection clone 没有改变 payload fields。
  // 公开 fork transaction 若失败应由 Session 清理 target；成功路径最终显式删除两个会话。
  // 测试不检查内部 Event 次数，只锁定数据库 row/ref 和业务读取结果。
  it.instance("forks cold owners with shared payloads and independent thaw", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionNs.Service
      const source = yield* sessions.create({ title: "cold fork source" })
      const parentID = MessageID.ascending()
      const messageID = MessageID.ascending()
      const partID = PartID.ascending()
      const finishID = PartID.ascending()
      const output = "fork-shared-output-".repeat(512)
      yield* sessions.updateMessage({
        id: parentID,
        sessionID: source.id,
        role: "user",
        time: { created: Date.now() },
        agent: "build",
        model: { providerID: ProviderID.make("test-provider"), modelID: ModelID.make("test-model") },
        tools: {},
      })
      yield* sessions.updateMessage({
        id: messageID,
        sessionID: source.id,
        role: "assistant",
        parentID,
        modelID: ModelID.make("test-model"),
        providerID: ProviderID.make("test-provider"),
        mode: "build",
        agent: "build",
        path: { cwd: source.directory, root: source.directory },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: Date.now() },
      })
      yield* sessions.updatePart({
        id: partID,
        sessionID: source.id,
        messageID,
        type: "tool",
        callID: "fork-shared-call",
        tool: "read",
        state: {
          status: "completed",
          input: {},
          output,
          title: "read",
          metadata: {},
          time: { start: 1, end: 2 },
        },
      })
      yield* sessions.updatePart({
        id: finishID,
        sessionID: source.id,
        messageID,
        type: "step-finish",
        reason: "stop",
        cost: 2.5,
        tokens: { input: 3, output: 5, reasoning: 7, cache: { read: 11, write: 13 } },
      })
      Database.use((db) =>
        db
          .update(SessionTable)
          .set({ time_updated: Date.now() - 31 * 24 * 60 * 60 * 1000 })
          .where(Database.eq(SessionTable.id, source.id))
          .run(),
      )
      expect(ColdStorage.freezeOwner({ type: "part", id: partID, now: Date.now() }).type).toBe("frozen")

      const child = yield* sessions.fork({ sessionID: source.id })
      const childPart = Database.use((db) =>
        db
          .select({ id: PartTable.id, cold_ref: PartTable.cold_ref })
          .from(PartTable)
          .where(Database.eq(PartTable.session_id, child.id))
          .all()
          .find((row) => row.cold_ref !== null),
      )
      const sourcePart = Database.use((db) =>
        db
          .select({ id: PartTable.id, cold_ref: PartTable.cold_ref })
          .from(PartTable)
          .where(Database.eq(PartTable.id, partID))
          .get(),
      )
      expect(childPart?.id).not.toBe(partID)
      expect(childPart?.cold_ref).toBe(sourcePart?.cold_ref)
      expect(coldOwnerCount([source.id, child.id])).toBe(2)
      expect(coldPayloadCount([source.id, child.id])).toBe(1)
      // raw clone 不再发布 PartUpdated events，但 child 的 Session usage 必须与旧 fork 行为和 source totals 一致。
      // step-finish 本身保持热态；该断言同时证明 usage 聚合没有依赖 cold payload thaw。
      const childUsage = yield* sessions.get(child.id)
      expect(childUsage.cost).toBe(2.5)
      expect(childUsage.tokens).toEqual({ input: 3, output: 5, reasoning: 7, cache: { read: 11, write: 13 } })

      const childMessage = Database.use((db) =>
        db
          .select({ id: MessageTable.id, data: MessageTable.data })
          .from(MessageTable)
          .where(Database.eq(MessageTable.session_id, child.id))
          .all()
          .find((row) => row.data.role === "assistant"),
      )
      if (!childMessage) throw new Error("Fork did not clone the message")
      const thawedChild = yield* MessageV2.get({ sessionID: child.id, messageID: childMessage.id })
      const childTool = thawedChild.parts.find((part) => part.id === childPart?.id)
      expect(
        childTool?.type === "tool" && childTool.state.status === "completed" ? childTool.state.output : undefined,
      ).toBe(output)
      expect(coldOwnerCount([source.id, child.id])).toBe(1)

      const thawedSource = yield* MessageV2.get({ sessionID: source.id, messageID })
      const sourceTool = thawedSource.parts.find((part) => part.id === partID)
      expect(
        sourceTool?.type === "tool" && sourceTool.state.status === "completed" ? sourceTool.state.output : undefined,
      ).toBe(output)
      expect(coldOwnerCount([source.id, child.id])).toBe(0)
      yield* sessions.remove(child.id)
      yield* sessions.remove(source.id)
    }),
  )

  // 删除矩阵复用真实 fork 共享引用，依次覆盖 Part、Message 和 Session 三个 projector owner。
  // 删除 child Part 后 source payload 必须保留，防止单 owner release 错删共享 blob。
  // 删除 source Message 后最后引用归零，payload 应在同一事务消失而不是等待 verify 修补。
  // 第二组直接删除整个 child Session，覆盖 SQLite cascade 前的 releaseSession 聚合路径。
  // source Session 在 child 删除后仍可持有 payload，证明 cascade 不越过会话边界。
  // 最后删除 source 后 owner/payload 同时归零，锁定 refcount 正常路径的最终一致性。
  // 每个阶段都按相关 session scope 计数，避免其他测试 owner 影响行为结论。
  // createFrozen 使用生产 age eligibility 和 projector，未直接插入 cold_storage 伪造状态。
  // usage/cost 字段不在本矩阵重复断言，删除 projector 的该逻辑由既有 session 测试负责。
  // 整个测试不调用 verify --repair，证明正常删除不依赖维护补偿。
  it.instance("releases shared cold references through part, message, and session deletes", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionNs.Service
      const createFrozen = Effect.fn("Test.createFrozenDeleteSource")(function* (title: string) {
        const session = yield* sessions.create({ title })
        const userID = MessageID.ascending()
        const messageID = MessageID.ascending()
        const partID = PartID.ascending()
        yield* sessions.updateMessage({
          id: userID,
          sessionID: session.id,
          role: "user",
          time: { created: Date.now() },
          agent: "build",
          model: { providerID: ProviderID.make("test-provider"), modelID: ModelID.make("test-model") },
          tools: {},
        })
        yield* sessions.updateMessage({
          id: messageID,
          sessionID: session.id,
          role: "assistant",
          parentID: userID,
          modelID: ModelID.make("test-model"),
          providerID: ProviderID.make("test-provider"),
          mode: "build",
          agent: "build",
          path: { cwd: session.directory, root: session.directory },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: Date.now() },
        })
        yield* sessions.updatePart({
          id: partID,
          sessionID: session.id,
          messageID,
          type: "tool",
          callID: title,
          tool: "read",
          state: {
            status: "completed",
            input: {},
            output: `${title}-output-`.repeat(512),
            title: "read",
            metadata: {},
            time: { start: 1, end: 2 },
          },
        })
        Database.use((db) =>
          db
            .update(SessionTable)
            .set({ time_updated: Date.now() - 31 * 24 * 60 * 60 * 1000 })
            .where(Database.eq(SessionTable.id, session.id))
            .run(),
        )
        expect(ColdStorage.freezeOwner({ type: "part", id: partID, now: Date.now() }).type).toBe("frozen")
        return { session, messageID, partID }
      })

      const first = yield* createFrozen("delete-owner")
      const firstFork = yield* sessions.fork({ sessionID: first.session.id })
      const forkPart = Database.use((db) =>
        db.select().from(PartTable).where(Database.eq(PartTable.session_id, firstFork.id)).get(),
      )
      if (!forkPart) throw new Error("Fork did not clone a Part")
      expect(coldOwnerCount([first.session.id, firstFork.id])).toBe(2)
      yield* sessions.removePart({
        sessionID: firstFork.id,
        messageID: forkPart.message_id,
        partID: forkPart.id,
      })
      expect(coldOwnerCount([first.session.id, firstFork.id])).toBe(1)
      expect(coldPayloadCount([first.session.id, firstFork.id])).toBe(1)
      yield* sessions.removeMessage({ sessionID: first.session.id, messageID: first.messageID })
      expect(coldOwnerCount([first.session.id, firstFork.id])).toBe(0)
      expect(coldPayloadCount([first.session.id, firstFork.id])).toBe(0)
      yield* sessions.remove(firstFork.id)
      yield* sessions.remove(first.session.id)

      const second = yield* createFrozen("delete-session")
      const secondFork = yield* sessions.fork({ sessionID: second.session.id })
      expect(coldOwnerCount([second.session.id, secondFork.id])).toBe(2)
      yield* sessions.remove(secondFork.id)
      expect(coldOwnerCount([second.session.id, secondFork.id])).toBe(1)
      expect(coldPayloadCount([second.session.id, secondFork.id])).toBe(1)
      yield* sessions.remove(second.session.id)
      expect(coldOwnerCount([second.session.id, secondFork.id])).toBe(0)
      expect(coldPayloadCount([second.session.id, secondFork.id])).toBe(0)
    }),
  )

  // verify 用例先确认正常 freeze 的 refcount 无 mismatch，再只篡改目标 hash 的计数。
  // baseline mismatch 允许同进程其他隔离数据存在，但目标破坏必须使总数精确增加一。
  // repair 只恢复真实 owner count，不能改变 payload bytes 或 owner projection。
  // repair 后 mismatch 回到 baseline，证明修复没有把无关 payload 一并伪造为成功。
  // scoped expand 恢复 reasoning 原文并清除 owner，锁定同步维护 helper 的可逆性。
  // prepareMaintenance(status) 必须 immediate，compress 必须 task-backed，防止 CLI/daemon 分叉。
  // reasoning 文本逐字比较，不用仅检查长度替代零损失断言。
  // task 分类断言不依赖随机 taskID，保持测试跨运行稳定。
  // 测试故意不调用 cleanup，verify repair 与 orphan 删除的责任在下一用例独立证明。
  // session 删除发生在 owner 已热态后，验证 expand 不留下外键或 refcount 残余。
  it.instance("verifies, repairs, expands, and classifies maintenance requests", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionNs.Service
      const session = yield* sessions.create({ title: "cold maintenance" })
      const messageID = MessageID.ascending()
      const partID = PartID.ascending()
      yield* sessions.updateMessage({
        id: messageID,
        sessionID: session.id,
        role: "assistant",
        parentID: MessageID.ascending(),
        modelID: ModelID.make("test-model"),
        providerID: ProviderID.make("test-provider"),
        mode: "build",
        agent: "build",
        path: { cwd: session.directory, root: session.directory },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: Date.now() },
      })
      yield* sessions.updatePart({
        id: partID,
        sessionID: session.id,
        messageID,
        type: "reasoning",
        text: "maintenance-reasoning-".repeat(512),
        time: { start: 1, end: 2 },
      })
      Database.use((db) =>
        db
          .update(SessionTable)
          .set({ time_updated: Date.now() - 31 * 24 * 60 * 60 * 1000 })
          .where(Database.eq(SessionTable.id, session.id))
          .run(),
      )
      expect(ColdStorage.freezeOwner({ type: "part", id: partID, now: Date.now() }).type).toBe("frozen")
      const beforeVerify = ColdStorage.verify({ repair: false }).refCountMismatches
      const owner = Database.use(
        (db) =>
          db
            .select({ hash: PartTable.cold_ref, key: PartTable.cold_key })
            .from(PartTable)
            .where(Database.eq(PartTable.id, partID))
            .get(),
      )
      if (!owner?.hash || !owner.key) throw new Error("Expected a packed cold owner for verify test")
      const hash = owner.hash
      Database.use((db) =>
        db.update(ColdStorageTable).set({ ref_count: 99 }).where(Database.eq(ColdStorageTable.hash, hash)).run(),
      )
      expect(ColdStorage.verify({ repair: false }).refCountMismatches).toBe(beforeVerify + 1)
      expect(ColdStorage.verify({ repair: true }).repaired).toBeGreaterThanOrEqual(1)
      expect(ColdStorage.verify({ repair: false }).refCountMismatches).toBe(beforeVerify)

      // 合法 frame 搭配不存在的随机 entry key，专门区分完整 owner verify 与旧 payload-only task。
      Database.use((db) =>
        db.update(PartTable).set({ cold_key: Buffer.alloc(32, 0xa5) }).where(Database.eq(PartTable.id, partID)).run(),
      )
      const verifyTask = ColdStorage.prepareMaintenance({ operation: "verify", repair: true, batchSize: 50 })
      if (verifyTask.type !== "task") throw new Error("Expected task-backed repair")
      const verified = yield* Effect.promise(() =>
        ColdStorage.maintain(verifyTask, { lease: { assertOwned() {} }, checkpoint: async () => {} }),
      )
      if (verified.type !== "task") throw new Error("Expected task result for repair")
      // repair 不可修 key；task 必须报告 corruption，不能因 payload hash 正常而 completed/failed=0。
      expect(verified.task.failed).toBeGreaterThan(0)
      Database.use((db) =>
        db.update(PartTable).set({ cold_key: owner.key }).where(Database.eq(PartTable.id, partID)).run(),
      )

      const baselineOwners = ColdStorage.verify({ repair: false }).corruptOwners
      // dirty 没有 claimed cursor 是非法 Session 状态；repair 只能报告，不能猜测清 bit 或制造 cursor。
      Database.use((db) =>
        db
          .update(SessionTable)
          .set({ summary_init_dirty: true })
          .where(Database.eq(SessionTable.id, session.id))
          .run(),
      )
      const summaryTask = ColdStorage.prepareMaintenance({ operation: "verify", repair: true, batchSize: 50 })
      if (summaryTask.type !== "task") throw new Error("Expected task-backed summary repair")
      const summaryVerified = yield* Effect.promise(() =>
        ColdStorage.maintain(summaryTask, { lease: { assertOwned() {} }, checkpoint: async () => {} }),
      )
      if (summaryVerified.type !== "task") throw new Error("Expected task result for summary repair")
      expect(summaryVerified.task.failed).toBeGreaterThan(0)
      expect(ColdStorage.verify({ repair: false }).corruptOwners).toBe(baselineOwners + 1)
      expect(
        Database.use((db) =>
          db
            .select({ dirty: SessionTable.summary_init_dirty })
            .from(SessionTable)
            .where(Database.eq(SessionTable.id, session.id))
            .get()?.dirty,
        ),
      ).toBe(true)
      Database.use((db) =>
        db
          .update(SessionTable)
          .set({ summary_init_dirty: false })
          .where(Database.eq(SessionTable.id, session.id))
          .run(),
      )

      const expanded = ColdStorage.expand({ sessionID: session.id, all: false })
      expect(expanded.expanded).toBe(1)
      expect(coldOwnerCount([session.id])).toBe(0)
      const restored = yield* sessions.getPart({ sessionID: session.id, messageID, partID })
      expect(restored?.type === "reasoning" ? restored.text : undefined).toBe("maintenance-reasoning-".repeat(512))

      expect(ColdStorage.prepareMaintenance({ operation: "status" }).type).toBe("immediate")
      const prepared = ColdStorage.prepareMaintenance({
        operation: "compress",
        olderThanMs: 30 * 24 * 60 * 60 * 1000,
        batchSize: 50,
      })
      expect(prepared.type).toBe("task")
      if (prepared.type !== "task") throw new Error("Expected task-backed maintenance")
      // task round-trip 证明持久 record 能通过白名单重建；字符串 counter 模拟可解析但不可信的外部文件。
      // 损坏 record 必须在 resume 前失败，不能靠 TypeScript cast 把 processed="1" 带进 cursor 累加。
      expect(ColdStorage.parseMaintenanceTask(structuredClone(prepared.task))).toEqual(prepared.task)
      expect(() => ColdStorage.parseMaintenanceTask({ ...prepared.task, processed: "1" })).toThrow()
      expect(() => ColdStorage.parseMaintenanceTask({ ...prepared.task, taskID: "dbm_../../outside" })).toThrow()
      expect(() =>
        ColdStorage.parseMaintenanceTask({
          ...prepared.task,
          cursor: { owner: "message", lastID: "prt_wrong-kind" },
        }),
      ).toThrow()
      expect(() => ColdStorage.prepareMaintenance({ operation: "compress", olderThanMs: 0, batchSize: 5001 })).toThrow()
      yield* sessions.remove(session.id)
    }),
  )

  // cleanup 用例通过手工清 ref 模拟外部 SQL/crash 遗留 orphan，正常 API 不应制造这种状态。
  // preview 必须报告候选但保留 payload row，证明默认命令是纯只读而非隐式清理。
  // delete=true 后目标 hash 消失，且删除数至少包含该已证明的 ownerless payload。
  // cleanup 依据两个 owner 表反算，不信任测试未同步修改的旧 ref_count=1。
  // 目标 payload 在 preview/delete 之间保持无 owner，隔离二次确认的正常成功路径。
  // 测试不执行 VACUUM，锁定逻辑删除与物理页面回收是两个独立用户操作。
  // hash 从真实 Part.cold_ref 读取，不复制 canonical digest 实现。
  // 删除 session 时 Part 已热且 payload 已清，证明 cleanup 不破坏普通 cascade。
  // 断言不要求全库 candidates 恰好为一，允许测试运行器共享数据库中的其他诊断状态。
  // 该用例是 verify --repair 之外的 orphan 生命周期证据，二者不能互相替代。
  it.instance("previews cleanup without writes and deletes only ownerless payloads", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionNs.Service
      const session = yield* sessions.create({ title: "cold cleanup" })
      const messageID = MessageID.ascending()
      const partID = PartID.ascending()
      yield* sessions.updateMessage({
        id: messageID,
        sessionID: session.id,
        role: "assistant",
        parentID: MessageID.ascending(),
        modelID: ModelID.make("test-model"),
        providerID: ProviderID.make("test-provider"),
        mode: "build",
        agent: "build",
        path: { cwd: session.directory, root: session.directory },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: Date.now() },
      })
      yield* sessions.updatePart({
        id: partID,
        sessionID: session.id,
        messageID,
        type: "reasoning",
        text: "cleanup-payload-".repeat(512),
        time: { start: 1, end: 2 },
      })
      Database.use((db) =>
        db
          .update(SessionTable)
          .set({ time_updated: Date.now() - 31 * 24 * 60 * 60 * 1000 })
          .where(Database.eq(SessionTable.id, session.id))
          .run(),
      )
      expect(ColdStorage.freezeOwner({ type: "part", id: partID }).type).toBe("frozen")
      const hash = Database.use(
        (db) =>
          db.select({ hash: PartTable.cold_ref }).from(PartTable).where(Database.eq(PartTable.id, partID)).get()?.hash,
      )
      if (!hash) throw new Error("Expected a cleanup hash")
      // 手工清除 owner 模拟外部 SQL/crash 遗留的 orphan；正常删除路径不会制造此状态。
      Database.use((db) => db.update(PartTable).set({ cold_ref: null }).where(Database.eq(PartTable.id, partID)).run())

      const preview = ColdStorage.cleanup({ delete: false })
      expect(preview.candidates).toBeGreaterThanOrEqual(1)
      expect(
        Database.use((db) => db.select().from(ColdStorageTable).where(Database.eq(ColdStorageTable.hash, hash)).get()),
      ).toBeDefined()
      const deleted = ColdStorage.cleanup({ delete: true })
      expect(deleted.deleted).toBeGreaterThanOrEqual(1)
      expect(
        Database.use((db) => db.select().from(ColdStorageTable).where(Database.eq(ColdStorageTable.hash, hash)).get()),
      ).toBeUndefined()
      yield* sessions.remove(session.id)
    }),
  )

  // dispatcher 用例使用同一 prepared request/runtime seam，模拟 daemon 与 offline CLI 的共同执行核心。
  // batchSize=1 强制经过多次 cursor/checkpoint，避免单批成功掩盖状态机缺陷。
  // compress terminal 必须 completed，且 session 内恰有一个 owner 进入 cold 状态。
  // checkpoint 至少出现 running，证明 task 在数据提交前后有可查询的非终态记录。
  // expand 使用相同 runtime 和 scoped request，禁止调用另一个平行解压实现。
  // expand completed 后 owner 归零，tool output 逐字恢复并可由普通 getPart 读取。
  // task counters 不在测试中复制 production 计算，只检查用户可观察的状态和内容。
  // lease stub 只提供 ownership invariant，不 mock 数据库或压缩器。
  // 该用例同时覆盖默认 operation dispatch 对 unsupported/immediate 路径的类型收窄。
  // 最终删除 session 确认 terminal task 未持有数据库 owner 或内存缓存引用。
  it.instance("runs compress and expand through the shared maintenance dispatcher", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionNs.Service
      const session = yield* sessions.create({ title: "maintenance dispatcher" })
      const messageID = MessageID.ascending()
      const partID = PartID.ascending()
      const output = "dispatcher-output-".repeat(512)
      yield* sessions.updateMessage({
        id: messageID,
        sessionID: session.id,
        role: "assistant",
        parentID: MessageID.ascending(),
        modelID: ModelID.make("test-model"),
        providerID: ProviderID.make("test-provider"),
        mode: "build",
        agent: "build",
        path: { cwd: session.directory, root: session.directory },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: Date.now() },
      })
      yield* sessions.updatePart({
        id: partID,
        sessionID: session.id,
        messageID,
        type: "tool",
        callID: "dispatcher",
        tool: "read",
        state: {
          status: "completed",
          input: {},
          output,
          title: "read",
          metadata: {},
          time: { start: 1, end: 2 },
        },
      })
      Database.use((db) =>
        db
          .update(SessionTable)
          .set({ time_updated: Date.now() - 31 * 24 * 60 * 60 * 1000 })
          .where(Database.eq(SessionTable.id, session.id))
          .run(),
      )
      const checkpoints: ColdStorage.MaintenanceTask[] = []
      const runtime = {
        lease: { assertOwned() {} },
        checkpoint(task: ColdStorage.MaintenanceTask) {
          checkpoints.push(structuredClone(task))
          return Promise.resolve()
        },
      }
      const compressed = yield* Effect.promise(() =>
        ColdStorage.maintain(
          ColdStorage.prepareMaintenance({
            operation: "compress",
            sessionID: session.id,
            olderThanMs: 30 * 24 * 60 * 60 * 1000,
            batchSize: 1,
          }),
          runtime,
        ),
      )
      expect(compressed.type).toBe("task")
      expect(compressed.type === "task" ? compressed.task.status : undefined).toBe("completed")
      expect(coldOwnerCount([session.id])).toBe(1)
      expect(checkpoints.some((task) => task.status === "running")).toBe(true)

      const expanded = yield* Effect.promise(() =>
        ColdStorage.maintain(
          ColdStorage.prepareMaintenance({ operation: "expand", sessionID: session.id, all: false, batchSize: 1 }),
          runtime,
        ),
      )
      expect(expanded.type === "task" ? expanded.task.status : undefined).toBe("completed")
      expect(coldOwnerCount([session.id])).toBe(0)
      const restored = yield* sessions.getPart({ sessionID: session.id, messageID, partID })
      expect(
        restored?.type === "tool" && restored.state.status === "completed" ? restored.state.output : undefined,
      ).toBe(output)
      yield* sessions.remove(session.id)
    }),
  )

  // file row 的热骨架比 canonical envelope 少几个固定包装字节，是 SQL 等值门槛可能漏选的最小反例。
  // 测试把真实持久 data JSON 固定在 4095 bytes，证明它低于最终门槛但其冷 envelope 仍应被 exact 判定接纳。
  // 维护必须通过 session-scoped dispatcher 而非直接 freezeOwner，才能覆盖 nextPartRows 的 SQL candidate 条件。
  // completed task 与非空 cold_ref 联合证明 candidate 未漏选；普通 getPart 随后验证透明持久 thaw。
  // URL 由独立 JSON byte 长度构造，不复制 canonical key sorting、hash 或 compression 实现。
  // batchSize=10 不是性能断言，只避免单 owner 测试引入不相关 cursor 次数假设。
  // session 最终删除确认边界用例不遗留 payload 或共享测试数据库状态。
  it.instance("includes a file envelope that crosses the threshold above its stored row size", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionNs.Service
      const session = yield* sessions.create({ title: "candidate threshold" })
      const messageID = MessageID.ascending()
      const partID = PartID.ascending()
      const prefix = "data:image/png;base64,"
      const baseBytes = Buffer.byteLength(JSON.stringify({ type: "file", mime: "image/png", url: prefix }))
      const url = prefix + "a".repeat(4095 - baseBytes)
      expect(Buffer.byteLength(JSON.stringify({ type: "file", mime: "image/png", url }))).toBe(4095)
      yield* sessions.updateMessage({
        id: messageID,
        sessionID: session.id,
        role: "user",
        time: { created: Date.now() },
        agent: "build",
        model: { providerID: ProviderID.make("test-provider"), modelID: ModelID.make("test-model") },
      })
      yield* sessions.updatePart({ id: partID, sessionID: session.id, messageID, type: "file", mime: "image/png", url })
      Database.use((db) =>
        db
          .update(SessionTable)
          .set({ time_updated: Date.now() - 31 * 24 * 60 * 60 * 1000 })
          .where(Database.eq(SessionTable.id, session.id))
          .run(),
      )
      const result = yield* Effect.promise(() =>
        ColdStorage.maintain(
          ColdStorage.prepareMaintenance({
            operation: "compress",
            sessionID: session.id,
            olderThanMs: 30 * 24 * 60 * 60 * 1000,
            batchSize: 10,
          }),
          { lease: { assertOwned() {} }, checkpoint: () => Promise.resolve() },
        ),
      )
      expect(result.type === "task" ? result.task.status : undefined).toBe("completed")
      expect(coldOwnerCount([session.id])).toBe(1)
      const restored = yield* sessions.getPart({ sessionID: session.id, messageID, partID })
      expect(restored?.type === "file" ? restored.url : undefined).toBe(url)
      yield* sessions.remove(session.id)
    }),
  )

  // interruption 用例在首个已提交数据批 checkpoint 后 abort，确保不是“开始前取消”的简单分支。
  // signal 只在下一批边界观察，因此已提交 cursor/processed 必须随 interrupted task 一起返回。
  // resume 注入原 task record，operation/args/cursor 不能被新 prepared task 的随机 ID 覆盖。
  // 第二次 maintain 从持久 cursor 继续，已冷 owner 因状态幂等不会被重复压缩或重复加 ref。
  // terminal completed 和 cold owner=1 联合证明恢复既没有漏处理，也没有双计数。
  // checkpoint callback 不写磁盘是 unit seam；daemon 集成测试另行覆盖原子 task 文件。
  // controller 由测试在 observable running checkpoint 中触发，不依赖 sleep 或调度时序。
  // batchSize=1 使中断点确定，避免大批次太快结束导致 flaky abort。
  // 测试不修改 resumed args，锁定用户必须用新 task 才能改变 scope 的合同。
  // session 删除验证 completed resume 后引用生命周期仍由正常 projector 接管。
  it.instance("checkpoints an interrupted task and resumes from its cursor", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionNs.Service
      const session = yield* sessions.create({ title: "maintenance resume" })
      const messageID = MessageID.ascending()
      const partID = PartID.ascending()
      yield* sessions.updateMessage({
        id: messageID,
        sessionID: session.id,
        role: "assistant",
        parentID: MessageID.ascending(),
        modelID: ModelID.make("test-model"),
        providerID: ProviderID.make("test-provider"),
        mode: "build",
        agent: "build",
        path: { cwd: session.directory, root: session.directory },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: Date.now() },
      })
      yield* sessions.updatePart({
        id: partID,
        sessionID: session.id,
        messageID,
        type: "tool",
        callID: "resume",
        tool: "read",
        state: {
          status: "completed",
          input: {},
          output: "resume-output-".repeat(512),
          title: "read",
          metadata: {},
          time: { start: 1, end: 2 },
        },
      })
      Database.use((db) =>
        db
          .update(SessionTable)
          .set({ time_updated: Date.now() - 31 * 24 * 60 * 60 * 1000 })
          .where(Database.eq(SessionTable.id, session.id))
          .run(),
      )
      const controller = new AbortController()
      let aborted = false
      const firstRuntime = {
        lease: { assertOwned() {} },
        signal: controller.signal,
        checkpoint(task: ColdStorage.MaintenanceTask) {
          if (task.status === "running" && task.processed > 0 && !aborted) {
            aborted = true
            controller.abort()
          }
          return Promise.resolve()
        },
      }
      const interrupted = yield* Effect.promise(() =>
        ColdStorage.maintain(
          ColdStorage.prepareMaintenance({
            operation: "compress",
            sessionID: session.id,
            olderThanMs: 30 * 24 * 60 * 60 * 1000,
            batchSize: 1,
          }),
          firstRuntime,
        ),
      )
      expect(interrupted.type === "task" ? interrupted.task.status : undefined).toBe("interrupted")

      const resumed = yield* Effect.promise(() =>
        ColdStorage.maintain(
          ColdStorage.prepareMaintenance({
            operation: "compress",
            sessionID: session.id,
            olderThanMs: 30 * 24 * 60 * 60 * 1000,
            batchSize: 1,
          }),
          {
            lease: { assertOwned() {} },
            task: interrupted.type === "task" ? interrupted.task : undefined,
            checkpoint: async () => {},
          },
        ),
      )
      expect(resumed.type === "task" ? resumed.task.status : undefined).toBe("completed")
      expect(coldOwnerCount([session.id])).toBe(1)
      yield* sessions.remove(session.id)
    }),
  )
})

describe.serial("Packed ColdStorage V2", () => {
  // maintenance batch 必须把同 Session/kind 的小 owner 装入同一 pack；相同 ref 配合不同 key 才能定位各自 entry。
  // refcount 以真实 owner 数计为 2，而不是按 payload 行或 Session 计为 1；expand 后 payload 应由最后一个 owner 释放。
  // 恢复预期直接使用压缩前持久 business rows，避免测试复制 extraction、codec 或 entry selector 算法。
  it.instance("packs small Part owners together and expands them losslessly", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const sessions = yield* SessionNs.Service
      const session = yield* sessions.create({ title: "shared Part pack" })
      const first = yield* addCompletedSummaryEdit(sessions, {
        sessionID: session.id,
        directory: test.directory,
        file: "src/pack-a.ts",
        patch: "+pack-a\n",
      })
      // 两个 Tool 使用不同文件和 patch，排除内容去重碰巧共享 entry key 的假阳性。
      const second = yield* addCompletedSummaryEdit(sessions, {
        sessionID: session.id,
        directory: test.directory,
        file: "src/pack-b.ts",
        patch: "+pack-b\n",
      })
      const ids = [first.partID, second.partID]
      // 原始 rows 在压缩前读取，是允许的业务基线；压缩后的 skeleton 不参与 expected 构造。
      const original = Database.use((db) =>
        db
          .select({ id: PartTable.id, data: PartTable.data })
          .from(PartTable)
          .where(Database.inArray(PartTable.id, ids))
          .orderBy(PartTable.id)
          .all(),
      )
      // maintenance 走公开 dispatcher 与真实 lease contract，不能用 direct freeze 掩盖 batch packing 差异。
      const result = yield* Effect.promise(() =>
        ColdStorage.maintain(
          ColdStorage.prepareMaintenance({
            operation: "compress",
            olderThanMs: 0,
            batchSize: ColdStorage.DEFAULT_BATCH_SIZE,
          }),
          { lease: { assertOwned() {} }, checkpoint: async () => {} },
        ),
      )
      expect(result.type === "task" ? result.task.status : undefined).toBe("completed")

      // key 只断言互异而不复制二进制编码，未来可改变 key representation 而不削弱 entry identity。
      const packed = Database.use((db) =>
        db
          .select({ id: PartTable.id, ref: PartTable.cold_ref, key: PartTable.cold_key })
          .from(PartTable)
          .where(Database.inArray(PartTable.id, ids))
          .orderBy(PartTable.id)
          .all(),
      )
      expect(packed).toHaveLength(2)
      expect(packed[0]?.ref).toBe(packed[1]?.ref)
      expect(packed[0]?.key).not.toEqual(packed[1]?.key)
      // payload refcount 从真实表读取，证明共享收益与 owner 生命周期同时成立。
      expect(
        Database.use((db) =>
          db
            .select({ refs: ColdStorageTable.ref_count })
            .from(ColdStorageTable)
            .where(Database.eq(ColdStorageTable.hash, packed[0]?.ref ?? ""))
            .get(),
        ),
      ).toEqual({ refs: 2 })

      // expand 后同时比较 data 和空 payload 表，防止“业务值恢复但 orphan pack 遗留”的半成功。
      ColdStorage.expand({ all: true })
      expect(
        Database.use((db) =>
          db
            .select({ id: PartTable.id, data: PartTable.data })
            .from(PartTable)
            .where(Database.inArray(PartTable.id, ids))
            .orderBy(PartTable.id)
            .all(),
        ),
      ).toEqual(original)
      // fixture DB 随 Instance scope 清理，断言不依赖其他测试的全局 payload 数量。
      expect(Database.use((db) => db.select().from(ColdStorageTable).all())).toEqual([])
    }),
  )

  // legacy mirror 是迁移前已发布的数据来源，首次公开读取必须先转入同库 DB authority。
  // 删除 mirror 后 Session、Summary service 与 HTTP 三个消费者都只能得到同一持久值。
  // expected 完全由测试字面量构造，不读取 summary payload 反向生成预期值。
  it.instance("adopts a legacy diff once for every public diff seam", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const sessions = yield* SessionNs.Service
      const summary = yield* SessionSummary.Service
      const storage = yield* Storage.Service
      const session = yield* sessions.create({ title: "legacy summary adoption" })
      const expected = [{ file: "legacy.ts", additions: 3, deletions: 1 }]

      // 该兼容只允许 pending initialization 使用一次，不能演变为 corruption 后的 fallback。
      yield* storage.write(["session_diff", session.id], expected)
      expect(yield* sessions.diff(session.id)).toEqual(expected)
      // mirror 删除模拟用户清理外部缓存目录，后续成功不能依赖文件幸存。
      yield* storage.remove(["session_diff", session.id])
      // 第二次读取不检查 helper 调用次数，只观察外部数据源已经不存在时的业务结果。
      expect(yield* summary.diff({ sessionID: session.id })).toEqual(expected)

      // 三个 seam 共用同一 Session，能够暴露任一 caller 绕过 DB authority 的分叉实现。
      // HTTP 路径使用公开 route 常量与真实 instance header，不复制 handler 内部函数。
      const response = yield* Effect.promise(() =>
        Promise.resolve(
          Server.Default().app.request(SessionPaths.diff.replace(":sessionID", session.id), {
            headers: { "x-opencode-directory": test.directory },
          }),
        ),
      )
      const body = yield* Effect.promise(() => response.text())
      // 非 200 会保留 response body，确保 codec/Storage defect 不被空数组断言掩盖。
      if (response.status !== 200) throw new Error(`HTTP ${response.status}: ${body}`)
      // missing patch 的更细兼容形状由 unchanged HTTP regression 单独覆盖，本例只锁定 authority 生命周期。
      expect(JSON.parse(body)).toEqual(expected)
    }),
  )

  // 首次 automatic summarize 即使只有 legacy materialization，也必须更新 Session counters。
  // 第二次执行使用同一边界并在 mirror 删除后读取，必须保持 aggregate 和 counters 稳定。
  it.instance("publishes legacy materialization through automatic summarize exactly once", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionNs.Service
      const summary = yield* SessionSummary.Service
      const storage = yield* Storage.Service
      const session = yield* sessions.create({ title: "automatic legacy materialization" })
      const messageID = MessageID.ascending()
      // user Message 没有 Tool child，刻意制造“payload 改变但增量为空”的 materialized 分支。
      yield* sessions.updateMessage({
        id: messageID,
        sessionID: session.id,
        role: "user",
        time: { created: Date.now() },
        agent: "build",
        model: { providerID: ProviderID.make("test-provider"), modelID: ModelID.make("test-model") },
      })
      // expected 数字来自 literal legacy 行，不从 Session counters 反推，避免同源错误。
      const expected = [{ file: "legacy-auto.ts", additions: 4, deletions: 2 }]
      // storage.write 仍是 existing downgrade mirror orchestration，不是新的 production authority。
      yield* storage.write(["session_diff", session.id], expected)

      yield* summary.summarize({ sessionID: session.id, messageID })
      // counters 由公开 Session.get 观察，避免断言 SummaryCache private CAS 结果。
      expect((yield* sessions.get(session.id)).summary).toMatchObject({ additions: 4, deletions: 2, files: 1 })
      // 第二次 summarize 证明 cursor-only 重放不会重复增加 files/additions/deletions。
      yield* summary.summarize({ sessionID: session.id, messageID })
      // mirror 在第二次后删除，随后 Summary service 必须仍从 DB ref 返回同一累计值。
      yield* storage.remove(["session_diff", session.id])
      expect(yield* summary.diff({ sessionID: session.id })).toEqual(expected)
      // Bus 发布次数不作为断言，因为用户可观察 counters/diff 已覆盖 exactly-once 语义。
      // 该用例与普通 Session.diff 初始化分开，防止先读 cache 掩盖 automatic 路径差异。
      expect((yield* sessions.get(session.id)).summary).toMatchObject({ additions: 4, deletions: 2, files: 1 })
    }),
  )

  // mirror 与第一轮累计值逐字段相等时只能证明 prefix，不能声称覆盖初始化时已持久化的最新 Tool tail。
  // expected 两个文件各出现一次；丢失第二项或重复第一项都会改变公开数组与计数。
  it.instance("keeps the Tool tail after proving a legacy cumulative prefix", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const sessions = yield* SessionNs.Service
      const storage = yield* Storage.Service
      const session = yield* sessions.create({ title: "legacy prefix with tail" })
      // 两个文件不同使 append 与 merge 行为可直接观察，不依赖 patch parser。
      const first = { file: "src/first.ts", patch: "+first\n", additions: 1, deletions: 0, status: "added" as const }
      // second literal 完全由测试构造，若 cursor 错标为当前最大值就会稳定丢失该项。
      const second = { file: "src/second.ts", patch: "+second\n", additions: 1, deletions: 0, status: "added" as const }
      yield* addCompletedSummaryEdit(sessions, {
        sessionID: session.id,
        directory: test.directory,
        file: first.file,
        patch: first.patch,
      })
      // mirror 写入严格位于 first Tool 与 second Tool 之间，复现正常 summarize 的真实持久顺序。
      // first literal 同时作为 mirror 与 expected prefix，lineage proof 必须逐字段匹配才可抑制 seed。
      yield* storage.write(["session_diff", session.id], [first])
      yield* addCompletedSummaryEdit(sessions, {
        sessionID: session.id,
        directory: test.directory,
        file: second.file,
        patch: second.patch,
      })

      // 文件顺序也参与断言，保护按 MessageID 累计的用户展示语义。
      // 测试不读取 summary_cursor，结果数组本身就是 public contract 的充分证据。
      expect(yield* sessions.diff(session.id)).toEqual([first, second])
      // 删除 mirror 后重复读取证明正确 tail 已进入同库 payload，而非每次重新读文件。
      yield* storage.remove(["session_diff", session.id])
      // 同一 worktree path normalization 在 helper 和 expected 中使用相对路径，排除平台分隔符噪声。
      expect(yield* sessions.diff(session.id)).toEqual([first, second])
    }),
  )

  // 不可证明 lineage 的 legacy aggregate 是 opaque seed；full expand 必须先把它转为同一 Session 的 hot seed。
  // 删除 mirror 后仍返回逐字段原值，证明 expand 没有重新启用外部文件 fallback。
  it.instance("preserves an opaque legacy aggregate across full expand", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const sessions = yield* SessionNs.Service
      const storage = yield* Storage.Service
      const session = yield* sessions.create({ title: "opaque legacy expand" })
      // 同 Session 只有一个 Tool，使 opaque 判断的反例最小且每个输入都负载必要。
      yield* addCompletedSummaryEdit(sessions, {
        sessionID: session.id,
        directory: test.directory,
        file: "src/opaque.ts",
        patch: "+tool-evidence\n",
      })
      // Tool evidence 与 legacy 修改同一文件但 patch/计数不同，刻意阻止 cumulative-prefix proof。
      // expected 不从 hot seed 列读取，避免直接断言 private representation。
      const expected = [
        { file: "src/opaque.ts", patch: "+legacy-import\n", additions: 7, deletions: 3, status: "modified" as const },
      ]
      yield* storage.write(["session_diff", session.id], expected)
      // 首次公开结果必须选择 persisted legacy 语义，不能把两个来源猜测性拼接。
      expect(yield* sessions.diff(session.id)).toEqual(expected)
      // hot seed 留在 Session 行而非外部目录，所以用户清理 mirror 不影响可逆性。
      yield* storage.remove(["session_diff", session.id])

      // expand 使用公开 ColdStorage operation，覆盖 summary owner 与 Message/Part owner 的统一清理路径。
      ColdStorage.expand({ all: true })
      // ref/cursor 归零只证明 representation 展开，随后 public diff byte-equal 才证明业务值未丢失。
      expect(
        Database.use((db) =>
          db
            .select({ ref: SessionTable.summary_ref, cursor: SessionTable.summary_cursor })
            .from(SessionTable)
            .where(Database.eq(SessionTable.id, session.id))
            .get(),
        ),
      ).toEqual({ ref: null, cursor: null })
      // next diff 可重新压入 DB payload，但该表示变化不能改变 FileDiff 数组。
      expect(yield* sessions.diff(session.id)).toEqual(expected)
    }),
  )

  // opaque seed 覆盖 first Tool；second Tool 是可证明的 post-seed suffix。
  // suffix replacement 必须保留 seed，只从当前 second Part 重建，不能累计旧版 suffix patch。
  it.instance("preserves an opaque seed while rebuilding a mutated post-seed suffix", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const sessions = yield* SessionNs.Service
      const storage = yield* Storage.Service
      const session = yield* sessions.create({ title: "opaque suffix mutation" })
      // first Tool evidence 与 seed 不同，确保前缀确实不可追溯而不是普通 exact-prefix case。
      yield* addCompletedSummaryEdit(sessions, {
        sessionID: session.id,
        directory: test.directory,
        file: "src/pre-seed.ts",
        patch: "+tool-before-seed\n",
      })
      // suffix 文件与 seed 文件不同，使 merge index 不会掩盖位置分类错误。
      const seed = {
        file: "src/imported.ts",
        patch: "+opaque-legacy\n",
        additions: 5,
        deletions: 1,
        status: "modified" as const,
      }
      yield* storage.write(["session_diff", session.id], [seed])
      expect(yield* sessions.diff(session.id)).toEqual([seed])
      // mirror 在 mutation 前已删除，projector 只能保存 DB seed 并从当前 Part 重建。
      yield* storage.remove(["session_diff", session.id])

      // second Tool 在初始化后创建，其 MessageID 严格大于 seed cursor，提供持久位置分类证据。
      const suffix = yield* addCompletedSummaryEdit(sessions, {
        sessionID: session.id,
        directory: test.directory,
        file: "src/suffix.ts",
        patch: "+suffix-old\n",
      })
      expect(yield* sessions.diff(session.id)).toEqual([
        seed,
        { file: "src/suffix.ts", patch: "+suffix-old\n", additions: 1, deletions: 0, status: "added" },
      ])
      // replacement 复用同一 PartID，模拟公开 PATCH/完整 projector replacement，而非新增第三条 diff。
      yield* sessions.updatePart({
        id: suffix.partID,
        sessionID: session.id,
        messageID: suffix.assistantID,
        type: "tool",
        callID: "edit-suffix-replaced",
        tool: "edit",
        state: {
          status: "completed",
          input: {},
          output: "ok",
          title: "edit",
          metadata: {
            filediff: {
              file: path.join(test.directory, "src/suffix.ts"),
              patch: "+suffix-new\n",
              additions: 1,
              deletions: 0,
            },
          },
          time: { start: 0, end: 1 },
        },
      })
      // expected 同时拒绝 seed 丢失、old suffix 遗留和 old+new patch 重复三类错误。
      // status/additions/deletions 与 patch 一起断言，防止只修字符串却保留旧 projection 标量。
      // public Session.diff 是 frontend/HTTP 共用业务 seam，测试不调用 invalidation helper。
      expect(yield* sessions.diff(session.id)).toEqual([
        seed,
        { file: "src/suffix.ts", patch: "+suffix-new\n", additions: 1, deletions: 0, status: "added" },
      ])
    }),
  )

  // opaque seed 无法把某段反向归属给 covered Tool；该历史被修改后必须退休 seed并从当前 rows 完整重建。
  // mirror 已删除，确保 rebuilt 值没有通过兼容文件取回失效 patch。
  it.instance("retires an opaque seed after a covered history mutation", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const sessions = yield* SessionNs.Service
      const storage = yield* Storage.Service
      const session = yield* sessions.create({ title: "opaque covered mutation" })
      // mutation MessageID 位于 seed cursor 内，和上一用例的 post-seed 条件形成互补边界。
      const edit = yield* addCompletedSummaryEdit(sessions, {
        sessionID: session.id,
        directory: test.directory,
        file: "src/covered.ts",
        patch: "+covered-old\n",
      })
      // legacy 文件与 Tool 文件不同，若 seed 未退休会在结果中清晰多出 imported.ts。
      const seed = [
        { file: "src/imported.ts", patch: "+opaque\n", additions: 9, deletions: 4, status: "modified" as const },
      ]
      yield* storage.write(["session_diff", session.id], seed)
      expect(yield* sessions.diff(session.id)).toEqual(seed)
      // mirror 清理不会删除 per-Message summary 或 Tool metadata，因此零数据损失仍可由重建证明。
      yield* storage.remove(["session_diff", session.id])

      // Part business row 始终存在，测试只让派生 Session aggregate 失效，不混入删除语义。
      // 不尝试从 opaque seed 减去旧 Tool，锁定“正式失效后全量重建”而非不可证明的 lineage 算法。
      yield* sessions.updatePart({
        id: edit.partID,
        sessionID: session.id,
        messageID: edit.assistantID,
        type: "tool",
        callID: "edit-covered-replaced",
        tool: "edit",
        state: {
          status: "completed",
          input: {},
          output: "ok",
          title: "edit",
          metadata: {
            filediff: {
              file: path.join(test.directory, "src/covered.ts"),
              patch: "+covered-new\n",
              additions: 1,
              deletions: 0,
            },
          },
          time: { start: 0, end: 1 },
        },
      })
      // replacement expected 只来自当前 visible Tool metadata，是现有 Revert 重建语义的独立字面量。
      // files 数量从一到一但文件名变化，防止仅检查 counters 的弱断言漏掉 stale seed。
      // 完整 public array 比较同时保护顺序、路径、patch、计数与 status。
      expect(yield* sessions.diff(session.id)).toEqual([
        { file: "src/covered.ts", patch: "+covered-new\n", additions: 1, deletions: 0, status: "added" },
      ])
    }),
  )

  // persisted claim 是初始化 I/O 的 durable boundary；covered closed Tool mutation 必须把它标成 dirty。
  // resumed public diff 随后跳过 stale mirror，只从当前 rows 重建 replacement patch。
  it.instance("rejects a stale mirror after a claimed boundary becomes dirty", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const sessions = yield* SessionNs.Service
      const storage = yield* Storage.Service
      const session = yield* sessions.create({ title: "dirty initialization claim" })
      const edit = yield* addCompletedSummaryEdit(sessions, {
        sessionID: session.id,
        directory: test.directory,
        file: "src/claim.ts",
        patch: "+claim-old\n",
      })
      // stale mirror 使用不同文件和大计数，若被采用会产生一眼可见的错误结果。
      yield* storage.write(["session_diff", session.id], [
        { file: "src/stale.ts", patch: "+stale\n", additions: 20, deletions: 10, status: "modified" },
      ])
      // 测试直接构造 crash-resume 可见的 persisted claim，而不是依赖不可控 wall-clock race。
      Database.use((db) =>
        db
          .update(SessionTable)
          .set({
            summary_initialized: false,
            summary_init_dirty: false,
            // claim cursor 指向 completed Assistant，满足“covered closed history”而非 running activity。
            summary_cursor: edit.assistantID,
            summary_ref: null,
            // summary_ref/seed 显式为空，保证 fixture 表示 pending initialization 而不是 materialized cache。
            summary_seed: null,
            time_updated: SessionTable.time_updated,
          })
          .where(Database.eq(SessionTable.id, session.id))
          .run(),
      )
      // Part replacement 经公开 Session service 投影，使 dirty 与 owner replacement 共享真实 transaction。
      yield* sessions.updatePart({
        id: edit.partID,
        sessionID: session.id,
        messageID: edit.assistantID,
        type: "tool",
        callID: "edit-claim-replaced",
        tool: "edit",
        state: {
          status: "completed",
          input: {},
          output: "ok",
          title: "edit",
          metadata: {
            filediff: {
              file: path.join(test.directory, "src/claim.ts"),
              patch: "+claim-new\n",
              additions: 1,
              deletions: 0,
            },
          },
          time: { start: 0, end: 1 },
        },
      })
      // 首次 diff 即恢复 current Tool 值，证明 dirty resume 在文件 I/O 前跳过 mirror。
      // expected 不读取 summary_init_dirty；用户结果比内部 bit 更能保护 crash-resume contract。
      // 本例与 Deferred race 并存，分别覆盖进程重启状态和同进程 I/O 窗口。
      expect(yield* sessions.diff(session.id)).toEqual([
        { file: "src/claim.ts", patch: "+claim-new\n", additions: 1, deletions: 0, status: "added" },
      ])
    }),
  )

  // pending Tool 没有稳定 filediff metadata，不属于 aggregate producer；input/output 变化不能污染 claim。
  // claim 保持 clean 时首次读取仍采用合法 mirror，避免无关 active-turn 写入抛弃可恢复历史。
  it.instance("keeps an initialization claim clean for a pending Tool update", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const sessions = yield* SessionNs.Service
      const storage = yield* Storage.Service
      const session = yield* sessions.create({ title: "clean initialization claim" })
      const edit = yield* addCompletedSummaryEdit(sessions, {
        sessionID: session.id,
        directory: test.directory,
        file: "src/existing.ts",
        patch: "+existing\n",
      })
      // existing completed Tool 作为重建反例：若 claim 被误标 dirty，结果会变成 existing.ts。
      // literal mirror 与 existing Tool 完全不同，使 clean/dirty 两条路径可由公开结果判别。
      const expected = [
        { file: "src/imported.ts", patch: "+imported\n", additions: 8, deletions: 2, status: "modified" as const },
      ]
      yield* storage.write(["session_diff", session.id], expected)
      Database.use((db) =>
        db
          .update(SessionTable)
          .set({
            summary_initialized: false,
            summary_init_dirty: false,
            summary_cursor: edit.assistantID,
            summary_ref: null,
            summary_seed: null,
            time_updated: SessionTable.time_updated,
          })
          .where(Database.eq(SessionTable.id, session.id))
          .run(),
      )

      // pending Part 插入和 replacement 都位于 captured closed Message 下，专门测试 projector 的 producer 分类。
      // pending Tool 保持热态，测试不把冷 codec 行为混入初始化分类。
      const pendingID = PartID.ascending()
      yield* sessions.updatePart({
        id: pendingID,
        sessionID: session.id,
        messageID: edit.assistantID,
        type: "tool",
        callID: "pending-tool",
        tool: "edit",
        state: { status: "pending", input: { file: "src/pending.ts" }, raw: "pending" },
      })
      // callID 保持相同，模拟流式 Tool input 更新而非另一个独立调用。
      // raw/input 两次变化均不产生 completed metadata，故任何 dirty 都是过度失效。
      yield* sessions.updatePart({
        id: pendingID,
        sessionID: session.id,
        messageID: edit.assistantID,
        type: "tool",
        callID: "pending-tool",
        tool: "edit",
        state: { status: "pending", input: { file: "src/pending.ts", content: "changed" }, raw: "changed" },
      })
      // 不检查 dirty=false 列值，避免测试耦合 bit 表示；只验证其业务后果。
      // 该正常 active-turn 路径避免频繁废弃 legacy import，属于性能与兼容共同边界。
      expect(yield* sessions.diff(session.id)).toEqual(expected)
    }),
  )

  // hidden 是 transcript 可见性，不是 usage/statistics 删除；完整 report 必须与隐藏前逐字段相同。
  // v2 cold_stats 保存既有统计标量；owner/ref/key/projection/refcount 的前后快照证明 Stats 没有持久 thaw。
  it.instance("keeps hidden data in Stats without thawing packed owners", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const sessions = yield* SessionNs.Service
      const session = yield* sessions.create({ title: "hidden packed stats" })
      const edit = yield* addCompletedSummaryEdit(sessions, {
        sessionID: session.id,
        directory: test.directory,
        file: "src/stats.ts",
        patch: "+stats\n",
      })
      // expected report 由 hot path 生成，不从 cold_stats 反推，避免 projector 与测试共享错误公式。
      // 同一 report 包含 session/tool/model/agent/token/字符等所有现有透视结构。
      const hot = yield* aggregateStats()
      Database.use((db) => {
        const row = db.select().from(MessageTable).where(Database.eq(MessageTable.id, edit.assistantID)).get()
        if (!row) throw new Error("Stats fixture assistant is missing")
        // hidden 采用真实 undo reason shape，不用 boolean 伪造旧 schema。
        db.update(MessageTable)
          .set({ data: { ...row.data, hidden: { reason: "undo", time: Date.now() } }, time_updated: row.time_updated })
          .where(Database.eq(MessageTable.id, row.id))
          .run()
      })
      // hot report 在 hidden 标记前捕获，随后 byte-deep equality 证明 hidden rows 仍计入全部 public pivots。
      expect(yield* aggregateStats()).toEqual(hot)

      // Tool output 虽很小仍进入 v2 projection，freeze result 证明测试确实覆盖 cold owner。
      expect(
        ColdStorage.freezeOwner({ type: "part", id: edit.partID, now: Date.now() + 1_000, olderThanMs: 0 }).type,
      ).toBe("frozen")
      // state snapshot 包含 owner ref/key/stats 与所有 payload refcount，防止只检查 cold_ref 的弱证明。
      const state = () =>
        Database.use((db) => ({
          owner: db
            .select({ ref: PartTable.cold_ref, key: PartTable.cold_key, stats: PartTable.cold_stats })
            .from(PartTable)
            .where(Database.eq(PartTable.id, edit.partID))
            .get(),
          payloads: db
            .select({ hash: ColdStorageTable.hash, refs: ColdStorageTable.ref_count })
            .from(ColdStorageTable)
            .orderBy(ColdStorageTable.hash)
            .all(),
        }))
      const before = state()
      // aggregateStats 不经过 Session.messages，故完成后 owner 必须逐字段保持不变。
      expect(yield* aggregateStats()).toEqual(hot)
      expect(state()).toEqual(before)
      // v1 parity 由真实 current-copy CLI copy 单独验证，本 fixture 聚焦 hidden 与 v2 metadata-only path。
    }),
  )

  // page SQL 先选定一条 Message 再 hydrate；第二条只作为 next-page 范围之外的数据，不能被顺带 thaw。
  // 随后的显式 full-history Session.messages 保持原合同并恢复其余 owner，证明冷热选择由调用意图决定。
  it.instance("thaws only the requested Message page before an explicit full-history read", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionNs.Service
      const session = yield* sessions.create({ title: "bounded Message page" })
      const ids: PartID[] = []
      // 三条 Message 使用递增时间与 ID，最新一页选择不依赖 SQLite 未定义顺序。
      for (const index of [1, 2, 3]) {
        const messageID = MessageID.ascending()
        yield* sessions.updateMessage({
          id: messageID,
          sessionID: session.id,
          role: "assistant",
          parentID: MessageID.ascending(),
          modelID: ModelID.make("test-model"),
          providerID: ProviderID.make("test-provider"),
          mode: "build",
          agent: "build",
          path: { cwd: session.directory, root: session.directory },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: Date.now() + index, completed: Date.now() + index },
        })
        const partID = PartID.ascending()
        ids.push(partID)
        // 每条 reasoning 文本唯一且足够大，freeze 不会因 no-fields 或体积条件跳过。
        // Parts 属于不同 Messages，避免同 Message sibling grouping 把范围边界混淆。
        yield* sessions.updatePart({
          id: partID,
          sessionID: session.id,
          messageID,
          type: "reasoning",
          text: `bounded-${index}-`.repeat(512),
          time: { start: index, end: index + 1 },
        })
      }
      Database.use((db) =>
        db
          .update(SessionTable)
          .set({ time_updated: Date.now() - 31 * 24 * 60 * 60 * 1000 })
          .where(Database.eq(SessionTable.id, session.id))
          .run(),
      )
      ids.forEach((id) => expect(ColdStorage.freezeOwner({ type: "part", id }).type).toBe("frozen"))
      expect(coldOwnerCount([session.id])).toBe(3)

      // 测试不调用 thawOwner，所有恢复均由 MessageV2 public business seam 触发。
      const page = yield* MessageV2.page({ sessionID: session.id, limit: 1 })
      expect(page.items).toHaveLength(1)
      // page limit=1 同时断言 more=true，证明第二条仅作为范围探针而非被 hydrate 的 item。
      expect(page.more).toBe(true)
      // cold owner 数从 3 到 2 是持久预热范围的数据库证据，不断言内部 SQL 次数。
      expect(coldOwnerCount([session.id])).toBe(2)
      // explicit no-limit consumer 随后降到 0，保护 export/Revert 类完整历史合同。
      expect(yield* sessions.messages({ sessionID: session.id })).toHaveLength(3)
      // 原始文本可由完整 suite 的 Message round-trip覆盖，本例只锁定选择范围和 owner 生命周期。
      expect(coldOwnerCount([session.id])).toBe(0)
    }),
  )

  // completed Compaction 没有 tail_start_id 时 marker 本身就是兼容 cutoff，不能因缺少 tail 回退到完整 Session。
  // filterCompactedEffect 必须先查询 boundary 再 stream/hydrate，故旧 reasoning owner 在 routine prompt window 后仍为 cold。
  it.instance("keeps a no-tail compacted head cold while returning the retained window", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionNs.Service
      const session = yield* sessions.create({ title: "no-tail compacted boundary" })
      const oldUser = MessageID.ascending()
      yield* sessions.updateMessage({
        id: oldUser,
        sessionID: session.id,
        role: "user",
        time: { created: Date.now() },
        agent: "build",
        model: { providerID: ProviderID.make("test-provider"), modelID: ModelID.make("test-model") },
      })
      const oldAssistant = MessageID.ascending()
      yield* sessions.updateMessage({
        id: oldAssistant,
        sessionID: session.id,
        role: "assistant",
        parentID: oldUser,
        modelID: ModelID.make("test-model"),
        providerID: ProviderID.make("test-provider"),
        mode: "build",
        agent: "build",
        path: { cwd: session.directory, root: session.directory },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: Date.now() + 1, completed: Date.now() + 2 },
        finish: "stop",
      })
      const oldPart = PartID.ascending()
      yield* sessions.updatePart({
        id: oldPart,
        sessionID: session.id,
        messageID: oldAssistant,
        type: "reasoning",
        text: "compacted-head-".repeat(512),
        time: { start: 1, end: 2 },
      })
      // marker 与 finished summary Assistant 形成真实 durable pair，单独 marker 不足以建立 cutoff。
      const marker = MessageID.ascending()
      yield* sessions.updateMessage({
        id: marker,
        sessionID: session.id,
        role: "user",
        time: { created: Date.now() + 3 },
        agent: "build",
        model: { providerID: ProviderID.make("test-provider"), modelID: ModelID.make("test-model") },
      })
      // Compaction Part 故意不写 tail_start_id，复现 shipped compatibility 数据而非新 tail 形状。
      // 该无-tail案例与 tail_start_id 既有单测互补，防止 compatibility 分支被优化遗漏。
      yield* sessions.updatePart({
        id: PartID.ascending(),
        sessionID: session.id,
        messageID: marker,
        type: "compaction",
        auto: true,
      })
      const summary = MessageID.ascending()
      // summary 同时设置 summary、finish 与 completed，覆盖 boundary query 的全部完成条件。
      yield* sessions.updateMessage({
        id: summary,
        sessionID: session.id,
        role: "assistant",
        parentID: marker,
        modelID: ModelID.make("test-model"),
        providerID: ProviderID.make("test-provider"),
        mode: "build",
        agent: "build",
        path: { cwd: session.directory, root: session.directory },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: Date.now() + 4, completed: Date.now() + 5 },
        summary: true,
        finish: "stop",
      })
      // Session age 让 old owner 可冻结，但 boundary 选择仍由 completed Compaction 而非 age 决定。
      Database.use((db) =>
        db
          .update(SessionTable)
          .set({ time_updated: Date.now() - 31 * 24 * 60 * 60 * 1000 })
          .where(Database.eq(SessionTable.id, session.id))
          .run(),
      )
      expect(ColdStorage.freezeOwner({ type: "part", id: oldPart }).type).toBe("frozen")

      // filterCompactedEffect 是 routine prompt 实际 seam，不以纯 filterCompacted 数组测试替代 DB 范围行为。
      const window = yield* MessageV2.filterCompactedEffect(session.id)
      // expected 只含 marker 与 summary，若 cutoff 未应用就会多出 old user/assistant。
      expect(window.map((message) => message.info.id)).toEqual([marker, summary])
      // old reasoning 是唯一 cold owner；结果后仍为 1 可直接证明 head 未被业务 hydrate。
      expect(coldOwnerCount([session.id])).toBe(1)
    }),
  )

  // refcount 是 payload 与真实 owner 的完整性事实；projection 可解析也不能绕过这一 metadata gate。
  // Stats 和 Session.diff 均必须 hard-fail；Summary 可保留 crash-resume claim，但不能 repair archive 或提交 summary ref。
  it.instance("fails Stats and summary inspect on refcount drift without archive repair", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const sessions = yield* SessionNs.Service
      const session = yield* sessions.create({ title: "inspect refcount drift" })
      const edit = yield* addCompletedSummaryEdit(sessions, {
        sessionID: session.id,
        directory: test.directory,
        file: "src/integrity.ts",
        patch: "+integrity\n",
      })
      expect(
        ColdStorage.freezeOwner({ type: "part", id: edit.partID, now: Date.now() + 1_000, olderThanMs: 0 }).type,
      ).toBe("frozen")
      // Part ref 从真实 owner 行读取，测试不复制 content hash 或 pack identity 算法。
      const partRef = Database.use((db) =>
        db
          .select({ hash: PartTable.cold_ref })
          .from(PartTable)
          .where(Database.eq(PartTable.id, edit.partID))
          .get()?.hash,
      )
      if (!partRef) throw new Error("Integrity fixture did not create a cold Part owner")

      // drift 值 99 明显不同于真实 owner 数 1，避免与内容寻址共享引用偶然相等。
      Database.use((db) =>
        db.update(ColdStorageTable).set({ ref_count: 99 }).where(Database.eq(ColdStorageTable.hash, partRef)).run(),
      )
      // Stats failure 前 snapshot 包含完整 payload metadata 和 bytes，确保异常路径没有 repair 副作用。
      const state = () =>
        Database.use((db) => ({
          session: db
            .select({ ref: SessionTable.summary_ref, cursor: SessionTable.summary_cursor })
            .from(SessionTable)
            .where(Database.eq(SessionTable.id, session.id))
            .get(),
          part: db
            .select({ ref: PartTable.cold_ref, key: PartTable.cold_key, stats: PartTable.cold_stats })
            .from(PartTable)
            .where(Database.eq(PartTable.id, edit.partID))
            .get(),
          payloads: db.select().from(ColdStorageTable).orderBy(ColdStorageTable.hash).all(),
        }))
      const beforeStats = state()
      // v2 Stats 只能读取 cold_stats；错误投影不能触发 decodePack fallback 或成功报表。
      expect(Exit.isFailure(yield* Effect.exit(aggregateStats()))).toBe(true)
      expect(state()).toEqual(beforeStats)
      // 首次 Session.diff 必须 inspect 冷 Tool metadata；同一 refcount drift 不能比 Stats 更宽松。
      expect(Exit.isFailure(yield* Effect.exit(sessions.diff(session.id)))).toBe(true)
      const afterSummary = state()
      // claim 只记录已检查边界；Part owner 和损坏 payload 仍逐字段保持原样。
      expect(afterSummary.session).toEqual({ ref: null, cursor: edit.assistantID })
      expect(afterSummary.part).toEqual(beforeStats.part)
      expect(afterSummary.payloads).toEqual(beforeStats.payloads)

      // 恢复 Part 后先建立合法 summary，再单独破坏 Session ref 以隔离第二个 gate。
      Database.use((db) =>
        db.update(ColdStorageTable).set({ ref_count: 1 }).where(Database.eq(ColdStorageTable.hash, partRef)).run()
      )
      expect(yield* sessions.diff(session.id)).toHaveLength(1)
      const summaryRef = Database.use((db) =>
        db
          .select({ hash: SessionTable.summary_ref })
          .from(SessionTable)
          .where(Database.eq(SessionTable.id, session.id))
          .get()?.hash,
      )
      if (!summaryRef) throw new Error("Integrity fixture did not create a summary owner")
      Database.use((db) =>
        db.update(ColdStorageTable).set({ ref_count: 99 }).where(Database.eq(ColdStorageTable.hash, summaryRef)).run(),
      )
      const beforeSummary = state()
      // Session.diff 在无新 delta 时仍必须检查 referenced aggregate，不能把 unchanged 当作免检成功。
      expect(Exit.isFailure(yield* Effect.exit(sessions.diff(session.id)))).toBe(true)
      // repair 只属于显式 db verify --repair，本例普通读取没有修正损坏的授权。
      expect(state()).toEqual(beforeSummary)
    }),
  )

  // readiness 只在 mirror read 已进入后发布，此时 claim cursor 已先行持久化，mutation 必须在同一真实竞态窗口标 dirty。
  // 释放 read 后 stale bytes 仍会返回给 initializer，但 final immediate-state check 必须丢弃它并采用当前 Tool rows。
  // 首次和后续公开结果都用 literal replacement expected 验证，不断言内部 helper 或调用次数。
  raceIt.instance("discards a delayed stale mirror after a covered public Part replacement", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const gate = yield* MirrorReadGate
      const sessions = yield* SessionNs.Service
      const storage = yield* Storage.Service
      const session = yield* sessions.create({ title: "delayed dirty initialization" })
      const edit = yield* addCompletedSummaryEdit(sessions, {
        sessionID: session.id,
        directory: test.directory,
        file: "src/race.ts",
        patch: "+race-old\n",
      })
      // stale 文件在 release 时仍存在，成功不能归因于 NotFound compatibility branch。
      yield* storage.write(["session_diff", session.id], [
        { file: "src/stale-race.ts", patch: "+stale\n", additions: 30, deletions: 12, status: "modified" },
      ])

      // Storage wrapper 最终委托真实 filesystem read，Deferred 只控制顺序而不伪造 mirror 类型或内容。
      const first = yield* sessions.diff(session.id).pipe(Effect.forkChild)
      // readiness 替代固定 sleep，慢速 CI 也不会在 claim 尚未落盘时提前 mutation。
      yield* Deferred.await(gate.ready).pipe(Effect.timeout("5 seconds"))
      // replacement 与 claim 位于不同 transaction，真实模拟前端请求和后台初始化交错。
      yield* sessions.updatePart({
        id: edit.partID,
        sessionID: session.id,
        messageID: edit.assistantID,
        type: "tool",
        callID: "edit-race-replaced",
        tool: "edit",
        state: {
          status: "completed",
          input: {},
          output: "ok",
          title: "edit",
          metadata: {
            filediff: {
              file: path.join(test.directory, "src/race.ts"),
              patch: "+race-new\n",
              additions: 1,
              deletions: 0,
            },
          },
          time: { start: 0, end: 1 },
        },
      })
      yield* Deferred.succeed(gate.release, undefined)
      // expected 文件与 stale 文件不同，直接证明 final transaction 观察到了 dirty witness。
      const expected = [
        { file: "src/race.ts", patch: "+race-new\n", additions: 1, deletions: 0, status: "added" as const },
      ]
      expect(yield* Fiber.join(first)).toEqual(expected)
      // 第二次 public diff 证明 stale mirror 从未提交成 seed，不只是首个 fiber 临时返回正确。
      // test layer 只替换 Storage service，production 不增加 race hook 或延迟配置。
      expect(yield* sessions.diff(session.id)).toEqual(expected)
    }),
  )

  // claim ceiling 在外部 read 前持久化，但 Message 可由公开删除在等待期间消失；提交游标必须在 final transaction 重新取值。
  // 删除的 Tool 不能从 stale mirror 复活，且第二次读取不能因 ahead cursor 报错。
  raceIt.instance("commits the remaining closed boundary after deleting the claimed latest Message", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const gate = yield* MirrorReadGate
      const sessions = yield* SessionNs.Service
      const storage = yield* Storage.Service
      const session = yield* sessions.create({ title: "deleted initialization ceiling" })
      // 两个完整 Tool turns 使 captured ceiling 与删除后最大 closed boundary 必然不同。
      const firstEdit = yield* addCompletedSummaryEdit(sessions, {
        sessionID: session.id,
        directory: test.directory,
        file: "src/remains.ts",
        patch: "+remains\n",
      })
      const removedEdit = yield* addCompletedSummaryEdit(sessions, {
        sessionID: session.id,
        directory: test.directory,
        file: "src/removed.ts",
        patch: "+removed\n",
      })
      // mirror 包含即将删除的文件，若 initializer 信任 pre-I/O ceiling 会把 removed.ts 永久保存。
      yield* storage.write(["session_diff", session.id], [
        { file: "src/remains.ts", patch: "+remains\n", additions: 1, deletions: 0, status: "added" },
        { file: "src/removed.ts", patch: "+removed\n", additions: 1, deletions: 0, status: "added" },
      ])

      const pending = yield* sessions.diff(session.id).pipe(Effect.forkChild)
      yield* Deferred.await(gate.ready).pipe(Effect.timeout("5 seconds"))
      // public removeMessage 触发真实 projector、Part cascade 与 summary dirty，不直接修改 owner 表。
      // 只删除 latest Assistant，保留其 parent User，预期 cursor 因而可用独立 userID 字面事实断言。
      yield* sessions.removeMessage({ sessionID: session.id, messageID: removedEdit.assistantID })
      yield* Deferred.succeed(gate.release, undefined)
      // remaining Tool expected 来自第一轮 literal metadata，不读取 rebuild payload。
      const expected = [
        { file: "src/remains.ts", patch: "+remains\n", additions: 1, deletions: 0, status: "added" as const },
      ]
      // Deferred release 后 first fiber 必须完成，证明删除不会让 initialization CAS 永久卡住。
      expect(yield* Fiber.join(pending)).toEqual(expected)
      // second diff 防止超前 cursor 在下一轮才暴露“cursor ahead of history”错误。
      expect(yield* sessions.diff(session.id)).toEqual(expected)
      expect(
        Database.use((db) =>
          db
            .select({ cursor: SessionTable.summary_cursor })
            .from(SessionTable)
            .where(Database.eq(SessionTable.id, session.id))
            .get(),
        ),
      ).toEqual({ cursor: removedEdit.userID })
      // ID 比较断言证明保留 user 确实晚于 first Assistant，测试边界不是偶然等于旧 cursor。
      expect(firstEdit.assistantID < removedEdit.userID).toBe(true)
    }),
  )

  // 显式 vacuum 的用户可观察结果是 main+WAL 物理整理完成；只返回 page count 而留下完整 WAL 会伪报成功。
  // fixture 使用真实 SQLite 文件与公开 maintenance dispatcher，不 mock checkpoint 或文件长度。
  it.instance("truncates WAL before explicit vacuum reports success", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionNs.Service
      yield* sessions.create({ title: "vacuum WAL checkpoint" })
      // confirm=true 与 lease 同时提供，覆盖 production 对破坏性物理操作的双重授权门禁。
      // 本测试不执行自动 vacuum，只有显式 operation 才拥有 checkpoint/truncate 副作用。
      const result = yield* Effect.promise(() =>
        ColdStorage.maintain(ColdStorage.prepareMaintenance({ operation: "vacuum", confirm: true }), {
          lease: { assertOwned() {} },
          checkpoint: async () => {},
        }),
      )
      // maintenance dispatcher 仍返回原有 vacuum report，前端/CLI contract 没有新增字段。
      expect(result.type).toBe("vacuum")
      // 文件大小在 command 返回后读取，确保断言观察的是 terminal 状态而非并发 checkpoint 中间态。
      // current-scale 1.35 GB temp-copy gate另行证明同一逻辑在真实 WAL 模式清零大文件。
      const wal = Bun.file(`${Database.getPath()}-wal`)
      // WAL 不存在和零字节都视为成功，兼容 SQLite fixture 选择 DELETE/内存 journal 的情况。
      // 非零 WAL 直接失败，避免只看 pageCount 而忽略磁盘上第二份数据库。
      // checkpoint busy 时 production hard-fail，不能以测试环境通常无 reader 为理由吞掉失败。
      expect(yield* Effect.promise(async () => ((await wal.exists()) ? wal.size : 0))).toBe(0)
    }),
  )
})
