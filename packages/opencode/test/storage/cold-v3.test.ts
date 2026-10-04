import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { Worker } from "node:worker_threads"
import { Effect, Layer } from "effect"
import { eq, sql } from "drizzle-orm"
import { ColdStorage } from "@/storage/cold"
import { ColdMaintain } from "@/storage/cold-maintain"
import { ColdCodec } from "@/storage/cold-codec"
import { Database } from "@/storage/db"
import { Session } from "@/session/session"
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

// CI core 分片单进程跑 integration+runtime 全部文件，test/preload.ts 把 OPENCODE_DB 设为 :memory:，
// 因此本文件与其他文件共享同一个内存库；全库绝对零断言会被他文件的遗留漂移误红（Linux/macOS CI 实测）。
// 与 cold.test.ts 的 beforeVerify 范式一致：断言只针对本用例造成的增量。
function verifyBaseline() {
  return ColdStorage.verify({ repair: false })
}

function expectVerifyDelta(baseline: ReturnType<typeof ColdStorage.verify>) {
  const current = ColdStorage.verify({ repair: false })
  expect(current.corruptOwners - baseline.corruptOwners).toBe(0)
  expect(current.corruptPayloads - baseline.corruptPayloads).toBe(0)
  expect(current.refCountMismatches - baseline.refCountMismatches).toBe(0)
}

function payloadHashes() {
  return new Set(
    Database.use((db) => db.select({ hash: ColdStorageTable.hash }).from(ColdStorageTable).all()).map(
      (row) => row.hash,
    ),
  )
}

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

test("cold worker completes a batch with more than 128 source packs", async () => {
  // 同一模块既供正常 import，也作线程入口；workerData 明确选择专属消息处理器。
  const worker = new Worker(new URL("../../src/storage/cold-codec.ts", import.meta.url), {
    workerData: "opencode-cold-codec",
  })
  // 同一真实 worker 持有超过旧缓存阈值的在飞源；每个包很小，专门锁定生命周期而非吞吐。
  const send = (id: number, input: unknown) =>
    new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`worker stalled at source ${id}`)), 5000)
      worker.once("message", (message: { id: number; error?: string }) => {
        clearTimeout(timer)
        if (message.error) return reject(new Error(message.error))
        expect(message.id).toBe(id)
        resolve()
      })
      worker.postMessage({ id, op: "scan", input })
    })
  try {
    for (let id = 0; id < 129; id++) {
      // 每次改变正文得到不同地址，防止同hash覆盖掩盖旧缓存阈值问题。
      const raw = Buffer.from(JSON.stringify({ entries: [{ text: String(id) }], owner: "part", version: 3 }))
      const payload = Bun.zstdCompressSync(raw)
      await send(id, {
        hash: createHash("sha256").update("part-pack\0").update(raw).digest("base64url"),
        owner: "part",
        pack: { payload, raw_bytes: raw.length, compressed_bytes: payload.length },
        rows: [],
      })
    }
  } finally {
    await worker.terminate()
  }
}, 15000)

test("encoder isolates identical source handles and settles close", async () => {
  const encoder = ColdCodec.createPackEncoder()
  const raw = Buffer.from(JSON.stringify({ entries: [{ text: "same body" }], owner: "part", version: 3 }))
  const hash = createHash("sha256").update("part-pack\0").update(raw).digest("base64url")
  const payload = Bun.zstdCompressSync(raw)
  const input = {
    hash,
    owner: "part" as const,
    pack: { payload, raw_bytes: raw.length, compressed_bytes: payload.length },
    rows: [],
  }
  try {
    // 内容身份相同也有独立生命周期；释放第一次请求不能破坏第二次扫描的正文。
    const first = await encoder.call("scan", input)
    const second = await encoder.call("scan", input)
    expect(first.handle).not.toBe(second.handle)
    await encoder.call("drop", { handle: first.handle })
    const encoded = await encoder.call("encode", {
      hash,
      handle: second.handle,
      owner: "part",
      chunks: [second.entries.map((e) => e.key)],
    })
    expect(Buffer.from(Bun.zstdDecompressSync(encoded.packs[0].payload))).toEqual(raw)
    // 已释放句柄保持失效，同内容的新扫描不能重新激活它。
    await expect(
      encoder.call("encode", { hash, handle: first.handle, owner: "part", chunks: [first.entries.map((e) => e.key)] }),
    ).rejects.toThrow("cache miss")
    const summaryRaw = Buffer.from(JSON.stringify({ fields: { delta: [] }, owner: "session-summary", version: 2 }))
    const summaryPayload = Bun.zstdCompressSync(summaryRaw)
    const corruptSummary = {
      kind: "session-summary" as const,
      hash: "0".repeat(64),
      payload: summaryPayload,
      raw_bytes: summaryRaw.length,
      compressed_bytes: summaryPayload.length,
    }
    // 合法 JSON 也不能绕过内容身份校验；重编码损坏摘要应在写入之前失败。
    await expect(encoder.call("recode", corruptSummary)).rejects.toThrow("hash")
  } finally {
    await encoder.close()
  }
  // 晚到调用也不能在已结束的维护中重新启动线程。
  await expect(encoder.call("scan", input)).rejects.toThrow("closed")
}, 15000)

