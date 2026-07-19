import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { afterEach, describe, expect } from "bun:test"
import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { Cause, Config, Context, Deferred, Effect, Exit, Fiber, Layer, Scope } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse, HttpRouter, HttpServer } from "effect/unstable/http"
import { layerWebSocketConstructorGlobal } from "effect/unstable/socket/Socket"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
// #497：ownership 用例经 filterCompactedEffect 读取公共持久化投影。
import { MessageV2 } from "@/session/message-v2"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { LocationServiceMap } from "@opencode-ai/core/location-services"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { registerAdapter } from "../../src/control-plane/adapters"
import type { WorkspaceAdapter } from "../../src/control-plane/types"
import { Workspace } from "../../src/control-plane/workspace"

import { InstanceBootstrap as InstanceBootstrapService } from "../../src/project/bootstrap-service"
import { InstanceStore } from "../../src/project/instance-store"
import { Project } from "../../src/project/project"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import * as HttpSessionError from "../../src/server/routes/instance/httpapi/handlers/session-errors"
import { ExperimentalPaths } from "../../src/server/routes/instance/httpapi/groups/experimental"
import { SessionPaths } from "../../src/server/routes/instance/httpapi/groups/session"
import { Session } from "@/session/session"
import { SessionRunState } from "../../src/session/run-state"
import { AppLayer } from "../../src/effect/app-runtime"
import { MessageID, PartID, SessionID, type SessionID as SessionIDType } from "../../src/session/schema"
import { Database } from "@opencode-ai/core/database/database"
import { SessionRequestUsage } from "@opencode-ai/core/session/request-usage"
import { SessionInputTable, SessionMessageTable, SessionTable } from "@opencode-ai/core/session/sql"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import * as DateTime from "effect/DateTime"
import { eq } from "drizzle-orm"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, provideInstanceEffect, TestInstance, tmpdirScoped } from "../fixture/fixture"
import { TestLLMServer } from "../lib/llm-server"
import { testProviderConfig } from "../lib/test-provider"
import { awaitWithTimeout, pollWithTimeout, testEffect } from "../lib/effect"

const originalWorkspaces = Flag.OPENCODE_EXPERIMENTAL_WORKSPACES
const noopBootstrapLayer = Layer.succeed(
  InstanceBootstrapService.Service,
  InstanceBootstrapService.Service.of({ run: Effect.void }),
)
const appLayer = AppNodeBuilder.build(
  // 种子写入与 HttpApi app 都依赖同一个全局 Database 节点，不另建请求级账本层。
  LayerNode.group([InstanceStore.node, Project.node, Session.node, Workspace.node, Database.node, Ripgrep.node, SessionRequestUsage.node]),
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

function pathFor(path: string, params: Record<string, string>) {
  return Object.entries(params).reduce((result, [key, value]) => result.replace(`:${key}`, value), path)
}

function createSession(input?: Session.CreateInput) {
  return Session.use.create(input)
}

function createTextMessage(sessionID: SessionIDType, text: string) {
  return Effect.gen(function* () {
    const svc = yield* Session.Service
    const info = yield* svc.updateMessage({
      id: MessageID.ascending(),
      role: "user",
      sessionID,
      agent: "build",
      model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test") },
      time: { created: Date.now() },
    })
    const part = yield* svc.updatePart({
      id: PartID.ascending(),
      sessionID,
      messageID: info.id,
      type: "text",
      text,
    })
    return { info, part }
  })
}

const localAdapter = (directory: string): WorkspaceAdapter => ({
  name: "Local Test",
  description: "Create a local test workspace",
  configure: (info) => ({ ...info, name: "local-test", directory }),
  create: async () => {
    await mkdir(directory, { recursive: true })
  },
  async remove() {},
  target: () => ({ type: "local" as const, directory }),
})

const createLocalWorkspace = (input: { projectID: Project.Info["id"]; type: string; directory: string }) =>
  Effect.acquireRelease(
    Effect.gen(function* () {
      registerAdapter(input.projectID, input.type, localAdapter(input.directory))
      return yield* Workspace.Service.use((svc) =>
        svc.create({
          type: input.type,
          branch: null,
          extra: null,
          projectID: input.projectID,
        }),
      )
    }),
    (info) => Workspace.use.remove(info.id).pipe(Effect.ignore),
  )

const insertLegacyAssistantMessage = (sessionID: SessionIDType, seq = 1, time = seq) =>
  Effect.gen(function* () {
    const message = SessionMessage.Assistant.make({
      id: SessionMessage.ID.create(),
      type: "assistant",
      agent: "build",
      model: {
        id: ModelV2.ID.make("model"),
        providerID: ProviderV2.ID.make("provider"),
        variant: ModelV2.VariantID.make("default"),
      },
      time: { created: DateTime.makeUnsafe(time) },
      content: [],
    })
    const { db } = yield* Database.Service
    yield* db
      .insert(SessionMessageTable)
      .values([
        {
          id: message.id,
          session_id: sessionID,
          type: message.type,
          seq,
          time_created: time,
          data: {
            time: { created: time },
            agent: message.agent,
            model: message.model,
            content: message.content,
          } as NonNullable<(typeof SessionMessageTable.$inferInsert)["data"]>,
        },
      ])
      .run()
      .pipe(Effect.orDie)
    return message
  })

const insertCorruptV2Message = (sessionID: SessionIDType, time = 1) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(SessionMessageTable)
      .values([
        {
          id: SessionMessage.ID.create(),
          session_id: sessionID,
          type: "assistant",
          seq: time,
          time_created: time,
          data: {} as NonNullable<(typeof SessionMessageTable.$inferInsert)["data"]>,
        },
      ])
      .run()
      .pipe(Effect.orDie)
  })

const setLegacySummaryDiff = (sessionID: SessionIDType) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .update(SessionTable)
      .set({
        summary_additions: 1,
        summary_deletions: 0,
        summary_files: 1,
        summary_diffs: [{ additions: 1, deletions: 0 }],
      })
      .where(eq(SessionTable.id, sessionID))
      .run()
      .pipe(Effect.orDie)
  })

const getWorkspaceID = (sessionID: SessionIDType) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    return yield* db
      .select({ workspaceID: SessionTable.workspace_id })
      .from(SessionTable)
      .where(eq(SessionTable.id, sessionID))
      .get()
      .pipe(Effect.orDie)
  })

const clearSessionPath = (sessionID: SessionIDType) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db.update(SessionTable).set({ path: null }).where(eq(SessionTable.id, sessionID)).run().pipe(Effect.orDie)
  })

function request(path: string, init?: RequestInit) {
  const url = new URL(path, "http://localhost")
  return HttpClientRequest.fromWeb(new Request(url, init)).pipe(
    HttpClientRequest.setUrl(url.pathname),
    HttpClient.execute,
  )
}

function json<T>(response: HttpClientResponse.HttpClientResponse) {
  if (response.status !== 200) return response.text.pipe(Effect.flatMap((text) => Effect.die(new Error(text))))
  return response.json.pipe(Effect.map((value) => value as T))
}

function responseJson(response: HttpClientResponse.HttpClientResponse) {
  return response.json
}

function requestJson<T>(path: string, init?: RequestInit) {
  return request(path, init).pipe(Effect.flatMap(json<T>))
}

