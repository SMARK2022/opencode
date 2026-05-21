import { describe, expect, test } from "bun:test"
import { sessionMessageContentWidth, SESSION_SIDEBAR_WIDTH } from "../../../src/routes/session/layout"

// #184：与 tip index 主列 paddingLeft=2 paddingRight=1、scrollbar paddingRight 0/1 对齐
// #184：纯函数锁定 docked/overlay 与滚动条组合
describe("sessionMessageContentWidth (#184)", () => {
  test("does not subtract sidebar when overlay (narrow)", () => {
    // #184：窄屏侧栏 overlay，消息区应保留全宽扣 chrome
    const w = sessionMessageContentWidth({ terminalWidth: 80, sidebarInLayout: false, scrollbarEnabled: false })
    expect(w).toBe(80 - 3 - 3)
  })

  test("subtracts docked sidebar on wide layout", () => {
    // #184：宽屏 docked 侧栏必须计入
    const w = sessionMessageContentWidth({ terminalWidth: 160, sidebarInLayout: true, scrollbarEnabled: false })
    expect(w).toBe(160 - SESSION_SIDEBAR_WIDTH - 3 - 3)
  })

  test("subtracts scrollbar gutter when enabled", () => {
    // #184：滚动条开启再扣 tip 双层 paddingRight 合计 2
    const w = sessionMessageContentWidth({ terminalWidth: 160, sidebarInLayout: true, scrollbarEnabled: true })
    expect(w).toBe(160 - SESSION_SIDEBAR_WIDTH - 3 - 3 - 2)
  })
})