test("exclusive encoding preserves large canonical content and identity", async () => {
  const encoder = ColdCodec.createPackEncoder()
  // 单个完整字段越过普通源预算，验证真实原生编码帧仍遵守原有内容身份。
  // 字面协议由测试独立构造，回读期望不依赖被测writer生成。
  const raw = Buffer.from(
    JSON.stringify({
      entries: [{ text: "bounded native zstd ".repeat(520000) }],
      owner: "part",
      version: 3,
    }),
  )
  const hash = createHash("sha256").update("part-pack\0").update(raw).digest("base64url")
  const payload = Bun.zstdCompressSync(raw, { level: 1 })
  const input = {
    hash,
    owner: "part" as const,
    pack: {
      payload,
      raw_bytes: raw.length,
      compressed_bytes: payload.length,
    },
    rows: [],
  }
  try {
    const scan = await encoder.call("scan", input)
    // 两种预算使用同一次已验证扫描，比较执行方式时保持输入完全一致。
    for (const exclusive of [false, true]) {
      const encoded = await encoder.call(
        "encode",
        {
          hash,
          handle: scan.handle,
          owner: "part",
          chunks: [scan.entries.map((entry) => entry.key)],
        },
        [],
        exclusive,
      )
      expect(encoded.packs[0].hash).toBe(hash)
      expect(Buffer.from(encoded.packs[0].raw)).toEqual(raw)
      expect(Buffer.from(Bun.zstdDecompressSync(encoded.packs[0].payload))).toEqual(raw)
      const recoded = await encoder.call("recode", { kind: "part-pack", hash, ...input.pack }, [], exclusive)
      // 断言解压后的业务字节；线程参数允许产生不同的标准压缩帧。
      expect(Buffer.from(Bun.zstdDecompressSync(recoded))).toEqual(raw)
    }
    await encoder.call("drop", { handle: scan.handle })
  } finally {
    await encoder.close()
  }
}, 20000)

test("cold canonical identity keeps Unicode code-point order", () => {
  // U+E000 在码点序中早于 U+10000，普通 UTF-16 sort 的结果相反。
  expect(ColdCodec.canonical({ "\u{10000}": 1, "\ue000": 2, a: { z: 3, a: 4 } })).toBe(
    '{"a":{"a":4,"z":3},"\ue000":2,"\u{10000}":1}',
  )
})

