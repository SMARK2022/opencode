import { expect } from "bun:test"
import { CodeMode } from "@opencode-ai/codemode"
import { DateTime, Deferred, Effect, Exit, Fiber, Layer } from "effect"
import { ExecuteEnvironments } from "@/tool/execute-environments"
import { testEffect } from "../lib/effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { EventV2 } from "@opencode-ai/core/event"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Location } from "@opencode-ai/core/location"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { WorkspaceV2 } from "@opencode-ai/core/workspace"
import { Session } from "@/session/session"
import { InstanceRef } from "@/effect/instance-ref"
import { disposeInstance } from "@/effect/instance-registry"
import { TestInstance, provideInstanceEffect, tmpdirScoped } from "../fixture/fixture"

// 失败出口和副作用分开验证；统一断言保留 Effect 上下文，不用抛错重试替代实际调用。
const expectFailure = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.map(Effect.exit(effect), (exit) => expect(Exit.isFailure(exit)).toBe(true))

const unit = testEffect(Layer.empty)
const owner: ExecuteEnvironments.Owner = { sessionID: "ses_notebook", directory: "/project" }

unit.effect("environment handles resume full state without crossing owners or guessing missing IDs", () =>
  Effect.gen(function* () {
    const registry = ExecuteEnvironments.makeRegistry()
    // 同一执行引擎跨调用保留函数和变量；新建与复用只选择状态，不切换运行模式。
    const first = yield* registry.use(owner, undefined, (lease) =>
      CodeMode.execute({
        environment: lease.environment,
        code: "let n = 1; const next = () => ++n; return next()",
      }).pipe(Effect.map((result) => ({ id: lease.id, result }))),
    )
    // 前缀和长度来自宿主 Identifier 合同，复用成功还须交付可供模型下一轮传回的有效句柄。
    expect(first.id).toMatch(/^env_[0-9a-zA-Z]{26}$/)
    expect(first.result).toMatchObject({ ok: true, value: 2 })
    expect(
      yield* registry.use(owner, first.id, (lease) =>
        CodeMode.execute({ environment: lease.environment, code: "return next()" }),
      ),
    ).toMatchObject({ ok: true, value: 3 })
    // 显式错误句柄和其它会话/位置均不得获得替代环境，更不能执行传入回调。
    let effects = 0
    for (const [other, id] of [
      [owner, ""],
      [owner, "env_missing"],
      [{ ...owner, sessionID: "ses_other" }, first.id],
      [{ ...owner, directory: "/else" }, first.id],
      [{ ...owner, workspaceID: "wrk_other" }, first.id],
    ] as const) {
      yield* expectFailure(registry.use(other, id, () => Effect.sync(() => effects++)))
    }
    // 报错还不够：无效句柄的 callback 从未运行，才证明没有失败后备用执行。
    expect(effects).toBe(0)
    // 省略 ID 与显式错误 ID 分开检查，既允许新建，也不把复用失败偷偷降级为新建。
    const fresh = yield* registry.use(owner, undefined, (lease) => Effect.succeed(lease.id))
    expect(fresh).not.toBe(first.id)
    yield* registry.close()
  }),
)

