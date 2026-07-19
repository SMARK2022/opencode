import { InstanceState } from "@/effect/instance-state"
import { Runner } from "@/effect/runner"
import { BackgroundJob } from "@/background/job"
import { Effect, Latch, Layer, Scope, Context } from "effect"
import * as Session from "./session"
import { MessageV2 } from "./message-v2"
import { SessionID } from "./schema"
import { SessionStatus } from "./status"
import { SessionActivity } from "./activity"
import { LSP } from "@/lsp/lsp"
import { InstanceRef, WorkspaceRef } from "@/effect/instance-ref"
import { attachWith } from "@/effect/run-service"

export interface Interface {
  readonly assertNotBusy: (sessionID: SessionID) => Effect.Effect<void, Session.BusyError>
  // 只检查 revert 进行中，不检查 runner.busy——用于 prompt/shell handler 层守卫，
  // 避免阻止 prompt 执行中发新消息的排队语义（ensureRunning join 行为）。
  readonly assertNotReverting: (sessionID: SessionID) => Effect.Effect<void, Session.BusyError>
  // 原子 check-and-set：标记 revert 进行中。失败（已 reverting）返回 BusyError。
  // 必须与 endRevert 配对使用（通过 Effect.acquireUseRelease 保证）。
  readonly beginRevert: (sessionID: SessionID) => Effect.Effect<void, Session.BusyError>
  readonly endRevert: (sessionID: SessionID) => Effect.Effect<void>
  readonly cancel: (sessionID: SessionID) => Effect.Effect<void>
  readonly ensureRunning: (
    sessionID: SessionID,
    onInterrupt: Effect.Effect<MessageV2.WithParts>,
    work: Effect.Effect<MessageV2.WithParts>,
  ) => Effect.Effect<MessageV2.WithParts>
  readonly startExclusive: (
    sessionID: SessionID,
    onInterrupt: Effect.Effect<MessageV2.WithParts>,
    work: Effect.Effect<MessageV2.WithParts>,
  ) => Effect.Effect<MessageV2.WithParts, Session.BusyError>
  readonly startShell: (
    sessionID: SessionID,
    onInterrupt: Effect.Effect<MessageV2.WithParts>,
    work: Effect.Effect<MessageV2.WithParts>,
    ready?: Latch.Latch,
  ) => Effect.Effect<MessageV2.WithParts, Session.BusyError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionRunState") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const background = yield* BackgroundJob.Service
    const status = yield* SessionStatus.Service
    const sessions = yield* Session.Service
    const lsp = yield* LSP.Service
    // Runner 身份必须跨 Project 唯一，否则 Workspace 将 Session 从 D 路由到 T 后，
    // T 会把 D 的活跃 run 误判为空闲；InstanceState 只继续拥有资源释放责任。
    const runners = new Map<SessionID, Runner.Runner<MessageV2.WithParts>>()

    const state = yield* InstanceState.make(
      Effect.fn("SessionRunState.state")(function* (ctx) {
        const scope = yield* Scope.Scope
        const owned = new Map<SessionID, Runner.Runner<MessageV2.WithParts>>()
        // revert 进行中标记：beginRevert 原子 check-and-set，endRevert 清除。
        // assertNotBusy 和 assertNotReverting 检查此 Set 阻止 revert 期间的 prompt/shell 竞争。
        const reverting = new Set<SessionID>()
        // lease区分并发maintenance owner，失败调用的finalizer不能误删另一个调用的所有权。
        const exclusive = new Map<SessionID, symbol>()
        yield* Effect.addFinalizer(
          Effect.fnUntraced(function* () {
            // D 销毁时只能取消仍由 D 创建的同一对象；旧 finalizer 不能误删
            // 已在 T 重建的同 Session Runner。
            const active = [...owned].filter(([sessionID, runner]) => runners.get(sessionID) === runner)
            yield* Effect.forEach(active, ([, runner]) => runner.cancel, {
              concurrency: "unbounded",
              discard: true,
            })
            owned.clear()
            reverting.clear()
            exclusive.clear()
          }),
        )
        return { owned, scope, reverting, exclusive }
      }),
    )

