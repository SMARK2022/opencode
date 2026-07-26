import { describe, expect, test } from "bun:test"
import { Effect, Option } from "effect"
import { Session as SessionNs } from "@/session/session"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, type SessionID } from "../../src/session/schema"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { NotFoundError } from "@/storage/storage"
import { ColdStorage } from "@/storage/cold"
import { Database } from "@/storage/db"
import { MessageTable, PartTable, SessionTable } from "@/session/session.sql"
import * as Log from "@opencode-ai/core/util/log"
import { testEffect } from "../lib/effect"

void Log.init({ print: false })

const it = testEffect(SessionNs.defaultLayer)

// 测试进程共享 preload SQLite；ColdStorage.status().coldOwners 是全库计数，不能当作当前 fixture 的局部结果。
// 只统计本 session 的 cold_ref owner，才能在 cold.test / processor 等同进程 suite 下稳定断言 thaw 副作用。
function sessionColdOwners(sessionID: SessionID) {
  return Database.use(
    (db) =>
      db
        .select({ cold_ref: MessageTable.cold_ref })
        .from(MessageTable)
        .where(Database.eq(MessageTable.session_id, sessionID))
        .all()
        .filter((row) => row.cold_ref).length +
      db
        .select({ cold_ref: PartTable.cold_ref })
        .from(PartTable)
        .where(Database.eq(PartTable.session_id, sessionID))
        .all()
        .filter((row) => row.cold_ref).length,
  )
}

const withSession = <A, E, R>(
  fn: (input: { session: SessionNs.Interface; sessionID: SessionID }) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const created = yield* session.create({})
      return { session, sessionID: created.id }
    }),
    fn,
    (input) => input.session.remove(input.sessionID).pipe(Effect.ignore),
  )

// Helper functions using Effect.gen
const fill = Effect.fn("Test.fill")(function* (
  sessionID: SessionID,
  count: number,
  time = (i: number) => Date.now() + i,
  partsPerMessage = 1,
) {
  const session = yield* SessionNs.Service
  const ids = [] as MessageID[]
  for (let i = 0; i < count; i++) {
    const id = MessageID.ascending()
    ids.push(id)
    yield* session.updateMessage({
      id,
      sessionID,
      role: "user",
      time: { created: time(i) },
      agent: "test",
      model: { providerID: "test", modelID: "test" },
      tools: {},
      mode: "",
    } as unknown as MessageV2.Info)
    // 多 Part cohort 让旧 locator 的 payload 扫描成本可见；固定形状仍只服务 Goal eligibility。
    for (let part = 0; part < partsPerMessage; part++) {
      yield* session.updatePart({
        id: PartID.ascending(),
        sessionID,
        messageID: id,
        type: "text",
        text: part === 0 ? `m${i}` : `m${i}-${part}`,
      })
    }
  }
  return ids
})

const addUser = Effect.fn("Test.addUser")(function* (sessionID: SessionID, text?: string) {
  const session = yield* SessionNs.Service
  const id = MessageID.ascending()
  yield* session.updateMessage({
    id,
    sessionID,
    role: "user",
    time: { created: Date.now() },
    agent: "test",
    model: { providerID: "test", modelID: "test" },
    tools: {},
    mode: "",
  } as unknown as MessageV2.Info)
  if (text) {
    yield* session.updatePart({
      id: PartID.ascending(),
      sessionID,
      messageID: id,
      type: "text",
      text,
    })
  }
  return id
})

