import { describe, expect } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import fs from "fs/promises"
import path from "path"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Cause, Deferred, Effect, Exit, Fiber } from "effect"
import { Session } from "@/session/session"

import { SessionRevert } from "../../src/session/revert"
import { SessionRunState } from "../../src/session/run-state"
import { SessionRequestUsage } from "@opencode-ai/core/session/request-usage"
import { MessageV2 } from "../../src/session/message-v2"
import { Snapshot } from "../../src/snapshot"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { provideTmpdirInstance } from "../fixture/fixture"
import { awaitWithTimeout, testEffect } from "../lib/effect"
import { InstanceRef, WorkspaceRef } from "@/effect/instance-ref"
import { WorkspaceV2 } from "@opencode-ai/core/workspace"
import { disposeInstance } from "@/effect/instance-registry"
import { InstanceState } from "@/effect/instance-state"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([Session.node, SessionRevert.node, Snapshot.node, SessionProjector.node, CrossSpawnSpawner.node, MessageV2.node, SessionRequestUsage.node, SessionRunState.node]),
  ),
)

const user = Effect.fn("test.user")(function* (sessionID: SessionID, agent = "default") {
  const session = yield* Session.Service
  return yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user" as const,
    sessionID,
    agent,
    model: { providerID: ProviderV2.ID.make("openai"), modelID: ModelV2.ID.make("gpt-4") },
    time: { created: Date.now() },
  })
})

