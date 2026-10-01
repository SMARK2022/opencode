import { expect } from "bun:test"
import { createHash } from "node:crypto"
import { Effect, Layer } from "effect"
import { eq } from "drizzle-orm"
import { ColdStorage } from "@/storage/cold"
import { Database } from "@/storage/db"
import { Session } from "@/session/session"
import { MessageV2 } from "@/session/message-v2"
import { MessageID, PartID } from "@/session/schema"
import { ModelID, ProviderID } from "@/provider/schema"
import { ColdStorageTable, MessageTable, PartTable } from "@/session/session.sql"
import { Bus } from "@/bus"
import { Storage } from "@/storage/storage"
import { SyncEvent } from "@/sync"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { BackgroundJob } from "@/background/job"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { testEffect } from "../lib/effect"

const it = testEffect(
  // 使用真实 Session/projector/数据库层，字段恢复错误能够穿透到公开读取结果。
  // fixture 负责实例隔离，本文件不连接用户正在运行的生产数据库。
  Layer.mergeAll(
    Session.layer.pipe(
      Layer.provide(Bus.layer),
      Layer.provide(Storage.defaultLayer),
      Layer.provide(SyncEvent.defaultLayer),
      Layer.provide(RuntimeFlags.layer({ experimentalWorkspaces: false })),
      Layer.provide(BackgroundJob.defaultLayer),
    ),
    Storage.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
  ),
)

it.instance("manual cold Text preserves complete reads and root Text", () =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const root = yield* sessions.create({ title: "cold v3 root" })
    const child = yield* sessions.create({ parentID: root.id, agent: "permission-reviewer" })
    const text = "review transcript 中文 % _\n".repeat(1024)
    // 字面量通配符与中文同时覆盖 SQL 子串语义，不能因冷冻改成 LIKE 模糊匹配。
    // 同样的正文分别放在根和子 Session，锁定搜索正文的冷冻边界。
    for (const session of [root, child]) {
      const messageID = MessageID.ascending()
      const id = PartID.ascending()
      yield* sessions.updateMessage({
        id: messageID,
        sessionID: session.id,
        role: "user",
        agent: "permission-reviewer",
        time: { created: 1 },
        model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test") },
      })
      yield* sessions.updatePart({ id, messageID, sessionID: session.id, type: "text", text })
      // eligibility 使用持久 chronology，而不是业务 JSON 中的 created 字段。
      Database.use((db) => db.update(MessageTable).set({ time_created: 1 }).where(eq(MessageTable.id, messageID)).run())
      const frozen = ColdStorage.freezeOwner({ type: "part", id, olderThanMs: 0 })
      expect(frozen.type).toBe(session.id === child.id ? "frozen" : "skipped")
      const before = Database.use((db) => db.select().from(PartTable).where(eq(PartTable.id, id)).get())
      const result = yield* MessageV2.get({ sessionID: session.id, messageID })
      expect(result.parts).toEqual([
        expect.objectContaining({ id, messageID, sessionID: session.id, type: "text", text }),
      ])
      // 查看返回完整值，同时保留持久冷态；显式 expand 才负责反向写回。
      expect(Database.use((db) => db.select().from(PartTable).where(eq(PartTable.id, id)).get())).toEqual(before)
      if (session.id === child.id) {
        expect((yield* sessions.list({ search: "中文 % _" })).some((item) => item.id === child.id)).toBe(true)
        // 完整读取之后再显式展开，区分返回值恢复和数据库持久恢复两个合同。
        expect(ColdStorage.thawOwner({ type: "part", id })).toBe(true)
        expect(Database.use((db) => db.select().from(PartTable).where(eq(PartTable.id, id)).get())?.cold_ref).toBeNull()
      }
    }
  }),
)