const addAssistant = Effect.fn("Test.addAssistant")(function* (
  sessionID: SessionID,
  parentID: MessageID,
  opts?: { summary?: boolean; finish?: string; error?: MessageV2.Assistant["error"] },
) {
  const session = yield* SessionNs.Service
  const id = MessageID.ascending()
  yield* session.updateMessage({
    id,
    sessionID,
    role: "assistant",
    time: { created: Date.now() },
    parentID,
    modelID: ModelID.make("test"),
    providerID: ProviderID.make("test"),
    mode: "",
    agent: "default",
    path: { cwd: "/", root: "/" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    summary: opts?.summary,
    finish: opts?.finish,
    error: opts?.error,
  } as unknown as MessageV2.Info)
  return id
})

const addCompactionPart = Effect.fn("Test.addCompactionPart")(function* (
  sessionID: SessionID,
  messageID: MessageID,
  tailStartID?: MessageID,
) {
  const session = yield* SessionNs.Service
  yield* session.updatePart({
    id: PartID.ascending(),
    sessionID,
    messageID,
    type: "compaction",
    auto: true,
    tail_start_id: tailStartID,
  } as any)
})

describe("MessageV2.page", () => {
  it.instance("returns page result", () =>
    withSession(({ sessionID }) =>
      Effect.gen(function* () {
        yield* fill(sessionID, 2)

        const result = yield* MessageV2.page({ sessionID, limit: 10 })
        expect(result).toBeDefined()
        expect(result.items).toBeArray()
      }),
    ),
  )

  it.instance("pages backward with opaque cursors", () =>
    withSession(({ sessionID }) =>
      Effect.gen(function* () {
        const ids = yield* fill(sessionID, 6)

        const a = yield* MessageV2.page({ sessionID, limit: 2 })
        expect(a.items.map((item) => item.info.id)).toEqual(ids.slice(-2))
        expect(a.items.every((item) => item.parts.length === 1)).toBe(true)
        expect(a.more).toBe(true)
        expect(a.cursor).toBeTruthy()

        const b = yield* MessageV2.page({ sessionID, limit: 2, before: a.cursor! })
        expect(b.items.map((item) => item.info.id)).toEqual(ids.slice(-4, -2))
        expect(b.more).toBe(true)
        expect(b.cursor).toBeTruthy()

        const c = yield* MessageV2.page({ sessionID, limit: 2, before: b.cursor! })
        expect(c.items.map((item) => item.info.id)).toEqual(ids.slice(0, 2))
        expect(c.more).toBe(false)
        expect(c.cursor).toBeUndefined()
      }),
    ),
  )

  it.instance("returns items in chronological order within a page", () =>
    withSession(({ sessionID }) =>
      Effect.gen(function* () {
        const ids = yield* fill(sessionID, 4)

        const result = yield* MessageV2.page({ sessionID, limit: 4 })
        expect(result.items.map((item) => item.info.id)).toEqual(ids)
      }),
    ),
  )

  it.instance("returns empty items for session with no messages", () =>
    withSession(({ sessionID }) =>
      Effect.gen(function* () {
        const result = yield* MessageV2.page({ sessionID, limit: 10 })
        expect(result.items).toEqual([])
        expect(result.more).toBe(false)
        expect(result.cursor).toBeUndefined()
      }),
    ),
  )

  it.instance("fails with NotFoundError for non-existent session", () =>
    Effect.gen(function* () {
      const fake = "non-existent-session" as SessionID
      const error = yield* Effect.flip(MessageV2.page({ sessionID: fake, limit: 10 }))
      expect(error).toBeInstanceOf(NotFoundError)
      expect(error.message).toBe(`Session not found: ${fake}`)
    }),
  )

  it.instance("handles exact limit boundary", () =>
    withSession(({ sessionID }) =>
      Effect.gen(function* () {
        const ids = yield* fill(sessionID, 3)

        const result = yield* MessageV2.page({ sessionID, limit: 3 })
        expect(result.items.map((item) => item.info.id)).toEqual(ids)
        expect(result.more).toBe(false)
        expect(result.cursor).toBeUndefined()
      }),
    ),
  )

  it.instance("visible limit skips hidden Messages and thaws no hidden Parts", () =>
    withSession(({ session, sessionID }) =>
      Effect.gen(function* () {
        const ids = yield* fill(sessionID, 4)
        const hidden = yield* MessageV2.get({ sessionID, messageID: ids[3] })
        yield* session.updateMessage({ ...hidden.info, hidden: { time: Date.now(), reason: "undo" } })
        const visible = yield* MessageV2.get({ sessionID, messageID: ids[2] })
        const part = Option.getOrThrow(Option.fromNullishOr(visible.parts.find((item) => item.type === "text")))
        yield* session.updatePart({ ...part, type: "reasoning", text: "cold".repeat(512), time: { start: Date.now() }, hidden: { time: Date.now(), reason: "undo" } })
        expect(ColdStorage.freezeOwner({ type: "part", id: part.id, now: Date.now() + 1, olderThanMs: 0 }).type).toBe("frozen")
        const result = yield* MessageV2.page({ sessionID, limit: 1 })
        expect([result.items[0].info.id, result.items[0].parts, sessionColdOwners(sessionID)]).toEqual([ids[2], [], 1])
        expect(result.more).toBe(true)
      }),
    ),
  )

  it.instance(
    "bounded Goal query cost does not grow with old history",
    () =>
      Effect.gen(function* () {
        const sessions = yield* SessionNs.Service
        const smallSession = yield* sessions.create({})
        const largeSession = yield* sessions.create({})
        const smallIDs = yield* fill(smallSession.id, 256, (i: number) => Date.now() + i, 4)
        const largeIDs = yield* fill(largeSession.id, 6326, (i: number) => Date.now() + i, 4)

        const measure = (sessionID: SessionID) => {
          const p95s = Array.from({ length: 3 }, () => {
            for (let i = 0; i < 5; i++) MessageV2.goalChronology(sessionID)
            const samples = Array.from({ length: 20 }, () => {
              const started = performance.now()
              MessageV2.goalChronology(sessionID)
              return performance.now() - started
            }).sort((a, b) => a - b)
            return samples[18] ?? 0
          })
          return { p95s, p95: [...p95s].sort((a, b) => a - b)[1] ?? 0 }
        }

        const small = measure(smallSession.id)
        const large = measure(largeSession.id)
        small.p95s.forEach((value, index) => {
          const largeValue = large.p95s[index] ?? 0
          console.log(
            `goal-query-scale repetition=${index + 1} small_p95_ms=${value.toFixed(2)} large_p95_ms=${largeValue.toFixed(2)} delta_ms=${(
              largeValue - value
            ).toFixed(2)}`,
          )
        })
        console.log(
          `goal-query-scale median small_p95_ms=${small.p95.toFixed(2)} large_p95_ms=${large.p95.toFixed(2)} delta_ms=${(
            large.p95 - small.p95
          ).toFixed(2)}`,
        )

        expect(smallIDs.slice(-2)).toEqual(MessageV2.goalChronology(smallSession.id).map((message) => message.info.id))
        expect(largeIDs.slice(-2)).toEqual(MessageV2.goalChronology(largeSession.id).map((message) => message.info.id))
        expect(large.p95 - small.p95).toBeLessThanOrEqual(45)
        expect(large.p95).toBeLessThanOrEqual(100)
      }),
    90_000,
  )

  it.instance("Goal query excludes hidden and technical user rows before classification", () =>
    withSession(({ session, sessionID }) =>
      Effect.gen(function* () {
        const previous = yield* addUser(sessionID, "previous")
        const hiddenPartUser = yield* addUser(sessionID, "hidden part")
        const hiddenPartMessage = yield* MessageV2.get({ sessionID, messageID: hiddenPartUser })
        const hiddenText = hiddenPartMessage.parts.find((part) => part.type === "text")
        if (!hiddenText) throw new Error("hidden-part fixture did not create text")
        yield* session.updatePart({ ...hiddenText, hidden: { time: Date.now(), reason: "undo" } })

        const hiddenMessageUser = yield* addUser(sessionID, "hidden message")
        const hiddenMessage = yield* MessageV2.get({ sessionID, messageID: hiddenMessageUser })
        yield* session.updateMessage({ ...hiddenMessage.info, hidden: { time: Date.now(), reason: "undo" } })

        const technical = yield* addUser(sessionID)
        yield* addCompactionPart(sessionID, technical)
        const current = yield* addUser(sessionID, "current")

        expect(MessageV2.goalChronology(sessionID).map((message) => message.info.id)).toEqual([previous, current])
      }),
    ),
  )

  it.instance("hydrates multiple parts per message", () =>
    withSession(({ session, sessionID }) =>
      Effect.gen(function* () {
        const [id] = yield* fill(sessionID, 1)

        yield* session.updatePart({
          id: PartID.ascending(),
          sessionID,
          messageID: id,
          type: "text",
          text: "extra",
        })

        const result = yield* MessageV2.page({ sessionID, limit: 10 })
        expect(result.items).toHaveLength(1)
        expect(result.items[0].parts).toHaveLength(2)
      }),
    ),
  )

  it.instance("accepts cursors from fractional timestamps", () =>
    withSession(({ sessionID }) =>
      Effect.gen(function* () {
        const ids = yield* fill(sessionID, 4, (i: number) => 1000.5 + i)

        const a = yield* MessageV2.page({ sessionID, limit: 2 })
        const b = yield* MessageV2.page({ sessionID, limit: 2, before: a.cursor! })

        expect(a.items.map((item) => item.info.id)).toEqual(ids.slice(-2))
        expect(b.items.map((item) => item.info.id)).toEqual(ids.slice(0, 2))
      }),
    ),
  )

  it.instance("messages with same timestamp are ordered by id", () =>
    withSession(({ sessionID }) =>
      Effect.gen(function* () {
        const ids = yield* fill(sessionID, 4, () => 1000)

        const a = yield* MessageV2.page({ sessionID, limit: 2 })
        expect(a.items.map((item) => item.info.id)).toEqual(ids.slice(-2))
        expect(a.more).toBe(true)

        const b = yield* MessageV2.page({ sessionID, limit: 2, before: a.cursor! })
        expect(b.items.map((item) => item.info.id)).toEqual(ids.slice(0, 2))
        expect(b.more).toBe(false)
      }),
    ),
  )

  it.instance("does not return messages from other sessions", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const a = yield* session.create({})
      const b = yield* session.create({})
      yield* fill(a.id, 3)
      yield* fill(b.id, 2)

      const resultA = yield* MessageV2.page({ sessionID: a.id, limit: 10 })
      const resultB = yield* MessageV2.page({ sessionID: b.id, limit: 10 })
      expect(resultA.items).toHaveLength(3)
      expect(resultB.items).toHaveLength(2)
      expect(resultA.items.every((item) => item.info.sessionID === a.id)).toBe(true)
      expect(resultB.items.every((item) => item.info.sessionID === b.id)).toBe(true)

      yield* session.remove(a.id)
      yield* session.remove(b.id)
    }),
  )

  it.instance("large limit returns all messages without cursor", () =>
    withSession(({ sessionID }) =>
      Effect.gen(function* () {
        const ids = yield* fill(sessionID, 10)

        const result = yield* MessageV2.page({ sessionID, limit: 100 })
        expect(result.items).toHaveLength(10)
        expect(result.items.map((item) => item.info.id)).toEqual(ids)
        expect(result.more).toBe(false)
        expect(result.cursor).toBeUndefined()
      }),
    ),
  )
})

