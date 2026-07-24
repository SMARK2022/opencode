import { Effect, Layer, Context, Schema, Option, Deferred, Exit } from "effect"
import path from "path"
import { Bus } from "../bus"
import { Snapshot } from "../snapshot"
import { Storage } from "@/storage/storage"
import { SyncEvent } from "../sync"
import { InstanceState } from "@/effect/instance-state"
import * as Log from "@opencode-ai/core/util/log"
import * as Session from "./session"
import { MessageV2 } from "./message-v2"
import { SessionID, MessageID, PartID } from "./schema"
import { SessionRunState } from "./run-state"
import { SessionSummary } from "./summary"
import { SessionRequestUsage } from "./request-usage"

const log = Log.create({ service: "session.revert" })

export const RevertInput = Schema.Struct({
  sessionID: SessionID,
  messageID: MessageID,
  partID: Schema.optional(PartID),
})
export type RevertInput = Schema.Schema.Type<typeof RevertInput>

export interface Interface {
  readonly revert: (input: RevertInput) => Effect.Effect<Session.Info, Session.BusyError>
  readonly unrevert: (input: { sessionID: SessionID }) => Effect.Effect<Session.Info, Session.BusyError>
  readonly cleanup: (session: Session.Info) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionRevert") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const snap = yield* Snapshot.Service
    const storage = yield* Storage.Service
    const bus = yield* Bus.Service
    const summary = yield* SessionSummary.Service
    const state = yield* SessionRunState.Service
    const sync = yield* SyncEvent.Service
    // 同一 Session 的 cleanup 必须是 single-flight：并发 prompt/compact 只能共同消费一次 revert 边界。
    const cleanupOps = new Map<SessionID, Deferred.Deferred<Exit.Exit<void>>>()

    const revert = Effect.fn("SessionRevert.revert")(function* (input: RevertInput) {
      yield* state.assertNotBusy(input.sessionID)
      // acquireUseRelease：beginRevert 成功后 endRevert 立即注册为 finalizer，
      // 消除 beginRevert 与 Effect.ensuring 之间的理论中断窗口。
      // beginRevert 失败（已 reverting）时 endRevert 不执行——不会误清除其他 revert 的标志。
      return yield* Effect.acquireUseRelease(
        state.beginRevert(input.sessionID),
        () =>
          Effect.gen(function* () {
            // 只加载 input.messageID 及之后的尾部消息，避免大 session 全量分页加载。
            // partID 场景（部分撤回）需要 lastUser（input.messageID 之前的最近 user 消息），
            // 仍加载全部作为安全回退。
            // narrowing：非 partID + assistant messageID（仅 API 直传可达，TUI 不可达）时，
            // lastUser 为 undefined → rev.messageID = assistant 自身（旧行为是之前的 user）。
            // 此差异可接受——保留 user 提问不造成数据损坏。
            const all = yield* sessions.messages(
              input.partID
                ? { sessionID: input.sessionID }
                : { sessionID: input.sessionID, fromMessageID: input.messageID },
            ).pipe(Effect.orDie)
            let lastUser: MessageV2.User | undefined
            const session = yield* sessions.get(input.sessionID).pipe(Effect.orDie)

            let rev: Session.Info["revert"]
            const patches: Snapshot.Patch[] = []
            for (const msg of all) {
              if (msg.info.role === "user") lastUser = msg.info
              const remaining = []
              for (const part of msg.parts) {
                if (rev) {
                  if (part.type === "patch") patches.push(part)
                  continue
                }

                if (!rev) {
                  if ((msg.info.id === input.messageID && !input.partID) || part.id === input.partID) {
                    const partID = remaining.some((item) => ["text", "tool"].includes(item.type)) ? input.partID : undefined
                    rev = {
                      messageID: !partID && lastUser ? lastUser.id : msg.info.id,
                      partID,
                    }
                  }
                  remaining.push(part)
                }
              }
            }

            if (!rev) return session

            // 只认工具流声明的文件（edit/write/apply_patch metadata）。
            // snapshot.patch() 的时间窗会混入同目录其他 session/外部改动；
            // 与 toolFiles 取交集后只 checkout 本 session 工具认领的文件。
            // toolFiles 为空（只读/bash/无 declared 元数据）时交集为空：消息可 undo，磁盘不撤。
            const range = all.filter((msg) => msg.info.id >= rev.messageID)
            const toolDiffs = yield* summary.computeDiff({ messages: range })
            const ictx = yield* InstanceState.context
            const toolFiles = new Set(
              toolDiffs
                .map((d) => d.file)
                .filter((f): f is string => Boolean(f))
                .map((f) => path.join(ictx.worktree, f).replaceAll("\\", "/")),
            )
            const filteredPatches = patches.map((p) => ({
              ...p,
              files: p.files.filter((f) => toolFiles.has(f)),
            }))
            // 记录被 revert 的文件列表，供后续 unrevert/二次 revert 的 restore 精确恢复
            const revertedFiles = Array.from(new Set(filteredPatches.flatMap((p) => p.files)))

            rev.snapshot = session.revert?.snapshot ?? (yield* snap.track())
            // 二次 revert：先恢复到上次 revert 前的状态，只恢复上次被 revert 的文件
            if (session.revert?.snapshot) yield* snap.restore(session.revert.snapshot, session.revert.files)
            yield* snap.revert(filteredPatches)
            if (rev.snapshot) rev.diff = yield* snap.diff(rev.snapshot)
            const diffs = toolDiffs
            yield* storage.write(["session_diff", input.sessionID], diffs).pipe(Effect.ignore)
            yield* bus.publish(Session.Event.Diff, { sessionID: input.sessionID, diff: diffs })
            yield* sessions.setRevert({
              sessionID: input.sessionID,
              revert: { ...rev, files: revertedFiles.length > 0 ? revertedFiles : undefined },
              summary: {
                additions: diffs.reduce((sum, x) => sum + x.additions, 0),
                deletions: diffs.reduce((sum, x) => sum + x.deletions, 0),
                files: diffs.length,
              },
            })
            return yield* sessions.get(input.sessionID).pipe(Effect.orDie)
          }),
        () => state.endRevert(input.sessionID),
      )
    })

