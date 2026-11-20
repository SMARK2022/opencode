// 测试层资源泄漏门禁：整轮测试结束时（所有文件的 afterAll 都已执行），仍在运行、且会阻止进程退出的
// 计时器和子进程必须为 0。不在单个测试结束时判定：共享运行时常在第一个用到它的测试里启动计时器，
// 到 afterAll 才关闭，这是正常生命周期。计时器不分是谁创建的（Effect、库、测试本身都算）。
import { afterAll, expect } from "bun:test"

const timers = new Map<unknown, string>()
const children = new Set<ReturnType<typeof Bun.spawn>>()
const origSetTimeout = globalThis.setTimeout
const origSetInterval = globalThis.setInterval
const origClearTimeout = globalThis.clearTimeout
const origClearInterval = globalThis.clearInterval
const origSpawn = Bun.spawn

// 报告仓库里的创建位置：跳过本文件和依赖包里的栈帧
const site = () =>
  new Error().stack
    ?.split("\n")
    .slice(2)
    .map((frame) => frame.trim())
    .find((frame) => !frame.includes("leak-preload") && !frame.includes("node_modules")) ?? "unknown"

globalThis.setTimeout = ((fn: (...a: unknown[]) => void, ms?: number, ...rest: unknown[]) => {
  const where = site()
  const handle = origSetTimeout(
    (...a: unknown[]) => {
      timers.delete(handle)
      fn(...a)
    },
    ms,
    ...rest,
  )
  timers.set(handle, `setTimeout(${ms ?? 0}) @ ${where}`)
  return handle
}) as typeof setTimeout

globalThis.setInterval = ((fn: (...a: unknown[]) => void, ms?: number, ...rest: unknown[]) => {
  const handle = origSetInterval(fn, ms, ...rest)
  timers.set(handle, `setInterval(${ms ?? 0}) @ ${site()}`)
  return handle
}) as typeof setInterval

globalThis.clearTimeout = ((h: Parameters<typeof clearTimeout>[0]) => {
  timers.delete(h)
  origClearTimeout(h)
}) as typeof clearTimeout

globalThis.clearInterval = ((h: Parameters<typeof clearInterval>[0]) => {
  timers.delete(h)
  origClearInterval(h)
}) as typeof clearInterval

Bun.spawn = ((...args: Parameters<typeof Bun.spawn>) => {
  const proc = origSpawn(...args)
  children.add(proc)
  proc.exited.then(() => children.delete(proc))
  return proc
}) as typeof Bun.spawn

// 预加载里的 afterAll 在所有测试文件结束后执行一次
afterAll(async () => {
  await Bun.sleep(0)
  // unref() 过的计时器不会阻止进程退出，不算泄漏
  const leakedTimers = [...timers]
    .filter(([handle]) => (handle as { hasRef?: () => boolean }).hasRef?.() !== false)
    .map(([, where]) => where)
  const leakedChildren = [...children].filter((p) => p.exitCode === null).map((p) => `pid ${p.pid}`)
  for (const p of children) if (p.exitCode === null) p.kill()
  expect({ leakedTimers, leakedChildren }).toEqual({ leakedTimers: [], leakedChildren: [] })
})
