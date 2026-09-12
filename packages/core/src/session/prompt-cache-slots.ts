type Entry = { sessionID: string; instance: { directory: string } | undefined }
type Slot<T extends Entry> = { generation: number; entry: T | undefined }

// 这里只拥有单槽登记/失效，不认识V1 proof或模型转换；Core删除owner无需反向导入应用模块。
const slots = new Set<Slot<Entry>>()

export function acquire<T extends Entry>(): Slot<T> {
  const slot: Slot<T> = { generation: 0, entry: undefined }
  slots.add(slot)
  return slot
}

export function release<T extends Entry>(slot: Slot<T>) {
  slots.delete(slot)
  slot.entry = undefined
}

export function lease<T extends Entry>(slot: Slot<T>) {
  return slot.generation
}

export function read<T extends Entry>(slot: Slot<T>, sessionID: string) {
  return slot.entry?.sessionID === sessionID ? slot.entry : undefined
}

export function publish<T extends Entry>(slot: Slot<T>, generation: number, entry: T) {
  if (slot.generation !== generation) return
  slot.entry = entry
}

export function invalidateSession(sessionID: string) {
  for (const slot of slots) {
    // 空槽也推进租约：在途计算尚未发布，不能据当前entry推断它将属于哪个Session。
    slot.generation++
    if (slot.entry?.sessionID === sessionID) slot.entry = undefined
  }
}

export function invalidateInstance(directory: string) {
  for (const slot of slots) {
    slot.generation++
    // 多张Service图可能有不同context对象，目录才是source实例生命周期的稳定身份。
    if (slot.entry?.instance?.directory === directory) slot.entry = undefined
  }
}

export * as PromptCacheSlots from "./prompt-cache-slots"
