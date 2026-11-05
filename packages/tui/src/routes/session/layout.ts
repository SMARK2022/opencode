// #184：常量按 tip Session 主列/滚动条实测 chrome 校准
// #184：会话消息可读宽度的唯一公式，避免终端估值漂移
export const SESSION_SIDEBAR_WIDTH = 42

// #184：tip 主列 paddingLeft2+paddingRight1=3
const SESSION_MAIN_HORIZONTAL_PADDING = 3
// 消息左边框占 1 列，TextPart 与推理内容再内缩 3 列；共享预算必须计入恢复的外框。
const SESSION_MESSAGE_LEFT_CHROME = 4
// viewport/content各留一列，原生vertical track作为横向兄弟另占一列。
const SESSION_SCROLLBAR_GUTTER = 3

export const sessionMessageContentWidth = (input: {
  terminalWidth: number
  sidebarInLayout: boolean
  scrollbarEnabled: boolean
}) => {
  // #184：overlay 侧栏不扣宽；仅 docked 时减 SIDEBAR
  const sidebar = input.sidebarInLayout ? SESSION_SIDEBAR_WIDTH : 0
  const scroll = input.scrollbarEnabled ? SESSION_SCROLLBAR_GUTTER : 0
  // #184：至少 1 列，防止 Yoga 负数
  return Math.max(
    1,
    input.terminalWidth - sidebar - SESSION_MAIN_HORIZONTAL_PADDING - SESSION_MESSAGE_LEFT_CHROME - scroll,
  )
}
