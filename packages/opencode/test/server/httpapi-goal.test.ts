import { afterEach, describe, expect } from "bun:test"
import { Effect } from "effect"
import { Server } from "../../src/server/server"
import { Session } from "@/session/session"
import { SessionPaths } from "../../src/server/routes/instance/httpapi/groups/session"
import { EventPaths } from "../../src/server/routes/instance/httpapi/groups/event"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { ModelID, ProviderID } from "@/provider/schema"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

// 复用 httpapi-session.test.ts / httpapi-schema-error-body.test.ts 的最小 harness：
// testEffect(Session.defaultLayer) 提供测试侧 Session.Service 用于建会话，
// Server.Default() 内部组装全部 HTTP handler 层（含 SessionGoal.Service）。
const it = testEffect(Session.defaultLayer)

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

// pathFor：把 :sessionID 占位符替换为真实 id，与 httpapi-session.test.ts 一致
function pathFor(path: string, params: Record<string, string>) {
  return Object.entries(params).reduce((result, [key, value]) => result.replace(`:${key}`, value), path)
}

function request(path: string, init?: RequestInit) {
  return Effect.promise(async () => Server.Default().app.request(path, init))
}

function responseJson(response: Response) {
  return Effect.promise(() => response.json())
}

function createSession() {
  return Session.Service.use((svc) => svc.create({}))
}

function observeGoalEvents(input: {
  directory: string
  sessionID: SessionID
  objective: string
  timeout: number
  stopOnFailure?: boolean
}) {
  return Effect.promise(async () => {
    // 使用公开 SSE 而不是注入 handler 私有依赖，验证客户端真实可见的 busy/error 合同；
    // 同一 directory header 确保订阅与 mutation 落在相同 Instance runtime。
    const headers = { "x-opencode-directory": input.directory }
    const stream = await Server.Default().app.request(EventPaths.event, { headers })
    if (!stream.body) throw new Error("missing event stream body")
    const reader = stream.body.getReader()
    await reader.read() // server.connected 确认订阅先于 mutation 就绪，避免丢失瞬时 busy/error。
    const response = await Server.Default().app.request(pathFor(SessionPaths.goal, { sessionID: input.sessionID }), {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ objective: input.objective }),
    })
    const statuses: string[] = []
    let failed = false
    // empty-session 用完整观察窗口证明 busy 缺席；non-empty 在 error 到达后即可结束，
    // 两种等待都以 server.connected 为 readiness，不用任意 sleep 猜测订阅时序。
    const deadline = Date.now() + input.timeout
    try {
      while (Date.now() < deadline && !(input.stopOnFailure && failed)) {
        const chunk = await Promise.race([
          reader.read(),
          new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), deadline - Date.now())),
        ])
        if (!chunk?.value) break
        for (const item of new TextDecoder().decode(chunk.value).split("\n\n")) {
          if (!item.startsWith("data: ")) continue
          const event = JSON.parse(item.slice(6))
          // 全局 Event stream 可能混有其他 test/runtime session；只收集目标 Session，
          // 避免并行测试的 busy/error 被误认成当前 Goal mutation 的结果。
          if (event.properties?.sessionID !== input.sessionID) continue
          if (event.type === "session.status") statuses.push(event.properties.status.type)
          if (event.type === "session.error") failed = true
        }
      }
    } finally {
      await reader.cancel()
    }
    return { response, statuses, failed }
  })
}

