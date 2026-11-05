import { describe, expect } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { EventV2 } from "@opencode-ai/core/event"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Database } from "@opencode-ai/core/database/database"
import { DatabaseMigration } from "@opencode-ai/core/database/migration"
import stepUsageMigration from "@opencode-ai/core/database/migration/20260623000000_session_step_usage"
import { Deferred, Effect, Exit, Layer } from "effect"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { eq, sql } from "drizzle-orm"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Session as SessionNs } from "@/session/session"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, type SessionID } from "../../src/session/schema"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { provideInstance, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { GlobalBus } from "@/bus/global"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { InstanceStore } from "@/project/instance-store"
import { InstanceBootstrap } from "@/project/bootstrap"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      SessionNs.node,
      EventV2Bridge.node,
      SessionProjector.node,
      // 测试读取实际迁移基数，必须显式暴露同一 Layer 图中的数据库服务。
      Database.node,
      CrossSpawnSpawner.node,
      InstanceStore.node,
    ]),
    [
      [RuntimeFlags.node, RuntimeFlags.layer({ experimentalWorkspaces: false })],
      [
        InstanceBootstrap.node,
        Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void })),
      ],
    ],
  ),
)

const awaitDeferred = <T>(deferred: Deferred.Deferred<T>, message: string) =>
  Effect.race(
    Deferred.await(deferred),
    Effect.sleep("2 seconds").pipe(Effect.flatMap(() => Effect.fail(new Error(message)))),
  )

const remove = (id: SessionID) => SessionNs.use.remove(id)

it.instance("limits cancellation children to active ancestry without dropping idle bridges", () =>
  Effect.gen(function* () {
    // 空闲父节点仍可能拥有活动后代，不能简单把直接子列表与活动 ID 求交集。
    const sessions = yield* SessionNs.Service
    const parent = yield* sessions.create({})
    yield* sessions.create({ parentID: parent.id })
    const bridge = yield* sessions.create({ parentID: parent.id })
    const active = yield* sessions.create({ parentID: bridge.id })
    const unrelated = yield* sessions.create({})
    // 默认列表合同不变；取消筛选同时排除历史分支和其他根会话。
    expect((yield* sessions.children(parent.id)).length).toBe(2)
    expect((yield* sessions.children(parent.id, [active.id, unrelated.id])).map(child => child.id)).toEqual([bridge.id])
    expect((yield* sessions.children(bridge.id, [active.id])).map(child => child.id)).toEqual([active.id])
    expect(yield* sessions.children(parent.id, [])).toEqual([])
  }),
)

describe("session.created event", () => {
  it.instance("should emit session.created event when session is created", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const events = yield* EventV2Bridge.Service
      const received = yield* Deferred.make<SessionNs.Info>()

      const unsub = yield* events.listen((event) => {
        if (event.type === SessionNs.Event.Created.type)
          Deferred.doneUnsafe(
            received,
            Effect.succeed((event.data as typeof SessionNs.Event.Created.data.Type).info as SessionNs.Info),
          )
        return Effect.void
      })
      yield* Effect.addFinalizer(() => unsub)

      const info = yield* session.create({})
      const receivedInfo = yield* awaitDeferred(received, "timed out waiting for session.created")

      expect(receivedInfo.id).toBe(info.id)
      expect(receivedInfo.projectID).toBe(info.projectID)
      expect(receivedInfo.directory).toBe(info.directory)
      expect(receivedInfo.path).toBe(info.path)
      expect(receivedInfo.title).toBe(info.title)

      yield* session.remove(info.id)
    }),
  )

  it.instance("session.created event should be emitted before session.updated", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const source = yield* EventV2Bridge.Service
      const events: string[] = []
      const received = yield* Deferred.make<string[]>()
      const push = (event: string) => {
        events.push(event)
        if (events.includes("created") && events.includes("updated")) {
          Deferred.doneUnsafe(received, Effect.succeed(events))
        }
      }

      const unsubscribe = yield* source.listen((event) => {
        if (event.type === SessionNs.Event.Created.type) push("created")
        if (event.type === SessionNs.Event.Updated.type) push("updated")
        return Effect.void
      })
      yield* Effect.addFinalizer(() => unsubscribe)

      const info = yield* session.create({})
      yield* session.setTitle({ sessionID: info.id, title: "updated" })
      const receivedEvents = yield* awaitDeferred(received, "timed out waiting for session created/updated events")

      expect(receivedEvents).toContain("created")
      expect(receivedEvents).toContain("updated")
      expect(receivedEvents.indexOf("created")).toBeLessThan(receivedEvents.indexOf("updated"))

      yield* session.remove(info.id)
    }),
  )

  it.instance("emits legacy global sync payload", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const received = yield* Deferred.make<{ syncEvent: EventV2.SerializedEvent }>()
      const listener = (event: { payload: { type?: string; syncEvent?: EventV2.SerializedEvent } }) => {
        if (event.payload.type === "sync" && event.payload.syncEvent)
          Deferred.doneUnsafe(received, Effect.succeed({ syncEvent: event.payload.syncEvent }))
      }
      GlobalBus.on("event", listener)
      yield* Effect.addFinalizer(() => Effect.sync(() => GlobalBus.off("event", listener)))

      const info = yield* session.create({})
      const event = yield* awaitDeferred(received, "timed out waiting for legacy global sync event")

      expect(event.syncEvent).toMatchObject({
        type: EventV2.versionedType(SessionNs.Event.Created.type, 1),
        seq: 0,
        aggregateID: info.id,
        data: { sessionID: info.id },
      })

      yield* session.remove(info.id)
    }),
  )
})

