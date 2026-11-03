import { expect } from "bun:test"
import { Cause, Context, Deferred, Effect, Exit, Fiber, Layer, LayerMap, Scope } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Location } from "@opencode-ai/core/location"
import { LocationServiceMap } from "@opencode-ai/core/location-service-map"
import type { LocationServices } from "@opencode-ai/core/location-services"
import { SessionActivity } from "@opencode-ai/core/session/activity"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionExecutionLocal } from "@opencode-ai/core/session/execution/local"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionStore } from "@opencode-ai/core/session/store"
import { testEffect } from "./lib/effect"

const it = testEffect(Layer.empty)

// #235：只构建真实 Native 执行服务，在 Session 读取处阻塞，不启动模型、HTTP 或 daemon。
it.effect("tracks Native drains across isolated runtimes and releases activity", () =>
  Effect.gen(function* () {
    const baseline = SessionActivity.count()
    const counts: number[] = []
    yield* Effect.acquireRelease(
      Effect.sync(() => SessionActivity.onChange((count) => counts.push(count))),
      (off) => Effect.sync(off),
    )
    const firstStarted = yield* Deferred.make<void>()
    const secondStarted = yield* Deferred.make<void>()
    const scopeStarted = yield* Deferred.make<void>()
    const gate = yield* Deferred.make<void>()
    let lookups = 0
    const layer = LayerNode.compile(SessionExecutionLocal.node, [
      [
        SessionStore.node,
        Layer.mock(SessionStore.Service, {
          get: () =>
            Effect.gen(function* () {
              const lookup = lookups++
              if (lookup === 2) {
                yield* Deferred.succeed(scopeStarted, undefined)
                return yield* Effect.never
              }
              yield* Deferred.succeed(lookup === 0 ? firstStarted : secondStarted, undefined)
              yield* Deferred.await(gate)
              return yield* Effect.die("lookup failed")
            }),
        }),
      ],
      [
        LocationServiceMap.node,
        Layer.effect(
          LocationServiceMap.Service,
          LayerMap.make((_ref: Location.Ref) =>
            Layer.unwrap<LocationServices, never, never, never, never>(Effect.die("unexpected Location lookup")),
          ),
        ),
      ],
    ])
    const scope = yield* Effect.acquireRelease(Scope.make(), (scope) => Scope.close(scope, Exit.void))
    // #235：复用层定义但隔离 MemoMap，贴近内部/外部监听分别装配服务的边界。
    const first = Context.get(
      yield* Layer.buildWithMemoMap(layer, Layer.makeMemoMapUnsafe(), scope),
      SessionExecution.Service,
    )
    const second = Context.get(
      yield* Layer.buildWithMemoMap(layer, Layer.makeMemoMapUnsafe(), scope),
      SessionExecution.Service,
    )
    const sessionID = SessionSchema.ID.make("ses_native_activity")

    const resumed = yield* first.resume(sessionID).pipe(Effect.forkChild)
    yield* Deferred.await(firstStarted)
    expect(SessionActivity.count()).toBe(baseline + 1)
    const other = yield* second.resume(sessionID).pipe(Effect.forkChild)
    yield* Deferred.await(secondStarted)
    expect(SessionActivity.count()).toBe(baseline + 2)

    yield* first.interrupt(sessionID)
    const interrupted = yield* Fiber.await(resumed)
    expect(Exit.isFailure(interrupted) && Cause.hasInterruptsOnly(interrupted.cause)).toBe(true)
    expect(SessionActivity.count()).toBe(baseline + 1)
    yield* Deferred.succeed(gate, undefined)
    const failed = yield* Fiber.await(other)
    expect(Exit.isFailure(failed) && Cause.hasDies(failed.cause)).toBe(true)
    expect(SessionActivity.count()).toBe(baseline)

    yield* first.wake(sessionID)
    yield* Deferred.await(scopeStarted)
    expect(SessionActivity.count()).toBe(baseline + 1)
    yield* Scope.close(scope, Exit.void)
    expect(SessionActivity.count()).toBe(baseline)
    expect(counts).toEqual([baseline + 1, baseline + 2, baseline + 1, baseline, baseline + 1, baseline])
  }),
)
