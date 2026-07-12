import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect, Exit, Layer } from "effect"
import { Session } from "@/session/session"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { SessionRevert } from "../../src/session/revert"
import { SessionRunState } from "../../src/session/run-state"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionRequestUsage } from "../../src/session/request-usage"
import { Snapshot } from "../../src/snapshot"
import * as Log from "@opencode-ai/core/util/log"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

void Log.init({ print: false })

const env = Layer.mergeAll(
  Session.defaultLayer,
  SessionRevert.defaultLayer,
  SessionRequestUsage.defaultLayer,
  Snapshot.defaultLayer,
  CrossSpawnSpawner.defaultLayer,
  SessionRunState.defaultLayer,
)

const it = testEffect(env)

const user = Effect.fn("test.user")(function* (sessionID: SessionID, agent = "default") {
  const session = yield* Session.Service
  return yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user" as const,
    sessionID,
    agent,
    model: { providerID: ProviderID.make("openai"), modelID: ModelID.make("gpt-4") },
    time: { created: Date.now() },
  })
})

const assistant = Effect.fn("test.assistant")(function* (sessionID: SessionID, parentID: MessageID, dir: string) {
  const session = yield* Session.Service
  return yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "assistant" as const,
    sessionID,
    mode: "default",
    agent: "default",
    path: { cwd: dir, root: dir },
    cost: 0,
    tokens: { output: 0, input: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ModelID.make("gpt-4"),
    providerID: ProviderID.make("openai"),
    parentID,
    time: { created: Date.now() },
    finish: "end_turn",
  })
})

const text = Effect.fn("test.text")(function* (sessionID: SessionID, messageID: MessageID, content: string) {
  const session = yield* Session.Service
  return yield* session.updatePart({
    id: PartID.ascending(),
    messageID,
    sessionID,
    type: "text" as const,
    text: content,
  })
})

const tool = Effect.fn("test.tool")(function* (sessionID: SessionID, messageID: MessageID) {
  const session = yield* Session.Service
  return yield* session.updatePart({
    id: PartID.ascending(),
    messageID,
    sessionID,
    type: "tool" as const,
    tool: "bash",
    callID: "call-1",
    state: {
      status: "completed" as const,
      input: {},
      output: "done",
      title: "",
      metadata: {},
      time: { start: 0, end: 1 },
    },
  })
})

const read = (file: string) => Effect.promise(() => fs.readFile(file, "utf-8"))
const write = (file: string, text: string) => Effect.promise(() => fs.writeFile(file, text))

const tokens = {
  input: 0,
  output: 0,
  reasoning: 0,
  cache: { read: 0, write: 0 },
}

