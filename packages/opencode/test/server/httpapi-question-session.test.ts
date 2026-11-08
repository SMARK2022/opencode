import { NodeServices } from "@effect/platform-node"
import { describe, expect } from "bun:test"
import { Context, Effect, Fiber, Layer, Scope } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { layerWebSocketConstructorGlobal } from "effect/unstable/socket/Socket"
import { InstanceRef } from "../../src/effect/instance-ref"
import { InstanceStore } from "../../src/project/instance-store"
import { Question } from "../../src/question"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { Session } from "../../src/session/session"
import { SessionID } from "../../src/session/schema"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdirScoped } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"

// 每个用例都重建数据库与实例生命周期，防止 pending Deferred 或 InstanceState 跨测试泄漏。
const testStateLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    yield* Effect.promise(() => resetDatabase())
    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        await disposeAllInstances()
        await resetDatabase()
      }),
    )
  }),
)

const it = testEffect(Layer.mergeAll(testStateLayer, NodeServices.layer, layerWebSocketConstructorGlobal))
const handlerContext = Context.empty() as Context.Context<unknown>

// HTTP 与直接服务调用共享同一 MemoMap，测试观察的是 daemon 中真实的 pending，而不是另一份 fixture。
function withHarness<A, E, R>(use: (input: {
  directory: string
  request: (path: string, init?: RequestInit) => Effect.Effect<Response>
  run: <T, E2, R2>(effect: Effect.Effect<T, E2, R2>) => Effect.Effect<T, E2, R2>
}) => Effect.Effect<A, E, R>) {
  return Effect.gen(function* () {
    // 同一 MemoMap 同时供 typed HTTP 和直接服务调用使用，这是证明 daemon pending 身份一致的关键。
    const shared = HttpApiApp.createSharedServices()
    const app = yield* Layer.buildWithMemoMap(shared.layer, shared.memoMap, yield* Scope.Scope)
    const handler = HttpRouter.toWebHandler(HttpApiApp.createRoutes(undefined, undefined, shared), {
      disableLogger: true,
      memoMap: shared.memoMap,
    }).handler
    const directory = yield* tmpdirScoped({ git: true })
    const instance = yield* InstanceStore.Service.use((svc) => svc.load({ directory })).pipe(Effect.provide(app))
    // 直接服务调用只补 InstanceRef；其余服务由 harness 边界统一提供，避免泛型依赖被错误吞掉。
    const run = <T, E2, R2>(effect: Effect.Effect<T, E2, R2>) =>
      effect.pipe(Effect.provideService(InstanceRef, instance))
    // viewer header 刻意指向当前测试目录；Session-ID 路由必须在此基础上继续解析请求归属。
    const request = (path: string, init?: RequestInit) =>
      Effect.promise(() =>
        handler(
          new Request(`http://localhost${path}`, {
            ...init,
            headers: { "x-opencode-directory": directory, "content-type": "application/json", ...init?.headers },
          }),
          handlerContext,
        ),
      )
    return yield* use({ directory, request, run }).pipe(Effect.provide(app))
  })
}

