import { $ } from "bun"
import * as Observability from "@opencode-ai/core/effect/observability"
import * as fs from "fs/promises"
import os from "os"
import path from "path"
import { Effect, Context, Layer, ManagedRuntime } from "effect"
import type * as PlatformError from "effect/PlatformError"
import type * as Scope from "effect/Scope"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import type { Config } from "@/config/config"
import { InstanceRef } from "../../src/effect/instance-ref"
import { InstanceBootstrap } from "../../src/project/bootstrap-service"
import type { InstanceContext } from "../../src/project/instance-context"
import { InstanceRuntime } from "../../src/project/instance-runtime"
import { InstanceStore } from "../../src/project/instance-store"
import { TestLLMServer } from "../lib/llm-server"

const noopBootstrap = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))
export const testInstanceStoreLayer = InstanceStore.defaultLayer.pipe(Layer.provide(noopBootstrap))
const testInstanceRuntime = ManagedRuntime.make(testInstanceStoreLayer.pipe(Layer.provideMerge(Observability.layer)))

const runTestInstanceStore = <A>(fn: (store: InstanceStore.Interface) => Effect.Effect<A>) =>
  testInstanceRuntime.runPromise(InstanceStore.Service.use(fn))

export async function provideTestInstance<R>(input: {
  directory: string
  init?: Effect.Effect<void>
  fn: (ctx: InstanceContext) => R
}) {
  const ctx = await runTestInstanceStore((store) => store.load({ directory: input.directory }))
  try {
    if (input.init) await testInstanceRuntime.runPromise(input.init.pipe(Effect.provideService(InstanceRef, ctx)))
    return await input.fn(ctx)
  } finally {
    await runTestInstanceStore((store) => store.dispose(ctx))
  }
}

export async function withTestInstance<R>(input: { directory: string; fn: (ctx: InstanceContext) => R }) {
  return input.fn(await runTestInstanceStore((store) => store.load({ directory: input.directory })))
}

export async function reloadTestInstance(input: { directory: string }) {
  return runTestInstanceStore((store) => store.reload(input))
}

// Windows CI 上某些 service finalizer（如 SessionRunState.runner.cancel）
// 偶发挂死会导致 disposeAllInstances 永不返回，进而让 afterEach hook
// 超时（30 秒）并拖垮整个测试文件。为两个 runtime 的 disposal 各设上限：
// 正常 disposal 在毫秒级完成，5 秒提供 50x 余量同时远低于 hook 超时。
//
// 注意：超时只是放弃等待，不会取消后台仍在运行的 disposal fiber——
// 挂死的 disposer 会继续占用资源直到进程退出。这是 teardown 场景下
// 可接受的折衷：优先保证后续测试不被 hook 超时阻断。
export const DISPOSAL_TIMEOUT = 5_000

export const withDisposalTimeout = <T>(p: Promise<T>, label: string) => {
  // 用 setTimeout 而非 Bun.sleep，以便在 p 先 settle 时 clearTimeout
  // 避免向后续测试输出虚假的 "timed out" 警告。
  //
  // 关键不变量：Promise.race 直接竞争原始 p（不包 .finally()），
  // 确保 settle 时序与无超时保护时完全一致——Bus 测试依赖
  // disposeAllInstances 返回后 InstanceDisposed 事件已在 PubSub
  // 队列中，额外的微任务轮次会扰动跨 runtime 的事件投递时序。
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      console.warn(`[fixture] ${label} disposal timed out after ${DISPOSAL_TIMEOUT}ms`)
      resolve()
    }, DISPOSAL_TIMEOUT)
  })
  // 在 p 上注册 settle 回调清除定时器，但不改变 p 本身的 settle 行为
  p.then(() => { if (timer) clearTimeout(timer) }, () => { if (timer) clearTimeout(timer) })
  return Promise.race([p, timeout]) as Promise<T>
}

export async function disposeAllInstances() {
  // Promise.all（而非 allSettled）：disposeInstance（instance-registry.ts）
  // 内部已用 Promise.allSettled 捕获所有 disposer rejection，因此
  // store.disposeAll() 不会因单个 disposer 失败而 reject——
  // 先前 allSettled 的 rejection 日志循环是永远不会触发的死代码。
  // 保持 Promise.all 与绿测基线（16bb317b8b）行为一致。
  await Promise.all([
    withDisposalTimeout(InstanceRuntime.disposeAllInstances(), "InstanceRuntime"),
    withDisposalTimeout(runTestInstanceStore((store) => store.disposeAll()), "InstanceStore"),
  ])
}

// Strip null bytes from paths (defensive fix for CI environment issues)
function sanitizePath(p: string): string {
  return p.replace(/\0/g, "")
}

function exists(dir: string) {
  return fs
    .stat(dir)
    .then(() => true)
    .catch(() => false)
}

function clean(dir: string) {
  return fs.rm(dir, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  })
}

async function stop(dir: string) {
  if (!(await exists(dir))) return
  await $`git fsmonitor--daemon stop`.cwd(dir).quiet().nothrow()
}

