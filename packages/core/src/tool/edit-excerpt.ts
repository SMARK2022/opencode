import { closestWindow } from "../patch-match"

export function closestMatch(content: string, expected: string) {
  // DP已完成候选选择和字符差异展示；重新截取等高窗口会丢失变长证据并重复输出requested。
  // 直接透传同一raw span的预算化excerpt，长行真正变化点仍由共享renderer保留。
  return closestWindow(content, expected)
}
