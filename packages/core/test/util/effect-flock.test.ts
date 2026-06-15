import { describe, expect } from "bun:test"
import { spawn } from "child_process"
import fs from "fs/promises"
import path from "path"
import os from "os"
import { Cause, Effect, Exit, Layer } from "effect"
import { systemError } from "effect/PlatformError"
import { testEffect } from "../lib/effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EffectFlock } from "@opencode-ai/core/util/effect-flock"
import { Global } from "@opencode-ai/core/global"
import { Hash } from "@opencode-ai/core/util/hash"
import { FSUtil } from "@opencode-ai/core/fs-util"

function lock(dir: string, key: string) {
  return path.join(dir, Hash.fast(key) + ".lock")
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

async function exists(file: string) {
  return fs
    .stat(file)
    .then(() => true)
    .catch(() => false)
}

async function readJson<T>(p: string): Promise<T> {
  return JSON.parse(await fs.readFile(p, "utf8"))
}

// ---------------------------------------------------------------------------
// Worker subprocess helpers
// ---------------------------------------------------------------------------

type Msg = {
  key: string
  dir: string
  holdMs?: number
  ready?: string
  active?: string
  done?: string
}

const root = path.join(import.meta.dir, "../..")
const worker = path.join(import.meta.dir, "../fixture/effect-flock-worker.ts")

function run(msg: Msg) {
  return new Promise<{ code: number; stdout: Buffer; stderr: Buffer }>((resolve) => {
    const proc = spawn(process.execPath, [worker, JSON.stringify(msg)], { cwd: root })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    proc.stdout?.on("data", (data) => stdout.push(Buffer.from(data)))
    proc.stderr?.on("data", (data) => stderr.push(Buffer.from(data)))
    proc.on("close", (code) => {
      resolve({ code: code ?? 1, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) })
    })
  })
}

function spawnWorker(msg: Msg) {
  return spawn(process.execPath, [worker, JSON.stringify(msg)], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
  })
}

async function stopWorker(proc: ReturnType<typeof spawnWorker>) {
  if (proc.exitCode !== null || proc.signalCode !== null) return

  const closed = new Promise<void>((resolve) => proc.once("close", () => resolve()))

  if (process.platform !== "win32" || !proc.pid) {
    proc.kill()
    await closed
    return
  }

  await new Promise<void>((resolve) => {
    const killProc = spawn("taskkill", ["/pid", String(proc.pid), "/T", "/F"])
    killProc.on("close", () => {
      proc.kill()
      resolve()
    })
  })
  await closed
}

async function waitForFile(file: string, timeout = 3_000) {
  const stop = Date.now() + timeout
  while (Date.now() < stop) {
    if (await exists(file)) return
    await sleep(20)
  }
  throw new Error(`Timed out waiting for file: ${file}`)
}

// ---------------------------------------------------------------------------
// Test layer
// ---------------------------------------------------------------------------

const testGlobal = Global.layerWith({
  home: os.homedir(),
  data: os.tmpdir(),
  cache: os.tmpdir(),
  config: os.tmpdir(),
  state: os.tmpdir(),
  bin: os.tmpdir(),
  log: os.tmpdir(),
})