describe("Session-scoped legacy question HttpApi", () => {
  // 列表验收同时覆盖 pending 产生、HTTP JSON 形状和服务端 reject 对原等待 fiber 的结算。
  it.live("lists pending questions by Session ID", () =>
    withHarness(({ request, run }) =>
      Effect.gen(function* () {
        const session = yield* run(Session.Service.use((svc) => svc.create({ title: "parent" })))
        const fiber = yield* run(
          Question.Service.use((svc) =>
            svc.ask({
              sessionID: session.id,
              questions: [{
                question: "Continue?",
                header: "Choice",
                options: [{ label: "Yes", description: "Continue" }],
              }],
            }),
          ).pipe(Effect.forkScoped),
        )
        const pending = yield* pollWithTimeout(
          run(Question.Service.use((svc) => svc.list())).pipe(
            Effect.map((rows) => rows.length === 1 ? rows : undefined),
          ),
          "question did not become pending",
        )

        // pending 就绪信号来自原服务，而不是猜测后台 fiber 已运行到 Map 写入点。
        // content-type 先排除声明缺失时落入 UI HTML fallback 的假 200，再检查领域 payload。
        const response = yield* request(`/question?sessionID=${session.id}`)
        if (!response.headers.get("content-type")?.includes("application/json")) {
          return yield* Effect.fail(new Error(`expected Session question JSON, got ${response.status} ${response.headers.get("content-type")}`))
        }
        expect(response.status).toBe(200)
        const body = yield* Effect.promise(() => response.json())
        expect(body).toHaveLength(1)
        expect(body[0]).toMatchObject({ id: pending[0].id, sessionID: session.id })
        // 同一 handler 不传 sessionID 时仍返回 App 依赖的全局 pending，scoped 替换没有形成行为分叉。
        const global = yield* request("/question")
        expect(global.status).toBe(200)
        expect(yield* Effect.promise(() => global.json())).toEqual(body)

        // 清理必须结算 ask fiber，不能只把列表删空而留下悬挂的等待方。
        yield* run(Question.Service.use((svc) => svc.reject(pending[0].id)))
        expect((yield* Fiber.await(fiber))._tag).toBe("Failure")
      }),
    ),
  )

  // reply 的核心不是路径能否匹配，而是错误 Session 是否绝对无法改变 pending。
  it.live("replies only when the request belongs to the identified Session", () =>
    withHarness(({ request, run }) =>
      Effect.gen(function* () {
        const session = yield* run(Session.Service.use((svc) => svc.create({ title: "parent" })))
        const other = yield* run(Session.Service.use((svc) => svc.create({ title: "other" })))
        const fiber = yield* run(
          Question.Service.use((svc) =>
            svc.ask({
              sessionID: session.id,
              questions: [{
                question: "Continue?",
                header: "Choice",
                options: [{ label: "Yes", description: "Continue" }],
              }],
            }),
          ).pipe(Effect.forkScoped),
        )
        const pending = yield* pollWithTimeout(
          run(Question.Service.use((svc) => svc.list())).pipe(
            Effect.map((rows) => rows.length === 1 ? rows : undefined),
          ),
          "question did not become pending",
        )
        const requestID = pending[0].id

        // 错配返回 404 后再次读取原服务，证明没有仅靠响应码掩盖实际回答。
        const mismatched = yield* request(`/question/session/${other.id}/${requestID}/reply`, {
          method: "POST",
          body: JSON.stringify({ answers: [["Yes"]] }),
        })
        expect(mismatched.status).toBe(404)
        expect(yield* run(Question.Service.use((svc) => svc.list()))).toHaveLength(1)

        // 正确身份必须让 HTTP 返回值与原 ask fiber 的 answers 同时成立。
        const correct = yield* request(`/question/session/${session.id}/${requestID}/reply`, {
          method: "POST",
          body: JSON.stringify({ answers: [["Yes"]] }),
        })
        expect(correct.status).toBe(200)
        expect(yield* Effect.promise(() => correct.json())).toBe(true)
        const exit = yield* Fiber.await(fiber)
        expect(exit._tag).toBe("Success")
        if (exit._tag === "Success") expect(exit.value).toEqual([["Yes"]])
      }),
    ),
  )

  // 缺失 Session 必须在读取 pending 前失败，并保持公开错误 schema。
  it.live("returns the declared NotFoundError for a missing Session", () =>
    withHarness(({ request }) =>
      Effect.gen(function* () {
        // 使用合法但从未创建的 SessionID，确保 404 来自领域存在性检查而不是路径/schema 解析失败。
        const missing = SessionID.make("ses_missing")
        // scoped list 应先验证 Session，再读取 Question.Service，因此不存在 ID 不会返回权威空数组。
        const response = yield* request(`/question?sessionID=${missing}`)
        expect(response.status).toBe(404)
        expect(response.headers.get("content-type")).toContain("application/json")
        // 错误体必须保持公开 ApiNotFoundError 形状，不能退化成 HTML fallback 或空响应。
        expect(yield* Effect.promise(() => response.json())).toMatchObject({
          name: "NotFoundError",
          data: { message: expect.stringContaining(missing) },
        })
      }),
    ),
  )

  // reject 与 reply 分开验证，避免只覆盖其中一条 mutation 路径而遗漏归属检查。
  it.live("rejects only when the request belongs to the identified Session", () =>
    withHarness(({ request, run }) =>
      Effect.gen(function* () {
        const session = yield* run(Session.Service.use((svc) => svc.create({ title: "parent" })))
        const other = yield* run(Session.Service.use((svc) => svc.create({ title: "other" })))
        const fiber = yield* run(
          Question.Service.use((svc) =>
            svc.ask({
              sessionID: session.id,
              questions: [{
                question: "Continue?",
                header: "Choice",
                options: [{ label: "Yes", description: "Continue" }],
              }],
            }),
          ).pipe(Effect.forkScoped),
        )
        const pending = yield* pollWithTimeout(
          run(Question.Service.use((svc) => svc.list())).pipe(
            Effect.map((rows) => rows.length === 1 ? rows : undefined),
          ),
          "question did not become pending",
        )
        const requestID = pending[0].id

        // 错配拒绝后 pending 必须仍然存在，且原 fiber 不能被提前唤醒。
        const mismatched = yield* request(`/question/session/${other.id}/${requestID}/reject`, { method: "POST" })
        expect(mismatched.status).toBe(404)
        expect(yield* run(Question.Service.use((svc) => svc.list()))).toHaveLength(1)

        // 正确拒绝最终以 Failure 结算原 ask，证明复用的是领域 reject 而非通用成功响应。
        const correct = yield* request(`/question/session/${session.id}/${requestID}/reject`, { method: "POST" })
        expect(correct.status).toBe(200)
        expect(yield* Effect.promise(() => correct.json())).toBe(true)
        expect((yield* Fiber.await(fiber))._tag).toBe("Failure")
      }),
    ),
  )
})