    const runner = Effect.fn("SessionRunState.runner")(function* (
      sessionID: SessionID,
      onInterrupt: Effect.Effect<MessageV2.WithParts>,
    ) {
      const data = yield* InstanceState.get(state)
      const existing = runners.get(sessionID)
      if (existing) return existing
      const next = Runner.make<MessageV2.WithParts>(data.scope, {
        onIdle: Effect.gen(function* () {
          if (runners.get(sessionID) === next) runners.delete(sessionID)
          data.owned.delete(sessionID)
          yield* status.set(sessionID, { type: "idle" })
        }),
        onBusy: status.set(sessionID, { type: "busy" }),
        onInterrupt,
      })
      runners.set(sessionID, next)
      data.owned.set(sessionID, next)
      return next
    })

    const assertNotBusy = Effect.fn("SessionRunState.assertNotBusy")(function* (sessionID: SessionID) {
      const data = yield* InstanceState.get(state)
      const existing = runners.get(sessionID)
      if (existing?.busy) yield* busyError(sessionID)
      // revert 进行中也视为 busy——阻止 compact/deleteMessage 等操作与 revert 并发
      if (data.reverting.has(sessionID)) yield* busyError(sessionID)
      // exclusive 在Runner正式进入Shell前也生效，覆盖maintenance acquisition的短暂过渡窗。
      if (data.exclusive.has(sessionID)) yield* busyError(sessionID)
    })

    // 只检查 revert 进行中，不检查 runner.busy——保留 prompt 执行中发新消息的排队语义
    const assertNotReverting = Effect.fn("SessionRunState.assertNotReverting")(function* (sessionID: SessionID) {
      const data = yield* InstanceState.get(state)
      if (data.reverting.has(sessionID)) yield* busyError(sessionID)
    })

    // 原子 check-and-set：yield* InstanceState.get 后，has 和 add 之间无 yield*，
    // Effect 协作式调度不会在同步代码块中切让 fiber，保证只一个 revert 能进入。
    const beginRevert = Effect.fn("SessionRunState.beginRevert")(function* (sessionID: SessionID) {
      const data = yield* InstanceState.get(state)
      // explicit revert 与 exclusive maintenance 必须双向互斥，不能只依赖调用前的非原子检查。
      if (data.reverting.has(sessionID) || data.exclusive.has(sessionID)) yield* busyError(sessionID)
      data.reverting.add(sessionID)
    })

    // endRevert 幂等——即使 reverting 未被设置（理论上不会发生），delete 也不会报错
    const endRevert = Effect.fn("SessionRunState.endRevert")(function* (sessionID: SessionID) {
      const data = yield* InstanceState.get(state)
      data.reverting.delete(sessionID)
    })

    const cancel = Effect.fn("SessionRunState.cancel")(function* (sessionID: SessionID) {
      const existing = runners.get(sessionID)
      if (!existing || !existing.busy) {
        // 无 runner 时仍需取消可能残留的 background jobs
        yield* Effect.all([cancelBackgroundJobs(background, sessionID), status.set(sessionID, { type: "idle" })], {
          concurrency: "unbounded",
          discard: true,
        })
        return
      }
      // 并行取消 background jobs 和 runner fiber，避免串行等待。
      // 两者操作独立的 resource（BackgroundJob 服务 vs runner fiber），都幂等。
      yield* Effect.all([cancelBackgroundJobs(background, sessionID), existing.cancel], {
        concurrency: "unbounded",
        discard: true,
      })
    })

    const ensureRunning = Effect.fn("SessionRunState.ensureRunning")(function* (
      sessionID: SessionID,
      onInterrupt: Effect.Effect<MessageV2.WithParts>,
      work: Effect.Effect<MessageV2.WithParts>,
    ) {
      const refs = { instance: yield* InstanceRef, workspace: yield* WorkspaceRef }
      const tracked = Effect.acquireUseRelease(
        Effect.sync(() => SessionActivity.begin(`session:${sessionID}`)),
        () =>
          Effect.gen(function* () {
            // admission 位于 Runner 真正执行的 work 内；Running caller 只等待 done，
            // 不会退休当前 run 仍使用的 LSP claim。
            yield* lsp.init()
            return yield* work
          }).pipe(LSP.withSession(sessionID, sessions.get(sessionID).pipe(Effect.asVoid, Effect.orDie))),
        (end) => Effect.sync(end),
      )
      // ShellThenRun 由旧 D shell fiber 启动；显式绑定提交方 T 的 references，
      // 防止延迟执行时把 Prompt 和 Read/LSP 工作重新路由回 D。
      return yield* (yield* runner(sessionID, onInterrupt)).ensureRunning(attachWith(tracked, refs))
    })

