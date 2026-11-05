import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { InstanceState } from "@/effect/instance-state"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Runner } from "@/effect/runner"
import { BackgroundJob } from "@/background/job"
import { Effect, Latch, Layer, Scope, Context } from "effect"
import { Session } from "./session"
import { SessionID } from "./schema"
import { SessionActivity } from "@/session/activity"
import { SessionStatus } from "./status"
import { InstanceRef, WorkspaceRef } from "@/effect/instance-ref"

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
  // 供取消入口筛选活动子树；身份来自现有执行登记，不读取历史消息。
  readonly active: () => Effect.Effect<readonly string[]>
  readonly ensureRunning: (
    sessionID: SessionID,
    onInterrupt: Effect.Effect<SessionV1.WithParts>,
    work: Effect.Effect<SessionV1.WithParts>,
  ) => Effect.Effect<SessionV1.WithParts>
  readonly startExclusive: (
    sessionID: SessionID,
    onInterrupt: Effect.Effect<SessionV1.WithParts>,
    work: Effect.Effect<SessionV1.WithParts>,
  ) => Effect.Effect<SessionV1.WithParts, Session.BusyError>
  readonly startShell: (
    sessionID: SessionID,
    onInterrupt: Effect.Effect<SessionV1.WithParts>,
    work: Effect.Effect<SessionV1.WithParts>,
    ready?: Latch.Latch,
  ) => Effect.Effect<SessionV1.WithParts, Session.BusyError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionRunState") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const background = yield* BackgroundJob.Service
    const status = yield* SessionStatus.Service
    // 按Session而非目录共享运行、撤回和维护登记，跨工作区不能绕过同一把锁。
    const runners = new Map<SessionID, Runner.Runner<SessionV1.WithParts>>()
    const reverting = new Set<SessionID>()
    const exclusive = new Map<SessionID, symbol>()

    const state = yield* InstanceState.make(
      Effect.fn("SessionRunState.state")(function* () {
        const scope = yield* Scope.Scope
        // 目录销毁只取消自身持有的对象，不能清空跨目录权威索引或他人的维护租约。
        const owned = new Map<SessionID, Runner.Runner<SessionV1.WithParts>>()
        yield* Effect.addFinalizer(
          Effect.fnUntraced(function* () {
            // 固定本次清理集合，并以对象身份排除已由其它目录接管的Session。
            yield* Effect.forEach([...owned], ([id, runner]) => runners.get(id) === runner ? runner.cancel : Effect.void, {
              concurrency: "unbounded",
              discard: true,
            })
            for (const [id, runner] of owned) {
              if (runners.get(id) === runner) runners.delete(id)
            }
            owned.clear()
          }),
        )
        return { runners, owned, scope, reverting, exclusive }
      }),
    )

    const runner = Effect.fn("SessionRunState.runner")(function* (
      sessionID: SessionID,
      onInterrupt: Effect.Effect<SessionV1.WithParts>,
    ) {
      const data = yield* InstanceState.get(state)
      const existing = data.runners.get(sessionID)
      if (existing) return existing
      const next = Runner.make<SessionV1.WithParts>(data.scope, {
        onIdle: Effect.gen(function* () {
          // 迟到idle既不能删除replacement，也不能把新运行的状态发布为空闲。
          if (data.owned.get(sessionID) === next) data.owned.delete(sessionID)
          if (data.runners.get(sessionID) !== next) return
          data.runners.delete(sessionID)
          yield* status.set(sessionID, { type: "idle" })
        }),
        onBusy: status.set(sessionID, { type: "busy" }),
        onInterrupt,
      })
      data.runners.set(sessionID, next)
      data.owned.set(sessionID, next)
      return next
    })

    const assertNotBusy = Effect.fn("SessionRunState.assertNotBusy")(function* (sessionID: SessionID) {
      const data = yield* InstanceState.get(state)
      const existing = data.runners.get(sessionID)
      if (existing?.busy) yield* busyError(sessionID)
      // revert 进行中也视为 busy——阻止 compact/deleteMessage 等操作与 revert 并发
      if (data.reverting.has(sessionID)) yield* busyError(sessionID)
      // #482：Busy 判定扩展到独占租约——compaction 期间外部 prompt/shell 同样被拒
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
      // #482：beginRevert 双向互斥——revert 与独占维护工作不能同时持有 Session
      if (data.reverting.has(sessionID) || data.exclusive.has(sessionID)) yield* busyError(sessionID)
      data.reverting.add(sessionID)
    })

    // endRevert 幂等——即使 reverting 未被设置（理论上不会发生），delete 也不会报错
    const endRevert = Effect.fn("SessionRunState.endRevert")(function* (sessionID: SessionID) {
      const data = yield* InstanceState.get(state)
      data.reverting.delete(sessionID)
    })

    const active = Effect.fn("SessionRunState.active")(function* () {
      // 复用真实 runner 与后台作业登记，不为取消建立另一套会话状态。
      const jobs = yield* background.list()
      return [...new Set([
        ...runners.keys(),
        // 作业可直接以 Session ID 命名，也可通过 metadata 关联；归属最终由会话树查询筛选。
        ...jobs.filter(job => job.status === "running")
          .flatMap(job => [job.id, job.metadata?.sessionId, job.metadata?.parentSessionId])
          .filter((id): id is string => typeof id === "string"),
      ])]
    })

    const cancel = Effect.fn("SessionRunState.cancel")(function* (sessionID: SessionID) {
      const data = yield* InstanceState.get(state)
      const existing = data.runners.get(sessionID)
      const jobs = yield* background.list()
      if (!existing) {
        // 无 runner 时仍需取消可能残留的 background jobs
        yield* Effect.all([cancelBackgroundJobs(background, sessionID, jobs), status.set(sessionID, { type: "idle" })], {
          concurrency: "unbounded",
          discard: true,
        })
        return
      }
      // 先固定本次jobs再并行取消，不能在runner发布idle后扫描新命令的作业。
      yield* Effect.all([cancelBackgroundJobs(background, sessionID, jobs), existing.cancel], {
        concurrency: "unbounded",
        discard: true,
      })
    })

    const ensureRunning = Effect.fn("SessionRunState.ensureRunning")(function* (
      sessionID: SessionID,
      onInterrupt: Effect.Effect<SessionV1.WithParts>,
      work: Effect.Effect<SessionV1.WithParts>,
    ) {
      const instance = yield* InstanceState.context
      const workspace = yield* InstanceState.workspaceID
      // 登记实际 work 而非等待者，排队或取消等待不提前释放活动标记。
      const tracked = SessionActivity.track(`session:${sessionID}`, work)
      const current = yield* runner(sessionID, onInterrupt)
      // queued work可能由旧shell fiber启动，显式提供空WorkspaceRef也不能沿用旧值。
      return yield* current.ensureRunning(tracked.pipe(
        Effect.provideService(InstanceRef, instance),
        Effect.provideService(WorkspaceRef, workspace),
      ))
    })

    // #482：compaction/cleanup 的独占执行入口——复用 shell runner 的并发控制，
    // 但以专属 lease 注册到 exclusive 表，与 prompt/shell/revert 三方互斥。
    const startExclusive = Effect.fn("SessionRunState.startExclusive")(function* (
      sessionID: SessionID,
      onInterrupt: Effect.Effect<SessionV1.WithParts>,
      work: Effect.Effect<SessionV1.WithParts>,
    ) {
      const data = yield* InstanceState.get(state)
      // lease 用唯一 symbol 防止陈旧 finalizer 误删新请求的登记
      const lease = Symbol()
      return yield* Effect.acquireUseRelease(
        Effect.void,
        () =>
          Effect.gen(function* () {
            const tracked = Effect.acquireUseRelease(
              Effect.sync(() => SessionActivity.begin(`maintenance:${sessionID}`)),
              () => work,
              (end) => Effect.sync(end),
            )
            return yield* (yield* runner(sessionID, onInterrupt))
              .startShell(
                tracked,
                undefined,
                Effect.gen(function* () {
                  // 在 runner 持锁的临界区内 check-and-set，保证与 prompt/revert 的原子互斥
                  if (data.reverting.has(sessionID) || data.exclusive.has(sessionID)) yield* new Runner.Busy()
                  data.exclusive.set(sessionID, lease)
                }),
              )
              .pipe(Effect.catchTag("RunnerBusy", () => Effect.fail(busyError(sessionID))))
          }),
        () =>
          Effect.sync(() => {
            // release 阶段：只允许持有者自己清除，join 者的 finalizer 不能提前释放他人租约
            if (data.exclusive.get(sessionID) === lease) data.exclusive.delete(sessionID)
          }),
      )
    })

    const startShell = Effect.fn("SessionRunState.startShell")(function* (
      sessionID: SessionID,
      onInterrupt: Effect.Effect<SessionV1.WithParts>,
      work: Effect.Effect<SessionV1.WithParts>,
      ready?: Latch.Latch,
    ) {
      // Shell 与 loop 独立标记，拒绝启动的 shell 不影响已有运行。
      const tracked = SessionActivity.track(`shell:${sessionID}`, work)
      const current = yield* runner(sessionID, onInterrupt)
      return yield* current.startShell(tracked, ready)
        .pipe(Effect.catchTag("RunnerBusy", () => Effect.fail(busyError(sessionID))))
    })

    // 暴露身份快照供上层收窄查询，取消与终态处理仍沿原有 runner/作业 owner 执行。
    return Service.of({ assertNotBusy, assertNotReverting, beginRevert, endRevert, active, cancel, ensureRunning, startExclusive, startShell })
  }),
)

const cancelBackgroundJobs = Effect.fn("SessionRunState.cancelBackgroundJobs")(function* (
  background: BackgroundJob.Interface,
  sessionID: SessionID,
  jobs: ReadonlyArray<BackgroundJob.Info>,
) {
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

export const node = LayerNode.make({ service: Service, layer: layer, deps: [BackgroundJob.node, SessionStatus.node] })

export * as SessionRunState from "./run-state"