unit.effect("same environment waits through cleanup while other environments stay concurrent", () =>
  Effect.gen(function* () {
    const registry = ExecuteEnvironments.makeRegistry()
    const id = yield* registry.use(owner, undefined, (lease) => Effect.succeed(lease.id))
    const entered = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const cleanup = yield* Deferred.make<void>()
    const finish = yield* Deferred.make<void>()
    const order: string[] = []
    // 先观察 holder 已进入，再观察清理阻塞；测试不以 sleep 猜测锁或取消是否生效。
    yield* Effect.gen(function* () {
      const first = yield* registry
        .use(owner, id, () =>
          Effect.gen(function* () {
            order.push("first")
            yield* Deferred.succeed(entered, undefined)
            yield* Deferred.await(release)
          }).pipe(Effect.ensuring(Deferred.succeed(cleanup, undefined).pipe(Effect.andThen(Deferred.await(finish))))),
        )
        .pipe(Effect.forkScoped({ startImmediately: true }))
      yield* Deferred.await(entered)
      const second = yield* registry
        .use(owner, id, () =>
          Effect.sync(() => {
            order.push("second")
          }),
        )
        .pipe(Effect.forkScoped({ startImmediately: true }))
      // 同时执行另一环境可排除全局串行锁，前一个环境的排他性必须只绑定自身ID。
      expect(yield* registry.use(owner, undefined, () => Effect.succeed("independent"))).toBe("independent")
      expect(order).toEqual(["first"])
      yield* Deferred.succeed(release, undefined)
      yield* Deferred.await(cleanup)
      // 用户主值已结束但 finalizer 仍被阻塞，这段窗口也必须排他。
      expect(order).toEqual(["first"])
      yield* Deferred.succeed(finish, undefined)
      yield* Fiber.join(first)
      // 两个 Fiber 都结束后再看顺序，排除第二个调用只是暂时没被调度、从未成功取得租约。
      yield* Fiber.join(second)
      expect(order).toEqual(["first", "second"])
    }).pipe(
      Effect.ensuring(
        Effect.all([Deferred.succeed(release, undefined), Deferred.succeed(finish, undefined)], { discard: true }),
      ),
    )
    yield* registry.close()
  }),
)

unit.effect("self-published retirement cannot return success or deadlock the publishing cell", () =>
  Effect.gen(function* () {
    const registry = ExecuteEnvironments.makeRegistry()
    const id = yield* registry.use(owner, undefined, (lease) => Effect.succeed(lease.id))
    // 通知回调只标记退出；若在其中 join 当前单元会自锁，若不复查关闭状态又会伪成功。
    const result = yield* registry
      .use(owner, id, () => registry.retireSession(owner.sessionID).pipe(Effect.as("wrong success")))
      .pipe(Effect.exit)
    expect(Exit.isFailure(result)).toBe(true)
    // 自退休调用失败后，同一 ID 还须继续拒绝，不能只中断当前执行却保留可复活的条目。
    yield* expectFailure(registry.use(owner, id, () => Effect.succeed("wrong replacement")))
    yield* registry.close()
  }),
)

unit.effect("pressure eviction follows the latest return to idle, without an owner quota", () =>
  Effect.gen(function* () {
    const registry = ExecuteEnvironments.makeRegistry()
    const create = () => registry.use(owner, undefined, (lease) => Effect.succeed(lease.id))
    const ids: string[] = []
    // 一个 owner 可以使用全部目录容量；旧第九项策略不再隐式销毁它的第一个环境。
    for (let i = 0; i < 64; i++) ids.push(yield* create())
    expect(yield* registry.use(owner, ids[0], () => Effect.succeed("touched"))).toBe("touched")
    const newest = yield* create()
    // 使用第一个后移到闲置队尾；新增只淘汰未被触碰的第二个，不按创建时间排序。
    yield* expectFailure(registry.use(owner, ids[1], () => Effect.succeed("wrong")))
    expect(yield* registry.use(owner, ids[0], () => Effect.succeed("retained"))).toBe("retained")
    // 淘汰旧项后新项必须可用；只断言旧 ID 失败会放过“容量满后全部拒绝”的实现。
    expect(yield* registry.use(owner, newest, () => Effect.succeed("newest"))).toBe("newest")
    yield* registry.close()
  }),
)

unit.effect("capacity cannot evict active leases or execute the rejected callback", () =>
  Effect.gen(function* () {
    const registry = ExecuteEnvironments.makeRegistry()
    const ready = yield* Deferred.make<void>()
    let entered = 0
    // 六十四个活动租约占满目录；新建不能靠淘汰运行中的环境而成功。
    for (let i = 0; i < 64; i++)
      yield* registry
        .use(owner, undefined, () =>
          Effect.gen(function* () {
            entered++
            if (entered === 64) yield* Deferred.succeed(ready, undefined)
            return yield* Effect.never
          }),
        )
        .pipe(Effect.forkScoped({ startImmediately: true }))
    // 等全部六十四个 callback 已进入后才申请第六十五项，保证测试确实面对活动容量满额。
    yield* Deferred.await(ready)
    let extra = false
    yield* expectFailure(
      registry.use(owner, undefined, () =>
        Effect.sync(() => {
          extra = true
        }),
      ),
    )
    // 容量错误若发生在callback之后仍会破坏状态，独立标志确保拒绝发生在准入前。
    expect(extra).toBe(false)
    yield* registry.close()
  }),
)

