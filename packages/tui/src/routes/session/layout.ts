export const SESSION_SIDEBAR_WIDTH = 42

// Keep this aligned with the fixed horizontal chrome in Session's scrollbox
// tree. This is the readable content column exposed as ctx.width, so wider
// regions such as diff views use the same conservative wrapping threshold.
const SESSION_MAIN_HORIZONTAL_PADDING = 4
const SESSION_MESSAGE_LEFT_CHROME = 4
const SESSION_SCROLLBAR_GUTTER = 2

export function sessionMessageContentWidth(input: {
  terminalWidth: number
  sidebarInLayout: boolean
  scrollbarEnabled: boolean
}) {
  return Math.max(
    1,
    input.terminalWidth -
      (input.sidebarInLayout ? SESSION_SIDEBAR_WIDTH : 0) -
      SESSION_MAIN_HORIZONTAL_PADDING -
      SESSION_MESSAGE_LEFT_CHROME -
      (input.scrollbarEnabled ? SESSION_SCROLLBAR_GUTTER : 0),
  )
}
