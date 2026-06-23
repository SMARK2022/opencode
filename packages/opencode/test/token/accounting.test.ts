import { describe, expect, test } from "bun:test"
import { tokenAccounting } from "@/token/accounting"

// 构造最小化的 tokenAccounting 输入：只填该函数实际读取的字段，避免与 SDK Message
// schema 耦合。tokenAccounting 的 Msg 类型是内部窄类型，测试通过结构匹配传入。
function userMsg(id: string) {
  return { id, role: "user" as const }
}

function assistantMsg(id: string, parentID: string, input: number, output = 0) {
  return {
    id,
    role: "assistant" as const,
    parentID,
    tokens: { input, output, reasoning: 0, cache: { read: 0, write: 0 } },
    // time.completed 存在表示该 assistant 已终态，stepConfirmed 据此判定
    time: { created: Number(id), completed: Number(id) + 1 },
  }
}

function stepFinishPart(messageID: string, input: number, output = 0) {
  return {
    id: `${messageID}-sf`,
    type: "step-finish" as const,
    reason: "stop",
    cost: 0,
    tokens: { input, output, reasoning: 0, cache: { read: 0, write: 0 } },
  }
}

describe("tokenAccounting", () => {
  test("accumulates request totals across continuation steps even with a trailing orphan user", () => {
    // orphan user4 无 assistant 子节点（模拟 TaskTool 后台注入 noReply prompt 在父会话
    // busy 期间持久化的 user message）。活跃请求是 u1 的两个续轮 assistant(a1+a2)。
    // 修复前 lastUser=user4 → requestAssistantIDs 为空 → confirmedRequest 归零 →
    // request.totalInput 为 0；修复后 lastUser=user1 → requestAssistantIDs={a1,a2}
    // → confirmedRequest 累计 → request.totalInput 正确反映整个请求的累计 input。
    const messages = [
      userMsg("1"),
      assistantMsg("2", "1", 1_000),
      assistantMsg("3", "1", 2_000),
      userMsg("4"), // queued orphan：无 assistant 子节点
    ]
    const parts: Record<string, ReturnType<typeof stepFinishPart>[]> = {
      "2": [stepFinishPart("2", 1_000)],
      "3": [stepFinishPart("3", 2_000)],
    }

    const acc = tokenAccounting(
      messages as never,
      (id) => parts[id] ?? [],
      200_000,
    )

    // request.totalInput 应累计 a1(1000)+a2(2000) 的 confirmed input，而非 0
    expect(acc.request.totalInput).toBe(3_000)
    // session 级累计遍历所有 assistant，不受 lastUser 选择影响（回归保护）
    expect(acc.session.input).toBe(3_000)
  })
})
