import { $ } from "bun"
import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import { disposeAllInstances, tmpdir, withTestInstance } from "./fixture"
import { registerDisposer } from "../../src/effect/instance-registry"

describe("tmpdir", () => {
  test("disables fsmonitor for git fixtures", async () => {
    await using tmp = await tmpdir({ git: true })

    const value = (await $`git config core.fsmonitor`.cwd(tmp.path).quiet().text()).trim()
    expect(value).toBe("false")
  })

  test("removes directories on dispose", async () => {
    const tmp = await tmpdir({ git: true })
    const dir = tmp.path

    await tmp[Symbol.asyncDispose]()

    const exists = await fs
      .stat(dir)
      .then(() => true)
      .catch(() => false)
    expect(exists).toBe(false)
  })
})

describe("disposeAllInstances", () => {
  test("does not throw when disposal rejects", async () => {
    // teardown 不应将 disposal rejection 传播给调用方——
    // 这与 db.ts 中 resetDatabase 已有的 .catch(() => undefined) 意图一致。
    //
    // 放在 hang 测试之前执行：hang 测试会向 testInstanceRuntime 的
    // cachedDisposeAll 注入永不 settle 的 fiber，后续 disposeAll 调用
    // 可能 join 同一个卡死 fiber。先执行 rejection 测试可确保它
    // 在干净的缓存状态下验证 rejection-swallowing 行为。
    await using tmp = await tmpdir()
    await withTestInstance({ directory: tmp.path, fn: () => undefined })

    const off = registerDisposer(() => Promise.reject(new Error("simulated disposal failure")))
    try {
      await expect(disposeAllInstances()).resolves.toBeUndefined()
    } finally {
      off()
    }
  })

  test("completes within a bounded time even when an internal disposal hangs", async () => {
    // 行为复现：模拟 Windows CI 上某个 service finalizer 挂死。
    // withTestInstance 加载 instance 但不 dispose（与 provideTestInstance 不同），
    // 让 disposeAllInstances 有 cache entry 可遍历。
    // 注入永不 resolve 的 disposer 模拟 SessionRunState.runner.cancel 等
    // finalizer 在特定时序下不返回的场景。
    // 修复前 disposeAllInstances 会永远挂起，修复后应在远低于 30 秒
    // hook 超时的时间内返回。
    await using tmp = await tmpdir()
    // withTestInstance 不 dispose，instance 留在 testInstanceRuntime 缓存中
    await withTestInstance({ directory: tmp.path, fn: () => undefined })

    const off = registerDisposer(() => new Promise(() => {}))
    try {
      const start = Date.now()
      await disposeAllInstances()
      const elapsed = Date.now() - start

      // fixture.ts 中 DISPOSAL_TIMEOUT = 5_000，此处加 2 秒调度开销余量。
      // 关键是远低于 bun 30 秒 hook 超时，避免 afterEach 拖垮整个测试文件。
      expect(elapsed).toBeLessThan(5_000 + 2_000)
    } finally {
      off()
    }
  })
})