describe("step-finish token propagation via event", () => {
  it.instance("projects all steps past the transcript window and reconciles edits/removals", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const database = yield* Database.Service
      const created = yield* Effect.acquireRelease(session.create({}), (info) => session.remove(info.id).pipe(Effect.ignore))
      const snapshots: SessionNs.Info[] = []
      // 监听真正的兼容 wire 通知，而非 EventV2 原始 part 事件，才能发现实时快照缺失。
      const listener = (event: { payload: { type?: string; properties?: { info?: SessionNs.Info } } }) => {
        const info = event.payload.properties?.info
        if (event.payload.type === "session.updated" && info?.id === created.id) snapshots.push(info)
      }
      GlobalBus.on("event", listener)
      // fixture 结束即退订，防止后续实例事件串入这个用量样本。
      yield* Effect.addFinalizer(() => Effect.sync(() => GlobalBus.off("event", listener)))
      const userID = MessageID.ascending()
      // 名称仍是 fixture 的 test，使用规范 ID 构造器承载品牌，避免断言绕过协议类型。
      yield* session.updateMessage({
        id: userID, sessionID: created.id, role: "user", time: { created: 0 },
        agent: "build", model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") },
      })
      const tokens = { input: 2, output: 3, reasoning: 1, cache: { read: 5, write: 7 } }
      const assistant: SessionV1.Assistant = {
        id: MessageID.ascending(), sessionID: created.id, role: "assistant", parentID: userID,
        agent: "build", mode: "build", modelID: ModelV2.ID.make("test"), providerID: ProviderV2.ID.make("test"),
        path: { cwd: created.directory, root: created.directory }, cost: 0.01, tokens,
        time: { created: 1, completed: 2 },
      }
      const first = {
        id: PartID.ascending(), sessionID: created.id, messageID: assistant.id,
        type: "step-finish" as const, reason: "stop", cost: 0.01, tokens,
      }
      // 101 个助手使第一条退出 limit:100；每条都有真实持久步骤，而非单纯填充文本。
      for (let index = 0; index < 101; index++) {
        const messageID = index === 0 ? assistant.id : MessageID.ascending()
        yield* session.updateMessage({ ...assistant, id: messageID, time: { created: index + 1, completed: index + 2 } })
        yield* session.updatePart({ ...first, messageID, id: index === 0 ? first.id : PartID.ascending() })
      }
      // 同一助手再有一步，模拟 processor 覆盖 tokens 后仍须保留先前步骤的用量。
      const second = { ...first, id: PartID.ascending() }
      yield* session.updatePart(second)
      const page = yield* session.messages({ sessionID: created.id, limit: 100 })
      expect(page).toHaveLength(100)
      expect(page.some((item) => item.info.id === assistant.id)).toBe(false)
      // 用户同样退出 100 条窗口，但完整请求身份和累计不能因此归零。
      expect(page.some((item) => item.info.id === userID)).toBe(false)
      expect((yield* session.get(created.id)).request).toMatchObject({ messageID: userID, input: 1428, output: 408 })
      // 源语义取助手 cost；fixture 的第二个 part 有额外费用，能区分请求与全局费用。
      expect((yield* session.get(created.id)).request?.cost).toBeCloseTo(1.01)
      expect(snapshots.at(-1)?.request?.input).toBe(1428)
      // 请求跨窗口累计 102 步，主值却只显示最后助手的一步，而非整个请求。
      expect((yield* session.get(created.id)).request).toMatchObject({ stepInput: 14, stepOutput: 4 })
      // 费用仍属于请求所有助手，新增 step 字段不能缩窄原有请求费用口径。
      expect((yield* session.get(created.id)).tokens).toEqual({
        input: 204, output: 306, reasoning: 102, cache: { read: 510, write: 714 },
      })
      // token 投影不能改写收费账本；保留上游服务端 cost 的累计语义。
      expect((yield* session.get(created.id)).cost).toBeCloseTo(1.02)
      // 用户正文不是 provider usage；保留负样本，但不制造运行时不存在的用户 step-finish。
      yield* session.updatePart({ id: PartID.ascending(), sessionID: created.id, messageID: userID, type: "text", text: "not provider usage" })
      expect((yield* session.get(created.id)).tokens?.input).toBe(204)
      // exact part 重发不得再累计一次；读投影按持久 part ID 的当前版本计算。
      yield* session.updatePart(first)
      expect(snapshots.at(-1)?.tokens?.input).toBe(204)
      // 模拟已升级旧库的最后一步基数，由一次性数据迁移修正，不要求 GET 扫描历史。
      // 新建 fixture 已记录所有迁移；移除本项 journal 才能真实模拟尚未安装修正的旧库。
      yield* database.db.run(sql`DELETE FROM migration WHERE id = ${stepUsageMigration.id}`)
      yield* database.db.update(SessionTable).set({ tokens_input: 2 }).where(eq(SessionTable.id, created.id)).run()
      yield* DatabaseMigration.applyOnly(database.db, [stepUsageMigration])
      expect((yield* session.get(created.id)).tokens?.input).toBe(204)
      // GET 与列表直接读同一已修正基数，验证恢复后无需各自维护查询投影。
      expect((yield* session.list({ scope: "project" })).find((item) => item.id === created.id)?.tokens?.input).toBe(204)
      // 步骤修订替换旧 usage，而不是把修订作为额外的一次 provider 调用。
      yield* session.updatePart({ ...first, tokens: { input: 4, output: 6, reasoning: 2, cache: { read: 10, write: 14 } } })
      // migration journal 再次进入应跳过回填，之后的步骤修订仍由增量 projector 维护。
      yield* DatabaseMigration.applyOnly(database.db, [stepUsageMigration])
      expect(snapshots.at(-1)?.tokens).toEqual({
        input: 206, output: 309, reasoning: 103, cache: { read: 515, write: 721 },
      })
      // 删除一步只扣该步，删除助手则扣该助手剩余全部步骤，均需实时通知。
      yield* session.removePart({ sessionID: created.id, messageID: assistant.id, partID: second.id })
      expect(snapshots.at(-1)?.tokens?.input).toBe(204)
      yield* session.removeMessage({ sessionID: created.id, messageID: assistant.id })
      expect(snapshots.at(-1)?.tokens).toEqual({
        input: 200, output: 300, reasoning: 100, cache: { read: 500, write: 700 },
      })
      // fork 的复制步骤也走同一 projector；验证持久累计，保留上游初始响应的既有契约。
      const fork = yield* Effect.acquireRelease(session.fork({ sessionID: created.id }), (info) => session.remove(info.id).pipe(Effect.ignore))
      expect((yield* session.get(fork.id)).tokens?.input).toBe(200)
      // 空子代理必须给零，不得借用已有用量的父会话累计或历史 fallback。
      const empty = yield* Effect.acquireRelease(session.create({ parentID: created.id }), (info) => session.remove(info.id).pipe(Effect.ignore))
      expect((yield* session.get(empty.id)).tokens).toEqual({
        input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 },
      })
      expect((yield* session.children(created.id)).find((item) => item.id === empty.id)?.tokens?.input).toBe(0)
      // 旧请求仍有100个助手，无回复的新用户不能让完整请求累计归零。
      const nextUserID = MessageID.ascending()
      yield* session.updateMessage({
        id: nextUserID, sessionID: created.id, role: "user", time: { created: 1000 },
        agent: "build", model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") },
      })
      expect((yield* session.get(created.id)).request).toMatchObject({ messageID: userID, input: 1400, output: 400, cost: 1 })
      expect((yield* session.get(created.id)).request?.assistantID).toBeDefined()
      // 身份切换只改变请求投影，已确认 Session.tokens 仍保留完整历史。
      expect((yield* session.get(created.id)).tokens?.input).toBe(200)
      expect(snapshots.at(-1)?.request?.messageID).toBe(userID)
      expect(snapshots.at(-1)?.request?.cost).toBe(1)
      const latest = yield* session.findMessage(created.id, (info) => info.role === "assistant")
      if (latest._tag !== "Some" || latest.value.info.role !== "assistant") throw new Error("Expected latest assistant")
      const saved = latest.value.info
      // 父行缺失或不是用户时，仍按原语义投影最新用户；不能把任意已有ID当作请求。
      for (const parentID of [MessageID.ascending(), saved.id]) {
        yield* session.updateMessage({ ...saved, parentID })
        expect((yield* session.get(created.id)).request?.messageID).toBe(nextUserID)
      }
      // 恢复原父用户后重新显示完整请求，确认点与Session累计均保留。
      yield* session.updateMessage(saved)
      expect((yield* session.get(created.id)).request).toMatchObject({ messageID: userID, input: 1400, output: 400, cost: 1 })
      expect((yield* session.get(created.id)).tokens?.input).toBe(200)
      // 退订不影响持久请求；没有消费者时无需为兼容快照扫描完整历史。
      GlobalBus.off("event", listener)
      const observed = snapshots.length
      const unobserved = {
        id: MessageID.ascending(), sessionID: created.id, role: "user" as const, time: { created: 1001 },
        agent: "build", model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") },
      }
      yield* session.updateMessage(unobserved)
      expect(snapshots.at(-1)?.request?.messageID).toBe(userID)
      expect(snapshots).toHaveLength(observed)
      expect((yield* session.get(created.id)).request?.messageID).toBe(userID)
      // 重新订阅后立即恢复真实投影，不能把无订阅状态缓存成永久禁用。
      GlobalBus.on("event", listener)
      yield* session.updateMessage({ ...unobserved, agent: "updated" })
      expect(snapshots.at(-1)?.request?.messageID).toBe(userID)
      expect(snapshots.length).toBeGreaterThan(observed)
    }),
    // fixture 包含跨窗口的持久事件与 fork；只放宽执行上限，不用固定 sleep 掩盖竞态。
    { timeout: 30000 },
  )

  it.instance(
    "non-zero tokens propagate through PartUpdated event",
    () =>
      Effect.gen(function* () {
        const session = yield* SessionNs.Service
        const events = yield* EventV2Bridge.Service
        const info = yield* session.create({})

        const messageID = MessageID.ascending()
        yield* session.updateMessage({
          id: messageID,
          sessionID: info.id,
          role: "user",
          time: { created: Date.now() },
          agent: "user",
          model: { providerID: "test", modelID: "test" },
          tools: {},
          mode: "",
        } as unknown as SessionV1.Info)

        // Event subscribers receive readonly Schema.Type payloads; `SessionV1.Part`
        // is the mutable domain type. Cast bridges the two — safe because the
        // test only reads the value afterwards.
        const received = yield* Deferred.make<SessionV1.Part>()
        const unsub = yield* events.listen((event) => {
          if (event.type === MessageV2.Event.PartUpdated.type)
            Deferred.doneUnsafe(
              received,
              Effect.succeed((event.data as typeof MessageV2.Event.PartUpdated.data.Type).part as SessionV1.Part),
            )
          return Effect.void
        })
        yield* Effect.addFinalizer(() => unsub)

        const tokens = {
          total: 1500,
          input: 500,
          output: 800,
          reasoning: 200,
          cache: { read: 100, write: 50 },
        }

        const partInput = {
          id: PartID.ascending(),
          messageID,
          sessionID: info.id,
          type: "step-finish" as const,
          reason: "stop",
          cost: 0.005,
          tokens,
        }

        yield* session.updatePart(partInput)
        const receivedPart = yield* awaitDeferred(received, "timed out waiting for message.part.updated")

        expect(receivedPart.type).toBe("step-finish")
        const finish = receivedPart as SessionV1.StepFinishPart
        expect(finish.tokens.input).toBe(500)
        expect(finish.tokens.output).toBe(800)
        expect(finish.tokens.reasoning).toBe(200)
        expect(finish.tokens.total).toBe(1500)
        expect(finish.tokens.cache.read).toBe(100)
        expect(finish.tokens.cache.write).toBe(50)
        expect(finish.cost).toBe(0.005)
        expect(receivedPart).not.toBe(partInput)

        yield* session.remove(info.id)
      }),
    { timeout: 30000 },
  )
})