    const startExclusive = Effect.fn("SessionRunState.startExclusive")(function* (
      sessionID: SessionID,
      onInterrupt: Effect.Effect<MessageV2.WithParts>,
      work: Effect.Effect<MessageV2.WithParts>,
    ) {
      const data = yield* InstanceState.get(state)
      // 每次调用使用唯一token，release据此判断自己是否真正取得了maintenance所有权。
      const lease = Symbol()
      return yield* Effect.acquireUseRelease(
        // finalizer先安装再尝试Runner reservation，覆盖reservation后的任意failure或defect。
        Effect.void,
        () =>
          Effect.gen(function* () {
            // maintenance 使用独立 key，避免与紧邻启动的 session run 在 Set 中互相提前释放。
            const tracked = Effect.acquireUseRelease(
              Effect.sync(() => SessionActivity.begin(`maintenance:${sessionID}`)),
              () => work,
              (end) => Effect.sync(end),
            )
            // startShell的ref锁是prompt与maintenance竞争Idle的唯一线性化点。
            return yield* (yield* runner(sessionID, onInterrupt))
              .startShell(
                tracked,
                undefined,
                Effect.gen(function* () {
                  // acquisition在Runner的Idle锁内完成；之后到达的prompt只能进入ShellThenRun。
                  if (data.reverting.has(sessionID) || data.exclusive.has(sessionID)) yield* new Runner.Busy()
                  data.exclusive.set(sessionID, lease)
                }),
              )
              .pipe(Effect.catchTag("RunnerBusy", () => Effect.fail(busyError(sessionID))))
          }),
        // startShell 的 Busy、work defect 与 cancel 都必须释放内存标记，保证后续操作可重试。
        // release晚于shell finalizer，确保handoff前不会让explicit revert插入维护边界。
        () =>
          Effect.sync(() => {
            // 未取得reservation的Busy调用不能删除当前owner留下的lease。
            if (data.exclusive.get(sessionID) === lease) data.exclusive.delete(sessionID)
          }),
      )
    })

    const startShell = Effect.fn("SessionRunState.startShell")(function* (
      sessionID: SessionID,
      onInterrupt: Effect.Effect<MessageV2.WithParts>,
      work: Effect.Effect<MessageV2.WithParts>,
      ready?: Latch.Latch,
    ) {
      // [local-smark] SessionActivity tracking for daemon multi-instance
      const tracked = Effect.acquireUseRelease(
        Effect.sync(() => SessionActivity.begin(`shell:${sessionID}`)),
        () => work,
        (end) => Effect.sync(end),
      )
      return yield* (yield* runner(sessionID, onInterrupt))
        .startShell(tracked, ready)
        .pipe(Effect.catchTag("RunnerBusy", () => Effect.fail(busyError(sessionID))))
    })

    return Service.of({
      assertNotBusy,
      assertNotReverting,
      beginRevert,
      endRevert,
      cancel,
      ensureRunning,
      startExclusive,
      startShell,
    })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(BackgroundJob.defaultLayer),
  Layer.provide(SessionStatus.defaultLayer),
  Layer.provide(Session.defaultLayer),
  Layer.provide(LSP.defaultLayer),
)

const cancelBackgroundJobs = Effect.fn("SessionRunState.cancelBackgroundJobs")(function* (
  background: BackgroundJob.Interface,
  sessionID: SessionID,
) {
  const jobs = yield* background.list()
  const pending = new Set<string>([sessionID])
  const cancelled = new Set<string>()
  const matches = (job: BackgroundJob.Info) => {
    if (job.status !== "running") return false
    if (cancelled.has(job.id)) return false
    if (pending.has(job.id)) return true
    if (typeof job.metadata?.sessionId === "string" && pending.has(job.metadata.sessionId)) return true
    return typeof job.metadata?.parentSessionId === "string" && pending.has(job.metadata.parentSessionId)
  }
  let batch = jobs.filter(matches)
  while (batch.length > 0) {
    yield* Effect.forEach(
      batch,
      (job) =>
        background.cancel(job.id).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              cancelled.add(job.id)
              pending.add(job.id)
              if (typeof job.metadata?.sessionId === "string") pending.add(job.metadata.sessionId)
            }),
          ),
        ),
      { concurrency: "unbounded", discard: true },
    )
    batch = jobs.filter(matches)
  }
})

function busyError(sessionID: SessionID) {
  return new Session.BusyError({ sessionID })
}

export * as SessionRunState from "./run-state"
