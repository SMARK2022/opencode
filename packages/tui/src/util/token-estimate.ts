/**
 * token-estimate.ts — 纯工具函数
 *
 * 不做任何 token accounting 逻辑。只提供：
 * - estimateDataUrlInputTokens: data URL 的 token 估算（图片/PDF/文本）
 * - getContextLimit: 从 provider 列表查 model context limit
 * - UsageInfo: 消费端显示用的轻量类型
 */

import { TokenEstimate } from "../token/estimate"

/** 消费端（sidebar / prompt footer / subagent footer）显示用的轻量类型 */
export type UsageInfo = {
  input: number
  output: number
  totalInput: number
  totalOutput: number
  context: string | undefined
  cost: string | undefined
}

/** data URL 的 token 估算：图片按像素密度，PDF 按字节密度，其余按通用 tokenizer */
export function estimateDataUrlInputTokens(url: string, mime: string) {
  return TokenEstimate.estimateAttachment({ url, mime }).tokens
}

/** 从 provider 列表查 model 的 context window limit */
export function getContextLimit(
  provider: ReadonlyArray<{ id: string; models: Record<string, { limit: { context: number; input?: number; output: number } }> }>,
  providerID: string | undefined,
  modelID: string | undefined,
): number | undefined {
  if (!providerID || !modelID) return undefined
  return provider.find((item) => item.id === providerID)?.models[modelID]?.limit.context
}
