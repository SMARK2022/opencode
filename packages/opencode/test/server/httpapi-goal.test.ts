import { afterEach, describe, expect } from "bun:test"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { Config, Effect, Layer, Queue, Stream } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse, HttpRouter, HttpServer } from "effect/unstable/http"
import { layerWebSocketConstructorGlobal } from "effect/unstable/socket/Socket"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { InstanceBootstrap as InstanceBootstrapService } from "../../src/project/bootstrap-service"
import { InstanceStore } from "../../src/project/instance-store"
import { Project } from "../../src/project/project"
import { Workspace } from "../../src/control-plane/workspace"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { SessionPaths } from "../../src/server/routes/instance/httpapi/groups/session"
import { EventPaths } from "../../src/server/routes/instance/httpapi/groups/event"
import { Session } from "@/session/session"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
// 复用 httpapi-session.test.ts 的 harness：appLayer 提供测试侧 Session.Service 建会话，
// HttpApiApp.routes 组装全部 HTTP handler 层（含 SessionGoal.Service），
// HttpClient 请求走 NodeHttpServer.layerTest 内存服务器。
const noopBootstrapLayer = Layer.succeed(
  InstanceBootstrapService.Service,
  InstanceBootstrapService.Service.of({ run: Effect.void }),
)
const appLayer = AppNodeBuilder.build(
  LayerNode.group([InstanceStore.node, Project.node, Session.node, Workspace.node, Database.node, Ripgrep.node]),
  [[InstanceStore.bootstrapNode, noopBootstrapLayer]],
)
const servedRoutes: Layer.Layer<never, Config.ConfigError, HttpServer.HttpServer> = HttpRouter.serve(
  HttpApiApp.routes,
  {
    disableListenLog: true,
    disableLogger: true,
  },
)
const httpApiLayer = servedRoutes.pipe(
  Layer.provide(layerWebSocketConstructorGlobal),
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provideMerge(NodeServices.layer),
)
const it = testEffect(Layer.mergeAll(appLayer, httpApiLayer))

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

// pathFor：把 :sessionID 占位符替换为真实 id，与 httpapi-session.test.ts 一致
function pathFor(path: string, params: Record<string, string>) {
  return Object.entries(params).reduce((result, [key, value]) => result.replace(`:${key}`, value), path)
}
function request(path: string, init?: RequestInit) {
  const url = new URL(path, "http://localhost")
  return HttpClientRequest.fromWeb(new Request(url, init)).pipe(
    HttpClientRequest.setUrl(url.pathname),
    HttpClient.execute,
  )
}
function responseJson(response: HttpClientResponse.HttpClientResponse) {
  return response.json
}

