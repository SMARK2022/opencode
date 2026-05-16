import { EventEmitter } from "events"

const emitter = new EventEmitter()
const active = new Set<string>()

export function begin(id: string) {
  active.add(id)
  emitter.emit("change", active.size)

  let done = false
  return () => {
    if (done) return
    done = true
    active.delete(id)
    emitter.emit("change", active.size)
  }
}

export function count() {
  return active.size
}

export function onChange(cb: (count: number) => void) {
  emitter.on("change", cb)
  return () => {
    emitter.off("change", cb)
  }
}

export * as SessionActivity from "./activity"