for (const action of ["preserve", "update", "delete", "activity", "cancel"] as const)
  it.instance(`first freeze keeps progress responsive (${action})`, () =>
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
      const value = {
        id: PartID.ascending(),
        messageID,
        sessionID: session.id,
        type: "tool" as const,
        tool: "read",
        callID: "first-freeze",
        // 使用普通已完成Tool触发真实抽取，验证线程路径而不是伪造冷包状态。
        state: {
          status: "completed" as const,
          input: {},
          output: "content".repeat(1000),
          title: "read",
          metadata: {},
          time: { start: 1, end: 2 },
        },
      }
      yield* sessions.updatePart(value)
      // 根Session的资格使用持久活跃时间，与Message业务JSON里的时间分别控制。
      Database.use((db) =>
        db.update(SessionTable).set({ time_updated: 1 }).where(eq(SessionTable.id, session.id)).run(),
      )
      const controller = new AbortController()
      let mutation: ReturnType<typeof setTimeout> | undefined
      let changed = false
      let ticks = 0
      // 这里只验证事件循环仍有调度机会，tick数量不是压缩吞吐基准。
      const timer = setInterval(() => ticks++, 1)
      try {
        const result = yield* Effect.promise(() =>
          ColdMaintain.maintain(
            ColdMaintain.prepareMaintenance({
              operation: "compress",
              sessionID: session.id,
              olderThanMs: 7 * 24 * 60 * 60 * 1000,
              batchSize: 10,
            }),
            {
              lease: { assertOwned() {} },
              signal: controller.signal,
              checkpoint: async (task) => {
                // 在Part阶段首次扫描前安排一次变化，避免后续checkpoint重复写入夹具。
                if (
                  action === "preserve" ||
                  mutation ||
                  !task.cursor ||
                  !("owner" in task.cursor) ||
                  task.cursor.owner !== "part" ||
                  task.cursor.lastID
                )
                  return
                // 阶段发布后安排真实写入，异步编码让写入发生于快照与提交之间。
                mutation = setTimeout(() => {
                  changed = true
                  if (action === "cancel") {
                    // 取消复用真实AbortSignal，已算出的结果应在写入前被放弃。
                    controller.abort()
                    return
                  }
                  Database.use((db) => {
                    if (action === "delete") {
                      // 真正删除行，能捕获把旧快照误当成upsert输入的回归。
                      db.delete(PartTable).where(eq(PartTable.id, value.id)).run()
                      return
                    }
                    if (action === "activity") {
                      // owner内容保持原样，单独检验Session重新活跃后的资格复核。
                      db.update(SessionTable)
                        .set({ time_updated: Date.now() })
                        .where(eq(SessionTable.id, session.id))
                        .run()
                      return
                    }
                    // 显式同列赋值覆盖Drizzle的onUpdate，确保此替换确实保留快照时间。
                    db.update(PartTable)
                      .set({
                        time_updated: PartTable.time_updated,
                        data: {
                          type: "tool",
                          tool: value.tool,
                          callID: value.callID,
                          state: { ...value.state, output: "updated output" },
                        },
                      })
                      .where(eq(PartTable.id, value.id))
                      .run()
                  })
                }, 0)
              },
            },
          ),
        )
        expect(result.type === "task" && result.task.status).toBe(action === "cancel" ? "interrupted" : "completed")
      } finally {
        // 清理调度器，使共享测试进程中的下一条用例不接收本条的延迟写入。
        clearInterval(timer)
        if (mutation) clearTimeout(mutation)
      }
      expect(ticks).toBeGreaterThan(0)
      if (action !== "preserve") {
        expect(changed).toBe(true)
        const row = Database.use((db) => db.select().from(PartTable).where(eq(PartTable.id, value.id)).get())
        // 删除保持缺行，其余变化保持热态；两者都不能被旧编码结果重新覆盖。
        expect(row?.cold_ref ?? null).toBeNull()
      }
      // 完整公开读取同时保护 Tool 身份、状态、时间与冷字段的对应关系。
      expect((yield* MessageV2.get({ sessionID: session.id, messageID })).parts).toEqual(
        action === "delete"
          ? []
          : [action === "update" ? { ...value, state: { ...value.state, output: "updated output" } } : value],
      )
    }),
  )

