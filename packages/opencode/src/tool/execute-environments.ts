import { CodeMode } from "@opencode-ai/codemode"
import { Context, Deferred, Effect, Layer, Schema, Semaphore } from "effect"
import { Identifier } from "@/id/id"
import { InstanceState } from "@/effect/instance-state"
import { EventV2Bridge } from "@/event-v2-bridge"
import type { SessionID } from "@/session/schema"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionStore } from "@opencode-ai/core/session/store"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionV1 } from "@opencode-ai/core/v1/session"

// 状态只能由同一会话和位置复用；句柄本身不是跨会话授权凭证。
export type Location = { directory: string; workspaceID?: string }
export type Owner = Location & { sessionID: string }
export type Lease = { id: string; environment: CodeMode.Environment }
export class EnvironmentUnavailable extends Schema.TaggedErrorClass<EnvironmentUnavailable>()(
  "EnvironmentUnavailable",
  {
    message: Schema.String,
  },
) {}

// 每个会话和位置保留最近调用的八个环境；窗口外的忙项在租约结束后回收。
const ownerCapacity = 8
type Entry = Lease & {
  owner: Owner
  // 每个环境独占一个许可，互相独立的 Notebook 不共用执行锁。
  gate: Semaphore.Semaphore
  // 退休信号终止本环境全部租约；取消单个排队者不触发它。
  cancel: Deferred.Deferred<void>
  // drain 表示本轮租约及其清理均已退出，与发出取消通知不是同一时点。
  drained: Deferred.Deferred<void>
  // 计入排队租约，避免当前持有者结束时把仍等待使用的环境误判为闲置。
  users: number
  closed: boolean
}

const sameLocation = (one: Location, two: Location) =>
  one.directory === two.directory && one.workspaceID === two.workspaceID
const sameOwner = (one: Owner, two: Owner) => one.sessionID === two.sessionID && sameLocation(one, two)

export function makeRegistry(options: { nextID?: () => string } = {}) {
  const nextID = options.nextID ?? (() => Identifier.create("env", "ascending"))
  const entries = new Map<string, Entry>()
  let closing = false
  const retire = (entry: Entry) => {
    // 先关闭准入再发出取消；尚未进入许可区的租约也会看见同一个退休事实。
    entry.closed = true
    Deferred.doneUnsafe(entry.cancel, Effect.void)
    // 活动条目暂留到最后一个租约退出，close 才能等待真实清理而非丢失引用。
    if (entry.users === 0) entries.delete(entry.id)
  }
  // 状态变动延迟到 Effect 真正执行，单纯构造一个 use 请求不会占用目录容量。
  const acquire = (owner: Owner, id: string | undefined) =>
    Effect.suspend(() => {
      if (closing) return Effect.fail(new EnvironmentUnavailable({ message: "Execute environments are disposed." }))
      // 空字符串仍是显式句柄，不能用真值判断把无效复用请求悄悄变成新环境。
      let entry = id !== undefined ? entries.get(id) : undefined
      if (id !== undefined && (!entry || entry.closed || !sameOwner(owner, entry.owner)))
        return Effect.fail(
          new EnvironmentUnavailable({
            message: "Execute environment is unavailable. Omit environmentID to start a new one.",
          }),
        )
      if (!entry) {
        let fresh = nextID()
        // 已存在的句柄绝不覆盖；沿用仓库生成器，仅在当前集合真实冲突时重新生成。
        while (entries.has(fresh)) fresh = nextID()
        entry = {
          id: fresh,
          owner: { ...owner },
          environment: CodeMode.createEnvironment(),
          gate: Semaphore.makeUnsafe(1),
          cancel: Deferred.makeUnsafe(),
          drained: Deferred.makeUnsafe(),
          users: 0,
          closed: false,
        }
        entries.set(fresh, entry)
      }
      // 闲置后的新一轮租约需要新的 drain 信号，不能复用上一轮已完成的 Deferred。
      if (entry.users === 0) entry.drained = Deferred.makeUnsafe()
      // 等许可之前先计入使用者，才能让淘汰和关闭逻辑看见仍在队列里的请求。
      entries.delete(entry.id)
      entries.set(entry.id, entry)
      entry.users++
      return Effect.succeed(entry)
    })
  return {
    use<A, E, R>(
      owner: Owner,
      id: string | undefined,
      run: (lease: Lease) => Effect.Effect<A, E, R>,
    ): Effect.Effect<A, E | EnvironmentUnavailable, R> {
      // 增加 users 与安装释放逻辑之间不能被取消，否则失去回收者的租约会永久占用容量。
      return Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const entry = yield* acquire(owner, id)
          const work = entry.gate.withPermits(1)(
            Effect.suspend(() => {
              // 排队期间发生删除/移动后，拿到许可也不能开始旧 owner 的代码。
              if (entry.closed) return Effect.interrupt
              // 许可覆盖 callback 的 finalizer；自发删除后即便 callback 返回，也不能报告成功。
              return run(entry).pipe(
                Effect.flatMap((value) => (entry.closed ? Effect.interrupt : Effect.succeed(value))),
              )
            }),
          )
          // 释放先于恢复可中断性安装；取消排队者只释放其租约，不触碰 holder 的取消信号。
          return yield* restore(
            Effect.raceFirst(work, Deferred.await(entry.cancel).pipe(Effect.andThen(Effect.interrupt))),
          ).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                entry.users--
                if (entry.users === 0) {
                  Deferred.doneUnsafe(entry.drained, Effect.void)
                  // 完成顺序不能覆盖调用顺序；关闭项在最后一个租约退出后删除。
                  if (entry.closed) entries.delete(entry.id)
                }
                // 最近八个唯一调用之外只回收闲置项；忙项由自己的最后一个租约退出后再检查。
                const owned = [...entries.values()].filter(
                  (candidate) => sameOwner(entry.owner, candidate.owner) && !candidate.closed,
                )
                for (const candidate of owned.slice(0, -ownerCapacity)) if (candidate.users === 0) retire(candidate)
              }),
            ),
          )
        }),
      )
    },
    // 移动只退休旧位置的状态；目的位置匹配的环境可继续保留，删除则不传目的地。
    retireSession(sessionID: string, destination?: Location) {
      return Effect.sync(() => {
        for (const entry of entries.values())
          if (entry.owner.sessionID === sessionID && (!destination || !sameLocation(entry.owner, destination)))
            retire(entry)
      })
    },
    close() {
      return Effect.uninterruptible(
        Effect.gen(function* () {
          // 先关闭整个注册表，退休过程中即使有回调重入也不能创建新环境。
          closing = true
          const pending = [...entries.values()]
          // 先通知全部条目，再等待各自清理，避免一个慢 finalizer 延迟其他执行收到取消。
          for (const entry of pending) retire(entry)
          // 不设置虚假的回收成功超时：原工具 finalizer 未退出时，目录实例必须继续等待。
          yield* Effect.forEach(pending, (entry) => (entry.users === 0 ? Effect.void : Deferred.await(entry.drained)), {
            discard: true,
            concurrency: "unbounded",
          })
        }),
      )
    },
  }
}