afterEach(async () => {
  Flag.OPENCODE_EXPERIMENTAL_WORKSPACES = originalWorkspaces
  await disposeAllInstances()
  await resetDatabase()
})

describe("session HttpApi", () => {
  // 原 it 会启动 HTTP 路由；此用例只构建生产服务，验证跨入口取消而不监听端口。
  testEffect(appLayer).instance(
    "shares session ownership and cancels V1 runs across service contexts",
    () =>
      Effect.gen(function* () {
        const shared = HttpApiApp.createSharedServices()
        const scope = yield* Scope.Scope
        const firstScope = yield* Scope.fork(scope)
        const secondScope = yield* Scope.fork(scope)
        const runtimeScope = yield* Scope.fork(scope)
        const first = yield* Layer.buildWithMemoMap(shared.layer, shared.memoMap, firstScope)
        const second = yield* Layer.buildWithMemoMap(shared.layer, shared.memoMap, secondScope)
        const runtime = yield* Layer.buildWithMemoMap(AppLayer, shared.memoMap, runtimeScope)

        const firstRunState = Context.get(first, SessionRunState.Service)
        const secondRunState = Context.get(second, SessionRunState.Service)
        expect(secondRunState).toBe(firstRunState)
        expect(Context.get(second, SessionExecution.Service)).toBe(Context.get(first, SessionExecution.Service))
        expect(Context.get(second, LocationServiceMap.Service)).toBe(Context.get(first, LocationServiceMap.Service))
        expect(Context.get(second, Database.Service)).toBe(Context.get(first, Database.Service))
        expect(Context.get(runtime, SessionRunState.Service)).toBe(firstRunState)
        expect(Context.get(runtime, InstanceStore.Service)).toBe(Context.get(first, InstanceStore.Service))
        const configuration = yield* Effect.promise(() => import("../../src/config/config"))
        expect(Context.get(runtime, configuration.Config.Service)).toBe(Context.get(first, configuration.Config.Service))

        // 直接调用无端口 handler，确认共享服务不会把第二棵路由或 CORS 缓存为第一棵。
        const handlers = ["https://first.test", "https://second.test"].map(origin => ({
          origin, web: HttpRouter.toWebHandler(HttpApiApp.createRoutes({ cors: [origin] }, undefined, shared), { disableLogger: true }),
        }))
        yield* Effect.addFinalizer(() => Effect.promise(() => Promise.all(handlers.map(entry => entry.web.dispose()))))
        for (const entry of handlers) {
          const response = yield* Effect.promise(() => entry.web.handler(new Request("http://localhost/global/health", { headers: { origin: entry.origin } }), HttpApiApp.context))
          expect(response.status).toBe(200)
          expect(response.headers.get("access-control-allow-origin")).toBe(entry.origin)
        }
        // 共享层使用独立内存库，项目也须由同一服务上下文登记后再创建会话。
        const instance = yield* TestInstance
        yield* Context.get(first, Project.Service).fromDirectory(instance.directory)
        const session = yield* createSession().pipe(Effect.provide(first))
        const message = yield* createTextMessage(session.id, "shared run").pipe(Effect.provide(first))
        const other = yield* tmpdirScoped({ git: true }).pipe(Effect.provide(AppNodeBuilder.build(CrossSpawnSpawner.node)))
        yield* Effect.acquireUseRelease(
          firstRunState.beginRevert(session.id).pipe(Effect.provide(first)),
          () => Effect.gen(function* () {
            // 请求目录不同仍同步拒绝；若守卫放在fork内则会错误返回204。
            const response = yield* Effect.promise(() => handlers[0]!.web.handler(new Request(
              `http://localhost${pathFor(SessionPaths.promptAsync, { sessionID: session.id })}?directory=${encodeURIComponent(other)}`,
              { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ noReply: true, parts: [{ type: "text", text: "must not be admitted" }] }) },
            ), HttpApiApp.context))
            expect(response.status).toBe(400)
            expect(yield* Context.get(first, Session.Service).messages({ sessionID: session.id }).pipe(Effect.provide(first))).toHaveLength(1)
          }),
          () => firstRunState.endRevert(session.id).pipe(Effect.provide(first)),
        )

        const interrupted = { info: message.info, parts: [message.part] }
        const ready = yield* Deferred.make<void>()
        const fiber = yield* firstRunState
          .ensureRunning(
            session.id,
            Effect.succeed(interrupted),
            Deferred.succeed(ready, undefined).pipe(Effect.andThen(Effect.never)),
          )
          .pipe(Effect.provide(first), Effect.forkScoped)

        yield* awaitWithTimeout(Deferred.await(ready), "shared V1 run never became ready")
        yield* awaitWithTimeout(
          secondRunState.cancel(session.id).pipe(Effect.provide(second)),
          "cross-context V1 cancellation did not finish",
        )
        const exit = yield* awaitWithTimeout(Fiber.await(fiber), "shared V1 run did not complete after cancellation")
        expect(exit).toEqual(Exit.succeed(interrupted))
      }),
  )

  it.effect("maps busy sessions to public session busy errors", () =>
    Effect.gen(function* () {
      const sessionID = SessionID.descending()
      const exit = yield* HttpSessionError.mapBusy(Effect.fail(new Session.BusyError({ sessionID }))).pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(Cause.squash(exit.cause)).toMatchObject({
          _tag: "SessionBusyError",
          sessionID,
          message: `Session is busy: ${sessionID}`,
        })
      }
    }),
  )

  it.instance(
    "serves request usage query codecs, wire values and missing request errors",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-opencode-directory": test.directory }
        const info = yield* createSession({ title: "request usage wire" })
        const session = yield* Session.Service
        const usage = yield* SessionRequestUsage.Service
        // 用户身份经正常消息 owner 持久化；账本创建时间可独立验证 epoch 零游标。
        const root = yield* createTextMessage(info.id, "root")
        const shell = yield* createTextMessage(info.id, "shell")
        const other = yield* createTextMessage(info.id, "other root")
        const newer = yield* createTextMessage(info.id, "newer")
        const model = { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test"), variant: "small" }
        const base = { sessionID: info.id, rootRequestID: root.info.id, agent: "build", ...model }
        // 同根不同来源、同来源不同根和较新输入分别隔离三个过滤条件的漏传。
        yield* usage.begin({ ...base, requestID: root.info.id, source: "prompt", timeCreated: 0 })
        yield* usage.begin({ ...base, requestID: shell.info.id, source: "shell", variant: undefined, timeCreated: 0 })
        yield* usage.begin({ ...base, requestID: other.info.id, rootRequestID: other.info.id, source: "prompt", timeCreated: 0 })
        yield* usage.begin({ ...base, requestID: newer.info.id, source: "prompt", timeCreated: 2 })

        // V1 账本从持久化 step-finish 读取费用，只有助手 info.cost 不能替代这条结算。
        // 不传原生 usage 快照，确保 HTTP 测试确实经过现有 V1 parts 适配边界。
        const tokens = { input: 5, output: 3, reasoning: 2, cache: { read: 1, write: 0 }, total: 11 }
        const assistant = yield* session.updateMessage({
          id: MessageID.ascending(), role: "assistant", sessionID: info.id,
          parentID: root.info.id, mode: "build", agent: "build",
          path: { cwd: test.directory, root: test.directory },
          ...model, cost: 1.25, tokens,
          time: { created: 0, completed: 0 }, finish: "stop",
        })
        // completed=0 必须编码为已完成；真实时钟仅影响 updated，不需要全局时钟替身。
        yield* session.updatePart({
          id: PartID.ascending(), messageID: assistant.id, sessionID: info.id,
          type: "step-finish", reason: "stop", cost: 1.25, tokens,
        })
        yield* usage.recordAssistant({ sessionID: info.id, requestID: root.info.id, assistant })

        // 独立美元常量是 oracle，不复写整数微美元换算或账本求和算法。
        const wire = {
          sessionID: info.id, requestID: root.info.id, rootRequestID: root.info.id,
          status: "completed", model, tokens, cost: 1.25,
          time: { created: 0, updated: expect.any(Number), completed: 0 },
        }
        const url = `/session/${info.id}/request_usage`
        const expected = { ...wire, source: "prompt", agent: "build", assistantCount: 1, stepCount: 1 }
        expect(yield* requestJson<unknown>(`${url}/${root.info.id}`, { headers })).toEqual(expected)
        // 明细身份是 assistantMessageID；精确形状也拒绝扁平模型、时间或 costMicros wire。
        expect(yield* requestJson<unknown>(`${url}/${root.info.id}/assistant`, { headers })).toEqual([
          { ...wire, assistantMessageID: assistant.id, stepCount: 1 },
        ])

        // 复用被 source 过滤排除的 shell 行，不新增请求改变既有分页和联合过滤 oracle。
        const zero = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 }, total: 0 }
        const running = yield* session.updateMessage({
          id: MessageID.ascending(), role: "assistant", sessionID: info.id,
          parentID: shell.info.id, mode: "build", agent: "build",
          path: { cwd: test.directory, root: test.directory },
          providerID: model.providerID, modelID: model.modelID, cost: 0, tokens: zero,
          time: { created: 0 },
        })
        yield* usage.recordAssistant({ sessionID: info.id, requestID: shell.info.id, assistant: running })
        // 精确 JSON 对象不列可选键，variant/completed/error 输出 null 也必须失败。
        const runningWire = {
          ...wire, requestID: shell.info.id, status: "running",
          model: { providerID: model.providerID, modelID: model.modelID }, tokens: zero, cost: 0,
          time: { created: 0, updated: expect.any(Number) },
        }
        const runningRequest = { ...runningWire, source: "shell", agent: "build", assistantCount: 1, stepCount: 0 }
        expect(yield* requestJson<unknown>(`${url}/${shell.info.id}`, { headers })).toEqual(runningRequest)
        expect(yield* requestJson<unknown>(`${url}?source=shell`, { headers })).toEqual([runningRequest])
        // 明细也经真实 response codec；助手尚未完成不能编码为 completed:null。
        expect(yield* requestJson<unknown>(`${url}/${shell.info.id}/assistant`, { headers })).toEqual([
          { ...runningWire, assistantMessageID: running.id, stepCount: 0 },
        ])

        expect(
          (yield* requestJson<Array<{ requestID: string }>>(`${url}?limit=1`, { headers })).map((row) => row.requestID),
        ).toEqual([newer.info.id])
        // URL 的数字文本必须被解码；before=0 严格排除创建时间恰为零的已有行。
        expect(yield* requestJson<unknown[]>(`${url}?limit=2&before=0`, { headers })).toEqual([])
        // limit=0 也属于显式输入，不能退回默认一百条。
        expect(yield* requestJson<unknown[]>(`${url}?limit=0`, { headers })).toEqual([])
        // 负整数保留不限量语义：同根两条都应返回，不能钳制为一条或拒绝为负数。
        expect(
          (yield* requestJson<Array<{ requestID: string }>>(`${url}?limit=-1&source=prompt&rootRequestID=${root.info.id}`, { headers })).map((row) => row.requestID),
        ).toEqual([newer.info.id, root.info.id])
        // 每个排除行只违反一个条件，不能靠单一 source/root/before 条件碰巧通过。
        expect(yield* requestJson<unknown[]>(`${url}?limit=2&before=1&source=prompt&rootRequestID=${root.info.id}`, { headers })).toEqual([expected])
        // 整数限制仅属于 limit；before 的小数边界与安全整数上界仍须正常查询。
        expect(yield* requestJson<unknown[]>(`${url}?limit=2&before=1.5&source=prompt&rootRequestID=${root.info.id}`, { headers })).toEqual([expected])
        expect(yield* requestJson<unknown[]>(`${url}?limit=${Number.MAX_SAFE_INTEGER}&before=1.5&source=prompt&rootRequestID=${root.info.id}`, { headers })).toEqual([expected])

        // 数字 codec 拒绝不可转换文本，避免只测试服务方法而遗漏 HttpApi query 解码。
        expect((yield* request(`${url}?limit=bad`, { headers })).status).toBe(400)
        // 小数及正负安全整数溢出必须在 Query codec 拒绝，不能触发 SQLite defect 或静默取整。
        for (const limit of [1.5, Number.MAX_SAFE_INTEGER + 1, Number.MIN_SAFE_INTEGER - 1]) {
          const invalid = yield* request(`${url}?limit=${limit}`, { headers })
          expect(invalid.status).toBe(400)
          expect(yield* responseJson(invalid)).toMatchObject({
            name: "BadRequest", data: { kind: "Query", message: expect.stringContaining("limit") },
          })
        }
        // Session 已存在且 message ID 合法，404 必须来自缺失账本资源而非路由或 ID 校验。
        const missingID = MessageID.ascending()
        const missing = yield* request(`${url}/${missingID}`, { headers })
        expect(missing.status).toBe(404)
        expect(yield* responseJson(missing)).toEqual({
          name: "NotFoundError",
          data: { message: `Request usage not found: ${missingID}` },
        })
        // 明细与详情共享父请求存在性；旧空数组断言必须随0269的404契约一同更新。
        const missingAssistants = yield* request(`${url}/${missingID}/assistant`, { headers })
        expect(missingAssistants.status).toBe(404)
        expect(yield* responseJson(missingAssistants)).toEqual({
          name: "NotFoundError",
          data: { message: `Request usage not found: ${missingID}` },
        })
      }),
    { git: false, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "returns declared not found errors for read routes",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-opencode-directory": test.directory }
        const missingSession = SessionID.descending()
        const missingSessionBody = {
          name: "NotFoundError",
          data: { message: `Session not found: ${missingSession}` },
        }

        const get = yield* request(pathFor(SessionPaths.get, { sessionID: missingSession }), { headers })
        expect(get.status).toBe(404)
        expect(yield* responseJson(get)).toEqual(missingSessionBody)

        const children = yield* request(pathFor(SessionPaths.children, { sessionID: missingSession }), { headers })
        expect(children.status).toBe(404)
        expect(yield* responseJson(children)).toEqual(missingSessionBody)

        const todo = yield* request(pathFor(SessionPaths.todo, { sessionID: missingSession }), { headers })
        expect(todo.status).toBe(404)
        expect(yield* responseJson(todo)).toEqual(missingSessionBody)

        const messages = yield* request(pathFor(SessionPaths.messages, { sessionID: missingSession }), { headers })
        expect(messages.status).toBe(404)
        expect(yield* responseJson(messages)).toEqual(missingSessionBody)

        const remove = yield* request(pathFor(SessionPaths.remove, { sessionID: missingSession }), {
          headers,
          method: "DELETE",
        })
        expect(remove.status).toBe(404)
        expect(yield* responseJson(remove)).toEqual(missingSessionBody)

        const prompt = yield* request(pathFor(SessionPaths.prompt, { sessionID: missingSession }), {
          headers: { ...headers, "content-type": "application/json" },
          method: "POST",
          body: JSON.stringify({ agent: "build", noReply: true, parts: [{ type: "text", text: "hello" }] }),
        })
        expect(prompt.status).toBe(404)
        expect(yield* responseJson(prompt)).toEqual(missingSessionBody)

        const abort = yield* request(pathFor(SessionPaths.abort, { sessionID: missingSession }), {
          headers,
          method: "POST",
        })
        expect(abort.status).toBe(200)
        expect(yield* responseJson(abort)).toBe(true)

        const session = yield* createSession({ title: "missing message" })
        const missingMessage = MessageID.ascending()
        const message = yield* request(
          pathFor(SessionPaths.message, { sessionID: session.id, messageID: missingMessage }),
          { headers },
        )
        expect(message.status).toBe(404)
        expect(yield* responseJson(message)).toEqual({
          name: "NotFoundError",
          data: { message: `Message not found: ${missingMessage}` },
        })
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "serves read routes",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-opencode-directory": test.directory }
        const parent = yield* createSession({ title: "parent" })
        const child = yield* createSession({ title: "child", parentID: parent.id })
        const message = yield* createTextMessage(parent.id, "hello")
        yield* createTextMessage(parent.id, "world")

        const listed = yield* requestJson<Session.Info[]>(`${SessionPaths.list}?roots=true`, { headers })
        expect(listed.map((item) => item.id)).toContain(parent.id)
        expect(Object.hasOwn(listed[0]!, "parentID")).toBe(false)

        expect(yield* requestJson<Record<string, unknown>>(SessionPaths.status, { headers })).toEqual({})

        expect(
          yield* requestJson<Session.Info>(pathFor(SessionPaths.get, { sessionID: parent.id }), { headers }),
        ).toMatchObject({ id: parent.id, title: "parent" })

        expect(
          (yield* requestJson<Session.Info[]>(pathFor(SessionPaths.children, { sessionID: parent.id }), {
            headers,
          })).map((item) => item.id),
        ).toEqual([child.id])

        expect(
          yield* requestJson<unknown[]>(pathFor(SessionPaths.todo, { sessionID: parent.id }), { headers }),
        ).toEqual([])

        expect(
          yield* requestJson<unknown[]>(pathFor(SessionPaths.diff, { sessionID: parent.id }), { headers }),
        ).toEqual([])

        const messages = yield* request(`${pathFor(SessionPaths.messages, { sessionID: parent.id })}?limit=1`, {
          headers,
        })
        const messagePage = yield* json<SessionV1.WithParts[]>(messages)
        const nextCursor = messages.headers["x-next-cursor"]
        expect(nextCursor).toBeTruthy()
        expect(messagePage[0]?.parts[0]).toMatchObject({ type: "text" })

        expect(
          (yield* request(`${pathFor(SessionPaths.messages, { sessionID: parent.id })}?before=${nextCursor}`, {
            headers,
          })).status,
        ).toBe(400)
        expect(
          (yield* request(`${pathFor(SessionPaths.messages, { sessionID: parent.id })}?limit=1&before=invalid`, {
            headers,
          })).status,
        ).toBe(400)

        expect(
          yield* requestJson<SessionV1.WithParts>(
            pathFor(SessionPaths.message, { sessionID: parent.id, messageID: message.info.id }),
            { headers },
          ),
        ).toMatchObject({ info: { id: message.info.id } })

        yield* insertLegacyAssistantMessage(parent.id)

        expect(
          (yield* requestJson<{ data: SessionMessage.Message[] }>(`/api/session/${parent.id}/message`, {
            headers,
          })).data,
        ).toMatchObject([{ type: "assistant" }])
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.live("uses the persisted session directory for prompt requests", () =>
    Effect.gen(function* () {
      const llm = yield* TestLLMServer
      yield* llm.text("ok", { usage: { input: 1, output: 1 } })

      const config = testProviderConfig(llm.url)
      const sessionDirectory = yield* tmpdirScoped({ git: true, config })
      const requestDirectory = yield* tmpdirScoped({ git: true, config })
      const session = yield* createSession({ title: "directory regression" }).pipe(
        provideInstanceEffect(sessionDirectory),
      )

      const response = yield* request(
        `${pathFor(SessionPaths.prompt, { sessionID: session.id })}?directory=${encodeURIComponent(requestDirectory)}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            agent: "build",
            model: { providerID: "test", modelID: "test-model" },
            parts: [{ type: "text", text: "which directory?" }],
          }),
        },
      )

      expect(response.status).toBe(200)
      yield* responseJson(response)

      const messages = yield* Session.use
        .messages({ sessionID: session.id })
        .pipe(provideInstanceEffect(sessionDirectory), Effect.orDie)
      const assistant = messages.find((message) => message.info.role === "assistant")
      expect(assistant?.info.role === "assistant" ? assistant.info.path : undefined).toEqual({
        cwd: sessionDirectory,
        root: sessionDirectory,
      })
    }).pipe(Effect.provide(TestLLMServer.layer), Effect.provide(AppNodeBuilder.build(CrossSpawnSpawner.node))),
  )

  it.instance(
    "returns v2 public request errors for cursor and workspace query failures",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-opencode-directory": test.directory }
        const session = yield* createSession({ title: "v2 cursor" })
        const firstMessage = yield* insertLegacyAssistantMessage(session.id, 1, 2)
        const secondMessage = yield* insertLegacyAssistantMessage(session.id, 2, 1)

        const sessionPage = yield* request(
          `/api/session?${new URLSearchParams({
            limit: "1",
            order: "asc",
            directory: test.directory,
            search: "v2",
          })}`,
          { headers },
        )
        const sessionCursor = (yield* json<{ data: Session.Info[]; cursor: { next?: string } }>(sessionPage)).cursor
          .next
        expect(sessionCursor).toBeTruthy()
        expect(JSON.parse(Buffer.from(sessionCursor!, "base64url").toString("utf8"))).toMatchObject({
          order: "asc",
          directory: test.directory,
          search: "v2",
          anchor: { id: session.id, direction: "next" },
        })

        const sessionNextPage = yield* request(`/api/session?cursor=${sessionCursor}`, { headers })
        expect(sessionNextPage.status).toBe(200)

        const invalidSessionCursor = yield* request(`/api/session?cursor=invalid`, { headers })
        expect(invalidSessionCursor.status).toBe(400)
        expect(yield* responseJson(invalidSessionCursor)).toMatchObject({
          _tag: "InvalidCursorError",
          message: "Invalid cursor",
        })

        const invalidWorkspace = yield* request(`/api/session?workspace=bad`, { headers })
        expect(invalidWorkspace.status).toBe(400)
        expect(yield* responseJson(invalidWorkspace)).toMatchObject({
          _tag: "InvalidRequestError",
          kind: "Query",
        })

        const messagePage = yield* request(`/api/session/${session.id}/message?limit=1`, { headers })
        const messageBody = yield* json<{ data: SessionMessage.Message[]; cursor: { next?: string } }>(messagePage)
        const messageCursor = messageBody.cursor.next
        expect(messageCursor).toBeTruthy()
        expect(messageBody.data.map((message) => message.id)).toEqual([secondMessage.id])
        expect(JSON.parse(Buffer.from(messageCursor!, "base64url").toString("utf8"))).toEqual({
          id: secondMessage.id,
          order: "desc",
          direction: "next",
        })

        const nextMessagePage = yield* request(`/api/session/${session.id}/message?cursor=${messageCursor}`, {
          headers,
        })
        expect(
          (yield* json<{ data: SessionMessage.Message[] }>(nextMessagePage)).data.map((message) => message.id),
        ).toEqual([firstMessage.id])

        const legacyMessageCursor = Buffer.from(
          JSON.stringify({ id: secondMessage.id, time: 1, order: "desc", direction: "next" }),
        ).toString("base64url")
        const legacyMessagePage = yield* request(`/api/session/${session.id}/message?cursor=${legacyMessageCursor}`, {
          headers,
        })
        expect(
          (yield* json<{ data: SessionMessage.Message[] }>(legacyMessagePage)).data.map((message) => message.id),
        ).toEqual([firstMessage.id])

        const messageCursorWithOrder = yield* request(
          `/api/session/${session.id}/message?cursor=${messageCursor}&order=asc`,
          { headers },
        )
        expect(messageCursorWithOrder.status).toBe(400)
        expect(yield* responseJson(messageCursorWithOrder)).toMatchObject({
          _tag: "InvalidCursorError",
          message: "Cursor cannot be combined with order",
        })

        const invalidMessageCursor = yield* request(`/api/session/${session.id}/message?cursor=invalid`, { headers })
        expect(invalidMessageCursor.status).toBe(400)
        expect(yield* responseJson(invalidMessageCursor)).toMatchObject({
          _tag: "InvalidCursorError",
          message: "Invalid cursor",
        })
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "returns v2 public not found errors for missing sessions",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-opencode-directory": test.directory }
        const missing = SessionID.descending()
        const expected = {
          _tag: "SessionNotFoundError",
          sessionID: missing,
          message: `Session not found: ${missing}`,
        }

        const messages = yield* request(`/api/session/${missing}/message`, { headers })
        expect(messages.status).toBe(404)
        expect(yield* responseJson(messages)).toEqual(expected)

        const context = yield* request(`/api/session/${missing}/context`, { headers })
        expect(context.status).toBe(404)
        expect(yield* responseJson(context)).toEqual(expected)

        const compact = yield* request(`/api/session/${missing}/compact`, { method: "POST", headers })
        expect(compact.status).toBe(404)
        expect(yield* responseJson(compact)).toEqual(expected)

        const wait = yield* request(`/api/session/${missing}/wait`, { method: "POST", headers })
        expect(wait.status).toBe(404)
        expect(yield* responseJson(wait)).toEqual(expected)

        const prompt = yield* request(`/api/session/${missing}/prompt`, {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ prompt: { text: "hello" } }),
        })
        expect(prompt.status).toBe(404)
        expect(yield* responseJson(prompt)).toEqual(expected)
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "durably records one v2 prompt for exact message-ID retries",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-opencode-directory": test.directory }
        const session = yield* createSession({ title: "v2 prompt recording" })

        const recordPrompt = () =>
          request(`/api/session/${session.id}/prompt`, {
            method: "POST",
            headers: { ...headers, "content-type": "application/json" },
            body: JSON.stringify({ id: "msg_http_prompt", prompt: { text: "hello" }, resume: false }),
          })
        const first = yield* recordPrompt()
        const retried = yield* recordPrompt()
        type PromptBody = { id: string; prompt: { text: string }; delivery: string; promotedSeq?: number }
        const firstBody = yield* json<{ data: PromptBody }>(first)
        const retriedBody = yield* json<{ data: PromptBody }>(retried)
        expect(first.status).toBe(200)
        expect(retried.status).toBe(200)
        expect(retriedBody).toEqual(firstBody)
        expect(firstBody).toMatchObject({
          data: { id: "msg_http_prompt", prompt: { text: "hello" }, delivery: "steer" },
        })

        const messages = yield* requestJson<{ data: PromptBody[] }>(`/api/session/${session.id}/message`, {
          headers,
        })
        expect(messages.data).toHaveLength(0)
        const admitted = yield* Database.Service.use(({ db }) =>
          db
            .select()
            .from(SessionInputTable)
            .where(eq(SessionInputTable.id, SessionMessage.ID.make("msg_http_prompt")))
            .get()
            .pipe(Effect.orDie),
        )
        expect(admitted).toMatchObject({
          id: "msg_http_prompt",
          session_id: session.id,
          delivery: "steer",
          promoted_seq: null,
        })
        const conflict = yield* request(`/api/session/${session.id}/prompt`, {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ id: "msg_http_prompt", prompt: { text: "goodbye" } }),
        })
        expect(conflict.status).toBe(409)
        expect(yield* responseJson(conflict)).toEqual({
          _tag: "ConflictError",
          message: "Prompt message ID conflicts with an existing durable record: msg_http_prompt",
          resource: "msg_http_prompt",
        })

        const wakeID = SessionMessage.ID.make("msg_http_wake")
        const wake = yield* request(`/api/session/${session.id}/prompt`, {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ id: wakeID, prompt: { text: "hello again" } }),
        })
        expect(wake.status).toBe(200)
        const message = yield* pollWithTimeout(
          requestJson<{ data: SessionMessage.Message[] }>(`/api/session/${session.id}/message`, { headers }).pipe(
            Effect.map(({ data }) => data.find((message) => message.id === wakeID)),
          ),
          "V2 prompt was not promoted after wake",
          "10 seconds",
        )
        expect(message).toMatchObject({ id: wakeID, type: "user" })
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "compacts empty v2 sessions and preserves unavailable wait errors",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-opencode-directory": test.directory }
        const session = yield* createSession({ title: "v2 unavailable" })

        const compact = yield* request(`/api/session/${session.id}/compact`, { method: "POST", headers })
        // 本项已接通compact，空会话无副作用成功；wait仍检查真实未实现错误。
        expect(compact.status).toBe(204)
        expect(yield* compact.text).toBe("")

        const wait = yield* request(`/api/session/${session.id}/wait`, { method: "POST", headers })
        expect(wait.status).toBe(503)
        expect(yield* responseJson(wait)).toEqual({
          _tag: "ServiceUnavailableError",
          message: "Session wait is not available yet",
          service: "session.wait",
        })
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "returns safe v2 unknown errors for corrupt projected messages",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const session = yield* createSession({ title: "v2 corrupt message" })
        yield* insertCorruptV2Message(session.id)

        const messages = yield* request(`/api/session/${session.id}/message`, {
          headers: { "x-opencode-directory": test.directory },
        })
        const messagesBody = yield* responseJson(messages)
        expect(messages.status).toBe(500)
        expect(messagesBody).toMatchObject({
          _tag: "UnknownError",
          message: "Unexpected server error. Check server logs for details.",
        })
        expect((messagesBody as { ref?: unknown }).ref).toMatch(/^err_[0-9a-f-]{8}$/)
        expect(JSON.stringify(messagesBody)).not.toContain("assistant")

        const context = yield* request(`/api/session/${session.id}/context`, {
          headers: { "x-opencode-directory": test.directory },
        })
        const contextBody = yield* responseJson(context)
        expect(context.status).toBe(500)
        expect(contextBody).toMatchObject({
          _tag: "UnknownError",
          message: "Unexpected server error. Check server logs for details.",
        })
        expect((contextBody as { ref?: unknown }).ref).toMatch(/^err_[0-9a-f-]{8}$/)
        expect(JSON.stringify(contextBody)).not.toContain("assistant")
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "serves sessions with migrated summary diffs missing file details",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const session = yield* createSession({ title: "legacy diff" })
        yield* setLegacySummaryDiff(session.id)

        const response = yield* request(pathFor(SessionPaths.get, { sessionID: session.id }), {
          headers: { "x-opencode-directory": test.directory },
        })

        expect(response.status).toBe(200)
        expect((yield* json<Session.Info>(response)).summary?.diffs).toEqual([{ additions: 1, deletions: 0 }])
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "serves lifecycle mutation routes",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-opencode-directory": test.directory, "content-type": "application/json" }

        const createdEmpty = yield* requestJson<Session.Info>(SessionPaths.create, {
          method: "POST",
          headers,
        })
        expect(createdEmpty.id).toBeTruthy()

        const created = yield* requestJson<Session.Info>(SessionPaths.create, {
          method: "POST",
          headers,
          body: JSON.stringify({ title: "created" }),
        })
        expect(created.title).toBe("created")

        const updated = yield* requestJson<Session.Info>(pathFor(SessionPaths.update, { sessionID: created.id }), {
          method: "PATCH",
          headers,
          body: JSON.stringify({ title: "updated", time: { archived: 1 } }),
        })
        expect(updated).toMatchObject({ id: created.id, title: "updated", time: { archived: 1 } })

        const forked = yield* requestJson<Session.Info>(pathFor(SessionPaths.fork, { sessionID: created.id }), {
          method: "POST",
          headers,
        })
        expect(forked.id).not.toBe(created.id)

        const forkedWithoutContentType = yield* requestJson<Session.Info>(
          pathFor(SessionPaths.fork, { sessionID: created.id }),
          {
            method: "POST",
            headers: { "x-opencode-directory": test.directory },
          },
        )
        expect(forkedWithoutContentType.id).not.toBe(created.id)

        const invalidFork = yield* request(pathFor(SessionPaths.fork, { sessionID: created.id }), {
          method: "POST",
          headers,
          body: "{",
        })
        expect(invalidFork.status).toBe(400)

        const forkedWhitespace = yield* requestJson<Session.Info>(
          pathFor(SessionPaths.fork, { sessionID: created.id }),
          {
            method: "POST",
            headers,
            body: "  \n",
          },
        )
        expect(forkedWhitespace.id).not.toBe(created.id)

        expect(
          yield* requestJson<boolean>(pathFor(SessionPaths.abort, { sessionID: created.id }), {
            method: "POST",
            headers,
          }),
        ).toBe(true)

        expect(
          yield* requestJson<boolean>(pathFor(SessionPaths.remove, { sessionID: created.id }), {
            method: "DELETE",
            headers,
          }),
        ).toBe(true)
      }),
    { git: true, config: { formatter: false, lsp: false, share: "disabled" } },
  )

  // #497：Session.directory 成为 local plan 权威后，prompt/foreground Task/abort 必须
  // 命中同一 per-directory Runner——错误 caller hint 不能再分叉出第二个 Runner。
  it.instance(
    "keeps foreground Task execution and abort on the persisted Session owner",
    () =>
      Effect.gen(function* () {
        const owner = (yield* TestInstance).directory
        const callerA = yield* tmpdirScoped()
        const callerB = yield* tmpdirScoped()
        const llm = yield* TestLLMServer
        const providerConfig = {
          $schema: "https://opencode.ai/config.json",
          provider: {
            test: {
              name: "Test",
              id: "test",
              env: [],
              npm: "@ai-sdk/openai-compatible",
              models: {
                "test-model": {
                  id: "test-model",
                  name: "Test Model",
                  attachment: false,
                  reasoning: false,
                  temperature: false,
                  tool_call: true,
                  release_date: "2025-01-01",
                  limit: { context: 100_000, output: 10_000 },
                  cost: { input: 0, output: 0 },
                  options: {},
                },
              },
              options: { apiKey: "test", baseURL: llm.url },
            },
          },
        }
        // 三个目录共用同一 Provider 配置，只让 directory ownership 成为变量；
        // 否则错误 owner 可能先因缺少模型失败，测试就无法到达真实 Runner 分叉。
        yield* Effect.promise(() =>
          Promise.all(
            [owner, callerA, callerB].map((directory) =>
              Bun.write(path.join(directory, "opencode.json"), JSON.stringify(providerConfig)),
            ),
          ),
        )
        const chat = yield* createSession({
          title: "Pinned foreground Task",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        const promptPath = pathFor(SessionPaths.prompt, { sessionID: chat.id })
        const sendPrompt = (directory: string, text: string) =>
          request(promptPath, {
            method: "POST",
            headers: { "content-type": "application/json", "x-opencode-directory": directory },
            body: JSON.stringify({
              agent: "build",
              model: { providerID: "test", modelID: "test-model" },
              parts: [{ type: "text", text }],
            }),
          })
        // 第一轮由主 Agent 产生真实 foreground task，child 的 Provider 流保持挂起；
        // 父 Tool 因而稳定停在 running，形成与生产事故相同的阻塞边界。
        yield* llm.tool("task", {
          description: "hold child",
          prompt: "wait until cancelled",
          subagent_type: "general",
        })
        yield* llm.hang
        // 该第三个响应只会被错误目录创建的第二个 Runner 消费；正确 join 不会触碰它。
        yield* llm.hang
        const first = yield* sendPrompt(callerA, "start foreground task").pipe(Effect.forkChild)
        const runningTask = yield* pollWithTimeout(
          Effect.gen(function* () {
            const messages = yield* MessageV2.filterCompactedEffect(chat.id)
            return messages
              .flatMap((message) => message.parts)
              .find(
                (part): part is MessageV2.ToolPart =>
                  part.type === "tool" &&
                  part.tool === "task" &&
                  part.state.status === "running" &&
                  typeof part.state.metadata?.sessionId === "string",
              )
          }),
          "foreground task never became running",
          "10 seconds",
        )
        if (runningTask.state.status !== "running") throw new Error("foreground task did not remain running")
        const childID = SessionID.make(String(runningTask.state.metadata?.sessionId))
        // Task metadata 会早于 child Provider 请求落库；等待第二个 HTTP hit 才能证明
        // child fiber 已真正越过 prompt 边界，后续 abort 终态断言因而不会误测启动前取消。
        yield* llm.wait(2)

        const second = yield* sendPrompt(callerB, "join the same foreground task").pipe(Effect.forkChild)
        // 第二条 user Message 是公共持久化 readiness signal：它证明第二个请求已经
        // 穿过 HttpApi 并到达 prompt，而无需用固定 sleep 猜测 join/start 时机。
        yield* pollWithTimeout(
          Effect.gen(function* () {
            const messages = yield* MessageV2.filterCompactedEffect(chat.id)
            return messages.filter((message) => message.info.role === "user").length === 2 ? true : undefined
          }),
          "second prompt never reached the Session",
          "10 seconds",
        )

        // abort 故意来自持久化 owner，而非任一 caller hint；只有 Session.directory
        // 在 middleware 成为权威后，它才能命中两个调用共同等待的真实 Runner。
        expect(
          yield* requestJson<boolean>(pathFor(SessionPaths.abort, { sessionID: chat.id }), {
            method: "POST",
            headers: { "x-opencode-directory": owner },
          }),
        ).toBe(true)

        const [firstResponse, secondResponse] = yield* Effect.all([Fiber.join(first), Fiber.join(second)], {
          concurrency: "unbounded",
        }).pipe(Effect.timeout("10 seconds"))
        const firstResult = yield* json<MessageV2.WithParts>(firstResponse)
        const secondResult = yield* json<MessageV2.WithParts>(secondResponse)
        // 相同 assistant ID 是 Runner join 的外部结果；两次 Provider 请求分别属于
        // parent 和 child，若第二个 parent work 真执行则计数会增加到三次。
        expect(firstResult.info.id).toBe(secondResult.info.id)
        expect(yield* llm.calls).toBe(2)

        const parentTask = (yield* MessageV2.filterCompactedEffect(chat.id))
          .flatMap((message) => message.parts)
          .find((part): part is MessageV2.ToolPart => part.type === "tool" && part.tool === "task")
        // 父 Tool 的 error 终态直接驱动 TUI 停止 spinner；child assistant 终态则证明
        // abort 到达真实子 fiber，而非只在另一个 InstanceState 中修补 SQLite 外观。
        expect(parentTask?.state.status).toBe("error")
        const childAssistants = (yield* MessageV2.filterCompactedEffect(childID)).filter(
          (message): message is MessageV2.WithParts & { info: MessageV2.Assistant } => message.info.role === "assistant",
        )
        expect(childAssistants.length).toBeGreaterThan(0)
        expect(childAssistants.every((message) => message.info.time.completed !== undefined)).toBe(true)
      }).pipe(Effect.provide(TestLLMServer.layer), Effect.provide(AppNodeBuilder.build(CrossSpawnSpawner.node))),
    { git: true, config: { formatter: false, lsp: false, share: "disabled" } },
    30_000,
  )

  it.instance(
    "persists selected workspace id when creating a session",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        Flag.OPENCODE_EXPERIMENTAL_WORKSPACES = true
        const project = yield* Project.use.fromDirectory(test.directory)
        const workspace = yield* createLocalWorkspace({
          projectID: project.project.id,
          type: "session-create-workspace",
          directory: path.join(test.directory, ".workspace-local"),
        })

        const created = yield* requestJson<Session.Info>(`${SessionPaths.create}?workspace=${workspace.id}`, {
          method: "POST",
          headers: { "x-opencode-directory": test.directory, "content-type": "application/json" },
          body: JSON.stringify({ title: "workspace session" }),
        })
        const messages = yield* request(
          `${pathFor(SessionPaths.messages, { sessionID: created.id })}?workspace=${workspace.id}`,
          {
            headers: { "x-opencode-directory": test.directory },
          },
        )

        expect(created).toMatchObject({ id: created.id, workspaceID: workspace.id })
        expect(messages.status).toBe(200)
        expect(yield* getWorkspaceID(created.id)).toEqual({ workspaceID: workspace.id })
      }),
    { git: true, config: { formatter: false, lsp: false, share: "disabled" } },
  )

  it.instance(
    "validates archived timestamp values",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-opencode-directory": test.directory, "content-type": "application/json" }
        const session = yield* createSession({ title: "archived" })
        const body = JSON.stringify({ time: { archived: -1 } })

        const response = yield* request(pathFor(SessionPaths.update, { sessionID: session.id }), {
          method: "PATCH",
          headers,
          body,
        })
        expect(response.status).toBe(200)
        expect((yield* json<Session.Info>(response)).time.archived).toBe(-1)
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "uses project-scoped path and directory precedence",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const currentDir = path.join(test.directory, "packages", "opencode", "src")
        yield* Effect.promise(() => mkdir(currentDir, { recursive: true }))

        const store = yield* InstanceStore.Service
        const { pathSession, pathlessSession } = yield* store.provide(
          { directory: currentDir },
          Effect.gen(function* () {
            return {
              pathSession: yield* createSession(),
              pathlessSession: yield* createSession(),
            }
          }).pipe(Effect.provideService(TestInstance, { directory: currentDir })),
        )
        yield* clearSessionPath(pathlessSession.id)

        const query = new URLSearchParams({
          scope: "project",
          path: "packages/opencode/src",
          directory: currentDir,
        })
        const headers = { "x-opencode-directory": test.directory }
        const sessions = (yield* json<Session.Info[]>(
          yield* request(`${SessionPaths.list}?${query}`, { headers }),
        )).map((item) => item.id)

        expect(sessions).toContain(pathSession.id)
        expect(sessions).not.toContain(pathlessSession.id)
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "lists sessions created through an equivalent directory hint",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const hint = test.directory + path.sep
        const headers = { "x-opencode-directory": hint, "content-type": "application/json" }
        const created = yield* requestJson<Session.Info>(SessionPaths.create, {
          method: "POST",
          headers,
          body: JSON.stringify({ title: "hinted" }),
        })

        const query = new URLSearchParams({ directory: hint, roots: "true" })
        const listed = yield* requestJson<Session.Info[]>(`${SessionPaths.list}?${query}`, { headers })
        expect(listed.map((item) => item.id)).toContain(created.id)

        const globalQuery = new URLSearchParams({ directory: hint })
        const global = yield* requestJson<Session.Info[]>(`${ExperimentalPaths.session}?${globalQuery}`, { headers })
        expect(global.map((item) => item.id)).toContain(created.id)
      }),
    { git: true, config: { formatter: false, lsp: false, share: "disabled" } },
  )

  it.instance(
    "lists Windows sessions for equivalent directory spellings",
    () =>
      Effect.gen(function* () {
        if (process.platform !== "win32") return
        const test = yield* TestInstance
        const headers = { "x-opencode-directory": test.directory, "content-type": "application/json" }
        const created = yield* requestJson<Session.Info>(SessionPaths.create, {
          method: "POST",
          headers,
          body: JSON.stringify({ title: "windows spelling" }),
        })

        const forwardSlashes = test.directory.replaceAll("\\", "/")
        const lowercaseDrive = test.directory.replace(/^[A-Z]:/, (drive) => drive.toLowerCase())
        const trailingSeparator = `${test.directory}\\`
        for (const spelling of [forwardSlashes, lowercaseDrive, trailingSeparator]) {
          const query = new URLSearchParams({ directory: spelling, roots: "true" })
          const listed = yield* requestJson<Session.Info[]>(`${SessionPaths.list}?${query}`, { headers })
          expect({ spelling, ids: listed.map((item) => item.id) }).toEqual({ spelling, ids: [created.id] })
        }
      }),
    { git: true, config: { formatter: false, lsp: false, share: "disabled" } },
    { timeout: 15000 },
  )

  it.instance(
    "lists Windows sessions created through the global worktree sentinel",
    () =>
      Effect.gen(function* () {
        if (process.platform !== "win32") return
        const globalWorktreeSentinel = "/"
        const headers = { "x-opencode-directory": globalWorktreeSentinel, "content-type": "application/json" }
        const driveRootSession = yield* requestJson<Session.Info>(SessionPaths.create, {
          method: "POST",
          headers,
          body: JSON.stringify({ title: "created at drive root" }),
        })
        expect(driveRootSession.directory).toMatch(/^[A-Za-z]:\\$/)

        const query = new URLSearchParams({ directory: globalWorktreeSentinel, roots: "true" })
        const listed = yield* requestJson<Session.Info[]>(`${SessionPaths.list}?${query}`, { headers })
        expect(listed.map((item) => item.id)).toContain(driveRootSession.id)
      }),
    { git: true, config: { formatter: false, lsp: false, share: "disabled" } },
    { timeout: 15000 },
  )

  it.instance(
    "serves paginated message link headers",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-opencode-directory": test.directory }
        const session = yield* createSession({ title: "messages" })
        yield* createTextMessage(session.id, "first")
        yield* createTextMessage(session.id, "second")
        const route = `${pathFor(SessionPaths.messages, { sessionID: session.id })}?limit=1`

        const response = yield* request(route, { headers })

        expect(response.headers["x-next-cursor"]).toBeTruthy()
        expect(response.headers["link"]).toContain("limit=1")
        expect(response.headers["access-control-expose-headers"]?.toLowerCase()).toContain("x-next-cursor")
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "serves message mutation routes",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-opencode-directory": test.directory, "content-type": "application/json" }
        const session = yield* createSession({ title: "messages" })
        const first = yield* createTextMessage(session.id, "first")
        const second = yield* createTextMessage(session.id, "second")

        const updated = yield* requestJson<SessionV1.Part>(
          pathFor(SessionPaths.updatePart, {
            sessionID: session.id,
            messageID: first.info.id,
            partID: first.part.id,
          }),
          {
            method: "PATCH",
            headers,
            body: JSON.stringify({ ...first.part, text: "updated" }),
          },
        )
        expect(updated).toMatchObject({ id: first.part.id, type: "text", text: "updated" })

        expect(
          yield* requestJson<boolean>(
            pathFor(SessionPaths.deletePart, {
              sessionID: session.id,
              messageID: first.info.id,
              partID: first.part.id,
            }),
            { method: "DELETE", headers },
          ),
        ).toBe(true)

        expect(
          yield* requestJson<boolean>(
            pathFor(SessionPaths.deleteMessage, { sessionID: session.id, messageID: second.info.id }),
            { method: "DELETE", headers },
          ),
        ).toBe(true)
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "rejects part updates whose path and body ids disagree",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-opencode-directory": test.directory, "content-type": "application/json" }
        const session = yield* createSession({ title: "part mismatch" })
        const message = yield* createTextMessage(session.id, "first")
        const response = yield* request(
          pathFor(SessionPaths.updatePart, {
            sessionID: session.id,
            messageID: message.info.id,
            partID: message.part.id,
          }),
          {
            method: "PATCH",
            headers,
            body: JSON.stringify({ ...message.part, id: PartID.ascending() }),
          },
        )

        expect(response.status).toBe(400)
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "serves remaining non-LLM session mutation routes",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-opencode-directory": test.directory, "content-type": "application/json" }
        const session = yield* createSession({ title: "remaining" })

        expect(
          yield* requestJson<Session.Info>(pathFor(SessionPaths.revert, { sessionID: session.id }), {
            method: "POST",
            headers,
            body: JSON.stringify({ messageID: MessageID.ascending() }),
          }),
        ).toMatchObject({ id: session.id })

        expect(
          yield* requestJson<Session.Info>(pathFor(SessionPaths.unrevert, { sessionID: session.id }), {
            method: "POST",
            headers,
          }),
        ).toMatchObject({ id: session.id })

        const permissionID = String(PermissionV1.ID.ascending())
        const permission = yield* request(
          pathFor(SessionPaths.permissions, {
            sessionID: session.id,
            permissionID,
          }),
          {
            method: "POST",
            headers,
            body: JSON.stringify({ response: "once" }),
          },
        )
        expect(permission.status).toBe(404)
        expect(yield* responseJson(permission)).toEqual({
          _tag: "PermissionNotFoundError",
          requestID: permissionID,
          message: `Permission request not found: ${permissionID}`,
        })
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  // #269：三个用例分别锁定空列表/单一 get 404/assistants 404——父请求存在性是各端点的前置契约
  it.live("returns empty list for new session request_usage", () =>
    Effect.gen(function* () {
      const llm = yield* TestLLMServer
      const directory = yield* tmpdirScoped({ git: true, config: testProviderConfig(llm.url) })
      const session = yield* createSession({ title: "Request usage session" }).pipe(
        provideInstanceEffect(directory),
      )
      const headers = { "x-opencode-directory": directory }
      // #269：列表端点返回裸数组——成功契约是 [] 而非 { data: [] } 包装
      const body = yield* requestJson<unknown[]>(
        pathFor("/session/:sessionID/request_usage", { sessionID: session.id }),
        { headers },
      )
      expect(body.length).toBe(0)
    }).pipe(Effect.provide(TestLLMServer.layer), Effect.provide(AppNodeBuilder.build(CrossSpawnSpawner.node))),
  )

  // #269：缺失的 requestID 应返回 404，而非空成功
  it.live("returns 404 for missing request_usage get", () =>
    Effect.gen(function* () {
      const llm = yield* TestLLMServer
      const directory = yield* tmpdirScoped({ git: true, config: testProviderConfig(llm.url) })
      const session = yield* createSession({ title: "Missing request usage session" }).pipe(
        provideInstanceEffect(directory),
      )
      const headers = { "x-opencode-directory": directory }
      const missingID = "msg_httpapi_missing"
      const response = yield* request(
        pathFor("/session/:sessionID/request_usage/:requestID", { sessionID: session.id, requestID: missingID }),
        { headers },
      )
      // #269：断言 404 而非 200 空体——缺失资源必须与“存在但无数据”可区分
      expect(response.status).toBe(404)
    }).pipe(Effect.provide(TestLLMServer.layer), Effect.provide(AppNodeBuilder.build(CrossSpawnSpawner.node))),
  )

  // #269：缺失父请求时 assistants 端点也应 404
  it.live("returns 404 for missing request_usage assistants", () =>
    Effect.gen(function* () {
      const llm = yield* TestLLMServer
      const directory = yield* tmpdirScoped({ git: true, config: testProviderConfig(llm.url) })
      const session = yield* createSession({ title: "Missing assistant usage session" }).pipe(
        provideInstanceEffect(directory),
      )
      const headers = { "x-opencode-directory": directory }
      const missingID = "msg_httpapi_missing"
      const response = yield* request(
        pathFor("/session/:sessionID/request_usage/:requestID/assistant", { sessionID: session.id, requestID: missingID }),
        { headers },
      )
      // #269：assistants 端点与 get 端点共享同一父请求前置——两处都需锁定
      expect(response.status).toBe(404)
    }).pipe(Effect.provide(TestLLMServer.layer), Effect.provide(AppNodeBuilder.build(CrossSpawnSpawner.node))),
  )
})
