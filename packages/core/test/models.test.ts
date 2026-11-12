import { describe, expect, beforeEach, afterAll, spyOn } from "bun:test"
import { Context, Deferred, Effect, Fiber, Layer, Ref } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Global } from "@opencode-ai/core/global"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { ModelsDev } from "@opencode-ai/core/models-dev"
import { NetworkProxy } from "@opencode-ai/core/network-proxy"
import { it } from "./lib/effect"
import { readFile, rm, writeFile, utimes, mkdir } from "fs/promises"
import path from "path"

// 清空 preload 指定路径后，磁盘读取与原子回写必须验证同一个 production cache 文件。
const cacheFile = path.join(Global.Path.cache, "models.json")

const fixture = {
  acme: { id: "acme", name: "Acme", env: [] as string[], models: {} as Record<string, never> },
}
const fixture2 = {
  acme: { id: "acme", name: "Acme Updated", env: [] as string[], models: {} as Record<string, never> },
}

type MockState = {
  body: string
  status: number
  calls: Array<{ url: string; userAgent: string | null }>
}

// 拦真实 routed transport 而非全局 fetch，后续代理包装不能让测试漏到外网。
const installRoutedFetchMock = (state: Ref.Ref<MockState>) =>
  Effect.sync(() =>
    spyOn(NetworkProxy, "routedFetch").mockImplementation(async (input: Request | string | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      const headers = new Headers(init?.headers)
      const userAgent = headers.get("user-agent")
      await Effect.runPromise(
        Ref.update(state, (s) => ({
          ...s,
          calls: [...s.calls, { url, userAgent }],
        })),
      )
      const s = await Effect.runPromise(Ref.get(state))
      return new Response(s.body, { status: s.status })
    }),
  )

// 每例使用新 layer memo，避免上例的 cachedGet 掩盖本例的磁盘或网络行为。
const buildLayer = () => Layer.fresh(AppNodeBuilder.build(ModelsDev.node, []))

const writeCacheText = (text: string, mtimeMs?: number) =>
  Effect.promise(async () => {
    await mkdir(path.dirname(cacheFile), { recursive: true })
    await writeFile(cacheFile, text)
    if (mtimeMs !== undefined) await utimes(cacheFile, mtimeMs / 1000, mtimeMs / 1000)
  })

const writeCache = (data: unknown, mtimeMs?: number) => writeCacheText(JSON.stringify(data), mtimeMs)

// fixture flags 与 transport 必须覆盖 layer 生命周期，不能在请求 fork 尚未退出时提前 restore。
const provided = <A, E>(state: Ref.Ref<MockState>, eff: Effect.Effect<A, E, ModelsDev.Service>) =>
  Effect.acquireUseRelease(
    Effect.gen(function* () {
      const prevPath = Flag.OPENCODE_MODELS_PATH
      const prevDisable = Flag.OPENCODE_DISABLE_MODELS_FETCH
      // 在禁用 fetch 时先建 layer，再打开显式 get，后台刷新不会与用例争抢缓存锁。
      Flag.OPENCODE_MODELS_PATH = undefined
      Flag.OPENCODE_DISABLE_MODELS_FETCH = true
      const spy = yield* installRoutedFetchMock(state)
      const context = yield* Layer.build(buildLayer())
      Flag.OPENCODE_DISABLE_MODELS_FETCH = false
      return { prevPath, prevDisable, spy, context }
    }),
    (env) => eff.pipe(Effect.provide(env.context)),
    (env) =>
      Effect.sync(() => {
        env.spy.mockRestore()
        Flag.OPENCODE_MODELS_PATH = env.prevPath
        Flag.OPENCODE_DISABLE_MODELS_FETCH = env.prevDisable
      }),
  ).pipe(Effect.scoped)

beforeEach(async () => {
  await rm(cacheFile, { force: true })
})

afterAll(async () => {
  await rm(cacheFile, { force: true })
})

const initialState: MockState = {
  body: JSON.stringify(fixture),
  status: 200,
  calls: [],
}