function createSession() {
  return Session.use.create({})
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
        // response.json 的类型含 null 联合——先断言非空再取 goal，锁定 wire 契约
        expect(parsed).not.toBeNull()
        const goalBody = parsed as { goal: { objective: string; status: string; tokensUsed: number } }
        // 正常创建：默认 active，usage 归零
        expect(goalBody.goal).toMatchObject({
          objective: "ship the feature",
          status: "active",
          tokensUsed: 0,
          generation: 1,
          reason: null,
        })
        // 通过真实HTTP解码/转发/响应检查reason，领域单测不能代替wire往返。
        const url = pathFor(SessionPaths.goal, { sessionID: session.id })
        const headers = { "x-opencode-directory": test.directory, "content-type": "application/json" }
        const rejected = yield* request(url, { method: "POST", headers, body: JSON.stringify({ status: "complete" }) })
        expect(rejected.status).toBe(400)
        expect(yield* responseJson(rejected)).toEqual({ name: "GoalError", data: { message: "Marking the goal as complete requires a non-empty reason." } })
        const completed = yield* request(url, { method: "POST", headers, body: JSON.stringify({ status: "complete", reason: " Verified end state " }) })
        expect(completed.status).toBe(200)
        expect(yield* responseJson(completed)).toMatchObject({ goal: { status: "complete", generation: 1, reason: "Verified end state" } })
        const fetched = yield* request(url, { headers })
        expect(yield* responseJson(fetched)).toMatchObject({ goal: { status: "complete", reason: "Verified end state" } })
        const resumed = yield* request(url, { method: "POST", headers, body: JSON.stringify({ status: "active" }) })
        expect(resumed.status).toBe(200)
        expect(yield* responseJson(resumed)).toMatchObject({ goal: { status: "active", generation: 1, reason: null } })
      }),
    { git: true, config: { formatter: false, lsp: false } },
    // 30s 超时：每个用例需 git-init + Server.Default() 首次 bootstrap，
    // 默认 5s 在冷启动（首个用例）时可能超时
    30000,
  )

  // 空 Session 没有可执行的 user Message；active Goal 必须等待首条真实 prompt，
  // handler fork loop 只会制造 busy/defect 噪声。用 status endpoint 观察而非注入私有依赖。
  it.instance(
    "active goal on an empty Session does not start the prompt loop",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const session = yield* createSession()
        const res = yield* request(pathFor(SessionPaths.goal, { sessionID: session.id }), {
          method: "POST",
          headers: { "x-opencode-directory": test.directory, "content-type": "application/json" },
          body: JSON.stringify({ objective: "wait for the first prompt" }),
        })
        expect(res.status).toBe(200)
        // 等待一个调度窗口：若 loop 被错误启动，status 会进入 busy
        yield* Effect.sleep(500)
        const statusRes = yield* request(pathFor(SessionPaths.status, {}), {
          headers: { "x-opencode-directory": test.directory },
        })
        expect(statusRes.status).toBe(200)
        const statuses = (yield* responseJson(statusRes)) as Record<string, { type: string }>
        expect(statuses[session.id]?.type).not.toBe("busy")
      }),
    { git: true, config: { formatter: false, lsp: false } },
    30000,
  )

  // [local-smark] 0642：全撤后的 goal 恢复——loop 必须消费 revert 边界后保持 idle，不派发也不报错。
  it.instance(
    "goal resume after reverting all history stays idle and applies the revert",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const sessions = yield* Session.Service
        const session = yield* sessions.create({ title: "full revert resume" })
        const user = yield* sessions.updateMessage({
          id: MessageID.ascending(),
          role: "user",
          sessionID: session.id,
          agent: "build",
          model: { providerID: ProviderV2.ID.make("missing"), modelID: ModelV2.ID.make("missing") },
          time: { created: Date.now() },
        })
        yield* sessions.updatePart({ id: PartID.ascending(), messageID: user.id, sessionID: session.id, type: "text", text: "withdrawn request" })
        // 用公开撤回端点留下边界；不直接写 hidden，才能验证 HTTP 恢复接线确实执行清理。
        const reverted = yield* request(pathFor(SessionPaths.revert, { sessionID: session.id }), {
          method: "POST",
          headers: { "x-opencode-directory": test.directory, "content-type": "application/json" },
          body: JSON.stringify({ messageID: user.id }),
        })
        expect(reverted.status).toBe(200)
        expect((yield* sessions.get(session.id)).revert?.messageID).toBe(user.id)
        // 订阅先连接再提交 goal mutation；观察窗口只检查空恢复本身，不依赖模型响应速度。
        const eventRes = yield* request(pathFor(EventPaths.event, {}), {
          headers: { "x-opencode-directory": test.directory },
        })
        expect(eventRes.status).toBe(200)
        const eventQueue = yield* Queue.unbounded<Uint8Array>()
        yield* eventRes.stream.pipe(
          Stream.runForEach((value) => Queue.offer(eventQueue, value)),
          Effect.forkScoped,
        )
        const decoder = new TextDecoder()
        const res = yield* request(pathFor(SessionPaths.goal, { sessionID: session.id }), {
          method: "POST",
          headers: { "x-opencode-directory": test.directory, "content-type": "application/json" },
          body: JSON.stringify({ objective: "await new input" }),
        })
        expect(res.status).toBe(200)
        // 全撤之后没有可派发的历史：goalSet 只在存在可见 user 时 fork loop，
        // loop 入口的 cleanupRevert 清理后也不得报 Provider 错误或创建空运行。
        let sawBusy = false
        for (let i = 0; i < 10 && !sawBusy; i++) {
          const statusRes = yield* request(pathFor(SessionPaths.status, {}), {
            headers: { "x-opencode-directory": test.directory },
          })
          const statuses = (yield* responseJson(statusRes)) as Record<string, { type: string }>
          sawBusy = statuses[session.id]?.type === "busy"
          if (!sawBusy) yield* Effect.sleep(100)
        }
        expect(sawBusy).toBe(false)
        // goal.updated 等事件可以到达，但不得出现 session error 事件。
        let sawErrorEvent = false
        for (let i = 0; i < 20; i++) {
          const chunk = yield* Queue.take(eventQueue).pipe(Effect.timeoutOption("500 millis"))
          if (chunk._tag === "None") break
          const text = decoder.decode(chunk.value)
          if (text.includes("session.error") || text.includes('"type":"error"')) sawErrorEvent = true
        }
        expect(sawErrorEvent).toBe(false)
        expect(yield* sessions.messages({ sessionID: session.id })).toEqual([])
        expect((yield* sessions.get(session.id)).revert).toBeUndefined()
        const body = yield* responseJson(res)
        expect((body as { goal?: { status?: string } }).goal?.status).toBe("active")
      }),
    { git: true, config: { formatter: false, lsp: false } },
    30_000,
  )

  // 有 user history 时 active mutation 启动后台 loop（missing provider 会在模型解析处失败）。
  // mutation 已提交后 loop failure 走既有 Session error event，而不是 catch-and-ignore；
  // busy 的出现证明 fork 真正启动，未被空守卫拦截。
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
          model: { providerID: ProviderV2.ID.make("missing"), modelID: ModelV2.ID.make("missing") },
          time: { created: Date.now() },
        })
        yield* sessions.updatePart({
          id: PartID.ascending(),
          messageID: user.id,
          sessionID: session.id,
          type: "text",
          text: "resume this Goal",
        })

        // [local-smark] 先订阅 SSE 事件流：后台 loop failure 必须以 session error event 可观测，
        // 不得 catch-and-ignore（busy 只证明 fork 启动；error event 证明失败未被吞掉）
        const eventRes = yield* request(pathFor(EventPaths.event, {}), {
          headers: { "x-opencode-directory": test.directory },
        })
        expect(eventRes.status).toBe(200)
        const eventQueue = yield* Queue.unbounded<Uint8Array>()
        yield* eventRes.stream.pipe(
          Stream.runForEach((value) => Queue.offer(eventQueue, value)),
          Effect.forkScoped,
        )
        const decoder = new TextDecoder()
        const res = yield* request(pathFor(SessionPaths.goal, { sessionID: session.id }), {
          method: "POST",
          headers: { "x-opencode-directory": test.directory, "content-type": "application/json" },
          body: JSON.stringify({ objective: "resume with observability" }),
        })
        expect(res.status).toBe(200)

        let sawBusy = false
        for (let i = 0; i < 20 && !sawBusy; i++) {
          const statusRes = yield* request(pathFor(SessionPaths.status, {}), {
            headers: { "x-opencode-directory": test.directory },
          })
          const statuses = (yield* responseJson(statusRes)) as Record<string, { type: string }>
          sawBusy = statuses[session.id]?.type === "busy"
          if (!sawBusy) yield* Effect.sleep(100)
        }
        expect(sawBusy).toBe(true)
        // [local-smark] 从 SSE 流读取后台 loop 的 session error event（source 合同）
        let sawErrorEvent = false
        for (let i = 0; i < 100 && !sawErrorEvent; i++) {
          const chunk = yield* Queue.take(eventQueue).pipe(Effect.timeoutOption("20 seconds"))
          if (chunk._tag === "None") break
          const text = decoder.decode(chunk.value)
          if (text.includes("session.error") || text.includes("\"type\":\"error\"")) sawErrorEvent = true
        }
        expect(sawErrorEvent).toBe(true)
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
    // 30s 超时：每个用例需 git-init + Server.Default() 首次 bootstrap，
    // 默认 5s 在冷启动（首个用例）时可能超时
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
        expect((parsed as { goal?: { continueOnError?: boolean } }).goal?.continueOnError).toBe(true)

        // GET 也返回 true
        const getRes = yield* request(pathFor(SessionPaths.goal, { sessionID: session.id }), {
          headers: { "x-opencode-directory": test.directory },
        })
        const getParsed = yield* responseJson(getRes)
        expect((getParsed as { goal?: { continueOnError?: boolean } }).goal?.continueOnError).toBe(true)
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
        expect((parsed as { goal?: { continueOnError?: boolean } }).goal?.continueOnError).toBe(true)
        expect((parsed as { goal?: { objective?: string } }).goal?.objective).toBe("original")
        expect((parsed as { goal?: { status?: string } }).goal?.status).toBe("active")
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
        expect((parsed as { goal?: { continueOnError?: boolean } }).goal?.continueOnError).toBe(true)
        expect((parsed as { goal?: { objective?: string } }).goal?.objective).toBe("updated")
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