    const unrevert = Effect.fn("SessionRevert.unrevert")(function* (input: { sessionID: SessionID }) {
      log.info("unreverting", input)
      yield* state.assertNotBusy(input.sessionID)
      // unrevert 也修改文件（snap.restore），同样需要 reverting 守卫防止与 prompt 竞争
      return yield* Effect.acquireUseRelease(
        state.beginRevert(input.sessionID),
        () =>
          Effect.gen(function* () {
            const session = yield* sessions.get(input.sessionID).pipe(Effect.orDie)
            if (!session.revert) return session
            // 只恢复被 revert 的文件，避免覆盖同目录其他 session 的改动
            if (session.revert.snapshot) yield* snap.restore(session.revert.snapshot, session.revert.files)
            yield* sessions.clearRevert(input.sessionID)
            return yield* sessions.get(input.sessionID).pipe(Effect.orDie)
          }),
        () => state.endRevert(input.sessionID),
      )
    })

    const cleanupCurrent = Effect.fn("SessionRevert.cleanupCurrent")(function* (sessionID: SessionID) {
      // 调用方可能持有 cleanup 前的 Session 快照；必须重读当前值，防止旧边界隐藏后来创建的消息。
      const session = yield* sessions.get(sessionID).pipe(Effect.orDie)
      if (!session.revert) return
      // 本次 owner 固定使用同一个边界，后续异步写入不能改变这次 cleanup 的解释范围。
      const boundary = session.revert
      const msgs = yield* sessions.messages({ sessionID }).pipe(Effect.orDie)
      const messageID = boundary.messageID
      const remove = [] as MessageV2.WithParts[]
      let target: MessageV2.WithParts | undefined
      for (const msg of msgs) {
        if (msg.info.id < messageID) continue
        if (msg.info.id > messageID) {
          remove.push(msg)
          continue
        }
        if (boundary.partID) {
          target = msg
          continue
        }
        remove.push(msg)
      }
      for (const msg of remove) {
        const next = {
          ...msg.info,
          hidden: { time: Date.now(), reason: "undo" as const },
        }
        if (next.role === "assistant" && !next.time.completed) {
          next.time.completed = next.hidden.time
          next.error ??= new MessageV2.AbortedError({ message: "Aborted by undo" }).toObject()
        }
        yield* sessions.updateMessage(next)
        if (next.role === "assistant" && next.parentID) {
          const usage = Option.getOrUndefined(yield* Effect.serviceOption(SessionRequestUsage.Service))
          if (usage) yield* usage.recordAssistant({ sessionID, requestID: next.parentID, assistant: next })
        }
      }
      if (boundary.partID && target) {
        const partID = boundary.partID
        const idx = target.parts.findIndex((part) => part.id === partID)
        if (idx >= 0) {
          const removeParts = target.parts.slice(idx)
          target.parts = target.parts.slice(0, idx)
          for (const part of removeParts) {
            yield* sessions.updatePart({
              ...part,
              hidden: { time: Date.now(), reason: "undo" },
            } satisfies MessageV2.Part)
          }
        }
      }
      yield* sessions.clearRevert(sessionID)
    })

    const cleanup = Effect.fn("SessionRevert.cleanup")(function* (session: Session.Info) {
      const existing = cleanupOps.get(session.id)
      if (existing) {
        // joiner 重放 owner 的完整 Exit，不能把 cleanup failure 静默降级成成功。
        const exit = yield* Deferred.await(existing)
        if (Exit.isFailure(exit)) yield* Effect.failCause(exit.cause)
        return
      }

      // Deferred 分配与 Map 登记之间没有异步 I/O，保持与 SessionPrompt.cancel 相同的原子登记约束。
      const deferred = yield* Deferred.make<Exit.Exit<void>>()
      cleanupOps.set(session.id, deferred)
      yield* cleanupCurrent(session.id).pipe(
        Effect.onExit((exit) =>
          Effect.uninterruptible(
            Effect.gen(function* () {
              // 以值保存 Exit，让后续 caller 得到与 owner 完全一致的 success/failure/interrupt。
              // 先完成Deferred再删登记，交叠caller只能join完成值而不能另起cleanup owner。
              yield* Deferred.succeed(deferred, exit as Exit.Exit<void>).pipe(Effect.asVoid)
              cleanupOps.delete(session.id)
            }),
          ),
        ),
      )
    })

    return Service.of({ revert, unrevert, cleanup })
  }),
)

export const defaultLayer = Layer.suspend(() =>
  layer.pipe(
    Layer.provide(SessionRunState.defaultLayer),
    Layer.provide(Session.defaultLayer),
    Layer.provide(Snapshot.defaultLayer),
    Layer.provide(Storage.defaultLayer),
    Layer.provide(Bus.layer),
    Layer.provide(SessionSummary.defaultLayer),
    Layer.provide(SyncEvent.defaultLayer),
  ),
)

export * as SessionRevert from "./revert"
