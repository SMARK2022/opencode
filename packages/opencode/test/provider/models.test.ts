import { describe, expect, beforeAll, beforeEach, afterAll } from "bun:test"
import { Effect, Layer } from "effect"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Global } from "@opencode-ai/core/global"
import { Hash } from "@opencode-ai/core/util/hash"
import { ModelsDev } from "../../src/provider/models"
import { it } from "../lib/effect"
import { rm, writeFile, utimes, mkdir } from "fs/promises"
import path from "path"

// test/preload.ts pins OPENCODE_MODELS_PATH to a fixture so other tests can
// resolve providers without network. These tests need to drive the on-disk
// cache themselves and silence the eager refresh fork. Save/restore around
// the suite — never leak the mutation to subsequent test files in the same
// bun process.
const ORIGINAL_MODELS_PATH = Flag.OPENCODE_MODELS_PATH
const ORIGINAL_DISABLE_FETCH = Flag.OPENCODE_DISABLE_MODELS_FETCH
const ORIGINAL_MODELS_URL = Flag.OPENCODE_MODELS_URL
beforeAll(() => {
  Flag.OPENCODE_MODELS_PATH = undefined
  Flag.OPENCODE_DISABLE_MODELS_FETCH = true
})
afterAll(() => {
  Flag.OPENCODE_MODELS_PATH = ORIGINAL_MODELS_PATH
  Flag.OPENCODE_DISABLE_MODELS_FETCH = ORIGINAL_DISABLE_FETCH
  Flag.OPENCODE_MODELS_URL = ORIGINAL_MODELS_URL
})

const source = () => Flag.OPENCODE_MODELS_URL || "https://models.dev"
const cacheFile = () =>
  path.join(Global.Path.cache, source() === "https://models.dev" ? "models.json" : `models-${Hash.fast(source())}.json`)

const fixture: Record<string, ModelsDev.Provider> = {
  acme: {
    id: "acme",
    name: "Acme",
    env: ["ACME_API_KEY"],
    models: {
      "acme-1": {
        id: "acme-1",
        name: "Acme One",
        release_date: "2026-01-01",
        attachment: false,
        reasoning: false,
        temperature: true,
        tool_call: true,
        limit: { context: 128000, output: 8192 },
      },
    },
  },
}

const fixture2: Record<string, ModelsDev.Provider> = {
  beta: {
    id: "beta",
    name: "Beta",
    env: ["BETA_API_KEY"],
    models: {
      "beta-1": {
        id: "beta-1",
        name: "Beta One",
        release_date: "2026-02-01",
        attachment: false,
        reasoning: true,
        temperature: false,
        tool_call: false,
        limit: { context: 64000, output: 4096 },
      },
    },
  },
}

interface ServerState {
  body: string
  status: number
  calls: Array<{ url: string }>
}

function withModelsServer<A, E, R>(state: ServerState, run: (state: ServerState) => Effect.Effect<A, E, R>) {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = Flag.OPENCODE_MODELS_URL
      const server = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        fetch(request) {
          state.calls.push({ url: request.url })
          return new Response(state.body, { status: state.status })
        },
      })
      Flag.OPENCODE_MODELS_URL = server.url.origin
      return { server, previous, file: cacheFile() }
    }),
    () => run(state),
    (value) =>
      Effect.promise(async () => {
        value.server.stop(true)
        await rm(value.file, { force: true })
        Flag.OPENCODE_MODELS_URL = value.previous
      }),
  )
}

const buildLayer = () =>
  // Layer.fresh is required: ModelsDev.layer is a module-level Layer constant,
  // and Effect.provide uses a process-global MemoMap by default — without fresh,
  // every test would reuse the cachedInvalidateWithTTL state from the first run.
  Layer.fresh(ModelsDev.layer).pipe(Layer.provide(AppFileSystem.defaultLayer))

const writeCache = (data: object, mtimeMs?: number) =>
  Effect.promise(async () => {
    await mkdir(Global.Path.cache, { recursive: true })
    await writeFile(cacheFile(), JSON.stringify(data))
    if (mtimeMs !== undefined) {
      const t = mtimeMs / 1000
      await utimes(cacheFile(), t, t)
    }
  })

