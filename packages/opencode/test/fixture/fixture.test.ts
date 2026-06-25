import { $ } from "bun"
import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import { DISPOSAL_TIMEOUT, disposeAllInstances, tmpdir, withDisposalTimeout, withTestInstance } from "./fixture"
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

describe("withDisposalTimeout", () => {
  test("forwards the resolved value when the promise settles normally", async () => {
    // 正常路径：disposal 快速完成时，withDisposalTimeout 必须透传原始值，
    // 不能被 timeout 分支拦截——这是 Bus 测试依赖的核心不变量：
    // disposeAllInstances 返回后 InstanceDisposed 事件已在 PubSub 队列中。
    const result = await withDisposalTimeout(Promise.resolve(42), "test-normal")
    expect(result).toBe(42)
  })

  test("resolves within the timeout when the promise hangs", async () => {
    // 超时路径：disposal 挂死时，withDisposalTimeout 必须在 DISPOSAL_TIMEOUT
    // (5s) 内返回，而非永久阻塞——这防止 afterEach hook 超时拖垮整个测试文件。
    //
    // 直接用合成 Promise 测试，不经过 disposeAllInstances / InstanceStore，
    // 避免 hang 场景 poison testInstanceRuntime 的 cachedDisposeAll fiber
    // （Effect.cachedWithTTL(Duration.zero) 缓存 in-flight fiber，永不 settle
    // 则永久缓存，后续所有 disposeAll 调用 join 同一个 stuck fiber）。
    const start = Date.now()
    await withDisposalTimeout(new Promise(() => {}), "test-hang")
    const elapsed = Date.now() - start

    // DISPOSAL_TIMEOUT + 2 秒余量覆盖 setTimeout 精度和 CI 调度延迟
    expect(elapsed).toBeLessThan(DISPOSAL_TIMEOUT + 2_000)
    expect(elapsed).toBeGreaterThanOrEqual(DISPOSAL_TIMEOUT)
  })

  test("does not emit a timeout warning when the promise settles first", async () => {
    // timer 清理不变量：p 先 settle 时 clearTimeout 必须执行，
    // 否则 5 秒后会输出虚假的 "disposal timed out" 警告污染 CI 日志。
    const warnings: string[] = []
    const originalWarn = console.warn
    console.warn = (msg: string) => warnings.push(msg)
    try {
      await withDisposalTimeout(Promise.resolve("ok"), "test-no-leak")
      // 等待超过 DISPOSAL_TIMEOUT 确保 setTimeout 不会延迟触发
      await Bun.sleep(DISPOSAL_TIMEOUT + 200)
    } finally {
      console.warn = originalWarn
    }
    expect(warnings).toEqual([])
  })
})

describe("disposeAllInstances", () => {
  test("does not throw when a disposer rejects", async () => {
    // rejection 不传播：disposeInstance（instance-registry.ts）内部
    // 使用 Promise.allSettled 捕获所有 disposer rejection，
    // 因此 disposeAllInstances 本身不会因 disposer rejection 而抛出。
    //
    // 此测试加载真实 instance（让 disposeAllOnce 有 cache entry 可遍历）
    // 并注入 rejecting disposer，验证端到端 rejection-swallowing 行为。
    await using tmp = await tmpdir()
    await withTestInstance({ directory: tmp.path, fn: () => undefined })

    const off = registerDisposer(() => Promise.reject(new Error("simulated disposal failure")))
    try {
      await expect(disposeAllInstances()).resolves.toBeUndefined()
    } finally {
      off()
    }
  })

  test("resolves quickly on empty cache", async () => {
    // 空载路径：无实例可清理时 disposeAllInstances 应在毫秒级返回，
    // 不能因 withDisposalTimeout 引入不必要延迟。
    const start = Date.now()
    await disposeAllInstances()
    expect(Date.now() - start).toBeLessThan(2_000)
  })
})