it.instance("explicit recompress reduces an existing frame and preserves owner identity", () =>
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
    const value = {
      id: PartID.ascending(),
      messageID,
      sessionID: session.id,
      type: "tool" as const,
      tool: "read",
      callID: "existing-frame",
      state: {
        status: "completed" as const,
        input: {},
        // 有重复也有变化的文本使两种编码级别产生可观察的空间差异。
        output: Array.from(
          { length: 2048 },
          (_, i) => `record ${i % 97}: source ${i % 43} result ${i % 71} repeated body for file inspection\n`,
        ).join(""),
        title: "read",
        metadata: {},
        time: { start: 1, end: 2 },
      },
    }
    yield* sessions.updatePart(value)
    ColdStorage.freezeOwner({ type: "part", id: value.id, olderThanMs: 0 })
    const owner = Database.use((db) => db.select().from(PartTable).where(eq(PartTable.id, value.id)).get())
    if (!owner?.cold_ref) throw new Error("Expected a frozen owner")
    const before = Database.use((db) =>
      db
        .select()
        .from(ColdStorageTable)
        .where(eq(ColdStorageTable.hash, owner.cold_ref ?? ""))
        .get(),
    )
    if (!before) throw new Error("Expected its cold frame")
    // 保留真实 v3 身份，仅将压缩帧设为已有低级别形态，普通 compress 会跳过该干净包。
    const raw = Bun.zstdDecompressSync(before.payload)
    const older = Buffer.from(Bun.zstdCompressSync(raw, { level: 1 }))
    // 明确检验夹具前提，避免把“保留更小旧帧”误认成重压缩实现失效。
    expect(before.compressed_bytes).toBeLessThan(older.length)
    Database.use((db) =>
      db
        .update(ColdStorageTable)
        // 只替换编码表示，基线时间仍用于检测维护是否意外标记了业务更新。
        .set({ payload: older, compressed_bytes: older.length, time_updated: before.time_updated })
        .where(eq(ColdStorageTable.hash, before.hash))
        .run(),
    )
    const request = ColdMaintain.parseMaintenanceRequest({
      operation: "compress",
      sessionID: session.id,
      olderThanMs: 0,
      batchSize: 10,
      recompress: true,
    })
    const prepared = ColdMaintain.prepareMaintenance(request)
    if (prepared.type !== "task") throw new Error("Expected a persistent compression task")
    // 恢复后的请求保持显式范围，旧任务缺少该字段时仍按原范围处理。
    const restoredTask = ColdMaintain.parseMaintenanceTask(prepared.task)
    expect(restoredTask.args).toMatchObject({ recompress: true })
    // 控制面JSON中的字符串不能被当成显式扩大维护范围的授权。
    expect(() => ColdMaintain.parseMaintenanceRequest({ ...request, recompress: "true" })).toThrow("boolean")
    yield* Effect.promise(() =>
      ColdMaintain.maintain(prepared, {
        task: restoredTask,
        lease: { assertOwned() {} },
        checkpoint: async () => {},
      }),
    )
    const after = Database.use((db) =>
      db.select().from(ColdStorageTable).where(eq(ColdStorageTable.hash, before.hash)).get(),
    )
    if (!after) throw new Error("Expected retained content identity")
    expect(after.compressed_bytes).toBeLessThan(older.length)
    expect(Buffer.from(Bun.zstdDecompressSync(after.payload))).toEqual(Buffer.from(raw))
    // 帧替换仅改变字节存储，owner 的定位、时间和同行统计保持原样。
    expect(Database.use((db) => db.select().from(PartTable).where(eq(PartTable.id, value.id)).get())).toEqual(owner)
    // 同一帧的所有引用者共享原位更新，逐owner迁移会破坏这条计数与定位合同。
    expect(after.ref_count).toBe(before.ref_count)
    expect(after.time_updated).toBe(before.time_updated)
    expect((yield* MessageV2.get({ sessionID: session.id, messageID })).parts).toEqual([value])
    // 第二次真实运行覆盖无收益结果，和第一次缩小帧的分支分别验证。
    const repeated = yield* Effect.promise(() =>
      ColdMaintain.maintain(ColdMaintain.prepareMaintenance(request), {
        lease: { assertOwned() {} },
        checkpoint: async () => {},
      }),
    )
    // 已达到本策略密度的帧保留原字节，报告将它计为已检查且跳过的 owner。
    expect(repeated.type === "task" && repeated.task.processed).toBe(1)
    expect(repeated.type === "task" && repeated.task.skipped).toBe(1)
    expect(
      Database.use((db) => db.select().from(ColdStorageTable).where(eq(ColdStorageTable.hash, after.hash)).get()),
    ).toEqual(after)
  }),
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
      if (session.id === root.id) {
        const totals: number[] = []
        // 年龄0也保留root搜索正文，维护应在读取候选时直接排除它。
        const maintenance = yield* Effect.promise(() =>
          ColdMaintain.maintain(
            ColdMaintain.prepareMaintenance({
              operation: "compress",
              sessionID: root.id,
              olderThanMs: 0,
              batchSize: 10,
            }),
            {
              lease: { assertOwned() {} },
              checkpoint: async (task) => {
                if (task.progress?.stage === "owner") totals.push(task.progress.total)
              },
            },
          ),
        )
        // 工作量与展示分母同时为零，不能逐行处理后只报告skipped。
        expect(maintenance.type === "task" && maintenance.task.processed).toBe(0)
        expect(totals.length).toBeGreaterThan(0)
        expect(totals.every((total) => total === 0)).toBe(true)
      }
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

