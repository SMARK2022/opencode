import { EventEmitter } from "events"
import { Effect } from "effect"

const emitter = new EventEmitter()
const active = new Set<symbol>()

// #152：begin 返回 end；进程内跟踪 session/shell 活跃 runner
export function begin(id: string) {
  // #235：不同 listener 可并行处理同一 ID，每次登记独占令牌，避免互相提前释放。
  const token = Symbol(id)
  active.add(token)
  emitter.emit("change", active.size)

  let done = false
  return () => {
    if (done) return
    done = true
    active.delete(token)
    emitter.emit("change", active.size)
  }
}

// 只登记实际 work 的生命周期；join/排队等待者不取得也不提前释放活动所有权。
export const track = <A, E, R>(id: string, work: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => begin(id)),
    () => work,
    (end) => Effect.sync(end),
  )

// #152：当前活跃 runner 数量
export function count() {
  return active.size
}

// #152：数量变化订阅，供 worker 重武装 idle 计时器
export function onChange(cb: (count: number) => void) {
  emitter.on("change", cb)
  return () => {
    emitter.off("change", cb)
  }
}

export * as SessionActivity from "./activity"