describe("revert + compact workflow", () => {
  it.live(
    "should properly handle compact command after revert",
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const session = yield* Session.Service
          const revert = yield* SessionRevert.Service

          const info = yield* session.create({})
          const sessionID = info.id

          const userMsg1 = yield* session.updateMessage({
            id: MessageID.ascending(),
            role: "user",
            sessionID,
            agent: "default",
            model: {
              providerID: ProviderID.make("openai"),
              modelID: ModelID.make("gpt-4"),
            },
            time: {
              created: Date.now(),
            },
          })

          yield* session.updatePart({
            id: PartID.ascending(),
            messageID: userMsg1.id,
            sessionID,
            type: "text",
            text: "Hello, please help me",
          })

          const assistantMsg1: MessageV2.Assistant = {
            id: MessageID.ascending(),
            role: "assistant",
            sessionID,
            mode: "default",
            agent: "default",
            path: {
              cwd: dir,
              root: dir,
            },
            cost: 0,
            tokens: {
              output: 0,
              input: 0,
              reasoning: 0,
              cache: { read: 0, write: 0 },
            },
            modelID: ModelID.make("gpt-4"),
            providerID: ProviderID.make("openai"),
            parentID: userMsg1.id,
            time: {
              created: Date.now(),
            },
            finish: "end_turn",
          }
          yield* session.updateMessage(assistantMsg1)

          yield* session.updatePart({
            id: PartID.ascending(),
            messageID: assistantMsg1.id,
            sessionID,
            type: "text",
            text: "Sure, I'll help you!",
          })

          const userMsg2 = yield* session.updateMessage({
            id: MessageID.ascending(),
            role: "user",
            sessionID,
            agent: "default",
            model: {
              providerID: ProviderID.make("openai"),
              modelID: ModelID.make("gpt-4"),
            },
            time: {
              created: Date.now(),
            },
          })

          yield* session.updatePart({
            id: PartID.ascending(),
            messageID: userMsg2.id,
            sessionID,
            type: "text",
            text: "What's the capital of France?",
          })

          const assistantMsg2: MessageV2.Assistant = {
            id: MessageID.ascending(),
            role: "assistant",
            sessionID,
            mode: "default",
            agent: "default",
            path: {
              cwd: dir,
              root: dir,
            },
            cost: 0,
            tokens: {
              output: 0,
              input: 0,
              reasoning: 0,
              cache: { read: 0, write: 0 },
            },
            modelID: ModelID.make("gpt-4"),
            providerID: ProviderID.make("openai"),
            parentID: userMsg2.id,
            time: {
              created: Date.now(),
            },
            finish: "end_turn",
          }
          yield* session.updateMessage(assistantMsg2)

          yield* session.updatePart({
            id: PartID.ascending(),
            messageID: assistantMsg2.id,
            sessionID,
            type: "text",
            text: "The capital of France is Paris.",
          })

          let messages = yield* session.messages({ sessionID })
          expect(messages.length).toBe(4)
          const messageIds = messages.map((m) => m.info.id)
          expect(messageIds).toContain(userMsg1.id)
          expect(messageIds).toContain(userMsg2.id)
          expect(messageIds).toContain(assistantMsg1.id)
          expect(messageIds).toContain(assistantMsg2.id)

          yield* revert.revert({
            sessionID,
            messageID: userMsg2.id,
          })

          let sessionInfo = yield* session.get(sessionID)
          expect(sessionInfo.revert).toBeDefined()
          expect(sessionInfo.revert?.messageID).toBeDefined()

          messages = yield* session.messages({ sessionID })
          expect(messages.length).toBe(4)

          yield* revert.cleanup(sessionInfo)

          messages = yield* session.messages({ sessionID })
          const remainingIds = messages.map((m) => m.info.id)
          expect(messages.length).toBeLessThan(4)
          expect(remainingIds).not.toContain(userMsg2.id)
          expect(remainingIds).not.toContain(assistantMsg2.id)

          sessionInfo = yield* session.get(sessionID)
          expect(sessionInfo.revert).toBeUndefined()

          yield* session.remove(sessionID)
        }),
      { git: true },
    ),
  )

  it.live(
    "should properly clean up revert state before creating compaction message",
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const session = yield* Session.Service
          const revert = yield* SessionRevert.Service

          const info = yield* session.create({})
          const sessionID = info.id

          const userMsg = yield* session.updateMessage({
            id: MessageID.ascending(),
            role: "user",
            sessionID,
            agent: "default",
            model: {
              providerID: ProviderID.make("openai"),
              modelID: ModelID.make("gpt-4"),
            },
            time: {
              created: Date.now(),
            },
          })

          yield* session.updatePart({
            id: PartID.ascending(),
            messageID: userMsg.id,
            sessionID,
            type: "text",
            text: "Hello",
          })

          const assistantMsg: MessageV2.Assistant = {
            id: MessageID.ascending(),
            role: "assistant",
            sessionID,
            mode: "default",
            agent: "default",
            path: {
              cwd: dir,
              root: dir,
            },
            cost: 0,
            tokens: {
              output: 0,
              input: 0,
              reasoning: 0,
              cache: { read: 0, write: 0 },
            },
            modelID: ModelID.make("gpt-4"),
            providerID: ProviderID.make("openai"),
            parentID: userMsg.id,
            time: {
              created: Date.now(),
            },
            finish: "end_turn",
          }
          yield* session.updateMessage(assistantMsg)

          yield* session.updatePart({
            id: PartID.ascending(),
            messageID: assistantMsg.id,
            sessionID,
            type: "text",
            text: "Hi there!",
          })

          yield* revert.revert({
            sessionID,
            messageID: userMsg.id,
          })

          let sessionInfo = yield* session.get(sessionID)
          expect(sessionInfo.revert).toBeDefined()

          yield* revert.cleanup(sessionInfo)

          sessionInfo = yield* session.get(sessionID)
          expect(sessionInfo.revert).toBeUndefined()

          const messages = yield* session.messages({ sessionID })
          expect(messages.length).toBe(0)

          yield* session.remove(sessionID)
        }),
      { git: true },
    ),
  )

  it.live(
    "cleanup with partID removes parts from the revert point onward",
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const session = yield* Session.Service
          const revert = yield* SessionRevert.Service

          const info = yield* session.create({})
          const sid = info.id

          const u1 = yield* user(sid)
          const p1 = yield* text(sid, u1.id, "first part")
          const p2 = yield* tool(sid, u1.id)
          yield* text(sid, u1.id, "third part")

          yield* session.setRevert({
            sessionID: sid,
            revert: { messageID: u1.id, partID: p2.id },
            summary: { additions: 0, deletions: 0, files: 0 },
          })

          const state = yield* session.get(sid)
          yield* revert.cleanup(state)

          const msgs = yield* session.messages({ sessionID: sid })
          expect(msgs.length).toBe(1)
          expect(msgs[0].parts.length).toBe(1)
          expect(msgs[0].parts[0].id).toBe(p1.id)

          const cleared = yield* session.get(sid)
          expect(cleared.revert).toBeUndefined()
        }),
      { git: true },
    ),
  )

  it.live(
    "cleanup removes messages after revert point but keeps earlier ones",
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const session = yield* Session.Service
          const revert = yield* SessionRevert.Service

          const info = yield* session.create({})
          const sid = info.id

          const u1 = yield* user(sid)
          yield* text(sid, u1.id, "hello")
          const a1 = yield* assistant(sid, u1.id, dir)
          yield* text(sid, a1.id, "hi back")

          const u2 = yield* user(sid)
          yield* text(sid, u2.id, "second question")
          const a2 = yield* assistant(sid, u2.id, dir)
          yield* text(sid, a2.id, "second answer")

          yield* session.setRevert({
            sessionID: sid,
            revert: { messageID: u2.id },
            summary: { additions: 0, deletions: 0, files: 0 },
          })

          const state = yield* session.get(sid)
          yield* revert.cleanup(state)

          const msgs = yield* session.messages({ sessionID: sid })
          const ids = msgs.map((m) => m.info.id)
          expect(ids).toContain(u1.id)
          expect(ids).toContain(a1.id)
          expect(ids).not.toContain(u2.id)
          expect(ids).not.toContain(a2.id)
        }),
      { git: true },
    ),
  )

  it.live(
    "cleanup terminalizes unfinished assistant messages hidden by undo",
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const session = yield* Session.Service
          const revert = yield* SessionRevert.Service
          const usage = yield* SessionRequestUsage.Service

          const info = yield* session.create({})
          const sid = info.id
          const u1 = yield* user(sid)
          const a1 = yield* assistant(sid, u1.id, dir)

          yield* usage.begin({
            sessionID: sid,
            requestID: u1.id,
            source: "prompt",
            agent: a1.agent,
            providerID: a1.providerID,
            modelID: a1.modelID,
            timeCreated: u1.time.created,
          })
          yield* usage.recordAssistant({ sessionID: sid, requestID: u1.id, assistant: a1 })
          expect((yield* usage.get({ sessionID: sid, requestID: u1.id }))?.status).toBe("running")

          yield* session.setRevert({
            sessionID: sid,
            revert: { messageID: u1.id },
            summary: { additions: 0, deletions: 0, files: 0 },
          })
          yield* revert.cleanup(yield* session.get(sid))

          const stored = yield* MessageV2.get({ sessionID: sid, messageID: a1.id })
          const request = yield* usage.get({ sessionID: sid, requestID: u1.id })
          const assistants = yield* usage.assistants({ sessionID: sid, requestID: u1.id })

          expect(stored.info.role).toBe("assistant")
          if (stored.info.role === "assistant") {
            expect(stored.info.hidden?.reason).toBe("undo")
            expect(stored.info.time.completed).toBeDefined()
            expect(stored.info.error?.name).toBe("MessageAbortedError")
          }
          expect(request?.status).toBe("aborted")
          expect(assistants.find((item) => item.assistantMessageID === a1.id)?.status).toBe("aborted")
        }),
      { git: true },
    ),
  )

  it.live(
    "cleanup is a no-op when session has no revert state",
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const session = yield* Session.Service
          const revert = yield* SessionRevert.Service

          const info = yield* session.create({})
          const sid = info.id

          const u1 = yield* user(sid)
          yield* text(sid, u1.id, "hello")

          const state = yield* session.get(sid)
          expect(state.revert).toBeUndefined()
          yield* revert.cleanup(state)

          const msgs = yield* session.messages({ sessionID: sid })
          expect(msgs.length).toBe(1)
        }),
      { git: true },
    ),
  )

  it.live(
    "cleanup ignores a stale revert snapshot after the boundary was cleared",
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const session = yield* Session.Service
          const revert = yield* SessionRevert.Service
          const info = yield* session.create({})
          const reverted = yield* user(info.id)
          yield* text(info.id, reverted.id, "old boundary")
          yield* session.setRevert({
            sessionID: info.id,
            revert: { messageID: reverted.id },
            summary: { additions: 0, deletions: 0, files: 0 },
          })

          // 保留 cleanup 前的快照，模拟并发 caller 在维护操作完成后才恢复执行。
          const stale = yield* session.get(info.id)
          yield* revert.cleanup(stale)

          // 新消息晚于已消费的 revert 边界，不能被陈旧快照再次解释成待隐藏尾部。
          const fresh = yield* user(info.id)
          yield* text(info.id, fresh.id, "new user intent")
          yield* revert.cleanup(stale)

          const messages = yield* session.messages({ sessionID: info.id })
          // 通过 Session 可见消息验证行为，而不是依赖 cleanup 的内部锁或缓存形状。
          expect(messages.map((message) => message.info.id)).toContain(fresh.id)
          expect((yield* session.get(info.id)).revert).toBeUndefined()
        }),
      { git: true },
    ),
  )

  it.live(
    "restore messages in sequential order",
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const session = yield* Session.Service
          const revert = yield* SessionRevert.Service
          const snapshot = yield* Snapshot.Service

          yield* write(path.join(dir, "a.txt"), "a0")
          yield* write(path.join(dir, "b.txt"), "b0")
          yield* write(path.join(dir, "c.txt"), "c0")

          const info = yield* session.create({})
          const sid = info.id

          const turn = Effect.fn("test.turn")(function* (file: string, next: string) {
            const u = yield* user(sid)
            yield* text(sid, u.id, `${file}:${next}`)
            const a = yield* assistant(sid, u.id, dir)
            const before = yield* snapshot.track()
            if (!before) throw new Error("expected snapshot")
            yield* write(path.join(dir, file), next)
            const after = yield* snapshot.track()
            if (!after) throw new Error("expected snapshot")
            const patch = yield* snapshot.patch(before)
            yield* session.updatePart({
              id: PartID.ascending(),
              messageID: a.id,
              sessionID: sid,
              type: "step-start",
              snapshot: before,
            })
            yield* session.updatePart({
              id: PartID.ascending(),
              messageID: a.id,
              sessionID: sid,
              type: "step-finish",
              reason: "stop",
              snapshot: after,
              cost: 0,
              tokens,
            })
            yield* session.updatePart({
              id: PartID.ascending(),
              messageID: a.id,
              sessionID: sid,
              type: "patch",
              hash: patch.hash,
              files: patch.files,
            })
            return u.id
          })

          const first = yield* turn("a.txt", "a1")
          const second = yield* turn("b.txt", "b2")
          const third = yield* turn("c.txt", "c3")

          yield* revert.revert({
            sessionID: sid,
            messageID: first,
          })
          expect((yield* session.get(sid)).revert?.messageID).toBe(first)
          expect(yield* read(path.join(dir, "a.txt"))).toBe("a0")
          expect(yield* read(path.join(dir, "b.txt"))).toBe("b0")
          expect(yield* read(path.join(dir, "c.txt"))).toBe("c0")

          yield* revert.revert({
            sessionID: sid,
            messageID: second,
          })
          expect((yield* session.get(sid)).revert?.messageID).toBe(second)
          expect(yield* read(path.join(dir, "a.txt"))).toBe("a1")
          expect(yield* read(path.join(dir, "b.txt"))).toBe("b0")
          expect(yield* read(path.join(dir, "c.txt"))).toBe("c0")

          yield* revert.revert({
            sessionID: sid,
            messageID: third,
          })
          expect((yield* session.get(sid)).revert?.messageID).toBe(third)
          expect(yield* read(path.join(dir, "a.txt"))).toBe("a1")
          expect(yield* read(path.join(dir, "b.txt"))).toBe("b2")
          expect(yield* read(path.join(dir, "c.txt"))).toBe("c0")

          yield* revert.unrevert({
            sessionID: sid,
          })
          expect((yield* session.get(sid)).revert).toBeUndefined()
          expect(yield* read(path.join(dir, "a.txt"))).toBe("a1")
          expect(yield* read(path.join(dir, "b.txt"))).toBe("b2")
          expect(yield* read(path.join(dir, "c.txt"))).toBe("c3")
        }),
      { git: true },
    ),
  )

  it.live(
    "restore same file in sequential order",
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const session = yield* Session.Service
          const revert = yield* SessionRevert.Service
          const snapshot = yield* Snapshot.Service

          yield* write(path.join(dir, "a.txt"), "a0")

          const info = yield* session.create({})
          const sid = info.id

          const turn = Effect.fn("test.turnSame")(function* (next: string) {
            const u = yield* user(sid)
            yield* text(sid, u.id, `a.txt:${next}`)
            const a = yield* assistant(sid, u.id, dir)
            const before = yield* snapshot.track()
            if (!before) throw new Error("expected snapshot")
            yield* write(path.join(dir, "a.txt"), next)
            const after = yield* snapshot.track()
            if (!after) throw new Error("expected snapshot")
            const patch = yield* snapshot.patch(before)
            yield* session.updatePart({
              id: PartID.ascending(),
              messageID: a.id,
              sessionID: sid,
              type: "step-start",
              snapshot: before,
            })
            yield* session.updatePart({
              id: PartID.ascending(),
              messageID: a.id,
              sessionID: sid,
              type: "step-finish",
              reason: "stop",
              snapshot: after,
              cost: 0,
              tokens,
            })
            yield* session.updatePart({
              id: PartID.ascending(),
              messageID: a.id,
              sessionID: sid,
              type: "patch",
              hash: patch.hash,
              files: patch.files,
            })
            return u.id
          })

          const first = yield* turn("a1")
          const second = yield* turn("a2")
          const third = yield* turn("a3")
          expect(yield* read(path.join(dir, "a.txt"))).toBe("a3")

          yield* revert.revert({
            sessionID: sid,
            messageID: first,
          })
          expect((yield* session.get(sid)).revert?.messageID).toBe(first)
          expect(yield* read(path.join(dir, "a.txt"))).toBe("a0")

          yield* revert.revert({
            sessionID: sid,
            messageID: second,
          })
          expect((yield* session.get(sid)).revert?.messageID).toBe(second)
          expect(yield* read(path.join(dir, "a.txt"))).toBe("a1")

          yield* revert.revert({
            sessionID: sid,
            messageID: third,
          })
          expect((yield* session.get(sid)).revert?.messageID).toBe(third)
          expect(yield* read(path.join(dir, "a.txt"))).toBe("a2")

          yield* revert.unrevert({
            sessionID: sid,
          })
          expect((yield* session.get(sid)).revert).toBeUndefined()
          expect(yield* read(path.join(dir, "a.txt"))).toBe("a3")
        }),
      { git: true },
    ),
  )

  it.live(
    "cleanup preserves hidden messages in database",
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const session = yield* Session.Service
          const revert = yield* SessionRevert.Service

          const info = yield* session.create({})
          const sid = info.id

          const u1 = yield* user(sid)
          yield* text(sid, u1.id, "hello")
          const a1 = yield* assistant(sid, u1.id, info.directory)
          yield* text(sid, a1.id, "hi")

          yield* session.setRevert({
            sessionID: sid,
            revert: { messageID: u1.id },
            summary: { additions: 0, deletions: 0, files: 0 },
          })

          yield* revert.cleanup(yield* session.get(sid))

          const visible = yield* session.messages({ sessionID: sid })
          expect(visible.length).toBe(0)

          const hidden = yield* MessageV2.get({ sessionID: sid, messageID: u1.id })
          expect(hidden.info.hidden).toBeDefined()
          expect(hidden.info.hidden!.reason).toBe("undo")

          const u1raw = yield* MessageV2.get({ sessionID: sid, messageID: u1.id })
          expect(u1raw.info.id).toBe(u1.id)
          expect(u1raw.info.hidden?.reason).toBe("undo")

          yield* session.remove(sid)
        }),
      { git: true },
    ),
  )

  // ── B1: revert 状态守卫 ──────────────────────────────────────
  // 验证 revert 进行中时，第二次 revert 被阻止（返回 BusyError），
  // 以及 revert 失败后 reverting 标志被清除（后续操作不受阻）。

  it.live(
    "concurrent revert is rejected with BusyError",
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const session = yield* Session.Service
          const revert = yield* SessionRevert.Service
          const snapshot = yield* Snapshot.Service

          // 准备：两个 turn，各有 patch（同文件不同 hash）
          yield* write(path.join(dir, "a.txt"), "a0")
          const info = yield* session.create({})
          const sid = info.id

          const turn = Effect.fn("test.concurrentTurn")(function* (next: string) {
            const u = yield* user(sid)
            yield* text(sid, u.id, `a.txt:${next}`)
            const a = yield* assistant(sid, u.id, dir)
            const before = yield* snapshot.track()
            if (!before) throw new Error("expected snapshot")
            yield* write(path.join(dir, "a.txt"), next)
            const after = yield* snapshot.track()
            if (!after) throw new Error("expected snapshot")
            const patch = yield* snapshot.patch(before)
            yield* session.updatePart({
              id: PartID.ascending(),
              messageID: a.id,
              sessionID: sid,
              type: "step-start",
              snapshot: before,
            })
            yield* session.updatePart({
              id: PartID.ascending(),
              messageID: a.id,
              sessionID: sid,
              type: "step-finish",
              reason: "stop",
              snapshot: after,
              cost: 0,
              tokens,
            })
            yield* session.updatePart({
              id: PartID.ascending(),
              messageID: a.id,
              sessionID: sid,
              type: "patch",
              hash: patch.hash,
              files: patch.files,
            })
            return u.id
          })

          yield* turn("a1")
          yield* turn("a2")

          // 获取两个 user messageID 作为 revert 目标
          const msgs = yield* session.messages({ sessionID: sid })
          const userMsgs = msgs.filter((m) => m.info.role === "user")
          const first = userMsgs[0]!.info.id
          const second = userMsgs[1]!.info.id

          // 真正并发：两个 revert 同时执行，beginRevert 原子 check-and-set
          // 保证只有一个成功，另一个得 BusyError
          const [exit1, exit2] = yield* Effect.all(
            [
              Effect.exit(revert.revert({ sessionID: sid, messageID: first })),
              Effect.exit(revert.revert({ sessionID: sid, messageID: second })),
            ],
            { concurrency: 2 },
          )

          // 一个成功一个失败（BusyError）——顺序不确定，但恰好一个 success
          const successCount = [exit1, exit2].filter((e) => Exit.isSuccess(e)).length
          expect(successCount).toBe(1)

          yield* session.remove(sid)
        }),
      { git: true },
    ),
  )

  it.live(
    "revert clears reverting flag on failure allowing subsequent operations",
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const session = yield* Session.Service
          const revert = yield* SessionRevert.Service
          const state = yield* SessionRunState.Service

          const info = yield* session.create({})
          const sid = info.id
          const u1 = yield* user(sid)
          yield* text(sid, u1.id, "hello")

          // revert 一个不存在的 messageID——revert 内部遍历找不到 rev，
          // 提前返回（不触发 git），但 beginRevert/endRevert 仍应正确配对
          const fakeID = MessageID.ascending()
          const exit = yield* Effect.exit(revert.revert({ sessionID: sid, messageID: fakeID }))

          // revert 对不存在的 messageID 返回 session（不报错），reverting 已清除
          expect(Exit.isSuccess(exit)).toBe(true)

          // assertNotReverting 应该通过——reverting 已被 endRevert 清除
          yield* state.assertNotReverting(sid)

          yield* session.remove(sid)
        }),
      { git: true },
    ),
  )

  // ── A1: 合并 git checkout ────────────────────────────────────
  // 验证同一 hash 的多文件批量 revert 能正确恢复全部文件。
  // 当前测试中每个 turn 只改一个文件且 hash 不同，走 single() 路径。
  // 此测试构造同 hash 多文件场景，触发 A1 快速 checkout 路径。

  it.live(
    "revert restores multiple files with same snapshot hash in one batch",
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const session = yield* Session.Service
          const revert = yield* SessionRevert.Service
          const snapshot = yield* Snapshot.Service

          // 初始：两个文件
          yield* write(path.join(dir, "x.txt"), "x0")
          yield* write(path.join(dir, "y.txt"), "y0")

          const info = yield* session.create({})
          const sid = info.id

          const u = yield* user(sid)
          yield* text(sid, u.id, "change both files")
          const a = yield* assistant(sid, u.id, dir)

          // 一次 track（before），然后同时修改两个文件，再一次 track（after）
          // 这样两个文件的 patch 共享同一个 before hash → A1 批量路径
          const before = yield* snapshot.track()
          if (!before) throw new Error("expected before snapshot")
          yield* write(path.join(dir, "x.txt"), "x1")
          yield* write(path.join(dir, "y.txt"), "y1")
          const after = yield* snapshot.track()
          if (!after) throw new Error("expected after snapshot")
          const patch = yield* snapshot.patch(before)

          yield* session.updatePart({
            id: PartID.ascending(),
            messageID: a.id,
            sessionID: sid,
            type: "step-start",
            snapshot: before,
          })
          yield* session.updatePart({
            id: PartID.ascending(),
            messageID: a.id,
            sessionID: sid,
            type: "step-finish",
            reason: "stop",
            snapshot: after,
            cost: 0,
            tokens,
          })
          // 两个 patch part 共享同一 hash——A1 会将它们合并为一次 checkout
          yield* session.updatePart({
            id: PartID.ascending(),
            messageID: a.id,
            sessionID: sid,
            type: "patch",
            hash: patch.hash,
            files: patch.files,
          })

          // revert 后两个文件都应恢复到初始内容
          yield* revert.revert({ sessionID: sid, messageID: u.id })
          expect(yield* read(path.join(dir, "x.txt"))).toBe("x0")
          expect(yield* read(path.join(dir, "y.txt"))).toBe("y0")

          yield* session.remove(sid)
        }),
      { git: true },
    ),
  )

  // ── A2: messages 范围裁剪 ────────────────────────────────────
  // 验证 messages(fromMessageID) 只返回该 ID 及之后的消息。

  it.live(
    "messages with fromMessageID returns only tail messages",
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const session = yield* Session.Service

          const info = yield* session.create({})
          const sid = info.id

          const u1 = yield* user(sid)
          yield* text(sid, u1.id, "first")
          const u2 = yield* user(sid)
          yield* text(sid, u2.id, "second")
          const u3 = yield* user(sid)
          yield* text(sid, u3.id, "third")

          // 全量加载应返回 3 条
          const all = yield* session.messages({ sessionID: sid })
          expect(all.length).toBe(3)

          // 从 u2 开始裁剪——只返回 u2 和 u3
          const tail = yield* session.messages({ sessionID: sid, fromMessageID: u2.id })
          expect(tail.length).toBe(2)
          const tailIds = tail.map((m) => m.info.id)
          expect(tailIds).toContain(u2.id)
          expect(tailIds).toContain(u3.id)
          expect(tailIds).not.toContain(u1.id)

          yield* session.remove(sid)
        }),
      { git: true },
    ),
  )
})
