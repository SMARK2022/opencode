import { Clock, Effect, Fiber, Queue } from "effect"
import type * as Scope from "effect/Scope"

const LIVE_INTERVAL_MS = 50
const DURABLE_INTERVAL_MS = 1_000

type Versioned<M extends Record<string, unknown>> = M & { progressVersion: number }

export type Interface<M extends Record<string, unknown>> = {
  update(metadata: M): Effect.Effect<void>
  close(): Effect.Effect<void>
}

export function make<M extends Record<string, unknown>>(input: {
  live(metadata: Versioned<M>): Effect.Effect<void>
  durable(metadata: Versioned<M>): Effect.Effect<void>
}): Effect.Effect<Interface<M>, never, Scope.Scope> {
  return Effect.gen(function* () {
    let latest: Versioned<M> | undefined
    let version = 0
    let closed = false

    // 两个 delivery state 只拥有 cadence marker；snapshot 与 progressVersion 仍由 latest 唯一持有，
    // 因此 durable I/O 可以独立等待，而不会复制 producer 状态算法或阻塞 live worker。
    const live = {
      wake: yield* Queue.sliding<void>(1),
      interval: LIVE_INTERVAL_MS,
      deliver: input.live,
      version: 0,
      last: 0,
    }
    const durable = {
      wake: yield* Queue.sliding<void>(1),
      interval: DURABLE_INTERVAL_MS,
      deliver: input.durable,
      version: 0,
      last: 0,
    }

    const start = (delivery: typeof live) =>
      Effect.forever(
        // sliding queue 只表示“有新版本”；真正发送前重读 latest，慢 worker 不会补发中间 chunk。
        // last 记录 delivery 开始时刻，使耗时 adapter 不会缩短相邻 cadence 的最小间隔。
        Queue.take(delivery.wake).pipe(
          Effect.andThen(
            Effect.gen(function* () {
              while (true) {
                const current = latest
                if (!current || current.progressVersion <= delivery.version) return
                const now = yield* Clock.currentTimeMillis
                const delay = delivery.version === 0 ? 0 : delivery.last + delivery.interval - now
                if (delay > 0) yield* Effect.sleep(delay)

                yield* Effect.gen(function* () {
                  const next = latest
                  if (!next || next.progressVersion <= delivery.version) return
                  const time = yield* Clock.currentTimeMillis
                  if (delivery.version > 0 && time - delivery.last < delivery.interval) return
                  yield* delivery.deliver(next)
                  // adapter 返回才确认 version；不可中断区防止 close 重复已提交的 durable write。
                  delivery.version = next.progressVersion
                  delivery.last = time
                }).pipe(Effect.uninterruptible)
              }
            }),
          ),
        ),
      ).pipe(Effect.forkScoped)

    const liveWorker = yield* start(live)
    const durableWorker = yield* start(durable)

    const flush = (delivery: typeof live) =>
      Effect.gen(function* () {
        // close 只补尚未确认的 latest；worker 已停止，所以 flush 后不会再出现旧 running event。
        // live 与 durable 分别确认同一 version，不能用另一 channel 的 marker 跳过必要 recovery 写入。
        const next = latest
        if (!next || next.progressVersion <= delivery.version) return
        yield* delivery.deliver(next)
        delivery.version = next.progressVersion
      }).pipe(Effect.uninterruptible)

    const close = Effect.fnUntraced(function* () {
      if (closed) return
      closed = true
      // 同时 interrupt 可避免先停 live 再等待慢 durable；两个确认区结束后才由 close flush，
      // 所以返回以后不会再有 running snapshot 越过调用方写入的 terminal Part。
      yield* Effect.forEach([liveWorker, durableWorker], Fiber.interrupt, { concurrency: "unbounded" }).pipe(
        Effect.asVoid,
      )
      yield* flush(live)
      yield* flush(durable)
      yield* Effect.forEach([live.wake, durable.wake], Queue.shutdown, { concurrency: "unbounded" }).pipe(Effect.asVoid)
    })

    // Scope interruption、正常完成、abort 与 timeout 都执行同一幂等 close；调用方
    // 可以提前 close，但 scope finalizer 仍安全地兜住异常退出。
    yield* Effect.addFinalizer(close)

    return {
      update: Effect.fnUntraced(function* (metadata) {
        if (closed) return
        version++
        latest = { ...metadata, progressVersion: version }
        yield* Queue.offer(live.wake, undefined).pipe(Effect.asVoid)
        yield* Queue.offer(durable.wake, undefined).pipe(Effect.asVoid)
      }),
      close,
    }
  })
}

export * as ToolProgress from "./progress"
