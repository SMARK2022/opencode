import { Effect, Layer, Context, Schema } from "effect"
import { Bus } from "@/bus"
import { Snapshot } from "@/snapshot"
import { Storage } from "@/storage/storage"
import { InstanceState } from "@/effect/instance-state"
import * as Session from "./session"
import { MessageV2 } from "./message-v2"
import { SummaryCache } from "./summary-cache"
import { SessionID, MessageID } from "./schema"

export interface Interface {
  readonly summarize: (input: { sessionID: SessionID; messageID: MessageID }) => Effect.Effect<void>
  readonly diff: (input: { sessionID: SessionID; messageID?: MessageID }) => Effect.Effect<Snapshot.FileDiff[]>
  readonly computeDiff: (input: { messages: MessageV2.WithParts[] }) => Effect.Effect<Snapshot.FileDiff[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionSummary") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const storage = yield* Storage.Service
    const bus = yield* Bus.Service

    const computeDiff = Effect.fn("SessionSummary.computeDiff")(function* (input: { messages: MessageV2.WithParts[] }) {
      // 修改文件追踪以「工具调用流」为唯一来源：edit/write/apply_patch 各自携带
      // 落盘前后的文件改动证据（part.state.metadata），按文件聚合后能区分不同工具/
      // 并行 subagent 的改动归属。不使用 git 整树快照 diff（diffFull）兜底——后者在
      // 同目录多 session 场景下会把其他 session 的改动并入（A∪B 问题），也无法区分
      // 工具改动与外部改动。工具未覆盖的文件（bash/MCP/手动编辑）不出现在 diff 中，
      // 这是有意为之的取舍：宁可遗漏非工具改动，也不混入其他 session 的改动。
      const ctx = yield* InstanceState.context
      const base = ctx.worktree && ctx.worktree !== "/" ? ctx.worktree : ctx.directory
      return SummaryCache.collectToolDiffs(SummaryCache.toToolDiffMessages(input.messages), base)
    })

    const summarize = Effect.fn("SessionSummary.summarize")(function* (input: {
      sessionID: SessionID
      messageID: MessageID
    }) {
      const prepared = yield* SummaryCache.prepareDelta({
        sessionID: input.sessionID,
        targetMessageID: input.messageID,
        storage,
      })
      const messages = prepared.snapshotMaxID
        ? yield* MessageV2.targetWithAssistantChildren({
            sessionID: input.sessionID,
            messageID: input.messageID,
            throughMessageID: MessageID.make(prepared.snapshotMaxID),
          })
        : []
      const target = messages.find((message) => message.info.id === input.messageID)
      if (target?.info.role === "user") {
        const msgDiffs = yield* computeDiff({ messages })
        target.info.summary = { ...target.info.summary, diffs: msgDiffs }
        yield* sessions.updateMessageSummary(target.info)
      }

      // aggregate 在 per-user metadata 持久化后 CAS 提交；两者共享同一 snapshot 上界，
      // 但 summary-only update 不改变 Tool history，也不得使旧 ref/cursor 失效。
      yield* SummaryCache.commit(prepared)
      // cursor-only 提交没有改变 aggregate，既不需要读取旧 payload，也不重复广播/写兼容 mirror。
      if (prepared.type === "unchanged") return
      const diffs = prepared.diffs
      yield* sessions.setSummary({
        sessionID: input.sessionID,
        summary: {
          additions: diffs.reduce((sum, x) => sum + x.additions, 0),
          deletions: diffs.reduce((sum, x) => sum + x.deletions, 0),
          files: diffs.length,
        },
      })
      yield* storage.write(["session_diff", input.sessionID], diffs).pipe(Effect.ignore)
      yield* bus.publish(Session.Event.Diff, { sessionID: input.sessionID, diff: diffs })
    })

    const diff = Effect.fn("SessionSummary.diff")(function* (input: { sessionID: SessionID; messageID?: MessageID }) {
      const diffs = yield* SummaryCache.load({ sessionID: input.sessionID, storage })
      const next = SummaryCache.normalizeDiffPaths(diffs)
      // mirror 是 commit 后的 downgrade 兼容副本；即使路径未变化，也要允许用户清理后重新生成。
      yield* storage.write(["session_diff", input.sessionID], next).pipe(Effect.ignore)
      return next
    })

    return Service.of({ summarize, diff, computeDiff })
  }),
)

export const defaultLayer = Layer.suspend(() =>
  layer.pipe(
    Layer.provide(Session.defaultLayer),
    Layer.provide(Storage.defaultLayer),
    Layer.provide(Bus.layer),
  ),
)

export const DiffInput = Schema.Struct({
  sessionID: SessionID,
  messageID: Schema.optional(MessageID),
})
export type DiffInput = Schema.Schema.Type<typeof DiffInput>

export * as SessionSummary from "./summary"
