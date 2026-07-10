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

  test("completed partial search stays visible when details off", () => {
    // #244：partial 搜索豁免隐藏——details 关闭时 part 可见性是
    // 「结果可能不完整」的唯一信号，不得被 details 开关吞掉
    expect(
      isVisibleAssistantPart(
        { type: "tool", tool: "glob", state: { status: "completed", metadata: { partial: true } } },
        { showDetails: false, showThinking: true },
      ),
    ).toBe(true)
    expect(
      isVisibleAssistantPart(
        { type: "tool", tool: "grep", state: { status: "completed", metadata: { partial: true } } },
        { showDetails: false, showThinking: true },
      ),
    ).toBe(true)
    // 同形状但无 partial 标记：维持 #185 隐藏语义，豁免不扩大化
    expect(isVisibleAssistantPart(
      { type: "tool", tool: "glob", state: { status: "completed", structured: { files: [], partial: true } } },
      { showDetails: false, showThinking: true },
    )).toBe(true)
    expect(
      isVisibleAssistantPart(
        { type: "tool", tool: "glob", state: { status: "completed", metadata: {} } },
        { showDetails: false, showThinking: true },
      ),
    ).toBe(false)
    // 非 glob/grep 工具不享受豁免
    expect(
      isVisibleAssistantPart(
        { type: "tool", tool: "bash", state: { status: "completed", metadata: { partial: true } } },
        { showDetails: false, showThinking: true },
      ),
    ).toBe(false)
  })
})