for (const scoped of [false, true])
  it.instance(`repack preserves carried data beside a merged owner (scoped=${scoped})`, () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ title: "mixed merge and carry" })
      // 同一个包同时覆盖范围内外owner，才能检验共享引用与Session过滤的配合。
      const carriedSession = scoped ? yield* sessions.create({ title: "shared source outside scope" }) : session
      const userID = MessageID.ascending()
      const assistantID = MessageID.ascending()
      const user = {
        id: userID,
        sessionID: carriedSession.id,
        role: "user" as const,
        agent: "build",
        time: { created: 1 },
        summary: { title: "carried summary", body: "body remains intact", diffs: [] },
        // carry读取须保持全部热字段，不能只验证冷字段是否仍存在。
        model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test") },
      }
      const assistant = {
        id: assistantID,
        parentID: userID,
        sessionID: session.id,
        role: "assistant" as const,
        agent: "build",
        mode: "build",
        path: { cwd: "mixed-cwd", root: "mixed-root" },
        // 完成态配合显式年龄0，让assistant的诊断字段进入本次merge。
        time: { created: 1, completed: 2 },
        finish: "stop",
        cost: 0,
        tokens: { input: 5, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
        providerID: ProviderID.make("test"),
        modelID: ModelID.make("test"),
      }
      yield* sessions.updateMessage(user)
      yield* sessions.updateMessage(assistant)
      // 一个 legacy 源内既有待 merge 的 assistant，又有原样进位的 user。
      // 两行进入同一目标包，维护必须只缩减 assistant 的投影而保留 user 原值。
      const key = createHash("sha256").update("message\0{}").digest()
      const userFields = { "summary.diffs": [] }
      // 从字面字段计算旧格式键，不用当前writer替测试生成迁移输入。
      const userKey = createHash("sha256").update("message\0").update(JSON.stringify(userFields)).digest()
      const entries = [
        { fields: {}, key: key.toString("hex") },
        { fields: userFields, key: userKey.toString("hex") },
      ].sort((a, b) => a.key.localeCompare(b.key))
      const raw = Buffer.from(JSON.stringify({ entries, owner: "message", version: 2 }))
      const hash = createHash("sha256").update("message-pack\0").update(raw).digest("hex")
      const payload = Buffer.from(Bun.zstdCompressSync(raw))
      Database.transaction((db) => {
        db.insert(ColdStorageTable)
          .values({
            hash,
            kind: "message-pack",
            codec: "zstd",
            payload,
            raw_bytes: raw.length,
            compressed_bytes: payload.length,
            ref_count: 2,
            time_created: 1,
            time_updated: 1,
          })
          .run()
        for (const id of [userID, assistantID])
          db.update(MessageTable)
            .set({ cold_ref: hash, cold_key: id === userID ? userKey : key })
            .where(eq(MessageTable.id, id))
            .run()
      })
      const result = yield* Effect.promise(() =>
        ColdMaintain.maintain(
          ColdMaintain.prepareMaintenance({
            operation: "compress",
            sessionID: session.id,
            olderThanMs: 0,
            batchSize: 10,
          }),
          {
            lease: { assertOwned() {} },
            checkpoint: async (task) => {
              // 预取不是完成：首个 payload cursor 落盘之前，完成包数必须保持零。
              if (task.progress?.stage === "payload" && task.cursor && "stage" in task.cursor && !task.cursor.lastHash)
                expect(task.progress.done).toBe(0)
            },
          },
        ),
      )
      expect(result.type === "task" && result.task.status).toBe("completed")
      // session 范围只搬选中的 owner；共享源的其他引用不是并发变更，不能令本次维护空跑。
      expect(result.type === "task" && result.task.processed).toBe(scoped ? 1 : 2)
      // 分别经各自Session的公开入口读取，防止只恢复了范围内那一行。
      expect((yield* MessageV2.get({ sessionID: carriedSession.id, messageID: userID })).info).toEqual(user)
      expect((yield* MessageV2.get({ sessionID: session.id, messageID: assistantID })).info).toEqual(assistant)
    }),
  )