describe("session goal HttpApi", () => {
  // 以下四个用例验证核心修复：goal 校验失败时服务器必须把具体原因
  // 写入 wire 体 {name:"GoalError", data:{message}}，而不是空 BadRequest 体。
  // 修复前 body 为 {name:"BadRequest", data:{}}（data.message 为 undefined），用例失败。

  it.instance(
    "over-long objective returns 400 GoalError with the length reason",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const session = yield* createSession()
        const res = yield* request(pathFor(SessionPaths.goal, { sessionID: session.id }), {
          method: "POST",
          headers: { "x-opencode-directory": test.directory, "content-type": "application/json" },
          // 超过 MAX_OBJECTIVE_CHARS(6400) 的 objective 必须被拒
          body: JSON.stringify({ objective: "a".repeat(6401) }),
        })
        expect(res.status).toBe(400)
        const parsed = yield* responseJson(res)
        expect(parsed).toEqual({
          name: "GoalError",
          data: { message: "goal objective must be at most 6400 characters" },
        })
      }),
    { git: true, config: { formatter: false, lsp: false } },
    // 30s 超时：每个用例需 git-init + Server.Default() 首次 bootstrap，
    // 默认 5s 在冷启动（首个用例）时可能超时
    30000,
  )

  it.instance(
    "whitespace-only objective returns 400 GoalError with the empty reason",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const session = yield* createSession()
        const res = yield* request(pathFor(SessionPaths.goal, { sessionID: session.id }), {
          method: "POST",
          headers: { "x-opencode-directory": test.directory, "content-type": "application/json" },
          // 纯空白 objective trim 后为空，必须被拒
          body: JSON.stringify({ objective: "   " }),
        })
        expect(res.status).toBe(400)
        const parsed = yield* responseJson(res)
        expect(parsed).toEqual({
          name: "GoalError",
          data: { message: "goal objective must not be empty" },
        })
      }),
    { git: true, config: { formatter: false, lsp: false } },
    // 30s 超时：每个用例需 git-init + Server.Default() 首次 bootstrap，
    // 默认 5s 在冷启动（首个用例）时可能超时
    30000,
  )

  it.instance(
    "non-positive tokenBudget returns 400 GoalError with the budget reason",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const session = yield* createSession()
        const res = yield* request(pathFor(SessionPaths.goal, { sessionID: session.id }), {
          method: "POST",
          headers: { "x-opencode-directory": test.directory, "content-type": "application/json" },
          // 0 budget 非法：只有正数或 null（清除）合法
          body: JSON.stringify({ objective: "ok", tokenBudget: 0 }),
        })
        expect(res.status).toBe(400)
        const parsed = yield* responseJson(res)
        expect(parsed).toEqual({
          name: "GoalError",
          data: { message: "goal token budget must be positive when provided" },
        })
      }),
    { git: true, config: { formatter: false, lsp: false } },
    // 30s 超时：每个用例需 git-init + Server.Default() 首次 bootstrap，
    // 默认 5s 在冷启动（首个用例）时可能超时
    30000,
  )

  it.instance(
    "status-only update with no existing goal returns 400 GoalError with the no-goal reason",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const session = yield* createSession()
        const res = yield* request(pathFor(SessionPaths.goal, { sessionID: session.id }), {
          method: "POST",
          headers: { "x-opencode-directory": test.directory, "content-type": "application/json" },
          // 没有 goal 时仅传 status 不能创建，必须报错
          body: JSON.stringify({ status: "paused" }),
        })
        expect(res.status).toBe(400)
        const parsed = yield* responseJson(res)
        expect(parsed).toEqual({
          name: "GoalError",
          data: { message: "cannot update goal for session: no goal exists" },
        })
      }),
    { git: true, config: { formatter: false, lsp: false } },
    // 30s 超时：每个用例需 git-init + Server.Default() 首次 bootstrap，
    // 默认 5s 在冷启动（首个用例）时可能超时
    30000,
  )

  it.instance(
    "valid objective creates an active goal (happy path regression guard)",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const session = yield* createSession()
        const res = yield* request(pathFor(SessionPaths.goal, { sessionID: session.id }), {
          method: "POST",
          headers: { "x-opencode-directory": test.directory, "content-type": "application/json" },
          body: JSON.stringify({ objective: "ship the feature" }),
        })
        expect(res.status).toBe(200)
        const parsed = yield* responseJson(res)
        // 正常创建：默认 active，usage 归零
        expect(parsed.goal).toMatchObject({
          objective: "ship the feature",
          status: "active",
          tokensUsed: 0,
        })
      }),
    { git: true, config: { formatter: false, lsp: false } },
    // 30s 超时：每个用例需 git-init + Server.Default() 首次 bootstrap，
    // 默认 5s 在冷启动（首个用例）时可能超时
    30000,
  )

  it.instance(
    "active goal on an empty Session does not start the prompt loop",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const session = yield* createSession()
        const result = yield* observeGoalEvents({
          directory: test.directory,
          sessionID: session.id,
          objective: "wait for the first prompt",
          timeout: 500,
        })
        expect(result.response.status).toBe(200)

        // 空 Session 没有可执行的 user Message，启动 loop 只会制造 busy/defect 噪声。
        expect(result.statuses).not.toContain("busy")
      }),
    { git: true, config: { formatter: false, lsp: false } },
    30000,
  )

  it.instance(
    "active goal with user history starts the loop and exposes background failure",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const sessions = yield* Session.Service
        const session = yield* sessions.create({})
        const user = yield* sessions.updateMessage({
          id: MessageID.ascending(),
          role: "user",
          sessionID: session.id,
          agent: "build",
          model: { providerID: ProviderID.make("missing"), modelID: ModelID.make("missing") },
          time: { created: Date.now() },
        })
        yield* sessions.updatePart({
          id: PartID.ascending(),
          messageID: user.id,
          sessionID: session.id,
          type: "text",
          text: "resume this Goal",
        })

        const result = yield* observeGoalEvents({
          directory: test.directory,
          sessionID: session.id,
          objective: "resume with observability",
          timeout: 1_000,
          stopOnFailure: true,
        })

        expect(result.response.status).toBe(200)
        expect(result.statuses).toContain("busy")
        // mutation 已提交后 loop failure 走既有 Session error event，而不是 catch-and-ignore。
        expect(result.failed).toBe(true)
      }),
    { git: true, config: { formatter: false, lsp: false } },
    30000,
  )

  it.instance(
    "goal set on missing session returns 404 NotFoundError (regression guard)",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        // 不存在的 session：requireSession 走 ApiNotFoundError(404) 路径，
        // 必须保证 GoalError 改动不影响 not-found 分支
        const missing = SessionID.descending()
        const res = yield* request(pathFor(SessionPaths.goal, { sessionID: missing }), {
          method: "POST",
          headers: { "x-opencode-directory": test.directory, "content-type": "application/json" },
          body: JSON.stringify({ objective: "x" }),
        })
        expect(res.status).toBe(404)
        const parsed = yield* responseJson(res)
      expect(parsed).toEqual({
          name: "NotFoundError",
          data: { message: `Session not found: ${missing}` },
        })
      }),
    { git: true, config: { formatter: false, lsp: false } },
    30000,
  )

  // [local-smark] continueOnError HTTP 契约测试：验证 boolean 透传、保留和拒绝
  it.instance(
    "POST with continueOnError true creates goal and GET returns true",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const session = yield* createSession()
        // 创建时显式开启错误续跑
        const res = yield* request(pathFor(SessionPaths.goal, { sessionID: session.id }), {
          method: "POST",
          headers: { "x-opencode-directory": test.directory, "content-type": "application/json" },
          body: JSON.stringify({ objective: "test", continueOnError: true }),
        })
        expect(res.status).toBe(200)
        const parsed = yield* responseJson(res)
        expect(parsed.goal.continueOnError).toBe(true)

        // GET 也返回 true
        const getRes = yield* request(pathFor(SessionPaths.goal, { sessionID: session.id }), {
          headers: { "x-opencode-directory": test.directory },
        })
        const getParsed = yield* responseJson(getRes)
        expect(getParsed.goal.continueOnError).toBe(true)
      }),
    { git: true, config: { formatter: false, lsp: false } },
    30000,
  )

  it.instance(
    "POST continueOnError update preserves objective and status",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const session = yield* createSession()
        // 先创建带 objective 的 goal
        yield* request(pathFor(SessionPaths.goal, { sessionID: session.id }), {
          method: "POST",
          headers: { "x-opencode-directory": test.directory, "content-type": "application/json" },
          body: JSON.stringify({ objective: "original" }),
        })
        // 只更新 continueOnError，objective 必须保留
        const res = yield* request(pathFor(SessionPaths.goal, { sessionID: session.id }), {
          method: "POST",
          headers: { "x-opencode-directory": test.directory, "content-type": "application/json" },
          body: JSON.stringify({ continueOnError: true }),
        })
        expect(res.status).toBe(200)
        const parsed = yield* responseJson(res)
        expect(parsed.goal.continueOnError).toBe(true)
        expect(parsed.goal.objective).toBe("original")
        expect(parsed.goal.status).toBe("active")
      }),
    { git: true, config: { formatter: false, lsp: false } },
    30000,
  )

  it.instance(
    "POST without continueOnError preserves existing value",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const session = yield* createSession()
        // 创建时开启
        yield* request(pathFor(SessionPaths.goal, { sessionID: session.id }), {
          method: "POST",
          headers: { "x-opencode-directory": test.directory, "content-type": "application/json" },
          body: JSON.stringify({ objective: "test", continueOnError: true }),
        })
        // 更新 objective 不传 continueOnError，策略必须保留
        const res = yield* request(pathFor(SessionPaths.goal, { sessionID: session.id }), {
          method: "POST",
          headers: { "x-opencode-directory": test.directory, "content-type": "application/json" },
          body: JSON.stringify({ objective: "updated" }),
        })
        const parsed = yield* responseJson(res)
        expect(parsed.goal.continueOnError).toBe(true)
        expect(parsed.goal.objective).toBe("updated")
      }),
    { git: true, config: { formatter: false, lsp: false } },
    30000,
  )

  it.instance(
    "POST with non-boolean continueOnError is rejected by schema",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const session = yield* createSession()
        // 字符串 "true" 不是合法 boolean，schema 必须拒绝
        const res = yield* request(pathFor(SessionPaths.goal, { sessionID: session.id }), {
          method: "POST",
          headers: { "x-opencode-directory": test.directory, "content-type": "application/json" },
          body: JSON.stringify({ objective: "test", continueOnError: "true" }),
        })
        expect(res.status).toBe(400)
      }),
    { git: true, config: { formatter: false, lsp: false } },
    30000,
  )
})
