import { describe, expect } from "bun:test"
import { Effect, Exit, Layer } from "effect"
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

const it = testEffect(
  Layer.mergeAll(
    SessionNs.layer.pipe(
      Layer.provide(Bus.layer),
      Layer.provide(Storage.defaultLayer),
      Layer.provide(SyncEvent.defaultLayer),
      Layer.provide(RuntimeFlags.layer({ experimentalWorkspaces: false })),
      Layer.provide(BackgroundJob.defaultLayer),
    ),
    CrossSpawnSpawner.defaultLayer,
  ),
)

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

  // search 用例使用互不重叠的 input/output needle，明确区分允许索引与禁止索引的数据面。
  // tool input 常驻 projection，session list 应能按它定位会话而无需访问 cold blob。
  // tool output 和 provider metadata 都属于结果面，即使原文存在也不得污染 session 搜索。
  // output 被实际冻结且超过门槛，排除“搜索没命中只是测试没有冷数据”的假阳性。
  // 两次 list 后 owner 仍为 cold，证明 searchCondition 只执行 SQL 热投影，不调用 decoder。
  // 测试走 Session.list 公共接口，覆盖 TUI quick switch 实际使用的搜索路径。
  // 不断言标题搜索等既有行为，避免把本测试扩展成与冷存储无关的宽泛回归。
  // metadata 故意含 output needle，锁定 provider/internal metadata 同样不可进入结果。
  // input 匹配使用 JSON 叶子值而非键名，保留现有“搜值不搜 command 键”的契约。
  // 删除会话验证 search 只读操作没有制造额外 owner 或 payload。
  it.instance("searches hot tool identity and input without thawing cold output", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionNs.Service
      const session = yield* sessions.create({ title: "cold search" })
      const messageID = MessageID.ascending()
      const partID = PartID.ascending()
      const inputNeedle = "visible-search-input-unique"
      const outputNeedle = "hidden-search-output-unique"
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
      Database.use((db) =>
        db
          .update(SessionTable)
          .set({ time_updated: Date.now() - 31 * 24 * 60 * 60 * 1000 })
          .where(Database.eq(SessionTable.id, session.id))
          .run(),
      )
      expect(ColdStorage.freezeOwner({ type: "part", id: partID }).type).toBe("frozen")

      expect((yield* sessions.list({ search: inputNeedle })).some((item) => item.id === session.id)).toBe(true)
      expect((yield* sessions.list({ search: outputNeedle })).some((item) => item.id === session.id)).toBe(false)
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
      const hash = Database.use(
        (db) =>
          db.select({ hash: PartTable.cold_ref }).from(PartTable).where(Database.eq(PartTable.id, partID)).get()?.hash,
      )
      if (!hash) throw new Error("Expected a cold ref for verify test")
      Database.use((db) =>
        db.update(ColdStorageTable).set({ ref_count: 99 }).where(Database.eq(ColdStorageTable.hash, hash)).run(),
      )
      expect(ColdStorage.verify({ repair: false }).refCountMismatches).toBe(beforeVerify + 1)
      expect(ColdStorage.verify({ repair: true }).repaired).toBeGreaterThanOrEqual(1)
      expect(ColdStorage.verify({ repair: false }).refCountMismatches).toBe(beforeVerify)

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