describe("MessageV2.stream", () => {
  it.instance("yields items newest first", () =>
    withSession(({ sessionID }) =>
      Effect.gen(function* () {
        const ids = yield* fill(sessionID, 5)

        const items = Array.from(MessageV2.stream(sessionID))
        expect(items.map((item) => item.info.id)).toEqual(ids.slice().reverse())
      }),
    ),
  )

  it.instance("yields nothing for empty session", () =>
    withSession(({ sessionID }) =>
      Effect.gen(function* () {
        const items = Array.from(MessageV2.stream(sessionID))
        expect(items).toHaveLength(0)
      }),
    ),
  )

  it.instance("yields single message", () =>
    withSession(({ sessionID }) =>
      Effect.gen(function* () {
        const ids = yield* fill(sessionID, 1)

        const items = Array.from(MessageV2.stream(sessionID))
        expect(items).toHaveLength(1)
        expect(items[0].info.id).toBe(ids[0])
      }),
    ),
  )

  it.instance("hydrates parts for each yielded message", () =>
    withSession(({ sessionID }) =>
      Effect.gen(function* () {
        yield* fill(sessionID, 3)

        const items = Array.from(MessageV2.stream(sessionID))
        for (const item of items) {
          expect(item.parts).toHaveLength(1)
          expect(item.parts[0].type).toBe("text")
        }
      }),
    ),
  )

  it.instance("handles sets exceeding internal page size", () =>
    withSession(({ sessionID }) =>
      Effect.gen(function* () {
        const ids = yield* fill(sessionID, 60)

        const items = Array.from(MessageV2.stream(sessionID))
        expect(items).toHaveLength(60)
        expect(items[0].info.id).toBe(ids[ids.length - 1])
        expect(items[59].info.id).toBe(ids[0])
      }),
    ),
  )

  it.instance("is a sync generator", () =>
    withSession(({ sessionID }) =>
      Effect.gen(function* () {
        yield* fill(sessionID, 1)

        const gen = MessageV2.stream(sessionID)
        const first = gen.next()
        // sync generator returns { value, done } directly, not a Promise
        expect(first).toHaveProperty("value")
        expect(first).toHaveProperty("done")
        expect(first.done).toBe(false)
      }),
    ),
  )
})

describe("MessageV2.parts", () => {
  it.instance("returns parts for a message", () =>
    withSession(({ sessionID }) =>
      Effect.gen(function* () {
        const [id] = yield* fill(sessionID, 1)

        const result = MessageV2.parts(id)
        expect(result).toHaveLength(1)
        expect(result[0].type).toBe("text")
        expect((result[0] as MessageV2.TextPart).text).toBe("m0")
      }),
    ),
  )

  it.instance("returns empty array for message with no parts", () =>
    withSession(({ sessionID }) =>
      Effect.gen(function* () {
        const id = yield* addUser(sessionID)

        const result = MessageV2.parts(id)
        expect(result).toEqual([])
      }),
    ),
  )

  it.instance("returns multiple parts in order", () =>
    withSession(({ session, sessionID }) =>
      Effect.gen(function* () {
        const [id] = yield* fill(sessionID, 1)

        yield* session.updatePart({
          id: PartID.ascending(),
          sessionID,
          messageID: id,
          type: "text",
          text: "second",
        })
        yield* session.updatePart({
          id: PartID.ascending(),
          sessionID,
          messageID: id,
          type: "text",
          text: "third",
        })

        const result = MessageV2.parts(id)
        expect(result).toHaveLength(3)
        expect((result[0] as MessageV2.TextPart).text).toBe("m0")
        expect((result[1] as MessageV2.TextPart).text).toBe("second")
        expect((result[2] as MessageV2.TextPart).text).toBe("third")
      }),
    ),
  )

  it.instance("returns empty for non-existent message id", () =>
    Effect.gen(function* () {
      yield* SessionNs.Service
      const result = MessageV2.parts(MessageID.ascending())
      expect(result).toEqual([])
    }),
  )

  it.instance("parts contain sessionID and messageID", () =>
    withSession(({ sessionID }) =>
      Effect.gen(function* () {
        const [id] = yield* fill(sessionID, 1)

        const result = MessageV2.parts(id)
        expect(result[0].sessionID).toBe(sessionID)
        expect(result[0].messageID).toBe(id)
      }),
    ),
  )
})