describe("Session", () => {
  it.live("remove works without an instance", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const dir = yield* tmpdirScoped({ git: true })
      const info = yield* provideInstance(dir)(session.create({ title: "remove-without-instance" }))

      const removeExit = yield* remove(info.id).pipe(Effect.exit)
      expect(Exit.isSuccess(removeExit)).toBe(true)

      const getExit = yield* session.get(info.id).pipe(Effect.exit)
      expect(Exit.isFailure(getExit)).toBe(true)
    }),
  )

  it.instance("persists metadata and copies it on fork by default", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const meta = { source: "sdk", trace: { id: "abc" } }
      const created = yield* Effect.acquireRelease(session.create({ title: "with-meta", metadata: meta }), (info) =>
        session.remove(info.id).pipe(Effect.ignore),
      )
      const saved = yield* session.get(created.id)
      const fork = yield* Effect.acquireRelease(session.fork({ sessionID: created.id }), (info) =>
        session.remove(info.id).pipe(Effect.ignore),
      )

      expect(saved.metadata).toEqual(meta)
      expect(fork.metadata).toEqual(meta)
      expect(fork.metadata).not.toBe(meta)
    }),
  )

  it.instance("forks the chronological prefix across mixed message ID ordering", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const created = yield* Effect.acquireRelease(session.create({}), (info) =>
        session.remove(info.id).pipe(Effect.ignore),
      )
      const ids = ["msg_z9-before", "msg_z1-before-wrap", "msg_a0-after-wrap", "msg_a1-after"]
      for (const [index, id] of ids.entries()) {
        yield* session.updateMessage({
          id: MessageID.make(id),
          sessionID: created.id,
          role: "user",
          time: { created: index + 1 },
          agent: "user",
          model: { providerID: "test", modelID: "test" },
        } as SessionV1.User)
      }

      const beforeWrap = yield* Effect.acquireRelease(
        session.fork({ sessionID: created.id, messageID: MessageID.make(ids[1]!) }),
        (info) => session.remove(info.id).pipe(Effect.ignore),
      )
      const afterWrap = yield* Effect.acquireRelease(
        session.fork({ sessionID: created.id, messageID: MessageID.make(ids[2]!) }),
        (info) => session.remove(info.id).pipe(Effect.ignore),
      )

      expect((yield* session.messages({ sessionID: beforeWrap.id })).map((msg) => msg.info.time.created)).toEqual([1])
      expect((yield* session.messages({ sessionID: afterWrap.id })).map((msg) => msg.info.time.created)).toEqual([1, 2])
    }),
  )

  it.instance("omits metadata when not provided", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const created = yield* Effect.acquireRelease(session.create({ title: "empty-meta" }), (info) =>
        session.remove(info.id).pipe(Effect.ignore),
      )
      const saved = yield* session.get(created.id)

      expect(created.metadata).toBeUndefined()
      expect(saved.metadata).toBeUndefined()
    }),
  )
})