const integration = testEffect(
  // 第二个目录与原目录共用真实 owner，但临时目录构造器的依赖也属于本测试层。
  LayerNode.compile(
    LayerNode.group([
      ExecuteEnvironments.node,
      Session.node,
      SessionProjector.node,
      EventV2.node,
      CrossSpawnSpawner.node,
    ]),
  ),
)

integration.instance("real deletion without Location cancels leases and rejects late fresh admission", () =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const environments = yield* ExecuteEnvironments.Service
    const events = yield* EventV2.Service
    const session = yield* sessions.create()
    const id = yield* environments.use(session.id, undefined, (lease) => Effect.succeed(lease.id))
    const entered = yield* Deferred.make<void>()
    let cleaned = false
    let queuedEffect = false
    // 使用真实 projector 删除持久 Session；无 Location 外壳也必须回收其活动和排队租约。
    const holder = yield* environments
      .use(session.id, id, () =>
        Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(
            Effect.sync(() => {
              cleaned = true
            }),
          ),
        ),
      )
      .pipe(Effect.forkScoped({ startImmediately: true }))
    yield* Deferred.await(entered)
    const queued = yield* environments
      .use(session.id, id, () =>
        Effect.sync(() => {
          queuedEffect = true
        }),
      )
      .pipe(Effect.forkScoped({ startImmediately: true }))
    // 去掉发布者的 InstanceRef，强制删除通知不依赖位置外壳，而从事件中的会话身份回收。
    const deletion = yield* events
      .publish(SessionV1.Event.Deleted, { sessionID: session.id, info: session })
      .pipe(Effect.provideService(InstanceRef, undefined))
    expect(deletion.location).toBeUndefined()
    expect(Exit.isFailure(yield* Fiber.await(holder))).toBe(true)
    // 排队者也必须结束为失败，不能等 holder 清理后拿到旧许可再执行。
    expect(Exit.isFailure(yield* Fiber.await(queued))).toBe(true)
    expect(cleaned).toBe(true)
    // 删除通知不能只让 holder 报错，排队 callback 也必须没有产生效果。
    expect(queuedEffect).toBe(false)
    // 事件已过去后才省略 ID 新建，也必须由权威 placement 读取阻止，不能依赖已错过的通知。
    yield* expectFailure(
      environments.use(session.id, undefined, () =>
        Effect.sync(() => {
          queuedEffect = true
        }),
      ),
    )
    expect(queuedEffect).toBe(false)
  }),
)

integration.instance("real move retires source state and preserves destination state", () =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const environments = yield* ExecuteEnvironments.Service
    const events = yield* EventV2.Service
    const session = yield* sessions.create()
    const source = yield* environments.use(session.id, undefined, (lease) => Effect.succeed(lease.id))
    const destination = yield* tmpdirScoped()
    const moved = {
      sessionID: session.id,
      location: Location.Ref.make({ directory: AbsolutePath.make(destination) }),
      timestamp: yield* DateTime.now,
    }
    // 真实 Moved projector 先改权威位置；旧宿主之后不能再创建一个仍绑在源目录的环境。
    yield* events.publish(SessionEvent.Moved, moved)
    yield* expectFailure(environments.use(session.id, source, () => Effect.succeed("wrong")))
    yield* expectFailure(environments.use(session.id, undefined, () => Effect.succeed("wrong")))
    // 进入目的目录的真实 InstanceState 后才新建，源目录拒绝不能被“全局禁用此 Session”冒充。
    const target = yield* environments
      .use(session.id, undefined, (lease) => Effect.succeed(lease.id))
      .pipe(provideInstanceEffect(destination))
    // 重复位置通知不能把目的地已存在的合法环境一并删掉，事件 owner 以目的位置比较。
    yield* events.publish(SessionEvent.Moved, moved)
    // 目标目录使用同一个 Service，但按新的 InstanceState 键承载状态，不共享源环境。
    expect(
      yield* environments
        .use(session.id, target, () => Effect.succeed("retained"))
        .pipe(provideInstanceEffect(destination)),
    ).toBe("retained")
  }),
)

