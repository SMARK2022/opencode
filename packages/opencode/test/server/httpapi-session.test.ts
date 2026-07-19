import { afterEach, describe, expect } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { Effect, Fiber, Layer } from "effect"
import { Flag } from "@opencode-ai/core/flag/flag"
import { registerAdapter } from "../../src/control-plane/adapters"
import type { WorkspaceAdapter } from "../../src/control-plane/types"
import { Workspace } from "../../src/control-plane/workspace"
import { PermissionID } from "../../src/permission/schema"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { InstanceBootstrap as InstanceBootstrapService } from "../../src/project/bootstrap-service"
import { InstanceStore } from "../../src/project/instance-store"
import { Project } from "../../src/project/project"
import { Server } from "../../src/server/server"
import { SessionPaths } from "../../src/server/routes/instance/httpapi/groups/session"
import { Session } from "@/session/session"
import { MessageID, PartID, SessionID, type SessionID as SessionIDType } from "../../src/session/schema"
import { MessageV2 } from "../../src/session/message-v2"
import { Database } from "@/storage/db"
import { SessionMessageTable, SessionTable } from "@/session/session.sql"
import { SessionMessage } from "@opencode-ai/core/session-message"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import * as DateTime from "effect/DateTime"
import * as Log from "@opencode-ai/core/util/log"
import { eq } from "drizzle-orm"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, TestInstance, tmpdirScoped } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"
import { TestLLMServer } from "../lib/llm-server"

void Log.init({ print: false })

const originalWorkspaces = Flag.OPENCODE_EXPERIMENTAL_WORKSPACES
const workspaceLayer = Workspace.defaultLayer.pipe(
  Layer.provide(InstanceStore.defaultLayer),
  Layer.provide(InstanceBootstrap.defaultLayer),
)
const instanceStoreLayer = InstanceStore.defaultLayer.pipe(
  Layer.provide(
    Layer.succeed(InstanceBootstrapService.Service, InstanceBootstrapService.Service.of({ run: Effect.void })),
  ),
)
const it = testEffect(
  Layer.mergeAll(
    instanceStoreLayer,
    Project.defaultLayer,
    Session.defaultLayer,
    workspaceLayer,
    TestLLMServer.layer,
    CrossSpawnSpawner.defaultLayer,
  ),
)

function app() {
  return Server.Default().app
}

function pathFor(path: string, params: Record<string, string>) {
  return Object.entries(params).reduce((result, [key, value]) => result.replace(`:${key}`, value), path)
}

function createSession(input?: Session.CreateInput) {
  return Session.Service.use((svc) => svc.create(input))
}

function createTextMessage(sessionID: SessionIDType, text: string) {
  return Effect.gen(function* () {
    const svc = yield* Session.Service
    const info = yield* svc.updateMessage({
      id: MessageID.ascending(),
      role: "user",
      sessionID,
      agent: "build",
      model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test") },
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
    (info) => Workspace.Service.use((svc) => svc.remove(info.id)).pipe(Effect.ignore),
  )

const insertLegacyAssistantMessage = (sessionID: SessionIDType) =>
  Effect.sync(() => {
    const message = new SessionMessage.Assistant({
      id: SessionMessage.ID.create(),
      type: "assistant",
      agent: "build",
      model: {
        id: ModelV2.ID.make("model"),
        providerID: ProviderV2.ID.make("provider"),
        variant: ModelV2.VariantID.make("default"),
      },
      time: { created: DateTime.makeUnsafe(1) },
      content: [],
    })
    Database.use((db) =>
      db
        .insert(SessionMessageTable)
        .values([
          {
            id: message.id,
            session_id: sessionID,
            type: message.type,
            time_created: 1,
            data: {
              time: { created: 1 },
              agent: message.agent,
              model: message.model,
              content: message.content,
            } as NonNullable<(typeof SessionMessageTable.$inferInsert)["data"]>,
          },
        ])
        .run(),
    )
  })

const setLegacySummaryDiff = (sessionID: SessionIDType) =>
  Effect.sync(() =>
    Database.use((db) =>
      db
        .update(SessionTable)
        .set({
          summary_additions: 1,
          summary_deletions: 0,
          summary_files: 1,
          summary_diffs: [{ additions: 1, deletions: 0 }],
        })
        .where(eq(SessionTable.id, sessionID))
        .run(),
    ),
  )

const getWorkspaceID = (sessionID: SessionIDType) =>
  Effect.sync(() =>
    Database.use((db) =>
      db
        .select({ workspaceID: SessionTable.workspace_id })
        .from(SessionTable)
        .where(eq(SessionTable.id, sessionID))
        .get(),
    ),
  )

const clearSessionPath = (sessionID: SessionIDType) =>
  Effect.sync(() =>
    Database.use((db) => db.update(SessionTable).set({ path: null }).where(eq(SessionTable.id, sessionID)).run()),
  )

function request(path: string, init?: RequestInit) {
  return Effect.promise(async () => app().request(path, init))
}

function json<T>(response: Response) {
  return Effect.promise(async () => {
    if (response.status !== 200) throw new Error(await response.text())
    return (await response.json()) as T
  })
}

function responseJson(response: Response) {
  return Effect.promise(() => response.json())
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
        const messagePage = yield* json<MessageV2.WithParts[]>(messages)
        const nextCursor = messages.headers.get("x-next-cursor")
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
          yield* requestJson<MessageV2.WithParts>(
            pathFor(SessionPaths.message, { sessionID: parent.id, messageID: message.info.id }),
            { headers },
          ),
        ).toMatchObject({ info: { id: message.info.id } })

        yield* insertLegacyAssistantMessage(parent.id)

        expect(
          (yield* requestJson<{ items: SessionMessage.Message[] }>(`/api/session/${parent.id}/message`, { headers }))
            .items,
        ).toMatchObject([{ type: "assistant" }])
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
              options: { apiKey: "test-key", baseURL: llm.url },
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
          (message): message is MessageV2.WithParts & { info: MessageV2.Assistant } =>
            message.info.role === "assistant",
        )
        expect(childAssistants.length).toBeGreaterThan(0)
        expect(childAssistants.every((message) => message.info.time.completed !== undefined)).toBe(true)
      }),
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
          }).pipe(Effect.provideService(TestInstance, { directory: currentDir }), Effect.provide(Session.defaultLayer)),
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

        expect(response.headers.get("x-next-cursor")).toBeTruthy()
        expect(response.headers.get("link")).toContain("limit=1")
        expect(response.headers.get("access-control-expose-headers")?.toLowerCase()).toContain("x-next-cursor")
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

        const updated = yield* requestJson<MessageV2.Part>(
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

        expect(
          yield* requestJson<boolean>(
            pathFor(SessionPaths.permissions, {
              sessionID: session.id,
              permissionID: String(PermissionID.ascending()),
            }),
            {
              method: "POST",
              headers,
              body: JSON.stringify({ response: "once" }),
            },
          ),
        ).toBe(true)
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )
})
