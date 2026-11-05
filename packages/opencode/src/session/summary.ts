import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Layer, Context, Schema } from "effect"
import { ToolDiffs } from "@opencode-ai/core/session/tool-diffs"
import { SessionStore } from "@opencode-ai/core/session/store"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Snapshot } from "@/snapshot"
import { InstanceState } from "@/effect/instance-state"
import { Session } from "./session"
import { MessageV2 } from "./message-v2"
// #0500：aggregate 权威与 per-file 归一化移入 SummaryCache——summary 层只剩 seam 编排。
import { SummaryCache } from "./summary-cache"
import { SessionID, MessageID } from "./schema"
import { Config } from "@/config/config"
import { Storage } from "@/storage/storage"
import { Database } from "@opencode-ai/core/database/database"


export interface Interface {
  readonly summarize: (input: { sessionID: SessionID; messageID: MessageID }) => Effect.Effect<void>
  // 投影选择传到存储 owner，调用方无需先读完整正文再丢弃。
  readonly diff: (input: { sessionID: SessionID; messageID?: MessageID; statsOnly?: boolean }) => Effect.Effect<Snapshot.FileDiff[]>
  readonly computeDiff: (input: { messages: SessionV1.WithParts[] }) => Effect.Effect<Snapshot.FileDiff[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionSummary") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const events = yield* EventV2Bridge.Service
    const nativeMessages = yield* SessionStore.Service
    const config = yield* Config.Service
    const storage = yield* Storage.Service
    const database = yield* Database.Service

    const computeDiff = Effect.fn("SessionSummary.computeDiff")(function* (input: { messages: SessionV1.WithParts[] }) {
      // 修改文件只按本会话已完成工具的真实metadata归因；整树快照会混入同目录其他会话的改动。
      // Bash/MCP/手工改动不进入此列表是source明确取舍，隐藏或撤回消息也不能重新计入。
      const ctx = yield* InstanceState.context
      const base = ctx.worktree && ctx.worktree !== "/" ? ctx.worktree : ctx.directory
      return ToolDiffs.collect(input.messages.flatMap((message) => message.info.hidden ? [] :
        message.parts.flatMap((part) => part.hidden || part.type !== "tool" || part.state.status !== "completed"
          ? [] : [part.state.metadata]),
      ), base)
    })

    const summarize = Effect.fn("SessionSummary.summarize")(function* (input: {
      sessionID: SessionID
      messageID: MessageID
    }) {
      if ((yield* config.get()).snapshot === false) return
      // #0500：prepareDelta 返回 snapshot 上界与上次已提交基线；重活只在 boundary 后进行。
      const prepared = yield* SummaryCache.prepareDelta({
        sessionID: input.sessionID,
        targetMessageID: input.messageID,
        storage,
      }).pipe(Effect.provideService(Database.Service, database))
      // 只取目标 user 与其 assistant children——为一个 turn hydrate 整个 Session 是无意义预热。
      const messages = prepared.snapshotMaxID
        ? yield* MessageV2.targetWithAssistantChildren({
            sessionID: input.sessionID,
            messageID: input.messageID,
            throughMessageID: MessageID.make(prepared.snapshotMaxID),
          }).pipe(Effect.provideService(Database.Service, database))
        : []
      const target = messages.find((message) => message.info.id === input.messageID)
      if (target?.info.role === "user") {
        const msgDiffs = yield* computeDiff({ messages })
        target.info.summary = { ...target.info.summary, diffs: msgDiffs }
        yield* sessions.updateMessageSummary(target.info)
      }
      // aggregate 在 per-user metadata 持久化后 CAS 提交；两者共享同一 snapshot 上界，
      // 但 summary-only update 不改变 Tool history，也不得使旧 ref/cursor 失效。
      yield* SummaryCache.commit(prepared).pipe(Effect.provideService(Database.Service, database))
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
      yield* events.publish(Session.Event.Diff, { sessionID: input.sessionID, diff: diffs })
    })

    // 指定 messageID 保持原回合读取；会话总览才按 statsOnly 选择聚合投影。
    const diff = Effect.fn("SessionSummary.diff")(function* (input: { sessionID: SessionID; messageID?: MessageID; statsOnly?: boolean }) {
      if (input.messageID) {
        // 混合历史按 Message 身份选择持久 owner，精确回合不能退回整个会话的汇总。
        const native = yield* nativeMessages.message(SessionMessage.ID.make(input.messageID), input.sessionID)
        if (native) return native.message.type === "user" ? native.message.summary?.diffs.map(item => ({ ...item })) ?? [] : []
        const legacy = yield* MessageV2.get({ sessionID: input.sessionID, messageID: input.messageID }).pipe(
          Effect.provideService(Database.Service, database),
          // 查询不存在或隐藏的回合返回空集合；数据库和冷包故障仍沿原错误路径传播。
          Effect.catchTag("NotFoundError", () => Effect.succeed(undefined)),
        )
        return legacy?.info.role === "user" ? SummaryCache.normalizeDiffPaths(legacy.info.summary?.diffs ?? []) : []
      }
      // 读取只消费 DB 权威聚合；镜像由摘要变更和撤回的写入端维护，避免每次查看重写全部 patch。
      const diffs = yield* SummaryCache.load({ sessionID: input.sessionID, storage, statsOnly: input.statsOnly }).pipe(
        Effect.provideService(Database.Service, database),
      )
      return SummaryCache.normalizeDiffPaths(diffs)
    })

    return Service.of({ summarize, diff, computeDiff })
  }),
)



export const DiffInput = Schema.Struct({
  sessionID: SessionID,
  messageID: Schema.optional(MessageID),
})
export type DiffInput = Schema.Schema.Type<typeof DiffInput>

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  // 两代摘要读取仍使用各自持久消息表，不再为Modified Files构造整树快照。
  deps: [Session.node, EventV2Bridge.node, Config.node, SessionStore.node, Storage.node, Database.node],
})

export * as SessionSummary from "./summary"