it.instance("compact packs retain full content and exact tool statistics", () =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const session = yield* sessions.create({})
    const messageID = MessageID.ascending()
    yield* sessions.updateMessage({
      id: messageID,
      sessionID: session.id,
      role: "user",
      agent: "build",
      time: { created: 1 },
      model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test") },
    })
    const id = PartID.ascending()
    const value = {
      // 固定名称、callID 和时间，完整对象相等同时保护用户要求常驻热表的身份字段。
      id,
      messageID,
      sessionID: session.id,
      type: "tool" as const,
      tool: "read",
      callID: "call-v3",
      state: {
        status: "completed" as const,
        input: {},
        output: "content".repeat(1000),
        title: "read",
        metadata: { exact: true },
        time: { start: 10, end: 20 },
      },
    }
    yield* sessions.updatePart(value)
    expect(ColdStorage.freezeOwner({ type: "part", id, olderThanMs: 0 }).type).toBe("frozen")
    const row = Database.use((db) => db.select().from(PartTable).where(eq(PartTable.id, id)).get())
    if (!row) throw new Error("Tool owner disappeared")
    // 检查存储定位开销，同时完整哈希校验仍由公开 verify 承担。
    expect(row.cold_key?.length).toBe(4)
    expect(row.cold_ref?.length).toBe(43)
    // {} 的 JSON 长度为 2，正文固定为 7000 字符，期望值独立于统计实现。
    expect(Database.use((db) => ColdStorage.inspectPartStats(db, [row]))).toEqual([
      { version: 1, type: "tool", inputChars: 2, outputChars: 7000 },
    ])
    expect((yield* MessageV2.get({ sessionID: session.id, messageID })).parts).toEqual([value])
    // verify 覆盖引用数和内容完整性，短 locator 不能以降低校验强度换取空间。
    expect(ColdStorage.verify({ repair: false })).toMatchObject({
      corruptOwners: 0,
      corruptPayloads: 0,
      refCountMismatches: 0,
    })
    // 构造已发布 v2 字节协议，验证维护命令会升级存量数据而非只处理新行。
    const packed = Database.use((db) => db.select().from(ColdStorageTable).all()[0])
    const fields = {
      // 直接给定旧协议字段，避免调用新 writer 生成旧格式而形成同源自证。
      "state.input": {},
      "state.metadata": { exact: true },
      "state.output": value.state.output,
      "state.title": "read",
    }
    const legacyKey = createHash("sha256").update("part\0").update(JSON.stringify(fields)).digest()
    // owner 前缀隔离 Message 与 Part；旧 frame 必须是真实可读的已发布格式。
    const raw = Buffer.from(
      JSON.stringify({ entries: [{ fields, key: legacyKey.toString("hex") }], owner: "part", version: 2 }),
    )
    const hash = createHash("sha256").update("part-pack\0").update(raw).digest("hex")
    const payload = Buffer.from(Bun.zstdCompressSync(raw))
    Database.transaction((db) => {
      // 先建立旧包再切引用，夹具也遵守 RESTRICT 外键及原子替换顺序。
      db.insert(ColdStorageTable)
        .values({ ...packed, hash, payload, raw_bytes: raw.length, compressed_bytes: payload.length })
        .run()
      db.update(PartTable).set({ cold_ref: hash, cold_key: legacyKey }).where(eq(PartTable.id, id)).run()
      db.delete(ColdStorageTable).where(eq(ColdStorageTable.hash, packed.hash)).run()
    })
    const prepared = ColdStorage.prepareMaintenance({
      operation: "compress",
      sessionID: session.id,
      olderThanMs: 0,
      batchSize: 10,
    })
    const controller = new AbortController()
    // 在已提交 payload checkpoint 中断，验证真正的恢复边界而非未开始的任务。
    const interrupted = yield* Effect.promise(() =>
      ColdStorage.maintain(prepared, {
        lease: { assertOwned() {} },
        signal: controller.signal,
        checkpoint: async (task) => {
          if (task.cursor && "stage" in task.cursor && task.cursor.lastHash) controller.abort()
        },
      }),
    )
    if (interrupted.type !== "task") throw new Error("Expected maintenance task")
    expect(interrupted.task.status).toBe("interrupted")
    // 通过公开持久 record parser 恢复，覆盖新 payload cursor 和重建后的引用索引。
    const task = ColdStorage.parseMaintenanceTask(interrupted.task)
    const resumed = yield* Effect.promise(() =>
      ColdStorage.maintain(prepared, {
        task,
        lease: { assertOwned() {} },
        checkpoint: async () => {},
      }),
    )
    expect(resumed.type === "task" && resumed.task.status).toBe("completed")
    // 恢复后的完整值再与原输入比较，成功状态本身不能证明迁移保真。
    expect(Database.use((db) => db.select().from(PartTable).where(eq(PartTable.id, id)).get())?.cold_key?.length).toBe(
      4,
    )
    expect((yield* MessageV2.get({ sessionID: session.id, messageID })).parts).toEqual([value])
    expect(ColdStorage.thawOwner({ type: "part", id })).toBe(true)
    expect(Database.use((db) => db.select().from(ColdStorageTable).all())).toHaveLength(0)
    // 最后一个 owner 展开后释放包，防止逻辑成功却遗留冗余冷内容。
  }),
)

