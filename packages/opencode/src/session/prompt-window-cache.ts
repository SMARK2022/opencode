import type { ModelMessage } from "ai"
import type { InstanceContext } from "@/project/instance-context"
import type { MessageV2 } from "./message-v2"
import type { MessageID, SessionID } from "./schema"
import { PromptCacheSlots } from "@opencode-ai/core/session/prompt-cache-slots"

interface Entry {
  sessionID: SessionID
  model: string
  proof: MessageV2.PromptWindowProof
  canonical: MessageV2.WithParts[]
  chunks: Map<MessageID, ModelMessage[]>
  instance: InstanceContext | undefined
}

// 具体proof/canonical/chunks仍由V1拥有；底层仅登记生命周期，不增加另一套历史或转换缓存。
export const acquire = () => PromptCacheSlots.acquire<Entry>()
export const release = PromptCacheSlots.release<Entry>
export const lease = PromptCacheSlots.lease<Entry>
export const read = PromptCacheSlots.read<Entry>
export const publish = PromptCacheSlots.publish<Entry>
export const invalidateSession = PromptCacheSlots.invalidateSession
export const invalidateInstance = PromptCacheSlots.invalidateInstance

export * as PromptWindowCache from "./prompt-window-cache"