export interface Interface {
  use<A, E, R>(
    sessionID: SessionID,
    id: string | undefined,
    run: (lease: Lease) => Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | EnvironmentUnavailable, R>
}
export class Service extends Context.Service<Service, Interface>()("@opencode/ExecuteEnvironments") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    const sessions = yield* SessionStore.Service
    // 目录实例负责回收；workspace 仍属于条目的 owner，不能假定缓存本身按 workspace 分隔。
    const state = yield* InstanceState.make(() =>
      Effect.gen(function* () {
        const registry = makeRegistry()
        const off = yield* events.listen(
          (event) => {
            // 删除可在无 Location 的上下文发布；以会话数据而非事件外壳决定回收范围。
            // 发布的 data 已是解码值；再次执行传输 codec 会误拒绝缺省字段或 DateTime。
            if (event.type === SessionV1.Event.Deleted.type)
              return registry.retireSession(
                Schema.decodeUnknownSync(Schema.toType(SessionV1.Event.Deleted.data))(event.data).sessionID,
              )
            if (event.type === SessionEvent.Moved.type) {
              const data = Schema.decodeUnknownSync(Schema.toType(SessionEvent.Moved.data))(event.data)
              return registry.retireSession(data.sessionID, data.location)
            }
            // legacy workspace 更新使用 Updated；标题或权限变化不清掉同位置的解释器状态。
            if (event.type === SessionV1.Event.Updated.type) {
              const data = Schema.decodeUnknownSync(Schema.toType(SessionV1.Event.Updated.data))(event.data)
              return registry.retireSession(data.sessionID, data.info)
            }
            return Effect.void
          },
          { finalizerSafe: true },
        )
        // 内联通知只发取消信号，实例关闭才等待 drain，避免发布删除事件的单元等待自己。
        // 清理期间继续接收 Session 变化；全部租约结束后才解除监听。
        yield* Effect.addFinalizer(() => registry.close().pipe(Effect.ensuring(off)))
        return registry
      }),
    )
    return Service.of({
      use: <A, E, R>(sessionID: SessionID, id: string | undefined, run: (lease: Lease) => Effect.Effect<A, E, R>) =>
        Effect.gen(function* () {
          const ctx = yield* InstanceState.context
          const owner = { sessionID, directory: ctx.directory, workspaceID: yield* InstanceState.workspaceID }
          const registry = yield* InstanceState.get(state)
          return yield* registry.use(owner, id, (lease) =>
            Effect.gen(function* () {
              // 先注册租约再读权威位置：已发生的移动由此读取覆盖，稍后的移动由监听器覆盖。
              const current = yield* sessions.get(sessionID)
              if (!current || !sameLocation(owner, current.location)) {
                yield* registry.retireSession(sessionID, current?.location)
                return yield* new EnvironmentUnavailable({
                  message: "Execute environment Session or Location is no longer available.",
                })
              }
              return yield* run(lease)
            }),
          )
        }),
    })
  }),
)

// 复用已有全局事件与存储服务，避免反向依赖 Session.Service 或 ToolRegistry 形成初始化环。
export const node = LayerNode.make({ service: Service, layer, deps: [EventV2Bridge.node, SessionStore.node] })
export * as ExecuteEnvironments from "./execute-environments"