it.instance("manual freeze admits a completed reviewer attempt in an active child", () =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const root = yield* sessions.create({})
    const child = yield* sessions.create({ parentID: root.id, agent: "permission-reviewer" })
    const request = MessageID.ascending()
    const breakdown = {
      system: 10,
      instructions: 20,
      skills: 0,
      tools: 30,
      messages: {
        userText: 40,
        assistantText: 0,
        reasoning: 0,
        toolInput: 0,
        toolOutput: 0,
        attachments: 0,
        total: 40,
      },
    }
    // 新 request 使用当前时间，确保该用例命中 completed-attempt 分支而非 24h 闲置。
    const reply = MessageID.ascending()
    const id = PartID.ascending()
    yield* sessions.updateMessage({
      id: request,
      sessionID: child.id,
      role: "user",
      agent: "permission-reviewer",
      time: { created: Date.now() },
      model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test") },
    })
    yield* sessions.updatePart({
      id,
      messageID: request,
      sessionID: child.id,
      type: "text",
      text: "completed review request",
      metadata: { permissionReviewerRequest: true, reviewID: "review-v3" },
    })
    expect(ColdStorage.freezeOwner({ type: "part", id }).type).toBe("skipped")
    // 请求已经存在还不足以冷冻，必须具备其关联执行的完成事实。
    // 仍在使用的 reviewer Session 可以包含已完成 attempt，资格按关联消息确定。
    yield* sessions.updateMessage({
      id: reply,
      sessionID: child.id,
      role: "assistant",
      parentID: request,
      agent: "permission-reviewer",
      mode: "permission-reviewer",
      path: { cwd: ".", root: "." },
      time: { created: Date.now(), completed: Date.now() },
      finish: "stop",
      cost: 0,
      tokens: { input: 12, output: 3, reasoning: 2, cache: { read: 4, write: 0 } },
      inputChars: 100,
      inputTokens: 25,
      inputBreakdown: breakdown,
      providerID: ProviderID.make("test"),
      modelID: ModelID.make("test"),
    })
    const toolID = PartID.ascending()
    // timeout 路径可能先写 assistant.completed 再收尾 Tool，锁住这个真实写入间隙。
    yield* sessions.updatePart({
      id: toolID,
      messageID: reply,
      sessionID: child.id,
      type: "tool",
      tool: "read",
      callID: "pending-review",
      state: { status: "running", input: {}, time: { start: 1 } },
    })
    expect(ColdStorage.freezeOwner({ type: "part", id }).type).toBe("skipped")
    yield* sessions.updatePart({
      id: toolID,
      messageID: reply,
      sessionID: child.id,
      type: "tool",
      tool: "read",
      callID: "pending-review",
      state: { status: "error", input: {}, error: "cancelled", time: { start: 1, end: 2 } },
    })
    expect(ColdStorage.freezeOwner({ type: "part", id }).type).toBe("frozen")
    const result = yield* MessageV2.get({ sessionID: child.id, messageID: request })
    expect(result.parts[0]).toMatchObject({ text: "completed review request", metadata: { reviewID: "review-v3" } })
    expect(ColdStorage.freezeOwner({ type: "message", id: reply }).type).toBe("frozen")
    const restored = yield* MessageV2.get({ sessionID: child.id, messageID: reply })
    expect(restored.info).toMatchObject({
      path: { cwd: ".", root: "." },
      tokens: { input: 12, output: 3, reasoning: 2 },
    })
    // TUI viewer 同样需要完整 assistant path，不能接收仅供内部 predicate 的 HotInfo。
    const page = yield* MessageV2.page({ sessionID: child.id, limit: 10, messageProjection: "viewer" })
    expect(page.items.find((item) => item.info.id === reply)?.info).toMatchObject({ path: { cwd: ".", root: "." } })
    // 搜索必须同时覆盖冷子正文与原有热字段，不能只验证根 Session。
    expect((yield* sessions.list({ search: "completed request" })).some((item) => item.id === child.id)).toBe(true)
    const fork = yield* sessions.fork({ sessionID: child.id })
    // 新 root 的正文必须可直接搜索，源 child 仍可保留自己的冷引用。
    expect(
      (yield* sessions.list({ search: "completed request", roots: true })).some((item) => item.id === fork.id),
    ).toBe(true)
    // 按 reviewer 的真实调用顺序隐藏完成 attempt，冷诊断字段必须随完整 Info 保留。
    const hidden = { time: Date.now(), reason: "permission-reviewer-protocol-retry" as const }
    yield* sessions.updateMessage({ ...result.info, hidden })
    yield* sessions.updateMessage({ ...restored.info, hidden })
    const hiddenReply = yield* MessageV2.get({ sessionID: child.id, messageID: reply, includeHidden: true })
    expect(hiddenReply.info).toEqual({ ...restored.info, hidden })
    expect(hiddenReply.info).toMatchObject({ inputChars: 100, inputTokens: 25, inputBreakdown: breakdown })
    expect((yield* MessageV2.page({ sessionID: child.id, limit: 10 })).items).toHaveLength(0)
    const text = result.parts.find((part) => part.type === "text")
    if (!text) throw new Error("Reviewer request Text missing")
    // 冷 Text 的完整 replacement 释放旧引用，同时保留 reviewID 等业务 metadata。
    yield* sessions.updatePart({ ...text, text: "revised reviewer request" })
    const revised = yield* MessageV2.get({ sessionID: child.id, messageID: request, includeHidden: true })
    expect(revised.parts).toContainEqual({ ...text, text: "revised reviewer request" })
    expect(ColdStorage.verify({ repair: false })).toMatchObject({
      corruptOwners: 0,
      corruptPayloads: 0,
      refCountMismatches: 0,
    })
  }),
)