it.instance("repack includes envelope bytes at the pack size boundary", () =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const session = yield* sessions.create({})
    // 两个字段 JSON 刚好合计 1MiB；包头与分隔符使其必须分成两包。
    // 用真实 legacy 输入经过维护接口，验证最终字节边界和完整恢复，而不是私有分块函数。
    const messages = ["a", "b"].map((character) => ({
      id: MessageID.ascending(),
      parentID: MessageID.ascending(),
      sessionID: session.id,
      role: "assistant" as const,
      agent: "build",
      mode: "build",
      // 29是空path字段对象的JSON字节壳，两个正文各自补足半MiB。
      path: { cwd: "", root: character.repeat(524288 - 29) },
      time: { created: 1, completed: 2 },
      finish: "stop",
      cost: 0,
      tokens: { input: 5, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
      providerID: ProviderID.make("test"),
      modelID: ModelID.make("test"),
    }))
    const entries = messages.map((message) => {
      const fields = { path: message.path }
      return { fields, key: createHash("sha256").update("message\0").update(JSON.stringify(fields)).digest("hex") }
    })
    const raw = Buffer.from(
      JSON.stringify({
        // v2按显式摘要排序，messages保留原顺序并用各自键建立正确引用。
        entries: [...entries].sort((a, b) => a.key.localeCompare(b.key)),
        owner: "message",
        version: 2,
      }),
    )
    const hash = createHash("sha256").update("message-pack\0").update(raw).digest("hex")
    const payload = Buffer.from(Bun.zstdCompressSync(raw))
    for (const message of messages) yield* sessions.updateMessage(message)
    Database.transaction((db) => {
      db.insert(ColdStorageTable)
        .values({
          hash,
          kind: "message-pack",
          codec: "zstd",
          payload,
          raw_bytes: raw.length,
          compressed_bytes: payload.length,
          ref_count: 2,
          time_created: 1,
          time_updated: 1,
        })
        .run()
      for (const [index, message] of messages.entries()) {
        db.update(MessageTable)
          .set({
            // 热投影移去path，完整读取必须确实从旧包恢复它。
            data: sql`json_remove(${MessageTable.data}, '$.path')`,
            cold_ref: hash,
            cold_key: Buffer.from(entries[index].key, "hex"),
          })
          .where(eq(MessageTable.id, message.id))
          .run()
      }
    })
    yield* Effect.promise(() =>
      ColdMaintain.maintain(
        ColdMaintain.prepareMaintenance({
          operation: "compress",
          sessionID: session.id,
          olderThanMs: 0,
          batchSize: 10,
        }),
        { lease: { assertOwned() {} }, checkpoint: async () => {} },
      ),
    )
    const refs = Database.use((db) =>
      db.select({ ref: MessageTable.cold_ref }).from(MessageTable).where(eq(MessageTable.session_id, session.id)).all(),
    )
    expect(new Set(refs.map((row) => row.ref)).size).toBe(2)
    // 分包数之外还验证完整对象，避免用丢弃字段的方式满足大小断言。
    for (const message of messages)
      expect((yield* MessageV2.get({ sessionID: session.id, messageID: message.id })).info).toEqual(message)
  }),
)