integration.instance("legacy workspace updates retire state but title updates preserve it", () =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const environments = yield* ExecuteEnvironments.Service
    const session = yield* sessions.create()
    const id = yield* environments.use(session.id, undefined, (lease) => Effect.succeed(lease.id))
    // 元数据更新不是退出；只改变 workspace 的真实 Updated 事件才使当前 owner 失效。
    yield* sessions.setTitle({ sessionID: session.id, title: "Renamed" })
    expect(yield* environments.use(session.id, id, () => Effect.succeed("retained"))).toBe("retained")
    // 目录路径不变，只变 workspace 身份，使旧环境失效原因只能来自 owner 的 workspace 比较。
    yield* sessions.setWorkspace({ sessionID: session.id, workspaceID: WorkspaceV2.ID.make("wrk_other") })
    yield* expectFailure(environments.use(session.id, id, () => Effect.succeed("wrong")))
  }),
)

unit.effect("directory capacity and live ID collisions never replace a live identity", () =>
  Effect.gen(function* () {
    // 两次连续分配同名ID后再给新ID，只测真实碰撞重试，不依赖随机生成器碰巧重复。
    const issued = ["env_first", "env_first", "env_second"]
    const colliding = ExecuteEnvironments.makeRegistry({ nextID: () => issued.shift() ?? "env_unexpected" })
    const one = yield* colliding.use(owner, undefined, (lease) => Effect.succeed(lease.id))
    const two = yield* colliding.use(owner, undefined, (lease) => Effect.succeed(lease.id))
    // 同时存在的冲突只重新分配新 ID，不把第二个新建单元绑定到第一个环境。
    expect([one, two]).toEqual(["env_first", "env_second"])
    // 重新分配第二个 ID 后再访问第一个，确认碰撞重试没有替换仍存活的原条目。
    expect(yield* colliding.use(owner, one, () => Effect.succeed("original"))).toBe("original")
    yield* colliding.close()
    const registry = ExecuteEnvironments.makeRegistry()
    const ids: string[] = []
    for (let i = 0; i < 65; i++)
      ids.push(yield* registry.use({ ...owner, sessionID: `ses_${i}` }, undefined, (lease) => Effect.succeed(lease.id)))
    // 目录容量跨 owner 共用；第六十五项淘汰最早回到闲置的环境。
    yield* expectFailure(registry.use({ ...owner, sessionID: "ses_0" }, ids[0], () => Effect.succeed("wrong")))
    expect(yield* registry.use({ ...owner, sessionID: "ses_64" }, ids[64], () => Effect.succeed("newest"))).toBe(
      "newest",
    )
    yield* registry.close()
  }),
)

