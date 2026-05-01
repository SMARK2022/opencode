export * as SessionOverflowV1 from "./overflow"

const COMPACTION_BUFFER = 20_000
const COMPACTION_BUFFER_MIN = 5_000

// 只共享 V1 的数值契约，不加载 provider 服务；TUI 与 runtime 必须使用同一预算来源。
export function usable(input: { context: number; input?: number; output: number; reserved?: number }) {
  if (input.context === 0) return 0
  // 未提供输入上限时仍按有效输出预留，reserved 只属于显式 input 分支。
  if (!input.input) return Math.max(0, input.context - input.output)
  // catalog 已预留的 context-input 只抵消默认缓冲，不能从 usable 再扣一次。
  const providerReserve = Math.max(0, input.context - input.input)
  // 即使输出很小或 provider reserve 很大，也保留下一轮输入增长的最低余量。
  const reserved = input.reserved ?? Math.max(COMPACTION_BUFFER_MIN, COMPACTION_BUFFER - providerReserve)
  // 显式 reserved=0 仍有效；超大预留只归零，不产生负的可用输入。
  return Math.max(0, input.input - reserved)
}