const provided = <A, E>(eff: Effect.Effect<A, E, ModelsDev.Service>) => eff.pipe(Effect.provide(buildLayer()))

beforeEach(async () => {
  await rm(cacheFile(), { force: true })
})

afterAll(async () => {
  await rm(cacheFile(), { force: true })
})

const initialState: ServerState = {
  body: JSON.stringify(fixture),
  status: 200,
  calls: [],
}

const serverState = (input?: Partial<Omit<ServerState, "calls">>): ServerState => ({
  ...initialState,
  ...input,
  calls: [],
})

describe("ModelsDev Service", () => {
  it.live("get() returns providers from disk when cache file exists", () =>
    Effect.gen(function* () {
      yield* writeCache(fixture)
      const result = yield* provided(ModelsDev.Service.use((s) => s.get()))
      expect(result).toEqual(fixture)
    }),
  )

  it.live("get() does not fetch when disk empty and fetch disabled", () =>
    Effect.gen(function* () {
      const state = serverState()
      const result = yield* withModelsServer(state, () => provided(ModelsDev.Service.use((s) => s.get())))
      expect(typeof result).toBe("object")
      expect(state.calls).toEqual([])
    }),
  )

  it.live("get() is single-flight under concurrent calls", () =>
    Effect.gen(function* () {
      yield* writeCache(fixture)
      const results = yield* provided(
        Effect.gen(function* () {
          const svc = yield* ModelsDev.Service
          return yield* Effect.all([svc.get(), svc.get(), svc.get(), svc.get(), svc.get()], {
            concurrency: "unbounded",
          })
        }),
      )
      for (const result of results) expect(result).toEqual(fixture)
    }),
  )

  it.live("get() caches across calls (later disk writes are ignored until invalidate)", () =>
    Effect.gen(function* () {
      yield* writeCache(fixture)
      const first = yield* provided(
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

  it.live("refresh(true) fetches through routed fetch and updates the cache", () =>
    Effect.gen(function* () {
      const state = serverState({ body: JSON.stringify(fixture2) })
      const result = yield* withModelsServer(state, () =>
        provided(
          Effect.gen(function* () {
            yield* writeCache(fixture)
            const svc = yield* ModelsDev.Service
            const before = yield* svc.get()
            yield* svc.refresh(true)
            const after = yield* svc.get()
            return { before, after }
          }),
        ),
      )
      expect(result.before).toEqual(fixture)
      expect(result.after).toEqual(fixture2)
      expect(state.calls.length).toBe(1)
      expect(state.calls[0]?.url).toContain("/api.json")
    }),
  )

  it.live("refresh(false) skips fetch when on-disk file is fresh", () =>
    Effect.gen(function* () {
      const state = serverState({ body: JSON.stringify(fixture2) })
      yield* withModelsServer(state, () =>
        provided(
          Effect.gen(function* () {
            // Fresh: mtime within the 5-minute TTL.
            yield* writeCache(fixture, Date.now() - 1000)
            const svc = yield* ModelsDev.Service
            yield* svc.refresh(false)
          }),
        ),
      )
      expect(state.calls).toEqual([])
    }),
  )

  it.live("refresh(false) fetches when on-disk file is stale", () =>
    Effect.gen(function* () {
      const state = serverState({ body: JSON.stringify(fixture2) })
      const after = yield* withModelsServer(state, () =>
        provided(
          Effect.gen(function* () {
            // Stale: mtime 10 minutes ago, beyond the 5-minute TTL.
            yield* writeCache(fixture, Date.now() - 10 * 60 * 1000)
            const svc = yield* ModelsDev.Service
            yield* svc.refresh(false)
            return yield* svc.get()
          }),
        ),
      )
      expect(state.calls.length).toBe(1)
      expect(after).toEqual(fixture2)
    }),
  )

  it.live("refresh swallows HTTP errors and leaves cache intact", () =>
    Effect.gen(function* () {
      const state = serverState({ status: 500, body: "boom" })
      const result = yield* withModelsServer(state, () =>
        provided(
          Effect.gen(function* () {
            yield* writeCache(fixture)
            const svc = yield* ModelsDev.Service
            yield* svc.refresh(true)
            return yield* svc.get()
          }),
        ),
      )
      expect(result).toEqual(fixture)
      expect(state.calls.length).toBe(1)
    }),
  )
})
