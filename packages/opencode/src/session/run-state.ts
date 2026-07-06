import { InstanceState } from "@/effect/instance-state"
import { Runner } from "@/effect/runner"
import { BackgroundJob } from "@/background/job"
import { Effect, Latch, Layer, Scope, Context } from "effect"
import * as Session from "./session"
import { MessageV2 } from "./message-v2"
import { SessionID } from "./schema"
import { SessionStatus } from "./status"
import { SessionActivity } from "./activity"

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

    const state = yield* InstanceState.make(
      Effect.fn("SessionRunState.state")(function* (ctx) {
        const scope = yield* Scope.Scope
        const runners = new Map<SessionID, Runner.Runner<MessageV2.WithParts>>()
        // revert 进行中标记：beginRevert 原子 check-and-set，endRevert 清除。
        // assertNotBusy 和 assertNotReverting 检查此 Set 阻止 revert 期间的 prompt/shell 竞争。
        const reverting = new Set<SessionID>()
        yield* Effect.addFinalizer(
          Effect.fnUntraced(function* () {
            yield* Effect.forEach(runners.values(), (runner) => runner.cancel, {
              concurrency: "unbounded",
              discard: true,
            })
            runners.clear()
            reverting.clear()
          }),
        )
        return { runners, scope, reverting }
      }),
    )

    const runner = Effect.fn("SessionRunState.runner")(function* (
      sessionID: SessionID,
      onInterrupt: Effect.Effect<MessageV2.WithParts>,
    ) {
      const data = yield* InstanceState.get(state)
      const existing = data.runners.get(sessionID)
      if (existing) return existing
      const next = Runner.make<MessageV2.WithParts>(data.scope, {
        onIdle: Effect.gen(function* () {
          data.runners.delete(sessionID)
          yield* status.set(sessionID, { type: "idle" })
        }),
        onBusy: status.set(sessionID, { type: "busy" }),
        onInterrupt,
      })
      data.runners.set(sessionID, next)
      return next
    })

    const assertNotBusy = Effect.fn("SessionRunState.assertNotBusy")(function* (sessionID: SessionID) {
      const data = yield* InstanceState.get(state)
      const existing = data.runners.get(sessionID)
      if (existing?.busy) yield* busyError(sessionID)
      // revert 进行中也视为 busy——阻止 compact/deleteMessage 等操作与 revert 并发
      if (data.reverting.has(sessionID)) yield* busyError(sessionID)
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
      if (data.reverting.has(sessionID)) yield* busyError(sessionID)
      data.reverting.add(sessionID)
    })

    // endRevert 幂等——即使 reverting 未被设置（理论上不会发生），delete 也不会报错
    const endRevert = Effect.fn("SessionRunState.endRevert")(function* (sessionID: SessionID) {
      const data = yield* InstanceState.get(state)
      data.reverting.delete(sessionID)
    })

    const cancel = Effect.fn("SessionRunState.cancel")(function* (sessionID: SessionID) {
      yield* cancelBackgroundJobs(background, sessionID)
      const data = yield* InstanceState.get(state)
      const existing = data.runners.get(sessionID)
      if (!existing || !existing.busy) {
        yield* status.set(sessionID, { type: "idle" })
        return
      }
      yield* existing.cancel
    })

    const ensureRunning = Effect.fn("SessionRunState.ensureRunning")(function* (
      sessionID: SessionID,
      onInterrupt: Effect.Effect<MessageV2.WithParts>,
      work: Effect.Effect<MessageV2.WithParts>,
    ) {
      const tracked = Effect.acquireUseRelease(
        Effect.sync(() => SessionActivity.begin(`session:${sessionID}`)),
        () => work,
        (end) => Effect.sync(end),
      )
      return yield* (yield* runner(sessionID, onInterrupt)).ensureRunning(tracked)
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

    return Service.of({ assertNotBusy, assertNotReverting, beginRevert, endRevert, cancel, ensureRunning, startShell })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(BackgroundJob.defaultLayer),
  Layer.provide(SessionStatus.defaultLayer),
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
