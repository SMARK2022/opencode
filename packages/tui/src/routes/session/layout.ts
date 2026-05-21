// #184：常量按 tip Session 主列/滚动条实测 chrome 校准
// #184：会话消息可读宽度的唯一公式，避免终端估值漂移
export const SESSION_SIDEBAR_WIDTH = 42

// #184：tip 主列 paddingLeft2+paddingRight1=3
const SESSION_MAIN_HORIZONTAL_PADDING = 3
// #184：消息 TextPart paddingLeft=3；tip 无 v1.17.x 左边框，按现布局实测重推导
const SESSION_MESSAGE_LEFT_CHROME = 3
// #184：tip viewport+content 各 paddingRight 1，合计 gutter 2
const SESSION_SCROLLBAR_GUTTER = 2

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