it.instance("resumed repack retains every destination until all owners move", () =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const session = yield* sessions.create({ title: "repack destination cycle" })
    const messageID = MessageID.ascending()
    yield* sessions.updateMessage({
      id: messageID,
      sessionID: session.id,
      role: "user",
      agent: "build",
      time: { created: 1 },
      model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test") },
    })
    const fields = (output: string) => ({
      "state.input": {},
      "state.metadata": {},
      "state.output": output,
      "state.title": "cycle regression",
    })
    const x = fields("cycle-x-0"),
      y = fields("cycle-y-0")
    const digest = (owner: string, value: object) =>
      createHash("sha256")
        .update(owner + "\0")
        .update(JSON.stringify(value))
        .digest()
    const pack = (entries: ReturnType<typeof fields>[]) => {
      const sorted = entries.toSorted((a, b) => Buffer.compare(digest("part", a), digest("part", b)))
      const raw = Buffer.from(JSON.stringify({ entries: sorted, owner: "part", version: 3 }))
      const hash = createHash("sha256").update("part-pack\0").update(raw).digest("base64url")
      return { entries: sorted, hash, raw, payload: Buffer.from(Bun.zstdCompressSync(raw)) }
    }
    const p = pack([x, y]),
      q = pack([x]),
      r = pack([y])
    expect(p.hash < q.hash).toBe(true)
    const checkpointID = PartID.ascending()
    yield* sessions.updatePart({
      id: checkpointID,
      messageID,
      sessionID: session.id,
      type: "tool",
      tool: "read",
      callID: "checkpoint",
      state: {
        status: "completed",
        input: {},
        output: "checkpoint-29",
        title: "cycle regression",
        metadata: {},
        time: { start: 1, end: 2 },
      },
    })
    ColdStorage.freezeOwner({ type: "part", id: checkpointID, olderThanMs: 0 })
    const prepared = ColdStorage.prepareMaintenance({
      operation: "compress",
      sessionID: session.id,
      olderThanMs: 0,
      batchSize: 10,
    })
    const controller = new AbortController()
    // 先运行真实批次取得 checkpoint，再通过正常删除形成已释放的旧输入包。
    const interrupted = yield* Effect.promise(() =>
      ColdStorage.maintain(prepared, {
        lease: { assertOwned() {} },
        signal: controller.signal,
        checkpoint: async (task) => {
          if (task.cursor && "stage" in task.cursor && task.cursor.lastHash) controller.abort()
        },
      }),
    )
    if (interrupted.type !== "task" || !interrupted.task.cursor || !("stage" in interrupted.task.cursor))
      throw new Error("Missing payload checkpoint")
    expect(interrupted.task.status).toBe("interrupted")
    expect(interrupted.task.cursor.lastHash < p.hash).toBe(true)
    yield* sessions.removePart({ sessionID: session.id, messageID, partID: checkpointID })
    // P 中 x 已无 owner；这与正常删除一个共享包 owner 后的持久状态一致。
    // 插入顺序 Q/P/R 让恢复索引选择 x->P、y->R，输入 hash 顺序则先搬走 P 的 y。
    // 只描述合法持久布局，不调用被测重打包函数来生成预期目的关系。
    const records = [
      { pack: q, value: x },
      { pack: p, value: y },
      { pack: r, value: y },
    ]
    for (const record of records) {
      const id = PartID.ascending()
      const value = {
        id,
        messageID,
        sessionID: session.id,
        type: "tool" as const,
        tool: "read",
        callID: id,
        state: {
          status: "completed" as const,
          input: {},
          output: record.value["state.output"],
          title: "cycle regression",
          metadata: {},
          time: { start: 1, end: 2 },
        },
      }
      yield* sessions.updatePart(value)
      const slot = Buffer.alloc(4)
      slot.writeUInt32LE(record.pack.entries.indexOf(record.value))
      Database.transaction((db) => {
        db.insert(ColdStorageTable)
          .values({
            hash: record.pack.hash,
            kind: "part-pack",
            codec: "zstd",
            payload: record.pack.payload,
            raw_bytes: record.pack.raw.length,
            compressed_bytes: record.pack.payload.length,
            ref_count: 1,
            time_created: 1,
            time_updated: 1,
          })
          .run()
        db.update(PartTable)
          .set({
            data: { type: "tool", tool: "read", callID: id, state: { ...value.state, output: "", title: "" } },
            cold_ref: record.pack.hash,
            cold_key: slot,
            cold_stats: [2, 0, 2, value.state.output.length],
          })
          .where(eq(PartTable.id, id))
          .run()
      })
    }
    expect(ColdStorage.verify({ repair: false })).toMatchObject({
      corruptOwners: 0,
      corruptPayloads: 0,
      refCountMismatches: 0,
    })
    // 原始任务参数和实际持久 cursor 原样恢复，不伪造进度或修改 Session scope。
    const task = ColdStorage.parseMaintenanceTask(interrupted.task)
    const result = yield* Effect.promise(() =>
      ColdStorage.maintain(prepared, { task, lease: { assertOwned() {} }, checkpoint: async () => {} }),
    )
    expect(result.type === "task" && result.task.status).toBe("completed")
    const message = yield* MessageV2.get({ sessionID: session.id, messageID })
    expect(
      message.parts.flatMap((part) =>
        part.type === "tool" && part.state.status === "completed" ? [part.state.output] : [],
      ),
    ).toEqual(["cycle-x-0", "cycle-y-0", "cycle-y-0"])
    expect(ColdStorage.verify({ repair: false })).toMatchObject({
      corruptOwners: 0,
      corruptPayloads: 0,
      refCountMismatches: 0,
    })
  }),
)
