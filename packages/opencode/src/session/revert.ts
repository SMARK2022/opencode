import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Layer, Context, Schema, Option, Deferred, Exit } from "effect"
import path from "path"
import { InstanceState } from "@/effect/instance-state"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Snapshot } from "../snapshot"
import { Storage } from "@/storage/storage"
import { Session } from "./session"
import { MessageV2 } from "./message-v2"
import { SessionID, MessageID, PartID } from "./schema"
import { SessionRunState } from "./run-state"
import { SessionSummary } from "./summary"
import { SessionRequestUsage } from "@opencode-ai/core/session/request-usage"

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

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const snap = yield* Snapshot.Service
    const storage = yield* Storage.Service
    const events = yield* EventV2Bridge.Service
    const summary = yield* SessionSummary.Service
    const state = yield* SessionRunState.Service
    // #482：同一 Session 的 cleanup 必须是 single-flight：并发 prompt/compact 只能共同消费一次 revert 边界。
    const cleanupOps = new Map<SessionID, Deferred.Deferred<Exit.Exit<void>>>()

    const revert = Effect.fn("SessionRevert.revert")(function* (input: RevertInput) {
      // acquireUseRelease：beginRevert 成功后 endRevert 立即注册为 finalizer，
      // 消除 beginRevert 与 Effect.ensuring 之间的理论中断窗口。
      // beginRevert 失败（已 reverting）时 endRevert 不执行——不会误清除其他 revert 的标志。
      // #393：busy runner 期间同样拒绝——snap.restore/revert 与运行中工具的文件写入在服务层拦截
      yield* state.assertNotBusy(input.sessionID)
      return yield* Effect.acquireUseRelease(
        state.beginRevert(input.sessionID),
        () =>
          Effect.gen(function* () {
            // 只加载 input.messageID 及之后的尾部消息，避免大 session 全量分页加载。
            // partID 场景（部分撤回）需要 lastUser，仍加载全部作为安全回退。
            const all = yield* sessions
              .messages(
                input.partID
                  ? { sessionID: input.sessionID }
                  : { sessionID: input.sessionID, fromMessageID: input.messageID },
              )
              .pipe(Effect.orDie)
            let lastUser: SessionV1.User | undefined
            const session = yield* sessions.get(input.sessionID).pipe(Effect.orDie)

            let rev: Session.Info["revert"]
            const patches: SessionV1.PatchPart[] = []
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
                    const partID = remaining.some((item) => ["text", "tool"].includes(item.type))
                      ? input.partID
                      : undefined
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

            // #557：Revert range 与 Prompt 使用同一个 persisted comparator，不能恢复 lexical-low 后继之外的行。
            const boundaryRow = all.find((msg) => msg.info.id === rev.messageID)
            if (!boundaryRow) throw new Error(`Revert boundary missing from Session history: ${rev.messageID}`)
            const range = all.filter((msg) => MessageV2.compareChronology(msg.info, boundaryRow.info) >= 0)
            // range 可包含 hidden audit rows；真正文件 admission 仍由各 Tool policy 决定。
            const ictx = yield* InstanceState.context
            // #557：declared diff 按 Assistant 单独计算，禁止后续 Tool 把文件 authority 回传给早期 Patch。
            // #557：per-Assistant ownership——文件 authority 不跨 Assistant 传递。
            const ownership = yield* Effect.forEach(range, (msg) =>
              Effect.gen(function* () {
                const diffs = yield* summary.computeDiff({
                  messages: [
                    {
                      ...msg,
                      parts: msg.parts.filter((part) => part.type !== "tool" || part.metadata?.worktree === "declared"),
                    },
                  ],
                })
                const files = new Set(
                  diffs.flatMap((d) => (d.file ? [path.join(ictx.worktree, d.file).replaceAll("\\", "/")] : [])),
                )
                // authority 必须停留在所属 Assistant；后续 ambient 不能反向授权更早 Patch。
                if (msg.parts.some((part) => part.type === "tool" && part.metadata?.worktree === "ambient"))
                  msg.parts
                    .filter((part) => part.type === "patch")
                    .flatMap((part) => part.files)
                    .forEach((file) => files.add(file))
                return { id: msg.info.id, diffs, files }
              }),
            )
            const toolDiffs = ownership.flatMap((item) => item.diffs)
            // #557：messageID 是 Patch 与 authority 的稳定关联键，不能退化为 range 级文件并集。
            // #557：ownership 键是 messageID——Patch 文件 admission 不退化为 range 并集。
            const toolFiles = new Map<string, Set<string>>(ownership.map((item) => [item.id, item.files]))
            // #545：无条件交集——空 toolFiles 不再回退全量 revert，避免只读 turn 误撤 ambient 改动。
            // Patch 未被 declared 或 ambient owner 接纳时保留空 files，hash 顺序不改写。
            const filteredPatches = patches.map((p) => ({
              ...p,
              files: p.files.filter((f) => toolFiles.get(p.messageID)?.has(f)),
            }))
            // 记录被 revert 的文件列表（revertedPaths），供 unrevert/二次 revert 精确恢复
            const revertedFiles = Array.from(new Set(filteredPatches.flatMap((p) => p.files)))

            rev.snapshot = session.revert?.snapshot ?? (yield* snap.track())
            // 二次 revert：先恢复到上次 revert 前的状态，只恢复上次被 revert 的文件
            if (session.revert?.snapshot) yield* snap.restore(session.revert.snapshot, session.revert.revertedPaths)
            yield* snap.revert(filteredPatches)
            if (rev.snapshot) rev.diff = yield* snap.diff(rev.snapshot)
            const diffs = toolDiffs
            yield* storage.write(["session_diff", input.sessionID], diffs).pipe(Effect.ignore)
            yield* events.publish(Session.Event.Diff, { sessionID: input.sessionID, diff: diffs })
            yield* sessions.setRevert({
              sessionID: input.sessionID,
              revert: { ...rev, revertedPaths: revertedFiles.length > 0 ? revertedFiles : undefined },
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
      yield* Effect.logInfo("unreverting", { sessionID: input.sessionID })
      // unrevert 也修改文件（snap.restore），同样需要 reverting 守卫防止与 prompt 竞争
      // #393：busy runner 期间 unrevert 同样拒绝，保持 revert 路径的双层守卫对称
      yield* state.assertNotBusy(input.sessionID)
      return yield* Effect.acquireUseRelease(
        state.beginRevert(input.sessionID),
        () =>
          Effect.gen(function* () {
            const session = yield* sessions.get(input.sessionID).pipe(Effect.orDie)
            if (!session.revert) return session
            // 恢复撤回前快照，标志仍与正常revert共用同一释放边界。
            if (session.revert.snapshot) yield* snap.restore(session.revert.snapshot, session.revert.revertedPaths)
            yield* sessions.clearRevert(input.sessionID)
            return yield* sessions.get(input.sessionID).pipe(Effect.orDie)
          }),
        () => state.endRevert(input.sessionID),
      )
    })

    // #482：cleanupCurrent 在单次执行内冻结同一个 revert 边界（boundary.messageID/partID）；
    // 异步 await 之后不得改读活跃 session.revert——并发 revert 可能已写入新边界，
    // 混合解释会隐藏错误消息并吞掉用户的新 revert；boundary 是本次清理的唯一事实
    const cleanupCurrent = Effect.fn("SessionRevert.cleanupCurrent")(function* (sessionID: SessionID) {
      const session = yield* sessions.get(sessionID).pipe(Effect.orDie)
      if (!session.revert) return
      const boundary = session.revert
      // cleanup 可在边界已隐藏后重入；只读本次边界之后的原始范围，避免扩到完整审计历史。
      const msgs = yield* sessions
        .messages({ sessionID, fromMessageID: boundary.messageID, includeHidden: true })
        .pipe(Effect.orDie)
      const messageID = boundary.messageID
      const boundaryMessage = msgs.find((msg) => msg.info.id === messageID)
      // #557：cleanup 与首次 revert 共用同一 boundary tuple，hidden/删除不能重新解释范围。
      if (!boundaryMessage) throw new Error(`Revert cleanup boundary missing from Session history: ${messageID}`)
      const remove = [] as MessageV2.WithParts[]
      let target: MessageV2.WithParts | undefined
      for (const msg of msgs) {
        // #557：compareChronology 替代字符串比较——持久化时间主序，ID 只作同毫秒平局。
        const order = MessageV2.compareChronology(msg.info, boundaryMessage.info)
        // partID 部分撤回保留 boundary 行；messageID 撤回连 boundary 一起 hide（旧 slice(index) 语义）。
        if (order < 0) continue
        if (order === 0) {
          target = msg
          if (boundary.partID) continue
          remove.push(msg)
          continue
        }
        remove.push(msg)
      }
      for (const msg of remove) {
        // #98：软隐藏而非物理删除，保留 DB 行
        // #153：undo 时未完成 assistant 先终态化再 soft-hide
        const incomplete = msg.info.role === "assistant" && !msg.info.time.completed
        const next = {
          ...msg.info,
          // #98：cleanup 写 hidden 而非 MessageRemoved
          // 重试和旧 tombstone 保留原时间/原因；隐藏状态不能被反复改写。
          hidden: msg.info.hidden ?? { time: Date.now(), reason: "undo" as const },
        }
        if (next.role === "assistant" && !next.time.completed) {
          // #153：补 completed，避免 UI 仍显示 streaming
          // completed 与 hidden 取同一时间戳，保证按时间排序的稳定性
          next.time.completed = next.hidden.time
          // 文案与 cancel 路径区分开，便于日志与事件流溯源撤销来源
          next.error ??= new SessionV1.AbortedError({ message: "Aborted by undo" }).toObject()
        }
        // 复用 updateMessage 的事件路径，订阅方以普通消息更新感知撤销
        if (!msg.info.hidden || incomplete) yield* sessions.updateMessage(next)
        // #153：undo 终态化绕过 processor，补记 usage 让 UI 与 token 统计识别被撤销请求
        // 有 parentID 才存在关联的请求记录，user 根消息等无需补记
        if (next.role === "assistant" && next.parentID) {
          // hide 已提交而记账中断时仍需重放此幂等 owner，之后才能清除 revert 边界。
          const usage = Option.getOrUndefined(yield* Effect.serviceOption(SessionRequestUsage.Service))
          // Interface 声明为 Effect<any, any>，收窄以维持 cleanup 的 never 契约
          if (usage)
            yield* usage.recordAssistant({
              sessionID,
              requestID: next.parentID,
              assistant: next,
            }) as Effect.Effect<void>
        }
      }
      if (boundary.partID && target) {
        // partID 同样取自冻结边界：循环期间的 await 不得改用新写入的边界值
        const partID = boundary.partID
        const idx = target.parts.findIndex((part) => part.id === partID)
        if (idx >= 0) {
          const removeParts = target.parts.slice(idx)
          target.parts = target.parts.slice(0, idx)
          for (const part of removeParts) {
            if (part.hidden) continue
            // #98：部件软隐藏保留工具输出。
            yield* sessions.updatePart({
              ...part,
              hidden: { time: Date.now(), reason: "undo" },
            })
          }
        }
      }
      yield* sessions.clearRevert(sessionID)
    })

    // #482：cleanup single-flight——joiner 重放 owner 的完整 Exit，不静默降级成功。
    const cleanup = Effect.fn("SessionRevert.cleanup")(function* (session: Session.Info) {
      const existing = cleanupOps.get(session.id)
      if (existing) {
        const exit = yield* Deferred.await(existing)
        if (Exit.isFailure(exit)) yield* Effect.failCause(exit.cause)
        return
      }
      // Deferred 分配与 Map 登记之间无异步 I/O，保持与 SessionPrompt.cancel 相同的原子登记约束。
      const deferred = yield* Deferred.make<Exit.Exit<void>>()
      cleanupOps.set(session.id, deferred)
      yield* cleanupCurrent(session.id).pipe(
        Effect.onExit((exit) =>
          Effect.uninterruptible(
            Effect.gen(function* () {
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

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [Session.node, Snapshot.node, Storage.node, EventV2Bridge.node, SessionSummary.node, SessionRunState.node],
})

export * as SessionRevert from "./revert"