it.instance("compact packs retain full content and exact tool statistics", () =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const verifyBase = verifyBaseline()
    // 全库为空断言只在单租户库成立；共享内存库下断言本用例结束后没有新增遗留 hash。
    const beforePayloads = payloadHashes()
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
    expectVerifyDelta(verifyBase)
    // 构造已发布 v2 字节协议，验证维护命令会升级存量数据而非只处理新行。
    // 按本用例 owner 的 cold_ref 精确定位包；共享库下 all() 含有他文件遗留的行。
    const packed = Database.use((db) =>
      db
        .select()
        .from(ColdStorageTable)
        .where(eq(ColdStorageTable.hash, row.cold_ref ?? ""))
        .get(),
    )
    if (!packed) throw new Error("Packed payload missing for the frozen owner")
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
    const prepared = ColdMaintain.prepareMaintenance({
      operation: "compress",
      sessionID: session.id,
      olderThanMs: 0,
      batchSize: 10,
    })
    const controller = new AbortController()
    // 在已提交 payload checkpoint 中断，验证真正的恢复边界而非未开始的任务。
    const interrupted = yield* Effect.promise(() =>
      ColdMaintain.maintain(prepared, {
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
    const task = ColdMaintain.parseMaintenanceTask(interrupted.task)
    const resumed = yield* Effect.promise(() =>
      ColdMaintain.maintain(prepared, {
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
    expect([...payloadHashes()].filter((hash) => !beforePayloads.has(hash))).toEqual([])
    // 最后一个 owner 展开后释放包，防止逻辑成功却遗留冗余冷内容。
  }),
)

it.instance("manual freeze admits a completed reviewer attempt in an active child", () =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const verifyBase = verifyBaseline()
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
    expectVerifyDelta(verifyBase)
  }),
)

it.instance("resumed repack retains every destination until all owners move", () =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const verifyBase = verifyBaseline()
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
    // pad 只撑大 raw_bytes，让 8 MiB 批次每次只装一个源包；多目的地编排在批间 checkpoint 上展开。
    const pad = "p".repeat(4_500_000)
    const fields = (output: string) => ({
      "state.input": {},
      "state.metadata": { pad },
      "state.output": output,
      "state.title": "cycle regression",
    })
    const digest = (owner: string, value: object) =>
      createHash("sha256")
        .update(owner + "\0")
        .update(JSON.stringify(value))
        .digest()
    // v2 已发布字节协议：显式 32 字节 entry key + hex 包 hash；不用新 writer 生成旧格式，避免同源自证。
    // 干净 v3 包不再进入重打包枚举（见同文件 merge 用例），恢复覆盖必须用 legacy 夹具。
    const pack = (entries: ReturnType<typeof fields>[]) => {
      // canonical 要求对象键按 code point 排序（fields 在 key 前），写反即非 canonical 字节。
      const keyed = entries
        .map((item) => ({ fields: item, key: digest("part", item).toString("hex") }))
        .toSorted((a, b) => (a.key < b.key ? -1 : 1))
      const raw = Buffer.from(JSON.stringify({ entries: keyed, owner: "part", version: 2 }))
      const hash = createHash("sha256").update("part-pack\0").update(raw).digest("hex")
      return { entries: keyed, hash, raw, payload: Buffer.from(Bun.zstdCompressSync(raw)) }
    }
    // 内容寻址使 hash 不可指定；微调 inert title 后缀直到 p<q，保持恢复编排的确定性前置条件。
    let suffix = 0
    let x = fields("cycle-x-0")
    const y = fields("cycle-y-0")
    let p = pack([x, y])
    let q = pack([x])
    const r = pack([y])
    while (p.hash >= q.hash) {
      suffix++
      x = { ...fields("cycle-x-0"), "state.title": `cycle regression ${suffix}` }
      p = pack([x, y])
      q = pack([x])
    }
    expect(p.hash < q.hash).toBe(true)
    const checkpointID = PartID.ascending()
    // 中断锚点必须是第一个被处理的 legacy 输入：微调输出直到其 hash 排在 p/q/r 之前。
    const checkpointFields = (output: string) => ({
      "state.input": {},
      "state.metadata": {},
      "state.output": output,
      "state.title": "cycle regression",
    })
    let checkpointOutput = "checkpoint-29"
    let checkpoint = pack([checkpointFields(checkpointOutput)] as ReturnType<typeof fields>[])
    while (checkpoint.hash >= p.hash || checkpoint.hash >= q.hash || checkpoint.hash >= r.hash) {
      checkpointOutput += "-"
      checkpoint = pack([checkpointFields(checkpointOutput)] as ReturnType<typeof fields>[])
    }
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
        output: checkpointOutput,
        title: "cycle regression",
        metadata: {},
        time: { start: 1, end: 2 },
      },
    })
    // checkpoint 包同样手工构造 legacy 形态；与下方 Q/P/R 同一插入纪律。
    Database.transaction((db) => {
      db.insert(ColdStorageTable)
        .values({
          hash: checkpoint.hash,
          kind: "part-pack",
          codec: "zstd",
          payload: checkpoint.payload,
          raw_bytes: checkpoint.raw.length,
          compressed_bytes: checkpoint.payload.length,
          ref_count: 1,
          time_created: 1,
          time_updated: 1,
        })
        .run()
      db.update(PartTable)
        .set({
          data: {
            type: "tool",
            tool: "read",
            callID: "checkpoint",
            state: { status: "completed", input: {}, output: "", title: "", metadata: {}, time: { start: 1, end: 2 } },
          },
          cold_ref: checkpoint.hash,
          cold_key: Buffer.from(checkpoint.entries[0].key, "hex"),
          cold_stats: [2, 0, 2, checkpointOutput.length],
        })
        .where(eq(PartTable.id, checkpointID))
        .run()
    })
    const prepared = ColdMaintain.prepareMaintenance({
      operation: "compress",
      sessionID: session.id,
      olderThanMs: 0,
      batchSize: 10,
    })
    const controller = new AbortController()
    // 先运行真实批次取得 checkpoint，再通过正常删除形成已释放的旧输入包。
    const interrupted = yield* Effect.promise(() =>
      ColdMaintain.maintain(prepared, {
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
      const entry = record.pack.entries.find((item) => item.fields === record.value)
      if (!entry) throw new Error("Fixture entry missing from its pack")
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
            // v2 的 cold_key 是完整 32 字节 entry key；slot 短定位键由重打包后的 v3 包分配。
            cold_key: Buffer.from(entry.key, "hex"),
            cold_stats: [2, 0, 2, value.state.output.length],
          })
          .where(eq(PartTable.id, id))
          .run()
      })
    }
    expectVerifyDelta(verifyBase)
    // 原始任务参数和实际持久 cursor 原样恢复，不伪造进度或修改 Session scope。
    const task = ColdMaintain.parseMaintenanceTask(interrupted.task)
    const result = yield* Effect.promise(() =>
      ColdMaintain.maintain(prepared, { task, lease: { assertOwned() {} }, checkpoint: async () => {} }),
    )
    expect(result.type === "task" && result.task.status).toBe("completed")
    const message = yield* MessageV2.get({ sessionID: session.id, messageID })
    expect(
      message.parts.flatMap((part) =>
        part.type === "tool" && part.state.status === "completed" ? [part.state.output] : [],
      ),
    ).toEqual(["cycle-x-0", "cycle-y-0", "cycle-y-0"])
    expectVerifyDelta(verifyBase)
  }),
)