const testLayer = AppNodeBuilder.build(EffectFlock.node, [[Global.node, testGlobal]])

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("util.effect-flock", () => {
  const it = testEffect(testLayer)

  it.live(
    "acquire and release via scoped Effect",
    Effect.gen(function* () {
      const flock = yield* EffectFlock.Service
      const tmp = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "eflock-test-")))
      const dir = path.join(tmp, "locks")
      const lockDir = lock(dir, "eflock:acquire")

      yield* Effect.scoped(flock.acquire("eflock:acquire", dir))

      expect(yield* Effect.promise(() => exists(lockDir))).toBe(false)
      const released: string[] = []
      let attempts = 0
      const filesystem = Layer.effect(FSUtil.Service, Effect.gen(function* () {
        const actual = yield* FSUtil.Service
        return FSUtil.Service.of({ ...actual, rename: (from, to) => Effect.gen(function* () {
          if (from === lockDir && process.platform === "win32" && ++attempts === 1) {
            // 复刻线上Unknown/EPERM，不让第一次共享冲突跳过真实交接和后继owner断言。
            return yield* systemError({ _tag: "Unknown", module: "FileSystem", method: "rename", cause: Object.assign(new Error("sharing violation"), { code: "EPERM" }) })
          }
          yield* actual.rename(from, to)
          if (from !== lockDir) return
          released.push(to)
          // 在真实rename和旧目录清理之间重建活动锁，确定性模拟下一owner抢到同一路径。
          yield* actual.makeDirectory(from)
          yield* actual.writeFileString(path.join(from, "meta.json"), JSON.stringify({ token: "next-owner" }))
        }) })
      })).pipe(Layer.provide(LayerNode.compile(FSUtil.node)))
      yield* Effect.gen(function* () {
        // 默认服务已在本用例构建；fresh避免memo复用它而绕过真实文件交接夹具。
        yield* Effect.scoped(Effect.gen(function* () {
          const guarded = yield* EffectFlock.Service
          yield* guarded.acquire("eflock:acquire", dir)
        }).pipe(Effect.provide(Layer.fresh(AppNodeBuilder.build(EffectFlock.node, [[Global.node, testGlobal], [FSUtil.node, filesystem]])))))
        expect(released).toHaveLength(1)
        expect(attempts).toBe(process.platform === "win32" ? 2 : 0)
        expect(released[0]).toStartWith(`${lockDir}.release-`)
        // scope释放只能清掉改名后的旧目录，下一owner的元数据和活动目录须完整保留。
        expect((yield* Effect.promise(() => readJson<{ token: string }>(path.join(lockDir, "meta.json")))).token).toBe("next-owner")
        expect(yield* Effect.promise(() => fs.readdir(dir))).toEqual([path.basename(lockDir)])
      }).pipe(Effect.ensuring(Effect.promise(() => fs.rm(tmp, { recursive: true, force: true }))))
    }),
  )

  for (const errorCode of ["EIO", "EPERM"]) {
    it.live(`preserves persistent ${errorCode} release failures`, Effect.gen(function* () {
      const tmp = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "eflock-error-")))
      const dir = path.join(tmp, "locks")
      let attempts = 0
      const filesystem = Layer.effect(FSUtil.Service, Effect.gen(function* () {
        const actual = yield* FSUtil.Service
        return FSUtil.Service.of({ ...actual, rename: () => Effect.suspend(() => {
          attempts++
          return Effect.fail(systemError({ _tag: "Unknown", module: "FileSystem", method: "rename", cause: Object.assign(new Error(`${errorCode} release failure`), { code: errorCode }) }))
        }) })
      })).pipe(Layer.provide(LayerNode.compile(FSUtil.node)))
      // 只替换外部FS失败边界，获取、token校验和释放仍执行真实锁实现。
      const result = yield* Effect.scoped(Effect.gen(function* () {
        const flock = yield* EffectFlock.Service
        yield* flock.acquire("eflock:release-error", dir)
      }).pipe(Effect.provide(Layer.fresh(AppNodeBuilder.build(EffectFlock.node, [[Global.node, testGlobal], [FSUtil.node, filesystem]]))))).pipe(Effect.exit)
      yield* Effect.gen(function* () {
        expect(Exit.isFailure(result)).toBe(true)
        const failure = Exit.isFailure(result) ? Cause.pretty(result.cause) : ""
        expect(failure).toContain(errorCode)
        expect(failure).not.toContain("directory missing")
        // 无关I/O错误不重试；持久共享拒绝也必须有界失败并保留活动owner。
        expect(attempts).toBe(process.platform === "win32" && errorCode === "EPERM" ? 21 : 1)
        expect(yield* Effect.promise(() => exists(lock(dir, "eflock:release-error")))).toBe(true)
      }).pipe(Effect.ensuring(Effect.promise(() => fs.rm(tmp, { recursive: true, force: true }))))
    }))
  }

  it.live(
    "withLock data-first",
    Effect.gen(function* () {
      const flock = yield* EffectFlock.Service
      const tmp = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "eflock-test-")))
      const dir = path.join(tmp, "locks")

      let hit = false
      yield* flock.withLock(
        Effect.sync(() => {
          hit = true
        }),
        "eflock:df",
        dir,
      )
      expect(hit).toBe(true)
      yield* Effect.promise(() => fs.rm(tmp, { recursive: true, force: true }))
    }),
  )

  it.live(
    "withLock pipeable",
    Effect.gen(function* () {
      const flock = yield* EffectFlock.Service
      const tmp = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "eflock-test-")))
      const dir = path.join(tmp, "locks")

      let hit = false
      yield* Effect.sync(() => {
        hit = true
      }).pipe(flock.withLock("eflock:pipe", dir))
      expect(hit).toBe(true)
      yield* Effect.promise(() => fs.rm(tmp, { recursive: true, force: true }))
    }),
  )

  it.live(
    "writes owner metadata",
    Effect.gen(function* () {
      const flock = yield* EffectFlock.Service
      const tmp = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "eflock-test-")))
      const dir = path.join(tmp, "locks")
      const key = "eflock:meta"
      const file = path.join(lock(dir, key), "meta.json")

      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* flock.acquire(key, dir)
          const json = yield* Effect.promise(() =>
            readJson<{ token?: unknown; pid?: unknown; hostname?: unknown; createdAt?: unknown }>(file),
          )
          expect(typeof json.token).toBe("string")
          expect(typeof json.pid).toBe("number")
          expect(typeof json.hostname).toBe("string")
          expect(typeof json.createdAt).toBe("string")
        }),
      )
      yield* Effect.promise(() => fs.rm(tmp, { recursive: true, force: true }))
    }),
  )

  it.live(
    "breaks stale lock dirs",
    Effect.gen(function* () {
      const flock = yield* EffectFlock.Service
      const tmp = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "eflock-test-")))
      const dir = path.join(tmp, "locks")
      const key = "eflock:stale"
      const lockDir = lock(dir, key)

      yield* Effect.promise(async () => {
        await fs.mkdir(lockDir, { recursive: true })
        const old = new Date(Date.now() - 120_000)
        await fs.utimes(lockDir, old, old)
      })

      let hit = false
      yield* flock.withLock(
        Effect.sync(() => {
          hit = true
        }),
        key,
        dir,
      )
      expect(hit).toBe(true)
      yield* Effect.promise(() => fs.rm(tmp, { recursive: true, force: true }))
    }),
  )

  it.live(
    "recovers from stale breaker",
    Effect.gen(function* () {
      const flock = yield* EffectFlock.Service
      const tmp = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "eflock-test-")))
      const dir = path.join(tmp, "locks")
      const key = "eflock:stale-breaker"
      const lockDir = lock(dir, key)
      const breaker = lockDir + ".breaker"

      yield* Effect.promise(async () => {
        await fs.mkdir(lockDir, { recursive: true })
        await fs.mkdir(breaker)
        const old = new Date(Date.now() - 120_000)
        await fs.utimes(lockDir, old, old)
        await fs.utimes(breaker, old, old)
      })

      let hit = false
      yield* flock.withLock(
        Effect.sync(() => {
          hit = true
        }),
        key,
        dir,
      )
      expect(hit).toBe(true)
      expect(yield* Effect.promise(() => exists(breaker))).toBe(false)
      yield* Effect.promise(() => fs.rm(tmp, { recursive: true, force: true }))
    }),
  )

  it.live(
    "detects compromise when lock dir removed",
    Effect.gen(function* () {
      const flock = yield* EffectFlock.Service
      const tmp = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "eflock-test-")))
      const dir = path.join(tmp, "locks")
      const key = "eflock:compromised"
      const lockDir = lock(dir, key)

      const result = yield* flock
        .withLock(
          Effect.promise(() => fs.rm(lockDir, { recursive: true, force: true })),
          key,
          dir,
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(result)).toBe(true)
      expect(Exit.isFailure(result) ? Cause.pretty(result.cause) : "").toContain("missing")
      yield* Effect.promise(() => fs.rm(tmp, { recursive: true, force: true }))
    }),
  )

  it.live(
    "detects token mismatch",
    Effect.gen(function* () {
      const flock = yield* EffectFlock.Service
      const tmp = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "eflock-test-")))
      const dir = path.join(tmp, "locks")
      const key = "eflock:token"
      const lockDir = lock(dir, key)
      const meta = path.join(lockDir, "meta.json")

      const result = yield* flock
        .withLock(
          Effect.promise(async () => {
            const json = await readJson<{ token?: string }>(meta)
            json.token = "tampered"
            await fs.writeFile(meta, JSON.stringify(json, null, 2))
          }),
          key,
          dir,
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(result)).toBe(true)
      expect(Exit.isFailure(result) ? Cause.pretty(result.cause) : "").toContain("token mismatch")
      expect(yield* Effect.promise(() => exists(lockDir))).toBe(true)
      yield* Effect.promise(() => fs.rm(tmp, { recursive: true, force: true }))
    }),
  )

  it.live(
    "fails on unwritable lock roots",
    Effect.gen(function* () {
      if (process.platform === "win32") return
      const flock = yield* EffectFlock.Service
      const tmp = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "eflock-test-")))
      const dir = path.join(tmp, "locks")

      yield* Effect.promise(async () => {
        await fs.mkdir(dir, { recursive: true })
        await fs.chmod(dir, 0o500)
      })

      const result = yield* flock.withLock(Effect.void, "eflock:perm", dir).pipe(Effect.exit)
      // oxlint-disable-next-line no-base-to-string -- Exit has a useful toString for test assertions
      expect(String(result)).toContain("PermissionDenied")
      yield* Effect.promise(() => fs.chmod(dir, 0o700).then(() => fs.rm(tmp, { recursive: true, force: true })))
    }),
  )

  it.live(
    "enforces mutual exclusion under process contention",
    () =>
      Effect.promise(async () => {
        const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "eflock-stress-"))
        const dir = path.join(tmp, "locks")
        const done = path.join(tmp, "done.log")
        const active = path.join(tmp, "active")
        const n = 16

        try {
          const out = await Promise.all(
            Array.from({ length: n }, () => run({ key: "eflock:stress", dir, done, active, holdMs: 30 })),
          )

          expect(out.map((x) => x.code)).toEqual(Array.from({ length: n }, () => 0))
          expect(out.map((x) => x.stderr.toString()).filter(Boolean)).toEqual([])

          const lines = (await fs.readFile(done, "utf8"))
            .split("\n")
            .map((x) => x.trim())
            .filter(Boolean)
          expect(lines.length).toBe(n)
        } finally {
          await fs.rm(tmp, { recursive: true, force: true })
        }
      }),
    60_000,
  )

  it.live(
    "recovers after a crashed lock owner",
    () =>
      Effect.promise(async () => {
        const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "eflock-crash-"))
        const dir = path.join(tmp, "locks")
        const ready = path.join(tmp, "ready")

        const proc = spawnWorker({ key: "eflock:crash", dir, ready, holdMs: 120_000 })

        try {
          await waitForFile(ready, 5_000)
          await stopWorker(proc)

          // Backdate lock files so they're past STALE_MS (60s)
          const lockDir = lock(dir, "eflock:crash")
          const old = new Date(Date.now() - 120_000)
          await fs.utimes(lockDir, old, old).catch(() => {})
          await fs.utimes(path.join(lockDir, "heartbeat"), old, old).catch(() => {})
          await fs.utimes(path.join(lockDir, "meta.json"), old, old).catch(() => {})

          const done = path.join(tmp, "done.log")
          const result = await run({ key: "eflock:crash", dir, done, holdMs: 10 })
          expect(result.code).toBe(0)
          expect(result.stderr.toString()).toBe("")
        } finally {
          await stopWorker(proc).catch(() => {})
          await fs.rm(tmp, { recursive: true, force: true })
        }
      }),
    30_000,
  )
})
