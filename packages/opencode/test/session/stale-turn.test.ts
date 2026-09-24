import { describe, expect } from "bun:test"
import { DateTime, Effect, Layer, Schema } from "effect"
import { eq } from "drizzle-orm"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Session as SessionNs } from "@/session/session"
import { MessageV2 } from "@/session/message-v2"
import { MessageID, PartID, type SessionID } from "@/session/schema"
import { SessionStaleTurn } from "@/session/stale-turn"
import { SessionProcessor } from "@/session/processor"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Database } from "@opencode-ai/core/database/database"
import { RequestUsageTable } from "@opencode-ai/core/session/request-usage.sql"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { EventV2Bridge } from "@/event-v2-bridge"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionRequestUsage } from "@opencode-ai/core/session/request-usage"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionInputTable, SessionMessageTable, SessionTable } from "@opencode-ai/core/session/sql"
import { InstanceRef, WorkspaceRef } from "@/effect/instance-ref"
import { Storage } from "@/storage/storage"
import { testEffect } from "../lib/effect"

// 测试和生产消费同一Effect入口；只为测试提供空执行协调器，绝不启动native runner或daemon。
const it = testEffect(
  Layer.mergeAll(LayerNode.compile(
    LayerNode.group([
      SessionNs.node,
      MessageV2.node,
      SessionProjector.node,
      CrossSpawnSpawner.node,
      Database.node,
      EventV2Bridge.node,
      Storage.node,
      SessionRequestUsage.node,
    ]),
  ), SessionExecution.noopLayer),
)

// Native同责回归只用真实内存DB/投影和空执行协调器；不绑定Git实例或启动产品生命周期。
const native = testEffect(AppNodeBuilder.build(
  LayerNode.group([Database.node, SessionProjector.node, EventV2Bridge.node, SessionRequestUsage.node, SessionExecution.node]),
  [[Database.node, Database.layerFromPath(":memory:")], [SessionExecution.node, SessionExecution.noopLayer]],
).pipe(
  Layer.provide(Layer.succeed(InstanceRef, undefined)),
  Layer.provide(Layer.succeed(WorkspaceRef, undefined)),
))

