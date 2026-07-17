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

function stepFinishPart(messageID: string, input: number, output = 0, cacheRead = 0, cacheWrite = 0) {
  return {
    id: `${messageID}-sf`,
    type: "step-finish" as const,
    reason: "stop",
    cost: 0,
    tokens: { input, output, reasoning: 0, cache: { read: cacheRead, write: cacheWrite } },
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

  test("keeps pure request input separate from cache-inclusive input", () => {
    const messages = [userMsg("pure-input-user"), assistantMsg("pure-input-assistant", "pure-input-user", 100)]
    const parts = {
      "pure-input-assistant": [stepFinishPart("pure-input-assistant", 100, 0, 20, 5)],
    }

    const acc = tokenAccounting(messages as never, (id) => parts[id as keyof typeof parts] ?? [], 200_000)

    // 纯 input 只锁定 provider 的 input 字段；cache-inclusive totalInput 仍保护实时上下文口径。
    // 100 是独立的 provider input literal，20/5 只作为 cache 干扰项，不从 production 结果反推期望值。
    // 这个断言因此能同时发现 pure 字段缺失和误把 cache 合并进永久 input 的回归。
    expect(acc.request.totalInputPure).toBe(100)
    expect(acc.request.totalInput).toBe(125)
  })

  test("scopes an explicit historical request away from the current streaming parent", () => {
    const messages = [
      userMsg("old-user"),
      assistantMsg("old-assistant", "old-user", 100, 200),
      userMsg("new-user"),
      assistantMsg("new-assistant", "new-user", 300, 900),
    ]
    const parts = {
      "old-assistant": [stepFinishPart("old-assistant", 100, 200)],
      "new-assistant": [stepFinishPart("new-assistant", 300, 900)],
    }

    const acc = tokenAccounting(
      messages as never,
      (id) => parts[id as keyof typeof parts] ?? [],
      200_000,
      "old-user",
    )

    // 旧 parent 的永久记录不能读取当前 latest parent 的流式/完成 output。
    // old/new 两个 parent 都有 confirmed output，测试观察的是 request selection 而不是字符串或调用次数。
    // 200 与 900 的差异直接对应 Session 中两个可达 assistant parent 的归属边界。
    expect(acc.request.totalOutput).toBe(200)
  })

  test("uses pure input from an explicit historical message-token fallback", () => {
    const messages = [
      userMsg("legacy-user"),
      {
        ...assistantMsg("legacy-assistant", "legacy-user", 77, 11),
        tokens: { input: 77, output: 11, reasoning: 3, cache: { read: 8, write: 2 } },
      },
      userMsg("current-user"),
      assistantMsg("current-assistant", "current-user", 300, 900),
    ]
    const parts = {
      "legacy-assistant": [],
      "current-assistant": [stepFinishPart("current-assistant", 300, 900)],
    }

    const acc = tokenAccounting(
      messages as never,
      (id) => parts[id as keyof typeof parts] ?? [],
      200_000,
      "legacy-user",
    )

    // 旧持久化 message 没有 step-finish 时，显式历史 request 仍必须保留纯 input。
    // cache read/write 仍存在于 fixture，证明 fallback 不能通过 totalInput 间接冒充 pure input。
    // output+reasoning 继续沿用旧 message.tokens 兼容契约，避免只修 input 而丢掉历史 cost 语义。
    expect(acc.request.totalInputPure).toBe(77)
    expect(acc.request.totalOutput).toBe(14)
  })
})