const userAt = Effect.fn("test.userAt")(function* (sessionID: SessionID, id: string, created: number) {
  const session = yield* Session.Service
  return yield* session.updateMessage({
    id: MessageID.make(id),
    role: "user" as const,
    sessionID,
    agent: "default",
    model: { providerID: ProviderV2.ID.make("openai"), modelID: ModelV2.ID.make("gpt-4") },
    time: { created },
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
    modelID: ModelV2.ID.make("gpt-4"),
    providerID: ProviderV2.ID.make("openai"),
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
    // #557：bash 归因 ambient——Revert 只接纳其自身 Patch 文件。
    metadata: { worktree: "ambient" },
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

// #545：edit 完成态 metadata——filediff 与真实 edit 工具同形状，供 computeDiff/toolFiles 归因。
const editTool = Effect.fn("test.editTool")(function* (
  sessionID: SessionID,
  messageID: MessageID,
  absFile: string,
  oldText: string,
  newText: string,
) {
  const session = yield* Session.Service
  const patch = `--- a\n+++ b\n@@ -1 +1 @@\n-${oldText}\n+${newText}\n`
  return yield* session.updatePart({
    id: PartID.ascending(),
    messageID,
    sessionID,
    type: "tool" as const,
    tool: "edit",
    callID: "edit-" + Math.random().toString(36).slice(2),
    // #557：edit 归因 declared——精确文件 authority。
    metadata: { worktree: "declared" },
    state: {
      status: "completed" as const,
      input: { filePath: absFile },
      output: "ok",
      title: path.basename(absFile),
      metadata: {
        diff: patch,
        filediff: { file: absFile, patch, additions: 1, deletions: 1 },
      },
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
              providerID: ProviderV2.ID.make("openai"),
              modelID: ModelV2.ID.make("gpt-4"),
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

          const assistantMsg1: SessionV1.Assistant = {
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
            modelID: ModelV2.ID.make("gpt-4"),
            providerID: ProviderV2.ID.make("openai"),
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
              providerID: ProviderV2.ID.make("openai"),
              modelID: ModelV2.ID.make("gpt-4"),
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

          const assistantMsg2: SessionV1.Assistant = {
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
            modelID: ModelV2.ID.make("gpt-4"),
            providerID: ProviderV2.ID.make("openai"),
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
              providerID: ProviderV2.ID.make("openai"),
              modelID: ModelV2.ID.make("gpt-4"),
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

          const assistantMsg: SessionV1.Assistant = {
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
            modelID: ModelV2.ID.make("gpt-4"),
            providerID: ProviderV2.ID.make("openai"),
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
          const p3 = yield* text(sid, u1.id, "third part")

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

          // #98：原始读取保留隐藏部件及完整工具输出。
          const raw = yield* MessageV2.get({ sessionID: sid, messageID: u1.id })
          expect(raw.info.hidden).toBeUndefined()
          expect(raw.parts).toEqual([
            p1,
            { ...p2, hidden: { time: expect.any(Number), reason: "undo" } },
            { ...p3, hidden: { time: expect.any(Number), reason: "undo" } },
          ])

          const page = yield* MessageV2.page({ sessionID: sid, limit: 1 })
          expect(page.items).toEqual(msgs)
          expect(page.more).toBe(false)
          expect(page.cursor).toBeUndefined()
          expect(yield* session.messages({ sessionID: sid, limit: 1 })).toEqual(msgs)
          expect(yield* MessageV2.stream(sid, { includeHidden: true })).toEqual([raw])
          const audit = yield* MessageV2.page({ sessionID: sid, limit: 1, includeHidden: true })
          expect(audit.items).toEqual([raw])

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

          // #98：隐藏后缀不占页容量，游标指向最旧可见项。
          const page = yield* MessageV2.page({ sessionID: sid, limit: 1 })
          expect(page.items.map((msg) => msg.info.id)).toEqual([a1.id])
          expect(page.more).toBe(true)
          expect(page.cursor).toBe(MessageV2.cursor.encode({ id: a1.id, time: a1.time.created }))

          const older = yield* MessageV2.page({ sessionID: sid, limit: 1, before: page.cursor })
          expect(older.items.map((msg) => msg.info.id)).toEqual([u1.id])
          expect(older.more).toBe(false)
          expect(older.cursor).toBeUndefined()
          expect(yield* session.messages({ sessionID: sid, limit: 1 })).toEqual(page.items)
          expect(yield* session.messages({ sessionID: sid, limit: 2 })).toEqual(msgs)

          const audit = yield* MessageV2.stream(sid, { includeHidden: true })
          expect(audit.map((msg) => msg.info.id)).toEqual([a2.id, u2.id, a1.id, u1.id])
          const raw = yield* MessageV2.page({ sessionID: sid, limit: 2, includeHidden: true })
          expect(raw.items.map((msg) => msg.info.id)).toEqual([u2.id, a2.id])
          expect(raw.items.every((msg) => msg.info.hidden?.reason === "undo")).toBe(true)
        }),
      { git: true },
    ),
  )

  it.live(
    "reverts chronological suffixes on both sides of mixed message ID ordering",
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const session = yield* Session.Service
          const revert = yield* SessionRevert.Service
          const ids = ["msg_z9-before", "msg_z1-before-wrap", "msg_a0-after-wrap", "msg_a1-after"]

          const run = Effect.fn("test.mixedIDRevert")(function* (target: number) {
            const info = yield* session.create({})
            for (const [index, id] of ids.entries()) {
              const message = yield* userAt(info.id, id, index + 1)
              yield* text(info.id, message.id, id)
            }

            const reverted = yield* revert.revert({
              sessionID: info.id,
              messageID: MessageID.make(ids[target]!),
            })
            yield* revert.cleanup(reverted)
            const remaining = yield* session.messages({ sessionID: info.id })
            yield* session.remove(info.id)
            return remaining.map((msg) => msg.info.time.created)
          })

          expect(yield* run(1)).toEqual([1])
          expect(yield* run(2)).toEqual([1, 2])
        }),
      { git: true },
    ),
  )


  it.live(
    "cleanup preserves hidden messages in database",
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          // #98：软隐藏必须 DB 留存；visible 为空且 get 得 hidden.reason=undo
          const session = yield* Session.Service
          const revert = yield* SessionRevert.Service

          const info = yield* session.create({})
          const sid = info.id

          const u1 = yield* user(sid)
          yield* text(sid, u1.id, "hello")
          const a1 = yield* assistant(sid, u1.id, dir)
          yield* text(sid, a1.id, "hi back")

          yield* session.setRevert({
            sessionID: sid,
            revert: { messageID: u1.id },
            summary: { additions: 0, deletions: 0, files: 0 },
          })

          const state = yield* session.get(sid)
          yield* revert.cleanup(state)

          const visible = yield* session.messages({ sessionID: sid })
          expect(visible.length).toBe(0)

          const hidden = yield* MessageV2.get({ sessionID: sid, messageID: u1.id })
          expect(hidden.info.hidden).toBeDefined()
          expect(hidden.info.hidden!.reason).toBe("undo")
        }),
      { git: true },
    ),
  )

  // #482：并发 cleanup single-flight——双方共同消费同一次 revert 边界，
  // 第二路重放 owner 的 Exit；边界消费后 revert 无残留且 fresh 消息正常可见
  it.live(
    "concurrent cleanup joins a single revert boundary consumption",
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

          yield* session.setRevert({
            sessionID: sid,
            revert: { messageID: u1.id },
            summary: { additions: 0, deletions: 0, files: 0 },
          })
          const state = yield* session.get(sid)

          // 并发两路 cleanup：single-flight 让双方共同消费同一次边界
          // （cleanup 返回 void，边界成功与否由下方 revert 残留与 fresh 可见性断言）
          yield* Effect.all([revert.cleanup(state), revert.cleanup(state)], { concurrency: 2 })
          // 边界只消费一次：revert 状态已清，后续请求不受残留影响
          expect((yield* session.get(sid)).revert).toBeUndefined()
          const fresh = yield* user(sid)
          const visible = yield* session.messages({ sessionID: sid })
          expect(visible.map((m) => m.info.id)).toContain(fresh.id)
        }),
      { git: true },
    ),
  )

  // #482：陈旧快照不得重新解释边界——cleanup 完成后再次以旧快照调用，
  // fresh 消息必须存活且 revert 不复活（锁定 sessions.get 重读语义）
  it.live(
    "cleanup ignores a stale revert snapshot after the boundary was cleared",
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

          yield* session.setRevert({
            sessionID: sid,
            revert: { messageID: u1.id },
            summary: { additions: 0, deletions: 0, files: 0 },
          })
          // 陈旧快照在此刻固定：后续 user/fresh 的创建使快照与新状态天然脱节
          const stale = yield* session.get(sid)

          // 第一次 cleanup 消费边界；第二次以陈旧快照调用必须为 no-op——
          // cleanupCurrent 的 sessions.get 重读保证边界清除后旧快照不再触发隐藏
          yield* revert.cleanup(stale)
          // fresh 创建在边界清除后：二次 stale cleanup 若重新解释快照，fresh 必然被误隐藏
          const fresh = yield* user(sid)
          yield* revert.cleanup(stale)

          const visible = yield* session.messages({ sessionID: sid })
          // fresh 存活是核心断言：信任入参快照的实现会把 fresh 也隐藏
          expect(visible.map((m) => m.info.id)).toContain(fresh.id)
          expect((yield* session.get(sid)).revert).toBeUndefined()
        }),
      { git: true },
    ),
  )

  // #482：exclusive 租约互斥——compaction 等维护工作占用期间，
  // prompt 的 Busy 检查、二次 exclusive 与 beginRevert 全部被拒；释放后恢复
  it.live(
    "startExclusive rejects concurrent busy checks and revert while owning the session",
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const session = yield* Session.Service
          const runState = yield* SessionRunState.Service
          const source = yield* InstanceState.context
          // 只切换实例引用，不启动模型、LSP或操作系统shell。
          const target = { ...source, directory: path.join(source.directory, "target") }

          const info = yield* session.create({})
          const sid = info.id

          const fakeResult = { info: { id: "", role: "assistant", parentID: "", path: {}, sessionID: sid, providerID: "", modelID: "", mode: "", agent: "", cost: 0, tokens: {}, time: { created: 0 } }, parts: [] } as never
          const release = yield* Deferred.make<SessionV1.WithParts>()
          const owner = yield* runState
            .startExclusive(
              sid,
              // 中断目标：compact 无既有 assistant 可恢复，成功值不参与断言
              Effect.succeed(fakeResult),
              // work 挂起在 deferred 上：租约持有期由我们控制，释放后完成
              Effect.as(Deferred.await(release), fakeResult),
            )
            .pipe(Effect.forkChild)

          // 等 owner 拿到租约：BusyError 轮询转成功即登记完成
          let leased = false
          for (let i = 0; i < 100 && !leased; i++) {
            const probe = yield* runState.assertNotBusy(sid).pipe(Effect.exit)
            leased = Exit.isSuccess(probe) === false
            if (!leased) yield* Effect.yieldNow
          }
          expect(leased).toBe(true)

          expect(Exit.isFailure(yield* runState.assertNotBusy(sid).pipe(Effect.exit))).toBe(true)
          expect(Exit.isFailure(yield* runState.startExclusive(sid, Effect.succeed(fakeResult), Effect.succeed(fakeResult)).pipe(Effect.exit))).toBe(true)
          expect(Exit.isFailure(yield* runState.beginRevert(sid).pipe(Effect.exit))).toBe(true)

          // 其它目录同样受维护租约约束；销毁其空State不能取消原目录的owner。
          expect(Exit.isFailure(yield* runState.assertNotBusy(sid).pipe(Effect.provideService(InstanceRef, target), Effect.exit))).toBe(true)
          expect(Exit.isFailure(yield* runState.startExclusive(sid, Effect.succeed(fakeResult), Effect.succeed(fakeResult)).pipe(Effect.provideService(InstanceRef, target), Effect.exit))).toBe(true)
          expect(Exit.isFailure(yield* runState.beginRevert(sid).pipe(Effect.provideService(InstanceRef, target), Effect.exit))).toBe(true)
          yield* Effect.promise(() => disposeInstance(target.directory))
          expect(Exit.isFailure(yield* runState.assertNotBusy(sid).pipe(Effect.exit))).toBe(true)

          // 手动终结 deferred 以释放租约——fakeResult 经 never 泛化后可满足 WithParts 成功通道
          yield* (Deferred.succeed(release, fakeResult as never) as Effect.Effect<boolean>)
          const exit = yield* Effect.exit(Fiber.join(owner))
          expect(Exit.isSuccess(exit)).toBe(true)
          // 释放后 Busy 检查恢复通过
          yield* runState.assertNotBusy(sid)
          const shellStarted = yield* Deferred.make<void>()
          const shellEnd = yield* Deferred.make<SessionV1.WithParts>()
          const queuedStarted = yield* Deferred.make<void>()
          const queuedEnd = yield* Deferred.make<SessionV1.WithParts>()
          const shell = yield* runState.startShell(sid, Effect.succeed(fakeResult),
            Deferred.succeed(shellStarted, undefined).pipe(Effect.andThen(Deferred.await(shellEnd))),
          ).pipe(Effect.provideService(WorkspaceRef, WorkspaceV2.ID.make("wrk_source")), Effect.forkChild)
          yield* awaitWithTimeout(Deferred.await(shellStarted), "logical shell did not start")
          const queued = yield* runState.ensureRunning(sid, Effect.succeed(fakeResult), Effect.gen(function* () {
            // D的shell fiber接续T的work时，Instance与显式空Workspace都必须来自T。
            expect((yield* InstanceState.context).directory).toBe(target.directory)
            expect(yield* WorkspaceRef).toBeUndefined()
            yield* Deferred.succeed(queuedStarted, undefined)
            return yield* Deferred.await(queuedEnd)
          })).pipe(Effect.provideService(InstanceRef, target), Effect.provideService(WorkspaceRef, undefined), Effect.forkChild)
          yield* Effect.yieldNow
          expect(yield* Deferred.isDone(queuedStarted)).toBe(false)
          yield* Deferred.succeed(shellEnd, fakeResult)
          yield* Fiber.join(shell)
          yield* awaitWithTimeout(Deferred.await(queuedStarted), "queued caller context was not preserved")
          // 运行中跨目录join不能执行第二份work，目标目录取消后两个等待者均收到中断结果。
          let duplicate = false
          const joined = yield* runState.ensureRunning(sid, Effect.succeed(fakeResult), Effect.sync(() => {
            duplicate = true
            return fakeResult
          })).pipe(Effect.forkChild)
          yield* Effect.yieldNow
          expect(duplicate).toBe(false)
          yield* runState.cancel(sid).pipe(Effect.provideService(InstanceRef, target))
          const results = yield* Effect.all([Fiber.join(queued), Fiber.join(joined)])
          expect(results).toEqual([fakeResult, fakeResult])
          yield* runState.assertNotBusy(sid)
          // 撤回登记也跨目录共享，endRevert后同一Session才可再次进入维护。
          yield* runState.beginRevert(sid)
          expect(Exit.isFailure(yield* runState.assertNotReverting(sid).pipe(Effect.provideService(InstanceRef, target), Effect.exit))).toBe(true)
          expect(Exit.isFailure(yield* runState.startExclusive(sid, Effect.succeed(fakeResult), Effect.succeed(fakeResult)).pipe(Effect.provideService(InstanceRef, target), Effect.exit))).toBe(true)
          yield* runState.endRevert(sid).pipe(Effect.provideService(InstanceRef, target))
          yield* runState.startExclusive(sid, Effect.succeed(fakeResult), Effect.succeed(fakeResult))
        }),
      {},
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

          // #153：验证 undo 终态化同时补记 request-usage 的 aborted 状态
          // begin 以 user 消息为请求根，与生产 prompt 路径的 requestID 语义一致
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
          // 前置断言：补记前请求必须处于 running，排除 begin 缺失导致的假阳性
          expect((yield* usage.get({ sessionID: sid, requestID: u1.id }))?.status).toBe("running")

          yield* session.setRevert({
            sessionID: sid,
            revert: { messageID: u1.id },
            summary: { additions: 0, deletions: 0, files: 0 },
          })
          // cleanup 自行读取 revert 状态并终态化 assistant，调用方无需预清理
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

          // #545：turn 补 prev 参数并在写盘后声明 editTool——交集语义下未声明的文件不撤。
          // prev 参与 editTool patch 文本仅作 metadata 证据；磁盘状态由 write 决定。
          const turn = Effect.fn("test.turn")(function* (file: string, prev: string, next: string) {
            const u = yield* user(sid)
            yield* text(sid, u.id, `${file}:${next}`)
            const a = yield* assistant(sid, u.id, dir)
            const before = yield* snapshot.track()
            if (!before) throw new Error("expected snapshot")
            const abs = path.join(dir, file)
            yield* write(abs, next)
            yield* editTool(sid, a.id, abs, prev, next)
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

          const first = yield* turn("a.txt", "a0", "a1")
          const second = yield* turn("b.txt", "b0", "b2")
          const third = yield* turn("c.txt", "c0", "c3")

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

          // #545：同文件连写场景同样需要 editTool 声明——prev/next 随迭代链传递。
          // 迭代链（a0→a1→a2）使每次 revert 的目标版本即上一次 editTool 的 prev。
          const turn = Effect.fn("test.turnSame")(function* (prev: string, next: string) {
            const u = yield* user(sid)
            yield* text(sid, u.id, `a.txt:${next}`)
            const a = yield* assistant(sid, u.id, dir)
            const before = yield* snapshot.track()
            if (!before) throw new Error("expected snapshot")
            const abs = path.join(dir, "a.txt")
            yield* write(abs, next)
            yield* editTool(sid, a.id, abs, prev, next)
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

          const first = yield* turn("a0", "a1")
          const second = yield* turn("a1", "a2")
          const third = yield* turn("a2", "a3")
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
})

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

          // #545：并发 revert 场景的 turn 同样声明 editTool，保持夹具语义一致。
          // BusyError 语义与本 patch 无关——此测试只需在新夹具形状下保持可跑。
          const turn = Effect.fn("test.concurrentTurn")(function* (prev: string, next: string) {
            const u = yield* user(sid)
            yield* text(sid, u.id, `a.txt:${next}`)
            const a = yield* assistant(sid, u.id, dir)
            const before = yield* snapshot.track()
            if (!before) throw new Error("expected snapshot")
            const abs = path.join(dir, "a.txt")
            yield* write(abs, next)
            yield* editTool(sid, a.id, abs, prev, next)
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

          yield* turn("a0", "a1")
          yield* turn("a1", "a2")

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
          const failure = [exit1, exit2].find(Exit.isFailure)
          expect(failure).toBeDefined()
          if (failure) expect(Cause.squash(failure.cause)).toBeInstanceOf(Session.BusyError)

          yield* session.remove(sid)
        }),
      { git: true },
    ),
  )

  it.live(
    "revert clears reverting flag on early return allowing subsequent operations",
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const session = yield* Session.Service
          const revert = yield* SessionRevert.Service

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
          // 二次 revert 成功 = reverting 标志已被 endRevert 清除（若泄漏会 BusyError 失败）
          const exit2 = yield* Effect.exit(revert.revert({ sessionID: sid, messageID: fakeID }))
          expect(Exit.isSuccess(exit2)).toBe(true)


          yield* session.remove(sid)
        }),
      { git: true },
    ),
  )