// 构造 crash 残留：incomplete assistant + pending tool + running usage。
// 对应真实 daemon 死亡现场，而不是 live cancel 的内存 runner 状态。
// seed 经 Session.update*（有 instance）写入；reconcile 本身在独立 runtime 上执行。
function seedIncompleteTurn(sessions: SessionNs.Interface, sessionID: SessionID) {
  return Effect.gen(function* () {
    // user 消息先行：request_usage 的 PK 含 request_id=user messageID，种子必须先落 user 行。
    const userID = MessageID.ascending()
    yield* sessions.updateMessage({
      id: userID,
      sessionID,
      role: "user",
      time: { created: Date.now() },
      agent: "build",
      model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") },
    })
    const assistantID = MessageID.ascending()
    // assistant 故意不写 time.completed：模拟 agent 循环中途进程退出。
    const assistant = yield* sessions.updateMessage({
      id: assistantID,
      sessionID,
      role: "assistant",
      parentID: userID,
      mode: "build",
      agent: "build",
      path: { cwd: "/tmp", root: "/tmp" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: ModelV2.ID.make("test"),
      providerID: ProviderV2.ID.make("test"),
      time: { created: Date.now() },
    })
    const partID = PartID.ascending()
    // pending + raw 是 ToolStatePending 的完整合同；缺 raw 会在类型层失败。
    const tool = yield* sessions.updatePart({
      id: partID,
      sessionID,
      messageID: assistantID,
      type: "tool",
      tool: "bash",
      callID: "call_stale",
      state: {
        status: "pending",
        input: { command: "sleep 999" },
        raw: "",
      },
    })
    // usage 直接插 running 行：绕过 begin() 的 Effect 服务，聚焦 reconcile 的 SQL 终态。
    // 只写本fixture所持的同一连接，不借用全局数据库或最后打开的sync引用。
    const { sync } = yield* Database.Service
    sync.insert(RequestUsageTable)
      .values({
        session_id: sessionID,
        request_id: userID,
        root_request_id: userID,
        source: "prompt",
        status: "running",
        agent: "build",
        provider_id: "test",
        model_id: "test",
        time_created: Date.now(),
        time_updated: Date.now(),
      })
      .run()
    return { userID, assistant, tool }
  })
}

describe("SessionStaleTurn", () => {
  // 行为：owner-transition reconcile 把 incomplete assistant 写成 cancel 等价终态（time.completed + MessageAbortedError）。
  // 这是 INV-01 / 用户可见「· interrupted」的 durable 前提。
  it.instance(
    "recent reconcile terminalizes incomplete assistant in top sessions",
    () =>
      Effect.gen(function* () {
        const sessions = yield* SessionNs.Service
        const chat = yield* sessions.create({ title: "stale-recent" })
        const seeded = yield* seedIncompleteTurn(sessions, chat.id)

        // 期望值来自 cancel 合同字面量，不复制 reconcile 内部算法。
        yield* SessionStaleTurn.reconcile({ kind: "recent", limit: 16 })

        // MessageV2.get 走 effect 上下文读回投影终态——断言面是 durable 结果而非内存种子。
        const msg = yield* MessageV2.get({ sessionID: chat.id, messageID: seeded.assistant.id })
        expect(msg.info.role).toBe("assistant")
        if (msg.info.role !== "assistant") return
        // time.completed 存在即退出 streaming；error.name 驱动 TUI interrupted 后缀。
        expect(msg.info.time.completed).toBeDefined()
        expect(msg.info.error?.name).toBe("MessageAbortedError")
      }),
    { git: true },
  )

  // 行为：open tool 必须带 TOOL_ABORTED_ERROR + interrupted metadata。
  // UI 与 LLM 回放都依赖该合同；新文案会分叉「· interrupted」路径。
  it.instance(
    "recent reconcile aborts open tools with interrupted metadata",
    () =>
      Effect.gen(function* () {
        const sessions = yield* SessionNs.Service
        const chat = yield* sessions.create({ title: "stale-tool" })
        const seeded = yield* seedIncompleteTurn(sessions, chat.id)

        // 修复的物理open扫描必须关闭隐藏工具，不能被业务可见性过滤截断。
        yield* sessions.updatePart({ ...seeded.tool, hidden: { time: Date.now(), reason: "undo" } })
        yield* SessionStaleTurn.reconcile({ kind: "recent", limit: 16 })

        const msg = yield* MessageV2.get({ sessionID: chat.id, messageID: seeded.assistant.id, includeHidden: true })
        const tool = msg.parts.find((part) => part.id === seeded.tool.id)
        expect(tool?.type).toBe("tool")
        if (tool?.type !== "tool") return
        expect(tool.state.status).toBe("error")
        if (tool.state.status !== "error") return
        // 独立字面量：与 SessionProcessor 导出常量对齐，防止实现方另造 error 字符串。
        expect(tool.state.error).toBe(SessionProcessor.TOOL_ABORTED_ERROR)
        expect(tool.state.metadata?.interrupted).toBe(true)
      }),
    { git: true },
  )

  // 行为：running usage 必须变为 aborted，避免计费/状态聚合长期卡在 running。
  it.instance(
    "recent reconcile aborts running request usage",
    () =>
      Effect.gen(function* () {
        const sessions = yield* SessionNs.Service
        const chat = yield* sessions.create({ title: "stale-usage" })
        const seeded = yield* seedIncompleteTurn(sessions, chat.id)

        yield* SessionStaleTurn.reconcile({ kind: "recent", limit: 16 })

        // usage 断言直接查表——status 是计费聚合的输入，不经事件重放。
        const { sync } = yield* Database.Service
        const row = sync
          .select()
          .from(RequestUsageTable)
          .where(eq(RequestUsageTable.request_id, seeded.userID))
          .get()
        // status 与 time_completed 对齐 RequestUsage.complete(aborted) 字段合同。
        expect(row?.status).toBe("aborted")
        expect(row?.time_completed).toBeDefined()
        // 助手明细沿同一commit结算，不能只把请求总行改成aborted而留下running明细。
        const usage = yield* SessionRequestUsage.Service
        const assistants = yield* usage.assistants({ sessionID: chat.id, requestID: seeded.userID })
        expect(assistants).toHaveLength(1)
        expect(assistants[0]?.status).toBe("aborted")
      }),
    { git: true },
  )

  // INV-08 适配形态：目标 bridge 在无 InstanceRef 时直接 events.publish（不再失败）。
  // worker boot/exit 没有 directory instance；若误走 Session.update* 仍会在 InstanceState.context 处失败——
  // reconcile 内部固定经 AppRuntime.runPromise（独立 runtime、无 InstanceRef），本用例锁该可执行合同。
  it.instance(
    "reconcile succeeds without instance context",
    () =>
      Effect.gen(function* () {
        const sessions = yield* SessionNs.Service
        const chat = yield* sessions.create({ title: "stale-no-instance" })
        const seeded = yield* seedIncompleteTurn(sessions, chat.id)

        // 显式去掉两个实例引用，仍须经真实数据库和projector写终态。
        yield* SessionStaleTurn.reconcile({ kind: "recent", limit: 16 }).pipe(
          Effect.provideService(InstanceRef, undefined), Effect.provideService(WorkspaceRef, undefined),
        )

        const msg = yield* MessageV2.get({ sessionID: chat.id, messageID: seeded.assistant.id })
        if (msg.info.role !== "assistant") throw new Error("expected assistant")
        // 成功本身即证明无 InstanceRef 路径可写 durable 终态。
        expect(msg.info.time.completed).toBeDefined()
      }),
    { git: true },
  )

  // 行为：exit-full C 步关闭「message 已 completed 但 tool 仍 open」的孤儿。
  // cancelSnapshot 故意跳过 completed assistant，因此必须 tool-only 终端化且不改写 message.error。
  it.instance(
    "exit-full closes orphan open tool on completed message",
    () =>
      Effect.gen(function* () {
        const sessions = yield* SessionNs.Service
        const chat = yield* sessions.create({ title: "stale-orphan" })
        const userID = MessageID.ascending()
        yield* sessions.updateMessage({
          id: userID,
          sessionID: chat.id,
          role: "user",
          time: { created: Date.now() },
          agent: "build",
          model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") },
        })
        const assistantID = MessageID.ascending()
        yield* sessions.updateMessage({
          id: assistantID,
          sessionID: chat.id,
          role: "assistant",
          parentID: userID,
          mode: "build",
          agent: "build",
          path: { cwd: "/tmp", root: "/tmp" },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: ModelV2.ID.make("test"),
          providerID: ProviderV2.ID.make("test"),
          time: { created: Date.now(), completed: Date.now() },
          error: new SessionV1.AbortedError({ message: "Aborted" }).toObject(),
        })
        const partID = PartID.ascending()
        yield* sessions.updatePart({
          id: partID,
          sessionID: chat.id,
          messageID: assistantID,
          type: "tool",
          tool: "bash",
          callID: "call_orphan",
          state: { status: "running", input: {}, time: { start: Date.now() } },
        })

          // exit-full 走完整 D/E/C 链：先 incomplete 后孤儿，预算 5s 覆盖两段。
        yield* SessionStaleTurn.reconcile({ kind: "exit-full" }, { budgetMs: 5_000 })

        const msg = yield* MessageV2.get({ sessionID: chat.id, messageID: assistantID })
        const tool = msg.parts.find((part) => part.id === partID)
        expect(tool?.type).toBe("tool")
        if (tool?.type !== "tool" || tool.state.status !== "error") throw new Error("expected aborted tool")
        expect(tool.state.error).toBe(SessionProcessor.TOOL_ABORTED_ERROR)
        // message 已 terminal：孤儿路径不得改写 error（历史终态语义）。
        if (msg.info.role !== "assistant") throw new Error("expected assistant")
        expect(msg.info.error?.name).toBe("MessageAbortedError")
      }),
    { git: true },
  )

  // 行为：budgetMs=0 表示 dispose 吃光 worker 5s 窗口，exit-full 必须整段跳过（残留交给下次 L1）。
  it.instance(
    "exit-full with budgetMs 0 leaves incomplete state unchanged",
    () =>
      Effect.gen(function* () {
        const sessions = yield* SessionNs.Service
        const chat = yield* sessions.create({ title: "stale-budget-zero" })
        const seeded = yield* seedIncompleteTurn(sessions, chat.id)

        // budgetMs=0 是 worker residual 计算的边界：remaining<=0 时不得触碰 SQLite 行。
        yield* SessionStaleTurn.reconcile({ kind: "exit-full" }, { budgetMs: 0 })

        const msg = yield* MessageV2.get({ sessionID: chat.id, messageID: seeded.assistant.id })
        if (msg.info.role !== "assistant") throw new Error("expected assistant")
        // budget=0 整段跳过：completed 必须保持 undefined，证明 SQLite 行未被触碰。
        expect(msg.info.time.completed).toBeUndefined()
      }),
    { git: true },
  )

  // native残留沿真实事件与投影闭合；未提升队列仍是有效待执行输入，绝不被当作旧running请求。
  native.effect("reconciles native tools and promoted usage without aborting pending inbox", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const events = yield* EventV2Bridge.Service
      const timestamp = yield* DateTime.now
      const chat = { id: SessionSchema.ID.make("ses_stale_native") }
      yield* database.db.insert(ProjectTable).values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] }).run().pipe(Effect.orDie)
      yield* database.db.insert(SessionTable).values({ id: chat.id, project_id: Project.ID.global, slug: "stale-native", directory: "/project", title: "stale-native", version: "test" }).run().pipe(Effect.orDie)
      const ids = [SessionMessage.ID.create(), SessionMessage.ID.create()] as const
      for (const [index, id] of ids.entries()) {
        // 由真实admission/promotion projector分配序列；夹具不伪造会与durable身份冲突的输入行。
        yield* events.publish(SessionEvent.PromptAdmitted, {
          sessionID: chat.id, messageID: id, prompt: { text: "native request" }, delivery: "steer", timestamp,
        })
        if (index === 0) yield* events.publish(SessionEvent.Prompted, {
          sessionID: chat.id, messageID: id, prompt: { text: "native request" }, delivery: "steer", timestamp,
        })
      }
      const assistant = SessionMessage.ID.create()
      yield* events.publish(SessionEvent.Step.Started, {
        sessionID: chat.id, assistantMessageID: assistant, agent: "build", timestamp,
        model: { id: ModelV2.ID.make("test"), providerID: ProviderV2.ID.make("test") },
      })
      yield* events.publish(SessionEvent.Tool.Input.Started, {
        sessionID: chat.id, assistantMessageID: assistant, callID: "native-stale", name: "edit", timestamp,
      })
      yield* SessionStaleTurn.reconcile({ kind: "recent", limit: 16 })
      const row = yield* database.db.select().from(SessionMessageTable).where(eq(SessionMessageTable.id, assistant)).get().pipe(Effect.orDie)
      if (!row) throw new Error("expected native assistant")
      const data = Schema.decodeUnknownSync(SessionMessage.Message)({ ...row.data, id: row.id, type: row.type })
      if (data.type !== "assistant") throw new Error("expected native assistant data")
      // completed与tool error必须来自projector；不存在V1影子助手或重复消费重建。
      expect(data.time.completed).toBeDefined()
      expect(data.content.filter((part) => part.type === "tool").map((part) => part.state.status)).toEqual(["error"])
      const stored = yield* database.db.select().from(RequestUsageTable).where(eq(RequestUsageTable.session_id, chat.id)).all().pipe(Effect.orDie)
      expect(stored.find((item) => item.request_id === MessageID.make(ids[0]))?.status).toBe("aborted")
      expect(stored.find((item) => item.request_id === MessageID.make(ids[1]))?.status).toBe("running")
      const pending = yield* database.db.select().from(SessionInputTable).where(eq(SessionInputTable.id, ids[1])).get().pipe(Effect.orDie)
      expect(pending?.promoted_seq).toBeNull()
      const usage = yield* SessionRequestUsage.Service
      const details = yield* usage.assistants({ sessionID: chat.id, requestID: MessageID.make(ids[0]) })
      expect(details[0]?.status).toBe("aborted")

      // 完成助手仍可能遗留open工具；非零用量已确认，C只能修工具，不得退款或重新累计。
      const orphanSession = SessionSchema.ID.make("ses_native_orphan")
      yield* database.db.insert(SessionTable).values({ id: orphanSession, project_id: Project.ID.global, slug: "orphan", directory: "/project", title: "orphan", version: "test" }).run().pipe(Effect.orDie)
      const orphanRequest = SessionMessage.ID.create()
      yield* events.publish(SessionEvent.PromptAdmitted, { sessionID: orphanSession, messageID: orphanRequest, prompt: { text: "orphan" }, delivery: "steer", timestamp })
      yield* events.publish(SessionEvent.Prompted, { sessionID: orphanSession, messageID: orphanRequest, prompt: { text: "orphan" }, delivery: "steer", timestamp })
      const orphanAssistant = SessionMessage.ID.create()
      yield* events.publish(SessionEvent.Step.Started, { sessionID: orphanSession, assistantMessageID: orphanAssistant, agent: "build", timestamp, model: { id: ModelV2.ID.make("test"), providerID: ProviderV2.ID.make("test") } })
      yield* events.publish(SessionEvent.Tool.Input.Started, { sessionID: orphanSession, assistantMessageID: orphanAssistant, callID: "orphan-tool", name: "edit", timestamp })
      yield* events.publish(SessionEvent.Tool.Called, { sessionID: orphanSession, assistantMessageID: orphanAssistant, callID: "orphan-tool", tool: "edit", input: {}, provider: { executed: false }, timestamp })
      const tokens = { input: 5, output: 3, reasoning: 1, cache: { read: 0, write: 0 } }
      yield* events.publish(SessionEvent.Step.Ended, { sessionID: orphanSession, assistantMessageID: orphanAssistant, timestamp, finish: "tool-calls", cost: 1, tokens })
      const before = yield* database.db.select().from(SessionMessageTable).where(eq(SessionMessageTable.id, orphanAssistant)).get().pipe(Effect.orDie)
      if (!before) throw new Error("expected orphan assistant")
      const confirmed = Schema.decodeUnknownSync(SessionMessage.Message)({ ...before.data, id: before.id, type: before.type })
      if (confirmed.type !== "assistant") throw new Error("expected confirmed assistant")
      expect(confirmed).toMatchObject({ cost: 1, tokens })
      const balance = yield* database.db.select().from(RequestUsageTable).where(eq(RequestUsageTable.session_id, orphanSession)).get().pipe(Effect.orDie)
      const priorDetails = yield* usage.assistants({ sessionID: orphanSession, requestID: MessageID.make(orphanRequest) })
      // 零预算与recent均不执行C；用完整行比较约束其不写入，而非只检查最终状态。
      yield* SessionStaleTurn.reconcile({ kind: "exit-full" }, { budgetMs: 0 })
      expect(yield* database.db.select().from(SessionMessageTable).where(eq(SessionMessageTable.id, orphanAssistant)).get().pipe(Effect.orDie)).toEqual(before)
      yield* SessionStaleTurn.reconcile({ kind: "recent", limit: 16 })
      expect(yield* database.db.select().from(SessionMessageTable).where(eq(SessionMessageTable.id, orphanAssistant)).get().pipe(Effect.orDie)).toEqual(before)
      yield* SessionStaleTurn.reconcile({ kind: "exit-full" }, { budgetMs: 2000 })
      const after = yield* database.db.select().from(SessionMessageTable).where(eq(SessionMessageTable.id, orphanAssistant)).get().pipe(Effect.orDie)
      if (!after) throw new Error("expected settled orphan")
      const settled = Schema.decodeUnknownSync(SessionMessage.Message)({ ...after.data, id: after.id, type: after.type })
      if (settled.type !== "assistant") throw new Error("expected assistant")
      expect(settled.content.filter(part => part.type === "tool").map(part => part.state.status)).toEqual(["error"])
      // Tool.Failed不改变助手的原有完成时间/费用/Token或请求账本，幂等重扫也不改变它们。
      expect(after.data.time).toEqual(before.data.time)
      expect(settled.tokens).toEqual(confirmed.tokens)
      expect(settled.cost).toEqual(confirmed.cost)
      expect(yield* database.db.select().from(RequestUsageTable).where(eq(RequestUsageTable.session_id, orphanSession)).get().pipe(Effect.orDie)).toEqual(balance)
      expect(yield* usage.assistants({ sessionID: orphanSession, requestID: MessageID.make(orphanRequest) })).toEqual(priorDetails)
      yield* SessionStaleTurn.reconcile({ kind: "exit-full" }, { budgetMs: 2000 })
      expect(yield* database.db.select().from(SessionMessageTable).where(eq(SessionMessageTable.id, orphanAssistant)).get().pipe(Effect.orDie)).toEqual(after)
      const waiting = yield* database.db.select().from(SessionInputTable).where(eq(SessionInputTable.id, ids[1])).get().pipe(Effect.orDie)
      expect(waiting?.promoted_seq).toBeNull()
    }),
  )

  // 行为：二次 reconcile 幂等，防止 double-start / 重复 exit 改写已终态字段。
  it.instance(
    "second reconcile is idempotent",
    () =>
      Effect.gen(function* () {
        const sessions = yield* SessionNs.Service
        const chat = yield* sessions.create({ title: "stale-idempotent" })
        const seeded = yield* seedIncompleteTurn(sessions, chat.id)

        yield* SessionStaleTurn.reconcile({ kind: "recent", limit: 16 })
        const first = yield* MessageV2.get({ sessionID: chat.id, messageID: seeded.assistant.id })
        // 两次均消费同一服务图的数据库与事件，不使用测试专用第二执行器。
        yield* SessionStaleTurn.reconcile({ kind: "recent", limit: 16 })
        const second = yield* MessageV2.get({ sessionID: chat.id, messageID: seeded.assistant.id })

        if (first.info.role !== "assistant" || second.info.role !== "assistant") throw new Error("expected assistant")
        // 二次调用不得推进 time.completed 或改写 tool 快照（幂等 INV-05）。
        expect(second.info.time.completed).toBe(first.info.time.completed)
        expect(second.info.error).toEqual(first.info.error)
        const firstTool = first.parts.find((part) => part.id === seeded.tool.id)
        const secondTool = second.parts.find((part) => part.id === seeded.tool.id)
        expect(secondTool).toEqual(firstTool)
      }),
    { git: true },
  )
})
