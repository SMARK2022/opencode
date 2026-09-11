import { eq, sql } from "drizzle-orm"
import { Effect, Schema } from "effect"
import { Database } from "@/storage/db"
import { NotFoundError } from "@/storage/storage"
import { MessageID, SessionID } from "./schema"
import { SessionTable } from "./session.sql"

// 与上游 @opencode-ai/core 的 SystemContext 持久形状对齐：snapshot 按来源命名空间保存 {value}，
// baseline 保存初始渲染文本；普通日期变化只推进 snapshot 并追加 updates，不重写 baseline。
// SourceSnapshot 与上游 SystemContext 的单来源持久形状一致：当前两来源都是字符串值。
const SourceSnapshot = Schema.Struct({ value: Schema.String })

// 持久编码对齐上游 Session.Message.System；本地 wire 投影为 user reminder，不走 system 历史消息。
const SystemMessage = Schema.Struct({
  id: MessageID,
  type: Schema.Literal("system"),
  // created 为 epoch 毫秒数，与上游 DateTimeUtcFromMillis 编码后的持久形状一致。
  time: Schema.Struct({ created: Schema.Number }),
  text: Schema.String,
})

// after_message_id 用 snake_case 与数据库/JSON 惯例一致；message 内嵌完整上游 System 编码。
export const Update = Schema.Struct({
  after_message_id: MessageID,
  message: SystemMessage,
})
export type Update = typeof Update.Type

export const Stored = Schema.Struct({
  // baseline 是首次渲染的逐字文本：前缀恢复以它为准，渲染措辞升级不会改写旧 Session 的开头。
  baseline: Schema.String,
  // snapshot 是最新比较状态：日期跨天后推进到这里，baseline 中的初始日期保持不变。
  snapshot: Schema.Struct({
    "smark/git": SourceSnapshot,
    "core/date": SourceSnapshot,
  }),
  // boundary 绑定当前历史窗口代际；compaction 完成后值变化，触发日期代重建而不是继续追加。
  boundary: Schema.String,
  // updates 自带完整消息编码，回放时不需要 join 其他表；锚点只用于定位与失效检测。
  updates: Schema.Array(Update),
})
export type Stored = typeof Stored.Type

// History 由调用方从可见 canonical 窗口计算；本模块绝不直接读取 Message 表，避免第二条历史来源。
export interface History {
  readonly boundary: string
  readonly messageIDs: readonly MessageID[]
}

// 新代只在初始化、compaction 或锚点退出可见窗口时建立；Git 值总是从既有代继承，永不重采。
const generation = (git: string, today: string, boundary: string): Stored => ({
  baseline: `${git}\nToday's date: ${today}`,
  snapshot: { "smark/git": { value: git }, "core/date": { value: today } },
  boundary,
  updates: [],
})

// reconcile 是纯函数：同事务内可对重读值重复求值，并发竞争不会产生重复更新。
const reconcile = (
  stored: Stored,
  now: Date,
  history: History,
): { readonly _tag: "unchanged"; readonly value: Stored } | { readonly _tag: "changed"; readonly value: Stored } => {
  const today = now.toDateString()
  // 完成的 compaction 会更换 boundary；undo cleanup 可能让已存更新的锚点退出可见窗口。
  // 两者都使旧代不可继续追加：以当前日期建立新代，Git 快照跨代保留。
  const anchorsVisible = stored.updates.every((update) => history.messageIDs.includes(update.after_message_id))
  // Git 快照在代内永不重采；只有日期与窗口代际参与比较。
  if (stored.boundary !== history.boundary || !anchorsVisible) {
    return { _tag: "changed", value: generation(stored.snapshot["smark/git"].value, today, history.boundary) }
  }
  // unchanged 返回原对象本身：调用方与写路径都能据此跳过一切后续工作。
  if (stored.snapshot["core/date"].value === today) return { _tag: "unchanged", value: stored }
  const anchor = history.messageIDs.at(-1)
  // 空窗口没有可锚定的消息；新代直接以当前日期为 baseline，不产生悬空更新。
  if (!anchor) return { _tag: "changed", value: generation(stored.snapshot["smark/git"].value, today, history.boundary) }
  // 一次跨越多日只记录当前日期；跳过的日期没有对应请求，不补造历史。
  // 日期比较与渲染都用本地时区的 toDateString，与上游 core/date 来源的口径逐字一致。
  const update: Update = {
    after_message_id: anchor,
    message: {
      // 更新消息 id 与真实历史同工厂生成，回放时不会与任何持久 Message 冲突。
      id: MessageID.ascending(),
      type: "system",
      time: { created: now.getTime() },
      text: `Today's date is now: ${today}`,
    },
  }
  return {
    _tag: "changed",
    value: {
      ...stored,
      snapshot: { ...stored.snapshot, "core/date": { value: today } },
      updates: [...stored.updates, update],
    },
  }
}