describe("MessageV2.get", () => {
  it.instance("returns message with hydrated parts", () =>
    withSession(({ sessionID }) =>
      Effect.gen(function* () {
        const [id] = yield* fill(sessionID, 1)

        const result = yield* MessageV2.get({ sessionID, messageID: id })
        expect(result.info.id).toBe(id)
        expect(result.info.sessionID).toBe(sessionID)
        expect(result.info.role).toBe("user")
        expect(result.parts).toHaveLength(1)
        expect((result.parts[0] as MessageV2.TextPart).text).toBe("m0")
      }),
    ),
  )

  it.instance("fails with NotFoundError for non-existent message", () =>
    withSession(({ sessionID }) =>
      Effect.gen(function* () {
        const messageID = MessageID.ascending()
        const error = yield* Effect.flip(MessageV2.get({ sessionID, messageID }))
        expect(error).toBeInstanceOf(NotFoundError)
        expect(error.message).toBe(`Message not found: ${messageID}`)
      }),
    ),
  )

  it.instance("scopes by session id", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const a = yield* session.create({})
      const b = yield* session.create({})
      const [id] = yield* fill(a.id, 1)

      const error = yield* Effect.flip(MessageV2.get({ sessionID: b.id, messageID: id }))
      expect(error).toBeInstanceOf(NotFoundError)
      expect(error.message).toBe(`Message not found: ${id}`)
      const result = yield* MessageV2.get({ sessionID: a.id, messageID: id })
      expect(result.info.id).toBe(id)

      yield* session.remove(a.id)
      yield* session.remove(b.id)
    }),
  )

  it.instance("returns message with multiple parts", () =>
    withSession(({ session, sessionID }) =>
      Effect.gen(function* () {
        const [id] = yield* fill(sessionID, 1)

        yield* session.updatePart({
          id: PartID.ascending(),
          sessionID,
          messageID: id,
          type: "text",
          text: "extra",
        })

        const result = yield* MessageV2.get({ sessionID, messageID: id })
        expect(result.parts).toHaveLength(2)
      }),
    ),
  )

  it.instance("returns assistant message with correct role", () =>
    withSession(({ session, sessionID }) =>
      Effect.gen(function* () {
        const uid = yield* addUser(sessionID, "hello")
        const aid = yield* addAssistant(sessionID, uid)

        yield* session.updatePart({
          id: PartID.ascending(),
          sessionID,
          messageID: aid,
          type: "text",
          text: "response",
        })

        const result = yield* MessageV2.get({ sessionID, messageID: aid })
        expect(result.info.role).toBe("assistant")
        expect(result.parts).toHaveLength(1)
        expect((result.parts[0] as MessageV2.TextPart).text).toBe("response")
      }),
    ),
  )

  it.instance("returns message with zero parts", () =>
    withSession(({ sessionID }) =>
      Effect.gen(function* () {
        const id = yield* addUser(sessionID)

        const result = yield* MessageV2.get({ sessionID, messageID: id })
        expect(result.info.id).toBe(id)
        expect(result.parts).toEqual([])
      }),
    ),
  )
})

describe("Session.messages", () => {
  it.instance("returns an empty bounded range for limit zero", () =>
    withSession(({ session, sessionID }) =>
      Effect.gen(function* () {
        yield* fill(sessionID, 3)
        // 0 是显式范围而不是“未提供”；退化为全量会在 cold session 上触发无意义持久预热。
        expect(yield* session.messages({ sessionID, limit: 0 })).toEqual([])
      }),
    ),
  )

  it.instance("returns all messages in chronological order across pages", () =>
    withSession(({ session, sessionID }) =>
      Effect.gen(function* () {
        const ids = yield* fill(sessionID, 55)
        const result = yield* session.messages({ sessionID })
        expect(result.map((item) => item.info.id)).toEqual(ids)
      }),
    ),
  )

  it.instance("fails with NotFoundError for non-existent session", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const fake = "non-existent-session" as SessionID
      const error = yield* Effect.flip(session.messages({ sessionID: fake }))
      expect(error).toBeInstanceOf(NotFoundError)
      expect(error.message).toBe(`Session not found: ${fake}`)
    }),
  )
})

