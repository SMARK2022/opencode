// 测试层资源泄漏门禁：每个测试结束时，本测试创建且未释放的定时器、子进程必须为 0。
import { afterEach, expect } from "bun:test"

const timers = new Map<unknown, string>()
const children = new Set<{ pid: number; exitCode: number | null; killed: boolean }>()
const origSetTimeout = globalThis.setTimeout
const origSetInterval = globalThis.setInterval
const origClearTimeout = globalThis.clearTimeout
const origClearInterval = globalThis.clearInterval
const origSpawn = Bun.spawn

const site = () => new Error().stack?.split("\n")[3]?.trim() ?? "unknown"

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

afterEach(async () => {
  await Bun.sleep(0)
  const leakedTimers = [...timers.values()]
  const leakedChildren = [...children].filter((p) => p.exitCode === null).map((p) => `pid ${p.pid}`)
  timers.clear()
  for (const p of children) if (p.exitCode === null) (p as unknown as { kill(): void }).kill()
  children.clear()
  expect({ leakedTimers, leakedChildren }).toEqual({ leakedTimers: [], leakedChildren: [] })
})
