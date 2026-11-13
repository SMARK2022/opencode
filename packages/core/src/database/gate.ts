export * as DatabaseGate from "./gate"

import { Effect } from "effect"
import { resolve } from "path"

type Hold = { id: string; supervisor: string }
type QueuedHold = Hold & {
  resolve(id: string): void
  reject(error: Error): void
  signal?: AbortSignal
  onAbort?: () => void
}
type State = {
  active: Map<string, Hold> // 已确认的 Worker 持有项会阻止新的父侧 SQL 进入。
  queued: QueuedHold[] // 等待中的 Worker 请求按数组顺序取得下一次数据库使用权。
  parents: Set<() => void> // 父侧回调只负责恢复 admission，不执行具体 SQL。
  reservations: number // 已开放父事务必须结束后，Worker 才能获得确认避免交叉等待。
}

const states = new Map<string, State>()
let sequence = 0

function keyOf(filename: string) {
  return filename === ":memory:" ? filename : resolve(filename) // 文件数据库统一按解析后的真实路径隔离队列。
}

function stateOf(filename: string) {
  const key = keyOf(filename)
  return states.get(key) ?? states.set(key, { active: new Map(), queued: [], parents: new Set(), reservations: 0 }).get(key)!
}

function settle(filename: string, state: State) {
  if (state.active.size === 0 && state.reservations === 0 && state.queued.length > 0) {
    const next = state.queued.shift()! // 只提升队首请求，保证多个维护批次的 FIFO 顺序。
    if (next.signal && next.onAbort) next.signal.removeEventListener("abort", next.onAbort)
    state.active.set(next.id, { id: next.id, supervisor: next.supervisor }) // 先发布持有项再确认，Worker 不会在未登记时执行 SQL。
    next.resolve(next.id) // 确认消息到达后，Worker 才开始自己的原生数据库预约。
    return
  }
  if (state.active.size > 0 || state.queued.length > 0 || state.reservations > 0) return
  for (const resume of state.parents) resume() // 最后一个持有项释放后统一唤醒父侧等待队列。
  state.parents.clear()
  if (state.reservations === 0) states.delete(keyOf(filename))
}

export function hold(filename: string, supervisor: string, signal?: AbortSignal): Promise<string> {
  const state = stateOf(filename)
  return new Promise<string>((resolveHold, reject) => {
    if (signal?.aborted) return reject(new Error("Database gate hold aborted")) // 已取消请求不会进入队列，也不会阻塞后续父请求。
    const request: QueuedHold = {
      id: `dbhold_${++sequence}`,
      supervisor,
      resolve: resolveHold,
      reject,
      signal,
    }
    if (signal) {
      request.onAbort = () => {
        const index = state.queued.indexOf(request)
        if (index < 0) return
        state.queued.splice(index, 1) // 中断只删除尚未确认的持有请求，不影响正在执行的其他批次。
        reject(new Error("Database gate hold aborted"))
        settle(filename, state)
      }
    }
    if (state.active.size === 0 && state.queued.length === 0 && state.reservations === 0) {
      state.active.set(request.id, { id: request.id, supervisor })
      return resolveHold(request.id)
    }
    state.queued.push(request)
    if (request.onAbort) signal?.addEventListener("abort", request.onAbort, { once: true })
  })
}

export function enter(filename: string): Effect.Effect<Effect.Effect<void>> {
  return Effect.callback<Effect.Effect<void>>((resume) => {
    const state = stateOf(filename)
    const admit = () => {
      state.reservations++ // 父事务在入口处登记完整生命周期，内部语句沿用同一许可。
      resume(Effect.succeed(Effect.sync(() => {
        state.reservations-- // 事务收尾后才允许监督端确认下一段 Worker SQL。
        settle(filename, state)
      })))
    }
    if (state.active.size === 0 && state.queued.length === 0) return admit()
    const ready = () => admit()
    state.parents.add(ready)
    return Effect.sync(() => { state.parents.delete(ready) })
  })
}

export function release(filename: string, id: string) {
  const state = states.get(keyOf(filename))
  if (!state?.active.delete(id)) return // 重复或过期释放保持幂等，不能误删替代持有项。
  settle(filename, state)
}

export function releaseSupervisor(filename: string, supervisor: string) {
  const state = states.get(keyOf(filename))
  if (!state) return
  for (const [id, hold] of state.active) {
    if (hold.supervisor === supervisor) state.active.delete(id) // 异常退出按监督身份清理全部残留持有项。
  }
  const queued = state.queued.filter((request) => request.supervisor === supervisor)
  state.queued = state.queued.filter((request) => request.supervisor !== supervisor)
  for (const request of queued) request.reject(new Error("Database gate supervisor exited")) // 未确认请求收到失败，避免 Worker 退出后留下悬空 Promise。
  settle(filename, state)
}

export function wait(filename: string): Effect.Effect<void> {
  return Effect.callback<void>((resume) => {
    const state = stateOf(filename)
    if (state.active.size === 0 && state.queued.length === 0) {
      if (state.reservations === 0) states.delete(keyOf(filename))
      return resume(Effect.void)
    }
    const ready = () => resume(Effect.void)
    state.parents.add(ready)
    return Effect.sync(() => { state.parents.delete(ready) })
  })
}
