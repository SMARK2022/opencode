import { describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Deferred, Duration, Effect, Fiber, Layer } from "effect"
import { ProjectV2 } from "@opencode-ai/core/project"
import { Project } from "../../src/project/project"
import { InstanceRef } from "../../src/effect/instance-ref"
import { registerDisposer } from "../../src/effect/instance-registry"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { InstanceStore } from "../../src/project/instance-store"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

let bootstrapRun: Effect.Effect<void> = Effect.void
const noopBootstrap = Layer.succeed(
  InstanceBootstrap.Service,
  InstanceBootstrap.Service.of({ run: Effect.suspend(() => bootstrapRun) }),
)

const it = testEffect(
  LayerNode.compile(LayerNode.group([InstanceStore.node, CrossSpawnSpawner.node]), [
    [InstanceStore.bootstrapNode, noopBootstrap],
  ]),
)

const setBootstrap = (run: Effect.Effect<void>) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      bootstrapRun = run
    }),
    () =>
      Effect.sync(() => {
        bootstrapRun = Effect.void
      }),
  )

const registerDisposerScoped = (disposer: (directory: string) => Promise<void>) =>
  Effect.acquireRelease(
    Effect.sync(() => registerDisposer(disposer)),
    (off) => Effect.sync(off),
  )

describe("InstanceStore", () => {
  it.live("loads instance context", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      const ctx = yield* store.load({ directory: dir })

      expect(ctx.directory).toBe(dir)
      expect(ctx.worktree).toBe(dir)
    }),
  )

  it.live("runs bootstrap with InstanceRef provided", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      let initializedDirectory: string | undefined

      yield* setBootstrap(
        Effect.gen(function* () {
          initializedDirectory = (yield* InstanceRef)?.directory
        }),
      )
      yield* store.load({ directory: dir })

      expect(initializedDirectory).toBe(dir)
    }),
  )

  it.live("caches loaded instance context by directory", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      let initialized = 0

      yield* setBootstrap(
        Effect.sync(() => {
          initialized++
        }),
      )
      const first = yield* store.load({ directory: dir })
      const second = yield* store.load({ directory: dir })

      expect(second).toBe(first)
      expect(initialized).toBe(1)
    }),
  )

  it.live("dedupes concurrent loads while init is in flight", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      let initialized = 0

      yield* setBootstrap(
        Effect.gen(function* () {
          initialized++
          yield* Deferred.succeed(started, undefined)
          yield* Deferred.await(release)
        }),
      )
      const first = yield* store.load({ directory: dir }).pipe(Effect.forkScoped)

      yield* Deferred.await(started)

      yield* setBootstrap(
        Effect.sync(() => {
          initialized++
        }),
      )
      const second = yield* store.load({ directory: dir }).pipe(Effect.forkScoped)

      expect(initialized).toBe(1)
      yield* Deferred.succeed(release, undefined)

      const [firstCtx, secondCtx] = yield* Effect.all([Fiber.join(first), Fiber.join(second)])
      expect(secondCtx).toBe(firstCtx)
      expect(initialized).toBe(1)
    }),
  )

  // #523：disposeAll 必须取消 pending bootstrap，而不是等待它自然完成。
  // 契约面：dispose 的 500ms 预算在 release 之前就应完成——取消语义优先于等待。
  it.live("cancels pending bootstrap during disposeAll", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()

      // #523：bootstrap 停在 started 之后——load 已完成登记但 producer 未完成。
      yield* setBootstrap(
        Effect.gen(function* () {
          yield* Deferred.succeed(started, undefined)
          yield* Deferred.await(release)
        }),
      )

      const loading = yield* store.load({ directory: dir }).pipe(Effect.forkScoped)
      // #523：await started 保证 cancel 时 producer 确实在运行中。
      yield* Deferred.await(started)

      // #523：若不取消 producer，disposeAll 会挂在 Deferred.await(entry.deferred) 上直到 release。
      const disposal = yield* store.disposeAll().pipe(Effect.forkScoped)
      const finished = yield* Fiber.join(disposal).pipe(
        Effect.timeoutOrElse({
          duration: Duration.millis(500),
          orElse: () => Effect.fail(new Error("dispose timeout")),
        }),
        Effect.exit,
      )

      yield* Deferred.succeed(release, undefined)
      // #523：loading 被 cancel 中断后 join 必须可完成——不能因中断遗留挂起 fiber。
      yield* Fiber.join(loading).pipe(Effect.exit)

      // release 发生前必须完成取消；最终断言不能被释放 bootstrap 的收尾动作掩盖。
      expect(finished._tag).toBe("Success")
    }),
  )

  it.live("removes failed loads from the cache", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      let attempts = 0

      yield* setBootstrap(
        Effect.sync(() => {
          attempts++
          throw new Error("init failed")
        }),
      )
      const failed = yield* store.load({ directory: dir }).pipe(
        Effect.as(false),
        Effect.catchCause(() => Effect.succeed(true)),
      )

      expect(failed).toBe(true)

      yield* setBootstrap(
        Effect.sync(() => {
          attempts++
        }),
      )
      const ctx = yield* store.load({ directory: dir })

      expect(ctx.directory).toBe(dir)
      expect(attempts).toBe(2)
    }),
  )

  it.live("reload replaces the cached context", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service

      const first = yield* store.load({ directory: dir })
      const second = yield* store.reload({ directory: dir })
      const cached = yield* store.load({ directory: dir })

      expect(second).not.toBe(first)
      expect(cached).toBe(second)
    }),
  )

  it.live("stale dispose does not delete an in-flight reload", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      const reloading = yield* Deferred.make<void>()
      const releaseReload = yield* Deferred.make<void>()
      const disposed: Array<string> = []
      yield* registerDisposerScoped(async (directory) => {
        disposed.push(directory)
      })

      const first = yield* store.load({ directory: dir })
      yield* setBootstrap(
        Effect.gen(function* () {
          yield* Deferred.succeed(reloading, undefined)
          yield* Deferred.await(releaseReload)
        }),
      )
      const reload = yield* store.reload({ directory: dir }).pipe(Effect.forkScoped)

      yield* Deferred.await(reloading)
      const staleDispose = yield* store.dispose(first).pipe(Effect.forkScoped)
      yield* Deferred.succeed(releaseReload, undefined)

      const second = yield* Fiber.join(reload)
      yield* Fiber.join(staleDispose)

      expect(disposed).toEqual([dir])
      expect(yield* store.load({ directory: dir })).toBe(second)
    }),
  )

  it.live("dedupes concurrent disposeAll calls", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      const disposing = yield* Deferred.make<void>()
      const releaseDispose = yield* Deferred.make<() => void>()
      const disposed: Array<string> = []
      yield* registerDisposerScoped((directory) => {
        disposed.push(directory)
        Deferred.doneUnsafe(disposing, Effect.void)
        return new Promise<void>((resolve) => {
          Deferred.doneUnsafe(releaseDispose, Effect.succeed(resolve))
        })
      })

      yield* store.load({ directory: dir })
      const first = yield* store.disposeAll().pipe(Effect.forkScoped)
      yield* Deferred.await(disposing)
      const release = yield* Deferred.await(releaseDispose)
      const second = yield* store.disposeAll().pipe(Effect.forkScoped)

      expect(disposed).toEqual([dir])
      yield* Effect.sync(release)
      yield* Effect.all([Fiber.join(first), Fiber.join(second)])
      expect(disposed).toEqual([dir])
    }),
  )

  it.live("re-arms disposeAll after completion", () =>
    Effect.gen(function* () {
      const dir1 = yield* tmpdirScoped({ git: true })
      const dir2 = yield* tmpdirScoped({ git: true })
      const store = yield* InstanceStore.Service
      const disposed: Array<string> = []
      yield* registerDisposerScoped(async (directory) => {
        disposed.push(directory)
      })

      yield* store.load({ directory: dir1 })
      yield* store.disposeAll()
      expect(disposed).toEqual([dir1])

      yield* store.load({ directory: dir2 })
      yield* store.disposeAll()
      expect(disposed).toEqual([dir1, dir2])
    }),
  )
})

