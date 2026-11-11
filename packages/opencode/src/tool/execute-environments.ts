import { CodeMode } from "@opencode-ai/codemode"
import { Context, Effect, Fiber, Layer, Schema, Semaphore } from "effect"
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
  // 每个租约的真实 Fiber 同时拥有取消和清理；排队者也计入活动集合。
  fibers: Set<Fiber.Fiber<unknown, unknown>>
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
    for (const fiber of entry.fibers) fiber.interruptUnsafe()
    // 活动条目暂留到最后一个租约退出，close 才能等待真实清理而非丢失引用。
    if (!entry.fibers.size) entries.delete(entry.id)
  }
  return {
    use<A, E, R>(
      owner: Owner,
      id: string | undefined,
      run: (lease: Lease) => Effect.Effect<A, E, R>,
    ): Effect.Effect<A, E | EnvironmentUnavailable, R> {
      // 登记真实租约和安装退出逻辑不可被取消拆开；用户回调保持可中断。
      const work = Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          // 先取得当前 Fiber，再同步完成准入与退出登记，避免可见条目没有租约所有者。
          const fiber = yield* Effect.fiber
          if (closing) return yield* new EnvironmentUnavailable({ message: "Execute environments are disposed." })
          // 空字符串仍是显式句柄，不能用真值判断把无效复用请求悄悄变成新环境。
          let entry = id !== undefined ? entries.get(id) : undefined
          if (id !== undefined && (!entry || entry.closed || !sameOwner(owner, entry.owner)))
            return yield* new EnvironmentUnavailable({
              message: "Execute environment is unavailable. Omit environmentID to start a new one.",
            })
          if (!entry) {
            let fresh = nextID()
            // 已存在的句柄绝不覆盖；沿用仓库生成器，仅在当前集合真实冲突时重新生成。
            while (entries.has(fresh)) fresh = nextID()
            entry = {
              id: fresh,
              owner: { ...owner },
              environment: CodeMode.createEnvironment(),
              gate: Semaphore.makeUnsafe(1),
              fibers: new Set(),
              closed: false,
            }
          }
          // 等许可之前先计入使用者，才能让淘汰和关闭逻辑看见仍在队列里的请求。
          entries.delete(entry.id)
          entries.set(entry.id, entry)
          entry.fibers.add(fiber)
          // 只在 Fiber 的子任务和 finalizer 全部结束后回收，不能把 callback 返回当成租约终态。
          fiber.addObserver(() => {
            entry.fibers.delete(fiber)
            // 完成顺序不能覆盖调用顺序；关闭项在最后一个租约退出后删除。
            if (entry.closed && !entry.fibers.size) entries.delete(entry.id)
            // 最近八个唯一调用之外只回收闲置项；忙项由自己的最后一个租约退出后再检查。
            const owned = [...entries.values()].filter(
              (candidate) => sameOwner(entry.owner, candidate.owner) && !candidate.closed,
            )
            for (const candidate of owned.slice(0, -ownerCapacity)) if (!candidate.fibers.size) retire(candidate)
          })
          // 退休直接中断租约本身；排队和同步自退休也不能绕过中断返回成功。
          return yield* restore(entry.gate.withPermits(1)(Effect.suspend(() => run(entry))))
        }),
      )
      // 独立租约 Fiber 的寿命精确到 use；不能等待调用者在 use 之后的其它工作。
      // 先 await Exit 再展开，避免中断出口的 join 观察者清理影响其它等待者。
      return Effect.scopedWith((scope) =>
        Effect.forkIn(work, scope, { startImmediately: true }).pipe(Effect.flatMap(Fiber.await), Effect.flatten),
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
          yield* Fiber.awaitAll(pending.flatMap((entry) => [...entry.fibers]))
        }),
      )
    },
  }
}

const make = Effect.gen(function* () {
  const events = yield* EventV2Bridge.Service
  const sessions = yield* SessionStore.Service
  // 目录实例负责回收；workspace 仍属于条目的 owner，不能假定缓存本身按 workspace 分隔。
  const state = yield* InstanceState.make(() =>
    Effect.gen(function* () {
      const registry = makeRegistry()
      const off = yield* events.listen(
        (event) => {
          // EventV2 发布和重放已交付解码值；按真实事件定义恢复被监听接口擦除的类型。
          const change = event as
            | typeof SessionV1.Event.Deleted.Type
            | typeof SessionEvent.Moved.Type
            | typeof SessionV1.Event.Updated.Type
          switch (change.type) {
            // 删除不依赖事件外壳的位置；移动和 legacy 更新仅退休不再匹配的位置。
            case SessionV1.Event.Deleted.type:
              return registry.retireSession(change.data.sessionID)
            case SessionEvent.Moved.type:
              return registry.retireSession(change.data.sessionID, change.data.location)
            case SessionV1.Event.Updated.type:
              return registry.retireSession(change.data.sessionID, change.data.info)
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
  return {
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
  }
})

// 服务合同直接来自实现，泛型租约与错误环境不维护第二份声明。
export type Interface = Effect.Success<typeof make>
export class Service extends Context.Service<Service, Interface>()("@opencode/ExecuteEnvironments") {}
const layer = Layer.effect(Service, make)

// 复用已有全局事件与存储服务，避免反向依赖 Session.Service 或 ToolRegistry 形成初始化环。
export const node = LayerNode.make({ service: Service, layer, deps: [EventV2Bridge.node, SessionStore.node] })
export * as ExecuteEnvironments from "./execute-environments"