describe("ModelsDev Service", () => {
  it.live("get() returns providers from disk when cache file exists", () =>
    Effect.gen(function* () {
      yield* writeCache(fixture)
      const state = yield* Ref.make(initialState)
      const result = yield* provided(state, ModelsDev.Service.use((s) => s.get()))
      expect(result).toEqual(fixture)
      const final = yield* Ref.get(state)
      expect(final.calls).toEqual([])
    }),
  )

  it.live("get() returns empty catalog when disk empty, fetch disabled, and no bundled snapshot is injected", () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(initialState)
      const result = yield* Effect.acquireUseRelease(
        Effect.gen(function* () {
          const prevPath = Flag.OPENCODE_MODELS_PATH
          const prevDisable = Flag.OPENCODE_DISABLE_MODELS_FETCH
          Flag.OPENCODE_MODELS_PATH = undefined
          Flag.OPENCODE_DISABLE_MODELS_FETCH = true
          const spy = yield* installRoutedFetchMock(state)
          return { prevPath, prevDisable, spy }
        }),
        () => ModelsDev.Service.use((s) => s.get()).pipe(Effect.provide(buildLayer())),
        (env) =>
          Effect.sync(() => {
            env.spy.mockRestore()
            Flag.OPENCODE_MODELS_PATH = env.prevPath
            Flag.OPENCODE_DISABLE_MODELS_FETCH = env.prevDisable
          }),
      )
      expect(result).toEqual({})
      const final = yield* Ref.get(state)
      expect(final.calls).toEqual([])
    }),
  )

  it.live("get() recovers from a corrupted cache file by fetching a fresh catalog", () =>
    Effect.gen(function* () {
      yield* writeCacheText("{")
      const state = yield* Ref.make({ ...initialState, body: JSON.stringify(fixture2) })
      const result = yield* provided(state, ModelsDev.Service.use((s) => s.get()))
      expect(result).toEqual(fixture2)
      expect(yield* Effect.promise(() => readFile(cacheFile, "utf8"))).toBe(JSON.stringify(fixture2))
      const final = yield* Ref.get(state)
      expect(final.calls.length).toBe(1)
    }),
  )

  // 缺盘并发才真正经过 transport；每个 get 都独立 fetch 会被调用数断言捕获。
  it.live("get() is single-flight under concurrent calls", () =>
    Effect.gen(function* () {
      const state = yield* Ref.make(initialState)
      const results = yield* provided(
        state,
        Effect.gen(function* () {
          const svc = yield* ModelsDev.Service
          return yield* Effect.all([svc.get(), svc.get(), svc.get(), svc.get(), svc.get()], {
            concurrency: "unbounded",
          })
        }),
      )
      for (const result of results) expect(result).toEqual(fixture)
      expect((yield* Ref.get(state)).calls.length).toBe(1)
    }),
  )

  // 同一 service 内改磁盘不能改变 cachedGet；每次重建 layer 会让这个缓存契约失去意义。
  it.live("get() caches across calls (later disk writes are ignored until invalidate)", () =>
    Effect.gen(function* () {
      yield* writeCache(fixture)
      const state = yield* Ref.make(initialState)
      const first = yield* provided(
        state,
        Effect.gen(function* () {
          const svc = yield* ModelsDev.Service
          const a = yield* svc.get()
          // mutate disk between calls — cache should mask the change
          yield* writeCache(fixture2)
          const b = yield* svc.get()
          return { a, b }
        }),
      )
      expect(first.a).toEqual(fixture)
      expect(first.b).toEqual(fixture)
    }),
  )

  // 强刷既要替换缓存文件又要 invalidate 内存，否则随后 get 仍会隐藏网络的新结果。
  it.live("refresh(true) fetches via routed fetch and updates the cache", () =>
    Effect.gen(function* () {
      yield* writeCache(fixture)
      const state = yield* Ref.make({ ...initialState, body: JSON.stringify(fixture2) })
      const result = yield* provided(
        state,
        Effect.gen(function* () {
          const svc = yield* ModelsDev.Service
          const before = yield* svc.get()
          yield* svc.refresh(true)
          const after = yield* svc.get()
          return { before, after }
        }),
      )
      expect(result.before).toEqual(fixture)
      expect(result.after).toEqual(fixture2)
      const final = yield* Ref.get(state)
      expect(final.calls.length).toBe(1)
      // URL 和 User-Agent 均来自真实 HttpClient 请求，证明 transport override 没丢请求身份。
      expect(final.calls[0].url).toContain("/api.json")
      expect(final.calls[0].userAgent).toContain("/cli")
      expect(yield* Effect.promise(() => readFile(cacheFile, "utf8"))).toBe(JSON.stringify(fixture2))
    }),
  )

  it.live("refresh(false) skips fetch when on-disk file is fresh", () =>
    Effect.gen(function* () {
      yield* writeCache(fixture, Date.now() - 1000)
      const state = yield* Ref.make({ ...initialState, body: JSON.stringify(fixture2) })
      yield* provided(state, ModelsDev.Service.use((s) => s.refresh(false)))
      const final = yield* Ref.get(state)
      expect(final.calls).toEqual([])
    }),
  )

  // 陈旧缓存必须触发真实 routed transport 的 spy，单测不能只从已保存文件得到期望结果。
  it.live("refresh(false) fetches when on-disk file is stale", () =>
    Effect.gen(function* () {
      yield* writeCache(fixture, Date.now() - 10 * 60 * 1000)
      const state = yield* Ref.make({ ...initialState, body: JSON.stringify(fixture2) })
      const after = yield* provided(
        state,
        Effect.gen(function* () {
          const svc = yield* ModelsDev.Service
          yield* svc.refresh(false)
          return yield* svc.get()
        }),
      )
      expect(after).toEqual(fixture2)
      const final = yield* Ref.get(state)
      expect(final.calls.length).toBe(1)
    }),
  )

  it.live("get() retries an interrupted initial read and reuses the successful catalog", () =>
    Effect.gen(function* () {
      const previous = Flag.OPENCODE_DISABLE_MODELS_FETCH
      Flag.OPENCODE_DISABLE_MODELS_FETCH = true
      // 全局 flag 在 scope 结束时恢复，避免禁用网络的行为泄漏到其他测试。
      yield* Effect.addFinalizer(() => Effect.sync(() => { Flag.OPENCODE_DISABLE_MODELS_FETCH = previous }))
      const started = yield* Deferred.make<void>()
      let reads = 0
      // FSUtil 继承 FileSystem，三个非 Effect 成员必须显式提供，测试仍不会触达真实磁盘。
      const fsLayer = Layer.mock(FSUtil.Service)({
        "~effect/platform/FileSystem": "~effect/platform/FileSystem",
        sink: () => { throw new Error("unexpected sink") },
        globMatch: () => { throw new Error("unexpected globMatch") },
        readJson: () => Effect.gen(function* () {
          reads++
          // 只有第一次读取卡住，后续读取成功才能把真正重试与中断重放区分开。
          if (reads > 1) return fixture
          yield* Deferred.succeed(started, undefined)
          return yield* Effect.never
        }),
      })
      // fresh layer 防止服务 memoMap 复用其他测试已经建立的全局目录缓存。
      const context = yield* Layer.build(Layer.fresh(AppNodeBuilder.build(ModelsDev.node, [[FSUtil.node, fsLayer]])))
      const svc = Context.get(context, ModelsDev.Service)
      const first = yield* svc.get().pipe(Effect.forkChild)
      yield* Deferred.await(started)
      yield* Fiber.interrupt(first)
      const second = yield* svc.get()
      const third = yield* svc.get()
      // 首次读取被请求中断后，下一次 get 必须重新读取；成功目录仍由后续 get 复用。
      expect(second).toEqual(fixture)
      expect(third).toBe(second)
      expect(reads).toBe(2)
    }),
  )

  // 重试耗尽也不能破坏旧缓存，refresh 的 best-effort 契约同时包含内存和磁盘。
  it.live("refresh swallows HTTP errors and leaves cache intact", () =>
    Effect.gen(function* () {
      yield* writeCache(fixture)
      const state = yield* Ref.make({ ...initialState, status: 500, body: "boom" })
      const result = yield* provided(
        state,
        Effect.gen(function* () {
          const svc = yield* ModelsDev.Service
          yield* svc.refresh(true)
          return yield* svc.get()
        }),
      )
      expect(result).toEqual(fixture)
      // 固定 500 必须走原 transient 策略的两次重试，不能靠 refresh 吞错伪装恢复。
      const final = yield* Ref.get(state)
      expect(final.calls.length).toBe(3)
      expect(yield* Effect.promise(() => readFile(cacheFile, "utf8"))).toBe(JSON.stringify(fixture))
    }),
  )
})