// ── #545 工具流过滤：空 toolFiles 不撤磁盘；有声明时只撤交集 ──────────

// #545 红绿锚点：本用例在旧安全网（空 toolFiles 回退全量）下会把 external edit 撤回 baseline 而失败。
it.live(
  "ambient patch without tool metadata does not restore files",
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const session = yield* Session.Service
        const revert = yield* SessionRevert.Service
        const snapshot = yield* Snapshot.Service

        yield* write(path.join(dir, "plan.md"), "baseline\n")
        const info = yield* session.create({})
        const sid = info.id
        const u = yield* user(sid)
        // 只读 turn：不声明任何 edit/write 工具，toolFiles 必然为空。
        yield* text(sid, u.id, "read only")
        const a = yield* assistant(sid, u.id, dir)

        // #545：模拟只读 turn 期间外部改动——只有 PatchPart，无 edit/write metadata。
        const before = yield* snapshot.track()
        if (!before) throw new Error("expected before snapshot")
        // 外部改动直接写盘（无工具声明）——模拟 IDE/其他 session 的 ambient 变更。
        yield* write(path.join(dir, "plan.md"), "external edit\n")
        const after = yield* snapshot.track()
        if (!after) throw new Error("expected after snapshot")
        const patch = yield* snapshot.patch(before)
        // patch 必须非空：否则「磁盘不撤」断言无法区分交集为空与根本没有变更。
        expect(patch.files.length).toBeGreaterThan(0)

        // step-start/finish 携带前后 snapshot，patch part 携带 hash+files——三件套
        // 与真实 turn 的 part 形状一致，revert 的 boundary/patch 收集路径才会走全。
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

        yield* revert.revert({ sessionID: sid, messageID: u.id })
        // #545：toolFiles 为空——消息可 undo，磁盘保持外部改动（不回退全量 revert）。
        expect(yield* read(path.join(dir, "plan.md"))).toBe("external edit\n")
        const state = yield* session.get(sid)
        expect(state.revert?.messageID).toBe(u.id)
        // 目标键名为 revertedPaths（0478 分键）：无交集时保持 undefined。
        // messageID 已记录证明消息级 undo 成功——空交集只清空磁盘恢复面，不阻塞 undo。
        expect(state.revert?.revertedPaths).toBeUndefined()

        yield* session.remove(sid)
      }),
    { git: true },
  ),
  // #545：Windows 宿主 git fixture 冷启动慢于 5s 默认超时，与 session-list 用例同族显式放宽。
  30_000,
)

