// 两代工具共用纯行尾算法，原有调用路径保持不变。
export {
  normalizeLineEndings,
  detectLineEnding,
  splitLines,
  convertToLineEnding,
} from "@opencode-ai/core/util/line-ending"
export type { LineEnding } from "@opencode-ai/core/util/line-ending"