testEffect(Layer.empty).live("cancels and re-arms pending bootstrap with isolated services", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    let boots = 0
    let stopped = false
    const layer = LayerNode.compile(InstanceStore.node, [
      [
        Project.node,
        Layer.mock(Project.Service, {
          fromDirectory: (directory) =>
            Effect.succeed({
              sandbox: directory,
              project: {
                id: ProjectV2.ID.make("global"),
                worktree: directory,
                sandboxes: [],
                time: { created: 0, updated: 0 },
              },
            }),
        }),
      ],
      [
        InstanceStore.bootstrapNode,
        Layer.succeed(InstanceBootstrap.Service, {
          // 只有首个producer被Deferred挂住；本测试不装配默认Project/DB/Git或应用启动图。
          run: Effect.gen(function* () {
            boots++
            if (boots !== 1) return
            yield* Deferred.succeed(started, undefined)
            yield* Deferred.await(release)
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                stopped = true
              }),
            ),
          ),
        }),
      ],
    ])
    yield* Effect.gen(function* () {
      const store = yield* InstanceStore.Service
      const input = { directory: process.cwd() }
      const loading = yield* store.load(input).pipe(Effect.forkScoped)
      yield* Deferred.await(started)
      // release前的500ms合同与source相同，失败也先释放fixture再断言，避免测试自身挂起。
      const finished = yield* store.disposeAll().pipe(
        Effect.timeoutOrElse({
          duration: Duration.millis(500),
          orElse: () => Effect.fail(new Error("dispose timeout")),
        }),
        Effect.exit,
      )
      const stoppedBeforeRelease = stopped
      yield* Deferred.succeed(release, undefined)
      const loadingExit = yield* Fiber.join(loading).pipe(Effect.exit)
      expect(finished._tag).toBe("Success")
      expect(stoppedBeforeRelease).toBe(true)
      expect(loadingExit._tag).toBe("Failure")
      // 被取消的旧entry不能留作可复用缓存；新entry仍保持既有load去重。
      const current = yield* store.load(input)
      expect(yield* store.load(input)).toBe(current)
      expect(boots).toBe(2)
    }).pipe(Effect.provide(layer))
  }),
)