// #545 红绿锚点：旧三元在 toolFiles 非空时行为相同；本用例锁交集不含 ambient 的边界。
it.live(
  "revert intersects patch files with edit tool metadata only",
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const session = yield* Session.Service
        const revert = yield* SessionRevert.Service
        const snapshot = yield* Snapshot.Service

        yield* write(path.join(dir, "owned.ts"), "owned0\n")
        yield* write(path.join(dir, "other.md"), "other0\n")
        const info = yield* session.create({})
        const sid = info.id
        const u = yield* user(sid)
        yield* text(sid, u.id, "edit owned only")
        const a = yield* assistant(sid, u.id, dir)

        const before = yield* snapshot.track()
        if (!before) throw new Error("expected before snapshot")
        // owned/other 双写后只声明单一 editTool：patch 窗含两文件而 toolFiles 只含其一。
        const ownedAbs = path.join(dir, "owned.ts")
        const otherAbs = path.join(dir, "other.md")
        // 两文件同窗变更：patch.files 同时含 owned/other，交集只放行 owned。
        yield* write(ownedAbs, "owned1\n")
        yield* write(otherAbs, "other1\n")
        // #545：工具只声明 owned.ts；other.md 是同窗 ambient 噪声，必须被交集过滤。
        yield* editTool(sid, a.id, ownedAbs, "owned0\n", "owned1\n")
        const after = yield* snapshot.track()
        if (!after) throw new Error("expected after snapshot")
        const patch = yield* snapshot.patch(before)
        // 先证明 patch.files 确实同时含两文件，否则「过滤 other」断言无区分力。
        expect(patch.files.some((f) => f.endsWith("owned.ts"))).toBe(true)
        expect(patch.files.some((f) => f.endsWith("other.md"))).toBe(true)

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

        yield* revert.revert({ sessionID: sid, messageID: u.id })
        // 只恢复工具声明的 owned.ts；ambient other.md 保持改后内容。
        expect(yield* read(ownedAbs)).toBe("owned0\n")
        expect(yield* read(otherAbs)).toBe("other1\n")
        // owned 恢复到 editTool 的 prev 内容；other 保持写盘值——交集语义的双向证据。
        const state = yield* session.get(sid)
        // revertedPaths 只含交集结果，供 unrevert 精确恢复同一文件集。
        // 长度 1（而非 2）直接证明 other.md 被 toolFiles 交集排除。
        expect(state.revert?.revertedPaths?.length).toBe(1)
        expect(state.revert?.revertedPaths?.[0]?.endsWith("owned.ts")).toBe(true)

        yield* session.remove(sid)
      }),
    { git: true },
  ),
  30_000,
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
          // A1 批量路径：两 patch 同 before hash 合并 checkout，交集后仍需两文件都恢复。
          const xAbs = path.join(dir, "x.txt")
          const yAbs = path.join(dir, "y.txt")
          yield* write(xAbs, "x1")
          yield* write(yAbs, "y1")
          // #545：两个 edit 工具各自声明文件，toolFiles 才能与 patch.files 取交集。
          // 若任一文件缺声明，无条件交集会把该文件从恢复面剔除、破坏既有断言。
          yield* editTool(sid, a.id, xAbs, "x0", "x1")
          yield* editTool(sid, a.id, yAbs, "y0", "y1")
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

          const u1 = yield* userAt(sid, "msg_z9-crop-before", 1)
          yield* text(sid, u1.id, "first")
          const u2 = yield* userAt(sid, "msg_z1-crop-target", 2)
          yield* text(sid, u2.id, "second")
          const u3 = yield* userAt(sid, "msg_a0-crop-after", 3)
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
          // 回绕ID仍沿时间后缀分页；不存在的锚点不能退回全量历史。
          expect((yield* session.messages({ sessionID: sid, limit: 1, fromMessageID: u2.id })).map((m) => m.info.id)).toEqual([u3.id])
          expect(yield* session.messages({ sessionID: sid, fromMessageID: MessageID.make("msg_missing-crop") })).toEqual([])
          const page = yield* MessageV2.page({ sessionID: sid, limit: 1, fromMessageID: u2.id })
          expect((yield* MessageV2.page({ sessionID: sid, limit: 1, before: page.cursor, fromMessageID: u2.id })).items.map((m) => m.info.id)).toEqual([u2.id])

          yield* session.remove(sid)
        }),
      { git: true },
    ),
  )