integration.instance("actual instance disposal waits for cleanup before replacing the registry", () =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const environments = yield* ExecuteEnvironments.Service
    const instance = yield* TestInstance
    const session = yield* sessions.create()
    const id = yield* environments.use(session.id, undefined, (lease) => Effect.succeed(lease.id))
    const entered = yield* Deferred.make<void>()
    const cleanup = yield* Deferred.make<void>()
    const finish = yield* Deferred.make<void>()
    let disposed = false
    yield* Effect.gen(function* () {
      const holder = yield* environments
        .use(session.id, id, () =>
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.ensuring(Deferred.succeed(cleanup, undefined).pipe(Effect.andThen(Deferred.await(finish)))),
          ),
        )
        .pipe(Effect.forkScoped({ startImmediately: true }))
      yield* Deferred.await(entered)
      const disposer = yield* Effect.promise(() => disposeInstance(instance.directory)).pipe(
        Effect.andThen(
          Effect.sync(() => {
            disposed = true
          }),
        ),
        Effect.forkScoped({ startImmediately: true }),
      )
      // 先等 holder 的清理器真正开始，再检查 dispose 尚未完成，把等待范围定位到 finalizer。
      yield* Deferred.await(cleanup)
      // 全局 disposer 会收集错误；观察清理 barrier，不能仅因 dispose 返回就假定原工作已结束。
      expect(disposed).toBe(false)
      yield* Deferred.succeed(finish, undefined)
      // 清理完成只说明资源释放，holder失败还要证明实例关闭没有被转换成业务成功。
      expect(Exit.isFailure(yield* Fiber.await(holder))).toBe(true)
      yield* Fiber.join(disposer)
      expect(disposed).toBe(true)
      // 同一个 Service 下一次经 InstanceState 获得新 owner，旧句柄不得复活。
      yield* expectFailure(environments.use(session.id, id, () => Effect.succeed("wrong")))
      expect(yield* environments.use(session.id, undefined, (lease) => Effect.succeed(lease.id))).not.toBe(id)
    }).pipe(Effect.ensuring(Deferred.succeed(finish, undefined)))
  }),
)

integration.instance("forked Sessions cannot resume the parent's environment", () =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const environments = yield* ExecuteEnvironments.Service
    const parent = yield* sessions.create()
    const id = yield* environments.use(parent.id, undefined, (lease) => Effect.succeed(lease.id))
    const child = yield* sessions.fork({ sessionID: parent.id })
    // fork 复制会话历史而不复制进程内词法图；父句柄不能成为子会话的隐含能力。
    expect(Exit.isFailure(yield* environments.use(child.id, id, () => Effect.succeed("wrong")).pipe(Effect.exit))).toBe(
      true,
    )
    // 子 Session 的拒绝不能连带退休父环境，原 owner 仍须继续使用同一 ID。
    expect(yield* environments.use(parent.id, id, () => Effect.succeed("parent retained"))).toBe("parent retained")
  }),
)

unit.effect("queued leases stay protected and the last canceled lease refreshes idle order", () =>
  Effect.gen(function* () {
    const registry = ExecuteEnvironments.makeRegistry()
    const create = () => registry.use(owner, undefined, (lease) => Effect.succeed(lease.id))
    const ids: string[] = []
    for (let i = 0; i < 64; i++) ids.push(yield* create())
    const entered = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const waiterEntered = yield* Deferred.make<void>()
    const holder = yield* registry
      .use(owner, ids[0], () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))))
      .pipe(Effect.forkScoped({ startImmediately: true }))
    yield* Deferred.await(entered)
    const waiter = yield* registry
      .use(owner, ids[0], () => Deferred.succeed(waiterEntered, undefined).pipe(Effect.andThen(Effect.never)))
      .pipe(Effect.forkScoped({ startImmediately: true }))
    // 最老环境同时持有运行与排队租约；压力淘汰必须跳过它，不能靠回收活动状态腾位。
    yield* create()
    yield* expectFailure(registry.use(owner, ids[1], () => Effect.succeed("wrong")))
    yield* Deferred.succeed(release, undefined)
    yield* Fiber.join(holder)
    // 确认排队者已经成为实际使用者，再取消它；否则只能验证取消等待队列，不能覆盖最后租约退出。
    yield* Deferred.await(waiterEntered)
    // 曾排队的租约成为最后一个使用者后取消；其退出让环境重新闲置并移动到队尾。
    yield* Fiber.interrupt(waiter)
    yield* create()
    // 第二次压力应继续淘汰旧闲置项；刚取消的最后租约要排到队尾，而不是回到原创建位置。
    yield* expectFailure(registry.use(owner, ids[2], () => Effect.succeed("wrong")))
    expect(yield* registry.use(owner, ids[0], () => Effect.succeed("retained"))).toBe("retained")
    yield* registry.close()
  }),
)
