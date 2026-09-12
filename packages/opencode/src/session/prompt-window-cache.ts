import type { ModelMessage } from "ai"
import type { InstanceContext } from "@/project/instance-context"
import type { MessageV2 } from "./message-v2"
import type { MessageID, SessionID } from "./schema"

// 单槽 current-entry 的归属与失效：每个 SessionPrompt Service 注册一个槽，
// 槽内仍是现有 proof/canonical/chunks，不扩成按 Session/Project 的 Map。
// Session 删除（projector after-commit）与 Instance dispose/reload 完成后失效槽内对象，
// Service 的长生命周期不再延长已结束 Session/Instance 的生存期。
interface Entry {
  sessionID: SessionID
  model: string
  proof: MessageV2.PromptWindowProof
  canonical: MessageV2.WithParts[]
  chunks: Map<MessageID, ModelMessage[]>
  instance: InstanceContext | undefined
}

interface Slot {
  // generation 是 publication lease：失效即推进，在途旧 lease 的 publish 直接丢弃。
  // 无论槽内是否已有 entry 都必须推进——在途计算的发布目标此时还不知道是哪个 Session。
  generation: number
  entry: Entry | undefined
}

// 注册表是进程级的：同一进程可能存在多张 Service 图（TCP listener 与 AppRuntime），
// 删除失效必须覆盖全部图；槽随 Service finalizer 注销，注册表自身不累积。
const slots = new Set<Slot>()

export function acquire(): Slot {
  const slot: Slot = { generation: 0, entry: undefined }
  slots.add(slot)
  return slot
}

export function release(slot: Slot) {
  slots.delete(slot)
  slot.entry = undefined
}

export function lease(slot: Slot) {
  return slot.generation
}

export function read(slot: Slot, sessionID: SessionID) {
  // 只按 sessionID 命中；boundary/proof 比较是调用方的既有 admission 职责，这里不复制第二套。
  return slot.entry?.sessionID === sessionID ? slot.entry : undefined
}

export function publish(slot: Slot, generation: number, entry: Entry) {
  if (slot.generation !== generation) return
  slot.entry = entry
}

export function invalidateSession(sessionID: SessionID) {
  for (const slot of slots) {
    slot.generation++
    if (slot.entry?.sessionID === sessionID) slot.entry = undefined
  }
}

export function invalidateInstance(directory: string) {
  // 按 directory 判定而不按 InstanceContext 对象身份：测试/工具链可能并存多张
  // InstanceStore 图，同一目录的 ctx 对象不保证唯一；目录才是实例生命周期的稳定标识。
  for (const slot of slots) {
    slot.generation++
    if (slot.entry?.instance?.directory === directory) slot.entry = undefined
  }
}

export * as PromptWindowCache from "./prompt-window-cache"