type TmpDirOptions<T> = {
  git?: boolean
  config?: Partial<Config.Info>
  init?: (dir: string) => Promise<T>
  dispose?: (dir: string) => Promise<T>
}
export async function tmpdir<T>(options?: TmpDirOptions<T>) {
  const dirpath = sanitizePath(path.join(os.tmpdir(), "opencode-test-" + Math.random().toString(36).slice(2)))
  await fs.mkdir(dirpath, { recursive: true })
  if (options?.git) {
    await $`git init`.cwd(dirpath).quiet()
    // 测试仓库必须复现 opencode Git 服务的 LF 行为；Windows runner 的
    // 系统 core.autocrlf=true 会把 fixture 文件标记为脏并破坏 clone/commit 断言。
    await $`git config core.autocrlf false`.cwd(dirpath).quiet()
    await $`git config core.fsmonitor false`.cwd(dirpath).quiet()
    await $`git config commit.gpgsign false`.cwd(dirpath).quiet()
    await $`git config user.email "test@opencode.test"`.cwd(dirpath).quiet()
    await $`git config user.name "Test"`.cwd(dirpath).quiet()
    await $`git commit --allow-empty -m "root commit ${dirpath}"`.cwd(dirpath).quiet()
  }
  if (options?.config) {
    await Bun.write(
      path.join(dirpath, "opencode.json"),
      JSON.stringify({
        $schema: "https://opencode.ai/config.json",
        ...options.config,
      }),
    )
  }
  const realpath = sanitizePath(await fs.realpath(dirpath))
  const extra = await options?.init?.(realpath)
  const result = {
    [Symbol.asyncDispose]: async () => {
      try {
        await options?.dispose?.(realpath)
      } finally {
        if (options?.git) await stop(realpath).catch(() => undefined)
        await clean(realpath).catch(() => undefined)
      }
    },
    path: realpath,
    extra: extra as T,
  }
  return result
}

/** Effectful scoped tmpdir. Cleaned up when the scope closes. Make sure these stay in sync */
export function tmpdirScoped(options?: { git?: boolean; config?: Partial<Config.Info> }) {
  return Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const dirpath = sanitizePath(path.join(os.tmpdir(), "opencode-test-" + Math.random().toString(36).slice(2)))
    yield* Effect.promise(() => fs.mkdir(dirpath, { recursive: true }))
    const dir = sanitizePath(yield* Effect.promise(() => fs.realpath(dirpath)))

    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        if (options?.git) await stop(dir).catch(() => undefined)
        await clean(dir).catch(() => undefined)
      }),
    )

    const git = (...args: string[]) =>
      spawner.spawn(ChildProcess.make("git", args, { cwd: dir })).pipe(Effect.flatMap((handle) => handle.exitCode))

    if (options?.git) {
      yield* git("init")
      // 与 promise 版 tmpdir 保持一致，屏蔽 Windows 系统级 autocrlf，确保
      // Effect 测试中的 git add/commit 不受 runner 全局配置影响。
      yield* git("config", "core.autocrlf", "false")
      yield* git("config", "core.fsmonitor", "false")
      yield* git("config", "commit.gpgsign", "false")
      yield* git("config", "user.email", "test@opencode.test")
      yield* git("config", "user.name", "Test")
      yield* git("commit", "--allow-empty", "-m", `root commit ${dir}`)
    }

    if (options?.config) {
      yield* Effect.promise(() =>
        fs.writeFile(
          path.join(dir, "opencode.json"),
          JSON.stringify({ $schema: "https://opencode.ai/config.json", ...options.config }),
        ),
      )
    }

    return dir
  })
}

export const provideInstance =
  (directory: string) =>
  <A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.contextWith((services: Context.Context<R>) =>
      Effect.promise<A>(async () => {
        const ctx = await runTestInstanceStore((store) => store.load({ directory }))
        return Effect.runPromiseWith(services)(self.pipe(Effect.provideService(InstanceRef, ctx)))
      }),
    )

export const provideInstanceEffect =
  (directory: string) =>
  <A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, E, R | InstanceStore.Service> =>
    InstanceStore.Service.use((store) => store.provide({ directory }, self))

export const reloadInstance = (input: InstanceStore.LoadInput) =>
  InstanceStore.Service.use((store) => store.reload(input))

export const disposeAllInstancesEffect = InstanceStore.Service.use((store) => store.disposeAll())

export function provideTmpdirInstance<A, E, R>(
  self: (path: string) => Effect.Effect<A, E, R>,
  options?: { git?: boolean; config?: Partial<Config.Info> },
) {
  return Effect.gen(function* () {
    const path = yield* tmpdirScoped(options)
    let provided = false

    yield* Effect.addFinalizer(() =>
      provided
        ? Effect.promise(() =>
            runTestInstanceStore((store) =>
              store.load({ directory: path }).pipe(Effect.flatMap((ctx) => store.dispose(ctx))),
            ),
          ).pipe(Effect.ignore)
        : Effect.void,
    )

    provided = true
    return yield* self(path).pipe(provideInstance(path))
  })
}

export class TestInstance extends Context.Service<TestInstance, { readonly directory: string }>()("@test/Instance") {}

export const withTmpdirInstance =
  (options?: { git?: boolean; config?: Partial<Config.Info> }) =>
  <A, E, R>(self: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped(options)
      return yield* self.pipe(Effect.provideService(TestInstance, { directory }), provideInstanceEffect(directory))
    }).pipe(Effect.provide(testInstanceStoreLayer), Effect.provide(CrossSpawnSpawner.defaultLayer))

export function provideTmpdirServer<A, E, R>(
  self: (input: { dir: string; llm: TestLLMServer["Service"] }) => Effect.Effect<A, E, R>,
  options?: { git?: boolean; config?: (url: string) => Partial<Config.Info> },
): Effect.Effect<
  A,
  E | PlatformError.PlatformError,
  R | TestLLMServer | ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
> {
  return Effect.gen(function* () {
    const llm = yield* TestLLMServer
    return yield* provideTmpdirInstance((dir) => self({ dir, llm }), {
      git: options?.git,
      config: options?.config?.(llm.url),
    })
  })
}
