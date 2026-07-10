import { afterEach, describe, expect } from "bun:test"
import { Effect } from "effect"
import { Server } from "../../src/server/server"
import { Session } from "@/session/session"
import { SessionPaths } from "../../src/server/routes/instance/httpapi/groups/session"
import { SessionID } from "@/session/schema"
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
