import { Effect, Layer, Context, Schema, Option } from "effect"
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

    const revert = Effect.fn("SessionRevert.revert")(function* (input: RevertInput) {
      yield* state.assertNotBusy(input.sessionID)
      const all = yield* sessions.messages({ sessionID: input.sessionID }).pipe(Effect.orDie)
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

      // 按工具触碰文件过滤 patch：同目录多 session 场景下，snapshot.patch() 列出的
      // 变更文件包含其他 session 的改动。通过 computeDiff（仅工具流）提取本 session
      // 工具实际触碰的文件，过滤 patch.files 以避免 revert 覆盖其他 session 的文件。
      // 安全网：当 session 无工具 part（如纯 bash turn 或旧数据）时 toolFiles 为空，
      // 此时不过滤，保持原始行为——避免误丢弃非工具 session 的全部 revert 能力。
      const range = all.filter((msg) => msg.info.id >= rev.messageID)
      const toolDiffs = yield* summary.computeDiff({ messages: range })
      const ictx = yield* InstanceState.context
      const toolFiles = new Set(
        toolDiffs
          .map((d) => d.file)
          .filter((f): f is string => Boolean(f))
          .map((f) => path.join(ictx.worktree, f).replaceAll("\\", "/")),
      )
      const filteredPatches = toolFiles.size > 0
        ? patches.map((p) => ({ ...p, files: p.files.filter((f) => toolFiles.has(f)) }))
        : patches
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
    })

    const unrevert = Effect.fn("SessionRevert.unrevert")(function* (input: { sessionID: SessionID }) {
      log.info("unreverting", input)
      yield* state.assertNotBusy(input.sessionID)
      const session = yield* sessions.get(input.sessionID).pipe(Effect.orDie)
      if (!session.revert) return session
      // 只恢复被 revert 的文件，避免覆盖同目录其他 session 的改动
      if (session.revert.snapshot) yield* snap.restore(session.revert.snapshot, session.revert.files)
      yield* sessions.clearRevert(input.sessionID)
      return yield* sessions.get(input.sessionID).pipe(Effect.orDie)
    })

    const cleanup = Effect.fn("SessionRevert.cleanup")(function* (session: Session.Info) {
      if (!session.revert) return
      const sessionID = session.id
      const msgs = yield* sessions.messages({ sessionID }).pipe(Effect.orDie)
      const messageID = session.revert.messageID
      const remove = [] as MessageV2.WithParts[]
      let target: MessageV2.WithParts | undefined
      for (const msg of msgs) {
        if (msg.info.id < messageID) continue
        if (msg.info.id > messageID) {
          remove.push(msg)
          continue
        }
        if (session.revert.partID) {
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
      if (session.revert.partID && target) {
        const partID = session.revert.partID
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
