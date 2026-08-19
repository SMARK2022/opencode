import { expect, test } from "bun:test"
import { Effect } from "effect"
import * as DateTime from "effect/DateTime"
import { SessionID } from "../../src/session/schema"
import { EventV2 } from "@opencode-ai/core/event"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionMessageUpdater } from "@opencode-ai/core/session/message-updater"
import { SessionMessage } from "@opencode-ai/core/session/message"

test.skip("step snapshots carry over to assistant messages", () => {
  const state: SessionMessageUpdater.MemoryState = { messages: [] }
  const sessionID = SessionID.make("session")
  const assistantMessageID = SessionMessage.ID.create()

  Effect.runSync(
    SessionMessageUpdater.update(SessionMessageUpdater.memory(state), {
      id: EventV2.ID.create(),
      type: "session.next.step.started",
      data: {
        sessionID,
        assistantMessageID,
        timestamp: DateTime.makeUnsafe(1),
        agent: "build",
        model: {
          id: ModelV2.ID.make("model"),
          providerID: ProviderV2.ID.make("provider"),
          variant: ModelV2.VariantID.make("default"),
        },
        snapshot: "before",
      },
    } satisfies SessionEvent.Event),
  )

  expect(state.messages).toEqual([])

  Effect.runSync(
    SessionMessageUpdater.update(SessionMessageUpdater.memory(state), {
      id: EventV2.ID.create(),
      type: "session.next.step.ended",
      data: {
        sessionID,
        assistantMessageID,
        timestamp: DateTime.makeUnsafe(2),
        finish: "stop",
        cost: 0,
        tokens: {
          input: 1,
          output: 2,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
        snapshot: "after",
      },
    } satisfies SessionEvent.Event),
  )

  expect(state.messages[0]?.type).toBe("assistant")
  if (state.messages[0]?.type !== "assistant") return
  expect(state.messages[0].snapshot).toEqual({ start: "before", end: "after" })
  expect(state.messages[0].finish).toBe("stop")
})

test.skip("text ended populates assistant text content", () => {
  const state: SessionMessageUpdater.MemoryState = { messages: [] }
  const sessionID = SessionID.make("session")
  const assistantMessageID = SessionMessage.ID.create()

  Effect.runSync(
    SessionMessageUpdater.update(SessionMessageUpdater.memory(state), {
      id: EventV2.ID.create(),
      type: "session.next.step.started",
      data: {
        sessionID,
        assistantMessageID,
        timestamp: DateTime.makeUnsafe(1),
        agent: "build",
        model: {
          id: ModelV2.ID.make("model"),
          providerID: ProviderV2.ID.make("provider"),
          variant: ModelV2.VariantID.make("default"),
        },
      },
    } satisfies SessionEvent.Event),
  )

  Effect.runSync(
    SessionMessageUpdater.update(SessionMessageUpdater.memory(state), {
      id: EventV2.ID.create(),
      type: "session.next.text.started",
      data: {
        sessionID,
        assistantMessageID,
        timestamp: DateTime.makeUnsafe(2),
        textID: "text-1",
      },
    } satisfies SessionEvent.Event),
  )

  Effect.runSync(
    SessionMessageUpdater.update(SessionMessageUpdater.memory(state), {
      id: EventV2.ID.create(),
      type: "session.next.text.ended",
      data: {
        sessionID,
        assistantMessageID,
        timestamp: DateTime.makeUnsafe(3),
        textID: "text-1",
        text: "hello assistant",
      },
    } satisfies SessionEvent.Event),
  )

  expect(state.messages[0]?.type).toBe("assistant")
  if (state.messages[0]?.type !== "assistant") return
  expect(state.messages[0].content).toEqual([{ type: "text", id: "text-1", text: "hello assistant" }])
})

test.skip("tool completion stores completed timestamp", () => {
  const state: SessionMessageUpdater.MemoryState = { messages: [] }
  const sessionID = SessionID.make("session")
  const callID = "call"
  const assistantMessageID = SessionMessage.ID.create()

  Effect.runSync(
    SessionMessageUpdater.update(SessionMessageUpdater.memory(state), {
      id: EventV2.ID.create(),
      type: "session.next.step.started",
      data: {
        sessionID,
        assistantMessageID,
        timestamp: DateTime.makeUnsafe(1),
        agent: "build",
        model: {
          id: ModelV2.ID.make("model"),
          providerID: ProviderV2.ID.make("provider"),
          variant: ModelV2.VariantID.make("default"),
        },
      },
    } satisfies SessionEvent.Event),
  )

  Effect.runSync(
    SessionMessageUpdater.update(SessionMessageUpdater.memory(state), {
      id: EventV2.ID.create(),
      type: "session.next.tool.input.started",
      data: {
        sessionID,
        assistantMessageID,
        timestamp: DateTime.makeUnsafe(2),
        callID,
        name: "bash",
      },
    } satisfies SessionEvent.Event),
  )

  Effect.runSync(
    SessionMessageUpdater.update(SessionMessageUpdater.memory(state), {
      id: EventV2.ID.create(),
      type: "session.next.tool.called",
      data: {
        sessionID,
        assistantMessageID,
        timestamp: DateTime.makeUnsafe(3),
        callID,
        tool: "bash",
        input: { command: "pwd" },
        provider: { executed: true, metadata: { fake: { source: "provider" } } },
      },
    } satisfies SessionEvent.Event),
  )

  Effect.runSync(
    SessionMessageUpdater.update(SessionMessageUpdater.memory(state), {
      id: EventV2.ID.create(),
      type: "session.next.tool.success",
      data: {
        sessionID,
        assistantMessageID,
        timestamp: DateTime.makeUnsafe(4),
        callID,
        structured: {},
        content: [{ type: "text", text: "/tmp" }],
        provider: { executed: true, metadata: { fake: { status: "done" } } },
      },
    } satisfies SessionEvent.Event),
  )

  expect(state.messages[0]?.type).toBe("assistant")
  if (state.messages[0]?.type !== "assistant") return
  expect(state.messages[0].content[0]?.type).toBe("tool")
  if (state.messages[0].content[0]?.type !== "tool") return
  expect(state.messages[0].content[0].time.completed).toEqual(DateTime.makeUnsafe(4))
  expect(state.messages[0].content[0].provider).toEqual({ executed: true, metadata: { fake: { status: "done" } } })
})

test("compaction events reduce to compaction message only when completed", () => {
  const state: SessionMessageUpdater.MemoryState = { messages: [] }
  const sessionID = SessionID.make("session")
  const id = EventV2.ID.create()
  const compactionID = SessionMessage.ID.create()

  Effect.runSync(
    SessionMessageUpdater.update(SessionMessageUpdater.memory(state), {
      id,
      type: "session.next.compaction.started",
      data: {
        sessionID,
        messageID: compactionID,
        timestamp: DateTime.makeUnsafe(1),
        reason: "auto",
      },
    } satisfies SessionEvent.Event),
  )

  expect(state.messages).toEqual([])

  Effect.runSync(
    SessionMessageUpdater.update(SessionMessageUpdater.memory(state), {
      id: EventV2.ID.create(),
      type: "session.next.compaction.delta",
      data: {
        sessionID,
        messageID: compactionID,
        timestamp: DateTime.makeUnsafe(2),
        text: "hello ",
      },
    } satisfies SessionEvent.Event),
  )

  Effect.runSync(
    SessionMessageUpdater.update(SessionMessageUpdater.memory(state), {
      id: EventV2.ID.create(),
      type: "session.next.compaction.delta",
      data: {
        sessionID,
        messageID: compactionID,
        timestamp: DateTime.makeUnsafe(3),
        text: "summary",
      },
    } satisfies SessionEvent.Event),
  )

  Effect.runSync(
    SessionMessageUpdater.update(SessionMessageUpdater.memory(state), {
      id: EventV2.ID.create(),
      type: "session.next.compaction.ended",
      data: {
        sessionID,
        messageID: compactionID,
        timestamp: DateTime.makeUnsafe(4),
        reason: "auto",
        text: "final summary",
        recent: "recent context",
      },
    } satisfies SessionEvent.Event),
  )

  expect(state.messages).toHaveLength(1)
  expect(state.messages[0]).toMatchObject({
    id: compactionID,
    type: "compaction",
    reason: "auto",
    summary: "final summary",
    recent: "recent context",
    time: { created: DateTime.makeUnsafe(4) },
  })
})

test("legacy retry without an owner stays no-op and the next step.started completes the stale assistant", () => {
  // #582：memory adapter 是 SQLite projector 与 live store 的共同语义基准，此处锁定即两处共同合同。
  const state: SessionMessageUpdater.MemoryState = { messages: [] }
  const sessionID = SessionID.make("session")
  const model = {
    id: ModelV2.ID.make("model"),
    providerID: ProviderV2.ID.make("provider"),
    variant: ModelV2.VariantID.make("default"),
  }

  const stepStarted = (assistantMessageID: SessionMessage.ID, time: number) =>
    ({
      id: EventV2.ID.create(),
      type: "session.next.step.started",
      // 目标事件 schema 以 assistantMessageID 声明归属：与 source 的全局 current 隐式定位不同，
      // 这使 stale 终结与追加可以独立定位而不依赖 adapter 内部顺序。
      data: { sessionID, assistantMessageID, timestamp: DateTime.makeUnsafe(time), agent: "build", model },
    }) satisfies SessionEvent.Event

  const firstID = SessionMessage.ID.create()
  const secondID = SessionMessage.ID.create()
  // 两条 Assistant 各自持有显式 ID：验证不依赖 ID 大小或生成顺序。
  Effect.runSync(SessionMessageUpdater.update(SessionMessageUpdater.memory(state), stepStarted(firstID, 1)))
  Effect.runSync(
    SessionMessageUpdater.update(SessionMessageUpdater.memory(state), {
      id: EventV2.ID.create(),
      type: "session.next.text.started",
      data: { sessionID, assistantMessageID: firstID, textID: "txt-1", timestamp: DateTime.makeUnsafe(2) },
    } satisfies SessionEvent.Event),
  )
  // Legacy无归属retry仍不猜测当前助手；Native带ID重试由runner回归独立覆盖。
  // 下一次Step.Started继续承担旧dual-write残留助手的终结。
  Effect.runSync(
    SessionMessageUpdater.update(SessionMessageUpdater.memory(state), {
      id: EventV2.ID.create(),
      type: "session.next.retried",
      data: {
        sessionID,
        timestamp: DateTime.makeUnsafe(3),
        attempt: 1,
        // RetryError 合同：message+isRetryable 必填；与 processor 熔断发出的
        // retryable APIError 形状保持一致，验证投影层不反序列化失败。
        error: { message: "over limit", isRetryable: true },
      },
    } satisfies SessionEvent.Event),
  )
  Effect.runSync(SessionMessageUpdater.update(SessionMessageUpdater.memory(state), stepStarted(secondID, 4)))
  // 此处故意不带assistantMessageID，只锁定Legacy兼容事件，不代表Native重试为空操作。
  // 新Step使用显式ID，仍不能把旧助手的错误归到新助手之外。
  Effect.runSync(
    SessionMessageUpdater.update(SessionMessageUpdater.memory(state), {
      id: EventV2.ID.create(),
      type: "session.next.step.failed",
      data: {
        sessionID,
        assistantMessageID: secondID,
        timestamp: DateTime.makeUnsafe(5),
        error: { type: "unknown", message: "terminal" },
      },
    } satisfies SessionEvent.Event),
  )

  expect(state.messages).toHaveLength(2)
  const stale = state.messages[0]
  if (stale?.type !== "assistant") return
  // retried 不产生新投影；下一次 Step.Started 把残留 Assistant 置 completed。
  // 该断言是长度断言的另一面：若 retried 曾投影，这里会指向错误的 Assistant。
  expect(stale.time.completed).toEqual(DateTime.makeUnsafe(4))
  const fresh = state.messages[1]
  if (fresh?.type !== "assistant") return
  // 终态 Step.Failed 只作用于当前 active Assistant：completed + finish=error；
  // stale 虽已 completed 但不受本次 error 污染，两条 Assistant 生命周期独立。
  expect(fresh.time.completed).toEqual(DateTime.makeUnsafe(5))
  expect(fresh.finish).toBe("error")
  expect(fresh.error).toEqual({ type: "unknown", message: "terminal" })
})
