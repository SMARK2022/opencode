import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { eq } from "drizzle-orm"
import { Session as SessionNs } from "@/session/session"
import { MessageV2 } from "@/session/message-v2"
import { MessageID, PartID, type SessionID } from "@/session/schema"
import { ModelID, ProviderID } from "@/provider/schema"
import { SessionStaleTurn } from "@/session/stale-turn"
import { SessionProcessor } from "@/session/processor"
import { Database } from "@/storage/db"
import { RequestUsageTable } from "@/session/request-usage.sql"
import { Bus } from "@/bus"
import { Storage } from "@/storage/storage"
import { SyncEvent } from "@/sync"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { BackgroundJob } from "@/background/job"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { testEffect } from "../lib/effect"
import { provideInstance, tmpdirScoped } from "../fixture/fixture"
import * as Log from "@opencode-ai/core/util/log"

void Log.init({ print: false })

// 测试层只提供 Session + SyncEvent，与 worker 调用 SessionStaleTurn 时的最小依赖一致。
// experimentalWorkspaces=false：避免 event-log 旁路干扰 publish:false 投影路径。
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

// 构造 crash 残留：incomplete assistant + pending tool + running usage。
// 对应真实 daemon 死亡现场，而不是 live cancel 的内存 runner 状态。
// seed 经 Session.update*（有 instance）写入；reconcile 本身必须在无 InstanceRef 下仍可执行。
function seedIncompleteTurn(sessions: SessionNs.Interface, sessionID: SessionID) {
  return Effect.gen(function* () {
    const userID = MessageID.ascending()
    yield* sessions.updateMessage({
      id: userID,
      sessionID,
      role: "user",
      time: { created: Date.now() },
      agent: "build",
      model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test") },
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
      modelID: ModelID.make("test"),
      providerID: ProviderID.make("test"),
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
    Database.use((db) => {
      db.insert(RequestUsageTable)
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
    })
    return { userID, assistant, tool }
  })
}

describe("SessionStaleTurn", () => {
  // 行为：owner-transition reconcile 把 incomplete assistant 写成 cancel 等价终态（time.completed + MessageAbortedError）。
  // 这是 INV-01 / 用户可见 “· interrupted” 的 durable 前提。
  it.live("recent reconcile terminalizes incomplete assistant in top sessions", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionNs.Service
      const dir = yield* tmpdirScoped({ git: true })
      const chat = yield* provideInstance(dir)(sessions.create({ title: "stale-recent" }))
      const seeded = yield* provideInstance(dir)(seedIncompleteTurn(sessions, chat.id))

      // 期望值来自 cancel 合同字面量，不复制 reconcile 内部算法。
      yield* Effect.promise(() => SessionStaleTurn.reconcile({ kind: "recent", limit: 16 }))

      const msg = yield* MessageV2.get({ sessionID: chat.id, messageID: seeded.assistant.id })
      expect(msg.info.role).toBe("assistant")
      if (msg.info.role !== "assistant") return
      // time.completed 存在即退出 streaming；error.name 驱动 TUI interrupted 后缀。
      expect(msg.info.time.completed).toBeDefined()
      expect(msg.info.error?.name).toBe("MessageAbortedError")
    }),
  )

  // 行为：open tool 必须带 TOOL_ABORTED_ERROR + interrupted metadata。
  // UI 与 LLM 回放都依赖该合同；新文案会分叉 “· interrupted” 路径。
  it.live("recent reconcile aborts open tools with interrupted metadata", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionNs.Service
      const dir = yield* tmpdirScoped({ git: true })
      const chat = yield* provideInstance(dir)(sessions.create({ title: "stale-tool" }))
      const seeded = yield* provideInstance(dir)(seedIncompleteTurn(sessions, chat.id))

      yield* Effect.promise(() => SessionStaleTurn.reconcile({ kind: "recent", limit: 16 }))

      const msg = yield* MessageV2.get({ sessionID: chat.id, messageID: seeded.assistant.id })
      const tool = msg.parts.find((part) => part.id === seeded.tool.id)
      expect(tool?.type).toBe("tool")
      if (tool?.type !== "tool") return
      expect(tool.state.status).toBe("error")
      if (tool.state.status !== "error") return
      // 独立字面量：与 SessionProcessor 导出常量对齐，防止实现方另造 error 字符串。
      expect(tool.state.error).toBe(SessionProcessor.TOOL_ABORTED_ERROR)
      expect(tool.state.metadata?.interrupted).toBe(true)
    }),
  )

  // 行为：running usage 必须变为 aborted，避免计费/状态聚合长期卡在 running。
  it.live("recent reconcile aborts running request usage", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionNs.Service
      const dir = yield* tmpdirScoped({ git: true })
      const chat = yield* provideInstance(dir)(sessions.create({ title: "stale-usage" }))
      const seeded = yield* provideInstance(dir)(seedIncompleteTurn(sessions, chat.id))

      yield* Effect.promise(() => SessionStaleTurn.reconcile({ kind: "recent", limit: 16 }))

      const row = Database.use((db) =>
        db
          .select()
          .from(RequestUsageTable)
          .where(eq(RequestUsageTable.request_id, seeded.userID))
          .get(),
      )
      // status 与 time_completed 对齐 RequestUsage.complete(aborted) 字段合同。
      expect(row?.status).toBe("aborted")
      expect(row?.time_completed).toBeDefined()
    }),
  )

  // INV-08：reconcile 不得依赖 InstanceRef（必须走 publish:false）。
  // worker boot/exit 没有 directory instance；若误走 Session.update* 会在 InstanceState.context 处失败。
  it.live("reconcile succeeds without instance context", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionNs.Service
      const dir = yield* tmpdirScoped({ git: true })
      const chat = yield* provideInstance(dir)(sessions.create({ title: "stale-no-instance" }))
      const seeded = yield* provideInstance(dir)(seedIncompleteTurn(sessions, chat.id))

      // 在无 InstanceRef 的 fiber 上调用：不得抛 InstanceState.context 错误。
      yield* Effect.promise(() => SessionStaleTurn.reconcile({ kind: "recent", limit: 16 }))

      const msg = yield* MessageV2.get({ sessionID: chat.id, messageID: seeded.assistant.id })
      if (msg.info.role !== "assistant") throw new Error("expected assistant")
      // 成功本身即证明无 InstanceRef 路径可写 durable 终态。
      expect(msg.info.time.completed).toBeDefined()
    }),
  )

  // 行为：exit-full C 步关闭“message 已 completed 但 tool 仍 open”的孤儿。
  // cancelSnapshot 故意跳过 completed assistant，因此必须 tool-only 终端化且不改写 message.error。
  it.live("exit-full closes orphan open tool on completed message", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionNs.Service
      const dir = yield* tmpdirScoped({ git: true })
      const chat = yield* provideInstance(dir)(sessions.create({ title: "stale-orphan" }))
      const userID = MessageID.ascending()
      yield* provideInstance(dir)(
        sessions.updateMessage({
          id: userID,
          sessionID: chat.id,
          role: "user",
          time: { created: Date.now() },
          agent: "build",
          model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test") },
        }),
      )
      const assistantID = MessageID.ascending()
      yield* provideInstance(dir)(
        sessions.updateMessage({
          id: assistantID,
          sessionID: chat.id,
          role: "assistant",
          parentID: userID,
          mode: "build",
          agent: "build",
          path: { cwd: "/tmp", root: "/tmp" },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: ModelID.make("test"),
          providerID: ProviderID.make("test"),
          time: { created: Date.now(), completed: Date.now() },
          error: new MessageV2.AbortedError({ message: "Aborted" }).toObject(),
        }),
      )
      const partID = PartID.ascending()
      yield* provideInstance(dir)(
        sessions.updatePart({
          id: partID,
          sessionID: chat.id,
          messageID: assistantID,
          type: "tool",
          tool: "bash",
          callID: "call_orphan",
          state: { status: "running", input: {}, time: { start: Date.now() } },
        }),
      )

      yield* Effect.promise(() => SessionStaleTurn.reconcile({ kind: "exit-full" }, { budgetMs: 5_000 }))

      const msg = yield* MessageV2.get({ sessionID: chat.id, messageID: assistantID })
      const tool = msg.parts.find((part) => part.id === partID)
      expect(tool?.type).toBe("tool")
      if (tool?.type !== "tool" || tool.state.status !== "error") throw new Error("expected aborted tool")
      expect(tool.state.error).toBe(SessionProcessor.TOOL_ABORTED_ERROR)
      // message 已 terminal：孤儿路径不得改写 error（历史终态语义）。
      if (msg.info.role !== "assistant") throw new Error("expected assistant")
      expect(msg.info.error?.name).toBe("MessageAbortedError")
    }),
  )

  // 行为：budgetMs=0 表示 dispose 吃光 worker 5s 窗口，exit-full 必须整段跳过（残留交给下次 L1）。
  it.live("exit-full with budgetMs 0 leaves incomplete state unchanged", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionNs.Service
      const dir = yield* tmpdirScoped({ git: true })
      const chat = yield* provideInstance(dir)(sessions.create({ title: "stale-budget-zero" }))
      const seeded = yield* provideInstance(dir)(seedIncompleteTurn(sessions, chat.id))

      // budgetMs=0 是 worker residual 计算的边界：remaining<=0 时不得触碰 SQLite 行。
      yield* Effect.promise(() => SessionStaleTurn.reconcile({ kind: "exit-full" }, { budgetMs: 0 }))

      const msg = yield* MessageV2.get({ sessionID: chat.id, messageID: seeded.assistant.id })
      if (msg.info.role !== "assistant") throw new Error("expected assistant")
      expect(msg.info.time.completed).toBeUndefined()
    }),
  )

  // 行为：二次 reconcile 幂等，防止 double-start / 重复 exit 改写已终态字段。
  it.live("second reconcile is idempotent", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionNs.Service
      const dir = yield* tmpdirScoped({ git: true })
      const chat = yield* provideInstance(dir)(sessions.create({ title: "stale-idempotent" }))
      const seeded = yield* provideInstance(dir)(seedIncompleteTurn(sessions, chat.id))

      yield* Effect.promise(() => SessionStaleTurn.reconcile({ kind: "recent", limit: 16 }))
      const first = yield* MessageV2.get({ sessionID: chat.id, messageID: seeded.assistant.id })
      yield* Effect.promise(() => SessionStaleTurn.reconcile({ kind: "recent", limit: 16 }))
      const second = yield* MessageV2.get({ sessionID: chat.id, messageID: seeded.assistant.id })

      if (first.info.role !== "assistant" || second.info.role !== "assistant") throw new Error("expected assistant")
      // 二次调用不得推进 time.completed 或改写 tool 快照（幂等 INV-05）。
      expect(second.info.time.completed).toBe(first.info.time.completed)
      expect(second.info.error).toEqual(first.info.error)
      const firstTool = first.parts.find((part) => part.id === seeded.tool.id)
      const secondTool = second.parts.find((part) => part.id === seeded.tool.id)
      expect(secondTool).toEqual(firstTool)
    }),
  )
})
