import { expect } from "bun:test"
import { Effect } from "effect"
import { Session } from "@/session/session"
import { MessageID, PartID } from "@/session/schema"
import { ModelID, ProviderID } from "@/provider/schema"
import { Server } from "@/server/server"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(Session.defaultLayer)

it.instance("TUI accounting returns only same-Session off-page facts and preserves step order", () => Effect.gen(function* () {
  const test = yield* TestInstance
  const sessions = yield* Session.Service
  const session = yield* sessions.create({})
  const other = yield* sessions.create({})
  // 两个 Session 共用 Project，防止测试仅因不同目录或 Project 过滤而碰巧隔离成功。
  const user = yield* sessions.updateMessage({
    id: MessageID.ascending(), sessionID: session.id, role: "user", agent: "build", time: { created: 1 },
    model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test") },
  })
  const ids: MessageID[] = []
  for (const [index, cost] of [0.1, 0.2, 0.3].entries()) {
    // 这些浮点字面量刻意不满足加法结合律，能够发现把历史费用重新分组的回归。
    const message = yield* sessions.updateMessage({
      id: MessageID.ascending(), sessionID: session.id, role: "assistant", parentID: user.id,
      modelID: ModelID.make("test"), providerID: ProviderID.make("test"), agent: "build", mode: "build",
      path: { cwd: test.directory, root: test.directory }, time: { created: index + 2, completed: index + 3 }, cost,
      tokens: { input: 11, output: 3, reasoning: 2, cache: { read: 5, write: 7 } },
    })
    ids.push(message.id)
    yield* sessions.updatePart({
      id: PartID.ascending(), sessionID: session.id, messageID: message.id, type: "step-finish", reason: "stop", cost,
      tokens: message.tokens,
    })
  }
  const read = (sessionID: string) => Effect.promise(async () => Server.Default().app.fetch(new Request("http://localhost/tui/accounting", {
    method: "POST", headers: { "content-type": "application/json", "x-opencode-directory": test.directory },
    body: JSON.stringify({ sessionID, requestIDs: [user.id], visibleMessageIDs: [ids[2]] }),
  })))
  const response = yield* read(session.id)
  expect(response.status).toBe(200)
  expect(response.headers.get("content-type")).toContain("application/json")
  // 第三个 Assistant 已在页内，服务端不得把它算进页外基线后再由 TUI 重复累计。
  // 页外只含前两个 step；cost 从原 step 顺序产生，后续可从该基线继续累加可见 step。
  expect(yield* Effect.promise(() => response.json())).toEqual({
    [user.id]: { input: 46, inputPure: 22, output: 10, cost: 0.30000000000000004 },
  })
  const foreign = yield* read(other.id)
  // 即使 caller 传入另一个 Session 的有效 request ID，也不能跨 Session 读取用量。
  expect(foreign.status).toBe(200)
  expect(yield* Effect.promise(() => foreign.json())).toEqual({})
}))