describe("Session.findMessage", () => {
  it.instance("searches newest-first", () =>
    withSession(({ session, sessionID }) =>
      Effect.gen(function* () {
        const ids = yield* fill(sessionID, 3)
        const hiddenID = yield* addUser(sessionID)
        const hidden = yield* MessageV2.get({ sessionID, messageID: hiddenID })
        yield* session.updateMessage({ ...hidden.info, hidden: { time: Date.now(), reason: "undo" } })
        const result = yield* session.findMessage(sessionID, () => true)
        // 旧 findMessage 经 visible Session.messages 搜索；HotInfo 优化不能让更新但 hidden 的 Message 抢占结果。
        expect(Option.isSome(result) ? result.value.info.id : undefined).toBe(ids.at(-1))
      }),
    ),
  )

  it.instance("fails with NotFoundError for non-existent session", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const fake = "non-existent-session" as SessionID
      const error = yield* Effect.flip(session.findMessage(fake, () => true))
      expect(error).toBeInstanceOf(NotFoundError)
      expect(error.message).toBe(`Session not found: ${fake}`)
    }),
  )

  it.instance("scans HotInfo without thawing Parts until a Message matches", () =>
    withSession(({ session, sessionID }) =>
      Effect.gen(function* () {
        const userID = yield* addUser(sessionID)
        const output = "find-hot-output-".repeat(512)
        const partID = PartID.ascending()
        yield* session.updatePart({
          id: partID,
          sessionID,
          messageID: userID,
          type: "tool",
          callID: "find-hot-call",
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
        const hiddenPartID = PartID.ascending()
        yield* session.updatePart({
          id: hiddenPartID,
          sessionID,
          messageID: userID,
          type: "text",
          text: "hidden-find-part",
          hidden: { time: Date.now(), reason: "undo" },
        })
        Database.use((db) =>
          db
            .update(SessionTable)
            .set({ time_updated: Date.now() - 31 * 24 * 60 * 60 * 1000 })
            .where(Database.eq(SessionTable.id, sessionID))
            .run(),
        )
        expect(ColdStorage.freezeOwner({ type: "part", id: partID, now: Date.now() }).type).toBe("frozen")

        const none = yield* session.findMessage(sessionID, () => false)
        expect(Option.isNone(none)).toBe(true)
        // 无匹配扫描不得 thaw；session 级 cold 计数仍为 1。顺带调用 status() 确保 freeze 后 payload 元数据健康。
        expect(sessionColdOwners(sessionID)).toBe(1)
        expect(ColdStorage.status().coldOwners).toBeGreaterThanOrEqual(1)

        const match = yield* session.findMessage(sessionID, (info) => info.role === "user")
        expect(Option.isSome(match)).toBe(true)
        const matchedPart = Option.isSome(match) ? match.value.parts.find((part) => part.id === partID) : undefined
        expect(
          matchedPart?.type === "tool" && matchedPart.state.status === "completed" ? matchedPart.state.output : undefined,
        ).toBe(output)
        expect(Option.isSome(match) ? match.value.parts.some((part) => part.id === hiddenPartID) : true).toBe(false)
        expect(sessionColdOwners(sessionID)).toBe(0)
      }),
    ),
  )

  it.instance("bounds doom-loop history to preceding multi-assistant tool tail", () =>
    withSession(({ session, sessionID }) =>
      Effect.gen(function* () {
        const userID = yield* addUser(sessionID)
        const previousAssistantID = yield* addAssistant(sessionID, userID)
        const partIDs: PartID[] = []
        for (let i = 0; i < 5; i++) {
          const id = PartID.ascending()
          partIDs.push(id)
          yield* session.updatePart({
            id,
            sessionID,
            messageID: previousAssistantID,
            type: "tool",
            callID: `bounded-${i}`,
            tool: "read",
            state: {
              status: "completed",
              input: { i },
              output: `bounded-output-${i}`.repeat(256),
              title: "read",
              metadata: {},
              time: { start: i + 1, end: i + 2 },
            },
          })
        }
        const hiddenPartID = PartID.ascending()
        yield* session.updatePart({
          id: hiddenPartID,
          sessionID,
          messageID: previousAssistantID,
          type: "tool",
          callID: "bounded-hidden-part",
          tool: "read",
          hidden: { time: Date.now(), reason: "undo" },
          state: {
            status: "completed",
            input: { hidden: true },
            output: "hidden-part",
            title: "read",
            metadata: {},
            time: { start: 10, end: 11 },
          },
        })
        const hiddenAssistantID = yield* addAssistant(sessionID, userID)
        const hiddenAssistant = yield* MessageV2.get({ sessionID, messageID: hiddenAssistantID })
        yield* session.updateMessage({
          ...hiddenAssistant.info,
          hidden: { time: Date.now(), reason: "undo" },
        })
        yield* session.updatePart({
          id: PartID.ascending(),
          sessionID,
          messageID: hiddenAssistantID,
          type: "tool",
          callID: "bounded-hidden-assistant",
          tool: "read",
          state: {
            status: "completed",
            input: { hidden: true },
            output: "hidden-assistant",
            title: "read",
            metadata: {},
            time: { start: 12, end: 13 },
          },
        })
        // 跨多个 visible assistant 各 1 tool：limit=2 必须返回 2 条（单 previous-assistant 只会得到 1）。
        const midAssistantID = yield* addAssistant(sessionID, userID)
        const midPartID = PartID.ascending()
        yield* session.updatePart({
          id: midPartID,
          sessionID,
          messageID: midAssistantID,
          type: "tool",
          callID: "bounded-mid",
          tool: "read",
          state: {
            status: "error",
            input: { mid: true },
            error: "missing",
            time: { start: 14, end: 15 },
          },
        })
        const currentAssistantID = yield* addAssistant(sessionID, userID)
        Database.use((db) =>
          db
            .update(SessionTable)
            .set({ time_updated: Date.now() - 31 * 24 * 60 * 60 * 1000 })
            .where(Database.eq(SessionTable.id, sessionID))
            .run(),
        )
        for (const id of partIDs) {
          expect(ColdStorage.freezeOwner({ type: "part", id, now: Date.now() }).type).toBe("frozen")
        }

        // 旧全量 Session.messages 默认排除 hidden Message/Part；bounded seam 必须保持同一可见性语义。
        // 最近 3 条 visible non-pending tools：previous 末尾 2 条 + mid 1 条（hidden 不占配额）。
        const tail = MessageV2.previousAssistantToolTail({
          sessionID,
          before: { id: currentAssistantID, time: Date.now() },
          limit: 3,
        })
        expect(tail.map((part) => part.id)).toEqual([...partIDs.slice(-2), midPartID])
        expect(tail.every((part) => part.type === "tool" && part.state.status !== "pending")).toBe(true)
        // 有界 tail 只 thaw 选中 part；本 session 的 previous freeze tools 仍应保持 cold（至少 2）。
        expect(sessionColdOwners(sessionID)).toBeGreaterThanOrEqual(2)

        const two = MessageV2.previousAssistantToolTail({
          sessionID,
          before: { id: currentAssistantID, time: Date.now() },
          limit: 2,
        })
        // 证明跨 assistant：最近 2 条来自 previous 末尾 1 条 + mid，而非只扫 mid 一个 assistant。
        expect(two.map((part) => part.id)).toEqual([partIDs[partIDs.length - 1], midPartID])
      }),
    ),
  )
})

