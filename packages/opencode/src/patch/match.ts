// 共享成功域与诊断评分，避免两代工具在相同旧块上产生分裂结果。
export { closestWindow, lineOffset, locateExact, nextLineOffset } from "@opencode-ai/core/patch-match"
export type { ClosestWindow, ExactLocation, ExactResult } from "@opencode-ai/core/patch-match"