// prepare 是上下文代际的唯一入口：返回当前代的内容与待投影更新，写路径全部走同步事务。
// captureGit 只在 NULL 初始化分支真正执行；同日同窗口的常规调用是纯读，不产生任何写。
export const prepare = Effect.fn("SessionContextEpoch.prepare")(function* (input: {
  sessionID: SessionID
  history: History
  now: Date
  captureGit: Effect.Effect<string>
}) {
  const read = () =>
    Database.use((db) =>
      db.select({ epoch: SessionTable.context_epoch }).from(SessionTable).where(eq(SessionTable.id, input.sessionID)).get(),
    )
  // 同一天/同窗口的常规 prepare 是纯读路径：不加写锁、不动 time_updated，逐步骤调用不产生任何写放大。
  const row = read()
  // 环境准备只为已持久化的 Session 调用；行缺失说明 Session 生命周期已经结束，按现有错误合同失败。
  if (!row) return yield* new NotFoundError({ message: `Session not found: ${input.sessionID}` })
  // 持久格式损坏属于数据错误：按现有错误路径终止请求，绝不回退到实时重采。
  // 每次 prepare 都经过 Schema 解码：持久边界上的漂移必须在第一时间失败，而不是被静默采信。
  if (row.epoch !== null) {
    const stored = Schema.decodeUnknownSync(Stored)(row.epoch)
    const result = reconcile(stored, input.now, input.history)
    if (result._tag === "unchanged") return stored
    // immediate 在 BEGIN 时就取得写锁：跨进程两个写者不会都在 deferred 读后才竞争升级。
    return Database.transaction(
      (tx) => {
        const fresh = tx
          .select({ epoch: SessionTable.context_epoch })
          .from(SessionTable)
          .where(eq(SessionTable.id, input.sessionID))
          .get()
        if (!fresh) throw new Error(`Session deleted during context epoch update: ${input.sessionID}`)
        // 并发写者可能已提交相同变化；对重读值重新 reconcile 保持幂等。
        const winner = reconcile(Schema.decodeUnknownSync(Stored)(fresh.epoch), input.now, input.history)
        if (winner._tag !== "unchanged") write(tx, input.sessionID, winner.value)
        return winner.value
      },
      { behavior: "immediate" },
    )
  }

  // Git 采集在两个并发初始化者间可能重复；采集在事务外执行，事务内重读保证最终采用已提交的胜者值。
  const git = yield* input.captureGit
  return Database.transaction(
    (tx) => {
      const fresh = tx
        .select({ epoch: SessionTable.context_epoch })
        .from(SessionTable)
        .where(eq(SessionTable.id, input.sessionID))
        .get()
      if (!fresh) throw new Error(`Session deleted during context epoch initialization: ${input.sessionID}`)
      // 胜者路径不再执行本地候选的 reconcile 之外逻辑；胜出的值就是唯一事实来源。
      if (fresh.epoch !== null) return Schema.decodeUnknownSync(Stored)(fresh.epoch)
      const created = generation(git, input.now.toDateString(), input.history.boundary)
      write(tx, input.sessionID, created)
      return created
    },
    { behavior: "immediate" },
  )
})

// time_updated 不参与环境快照语义；显式保留原值避免上下文准备改变 Session 排序。
const write = (tx: Database.TxOrDb, sessionID: SessionID, value: Stored) =>
  tx
    .update(SessionTable)
    .set({ context_epoch: value, time_updated: sql`${SessionTable.time_updated}` })
    .where(eq(SessionTable.id, sessionID))
    .run()

export interface UpdatePlacement {
  // after：锚点消息完整块（含 tool-result 伴随消息）之后；before：锚点被裁剪时第一个保留后继之前；
  // end：整个保留窗口不含锚点及其后继时，位于当前 turn 末尾。
  readonly placement:
    | { readonly type: "after"; readonly id: MessageID }
    | { readonly type: "before"; readonly id: MessageID }
    | { readonly type: "end" }
  readonly text: string
}

// decide/插件可能裁掉锚点消息；更新改放到第一个仍保留的后继之前，仍保留的消息则紧跟其后。
export function projectUpdates(input: {
  updates: readonly Update[]
  canonicalIDs: readonly MessageID[]
  retainedIDs: ReadonlySet<MessageID>
}): UpdatePlacement[] {
  // 每条更新恰好出现一次；返回顺序与持久 updates 的插入顺序一致，同一槽位内按时间递进。
  // 锚点必然在 canonicalIDs 中（prepare 已校验）；缺失时按 end 处理是确定性退化，不是另一条成功路径。
  return input.updates.map((update) => {
    const anchor = update.after_message_id
    if (input.retainedIDs.has(anchor)) return { placement: { type: "after", id: anchor }, text: update.message.text }
    const order = input.canonicalIDs.indexOf(anchor)
    // 只向后找后继：更新描述的是锚点时刻之后的状态，不能插到更早的消息之前。
    const successor = order < 0 ? undefined : input.canonicalIDs.slice(order + 1).find((id) => input.retainedIDs.has(id))
    return successor
      ? { placement: { type: "before", id: successor }, text: update.message.text }
      : { placement: { type: "end" }, text: update.message.text }
  })
}

export * as SessionContextEpoch from "./context-epoch"