describe("MessageV2.filterCompacted", () => {
  it.instance("returns all messages when no compaction", () =>
    withSession(({ sessionID }) =>
      Effect.gen(function* () {
        const ids = yield* fill(sessionID, 5)

        const result = MessageV2.filterCompacted(MessageV2.stream(sessionID))
        expect(result).toHaveLength(5)
        // reversed from newest-first to chronological
        expect(result.map((item) => item.info.id)).toEqual(ids)
      }),
    ),
  )

  it.instance("stops at compaction boundary and returns chronological order", () =>
    withSession(({ session, sessionID }) =>
      Effect.gen(function* () {
        const old = yield* addUser(sessionID, "old question")
        // Chronological: u1(+compaction part), a1(summary, parentID=u1), u2, a2
        // Stream (newest first): a2, u2, a1(adds u1 to completed), u1(in completed + compaction) -> break
        const u1 = yield* addUser(sessionID, "first question")
        const a1 = yield* addAssistant(sessionID, u1, { summary: true, finish: "end_turn" })
        yield* session.updatePart({
          id: PartID.ascending(),
          sessionID,
          messageID: a1,
          type: "text",
          text: "summary",
        })
        const summary = yield* MessageV2.get({ sessionID, messageID: a1 })
        yield* session.updateMessage({ ...summary.info, hidden: { time: Date.now(), reason: "undo" } })
        yield* addCompactionPart(sessionID, u1)

        const u2 = yield* addUser(sessionID, "new question")
        const a2 = yield* addAssistant(sessionID, u2)
        yield* session.updatePart({
          id: PartID.ascending(),
          sessionID,
          messageID: a2,
          type: "text",
          text: "new response",
        })

        const result = yield* MessageV2.filterCompactedEffect(sessionID)
        expect(result.map((item) => item.info.id)).toEqual([old, u2, a2])
      }),
    ),
  )

  it.live("handles empty iterable", () =>
    Effect.sync(() => {
      const result = MessageV2.filterCompacted([])
      expect(result).toEqual([])
    }),
  )

  it.instance("drops compaction marker with a hidden Compaction Part", () =>
    withSession(({ session, sessionID }) =>
      Effect.gen(function* () {
        const u1 = yield* addUser(sessionID, "hello")
        yield* addCompactionPart(sessionID, u1)
        yield* addAssistant(sessionID, u1, { summary: true, finish: "end_turn" })
        const marker = yield* MessageV2.get({ sessionID, messageID: u1 })
        const part = marker.parts.find((item) => item.type === "compaction")
        if (!part) throw new Error("Expected Compaction Part")
        yield* session.updatePart({ ...part, hidden: { time: Date.now(), reason: "undo" } })
        const u2 = yield* addUser(sessionID, "world")

        const result = yield* MessageV2.filterCompactedEffect(sessionID)
        expect(result.map((item) => item.info.id)).toEqual([u2])
      }),
    ),
  )

  it.instance("drops compaction marker with errored summary", () =>
    withSession(({ sessionID }) =>
      Effect.gen(function* () {
        const old = yield* addUser(sessionID, "old")
        const completed = yield* addUser(sessionID)
        yield* addCompactionPart(sessionID, completed, old)
        const completedSummary = yield* addAssistant(sessionID, completed, { summary: true, finish: "end_turn" })
        const u1 = yield* addUser(sessionID, "hello")
        yield* addCompactionPart(sessionID, u1)

        const error = new MessageV2.APIError({
          message: "boom",
          isRetryable: true,
        }).toObject() as MessageV2.Assistant["error"]
        yield* addAssistant(sessionID, u1, { summary: true, finish: "end_turn", error })
        const retry = yield* addUser(sessionID, "retry")

        const result = yield* MessageV2.filterCompactedEffect(sessionID)
        expect(result.map((item) => item.info.id)).toEqual([completed, completedSummary, old, retry])
      }),
    ),
  )

  it.instance("drops compaction marker with unfinished summary", () =>
    withSession(({ sessionID }) =>
      Effect.gen(function* () {
        const u1 = yield* addUser(sessionID, "hello")
        yield* addCompactionPart(sessionID, u1)

        // summary=true but no finish
        yield* addAssistant(sessionID, u1, { summary: true })
        const next = yield* addUser(sessionID, "next")

        const result = MessageV2.filterCompacted(MessageV2.stream(sessionID))
        expect(result.map((item) => item.info.id)).toEqual([next])
      }),
    ),
  )

  it.instance("does not expose incomplete compaction as a runnable task", () =>
    withSession(({ sessionID }) =>
      Effect.gen(function* () {
        const u1 = yield* addUser(sessionID, "hello")
        yield* addCompactionPart(sessionID, u1)
        const u2 = yield* addUser(sessionID, "world")

        const result = MessageV2.latest(MessageV2.filterCompacted(MessageV2.stream(sessionID)))

        expect(result.user?.id).toBe(u2)
        expect(result.tasks).toEqual([])
      }),
    ),
  )

  it.instance("retains original tail when compaction stores tail_start_id", () =>
    withSession(({ session, sessionID }) =>
      Effect.gen(function* () {
        const u1 = yield* addUser(sessionID, "first")
        const a1 = yield* addAssistant(sessionID, u1, { finish: "end_turn" })
        yield* session.updatePart({
          id: PartID.ascending(),
          sessionID,
          messageID: a1,
          type: "text",
          text: "first reply",
        })

        const u2 = yield* addUser(sessionID, "second")
        const a2 = yield* addAssistant(sessionID, u2, { finish: "end_turn" })
        yield* session.updatePart({
          id: PartID.ascending(),
          sessionID,
          messageID: a2,
          type: "text",
          text: "second reply",
        })

        const c1 = yield* addUser(sessionID)
        yield* addCompactionPart(sessionID, c1, u2)
        const s1 = yield* addAssistant(sessionID, c1, { summary: true, finish: "end_turn" })
        yield* session.updatePart({
          id: PartID.ascending(),
          sessionID,
          messageID: s1,
          type: "text",
          text: "summary",
        })

        const u3 = yield* addUser(sessionID, "third")
        const a3 = yield* addAssistant(sessionID, u3, { finish: "end_turn" })
        yield* session.updatePart({
          id: PartID.ascending(),
          sessionID,
          messageID: a3,
          type: "text",
          text: "third reply",
        })

        const result = MessageV2.filterCompacted(MessageV2.stream(sessionID))

        expect(result.map((item) => item.info.id)).toEqual([c1, s1, u2, a2, u3, a3])
      }),
    ),
  )

  it.instance("uses hidden retained-tail anchors as boundaries without returning hidden messages", () =>
    withSession(({ session, sessionID }) =>
      Effect.gen(function* () {
        const old = yield* addUser(sessionID, "old request")
        const oldReply = yield* addAssistant(sessionID, old, { finish: "end_turn" })
        yield* session.updatePart({
          id: PartID.ascending(),
          sessionID,
          messageID: oldReply,
          type: "text",
          text: "old reply",
        })
        const anchor = yield* addAssistant(sessionID, old)
        const stored = yield* MessageV2.get({ sessionID, messageID: anchor })
        if (stored.info.role === "assistant") {
          yield* session.updateMessage({
            ...stored.info,
            time: { ...stored.info.time, completed: Date.now() },
            error: new MessageV2.AbortedError({ message: "Aborted" }).toObject(),
            hidden: { time: Date.now(), reason: "repair-empty-dangling-assistant" as const },
          })
        }

        const compact = yield* addUser(sessionID)
        yield* addCompactionPart(sessionID, compact, anchor)
        const summary = yield* addAssistant(sessionID, compact, { summary: true, finish: "stop" })
        yield* session.updatePart({
          id: PartID.ascending(),
          sessionID,
          messageID: summary,
          type: "text",
          text: "summary",
        })
        for (const id of [compact, summary]) {
          const message = yield* MessageV2.get({ sessionID, messageID: id })
          yield* session.updateMessage({ ...message.info, hidden: { time: Date.now(), reason: "undo" } })
        }
        const next = yield* addUser(sessionID, "next request")

        const result = yield* MessageV2.filterCompactedEffect(sessionID)

        expect(result.map((item) => item.info.id)).toEqual([next])
      }),
    ),
  )

  it.instance("fork remaps compaction tail_start_id for filterCompacted", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const created = yield* session.create({})

      const u1 = yield* addUser(created.id, "first")
      const a1 = yield* addAssistant(created.id, u1, { finish: "end_turn" })
      yield* session.updatePart({
        id: PartID.ascending(),
        sessionID: created.id,
        messageID: a1,
        type: "text",
        text: "first reply",
      })

      const u2 = yield* addUser(created.id, "second")
      const a2 = yield* addAssistant(created.id, u2, { finish: "end_turn" })
      yield* session.updatePart({
        id: PartID.ascending(),
        sessionID: created.id,
        messageID: a2,
        type: "text",
        text: "second reply",
      })

      const c1 = yield* addUser(created.id)
      yield* addCompactionPart(created.id, c1, u2)
      const s1 = yield* addAssistant(created.id, c1, { summary: true, finish: "end_turn" })
      yield* session.updatePart({
        id: PartID.ascending(),
        sessionID: created.id,
        messageID: s1,
        type: "text",
        text: "summary",
      })

      const u3 = yield* addUser(created.id, "third")
      const a3 = yield* addAssistant(created.id, u3, { finish: "end_turn" })
      yield* session.updatePart({
        id: PartID.ascending(),
        sessionID: created.id,
        messageID: a3,
        type: "text",
        text: "third reply",
      })

      const parentFiltered = MessageV2.filterCompacted(MessageV2.stream(created.id))
      expect(parentFiltered.map((item) => item.info.id)).toEqual([c1, s1, u2, a2, u3, a3])

      const forked = yield* session.fork({ sessionID: created.id })
      const childFiltered = MessageV2.filterCompacted(MessageV2.stream(forked.id))
      expect(childFiltered).toHaveLength(parentFiltered.length)

      const tailPart = childFiltered.flatMap((m) => m.parts).find((p) => p.type === "compaction")
      expect(tailPart?.type).toBe("compaction")
      if (!tailPart || tailPart.type !== "compaction") throw new Error("Expected forked compaction part")
      expect(tailPart.tail_start_id).toBeDefined()
      expect(childFiltered.some((m) => m.info.id === tailPart.tail_start_id)).toBe(true)

      yield* session.remove(forked.id)
      yield* session.remove(created.id)
    }),
  )

  it.instance("retains an assistant tail when compaction starts inside a turn", () =>
    withSession(({ session, sessionID }) =>
      Effect.gen(function* () {
        const u1 = yield* addUser(sessionID, "first")
        const a1 = yield* addAssistant(sessionID, u1, { finish: "end_turn" })
        yield* session.updatePart({
          id: PartID.ascending(),
          sessionID,
          messageID: a1,
          type: "text",
          text: "first reply",
        })

        const u2 = yield* addUser(sessionID, "second")
        const a2 = yield* addAssistant(sessionID, u2, { finish: "end_turn" })
        yield* session.updatePart({
          id: PartID.ascending(),
          sessionID,
          messageID: a2,
          type: "text",
          text: "second reply",
        })
        const a3 = yield* addAssistant(sessionID, u2, { finish: "end_turn" })
        yield* session.updatePart({
          id: PartID.ascending(),
          sessionID,
          messageID: a3,
          type: "text",
          text: "tail reply",
        })

        const c1 = yield* addUser(sessionID)
        yield* addCompactionPart(sessionID, c1, a3)
        const s1 = yield* addAssistant(sessionID, c1, { summary: true, finish: "end_turn" })
        yield* session.updatePart({
          id: PartID.ascending(),
          sessionID,
          messageID: s1,
          type: "text",
          text: "summary",
        })

        const u3 = yield* addUser(sessionID, "third")
        const a4 = yield* addAssistant(sessionID, u3, { finish: "end_turn" })
        yield* session.updatePart({
          id: PartID.ascending(),
          sessionID,
          messageID: a4,
          type: "text",
          text: "third reply",
        })

        const result = MessageV2.filterCompacted(MessageV2.stream(sessionID))

        expect(result.map((item) => item.info.id)).toEqual([c1, s1, a3, u3, a4])
      }),
    ),
  )

  it.instance("prefers latest compaction boundary when repeated compactions exist", () =>
    withSession(({ session, sessionID }) =>
      Effect.gen(function* () {
        const u1 = yield* addUser(sessionID, "first")
        const a1 = yield* addAssistant(sessionID, u1, { finish: "end_turn" })
        yield* session.updatePart({
          id: PartID.ascending(),
          sessionID,
          messageID: a1,
          type: "text",
          text: "first reply",
        })

        const u2 = yield* addUser(sessionID, "second")
        const a2 = yield* addAssistant(sessionID, u2, { finish: "end_turn" })
        yield* session.updatePart({
          id: PartID.ascending(),
          sessionID,
          messageID: a2,
          type: "text",
          text: "second reply",
        })

        const c1 = yield* addUser(sessionID)
        yield* addCompactionPart(sessionID, c1, u2)
        const s1 = yield* addAssistant(sessionID, c1, { summary: true, finish: "end_turn" })
        yield* session.updatePart({
          id: PartID.ascending(),
          sessionID,
          messageID: s1,
          type: "text",
          text: "summary one",
        })

        const u3 = yield* addUser(sessionID, "third")
        const a3 = yield* addAssistant(sessionID, u3, { finish: "end_turn" })
        yield* session.updatePart({
          id: PartID.ascending(),
          sessionID,
          messageID: a3,
          type: "text",
          text: "third reply",
        })

        const c2 = yield* addUser(sessionID)
        yield* addCompactionPart(sessionID, c2, u3)
        const s2 = yield* addAssistant(sessionID, c2, { summary: true, finish: "end_turn" })
        yield* session.updatePart({
          id: PartID.ascending(),
          sessionID,
          messageID: s2,
          type: "text",
          text: "summary two",
        })

        const u4 = yield* addUser(sessionID, "fourth")
        const a4 = yield* addAssistant(sessionID, u4, { finish: "end_turn" })
        yield* session.updatePart({
          id: PartID.ascending(),
          sessionID,
          messageID: a4,
          type: "text",
          text: "fourth reply",
        })

        const result = MessageV2.filterCompacted(MessageV2.stream(sessionID))

        expect(result.map((item) => item.info.id)).toEqual([c2, s2, u3, a3, u4, a4])
      }),
    ),
  )

  test("works with array input", () => {
    // filterCompacted accepts any Iterable, not just generators
    const id = MessageID.ascending()
    const items: MessageV2.WithParts[] = [
      {
        info: {
          id,
          sessionID: "s1",
          role: "user",
          time: { created: 1 },
          agent: "test",
          model: { providerID: "test", modelID: "test" },
        } as unknown as MessageV2.Info,
        parts: [{ type: "text", text: "hello" }] as unknown as MessageV2.Part[],
      },
    ]
    const result = MessageV2.filterCompacted(items)
    expect(result).toHaveLength(1)
    expect(result[0].info.id).toBe(id)
  })
})

