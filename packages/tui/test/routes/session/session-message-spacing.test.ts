import { describe, expect, test } from "bun:test"
import { isVisibleAssistantPart } from "../../../src/routes/session/index"

// #185：首个可见 part 选择逻辑（隐藏 completed tool / 空 text）
describe("assistant visible parts (#185)", () => {
  test("empty text is not visible", () => {
    // #185：空 text 不抢首距
    expect(isVisibleAssistantPart({ type: "text", text: "  " }, { showDetails: true, showThinking: true })).toBe(false)
  })

  test("completed tool hidden when details off", () => {
    // #185：tool_details 关闭时 completed 工具不可见
    expect(
      isVisibleAssistantPart({ type: "tool", state: { status: "completed" } }, { showDetails: false, showThinking: true }),
    ).toBe(false)
  })

  test("completed tool visible when details on", () => {
    // #185：详情开启时 completed 工具可见
    expect(
      isVisibleAssistantPart({ type: "tool", state: { status: "completed" } }, { showDetails: true, showThinking: true }),
    ).toBe(true)
  })
})