it.instance("repack merges newly eligible v3 entries and leaves clean packs untouched", () =>
  Effect.gen(function* () {
    const verifyBase = verifyBaseline()
    const sessions = yield* Session.Service
    const session = yield* sessions.create({ title: "pending merge" })
    const messageID = MessageID.ascending()
    // 未 merge entry 的唯一真实来源是 repack 进位：legacy 包 + 通过时 session 未具备资格。
    // 夹具直接构造 v2 字节协议（entry 不含深层字段），不走新 writer，避免同源自证。
    yield* sessions.updateMessage({
      id: messageID,
      sessionID: session.id,
      role: "assistant",
      parentID: messageID,
      agent: "build",
      mode: "build",
      path: { cwd: ".", root: "." },
      time: { created: 1, completed: 2 },
      finish: "stop",
      cost: 0,
      tokens: { input: 5, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
      inputChars: 42,
      inputTokens: 11,
      providerID: ProviderID.make("test"),
      modelID: ModelID.make("test"),
    })
    const fields: Record<string, never> = {}
    const legacyKey = createHash("sha256").update("message\0").update(JSON.stringify(fields)).digest()
    const raw = Buffer.from(
      JSON.stringify({ entries: [{ fields, key: legacyKey.toString("hex") }], owner: "message", version: 2 }),
    )
    const legacyHash = createHash("sha256").update("message-pack\0").update(raw).digest("hex")
    const payload = Buffer.from(Bun.zstdCompressSync(raw))
    Database.transaction((db) => {
      db.insert(ColdStorageTable)
        .values({
          hash: legacyHash,
          kind: "message-pack",
          codec: "zstd",
          payload,
          raw_bytes: raw.length,
          compressed_bytes: payload.length,
          ref_count: 1,
          time_created: 1,
          time_updated: 1,
        })
        .run()
      db.update(MessageTable)
        .set({ cold_ref: legacyHash, cold_key: legacyKey })
        .where(eq(MessageTable.id, messageID))
        .run()
    })
    const prepared = () =>
      ColdMaintain.prepareMaintenance({
        operation: "compress",
        sessionID: session.id,
        olderThanMs: 7 * 24 * 60 * 60 * 1000,
        batchSize: 10,
      })
    const run = () =>
      Effect.promise(() =>
        ColdMaintain.maintain(prepared(), { lease: { assertOwned() {} }, checkpoint: async () => {} }),
      )
    // 第一次运行：session 未老化，repack 只升级编码，深层字段留在热行等待后续 merge。
    const first = yield* run()
    expect(first.type === "task" && first.task.status).toBe("completed")
    const carried = Database.use((db) => db.select().from(MessageTable).where(eq(MessageTable.id, messageID)).get())
    expect(carried?.cold_ref?.length).toBe(43)
    expect(carried?.data.role === "assistant" ? carried.data.path : undefined).toEqual({ cwd: ".", root: "." })
    // 热行仍携带深层字段是待 merge 的唯一可读信号；predicate 不能依赖包内字节。
    Database.use((db) =>
      db
        .update(SessionTable)
        .set({ time_updated: Date.now() - 8 * 24 * 60 * 60 * 1000 })
        .where(eq(SessionTable.id, session.id))
        .run(),
    )
    // 第二次运行：session 已老化，v3 包携带的未 merge entry 必须仍可被选中并完成 merge（R4 合约）。
    const second = yield* run()
    expect(second.type === "task" && second.task.status).toBe("completed")
    const merged = Database.use((db) => db.select().from(MessageTable).where(eq(MessageTable.id, messageID)).get())
    expect(merged?.data.role === "assistant" && "path" in merged.data).toBe(false)
    const restored = yield* MessageV2.get({ sessionID: session.id, messageID })
    expect(restored.info).toMatchObject({ path: { cwd: ".", root: "." }, inputChars: 42, inputTokens: 11 })
    // 第三次运行：唯一的 v3 包已干净，枚举不得再选中任何源；全量重处理正是要消除的浪费。
    const third = yield* run()
    expect(third.type === "task" && third.task.status).toBe("completed")
    expect(third.type === "task" ? third.task.processed : -1).toBe(0)
    expectVerifyDelta(verifyBase)
  }),
)
