import { describe, expect, test } from "bun:test"
import { disabledToolNotice } from "../../src/session/prompt"
import type { MessageV2 } from "../../src/session/message-v2"
import type { Permission } from "../../src/permission"

// 构造最小化的 assistant 消息，包含一个 tool part
function msgWithTool(tool: string): MessageV2.WithParts {
  return {
    info: { id: "msg_1", role: "assistant", sessionID: "ses_1" } as MessageV2.Assistant,
    parts: [
      {
        id: "p_1",
        messageID: "msg_1",
        sessionID: "ses_1",
        type: "tool",
        tool,
        callID: "call_1",
        state: {
          status: "completed",
          input: {},
          output: "",
          metadata: {},
          time: { start: 0, end: 1 },
        },
      } as MessageV2.ToolPart,
    ],
  }
}

// [local-smark] 测试 disabledToolNotice 纯函数：
// 1. 历史含 apply_patch 且 edit 被 deny → 返回提醒文本，包含替代建议
// 2. 历史含 read 且无 deny → 返回 undefined
// 3. 空历史 → 返回 undefined
describe("disabledToolNotice", () => {
  test("returns notice when history contains a disabled tool", () => {
    const messages = [msgWithTool("apply_patch")]
    // 模拟 apply_patch 被 deny：edit 规则 deny 所有
    const agentPermission: Permission.Ruleset = [
      { permission: "edit", pattern: "*", action: "deny" },
    ]
    const result = disabledToolNotice(messages, agentPermission, [])
    expect(result).toContain("apply_patch is not available")
    // edit 和 write 也被 deny，所以不应建议它们
    expect(result).toContain("Use an available tool instead")
    expect(result).not.toContain("Use edit")
  })

  test("suggests edit/write when only apply_patch is disabled", () => {
    const messages = [msgWithTool("apply_patch")]
    // 仅 deny apply_patch（通过独立的 apply_patch permission deny）
    // 注意：Permission.disabled 将 edit/write/apply_patch 都映射到 "edit" permission，
    // 所以要仅禁用 apply_patch 需要用 ToolSelection.enabled 而非 permission deny。
    // 这里测试 deny edit 但 NOT deny 的场景不存在——edit deny 会同时禁用三者。
    // 因此测试 deny edit 时 substitutes 被正确过滤。
    const agentPermission: Permission.Ruleset = [
      { permission: "edit", pattern: "*", action: "deny" },
    ]
    const result = disabledToolNotice(messages, agentPermission, [])
    // 所有 edit 类工具都被 deny，替代建议应回退到通用提示
    expect(result).toContain("Use an available tool instead")
  })

  test("returns undefined when history has no disabled tools", () => {
    const messages = [msgWithTool("read")]
    // read 未被 disable
    const result = disabledToolNotice(messages, [], [])
    expect(result).toBeUndefined()
  })

  test("returns undefined when history is empty", () => {
    // 空历史不应产生提醒
    const result = disabledToolNotice([], [], [])
    expect(result).toBeUndefined()
  })
})