describe("MessageV2.cursor", () => {
  test("encode/decode roundtrip", () => {
    const input = { id: MessageID.ascending(), time: 1234567890 }
    const encoded = MessageV2.cursor.encode(input)
    const decoded = MessageV2.cursor.decode(encoded)
    expect(decoded.id).toBe(input.id)
    expect(decoded.time).toBe(input.time)
  })

  test("encode/decode with fractional time", () => {
    const input = { id: MessageID.ascending(), time: 1234567890.5 }
    const encoded = MessageV2.cursor.encode(input)
    const decoded = MessageV2.cursor.decode(encoded)
    expect(decoded.time).toBe(1234567890.5)
  })

  test("encoded cursor is base64url", () => {
    const encoded = MessageV2.cursor.encode({ id: MessageID.ascending(), time: 0 })
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/)
  })
})

describe("MessageV2 consistency", () => {
  it.instance("page hydration matches get for each message", () =>
    withSession(({ sessionID }) =>
      Effect.gen(function* () {
        yield* fill(sessionID, 3)

        const paged = yield* MessageV2.page({ sessionID, limit: 10 })
        for (const item of paged.items) {
          const got = yield* MessageV2.get({ sessionID, messageID: item.info.id as MessageID })
          expect(got.info).toEqual(item.info)
          expect(got.parts).toEqual(item.parts)
        }
      }),
    ),
  )

  it.instance("parts from get match standalone parts call", () =>
    withSession(({ sessionID }) =>
      Effect.gen(function* () {
        const [id] = yield* fill(sessionID, 1)

        const got = yield* MessageV2.get({ sessionID, messageID: id })
        const standalone = MessageV2.parts(id)
        expect(got.parts).toEqual(standalone)
      }),
    ),
  )

  it.instance("stream collects same messages as exhaustive page iteration", () =>
    withSession(({ sessionID }) =>
      Effect.gen(function* () {
        yield* fill(sessionID, 7)

        const streamed = Array.from(MessageV2.stream(sessionID))

        const paged = [] as MessageV2.WithParts[]
        let cursor: string | undefined
        while (true) {
          const result = yield* MessageV2.page({ sessionID, limit: 3, before: cursor })
          for (let i = result.items.length - 1; i >= 0; i--) {
            paged.push(result.items[i])
          }
          if (!result.more || !result.cursor) break
          cursor = result.cursor
        }

        expect(streamed.map((m) => m.info.id)).toEqual(paged.map((m) => m.info.id))
      }),
    ),
  )

  it.instance("filterCompacted of full stream returns same as Array.from when no compaction", () =>
    withSession(({ sessionID }) =>
      Effect.gen(function* () {
        yield* fill(sessionID, 4)

        const filtered = MessageV2.filterCompacted(MessageV2.stream(sessionID))
        const all = Array.from(MessageV2.stream(sessionID)).reverse()

        expect(filtered.map((m) => m.info.id)).toEqual(all.map((m) => m.info.id))
      }),
    ),
  )
})
