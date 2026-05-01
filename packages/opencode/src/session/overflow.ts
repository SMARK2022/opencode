import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { SessionOverflowV1 } from "@opencode-ai/core/v1/session/overflow"
import type { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"

export function usable(input: { cfg: ConfigV1.Info; model: Provider.Model; outputTokenMax?: number }) {
  // 输出限额仍由 provider transform 解析，共享预算只消除输入缓冲与 TUI 的重复公式。
  return SessionOverflowV1.usable({
    context: input.model.limit.context,
    input: input.model.limit.input,
    output: ProviderTransform.maxOutputTokens(input.model, input.outputTokenMax),
    reserved: input.cfg.compaction?.reserved,
  })
}

export function isOverflow(input: {
  cfg: ConfigV1.Info
  tokens: SessionV1.Assistant["tokens"]
  model: Provider.Model
  outputTokenMax?: number
}) {
  if (input.cfg.compaction?.auto === false) return false
  if (input.model.limit.context === 0) return false

  const count =
    input.tokens.total || input.tokens.input + input.tokens.output + input.tokens.cache.read + input.tokens.cache.write
  return count >= usable(input)
}
