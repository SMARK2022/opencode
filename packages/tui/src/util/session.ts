// #113：与 packages/opencode/src/session/title.ts 同构默认标题判定
// TUI 包不直接依赖 opencode 源路径，因此在此保持同一前缀/ISO 正则
const parentTitlePrefix = "New session - "
const childTitlePrefix = "Child session - "

// #113：终端标题栏：仍为默认标题时显示 OpenCode 而非会话名
export function isDefaultTitle(title: string) {
  return new RegExp(
    `^(${parentTitlePrefix}|${childTitlePrefix})\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$`,
  ).test(title)
}
